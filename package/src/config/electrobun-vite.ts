import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

type ViteAlias = {
	find: RegExp;
	replacement: string;
};

type DevkitPackage = {
	exports?: Record<string, unknown>;
};

function exactImportPattern(specifier: string): RegExp {
	return new RegExp(
		`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
	);
}

function isWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return (
		child !== ".." &&
		!child.startsWith(`..${sep}`) &&
		!isAbsolute(child)
	);
}

/**
 * Maps Electrobun's public JavaScript SDK exports to the devkit projected by
 * Hutch. External Vite builds call this explicitly; Electrobun itself remains
 * package-manager independent.
 */
export function electrobunViteAliases(devkitRoot: string): ViteAlias[] {
	const absoluteDevkitRoot = resolve(devkitRoot);
	const apiRoot = resolve(absoluteDevkitRoot, "api");
	const packagePath = resolve(absoluteDevkitRoot, "package.json");
	let manifest: DevkitPackage;
	try {
		manifest = JSON.parse(readFileSync(packagePath, "utf8")) as DevkitPackage;
	} catch (cause) {
		throw new Error(
			`Electrobun devkit is unavailable at ${absoluteDevkitRoot}; run hutch electrobun sync`,
			{ cause },
		);
	}

	if (!manifest.exports || Array.isArray(manifest.exports)) {
		throw new Error(`Electrobun devkit has no export map at ${packagePath}`);
	}

	return Object.entries(manifest.exports).map(([subpath, target]) => {
		if (subpath !== "." && !subpath.startsWith("./")) {
			throw new Error(`Invalid Electrobun SDK export ${JSON.stringify(subpath)}`);
		}
		if (typeof target !== "string" || !target.startsWith("./api/")) {
			throw new Error(
				`Invalid Electrobun SDK target for ${JSON.stringify(subpath)}`,
			);
		}

		const replacement = resolve(absoluteDevkitRoot, target);
		if (!isWithin(apiRoot, replacement)) {
			throw new Error(
				`Electrobun SDK target escapes the projected API for ${JSON.stringify(subpath)}`,
			);
		}
		const specifier =
			subpath === "." ? "electrobun" : `electrobun/${subpath.slice(2)}`;
		return { find: exactImportPattern(specifier), replacement };
	});
}
