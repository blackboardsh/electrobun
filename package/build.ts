// Run this script via terminal or command line with dash build.ts

import { $ } from "bun";
import { createHash } from "crypto";
import { platform, arch } from "os";
import { join, relative, basename, resolve } from "path";
import {
	existsSync,
	readdirSync,
	renameSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	chmodSync,
	statSync,
	unlinkSync,
	cpSync,
	rmSync,
} from "fs";
import { parseArgs } from "util";
import process from "process";
import {
	CEF_VERSION,
	CHROMIUM_VERSION,
	DEFAULT_CEF_VERSION_STRING,
} from "./src/shared/cef-version";
import { BUN_VERSION } from "./src/shared/bun-version";
import { RUST_VERSION } from "./src/shared/rust-version";
import { GO_VERSION } from "./src/shared/go-version";

console.log("building...", platform(), arch());

const { values: args } = parseArgs({
	args: Bun.argv,
	options: {
		release: {
			type: "boolean",
		},
		ci: {
			type: "boolean",
		},
		npm: {
			type: "boolean",
		},
	},
	allowPositionals: true,
});

// TODO: set via cl arg
const CHANNEL: "debug" | "release" = args.release ? "release" : "debug";
const IS_NPM_BUILD = args.npm || false;
const OS: "win" | "linux" | "macos" = getPlatform();
const ARCH: "arm64" | "x64" = getArch();

const isWindows = platform() === "win32";
const binExt = OS === "win" ? ".exe" : "";
const bunBin = isWindows ? "bun.exe" : "bun";
const zigBinary = OS === "win" ? "zig.exe" : "zig";
const rustBinary = OS === "win" ? "rustc.exe" : "rustc";
const cargoBinary = OS === "win" ? "cargo.exe" : "cargo";
const goBinary = OS === "win" ? "go.exe" : "go";
const cottontailBinary = OS === "win" ? "cottontail.exe" : "cottontail";
const dashCliBinary = OS === "win" ? "dash.exe" : "dash";

type RuntimeArtifact = {
	url: string;
	sha256: string;
	size: number;
};

type RuntimeRelease = {
	schema: number;
	channel: string;
	name: string;
	version: string;
	revision: string;
	publishedAt: string;
	platforms: Record<string, { archive: RuntimeArtifact }>;
};

type RuntimeArtifactsLock = {
	schema: number;
	sources: {
		cottontail: string;
		dashCli: string;
	};
	cottontail: RuntimeRelease;
	dashCli: RuntimeRelease;
};

const RUNTIME_ARTIFACTS_LOCK_PATH = join(
	process.cwd(),
	"runtime-artifacts.lock.json",
);
const RUNTIME_ARTIFACTS = JSON.parse(
	readFileSync(RUNTIME_ARTIFACTS_LOCK_PATH, "utf8"),
) as RuntimeArtifactsLock;

// Note: We want all binaries in /dist to be extensionless to simplify our cross platform code
// (no .exe on windows)

// PATHS
const PATH = {
	bun: {
		RUNTIME: join(process.cwd(), "vendors", "bun", bunBin),
		DIST: join(process.cwd(), "dist", bunBin),
	},
	zig: {
		BIN: join(process.cwd(), "vendors", "zig", zigBinary),
	},
	rust: {
		BIN: join(process.cwd(), "vendors", "rust", "bin", rustBinary),
		CARGO: join(process.cwd(), "vendors", "rust", "bin", cargoBinary),
	},
	go: {
		BIN: join(process.cwd(), "vendors", "go", "bin", goBinary),
	},
	cottontail: {
		BIN: join(process.cwd(), "vendors", "cottontail", cottontailBinary),
		DIST: join(process.cwd(), "dist", cottontailBinary),
	},
	dashCli: {
		BIN: join(process.cwd(), "vendors", "dash-cli", dashCliBinary),
		DIST: join(process.cwd(), "dist", dashCliBinary),
	},
};

// Minimum expected file sizes for downloaded archives (in bytes)
// These are sanity checks to detect failed downloads (e.g., HTML error pages)
const MIN_DOWNLOAD_SIZES: Record<string, number> = {
	bun: 10 * 1024 * 1024, // Bun zip should be > 10MB
	"zig-asar": 100 * 1024, // zig-asar tarball should be > 100KB
	"zig-bsdiff": 100 * 1024, // zig-bsdiff tarball should be > 100KB
	"zig-zstd": 100 * 1024, // zig-zstd tarball should be > 100KB
	wgpu: 1 * 1024 * 1024, // Dawn (WGPU) tarball should be > 1MB
	cef: 50 * 1024 * 1024, // CEF tarball should be > 50MB
	rust: 100 * 1024 * 1024, // Rust toolchain tarball should be > 100MB
	go: 50 * 1024 * 1024, // Go toolchain archive should be > 50MB
};

function validateDownload(filePath: string, type: string): void {
	if (!existsSync(filePath)) {
		throw new Error(`Download failed: ${filePath} does not exist`);
	}
	const stats = statSync(filePath);
	const minSize = MIN_DOWNLOAD_SIZES[type];
	if (minSize && stats.size < minSize) {
		// Remove the invalid file so next run will re-download
		unlinkSync(filePath);
		throw new Error(
			`Download failed: ${filePath} is only ${stats.size} bytes (expected > ${minSize} bytes). ` +
				`Please try again in a minute.`,
		);
	}
}

function outputMissingOrOlder(outputPath: string, inputPaths: string[]): boolean {
	if (!existsSync(outputPath)) {
		return true;
	}

	const outputMtime = statSync(outputPath).mtimeMs;
	return inputPaths.some((inputPath) => {
		if (!existsSync(inputPath)) {
			return false;
		}
		return statSync(inputPath).mtimeMs > outputMtime;
	});
}

// Pause between GitHub downloads to avoid rate limiting
// Track if we've done a GitHub download this session
let lastGitHubDownload = 0;

async function pauseForGitHub(): Promise<void> {
	const now = Date.now();
	const timeSinceLastDownload = now - lastGitHubDownload;
	const pauseDuration = 60000; // 60 seconds

	if (lastGitHubDownload > 0 && timeSinceLastDownload < pauseDuration) {
		const remainingPause = pauseDuration - timeSinceLastDownload;
		console.log(
			`Pausing ${Math.ceil(remainingPause / 1000)} seconds before next GitHub download...`,
		);
		await new Promise((resolve) => setTimeout(resolve, remainingPause));
	}
	lastGitHubDownload = Date.now();
}

// TODO: setup file watchers
try {
	if (IS_NPM_BUILD) {
		console.log("Building for npm (JS/TS files only)...");
		await buildForNpm();
	} else {
		await setup();
		await build();
		await copyToDist();
	}
} catch (err) {
	console.error(err);
	process.exit(1);
}

// Global variables to store build tool paths
var CMAKE_BIN = "cmake";

async function vendorCmake() {
	if (OS !== "macos") return;

	// On macOS, cmake is distributed as an app bundle
	const vendoredCmakePath = join(
		process.cwd(),
		"vendors",
		"cmake",
		"CMake.app",
		"Contents",
		"bin",
		"cmake",
	);

	// Check if cmake is already available (system or vendored)
	try {
		await $`which cmake`.quiet();
		console.log("✓ cmake found in system PATH");
		CMAKE_BIN = "cmake";
		return;
	} catch {
		// Not in system PATH, check if vendored
		if (existsSync(vendoredCmakePath)) {
			CMAKE_BIN = vendoredCmakePath;
			console.log("✓ Using vendored cmake");
			return;
		}
	}

	console.log("cmake not found, downloading...");

	try {
		const cmakeVersion = "3.30.2";
		const cmakeUrl = `https://github.com/Kitware/CMake/releases/download/v${cmakeVersion}/cmake-${cmakeVersion}-macos-universal.tar.gz`;

		await $`mkdir -p vendors`;
		console.log(`Downloading cmake ${cmakeVersion} for macOS...`);

		// Download and extract in vendors directory
		const tempFile = "vendors/cmake_temp.tar.gz";
		await $`curl -L "${cmakeUrl}" -o "${tempFile}"`;

		// Extract in vendors directory
		await $`cd vendors && tar -xzf cmake_temp.tar.gz`;

		// Always clean up the temp file
		await $`rm -f vendors/cmake_temp.tar.gz`;

		// Rename to simple 'cmake' directory if needed
		const extractedDir = `vendors/cmake-${cmakeVersion}-macos-universal`;
		if (existsSync(extractedDir)) {
			await $`rm -rf vendors/cmake`; // Remove old cmake if exists
			await $`mv "${extractedDir}" vendors/cmake`;
		}

		// Set the cmake binary path
		CMAKE_BIN = vendoredCmakePath;

		// Verify it works
		await $`"${CMAKE_BIN}" --version`;
		console.log("✓ cmake vendored successfully");
	} catch (error) {
		console.error("Failed to vendor cmake:", error);
		throw new Error("Could not vendor cmake. Please install it manually.");
	}
}

// Global variable to store vcvarsall path
var VCVARSALL_PATH = "";

async function findMsvcTools() {
	if (OS !== "win") return;

	try {
		const vswherePath = join(
			process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
			"Microsoft Visual Studio",
			"Installer",
			"vswhere.exe",
		);
		if (!existsSync(vswherePath)) {
			console.log("vswhere not found, using default tool names");
			return;
		}

		// Find Visual Studio installation path
		const vsInstallResult =
			await $`powershell -command "& '${vswherePath}' -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"`.quiet();
		if (
			vsInstallResult.exitCode !== 0 ||
			!vsInstallResult.stdout.toString().trim()
		) {
			console.log("Could not find Visual Studio installation path");
			return;
		}

		const vsInstallPath = vsInstallResult.stdout.toString().trim();
		VCVARSALL_PATH = join(
			vsInstallPath,
			"VC",
			"Auxiliary",
			"Build",
			"vcvarsall.bat",
		);

		if (!existsSync(VCVARSALL_PATH)) {
			console.log("vcvarsall.bat not found at expected location");
			VCVARSALL_PATH = "";
			return;
		}

		console.log("✓ Found MSVC tools with vcvarsall.bat");
	} catch {
		console.log("Could not locate MSVC tools, using default tool names");
	}
}

// Helper function to run MSVC commands with environment set up
async function runMsvcCommand(command: string) {
	if (!VCVARSALL_PATH) {
		// Fallback to running command directly
		return await $`${command}`;
	}

	// Create a temporary batch file to run the command with proper environment
	const tempBat = join(process.cwd(), "temp_build_cmd.bat");
	const batContent = `@echo off\ncall "${VCVARSALL_PATH}" x64 >nul\n${command}`;

	writeFileSync(tempBat, batContent);

	try {
		const result = await $`cmd /c "${tempBat}"`;
		await $`rm "${tempBat}"`.catch(() => {});
		return result;
	} catch (error) {
		await $`rm "${tempBat}"`.catch(() => {});
		throw error;
	}
}

function getWindowsCmakeGenerator() {
	// Prefer a toolchain-driven generator over the Visual Studio IDE generator.
	// On CI we may have MSVC Build Tools + vcvarsall without a full VS instance
	// that CMake can discover for `-G "Visual Studio 17 2022"`.
	return VCVARSALL_PATH ? "NMake Makefiles" : "Visual Studio 17 2022";
}

