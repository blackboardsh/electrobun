import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	MIGRATION_BASELINE_VERSION,
	expectedHutchCache,
	migrationInstallArguments,
	npmInvocation,
	validateMigratedNodeModules,
	validatePublicArtifactIndex,
	validatePublishedManifest,
	validateReleaseCoordinates,
	validateRunnerPlatform,
} from "./accept-published-bootstrap.mjs";

function manifest(overrides = {}) {
	return {
		name: "electrobun",
		version: "2.3.4-beta.5",
		bin: { electrobun: "bin/electrobun.cjs" },
		...overrides,
	};
}

test("accepts only an exact matching release tag and monotonic npm channel", () => {
	assert.deepEqual(
		validateReleaseCoordinates({
			distTag: "beta",
			releaseTag: "v2.3.4-beta.5",
			repository: "blackboardsh/electrobun",
			version: "2.3.4-beta.5",
		}),
		{
			distTag: "beta",
			releaseTag: "v2.3.4-beta.5",
			repository: "blackboardsh/electrobun",
			version: "2.3.4-beta.5",
		},
	);
	assert.doesNotThrow(() =>
		validateReleaseCoordinates({
			distTag: "latest",
			releaseTag: "v2.3.4",
			repository: "blackboardsh/electrobun",
			version: "2.3.4",
		}),
	);
	for (const value of [
		{
			distTag: "latest",
			releaseTag: "v2.3.4-beta.5",
			repository: "blackboardsh/electrobun",
			version: "2.3.4-beta.5",
		},
		{
			distTag: "beta",
			releaseTag: "v2.3.4-beta.4",
			repository: "blackboardsh/electrobun",
			version: "2.3.4-beta.5",
		},
		{
			distTag: "beta",
			releaseTag: "v2.3.4-beta.5",
			repository: "https://github.com/blackboardsh/electrobun",
			version: "2.3.4-beta.5",
		},
	]) {
		assert.throws(() => validateReleaseCoordinates(value), /published npm acceptance/);
	}
});

test("accepts only the dependency-free single-package bootstrap manifest", () => {
	assert.equal(
		validatePublishedManifest(manifest(), "2.3.4-beta.5").name,
		"electrobun",
	);
	assert.doesNotThrow(() =>
		validatePublishedManifest(
			manifest({ dependencies: {}, optionalDependencies: {}, scripts: {} }),
			"2.3.4-beta.5",
		),
	);

	for (const [overrides, message] of [
		[{ version: "2.3.4-beta.4" }, /identity/],
		[{ bin: { hutch: "bin/hutch.cjs" } }, /bootstrap bin/],
		[{ dependencies: { "@electrobun/hutch-linux-x64": "2.3.4" } }, /dependencies/],
		[
			{ optionalDependencies: { "@electrobun/hutch-linux-x64": "2.3.4" } },
			/optionalDependencies/,
		],
		[{ bundledDependencies: ["@electrobun/hutch-linux-x64"] }, /bundledDependencies/],
		[{ scripts: { postinstall: "node install.js" } }, /lifecycle scripts/],
	]) {
		assert.throws(
			() => validatePublishedManifest(manifest(overrides), "2.3.4-beta.5"),
			message,
		);
	}
});

test("migrates from exact v1 to exact v2 with scripts off and optionals on", () => {
	assert.equal(MIGRATION_BASELINE_VERSION, "1.18.1");
	for (const version of [MIGRATION_BASELINE_VERSION, "2.3.4-beta.5"]) {
		const args = migrationInstallArguments(version);
		assert.deepEqual(args.slice(0, 1), ["install"]);
		assert.ok(args.includes("--ignore-scripts"));
		assert.ok(args.includes("--include=optional"));
		assert.ok(args.includes("--save-dev"));
		assert.ok(args.includes("--save-exact"));
		assert.ok(args.includes(`electrobun@${version}`));
		assert.ok(!args.includes("--omit=optional"));
		assert.ok(!args.includes("--package-lock=false"));
	}
});

