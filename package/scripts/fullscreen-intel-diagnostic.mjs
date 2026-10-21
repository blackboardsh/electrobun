#!/usr/bin/env node
// Diagnostic-only: reuse a CI devkit, replace only its native window wrapper,
// and exercise the same packaged Kitchen tests used by the full VM suite.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CEF_VERSION, CHROMIUM_VERSION } from "../src/shared/cef-version.ts";
import { ownedBuildDependencyArtifact } from "../src/shared/build-dependencies.ts";
import { MACOS_DEPLOYMENT_TARGET, macosNativeArchitecture } from "./macos-release.js";
import { validateNativeDevkitManifest } from "./validate-native-devkit.mjs";
import { selectHutchBinary } from "./hutch-launcher.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(packageRoot, "..");
const dist = join(packageRoot, "dist");
const diagnostics = resolve(process.env.FULLSCREEN_DIAGNOSTICS ?? join(repository, "fullscreen-diagnostics"));
mkdirSync(diagnostics, { recursive: true });

function command(binary, args, options = {}) {
	console.log(`+ ${binary} ${args.join(" ")}`);
	const result = spawnSync(binary, args, { cwd: packageRoot, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${binary} exited ${result.status} (${result.signal ?? "no signal"})`);
	return result;
}

function download(url, output) {
	command("curl", ["--proto", "=https", "--tlsv1.2", "--fail", "--location", "--retry", "3", "--silent", "--show-error", url, "--output", output]);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function recordContext(label, full = true) {
	spawnSync("screencapture", ["-x", join(diagnostics, `${label}.png`)], { timeout: 10_000 });
	const commands = [
		["sw_vers", []], ["uname", ["-a"]],
		["sysctl", ["-n", "hw.model", "hw.ncpu", "hw.memsize"]],
		["stat", ["-f", "%Su", "/dev/console"]],
		["launchctl", ["print", `gui/${process.getuid()}`]],
		["defaults", ["read", "com.apple.spaces"]],
		["defaults", ["read", "NSGlobalDomain"]],
		["defaults", ["read", "NSGlobalDomain", "NSAutomaticWindowAnimationsEnabled"]],
		["defaults", ["read", "com.apple.dock"]],
		["defaults", ["read", "com.apple.universalaccess"]],
		["ps", ["-axo", "pid,ppid,state,etime,command"]],
	];
	const context = (full ? commands : commands.slice(-1)).map(([binary, args]) => {
		const result = spawnSync(binary, args, { encoding: "utf8", timeout: 2000 });
		return { binary, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
	});
	writeFileSync(join(diagnostics, `${label}-desktop.json`), JSON.stringify(context, null, 2));
}

function captureCommand(label, binary, args, timeout = 10_000) {
	return new Promise((resolveCapture) => {
		const output = createWriteStream(join(diagnostics, `${label}.log`));
		const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => output.write(chunk));
		const finish = (status, signal, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			output.end(() => resolveCapture({ label, binary, args, status, signal, timedOut, error }));
		};
		child.on("error", (error) => finish(1, null, error.message));
		child.on("close", (status, signal) => finish(status, signal));
	});
}

async function captureTransitionContext(label, firstWillEnter) {
	// Keep stdout/stderr draining while the app transitions. Static preferences
	// are recorded before/after; only screenshot and live processes run here.
	const captured = await Promise.all([
		captureCommand(`${label}-during-screenshot`, "screencapture", ["-x", join(diagnostics, `${label}-during.png`)]),
		captureCommand(`${label}-during-processes`, "ps", ["-axo", "pid,ppid,state,etime,command"]),
	]);
	writeFileSync(join(diagnostics, `${label}-during-desktop.json`), JSON.stringify({ firstWillEnter, captured }, null, 2));
}

async function sampleStalledEntry(label, appPid) {
	const targets = [{ name: "app", pid: appPid }];
	for (const name of ["Dock", "WindowServer"]) {
		const lookup = `${label}-pgrep-${name}`;
		await captureCommand(lookup, "pgrep", ["-x", name], 2000);
		const pid = Number(readFileSync(join(diagnostics, `${lookup}.log`), "utf8").trim().split(/\s+/)[0]);
		if (Number.isSafeInteger(pid) && pid > 0) targets.push({ name, pid });
	}
	const results = await Promise.all(targets.map(({ name, pid }) => {
		const args = [String(pid), "2", "1", "-file", join(diagnostics, `${label}-${name}-sample.txt`)];
		return name === "WindowServer"
			? captureCommand(`${label}-${name}-sample-command`, "sudo", ["-n", "sample", ...args])
			: captureCommand(`${label}-${name}-sample-command`, "sample", args);
	}));
	writeFileSync(join(diagnostics, `${label}-sample-results.json`), JSON.stringify(results, null, 2));
}

async function runObservedProcess(label, binary, args, options = {}, timeout = 75_000) {
	const output = createWriteStream(join(diagnostics, `${label}.log`));
	const observations = [];
	let entered = false;
	let firstWillEnter = null;
	let snapshotTimer;
	let sampleTimer;
	const result = await new Promise((resolveResult) => {
		const child = spawn(binary, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let timedOut = false;
		let settled = false;
		let hardKill;
		let settleDeadline;
		const deadline = setTimeout(() => {
			timedOut = true;
			// Kitchen isolates its own Hutch/app process groups. Snapshot the
			// complete tree before asking the matrix runner to stop gracefully.
			const processList = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
			const tree = processList.stdout?.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)) ?? [];
			const owned = new Set([child.pid]);
			let previousSize;
			do {
				previousSize = owned.size;
				for (const [pid, ppid] of tree) if (owned.has(ppid)) owned.add(pid);
			} while (owned.size !== previousSize);
			const signalTree = (signal) => {
				for (const pid of [...owned].reverse()) {
					if (!Number.isSafeInteger(pid) || pid < 1) continue;
					try { process.kill(-pid, signal); } catch {}
					try { process.kill(pid, signal); } catch {}
				}
			};
			signalTree("SIGTERM");
			hardKill = setTimeout(() => signalTree("SIGKILL"), 2000);
			settleDeadline = setTimeout(() => {
				signalTree("SIGKILL");
				child.stdout.destroy();
				child.stderr.destroy();
				finish(1, "SIGKILL", "Diagnostic process watchdog expired");
			}, 4000);
		}, timeout);
		for (const stream of [child.stdout, child.stderr]) {
			let pending = "";
			stream.on("data", (chunk) => {
				output.write(chunk);
				process.stdout.write(chunk);
				pending += chunk.toString();
				const lines = pending.split("\n");
				pending = lines.pop();
				for (const line of lines) {
					if (line.includes("event=did-enter")) entered = true;
					if (firstWillEnter || !line.includes("event=will-enter")) continue;
					firstWillEnter = line;
					const pid = Number(line.match(/\[(\d+):\d+\]/)?.[1] ?? line.match(/\bpid=(\d+)/)?.[1] ?? child.pid);
					snapshotTimer = setTimeout(() => { observations.push(captureTransitionContext(label, firstWillEnter)); }, 500);
					sampleTimer = setTimeout(() => {
						if (!entered) observations.push(sampleStalledEntry(label, pid));
					}, 2000);
				}
			});
		}
		const finish = (status, signal, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(hardKill);
			clearTimeout(settleDeadline);
			clearTimeout(snapshotTimer);
			clearTimeout(sampleTimer);
			resolveResult({ status: timedOut ? 1 : status, signal, error, timedOut, firstWillEnter });
		};
		child.on("error", (error) => finish(1, null, error.message));
		child.on("close", (status, signal) => finish(status, signal));
	});
	await new Promise((resolveOutput) => output.end(resolveOutput));
	const observed = await Promise.allSettled(observations);
	result.diagnosticErrors = observed.filter((item) => item.status === "rejected").map((item) => String(item.reason));
	return result;
}

let controlBuildIdentity;

async function runControls(modes = ["stock", "wrapper"], prefix = "control") {
	const results = [];
	const source = join(packageRoot, "scripts/fullscreen-control-probe.mm");
	const controlDirectory = join(diagnostics, "controls");
	const executable = join(controlDirectory, "fullscreen-control-probe");
	mkdirSync(controlDirectory, { recursive: true });
	try {
		if (!controlBuildIdentity) {
			command("xcrun", ["--sdk", "macosx", "clang++", "-arch", macosNativeArchitecture(process.arch), `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`, "-fobjc-arc", "-std=c++20", "-framework", "Cocoa", source, "-o", executable]);
			controlBuildIdentity = { sourceRevision: command("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).stdout.trim(), architecture: process.arch, sourceSha256: sha256(source), executableSha256: sha256(executable) };
		}
		if (sha256(executable) !== controlBuildIdentity.executableSha256 || sha256(source) !== controlBuildIdentity.sourceSha256) throw new Error("Control source or executable changed during paired comparison");
		if (modes.includes("wrapper")) copyFileSync(join(dist, "libasar.dylib"), join(controlDirectory, "libasar.dylib"));
		writeFileSync(join(diagnostics, `${prefix}-provenance.json`), JSON.stringify({ ...controlBuildIdentity, ...(modes.includes("wrapper") ? { libasarSha256: sha256(join(controlDirectory, "libasar.dylib")), wrapperSha256: sha256(join(dist, "libNativeWrapper.dylib")) } : {}) }, null, 2));
		for (const mode of modes) {
			for (const style of ["normal", "hidden"]) {
				const label = `${prefix}-${mode}-${style}`;
				const args = [mode, style, ...(mode === "wrapper" ? [join(dist, "libNativeWrapper.dylib")] : [])];
				const result = await runObservedProcess(label, executable, args, { env: { ...process.env, ELECTROBUN_DEBUG_FULLSCREEN: "1" } }, 45_000);
				results.push({ label, mode, style, ...result });
				writeFileSync(join(diagnostics, `${prefix}-results.json`), JSON.stringify(results, null, 2));
				recordContext(`${label}-after`, false);
			}
		}
	} catch (error) {
		results.push({ stage: "prepare-controls", status: 1, error: error.message });
		writeFileSync(join(diagnostics, `${prefix}-results.json`), JSON.stringify(results, null, 2));
	}
	return results;
}

function readReduceMotionPreference() {
	const exported = command("defaults", ["export", "com.apple.universalaccess", "-"], { encoding: "utf8", stdio: "pipe" }).stdout;
	const preferences = JSON.parse(command("plutil", ["-convert", "json", "-o", "-", "-"], { input: exported, encoding: "utf8", stdio: "pipe" }).stdout);
	const present = Object.hasOwn(preferences, "reduceMotion");
	if (present && typeof preferences.reduceMotion !== "boolean") throw new Error("reduceMotion is not a Boolean; refusing to change its type");
	return { present, value: present ? preferences.reduceMotion : null };
}

function effectiveReduceMotion(results) {
	return results.flatMap((result) => result.label ? Array.from(readFileSync(join(diagnostics, `${result.label}.log`), "utf8").matchAll(/\breduceMotion=([01])\b/g), (match) => Number(match[1])) : []);
}

async function runReduceMotionExperiment(stockBaseline) {
	const experiment = { domain: "com.apple.universalaccess", key: "reduceMotion", attempted: false, conclusion: "not-needed", baselineEffectiveValues: [...new Set(effectiveReduceMotion(stockBaseline))] };
	const persist = () => writeFileSync(join(diagnostics, "reduce-motion-experiment.json"), JSON.stringify(experiment, null, 2));
	const entryStalled = stockBaseline.some((result) => result.label && /event=deadline-failed phase=entry-completion\b/.test(readFileSync(join(diagnostics, `${result.label}.log`), "utf8")));
	if (!entryStalled) { persist(); return; }
	let original;
	let mutationAttempted = false;
	try {
		original = readReduceMotionPreference();
		experiment.originalPreference = original;
		experiment.attempted = true;
		persist();
		// Match runner-images configure-system.sh: the user preference domain,
		// with no sudo, Dock restart, or change to reduceTransparency.
		mutationAttempted = true;
		command("defaults", ["write", experiment.domain, experiment.key, "-bool", "false"]);
		experiment.writtenPreference = readReduceMotionPreference();
		experiment.results = await runControls(["stock"], "control-reduce-motion-false");
		experiment.experimentalEffectiveValues = [...new Set(effectiveReduceMotion(experiment.results))];
		experiment.effectiveValueChanged = experiment.baselineEffectiveValues.length === 1 && experiment.baselineEffectiveValues[0] === 1 && experiment.experimentalEffectiveValues.length === 1 && experiment.experimentalEffectiveValues[0] === 0;
		experiment.conclusion = experiment.effectiveValueChanged ? "paired-results-recorded" : "inconclusive-effective-value-did-not-change";
	} catch (error) {
		experiment.error = error.message;
		experiment.conclusion = "inconclusive-experiment-error";
	} finally {
		if (mutationAttempted) {
			try {
				if (original.present) command("defaults", ["write", experiment.domain, experiment.key, "-bool", String(original.value)]);
				else command("defaults", ["delete", experiment.domain, experiment.key]);
				experiment.restoredPreference = readReduceMotionPreference();
				experiment.restoredExactly = JSON.stringify(experiment.restoredPreference) === JSON.stringify(original);
				if (!experiment.restoredExactly) throw new Error("reduceMotion preference restoration did not match baseline");
			} catch (error) {
				experiment.restoreError = error.message;
				persist();
				throw new Error("Cannot run baseline wrapper/Kitchen cases after failed preference restoration");
			}
		}
		persist();
	}
}

async function collectDesktopLogs() {
	const result = await captureCommand("desktop-unified", "/usr/bin/log", ["show", "--last", "15m", "--style", "compact", "--info", "--predicate", 'process == "Dock" OR process == "WindowServer" OR subsystem CONTAINS[c] "spaces" OR eventMessage CONTAINS[c] "fullscreen"'], 30_000);
	writeFileSync(join(diagnostics, "desktop-unified-command.json"), JSON.stringify(result, null, 2));
}

function prepare() {
	mkdirSync(dist, { recursive: true });
	const artifactHashes = {};
	for (const kind of ["core", "cef"]) {
		const archive = join(repository, "diagnostic-artifacts", `electrobun-${kind}-darwin-x64.tar.gz`);
		artifactHashes[kind] = sha256(archive);
		command("tar", ["-xzf", archive, "-C", dist]);
	}
	writeFileSync(join(diagnostics, "artifact-sha256.json"), JSON.stringify(artifactHashes, null, 2));
	const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
	validateNativeDevkitManifest({ coreRoot: dist, expectedVersion: version, expectedTarget: { os: "macos", arch: "x64" } });
	command(process.execPath, ["scripts/verify-macho-deployment-target.js", "--arch=x64", dist]);
	const provenance = {
		mode: process.env.REBUILD_NATIVE === "false" ? "original-artifact" : "rebuilt-native-wrapper",
		artifactRun: JSON.parse(readFileSync(join(diagnostics, "artifact-run.json"), "utf8")).id,
		artifactSourceRevision: JSON.parse(readFileSync(join(diagnostics, "artifact-run.json"), "utf8")).head_sha,
		artifactHashes,
		diagnosticSourceRevision: command("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).stdout.trim(),
		nativeSourceSha256: sha256(join(packageRoot, "src/native/macos/nativeWrapper.mm")),
		originalWrapperSha256: sha256(join(dist, "libNativeWrapper.dylib")),
		devkitWrapperSha256: sha256(join(dist, "libNativeWrapper.dylib")),
	};
	writeFileSync(join(diagnostics, "wrapper-provenance.json"), JSON.stringify(provenance, null, 2));
	if (process.env.REBUILD_NATIVE === "false") return;

	// Use the exact SDK versions used by build.ts. Rebuilding only this dylib
	// avoids rebuilding Zig/core, launchers, and unrelated language toolchains.
	const scratch = join(diagnostics, "build");
	const cef = join(scratch, "cef");
	const dawn = join(scratch, "dawn");
	mkdirSync(cef, { recursive: true });
	mkdirSync(dawn, { recursive: true });
	const cefArchive = join(scratch, "cef.tar.bz2");
	download(`https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION}+chromium-${CHROMIUM_VERSION}_macosx64_minimal.tar.bz2`, cefArchive);
	command("tar", ["-xjf", cefArchive, "--strip-components=1", "-C", cef]);
	const dawnArtifact = ownedBuildDependencyArtifact("electrobun-dawn", "macos", "x64");
	const dawnArchive = join(scratch, "dawn.tar.gz");
	download(dawnArtifact.url, dawnArchive);
	download(dawnArtifact.checksumUrl, `${dawnArchive}.sha256`);
	const expectedHash = readFileSync(`${dawnArchive}.sha256`, "utf8").trim().split(/\s+/)[0];
	const actualHash = createHash("sha256").update(readFileSync(dawnArchive)).digest("hex");
	if (!/^[a-f0-9]{64}$/i.test(expectedHash) || expectedHash.toLowerCase() !== actualHash) throw new Error("Dawn checksum mismatch");
	command("tar", ["-xzf", dawnArchive, "-C", dawn]);
	const dawnEntries = readdirSync(dawn);
	const dawnRoot = existsSync(join(dawn, "include")) ? dawn : join(dawn, dawnEntries[0]);
	if (!existsSync(join(dawnRoot, "include", "dawn", "webgpu.h"))) throw new Error("Dawn headers missing");
	const cefBuild = join(cef, "build");
	command("cmake", ["-S", cef, "-B", cefBuild, "-DPROJECT_ARCH=x86_64", "-DCMAKE_OSX_ARCHITECTURES=x86_64", "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}`]);
	command("cmake", ["--build", cefBuild, "--target", "libcef_dll_wrapper", "--parallel", "8"]);
	const sdk = command("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8", stdio: "pipe" }).stdout.trim();
	if (!sdk) throw new Error("Missing macOS SDK path");
	const targetFlags = ["-arch", "x86_64", `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`];
	const object = join(scratch, "nativeWrapper.o");
	command("xcrun", ["--sdk", "macosx", "clang++", "-c", "src/native/macos/nativeWrapper.mm", "-o", object, ...targetFlags, "-fobjc-arc", "-fno-objc-msgsend-selector-stubs", `-I${cef}`, `-I${join(dawnRoot, "include")}`, "-std=c++20", "-isysroot", sdk]);
	const wrapper = join(dist, "libNativeWrapper.dylib");
	renameSync(wrapper, join(diagnostics, "original-libNativeWrapper.dylib"));
	command("xcrun", ["--sdk", "macosx", "clang++", ...targetFlags, "-o", wrapper, object, join(dist, "libasar.dylib"), "-framework", "Cocoa", "-framework", "WebKit", "-framework", "QuartzCore", "-framework", "Metal", "-framework", "MetalKit", "-framework", "UserNotifications", `-F${join(cef, "Release")}`, "-weak_framework", "Chromium Embedded Framework", `-L${join(cefBuild, "libcef_dll_wrapper")}`, "-lcef_dll_wrapper", "-stdlib=libc++", "-shared", "-install_name", "@executable_path/libNativeWrapper.dylib", "-Wl,-rpath,@executable_path"]);
	command("codesign", ["--force", "--sign", "-", wrapper]);
	command(process.execPath, ["scripts/verify-macho-deployment-target.js", "--arch=x64", wrapper]);
	provenance.devkitWrapperSha256 = sha256(wrapper);
	writeFileSync(join(diagnostics, "wrapper-provenance.json"), JSON.stringify(provenance, null, 2));
	writeFileSync(join(diagnostics, "instrumented-wrapper-sha256.txt"), `${provenance.devkitWrapperSha256}\n`);
	// The diagnostic archive should contain evidence, not duplicate large SDKs.
	command("rm", ["-rf", scratch]);
}

