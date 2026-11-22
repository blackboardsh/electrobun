import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Run against a freshly built launcher using ELECTROBUN_TEST_LAUNCHER. A copied
// Node binary independently records the argv received by each runtime shape;
// no Electrobun UI, native wrapper, or display server is needed.
const launcher = process.env.ELECTROBUN_TEST_LAUNCHER
  ? resolve(process.env.ELECTROBUN_TEST_LAUNCHER)
  : undefined;
const extension = process.platform === "win32" ? ".exe" : "";
const applicationArgs = ["--headless", "--settings-file", "a path/é.json", "", 'quote"and\\slash', "C:\\directory with space\\", 'slash before\\"quote', "--automation=true", "--", "tail"];
const reportScript = `
  require('node:fs').writeFileSync(process.env.ARGUMENTS_REPORT, JSON.stringify({
    args: process.argv.slice(process.env.ARGUMENTS_OFFSET),
    automation: process.env.ELECTROBUN_WEBKIT_AUTOMATION ?? null,
  }));
`;

const channels = process.platform === "win32" ? ["dev", "canary"] : ["dev"];
for (const [mainProcess, channel] of ["zig", "rust", "go", "odin", "bun", "cottontail"]
  .flatMap(runtime => channels.map(channel => [runtime, channel]))) {
  test(`${channel} launcher forwards exact arguments to ${mainProcess} and consumes its automation flag`, {
    skip: !launcher, timeout: 20_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "electrobun arguments é "));
    try {
      const bin = join(directory, "bin");
      const resources = join(directory, "Resources");
      const isScript = mainProcess === "bun" || mainProcess === "cottontail";
      await Promise.all([mkdir(bin), mkdir(resources)]);
      await Promise.all([
        copyFile(launcher, join(bin, `launcher${extension}`)),
        copyFile(process.execPath, join(bin, `${isScript ? mainProcess : "main"}${extension}`)),
        writeFile(join(resources, "build.json"), JSON.stringify({ mainProcess })),
        // This unmanaged fixture must never register an installed application.
        writeFile(join(resources, "version.json"), JSON.stringify({ channel })),
        writeFile(join(resources, "main.js"), reportScript),
      ]);
      const env = {
        ...process.env,
        ARGUMENTS_REPORT: join(directory, "received.json"),
        ARGUMENTS_OFFSET: isScript ? "2" : "1",
      };
      delete env.ELECTROBUN_WEBKIT_AUTOMATION;
      const args = ["--automation", ...(isScript ? [] : ["--eval", reportScript, "--"]), ...applicationArgs];
      const result = spawnSync(join(bin, `launcher${extension}`), args, {
        cwd: directory, env, encoding: "utf8", timeout: 15_000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(await readFile(env.ARGUMENTS_REPORT, "utf8"));
      assert.deepEqual(actual.args, applicationArgs);
      assert.equal(actual.automation, process.platform === "linux" ? "1" : null);
      assert.ok(!result.stderr.includes("a path/é.json"), "application settings must not be logged");
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
