import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, test } from "node:test";

const require = createRequire(import.meta.url);
const bootstrap = require("../bin/electrobun.cjs");
const resolver = require("../bin/resolve-hutch.cjs");
const manifest = require("../package.json");
const originalConsoleError = console.error;

afterEach(() => {
	console.error = originalConsoleError;
});

const noPlatformPackage = () => {
	throw new Error("platform package absent");
};

test("uses stable Hutch and stable templates by default", async () => {
	const calls = [];
	const status = await bootstrap.main({
		args: ["init", "my-app"],
		environment: { DASH_HOME: "/home/dev/.dash" },
		existsSync: () => true,
		platform: "linux",
		arch: "x64",
		resolvePackageJson: noPlatformPackage,
		runHutch: (call) => {
			calls.push(call);
			return 23;
		},
		userHome: "/home/dev",
	});

	assert.equal(status, 23);
	assert.deepEqual(calls, [
		{
			args: ["electrobun", "init", "my-app", "--channel=stable"],
			binary: "/home/dev/.dash/bin/hutch",
			environment: { DASH_HOME: "/home/dev/.dash" },
		},
	]);
});

test("preserves an explicit beta template request", async () => {
	let forwardedArgs;
	await bootstrap.main({
		args: ["init", "my-app", "--beta"],
		environment: {},
		existsSync: () => true,
		platform: "linux",
		arch: "x64",
		resolvePackageJson: noPlatformPackage,
		runHutch: ({ args }) => {
			forwardedArgs = args;
			return 0;
		},
		userHome: "/home/dev",
	});

	assert.deepEqual(forwardedArgs, ["electrobun", "init", "my-app", "--beta"]);
});

test("preserves an explicit named template channel", () => {
	assert.deepEqual(bootstrap.hutchArguments(["init", "--channel=beta"]), [
		"init",
		"--channel=beta",
	]);
	assert.deepEqual(bootstrap.hutchArguments(["init", "--channel=stable"]), [
		"init",
		"--channel=stable",
	]);
});

test("forwards every non-init command and argument unchanged", async () => {
	let forwardedArgs;
	const args = ["build", "--env=canary", "--", "--literal", "value with spaces"];
	await bootstrap.main({
		args,
		environment: {},
		existsSync: () => true,
		platform: "linux",
		arch: "x64",
		resolvePackageJson: noPlatformPackage,
		runHutch: (call) => {
			forwardedArgs = call.args;
			return 0;
		},
		userHome: "/home/dev",
	});

	assert.deepEqual(forwardedArgs, ["electrobun", ...args]);
});

test("a vendored platform package wins over the global installation", async () => {
	let forwarded;
	let installCalls = 0;
	await bootstrap.main({
		args: ["dev"],
		environment: {},
		existsSync: (candidate) =>
			candidate === "/repo/node_modules/@electrobun/hutch-darwin-arm64/bin/hutch",
		installHutch: async () => {
			installCalls += 1;
		},
		platform: "darwin",
		arch: "arm64",
		resolvePackageJson: (specifier) => {
			assert.equal(specifier, "@electrobun/hutch-darwin-arm64/package.json");
			return "/repo/node_modules/@electrobun/hutch-darwin-arm64/package.json";
		},
		runHutch: (call) => {
			forwarded = call;
			return 0;
		},
		userHome: "/home/dev",
	});

	assert.equal(installCalls, 0);
	assert.equal(
		forwarded.binary,
		"/repo/node_modules/@electrobun/hutch-darwin-arm64/bin/hutch",
	);
});

test("paired toolchain versions are supplied as defaults, never overrides", () => {
	const enriched = resolver.environmentWithPairedDefaults({});
	assert.equal(enriched.HUTCH_DEFAULT_CLI, resolver.PAIRED_HUTCH_VERSION);
	assert.equal(enriched.HUTCH_DEFAULT_ELECTROBUN, manifest.version);
	// Cottontail deliberately has no default env: the build-time runtime is
	// paired inside Hutch, the bundled runtime inside the Electrobun release.
	assert.equal(enriched.HUTCH_DEFAULT_COTTONTAIL, undefined);

	const preset = resolver.environmentWithPairedDefaults({
		HUTCH_DEFAULT_CLI: "9.9.9",
		HUTCH_DEFAULT_ELECTROBUN: "7.7.7",
	});
	assert.equal(preset.HUTCH_DEFAULT_CLI, "9.9.9");
	assert.equal(preset.HUTCH_DEFAULT_ELECTROBUN, "7.7.7");
});

