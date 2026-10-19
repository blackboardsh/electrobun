import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { resolveBuildArch, windowsBuildTarget } from "../src/shared/windows-build-target.ts";

const value = (env, name) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())] ?? "";

// Windows treats environment names case-insensitively. Passing both Path and
// PATH to Node children can silently select the old compiler search path.
export function mergeWindowsEnvironment(base, additions) {
  const result = { ...base };
  for (const [name, content] of Object.entries(additions)) {
    if (typeof content !== "string") throw new Error("Invalid MSVC environment value");
    for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete result[existing];
    }
    result[name] = content;
  }
  return result;
}

function batchPath(path) {
  // These values are executable paths from the installation, not shell code.
  // CALL expands percent expressions twice, even inside quoted paths.
  if (/["%\r\n\0]/u.test(path)) throw new Error("Unsupported MSVC setup executable path");
  return `"${path}"`;
}

export function loadMsvcEnvironment(vcvars, arch, env, { spawn = spawnSync } = {}) {
  const target = windowsBuildTarget(resolveBuildArch(arch));
  const setup = batchPath(vcvars), runtime = batchPath(process.execPath);
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "electrobun-msvc-env-"));
  try {
    // Use JSON rather than SET output: environment values can contain Unicode,
    // equals signs and newlines. Never log the captured environment on failure.
    writeFileSync(join(directory, "capture.cjs"), "process.stdout.write(JSON.stringify(process.env));\n");
    writeFileSync(join(directory, "environment.cmd"), [
      "@echo off", "chcp 65001 >nul", `call ${setup} ${target.vcvars} >nul`,
      "if errorlevel 1 exit /b %errorlevel%", `${runtime} capture.cjs`,
    ].join("\r\n") + "\r\n");
    const result = spawn(value(env, "ComSpec") || win32.join(value(env, "SystemRoot") || "C:\\Windows", "System32", "cmd.exe"),
      ["/D", "/V:OFF", "/S", "/C", ".\\environment.cmd"],
      { cwd: directory, env: { ...env }, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`MSVC environment setup failed (${result.error?.code ?? result.status ?? "unknown"})`);
    let captured;
    try { captured = JSON.parse(String(result.stdout || "")); }
    catch { throw new Error("MSVC environment setup did not return valid JSON"); }
    if (!captured || Array.isArray(captured) || typeof captured !== "object") throw new Error("Invalid MSVC environment result");
    return mergeWindowsEnvironment(env, captured);
  } finally {
    const cleanup = resolve(directory);
    if (dirname(cleanup).toLowerCase() !== temporaryRoot.toLowerCase()
      || !basename(cleanup).startsWith("electrobun-msvc-env-")
      || lstatSync(cleanup).isSymbolicLink()
      || realpathSync(cleanup).toLowerCase() !== cleanup.toLowerCase()) {
      throw new Error("MSVC environment cleanup escaped its temporary directory");
    }
    rmSync(cleanup, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

export function msvcEnvironment({ arch = process.arch, env = process.env,
  spawn = spawnSync, exists = existsSync, load = loadMsvcEnvironment } = {}) {
  const target = windowsBuildTarget(resolveBuildArch(arch));
  const usable = candidate => {
    const declared = value(candidate, "VSCMD_ARG_TGT_ARCH");
    if (declared && declared.toLowerCase() !== arch) return false;
    if (!value(candidate, "INCLUDE") || !value(candidate, "LIB")) return false;
    // Localize only this machine-readable probe; preserve the caller's language
    // for the actual build and its diagnostics.
    const probe = spawn("cl.exe", ["/Bv"], { env: mergeWindowsEnvironment(candidate, { VSLANG: "1033" }), encoding: "utf8", windowsHide: true, timeout: 10_000 });
    // cl /Bv without a source may exit nonzero; its banner still identifies
    // the compiler's target. A wrong-target developer shell needs reloading.
    const actual = `${probe.stdout || ""}\n${probe.stderr || ""}`.match(/Compiler Version [^\r\n]+ for (x64|ARM64)\b/iu)?.[1]?.toLowerCase();
    return !probe.error && actual === arch;
  };
  if (usable(env)) return { ...env };
  const locator = win32.join(value(env, "ProgramFiles(x86)") || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const found = spawn(exists(locator) ? locator : "vswhere.exe", ["-latest", "-products", "*", "-requires", target.vcComponent, "-property", "installationPath"],
    { env: { ...env }, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const installation = String(found.stdout || "").trim();
  if (found.error || found.status !== 0 || !installation || !win32.isAbsolute(installation) || /[\r\n]/u.test(installation)) {
    throw new Error(`Visual Studio C++ tools for ${arch} were not found; install the ${target.vcComponent} component`);
  }
  const vcvars = win32.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  if (!exists(vcvars)) throw new Error(`Visual Studio vcvarsall.bat was not found for ${arch}`);
  const configured = load(vcvars, arch, env, { spawn });
  if (!usable(configured)) throw new Error(`MSVC setup did not provide a working ${arch} compiler, INCLUDE and LIB`);
  return configured;
}
