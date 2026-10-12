import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { machine, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZIG_VERSION } from "../src/shared/build-dependencies.ts";
import { assertWindowsBinaryArchitecture } from "./windows-binary-architecture.mjs";
import { zigCompilerHostArchitecture } from "./zig-compiler-host.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const success = "PASS: contention=8000000 broadcast=4 idle-queue=1000";

// Windows ARM runners must exercise both native execution and the x64
// emulation that exposed the parking handoff failure. Elsewhere use native.
export function synchronizationTargets({ platform = process.platform, processArch = process.arch,
  machine: hostMachine = machine(), env = process.env, target, queryWindowsArchitecture } = {}) {
  if (platform !== "win32") {
    assert.ok(!target || target === "native", "Non-Windows synchronization tests run the native target");
    return [{ target: "native", arch: processArch }];
  }
  const host = zigCompilerHostArchitecture({ platform, processArch, machine: hostMachine, env, queryWindowsArchitecture });
  const targets = host === "arm64"
    ? [{ target: "aarch64-windows-gnu", arch: "arm64" }, { target: "x86_64-windows-gnu", arch: "x64" }]
    : [{ target: "x86_64-windows-gnu", arch: "x64" }];
  if (!target) return targets;
  if (target === "native") return targets.slice(0, 1);
  const selected = targets.filter(candidate => candidate.target === target);
  assert.equal(selected.length, 1, `Target ${target} cannot run on this ${host} Windows host`);
  return selected;
}

// A mutex deadlock cannot reliably run its own timeout. Keep the watchdog in
// this separate process and terminate only the executable we just spawned.
function run(command, args, directory, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, timedOut, elapsedMs: Math.round(performance.now() - started), stdout, stderr });
    });
  });
}

