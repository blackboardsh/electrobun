#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictSemVer } from "../src/shared/strict-semver.js";

function fail(message) {
	throw new Error(`Electrobun release version: ${message}`);
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
	}
	return value;
}

function readPackageVersion(packageJsonPath) {
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	} catch (error) {
		fail(`cannot read ${packageJsonPath}: ${error.message}`);
	}
	return manifest?.version;
}

function explicitPrereleaseFromEnvironment(value) {
	if (value === undefined || value === "" || value === "false") return false;
	if (value === "true") return true;
	fail(`EXPLICIT_PRERELEASE must be true or false, got ${JSON.stringify(value)}`);
}

export function verifyReleaseVersion({
	tag,
	version,
	prefix = "v",
	explicitPrerelease = false,
}) {
	const parsed = parseStrictSemVer(version);
	if (!parsed) {
		fail(
			`package version must be an exact SemVer 2.0.0 version, got ${JSON.stringify(version)}`,
		);
	}

	nonEmptyString(tag, "release tag");
	nonEmptyString(prefix, "release tag prefix");
	if (!/^[0-9A-Za-z._-]+$/.test(prefix)) {
		fail(`release tag prefix contains unsupported characters: ${JSON.stringify(prefix)}`);
	}
	if (typeof explicitPrerelease !== "boolean") {
		fail(
			`explicit prerelease must be a boolean, got ${JSON.stringify(explicitPrerelease)}`,
		);
	}

	const expectedTag = `${prefix}${version}`;
	if (tag !== expectedTag) {
		fail(
			`release tag must be ${JSON.stringify(expectedTag)}, got ${JSON.stringify(tag)}`,
		);
	}

	const prerelease = parsed.prerelease !== null;
	if (explicitPrerelease && !prerelease) {
		fail(
			`explicit prerelease is true, but package version ${JSON.stringify(version)} has no prerelease identifiers`,
		);
	}
	return {
		tag,
		version,
		prerelease,
		environment: prerelease ? "canary" : "production",
		npmDistTag: prerelease ? "beta" : "latest",
	};
}

export function verifyReleaseVersionFromEnvironment(
	environment = process.env,
	currentDirectory = process.cwd(),
) {
	const packageJsonPath = resolve(
		currentDirectory,
		environment.RELEASE_PACKAGE_JSON ?? "package/package.json",
	);
	return verifyReleaseVersion({
		tag: environment.RELEASE_TAG,
		version: readPackageVersion(packageJsonPath),
		prefix: environment.RELEASE_TAG_PREFIX ?? "v",
		explicitPrerelease: explicitPrereleaseFromEnvironment(
			environment.EXPLICIT_PRERELEASE,
		),
	});
}

function githubOutputs(result) {
	return [
		`tag=${result.tag}`,
		`version=${result.version}`,
		`prerelease=${result.prerelease}`,
		`env=${result.environment}`,
		`dist-tag=${result.npmDistTag}`,
	].join("\n");
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = verifyReleaseVersionFromEnvironment();
		if (process.env.GITHUB_OUTPUT) {
			appendFileSync(process.env.GITHUB_OUTPUT, `${githubOutputs(result)}\n`, "utf8");
		} else {
			console.log(JSON.stringify(result));
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
