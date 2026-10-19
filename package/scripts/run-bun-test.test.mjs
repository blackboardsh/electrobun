import assert from "node:assert/strict";
import test from "node:test";
import { runBunTests } from "./run-bun-test.js";

test("Bun suite verifies runtime identity, overrides local Cottontail, and propagates failures", () => {
	const calls = [];
	const status = runBunTests(["first.test.ts", "second.test.ts"], {
		hutch: "/selected/hutch",
		environment: { HUTCH_RUNTIME: "cottontail", COTTONTAIL_BINARY: "/local/cottontail" },
		spawn(...args) { calls.push(args); return { status: calls.length === 1 ? 0 : 7 }; },
	});
	assert.equal(status, 7);
	assert.equal(calls[0][0], "/selected/hutch");
	assert.match(calls[0][1][1], /process\.versions\.cottontail/);
	assert.deepEqual(calls[1][1], ["test", "first.test.ts", "second.test.ts"]);
	assert.equal(calls[1][2].env.HUTCH_RUNTIME, "bun");
});

test("an old Hutch cannot silently run application tests on Cottontail", () => {
	let calls = 0;
	assert.equal(runBunTests(["suite.test.ts"], {
		spawn() { calls++; return { status: 1 }; }, report() {},
	}), 1);
	assert.equal(calls, 1);
});

test("empty test selection fails without invoking the runtime", () => {
	assert.equal(runBunTests([], { spawn() { throw new Error("unexpected spawn"); }, report() {} }), 1);
});

test("Bun probes and tests inherit the same launcher, with explicit overrides taking precedence", () => {
	for (const environment of [
		{ HUTCH_LAUNCHER_PATH: "C:\\ARM tools\\hutch-canary.exe" },
		{ HUTCH_LAUNCHER_PATH: "C:\\ARM tools\\hutch-canary.exe", HUTCH_BINARY: "/local/hutch" },
		{},
	]) {
		const expected = environment.HUTCH_BINARY || environment.HUTCH_LAUNCHER_PATH || "hutch";
		const calls = [];
		assert.equal(runBunTests(["suite.test.ts"], {
			environment: Object.freeze(environment),
			spawn(...args) { calls.push(args); return { status: 0 }; },
		}), 0);
		assert.deepEqual(calls.map(([binary]) => binary), [expected, expected]);
		assert.deepEqual(calls[1][2].env, { ...environment, HUTCH_RUNTIME: "bun" });
	}
});
