import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
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
	const { wgpuAuxiliaryLibraries = [], ...runtime } = manifest.layout.runtime;
	return new Set([
		...Object.values(runtime),
		...wgpuAuxiliaryLibraries,
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

test("rejects a stale emitted app runtime before packaging", (t) => {
	const manifest = fixture();
	manifest.toolchains.cottontail.defaultVersion = "0.7.0-canary.6";
	const coreRoot = makeCore(manifest);
	t.after(() => rmSync(coreRoot, { recursive: true, force: true }));
	assert.throws(
		() => validateNativeDevkitManifest({
			coreRoot,
			...expected,
			expectedAppCottontailVersion: "0.7.0-canary.7",
		}),
		/toolchains\.cottontail\.defaultVersion "0\.7\.0-canary\.6" does not match expected app runtime "0\.7\.0-canary\.7"/,
	);
	assert.equal(
		validateNativeDevkitManifest({ coreRoot, ...expected }).toolchains.cottontail.defaultVersion,
		"0.7.0-canary.6",
		"generic manifest validation remains independent of a release's app pin",
	);
});

test("validates the explicit app runtime expectation", (t) => {
	const coreRoot = makeCore();
	t.after(() => rmSync(coreRoot, { recursive: true, force: true }));
	const appVersion = fixture().toolchains.cottontail.defaultVersion;
	assert.equal(
		validateNativeDevkitManifest({
			coreRoot, ...expected, expectedAppCottontailVersion: appVersion,
		}).toolchains.cottontail.defaultVersion,
		appVersion,
	);
	for (const invalid of ["canary", "^0.7.0", "0.7.0-canary.01", ""]) {
		assert.throws(
			() => validateNativeDevkitManifest({
				coreRoot, ...expected, expectedAppCottontailVersion: invalid,
			}),
			/expected app Cottontail version/,
		);
	}
});

test("the packaging entrypoint rejects stale app metadata before creating archives", (t) => {
	const root = mkdtempSync(join(tmpdir(), "electrobun-package-app-pin-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packageRoot = join(root, "package");
	const scriptsRoot = join(packageRoot, "scripts");
	const sharedRoot = join(packageRoot, "src", "shared");
	mkdirSync(scriptsRoot, { recursive: true });
	mkdirSync(sharedRoot, { recursive: true });
	for (const name of ["package-release.js", "validate-native-devkit.mjs", "verify-release-toolchain.mjs", "macos-release.js"]) {
		cpSync(new URL(`./${name}`, import.meta.url), join(scriptsRoot, name));
	}
	cpSync(new URL("../src/shared/strict-semver.js", import.meta.url), join(sharedRoot, "strict-semver.js"));
	writeFileSync(join(sharedRoot, "cottontail-version.ts"), 'export const COTTONTAIL_VERSION = "0.7.0-canary.7";\n');
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: expected.expectedVersion }));
	// This fixture exercises the real packaging entrypoint and metadata guard;
	// native compilation and ABI verification have their own release checks.
	writeFileSync(join(packageRoot, "build.ts"), "// Fixture build has already emitted dist.\n");
	for (const name of ["verify-macho-deployment-target.js", "verify-macho-code-signing.js", "verify-linux-elf-abi.js"]) {
		writeFileSync(join(scriptsRoot, name), "// Native ABI verification is outside this metadata fixture.\n");
	}
	const manifest = fixture();
	manifest.target = {
		os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "win" : "linux",
		arch: process.platform === "win32" ? "x64" : process.arch,
	};
	manifest.toolchains.cottontail.defaultVersion = "0.7.0-canary.6";
	const originalCore = makeCore(manifest);
	t.after(() => rmSync(originalCore, { recursive: true, force: true }));
	const distRoot = join(packageRoot, "dist");
	cpSync(originalCore, distRoot, { recursive: true });
	if (process.platform === "win32") writeFileSync(join(distRoot, "launcher.exe"), "fixture");
	const result = spawnSync(process.execPath, [join(scriptsRoot, "package-release.js")], {
		cwd: root,
		env: { ...process.env, HUTCH_BINARY: process.execPath },
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stderr, /toolchains\.cottontail\.defaultVersion "0\.7\.0-canary\.6" does not match expected app runtime "0\.7\.0-canary\.7"/);
	const platformName = process.platform === "win32" ? "win" : process.platform;
	assert.equal(existsSync(join(packageRoot, `electrobun-core-${platformName}-${manifest.target.arch}.tar.gz`)), false);
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

test("rejects non-exact product versions at both manifest and release boundaries", () => {
	for (const invalidVersion of [
		"02.0.0",
		"2.0.0-beta.01",
		"^2.0.0",
		"latest",
		"file:../electrobun",
		"2.0.0\n",
	]) {
		const manifest = fixture();
		manifest.product.version = invalidVersion;
		const coreRoot = makeCore(manifest);
		try {
			assert.throws(
				() =>
					validateNativeDevkitManifest({
						coreRoot,
						...expected,
						expectedVersion: invalidVersion,
					}),
				/product\.version must be an exact version using strict SemVer 2\.0\.0/,
			);
		} finally {
			rmSync(coreRoot, { recursive: true, force: true });
		}
	}

	const coreRoot = makeCore();
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({
					coreRoot,
					...expected,
					expectedVersion: "2.0.0-beta.01",
				}),
			/expected product version must be an exact version using strict SemVer 2\.0\.0/,
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

test("requires an exact default bun toolchain version", () => {
	for (const version of [
		undefined,
		"1.4.0-01",
		"^1.4.0",
		"latest",
		"file:../bun",
	]) {
		const manifest = fixture();
		if (version === undefined) delete manifest.toolchains.bun.defaultVersion;
		else manifest.toolchains.bun.defaultVersion = version;
		const coreRoot = makeCore(manifest);
		try {
			assert.throws(
				() => validateNativeDevkitManifest({ coreRoot, ...expected }),
				/toolchains\.bun\.defaultVersion/,
			);
		} finally {
			rmSync(coreRoot, { recursive: true, force: true });
		}
	}
});

test("rejects manifests that still distribute a bun runtime", () => {
	const withRuntimes = fixture();
	withRuntimes.runtimes = { bun: { version: "1.4.0" } };
	const runtimesRoot = makeCore(withRuntimes);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: runtimesRoot, ...expected }),
			/runtimes was removed/,
		);
	} finally {
		rmSync(runtimesRoot, { recursive: true, force: true });
	}

	const withLayoutBun = fixture();
	withLayoutBun.layout.runtime.bun = "bun";
	const layoutRoot = makeCore(withLayoutBun);
	try {
		assert.throws(
			() => validateNativeDevkitManifest({ coreRoot: layoutRoot, ...expected }),
			/layout\.runtime\.bun was removed/,
		);
	} finally {
		rmSync(layoutRoot, { recursive: true, force: true });
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

	const leadingZero = fixture();
	leadingZero.toolchains.go.defaultVersion = "1.26.4-01";
	const leadingZeroRoot = makeCore(leadingZero);
	try {
		assert.throws(
			() =>
				validateNativeDevkitManifest({
					coreRoot: leadingZeroRoot,
					...expected,
				}),
			/toolchains\.go\.defaultVersion must be an exact version/,
		);
	} finally {
		rmSync(leadingZeroRoot, { recursive: true, force: true });
	}
});
