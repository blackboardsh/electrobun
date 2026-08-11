const LEGACY_BUN_VERSION_CONFIG_ERROR =
	"Per-project Bun runtime version selection is not supported. Electrobun ships one pinned Bun runtime version.";

const EXACT_SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXACT_ODIN_RELEASE =
	/^(?:dev-\d{4}-(?:0[1-9]|1[0-2])[a-z]?|(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function assertExactVersion(
	value: unknown,
	label: string,
	pattern: RegExp,
): void {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error(
			`${label} must be an exact version, got ${JSON.stringify(value)}. Version ranges, channels, paths, and aliases are not supported.`,
		);
	}
}

export function assertNoLegacyBunVersionConfig(config: unknown): void {
	const configRecord = record(config);
	if (!configRecord) return;

	const build = record(configRecord["build"]);
	if (!build) return;

	if (
		Object.hasOwn(build, "bunVersion") ||
		Object.hasOwn(build, "bunnyBun")
	) {
		throw new Error(LEGACY_BUN_VERSION_CONFIG_ERROR);
	}
}

/**
 * Validate the version fields introduced by the Hutch v2 devkit contract.
 * V2 always requires an exact Electrobun release pin; v1 projects use the
 * separately published Electrobun 1.x package and loader.
 */
export function assertValidVersionPins(config: unknown): void {
	const configRecord = record(config);
	if (!configRecord) {
		throw new Error(
			'electrobun.version must be an exact version, for example "2.0.0".',
		);
	}

	const electrobun = record(configRecord["electrobun"]);
	if (!electrobun || !Object.hasOwn(electrobun, "version")) {
		throw new Error(
			'electrobun.version must be an exact version, for example "2.0.0".',
		);
	}
	assertExactVersion(
		electrobun["version"],
		"electrobun.version",
		EXACT_SEMVER,
	);

	const build = record(configRecord["build"]);
	if (!build) return;

	for (const language of ["zig", "rust", "go"] as const) {
		const languageConfig = record(build[language]);
		if (!languageConfig || !Object.hasOwn(languageConfig, "version")) continue;
		assertExactVersion(
			languageConfig["version"],
			`build.${language}.version`,
			EXACT_SEMVER,
		);
	}

	const odin = record(build["odin"]);
	if (odin && Object.hasOwn(odin, "version")) {
		assertExactVersion(
			odin["version"],
			"build.odin.version",
			EXACT_ODIN_RELEASE,
		);
	}
}
