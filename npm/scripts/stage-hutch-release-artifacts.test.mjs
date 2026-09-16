import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	HUTCH_ARTIFACT_INDEX_FILENAME,
	HUTCH_RELEASE_PLATFORMS,
	readPairedHutchVersion,
	stageHutchReleaseArtifacts,
} from "./stage-hutch-release-artifacts.mjs";

const hutchVersion = "1.2.3-beta.4";
const electrobunVersion = "2.0.0-beta.7";
const repository = "blackboardsh/electrobun";
const tag = `v${electrobunVersion}`;
const baseUrl = "https://hutch.test";

function stageOptions(outputRoot, fetchImpl) {
	return {
		artifactsBaseUrl: baseUrl,
		electrobunVersion,
		fetchImpl,
		hutchVersion,
		outputRoot,
		repository,
		tag,
	};
}

function response(bytes, status = 200) {
	const body = Buffer.from(bytes);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => (name === "content-length" ? `${body.length}` : null) },
		arrayBuffer: async () => body,
	};
}

function hutchArchive(temporary, platform, metadataOverrides = {}, extra = false) {
	const rootName = `hutch-v${hutchVersion}-${platform}`;
	const staging = join(temporary, `staging-${platform}-${Math.random()}`);
	const root = join(staging, rootName);
	const extension = platform === "windows-x64" ? ".exe" : "";
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(join(root, "bin", `hutch${extension}`), `launcher:${platform}`);
	writeFileSync(
		join(root, "bin", `hutch-engine${extension}`),
		`engine:${platform}`,
	);
	writeFileSync(
		join(root, "hutch-release.json"),
		JSON.stringify({
			schema: 1,
			kind: "archive",
			product: "hutch",
			version: hutchVersion,
			platform,
			launcher: `bin/hutch${extension}`,
			executable: `bin/hutch-engine${extension}`,
			...metadataOverrides,
		}),
	);
	if (extra) writeFileSync(join(root, "unexpected.txt"), "unexpected");
	const archivePath = join(temporary, `hutch-${platform}-${Math.random()}.tar.gz`);
	execFileSync("tar", ["-czf", archivePath, "-C", staging, rootName]);
	return readFileSync(archivePath);
}

function releaseFixture(temporary, overrides = {}) {
	const archives = new Map();
	const platforms = {};
	for (const platform of HUTCH_RELEASE_PLATFORMS) {
		const bytes = hutchArchive(temporary, platform);
		const url = `${baseUrl}/builds/revision/${platform}/hutch.tar.gz`;
		archives.set(url, bytes);
		platforms[platform] = {
			archive: {
				url,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
			},
		};
	}
	const manifest = {
		schema: 1,
		kind: "release",
		product: "hutch",
		version: hutchVersion,
		platforms,
		...overrides,
	};
	const manifestUrl = `${baseUrl}/hutch/releases/${hutchVersion}/manifest.json`;
	archives.set(manifestUrl, Buffer.from(JSON.stringify(manifest)));
	return { archives, manifestUrl };
}

function replaceArchive(fixture, platform, bytes) {
	const manifest = JSON.parse(fixture.archives.get(fixture.manifestUrl));
	const descriptor = manifest.platforms[platform].archive;
	fixture.archives.set(descriptor.url, bytes);
	descriptor.size = bytes.length;
	descriptor.sha256 = createHash("sha256").update(bytes).digest("hex");
	fixture.archives.set(fixture.manifestUrl, Buffer.from(JSON.stringify(manifest)));
}

function fetchFrom(map, calls = []) {
	return async (url) => {
		calls.push(url);
		const bytes = map.get(url);
		return bytes === undefined ? response("missing", 404) : response(bytes);
	};
}

test("reads the exact paired Hutch pin from the npm resolver", () => {
	assert.equal(
		readPairedHutchVersion('const PAIRED_HUTCH_VERSION = "0.23.0";\n'),
		"0.23.0",
	);
	for (const source of [
		'const PAIRED_HUTCH_VERSION = "latest";',
		'const PAIRED_HUTCH_VERSION = "01.2.3";',
		"const SOMETHING_ELSE = \"0.23.0\";",
	]) {
		assert.throws(() => readPairedHutchVersion(source), /no exact PAIRED_HUTCH_VERSION/);
	}
});

