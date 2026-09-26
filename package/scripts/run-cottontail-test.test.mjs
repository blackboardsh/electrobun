import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	collectTestFiles,
	isDirectEntry,
	resolveTestArgs,
	runTestsIndividually,
	testExitCode,
} from "./run-cottontail-test.js";

test("recognizes direct execution without relying on import.meta.main", () => {
	const wrapperUrl = new URL("./run-cottontail-test.js", import.meta.url);
	assert.equal(isDirectEntry(wrapperUrl.href, fileURLToPath(wrapperUrl)), true);
	assert.equal(isDirectEntry(wrapperUrl.href, fileURLToPath(import.meta.url)), false);
	assert.equal(isDirectEntry(wrapperUrl.href, undefined), false);
});

test("resolves directories while preserving files and non-filesystem filters", () => {
	const collected = [];
	const resolved = resolveTestArgs(
		["unit-suite", "direct.test.ts", "name-filter"],
		{
			stat(path) {
				if (path === "unit-suite") return { isDirectory: () => true };
				if (path === "direct.test.ts") return { isDirectory: () => false };
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
			collect(path) {
				collected.push(path);
				return ["unit-suite/a.test.ts", "unit-suite/b.spec.ts"];
			},
		},
	);

	assert.deepEqual(collected, ["unit-suite"]);
	assert.deepEqual(resolved, [
		"unit-suite/a.test.ts",
		"unit-suite/b.spec.ts",
		"direct.test.ts",
		"name-filter",
	]);
});

test("runs every resolved test separately and collects every failure", () => {
	const invocations = [];
	const reported = [];
	const outcomes = [
		{ status: 7, signal: null, error: undefined },
		{ status: null, signal: null, error: new Error("could not spawn") },
		{ status: 0, signal: null, error: undefined },
	];

	const failures = runTestsIndividually(
		"C:\\tool chain\\cottontail.exe",
		["first.test.ts", "second.test.ts", "third.test.ts"],
		{
			spawn(binary, args, options) {
				invocations.push({ binary, args, options });
				return outcomes[invocations.length - 1];
			},
			reportFailure(testArg, result) {
				reported.push({ testArg, result });
			},
		},
	);

	assert.deepEqual(
		invocations.map(({ binary, args, options }) => ({
			binary,
			args,
			stdio: options.stdio,
		})),
		[
			{
				binary: "C:\\tool chain\\cottontail.exe",
				args: ["test", "first.test.ts"],
				stdio: "inherit",
			},
			{
				binary: "C:\\tool chain\\cottontail.exe",
				args: ["test", "second.test.ts"],
				stdio: "inherit",
			},
			{
				binary: "C:\\tool chain\\cottontail.exe",
				args: ["test", "third.test.ts"],
				stdio: "inherit",
			},
		],
	);
	assert.deepEqual(
		reported.map(({ testArg }) => testArg),
		["first.test.ts", "second.test.ts"],
	);
	assert.equal(failures.length, 2);
	assert.equal(testExitCode(failures), 1);
});

test("returns success only when every invocation succeeds", () => {
	const failures = runTestsIndividually("cottontail", ["only.test.ts"], {
		spawn: () => ({ status: 0, signal: null, error: undefined }),
	});
	assert.deepEqual(failures, []);
	assert.equal(testExitCode(failures), 0);
});

test("leaves node:test suites to Node's runner when expanding directories", () => {
	const entry = (name) => ({ name, isDirectory: () => false, isFile: () => true });
	// path.join uses the host separator, so both the fixture keys and the
	// expected result must be built with join() to work on Windows and POSIX.
	const cottontailPath = join("suite", "cottontail.test.ts");
	const nodePath = join("suite", "node.test.js");
	const helperPath = join("suite", "helper.ts");
	const sources = {
		[cottontailPath]: 'import { test } from "bun:test";',
		[nodePath]: 'import { test } from "node:test";',
		[helperPath]: "",
	};
	const files = collectTestFiles(
		"suite",
		() => [entry("node.test.js"), entry("cottontail.test.ts"), entry("helper.ts")],
		(path) => sources[path],
	);
	assert.deepEqual(files, [cottontailPath]);
});
