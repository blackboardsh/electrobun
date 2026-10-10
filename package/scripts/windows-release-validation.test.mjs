import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zigCompilerHostArchitecture } from "./zig-compiler-host.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(packageRoot, "../.github/workflows/release.yml"), "utf8");
const integration = readFileSync(resolve(packageRoot, "src/launcher/windows_process_identity.integration.test.mjs"), "utf8");
const nativeRunner = readFileSync(resolve(packageRoot, "scripts/test-windows-profile-paths.mjs"), "utf8");
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
  assert.equal((section.match(/if \(\$LASTEXITCODE -ne 0\)/g) || []).length, 2);
  assert.match(nativeRunner, /run\("cl\.exe",/);
  assert.match(nativeRunner, /"\/UNDEBUG"/);
  assert.match(nativeRunner, /assertWindowsBinaryArchitecture\(executable, process\.arch\)/);
  assert.ok(nativeRunner.indexOf("assertWindowsBinaryArchitecture(executable, process.arch)") < nativeRunner.indexOf("run(executable, [])"));
  assert.match(nativeRunner, /run\(executable, \[\]\)/);
});
