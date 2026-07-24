import { readFileSync } from "fs";

export type BuildConfigType = {
	mainProcess?: "cottontail" | "zig" | "rust" | "go" | "odin";
	defaultRenderer: "native" | "cef";
	availableRenderers: ("native" | "cef")[];
	cefVersion?: string;
	runtime?: {
		exitOnLastWindowClosed?: boolean;
		[key: string]: unknown;
	};
};

let buildConfig: BuildConfigType | null = null;

function fallbackBuildConfig(): BuildConfigType {
	return {
		defaultRenderer: "native",
		availableRenderers: ["native"],
	};
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
			buildConfig = await Bun.file(`../${resourcesDir}/build.json`).json();
			return buildConfig!;
		} catch (error) {
			// Fallback for dev mode or missing file
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
			buildConfig = JSON.parse(
				readFileSync(`../${resourcesDir}/build.json`, "utf8"),
			) as BuildConfigType;
			return buildConfig;
		} catch (error) {
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
