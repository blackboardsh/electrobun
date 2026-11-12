import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
	parseUpdaterLifecycleBackend,
	updaterLifecycleFixturePath,
	writeUpdaterLifecycleControl,
} from "./updater-lifecycle-fixture.mjs";
import { runLifecycleCommand, snapshotLifecycleTree } from "./updater-lifecycle-diagnostics.mjs";

async function waitForCommandOutput(record, timeout = 10_000) {
	assert.ok(record, "command must retain its live output record");
	const deadline = Date.now() + timeout;
	while (!record.outputClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(record.outputClosed, true, "command pipes did not close within the diagnostic deadline");
}

test("delegated command output remains visible after its parent exits without waiting for inherited pipes", { timeout: 30_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "updater-lifecycle-delegation-"));
	const gate = join(root, "manager-can-finish");
	const ready = join(root, "manager-ready");
	const descendantPath = join(root, "manager.cjs");
	const parentPath = join(root, "launcher.cjs");
	let record;
	// Release and drain the descendant before removing its gate, including when
	// a failed assertion or command timeout interrupts the normal test path.
	t.after(async () => {
		writeFileSync(gate, "finish");
		try { if (record) await waitForCommandOutput(record, 15_000); }
		finally { rmSync(root, { recursive: true, force: true }); }
	});
	writeFileSync(descendantPath, `
		const fs = require('node:fs');
		const [gate, ready] = process.argv.slice(2);
		fs.writeFileSync(ready, String(process.pid));
		const poll = setInterval(() => {
			if (!fs.existsSync(gate)) return;
			clearInterval(poll);
			process.stderr.write('delayed manager failure\\n', () => process.exit(0));
		}, 10);
		setTimeout(() => process.exit(2), 15000).unref();
	`);
	// libuv puts non-detached Windows children in a kill-on-parent-exit job.
	// The real native launcher creates no such job: detach only this synthetic
	// Node manager so it models native delegation while retaining the same pipes.
	writeFileSync(parentPath, `
		const fs = require('node:fs');
		const [descendant, gate, ready] = process.argv.slice(2);
		const manager = require('node:child_process').spawn(process.execPath, [descendant, gate, ready], {
			stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: true,
		});
		manager.on('error', error => { console.error(error); process.exit(1); });
		manager.unref();
		const poll = setInterval(() => {
			if (!fs.existsSync(ready)) return;
			clearInterval(poll);
			process.exit(0);
		}, 10);
		setTimeout(() => { console.error('manager did not become ready'); process.exit(3); }, 8000).unref();
	`);
	let echoed = "";
	try {
		record = await runLifecycleCommand(process.execPath, [parentPath, descendantPath, gate, ready], {
			cwd: root, env: process.env, label: "delegating launcher", timeout: 10_000,
			echo: true, output: { stdout: { write() {} }, stderr: { write(chunk) { echoed += chunk.toString(); } } },
		});
	} catch (error) {
		record = error.commandResult;
		throw error;
	}
	assert.equal(record.exitCode, 0);
	assert.equal(existsSync(ready), true, `manager never became ready: ${record.stderr}`);
	assert.equal(record.outputClosed, false, `launcher exit must not wait for its delegated manager's pipes: ${record.stderr}`);
	assert.equal(record.stderr, "");
	writeFileSync(gate, "finish");
	await waitForCommandOutput(record);
	assert.equal(record.stderr, "delayed manager failure\n");
	assert.equal(echoed, record.stderr, "late manager errors must reach the retained CI log");
	assert.equal(JSON.parse(JSON.stringify(record)).stderr, record.stderr, "failure snapshots must include late output");
});

test("lifecycle command diagnostics bound captured output and retain nonzero exit failures", async () => {
	const record = await runLifecycleCommand(process.execPath, ["-e", "process.stderr.write('x'.repeat(8192) + 'end')"], {
		cwd: process.cwd(), env: process.env, label: "bounded output", timeout: 10_000, maxOutputBytes: 64,
	});
	await waitForCommandOutput(record);
	assert.equal(Buffer.byteLength(record.stderr), 64);
	assert.ok(record.stderr.endsWith("end"));
	let failedRecord;
	await assert.rejects(runLifecycleCommand(process.execPath, ["-e", "process.stderr.write('manager failed'); process.exitCode = 7"], {
		cwd: process.cwd(), env: process.env, label: "failed manager", timeout: 10_000,
	}), error => {
		assert.match(error.message, /failed manager failed \(7\):/);
		assert.equal(error.commandResult.exitCode, 7);
		failedRecord = error.commandResult;
		return true;
	});
	await waitForCommandOutput(failedRecord);
	assert.equal(failedRecord.stderr, "manager failed");
	await assert.rejects(runLifecycleCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		cwd: process.cwd(), env: process.env, label: "stalled manager", timeout: 100,
	}), error => {
		assert.match(error.message, /stalled manager timed out after 100ms/);
		assert.equal(typeof error.commandResult.pid, "number");
		return true;
	});
});

