import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zigCompilerHostArchitecture } from "./zig-compiler-host.mjs";
import { synchronizationTargets } from "./core-synchronization-stress.mjs";

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
  for (const [machine, env] of [
    ["ARM64", {}],
    ["x86_64", { PROCESSOR_ARCHITEW6432: "ARM64", PROCESSOR_ARCHITECTURE: "AMD64" }],
    ["x86_64", { PROCESSOR_ARCHITECTURE: "ARM64" }],
  ]) assert.equal(zigCompilerHostArchitecture({ platform: "win32", processArch: "x64", machine, env }), "arm64");
  assert.equal(zigCompilerHostArchitecture({ platform: "win32", processArch: "arm64", machine: "x86_64", env: {} }), "arm64");
  assert.equal(zigCompilerHostArchitecture({ platform: "win32", processArch: "x64", machine: "AMD64", env: {} }), "x64");
  assert.equal(zigCompilerHostArchitecture({ platform: "linux", processArch: "x64", machine: "x86_64", env: { PROCESSOR_ARCHITECTURE: "ARM64" } }), "x64");
  assert.equal(zigCompilerHostArchitecture({ platform: "darwin", processArch: "arm64", machine: "arm64", env: {} }), "arm64");
  assert.throws(() => zigCompilerHostArchitecture({ platform: "win32", processArch: "ia32", machine: "i686", env: {} }), /Unsupported/);
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
  ]) assert.deepEqual(synchronizationTargets({ platform: "win32", ...host }), expected);
});

test("synchronization targets stay executable on each host and reject incompatible overrides", () => {
  const windowsX64 = { platform: "win32", processArch: "x64", machine: "AMD64", env: {} };
  assert.deepEqual(synchronizationTargets(windowsX64), [{ target: "x86_64-windows-gnu", arch: "x64" }]);
  assert.throws(() => synchronizationTargets({ ...windowsX64, target: "aarch64-windows-gnu" }), /cannot run/);
  for (const [platform, processArch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "arm64"]]) {
    const host = { platform, processArch, machine: processArch, env: {} };
    assert.deepEqual(synchronizationTargets(host), [{ target: "native", arch: processArch }]);
    assert.throws(() => synchronizationTargets({ ...host, target: "x86_64-windows-gnu" }), /native target/);
  }
});
