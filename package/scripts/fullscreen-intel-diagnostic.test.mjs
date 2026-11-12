import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fullscreenDiagnosticTarget, fullSuiteLaunch } from "./fullscreen-intel-diagnostic.mjs";

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
		full_suite: "true",
	})) {
		const block = workflowBlock(new RegExp(`^\\s*${input}:\\s*$`));
		const value = block.match(/^\s*default:\s*([^\r\n]+)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, "$2");
		assert.equal(value, expected, `unexpected default for ${input}`);
	}
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
