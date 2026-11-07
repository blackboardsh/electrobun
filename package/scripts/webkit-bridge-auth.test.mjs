import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { runInNewContext } from "node:vm";

describe("WebKitGTK bridge authentication", { skip: process.platform === "win32" }, () => {
	let directory;
	let script;
	let token;
	before(() => {
		directory = mkdtempSync(join(tmpdir(), "electrobun-bridge-auth-"));
		const binary = join(directory, "bridge-auth-test");
		const source = resolve(import.meta.dirname, "../src/native/linux/tests/bridge_auth_test.cpp");
		const compile = spawnSync(process.env.CXX ?? "c++", [
			"-std=c++17", "-Wall", "-Wextra", "-Werror", source, "-o", binary,
		], { encoding: "utf8", timeout: 60_000 });
		assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
		const result = spawnSync(binary, ["--script"], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.status, 0, result.error?.message ?? result.stderr);
		script = result.stdout;
		token = script.match(/\('([a-f0-9]{64})'\);$/)?.[1];
		assert.ok(token, "bootstrap contains an OS-generated 256-bit token");
	});
	after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

	function install(names = ["hostBridge", "bunBridge", "internalBridge", "eventBridge"], child = false) {
		const messages = [];
		const handlers = Object.fromEntries(names.map(name => [name, {
			postMessage(message) {
				assert.equal(this, handlers[name], "preserve the WebKit receiver");
				messages.push({ name, message });
			},
		}]));
		const window = { webkit: { messageHandlers: handlers } };
		window.top = child ? {} : window;
		runInNewContext(script, { window });
		return { window, handlers, messages };
	}

	it("authenticates all four bridges without changing their JSON payloads", () => {
		const { window, messages } = install();
		const payload = JSON.stringify({ type: "message", payload: "hello: 🐇" });
		for (const name of ["Host", "Bun", "Internal", "Event"]) {
			window[`__electrobun${name}Bridge`].postMessage(payload);
		}
		assert.deepEqual(messages, ["hostBridge", "bunBridge", "internalBridge", "eventBridge"].map(name => ({
			name, message: `${token}:${payload}`,
		})));
	});

	it("keeps the token out of globals and wrapper source and captures native methods", () => {
		const { window, handlers, messages } = install();
		assert.ok(!Object.values(window).includes(token));
		assert.ok(!window.__electrobunHostBridge.postMessage.toString().includes(token));
		handlers.hostBridge.postMessage = () => assert.fail("must use the captured native function");
		window.__electrobunHostBridge.postMessage("[]");
		assert.deepEqual(messages, [{ name: "hostBridge", message: `${token}:[]` }]);
	});

	it("does not authenticate raw messages or coerce non-string payloads", () => {
		const { window, handlers, messages } = install();
		for (const value of [null, {}, [], 0, undefined]) {
			window.__electrobunHostBridge.postMessage(value);
		}
		assert.equal(messages.length, 0);
		handlers.hostBridge.postMessage('{"type":"message"}');
		assert.equal(messages[0].message, '{"type":"message"}');
	});

	it("exposes only the event wrapper in sandboxed webviews", () => {
		const { window, messages } = install(["eventBridge"]);
		for (const name of ["Host", "Bun", "Internal"]) {
			assert.equal(window[`__electrobun${name}Bridge`], undefined);
		}
		window.__electrobunEventBridge.postMessage("{}");
		assert.equal(messages[0].message, `${token}:{}`);
	});

	it("does not install wrappers in a child frame", () => {
		const { window } = install(undefined, true);
		assert.equal(Object.keys(window).filter(name => name.startsWith("__electrobun")).length, 0);
	});

	it("installs working wrappers in a fresh document after navigation", () => {
		for (let navigation = 0; navigation < 2; ++navigation) {
			const { window, messages } = install();
			window.__electrobunHostBridge.postMessage("[]");
			assert.equal(messages[0].message, `${token}:[]`);
		}
	});
});
