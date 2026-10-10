import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZIG_VERSION } from "../src/shared/build-dependencies.ts";
import { assertWindowsBinaryArchitecture } from "./windows-binary-architecture.mjs";

if (process.platform !== "win32") {
  console.log("Windows Threaded startup/shutdown stress skipped on this platform.");
} else {
  assert.ok(["arm64", "x64"].includes(process.arch), "Windows stress requires a supported native architecture");
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const zig = process.env.ZIG_BINARY || join(packageRoot, "vendors/zig/zig.exe");
  const target = process.arch === "arm64" ? "aarch64-windows-gnu" : "x86_64-windows-gnu";
  const directory = mkdtempSync(join(tmpdir(), "electrobun-threaded-shutdown-"));
  function run(binary, args, timeout) {
    const result = spawnSync(binary, args, { cwd: directory, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    assert.equal(result.status, 0, `${binary} ${args.join(" ")} failed (${result.error?.code || result.signal || result.status}):\n${output}`);
    return output;
  }
  try {
    assert.equal(run(zig, ["version"], 10_000).trim(), ZIG_VERSION, "Use the pinned release compiler");
    for (const optimize of ["ReleaseFast", "ReleaseSmall"]) {
      const executable = join(directory, `${optimize}.exe`);
      run(zig, ["build-exe", join(packageRoot, "scripts/fixtures/windows-threaded-shutdown.zig"),
        "-lc", "-target", target, "-O", optimize, `-femit-bin=${executable}`], 240_000);
      assertWindowsBinaryArchitecture(executable, process.arch);
      // Fresh processes vary scheduling/address layout; each child also repeats
      // teardown to expose lost wakeups. No child creates descendant processes.
      for (let batch = 0; batch < 4; batch++) {
        assert.match(run(executable, [], 30_000), /completed 50 startup\/shutdown cycles/);
      }
      console.log(`Windows ${process.arch} ${optimize}: 200 Threaded startup/shutdown cycles passed.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
