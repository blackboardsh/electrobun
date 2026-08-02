#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const defaults = {
	warmupSeconds: 5,
	sampleSeconds: 20,
	pollMilliseconds: 250,
	hostMaximumPercent: 10,
	treeMaximumPercent: 20,
	shutdownSeconds: 10,
	hostName: undefined,
};

const help = `Electrobun Linux CEF idle CPU benchmark

Usage:
  node scripts/test-linux-cef-idle.js [options] -- /path/to/app [app args...]
  node scripts/test-linux-cef-idle.js --pid <pid> [options]
  node scripts/test-linux-cef-idle.js --self-test

The benchmark warms up the app, then samples utime + stime from /proc for the
root process and its complete process tree. Percentages are relative to one CPU
core: 100% means one fully occupied core, independent of the machine's core
count. The default ceilings are <10% for the host/root process and <20% for the
whole tree. --host-name matches the exact Linux /proc comm name after warm-up
and fails unless exactly one process in the tree has that name.

Options:
  --pid <pid>                  Attach to an existing process (never terminates it)
  --warmup-seconds <number>    Warm-up duration (default: 5)
  --sample-seconds <number>    Measurement duration (default: 20)
  --poll-ms <number>           /proc sampling interval (default: 250)
  --host-name <comm>           Measure this unique process instead of the root
  --host-max-percent <number>  Selected-host ceiling (default: 10)
  --tree-max-percent <number>  Process-tree ceiling (default: 20)
  --shutdown-seconds <number>  Graceful shutdown deadline (default: 10)
  --self-test                  Test parsing and CPU calculations without an app
  --help                       Show this help

Launch mode uses spawn() directly, never a shell. Put the executable and each
argument after --. On completion the launched root receives SIGTERM; the test
fails if its observed descendants linger beyond the shutdown deadline.

Examples:
  node scripts/test-linux-cef-idle.js -- ./build/blank-cef-app
  node scripts/test-linux-cef-idle.js --host-name cottontail -- ./app-launcher
  node scripts/test-linux-cef-idle.js --pid 12345 --sample-seconds 30
`;

function parseFiniteNumber(flag, value, { allowZero }) {
	if (value === undefined) throw new Error(`${flag} requires a value`);
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
		throw new Error(
			`${flag} must be a ${allowZero ? "non-negative" : "positive"} number`,
		);
	}
	return parsed;
}

function parseArguments(argv) {
	const options = { ...defaults, command: [], pid: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--") {
			options.command = argv.slice(index + 1);
			break;
		}
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument === "--self-test") {
			options.selfTest = true;
			continue;
		}

		const value = argv[index + 1];
		switch (argument) {
			case "--pid": {
				const pid = parseFiniteNumber(argument, value, { allowZero: false });
				if (!Number.isSafeInteger(pid)) {
					throw new Error("--pid must be a positive integer");
				}
				options.pid = pid;
				index += 1;
				break;
			}
			case "--warmup-seconds":
				options.warmupSeconds = parseFiniteNumber(argument, value, {
					allowZero: true,
				});
				index += 1;
				break;
			case "--sample-seconds":
				options.sampleSeconds = parseFiniteNumber(argument, value, {
					allowZero: false,
				});
				index += 1;
				break;
			case "--poll-ms":
				options.pollMilliseconds = parseFiniteNumber(argument, value, {
					allowZero: false,
				});
				index += 1;
				break;
			case "--host-name":
				if (value === undefined || value.length === 0 || value === "--") {
					throw new Error("--host-name requires a non-empty /proc comm name");
				}
				options.hostName = value;
				index += 1;
				break;
			case "--host-max-percent":
				options.hostMaximumPercent = parseFiniteNumber(argument, value, {
					allowZero: false,
				});
				index += 1;
				break;
			case "--tree-max-percent":
				options.treeMaximumPercent = parseFiniteNumber(argument, value, {
					allowZero: false,
				});
				index += 1;
				break;
			case "--shutdown-seconds":
				options.shutdownSeconds = parseFiniteNumber(argument, value, {
					allowZero: false,
				});
				index += 1;
				break;
			default:
				throw new Error(
					`Unknown argument: ${argument}. App arguments must follow --.`,
				);
		}
	}

	if (!options.help && !options.selfTest) {
		if (options.pid !== undefined && options.command.length > 0) {
			throw new Error("Choose either --pid or a command after --, not both");
		}
		if (options.pid === undefined && options.command.length === 0) {
			throw new Error("Provide --pid <pid> or an executable after --");
		}
	}
	return options;
}

