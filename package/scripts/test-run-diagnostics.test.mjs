import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommandWithSignalForwarding } from "./dev.ts";
import { createTestRunDiagnostics } from "./test-run-diagnostics.mjs";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "electrobun-diagnostics-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function command(directory, label, script) {
	return { label, command: process.execPath, args: ["-e", script], cwd: directory };
}

test("keeps failing child output and exit details after a later stage succeeds", async (t) => {
	const directory = fixture(t);
	const stdout = "first assertion context: café 漢字\n";
	const stderr = "AssertionError: expected callback before timeout\n";
	const failing = command(directory, "Rust + system", `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`);
	const passing = command(directory, "Later check", "process.stdout.write('later check passed\\n');");
	const diagnostics = createTestRunDiagnostics("fixture", [failing, passing], {
		temporaryDirectory: directory,
		environment: { HUTCH_RUNTIME: "bun", SECRET_TEST_TOKEN: "must-not-be-recorded" },
	});
	let failure;
	try {
		await diagnostics.run(failing, runCommandWithSignalForwarding);
		assert.fail("the failed stage must not be converted into a pass");
	} catch (error) {
		assert.equal(error.status, 7);
		failure = { command: failing, error };
	}
	// The report and full stream files must already be durable while the suite
	// is still running, even if a later stage hangs or the process is killed.
	const interim = JSON.parse(readFileSync(diagnostics.summaryPath, "utf8"));
	assert.equal(interim.status, "running");
	assert.equal(interim.stages[0].status, "failed");
	assert.equal(readFileSync(interim.stages[0].stdoutLog, "utf8"), stdout);
	assert.equal(readFileSync(interim.stages[0].stderrLog, "utf8"), stderr);
	await diagnostics.run(passing, runCommandWithSignalForwarding);
	diagnostics.finish([failure]);
	const serialized = readFileSync(diagnostics.summaryPath, "utf8");
	const summary = JSON.parse(serialized);
	assert.equal(summary.status, "failed");
	assert.deepEqual(summary.stages.map((stage) => stage.status), ["failed", "passed"]);
	assert.equal(summary.stages[0].exitStatus, 7);
	assert.equal(summary.stages[1].exitStatus, 0);
	assert.equal(summary.stages[0].cwd, directory);
	assert.deepEqual(summary.stages[0].args, failing.args);
	assert.match(summary.stages[0].error.message, /Rust \+ system failed/);
	const combined = readFileSync(summary.stages[0].log, "utf8");
	assert.ok(combined.includes(stdout));
	assert.ok(combined.includes(stderr));
	assert.ok(summary.stages[0].durationMs >= 0);
	assert.ok(summary.startedAt && summary.finishedAt);
	assert.equal(summary.runtime.arch, process.arch);
	assert.equal(summary.runtime.executable, process.execPath);
	assert.equal(summary.runtime.environment.HUTCH_RUNTIME, "bun");
	assert.ok(!serialized.includes("SECRET_TEST_TOKEN"));
	assert.ok(!serialized.includes("must-not-be-recorded"));
});

test("retains interruption identity and distinguishes skipped from unstarted stages", async (t) => {
	const directory = fixture(t);
	const stopped = command(directory, "Interrupted build", "");
	const dependent = { ...command(directory, "Dependent", ""), requires: stopped.label };
	const later = command(directory, "Later", "");
	const diagnostics = createTestRunDiagnostics("fixture", [stopped, dependent, later], { temporaryDirectory: directory });
	const interruption = Object.assign(new Error("interrupted by SIGTERM"), { status: 143 });
	await assert.rejects(diagnostics.run(stopped, async (_command, { onOutput }) => {
		onOutput("stderr", Buffer.from("last message before interruption\n"));
		throw interruption;
	}), (error) => error === interruption);
	diagnostics.recordFailure({ command: dependent, error: new Error("Skipped because build failed") });
	assert.equal(JSON.parse(readFileSync(diagnostics.summaryPath, "utf8")).stages[1].status, "skipped");
	diagnostics.finish([], interruption);
	const summary = JSON.parse(readFileSync(diagnostics.summaryPath, "utf8"));
	assert.equal(summary.status, "interrupted");
	assert.deepEqual(summary.stages.map((stage) => stage.status), ["interrupted", "skipped", "not-run"]);
	assert.equal(summary.stages[0].exitStatus, 143);
	assert.equal(readFileSync(summary.stages[0].stderrLog, "utf8"), "last message before interruption\n");
	assert.equal(existsSync(summary.stages[1].log), false);
	assert.equal(existsSync(summary.stages[2].log), false);
});

test("records spawn errors without inventing a child exit status", async (t) => {
	const directory = fixture(t);
	const missing = { ...command(directory, "Missing runner", ""), command: join(directory, "missing-executable") };
	const diagnostics = createTestRunDiagnostics("fixture", [missing], { temporaryDirectory: directory });
	let failure;
	await assert.rejects(diagnostics.run(missing, runCommandWithSignalForwarding), (error) => {
		failure = { command: missing, error };
		return /Failed to start/.test(error.message);
	});
	diagnostics.finish([failure]);
	const summary = JSON.parse(readFileSync(diagnostics.summaryPath, "utf8"));
	assert.equal(summary.status, "failed");
	assert.equal(summary.stages[0].exitStatus, null);
	assert.match(summary.stages[0].error.message, /missing-executable/);
});
