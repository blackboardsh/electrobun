import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const source = join(
	packageRoot,
	"src",
	"native",
	"shared",
	"webview2_permissions.test.cpp",
);
const outputDir = join(packageRoot, "src", "native", "build");
const output = join(
	outputDir,
	process.platform === "win32"
		? "webview2-permissions-test.exe"
		: "webview2-permissions-test",
);
mkdirSync(outputDir, { recursive: true });
const cleanupWaiter = new Int32Array(new SharedArrayBuffer(4));

const zig = join(
	packageRoot,
	"vendors",
	"zig",
	process.platform === "win32" ? "zig.exe" : "zig",
);

let compileCommand: string;
let compileArgs: string[];
if (existsSync(zig)) {
	compileCommand = zig;
	compileArgs = ["c++", "-std=c++20", source, "-o", output];
} else if (process.platform === "win32") {
	compileCommand = "cl";
	compileArgs = ["/nologo", "/EHsc", "/std:c++20", source, `/Fe:${output}`];
} else {
	compileCommand = process.env.CXX || "c++";
	compileArgs = ["-std=c++20", source, "-o", output];
}

try {
	const compile = spawnSync(compileCommand, compileArgs, {
		cwd: packageRoot,
		stdio: "inherit",
	});
	if (compile.error) throw compile.error;
	if (compile.status !== 0) {
		throw new Error(
			`WebView2 permission parser test compilation exited with ${compile.status ?? 1}`,
		);
	}

	const test = spawnSync(output, [], { cwd: packageRoot, stdio: "inherit" });
	if (test.error) throw test.error;
	if (test.status !== 0) {
		throw new Error(
			`WebView2 permission parser test exited with ${test.status ?? 1}`,
		);
	}
} finally {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			rmSync(output, { force: true });
			break;
		} catch (error) {
			if (attempt === 19) throw error;
			// Windows scanners can briefly retain a just-executed binary.
			Atomics.wait(cleanupWaiter, 0, 0, 50 * (attempt + 1));
		}
	}
}
