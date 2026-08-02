const LEGACY_BUN_VERSION_CONFIG_ERROR =
	"Per-project Bun runtime version selection is not supported. Electrobun ships one pinned Bun runtime version.";

export function assertNoLegacyBunVersionConfig(config: unknown): void {
	if (!config || typeof config !== "object") return;

	const build = (config as Record<string, unknown>)["build"];
	if (!build || typeof build !== "object") return;

	const buildConfig = build as Record<string, unknown>;
	if (
		Object.hasOwn(buildConfig, "bunVersion") ||
		Object.hasOwn(buildConfig, "bunnyBun")
	) {
		throw new Error(LEGACY_BUN_VERSION_CONFIG_ERROR);
	}
}
