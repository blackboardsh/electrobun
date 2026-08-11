import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	NATIVE_DEVKIT_MANIFEST_FILENAME,
	validateNativeDevkitManifest,
} from "./validate-native-devkit.mjs";

const fixturePath = new URL(
	"./fixtures/native-devkit.macos-arm64.json",
	import.meta.url,
);

function fixture() {
	return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function declaredPaths(manifest) {
	const sdks = manifest.layout.sdks;
	return new Set([
		...Object.values(manifest.layout.runtime),
		sdks.javascript.root,
		sdks.javascript.main,
		sdks.javascript.browser,
		sdks.javascript.config,
		sdks.javascript.preload,
		...Object.values(sdks.javascript.exports),
		sdks.zig.root,
		sdks.zig.entrypoint,
		sdks.rust.root,
		sdks.rust.entrypoint,
		sdks.go.root,
		sdks.go.entrypoint,
		sdks.odin.root,
		sdks.odin.entrypoint,
		sdks.odin.collection,
	]);
}

function makeCore(manifest = fixture()) {
	const root = mkdtempSync(join(tmpdir(), "electrobun-devkit-test-"));
	const directories = new Set([
		"api",
		"api/preload",
		"zig-sdk",
		"rust-sdk",
		"go-sdk",
		"odin-sdk",
		"odin-sdk/electrobun",
	]);

	for (const path of declaredPaths(manifest)) {
		if (
			path.startsWith("/") ||
			path.includes("\\") ||
			path.split("/").includes("..")
		) {
			continue;
		}
		const destination = join(root, path);
		if (directories.has(path)) {
			mkdirSync(destination, { recursive: true });
		} else {
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, "fixture");
		}
	}
	writeFileSync(
		join(root, NATIVE_DEVKIT_MANIFEST_FILENAME),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	return root;
}

const expected = {
	expectedVersion: "2.0.0-beta.1",
	expectedTarget: { os: "macos", arch: "arm64" },
};

test("validates an exact devkit contract and every declared path", () => {
	const coreRoot = makeCore();
	try {
		const manifest = validateNativeDevkitManifest({ coreRoot, ...expected });
		assert.equal(manifest.product.version, expected.expectedVersion);
	} finally {
		rmSync(coreRoot, { recursive: true, force: true });
	}
});

test("rejects product or target drift", () => {
	const coreRoot = makeCore();
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({
					coreRoot,
					...expected,
					expectedVersion: "2.0.0",
				}),
			/product\.version/,
		);
		assert.throws(
			() =>
				validateNativeDevkitManifest({
					coreRoot,
					...expected,
					expectedTarget: { os: "linux", arch: "arm64" },
				}),
			/target/,
		);
	} finally {
		rmSync(coreRoot, { recursive: true, force: true });
	}
});

test("rejects unsafe or missing declared paths", () => {
	const unsafe = fixture();
	unsafe.layout.sdks.zig.entrypoint = "../electrobun.zig";
	const unsafeRoot = makeCore(unsafe);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: unsafeRoot, ...expected }),
			/normalized POSIX path/,
		);
	} finally {
		rmSync(unsafeRoot, { recursive: true, force: true });
	}

	const missing = fixture();
	const missingRoot = makeCore(missing);
	rmSync(join(missingRoot, missing.layout.sdks.go.entrypoint));
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: missingRoot, ...expected }),
			/declared path does not exist: "go-sdk\/electrobun\.go"/,
		);
	} finally {
		rmSync(missingRoot, { recursive: true, force: true });
	}
});

test("rejects missing ABI and compiler-default metadata", () => {
	const missingAbi = fixture();
	delete missingAbi.abi.sdk;
	const abiRoot = makeCore(missingAbi);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: abiRoot, ...expected }),
			/abi\.sdk must be an object/,
		);
	} finally {
		rmSync(abiRoot, { recursive: true, force: true });
	}

	const missingToolchain = fixture();
	delete missingToolchain.toolchains.odin.defaultVersion;
	const toolchainRoot = makeCore(missingToolchain);
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({ coreRoot: toolchainRoot, ...expected }),
			/toolchains\.odin\.defaultVersion/,
		);
	} finally {
		rmSync(toolchainRoot, { recursive: true, force: true });
	}
});

test("rejects compiler channels and ranges in release metadata", () => {
	const channel = fixture();
	channel.toolchains.rust.defaultVersion = "stable";
	const channelRoot = makeCore(channel);
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({ coreRoot: channelRoot, ...expected }),
			/toolchains\.rust\.defaultVersion must be an exact version/,
		);
	} finally {
		rmSync(channelRoot, { recursive: true, force: true });
	}

	const range = fixture();
	range.toolchains.zig.defaultVersion = "^0.16.0";
	const rangeRoot = makeCore(range);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: rangeRoot, ...expected }),
			/toolchains\.zig\.defaultVersion must be an exact version/,
		);
	} finally {
		rmSync(rangeRoot, { recursive: true, force: true });
	}
});
