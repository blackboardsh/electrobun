import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertStrictSemVer } from "../src/shared/strict-semver.js";

const electrobunProductConfigPattern =
	/(?:^|[{,]\s*)(?:electrobun|["']electrobun["'])\s*:/s;

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

// The paired toolchain constants in resolve-hutch.cjs mirror the repository
// pragma; release provenance rejects any drift.
export function stampNpmBootstrapPairedVersions(source, pins) {
	assertStrictSemVer(pins.hutch, "paired Hutch version");
	let updated = source;
	for (const [name, value] of [
		["PAIRED_HUTCH_VERSION", pins.hutch],
	]) {
		const pattern = new RegExp(`const ${name} = "[^"]+";`);
		if (!pattern.test(updated)) {
			throw new Error(`resolve-hutch.cjs is missing ${name}`);
		}
		updated = updated.replace(pattern, `const ${name} = "${value}";`);
	}
	return updated;
}

export function parseRepositoryPragmaPins(hutchConfigSource) {
	const pins = hutchConfigSource
		.split(/\r?\n/, 1)[0]
		.match(/^\/\/ @hutch cli=([^\s]+) cottontail=([^\s]+)$/);
	if (!pins) {
		throw new Error("package/hutch.config.ts is missing its // @hutch pragma");
	}
	return {
		hutch: assertStrictSemVer(pins[1], "pragma cli pin"),
		cottontail: assertStrictSemVer(pins[2], "pragma cottontail pin"),
	};
}

export function updateKitchenVersions(hutchSource, electrobunSource, version) {
	assertStrictSemVer(version, "Kitchen release version");
	return {
		hutchConfig: replaceBlockVersion(hutchSource, "electrobun", version),
		electrobunConfig: replaceBlockVersion(electrobunSource, "app", version),
	};
}

function splitLinesPreservingEndings(source) {
	const lines = source.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function tomlTableKind(line) {
	const value = line.replace(/\r?\n$/, "").trim();
	if (/^\[package\](?:\s+#.*)?$/.test(value)) return "package";
	if (/^\[\[package\]\](?:\s+#.*)?$/.test(value)) return "package-array";
	return /^\[{1,2}[^\]\r\n]+\]{1,2}(?:\s+#.*)?$/.test(value)
		? "other"
		: null;
}

function updateCargoPackageTableVersion(source, version, { array, label }) {
	assertStrictSemVer(version, `${label} Electrobun version`);
	const lines = splitLinesPreservingEndings(source);
	const requiredKind = array ? "package-array" : "package";
	const tableStarts = lines
		.map((line, index) => (tomlTableKind(line) === null ? -1 : index))
		.filter((index) => index !== -1);
	const matchingTables = [];

	for (const [tableIndex, start] of tableStarts.entries()) {
		if (tomlTableKind(lines[start]) !== requiredKind) continue;
		const end = tableStarts[tableIndex + 1] ?? lines.length;
		const names = lines
			.slice(start + 1, end)
			.map((line) =>
				/^\s*name\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?(?:\r?\n)?$/.exec(
					line,
				)?.[1],
			)
			.filter((name) => name !== undefined);
		if (names.includes("electrobun")) {
			matchingTables.push({ start, end, names });
		}
	}

	if (matchingTables.length !== 1) {
		throw new Error(
			`${label} must contain exactly one ${array ? "[[package]]" : "[package]"} table named electrobun; found ${matchingTables.length}`,
		);
	}

	const [{ start, end, names }] = matchingTables;
	if (names.length !== 1) {
		throw new Error(
			`${label} Electrobun package table must contain exactly one name field`,
		);
	}
	const versionLines = [];
	for (let index = start + 1; index < end; index += 1) {
		if (/^\s*version\s*=/.test(lines[index])) versionLines.push(index);
	}
	if (versionLines.length !== 1) {
		throw new Error(
			`${label} Electrobun package table must contain exactly one version field; found ${versionLines.length}`,
		);
	}

	const versionIndex = versionLines[0];
	const versionPattern =
		/^(\s*version\s*=\s*)"[^"\r\n]*"(\s*(?:#.*)?)(\r?\n|$)$/;
	const versionMatch = versionPattern.exec(lines[versionIndex]);
	if (!versionMatch) {
		throw new Error(
			`${label} Electrobun version field must be a double-quoted TOML string`,
		);
	}
	lines[versionIndex] = `${versionMatch[1]}"${version}"${versionMatch[2]}${versionMatch[3]}`;
	return lines.join("");
}

export function updateElectrobunCargoManifestVersion(
	source,
	version,
	label = "Cargo.toml",
) {
	return updateCargoPackageTableVersion(source, version, {
		array: false,
		label,
	});
}

export function updateElectrobunCargoLockVersion(
	source,
	version,
	label = "Cargo.lock",
) {
	return updateCargoPackageTableVersion(source, version, {
		array: true,
		label,
	});
}

export function createRustSdkVersionUpdates(repositoryRoot, version) {
	const targets = [
		{
			path: join(
				repositoryRoot,
				"package",
				"src",
				"sdks",
				"rust",
				"Cargo.toml",
			),
			update: updateElectrobunCargoManifestVersion,
		},
		{
			path: join(repositoryRoot, "kitchen", "Cargo.lock"),
			update: updateElectrobunCargoLockVersion,
		},
		{
			path: join(
				repositoryRoot,
				"templates",
				"rust-flock-wgpu",
				"Cargo.lock",
			),
			update: updateElectrobunCargoLockVersion,
		},
	];
	return targets.map(({ path, update }) => ({
		path,
		source: update(readFileSync(path, "utf8"), version, path),
	}));
}

// Templates float — no pragma, no product pin — so a release stamps
// nothing in them; it only refuses to ship a template that regained a pin.
export function assertTemplatesFloat(templatesDir) {
	for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(templatesDir, entry.name, "hutch.config.ts");
		let source;
		try {
			source = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		if (/^\/\/\s*@hutch\b/m.test(source)) {
			throw new Error(`${path} must not carry a // @hutch pragma; templates float`);
		}
		if (electrobunProductConfigPattern.test(source)) {
			throw new Error(`${path} must not pin electrobun.version; templates float`);
		}
	}
}
