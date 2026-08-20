import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	readPairedHutchVersion,
	verifyReleaseAssets,
} from "./verify-release-assets.mjs";

const electrobunVersion = "2.0.0-beta.7";
const hutchVersion = "1.2.3-beta.4";
const repository = "blackboardsh/electrobun";
const tag = `v${electrobunVersion}`;
const releaseUrl = `https://github.com/${repository}/releases/download/${tag}`;
const platforms = {
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

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "electrobun-release-assets-"));
	const productEntries = {};
	const hutchEntries = {};
	const descriptor = (name, contents) => {
		const bytes = Buffer.from(contents);
		writeFileSync(join(root, name), bytes);
		return {
			url: `${releaseUrl}/${name}`,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	};
	for (const [key, platform] of Object.entries(platforms)) {
		productEntries[key] = {
			target: platform.target,
			core: descriptor(
				`electrobun-core-${platform.archiveTarget}.tar.gz`,
				`core:${key}`,
			),
		};
		if (key === "macos-arm64") {
			productEntries[key].cef = descriptor(
				`electrobun-cef-${platform.archiveTarget}.tar.gz`,
				`cef:${key}`,
			);
		}
		hutchEntries[key] = {
			archive: descriptor(
				`electrobun-hutch-${key}.tar.gz`,
				`hutch:${key}`,
			),
		};
	}
	writeFileSync(
		join(root, "electrobun-artifacts.json"),
		JSON.stringify({
			schemaVersion: 1,
			product: { name: "electrobun", version: electrobunVersion },
			devkit: { manifest: "native-devkit.json", schemaVersion: 1 },
			abi: {
				core: { name: "electrobun-core", version: 1 },
				sdk: { name: "electrobun-sdk", version: 1 },
			},
			platforms: productEntries,
		}),
	);
	writeFileSync(
		join(root, "hutch-artifacts.json"),
		JSON.stringify({
			schemaVersion: 1,
			product: { name: "electrobun", version: electrobunVersion },
			hutch: { version: hutchVersion },
			platforms: hutchEntries,
		}),
	);
	return {
		actualRoot: root,
		electrobunVersion,
		hutchVersion,
		repository,
		root,
		tag,
	};
}

function updateIndex(root, name, update) {
	const path = join(root, name);
	const index = JSON.parse(readFileSync(path, "utf8"));
	update(index);
	writeFileSync(path, JSON.stringify(index));
}

test("accepts a complete release that is self-consistent with both indexes", async () => {
	const value = fixture();
	try {
		const names = await verifyReleaseAssets(value);
		assert.equal(names.length, 11);
		assert.ok(names.includes("electrobun-artifacts.json"));
		assert.ok(names.includes("hutch-artifacts.json"));
	} finally {
		rmSync(value.root, { recursive: true, force: true });
	}
});

test("rejects partial, unexpected, and hash-mismatched release assets", async () => {
	for (const mutate of [
		({ root }) =>
			rmSync(join(root, "electrobun-hutch-linux-arm64.tar.gz"), {
				force: true,
			}),
		({ root }) => writeFileSync(join(root, "unexpected.txt"), "extra"),
		({ root }) =>
			writeFileSync(join(root, "electrobun-core-linux-x64.tar.gz"), "xxxxxxxxxxxxxx"),
	]) {
		const value = fixture();
		try {
			mutate(value);
			await assert.rejects(
				verifyReleaseAssets(value),
				/asset set differs|size .* does not match|SHA-256 does not match/,
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("rejects mismatched index identities, URLs, pairs, and platform matrices", async () => {
	for (const [indexName, mutate] of [
		[
			"electrobun-artifacts.json",
			(index) => {
				index.product.version = "2.0.0-beta.8";
			},
		],
		[
			"electrobun-artifacts.json",
			(index) => {
				index.platforms["linux-x64"].core.url =
					"https://example.invalid/core.tar.gz";
			},
		],
		[
			"hutch-artifacts.json",
			(index) => {
				index.hutch.version = "1.2.3-beta.5";
			},
		],
		[
			"hutch-artifacts.json",
			(index) => {
				delete index.platforms["windows-x64"];
			},
		],
	]) {
		const value = fixture();
		try {
			updateIndex(value.root, indexName, mutate);
			await assert.rejects(
				verifyReleaseAssets(value),
				/identity does not match|URL does not match|keys .* do not match/,
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	}
});

test("reads only an exact paired Hutch pin from the checked-in resolver", () => {
	assert.equal(
		readPairedHutchVersion('const PAIRED_HUTCH_VERSION = "0.23.0";\n'),
		"0.23.0",
	);
	assert.throws(
		() => readPairedHutchVersion('const PAIRED_HUTCH_VERSION = "latest";\n'),
		/exact SemVer/,
	);
});
