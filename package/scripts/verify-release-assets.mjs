#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	createReadStream,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ELECTROBUN_INDEX = "electrobun-artifacts.json";
const HUTCH_INDEX = "hutch-artifacts.json";
const INDEX_SCHEMA_VERSION = 1;
const maxIndexBytes = 1024 * 1024;
const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bootstrapManifestPath = resolve(
	repositoryRoot,
	"npm/electrobun/package.json",
);
const resolverPath = resolve(
	repositoryRoot,
	"npm/electrobun/bin/resolve-hutch.cjs",
);

const productPlatforms = {
	"linux-arm64": {
		archiveTarget: "linux-arm64",
		target: { os: "linux", arch: "arm64" },
	},
	"linux-x64": {
		archiveTarget: "linux-x64",
		target: { os: "linux", arch: "x64" },
	},
	"macos-arm64": {
		archiveTarget: "darwin-arm64",
		target: { os: "macos", arch: "arm64" },
	},
	"windows-x64": {
		archiveTarget: "win-x64",
		target: { os: "win", arch: "x64" },
	},
};
const platformKeys = Object.keys(productPlatforms).sort();

function fail(message) {
	throw new Error(`Electrobun release assets: ${message}`);
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function exactVersion(value, label) {
	if (typeof value !== "string" || !strictSemver.test(value)) {
		fail(`${label} must be exact SemVer`);
	}
	return value;
}

function repositoryName(value) {
	if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(value ?? "")) {
		fail(`invalid GitHub repository ${JSON.stringify(value)}`);
	}
	return value;
}

function positiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) {
		fail(`${label} must be a positive integer`);
	}
	return value;
}

function exactKeys(value, expected, label) {
	const actual = Object.keys(object(value, label)).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(`${label} keys ${JSON.stringify(actual)} do not match ${JSON.stringify(expected)}`);
	}
	return value;
}

function readIndex(assets, name) {
	const path = assets.get(name);
	if (!path) fail(`existing release is missing ${name}`);
	const size = statSync(path).size;
	if (size < 1 || size > maxIndexBytes) fail(`${name} has an invalid size`);
	try {
		return object(JSON.parse(readFileSync(path, "utf8")), name);
	} catch (error) {
		if (error.message.startsWith("Electrobun release assets:")) throw error;
		fail(`${name} is invalid JSON: ${error.message}`);
	}
}

function downloadedAssets(root) {
	const assets = new Map();
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile()) fail(`unexpected downloaded release entry ${entry.name}`);
		assets.set(entry.name, resolve(root, entry.name));
	}
	return assets;
}

function descriptor(value, label, filename, releaseUrl) {
	const asset = object(value, label);
	if (asset.url !== `${releaseUrl}/${filename}`) {
		fail(`${label} URL does not match ${filename} on the immutable release`);
	}
	const size = positiveInteger(asset.size, `${label} size`);
	if (!/^[0-9a-f]{64}$/.test(asset.sha256)) {
		fail(`${label} SHA-256 is invalid`);
	}
	return { filename, sha256: asset.sha256, size };
}

function validateAbi(value) {
	const abi = object(value, `${ELECTROBUN_INDEX} abi`);
	for (const [key, name] of [
		["core", "electrobun-core"],
		["sdk", "electrobun-sdk"],
	]) {
		const entry = object(abi[key], `${ELECTROBUN_INDEX} abi.${key}`);
		if (entry.name !== name) fail(`${ELECTROBUN_INDEX} abi.${key}.name is invalid`);
		positiveInteger(entry.version, `${ELECTROBUN_INDEX} abi.${key}.version`);
	}
}

function productDescriptors(index, version, releaseUrl) {
	if (index.schemaVersion !== INDEX_SCHEMA_VERSION) {
		fail(`${ELECTROBUN_INDEX} schemaVersion is unsupported`);
	}
	const product = object(index.product, `${ELECTROBUN_INDEX} product`);
	if (product.name !== "electrobun" || product.version !== version) {
		fail(`${ELECTROBUN_INDEX} product identity does not match the release`);
	}
	const devkit = object(index.devkit, `${ELECTROBUN_INDEX} devkit`);
	if (devkit.manifest !== "native-devkit.json" || devkit.schemaVersion !== 1) {
		fail(`${ELECTROBUN_INDEX} devkit identity is invalid`);
	}
	validateAbi(index.abi);

	const platforms = exactKeys(
		index.platforms,
		platformKeys,
		`${ELECTROBUN_INDEX} platforms`,
	);
	const descriptors = [];
	for (const key of platformKeys) {
		const expected = productPlatforms[key];
		const entry = object(platforms[key], `${ELECTROBUN_INDEX} ${key}`);
		const target = object(entry.target, `${ELECTROBUN_INDEX} ${key} target`);
		if (
			target.os !== expected.target.os ||
			target.arch !== expected.target.arch
		) {
			fail(`${ELECTROBUN_INDEX} ${key} target identity is invalid`);
		}
		descriptors.push(
			descriptor(
				entry.core,
				`${ELECTROBUN_INDEX} ${key} core`,
				`electrobun-core-${expected.archiveTarget}.tar.gz`,
				releaseUrl,
			),
		);
		if (entry.cef !== undefined) {
			descriptors.push(
				descriptor(
					entry.cef,
					`${ELECTROBUN_INDEX} ${key} CEF`,
					`electrobun-cef-${expected.archiveTarget}.tar.gz`,
					releaseUrl,
				),
			);
		}
	}
	return descriptors;
}

