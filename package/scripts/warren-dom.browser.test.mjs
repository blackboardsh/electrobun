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

test("static For inside a live Switch updates its rows without remounting the desktop", { timeout: 15_000 }, async t => {
	const page = await openFixture(t);
	const warnings = [];
	page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
	await page.evaluate(() => { window.staticRows = window.warrenFixture.mountStaticRows(); });
	await page.locator("#hold-Shift").click();
	const state = await page.evaluate(() => {
		const rows = window.staticRows;
		const desktop = document.querySelector("#static-desktop");
		const shift = document.querySelector("#hold-Shift");
		const initial = { pressed: shift.getAttribute("aria-pressed"), focused: document.activeElement === shift };
		rows.setHeld(["Control"]);
		rows.setReady(false);
		const updated = {
			retained: document.querySelector("#static-desktop") === desktop && document.querySelector("#hold-Shift") === shift,
			shiftPressed: shift.getAttribute("aria-pressed"),
			controlPressed: document.querySelector("#hold-Control").getAttribute("aria-pressed"),
			disabled: shift.disabled,
			lifecycle: { ...rows.lifecycle },
		};
		rows.setTab("other");
		rows.setHeld([]); rows.setReady(true);
		const hidden = { text: document.querySelector("#static-rows").textContent, lifecycle: { ...rows.lifecycle } };
		rows.setTab("desktop");
		const reopened = { newDesktop: document.querySelector("#static-desktop") !== desktop, lifecycle: { ...rows.lifecycle } };
		rows.dispose(); rows.setHeld(["Shift"]);
		return { initial, updated, hidden, reopened, disposed: { ...rows.lifecycle }, removed: !document.querySelector("#static-rows") };
	});
	assert.deepEqual(state, {
		initial: { pressed: "true", focused: true },
		updated: { retained: true, shiftPressed: "false", controlPressed: "true", disabled: true, lifecycle: { mounted: 1, disposed: 0, rowsDisposed: 0 } },
		hidden: { text: "other tab", lifecycle: { mounted: 1, disposed: 1, rowsDisposed: 2 } },
		reopened: { newDesktop: true, lifecycle: { mounted: 2, disposed: 1, rowsDisposed: 2 } },
		disposed: { mounted: 2, disposed: 2, rowsDisposed: 4 }, removed: true,
	});
	assert.deepEqual(warnings.filter(message => message.includes("nested live()")), []);
});

test("a runaway effect reports its cycle and leaves timers and unrelated controls responsive", { timeout: 15_000 }, async t => {
	const page = await openFixture(t);
	await page.evaluate(() => { window.runaway = window.warrenFixture.mountRunaway(); });
	await page.locator("#start-runaway").click();
	await page.waitForFunction(() => document.querySelector("#runaway-diagnostic")?.textContent.includes("WarrenReactiveCycleError"));
	await page.waitForFunction(() => window.runaway.lifecycle.runs === window.runaway.lifecycle.cleanups && Number(document.querySelector("#runaway-counter").textContent) === window.runaway.lifecycle.runs);
	assert.match(await page.locator("#runaway-diagnostic").innerText(), /WarrenReactiveCycleError:.*reactive cycle/i);
	const stopped = await page.evaluate(() => ({
		...window.runaway.lifecycle,
		counter: Number(document.querySelector("#runaway-counter").textContent),
	}));
	assert.ok(stopped.runs > 0 && stopped.runs <= 100, `The runtime must stop repeated scope executions promptly: ${stopped.runs}`);
	assert.equal(stopped.cleanups, stopped.runs, "The rejected scope and its resources are torn down exactly once");
	assert.equal(stopped.counter, stopped.runs, "Unrelated queued bindings still receive their committed value");
	await page.locator("#healthy-button").click();
	assert.equal(await page.locator("#healthy-button").innerText(), "Healthy clicks: 1");
	const after = await page.evaluate(() => new Promise(resolve => {
		setTimeout(() => requestAnimationFrame(() => {
			window.runaway.writeAgain();
			resolve({ ...window.runaway.lifecycle, counter: Number(document.querySelector("#runaway-counter").textContent) });
		}), 0);
	}));
	assert.deepEqual(after, { runs: stopped.runs, cleanups: stopped.cleanups, counter: stopped.counter + 1 }, "The disposed effect cannot resume, while healthy bindings and the event loop still work");
	await page.locator("#healthy-button").click();
	assert.equal(await page.locator("#healthy-button").innerText(), "Healthy clicks: 2");
	await page.evaluate(() => window.runaway.dispose());
});

