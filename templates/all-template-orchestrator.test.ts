import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROCESS_SPAWNED_MARKER,
	TemplateQaOrchestrator,
	catalogChannelForVersion,
	describeHutchStatusFailure,
	formatByteSize,
	hutchPlatformForHost,
	parseHutchStatus,
	parseHutchStatusOutput,
	outputContainsSpawnedProcess,
	parseTemplateCatalog,
	resolveElectrobunDevkitRootFromHutchStatusOutput,
	sanitizedTemplateQaEnv,
	type CatalogChannel,
	type CommandSpec,
	type ManagedProcess,
	type ProcessResult,
	type QaRuntime,
} from "./all/src/bun/orchestrator";
import {
	inspectTemplateProject,
	isMatchingElectrobunDevkitRoot,
} from "./all/src/bun/project-inspection";
import {
	findTemplateQaProjectRoot,
	resolveTemplateQaElectrobunDevkitRoot,
	resolveTemplateQaHutchExecutable,
} from "./all/src/bun/project-root";

function writeNativeDevkitManifest(
	root: string,
	version = "2.0.0-beta.7",
	os = "linux",
	arch = "arm64",
): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "native-devkit.json"),
		JSON.stringify({
			schemaVersion: 1,
			product: { name: "electrobun", version },
			target: { os, arch },
		}),
	);
}

function catalog(
	ids = ["all", "install-task", "no-install-task"],
	channel: CatalogChannel = "beta",
	version = channel === "beta" ? "2.0.0-beta.7" : "2.0.0",
): unknown {
	return {
		schema: 1,
		kind: "electrobun-template-channel",
		channel,
		version,
		revision: "a".repeat(40),
		templates: ids.map((id) => ({
			id,
			name: id,
			description: `${id} description`,
			mainProcess: "cottontail",
		})),
	};
}

class FakeProcess implements ManagedProcess {
	readonly pid = 42;
	readonly completed: Promise<ProcessResult>;
	terminated = false;
	private resolveCompletion!: (result: ProcessResult) => void;
	private readonly listeners: Array<
		(stream: "stdout" | "stderr", text: string) => void
	> = [];
	private readonly pending: Array<{
		stream: "stdout" | "stderr";
		text: string;
	}> = [];

	constructor() {
		this.completed = new Promise((resolve) => {
			this.resolveCompletion = resolve;
		});
	}

	onOutput(
		listener: (stream: "stdout" | "stderr", text: string) => void,
	): void {
		this.listeners.push(listener);
		for (const entry of this.pending.splice(0)) {
			listener(entry.stream, entry.text);
		}
	}

	emit(stream: "stdout" | "stderr", text: string): void {
		if (this.listeners.length === 0) {
			this.pending.push({ stream, text });
			return;
		}
		for (const listener of this.listeners) listener(stream, text);
	}

	finish(result: ProcessResult = { code: 0 }): void {
		this.resolveCompletion(result);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
		this.finish({ code: null, signal: "SIGTERM" });
	}

	terminateImmediately(): void {
		this.terminated = true;
		this.finish({ code: null, signal: "SIGTERM" });
	}
}

type FakeHarness = {
	runtime: QaRuntime;
	commands: CommandSpec[];
	processes: Array<{ spec: CommandSpec; process: FakeProcess }>;
	materialized: Set<string>;
	projected: Set<string>;
	installedVersions: Map<string, string>;
	removed: string[];
};

