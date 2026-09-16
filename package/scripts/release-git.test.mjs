import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	assertReleaseGitState,
	pushReleaseAtomically,
} from "./release-git.mjs";

test("release Git preflight accepts only a clean main branch", () => {
	const calls = [];
	const outputs = ["main\n", ""];
	assertReleaseGitState("/repo", (args, options) => {
		calls.push({ args, options });
		return outputs.shift();
	});
	assert.deepEqual(calls, [
		{
			args: ["branch", "--show-current"],
			options: { cwd: "/repo", encoding: "utf8" },
		},
		{
			args: ["status", "--porcelain=v1", "--untracked-files=all"],
			options: { cwd: "/repo", encoding: "utf8" },
		},
	]);
});

test("release Git preflight rejects other branches and detached HEAD", () => {
	for (const branch of ["release/v2\n", ""]) {
		const calls = [];
		assert.throws(
			() =>
				assertReleaseGitState("/repo", (args) => {
					calls.push(args);
					return branch;
				}),
			/main branch/,
		);
		assert.deepEqual(calls, [["branch", "--show-current"]]);
	}
});

test("release Git preflight rejects modified and untracked files", () => {
	for (const status of [" M package/package.json\n", "?? scratch.txt\n"]) {
		const outputs = ["main\n", status];
		assert.throws(
			() => assertReleaseGitState("/repo", () => outputs.shift()),
			/clean worktree/,
		);
	}
});

test("release push atomically updates only main HEAD and the exact tag", () => {
	const calls = [];
	pushReleaseAtomically("/repo", "v2.0.1-beta.0", (args, options) => {
		calls.push({ args, options });
	});
	assert.deepEqual(calls, [
		{
			args: [
				"push",
				"--atomic",
				"origin",
				"HEAD:refs/heads/main",
				"refs/tags/v2.0.1-beta.0:refs/tags/v2.0.1-beta.0",
			],
			options: { cwd: "/repo", stdio: "inherit" },
		},
	]);
	assert.ok(!calls[0].args.includes("--tags"));
});

test("release push rejects invalid tags before invoking Git", () => {
	for (const tagName of ["2.0.1-beta.0", "vlatest", "v2.0.1-beta.01"]) {
		let calls = 0;
		assert.throws(() =>
			pushReleaseAtomically("/repo", tagName, () => {
				calls += 1;
			}),
		);
		assert.equal(calls, 0);
	}
});

test("push-version preflights before mutation and uses the exact atomic push", () => {
	const source = readFileSync(new URL("./push-version.js", import.meta.url), "utf8");
	const preflight = source.indexOf("assertReleaseGitState(repoRoot)");
	const mutation = source.indexOf("execSync(`npm version ${versionCmd}");
	assert.notEqual(preflight, -1);
	assert.notEqual(mutation, -1);
	assert.ok(preflight < mutation);
	assert.match(source, /pushReleaseAtomically\(repoRoot, tagName\)/);
	assert.doesNotMatch(source, /git push origin main --tags|\[\s*["']--tags["']/);
});
