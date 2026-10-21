import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { startBunnyDiagnostics } from "./bunny-diagnostics.mjs";

function fixture(t, { module = false, missing } = {}) {
	const root = mkdtempSync(join(tmpdir(), "electrobun-bunny-diagnostics-"));
	const cleanup = [];
	t.after(async () => {
		try {
			for (const close of cleanup) await close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	const project = join(root, "bunny");
	const output = join(root, "diagnostics");
	const html = join(project, "src", "mainview", "index.html");
	const renderer = join(project, "src", "mainview", "index.ts");
	const host = join(project, "src", "bun", "index.ts");
	const originalScript = `<script${module ? ' type="module"' : ""} src="views://mainview/index.js"></script>`;
	const originalHtml = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Bunny</title></head>
  <body><div id="bunny">Original Bunny scene</div>${originalScript}</body>
</html>
`;
	const originalHost = `import { BrowserWindow } from "electrobun/main";
const win = new BrowserWindow({ title: "Bunny", url: "views://mainview/index.html" });
win.setAlwaysOnTop(true);
`;
	const originalRenderer = `import { Electroview } from "electrobun/view";
const bunny = document.getElementById("bunny");
bunny?.addEventListener("click", () => console.log("original bunny click"));
`;
	const sources = [
		{ name: "html", path: html, original: originalHtml },
		{ name: "renderer", path: renderer, original: originalRenderer },
		{ name: "host", path: host, original: originalHost },
	];
	for (const { name, path, original } of sources) {
		if (missing === name) continue;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, original);
	}
	return { project, output, html, renderer, host, sources, cleanup, originalScript, originalHtml, originalRenderer, originalHost };
}

function inlineScripts(html) {
	return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
		.filter(match => !/\bsrc\s*=/i.test(match[1]))
		.map(match => ({ code: match[2], index: match.index }));
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

async function start(t, fixture, { rendererStarted = true } = {}) {
	const diagnostics = await startBunnyDiagnostics({ project: fixture.project, output: fixture.output });
	fixture.cleanup.push(() => diagnostics.close());
	if (rendererStarted) {
		const response = await fetch(diagnostics.metadata.endpoint, {
			method: "POST",
			body: JSON.stringify({ source: "renderer", event: "installed" }),
		});
		assert.ok(response.ok);
	}
	return diagnostics;
}

for (const module of [false, true]) {
	test(`diagnostics run before the original ${module ? "module" : "classic"} renderer and preserve app code`, async t => {
		const f = fixture(t, { module });
		const { metadata } = await start(t, f);
		const html = readFileSync(f.html, "utf8");
		assert.equal(html.split(f.originalScript).length - 1, 1, "the original renderer must remain exactly once");
		assert.ok(html.includes('<div id="bunny">Original Bunny scene</div>'));
		assert.ok(html.includes("<title>Bunny</title>"));
		const scripts = inlineScripts(html);
		assert.ok(scripts.length > 0, "renderer diagnostics must be installed inline before app startup");
		for (const script of scripts) {
			assert.ok(script.code.trim().length > 0);
			assert.ok(script.index < html.indexOf(f.originalScript), "diagnostics must precede the original renderer");
			assert.ok(script.index < html.indexOf("</head>"), "early diagnostics must be installed in the document head");
		}
		for (const { path, original } of f.sources.filter(source => source.name !== "html")) {
			const content = readFileSync(path, "utf8");
			assert.ok(content.endsWith(original), "original code must remain intact after diagnostics");
			assert.ok(content.length > original.length, "diagnostics must be added before app startup");
		}
		assert.equal(metadata.sourceFiles.length, f.sources.length);
		for (const source of f.sources) {
			const recorded = metadata.sourceFiles.find(file => resolve(f.project, file.path) === source.path);
			assert.ok(recorded, `metadata must identify ${source.name}`);
			assert.equal(recorded.originalSha256, sha256(source.original));
			assert.equal(recorded.instrumentedSha256, sha256(readFileSync(source.path)));
		}
	});
}

test("a second instrumentation rejects the stale endpoint without altering any source", async t => {
	const f = fixture(t);
	await start(t, f);
	const contents = f.sources.map(source => readFileSync(source.path, "utf8"));
	await assert.rejects(() => start(t, f), /already.*installed/i);
	f.sources.forEach((source, index) => assert.equal(readFileSync(source.path, "utf8"), contents[index]));
});

for (const missing of ["html", "renderer", "host"]) {
	test(`a missing ${missing} source fails before mutating other sources`, async t => {
		const f = fixture(t, { missing });
		await assert.rejects(() => start(t, f), /ENOENT/);
		for (const source of f.sources) {
			if (source.name === missing) assert.equal(existsSync(source.path), false);
			else assert.equal(readFileSync(source.path, "utf8"), source.original);
		}
	});
}

test("HTML without a head is rejected before any generated source is changed", async t => {
	const f = fixture(t);
	const invalidHtml = "<html><body>Missing head</body></html>\n";
	writeFileSync(f.html, invalidHtml);
	await assert.rejects(() => start(t, f), /head/i);
	for (const source of f.sources) {
		assert.equal(readFileSync(source.path, "utf8"), source.name === "html" ? invalidHtml : source.original);
	}
});

test("local telemetry accepts browser preflight and writes structured events", async t => {
	const f = fixture(t);
	const { metadata } = await start(t, f);
	const endpoint = new URL(metadata.endpoint);
	assert.equal(endpoint.protocol, "http:");
	assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname));
	assert.notEqual(endpoint.port, "0");
	const preflight = await fetch(endpoint, {
		method: "OPTIONS",
		headers: { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
	});
	assert.ok(preflight.ok);
	assert.ok(["*", "null"].includes(preflight.headers.get("access-control-allow-origin")));
	const marker = "bunny-telemetry-test-event";
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "null" },
		body: JSON.stringify({ kind: marker, detail: { message: "renderer reached diagnostics" } }),
	});
	assert.ok(response.ok);
	assert.ok(["*", "null"].includes(response.headers.get("access-control-allow-origin")));
	const lines = readFileSync(metadata.logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.ok(lines.some(line => JSON.stringify(line).includes(marker)));
});

test("early renderer diagnostics report errors and null WebGL before Electrobun or RPC exists", async t => {
	const f = fixture(t);
	const { metadata } = await start(t, f, { rendererStarted: false });
	const scripts = inlineScripts(readFileSync(f.html, "utf8"));
	const listeners = new Map();
	const requests = [];
	const contextCalls = [];
	class Canvas {
		className = "spark-canvas";
		getContext(...args) {
			contextCalls.push({ canvas: this, args });
			return null;
		}
	}
	const browser = {
		HTMLCanvasElement: Canvas,
		location: { href: "views://mainview/index.html" },
		navigator: { userAgent: "Bunny diagnostic test renderer" },
		console: { log() {} },
		addEventListener(name, callback) { listeners.set(name, callback); },
		requestAnimationFrame() { return 1; },
		setInterval() { return 1; },
		clearInterval() {},
		setTimeout,
		clearTimeout,
		AbortController,
		AbortSignal,
		fetch(url, options) {
			const request = fetch(url, options);
			requests.push(request);
			return request;
		},
	};
	browser.window = browser;
	const context = vm.createContext(browser);
	for (const script of scripts) vm.runInContext(script.code, context, { timeout: 1000 });
	assert.equal(browser.__electrobun, undefined, "the probe must work before the application bridge exists");
	const canvas = new Canvas();
	const options = { alpha: true };
	assert.equal(canvas.getContext("webgl2", options), null, "diagnostics must preserve the original context result");
	assert.equal(contextCalls.length, 1);
	assert.equal(contextCalls[0].canvas, canvas);
	assert.deepEqual(contextCalls[0].args, ["webgl2", options]);
	assert.ok(listeners.has("error"), "the probe must listen before app code can throw");
	const message = "Bunny renderer failed before RPC initialization";
	listeners.get("error")({ message, filename: "views://mainview/index.js", lineno: 42, colno: 7, error: new Error(message) });
	await Promise.all(requests);
	const payloads = readFileSync(metadata.logPath, "utf8").trim().split("\n").map(line => JSON.parse(line).payload);
	assert.ok(payloads.some(payload => payload.source === "renderer" && payload.event === "installed"));
	assert.ok(payloads.some(payload => payload.source === "renderer" && payload.message === message));
	assert.ok(payloads.some(payload => payload.source === "renderer" && payload.type === "webgl2" && payload.available === false));
});

test("closing without renderer startup rejects and still shuts down the telemetry server", async t => {
	const f = fixture(t);
	const { metadata, close } = await startBunnyDiagnostics({ project: f.project, output: f.output });
	await assert.rejects(close(), /renderer.*(?:installed|start)/i);
	assert.equal(metadata.summary.rendererStarted, false);
	await assert.rejects(fetch(metadata.endpoint, { method: "POST", body: "{}" }));
	const persisted = JSON.parse(readFileSync(join(f.output, "bunny-diagnostics-metadata.json"), "utf8"));
	assert.equal(persisted.summary.rendererStarted, false);
});
