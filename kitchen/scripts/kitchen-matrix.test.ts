import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import {
	createKitchenMatrix,
	KITCHEN_MAIN_PROCESSES,
	kitchenVariantEnvironment,
	kitchenVariantKey,
	readKitchenVariant,
} from "./kitchen-matrix-plan";
import {
	createKitchenMatrixRunRoot,
	kitchenWorkspaceCopyOptions,
	parseKitchenMatrixArguments,
	pipePrefixed,
	prepareKitchenVariantWorkspace,
	publishKitchenVariantWorkspace,
	runKitchenMatrix,
	stopChildProcessTree,
} from "./kitchen-matrix";
import {
	captureKitchenHangDiagnostics,
	captureMacosHostResources,
	runDiagnosticCommand,
	selectMacosHangProcesses,
} from "./kitchen-hang-diagnostics";
import { createFullscreenPhaseWatcher, type FullscreenPhase } from "./kitchen-fullscreen-watch";

function phaseLine(operation: string, phase: "start" | "end", windowId?: number, testId?: string) {
	return `[kitchen window phase] ${JSON.stringify({ operation, phase, windowId, testId })}`;
}

function phaseWatchFixture(enabled = true, capture?: (phase: FullscreenPhase) => Promise<void>, onError?: (error: unknown) => void) {
	let now = 0;
	const timers = new Map<() => void, number>();
	const captures: FullscreenPhase[] = [];
	const errors: unknown[] = [];
	const watcher = createFullscreenPhaseWatcher({
		enabled,
		capture: phase => { captures.push(phase); return capture?.(phase) ?? Promise.resolve(); },
		onError: error => { errors.push(error); onError?.(error); },
		schedule: (callback, delay) => {
			timers.set(callback, now + delay);
			return () => { timers.delete(callback); };
		},
	});
	return {
		...watcher, captures, errors, timers,
		advance(ms: number) {
			now += ms;
			for (const [callback, at] of timers) {
				if (at <= now) { timers.delete(callback); callback(); }
			}
		},
	};
}

function pendingPhaseCapture() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const report = new Promise<void>((complete, fail) => { resolve = complete; reject = fail; });
	return { report, resolve, reject };
}

