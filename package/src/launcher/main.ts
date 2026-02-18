import { join, dirname, resolve } from "path";
import { dlopen, suffix, ptr, toArrayBuffer } from "bun:ffi";
import { existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";

// Since main.js now runs from Resources, we need to find libraries in the MacOS directory
const pathToMacOS = dirname(process.argv0); // bun is still in MacOS/bin directory
const libPath = join(pathToMacOS, `libNativeWrapper.${suffix}`);
const absoluteLibPath = resolve(libPath);

function printLinuxMissingDeps(message: string) {
	if (process.platform !== "linux") {
		return false;
	}

	const missing: string[] = [];

	if (message.includes("libwebkit2gtk-4.1")) {
		missing.push("WebKitGTK 4.1");
	}
	if (message.includes("libgtk-3")) {
		missing.push("GTK 3");
	}
	if (message.includes("libayatana-appindicator")) {
		missing.push("Ayatana AppIndicator");
	}

	if (missing.length === 0) {
		return false;
	}

	console.error("[LAUNCHER] Missing Linux runtime dependencies:");
	console.error(`[LAUNCHER] ${missing.join(", ")}`);
	console.error("[LAUNCHER] Install with:");
	console.error("[LAUNCHER] Arch: sudo pacman -S webkit2gtk-4.1 gtk3 libayatana-appindicator");
	console.error(
		"[LAUNCHER] Ubuntu/Debian: sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1",
	);
	return true;
}

// Wrap main logic in a function to avoid top-level return
function main() {
	// Read version.json early to get identifier, name, and channel for CEF initialization
	let channel = "";
	let identifier = "";
	let name = "";
	try {
		const pathToLauncherBin = process.argv0;
		const pathToBinDir = dirname(pathToLauncherBin);
		const versionJsonPath = join(
			pathToBinDir,
			"..",
			"Resources",
			"version.json",
		);

		if (existsSync(versionJsonPath)) {
			const versionInfo = require(versionJsonPath);
			if (versionInfo.identifier) {
				identifier = versionInfo.identifier;
			}
			if (versionInfo.name) {
				name = versionInfo.name;
			}
			if (versionInfo.channel) {
				channel = versionInfo.channel;
			}
			console.log(
				`[LAUNCHER] Loaded identifier: ${identifier}, name: ${name}, channel: ${channel}`,
			);
		}
	} catch (error) {
		console.error(`[LAUNCHER] Warning: Could not read version.json:`, error);
		// Continue anyway - this is not critical for dev builds
	}

	// Check for CEF libraries and warn if LD_PRELOAD not set (Linux only)
	if (process.platform === "linux") {
		const cefLibs = [
			join(pathToMacOS, "libcef.so"),
			join(pathToMacOS, "libvk_swiftshader.so"),
		];
		const existingCefLibs = cefLibs.filter((lib) => existsSync(lib));

		if (existingCefLibs.length > 0 && !process.env["LD_PRELOAD"]) {
			console.error(
				`[LAUNCHER] ERROR: CEF libraries found but LD_PRELOAD not set!`,
			);
			console.error(
				`[LAUNCHER] Please run through the wrapper script: ./run.sh`,
			);
			console.error(
				`[LAUNCHER] Or set: LD_PRELOAD="${existingCefLibs.join(":")}" before starting.`,
			);

			// Try to re-exec ourselves with LD_PRELOAD set
			const { spawn } = require("child_process");
			const env = { ...process.env, LD_PRELOAD: existingCefLibs.join(":") };
			const child = spawn(process.argv[0], process.argv.slice(1), {
				env,
				stdio: "inherit",
			});
			child.on("exit", (code: number | null) => process.exit(code ?? 1));
			return; // Don't continue in this process
		}
	}

	let lib;
	try {
		// Set LD_LIBRARY_PATH if not already set
		if (!process.env["LD_LIBRARY_PATH"]?.includes(".")) {
			process.env["LD_LIBRARY_PATH"] =
				`.${process.env["LD_LIBRARY_PATH"] ? ":" + process.env["LD_LIBRARY_PATH"] : ""}`;
		}

		lib = dlopen(libPath, {
			startEventLoop: {
				args: ["cstring", "cstring", "cstring"],
				returns: "void",
			},
			forceExit: {
				args: ["i32"],
				returns: "void",
			},
		});
	} catch (error) {
		console.error(
			`[LAUNCHER] Failed to load library: ${(error as Error).message}`,
		);
		printLinuxMissingDeps((error as Error).message);

		// Try with absolute path as fallback
		try {
			lib = dlopen(absoluteLibPath, {
				startEventLoop: {
					args: ["cstring", "cstring", "cstring"],
					returns: "void",
				},
				forceExit: {
					args: ["i32"],
					returns: "void",
				},
			});
		} catch (absError) {
			printLinuxMissingDeps((absError as Error).message);
			console.error(
				`[LAUNCHER] Library loading failed. Try running: ldd ${libPath}`,
			);
			throw error;
		}
	}

	// todo (yoav): as the debug launcher, get the relative path a different way, so dev builds can be shared and executed
	// from different locations
	const pathToLauncherBin = process.argv0;
	const pathToBinDir = dirname(pathToLauncherBin);

	const resourcesDir = join(pathToBinDir, "..", "Resources");
	const asarPath = join(resourcesDir, "app.asar");
	const appFolderPath = join(resourcesDir, "app");

	let appEntrypointPath: string;

	// Check if ASAR archive exists
	if (existsSync(asarPath)) {
		console.log(`[LAUNCHER] Loading app code from ASAR: ${asarPath}`);

		// Load ASAR functions via FFI
		// On Windows, use libNativeWrapper.dll which has built-in C++ ASAR reader
		// On macOS/Linux, use standalone libasar library
		let asarLibPath: string;
		let asarLib: any;

		if (process.platform === "win32") {
			// Windows: Use native wrapper's built-in ASAR reader (no external DLL needed)
			asarLibPath = libPath;
			console.log(
				`[LAUNCHER] Using native wrapper's ASAR reader: ${asarLibPath}`,
			);
		} else {
			// macOS/Linux: Use standalone libasar library
			asarLibPath = join(pathToMacOS, `libasar.${suffix}`);
		}

		try {
			asarLib = dlopen(asarLibPath, {
				asar_open: { args: ["cstring"], returns: "ptr" },
				asar_read_file: { args: ["ptr", "cstring", "ptr"], returns: "ptr" },
				asar_free_buffer: { args: ["ptr", "u64"], returns: "void" },
				asar_close: { args: ["ptr"], returns: "void" },
			});
		} catch (error) {
			console.error(
				`[LAUNCHER] Failed to load ASAR library: ${(error as Error).message}`,
			);
			throw error;
		}

		// Open ASAR archive
		const asarArchive = asarLib.symbols.asar_open(
			ptr(new Uint8Array(Buffer.from(asarPath + "\0", "utf8"))),
		);

		if (!asarArchive || asarArchive === 0n) {
			console.error(`[LAUNCHER] Failed to open ASAR archive at: ${asarPath}`);
			throw new Error("Failed to open ASAR archive");
		}

		// Read bun/index.js from ASAR
		const filePath = "bun/index.js";
		const sizeBuffer = new BigUint64Array(1);
		const fileDataPtr = asarLib.symbols.asar_read_file(
			asarArchive,
			ptr(new Uint8Array(Buffer.from(filePath + "\0", "utf8"))),
			ptr(sizeBuffer),
		);

		if (!fileDataPtr || fileDataPtr === 0n) {
			console.error(`[LAUNCHER] Failed to read ${filePath} from ASAR`);
			asarLib.symbols.asar_close(asarArchive);
			throw new Error(`Failed to read ${filePath} from ASAR`);
		}

		const fileSize = Number(sizeBuffer[0]);
		console.log(`[LAUNCHER] Read ${fileSize} bytes from ASAR for ${filePath}`);

		// Copy data from the FFI pointer to a Buffer using toArrayBuffer
		const arrayBuffer = toArrayBuffer(fileDataPtr, 0, fileSize);
		const fileData = Buffer.from(arrayBuffer);

		// Write to system temp directory with randomized filename for security
		const systemTmpDir = tmpdir();
		const randomFileName = `electrobun-${Date.now()}-${Math.random().toString(36).substring(7)}.js`;
		appEntrypointPath = join(systemTmpDir, randomFileName);

		// Prepend code to delete the temp file after a short delay
		// This runs in the Worker thread, not the main thread (which gets blocked by startEventLoop)
		const wrappedFileData = `
// Auto-delete temp file after Worker loads it
const __tempFilePath = "${appEntrypointPath}";
setTimeout(() => {
    try {
        require("fs").unlinkSync(__tempFilePath);
        console.log("[LAUNCHER] Deleted temp file:", __tempFilePath);
    } catch (error) {
        console.warn("[LAUNCHER] Failed to delete temp file:", error.message);
    }
}, 100);

${fileData.toString("utf8")}
`;

		writeFileSync(appEntrypointPath, wrappedFileData);
		console.log(`[LAUNCHER] Wrote app entrypoint to: ${appEntrypointPath}`);

		// Free the buffer
		asarLib.symbols.asar_free_buffer(fileDataPtr, BigInt(fileSize));

		// Close the archive
		asarLib.symbols.asar_close(asarArchive);
	} else {
		// Fallback to flat file system (for non-ASAR builds)
		console.log(`[LAUNCHER] Loading app code from flat files`);
		appEntrypointPath = join(appFolderPath, "bun", "index.js");
	}

	// Register signal handlers on the main thread to prevent default termination.
	// The worker thread's SIGINT handler will call quit() for graceful shutdown.
	// Without these, SIGINT kills the process before the worker can run beforeQuit.
	process.on("SIGINT", () => {});
	process.on("SIGTERM", () => {});

	new Worker(appEntrypointPath, {
		// consider adding a preload with error handling
		// preload: [''];
	});

	// Pass identifier, name, and channel as C strings using Buffer encoding
	// Bun FFI requires explicit encoding for cstring parameters
	lib.symbols.startEventLoop(
		ptr(new Uint8Array(Buffer.from(identifier + "\0", "utf8"))),
		ptr(new Uint8Array(Buffer.from(name + "\0", "utf8"))),
		ptr(new Uint8Array(Buffer.from(channel + "\0", "utf8"))),
	);

	// Safety net: if startEventLoop returns (event loop stopped),
	// ensure the process exits even if the worker is still running.
	// Must use _exit() (via forceExit) instead of process.exit() because
	// CefShutdown() may leave threads still tearing down. Regular exit()
	// runs atexit handlers that try to pthread_join those threads, causing
	// a crash (SIGTRAP in CEF's CFThreadLoop TSD cleanup).
	lib.symbols.forceExit(0);
}

// Call the main function
main();
