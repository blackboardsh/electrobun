import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	parseHutchPragma,
	verifyReleaseToolchain,
} from "./verify-release-toolchain.mjs";

test("release provenance accepts only the exact Hutch pragma format", () => {
	assert.deepEqual(
		parseHutchPragma("// @hutch cli=0.5.0 cottontail=0.3.0\nexport default {};\n"),
		{ hutch: "0.5.0", cottontail: "0.3.0" },
	);
	assert.throws(
		() => parseHutchPragma("// @dash cli=0.5.0 cottontail=0.3.0\n"),
		/must start with an exact \/\/ @hutch/,
	);
	assert.throws(
		() => parseHutchPragma("// @hutch cottontail=0.3.0 cli=0.5.0\n"),
		/must start with an exact \/\/ @hutch/,
	);
});

test("release provenance accepts exact stable and prerelease SemVer", () => {
	assert.deepEqual(
		parseHutchPragma(
			"// @hutch cli=0.5.0+release.01 cottontail=0.3.0+macos-arm64\n",
		),
		{
			hutch: "0.5.0+release.01",
			cottontail: "0.3.0+macos-arm64",
		},
	);
	assert.deepEqual(
		parseHutchPragma(
			"// @hutch cli=0.26.0-canary.1 cottontail=0.6.0-canary.5\n",
		),
		{
			hutch: "0.26.0-canary.1",
			cottontail: "0.6.0-canary.5",
		},
	);
});

test("release provenance rejects non-exact Hutch pragma pins", () => {
	for (const version of [
		"0.5.0-beta.01",
		"^0.5.0",
		"latest",
		"file:../hutch",
		"../hutch",
		"v0.5.0",
		"00.5.0",
	]) {
		assert.throws(
			() =>
				parseHutchPragma(
					`// @hutch cli=${version} cottontail=0.3.0\n`,
				),
			/exact SemVer 2\.0\.0/,
			`expected Hutch pin ${JSON.stringify(version)} to be rejected`,
		);
		assert.throws(
			() =>
				parseHutchPragma(
					`// @hutch cli=0.5.0 cottontail=${version}\n`,
				),
			/exact SemVer 2\.0\.0/,
			`expected Cottontail pin ${JSON.stringify(version)} to be rejected`,
		);
	}
});

test("release provenance rejects invalid expected production versions before probing", () => {
	for (const version of [
		"0.5.0-01",
		"~0.5.0",
		"production",
		"file:../hutch",
		"0.5",
	]) {
		assert.throws(
			() =>
				verifyReleaseToolchain({
					EXPECTED_HUTCH_VERSION: version,
					EXPECTED_COTTONTAIL_VERSION: "0.3.0",
				}),
			/EXPECTED_HUTCH_VERSION must be an exact SemVer 2\.0\.0/,
		);
		assert.throws(
			() =>
				verifyReleaseToolchain({
					EXPECTED_HUTCH_VERSION: "0.5.0",
					EXPECTED_COTTONTAIL_VERSION: version,
				}),
			/EXPECTED_COTTONTAIL_VERSION must be an exact SemVer 2\.0\.0/,
		);
	}
});

