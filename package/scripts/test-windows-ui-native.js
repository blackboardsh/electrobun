import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { assertWindowsBinaryArchitecture } from "./windows-binary-architecture.mjs";

if (process.platform !== "win32") {
	console.log("Skipping Windows native UI test on non-Windows host");
	process.exit(0);
}

const packageRoot = resolve(import.meta.dirname, "..");
const requireNativeWrapper = process.argv.includes("--require-native-wrapper");
const source = join(
	packageRoot,
	"src",
	"native",
	"shared",
	"windows_ui_test.cpp",
);

const temporaryDirectory = mkdtempSync(join(tmpdir(), "electrobun-windows-ui-"));
const binary = join(temporaryDirectory, "windows-ui-test.exe");
const cleanupWaiter = new Int32Array(new SharedArrayBuffer(4));

function removeTemporaryDirectory(directory) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			rmSync(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = error?.code;
			if (!["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"].includes(code)) {
				throw error;
			}
			if (attempt === 19) throw error;
			// Windows scanners can briefly retain a just-executed binary.
			Atomics.wait(cleanupWaiter, 0, 0, 50 * (attempt + 1));
		}
	}
}

function resolveNativeWrapper() {
	const explicitPath = process.env["ELECTROBUN_NATIVE_WRAPPER_DLL"];
	if (explicitPath) {
		const resolved = resolve(packageRoot, explicitPath);
		if (!existsSync(resolved)) {
			throw new Error(
				`ELECTROBUN_NATIVE_WRAPPER_DLL does not exist: ${resolved}`,
			);
		}
		return resolved;
	}

	const distWrapper = join(packageRoot, "dist", "libNativeWrapper.dll");
	const buildWrapper = join(
		packageRoot,
		"src",
		"native",
		"win",
		"build",
		"libNativeWrapper.dll",
	);
	const webView2Loader = join(packageRoot, "dist", "WebView2Loader.dll");
	if (!existsSync(webView2Loader)) return undefined;
	const nativeInputs = [
		join(packageRoot, "src", "native", "win", "nativeWrapper.cpp"),
		...[
			"windows_dialog_options.h",
			"windows_dpi.h",
			"windows_resource_paths.h",
			"windows_utf.h",
		].map((name) => join(packageRoot, "src", "native", "shared", name)),
	];
	const sourceModified = Math.max(
		...nativeInputs.map((input) => statSync(input).mtimeMs),
	);
	for (const candidate of [distWrapper, buildWrapper]) {
		if (
			existsSync(candidate) &&
			statSync(candidate).mtimeMs >= sourceModified
		) {
			return candidate;
		}
	}
	return undefined;
}

function createUnicodeAsar(directory) {
	const zigAsar = join(
		packageRoot,
		"vendors",
		"zig-asar",
		process.arch,
		"zig-asar.exe",
	);
	if (!existsSync(zigAsar)) {
		throw new Error(`Vendored zig-asar was not found at ${zigAsar}`);
	}
	assertWindowsBinaryArchitecture(zigAsar, process.arch);
	const asarDirectory = join(
		directory,
		"\u8d44\u6e90-\u0434\u0430\u043d\u043d\u044b\u0435",
	);
	const sourceDirectory = join(asarDirectory, "source");
	const viewsDirectory = join(sourceDirectory, "views");
	mkdirSync(viewsDirectory, { recursive: true });
	writeFileSync(
		join(viewsDirectory, "index.html"),
		"ASAR Unicode resource: caf\u00e9 / \u6d4b\u8bd5",
		"utf8",
	);
	const asarPath = join(asarDirectory, "\u5e94\u7528.asar");
	const pack = spawnSync(zigAsar, ["pack", sourceDirectory, asarPath], {
		cwd: packageRoot,
		stdio: "inherit",
	});
	if (pack.error) throw pack.error;
	if (pack.status !== 0) {
		throw new Error(`zig-asar fixture creation exited with ${pack.status ?? 1}`);
	}
	return asarPath;
}

try {
	const compile = spawnSync(
		"cl.exe",
		[
			"/nologo",
			"/std:c++20",
			"/EHsc",
			"/utf-8",
			"/DNOMINMAX",
			"/DUNICODE",
			"/D_UNICODE",
			"/UNDEBUG",
			source,
			`/Fo${join(temporaryDirectory, "windows-ui-test.obj")}`,
			`/Fe${binary}`,
			"user32.lib",
			"comctl32.lib",
		],
		{ cwd: packageRoot, stdio: "inherit", windowsHide: true, timeout: 180_000 },
	);
	if (compile.error?.code === "ENOENT") {
		throw new Error(`Run this test in an MSVC developer environment targeting ${process.arch}.`, { cause: compile.error });
	}
	if (compile.error) throw compile.error;
	if (compile.status !== 0) {
		throw new Error(
			`Windows native UI test compilation exited with ${compile.status ?? 1}`,
		);
	}
	assertWindowsBinaryArchitecture(binary, process.arch);

	const nativeWrapper = resolveNativeWrapper();
	if (nativeWrapper) assertWindowsBinaryArchitecture(nativeWrapper, process.arch);
	const testArguments = nativeWrapper ? [nativeWrapper] : [];
	if (!nativeWrapper) {
		if (requireNativeWrapper) {
			throw new Error(
				"A current built native wrapper is required for integration coverage",
			);
		}
		console.log(
			"A current built native wrapper and WebView2 loader are unavailable; running helper coverage only",
		);
	}

	const pathKey =
		Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
		"PATH";
	const dependencyDirectories = [
		...(nativeWrapper ? [dirname(nativeWrapper)] : []),
		join(packageRoot, "dist"),
	];
	const environment = {
		...process.env,
		[pathKey]: [
			...dependencyDirectories,
			process.env[pathKey] ?? "",
		].join(delimiter),
	};
	if (nativeWrapper) {
		environment["ELECTROBUN_TEST_ASAR_PATH"] =
			createUnicodeAsar(temporaryDirectory);
	}
	const test = spawnSync(binary, testArguments, {
		cwd: nativeWrapper ? dirname(nativeWrapper) : packageRoot,
		env: environment,
		stdio: "inherit",
		timeout: 20_000,
		killSignal: "SIGKILL",
	});
	if (test.error) throw test.error;
	if (test.status !== 0) {
		throw new Error(`Windows native UI test exited with ${test.status ?? 1}`);
	}
} finally {
	removeTemporaryDirectory(temporaryDirectory);
}
