import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { acceptanceEnvironment, installProductionHutch, requiredChecks, run, validateCatalog, validateHutchSource, validateReport, withAcceptanceScratch } from "./accept-published-template.mjs";

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
	const legacyRuntimeOverrides = {
		DASH_COTTONTAIL: "/local/cottontail",
		DASH_COTTONTAIL_SELECTOR: "canary",
		DASH_USE_LOCAL_COTTONTAIL: "1",
		DASH_LOCAL_COTTONTAIL_ROOT: "/local/cottontail-checkout",
	};
	const env = acceptanceEnvironment({ PATH: "/bin", ...legacyRuntimeOverrides, HUTCH_ENGINE_BINARY: "local", COTTONTAIL_BINARY: "local", ELECTROBUN_TEMPLATES_BASE_URL: "local", DASH_ARTIFACTS_BASE_URL: "local", DASH_HOME: "local", NPM_CONFIG_REGISTRY: "local", NODE_OPTIONS: "--require=local" }, "/work");
	for (const name of Object.keys(legacyRuntimeOverrides)) assert.equal(env[name], undefined);
	assert.equal(env.HUTCH_ENGINE_BINARY, undefined);
	assert.equal(env.COTTONTAIL_BINARY, undefined);
	assert.equal(env.ELECTROBUN_TEMPLATES_BASE_URL, undefined);
	assert.equal(env.DASH_ARTIFACTS_BASE_URL, undefined);
	assert.equal(env.DASH_HOME, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.HUTCH_HOME, join("/work", "hutch-home"));
	assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
});

test("production installer acceptance only permits a stable release and stable toolchain", () => {
	validateHutchSource("production-installer", "2.0.2", pins);
	validateHutchSource("npm", "2.0.3-beta.29", { hutch: "0.28.0-canary.10", cottontail: "0.7.2-canary.7" });
	assert.throws(() => validateHutchSource("local", "2.0.2", pins), /Hutch source/);
	assert.throws(() => validateHutchSource("production-installer", "2.0.3-beta.29", pins), /stable electrobun/);
	assert.throws(() => validateHutchSource("production-installer", "2.0.2", { ...pins, hutch: "0.28.0-canary.10" }), /stable hutch/);
	assert.throws(() => validateHutchSource("production-installer", "2.0.2", { ...pins, cottontail: "0.7.2-canary.7" }), /stable cottontail/);
});

test("acceptance stops ancestor pragma discovery without pinning a tool and cleans up even on failure", async t => {
	const shared = mkdtempSync(join(tmpdir(), "electrobun-shared-temp-test-"));
	t.after(() => rmSync(shared, { recursive: true, force: true }));
	writeFileSync(join(shared, "hutch.config.ts"), "// @hutch cli=0.28.0-canary.10 cottontail=0.7.2-canary.7\nexport default {};\n");
	for (const fail of [false, true]) {
		let created;
		const operation = withAcceptanceScratch(async scratch => {
			created = scratch;
			assert.notEqual(scratch, shared);
			const config = readFileSync(join(scratch, "hutch.config.ts"), "utf8");
			assert.equal(config, "export default {};\n");
			assert.equal(readFileSync(join(scratch, "empty.npmrc"), "utf8"), "");
			if (fail) throw new Error("acceptance failed");
			return "accepted";
		}, shared);
		if (fail) await assert.rejects(operation, /acceptance failed/);
		else assert.equal(await operation, "accepted");
		assert.equal(existsSync(created), false);
	}
});

for (const platform of ["darwin", "linux", "win32"]) {
	test(`public ${platform} installer uses its default channel and verifies the installed launcher before init`, async t => {
		const scratch = mkdtempSync(join(tmpdir(), "electrobun-installer-test-"));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const env = acceptanceEnvironment({ PATH: "existing-tools" }, scratch);
		const hutch = join(env.HUTCH_HOME, "bin", platform === "win32" ? "hutch.exe" : "hutch");
		const calls = [];
		let installedVersion = pins.hutch;
		const deps = {
			fetchInstaller: async url => {
				assert.equal(url, `https://hutch.blackboard.sh/hutch/install.${platform === "win32" ? "ps1" : "sh"}`);
				return new Response("# public installer\n");
			},
			runInstaller: async (command, args, options) => {
				calls.push({ command, args });
				if (command === hutch) {
					assert.deepEqual(args, ["--version"]);
					assert.equal(options.cwd, parse(scratch).root);
					assert.deepEqual(options.env, { ...env, PWD: parse(scratch).root });
					return `${installedVersion}\n`;
				}
				assert.equal(options.cwd, scratch);
				assert.equal(options.env, env);
				assert.equal(command, platform === "win32" ? "powershell.exe" : "sh");
				const script = args[platform === "win32" ? 5 : 0];
				assert.equal(readFileSync(script, "utf8"), "# public installer\n");
				assert.deepEqual(args, platform === "win32"
					? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-NoModifyPath"]
					: [script, "--no-modify-path"]);
				mkdirSync(join(env.HUTCH_HOME, "bin"), { recursive: true });
				writeFileSync(hutch, "installed launcher");
				return "installed";
			},
		};
		const options = { scratch, work: scratch, env, platform, expectedVersion: pins.hutch };
		assert.equal(await installProductionHutch(options, deps), hutch);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].command, hutch);
		installedVersion = "0.27.0";
		await assert.rejects(installProductionHutch(options, deps), /exact Hutch version before reading a project pragma/);
	});
}

test("a missing or failed public installer cannot fall back to a preinstalled Hutch", async t => {
	const scratch = mkdtempSync(join(tmpdir(), "electrobun-installer-test-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const options = { scratch, work: scratch, env: acceptanceEnvironment(process.env, scratch), expectedVersion: pins.hutch };
	await assert.rejects(installProductionHutch(options, {
		fetchInstaller: async () => new Response("not found", { status: 404 }),
		runInstaller: async () => assert.fail("must not execute a missing installer"),
	}), /installer HTTP 404/);
	await assert.rejects(installProductionHutch(options, {
		fetchInstaller: async () => new Response("# installer"),
		runInstaller: async () => { throw new Error("download failed"); },
	}), /download failed/);
	await assert.rejects(installProductionHutch(options, {
		fetchInstaller: async () => new Response("# installer"),
		runInstaller: async () => "skipped installation",
	}), /did not create the production launcher/);
});

test("command runner rejects failure and hangs rather than accepting an absent report", async () => {
	await run(process.execPath, ["-e", "process.exit(0)"], { timeout: 5000 });
	await assert.rejects(run(process.execPath, ["-e", "process.exit(7)"], { timeout: 5000 }), /failed/);
	await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 100 }), /timed out/);
});

test("a startup marker followed by an immediate crash is not successful startup", async () => {
	await assert.rejects(run(process.execPath, ["-e", "console.log('ready');process.exit(1)"], { timeout: 5000, startupMarker: "ready" }), /failed/);
});