test("uninstall snapshots bound breadth and depth, preserve missing roots, and never follow links", (t) => {
	const root = project(t);
	const outside = project(t);
	writeFileSync(join(outside, "private-data"), "must never be read");
	symlinkSync(outside, join(root, "linked-profile"), process.platform === "win32" ? "junction" : "dir");
	mkdirSync(join(root, "src", "nested"));
	writeFileSync(join(root, "src", "nested", "hidden-by-depth"), "data");
	const snapshot = snapshotLifecycleTree(root, { maxDepth: 1 });
	assert.equal(snapshot.truncated, true);
	assert.ok(snapshot.entries.some(entry => entry.path === "linked-profile" && entry.kind === "symlink"));
	assert.equal(snapshot.entries.some(entry => /private-data|hidden-by-depth|nested/.test(entry.path)), false);
	for (let i = 0; i < 20; i++) writeFileSync(join(root, `file-${i}`), "data");
	const bounded = snapshotLifecycleTree(root, { maxEntries: 5 });
	assert.equal(bounded.entries.length, 5);
	assert.equal(bounded.truncated, true);
	assert.deepEqual(snapshotLifecycleTree(join(root, "removed")).entries, [{ path: ".", error: "ENOENT" }]);
});

test("native fixture event logging appends records with the platform's real file APIs", () => {
	const packageRoot = fileURLToPath(new URL("../", import.meta.url));
	const vendoredZig = join(packageRoot, "vendors", "zig", process.platform === "win32" ? "zig.exe" : "zig");
	const zig = process.env.ZIG_BINARY || (existsSync(vendoredZig) ? vendoredZig : "zig");
	const result = spawnSync(zig, ["test", "test-apps/updater-lifecycle-native/src/zig/fixture_io.zig", "-lc"], {
		cwd: packageRoot, encoding: "utf8", timeout: 300_000, windowsHide: true,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `Native fixture event logging failed: ${result.stdout}${result.stderr}`);
});

test("existing invocations select Bun and preserve arguments for the focus parser", () => {
	for (const args of [[], ["--focus=full"], ["--help"], ["--unknown"]]) {
		Object.freeze(args);
		const selected = parseUpdaterLifecycleBackend(args);
		assert.equal(selected.backend, "bun");
		assert.deepEqual(selected.args, args);
		assert.notEqual(selected.args, args, "selection must not reuse the caller's argument array");
	}
});

test("explicit fixture selection leaves remaining arguments in their original order", () => {
	for (const backend of ["bun", "zig"]) {
		const args = Object.freeze(["--focus=install", `--backend=${backend}`, "--focus=full"]);
		assert.deepEqual(parseUpdaterLifecycleBackend(args), {
			backend,
			args: ["--focus=install", "--focus=full"],
		});
		assert.deepEqual(args, ["--focus=install", `--backend=${backend}`, "--focus=full"]);
	}
});

test("invalid or duplicate backend selection fails before choosing a fixture", () => {
	for (const args of [
		["--backend"],
		["--backend", "zig"],
		["--backend="],
		["--backend=go"],
		["--backend=../updater-lifecycle"],
		["--backend=constructor"],
		["--backend=bun", "--backend=bun"],
		["--backend=zig", "--backend=bun"],
	]) {
		assert.throws(() => parseUpdaterLifecycleBackend(args), /backend/);
	}
});

test("fixture paths use only the established Bun and native project directories", () => {
	const root = join(tmpdir(), "package with spaces");
	assert.equal(updaterLifecycleFixturePath(root, "bun"), join(root, "test-apps", "updater-lifecycle"));
	assert.equal(updaterLifecycleFixturePath(root, "zig"), join(root, "test-apps", "updater-lifecycle-native"));
	assert.throws(() => updaterLifecycleFixturePath(root, "../unrelated"), /unsupported.*backend/);
});

function project(t) {
	const root = mkdtempSync(join(tmpdir(), "updater-lifecycle-control-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"));
	return root;
}

const control = Object.freeze({
	runToken: "fixture-token",
	identifier: "dev.example.updater-lifecycle.fixture",
	builtVersion: "1.0.0",
	channelRoot: "C:\\Profile with spaces\\App\"quoted\"",
	managedServices: true,
});

test("Bun control generation retains the existing TypeScript module byte for byte", (t) => {
	const root = project(t);
	const path = writeUpdaterLifecycleControl(root, "bun", control);
	assert.equal(path, join(root, "src", "control.ts"));
	assert.equal(readFileSync(path, "utf8"), `export const control = ${JSON.stringify(control, null, 2)} as const;\n`);
	assert.equal(existsSync(join(root, "src", "control.json")), false);
});

test("native control generation preserves the same data as plain bundled JSON", (t) => {
	const root = project(t);
	const path = writeUpdaterLifecycleControl(root, "zig", control);
	assert.equal(path, join(root, "src", "control.json"));
	const contents = readFileSync(path, "utf8");
	assert.equal(contents, `${JSON.stringify(control, null, 2)}\n`);
	assert.deepEqual(JSON.parse(contents), control);
	assert.equal(existsSync(join(root, "src", "control.ts")), false);
});

test("invalid control backend cannot write into the fixture project", (t) => {
	const root = project(t);
	assert.throws(() => writeUpdaterLifecycleControl(root, "constructor", control), /unsupported.*backend/);
	assert.equal(existsSync(join(root, "src", "control.ts")), false);
	assert.equal(existsSync(join(root, "src", "control.json")), false);
});

test("the selected native fixture bundles generated JSON and keeps hosting separate from Insights", async (t) => {
	const values = {
		ELECTROBUN_UPDATER_E2E_VERSION: "1.0.0",
		ELECTROBUN_UPDATER_E2E_NAME: "NativeLifecycleFixture",
		ELECTROBUN_UPDATER_E2E_IDENTIFIER: "dev.example.native-lifecycle",
		ELECTROBUN_UPDATER_E2E_BASE_URL: "http://127.0.0.1:8787/static",
		ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID: undefined,
		ELECTROBUN_UPDATER_E2E_MANAGED_API_URL: undefined,
		ELECTROBUN_UPDATER_E2E_INSIGHTS: undefined,
	};
	const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	const apply = record => {
		for (const [key, value] of Object.entries(record)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	t.after(() => apply(previous));
	apply(values);

	const selected = parseUpdaterLifecycleBackend(["--backend=zig", "--focus=full"]);
	const fixture = updaterLifecycleFixturePath(fileURLToPath(new URL("../", import.meta.url)), selected.backend);
	const config = async suffix => {
		const url = pathToFileURL(join(fixture, "electrobun.config.ts"));
		url.search = `?native-fixture-${suffix}`;
		return (await import(url.href)).default;
	};
	const ordinary = await config("ordinary");
	assert.equal(ordinary.build.mainProcess, "zig");
	assert.equal(ordinary.build.bun, undefined, "the installed native fixture must not contain a Bun main process");
	assert.deepEqual(ordinary.release, { baseUrl: values.ELECTROBUN_UPDATER_E2E_BASE_URL, generatePatch: true });
	assert.equal(ordinary.insights, undefined);
	const root = project(t);
	const controlPath = writeUpdaterLifecycleControl(root, selected.backend, control);
	const copyKey = relative(root, controlPath).split("\\").join("/");
	assert.equal(ordinary.build.copy[copyKey], "updater-lifecycle-control.json",
		"the generated native control file must be copied into the installed Resources/app folder");
	assert.deepEqual(JSON.parse(readFileSync(controlPath, "utf8")), control);
	assert.equal(existsSync(join(root, "src", "control.ts")), false);

	apply({
		ELECTROBUN_UPDATER_E2E_BASE_URL: undefined,
		ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID: "app_native_fixture",
		ELECTROBUN_UPDATER_E2E_MANAGED_API_URL: "http://127.0.0.1:9123",
	});
	const managed = await config("managed");
	assert.deepEqual(managed.release, {
		managed: { appId: "app_native_fixture", apiUrl: "http://127.0.0.1:9123" }, generatePatch: true,
	});
	assert.equal(managed.insights, undefined, "managed hosting alone does not opt into Insights");
	apply({ ELECTROBUN_UPDATER_E2E_INSIGHTS: "1" });
	const measured = await config("measured");
	assert.deepEqual(measured.insights, { appId: "app_native_fixture", apiUrl: "http://127.0.0.1:9123", enabled: true });
	assert.deepEqual(measured.release, managed.release, "Insights opt-in does not change update routing");

	for (const [index, incomplete] of [
		{ ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID: "app_native_fixture" },
		{ ELECTROBUN_UPDATER_E2E_MANAGED_API_URL: "http://127.0.0.1:9123" },
		{ ELECTROBUN_UPDATER_E2E_INSIGHTS: "1" },
	].entries()) {
		apply({ ...values, ...incomplete });
		await assert.rejects(config(`incomplete-${index}`), /both an app ID and an explicit test API URL/);
	}
});
