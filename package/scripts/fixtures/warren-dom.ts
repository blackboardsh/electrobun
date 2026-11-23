import { cleanup, createRoot, inert, live, liveScope, memo, signal } from "../../src/shared/warren/reactive";
import { For, Match, Show, Switch, jsx, render } from "../../src/browser/ui/dom";

const [release, setRelease] = signal({
	visible: true,
	command: "hutch electrobun publish --release=stable-1.2.0",
	platforms: 1,
	revision: 0,
});
const lifecycle = { mounted: 0, disposed: 0, fallbackMounted: 0 };
const container = document.querySelector("#app")!;

const dispose = render(() => jsx("main", {
	children: Show({
		when: live(() => release().visible),
		fallback: () => inert(() => {
			lifecycle.fallbackMounted++;
			return jsx("p", { id: "empty", children: "No release selected" });
		}),
		children: () => inert(() => {
			lifecycle.mounted++;
			cleanup(() => { lifecycle.disposed++; });
			return jsx("section", {
				id: "release",
				children: [
					jsx("input", { id: "draft", "aria-label": "Draft", value: "Initial draft" }),
					jsx("button", { id: "publish", type: "button", children: "Publish" }),
					jsx("p", { id: "platforms", children: live(() => `${release().platforms} platforms`) }),
					jsx("details", {
						id: "instructions",
						children: [
							jsx("summary", { children: "Publish from CI" }),
							jsx("pre", { children: jsx("code", { id: "command", children: live(() => release().command) }) }),
						],
					}),
				],
			});
		}),
	}),
}), container);

function mountStaticRows() {
	const target = document.createElement("div");
	target.id = "static-rows";
	document.body.appendChild(target);
	const [tab, setTab] = signal("desktop");
	const lifecycle = { mounted: 0, disposed: 0, rowsDisposed: 0 };
	let setHeld = (_next: string[]) => {};
	let setReady = (_next: boolean) => {};
	function Desktop() {
		if (++lifecycle.mounted > 4) throw new Error("Static For remounted its enclosing branch");
		const [held, updateHeld] = signal<string[]>([]);
		const [ready, updateReady] = signal(false);
		setHeld = updateHeld;
		setReady = updateReady;
		cleanup(() => { lifecycle.disposed++; updateHeld([]); });
		live(() => inert(() => updateReady(true)));
		return jsx("section", {
			id: "static-desktop",
			children: For({
				each: ["Shift", "Control"],
				children: (key: string) => {
					cleanup(() => { lifecycle.rowsDisposed++; });
					return jsx("button", {
						id: `hold-${key}`,
						"aria-pressed": live(() => String(held().includes(key))),
						disabled: live(() => !ready()),
						onClick: () => updateHeld([key]),
						children: key,
					});
				},
			}),
		});
	}
	const disposeRows = render(() => Switch({
		children: Match({
			when: live(() => tab() === "desktop"),
			children: () => jsx(Desktop, {}),
		}),
		fallback: jsx("aside", { children: "other tab" }),
	}), target);
	return {
		lifecycle,
		setTab,
		setHeld: (next: string[]) => setHeld(next),
		setReady: (next: boolean) => setReady(next),
		dispose() { disposeRows(); target.remove(); },
	};
}

function mountRunaway() {
	const target = document.createElement("div");
	target.id = "runaway-fixture";
	document.body.appendChild(target);
	const [armed, setArmed] = signal(false);
	const [counter, setCounter] = signal(0);
	const [clicks, setClicks] = signal(0);
	const [diagnostic, setDiagnostic] = signal("");
	const stopObserving = observeCycleErrors(error => setDiagnostic(`${error.name}: ${error.message}`));
	const lifecycle = { runs: 0, cleanups: 0 };
	const disposeRunaway = render(() => {
		live(function intentionalRunaway() {
			if (!armed()) return;
			counter();
			lifecycle.runs++;
			cleanup(() => { lifecycle.cleanups++; });
			// A baseline failure is bounded even before the runtime guard exists.
			if (lifecycle.runs > 500) throw new Error("Runaway fixture safety limit");
			setCounter(value => value + 1);
		});
		return jsx("section", { children: [
			jsx("button", {
				id: "start-runaway", children: "Start runaway updates",
				onClick: () => {
					try { setArmed(true); }
					catch (error) {
						const failure = error as Error;
						setDiagnostic(`${failure.name}: ${failure.message}`);
					}
				},
			}),
			jsx("output", { id: "runaway-diagnostic", children: live(diagnostic) }),
			jsx("output", { id: "runaway-counter", children: live(counter) }),
			jsx("button", {
				id: "healthy-button", children: live(() => `Healthy clicks: ${clicks()}`),
				onClick: () => setClicks(value => value + 1),
			}),
		] });
	}, target);
	return {
		lifecycle,
		writeAgain() { setArmed(false); setArmed(true); setCounter(value => value + 1); },
		dispose() { disposeRunaway(); stopObserving(); target.remove(); },
	};
}