describe("fullscreen phase diagnostics", () => {
	it("does nothing when disabled or when output is not a valid targeted marker", async () => {
		const disabled = phaseWatchFixture(false);
		disabled.observeLine(phaseLine("fullscreen.setTrue", "start", 29));
		disabled.observeLine(phaseLine("fixture.construct", "start"));
		expect(disabled.timers.size).toBe(0);
		const enabled = phaseWatchFixture();
		for (const line of ["ordinary output", "[kitchen window phase] {", phaseLine("fixture.wait100ms", "start"),
			phaseLine("fullscreen.setTrue", "start", -1),
			'[kitchen window phase] {"operation":"fixture.construct","phase":"start","testId":42}']) enabled.observeLine(line);
		expect(enabled.timers.size).toBe(0);
		await disabled.finish();
		await enabled.finish();
	});

	it("keeps the outer creation timer across nested fixtures and accepts its new window ID", async () => {
		const watcher = phaseWatchFixture();
		watcher.observeLine(phaseLine("fullscreen.createWindow", "start"));
		watcher.advance(2000);
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "fullscreen"));
		watcher.observeLine(phaseLine("fixture.construct", "end", 29));
		watcher.observeLine(phaseLine("fixture.wait100ms", "start", 29));
		expect(watcher.timers.size).toBe(1);
		watcher.observeLine(phaseLine("fullscreen.createWindow", "end", 29));
		watcher.advance(5000);
		expect(watcher.captures).toEqual([]);
		expect(watcher.timers.size).toBe(0);
		await watcher.finish();
	});

	it("captures fullscreen at three seconds and a later constructor at five, with no third capture", async () => {
		const watcher = phaseWatchFixture();
		watcher.observeLine(phaseLine("baseline.getFrame", "start", 29));
		watcher.observeLine(phaseLine("baseline.getFrame", "end", 30));
		watcher.advance(2999);
		expect(watcher.captures).toEqual([]);
		watcher.advance(1);
		expect(watcher.captures).toEqual([{ operation: "baseline.getFrame", windowId: 29, stalledForMs: 3000 }]);
		await Promise.resolve();
		watcher.observeLine(phaseLine("baseline.getFrame", "end", 29));
		watcher.observeLine('[kitchen window phase] {"operation":"fixture.construct","phase":"start","testId":"always-on-top","at":"2026-11-12T17:00:00.000Z","tMs":12345}');
		watcher.observeLine(phaseLine("fixture.construct", "end", 30, "other-test"));
		watcher.advance(4999);
		expect(watcher.captures).toHaveLength(1);
		watcher.advance(1);
		expect(watcher.captures[1]).toEqual({ operation: "fixture.construct", testId: "always-on-top", at: "2026-11-12T17:00:00.000Z", tMs: 12345, stalledForMs: 5000 });
		await Promise.resolve();
		watcher.observeLine(phaseLine("fixture.construct", "end", 30, "always-on-top"));
		watcher.observeLine(phaseLine("fullscreen.exitObservationAndAssert", "start", 29));
		watcher.advance(3000);
		watcher.observeLine(phaseLine("fullscreen.exitObservationAndAssert", "end", 29));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "later"));
		watcher.advance(5000);
		expect(watcher.captures).toHaveLength(2);
		expect(watcher.timers.size).toBe(0);
		await watcher.finish();
	});

	it("does not capture a short constructor or spend its budget", async () => {
		const watcher = phaseWatchFixture();
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "short"));
		watcher.advance(4999);
		watcher.observeLine(phaseLine("fixture.construct", "end", 29, "short"));
		watcher.advance(5000);
		expect(watcher.captures).toEqual([]);
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "slow"));
		watcher.advance(5000);
		expect(watcher.captures).toEqual([{ operation: "fixture.construct", testId: "slow", stalledForMs: 5000 }]);
		await watcher.finish();
	});

	it("tracks a fullscreen parent after its budget is spent so nested fixtures stay excluded", async () => {
		const watcher = phaseWatchFixture();
		watcher.observeLine(phaseLine("fullscreen.setTrue", "start", 29));
		watcher.advance(3000);
		await Promise.resolve();
		watcher.observeLine(phaseLine("fullscreen.setTrue", "end", 29));
		watcher.observeLine(phaseLine("fullscreen.createWindow", "start", undefined, "second-fullscreen"));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "second-fullscreen"));
		watcher.advance(5000);
		watcher.observeLine(phaseLine("fixture.construct", "end", 30, "second-fullscreen"));
		watcher.observeLine(phaseLine("fullscreen.createWindow", "end", 30, "wrong-test"));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "still-nested"));
		watcher.advance(5000);
		expect(watcher.captures).toHaveLength(1);
		expect(watcher.timers.size).toBe(0);
		watcher.observeLine(phaseLine("fullscreen.createWindow", "end", 30, "second-fullscreen"));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "ordinary"));
		watcher.advance(5000);
		expect(watcher.captures[1]).toMatchObject({ operation: "fixture.construct", testId: "ordinary", stalledForMs: 5000 });
		await watcher.finish();
	});

	it("replaces an unfinished phase and cancels timers on launch completion", async () => {
		const watcher = phaseWatchFixture();
		watcher.observeLine(phaseLine("fullscreen.setTrue", "start", 29));
		watcher.advance(2500);
		watcher.observeLine(phaseLine("fullscreen.enterObservationAndAssert", "start", 29));
		watcher.advance(1000);
		expect(watcher.captures).toEqual([]);
		expect(watcher.timers.size).toBe(1);
		await watcher.finish();
		watcher.observeLine(phaseLine("fullscreen.setFalse", "start", 29));
		watcher.advance(3000);
		expect(watcher.captures).toEqual([]);
		expect(watcher.timers.size).toBe(0);
	});

	it("finish drops deferred work while awaiting an in-flight report and contains capture failure", async () => {
		let rejectCapture!: (error: Error) => void;
		const report = new Promise<void>((_, reject) => { rejectCapture = reject; });
		const watcher = phaseWatchFixture(true, () => report);
		watcher.observeLine(phaseLine("fullscreen.exitObservationAndAssert", "start", 29));
		watcher.advance(3000);
		watcher.observeLine(phaseLine("fullscreen.exitObservationAndAssert", "end", 29));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "later"));
		watcher.advance(5000);
		let finished = false;
		const completion = watcher.finish().then(() => { finished = true; });
		await Promise.resolve();
		expect(finished).toBe(false);
		const failure = new Error("sample unavailable");
		rejectCapture(failure);
		await completion;
		expect(finished).toBe(true);
		expect(watcher.errors).toEqual([failure]);
		expect(watcher.captures).toHaveLength(1);
		expect(watcher.timers.size).toBe(0);
	});

	it("serializes a deferred constructor capture behind an active fullscreen report", async () => {
		const first = pendingPhaseCapture();
		const second = pendingPhaseCapture();
		const watcher = phaseWatchFixture(true, phase => phase.operation === "fixture.construct" ? second.report : first.report);
		watcher.observeLine(phaseLine("fullscreen.setTrue", "start", 29));
		watcher.advance(3000);
		watcher.observeLine(phaseLine("fullscreen.setTrue", "end", 29));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "later"));
		watcher.advance(5000);
		expect(watcher.captures).toHaveLength(1);
		first.resolve();
		await Promise.resolve();
		expect(watcher.captures).toHaveLength(2);
		expect(watcher.captures[1]).toMatchObject({ testId: "later", stalledForMs: 5000 });
		second.resolve();
		await watcher.finish();
	});

	it("discards ended or replaced deferred phases without spending the constructor budget", async () => {
		for (const replacement of [false, true]) {
			const first = pendingPhaseCapture();
			const watcher = phaseWatchFixture(true, phase => phase.operation === "fixture.construct" ? Promise.resolve() : first.report);
			watcher.observeLine(phaseLine("fullscreen.setTrue", "start", 29));
			watcher.advance(3000);
			watcher.observeLine(phaseLine("fullscreen.setTrue", "end", 29));
			watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "same-test"));
			watcher.advance(5000);
			if (!replacement) watcher.observeLine(phaseLine("fixture.construct", "end", 30, "same-test"));
			watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "same-test"));
			first.resolve();
			await Promise.resolve();
			expect(watcher.captures).toHaveLength(1);
			watcher.advance(4999);
			expect(watcher.captures).toHaveLength(1);
			watcher.advance(1);
			expect(watcher.captures).toHaveLength(2);
			await watcher.finish();
		}
	});

	it("spends a failed budget and contains even a throwing error handler", async () => {
		const failure = new Error("sample unavailable");
		const watcher = phaseWatchFixture(true, phase => {
			if (phase.operation !== "fixture.construct") throw failure;
			return Promise.resolve();
		}, () => { throw new Error("cannot log"); });
		watcher.observeLine(phaseLine("fullscreen.setTrue", "start", 29));
		watcher.advance(3000);
		watcher.observeLine(phaseLine("fullscreen.setFalse", "start", 29));
		watcher.advance(3000);
		watcher.observeLine(phaseLine("fullscreen.setFalse", "end", 29));
		watcher.observeLine(phaseLine("fixture.construct", "start", undefined, "later"));
		watcher.advance(5000);
		expect(watcher.errors).toEqual([failure]);
		expect(watcher.captures).toHaveLength(2);
		await watcher.finish();
	});

	it("observes split stderr lines without changing their forwarded contents", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let forwarded = "";
		output.on("data", chunk => { forwarded += chunk.toString(); });
		const watcher = phaseWatchFixture();
		pipePrefixed(input, "[bun-native] ", output, watcher.observeLine);
		const start = phaseLine("fullscreen.setTrue", "start", 29);
		input.write(start.slice(0, 12));
		expect(watcher.timers.size).toBe(0);
		input.write(start.slice(12) + "\n");
		expect(watcher.timers.size).toBe(1);
		const end = phaseLine("fullscreen.setTrue", "end", 29);
		const ended = new Promise<void>(resolve => input.once("end", resolve));
		input.end(end);
		await ended;
		expect(watcher.timers.size).toBe(0);
		expect(forwarded).toBe(`[bun-native] ${start}\n[bun-native] ${end}\n`);
		await watcher.finish();
		output.end();
	});
});

