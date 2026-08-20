#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HUTCH_RELEASE_PLATFORMS = [
	"macos-arm64",
	"linux-arm64",
	"linux-x64",
	"windows-x64",
];
export const HUTCH_ARTIFACT_INDEX_FILENAME = "hutch-artifacts.json";
export const HUTCH_ARTIFACT_INDEX_SCHEMA_VERSION = 1;

const npmRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resolverPath = join(npmRoot, "electrobun", "bin", "resolve-hutch.cjs");
const bootstrapManifestPath = join(npmRoot, "electrobun", "package.json");
const defaultArtifactsBaseUrl = "https://hutch.blackboard.sh";
const maxManifestBytes = 1024 * 1024;
const maxArchiveBytes = 64 * 1024 * 1024;
const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const require = createRequire(import.meta.url);
const { installDownloadedArchive } = require(resolverPath);
const runtimePlatforms = {
	"macos-arm64": "darwin",
	"linux-arm64": "linux",
	"linux-x64": "linux",
	"windows-x64": "win32",
};

function fail(message) {
	throw new Error(`Hutch release staging: ${message}`);
}

function validatedBaseUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`invalid artifacts base URL ${JSON.stringify(value)}`);
	}
	const localHttp =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !localHttp) {
		fail("artifact downloads require HTTPS (except localhost test servers)");
	}
	return url.href.replace(/\/+$/, "");
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function positiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) {
		fail(`${label} must be a positive integer`);
	}
	return value;
}

function exactVersion(value, label) {
	if (typeof value !== "string" || !strictSemver.test(value)) {
		fail(`invalid ${label} ${JSON.stringify(value)}`);
	}
	return value;
}

function githubRepository(value) {
	if (!/^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/.test(value ?? "")) {
		fail(`invalid GitHub repository ${JSON.stringify(value)}`);
	}
	return value;
}

export function readPairedHutchVersion(source) {
	const version = source.match(
		/^const PAIRED_HUTCH_VERSION = "([^"]+)";$/m,
	)?.[1];
	if (!version || !strictSemver.test(version)) {
		fail("resolve-hutch.cjs has no exact PAIRED_HUTCH_VERSION");
	}
	return version;
}