function mountCreationRunaway(detached: boolean) {
	const target = document.createElement("div");
	target.id = "creation-runaway-fixture";
	document.body.appendChild(target);
	const [armed, setArmed] = signal(false);
	const [counter, setCounter] = signal(0);
	const [clicks, setClicks] = signal(0);
	const [diagnostic, setDiagnostic] = signal("");
	const stopObserving = observeCycleErrors(error => setDiagnostic(`${error.name}: ${error.message}`));
	const lifecycle = { runs: 0, cleanups: 0, rootsCreated: 0, rootsDisposed: 0, initiatorCleanups: 0 };
	function spawn() {
		lifecycle.runs++;
		cleanup(() => { lifecycle.cleanups++; });
		// The old scheduler must also fail in bounded time during regression runs.
		if (lifecycle.runs > 500) throw new Error("Fresh-scope fixture safety limit");
		setCounter(value => value + 1);
		if (detached) {
			createRoot(() => {
				lifecycle.rootsCreated++;
				cleanup(() => { lifecycle.rootsDisposed++; });
				liveScope(spawn);
			});
		} else liveScope(spawn);
	}
	const disposeCreation = render(() => {
		live(function initiateCreationChain() {
			if (!armed()) return;
			cleanup(() => { lifecycle.initiatorCleanups++; });
			liveScope(spawn);
		});
		return jsx("section", { children: [
			jsx("button", {
				id: "start-creation-runaway", children: "Start fresh-scope chain",
				onClick: () => {
					try { setArmed(true); }
					catch (error) {
						const failure = error as Error;
						setDiagnostic(`${failure.name}: ${failure.message}`);
					}
				},
			}),
			jsx("output", { id: "creation-diagnostic", children: live(diagnostic) }),
			jsx("output", { id: "creation-counter", children: live(counter) }),
			jsx("button", {
				id: "creation-healthy-button", children: live(() => `Healthy clicks: ${clicks()}`),
				onClick: () => setClicks(value => value + 1),
			}),
		] });
	}, target);
	return {
		lifecycle,
		writeAgain() { setArmed(false); setArmed(true); setCounter(value => value + 1); },
		dispose() { disposeCreation(); stopObserving(); target.remove(); },
	};
}

function observeCycleErrors(report: (error: Error) => void) {
	const listener = (event: ErrorEvent) => {
		if (event.error?.name !== "WarrenReactiveCycleError") return;
		event.preventDefault();
		report(event.error);
	};
	window.addEventListener("error", listener);
	return () => window.removeEventListener("error", listener);
}

