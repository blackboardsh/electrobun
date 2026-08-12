import { join } from "node:path";

export const META_TEMPLATE_ID = "all";
export const BUILD_READY_MARKER = "electrobun build complete:";
export const PROCESS_SPAWNED_MARKER = "Child process spawned with PID";

const STRICT_SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export type TemplateStatus =
	| "pending"
	| "downloading"
	| "installing"
	| "starting"
	| "ready"
	| "failed"
	| "stopping"
	| "stopped";

export type LogStream = "stdout" | "stderr" | "system";

export type CatalogTemplate = {
	id: string;
	name: string;
	description: string;
	mainProcess: string;
};

export type TemplateAttempt = {
	number: number;
	startedAt: string;
	readyAt?: string;
	endedAt?: string;
	outcome: "running" | "ready" | "failed" | "stopped";
	error?: string;
};

export type CatalogChannel = "stable" | "beta";

export type TemplateCatalog = {
	channel: CatalogChannel;
	version: string;
	revision: string;
	templates: CatalogTemplate[];
};

export type TemplateState = CatalogTemplate & {
	status: TemplateStatus;
	detail?: string;
	directory?: string;
	lastError?: string;
	attemptCount: number;
	lastAttemptStartedAt?: string;
	readyAfterRetry?: boolean;
	attempts: TemplateAttempt[];
};

export type QaLog = {
	sequence: number;
	templateId: string;
	attempt: number;
	stream: LogStream;
	text: string;
	timestamp: string;
};

export type QaSnapshot = {
	catalogVersion: string;
	channel: CatalogChannel;
	root: string;
	templates: TemplateState[];
	logs: QaLog[];
};

export type ProcessResult = {
	code: number | null;
	signal?: string | null;
	error?: string;
};

export type CommandSpec = {
	kind: "init" | "install" | "build" | "run";
	templateId: string;
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
};

export type ProjectInspection = {
	hasInstallTask: boolean;
	configuredElectrobunVersion: string | null;
	projectedElectrobunVersion: string | null;
	devkitProjectionPath: string;
};

export interface ManagedProcess {
	readonly pid: number | null;
	readonly completed: Promise<ProcessResult>;
	onOutput(listener: (stream: "stdout" | "stderr", text: string) => void): void;
	terminate(): Promise<void>;
	terminateImmediately(): void;
}

export interface QaRuntime {
	loadCatalog(channel: CatalogChannel): Promise<unknown>;
	ensureDirectory(path: string): Promise<void> | void;
	removeDirectory(path: string): Promise<void> | void;
	isMaterialized(path: string): Promise<boolean> | boolean;
	inspectProject(path: string): Promise<ProjectInspection> | ProjectInspection;
	spawn(spec: CommandSpec): ManagedProcess;
	sleep(milliseconds: number): Promise<void>;
	now(): Date;
}

export type OrchestratorOptions = {
	projectRoot: string;
	channel: CatalogChannel;
	hutchExecutable?: string;
	readinessTimeoutMs?: number;
	settleMs?: number;
	onSnapshot?: (snapshot: QaSnapshot) => void;
	onLog?: (log: QaLog) => void;
};

