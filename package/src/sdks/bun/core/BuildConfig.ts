import { readFileSync } from "fs";
import type { WindowsWebView2Permission } from "../../../config/windowsPermissions";

export type BuildConfigType = {
	mainProcess?: "bun" | "cottontail" | "zig" | "rust" | "go" | "odin";
	defaultRenderer: "native" | "cef";
	availableRenderers: ("native" | "cef")[];
	buildEnvironment?: "dev" | "canary" | "production" | "stable";
	chromiumFlags?: Record<string, string | boolean>;
	autoGrantPermissions?: WindowsWebView2Permission[];
	/** Runtime channel read from the packaged Resources/version.json metadata. */
	channel: string;
	/** False for dev builds; true for canary, production, and other release channels. */
	isPackaged: boolean;
	cefVersion?: string;
	bunVersion?: string;
	runtime?: {
		exitOnLastWindowClosed?: boolean;
		[key: string]: unknown;
	};
};

let buildConfig: BuildConfigType | null = null;

export function isPackagedBuildChannel(channel: unknown): boolean {
	return typeof channel === "string" && channel.length > 0 && channel !== "dev";
}

function withRuntimeMode(
	config: Omit<BuildConfigType, "channel" | "isPackaged">,
	channel: unknown,
): BuildConfigType {
	const resolvedChannel =
		typeof channel === "string" && channel.length > 0 ? channel : "dev";
	return {
		...config,
		channel: resolvedChannel,
		isPackaged: isPackagedBuildChannel(resolvedChannel),
	};
}

function fallbackBuildConfig(): BuildConfigType {
	return withRuntimeMode(
		{
			defaultRenderer: "native",
			availableRenderers: ["native"],
		},
		"dev",
	);
}

const BuildConfig = {
	/**
	 * Get the build configuration. Loads from build.json on first call, then returns cached value.
	 */
	get: async (): Promise<BuildConfigType> => {
		if (buildConfig) {
			return buildConfig;
		}

		try {
			const resourcesDir = "Resources";
			const config = (await Bun.file(
				`../${resourcesDir}/build.json`,
			).json()) as Omit<BuildConfigType, "channel" | "isPackaged">;
			let channel: unknown = "dev";
			try {
				const version = (await Bun.file(
					`../${resourcesDir}/version.json`,
				).json()) as { channel?: unknown };
				channel = version.channel;
			} catch {
				// Missing runtime metadata is treated as a development build.
			}
			buildConfig = withRuntimeMode(config, channel);
			return buildConfig!;
		} catch {
			// Fallback for development tools or an incomplete bundle.
			buildConfig = fallbackBuildConfig();
			return buildConfig;
		}
	},

	/**
	 * Get the build configuration synchronously.
	 * Useful for modules that cannot use top-level await.
	 */
	getSync: (): BuildConfigType => {
		if (buildConfig) {
			return buildConfig;
		}

		try {
			const resourcesDir = "Resources";
			const config = JSON.parse(
				readFileSync(`../${resourcesDir}/build.json`, "utf8"),
			) as Omit<BuildConfigType, "channel" | "isPackaged">;
			let channel: unknown = "dev";
			try {
				const version = JSON.parse(
					readFileSync(`../${resourcesDir}/version.json`, "utf8"),
				) as { channel?: unknown };
				channel = version.channel;
			} catch {
				// Missing runtime metadata is treated as a development build.
			}
			buildConfig = withRuntimeMode(config, channel);
			return buildConfig;
		} catch {
			buildConfig = fallbackBuildConfig();
			return buildConfig;
		}
	},

	/**
	 * Get the cached build configuration synchronously.
	 * Returns null if config hasn't been loaded yet.
	 */
	getCached: (): BuildConfigType | null => buildConfig,
};

export { BuildConfig };
