import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { nativeWindowsArchitecture, zigCompilerHostArchitecture } from "./zig-compiler-host.mjs";
import { coreTestsCompleted, runSynchronizationProcess, synchronizationTargets } from "./core-synchronization-stress.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(packageRoot, "../.github/workflows/release.yml"), "utf8");
const integration = readFileSync(resolve(packageRoot, "src/launcher/windows_process_identity.integration.test.mjs"), "utf8");
const nativeRunner = readFileSync(resolve(packageRoot, "scripts/test-windows-profile-paths.mjs"), "utf8");
const webview2Runner = readFileSync(resolve(packageRoot, "scripts/test-windows-webview2-window.mjs"), "utf8");
const build = readFileSync(resolve(packageRoot, "build.ts"), "utf8");

test("Windows Zig compiler uses host architecture and rejects a stale emulated vendor", () => {
  const vendor = build.slice(build.indexOf("async function vendorZig()"), build.indexOf("function getRustHostTriple()"));
  assert.match(vendor, /const zigArch = ZIG_HOST_ARCH === "arm64" \? "aarch64" : "x86_64"/);
  assert.match(vendor, /zig-\$\{zigArch\}-windows-\$\{ZIG_VERSION\}/);
  const verify = build.slice(build.indexOf("function verifyVendoredZig()"), build.indexOf("async function vendorZig()"));
  assert.match(verify, /assertWindowsBinaryArchitecture\(PATH\.zig\.BIN, ZIG_HOST_ARCH\)/);
  assert.ok(vendor.indexOf("verifyVendoredZig()") < vendor.indexOf("return;"));
});

test("an emulated JS runtime selects the native Windows ARM64 compiler", () => {
  const noProbe = () => { throw new Error("Native query was unnecessary"); };
  for (const [machine, env] of [
    ["ARM64", {}],
    ["x86_64", { PROCESSOR_ARCHITEW6432: "ARM64", PROCESSOR_ARCHITECTURE: "AMD64" }],
    ["x86_64", { PROCESSOR_ARCHITECTURE: "ARM64" }],
  ]) assert.equal(zigCompilerHostArchitecture({ platform: "win32", processArch: "x64", machine, env, queryWindowsArchitecture: noProbe }), "arm64");
  assert.equal(zigCompilerHostArchitecture({ platform: "win32", processArch: "arm64", machine: "x86_64", env: {}, queryWindowsArchitecture: noProbe }), "arm64");
  assert.equal(zigCompilerHostArchitecture({ platform: "win32", processArch: "x64", machine: "AMD64", env: {}, queryWindowsArchitecture: () => "x64" }), "x64");
  assert.equal(zigCompilerHostArchitecture({ platform: "linux", processArch: "x64", machine: "x86_64", env: { PROCESSOR_ARCHITECTURE: "ARM64" }, queryWindowsArchitecture: noProbe }), "x64");
  assert.equal(zigCompilerHostArchitecture({ platform: "darwin", processArch: "arm64", machine: "arm64", env: {}, queryWindowsArchitecture: noProbe }), "arm64");
  assert.throws(() => zigCompilerHostArchitecture({ platform: "win32", processArch: "ia32", machine: "i686", env: {}, queryWindowsArchitecture: noProbe }), /Unsupported/);
});

test("x64 runtimes with no ARM hints use the native machine query, independently of the app target", () => {
  const env = { PROCESSOR_ARCHITECTURE: "AMD64", HUTCH_ELECTROBUN_TARGET_ARCH: "x64" };
  const host = { platform: "win32", processArch: "x64", machine: "x86_64", env };
  let queries = 0;
  assert.equal(zigCompilerHostArchitecture({ ...host, queryWindowsArchitecture(options) {
    queries++;
    assert.equal(options.env, env);
    return "arm64";
  } }), "arm64");
  assert.equal(queries, 1);
  assert.equal(env.HUTCH_ELECTROBUN_TARGET_ARCH, "x64");
  assert.equal(zigCompilerHostArchitecture({ ...host, queryWindowsArchitecture: () => "x64" }), "x64");
  assert.throws(() => zigCompilerHostArchitecture({ ...host, queryWindowsArchitecture: () => "ia32" }), /Unsupported native Windows/);
  assert.throws(() => zigCompilerHostArchitecture({ ...host, queryWindowsArchitecture() { throw new Error("query timeout"); } }), /query timeout/);
});

