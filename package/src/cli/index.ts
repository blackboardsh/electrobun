import { join, dirname, basename } from "path";
import * as path from "path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	cpSync,
	rmdirSync,
	mkdirSync,
	createWriteStream,
	unlinkSync,
	readdirSync,
	rmSync,
	symlinkSync,
	statSync,
	copyFileSync,
	renameSync,
} from "fs";
import { execSync } from "child_process";
import * as readline from "readline";
import archiver from "archiver";
import { OS, ARCH } from "../shared/platform";
import { DEFAULT_CEF_VERSION_STRING } from "../shared/cef-version";
import { BUN_VERSION } from "../shared/bun-version";
import { ELECTROBUN_VERSION } from "../shared/electrobun-version";
import {
	getAppFileName,
	getBundleFileName,
	getPlatformPrefix,
	getTarballFileName,
	getWindowsSetupFileName,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	sanitizeVolumeNameForHdiutil as _sanitizeVolumeNameForHdiutil,
	getDmgVolumeName,
	getMacOSBundleDisplayName,
} from "../shared/naming";
import { getTemplate, getTemplateNames } from "./templates/embedded";
// import { loadBsdiff, loadBspatch } from 'bsdiff-wasm';
// MacOS named pipes hang at around 4KB
// @ts-expect-error - reserved for future use
const _MAX_CHUNK_SIZE = 1024 * 2;

// const binExt = OS === 'win' ? '.exe' : '';

// Create a tar file using system tar command (preserves file permissions unlike Bun.Archive)
function createTar(tarPath: string, cwd: string, entries: string[]) {
	// Use a relative path for the tar output on Windows to avoid bsdtar
	// interpreting the "C:" drive letter as a remote host specifier.
	const resolvedTarPath =
		process.platform === "win32" ? path.relative(cwd, tarPath) : tarPath;
	execSync(
		`tar -cf "${resolvedTarPath}" ${entries.map((e) => `"${e}"`).join(" ")}`,
		{
			cwd,
			stdio: "pipe",
			// Prevent macOS tar from including Apple Double (._*) files. No-op on other platforms.
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		},
	);
}

// Create a tar.gz file using system tar command

// this when run as an npm script this will be where the folder where package.json is.
const projectRoot = process.cwd();

// Find TypeScript ESM config file
function findConfigFile(): string | null {
	const configFile = join(projectRoot, "electrobun.config.ts");
	return existsSync(configFile) ? configFile : null;
}

// Note: cli args can be called via npm bun /path/to/electorbun/binary arg1 arg2
const indexOfElectrobun = process.argv.findIndex((arg) =>
	arg.includes("electrobun"),
);
const commandArg = process.argv[indexOfElectrobun + 1] || "build";

// Walk up from projectRoot to find electrobun in node_modules (supports hoisted monorepo layouts)
function resolveElectrobunDir(): string {
	let dir = projectRoot;
	while (dir !== dirname(dir)) {
		const candidate = join(dir, "node_modules", "electrobun");
		if (existsSync(join(candidate, "package.json"))) {
			return candidate;
		}
		dir = dirname(dir);
	}
	return join(projectRoot, "node_modules", "electrobun");
}

const ELECTROBUN_DEP_PATH = resolveElectrobunDir();
const ELECTROBUN_CACHE_PATH = join(dirname(ELECTROBUN_DEP_PATH), ".electrobun-cache");

// When debugging electrobun with the example app use the builds (dev or release) right from the source folder
// For developers using electrobun cli via npm use the release versions in /dist
// This lets us not have to commit src build folders to git and provide pre-built binaries

// Function to get platform-specific paths
function getPlatformPaths(
	targetOS: "macos" | "win" | "linux",
	targetArch: "arm64" | "x64",
) {
	const binExt = targetOS === "win" ? ".exe" : "";
	const platformDistDir = join(
		ELECTROBUN_DEP_PATH,
		`dist-${targetOS}-${targetArch}`,
	);
	const sharedDistDir = join(ELECTROBUN_DEP_PATH, "dist");

	return {
		// Platform-specific binaries (from dist-OS-ARCH/)
		BUN_BINARY: join(platformDistDir, "bun") + binExt,
		LAUNCHER_DEV: join(platformDistDir, "electrobun") + binExt,
		LAUNCHER_RELEASE: join(platformDistDir, "launcher") + binExt,
		NATIVE_WRAPPER_MACOS: join(platformDistDir, "libNativeWrapper.dylib"),
		NATIVE_WRAPPER_WIN: join(platformDistDir, "libNativeWrapper.dll"),
		NATIVE_WRAPPER_LINUX: join(platformDistDir, "libNativeWrapper.so"),
		NATIVE_WRAPPER_LINUX_CEF: join(platformDistDir, "libNativeWrapper_cef.so"),
		WEBVIEW2LOADER_WIN: join(platformDistDir, "WebView2Loader.dll"),
		BSPATCH: join(platformDistDir, "bspatch") + binExt,
		EXTRACTOR: join(platformDistDir, "extractor") + binExt,
		BSDIFF: join(platformDistDir, "bsdiff") + binExt,
		ZSTD: join(platformDistDir, "zig-zstd") + binExt,
		CEF_FRAMEWORK_MACOS: join(
			platformDistDir,
			"cef",
			"Chromium Embedded Framework.framework",
		),
		CEF_HELPER_MACOS: join(platformDistDir, "process_helper"),
		CEF_HELPER_WIN: join(platformDistDir, "process_helper.exe"),
		CEF_HELPER_LINUX: join(platformDistDir, "process_helper"),
		CEF_DIR: join(platformDistDir, "cef"),

		// Shared platform-independent files (from dist/)
		// These work with existing package.json and development workflow
		MAIN_JS: join(sharedDistDir, "main.js"),
		API_DIR: join(sharedDistDir, "api"),
	};
}

// Default PATHS for host platform (backward compatibility)
// @ts-expect-error - reserved for future use
const _PATHS = getPlatformPaths(OS, ARCH);

async function ensureCoreDependencies(
	targetOS?: "macos" | "win" | "linux",
	targetArch?: "arm64" | "x64",
) {
	// Use provided target platform or default to host platform
	const platformOS = targetOS || OS;
	const platformArch = targetArch || ARCH;

	// Get platform-specific paths
	const platformPaths = getPlatformPaths(platformOS, platformArch);

	// Check platform-specific binaries
	const requiredBinaries = [
		platformPaths.BUN_BINARY,
		platformPaths.BSDIFF,
		platformPaths.BSPATCH,
	];
	if (platformOS === "macos") {
		requiredBinaries.push(
			platformPaths.LAUNCHER_RELEASE,
			platformPaths.NATIVE_WRAPPER_MACOS,
		);
	} else if (platformOS === "win") {
		requiredBinaries.push(platformPaths.NATIVE_WRAPPER_WIN);
	} else {
		requiredBinaries.push(platformPaths.NATIVE_WRAPPER_LINUX);
	}

	// Check shared files (main.js should be in shared dist/)
	const requiredSharedFiles = [platformPaths.MAIN_JS];

	const missingBinaries = requiredBinaries.filter((file) => !existsSync(file));
	const missingSharedFiles = requiredSharedFiles.filter(
		(file) => !existsSync(file),
	);

	// If only shared files are missing, that's expected in production (they come via npm)
	if (missingBinaries.length === 0 && missingSharedFiles.length > 0) {
		console.log(
			`Shared files missing (expected in production): ${missingSharedFiles.map((f) => f.replace(ELECTROBUN_DEP_PATH, ".")).join(", ")}`,
		);
	}

	// Only download if platform-specific binaries are missing
	if (missingBinaries.length === 0) {
		return;
	}

	// Show which binaries are missing
	console.log(
		`Core dependencies not found for ${platformOS}-${platformArch}. Missing files:`,
		missingBinaries.map((f) => f.replace(ELECTROBUN_DEP_PATH, ".")).join(", "),
	);
	console.log(`Downloading core binaries for ${platformOS}-${platformArch}...`);

	const version = `v${ELECTROBUN_VERSION}`;

	const platformName =
		platformOS === "macos" ? "darwin" : platformOS === "win" ? "win" : "linux";
	const archName = platformArch;
	const coreTarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${version}/electrobun-core-${platformName}-${archName}.tar.gz`;

	console.log(`Downloading core binaries from: ${coreTarballUrl}`);

	try {
		// Download core binaries tarball
		const response = await fetch(coreTarballUrl);
		if (!response.ok) {
			throw new Error(
				`Failed to download binaries: ${response.status} ${response.statusText}`,
			);
		}

		// Create temp file
		const tempFile = join(
			ELECTROBUN_DEP_PATH,
			`core-${platformOS}-${platformArch}-temp.tar.gz`,
		);
		const fileStream = createWriteStream(tempFile);

		// Write response to file
		if (response.body) {
			const reader = response.body.getReader();
			let totalBytes = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const buffer = Buffer.from(value);
				fileStream.write(buffer);
				totalBytes += buffer.length;
			}
			console.log(
				`Downloaded ${totalBytes} bytes for ${platformOS}-${platformArch}`,
			);
		}

		// Ensure file is properly closed before proceeding
		await new Promise((resolve, reject) => {
			fileStream.end((err: Error | null | undefined) => {
				if (err) reject(err);
				else resolve(null);
			});
		});

		// Verify the downloaded file exists and has content
		if (!existsSync(tempFile)) {
			throw new Error(`Downloaded file not found: ${tempFile}`);
		}

		const fileSize = require("fs").statSync(tempFile).size;
		if (fileSize === 0) {
			throw new Error(`Downloaded file is empty: ${tempFile}`);
		}

		console.log(`Verified download: ${tempFile} (${fileSize} bytes)`);

		// Extract to platform-specific dist directory
		console.log(
			`Extracting core dependencies for ${platformOS}-${platformArch}...`,
		);
		const platformDistPath = join(
			ELECTROBUN_DEP_PATH,
			`dist-${platformOS}-${platformArch}`,
		);
		mkdirSync(platformDistPath, { recursive: true });

		const tarBytes = await Bun.file(tempFile).arrayBuffer();
		const archive = new Bun.Archive(tarBytes);
		await archive.extract(platformDistPath);

		// NOTE: We no longer copy main.js from platform-specific downloads
		// Platform-specific downloads should only contain native binaries
		// main.js and api/ should be shipped via npm in the shared dist/ folder

		// Clean up temp file
		unlinkSync(tempFile);

		// Debug: List what was actually extracted
		try {
			const extractedFiles = readdirSync(platformDistPath);
			console.log(`Extracted files to ${platformDistPath}:`, extractedFiles);

			// Check if files are in subdirectories
			for (const file of extractedFiles) {
				const filePath = join(platformDistPath, file);
				const stat = require("fs").statSync(filePath);
				if (stat.isDirectory()) {
					const subFiles = readdirSync(filePath);
					console.log(`  ${file}/: ${subFiles.join(", ")}`);
				}
			}
		} catch (e) {
			console.error("Could not list extracted files:", e);
		}

		// Verify extraction completed successfully - check platform-specific binaries only
		const requiredBinaries = [
			platformPaths.BUN_BINARY,
			platformPaths.BSDIFF,
			platformPaths.BSPATCH,
			platformPaths.ZSTD,
		];
		if (platformOS === "macos") {
			requiredBinaries.push(
				platformPaths.LAUNCHER_RELEASE,
				platformPaths.NATIVE_WRAPPER_MACOS,
			);
		} else if (platformOS === "win") {
			requiredBinaries.push(platformPaths.NATIVE_WRAPPER_WIN);
		} else {
			requiredBinaries.push(platformPaths.NATIVE_WRAPPER_LINUX);
		}

		const missingBinaries = requiredBinaries.filter(
			(file) => !existsSync(file),
		);
		if (missingBinaries.length > 0) {
			console.error(
				`Missing binaries after extraction: ${missingBinaries.map((f) => f.replace(ELECTROBUN_DEP_PATH, ".")).join(", ")}`,
			);
			console.error(
				"This suggests the tarball structure is different than expected",
			);
		}

		// Note: We no longer need to remove or re-add signatures from downloaded binaries
		// The CI-added adhoc signatures are actually required for macOS to run the binaries

		// For development: if main.js doesn't exist in shared dist/, copy from platform-specific download as fallback
		const sharedDistPath = join(ELECTROBUN_DEP_PATH, "dist");
		const extractedMainJs = join(platformDistPath, "main.js");
		const sharedMainJs = join(sharedDistPath, "main.js");

		if (existsSync(extractedMainJs) && !existsSync(sharedMainJs)) {
			console.log(
				"Development fallback: copying main.js from platform-specific download to shared dist/",
			);
			mkdirSync(sharedDistPath, { recursive: true });
			cpSync(extractedMainJs, sharedMainJs, { dereference: true });
		}

		console.log(
			`Core dependencies for ${platformOS}-${platformArch} downloaded and cached successfully`,
		);
	} catch (error: any) {
		console.error(
			`Failed to download core dependencies for ${platformOS}-${platformArch}:`,
			error.message,
		);
		console.error(
			"Please ensure you have an internet connection and the release exists.",
		);
		process.exit(1);
	}
}

/**
 * Returns the effective CEF directory path. When a custom cefVersion is set,
 * CEF files are stored in node_modules/.electrobun-cache/ which survives
 * both dist rebuilds and bun install (which replaces node_modules/electrobun).
 * When using the default version, returns the standard dist-{platform}/cef/ path.
 */
function getEffectiveCEFDir(
	platformOS: "macos" | "win" | "linux",
	platformArch: "arm64" | "x64",
	cefVersion?: string,
): string {
	if (cefVersion) {
		return join(ELECTROBUN_CACHE_PATH, "cef-override", `${platformOS}-${platformArch}`);
	}
	return getPlatformPaths(platformOS, platformArch).CEF_DIR;
}

/**
 * Ensures the correct Bun binary is available for bundling. When a custom
 * bunVersion is specified in the config, downloads that version from GitHub
 * releases and caches it. Otherwise returns the default binary path.
 */
async function ensureBunBinary(
	targetOS: "macos" | "win" | "linux",
	targetArch: "arm64" | "x64",
	bunVersion?: string,
): Promise<string> {
	if (!bunVersion) {
		return getPlatformPaths(targetOS, targetArch).BUN_BINARY;
	}

	const binExt = targetOS === "win" ? ".exe" : "";
	const overrideDir = join(ELECTROBUN_CACHE_PATH, "bun-override", `${targetOS}-${targetArch}`);
	const overrideBinary = join(overrideDir, `bun${binExt}`);
	const versionFile = join(overrideDir, ".bun-version");

	// Check if already downloaded with matching version
	if (existsSync(overrideBinary) && existsSync(versionFile)) {
		const cachedVersion = readFileSync(versionFile, "utf8").trim();
		if (cachedVersion === bunVersion) {
			console.log(
				`Custom Bun ${bunVersion} already cached for ${targetOS}-${targetArch}`,
			);
			return overrideBinary;
		}
		// Version mismatch - remove stale cache
		console.log(
			`Cached Bun version "${cachedVersion}" does not match requested "${bunVersion}", re-downloading...`,
		);
		rmSync(overrideDir, { recursive: true, force: true });
	} else if (existsSync(overrideDir)) {
		rmSync(overrideDir, { recursive: true, force: true });
	}

	await downloadCustomBun(bunVersion, targetOS, targetArch);
	return overrideBinary;
}

/**
 * Downloads a specific Bun version from GitHub releases for a custom version
 * override. The binary is cached in node_modules/.electrobun-cache/bun-override/
 * so it survives dist rebuilds and bun install.
 */
async function downloadCustomBun(
	bunVersion: string,
	platformOS: "macos" | "win" | "linux",
	platformArch: "arm64" | "x64",
) {
	// Map to GitHub release asset names
	let bunUrlSegment: string;
	let bunDirName: string;

	if (platformOS === "win") {
		bunUrlSegment = "bun-windows-x64-baseline.zip";
		bunDirName = "bun-windows-x64-baseline";
	} else if (platformOS === "macos") {
		bunUrlSegment =
			platformArch === "arm64"
				? "bun-darwin-aarch64.zip"
				: "bun-darwin-x64.zip";
		bunDirName =
			platformArch === "arm64" ? "bun-darwin-aarch64" : "bun-darwin-x64";
	} else if (platformOS === "linux") {
		bunUrlSegment =
			platformArch === "arm64" ? "bun-linux-aarch64.zip" : "bun-linux-x64.zip";
		bunDirName =
			platformArch === "arm64" ? "bun-linux-aarch64" : "bun-linux-x64";
	} else {
		throw new Error(`Unsupported platform for custom Bun: ${platformOS}`);
	}

	const binExt = platformOS === "win" ? ".exe" : "";
	const overrideDir = join(ELECTROBUN_CACHE_PATH, "bun-override", `${platformOS}-${platformArch}`);
	const overrideBinary = join(overrideDir, `bun${binExt}`);
	const bunUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunUrlSegment}`;

	console.log(`Using custom Bun version: ${bunVersion}`);
	console.log(`Downloading from: ${bunUrl}`);

	mkdirSync(overrideDir, { recursive: true });

	const tempZipPath = join(overrideDir, "temp.zip");

	try {
		console.log(`Downloading custom Bun...`);
		const response = await fetch(bunUrl);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const contentLength = response.headers.get("content-length");
		const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
		const fileStream = createWriteStream(tempZipPath);
		let downloadedSize = 0;
		let lastReportedPercent = -1;

		if (response.body) {
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = Buffer.from(value);
				fileStream.write(chunk);
				downloadedSize += chunk.length;

				if (totalSize > 0) {
					const percent = Math.round((downloadedSize / totalSize) * 100);
					const percentTier = Math.floor(percent / 10) * 10;
					if (percentTier > lastReportedPercent && percentTier <= 100) {
						console.log(
							`  Progress: ${percentTier}% (${Math.round(downloadedSize / 1024 / 1024)}MB/${Math.round(totalSize / 1024 / 1024)}MB)`,
						);
						lastReportedPercent = percentTier;
					}
				}
			}
		}

		await new Promise((resolve, reject) => {
			fileStream.end((error: any) => {
				if (error) reject(error);
				else resolve(void 0);
			});
		});

		console.log(
			`Download completed (${Math.round(downloadedSize / 1024 / 1024)}MB), extracting...`,
		);

		// Extract zip file
		if (platformOS === "win") {
			execSync(
				`powershell -command "Expand-Archive -Path '${tempZipPath}' -DestinationPath '${overrideDir}' -Force"`,
				{ stdio: "inherit" },
			);
		} else {
			execSync(`unzip -o "${tempZipPath}" -d "${overrideDir}"`, {
				stdio: "inherit",
			});
		}

		// Move binary from extracted subdirectory to override dir root
		const extractedBinary = join(overrideDir, bunDirName, `bun${binExt}`);
		if (existsSync(extractedBinary)) {
			renameSync(extractedBinary, overrideBinary);
		} else {
			throw new Error(
				`Bun binary not found after extraction at ${extractedBinary}`,
			);
		}

		// Set execute permissions on non-Windows
		if (platformOS !== "win") {
			execSync(`chmod +x "${overrideBinary}"`);
		}

		// Write version stamp
		writeFileSync(join(overrideDir, ".bun-version"), bunVersion);

		// Clean up
		if (existsSync(tempZipPath)) unlinkSync(tempZipPath);
		const extractedDir = join(overrideDir, bunDirName);
		if (existsSync(extractedDir))
			rmSync(extractedDir, { recursive: true, force: true });

		console.log(
			`Custom Bun ${bunVersion} for ${platformOS}-${platformArch} set up successfully`,
		);
	} catch (error: any) {
		// Clean up on failure
		if (existsSync(overrideDir)) {
			try {
				rmSync(overrideDir, { recursive: true, force: true });
			} catch {}
		}

		console.error(
			`Failed to set up custom Bun ${bunVersion} for ${platformOS}-${platformArch}:`,
			error.message,
		);
		console.error(
			`\nVerify the Bun version string and that it exists at: https://github.com/oven-sh/bun/releases`,
		);
		process.exit(1);
	}
}

