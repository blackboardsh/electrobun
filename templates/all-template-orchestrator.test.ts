import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BUILD_READY_MARKER,
	PROCESS_SPAWNED_MARKER,
	TemplateQaOrchestrator,
	outputContainsBuildReady,
	outputContainsSpawnedProcess,
	parseBetaCatalog,
	type CommandSpec,
	type ManagedProcess,
	type ProcessResult,
	type QaRuntime,
} from "./all/src/bun/orchestrator";
import { inspectTemplateProject } from "./all/src/bun/project-inspection";
import { findTemplateQaProjectRoot } from "./all/src/bun/project-root";

function catalog(
	ids = ["all", "package-free", "npm-app", "package-no-install"],
): unknown {
	return {
		schema: 1,
		kind: "electrobun-template-channel",
		channel: "beta",
		version: "2.0.0-beta.7",
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
};

function fakeHarness(
	options: {
		failFirstBuildFor?: string;
		omitRunMarkerFor?: string;
		enableTimeouts?: boolean;
		configuredVersion?: string;
		projectedVersion?: string;
		omitProjectionFor?: string;
	} = {},
): FakeHarness {
	const commands: CommandSpec[] = [];
	const processes: Array<{ spec: CommandSpec; process: FakeProcess }> = [];
	const materialized = new Set<string>();
	const projected = new Set<string>();
	const buildAttempts = new Map<string, number>();
	let tick = 0;

	const runtime: QaRuntime = {
		async loadCatalog() {
			return catalog();
		},
		ensureDirectory() {},
		isMaterialized(path) {
			return materialized.has(path);
		},
		inspectProject(path) {
			const id = path.split(/[\\/]/).at(-1)!;
			return {
				hasPackageManifest: id !== "package-free",
				hasInstallTask: id === "npm-app",
				configuredElectrobunVersion:
					options.configuredVersion ?? "2.0.0-beta.7",
				projectedElectrobunVersion: projected.has(path)
					? (options.projectedVersion ?? "2.0.0-beta.7")
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
					case "init":
						{
							const directory = join(spec.cwd, spec.templateId);
							materialized.add(directory);
							if (options.omitProjectionFor !== spec.templateId) {
								projected.add(directory);
							}
						}
						process.emit("stdout", "Downloading template\n");
						process.finish();
						break;
					case "install":
						process.emit("stdout", "Installed dependencies\n");
						process.finish();
						break;
					case "build": {
						const count = (buildAttempts.get(spec.templateId) ?? 0) + 1;
						buildAttempts.set(spec.templateId, count);
						if (options.failFirstBuildFor === spec.templateId && count === 1) {
							process.emit("stderr", "cold build failed\n");
							process.finish({ code: 1 });
						} else {
							process.emit("stdout", "electrobun build comp");
							process.emit("stdout", "lete: /tmp/build\n");
							process.finish();
						}
						break;
					}
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

	return { runtime, commands, processes };
}

describe("Template QA catalog and readiness contracts", () => {
	test("uses the beta catalog and excludes its own all template", () => {
		const parsed = parseBetaCatalog(catalog());
		expect(parsed.channel).toBe("beta");
		expect(parsed.templates.map(({ id }) => id)).toEqual([
			"package-free",
			"npm-app",
			"package-no-install",
		]);
		expect(() =>
			parseBetaCatalog({ ...(catalog() as object), channel: "stable" }),
		).toThrow(/expected beta catalog/);
	});

	test("recognizes build and launcher markers split across output chunks", () => {
		expect(outputContainsBuildReady("electrobun build comp", "lete: path"))
			.toBe(true);
		expect(outputContainsSpawnedProcess("Child process spawned with ", "PID 9"))
			.toBe(true);
		expect(BUILD_READY_MARKER).not.toBe(PROCESS_SPAWNED_MARKER);
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

	test("inspects the exact product pin and project-local devkit facade", () => {
		const root = mkdtempSync(join(tmpdir(), "template qa inspection "));
		const devkit = join(root, ".hutch", "devkit");
		try {
			mkdirSync(devkit, { recursive: true });
			writeFileSync(join(root, "package.json"), '{"name":"example"}\n');
			writeFileSync(
				join(root, "electrobun.config.ts"),
				'export default { electrobun: { version: "2.0.0-beta.7" } };\n',
			);
			writeFileSync(
				join(root, "hutch.config.ts"),
				'export default {\n\tscripts: {\n\t\tinstall: ["npm", "ci"],\n\t},\n};\n',
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
				hasPackageManifest: true,
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

describe("Template QA orchestration", () => {
	test("installs only configured npm projects, builds serially, then launches", async () => {
		const harness = fakeHarness();
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/Template QA with spaces",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const kinds = harness.commands.map(({ kind, templateId }) =>
			`${kind}:${templateId}`,
		);
		expect(kinds).toEqual([
			"init:package-free",
			"build:package-free",
			"init:npm-app",
			"install:npm-app",
			"build:npm-app",
			"init:package-no-install",
			"build:package-no-install",
			"run:package-free",
			"run:npm-app",
			"run:package-no-install",
		]);
		expect(harness.commands.every(({ cwd }) => cwd.includes("Template QA with spaces")))
			.toBe(true);
		for (const command of harness.commands.filter(({ kind }) => kind === "build")) {
			expect(command.args).toEqual(["run", "build"]);
			expect(command.env).toBeUndefined();
		}
		for (const command of harness.commands.filter(({ kind }) => kind === "run")) {
			expect(command.args).toEqual([
				"electrobun",
				"run",
				"--env=production",
			]);
			expect(command.env).toBeUndefined();
		}
		expect(orchestrator.getSnapshot().templates.map(({ status }) => status))
			.toEqual(["ready", "ready", "ready"]);

		await orchestrator.stopAll();
		const runProcesses = harness.processes.filter(({ spec }) => spec.kind === "run");
		expect(runProcesses.every(({ process }) => process.terminated)).toBe(true);
	});

	test("continues after a cold failure and records passed-after-retry history", async () => {
		const harness = fakeHarness({ failFirstBuildFor: "package-free" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		let snapshot = orchestrator.getSnapshot();
		expect(snapshot.templates.find(({ id }) => id === "package-free")?.status)
			.toBe("failed");
		expect(snapshot.templates.find(({ id }) => id === "npm-app")?.status)
			.toBe("ready");

		await orchestrator.startTemplate("package-free");
		snapshot = orchestrator.getSnapshot();
		const packageFree = snapshot.templates.find(
			({ id }) => id === "package-free",
		)!;
		expect(packageFree.status).toBe("ready");
		expect(packageFree.readyAfterRetry).toBe(true);
		expect(packageFree.attempts.map(({ outcome }) => outcome)).toEqual([
			"failed",
			"ready",
		]);
		expect(
			snapshot.logs.filter(({ templateId }) => templateId === "package-free")
				.some(({ attempt }) => attempt === 1),
		).toBe(true);
		expect(
			snapshot.logs.filter(({ templateId }) => templateId === "package-free")
				.some(({ attempt }) => attempt === 2),
		).toBe(true);
	});

	test("times out a launch without the PID marker and still launches the rest", async () => {
		const harness = fakeHarness({
			omitRunMarkerFor: "package-free",
			enableTimeouts: true,
		});
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const states = Object.fromEntries(
			orchestrator.getSnapshot().templates.map((state) => [state.id, state]),
		);
		expect(states["package-free"]?.status).toBe("failed");
		expect(states["package-free"]?.lastError).toMatch(/Timed out waiting/);
		expect(states["npm-app"]?.status).toBe("ready");
		const packageFreeRun = harness.processes.find(
			({ spec }) => spec.kind === "run" && spec.templateId === "package-free",
		);
		expect(packageFreeRun?.process.terminated).toBe(true);
	});

	test("refuses a child whose exact product pin drifted", async () => {
		const harness = fakeHarness({ configuredVersion: "2.0.0-beta.8" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const snapshot = orchestrator.getSnapshot();
		expect(snapshot.templates.every(({ status }) => status === "failed")).toBe(true);
		expect(snapshot.templates[0]?.lastError).toMatch(
			/product pin.*Electrobun 2\.0\.0-beta\.7.*2\.0\.0-beta\.8/,
		);
		expect(harness.commands.some(({ kind }) => kind === "build")).toBe(false);
		expect(harness.commands.some(({ kind }) => kind === "run")).toBe(false);
	});

	test("refuses init output without the synchronous project devkit projection", async () => {
		const harness = fakeHarness({ omitProjectionFor: "package-free" });
		const orchestrator = new TemplateQaOrchestrator(harness.runtime, {
			projectRoot: "/tmp/template qa",
			readinessTimeoutMs: 1_000,
			settleMs: 0,
		});

		await orchestrator.startAll();
		const state = orchestrator
			.getSnapshot()
			.templates.find(({ id }) => id === "package-free");
		expect(state?.status).toBe("failed");
		expect(state?.lastError).toMatch(
			/project-local Electrobun 2\.0\.0-beta\.7 devkit projection/,
		);
		expect(
			harness.commands.some(
				({ kind, templateId }) =>
					kind === "build" && templateId === "package-free",
			),
		).toBe(false);
		expect(
			harness.commands.some(
				({ kind, templateId }) => kind === "run" && templateId === "npm-app",
			),
		).toBe(true);
	});
});