function parseProcStat(line) {
	const openingParenthesis = line.indexOf("(");
	const closingParenthesis = line.lastIndexOf(")");
	if (openingParenthesis <= 0 || closingParenthesis <= openingParenthesis) {
		throw new Error("Malformed /proc stat record");
	}

	const pid = Number(line.slice(0, openingParenthesis).trim());
	const fields = line.slice(closingParenthesis + 1).trim().split(/\s+/);
	if (!Number.isSafeInteger(pid) || fields.length < 20) {
		throw new Error("Incomplete /proc stat record");
	}

	try {
		const userTicks = BigInt(fields[11]);
		const systemTicks = BigInt(fields[12]);
		const startTicks = BigInt(fields[19]);
		return {
			pid,
			name: line.slice(openingParenthesis + 1, closingParenthesis),
			state: fields[0],
			parentPid: Number(fields[1]),
			startTicks,
			cpuTicks: userTicks + systemTicks,
			identity: `${pid}:${startTicks}`,
		};
	} catch {
		throw new Error("Invalid numeric field in /proc stat record");
	}
}

function readProcessStat(pid) {
	try {
		return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes(error?.code)) return undefined;
		throw error;
	}
}

function readChildPids(pid) {
	try {
		const contents = readFileSync(
			`/proc/${pid}/task/${pid}/children`,
			"utf8",
		).trim();
		if (contents === "") return [];
		return contents
			.split(/\s+/)
			.map(Number)
			.filter(Number.isSafeInteger);
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes(error?.code)) return [];
		throw error;
	}
}

function isRunning(stat) {
	return stat !== undefined && !["X", "Z"].includes(stat.state);
}

function collectProcessTree(rootPid, rootIdentity, knownProcesses) {
	const processes = new Map();
	const queuedPids = new Set();
	const queue = [{ pid: rootPid, expectedIdentity: rootIdentity }];

	for (const [identity, pid] of knownProcesses) {
		queue.push({ pid, expectedIdentity: identity });
	}

	for (let index = 0; index < queue.length; index += 1) {
		const entry = queue[index];
		if (queuedPids.has(entry.pid)) continue;
		queuedPids.add(entry.pid);

		const stat = readProcessStat(entry.pid);
		if (
			stat === undefined ||
			(entry.expectedIdentity !== undefined &&
				stat.identity !== entry.expectedIdentity)
		) {
			continue;
		}
		processes.set(stat.identity, stat);

		for (const childPid of readChildPids(stat.pid)) {
			queue.push({ pid: childPid, expectedIdentity: undefined });
		}
	}

	return processes;
}

function cpuPercent(cpuTicks, clockTicksPerSecond, elapsedSeconds) {
	return (
		(Number(cpuTicks) / clockTicksPerSecond / elapsedSeconds) * 100
	);
}

function selectHostProcess(processes, rootIdentity, hostName) {
	if (hostName === undefined) {
		const root = processes.get(rootIdentity);
		if (!isRunning(root)) throw new Error("The root process is not running");
		return root;
	}

	const matches = [...processes.values()].filter(
		(stat) => isRunning(stat) && stat.name === hostName,
	);
	if (matches.length !== 1) {
		throw new Error(
			`--host-name ${JSON.stringify(hostName)} matched ${matches.length} ` +
				"processes after warm-up; exactly one is required",
		);
	}
	return matches[0];
}