async function ensureCEFDependencies(
	targetOS?: "macos" | "win" | "linux",
	targetArch?: "arm64" | "x64",
	cefVersion?: string,
): Promise<string> {
	// Use provided target platform or default to host platform
	const platformOS = targetOS || OS;
	const platformArch = targetArch || ARCH;

	// Get platform-specific paths
	const platformPaths = getPlatformPaths(platformOS, platformArch);

	// If custom CEF version specified, download from Spotify CDN
	// Custom CEF is stored in vendors/cef-override/ to survive dist rebuilds
	if (cefVersion) {
		const overrideDir = getEffectiveCEFDir(
			platformOS,
			platformArch,
			cefVersion,
		);
		// Check if already downloaded with matching version
		const cefVersionFile = join(overrideDir, ".cef-version");
		if (existsSync(overrideDir) && existsSync(cefVersionFile)) {
			const cachedVersion = readFileSync(cefVersionFile, "utf8").trim();
			if (cachedVersion === cefVersion) {
				console.log(
					`Custom CEF ${cefVersion} already cached for ${platformOS}-${platformArch} at ${overrideDir}`,
				);
				return overrideDir;
			}
			// Version mismatch - remove stale cache
			console.log(
				`Cached CEF version "${cachedVersion}" does not match requested "${cefVersion}", re-downloading...`,
			);
			rmSync(overrideDir, { recursive: true, force: true });
		} else if (existsSync(overrideDir)) {
			// Override dir exists but no version stamp - remove it
			rmSync(overrideDir, { recursive: true, force: true });
		}

		await downloadAndExtractCustomCEF(cefVersion, platformOS, platformArch);
		return overrideDir;
	}

	// Check if CEF dependencies already exist
	if (existsSync(platformPaths.CEF_DIR)) {
		console.log(
			`CEF dependencies found for ${platformOS}-${platformArch}, using cached version`,
		);
		return platformPaths.CEF_DIR;
	}

	console.log(
		`CEF dependencies not found for ${platformOS}-${platformArch}, downloading...`,
	);

	const version = `v${ELECTROBUN_VERSION}`;

	const platformName =
		platformOS === "macos" ? "darwin" : platformOS === "win" ? "win" : "linux";
	const archName = platformArch;
	const cefTarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${version}/electrobun-cef-${platformName}-${archName}.tar.gz`;

	// Helper function to download with retry logic
	async function downloadWithRetry(
		url: string,
		filePath: string,
		maxRetries = 3,
	): Promise<void> {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(
					`Downloading CEF (attempt ${attempt}/${maxRetries}) from: ${url}`,
				);

				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}

				// Get content length for progress tracking
				const contentLength = response.headers.get("content-length");
				const totalSize = contentLength ? parseInt(contentLength, 10) : 0;

				// Create temp file with unique name to avoid conflicts
				const fileStream = createWriteStream(filePath);
				let downloadedSize = 0;
				let lastReportedPercent = -1;

				// Stream download with progress
				if (response.body) {
					const reader = response.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						const chunk = Buffer.from(value);
						fileStream.write(chunk);
						downloadedSize += chunk.length;

						if (totalSize > 0) {
							const percent = Math.round((downloadedSize / totalSize) * 100);
							const percentTier = Math.floor(percent / 10) * 10;
							if (percentTier > lastReportedPercent && percentTier <= 100) {
								console.log(
									`  Progress: ${percentTier}% (${Math.round(downloadedSize / 1024 / 1024)}MB/${Math.round(totalSize / 1024 / 1024)}MB)`,
								);
								lastReportedPercent = percentTier;
							}
						}
					}
				}

				await new Promise((resolve, reject) => {
					fileStream.end((error: any) => {
						if (error) reject(error);
						else resolve(void 0);
					});
				});

				// Verify file size if content-length was provided
				if (totalSize > 0) {
					const actualSize = (await import("fs")).statSync(filePath).size;
					if (actualSize !== totalSize) {
						throw new Error(
							`Downloaded file size mismatch: expected ${totalSize}, got ${actualSize}`,
						);
					}
				}

				console.log(
					`✓ Download completed successfully (${Math.round(downloadedSize / 1024 / 1024)}MB)`,
				);
				return; // Success, exit retry loop
			} catch (error: any) {
				console.error(`Download attempt ${attempt} failed:`, error.message);

				// Clean up partial download
				if (existsSync(filePath)) {
					unlinkSync(filePath);
				}

				if (attempt === maxRetries) {
					throw new Error(
						`Failed to download after ${maxRetries} attempts: ${error.message}`,
					);
				}

				// Wait before retrying (exponential backoff)
				const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
				console.log(`Retrying in ${delay / 1000} seconds...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	try {
		// Create temp file with unique name
		const tempFile = join(
			ELECTROBUN_DEP_PATH,
			`cef-${platformOS}-${platformArch}-${Date.now()}.tar.gz`,
		);

		// Download with retry logic
		await downloadWithRetry(cefTarballUrl, tempFile);

		// Extract to platform-specific dist directory
		console.log(
			`Extracting CEF dependencies for ${platformOS}-${platformArch}...`,
		);
		const platformDistPath = join(
			ELECTROBUN_DEP_PATH,
			`dist-${platformOS}-${platformArch}`,
		);
		mkdirSync(platformDistPath, { recursive: true });

		// Helper function to validate tar file before extraction
		async function validateTarFile(filePath: string): Promise<void> {
			try {
				// Quick validation - try to read the tar file header
				const fd = await import("fs").then((fs) =>
					fs.promises.readFile(filePath),
				);

				// Check if it's a gzip file (magic bytes: 1f 8b)
				if (fd.length < 2 || fd[0] !== 0x1f || fd[1] !== 0x8b) {
					throw new Error("Invalid gzip header - file may be corrupted");
				}

				console.log(
					`✓ Tar file validation passed (${Math.round(fd.length / 1024 / 1024)}MB)`,
				);
			} catch (error: any) {
				throw new Error(`Tar file validation failed: ${error.message}`);
			}
		}

		// Validate downloaded file before extraction
		await validateTarFile(tempFile);

		try {
			const cefTarBytes = await Bun.file(tempFile).arrayBuffer();
			const cefArchive = new Bun.Archive(cefTarBytes);
			await cefArchive.extract(platformDistPath);

			console.log(`✓ Extraction completed successfully`);
		} catch (error: any) {
			// Check if CEF directory was created despite the error (partial extraction)
			const cefDir = join(platformDistPath, "cef");
			if (existsSync(cefDir)) {
				const cefFiles = readdirSync(cefDir);
				if (cefFiles.length > 0) {
					console.warn(`⚠️ Extraction warning: ${error.message}`);
					console.warn(
						`  However, CEF files were extracted (${cefFiles.length} files found).`,
					);
					console.warn(
						`  Proceeding with partial extraction - this usually works fine.`,
					);
					// Don't throw - continue with what we have
				} else {
					// No files extracted, this is a real failure
					throw new Error(
						`Extraction failed (no files extracted): ${error.message}`,
					);
				}
			} else {
				// No CEF directory created, this is a real failure
				throw new Error(
					`Extraction failed (no CEF directory created): ${error.message}`,
				);
			}
		}

		// Clean up temp file only after successful extraction
		try {
			unlinkSync(tempFile);
		} catch (cleanupError) {
			console.warn("Could not clean up temp file:", cleanupError);
		}

		// Debug: List what was actually extracted for CEF
		try {
			const extractedFiles = readdirSync(platformDistPath);
			console.log(
				`CEF extracted files to ${platformDistPath}:`,
				extractedFiles,
			);

			// Check if CEF directory was created
			const cefDir = join(platformDistPath, "cef");
			if (existsSync(cefDir)) {
				const cefFiles = readdirSync(cefDir);
				console.log(
					`CEF directory contents: ${cefFiles.slice(0, 10).join(", ")}${cefFiles.length > 10 ? "..." : ""}`,
				);
			}
		} catch (e) {
			console.error("Could not list CEF extracted files:", e);
		}

		console.log(
			`✓ CEF dependencies for ${platformOS}-${platformArch} downloaded and cached successfully`,
		);
		return platformPaths.CEF_DIR;
	} catch (error: any) {
		console.error(
			`Failed to download CEF dependencies for ${platformOS}-${platformArch}:`,
			error.message,
		);

		// Provide helpful guidance based on the error
		if (
			error.message.includes("corrupted download") ||
			error.message.includes("zlib") ||
			error.message.includes("unexpected end")
		) {
			console.error(
				"\n💡 This appears to be a download corruption issue. Suggestions:",
			);
			console.error("  • Check your internet connection stability");
			console.error(
				"  • Try running the command again (it will retry automatically)",
			);
			console.error("  • Clear the cache if the issue persists:");
			console.error(`    rm -rf "${ELECTROBUN_DEP_PATH}"`);
		} else if (
			error.message.includes("HTTP 404") ||
			error.message.includes("Not Found")
		) {
			console.error("\n💡 The CEF release was not found. This could mean:");
			console.error(
				"  • The version specified doesn't have CEF binaries available",
			);
			console.error("  • You're using a development/unreleased version");
			console.error("  • Try using a stable version instead");
		} else {
			console.error(
				"\nPlease ensure you have an internet connection and the release exists.",
			);
			console.error(
				`If the problem persists, try clearing the cache: rm -rf "${ELECTROBUN_DEP_PATH}"`,
			);
		}

		process.exit(1);
	}
}

/**
 * Downloads CEF runtime files from Spotify CDN for a custom version override.
 * Extracts the minimal distribution and restructures runtime files to the
 * layout the CLI expects. No compilation is needed — process_helper ships in
 * the core tarball and uses CEF's stable C API at runtime.
 *
 * The C API is designed for ABI stability within the same major version line.
 * Across major versions, breaking changes are possible.
 */
async function downloadAndExtractCustomCEF(
	cefVersion: string,
	platformOS: "macos" | "win" | "linux",
	platformArch: "arm64" | "x64",
) {
	// Parse "CEF_VERSION+chromium-CHROMIUM_VERSION"
	const match = cefVersion.match(/^(.+)\+chromium-(.+)$/);
	if (!match) {
		throw new Error(
			`Invalid cefVersion format: "${cefVersion}". ` +
				`Expected: "CEF_VERSION+chromium-CHROMIUM_VERSION" ` +
				`(e.g. "144.0.11+ge135be2+chromium-144.0.7559.97")`,
		);
	}
	const cefVer = match[1]!;
	const chromiumVer = match[2]!;

	// Map platform names to Spotify CDN naming
	const cefPlatformMap: Record<string, string> = {
		"macos-arm64": "macosarm64",
		"macos-x64": "macosx64",
		"win-x64": "windows64",
		"win-arm64": "windowsarm64",
		"linux-x64": "linux64",
		"linux-arm64": "linuxarm64",
	};
	const cefPlatform = cefPlatformMap[`${platformOS}-${platformArch}`];
	if (!cefPlatform) {
		throw new Error(
			`Unsupported platform/arch for custom CEF: ${platformOS}-${platformArch}`,
		);
	}

	// URL-encode the + as %2B
	const encodedCefVer = cefVer.replace(/\+/g, "%2B");
	const cefUrl = `https://cef-builds.spotifycdn.com/cef_binary_${encodedCefVer}%2Bchromium-${chromiumVer}_${cefPlatform}_minimal.tar.bz2`;

	console.log(`Using custom CEF version: ${cefVersion}`);
	console.log(`Downloading from: ${cefUrl}`);

	// Store custom CEF in .electrobun-cache so it survives dist rebuilds and bun install
	const cefDir = getEffectiveCEFDir(platformOS, platformArch, cefVersion);
	console.log(`Caching custom CEF to ${cefDir}`);
	mkdirSync(cefDir, { recursive: true });

	// Download to temp file
	const tempFile = join(
		ELECTROBUN_DEP_PATH,
		`cef-custom-${platformOS}-${platformArch}-${Date.now()}.tar.bz2`,
	);

	try {
		console.log(`Downloading custom CEF...`);
		const response = await fetch(cefUrl);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const contentLength = response.headers.get("content-length");
		const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
		const fileStream = createWriteStream(tempFile);
		let downloadedSize = 0;
		let lastReportedPercent = -1;

		if (response.body) {
			const reader = response.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = Buffer.from(value);
				fileStream.write(chunk);
				downloadedSize += chunk.length;

				if (totalSize > 0) {
					const percent = Math.round((downloadedSize / totalSize) * 100);
					const percentTier = Math.floor(percent / 10) * 10;
					if (percentTier > lastReportedPercent && percentTier <= 100) {
						console.log(
							`  Progress: ${percentTier}% (${Math.round(downloadedSize / 1024 / 1024)}MB/${Math.round(totalSize / 1024 / 1024)}MB)`,
						);
						lastReportedPercent = percentTier;
					}
				}
			}
		}

		await new Promise((resolve, reject) => {
			fileStream.end((error: any) => {
				if (error) reject(error);
				else resolve(void 0);
			});
		});

		console.log(
			`Download completed (${Math.round(downloadedSize / 1024 / 1024)}MB), extracting...`,
		);

		// Extract tar.bz2 using system tar (bz2 requires it)
		execSync(`tar -xjf "${tempFile}" --strip-components=1 -C "${cefDir}"`, {
			stdio: "inherit",
		});

		// The Spotify distribution layout has runtime files in Release/ and Resources/
		// subdirectories, but the CLI expects them at the cef/ root. Copy them up.
		console.log("Copying CEF runtime files to expected locations...");
		const releaseDir = join(cefDir, "Release");
		const resourcesDir = join(cefDir, "Resources");

		if (platformOS === "macos") {
			// macOS: copy the framework from Release/ to cef/ root
			const fwSrc = join(releaseDir, "Chromium Embedded Framework.framework");
			const fwDst = join(cefDir, "Chromium Embedded Framework.framework");
			if (existsSync(fwSrc) && !existsSync(fwDst)) {
				cpSync(fwSrc, fwDst, { recursive: true, dereference: true });
			}
		} else {
			// Windows and Linux: copy all files from Release/ and Resources/ to cef/ root
			if (existsSync(releaseDir)) {
				for (const entry of readdirSync(releaseDir)) {
					const src = join(releaseDir, entry);
					const dst = join(cefDir, entry);
					if (!existsSync(dst)) {
						cpSync(src, dst, { recursive: true, dereference: true });
					}
				}
			}
			if (existsSync(resourcesDir)) {
				for (const entry of readdirSync(resourcesDir)) {
					const src = join(resourcesDir, entry);
					const dst = join(cefDir, entry);
					if (!existsSync(dst)) {
						cpSync(src, dst, { recursive: true, dereference: true });
					}
				}
			}
		}

		// Write version stamp
		writeFileSync(join(cefDir, ".cef-version"), cefVersion);

		console.log(
			`Custom CEF ${cefVersion} for ${platformOS}-${platformArch} set up successfully`,
		);
		console.log(
			`Note: process_helper ships in the core tarball and uses CEF's stable C API.`,
		);
		console.log(
			`C API compatibility is expected within the same major version line.`,
		);
	} catch (error: any) {
		// Clean up on failure
		if (existsSync(cefDir)) {
			try {
				rmSync(cefDir, { recursive: true, force: true });
			} catch {}
		}

		console.error(
			`Failed to set up custom CEF ${cefVersion} for ${platformOS}-${platformArch}:`,
			error.message,
		);
		console.error(
			`\nVerify the CEF version string and that it exists at: https://cef-builds.spotifycdn.com/`,
		);
		console.error(
			`Note: CEF's C API is ABI-stable within the same major version. ` +
				`Across major versions, breaking changes are possible.`,
		);
		process.exit(1);
	} finally {
		// Clean up temp file
		if (existsSync(tempFile)) {
			try {
				unlinkSync(tempFile);
			} catch {}
		}
	}
}

