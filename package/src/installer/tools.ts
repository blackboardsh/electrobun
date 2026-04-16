/**
 * Installer tool auto-download and caching.
 *
 * Locates or downloads NSIS and WiX v3 to ~/.electrobun/tools/.
 * Follows the same caching pattern as ensureCoreDependencies in the CLI.
 *
 * These tools are only relevant on Windows builds — both functions return null
 * on non-Windows hosts.
 */

import { join } from "path";
import {
	existsSync,
	mkdirSync,
	unlinkSync,
	renameSync,
	rmSync,
	readdirSync,
	readFileSync,
} from "fs";
import { execSync, spawnSync } from "child_process";
import { homedir } from "os";
import { createHash } from "crypto";

const ELECTROBUN_TOOLS_DIR = join(homedir(), ".electrobun", "tools");

// ── NSIS ──────────────────────────────────────────────────────────────────────

const NSIS_VERSION = "3.10";
const NSIS_DIR = join(ELECTROBUN_TOOLS_DIR, `nsis-${NSIS_VERSION}`);
const NSIS_MAKENSIS = join(NSIS_DIR, "makensis.exe");

// SourceForge CDN direct link (no JS redirect)
const NSIS_ZIP_URL = `https://netcologne.dl.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`;

/** Common NSIS install locations on Windows */
const NSIS_SYSTEM_PATHS = [
	"C:\\Program Files (x86)\\NSIS\\makensis.exe",
	"C:\\Program Files\\NSIS\\makensis.exe",
];

// ── WiX v3 ───────────────────────────────────────────────────────────────────

const WIX_TAG = "wix3141rtm";
const WIX_DIR = join(ELECTROBUN_TOOLS_DIR, "wix314");
const WIX_CANDLE = join(WIX_DIR, "candle.exe");
const WIX_LIGHT = join(WIX_DIR, "light.exe");
const WIX_ZIP_URL = `https://github.com/wixtoolset/wix3/releases/download/${WIX_TAG}/wix314-binaries.zip`;

// ── Pinned SHA-256 hashes for downloaded tool binaries ────────────────────────
// These must be updated when tool versions are bumped.
// To compute: sha256sum nsis-3.10.zip / wix314-binaries.zip
const NSIS_ZIP_SHA256 =
	"6b0f33ec631ac3218d7dddff44e3d7a1668610ed3ac1e24fcaeec4c458c3614b";
const WIX_ZIP_SHA256 =
	"34dcbba9952902bfb710161bd45ee2e721ffa878db99f738285a21c9b09c6edb";

// ── Shared helpers ────────────────────────────────────────────────────────────

