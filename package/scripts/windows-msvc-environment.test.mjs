import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadMsvcEnvironment, mergeWindowsEnvironment, msvcEnvironment } from "./windows-msvc-environment.mjs";

const configured = arch => ({ Path: `C:\\MSVC\\${arch}`, INCLUDE: "C:\\SDK\\include", LIB: "C:\\SDK\\lib", VSCMD_ARG_TGT_ARCH: arch });
const banner = arch => ({ status: 2, stderr: `Microsoft (R) C/C++ Optimizing Compiler Version 19.51.36260 for ${arch}\n`, stdout: "" });

test("matching developer environment is preserved without invoking setup", () => {
  const env = { ...configured("arm64"), PRIVATE_VALUE: "unchanged\nvalue", vslang: "1031" };
  const result = msvcEnvironment({ arch: "arm64", env,
    spawn: (command, args, options) => {
      assert.equal(command, "cl.exe"); assert.deepEqual(args, ["/Bv"]);
      assert.equal(options.env.VSLANG, "1033"); assert.equal(options.env.vslang, undefined);
      assert.equal(options.env.PRIVATE_VALUE, env.PRIVATE_VALUE);
      return banner("ARM64");
    }, exists: () => assert.fail("No discovery needed"), load: () => assert.fail("No setup needed") });
  assert.deepEqual(result, env); assert.notEqual(result, env);
  assert.equal(env.vslang, "1031", "Only the compiler probe switches language");
});

