import assert from "node:assert/strict";
import test from "node:test";
import { ensureWebview2Runtime, installWebview2Runtime } from "./webview2-runtime.mjs";

const available = { status: 0, output: "WebView2 runtime: 154.0.4258.62\n" };
const missing = { status: 42, output: "WebView2 runtime is not installed" };
const signature = { status: "Valid", subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, C=US" };

test("an available runtime never downloads or installs, even with CI opt-in", async () => {
  for (const allowInstall of [false, true]) {
    const result = await ensureWebview2Runtime({
      probe: async () => available, allowInstall,
      install: async () => { throw new Error("must not install"); },
    });
    assert.deepEqual(result, { installed: false, version: available.output.trim() });
  }
});

test("a missing local runtime fails without authorizing an installation", async () => {
  let installs = 0;
  await assert.rejects(ensureWebview2Runtime({ probe: () => missing, install: () => { installs++; } }), /--install-missing-runtime/);
  assert.equal(installs, 0);
});

test("CI installs once only for the explicit missing result and probes again", async () => {
  const calls = [];
  let installed = false;
  const result = await ensureWebview2Runtime({
    probe: () => { calls.push("probe"); return installed ? available : missing; }, allowInstall: true,
    install: () => { calls.push("install"); installed = true; },
  });
  assert.deepEqual(calls, ["probe", "install", "probe"]);
  assert.equal(result.installed, true);
});

test("probe failures do not authorize installation", async () => {
  for (const status of [1, null, 5]) {
    let installs = 0;
    await assert.rejects(ensureWebview2Runtime({
      probe: () => ({ status, output: "probe failure" }), allowInstall: true,
      install: () => { installs++; },
    }), /runtime probe failed/);
    assert.equal(installs, 0);
  }
});

test("installer failure and unavailable post-install runtime cannot pass", async () => {
  let probes = 0;
  await assert.rejects(ensureWebview2Runtime({
    probe: () => { probes++; return missing; }, allowInstall: true,
    install: () => { throw new Error("installer failed"); },
  }), /installer failed/);
  assert.equal(probes, 1);
  await assert.rejects(ensureWebview2Runtime({
    probe: () => missing, allowInstall: true, install: () => {},
  }), /still unavailable after installer success/);
});

test("download and valid Microsoft signature must precede the silent installer", async () => {
  const calls = [];
  await installWebview2Runtime({
    installerPath: "owned/installer.exe",
    download: (path, timeout) => { calls.push(["download", path]); assert.ok(timeout <= 60_000); },
    readSignature: (path, timeout) => { calls.push(["signature", path]); assert.ok(timeout <= 30_000); return signature; },
    execute: (path, args, timeout) => { calls.push(["execute", path, args]); assert.ok(timeout <= 240_000); return { status: 0, output: "" }; },
  });
  assert.deepEqual(calls, [
    ["download", "owned/installer.exe"], ["signature", "owned/installer.exe"],
    ["execute", "owned/installer.exe", ["/silent", "/install"]],
  ]);
});

test("invalid, missing and non-Microsoft signatures never execute the bootstrapper", async () => {
  for (const next of [null, {}, { ...signature, status: "NotSigned" },
    { ...signature, status: "HashMismatch" }, { ...signature, subject: "O=Not Microsoft Corporation" },
    { ...signature, subject: "O=Microsoft Corporation Fake" }]) {
    let executions = 0;
    await assert.rejects(installWebview2Runtime({
      installerPath: "owned/installer.exe", download: () => {}, readSignature: () => next,
      execute: () => { executions++; return { status: 0 }; },
    }), /valid Microsoft Authenticode signature/);
    assert.equal(executions, 0);
  }
});

test("download errors and installer errors fail the prerequisite", async () => {
  await assert.rejects(installWebview2Runtime({
    installerPath: "owned/installer.exe", download: () => { throw new Error("download timeout"); },
    readSignature: () => { throw new Error("must not verify"); }, execute: () => { throw new Error("must not execute"); },
  }), /download timeout/);
  await assert.rejects(installWebview2Runtime({
    installerPath: "owned/installer.exe", download: () => {}, readSignature: () => signature,
    execute: () => ({ status: 7, output: "installer denied" }),
  }), /installer failed \(7\): installer denied/);
});

test("all provisioning phases share a bounded five-minute deadline", async () => {
  let clock = 0;
  let executed = false;
  await assert.rejects(installWebview2Runtime({
    installerPath: "owned/installer.exe", now: () => clock,
    download: () => { clock = 300_000; },
    readSignature: () => signature,
    execute: () => { executed = true; return { status: 0 }; },
  }), /exceeded five minutes/);
  assert.equal(executed, false);
  clock = 0;
  await assert.rejects(installWebview2Runtime({
    installerPath: "owned/installer.exe", now: () => clock,
    download: () => { clock += 50_000; }, readSignature: () => { clock += 20_000; return signature; },
    execute: (_path, _args, timeout) => { assert.equal(timeout, 230_000); clock += timeout + 1; return { status: 0 }; },
  }), /exceeded five minutes/);
});