function hutchDescriptors(index, version, hutchVersion, releaseUrl) {
	if (index.schemaVersion !== INDEX_SCHEMA_VERSION) {
		fail(`${HUTCH_INDEX} schemaVersion is unsupported`);
	}
	const product = object(index.product, `${HUTCH_INDEX} product`);
	if (product.name !== "electrobun" || product.version !== version) {
		fail(`${HUTCH_INDEX} product identity does not match the release`);
	}
	const hutch = object(index.hutch, `${HUTCH_INDEX} hutch`);
	if (hutch.version !== hutchVersion) {
		fail(`${HUTCH_INDEX} paired Hutch identity does not match`);
	}
	const platforms = exactKeys(
		index.platforms,
		platformKeys,
		`${HUTCH_INDEX} platforms`,
	);
	return platformKeys.map((key) =>
		descriptor(
			object(platforms[key], `${HUTCH_INDEX} ${key}`).archive,
			`${HUTCH_INDEX} ${key} archive`,
			`electrobun-hutch-${key}.tar.gz`,
			releaseUrl,
		),
	);
}

function digest(path) {
	return new Promise((resolveDigest, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveDigest(hash.digest("hex")));
	});
}

export function readPairedHutchVersion(source) {
	const version = source.match(
		/^const PAIRED_HUTCH_VERSION = "([^"]+)";$/m,
	)?.[1];
	return exactVersion(version, "paired Hutch version");
}

export async function verifyReleaseAssets(options) {
	const version = exactVersion(options.electrobunVersion, "Electrobun version");
	const hutchVersion = exactVersion(options.hutchVersion, "paired Hutch version");
	const repository = repositoryName(options.repository);
	const tag = `v${version}`;
	if (options.tag !== tag) {
		fail(`release tag must be ${tag}, got ${JSON.stringify(options.tag)}`);
	}
	const releaseUrl = `https://github.com/${repository}/releases/download/${tag}`;
	const assets = downloadedAssets(resolve(options.actualRoot));
	const productIndex = readIndex(assets, ELECTROBUN_INDEX);
	const hutchIndex = readIndex(assets, HUTCH_INDEX);
	const descriptors = [
		...productDescriptors(productIndex, version, releaseUrl),
		...hutchDescriptors(hutchIndex, version, hutchVersion, releaseUrl),
	];
	const descriptorNames = descriptors.map(({ filename }) => filename);
	if (new Set(descriptorNames).size !== descriptorNames.length) {
		fail("release indexes contain duplicate asset names");
	}
	const expectedNames = [ELECTROBUN_INDEX, HUTCH_INDEX, ...descriptorNames].sort();
	const actualNames = [...assets.keys()].sort();
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		const expected = new Set(expectedNames);
		const missing = expectedNames.filter((name) => !assets.has(name));
		const unexpected = actualNames.filter((name) => !expected.has(name));
		fail(
			`existing release asset set differs (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
		);
	}

	for (const asset of descriptors) {
		const path = assets.get(asset.filename);
		const actualSize = statSync(path).size;
		if (actualSize !== asset.size) {
			fail(
				`${asset.filename} size ${actualSize} does not match indexed ${asset.size}`,
			);
		}
		if ((await digest(path)) !== asset.sha256) {
			fail(`${asset.filename} SHA-256 does not match its release index`);
		}
	}
	return expectedNames;
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) fail("invalid arguments");
		if (flag === "--actual") options.actualRoot = value;
		else if (flag === "--repository") options.repository = value;
		else if (flag === "--tag") options.tag = value;
		else fail(`unknown argument ${flag}`);
	}
	if (!options.actualRoot) fail("missing --actual");
	if (!options.repository) fail("missing --repository");
	if (!options.tag) fail("missing --tag");
	options.electrobunVersion = JSON.parse(
		readFileSync(bootstrapManifestPath, "utf8"),
	).version;
	options.hutchVersion = readPairedHutchVersion(readFileSync(resolverPath, "utf8"));
	return options;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const assets = await verifyReleaseAssets(parseArguments(process.argv.slice(2)));
		console.log(
			`Verified ${assets.length} self-consistent immutable Electrobun release assets`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