function clockTicksPerSecond() {
	const result = spawnSync("getconf", ["CLK_TCK"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) throw result.error;
	const value = Number(result.stdout.trim());
	if (result.status !== 0 || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error("Could not determine CLK_TCK with getconf");
	}
	return value;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let interruptedSignal;

function throwIfInterrupted() {
	if (interruptedSignal !== undefined) {
		throw new Error(`Benchmark interrupted by ${interruptedSignal}`);
	}
}

async function warmUp(
	rootPid,
	rootIdentity,
	seconds,
	pollMilliseconds,
	knownProcesses,
) {
	const deadline = performance.now() + seconds * 1000;
	while (performance.now() < deadline) {
		throwIfInterrupted();
		const current = collectProcessTree(
			rootPid,
			rootIdentity,
			knownProcesses,
		);
		const stat = current.get(rootIdentity);
		if (!isRunning(stat) || stat.identity !== rootIdentity) {
			throw new Error("The benchmark process exited during warm-up");
		}
		for (const processStat of current.values()) {
			knownProcesses.set(processStat.identity, processStat.pid);
		}
		await delay(Math.min(pollMilliseconds, deadline - performance.now()));
	}
}

async function sampleCpu(
	rootPid,
	rootIdentity,
	options,
	ticksPerSecond,
	knownProcesses,
) {
	const lastTicks = new Map();
	const initial = collectProcessTree(rootPid, rootIdentity, knownProcesses);
	const initialRoot = initial.get(rootIdentity);
	if (!isRunning(initialRoot)) {
		throw new Error("The benchmark process exited before sampling began");
	}
	for (const stat of initial.values()) {
		knownProcesses.set(stat.identity, stat.pid);
		lastTicks.set(stat.identity, stat.cpuTicks);
	}
	const selectedHost = selectHostProcess(
		initial,
		rootIdentity,
		options.hostName,
	);
	const hostIdentity = selectedHost.identity;

	let hostTicks = 0n;
	let treeTicks = 0n;
	const start = performance.now();
	const deadline = start + options.sampleSeconds * 1000;

	while (performance.now() < deadline) {
		throwIfInterrupted();
		await delay(
			Math.min(options.pollMilliseconds, deadline - performance.now()),
		);
		throwIfInterrupted();
		const current = collectProcessTree(
			rootPid,
			rootIdentity,
			knownProcesses,
		);
		const root = current.get(rootIdentity);
		if (!isRunning(root)) {
			throw new Error("The benchmark process exited during CPU sampling");
		}
		const currentHost = current.get(hostIdentity);
		if (!isRunning(currentHost)) {
			throw new Error(
				`Selected host process ${selectedHost.pid} (${selectedHost.name}) ` +
					"exited during CPU sampling",
			);
		}
		if (
			options.hostName !== undefined &&
			[...current.values()].some(
				(stat) =>
					isRunning(stat) &&
					stat.name === options.hostName &&
					stat.identity !== hostIdentity,
			)
		) {
			throw new Error(
				`--host-name ${JSON.stringify(options.hostName)} became ambiguous ` +
					"during CPU sampling",
			);
		}

		for (const stat of current.values()) {
			const priorTicks = lastTicks.get(stat.identity);
			// A child created during the sample is new to the tree, so all of the
			// CPU time it has accumulated since birth belongs to this interval.
			const delta =
				priorTicks === undefined
					? stat.cpuTicks
					: stat.cpuTicks >= priorTicks
						? stat.cpuTicks - priorTicks
						: 0n;
			treeTicks += delta;
			if (stat.identity === hostIdentity) hostTicks += delta;
			lastTicks.set(stat.identity, stat.cpuTicks);
			knownProcesses.set(stat.identity, stat.pid);
		}
	}

	const elapsedSeconds = (performance.now() - start) / 1000;
	return {
		hostPercent: cpuPercent(hostTicks, ticksPerSecond, elapsedSeconds),
		treePercent: cpuPercent(treeTicks, ticksPerSecond, elapsedSeconds),
		elapsedSeconds,
		observedProcessCount: knownProcesses.size,
		hostPid: selectedHost.pid,
		hostName: selectedHost.name,
		knownProcesses,
	};
}

function liveKnownProcesses(knownProcesses) {
	const live = [];
	for (const [identity, pid] of knownProcesses) {
		const stat = readProcessStat(pid);
		if (isRunning(stat) && stat.identity === identity) live.push(stat);
	}
	return live;
}

function signalIfSameProcess(pid, identity, signal) {
	const stat = readProcessStat(pid);
	if (!isRunning(stat) || stat.identity !== identity) return;
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

async function terminateLaunchedProcess(
	rootPid,
	rootIdentity,
	knownProcesses,
	shutdownSeconds,
) {
	for (const stat of collectProcessTree(
		rootPid,
		rootIdentity,
		knownProcesses,
	).values()) {
		knownProcesses.set(stat.identity, stat.pid);
	}
	signalIfSameProcess(rootPid, rootIdentity, "SIGTERM");

	const deadline = performance.now() + shutdownSeconds * 1000;
	let live = liveKnownProcesses(knownProcesses);
	while (live.length > 0 && performance.now() < deadline) {
		for (const stat of collectProcessTree(
			rootPid,
			rootIdentity,
			knownProcesses,
		).values()) {
			knownProcesses.set(stat.identity, stat.pid);
		}
		await delay(Math.min(100, deadline - performance.now()));
		live = liveKnownProcesses(knownProcesses);
	}

	if (live.length === 0) return;
	const lingering = live.map((stat) => `${stat.pid} (${stat.name})`).join(", ");
	for (const stat of live) {
		signalIfSameProcess(stat.pid, stat.identity, "SIGKILL");
	}
	await delay(100);
	throw new Error(
		`Launched process tree did not exit within ${shutdownSeconds}s; ` +
			`force-terminated: ${lingering}`,
	);
}

function runSelfTest() {
	const fields = Array(20).fill("0");
	fields[0] = "S";
	fields[1] = "42";
	fields[11] = "30";
	fields[12] = "12";
	fields[19] = "777";
	const stat = parseProcStat(`123 (cef helper (gpu)) ${fields.join(" ")}`);
	assert.equal(stat.pid, 123);
	assert.equal(stat.name, "cef helper (gpu)");
	assert.equal(stat.parentPid, 42);
	assert.equal(stat.cpuTicks, 42n);
	assert.equal(stat.identity, "123:777");
	assert.equal(cpuPercent(50n, 100, 2), 25);

	const parsed = parseArguments([
		"--warmup-seconds",
		"0",
		"--sample-seconds",
		"1.5",
		"--host-name",
		"cottontail",
		"--",
		"/tmp/app with spaces",
		"--flag=value",
	]);
	assert.equal(parsed.warmupSeconds, 0);
	assert.equal(parsed.sampleSeconds, 1.5);
	assert.equal(parsed.hostName, "cottontail");
	assert.deepEqual(parsed.command, ["/tmp/app with spaces", "--flag=value"]);
	assert.throws(() => parseArguments(["--pid", "5", "--", "app"]));

	const processes = new Map([
		["1:10", { ...stat, pid: 1, identity: "1:10", name: "launcher" }],
		["2:20", { ...stat, pid: 2, identity: "2:20", name: "cottontail" }],
	]);
	assert.equal(selectHostProcess(processes, "1:10", undefined).pid, 1);
	assert.equal(selectHostProcess(processes, "1:10", "cottontail").pid, 2);
	assert.throws(() => selectHostProcess(processes, "1:10", "missing"));
	processes.set("3:30", {
		...stat,
		pid: 3,
		identity: "3:30",
		name: "cottontail",
	});
	assert.throws(() => selectHostProcess(processes, "1:10", "cottontail"));
	console.log("Linux CEF idle benchmark self-test passed");
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		console.log(help);
		return;
	}
	if (options.selfTest) {
		runSelfTest();
		return;
	}
	if (process.platform !== "linux") {
		throw new Error("The CEF idle benchmark requires Linux /proc");
	}

	let child;
	let rootPid = options.pid;
	let rootIdentity;
	let result;
	let benchmarkError;
	let cleanupError;
	const observedProcesses = new Map();
	const signalHandlers = new Map();
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
			interruptedSignal ??= signal;
		};
		signalHandlers.set(signal, handler);
		process.once(signal, handler);
	}

	try {
		if (options.command.length > 0) {
			const [executable, ...arguments_] = options.command;
			child = spawn(executable, arguments_, {
				stdio: "inherit",
				shell: false,
			});
			await new Promise((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
			rootPid = child.pid;
		}

		const root = readProcessStat(rootPid);
		if (!isRunning(root)) throw new Error(`PID ${rootPid} is not running`);
		rootIdentity = root.identity;
		const ticksPerSecond = clockTicksPerSecond();
		const target =
			child === undefined ? `PID ${rootPid}` : options.command[0];
		console.log(
			`Benchmarking ${target}: ${options.warmupSeconds}s warm-up, ` +
				`${options.sampleSeconds}s sample`,
		);

		await warmUp(
			rootPid,
			rootIdentity,
			options.warmupSeconds,
			options.pollMilliseconds,
			observedProcesses,
		);
		result = await sampleCpu(
			rootPid,
			rootIdentity,
			options,
			ticksPerSecond,
			observedProcesses,
		);
		console.log(
			`Host CPU (${result.hostPid}, ${result.hostName}): ` +
				`${result.hostPercent.toFixed(2)}% ` +
				`(required <${options.hostMaximumPercent.toFixed(2)}%)`,
		);
		console.log(
			`Process-tree CPU: ${result.treePercent.toFixed(2)}% ` +
				`(required <${options.treeMaximumPercent.toFixed(2)}%; ` +
				`${result.observedProcessCount} process(es) observed)`,
		);

		const violations = [];
		if (result.hostPercent >= options.hostMaximumPercent) {
			violations.push("host CPU");
		}
		if (result.treePercent >= options.treeMaximumPercent) {
			violations.push("process-tree CPU");
		}
		if (violations.length > 0) {
			throw new Error(`Idle CPU ceiling exceeded: ${violations.join(" and ")}`);
		}
	} catch (error) {
		benchmarkError = error;
	} finally {
		if (child?.pid !== undefined) {
			try {
				const cleanupRoot = readProcessStat(child.pid);
				const cleanupIdentity = rootIdentity ?? cleanupRoot?.identity;
				if (cleanupIdentity !== undefined) {
					await terminateLaunchedProcess(
						child.pid,
						cleanupIdentity,
						observedProcesses.size > 0
							? observedProcesses
							: new Map([[cleanupIdentity, child.pid]]),
						options.shutdownSeconds,
					);
				}
				console.log("Shutdown: launched process tree exited cleanly");
			} catch (error) {
				cleanupError = error;
			}
		}
		for (const [signal, handler] of signalHandlers) {
			process.removeListener(signal, handler);
		}
	}

	if (benchmarkError !== undefined && cleanupError !== undefined) {
		throw new Error(
			`${benchmarkError.message}; cleanup also failed: ${cleanupError.message}`,
		);
	}
	if (benchmarkError !== undefined) throw benchmarkError;
	if (cleanupError !== undefined) throw cleanupError;
	if (child === undefined) console.log("Attached process was left running");
	console.log("Linux CEF idle CPU benchmark passed");
}

main().catch((error) => {
	console.error(`Linux CEF idle CPU benchmark failed: ${error.message}`);
	process.exitCode = 1;
});
