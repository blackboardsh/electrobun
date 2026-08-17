import { join } from "node:path";

export const META_TEMPLATE_ID = "all";
export const HUTCH_STORE_TEMPLATE_ID = "hutch-store";
export const PROCESS_SPAWNED_MARKER = "Child process spawned with PID";

const STRICT_SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export type TemplateStatus =
	| "pending"
	| "downloading"
	| "installing"
	| "prepared"
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
	kind: "init" | "install" | "run" | "status" | "prune";
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
	nestedHutchEnv?: Record<string, string>;
	readinessTimeoutMs?: number;
	settleMs?: number;
	onSnapshot?: (snapshot: QaSnapshot) => void;
	onLog?: (log: QaLog) => void;
};

type ActiveProcess = {
	process: ManagedProcess;
	phase: CommandSpec["kind"];
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

export type HutchStatusSummary = {
	homePath: string;
	homeSource: string;
	productCount: number;
	productInstallCount: number;
	productsBytes: number;
	toolchainCount: number;
	toolchainsBytes: number;
	cacheObjectCount: number;
	cacheBytes: number;
	prunableObjectCount: number;
	totalBytes: number;
	issueCount: number;
};

export type HutchStoreStatus =
	| { ok: true; summary: HutchStatusSummary }
	| { ok: false; message: string };

function optionalNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

function optionalRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function optionalArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

// Tolerates unknown extra fields and missing optional sections so a newer hutch
// payload still renders; only the document identity is required.
export function parseHutchStatus(value: unknown): HutchStatusSummary {
	const root = optionalRecord(value);
	if (root.kind !== "hutch-status") {
		throw new Error("hutch status returned an unrecognized document");
	}
	const home = optionalRecord(root.home);
	const products = optionalArray(root.products);
	const toolchains = optionalArray(root.toolchains);
	const cache = optionalRecord(root.cache);
	const cacheObjects = optionalArray(cache.objects);
	const totals = optionalRecord(root.totals);

	const productsBytes = totals.productsBytes
		? optionalNumber(totals.productsBytes)
		: products.reduce<number>(
				(sum, entry) => sum + optionalNumber(optionalRecord(entry).bytes),
				0,
			);
	const toolchainsBytes = totals.toolchainsBytes
		? optionalNumber(totals.toolchainsBytes)
		: toolchains.reduce<number>(
				(sum, entry) => sum + optionalNumber(optionalRecord(entry).bytes),
				0,
			);
	const cacheBytes = totals.cacheBytes
		? optionalNumber(totals.cacheBytes)
		: optionalNumber(cache.bytes);

	return {
		homePath: typeof home.path === "string" ? home.path : "unknown",
		homeSource: typeof home.source === "string" ? home.source : "unknown",
		productCount: products.length,
		productInstallCount: products.reduce<number>(
			(sum, entry) => sum + optionalArray(optionalRecord(entry).installs).length,
			0,
		),
		productsBytes,
		toolchainCount: toolchains.length,
		toolchainsBytes,
		cacheObjectCount: cache.objectCount
			? optionalNumber(cache.objectCount)
			: cacheObjects.length,
		cacheBytes,
		prunableObjectCount: cacheObjects.filter((entry) => {
			const object = optionalRecord(entry);
			return object.reachable === false && object.inUse !== true;
		}).length,
		totalBytes: totals.bytes
			? optionalNumber(totals.bytes)
			: productsBytes + toolchainsBytes,
		issueCount: optionalArray(root.issues).length,
	};
}

export function parseHutchStatusDocument(stdout: string): unknown {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("hutch status did not return JSON");
	}
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		throw new Error("hutch status returned output that is not valid JSON");
	}
}

export function parseHutchStatusOutput(stdout: string): HutchStatusSummary {
	return parseHutchStatus(parseHutchStatusDocument(stdout));
}