async function fetchBytes(fetchImpl, url, maximum, label) {
	const response = await fetchImpl(url);
	if (!response?.ok) {
		fail(`${label} returned HTTP ${response?.status ?? "unknown"}`);
	}
	const declaredLength = Number(response.headers?.get?.("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximum) {
		fail(`${label} exceeds the ${maximum}-byte limit`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > maximum) {
		fail(`${label} exceeds the ${maximum}-byte limit`);
	}
	return bytes;
}

function validateManifest(manifest, hutchVersion) {
	const value = object(manifest, "release manifest");
	if (value.schema !== 1 || value.kind !== "release" || value.product !== "hutch") {
		fail("release manifest identity is invalid");
	}
	if (value.version !== hutchVersion) {
		fail(
			`release manifest version ${JSON.stringify(value.version)} does not match ${hutchVersion}`,
		);
	}
	const platforms = object(value.platforms, "release manifest platforms");
	const actual = Object.keys(platforms).sort();
	const expected = [...HUTCH_RELEASE_PLATFORMS].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(
			`release platforms ${JSON.stringify(actual)} do not match ${JSON.stringify(expected)}`,
		);
	}
	return platforms;
}

function archiveDescriptor(platform, platformEntry) {
	const archive = object(
		object(platformEntry, `${platform} entry`).archive,
		`${platform} archive`,
	);
	if (typeof archive.url !== "string") fail(`${platform} archive URL is invalid`);
	const url = validatedBaseUrl(archive.url);
	if (!/^[0-9a-f]{64}$/.test(archive.sha256)) {
		fail(`${platform} archive SHA-256 is invalid`);
	}
	const size = positiveInteger(archive.size, `${platform} archive size`);
	if (size > maxArchiveBytes) {
		fail(`${platform} archive exceeds the ${maxArchiveBytes}-byte limit`);
	}
	return { url, sha256: archive.sha256, size };
}

function validateArchiveLayout(bytes, platform, hutchVersion) {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-layout-"));
	try {
		installDownloadedArchive({
			archive: bytes,
			environment: process.env,
			expectedHutchVersion: hutchVersion,
			platform: runtimePlatforms[platform],
			platformKey: platform,
			root: join(temporary, "cache"),
			tarExecutable: "tar",
		});
	} catch (error) {
		fail(`${platform} archive layout or metadata is invalid: ${error.message}`);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export async function stageHutchReleaseArtifacts(options) {
	const hutchVersion = exactVersion(options.hutchVersion, "Hutch version");
	const electrobunVersion = exactVersion(
		options.electrobunVersion,
		"Electrobun version",
	);
	const expectedTag = `v${electrobunVersion}`;
	if (options.tag !== expectedTag) {
		fail(`release tag must be ${expectedTag}, got ${JSON.stringify(options.tag)}`);
	}
	const repository = githubRepository(options.repository);
	const releaseUrl = `https://github.com/${repository}/releases/download/${expectedTag}`;
	const outputRoot = resolve(options.outputRoot);
	if (existsSync(outputRoot)) {
		fail(`output directory already exists: ${outputRoot}`);
	}
	const artifactsBaseUrl = validatedBaseUrl(
		options.artifactsBaseUrl ?? defaultArtifactsBaseUrl,
	);
	const fetchImpl = options.fetchImpl ?? fetch;
	const manifestUrl = `${artifactsBaseUrl}/hutch/releases/${hutchVersion}/manifest.json`;
	const manifestBytes = await fetchBytes(
		fetchImpl,
		manifestUrl,
		maxManifestBytes,
		"Hutch release manifest",
	);
	let manifest;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8"));
	} catch (error) {
		fail(`release manifest is not valid JSON: ${error.message}`);
	}
	const platforms = validateManifest(manifest, hutchVersion);

	mkdirSync(outputRoot, { recursive: true });
	try {
		const stagedPlatforms = {};
		for (const platform of HUTCH_RELEASE_PLATFORMS) {
			const descriptor = archiveDescriptor(platform, platforms[platform]);
			const bytes = await fetchBytes(
				fetchImpl,
				descriptor.url,
				maxArchiveBytes,
				`${platform} Hutch archive`,
			);
			if (bytes.length !== descriptor.size) {
				fail(
					`${platform} archive size ${bytes.length} does not match ${descriptor.size}`,
				);
			}
			const digest = createHash("sha256").update(bytes).digest("hex");
			if (digest !== descriptor.sha256) {
				fail(`${platform} archive SHA-256 does not match the Hutch manifest`);
			}
			validateArchiveLayout(bytes, platform, hutchVersion);

			const filename = `electrobun-hutch-${platform}.tar.gz`;
			writeFileSync(join(outputRoot, filename), bytes, { flag: "wx" });
			stagedPlatforms[platform] = {
				archive: {
					url: `${releaseUrl}/${filename}`,
					size: bytes.length,
					sha256: digest,
				},
			};
			console.log(`staged ${filename} (Hutch ${hutchVersion})`);
		}
		writeFileSync(
			join(outputRoot, HUTCH_ARTIFACT_INDEX_FILENAME),
			`${JSON.stringify(
				{
					schemaVersion: HUTCH_ARTIFACT_INDEX_SCHEMA_VERSION,
					product: { name: "electrobun", version: electrobunVersion },
					hutch: { version: hutchVersion },
					platforms: stagedPlatforms,
				},
				null,
				"\t",
			)}\n`,
			{ flag: "wx" },
		);
	} catch (error) {
		rmSync(outputRoot, { recursive: true, force: true });
		throw error;
	}
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) fail("invalid arguments");
		if (flag === "--output") options.outputRoot = value;
		else if (flag === "--hutch-version") options.hutchVersion = value;
		else if (flag === "--electrobun-version") options.electrobunVersion = value;
		else if (flag === "--repository") options.repository = value;
		else if (flag === "--tag") options.tag = value;
		else fail(`unknown argument ${flag}`);
	}
	if (!options.outputRoot) fail("missing --output");
	options.hutchVersion ??= readPairedHutchVersion(readFileSync(resolverPath, "utf8"));
	options.electrobunVersion ??= JSON.parse(
		readFileSync(bootstrapManifestPath, "utf8"),
	).version;
	if (!options.repository) fail("missing --repository");
	if (!options.tag) fail("missing --tag");
	options.artifactsBaseUrl =
		process.env.HUTCH_ARTIFACTS_BASE_URL ?? defaultArtifactsBaseUrl;
	return options;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		await stageHutchReleaseArtifacts(parseArguments(process.argv.slice(2)));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
