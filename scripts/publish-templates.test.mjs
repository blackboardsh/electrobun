import assert from "node:assert/strict";
import test from "node:test";

import {
	parseHutchPragma,
	pinElectrobunDependency,
	releaseChannel,
	templateArtifactKey,
	templateChannelKey,
} from "./publish-templates.mjs";

test("template releases map stable and prerelease versions to independent channels", () => {
	assert.equal(releaseChannel("2.0.0"), "production");
	assert.equal(releaseChannel("2.0.0-beta.3"), "canary");
	assert.equal(templateChannelKey("production"), "electrobun/templates/channels/production.json");
	assert.equal(templateChannelKey("canary"), "electrobun/templates/channels/canary.json");
});

test("template archive keys are immutable and content addressed", () => {
	const checksum = "a".repeat(64);
	assert.equal(
		templateArtifactKey(checksum),
		`electrobun/templates/artifacts/${checksum}.tar.gz`,
	);
	assert.throws(() => templateArtifactKey("short"), /invalid template checksum/);
});

test("the release toolchain pins come from the package pragma", () => {
	assert.deepEqual(
		parseHutchPragma("// @hutch cli=0.5.0 cottontail=0.3.0\nexport default {};\n"),
		{ hutch: "0.5.0", cottontail: "0.3.0" },
	);
	assert.throws(
		() => parseHutchPragma("// @dash cli=0.5.0 cottontail=0.3.0\n"),
		/missing its \/\/ @hutch pragma/,
	);
});

test("published templates replace repository-local Electrobun dependencies", () => {
	const manifest = {
		name: "example",
		dependencies: { electrobun: "file:../../package", react: "^19.0.0" },
	};
	pinElectrobunDependency(manifest, "2.0.0-beta.1");
	assert.deepEqual(manifest.dependencies, {
		electrobun: "2.0.0-beta.1",
		react: "^19.0.0",
	});
});