// @ts-expect-error - reserved for future use
const _commandDefaults = {
	init: {
		projectRoot,
		config: "electrobun.config",
	},
	build: {
		projectRoot,
		config: "electrobun.config",
	},
	dev: {
		projectRoot,
		config: "electrobun.config",
	},
};

// Default values merged with user's electrobun.config.ts
// For the user-facing type, see ElectrobunConfig in src/bun/ElectrobunConfig.ts
const defaultConfig = {
	app: {
		name: "MyApp",
		identifier: "com.example.myapp",
		version: "0.1.0",
		description: "" as string | undefined,
		urlSchemes: undefined as string[] | undefined,
	},
	build: {
		buildFolder: "build",
		artifactFolder: "artifacts",
		useAsar: false,
		asarUnpack: undefined as string[] | undefined, // Glob patterns for files to exclude from ASAR (e.g., ["*.node", "*.dll"])
		cefVersion: undefined as string | undefined, // Override CEF version: "CEF_VERSION+chromium-CHROMIUM_VERSION"
		bunVersion: undefined as string | undefined, // Override Bun runtime version: "1.4.2"
		mac: {
			codesign: false,
			notarize: false,
			bundleCEF: false,
			entitlements: {
				// This entitlement is required for Electrobun apps with a hardened runtime (required for notarization) to run on macos
				"com.apple.security.cs.allow-jit": true,
				// Required for bun runtime to work with dynamic code execution and JIT compilation when signed
				"com.apple.security.cs.allow-unsigned-executable-memory": true,
				"com.apple.security.cs.disable-library-validation": true,
			} as Record<string, boolean | string>,
			icons: "icon.iconset",
			defaultRenderer: undefined as "native" | "cef" | undefined,
			chromiumFlags: undefined as Record<string, string | true> | undefined,
		},
		win: {
			bundleCEF: false,
			icon: undefined as string | undefined,
			defaultRenderer: undefined as "native" | "cef" | undefined,
			chromiumFlags: undefined as Record<string, string | true> | undefined,
		},
		linux: {
			bundleCEF: false,
			icon: undefined as string | undefined,
			defaultRenderer: undefined as "native" | "cef" | undefined,
			chromiumFlags: undefined as Record<string, string | true> | undefined,
		},
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: undefined as
			| Record<string, { entrypoint: string; [key: string]: unknown }>
			| undefined,
		copy: undefined as Record<string, string> | undefined,
		watch: undefined as string[] | undefined,
		watchIgnore: undefined as string[] | undefined,
	},
	runtime: {} as Record<string, unknown>,
	scripts: {
		preBuild: "",
		postBuild: "",
		postWrap: "",
		postPackage: "",
	},
	release: {
		baseUrl: "",
		generatePatch: true,
	},
};

// Mapping of entitlements to their corresponding Info.plist usage description keys
const ENTITLEMENT_TO_PLIST_KEY: Record<string, string> = {
	"com.apple.security.device.camera": "NSCameraUsageDescription",
	"com.apple.security.device.microphone": "NSMicrophoneUsageDescription",
	"com.apple.security.device.audio-input": "NSMicrophoneUsageDescription",
	"com.apple.security.personal-information.location":
		"NSLocationUsageDescription",
	"com.apple.security.personal-information.location-when-in-use":
		"NSLocationWhenInUseUsageDescription",
	"com.apple.security.personal-information.contacts":
		"NSContactsUsageDescription",
	"com.apple.security.personal-information.calendars":
		"NSCalendarsUsageDescription",
	"com.apple.security.personal-information.reminders":
		"NSRemindersUsageDescription",
	"com.apple.security.personal-information.photos-library":
		"NSPhotoLibraryUsageDescription",
	"com.apple.security.personal-information.apple-music-library":
		"NSAppleMusicUsageDescription",
	"com.apple.security.personal-information.motion": "NSMotionUsageDescription",
	"com.apple.security.personal-information.speech-recognition":
		"NSSpeechRecognitionUsageDescription",
	"com.apple.security.device.bluetooth": "NSBluetoothAlwaysUsageDescription",
	"com.apple.security.files.user-selected.read-write":
		"NSDocumentsFolderUsageDescription",
	"com.apple.security.files.downloads.read-write":
		"NSDownloadsFolderUsageDescription",
	"com.apple.security.files.desktop.read-write":
		"NSDesktopFolderUsageDescription",
};

// Helper function to escape XML special characters
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// Helper functions
function escapePathForTerminal(path: string): string {
	return `"${path.replace(/"/g, '\\"')}"`;
}

/**
 * Creates a Linux installer tar.gz containing:
 * - Self-extracting installer executable (with embedded app archive)
 * - README.txt with instructions
 *
 * This replaces the AppImage-based installer to avoid libfuse2 dependency.
 * The installer executable has the compressed app archive embedded within it
 * using magic markers, similar to how Windows installers work.
 */
async function createLinuxInstallerArchive(
	buildFolder: string,
	compressedTarPath: string,
	appFileName: string,
	config: any,
	buildEnvironment: string,
	hash: string,
	targetPaths: ReturnType<typeof getPlatformPaths>,
): Promise<string> {
	console.log("Creating Linux installer archive...");

	// Create installer name using sanitized app file name (no spaces, URL-safe)
	// Note: appFileName already includes the channel suffix for non-stable builds
	const installerName = `${appFileName}-Setup`;

	// Create temp directory for staging
	const stagingDir = join(buildFolder, `${installerName}-staging`);
	if (existsSync(stagingDir)) {
		rmSync(stagingDir, { recursive: true, force: true });
	}
	mkdirSync(stagingDir, { recursive: true });

	try {
		// 1. Create self-extracting installer binary
		// Read the extractor binary
		const extractorBinary = readFileSync(targetPaths.EXTRACTOR);

		// Read the compressed archive
		const compressedArchive = readFileSync(compressedTarPath);

		// Create metadata JSON
		const metadata = {
			identifier: config.app.identifier,
			name: config.app.name,
			channel: buildEnvironment,
			hash: hash,
		};
		const metadataJson = JSON.stringify(metadata);
		const metadataBuffer = Buffer.from(metadataJson, "utf8");

		// Create marker buffers
		const metadataMarker = Buffer.from("ELECTROBUN_METADATA_V1", "utf8");
		const archiveMarker = Buffer.from("ELECTROBUN_ARCHIVE_V1", "utf8");

		// Combine extractor + metadata marker + metadata + archive marker + archive
		const combinedBuffer = Buffer.concat([
			new Uint8Array(extractorBinary),
			new Uint8Array(metadataMarker),
			new Uint8Array(metadataBuffer),
			new Uint8Array(archiveMarker),
			new Uint8Array(compressedArchive),
		]);

		// Write the self-extracting installer
		const installerPath = join(stagingDir, "installer");
		writeFileSync(installerPath, new Uint8Array(combinedBuffer), {
			mode: 0o755,
		});
		execSync(`chmod +x ${escapePathForTerminal(installerPath)}`);

		// 2. Create README for clarity
		const readmeContent = `${config.app.name} Installer
========================

To install ${config.app.name}:

1. Double-click the 'installer' file
2. Or run from terminal: ./installer

The installer will:
- Extract the application to ~/.local/share/
- Create a desktop shortcut with the app's icon

For more information, visit: ${config.app.homepage || "https://electrobun.dev"}
`;

		writeFileSync(join(stagingDir, "README.txt"), readmeContent);

		// 3. Create the tar.gz archive (extract contents directly, no nested folder)
		const archiveName = `${installerName}.tar.gz`;
		const archivePath = join(buildFolder, archiveName);

		console.log(`Creating installer archive: ${archivePath}`);

		// Use tar to create the archive, preserving executable permissions
		// The -C changes to the staging dir, then . archives its contents directly
		execSync(
			`tar -czf ${escapePathForTerminal(archivePath)} -C ${escapePathForTerminal(stagingDir)} .`,
			{ stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } },
		);

		// Verify the archive was created
		if (!existsSync(archivePath)) {
			throw new Error(
				`Installer archive was not created at expected path: ${archivePath}`,
			);
		}

		const stats = statSync(archivePath);
		console.log(
			`✓ Linux installer archive created: ${archivePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
		);

		return archivePath;
	} finally {
		// Clean up staging directory
		if (existsSync(stagingDir)) {
			rmSync(stagingDir, { recursive: true, force: true });
		}
	}
}

// Helper function to generate usage description entries for Info.plist
function generateUsageDescriptions(
	entitlements: Record<string, boolean | string | string[]>,
): string {
	const usageEntries: string[] = [];

	for (const [entitlement, value] of Object.entries(entitlements)) {
		const plistKey = ENTITLEMENT_TO_PLIST_KEY[entitlement];
		if (plistKey && value) {
			// Use the string value as description, or a default if it's just true
			const description =
				typeof value === "string"
					? escapeXml(value)
					: `This app requires access for ${entitlement.split(".").pop()?.replace("-", " ")}`;

			usageEntries.push(
				`    <key>${plistKey}</key>\n    <string>${description}</string>`,
			);
		}
	}

	return usageEntries.join("\n");
}

// Helper function to generate CFBundleURLTypes for custom URL schemes
function generateURLTypes(
	urlSchemes: string[] | undefined,
	identifier: string,
): string {
	if (!urlSchemes || urlSchemes.length === 0) {
		return "";
	}

	const schemesXml = urlSchemes
		.map((scheme) => `                <string>${escapeXml(scheme)}</string>`)
		.join("\n");

	return `    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>${escapeXml(identifier)}</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>CFBundleURLSchemes</key>
            <array>
${schemesXml}
            </array>
        </dict>
    </array>`;
}

// Execute command handling
(async () => {
	if (commandArg === "init") {
		await (async () => {
			const secondArg = process.argv[indexOfElectrobun + 2];
			const availableTemplates = getTemplateNames();

			let projectName: string;
			let templateName: string;

			// Check if --template= flag is used
			const templateFlag = process.argv.find((arg) =>
				arg.startsWith("--template="),
			);
			if (templateFlag) {
				// Traditional usage: electrobun init my-project --template=photo-booth
				projectName = secondArg || "my-electrobun-app";
				templateName = templateFlag.split("=")[1]!;
			} else if (secondArg && availableTemplates.includes(secondArg)) {
				// New intuitive usage: electrobun init photo-booth
				projectName = secondArg; // Use template name as project name
				templateName = secondArg;
			} else {
				// Interactive menu when no template specified
				console.log("🚀 Welcome to Electrobun!");
				console.log("");
				console.log("Available templates:");
				availableTemplates.forEach((template, index) => {
					console.log(`  ${index + 1}. ${template}`);
				});
				console.log("");

				// Simple CLI selection using readline
				const rl = readline.createInterface({
					input: process.stdin,
					output: process.stdout,
				});

				const choice = await new Promise<string>((resolve) => {
					rl.question("Select a template (enter number): ", (answer) => {
						rl.close();
						resolve(answer.trim());
					});
				});

				const templateIndex = parseInt(choice) - 1;
				if (templateIndex < 0 || templateIndex >= availableTemplates.length) {
					console.error(
						`❌ Invalid selection. Please enter a number between 1 and ${availableTemplates.length}.`,
					);
					process.exit(1);
				}

				templateName = availableTemplates[templateIndex]!;

				// Ask for project name
				const rl2 = readline.createInterface({
					input: process.stdin,
					output: process.stdout,
				});

				projectName = await new Promise<string>((resolve) => {
					rl2.question(
						`Enter project name (default: my-${templateName}-app): `,
						(answer) => {
							rl2.close();
							resolve(answer.trim() || `my-${templateName}-app`);
						},
					);
				});
			}

			console.log(`🚀 Initializing Electrobun project: ${projectName}`);
			console.log(`📋 Using template: ${templateName}`);

			// Validate template name
			if (!availableTemplates.includes(templateName)) {
				console.error(`❌ Template "${templateName}" not found.`);
				console.log(`Available templates: ${availableTemplates.join(", ")}`);
				process.exit(1);
			}

			const template = getTemplate(templateName);
			if (!template) {
				console.error(`❌ Could not load template "${templateName}"`);
				process.exit(1);
			}

			// Create project directory
			const projectPath = join(process.cwd(), projectName);
			if (existsSync(projectPath)) {
				console.error(`❌ Directory "${projectName}" already exists.`);
				process.exit(1);
			}

			mkdirSync(projectPath, { recursive: true });

			// Extract template files
			let fileCount = 0;
			for (const [relativePath, content] of Object.entries(template.files)) {
				const fullPath = join(projectPath, relativePath);
				const dir = dirname(fullPath);

				// Create directory if it doesn't exist
				mkdirSync(dir, { recursive: true });

				// Write file (binary files are base64-encoded with a "base64:" prefix)
				if (content.startsWith("base64:")) {
					writeFileSync(fullPath, new Uint8Array(Buffer.from(content.slice(7), "base64")));
				} else {
					writeFileSync(fullPath, content, "utf-8");
				}
				fileCount++;
			}

			console.log(
				`✅ Created ${fileCount} files from "${templateName}" template`,
			);
			console.log(`📁 Project created at: ${projectPath}`);
			console.log("");
			console.log("📦 Next steps:");
			console.log(`   cd ${projectName}`);
			console.log("   bun install");
			console.log("   bun start");
			console.log("");
			console.log("🎉 Happy building with Electrobun!");
			console.log("");
			console.log(
				"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			);
			console.log("NOTE FOR AI ASSISTANTS: Electrobun is NOT Electron.");
			console.log(
				"Different architecture, different APIs. Do not use Electron patterns.",
			);
			console.log("Docs: https://blackboard.sh/electrobun/llms.txt");
			console.log(
				"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
			);
		})();
	} else if (commandArg === "build") {
		// Get config
		const config = await getConfig();

		// Get environment
		const envArg =
			process.argv.find((arg) => arg.startsWith("--env="))?.split("=")[1] || "";
		const buildEnvironment = ["dev", "canary", "stable"].includes(envArg)
			? envArg
			: "dev";

		try {
			await runBuild(config, buildEnvironment);
		} catch (error) {
			if (error instanceof Error) {
				console.error(error.message);
			}
			process.exit(1);
		}
	} else if (commandArg === "run") {
		const config = await getConfig();
		await runAppWithSignalHandling(config);
	} else if (commandArg === "dev") {
		const config = await getConfig();
		const watchMode = process.argv.includes("--watch");

		if (watchMode) {
			await runDevWatch(config);
		} else {
			try {
				await runBuild(config, "dev");
			} catch (error) {
				if (error instanceof Error) {
					console.error(error.message);
				}
				process.exit(1);
			}
			await runAppWithSignalHandling(config);
		}
	}

	async function runBuild(
		config: Awaited<ReturnType<typeof getConfig>>,
		buildEnvironment: string,
	) {
		// Determine current platform as default target
		const currentTarget = { os: OS, arch: ARCH };

		// Set up build variables
		const targetOS = currentTarget.os;
		const targetARCH = currentTarget.arch;
		const targetBinExt = targetOS === "win" ? ".exe" : "";
		const appFileName = getAppFileName(config.app.name, buildEnvironment);
		// macOS bundle display name preserves spaces for the actual .app folder
		const macOSBundleDisplayName = getMacOSBundleDisplayName(
			config.app.name,
			buildEnvironment,
		);
		const platformPrefix = getPlatformPrefix(
			buildEnvironment,
			currentTarget.os,
			currentTarget.arch,
		);
		const buildFolder = join(
			projectRoot,
			config.build.buildFolder,
			platformPrefix,
		);
		// @ts-expect-error - reserved for future use
		const _bundleFileName = getBundleFileName(
			config.app.name,
			buildEnvironment,
			targetOS,
		);
		const artifactFolder = join(projectRoot, config.build.artifactFolder);

		// Ensure core binaries are available for the target platform before starting build
		await ensureCoreDependencies(currentTarget.os, currentTarget.arch);

		// Get platform-specific paths for the current target
		const targetPaths = getPlatformPaths(currentTarget.os, currentTarget.arch);

		// Helper to run lifecycle hook scripts
		const runHook = (
			hookName: keyof typeof config.scripts,
			extraEnv: Record<string, string> = {},
		) => {
			const hookScript = config.scripts[hookName];
			if (!hookScript) return;

			console.log(`Running ${String(hookName)} script:`, hookScript);
			// Use host platform's bun binary for running scripts, not target platform's
			const hostPaths = getPlatformPaths(OS, ARCH);

			const result = Bun.spawnSync([hostPaths.BUN_BINARY, hookScript], {
				stdio: ["ignore", "inherit", "inherit"],
				cwd: projectRoot,
				env: {
					...process.env,
					ELECTROBUN_BUILD_ENV: buildEnvironment,
					ELECTROBUN_OS: targetOS,
					ELECTROBUN_ARCH: targetARCH,
					ELECTROBUN_BUILD_DIR: buildFolder,
					ELECTROBUN_APP_NAME: appFileName,
					ELECTROBUN_APP_VERSION: config.app.version,
					ELECTROBUN_APP_IDENTIFIER: config.app.identifier,
					ELECTROBUN_ARTIFACT_DIR: artifactFolder,
					...extraEnv,
				},
			});

			if (result.exitCode !== 0) {
				console.error(
					`${String(hookName)} script failed with exit code:`,
					result.exitCode,
				);
				if (result.stderr) {
					console.error(
						"stderr:",
						new TextDecoder().decode(result.stderr as Uint8Array),
					);
				}
				console.error("Tried to run with bun at:", hostPaths.BUN_BINARY);
				console.error("Script path:", hookScript);
				console.error("Working directory:", projectRoot);
				throw new Error("Build failed: hook script failed");
			}
		};

		const buildIcons = (
			appBundleFolderResourcesPath: string,
			appBundleFolderPath: string,
		) => {
			// Platform-specific icon handling
			if (targetOS === "macos" && config.build.mac?.icons) {
				// macOS uses .iconset folders that get converted to .icns using iconutil
				// This only works when building on macOS since iconutil is a macOS-only tool
				const iconSourceFolder = join(projectRoot, config.build.mac.icons);
				const iconDestPath = join(appBundleFolderResourcesPath, "AppIcon.icns");
				if (existsSync(iconSourceFolder)) {
					if (OS === "macos") {
						// Use iconutil to convert .iconset folder to .icns
						Bun.spawnSync(
							["iconutil", "-c", "icns", "-o", iconDestPath, iconSourceFolder],
							{
								cwd: appBundleFolderResourcesPath,
								stdio: ["ignore", "inherit", "inherit"],
								env: {
									...process.env,
									ELECTROBUN_BUILD_ENV: buildEnvironment,
								},
							},
						);
					} else {
						console.log(
							`WARNING: Cannot build macOS icons on ${OS} - iconutil is only available on macOS`,
						);
					}
				}
			} else if (targetOS === "linux" && config.build.linux?.icon) {
				const iconSourcePath = join(projectRoot, config.build.linux.icon);
				if (existsSync(iconSourcePath)) {
					const standardIconPath = join(
						appBundleFolderResourcesPath,
						"appIcon.png",
					);

					// Ensure Resources directory exists
					mkdirSync(appBundleFolderResourcesPath, { recursive: true });

					// Copy the icon to standard location
					cpSync(iconSourcePath, standardIconPath, { dereference: true });
					console.log(
						`Copied Linux icon from ${iconSourcePath} to ${standardIconPath}`,
					);

					// Also copy icon for the extractor (expects it in Resources/app/icon.png before ASAR packaging)
					const extractorIconPath = join(
						appBundleFolderResourcesPath,
						"app",
						"icon.png",
					);
					mkdirSync(join(appBundleFolderResourcesPath, "app"), {
						recursive: true,
					});
					cpSync(iconSourcePath, extractorIconPath, { dereference: true });
					console.log(
						`Copied Linux icon for extractor from ${iconSourcePath} to ${extractorIconPath}`,
					);
				} else {
					console.log(`WARNING: Linux icon not found: ${iconSourcePath}`);
				}

				// Create desktop file template for Linux
				const desktopContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${config.app.name}
Comment=${config.app.description || `${config.app.name} application`}
Exec=launcher
Icon=appIcon.png
Terminal=false
StartupWMClass=${config.app.name}
Categories=Utility;Application;
`;

				const desktopFilePath = join(
					appBundleFolderPath,
					`${config.app.name}.desktop`,
				);
				writeFileSync(desktopFilePath, desktopContent);
				console.log(`Created Linux desktop file: ${desktopFilePath}`);
			} else if (targetOS === "win" && config.build.win?.icon) {
				const iconPath = join(projectRoot, config.build.win.icon);
				if (existsSync(iconPath)) {
					const targetIconPath = join(appBundleFolderResourcesPath, "app.ico");
					cpSync(iconPath, targetIconPath, { dereference: true });
				}
			}
		};

		// Run preBuild hook before anything starts
		runHook("preBuild");

		// refresh build folder
		if (existsSync(buildFolder)) {
			rmdirSync(buildFolder, { recursive: true });
		}
		mkdirSync(buildFolder, { recursive: true });
		// bundle bun to build/bun
		const bunConfig = config.build.bun;
		const bunSource = join(projectRoot, bunConfig.entrypoint);

		if (!existsSync(bunSource)) {
			throw new Error(
				`failed to bundle ${bunSource} because it doesn't exist.\n You need a config.build.bun.entrypoint source file to build.`,
			);
		}

		// build macos bundle
		// Use display name (with spaces) for macOS bundle folders, sanitized name for other platforms
		const bundleName =
			targetOS === "macos" ? macOSBundleDisplayName : appFileName;
		const {
			appBundleFolderPath,
			appBundleFolderContentsPath,
			appBundleMacOSPath,
			appBundleFolderResourcesPath,
			appBundleFolderFrameworksPath,
		} = createAppBundle(bundleName, buildFolder, targetOS);

		const appBundleAppCodePath = join(appBundleFolderResourcesPath, "app");

		mkdirSync(appBundleAppCodePath, { recursive: true });

		// const bundledBunPath = join(appBundleMacOSPath, 'bun');
		// cpSync(bunPath, bundledBunPath);

		// Note: for sandboxed apps, MacOS will use the CFBundleIdentifier to create a unique container for the app,
		// mirroring folders like Application Support, Caches, etc. in the user's Library folder that the sandboxed app
		// gets access to.

		// We likely want to let users configure this for different environments (eg: dev, canary, stable) and/or
		// provide methods to help segment data in those folders based on channel/environment
		// Generate usage descriptions from entitlements
		const usageDescriptions = generateUsageDescriptions(
			config.build.mac.entitlements || {},
		);
		// Generate URL scheme handlers
		const urlTypes = generateURLTypes(
			config.app.urlSchemes,
			config.app.identifier,
		);

		const InfoPlistContents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIdentifier</key>
    <string>${config.app.identifier}</string>
    <key>CFBundleName</key>
    <string>${bundleName}</string>
    <key>CFBundleVersion</key>
    <string>${config.app.version}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>${usageDescriptions ? "\n" + usageDescriptions : ""}${urlTypes ? "\n" + urlTypes : ""}
