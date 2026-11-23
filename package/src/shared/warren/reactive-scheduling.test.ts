import { expect, spyOn, test } from "bun:test";
import { batch, cleanup, createRoot, live, liveScope, memo, setDevMode, signal } from "./reactive";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await tick();
	}
}

for (const { continuation, workLocation } of [
	{ continuation: "queueMicrotask", workLocation: "effect" },
	{ continuation: "Promise.then", workLocation: "effect" },
	{ continuation: "Promise.then", workLocation: "microtask" },
] as const) {
	test(`${continuation} feedback with work in the ${workLocation} yields even when every flush empties`, async () => {
		await tick();
		const errors: unknown[] = [];
		const report = spyOn(console, "error").mockImplementation(error => { errors.push(error); });
		setDevMode(false);
		const [value, setValue] = signal(0);
		const [healthy, setHealthy] = signal(0);
		let runs = 0, runsAtTimer = -1, runsAtHealthyUpdate = -1, observed = 0;
		let dispose = () => {};
		const heartbeats: number[] = [];
		let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = new Promise<void>(resolve => {
			const beat = () => {
				heartbeats.push(runs);
				if (runsAtTimer < 0) {
					runsAtTimer = runs;
					setHealthy(7);
					resolve();
				}
				if (runs < 301) heartbeatTimer = setTimeout(beat, 0);
			};
			heartbeatTimer = setTimeout(beat, 0);
		});
		try {
			dispose = createRoot(stop => {
				liveScope(() => {
					const current = value();
					runs++;
					// Always bounded, including against a runtime without the fix.
					if (current >= 300) return;
					const spendOneMillisecond = () => {
						const end = performance.now() + 1;
						while (performance.now() < end) {}
					};
					if (workLocation === "effect") spendOneMillisecond();
					const update = () => {
						if (workLocation === "microtask") spendOneMillisecond();
						setValue(current + 1);
					};
					if (continuation === "queueMicrotask") queueMicrotask(update);
					else void Promise.resolve().then(update);
				});
				const derived = memo(() => healthy() * 2);
				liveScope(() => {
					observed = derived();
					if (observed === 14) runsAtHealthyUpdate = runs;
				});
				return stop;
			});
			await timer;
			expect(runsAtTimer).toBeGreaterThanOrEqual(0);
			// Each iteration deliberately costs at least 1ms. A generous count
			// bound catches a greatly delayed yield without wall-clock flakiness.
			expect(runsAtTimer).toBeLessThanOrEqual(32);
			await waitFor(() => observed === 14, "Microtask feedback stranded an independent input update");
			expect(runsAtHealthyUpdate).toBeLessThanOrEqual(64);
			await waitFor(() => runs === 301 && value() === 300, "Bounded microtask updates failed to finish");
			expect(heartbeats.filter(count => count > 0 && count < 301).length).toBeGreaterThanOrEqual(3);
			const checkpoints = [0, ...heartbeats, runs];
			expect(Math.max(...checkpoints.slice(1).map((count, index) => count - checkpoints[index]!))).toBeLessThanOrEqual(64);
			expect(errors).toEqual([]);
		} finally {
			dispose();
			await timer;
			clearTimeout(heartbeatTimer);
			await tick();
			setDevMode(true);
			report.mockRestore();
		}
	}, 10_000);
}

test("the host-turn work limit yields fast microtask feedback without depending on the clock", async () => {
	await tick();
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const errors: unknown[] = [];
	const report = spyOn(console, "error").mockImplementation(error => { errors.push(error); });
	const [value, setValue] = signal(0);
	let runs = 0, runsAtTimer = -1;
	let dispose = () => {};
	const timer = new Promise<void>(resolve => setTimeout(() => { runsAtTimer = runs; resolve(); }, 0));
	try {
		dispose = createRoot(stop => {
			liveScope(() => {
				const current = value();
				runs++;
				if (current < 5_000) queueMicrotask(() => setValue(current + 1));
			});
			return stop;
		});
		await timer;
		expect(runsAtTimer).toBeGreaterThan(0);
		expect(runsAtTimer).toBeLessThanOrEqual(2_048);
		await waitFor(() => runs === 5_001 && value() === 5_000, "Fast finite microtask updates failed to finish");
		expect(errors).toEqual([]);
	} finally {
		dispose();
		await timer;
		await tick();
		report.mockRestore();
		clock.mockRestore();
	}
}, 10_000);

