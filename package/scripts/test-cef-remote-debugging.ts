import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const source = join(packageRoot, "src", "native", "shared", "chromium_flags.test.cpp");
const include = join(packageRoot, "src", "native", "shared", "test_stubs");
const outputDir = join(packageRoot, "src", "native", "build");
const output = join(
	outputDir,
	process.platform === "win32"
		? "cef-remote-debugging-test.exe"
		: "cef-remote-debugging-test",
);
mkdirSync(outputDir, { recursive: true });

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
	compileArgs = ["c++", "-std=c++20", `-I${include}`, source, "-o", output];
} else if (process.platform === "win32") {
	compileCommand = "cl";
	compileArgs = [
		"/nologo",
		"/EHsc",
		"/std:c++20",
		`/I${include}`,
		source,
		`/Fe:${output}`,
	];
} else {
	compileCommand = process.env.CXX || "c++";
	compileArgs = ["-std=c++20", `-I${include}`, source, "-o", output];
}

try {
	const compile = spawnSync(compileCommand, compileArgs, {
		cwd: packageRoot,
		stdio: "inherit",
	});
	if (compile.error) throw compile.error;
	if (compile.status !== 0) {
		throw new Error(
			`CEF remote debugging test compilation exited with ${compile.status ?? 1}`,
		);
	}

	const test = spawnSync(output, [], { cwd: packageRoot, stdio: "inherit" });
	if (test.error) throw test.error;
	if (test.status !== 0) {
		throw new Error(
			`CEF remote debugging policy test exited with ${test.status ?? 1}`,
		);
	}
} finally {
	rmSync(output, { force: true });
}
