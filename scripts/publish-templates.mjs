#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStrictSemVer } from "../package/src/shared/strict-semver.js";

export const TEMPLATE_SCHEMA = 1;
export const TEMPLATE_BUCKET = "electrobun-artifacts";
export const TEMPLATE_PREFIX = "electrobun/templates";
export const TEMPLATE_PUBLIC_BASE_URL =
	"https://electrobun-artifacts.blackboard.sh";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(scriptPath));
const templatesRoot = join(repositoryRoot, "templates");
const packageRoot = join(repositoryRoot, "package");
const outputRoot = join(repositoryRoot, ".template-release");
const skippedFiles = new Set([".DS_Store"]);

function fail(message) {
	throw new Error(`Electrobun templates: ${message}`);
}

function exactSemVer(value, label) {
	const parsed = parseStrictSemVer(value);
	if (!parsed) {
		fail(`${label} must be an exact SemVer 2.0.0 version, got ${JSON.stringify(value)}`);
	}
	return { version: value, parsed };
}

export function releaseChannel(version) {
	const { parsed } = exactSemVer(version, "invalid release version");
	return parsed.prerelease === null ? "stable" : "beta";
}

export function templateArtifactKey(checksum) {
	if (!/^[0-9a-f]{64}$/.test(checksum)) fail("invalid template checksum");
	return `${TEMPLATE_PREFIX}/artifacts/${checksum}.tar.gz`;
}

export function templateChannelKey(channel) {
	if (channel !== "stable" && channel !== "beta") {
		fail(`invalid template channel ${JSON.stringify(channel)}`);
	}
	return `${TEMPLATE_PREFIX}/channels/${channel}.json`;
}

export function parseHutchPragma(source) {
	const line = source.match(/^\/\/\s*@hutch\s+([^\r\n]+)$/m)?.[1];
	if (!line) fail("package/hutch.config.ts is missing its // @hutch pragma");
	const values = Object.fromEntries(
		line
			.trim()
			.split(/\s+/)
			.map((entry) => entry.split("=", 2)),
	);
	if (!values.cli || !values.cottontail) {
		fail("package/hutch.config.ts must pin cli and cottontail");
	}
	exactSemVer(values.cli, "Hutch CLI pin");
	exactSemVer(values.cottontail, "Cottontail pin");
	return { hutch: values.cli, cottontail: values.cottontail };
}

export function pinHutchPragma(source, pins) {
	const pragmas = source.match(/^\/\/\s*@hutch[^\r\n]*$/gm) ?? [];
	if (pragmas.length !== 1) {
		fail(`expected exactly one // @hutch pragma, found ${pragmas.length}`);
	}
	parseHutchPragma(pragmas[0]);
	if (!pins?.hutch || !pins?.cottontail) fail("release toolchain pins are missing");
	exactSemVer(pins.hutch, "Hutch CLI release pin");
	exactSemVer(pins.cottontail, "Cottontail release pin");

	const updated = pragmas[0]
		.replace(/(\bcli=)[^\s]+/, `$1${pins.hutch}`)
		.replace(/(\bcottontail=)[^\s]+/, `$1${pins.cottontail}`);
	return source.replace(pragmas[0], updated);
}

