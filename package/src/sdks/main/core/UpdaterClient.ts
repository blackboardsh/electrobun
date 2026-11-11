import type { LocalUpdateInfo, UpdateInfo, UpdateStatusEntry } from "./UpdaterTypes";

export type UpdaterOperationState = "idle" | "queued" | "running" | "awaitingApproval" | "completed" | "failed" | "cancelled";
export interface UpdaterOperation {
	operationId: string;
	operation: string;
	state: UpdaterOperationState;
	error: string | null;
	updateInfo: UpdateInfo | null;
}
export interface UpdaterState {
	schemaVersion: 1;
	revision: number;
	operationId: string | null;
	operation: string | null;
	operationState: UpdaterOperationState;
	localInfo: LocalUpdateInfo;
	updateInfo: UpdateInfo;
	approval: { id: string; preparedHash: string } | null;
	quitReady: boolean;
	channelRoot: string;
	operations: UpdaterOperation[];
}
export type UpdaterRequest = { schemaVersion: 1 } & (
	| { action: "check" | "download" | "requestApply" | "reconcile" }
	| { action: "approveApply"; operationId: string; approvalId: string; approved: boolean }
	| { action: "cancel"; operationId: string }
);
export interface UpdaterResponse {
	schemaVersion: 1;
	accepted: boolean;
	operationId: string | null;
	error: string | null;
}
export interface UpdaterEvents {
	schemaVersion: 1;
	entries: (UpdateStatusEntry & { sequence: number; operationId: string | null })[];
	nextSequence: number;
	oldestSequence: number;
	overflow: boolean;
}
export interface UpdaterConfiguration { schemaVersion: 1; exeDir: string; resourcesDir: string }
export interface UpdaterNative {
	configure(configuration: UpdaterConfiguration): boolean;
	request(request: UpdaterRequest): UpdaterResponse;
	getState(): UpdaterState;
	getEvents(afterSequence: number, limit: number): UpdaterEvents;
}

const emptyUpdateInfo = (): UpdateInfo => ({ version: "", hash: "", updateAvailable: false, updateReady: false, error: "" });
const terminal = (state: UpdaterOperationState) => state === "completed" || state === "failed" || state === "cancelled";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Only scheduling, public API compatibility and the JS before-quit event live here.
 * Metadata, network requests, prepared state and update transactions belong to core. */
