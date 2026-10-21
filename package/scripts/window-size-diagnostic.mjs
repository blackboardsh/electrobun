#!/usr/bin/env node
// Diagnostic only: preserve the original resize decisions and observe any
// failed frame afterwards, using the exact release core and native wrapper.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectHutchBinary } from "./hutch-launcher.mjs";
import { validateNativeDevkitManifest } from "./validate-native-devkit.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(repository, "package/dist");
const diagnostics = resolve(process.env.WINDOW_SIZE_DIAGNOSTICS ?? join(repository, "window-size-diagnostics"));
const marker = "[window-size-diagnostic] ";
const nativeFiles = ["libElectrobunCore.dylib", "libNativeWrapper.dylib", "libasar.dylib", "libwebgpu_dawn.dylib"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) => sha256(readFileSync(path));

function replaceOnce(source, original, replacement) {
	if (source.split(original).length !== 2) throw new Error(`Expected exactly one diagnostic insertion point: ${original}`);
	return source.replace(original, replacement);
}

export function instrumentGoSource(source) {
	if (source.includes("diagnosticStarted :=")) throw new Error("Diagnostic insertion point is already instrumented");
	const start = source.indexOf("func runWindowSetSizeTest() error {");
	const end = source.indexOf("\nfunc runWindowSetFrameTest()", start);
	if (start < 0 || end < 0) throw new Error("Could not locate the original Go resize fixture");
	let body = source.slice(start, end);
	body = replaceOnce(body, "func runWindowSetSizeTest() error {", `func runWindowSetSizeTest() error {
	if os.Getenv("WINDOW_SIZE_DIAGNOSTIC_PREFIX") == "1" {
		for _, prefix := range []struct { name string; run func() error }{
			{"fullscreen-normal", func() error { return runWindowFullscreenToggleTest(false) }},
			{"fullscreen-hidden", func() error { return runWindowFullscreenToggleTest(true) }},
			{"set-position", runWindowSetPositionTest},
		} {
			if err := prefix.run(); err != nil { return fmt.Errorf("diagnostic prefix %s: %w", prefix.name, err) }
		}
	}
	diagnosticStarted := time.Now()
	diagnosticFrames := []map[string]interface{}{}
	diagnosticRecord := func(phase string, frame electrobun.Rect, err error) {
		entry := map[string]interface{}{"phase": phase, "elapsedMs": time.Since(diagnosticStarted).Milliseconds(), "frame": frame}
		if err != nil { entry["error"] = err.Error() }
		diagnosticFrames = append(diagnosticFrames, entry)
	}`);
	// These are the fixture's existing returned frames. Do not introduce a
	// synchronous UI-queue read (or console I/O) during its active assertions.
	body = replaceOnce(body, "\t\tif !approxEq(grown.Width", "\t\tdiagnosticRecord(\"grown-original-read\", grown, nil)\n\t\tif !approxEq(grown.Width");
	body = replaceOnce(body, "\t\tif !approxEq(shrunk.Width", "\t\tdiagnosticRecord(\"shrunk-original-read\", shrunk, nil)\n\t\tif !approxEq(shrunk.Width");
	body = replaceOnce(body, "\treturn finishWithWindow(created.windowID, err)", `	// The original failure is fixed before additional reads; later convergence
	// cannot change its error, tolerance, deadline, or process result.
	diagnosticError := ""
	if err != nil {
		diagnosticError = err.Error()
		for sample := 0; sample < 20; sample++ {
			time.Sleep(100 * time.Millisecond)
			frame, sampleErr := state.core.GetWindowFrame(created.windowID)
			diagnosticRecord("post-failure", frame, sampleErr)
		}
	}
	diagnosticJSON, _ := json.Marshal(map[string]interface{}{
		"windowId": created.windowID, "prefix": os.Getenv("WINDOW_SIZE_DIAGNOSTIC_PREFIX") == "1",
		"originalError": diagnosticError, "shortWaitMs": shortWait.Milliseconds(), "frames": diagnosticFrames,
	})
	fmt.Fprintf(os.Stderr, "[window-size-diagnostic] %s\\n", diagnosticJSON)
	return finishWithWindow(created.windowID, err)`);
	return source.slice(0, start) + body + source.slice(end);
}

