import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	checkPublishedBootstrap,
	compareSemver,
	packBootstrapIntegrity,
} from "./check-published-bootstrap.mjs";

const registry = "https://registry.test";

function fixture(version = "2.3.4-beta.5") {
	const root = mkdtempSync(join(tmpdir(), "electrobun-npm-published-"));
	const manifestPath = join(root, "package.json");
	writeFileSync(manifestPath, JSON.stringify({ name: "electrobun", version }));
	return { manifestPath, root, version };
}

function response(status, value) {
	const bytes = Buffer.from(JSON.stringify(value));
	return {
		arrayBuffer: async () => bytes,
		headers: { get: () => `${bytes.length}` },
		ok: status >= 200 && status < 300,
		status,
	};
}

function registryFetch({
	calls = [],
	tags = {},
	tagsStatus = 200,
	versionMetadata = {},
	versionStatus = 200,
} = {}) {
	return async (url) => {
		calls.push(url);
		return url.includes("/-/package/")
			? response(tagsStatus, tags)
			: response(versionStatus, versionMetadata);
	};
}

test("reuses only an integrity-identical version on the requested dist-tag", async () => {
	const value = fixture();
	const integrity = `sha512-${Buffer.from("expected-integrity").toString("base64")}`;
	const calls = [];
	try {
		assert.equal(
			await checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					calls,
					tags: { beta: value.version },
					versionMetadata: {
						name: "electrobun",
						version: value.version,
						dist: { integrity },
					},
				}),
				packIntegrity: () => integrity,
				registry,
			}),
			true,
		);
		assert.deepEqual(calls, [
			`${registry}/electrobun/${value.version}`,
			`${registry}/-/package/electrobun/dist-tags`,
		]);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("an unpublished version may advance a missing or older beta/latest tag", async () => {
	for (const candidate of [
		{ distTag: "beta", version: "2.3.4-beta.5", tagged: undefined },
		{ distTag: "beta", version: "2.3.4-beta.5", tagged: "2.3.4-beta.4" },
		{ distTag: "latest", version: "2.3.4", tagged: undefined },
		{ distTag: "latest", version: "2.3.4", tagged: "2.3.3" },
	]) {
		const value = fixture(candidate.version);
		try {
			assert.equal(
				await checkPublishedBootstrap({
					...value,
					distTag: candidate.distTag,
					fetchImpl: registryFetch({
						tags:
							candidate.tagged === undefined
								? {}
								: { [candidate.distTag]: candidate.tagged },
						versionStatus: 404,
					}),
					registry,
				}),
				false,
				JSON.stringify(candidate),
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("an unpublished version cannot move beta or latest backward", async () => {
	for (const candidate of [
		{ distTag: "beta", version: "2.3.4-beta.5", tagged: "2.3.4-beta.6" },
		{ distTag: "latest", version: "2.3.4", tagged: "2.3.5" },
	]) {
		const value = fixture(candidate.version);
		try {
			await assert.rejects(
				checkPublishedBootstrap({
					...value,
					distTag: candidate.distTag,
					fetchImpl: registryFetch({
						tags: { [candidate.distTag]: candidate.tagged },
						versionStatus: 404,
					}),
					registry,
				}),
				/move npm dist-tag .* backward from newer/,
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("an existing exact version fails closed on stale tag, registry, or integrity", async () => {
	const value = fixture();
	const integrity = `sha512-${Buffer.from("published").toString("base64")}`;
	const metadata = {
		name: "electrobun",
		version: value.version,
		dist: { integrity },
	};
	try {
		await assert.rejects(
			checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({ versionStatus: 503 }),
				registry,
			}),
			/HTTP 503/,
		);
		await assert.rejects(
			checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					tags: { beta: value.version },
					versionMetadata: { ...metadata, version: "2.3.4" },
				}),
				packIntegrity: () => integrity,
				registry,
			}),
			/identity does not match/,
		);
		await assert.rejects(
			checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					tags: { beta: value.version },
					versionMetadata: metadata,
				}),
				packIntegrity: () =>
					`sha512-${Buffer.from("different").toString("base64")}`,
				registry,
			}),
			/dist\.integrity does not match/,
		);
		for (const tags of [{}, { beta: "2.3.4-beta.4" }]) {
			await assert.rejects(
				checkPublishedBootstrap({
					...value,
					distTag: "beta",
					fetchImpl: registryFetch({ tags, versionMetadata: metadata }),
					packIntegrity: () => integrity,
					registry,
				}),
				/repair it with "npm dist-tag add/,
			);
		}
		await assert.rejects(
			checkPublishedBootstrap({
				...value,
				distTag: "beta",
				fetchImpl: registryFetch({
					tags: { beta: "2.3.4-beta.6" },
					versionMetadata: metadata,
				}),
				packIntegrity: () => integrity,
				registry,
			}),
			(error) => {
				assert.match(error.message, /refusing to move it backward/);
				assert.doesNotMatch(error.message, /npm dist-tag add/);
				return true;
			},
		);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("SemVer precedence handles prereleases for monotonic tags", () => {
	for (const [left, right, expected] of [
		["2.3.4-beta.4", "2.3.4-beta.5", -1],
		["2.3.4-beta.10", "2.3.4-beta.5", 1],
		["2.3.4", "2.3.4-beta.5", 1],
		["2.3.4-alpha", "2.3.4-alpha.1", -1],
		["2.3.4+one", "2.3.4+two", 0],
	]) {
		assert.equal(compareSemver(left, right), expected, `${left} vs ${right}`);
	}
});

test("npm pack produces a deterministic local integrity", () => {
	const value = fixture();
	try {
		assert.equal(
			packBootstrapIntegrity(value.manifestPath),
			packBootstrapIntegrity(value.manifestPath),
		);
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});