function findOnPath(name: string): string | null {
	try {
		const result = spawnSync("where.exe", [name], { encoding: "utf8" });
		if (result.status === 0) {
			const first = result.stdout.trim().split(/\r?\n/)[0]?.trim();
			return first || null;
		}
	} catch {
		/* ignore */
	}
	return null;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
	console.log(`[electrobun] Downloading ${url}`);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} fetching ${url}`);
	}
	const buffer = await response.arrayBuffer();
	await Bun.write(destPath, buffer);
	const mb = (buffer.byteLength / 1024 / 1024).toFixed(2);
	console.log(`[electrobun] Downloaded ${mb} MB → ${destPath}`);
}

/**
 * Verify that a file on disk matches the expected SHA-256 hash.
 * Throws if the hash doesn't match (possible supply-chain compromise).
 */
function verifyFileHash(filePath: string, expectedHash: string): void {
	const fileBuffer = readFileSync(filePath);
	const actualHash = createHash("sha256").update(new Uint8Array(fileBuffer)).digest("hex");
	if (actualHash !== expectedHash) {
		throw new Error(
			`SHA-256 mismatch for ${filePath}!\n` +
				`  Expected: ${expectedHash}\n` +
				`  Actual:   ${actualHash}\n` +
				`  The downloaded file may be corrupted or tampered with.`,
		);
	}
	console.log(`[electrobun] SHA-256 verified: ${filePath}`);
}

function extractZip(zipPath: string, destDir: string): void {
	mkdirSync(destDir, { recursive: true });

	// Windows tar.exe (bsdtar) misinterprets drive letters (e.g. "C:") as remote
	// host specifiers and fails with "Cannot connect to C: resolve failed".
	// PowerShell's Expand-Archive is the reliable cross-version solution on Windows.
	// Escape single quotes in paths to prevent injection into PS strings.
	const psZip = zipPath.replace(/\\/g, "/").replace(/'/g, "''");
	const psDest = destDir.replace(/\\/g, "/").replace(/'/g, "''");
	execSync(
		`powershell -NoProfile -NonInteractive -Command ` +
			`"Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psDest}' -Force"`,
		{ stdio: "pipe" },
	);

	const count = readdirSync(destDir).length;
	if (count === 0) {
		throw new Error(
			`Expand-Archive produced an empty directory. ` +
				`Zip: ${zipPath} → Dest: ${destDir}`,
		);
	}
}

/**
 * Search for an executable in a directory and its immediate subdirectories.
 * Handles zip structures that are flat (exe at root) or have a single root folder.
 */
function findExeInDir(dir: string, exeName: string): string | null {
	// Direct at root
	const direct = join(dir, exeName);
	if (existsSync(direct)) return direct;

	// Inside a single subdirectory
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const candidate = join(dir, entry.name, exeName);
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Find makensis.exe after extraction.
 * NSIS zip has structure: nsis-3.10/makensis.exe OR makensis.exe at root.
 */
function findMakensisInDir(dir: string): string | null {
	return findExeInDir(dir, "makensis.exe");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the path to makensis.exe, downloading NSIS if necessary.
 * Returns null on non-Windows hosts or if install fails.
 */
export async function ensureNsis(): Promise<string | null> {
	if (process.platform !== "win32") return null;

	// 1. System PATH
	const onPath = findOnPath("makensis");
	if (onPath && verifyNsisVersion(onPath)) return onPath;

	// 2. Common install locations
	for (const candidate of NSIS_SYSTEM_PATHS) {
		if (existsSync(candidate) && verifyNsisVersion(candidate)) return candidate;
	}

	// 3. Cached download
	if (existsSync(NSIS_MAKENSIS) && verifyNsisVersion(NSIS_MAKENSIS)) {
		return NSIS_MAKENSIS;
	}

	// 4. Auto-download
	console.log(
		`[electrobun] NSIS ${NSIS_VERSION} not found — downloading automatically...`,
	);
	mkdirSync(ELECTROBUN_TOOLS_DIR, { recursive: true });
	const zipPath = join(ELECTROBUN_TOOLS_DIR, `nsis-${NSIS_VERSION}.zip`);
	const tempDir = join(ELECTROBUN_TOOLS_DIR, `nsis-${NSIS_VERSION}-tmp`);

	try {
		await downloadFile(NSIS_ZIP_URL, zipPath);
		verifyFileHash(zipPath, NSIS_ZIP_SHA256);

		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		extractZip(zipPath, tempDir);
		unlinkSync(zipPath);

		// Find makensis.exe in the extracted tree and promote it to NSIS_DIR
		const found = findMakensisInDir(tempDir);
		if (!found) throw new Error("makensis.exe not found in extracted zip");

		if (existsSync(NSIS_DIR)) rmSync(NSIS_DIR, { recursive: true, force: true });

		// The makensis.exe might be at tempDir/nsis-x.y/makensis.exe
		// or at tempDir/makensis.exe (flat zip).
		const makensisDirname = join(found, "..");
		if (makensisDirname === tempDir) {
			// Flat: rename the whole tempDir to NSIS_DIR
			renameSync(tempDir, NSIS_DIR);
		} else {
			// Nested: rename the inner folder
			renameSync(makensisDirname, NSIS_DIR);
			rmSync(tempDir, { recursive: true, force: true });
		}

		const finalMakensis = join(NSIS_DIR, "makensis.exe");
		if (existsSync(finalMakensis) && verifyNsisVersion(finalMakensis)) {
			console.log(`[electrobun] NSIS installed to ${NSIS_DIR}`);
			return finalMakensis;
		}
		throw new Error(`makensis.exe not functional after download`);
	} catch (err) {
		// Clean up on failure
		try {
			if (existsSync(zipPath)) unlinkSync(zipPath);
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		console.warn(`[electrobun] Failed to auto-install NSIS: ${err}`);
		console.warn(
			`[electrobun] Please install NSIS manually: https://nsis.sourceforge.io/Download`,
		);
		console.warn(
			`[electrobun] Or via Chocolatey (CI): choco install nsis --yes --no-progress`,
		);
		return null;
	}
}

