import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessRun, instrumentGoSource, runDiagnosticProcess } from "./window-size-diagnostic.mjs";

const original = readFileSync(new URL("../../kitchen/src/go/main.go", import.meta.url), "utf8");
const instrumented = instrumentGoSource(original);
const extract = (source) => source.slice(source.indexOf("func runWindowSetSizeTest() error {"), source.indexOf("\nfunc runWindowSetFrameTest()"));

test("instrumentation leaves all other Kitchen source bytes untouched", () => {
	assert.equal(instrumented.replace(extract(instrumented), "FIXTURE"), original.replace(extract(original), "FIXTURE"));
	assert.throws(() => instrumentGoSource(instrumented), /insertion point/);
});

test("active resize operations, reads, waits, assertions and failures remain byte-for-byte original", () => {
	const active = extract(instrumented).slice(extract(instrumented).indexOf("\tcreated, err :="), extract(instrumented).indexOf("\t// The original failure"))
		.replace('\t\tdiagnosticRecord("grown-original-read", grown, nil)\n', "")
		.replace('\t\tdiagnosticRecord("shrunk-original-read", shrunk, nil)\n', "");
	const baseline = extract(original).slice(extract(original).indexOf("\tcreated, err :="), extract(original).indexOf("\treturn finishWithWindow"));
	assert.equal(active, baseline);
	assert.equal((active.match(/GetWindowFrame\(/g) ?? []).length, 2);
	assert.equal((active.match(/time.Sleep\(shortWait\)/g) ?? []).length, 3);
	assert.doesNotMatch(active, /Fprintf|Println|Printf/);
});

test("additional observations are bounded, conditional on fixed original failure and preserve its return", () => {
	const extra = extract(instrumented).split("\t// The original failure")[1];
	assert.match(extra, /if err != nil \{[\s\S]*diagnosticError = err.Error\(\)[\s\S]*sample < 20/);
	assert.match(extra, /time.Sleep\(100 \* time.Millisecond\)/);
	assert.equal((extra.match(/GetWindowFrame\(/g) ?? []).length, 1);
	assert.doesNotMatch(extra, /(?:^|\n)\s*err\s*[:=]/);
	assert.match(extra, /return finishWithWindow\(created.windowID, err\)/);
});

test("optional prefix calls original fullscreen and position tests in their original order", () => {
	const body = extract(instrumented);
	assert.ok(body.indexOf('os.Getenv("WINDOW_SIZE_DIAGNOSTIC_PREFIX") == "1"') < body.indexOf("diagnosticStarted :="));
	assert.ok(body.indexOf("runWindowFullscreenToggleTest(false)") < body.indexOf("runWindowFullscreenToggleTest(true)"));
	assert.ok(body.indexOf("runWindowFullscreenToggleTest(true)") < body.indexOf('{"set-position", runWindowSetPositionTest}'));
});

const record = { prefix: false, originalError: "", shortWaitMs: 150, frames: [{ phase: "grown-original-read" }, { phase: "shrunk-original-read" }] };
function logFor(value = record) {
	return '[kitchen go] auto-running test: go-window-set-size\n[kitchen go] completed test: Window setSize (Go) -> passed\n[kitchen go] auto-run complete; exiting with code 0\n[go-native] [window-size-diagnostic] ' + JSON.stringify(value);
}

test("success requires the actual selected test, both original frames and a successful process", () => {
	assert.equal(assessRun(logFor(), 0, false).passed, true);
	assert.equal(assessRun(logFor(), 1, false).passed, false);
	assert.equal(assessRun(logFor(), 0, false, "Diagnostic watchdog expired").passed, false);
	assert.equal(assessRun(logFor(), 0, false, undefined, "SIGKILL").passed, false);
	assert.equal(assessRun(logFor().replace("go-window-set-size", "another-test"), 0, false).passed, false);
	assert.equal(assessRun(logFor({ ...record, frames: [] }), 0, false).passed, false);
	assert.equal(assessRun(logFor({ ...record, shortWaitMs: 300 }), 0, false).passed, false);
	assert.equal(assessRun(logFor(), 0, true).passed, false);
});

test("later convergence cannot conceal the original failure and missing/duplicate telemetry fails", () => {
	const failed = { ...record, originalError: "unexpected shrunk size 420x308", frames: [...record.frames, { phase: "post-failure", frame: { Width: 320, Height: 240 } }] };
	assert.equal(assessRun(logFor(failed), 0, false).passed, false);
	assert.equal(assessRun("", 0, false).passed, false);
	assert.equal(assessRun(`${logFor()}\n${logFor()}`, 0, false).passed, false);
});

test("outer watchdog kills a stalled launcher and its separately grouped descendant", async () => {
	const result = await runDiagnosticProcess(process.execPath, ["-e", `
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true, stdio:'inherit'});
console.log('descendant='+child.pid);
setInterval(()=>{},1000);
`], {}, 500);
	assert.equal(result.error, "Diagnostic watchdog expired");
	assert.equal(result.signal, "SIGKILL");
	const pid = Number(result.log.match(/descendant=(\d+)/)?.[1]);
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
