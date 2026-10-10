import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const zig = process.env.ZIG_BINARY || join(packageRoot, "vendors", "zig", process.platform === "win32" ? "zig.exe" : "zig");

async function initializeSdkWakeup(versions, fd = 42) {
  // Exercise the actual SDK initialization without loading the desktop GUI or
  // its FFI library. A compatibility version must not select a polling loop.
  const source = (await readFile(join(packageRoot, "src", "sdks", "main", "proc", "native.ts"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("if (core) {\n\tconst wakeupReadFd");
  const end = source.indexOf("\nconst _ffiImpl =", start);
  assert.ok(start >= 0 && end > start, "SDK host message initialization must be present");
  const state = { polling: 0, drains: 0, destroyed: false, streamOptions: null, duplicated: 0, listeners: new Map() };
  const stream = {
    on(event, callback) { state.listeners.set(event, callback); return stream; },
    destroy() { state.destroyed = true; },
  };
  runInNewContext(source.slice(start, end).replace(": Socket | undefined", ""), {
    core: true,
    core_: { symbols: { getHostMessageWakeupReadFD: () => fd, duplicateHostMessageWakeupReadFD: () => { state.duplicated++; return fd + 1; } } },
    process: { versions },
    Socket: class { constructor(options) { state.streamOptions = { ...options }; return stream; } },
    closeSync() { throw new Error("unexpected raw descriptor close"); },
    startHostMessagePolling() { state.polling++; },
    drainQueuedHostMessages() { state.drains++; },
  });
  return state;
}

test("Cottontail uses readiness notifications even when it exposes a Bun compatibility version", async () => {
  const state = await initializeSdkWakeup({ cottontail: "0.7.0-canary.13", bun: "1.3.10" });
  assert.equal(state.polling, 0, "An idle Cottontail host must not install the 16 ms polling fallback");
  assert.deepEqual(state.streamOptions, { fd: 43, readable: true, writable: false });
  assert.equal(state.duplicated, 1, "The stream must own a duplicate, not the core descriptor");
  assert.equal(state.drains, 1, "Drain messages already queued before the readiness listener attached");
  state.listeners.get("data")();
  assert.equal(state.drains, 2, "Readiness must deliver subsequent messages without a timer");
  state.listeners.get("error")(new Error("readiness stream unavailable"));
  assert.equal(state.destroyed, true);
  assert.equal(state.polling, 1, "A failed readiness stream must retain the existing polling fallback");
});

test("Bun and hosts without a readiness descriptor retain the polling fallback", async () => {
  for (const [versions, fd] of [[{ bun: "1.3.10" }, 42], [{ cottontail: "0.7.0-canary.13", bun: "1.3.10" }, -1]]) {
    const state = await initializeSdkWakeup(versions, fd);
    assert.equal(state.polling, 1);
    assert.equal(state.streamOptions, null);
    assert.equal(state.duplicated, 0);
  }
});

const nativeFixture = `
// Only this temporary test library exports synthetic view registration.
export fn testInstallTransportWebview(webview_id: u32, key_byte: u8) bool {
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());
    webview_registry.put(webview_id, .{
        .ptr = null,
        .window_id = 1,
        .host_webview_id = null,
        .renderer = .native,
        .webview_event_handler = null,
        .event_bridge_handler = null,
        .internal_bridge_handler = null,
        .secret_key = @splat(key_byte),
        .socket_handle = null,
        .transport_ready = false,
        .plaintext_transport = false,
    }) catch return false;
    return true;
}
export fn testHostTransportPort() u32 {
    return host_transport_state.port;
}
`;

function runtimeBinary() {
  if (process.env.COTTONTAIL_BINARY) return process.env.COTTONTAIL_BINARY;
  const result = spawnSync(process.env.HUTCH_BINARY || "hutch", ["cottontail", "path"], { encoding: "utf8" });
  assert.equal(result.status, 0, `Locate Cottontail: ${result.stderr || result.error || ""}`);
  assert.ok(result.stdout.trim(), "Hutch must return a Cottontail executable");
  return result.stdout.trim();
}

function bunRuntimeBinary() {
  const result = spawnSync(process.env.HUTCH_BINARY || "hutch", ["-p", "process.execPath"], {
    encoding: "utf8", env: { ...process.env, HUTCH_RUNTIME: "bun" },
  });
  assert.equal(result.status, 0, `Locate Bun: ${result.stderr || result.error || ""}`);
  const binary = result.stdout.trim();
  assert.ok(binary, "Hutch must return a Bun executable");
  const identity = spawnSync(binary, ["-e", "if (!process.versions.bun || process.versions.cottontail) process.exit(1)"], { encoding: "utf8" });
  assert.equal(identity.status, 0, "The default transport test must run real Bun");
  return binary;
}

async function buildFixture(directory) {
  assert.ok(existsSync(zig), "Install the repository Zig toolchain or set ZIG_BINARY");
  const source = join(directory, "core.zig");
  await writeFile(source, await readFile(join(packageRoot, "src", "core", "main.zig"), "utf8") + nativeFixture);
  const extension = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const library = join(directory, `libCoreTransportTest.${extension}`);
  // Windows ARM64 uses an emulated x64 Zig compiler. The fixture must match
  // the native runtime that loads it, independently of the compiler's host.
  const target = process.platform === "win32"
    ? ["-target", process.arch === "arm64" ? "aarch64-windows-gnu" : "x86_64-windows-gnu"]
    : [];
  const child = spawn(zig, ["build-lib", source, ...target, "-dynamic", "-lc", "-O", "Debug", `-femit-bin=${library}`], { stdio: ["ignore", "pipe", "pipe"], timeout: 540_000 });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Native core fixture build failed (${code}): ${output}`)));
  });
  return library;
}

let fixtureDirectory;
let fixtureLibrary;
before(async () => {
  // Cold cross-compilation can outlast the runtime deadline, especially with
  // the x64 Zig compiler under ARM64 emulation. Compile once with its own bound;
  // each transport test below retains its independent 90-second deadline.
  fixtureDirectory = await mkdtemp(join(tmpdir(), "electrobun-core-transport-"));
  fixtureLibrary = await buildFixture(fixtureDirectory);
}, { timeout: 600_000 });
after(async () => {
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function startPeer(binary, library, keyByte, port = 0, readiness = false) {
  const child = spawn(binary, [join(packageRoot, "scripts", "fixtures", "core-host-transport-peer.ts"), library, String(keyByte), String(port), readiness ? "readiness" : "poll"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let nextId = 0;
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimeout = setTimeout(() => readyReject(new Error(`Core peer did not start: ${stderr}`)), 10_000);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (typeof message.started === "boolean") {
        clearTimeout(readyTimeout);
        readyResolve(message);
      } else {
        const request = pending.get(message.id);
        if (request) { pending.delete(message.id); clearTimeout(request.timer); request.resolve(message); }
      }
    } catch (error) { readyReject(error); }
  });
  let finished = false;
  const exited = new Promise((resolve) => {
    const settle = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(readyTimeout);
      readyReject(error);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
      resolve();
    };
    child.once("exit", (code, signal) => settle(new Error(`Core peer exited (${code ?? signal}): ${stderr}`)));
    child.once("error", settle);
  });
  return {
    ready,
    drain(closeWatcher = false) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Core peer drain timed out")); }, 3_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ type: "drain", id, closeWatcher })}\n`);
      });
    },
    async stop() {
      if (!finished) {
        child.kill("SIGTERM");
        await Promise.race([exited, delay(1_000, undefined, { ref: false })]);
      }
      if (!finished) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(1_000, undefined, { ref: false })]);
      }
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!finished) throw new Error("Core test peer did not exit after SIGKILL");
    },
  };
}