async function main() {
  const options = { repetitions: process.platform === "win32" ? 100 : 10,
    coreRepetitions: 5, timeoutMs: 20_000, compileTimeoutMs: 240_000 };
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (option === "--negative-control") options.negativeControl = true;
    else {
      const key = { "--zig": "zig", "--target": "target", "--output-dir": "outputDirectory", "--repetitions": "repetitions",
        "--core-repetitions": "coreRepetitions", "--timeout-ms": "timeoutMs", "--compile-timeout-ms": "compileTimeoutMs" }[option];
      assert.ok(key && process.argv[index + 1], `Unknown or incomplete option: ${option}`);
      options[key] = process.argv[++index];
    }
  }
  for (const key of ["repetitions", "coreRepetitions", "timeoutMs", "compileTimeoutMs"]) {
    options[key] = Number(options[key]);
    assert.ok(Number.isSafeInteger(options[key]) && options[key] > 0, `${key} must be a positive integer`);
  }
  const targets = synchronizationTargets({ target: options.target });
  const zig = options.zig || process.env.ZIG_BINARY || join(packageRoot, "vendors", "zig", process.platform === "win32" ? "zig.exe" : "zig");
  const directory = options.outputDirectory ? resolve(options.outputDirectory) : await mkdtemp(join(tmpdir(), "electrobun-core-sync-"));
  await mkdir(directory, { recursive: true });
  let implementation = join(packageRoot, "src", "core", "synchronization.zig");
  if (options.negativeControl) {
    implementation = join(directory, "original-synchronization.zig");
    await writeFile(implementation, 'const std = @import("std");\npub const Mutex = std.Io.Mutex;\npub const Condition = std.Io.Condition;\n');
  }

  const report = { targets, platform: process.platform, processArch: process.arch, machine: machine(),
    negativeControl: Boolean(options.negativeControl), repetitions: options.repetitions, coreRepetitions: options.coreRepetitions,
    startedAt: new Date().toISOString(), builds: [], runs: [], status: "running" };
  const save = () => writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
  try {
    const version = await run(zig, ["version"], directory, 10_000);
    assert.ok(!version.timedOut && version.code === 0, `Cannot read Zig version: ${version.stderr}`);
    assert.equal(version.stdout.trim(), ZIG_VERSION, "Use the pinned release compiler");
    report.zigVersion = version.stdout.trim();
    if (process.platform === "win32") assertWindowsBinaryArchitecture(zig, zigCompilerHostArchitecture());

    targetsLoop: for (const { target, arch } of targets) {
      for (const optimize of ["ReleaseFast", "ReleaseSmall"]) {
        // Compile and run both the adapter stress and the real Core queue /
        // callback tests. The negative control changes only the stress import.
        const fixtures = options.negativeControl ? ["adapter"] : ["adapter", "core"];
        for (const fixture of fixtures) {
          const label = `${target} ${optimize} ${fixture}`;
          const executable = join(directory, `core-sync-${target}-${optimize}-${fixture}${process.platform === "win32" ? ".exe" : ""}`);
          const moduleOptions = [`-O${optimize}`, ...(target === "native" ? [] : ["-target", target])];
          const args = fixture === "adapter"
            ? ["build-exe", `-femit-bin=${executable}`, "--cache-dir", join(directory, "cache"), ...moduleOptions,
              "--dep", "core_synchronization", `-Mroot=${join(packageRoot, "scripts", "core-synchronization-stress.zig")}`,
              ...moduleOptions, `-Mcore_synchronization=${implementation}`]
            : ["test", join(packageRoot, "src", "core", "main.zig"), "-lc", "--test-no-exec", `-femit-bin=${executable}`,
              "--cache-dir", join(directory, "cache"), ...moduleOptions];
          console.log(`Building Core synchronization: ${label}`);
          const build = await run(zig, args, directory, options.compileTimeoutMs);
          report.builds.push({ target, optimize, fixture, ...build });
          assert.ok(!build.timedOut && build.code === 0, `Compile ${label} failed: ${build.stderr || JSON.stringify(build)}`);
          if (process.platform === "win32") assertWindowsBinaryArchitecture(executable, arch);
          const repetitions = fixture === "adapter" ? options.repetitions : options.coreRepetitions;
          console.log(`Running Core synchronization: ${label}, ${repetitions} fresh processes`);
          for (let iteration = 1; iteration <= repetitions; iteration++) {
            const result = await run(executable, [], directory, options.timeoutMs);
            report.runs.push({ target, optimize, fixture, iteration, ...result });
            await save();
            if (result.timedOut && options.negativeControl) {
              assert.ok(result.stderr.includes("BEGIN contention") && !result.stderr.includes(success),
                `Inconclusive negative-control timeout outside synchronization phases: ${result.stderr}`);
              report.status = "negative-control-reproduced";
              console.log(`Original synchronization hung: ${label}, iteration ${iteration}\n${result.stderr}`);
              break targetsLoop;
            }
            assert.ok(!result.timedOut, `${label} iteration ${iteration} exceeded ${options.timeoutMs}ms (possible synchronization deadlock): ${result.stderr}`);
            assert.equal(result.code, 0, `${label} iteration ${iteration}: ${result.stderr}`);
            if (fixture === "adapter") assert.ok(result.stderr.includes(success), `${label} did not complete all stress phases: ${result.stderr}`);
            else assert.match(result.stderr, /All \d+ tests passed\./, `${label} did not finish the Core tests`);
          }
          console.log(`Passed ${repetitions} Core synchronization runs: ${label}`);
        }
      }
    }
    if (options.negativeControl) assert.equal(report.status, "negative-control-reproduced", "Original synchronization did not reproduce the hang on this host");
    else report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await save();
    // Keep failure evidence even when check:release/test:vm was invoked without
    // an explicit output directory. Their final summaries omit the root cause.
    if (options.outputDirectory || report.status === "failed") console.log(`Core synchronization results: ${join(directory, "results.json")}`);
    else {
      // This is only the unique directory created above, never a caller path.
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("electrobun-core-sync-"));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
