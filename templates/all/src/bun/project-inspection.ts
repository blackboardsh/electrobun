import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectInspection } from "./orchestrator";

const PRODUCT_CONFIG_PATTERN =
	/(?:^|[{,]\s*)(?:electrobun|["']electrobun["'])\s*:/g;
const PRODUCT_BLOCK_PATTERN =
	/(?:^|[{,]\s*)(?:electrobun|["']electrobun["'])\s*:\s*\{([\s\S]*?)\}/;
const PRODUCT_VERSION_PATTERN =
	/(?:^|,)\s*(?:version|["']version["'])\s*:\s*(["'])([^"'\r\n]+)\1/;

export function configuredElectrobunVersion(source: string): string | null {
	const configured = [...source.matchAll(PRODUCT_CONFIG_PATTERN)];
	if (configured.length === 0) return null;
	if (configured.length === 1) {
		const block = PRODUCT_BLOCK_PATTERN.exec(source)?.[1] ?? "";
		const version = PRODUCT_VERSION_PATTERN.exec(block)?.[2];
		if (version) return version;
	}
	// Any Electrobun product block violates the floating template contract,
	// even when its version is malformed, ambiguous, reordered, or dynamic.
	return "configured (version is not one exact string)";
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

export function isMatchingElectrobunDevkitRoot(
	devkitRoot: string,
	expectedVersion: string,
	expectedTarget: { os: string; arch: string },
): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(join(devkitRoot, "native-devkit.json"), "utf8"),
		) as {
			schemaVersion?: unknown;
			product?: { name?: unknown; version?: unknown };
			target?: { os?: unknown; arch?: unknown };
		};
		return (
			manifest.schemaVersion === 1 &&
			manifest.product?.name === "electrobun" &&
			manifest.product.version === expectedVersion &&
			manifest.target?.os === expectedTarget.os &&
			manifest.target.arch === expectedTarget.arch
		);
	} catch {
		return false;
	}
}

export function inspectTemplateProject(directory: string): ProjectInspection {
	const hutchConfigPath = join(directory, "hutch.config.ts");
	const devkitProjectionPath = join(directory, ".hutch", "devkit");

	let productVersion: string | null = null;
	let hasInstallTask = false;
	try {
		const hutchConfig = readFileSync(hutchConfigPath, "utf8");
		productVersion = configuredElectrobunVersion(hutchConfig);
		hasInstallTask = hutchConfigDefinesScript(hutchConfig, "install");
	} catch {
		// The orchestrator reports a missing pin; install remains explicit.
	}

	return {
		hasInstallTask,
		configuredElectrobunVersion: productVersion,
		projectedElectrobunVersion: validProjectedVersion(devkitProjectionPath),
		devkitProjectionPath,
	};
}
