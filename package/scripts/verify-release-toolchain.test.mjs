import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseHutchPragma } from "./verify-release-toolchain.mjs";

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

	assert.match(workflow, /^      EXPECTED_HUTCH_VERSION: '0\.5\.0'$/m);
	assert.match(workflow, /^      EXPECTED_COTTONTAIL_VERSION: '0\.3\.0'$/m);
	assert.match(
		workflow,
		/^      - name: Install Hutch\n        uses: \.\/\.github\/actions\/install-hutch\n        with:\n          channel: production$/m,
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
});
