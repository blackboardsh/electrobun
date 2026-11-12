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
	testId?: string;
	at?: string;
	tMs?: number;
	stalledForMs: number;
};

type PhaseKind = "fullscreen" | "fixture";
type ActivePhase = {
	kind: PhaseKind;
	phase: FullscreenPhase;
	cancel?: () => void;
	ready: boolean;
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
	const active: Partial<Record<PhaseKind, ActivePhase>> = {};
	const captured = { fullscreen: false, fixture: false };
	let closed = false;
	let pending: Promise<void> | undefined;
	const clear = (kind: PhaseKind) => {
		active[kind]?.cancel?.();
		delete active[kind];
	};
	const tryCapture = (state: ActivePhase) => {
		if (closed || captured[state.kind] || active[state.kind] !== state || !state.ready || pending) return;
		captured[state.kind] = true;
		state.ready = false;
		// Publish the in-flight promise before calling capture, including when it
		// throws synchronously. Both phase budgets share this serialization point.
		let complete!: () => void;
		pending = new Promise<void>(resolve => { complete = resolve; });
		void (async () => {
			try { await capture(state.phase); } catch (error) {
				try { onError(error); } catch { /* Diagnostics must not change the app result. */ }
			} finally {
				pending = undefined;
				complete();
				if (!closed) {
					for (const next of [active.fullscreen, active.fixture]) {
						if (next) tryCapture(next);
					}
				}
			}
		})();
	};
	return {
		observeLine(line: string) {
			if (!enabled || closed || !line.startsWith(marker) || line.length > 16_384) return;
			let value: unknown;
			try { value = JSON.parse(line.slice(marker.length)); } catch { return; }
			if (!value || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			if (typeof record["operation"] !== "string") return;
			const kind: PhaseKind = record["operation"] === "fixture.construct" ? "fixture" : "fullscreen";
			if (kind === "fullscreen" && !watchedOperations.has(record["operation"])) return;
			if (record["windowId"] !== undefined && (!Number.isSafeInteger(record["windowId"]) || Number(record["windowId"]) < 1)) return;
			if (record["testId"] !== undefined && typeof record["testId"] !== "string") return;
			if (record["phase"] === "end") {
				const phase = active[kind]?.phase;
				if (phase?.operation === record["operation"] &&
					(phase.windowId === undefined || phase.windowId === record["windowId"]) &&
					(phase.testId === undefined || phase.testId === record["testId"])) clear(kind);
				return;
			}
			if (record["phase"] !== "start") return;
			// Fullscreen creation owns its nested fixture markers, even after the
			// fullscreen capture budget is spent. Only its matching end releases it.
			if (kind === "fixture" && active.fullscreen) return;
			clear(kind);
			if (kind === "fullscreen") clear("fixture");
			const phase: FullscreenPhase = {
				operation: record["operation"],
				...(typeof record["windowId"] === "number" ? { windowId: record["windowId"] } : {}),
				...(typeof record["testId"] === "string" ? { testId: record["testId"] } : {}),
				...(typeof record["at"] === "string" ? { at: record["at"] } : {}),
				...(typeof record["tMs"] === "number" ? { tMs: record["tMs"] } : {}),
				stalledForMs: kind === "fullscreen" ? 3000 : 5000,
			};
			const state: ActivePhase = { kind, phase, ready: false };
			active[kind] = state;
			if (captured[kind]) return;
			state.cancel = schedule(() => {
				state.cancel = undefined;
				state.ready = true;
				tryCapture(state);
			}, phase.stalledForMs);
		},
		// The sampler bounds its own subprocesses. Finish lets an already-started
		// report complete before the matrix exits, without changing the app result.
		async finish() {
			closed = true;
			clear("fullscreen");
			clear("fixture");
			await pending;
		},
	};
}
