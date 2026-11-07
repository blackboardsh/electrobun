import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OS, ARCH } from "../../../shared/platform";
import { BuildConfig } from "./BuildConfig";
import { RESOURCES_FOLDER } from "./Paths";
import { paths } from "./Utils";
import { insightsNative } from "../proc/insightsNative";
import {
	resolveInsightsConfiguration,
	serializeInsightsProperties,
	validInsightsEventName,
	type InsightsConfig,
	type InsightsProperties,
	type InsightsVersion,
} from "./InsightsConfig";

export type { InsightsConfig, InsightsProperties } from "./InsightsConfig";

let attempted = false;
let configured = false;
let shutdownRegistered = false;

/** Called by native bootstrap; configuration only performs bounded local work. */
export function initializeInsights(): boolean {
	if (attempted) return configured;
	attempted = true;
	try {
		const build = BuildConfig.getSync();
		if (!build.insights) return false;
		return configure(build.insights);
	} catch {
		return false;
	}
}

function configure(config: InsightsConfig): boolean {
	attempted = true;
	try {
		const version = JSON.parse(readFileSync(join(RESOURCES_FOLDER, "version.json"), "utf8")) as InsightsVersion;
		const build = BuildConfig.getSync();
		const configuration = resolveInsightsConfiguration(
			config, version, join(paths.userData, "insights"), OS, ARCH, build.updateAuthority, build.distribution,
		);
		configured = insightsNative.configure(JSON.stringify(configuration));
		if (configured && !shutdownRegistered) {
			shutdownRegistered = true;
			process.once("exit", () => { insightsNative.shutdown(); });
		}
		return configured;
	} catch {
		return false;
	}
}

export const Insights = {
	/** Initialize public ingestion settings before automatic startup runs. */
	configure,
	/** Queue an event. False means disabled, unsupported or outside ingestion limits. */
	track(name: string, properties: InsightsProperties = {}): boolean {
		if (!initializeInsights() || !validInsightsEventName(name)) return false;
		const json = serializeInsightsProperties(properties);
		return json !== null && insightsNative.track(name, json);
	},
	/** Associate future custom events with an opaque app user ID; app sessions are unchanged. */
	identify(userId: string): void {
		if (!initializeInsights() || !userId || userId.length > 256 || userId.includes("\0")) return;
		insightsNative.identify(userId);
	},
	/** Clear user association for future custom events, preserving the app session and installation ID. */
	reset(): void { if (initializeInsights()) insightsNative.reset(); },
	/** Disable collection, or resume it. This does not enable the updater. */
	setEnabled(enabled: boolean): void { if (initializeInsights()) insightsNative.setEnabled(enabled); },
	getInstallationId(): string | null { return initializeInsights() ? insightsNative.getInstallationId() : null; },
	/** Request background delivery without waiting for the network. */
	flush(): void { if (initializeInsights()) insightsNative.flush(); },
};
