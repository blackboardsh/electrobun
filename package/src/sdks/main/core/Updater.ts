import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	createReadStream,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	opendirSync,
	readSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
	win32,
} from "node:path";
import {
	getPatchFileUrl,
	getPlatformPrefix,
	isBuildEnvironment,
	type BuildEnvironment,
} from "../../../shared/naming";
import {
	ARCH as currentArch,
	OS as currentOS,
	type SupportedArch,
	type SupportedOS,
} from "../../../shared/platform";
import {
	cancelQuitApproval,
	quitAfterApproval,
	requestQuitApproval,
} from "./Utils";
import {
	createWindowsUpdateTaskName,
	createWindowsUpdateTaskPlan,
	executeWindowsUpdateTaskPlan,
} from "./WindowsUpdateTask";

// Keep the established status names source-compatible across multi-hop patch
// preparation and full-bundle fallback.
export type UpdateStatusType =
	| "idle"
	| "checking"
	| "check-complete"
	| "no-update"
	| "update-available"
	| "downloading"
	| "download-starting"
	| "checking-local-tar"
	| "local-tar-found"
	| "local-tar-missing"
	| "fetching-patch"
	| "patch-found"
	| "patch-not-found"
	| "downloading-patch"
	| "applying-patch"
	| "patch-applied"
	| "patch-failed"
	| "extracting-version"
	| "patch-chain-complete"
	| "downloading-full-bundle"
	| "download-progress"
	| "decompressing"
	| "download-complete"
	| "applying"
	| "extracting"
	| "replacing-app"
	| "launching-new-version"
	| "complete"
	| "error";

export interface UpdateStatusDetails {
	fromHash?: string;
	toHash?: string;
	currentHash?: string;
	latestHash?: string;
	patchNumber?: number;
	totalPatchesApplied?: number;
	progress?: number;
	bytesDownloaded?: number;
	totalBytes?: number;
	usedPatchPath?: boolean;
	errorMessage?: string;
	url?: string;
	zstdPath?: string;
	exitCode?: number | null;
}

export interface UpdateStatusEntry {
	status: UpdateStatusType;
	message: string;
	timestamp: number;
	details?: UpdateStatusDetails;
}

export interface LocalUpdateInfo {
	version: string;
	hash: string;
	baseUrl: string;
	channel: string;
	name: string;
	displayName?: string;
	identifier: string;
}

export interface UpdateInfo {
	version: string;
	hash: string;
	updateAvailable: boolean;
	updateReady: boolean;
	error: string;
}

export interface UpdateArtifactV1 {
	file: string;
}

export interface UpdateManifestV1 {
	schemaVersion: 1;
	identifier: string;
	channel: string;
	version: string;
	hash: string;
	platform: SupportedOS;
	arch: SupportedArch;
	artifact: UpdateArtifactV1;
}

export interface PreparedUpdateV1 {
	schema_version: 1;
	identifier: string;
	channel: string;
	version: string;
	hash: string;
	platform: SupportedOS;
	arch: SupportedArch;
	retained_tar_path: string;
	artifact_file: string;
}

export interface NativeUpdatePlanV1 {
	schema_version: 1;
	transaction_id: string;
	identifier: string;
	channel: string;
	platform: SupportedOS;
	arch: SupportedArch;
	version: string;
	hash: string;
	channel_root: string;
	app_bundle_path: string;
	retained_tar_path: string;
	parent_pid: number;
	result_path: string;
}

export interface NativeUpdateResultV1 {
	schema_version: 1;
	transaction_id: string;
	success: boolean;
	phase:
		| "validating"
		| "waiting_for_parent"
		| "extracting"
		| "validating_payload"
		| "swapping"
		| "integrating"
		| "launching"
		| "complete";
	message: string;
	identifier: string;
	channel: string;
	version: string;
	hash: string;
}

export interface NativeUpdateResultCandidate {
	path: string;
	modifiedAt: number;
	result: NativeUpdateResultV1;
}

export interface NativeUpdateResultScan {
	candidates: NativeUpdateResultCandidate[];
	selected?: NativeUpdateResultCandidate;
	truncated: boolean;
}

export interface ReconciledNativeUpdateResult {
	updateInfo: UpdateInfo;
	status: "complete" | "error";
	message: string;
	details: UpdateStatusDetails;
}

interface ManifestExpectation {
	identifier: string;
	channel: string;
	platform: SupportedOS;
	arch: SupportedArch;
}

const MAX_UPDATE_DOCUMENT_BYTES = 1024 * 1024;
const SAFE_HASH_PATTERN = /^[a-z0-9]{1,13}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;
const MAX_TAR_EXTENSION_BYTES = 64 * 1024;
const PREPARED_UPDATE_FILE = ".electrobun-prepared-update.json";
const OBSERVED_UPDATE_RESULT_FILE = ".electrobun-observed-update-result.json";
const UPDATE_RESULT_FILE_PATTERN =
	/^\.electrobun-update-([a-f0-9]{32})\.result\.json$/;
const UPDATE_RESULT_PHASES = new Set<NativeUpdateResultV1["phase"]>([
	"validating",
	"waiting_for_parent",
	"extracting",
	"validating_payload",
	"swapping",
	"integrating",
	"launching",
	"complete",
]);
const UPDATE_RESULT_FIELDS = [
	"channel",
	"hash",
	"identifier",
	"message",
	"phase",
	"schema_version",
	"success",
	"transaction_id",
	"version",
] as const;
const MAX_UPDATE_RESULT_BYTES = 64 * 1024;
const MAX_UPDATE_RESULT_DIRECTORY_ENTRIES = 1024;
const MAX_UPDATE_RESULT_FILES = 64;
const UPDATE_RESULT_POLL_ATTEMPTS = 40;
const UPDATE_RESULT_POLL_INTERVAL_MS = 50;
const DOWNLOAD_PROGRESS_MIN_BYTES = 256 * 1024;
const DOWNLOAD_PROGRESS_MIN_INTERVAL_MS = 250;

export interface DownloadProgressThrottleState {
	lastBytes: number;
	lastPercent: number;
	lastTimestamp: number;
}

export function createDownloadProgressThrottleState(): DownloadProgressThrottleState {
	return { lastBytes: 0, lastPercent: -1, lastTimestamp: 0 };
}

/**
 * Return the next bounded progress percentage, or null when this chunk should
 * not produce a status entry. Non-final progress is capped at 99 so a corrupt
 * response never reports 100%; the caller forces 100 only after the complete
 * response has been durably written.
 */
export function nextDownloadProgressPercent(
	state: DownloadProgressThrottleState,
	bytesDownloaded: number,
	totalBytes: number,
	now: number,
	complete = false,
): number | null {
	if (complete) {
		if (state.lastPercent === 100) return null;
		state.lastBytes = bytesDownloaded;
		state.lastPercent = 100;
		state.lastTimestamp = now;
		return 100;
	}
	if (
		!Number.isFinite(bytesDownloaded) ||
		!Number.isFinite(totalBytes) ||
		bytesDownloaded < 0 ||
		totalBytes <= 0
	) {
		return null;
	}
	const percent = Math.min(
		99,
		Math.max(0, Math.floor((bytesDownloaded / totalBytes) * 100)),
	);
	const first = state.lastPercent < 0;
	const advanced = percent > state.lastPercent;
	const enoughBytes =
		bytesDownloaded - state.lastBytes >= DOWNLOAD_PROGRESS_MIN_BYTES;
	const enoughTime =
		state.lastTimestamp === 0 ||
		now - state.lastTimestamp >= DOWNLOAD_PROGRESS_MIN_INTERVAL_MS;
	if (!first && (!advanced || (!enoughBytes && !enoughTime))) return null;
	state.lastBytes = bytesDownloaded;
	state.lastPercent = percent;
	state.lastTimestamp = now;
	return percent;
}

const statusHistory: UpdateStatusEntry[] = [];
let onStatusChangeCallback: ((entry: UpdateStatusEntry) => void) | null = null;

let localInfo: LocalUpdateInfo | undefined;
let updateInfo: UpdateInfo = {
	version: "",
	hash: "",
	updateAvailable: false,
	updateReady: false,
	error: "",
};
let checkedManifest: UpdateManifestV1 | undefined;
let checkInFlight: Promise<UpdateInfo> | undefined;
let downloadInFlight: Promise<void> | undefined;
let applyInFlight: Promise<void> | undefined;
let nativeResultReconciliation: Promise<void> | undefined;
let nativeResultReconciliationScheduled = false;
let reconciledNativeResultPath: string | undefined;

function emitStatus(
	status: UpdateStatusType,
	message: string,
	details?: UpdateStatusDetails,
): void {
	const entry: UpdateStatusEntry = {
		status,
		message,
		timestamp: Date.now(),
		details,
	};
	statusHistory.push(entry);
	onStatusChangeCallback?.(entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	record: Record<string, unknown>,
	key: string,
): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`Invalid update manifest: ${key} must be a string`);
	}
	return value;
}