export function hutchPlatformForHost(platform: string, arch: string): string {
	const os =
		platform === "darwin"
			? "macos"
			: platform === "win32"
				? "windows"
				: platform === "linux"
					? "linux"
					: null;
	if (!os || (arch !== "arm64" && arch !== "x64")) {
		throw new Error(`unsupported Hutch host platform ${platform}-${arch}`);
	}
	return `${os}-${arch}`;
}

export function resolveElectrobunDevkitRootFromHutchStatusOutput(
	stdout: string,
	expectedVersion: string,
	expectedPlatform: string,
): string {
	const root = requireRecord(parseHutchStatusDocument(stdout), "hutch status");
	if (root.kind !== "hutch-status") {
		throw new Error("hutch status returned an unrecognized document");
	}
	for (const releaseValue of optionalArray(root.releases)) {
		const release = optionalRecord(releaseValue);
		if (release.name !== "electrobun") continue;
		for (const installValue of optionalArray(release.installs)) {
			const install = optionalRecord(installValue);
			if (
				install.version === expectedVersion &&
				install.platform === expectedPlatform &&
				typeof install.path === "string" &&
				install.path.length > 0
			) {
				return install.path;
			}
		}
	}
	throw new Error(
		`hutch status does not list Electrobun ${expectedVersion} for ${expectedPlatform}`,
	);
}

