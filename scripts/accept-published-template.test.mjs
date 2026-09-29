import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { acceptanceEnvironment, requiredChecks, run, validateCatalog, validateReport } from "./accept-published-template.mjs";

const pins = { hutch: "0.27.1", cottontail: "0.7.1" };
const catalog = { schema: 1, kind: "electrobun-template-channel", channel: "stable", version: "2.0.2", tools: pins, templates: [{ id: "hello-world" }] };

test("acceptance rejects a stale channel or mismatched toolchain instead of testing another release", () => {
	validateCatalog(catalog, "2.0.2", pins);
	for (const patch of [{ version: "2.0.1" }, { channel: "beta" }, { tools: { ...pins, hutch: "0.27.0" } }, { templates: [] }]) {
		assert.throws(() => validateCatalog({ ...catalog, ...patch }, "2.0.2", pins));
	}
});

test("app report must prove every check and belong to this launch", () => {
	const report = { token: "this-launch", ok: true, checks: requiredChecks };
	validateReport(report, "this-launch");
	assert.throws(() => validateReport(report, "another-launch"));
	assert.throws(() => validateReport({ ...report, ok: false, error: "SQL failed" }, "this-launch"), /SQL failed/);
	for (const check of requiredChecks) {
		assert.throws(() => validateReport({ ...report, checks: requiredChecks.filter(c => c !== check) }, "this-launch"));
	}
});

test("isolated environment discards local runtime, catalog, and npm overrides", () => {
	const env = acceptanceEnvironment({ PATH: "/bin", HUTCH_ENGINE_BINARY: "local", COTTONTAIL_BINARY: "local", ELECTROBUN_TEMPLATES_BASE_URL: "local", NPM_CONFIG_REGISTRY: "local", NODE_OPTIONS: "--require=local" }, "/work");
	assert.equal(env.HUTCH_ENGINE_BINARY, undefined);
	assert.equal(env.COTTONTAIL_BINARY, undefined);
	assert.equal(env.ELECTROBUN_TEMPLATES_BASE_URL, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.HUTCH_HOME, join("/work", "hutch-home"));
	assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
});

test("command runner rejects failure and hangs rather than accepting an absent report", async () => {
	await run(process.execPath, ["-e", "process.exit(0)"], { timeout: 5000 });
	await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"], { timeout: 5000 }), /failed/);
	await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100 }), /timed out/);
});

test("a startup marker followed by an immediate crash is not successful startup", async () => {
	await assert.rejects(run(process.execPath, ["-e", "console.log('ready');process.exit(1)"], { timeout: 5000, startupMarker: "ready" }), /failed/);
});
