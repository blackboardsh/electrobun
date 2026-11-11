import { afterEach, describe, expect, test } from "bun:test";
import { createUpdaterClient } from "./UpdaterClient";

type Options = Parameters<typeof createUpdaterClient>[0];
type Native = Options["native"];
type State = ReturnType<Native["getState"]>;
type Request = Parameters<Native["request"]>[0];
type Response = ReturnType<Native["request"]>;
type Page = ReturnType<Native["getEvents"]>;
type Operation = State["operations"][number];

const localInfo = {
	identifier: "com.example.facade", channel: "stable", version: "1.0.0",
	hash: "old123", baseUrl: "https://updates.example.invalid/releases", name: "Example",
};
const emptyUpdate = { version: "", hash: "", updateAvailable: false, updateReady: false, error: "" };
const availableUpdate = { version: "1.0.0", hash: "new456", updateAvailable: true, updateReady: false, error: "" };
const configurations = { schemaVersion: 1 as const, exeDir: "/example/bin", resourcesDir: "/example/Resources" };
const clients: ReturnType<typeof createUpdaterClient>[] = [];

afterEach(() => {
	for (const client of clients.splice(0)) client.shutdown();
});

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for the updater facade");
}

function fixture() {
	let available = true;
	let configurationReads = 0;
	let stateReads = 0;
	let eventReads = 0;
	let shutdowns = 0;
	let approvals = 0;
	let nextId = 0;
	const approval = {} as NonNullable<ReturnType<Options["requestQuitApproval"]>>;
	let approvalResult: ReturnType<Options["requestQuitApproval"]> = approval;
	let approvalError: Error | undefined;
	const cancelledApprovals: unknown[] = [];
	const quits: { approval: unknown; code: number }[] = [];
	const configured: Parameters<Native["configure"]>[0][] = [];
	const requests: Request[] = [];
	const events: Page["entries"] = [];
	let requestHandler: ((request: Request) => Response | undefined) | undefined;
	let state: State = {
		schemaVersion: 1, revision: 0, operationId: null, operation: null,
		operationState: "idle", localInfo: { ...localInfo }, updateInfo: { ...emptyUpdate },
		approval: null, quitReady: false, channelRoot: "/profile/com.example.facade/stable", operations: [],
	};
	const accepted = (operationId: string): Response => ({ schemaVersion: 1, accepted: true, operationId, error: null });
	const native = {
		configure(configuration: Parameters<Native["configure"]>[0]) { configured.push(configuration); return available; },
		request(request: Request): Response {
			requests.push(request);
			const custom = requestHandler?.(request);
			if (custom) return custom;
			if (request.action === "approveApply" || request.action === "cancel") return accepted(request.operationId);
			const operationId = `operation-${++nextId}`;
			state = { ...state, revision: state.revision + 1, operationId, operation: request.action,
				operationState: "running", approval: null, quitReady: false };
			return accepted(operationId);
		},
		getState(): State { stateReads++; return state; },
		getEvents(after: number, limit: number): Page {
			eventReads++;
			const entries = events.filter((event) => event.sequence > after).slice(0, limit);
			return { schemaVersion: 1, entries, nextSequence: entries.at(-1)?.sequence ?? after,
				oldestSequence: events[0]?.sequence ?? 0, overflow: false };
		},
		shutdown() { shutdowns++; },
	};
	const client = createUpdaterClient({ native, configuration: () => { configurationReads++; return configurations; },
		requestQuitApproval() { approvals++; if (approvalError) throw approvalError; return approvalResult; },
		cancelQuitApproval(value) { cancelledApprovals.push(value); },
		quitAfterApproval(value, code) { quits.push({ approval: value, code }); }, pollIntervalMs: 1 });
	clients.push(client);
	return {
		...client, native, requests, configured, events, approval, cancelledApprovals, quits,
		accepted,
		get state() { return state; },
		set state(value: State) { state = value; },
		get reads() { return { configurationReads, stateReads, eventReads, shutdowns, approvals }; },
		setAvailable(value: boolean) { available = value; },
		setApproval(value: ReturnType<Options["requestQuitApproval"]>) { approvalResult = value; },
		setApprovalError(value: Error) { approvalError = value; },
		onRequest(handler: (request: Request) => Response | undefined) { requestHandler = handler; },
		finish(operationId: string, operation: string, updateInfo = availableUpdate,
			operationState: Operation["state"] = "completed", error: string | null = null) {
			const completed: Operation = { operationId, operation, state: operationState, error, updateInfo };
			state = { ...state, revision: state.revision + 1, operationId, operation,
				operationState, updateInfo, operations: [...state.operations, completed] };
		},
		pushEvent(status: Page["entries"][number]["status"], operationId: string | null = null) {
			events.push({ sequence: events.length + 1, operationId, status,
				message: `Native ${status}`, timestamp: 1000 + events.length });
		},
	};
}

