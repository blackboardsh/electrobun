#!/usr/bin/env node
// Diagnostic-only: reuse a CI devkit, replace only its native window wrapper,
// and exercise the same packaged Kitchen tests used by the full VM suite.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CEF_VERSION, CHROMIUM_VERSION } from "../src/shared/cef-version.ts";
import { ownedBuildDependencyArtifact } from "../src/shared/build-dependencies.ts";
import { MACOS_DEPLOYMENT_TARGET } from "./macos-release.js";
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

function recordContext(label) {
	const commands = [
		["sw_vers", []], ["uname", ["-a"]],
		["sysctl", ["-n", "hw.model", "hw.ncpu", "hw.memsize"]],
		["stat", ["-f", "%Su", "/dev/console"]],
		["launchctl", ["print", `gui/${process.getuid()}`]],
		["defaults", ["read", "com.apple.spaces"]],
		["defaults", ["read", "com.apple.dock", "mru-spaces"]],
		["ps", ["-axo", "pid,ppid,state,etime,command"]],
	];
	const context = commands.map(([binary, args]) => {
		const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10_000 });
		return { binary, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
	});
	writeFileSync(join(diagnostics, `${label}-desktop.json`), JSON.stringify(context, null, 2));
	spawnSync("screencapture", ["-x", join(diagnostics, `${label}.png`)], { timeout: 10_000 });
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
	const results = [];
	for (const variant of ["bun:native", "bun:cef"]) {
		for (const name of ["Window fullscreen toggle", "Window fullscreen toggle with hidden titlebar"]) {
			const label = `${variant.replace(":", "-")}-${name.includes("hidden") ? "hidden" : "normal"}`;
			const wrapperEvidence = bundledWrapperEvidence(variant);
			if (!wrapperEvidence.matchesDevkit) throw new Error(`${label}: packaged wrapper changed before launch`);
			const output = createWriteStream(join(diagnostics, `${label}.log`));
			const result = await new Promise((resolveResult) => {
				const child = spawn(selectHutchBinary(), ["scripts/kitchen-matrix.ts", "--launch-only", `--with=${variant}`, "--timeout=60"], {
					cwd: join(repository, "kitchen"),
					env: { ...process.env, HUTCH_ELECTROBUN_DEVKIT_ROOT: dist, AUTO_RUN: "", AUTO_RUN_TEST_NAME: name, ELECTROBUN_DEBUG_FULLSCREEN: "1" },
					stdio: ["ignore", "pipe", "pipe"],
				});
				for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output.write(chunk); process.stdout.write(chunk); });
				const snapshot = setTimeout(() => recordContext(`${label}-during`), 4500);
				child.on("error", (error) => { clearTimeout(snapshot); resolveResult({ variant, name, error: error.message, status: 1 }); });
				child.on("close", (status, signal) => { clearTimeout(snapshot); resolveResult({ variant, name, status, signal }); });
			});
			await new Promise((resolveOutput) => output.end(resolveOutput));
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
			recordContext(`${label}-after`);
		}
	}
	if (results.some((result) => result.status !== 0)) throw new Error("Fullscreen diagnostic failed; inspect per-case logs and results.json");
}

if (process.platform !== "darwin" || process.arch !== "x64") throw new Error("Run this diagnostic on native Intel macOS");
if (process.argv[2] === "prepare") prepare();
else if (process.argv[2] === "run") await runTests();
else throw new Error("Usage: node fullscreen-intel-diagnostic.mjs prepare|run");
