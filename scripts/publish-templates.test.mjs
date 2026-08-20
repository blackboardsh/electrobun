import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	parseHutchPragma,
	assertFloatingTemplateConfig,
	publishTemplates,
	releaseChannel,
	templateArtifactKey,
	templateChannelKey,
	templateMetadata,
} from "./publish-templates.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("template releases map stable and prerelease versions to independent channels", () => {
	assert.equal(releaseChannel("2.0.0"), "stable");
	assert.equal(releaseChannel("2.0.0+build-with-hyphen"), "stable");
	assert.equal(releaseChannel("2.0.0-beta.3"), "beta");
	assert.equal(releaseChannel("2.0.0-rc.1+build-with-hyphen"), "beta");
	assert.equal(templateChannelKey("stable"), "electrobun/templates/channels/stable.json");
	assert.equal(templateChannelKey("beta"), "electrobun/templates/channels/beta.json");
});

test("template releases reject values outside exact SemVer 2.0.0", () => {
	for (const version of [
		"02.0.0",
		"2.0.0-beta.01",
		"^2.0.0",
		"latest",
		"file:../electrobun",
		"../electrobun",
		" 2.0.0",
		"2.0.0 ",
		"2.0.0\n",
	]) {
		assert.throws(
			() => releaseChannel(version),
			/invalid release version/,
			version,
		);
	}
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
	for (const source of [
		"// @hutch cli=0.5.0-beta.01 cottontail=0.3.0\n",
		"// @hutch cli=latest cottontail=0.3.0\n",
		"// @hutch cli=0.5.0 cottontail=../cottontail\n",
	]) {
		assert.throws(() => parseHutchPragma(source), /exact SemVer 2\.0\.0/);
	}
});

test("published templates must float: no pragma, no product pin", () => {
	assert.equal(
		assertFloatingTemplateConfig(
			"hello-world",
			'export default {\n\tscripts: { install: ["hutch", "install"] },\n};\n',
		),
		undefined,
	);
	assert.throws(
		() =>
			assertFloatingTemplateConfig(
				"hello-world",
				"// @hutch cli=0.7.3 cottontail=0.4.4\nexport default {};\n",
			),
		/must not carry a \/\/ @hutch pragma/,
	);
	assert.throws(
		() =>
			assertFloatingTemplateConfig(
				"hello-world",
				'export default { electrobun: { version: "2.0.0" } };\n',
			),
		/must not pin electrobun\.version/,
	);
});

test("package-free templates receive catalog metadata", () => {
	assert.deepEqual(templateMetadata("go-maze-wgpu"), {
		name: "Go Maze WGPU",
		description: "Go Maze WGPU Electrobun template",
	});
	assert.deepEqual(templateMetadata("all"), {
		name: "All",
		description:
			"Install, build, and launch every other Electrobun beta template from one QA dashboard",
	});
});

test("dry-run archives preserve package and package-free template inputs", async () => {
	const packageVersion = JSON.parse(
		readFileSync(join(repositoryRoot, "package", "package.json"), "utf8"),
	).version;
	const originalLog = console.log;
	console.log = () => {};
	let catalog;
	try {
		catalog = await publishTemplates({
			dryRun: true,
			channel: releaseChannel(packageVersion),
		});
	} finally {
		console.log = originalLog;
	}

	assert.equal(catalog.templates.length, 31);
	assert.equal(
		catalog.templates.filter(({ id }) => id === "all").length,
		1,
		"the all meta-template must remain a selectable catalog entry",
	);
	const stageRoot = join(repositoryRoot, ".template-release", "stage");
	for (const template of catalog.templates) {
		const sourceRoot = join(repositoryRoot, "templates", template.id);
		const stagedRoot = join(stageRoot, template.id);
		for (const file of ["package.json", "package-lock.json", "hutch.config.ts"]) {
			const sourcePath = join(sourceRoot, file);
			const stagedPath = join(stagedRoot, file);
			assert.equal(existsSync(stagedPath), existsSync(sourcePath));
			if (existsSync(sourcePath)) {
				assert.deepEqual(readFileSync(stagedPath), readFileSync(sourcePath));
			}
		}
		// Templates float: the staged config must carry no pragma and no
		// product pin, byte-identical to the source tree.
		const stagedHutch = readFileSync(
			join(stagedRoot, "hutch.config.ts"),
			"utf8",
		);
		assert.doesNotMatch(stagedHutch, /^\/\/\s*@hutch\b/m);
		assert.doesNotMatch(
			stagedHutch,
			/\belectrobun\s*:\s*\{\s*version\s*:/s,
		);
		assert.doesNotMatch(
			readFileSync(join(stagedRoot, "electrobun.config.ts"), "utf8"),
			/\belectrobun\s*:\s*\{\s*version\s*:/s,
		);
	}
});
