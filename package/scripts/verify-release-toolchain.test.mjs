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

test("release provenance accepts stable SemVer build metadata", () => {
	assert.deepEqual(
		parseHutchPragma(
			"// @hutch cli=0.5.0+release.01 cottontail=0.3.0+macos-arm64\n",
		),
		{
			hutch: "0.5.0+release.01",
			cottontail: "0.3.0+macos-arm64",
		},
	);
});

test("release provenance rejects non-stable or non-exact Hutch pragma pins", () => {
	for (const version of [
		"0.5.0-beta.1",
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
			/exact stable SemVer 2\.0\.0/,
			`expected Hutch pin ${JSON.stringify(version)} to be rejected`,
		);
		assert.throws(
			() =>
				parseHutchPragma(
					`// @hutch cli=0.5.0 cottontail=${version}\n`,
				),
			/exact stable SemVer 2\.0\.0/,
			`expected Cottontail pin ${JSON.stringify(version)} to be rejected`,
		);
	}
});

test("release provenance rejects invalid expected production versions before probing", () => {
	for (const version of [
		"0.5.0-rc.1",
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
			/EXPECTED_HUTCH_VERSION must be an exact stable SemVer 2\.0\.0/,
		);
		assert.throws(
			() =>
				verifyReleaseToolchain({
					EXPECTED_HUTCH_VERSION: "0.5.0",
					EXPECTED_COTTONTAIL_VERSION: version,
				}),
			/EXPECTED_COTTONTAIL_VERSION must be an exact stable SemVer 2\.0\.0/,
		);
	}
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

	assert.match(workflow, /^      EXPECTED_HUTCH_VERSION: '0\.6\.4'$/m);
	assert.match(workflow, /^      EXPECTED_COTTONTAIL_VERSION: '0\.4\.3'$/m);
	assert.match(
		workflow,
		/^      - name: Install Hutch\n        uses: \.\/\.github\/actions\/install-hutch\n        with:\n          channel: production$/m,
	);
	assert.match(
		workflow,
		/^      - name: Install Kitchen dependencies\n        run: hutch run install\n        working-directory: kitchen\n\n      - name: Typecheck Kitchen against local devkit\n        run: \|\n          hutch electrobun sync\n          node \.\.\/package\/node_modules\/typescript\/bin\/tsc --noEmit\n        working-directory: kitchen\n        env:\n          HUTCH_ELECTROBUN_DEVKIT_ROOT: \$\{\{ github\.workspace \}\}\/package\/dist$/m,
	);

	const provenance = workflow.indexOf(
		"      - name: Verify production Hutch and Cottontail provenance",
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