function signalOwnedProcess(pid: number, signal: NodeJS.Signals | 0): boolean {
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Invalid fixture PID: ${pid}`);
	try {
		process.kill(pid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function readOwnedProcessState(pid: number): string | null {
	if (!signalOwnedProcess(pid, 0)) return null;
	const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
		encoding: "utf8", timeout: 1000, maxBuffer: 4096,
	});
	if (result.error) throw result.error;
	const state = result.stdout.trim();
	if (result.status === 0 && /^[A-Za-z][A-Za-z+<>-]*$/.test(state)) return state;
	// It can exit between the signal probe and ps. Do not mistake an arbitrary
	// ps failure or EPERM for proof that the descendant is gone.
	if (!signalOwnedProcess(pid, 0)) return null;
	throw new Error(`Cannot inspect fixture PID ${pid}: ps status=${result.status}, stdout=${JSON.stringify(result.stdout)}, stderr=${JSON.stringify(result.stderr)}`);
}

async function waitForNoLiveProcess(pid: number): Promise<string | null> {
	const deadline = Date.now() + 1000;
	for (;;) {
		const state = readOwnedProcessState(pid);
		// An orphan's kernel entry may await PID 1's reap. Only a verified zombie
		// state, never mere signal-0 success, proves it cannot execute more work.
		if (state === null || state.startsWith("Z")) return state;
		if (Date.now() >= deadline) throw new Error(`Fixture descendant ${pid} is still live after group termination: ${state}`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("Kitchen hang diagnostics", () => {
	const completed = {
		exitCode: 0, errorCode: null, signal: null, killed: false, elapsedMs: 1,
		startedAt: "2026-11-12T17:15:02.000Z", finishedAt: "2026-11-12T17:15:02.001Z",
	};
	const listing = [
		"100 1 100 /Users/runner/.hutch/bin/hutch-canary",
		"101 100 100 /tmp/Kitchen.app/Contents/MacOS/launcher",
		"102 101 100 /tmp/Kitchen.app/Contents/MacOS/cottontail",
		"103 102 100 /tmp/Kitchen.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
		"104 1 100 /tmp/Kitchen.app/Contents/MacOS/main",
		"105 1 105 /tmp/Other.app/Contents/MacOS/cottontail",
	].join("\n");

	it("records bounded host probes including a failed probe without collecting arguments or environment", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kitchen-host-diagnostics-test-"));
		const reportPath = join(directory, "host-resources.json");
		const commands: string[] = [];
		try {
			await captureMacosHostResources({ reportPath, platform: "darwin" }, async (file, args, timeout) => {
				commands.push(file);
				expect(timeout).toBe(2000);
				if (file === "/bin/ps") expect(args).toEqual(["-axo", "pid=,ppid=,pgid=,state=,%cpu=,rss=,comm="]);
				if (file === "/bin/df") expect(args).toEqual(["-k", directory]);
				if (file === "/usr/bin/vm_stat") throw new Error("probe unavailable");
				return { ...completed, stdout: file === "/bin/ps" ? "102 101 100 S 2.1 1234 /tmp/Kitchen.app/Contents/MacOS/bun\n" : "probe output", stderr: "", error: null };
			});
			expect(commands).toEqual(["/bin/ps", "/usr/bin/vm_stat", "/usr/sbin/sysctl", "/bin/df"]);
			const report = JSON.parse(readFileSync(reportPath, "utf8"));
			expect(report.commands).toHaveLength(4);
			expect(report.commands[0]).toMatchObject({ ...completed, name: "processes", timeoutMs: 2000 });
			expect(report.commands[0].args).toEqual(["-axo", "pid=,ppid=,pgid=,state=,%cpu=,rss=,comm="]);
			expect(report.commands[1]).toMatchObject({ name: "virtualMemory", error: "Error: probe unavailable" });
			expect(report.commands[2]).toMatchObject({ ...completed, name: "system", timeoutMs: 2000 });
			expect(report.commands[2].args).toEqual(["vm.swapusage", "vm.loadavg", "hw.memsize", "hw.ncpu"]);
			expect(report.commands[3]).toMatchObject({ ...completed, name: "disk", timeoutMs: 2000, args: ["-k", directory] });
			expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not run macOS host probes on other platforms", async () => {
		let calls = 0;
		await captureMacosHostResources({ reportPath: "/unused-host-resources.json", platform: "linux" }, async () => {
			calls++;
			return { ...completed, stdout: "", stderr: "", error: null };
		});
		expect(calls).toBe(0);
	});

	it("finds the app runtime rather than its launcher, CEF helpers, or other apps", () => {
		const result = selectMacosHangProcesses(listing, 100, "cottontail", true);
		expect(result.targets.map((info) => info.pid)).toEqual([102]);
		expect(result.tree.map((info) => info.pid)).toEqual([100, 101, 102, 103, 104]);
		expect(selectMacosHangProcesses(listing, 100, "main", true).targets.map((info) => info.pid)).toEqual([104]);
		expect(selectMacosHangProcesses(listing, 100, "main", false).targets).toEqual([]);
	});

	it("uses sparse sampling and records timestamps with native stack provenance", async () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitchen-diagnostics-test-"));
		const commands: string[] = [];
		try {
			const directory = await captureKitchenHangDiagnostics({
				pid: 100, key: "cottontail-cef", mainProcess: "cottontail", isolatedProcessGroup: true,
				platform: "darwin", temporaryDirectory,
			}, async (file, args, timeout) => {
				commands.push(file);
				if (file === "/bin/ps") {
					expect(args).toEqual(["-g", "100", "-o", "pid=,ppid=,pgid=,comm="]);
					expect(timeout).toBe(2000);
					return { ...completed, stdout: listing, stderr: "", error: null };
				}
				expect(args.slice(0, 6)).toEqual(["102", "1", "10", "-mayDie", "-nodsyms", "-file"]);
				expect(timeout).toBe(8000);
				writeFileSync(args[6]!, "Thread 0: ebui_destroy -> dispatch_sync\n");
				return { ...completed, stdout: "", stderr: "Sampling complete", error: null };
			});
			expect(commands).toEqual(["/bin/ps", "/usr/bin/sample"]);
			expect(readFileSync(join(directory!, "sample-102.txt"), "utf8")).toContain("ebui_destroy");
			const provenance = JSON.parse(readFileSync(join(directory!, "processes.json"), "utf8"));
			expect(provenance.targets).toEqual([102]);
			expect(provenance.exitCode).toBe(0);
			expect(provenance.elapsedMs).toBe(1);
			expect(provenance).toMatchObject({ startedAt: completed.startedAt, finishedAt: completed.finishedAt });
			expect(JSON.stringify(provenance)).not.toContain("Other.app");
			const sample = JSON.parse(readFileSync(join(directory!, "sample-102-command.json"), "utf8"));
			expect(sample).toMatchObject({ ...completed, timeoutMs: 8000 });
			expect(sample.args).toEqual(["102", "1", "10", "-mayDie", "-nodsyms", "-file", join(directory!, "sample-102.txt")]);
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("keeps failed sampler diagnostics without preventing watchdog shutdown", async () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitchen-diagnostics-test-"));
		try {
			const directory = await captureKitchenHangDiagnostics({
				pid: 100, key: "cottontail-cef", mainProcess: "cottontail", isolatedProcessGroup: true,
				platform: "darwin", temporaryDirectory,
			}, async (file) => file === "/bin/ps"
				? { ...completed, stdout: listing, stderr: "", error: null }
				: { ...completed, exitCode: 1, stdout: "", stderr: "Cannot examine process", error: "sample failed" });
			const result = JSON.parse(readFileSync(join(directory!, "sample-102-command.json"), "utf8"));
			expect(result.stderr).toBe("Cannot examine process");
			expect(result.exitCode).toBe(1);
			expect(result.killed).toBe(false);
			expect(result).toMatchObject({ startedAt: completed.startedAt, finishedAt: completed.finishedAt });
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("allows phase symbolication to finish while the host snapshot runs independently", async () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitchen-diagnostics-test-"));
		let finishHostProbe!: () => void;
		const hostProbe = new Promise<void>(resolve => { finishHostProbe = resolve; });
		let sampleStarted!: () => void;
		const sampling = new Promise<void>(resolve => { sampleStarted = resolve; });
		try {
			const capture = captureKitchenHangDiagnostics({
				pid: 100, key: "cottontail-native", mainProcess: "cottontail", isolatedProcessGroup: true,
				platform: "darwin", temporaryDirectory, captureMode: "phase", includeHostResources: true,
			}, async (file, args, timeout) => {
				if (file === "/usr/bin/vm_stat") await hostProbe;
				if (file === "/usr/bin/sample") {
					expect(timeout).toBe(45000);
					sampleStarted();
					return { ...completed, elapsedMs: 12000, stdout: "", stderr: "Sampling complete", error: null };
				}
				expect(timeout).toBe(2000);
				return { ...completed, stdout: args[0] === "-g" ? listing : "probe output", stderr: "", error: null };
			});
			await sampling;
			finishHostProbe();
			const directory = await capture;
			const sample = JSON.parse(readFileSync(join(directory!, "sample-102-command.json"), "utf8"));
			expect(sample).toMatchObject({ timeoutMs: 45000, elapsedMs: 12000, exitCode: 0, killed: false });
			expect(JSON.parse(readFileSync(join(directory!, "host-resources.json"), "utf8")).commands).toHaveLength(4);
		} finally {
			finishHostProbe();
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("keeps owned-process and host evidence when phase sampling is disabled", async () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitchen-diagnostics-test-"));
		const commands: string[] = [];
		try {
			const directory = await captureKitchenHangDiagnostics({
				pid: 100, key: "cottontail-native", mainProcess: "cottontail", isolatedProcessGroup: true,
				platform: "darwin", temporaryDirectory, captureMode: "phase", includeHostResources: true,
				sampleTarget: false,
			}, async (file, args) => {
				commands.push(file);
				return { ...completed, stdout: args[0] === "-g" ? listing : "host probe", stderr: "", error: null };
			});
			expect(commands).toHaveLength(5);
			expect(commands).not.toContain("/usr/bin/sample");
			const provenance = JSON.parse(readFileSync(join(directory!, "processes.json"), "utf8"));
			expect(provenance).toMatchObject({ captureMode: "phase", sampleTarget: false, targets: [102], exitCode: 0 });
			expect(provenance.tree.map((info: { pid: number }) => info.pid)).toEqual([100, 101, 102, 103, 104]);
			expect(JSON.parse(readFileSync(join(directory!, "host-resources.json"), "utf8")).commands).toHaveLength(4);
			expect(existsSync(join(directory!, "sample-102-command.json"))).toBe(false);
			expect(existsSync(join(directory!, "sample-error.txt"))).toBe(false);
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("does not sample unrelated processes if process discovery fails", async () => {
		const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitchen-diagnostics-test-"));
		try {
			let calls = 0;
			const directory = await captureKitchenHangDiagnostics({
				pid: 100, key: "bun-cef", mainProcess: "bun", isolatedProcessGroup: true,
				platform: "darwin", temporaryDirectory,
			}, async () => {
				calls++;
				return { ...completed, exitCode: null, signal: "SIGKILL", killed: true, elapsedMs: 2001, stdout: "", stderr: "", error: "failed" };
			});
			expect(calls).toBe(1);
			expect(readFileSync(join(directory!, "sample-error.txt"), "utf8")).toContain("No live application runtime");
			const result = JSON.parse(readFileSync(join(directory!, "processes.json"), "utf8"));
			expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", killed: true, elapsedMs: 2001, timeoutMs: 2000 });
		} finally {
			rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("bounds a diagnostic command that never exits", async () => {
		const startedAt = Date.now();
		const result = await runDiagnosticCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100);
		expect(result.error).not.toBeNull();
		expect(result.killed).toBe(true);
		if (process.platform !== "win32") expect(result.signal).toBe("SIGKILL");
		expect(result.elapsedMs).toBeGreaterThanOrEqual(90);
		expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
		expect(new Date(result.finishedAt).toISOString()).toBe(result.finishedAt);
		expect(Date.parse(result.startedAt)).toBeGreaterThanOrEqual(startedAt);
		expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
		expect(Date.parse(result.finishedAt)).toBeLessThanOrEqual(Date.now());
		expect(Date.now() - startedAt).toBeLessThan(3000);
	});

	it("distinguishes an ordinary command failure from watchdog termination", async () => {
		const startedAt = Date.now();
		const result = await runDiagnosticCommand(process.execPath, ["-e", "process.exit(7)"], 2000);
		expect(result).toMatchObject({ exitCode: 7, signal: null, killed: false, errorCode: null });
		expect(result.error).not.toBeNull();
		expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
		expect(new Date(result.finishedAt).toISOString()).toBe(result.finishedAt);
		expect(Date.parse(result.startedAt)).toBeGreaterThanOrEqual(startedAt);
		expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
		expect(Date.parse(result.finishedAt)).toBeLessThanOrEqual(Date.now());
	});

	it.skipIf(process.platform !== "darwin")("discovers an actual detached app group without inspecting unrelated processes", async () => {
		const leader = spawn(process.execPath, ["-e", `
			const { spawn } = require("node:child_process");
			const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000)']);
			child.stdout.once("data", () => console.log(child.pid));
			setInterval(() => {}, 1000);
		`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
		const exited = new Promise<void>(resolve => leader.once("exit", () => resolve()));
		let readinessTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			const childPid = await new Promise<number>((resolve, reject) => {
				readinessTimer = setTimeout(() => reject(new Error("Owned group fixture did not start")), 5000);
				leader.once("error", reject);
				let output = "";
				leader.stdout!.on("data", chunk => {
					output += chunk.toString();
					if (/^\d+\n$/.test(output)) resolve(Number(output.trim()));
				});
			});
			const args = ["-g", String(leader.pid), "-o", "pid=,ppid=,pgid=,comm="];
			const result = await runDiagnosticCommand("/bin/ps", args, 2000);
			expect(result).toMatchObject({ exitCode: 0, signal: null, killed: false, error: null });
			const selected = selectMacosHangProcesses(result.stdout, leader.pid!, basename(process.execPath), true);
			expect(selected.targets.map(info => info.pid)).toEqual([childPid]);
			expect(selected.tree.every(info => info.group === leader.pid)).toBe(true);
		} finally {
			clearTimeout(readinessTimer);
			if (leader.pid) {
				try { process.kill(-leader.pid, "SIGKILL"); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			await exited;
		}
	}, 10000);
});

describe("kitchen matrix", () => {
	it("avoids Cottontail's rounded-inode copy fallback on Windows", () => {
		expect(kitchenWorkspaceCopyOptions("win32")).toEqual({ recursive: true });
		expect(kitchenWorkspaceCopyOptions("darwin")).toEqual({
			recursive: true,
			dereference: true,
		});
		expect(kitchenWorkspaceCopyOptions("linux")).toEqual({
			recursive: true,
			dereference: true,
		});
	});

	it("owns the native project build graphs used by Hutch", () => {
		const kitchenRoot = join(import.meta.dirname, "..");
		const build = readFileSync(
			join(kitchenRoot, "build.zig"),
			"utf8",
		);
		for (const contract of [
			'"electrobun-sdk"',
			'b.path("src/zig/main.zig")',
			'.name = "main"',
			"installArtifact",
		]) {
			expect(build).toContain(contract);
		}

		const cargo = readFileSync(join(kitchenRoot, "Cargo.toml"), "utf8");
		for (const contract of [
			'name = "main"',
			'path = "src/rust/main.rs"',
			'electrobun = { path = ".hutch/devkit/rust-sdk" }',
		]) {
			expect(cargo).toContain(contract);
		}
		const cargoLock = readFileSync(join(kitchenRoot, "Cargo.lock"), "utf8");
		expect(cargoLock).toContain('name = "electrobun-kitchen"');
		expect(cargoLock).toContain('name = "electrobun"');

		const goModule = readFileSync(join(kitchenRoot, "go.mod"), "utf8");
		expect(goModule).toContain("require electrobun v0.0.0");
		expect(goModule).toContain(
			"replace electrobun => ./.hutch/devkit/go-sdk",
		);

		const config = readFileSync(
			join(kitchenRoot, "electrobun.config.ts"),
			"utf8",
		);
		expect(config).toContain('manifest: "Cargo.toml"');
		expect(config).toContain('binary: "main"');
		expect(config).toContain('package: "./src/go"');
		expect(config).not.toContain('entrypoint: "src/rust/main.rs"');
		expect(config).not.toContain('entrypoint: "src/go/main.go"');

		const rustSource = readFileSync(
			join(kitchenRoot, "src", "rust", "main.rs"),
			"utf8",
		);
		expect(rustSource).toStartWith("use electrobun::{");
	});

	it("uses the reduced seven-variant interactive matrix by default", () => {
		const matrix = createKitchenMatrix(false, undefined, "win32", "x64");
		expect(matrix).toHaveLength(7);
		expect(new Set(matrix.map(kitchenVariantKey)).size).toBe(7);
		for (const mainProcess of KITCHEN_MAIN_PROCESSES) {
			expect(matrix).toContainEqual({ mainProcess, renderer: "native" });
		}
		expect(matrix.filter((variant) => variant.renderer === "cef")).toEqual([
			{ mainProcess: "bun", renderer: "cef" },
		]);
	});

	it("can expand to the complete twelve-variant matrix", () => {
		const matrix = createKitchenMatrix(true, undefined, "win32", "x64");
		expect(matrix).toHaveLength(12);
		expect(new Set(matrix.map(kitchenVariantKey)).size).toBe(12);
		for (const mainProcess of KITCHEN_MAIN_PROCESSES) {
			expect(matrix).toContainEqual({ mainProcess, renderer: "native" });
			expect(matrix).toContainEqual({ mainProcess, renderer: "cef" });
		}
	});

	it("selects explicit main-process and webview combinations", () => {
		expect(
			createKitchenMatrix(false, [
				{ mainProcess: "go", renderer: "native" },
				{ mainProcess: "rust", renderer: "cef" },
			]),
		).toEqual([
			{ mainProcess: "go", renderer: "native" },
			{ mainProcess: "rust", renderer: "cef" },
		]);
	});

	it("covers both renderers for every supported Windows ARM64 backend", () => {
		const matrix = createKitchenMatrix(true, undefined, "win32", "arm64");
		expect(matrix).toHaveLength(10);
		expect(matrix.some(({ mainProcess }) => mainProcess === "odin")).toBe(false);
		for (const mainProcess of ["cottontail", "bun", "zig", "rust", "go"]) {
			for (const renderer of ["native", "cef"]) {
				expect(matrix).toContainEqual({ mainProcess, renderer });
			}
		}
		expect(() => createKitchenMatrix(false, [{ mainProcess: "odin", renderer: "native" }], "win32", "arm64")).toThrow("unsupported on win32-arm64");
	});

	it("requires a complete and valid environment override", () => {
		expect(readKitchenVariant({})).toBeNull();
		expect(
			readKitchenVariant({
				ELECTROBUN_KITCHEN_MAIN_PROCESS: "bun",
				ELECTROBUN_KITCHEN_RENDERER: "cef",
			}),
		).toEqual({ mainProcess: "bun", renderer: "cef" });
		expect(() =>
			readKitchenVariant({ ELECTROBUN_KITCHEN_MAIN_PROCESS: "zig" }),
		).toThrow("must be set together");
		expect(() =>
			readKitchenVariant({
				ELECTROBUN_KITCHEN_MAIN_PROCESS: "node",
				ELECTROBUN_KITCHEN_RENDERER: "native",
			}),
		).toThrow("Unsupported kitchen main process");
		expect(
			kitchenVariantEnvironment(
				{ HUTCH_ELECTROBUN_DEVKIT_ROOT: "/local/devkit" },
				{ mainProcess: "go", renderer: "native" },
			),
		).toMatchObject({
			HUTCH_ELECTROBUN_DEVKIT_ROOT: "/local/devkit",
			ELECTROBUN_KITCHEN_MAIN_PROCESS: "go",
			ELECTROBUN_KITCHEN_RENDERER: "native",
		});
	});

	it("parses repeatable workflow modes and job limits", () => {
		expect(parseKitchenMatrixArguments([], 3)).toMatchObject({ jobs: 3 });
		expect(
			parseKitchenMatrixArguments(["--full", "--build-only", "--jobs=8"], 3),
		).toMatchObject({ full: true, buildOnly: true, jobs: 8 });
		expect(() =>
			parseKitchenMatrixArguments(["--build-only", "--launch-only"], 3),
		).toThrow("cannot be used together");
	});

	it("parses a launch timeout for unattended runs", () => {
		expect(parseKitchenMatrixArguments([], 3)).toMatchObject({
			launchTimeoutSeconds: null,
		});
		expect(
			parseKitchenMatrixArguments(["--timeout=900", "--launch-only"], 3),
		).toMatchObject({ launchTimeoutSeconds: 900, launchOnly: true });
		expect(parseKitchenMatrixArguments(["--timeout", "30"], 3)).toMatchObject({
			launchTimeoutSeconds: 30,
		});
		for (const value of ["0", "-1", "abc", "1.5"]) {
			expect(() =>
				parseKitchenMatrixArguments([`--timeout=${value}`], 3),
			).toThrow("--timeout must be a positive number of seconds");
		}
	});

	it.skipIf(process.platform === "win32")(
		"fails and reaps a launched variant that never exits",
		async () => {
			// Models a deadlocked app: the launcher never exits and owns a
			// descendant process that must not outlive the matrix run.
			const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-kitchen-hang-"));
			const grandchildPidFile = join(fixtureRoot, "grandchild.pid");
			const fakeHutch = join(fixtureRoot, "hutch");
			writeFileSync(
				fakeHutch,
				// Reap our child after the group signal instead of racing PID 1's
				// orphan reaping. The trap does not kill it: group termination must.
				`#!/bin/sh\ntrap 'wait; exit' TERM\nsleep 1000 &\necho $! > ${shellQuote(grandchildPidFile)}\nwait\n`,
			);
			chmodSync(fakeHutch, 0o755);
			const previousHutch = process.env["HUTCH_BINARY"];
			process.env["HUTCH_BINARY"] = fakeHutch;
			try {
				const startedAt = Date.now();
				await expect(
					runKitchenMatrix(["--launch-only", "--with=zig:cef", "--timeout=1"]),
				).rejects.toThrow("zig-cef: Hutch run timed out after 1s");
				expect(Date.now() - startedAt).toBeLessThan(5000);
				const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
				expect(() => process.kill(grandchildPid, 0)).toThrow();
			} finally {
				if (previousHutch === undefined) delete process.env["HUTCH_BINARY"];
				else process.env["HUTCH_BINARY"] = previousHutch;
				try {
					if (existsSync(grandchildPidFile)) {
						const pid = Number(readFileSync(grandchildPidFile, "utf8"));
						signalOwnedProcess(pid, "SIGKILL");
						await waitForNoLiveProcess(pid);
					}
				} finally {
					rmSync(fixtureRoot, { recursive: true, force: true });
				}
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"kills a TERM-resistant descendant after its launcher closes all pipes",
		async () => {
			const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-kitchen-orphan-"));
			const grandchildPidFile = join(fixtureRoot, "grandchild.pid");
			const heartbeatFile = join(fixtureRoot, "heartbeat");
			const descendant = join(fixtureRoot, "descendant.mjs");
			const fakeHutch = join(fixtureRoot, "hutch");
			writeFileSync(descendant, [
				"import { appendFileSync, writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));`,
				`writeFileSync(${JSON.stringify(heartbeatFile)}, 'started\\n');`,
				`setInterval(() => appendFileSync(${JSON.stringify(heartbeatFile)}, 'beat\\n'), 25);`,
			].join("\n"));
			writeFileSync(fakeHutch, `#!/bin/sh\n${shellQuote(process.execPath)} ${shellQuote(descendant)} </dev/null >/dev/null 2>&1 &\nwait\n`, { mode: 0o755 });
			const previousHutch = process.env["HUTCH_BINARY"];
			process.env["HUTCH_BINARY"] = fakeHutch;
			try {
				await expect(
					runKitchenMatrix(["--launch-only", "--with=zig:cef", "--timeout=1"]),
				).rejects.toThrow("zig-cef: Hutch run timed out after 1s");
				// The PID is written after installing the TERM handler. A slow or
				// failed fixture startup must fail, not silently pass this check.
				const pid = Number(readFileSync(grandchildPidFile, "utf8"));
				await waitForNoLiveProcess(pid);
				const stoppedHeartbeat = readFileSync(heartbeatFile, "utf8");
				expect(stoppedHeartbeat).toContain("beat\n");
				await new Promise(resolve => setTimeout(resolve, 100));
				expect(readFileSync(heartbeatFile, "utf8")).toBe(stoppedHeartbeat);
			} finally {
				if (previousHutch === undefined) delete process.env["HUTCH_BINARY"];
				else process.env["HUTCH_BINARY"] = previousHutch;
				try {
					if (existsSync(grandchildPidFile)) {
						const pid = Number(readFileSync(grandchildPidFile, "utf8"));
						signalOwnedProcess(pid, "SIGKILL");
						await waitForNoLiveProcess(pid);
					}
				} finally {
					rmSync(fixtureRoot, { recursive: true, force: true });
				}
			}
		},
	);

	it("parses an exact comma-separated variant list", () => {
		expect(
			parseKitchenMatrixArguments(
				["--with=go:system,rust:cef,go:cef", "--launch-only"],
				3,
			),
		).toMatchObject({
			selectedVariants: [
				{ mainProcess: "go", renderer: "native" },
				{ mainProcess: "rust", renderer: "cef" },
				{ mainProcess: "go", renderer: "cef" },
			],
			launchOnly: true,
		});
		expect(() => parseKitchenMatrixArguments(["--with=node:system"], 3)).toThrow(
			"unsupported main process",
		);
		expect(() => parseKitchenMatrixArguments(["--with=go:webkit"], 3)).toThrow(
			"unsupported webview",
		);
		expect(() =>
			parseKitchenMatrixArguments(["--full", "--with=go:system"], 3),
		).toThrow("cannot be used together");
	});

	it("terminates the isolated POSIX variant process group", () => {
		const directSignals: Array<NodeJS.Signals | number | undefined> = [];
		const groupSignals: Array<{
			pid: number;
			signal: NodeJS.Signals | number | undefined;
		}> = [];
		const child: Parameters<typeof stopChildProcessTree>[0] = {
			pid: 4321,
			exitCode: null,
			signalCode: null,
			kill: (signal) => {
				directSignals.push(signal);
				return true;
			},
		};
		const killProcess = ((
			pid: number,
			signal?: NodeJS.Signals | number,
		) => {
			groupSignals.push({ pid, signal });
			return true;
		}) as typeof process.kill;

		stopChildProcessTree(child, true, "SIGTERM", "linux", killProcess);

		expect(groupSignals).toEqual([{ pid: -4321, signal: "SIGTERM" }]);
		expect(directSignals).toEqual([]);
	});

	it("terminates a foreground variant directly", () => {
		const directSignals: Array<NodeJS.Signals | number | undefined> = [];
		const child: Parameters<typeof stopChildProcessTree>[0] = {
			pid: 4321,
			exitCode: null,
			signalCode: null,
			kill: (signal) => {
				directSignals.push(signal);
				return true;
			},
		};

		stopChildProcessTree(child, false, "SIGTERM", "linux");

		expect(directSignals).toEqual(["SIGTERM"]);
	});

	it("isolates and publishes staging output for every native runtime variant", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-kitchen-matrix-"));
		const kitchenRoot = join(fixtureRoot, "kitchen");
		const variants = (["zig", "rust", "go", "odin"] as const).map(
			(mainProcess) => ({ mainProcess, renderer: "native" as const }),
		);

		try {
			mkdirSync(join(kitchenRoot, "src"), { recursive: true });
			writeFileSync(join(kitchenRoot, "src", "shared.ts"), "export {};\n");
			writeFileSync(join(kitchenRoot, "electrobun.config.ts"), "export default {};\n");
			for (const projectFile of ["build.zig", "Cargo.toml", "Cargo.lock", "go.mod"]) {
				writeFileSync(join(kitchenRoot, projectFile), `${projectFile}\n`);
			}
			mkdirSync(join(kitchenRoot, ".hutch", "devkit"), { recursive: true });
			writeFileSync(join(kitchenRoot, ".hutch", "devkit", "stale"), "stale\n");
			mkdirSync(join(kitchenRoot, "build", "matrix", "rust-native"), {
				recursive: true,
			});
			writeFileSync(
				join(kitchenRoot, "build", "matrix", "rust-native", "stale.txt"),
				"stale",
			);

			const runRoot = createKitchenMatrixRunRoot(kitchenRoot);
			const workspaces = variants.map((variant) =>
				prepareKitchenVariantWorkspace(kitchenRoot, runRoot, variant),
			);
			expect(new Set(workspaces.map((workspace) => workspace.root)).size).toBe(4);
			for (const workspace of workspaces) {
				for (const projectFile of [
					"build.zig",
					"Cargo.toml",
					"Cargo.lock",
					"go.mod",
				]) {
					expect(existsSync(join(workspace.root, projectFile))).toBe(true);
				}
				expect(existsSync(join(workspace.root, ".hutch"))).toBe(false);
			}
			writeFileSync(join(workspaces[0]!.root, "src", "shared.ts"), "zig only\n");
			expect(readFileSync(join(kitchenRoot, "src", "shared.ts"), "utf8")).toBe(
				"export {};\n",
			);

			for (const [index, workspace] of workspaces.entries()) {
				const key = kitchenVariantKey(variants[index]!);
				const scratchFile = join(
					workspace.root,
					".cottontail-tmp",
					"electrobun",
					"cottontail-build-spec.json",
				);
				const bundledView = join(
					workspace.buildOutput,
					"dev-test-arch",
					"app",
					"views",
					"test-runner",
					"index.js",
				);
				mkdirSync(dirname(scratchFile), { recursive: true });
				mkdirSync(dirname(bundledView), { recursive: true });
				writeFileSync(scratchFile, key);
				writeFileSync(bundledView, key);
			}

			for (const [index, workspace] of workspaces.entries()) {
				const key = kitchenVariantKey(variants[index]!);
				expect(
					readFileSync(
						join(
							workspace.root,
							".cottontail-tmp",
							"electrobun",
							"cottontail-build-spec.json",
						),
						"utf8",
					),
				).toBe(key);
				publishKitchenVariantWorkspace(workspace);
			}

			for (const variant of variants) {
				const key = kitchenVariantKey(variant);
				const bundledView = join(
					kitchenRoot,
					"build",
					"matrix",
					key,
					"dev-test-arch",
					"app",
					"views",
					"test-runner",
					"index.js",
				);
				expect(readFileSync(bundledView, "utf8")).toBe(key);
			}
			expect(
				existsSync(join(kitchenRoot, "build", "matrix", "rust-native", "stale.txt")),
			).toBe(false);
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
