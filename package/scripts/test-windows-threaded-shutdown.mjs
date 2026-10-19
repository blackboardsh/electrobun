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
      run(zig, ["test", join(packageRoot, "scripts/fixtures/windows-threaded-shutdown.zig"),
        "-lc", "-target", target, "-O", optimize, "--test-no-exec", `-femit-bin=${executable}`], 240_000);
      assertWindowsBinaryArchitecture(executable, process.arch);
      // Reproduce the native test allocator and fresh-process layout that
      // exposed lost shutdown wakeups. No child creates descendant processes.
      for (let cycle = 0; cycle < 200; cycle++) {
        assert.match(run(executable, [], 10_000), /completed startup\/shutdown cycle/);
      }
      console.log(`Windows ${process.arch} ${optimize}: 200 Threaded startup/shutdown cycles passed.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
