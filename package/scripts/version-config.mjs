import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertStrictSemVer } from "../src/shared/strict-semver.js";

function replaceBlockVersion(source, blockName, version) {
	const pattern = new RegExp(
		`(${blockName}:\\s*\\{[\\s\\S]*?\\bversion:\\s*)["'][^"']+["']`,
	);
	if (!pattern.test(source)) {
		throw new Error(`Could not find ${blockName}.version in Electrobun config`);
	}
	return source.replace(pattern, `$1"${version}"`);
}

export function updateKitchenVersions(source, version) {
	assertStrictSemVer(version, "Kitchen release version");
	let updated = replaceBlockVersion(source, "electrobun", version);
	updated = replaceBlockVersion(updated, "app", version);
	return updated;
}

export function updateTemplateVersion(source, version) {
	assertStrictSemVer(version, "Template release version");
	return replaceBlockVersion(source, "electrobun", version);
}

export function createTemplateVersionUpdates(templatesDir, version) {
	return readdirSync(templatesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const path = join(templatesDir, entry.name, "electrobun.config.ts");
			return {
				path,
				source: updateTemplateVersion(readFileSync(path, "utf8"), version),
			};
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}
