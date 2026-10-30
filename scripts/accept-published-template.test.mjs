import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { acceptanceEnvironment, createAcceptanceCommands, installProductionHutch, requiredChecks, run, validateCatalog, validateHutchSource, validateReport, withAcceptanceScratch } from "./accept-published-template.mjs";
import hutchResolver from "../npm/electrobun/bin/resolve-hutch.cjs";

import { verifyBuiltMacOSApp } from "./desktop-smoke/run.mjs";

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

test("npm acceptance exercises the installed CLI from an unpinned environment and pins direct global-launcher calls", async () => {
	const scratch = join(tmpdir(), "electrobun-npm-command-test");
	const work = join(scratch, "reports");
	const env = acceptanceEnvironment({
		PATH: "existing-tools",
		HUTCH_ACTIVE_CHANNEL: "canary",
		HUTCH_DEFAULT_CLI: "0.1.0",
		HUTCH_DEFAULT_ELECTROBUN: "0.1.0",
	}, scratch, "npm");
	const hutch = join(env.HUTCH_HOME, "bin", "hutch");
	const npmCli = join(scratch, "bootstrap", "node_modules", "electrobun", "bin", "electrobun.cjs");
	const calls = [];
	const commands = createAcceptanceCommands({ hutch, npmCli, resolver: hutchResolver, env, scratch, work },
		async (command, args, options) => { calls.push({ command, args, options }); return "ok"; });
	const initArgs = ["init", "public-app", "--template=hello-world", "--beta"];
	await commands.initPublicTemplate(initArgs);
	assert.equal(calls[0].command, process.execPath);
	assert.deepEqual(calls[0].args, [npmCli, ...initArgs]);
	assert.equal(calls[0].options.cwd, scratch);
	assert.equal(calls[0].options.log, join(work, "public-init.log"));
	for (const key of ["HUTCH_ACTIVE_CHANNEL", "HUTCH_DEFAULT_CLI", "HUTCH_DEFAULT_ELECTROBUN"]) {
		assert.equal(calls[0].options.env[key], undefined, `${key} must be selected by the public npm CLI`);
	}
	assert.equal(calls[0].options.env.HUTCH_HOME, env.HUTCH_HOME);
	assert.equal(calls[0].options.env.PATH, "existing-tools", "public init must resolve recursive Hutch tasks without adding its cached bin directory to PATH");

	await commands.invokeHutch("hutch-version", ["--version"]);
	const project = join(scratch, "public-app");
	await commands.invokeHutch("public-build", ["electrobun", "build"], project,
		{ ELECTROBUN_ACCEPTANCE_TOKEN: "this-launch" }, { timeout: 1234 });
	for (const call of calls.slice(1)) {
		assert.equal(call.command, hutch);
		assert.equal(call.options.env.HUTCH_DEFAULT_CLI, hutchResolver.PAIRED_HUTCH_VERSION);
		assert.equal(call.options.env.HUTCH_DEFAULT_ELECTROBUN, hutchResolver.ELECTROBUN_VERSION);
		assert.equal(call.options.env.HUTCH_ACTIVE_CHANNEL, undefined);
	}
	assert.equal(calls[2].options.cwd, project);
	assert.equal(calls[2].options.env.ELECTROBUN_ACCEPTANCE_TOKEN, "this-launch");
	assert.equal(calls[2].options.timeout, 1234);
	assert.equal(env.HUTCH_DEFAULT_CLI, undefined, "direct invocations must not pin the public init environment");
	assert.equal(env.PATH, "existing-tools");
});

