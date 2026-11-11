import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZIG_VERSION } from "../src/shared/build-dependencies.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vendoredZig = join(packageRoot, "vendors", "zig", process.platform === "win32" ? "zig.exe" : "zig");
const zig = process.env.ZIG_BINARY || (existsSync(vendoredZig) ? vendoredZig : "zig");
const version = spawnSync(zig, ["version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
assert.ifError(version.error);
assert.equal(version.status, 0, `Cannot read Zig version: ${version.stderr}`);
assert.equal(version.stdout.trim(), ZIG_VERSION, `Use Zig ${ZIG_VERSION}; set ZIG_BINARY to its executable if needed`);

const result = spawnSync(zig, ["build", "test-updater", "--summary", "all"], {
  cwd: join(packageRoot, "src", "core"),
  stdio: "inherit",
  timeout: 300_000,
  windowsHide: true,
});
assert.ifError(result.error);
assert.equal(result.status, 0, `Shared updater tests failed${result.signal ? ` (${result.signal})` : ""}`);