function mountCooperativeRunaway(mode: "parallel" | "fresh" | "microtask" | "promise", workPlacement: "effect" | "callback" = "effect") {
	const target = document.createElement("div");
	target.id = "cooperative-fixture";
	document.body.appendChild(target);
	const count = mode === "parallel" ? 12 : 1;
	const asyncFeedback = mode === "microtask" || mode === "promise";
	const [armed, setArmed] = signal(false);
	const [clicks, setClicks] = signal(0);
	const lifecycle = {
		runs: Array(count).fill(0) as number[], cleanups: Array(count).fill(0) as number[],
		diagnostics: [] as string[], timersDuring: 0, framesDuring: 0,
		clicksDuring: 0, derivedDuring: [] as number[], externalDuring: [] as number[],
		callbacksQueued: 0, callbacksRun: 0, cancelledCallbacks: 0,
	};
	let started = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let frame: number | undefined;
	const pending = () => started && !stopped && (asyncFeedback
		? lifecycle.runs[0]! < 300
		: lifecycle.runs.some((runs, index) => runs > lifecycle.cleanups[index]!));
	const spin = (milliseconds: number) => {
		const until = performance.now() + milliseconds;
		while (performance.now() < until) { /* Deliberately costly application work. */ }
	};
	const record = (error: Error) => lifecycle.diagnostics.push(`${error.name}: ${error.message}`);
	const stopObserving = observeCycleErrors(record);
	const disposeFaults = createRoot(dispose => {
		if (mode === "parallel") {
			for (let index = 0; index < count; index++) {
				const [value, setValue] = signal(0);
				live(function costlyProducer() {
					if (!armed()) return;
					value();
					lifecycle.runs[index]++;
					cleanup(() => { lifecycle.cleanups[index]++; });
					if (lifecycle.runs[index]! > 500) throw new Error("Cooperative fixture safety limit");
					spin(1);
					setValue(current => current + 1);
				});
			}
		} else if (asyncFeedback) {
			const [value, setValue] = signal(0);
			live(function finiteAsyncFeedback() {
				if (!armed()) return;
				const current = value();
				lifecycle.runs[0]++;
				let cancelled = false;
				cleanup(() => { lifecycle.cleanups[0]++; cancelled = true; });
				if (workPlacement === "effect") spin(1);
				if (lifecycle.runs[0]! >= 300) return;
				lifecycle.callbacksQueued++;
				const advance = () => {
					lifecycle.callbacksRun++;
					// Microtasks cannot be removed; ownership cleanup invalidates
					// their work when this effect or its root has been disposed.
					if (cancelled || stopped) { lifecycle.cancelledCallbacks++; return; }
					if (workPlacement === "callback") spin(1);
					setValue(current + 1);
				};
				if (mode === "microtask") queueMicrotask(advance);
				else void Promise.resolve().then(advance);
			});
		} else {
			function spawnCostlyScope() {
				lifecycle.runs[0]++;
				cleanup(() => { lifecycle.cleanups[0]++; });
				if (lifecycle.runs[0]! > 500) throw new Error("Cooperative fresh-scope safety limit");
				spin(5);
				liveScope(spawnCostlyScope);
			}
			live(() => { if (armed()) liveScope(spawnCostlyScope); });
		}
		return dispose;
	});
	const disposeUI = render(() => {
		const doubled = memo(() => clicks() * 2);
		return jsx("section", { children: [
			jsx("button", {
				id: "cooperative-healthy-button", children: "Healthy control",
				onClick: () => {
					if (pending()) { lifecycle.clicksDuring++; setExternal(7); }
					setClicks(value => value + 1);
				},
			}),
			jsx("output", { id: "cooperative-derived", children: live(() => {
				const value = doubled();
				if (pending()) lifecycle.derivedDuring.push(value);
				return value;
			}) }),
		] });
	}, target);
	let disposeExternal = () => {};
	let setExternal = (_next: number) => {};
	const mountExternal = () => {
		const external = document.createElement("div");
		external.id = "cooperative-external";
		target.appendChild(external);
		const [value, updateValue] = signal(3);
		setExternal = updateValue;
		disposeExternal = render(() => {
			const doubled = memo(() => value() * 2);
			return jsx("output", { children: live(() => {
				const value = doubled();
				if (pending()) lifecycle.externalDuring.push(value);
				return value;
			}) });
		}, external);
	};
	const tick = () => { if (pending()) lifecycle.timersDuring++; timer = setTimeout(tick, 0); };
	const draw = () => { if (pending()) lifecycle.framesDuring++; frame = requestAnimationFrame(draw); };
	return {
		lifecycle, pending,
		start() {
			started = true;
			timer = setTimeout(tick, 0);
			frame = requestAnimationFrame(draw);
			try { setArmed(true); } catch (error) { record(error as Error); }
		},
		mountExternal,
		setExternal: (value: number) => setExternal(value),
		stopFaults() { stopped = true; disposeFaults(); },
		dispose() {
			stopped = true;
			disposeFaults(); disposeUI(); disposeExternal(); stopObserving();
			clearTimeout(timer); if (frame !== undefined) cancelAnimationFrame(frame);
			target.remove();
		},
	};
}

Object.assign(window, {
	warrenFixture: {
		// A network response is a fresh object even when all displayed fields agree.
		poll: () => setRelease(current => ({ ...current, revision: current.revision + 1 })),
		update: (patch: Partial<ReturnType<typeof release>>) => setRelease(current => ({ ...current, ...patch })),
		lifecycle,
		dispose,
		mountStaticRows,
		mountRunaway,
		mountCreationRunaway,
		mountCooperativeRunaway,
	},
});
