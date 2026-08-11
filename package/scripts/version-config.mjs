import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertStrictSemVer } from "../src/shared/strict-semver.js";

function replaceBlockVersion(source, blockName, version) {
	const pattern = new RegExp(
		`(${blockName}:\\s*\\{[\\s\\S]*?\\bversion:\\s*)["'][^"']+["']`,
	);
	if (!pattern.test(source)) {
		throw new Error(`Could not find ${blockName}.version in config`);
	}
	return source.replace(pattern, `$1"${version}"`);
}

export function updateHutchProductVersion(source, version) {
	assertStrictSemVer(version, "Electrobun product version");
	return replaceBlockVersion(source, "electrobun", version);
}

export function updateNpmBootstrapVersion(source, version) {
	assertStrictSemVer(version, "Electrobun npm bootstrap version");
	let manifest;
	try {
		manifest = JSON.parse(source);
	} catch (error) {
		throw new Error(`Could not parse npm bootstrap package.json: ${error.message}`);
	}
	if (manifest?.name !== "electrobun") {
		throw new Error("npm bootstrap package name must be electrobun");
	}
	manifest.version = version;
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

export function updateKitchenVersions(hutchSource, electrobunSource, version) {
	assertStrictSemVer(version, "Kitchen release version");
	return {
		hutchConfig: replaceBlockVersion(hutchSource, "electrobun", version),
		electrobunConfig: replaceBlockVersion(electrobunSource, "app", version),
	};
}

export function createTemplateVersionUpdates(templatesDir, version) {
	return readdirSync(templatesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const path = join(templatesDir, entry.name, "hutch.config.ts");
			return {
				path,
				source: updateHutchProductVersion(
					readFileSync(path, "utf8"),
					version,
				),
			};
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}
