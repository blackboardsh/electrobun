import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { batch, cleanup, createRoot, inert, live, liveScope, memo, setDevMode, signal } from "./reactive";

function caught(action: () => void): any {
	let reported: unknown;
	const log = spyOn(console, "error").mockImplementation(error => { reported = error; });
	try {
		try { action(); } catch (error) { return error; }
		if (reported !== undefined) return reported;
	} finally { log.mockRestore(); }
	throw new Error("Expected a reactive cycle diagnostic");
}

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
	// Fail inside the fixture's try/finally before Bun's outer test timeout.
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Reactive work did not settle");
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

async function caughtAsync(action: () => void): Promise<any> {
	let result: unknown;
	const report = spyOn(console, "error").mockImplementation(error => { result = error; });
	try {
		try { action(); } catch (error) { result = error; }
		await waitFor(() => result !== undefined);
		return result;
	} finally { report.mockRestore(); }
}

function spendHostTurnBudget(): void {
	const [value] = signal(0);
	let dispose = () => {};
	try {
		createRoot(stop => {
			dispose = stop;
			for (let i = 0; i < 2048; i++) live(() => { value(); });
		});
	} finally { dispose(); }
}

describe("Warren reactive failure containment", () => {
	let restoreClock = () => {};
	beforeEach(async () => {
		// Each logical interaction starts in a fresh host task. A test runner's
		// sequence of microtasks must not consume the preceding test's budget.
		await new Promise(resolve => setTimeout(resolve, 0));
		// Logical graph tests use deterministic execution counts. Separate real
		// browser tests assert timers and painting during yielded work.
		const clock = spyOn(performance, "now").mockReturnValue(0);
		restoreClock = () => clock.mockRestore();
	});
	afterEach(async () => {
		restoreClock();
		await new Promise(resolve => setTimeout(resolve, 0));
	});
	test("a self-writing live stops, cleans up, and drains unrelated work", () => {
		const [enabled, enable] = signal(false);
		const [value, setValue] = signal(0);
		const [healthy, setHealthy] = signal(0);
		let runs = 0, cleaned = 0, observed = -1;
		let dispose = () => {};
		try {
			createRoot(stop => {
				dispose = stop;
				live(function selfWritingView() {
					if (!enabled()) return;
					if (++runs > 500) throw new Error("baseline runaway sentinel");
					cleanup(() => { cleaned++; });
					setHealthy(runs);
					setValue(value() + 1);
				});
				live(() => { observed = healthy(); });
			});
			const error = caught(() => enable(true));
			expect(error.name).toBe("WarrenReactiveCycleError");
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(error.message).toContain("selfWritingView");
			expect(runs).toBeLessThanOrEqual(100);
			expect(cleaned).toBe(runs);
			expect(observed).toBe(runs);
			const stoppedAt = runs;
			setValue(1000);
			setHealthy(777);
			expect(runs).toBe(stoppedAt);
			expect(observed).toBe(777);
		} finally { dispose(); }
		expect(cleaned).toBe(runs);
	});

	test("two effects cannot keep each other running after a cycle is stopped", () => {
		const [enabled, enable] = signal(false);
		const [a, setA] = signal(0), [b, setB] = signal(0);
		let runs = 0;
		let dispose = () => {};
		try {
			createRoot(stop => {
				dispose = stop;
				live(() => { if (enabled()) { if (++runs > 500) throw new Error("baseline runaway sentinel"); setB(a() + 1); } });
				live(() => { if (enabled()) { if (++runs > 500) throw new Error("baseline runaway sentinel"); setA(b() + 1); } });
			});
			expect(caught(() => enable(true)).name).toBe("WarrenReactiveCycleError");
			expect(runs).toBeLessThanOrEqual(200);
			const before = runs;
			setA(1000); setB(2000);
			expect(runs - before).toBeLessThanOrEqual(2);
		} finally { dispose(); }
	});

	test("a remount cycle is bounded even when each pass creates fresh children", () => {
		const [revision, setRevision] = signal(0);
		let mounted = 0, cleaned = 0, childrenCleaned = 0;
		let dispose = () => {};
		try {
			const error = caught(() => createRoot(stop => {
				dispose = stop;
				liveScope(() => {
					revision();
					if (++mounted > 500) throw new Error("baseline runaway sentinel");
					cleanup(() => { cleaned++; });
					inert(() => live(() => {
						cleanup(() => { childrenCleaned++; });
						setRevision(value => value + 1);
					}));
				});
			}));
			expect(error.name).toBe("WarrenReactiveCycleError");
			expect(mounted).toBeLessThanOrEqual(100);
			expect(cleaned).toBe(mounted);
			expect(childrenCleaned).toBe(mounted);
			setRevision(value => value + 1);
			expect(cleaned).toBe(mounted);
		} finally { dispose(); }
	});

	test("serial fresh-scope creation stops without dropping unrelated queued work", () => {
		for (const detached of [false, true]) {
			const [healthy, setHealthy] = signal(0);
			let runs = 0, cleaned = 0, observed = 0;
			let dispose = () => {};
			try {
				const error = caught(() => createRoot(stop => {
					dispose = stop;
					live(() => { observed = healthy(); });
					function spawnAnotherScope() {
						if (++runs > 500) throw new Error("baseline fresh-scope sentinel");
						cleanup(() => { cleaned++; });
						setHealthy(runs);
						if (detached) createRoot(() => liveScope(spawnAnotherScope));
						else liveScope(spawnAnotherScope);
					}
					liveScope(spawnAnotherScope);
				}));
				expect(error.name).toBe("WarrenReactiveCycleError");
				expect(error.message).toContain("chain of");
				expect(runs).toBeLessThanOrEqual(256);
				expect(cleaned).toBe(runs);
				expect(observed).toBe(runs);
				setHealthy(999);
				expect(observed).toBe(999);
			} finally { dispose(); }
			expect(cleaned).toBe(runs);
		}
	});

	test("slow fresh-scope chains stop on their lineage time budget", async () => {
		let clock = 0;
		const timer = spyOn(performance, "now").mockImplementation(() => clock);
		let runs = 0, cleaned = 0, dispose = () => {};
		try {
			const error = await caughtAsync(() => createRoot(stop => {
				dispose = stop;
				function spawnAnotherScope() {
					if (++runs > 500) throw new Error("baseline fresh-scope sentinel");
					clock += 10;
					cleanup(() => { cleaned++; });
					liveScope(spawnAnotherScope);
				}
				liveScope(spawnAnotherScope);
			}));
			expect(error.name).toBe("WarrenReactiveCycleError");
			expect(runs).toBe(32);
			expect(cleaned).toBe(runs);
		} finally { try { dispose(); } finally { timer.mockRestore(); } }
	});

	test("cleanup writes do not requeue their old owner and cleanup reads stay untracked", () => {
		const [selected, select] = signal(0), [cleanupOnly, setCleanupOnly] = signal(0);
		let runs = 0, cleaned = 0;
		let dispose = () => {};
		try {
			createRoot(stop => {
				dispose = stop;
				live(() => {
					selected(); runs++;
					cleanup(() => { cleaned++; cleanupOnly(); select(value => value + 1); });
				});
			});
			select(10);
			expect(runs).toBe(2);
			expect(cleaned).toBe(1);
			setCleanupOnly(10);
			expect(runs).toBe(2);
		} finally { dispose(); }
		expect(cleaned).toBe(2);
	});

	test("direct and indirect recursive memos give a bounded diagnostic", () => {
		for (const indirect of [false, true]) {
			let dispose = () => {};
			try {
				const error = caught(() => createRoot(stop => {
					dispose = stop;
					let a: () => number, b: () => number;
					a = memo(function recursiveMemo() { return indirect ? b() : a(); });
					b = memo(() => a());
					a();
				}));
				expect(error.name).toBe("WarrenReactiveCycleError");
				expect(error.message).toContain("recursively entered");
			} finally { dispose(); }
		}
	});

	test("a cyclic observed memo does not prevent later subscribers from receiving the write", () => {
		const [enabled, enable] = signal(false);
		let observed = false, dispose = () => {};
		try {
			createRoot(stop => {
				dispose = stop;
				const bad: () => number = memo(() => enabled() ? bad() : 1);
				live(() => { bad(); });
				live(() => { observed = enabled(); });
			});
			expect(caught(() => enable(true)).name).toBe("WarrenReactiveCycleError");
			expect(observed).toBe(true);
			enable(false);
			expect(observed).toBe(false);
		} finally { dispose(); }
	});

	test("a slow repeated live stops on its time budget without rejecting a one-off slow live", async () => {
		let clock = 0;
		const timer = spyOn(performance, "now").mockImplementation(() => clock);
		const [value, setValue] = signal(0);
		let runs = 0, dispose = () => {};
		try {
			const error = await caughtAsync(() => createRoot(stop => {
				dispose = stop;
				live(() => { if (++runs > 500) throw new Error("baseline runaway sentinel"); clock += 10; setValue(value() + 1); });
			}));
			expect(error.name).toBe("WarrenReactiveCycleError");
			expect(runs).toBe(8);
			dispose();
			let once = 0;
			createRoot(stop => {
				dispose = stop;
				live(() => inert(() => { once++; clock += 10_000; }));
			});
			expect(once).toBe(1);
		} finally { try { dispose(); } finally { timer.mockRestore(); } }
	});

	test("bounded convergence and more than 100,000 distinct live bindings still settle", async () => {
		const [value, setValue] = signal(0);
		let iterations = 0;
		let dispose = () => {};
		let updates = 0;
		try {
			createRoot(stop => {
				dispose = stop;
				live(() => { iterations++; if (value() < 3) setValue(value() + 1); });
			});
			expect(iterations).toBe(4);
			dispose();
			createRoot(stop => {
				dispose = stop;
				for (let i = 0; i < 100_005; i++) live(() => { value(); updates++; });
			});
			await waitFor(() => updates === 100_005, 10_000);
			expect(updates).toBe(100_005);
			batch(() => { setValue(4); setValue(5); });
			await waitFor(() => updates === 200_010, 10_000);
			expect(updates).toBe(200_010);
		} finally { dispose(); }
		// Over 200,000 executions plus allocation/teardown exceed Bun's default
		// five seconds on Intel VMs. Both waits remain bounded below this deadline.
	}, 30_000);

	for (const deferred of [false, true]) {
		test(`throwing cleanup does not hide the cycle or prevent other teardown${deferred ? " after yielding" : ""}`, async () => {
			const [value, setValue] = signal(0);
			let runs = 0, cleaned = 0, dispose = () => {};
			try {
				if (deferred) spendHostTurnBudget();
				const error = await caughtAsync(() => {
					createRoot(stop => {
						dispose = stop;
						live(() => {
							if (++runs > 500) throw new Error("baseline runaway sentinel");
							cleanup(() => { cleaned++; });
							cleanup(() => { if (runs >= 100) throw new Error("cleanup failed"); });
							setValue(value() + 1);
						});
					});
					if (deferred) expect(runs).toBe(0);
				});
				expect(error.name).toBe("WarrenReactiveCycleError");
				expect(error.cleanupError?.message).toBe("cleanup failed");
				expect(cleaned).toBe(runs);
			} finally { dispose(); }
		});

		test(`the initial statement live still warns about zero dependencies${deferred ? " after yielding" : ""}`, async () => {
			setDevMode(true);
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			let ran = false, dispose = () => {};
			try {
				if (deferred) spendHostTurnBudget();
				// Warnings are deduplicated by source, so each scheduling path
				// needs its own call site even though their behavior is identical.
				const body = deferred
					? function initialZeroDependenciesRegressionDeferred() { ran = true; }
					: function initialZeroDependenciesRegression() { ran = true; };
				createRoot(stop => { dispose = stop; live(body); });
				expect(ran).toBe(!deferred);
				await waitFor(() => ran);
				expect(warn.mock.calls.some(call => String(call[0]).includes("zero dependencies") && String(call[0]).includes("initialZeroDependenciesRegression"))).toBe(true);
			} finally { try { dispose(); } finally { warn.mockRestore(); } }
		});
	}
});
