import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const zig = process.env.ZIG_BINARY || join(packageRoot, "vendors", "zig", process.platform === "win32" ? "zig.exe" : "zig");
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
        .secret_key = [_]u8{key_byte} ** Aes256Gcm.key_length,
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

async function buildFixture(directory) {
  assert.ok(existsSync(zig), "Install the repository Zig toolchain or set ZIG_BINARY");
  const source = join(directory, "core.zig");
  await writeFile(source, await readFile(join(packageRoot, "src", "core", "main.zig"), "utf8") + nativeFixture);
  const extension = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
  const library = join(directory, `libCoreTransportTest.${extension}`);
  const child = spawn(zig, ["build-lib", source, "-dynamic", "-lc", "-O", "Debug", `-femit-bin=${library}`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Native core fixture build failed (${code}): ${output}`)));
  });
  return library;
}

function startPeer(binary, library, keyByte, port = 0) {
  const child = spawn(binary, [join(packageRoot, "scripts", "fixtures", "core-host-transport-peer.ts"), library, String(keyByte), String(port)], { stdio: ["pipe", "pipe", "pipe"] });
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
    drain() {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Core peer drain timed out")); }, 3_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ type: "drain", id })}\n`);
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

test("two native cores own distinct loopback ports and decrypt only their own webview RPC", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "electrobun-core-transport-"));
  const peers = [];
  const sockets = [];
  try {
    const library = await buildFixture(directory);
    const binary = runtimeBinary();
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
    // Windows can retain the just-unloaded test DLL briefly after every peer
    // exits. Let fs.rm retry transient EPERM/EBUSY failures before failing the
    // test; these options are harmless on platforms that unlink immediately.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
