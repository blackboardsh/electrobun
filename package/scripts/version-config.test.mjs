import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createTemplateVersionUpdates,
	updateKitchenVersions,
} from "./version-config.mjs";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("release bumps update both Kitchen product and app versions", () => {
	const source = readFileSync(
		new URL("../../kitchen/electrobun.config.ts", import.meta.url),
		"utf8",
	);
	const updated = updateKitchenVersions(source, "2.3.4-beta.5");

	assert.match(
		updated,
		/electrobun:\s*\{\s*version:\s*"2\.3\.4-beta\.5"/,
	);
	assert.match(
		updated,
		/app:\s*\{[\s\S]*?version:\s*"2\.3\.4-beta\.5"/,
	);
	assert.equal((updated.match(/2\.3\.4-beta\.5/g) ?? []).length, 2);
});

test("release bumps fail instead of publishing a partially updated config", () => {
	assert.throws(
		() =>
			updateKitchenVersions(
				'export default { app: { version: "1.0.0" } };',
				"2.0.0",
			),
		/Could not find electrobun\.version/,
	);
	assert.throws(
		() =>
			updateKitchenVersions(
				'export default { electrobun: { version: "1.0.0" } };',
				"2.0.0",
			),
		/Could not find app\.version/,
	);
});

test("release bumps reject values outside exact SemVer 2.0.0", () => {
	const source =
		'export default { electrobun: { version: "1.0.0" }, app: { version: "1.0.0" } };';
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
			() => updateKitchenVersions(source, version),
			/Kitchen release version must be an exact SemVer 2\.0\.0 version/,
			version,
		);
	}
});

test("release bump plan stamps every template product pin", () => {
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

	const kitchenPath = join(repositoryRoot, "kitchen", "electrobun.config.ts");
	const kitchenSource = readFileSync(kitchenPath, "utf8");
	assert.equal(updateKitchenVersions(kitchenSource, version), kitchenSource);

	for (const update of createTemplateVersionUpdates(
		join(repositoryRoot, "templates"),
		version,
	)) {
		assert.equal(update.source, readFileSync(update.path, "utf8"), update.path);
	}
});
