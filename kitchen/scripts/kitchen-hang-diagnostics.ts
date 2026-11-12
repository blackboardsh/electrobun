import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type ProcessInfo = { pid: number; parent: number; group: number; executable: string };
type CommandResult = {
	stdout: string;
	stderr: string;
	error: string | null;
	exitCode: number | null;
	errorCode: string | null;
	signal: NodeJS.Signals | null;
	killed: boolean;
	elapsedMs: number;
};
type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

// SIGKILL also bounds a diagnostic tool that ignores graceful termination.
export const runDiagnosticCommand: CommandRunner = (file, args, timeoutMs) =>
	new Promise((resolve) => {
		const startedAt = performance.now();
		const child = execFile(file, args, {
			encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			resolve({
				stdout, stderr, error: error?.message ?? null,
				exitCode: typeof error?.code === "number" ? error.code : child.exitCode,
				errorCode: typeof error?.code === "string" ? error.code : null,
				signal: error?.signal ?? child.signalCode,
				killed: error?.killed ?? child.killed,
				elapsedMs: Math.round(performance.now() - startedAt),
			});
		});
	});

export function selectMacosHangProcesses(
	listing: string, rootPid: number, runtimeName: string, isolatedProcessGroup: boolean,
) {
	const processes: ProcessInfo[] = [];
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (match) processes.push({
			pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), executable: match[4]!,
		});
	}
	const owned = new Set([rootPid]);
	// Keep orphaned app processes in a timed run's isolated process group even
	// if Hutch or the app launcher exited before the watchdog fired.
	for (const info of processes) {
		if (isolatedProcessGroup && info.group === rootPid) owned.add(info.pid);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const info of processes) {
			if (owned.has(info.parent) && !owned.has(info.pid)) {
				owned.add(info.pid);
				changed = true;
			}
		}
	}
	const tree = processes.filter((info) => owned.has(info.pid));
	const runtimes = tree.filter((info) => info.pid !== rootPid && basename(info.executable) === runtimeName);
	const bundled = runtimes.filter((info) => info.executable.includes(".app/Contents/MacOS/"));
	// Sample the application runtime, not Hutch, its launcher, or CEF helpers.
	// Prefer bundled paths when ps provides them; comm may be a basename only.
	return { tree, targets: (bundled.length ? bundled : runtimes).slice(0, 3) };
}

export async function captureKitchenHangDiagnostics({
	pid, key, mainProcess, isolatedProcessGroup,
	platform = process.platform,
	temporaryDirectory = process.env["ELECTROBUN_DIAGNOSTICS_TEMP"] || tmpdir(),
}: {
	pid: number | undefined;
	key: string;
	mainProcess: string;
	isolatedProcessGroup: boolean;
	platform?: string;
	temporaryDirectory?: string;
}, run: CommandRunner = runDiagnosticCommand): Promise<string | null> {
	if (platform !== "darwin" || !pid) return null;
	mkdirSync(temporaryDirectory, { recursive: true });
	const directory = mkdtempSync(join(temporaryDirectory, `electrobun-kitchen-hang-${key}-`));
	const runtimeName = mainProcess === "bun" || mainProcess === "cottontail" ? mainProcess : "main";
	// comm intentionally excludes process arguments; only the owned tree is
	// persisted, not the runner's unrelated processes. Timed runs already own
	// an isolated group: avoid resolving every host executable during a stall.
	const discoveryArgs = isolatedProcessGroup
		? ["-g", String(pid), "-o", "pid=,ppid=,pgid=,comm="]
		: ["-axo", "pid=,ppid=,pgid=,comm="];
	const listing = await run("/bin/ps", discoveryArgs, 2000);
	const { tree, targets } = selectMacosHangProcesses(listing.stdout, pid, runtimeName, isolatedProcessGroup);
	const { stdout: _listing, ...discoveryResult } = listing;
	writeFileSync(join(directory, "processes.json"), JSON.stringify({
		key, pid, runtimeName, command: "/bin/ps", args: discoveryArgs, timeoutMs: 2000,
		...discoveryResult, tree,
		targets: targets.map((info) => info.pid),
	}, null, 2) + "\n");
	if (!targets.length) {
		writeFileSync(join(directory, "sample-error.txt"), "No live application runtime found in the launched process tree.\n");
	}
	await Promise.all(targets.map(async (info) => {
		const report = join(directory, `sample-${info.pid}.txt`);
		// External dSYM discovery can outlast the sampling itself and prevent any
		// report from being written before the tool deadline. Keep image symbols
		// and addresses, without that additional lookup or a longer timeout.
		const result = await run("/usr/bin/sample", [String(info.pid), "2", "-nodsyms", "-file", report], 8000);
		writeFileSync(join(directory, `sample-${info.pid}-command.json`), JSON.stringify({
			command: "/usr/bin/sample", args: [String(info.pid), "2", "-nodsyms", "-file", report], timeoutMs: 8000,
			...result,
		}, null, 2) + "\n");
	}));
	return directory;
}
