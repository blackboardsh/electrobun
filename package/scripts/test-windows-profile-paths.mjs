import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("Windows profile path native test: use test-windows-profile-paths.sh on POSIX");
  process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zig = process.env.ZIG_BINARY || join(packageRoot, "vendors", "zig", "zig.exe");
const directory = mkdtempSync(join(tmpdir(), "electrobun-profile-paths-"));
const executable = join(directory, "windows-profile-paths.exe");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit", windowsHide: true, timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows profile path test failed: ${result.status ?? result.signal}`);
}
try {
  run(zig, ["c++", "-target", "x86_64-windows-gnu", "-std=c++20", "-DUNICODE", "-D_UNICODE",
    join(packageRoot, "src", "native", "shared", "windows_profile_paths_test.cpp"), "-o", executable]);
  run(executable, []);
} finally {
  // Only the directory allocated by this invocation; antivirus may briefly
  // retain a just-exited image mapping.
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
