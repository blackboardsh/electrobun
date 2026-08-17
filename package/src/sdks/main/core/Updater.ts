import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
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
import { getPlatformPrefix } from "../../../shared/naming";
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

// Keep the legacy status names source-compatible even though v2 always uses a
// full, integrity-checked artifact instead of applying patch chains in-process.
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
	size: number;
	sha256: string;
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
	artifact_size: number;
	artifact_sha256: string;
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
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;
const SAFE_HASH_PATTERN = /^[a-z0-9]{1,13}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
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
 * artifact never reports 100%; the caller forces 100 only after verification.
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
	sha256?: string,
): string {
	if (!isSafeArtifactFileName(artifactFile)) {
		throw new Error("Invalid update artifact filename");
	}
	const artifactUrl = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(artifactFile)}`;
	if (sha256 === undefined) return artifactUrl;
	if (!SHA256_PATTERN.test(sha256)) {
		throw new Error("Invalid update artifact SHA-256");
	}
	// Release artifact filenames stay stable for v1 compatibility. Pin the
	// mutable URL to its verified bytes so caches cannot serve the prior build.
	return `${artifactUrl}?sha256=${sha256}`;
}

/** Validate and pin the v2 update metadata before any artifact is fetched. */
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
	const size = artifactValue["size"];
	const sha256 = requireString(artifactValue, "sha256");
	const requiredPrefix = `${getPlatformPrefix(channel, expected.platform, expected.arch)}-`;
	if (
		!isSafeArtifactFileName(file) ||
		!file.startsWith(requiredPrefix)
	) {
		throw new Error("Invalid update manifest: unsafe artifact filename");
	}
	if (
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size <= 0 ||
		size > MAX_ARTIFACT_BYTES
	) {
		throw new Error("Invalid update manifest: artifact size is out of range");
	}
	if (!SHA256_PATTERN.test(sha256)) {
		throw new Error("Invalid update manifest: artifact sha256 must be lowercase hex");
	}

	return {
		schemaVersion: 1,
		identifier,
		channel,
		version,
		hash,
		platform: platform as SupportedOS,
		arch: arch as SupportedArch,
		artifact: { file, size, sha256 },
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
		!isSafeIdentityComponent(info.channel, platform)
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
	// Recent v1 production installs used a literal `stable` root. macOS cannot
	// derive that physical root from process.execPath because the app bundle is
	// installed separately under /Applications, so retain it as a migration
	// candidate alongside the still older display-name layout.
	if (info.channel === "production") {
		candidates.push(pathApi.resolve(pathApi.join(identifierRoot, "stable")));
	}
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
			info.channel === "production"
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
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
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
	const artifactSize = document["artifact_size"];
	const artifactSha256 = requireString(document, "artifact_sha256");
	const expectedTarPath = resolve(
		join(extractionFolderFor(channelRoot), `${hash}.tar`),
	);
	if (
		identifier !== info.identifier ||
		channel !== info.channel ||
		platform !== currentOS ||
		arch !== currentArch ||
		!isSafeVersion(version) ||
		!SAFE_HASH_PATTERN.test(hash) ||
		resolve(retainedTarPath) !== retainedTarPath ||
		retainedTarPath !== expectedTarPath ||
		!isSafeArtifactFileName(artifactFile) ||
		typeof artifactSize !== "number" ||
		!Number.isSafeInteger(artifactSize) ||
		artifactSize <= 0 ||
		artifactSize > MAX_ARTIFACT_BYTES ||
		!SHA256_PATTERN.test(artifactSha256)
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
		artifact_size: artifactSize,
		artifact_sha256: artifactSha256,
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
		prepared.artifact_file === manifest.artifact.file &&
		prepared.artifact_size === manifest.artifact.size &&
		prepared.artifact_sha256 === manifest.artifact.sha256
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

async function downloadArtifact(
	response: Response,
	partialPath: string,
	expectedSize: number,
	expectedSha256: string,
): Promise<void> {
	if (!response.body) throw new Error("Update artifact response has no body");
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsedLength = Number(contentLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength !== expectedSize) {
			throw new Error("Update artifact Content-Length does not match its manifest");
		}
	}

	let fileDescriptor: number | undefined;
	let bytesDownloaded = 0;
	const hasher = createHash("sha256");
	const progressState = createDownloadProgressThrottleState();
	try {
		fileDescriptor = openSync(
			partialPath,
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
			0o600,
		);
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesDownloaded += value.byteLength;
			if (bytesDownloaded > expectedSize) {
				await reader.cancel();
				throw new Error("Update artifact is larger than its manifest size");
			}
			hasher.update(value);
			writeAll(fileDescriptor, value);
			const progress = nextDownloadProgressPercent(
				progressState,
				bytesDownloaded,
				expectedSize,
				Date.now(),
			);
			if (progress !== null) {
				emitStatus("download-progress", "Downloading update bundle...", {
					progress,
					bytesDownloaded,
					totalBytes: expectedSize,
				});
			}
		}
		if (bytesDownloaded !== expectedSize) {
			throw new Error("Update artifact is smaller than its manifest size");
		}
		if (hasher.digest("hex") !== expectedSha256) {
			throw new Error("Update artifact failed SHA-256 verification");
		}
		fsyncSync(fileDescriptor);
		closeSync(fileDescriptor);
		fileDescriptor = undefined;
		const finalProgress = nextDownloadProgressPercent(
			progressState,
			bytesDownloaded,
			expectedSize,
			Date.now(),
			true,
		);
		if (finalProgress !== null) {
			emitStatus("download-progress", "Downloading update bundle...", {
				progress: finalProgress,
				bytesDownloaded,
				totalBytes: expectedSize,
			});
		}
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
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
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
			});
			return;
		}
	} catch {
		// A missing or stale prepared record is replaced only after a fully
		// verified artifact and decompressed tar have been published.
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
		manifest.artifact.sha256,
	);
	try {
		emitStatus("downloading-full-bundle", "Downloading full update bundle...", {
			url: artifactUrl,
			latestHash: manifest.hash,
		});
		const response = await fetch(artifactUrl, {
			signal: AbortSignal.timeout(10 * 60_000),
		});
		if (!response.ok) {
			throw new Error(`Update artifact request failed with HTTP ${response.status}`);
		}
		await downloadArtifact(
			response,
			compressedPartialPath,
			manifest.artifact.size,
			manifest.artifact.sha256,
		);
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
			artifact_size: manifest.artifact.size,
			artifact_sha256: manifest.artifact.sha256,
		};
		atomicWriteJson(preparedUpdatePathFor(channelRoot), record);
		updateInfo = {
			version: manifest.version,
			hash: manifest.hash,
			updateAvailable: true,
			updateReady: true,
			error: "",
		};
		emitStatus("download-complete", "Update bundle downloaded and verified", {
			latestHash: manifest.hash,
			usedPatchPath: false,
		});
	} catch (error) {
		const message = `Failed to download update: ${(error as Error).message}`;
		updateInfo = { ...updateInfo, updateReady: false, error: message };
		emitStatus("error", message, {
			errorMessage: (error as Error).message,
			url: artifactUrl,
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
