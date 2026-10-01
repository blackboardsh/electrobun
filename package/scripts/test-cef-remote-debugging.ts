import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertWindowsBinaryArchitecture } from "./windows-binary-architecture.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const source = join(packageRoot, "src", "native", "shared", "chromium_flags.test.cpp");
const include = join(packageRoot, "src", "native", "shared", "test_stubs");
const temporaryRoot = resolve(tmpdir());
const outputDir = mkdtempSync(join(temporaryRoot, "electrobun-cef-policy-"));
const output = join(
	outputDir,
	process.platform === "win32"
		? "cef-remote-debugging-test.exe"
		: "cef-remote-debugging-test",
);

const zig = join(
	packageRoot,
	"vendors",
	"zig",
	process.platform === "win32" ? "zig.exe" : "zig",
);

let compileCommand: string;
let compileArgs: string[];
if (process.platform === "win32") {
	// Match the native wrapper's MSVC target, including on ARM64. An emulated
	// x64 Zig host otherwise builds an x64 test and its own C++ standard library.
	compileCommand = "cl.exe";
	compileArgs = [
		"/nologo",
		"/EHsc",
		"/std:c++20",
		"/utf-8",
		"/MT",
		"/UNDEBUG",
		`/I${include}`,
		source,
		`/Fo${join(outputDir, "cef-remote-debugging-test.obj")}`,
		`/Fe:${output}`,
	];
} else if (existsSync(zig)) {
	compileCommand = zig;
	compileArgs = ["c++", "-std=c++20", `-I${include}`, source, "-o", output];
} else {
	compileCommand = process.env.CXX || "c++";
	compileArgs = ["-std=c++20", `-I${include}`, source, "-o", output];
}

try {
	const compile = spawnSync(compileCommand, compileArgs, {
		cwd: packageRoot,
		stdio: "inherit",
		windowsHide: true,
		timeout: process.platform === "win32" ? 180_000 : 600_000,
	});
	if (compile.error?.code === "ENOENT" && process.platform === "win32") {
		throw new Error(
			`Run this test in an MSVC developer environment targeting ${process.arch}.`,
			{ cause: compile.error },
		);
	}
	if (compile.error) throw compile.error;
	if (compile.status !== 0) {
		throw new Error(
			`CEF remote debugging test compilation exited with ${compile.status ?? 1}`,
		);
	}

	if (process.platform === "win32") {
		assertWindowsBinaryArchitecture(output, process.arch);
	}
	const test = spawnSync(output, [], {
		cwd: packageRoot,
		stdio: "inherit",
		windowsHide: true,
		timeout: 60_000,
	});
	if (test.error) throw test.error;
	if (test.status !== 0) {
		throw new Error(
			`CEF remote debugging policy test exited with ${test.status ?? 1}`,
		);
	}
} finally {
	// Only remove the directory created by this invocation. Windows can retain
	// an image mapping briefly after process exit, including EACCES under emulation.
	if (dirname(outputDir) !== temporaryRoot) {
		throw new Error("Unexpected test cleanup directory");
	}
	const waiter = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(outputDir, { recursive: true, force: true });
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (
				process.platform !== "win32" ||
				!["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"].includes(code ?? "") ||
				attempt === 19
			) throw error;
			Atomics.wait(waiter, 0, 0, 50 * (attempt + 1));
		}
	}
}
