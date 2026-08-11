import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArtifactIndex } from "./create-artifact-index.mjs";

const version = "2.0.0-beta.7";

function manifest(target, overrides = {}) {
	return {
		schemaVersion: 1,
		product: { name: "electrobun", version },
		target,
		abi: {
			core: { name: "electrobun-core", version: 1 },
			sdk: { name: "electrobun-sdk", version: 1 },
		},
		...overrides,
	};
}

function writeCore(root, releaseName, target, overrides) {
	const staging = join(root, `staging-${releaseName}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging);
	writeFileSync(
		join(staging, "native-devkit.json"),
		JSON.stringify(manifest(target, overrides)),
	);
	const archive = join(root, `electrobun-core-${releaseName}.tar.gz`);
	execFileSync("tar", ["-czf", archive, "-C", staging, "native-devkit.json"]);
	return archive;
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "electrobun-artifact-index-"));
	writeCore(root, "darwin-arm64", { os: "macos", arch: "arm64" });
	writeCore(root, "linux-x64", { os: "linux", arch: "x64" });
	writeFileSync(join(root, "electrobun-cef-darwin-arm64.tar.gz"), "CEF");
	return root;
}

function create(root) {
	return createArtifactIndex({
		artifactRoot: root,
		repository: "blackboardsh/electrobun",
		tag: `v${version}`,
		version,
		expectedPlatforms: ["macos-arm64", "linux-x64"],
	});
}

test("indexes exact-version core and optional CEF assets by devkit target", () => {
	const root = fixture();
	try {
		const index = create(root);
		assert.equal(index.schemaVersion, 1);
		assert.deepEqual(index.product, { name: "electrobun", version });
		assert.deepEqual(index.devkit, {
			manifest: "native-devkit.json",
			schemaVersion: 1,
		});
		assert.deepEqual(index.abi.core, { name: "electrobun-core", version: 1 });
		assert.equal(index.platforms["linux-x64"].cef, undefined);
		const cef = readFileSync(join(root, "electrobun-cef-darwin-arm64.tar.gz"));
		assert.deepEqual(index.platforms["macos-arm64"].cef, {
			url: `https://github.com/blackboardsh/electrobun/releases/download/v${version}/electrobun-cef-darwin-arm64.tar.gz`,
			size: cef.length,
			sha256: createHash("sha256").update(cef).digest("hex"),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an archive whose native devkit target disagrees with its name", () => {
	const root = fixture();
	try {
		writeCore(root, "linux-arm64", { os: "linux", arch: "x64" });
		assert.throws(
			() =>
				createArtifactIndex({
					artifactRoot: root,
					repository: "blackboardsh/electrobun",
					tag: `v${version}`,
					version,
					expectedPlatforms: ["macos-arm64", "linux-x64", "linux-arm64"],
				}),
			/native-devkit\.json target.*does not match archive target/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects inconsistent ABI identity across platform archives", () => {
	const root = fixture();
	try {
		writeCore(root, "linux-x64", { os: "linux", arch: "x64" }, {
			abi: {
				core: { name: "electrobun-core", version: 2 },
				sdk: { name: "electrobun-sdk", version: 1 },
			},
		});
		assert.throws(() => create(root), /identity for macos-arm64 differs|identity for linux-x64 differs/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects missing release-matrix targets and tag/version mismatches", () => {
	const root = fixture();
	try {
		assert.throws(
			() =>
				createArtifactIndex({
					artifactRoot: root,
					repository: "blackboardsh/electrobun",
					tag: `v${version}`,
					version,
					expectedPlatforms: ["macos-arm64", "linux-x64", "windows-x64"],
				}),
			/do not match expected/,
		);
		assert.throws(
			() =>
				createArtifactIndex({
					artifactRoot: root,
					repository: "blackboardsh/electrobun",
					tag: "v2.0.0",
					version,
					expectedPlatforms: ["macos-arm64", "linux-x64"],
				}),
			/release tag must be/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
