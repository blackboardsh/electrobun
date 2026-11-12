const marker = "[kitchen window phase] ";
const watchedOperations = new Set([
	"fullscreen.createWindow",
	"fullscreen.initialState",
	"baseline.isFullScreen",
	"baseline.getFrame",
	"baseline.getPrimaryDisplay",
	"fullscreen.setTrue",
	"fullscreen.setFalse",
	"fullscreen.enterObservationAndAssert",
	"fullscreen.exitObservationAndAssert",
]);

export type FullscreenPhase = {
	operation: string;
	windowId?: number;
	at?: string;
	tMs?: number;
};

type Schedule = (callback: () => void, delayMs: number) => () => void;
const scheduleTimer: Schedule = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
};

// This runs in the matrix parent, so a synchronous native call blocking the
// app's JavaScript thread cannot prevent the diagnostic timer from firing.
export function createFullscreenPhaseWatcher({
	enabled, capture, onError, schedule = scheduleTimer,
}: {
	enabled: boolean;
	capture: (phase: FullscreenPhase) => Promise<void>;
	onError: (error: unknown) => void;
	schedule?: Schedule;
}) {
	let active: FullscreenPhase | undefined;
	let cancel: (() => void) | undefined;
	let captured = false;
	let closed = false;
	let pending: Promise<void> | undefined;
	const clear = () => {
		cancel?.();
		cancel = undefined;
		active = undefined;
	};
	return {
		observeLine(line: string) {
			if (!enabled || closed || captured || !line.startsWith(marker) || line.length > 16_384) return;
			let value: unknown;
			try { value = JSON.parse(line.slice(marker.length)); } catch { return; }
			if (!value || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			if (typeof record["operation"] !== "string" || !watchedOperations.has(record["operation"])) return;
			if (record["windowId"] !== undefined && (!Number.isSafeInteger(record["windowId"]) || Number(record["windowId"]) < 1)) return;
			if (record["phase"] === "end") {
				if (active?.operation === record["operation"] &&
					(active.windowId === undefined || active.windowId === record["windowId"])) clear();
				return;
			}
			if (record["phase"] !== "start") return;
			clear();
			const phase: FullscreenPhase = {
				operation: record["operation"],
				...(typeof record["windowId"] === "number" ? { windowId: record["windowId"] } : {}),
				...(typeof record["at"] === "string" ? { at: record["at"] } : {}),
				...(typeof record["tMs"] === "number" ? { tMs: record["tMs"] } : {}),
			};
			active = phase;
			cancel = schedule(() => {
				cancel = undefined;
				if (closed || captured || active !== phase) return;
				captured = true;
				pending = (async () => {
					try { await capture(phase); } catch (error) {
						try { onError(error); } catch { /* Diagnostic output must not change the app result. */ }
					}
				})();
			}, 3000);
		},
		// The sampler bounds its own subprocesses. Finish lets an already-started
		// report complete before the matrix exits, without changing the app result.
		async finish() {
			closed = true;
			clear();
			await pending;
		},
	};
}