function bundledWrapperEvidence(variant) {
	const provenance = JSON.parse(readFileSync(join(diagnostics, "wrapper-provenance.json"), "utf8"));
	const root = join(repository, "kitchen", "build", "matrix", variant.replace(":", "-"), "dev-macos-x64");
	const apps = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
	if (apps.length !== 1) throw new Error(`Expected one packaged app for ${variant}; found ${apps.length}`);
	const wrapper = join(root, apps[0].name, "Contents", "MacOS", "libNativeWrapper.dylib");
	const actualSha256 = sha256(wrapper);
	return { variant, wrapper, actualSha256, expectedSha256: provenance.devkitWrapperSha256, matchesDevkit: actualSha256 === provenance.devkitWrapperSha256 };
}

async function runTests() {
	const provenance = JSON.parse(readFileSync(join(diagnostics, "wrapper-provenance.json"), "utf8"));
	const traceRequired = provenance.mode === "rebuilt-native-wrapper";
	const bundledWrappers = ["bun:native", "bun:cef"].map(bundledWrapperEvidence);
	writeFileSync(join(diagnostics, "bundled-wrapper-sha256.json"), JSON.stringify(bundledWrappers, null, 2));
	if (bundledWrappers.some((wrapper) => !wrapper.matchesDevkit)) throw new Error("Packaged Kitchen wrapper differs from the prepared devkit; refusing to launch");
	recordContext("before");
	const stockBaseline = await runControls(["stock"], "control-stock-baseline");
	await runReduceMotionExperiment(stockBaseline);
	const wrapperBaseline = await runControls(["wrapper"], "control-wrapper-baseline");
	const controlResults = [...stockBaseline, ...wrapperBaseline];
	writeFileSync(join(diagnostics, "control-results.json"), JSON.stringify(controlResults, null, 2));
	const results = [];
	for (const variant of ["bun:native", "bun:cef"]) {
		for (const name of ["Window fullscreen toggle", "Window fullscreen toggle with hidden titlebar"]) {
			const label = `${variant.replace(":", "-")}-${name.includes("hidden") ? "hidden" : "normal"}`;
			const wrapperEvidence = bundledWrapperEvidence(variant);
			if (!wrapperEvidence.matchesDevkit) throw new Error(`${label}: packaged wrapper changed before launch`);
			const result = { variant, name, ...await runObservedProcess(label, selectHutchBinary(), ["scripts/kitchen-matrix.ts", "--launch-only", `--with=${variant}`, "--timeout=60"], {
					cwd: join(repository, "kitchen"),
					env: { ...process.env, HUTCH_ELECTROBUN_DEVKIT_ROOT: dist, AUTO_RUN: "", AUTO_RUN_TEST_NAME: name, ELECTROBUN_DEBUG_FULLSCREEN: "1" },
				}) };
			const log = readFileSync(join(diagnostics, `${label}.log`), "utf8");
			result.wrapper = wrapperEvidence;
			result.mode = provenance.mode;
			result.nativeTraceRequired = traceRequired;
			result.selectedTestObserved = log.includes(`Auto-running test "${name}"`);
			result.successMarkerObserved = log.includes("Auto-run test complete. Exiting with code 0");
			result.nativeApiRequests = Array.from(log.matchAll(/\[electrobun fullscreen\][^\n]*event=api-request window=(\S+) cppBool=([01]) objcBOOL=(-?\d+)/g), (match) => ({ window: match[1], cppBool: Number(match[2]), objcBOOL: Number(match[3]) }));
			result.nativeEnterAndExitObserved = result.nativeApiRequests.some((request, index, requests) => request.cppBool === 1 && requests.slice(index + 1).some((later) => later.window === request.window && later.cppBool === 0));
			if (!result.selectedTestObserved || !result.successMarkerObserved || (traceRequired && !result.nativeEnterAndExitObserved)) result.status = result.status || 1;
			results.push(result);
			writeFileSync(join(diagnostics, "results.json"), JSON.stringify(results, null, 2));
			recordContext(`${label}-after`, false);
		}
	}
	recordContext("after");
	await collectDesktopLogs();
	if ([...controlResults, ...results].some((result) => result.status !== 0)) throw new Error("Fullscreen diagnostic failed; inspect control-results.json, per-case logs and results.json");
}

if (process.platform !== "darwin") throw new Error("Run this diagnostic on macOS");
if (process.argv[2] !== "stock-only" && process.arch !== "x64") throw new Error("Run the integration diagnostic on native Intel macOS");
if (process.argv[2] === "stock-only") {
	recordContext("before");
	const results = await runControls(["stock"]);
	recordContext("after");
	await collectDesktopLogs();
	if (results.some((result) => result.status !== 0)) throw new Error("Stock Cocoa control failed; inspect control-results.json");
} else if (process.argv[2] === "prepare") prepare();
else if (process.argv[2] === "run") await runTests();
else throw new Error("Usage: node fullscreen-intel-diagnostic.mjs prepare|run|stock-only");
