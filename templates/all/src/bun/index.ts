import {
	ApplicationMenu,
	BrowserView,
	BrowserWindow,
	type RPCSchema,
} from "electrobun/main";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	TemplateQaOrchestrator,
	sanitizedTemplateQaEnv,
	selectedTemplateQaRelease,
	type CommandSpec,
	type HutchStoreStatus,
	type ManagedProcess,
	type ProcessResult,
	type QaLog,
	type QaRuntime,
	type QaSnapshot,
} from "./orchestrator";
import { inspectTemplateProject } from "./project-inspection";
import {
	findTemplateQaProjectRoot,
	resolveTemplateQaElectrobunDevkitRoot,
	resolveTemplateQaHutchExecutable,
} from "./project-root";

const DEFAULT_TEMPLATE_BASE_URL =
	"https://electrobun-artifacts.blackboard.sh/electrobun/templates";

type TemplateQaRPC = {
	bun: RPCSchema<{
		requests: {
			getSnapshot: { params: {}; response: QaSnapshot };
			startAll: { params: {}; response: { accepted: boolean } };
			stopAll: { params: {}; response: { accepted: boolean } };
			installTemplate: {
				params: { id: string };
				response: { accepted: boolean };
			};
			launchTemplate: {
				params: { id: string };
				response: { accepted: boolean };
			};
			stopTemplate: {
				params: { id: string };
				response: { accepted: boolean };
			};
			getHutchStatus: { params: {}; response: HutchStoreStatus };
			pruneHutchCache: {
				params: { dryRun: boolean };
				response: { accepted: boolean };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			snapshot: QaSnapshot;
			log: QaLog;
		};
	}>;
};

function normalizedTemplateBaseUrl(): string {
	const raw =
		process.env.ELECTROBUN_TEMPLATES_BASE_URL ?? DEFAULT_TEMPLATE_BASE_URL;
	const value = raw.replace(/\/+$/, "");
	const url = new URL(value);
	const trustedLocal =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !trustedLocal) {
		throw new Error("template catalog URL must use HTTPS or loopback HTTP");
	}
	return value;
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function loadHutchStatus(hutchExecutable: string, projectRoot: string): string {
	const result = spawnSync(hutchExecutable, ["status", "--json"], {
		cwd: projectRoot,
		env: sanitizedTemplateQaEnv(process.env),
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) {
		throw new Error(`Could not start hutch status: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = result.stderr.trim() || `exited with code ${result.status}`;
		throw new Error(`Could not read hutch status: ${detail}`);
	}
	return result.stdout;
}

// Every spawned child leads a process group (detached on POSIX). Track the
// live groups so app exit can reap entire trees synchronously — dev apps and
// package managers must not outlive the QA app.
const liveProcessGroups = new Set<number>();

function killAllProcessGroups(): void {
	for (const pid of liveProcessGroups) {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
			});
			continue;
		}
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// The group already exited.
			}
		}
	}
	liveProcessGroups.clear();
}

class NodeManagedProcess implements ManagedProcess {
	readonly completed: Promise<ProcessResult>;
	private readonly child: ChildProcess;
	private readonly outputListeners: Array<
		(stream: "stdout" | "stderr", text: string) => void
	> = [];
	private readonly pendingOutput: Array<{
		stream: "stdout" | "stderr";
		text: string;
	}> = [];
	private running = true;

	constructor(spec: CommandSpec) {
		this.child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: { ...sanitizedTemplateQaEnv(process.env), ...spec.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: false,
		});

		this.child.stdout?.on("data", (chunk: Buffer | string) => {
			this.emitOutput("stdout", chunk.toString());
		});
		this.child.stderr?.on("data", (chunk: Buffer | string) => {
			this.emitOutput("stderr", chunk.toString());
		});

		if (this.child.pid) liveProcessGroups.add(this.child.pid);
		this.completed = new Promise((resolveCompletion) => {
			let settled = false;
			const finish = (result: ProcessResult) => {
				if (settled) return;
				settled = true;
				this.running = false;
				if (this.child.pid) liveProcessGroups.delete(this.child.pid);
				resolveCompletion(result);
			};
			this.child.once("error", (error) => {
				finish({ code: null, error: error.message });
			});
			this.child.once("close", (code, signal) => finish({ code, signal }));
		});
	}

	get pid(): number | null {
		return this.child.pid ?? null;
	}

	onOutput(
		listener: (stream: "stdout" | "stderr", text: string) => void,
	): void {
		this.outputListeners.push(listener);
		for (const entry of this.pendingOutput.splice(0)) {
			listener(entry.stream, entry.text);
		}
	}

	async terminate(): Promise<void> {
		if (!this.running) return;
		this.signalTree(false);
		await Promise.race([this.completed.then(() => undefined), sleep(4_000)]);
		if (!this.running) return;
		this.signalTree(true);
		await Promise.race([this.completed.then(() => undefined), sleep(1_000)]);
	}

	terminateImmediately(): void {
		if (this.running) this.signalTree(false);
	}

	private emitOutput(stream: "stdout" | "stderr", text: string): void {
		if (this.outputListeners.length === 0) {
			this.pendingOutput.push({ stream, text });
			return;
		}
		for (const listener of this.outputListeners) listener(stream, text);
	}

	private signalTree(force: boolean): void {
		const pid = this.child.pid;
		if (!pid) return;
		if (process.platform === "win32") {
			const args = ["/PID", String(pid), "/T"];
			if (force) args.push("/F");
			spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore" });
			return;
		}
		try {
			process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
		} catch {
			try {
				this.child.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {
				// The process exited between the running check and the signal.
			}
		}
	}
}

const runtime: QaRuntime = {
	async loadCatalog(channel) {
		const response = await fetch(
			`${normalizedTemplateBaseUrl()}/channels/${channel}.json`,
			{ cache: "no-store" },
		);
		if (!response.ok) {
			throw new Error(
				`${channel} template catalog returned HTTP ${response.status}`,
			);
		}
		return response.json();
	},
	ensureDirectory(path) {
		mkdirSync(path, { recursive: true });
	},
	removeDirectory(path) {
		rmSync(path, { recursive: true, force: true });
	},
	isMaterialized(path) {
		return existsSync(join(path, "electrobun.config.ts"));
	},
	inspectProject: inspectTemplateProject,
	spawn(spec) {
		return new NodeManagedProcess(spec);
	},
	sleep,
	now() {
		return new Date();
	},
};

let mainWindow: BrowserWindow | null = null;
const projectRoot = findTemplateQaProjectRoot();
const selectedRelease = selectedTemplateQaRelease(
	inspectTemplateProject(projectRoot),
);
const hutchExecutable = resolveTemplateQaHutchExecutable();
const electrobunDevkitRoot = resolveTemplateQaElectrobunDevkitRoot({
	version: selectedRelease.version,
	platform: process.platform,
	arch: process.arch,
	inheritedRoot: process.env.HUTCH_ELECTROBUN_DEVKIT_ROOT,
	loadHutchStatus: () => loadHutchStatus(hutchExecutable, projectRoot),
});
const orchestrator = new TemplateQaOrchestrator(runtime, {
	projectRoot,
	selectedVersion: selectedRelease.version,
	hutchExecutable,
	nestedHutchEnv: {
		HUTCH_ELECTROBUN_DEVKIT_ROOT: electrobunDevkitRoot,
	},
	onSnapshot(snapshot) {
		// Live log entries use their own append-only message. Avoid repeatedly
		// serializing the complete history on every phase transition.
		(mainWindow?.webview.rpc as any)?.send?.snapshot({ ...snapshot, logs: [] });
	},
	onLog(log) {
		(mainWindow?.webview.rpc as any)?.send?.log(log);
	},
});

const qaRPC = BrowserView.defineRPC<TemplateQaRPC>({
	maxRequestTime: 30_000,
	handlers: {
		requests: {
			getSnapshot: () => orchestrator.getSnapshot(),
			startAll: () => {
				void orchestrator.startAll().catch(console.error);
				return { accepted: true };
			},
			stopAll: () => {
				void orchestrator.stopAll().catch(console.error);
				return { accepted: true };
			},
			installTemplate: ({ id }) => {
				void orchestrator.installTemplate(id).catch(console.error);
				return { accepted: true };
			},
			launchTemplate: ({ id }) => {
				void orchestrator.launchTemplate(id).catch(console.error);
				return { accepted: true };
			},
			stopTemplate: ({ id }) => {
				void orchestrator.stopTemplate(id).catch(console.error);
				return { accepted: true };
			},
			getHutchStatus: () => orchestrator.readHutchStatus(),
			pruneHutchCache: ({ dryRun }) => {
				void orchestrator.pruneHutchCache(dryRun === true).catch(console.error);
				return { accepted: true };
			},
		},
		messages: {},
	},
});

ApplicationMenu.setApplicationMenu([
	{
		submenu: [{ label: "Quit", role: "quit", accelerator: "q" }],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
]);

mainWindow = new BrowserWindow({
	title: "Electrobun Template QA",
	url: "views://mainview/index.html",
	rpc: qaRPC,
	frame: {
		width: 1180,
		height: 820,
		x: 80,
		y: 60,
	},
});

// Load the catalog so templates list as pending, but never start a run without
// an explicit Install all click.
mainWindow.webview.on("dom-ready", () => {
	(mainWindow?.webview.rpc as any)?.send?.snapshot(orchestrator.getSnapshot());
	void orchestrator.initialize().catch(console.error);
});
// Graceful stop first (SIGTERM via the orchestrator), then a hard exit whose
// exit handler force-kills any process group that ignored it.
function shutdownAndExit(code: number): void {
	orchestrator.shutdownImmediately();
	setTimeout(() => process.exit(code), 1_500);
}

mainWindow.on("close", () => shutdownAndExit(0));

process.on("SIGINT", () => shutdownAndExit(130));
process.on("SIGTERM", () => shutdownAndExit(143));
process.on("exit", () => {
	orchestrator.shutdownImmediately();
	killAllProcessGroups();
});

console.log(`Template QA project root: ${projectRoot}`);
console.log(
	`Template QA channel: ${selectedRelease.channel} (${selectedRelease.version})`,
);
