import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
	verifyReleaseVersion,
	verifyReleaseVersionFromEnvironment,
} from "./verify-release-version.mjs";

test("derives production and canary channels from strict SemVer", () => {
	assert.deepEqual(
		verifyReleaseVersion({ tag: "v2.0.0", version: "2.0.0" }),
		{
			tag: "v2.0.0",
			version: "2.0.0",
			prerelease: false,
			environment: "production",
			npmDistTag: "latest",
		},
	);
	assert.deepEqual(
		verifyReleaseVersion({
			tag: "v2.0.0-beta.7+build.4",
			version: "2.0.0-beta.7+build.4",
		}),
		{
			tag: "v2.0.0-beta.7+build.4",
			version: "2.0.0-beta.7+build.4",
			prerelease: true,
			environment: "canary",
			npmDistTag: "beta",
		},
	);
});

test("does not mistake hyphens in build metadata for a prerelease", () => {
	const result = verifyReleaseVersion({
		tag: "v2.0.0+build-with-hyphen",
		version: "2.0.0+build-with-hyphen",
	});
	assert.equal(result.prerelease, false);
	assert.equal(result.environment, "production");
	assert.equal(result.npmDistTag, "latest");
});

test("accepts a consistent explicit prerelease input", () => {
	const result = verifyReleaseVersion({
		tag: "v2.0.0-beta.1",
		version: "2.0.0-beta.1",
		explicitPrerelease: true,
	});
	assert.equal(result.prerelease, true);
	assert.equal(result.environment, "canary");
	assert.equal(result.npmDistTag, "beta");
});

test("rejects an explicit prerelease input for a stable version", () => {
	assert.throws(
		() =>
			verifyReleaseVersion({
				tag: "v2.0.0",
				version: "2.0.0",
				explicitPrerelease: true,
			}),
		/has no prerelease identifiers/,
	);
});

test("supports the independent npm bootstrap tag prefix", () => {
	assert.equal(
		verifyReleaseVersion({
			tag: "npm-v2.0.0",
			version: "2.0.0",
			prefix: "npm-v",
		}).npmDistTag,
		"latest",
	);
});

test("rejects loose versions, ranges, channels, aliases, paths, and whitespace", () => {
	for (const version of [
		"02.0.0",
		"2.0.0-beta.01",
		"^2.0.0",
		"latest",
		"beta",
		"npm:electrobun@2.0.0",
		"file:../electrobun",
		"../2.0.0",
		"v2.0.0",
		" 2.0.0",
		"2.0.0\n",
	]) {
		assert.throws(
			() => verifyReleaseVersion({ tag: `v${version}`, version }),
			/exact SemVer 2\.0\.0/,
			version,
		);
	}
});

test("requires an exact tag and a safe fixed prefix", () => {
	for (const tag of ["2.0.0", "v2.0.1", "v2.0.0/extra", "npm-v2.0.0"]) {
		assert.throws(
			() => verifyReleaseVersion({ tag, version: "2.0.0" }),
			/release tag must be "v2\.0\.0"/,
		);
	}
	assert.throws(
		() =>
			verifyReleaseVersion({
				tag: "npm/v2.0.0",
				version: "2.0.0",
				prefix: "npm/v",
			}),
		/unsupported characters/,
	);
});

test("reads the package manifest and validates environment booleans", () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-release-version-"));
	try {
		writeFileSync(
			join(fixtureRoot, "package.json"),
			'{"version":"2.0.0-rc.1"}\n',
		);
		assert.equal(
			verifyReleaseVersionFromEnvironment(
				{
					RELEASE_TAG: "npm-v2.0.0-rc.1",
					RELEASE_TAG_PREFIX: "npm-v",
					RELEASE_PACKAGE_JSON: "package.json",
					EXPLICIT_PRERELEASE: "false",
				},
				fixtureRoot,
			).npmDistTag,
			"beta",
		);
		assert.throws(
			() =>
				verifyReleaseVersionFromEnvironment(
					{
						RELEASE_TAG: "npm-v2.0.0-rc.1",
						RELEASE_TAG_PREFIX: "npm-v",
						RELEASE_PACKAGE_JSON: "package.json",
						EXPLICIT_PRERELEASE: "yes",
					},
					fixtureRoot,
				),
			/EXPLICIT_PRERELEASE must be true or false/,
		);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});

test("CLI writes all GitHub Actions outputs", () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-release-version-cli-"));
	try {
		const outputPath = join(fixtureRoot, "github-output.txt");
		writeFileSync(
			join(fixtureRoot, "package.json"),
			'{"version":"2.0.0+build-with-hyphen"}\n',
		);
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./verify-release-version.mjs", import.meta.url))],
			{
				cwd: fixtureRoot,
				encoding: "utf8",
				env: {
					...process.env,
					RELEASE_TAG: "v2.0.0+build-with-hyphen",
					RELEASE_PACKAGE_JSON: "package.json",
					GITHUB_OUTPUT: outputPath,
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(outputPath, "utf8"),
			[
				"tag=v2.0.0+build-with-hyphen",
				"version=2.0.0+build-with-hyphen",
				"prerelease=false",
				"env=production",
				"dist-tag=latest",
				"",
			].join("\n"),
		);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});