test("a spent host-turn budget defers further work but fresh host tasks retain small synchronous updates", async () => {
	await tick();
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const [value, setValue] = signal(0);
	let observed = -1;
	let dispose = () => {};
	try {
		dispose = createRoot(stop => {
			for (let i = 0; i < 2_047; i++) liveScope(() => {});
			liveScope(() => { observed = value(); });
			return stop;
		});
		expect(observed).toBe(0);
		// The previous queue is empty, but its work already spent this turn's
		// allowance. A separate flush must not get a fresh allowance immediately.
		setValue(1);
		expect(observed).toBe(0);
		await waitFor(() => observed === 1, "Deferred work failed to resume in a host task");
		await tick();
		setValue(2);
		expect(observed).toBe(2);
		await tick();
		setValue(3);
		expect(observed).toBe(3);
	} finally {
		dispose();
		await tick();
		clock.mockRestore();
	}
}, 10_000);

test("independent external writes through a memo do not exhaust a suspended settlement's cycle budget", async () => {
	// Use the scheduler's work-count slice rather than machine speed. Separate
	// real timer turns are independent input events, not a synchronous loop.
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const errors: unknown[] = [];
	const report = spyOn(console, "error").mockImplementation(error => { errors.push(error); });
	setDevMode(false);
	const [pulse, setPulse] = signal(0);
	const [input, setInput] = signal(0);
	const [derived, setDerived] = signal(0);
	let fanoutRuns = 0, derivedRuns = 0, observed = -1;
	let dispose = () => {};
	try {
		dispose = createRoot(stop => {
			// More than two slices keep work pending between input events without
			// introducing feedback: every observer only reads the pulse.
			for (let i = 0; i < 5_000; i++) live(() => { pulse(); fanoutRuns++; });
			const throughMemo = memo(() => input());
			live(function healthyExternalDerivation() {
				derivedRuns++;
				setDerived(throughMemo());
			});
			live(() => { observed = derived(); });
			return stop;
		});
		await waitFor(() => fanoutRuns >= 5_000, "Initial read-only fanout did not settle");
		for (let event = 1; event <= 320; event++) {
			batch(() => { setPulse(event); setInput(event); });
			await tick();
		}
		await tick();
		expect(errors).toEqual([]);
		expect(derivedRuns).toBeGreaterThan(100);
		setInput(9_999);
		await waitFor(() => observed === 9_999, "A healthy memo-driven effect stopped responding to external input");
		expect(errors).toEqual([]);
	} finally {
		dispose();
		await tick();
		setDevMode(true);
		report.mockRestore();
		clock.mockRestore();
	}
}, 15_000);

test("a deferred callback failure is reported without stranding healthy work or invoking Bun's fatal reporter", async () => {
	const clock = spyOn(performance, "now").mockReturnValue(0);
	const errors: unknown[] = [];
	const report = spyOn(console, "error").mockImplementation(error => { errors.push(error); });
	const nativeReporter = spyOn(globalThis, "reportError").mockImplementation(() => {});
	const failure = new Error("deferred callback failed");
	const [healthy, setHealthy] = signal(17);
	let setupRuns = 0, observed = -1, cleaned = 0;
	let dispose = () => {};
	try {
		dispose = createRoot(stop => {
			for (let i = 0; i < 2_500; i++) liveScope(() => { setupRuns++; });
			liveScope(() => { cleanup(() => { cleaned++; }); throw failure; });
			liveScope(() => { observed = healthy(); });
			return stop;
		});
		expect(setupRuns).toBeLessThan(2_500);
		expect(errors).toEqual([]);
		await waitFor(() => errors.length === 1 && observed === 17, "Deferred failure stranded an unrelated binding");
		expect(errors).toEqual([failure]);
		expect(nativeReporter).not.toHaveBeenCalled();
		setHealthy(23);
		await waitFor(() => observed === 23, "Unrelated binding stopped after a deferred failure");
		dispose();
		expect(cleaned).toBe(1);
		await tick();
		expect(errors).toEqual([failure]);
	} finally {
		dispose();
		await tick();
		nativeReporter.mockRestore();
		report.mockRestore();
		clock.mockRestore();
	}
}, 10_000);