export function pinElectrobunVersion(source, version) {
	releaseChannel(version);
	const pattern = /(\belectrobun\s*:\s*\{\s*version\s*:\s*)(["'])([^"'\r\n]+)\2/g;
	const matches = [...source.matchAll(pattern)];
	if (matches.length !== 1) {
		fail(
			`expected exactly one top-level electrobun.version, found ${matches.length}`,
		);
	}
	releaseChannel(matches[0][3]);

	const match = matches[0];
	const start = match.index;
	const end = start + match[0].length;
	const replacement = `${match[1]}${match[2]}${version}${match[2]}`;
	return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function gitRevision() {
	const revision =
		process.env.GITHUB_SHA ??
		execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repositoryRoot,
			encoding: "utf8",
		}).trim();
	if (!/^[0-9a-f]{40}$/.test(revision)) {
		fail(`invalid Git revision ${JSON.stringify(revision)}`);
	}
	return revision;
}

function trackedFiles(templateId) {
	const prefix = `templates/${templateId}/`;
	const output = execFileSync(
		"git",
		["ls-files", "-z", "--", `templates/${templateId}`],
		{ cwd: repositoryRoot },
	);
	return output
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.filter((path) => path.startsWith(prefix))
		.filter((path) => !skippedFiles.has(basename(path)));
}

function titleFromId(id) {
	const names = new Map([
		["wgpu", "WGPU"],
		["sqlite", "SQLite"],
	]);
	return id
		.split("-")
		.map((part) => names.get(part) ?? `${part[0].toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

export function templateMetadata(templateId, manifest = {}) {
	const name = titleFromId(templateId);
	const descriptions = new Map([
		[
			"all",
			"Install, build, and launch every other Electrobun beta template from one QA dashboard",
		],
	]);
	return {
		name,
		description:
			manifest.description ??
			descriptions.get(templateId) ??
			`${name} Electrobun template`,
	};
}

function templateMainProcess(source) {
	return source.match(/\bmainProcess\s*:\s*["']([^"']+)["']/)?.[1] ??
		"cottontail";
}

function copyTrackedTemplate(templateId, destination) {
	const files = trackedFiles(templateId);
	if (files.length === 0) fail(`template ${templateId} has no tracked files`);
	for (const trackedPath of files) {
		const source = join(repositoryRoot, trackedPath);
		const output = join(destination, relative(`templates/${templateId}`, trackedPath));
		mkdirSync(dirname(output), { recursive: true });
		copyFileSync(source, output);
		chmodSync(output, statSync(source).mode & 0o777);
	}
}

function createTemplateArchive(templateId, sourceRoot, archivePath) {
	const result = spawnSync(
		"tar",
		["-czf", archivePath, "-C", sourceRoot, templateId],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		},
	);
	if (result.status !== 0) {
		fail(`could not archive ${templateId}: ${result.stderr || result.stdout}`);
	}
}

function stageTemplate({ templateId, version, pins, stageRoot, archiveRoot }) {
	const destination = join(stageRoot, templateId);
	mkdirSync(destination, { recursive: true });
	copyTrackedTemplate(templateId, destination);

	const manifestPath = join(destination, "package.json");
	const manifest = existsSync(manifestPath)
		? JSON.parse(readFileSync(manifestPath, "utf8"))
		: {};

	const configPath = join(destination, "electrobun.config.ts");
	if (!existsSync(configPath)) fail(`${templateId} is missing electrobun.config.ts`);
	const configSource = readFileSync(configPath, "utf8");
	const mainProcess = templateMainProcess(configSource);
	writeFileSync(configPath, pinElectrobunVersion(configSource, version));

	const hutchConfigPath = join(destination, "hutch.config.ts");
	if (!existsSync(hutchConfigPath)) fail(`${templateId} is missing hutch.config.ts`);
	const hutchSource = readFileSync(hutchConfigPath, "utf8");
	writeFileSync(hutchConfigPath, pinHutchPragma(hutchSource, pins));

	const archivePath = join(archiveRoot, `${templateId}.tar.gz`);
	createTemplateArchive(templateId, stageRoot, archivePath);
	const archive = readFileSync(archivePath);
	const checksum = sha256(archive);
	const artifactKey = templateArtifactKey(checksum);
	const metadata = templateMetadata(templateId, manifest);

	return {
		catalogEntry: {
			id: templateId,
			...metadata,
			mainProcess,
			archive: {
				url: `${TEMPLATE_PUBLIC_BASE_URL}/${artifactKey}`,
				sha256: checksum,
				size: archive.length,
			},
		},
		archivePath,
		artifactKey,
	};
}

function templateIds() {
	return readdirSync(templatesRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(templatesRoot, entry.name, "electrobun.config.ts")),
		)
		.map((entry) => entry.name)
		.sort();
}

function awsEncode(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function hmac(key, value) {
	return createHmac("sha256", key).update(value).digest();
}

function signingRequest({ accountId, accessKeyId, secretAccessKey, key, body, contentType, cacheControl }) {
	const endpoint = new URL(`https://${accountId}.r2.cloudflarestorage.com`);
	const canonicalUri = `/${[TEMPLATE_BUCKET, ...key.split("/")].map(awsEncode).join("/")}`;
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const date = amzDate.slice(0, 8);
	const payloadHash = sha256(body);
	const canonicalHeaders = [
		`cache-control:${cacheControl}`,
		`content-type:${contentType}`,
		`host:${endpoint.host}`,
		`x-amz-content-sha256:${payloadHash}`,
		`x-amz-date:${amzDate}`,
		"",
	].join("\n");
	const signedHeaders =
		"cache-control;content-type;host;x-amz-content-sha256;x-amz-date";
	const canonicalRequest = [
		"PUT",
		canonicalUri,
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");
	const scope = `${date}/auto/s3/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256(canonicalRequest),
	].join("\n");
	const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`), date);
	const regionKey = hmac(dateKey, "auto");
	const serviceKey = hmac(regionKey, "s3");
	const signingKey = hmac(serviceKey, "aws4_request");
	const signature = createHmac("sha256", signingKey)
		.update(stringToSign)
		.digest("hex");
	return {
		url: new URL(canonicalUri, endpoint).href,
		headers: {
			Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
			"Cache-Control": cacheControl,
			"Content-Type": contentType,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
		},
	};
}

async function uploadObject(credentials, object, dryRun) {
	if (dryRun) {
		console.log(`dry-run PUT ${object.key} (${object.body.length} bytes)`);
		return;
	}
	const request = signingRequest({ ...credentials, ...object });
	const response = await fetch(request.url, {
		method: "PUT",
		headers: request.headers,
		body: object.body,
	});
	if (!response.ok) {
		fail(`R2 upload failed for ${object.key}: ${response.status} ${await response.text()}`);
	}
	console.log(`uploaded ${object.key}`);
}

export async function publishTemplates({ dryRun = false, channel: requestedChannel } = {}) {
	const packageJson = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	const version = packageJson.version;
	const channel = releaseChannel(version);
	if (requestedChannel && requestedChannel !== channel) {
		fail(`release ${version} belongs to ${channel}, not ${requestedChannel}`);
	}
	const revision = gitRevision();
	const pins = parseHutchPragma(
		readFileSync(join(packageRoot, "hutch.config.ts"), "utf8"),
	);

	rmSync(outputRoot, { recursive: true, force: true });
	const stageRoot = join(outputRoot, "stage");
	const archiveRoot = join(outputRoot, "archives");
	mkdirSync(stageRoot, { recursive: true });
	mkdirSync(archiveRoot, { recursive: true });

	const staged = templateIds().map((templateId) =>
		stageTemplate({ templateId, version, pins, stageRoot, archiveRoot }),
	);
	if (staged.length === 0) fail("no templates were found");

	const publishedAt = new Date().toISOString();
	const catalog = {
		schema: TEMPLATE_SCHEMA,
		kind: "electrobun-template-channel",
		channel,
		version,
		revision,
		publishedAt,
		tools: pins,
		templates: staged.map(({ catalogEntry }) => catalogEntry),
	};
	const catalogBody = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
	const catalogPath = join(outputRoot, `${channel}.json`);
	writeFileSync(catalogPath, catalogBody);

	const credentials = dryRun
		? {}
		: {
				accountId: process.env.R2_ACCOUNT_ID,
				accessKeyId: process.env.R2_ACCESS_KEY_ID,
				secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
			};
	if (!dryRun && Object.values(credentials).some((value) => !value)) {
		fail("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required");
	}

	const immutable = "public, max-age=31536000, immutable";
	for (const template of staged) {
		await uploadObject(
			credentials,
			{
				key: template.artifactKey,
				body: readFileSync(template.archivePath),
				contentType: "application/gzip",
				cacheControl: immutable,
			},
			dryRun,
		);
	}

	// The mutable channel catalog is switched only after every archive exists.
	await uploadObject(
		credentials,
		{
			key: templateChannelKey(channel),
			body: catalogBody,
			contentType: "application/json; charset=utf-8",
			cacheControl: "no-cache, no-store, must-revalidate",
		},
		dryRun,
	);

	console.log(
		JSON.stringify(
			{ channel, version, revision, templates: staged.length, catalog: catalogPath },
			null,
			2,
		),
	);
	return catalog;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const dryRun = process.argv.includes("--dry-run");
	const channel = process.argv
		.find((argument) => argument.startsWith("--channel="))
		?.slice("--channel=".length);
	publishTemplates({ dryRun, channel }).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
