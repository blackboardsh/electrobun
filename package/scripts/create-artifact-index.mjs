#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_INDEX_FILENAME = "electrobun-artifacts.json";
export const ARTIFACT_INDEX_SCHEMA_VERSION = 1;

const archivePattern =
	/^electrobun-(core|cef)-(darwin|linux|win)-(arm64|x64)\.tar\.gz$/;
const defaultExpectedPlatforms = [
	"linux-arm64",
	"linux-x64",
	"macos-arm64",
	"windows-x64",
];

function fail(message) {
	throw new Error(`Electrobun artifact index: ${message}`);
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function nonEmptyString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${label} must be a non-empty string`);
	}
	return value;
}

function positiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) {
		fail(`${label} must be a positive integer`);
	}
	return value;
}

function validateVersion(version) {
	nonEmptyString(version, "product.version");
	if (version.length > 128 || !/^[0-9A-Za-z.+-]+$/.test(version)) {
		fail(`invalid product.version ${JSON.stringify(version)}`);
	}
	return version;
}

function validateRepository(repository) {
	if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(repository)) {
		fail(`invalid GitHub repository ${JSON.stringify(repository)}`);
	}
	return repository;
}

function targetForArchive(platform, arch) {
	if (platform === "darwin") {
		return { key: `macos-${arch}`, target: { os: "macos", arch } };
	}
	if (platform === "linux") {
		return { key: `linux-${arch}`, target: { os: "linux", arch } };
	}
	if (platform === "win" && arch === "x64") {
		return { key: "windows-x64", target: { os: "win", arch: "x64" } };
	}
	fail(`unsupported release target ${platform}-${arch}`);
}

function walkFiles(root) {
	const files = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

function descriptor(path, releaseUrl) {
	const bytes = readFileSync(path);
	return {
		url: `${releaseUrl}/${basename(path)}`,
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function readNativeDevkitManifest(coreArchive) {
	let contents;
	try {
		contents = execFileSync(
			"tar",
			["-xOzf", coreArchive, "native-devkit.json"],
			{ encoding: "utf8", maxBuffer: 1024 * 1024 },
		);
	} catch (error) {
		fail(
			`${basename(coreArchive)} does not contain a readable root native-devkit.json: ${error.message}`,
		);
	}
	try {
		return object(JSON.parse(contents), "native-devkit.json");
	} catch (error) {
		fail(`${basename(coreArchive)} has invalid native-devkit.json: ${error.message}`);
	}
}

function validateAbi(abi, expected, label) {
	const value = object(abi, label);
	if (value.name !== expected) fail(`${label}.name must be ${JSON.stringify(expected)}`);
	positiveInteger(value.version, `${label}.version`);
	return { name: value.name, version: value.version };
}

function identityFromManifest(manifest, expectedTarget, expectedVersion) {
	if (manifest.schemaVersion !== 1) {
		fail(`native-devkit.json schemaVersion must be 1`);
	}
	const product = object(manifest.product, "native-devkit.json product");
	if (product.name !== "electrobun") {
		fail(`native-devkit.json product.name must be "electrobun"`);
	}
	const version = validateVersion(product.version);
	if (version !== expectedVersion) {
		fail(
			`native-devkit.json product.version ${JSON.stringify(version)} does not match tag version ${JSON.stringify(expectedVersion)}`,
		);
	}

	const target = object(manifest.target, "native-devkit.json target");
	if (target.os !== expectedTarget.os || target.arch !== expectedTarget.arch) {
		fail(
			`native-devkit.json target ${JSON.stringify(target)} does not match archive target ${JSON.stringify(expectedTarget)}`,
		);
	}

	const abi = object(manifest.abi, "native-devkit.json abi");
	return {
		version,
		abi: {
			core: validateAbi(abi.core, "electrobun-core", "abi.core"),
			sdk: validateAbi(abi.sdk, "electrobun-sdk", "abi.sdk"),
		},
	};
}

function sameIdentity(left, right) {
	return (
		left.version === right.version &&
		left.abi.core.name === right.abi.core.name &&
		left.abi.core.version === right.abi.core.version &&
		left.abi.sdk.name === right.abi.sdk.name &&
		left.abi.sdk.version === right.abi.sdk.version
	);
}

export function createArtifactIndex(options) {
	const artifactRoot = resolve(options.artifactRoot);
	if (!existsSync(artifactRoot) || !statSync(artifactRoot).isDirectory()) {
		fail(`artifact root is not a directory: ${artifactRoot}`);
	}
	const repository = validateRepository(options.repository);
	const version = validateVersion(options.version);
	const tag = `v${version}`;
	if (options.tag !== tag) {
		fail(`release tag must be ${JSON.stringify(tag)}, got ${JSON.stringify(options.tag)}`);
	}
	const releaseUrl = `https://github.com/${repository}/releases/download/${tag}`;

	const archives = new Map();
	for (const path of walkFiles(artifactRoot)) {
		const match = archivePattern.exec(basename(path));
		if (!match) continue;
		const [, kind, platform, arch] = match;
		const { key, target } = targetForArchive(platform, arch);
		const entry = archives.get(key) ?? { target };
		if (entry[kind]) fail(`duplicate ${kind} archive for ${key}`);
		entry[kind] = { path, descriptor: descriptor(path, releaseUrl) };
		archives.set(key, entry);
	}
	if (archives.size === 0) fail(`no Electrobun release archives found in ${artifactRoot}`);

	const expected = [...(options.expectedPlatforms ?? defaultExpectedPlatforms)].sort();
	const actual = [...archives.keys()].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(`release platforms ${JSON.stringify(actual)} do not match expected ${JSON.stringify(expected)}`);
	}

	let releaseIdentity;
	const platforms = {};
	for (const key of actual) {
		const entry = archives.get(key);
		if (!entry.core) fail(`missing core archive for ${key}`);
		const identity = identityFromManifest(
			readNativeDevkitManifest(entry.core.path),
			entry.target,
			version,
		);
		if (releaseIdentity && !sameIdentity(releaseIdentity, identity)) {
			fail(`native devkit identity for ${key} differs from the other platforms`);
		}
		releaseIdentity ??= identity;

		platforms[key] = {
			target: entry.target,
			core: entry.core.descriptor,
			...(entry.cef ? { cef: entry.cef.descriptor } : {}),
		};
	}

	return {
		schemaVersion: ARTIFACT_INDEX_SCHEMA_VERSION,
		product: { name: "electrobun", version },
		devkit: { manifest: "native-devkit.json", schemaVersion: 1 },
		abi: releaseIdentity.abi,
		platforms,
	};
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) fail(`invalid arguments`);
		if (flag === "--artifacts") options.artifactRoot = value;
		else if (flag === "--output") options.output = value;
		else if (flag === "--repository") options.repository = value;
		else if (flag === "--tag") options.tag = value;
		else if (flag === "--expect") {
			options.expectedPlatforms = value.split(",").filter(Boolean);
		} else fail(`unknown argument ${flag}`);
	}
	for (const name of ["artifactRoot", "output", "repository", "tag"]) {
		if (!options[name]) fail(`missing --${name === "artifactRoot" ? "artifacts" : name}`);
	}
	if (!options.tag.startsWith("v")) fail(`release tag must start with v`);
	options.version = options.tag.slice(1);
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const options = parseArguments(process.argv.slice(2));
		const index = createArtifactIndex(options);
		writeFileSync(resolve(options.output), `${JSON.stringify(index, null, "\t")}\n`, {
			flag: "wx",
		});
		console.log(`Wrote immutable Electrobun artifact index to ${resolve(options.output)}`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