function verifyNsisVersion(makensisPath: string): boolean {
	try {
		const result = spawnSync(makensisPath, ["/VERSION"], {
			encoding: "utf8",
			timeout: 5000,
		});
		if (result.status === 0 && result.stdout) {
			// Output is e.g. "v3.11" — strip the leading "v" before parsing
			const versionStr = result.stdout.trim().replace(/^v/i, "");
			const major = parseInt(versionStr.split(".")[0] ?? "0", 10);
			if (major >= 3) return true;
			console.warn(
				`[electrobun] Found NSIS ${result.stdout.trim()} at ${makensisPath}, but version 3.x+ is required`,
			);
		}
	} catch {
		/* ignore */
	}
	return false;
}

/**
 * Returns paths to candle.exe and light.exe (WiX v3 compiler + linker),
 * downloading WiX if necessary.
 * Returns null on non-Windows hosts or if install fails.
 */
export async function ensureWix(): Promise<{
	candle: string;
	light: string;
} | null> {
	if (process.platform !== "win32") return null;

	// 1. System PATH
	const candleOnPath = findOnPath("candle");
	const lightOnPath = findOnPath("light");
	if (candleOnPath && lightOnPath) {
		return { candle: candleOnPath, light: lightOnPath };
	}

	// 2. Cached download
	if (existsSync(WIX_CANDLE) && existsSync(WIX_LIGHT)) {
		return { candle: WIX_CANDLE, light: WIX_LIGHT };
	}

	// 3. Auto-download
	console.log(`[electrobun] WiX v3 not found — downloading automatically...`);
	mkdirSync(ELECTROBUN_TOOLS_DIR, { recursive: true });
	const zipPath = join(ELECTROBUN_TOOLS_DIR, `wix314-binaries.zip`);

	try {
		await downloadFile(WIX_ZIP_URL, zipPath);
		verifyFileHash(zipPath, WIX_ZIP_SHA256);

		const tempWixDir = `${WIX_DIR}-tmp`;
		if (existsSync(tempWixDir))
			rmSync(tempWixDir, { recursive: true, force: true });
		if (existsSync(WIX_DIR)) rmSync(WIX_DIR, { recursive: true, force: true });

		// WiX zip is typically flat (binaries at root), but search subdirs too.
		extractZip(zipPath, tempWixDir);
		unlinkSync(zipPath);

		// Find candle.exe — it may be at the root or inside a single subdirectory
		const foundCandle = findExeInDir(tempWixDir, "candle.exe");
		const foundLight = findExeInDir(tempWixDir, "light.exe");
		if (!foundCandle || !foundLight) {
			throw new Error("candle.exe / light.exe not found after extraction");
		}

		// Promote: if the exes are inside a subdirectory, rename that dir to WIX_DIR
		const candleParent = join(foundCandle, "..");
		if (candleParent === tempWixDir) {
			renameSync(tempWixDir, WIX_DIR);
		} else {
			renameSync(candleParent, WIX_DIR);
			rmSync(tempWixDir, { recursive: true, force: true });
		}

		const finalCandle = join(WIX_DIR, "candle.exe");
		const finalLight = join(WIX_DIR, "light.exe");
		if (existsSync(finalCandle) && existsSync(finalLight)) {
			console.log(`[electrobun] WiX v3 installed to ${WIX_DIR}`);
			return { candle: finalCandle, light: finalLight };
		}
		throw new Error("candle.exe / light.exe not functional after install");
	} catch (err) {
		try {
			if (existsSync(zipPath)) unlinkSync(zipPath);
		} catch {
			/* ignore */
		}
		console.warn(`[electrobun] Failed to auto-install WiX v3: ${err}`);
		console.warn(
			`[electrobun] Please install WiX v3 manually: https://github.com/wixtoolset/wix3/releases`,
		);
		return null;
	}
}