test("pin:latest bootstraps through the old self-update verb before repinning", () => {
	const config = readFileSync(
		new URL("../hutch.config.ts", import.meta.url),
		"utf8",
	);
	// This task is initially interpreted by the repository's old pinned engine.
	// Keep its first verb compatible with Hutch releases that predate the
	// user-facing `hutch upgrade` alias.
	assert.match(
		config,
		/"pin:latest":\s*"hutch self update && cd \.\. && hutch self pin --recursive && hutch cottontail pin --recursive && node package\/scripts\/sync-release-toolchain-pins\.mjs"/,
	);
	assert.doesNotMatch(config, /"pin:latest":\s*"hutch upgrade\b/);
	assert.doesNotMatch(config, /\bhutch cottontail update\b/);
});

test("release CI verifies provenance before all four Kitchen builds", () => {
	// Normalize CRLF -> LF: on Windows runners Git checks the workflow out with
	// CRLF, which breaks the explicit `\n` line separators in the regexes below.
	const workflow = readFileSync(
		new URL("../../.github/workflows/release.yml", import.meta.url),
		"utf8",
	).replace(/\r\n/g, "\n");
	const matrix = workflow.slice(
		workflow.indexOf("        include:"),
		workflow.indexOf("    runs-on:", workflow.indexOf("        include:")),
	);
	assert.equal((matrix.match(/^          - os:/gm) ?? []).length, 4);
	for (const runner of [
		"macos-14",
		"ubuntu-24.04",
		"ubuntu-24.04-arm",
		"windows-2025",
	]) {
		assert.match(matrix, new RegExp(`^          - os: ${runner}$`, "m"));
	}

	// The workflow env must mirror the canonical pragma pin, whatever it is.
	const pins = parseHutchPragma(
		readFileSync(new URL("../hutch.config.ts", import.meta.url), "utf8"),
	);
	const exact = (version) => version.replaceAll(".", "\\.").replaceAll("+", "\\+");
	assert.match(
		workflow,
		new RegExp(`^      EXPECTED_HUTCH_VERSION: '${exact(pins.hutch)}'$`, "m"),
	);
	assert.match(
		workflow,
		new RegExp(`^      EXPECTED_COTTONTAIL_VERSION: '${exact(pins.cottontail)}'$`, "m"),
	);
	for (const lifecycleToken of [
		"test:linux-extractor",
		"test:macos-uninstaller",
		"test:windows-uninstaller",
		"test:updater-lifecycle",
		"test-updater-lifecycle.mjs",
	]) {
		assert.equal(
			workflow.includes(lifecycleToken),
			false,
			`${lifecycleToken} must remain opt-in rather than running for every release`,
		);
	}
	assert.match(
		workflow,
		/^      - name: Install Hutch\n        uses: \.\/\.github\/actions\/install-hutch\n        with:\n          channel: \$\{\{ contains\(env\.EXPECTED_HUTCH_VERSION, '-'\) && 'canary' \|\| 'production' \}\}$/m,
	);
	assert.match(
		workflow,
		/^      - name: Install Kitchen dependencies\n        run: hutch run install\n        working-directory: kitchen\n\n      - name: Typecheck Kitchen against local devkit\n        run: \|\n          hutch electrobun prepare\n          node \.\.\/package\/node_modules\/typescript\/bin\/tsc --noEmit\n        working-directory: kitchen\n        env:\n          HUTCH_ELECTROBUN_DEVKIT_ROOT: \$\{\{ github\.workspace \}\}\/package\/dist$/m,
	);
	const macCleanupStart = workflow.indexOf(
		"      - name: Free disk space (macOS)",
	);
	const macCleanup = workflow.slice(
		macCleanupStart,
		workflow.indexOf("\n      - name:", macCleanupStart + 1),
	);
	assert.match(
		macCleanup,
		/selected_xcode_root="\$\(cd "\$\(xcode-select -p\)\/\.\.\/\.\." && pwd -P\)"/,
		"macOS cleanup must resolve and preserve the selected Xcode",
	);
	assert.match(
		macCleanup,
		/for xcode_root in \/Applications\/Xcode_\*\.app; do\n            \[\[ -d "\$xcode_root" && ! -L "\$xcode_root" \]\] \|\| continue/,
		"macOS cleanup must only consider real versioned Xcode directories",
	);
	assert.match(
		macCleanup,
		/case "\$resolved_xcode_root" in\n              \/Applications\/Xcode_\*\.app\) ;;[\s\S]*?if \[\[ "\$resolved_xcode_root" != "\$selected_xcode_root" \]\]; then\n              echo "Removing unused Xcode: \$resolved_xcode_root"\n              sudo rm -rf "\$resolved_xcode_root"/,
		"macOS cleanup must not remove the selected Xcode",
	);

	const provenance = workflow.indexOf(
		"      - name: Verify pinned Hutch and Cottontail provenance",
	);
	const build = workflow.indexOf("      - name: Build Kitchen");
	const validate = workflow.indexOf("      - name: Validate Kitchen artifacts");
	assert.ok(provenance !== -1 && provenance < build);
	assert.equal(
		workflow.slice(provenance, build).match(/^      - name:/gm)?.length,
		1,
		"the live provenance gate must be the direct predecessor of the Kitchen build",
	);
	assert.ok(build !== -1 && build < validate);
	const buildStep = workflow.slice(
		build,
		workflow.indexOf("\n      - name:", build + 1),
	);
	assert.match(
		buildStep,
		/^          HUTCH_ELECTROBUN_DEVKIT_ROOT: \$\{\{ github\.workspace \}\}\/package\/dist$/m,
		"Kitchen must bootstrap against the core/devkit built earlier in the same job",
	);
	assert.equal(
		(workflow.match(/HUTCH_ELECTROBUN_DEVKIT_ROOT/g) ?? []).length,
		2,
		"the local devkit override must remain scoped to Kitchen typechecking and building",
	);
});
