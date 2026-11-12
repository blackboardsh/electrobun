import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { selectHutchBinary } from "./hutch-launcher.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let browser;
let server;
let scratch;
let origin;

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "electrobun-warren-dom-"));
	// Use the same Hutch-selected Bun compiler as the SDK; no additional bundler.
	await promisify(execFile)(selectHutchBinary(), ["-e", `
		const result = await Bun.build({
			entrypoints: [process.env.ELECTROBUN_WARREN_FIXTURE],
			outdir: process.env.ELECTROBUN_WARREN_OUTPUT,
			naming: "fixture.js", target: "browser", format: "esm",
		});
		if (!result.success) { console.error(result.logs); process.exit(1); }
	`], {
		cwd: packageRoot,
		env: { ...process.env, HUTCH_RUNTIME: "bun", HUTCH_NO_UPDATE_CHECK: "1",
			ELECTROBUN_WARREN_FIXTURE: join(packageRoot, "scripts/fixtures/warren-dom.ts"),
			ELECTROBUN_WARREN_OUTPUT: scratch },
		timeout: 60_000,
	});
	const script = await readFile(join(scratch, "fixture.js"));
	server = createServer((request, response) => {
		if (request.url === "/fixture.js") response.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
		else response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>');
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const { chromium } = createRequire(import.meta.url)(process.env.ELECTROBUN_TEST_PLAYWRIGHT || "playwright");
	browser = await chromium.launch({ headless: true,
		...(process.env.ELECTROBUN_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.ELECTROBUN_TEST_BROWSER_EXECUTABLE } : {}) });
}, { timeout: 90_000 });

after(async () => {
	await browser?.close();
	if (server?.listening) await new Promise(resolve => server.close(resolve));
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function openFixture(t) {
	const page = await browser.newPage();
	t.after(() => page.close());
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	t.after(() => assert.deepEqual(errors, [], "The renderer must not throw browser errors"));
	await page.goto(origin);
	await page.waitForFunction(() => Boolean(window.warrenFixture));
	return page;
}

test("unchanged polling retains disclosure, draft, focus, selected text, and DOM nodes", async t => {
	const page = await openFixture(t);
	const result = await page.evaluate(() => {
		const release = document.querySelector("#release");
		const instructions = document.querySelector("#instructions");
		const publish = document.querySelector("#publish");
		const draft = document.querySelector("#draft");
		const command = document.querySelector("#command");
		const text = [...command.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
		instructions.open = true;
		draft.value = "My unsaved draft";
		publish.focus();
		const selection = getSelection();
		const range = document.createRange();
		range.setStart(text, 6); range.setEnd(text, 15);
		selection.removeAllRanges(); selection.addRange(range);
		const selected = selection.toString();
		const observer = new MutationObserver(() => {});
		observer.observe(release, { subtree: true, childList: true, characterData: true });
		for (let attempt = 0; attempt < 3; attempt++) window.warrenFixture.poll();
		const mutations = observer.takeRecords(); observer.disconnect();
		return {
			releaseRetained: release === document.querySelector("#release"),
			disclosureRetained: instructions === document.querySelector("#instructions"),
			disclosureOpen: document.querySelector("#instructions").open,
			draft: document.querySelector("#draft").value,
			focused: document.activeElement === publish && publish.isConnected,
			textRetained: text === [...document.querySelector("#command").childNodes].find(node => node.nodeType === Node.TEXT_NODE),
			selectedBefore: selected, selectedAfter: selection.toString(),
			selectionOffsets: [selection.anchorOffset, selection.focusOffset],
			mutations: mutations.map(mutation => mutation.type),
			lifecycle: { ...window.warrenFixture.lifecycle },
		};
	});
	assert.deepEqual(result, {
		releaseRetained: true, disclosureRetained: true, disclosureOpen: true,
		draft: "My unsaved draft", focused: true, textRetained: true,
		selectedBefore: "electrobu", selectedAfter: "electrobu", selectionOffsets: [6, 15],
		mutations: [], lifecycle: { mounted: 1, disposed: 0, fallbackMounted: 0 },
	});
});

test("changed data updates retained content and actual branch changes mount and dispose", async t => {
	const page = await openFixture(t);
	const result = await page.evaluate(() => {
		const release = document.querySelector("#release");
		const command = document.querySelector("#command");
		const text = [...command.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
		const instructions = document.querySelector("#instructions");
		instructions.open = true;
		window.warrenFixture.update({ command: "hutch electrobun publish --release=stable-1.3.0", platforms: 2 });
		const updated = {
			releaseRetained: release === document.querySelector("#release"),
			textRetained: text === [...command.childNodes].find(node => node.nodeType === Node.TEXT_NODE),
			command: command.textContent, platforms: document.querySelector("#platforms").textContent,
			disclosureOpen: instructions.open,
		};
		window.warrenFixture.update({ visible: false });
		const fallback = document.querySelector("#empty");
		window.warrenFixture.poll(); window.warrenFixture.poll();
		const hidden = {
			releaseRemoved: !release.isConnected && !document.querySelector("#release"),
			fallbackRetained: fallback === document.querySelector("#empty"),
			lifecycle: { ...window.warrenFixture.lifecycle },
		};
		window.warrenFixture.update({ visible: true });
		const shown = {
			newRelease: release !== document.querySelector("#release") && Boolean(document.querySelector("#release")),
			fallbackRemoved: !fallback.isConnected,
			command: document.querySelector("#command").textContent,
			lifecycle: { ...window.warrenFixture.lifecycle },
		};
		window.warrenFixture.dispose();
		return { updated, hidden, shown, disposed: { ...window.warrenFixture.lifecycle } };
	});
	assert.deepEqual(result, {
		updated: { releaseRetained: true, textRetained: true, command: "hutch electrobun publish --release=stable-1.3.0", platforms: "2 platforms", disclosureOpen: true },
		hidden: { releaseRemoved: true, fallbackRetained: true, lifecycle: { mounted: 1, disposed: 1, fallbackMounted: 1 } },
		shown: { newRelease: true, fallbackRemoved: true, command: "hutch electrobun publish --release=stable-1.3.0", lifecycle: { mounted: 2, disposed: 1, fallbackMounted: 1 } },
		disposed: { mounted: 2, disposed: 2, fallbackMounted: 1 },
	});
});
