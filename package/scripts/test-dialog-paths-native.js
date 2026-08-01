import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const zig =
	process.env["ZIG_BINARY"] ??
	join(packageRoot, "vendors", "zig", `zig${executableSuffix}`);
const source = join(
	packageRoot,
	"src",
	"native",
	"shared",
	"dialog_paths_test.cpp",
);

if (!existsSync(zig)) {
	throw new Error(`Vendored Zig was not found at ${zig}`);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "electrobun-dialog-paths-"));
const binary = join(temporaryDirectory, `dialog-paths-test${executableSuffix}`);

try {
	const compile = spawnSync(
		zig,
		["c++", "-std=c++17", source, "-o", binary],
		{ stdio: "inherit" },
	);
	if (compile.error) throw compile.error;
	if (compile.status !== 0) process.exit(compile.status ?? 1);

	const test = spawnSync(binary, [], { stdio: "inherit" });
	if (test.error) throw test.error;
	if (test.status !== 0) process.exit(test.status ?? 1);
} finally {
	rmSync(temporaryDirectory, { recursive: true, force: true });
}