test("ordinary shells discover the requested target using the shared build target mapping", () => {
  for (const arch of ["x64", "arm64"]) {
    const env = { Path: "C:\\runtime", "ProgramFiles(x86)": "C:\\Program Files (x86)", PRIVATE_VALUE: "preserved" };
    const calls = [];
    const result = msvcEnvironment({ arch, env, exists: () => true,
      spawn: (command, args, options) => {
        calls.push(command);
        if (command === "cl.exe") {
          assert.equal(options.env.VSCMD_ARG_TGT_ARCH, arch); return banner(arch);
        }
        assert.match(command, /Microsoft Visual Studio\\Installer\\vswhere\.exe$/u);
        assert.deepEqual(args, ["-latest", "-products", "*", "-requires",
          arch === "arm64" ? "Microsoft.VisualStudio.Component.VC.Tools.ARM64" : "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]);
        return { status: 0, stdout: "C:\\Program Files\\Microsoft Visual Studio\\18\\BuildTools\r\n" };
      },
      load: (path, target, inherited) => {
        assert.equal(target, arch); assert.equal(inherited, env);
        assert.equal(path, "C:\\Program Files\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat");
        return { ...env, ...configured(arch) };
      } });
    assert.equal(result.PRIVATE_VALUE, "preserved"); assert.equal(result.VSCMD_ARG_TGT_ARCH, arch);
    assert.equal(calls.length, 2); assert.deepEqual(env, { Path: "C:\\runtime", "ProgramFiles(x86)": "C:\\Program Files (x86)", PRIVATE_VALUE: "preserved" });
  }
});

test("an inherited compiler for the wrong architecture is reconfigured", () => {
  let setups = 0;
  const env = configured("x64");
  const result = msvcEnvironment({ arch: "arm64", env, exists: () => true,
    spawn: (command, args, options) => command === "cl.exe" ? banner(options.env.VSCMD_ARG_TGT_ARCH) : { status: 0, stdout: "C:\\VS" },
    load: () => { setups++; return configured("arm64"); } });
  assert.equal(setups, 1); assert.equal(result.VSCMD_ARG_TGT_ARCH, "arm64");
  assert.equal(env.VSCMD_ARG_TGT_ARCH, "x64", "Parent process environment stays unchanged");
});

test("matching cl alone cannot reuse a developer environment declaring another target", () => {
  let setups = 0;
  const result = msvcEnvironment({ arch: "x64", env: configured("arm64"), exists: () => true,
    spawn: command => command === "cl.exe" ? banner("x64") : { status: 0, stdout: "C:\\VS" },
    load: () => { setups++; return configured("x64"); } });
  assert.equal(setups, 1); assert.equal(result.VSCMD_ARG_TGT_ARCH, "x64");
});

test("missing compiler, missing setup and wrong setup target fail before compiling the fixture", () => {
  const options = { arch: "x64", env: {}, load: () => assert.fail("Do not run unavailable setup") };
  assert.throws(() => msvcEnvironment({ ...options, exists: () => false, spawn: () => ({ error: { code: "ENOENT" } }) }), /Visual Studio C\+\+ tools for x64 were not found/);
  assert.throws(() => msvcEnvironment({ ...options, exists: () => false, spawn: () => ({ status: 0, stdout: "C:\\VS" }) }), /vcvarsall\.bat was not found/);
  assert.throws(() => msvcEnvironment({ ...options, exists: () => true,
    spawn: command => command === "cl.exe" ? banner("ARM64") : { status: 0, stdout: "C:\\VS" },
    load: () => configured("arm64") }), /did not provide a working x64 compiler/);
  assert.throws(() => msvcEnvironment({ arch: "ia32", spawn: () => assert.fail("Invalid target must not spawn") }), /Unsupported build architecture/);
});

test("environment merge replaces Path case aliases and preserves Unicode, equals and newlines", () => {
  const base = { PATH: "old", KEEP: "base", MULTILINE: "old" };
  const result = mergeWindowsEnvironment(base, { Path: "C:\\工具;C:\\Compiler", MULTILINE: "line1\nline2=x" });
  assert.deepEqual(result, { KEEP: "base", Path: "C:\\工具;C:\\Compiler", MULTILINE: "line1\nline2=x" });
  assert.deepEqual(base, { PATH: "old", KEEP: "base", MULTILINE: "old" });
  assert.throws(() => mergeWindowsEnvironment({}, { PATH: null }), /Invalid MSVC environment/);
});

test("setup uses a private batch and JSON capture, then removes only its scratch directory", () => {
  let directory;
  const env = { PATH: "old", KEEP: "unmodified", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const result = loadMsvcEnvironment("C:\\VS with spaces\\vcvarsall.bat", "arm64", env, {
    spawn(command, args, options) {
      directory = options.cwd;
      assert.equal(command, env.ComSpec);
      assert.deepEqual(args, ["/D", "/V:OFF", "/S", "/C", ".\\environment.cmd"]);
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 30_000);
      const batch = readFileSync(join(directory, "environment.cmd"), "utf8");
      assert.match(batch, /call "C:\\VS with spaces\\vcvarsall\.bat" x64_arm64 >nul\r\nif errorlevel 1 exit \/b %errorlevel%/u);
      assert.match(readFileSync(join(directory, "capture.cjs"), "utf8"), /JSON\.stringify\(process\.env\)/u);
      return { status: 0, stdout: JSON.stringify({ Path: "C:\\工具", INCLUDE: "include", LIB: "lib", MULTILINE: "a\nb=c" }) };
    },
  });
  assert.equal(result.Path, "C:\\工具"); assert.equal(result.PATH, undefined); assert.equal(result.KEEP, "unmodified");
  assert.equal(result.MULTILINE, "a\nb=c"); assert.equal(existsSync(directory), false);
});

test("setup failures clean scratch without exposing captured environment", () => {
  for (const response of [{ status: 7, stdout: "private-secret" }, { status: 0, stdout: "private-secret" }, { error: { code: "ETIMEDOUT" }, stdout: "private-secret" }]) {
    let directory;
    assert.throws(() => loadMsvcEnvironment("C:\\VS\\vcvarsall.bat", "x64", {}, {
      spawn: (command, args, options) => { directory = options.cwd; return response; },
    }), error => !error.message.includes("private-secret") && /MSVC environment setup/.test(error.message));
    assert.equal(existsSync(directory), false);
  }
  assert.throws(() => loadMsvcEnvironment("C:\\%INJECT%\\vcvarsall.bat", "x64", {}, { spawn: () => assert.fail("Unsafe batch path") }), /Unsupported MSVC setup executable path/);
});