function isSafeVersion(value: string): boolean {
	return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeIdentityComponent(
	value: string,
	platform: SupportedOS,
): boolean {
	if (value.length === 0 || value.length > 256 || value === "." || value === "..") {
		return false;
	}
	if (platform === "win") {
		return (
			!/[\u0000-\u001f"%*/:<>?\\|]/.test(value) &&
			!/[ .]$/.test(value)
		);
	}
	return platform === "macos"
		? !/[\u0000-\u001f\u007f/\\]/.test(value)
		: !/[\u0000-\u001f\u007f/]/.test(value);
}

function isSafeArtifactFileName(value: string): boolean {
	return (
		value.length > ".tar.zst".length &&
		value.length <= 1024 &&
		value.endsWith(".tar.zst") &&
		!/[\u0000-\u001f\u007f/\\:]/.test(value)
	);
}

/** Encode the manifest's single filename as one URL path segment. */
export function buildUpdateArtifactUrl(
	baseUrl: string,
	artifactFile: string,
): string {
	if (!isSafeArtifactFileName(artifactFile)) {
		throw new Error("Invalid update artifact filename");
	}
	return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(artifactFile)}`;
}

export function addUpdateArtifactCacheBuster(
	artifactUrl: string,
	transactionId: string,
): string {
	if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
		throw new Error("Invalid update transaction identifier");
	}
	return `${artifactUrl}?cache=${transactionId}`;
}

/** Validate the v2 update metadata before any artifact is fetched. */
export function validateUpdateManifest(
	document: unknown,
	expected: ManifestExpectation,
): UpdateManifestV1 {
	if (!isRecord(document) || document["schemaVersion"] !== 1) {
		throw new Error("Invalid update manifest: unsupported schemaVersion");
	}

	const identifier = requireString(document, "identifier");
	const channel = requireString(document, "channel");
	const version = requireString(document, "version");
	const hash = requireString(document, "hash");
	const platform = requireString(document, "platform");
	const arch = requireString(document, "arch");
	if (
		!isBuildEnvironment(channel) ||
		!isBuildEnvironment(expected.channel) ||
		identifier !== expected.identifier ||
		channel !== expected.channel ||
		platform !== expected.platform ||
		arch !== expected.arch
	) {
		throw new Error("Invalid update manifest: release identity does not match this app");
	}
	if (
		!isSafeIdentityComponent(identifier, expected.platform) ||
		!isSafeIdentityComponent(channel, expected.platform) ||
		!isSafeVersion(version) ||
		!SAFE_HASH_PATTERN.test(hash)
	) {
		throw new Error("Invalid update manifest: unsafe release metadata");
	}

	const artifactValue = document["artifact"];
	if (!isRecord(artifactValue)) {
		throw new Error("Invalid update manifest: artifact is required");
	}
	const file = requireString(artifactValue, "file");
	const requiredPrefix = `${getPlatformPrefix(channel, expected.platform, expected.arch)}-`;
	if (
		!isSafeArtifactFileName(file) ||
		!file.startsWith(requiredPrefix)
	) {
		throw new Error("Invalid update manifest: unsafe artifact filename");
	}

	return {
		schemaVersion: 1,
		identifier,
		channel,
		version,
		hash,
		platform: platform as SupportedOS,
		arch: arch as SupportedArch,
		artifact: { file },
	};
}

function getAppDataDir(): string {
	switch (currentOS) {
		case "macos":
			return join(homedir(), "Library", "Application Support");
		case "win":
			return process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local");
		case "linux": {
			const configured = process.env["XDG_DATA_HOME"];
			if (configured && isAbsolute(configured)) {
				const normalized = resolve(configured);
				if (normalized !== "/") return normalized;
			}
			return join(homedir(), ".local", "share");
		}
	}
}

function hasRegularFile(path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

/**
 * Resolve the installed channel root rather than reconstructing it from the v2
 * channel name. Early v1 releases used app-name roots and later v1 releases
 * used stable/canary roots; a delivered v2 app must retain the physical root
 * that already contains its updater state.
 */
export function resolveInstalledChannelRoot(
	info: LocalUpdateInfo,
	executablePath = process.execPath,
	appDataRoot = getAppDataDir(),
): string {
	return resolveInstalledChannelRootForPlatform(
		info,
		currentOS,
		executablePath,
		appDataRoot,
	);
}

export function resolveInstalledChannelRootForPlatform(
	info: LocalUpdateInfo,
	platform: SupportedOS,
	executablePath: string,
	appDataRoot: string,
	regularFileProbe: (path: string) => boolean = hasRegularFile,
): string {
	if (
		!isSafeIdentityComponent(info.identifier, platform) ||
		!isSafeIdentityComponent(info.channel, platform) ||
		!isBuildEnvironment(info.channel)
	) {
		throw new Error("The installed update identity is unsafe");
	}
	const pathApi = platform === "win" ? win32 : posix;
	const identifierRoot = pathApi.resolve(
		pathApi.join(appDataRoot, info.identifier),
	);
	if (platform !== "macos") {
		const derivedRoot = pathApi.resolve(
			pathApi.dirname(executablePath),
			"..",
			"..",
		);
		const derivedParent = pathApi.resolve(pathApi.dirname(derivedRoot));
		const normalizedParent =
			platform === "win" ? derivedParent.toLowerCase() : derivedParent;
		const normalizedIdentifierRoot =
			platform === "win" ? identifierRoot.toLowerCase() : identifierRoot;
		if (normalizedParent !== normalizedIdentifierRoot) {
			if (info.channel === "dev") {
				return pathApi.resolve(pathApi.join(identifierRoot, info.channel));
			}
			throw new Error(
				"The running application is outside its managed update directory",
			);
		}
		return derivedRoot;
	}

	const modernRoot = pathApi.resolve(pathApi.join(identifierRoot, info.channel));
	const candidates = [modernRoot];
	if (isSafeIdentityComponent(info.name, "macos")) {
		candidates.push(pathApi.resolve(pathApi.join(identifierRoot, info.name)));
	}
	// Early v1 macOS roots used CFBundleName (the developer-facing display
	// name), while version.json.name contained the sanitized artifact name.
	if (
		info.displayName &&
		isSafeIdentityComponent(info.displayName, "macos")
	) {
		const legacyDisplayRootName =
			info.channel === "stable"
				? info.displayName
				: `${info.displayName}-${info.channel}`;
		if (isSafeIdentityComponent(legacyDisplayRootName, "macos")) {
			candidates.push(
				pathApi.resolve(pathApi.join(identifierRoot, legacyDisplayRootName)),
			);
		}
	}
	const distinctCandidates = [...new Set(candidates)];
	const currentTarRoot = distinctCandidates.find((candidate) =>
		regularFileProbe(
			pathApi.join(candidate, "self-extraction", `${info.hash}.tar`),
		),
	);
	if (currentTarRoot) return currentTarRoot;
	const manifestRoot = distinctCandidates.find((candidate) =>
		regularFileProbe(pathApi.join(candidate, ".electrobun-uninstall.json")),
	);
	if (manifestRoot) return manifestRoot;
	return modernRoot;
}

function appDataFolderFor(info: LocalUpdateInfo): string {
	return resolveInstalledChannelRoot(info);
}

function extractionFolderFor(channelRoot: string): string {
	return join(channelRoot, "self-extraction");
}

function preparedUpdatePathFor(channelRoot: string): string {
	return join(extractionFolderFor(channelRoot), PREPARED_UPDATE_FILE);
}

function writeAll(fileDescriptor: number, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const written = writeSync(
			fileDescriptor,
			bytes,
			offset,
			bytes.byteLength - offset,
		);
		if (written <= 0) throw new Error("Failed to write update file");
		offset += written;
	}
}

export function publishFileReplacingRegular(
	sourcePath: string,
	destinationPath: string,
): void {
	const previousPath = `${destinationPath}.previous`;
	const destination = lstatSync(destinationPath, { throwIfNoEntry: false });
	const previous = lstatSync(previousPath, { throwIfNoEntry: false });
	if (
		(destination && (!destination.isFile() || destination.isSymbolicLink())) ||
		(previous && (!previous.isFile() || previous.isSymbolicLink()))
	) {
		throw new Error(`Refusing to replace unsafe update state: ${destinationPath}`);
	}

	// Recover a prior interrupted swap before beginning another one. If both
	// files exist, the published destination is authoritative and the prior
	// backup is stale.
	if (!destination && previous) renameSync(previousPath, destinationPath);
	else if (destination && previous) rmSync(previousPath, { force: true });

	const current = lstatSync(destinationPath, { throwIfNoEntry: false });
	if (current) renameSync(destinationPath, previousPath);
	try {
		renameSync(sourcePath, destinationPath);
	} catch (error) {
		if (current) renameSync(previousPath, destinationPath);
		throw error;
	}
	if (current) {
		try {
			rmSync(previousPath, { force: true });
		} catch {
			// The new destination is already committed. A stale plain backup is
			// harmless and will be recovered/cleaned by the next publication.
		}
	}
}

export function atomicWriteFile(path: string, contents: Uint8Array): void {
	const partialPath = `${path}.${randomBytes(8).toString("hex")}.partial`;
	let fileDescriptor: number | undefined;
	try {
		fileDescriptor = openSync(
			partialPath,
			"wx+",
			0o600,
		);
		writeAll(fileDescriptor, contents);
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		publishFileReplacingRegular(partialPath, path);
	} finally {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {}
		}
		rmSync(partialPath, { force: true });
	}
}

function atomicWriteJson(path: string, value: unknown): void {
	atomicWriteFile(path, new TextEncoder().encode(`${JSON.stringify(value)}\n`));
}

export function syncFile(path: string): void {
	// Cottontail's Windows fsync path requires a read/write handle. Opening an
	// otherwise valid update file read-only can surface EBADF at the durability
	// boundary even though the preceding write completed successfully.
	const fileDescriptor = openSync(path, fsConstants.O_RDWR);
	try {
		fsyncSync(fileDescriptor);
	} finally {
		closeSync(fileDescriptor);
	}
}

function requireRegularFile(path: string, description: string): void {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.isSymbolicLink()) {
		throw new Error(`${description} is missing or is not a regular file: ${path}`);
	}
}

function validatePreparedUpdate(
	document: unknown,
	info: LocalUpdateInfo,
	channelRoot: string,
): PreparedUpdateV1 {
	if (!isRecord(document) || document["schema_version"] !== 1) {
		throw new Error("Invalid prepared update record");
	}
	const identifier = requireString(document, "identifier");
	const channel = requireString(document, "channel");
	const version = requireString(document, "version");
	const hash = requireString(document, "hash");
	const platform = requireString(document, "platform");
	const arch = requireString(document, "arch");
	const retainedTarPath = requireString(document, "retained_tar_path");
	const artifactFile = requireString(document, "artifact_file");
	const expectedTarPath = resolve(
		join(extractionFolderFor(channelRoot), `${hash}.tar`),
	);
	if (
		identifier !== info.identifier ||
		channel !== info.channel ||
		!isBuildEnvironment(channel) ||
		platform !== currentOS ||
		arch !== currentArch ||
		!isSafeVersion(version) ||
		!SAFE_HASH_PATTERN.test(hash) ||
		resolve(retainedTarPath) !== retainedTarPath ||
		retainedTarPath !== expectedTarPath ||
		!isSafeArtifactFileName(artifactFile)
	) {
		throw new Error("Invalid prepared update record");
	}
	requireRegularFile(retainedTarPath, "Prepared update archive");
	return {
		schema_version: 1,
		identifier,
		channel,
		version,
		hash,
		platform: platform as SupportedOS,
		arch: arch as SupportedArch,
		retained_tar_path: retainedTarPath,
		artifact_file: artifactFile,
	};
}

function loadPreparedUpdate(
	info: LocalUpdateInfo,
	channelRoot: string,
): PreparedUpdateV1 {
	const recordPath = preparedUpdatePathFor(channelRoot);
	const stat = lstatSync(recordPath, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
		throw new Error("No valid prepared update is available");
	}
	return validatePreparedUpdate(
		JSON.parse(readFileSync(recordPath, "utf8")),
		info,
		channelRoot,
	);
}

function preparedMatchesManifest(
	prepared: PreparedUpdateV1,
	manifest: UpdateManifestV1,
): boolean {
	return (
		prepared.hash === manifest.hash &&
		prepared.version === manifest.version &&
		prepared.artifact_file === manifest.artifact.file
	);
}

function hasExactUpdateResultFields(document: Record<string, unknown>): boolean {
	const keys = Object.keys(document).sort();
	return (
		keys.length === UPDATE_RESULT_FIELDS.length &&
		UPDATE_RESULT_FIELDS.every((field, index) => keys[index] === field)
	);
}

/** Validate the native manager's durable result without trusting its filename. */
export function validateNativeUpdateResult(
	document: unknown,
	expectedTransactionId: string,
	info: LocalUpdateInfo,
): NativeUpdateResultV1 {
	if (
		!isRecord(document) ||
		!hasExactUpdateResultFields(document) ||
		document["schema_version"] !== 1 ||
		document["transaction_id"] !== expectedTransactionId ||
		!TRANSACTION_ID_PATTERN.test(expectedTransactionId) ||
		typeof document["success"] !== "boolean" ||
		typeof document["phase"] !== "string" ||
		!UPDATE_RESULT_PHASES.has(
			document["phase"] as NativeUpdateResultV1["phase"],
		) ||
		typeof document["message"] !== "string" ||
		document["message"].length === 0 ||
		document["message"].length > 4096 ||
		/[\u0000-\u001f\u007f]/.test(document["message"]) ||
		document["identifier"] !== info.identifier ||
		document["channel"] !== info.channel ||
		typeof document["version"] !== "string" ||
		!isSafeVersion(document["version"]) ||
		typeof document["hash"] !== "string" ||
		!SAFE_HASH_PATTERN.test(document["hash"])
	) {
		throw new Error("Invalid native update result");
	}
	const success = document["success"] as boolean;
	const phase = document["phase"] as NativeUpdateResultV1["phase"];
	if (success !== (phase === "complete")) {
		throw new Error("Invalid native update result phase");
	}
	return {
		schema_version: 1,
		transaction_id: expectedTransactionId,
		success,
		phase,
		message: document["message"] as string,
		identifier: info.identifier,
		channel: info.channel,
		version: document["version"] as string,
		hash: document["hash"] as string,
	};
}

export function reconcileNativeUpdateResultState(
	result: NativeUpdateResultV1,
	info: LocalUpdateInfo,
): ReconciledNativeUpdateResult {
	if (result.success) {
		return {
			updateInfo: {
				version: result.version,
				hash: result.hash,
				updateAvailable: false,
				updateReady: false,
				error: "",
			},
			status: "complete",
			message: `Update to ${result.version} completed successfully`,
			details: { currentHash: result.hash, latestHash: result.hash },
		};
	}
	const message = `Update to ${result.version} failed during ${result.phase}: ${result.message}`;
	return {
		updateInfo: {
			version: result.version,
			hash: result.hash,
			updateAvailable: result.hash !== info.hash,
			updateReady: false,
			error: message,
		},
		status: "error",
		message,
		details: {
			errorMessage: result.message,
			currentHash: info.hash,
			latestHash: result.hash,
		},
	};
}

function preparedUpdateForResult(
	info: LocalUpdateInfo,
	channelRoot: string,
): PreparedUpdateV1 | undefined {
	try {
		return loadPreparedUpdate(info, channelRoot);
	} catch {
		return undefined;
	}
}

function resultMatchesRunningState(
	result: NativeUpdateResultV1,
	info: LocalUpdateInfo,
): boolean {
	if (result.success) {
		return result.version === info.version && result.hash === info.hash;
	}
	// Invalid archives deliberately remove their prepared record before the old
	// application is relaunched. The validated result itself is the durable
	// transaction record in that case; a differing hash identifies it as a
	// failed target rather than a success for the running build.
	return result.hash !== info.hash;
}

/**
 * Inspect only a bounded number of plain, transaction-named files in the
 * resolved channel root. Structurally valid older results are returned so the
 * next handoff can prune them, while `selected` is relevant to this launch.
 */
export function scanNativeUpdateResults(
	info: LocalUpdateInfo,
	channelRoot: string,
): NativeUpdateResultScan {
	const empty = (): NativeUpdateResultScan => ({
		candidates: [],
		truncated: false,
	});
	if (resolve(channelRoot) !== channelRoot) return { ...empty(), truncated: true };
	const rootStat = lstatSync(channelRoot, { throwIfNoEntry: false });
	if (!rootStat) return empty();
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		return { ...empty(), truncated: true };
	}

	const names: string[] = [];
	let directory: ReturnType<typeof opendirSync> | undefined;
	try {
		directory = opendirSync(channelRoot);
		let entriesSeen = 0;
		for (;;) {
			const entry = directory.readSync();
			if (!entry) break;
			entriesSeen += 1;
			if (entriesSeen > MAX_UPDATE_RESULT_DIRECTORY_ENTRIES) {
				return { ...empty(), truncated: true };
			}
			if (!UPDATE_RESULT_FILE_PATTERN.test(entry.name)) continue;
			names.push(entry.name);
			if (names.length > MAX_UPDATE_RESULT_FILES) {
				return { ...empty(), truncated: true };
			}
		}
	} catch {
		return { ...empty(), truncated: true };
	} finally {
		try {
			directory?.closeSync();
		} catch {}
	}

	const candidates: NativeUpdateResultCandidate[] = [];
	for (const name of names) {
		const match = UPDATE_RESULT_FILE_PATTERN.exec(name);
		if (!match) continue;
		const path = join(channelRoot, name);
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (
			!stat?.isFile() ||
			stat.isSymbolicLink() ||
			stat.size <= 0 ||
			stat.size > MAX_UPDATE_RESULT_BYTES
		) {
			continue;
		}
		try {
			const result = validateNativeUpdateResult(
				JSON.parse(readFileSync(path, "utf8")),
				match[1]!,
				info,
			);
			candidates.push({
				path,
				modifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
				result,
			});
		} catch {
			// A malformed or unrelated file is neither surfaced nor removed.
		}
	}
	candidates.sort(
		(left, right) =>
			right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path),
	);
	return {
		candidates,
		selected: candidates.find((candidate) =>
			resultMatchesRunningState(candidate.result, info),
		),
		truncated: false,
	};
}

function observedUpdateTransaction(channelRoot: string): string | undefined {
	const path = join(channelRoot, OBSERVED_UPDATE_RESULT_FILE);
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
	try {
		const document = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (
			!isRecord(document) ||
			Object.keys(document).length !== 2 ||
			document["schema_version"] !== 1 ||
			typeof document["transaction_id"] !== "string" ||
			!TRANSACTION_ID_PATTERN.test(document["transaction_id"])
		) {
			return undefined;
		}
		return document["transaction_id"];
	} catch {
		return undefined;
	}
}

function markUpdateTransactionObserved(
	channelRoot: string,
	transactionId: string,
): void {
	atomicWriteJson(join(channelRoot, OBSERVED_UPDATE_RESULT_FILE), {
		schema_version: 1,
		transaction_id: transactionId,
	});
}

function pendingResultMayArrive(
	info: LocalUpdateInfo,
	channelRoot: string,
): boolean {
	const prepared = preparedUpdateForResult(info, channelRoot);
	return Boolean(
		prepared && prepared.version === info.version && prepared.hash === info.hash,
	);
}

function waitForResultPoll(): Promise<void> {
	return new Promise((resolvePoll) =>
		setTimeout(resolvePoll, UPDATE_RESULT_POLL_INTERVAL_MS),
	);
}

async function reconcileNativeUpdateResultOperation(): Promise<void> {
	const info = await Updater.getLocalInfo();
	if (!info.identifier || !info.channel || !info.version || !info.hash) return;
	let channelRoot: string;
	try {
		channelRoot = appDataFolderFor(info);
	} catch {
		return;
	}

	for (let attempt = 0; attempt < UPDATE_RESULT_POLL_ATTEMPTS; attempt += 1) {
		const scan = scanNativeUpdateResults(info, channelRoot);
		if (scan.truncated) return;
		const candidate = scan.selected;
		if (candidate) {
			reconciledNativeResultPath = candidate.path;
			if (
				observedUpdateTransaction(channelRoot) ===
				candidate.result.transaction_id
			) {
				return;
			}

			const result = candidate.result;
			const reconciled = reconcileNativeUpdateResultState(result, info);
			updateInfo = reconciled.updateInfo;
			try {
				emitStatus(reconciled.status, reconciled.message, reconciled.details);
			} finally {
				try {
					markUpdateTransactionObserved(
						channelRoot,
						result.transaction_id,
					);
				} catch {}
			}
			return;
		}
		if (!pendingResultMayArrive(info, channelRoot)) return;
		await waitForResultPoll();
	}
}

function reconcileNativeUpdateResultOnce(): Promise<void> {
	if (nativeResultReconciliation) return nativeResultReconciliation;
	const operation = Promise.resolve().then(reconcileNativeUpdateResultOperation);
	nativeResultReconciliation = operation;
	return operation;
}

function scheduleNativeUpdateResultReconciliation(): void {
	if (nativeResultReconciliation || nativeResultReconciliationScheduled) return;
	nativeResultReconciliationScheduled = true;
	setTimeout(() => {
		nativeResultReconciliationScheduled = false;
		void reconcileNativeUpdateResultOnce().catch(() => {});
	}, 0);
}

/** Keep the newest launch-relevant result and prune older validated results. */
export function cleanupOlderNativeUpdateResults(
	info: LocalUpdateInfo,
	channelRoot: string,
): string[] {
	const scan = scanNativeUpdateResults(info, channelRoot);
	if (scan.truncated) return [];
	const candidatePaths = new Set(scan.candidates.map((candidate) => candidate.path));
	const keepPath =
		scan.selected?.path ??
		(reconciledNativeResultPath && candidatePaths.has(reconciledNativeResultPath)
			? reconciledNativeResultPath
			: undefined);
	const removed: string[] = [];
	for (const candidate of scan.candidates) {
		if (candidate.path === keepPath) continue;
		const stat = lstatSync(candidate.path, { throwIfNoEntry: false });
		if (!stat?.isFile() || stat.isSymbolicLink()) continue;
		try {
			rmSync(candidate.path);
			removed.push(candidate.path);
		} catch {}
	}
	return removed;
}

async function readBoundedResponse(
	response: Response,
	maximumBytes: number,
): Promise<Uint8Array> {
	if (!response.body) throw new Error("Response has no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel();
			throw new Error("Update metadata exceeds the size limit");
		}
		chunks.push(value);
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export async function downloadResponseToFile(
	response: Response,
	partialPath: string,
	description: string,
	onProgress?: (bytesDownloaded: number) => void,
): Promise<number> {
	if (!response.body) throw new Error(`${description} response has no body`);

	let fileDescriptor: number | undefined;
	let bytesDownloaded = 0;
	try {
		fileDescriptor = openSync(partialPath, "wx+", 0o600);
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytesDownloaded += value.byteLength;
				writeAll(fileDescriptor, value);
				onProgress?.(bytesDownloaded);
			}
		} catch (error) {
			try {
				await reader.cancel();
			} catch {}
			throw error;
		}
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		return bytesDownloaded;
	} catch (error) {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {}
		}
		rmSync(partialPath, { force: true });
		throw error;
	}
}

async function downloadArtifact(
	response: Response,
	partialPath: string,
): Promise<void> {
	const headerValue = response.headers.get("content-length");
	const parsedLength = headerValue === null ? 0 : Number(headerValue);
	const totalBytes =
		Number.isSafeInteger(parsedLength) && parsedLength > 0 ? parsedLength : 0;
	const progressState = createDownloadProgressThrottleState();
	const bytesDownloaded = await downloadResponseToFile(
		response,
		partialPath,
		"Update artifact",
		(bytesDownloaded) => {
			if (totalBytes === 0) return;
			const progress = nextDownloadProgressPercent(
				progressState,
				bytesDownloaded,
				totalBytes,
				Date.now(),
			);
			if (progress !== null) {
				emitStatus("download-progress", "Downloading update bundle...", {
					progress,
					bytesDownloaded,
					totalBytes,
				});
			}
		},
	);
	const finalProgress = nextDownloadProgressPercent(
		progressState,
		bytesDownloaded,
		bytesDownloaded || 1,
		Date.now(),
		true,
	);
	if (finalProgress !== null) {
		emitStatus("download-progress", "Downloading update bundle...", {
			progress: finalProgress,
			bytesDownloaded,
			...(totalBytes > 0 ? { totalBytes } : {}),
		});
	}
}

type DeltaPatchExecutor = (
	executable: string,
	args: readonly string[],
) => void;

export function applyDeltaPatch(
	options: {
		bspatchPath: string;
		currentTarPath: string;
		patchPath: string;
		outputPath: string;
	},
	execute: DeltaPatchExecutor = (executable, args) => {
		execFileSync(executable, [...args], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 10 * 60_000,
		});
	},
): void {
	requireRegularFile(options.bspatchPath, "bspatch executable");
	requireRegularFile(options.currentTarPath, "Current update archive");
	requireRegularFile(options.patchPath, "Downloaded update patch");
	if (lstatSync(options.outputPath, { throwIfNoEntry: false })) {
		throw new Error("Refusing to replace an existing patch output");
	}
	try {
		execute(options.bspatchPath, [
			options.currentTarPath,
			options.outputPath,
			options.patchPath,
		]);
		requireRegularFile(options.outputPath, "Patched update archive");
		if (lstatSync(options.outputPath).size <= 0) {
			throw new Error("Patched update archive is empty");
		}
		syncFile(options.outputPath);
	} catch (error) {
		rmSync(options.outputPath, { force: true });
		throw error;
	}
}

class TarStreamReader {
	private readonly iterator: AsyncIterator<Uint8Array<ArrayBufferLike>>;
	private chunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private chunkOffset = 0;
	bytesRead = 0;

	constructor(stream: AsyncIterable<Uint8Array<ArrayBufferLike>>) {
		this.iterator = stream[Symbol.asyncIterator]();
	}

	private async fill(): Promise<boolean> {
		while (this.chunkOffset >= this.chunk.byteLength) {
			const next = await this.iterator.next();
			if (next.done) return false;
			this.chunk = next.value;
			this.chunkOffset = 0;
		}
		return true;
	}

	async readExactly(length: number): Promise<Uint8Array> {
		const result = new Uint8Array(length);
		let resultOffset = 0;
		while (resultOffset < length) {
			if (!(await this.fill())) throw new Error("Truncated update archive");
			const available = this.chunk.byteLength - this.chunkOffset;
			const count = Math.min(available, length - resultOffset);
			result.set(
				this.chunk.subarray(this.chunkOffset, this.chunkOffset + count),
				resultOffset,
			);
			this.chunkOffset += count;
			resultOffset += count;
			this.bytesRead += count;
		}
		return result;
	}

	async skip(length: number): Promise<void> {
		let remaining = length;
		while (remaining > 0) {
			if (!(await this.fill())) throw new Error("Truncated update archive");
			const count = Math.min(
				this.chunk.byteLength - this.chunkOffset,
				remaining,
			);
			this.chunkOffset += count;
			this.bytesRead += count;
			remaining -= count;
		}
	}

	async close(): Promise<void> {
		try {
			await this.iterator.return?.();
		} catch {}
	}
}

const tarDecoder = new TextDecoder("utf-8", { fatal: true });

function decodeTarString(bytes: Uint8Array): string {
	const terminator = bytes.indexOf(0);
	return tarDecoder.decode(
		terminator < 0 ? bytes : bytes.subarray(0, terminator),
	);
}

function parseTarNumber(bytes: Uint8Array, description: string): number {
	if (bytes.byteLength === 0) throw new Error(`Invalid TAR ${description}`);
	if ((bytes[0]! & 0x80) !== 0) {
		// GNU base-256 uses the high bit as its marker and the next bit as the
		// sign bit. Update archive offsets and sizes must be non-negative.
		if ((bytes[0]! & 0x40) !== 0) {
			throw new Error(`Invalid TAR ${description}`);
		}
		let value = BigInt(bytes[0]! & 0x3f);
		for (let index = 1; index < bytes.byteLength; index += 1) {
			value = (value << 8n) | BigInt(bytes[index]!);
		}
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new Error(`TAR ${description} is too large`);
		}
		return Number(value);
	}
	const text = new TextDecoder()
		.decode(bytes)
		.replace(/\0.*$/, "")
		.trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid TAR ${description}`);
	const value = Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Invalid TAR ${description}`);
	}
	return value;
}

function verifyTarHeader(header: Uint8Array): void {
	const expected = parseTarNumber(header.subarray(148, 156), "checksum");
	let actual = 0;
	for (let index = 0; index < header.byteLength; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
	}
	if (actual !== expected) throw new Error("Invalid TAR header checksum");
}

function parsePaxRecords(bytes: Uint8Array): Record<string, string> {
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < bytes.byteLength) {
		let space = offset;
		while (space < bytes.byteLength && bytes[space] !== 0x20) space += 1;
		const lengthText = new TextDecoder().decode(bytes.subarray(offset, space));
		if (space === bytes.byteLength || !/^[1-9]\d*$/.test(lengthText)) {
			throw new Error("Invalid PAX record length");
		}
		const recordLength = Number(lengthText);
		const end = offset + recordLength;
		if (
			!Number.isSafeInteger(recordLength) ||
			recordLength <= space - offset + 2 ||
			end > bytes.byteLength ||
			bytes[end - 1] !== 0x0a
		) {
			throw new Error("Invalid PAX record");
		}
		const body = tarDecoder.decode(bytes.subarray(space + 1, end - 1));
		const equals = body.indexOf("=");
		if (equals <= 0) throw new Error("Invalid PAX record");
		records[body.slice(0, equals)] = body.slice(equals + 1);
		offset = end;
	}
	return records;
}

function parsePaxSize(value: string): number {
	if (!/^\d+$/.test(value)) throw new Error("Invalid PAX entry size");
	const size = Number(value);
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error("Invalid PAX entry size");
	}
	return size;
}

function isUpdateMetadataPath(value: string): boolean {
	const path = value.replace(/^\.\//, "");
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0")
	) {
		return false;
	}
	const components = path.split("/");
	if (components.some((component) => component === "" || component === "." || component === "..")) {
		return false;
	}
	return (
		(components.length === 3 &&
			components[1] === "Resources" &&
			components[2] === "version.json") ||
		(components.length === 4 &&
			components[0]!.endsWith(".app") &&
			components[1] === "Contents" &&
			components[2] === "Resources" &&
			components[3] === "version.json") ||
		(components.length === 2 && components[1] === "metadata.json")
	);
}

function tarEntrySpan(size: number): number {
	const padding = (512 - (size % 512)) % 512;
	const span = size + padding;
	if (!Number.isSafeInteger(span)) throw new Error("TAR entry is too large");
	return span;
}

/** Read only the small version metadata entry while streaming over the TAR. */
export async function readUpdateHashFromTar(path: string): Promise<string> {
	let fileDescriptor: number | undefined;
	let reader: TarStreamReader | undefined;
	let stream: ReturnType<typeof createReadStream> | undefined;
	try {
		fileDescriptor = openSync(
			path,
			fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
		);
		const stat = fstatSync(fileDescriptor);
		if (!stat.isFile() || stat.size < 512) {
			throw new Error("Patched update archive is not a regular TAR file");
		}
		stream = createReadStream(path, {
			fd: fileDescriptor,
			autoClose: false,
			highWaterMark: 64 * 1024,
		});
		reader = new TarStreamReader(stream);
		let globalPax: Record<string, string> = {};
		let localPax: Record<string, string> | undefined;
		let longName: string | undefined;

		for (;;) {
			const header = await reader.readExactly(512);
			if (header.every((byte) => byte === 0)) break;
			verifyTarHeader(header);
			const headerSize = parseTarNumber(header.subarray(124, 136), "entry size");
			const headerSpan = tarEntrySpan(headerSize);
			if (headerSpan > stat.size - reader.bytesRead) {
				throw new Error("TAR entry extends beyond the update archive");
			}
			const type = header[156] ?? 0;
			const rawName = decodeTarString(header.subarray(0, 100));
			const prefix = decodeTarString(header.subarray(345, 500));
			const headerName = prefix ? `${prefix}/${rawName}` : rawName;

			if (type === 0x78 || type === 0x67 || type === 0x4c) {
				if (headerSize > MAX_TAR_EXTENSION_BYTES) {
					throw new Error("TAR path metadata exceeds the size limit");
				}
				const extension = await reader.readExactly(headerSize);
				await reader.skip(headerSpan - headerSize);
				if (type === 0x78) localPax = parsePaxRecords(extension);
				else if (type === 0x67) {
					globalPax = { ...globalPax, ...parsePaxRecords(extension) };
				} else {
					longName = decodeTarString(extension).replace(/\n$/, "");
				}
				continue;
			}

			const pax = { ...globalPax, ...localPax };
			const entryName = pax["path"] ?? longName ?? headerName;
			const entrySize =
				pax["size"] === undefined ? headerSize : parsePaxSize(pax["size"]);
			const entrySpan = tarEntrySpan(entrySize);
			if (entrySpan > stat.size - reader.bytesRead) {
				throw new Error("TAR entry extends beyond the update archive");
			}
			localPax = undefined;
			longName = undefined;

			if ((type === 0 || type === 0x30) && isUpdateMetadataPath(entryName)) {
				if (entrySize === 0 || entrySize > MAX_TAR_METADATA_BYTES) {
					throw new Error("Update metadata exceeds the size limit");
				}
				const bytes = await reader.readExactly(entrySize);
				const document: unknown = JSON.parse(tarDecoder.decode(bytes));
				if (!isRecord(document) || typeof document["hash"] !== "string") {
					throw new Error("Update archive metadata has no hash");
				}
				if (!SAFE_HASH_PATTERN.test(document["hash"])) {
					throw new Error("Update archive metadata hash is unsafe");
				}
				return document["hash"];
			}
			await reader.skip(entrySpan);
		}
		throw new Error("Update archive metadata was not found");
	} finally {
		await reader?.close();
		stream?.destroy();
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch (error) {
				// Bun may close the supplied descriptor when an async iterator is
				// returned even with autoClose:false; Cottontail leaves it open.
				if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
			}
		}
	}
}

function isPlainManagedFile(root: string, path: string): boolean {
	const relativePath = relative(resolve(root), resolve(path));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return false;
	}
	const rootStat = lstatSync(root, { throwIfNoEntry: false });
	if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false;
	let current = resolve(root);
	const components = relativePath.split(sep);
	for (const [index, component] of components.entries()) {
		current = join(current, component);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat || stat.isSymbolicLink()) return false;
		if (index === components.length - 1) return stat.isFile();
		if (!stat.isDirectory()) return false;
	}
	return false;
}

/** Standalone v2 manager first, bundled manager second for v1-to-v2 bootstrap. */
export function getUpdateHelperSourceCandidates(
	channelRoot: string,
	appBundlePath: string,
	platform: SupportedOS = currentOS,
): string[] {
	const standalone = join(
		channelRoot,
		platform === "win" ? "uninstall.exe" : "uninstall",
	);
	const bundled =
		platform === "macos"
			? join(appBundlePath, "Contents", "Resources", "uninstall")
			: join(appBundlePath, "Resources", "uninstall");
	return [standalone, bundled];
}

export function resolveUpdateHelperSource(
	channelRoot: string,
	appBundlePath: string,
	platform: SupportedOS = currentOS,
): string {
	const candidates = getUpdateHelperSourceCandidates(
		channelRoot,
		appBundlePath,
		platform,
	);
	const source = candidates.find((candidate, index) =>
		isPlainManagedFile(index === 0 ? channelRoot : appBundlePath, candidate),
	);
	if (!source) {
		throw new Error("No installed or bundled native update manager is available");
	}
	return source;
}

function physicalTemporaryDirectory(): string {
	const temporaryDirectory = resolve(tmpdir());
	return currentOS === "win"
		? temporaryDirectory
		: realpathSync.native(temporaryDirectory);
}

function copyUpdateHelper(
	channelRoot: string,
	appBundlePath: string,
	transactionId: string,
): string {
	const source = resolveUpdateHelperSource(channelRoot, appBundlePath);
	const destination = join(
		physicalTemporaryDirectory(),
		`electrobun-update-${transactionId}${currentOS === "win" ? ".exe" : ""}`,
	);
	let sourceDescriptor: number | undefined;
	let destinationDescriptor: number | undefined;
	try {
		sourceDescriptor = openSync(
			source,
			fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
		);
		if (!fstatSync(sourceDescriptor).isFile()) {
			throw new Error("Native update manager source is not a regular file");
		}
		destinationDescriptor = openSync(
			destination,
			"wx+",
			0o700,
		);
		const buffer = new Uint8Array(64 * 1024);
		for (;;) {
			const bytesRead = readSync(
				sourceDescriptor,
				buffer,
				0,
				buffer.byteLength,
				null,
			);
			if (bytesRead === 0) break;
			writeAll(destinationDescriptor, buffer.subarray(0, bytesRead));
		}
		if (currentOS !== "win") fchmodSync(destinationDescriptor, 0o700);
		fsyncSync(destinationDescriptor);
		closeSync(destinationDescriptor);
		destinationDescriptor = undefined;
		closeSync(sourceDescriptor);
		sourceDescriptor = undefined;
		return destination;
	} catch (error) {
		if (destinationDescriptor !== undefined) {
			try {
				closeSync(destinationDescriptor);
			} catch {}
		}
		if (sourceDescriptor !== undefined) {
			try {
				closeSync(sourceDescriptor);
			} catch {}
		}
		rmSync(destination, { force: true });
		throw error;
	}
}

function isCanonicalAbsolutePath(path: string): boolean {
	return isAbsolute(path) && resolve(path) === path && !path.includes("\0");
}

export function createNativeUpdatePlan(
	plan: NativeUpdatePlanV1,
): NativeUpdatePlanV1 {
	if (
		plan.schema_version !== 1 ||
		!TRANSACTION_ID_PATTERN.test(plan.transaction_id) ||
		!isSafeIdentityComponent(plan.identifier, plan.platform) ||
		!isSafeIdentityComponent(plan.channel, plan.platform) ||
		!isBuildEnvironment(plan.channel) ||
		!isSafeVersion(plan.version) ||
		!SAFE_HASH_PATTERN.test(plan.hash) ||
		!Number.isSafeInteger(plan.parent_pid) ||
		plan.parent_pid <= 0 ||
		plan.platform !== currentOS ||
		plan.arch !== currentArch ||
		!(["win", "linux", "macos"] as const).includes(plan.platform) ||
		!(["x64", "arm64"] as const).includes(plan.arch) ||
		![
			plan.channel_root,
			plan.app_bundle_path,
			plan.retained_tar_path,
			plan.result_path,
		].every(isCanonicalAbsolutePath)
	) {
		throw new Error("Invalid native update plan");
	}
	const expectedTarPath = join(
		plan.channel_root,
		"self-extraction",
		`${plan.hash}.tar`,
	);
	const expectedResultPath = join(
		plan.channel_root,
		`.electrobun-update-${plan.transaction_id}.result.json`,
	);
	if (
		plan.retained_tar_path !== expectedTarPath ||
		plan.result_path !== expectedResultPath
	) {
		throw new Error("Invalid native update plan paths");
	}
	return { ...plan };
}

/** Prefer the outer launcher PID so the native helper waits for the complete
 * installed process tree, not only the main runtime child. */
export function resolveUpdateParentPid(
	launcherPid = process.env["ELECTROBUN_LAUNCHER_PID"],
	runtimePid = process.pid,
): number {
	if (typeof launcherPid === "string" && /^[1-9]\d{0,9}$/.test(launcherPid)) {
		const parsed = Number(launcherPid);
		if (Number.isSafeInteger(parsed) && parsed <= 0x7fffffff) return parsed;
	}
	return runtimePid;
}

async function checkForUpdateOperation(): Promise<UpdateInfo> {
	emitStatus("checking", "Checking for updates...");
	const info = await Updater.getLocalInfo();
	if (!isBuildEnvironment(info.channel)) {
		checkedManifest = undefined;
		const message = `Unsupported update channel: ${info.channel}`;
		updateInfo = {
			version: info.version,
			hash: info.hash,
			updateAvailable: false,
			updateReady: false,
			error: message,
		};
		emitStatus("error", message, { errorMessage: message });
		return updateInfo;
	}
	if (info.channel === "dev") {
		checkedManifest = undefined;
		updateInfo = {
			version: info.version,
			hash: info.hash,
			updateAvailable: false,
			updateReady: false,
			error: "",
		};
		emitStatus("no-update", "Dev channel - updates disabled", {
			currentHash: info.hash,
		});
		return updateInfo;
	}

	const platformPrefix = getPlatformPrefix(info.channel, currentOS, currentArch);
	const updateInfoUrl = `${info.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-update.json?${randomBytes(8).toString("hex")}`;
	try {
		const response = await fetch(updateInfoUrl, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const bytes = await readBoundedResponse(
			response,
			MAX_UPDATE_DOCUMENT_BYTES,
		);
		let document: unknown;
		try {
			document = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new Error("update.json is not valid JSON");
		}
		const manifest = validateUpdateManifest(document, {
			identifier: info.identifier,
			channel: info.channel,
			platform: currentOS,
			arch: currentArch,
		});
		checkedManifest = manifest;
		let ready = false;
		try {
			const existing = loadPreparedUpdate(info, appDataFolderFor(info));
			if (preparedMatchesManifest(existing, manifest)) {
				ready = true;
			}
		} catch {
		}
		updateInfo = {
			version: manifest.version,
			hash: manifest.hash,
			updateAvailable: manifest.hash !== info.hash,
			updateReady: ready && manifest.hash !== info.hash,
			error: "",
		};
		if (updateInfo.updateAvailable) {
			emitStatus(
				"update-available",
				`Update available: ${info.hash.slice(0, 8)} → ${manifest.hash.slice(0, 8)}`,
				{ currentHash: info.hash, latestHash: manifest.hash },
			);
		} else {
			emitStatus("no-update", "Already on latest version", {
				currentHash: info.hash,
			});
		}
		return updateInfo;
	} catch (error) {
		checkedManifest = undefined;
		const message = `Failed to check for updates: ${(error as Error).message}`;
		updateInfo = {
			version: "",
			hash: "",
			updateAvailable: false,
			updateReady: false,
			error: message,
		};
		emitStatus("error", message, {
			errorMessage: (error as Error).message,
			url: updateInfoUrl,
		});
		return updateInfo;
	}
}

function checkForUpdate(): Promise<UpdateInfo> {
	if (checkInFlight) return checkInFlight;
	const operation = checkForUpdateOperation();
	checkInFlight = operation;
	void operation.then(
		() => {
			if (checkInFlight === operation) checkInFlight = undefined;
		},
		() => {
			if (checkInFlight === operation) checkInFlight = undefined;
		},
	);
	return operation;
}

export interface PatchChainPreparationResult {
	completed: boolean;
	patchesApplied: number;
}

interface PatchChainDependencies {
	fetchResponse?: (url: string, init: RequestInit) => Promise<Response>;
	applyPatch?: typeof applyDeltaPatch;
	readNextHash?: typeof readUpdateHashFromTar;
	bspatchPath?: string;
}

export async function preparePatchChainForUpdate(
	options: {
		info: LocalUpdateInfo;
		manifest: UpdateManifestV1;
		extractionFolder: string;
		transactionId: string;
		retainedTarPath: string;
	},
	dependencies: PatchChainDependencies = {},
): Promise<PatchChainPreparationResult> {
	const { info, manifest, extractionFolder, transactionId, retainedTarPath } = options;
	if (
		!isBuildEnvironment(info.channel) ||
		info.channel === "dev" ||
		manifest.channel !== info.channel ||
		!SAFE_HASH_PATTERN.test(info.hash) ||
		!SAFE_HASH_PATTERN.test(manifest.hash) ||
		!TRANSACTION_ID_PATTERN.test(transactionId) ||
		resolve(retainedTarPath) !==
			resolve(join(extractionFolder, `${manifest.hash}.tar`))
	) {
		throw new Error("Invalid patch-chain preparation request");
	}
	const channel: BuildEnvironment = info.channel;
	const currentTarPath = resolve(
		join(extractionFolder, `${info.hash}.tar`),
	);
	emitStatus(
		"checking-local-tar",
		`Checking for local tar file: ${info.hash.slice(0, 8)}`,
		{ currentHash: info.hash },
	);
	const currentTar = lstatSync(currentTarPath, { throwIfNoEntry: false });
	if (!currentTar?.isFile() || currentTar.isSymbolicLink()) {
		emitStatus(
			"local-tar-missing",
			`Local tar not found for ${info.hash.slice(0, 8)}, will download full bundle`,
			{ currentHash: info.hash },
		);
		return { completed: false, patchesApplied: 0 };
	}
	emitStatus(
		"local-tar-found",
		`Found local tar for ${info.hash.slice(0, 8)}`,
		{ currentHash: info.hash },
	);

	const fetchResponse = dependencies.fetchResponse ?? fetch;
	const applyPatch = dependencies.applyPatch ?? applyDeltaPatch;
	const readNextHash = dependencies.readNextHash ?? readUpdateHashFromTar;
	const bspatchPath =
		dependencies.bspatchPath ??
		join(dirname(process.execPath), currentOS === "win" ? "bspatch.exe" : "bspatch");
	const platformPrefix = getPlatformPrefix(
		channel,
		manifest.platform,
		manifest.arch,
	);
	const transactionPaths = new Set<string>();
	const seenHashes = new Set([info.hash]);
	let currentHash = info.hash;
	let activeTarPath = currentTarPath;
	let patchesApplied = 0;
	let patchUrl: string | undefined;
	try {
		while (currentHash !== manifest.hash) {
			const patchNumber = patchesApplied + 1;
			patchUrl = getPatchFileUrl(info.baseUrl, platformPrefix, currentHash);
			const pathPrefix = join(
				extractionFolder,
				`.${transactionId}.${patchNumber}.${currentHash}`,
			);
			const patchPartialPath = `${pathPrefix}.patch.partial`;
			const patchPath = `${pathPrefix}.patch`;
			const outputPath = `${pathPrefix}.tar.partial`;
			transactionPaths.add(patchPartialPath);
			transactionPaths.add(patchPath);
			transactionPaths.add(outputPath);

			emitStatus(
				"fetching-patch",
				`Checking for patch: ${currentHash.slice(0, 8)}`,
				{
					currentHash,
					latestHash: manifest.hash,
					patchNumber,
					url: patchUrl,
				},
			);
			const response = await fetchResponse(patchUrl, {
				signal: AbortSignal.timeout(10 * 60_000),
			});
			if (!response.ok) {
				try {
					await response.body?.cancel();
				} catch {}
				emitStatus(
					"patch-not-found",
					`No patch available for ${currentHash.slice(0, 8)}, will download full bundle`,
					{
						currentHash,
						latestHash: manifest.hash,
						patchNumber,
						totalPatchesApplied: patchesApplied,
						url: patchUrl,
					},
				);
				return { completed: false, patchesApplied };
			}

			emitStatus(
				"patch-found",
				`Patch found for ${currentHash.slice(0, 8)}`,
				{ currentHash, latestHash: manifest.hash, patchNumber, url: patchUrl },
			);
			emitStatus(
				"downloading-patch",
				`Downloading patch for ${currentHash.slice(0, 8)}...`,
				{ currentHash, latestHash: manifest.hash, patchNumber, url: patchUrl },
			);
			await downloadResponseToFile(
				response,
				patchPartialPath,
				"Update patch",
			);
			renameSync(patchPartialPath, patchPath);

			emitStatus(
				"applying-patch",
				`Applying patch for ${currentHash.slice(0, 8)}...`,
				{ currentHash, latestHash: manifest.hash, patchNumber },
			);
			await applyPatch({
				bspatchPath,
				currentTarPath: activeTarPath,
				patchPath,
				outputPath,
			});
			emitStatus("extracting-version", "Reading patched update metadata...", {
				currentHash,
				latestHash: manifest.hash,
				patchNumber,
			});
			const nextHash = await readNextHash(outputPath);
			if (seenHashes.has(nextHash)) {
				throw new Error(`Patch chain contains a cycle at ${nextHash}`);
			}
			seenHashes.add(nextHash);
			patchesApplied += 1;
			emitStatus("patch-applied", "Patch applied successfully", {
				fromHash: currentHash,
				toHash: nextHash,
				currentHash: nextHash,
				latestHash: manifest.hash,
				patchNumber,
				totalPatchesApplied: patchesApplied,
			});
			currentHash = nextHash;
			activeTarPath = outputPath;
		}

		publishFileReplacingRegular(activeTarPath, retainedTarPath);
		emitStatus("patch-chain-complete", "Patch chain complete", {
			fromHash: info.hash,
			toHash: manifest.hash,
			currentHash: manifest.hash,
			latestHash: manifest.hash,
			totalPatchesApplied: patchesApplied,
			usedPatchPath: true,
		});
		return { completed: true, patchesApplied };
	} catch (error) {
		emitStatus(
			"patch-failed",
			`Patch failed for ${currentHash.slice(0, 8)}, will download full bundle`,
			{
				currentHash,
				latestHash: manifest.hash,
				totalPatchesApplied: patchesApplied,
				errorMessage: (error as Error).message,
				...(patchUrl ? { url: patchUrl } : {}),
			},
		);
		return { completed: false, patchesApplied };
	} finally {
		for (const path of transactionPaths) rmSync(path, { force: true });
	}
}

async function downloadUpdateOperation(): Promise<void> {
	if (applyInFlight) {
		throw new Error("Cannot download an update while one is being applied");
	}
	emitStatus("download-starting", "Starting update download...");
	const info = await Updater.getLocalInfo();
	if (checkInFlight) await checkInFlight;
	if (!checkedManifest) await checkForUpdate();
	const manifest = checkedManifest;
	if (!manifest || manifest.hash === info.hash) return;

	const channelRoot = appDataFolderFor(info);
	const extractionFolder = extractionFolderFor(channelRoot);
	mkdirSync(extractionFolder, { recursive: true });
	try {
		const existing = loadPreparedUpdate(info, channelRoot);
		if (preparedMatchesManifest(existing, manifest)) {
			updateInfo = { ...updateInfo, updateReady: true, error: "" };
			emitStatus("download-complete", "Update bundle is already prepared", {
				latestHash: manifest.hash,
				usedPatchPath: false,
				totalPatchesApplied: 0,
			});
			return;
		}
	} catch {
		// A missing or stale prepared record is replaced only after a fully
		// downloaded artifact and decompressed tar have been published.
	}

	const transactionId = randomBytes(16).toString("hex");
	const compressedPartialPath = join(
		extractionFolder,
		`.${manifest.hash}.${transactionId}.tar.zst.partial`,
	);
	const compressedPath = join(
		extractionFolder,
		`.${manifest.hash}.${transactionId}.tar.zst`,
	);
	const tarPartialPath = join(
		extractionFolder,
		`${manifest.hash}.tar.${transactionId}.partial`,
	);
	const retainedTarPath = resolve(
		join(extractionFolder, `${manifest.hash}.tar`),
	);
	const artifactUrl = buildUpdateArtifactUrl(
		info.baseUrl,
		manifest.artifact.file,
	);
	const artifactRequestUrl = addUpdateArtifactCacheBuster(
		artifactUrl,
		transactionId,
	);
	try {
		const patchResult = await preparePatchChainForUpdate({
			info,
			manifest,
			extractionFolder,
			transactionId,
			retainedTarPath,
		});
		const usedPatchPath = patchResult.completed;
		if (!usedPatchPath) {
			emitStatus("downloading-full-bundle", "Downloading full update bundle...", {
				url: artifactRequestUrl,
				latestHash: manifest.hash,
				usedPatchPath: false,
			});
			const response = await fetch(artifactRequestUrl, {
				signal: AbortSignal.timeout(10 * 60_000),
			});
			if (!response.ok) {
				throw new Error(`Update artifact request failed with HTTP ${response.status}`);
			}
			await downloadArtifact(response, compressedPartialPath);
			renameSync(compressedPartialPath, compressedPath);

			const zstdPath = join(
				dirname(process.execPath),
				currentOS === "win" ? "zig-zstd.exe" : "zig-zstd",
			);
			requireRegularFile(zstdPath, "zig-zstd executable");
			emitStatus("decompressing", "Decompressing update bundle...", {
				zstdPath,
			});
			execFileSync(
				zstdPath,
				[
					"decompress",
					"-i",
					compressedPath,
					"-o",
					tarPartialPath,
					"--no-timing",
				],
				{ stdio: "ignore", windowsHide: true },
			);
			requireRegularFile(tarPartialPath, "Decompressed update archive");
			if (lstatSync(tarPartialPath).size <= 0) {
				throw new Error("Decompressed update archive is empty");
			}
			syncFile(tarPartialPath);
			publishFileReplacingRegular(tarPartialPath, retainedTarPath);
		}

		const record: PreparedUpdateV1 = {
			schema_version: 1,
			identifier: manifest.identifier,
			channel: manifest.channel,
			version: manifest.version,
			hash: manifest.hash,
			platform: manifest.platform,
			arch: manifest.arch,
			retained_tar_path: retainedTarPath,
			artifact_file: manifest.artifact.file,
		};
		atomicWriteJson(preparedUpdatePathFor(channelRoot), record);
		updateInfo = {
			version: manifest.version,
			hash: manifest.hash,
			updateAvailable: true,
			updateReady: true,
			error: "",
		};
		emitStatus("download-complete", "Update bundle downloaded and prepared", {
			latestHash: manifest.hash,
			usedPatchPath,
			totalPatchesApplied: patchResult.patchesApplied,
		});
	} catch (error) {
		const message = `Failed to download update: ${(error as Error).message}`;
		updateInfo = { ...updateInfo, updateReady: false, error: message };
		emitStatus("error", message, {
			errorMessage: (error as Error).message,
			url: artifactRequestUrl,
		});
	} finally {
		rmSync(compressedPartialPath, { force: true });
		rmSync(compressedPath, { force: true });
		rmSync(tarPartialPath, { force: true });
	}
}

function downloadUpdate(): Promise<void> {
	if (downloadInFlight) return downloadInFlight;
	const operation = downloadUpdateOperation();
	downloadInFlight = operation;
	void operation.then(
		() => {
			if (downloadInFlight === operation) downloadInFlight = undefined;
		},
		() => {
			if (downloadInFlight === operation) downloadInFlight = undefined;
		},
	);
	return operation;
}

async function applyUpdateOperation(): Promise<void> {
	if (downloadInFlight) await downloadInFlight;
	const info = await Updater.getLocalInfo();
	const channelRoot = appDataFolderFor(info);
	let prepared: PreparedUpdateV1;
	try {
		prepared = loadPreparedUpdate(info, channelRoot);
	} catch (error) {
		const message = `Cannot apply update: ${(error as Error).message}`;
		updateInfo = { ...updateInfo, updateReady: false, error: message };
		emitStatus("error", message, { errorMessage: (error as Error).message });
		return;
	}
	if (prepared.hash === info.hash) {
		emitStatus("no-update", "Already on latest version", {
			currentHash: info.hash,
		});
		return;
	}

	const transactionId = randomBytes(16).toString("hex");
	const appBundlePath =
		currentOS === "macos"
			? resolve(dirname(process.execPath), "..", "..")
			: join(channelRoot, "app");
	const planPath = join(
		channelRoot,
		`.electrobun-update-${transactionId}.json`,
	);
	const resultPath = join(
		channelRoot,
		`.electrobun-update-${transactionId}.result.json`,
	);
	const plan = createNativeUpdatePlan({
		schema_version: 1,
		transaction_id: transactionId,
		identifier: info.identifier,
		channel: info.channel,
		platform: currentOS,
		arch: currentArch,
		version: prepared.version,
		hash: prepared.hash,
		channel_root: channelRoot,
		app_bundle_path: appBundlePath,
		retained_tar_path: prepared.retained_tar_path,
		parent_pid: resolveUpdateParentPid(),
		result_path: resultPath,
	});

	// The quit veto is resolved before any helper, plan, or scheduled task is
	// armed. quitAfterApproval consumes this exact approval without re-emitting.
	const approval = requestQuitApproval();
	if (!approval) {
		emitStatus("idle", "Update restart was cancelled by a before-quit handler");
		return;
	}

	let helperPath: string | undefined;
	let planPublished = false;
	let windowsTaskPlan: ReturnType<typeof createWindowsUpdateTaskPlan> | undefined;
	try {
		emitStatus("applying", "Preparing update handoff...");
		cleanupOlderNativeUpdateResults(info, channelRoot);
		helperPath = copyUpdateHelper(channelRoot, appBundlePath, transactionId);
		atomicWriteJson(planPath, plan);
		planPublished = true;
		if (currentOS !== "win") chmodSync(planPath, 0o400);

		if (currentOS === "win") {
			const taskName = createWindowsUpdateTaskName(transactionId);
			windowsTaskPlan = createWindowsUpdateTaskPlan(
				taskName,
				helperPath,
				planPath,
			);
			executeWindowsUpdateTaskPlan(windowsTaskPlan, (command) => {
				execFileSync(command.executable, command.args, {
					stdio: "ignore",
					windowsHide: true,
				});
			});
		} else {
			const child = Bun.spawn(
				[helperPath, "--apply-update", planPath, "--quiet"],
				{
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
				},
			);
			child.unref();
		}

		emitStatus("launching-new-version", "Update prepared; restarting application...");
		quitAfterApproval(approval, 0);
	} catch (error) {
		cancelQuitApproval(approval);
		if (windowsTaskPlan) {
			try {
				execFileSync(
					windowsTaskPlan.deleteTask.executable,
					windowsTaskPlan.deleteTask.args,
					{ stdio: "ignore", windowsHide: true },
				);
			} catch {}
		}
		if (planPublished) rmSync(planPath, { force: true });
		if (helperPath) rmSync(helperPath, { force: true });
		const message = `Failed to start update helper: ${(error as Error).message}`;
		updateInfo = { ...updateInfo, error: message };
		emitStatus("error", message, { errorMessage: (error as Error).message });
	}
}

function applyUpdate(): Promise<void> {
	if (applyInFlight) return applyInFlight;
	const operation = applyUpdateOperation();
	applyInFlight = operation;
	void operation.then(
		() => {
			if (applyInFlight === operation) applyInFlight = undefined;
		},
		() => {
			if (applyInFlight === operation) applyInFlight = undefined;
		},
	);
	return operation;
}

const Updater = {
	updateInfo: (): UpdateInfo => updateInfo,
	getStatusHistory: (): UpdateStatusEntry[] => [...statusHistory],
	clearStatusHistory: (): void => {
		statusHistory.length = 0;
	},
	onStatusChange: (
		callback: ((entry: UpdateStatusEntry) => void) | null,
	): void => {
		onStatusChangeCallback = callback;
		if (callback) scheduleNativeUpdateResultReconciliation();
	},
	checkForUpdate,
	downloadUpdate,
	applyUpdate,
	channelBucketUrl: async (): Promise<string> => {
		return (await Updater.getLocalInfo()).baseUrl;
	},
	appDataFolder: async (): Promise<string> => {
		return appDataFolderFor(await Updater.getLocalInfo());
	},
	localInfo: {
		version: async (): Promise<string> => (await Updater.getLocalInfo()).version,
		hash: async (): Promise<string> => (await Updater.getLocalInfo()).hash,
		channel: async (): Promise<string> => (await Updater.getLocalInfo()).channel,
		baseUrl: async (): Promise<string> => (await Updater.getLocalInfo()).baseUrl,
	},
	getLocalInfo: async (): Promise<LocalUpdateInfo> => {
		if (localInfo) {
			scheduleNativeUpdateResultReconciliation();
			return localInfo;
		}
		try {
			localInfo = (await Bun.file("../Resources/version.json").json()) as LocalUpdateInfo;
		} catch (error) {
			console.error("Failed to read version.json", error);
			localInfo = {
				identifier: "",
				channel: "",
				version: "",
				hash: "",
				baseUrl: "",
				name: "",
			};
		}
		scheduleNativeUpdateResultReconciliation();
		return localInfo;
	},
	getLocallocalInfo: async (): Promise<LocalUpdateInfo> => {
		console.error(
			"[Electrobun] Updater.getLocallocalInfo() is deprecated. Use Updater.getLocalInfo() instead.",
		);
		return Updater.getLocalInfo();
	},
};

export { Updater };
