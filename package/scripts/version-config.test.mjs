import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createTemplateVersionUpdates,
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
	assert.doesNotMatch(source, /npm-v\$\{newVersion\}/);
});

test("release bump plan stamps every template Hutch product pin", () => {
	const templatesRoot = fileURLToPath(
		new URL("../../templates/", import.meta.url),
	);
	const templateNames = readdirSync(templatesRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	assert.ok(templateNames.length > 0);
	const updates = createTemplateVersionUpdates(
		templatesRoot,
		"2.3.4-beta.5",
	);
	assert.equal(updates.length, templateNames.length);

	for (const [index, templateName] of templateNames.entries()) {
		const updated = updates[index]?.source ?? "";
		assert.match(
			updated,
			/electrobun:\s*\{\s*version:\s*"2\.3\.4-beta\.5"/,
			templateName,
		);
		assert.equal(
			(updated.match(/2\.3\.4-beta\.5/g) ?? []).length,
			1,
			templateName,
		);
		assert.equal(basename(updates[index]?.path ?? ""), "hutch.config.ts");
	}
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

	for (const update of createTemplateVersionUpdates(
		join(repositoryRoot, "templates"),
		version,
	)) {
		assert.equal(update.source, readFileSync(update.path, "utf8"), update.path);
		const electrobunConfigPath = join(
			dirname(update.path),
			"electrobun.config.ts",
		);
		assert.doesNotMatch(
			readFileSync(electrobunConfigPath, "utf8"),
			/\belectrobun\s*:\s*\{/,
			electrobunConfigPath,
		);
	}
});
