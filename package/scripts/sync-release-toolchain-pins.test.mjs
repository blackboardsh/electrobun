import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	syncReleaseToolchainPins,
	updateMigrationGuideHutchPin,
	updateNpmResolverPin,
	updateReleaseWorkflowPins,
} from "./sync-release-toolchain-pins.mjs";

const oldPins = { hutch: "0.23.0", cottontail: "0.5.0" };
const newPins = { hutch: "0.24.0", cottontail: "0.6.0+release.1" };

function workflow(pins = oldPins) {
	return `name: Release\r\n\r\njobs:\r\n  build:\r\n    env:\r\n      EXPECTED_HUTCH_VERSION: '${pins.hutch}'\r\n      EXPECTED_COTTONTAIL_VERSION: '${pins.cottontail}'\r\n`;
}

function resolver(version = oldPins.hutch) {
	return `"use strict";\n\nconst PAIRED_HUTCH_VERSION = "${version}";\nconsole.log(PAIRED_HUTCH_VERSION);\n`;
}

function migrationGuide(hutchVersion = oldPins.hutch) {
	return `# Migrating to v2\n\nFor an exact install:\n\n\`\`\`ts\n// @hutch cli=${hutchVersion} cottontail=0.5.0\nexport default {};\n\`\`\`\n`;
}

