#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStrictSemVer } from "../src/shared/strict-semver.js";
import { parseHutchPragma } from "./verify-release-toolchain.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = dirname(dirname(dirname(scriptPath)));

function fail(message) {
	throw new Error(`Electrobun toolchain pin sync: ${message}`);
}

function assertStableVersion(value, label) {
	const parsed = parseStrictSemVer(value);
	if (!parsed || parsed.prerelease !== null) {
		fail(
			`${label} must be an exact stable SemVer 2.0.0 version, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

function replaceWorkflowField(source, name, value) {
	const candidates = [
		...source.matchAll(new RegExp(`^[\\t ]*${name}[\\t ]*:.*$`, "gm")),
	];
	if (candidates.length !== 1) {
		fail(
			`.github/workflows/release.yml must contain exactly one ${name} field; found ${candidates.length}`,
		);
	}

	const candidate = candidates[0];
	const exact = new RegExp(
		`^([\\t ]*${name}[\\t ]*:[\\t ]*)(["'])([^"'\\r\\n]+)\\2([\\t ]*)$`,
	).exec(candidate[0]);
	if (!exact) {
		fail(
			`.github/workflows/release.yml ${name} must be a single quoted scalar`,
		);
	}
	assertStableVersion(
		exact[3],
		`.github/workflows/release.yml ${name}`,
	);

	const replacement = `${exact[1]}${exact[2]}${value}${exact[2]}${exact[4]}`;
	return `${source.slice(0, candidate.index)}${replacement}${source.slice(
		candidate.index + candidate[0].length,
	)}`;
}

export function updateReleaseWorkflowPins(source, pins) {
	assertStableVersion(pins.hutch, "canonical Hutch pin");
	assertStableVersion(pins.cottontail, "canonical Cottontail pin");
	let updated = replaceWorkflowField(
		source,
		"EXPECTED_HUTCH_VERSION",
		pins.hutch,
	);
	updated = replaceWorkflowField(
		updated,
		"EXPECTED_COTTONTAIL_VERSION",
		pins.cottontail,
	);
	return updated;
}

export function updateNpmResolverPin(source, hutchVersion) {
	assertStableVersion(hutchVersion, "canonical Hutch pin");
	const candidates = [
		...source.matchAll(
			/^[\t ]*const[\t ]+PAIRED_HUTCH_VERSION\b.*$/gm,
		),
	];
	if (candidates.length !== 1) {
		fail(
			`npm/electrobun/bin/resolve-hutch.cjs must contain exactly one PAIRED_HUTCH_VERSION constant; found ${candidates.length}`,
		);
	}

	const candidate = candidates[0];
	const exact = /^([\t ]*const[\t ]+PAIRED_HUTCH_VERSION[\t ]*=[\t ]*)(["'])([^"'\r\n]+)\2(;[\t ]*)$/.exec(
		candidate[0],
	);
	if (!exact) {
		fail(
			"npm/electrobun/bin/resolve-hutch.cjs PAIRED_HUTCH_VERSION must be a quoted const declaration ending in a semicolon",
		);
	}
	assertStableVersion(
		exact[3],
		"npm/electrobun/bin/resolve-hutch.cjs PAIRED_HUTCH_VERSION",
	);

	const replacement = `${exact[1]}${exact[2]}${hutchVersion}${exact[2]}${exact[4]}`;
	return `${source.slice(0, candidate.index)}${replacement}${source.slice(
		candidate.index + candidate[0].length,
	)}`;
}

export function updateMigrationGuideHutchPin(source, hutchVersion) {
	assertStableVersion(hutchVersion, "canonical Hutch pin");
	const candidates = [...source.matchAll(/^\/\/ @hutch\b.*$/gm)];
	if (candidates.length !== 1) {
		fail(
			`docs/src/content/docs/electrobun/guides/migrating-to-v2.mdx must contain exactly one documented // @hutch pragma; found ${candidates.length}`,
		);
	}

	const candidate = candidates[0];
	const pins = parseHutchPragma(
		candidate[0],
		"docs/src/content/docs/electrobun/guides/migrating-to-v2.mdx documented pragma",
	);
	const replacement = `// @hutch cli=${hutchVersion} cottontail=${pins.cottontail}`;
	return `${source.slice(0, candidate.index)}${replacement}${source.slice(
		candidate.index + candidate[0].length,
	)}`;
}

function atomicWriteFile(path, source) {
	const mode = statSync(path).mode & 0o777;
	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporaryPath, source, {
			encoding: "utf8",
			flag: "wx",
			mode,
		});
		chmodSync(temporaryPath, mode);
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function syncReleaseToolchainPins(repositoryRoot = defaultRepositoryRoot) {
	const root = resolve(repositoryRoot);
	const configPath = join(root, "package", "hutch.config.ts");
	const workflowPath = join(root, ".github", "workflows", "release.yml");
	const resolverPath = join(
		root,
		"npm",
		"electrobun",
		"bin",
		"resolve-hutch.cjs",
	);
	const migrationGuidePath = join(
		root,
		"docs",
		"src",
		"content",
		"docs",
		"electrobun",
		"guides",
		"migrating-to-v2.mdx",
	);
	const pins = parseHutchPragma(
		readFileSync(configPath, "utf8"),
		"package/hutch.config.ts",
	);

	// Compute and validate every update before replacing any target. This
	// prevents a malformed later target from leaving an earlier one synchronized
	// only partially. Each changed file is then independently replaced with a
	// same-directory atomic rename.
	const updates = [
		{
			path: workflowPath,
			source: readFileSync(workflowPath, "utf8"),
			update: (source) => updateReleaseWorkflowPins(source, pins),
		},
		{
			path: resolverPath,
			source: readFileSync(resolverPath, "utf8"),
			update: (source) => updateNpmResolverPin(source, pins.hutch),
		},
		{
			path: migrationGuidePath,
			source: readFileSync(migrationGuidePath, "utf8"),
			update: (source) => updateMigrationGuideHutchPin(source, pins.hutch),
		},
	].map((entry) => ({ ...entry, updated: entry.update(entry.source) }));

	const changed = updates.filter(({ source, updated }) => source !== updated);
	for (const update of changed) atomicWriteFile(update.path, update.updated);

	return {
		pins,
		changed: changed.map(({ path }) =>
			relative(root, path).split("\\").join("/"),
		),
	};
}

const invokedPath = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: "";
if (invokedPath === import.meta.url) {
	try {
		const result = syncReleaseToolchainPins();
		const detail = result.changed.length
			? `updated ${result.changed.join(", ")}`
			: "already synchronized";
		console.log(
			`Hutch ${result.pins.hutch} and Cottontail ${result.pins.cottontail}: ${detail}.`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
