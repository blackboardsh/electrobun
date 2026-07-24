const LEGACY_BUN_CONFIG_ERROR =
	'Bun main-process configuration has been removed. Use build.mainProcess = "cottontail" and move build.bun options to build.cottontail.';

export function assertNoLegacyBunMainProcessConfig(config: unknown): void {
	if (!config || typeof config !== "object") return;

	const build = (config as Record<string, unknown>)["build"];
	if (!build || typeof build !== "object") return;

	const buildConfig = build as Record<string, unknown>;
	if (
		buildConfig["mainProcess"] === "bun" ||
		Object.hasOwn(buildConfig, "bun") ||
		Object.hasOwn(buildConfig, "bunVersion") ||
		Object.hasOwn(buildConfig, "bunnyBun")
	) {
		throw new Error(LEGACY_BUN_CONFIG_ERROR);
	}
}