test("platform package names cover exactly the released Hutch platforms", () => {
	assert.equal(
		resolver.platformPackageName("darwin", "arm64"),
		"@electrobun/hutch-darwin-arm64",
	);
	assert.equal(
		resolver.platformPackageName("linux", "x64"),
		"@electrobun/hutch-linux-x64",
	);
	assert.equal(
		resolver.platformPackageName("linux", "arm64"),
		"@electrobun/hutch-linux-arm64",
	);
	assert.equal(
		resolver.platformPackageName("win32", "x64"),
		"@electrobun/hutch-win32-x64",
	);
	assert.equal(resolver.platformPackageName("win32", "arm64"), null);
	assert.equal(resolver.platformPackageName("freebsd", "x64"), null);
});

test("installs a missing stable Hutch before delegation", async () => {
	let installed = false;
	const calls = [];
	console.error = () => {};

	const status = await bootstrap.main({
		args: ["dev", "--watch"],
		environment: {},
		existsSync: () => installed,
		installHutch: async (call) => {
			calls.push({ install: call });
			installed = true;
		},
		platform: "linux",
		arch: "x64",
		resolvePackageJson: noPlatformPackage,
		runHutch: (call) => {
			calls.push({ run: call });
			return 7;
		},
		userHome: "/home/dev",
	});

	assert.equal(status, 7);
	assert.deepEqual(calls, [
		{
			install: {
				channel: "production",
				environment: {},
				platform: "linux",
			},
		},
		{
			run: {
				args: ["electrobun", "dev", "--watch"],
				binary: "/home/dev/.hutch/bin/hutch",
				environment: {},
			},
		},
	]);
});

test("cold offline bootstrap fails before installing Hutch", async () => {
	let installCalls = 0;
	let runCalls = 0;

	await assert.rejects(
		bootstrap.main({
			args: ["build"],
			environment: { DASH_RELEASE_OFFLINE: "1" },
			existsSync: () => false,
			installHutch: async () => {
				installCalls += 1;
			},
			platform: "linux",
			arch: "x64",
			resolvePackageJson: noPlatformPackage,
			runHutch: () => {
				runCalls += 1;
				return 0;
			},
			userHome: "/home/dev",
		}),
		/Hutch is not installed.*DASH_RELEASE_OFFLINE prevents downloading it/,
	);

	assert.equal(installCalls, 0);
	assert.equal(runCalls, 0);
});

test("warm offline bootstrap still delegates to Hutch", async () => {
	let installCalls = 0;
	const calls = [];
	const environment = {
		DASH_HOME: "/home/dev/.dash",
		DASH_RELEASE_OFFLINE: "yes",
	};

	const status = await bootstrap.main({
		args: ["build", "--env=stable"],
		environment,
		existsSync: () => true,
		installHutch: async () => {
			installCalls += 1;
		},
		platform: "linux",
		arch: "x64",
		resolvePackageJson: noPlatformPackage,
		runHutch: (call) => {
			calls.push(call);
			return 29;
		},
		userHome: "/home/dev",
	});

	assert.equal(status, 29);
	assert.equal(installCalls, 0);
	assert.deepEqual(calls, [
		{
			args: ["electrobun", "build", "--env=stable"],
			binary: "/home/dev/.dash/bin/hutch",
			environment,
		},
	]);
});

test("supports an explicit canary Hutch without changing template policy", () => {
	assert.equal(
		resolver.hutchChannel({ ELECTROBUN_HUTCH_CHANNEL: "canary" }),
		"canary",
	);
	assert.equal(
		resolver.globalHutchBinaryPath(
			"canary",
			{ DASH_HOME: "/opt/dash" },
			"linux",
			"/home/dev",
		),
		"/opt/dash/bin/hutch-canary",
	);
	assert.deepEqual(bootstrap.hutchArguments(["init"]), [
		"init",
		"--channel=stable",
	]);
});

test("an explicit ELECTROBUN_HUTCH_BINARY must exist", async () => {
	await assert.rejects(
		bootstrap.main({
			args: ["dev"],
			environment: { ELECTROBUN_HUTCH_BINARY: "/missing/hutch" },
			existsSync: () => false,
			platform: "linux",
			arch: "x64",
			resolvePackageJson: noPlatformPackage,
			runHutch: () => 0,
			userHome: "/home/dev",
		}),
		/ELECTROBUN_HUTCH_BINARY does not exist/,
	);
});