test("disposing a suspended root cancels its work without borrowing a later root's ownership", async () => {
	const clock = spyOn(performance, "now").mockReturnValue(0);
	let firstRuns = 0, firstCleanups = 0, secondRuns = 0, secondCleanups = 0;
	let disposeFirst = () => {}, disposeSecond = () => {};
	const [value, setValue] = signal(0);
	let secondValue = -1;
	try {
		disposeFirst = createRoot(stop => {
			for (let i = 0; i < 4_000; i++) liveScope(() => {
				firstRuns++;
				cleanup(() => { firstCleanups++; });
			});
			return stop;
		});
		expect(firstRuns).toBeGreaterThan(0);
		expect(firstRuns).toBeLessThan(4_000);
		const stoppedAt = firstRuns;
		// Mount another root while the old continuation exists. Its cleanup and
		// subscriptions belong to this root, not the paused computation.
		disposeSecond = createRoot(stop => {
			cleanup(() => { secondCleanups++; });
			liveScope(() => { secondRuns++; secondValue = value(); });
			return stop;
		});
		disposeFirst();
		await waitFor(() => secondRuns === 1, "A new root was lost with disposed pending work");
		expect(firstRuns).toBe(stoppedAt);
		expect(firstCleanups).toBe(stoppedAt);
		expect(secondCleanups).toBe(0);
		setValue(9);
		await waitFor(() => secondValue === 9, "New root lost its independent subscription");
		disposeSecond();
		await tick();
		expect(firstRuns).toBe(stoppedAt);
		expect(firstCleanups).toBe(stoppedAt);
		expect(secondCleanups).toBe(1);
	} finally {
		disposeFirst(); disposeSecond();
		await tick();
		clock.mockRestore();
	}
}, 10_000);

test("native queued cycles keep the Bun process and unrelated UI work alive before and after yielding", async () => {
	// Do not replace Bun's fatal reporter with a harmless mock here: if the
	// runtime invokes it, this actual child process must fail the regression.
	const source = `
		const { cleanup, createRoot, liveScope, setDevMode, signal } = await import(${JSON.stringify(new URL("./reactive.ts", import.meta.url).href)});
		setDevMode(false);
		Object.defineProperty(performance, "now", { value: () => 0, configurable: true });
		let nativeReports = 0;
		const nativeReporter = globalThis.reportError;
		globalThis.reportError = error => { nativeReports++; nativeReporter(error); };
		const diagnostics = [];
		const previousError = console.error;
		console.error = error => {
			if (error?.code === "WARREN_REACTIVE_CYCLE") diagnostics.push(error.code);
			else previousError(error);
		};
		const tick = () => new Promise(resolve => setTimeout(resolve, 0));
		const [healthy, setHealthy] = signal(0);
		let observed = -1, fastRuns = 0, fastCleanups = 0, yieldedRuns = 0, yieldedCleanups = 0;
		const stopHealthy = createRoot(stop => { liveScope(() => { observed = healthy(); }); return stop; });
		const [fast, setFast] = signal(0);
		const stopFast = createRoot(stop => {
			liveScope(function nativeFastCycle() {
				if (++fastRuns > 500) throw new Error("bounded fast cycle sentinel");
				cleanup(() => { fastCleanups++; });
				setFast(fast() + 1);
			});
			return stop;
		});
		if (diagnostics.length !== 1) throw new Error("The first-slice cycle was not diagnosed");
		const [yielded, setYielded] = signal(0);
		const stopYielded = createRoot(stop => {
			for (let i = 0; i < 2500; i++) liveScope(() => {});
			liveScope(function nativeYieldedCycle() {
				if (++yieldedRuns > 500) throw new Error("bounded yielded cycle sentinel");
				cleanup(() => { yieldedCleanups++; });
				setYielded(yielded() + 1);
			});
			return stop;
		});
		if (diagnostics.length !== 1) throw new Error("Expected the second cycle to remain queued after yielding");
		setHealthy(1);
		const deadline = Date.now() + 5000;
		while (diagnostics.length < 2 || observed !== 1) {
			if (Date.now() >= deadline) throw new Error("The deferred queue did not settle");
			await tick();
		}
		setHealthy(2);
		await tick();
		stopFast(); stopYielded(); stopHealthy();
		await tick();
		console.log(JSON.stringify({ diagnostics: diagnostics.length, nativeReports, observed,
			fastRuns, fastCleanups, yieldedRuns, yieldedCleanups }));
	`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
		env: { ...process.env, HUTCH_RUNTIME: "bun", HUTCH_NO_UPDATE_CHECK: "1" },
	});
	const deadline = setTimeout(() => child.kill(), 10_000);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const result = JSON.parse(stdout.trim());
		expect(result).toMatchObject({ diagnostics: 2, nativeReports: 0, observed: 2 });
		expect(result.fastRuns).toBeGreaterThan(0);
		expect(result.fastRuns).toBeLessThanOrEqual(100);
		expect(result.yieldedRuns).toBeGreaterThan(0);
		expect(result.yieldedRuns).toBeLessThanOrEqual(100);
		expect(result.fastCleanups).toBe(result.fastRuns);
		expect(result.yieldedCleanups).toBe(result.yieldedRuns);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		clearTimeout(deadline);
		await child.exited;
	}
}, 15_000);