type ActiveProcess = {
	process: ManagedProcess;
	phase: "init" | "install" | "build" | "run";
	intentionalStop: boolean;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(
	value: Record<string, unknown>,
	field: string,
	label: string,
): string {
	const result = value[field];
	if (typeof result !== "string" || result.length === 0) {
		throw new Error(`${label}.${field} must be a non-empty string`);
	}
	return result;
}

export function catalogChannelForVersion(version: string): CatalogChannel {
	const parsed = STRICT_SEMVER.exec(version);
	if (!parsed || parsed[0].length !== version.length) {
		throw new Error(
			"Electrobun product version must be an exact version using strict SemVer 2.0.0",
		);
	}
	return parsed[4] === undefined ? "stable" : "beta";
}

export function parseTemplateCatalog(
	value: unknown,
	expectedChannel: CatalogChannel,
): TemplateCatalog {
	const root = requireRecord(value, "catalog");
	if (root.schema !== 1 || root.kind !== "electrobun-template-channel") {
		throw new Error("unsupported Electrobun template catalog");
	}
	if (root.channel !== expectedChannel) {
		throw new Error(
			`expected ${expectedChannel} catalog, received ${String(root.channel)}`,
		);
	}
	const version = requireString(root, "version", "catalog");
	const expectedVersionDescription =
		expectedChannel === "beta" ? "prerelease" : "stable release";
	let versionChannel: CatalogChannel;
	try {
		versionChannel = catalogChannelForVersion(version);
	} catch {
		throw new Error(
			`catalog.version must be an exact ${expectedVersionDescription} using strict SemVer 2.0.0`,
		);
	}
	if (versionChannel !== expectedChannel) {
		throw new Error(
			`catalog.version must be an exact ${expectedVersionDescription} using strict SemVer 2.0.0`,
		);
	}
	const revision = requireString(root, "revision", "catalog");
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
		throw new Error("catalog.revision must be a lowercase Git revision");
	}
	if (!Array.isArray(root.templates)) {
		throw new Error("catalog.templates must be an array");
	}

	const seen = new Set<string>();
	const templates: CatalogTemplate[] = [];
	for (const [index, rawTemplate] of root.templates.entries()) {
		const template = requireRecord(rawTemplate, `catalog.templates[${index}]`);
		const id = requireString(template, "id", `catalog.templates[${index}]`);
		if (!/^[a-z0-9-]{1,80}$/.test(id)) {
			throw new Error(`invalid template id ${JSON.stringify(id)}`);
		}
		if (seen.has(id)) throw new Error(`duplicate template id ${id}`);
		seen.add(id);
		if (id === META_TEMPLATE_ID) continue;
		templates.push({
			id,
			name: requireString(template, "name", `template ${id}`),
			description: requireString(template, "description", `template ${id}`),
			mainProcess: requireString(template, "mainProcess", `template ${id}`),
		});
	}
	if (templates.length === 0) {
		throw new Error(`${expectedChannel} catalog contains no runnable templates`);
	}
	return { channel: expectedChannel, version, revision, templates };
}

// The QA app is itself a running Electrobun app, so its environment carries
// the runtime markers hutch sets when launching an app. Cottontail boots
// ElectrobunCore for any script it runs while COTTONTAIL_ELECTROBUN_DIST is
// present, which fails outside a packaged bundle, so nested hutch and app
// processes must never inherit those markers.
const PRESERVED_ELECTROBUN_ENV = new Set(["ELECTROBUN_TEMPLATES_BASE_URL"]);