test("npm acceptance leaves a cold home untouched until public init succeeds", async t => {
	const scratch = mkdtempSync(join(tmpdir(), "electrobun-cold-init-test-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const npmCli = join(scratch, "public-cli.cjs");
	// Run a real child process against the filesystem: its installer refuses
	// the same preexisting cache that the acceptance harness used to create.
	writeFileSync(npmCli, `
		const assert = require("node:assert/strict");
		const fs = require("node:fs");
		const path = require("node:path");
		assert.deepEqual(process.argv.slice(2), ["init", "public-app", "--template=hello-world", "--beta"]);
		assert.equal(fs.existsSync(process.env.HUTCH_HOME), false, "public init received a populated home");
		fs.mkdirSync(path.join(process.env.HUTCH_HOME, "state"), { recursive: true });
		fs.writeFileSync(path.join(process.env.HUTCH_HOME, "state", "store.json"), "installed");
	`);
	for (const populated of [false, true]) {
		const work = join(scratch, populated ? "populated" : "cold");
		mkdirSync(work);
		const env = acceptanceEnvironment(process.env, work, "npm");
		if (populated) mkdirSync(join(env.HUTCH_HOME, "npm"), { recursive: true });
		let resolutions = 0;
		const resolver = {
			async resolveHutchBinary({ environment }) {
				resolutions++;
				assert.equal(readFileSync(join(environment.HUTCH_HOME, "state", "store.json"), "utf8"), "installed");
				mkdirSync(join(environment.HUTCH_HOME, "npm"));
				return process.execPath;
			},
			environmentWithPairedDefaults: hutchResolver.environmentWithPairedDefaults,
		};
		const commands = createAcceptanceCommands({ npmCli, resolver, env, scratch: work, work });
		assert.throws(() => commands.invokeHutch("hutch-version", ["--version"]), /public init must succeed/);
		assert.equal(existsSync(env.HUTCH_HOME), populated);
		const operation = commands.initPublicTemplate(["init", "public-app", "--template=hello-world", "--beta"]);
		if (populated) {
			await assert.rejects(operation, /public init received a populated home/);
			assert.equal(resolutions, 0, "a failed public init must not resolve or run a fallback Hutch");
			assert.throws(() => commands.invokeHutch("hutch-version", ["--version"]), /public init must succeed/);
		} else {
			await operation;
			assert.equal(resolutions, 1);
			assert.equal(existsSync(join(env.HUTCH_HOME, "npm")), true);
			assert.equal((await commands.invokeHutch("hutch-version", ["--version"])).trim(), process.version);
		}
	}
});

test("production installer acceptance invokes the installed launcher without npm defaults", async () => {
	const scratch = join(tmpdir(), "electrobun-production-command-test");
	const env = acceptanceEnvironment({ PATH: "existing-tools", HUTCH_ACTIVE_CHANNEL: "canary" }, scratch, "production-installer");
	const hutch = join(env.HUTCH_HOME, "bin", "hutch");
	const calls = [];
	const commands = createAcceptanceCommands({ hutch, env, scratch, work: scratch },
		async (command, args, options) => { calls.push({ command, args, options }); });
	await commands.initPublicTemplate(["init", "public-app", "--template=hello-world"]);
	await commands.invokeHutch("public-build", ["electrobun", "build"]);
	assert.deepEqual(calls[0].args, ["electrobun", "init", "public-app", "--template=hello-world"]);
	for (const call of calls) {
		assert.equal(call.command, hutch);
		assert.equal(call.options.env.HUTCH_ACTIVE_CHANNEL, "production");
		assert.equal(call.options.env.HUTCH_DEFAULT_CLI, undefined);
		assert.equal(call.options.env.HUTCH_DEFAULT_ELECTROBUN, undefined);
	}
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

test("machine-readable stdout excludes progress but logs and failures retain stderr", async t => {
	const scratch = mkdtempSync(join(tmpdir(), "electrobun-command-output-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const log = join(scratch, "command.log");
	const script = "console.error('downloading pinned CLI'); console.log('/path with spaces/hutch');";
	assert.equal(await run(process.execPath, ["-e", script], { stdoutOnly: true, log }), "/path with spaces/hutch\n");
	assert.match(readFileSync(log, "utf8"), /downloading pinned CLI/);
	assert.match(readFileSync(log, "utf8"), /\/path with spaces\/hutch/);
	assert.match(await run(process.execPath, ["-e", script]), /downloading pinned CLI/);
	await assert.rejects(run(process.execPath, ["-e", "console.error('download failed'); process.exitCode = 7"],
		{ stdoutOnly: true }), /download failed/);
});

test("a startup marker followed by an immediate crash is not successful startup", async () => {
	await assert.rejects(run(process.execPath, ["-e", "console.log('ready');process.exit(1)"], { timeout: 5000, startupMarker: "ready" }), /failed/);
});


test("published desktop acceptance rejects SDK app binaries with the wrong Mac architecture or minimum OS", t => {
	const scratch = mkdtempSync(join(tmpdir(), "electrobun-macos-app-test-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const app = join(scratch, "dev-macos-x64", "SDK App.app", "Contents", "MacOS");
	mkdirSync(app, { recursive: true });
	const main = join(app, "main");
	// A minimal executable with one LC_BUILD_VERSION load command exercises
	// the real byte parser used against built Zig/Rust/Go/Odin main binaries.
	const binary = Buffer.alloc(56);
	binary.writeUInt32LE(0xfeedfacf, 0);
	binary.writeUInt32LE(0x01000007, 4);
	binary.writeUInt32LE(2, 12);
	binary.writeUInt32LE(1, 16);
	binary.writeUInt32LE(24, 20);
	binary.writeUInt32LE(0x32, 32);
	binary.writeUInt32LE(24, 36);
	binary.writeUInt32LE(1, 40);
	binary.writeUInt32LE(14 << 16, 44);
	writeFileSync(main, binary);
	assert.equal(verifyBuiltMacOSApp(scratch, "macos-x64")[0].path, main);
	assert.throws(() => verifyBuiltMacOSApp(scratch, "macos-arm64"), /requires arm64 Mach-O slice/);
	binary.writeUInt32LE(26 << 16, 44);
	writeFileSync(main, binary);
	assert.throws(() => verifyBuiltMacOSApp(scratch, "macos-x64"), /requires macOS 26.0/);
	assert.deepEqual(verifyBuiltMacOSApp(join(scratch, "no-build"), "linux-x64"), []);
	assert.throws(() => verifyBuiltMacOSApp(join(scratch, "no-build"), "macos-x64"), /ENOENT/);
});
