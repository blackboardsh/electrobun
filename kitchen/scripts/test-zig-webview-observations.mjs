import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZIG_VERSION } from "../../package/src/shared/build-dependencies.ts";
import { assertWindowsBinaryArchitecture } from "../../package/scripts/windows-binary-architecture.mjs";
import { zigCompilerHostArchitecture } from "../../package/scripts/zig-compiler-host.mjs";

const kitchen = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zig = process.env.ZIG_BINARY || join(kitchen, "..", "package", "vendors", "zig", process.platform === "win32" ? "zig.exe" : "zig");
const version = spawnSync(zig, ["version"], { encoding: "utf8", windowsHide: true });
assert.equal(version.status, 0, `Could not identify Zig compiler: ${version.error?.message || version.stderr}`);
assert.equal(version.stdout.trim(), ZIG_VERSION, "Use the pinned release compiler");
const hostArch = zigCompilerHostArchitecture();
if (process.platform === "win32") assertWindowsBinaryArchitecture(zig, hostArch);
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "electrobun-zig-observations-"));
const executable = join(scratch, process.platform === "win32" ? "observations.exe" : "observations");

function run(command, args) {
	const result = spawnSync(command, args, { cwd: scratch, stdio: "inherit", windowsHide: true });
	if (result.error || result.status !== 0) throw new Error(`Zig callback isolation tests failed (${result.error?.message || result.status}); retained files: ${scratch}`);
}

console.log(`[zig-observations] Compiler: Zig ${ZIG_VERSION} ${hostArch}`);
console.log(`[zig-observations] Test executable: ${executable}`);
run(zig, ["test", join(kitchen, "src", "zig", "webview_observations.zig"), "-O", "ReleaseSafe", "--cache-dir", join(scratch, "cache"), "--test-no-exec", `-femit-bin=${executable}`]);
if (process.platform === "win32") assertWindowsBinaryArchitecture(executable, hostArch);
run(executable, []);
