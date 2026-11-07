import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertLifecycleInstallation, loadLifecycleHost } from "./updater-lifecycle-host.mjs";

async function fixture(t, source) {
	const directory = await mkdtemp(join(tmpdir(), "electrobun-lifecycle-host-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "host.mjs");
	await writeFile(file, source);
	return file;
}

test("ordinary lifecycle needs no external host or Cloud dependency", async () => {
	assert.equal(await loadLifecycleHost(undefined, {}), null);
});

test("external lifecycle host receives the real fixture context and owns publication", async t => {
	const file = await fixture(t, `export async function createLifecycleHost(context) {
		return { baseUrl: 'http://127.0.0.1:9123', buildEnvironment: { ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID: 'app_fixture' },
			publishRelease: (release, options) => context.recordRequest({ release, options }),
			dispose: () => context.recordRequest({ disposed: true }) };
	}`);
	const calls = [];
	const host = await loadLifecycleHost(file, { recordRequest: value => calls.push(value) });
	const release = { root: "/artifacts", metadata: { version: "3.0.0" } };
	await host.publishRelease(release, { includePatch: false });
	await host.dispose();
	assert.deepEqual(calls, [{ release, options: { includePatch: false } }, { disposed: true }]);
	assert.equal(host.buildEnvironment.ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID, "app_fixture");
});

test("invalid adapter export fails rather than silently running the static lifecycle", async t => {
	const file = await fixture(t, "export default {};\n");
	await assert.rejects(loadLifecycleHost(file, {}), /createLifecycleHost/);
});

test("invalid host configuration is disposed before it is rejected", async t => {
	const file = await fixture(t, `export async function createLifecycleHost(context) {
		return { baseUrl: 'file:///artifacts', publishRelease() {}, dispose: () => context.disposed() };
	}`);
	let disposed = false;
	await assert.rejects(loadLifecycleHost(file, { disposed() { disposed = true; } }), /HTTP\(S\)/);
	assert.equal(disposed, true);
});

test("adapter cannot return nonstring build environment values", async t => {
	const file = await fixture(t, `export async function createLifecycleHost() {
		return { baseUrl: 'http://127.0.0.1', publishRelease() {}, dispose() {}, buildEnvironment: { BAD: true } };
	}`);
	await assert.rejects(loadLifecycleHost(file, {}), /values must be strings/);
});

test("installed profile ID remains shared across managed update versions", () => {
	const id = "a".repeat(32);
	const events = ["1.0.0", "3.0.0", "4.0.0"].map(version => ({ event: "installation-identity", version,
		details: { installationId: id, insightsId: id } }));
	events.unshift({ event: "ignored-installer-relaunch", details: { installationId: "b".repeat(32) } });
	assert.equal(assertLifecycleInstallation(events), id);
	assert.equal(assertLifecycleInstallation(events, id), id);
	assert.throws(() => assertLifecycleInstallation([...events, { event: "installation-identity", details: { installationId: "c".repeat(32), insightsId: id } }], id), /preserve/);
	assert.throws(() => assertLifecycleInstallation([{ event: "installation-identity", details: { installationId: id, insightsId: "d".repeat(32) } }]), /share/);
	assert.throws(() => assertLifecycleInstallation([]), /did not report/);
});

test("fixture configuration keeps static updates independent from managed hosting and Insights", async t => {
	const values = {
		ELECTROBUN_UPDATER_E2E_VERSION: "1.0.0", ELECTROBUN_UPDATER_E2E_NAME: "LifecycleFixture",
		ELECTROBUN_UPDATER_E2E_IDENTIFIER: "dev.example.lifecycle", ELECTROBUN_UPDATER_E2E_BASE_URL: "http://127.0.0.1:8787/static",
		ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID: undefined, ELECTROBUN_UPDATER_E2E_MANAGED_API_URL: undefined,
		ELECTROBUN_UPDATER_E2E_INSIGHTS: undefined,
	};
	const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	const apply = record => { for (const [key, value] of Object.entries(record)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
	t.after(() => apply(previous));
	apply(values);
	const config = async suffix => (await import(new URL(`../test-apps/updater-lifecycle/electrobun.config.ts?${suffix}`, import.meta.url))).default;
	const ordinary = await config("ordinary");
	assert.deepEqual(ordinary.release, { baseUrl: values.ELECTROBUN_UPDATER_E2E_BASE_URL, generatePatch: true });
	assert.equal(ordinary.insights, undefined);
	apply({ ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID: "app_fixture", ELECTROBUN_UPDATER_E2E_MANAGED_API_URL: "http://127.0.0.1:9123" });
	const managed = await config("managed");
	assert.deepEqual(managed.release, { managed: { appId: "app_fixture", apiUrl: "http://127.0.0.1:9123" }, generatePatch: true });
	assert.equal(managed.insights, undefined, "Managed hosting does not imply analytics opt-in");
	apply({ ELECTROBUN_UPDATER_E2E_INSIGHTS: "1" });
	const measured = await config("measured");
	assert.deepEqual(measured.insights, { appId: "app_fixture", apiUrl: "http://127.0.0.1:9123", enabled: true });
	apply({ ELECTROBUN_UPDATER_E2E_MANAGED_API_URL: undefined });
	await assert.rejects(config("incomplete"), /both an app ID/);
});
