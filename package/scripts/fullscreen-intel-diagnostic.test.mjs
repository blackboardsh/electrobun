import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	assertOnlyCoreChanged, assertPackagedRuntimeHashes, debugCoreBuildPlan, devkitFileHashes,
	diagnosticRuntimeEnvironment, fullscreenDiagnosticTarget, fullSuiteLaunch,
} from "./fullscreen-intel-diagnostic.mjs";

const coreTree = "a".repeat(40);
const debugPlanOptions = { packageRoot: resolve("fixture package"), zigVersion: "0.17.0", artifactSourceTree: coreTree, checkoutSourceTree: coreTree };

test("runtime evidence records only temporary directories and the selected runtime variants", () => {
	const selected = { TMPDIR: "/fixture/tmp", TMP: "", TEMP: "/fixture/temp", ELECTROBUN_DIAGNOSTICS_TEMP: "/fixture/diagnostics" };
	assert.deepEqual(diagnosticRuntimeEnvironment({ ...selected, GH_TOKEN: "secret", PATH: "tools", UNRELATED: "private" }), {
		...selected, variants: ["bun:native", "bun:cef"],
	});
	assert.deepEqual(diagnosticRuntimeEnvironment({}), {
		TMPDIR: null, TMP: null, TEMP: null, ELECTROBUN_DIAGNOSTICS_TEMP: null, variants: ["bun:native", "bun:cef"],
	});
});

for (const [arch, zigArch] of [["arm64", "aarch64"], ["x64", "x86_64"]]) {
	test(`Debug Core plan builds only ${arch} Core with the VM's Debug mode and macOS baseline`, () => {
		const plan = debugCoreBuildPlan({ ...debugPlanOptions, arch });
		assert.deepEqual(plan, {
			command: "zig",
			args: ["build", `-Dtarget=${zigArch}-macos.14.0`, "-Doptimize=Debug"],
			cwd: join(debugPlanOptions.packageRoot, "src", "core"),
			output: join(debugPlanOptions.packageRoot, "src", "core", "zig-out", "lib", "libElectrobunCore.dylib"),
		});
	});
}

test("Debug Core refuses a different compiler, architecture or source tree", () => {
	for (const override of [
		{ zigVersion: "0.16.0" }, { arch: "aarch64" },
		{ artifactSourceTree: "b".repeat(40) }, { checkoutSourceTree: "b".repeat(40) },
		{ artifactSourceTree: "", checkoutSourceTree: "" },
	]) {
		assert.throws(() => debugCoreBuildPlan({ ...debugPlanOptions, arch: "arm64", ...override }));
	}
});

