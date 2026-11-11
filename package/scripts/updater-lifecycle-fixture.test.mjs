import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
	parseUpdaterLifecycleBackend,
	updaterLifecycleFixturePath,
	writeUpdaterLifecycleControl,
} from "./updater-lifecycle-fixture.mjs";

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
