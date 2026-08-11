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
		sdks.rust.manifest,
		sdks.go.root,
		sdks.go.manifest,
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
		join(root, manifest.layout.sdks.go.manifest),
		`module ${manifest.layout.sdks.go.module}\n\ngo 1.26.0\n`,
	);
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
	rmSync(join(missingRoot, missing.layout.sdks.go.manifest));
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: missingRoot, ...expected }),
			/declared path does not exist: "go-sdk\/go\.mod"/,
		);
	} finally {
		rmSync(missingRoot, { recursive: true, force: true });
	}

	const legacyRust = fixture();
	legacyRust.layout.sdks.rust.entrypoint = "rust-sdk/electrobun.rs";
	delete legacyRust.layout.sdks.rust.manifest;
	const legacyRustRoot = makeCore();
	writeFileSync(
		join(legacyRustRoot, NATIVE_DEVKIT_MANIFEST_FILENAME),
		`${JSON.stringify(legacyRust, null, "\t")}\n`,
	);
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({ coreRoot: legacyRustRoot, ...expected }),
			/layout\.sdks\.rust\.manifest must be a non-empty string/,
		);
	} finally {
		rmSync(legacyRustRoot, { recursive: true, force: true });
	}

	const misplacedRust = fixture();
	misplacedRust.layout.sdks.rust.manifest = "rust-sdk/sdk.Cargo.toml";
	const misplacedRustRoot = makeCore(misplacedRust);
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({
					coreRoot: misplacedRustRoot,
					...expected,
				}),
			/layout\.sdks\.rust\.manifest must be Cargo\.toml at layout\.sdks\.rust\.root/,
		);
	} finally {
		rmSync(misplacedRustRoot, { recursive: true, force: true });
	}
});

test("rejects a Go SDK whose module identity drifts", () => {
	const manifest = fixture();
	const coreRoot = makeCore(manifest);
	writeFileSync(
		join(coreRoot, manifest.layout.sdks.go.manifest),
		"module wrong-sdk\n\ngo 1.26.0\n",
	);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot, ...expected }),
			/layout\.sdks\.go\.module "electrobun" does not match "wrong-sdk"/,
		);
	} finally {
		rmSync(coreRoot, { recursive: true, force: true });
	}
});

test("rejects simultaneous Go manifest and module drift", () => {
	const manifest = fixture();
	manifest.layout.sdks.go.module = "wrong-sdk";
	const coreRoot = makeCore(manifest);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot, ...expected }),
			/layout\.sdks\.go\.module must be "electrobun"/,
		);
	} finally {
		rmSync(coreRoot, { recursive: true, force: true });
	}
});

test("rejects malformed or unsupported Go SDK language baselines", () => {
	const malformed = fixture();
	const malformedRoot = makeCore(malformed);
	writeFileSync(
		join(malformedRoot, malformed.layout.sdks.go.manifest),
		"module electrobun\n\ngo next\n",
	);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: malformedRoot, ...expected }),
			/must declare a valid Go language version/,
		);
	} finally {
		rmSync(malformedRoot, { recursive: true, force: true });
	}

	const tooNew = fixture();
	const tooNewRoot = makeCore(tooNew);
	writeFileSync(
		join(tooNewRoot, tooNew.layout.sdks.go.manifest),
		"module electrobun\n\ngo 1.27.0\n",
	);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: tooNewRoot, ...expected }),
			/requires Go 1\.27\.0, newer than toolchains\.go\.defaultVersion 1\.26\.4/,
		);
	} finally {
		rmSync(tooNewRoot, { recursive: true, force: true });
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
