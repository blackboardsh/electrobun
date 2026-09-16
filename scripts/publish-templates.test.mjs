import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	parseHutchPragma,
	assertRepositoryTemplateConfig,
	pinPublishedTemplateConfig,
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

test("publication exact-pins a canonical repository config without mutating it", () => {
	const source =
		'export default {\n\tscripts: { install: ["hutch", "install"] },\n};\n';
	const original = `${source}`;
	assert.equal(assertRepositoryTemplateConfig("hello-world", source), undefined);
	assert.equal(
		pinPublishedTemplateConfig("hello-world", source, "2.0.0-beta.3+build.4"),
		[
			"export default {",
			"\tscripts: { install: [\"hutch\", \"install\"] },",
			"\telectrobun: {",
			'\t\tversion: "2.0.0-beta.3+build.4",',
			"\t},",
			"};",
			"",
		].join("\n"),
	);
	assert.equal(source, original);

	const windowsSource = "export default {\r\n\tscripts: {},\r\n};\r\n";
	assert.equal(
		pinPublishedTemplateConfig("hello-world", windowsSource, "2.0.0"),
		"export default {\r\n\tscripts: {},\r\n\telectrobun: {\r\n\t\tversion: \"2.0.0\",\r\n\t},\r\n};\r\n",
	);
});