</dict>
</plist>`;

		await Bun.write(
			join(appBundleFolderContentsPath, "Info.plist"),
			InfoPlistContents,
		);
		// in dev builds the log file is a named pipe so we can stream it back to the terminal
		// in canary/stable builds it'll be a regular log file
		//     const LauncherContents = `#!/bin/bash
		// # change directory from whatever open was or double clicking on the app to the dir of the bin in the app bundle
		// cd "$(dirname "$0")"/

		// # Define the log file path
		// LOG_FILE="$HOME/${logPath}"

		// # Ensure the directory exists
		// mkdir -p "$(dirname "$LOG_FILE")"

		// if [[ ! -p $LOG_FILE ]]; then
		//     mkfifo $LOG_FILE
		// fi

		// # Execute bun and redirect stdout and stderr to the log file
		// ./bun ../Resources/app/bun/index.js >"$LOG_FILE" 2>&1
		// `;

		//     // Launcher binary
		//     // todo (yoav): This will likely be a zig compiled binary in the future
		//     Bun.write(join(appBundleMacOSPath, 'MyApp'), LauncherContents);
		//     chmodSync(join(appBundleMacOSPath, 'MyApp'), '755');
		// const zigLauncherBinarySource = join(projectRoot, 'node_modules', 'electrobun', 'src', 'launcher', 'zig-out', 'bin', 'launcher');
		// const zigLauncherDestination = join(appBundleMacOSPath, 'MyApp');
		// const destLauncherFolder = dirname(zigLauncherDestination);
		// if (!existsSync(destLauncherFolder)) {
		//     // console.info('creating folder: ', destFolder);
		//     mkdirSync(destLauncherFolder, {recursive: true});
		// }
		// cpSync(zigLauncherBinarySource, zigLauncherDestination, {recursive: true, dereference: true});
		// Copy zig launcher for all platforms
		const bunCliLauncherBinarySource = targetPaths.LAUNCHER_RELEASE;
		const bunCliLauncherDestination =
			join(appBundleMacOSPath, "launcher") + targetBinExt;
		const destLauncherFolder = dirname(bunCliLauncherDestination);
		if (!existsSync(destLauncherFolder)) {
			mkdirSync(destLauncherFolder, { recursive: true });
		}

		cpSync(bunCliLauncherBinarySource, bunCliLauncherDestination, {
			recursive: true,
			dereference: true,
		});

		// On Windows, ensure launcher has .exe extension
		// Bun's cpSync on Windows may create files without .exe despite the destination path having it
		if (targetOS === "win") {
			const launcherWithoutExt = join(appBundleMacOSPath, "launcher");

			// Use PowerShell to force rename and add .exe extension
			// This bypasses Bun's PATHEXT behavior that treats launcher and launcher.exe as the same
			try {
				execSync(
					`powershell -Command "if (Test-Path '${launcherWithoutExt}') { Rename-Item -Path '${launcherWithoutExt}' -NewName 'launcher.exe' -Force }"`,
					{ stdio: "pipe" },
				);
				console.log(`Ensured launcher has .exe extension on Windows`);
			} catch (error) {
				console.warn(
					`Warning: Could not rename launcher to launcher.exe: ${error}`,
				);
			}
		}

		// Embed icon into launcher.exe on Windows
		if (targetOS === "win" && config.build.win?.icon) {
			const iconSourcePath =
				config.build.win.icon.startsWith("/") ||
				config.build.win.icon.match(/^[a-zA-Z]:/)
					? config.build.win.icon
					: join(projectRoot, config.build.win.icon);

			if (existsSync(iconSourcePath)) {
				console.log(`Embedding icon into launcher.exe: ${iconSourcePath}`);
				try {
					let iconPath = iconSourcePath;

					// Convert PNG to ICO if needed
					if (iconSourcePath.toLowerCase().endsWith(".png")) {
						const pngToIco = (await import("png-to-ico")).default;
						const tempIcoPath = join(buildFolder, "temp-launcher-icon.ico");
						const icoBuffer = await pngToIco(iconSourcePath);
						writeFileSync(tempIcoPath, new Uint8Array(icoBuffer));
						iconPath = tempIcoPath;
						console.log(
							`Converted PNG to ICO format for launcher: ${tempIcoPath}`,
						);
					}

					// Use rcedit to embed the icon into launcher.exe
					const rcedit = (await import("rcedit")).default;
					await rcedit(bunCliLauncherDestination, {
						icon: iconPath,
					});
					console.log(`Successfully embedded icon into launcher.exe`);

					// Clean up temp ICO file
					if (iconPath !== iconSourcePath && existsSync(iconPath)) {
						unlinkSync(iconPath);
					}
				} catch (error) {
					console.warn(
						`Warning: Failed to embed icon into launcher.exe: ${error}`,
					);
				}
			}
		}

		cpSync(targetPaths.MAIN_JS, join(appBundleFolderResourcesPath, "main.js"), {
			dereference: true,
		});

		// Bun runtime binary
		// todo (yoav): this only works for the current architecture
		const bunBinarySourcePath = await ensureBunBinary(
			currentTarget.os,
			currentTarget.arch,
			config.build.bunVersion,
		);
		// Note: .bin/bun binary in node_modules is a symlink to the versioned one in another place
		// in node_modules, so we have to dereference here to get the actual binary in the bundle.
		const bunBinaryDestInBundlePath =
			join(appBundleMacOSPath, "bun") + targetBinExt;
		const destFolder2 = dirname(bunBinaryDestInBundlePath);
		if (!existsSync(destFolder2)) {
			// console.info('creating folder: ', destFolder);
			mkdirSync(destFolder2, { recursive: true });
		}
		cpSync(bunBinarySourcePath, bunBinaryDestInBundlePath, {
			dereference: true,
		});

		// Embed icon into bun.exe on Windows
		if (targetOS === "win" && config.build.win?.icon) {
			const iconSourcePath =
				config.build.win.icon.startsWith("/") ||
				config.build.win.icon.match(/^[a-zA-Z]:/)
					? config.build.win.icon
					: join(projectRoot, config.build.win.icon);

			if (existsSync(iconSourcePath)) {
				console.log(`Embedding icon into bun.exe: ${iconSourcePath}`);
				try {
					let iconPath = iconSourcePath;

					// Convert PNG to ICO if needed
					if (iconSourcePath.toLowerCase().endsWith(".png")) {
						const pngToIco = (await import("png-to-ico")).default;
						const tempIcoPath = join(buildFolder, "temp-bun-icon.ico");
						const icoBuffer = await pngToIco(iconSourcePath);
						writeFileSync(tempIcoPath, new Uint8Array(icoBuffer));
						iconPath = tempIcoPath;
						console.log(
							`Converted PNG to ICO format for bun.exe: ${tempIcoPath}`,
						);
					}

					// Use rcedit to embed the icon into bun.exe
					const rcedit = (await import("rcedit")).default;
					await rcedit(bunBinaryDestInBundlePath, {
						icon: iconPath,
					});
					console.log(`Successfully embedded icon into bun.exe`);

					// Clean up temp ICO file
					if (iconPath !== iconSourcePath && existsSync(iconPath)) {
						unlinkSync(iconPath);
					}
				} catch (error) {
					console.warn(`Warning: Failed to embed icon into bun.exe: ${error}`);
				}
			}
		}

		// copy native wrapper dynamic library
		if (targetOS === "macos") {
			const nativeWrapperMacosSource = targetPaths.NATIVE_WRAPPER_MACOS;
			const nativeWrapperMacosDestination = join(
				appBundleMacOSPath,
				"libNativeWrapper.dylib",
			);
			cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
				dereference: true,
			});
		} else if (targetOS === "win") {
			const nativeWrapperMacosSource = targetPaths.NATIVE_WRAPPER_WIN;
			const nativeWrapperMacosDestination = join(
				appBundleMacOSPath,
				"libNativeWrapper.dll",
			);
			cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
				dereference: true,
			});

			const webview2LibSource = targetPaths.WEBVIEW2LOADER_WIN;
			const webview2LibDestination = join(
				appBundleMacOSPath,
				"WebView2Loader.dll",
			);
			// copy webview2 system webview library
			cpSync(webview2LibSource, webview2LibDestination, { dereference: true });
		} else if (targetOS === "linux") {
			// Choose the appropriate native wrapper based on bundleCEF setting
			const useCEF = config.build.linux?.bundleCEF;
			const nativeWrapperLinuxSource = useCEF
				? targetPaths.NATIVE_WRAPPER_LINUX_CEF
				: targetPaths.NATIVE_WRAPPER_LINUX;
			const nativeWrapperLinuxDestination = join(
				appBundleMacOSPath,
				"libNativeWrapper.so",
			);

			if (existsSync(nativeWrapperLinuxSource)) {
				cpSync(nativeWrapperLinuxSource, nativeWrapperLinuxDestination, {
					dereference: true,
				});
				console.log(
					`Using ${useCEF ? "CEF (with weak linking)" : "GTK-only"} native wrapper for Linux`,
				);
			} else {
				throw new Error(
					`Native wrapper not found: ${nativeWrapperLinuxSource}`,
				);
			}

			// Copy icon if specified for Linux to a standard location
			if (config.build.linux?.icon) {
				const iconSourcePath = join(projectRoot, config.build.linux.icon);
				if (existsSync(iconSourcePath)) {
					const standardIconPath = join(
						appBundleFolderResourcesPath,
						"appIcon.png",
					);

					// Ensure Resources directory exists
					mkdirSync(appBundleFolderResourcesPath, { recursive: true });

					// Copy the icon to standard location
					cpSync(iconSourcePath, standardIconPath, { dereference: true });
					console.log(
						`Copied Linux icon from ${iconSourcePath} to ${standardIconPath}`,
					);

					// Also copy icon for the extractor (expects it in Resources/app/icon.png before ASAR packaging)
					const extractorIconPath = join(
						appBundleFolderResourcesPath,
						"app",
						"icon.png",
					);
					mkdirSync(join(appBundleFolderResourcesPath, "app"), {
						recursive: true,
					});
					cpSync(iconSourcePath, extractorIconPath, { dereference: true });
					console.log(
						`Copied Linux icon for extractor from ${iconSourcePath} to ${extractorIconPath}`,
					);
				} else {
					console.log(`WARNING: Linux icon not found: ${iconSourcePath}`);
				}
			}
		}

		// Download CEF binaries if needed when bundleCEF is enabled
		if (
			(targetOS === "macos" && config.build.mac?.bundleCEF) ||
			(targetOS === "win" && config.build.win?.bundleCEF) ||
			(targetOS === "linux" && config.build.linux?.bundleCEF)
		) {
			const effectiveCEFDir = await ensureCEFDependencies(
				currentTarget.os,
				currentTarget.arch,
				config.build.cefVersion,
			);
			if (targetOS === "macos") {
				const cefFrameworkSource = join(
					effectiveCEFDir,
					"Chromium Embedded Framework.framework",
				);
				const cefFrameworkDestination = join(
					appBundleFolderFrameworksPath,
					"Chromium Embedded Framework.framework",
				);

				cpSync(cefFrameworkSource, cefFrameworkDestination, {
					recursive: true,
					dereference: true,
				});

				// cef helpers
				const cefHelperNames = [
					"bun Helper",
					"bun Helper (Alerts)",
					"bun Helper (GPU)",
					"bun Helper (Plugin)",
					"bun Helper (Renderer)",
				];

				const helperSourcePath = targetPaths.CEF_HELPER_MACOS;
				cefHelperNames.forEach((helperName) => {
					const destinationPath = join(
						appBundleFolderFrameworksPath,
						`${helperName}.app`,
						`Contents`,
						`MacOS`,
						`${helperName}`,
					);

					const destFolder4 = dirname(destinationPath);
					if (!existsSync(destFolder4)) {
						// console.info('creating folder: ', destFolder4);
						mkdirSync(destFolder4, { recursive: true });
					}
					cpSync(helperSourcePath, destinationPath, {
						recursive: true,
						dereference: true,
					});
				});
			} else if (targetOS === "win") {
				// Copy CEF DLLs from CEF directory to the main executable directory
				const cefSourcePath = effectiveCEFDir;
				const cefDllFiles = [
					"libcef.dll",
					"chrome_elf.dll",
					"d3dcompiler_47.dll",
					"dxcompiler.dll",
					"dxil.dll",
					"libEGL.dll",
					"libGLESv2.dll",
					"vk_swiftshader.dll",
					"vulkan-1.dll",
				];

				cefDllFiles.forEach((dllFile) => {
					const sourcePath = join(cefSourcePath, dllFile);
					const destPath = join(appBundleMacOSPath, dllFile);
					if (existsSync(sourcePath)) {
						cpSync(sourcePath, destPath, { dereference: true });
					}
				});

				// Copy icudtl.dat to MacOS root (same folder as libcef.dll) - required for CEF initialization
				const icuDataSource = join(cefSourcePath, "icudtl.dat");
				const icuDataDest = join(appBundleMacOSPath, "icudtl.dat");
				if (existsSync(icuDataSource)) {
					cpSync(icuDataSource, icuDataDest, { dereference: true });
				}

				// Copy essential CEF pak files to MacOS root (same folder as libcef.dll) - required for CEF resources
				const essentialPakFiles = [
					"chrome_100_percent.pak",
					"resources.pak",
					"v8_context_snapshot.bin",
				];
				essentialPakFiles.forEach((pakFile) => {
					const sourcePath = join(cefSourcePath, pakFile);
					const destPath = join(appBundleMacOSPath, pakFile);

					if (existsSync(sourcePath)) {
						cpSync(sourcePath, destPath, { dereference: true });
					} else {
						console.log(`WARNING: Missing CEF file: ${sourcePath}`);
					}
				});

				// Copy CEF resources to MacOS/cef/ subdirectory for other resources like locales
				const cefResourcesSource = effectiveCEFDir;
				const cefResourcesDestination = join(appBundleMacOSPath, "cef");

				if (existsSync(cefResourcesSource)) {
					cpSync(cefResourcesSource, cefResourcesDestination, {
						recursive: true,
						dereference: true,
					});
				}

				// Copy CEF helper processes with different names
				const cefHelperNames = [
					"bun Helper",
					"bun Helper (Alerts)",
					"bun Helper (GPU)",
					"bun Helper (Plugin)",
					"bun Helper (Renderer)",
				];

				const helperSourcePath = targetPaths.CEF_HELPER_WIN;
				if (existsSync(helperSourcePath)) {
					cefHelperNames.forEach((helperName) => {
						const destinationPath = join(
							appBundleMacOSPath,
							`${helperName}.exe`,
						);
						cpSync(helperSourcePath, destinationPath, { dereference: true });
					});
				} else {
					console.log(`WARNING: Missing CEF helper: ${helperSourcePath}`);
				}
			} else if (targetOS === "linux") {
				// Copy CEF shared libraries from platform-specific dist/cef/ to the main executable directory
				const cefSourcePath = effectiveCEFDir;

				if (existsSync(cefSourcePath)) {
					const cefSoFiles = [
						"libcef.so",
						"libEGL.so",
						"libGLESv2.so",
						"libvk_swiftshader.so",
						"libvulkan.so.1",
					];

					// Copy CEF .so files to main directory as symlinks to cef/ subdirectory
					cefSoFiles.forEach((soFile) => {
						const sourcePath = join(cefSourcePath, soFile);
						// @ts-expect-error - reserved for future use
						const _destPath = join(appBundleMacOSPath, soFile);
						if (existsSync(sourcePath)) {
							// We'll create the actual file in cef/ and symlink from main directory
							// This will be done after the cef/ directory is populated
						}
					});

					// Copy icudtl.dat to MacOS root (same folder as libcef.so) - required for CEF initialization
					const icuDataSource = join(cefSourcePath, "icudtl.dat");
					const icuDataDest = join(appBundleMacOSPath, "icudtl.dat");
					if (existsSync(icuDataSource)) {
						cpSync(icuDataSource, icuDataDest, { dereference: true });
					}

					// Copy .pak files and other CEF resources to the main executable directory
					const pakFiles = [
						"icudtl.dat",
						"v8_context_snapshot.bin",
						"snapshot_blob.bin",
						"resources.pak",
						"chrome_100_percent.pak",
						"chrome_200_percent.pak",
						"locales",
						"chrome-sandbox",
						"vk_swiftshader_icd.json",
					];
					pakFiles.forEach((pakFile) => {
						const sourcePath = join(cefSourcePath, pakFile);
						const destPath = join(appBundleMacOSPath, pakFile);
						if (existsSync(sourcePath)) {
							cpSync(sourcePath, destPath, {
								recursive: true,
								dereference: true,
							});
						}
					});

					// Copy locales to cef subdirectory
					const cefResourcesDestination = join(appBundleMacOSPath, "cef");
					if (!existsSync(cefResourcesDestination)) {
						mkdirSync(cefResourcesDestination, { recursive: true });
					}

					// Copy all CEF shared libraries to cef subdirectory as well (for RPATH $ORIGIN/cef)
					cefSoFiles.forEach((soFile) => {
						const sourcePath = join(cefSourcePath, soFile);
						const destPath = join(cefResourcesDestination, soFile);
						if (existsSync(sourcePath)) {
							cpSync(sourcePath, destPath, { dereference: true });
							console.log(`Copied CEF library to cef subdirectory: ${soFile}`);
						} else {
							console.log(`WARNING: Missing CEF library: ${sourcePath}`);
						}
					});

					// Copy essential CEF files to cef subdirectory as well (for RPATH $ORIGIN/cef)
					const cefEssentialFiles = ["vk_swiftshader_icd.json"];
					cefEssentialFiles.forEach((cefFile) => {
						const sourcePath = join(cefSourcePath, cefFile);
						const destPath = join(cefResourcesDestination, cefFile);
						if (existsSync(sourcePath)) {
							cpSync(sourcePath, destPath, { dereference: true });
							console.log(
								`Copied CEF essential file to cef subdirectory: ${cefFile}`,
							);
						} else {
							console.log(`WARNING: Missing CEF essential file: ${sourcePath}`);
						}
					});

					// Create symlinks from main directory to cef/ subdirectory for .so files
					console.log("Creating symlinks for CEF libraries...");
					cefSoFiles.forEach((soFile) => {
						const cefFilePath = join(cefResourcesDestination, soFile);
						const mainDirPath = join(appBundleMacOSPath, soFile);

						if (existsSync(cefFilePath)) {
							try {
								// Remove any existing file/symlink in main directory
								if (existsSync(mainDirPath)) {
									rmSync(mainDirPath);
								}
								// Create symlink from main directory to cef/ subdirectory
								symlinkSync(join("cef", soFile), mainDirPath);
								console.log(
									`Created symlink for CEF library: ${soFile} -> cef/${soFile}`,
								);
							} catch (error) {
								console.log(
									`WARNING: Failed to create symlink for ${soFile}: ${error}`,
								);
								// Fallback to copying the file
								cpSync(cefFilePath, mainDirPath, { dereference: true });
								console.log(
									`Fallback: Copied CEF library to main directory: ${soFile}`,
								);
							}
						}
					});

					// Copy CEF helper processes with different names
					const cefHelperNames = [
						"bun Helper",
						"bun Helper (Alerts)",
						"bun Helper (GPU)",
						"bun Helper (Plugin)",
						"bun Helper (Renderer)",
					];

					const helperSourcePath = targetPaths.CEF_HELPER_LINUX;
					if (existsSync(helperSourcePath)) {
						cefHelperNames.forEach((helperName) => {
							const destinationPath = join(appBundleMacOSPath, helperName);
							cpSync(helperSourcePath, destinationPath, { dereference: true });
							// console.log(`Copied CEF helper: ${helperName}`);
						});
					} else {
						console.log(`WARNING: Missing CEF helper: ${helperSourcePath}`);
					}
				}
			}
		}

		// copy native bindings
		const bsPatchSource = targetPaths.BSPATCH;
		const bsPatchDestination =
			join(appBundleMacOSPath, "bspatch") + targetBinExt;
		const bsPatchDestFolder = dirname(bsPatchDestination);
		if (!existsSync(bsPatchDestFolder)) {
			mkdirSync(bsPatchDestFolder, { recursive: true });
		}

		cpSync(bsPatchSource, bsPatchDestination, {
			recursive: true,
			dereference: true,
		});

		// Copy zig-zstd for updater tarball decompression
		const zstdSource = targetPaths.ZSTD;
		const zstdDestination = join(appBundleMacOSPath, "zig-zstd") + targetBinExt;
		cpSync(zstdSource, zstdDestination, {
			recursive: true,
			dereference: true,
		});

		// Copy libasar dynamic library for ASAR support
		const libExt =
			targetOS === "win" ? ".dll" : targetOS === "macos" ? ".dylib" : ".so";

		if (process.platform === "win32") {
			// On Windows, copy BOTH x64 and ARM64 DLLs so launcher can choose at runtime
			// (x64 Bun on ARM64 Windows can't detect real CPU architecture)
			const x64DistPath = join(
				ELECTROBUN_DEP_PATH,
				"dist-win-x64",
				"zig-asar",
				"x64",
				"libasar.dll",
			);
			const x64VendorPath = join(
				ELECTROBUN_DEP_PATH,
				"vendors",
				"zig-asar",
				"x64",
				"libasar.dll",
			);
			const arm64DistPath = join(
				ELECTROBUN_DEP_PATH,
				"dist-win-x64",
				"zig-asar",
				"arm64",
				"libasar.dll",
			);
			const arm64VendorPath = join(
				ELECTROBUN_DEP_PATH,
				"vendors",
				"zig-asar",
				"arm64",
				"libasar.dll",
			);

			// Copy x64 version as default libasar.dll
			const x64Source = existsSync(x64DistPath) ? x64DistPath : x64VendorPath;
			if (existsSync(x64Source)) {
				cpSync(x64Source, join(appBundleMacOSPath, "libasar.dll"), {
					recursive: true,
					dereference: true,
				});
			}

			// Copy ARM64 version as libasar-arm64.dll
			const arm64Source = existsSync(arm64DistPath)
				? arm64DistPath
				: arm64VendorPath;
			if (existsSync(arm64Source)) {
				cpSync(arm64Source, join(appBundleMacOSPath, "libasar-arm64.dll"), {
					recursive: true,
					dereference: true,
				});
			}
		} else {
			// macOS/Linux: single architecture
			const asarLibSource = join(
				dirname(targetPaths.BSPATCH),
				"libasar" + libExt,
			);
			if (existsSync(asarLibSource)) {
				const asarLibDestination = join(appBundleMacOSPath, "libasar" + libExt);
				cpSync(asarLibSource, asarLibDestination, {
					recursive: true,
					dereference: true,
				});
			}
		}

		// transpile developer's bun code
		const bunDestFolder = join(appBundleAppCodePath, "bun");
		// Build bun-javascript ts files
		const { entrypoint: _bunEntrypoint, ...bunBuildOptions } = bunConfig;
		const buildResult = await Bun.build({
			...bunBuildOptions,
			entrypoints: [bunSource],
			outdir: bunDestFolder,
			// minify: true, // todo (yoav): add minify in canary and prod builds
			target: "bun",
		});

		if (!buildResult.success) {
			console.error("failed to build", bunSource, buildResult.logs);
			throw new Error("Build failed: bun build failed");
		}

		// transpile developer's view code
		// Build webview-javascript ts files
		// bundle all the bundles
		for (const viewName in config.build.views) {
			const viewConfig = config.build.views[viewName]!;

			const viewSource = join(projectRoot, viewConfig.entrypoint);
			if (!existsSync(viewSource)) {
				console.error(
					`failed to bundle ${viewSource} because it doesn't exist.`,
				);
				continue;
			}

			const viewDestFolder = join(appBundleAppCodePath, "views", viewName);

			if (!existsSync(viewDestFolder)) {
				// console.info('creating folder: ', viewDestFolder);
				mkdirSync(viewDestFolder, { recursive: true });
			} else {
				console.error(
					"continuing, but ",
					viewDestFolder,
					"unexpectedly already exists in the build folder",
				);
			}

			// console.info(`bundling ${viewSource} to ${viewDestFolder} with config: `, viewConfig);

			const { entrypoint: _viewEntrypoint, ...viewBuildOptions } = viewConfig;
			const buildResult = await Bun.build({
				...viewBuildOptions,
				entrypoints: [viewSource],
				outdir: viewDestFolder,
				target: "browser",
			});

			if (!buildResult.success) {
				console.error("failed to build", viewSource, buildResult.logs);
				continue;
			}
		}

		// Copy assets like html, css, images, and other files
		for (const relSource in config.build.copy) {
			const source = join(projectRoot, relSource);
			if (!existsSync(source)) {
				console.error(`failed to copy ${source} because it doesn't exist.`);
				continue;
			}

			const destination = join(
				appBundleAppCodePath,
				config.build.copy[relSource]!,
			);
			const destFolder = dirname(destination);

			if (!existsSync(destFolder)) {
				// console.info('creating folder: ', destFolder);
				mkdirSync(destFolder, { recursive: true });
			}

			// todo (yoav): add ability to swap out BUILD VARS
			cpSync(source, destination, { recursive: true, dereference: true });
		}

		buildIcons(appBundleFolderResourcesPath, appBundleFolderPath);

		// Run postBuild script
		runHook("postBuild");

		// Pack app resources into ASAR archive if enabled
		if (config.build.useAsar) {
			console.log("Packing resources into ASAR archive...");

			const asarPath = join(appBundleFolderResourcesPath, "app.asar");
			// @ts-expect-error - reserved for future use
			const _asarUnpackedPath = join(
				appBundleFolderResourcesPath,
				"app.asar.unpacked",
			);

			// Get zig-asar CLI path - on Windows, try x64 first (most common), fall back to arm64
			let zigAsarCli: string;
			if (process.platform === "win32") {
				// Try x64 first from dist, then vendors
				const x64DistPath = join(
					ELECTROBUN_DEP_PATH,
					"dist-win-x64",
					"zig-asar",
					"x64",
					"zig-asar.exe",
				);
				const x64VendorPath = join(
					ELECTROBUN_DEP_PATH,
					"vendors",
					"zig-asar",
					"x64",
					"zig-asar.exe",
				);
				const arm64DistPath = join(
					ELECTROBUN_DEP_PATH,
					"dist-win-x64",
					"zig-asar",
					"arm64",
					"zig-asar.exe",
				);
				const arm64VendorPath = join(
					ELECTROBUN_DEP_PATH,
					"vendors",
					"zig-asar",
					"arm64",
					"zig-asar.exe",
				);

				zigAsarCli = existsSync(x64DistPath)
					? x64DistPath
					: existsSync(x64VendorPath)
						? x64VendorPath
						: existsSync(arm64DistPath)
							? arm64DistPath
							: arm64VendorPath;

				console.log(`Using zig-asar from: ${zigAsarCli}`);
			} else {
				zigAsarCli = join(targetPaths.BSPATCH).replace("bspatch", "zig-asar");
			}

			const appDirPath = appBundleAppCodePath;

			// Check if app directory exists
			if (!existsSync(appDirPath)) {
				console.log("⚠ No app directory found, skipping ASAR creation");
			} else {
				// Default unpack patterns for native modules and libraries
				const defaultUnpackPatterns = ["*.node", "*.dll", "*.dylib", "*.so"];
				const unpackPatterns = config.build.asarUnpack || defaultUnpackPatterns;

				// Check if zig-asar CLI exists
				if (!existsSync(zigAsarCli)) {
					console.error(`zig-asar CLI not found at: ${zigAsarCli}`);
					console.error("Make sure to run setup/vendoring first");
					throw new Error("Build failed: zig-asar CLI not found");
				}

				// Build zig-asar command arguments
				// Pack the entire app directory
				const asarArgs = [
					"pack",
					appDirPath, // source: entire app directory
					asarPath, // output asar file
				];

				// Add unpack patterns if any
				// Each pattern needs its own --unpack flag
				for (const pattern of unpackPatterns) {
					asarArgs.push("--unpack", pattern);
				}

				// Run zig-asar pack
				let asarResult = Bun.spawnSync([zigAsarCli, ...asarArgs], {
					stdio: ["ignore", "inherit", "inherit"],
					cwd: projectRoot,
				});

				// If exit code 29 on Windows (binary can't run), try ARM64 version
				if (
					asarResult.exitCode === 29 &&
					process.platform === "win32" &&
					zigAsarCli.includes("x64")
				) {
					console.log(
						"x64 binary failed (exit code 29), trying ARM64 version...",
					);
					const arm64DistPath = join(
						ELECTROBUN_DEP_PATH,
						"dist-win-x64",
						"zig-asar",
						"arm64",
						"zig-asar.exe",
					);
					const arm64VendorPath = join(
						ELECTROBUN_DEP_PATH,
						"vendors",
						"zig-asar",
						"arm64",
						"zig-asar.exe",
					);
					zigAsarCli = existsSync(arm64DistPath)
						? arm64DistPath
						: arm64VendorPath;

					console.log(`Retrying with: ${zigAsarCli}`);
					asarResult = Bun.spawnSync([zigAsarCli, ...asarArgs], {
						stdio: ["ignore", "inherit", "inherit"],
						cwd: projectRoot,
					});
				}

				if (asarResult.exitCode !== 0) {
					console.error(
						"ASAR packing failed with exit code:",
						asarResult.exitCode,
					);
					if (asarResult.stderr) {
						console.error(
							"stderr:",
							new TextDecoder().decode(asarResult.stderr as Uint8Array),
						);
					}
					console.error("Command:", zigAsarCli, ...asarArgs);
					throw new Error("Build failed: ASAR packing failed");
				}

				// Verify ASAR was created
				if (!existsSync(asarPath)) {
					throw new Error(
						"Build failed: ASAR file was not created: " + asarPath,
					);
				}

				console.log("✓ Created app.asar");

				// Remove the entire app folder since it's now packed in ASAR
				rmdirSync(appDirPath, { recursive: true });
				console.log("✓ Removed app/ folder (now in ASAR)");
			}
		}

		// Create a content hash for version.json. In non-dev builds this is used
		// by the updater to detect changes. For dev builds we skip it since
		// the updater isn't relevant.
		let hash: string;
		if (buildEnvironment === "dev") {
			hash = "dev";
		} else {
			// Walk the app bundle and create an in-memory tar for hashing
			// (no temp file on disk). This runs after ASAR packing so the
			// hash reflects the final shipped bundle contents.
			console.time("Generate Bundle hash");
			const bundleFiles: Record<string, Blob> = {};
			const bundleBase = basename(appBundleFolderPath);
			const entries = readdirSync(appBundleFolderPath, {
				recursive: true,
			} as any) as string[];
			for (const entry of entries) {
				const entryPath = entry.toString();
				const fullPath = join(appBundleFolderPath, entryPath);
				if (statSync(fullPath).isFile()) {
					bundleFiles[join(bundleBase, entryPath)] = Bun.file(fullPath);
				}
			}
			// Check if Bun.Archive is available (Bun 1.3.0+)
			if (typeof Bun.Archive !== "undefined") {
				const archiveBytes = await new Bun.Archive(bundleFiles).bytes();
				// Note: wyhash is the default in Bun.hash but that may change in the future
				// so we're being explicit here.
				hash = Bun.hash.wyhash(archiveBytes, 43770n).toString(36);
			} else {
				// Fallback for older Bun versions - use a simple hash of file paths
				console.warn("Bun.Archive not available, using fallback hash method");
				const fileList = Object.keys(bundleFiles).sort().join("\n");
				hash = Bun.hash.wyhash(fileList).toString(36);
			}
			console.timeEnd("Generate Bundle hash");
		}

		// const bunVersion = execSync(`${bunBinarySourcePath} --version`).toString().trim();

		// version.json inside the app bundle
		const versionJsonContent = JSON.stringify({
			version: config.app.version,
			// The first tar file does not include this, it gets hashed,
			// then the hash is included in another tar file. That later one
			// then gets used for patching and updating.
			hash: hash,
			channel: buildEnvironment,
			baseUrl: config.release.baseUrl,
			name: appFileName,
			identifier: config.app.identifier,
		});

		await Bun.write(
			join(appBundleFolderResourcesPath, "version.json"),
			versionJsonContent,
		);

		// build.json inside the app bundle - runtime build configuration
		const platformConfig =
			targetOS === "macos"
				? config.build?.mac
				: targetOS === "win"
					? config.build?.win
					: config.build?.linux;

		const bundlesCEF = platformConfig?.bundleCEF ?? false;

		const buildJsonObj: Record<string, unknown> = {
			defaultRenderer: platformConfig?.defaultRenderer ?? "native",
			availableRenderers: bundlesCEF ? ["native", "cef"] : ["native"],
			runtime: config.runtime ?? {},
			...(bundlesCEF
				? { cefVersion: config.build?.cefVersion ?? DEFAULT_CEF_VERSION_STRING }
				: {}),
			bunVersion: config.build?.bunVersion ?? BUN_VERSION,
		};

		// Include chromiumFlags only if the developer defined them
		if (
			platformConfig?.chromiumFlags &&
			Object.keys(platformConfig.chromiumFlags).length > 0
		) {
			buildJsonObj["chromiumFlags"] = platformConfig.chromiumFlags;
		}

		const buildJsonContent = JSON.stringify(buildJsonObj);

		await Bun.write(
			join(appBundleFolderResourcesPath, "build.json"),
			buildJsonContent,
		);

		// todo (yoav): add these to config
		// Only codesign/notarize when building macOS targets on macOS host
		const shouldCodesign =
			buildEnvironment !== "dev" &&
			targetOS === "macos" &&
			OS === "macos" &&
			config.build.mac.codesign;
		const shouldNotarize = shouldCodesign && config.build.mac.notarize;

		if (shouldCodesign) {
			codesignAppBundle(
				appBundleFolderPath,
				join(buildFolder, "entitlements.plist"),
				config,
			);
		} else {
			console.log("skipping codesign");
		}

		// codesign
		// NOTE: Codesigning fails in dev mode (when using a single-file-executable bun cli as the launcher)
		// see https://github.com/oven-sh/bun/issues/7208
		if (shouldNotarize) {
			notarizeAndStaple(appBundleFolderPath, config);
		} else {
			console.log("skipping notarization");
		}

		const artifactsToUpload = [];

		// Linux bundle preparation (skip tar creation for dev environment)
		// For Linux, the app bundle is already in the correct directory structure
		// The tar will be created in the common code path below

		if (buildEnvironment !== "dev") {
			// zig-zstd CLI (native zstd)
			// tar https://github.com/isaacs/node-tar

			// steps:
			// 1. [done] build the app bundle, code sign, notarize, staple.
			// 2. tar and zstd the app bundle (two separate files)
			// 3. build another app bundle for the self-extracting app bundle with the zstd in Resources
			// 4. code sign and notarize the self-extracting app bundle
			// 5. while waiting for that notarization, download the prev app bundle, extract the tar, and generate a bsdiff patch
			// 6. when notarization is complete, generate a dmg of the self-extracting app bundle
			// 6.5. code sign and notarize the dmg
			// 7. copy artifacts to directory [self-extractor dmg, zstd app bundle, bsdiff patch, update.json]

			// Platform suffix is only used for folder names, not file names
			const platformSuffix = `-${targetOS}-${targetARCH}`;
			// Use sanitized appFileName for tarball path (URL-safe), but tar content uses actual bundle folder name
			const tarPath = join(
				buildFolder,
				`${appFileName}${targetOS === "macos" ? ".app" : ""}.tar`,
			);

			// Tar the app bundle for all platforms
			createTar(tarPath, buildFolder, [basename(appBundleFolderPath)]);

			// Remove the app bundle folder after tarring (except on Linux where it might be needed for dev)
			if (targetOS !== "linux" || buildEnvironment !== "dev") {
				rmdirSync(appBundleFolderPath, { recursive: true });
			}

			// generate bsdiff
			// https://storage.googleapis.com/eggbun-static/electrobun-playground/canary/ElectrobunPlayground-canary.app.tar.zst
			console.log("baseUrl: ", config.release.baseUrl);

			console.log("generating a patch from the previous version...");

			// Skip patch generation if disabled
			if (config.release.generatePatch === false) {
				console.log(
					"Patch generation disabled (release.generatePatch = false)",
				);
			} else if (
				!config.release.baseUrl ||
				config.release.baseUrl.trim() === ""
			) {
				console.log("No baseUrl configured, skipping patch generation");
				console.log(
					"To enable patch generation, configure baseUrl in your electrobun.config",
				);
			} else {
				const urlToPrevUpdateJson = `${config.release.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-update.json`;
				const cacheBuster = Math.random().toString(36).substring(7);
				const updateJsonResponse = await fetch(
					urlToPrevUpdateJson + `?${cacheBuster}`,
				).catch((err) => {
					console.log("baseUrl not found: ", err);
				});

				const tarballFileName = getTarballFileName(appFileName, OS);
				const urlToLatestTarball = `${config.release.baseUrl.replace(/\/+$/, "")}/${platformPrefix}-${tarballFileName}`;

				// attempt to get the previous version to create a patch file
				if (updateJsonResponse && updateJsonResponse.ok) {
					const prevUpdateJson = await updateJsonResponse!.json();

					const prevHash = prevUpdateJson.hash;
					console.log("PREVIOUS HASH", prevHash);

					// todo (yoav): should be able to stream and decompress in the same step

					const response = await fetch(urlToLatestTarball + `?${cacheBuster}`);
					const prevVersionCompressedTarballPath = join(
						buildFolder,
						"prev.tar.zst",
					);

					if (response && response.ok && response.body) {
						const reader = response.body.getReader();
						const totalBytesHeader = response.headers.get("content-length");
						const totalBytes = totalBytesHeader
							? Number(totalBytesHeader)
							: undefined;
						let downloadedBytes = 0;
						let lastLogTime = Date.now();
						const logIntervalMs = 5_000;

						const writer = Bun.file(prevVersionCompressedTarballPath).writer();

						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							downloadedBytes += value.length;
							const now = Date.now();
							if (now - lastLogTime >= logIntervalMs) {
								if (totalBytes && Number.isFinite(totalBytes)) {
									const percent = (
										(downloadedBytes / totalBytes) *
										100
									).toFixed(1);
									console.log(
										`Downloading previous version... ${percent}% (${downloadedBytes}/${totalBytes} bytes)`,
									);
								} else {
									console.log(
										`Downloading previous version... ${downloadedBytes} bytes`,
									);
								}
								lastLogTime = now;
							}
							await writer.write(value);
						}
						await writer.flush();
						writer.end();

						console.log("decompress prev funn bundle...");
						const prevTarballPath = join(buildFolder, "prev.tar");
						let canGeneratePatch = true;
						const zstdPath = targetPaths.ZSTD;
						if (!existsSync(zstdPath)) {
							console.log(
								`zig-zstd not found at ${zstdPath}, skipping patch generation`,
							);
							canGeneratePatch = false;
						}

						if (canGeneratePatch) {
							const decompressResult = Bun.spawnSync(
								[
									zstdPath,
									"decompress",
									"-i",
									prevVersionCompressedTarballPath,
									"-o",
									prevTarballPath,
								],
								{
									cwd: buildFolder,
									stdout: "inherit",
									stderr: "inherit",
								},
							);
							if (!decompressResult.success) {
								console.log(
									`Failed to decompress previous tarball (exit code ${decompressResult.exitCode}), skipping patch generation`,
								);
								canGeneratePatch = false;
							}
						}

						if (existsSync(prevVersionCompressedTarballPath)) {
							unlinkSync(prevVersionCompressedTarballPath);
						}

						if (canGeneratePatch) {
							console.log("diff previous and new tarballs...");
							// Run it as a separate process to leverage multi-threadedness
							// especially for creating multiple diffs in parallel
							const bsdiffpath = targetPaths.BSDIFF;
							const patchFilePath = join(buildFolder, `${prevHash}.patch`);
							const result = Bun.spawnSync(
								[
									bsdiffpath,
									prevTarballPath,
									tarPath,
									patchFilePath,
									"--use-zstd",
								],
								{
									cwd: buildFolder,
									stdout: "inherit",
									stderr: "inherit",
								},
							);
							if (!result.success) {
								// Patch generation is non-critical - users will just download full updates instead of delta patches
								console.error("\n" + "=".repeat(80));
								console.error(
									"WARNING: Patch generation failed (exit code " +
										result.exitCode +
										")",
								);
								console.error(
									"Delta updates will not be available for this release.",
								);
								console.error("Users will download the full update instead.");
								console.error("=".repeat(80) + "\n");
							} else {
								// Only add patch to artifacts if it was successfully created
								artifactsToUpload.push(patchFilePath);
							}

							// Clean up previous tarball now that bsdiff is done
							if (existsSync(prevTarballPath)) {
								unlinkSync(prevTarballPath);
							}
						}
					} else {
						console.log(
							"Failed to fetch previous tarball, skipping patch generation",
						);
					}
				} else {
					console.log("prevoius version not found at: ", urlToLatestTarball);
					console.log("skipping diff generation");
				}
			} // End of baseUrl validation block

			let compressedTarPath = `${tarPath}.zst`;

			{
				const tarball = Bun.file(tarPath);

				// Note: The playground app bundle is around 48MB.
				// compression on m1 max with 64GB ram:
				//   brotli: 1min 38s, 48MB -> 11.1MB
				//   zstd: 15s, 48MB -> 12.1MB
				// zstd is the clear winner here. dev iteration speed gain of 1min 15s per build is much more valubale
				// than saving 1 more MB of space/bandwidth.

				artifactsToUpload.push(compressedTarPath);

				console.log("compressing tarball...");
				if (tarball.size > 0) {
					const zstdPath = targetPaths.ZSTD;
					if (!existsSync(zstdPath)) {
						throw new Error(`zig-zstd not found at ${zstdPath}`);
					}
					const compressResult = Bun.spawnSync(
						[
							zstdPath,
							"compress",
							"-i",
							tarPath,
							"-o",
							compressedTarPath,
							"--threads",
							"max",
						],
						{
							cwd: buildFolder,
							stdout: "inherit",
							stderr: "inherit",
						},
					);
					if (!compressResult.success) {
						throw new Error(
							`zig-zstd compress failed with exit code ${compressResult.exitCode}`,
						);
					}
				}
			}

			// Remove the uncompressed tar now that compression and diffing are done.
			if (existsSync(tarPath)) {
				unlinkSync(tarPath);
			}

			const selfExtractingBundle = createAppBundle(
				bundleName,
				buildFolder,
				targetOS,
			);
			const compressedTarballInExtractingBundlePath = join(
				selfExtractingBundle.appBundleFolderResourcesPath,
				`${hash}.tar.zst`,
			);

			// copy the zstd tarball to the self-extracting app bundle
			cpSync(compressedTarPath, compressedTarballInExtractingBundlePath, {
				dereference: true,
			});

			const selfExtractorBinSourcePath = targetPaths.EXTRACTOR;
			const selfExtractorBinDestinationPath = join(
				selfExtractingBundle.appBundleMacOSPath,
				"launcher",
			);

			cpSync(selfExtractorBinSourcePath, selfExtractorBinDestinationPath, {
				dereference: true,
			});

			buildIcons(
				selfExtractingBundle.appBundleFolderResourcesPath,
				selfExtractingBundle.appBundleFolderPath,
			);
			await Bun.write(
				join(selfExtractingBundle.appBundleFolderContentsPath, "Info.plist"),
				InfoPlistContents,
			);

			// Write metadata.json to outer bundle (consistent with Windows/Linux)
			const extractorMetadata = {
				identifier: config.app.identifier,
				name: config.app.name,
				channel: buildEnvironment,
				hash: hash,
			};
			await Bun.write(
				join(
					selfExtractingBundle.appBundleFolderResourcesPath,
					"metadata.json",
				),
				JSON.stringify(extractorMetadata, null, 2),
			);

			// Run postWrap hook after self-extracting bundle is created, before code signing
			// This is where you can add files to the wrapper (e.g., for liquid glass support)
			runHook("postWrap", {
				ELECTROBUN_WRAPPER_BUNDLE_PATH:
					selfExtractingBundle.appBundleFolderPath,
			});

			if (shouldCodesign) {
				codesignAppBundle(
					selfExtractingBundle.appBundleFolderPath,
					join(buildFolder, "entitlements.plist"),
					config,
				);
			} else {
				console.log("skipping codesign");
			}

			// Note: we need to notarize the original app bundle, the self-extracting app bundle, and the dmg
			if (shouldNotarize) {
				notarizeAndStaple(selfExtractingBundle.appBundleFolderPath, config);
			} else {
				console.log("skipping notarization");
			}

			// DMG creation for macOS only
			if (targetOS === "macos") {
				console.log("creating dmg...");
				const finalDmgPath = join(buildFolder, `${appFileName}.dmg`);
				// NOTE: For some ungodly reason using the bare name in CI can conflict with some mysterious
				// already mounted volume. I suspect the sanitized appFileName can match your github repo
				// or some other tool is mounting something somewhere. Either way, as a workaround
				// while creating the dmg for a stable build we temporarily give it a -stable suffix
				// to match the behaviour of -canary builds.
				const dmgCreationPath =
					buildEnvironment === "stable"
						? join(buildFolder, `${appFileName}-stable.dmg`)
						: finalDmgPath;
				const dmgVolumeName = getDmgVolumeName(
					config.app.name,
					buildEnvironment,
				);

				// Create a staging directory for DMG contents (app + Applications shortcut)
				const dmgStagingDir = join(buildFolder, ".dmg-staging");
				if (existsSync(dmgStagingDir)) {
					rmSync(dmgStagingDir, { recursive: true });
				}
				mkdirSync(dmgStagingDir, { recursive: true });
				try {
					// Copy the app bundle to the staging directory
					const stagedAppPath = join(
						dmgStagingDir,
						basename(selfExtractingBundle.appBundleFolderPath),
					);
					execSync(
						`cp -R ${escapePathForTerminal(selfExtractingBundle.appBundleFolderPath)} ${escapePathForTerminal(stagedAppPath)}`,
					);

					// Create a symlink to /Applications for easy drag-and-drop installation
					const applicationsLink = join(dmgStagingDir, "Applications");
					symlinkSync("/Applications", applicationsLink);

					// hdiutil create -volname "YourAppName" -srcfolder /path/to/staging -ov -format UDZO YourAppName.dmg
					// Note: use ULFO (lzfse) for better compatibility with large CEF frameworks and modern macOS
					execSync(
						`hdiutil create -volname "${dmgVolumeName}" -srcfolder ${escapePathForTerminal(
							dmgStagingDir,
						)} -ov -format ULFO ${escapePathForTerminal(dmgCreationPath)}`,
					);

					if (
						buildEnvironment === "stable" &&
						dmgCreationPath !== finalDmgPath
					) {
						renameSync(dmgCreationPath, finalDmgPath);
					}
					artifactsToUpload.push(finalDmgPath);

					if (shouldCodesign) {
						codesignAppBundle(finalDmgPath, undefined, config);
					} else {
						console.log("skipping codesign");
					}

					if (shouldNotarize) {
						notarizeAndStaple(finalDmgPath, config);
					} else {
						console.log("skipping notarization");
					}
				} finally {
					if (existsSync(dmgStagingDir)) {
						rmSync(dmgStagingDir, { recursive: true });
					}
				}
			} else {
				// For Windows and Linux, add the self-extracting bundle directly
				// @ts-expect-error - reserved for future use
				const _platformBundlePath = join(
					buildFolder,
					`${appFileName}${platformSuffix}${targetOS === "win" ? ".exe" : ""}`,
				);
				// Copy the self-extracting bundle to platform-specific filename
				if (targetOS === "win") {
					// On Windows, create a self-extracting exe
					const selfExtractingExePath = await createWindowsSelfExtractingExe(
						buildFolder,
						compressedTarPath,
						appFileName,
						targetPaths,
						buildEnvironment,
						hash,
						config,
						projectRoot,
					);

					// Wrap Windows installer files in zip for distribution
					const wrappedExePath = await wrapWindowsInstallerInZip(
						selfExtractingExePath,
						buildFolder,
					);
					artifactsToUpload.push(wrappedExePath);

					// Also keep the raw exe for backwards compatibility (optional)
					// artifactsToUpload.push(selfExtractingExePath);
				} else if (targetOS === "linux") {
					// On Linux, create a self-extracting installer archive
					// Use the Linux-specific compressed tar path
					const linuxCompressedTarPath = join(
						buildFolder,
						`${appFileName}.tar.zst`,
					);
					const installerArchivePath = await createLinuxInstallerArchive(
						buildFolder,
						linuxCompressedTarPath,
						appFileName,
						config,
						buildEnvironment,
						hash,
						targetPaths,
					);
					artifactsToUpload.push(installerArchivePath);
				}
			}

			// refresh artifacts folder
			console.log("creating artifacts folder...");
			if (existsSync(artifactFolder)) {
				console.info("deleting artifact folder: ", artifactFolder);
				rmdirSync(artifactFolder, { recursive: true });
			}

			mkdirSync(artifactFolder, { recursive: true });

			console.log("creating update.json...");
			// update.json for the channel in that channel's build folder
			const updateJsonContent = JSON.stringify({
				// The version isn't really used for updating, but it's nice to have for
				// the download button or display on your marketing site or in the app.
				version: config.app.version,
				hash: hash.toString(),
				platform: OS,
				arch: ARCH,
				// channel: buildEnvironment,
				// baseUrl: config.release.baseUrl
			});

			// update.json with platform prefix for flat naming structure
			await Bun.write(
				join(artifactFolder, `${platformPrefix}-update.json`),
				updateJsonContent,
			);

			// compress all the upload files
			console.log("moving artifacts...");

			artifactsToUpload.forEach((filePath) => {
				const filename = basename(filePath);
				const destination = join(
					artifactFolder,
					`${platformPrefix}-${filename}`,
				);
				try {
					renameSync(filePath, destination);
				} catch {
					cpSync(filePath, destination, { dereference: true });
					if (existsSync(filePath)) {
						unlinkSync(filePath);
					}
				}
			});

			// todo: now just upload the artifacts to your bucket replacing the ones that exist
			// you'll end up with a sequence of patch files that will
		}

		// Run postPackage hook at the very end of the build process
		runHook("postPackage");

		// NOTE: verify codesign
		//  codesign --verify --deep --strict --verbose=2 <app path>

		// Note: verify notarization
		// spctl --assess --type execute --verbose <app path>

		// Note: for .dmg spctl --assess will respond with "rejected (*the code is valid* but does not seem to be an app)" which is valid
		// an actual failed response for a dmg is "source=no usable signature"
		// for a dmg.
		// can also use stapler validate -v to validate the dmg and look for teamId, signingId, and the response signedTicket
		// stapler validate -v <app path>
	}

	// Take over as the terminal's foreground process group (macOS/Linux).
	// This prevents the parent bun script runner from receiving SIGINT
	// when Ctrl+C is pressed, keeping the terminal busy until the app
	// finishes shutting down gracefully.
	// Call once per CLI session — returns a restore function.
	async function takeoverForeground(): Promise<() => void> {
		let restoreFn = () => {};
		if (OS === "win") return restoreFn;
		try {
			const { dlopen, ptr } = await import("bun:ffi");
			const libName = OS === "macos" ? "libSystem.B.dylib" : "libc.so.6";
			const libc = dlopen(libName, {
				open: { args: ["ptr", "i32"], returns: "i32" },
				close: { args: ["i32"], returns: "i32" },
				getpid: { args: [], returns: "i32" },
				setpgid: { args: ["i32", "i32"], returns: "i32" },
				tcgetpgrp: { args: ["i32"], returns: "i32" },
				tcsetpgrp: { args: ["i32", "i32"], returns: "i32" },
				signal: { args: ["i32", "ptr"], returns: "ptr" },
			});

			const ttyPathBuf = new Uint8Array(Buffer.from("/dev/tty\0"));
			const ttyFd = libc.symbols.open(ptr(ttyPathBuf), 2); // O_RDWR

			if (ttyFd >= 0) {
				const originalPgid = libc.symbols.tcgetpgrp(ttyFd);
				if (originalPgid >= 0) {
					// Ignore SIGTTOU at C level so tcsetpgrp works from background group.
					// bun's process.on("SIGTTOU") doesn't set the C-level disposition.
					// SIG_IGN = (void(*)(int))1, SIGTTOU = 22 on macOS/Linux
					libc.symbols.signal(22, 1);

					if (libc.symbols.setpgid(0, 0) === 0) {
						const myPid = libc.symbols.getpid();
						if (libc.symbols.tcsetpgrp(ttyFd, myPid) === 0) {
							restoreFn = () => {
								try {
									libc.symbols.signal(22, 1);
									libc.symbols.tcsetpgrp(ttyFd, originalPgid);
									libc.symbols.close(ttyFd);
								} catch {}
							};
						} else {
							libc.symbols.setpgid(0, originalPgid);
							libc.symbols.close(ttyFd);
						}
					} else {
						libc.symbols.close(ttyFd);
					}
				} else {
					libc.symbols.close(ttyFd);
				}
			}
		} catch {
			// Fall back to default behavior (prompt may return early on Ctrl+C)
		}
		return restoreFn;
	}

	async function runApp(
		config: Awaited<ReturnType<typeof getConfig>>,
		options?: { onExit?: () => void },
	): Promise<{ kill: () => void; exited: Promise<number> }> {
		// Launch the already-built dev bundle

		const buildEnvironment = "dev";
		const appFileName = getAppFileName(config.app.name, buildEnvironment);
		const macOSBundleDisplayName = getMacOSBundleDisplayName(
			config.app.name,
			buildEnvironment,
		);
		const buildSubFolder = `${buildEnvironment}-${OS}-${ARCH}`;
		const buildFolder = join(
			projectRoot,
			config.build.buildFolder,
			buildSubFolder,
		);
		const bundleFileName =
			OS === "macos" ? `${macOSBundleDisplayName}.app` : appFileName;

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let mainProc: any;
		let bundleExecPath: string;
		// @ts-expect-error - reserved for future use
		let _bundleResourcesPath: string;
		if (OS === "macos") {
			bundleExecPath = join(buildFolder, bundleFileName, "Contents", "MacOS");
			_bundleResourcesPath = join(
				buildFolder,
				bundleFileName,
				"Contents",
				"Resources",
			);
		} else if (OS === "linux") {
			bundleExecPath = join(buildFolder, bundleFileName, "bin");
			_bundleResourcesPath = join(buildFolder, bundleFileName, "Resources");
		} else if (OS === "win") {
			bundleExecPath = join(buildFolder, bundleFileName, "bin");
			_bundleResourcesPath = join(buildFolder, bundleFileName, "Resources");
		} else {
			throw new Error(`Unsupported OS: ${OS}`);
		}

		if (OS === "macos" || OS === "linux") {
			// For Linux dev mode, update libNativeWrapper.so based on bundleCEF setting
			if (OS === "linux") {
				const currentLibPath = join(bundleExecPath, "libNativeWrapper.so");
				const targetPaths = getPlatformPaths("linux", ARCH);
				const correctLibSource = config.build.linux?.bundleCEF
					? targetPaths.NATIVE_WRAPPER_LINUX_CEF
					: targetPaths.NATIVE_WRAPPER_LINUX;

				if (existsSync(correctLibSource)) {
					try {
						cpSync(correctLibSource, currentLibPath, { dereference: true });
						console.log(
							`Updated libNativeWrapper.so for ${config.build.linux?.bundleCEF ? "CEF (with weak linking)" : "GTK-only"} mode`,
						);
					} catch (error) {
						console.warn("Failed to update libNativeWrapper.so:", error);
					}
				}
			}

			mainProc = Bun.spawn([join(bundleExecPath, "launcher")], {
				stdio: ["inherit", "inherit", "inherit"],
				cwd: bundleExecPath,
			});
		} else if (OS === "win") {
			mainProc = Bun.spawn([join(bundleExecPath, "launcher.exe")], {
				stdio: ["inherit", "inherit", "inherit"],
				cwd: bundleExecPath,
			});
		}

		if (!mainProc) {
			throw new Error("Failed to spawn app process");
		}

		const exitedPromise = mainProc.exited.then((code: number) => {
			options?.onExit?.();
			return code ?? 0;
		});

		return {
			kill: () => {
				try {
					mainProc.kill();
				} catch {}
			},
			exited: exitedPromise,
		};
	}

	async function runAppWithSignalHandling(
		config: Awaited<ReturnType<typeof getConfig>>,
	) {
		const restoreForeground = await takeoverForeground();
		const handle = await runApp(config);

		let sigintCount = 0;
		process.on("SIGINT", () => {
			sigintCount++;
			if (sigintCount === 1) {
				console.log(
					"\n[electrobun dev] Shutting down gracefully... (press Ctrl+C again to force quit)",
				);
			} else {
				console.log("\n[electrobun dev] Force quitting...");
				try {
					process.kill(0, "SIGKILL");
				} catch {}
				process.exit(0);
			}
		});

		const code = await handle.exited;
		restoreForeground();
		process.exit(code);
	}

	async function runDevWatch(config: Awaited<ReturnType<typeof getConfig>>) {
		const { watch } = await import("fs");

		// Collect watch directories from config entrypoints
		const watchDirs = new Set<string>();

		// Bun entrypoint directory
		if (config.build.bun?.entrypoint) {
			watchDirs.add(join(projectRoot, dirname(config.build.bun.entrypoint)));
		}

		// View entrypoint directories
		if (config.build.views) {
			for (const viewConfig of Object.values(config.build.views)) {
				if (viewConfig.entrypoint) {
					watchDirs.add(join(projectRoot, dirname(viewConfig.entrypoint)));
				}
			}
		}

		// Copy source directories
		if (config.build.copy) {
			for (const src of Object.keys(config.build.copy)) {
				const srcPath = join(projectRoot, src);
				try {
					const stat = statSync(srcPath);
					watchDirs.add(stat.isDirectory() ? srcPath : dirname(srcPath));
				} catch {
					watchDirs.add(dirname(srcPath));
				}
			}
		}

		// User-specified additional watch paths
		if (config.build.watch) {
			for (const entry of config.build.watch) {
				const entryPath = join(projectRoot, entry);
				try {
					const stat = statSync(entryPath);
					watchDirs.add(stat.isDirectory() ? entryPath : dirname(entryPath));
				} catch {
					// Path doesn't exist yet — watch its parent directory
					watchDirs.add(dirname(entryPath));
				}
			}
		}

		// Deduplicate overlapping directories (remove children if parent is watched)
		const sortedDirs = [...watchDirs].sort();
		const dedupedDirs = sortedDirs.filter((dir, i) => {
			return !sortedDirs.some(
				(other, j) => j < i && dir.startsWith(other + "/"),
			);
		});

		if (dedupedDirs.length === 0) {
			console.error(
				"[electrobun dev --watch] No directories to watch. Check your config entrypoints.",
			);
			process.exit(1);
		}

		console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ELECTROBUN DEV --watch                                     ║
║  Watching ${String(dedupedDirs.length).padEnd(2)} director${dedupedDirs.length === 1 ? "y " : "ies"}                                          ║
╚══════════════════════════════════════════════════════════════╝
`);
		for (const dir of dedupedDirs) {
			console.log(`  ${dir}`);
		}

		// Set up terminal foreground takeover once for the whole session
		const restoreForeground = await takeoverForeground();

		// Paths to ignore in file watcher (build output, node_modules, artifacts)
		const buildDir = join(projectRoot, config.build.buildFolder);
		const artifactDir = join(projectRoot, config.build.artifactFolder);
		const ignoreDirs = [
			buildDir,
			artifactDir,
			join(projectRoot, "node_modules"),
		];

		// Compile watchIgnore glob patterns
		const ignoreGlobs = (config.build.watchIgnore || []).map(
			(pattern) => new Bun.Glob(pattern),
		);

		function shouldIgnore(fullPath: string): boolean {
			// Check built-in ignore dirs
			if (
				ignoreDirs.some(
					(ignored) =>
						fullPath.startsWith(ignored + "/") || fullPath === ignored,
				)
			) {
				return true;
			}
			// Check user-configured watchIgnore globs (match against project-relative path)
			const relativePath = fullPath.replace(projectRoot + "/", "");
			if (ignoreGlobs.some((glob) => glob.match(relativePath))) {
				return true;
			}
			return false;
		}

		let appHandle: { kill: () => void; exited: Promise<number> } | null = null;
		let lastChangedFile = "";
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let shuttingDown = false;
		let watchers: ReturnType<typeof watch>[] = [];

		function startWatchers() {
			for (const dir of dedupedDirs) {
				const watcher = watch(dir, { recursive: true }, (_event, filename) => {
					if (shuttingDown) return;

					if (filename) {
						const fullPath = join(dir, filename);
						if (shouldIgnore(fullPath)) {
							return;
						}
						lastChangedFile = fullPath;
					}

					if (debounceTimer) clearTimeout(debounceTimer);
					debounceTimer = setTimeout(() => {
						triggerRebuild();
					}, 300);
				});
				watchers.push(watcher);
			}
		}

		function stopWatchers() {
			for (const watcher of watchers) {
				try { watcher.close(); } catch {}
			}
			watchers = [];
		}

		async function triggerRebuild() {
			if (shuttingDown) return;

			// Stop watching during build so build output doesn't trigger more events
			stopWatchers();

			const changedDisplay = lastChangedFile
				? lastChangedFile.replace(projectRoot + "/", "")
				: "unknown";
			console.log(`
╔══════════════════════════════════════════════════════════════╗
║  FILE CHANGED: ${changedDisplay.padEnd(44)}║
║  Rebuilding...                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

			// Kill running app if any
			if (appHandle) {
				appHandle.kill();
				try {
					await appHandle.exited;
				} catch {}
				appHandle = null;
			}

			try {
				await runBuild(config, "dev");
				console.log(
					"[electrobun dev --watch] Build succeeded, launching app...",
				);

				appHandle = await runApp(config, {
					onExit: () => {
						appHandle = null;
					},
				});
			} catch (error) {
				console.error("[electrobun dev --watch] Build failed:", error);
				console.log("[electrobun dev --watch] Waiting for file changes...");
			}

			// Resume watching after build + hooks are done
			if (!shuttingDown) {
				startWatchers();
			}
		}

		function cleanup() {
			shuttingDown = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			stopWatchers();
			if (appHandle) {
				appHandle.kill();
			}
			restoreForeground();
		}

		// Ctrl+C handling for watch mode
		let sigintCount = 0;
		process.on("SIGINT", () => {
			sigintCount++;
			if (sigintCount === 1) {
				console.log(
					"\n[electrobun dev --watch] Shutting down... (press Ctrl+C again to force quit)",
				);
				cleanup();
				// Wait briefly for app to exit, then exit
				setTimeout(() => process.exit(0), 2000);
			} else {
				try {
					process.kill(0, "SIGKILL");
				} catch {}
				process.exit(0);
			}
		});

		// Initial build + launch (watchers start after build completes)
		try {
			await runBuild(config, "dev");
			appHandle = await runApp(config, {
				onExit: () => {
					appHandle = null;
				},
			});
		} catch (error) {
			console.error("[electrobun dev --watch] Initial build failed:", error);
			console.log("[electrobun dev --watch] Waiting for file changes...");
		}

		// Start watching only after initial build + all hooks are done
		startWatchers();

		// Keep the process alive
		await new Promise(() => {});
	}

	// Helper functions

	async function getConfig() {
		let loadedConfig: Partial<typeof defaultConfig> & Record<string, unknown> =
			{};
		const foundConfigPath = findConfigFile();

		if (foundConfigPath) {
			console.log(`Using config file: ${basename(foundConfigPath)}`);

			try {
				// Use dynamic import for TypeScript ESM files
				// Bun handles TypeScript natively, no transpilation needed
				const configModule = await import(foundConfigPath);
				loadedConfig = configModule.default || configModule;

				// Validate that we got a valid config object
				if (!loadedConfig || typeof loadedConfig !== "object") {
					console.error("Config file must export a default object");
					console.error("using default config instead");
					loadedConfig = {};
				}
			} catch (error) {
				console.error("Failed to load config file:", error);
				console.error("using default config instead");
			}
		}

		// todo (yoav): write a deep clone fn
		return {
			...defaultConfig,
			...loadedConfig,
			app: {
				...defaultConfig.app,
				...(loadedConfig?.app || {}),
			},
			build: {
				...defaultConfig.build,
				...(loadedConfig?.build || {}),
				mac: {
					...defaultConfig.build.mac,
					...(loadedConfig?.build?.mac || {}),
					entitlements: {
						...defaultConfig.build.mac.entitlements,
						...(loadedConfig?.build?.mac?.entitlements || {}),
					},
				},
				win: {
					...defaultConfig.build.win,
					...(loadedConfig?.build?.win || {}),
				},
				linux: {
					...defaultConfig.build.linux,
					...(loadedConfig?.build?.linux || {}),
				},
				bun: {
					...defaultConfig.build.bun,
					...(loadedConfig?.build?.bun || {}),
				},
			},
			runtime: {
				...defaultConfig.runtime,
				...((loadedConfig as Record<string, any>)?.["runtime"] || {}),
			},
			scripts: {
				...defaultConfig.scripts,
				...(loadedConfig?.scripts || {}),
			},
			release: {
				...defaultConfig.release,
				...(loadedConfig?.release || {}),
			},
		};
	}

	function buildEntitlementsFile(
		entitlements: Record<string, boolean | string | string[]>,
	) {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    ${Object.keys(entitlements)
			.map((key) => {
				return `<key>${key}</key>\n${getEntitlementValue(entitlements[key]!)}`;
			})
			.join("\n")}
</dict>
</plist>
`;
	}

	function getEntitlementValue(value: boolean | string | string[]) {
		if (typeof value === "boolean") {
			return `<${value.toString()}/>`;
		} else if (Array.isArray(value)) {
			return `<array>\n${value.map((v) => `        <string>${v}</string>`).join("\n")}\n    </array>`;
		} else {
			return `<string>${value}</string>`;
		}
	}

	async function createWindowsSelfExtractingExe(
		buildFolder: string,
		compressedTarPath: string,
		_appFileName: string,
		targetPaths: any,
		buildEnvironment: string,
		hash: string,
		config: any,
		projectRoot: string,
	): Promise<string> {
		console.log("Creating Windows installer with separate archive...");

		const setupFileName = getWindowsSetupFileName(
			config.app.name,
			buildEnvironment,
		);
		const outputExePath = join(buildFolder, setupFileName);

		// Copy the extractor exe
		const extractorExe = readFileSync(targetPaths.EXTRACTOR);
		writeFileSync(outputExePath, new Uint8Array(extractorExe));

		// Embed icon into the wrapper EXE if provided
		if (config.build.win?.icon) {
			const iconSourcePath =
				config.build.win.icon.startsWith("/") ||
				config.build.win.icon.match(/^[a-zA-Z]:/)
					? config.build.win.icon
					: join(projectRoot, config.build.win.icon);

			if (existsSync(iconSourcePath)) {
				console.log(`Embedding icon into Windows installer: ${iconSourcePath}`);
				try {
					let iconPath = iconSourcePath;

					// Convert PNG to ICO if needed
					if (iconSourcePath.toLowerCase().endsWith(".png")) {
						const pngToIco = (await import("png-to-ico")).default;
						const tempIcoPath = join(buildFolder, "temp-icon.ico");
						const icoBuffer = await pngToIco(iconSourcePath);
						writeFileSync(tempIcoPath, new Uint8Array(icoBuffer));
						iconPath = tempIcoPath;
						console.log(`Converted PNG to ICO format: ${tempIcoPath}`);
					}

					// Use rcedit to embed the icon
					const rcedit = (await import("rcedit")).default;
					await rcedit(outputExePath, {
						icon: iconPath,
					});
					console.log(`Successfully embedded icon into ${setupFileName}`);

					// Clean up temp ICO file
					if (iconPath !== iconSourcePath && existsSync(iconPath)) {
						unlinkSync(iconPath);
					}
				} catch (error) {
					console.warn(
						`Warning: Failed to embed icon into Windows installer: ${error}`,
					);
				}
			} else {
				console.warn(`Warning: Windows icon not found at ${iconSourcePath}`);
			}
		}

		// Create metadata JSON file
		const metadata = {
			identifier: config.app.identifier,
			name: config.app.name,
			channel: buildEnvironment,
			hash: hash,
		};
		const metadataJson = JSON.stringify(metadata, null, 2);
		const metadataFileName = setupFileName.replace(".exe", ".metadata.json");
		const metadataPath = join(buildFolder, metadataFileName);
		writeFileSync(metadataPath, metadataJson);

		// Copy the compressed archive with matching name
		const archiveFileName = setupFileName.replace(".exe", ".tar.zst");
		const archivePath = join(buildFolder, archiveFileName);
		copyFileSync(compressedTarPath, archivePath);

		// Make the exe executable (though Windows doesn't need chmod)
		if (OS !== "win") {
			execSync(`chmod +x ${escapePathForTerminal(outputExePath)}`);
		}

		const exeSize = statSync(outputExePath).size;
		const archiveSize = statSync(archivePath).size;
		const totalSize = exeSize + archiveSize;

		console.log(`Created Windows installer:`);
		console.log(
			`  - Extractor: ${outputExePath} (${(exeSize / 1024 / 1024).toFixed(2)} MB)`,
		);
		console.log(
			`  - Archive: ${archivePath} (${(archiveSize / 1024 / 1024).toFixed(2)} MB)`,
		);
		console.log(`  - Metadata: ${metadataPath}`);
		console.log(`  - Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

		return outputExePath;
	}

	async function wrapWindowsInstallerInZip(
		exePath: string,
		buildFolder: string,
	): Promise<string> {
		const exeName = basename(exePath);
		const exeStem = exeName.replace(".exe", "");

		// Derive the paths for metadata and archive files
		const metadataPath = join(buildFolder, `${exeStem}.metadata.json`);
		const archivePath = join(buildFolder, `${exeStem}.tar.zst`);
		// Sanitize the zip filename (no spaces in artifact URLs) while inner files keep their original names
		const zipPath = join(buildFolder, `${exeStem.replace(/ /g, "")}.zip`);

		// Verify all files exist
		if (!existsSync(exePath)) {
			throw new Error(`Installer exe not found: ${exePath}`);
		}
		if (!existsSync(metadataPath)) {
			throw new Error(`Metadata file not found: ${metadataPath}`);
		}
		if (!existsSync(archivePath)) {
			throw new Error(`Archive file not found: ${archivePath}`);
		}

		// Create zip archive
		const output = createWriteStream(zipPath);
		const archive = archiver("zip", {
			zlib: { level: 9 }, // Maximum compression
		});

		return new Promise((resolve, reject) => {
			output.on("close", () => {
				console.log(
					`Created Windows installer package: ${zipPath} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`,
				);
				resolve(zipPath);
			});

			archive.on("error", (err) => {
				reject(err);
			});

			archive.pipe(output);

			// Add Setup.exe at the root level for easy access
			archive.file(exePath, { name: basename(exePath) });

			// Put metadata and archive in a subdirectory to discourage manual extraction
			archive.file(metadataPath, {
				name: `.installer/${basename(metadataPath)}`,
			});
			archive.file(archivePath, {
				name: `.installer/${basename(archivePath)}`,
			});

			archive.finalize();
		});
	}

	function codesignAppBundle(
		appBundleOrDmgPath: string,
		entitlementsFilePath: string | undefined,
		config: Awaited<ReturnType<typeof getConfig>>,
	) {
		console.log("code signing...");
		if (OS !== "macos" || !config.build.mac.codesign) {
			return;
		}

		const ELECTROBUN_DEVELOPER_ID = process.env["ELECTROBUN_DEVELOPER_ID"];

		if (!ELECTROBUN_DEVELOPER_ID) {
			console.error("Env var ELECTROBUN_DEVELOPER_ID is required to codesign");
			process.exit(1);
		}

		// If this is a DMG file, sign it directly
		if (appBundleOrDmgPath.endsWith(".dmg")) {
			execSync(
				`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" ${escapePathForTerminal(
					appBundleOrDmgPath,
				)}`,
			);
			return;
		}

		// For app bundles, sign binaries individually to avoid --deep issues with notarization
		const contentsPath = join(appBundleOrDmgPath, "Contents");
		const macosPath = join(contentsPath, "MacOS");

		// Prepare entitlements if provided
		if (entitlementsFilePath) {
			const entitlementsFileContents = buildEntitlementsFile(
				config.build.mac.entitlements,
			);
			Bun.write(entitlementsFilePath, entitlementsFileContents);
		}

		// Sign frameworks first (CEF framework requires special handling)
		const frameworksPath = join(contentsPath, "Frameworks");
		if (existsSync(frameworksPath)) {
			try {
				const frameworks = readdirSync(frameworksPath);
				for (const framework of frameworks) {
					if (framework.endsWith(".framework")) {
						const frameworkPath = join(frameworksPath, framework);

						if (framework === "Chromium Embedded Framework.framework") {
							console.log(`Signing CEF framework components: ${framework}`);

							// Sign CEF libraries first
							const librariesPath = join(frameworkPath, "Libraries");
							if (existsSync(librariesPath)) {
								const libraries = readdirSync(librariesPath);
								for (const library of libraries) {
									if (library.endsWith(".dylib")) {
										const libraryPath = join(librariesPath, library);
										console.log(`Signing CEF library: ${library}`);
										execSync(
											`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${escapePathForTerminal(libraryPath)}`,
										);
									}
								}
							}

							// CEF helper apps are in the main Frameworks directory, not inside the CEF framework
							// We'll sign them after signing all frameworks
						}

						// Sign the framework bundle itself (for CEF and any other frameworks)
						console.log(`Signing framework bundle: ${framework}`);
						execSync(
							`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${escapePathForTerminal(frameworkPath)}`,
						);
					}
				}
			} catch (err) {
				console.log("Error signing frameworks:", err);
				throw err; // Re-throw to fail the build since framework signing is critical
			}
		}

		// Sign CEF helper apps (they're in the main Frameworks directory, not inside CEF framework)
		const cefHelperApps = [
			"bun Helper.app",
			"bun Helper (GPU).app",
			"bun Helper (Plugin).app",
			"bun Helper (Alerts).app",
			"bun Helper (Renderer).app",
		];

		for (const helperApp of cefHelperApps) {
			const helperPath = join(frameworksPath, helperApp);
			if (existsSync(helperPath)) {
				const helperExecutablePath = join(
					helperPath,
					"Contents",
					"MacOS",
					helperApp.replace(".app", ""),
				);
				if (existsSync(helperExecutablePath)) {
					console.log(`Signing CEF helper executable: ${helperApp}`);
					const entitlementFlag = entitlementsFilePath
						? `--entitlements ${entitlementsFilePath}`
						: "";
					execSync(
						`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(helperExecutablePath)}`,
					);
				}

				console.log(`Signing CEF helper bundle: ${helperApp}`);
				const entitlementFlag = entitlementsFilePath
					? `--entitlements ${entitlementsFilePath}`
					: "";
				execSync(
					`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(helperPath)}`,
				);
			}
		}

		// Sign all binaries and libraries in MacOS folder and subdirectories
		console.log("Signing all binaries in MacOS folder...");

		// Recursively find all executables and libraries in MacOS folder
		function findExecutables(dir: string): string[] {
			let executables: string[] = [];

			try {
				const entries = readdirSync(dir, { withFileTypes: true });

				for (const entry of entries) {
					const fullPath = join(dir, entry.name);

					if (entry.isDirectory()) {
						// Recursively search subdirectories
						executables = executables.concat(findExecutables(fullPath));
					} else if (entry.isFile()) {
						// Check if it's an executable or library
						try {
							const fileInfo = execSync(`file -b "${fullPath}"`, {
								encoding: "utf8",
							}).trim();
							if (
								fileInfo.includes("Mach-O") ||
								entry.name.endsWith(".dylib")
							) {
								executables.push(fullPath);
							}
						} catch {
							// If file command fails, check by extension
							if (entry.name.endsWith(".dylib") || !entry.name.includes(".")) {
								// No extension often means executable
								executables.push(fullPath);
							}
						}
					}
				}
			} catch (err) {
				console.error(`Error scanning directory ${dir}:`, err);
			}

			return executables;
		}

		const executablesInMacOS = findExecutables(macosPath);

		// Sign each found executable
		for (const execPath of executablesInMacOS) {
			const fileName = basename(execPath);
			const relativePath = execPath.replace(macosPath + "/", "");

			// Use filename as identifier (without extension)
			const identifier = fileName.replace(/\.[^.]+$/, "");

			console.log(`Signing ${relativePath} with identifier ${identifier}`);
			const entitlementFlag = entitlementsFilePath
				? `--entitlements ${entitlementsFilePath}`
				: "";

			try {
				execSync(
					`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime --identifier ${identifier} ${entitlementFlag} ${escapePathForTerminal(execPath)}`,
				);
			} catch (err) {
				console.error(
					`Failed to sign ${relativePath}:`,
					(err as Error).message,
				);
				// Continue signing other files even if one fails
			}
		}

		// Note: main.js is now in Resources and will be automatically sealed when signing the app bundle

		// Sign the main executable (launcher) - this should use the app's bundle identifier, not "launcher"
		const launcherPath = join(macosPath, "launcher");
		if (existsSync(launcherPath)) {
			console.log("Signing main executable (launcher)");
			const entitlementFlag = entitlementsFilePath
				? `--entitlements ${entitlementsFilePath}`
				: "";
			try {
				execSync(
					`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(launcherPath)}`,
				);
			} catch (error) {
				console.error("Failed to sign launcher:", (error as Error).message);
				console.log("Attempting to sign launcher without runtime hardening...");
				execSync(
					`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" ${entitlementFlag} ${escapePathForTerminal(launcherPath)}`,
				);
			}
		}

		// Finally, sign the app bundle itself (without --deep)
		console.log("Signing app bundle");
		const entitlementFlag = entitlementsFilePath
			? `--entitlements ${entitlementsFilePath}`
			: "";
		execSync(
			`codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(appBundleOrDmgPath)}`,
		);
	}

	function notarizeAndStaple(
		appOrDmgPath: string,
		config: Awaited<ReturnType<typeof getConfig>>,
	) {
		if (OS !== "macos" || !config.build.mac.notarize) {
			return;
		}

		let fileToNotarize = appOrDmgPath;
		// codesign
		// NOTE: Codesigning fails in dev mode (when using a single-file-executable bun cli as the launcher)
		// see https://github.com/oven-sh/bun/issues/7208
		// if (shouldNotarize) {
		console.log("notarizing...");
		const zipPath = appOrDmgPath + ".zip";
		// if (appOrDmgPath.endsWith('.app')) {
		const appBundleFileName = basename(appOrDmgPath);
		// if we're codesigning the .app we have to zip it first
		execSync(
			`zip -y -r -9 ${escapePathForTerminal(zipPath)} ${escapePathForTerminal(
				appBundleFileName,
			)}`,
			{
				cwd: dirname(appOrDmgPath),
			},
		);
		fileToNotarize = zipPath;
		// }

		const ELECTROBUN_APPLEID = process.env["ELECTROBUN_APPLEID"];

		if (!ELECTROBUN_APPLEID) {
			console.error("Env var ELECTROBUN_APPLEID is required to notarize");
			process.exit(1);
		}

		const ELECTROBUN_APPLEIDPASS = process.env["ELECTROBUN_APPLEIDPASS"];

		if (!ELECTROBUN_APPLEIDPASS) {
			console.error("Env var ELECTROBUN_APPLEIDPASS is required to notarize");
			process.exit(1);
		}

		const ELECTROBUN_TEAMID = process.env["ELECTROBUN_TEAMID"];

		if (!ELECTROBUN_TEAMID) {
			console.error("Env var ELECTROBUN_TEAMID is required to notarize");
			process.exit(1);
		}

		// notarize
		// todo (yoav): follow up on options here like --s3-acceleration and --webhook
		// todo (yoav): don't use execSync since it's blocking and we'll only see the output at the end
		const statusInfo = execSync(
			`xcrun notarytool submit --apple-id "${ELECTROBUN_APPLEID}" --password "${ELECTROBUN_APPLEIDPASS}" --team-id "${ELECTROBUN_TEAMID}" --wait ${escapePathForTerminal(
				fileToNotarize,
			)}`,
		).toString();
		const uuid = statusInfo.match(/id: ([^\n]+)/)?.[1];
		console.log("statusInfo", statusInfo);
		console.log("uuid", uuid);

		if (statusInfo.match("Current status: Invalid")) {
			console.error("notarization failed", statusInfo);
			const log = execSync(
				`xcrun notarytool log --apple-id "${ELECTROBUN_APPLEID}" --password "${ELECTROBUN_APPLEIDPASS}" --team-id "${ELECTROBUN_TEAMID}" ${uuid}`,
			).toString();
			console.log("log", log);
			process.exit(1);
		}
		// check notarization
		// todo (yoav): actually check result
		// use `notarytool info` or some other request thing to check separately from the wait above

		// stable notarization
		console.log("stapling...");
		execSync(`xcrun stapler staple ${escapePathForTerminal(appOrDmgPath)}`);

		if (existsSync(zipPath)) {
			unlinkSync(zipPath);
		}
	}

	// Note: supposedly the app bundle name is relevant to code sign/notarization so we need to make the app bundle and the self-extracting wrapper app bundle
	// have the same name but different subfolders in our build directory. or I guess delete the first one after tar/compression and then create the other one.
	// either way you can pass in the parent folder here for that flexibility.
	// for intel/arm builds on mac we'll probably have separate subfolders as well and build them in parallel.
	function createAppBundle(
		bundleName: string,
		parentFolder: string,
		targetOS: "macos" | "win" | "linux",
	) {
		if (targetOS === "macos") {
			// macOS bundle structure
			const bundleFileName = `${bundleName}.app`;
			const appBundleFolderPath = join(parentFolder, bundleFileName);
			const appBundleFolderContentsPath = join(appBundleFolderPath, "Contents");
			const appBundleMacOSPath = join(appBundleFolderContentsPath, "MacOS");
			const appBundleFolderResourcesPath = join(
				appBundleFolderContentsPath,
				"Resources",
			);
			const appBundleFolderFrameworksPath = join(
				appBundleFolderContentsPath,
				"Frameworks",
			);

			// we don't have to make all the folders, just the deepest ones
			mkdirSync(appBundleMacOSPath, { recursive: true });
			mkdirSync(appBundleFolderResourcesPath, { recursive: true });
			mkdirSync(appBundleFolderFrameworksPath, { recursive: true });

			return {
				appBundleFolderPath,
				appBundleFolderContentsPath,
				appBundleMacOSPath,
				appBundleFolderResourcesPath,
				appBundleFolderFrameworksPath,
			};
		} else if (targetOS === "linux" || targetOS === "win") {
			// Linux/Windows simpler structure
			const appBundleFolderPath = join(parentFolder, bundleName);
			const appBundleFolderContentsPath = appBundleFolderPath; // No Contents folder needed
			const appBundleMacOSPath = join(appBundleFolderPath, "bin"); // Use bin instead of MacOS
			const appBundleFolderResourcesPath = join(
				appBundleFolderPath,
				"Resources",
			);
			const appBundleFolderFrameworksPath = join(appBundleFolderPath, "lib"); // Use lib instead of Frameworks

			// Create directories
			mkdirSync(appBundleMacOSPath, { recursive: true });
			mkdirSync(appBundleFolderResourcesPath, { recursive: true });
			mkdirSync(appBundleFolderFrameworksPath, { recursive: true });

			return {
				appBundleFolderPath,
				appBundleFolderContentsPath,
				appBundleMacOSPath,
				appBundleFolderResourcesPath,
				appBundleFolderFrameworksPath,
			};
		} else {
			throw new Error(`Unsupported OS: ${targetOS}`);
		}
	}

	// Close the command handling if/else chain

	// Close and execute the async IIFE
})().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
