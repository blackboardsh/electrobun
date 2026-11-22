import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Run against a freshly built launcher using ELECTROBUN_TEST_LAUNCHER. A copied
// Node binary independently records the argv and stdin received by each runtime shape;
// no Electrobun UI, native wrapper, or display server is needed.
const launcher = process.env.ELECTROBUN_TEST_LAUNCHER
  ? resolve(process.env.ELECTROBUN_TEST_LAUNCHER)
  : undefined;
const extension = process.platform === "win32" ? ".exe" : "";
const applicationArgs = ["--headless", "--settings-file", "a path/é.json", "", 'quote"and\\slash', "C:\\directory with space\\", 'slash before\\"quote', "--automation=true", "--", "tail"];
const secret = `enrollment-test-secret-${randomBytes(18).toString("hex")}`;
const stdinPayload = Buffer.from(JSON.stringify({ apiKey: secret, machineName: "café 雪 🚀", startup: { openWindow: false } }) + "\n");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const reportScript = `
  const stdin = require('node:fs').readFileSync(0);
  require('node:fs').writeFileSync(process.env.ARGUMENTS_REPORT, JSON.stringify({
    args: process.argv.slice(process.env.ARGUMENTS_OFFSET),
    automation: process.env.ELECTROBUN_WEBKIT_AUTOMATION ?? null,
    stdinSha256: require('node:crypto').createHash('sha256').update(stdin).digest('hex'),
    stdinLength: stdin.length,
  }), { mode: 0o600 });
`;

const channels = ["dev", "canary"];
for (const [mainProcess, channel] of ["zig", "rust", "go", "odin", "bun", "cottontail"]
  .flatMap(runtime => channels.map(channel => [runtime, channel]))) {
  test(`${channel} launcher forwards exact arguments and stdin to ${mainProcess}, including launches without input`, {
    skip: !launcher, timeout: 60_000,
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
        ARGUMENTS_OFFSET: isScript ? "2" : "1",
      };
      delete env.ELECTROBUN_WEBKIT_AUTOMATION;
      // Exercise Windows production spawning even if the caller normally forces
      // console mode. The other platforms still cover both release channels.
      delete env.ELECTROBUN_CONSOLE;
      for (const scenario of [
        { name: "private-json", stdin: "pipe", input: stdinPayload, args: applicationArgs, automation: true },
        { name: "empty-pipe", stdin: "pipe", input: Buffer.alloc(0), args: [], automation: false },
        { name: "ignored-stdin", stdin: "ignore", input: undefined, args: [], automation: false },
      ]) {
        env.ARGUMENTS_REPORT = join(directory, `${scenario.name}.json`);
        const args = [
          ...(scenario.automation ? ["--automation"] : []),
          ...(isScript ? [] : ["--eval", reportScript, "--"]),
          ...scenario.args,
        ];
        const result = spawnSync(join(bin, `launcher${extension}`), args, {
          cwd: directory, env, encoding: "utf8", timeout: 15_000, windowsHide: true,
          stdio: [scenario.stdin, "pipe", "pipe"], input: scenario.input,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
        const actual = JSON.parse(await readFile(env.ARGUMENTS_REPORT, "utf8"));
        assert.deepEqual(actual.args, scenario.args, scenario.name);
        assert.equal(actual.automation, process.platform === "linux" && scenario.automation ? "1" : null, scenario.name);
        const expectedInput = scenario.input ?? Buffer.alloc(0);
        assert.equal(actual.stdinLength, expectedInput.length, `${scenario.name}: stdin byte length`);
        assert.equal(actual.stdinSha256, digest(expectedInput), `${scenario.name}: exact stdin bytes`);
        const output = `${result.stdout}${result.stderr}`;
        assert.ok(!output.includes(secret), "stdin secrets must not be logged");
        assert.ok(!output.includes(stdinPayload.toString("utf8")), "stdin payload must not be echoed");
        assert.ok(!output.includes("a path/é.json"), "application settings must not be logged");
        if (process.platform !== "win32") assert.equal((await stat(env.ARGUMENTS_REPORT)).mode & 0o777, 0o600);
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
