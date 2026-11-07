import { ELECTROBUN_API_URL, normalizeManagedCustomOrigin } from "../../../shared/managed-service";

export type InsightsProperties = Record<string, string | number | boolean | null>;

/** Public ingestion configuration. Never include a deploy API key in an app. */
export interface InsightsConfig {
	appId: string;
	/** Advanced endpoint override for staging/local testing. */
	apiUrl?: string;
	/** Defaults to false on every channel; the user's persisted setEnabled choice wins. */
	enabled?: boolean;
}

export interface InsightsVersion {
	version?: string;
	hash?: string;
	channel?: string;
	updateAuthority?: "direct" | "external" | "none";
	distribution?: string;
	/** Packaged managed update configuration; custom domains also receive Insights. */
	managed?: { appId: string; baseUrl?: string };
}

function insightsApiUrl(config: InsightsConfig, version: InsightsVersion): string {
	if (config.apiUrl !== undefined) return config.apiUrl;
	const managed = version.managed;
	if (managed?.baseUrl === undefined) return ELECTROBUN_API_URL;
	if (managed.appId !== config.appId) {
		throw new Error("Insights cannot inherit a custom domain bound to a different managed app");
	}
	return normalizeManagedCustomOrigin(managed.baseUrl);
}

export function validInsightsEventName(name: unknown): name is string {
	return typeof name === "string" && name.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9_.: -]*$/.test(name);
}

export function resolveInsightsConfiguration(
	config: InsightsConfig,
	version: InsightsVersion,
	storagePath: string,
	platform: string,
	arch: string,
	updateAuthority: "direct" | "external" | "none" = "direct",
	distribution = "direct",
) {
	const channel = version.channel ?? "dev";
	return {
		appId: config.appId,
		apiUrl: insightsApiUrl(config, version),
		// The native core additionally restricts explicit dev collection to a
		// loopback HTTP endpoint; the production ingest API accepts packaged builds.
		enabled: config.enabled === true,
		storagePath,
		version: version.version ?? "",
		buildHash: version.hash ?? "",
		channel,
		platform,
		arch,
		distribution: version.distribution ?? distribution,
		updateAuthority: version.updateAuthority ?? updateAuthority,
	};
}

/** Keep custom events inside the public ingestion limits before crossing FFI. */
export function serializeInsightsProperties(properties: InsightsProperties): string | null {
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
	const entries = Object.entries(properties);
	if (entries.length > 16) return null;
	for (const [key, value] of entries) {
		if (key.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(key)) return null;
		if (value === null || typeof value === "boolean") continue;
		if (typeof value === "number" && Number.isFinite(value)) continue;
		if (typeof value === "string" && value.length <= 256) continue;
		return null;
	}
	try {
		return JSON.stringify(properties);
	} catch {
		return null;
	}
}
