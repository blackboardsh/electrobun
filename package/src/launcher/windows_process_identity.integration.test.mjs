import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

// This is a launcher test, not Desktop runtime coverage. A copied Node binary
// supplies an independent process.pid oracle and a deterministic exit fixture.
const launcher = process.env.ELECTROBUN_TEST_LAUNCHER;
const available = process.platform === "win32" && Boolean(launcher);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let supervisorDirectory;
let supervisor;
before(async () => {
  if (!available) return;
  supervisorDirectory = await mkdtemp(join(tmpdir(), "electrobun-test-job-"));
  supervisor = join(supervisorDirectory, "supervisor.exe");
  const zig = process.env.ZIG_BINARY || join(packageRoot, "vendors/zig/zig.exe");
  const result = spawnSync(zig, ["build-exe", join(packageRoot, "src/launcher/windows_test_job.zig"),
    "-target", "x86_64-windows-gnu", "-O", "ReleaseSafe", `-femit-bin=${supervisor}`], {
    cwd: supervisorDirectory, stdio: "inherit", timeout: 180_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, "Windows test Job supervisor must compile");
}, { timeout: 190_000 });
after(async () => {
  if (supervisorDirectory) await rm(supervisorDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function runInJob(command, args, options, timeoutMs = 20_000) {
  // Native Job ownership precedes the launcher's first instruction. Its own
  // deadline and parent-death handle cover every descendant, including detached
  // children. Node's last-resort timeout kills only the supervisor handle; the
  // Job's kill-on-close policy still contains children if the supervisor fails.
  const child = spawn(supervisor, [`Local\\ElectrobunLauncherTest-${randomUUID()}`,
    String(process.pid), String(timeoutMs), command, ...args], {
    ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs + 7_000, killSignal: "SIGKILL",
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", chunk => output += chunk);
  child.stderr.setEncoding("utf8").on("data", chunk => output += chunk);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const rows = output.split(/\r?\n/).filter(line => line.startsWith("[electrobun:test-job] "))
    .map(line => JSON.parse(line.slice("[electrobun:test-job] ".length)));
  assert.deepEqual(rows.map(row => row.event), ["spawn", "empty"], `missing owned Job teardown proof: ${output}`);
  assert.equal(rows[1].active, 0);
  return { result, output, targetPid: rows[0].pid, timedOut: rows[1].timedOut };
}

if (process.env.ELECTROBUN_REQUIRE_TEST_LAUNCHER === "1") {
  assert.equal(process.platform, "win32", "the required launcher gate needs Windows");
  assert.equal(process.arch, "x64", "the release launcher gate targets Windows x64");
  assert.ok(launcher, "ELECTROBUN_TEST_LAUNCHER must select the freshly built release launcher");
}
for (const channel of ["dev", "stable"]) {
  for (const fixture of [{ exit: "exit", code: 0 }, { exit: "exit", code: 9 },
    { exit: "exit", code: 0xc0000409 }, { exit: "exit", code: 0xc0000400 }, { exit: "self-terminate", code: 1 }]) {
    // Node/libuv reports forced Windows termination as 1, unlike Cottontail's
    // signal-number exit code. Both must be reported without interpretation.
    const { exit, code: expectedCode } = fixture;
    test(`Windows ${channel} launcher records the real child identity and ${exit} code ${expectedCode}`, {
      skip: !available, timeout: 35_000,
    }, async () => {
      const directory = await mkdtemp(join(tmpdir(), "electrobun identity é "));
      try {
        const bin = join(directory, "bin");
        const resources = join(directory, "Resources");
        await Promise.all([mkdir(bin), mkdir(resources)]);
        await Promise.all([
          copyFile(launcher, join(bin, "launcher.exe")),
          copyFile(process.execPath, join(bin, "bun.exe")),
          writeFile(join(resources, "build.json"), JSON.stringify({ mainProcess: "bun" })),
          // Omit install metadata: this unmanaged fixture must not register an app.
          writeFile(join(resources, "version.json"), JSON.stringify({ channel })),
          writeFile(join(resources, "main.js"), `
            const fs = require('node:fs');
            fs.writeFileSync(process.env.IDENTITY_REPORT, JSON.stringify({pid:process.pid, parentPid:process.ppid, at:Date.now()}));
            ${exit === "exit" ? `process.exit(${expectedCode})` : "process.kill(process.pid, 'SIGKILL')"};
          `),
        ]);
        const env = { ...process.env, IDENTITY_REPORT: join(directory, "identity.json") };
        delete env.ELECTROBUN_CONSOLE;
        const { result, output, targetPid, timedOut } = await runInJob(join(bin, "launcher.exe"), [], { cwd: bin, env });
        assert.equal(timedOut, false, output);
        assert.deepEqual(result, { code: expectedCode, signal: null });
        const actual = JSON.parse(await readFile(env.IDENTITY_REPORT, "utf8"));
        const rows = output.split(/\r?\n/).filter((line) => line.startsWith("[electrobun:process] ")).map((line) => JSON.parse(line.slice("[electrobun:process] ".length)));
        assert.deepEqual(rows.map(({ event }) => event), ["spawn", "exit"]);
        const [spawned, exited] = rows;
        assert.equal(spawned.pid, actual.pid);
        assert.equal(spawned.launcherPid, targetPid);
        assert.equal(actual.parentPid, targetPid);
        assert.match(output, new RegExp(`Child process spawned with PID ${actual.pid}\\b`));
        assert.equal(exited.pid, actual.pid);
        assert.equal(exited.createdFiletime, spawned.createdFiletime);
        assert.equal(exited.code, expectedCode);
        const birthMs = Number((BigInt(spawned.createdFiletime) - 116444736000000000n) / 10000n);
        assert.ok(birthMs <= actual.at && actual.at - birthMs < 10_000);
        assert.ok(BigInt(exited.observedFiletime) >= BigInt(spawned.observedFiletime));
      } finally {
        // Windows image mappings/antivirus can briefly retain a just-exited exe.
        await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }
}

for (const stayAlive of [false, true]) {
  test(`Windows test Job removes detached descendants after ${stayAlive ? "native deadline" : "normal exit"}`, {
    skip: !available, timeout: 15_000,
  }, async () => {
    const source = `
      const {spawn} = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore'
      });
      console.log('GRANDCHILD:' + grandchild.pid);
      grandchild.unref();
      ${stayAlive ? "setInterval(() => {}, 1000);" : ""}
    `;
    const { result, output, timedOut } = await runInJob(process.execPath, ["-e", source], {}, 1_500);
    assert.deepEqual(result, { code: stayAlive ? 124 : 0, signal: null });
    assert.equal(timedOut, stayAlive);
    const match = output.match(/GRANDCHILD:(\d+)/);
    assert.ok(match, output);
    assert.throws(() => process.kill(Number(match[1]), 0), { code: "ESRCH" }, "detached descendant survived Job teardown");
  });
}
