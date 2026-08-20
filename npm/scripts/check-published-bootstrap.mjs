#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRegistry = "https://registry.npmjs.org";
const maxMetadataBytes = 1024 * 1024;
const requestTimeoutMs = 15_000;
const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
	throw new Error(`npm bootstrap publication: ${message}`);
}

function registryBaseUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`invalid npm registry URL ${JSON.stringify(value)}`);
	}
	const localHttp =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !localHttp) {
		fail("npm registry URL must use HTTPS");
	}
	return url.href.replace(/\/+$/, "");
}

export async function checkPublishedBootstrap(options) {
	const manifestPath = resolve(options.manifestPath);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.name !== "electrobun") fail("manifest package name must be electrobun");
	if (typeof manifest.version !== "string" || !strictSemver.test(manifest.version)) {
		fail(`manifest version is not exact SemVer: ${JSON.stringify(manifest.version)}`);
	}
	if (!new Set(["beta", "latest"]).has(options.distTag)) {
		fail(`expected npm dist-tag must be beta or latest, got ${JSON.stringify(options.distTag)}`);
	}
	const registry = registryBaseUrl(options.registry ?? defaultRegistry);
	const url = `${registry}/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
	const fetchImpl = options.fetchImpl ?? fetch;
	const metadata = await registryJson(fetchImpl, url, "version metadata", true);
	const tags =
		(await registryJson(
			fetchImpl,
			`${registry}/-/package/${encodeURIComponent(manifest.name)}/dist-tags`,
			"dist-tag metadata",
			true,
		)) ?? {};
	const taggedVersion = tags[options.distTag];
	if (!metadata) {
		if (taggedVersion === undefined) return false;
		if (typeof taggedVersion !== "string" || !strictSemver.test(taggedVersion)) {
			fail(`npm dist-tag ${options.distTag} has an invalid version`);
		}
		const comparison = compareSemver(taggedVersion, manifest.version);
		if (comparison < 0) return false;
		if (comparison > 0) {
			fail(
				`publishing ${manifest.version} would move npm dist-tag ${options.distTag} backward from newer ${taggedVersion}`,
			);
		}
		fail(
			`npm dist-tag ${options.distTag} already points to ${taggedVersion}, but that exact version has no registry metadata`,
		);
	}
	if (metadata.name !== manifest.name || metadata.version !== manifest.version) {
		fail("registry metadata identity does not match the npm bootstrap");
	}
	const publishedIntegrity = object(metadata.dist, "registry dist metadata").integrity;
	if (typeof publishedIntegrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(publishedIntegrity)) {
		fail("registry dist.integrity is missing or invalid");
	}
	const localIntegrity = (options.packIntegrity ?? packBootstrapIntegrity)(
		manifestPath,
	);
	if (publishedIntegrity !== localIntegrity) {
		fail(
			`published dist.integrity does not match the tagged npm bootstrap (${publishedIntegrity} != ${localIntegrity})`,
		);
	}

	if (taggedVersion !== manifest.version) {
		const actual = taggedVersion ?? "missing";
		if (taggedVersion !== undefined) {
			if (typeof taggedVersion !== "string" || !strictSemver.test(taggedVersion)) {
				fail(`npm dist-tag ${options.distTag} has an invalid version`);
			}
			if (compareSemver(taggedVersion, manifest.version) >= 0) {
				fail(
					`npm dist-tag ${options.distTag} points to ${taggedVersion}; refusing to move it backward to existing ${manifest.version}`,
				);
			}
		}
		fail(
			`npm dist-tag ${options.distTag} points to ${actual}, expected ${manifest.version}; repair it with "npm dist-tag add ${manifest.name}@${manifest.version} ${options.distTag}" before retrying`,
		);
	}
	return true;
}

function parseSemver(value) {
	const match = typeof value === "string" ? value.match(strictSemver) : null;
	if (!match) fail(`invalid SemVer ${JSON.stringify(value)}`);
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4]?.split(".") ?? null,
	};
}

export function compareSemver(leftValue, rightValue) {
	const left = parseSemver(leftValue);
	const right = parseSemver(rightValue);
	for (let index = 0; index < left.core.length; index += 1) {
		if (left.core[index] !== right.core[index]) {
			return left.core[index] < right.core[index] ? -1 : 1;
		}
	}
	if (left.prerelease === null || right.prerelease === null) {
		if (left.prerelease === right.prerelease) return 0;
		return left.prerelease === null ? 1 : -1;
	}
	const count = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < count; index += 1) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === undefined || rightPart === undefined) {
			return leftPart === undefined ? -1 : 1;
		}
		if (leftPart === rightPart) continue;
		const leftNumeric = /^\d+$/.test(leftPart);
		const rightNumeric = /^\d+$/.test(rightPart);
		if (leftNumeric && rightNumeric) {
			return Number(leftPart) < Number(rightPart) ? -1 : 1;
		}
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}

async function registryJson(fetchImpl, url, label, allowNotFound = false) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
	let response;
	let bytes;
	try {
		response = await fetchImpl(url, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (response.status === 404 && allowNotFound) return null;
		if (!response.ok) fail(`${label} returned HTTP ${response.status}`);
		const declared = Number(response.headers?.get?.("content-length"));
		if (Number.isFinite(declared) && declared > maxMetadataBytes) {
			fail(`${label} exceeds its size limit`);
		}
		bytes = Buffer.from(await response.arrayBuffer());
	} finally {
		clearTimeout(timeout);
	}
	if (bytes.length > maxMetadataBytes) fail(`${label} exceeds its size limit`);
	let metadata;
	try {
		metadata = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		fail(`${label} is invalid JSON: ${error.message}`);
	}
	return object(metadata, label);
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

export function packBootstrapIntegrity(manifestPath) {
	const packageRoot = dirname(resolve(manifestPath));
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-pack-"));
	try {
		const output = execFileSync(
			"npm",
			[
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temporary,
			],
			{
				cwd: packageRoot,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let report;
		try {
			report = JSON.parse(output);
		} catch (error) {
			fail(`npm pack did not return valid JSON: ${error.message}`);
		}
		if (
			!Array.isArray(report) ||
			report.length !== 1 ||
			typeof report[0]?.filename !== "string" ||
			basename(report[0].filename) !== report[0].filename
		) {
			fail("npm pack returned an invalid tarball report");
		}
		const tarball = readFileSync(join(temporary, report[0].filename));
		return `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) fail("invalid arguments");
		if (flag === "--manifest") options.manifestPath = value;
		else if (flag === "--output") options.output = value;
		else if (flag === "--tag") options.distTag = value;
		else fail(`unknown argument ${flag}`);
	}
	if (!options.manifestPath) fail("missing --manifest");
	if (!options.output) fail("missing --output");
	if (!options.distTag) fail("missing --tag");
	options.registry = process.env.NPM_REGISTRY_BASE_URL ?? defaultRegistry;
	return options;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const options = parseArguments(process.argv.slice(2));
		const exists = await checkPublishedBootstrap(options);
		appendFileSync(options.output, `exists=${exists}\n`);
		console.log(
			exists
				? "The exact electrobun npm bootstrap is already published; reusing it."
				: "The exact electrobun npm bootstrap is not published yet.",
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
