import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bootstrap = require("../bin/electrobun.cjs");
const testRoot = dirname(fileURLToPath(import.meta.url));
const originalConsoleError = console.error;

afterEach(() => {
	console.error = originalConsoleError;
});

test("uses stable Hutch and stable templates by default", async () => {
	const calls = [];
	const status = await bootstrap.main({
		args: ["init", "my-app"],
		environment: { DASH_HOME: "/home/dev/.dash" },
		existsSync: () => true,
		platform: "linux",
		runHutch: (call) => {
			calls.push(call);
			return 23;
		},
		userHome: "/home/dev",
		// A bootstrap prerelease must never select beta Electrobun templates.
		version: "99.0.0-beta.1",
	});

	assert.equal(status, 23);
	assert.deepEqual(calls, [
		{
			args: ["init", "my-app", "--channel=stable"],
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
		runHutch: ({ args }) => {
			forwardedArgs = args;
			return 0;
		},
		userHome: "/home/dev",
	});

	assert.deepEqual(forwardedArgs, ["init", "my-app", "--beta"]);
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
		runHutch: (call) => {
			forwardedArgs = call.args;
			return 0;
		},
		userHome: "/home/dev",
	});

	assert.deepEqual(forwardedArgs, args);
	assert.deepEqual(args, [
		"build",
		"--env=canary",
		"--",
		"--literal",
		"value with spaces",
	]);
});

test("forwards an empty argument list to Hutch", async () => {
	let forwardedArgs;
	await bootstrap.main({
		args: [],
		environment: {},
		existsSync: () => true,
		platform: "linux",
		runHutch: ({ args }) => {
			forwardedArgs = args;
			return 0;
		},
		userHome: "/home/dev",
	});
	assert.deepEqual(forwardedArgs, []);
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
				args: ["dev", "--watch"],
				binary: "/home/dev/.dash/bin/hutch",
				environment: {},
			},
		},
	]);
});

test("supports an explicit canary Hutch without changing template policy", () => {
	assert.equal(
		bootstrap.hutchChannel({ ELECTROBUN_HUTCH_CHANNEL: "canary" }),
		"canary",
	);
	assert.equal(
		bootstrap.hutchBinaryPath(
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

test("uses the canonical Windows installation path", () => {
	assert.equal(
		bootstrap.hutchBinaryPath(
			"production",
			{ DASH_HOME: "C:\\Users\\dev\\.dash" },
			"win32",
			"C:\\Users\\dev",
		),
		"C:\\Users\\dev\\.dash\\bin\\hutch.exe",
	);
});

test("does not replace a missing explicit Hutch binary", async () => {
	await assert.rejects(
		bootstrap.main({
			args: ["dev"],
			environment: { ELECTROBUN_HUTCH_BINARY: "/custom/hutch" },
			existsSync: () => false,
			platform: "linux",
			userHome: "/home/dev",
		}),
		/ELECTROBUN_HUTCH_BINARY does not exist/,
	);
});

test(
	"the executable passes real argv and exit status through to Hutch",
	{ skip: process.platform === "win32" },
	() => {
		const fixture = mkdtempSync(join(tmpdir(), "electrobun-npm-bootstrap-"));
		try {
			const recordedArguments = join(fixture, "arguments.json");
			const fakeHutch = join(fixture, "fake hutch.cjs");
			writeFileSync(
				fakeHutch,
				[
					"#!/usr/bin/env node",
					'const { writeFileSync } = require("node:fs");',
					"writeFileSync(process.env.RECORDED_ARGUMENTS, JSON.stringify(process.argv.slice(2)));",
					"process.exitCode = 19;",
					"",
				].join("\n"),
			);
			chmodSync(fakeHutch, 0o755);

			const result = spawnSync(
				process.execPath,
				[
					join(testRoot, "..", "bin", "electrobun.cjs"),
					"build",
					"--",
					"value with spaces",
				],
				{
					env: {
						...process.env,
						ELECTROBUN_HUTCH_BINARY: fakeHutch,
						RECORDED_ARGUMENTS: recordedArguments,
					},
					encoding: "utf8",
				},
			);

			if (result.error) throw result.error;
			assert.equal(result.status, 19, result.stderr);
			assert.deepEqual(JSON.parse(readFileSync(recordedArguments, "utf8")), [
				"electrobun",
				"build",
				"--",
				"value with spaces",
			]);
		} finally {
			rmSync(fixture, { force: true, recursive: true });
		}
	},
);
