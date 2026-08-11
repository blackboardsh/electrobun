import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectInspection } from "./orchestrator";

const PRODUCT_VERSION_PATTERN =
	/\belectrobun\s*:\s*\{\s*version\s*:\s*(["'])([^"'\r\n]+)\1/g;

export function configuredElectrobunVersion(source: string): string | null {
	const matches = [...source.matchAll(PRODUCT_VERSION_PATTERN)];
	return matches.length === 1 ? (matches[0]?.[2] ?? null) : null;
}

export function hutchConfigDefinesScript(
	source: string,
	scriptName: string,
): boolean {
	const scripts = source.match(
		/\bscripts\s*:\s*\{([\s\S]*?)\n\s*\},?\s*\n\s*\};?\s*$/,
	)?.[1];
	if (!scripts) return false;
	const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?:^|[,\\n])\\s*(?:${escaped}|["']${escaped}["'])\\s*:`,
	).test(scripts);
}

function validProjectedVersion(devkitRoot: string): string | null {
	try {
		const projection = JSON.parse(
			readFileSync(join(devkitRoot, "projection.json"), "utf8"),
		) as {
			schemaVersion?: unknown;
			kind?: unknown;
			product?: { name?: unknown; version?: unknown };
		};
		const facade = JSON.parse(
			readFileSync(join(devkitRoot, "package.json"), "utf8"),
		) as { name?: unknown; version?: unknown };
		const version = projection.product?.version;
		if (
			projection.schemaVersion !== 1 ||
			projection.kind !== "electrobun-devkit-projection" ||
			projection.product?.name !== "electrobun" ||
			typeof version !== "string" ||
			facade.name !== "electrobun" ||
			facade.version !== version ||
			!existsSync(join(devkitRoot, "tsconfig.json"))
		) {
			return null;
		}
		return version;
	} catch {
		return null;
	}
}

export function inspectTemplateProject(directory: string): ProjectInspection {
	const packagePath = join(directory, "package.json");
	const hutchConfigPath = join(directory, "hutch.config.ts");
	const electrobunConfigPath = join(directory, "electrobun.config.ts");
	const devkitProjectionPath = join(directory, ".hutch", "devkit");

	let productVersion: string | null = null;
	try {
		productVersion = configuredElectrobunVersion(
			readFileSync(electrobunConfigPath, "utf8"),
		);
	} catch {
		// The orchestrator reports the missing or malformed exact product pin.
	}

	let hasInstallTask = false;
	try {
		hasInstallTask = hutchConfigDefinesScript(
			readFileSync(hutchConfigPath, "utf8"),
			"install",
		);
	} catch {
		// A package without an explicit install task is intentionally not installed.
	}

	return {
		hasPackageManifest: existsSync(packagePath),
		hasInstallTask,
		configuredElectrobunVersion: productVersion,
		projectedElectrobunVersion: validProjectedVersion(devkitProjectionPath),
		devkitProjectionPath,
	};
}
