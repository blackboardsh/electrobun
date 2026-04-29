export type BuildConfigType = {
	defaultRenderer: "native" | "cef";
	availableRenderers: ("native" | "cef")[];
	cefVersion?: string;
	bunVersion?: string;
	runtime?: {
		exitOnLastWindowClosed?: boolean;
		[key: string]: unknown;
	};
	/**
	 * X11 / GTK `WM_CLASS` hint applied to every window on Linux. Set
	 * by the CLI from `electrobun.config.ts` `build.linux.wmClass`. The
	 * bun side reads this on first window creation and forwards it to
	 * the native wrapper via `setLinuxWmClass()`. Has no effect on
	 * macOS or Windows targets — those platforms use other mechanisms
	 * (CFBundleIdentifier on macOS, AUMID on Windows).
	 */
	wmClass?: string;
};

let buildConfig: BuildConfigType | null = null;

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
			buildConfig = {
				defaultRenderer: "native",
				availableRenderers: ["native"],
			};
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