function fakeHarness(
	options: {
		failFirstInitFor?: string;
		omitRunMarkerFor?: string;
		enableTimeouts?: boolean;
		configuredVersion?: string;
		projectedVersion?: string;
		omitProjectionFor?: string;
		channel?: CatalogChannel;
		catalogVersion?: string;
		statusStdout?: string;
		statusStderr?: string;
		statusExitCode?: number;
	} = {},
): FakeHarness {
	const commands: CommandSpec[] = [];
	const processes: Array<{ spec: CommandSpec; process: FakeProcess }> = [];
	const materialized = new Set<string>();
	const projected = new Set<string>();
	const installedVersions = new Map<string, string>();
	const removed: string[] = [];
	const initAttempts = new Map<string, number>();
	let tick = 0;
	const channel = options.channel ?? "beta";
	const catalogVersion =
		options.catalogVersion ?? (channel === "beta" ? "2.0.0-beta.7" : "2.0.0");

	const runtime: QaRuntime = {
		async loadCatalog(requestedChannel) {
			expect(requestedChannel).toBe(channel);
			return catalog(undefined, channel, catalogVersion);
		},
		ensureDirectory() {},
		removeDirectory(path) {
			removed.push(path);
			materialized.delete(path);
			projected.delete(path);
			installedVersions.delete(path);
		},
		isMaterialized(path) {
			return materialized.has(path);
		},
		inspectProject(path) {
			const id = path.split(/[\\/]/).at(-1)!;
			const configuredVersion =
				installedVersions.get(path) ??
				options.configuredVersion ??
				catalogVersion;
			return {
				hasInstallTask: id === "install-task",
				configuredElectrobunVersion: configuredVersion,
				projectedElectrobunVersion: projected.has(path)
					? (options.projectedVersion ?? configuredVersion)
					: null,
				devkitProjectionPath: `${path}/.hutch/devkit`,
			};
		},
		spawn(spec) {
			commands.push(spec);
			const process = new FakeProcess();
			processes.push({ spec, process });
			queueMicrotask(() => {
				switch (spec.kind) {
					case "init": {
						const attempt = (initAttempts.get(spec.templateId) ?? 0) + 1;
						initAttempts.set(spec.templateId, attempt);
						if (options.failFirstInitFor === spec.templateId && attempt === 1) {
							process.emit("stderr", "cold install failed\n");
							process.finish({ code: 1 });
							break;
						}
						const directory = join(spec.cwd, spec.templateId);
						materialized.add(directory);
						installedVersions.set(
							directory,
							options.configuredVersion ?? catalogVersion,
						);
						if (options.omitProjectionFor !== spec.templateId) {
							projected.add(directory);
						}
						process.emit("stdout", "Downloading template\n");
						process.finish();
						break;
					}
					case "install":
						if (options.installStderr) {
							process.emit("stderr", options.installStderr);
						}
						process.emit("stdout", "Installed dependencies\n");
						process.finish();
						break;
					case "status":
						if (options.statusStdout) process.emit("stdout", options.statusStdout);
						if (options.statusStderr) process.emit("stderr", options.statusStderr);
						process.finish({ code: options.statusExitCode ?? 0 });
						break;
					case "prune":
						process.emit("stdout", "removed 2 unreachable objects\n");
						process.finish();
						break;
					case "run":
						if (options.omitRunMarkerFor !== spec.templateId) {
							process.emit("stderr", "Child process spawned with ");
							process.emit("stderr", "PID 123\n");
						}
						// A launched app intentionally stays alive.
						break;
				}
			});
			return process;
		},
		async sleep(milliseconds) {
			if (milliseconds > 10) {
				return options.enableTimeouts
					? new Promise<void>((resolve) => setTimeout(resolve, 1))
					: new Promise<void>(() => {});
			}
		},
		now() {
			tick += 1;
			return new Date(1_700_000_000_000 + tick);
		},
	};

	return {
		runtime,
		commands,
		processes,
		materialized,
		projected,
		installedVersions,
		removed,
	};
}