export function createUpdaterClient<Approval extends object>(dependencies: {
	native: UpdaterNative;
	configuration(): UpdaterConfiguration;
	requestQuitApproval(): Approval | null;
	cancelQuitApproval(approval: Approval): void;
	quitAfterApproval(approval: Approval, code: number): void;
	pollIntervalMs?: number;
}) {
	let configured = false;
	let stopped = false;
	let polling = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let state: UpdaterState | undefined;
	let updateInfo = emptyUpdateInfo();
	let sequence = 0;
	const history: UpdateStatusEntry[] = [];
	const pendingReconciliation: UpdateStatusEntry[] = [];
	let callback: ((entry: UpdateStatusEntry) => void) | null = null;
	let checkInFlight: Promise<UpdateInfo> | undefined;
	let downloadInFlight: Promise<void> | undefined;
	let applyInFlight: Promise<void> | undefined;
	type Waiter = {
		resolve(operation: UpdaterOperation): void;
		reject(error: Error): void;
		approval?: Approval;
		approvalId?: string;
	};
	const waiters = new Map<string, Waiter>();

	function notify(entry: UpdateStatusEntry): void {
		try { callback?.(entry); }
		catch (error) { console.error("[Updater] Status listener failed:", error); }
	}
	function localError(error: unknown): Error {
		const message = errorMessage(error);
		updateInfo = { ...updateInfo, error: message };
		const entry: UpdateStatusEntry = { status: "error", message, timestamp: Date.now(), details: { errorMessage: message } };
		history.push(entry);
		notify(entry);
		return error instanceof Error ? error : new Error(message);
	}
	function send(request: UpdaterRequest): UpdaterResponse {
		if (stopped) throw new Error("The updater has been shut down");
		const response = dependencies.native.request(request);
		if (response.schemaVersion !== 1 || !response.accepted) {
			throw new Error(response.error || "The native core rejected the updater request");
		}
		return response;
	}
	function cancel(id: string): void {
		try { send({ schemaVersion: 1, action: "cancel", operationId: id }); } catch {}
	}
	function failWaiter(id: string, waiter: Waiter, error: unknown): void {
		waiters.delete(id);
		if (waiter.approval) dependencies.cancelQuitApproval(waiter.approval);
		cancel(id);
		waiter.reject(localError(error));
	}
	function drainEvents(): void {
		// Read a bounded number per tick even when a producer is very active.
		for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
			if (stopped) break;
			const page = dependencies.native.getEvents(sequence, 256);
			if (page.schemaVersion !== 1) throw new Error("Unsupported native updater event schema");
			// Events can arrive between the first state read and the event read.
			// Publish the matching/newer state before invoking user callbacks.
			if (page.entries.length) {
				state = dependencies.native.getState();
				if (state.schemaVersion !== 1) throw new Error("Unsupported native updater state schema");
				updateInfo = state.updateInfo;
			}
			const snapshot = state!;
			for (const event of page.entries) {
				if (event.sequence <= sequence) continue;
				const { status, message, timestamp, details } = event;
				const entry: UpdateStatusEntry = { status, message, timestamp, ...(details ? { details } : {}) };
				if (stopped) break;
				history.push(entry);
				const operation = snapshot.operations.find((operation) => operation.operationId === event.operationId)?.operation
					?? (snapshot.operationId === event.operationId ? snapshot.operation : null);
				if (!callback && (operation === "reconcile" ||
					(event.operationId == null && (status === "complete" || status === "error")))) {
					pendingReconciliation.push(entry);
				}
				notify(entry);
			}
			const previousSequence = sequence;
			sequence = Math.max(sequence, page.nextSequence);
			if (page.entries.length < 256 || sequence === previousSequence) break;
		}
	}
	function refresh(): void {
		if (stopped || polling) return;
		polling = true;
		try {
			let snapshot = dependencies.native.getState();
			if (snapshot.schemaVersion !== 1) throw new Error("Unsupported native updater state schema");
			state = snapshot;
			updateInfo = snapshot.updateInfo;
			drainEvents();
			if (stopped) return;
			snapshot = state;
			for (const [id, waiter] of waiters) {
				const completed = snapshot.operations.find((operation) => operation.operationId === id && terminal(operation.state));
				if (completed) {
					waiters.delete(id);
					if (waiter.approval) {
						try {
							if (completed.state === "completed" && snapshot.operationId === id && snapshot.quitReady) {
								dependencies.quitAfterApproval(waiter.approval, 0);
							} else dependencies.cancelQuitApproval(waiter.approval);
						} catch (error) { failWaiter(id, waiter, error); continue; }
					}
					waiter.resolve(completed);
					continue;
				}
				if (snapshot.operationId !== id || snapshot.operationState !== "awaitingApproval" || !snapshot.approval || waiter.approvalId) continue;
				try {
					waiter.approvalId = snapshot.approval.id;
					const approval = dependencies.requestQuitApproval();
					if (approval) waiter.approval = approval;
					send({ schemaVersion: 1, action: "approveApply", operationId: id, approvalId: snapshot.approval.id, approved: approval !== null });
				} catch (error) { failWaiter(id, waiter, error); }
			}
		} finally { polling = false; }
	}
	function schedule(): void {
		if (stopped || timer) return;
		if (!callback && waiters.size === 0 && (!state || terminal(state.operationState) || state.operationState === "idle")) return;
		timer = setTimeout(() => {
			timer = undefined;
			try { refresh(); }
			catch (error) {
				if (waiters.size) for (const [id, waiter] of waiters) failWaiter(id, waiter, error);
				else localError(error);
				return;
			}
			schedule();
		}, dependencies.pollIntervalMs ?? 50);
		// A listener by itself should not keep a closing runtime alive.
		if (waiters.size === 0) timer.unref?.();
	}
	function initialize(): void {
		if (stopped) throw new Error("The updater has been shut down");
		if (!configured) {
			if (!dependencies.native.configure(dependencies.configuration())) {
				throw new Error("The native core updater is unavailable or could not be configured");
			}
			configured = true;
		}
		refresh();
		schedule();
	}
	function run(action: "check" | "download" | "requestApply"): Promise<UpdaterOperation> {
		initialize();
		const response = send({ schemaVersion: 1, action });
		if (!response.operationId) throw new Error("The native updater did not return an operation identifier");
		const id = response.operationId;
		const promise = new Promise<UpdaterOperation>((resolve, reject) => { waiters.set(id, { resolve, reject }); });
		try { refresh(); } catch (error) {
			const waiter = waiters.get(id);
			if (waiter) failWaiter(id, waiter, error);
		}
		// A previously unreferenced listener timer must now keep the operation alive.
		timer?.ref?.();
		schedule();
		return promise;
	}
	function checkForUpdate(): Promise<UpdateInfo> {
		if (checkInFlight) return checkInFlight;
		const promise = Promise.resolve().then(() => run("check")).then((operation) => operation.updateInfo ?? updateInfo);
		checkInFlight = promise;
		void promise.then(() => { checkInFlight = undefined; }, () => { checkInFlight = undefined; });
		return promise;
	}
	function downloadUpdate(): Promise<void> {
		if (downloadInFlight) return downloadInFlight;
		const check = checkInFlight;
		const applying = applyInFlight;
		const promise = Promise.resolve().then(async () => {
			if (applying) throw new Error("Cannot download an update while one is being applied");
			if (check) await check;
			await run("download");
		});
		downloadInFlight = promise;
		void promise.then(() => { downloadInFlight = undefined; }, () => { downloadInFlight = undefined; });
		return promise;
	}
	function applyUpdate(): Promise<void> {
		if (applyInFlight) return applyInFlight;
		const download = downloadInFlight;
		const check = checkInFlight;
		const promise = Promise.resolve().then(async () => {
			if (download) await download;
			else if (check) await check;
			await run("requestApply");
		});
		applyInFlight = promise;
		void promise.then(() => { applyInFlight = undefined; }, () => { applyInFlight = undefined; });
		return promise;
	}
	async function getLocalInfo(): Promise<LocalUpdateInfo> { initialize(); return state!.localInfo; }
	const updater = {
		updateInfo: (): UpdateInfo => updateInfo,
		getStatusHistory: (): UpdateStatusEntry[] => [...history],
		clearStatusHistory(): void { history.length = 0; pendingReconciliation.length = 0; },
		onStatusChange(listener: ((entry: UpdateStatusEntry) => void) | null): void {
			if (stopped) return;
			callback = listener;
			if (!listener) return;
			for (const entry of pendingReconciliation.splice(0)) notify(entry);
			try { initialize(); } catch (error) { localError(error); }
		},
		checkForUpdate, downloadUpdate, applyUpdate,
		channelBucketUrl: async (): Promise<string> => (await getLocalInfo()).baseUrl,
		appDataFolder: async (): Promise<string> => { initialize(); return state!.channelRoot; },
		localInfo: {
			version: async (): Promise<string> => (await getLocalInfo()).version,
			hash: async (): Promise<string> => (await getLocalInfo()).hash,
			channel: async (): Promise<string> => (await getLocalInfo()).channel,
			baseUrl: async (): Promise<string> => (await getLocalInfo()).baseUrl,
		},
		getLocalInfo,
		getLocallocalInfo: async (): Promise<LocalUpdateInfo> => {
			console.error("[Electrobun] Updater.getLocallocalInfo() is deprecated. Use Updater.getLocalInfo() instead.");
			return getLocalInfo();
		},
	};
	function shutdown(): void {
		if (stopped) return;
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
		callback = null;
		for (const waiter of waiters.values()) {
			if (waiter.approval) {
				try { dependencies.cancelQuitApproval(waiter.approval); } catch {}
			}
			waiter.reject(new Error("The updater has been shut down"));
		}
		waiters.clear();
	}
	return { updater, shutdown };
}