export function sanitizedTemplateQaEnv(
	env: Record<string, string | undefined>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (
			!PRESERVED_ELECTROBUN_ENV.has(key) &&
			(key.startsWith("ELECTROBUN_") ||
				key.startsWith("COTTONTAIL_ELECTROBUN_"))
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

export function outputContainsBuildReady(previousTail: string, chunk: string): boolean {
	return `${previousTail}${chunk}`.includes(BUILD_READY_MARKER);
}

export function outputContainsSpawnedProcess(
	previousTail: string,
	chunk: string,
): boolean {
	return `${previousTail}${chunk}`.includes(PROCESS_SPAWNED_MARKER);
}

function resultDescription(result: ProcessResult): string {
	if (result.error) return result.error;
	if (result.signal) return `terminated by ${result.signal}`;
	return `exited with code ${result.code ?? "unknown"}`;
}

export class TemplateQaOrchestrator {
	private readonly runtime: QaRuntime;
	private readonly projectRoot: string;
	private readonly channel: CatalogChannel;
	private readonly hutchExecutable: string;
	private readonly readinessTimeoutMs: number;
	private readonly settleMs: number;
	private readonly onSnapshot?: (snapshot: QaSnapshot) => void;
	private readonly onLog?: (log: QaLog) => void;
	private catalog: TemplateCatalog | null = null;
	private runRoot = "";
	private states: TemplateState[] = [];
	private logs: QaLog[] = [];
	private sequence = 0;
	private initialization: Promise<void> | null = null;
	private queue: Promise<void> = Promise.resolve();
	private stopEpoch = 0;
	private shuttingDown = false;
	private readonly suppressed = new Set<string>();
	private readonly active = new Map<string, ActiveProcess>();
	private readonly preparedProjects = new Set<string>();

	constructor(runtime: QaRuntime, options: OrchestratorOptions) {
		this.runtime = runtime;
		this.projectRoot = options.projectRoot;
		this.channel = options.channel;
		this.hutchExecutable = options.hutchExecutable ?? "hutch";
		this.readinessTimeoutMs = options.readinessTimeoutMs ?? 15 * 60_000;
		this.settleMs = options.settleMs ?? 1_000;
		this.onSnapshot = options.onSnapshot;
		this.onLog = options.onLog;
	}

	async initialize(): Promise<void> {
		if (!this.initialization) {
			this.initialization = this.initializeOnce();
		}
		return this.initialization;
	}

	private async initializeOnce(): Promise<void> {
		this.catalog = parseTemplateCatalog(
			await this.runtime.loadCatalog(this.channel),
			this.channel,
		);
		this.runRoot = join(this.projectRoot, "templates");
		await this.runtime.ensureDirectory(this.runRoot);
		this.states = this.catalog.templates.map((template) => ({
			...template,
			status: "pending",
			detail: "Waiting to start",
			directory: join(this.runRoot, template.id),
			attemptCount: 0,
			attempts: [],
		}));
		this.systemLog(
			META_TEMPLATE_ID,
			`Loaded Electrobun ${this.catalog.version} ${this.channel} catalog (${this.states.length} templates).`,
		);
		this.emitSnapshot();
	}

	getSnapshot(): QaSnapshot {
		return {
			catalogVersion: this.catalog?.version ?? "Discovering…",
			channel: this.channel,
			root: this.runRoot || join(this.projectRoot, "templates"),
			templates: this.states.map((state) => ({
				...state,
				attempts: state.attempts.map((attempt) => ({ ...attempt })),
			})),
			logs: this.logs.map((entry) => ({ ...entry })),
		};
	}

	startAll(): Promise<void> {
		this.suppressed.clear();
		const epoch = this.stopEpoch;
		return this.enqueue(async () => {
			await this.initialize();
			const prepared: string[] = [];
			for (const state of this.states) {
				if (this.shuttingDown || epoch !== this.stopEpoch) break;
				if (this.suppressed.has(state.id)) continue;
				if (state.status === "ready" && this.active.has(state.id)) continue;
				if (await this.prepareOne(state.id, epoch)) prepared.push(state.id);
			}
			await Promise.all(
				prepared
					.filter(
						(id) =>
							!this.shuttingDown &&
							epoch === this.stopEpoch &&
							!this.suppressed.has(id),
					)
					.map((id) => this.launchOne(id, epoch)),
			);
			const ready = this.states.filter((state) => state.status === "ready").length;
			const failed = this.states.filter((state) => state.status === "failed").length;
			const stopped = this.states.filter(
				(state) => state.status === "stopped",
			).length;
			this.systemLog(
				META_TEMPLATE_ID,
				`Run summary: ${ready} ready, ${failed} failed, ${stopped} stopped.`,
			);
		});
	}

	startTemplate(id: string): Promise<void> {
		this.suppressed.delete(id);
		const epoch = this.stopEpoch;
		return this.enqueue(async () => {
			await this.initialize();
			await this.stopOne(id, false);
			if (!this.shuttingDown && epoch === this.stopEpoch) {
				if (await this.prepareOne(id, epoch)) await this.launchOne(id, epoch);
			}
		});
	}

	async stopTemplate(id: string): Promise<void> {
		this.suppressed.add(id);
		await this.initialize();
		await this.stopOne(id, true);
	}

	async stopAll(): Promise<void> {
		this.stopEpoch += 1;
		await this.initialize();
		for (const state of this.states) this.suppressed.add(state.id);
		await Promise.all(this.states.map((state) => this.stopOne(state.id, true)));
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await this.stopAll();
	}

	shutdownImmediately(): void {
		this.shuttingDown = true;
		this.stopEpoch += 1;
		for (const active of this.active.values()) {
			active.intentionalStop = true;
			active.process.terminateImmediately();
		}
	}

	whenIdle(): Promise<void> {
		return this.queue;
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const scheduled = this.queue.then(task, task);
		this.queue = scheduled.catch((error: unknown) => {
			this.systemLog(
				META_TEMPLATE_ID,
				`Orchestration error: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		return scheduled;
	}

	private stateFor(id: string): TemplateState {
		const state = this.states.find((candidate) => candidate.id === id);
		if (!state) throw new Error(`unknown template ${id}`);
		return state;
	}

	private update(
		state: TemplateState,
		status: TemplateStatus,
		detail: string,
		lastError?: string,
	): void {
		state.status = status;
		state.detail = detail;
		state.lastError = lastError;
		this.emitSnapshot();
	}

	private async prepareOne(id: string, epoch: number): Promise<boolean> {
		const state = this.stateFor(id);
		if (
			this.shuttingDown ||
			epoch !== this.stopEpoch ||
			this.suppressed.has(id)
		) {
			this.update(state, "stopped", "Skipped");
			return false;
		}
		this.preparedProjects.delete(id);
		this.beginAttempt(state);

		const directory = state.directory!;
		let needsMaterialization = !(await this.runtime.isMaterialized(directory));
		if (!needsMaterialization) {
			const stale = await this.staleReason(directory);
			if (stale) {
				this.systemLog(id, `Reinstalling ${directory}: ${stale}`);
				try {
					await this.runtime.removeDirectory(directory);
				} catch (error) {
					this.fail(state, `Could not remove the stale project: ${String(error)}`);
					return false;
				}
				needsMaterialization = true;
			} else {
				this.systemLog(id, `Reusing ${directory}`);
			}
		}
		if (needsMaterialization) {
			this.update(state, "downloading", `Downloading ${this.channel} template`);
			this.systemLog(id, `Materializing ${directory}`);
			let initProcess: ManagedProcess;
			try {
				initProcess = this.runtime.spawn({
					kind: "init",
					templateId: id,
					command: this.hutchExecutable,
					args: [
						"electrobun",
						"init",
						id,
						`--template=${id}`,
						`--channel=${this.channel}`,
						"--skip-install",
					],
					cwd: this.runRoot,
				});
			} catch (error) {
				this.fail(state, `Could not start template installer: ${String(error)}`);
				return false;
			}
			const active: ActiveProcess = {
				process: initProcess,
				phase: "init",
				intentionalStop: false,
			};
			this.active.set(id, active);
			let sawOutput = false;
			initProcess.onOutput((stream, text) => {
				this.appendOutput(id, stream, text);
				if (!sawOutput) {
					sawOutput = true;
					this.update(state, "installing", "Extracting and preparing project");
				}
			});
			const result = await initProcess.completed;
			if (this.active.get(id) === active) this.active.delete(id);
			if (
				active.intentionalStop ||
				this.shuttingDown ||
				epoch !== this.stopEpoch ||
				this.suppressed.has(id)
			) {
				this.finishAttempt(state, "stopped");
				this.update(state, "stopped", "Stopped during installation");
				return false;
			}
			if (result.code !== 0 || result.error) {
				this.fail(state, `Template install ${resultDescription(result)}`);
				return false;
			}
			if (!(await this.runtime.isMaterialized(directory))) {
				this.fail(
					state,
					"Template installer completed without creating electrobun.config.ts",
				);
				return false;
			}
		}

		let inspection: ProjectInspection;
		try {
			inspection = await this.runtime.inspectProject(directory);
		} catch (error) {
			this.fail(state, `Could not inspect installed project: ${String(error)}`);
			return false;
		}
		if (inspection.configuredElectrobunVersion !== this.catalog!.version) {
			this.fail(
				state,
				`Expected the hutch.config.ts product pin to be Electrobun ${this.catalog!.version}, found ${inspection.configuredElectrobunVersion ?? "no exact electrobun.version"}`,
			);
			return false;
		}
		if (inspection.projectedElectrobunVersion !== this.catalog!.version) {
			this.fail(
				state,
				`Expected a project-local Electrobun ${this.catalog!.version} devkit projection at ${inspection.devkitProjectionPath}, found ${inspection.projectedElectrobunVersion ?? "no valid projection"}`,
			);
			return false;
		}
		this.systemLog(
			id,
			`Verified project-local Electrobun ${inspection.projectedElectrobunVersion} devkit projection`,
		);

		if (inspection.hasInstallTask) {
			this.update(state, "installing", "Running configured install task");
			const installResult = await this.runFiniteCommand(state, epoch, {
				kind: "install",
				templateId: id,
				command: this.hutchExecutable,
				args: ["run", "install"],
				cwd: directory,
			});
			if (!installResult) return false;
		}

		if (
			this.shuttingDown ||
			epoch !== this.stopEpoch ||
			this.suppressed.has(id)
		) {
			this.finishAttempt(state, "stopped");
			this.update(state, "stopped", "Stopped before launch");
			return false;
		}

		this.update(state, "starting", "Building production app");
		const buildResult = await this.runFiniteCommand(
			state,
			epoch,
			{
				kind: "build",
				templateId: id,
				command: this.hutchExecutable,
				args: ["run", "build"],
				cwd: directory,
			},
			BUILD_READY_MARKER,
		);
		if (!buildResult) return false;
		this.preparedProjects.add(id);
		this.update(state, "starting", "Prepared; waiting for the launch phase");
		this.systemLog(id, "Production build prepared");
		return true;
	}

	// A reused project directory must match the catalog identity exactly;
	// anything else is a leftover from an earlier Electrobun version and gets
	// wiped and re-materialized instead of failing the run.
	private async staleReason(directory: string): Promise<string | null> {
		const version = this.catalog!.version;
		let inspection: ProjectInspection;
		try {
			inspection = await this.runtime.inspectProject(directory);
		} catch (error) {
			return `the existing project could not be inspected (${String(error)})`;
		}
		if (inspection.configuredElectrobunVersion !== version) {
			return `the existing project pins Electrobun ${inspection.configuredElectrobunVersion ?? "nothing"} instead of ${version}`;
		}
		if (inspection.projectedElectrobunVersion !== version) {
			return `the existing project projects Electrobun ${inspection.projectedElectrobunVersion ?? "nothing"} instead of ${version}`;
		}
		return null;
	}

	private async launchOne(id: string, epoch: number): Promise<void> {
		const state = this.stateFor(id);
		if (!this.preparedProjects.has(id)) {
			this.fail(state, "Prepared project marker is missing");
			return;
		}
		if (
			this.shuttingDown ||
			epoch !== this.stopEpoch ||
			this.suppressed.has(id)
		) {
			this.finishAttempt(state, "stopped");
			this.update(state, "stopped", "Stopped before launch");
			return;
		}

		this.update(state, "starting", "Launching prepared app");
		this.systemLog(id, "Starting hutch electrobun run");
		let runProcess: ManagedProcess;
		try {
			runProcess = this.runtime.spawn({
				kind: "run",
				templateId: id,
				command: this.hutchExecutable,
				args: ["electrobun", "run", "--env=production"],
				cwd: state.directory!,
			});
		} catch (error) {
			this.fail(state, `Could not start app process: ${String(error)}`);
			return;
		}
		const active: ActiveProcess = {
			process: runProcess,
			phase: "run",
			intentionalStop: false,
		};
		this.active.set(id, active);

		let outputTail = "";
		let sawSpawnedProcess = false;
		let signalReady: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			signalReady = resolve;
		});
		runProcess.onOutput((stream, text) => {
			this.appendOutput(id, stream, text);
			sawSpawnedProcess ||= outputContainsSpawnedProcess(outputTail, text);
			if (sawSpawnedProcess) signalReady?.();
			outputTail = `${outputTail}${text}`.slice(
				-Math.max(BUILD_READY_MARKER.length, PROCESS_SPAWNED_MARKER.length) * 2,
			);
		});

		const outcome = await Promise.race([
			ready.then(() => ({ type: "ready" as const })),
			runProcess.completed.then((result) => ({
				type: "exit" as const,
				result,
			})),
			this.runtime
				.sleep(this.readinessTimeoutMs)
				.then(() => ({ type: "timeout" as const })),
		]);

		if (outcome.type === "exit") {
			if (this.active.get(id) === active) this.active.delete(id);
			if (active.intentionalStop || this.suppressed.has(id)) {
				this.finishAttempt(state, "stopped");
				this.update(state, "stopped", "Stopped");
			} else {
				this.fail(state, `App process ${resultDescription(outcome.result)} before launch`);
			}
			return;
		}
		if (outcome.type === "timeout") {
			active.intentionalStop = true;
			await runProcess.terminate();
			if (this.active.get(id) === active) this.active.delete(id);
			this.fail(
				state,
				`Timed out waiting for ${JSON.stringify(PROCESS_SPAWNED_MARKER)}`,
			);
			return;
		}

		const survival = await Promise.race([
			this.runtime.sleep(this.settleMs).then(() => ({ type: "survived" as const })),
			runProcess.completed.then((result) => ({
				type: "exit" as const,
				result,
			})),
		]);
		if (survival.type === "exit") {
			if (this.active.get(id) === active) this.active.delete(id);
			if (active.intentionalStop || this.suppressed.has(id)) {
				this.finishAttempt(state, "stopped");
				this.update(state, "stopped", "Stopped");
			} else {
				this.fail(
					state,
					`App process ${resultDescription(survival.result)} during launch grace period`,
				);
			}
			return;
		}
		if (
			active.intentionalStop ||
			this.shuttingDown ||
			epoch !== this.stopEpoch ||
			this.suppressed.has(id)
		) {
			await runProcess.terminate();
			if (this.active.get(id) === active) this.active.delete(id);
			this.finishAttempt(state, "stopped");
			this.update(state, "stopped", "Stopped during launch");
			return;
		}

		const passedAfterRetry = state.attempts
			.slice(0, -1)
			.some((attempt) => attempt.outcome === "failed");
		state.readyAfterRetry = passedAfterRetry;
		this.markAttemptReady(state);
		this.update(
			state,
			"ready",
			passedAfterRetry
				? "Passed after retry — build complete; app launched"
				: "Build complete; app launched",
		);
		this.systemLog(id, "Ready — keeping the app process alive");
		void runProcess.completed.then((result) => {
			if (this.active.get(id) !== active) return;
			this.active.delete(id);
			if (active.intentionalStop || this.suppressed.has(id)) {
				this.finishAttempt(state, "stopped");
				this.update(state, "stopped", "Stopped");
			} else if (result.code === 0 && !result.error) {
				this.finishAttempt(state, "stopped");
				this.update(state, "stopped", "App closed");
			} else {
				this.fail(state, `App process ${resultDescription(result)}`);
			}
		});
	}

	private async runFiniteCommand(
		state: TemplateState,
		epoch: number,
		spec: CommandSpec,
		requiredOutputMarker?: string,
	): Promise<boolean> {
		this.systemLog(
			state.id,
			`Running ${[spec.command, ...spec.args].join(" ")}`,
		);
		let process: ManagedProcess;
		try {
			process = this.runtime.spawn(spec);
		} catch (error) {
			this.fail(state, `Could not start ${spec.kind}: ${String(error)}`);
			return false;
		}
		const active: ActiveProcess = {
			process,
			phase: spec.kind,
			intentionalStop: false,
		};
		this.active.set(state.id, active);
		let outputTail = "";
		let sawRequiredOutput = requiredOutputMarker === undefined;
		process.onOutput((stream, text) => {
			this.appendOutput(state.id, stream, text);
			if (
				requiredOutputMarker &&
				`${outputTail}${text}`.includes(requiredOutputMarker)
			) {
				sawRequiredOutput = true;
			}
			outputTail = `${outputTail}${text}`.slice(
				-(requiredOutputMarker?.length ?? 64) * 2,
			);
		});
		const result = await process.completed;
		if (this.active.get(state.id) === active) this.active.delete(state.id);
		if (
			active.intentionalStop ||
			this.shuttingDown ||
			epoch !== this.stopEpoch ||
			this.suppressed.has(state.id)
		) {
			this.finishAttempt(state, "stopped");
			this.update(state, "stopped", `Stopped during ${spec.kind}`);
			return false;
		}
		if (result.code !== 0 || result.error) {
			this.fail(state, `${spec.kind} ${resultDescription(result)}`);
			return false;
		}
		if (!sawRequiredOutput) {
			this.fail(
				state,
				`${spec.kind} completed without ${JSON.stringify(requiredOutputMarker)}`,
			);
			return false;
		}
		return true;
	}

	private async stopOne(id: string, showTransition: boolean): Promise<void> {
		const state = this.states.find((candidate) => candidate.id === id);
		if (!state) return;
		const active = this.active.get(id);
		if (!active) {
			if (showTransition && state.status !== "failed") {
				this.finishAttempt(state, "stopped");
				this.update(state, "stopped", "Stopped");
			}
			return;
		}
		active.intentionalStop = true;
		if (showTransition) this.update(state, "stopping", `Stopping ${active.phase}`);
		await active.process.terminate();
		if (this.active.get(id) === active) this.active.delete(id);
		this.preparedProjects.delete(id);
		this.finishAttempt(state, "stopped");
		this.update(state, "stopped", "Stopped");
	}

	private fail(state: TemplateState, message: string): void {
		this.appendLog(state.id, "system", `FAILED: ${message}`);
		this.finishAttempt(state, "failed", message);
		this.update(state, "failed", message, message);
	}

	private beginAttempt(state: TemplateState): void {
		const startedAt = this.runtime.now().toISOString();
		state.attemptCount += 1;
		state.lastAttemptStartedAt = startedAt;
		state.readyAfterRetry = false;
		state.lastError = undefined;
		state.attempts.push({
			number: state.attemptCount,
			startedAt,
			outcome: "running",
		});
		this.systemLog(state.id, `Attempt ${state.attemptCount} started`);
		this.emitSnapshot();
	}

	private markAttemptReady(state: TemplateState): void {
		const attempt = state.attempts.at(-1);
		if (!attempt) return;
		attempt.outcome = "ready";
		attempt.readyAt = this.runtime.now().toISOString();
	}

	private finishAttempt(
		state: TemplateState,
		outcome: "failed" | "stopped",
		error?: string,
	): void {
		const attempt = state.attempts.at(-1);
		if (!attempt) return;
		// A clean stop after readiness must not erase the fact that this attempt
		// passed its build-and-launch gate.
		if (attempt.outcome !== "ready" || outcome === "failed") {
			attempt.outcome = outcome;
		}
		attempt.endedAt = this.runtime.now().toISOString();
		if (error) attempt.error = error;
	}

	private appendOutput(
		templateId: string,
		stream: "stdout" | "stderr",
		text: string,
	): void {
		const normalized = text.replace(/\r\n/g, "\n");
		for (const chunk of normalized.match(/[^\n]*\n|[^\n]+/g) ?? []) {
			this.appendLog(templateId, stream, chunk.slice(0, 32_768));
		}
	}

	private systemLog(templateId: string, text: string): void {
		this.appendLog(templateId, "system", `${text}\n`);
	}

	private appendLog(
		templateId: string,
		stream: LogStream,
		text: string,
	): void {
		const entry: QaLog = {
			sequence: ++this.sequence,
			templateId,
			attempt:
				this.states.find((state) => state.id === templateId)?.attemptCount ?? 0,
			stream,
			text,
			timestamp: this.runtime.now().toISOString(),
		};
		this.logs.push(entry);
		this.onLog?.({ ...entry });
	}

	private emitSnapshot(): void {
		this.onSnapshot?.(this.getSnapshot());
	}
}