export function describeHutchStatusFailure(
	stderr: string,
	fallback: string,
): string {
	const detail =
		stderr
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? fallback;
	return `Status unavailable — this hutch may predate \`hutch status --json\` (0.7+). ${detail}`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${BYTE_UNITS[unit]}`;
}

// Hutch prints download/toolchain progress notices to stderr per CLI
// convention. In the QA log they read as failures, so show them as regular
// output. Deliberately narrow: real "hutch electrobun:" errors stay stderr.
const HUTCH_PROGRESS_LINE = /^hutch: (downloading|verifying|installing|resolving) /;

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
	private readonly nestedHutchEnv?: Record<string, string>;
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
	private pruning = false;
	private readonly suppressed = new Set<string>();
	private readonly active = new Map<string, ActiveProcess>();
	private readonly preparedProjects = new Set<string>();

	constructor(runtime: QaRuntime, options: OrchestratorOptions) {
		this.runtime = runtime;
		this.projectRoot = options.projectRoot;
		this.channel = options.channel;
		this.hutchExecutable = options.hutchExecutable ?? "hutch";
		this.nestedHutchEnv = options.nestedHutchEnv
			? { ...options.nestedHutchEnv }
			: undefined;
		this.readinessTimeoutMs = options.readinessTimeoutMs ?? 15 * 60_000;
		this.settleMs = options.settleMs ?? 1_000;
		this.onSnapshot = options.onSnapshot;
		this.onLog = options.onLog;
	}

	async initialize(): Promise<void> {
		if (!this.initialization) {
			// A failed catalog load must not poison every later action.
			this.initialization = this.initializeOnce().catch((error: unknown) => {
				this.initialization = null;
				throw error;
			});
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

	// Install only: materialize the project and run its install task.
	installTemplate(id: string): Promise<void> {
		this.suppressed.delete(id);
		const epoch = this.stopEpoch;
		return this.enqueue(async () => {
			await this.initialize();
			await this.stopOne(id, false);
			if (this.shuttingDown || epoch !== this.stopEpoch) return;
			if (await this.prepareOne(id, epoch)) {
				this.systemLog(id, "Installed — press Launch to run the app");
			}
		});
	}

	// Launch the installed project, installing first when nothing is on disk.
	launchTemplate(id: string): Promise<void> {
		this.suppressed.delete(id);
		const epoch = this.stopEpoch;
		return this.enqueue(async () => {
			await this.initialize();
			await this.stopOne(id, false);
			if (this.shuttingDown || epoch !== this.stopEpoch) return;
			if (this.preparedProjects.has(id) || (await this.prepareOne(id, epoch))) {
				await this.launchOne(id, epoch);
			}
		});
	}

	startTemplate(id: string): Promise<void> {
		return this.launchTemplate(id);
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

	async readHutchStatus(): Promise<HutchStoreStatus> {
		let process: ManagedProcess;
		try {
			process = this.runtime.spawn({
				kind: "status",
				templateId: HUTCH_STORE_TEMPLATE_ID,
				command: this.hutchExecutable,
				args: ["status", "--json"],
				cwd: this.projectRoot,
			});
		} catch (error) {
			return {
				ok: false,
				message: `Status unavailable — could not start hutch: ${String(error)}`,
			};
		}
		let stdout = "";
		let stderr = "";
		process.onOutput((stream, text) => {
			if (stream === "stdout") stdout += text;
			else stderr += text;
		});
		const result = await process.completed;
		if (result.code !== 0 || result.error) {
			return {
				ok: false,
				message: describeHutchStatusFailure(
					stderr,
					`hutch status ${resultDescription(result)}`,
				),
			};
		}
		try {
			return { ok: true, summary: parseHutchStatusOutput(stdout) };
		} catch (error) {
			return {
				ok: false,
				message: describeHutchStatusFailure(
					stderr,
					error instanceof Error ? error.message : String(error),
				),
			};
		}
	}

	async pruneHutchCache(dryRun: boolean): Promise<boolean> {
		if (this.pruning) {
			this.systemLog(HUTCH_STORE_TEMPLATE_ID, "A prune is already running.");
			return false;
		}
		this.pruning = true;
		const label = dryRun ? "Prune preview" : "Prune";
		try {
			const args = ["cache", "prune"];
			if (dryRun) args.push("--dry-run");
			this.systemLog(
				HUTCH_STORE_TEMPLATE_ID,
				`Running ${[this.hutchExecutable, ...args].join(" ")}`,
			);
			let process: ManagedProcess;
			try {
				process = this.runtime.spawn({
					kind: "prune",
					templateId: HUTCH_STORE_TEMPLATE_ID,
					command: this.hutchExecutable,
					args,
					cwd: this.projectRoot,
				});
			} catch (error) {
				this.systemLog(
					HUTCH_STORE_TEMPLATE_ID,
					`${label} could not start: ${String(error)}`,
				);
				return false;
			}
			process.onOutput((stream, text) => {
				this.appendOutput(HUTCH_STORE_TEMPLATE_ID, stream, text);
			});
			const result = await process.completed;
			const succeeded = result.code === 0 && !result.error;
			this.systemLog(
				HUTCH_STORE_TEMPLATE_ID,
				succeeded ? `${label} finished.` : `${label} ${resultDescription(result)}`,
			);
			return succeeded;
		} finally {
			this.pruning = false;
		}
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
					env: this.nestedHutchEnv,
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
				env: this.nestedHutchEnv,
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

		this.preparedProjects.add(id);
		this.update(state, "prepared", "Installed; ready to launch");
		this.systemLog(id, "Install complete");
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
			this.fail(state, "Installed project marker is missing");
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

		// `hutch run start` is exactly what a new user runs; the dev build happens
		// inside it, so the first launch can take a while.
		this.update(state, "starting", "Building and launching (dev)…");
		this.systemLog(id, "Starting hutch run start");
		let runProcess: ManagedProcess;
		try {
			runProcess = this.runtime.spawn({
				kind: "run",
				templateId: id,
				command: this.hutchExecutable,
				args: ["run", "start"],
				cwd: state.directory!,
				env: this.nestedHutchEnv,
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
				-PROCESS_SPAWNED_MARKER.length * 2,
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
				? "Passed after retry — dev app launched"
				: "Dev app launched",
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
		process.onOutput((stream, text) => {
			this.appendOutput(state.id, stream, text);
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
			this.appendLog(
				templateId,
				stream === "stderr" && HUTCH_PROGRESS_LINE.test(chunk)
					? "stdout"
					: stream,
				chunk.slice(0, 32_768),
			);
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
