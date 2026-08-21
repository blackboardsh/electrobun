import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createRustSdkVersionUpdates,
	assertTemplateSourcesUnpinned,
	parseRepositoryPragmaPins,
	stampNpmBootstrapPairedVersions,
	updateElectrobunCargoLockVersion,
	updateElectrobunCargoManifestVersion,
	updateKitchenVersions,
	updateNpmBootstrapVersion,
} from "./version-config.mjs";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("release bumps update the Kitchen product in Hutch config and app metadata separately", () => {
	const hutchSource = readFileSync(
		new URL("../../kitchen/hutch.config.ts", import.meta.url),
		"utf8",
	);
	const electrobunSource = readFileSync(
		new URL("../../kitchen/electrobun.config.ts", import.meta.url),
		"utf8",
	);
	const updated = updateKitchenVersions(
		hutchSource,
		electrobunSource,
		"2.3.4-beta.5",
	);

	assert.match(
		updated.hutchConfig,
		/electrobun:\s*\{\s*version:\s*"2\.3\.4-beta\.5"/,
	);
	assert.match(
		updated.electrobunConfig,
		/app:\s*\{[\s\S]*?version:\s*"2\.3\.4-beta\.5"/,
	);
	assert.doesNotMatch(updated.electrobunConfig, /\belectrobun\s*:\s*\{/);
	assert.equal(
		(
			`${updated.hutchConfig}\n${updated.electrobunConfig}`.match(
				/2\.3\.4-beta\.5/g,
			) ?? []
		).length,
		2,
	);
});

test("release bumps fail instead of publishing a partially updated config", () => {
	assert.throws(
		() =>
			updateKitchenVersions(
				'export default { scripts: {} };',
				'export default { app: { version: "1.0.0" } };',
				"2.0.0",
			),
		/Could not find electrobun\.version/,
	);
	assert.throws(
		() =>
			updateKitchenVersions(
				'export default { electrobun: { version: "1.0.0" } };',
				'export default { build: {} };',
				"2.0.0",
			),
		/Could not find app\.version/,
	);
});

test("release bumps reject values outside exact SemVer 2.0.0", () => {
	const hutchSource =
		'export default { electrobun: { version: "1.0.0" }, scripts: {} };';
	const electrobunSource =
		'export default { app: { version: "1.0.0" }, build: {} };';
	for (const version of [
		"02.0.0",
		"2.0.0-beta.01",
		"^2.0.0",
		"latest",
		"file:../electrobun",
		"../electrobun",
		" 2.0.0",
		"2.0.0 ",
		"2.0.0\n",
	]) {
		assert.throws(
			() => updateKitchenVersions(hutchSource, electrobunSource, version),
			/Kitchen release version must be an exact SemVer 2\.0\.0 version/,
			version,
		);
	}
});

test("release bumps keep the thin npm bootstrap on the product version", () => {
	const source = readFileSync(
		join(repositoryRoot, "npm", "electrobun", "package.json"),
		"utf8",
	);
	const original = JSON.parse(source);
	const updated = JSON.parse(updateNpmBootstrapVersion(source, "2.3.4-beta.5"));
	assert.equal(updated.name, "electrobun");
	assert.equal(updated.version, "2.3.4-beta.5");
	// Only the single dependency-free bootstrap version moves.
	assert.equal(updated.optionalDependencies, undefined);
	const { version: originalVersion, ...originalRest } = original;
	const { version: updatedVersion, ...updatedRest } = updated;
	assert.notEqual(originalVersion, updatedVersion);
	assert.deepEqual(updatedRest, originalRest);
	assert.throws(
		() => updateNpmBootstrapVersion(source, "beta"),
		/exact SemVer 2\.0\.0/,
	);
});

test("push:beta writes and stages the synchronized npm bootstrap identity", () => {
	const source = readFileSync(
		join(repositoryRoot, "package", "scripts", "push-version.js"),
		"utf8",
	);
	assert.match(source, /updateNpmBootstrapVersion\(/);
	assert.match(source, /writeFileSync\(npmBootstrapPath, npmBootstrap\)/);
	assert.match(source, /"npm\/electrobun\/package\.json"/);
	assert.match(source, /createRustSdkVersionUpdates\(repoRoot, newVersion\)/);
	assert.match(
		source,
		/writeFileSync\(rustSdkVersion\.path, rustSdkVersion\.source\)/,
	);
	assert.match(
		source,
		/\.\.\.rustSdkVersions\.map\(\(\{ path \}\) => relative\(repoRoot, path\)\)/,
	);
	assert.doesNotMatch(source, /npm-v\$\{newVersion\}/);
});

test("release bumps update only the Electrobun Cargo package identity", () => {
	const manifest = `[package]\nname = "electrobun"\nversion = "2.0.0"\nedition = "2021"\n\n[dependencies]\nexample = { version = "9.8.7" }\n`;
	assert.equal(
		updateElectrobunCargoManifestVersion(
			manifest,
			"2.0.1-beta.0",
			"fixture Cargo.toml",
		),
		`[package]\nname = "electrobun"\nversion = "2.0.1-beta.0"\nedition = "2021"\n\n[dependencies]\nexample = { version = "9.8.7" }\n`,
	);

	const lock = `version = 4\n\n[[package]]\nname = "before"\nversion = "1.2.3"\n\n[[package]]\nname = "electrobun"\nversion = "2.0.0"\n\n[[package]]\nname = "electrobun-kitchen"\nversion = "0.0.1"\ndependencies = [\n "electrobun",\n]\n`;
	assert.equal(
		updateElectrobunCargoLockVersion(
			lock,
			"2.0.1-beta.0",
			"fixture Cargo.lock",
		),
		`version = 4\n\n[[package]]\nname = "before"\nversion = "1.2.3"\n\n[[package]]\nname = "electrobun"\nversion = "2.0.1-beta.0"\n\n[[package]]\nname = "electrobun-kitchen"\nversion = "0.0.1"\ndependencies = [\n "electrobun",\n]\n`,
	);
});

test("Cargo identity updates fail closed on malformed package tables", () => {
	assert.throws(
		() =>
			updateElectrobunCargoManifestVersion(
				'[package]\nname = "other"\nversion = "2.0.0"\n',
				"2.0.1-beta.0",
			),
		/exactly one \[package\] table named electrobun; found 0/,
	);
	assert.throws(
		() =>
			updateElectrobunCargoLockVersion(
				'[[package]]\nname = "electrobun"\nversion = "2.0.0"\n\n[[package]]\nname = "electrobun"\nversion = "2.0.0"\n',
				"2.0.1-beta.0",
			),
		/exactly one \[\[package\]\] table named electrobun; found 2/,
	);
	for (const body of [
		'[package]\nname = "electrobun"\n',
		'[package]\nname = "electrobun"\nversion = "2.0.0"\nversion = "2.0.1"\n',
	]) {
		assert.throws(
			() =>
				updateElectrobunCargoManifestVersion(body, "2.0.1-beta.0"),
			/exactly one version field/,
		);
	}
	assert.throws(
		() =>
			updateElectrobunCargoManifestVersion(
				'[package]\nname = "electrobun"\nversion = "2.0.0"\n',
				"beta",
			),
		/exact SemVer 2\.0\.0/,
	);
});

test("Rust release bump plan is limited to the SDK and its two lockfiles", () => {
	const updates = createRustSdkVersionUpdates(
		repositoryRoot,
		"2.0.1-beta.0",
	);
	assert.deepEqual(
		updates.map(({ path }) =>
			relative(repositoryRoot, path).split(sep).join("/"),
		),
		[
			"package/src/sdks/rust/Cargo.toml",
			"kitchen/Cargo.lock",
			"templates/rust-flock-wgpu/Cargo.lock",
		],
	);
	for (const { source } of updates) {
		assert.match(
			source,
			/name = "electrobun"\r?\nversion = "2\.0\.1-beta\.0"/,
		);
	}
});

test("release bumps require every repository template source to remain unpinned", () => {
	const templatesRoot = fileURLToPath(
		new URL("../../templates/", import.meta.url),
	);
	assertTemplateSourcesUnpinned(templatesRoot);
	assert.throws(() => {
		const scratch = mkdtempSync(join(tmpdir(), "template-float-"));
		try {
			mkdirSync(join(scratch, "pinned"));
			writeFileSync(
				join(scratch, "pinned", "hutch.config.ts"),
				"// @hutch cli=0.7.3 cottontail=0.4.4\nexport default {};\n",
			);
			assertTemplateSourcesUnpinned(scratch);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, /repository source must not carry a \/\/ @hutch pragma/);
	assert.throws(() => {
		const scratch = mkdtempSync(join(tmpdir(), "template-product-pin-"));
		try {
			mkdirSync(join(scratch, "pinned"));
			writeFileSync(
				join(scratch, "pinned", "hutch.config.ts"),
				'export default { "electrobun": { note: true, "version": "2.0.0" } };\n',
			);
			assertTemplateSourcesUnpinned(scratch);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, /repository source must not pin electrobun\.version/);
});

test("the npm bootstrap paired versions stamp from the repository pragma", () => {
	const pins = parseRepositoryPragmaPins(
		readFileSync(join(repositoryRoot, "package", "hutch.config.ts"), "utf8"),
	);
	const resolverSource = readFileSync(
		join(repositoryRoot, "npm", "electrobun", "bin", "resolve-hutch.cjs"),
		"utf8",
	);
	// The checked-in constants already match the pragma, so stamping is a
	// fixed point; a mismatched pragma would produce a diff at release time.
	assert.equal(
		stampNpmBootstrapPairedVersions(resolverSource, pins),
		resolverSource,
	);
	assert.throws(
		() => stampNpmBootstrapPairedVersions("// nothing here\n", pins),
		/missing PAIRED_HUTCH_VERSION/,
	);
	assert.throws(
		() =>
			parseRepositoryPragmaPins("export default {};\n"),
		/missing its \/\/ @hutch pragma/,
	);
});

test("checked-in package, lock, Kitchen, and template product identities agree", () => {
	const packageManifest = JSON.parse(
		readFileSync(join(repositoryRoot, "package", "package.json"), "utf8"),
	);
	const packageLock = JSON.parse(
		readFileSync(join(repositoryRoot, "package", "package-lock.json"), "utf8"),
	);
	const version = packageManifest.version;
	assert.equal(packageLock.version, version);
	assert.equal(packageLock.packages?.[""]?.version, version);
	const npmBootstrapManifest = JSON.parse(
		readFileSync(
			join(repositoryRoot, "npm", "electrobun", "package.json"),
			"utf8",
		),
	);
	assert.equal(npmBootstrapManifest.version, version);

	const kitchenHutchPath = join(repositoryRoot, "kitchen", "hutch.config.ts");
	const kitchenPath = join(repositoryRoot, "kitchen", "electrobun.config.ts");
	const kitchenHutchSource = readFileSync(kitchenHutchPath, "utf8");
	const kitchenSource = readFileSync(kitchenPath, "utf8");
	assert.deepEqual(
		updateKitchenVersions(kitchenHutchSource, kitchenSource, version),
		{
			hutchConfig: kitchenHutchSource,
			electrobunConfig: kitchenSource,
		},
	);
	assert.doesNotMatch(kitchenSource, /\belectrobun\s*:\s*\{/);

		assertTemplateSourcesUnpinned(join(repositoryRoot, "templates"));
	assert.equal(npmBootstrapManifest.optionalDependencies, undefined);

	for (const update of createRustSdkVersionUpdates(repositoryRoot, version)) {
		assert.equal(update.source, readFileSync(update.path, "utf8"), update.path);
	}
});

test("push:beta dry semantics produce 2.0.1-beta.0 from 2.0.0", () => {
	const helperSource = readFileSync(
		join(repositoryRoot, "package", "scripts", "push-version.js"),
		"utf8",
	);
	assert.match(helperSource, /beta:\s*"prerelease --preid=beta"/);
	const baseVersion = "2.0.0";
	const temporaryRoot = mkdtempSync(join(tmpdir(), "electrobun-beta-version-"));
	try {
		writeFileSync(
			join(temporaryRoot, "package.json"),
			`${JSON.stringify(
				{
					name: "electrobun-version-dry-run",
					version: baseVersion,
					private: true,
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(temporaryRoot, "package-lock.json"),
			`${JSON.stringify(
				{
					name: "electrobun-version-dry-run",
					version: baseVersion,
					lockfileVersion: 3,
					requires: true,
					packages: {
						"": {
							name: "electrobun-version-dry-run",
							version: baseVersion,
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const npmCommand =
			process.platform === "win32"
				? (process.env.ComSpec ?? "cmd.exe")
				: "npm";
		const npmArguments =
			process.platform === "win32"
				? [
						"/d",
						"/s",
						"/c",
						"npm version prerelease --preid=beta --no-git-tag-version",
					]
				: [
						"version",
						"prerelease",
						"--preid=beta",
						"--no-git-tag-version",
					];
		const result = spawnSync(npmCommand, npmArguments, {
			cwd: temporaryRoot,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const bumpedManifest = JSON.parse(
			readFileSync(join(temporaryRoot, "package.json"), "utf8"),
		);
		const bumpedLock = JSON.parse(
			readFileSync(join(temporaryRoot, "package-lock.json"), "utf8"),
		);
		assert.equal(bumpedManifest.version, "2.0.1-beta.0");
		assert.equal(bumpedLock.version, bumpedManifest.version);
		assert.equal(bumpedLock.packages?.[""]?.version, bumpedManifest.version);

		const version = bumpedManifest.version;
		const kitchenVersions = updateKitchenVersions(
			readFileSync(join(repositoryRoot, "kitchen", "hutch.config.ts"), "utf8"),
			readFileSync(
				join(repositoryRoot, "kitchen", "electrobun.config.ts"),
				"utf8",
			),
			version,
		);
		assert.match(kitchenVersions.hutchConfig, /version: "2\.0\.1-beta\.0"/);
		assert.match(
			kitchenVersions.electrobunConfig,
			/version: "2\.0\.1-beta\.0"/,
		);
		assert.equal(
			JSON.parse(
				updateNpmBootstrapVersion(
					readFileSync(
						join(repositoryRoot, "npm", "electrobun", "package.json"),
						"utf8",
					),
					version,
				),
			).version,
			version,
		);
		assertTemplateSourcesUnpinned(join(repositoryRoot, "templates"));
		assert.equal(createRustSdkVersionUpdates(repositoryRoot, version).length, 3);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});
