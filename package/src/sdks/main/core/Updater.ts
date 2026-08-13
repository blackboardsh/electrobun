import { join, dirname, resolve, win32 } from "path";
import { homedir } from "os";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	copyFileSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	renameSync,
	unlinkSync,
	mkdirSync,
	openSync,
	readSync,
	rmSync,
	statSync,
	lstatSync,
	readdirSync,
	writeSync,
} from "fs";
import { execFileSync, execSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { OS as currentOS, ARCH as currentArch } from "../../../shared/platform";
import { getPlatformPrefix, getTarballFileName } from "../../../shared/naming";
import { quit } from "./Utils";
import {
	createWindowsUpdateTaskPlan,
	executeWindowsUpdateTaskPlan,
} from "./WindowsUpdateTask";

// Update status types for granular progress tracking
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

// Status history and callback
const statusHistory: UpdateStatusEntry[] = [];
let onStatusChangeCallback: ((entry: UpdateStatusEntry) => void) | null = null;

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
	if (onStatusChangeCallback) {
		onStatusChangeCallback(entry);
	}
}

// setTimeout(async () => {
//   console.log('killing')
//   const { native } = await import('../proc/native');
//             native.symbols.killApp();
// }, 1000)


// Cross-platform app data directory
function getAppDataDir(): string {
	switch (currentOS) {
		case "macos":
			return join(homedir(), "Library", "Application Support");
		case "win":
			// Use LOCALAPPDATA to match extractor location
			return process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local");
		case "linux":
			// Use XDG_DATA_HOME or fallback to ~/.local/share to match extractor
			return process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
		default:
			// Fallback to home directory with .config
			return join(homedir(), ".config");
	}
}

// todo (yoav): share type with cli
let localInfo: {
	version: string;
	hash: string;
	baseUrl: string;
	channel: string;
	name: string;
	identifier: string;
};

let updateInfo: {
	version: string;
	hash: string;
	updateAvailable: boolean;
	updateReady: boolean;
	error: string;
};

function cleanupExtractionFolder(
	extractionFolder: string,
	keepTarHash: string,
) {
	const keepFile = `${keepTarHash}.tar`;
	try {
		const entries = readdirSync(extractionFolder);
		for (const entry of entries) {
			if (entry === keepFile) continue;
			const fullPath = join(extractionFolder, entry);
			try {
				const s = statSync(fullPath);
				if (s.isDirectory()) {
					rmSync(fullPath, { recursive: true });
				} else {
					unlinkSync(fullPath);
				}
			} catch (e) {
				// Best effort — file may be in use on Windows
			}
		}
	} catch (e) {
		// Ignore errors in cleanup
	}
}