function command(binary, args, options = {}) {
	const result = spawnSync(binary, args, { cwd: repository, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${binary} exited ${result.status} (${result.signal ?? "no signal"})`);
	return result;
}

function save(name, value) {
	writeFileSync(join(diagnostics, name), `${JSON.stringify(value, null, 2)}\n`);
}

function prepare() {
	const artifactSha = process.env.ARTIFACT_SHA;
	if (!/^[a-f0-9]{40}$/.test(artifactSha ?? "")) throw new Error("Expected exact ARTIFACT_SHA");
	const run = JSON.parse(readFileSync(join(diagnostics, "artifact-run.json"), "utf8"));
	if (run.head_sha !== artifactSha || String(run.id) !== process.env.ARTIFACT_RUN_ID || run.path !== ".github/workflows/release.yml") throw new Error("Unexpected release artifact provenance");
	const sourcePath = join(repository, "kitchen/src/go/main.go");
	const source = readFileSync(sourcePath, "utf8");
	const originalSource = command("git", ["show", `${artifactSha}:kitchen/src/go/main.go`], { stdio: "pipe", encoding: "utf8" }).stdout;
	if (source !== originalSource) throw new Error("Kitchen Go source differs from the artifact release before instrumentation");
	if (existsSync(dist) && readdirSync(dist).length) throw new Error("Expected an empty devkit destination; refusing to mix artifacts");
	mkdirSync(dist, { recursive: true });
	const archive = join(repository, "diagnostic-artifacts/electrobun-core-darwin-arm64.tar.gz");
	command("tar", ["-xzf", archive, "-C", dist]);
	const version = JSON.parse(readFileSync(join(repository, "package/package.json"), "utf8")).version;
	validateNativeDevkitManifest({ coreRoot: dist, expectedVersion: version, expectedTarget: { os: "macos", arch: "arm64" } });
	command(process.execPath, ["package/scripts/verify-macho-deployment-target.js", "--arch=arm64", dist]);
	const instrumented = instrumentGoSource(source);
	writeFileSync(join(diagnostics, "original-main.go"), source);
	writeFileSync(join(diagnostics, "instrumented-main.go"), instrumented);
	writeFileSync(sourcePath, instrumented);
	save("provenance.json", {
		artifactRun: run.id, artifactSourceRevision: artifactSha, artifactSha256: fileHash(archive), version,
		diagnosticSourceRevision: command("git", ["rev-parse", "HEAD"], { stdio: "pipe", encoding: "utf8" }).stdout.trim(),
		originalSourceSha256: sha256(source), instrumentedSourceSha256: sha256(instrumented),
		nativeArtifacts: Object.fromEntries(nativeFiles.map((name) => [name, fileHash(join(dist, name))])),
		limitations: "Frame observations do not reveal AppKit size constraints or identify an immediate clamp versus a later restoration.",
	});
}

export function assessRun(log, status, prefix, error, signal) {
	const records = log.split("\n").filter((line) => line.includes(marker)).map((line) => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
	const selected = log.includes("[kitchen go] auto-running test: go-window-set-size");
	const completed = log.includes("[kitchen go] completed test: Window setSize (Go) -> passed") && log.includes("[kitchen go] auto-run complete; exiting with code 0");
	const validRecord = records.length === 1 && records[0].prefix === prefix && records[0].shortWaitMs === 150;
	const originalReadPhases = validRecord ? records[0].frames.filter((frame) => frame.phase !== "post-failure").map((frame) => frame.phase) : [];
	const passed = !error && !signal && status === 0 && selected && completed && validRecord && records[0].originalError === "" && originalReadPhases.join(",") === "grown-original-read,shrunk-original-read";
	return { passed, selected, completed, records };
}

function verifyBundledNative(provenance) {
	const root = join(repository, "kitchen/build/matrix/go-native/dev-macos-arm64");
	const apps = readdirSync(root).filter((name) => name.endsWith(".app"));
	if (apps.length !== 1) throw new Error("Expected one Go native Kitchen app");
	const executableRoot = join(root, apps[0], "Contents/MacOS");
	const hashes = Object.fromEntries(nativeFiles.map((name) => [name, fileHash(join(executableRoot, name))]));
	for (const name of nativeFiles) {
		if (hashes[name] !== provenance.nativeArtifacts[name] || fileHash(join(dist, name)) !== hashes[name]) throw new Error(`Native artifact changed: ${name}`);
	}
	return hashes;
}

export function runDiagnosticProcess(binary, args, options = {}, timeout = 75_000) {
	return new Promise((resolveResult) => {
		const child = spawn(binary, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let log = "", error, settled = false, forcedFinish;
		const finish = (status, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(forcedFinish);
			resolveResult({ status, signal, error, log });
		};
		const terminate = (message) => {
			if (error) return;
			error = message;
			// Kitchen launches its own groups. Capture descendants before killing
			// their parents, then reap every owned group and individual process.
			const snapshot = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
			const rows = (snapshot.stdout ?? "").trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
			const owned = new Set([child.pid]);
			let previous;
			do { previous = owned.size; for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid); } while (previous !== owned.size);
			for (const pid of [...owned].reverse()) {
				if (!Number.isSafeInteger(pid) || pid < 1) continue;
				try { process.kill(-pid, "SIGKILL"); } catch {}
				try { process.kill(pid, "SIGKILL"); } catch {}
			}
			forcedFinish = setTimeout(() => {
				child.stdout.destroy(); child.stderr.destroy(); finish(null, "SIGKILL");
			}, 1000);
		};
		const deadline = setTimeout(() => terminate("Diagnostic watchdog expired"), timeout);
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
			log += chunk.toString();
			if (Buffer.byteLength(log) > 20 * 1024 * 1024) terminate("Diagnostic output limit exceeded");
		});
		child.on("error", (failure) => { error = failure.message; finish(null, null); });
		child.on("close", finish);
	});
}

async function run() {
	const provenance = JSON.parse(readFileSync(join(diagnostics, "provenance.json"), "utf8"));
	if (fileHash(join(repository, "kitchen/src/go/main.go")) !== provenance.instrumentedSourceSha256) throw new Error("Instrumented source changed before launch");
	const results = [];
	for (const prefix of [false, true]) {
		for (let attempt = 1; attempt <= (prefix ? 3 : 10); attempt++) {
			const label = `${prefix ? "prefix" : "selected"}-${attempt}`;
			const hashes = verifyBundledNative(provenance);
			const processResult = await runDiagnosticProcess(selectHutchBinary(), ["scripts/kitchen-matrix.ts", "--launch-only", "--with=go:native", "--timeout=60"], {
				cwd: join(repository, "kitchen"),
				env: { ...process.env, HUTCH_ELECTROBUN_DEVKIT_ROOT: dist, AUTO_RUN: "", AUTO_RUN_TEST_NAME: "go-window-set-size", WINDOW_SIZE_DIAGNOSTIC_PREFIX: prefix ? "1" : "0" },
			});
			const log = processResult.log;
			writeFileSync(join(diagnostics, `${label}.log`), log);
			const result = { label, prefix, attempt, status: processResult.status, signal: processResult.signal, error: processResult.error, nativeArtifacts: hashes, ...assessRun(log, processResult.status, prefix, processResult.error, processResult.signal) };
			results.push(result);
			save("results.json", results);
			console.log(JSON.stringify(result));
			verifyBundledNative(provenance);
			if (processResult.error || processResult.signal) throw new Error(`${label}: diagnostic process did not exit normally`);
		}
	}
	if (results.some((result) => !result.passed)) throw new Error("At least one original resize decision failed or required evidence is missing; inspect results.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Run on native macOS ARM64");
	mkdirSync(diagnostics, { recursive: true });
	if (process.argv[2] === "prepare") prepare();
	else if (process.argv[2] === "run") await run();
	else throw new Error("Usage: window-size-diagnostic.mjs prepare|run");
}