describe("Template QA catalog and readiness contracts", () => {
	test("uses the requested catalog and excludes its own all template", () => {
		const parsed = parseTemplateCatalog(catalog(), "beta");
		expect(parsed.channel).toBe("beta");
		expect(parsed.templates.map(({ id }) => id)).toEqual([
			"install-task",
			"no-install-task",
		]);
		expect(() =>
			parseTemplateCatalog({ ...(catalog() as object), channel: "stable" }, "beta"),
		).toThrow(/expected beta catalog/);

		const stable = parseTemplateCatalog(
			catalog(undefined, "stable", "2.0.0"),
			"stable",
		);
		expect(stable.channel).toBe("stable");
		expect(stable.version).toBe("2.0.0");
	});

	test("derives the channel from an exact product version", () => {
		expect(catalogChannelForVersion("2.0.0")).toBe("stable");
		expect(catalogChannelForVersion("2.0.0-beta.7")).toBe("beta");
		for (const version of ["02.0.0", "2.0", "latest", "^2.0.0", "2.0.0\n"]) {
			expect(() => catalogChannelForVersion(version)).toThrow(/exact version/);
		}
	});

	test("requires a prerelease for beta and a release for stable", () => {
		for (const version of [
			"2.0.0",
			"02.0.0-beta.1",
			"2.0.0-beta.01",
			"^2.0.0-beta.1",
			"latest",
			"file:../catalog",
			"2.0.0-beta.1\n",
		]) {
			expect(() =>
				parseTemplateCatalog({ ...(catalog() as object), version }, "beta"),
			).toThrow(/exact prerelease using strict SemVer 2\.0\.0/);
		}

		expect(
			parseTemplateCatalog({
				...(catalog() as object),
				version: "2.0.0-preview.7+qa.001",
			}, "beta").version,
		).toBe("2.0.0-preview.7+qa.001");

		expect(() =>
			parseTemplateCatalog(
				catalog(undefined, "stable", "2.0.0-beta.1"),
				"stable",
			),
		).toThrow(/exact stable release/);
	});

	test("recognizes the launcher marker split across output chunks", () => {
		expect(outputContainsSpawnedProcess("Child process spawned with ", "PID 9"))
			.toBe(true);
		expect(outputContainsSpawnedProcess("", PROCESS_SPAWNED_MARKER)).toBe(true);
		expect(outputContainsSpawnedProcess("Child process ", "exited")).toBe(false);
	});

	test("finds the installed meta-template root through paths with spaces", () => {
		const root = mkdtempSync(join(tmpdir(), "template qa root "));
		try {
			writeFileSync(
				join(root, "electrobun.config.ts"),
				'export default { app: { identifier: "template-qa.electrobun.dev" } };\n',
			);
			const nested = join(root, "build output", "Template QA.app", "Contents");
			mkdirSync(nested, { recursive: true });
			expect(findTemplateQaProjectRoot(nested, "")).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("inherits the pinned Hutch launcher without splitting paths with spaces", () => {
		const launcher = join(
			"/tmp",
			"Pinned Hutch Runtime",
			"hutch launcher with spaces",
		);
		expect(
			resolveTemplateQaHutchExecutable({ HUTCH_LAUNCHER_PATH: launcher }),
		).toBe(launcher);
		expect(
			resolveTemplateQaHutchExecutable({
				HUTCH_TEMPLATE_QA_EXECUTABLE: "explicit-hutch",
				HUTCH_LAUNCHER_PATH: launcher,
			}),
		).toBe("explicit-hutch");
		expect(resolveTemplateQaHutchExecutable({})).toBe("hutch");
	});

	test("selects the exact installed Electrobun devkit from Hutch status", () => {
		const status = JSON.stringify({
			schemaVersion: 3,
			kind: "hutch-status",
			releases: [
				{
					name: "electrobun",
					installs: [
						{
							version: "2.0.0-beta.6",
							platform: "linux-arm64",
							path: "/store/electrobun/2.0.0-beta.6/linux-arm64",
						},
						{
							version: "2.0.0-beta.7",
							platform: "linux-x64",
							path: "/store/electrobun/2.0.0-beta.7/linux-x64",
						},
						{
							version: "2.0.0-beta.7",
							platform: "linux-arm64",
							path: "/store/electrobun/2.0.0-beta.7/linux-arm64",
						},
					],
				},
			],
		});
		expect(
			resolveElectrobunDevkitRootFromHutchStatusOutput(
				`hutch notice\n${status}\n`,
				"2.0.0-beta.7",
				"linux-arm64",
			),
		).toBe("/store/electrobun/2.0.0-beta.7/linux-arm64");
		expect(() =>
			resolveElectrobunDevkitRootFromHutchStatusOutput(
				status,
				"2.0.0-beta.8",
				"linux-arm64",
			),
		).toThrow(/does not list Electrobun 2\.0\.0-beta\.8 for linux-arm64/);
		expect(hutchPlatformForHost("darwin", "arm64")).toBe("macos-arm64");
		expect(hutchPlatformForHost("win32", "x64")).toBe("windows-x64");
		expect(hutchPlatformForHost("linux", "arm64")).toBe("linux-arm64");
		expect(() => hutchPlatformForHost("freebsd", "x64")).toThrow(
			/unsupported Hutch host platform/,
		);
	});

	test("uses a full inherited devkit root and rejects a project projection", () => {
		const fixture = mkdtempSync(join(tmpdir(), "template qa devkit root "));
		const releaseRoot = join(fixture, "release");
		const projectionRoot = join(fixture, "project", ".hutch", "devkit");
		try {
			writeNativeDevkitManifest(releaseRoot);
			mkdirSync(projectionRoot, { recursive: true });
			writeFileSync(
				join(projectionRoot, "projection.json"),
				JSON.stringify({
					schemaVersion: 1,
					kind: "electrobun-devkit-projection",
					product: { name: "electrobun", version: "2.0.0-beta.7" },
				}),
			);

			let statusLoads = 0;
			const status = () => {
				statusLoads += 1;
				return JSON.stringify({
					kind: "hutch-status",
					releases: [
						{
							name: "electrobun",
							installs: [
								{
									version: "2.0.0-beta.7",
									platform: "linux-arm64",
									path: releaseRoot,
								},
							],
						},
					],
				});
			};

			expect(
				resolveTemplateQaElectrobunDevkitRoot({
					version: "2.0.0-beta.7",
					platform: "linux",
					arch: "arm64",
					inheritedRoot: releaseRoot,
					loadHutchStatus: status,
				}),
			).toBe(releaseRoot);
			expect(statusLoads).toBe(0);
			expect(isMatchingElectrobunDevkitRoot(projectionRoot, "2.0.0-beta.7", {
				os: "linux",
				arch: "arm64",
			})).toBe(false);
			expect(
				resolveTemplateQaElectrobunDevkitRoot({
					version: "2.0.0-beta.7",
					platform: "linux",
					arch: "arm64",
					inheritedRoot: projectionRoot,
					loadHutchStatus: status,
				}),
			).toBe(releaseRoot);
			expect(statusLoads).toBe(1);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	test("inspects the exact product pin and project-local devkit facade", () => {
		const root = mkdtempSync(join(tmpdir(), "template qa inspection "));
		const devkit = join(root, ".hutch", "devkit");
		try {
			mkdirSync(devkit, { recursive: true });
			expect(existsSync(join(root, "package.json"))).toBe(false);
			writeFileSync(
				join(root, "hutch.config.ts"),
				'export default {\n\telectrobun: { version: "2.0.0-beta.7" },\n\tscripts: {\n\t\tinstall: ["npm", "ci"],\n\t},\n};\n',
			);
			writeFileSync(
				join(devkit, "projection.json"),
				JSON.stringify({
					schemaVersion: 1,
					kind: "electrobun-devkit-projection",
					product: { name: "electrobun", version: "2.0.0-beta.7" },
				}),
			);
			writeFileSync(
				join(devkit, "package.json"),
				JSON.stringify({ name: "electrobun", version: "2.0.0-beta.7" }),
			);
			writeFileSync(join(devkit, "tsconfig.json"), "{}\n");

			expect(inspectTemplateProject(root)).toEqual({
				hasInstallTask: true,
				configuredElectrobunVersion: "2.0.0-beta.7",
				projectedElectrobunVersion: "2.0.0-beta.7",
				devkitProjectionPath: devkit,
			});

			writeFileSync(
				join(devkit, "package.json"),
				JSON.stringify({ name: "electrobun", version: "2.0.0-beta.8" }),
			);
			expect(inspectTemplateProject(root).projectedElectrobunVersion).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Template QA child environment", () => {
	test("strips the parent app's Electrobun runtime markers", () => {
		expect(
			sanitizedTemplateQaEnv({
				PATH: "/usr/bin",
				HOME: "/Users/qa",
				COTTONTAIL_ELECTROBUN_DIST: "/dist",
				COTTONTAIL_ELECTROBUN_NAME: "Template QA",
				COTTONTAIL_ELECTROBUN_IDENTIFIER: "qa.electrobun.dev",
				COTTONTAIL_ELECTROBUN_CHANNEL: "dev",
				ELECTROBUN_BUILD_ENV: "dev",
				ELECTROBUN_OS: "macos",
				ELECTROBUN_TEMPLATES_BASE_URL: "http://127.0.0.1:8080/templates",
				HUTCH_ELECTROBUN_DEVKIT_ROOT: "/store/electrobun/devkit",
				UNSET: undefined,
			}),
		).toEqual({
			PATH: "/usr/bin",
			HOME: "/Users/qa",
			ELECTROBUN_TEMPLATES_BASE_URL: "http://127.0.0.1:8080/templates",
			HUTCH_ELECTROBUN_DEVKIT_ROOT: "/store/electrobun/devkit",
		});
	});
});

describe("Template QA orchestration", () => {
	test("hutch progress notices on stderr display as regular output", async () => {
		const harness = fakeHarness({
			installStderr:
				"hutch: downloading rust 1.88.0 toolchain for macos-arm64\nhutch electrobun: macOS icon source not found: /x\n",
		});
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});
		await orchestrator.installTemplate("install-task");
		const logs = orchestrator.getSnapshot().logs;
		const progress = logs.find(({ text }) => text.startsWith("hutch: downloading"));
		const warning = logs.find(({ text }) => text.startsWith("hutch electrobun:"));
		expect(progress?.stream).toBe("stdout");
		expect(warning?.stream).toBe("stderr");
	});

	test("installs into flat template directories and reinstalls stale projects", async () => {
		const harness = fakeHarness();
		const root = "/tmp/template qa";
		const staleDirectory = join(root, "templates", "install-task");
		harness.materialized.add(staleDirectory);
		harness.projected.add(staleDirectory);
		harness.installedVersions.set(staleDirectory, "2.0.0-beta.6");

		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: root,
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});
		await orchestrator.startAll();

		const snapshot = orchestrator.getSnapshot();
		expect(snapshot.root).toBe(join(root, "templates"));
		for (const command of harness.commands) {
			if (command.kind === "init") {
				expect(command.cwd).toBe(join(root, "templates"));
			} else {
				expect(command.cwd).toBe(join(root, "templates", command.templateId));
			}
		}
		expect(harness.removed).toEqual([staleDirectory]);
		expect(
			harness.commands
				.filter(({ kind }) => kind === "init")
				.map(({ templateId }) => templateId),
		).toEqual(["install-task", "no-install-task"]);
		expect(snapshot.templates.map(({ status }) => status)).toEqual([
			"ready",
			"ready",
		]);
		expect(
			snapshot.logs.some(
				({ text }) =>
					text.includes("Reinstalling") && text.includes("2.0.0-beta.6"),
			),
		).toBe(true);
		await orchestrator.stopAll();
	});

	test("uses the stable catalog and init channel for a stable product", async () => {
		const harness = fakeHarness({ channel: "stable", catalogVersion: "2.0.0" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/stable template qa",
			channel: "stable",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		expect(orchestrator.getSnapshot().channel).toBe("stable");
		for (const command of harness.commands.filter(({ kind }) => kind === "init")) {
			expect(command.args).toContain("--channel=stable");
			expect(command.args).not.toContain("--channel=beta");
		}
		await orchestrator.stopAll();
	});

	test("installs serially, then launches every template with its start task", async () => {
		const harness = fakeHarness();
		const pinnedHutch = join(
			"/tmp",
			"Pinned Hutch Runtime",
			"hutch launcher with spaces",
		);
		const nestedHutchEnv = {
			HUTCH_ELECTROBUN_DEVKIT_ROOT:
				"/store/electrobun/2.0.0-beta.7/linux-arm64",
		};
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/Template QA with spaces",
			channel: "beta",
			hutchExecutable: pinnedHutch,
			nestedHutchEnv,
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const kinds = harness.commands.map(({ kind, templateId }) =>
			`${kind}:${templateId}`,
		);
		expect(kinds).toEqual([
			"init:install-task",
			"install:install-task",
			"init:no-install-task",
			"run:install-task",
			"run:no-install-task",
		]);
		expect(harness.commands.every(({ cwd }) => cwd.includes("Template QA with spaces")))
			.toBe(true);
		expect(harness.commands.every(({ command }) => command === pinnedHutch)).toBe(
			true,
		);
		for (const command of harness.commands.filter(({ kind }) => kind === "init")) {
			expect(command.args).toEqual([
				"electrobun",
				"init",
				command.templateId,
				`--template=${command.templateId}`,
				"--channel=beta",
				"--skip-install",
			]);
			expect(command.env).toEqual(nestedHutchEnv);
		}
		for (const command of harness.commands.filter(({ kind }) => kind === "install")) {
			expect(command.args).toEqual(["run", "install"]);
			expect(command.env).toEqual(nestedHutchEnv);
		}
		// Launch is exactly the command a new user runs; dev builds happen inside it.
		for (const command of harness.commands.filter(({ kind }) => kind === "run")) {
			expect(command.args).toEqual(["run", "start"]);
			expect(command.cwd.endsWith(command.templateId)).toBe(true);
			expect(command.env).toEqual(nestedHutchEnv);
		}
		expect(orchestrator.getSnapshot().templates.map(({ status }) => status))
			.toEqual(["ready", "ready"]);

		await orchestrator.stopAll();
		const runProcesses = harness.processes.filter(({ spec }) => spec.kind === "run");
		expect(runProcesses.every(({ process }) => process.terminated)).toBe(true);
	});

	test("continues after a cold failure and records passed-after-retry history", async () => {
		const harness = fakeHarness({ failFirstInitFor: "no-install-task" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		let snapshot = orchestrator.getSnapshot();
		expect(snapshot.templates.find(({ id }) => id === "no-install-task")?.status)
			.toBe("failed");
		expect(snapshot.templates.find(({ id }) => id === "install-task")?.status)
			.toBe("ready");

		await orchestrator.startTemplate("no-install-task");
		snapshot = orchestrator.getSnapshot();
		const noInstall = snapshot.templates.find(
			({ id }) => id === "no-install-task",
		)!;
		expect(noInstall.status).toBe("ready");
		expect(noInstall.readyAfterRetry).toBe(true);
		expect(noInstall.attempts.map(({ outcome }) => outcome)).toEqual([
			"failed",
			"ready",
		]);
		expect(
			snapshot.logs.filter(({ templateId }) => templateId === "no-install-task")
				.some(({ attempt }) => attempt === 1),
		).toBe(true);
		expect(
			snapshot.logs.filter(({ templateId }) => templateId === "no-install-task")
				.some(({ attempt }) => attempt === 2),
		).toBe(true);
	});

	test("times out a launch without the PID marker and still launches the rest", async () => {
		const harness = fakeHarness({
			omitRunMarkerFor: "no-install-task",
			enableTimeouts: true,
		});
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const states = Object.fromEntries(
			orchestrator.getSnapshot().templates.map((state) => [state.id, state]),
		);
		expect(states["no-install-task"]?.status).toBe("failed");
		expect(states["no-install-task"]?.lastError).toMatch(/Timed out waiting/);
		expect(states["install-task"]?.status).toBe("ready");
		const noInstallRun = harness.processes.find(
			({ spec }) => spec.kind === "run" && spec.templateId === "no-install-task",
		);
		expect(noInstallRun?.process.terminated).toBe(true);
	});

	test("refuses a child whose exact product pin drifted", async () => {
		const harness = fakeHarness({ configuredVersion: "2.0.0-beta.8" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const snapshot = orchestrator.getSnapshot();
		expect(snapshot.templates.every(({ status }) => status === "failed")).toBe(true);
		expect(snapshot.templates[0]?.lastError).toMatch(
			/product pin.*Electrobun 2\.0\.0-beta\.7.*2\.0\.0-beta\.8/,
		);
		expect(harness.commands.some(({ kind }) => kind === "install")).toBe(false);
		expect(harness.commands.some(({ kind }) => kind === "run")).toBe(false);
	});

	test("refuses init output without the synchronous project devkit projection", async () => {
		const harness = fakeHarness({ omitProjectionFor: "no-install-task" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const state = orchestrator
			.getSnapshot()
			.templates.find(({ id }) => id === "no-install-task");
		expect(state?.status).toBe("failed");
		expect(state?.lastError).toMatch(
			/project-local Electrobun 2\.0\.0-beta\.7 devkit projection/,
		);
		expect(
			harness.commands.some(
				({ kind, templateId }) =>
					kind === "run" && templateId === "no-install-task",
			),
		).toBe(false);
		expect(
			harness.commands.some(
				({ kind, templateId }) => kind === "run" && templateId === "install-task",
			),
		).toBe(true);
	});
});

function hutchStatusPayload(): unknown {
	return {
		schemaVersion: 1,
		kind: "hutch-status",
		home: { path: "/Users/qa/.hutch", source: "default" },
		products: [
			{ name: "electrobun", bytes: 2_048, installs: [{ version: "2.0.0" }] },
			{
				name: "hutch",
				bytes: 1_024,
				installs: [{ version: "0.7.1" }, { version: "0.7.0" }],
			},
		],
		toolchains: [{ language: "go", version: "1.26.4", bytes: 4_096 }],
		cache: {
			objectCount: 3,
			bytes: 8_192,
			objects: [
				{ type: "electrobun", bytes: 2_048, reachable: true, inUse: true },
				{ type: "toolchain", bytes: 4_096, reachable: false, inUse: false },
				{ type: "toolchain", bytes: 2_048, reachable: false, inUse: true },
			],
		},
		issues: [{ kind: "missing-target" }],
		totals: {
			productsBytes: 3_072,
			toolchainsBytes: 4_096,
			cacheBytes: 8_192,
			bytes: 7_168,
		},
	};
}

describe("Hutch store status", () => {
	test("reduces a hutch status document to the panel summary", () => {
		const summary = parseHutchStatus(hutchStatusPayload());
		expect(summary).toEqual({
			homePath: "/Users/qa/.hutch",
			homeSource: "default",
			productCount: 2,
			productInstallCount: 3,
			productsBytes: 3_072,
			toolchainCount: 1,
			toolchainsBytes: 4_096,
			cacheObjectCount: 3,
			cacheBytes: 8_192,
			prunableObjectCount: 1,
			totalBytes: 7_168,
			issueCount: 1,
		});
	});

	test("derives sizes when a payload omits totals and optional sections", () => {
		const payload = hutchStatusPayload() as Record<string, unknown>;
		delete payload.totals;
		delete payload.issues;
		delete payload.home;
		const summary = parseHutchStatus(payload);
		expect(summary.productsBytes).toBe(3_072);
		expect(summary.toolchainsBytes).toBe(4_096);
		expect(summary.totalBytes).toBe(7_168);
		expect(summary.homePath).toBe("unknown");
		expect(summary.issueCount).toBe(0);

		const bare = parseHutchStatus({ kind: "hutch-status" });
		expect(bare.productCount).toBe(0);
		expect(bare.cacheObjectCount).toBe(0);
		expect(bare.totalBytes).toBe(0);
	});

	test("rejects output that is not a hutch status document", () => {
		expect(() => parseHutchStatus({ kind: "something-else" })).toThrow(
			/unrecognized document/,
		);
		expect(() => parseHutchStatusOutput("hutch: unknown command 'status'\n")).toThrow(
			/did not return JSON/,
		);
		expect(() => parseHutchStatusOutput("{not json}")).toThrow(/not valid JSON/);
		expect(
			parseHutchStatusOutput(
				`warming caches\n${JSON.stringify(hutchStatusPayload())}\n`,
			).cacheObjectCount,
		).toBe(3);
	});

	test("explains an unsupported hutch with its own stderr", () => {
		expect(
			describeHutchStatusFailure(
				"\nerror: unknown command 'status'\nusage: hutch\n",
				"hutch status exited with code 2",
			),
		).toBe(
			"Status unavailable — this hutch may predate `hutch status --json` (0.7+). error: unknown command 'status'",
		);
		expect(describeHutchStatusFailure("   \n", "hutch status exited with code 2")).toBe(
			"Status unavailable — this hutch may predate `hutch status --json` (0.7+). hutch status exited with code 2",
		);
	});

	test("formats store sizes for the panel", () => {
		expect(formatByteSize(0)).toBe("0 B");
		expect(formatByteSize(-4)).toBe("0 B");
		expect(formatByteSize(900)).toBe("900 B");
		expect(formatByteSize(1_536)).toBe("1.5 KB");
		expect(formatByteSize(612_324_946)).toBe("584 MB");
		expect(formatByteSize(5 * 1024 ** 3)).toBe("5 GB");
	});

	test("reads the store through hutch and reports an unsupported hutch", async () => {
		const harness = fakeHarness({
			statusStdout: JSON.stringify(hutchStatusPayload()),
		});
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			hutchExecutable: "/opt/hutch",
			nestedHutchEnv: {
				HUTCH_ELECTROBUN_DEVKIT_ROOT: "/store/electrobun/devkit",
			},
		});

		const status = await orchestrator.readHutchStatus();
		expect(status.ok).toBe(true);
		if (status.ok) expect(status.summary.cacheObjectCount).toBe(3);
		const statusCommand = harness.commands.find(({ kind }) => kind === "status");
		expect(statusCommand?.command).toBe("/opt/hutch");
		expect(statusCommand?.args).toEqual(["status", "--json"]);
		expect(statusCommand?.env).toBeUndefined();

		const legacy = new TemplateQaOrchestrator(
			fakeHarness({
				statusStderr: "error: unknown command 'status'\n",
				statusExitCode: 2,
			}).runtime,
			{ projectRoot: "/tmp/template qa", channel: "beta" },
		);
		const legacyStatus = await legacy.readHutchStatus();
		expect(legacyStatus.ok).toBe(false);
		if (!legacyStatus.ok) {
			expect(legacyStatus.message).toMatch(/Status unavailable/);
			expect(legacyStatus.message).toMatch(/unknown command 'status'/);
		}
	});

	test("previews and runs a cache prune, logging its output", async () => {
		const harness = fakeHarness();
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			nestedHutchEnv: {
				HUTCH_ELECTROBUN_DEVKIT_ROOT: "/store/electrobun/devkit",
			},
		});

		expect(await orchestrator.pruneHutchCache(true)).toBe(true);
		expect(await orchestrator.pruneHutchCache(false)).toBe(true);
		expect(
			harness.commands.filter(({ kind }) => kind === "prune").map(({ args }) => args),
		).toEqual([
			["cache", "prune", "--dry-run"],
			["cache", "prune"],
		]);
		expect(
			harness.commands
				.filter(({ kind }) => kind === "prune")
				.every(({ env }) => env === undefined),
		).toBe(true);
		const logs = orchestrator
			.getSnapshot()
			.logs.filter(({ templateId }) => templateId === "hutch-store");
		expect(logs.some(({ text }) => text.includes("removed 2 unreachable objects"))).toBe(
			true,
		);
		expect(logs.some(({ text }) => text.includes("Prune preview finished."))).toBe(true);
	});
});

describe("Per-template install and launch", () => {
	test("install stops after the install task, and launch reuses the project", async () => {
		const harness = fakeHarness();
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.installTemplate("install-task");
		const installed = orchestrator
			.getSnapshot()
			.templates.find(({ id }) => id === "install-task");
		expect(installed?.status).toBe("prepared");
		expect(harness.commands.map(({ kind }) => kind)).toEqual(["init", "install"]);

		await orchestrator.launchTemplate("install-task");
		const runCommands = harness.commands.filter(({ kind }) => kind === "run");
		expect(runCommands).toHaveLength(1);
		expect(runCommands[0]?.args).toEqual(["run", "start"]);
		// Launch must not re-run init or the install task for a prepared project.
		expect(harness.commands.filter(({ kind }) => kind === "init")).toHaveLength(1);
		expect(harness.commands.filter(({ kind }) => kind === "install")).toHaveLength(1);
		expect(
			orchestrator.getSnapshot().templates.find(({ id }) => id === "install-task")
				?.status,
		).toBe("ready");
	});

	test("launch without an installed project installs first, and stop still works", async () => {
		const harness = fakeHarness();
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			channel: "beta",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.launchTemplate("no-install-task");
		expect(harness.commands.map(({ kind }) => kind)).toEqual(["init", "run"]);
		expect(
			orchestrator.getSnapshot().templates.find(({ id }) => id === "no-install-task")
				?.status,
		).toBe("ready");

		await orchestrator.stopTemplate("no-install-task");
		const runProcess = harness.processes.find(({ spec }) => spec.kind === "run");
		expect(runProcess?.process.terminated).toBe(true);
		expect(
			orchestrator.getSnapshot().templates.find(({ id }) => id === "no-install-task")
				?.status,
		).toBe("stopped");
	});
});