function quoteWindowsBatchArgument(argument: string): string {
	if (/["\r\n]/.test(argument)) {
		throw new Error("Invalid Windows batch argument");
	}

	// Percent signs are expanded even inside quotes in a batch file. Doubling
	// them preserves a literal percent sign when cmd.exe parses the script.
	return `"${argument.replace(/%/g, "%%")}"`;
}

function quoteWindowsBatchPath(path: string): string {
	return quoteWindowsBatchArgument(path.replace(/\//g, "\\"));
}

function quoteWindowsPowerShellPathForBatch(path: string): string {
	const normalized = path.replace(/\//g, "\\");
	if (/["\r\n]/.test(normalized)) {
		throw new Error("Invalid Windows batch argument");
	}
	// The outer batch parser still expands percent signs. PowerShell single-
	// quoted literals otherwise need only doubled apostrophes.
	return `'${normalized.replace(/%/g, "%%").replace(/'/g, "''")}'`;
}

export function createWindowsRegistrationRefreshBatch(
	channelRootPath: string,
): string {
	const normalizedChannelRoot = channelRootPath.replace(/\//g, "\\");
	const packagedUninstallerPath = win32.join(
		normalizedChannelRoot,
		"app",
		"Resources",
		"uninstall",
	);
	const installedUninstallerPath = win32.join(
		normalizedChannelRoot,
		"uninstall.exe",
	);
	const quotedPackagedUninstallerPath = quoteWindowsBatchPath(
		packagedUninstallerPath,
	);
	const packagedUninstallerPowerShellPath =
		quoteWindowsPowerShellPathForBatch(packagedUninstallerPath);
	const channelRootPowerShellPath =
		quoteWindowsPowerShellPathForBatch(normalizedChannelRoot);
	const quotedInstalledUninstallerPath = quoteWindowsBatchPath(
		installedUninstallerPath,
	);

	return `:: Replace the standalone Windows uninstall manager from the newly-installed app.
:: Windows cannot execute the extensionless bundled resource directly. Stage it
:: as a uniquely-named .exe outside the channel, then let that process perform
:: the atomic replacement while holding the channel uninstall mutex.
if not exist ${quotedPackagedUninstallerPath} goto registrationrefreshlegacy
"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -Command "$ErrorActionPreference = 'Stop'; $sourcePath = ${packagedUninstallerPowerShellPath}; $channelRoot = ${channelRootPowerShellPath}; $tempRoot = [Environment]::GetEnvironmentVariable('TEMP'); if ([String]::IsNullOrWhiteSpace($tempRoot)) { $tempRoot = [Environment]::GetEnvironmentVariable('TMP') }; if ([String]::IsNullOrWhiteSpace($tempRoot)) { $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA'); if (-not [String]::IsNullOrWhiteSpace($localAppData)) { $tempRoot = [IO.Path]::Combine($localAppData, 'Temp') } }; if ([String]::IsNullOrWhiteSpace($tempRoot)) { throw 'No Windows temporary directory is available' }; $stagePath = [IO.Path]::Combine($tempRoot, 'electrobun-uninstall-refresh-' + [Guid]::NewGuid().ToString('N') + '.exe'); $exitCode = 1; try { [IO.File]::Copy($sourcePath, $stagePath, $false); $channelRootArgument = [char]34 + $channelRoot + [char]34; $manager = Start-Process -FilePath $stagePath -ArgumentList @('--refresh-registration-from-update', $channelRootArgument, '--quiet') -WindowStyle Hidden -Wait -PassThru; $exitCode = $manager.ExitCode } finally { Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue }; exit $exitCode"
if errorlevel 1 echo Warning: could not replace or refresh the Windows uninstall manager.
goto registrationrefreshdone

:: Legacy bundles may not contain the manager resource. Keep updates working and
:: refresh the existing registration when an older standalone manager is present.
:registrationrefreshlegacy
if not exist ${quotedInstalledUninstallerPath} goto registrationrefreshmissing
${quotedInstalledUninstallerPath} --refresh-registration --quiet
if errorlevel 1 echo Warning: could not refresh Windows uninstall registration.
goto registrationrefreshdone
:registrationrefreshmissing
echo Skipping uninstall registration refresh: no bundled or installed manager was found.
:registrationrefreshdone
:: Metadata refresh is best effort and must not make a successful update fail.
ver >nul`;
}

export function createWindowsUpdateTaskName(
	identifier: string,
	channel: string,
): string {
	const scope = createHash("sha256")
		.update(identifier)
		.update("\0")
		.update(channel)
		.digest("hex")
		.slice(0, 24);
	return `ElectrobunUpdate_${scope}`;
}

type LinuxUninstallerMetadataRefreshExecutor = (
	executable: string,
	args: readonly string[],
) => void;

export interface LinuxUninstallerRefreshPlan {
	packagedUninstallerPath: string;
	installedUninstallerPath: string;
	stagedUninstallerPath: string;
	refreshArguments: readonly ["--refresh-metadata", "--quiet"];
}

export function createLinuxUninstallerRefreshPlan(
	channelRootPath: string,
	appBundlePath: string,
	nonce: string,
): LinuxUninstallerRefreshPlan {
	if (!/^[a-f0-9]{16}$/.test(nonce)) {
		throw new Error("Invalid Linux uninstaller staging nonce");
	}
	return {
		packagedUninstallerPath: join(appBundlePath, "Resources", "uninstall"),
		installedUninstallerPath: join(channelRootPath, "uninstall"),
		stagedUninstallerPath: join(
			channelRootPath,
			`.electrobun-uninstall-${nonce}.tmp`,
		),
		refreshArguments: ["--refresh-metadata", "--quiet"],
	};
}

function isPlainLinuxPath(path: string): boolean {
	const normalized = resolve(path);
	if (!normalized.startsWith("/") || normalized !== path) return false;
	let current = "/";
	for (const component of normalized.slice(1).split("/")) {
		if (!component) return false;
		current = join(current, component);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat || stat.isSymbolicLink()) return false;
	}
	return true;
}

/**
 * Replace the app-independent Linux uninstall manager from the newly installed
 * bundle, then let that manager refresh its external manifest. Older bundles
 * and package-managed installs do not contain the resource, so a missing source
 * is intentionally nonfatal.
 */
export function refreshLinuxUninstallerMetadata(
	channelRootPath: string,
	appBundlePath: string,
	execute: LinuxUninstallerMetadataRefreshExecutor = (executable, args) => {
		execFileSync(executable, [...args], { stdio: "ignore" });
	},
	nonce: () => string = () => randomBytes(8).toString("hex"),
): boolean {
	const plan = createLinuxUninstallerRefreshPlan(
		channelRootPath,
		appBundlePath,
		nonce(),
	);
	let sourceFd: number | undefined;
	let stagedFd: number | undefined;
	try {
		if (
			!isPlainLinuxPath(channelRootPath) ||
			!isPlainLinuxPath(appBundlePath) ||
			!isPlainLinuxPath(join(appBundlePath, "Resources"))
		) {
			return false;
		}
		const channelRoot = lstatSync(channelRootPath, { throwIfNoEntry: false });
		if (!channelRoot?.isDirectory() || channelRoot.isSymbolicLink()) return false;
		const installedManifest = lstatSync(
			join(channelRootPath, ".electrobun-uninstall.json"),
			{ throwIfNoEntry: false },
		);
		if (
			!installedManifest?.isFile() ||
			installedManifest.isSymbolicLink()
		) {
			return false;
		}
		const appBundle = lstatSync(appBundlePath, { throwIfNoEntry: false });
		const resourcesPath = join(appBundlePath, "Resources");
		const resources = lstatSync(resourcesPath, { throwIfNoEntry: false });
		if (
			!appBundle?.isDirectory() ||
			appBundle.isSymbolicLink() ||
			!resources?.isDirectory() ||
			resources.isSymbolicLink()
		) {
			return false;
		}
		const sourcePathStat = lstatSync(plan.packagedUninstallerPath, {
			throwIfNoEntry: false,
		});
		if (!sourcePathStat?.isFile() || sourcePathStat.isSymbolicLink()) return false;

		sourceFd = openSync(
			plan.packagedUninstallerPath,
			fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
		);
		if (!fstatSync(sourceFd).isFile()) throw new Error("Invalid Linux uninstaller resource");
		stagedFd = openSync(
			plan.stagedUninstallerPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
			0o600,
		);
		const buffer = new Uint8Array(64 * 1024);
		for (;;) {
			const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			let written = 0;
			while (written < bytesRead) {
				written += writeSync(
					stagedFd,
					buffer,
					written,
					bytesRead - written,
					null,
				);
			}
		}
		fchmodSync(stagedFd, 0o755);
		fsyncSync(stagedFd);
		closeSync(stagedFd);
		stagedFd = undefined;
		closeSync(sourceFd);
		sourceFd = undefined;
		renameSync(plan.stagedUninstallerPath, plan.installedUninstallerPath);
		execute(plan.installedUninstallerPath, plan.refreshArguments);
		return true;
	} catch {
		if (stagedFd !== undefined) {
			try {
				closeSync(stagedFd);
			} catch {}
		}
		if (sourceFd !== undefined) {
			try {
				closeSync(sourceFd);
			} catch {}
		}
		try {
			rmSync(plan.stagedUninstallerPath, { force: true });
		} catch {
			// A failed best-effort cleanup must not make an app update fail.
		}
		return false;
	}
}

type MacUninstallerMetadataRefreshExecutor = (
	executable: string,
	args: readonly string[],
) => void;

export interface MacUninstallerRefreshPlan {
	packagedUninstallerPath: string;
	installedUninstallerPath: string;
	stagedUninstallerPath: string;
	refreshArguments: readonly ["--refresh-metadata", "--quiet"];
}

export function createMacUninstallerRefreshPlan(
	channelRootPath: string,
	appBundlePath: string,
	nonce: string,
): MacUninstallerRefreshPlan {
	if (!/^[a-f0-9]{16}$/.test(nonce)) {
		throw new Error("Invalid macOS uninstaller staging nonce");
	}
	return {
		packagedUninstallerPath: join(
			appBundlePath,
			"Contents",
			"Resources",
			"uninstall",
		),
		installedUninstallerPath: join(channelRootPath, "uninstall"),
		stagedUninstallerPath: join(
			channelRootPath,
			`.electrobun-uninstall-${nonce}.tmp`,
		),
		refreshArguments: ["--refresh-metadata", "--quiet"],
	};
}

/**
 * Replace the app-independent macOS uninstall manager from the newly installed
 * bundle, then let that manager refresh its external manifest. Legacy bundles
 * do not contain the resource, so a missing source is intentionally nonfatal.
 */
export function refreshMacUninstallerMetadata(
	channelRootPath: string,
	appBundlePath: string,
	execute: MacUninstallerMetadataRefreshExecutor = (executable, args) => {
		execFileSync(executable, [...args], { stdio: "ignore" });
	},
	nonce: () => string = () => randomBytes(8).toString("hex"),
): boolean {
	const plan = createMacUninstallerRefreshPlan(
		channelRootPath,
		appBundlePath,
		nonce(),
	);
	try {
		const source = lstatSync(plan.packagedUninstallerPath, {
			throwIfNoEntry: false,
		});
		if (!source?.isFile() || source.isSymbolicLink()) return false;

		mkdirSync(channelRootPath, { recursive: true });
		copyFileSync(
			plan.packagedUninstallerPath,
			plan.stagedUninstallerPath,
			fsConstants.COPYFILE_EXCL,
		);
		chmodSync(plan.stagedUninstallerPath, 0o755);
		renameSync(plan.stagedUninstallerPath, plan.installedUninstallerPath);
		execute(plan.installedUninstallerPath, plan.refreshArguments);
		return true;
	} catch {
		rmSync(plan.stagedUninstallerPath, { force: true });
		return false;
	}
}

export interface WindowsUpdateBatchOptions {
	runningAppPath: string;
	newAppPath: string;
	extractionDirectoryPath: string;
	launcherPath: string;
	registrationRefreshBatch: string;
	taskCleanupBatchLine: string;
}

export function createWindowsUpdateBatch({
	runningAppPath,
	newAppPath,
	extractionDirectoryPath,
	launcherPath,
	registrationRefreshBatch,
	taskCleanupBatchLine,
}: WindowsUpdateBatchOptions): string {
	const quotedRunningAppPath = quoteWindowsBatchPath(runningAppPath);
	const quotedNewAppPath = quoteWindowsBatchPath(newAppPath);
	const quotedExtractionDirectoryPath = quoteWindowsBatchPath(
		extractionDirectoryPath,
	);
	const quotedLauncherPath = quoteWindowsBatchPath(launcherPath);

	return `@echo off
setlocal DisableDelayedExpansion

:: Wait for the app and any CEF helper processes to fully exit.
:: launcher.exe spawns cottontail.exe and "main Helper*.exe" processes that
:: keep libcef.dll locked; if we proceed too early, rmdir partially fails.
:waitloop
tasklist /FI "IMAGENAME eq launcher.exe" 2>NUL | find /I /N "launcher.exe">NUL && goto waitsleep
tasklist /FI "IMAGENAME eq cottontail.exe" 2>NUL | find /I /N "cottontail.exe">NUL && goto waitsleep
tasklist /FI "IMAGENAME eq main Helper.exe" 2>NUL | find /I /N "main Helper.exe">NUL && goto waitsleep
tasklist 2>NUL | find /I "main Helper">NUL && goto waitsleep
goto waitdone
:waitsleep
timeout /t 1 /nobreak >nul
goto waitloop
:waitdone

:: Small extra delay to ensure all file handles are released
timeout /t 2 /nobreak >nul

:: Remove current app folder, retrying if rmdir fails (locked files etc.)
set rmRetry=0
:rmloop
if not exist ${quotedRunningAppPath} goto rmdone
rmdir /s /q ${quotedRunningAppPath} 2>nul
if not exist ${quotedRunningAppPath} goto rmdone
set /a rmRetry=rmRetry+1
if %rmRetry% GEQ 10 goto rmfailed
timeout /t 2 /nobreak >nul
goto rmloop
:rmfailed
echo Update failed: could not remove ${quotedRunningAppPath} after retries.
echo Files may still be locked by a helper process.
goto updatefailed
:rmdone

:: Move new app to current location (safe now that destination is gone)
move ${quotedNewAppPath} ${quotedRunningAppPath}
if errorlevel 1 (
    echo Update failed: could not move ${quotedNewAppPath} to ${quotedRunningAppPath}.
    goto updatefailed
)
if not exist ${quotedLauncherPath} (
    echo Update failed: launcher not found at ${quotedLauncherPath} after move.
    goto updatefailed
)

${registrationRefreshBatch}

:: Clean up extraction directory
rmdir /s /q ${quotedExtractionDirectoryPath} 2>nul

:: Launch the new app
start "" ${quotedLauncherPath}
if errorlevel 1 (
    echo Update failed: could not launch ${quotedLauncherPath}.
    goto updatefailed
)

:: Remove this updater's scheduled task. The task name is generated internally
:: and embedded directly so localized schtasks output never needs parsing.
${taskCleanupBatchLine}

:: Delete this update script after a short delay
ping -n 2 127.0.0.1 >nul
del "%~f0"
exit /b 0

:updatefailed
:: Do not leave the generated task registered when an update step fails.
${taskCleanupBatchLine}
pause
exit /b 1
`;
}

const Updater = {
	updateInfo: () => {
		return updateInfo;
	},

	// Status history and subscription methods
	getStatusHistory: () => {
		return [...statusHistory];
	},

	clearStatusHistory: () => {
		statusHistory.length = 0;
	},

	onStatusChange: (callback: ((entry: UpdateStatusEntry) => void) | null) => {
		onStatusChangeCallback = callback;
	},

	// todo: allow switching channels, by default will check the current channel
	checkForUpdate: async () => {
		emitStatus("checking", "Checking for updates...");
		const localInfo = await Updater.getLocalInfo();

		if (localInfo.channel === "dev") {
			emitStatus("no-update", "Dev channel - updates disabled", {
				currentHash: localInfo.hash,
			});
			return {
				version: localInfo.version,
				hash: localInfo.hash,
				updateAvailable: false,
				updateReady: false,
				error: "",
			};
		}

		const cacheBuster = Math.random().toString(36).substring(7);
		const platformPrefix = getPlatformPrefix(
			localInfo.channel,
			currentOS,
			currentArch,
		);
		const updateInfoUrl = `${localInfo.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-update.json?${cacheBuster}`;

		try {
			const updateInfoResponse = await fetch(updateInfoUrl);

			if (updateInfoResponse.ok) {
				const responseText = await updateInfoResponse.text();
				try {
					updateInfo = JSON.parse(responseText);
				} catch {
					emitStatus("error", "Invalid update.json: failed to parse JSON", {
						url: updateInfoUrl,
					});
					return {
						version: "",
						hash: "",
						updateAvailable: false,
						updateReady: false,
						error: `Invalid update.json: failed to parse JSON`,
					};
				}

				if (!updateInfo.hash) {
					emitStatus("error", "Invalid update.json: missing hash", {
						url: updateInfoUrl,
					});
					return {
						version: "",
						hash: "",
						updateAvailable: false,
						updateReady: false,
						error: `Invalid update.json: missing hash`,
					};
				}

				if (updateInfo.hash !== localInfo.hash) {
					updateInfo.updateAvailable = true;
					emitStatus(
						"update-available",
						`Update available: ${localInfo.hash.slice(0, 8)} → ${updateInfo.hash.slice(0, 8)}`,
						{
							currentHash: localInfo.hash,
							latestHash: updateInfo.hash,
						},
					);
				} else {
					emitStatus("no-update", "Already on latest version", {
						currentHash: localInfo.hash,
					});
				}
			} else {
				emitStatus(
					"error",
					`Failed to fetch update info (HTTP ${updateInfoResponse.status})`,
					{ url: updateInfoUrl },
				);
				return {
					version: "",
					hash: "",
					updateAvailable: false,
					updateReady: false,
					error: `Failed to fetch update info from ${updateInfoUrl}`,
				};
			}
		} catch (error) {
			return {
				version: "",
				hash: "",
				updateAvailable: false,
				updateReady: false,
				error: `Failed to fetch update info from ${updateInfoUrl}`,
			};
		}

		return updateInfo;
	},

	downloadUpdate: async () => {
		emitStatus("download-starting", "Starting update download...");
		const appDataFolder = await Updater.appDataFolder();
		await Updater.channelBucketUrl(); // Ensure localInfo is loaded
		const appFileName = localInfo.name;

		let currentHash = (await Updater.getLocalInfo()).hash;
		let latestHash = (await Updater.checkForUpdate()).hash;

		const extractionFolder = join(appDataFolder, "self-extraction");
		if (!(await Bun.file(extractionFolder).exists())) {
			mkdirSync(extractionFolder, { recursive: true });
		}

		let currentTarPath = join(extractionFolder, `${currentHash}.tar`);
		const latestTarPath = join(extractionFolder, `${latestHash}.tar`);

		const seenHashes: string[] = [];
		let patchesApplied = 0;
		let usedPatchPath = false;

		if (!(await Bun.file(latestTarPath).exists())) {
			emitStatus(
				"checking-local-tar",
				`Checking for local tar file: ${currentHash.slice(0, 8)}`,
				{ currentHash },
			);

			while (currentHash !== latestHash) {
				seenHashes.push(currentHash);
				const currentTar = Bun.file(currentTarPath);

				if (!(await currentTar.exists())) {
					// tar file of the current version not found
					// so we can't patch it. We need the byte-for-byte tar file
					// so break out and download the full version
					emitStatus(
						"local-tar-missing",
						`Local tar not found for ${currentHash.slice(0, 8)}, will download full bundle`,
						{ currentHash },
					);
					break;
				}

				emitStatus(
					"local-tar-found",
					`Found local tar for ${currentHash.slice(0, 8)}`,
					{ currentHash },
				);

				// check if there's a patch file for it
				const platformPrefix = getPlatformPrefix(
					localInfo.channel,
					currentOS,
					currentArch,
				);
				const patchUrl = `${localInfo.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-${currentHash}.patch`;
				emitStatus(
					"fetching-patch",
					`Checking for patch: ${currentHash.slice(0, 8)}`,
					{ currentHash, url: patchUrl },
				);

				const patchResponse = await fetch(patchUrl);

				if (!patchResponse.ok) {
					// patch not found
					emitStatus(
						"patch-not-found",
						`No patch available for ${currentHash.slice(0, 8)}, will download full bundle`,
						{ currentHash },
					);
					break;
				}

				emitStatus(
					"patch-found",
					`Patch found for ${currentHash.slice(0, 8)}`,
					{ currentHash },
				);
				emitStatus(
					"downloading-patch",
					`Downloading patch for ${currentHash.slice(0, 8)}...`,
					{ currentHash },
				);

				// The patch file's name is the hash of the "from" version
				const patchFilePath = join(
					appDataFolder,
					"self-extraction",
					`${currentHash}.patch`,
				);
				await Bun.write(patchFilePath, await patchResponse.arrayBuffer());
				// patch it to a tmp name
				const tmpPatchedTarFilePath = join(
					appDataFolder,
					"self-extraction",
					`from-${currentHash}.tar`,
				);

				const bunBinDir = dirname(process.execPath);
				const bspatchBinName = currentOS === "win" ? "bspatch.exe" : "bspatch";
				const bspatchPath = join(bunBinDir, bspatchBinName);

				emitStatus(
					"applying-patch",
					`Applying patch ${patchesApplied + 1} for ${currentHash.slice(0, 8)}...`,
					{
						currentHash,
						patchNumber: patchesApplied + 1,
					},
				);

				// Verify all files exist before invoking bspatch
				if (!statSync(bspatchPath, { throwIfNoEntry: false })) {
					emitStatus(
						"patch-failed",
						`bspatch binary not found at ${bspatchPath}`,
						{
							currentHash,
							errorMessage: `bspatch not found: ${bspatchPath}`,
						},
					);
					console.error("bspatch not found:", bspatchPath);
					break;
				}
				if (!statSync(currentTarPath, { throwIfNoEntry: false })) {
					emitStatus("patch-failed", `Old tar not found at ${currentTarPath}`, {
						currentHash,
						errorMessage: `old tar not found: ${currentTarPath}`,
					});
					console.error("old tar not found:", currentTarPath);
					break;
				}
				if (!statSync(patchFilePath, { throwIfNoEntry: false })) {
					emitStatus(
						"patch-failed",
						`Patch file not found at ${patchFilePath}`,
						{
							currentHash,
							errorMessage: `patch not found: ${patchFilePath}`,
						},
					);
					console.error("patch file not found:", patchFilePath);
					break;
				}

				try {
					const patchResult = Bun.spawnSync([
						bspatchPath,
						currentTarPath,
						tmpPatchedTarFilePath,
						patchFilePath,
					]);

					if (patchResult.exitCode !== 0 || patchResult.success === false) {
						const stderr = patchResult.stderr
							? patchResult.stderr.toString()
							: "";
						const stdout = patchResult.stdout
							? patchResult.stdout.toString()
							: "";
						if (updateInfo) {
							updateInfo.error =
								stderr ||
								`bspatch failed with exit code ${patchResult.exitCode}`;
						}
						emitStatus(
							"patch-failed",
							`Patch application failed: ${stderr || `exit code ${patchResult.exitCode}`}`,
							{
								currentHash,
								errorMessage: stderr || `exit code ${patchResult.exitCode}`,
							},
						);
						console.error("bspatch failed", {
							exitCode: patchResult.exitCode,
							stdout,
							stderr,
							bspatchPath,
							oldTar: currentTarPath,
							newTar: tmpPatchedTarFilePath,
							patch: patchFilePath,
						});
						break;
					}
				} catch (error) {
					emitStatus(
						"patch-failed",
						`Patch threw exception: ${(error as Error).message}`,
						{
							currentHash,
							errorMessage: (error as Error).message,
						},
					);
					console.error("bspatch threw", error, { bspatchPath });
					break;
				}

				patchesApplied++;
				emitStatus(
					"patch-applied",
					`Patch ${patchesApplied} applied successfully`,
					{
						currentHash,
						patchNumber: patchesApplied,
					},
				);

				emitStatus(
					"extracting-version",
					"Extracting version info from patched tar...",
					{ currentHash },
				);

				let hashFilePath = "";

				// Read the hash from the patched tar without full extraction:
				// - macOS/Windows: Resources/version.json (inside the app bundle directory)
				// - Linux: metadata.json (alongside the app bundle)
				const resourcesDir = "Resources";
				const patchedTarBytes = await Bun.file(
					tmpPatchedTarFilePath,
				).arrayBuffer();
				const patchedArchive = new Bun.Archive(patchedTarBytes);
				const patchedFiles = await patchedArchive.files();

				for (const [filePath] of patchedFiles) {
					if (
						filePath.endsWith(`${resourcesDir}/version.json`) ||
						filePath.endsWith("metadata.json")
					) {
						hashFilePath = filePath;
						break;
					}
				}

				if (!hashFilePath) {
					emitStatus(
						"error",
						"Could not find version/metadata file in patched tar",
						{ currentHash },
					);
					console.error(
						"Neither Resources/version.json nor metadata.json found in patched tar:",
						tmpPatchedTarFilePath,
					);
					break;
				}

				const hashFile = patchedFiles.get(hashFilePath);
				const hashFileJson = JSON.parse(await hashFile!.text());
				const nextHash = hashFileJson.hash;

				if (seenHashes.includes(nextHash)) {
					emitStatus(
						"error",
						"Cyclical update detected, falling back to full download",
						{ currentHash: nextHash },
					);
					console.log("Warning: cyclical update detected");
					break;
				}

				seenHashes.push(nextHash);

				if (!nextHash) {
					emitStatus(
						"error",
						"Could not determine next hash from patched tar",
						{ currentHash },
					);
					break;
				}
				// Sync the patched tar file to the new hash
				const updatedTarPath = join(
					appDataFolder,
					"self-extraction",
					`${nextHash}.tar`,
				);
				renameSync(tmpPatchedTarFilePath, updatedTarPath);

				// delete the old tar file
				unlinkSync(currentTarPath);
				unlinkSync(patchFilePath);

				currentHash = nextHash;
				currentTarPath = join(
					appDataFolder,
					"self-extraction",
					`${currentHash}.tar`,
				);

				emitStatus(
					"patch-applied",
					`Patched to ${nextHash.slice(0, 8)}, checking for more patches...`,
					{
						currentHash: nextHash,
						toHash: latestHash,
						totalPatchesApplied: patchesApplied,
					},
				);
				// loop through applying patches until we reach the latest version
				// if we get stuck then exit and just download the full latest version
			}

			// Check if patch chain completed successfully
			if (currentHash === latestHash && patchesApplied > 0) {
				usedPatchPath = true;
				emitStatus(
					"patch-chain-complete",
					`Patch chain complete! Applied ${patchesApplied} patches`,
					{
						totalPatchesApplied: patchesApplied,
						currentHash: latestHash,
						usedPatchPath: true,
					},
				);
			}

			// If we weren't able to apply patches to the current version,
			// then just download it and unpack it
			if (currentHash !== latestHash) {
				emitStatus(
					"downloading-full-bundle",
					"Downloading full update bundle...",
					{
						currentHash,
						latestHash,
						usedPatchPath: false,
					},
				);

				const cacheBuster = Math.random().toString(36).substring(7);
				const platformPrefix = getPlatformPrefix(
					localInfo.channel,
					currentOS,
					currentArch,
				);
				const tarballName = getTarballFileName(appFileName, currentOS);
				const urlToLatestTarball = `${localInfo.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-${tarballName}`;
				const prevVersionCompressedTarballPath = join(
					appDataFolder,
					"self-extraction",
					"latest.tar.zst",
				);

				emitStatus("download-progress", `Fetching ${tarballName}...`, {
					url: urlToLatestTarball,
				});
				const response = await fetch(urlToLatestTarball + `?${cacheBuster}`);

				if (response.ok && response.body) {
					const contentLength = response.headers.get("content-length");
					const totalBytes = contentLength
						? parseInt(contentLength, 10)
						: undefined;
					let bytesDownloaded = 0;

					const reader = response.body.getReader();
					const writer = Bun.file(prevVersionCompressedTarballPath).writer();

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						await writer.write(value);
						bytesDownloaded += value.length;

						// Emit progress every ~500KB or so
						if (bytesDownloaded % 500000 < value.length) {
							emitStatus(
								"download-progress",
								`Downloading: ${(bytesDownloaded / 1024 / 1024).toFixed(1)} MB`,
								{
									bytesDownloaded,
									totalBytes,
									progress: totalBytes
										? Math.round((bytesDownloaded / totalBytes) * 100)
										: undefined,
								},
							);
						}
					}
					await writer.flush();
					writer.end();

					emitStatus(
						"download-progress",
						`Download complete: ${(bytesDownloaded / 1024 / 1024).toFixed(1)} MB`,
						{
							bytesDownloaded,
							totalBytes,
							progress: 100,
						},
					);
				} else {
					emitStatus("error", `Failed to download: ${urlToLatestTarball}`, {
						url: urlToLatestTarball,
					});
					console.log("latest version not found at: ", urlToLatestTarball);
				}

				emitStatus("decompressing", "Decompressing update bundle...");
				const bunBinDir = dirname(process.execPath);
				const zstdBinName = currentOS === "win" ? "zig-zstd.exe" : "zig-zstd";
				const zstdPath = join(bunBinDir, zstdBinName);

				if (!statSync(zstdPath, { throwIfNoEntry: false })) {
					updateInfo.error = `zig-zstd not found: ${zstdPath}`;
					emitStatus("error", updateInfo.error, { zstdPath });
					console.error("zig-zstd not found:", zstdPath);
				} else {
					const decompressResult = Bun.spawnSync(
						[
							zstdPath,
							"decompress",
							"-i",
							prevVersionCompressedTarballPath,
							"-o",
							latestTarPath,
							"--no-timing",
						],
						{
							cwd: extractionFolder,
							stdout: "inherit",
							stderr: "inherit",
						},
					);
					if (!decompressResult.success) {
						updateInfo.error = `zig-zstd failed with exit code ${decompressResult.exitCode}`;
						emitStatus("error", updateInfo.error, {
							zstdPath,
							exitCode: decompressResult.exitCode,
						});
						console.error("zig-zstd failed", {
							exitCode: decompressResult.exitCode,
							zstdPath,
						});
					} else {
						emitStatus("decompressing", "Decompression complete");
					}
				}

				unlinkSync(prevVersionCompressedTarballPath);
			}
		}

		// Note: Bun.file().exists() caches the result, so we nee d an new instance of Bun.file() here
		// to check again
		if (await Bun.file(latestTarPath).exists()) {
			// download patch for this version, apply it.
			// check for patch from that tar and apply it, until it matches the latest version
			// as a fallback it should just download and unpack the latest version
			updateInfo.updateReady = true;
			emitStatus(
				"download-complete",
				`Update ready to install (used ${usedPatchPath ? "patch" : "full download"} path)`,
				{
					latestHash,
					usedPatchPath,
					totalPatchesApplied: patchesApplied,
				},
			);
		} else {
			updateInfo.error = "Failed to download latest version";
			emitStatus("error", "Failed to download latest version", { latestHash });
		}

		// Clean up stale files in the extraction folder (old tars, patches, backups, etc.)
		cleanupExtractionFolder(extractionFolder, latestHash);
	},

	// todo (yoav): this should emit an event so app can cleanup or block the restart
	// todo (yoav): rename this to quitAndApplyUpdate or something
	applyUpdate: async () => {
		if (updateInfo?.updateReady) {
			emitStatus("applying", "Starting update installation...");
			const appDataFolder = await Updater.appDataFolder();
			const extractionFolder = join(appDataFolder, "self-extraction");
			if (!(await Bun.file(extractionFolder).exists())) {
				mkdirSync(extractionFolder, { recursive: true });
			}

			let latestHash = (await Updater.checkForUpdate()).hash;
			const latestTarPath = join(extractionFolder, `${latestHash}.tar`);

			let appBundleSubpath: string = "";

			if (await Bun.file(latestTarPath).exists()) {
				emitStatus(
					"extracting",
					`Extracting update to ${latestHash.slice(0, 8)}...`,
					{ latestHash },
				);

				// Windows needs a temporary directory to avoid file locking issues
				const extractionDir =
					currentOS === "win"
						? join(extractionFolder, `temp-${latestHash}`)
						: extractionFolder;

				if (currentOS === "win") {
					mkdirSync(extractionDir, { recursive: true });
				}

				const latestTarBytes = await Bun.file(latestTarPath).arrayBuffer();
				const latestArchive = new Bun.Archive(latestTarBytes);
				await latestArchive.extract(extractionDir);

				if (currentOS === "macos") {
					// Find the .app bundle by scanning extracted directory
					const extractedFiles = readdirSync(extractionDir);
					for (const file of extractedFiles) {
						if (file.endsWith('.app')) {
							appBundleSubpath = file + "/";
							break;
						}
					}
				} else {
					appBundleSubpath = "./";
				}

				console.log(
					`Tar extraction completed. Found appBundleSubpath: ${appBundleSubpath}`,
				);

				if (!appBundleSubpath) {
					console.error("Failed to find app in tarball");
					return;
				}

				// Note: resolve here removes the extra trailing / that the tar file adds
				const extractedAppPath = resolve(join(extractionDir, appBundleSubpath));

				// Platform-specific path handling
				let newAppBundlePath: string;
				if (currentOS === "linux") {
					// On Linux, the tarball contains a directory bundle
					// Find the actual extracted app directory name instead of guessing
					const extractedFiles = readdirSync(extractionDir);
					const appBundleDir = extractedFiles.find(file => {
						const filePath = join(extractionDir, file);
						return statSync(filePath).isDirectory() && !file.endsWith('.tar');
					});
					
					if (!appBundleDir) {
						console.error("Could not find app bundle directory in extraction");
						return;
					}
					
					newAppBundlePath = join(extractionDir, appBundleDir);

					// Verify the app bundle directory exists
					const bundleStats = statSync(newAppBundlePath, { throwIfNoEntry: false });
					if (!bundleStats || !bundleStats.isDirectory()) {
						console.error(`App bundle directory not found at: ${newAppBundlePath}`);
						console.log("Contents of extraction directory:");
						try {
							const files = readdirSync(extractionDir);
							for (const file of files) {
								console.log(`  - ${file}`);
								// Also list contents of subdirectories
								const subPath = join(extractionDir, file);
								if (statSync(subPath).isDirectory()) {
									const subFiles = readdirSync(subPath);
									for (const subFile of subFiles) {
										console.log(`    - ${subFile}`);
									}
								}
							}
						} catch (e) {
							console.log("Could not list directory contents:", e);
						}
						return;
					}
				} else if (currentOS === "win") {
					// On Windows, the actual app is inside a subdirectory.
					// version.json's `name` field already contains the formatted app
					// file name (e.g. "MyApp-canary" for canary, "MyApp" for production),
					// so don't re-apply getAppFileName or it doubles the channel suffix.
					newAppBundlePath = join(extractionDir, localInfo.name);

					// Verify the extracted app exists
					if (!statSync(newAppBundlePath, { throwIfNoEntry: false })) {
						console.error(`Extracted app not found at: ${newAppBundlePath}`);
						console.log("Contents of extraction directory:");
						try {
							const files = readdirSync(extractionDir);
							for (const file of files) {
								console.log(`  - ${file}`);
							}
						} catch (e) {
							console.log("Could not list directory contents:", e);
						}
						return;
					}
				} else {
					// On macOS, use the extracted app path directly
					newAppBundlePath = extractedAppPath;
				}
				// Platform-specific app path calculation
				let runningAppBundlePath: string;
				const appDataFolder = await Updater.appDataFolder();
				
				if (currentOS === "macos") {
					// On macOS, executable is at Contents/MacOS/binary inside .app bundle
					runningAppBundlePath = resolve(dirname(process.execPath), "..", "..");
				} else if (currentOS === "linux" || currentOS === "win") {
					// On Linux and Windows, use fixed 'app' folder to match extractor
					runningAppBundlePath = join(appDataFolder, "app");
				} else {
					throw new Error(`Unsupported platform: ${currentOS}`);
				}
				try {
					emitStatus("replacing-app", "Removing old version...");

					if (currentOS === "macos") {
						// Remove existing app before installing the new one
						if (statSync(runningAppBundlePath, { throwIfNoEntry: false })) {
							rmSync(runningAppBundlePath, { recursive: true });
						}

						emitStatus("replacing-app", "Installing new version...");
						// Move new app to running location
						renameSync(newAppBundlePath, runningAppBundlePath);

						// Remove quarantine extended attributes to prevent "damaged" error
						// The inner bundle is already signed/notarized, but macOS applies
						// quarantine attributes when extracting from a downloaded archive
						try {
							execSync(
								`xattr -r -d com.apple.quarantine "${runningAppBundlePath}"`,
								{ stdio: "ignore" },
							);
						} catch (e) {
							// Ignore errors - attribute may not exist
						}

						if (!refreshMacUninstallerMetadata(appDataFolder, runningAppBundlePath)) {
							console.warn(
								"Could not refresh the standalone macOS uninstaller; the installed app was still updated.",
							);
						}
					} else if (currentOS === "linux") {
						// On Linux, we now have directory bundles instead of AppImage files
						// The app is stored in {appDataFolder}/app/
						const appBundleDir = join(appDataFolder, "app");
						
						// Remove existing app directory if it exists
						if (statSync(appBundleDir, { throwIfNoEntry: false })) {
							rmSync(appBundleDir, { recursive: true });
						}

						// Move new app bundle directory to app location
						renameSync(newAppBundlePath, appBundleDir);

						// Ensure launcher binary is executable
						const launcherPath = join(appBundleDir, "bin", "launcher");
						if (statSync(launcherPath, { throwIfNoEntry: false })) {
							chmodSync(launcherPath, 0o755);
						}

						// Also ensure other binaries are executable
						const cottontailPath = join(appBundleDir, "bin", "cottontail");
						if (statSync(cottontailPath, { throwIfNoEntry: false })) {
							chmodSync(cottontailPath, 0o755);
						}

						refreshLinuxUninstallerMetadata(appDataFolder, appBundleDir);
					}

					// Clean up stale files in extraction folder
					if (currentOS !== "win") {
						cleanupExtractionFolder(extractionFolder, latestHash);
					}

					if (currentOS === "win") {
						// On Windows, files are locked while in use, so we need a helper script
						// that runs after the app exits to do the replacement
						const parentDir = dirname(runningAppBundlePath);
						const updateScriptPath = join(parentDir, "update.bat");
						const launcherPath = join(
							runningAppBundlePath,
							"bin",
							"launcher.exe",
						);

						const taskName = createWindowsUpdateTaskName(
							localInfo.identifier,
							localInfo.channel,
						);
						const taskPlan = createWindowsUpdateTaskPlan(
							taskName,
							updateScriptPath.replace(/\//g, "\\"),
						);
						const registrationRefreshBatch =
							createWindowsRegistrationRefreshBatch(parentDir);

						// Create a batch script that will:
						// 1. Wait for the current app and its helper processes to exit
						// 2. Remove current app folder (with retries — CEF helpers may briefly
						//    keep libcef.dll locked after launcher.exe exits)
						// 3. Move new app to current location (only if old folder is fully gone,
						//    otherwise `move` would put it inside as a subdirectory)
						// 4. Refresh the channel's Windows uninstall registration
						// 5. Launch the new app
						// 6. Clean up
						const updateScript = createWindowsUpdateBatch({
							runningAppPath: runningAppBundlePath,
							newAppPath: newAppBundlePath,
							extractionDirectoryPath: extractionDir,
							launcherPath,
							registrationRefreshBatch,
							taskCleanupBatchLine: taskPlan.cleanupBatchLine,
						});

						await Bun.write(updateScriptPath, updateScript);

						// Use Windows Task Scheduler to run the update script independently
						// This ensures the script runs even after the app exits
						// schtasks creates AC-only tasks by default. Configure the task to
						// start and continue on battery before running it; if any command
						// fails, the surrounding catch prevents the app from quitting.
						executeWindowsUpdateTaskPlan(taskPlan, (command) => {
							execFileSync(command.executable, command.args, {
								stdio: "ignore",
								windowsHide: true,
							});
						});

						// Use quit() for graceful shutdown - this closes all windows and processes
						quit();
					}
				} catch (error) {
					emitStatus(
						"error",
						`Failed to replace app: ${(error as Error).message}`,
						{
							errorMessage: (error as Error).message,
						},
					);
					console.error("Failed to replace app with new version", error);
					return;
				}

				emitStatus("launching-new-version", "Launching updated version...");

				// Cross-platform app launch (Windows is handled above with its own update script)
				if (currentOS === "macos") {
					// Wait for the current process to fully exit before relaunching.
					// macOS 'open' on an already-running app just activates the existing
					// instance instead of launching a new one, so we must ensure the
					// current process has exited first. The detached shell survives our
					// exit and polls until the process is gone.
					const pid = process.pid;
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					Bun.spawn(
						[
							"sh",
							"-c",
							`while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done; sleep 1; open "${runningAppBundlePath}"`,
						],
						{
							detached: true,
							stdio: ["ignore", "ignore", "ignore"],
						} as any,
					);
				} else if (currentOS === "linux") {
					// On Linux, launch the launcher binary inside the app directory
					const launcherPath = join(runningAppBundlePath, "bin", "launcher");
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					Bun.spawn(["sh", "-c", `"${launcherPath}" &`], {
						detached: true,
					} as any);
				}

				emitStatus("complete", "Update complete, restarting application...");
				// Use quit() for graceful shutdown
				quit();
			}
		}
	},

	channelBucketUrl: async () => {
		await Updater.getLocalInfo();
		// With flat prefix-based naming, channelBucketUrl is just the baseUrl
		// Users can also use Updater.localInfo.baseUrl() directly
		return localInfo.baseUrl;
	},

	appDataFolder: async () => {
		await Updater.getLocalInfo();
		// Use identifier + channel for the app data folder
		// e.g., ~/Library/Application Support/sh.blackboard.myapp/canary/
		const appDataFolder = join(
			getAppDataDir(),
			localInfo.identifier,
			localInfo.channel,
		);

		return appDataFolder;
	},

	// TODO: consider moving this from "Updater.localInfo" to "BuildVars"
	localInfo: {
		version: async () => {
			return (await Updater.getLocalInfo()).version;
		},
		hash: async () => {
			return (await Updater.getLocalInfo()).hash;
		},
		channel: async () => {
			return (await Updater.getLocalInfo()).channel;
		},
		baseUrl: async () => {
			return (await Updater.getLocalInfo()).baseUrl;
		},
	},

	getLocalInfo: async () => {
		if (localInfo) {
			return localInfo;
		}

		try {
			const resourcesDir = "Resources"; // Always use capitalized Resources
			localInfo = await Bun.file(`../${resourcesDir}/version.json`).json();
			return localInfo;
		} catch (error) {
			console.error("Failed to read version.json", error);
			localInfo = { identifier: "", channel: "", version: "", hash: "", baseUrl: "", name: "" };
			return localInfo;
			}
		},
		getLocallocalInfo: async () => {
			console.error(
				"[Electrobun] Updater.getLocallocalInfo() is deprecated. Use Updater.getLocalInfo() instead.",
			);

			return Updater.getLocalInfo();
		},
	};

export { Updater };