test("allows only recursively empty npm 10 migration residue", () => {
	const root = mkdtempSync(join(tmpdir(), "electrobun-npm-migration-layout-"));
	const nodeModules = join(root, "node_modules");
	try {
		mkdirSync(join(nodeModules, ".bin"), { recursive: true });
		mkdirSync(join(nodeModules, "electrobun"));
		writeFileSync(join(nodeModules, ".package-lock.json"), "{}\n");

		for (const scope of ["@babylonjs", "@malept", "@tootallnate", "@types"]) {
			mkdirSync(join(nodeModules, scope, "nested", "empty"), {
				recursive: true,
			});
		}
		assert.doesNotThrow(() => validateMigratedNodeModules(nodeModules));

		writeFileSync(join(nodeModules, "@types", "residual.js"), "stale\n");
		assert.throws(
			() => validateMigratedNodeModules(nodeModules),
			/files or packages left by the v1 migration: @types/,
		);
		rmSync(join(nodeModules, "@types", "residual.js"));

		writeFileSync(join(nodeModules, "stale-package.json"), "{}\n");
		assert.throws(
			() => validateMigratedNodeModules(nodeModules),
			/files or packages left by the v1 migration: stale-package\.json/,
		);
		rmSync(join(nodeModules, "stale-package.json"));

		mkdirSync(join(nodeModules, "@electrobun"));
		assert.throws(
			() => validateMigratedNodeModules(nodeModules),
			/node_modules\/@electrobun exists; platform packages must not be installed/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invokes the Windows npm.cmd shim without shell:true or path interpolation", () => {
	const args = migrationInstallArguments("2.3.4-beta.5");
	assert.deepEqual(npmInvocation(args, "linux", {}), {
		args,
		command: "npm",
	});
	assert.deepEqual(
		npmInvocation(args, "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
		{
			args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")],
			command: "C:\\Windows\\System32\\cmd.exe",
		},
	);
	assert.throws(
		() => npmInvocation(["install", "value & whoami"], "win32", {}),
		/unsafe command-string argument/,
	);
});

test("binds each workflow label to its native runner architecture", () => {
	for (const [platform, arch, expected] of [
		["darwin", "arm64", "macos-arm64"],
		["linux", "x64", "linux-x64"],
		["linux", "arm64", "linux-arm64"],
		["win32", "x64", "windows-x64"],
	]) {
		assert.equal(validateRunnerPlatform(expected, platform, arch), expected);
		if (expected !== "linux-x64") {
			assert.throws(
				() => validateRunnerPlatform("linux-x64", platform, arch),
				/workflow expected/,
			);
		}
	}
});

test("accepts only the exact public same-version Hutch asset matrix", () => {
	const version = "2.3.4-beta.5";
	const pairedHutchVersion = "0.24.1";
	const platforms = {};
	for (const platformKey of [
		"linux-arm64",
		"linux-x64",
		"macos-arm64",
		"windows-x64",
	]) {
		platforms[platformKey] = {
			archive: {
				sha256: "a".repeat(64),
				size: 123,
				url: `https://github.com/blackboardsh/electrobun/releases/download/v${version}/electrobun-hutch-${platformKey}.tar.gz`,
			},
		};
	}
	const index = {
		hutch: { version: pairedHutchVersion },
		platforms,
		product: { name: "electrobun", version },
		schemaVersion: 1,
	};
	assert.deepEqual(
		validatePublicArtifactIndex(index, {
			pairedHutchVersion,
			platformKey: "linux-x64",
			version,
		}),
		{
			filename: "electrobun-hutch-linux-x64.tar.gz",
			...platforms["linux-x64"].archive,
		},
	);
	assert.throws(
		() =>
			validatePublicArtifactIndex(
				{
					...index,
					platforms: {
						...platforms,
						"linux-x64": {
							archive: {
								...platforms["linux-x64"].archive,
								url: "https://example.com/hutch.tar.gz",
							},
						},
					},
				},
				{ pairedHutchVersion, platformKey: "linux-x64", version },
			),
		/exact release/,
	);
});

test("maps every release runner to the exact versioned Hutch cache", () => {
	const hutchHome = join("root", "isolated-hutch");
	for (const [platform, arch, platformKey, executable] of [
		["darwin", "arm64", "macos-arm64", "hutch"],
		["linux", "x64", "linux-x64", "hutch"],
		["linux", "arm64", "linux-arm64", "hutch"],
		["win32", "x64", "windows-x64", "hutch.exe"],
	]) {
		const cache = expectedHutchCache({
			arch,
			hutchHome,
			platform,
			version: "2.3.4-beta.5",
		});
		assert.equal(cache.platformKey, platformKey);
		assert.equal(
			cache.root,
			join(
				hutchHome,
				"npm",
				"electrobun",
				"2.3.4-beta.5",
				platformKey,
			),
		);
		assert.equal(cache.binary, join(cache.root, "bin", executable));
	}
	assert.throws(
		() =>
			expectedHutchCache({
				arch: "x64",
				hutchHome,
				platform: "darwin",
				version: "2.3.4-beta.5",
			}),
		/unsupported acceptance host/,
	);
});