function createRepositoryFixture(t, options = {}) {
	const root = mkdtempSync(join(tmpdir(), "electrobun-pin-sync-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packageDir = join(root, "package");
	const workflowDir = join(root, ".github", "workflows");
	const resolverDir = join(root, "npm", "electrobun", "bin");
	const migrationGuideDir = join(
		root,
		"docs",
		"src",
		"content",
		"docs",
		"electrobun",
		"guides",
	);
	for (const directory of [
		packageDir,
		workflowDir,
		resolverDir,
		migrationGuideDir,
	]) {
		mkdirSync(directory, { recursive: true });
	}
	const paths = {
		config: join(packageDir, "hutch.config.ts"),
		workflow: join(workflowDir, "release.yml"),
		resolver: join(resolverDir, "resolve-hutch.cjs"),
		migrationGuide: join(migrationGuideDir, "migrating-to-v2.mdx"),
	};
	writeFileSync(
		paths.config,
		options.config ??
			`// @hutch cli=${newPins.hutch} cottontail=${newPins.cottontail}\nexport default {};\n`,
	);
	writeFileSync(paths.workflow, options.workflow ?? workflow());
	writeFileSync(paths.resolver, options.resolver ?? resolver());
	writeFileSync(
		paths.migrationGuide,
		options.migrationGuide ?? migrationGuide(),
	);
	chmodSync(paths.workflow, 0o640);
	chmodSync(paths.resolver, 0o600);
	chmodSync(paths.migrationGuide, 0o644);
	return { root, paths };
}

test("pin synchronization is atomic per file and reaches a fixed point", (t) => {
	const fixture = createRepositoryFixture(t);
	const workflowMode = statSync(fixture.paths.workflow).mode & 0o777;
	const resolverMode = statSync(fixture.paths.resolver).mode & 0o777;
	const migrationGuideMode =
		statSync(fixture.paths.migrationGuide).mode & 0o777;

	const first = syncReleaseToolchainPins(fixture.root);
	assert.deepEqual(first, {
		pins: newPins,
		changed: [
			".github/workflows/release.yml",
			"npm/electrobun/bin/resolve-hutch.cjs",
			"docs/src/content/docs/electrobun/guides/migrating-to-v2.mdx",
		],
	});
	assert.equal(
		readFileSync(fixture.paths.workflow, "utf8"),
		workflow(newPins),
	);
	assert.equal(
		readFileSync(fixture.paths.resolver, "utf8"),
		resolver(newPins.hutch),
	);
	assert.equal(
		readFileSync(fixture.paths.migrationGuide, "utf8"),
		migrationGuide(newPins.hutch),
	);
	assert.equal(statSync(fixture.paths.workflow).mode & 0o777, workflowMode);
	assert.equal(statSync(fixture.paths.resolver).mode & 0o777, resolverMode);
	assert.equal(
		statSync(fixture.paths.migrationGuide).mode & 0o777,
		migrationGuideMode,
	);
	assert.equal(
		readdirSync(join(fixture.root, ".github", "workflows")).some((name) =>
			name.endsWith(".tmp"),
		),
		false,
	);

	const second = syncReleaseToolchainPins(fixture.root);
	assert.deepEqual(second, { pins: newPins, changed: [] });
});

test("pin synchronization validates every target before mutating any", (t) => {
	const originalWorkflow = workflow();
	const fixture = createRepositoryFixture(t, {
		workflow: originalWorkflow,
		resolver: resolver("latest"),
	});
	assert.throws(
		() => syncReleaseToolchainPins(fixture.root),
		/PAIRED_HUTCH_VERSION must be an exact SemVer 2\.0\.0/,
	);
	assert.equal(readFileSync(fixture.paths.workflow, "utf8"), originalWorkflow);
	assert.equal(readFileSync(fixture.paths.resolver, "utf8"), resolver("latest"));
});

test("a malformed documented pin prevents every target mutation", (t) => {
	const originalWorkflow = workflow();
	const originalResolver = resolver();
	const fixture = createRepositoryFixture(t, {
		workflow: originalWorkflow,
		resolver: originalResolver,
		migrationGuide: migrationGuide("latest"),
	});
	assert.throws(
		() => syncReleaseToolchainPins(fixture.root),
		/documented pragma Hutch pin must be an exact SemVer 2\.0\.0/,
	);
	assert.equal(readFileSync(fixture.paths.workflow, "utf8"), originalWorkflow);
	assert.equal(readFileSync(fixture.paths.resolver, "utf8"), originalResolver);
	assert.equal(
		readFileSync(fixture.paths.migrationGuide, "utf8"),
		migrationGuide("latest"),
	);
});

test("pin synchronization rejects malformed canonical pragma pins", (t) => {
	const fixture = createRepositoryFixture(t, {
		config:
			"// @hutch cli=^0.24.0 cottontail=0.6.0\nexport default {};\n",
	});
	assert.throws(
		() => syncReleaseToolchainPins(fixture.root),
		/package\/hutch\.config\.ts Hutch pin must be an exact SemVer 2\.0\.0/,
	);
});

test("workflow synchronization rejects missing, duplicate, and malformed fields", () => {
	assert.throws(
		() =>
			updateReleaseWorkflowPins(
				"env:\n  EXPECTED_HUTCH_VERSION: '0.23.0'\n",
				newPins,
			),
		/exactly one EXPECTED_COTTONTAIL_VERSION field; found 0/,
	);
	assert.throws(
		() =>
			updateReleaseWorkflowPins(
				`${workflow()}      EXPECTED_HUTCH_VERSION: '0.22.0'\n`,
				newPins,
			),
		/exactly one EXPECTED_HUTCH_VERSION field; found 2/,
	);
	assert.throws(
		() =>
			updateReleaseWorkflowPins(
				workflow().replace("'0.23.0'", "latest"),
				newPins,
			),
		/must be a single quoted scalar/,
	);
	assert.throws(
		() =>
			updateReleaseWorkflowPins(
				workflow().replace("0.23.0", "production"),
				newPins,
			),
		/EXPECTED_HUTCH_VERSION must be an exact SemVer 2\.0\.0/,
	);
});

test("resolver synchronization rejects missing, duplicate, and malformed constants", () => {
	assert.throws(
		() => updateNpmResolverPin("module.exports = {};\n", newPins.hutch),
		/exactly one PAIRED_HUTCH_VERSION constant; found 0/,
	);
	assert.throws(
		() =>
			updateNpmResolverPin(
				`${resolver()}const PAIRED_HUTCH_VERSION = "0.22.0";\n`,
				newPins.hutch,
			),
		/exactly one PAIRED_HUTCH_VERSION constant; found 2/,
	);
	assert.throws(
		() =>
			updateNpmResolverPin(
				"const PAIRED_HUTCH_VERSION = latest;\n",
				newPins.hutch,
			),
		/must be a quoted const declaration/,
	);
	assert.throws(
		() => updateNpmResolverPin(resolver("latest"), newPins.hutch),
		/PAIRED_HUTCH_VERSION must be an exact SemVer 2\.0\.0/,
	);
});

test("migration-guide synchronization rejects missing, duplicate, and malformed pins", () => {
	assert.throws(
		() => updateMigrationGuideHutchPin("# No install example\n", newPins.hutch),
		/exactly one documented \/\/ @hutch pragma; found 0/,
	);
	assert.throws(
		() =>
			updateMigrationGuideHutchPin(
				`${migrationGuide()}\n// @hutch cli=0.22.0 cottontail=0.5.0\n`,
				newPins.hutch,
			),
		/exactly one documented \/\/ @hutch pragma; found 2/,
	);
	assert.throws(
		() => updateMigrationGuideHutchPin(migrationGuide("latest"), newPins.hutch),
		/documented pragma Hutch pin must be an exact SemVer 2\.0\.0/,
	);
	assert.throws(
		() =>
			updateMigrationGuideHutchPin(
				migrationGuide().replace("cottontail=0.5.0", "cottontail=production"),
				newPins.hutch,
			),
		/documented pragma Cottontail pin must be an exact SemVer 2\.0\.0/,
	);
});
