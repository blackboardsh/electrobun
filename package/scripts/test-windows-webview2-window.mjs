import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsBinaryArchitecture } from "./windows-binary-architecture.mjs";
import { ensureWebview2Runtime, installWebview2Runtime } from "./webview2-runtime.mjs";

assert.ok(process.argv.slice(2).every((argument) => argument === "--install-missing-runtime"), "Unknown WebView2 test option");

if (process.platform !== "win32") {
  console.log("Windows WebView2 controller ownership test skipped on this platform.");
} else {
  assert.ok(["arm64", "x64"].includes(process.arch), "Use a supported native Windows architecture");
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "electrobun-webview2-window-"));
  const executable = join(directory, "webview2-window.exe");
  const sdk = join(packageRoot, "vendors/webview2/Microsoft.Web.WebView2/build/native");
  function run(command, args, timeout = 90_000) {
    const result = spawnSync(command, args, {
      cwd: directory, windowsHide: true, encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
    });
    if (result.error?.code === "ENOENT" && command === "cl.exe") {
      throw new Error(`Run this test in an MSVC developer environment targeting ${process.arch}.`, { cause: result.error });
    }
    if (result.error) throw result.error;
    return { status: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
  }
  try {
    const compile = run("cl.exe", [
      "/nologo", "/std:c++17", "/EHsc", "/O2", "/MT", "/utf-8", "/DNOMINMAX",
      `/I${join(sdk, "include")}`,
      join(packageRoot, "src/native/shared/webview2_window_test.cpp"),
      `/Fo${join(directory, "webview2-window.obj")}`, `/Fe${executable}`,
      "/link", join(sdk, process.arch, "WebView2LoaderStatic.lib"),
      "user32.lib", "ole32.lib", "version.lib", "shlwapi.lib", "advapi32.lib",
    ], 180_000);
    assert.equal(compile.status, 0, `WebView2 controller test compilation failed:\n${compile.output}`);
    assertWindowsBinaryArchitecture(executable, process.arch);
    const provision = (operation, installerPath, timeout) => {
      const result = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", join(packageRoot, "scripts/webview2-runtime.ps1"), "-Operation", operation, "-InstallerPath", installerPath], timeout);
      assert.equal(result.status, 0, `WebView2 bootstrapper ${operation} failed:\n${result.output}`);
      return result.output;
    };
    const runtime = await ensureWebview2Runtime({
      probe: () => run(executable, ["--check-runtime"], 15_000),
      allowInstall: process.argv.includes("--install-missing-runtime"),
      install: () => installWebview2Runtime({
        installerPath: join(directory, "MicrosoftEdgeWebview2Setup.exe"),
        download: (path, timeout) => provision("Download", path, timeout),
        readSignature: (path, timeout) => JSON.parse(provision("Signature", path, timeout)),
        execute: run,
      }),
    });
    console.log(`${runtime.version}${runtime.installed ? " (installed for CI)" : " (already available)"}`);
    // Both processes use private profiles and hidden native windows. They load
    // the installed WebView2 runtime, never an installed application's profile.
    const negative = run(executable, [join(directory, "negative-profile"), "--legacy-coordinate-control"]);
    assert.equal(negative.status, 1, `Old coordinate lookup must fail:\n${negative.output}`);
    assert.match(negative.output, /FAIL: zero-size target must be exact top sibling/,
      `Negative control must reach the ownership regression. A working installed WebView2 runtime is required; setup failures cannot skip this gate:\n${negative.output}`);
    const fixed = run(executable, [join(directory, "fixed-profile")]);
    assert.equal(fixed.status, 0, `Real WebView2 controller ownership test failed:\n${fixed.output}`);
    assert.match(fixed.output, /PASS: real WebView2 hidden zero-size and overlapping controller ownership/);
    assert.match(fixed.output, /PASS: destroy and recreate owner lifetime/);
    console.log(`Windows ${process.arch}: real WebView2 controller ownership, z-order, passthrough and destruction/recreation passed; old coordinate lookup failed as expected.`);
  } finally {
    // Delete only this invocation's mkdtemp directory, after both owned native
    // processes have exited. Browser teardown can briefly retain profile files.
    const cleanupTarget = resolve(directory);
    assert.equal(dirname(cleanupTarget).toLowerCase(), temporaryRoot.toLowerCase(), "Cleanup must stay within the selected temporary root");
    assert.ok(basename(cleanupTarget).startsWith("electrobun-webview2-window-"), "Cleanup must target this fixture's directory");
    assert.ok(!lstatSync(cleanupTarget).isSymbolicLink(), "Fixture cleanup target must not be a link");
    assert.equal(realpathSync(cleanupTarget).toLowerCase(), cleanupTarget.toLowerCase(), "Fixture cleanup target must not be redirected");
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
