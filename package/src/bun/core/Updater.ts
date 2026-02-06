import { join, dirname, resolve } from "path";
import { homedir } from "os";
import {
	renameSync,
	unlinkSync,
	mkdirSync,
	rmdirSync,
	statSync,
	readdirSync,
} from "fs";
import { execSync } from "child_process";
import { OS as currentOS, ARCH as currentArch } from "../../shared/platform";
import { getPlatformPrefix, getTarballFileName } from "../../shared/naming";
import { quit } from "./Utils";

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
					rmdirSync(fullPath, { recursive: true });
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
		const localInfo = await Updater.getLocallocalInfo();

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

		let currentHash = (await Updater.getLocallocalInfo()).hash;
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
					// On Windows, the actual app is inside a subdirectory
					// Use same sanitization as extractor: remove spaces and dots
					const appBundleName = localInfo.name
						.replace(/ /g, "")
						.replace(/\./g, "-");
					newAppBundlePath = join(extractionDir, appBundleName);

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
							rmdirSync(runningAppBundlePath, { recursive: true });
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
					} else if (currentOS === "linux") {
						// On Linux, we now have directory bundles instead of AppImage files
						// The app is stored in {appDataFolder}/app/
						const appBundleDir = join(appDataFolder, "app");
						
						// Remove existing app directory if it exists
						if (statSync(appBundleDir, { throwIfNoEntry: false })) {
							rmdirSync(appBundleDir, { recursive: true });
						}

						// Move new app bundle directory to app location
						renameSync(newAppBundlePath, appBundleDir);

						// Ensure launcher binary is executable
						const launcherPath = join(appBundleDir, "bin", "launcher");
						if (statSync(launcherPath, { throwIfNoEntry: false })) {
							execSync(`chmod +x "${launcherPath}"`);
						}

						// Also ensure other binaries are executable
						const bunPath = join(appBundleDir, "bin", "bun");
						if (statSync(bunPath, { throwIfNoEntry: false })) {
							execSync(`chmod +x "${bunPath}"`);
						}
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

						// Convert paths to Windows format
						const runningAppWin = runningAppBundlePath.replace(/\//g, "\\");
						const newAppWin = newAppBundlePath.replace(/\//g, "\\");
						const extractionDirWin = extractionDir.replace(/\//g, "\\");
						const launcherPathWin = launcherPath.replace(/\//g, "\\");

						// Create a batch script that will:
						// 1. Wait for the current app to exit
						// 2. Remove current app folder
						// 3. Move new app to current location
						// 4. Launch the new app
						// 5. Clean up
						const updateScript = `@echo off
setlocal

:: Wait for the app to fully exit (check if launcher.exe is still running)
:waitloop
tasklist /FI "IMAGENAME eq launcher.exe" 2>NUL | find /I /N "launcher.exe">NUL
if "%ERRORLEVEL%"=="0" (
    timeout /t 1 /nobreak >nul
    goto waitloop
)

:: Small extra delay to ensure all file handles are released
timeout /t 2 /nobreak >nul

:: Remove current app folder
if exist "${runningAppWin}" (
    rmdir /s /q "${runningAppWin}"
)

:: Move new app to current location
move "${newAppWin}" "${runningAppWin}"

:: Clean up extraction directory
rmdir /s /q "${extractionDirWin}" 2>nul

:: Launch the new app
start "" "${launcherPathWin}"

:: Clean up scheduled tasks starting with ElectrobunUpdate_
for /f "tokens=1" %%t in ('schtasks /query /fo list ^| findstr /i "ElectrobunUpdate_"') do (
    schtasks /delete /tn "%%t" /f >nul 2>&1
)

:: Delete this update script after a short delay
ping -n 2 127.0.0.1 >nul
del "%~f0"
`;

						await Bun.write(updateScriptPath, updateScript);

						// Use Windows Task Scheduler to run the update script independently
						// This ensures the script runs even after the app exits
						const scriptPathWin = updateScriptPath.replace(/\//g, "\\");
						const taskName = `ElectrobunUpdate_${Date.now()}`;

						// Create a scheduled task that runs immediately and deletes itself
						execSync(
							`schtasks /create /tn "${taskName}" /tr "cmd /c \\"${scriptPathWin}\\"" /sc once /st 00:00 /f`,
							{ stdio: "ignore" },
						);
						execSync(`schtasks /run /tn "${taskName}"`, { stdio: "ignore" });
						// The task will be cleaned up by Windows after it runs, or we delete it in the batch script

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
					// Use a detached shell so relaunch survives after killApp terminates the current process
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					await Bun.spawn(["sh", "-c", `open "${runningAppBundlePath}" &`], {
						detached: true,
					} as any);
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
		await Updater.getLocallocalInfo();
		// With flat prefix-based naming, channelBucketUrl is just the baseUrl
		// Users can also use Updater.localInfo.baseUrl() directly
		return localInfo.baseUrl;
	},

	appDataFolder: async () => {
		await Updater.getLocallocalInfo();
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
			return (await Updater.getLocallocalInfo()).version;
		},
		hash: async () => {
			return (await Updater.getLocallocalInfo()).hash;
		},
		channel: async () => {
			return (await Updater.getLocallocalInfo()).channel;
		},
		baseUrl: async () => {
			return (await Updater.getLocallocalInfo()).baseUrl;
		},
	},

	getLocallocalInfo: async () => {
		if (localInfo) {
			return localInfo;
		}

		try {
			const resourcesDir = "Resources"; // Always use capitalized Resources
			localInfo = await Bun.file(`../${resourcesDir}/version.json`).json();
			return localInfo;
		} catch (error) {
			// Handle the error
			console.error("Failed to read version.json", error);

			// Then rethrow so the app crashes
			throw error;
		}
	},
};

export { Updater };