describe("shared native updater facade", () => {
	test("construction and synchronous snapshots do not initialize native state", () => {
		const f = fixture();
		expect(f.updater.updateInfo()).toEqual(emptyUpdate);
		expect(f.updater.getStatusHistory()).toEqual([]);
		expect(f.configured).toEqual([]);
		expect(f.requests).toEqual([]);
		expect(f.reads).toEqual({ configurationReads: 0, stateReads: 0, eventReads: 0, shutdowns: 0, approvals: 0 });
	});

	test("local metadata and its compatibility alias come from one native configuration", async () => {
		const f = fixture();
		expect(await f.updater.getLocalInfo()).toEqual(localInfo);
		expect(await f.updater.getLocallocalInfo()).toEqual(localInfo);
		expect(await f.updater.localInfo.version()).toBe(localInfo.version);
		expect(await f.updater.localInfo.hash()).toBe(localInfo.hash);
		expect(await f.updater.localInfo.channel()).toBe(localInfo.channel);
		expect(await f.updater.localInfo.baseUrl()).toBe(localInfo.baseUrl);
		expect(await f.updater.channelBucketUrl()).toBe(localInfo.baseUrl);
		expect(await f.updater.appDataFolder()).toBe(f.state.channelRoot);
		expect(f.configured).toEqual([configurations]);
		expect(f.requests).toEqual([]);
	});

	test("concurrent checks share one request and resolve the operation's terminal snapshot", async () => {
		const f = fixture();
		const first = f.updater.checkForUpdate();
		const second = f.updater.checkForUpdate();
		expect(second).toBe(first);
		await until(() => f.requests.length === 1);
		expect(f.requests[0]).toEqual({ schemaVersion: 1, action: "check" });
		const operationId = f.state.operationId!;
		f.finish(operationId, "check");
		f.state = { ...f.state, operationId: "later", operation: "download", operationState: "running",
			updateInfo: { ...availableUpdate, hash: "other789" } };
		expect(await first).toEqual(availableUpdate);
	});

	test("downloads coalesce and expose native readiness", async () => {
		const f = fixture();
		const first = f.updater.downloadUpdate();
		expect(f.updater.downloadUpdate()).toBe(first);
		await until(() => f.requests.length === 1);
		expect(f.requests[0]?.action).toBe("download");
		f.finish(f.state.operationId!, "download", { ...availableUpdate, updateReady: true });
		await first;
		expect(f.updater.updateInfo()).toEqual({ ...availableUpdate, updateReady: true });
	});

	test("startup reconciliation completion remains observable to a later listener", async () => {
		const f = fixture();
		f.finish("startup-reconcile", "reconcile", emptyUpdate);
		f.pushEvent("complete", "startup-reconcile");
		await f.updater.getLocalInfo();
		const seen: string[] = [];
		f.updater.onStatusChange((entry) => seen.push(entry.status));
		await until(() => seen.length === 1);
		expect(seen).toEqual(["complete"]);
		expect(f.updater.getStatusHistory()).toEqual([{ status: "complete", message: "Native complete", timestamp: 1000 }]);
	});

	test("history clearing retains the native cursor and never replays cleared events", async () => {
		const f = fixture();
		f.pushEvent("complete", "startup-reconcile");
		const seen: string[] = [];
		f.updater.onStatusChange((entry) => seen.push(entry.status));
		await until(() => seen.length === 1);
		f.updater.clearStatusHistory();
		f.updater.onStatusChange(null);
		f.updater.onStatusChange((entry) => seen.push(entry.status));
		f.pushEvent("checking", "next-check");
		await until(() => seen.length === 2);
		expect(seen).toEqual(["complete", "checking"]);
		expect(f.updater.getStatusHistory().map((entry) => entry.status)).toEqual(["checking"]);
	});

	test("startup completion without an operation ID survives subscribing after metadata access", async () => {
		const f = fixture();
		f.finish("startup-reconcile", "reconcile", emptyUpdate);
		f.pushEvent("complete");
		await f.updater.getLocalInfo();
		const seen: string[] = [];
		f.updater.onStatusChange((entry) => seen.push(entry.status));
		await until(() => seen.length > 0);
		expect(seen).toEqual(["complete"]);
	});

	test("a reconciliation event newer than the state snapshot remains observable", async () => {
		const f = fixture();
		const getEvents = f.native.getEvents;
		let publish = true;
		f.native.getEvents = (after: number, limit: number): Page => {
			if (publish) {
				publish = false;
				f.finish("startup-reconcile", "reconcile", emptyUpdate);
				f.pushEvent("complete", "startup-reconcile");
			}
			return getEvents(after, limit);
		};
		await f.updater.getLocalInfo();
		const seen: string[] = [];
		f.updater.onStatusChange((entry) => seen.push(entry.status));
		await until(() => seen.length > 0);
		expect(seen).toEqual(["complete"]);
	});

	test("an overflow page advances its cursor and exposes only public event fields", async () => {
		const f = fixture();
		const cursors: number[] = [];
		f.native.getEvents = (after: number): Page => {
			cursors.push(after);
			return { schemaVersion: 1, oldestSequence: 100, overflow: after < 99, nextSequence: 101,
				entries: after >= 101 ? [] : [100, 101].map((sequence) => ({ sequence, operationId: "check-1",
					status: "checking", message: `event ${sequence}`, timestamp: sequence })) };
		};
		await f.updater.getLocalInfo();
		await f.updater.getLocalInfo();
		expect(cursors).toEqual([0, 101]);
		expect(f.updater.getStatusHistory()).toEqual([
			{ status: "checking", message: "event 100", timestamp: 100 },
			{ status: "checking", message: "event 101", timestamp: 101 },
		]);
	});

	test("a listener can shut down during a full event page without another native read", async () => {
		const f = fixture();
		for (let index = 0; index < 300; index++) f.pushEvent("download-progress", "download-1");
		let callbacks = 0;
		f.updater.onStatusChange(() => { callbacks++; f.shutdown(); });
		expect(callbacks).toBe(1);
		expect(f.reads.eventReads).toBe(1);
		const reads = f.reads;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(f.reads).toEqual(reads);
	});

	test("apply coalesces and asks before-quit only after native validation requests approval", async () => {
		const f = fixture();
		const first = f.updater.applyUpdate();
		expect(f.updater.applyUpdate()).toBe(first);
		await until(() => f.requests.length === 1);
		const operationId = f.state.operationId!;
		expect(f.reads.approvals).toBe(0);
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "approval-1", preparedHash: availableUpdate.hash } };
		await until(() => f.requests.some((request) => request.action === "approveApply"));
		expect(f.requests[1]).toEqual({ schemaVersion: 1, action: "approveApply", operationId, approvalId: "approval-1", approved: true });
		expect(f.reads.approvals).toBe(1);
		expect(f.quits).toEqual([]);
		f.finish(operationId, "requestApply");
		f.state = { ...f.state, approval: null, quitReady: true };
		await first;
		expect(f.quits).toEqual([{ approval: f.approval, code: 0 }]);
		expect(f.reads.approvals).toBe(1);
	});

	test("a before-quit veto sends a negative native approval and never quits", async () => {
		const f = fixture();
		f.setApproval(null);
		const pending = f.updater.applyUpdate();
		await until(() => f.state.operationId !== null);
		const operationId = f.state.operationId!;
		f.onRequest((request) => {
			if (request.action !== "approveApply") return;
			expect(request.approved).toBe(false);
			f.finish(operationId, "requestApply", availableUpdate, "cancelled");
			f.state = { ...f.state, approval: null };
			return f.accepted(operationId);
		});
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "veto", preparedHash: availableUpdate.hash } };
		await pending;
		expect(f.requests.map((request) => request.action)).toEqual(["requestApply", "approveApply"]);
		expect(f.quits).toEqual([]);
		expect(f.cancelledApprovals).toEqual([]);
	});

	test("a failed handoff releases its reserved approval even if native quitReady is stale", async () => {
		const f = fixture();
		const pending = f.updater.applyUpdate();
		await until(() => f.state.operationId !== null);
		const operationId = f.state.operationId!;
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "failure", preparedHash: availableUpdate.hash } };
		await until(() => f.requests.length === 2);
		f.finish(operationId, "requestApply", { ...availableUpdate, error: "Helper spawn failed" }, "failed", "Helper spawn failed");
		f.state = { ...f.state, quitReady: true, approval: null };
		await pending;
		expect(f.quits).toEqual([]);
		expect(f.cancelledApprovals).toEqual([f.approval]);
		expect(f.updater.updateInfo().error).toContain("Helper spawn failed");
	});

	test("a completed operation without quitReady does not start native shutdown", async () => {
		const f = fixture();
		const pending = f.updater.applyUpdate();
		await until(() => f.state.operationId !== null);
		const operationId = f.state.operationId!;
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "not-ready", preparedHash: availableUpdate.hash } };
		await until(() => f.requests.length === 2);
		f.finish(operationId, "requestApply");
		f.state = { ...f.state, approval: null, quitReady: false };
		await pending;
		expect(f.quits).toEqual([]);
		expect(f.cancelledApprovals).toEqual([f.approval]);
	});

	test("rejected native approval releases the reserved JavaScript approval", async () => {
		const f = fixture();
		f.onRequest((request) => request.action === "approveApply"
			? { schemaVersion: 1, accepted: false, operationId: null, error: "Expired approval" } : undefined);
		const pending = f.updater.applyUpdate();
		const rejection = pending.then(() => null, (error: unknown) => error);
		await until(() => f.state.operationId !== null);
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "expired", preparedHash: availableUpdate.hash } };
		expect(await rejection).toBeInstanceOf(Error);
		expect(String(await rejection)).toContain("Expired approval");
		expect(f.cancelledApprovals).toEqual([f.approval]);
		expect(f.quits).toEqual([]);
	});

	test("quitReady from a different operation cannot consume an apply approval", async () => {
		const f = fixture();
		const pending = f.updater.applyUpdate();
		await until(() => f.state.operationId !== null);
		const operationId = f.state.operationId!;
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "old-apply", preparedHash: availableUpdate.hash } };
		await until(() => f.requests.length === 2);
		f.finish(operationId, "requestApply");
		f.state = { ...f.state, operationId: "unrelated", operation: "requestApply", quitReady: true, approval: null };
		await pending;
		expect(f.quits).toEqual([]);
		expect(f.cancelledApprovals).toEqual([f.approval]);
	});

	test("a throwing before-quit handler cancels the native operation", async () => {
		const f = fixture();
		f.setApprovalError(new Error("before-quit handler failed"));
		const pending = f.updater.applyUpdate();
		const rejection = pending.then(() => null, (error: unknown) => error);
		await until(() => f.state.operationId !== null);
		const operationId = f.state.operationId!;
		f.state = { ...f.state, operationState: "awaitingApproval", approval: { id: "throwing", preparedHash: availableUpdate.hash } };
		expect(String(await rejection)).toContain("before-quit handler failed");
		expect(f.requests).toContainEqual({ schemaVersion: 1, action: "cancel", operationId });
		expect(f.quits).toEqual([]);
	});

	test("worker check failures preserve the legacy resolved error snapshot", async () => {
		const f = fixture();
		const pending = f.updater.checkForUpdate();
		await until(() => f.state.operationId !== null);
		const failed = { ...emptyUpdate, error: "HTTP 503" };
		f.finish(f.state.operationId!, "check", failed, "failed", "HTTP 503");
		expect(await pending).toEqual(failed);
		expect(f.updater.updateInfo()).toEqual(failed);
	});

	test("an unavailable core fails explicitly without consulting any fallback", async () => {
		const f = fixture();
		f.setAvailable(false);
		await expect(f.updater.checkForUpdate()).rejects.toThrow(/native core updater is unavailable or could not be configured/i);
		expect(f.requests).toEqual([]);
		expect(f.reads.stateReads).toBe(0);
		expect(f.reads.eventReads).toBe(0);
	});

	test("shutdown rejects outstanding work and stops all subsequent polling", async () => {
		const f = fixture();
		const pending = f.updater.checkForUpdate();
		const rejection = pending.then(() => null, (error: unknown) => error);
		await until(() => f.state.operationId !== null);
		f.shutdown();
		expect(String(await rejection)).toMatch(/shut down/i);
		const reads = f.reads;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(f.reads.stateReads).toBe(reads.stateReads);
		expect(f.reads.eventReads).toBe(reads.eventReads);
		await expect(f.updater.getLocalInfo()).rejects.toThrow(/shut down/i);
	});

	test("registering a listener after shutdown cannot restart native reads", async () => {
		const f = fixture();
		await f.updater.getLocalInfo();
		f.shutdown();
		const reads = f.reads;
		let callbacks = 0;
		f.updater.onStatusChange(() => { callbacks++; });
		f.pushEvent("complete", "late-reconcile");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(f.reads).toEqual(reads);
		expect(callbacks).toBe(0);
	});
});