function getWindowsCefWrapperLibPath() {
	const candidates = [
		join(
			process.cwd(),
			"vendors",
			"cef",
			"build",
			"libcef_dll_wrapper",
			"Release",
			"libcef_dll_wrapper.lib",
		),
		join(
			process.cwd(),
			"vendors",
			"cef",
			"build",
			"libcef_dll_wrapper",
			"libcef_dll_wrapper.lib",
		),
	];

	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function installWindowsDeps() {
	const scriptPath = join(process.cwd(), "scripts", "install-windows-deps.ps1");
	if (!existsSync(scriptPath)) {
		console.error(`Installer script not found: ${scriptPath}`);
		throw new Error(
			"Windows installer script missing. Please run the installer manually.",
		);
	}

	console.log(
		"Running Windows dependency installer (may require Administrator privileges)...",
	);
	try {
		// Run the PowerShell helper (it will request elevation if needed)
		await $`powershell -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}"`;
		console.log(
			"Windows dependency installer finished. Re-checking dependencies...",
		);
	} catch (err) {
		console.error("Windows installer failed:", err);
		throw err;
	}
}

async function checkDependencies() {
	const missingDeps: string[] = [];

	if (OS === "macos") {
		// Try to vendor cmake if not available
		await vendorCmake();

		// Check for make (should be available with Xcode command line tools)
		try {
			await $`which make`.quiet();
		} catch {
			missingDeps.push(
				"make (install Xcode Command Line Tools: xcode-select --install)",
			);
		}
	} else if (OS === "win") {
		// Find MSVC compiler tools
		await findMsvcTools();

		// Check for cmake
		try {
			await $`where cmake`.quiet();
			CMAKE_BIN = "cmake";
		} catch {
			missingDeps.push("cmake");
		}

		// Check for Visual Studio (use vswhere if available)
		let vsFound = false;
		try {
			const vswherePath = join(
				process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
				"Microsoft Visual Studio",
				"Installer",
				"vswhere.exe",
			);
			if (existsSync(vswherePath)) {
				// Use PowerShell wrapper to ensure output is captured correctly on Windows
				const out =
					await $`powershell -command "& '${vswherePath}' -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"`.quiet();
				if (out.exitCode === 0 && out.stdout.toString().trim()) vsFound = true;
			} else {
				const out =
					await $`vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.quiet();
				if (out.exitCode === 0 && out.stdout.toString().trim()) vsFound = true;
			}
		} catch {
			vsFound = false;
		}

		if (!vsFound) missingDeps.push("visual-studio");

		if (missingDeps.length > 0) {
			// In CI we should not attempt interactive installs
			if (process.env["GITHUB_ACTIONS"]) {
				console.warn(
					"\n⚠️  Missing required dependencies in CI - continuing (CI should provide these)",
				);
			} else {
				try {
					await installWindowsDeps();
				} catch {
					console.error("Auto-install failed or was cancelled.");
				}

				// Re-check cmake
				const newMissing: string[] = [];
				try {
					await $`where cmake`.quiet();
					CMAKE_BIN = "cmake";
				} catch {
					newMissing.push("cmake");
				}

				// Re-check Visual Studio
				try {
					const vswherePath = join(
						process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
						"Microsoft Visual Studio",
						"Installer",
						"vswhere.exe",
					);
					let out;
					if (existsSync(vswherePath)) {
						// Use PowerShell wrapper to ensure output is captured correctly on Windows
						out =
							await $`powershell -command "& '${vswherePath}' -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath"`.quiet();
					} else {
						out =
							await $`vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`.quiet();
					}
					if (!(out && out.exitCode === 0 && out.stdout.toString().trim())) {
						newMissing.push("visual-studio");
					}
				} catch {
					newMissing.push("visual-studio");
				}

				if (newMissing.length > 0) {
					missingDeps.length = 0;
					newMissing.forEach((m) => missingDeps.push(m));
				} else {
					// clear missingDeps if everything is present now
					missingDeps.length = 0;
				}
			}
		}
	} else if (OS === "linux") {
		// Check for build essentials
		try {
			await $`which cmake`.quiet();
			CMAKE_BIN = "cmake";
		} catch {
			missingDeps.push("cmake");
		}
		try {
			await $`which make`.quiet();
		} catch {
			missingDeps.push("make");
		}
		try {
			await $`which gcc`.quiet();
		} catch {
			missingDeps.push("build-essential");
		}
	}

	if (missingDeps.length > 0) {
		console.error("\n⚠️  Missing required dependencies:");
		missingDeps.forEach((dep) => console.error(`  • ${dep}`));

		if (OS === "macos") {
			console.error("\nTo install missing dependencies on macOS:");
			console.error("• For make: Install Xcode Command Line Tools");
			console.error("   xcode-select --install");
		} else if (OS === "win") {
			console.error("\nTo install missing dependencies on Windows:");
			console.error("1. Install Visual Studio 2022 with C++ development tools");
			console.error("2. Install cmake from: https://cmake.org/download/");
		} else if (OS === "linux") {
			console.error("\nTo install missing dependencies on Linux:");
			console.error(
				"   sudo apt update && sudo apt install -y build-essential cmake",
			);
		}

		// In CI, just warn but continue; locally throw an error
		if (process.env["GITHUB_ACTIONS"]) {
			console.warn(
				"\n⚠️  Running in CI - continuing despite missing dependencies",
			);
			console.warn(
				"   The CI workflow should have already installed these dependencies",
			);
		} else {
			throw new Error(
				"Missing required dependencies. Please install them and try again.",
			);
		}
	}

	console.log("✓ All required dependencies found");
}

async function setup() {
	await checkDependencies();
	// Run vendors sequentially to avoid network/curl conflicts
	// GitHub downloads have built-in pauses to avoid rate limiting
	await vendorBun(); // GitHub
	await vendorBsdiff(); // GitHub
	await vendorZstd(); // GitHub
	await vendorAsar(); // GitHub
	await vendorWGPU(); // GitHub
	await vendorZig(); // ziglang.org (not GitHub)
	await vendorRust(); // static.rust-lang.org (not GitHub)
	await vendorGo(); // go.dev (not GitHub)
	await vendorDashCli(); // pinned release or explicit local override
	await vendorCottontail(); // normally supplied by the pinned Dash release
	await vendorCEF(); // Spotify CDN (not GitHub)
	await vendorWebview2();
	await vendorLinuxDeps();
}

async function build() {
	await createDistFolder();
	await installPackageDependencies();

	// await buildAsar(); // Now using vendored binaries from zig-asar releases
	await buildNative(); // zig depends on this for linking symbols

	// Build preload script (compiles TypeScript to JS for webview injection)
	console.log("Building preload script...");
	await buildPreload();

	await Promise.all([
		buildSelfExtractor(),
		buildCore(),
		buildLauncher(),
		buildMainJs(),
	]);
}

async function buildForNpm() {
	console.log("Creating dist folder for npm...");
	await createDistFolder();

	console.log("Building main.js...");
	await buildMainJs();

	// Build preload script (compiles TypeScript to JS for webview injection)
	// Must run before copyApiFiles so the generated file is included
	console.log("Building preload script...");
	await buildPreload();

	console.log("Copying API files...");
	await copyApiFiles();

	console.log(
		"npm build complete! dist/ contains main.js and api/ folder (bun, browser, shared APIs).",
	);
}

async function copyApiFiles() {
	// Copy TypeScript APIs while preserving source-relative imports.
	// Use Node's copy implementation here so directory-root semantics stay the
	// same across Windows and Unix shells.
	mkdirSync("dist/api/sdks", { recursive: true });
	cpSync("src/sdks/bun", "dist/api/sdks/bun", { recursive: true, force: true });
	cpSync("src/browser", "dist/api/browser", { recursive: true, force: true });
	cpSync("src/shared", "dist/api/shared", { recursive: true, force: true });
	cpSync("src/config", "dist/api/config", { recursive: true, force: true });
	cpSync("src/preload", "dist/api/preload", { recursive: true, force: true });

	mkdirSync("dist/zig-sdk", { recursive: true });
	cpSync("src/sdks/zig/electrobun.zig", "dist/zig-sdk/electrobun.zig", {
		force: true,
	});
	mkdirSync("dist/rust-sdk", { recursive: true });
	cpSync("src/sdks/rust/electrobun.rs", "dist/rust-sdk/electrobun.rs", {
		force: true,
	});
	mkdirSync("dist/go-sdk", { recursive: true });
	cpSync("src/sdks/go", "dist/go-sdk", { recursive: true, force: true });
}

async function copyToDist() {
	// Bun runtime
	await $`cp ${PATH.bun.RUNTIME} ${PATH.bun.DIST}`;
	// Zig launcher for all platforms
	await $`cp src/launcher/zig-out/bin/launcher${binExt} dist/launcher${binExt}`;
	await $`cp src/extractor/zig-out/bin/extractor${binExt} dist/extractor${binExt}`;
	const coreLibName =
		OS === "win"
			? "ElectrobunCore.dll"
			: OS === "macos"
				? "libElectrobunCore.dylib"
				: "libElectrobunCore.so";
	const coreLibSourceDir = OS === "win" ? "bin" : "lib";
	await $`cp ${join("src", "core", "zig-out", coreLibSourceDir, coreLibName)} ${join("dist", coreLibName)}`;
	// Copy bsdiff/bspatch from vendored zig-bsdiff
	await $`cp vendors/zig-bsdiff/bsdiff${binExt} dist/bsdiff${binExt}`;
	await $`cp vendors/zig-bsdiff/bspatch${binExt} dist/bspatch${binExt}`;
	// Copy zig-zstd from vendored zig-zstd
	await $`cp vendors/zig-zstd/zig-zstd${binExt} dist/zig-zstd${binExt}`;

	// Copy zig-asar CLI and library from vendored zig-asar
	const libExt = OS === "win" ? ".dll" : OS === "macos" ? ".dylib" : ".so";

	// Copy electrobun-dawn (WGPU) shared library only
	const wgpuSourceDir = join(process.cwd(), "vendors", "wgpu", `${OS}-${ARCH}`);
	if (existsSync(wgpuSourceDir)) {
		const wgpuLibCandidates =
			OS === "win"
				? [
						join(wgpuSourceDir, "bin", "webgpu_dawn.dll"),
						join(wgpuSourceDir, "bin", "libwebgpu_dawn.dll"),
						join(wgpuSourceDir, "lib", "webgpu_dawn.dll"),
						join(wgpuSourceDir, "lib", "libwebgpu_dawn.dll"),
					]
				: [
						join(wgpuSourceDir, "lib", `libwebgpu_dawn${libExt}`),
						join(wgpuSourceDir, "lib", `libwebgpu_dawn_shared${libExt}`),
					];

		const wgpuLib = wgpuLibCandidates.find((p) => existsSync(p));
		if (!wgpuLib) {
			throw new Error(`WGPU shared library not found in ${wgpuSourceDir}`);
		}
		await $`cp ${wgpuLib} dist/${basename(wgpuLib)}`;
		console.log("✓ Copied WGPU shared library to dist");

		// On Windows, Dawn needs d3dcompiler_47.dll for D3D shader compilation.
		// ARM64 Windows doesn't have an x64 version in system directories,
		// so we must bundle it alongside the WGPU library.
		if (OS === "win") {
			const d3dCompilerCandidates = [
				join(wgpuSourceDir, "bin", "d3dcompiler_47.dll"),
				join(process.cwd(), "vendors", "cef", "Release", "d3dcompiler_47.dll"),
			];
			const d3dCompiler = d3dCompilerCandidates.find((p) => existsSync(p));
			if (d3dCompiler) {
				await $`cp ${d3dCompiler} dist/d3dcompiler_47.dll`;
				console.log("✓ Copied d3dcompiler_47.dll to dist");
			}
		}
	}

	if (OS === "win") {
		// On Windows, copy both x64 and arm64 versions
		// Note: DLL is needed by launcher to extract bun/index.js from ASAR
		await $`mkdir -p dist/zig-asar/x64 dist/zig-asar/arm64`;

		// Copy x64 version
		await $`cp vendors/zig-asar/x64/zig-asar.exe dist/zig-asar/x64/zig-asar.exe`;
		await $`cp vendors/zig-asar/x64/libasar.dll dist/zig-asar/x64/libasar.dll`;

		// Copy arm64 version
		await $`cp vendors/zig-asar/arm64/zig-asar.exe dist/zig-asar/arm64/zig-asar.exe`;
		await $`cp vendors/zig-asar/arm64/libasar.dll dist/zig-asar/arm64/libasar.dll`;

		console.log("✓ Copied both x64 and arm64 zig-asar to dist");
	} else {
		// Unix: single architecture
		await $`cp vendors/zig-asar/zig-asar${binExt} dist/zig-asar${binExt}`;
		const asarLibPath = `vendors/zig-asar/libasar${libExt}`;
		if (existsSync(asarLibPath)) {
			await $`cp ${asarLibPath} dist/libasar${libExt}`;
		} else {
			throw new Error(`Required library file not found: ${asarLibPath}`);
		}
	}

	// Verify critical files were copied
	if (OS === "macos") {
		const launcherPath = join("dist", `launcher${binExt}`);
		if (!existsSync(launcherPath)) {
			throw new Error(`launcher${binExt} was not copied to ${launcherPath}`);
		}
		console.log(`launcher${binExt} copied successfully to ${launcherPath}`);
	}
	// Electrobun npm launcher
	await $`cp src/npmbin/index.js dist/npmbin.js`;
	if (existsSync(PATH.cottontail.BIN)) {
		await $`cp ${PATH.cottontail.BIN} ${PATH.cottontail.DIST}`;
	}
	if (existsSync(PATH.dashCli.BIN)) {
		await $`cp ${PATH.dashCli.BIN} ${PATH.dashCli.DIST}`;
	}
	await $`mkdir -p bin`;
	rmSync(join("bin", OS === "win" ? "electrobun.exe" : "electrobun"), {
		force: true,
	});
	if (existsSync(PATH.cottontail.BIN)) {
		await copyExecutableToBin(PATH.cottontail.BIN, cottontailBinary);
	}
	if (existsSync(PATH.dashCli.BIN)) {
		await copyExecutableToBin(PATH.dashCli.BIN, dashCliBinary);
	}
	writeFileSync(join("bin", ".runtime-platform"), `${runtimePlatformKey()}\n`);
	// Electrobun's Typescript bun and browser apis
	await copyApiFiles();
	// Native code and frameworks
	if (OS === "macos") {
		await $`cp -R src/native/build/libNativeWrapper.dylib dist/libNativeWrapper.dylib`;
		// Copy CEF to cef/ subdirectory for consistent organization
		await $`mkdir -p dist/cef`;
		cpSync(
			join(
				"vendors",
				"cef",
				"Release",
				"Chromium Embedded Framework.framework",
			),
			join("dist", "cef", "Chromium Embedded Framework.framework"),
			{ recursive: true, force: true, preserveTimestamps: true },
		);
		// CEF's helper process binary
		cpSync(
			join("src", "native", "build", "process_helper"),
			join("dist", "process_helper"),
		);
	} else if (OS === "win") {
		await $`cp src/native/win/build/libNativeWrapper.dll dist/libNativeWrapper.dll`;
		// native system webview library - always use x64 for Windows
		const webview2Arch = "x64";
		await $`cp vendors/webview2/Microsoft.Web.WebView2/build/native/${webview2Arch}/WebView2Loader.dll dist/WebView2Loader.dll`;
		// CEF binaries for Windows - copy ALL CEF files to cef/ subdirectory for consistent organization
		await $`powershell -command "New-Item -ItemType Directory -Path 'dist/cef' -Force | Out-Null"`;
		// Copy main CEF DLLs to cef/ subdirectory
		await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.dll') { Copy-Item 'vendors/cef/Release/*.dll' 'dist/cef/' -Force }"`;

		// Copy all available resource files to cef/ subdirectory from both Release and Resources directories
		console.log("Copying CEF resource files...");

		// Copy .pak files from Resources directory
		await $`powershell -command "if (Test-Path 'vendors/cef/Resources/*.pak') { Write-Host 'Found .pak files in Resources, copying...'; Copy-Item 'vendors/cef/Resources/*.pak' 'dist/cef/' -Force } else { Write-Host 'No .pak files found in vendors/cef/Resources/' }"`;

		// Copy resource files from Release directory
		await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.pak') { Write-Host 'Found .pak files in Release, copying...'; Copy-Item 'vendors/cef/Release/*.pak' 'dist/cef/' -Force }"`;
		await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.dat') { Copy-Item 'vendors/cef/Release/*.dat' 'dist/cef/' -Force }"`;
		await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.bin') { Copy-Item 'vendors/cef/Release/*.bin' 'dist/cef/' -Force }"`;

		// Copy icudtl.dat directly to cef/ root (same folder as DLLs) - this is required for CEF initialization
		await $`powershell -command "if (Test-Path 'vendors/cef/Resources/icudtl.dat') { Copy-Item 'vendors/cef/Resources/icudtl.dat' 'dist/cef/' -Force }"`.catch(
			() => {},
		);

		// CEF locales to cef/Resources/locales subdirectory
		await $`powershell -command "if (-not (Test-Path 'dist/cef/Resources')) { New-Item -ItemType Directory -Path 'dist/cef/Resources' -Force | Out-Null }"`;
		await $`powershell -command "if (Test-Path 'vendors/cef/Resources/locales') { Copy-Item 'vendors/cef/Resources/locales' 'dist/cef/Resources/' -Recurse -Force }"`.catch(
			() => {},
		);

		// Copy CEF helper process
		await $`cp src/native/build/process_helper.exe dist/process_helper.exe`;
	} else if (OS === "linux") {
		// Copy both GTK-only and CEF native wrappers for flexible deployment
		if (
			existsSync(
				join(process.cwd(), "src", "native", "build", "libNativeWrapper.so"),
			)
		) {
			await $`cp src/native/build/libNativeWrapper.so dist/libNativeWrapper.so`;
		}
		if (
			existsSync(
				join(
					process.cwd(),
					"src",
					"native",
					"build",
					"libNativeWrapper_cef.so",
				),
			)
		) {
			await $`cp src/native/build/libNativeWrapper_cef.so dist/libNativeWrapper_cef.so`;
		}

		// CEF binaries for Linux - copy to cef/ subdirectory
		if (existsSync(join(process.cwd(), "vendors", "cef", "Release"))) {
			console.log("Copying CEF files for Linux...");
			await $`mkdir -p dist/cef`;

			// Copy main CEF library and dependencies
			await $`cp vendors/cef/Release/*.so dist/cef/`;
			await $`cp vendors/cef/Release/*.so.* dist/cef/`; // For versioned libraries like libvulkan.so.1
			await $`cp vendors/cef/Release/*.bin dist/cef/`;
			await $`cp vendors/cef/Release/*.json dist/cef/`; // For vk_swiftshader_icd.json

			// Strip debug symbols from CEF libraries to reduce file size
			console.log("Stripping debug symbols from CEF libraries...");
			await $`strip --strip-debug dist/cef/*.so dist/cef/*.so.* 2>/dev/null || true`;

			// Copy stripped CEF files to platform-specific directory
			const platformCefDir = `dist-${OS}-${ARCH}/cef`;
			await $`mkdir -p ${platformCefDir}`;
			await $`cp -r dist/cef/* ${platformCefDir}/`;
			console.log(`Copied stripped CEF files to ${platformCefDir}`);

			// Copy chrome-sandbox (needs setuid root)
			if (
				existsSync(
					join(process.cwd(), "vendors", "cef", "Release", "chrome-sandbox"),
				)
			) {
				await $`cp vendors/cef/Release/chrome-sandbox dist/cef/`;
			}

			// Copy Resources
			await $`cp vendors/cef/Resources/*.pak dist/cef/`;
			await $`cp vendors/cef/Resources/*.dat dist/cef/`;

			// Copy locales
			await $`mkdir -p dist/cef/locales`;
			await $`cp vendors/cef/Resources/locales/*.pak dist/cef/locales/`;
		} else {
			console.log("CEF not built, skipping CEF file copying");
		}

		// Copy CEF helper process if it exists
		if (
			existsSync(
				join(process.cwd(), "src", "native", "build", "process_helper"),
			)
		) {
			await $`cp src/native/build/process_helper dist/process_helper`;
		}
		console.log("[done]Copying CEF files for Linux...");
	}

	normalizeDistExecutableModes("dist");
	// Create platform-specific dist folder and copy all files
	await createPlatformDistFolder();
}

function normalizeDistExecutableModes(directory: string) {
	if (OS === "win") return;
	for (const filename of [
		bunBin,
		cottontailBinary,
		dashCliBinary,
		"launcher",
		"extractor",
		"bsdiff",
		"bspatch",
		"zig-asar",
		"zig-zstd",
		"process_helper",
	]) {
		const path = join(directory, filename);
		if (existsSync(path)) chmodSync(path, 0o755);
	}
}

async function createPlatformDistFolder() {
	// Create platform-specific dist folder (e.g., dist-linux-arm64)
	const platformDistDir = `dist-${OS}-${ARCH}`;
	console.log(`Creating platform-specific dist folder: ${platformDistDir}`);

	await $`mkdir -p ${platformDistDir}`;

	// Copy all files from dist/ to platform-specific folder
	if (OS === "win") {
		// On Windows use PowerShell to copy all files
		await $`powershell -command "Copy-Item -Path 'dist\\*' -Destination '${platformDistDir}\\' -Recurse -Force"`;
	} else if (OS === "macos") {
		rmSync(platformDistDir, { recursive: true, force: true });
		cpSync("dist", platformDistDir, {
			recursive: true,
			force: true,
			preserveTimestamps: true,
		});
	} else {
		// On Unix systems - use rsync with delete to ensure clean copy
		// The --delete flag removes files in destination that don't exist in source
		// This handles read-only files that might prevent overwriting
		await $`rsync -a --delete dist/ ${platformDistDir}/`;
	}
	normalizeDistExecutableModes(platformDistDir);

	// NOTE: We no longer remove adhoc signatures from binaries
	// These signatures are actually required for the binaries to run on macOS
	// The notarization issues were fixed by using proper entitlements and not using --deep

	console.log(`Successfully created and populated ${platformDistDir}`);
}

function getPlatform() {
	switch (platform()) {
		case "win32":
			return "win";
		case "darwin":
			return "macos";
		case "linux":
			return "linux";
		default:
			throw new Error("unsupported platform");
	}
}

function getArch() {
	switch (arch()) {
		case "arm64":
			return "arm64";
		case "x64":
			return "x64";
		default:
			throw new Error("unsupported arch");
	}
}

async function createDistFolder() {
	await $`rm -rf dist`;
	await $`mkdir -p dist/api`;
	await $`mkdir -p dist/api/sdks`;
	await $`mkdir -p dist/api/browser`;
	if (OS === "win" || OS === "linux") {
		await $`mkdir -p dist/cef`;
	}
}

async function copyExecutableToBin(source: string, filename: string) {
	const destination = join("bin", filename);

	if (OS === "win") {
		await $`cp ${source} ${destination}`;
		return;
	}

	const tempDestination = `${destination}.tmp-${Date.now()}-${Math.floor(
		Math.random() * 1_000_000,
	)}`;

	try {
		await $`cp ${source} ${tempDestination}`;
		await $`chmod +x ${tempDestination}`;
		await signExecutableIfNeeded(tempDestination);
		renameSync(tempDestination, destination);
	} finally {
		if (existsSync(tempDestination)) {
			unlinkSync(tempDestination);
		}
	}
}

async function signExecutableIfNeeded(path: string) {
	if (OS !== "macos") return;
	await $`codesign --force --sign - ${path}`;
}

async function installPackageDependencies() {
	await $`npm install`;
}

async function vendorBun() {
	// Check if vendored Bun version matches expected version.
	// When the hardcoded version is bumped (e.g. after a git pull),
	// this detects the mismatch and forces a clean re-vendor.
	const bunDir = join(process.cwd(), "vendors", "bun");
	const bunVersionFile = join(bunDir, ".bun-version");

	if (existsSync(PATH.bun.RUNTIME)) {
		if (existsSync(bunVersionFile)) {
			const vendoredVersion = readFileSync(bunVersionFile, "utf-8").trim();
			if (vendoredVersion !== BUN_VERSION) {
				console.log(
					`Bun version mismatch: vendored "${vendoredVersion}" vs expected "${BUN_VERSION}"`,
				);
				console.log("Cleaning stale Bun binary and re-vendoring...");
				unlinkSync(PATH.bun.RUNTIME);
			} else {
				return;
			}
		} else {
			// Binary exists but no version stamp (legacy state) — write one and keep going
			mkdirSync(bunDir, { recursive: true });
			writeFileSync(bunVersionFile, BUN_VERSION);
			return;
		}
	}

	await pauseForGitHub();

	let bunUrlSegment: string;
	let bunDirName: string;

	if (OS === "win") {
		// Use baseline x64 for Windows to ensure ARM64 compatibility
		bunUrlSegment = "bun-windows-x64-baseline.zip";
		bunDirName = "bun-windows-x64-baseline";
	} else if (OS === "macos") {
		bunUrlSegment =
			ARCH === "arm64" ? "bun-darwin-aarch64.zip" : "bun-darwin-x64.zip";
		bunDirName = ARCH === "arm64" ? "bun-darwin-aarch64" : "bun-darwin-x64";
	} else if (OS === "linux") {
		bunUrlSegment =
			ARCH === "arm64" ? "bun-linux-aarch64.zip" : "bun-linux-x64.zip";
		bunDirName = ARCH === "arm64" ? "bun-linux-aarch64" : "bun-linux-x64";
	} else {
		throw new Error(`Unsupported platform: ${OS}`);
	}

	const tempZipPath = join("vendors", "bun", "temp.zip");
	const extractDir = join("vendors", "bun");

	// Download zip file
	await $`mkdir -p ${extractDir} && curl -L -o ${tempZipPath} https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bunUrlSegment}`;

	// Validate download
	validateDownload(tempZipPath, "bun");

	// Extract zip file
	if (isWindows) {
		// Use PowerShell to extract zip on Windows
		await $`powershell -command "Expand-Archive -Path ${tempZipPath} -DestinationPath ${extractDir} -Force"`;
	} else {
		// Use unzip on macOS/Linux
		await $`unzip -o ${tempZipPath} -d ${extractDir}`;
	}

	// Move the bun binary to the correct location
	// The path inside the zip might be different depending on the platform
	if (isWindows) {
		await $`mv ${join("vendors", "bun", bunDirName, "bun.exe")} ${PATH.bun.RUNTIME}`;
	} else {
		await $`mv ${join("vendors", "bun", bunDirName, "bun")} ${PATH.bun.RUNTIME}`;
	}

	// Add execute permissions on non-Windows platforms
	if (!isWindows) {
		await $`chmod +x ${PATH.bun.RUNTIME}`;
	}

	// Clean up
	await $`rm ${tempZipPath}`;
	await $`rm -rf ${join("vendors", "bun", bunDirName)}`;

	// Write version stamp so future builds can detect staleness
	writeFileSync(join("vendors", "bun", ".bun-version"), BUN_VERSION);
}

async function vendorZig() {
	if (existsSync(PATH.zig.BIN)) {
		return;
	}

	if (OS === "macos") {
		const zigArch = ARCH === "arm64" ? "aarch64" : "x86_64";
		await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/zig-macos-${zigArch}-0.13.0.tar.xz | tar -xJ --strip-components=1 -C vendors/zig zig-macos-${zigArch}-0.13.0/zig zig-macos-${zigArch}-0.13.0/lib  zig-macos-${zigArch}-0.13.0/doc`;
	} else if (OS === "win") {
		// Always use x64 for Windows since we only build x64 Windows binaries
		const zigArch = "x86_64";
		const zigFolder = `zig-windows-${zigArch}-0.13.0`;
		await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/${zigFolder}.zip -o vendors/zig.zip && powershell -ExecutionPolicy Bypass -Command Expand-Archive -Path vendors/zig.zip -DestinationPath vendors/zig-temp && mv vendors/zig-temp/${zigFolder}/zig.exe vendors/zig && mv vendors/zig-temp/${zigFolder}/lib vendors/zig/`;
	} else if (OS === "linux") {
		const zigArch = ARCH === "arm64" ? "aarch64" : "x86_64";
		await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/zig-linux-${zigArch}-0.13.0.tar.xz | tar -xJ --strip-components=1 -C vendors/zig zig-linux-${zigArch}-0.13.0/zig zig-linux-${zigArch}-0.13.0/lib zig-linux-${zigArch}-0.13.0/doc`;
	}
}

function getRustHostTriple(): string {
	if (OS === "macos") {
		return ARCH === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	}
	if (OS === "linux") {
		return ARCH === "arm64"
			? "aarch64-unknown-linux-gnu"
			: "x86_64-unknown-linux-gnu";
	}
	if (OS === "win") {
		// Keep Windows aligned with the current Electrobun target policy.
		return "x86_64-pc-windows-msvc";
	}
	throw new Error(`Unsupported platform: ${OS}`);
}

async function verifyVendoredRust() {
	const versionResult = await $`${PATH.rust.BIN} --version`.quiet();
	const versionOutput = versionResult.stdout.toString().trim();
	if (!versionOutput.startsWith(`rustc ${RUST_VERSION}`)) {
		throw new Error(
			`Vendored Rust version mismatch: expected rustc ${RUST_VERSION}, got "${versionOutput}"`,
		);
	}
}

async function vendorRust() {
	const rustDir = join(process.cwd(), "vendors", "rust");
	const rustVersionFile = join(rustDir, ".rust-version");

	if (existsSync(PATH.rust.BIN)) {
		if (existsSync(rustVersionFile)) {
			const vendoredVersion = readFileSync(rustVersionFile, "utf-8").trim();
			if (vendoredVersion === RUST_VERSION) {
				await verifyVendoredRust();
				return;
			}
			console.log(
				`Rust version mismatch: vendored "${vendoredVersion}" vs expected "${RUST_VERSION}"`,
			);
		} else {
			try {
				await verifyVendoredRust();
				writeFileSync(rustVersionFile, RUST_VERSION);
				return;
			} catch {
				console.log("Rust vendor directory found without a valid version stamp.");
			}
		}

		console.log("Cleaning stale Rust toolchain and re-vendoring...");
		await $`rm -rf ${rustDir}`;
	}

	const rustTriple = getRustHostTriple();
	const rustFolder = `rust-${RUST_VERSION}-${rustTriple}`;
	const tempTarball = join("vendors", `rust-${RUST_VERSION}-${rustTriple}.tar.xz`);
	const tempExtractDir = join("vendors", `rust-extract-${Date.now()}`);
	const rustUrl = `https://static.rust-lang.org/dist/${rustFolder}.tar.xz`;

	try {
		await $`mkdir -p vendors ${tempExtractDir}`;
		console.log(`Downloading Rust ${RUST_VERSION} for ${rustTriple}...`);
		await $`curl -L "${rustUrl}" -o "${tempTarball}"`;
		validateDownload(tempTarball, "rust");

		await $`tar -xJf "${tempTarball}" -C "${tempExtractDir}"`;
		const extractedDir = join(tempExtractDir, rustFolder);
		const installScript = join(extractedDir, "install.sh");
		if (!existsSync(installScript)) {
			throw new Error(`Rust installer not found at ${installScript}`);
		}

		if (OS === "win") {
			mkdirSync(rustDir, { recursive: true });
			const componentsFile = join(extractedDir, "components");
			const components = readFileSync(componentsFile, "utf-8")
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			for (const component of components) {
				const componentDir = join(extractedDir, component);
				for (const entry of readdirSync(componentDir, { withFileTypes: true })) {
					if (entry.name === "manifest.in") continue;
					cpSync(join(componentDir, entry.name), join(rustDir, entry.name), {
						recursive: true,
						force: true,
					});
				}
			}
		} else {
			await $`sh "${installScript}" --prefix="${rustDir}" --disable-ldconfig`;
		}
		await verifyVendoredRust();
		writeFileSync(rustVersionFile, RUST_VERSION);
		console.log("✓ Rust toolchain vendored successfully");
	} catch (error) {
		console.error("Failed to vendor Rust:", error);
		throw new Error("Could not vendor Rust toolchain.");
	} finally {
		await $`rm -f "${tempTarball}"`.catch(() => {});
		await $`rm -rf "${tempExtractDir}"`.catch(() => {});
	}
}

function getGoHostTuple(): { goOS: string; goArch: string } {
	const goOS = OS === "macos" ? "darwin" : OS === "win" ? "windows" : "linux";
	const goArch = ARCH === "arm64" ? "arm64" : "amd64";
	return { goOS, goArch };
}

async function verifyVendoredGo() {
	const versionResult = await $`${PATH.go.BIN} version`.quiet();
	const versionOutput = versionResult.stdout.toString().trim();
	if (!versionOutput.startsWith(`go version go${GO_VERSION} `)) {
		throw new Error(
			`Vendored Go version mismatch: expected go${GO_VERSION}, got "${versionOutput}"`,
		);
	}
}

async function vendorGo() {
	const goDir = join(process.cwd(), "vendors", "go");
	const goVersionFile = join(goDir, ".go-version");

	if (existsSync(PATH.go.BIN)) {
		if (existsSync(goVersionFile)) {
			const vendoredVersion = readFileSync(goVersionFile, "utf-8").trim();
			if (vendoredVersion === GO_VERSION) {
				await verifyVendoredGo();
				return;
			}
			console.log(
				`Go version mismatch: vendored "${vendoredVersion}" vs expected "${GO_VERSION}"`,
			);
		} else {
			try {
				await verifyVendoredGo();
				writeFileSync(goVersionFile, GO_VERSION);
				return;
			} catch {
				console.log("Go vendor directory found without a valid version stamp.");
			}
		}

		console.log("Cleaning stale Go toolchain and re-vendoring...");
		await $`rm -rf ${goDir}`;
	}

	const { goOS, goArch } = getGoHostTuple();
	const archiveExt = OS === "win" ? "zip" : "tar.gz";
	const archiveName = `go${GO_VERSION}.${goOS}-${goArch}.${archiveExt}`;
	const tempArchive = join("vendors", archiveName);
	const goUrl = `https://go.dev/dl/${archiveName}`;

	try {
		await $`mkdir -p vendors`;
		console.log(`Downloading Go ${GO_VERSION} for ${goOS}-${goArch}...`);
		await $`curl -L "${goUrl}" -o "${tempArchive}"`;
		validateDownload(tempArchive, "go");

		if (OS === "win") {
			await $`powershell -ExecutionPolicy Bypass -Command Expand-Archive -Path "${tempArchive}" -DestinationPath vendors -Force`;
		} else {
			await $`tar -xzf "${tempArchive}" -C vendors`;
		}

		await verifyVendoredGo();
		writeFileSync(goVersionFile, GO_VERSION);
		console.log("✓ Go toolchain vendored successfully");
	} catch (error) {
		console.error("Failed to vendor Go:", error);
		throw new Error("Could not vendor Go toolchain.");
	} finally {
		await $`rm -f "${tempArchive}"`.catch(() => {});
	}
}

function defaultDashCliRoot() {
	return resolve(process.cwd(), "..", "..", "dash-cloud", "dash-cli");
}

function defaultCottontailRoot() {
	return resolve(process.cwd(), "..", "..", "cottontail");
}

function environmentFlagEnabled(name: string) {
	const value = process.env[name]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function resolveCottontailRoot() {
	return resolve(
		process.env["DASH_COTTONTAIL_ROOT"] ||
			process.env["COTTONTAIL_ROOT"] ||
			defaultCottontailRoot(),
	);
}

function runtimePlatformKey() {
	if (OS === "win") return "windows-x64";
	if (OS === "macos" && ARCH === "arm64") return "macos-arm64";
	if (OS === "linux") return `linux-${ARCH}`;
	throw new Error(`No Dash/Cottontail release is published for ${OS}-${ARCH}`);
}

function readReleaseMetadata(path: string) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function metadataMatches(
	path: string,
	release: RuntimeRelease,
	platformKey: string,
) {
	if (!existsSync(path)) return false;
	try {
		const metadata = readReleaseMetadata(path);
		return (
			metadata.name === release.name &&
			metadata.version === release.version &&
			metadata.revision === release.revision &&
			metadata.platform === platformKey
		);
	} catch {
		return false;
	}
}

function assertReleaseMetadata(
	path: string,
	release: RuntimeRelease,
	platformKey: string,
) {
	if (!metadataMatches(path, release, platformKey)) {
		throw new Error(
			`Downloaded ${release.name} metadata does not match the pinned ${release.version}@${release.revision} ${platformKey} release`,
		);
	}
	return readReleaseMetadata(path);
}

async function downloadRuntimeRelease(
	release: RuntimeRelease,
	platformKey: string,
) {
	const artifact = release.platforms[platformKey]?.archive;
	if (!artifact) {
		throw new Error(`${release.name} ${release.version} has no ${platformKey} artifact`);
	}

	const tempRoot = join(
		process.cwd(),
		"vendors",
		`.${release.name}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
	);
	const archivePath = join(tempRoot, "release.tar.gz");
	const extractRoot = join(tempRoot, "extract");
	mkdirSync(extractRoot, { recursive: true });

	console.log(
		`Downloading ${release.name} ${release.version} (${platformKey})...`,
	);
	// Use the system downloader for large binary payloads. This build script is
	// intentionally runnable under Cottontail, whose fetch compatibility layer
	// is not the right byte transport for release archives yet.
	await $`curl -fsSL --retry 3 ${artifact.url} -o ${archivePath}`;
	const bytes = readFileSync(archivePath);
	const actualSha256 = createHash("sha256").update(bytes).digest("hex");
	if (actualSha256 !== artifact.sha256) {
		throw new Error(
			`${release.name} checksum mismatch: expected ${artifact.sha256}, got ${actualSha256}`,
		);
	}
	if (bytes.byteLength !== artifact.size) {
		throw new Error(
			`${release.name} size mismatch: expected ${artifact.size}, got ${bytes.byteLength}`,
		);
	}
	await $`tar -xzf ${archivePath} -C ${extractRoot}`;

	const entries = readdirSync(extractRoot, { withFileTypes: true }).filter(
		(entry) => entry.isDirectory(),
	);
	if (entries.length !== 1) {
		throw new Error(`${release.name} archive did not contain one package root`);
	}

	return {
		packageRoot: join(extractRoot, entries[0]!.name),
		cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
	};
}

async function installCottontailPayload(
	packageRoot: string,
	release: RuntimeRelease,
	platformKey: string,
) {
	const metadataPath = join(packageRoot, "cottontail-release.json");
	assertReleaseMetadata(metadataPath, release, platformKey);
	const sourceBinary = join(packageRoot, "bin", cottontailBinary);
	if (!existsSync(sourceBinary)) {
		throw new Error("Cottontail release is missing its executable");
	}

	const destination = join(process.cwd(), "vendors", "cottontail");
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	cpSync(sourceBinary, PATH.cottontail.BIN);
	cpSync(metadataPath, join(destination, "cottontail-release.json"));
	if (OS !== "win") await $`chmod +x ${PATH.cottontail.BIN}`;
	await signExecutableIfNeeded(PATH.cottontail.BIN);
}

async function installLocalCottontail(binary: string) {
	const destination = join(process.cwd(), "vendors", "cottontail");
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	cpSync(binary, PATH.cottontail.BIN);
	if (OS !== "win") await $`chmod +x ${PATH.cottontail.BIN}`;
	await signExecutableIfNeeded(PATH.cottontail.BIN);
}

async function vendorCottontail() {
	const envBinary =
		process.env["DASH_COTTONTAIL"] || process.env["COTTONTAIL_BINARY"];
	if (envBinary) {
		if (!existsSync(envBinary)) {
			throw new Error(`Cottontail binary does not exist: ${envBinary}`);
		}
		await installLocalCottontail(envBinary);
		console.log(
			`✓ Cottontail vendored from binary override: ${PATH.cottontail.BIN}`,
		);
		return;
	}

	const cottontailRoot = resolveCottontailRoot();
	const buildZig = join(cottontailRoot, "build.zig");
	const sourceBinary = join(cottontailRoot, "zig-out", "bin", cottontailBinary);
	const useLocalCottontail = environmentFlagEnabled(
		"DASH_USE_LOCAL_COTTONTAIL",
	);
	if (useLocalCottontail && (!existsSync(buildZig) || !existsSync(sourceBinary))) {
		throw new Error(
			`DASH_USE_LOCAL_COTTONTAIL is set, but no built Cottontail was found at ${sourceBinary}`,
		);
	}

	if (
		(useLocalCottontail ||
			process.env["DASH_COTTONTAIL_ROOT"] ||
			process.env["COTTONTAIL_ROOT"]) &&
		existsSync(buildZig) &&
		existsSync(sourceBinary)
	) {
		await installLocalCottontail(sourceBinary);
		console.log(`✓ Cottontail vendored from existing build at ${PATH.cottontail.BIN}`);
		return;
	}

	const platformKey = runtimePlatformKey();
	const metadataPath = join(
		process.cwd(),
		"vendors",
		"cottontail",
		"cottontail-release.json",
	);
	if (
		existsSync(PATH.cottontail.BIN) &&
		metadataMatches(metadataPath, RUNTIME_ARTIFACTS.cottontail, platformKey)
	) {
		console.log(`✓ Using existing vendored Cottontail at ${PATH.cottontail.BIN}`);
		return;
	}

	const downloaded = await downloadRuntimeRelease(
		RUNTIME_ARTIFACTS.cottontail,
		platformKey,
	);
	try {
		await installCottontailPayload(
			downloaded.packageRoot,
			RUNTIME_ARTIFACTS.cottontail,
			platformKey,
		);
	} finally {
		downloaded.cleanup();
	}
	console.log(`✓ Cottontail ${RUNTIME_ARTIFACTS.cottontail.version} vendored`);
}

async function vendorDashCli() {
	const envBinary = process.env["DASH_CLI_BINARY"];
	if (envBinary) {
		if (!existsSync(envBinary)) {
			throw new Error(`DASH_CLI_BINARY does not exist: ${envBinary}`);
		}
		rmSync(join(process.cwd(), "vendors", "dash-cli"), { recursive: true, force: true });
		mkdirSync(join(process.cwd(), "vendors", "dash-cli"), { recursive: true });
		cpSync(envBinary, PATH.dashCli.BIN);
		if (OS !== "win") {
			await $`chmod +x ${PATH.dashCli.BIN}`;
		}
		console.log(`✓ Dash CLI vendored from DASH_CLI_BINARY: ${PATH.dashCli.BIN}`);
		return;
	}

	const dashCliRoot = resolve(process.env["DASH_CLI_ROOT"] || defaultDashCliRoot());
	const buildScript = join(dashCliRoot, "scripts", "build.sh");
	const sourceBinary = join(dashCliRoot, "zig-out", "bin", dashCliBinary);

	if (
		process.env["DASH_CLI_ROOT"] &&
		existsSync(buildScript) &&
		existsSync(sourceBinary)
	) {
		rmSync(join(process.cwd(), "vendors", "dash-cli"), { recursive: true, force: true });
		mkdirSync(join(process.cwd(), "vendors", "dash-cli"), { recursive: true });
		cpSync(sourceBinary, PATH.dashCli.BIN);
		if (OS !== "win") await $`chmod +x ${PATH.dashCli.BIN}`;
		await signExecutableIfNeeded(PATH.dashCli.BIN);
		console.log(`✓ Dash CLI vendored from existing build at ${PATH.dashCli.BIN}`);
		return;
	}

	const platformKey = runtimePlatformKey();
	const dashMetadataPath = join(
		process.cwd(),
		"vendors",
		"dash-cli",
		"dash-cli-release.json",
	);
	const cottontailMetadataPath = join(
		process.cwd(),
		"vendors",
		"cottontail",
		"cottontail-release.json",
	);
	if (
		existsSync(PATH.dashCli.BIN) &&
		metadataMatches(dashMetadataPath, RUNTIME_ARTIFACTS.dashCli, platformKey) &&
		metadataMatches(
			cottontailMetadataPath,
			RUNTIME_ARTIFACTS.cottontail,
			platformKey,
		)
	) {
		console.log(`✓ Using existing vendored Dash CLI at ${PATH.dashCli.BIN}`);
		return;
	}

	const downloaded = await downloadRuntimeRelease(
		RUNTIME_ARTIFACTS.dashCli,
		platformKey,
	);
	try {
		const metadataPath = join(downloaded.packageRoot, "dash-cli-release.json");
		const metadata = assertReleaseMetadata(
			metadataPath,
			RUNTIME_ARTIFACTS.dashCli,
			platformKey,
		);
		if (
			metadata.cottontail?.version !== RUNTIME_ARTIFACTS.cottontail.version ||
			metadata.cottontail?.revision !== RUNTIME_ARTIFACTS.cottontail.revision
		) {
			throw new Error(
				"Dash CLI was not built with the Cottontail release pinned by Electrobun",
			);
		}

		const destination = join(process.cwd(), "vendors", "dash-cli");
		rmSync(destination, { recursive: true, force: true });
		mkdirSync(destination, { recursive: true });
		cpSync(join(downloaded.packageRoot, "bin", dashCliBinary), PATH.dashCli.BIN);
		cpSync(metadataPath, join(destination, "dash-cli-release.json"));
		if (OS !== "win") await $`chmod +x ${PATH.dashCli.BIN}`;
		await signExecutableIfNeeded(PATH.dashCli.BIN);

		await installCottontailPayload(
			downloaded.packageRoot,
			RUNTIME_ARTIFACTS.cottontail,
			platformKey,
		);
	} finally {
		downloaded.cleanup();
	}
	console.log(`✓ Dash CLI ${RUNTIME_ARTIFACTS.dashCli.version} vendored`);
}

async function vendorBsdiff() {
	const BSDIFF_VERSION = "0.1.20";
	const bsdiffDir = join(process.cwd(), "vendors", "zig-bsdiff");
	const bsdiffBin = join(bsdiffDir, "bsdiff" + binExt);
	const bspatchBin = join(bsdiffDir, "bspatch" + binExt);

	// Check if binaries already exist
	if (existsSync(bsdiffBin) && existsSync(bspatchBin)) {
		return;
	}

	await pauseForGitHub();
	console.log("Downloading zig-bsdiff binaries...");

	// Map OS names to match GitHub release naming
	const bsdiffPlatformMap: Record<string, string> = {
		macos: "darwin",
		win: "win32",
		linux: "linux",
	};
	const bsdiffPlatform = bsdiffPlatformMap[OS];
	const bsdiffArch = ARCH;

	const tarballUrl = `https://github.com/blackboardsh/zig-bsdiff/releases/download/v${BSDIFF_VERSION}/zig-bsdiff-${bsdiffPlatform}-${bsdiffArch}.tar.gz`;
	const tempTarball = join("vendors", `zig-bsdiff-temp.tar.gz`);

	try {
		// Download tarball
		await $`mkdir -p vendors/zig-bsdiff`;
		await $`curl -L "${tarballUrl}" -o "${tempTarball}"`;

		// Validate download
		validateDownload(tempTarball, "zig-bsdiff");

		// Extract to vendors/zig-bsdiff
		if (OS === "win") {
			// Use tar on Windows (built-in on Windows 10+)
			await $`tar -xzf "${tempTarball}" -C vendors/zig-bsdiff`;
		} else {
			await $`tar -xzf "${tempTarball}" -C vendors/zig-bsdiff`;
		}

		// Clean up temp file
		await $`rm "${tempTarball}"`;

		// Verify binaries were extracted
		if (!existsSync(bsdiffBin) || !existsSync(bspatchBin)) {
			throw new Error(`Binaries not found after extraction: ${bsdiffDir}`);
		}

		// Make executable on Unix systems
		if (OS !== "win") {
			await $`chmod +x ${bsdiffBin} ${bspatchBin}`;
		}

		console.log("✓ zig-bsdiff binaries downloaded successfully");
	} catch (error: unknown) {
		console.error(
			"Failed to download zig-bsdiff binaries:",
			error instanceof Error ? error.message : error,
		);
		throw new Error(
			`Failed to download zig-bsdiff binaries. Please try again in a minute.`,
		);
	}
}

async function vendorZstd() {
	const ZSTD_VERSION = "0.1.3";
	const zstdDir = join(process.cwd(), "vendors", "zig-zstd");
	const zstdBin = join(zstdDir, "zig-zstd" + binExt);

	if (existsSync(zstdBin)) {
		return;
	}

	await pauseForGitHub();
	console.log("Downloading zig-zstd binaries...");

	const zstdPlatformMap: Record<string, string> = {
		macos: "darwin",
		win: "win32",
		linux: "linux",
	};
	const zstdPlatform = zstdPlatformMap[OS];
	const zstdArch = ARCH;

	const tempTarball = join("vendors", `zig-zstd-temp.tar.gz`);

	try {
		await $`mkdir -p vendors/zig-zstd`;
		const tarballUrl = `https://github.com/blackboardsh/zig-zstd/releases/download/v${ZSTD_VERSION}/zig-zstd-${zstdPlatform}-${zstdArch}.tar.gz`;
		console.log(`Downloading zig-zstd from: ${tarballUrl}`);
		await $`rm -f "${tempTarball}"`;
		const githubToken =
			process.env["GITHUB_TOKEN"] ??
			process.env["GH_TOKEN"] ??
			process.env["GITHUB_ACCESS_TOKEN"];
		if (githubToken) {
			await $`curl -fL -H "Authorization: Bearer ${githubToken}" -H "Accept: application/octet-stream" "${tarballUrl}" -o "${tempTarball}"`;
		} else {
			await $`curl -fL -H "Accept: application/octet-stream" "${tarballUrl}" -o "${tempTarball}"`;
		}
		validateDownload(tempTarball, "zig-zstd");

		await $`tar -xzf "${tempTarball}" -C vendors/zig-zstd`;

		await $`rm "${tempTarball}"`;

		if (!existsSync(zstdBin)) {
			throw new Error(`Binary not found after extraction: ${zstdDir}`);
		}

		if (OS !== "win") {
			await $`chmod +x ${zstdBin}`;
		}

		console.log("✓ zig-zstd binaries downloaded successfully");
	} catch (error: unknown) {
		console.error(
			"Failed to download zig-zstd binaries:",
			error instanceof Error ? error.message : error,
		);
		throw new Error(
			`Failed to download zig-zstd binaries. Please try again in a minute.`,
		);
	}
}

async function vendorWGPU() {
	const WGPU_VERSION = "0.2.3";
	const wgpuBaseDir = join(process.cwd(), "vendors", "wgpu");
	const wgpuDir = join(wgpuBaseDir, `${OS}-${ARCH}`);
	const wgpuVersionFile = join(wgpuBaseDir, ".wgpu-version");
	const currentVersion = existsSync(wgpuVersionFile)
		? readFileSync(wgpuVersionFile, "utf8").trim()
		: null;

	const libExt = OS === "win" ? ".dll" : OS === "macos" ? ".dylib" : ".so";
	const libCandidates =
		OS === "win"
			? [
					join(wgpuDir, "bin", "webgpu_dawn.dll"),
					join(wgpuDir, "bin", "libwebgpu_dawn.dll"),
					join(wgpuDir, "lib", "webgpu_dawn.dll"),
					join(wgpuDir, "lib", "libwebgpu_dawn.dll"),
				]
			: [
					join(wgpuDir, "lib", `libwebgpu_dawn${libExt}`),
					join(wgpuDir, "lib", `libwebgpu_dawn_shared${libExt}`),
				];

	if (libCandidates.some((p) => existsSync(p)) && currentVersion === WGPU_VERSION) {
		return;
	}

	if (libCandidates.some((p) => existsSync(p)) && !currentVersion) {
		writeFileSync(wgpuVersionFile, WGPU_VERSION);
		return;
	}

	if (currentVersion && currentVersion !== WGPU_VERSION && existsSync(wgpuDir)) {
		await $`rm -rf "${wgpuDir}"`;
	}

	await pauseForGitHub();
	console.log("Downloading electrobun-dawn binaries...");

	const platformMap: Record<string, string> = {
		macos: "darwin",
		win: "win32",
		linux: "linux",
	};
	const platformName = platformMap[OS];
	const archName = ARCH;

	const tarballUrl = `https://github.com/blackboardsh/electrobun-dawn/releases/download/v${WGPU_VERSION}/electrobun-dawn-${platformName}-${archName}.tar.gz`;
	const tempTarball = join("vendors", `electrobun-dawn-temp.tar.gz`);
	const tempExtractDir = join("vendors", `electrobun-dawn-extract-${Date.now()}`);

	try {
		await $`mkdir -p "${wgpuBaseDir}"`;
		await $`rm -f "${tempTarball}"`;

		const githubToken =
			process.env["GITHUB_TOKEN"] ??
			process.env["GH_TOKEN"] ??
			process.env["GITHUB_ACCESS_TOKEN"];
		if (githubToken) {
			await $`curl -fL -H "Authorization: Bearer ${githubToken}" -H "Accept: application/octet-stream" "${tarballUrl}" -o "${tempTarball}"`;
		} else {
			await $`curl -fL -H "Accept: application/octet-stream" "${tarballUrl}" -o "${tempTarball}"`;
		}

		validateDownload(tempTarball, "wgpu");

		await $`rm -rf "${tempExtractDir}"`;
		await $`mkdir -p "${tempExtractDir}"`;
		await $`tar -xzf "${tempTarball}" -C "${tempExtractDir}"`;

		const extracted = readdirSync(tempExtractDir);
		if (extracted.length === 1) {
			const single = join(tempExtractDir, extracted[0]!);
			if (existsSync(wgpuDir)) {
				await $`rm -rf "${wgpuDir}"`;
			}
			await $`mv "${single}" "${wgpuDir}"`;
		} else {
			if (existsSync(wgpuDir)) {
				await $`rm -rf "${wgpuDir}"`;
			}
			await $`mkdir -p "${wgpuDir}"`;
			for (const item of extracted) {
				await $`mv "${join(tempExtractDir, item)}" "${wgpuDir}/"`;
			}
		}

		await $`rm -rf "${tempExtractDir}"`;
		await $`rm -f "${tempTarball}"`;

		if (!libCandidates.some((p) => existsSync(p))) {
			throw new Error(`WGPU library not found after extraction: ${wgpuDir}`);
		}

		writeFileSync(wgpuVersionFile, WGPU_VERSION);

		// Regenerate Bun FFI bindings when WGPU version changes
		if (!existsSync(join(process.cwd(), "src", "sdks", "bun", "webGPU.ts"))) {
			await $`node scripts/gen-webgpu-ffi.mjs`;
		} else if (currentVersion !== WGPU_VERSION) {
			await $`node scripts/gen-webgpu-ffi.mjs`;
		}

		console.log("✓ electrobun-dawn binaries downloaded successfully");
	} catch (error: unknown) {
		console.error(
			"Failed to download electrobun-dawn binaries:",
			error instanceof Error ? error.message : error,
		);
		throw new Error(
			`Failed to download electrobun-dawn binaries. Please try again in a minute.`,
		);
	}
}

async function vendorAsar() {
	const ASAR_VERSION = "0.2.2";
	const asarBaseDir = join(process.cwd(), "vendors", "zig-asar");

	// Map OS names to match GitHub release naming
	const asarPlatformMap: Record<string, string> = {
		macos: "darwin",
		win: "win32",
		linux: "linux",
	};
	const asarPlatform = asarPlatformMap[OS];

	// On Windows, download both x64 and arm64 versions for development flexibility
	// (allows testing on Windows ARM machines while shipping x64 binaries)
	const archsToDownload = OS === "win" ? ["x64", "arm64"] : [ARCH];

	for (const targetArch of archsToDownload) {
		const asarDir = OS === "win" ? join(asarBaseDir, targetArch) : asarBaseDir;
		const asarCli = join(asarDir, "zig-asar" + binExt);
		const libExt = OS === "win" ? ".dll" : OS === "macos" ? ".dylib" : ".so";
		const asarLib = join(asarDir, "libasar" + libExt);

		// Check if binaries already exist for this architecture
		// Note: All platforms need both CLI and library:
		// - CLI: Used at build time to pack ASARs
		// - Library: Used by launcher at runtime to extract bun/index.js from ASAR
		//   (Native wrapper on Windows has built-in C++ reader for views:// files)
		const requiredFiles = [asarCli, asarLib];

		if (requiredFiles.every((f) => existsSync(f))) {
			continue; // Already have this architecture
		}

		await pauseForGitHub();
		console.log(
			`Downloading zig-asar binaries for ${asarPlatform}-${targetArch}...`,
		);

		const tarballUrl = `https://github.com/blackboardsh/zig-asar/releases/download/v${ASAR_VERSION}/zig-asar-${asarPlatform}-${targetArch}.tar.gz`;
		const tempTarball = join("vendors", `zig-asar-temp-${targetArch}.tar.gz`);

		try {
			// Download tarball
			await $`mkdir -p "${asarDir}"`;
			await $`curl -L "${tarballUrl}" -o "${tempTarball}"`;

			// Validate download
			validateDownload(tempTarball, "zig-asar");

			// Extract to architecture-specific directory
			await $`tar -xzf "${tempTarball}" -C "${asarDir}"`;

			// Clean up temp file
			await $`rm "${tempTarball}"`;

			// Verify binaries were extracted
			const missingFiles = requiredFiles.filter((f) => !existsSync(f));
			if (missingFiles.length > 0) {
				console.error("Missing files after extraction:", missingFiles);
				console.error("Files found in", asarDir + ":");
				if (existsSync(asarDir)) {
					const files = await $`ls -la "${asarDir}"`.quiet();
					console.error(files.stdout.toString());
				}
				throw new Error(`Required ASAR files not found after extraction`);
			}

			// Make executable on Unix systems
			if (OS !== "win") {
				await $`chmod +x ${asarCli}`;
			}

			console.log(
				`✓ zig-asar binaries for ${targetArch} downloaded successfully`,
			);
		} catch (error: unknown) {
			console.error(
				`Failed to download zig-asar binaries for ${targetArch}:`,
				error instanceof Error ? error.message : error,
			);
			throw new Error(
				`Failed to download zig-asar binaries. Please try again in a minute.`,
			);
		}
	}
}

async function vendorCEF() {
	// CEF_VERSION, CHROMIUM_VERSION, and DEFAULT_CEF_VERSION_STRING are imported from src/shared/cef-version.ts
	const expectedVersionString = DEFAULT_CEF_VERSION_STRING;

	// Keep per-platform aliases for backward compatibility in URL construction below.
	const CEF_VERSION_MAC = CEF_VERSION;
	const CHROMIUM_VERSION_MAC = CHROMIUM_VERSION;
	const CEF_VERSION_WIN = CEF_VERSION;
	const CHROMIUM_VERSION_WIN = CHROMIUM_VERSION;
	const CEF_VERSION_LINUX = CEF_VERSION;
	const CHROMIUM_VERSION_LINUX = CHROMIUM_VERSION;

	// Check if vendored CEF version matches expected version.
	// When the hardcoded version is bumped (e.g. after a git pull),
	// this detects the mismatch and forces a clean re-vendor + rebuild.
	const cefDir = join(process.cwd(), "vendors", "cef");
	const versionFile = join(cefDir, ".cef-version");

	if (existsSync(cefDir) && existsSync(versionFile)) {
		const vendoredVersion = readFileSync(versionFile, "utf-8").trim();
		if (vendoredVersion !== expectedVersionString) {
			console.log(
				`CEF version mismatch: vendored "${vendoredVersion}" vs expected "${expectedVersionString}"`,
			);
			console.log("Cleaning stale CEF artifacts and re-vendoring...");
			// Remove stale CEF vendor directory
			await $`rm -rf vendors/cef`;
			// Remove stale build artifacts compiled against old CEF
			await $`rm -f src/native/build/process_helper src/native/build/process_helper.exe`;
			await $`rm -f src/native/build/process_helper_mac.o src/native/build/process_helper_win.obj src/native/linux/build/process_helper_linux.o`;
			await $`rm -f src/native/build/libNativeWrapper.dylib src/native/build/libNativeWrapper.so src/native/build/libNativeWrapper_cef.so`;
			await $`rm -f src/native/win/build/libNativeWrapper.dll src/native/win/build/nativeWrapper.obj`;
			await $`rm -f src/native/macos/build/nativeWrapper.o src/native/linux/build/nativeWrapper.o`;
		}
	} else if (existsSync(cefDir) && !existsSync(versionFile)) {
		// CEF dir exists but no version file (legacy state) — force re-vendor
		console.log(
			"CEF vendor directory found without version stamp, cleaning...",
		);
		await $`rm -rf vendors/cef`;
		await $`rm -f src/native/build/process_helper src/native/build/process_helper.exe`;
		await $`rm -f src/native/build/process_helper_mac.o src/native/build/process_helper_win.obj src/native/linux/build/process_helper_linux.o`;
		await $`rm -f src/native/build/libNativeWrapper.dylib src/native/build/libNativeWrapper.so src/native/build/libNativeWrapper_cef.so`;
		await $`rm -f src/native/win/build/libNativeWrapper.dll src/native/win/build/nativeWrapper.obj`;
		await $`rm -f src/native/macos/build/nativeWrapper.o src/native/linux/build/nativeWrapper.o`;
	}

	if (OS === "macos") {
		if (!existsSync(join(process.cwd(), "vendors", "cef"))) {
			const cefArch = ARCH === "arm64" ? "macosarm64" : "macosx64";
			console.log(`Downloading CEF for macOS ${ARCH}...`);
			// Try a different URL format - encode all + symbols
			let cefUrl = `https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_MAC}+chromium-${CHROMIUM_VERSION_MAC}_${cefArch}_minimal.tar.bz2`;
			console.log("CEF URL:", cefUrl);

			// Test if URL is accessible first
			console.log("Testing CEF URL accessibility...");
			try {
				await $`curl -I "${cefUrl}"`;
				console.log("CEF URL is accessible");
			} catch (error) {
				console.log("CEF URL test failed, trying alternative format...");
				// Try simpler format without the complex version encoding
				const altUrl = `https://cef-builds.spotifycdn.com/cef_binary_125.0.22_${cefArch}.tar.bz2`;
				console.log("Alternative CEF URL:", altUrl);
				try {
					await $`curl -I "${altUrl}"`;
					console.log("Alternative URL works, using it");
					cefUrl = altUrl;
				} catch (altError) {
					throw new Error(
						"Neither CEF URL format worked. Manual intervention needed.",
					);
				}
			}

			// Download to temp file first, then extract
			await $`mkdir -p vendors`;
			const tempFile = "vendors/cef_temp.tar.bz2";
			await $`curl -L "${cefUrl}" -o "${tempFile}"`;

			// Validate download
			validateDownload(tempFile, "cef");

			console.log("CEF download completed, extracting...");

			// Extract CEF
			await $`mkdir -p vendors/cef`;
			try {
				await $`tar -xjf "${tempFile}" --strip-components=1 -C vendors/cef`;
				console.log("CEF extraction completed");
			} catch (error) {
				console.log("Tar extraction failed, trying alternative method...");
				// Try without strip-components first
				await $`tar -xjf "${tempFile}" -C vendors/`;

				// List what was extracted
				const vendorContents = await $`ls vendors/`.text();
				console.log("Extracted contents:", vendorContents);

				// Try to find the CEF directory and move it
				const dirName = vendorContents
					.split("\n")
					.find((line) => line.startsWith("cef_binary_"));
				if (dirName) {
					await $`mv vendors/${dirName.trim()}/* vendors/cef/`;
					await $`rmdir vendors/${dirName.trim()}`;
					console.log("Moved CEF contents to vendors/cef");
				}
			}

			// Clean up temp file
			await $`rm "${tempFile}"`;

			// List what's in the cef directory
			try {
				const cefContents = await $`ls vendors/cef/`.text();
				console.log("CEF directory contents:", cefContents);
			} catch {
				console.log("Could not list CEF directory contents");
			}

			// Verify CEF was extracted properly
			if (
				!existsSync(join(process.cwd(), "vendors", "cef", "CMakeLists.txt"))
			) {
				throw new Error(
					"CEF download/extraction failed - CMakeLists.txt not found",
				);
			}
			// Write version stamp so future builds can detect staleness
			writeFileSync(
				join(process.cwd(), "vendors", "cef", ".cef-version"),
				expectedVersionString,
			);
			console.log("CEF downloaded and extracted successfully");
		}

		// Build process_helper binary
		if (
			!existsSync(
				join(process.cwd(), "src", "native", "build", "process_helper"),
			)
		) {
			await $`mkdir -p src/native/build`;
			// build CEF wrapper library
			console.log("Building CEF wrapper library...");
			const buildArch = ARCH === "arm64" ? "arm64" : "x86_64";
			await $`cd vendors/cef && rm -rf build && mkdir -p build && cd build && "${CMAKE_BIN}" -DPROJECT_ARCH="${buildArch}" -DCMAKE_BUILD_TYPE=Release .. && make -j8 libcef_dll_wrapper`;

			// Verify the wrapper library was built
			const wrapperPath = join(
				process.cwd(),
				"vendors",
				"cef",
				"build",
				"libcef_dll_wrapper",
				"libcef_dll_wrapper.a",
			);
			if (!existsSync(wrapperPath)) {
				throw new Error(`CEF wrapper library not found at ${wrapperPath}`);
			}
			console.log("CEF wrapper library built successfully");

			// build helper
			await $`xcrun --sdk macosx clang++ -mmacosx-version-min=10.13 -std=c++20 -ObjC++ -fobjc-arc -I./vendors/cef -c src/native/macos/cef_process_helper_mac.cc -o src/native/build/process_helper_mac.o`;
			// link
			await $`xcrun --sdk macosx clang++ -mmacosx-version-min=10.13 -std=c++20 src/native/build/process_helper_mac.o -o src/native/build/process_helper -framework Cocoa -framework WebKit -framework QuartzCore -F./vendors/cef/Release -framework "Chromium Embedded Framework" -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++`;
			// fix internal path
			// Note: Can use `otool -L src/native/build/process_helper` to check the value
			await $`install_name_tool -change "@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" "@executable_path/../../../../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" src/native/build/process_helper`;
		}
	} else if (OS === "win") {
		if (!existsSync(join(process.cwd(), "vendors", "cef"))) {
			// Download Windows CEF binaries (minimal distribution)
			const tempPath = join(process.cwd(), "vendors", "cef_temp.tar.bz2");
			// Create vendors directory if needed
			await $`powershell -command "if (-not (Test-Path vendors)) { New-Item -ItemType Directory -Path vendors | Out-Null }"`;

			// Download CEF - using URL encoding for the + character
			console.log("Downloading CEF binaries...");
			// Always use x64 for Windows since we only build x64 Windows binaries
			const cefArch = "windows64";
			console.log("Downloading CEF for Windows x64...");
			await $`curl -L "https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_WIN}%2Bchromium-${CHROMIUM_VERSION_WIN}_${cefArch}_minimal.tar.bz2" -o "${tempPath}"`;

			// Validate download
			validateDownload(tempPath, "cef");

			// Extract using tar (Windows 10+ has built-in tar support)
			console.log("Extracting CEF...");
			await $`powershell -command "New-Item -ItemType Directory -Path 'vendors/cef_temp' -Force | Out-Null"`;
			await $`powershell -command "New-Item -ItemType Directory -Path 'vendors/cef' -Force | Out-Null"`;

			// Extract tar.bz2 using Windows built-in tar
			console.log("Extracting with tar (this may take a few minutes)...");
			console.log(
				"Note: Windows tar extraction of bz2 files can be slow, please be patient...",
			);

			// Windows tar doesn't support many options, just use basic extraction
			const relativeTempPath = relative("vendors/cef_temp", tempPath);
			await $`cd vendors/cef_temp && tar -xjf "${relativeTempPath}"`;

			// Check what was extracted
			const tempDir = "vendors/cef_temp";
			console.log("Checking extracted contents...");

			if (!existsSync(tempDir)) {
				throw new Error("Temp extraction directory not created");
			}

			const extractedDirs = readdirSync(tempDir);
			console.log("Extracted directories:", extractedDirs);

			if (extractedDirs.length === 0) {
				throw new Error("No files extracted");
			}

			// Move the contents from the extracted directory
			const extractedPath = join(tempDir, extractedDirs[0]);
			console.log("Moving files from:", extractedPath);

			if (existsSync(extractedPath)) {
				// Use PowerShell Copy-Item for reliable directory copying
				await $`powershell -command "Copy-Item -Path '${extractedPath}\\*' -Destination 'vendors\\cef' -Recurse -Force"`;
			} else {
				// If it's not a directory, the files might be directly in cef_temp
				await $`powershell -command "Copy-Item -Path 'vendors\\cef_temp\\*' -Destination 'vendors\\cef' -Recurse -Force"`;
			}

			// Clean up temp directory
			await $`powershell -command "Remove-Item 'vendors/cef_temp' -Recurse -Force"`;

			// Clean up temp file
			await $`powershell -command "Remove-Item '${tempPath}' -Force"`;

			// Verify extraction worked
			const cefCMakeFile = join(
				process.cwd(),
				"vendors",
				"cef",
				"CMakeLists.txt",
			);
			if (!existsSync(cefCMakeFile)) {
				throw new Error("CEF extraction failed - CMakeLists.txt not found");
			}
			// Write version stamp so future builds can detect staleness
			writeFileSync(
				join(process.cwd(), "vendors", "cef", ".cef-version"),
				expectedVersionString,
			);
			console.log("CEF extracted successfully");
		}

		// Build CEF wrapper library for Windows
		if (
			!existsSync(getWindowsCefWrapperLibPath())
		) {
			// Clean and create build directory
			await $`cd vendors/cef && powershell -command "if (Test-Path build) { Remove-Item -Recurse -Force build }"`;
			await $`cd vendors/cef && mkdir build`;
			const cmakeGenerator = getWindowsCmakeGenerator();
			const generatorArgs =
				cmakeGenerator === "Visual Studio 17 2022"
					? `-G "${cmakeGenerator}" -A x64`
					: `-G "${cmakeGenerator}"`;

			// Generate the CEF wrapper project with sandbox disabled.
			// When vcvarsall is available, prefer an MSVC toolchain generator that
			// does not require a full Visual Studio IDE instance to be discoverable.
			await runMsvcCommand(
				`cd vendors\\cef\\build && "${CMAKE_BIN}" ${generatorArgs} -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release ..`,
			);
			// Build the wrapper library only.
			await runMsvcCommand(
				`cd vendors\\cef\\build && "${CMAKE_BIN}" --build . --target libcef_dll_wrapper`,
			);
		}

		// Build process_helper binary for Windows
		const processHelperPath = join(
			process.cwd(),
			"src",
			"native",
			"build",
			"process_helper.exe",
		);
		const processHelperSourcePath = join(
			process.cwd(),
			"src",
			"native",
			"win",
			"cef_process_helper_win.cpp",
		);
		if (outputMissingOrOlder(processHelperPath, [processHelperSourcePath])) {
			await $`mkdir -p src/native/build`;

			const cefInclude = `./vendors/cef`;
			const cefLib = `./vendors/cef/Release/libcef.lib`;
			const cefWrapperLib = getWindowsCefWrapperLibPath();

			// Compile the Windows helper process
			await runMsvcCommand(
				`cl /c /EHsc /std:c++20 /DNOMINMAX /I"${cefInclude}" /D_USRDLL /D_WINDLL /Fosrc/native/build/process_helper_win.obj src/native/win/cef_process_helper_win.cpp`,
			);

			// Link to create the helper executable
			await runMsvcCommand(
				`link /OUT:src/native/build/process_helper.exe user32.lib ole32.lib shell32.lib "${cefLib}" "${cefWrapperLib}" /SUBSYSTEM:WINDOWS src/native/build/process_helper_win.obj`,
			);
		}
	} else if (OS === "linux") {
		if (!existsSync(join(process.cwd(), "vendors", "cef"))) {
			const cefArch = ARCH === "arm64" ? "linuxarm64" : "linux64";
			console.log(`Downloading CEF for Linux ${ARCH}...`);
			await $`mkdir -p vendors/cef && curl -L "https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_LINUX}%2Bchromium-${CHROMIUM_VERSION_LINUX}_${cefArch}_minimal.tar.bz2" | tar -xj --strip-components=1 -C vendors/cef`;
			// Write version stamp so future builds can detect staleness
			writeFileSync(
				join(process.cwd(), "vendors", "cef", ".cef-version"),
				expectedVersionString,
			);
		}

		// Build CEF wrapper library for Linux
		if (
			!existsSync(
				join(
					process.cwd(),
					"vendors",
					"cef",
					"build",
					"libcef_dll_wrapper",
					"libcef_dll_wrapper.a",
				),
			)
		) {
			console.log("Building CEF wrapper library for Linux...");
			await $`cd vendors/cef && rm -rf build && mkdir -p build`;

			if (ARCH === "arm64") {
				// For ARM64, we need to modify CEF's cmake files to remove -m64 flags
				console.log("Patching CEF cmake files for ARM64...");

				// Replace -m64 and -march=x86-64 with ARM64 equivalents in cef_variables.cmake
				const cefVariablesPath = join(
					process.cwd(),
					"vendors",
					"cef",
					"cmake",
					"cef_variables.cmake",
				);
				if (existsSync(cefVariablesPath)) {
					let cefVariables = readFileSync(cefVariablesPath, "utf-8");
					cefVariables = cefVariables.replace(/-m64/g, "");
					cefVariables = cefVariables.replace(
						/-march=x86-64/g,
						"-march=armv8-a",
					);
					writeFileSync(cefVariablesPath, cefVariables);
				}

				await $`cd vendors/cef/build && "${CMAKE_BIN}" -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release -DPROJECT_ARCH=arm64 ..`;
			} else {
				await $`cd vendors/cef/build && "${CMAKE_BIN}" -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release ..`;
			}

			await $`cd vendors/cef/build && make -j$(nproc) libcef_dll_wrapper`;
		}

		// Build process_helper binary for Linux
		if (
			!existsSync(
				join(process.cwd(), "src", "native", "build", "process_helper"),
			)
		) {
			console.log("Building CEF process helper for Linux...");
			await $`mkdir -p src/native/build`;

			const cefInclude = `./vendors/cef`;
			const cefLib = `./vendors/cef/Release/libcef.so`;
			const cefWrapperLib = `./vendors/cef/build/libcef_dll_wrapper/libcef_dll_wrapper.a`;

			// Compile the Linux helper process
			await $`g++ -c -std=c++20 -I"${cefInclude}" -o src/native/build/process_helper_linux.o src/native/linux/cef_process_helper_linux.cpp`;

			// Link to create the helper executable
			await $`g++ -o src/native/build/process_helper src/native/build/process_helper_linux.o "${cefWrapperLib}" "${cefLib}" -Wl,-rpath,'$ORIGIN' -lpthread -ldl`;
		}
	}
}

async function vendorNuget() {
	if (OS === "win") {
		if (existsSync(join(process.cwd(), "vendors", "nuget", "nuget.exe"))) {
			return;
		}

		// install nuget package manager
		await $`mkdir -p vendors/nuget && curl -L -o vendors/nuget/nuget.exe https://dist.nuget.org/win-x86-commandline/latest/nuget.exe`;
	}
}

async function vendorWebview2() {
	if (OS === "win") {
		if (existsSync(join(process.cwd(), "vendors", "webview2"))) {
			return;
		}

		await vendorNuget();

		// install nuget package manager
		await $`vendors/nuget/nuget.exe install Microsoft.Web.WebView2 -OutputDirectory vendors/webview2`;

		const webview2BasePath = "./vendors/webview2";
		const webview2Dir = readdirSync(webview2BasePath).find((dir: string) =>
			dir.startsWith("Microsoft.Web.WebView2"),
		);

		if (webview2Dir && webview2Dir !== "Microsoft.Web.WebView2") {
			const oldPath = join(webview2BasePath, webview2Dir);
			const newPath = join(webview2BasePath, "Microsoft.Web.WebView2");

			try {
				renameSync(oldPath, newPath);
				console.log(`Renamed ${webview2Dir} to Microsoft.Web.WebView2`);
			} catch (error) {
				console.error("Error renaming folder:", error);
			}
		}
	}
}

async function vendorLinuxDeps() {
	if (OS === "linux") {
		// We can't check the package manager of every Linux distro,
		// so lets just do Ubuntu/Debian for now since thats what CI uses.

		const requiredPackages = [
			"build-essential",
			"cmake",
			"pkg-config",
			"libgtk-3-dev",
			"libwebkit2gtk-4.1-dev",
			"libayatana-appindicator3-dev",
			"librsvg2-dev",
			"fuse",
			"libfuse2",
		];

		const distroInfo = await $`grep -E '^(ID|ID_LIKE)=' /etc/os-release`.catch(
			() => null,
		);
		if (
			!distroInfo ||
			!(
				String(distroInfo.stdout).includes("debian") ||
				String(distroInfo.stdout).includes("ubuntu")
			)
		) {
			console.log(
				"Cannot determine Linux distro or not Debian/Ubuntu based - skipping automatic dependency check",
			);
			console.log(
				`Please ensure required packages are installed: ${requiredPackages.join(", ")}`,
			);
			return;
		}

		console.log("Detected Debian/Ubuntu based Linux. Checking dependencies...");
		const missingPackages: string[] = [];
		for (const pkg of requiredPackages) {
			const result = await $`dpkg -l | grep ${pkg}`.catch(() => null);
			if (!result || String(result.stdout).trim() === "") {
				missingPackages.push(pkg);
			}
		}
		if (missingPackages.length > 0) {
			console.log("");
			console.log(
				"═══════════════════════════════════════════════════════════════",
			);
			console.log("🚨 MISSING REQUIRED LINUX DEPENDENCIES");
			console.log(
				"═══════════════════════════════════════════════════════════════",
			);
			console.log(`Missing packages: ${missingPackages.join(", ")}`);
			console.log("");
			console.log("Please install them using:");
			console.log(
				`   sudo apt update && sudo apt install -y ${missingPackages.join(" ")}`,
			);
			console.log("");

			// Check specifically for libfuse2 since it affects AppImage creation
			if (missingPackages.includes("libfuse2")) {
				console.log("⚠️  libfuse2 is required for AppImage creation");
				console.log(
					"   Without it, AppImage generation will fail with FUSE errors",
				);
				console.log("");
			}

			// In CI, just warn but continue; locally show message and continue
			if (process.env["GITHUB_ACTIONS"]) {
				console.warn("⚠️  Running in CI - continuing despite missing packages");
				console.warn(
					"   The CI workflow should have already installed these packages",
				);
			} else {
				console.warn("⚠️  Some features may not work without these packages");
				console.warn("   Continuing with build...");
			}
			console.log(
				"═══════════════════════════════════════════════════════════════",
			);
			console.log("");
		}
		console.log("All required packages are installed");
	}
}

async function buildNative() {
	if (OS === "macos") {
		// Ensure CEF wrapper library is built first
		const wrapperPath = join(
			process.cwd(),
			"vendors",
			"cef",
			"build",
			"libcef_dll_wrapper",
			"libcef_dll_wrapper.a",
		);
		if (!existsSync(wrapperPath)) {
			console.log("CEF wrapper library not found, building it now...");
			const buildArch = ARCH === "arm64" ? "arm64" : "x86_64";
			await $`cd vendors/cef && rm -rf build && mkdir -p build && cd build && "${CMAKE_BIN}" -DPROJECT_ARCH="${buildArch}" -DCMAKE_BUILD_TYPE=Release .. && make -j8 libcef_dll_wrapper`;

			if (!existsSync(wrapperPath)) {
				throw new Error(
					`Failed to build CEF wrapper library at ${wrapperPath}`,
				);
			}
		}

		const wgpuIncludeDir = join(
			process.cwd(),
			"vendors",
			"wgpu",
			`${OS}-${ARCH}`,
			"include",
		);
		const wgpuIncludeFlag = existsSync(wgpuIncludeDir)
			? `-I${wgpuIncludeDir}`
			: "";
		await $`mkdir -p src/native/macos/build && xcrun --sdk macosx clang++ -mmacosx-version-min=10.13 -c src/native/macos/nativeWrapper.mm -o src/native/macos/build/nativeWrapper.o -fobjc-arc -fno-objc-msgsend-selector-stubs -I./vendors/cef ${wgpuIncludeFlag} -std=c++20`;
		await $`mkdir -p src/native/build && xcrun --sdk macosx clang++ -mmacosx-version-min=10.13 -o src/native/build/libNativeWrapper.dylib src/native/macos/build/nativeWrapper.o ./vendors/zig-asar/libasar.dylib -framework Cocoa -framework WebKit -framework QuartzCore -framework Metal -framework MetalKit -framework UserNotifications -F./vendors/cef/Release -weak_framework 'Chromium Embedded Framework' -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++ -shared -install_name @executable_path/libNativeWrapper.dylib -Wl,-rpath,@executable_path`;
	} else if (OS === "win") {
		const webview2Include = `./vendors/webview2/Microsoft.Web.WebView2/build/native/include`;
		// Always use x64 for Windows since we only build x64 Windows binaries
		const webview2Arch = "x64";
		const webview2Lib = `./vendors/webview2/Microsoft.Web.WebView2/build/native/${webview2Arch}/WebView2LoaderStatic.lib`;
		const cefInclude = `./vendors/cef`;
		const cefLib = `./vendors/cef/Release/libcef.lib`;
		const cefWrapperLib = getWindowsCefWrapperLibPath();

		const wgpuIncludeDir = join(
			process.cwd(),
			"vendors",
			"wgpu",
			`win-${ARCH}`,
			"include",
		);
		const wgpuIncludeFlag = existsSync(wgpuIncludeDir)
			? `/I"${wgpuIncludeDir}"`
			: "";

		// Dawn native lib for zero-copy DComp bridge (D3D11On12 interop)
		const wgpuLibDir = join(
			process.cwd(),
			"vendors",
			"wgpu",
			`win-${ARCH}`,
			"lib",
		);
		const wgpuLib = existsSync(join(wgpuLibDir, "webgpu_dawn.lib"))
			? `"${join(wgpuLibDir, "webgpu_dawn.lib")}"`
			: "";

		// Compile the main wrapper with both WebView2 and CEF support (runtime detection)
		// Use /MT to statically link the C runtime (matches libcpmt.lib that CEF uses)
		await $`mkdir -p src/native/win/build`;
		await runMsvcCommand(
			`cl /c /EHsc /std:c++20 /DNOMINMAX /MT /I"${webview2Include}" /I"${cefInclude}" ${wgpuIncludeFlag} /D_USRDLL /D_WINDLL /Fosrc/native/win/build/nativeWrapper.obj src/native/win/nativeWrapper.cpp`,
		);

		// Link with both WebView2 and CEF libraries using DelayLoad for CEF (similar to macOS weak linking)
		// Note: ASAR reading is now implemented directly in C++ (no external library needed)
		// webgpu_dawn.lib: Dawn native API for D3D11On12 zero-copy bridge
		// d3d12.lib: D3D12 types used by D3D11On12 interop
		// DELAYLOAD webgpu_dawn.dll: only loaded when zero-copy bridge is used
		await runMsvcCommand(
			`link /DLL /OUT:src/native/win/build/libNativeWrapper.dll user32.lib ole32.lib shell32.lib shlwapi.lib advapi32.lib dcomp.lib d2d1.lib d3d12.lib kernel32.lib comctl32.lib ${wgpuLib} "${webview2Lib}" "${cefLib}" "${cefWrapperLib}" delayimp.lib /DELAYLOAD:libcef.dll /DELAYLOAD:webgpu_dawn.dll libcmt.lib /IMPLIB:src/native/win/build/libNativeWrapper.lib src/native/win/build/nativeWrapper.obj`,
		);
	} else if (OS === "linux") {
		// Skip package checks in CI or continue anyway if packages are missing
		if (!process.env["GITHUB_ACTIONS"]) {
			try {
				// Check if required packages are available first
				await $`pkg-config --exists webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1`;
				console.log("✓ All required packages found via pkg-config");
			} catch (error) {
				console.warn(
					"⚠️  Warning: Some packages might be missing (pkg-config check failed)",
				);
				console.warn(
					"   Continuing anyway - build may fail if packages are actually missing",
				);
			}
		} else {
			console.log("Running in CI - skipping package checks");
		}

		try {
			// Always include CEF headers for Linux builds
			const cefInclude = join(process.cwd(), "vendors", "cef");
			const wgpuIncludeDir = join(
				process.cwd(),
				"vendors",
				"wgpu",
				`${OS}-${ARCH}`,
				"include",
			);
			const cefLib = join(
				process.cwd(),
				"vendors",
				"cef",
				"Release",
				"libcef.so",
			);
			const cefWrapperLib = join(
				process.cwd(),
				"vendors",
				"cef",
				"build",
				"libcef_dll_wrapper",
				"libcef_dll_wrapper.a",
			);

			// Check if CEF libraries exist for linking
			const cefLibsExist = existsSync(cefWrapperLib) && existsSync(cefLib);

			if (cefLibsExist) {
				console.log("CEF libraries found, building with full CEF support");
			} else {
				console.log(
					"CEF libraries not found, building with CEF headers only (runtime detection)",
				);
			}

			// Get pkg-config flags, falling back to manual flags if not available
			let pkgConfigCflags = "";
			let pkgConfigLibs = "";
			let hasAppIndicator = false;

			try {
				// Try to get flags for all packages
				const cflagsResult =
					await $`pkg-config --cflags webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1`.quiet();
				pkgConfigCflags = cflagsResult.stdout.toString().trim();
				const libsResult =
					await $`pkg-config --libs webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1`.quiet();
				pkgConfigLibs = libsResult.stdout.toString().trim();
				hasAppIndicator = true;
				console.log("Successfully retrieved pkg-config flags");
			} catch {
				// If that fails, try without ayatana-appindicator3
				try {
					const cflagsResult =
						await $`pkg-config --cflags webkit2gtk-4.1 gtk+-3.0`.quiet();
					pkgConfigCflags = cflagsResult.stdout.toString().trim();
					const libsResult =
						await $`pkg-config --libs webkit2gtk-4.1 gtk+-3.0`.quiet();
					pkgConfigLibs = libsResult.stdout.toString().trim();
					console.warn("⚠️  Using pkg-config without ayatana-appindicator3-0.1");
					console.log("   cflags:", pkgConfigCflags.substring(0, 100) + "...");
				} catch (error) {
					// Fallback to manual flags if pkg-config fails entirely
					console.warn("⚠️  pkg-config failed, using fallback flags");
					console.warn("   Error:", error);
					// Detect architecture for correct glib path
					const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
					pkgConfigCflags = `-I/usr/include/gtk-3.0 -I/usr/include/webkit2gtk-4.1 -I/usr/include/glib-2.0 -I/usr/lib/${arch}-linux-gnu/glib-2.0/include -I/usr/include/pango-1.0 -I/usr/include/cairo -I/usr/include/gdk-pixbuf-2.0 -I/usr/include/atk-1.0`;
					pkgConfigLibs = "-lgtk-3 -lwebkit2gtk-4.1 -lglib-2.0 -lgobject-2.0";
				}
			}

			// Compile the main wrapper with WebKitGTK, AppIndicator, and CEF headers
			await $`mkdir -p src/native/linux/build`;
			console.log(
				"Compiling with flags:",
				pkgConfigCflags ? "pkg-config flags present" : "NO FLAGS!",
			);

			// Build the complete g++ command as an array to avoid shell interpolation issues
			const compileCmd = [
				"g++",
				"-c",
				"-std=c++20",
				"-fPIC",
				...pkgConfigCflags.split(/\s+/).filter((f) => f),
				`-I${cefInclude}`,
				...(existsSync(wgpuIncludeDir) ? [`-I${wgpuIncludeDir}`] : []),
				...(hasAppIndicator ? [] : ["-DNO_APPINDICATOR"]),
				"-o",
				"src/native/linux/build/nativeWrapper.o",
				"src/native/linux/nativeWrapper.cpp",
			];

			await $`${compileCmd}`;

			// Link with WebKitGTK, AppIndicator, and optionally CEF libraries using weak linking
			await $`mkdir -p src/native/build`;

			// Build both GTK-only and CEF versions for Linux
			const asarLib = join(process.cwd(), "vendors", "zig-asar", "libasar.so");

			console.log("Building GTK-only version (libNativeWrapper.so)");
			const linkCmd = [
				"g++",
				"-shared",
				"-o",
				"src/native/build/libNativeWrapper.so",
				"src/native/linux/build/nativeWrapper.o",
				asarLib,
				...pkgConfigLibs.split(/\s+/).filter((f) => f),
				"-ldl",
				"-lpthread",
			];
			await $`${linkCmd}`;

			if (cefLibsExist) {
				console.log("Compiling CEF loader...");
				await $`g++ -c -std=c++20 -fPIC -I${cefInclude} -o src/native/linux/build/cef_loader.o src/native/linux/cef_loader.cpp`;

				console.log(
					"Building CEF version (libNativeWrapper_cef.so) with weak linking",
				);
				const linkCefCmd = [
					"g++",
					"-shared",
					"-o",
					"src/native/build/libNativeWrapper_cef.so",
					"src/native/linux/build/nativeWrapper.o",
					"src/native/linux/build/cef_loader.o",
					asarLib,
					...pkgConfigLibs.split(/\s+/).filter((f) => f),
					"-Wl,--whole-archive",
					cefWrapperLib,
					"-Wl,--no-whole-archive",
					"-ldl",
					"-lpthread",
					"-Wl,-rpath,$ORIGIN:$ORIGIN/cef",
				];
				await $`${linkCefCmd}`;
				console.log(
					"Built both GTK-only and CEF versions for flexible deployment",
				);
			} else {
				console.log("CEF libraries not found - only GTK version built");
			}

			console.log("Native wrapper built successfully");
		} catch (error: unknown) {
			console.log(
				"Build failed, error details:",
				error instanceof Error ? error.message : error,
			);
			throw error;
		}
	}
}

async function buildLauncher() {
	console.log(`Building launcher for ${OS} ${ARCH}...`);

	let zigArgs: string[] = [];

	if (OS === "win") {
		// Windows always x64 for now
		zigArgs = ["-Dtarget=x86_64-windows", "-Dcpu=baseline"];
	} else if (OS === "linux") {
		if (ARCH === "arm64") {
			zigArgs = ["-Dtarget=aarch64-linux-gnu"];
		} else {
			zigArgs = ["-Dtarget=x86_64-linux-gnu"];
		}
	} else if (OS === "macos") {
		if (ARCH === "arm64") {
			zigArgs = ["-Dtarget=aarch64-macos"];
		} else {
			zigArgs = ["-Dtarget=x86_64-macos"];
		}
	}

	if (CHANNEL === "debug") {
		await $`cd src/launcher && ../../vendors/zig/zig build ${zigArgs}`;
	} else if (CHANNEL === "release") {
		await $`cd src/launcher && ../../vendors/zig/zig build -Doptimize=ReleaseSmall ${zigArgs}`;
	}
}

async function buildCore() {
	console.log(`Building ElectrobunCore for ${OS} ${ARCH}...`);

	let zigArgs: string[] = [];

	if (OS === "win") {
		zigArgs = ["-Dtarget=x86_64-windows", "-Dcpu=baseline"];
	} else if (OS === "linux") {
		if (ARCH === "arm64") {
			zigArgs = ["-Dtarget=aarch64-linux-gnu"];
		} else {
			zigArgs = ["-Dtarget=x86_64-linux-gnu"];
		}
	} else if (OS === "macos") {
		if (ARCH === "arm64") {
			zigArgs = ["-Dtarget=aarch64-macos"];
		} else {
			zigArgs = ["-Dtarget=x86_64-macos"];
		}
	}

	if (CHANNEL === "debug") {
		await $`cd src/core && ../../vendors/zig/zig build ${zigArgs}`;
	} else if (CHANNEL === "release") {
		await $`cd src/core && ../../vendors/zig/zig build -Doptimize=ReleaseSmall ${zigArgs}`;
	}
}

async function buildMainJs() {
	const result = await Bun.build({
		entrypoints: [join("src", "launcher", "main.ts")],
		outdir: join("dist"),
		external: [],
		// minify: true, // todo (yoav): add minify in canary and prod builds
		target: "bun",
	});

	// Verify main.js was created
	const mainJsPath = join("dist", "main.js");
	if (!existsSync(mainJsPath)) {
		throw new Error(
			`main.js was not created at ${mainJsPath}. Build result: ${JSON.stringify(result)}`,
		);
	}
	console.log(`main.js built successfully at ${mainJsPath}`);

	return result;
}

async function buildSelfExtractor() {
	const zigArgs =
		OS === "win"
			? ["-Dtarget=x86_64-windows", "-Dcpu=baseline"]
			: ARCH === "x64"
				? ["-Dcpu=baseline"]
				: [];

	if (CHANNEL === "debug") {
		await $`cd src/extractor && ../../vendors/zig/zig build ${zigArgs}`;
	} else if (CHANNEL === "release") {
		await $`cd src/extractor && ../../vendors/zig/zig build -Doptimize=ReleaseSmall ${zigArgs}`;
	}
}

async function buildPreload() {
	// The preload scripts (drag regions, internal RPC, encryption, webview tags) are written
	// in TypeScript for maintainability. We pre-compile them here because:
	// 1. At runtime, the app runs from an ASAR bundle where source .ts files don't exist
	// 2. Only the bundled JS is shipped, so Bun.build() can't compile at runtime
	// The compiled outputs are imported by native.ts and injected into webviews.
	//
	// Two variants are compiled:
	// - preloadScript: Full preload for trusted webviews (RPC, encryption, webview tags)
	// - preloadScriptSandboxed: Minimal preload for sandboxed/untrusted webviews (events only)
	const preloadDir = join(process.cwd(), "src", "preload");
	const outputDir = join(preloadDir, ".generated");
	const outputPath = join(outputDir, "compiled.ts");

	// Ensure output directory exists
	mkdirSync(outputDir, { recursive: true });

	// Build full preload (trusted webviews)
	const fullPreloadEntry = join(preloadDir, "index.ts");
	const fullResult = await Bun.build({
		entrypoints: [fullPreloadEntry],
		target: "browser",
		format: "esm",
		minify: false,
	});

	if (!fullResult.success) {
		console.error("Full preload build failed:", fullResult.logs);
		throw new Error("Failed to build full preload script");
	}

	// Build sandboxed preload (untrusted webviews)
	const sandboxedPreloadEntry = join(preloadDir, "index-sandboxed.ts");
	const sandboxedResult = await Bun.build({
		entrypoints: [sandboxedPreloadEntry],
		target: "browser",
		format: "esm",
		minify: false,
	});

	if (!sandboxedResult.success) {
		console.error("Sandboxed preload build failed:", sandboxedResult.logs);
		throw new Error("Failed to build sandboxed preload script");
	}

	// Wrap in IIFE to prevent top-level variables from leaking into webview global scope
	// (Bun removed iife format support in 1.3.10, so we build as esm and wrap manually)
	const fullPreloadJs = `(function(){${await fullResult.outputs[0].text()}})();`;
	const sandboxedPreloadJs = `(function(){${await sandboxedResult.outputs[0].text()}})();`;
	const distDir = join(process.cwd(), "dist");

	const outputContent = `// Auto-generated file. Do not edit directly.
// Run "dash build.ts" or "dash run build:dev" from the package folder to regenerate.

// Full preload for trusted webviews (RPC, encryption, drag regions, webview tags)
export const preloadScript = ${JSON.stringify(fullPreloadJs)};

// Minimal preload for sandboxed/untrusted webviews (lifecycle events only, no RPC)
export const preloadScriptSandboxed = ${JSON.stringify(sandboxedPreloadJs)};
`;

	writeFileSync(outputPath, outputContent);
	mkdirSync(distDir, { recursive: true });
	writeFileSync(join(distDir, "preload-full.js"), fullPreloadJs);
	writeFileSync(join(distDir, "preload-sandboxed.js"), sandboxedPreloadJs);
	console.log("Preload scripts compiled successfully (full + sandboxed)");
}