test("Core replacement preserves every other devkit file, including the manifest", () => {
	const root = mkdtempSync(join(tmpdir(), "electrobun-debug-core-test-"));
	try {
		mkdirSync(join(root, "cef"));
		for (const path of ["libElectrobunCore.dylib", "libElectrobunUI.dylib", "libNativeWrapper.dylib", "native-devkit.json", "cef/framework"]) {
			writeFileSync(join(root, path), `original:${path}`);
		}
		const before = devkitFileHashes(root);
		assert.throws(() => assertOnlyCoreChanged(before, devkitFileHashes(root)), /must change the Core/);
		writeFileSync(join(root, "libElectrobunCore.dylib"), "debug core");
		const after = devkitFileHashes(root);
		assert.doesNotThrow(() => assertOnlyCoreChanged(before, after));
		for (const path of ["libElectrobunUI.dylib", "libNativeWrapper.dylib", "native-devkit.json", "cef/framework"]) {
			assert.throws(() => assertOnlyCoreChanged(before, { ...after, [path]: "changed" }), /changed another devkit file/);
		}
		assert.throws(() => assertOnlyCoreChanged(before, { ...after, "unexpected.dylib": "added" }), /changed another devkit file/);
		const removed = { ...after };
		delete removed["libNativeWrapper.dylib"];
		assert.throws(() => assertOnlyCoreChanged(before, removed), /changed another devkit file/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Core replacement also preserves POSIX framework symlink targets", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "electrobun-debug-core-symlink-test-"));
	try {
		writeFileSync(join(root, "libElectrobunCore.dylib"), "release core");
		symlinkSync("framework", join(root, "Current"));
		const before = devkitFileHashes(root);
		writeFileSync(join(root, "libElectrobunCore.dylib"), "debug core");
		assert.doesNotThrow(() => assertOnlyCoreChanged(before, devkitFileHashes(root)));
		unlinkSync(join(root, "Current"));
		symlinkSync("other-framework", join(root, "Current"));
		assert.throws(() => assertOnlyCoreChanged(before, devkitFileHashes(root)), /Current/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("packaged Core and wrapper must both match the prepared devkit before launch", () => {
	const expected = { core: "a".repeat(64), wrapper: "b".repeat(64) };
	assert.doesNotThrow(() => assertPackagedRuntimeHashes(expected, { ...expected }));
	for (const component of ["core", "wrapper"]) {
		assert.throws(() => assertPackagedRuntimeHashes(expected, { ...expected, [component]: "c".repeat(64) }), new RegExp(component));
		assert.throws(() => assertPackagedRuntimeHashes({ ...expected, [component]: undefined }, expected), new RegExp(component));
		assert.throws(() => assertPackagedRuntimeHashes({ ...expected, [component]: "" }, { ...expected, [component]: "" }), new RegExp(component));
	}
});

for (const expected of [
	{ arch: "x64", machine: "x86_64", artifactSuffix: "darwin-x64", bundleDirectory: "dev-macos-x64", cefPlatform: "macosx64" },
	{ arch: "arm64", machine: "arm64", artifactSuffix: "darwin-arm64", bundleDirectory: "dev-macos-arm64", cefPlatform: "macosarm64" },
]) {
	test(`${expected.arch} keeps runner, release artifact, app bundle and CEF architecture aligned`, () => {
		assert.deepEqual(fullscreenDiagnosticTarget(expected.arch), expected);
	});
}

test("unsupported architectures cannot select diagnostic artifacts", () => {
	for (const arch of ["ia32", "aarch64", "x86_64", "", "../arm64", "__proto__"]) {
		assert.throws(() => fullscreenDiagnosticTarget(arch), `accepted unsupported architecture ${JSON.stringify(arch)}`);
	}
});

for (const variant of ["bun:native", "bun:cef"]) {
	test(`${variant} launches the full existing suite without rebuilding or selecting one test`, () => {
		const repository = resolve("fixture repositories", "electrobun");
		const dist = join(repository, "package", "dist");
		const inherited = Object.freeze({
			PATH: "fixture-tools",
			HUTCH_LAUNCHER_PATH: "fixture-hutch",
			HUTCH_ELECTROBUN_DEVKIT_ROOT: "stale-devkit",
			AUTO_RUN: "0",
			AUTO_RUN_TEST_NAME: "Window fullscreen toggle with hidden titlebar",
			AUTO_RUN_CATEGORY: "BrowserWindow",
			AUTO_RUN_WGPU: "1",
			ELECTROBUN_DEBUG_FULLSCREEN: "0",
			TMPDIR: "/fixture/tmp", TMP: "/fixture/tmp", TEMP: "/fixture/tmp",
		});
		const launch = fullSuiteLaunch(variant, { repository, dist, env: inherited });
		assert.deepEqual(launch.args, [
			"scripts/kitchen-matrix.ts", "--launch-only", `--with=${variant}`, "--timeout=1200",
		]);
		assert.equal(launch.cwd, join(repository, "kitchen"));
		assert.deepEqual(launch.env, {
			...inherited,
			HUTCH_ELECTROBUN_DEVKIT_ROOT: dist,
			AUTO_RUN: "1",
			AUTO_RUN_TEST_NAME: "",
			AUTO_RUN_CATEGORY: "",
			AUTO_RUN_WGPU: "",
			ELECTROBUN_DEBUG_FULLSCREEN: "1",
		});
		assert.notEqual(launch.env, inherited, "launch must not reuse or mutate the caller's environment");
		assert.equal(inherited.AUTO_RUN_TEST_NAME, "Window fullscreen toggle with hidden titlebar");
		assert.equal(launch.timeoutMs, 1_230_000, "outer watchdog must allow the matrix's 1200s timeout and cleanup");
		assert.equal(launch.observeTransitions, false, "full suites use the matrix watcher without the isolated-case sampler");
	});
}

test("full-suite mode rejects unsupported or compound variant selections", () => {
	const options = { repository: resolve("fixture"), dist: resolve("fixture", "package", "dist"), env: {} };
	for (const variant of ["cottontail:native", "go:native", "bun", "bun:unknown", "bun:native,bun:cef", "", "__proto__"]) {
		assert.throws(() => fullSuiteLaunch(variant, options), `accepted unsupported variant ${JSON.stringify(variant)}`);
	}
});

const workflow = readFileSync(new URL("../../.github/workflows/fullscreen-intel-diagnostic.yml", import.meta.url), "utf8");

function workflowBlock(pattern) {
	const lines = workflow.split(/\r?\n/);
	const start = lines.findIndex((line) => pattern.test(line));
	assert.notEqual(start, -1, `missing workflow block ${pattern}`);
	const indentation = lines[start].match(/^\s*/)[0].length;
	let end = start + 1;
	while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > indentation)) end += 1;
	return lines.slice(start + 1, end).join("\n");
}

test("diagnostic defaults retain the exact beta16 artifacts without rebuilding the wrapper", () => {
	for (const [input, expected] of Object.entries({
		integration_runner: "macos-26",
		artifact_run_id: "43200214270",
		artifact_sha: "146da4c44a13ac1ae761696e1a578bb98d7a0aea",
		rebuild_native: "false",
		rebuild_debug_core: "false",
		use_vm_temp_dir: "false",
		full_suite: "true",
	})) {
		const block = workflowBlock(new RegExp(`^\\s*${input}:\\s*$`));
		const value = block.match(/^\s*default:\s*([^\r\n]+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, "$2");
		assert.equal(value, expected, `unexpected default for ${input}`);
	}
});

test("VM temporary directories are opt-in and configured before installing tools or building apps", () => {
	const block = workflowBlock(/^\s*- name: Use full VM temporary directory\s*$/);
	assert.match(block, /^\s*if:\s*inputs\.use_vm_temp_dir\s*$/m);
	const assignments = block.match(/echo "(?:TMPDIR|TMP|TEMP)=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/g);
	const vmWorkflow = readFileSync(new URL("../../.github/workflows/test-vm.yml", import.meta.url), "utf8");
	assert.deepEqual(assignments, vmWorkflow.match(/echo "(?:TMPDIR|TMP|TEMP)=\$RUNNER_TEMP" >> "\$GITHUB_ENV"/g));
	assert.equal(assignments?.length, 3);
	assert.ok(workflow.indexOf("- name: Use full VM temporary directory") < workflow.indexOf("- uses: ./.github/actions/install-hutch"));
});

test("Debug Core is explicit, uses pinned Zig and skips unrelated stock controls", () => {
	assert.match(workflowBlock(/^\s*stock-cocoa:\s*$/), /^\s*if:\s*\$\{\{ !inputs\.rebuild_debug_core \}\}\s*$/m);
	const zig = workflowBlock(/^\s*- uses: mlugg\/setup-zig@v2\s*$/);
	assert.match(zig, /^\s*if:\s*inputs\.rebuild_debug_core\s*$/m);
	assert.match(zig, /^\s*version:\s*0\.17\.0\s*$/m);
	const prepare = workflowBlock(/^\s*- name: Stage immutable devkit and apply selected diagnostic rebuilds\s*$/);
	assert.match(prepare, /REBUILD_DEBUG_CORE:\s*\$\{\{ inputs\.rebuild_debug_core \}\}/);
	assert.match(prepare, /REBUILD_NATIVE:\s*\$\{\{ inputs\.rebuild_native \}\}/);
	assert.ok(workflow.includes("contents/package/src?ref=$ARTIFACT_SHA"));
	assert.ok(workflow.includes("artifact-core-tree-sha.txt"));
});

test("workflow selects both artifact architectures and retains owned-app samples on failure", () => {
	assert.match(workflow, /ELECTROBUN_BUILD_ARCH:\s*\$\{\{\s*endsWith\(inputs\.integration_runner,\s*'-intel'\)\s*&&\s*'x64'\s*\|\|\s*'arm64'\s*\}\}/);
	for (const artifact of ["core", "cef"]) {
		assert.ok(workflow.includes(`electrobun-${artifact}-darwin-` + "${{ env.ELECTROBUN_BUILD_ARCH }}"));
	}
	assert.match(workflow, /ELECTROBUN_DIAGNOSTICS_TEMP:\s*\$\{\{\s*github\.workspace\s*\}\}\/fullscreen-owned-app-diagnostics/);
	const retention = workflowBlock(/^\s*- name: Retain fullscreen diagnostics\s*$/);
	assert.match(retention, /^\s*if:\s*always\(\)\s*$/m);
	assert.match(retention, /uses:\s*actions\/upload-artifact@/);
	for (const path of ["${{ env.FULLSCREEN_DIAGNOSTICS }}/**", "${{ env.ELECTROBUN_DIAGNOSTICS_TEMP }}/**", "kitchen/test-results/**"]) {
		assert.ok(retention.includes(path), `missing retained diagnostic path ${path}`);
	}
});