for (const detached of [false, true]) {
	test(`a fresh-scope chain${detached ? " through detached roots" : ""} is stopped while the browser remains usable`, { timeout: 15_000 }, async t => {
		const page = await openFixture(t);
		await page.evaluate(detached => { window.creation = window.warrenFixture.mountCreationRunaway(detached); }, detached);
		await page.locator("#start-creation-runaway").click();
		await page.waitForFunction(() => document.querySelector("#creation-diagnostic")?.textContent.includes("WarrenReactiveCycleError"));
		await page.waitForFunction(() => window.creation.lifecycle.runs === window.creation.lifecycle.cleanups && Number(document.querySelector("#creation-counter").textContent) === window.creation.lifecycle.runs);
		assert.match(await page.locator("#creation-diagnostic").innerText(), /WarrenReactiveCycleError:.*reactive cycle/i);
		const stopped = await page.evaluate(() => ({
			...window.creation.lifecycle,
			counter: Number(document.querySelector("#creation-counter").textContent),
		}));
		assert.ok(stopped.runs > 0 && stopped.runs <= 256, `Serial scope creation must be bounded: ${stopped.runs}`);
		assert.equal(stopped.cleanups, stopped.runs, "Every executed fresh scope is disposed exactly once");
		assert.equal(stopped.initiatorCleanups, 1, "The initiating effect cannot restart the rejected chain");
		assert.equal(stopped.rootsDisposed, stopped.rootsCreated, "Causally created detached roots are disposed too");
		assert.equal(stopped.rootsCreated, detached ? stopped.runs : 0);
		assert.equal(stopped.counter, stopped.runs, "Independent bindings drain their committed values");
		await page.locator("#creation-healthy-button").click();
		assert.equal(await page.locator("#creation-healthy-button").innerText(), "Healthy clicks: 1");
		const after = await page.evaluate(() => new Promise(resolve => {
			setTimeout(() => requestAnimationFrame(() => {
				window.creation.writeAgain();
				resolve({ ...window.creation.lifecycle, counter: Number(document.querySelector("#creation-counter").textContent) });
			}), 0);
		}));
		assert.deepEqual(after, { ...stopped, counter: stopped.counter + 1 }, "The rejected chain stays stopped while timers, frames and independent bindings run");
		await page.locator("#creation-healthy-button").click();
		assert.equal(await page.locator("#creation-healthy-button").innerText(), "Healthy clicks: 2");
		const disposed = await page.evaluate(() => { window.creation.dispose(); return { ...window.creation.lifecycle }; });
		const { counter, ...lifecycle } = stopped;
		assert.deepEqual(disposed, lifecycle, "Closing the healthy UI does not repeat rejected-scope cleanup");
	});
}

for (const mode of ["parallel", "fresh"]) {
	test(`${mode === "parallel" ? "independent costly producers" : "a costly fresh-scope chain"} yields to input, timers and drawing before it stops`, { timeout: 15_000 }, async t => {
		const page = await openFixture(t);
		const started = await page.evaluate(mode => {
			window.cooperative = window.warrenFixture.mountCooperativeRunaway(mode);
			window.cooperative.start();
			window.cooperative.mountExternal();
			return { pending: window.cooperative.pending(), runs: [...window.cooperative.lifecycle.runs] };
		}, mode);
		assert.equal(started.pending, true, "Starting faulty work must return while its bounded continuation is still pending");
		assert.ok(started.runs.some(runs => runs > 0));
		await page.locator("#cooperative-healthy-button").click({ force: true });
		await page.waitForFunction(() => window.cooperative.lifecycle.derivedDuring.includes(2));
		await page.waitForFunction(() => !window.cooperative.pending());
		const settled = await page.evaluate(() => ({ ...window.cooperative.lifecycle }));
		assert.ok(settled.timersDuring > 0, "Timer heartbeat ran before the fault was stopped");
		assert.ok(settled.framesDuring > 0, "Animation-frame heartbeat ran before the fault was stopped");
		assert.ok(settled.clicksDuring > 0, "A real click was processed while faulty work remained queued");
		assert.ok(settled.externalDuring.includes(14), "A new root mounted during pending work and processed a later state update before the fault stopped");
		assert.deepEqual(settled.cleanups, settled.runs, "All faulty computations have been stopped and cleaned up");
		assert.ok(settled.runs.every(runs => runs > 0 && runs <= (mode === "parallel" ? 100 : 256)), "Yielding must not reset cycle budgets");
		assert.ok(settled.diagnostics.length > 0);
		assert.ok(settled.diagnostics.every(message => /^WarrenReactiveCycleError:.*reactive cycle/i.test(message)), "Only the intended diagnostic may terminate faulty work");
		await page.evaluate(() => window.cooperative.setExternal(9));
		await page.waitForFunction(() => document.querySelector("#cooperative-external")?.textContent === "18");
		await page.locator("#cooperative-healthy-button").click();
		assert.equal(await page.locator("#cooperative-derived").innerText(), "4");
		await page.evaluate(() => window.cooperative.dispose());
	});
}

test("disposing pending faulty work prevents stale continuation updates and preserves an external root", { timeout: 15_000 }, async t => {
	const page = await openFixture(t);
	const stopped = await page.evaluate(() => {
		window.cooperative = window.warrenFixture.mountCooperativeRunaway("parallel");
		window.cooperative.start();
		const wasPending = window.cooperative.pending();
		window.cooperative.mountExternal();
		window.cooperative.stopFaults();
		return { wasPending, runs: [...window.cooperative.lifecycle.runs], cleanups: [...window.cooperative.lifecycle.cleanups] };
	});
	assert.equal(stopped.wasPending, true);
	assert.deepEqual(stopped.cleanups, stopped.runs);
	await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 40)));
	await page.evaluate(() => window.cooperative.setExternal(9));
	await page.waitForFunction(() => document.querySelector("#cooperative-external")?.textContent === "18");
	await page.locator("#cooperative-healthy-button").click();
	assert.equal(await page.locator("#cooperative-derived").innerText(), "2");
	const after = await page.evaluate(() => ({ ...window.cooperative.lifecycle }));
	assert.deepEqual(after.runs, stopped.runs, "Disposed producers never run from the stale queued continuation");
	assert.deepEqual(after.cleanups, stopped.cleanups);
	assert.deepEqual(after.diagnostics, [], "Disposal cancels the fault before its cycle threshold");
	await page.evaluate(() => window.cooperative.dispose());
});
