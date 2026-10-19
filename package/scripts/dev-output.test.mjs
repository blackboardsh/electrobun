import assert from "node:assert/strict";
import test from "node:test";
import { runCommandWithSignalForwarding } from "./dev.ts";

function command(program) {
	return {
		label: "Output capture fixture",
		command: process.execPath,
		args: ["-e", program],
		cwd: process.cwd(),
	};
}

test("records both child streams while preserving bytes through process close", async () => {
	const chunks = { stdout: [], stderr: [] };
	await runCommandWithSignalForwarding(command(
		"process.stdout.write('stdout ✓\\n'); process.stderr.write('stderr ✓\\n');",
	), {
		onOutput(stream, chunk) {
			assert.ok(Buffer.isBuffer(chunk));
			chunks[stream].push(chunk);
		},
	});
	assert.equal(Buffer.concat(chunks.stdout).toString(), "stdout ✓\n");
	assert.equal(Buffer.concat(chunks.stderr).toString(), "stderr ✓\n");
});

test("retains the failed assertion and exit status from a failing child", async () => {
	let output = "";
	await assert.rejects(runCommandWithSignalForwarding(command(
		"process.stderr.write('specific assertion failed\\n'); process.exitCode = 7;",
	), {
		onOutput(_stream, chunk) { output += chunk.toString(); },
	}), (error) => {
		assert.equal(error.status, 7);
		assert.equal(error.signal, null);
		return true;
	});
	assert.equal(output, "specific assertion failed\n");
});

test("a failed output recorder terminates its child and reports the original cause", { timeout: 10_000 }, async () => {
	const recordingFailure = new Error("fixture disk full");
	let childPid;
	const signalListenerCounts = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	await assert.rejects(runCommandWithSignalForwarding(command(
		"process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000);",
	), {
		onOutput(_stream, chunk) {
			childPid = Number(chunk.toString().trim());
			throw recordingFailure;
		},
	}), (error) => {
		assert.match(error.message, /Could not record output/);
		assert.equal(error.cause, recordingFailure);
		return true;
	});
	assert.ok(Number.isInteger(childPid) && childPid > 0);
	assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
	assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signalListenerCounts);
});

test("a missing child executable remains a normal start failure with capture enabled", async () => {
	await assert.rejects(runCommandWithSignalForwarding({
		...command(""), command: `${process.execPath}.missing-fixture`,
	}, { onOutput() {} }), (error) => {
		assert.match(error.message, /Failed to start/);
		assert.equal(error.code, "ENOENT");
		assert.equal(error.cause.code, "ENOENT");
		return true;
	});
});