test("native Windows query invokes IsWow64Process2 with a hidden bounded process and parses native architecture", () => {
  for (const [stdout, expected] of [["aa64\r\n", "arm64"], ["8664\n", "x64"], ["AA64\n", "arm64"]]) {
    assert.equal(nativeWindowsArchitecture({ env: { SystemRoot: "C:\\Windows" }, run(executable, args, options) {
      assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      assert.equal(args.length, 4);
      const program = Buffer.from(args[3], "base64").toString("utf16le");
      assert.match(program, /IsWow64Process2\(\[IntPtr\]::new\(-1\), \[ref\]\$processMachine, \[ref\]\$nativeMachine\)/);
      assert.match(program, /Write-Output \('\{0:x4\}' -f \$nativeMachine\)/);
      assert.doesNotMatch(program, /GetNativeSystemInfo/);
      assert.deepEqual(options, { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
      return { status: 0, stdout };
    } }), expected);
  }
});

test("native Windows query fails clearly instead of silently selecting an emulated compiler", () => {
  for (const result of [
    { status: null, error: { code: "ETIMEDOUT" } },
    { status: null, error: { code: "ENOENT" } },
    { status: 1, stdout: "aa64" },
    { status: null, signal: "SIGTERM" },
    { status: 0, stdout: "" },
    { status: 0, stdout: "014c" },
    { status: 0, stdout: "8664\naa64" },
    { status: 0, stdout: "aa64 unexpected" },
  ]) assert.throws(() => nativeWindowsArchitecture({ env: { SystemRoot: "C:\\Windows" }, run: () => result }), /Cannot determine native Windows Zig compiler host/);
  for (const env of [{}, { SystemRoot: "relative\\Windows" }]) {
    assert.throws(() => nativeWindowsArchitecture({ env, run() { assert.fail("Invalid path must not spawn a process"); } }), /SystemRoot is not an absolute path/);
  }
});

test("Windows launcher gate uses the packaged GUI launcher before artifact publication and cannot skip", () => {
  const start = workflow.indexOf("      - name: Test Windows release launcher identity and full exit status");
  assert.ok(start > workflow.indexOf("        run: node scripts/package-release.js"));
  const section = workflow.slice(start, workflow.indexOf("      - name:", start + 12));
  assert.match(section, /if: matrix\.platform == 'win32'/);
  assert.match(section, /ELECTROBUN_REQUIRE_TEST_LAUNCHER: '1'/);
  assert.match(section, /Resolve-Path \.\\dist\\launcher\.exe/);
  assert.match(section, /node --test src\/launcher\/windows_process_identity\.integration\.test\.mjs/);
  assert.match(section, /if \(\$LASTEXITCODE -ne 0\)/);
  assert.ok(start < workflow.indexOf("      - name: Upload core artifact"));
  assert.match(integration, /assert\.ok\(launcher,/);
  assert.match(integration, /assertWindowsBinaryArchitecture\(launcher, process\.arch\)/);
});

test("Windows profile path and lifecycle source regressions are release gates with native architecture coverage", () => {
  const start = workflow.indexOf("      - name: Test Windows profile paths and WebView2 teardown");
  assert.ok(start > workflow.indexOf("        run: node scripts/package-release.js"));
  const section = workflow.slice(start, workflow.indexOf("      - name:", start + 12));
  assert.match(section, /if: matrix\.platform == 'win32'/);
  assert.match(section, /node scripts\/test-windows-profile-paths\.mjs/);
  assert.match(section, /node scripts\/run-bun-test\.js src\/shared\/windows-webview2-lifecycle\.test\.ts/);
  assert.equal((section.match(/if \(\$LASTEXITCODE -ne 0\)/g) || []).length, 4);
  assert.match(nativeRunner, /run\("cl\.exe",/);
  assert.match(nativeRunner, /"\/UNDEBUG"/);
  assert.match(nativeRunner, /assertWindowsBinaryArchitecture\(executable, process\.arch\)/);
  assert.ok(nativeRunner.indexOf("assertWindowsBinaryArchitecture(executable, process.arch)") < nativeRunner.indexOf("run(executable, [])"));
  assert.match(nativeRunner, /run\(executable, \[\]\)/);
});

test("real WebView2 ownership and presentation assertion regressions gate Windows publication", () => {
  const start = workflow.indexOf("      - name: Test Windows profile paths and WebView2 teardown");
  const section = workflow.slice(start, workflow.indexOf("      - name:", start + 12));
  assert.match(section, /node scripts\/test-windows-webview2-window\.mjs --install-missing-runtime/);
  assert.match(section, /windows-webview2-lifecycle\.test\.ts src\/shared\/windows-webview2-initialization\.test\.ts/);
  assert.match(section, /webview2-initialization-state\.test\.ts .*webview2-stacking-state\.test\.ts/);
  assert.ok(start < workflow.indexOf("      - name: Upload core artifact"));
  assert.doesNotMatch(section, /continue-on-error/);
  assert.match(webview2Runner, /assertWindowsBinaryArchitecture\(executable, process\.arch\)/);
  assert.match(webview2Runner, /ensureWebview2Runtime/);
  assert.match(webview2Runner, /allowInstall: process\.argv\.includes\("--install-missing-runtime"\)/);
  assert.match(workflow, /node --test scripts\/windows-release-validation\.test\.mjs scripts\/webview2-runtime\.test\.mjs/);
  assert.match(webview2Runner, /--legacy-coordinate-control/);
  assert.match(webview2Runner, /assert\.equal\(negative\.status, 1/);
  assert.match(webview2Runner, /zero-size target must be exact top sibling/);
  assert.match(webview2Runner, /assert\.equal\(fixed\.status, 0/);
});

test("Core synchronization must pass on every release target before artifacts can publish", () => {
  const buildJob = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("\n  release:"));
  const start = buildJob.indexOf("      - name: Test core synchronization under contention");
  const upload = buildJob.indexOf("      - name: Upload core artifact");
  assert.ok(start > buildJob.indexOf("        run: node scripts/package-release.js"));
  assert.ok(upload > start, "Synchronization stress must gate the first core artifact upload");
  const section = buildJob.slice(start, buildJob.indexOf("      - name:", start + 12));
  assert.match(section, /^        run: node scripts\/core-synchronization-stress\.mjs\s*$/m);
  assert.match(section, /^        working-directory: package\s*$/m);
  assert.doesNotMatch(section, /^        (?:if|continue-on-error):/m, "No target may skip or ignore this gate");
  const deadline = section.match(/^        timeout-minutes: (\d+)\s*$/m);
  assert.ok(deadline && Number(deadline[1]) > 0 && Number(deadline[1]) <= 30,
    "A deadlocked test process must not leave the release job waiting indefinitely");
  for (const arch of ["x64", "arm64"]) {
    assert.match(buildJob, new RegExp(`platform: win32\\s+arch: ${arch}\\b`));
  }
});

test("Windows ARM synchronization covers native and emulated binaries even with an x64 JS host", () => {
  const expected = [
    { target: "aarch64-windows-gnu", arch: "arm64" },
    { target: "x86_64-windows-gnu", arch: "x64" },
  ];
  for (const host of [
    { processArch: "arm64", machine: "ARM64", env: {} },
    { processArch: "x64", machine: "ARM64", env: {} },
    { processArch: "x64", machine: "AMD64", env: { PROCESSOR_ARCHITEW6432: "ARM64" } },
    { processArch: "x64", machine: "x86_64", env: { PROCESSOR_ARCHITECTURE: "AMD64" }, queryWindowsArchitecture: () => "arm64" },
  ]) assert.deepEqual(synchronizationTargets({ platform: "win32", ...host }), expected);
});

test("synchronization targets stay executable on each host and reject incompatible overrides", () => {
  const windowsX64 = { platform: "win32", processArch: "x64", machine: "AMD64", env: {}, queryWindowsArchitecture: () => "x64" };
  assert.deepEqual(synchronizationTargets(windowsX64), [{ target: "x86_64-windows-gnu", arch: "x64" }]);
  assert.throws(() => synchronizationTargets({ ...windowsX64, target: "aarch64-windows-gnu" }), /cannot run/);
  for (const [platform, processArch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"]]) {
    const host = { platform, processArch, machine: processArch, env: {} };
    assert.deepEqual(synchronizationTargets(host), [{ target: "native", arch: processArch }]);
    assert.throws(() => synchronizationTargets({ ...host, target: "x86_64-windows-gnu" }), /native target/);
  }
});

test("Core watchdog preserves successful output and exit status", async () => {
  const result = await runSynchronizationProcess(process.execPath, ["-e", `
    process.stderr.write("1/2 fixture.test.first...OK\\n");
    setTimeout(() => process.stderr.write("2/2 fixture.test.second...OK\\nAll 2 tests passed.\\n"), 50);
  `], packageRoot, 5_000);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /All 2 tests passed\./);
});

test("Core completion accepts successful Zig summaries with platform skips", () => {
  // Captured Windows beta.6 output: the POSIX environment regression skips,
  // while the other 49 Core tests pass. Middle test lines are omitted here.
  const windowsOutput = [
    "4/50 main.test.native profile root lookup survives unrelated environment removal while allocating...SKIP",
    "50/50 insights_spool.test.legacy JSON migrates without changing plaintext or key and obeys independent size bounds...OK",
    "49 passed; 1 skipped; 0 failed.",
    "",
  ].join("\r\n");
  assert.equal(coreTestsCompleted(windowsOutput), true);
  assert.equal(coreTestsCompleted("1/1 fixture.test.one...OK\nAll 1 tests passed.\n"), true);
  assert.equal(coreTestsCompleted("All 50 tests passed.\n"), true);
  assert.equal(coreTestsCompleted("1 passed; 0 skipped; 0 failed.\n"), true);
});

test("Core completion rejects failures, empty runs, incomplete or superseded summaries", () => {
  for (const output of [
    "", "1/50 fixture.test.one...OK\n", "All 0 tests passed.\n",
    "0 passed; 50 skipped; 0 failed.\n", "0 passed; 0 skipped; 0 failed.\n",
    "48 passed; 1 skipped; 1 failed.\n", "49 passed; 1 skipped; 0 failed",
    "49 passed; 1 skipped.\n", "passed; 1 skipped; 0 failed.\n",
    "All 50 tests passed.\n1 tests leaked memory.\n",
    "49 passed; 1 skipped; 0 failed.\n1 errors were logged.\n",
    "All 50 tests passed.\n1/50 fixture.test.next-run...",
  ]) assert.equal(coreTestsCompleted(output), false, JSON.stringify(output));
});

test("Core watchdog kills a stalled child even when it keeps producing output", async () => {
  const result = await runSynchronizationProcess(process.execPath, ["-e", `
    process.stderr.write("1/2 fixture.test.completed...OK\\n");
    setInterval(() => process.stderr.write("waiting for stuck test\\n"), 20);
  `], packageRoot, 5_000);
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /1\/2 fixture\.test\.completed\.\.\.OK/);
  assert.doesNotMatch(result.stderr, /All 2 tests passed\./);
  assert.ok(result.elapsedMs < 15_000, "The parent must terminate the stalled child, not wait for it to exit");
});
