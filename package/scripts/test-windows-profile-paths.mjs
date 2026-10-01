import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsBinaryArchitecture } from "./windows-binary-architecture.mjs";

if (process.platform !== "win32") {
  console.log("Windows profile path native test: use test-windows-profile-paths.sh on POSIX");
  process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "electrobun-profile-paths-"));
const executable = join(directory, "windows-profile-paths.exe");
function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit", windowsHide: true, timeout: 180_000 });
  if (result.error?.code === "ENOENT" && command === "cl.exe") {
    throw new Error(`Run this test in an MSVC developer environment targeting ${process.arch}.`, { cause: result.error });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows profile path test failed: ${result.status ?? result.signal}`);
}
try {
  // Use the wrapper's MSVC toolchain, already selected for this architecture in
  // CI. Zig's first Windows GNU compile builds its own libc++/MinGW runtime and
  // can exhaust this small test's deadline under ARM64 host emulation.
  run("cl.exe", ["/nologo", "/std:c++20", "/EHsc", "/utf-8", "/DNOMINMAX", "/DUNICODE", "/D_UNICODE", "/UNDEBUG",
    join(packageRoot, "src", "native", "shared", "windows_profile_paths_test.cpp"),
    `/Fo${join(directory, "windows-profile-paths.obj")}`, `/Fe${executable}`]);
  assertWindowsBinaryArchitecture(executable, process.arch);
  run(executable, []);
} finally {
  // Only the directory allocated by this invocation; antivirus may briefly
  // retain a just-exited image mapping.
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