test("stages the complete verified Hutch matrix and immutable artifact index", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-stage-"));
	const outputRoot = join(temporary, "artifacts", "hutch");
	try {
		const fixture = releaseFixture(temporary);
		const calls = [];
		await stageHutchReleaseArtifacts(
			stageOptions(outputRoot, fetchFrom(fixture.archives, calls)),
		);

		assert.equal(calls[0], fixture.manifestUrl);
		assert.equal(calls.length, 1 + HUTCH_RELEASE_PLATFORMS.length);
		const expectedFiles = [
			HUTCH_ARTIFACT_INDEX_FILENAME,
			...HUTCH_RELEASE_PLATFORMS.map(
				(platform) => `electrobun-hutch-${platform}.tar.gz`,
			),
		].sort();
		assert.deepEqual(readdirSync(outputRoot).sort(), expectedFiles);

		const index = JSON.parse(
			readFileSync(join(outputRoot, HUTCH_ARTIFACT_INDEX_FILENAME), "utf8"),
		);
		assert.equal(index.schemaVersion, 1);
		assert.deepEqual(index.product, {
			name: "electrobun",
			version: electrobunVersion,
		});
		assert.deepEqual(index.hutch, { version: hutchVersion });
		for (const platform of HUTCH_RELEASE_PLATFORMS) {
			const filename = `electrobun-hutch-${platform}.tar.gz`;
			const bytes = readFileSync(join(outputRoot, filename));
			const digest = createHash("sha256").update(bytes).digest("hex");
			assert.deepEqual(index.platforms[platform], {
				archive: {
					url: `https://github.com/${repository}/releases/download/${tag}/${filename}`,
					size: bytes.length,
					sha256: digest,
				},
			});
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejects a partial release matrix without leaving partial output", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-stage-"));
	const outputRoot = join(temporary, "output");
	try {
		const fixture = releaseFixture(temporary);
		const manifest = JSON.parse(fixture.archives.get(fixture.manifestUrl));
		delete manifest.platforms["linux-arm64"];
		fixture.archives.set(fixture.manifestUrl, Buffer.from(JSON.stringify(manifest)));
		await assert.rejects(
			stageHutchReleaseArtifacts(
				stageOptions(outputRoot, fetchFrom(fixture.archives)),
			),
			/release platforms.*do not match/,
		);
		assert.equal(existsSync(outputRoot), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejects archive corruption and cleans up already staged files", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-stage-"));
	const outputRoot = join(temporary, "output");
	try {
		const fixture = releaseFixture(temporary);
		const corruptUrl = `${baseUrl}/builds/revision/linux-arm64/hutch.tar.gz`;
		fixture.archives.set(corruptUrl, Buffer.from("same-size-corrupt!!"));
		await assert.rejects(
			stageHutchReleaseArtifacts(
				stageOptions(outputRoot, fetchFrom(fixture.archives)),
			),
			/archive size|SHA-256 does not match/,
		);
		assert.equal(existsSync(outputRoot), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("refuses non-HTTPS remote artifact URLs", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-stage-"));
	try {
		const fixture = releaseFixture(temporary);
		const manifest = JSON.parse(fixture.archives.get(fixture.manifestUrl));
		manifest.platforms["linux-x64"].archive.url =
			"http://artifacts.example/hutch.tar.gz";
		fixture.archives.set(fixture.manifestUrl, Buffer.from(JSON.stringify(manifest)));
		await assert.rejects(
			stageHutchReleaseArtifacts(
				stageOptions(join(temporary, "output"), fetchFrom(fixture.archives)),
			),
			/artifact downloads require HTTPS/,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejects an archive with unexpected layout after cryptographic verification", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-stage-"));
	const outputRoot = join(temporary, "output");
	try {
		const fixture = releaseFixture(temporary);
		replaceArchive(
			fixture,
			"linux-x64",
			hutchArchive(temporary, "linux-x64", {}, true),
		);
		await assert.rejects(
			stageHutchReleaseArtifacts(
				stageOptions(outputRoot, fetchFrom(fixture.archives)),
			),
			/unexpected entry/,
		);
		assert.equal(existsSync(outputRoot), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejects mismatched hutch-release metadata after cryptographic verification", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-hutch-stage-"));
	const outputRoot = join(temporary, "output");
	try {
		const fixture = releaseFixture(temporary);
		replaceArchive(
			fixture,
			"linux-arm64",
			hutchArchive(temporary, "linux-arm64", { version: "9.9.9" }),
		);
		await assert.rejects(
			stageHutchReleaseArtifacts(
				stageOptions(outputRoot, fetchFrom(fixture.archives)),
			),
			/archive identity is invalid/,
		);
		assert.equal(existsSync(outputRoot), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
