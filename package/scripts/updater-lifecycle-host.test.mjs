import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertLifecycleInstallation, loadLifecycleHost } from "./updater-lifecycle-host.mjs";
import { inspectLifecycleChecksum, publishLifecycleReleaseFiles } from "./updater-lifecycle-artifacts.mjs";

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
	const release = { root: "/artifacts", metadata: { version: "3.0.0" },
		checksumPath: "/artifacts/stable-macos-arm64-new123-checksum.json", checksum: { tarSha256: "a".repeat(64), tarSize: 2048 } };
	await host.publishRelease(release, { includePatch: false, includeIntegrity: false });
	await host.dispose();
	assert.deepEqual(calls, [{ release, options: { includePatch: false, includeIntegrity: false } }, { disposed: true }]);
	assert.equal(host.buildEnvironment.ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID, "app_fixture");
});

async function artifactFixture(t) {
	const root = await mkdtemp(join(tmpdir(), "electrobun-lifecycle-artifacts-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const server = join(root, "server");
	await mkdir(source);
	const prefix = "stable-macos-arm64";
	const metadata = { schemaVersion: 1, identifier: "dev.example.fixture", channel: "stable",
		version: "2.0.0", hash: "new123", platform: "macos", arch: "arm64", artifact: { file: `${prefix}-Example.app.tar.zst` } };
	const checksum = { tarSha256: "a".repeat(64), tarSize: 2048 };
	const release = { root: source, metadata, checksum,
		updatePath: join(source, `${prefix}-update.json`),
		checksumPath: join(source, `${prefix}-${metadata.hash}-checksum.json`),
		archivePath: join(source, metadata.artifact.file),
		patchPath: join(source, `${prefix}-old123.patch`) };
	await writeFile(release.updatePath, JSON.stringify(metadata));
	await writeFile(release.checksumPath, JSON.stringify(checksum));
	await writeFile(release.archivePath, "fixture archive");
	await writeFile(release.patchPath, "fixture patch");
	return { root, source, server, prefix, release, metadata, checksum,
		tarIdentity: { sha256: checksum.tarSha256, size: checksum.tarSize } };
}

test("lifecycle verifies one hash-bound checksum without adding fields to the strict legacy manifest", async t => {
	const f = await artifactFixture(t);
	assert.deepEqual(inspectLifecycleChecksum(f.source, f.prefix, f.metadata, f.tarIdentity, "fixture"), {
		checksumPath: f.release.checksumPath, checksum: f.checksum,
	});
	for (const metadata of [
		{ ...f.metadata, futureField: true },
		{ ...f.metadata, artifact: { ...f.metadata.artifact, ...f.checksum } },
		{ ...f.metadata, hash: "../another" },
	]) assert.throws(() => inspectLifecycleChecksum(f.source, f.prefix, metadata, f.tarIdentity, "fixture"));
	assert.throws(() => inspectLifecycleChecksum(f.source, f.prefix, f.metadata, { ...f.tarIdentity, size: 4096 }, "fixture"), /differs/);
	await writeFile(f.release.checksumPath, JSON.stringify({ ...f.checksum, version: f.metadata.version }));
	assert.throws(() => inspectLifecycleChecksum(f.source, f.prefix, f.metadata, f.tarIdentity, "fixture"), /duplicate release metadata/);
	await writeFile(f.release.checksumPath, JSON.stringify(f.checksum));
	await writeFile(join(f.source, `${f.prefix}-another-checksum.json`), JSON.stringify(f.checksum));
	assert.throws(() => inspectLifecycleChecksum(f.source, f.prefix, f.metadata, f.tarIdentity, "fixture"), /sidecar names/);
});

test("lifecycle publication preserves flat patch history and can simulate a missing checksum without changing update.json", async t => {
	const f = await artifactFixture(t);
	publishLifecycleReleaseFiles(f.release, f.server);
	assert.deepEqual(new Set(await readdir(f.server)), new Set([
		`${f.prefix}-update.json`, `${f.prefix}-new123-checksum.json`,
		f.metadata.artifact.file, `${f.prefix}-old123.patch`,
	]));
	assert.equal(await readFile(join(f.server, `${f.prefix}-update.json`), "utf8"), JSON.stringify(f.metadata));
	assert.equal(await readFile(join(f.server, `${f.prefix}-new123-checksum.json`), "utf8"), JSON.stringify(f.checksum));
	await writeFile(join(f.server, `${f.prefix}-older456.patch`), "historical patch");
	await writeFile(join(f.server, `${f.prefix}-older456-checksum.json`), "historical checksum");
	publishLifecycleReleaseFiles(f.release, f.server, { includePatch: false, includeIntegrity: false });
	await assert.rejects(readFile(join(f.server, `${f.prefix}-new123-checksum.json`)), { code: "ENOENT" });
	assert.equal(await readFile(join(f.server, `${f.prefix}-update.json`), "utf8"), JSON.stringify(f.metadata));
	assert.equal(await readFile(join(f.server, `${f.prefix}-older456.patch`), "utf8"), "historical patch");
	assert.equal(await readFile(join(f.server, `${f.prefix}-older456-checksum.json`), "utf8"), "historical checksum");
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
