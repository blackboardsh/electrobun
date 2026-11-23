import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { batch, cleanup, createRoot, inert, live, liveScope, signal } from "./reactive";

function cycleFrom(action: () => void): any {
	const reported: unknown[] = [];
	const report = spyOn(console, "error").mockImplementation((error: unknown) => { reported.push(error); });
	let thrown: unknown, failed = false;
	try { action(); } catch (error) { thrown = error; failed = true; }
	finally { report.mockRestore(); }
	// Browser event boundaries may receive a synchronous exception; native
	// renderers report nonfatally so a guarded effect cannot terminate the app.
	// Both paths must identify the cycle exactly once.
	expect(reported.length + Number(failed)).toBe(1);
	return failed ? thrown : reported[0];
}

describe("Warren causal failure containment", () => {
	let clock: ReturnType<typeof spyOn>;
	// These small logical cases stay below the work-count yield threshold.
	// Freeze elapsed time so a loaded CI runner cannot switch their failure
	// delivery from the calling write to a later task. Browser tests exercise
	// the real clock, heartbeat and input responsiveness separately.
	beforeEach(() => { clock = spyOn(performance, "now").mockReturnValue(0); });
	afterEach(() => { clock.mockRestore(); });

	test("a readonly dynamic region survives a producer cycle even when it creates bindings", () => {
		const [value, setValue] = signal(0), [enabled, enable] = signal(false);
		let observations = 0, producerRuns = 0, rowsCreated = 0, rowsCleaned = 0;
		const dispose = createRoot(stop => {
			liveScope(function healthyRegion() {
				value(); observations++;
				inert(() => live(() => {
					value(); rowsCreated++;
					cleanup(() => { rowsCleaned++; });
				}));
			});
			liveScope(function brokenProducer() {
				if (!enabled()) return;
				if (++producerRuns > 500) throw new Error("producer runaway sentinel");
				setValue(value() + 1);
			});
			return stop;
		});
		try {
			// Queue the observer before the producer: containment must identify
			// the write feedback, rather than whichever scope reaches 100 first.
			const error = cycleFrom(() => batch(() => { setValue(1); enable(true); }));
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(error.message).toContain("brokenProducer");
			expect(error.message).not.toContain("healthyRegion");
			const before = observations, stoppedAt = producerRuns;
			setValue(9999);
			expect(observations).toBe(before + 1);
			expect(producerRuns).toBe(stoppedAt);
		} finally { dispose(); }
		expect(rowsCleaned).toBe(rowsCreated);
	});

	test("quarantine cleanup cannot start detached roots whose resources would leak", () => {
		let runs = 0, cleaned = 0, attemptedRoots = 0, startedRoots = 0, cleanedRoots = 0;
		let dispose = () => {};
		function freshChain() {
			if (++runs > 500) throw new Error("fresh-scope runaway sentinel");
			cleanup(() => { cleaned++; });
			cleanup(() => {
				attemptedRoots++;
				createRoot(() => {
					startedRoots++;
					cleanup(() => { cleanedRoots++; });
				});
			});
			liveScope(freshChain);
		}
		const error = cycleFrom(() => createRoot(stop => {
			dispose = stop;
			liveScope(freshChain);
		}));
		try {
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(error.cleanupError?.message).toContain("cannot start a root");
			expect(runs).toBeLessThanOrEqual(256);
			expect(attemptedRoots).toBe(runs);
			expect(startedRoots).toBe(0);
			expect(cleanedRoots).toBe(0);
			expect(cleaned).toBe(runs);
		} finally { dispose(); }
		expect(cleaned).toBe(runs);
	});

	test("a repeated producer releases detached roots created before quarantine", () => {
		const [value, setValue] = signal(0);
		let runs = 0, rootsCreated = 0, rootsCleaned = 0, dispose = () => {};
		const error = cycleFrom(() => createRoot(stop => {
			dispose = stop;
			liveScope(function repeatedProducer() {
				if (++runs > 500) throw new Error("producer runaway sentinel");
				createRoot(() => {
					rootsCreated++;
					cleanup(() => { rootsCleaned++; });
				});
				setValue(value() + 1);
			});
		}));
		try {
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(runs).toBeLessThanOrEqual(100);
			expect(rootsCreated).toBe(runs);
			expect(rootsCleaned).toBe(rootsCreated);
			setValue(9999);
			expect(rootsCreated).toBe(runs);
		} finally { dispose(); }
		expect(rootsCleaned).toBe(rootsCreated);
	});

	test("stopping one child producer preserves siblings sharing its creator", () => {
		const [value, setValue] = signal(0), [healthy, setHealthy] = signal(0);
		let producerRuns = 0, observed = -1, healthyCleaned = 0, dispose = () => {};
		const error = cycleFrom(() => createRoot(stop => {
			dispose = stop;
			liveScope(function initializePanel() {
				liveScope(function healthySibling() {
					observed = healthy();
					cleanup(() => { healthyCleaned++; });
				});
				liveScope(function brokenChild() {
					if (++producerRuns > 500) throw new Error("producer runaway sentinel");
					setValue(value() + 1);
				});
			});
		}));
		try {
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(error.message).toContain("brokenChild");
			expect(observed).toBe(0);
			expect(healthyCleaned).toBe(0);
			setHealthy(7);
			expect(observed).toBe(7);
			expect(healthyCleaned).toBe(1);
		} finally { dispose(); }
		expect(healthyCleaned).toBe(2);
	});

	test("stopping a fresh-scope chain preserves siblings sharing its creator", () => {
		const [healthy, setHealthy] = signal(0);
		let chainRuns = 0, chainCleaned = 0, observed = -1, healthyCleaned = 0, dispose = () => {};
		function freshChain() {
			if (++chainRuns > 500) throw new Error("fresh-scope runaway sentinel");
			cleanup(() => { chainCleaned++; });
			liveScope(freshChain);
		}
		const error = cycleFrom(() => createRoot(stop => {
			dispose = stop;
			liveScope(function initializePanel() {
				liveScope(function healthySibling() {
					observed = healthy();
					cleanup(() => { healthyCleaned++; });
				});
				liveScope(freshChain);
			});
		}));
		try {
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(error.message).toContain("in: function freshChain");
			expect(chainRuns).toBeLessThanOrEqual(256);
			expect(chainCleaned).toBe(chainRuns);
			expect(observed).toBe(0);
			expect(healthyCleaned).toBe(0);
			setHealthy(7);
			expect(observed).toBe(7);
			expect(healthyCleaned).toBe(1);
		} finally { dispose(); }
		expect(chainCleaned).toBe(chainRuns);
		expect(healthyCleaned).toBe(2);
	});

	for (const detached of [false, true]) {
		test(`a ${detached ? "detached-root" : "child-scope"} chain preserves a resource-only sibling root`, () => {
			let runs = 0, scopesCleaned = 0, rootsCreated = 0, rootsCleaned = 0, healthyCleaned = 0;
			let dispose = () => {}, disposeHealthy = () => {};
			function freshChain() {
				if (++runs > 500) throw new Error("fresh-scope runaway sentinel");
				cleanup(() => { scopesCleaned++; });
				if (detached) {
					createRoot(() => {
						rootsCreated++;
						cleanup(() => { rootsCleaned++; });
						liveScope(freshChain);
					});
				} else liveScope(freshChain);
			}
			const error = cycleFrom(() => createRoot(stop => {
				dispose = stop;
				liveScope(function initializePanel() {
					// This root may own a timer or native resource without any
					// queued live computation. It is still a healthy sibling.
					createRoot(stop => {
						disposeHealthy = stop;
						cleanup(() => { healthyCleaned++; });
					});
					liveScope(freshChain);
				});
			}));
			try {
				expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
				expect(error.message).toContain("in: function freshChain");
				expect(runs).toBeGreaterThan(0);
				expect(runs).toBeLessThanOrEqual(256);
				expect(scopesCleaned).toBe(runs);
				expect(rootsCreated).toBe(detached ? runs : 0);
				expect(rootsCleaned).toBe(rootsCreated);
				expect(healthyCleaned).toBe(0);
				dispose();
				expect(scopesCleaned).toBe(runs);
				expect(rootsCleaned).toBe(rootsCreated);
				expect(healthyCleaned).toBe(0);
				disposeHealthy();
				expect(healthyCleaned).toBe(1);
			} finally { dispose(); disposeHealthy(); }
		});
	}

	test("a shared detached root remains alive when only one of its child branches cycles", () => {
		const [healthy, setHealthy] = signal(0);
		let observed = -1, rootCleaned = 0, chainRuns = 0, chainCleaned = 0;
		let dispose = () => {}, disposeShared = () => {};
		function freshChain() {
			if (++chainRuns > 500) throw new Error("fresh-scope runaway sentinel");
			cleanup(() => { chainCleaned++; });
			liveScope(freshChain);
		}
		const error = cycleFrom(() => createRoot(stop => {
			dispose = stop;
			liveScope(function initializePanel() {
				createRoot(stop => {
					disposeShared = stop;
					cleanup(() => { rootCleaned++; });
					liveScope(function healthySibling() { observed = healthy(); });
					liveScope(freshChain);
				});
			});
		}));
		try {
			expect(error.code).toBe("WARREN_REACTIVE_CYCLE");
			expect(error.message).toContain("in: function freshChain");
			expect(chainCleaned).toBe(chainRuns);
			expect(rootCleaned).toBe(0);
			setHealthy(7);
			expect(observed).toBe(7);
			dispose();
			expect(rootCleaned).toBe(0);
			setHealthy(8);
			expect(observed).toBe(8);
			disposeShared();
			expect(rootCleaned).toBe(1);
			expect(chainCleaned).toBe(chainRuns);
		} finally { dispose(); disposeShared(); }
	});
});