test("publication rejects non-canonical, ambiguous, or pre-pinned configs", () => {
	assert.throws(
		() =>
			pinPublishedTemplateConfig(
				"hello-world",
				"// @hutch cli=0.7.3 cottontail=0.4.4\nexport default {};\n",
				"2.0.0",
			),
		/must not carry a \/\/ @hutch pragma/,
	);
	for (const source of [
		'export default {\n\telectrobun: { version: "2.0.0" },\n};\n',
		'export default {\n\t"electrobun": { note: true, "version": "2.0.0" },\n};\n',
		"export default {\n\telectrobun: { version: resolveVersion() },\n};\n",
		'export default {\n\t["electrobun"]: { version: "2.0.0" },\n};\n',
		'export default {\n\telectrobun /* comment */: { version: "2.0.0" },\n};\n',
		'export default {\n\t...{ electrobun: { version: "2.0.0" } },\n};\n',
		'export default {\n\t__proto__: { electrobun: { version: "2.0.0" } },\n};\n',
	]) {
		assert.throws(
			() => pinPublishedTemplateConfig("hello-world", source, "2.0.0"),
			/must not select electrobun/,
		);
	}

	for (const source of [
		"export default { scripts: {} };\n",
		"const config = { scripts: {} };\nexport default config;\n",
		"\nexport default {\n\tscripts: {},\n};\n",
		"export default {\n};\nexport default {\n};\n",
	]) {
		assert.throws(
			() => pinPublishedTemplateConfig("hello-world", source, "2.0.0"),
			/must begin with exactly one top-level "export default \{" line/,
		);
	}
	assert.throws(
		() =>
			pinPublishedTemplateConfig(
				"hello-world",
				"export default {\n\tscripts: {},\n",
				"2.0.0",
			),
		/must end with a top-level "};" line/,
	);

	assert.throws(
		() =>
			pinPublishedTemplateConfig(
				"hello-world",
				"export default {\n\tscripts: {},\n};\n",
				"latest",
			),
		/published Electrobun version must be an exact SemVer 2\.0\.0 version/,
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

test("template publication fails closed when checked-out HEAD cannot be resolved", async () => {
	const pathKey =
		Object.keys(process.env).find((name) => name.toLowerCase() === "path") ??
		"PATH";
	const originalPath = process.env[pathKey];
	try {
		process.env[pathKey] = "";
		await assert.rejects(
			publishTemplates({ dryRun: true }),
			/could not resolve the checked-out Git revision/,
		);
	} finally {
		if (originalPath === undefined) delete process.env[pathKey];
		else process.env[pathKey] = originalPath;
	}
});

test("dry-run pins only staged Hutch configs and preserves repository inputs", async () => {
	const packageVersion = JSON.parse(
		readFileSync(join(repositoryRoot, "package", "package.json"), "utf8"),
	).version;
	const trackedTemplateFiles = execFileSync(
		"git",
		["ls-files", "-z", "--", "templates"],
		{ cwd: repositoryRoot },
	)
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.filter((path) => !path.endsWith("/.DS_Store"));
	const sourceInputsBefore = new Map(
		trackedTemplateFiles.map((path) => [
			path,
			readFileSync(join(repositoryRoot, path)),
		]),
	);
	const checkedOutHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
	const spoofedRevision = "f".repeat(40);
	const originalRevision = process.env.GITHUB_SHA;
	const originalLog = console.log;
	console.log = () => {};
	let catalog;
	try {
		process.env.GITHUB_SHA = spoofedRevision;
		catalog = await publishTemplates({
			dryRun: true,
			channel: releaseChannel(packageVersion),
		});
	} finally {
		console.log = originalLog;
		if (originalRevision === undefined) delete process.env.GITHUB_SHA;
		else process.env.GITHUB_SHA = originalRevision;
	}

	assert.equal(catalog.revision, checkedOutHead);
	assert.notEqual(catalog.revision, spoofedRevision);
	assert.equal(catalog.templates.length, 31);
	assert.equal(
		catalog.templates.filter(({ id }) => id === "all").length,
		1,
		"the all meta-template must remain a selectable catalog entry",
	);
	for (const [path, source] of sourceInputsBefore) {
		assert.deepEqual(
			readFileSync(join(repositoryRoot, path)),
			source,
			`${path} must remain unchanged by publication`,
		);
	}
	const stageRoot = join(repositoryRoot, ".template-release", "stage");
	for (const template of catalog.templates) {
		const sourceRoot = join(repositoryRoot, "templates", template.id);
		const stagedRoot = join(stageRoot, template.id);
		const templateFiles = trackedTemplateFiles.filter((path) =>
			path.startsWith(`templates/${template.id}/`),
		);
		assert.ok(templateFiles.length > 0, `${template.id} has tracked inputs`);
		for (const trackedPath of templateFiles) {
			const stagedPath = join(
				stagedRoot,
				relative(`templates/${template.id}`, trackedPath),
			);
			assert.equal(existsSync(stagedPath), true, `${trackedPath} was staged`);
			if (basename(trackedPath) !== "hutch.config.ts") {
				assert.deepEqual(
					readFileSync(stagedPath),
					sourceInputsBefore.get(trackedPath),
					`${trackedPath} changed while staging`,
				);
			}
		}

		const sourceHutch = readFileSync(join(sourceRoot, "hutch.config.ts"), "utf8");
		const stagedHutch = readFileSync(
			join(stagedRoot, "hutch.config.ts"),
			"utf8",
		);
		assert.notEqual(stagedHutch, sourceHutch);
		assert.doesNotMatch(
			sourceHutch,
			/(?:^|[{,]\s*)(?:electrobun|["']electrobun["'])\s*:/s,
		);
		assert.doesNotMatch(stagedHutch, /^\/\/\s*@hutch\b/m);
		const stagedVersions = [
			...stagedHutch.matchAll(
				/\belectrobun\s*:\s*\{\s*version\s*:\s*(["'])([^"'\r\n]+)\1/g,
			),
		];
		assert.equal(stagedVersions.length, 1, template.id);
		assert.equal(stagedVersions[0][2], packageVersion, template.id);

		const archivedHutch = execFileSync(
			"tar",
			[
				"-xOf",
				join(repositoryRoot, ".template-release", "archives", `${template.id}.tar.gz`),
				`${template.id}/hutch.config.ts`,
			],
			{ cwd: repositoryRoot },
		);
		assert.deepEqual(archivedHutch, Buffer.from(stagedHutch), template.id);
		assert.doesNotMatch(
			readFileSync(join(stagedRoot, "electrobun.config.ts"), "utf8"),
			/(?:^|[{,]\s*)(?:electrobun|["']electrobun["'])\s*:/s,
		);
	}
});