async function connect(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket?webviewId=2`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native WebSocket handshake timed out")), 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Native WebSocket handshake failed")); }, { once: true });
    });
    return socket;
  } catch (error) { socket.close(); throw error; }
}

function encryptedRequest(keyByte, id, owner) {
  const message = { type: "request", id, method: "identity", params: { owner } };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, keyByte), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(message)), cipher.final()]);
  return JSON.stringify({ encryptedData: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
}

test("readiness survives idle periods and closing its stream preserves core draining", { timeout: 90_000, skip: process.platform === "win32" }, async () => {
  let peer, socket;
  try {
    const library = fixtureLibrary;
    peer = startPeer(runtimeBinary(), library, 17, 0, true);
    const ready = await peer.ready;
    socket = await connect(ready.port);
    for (let id = 1; id <= 3; id++) {
      await delay(100); // Empty nonblocking pipe must not fail or stop watching.
      socket.send(encryptedRequest(17, id, "readiness"));
      let result;
      const deadline = Date.now() + 3000;
      do { await delay(20); result = await peer.drain(); } while (result.messages.length === 0 && Date.now() < deadline);
      assert.equal(result.messages[0]?.message.id, id);
      assert.ok(result.wakeups >= id, "every separated notification must reach the readiness listener");
    }
    await peer.drain(true); // Also asserts the core-owned descriptor is still valid.
    socket.send(encryptedRequest(17, 4, "fallback"));
    await delay(100);
    assert.equal((await peer.drain()).messages[0]?.message.id, 4, "fallback can drain after the stream closes");
  } finally {
    socket?.close();
    await peer?.stop();
  }
});

for (const [runtime, resolveRuntime] of [["Bun", bunRuntimeBinary], ["Cottontail", runtimeBinary]]) {
test(`${runtime}: two native cores own distinct loopback ports and decrypt only their own webview RPC`, { timeout: 90_000 }, async () => {
  const peers = [];
  const sockets = [];
  try {
    const library = fixtureLibrary;
    const binary = resolveRuntime();
    const a = startPeer(binary, library, 17);
    peers.push(a);
    const readyA = await a.ready;
    assert.equal(readyA.started, true);
    const b = startPeer(binary, library, 34);
    peers.push(b);
    const readyB = await b.ready;
    assert.equal(readyB.started, true);
    assert.notEqual(readyA.port, readyB.port, "Independent hosts must not share a listener even though both have webview ID 2");

    const occupied = startPeer(binary, library, 51, readyA.port);
    peers.push(occupied);
    assert.deepEqual(await occupied.ready, { started: false }, "An explicitly occupied port must fail instead of sharing another host's connections");

    for (const [peer, port, key, owner] of [[a, readyA.port, 17, "A"], [b, readyB.port, 34, "B"]]) {
      const socket = await connect(port);
      sockets.push(socket);
      for (let id = 1; id <= 8; id++) socket.send(encryptedRequest(key, id, owner));
      const received = [];
      const deadline = Date.now() + 3_000;
      let debug;
      while (received.length < 8 && Date.now() < deadline) {
        const response = await peer.drain();
        received.push(...response.messages);
        debug = response.debug;
        if (received.length < 8) await delay(20);
      }
      assert.deepEqual(received, Array.from({ length: 8 }, (_, index) => ({
        webviewId: 2, message: { type: "request", id: index + 1, method: "identity", params: { owner } },
      })), `Host ${owner} must own and decrypt every request addressed to its port`);
      assert.equal(debug.decryptErrors, 0);
      assert.equal(debug.decryptOk, 8);
      const other = await (peer === a ? b : a).drain();
      assert.deepEqual(other.messages, [], "Requests must not enter the other process's native queue");
    }
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(peers.map((peer) => peer.stop()));
  }
});

}
