import assert from "node:assert/strict";
import test from "node:test";

import {
	parseDashPragma,
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
		parseDashPragma("// @dash cli=0.5.0-canary.1 cottontail=0.2.3\nexport default {};\n"),
		{ hutch: "0.5.0-canary.1", cottontail: "0.2.3" },
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
