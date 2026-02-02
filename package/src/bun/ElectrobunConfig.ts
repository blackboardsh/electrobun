/**
 * Electrobun configuration type definitions
 * Used in electrobun.config.ts files
 */

/**
 * Bun.build() options that can be passed through to the bundler.
 * Excludes options that are controlled by Electrobun (entrypoints, outdir, target).
 * See https://bun.sh/docs/bundler for full documentation.
 */
type BunBuildOptions = Omit<
	Parameters<typeof Bun.build>[0],
	"entrypoints" | "outdir" | "target"
>;

export interface ElectrobunConfig {
	/**
	 * Application metadata configuration
	 */
	app: {
		/**
		 * The display name of your application
		 */
		name: string;

		/**
		 * Unique identifier for your application (e.g., "com.example.myapp")
		 * Used for platform-specific identifiers
		 */
		identifier: string;

		/**
		 * Application version string (e.g., "1.0.0")
		 */
		version: string;

		/**
		 * Custom URL schemes to register for deep linking (e.g., ["myapp", "myapp-dev"])
		 * This allows your app to be opened via URLs like myapp://some/path
		 *
		 * Platform support:
		 * - macOS: Fully supported. App must be in /Applications folder for registration to work.
		 * - Windows: Not yet supported
		 * - Linux: Not yet supported
		 *
		 * To handle incoming URLs, listen for the "open-url" event:
		 * ```typescript
		 * Electrobun.events.on("open-url", (e) => {
		 *   console.log("Opened with URL:", e.data.url);
		 * });
		 * ```
		 */
		urlSchemes?: string[];
	};

	/**
	 * Build configuration options
	 */
	build?: {
		/**
		 * Bun process build configuration.
		 * Accepts all Bun.build() options (plugins, sourcemap, minify, define, etc.)
		 * in addition to the entrypoint. See https://bun.sh/docs/bundler
		 */
		bun?: {
			/**
			 * Entry point for the main Bun process
			 * @default "src/bun/index.ts"
			 */
			entrypoint?: string;
		} & BunBuildOptions;

		/**
		 * Browser view build configurations.
		 * Each view accepts all Bun.build() options (plugins, sourcemap, minify, define, etc.)
		 * in addition to the entrypoint. See https://bun.sh/docs/bundler
		 */
		views?: {
			[viewName: string]: {
				/**
				 * Entry point for this view's TypeScript code
				 */
				entrypoint: string;
			} & BunBuildOptions;
		};

		/**
		 * Files to copy directly to the build output
		 * Key is source path, value is destination path
		 */
		copy?: {
			[sourcePath: string]: string;
		};
		/**
		 * Output folder for built application
		 * @default "build"
		 */
		buildFolder?: string;

		/**
		 * Output folder for distribution artifacts
		 * @default "artifacts"
		 */
		artifactFolder?: string;

		/**
		 * Build targets to compile for
		 * Can be "current", "all", or comma-separated list like "macos-arm64,win-x64"
		 */
		targets?: string;

		/**
		 * Enable ASAR archive packaging for bundled assets
		 * When enabled, all files in the Resources folder will be packed into an app.asar archive
		 * @default false
		 */
		useAsar?: boolean;

		/**
		 * Glob patterns for files to exclude from ASAR packing (extract to app.asar.unpacked)
		 * Useful for native modules or executables that need to be accessible as regular files
		 * @default ["*.node", "*.dll", "*.dylib", "*.so"]
		 */
		asarUnpack?: string[];

		/**
		 * Override the CEF (Chromium Embedded Framework) version.
		 * Format: "CEF_VERSION+chromium-CHROMIUM_VERSION"
		 * Example: "144.0.11+ge135be2+chromium-144.0.7559.97"
		 *
		 * Check the electrobun-cef-compat compatibility matrix for tested combinations
		 * before overriding. Using an untested version may cause runtime issues.
		 * @default Uses the version bundled with this Electrobun release
		 */
		cefVersion?: string;

		/**
		 * macOS-specific build configuration
		 */
		mac?: {
			/**
			 * Enable code signing for macOS builds
			 * @default false
			 */
			codesign?: boolean;

			/**
			 * Enable notarization for macOS builds (requires codesign)
			 * @default false
			 */
			notarize?: boolean;

			/**
			 * Bundle CEF (Chromium Embedded Framework) instead of using system WebView
			 * @default false
			 */
			bundleCEF?: boolean;

			/**
			 * Default renderer for webviews when not explicitly specified
			 * @default 'native'
			 */
			defaultRenderer?: "native" | "cef";

			/**
			 * Custom Chromium command-line flags to pass to CEF during initialization.
			 * Keys are flag names without the "--" prefix.
			 * Use `true` for switch-only flags, or a string for flags that take a value.
			 *
			 * @example
			 * ```typescript
			 * chromiumFlags: {
			 *   "disable-gpu": true,                // --disable-gpu
			 *   "remote-debugging-port": "9333",    // --remote-debugging-port=9333
			 * }
			 * ```
			 */
			chromiumFlags?: Record<string, string | true>;

			/**
			 * macOS entitlements for code signing
			 */
			entitlements?: Record<string, boolean | string>;

			/**
			 * Path to .iconset folder containing app icons
			 * @default "icon.iconset"
			 */
			icons?: string;
		};

		/**
		 * Windows-specific build configuration
		 */
		win?: {
			/**
			 * Bundle CEF (Chromium Embedded Framework) instead of using WebView2
			 * @default false
			 */
			bundleCEF?: boolean;

			/**
			 * Default renderer for webviews when not explicitly specified
			 * @default 'native'
			 */
			defaultRenderer?: "native" | "cef";

			/**
			 * Custom Chromium command-line flags to pass to CEF during initialization.
			 * Keys are flag names without the "--" prefix.
			 * Use `true` for switch-only flags, or a string for flags that take a value.
			 *
			 * @example
			 * ```typescript
			 * chromiumFlags: {
			 *   "disable-gpu": true,                // --disable-gpu
			 *   "remote-debugging-port": "9333",    // --remote-debugging-port=9333
			 * }
			 * ```
			 */
			chromiumFlags?: Record<string, string | true>;

			/**
			 * Path to application icon (.ico format)
			 * Used for the installer/extractor wrapper, desktop shortcuts, and taskbar
			 * Should include multiple sizes (16x16, 32x32, 48x48, 256x256) for best results
			 * @example "assets/icon.ico"
			 */
			icon?: string;
		};

		/**
		 * Linux-specific build configuration
		 */
		linux?: {
			/**
			 * Bundle CEF (Chromium Embedded Framework) instead of using GTKWebKit
			 * Recommended on Linux for advanced layer compositing features
			 * @default false
			 */
			bundleCEF?: boolean;

			/**
			 * Default renderer for webviews when not explicitly specified
			 * @default 'native'
			 */
			defaultRenderer?: "native" | "cef";

			/**
			 * Custom Chromium command-line flags to pass to CEF during initialization.
			 * Keys are flag names without the "--" prefix.
			 * Use `true` for switch-only flags, or a string for flags that take a value.
			 *
			 * @example
			 * ```typescript
			 * chromiumFlags: {
			 *   "disable-gpu": true,                // --disable-gpu
			 *   "remote-debugging-port": "9333",    // --remote-debugging-port=9333
			 * }
			 * ```
			 */
			chromiumFlags?: Record<string, string | true>;

			/**
			 * Path to application icon (PNG format recommended)
			 * Used for desktop entries, window icons, and taskbar
			 * Should be at least 256x256 pixels for best results
			 * @example "assets/icon.png"
			 */
			icon?: string;
		};
	};

	/**
	 * Runtime behaviour configuration.
	 * These values are copied into build.json and available to the Bun process at runtime.
	 * You can add arbitrary keys here and access them via BuildConfig.
	 */
	runtime?: {
		/**
		 * Quit the application when the last BrowserWindow is closed.
		 * @default true
		 */
		exitOnLastWindowClosed?: boolean;

		[key: string]: unknown;
	};

	/**
	 * Build scripts configuration
	 */
	scripts?: {
		/**
		 * Script to run after build completes
		 * Can be a path to a script file
		 */
		postBuild?: string;
	};

	/**
	 * Release and distribution configuration
	 */
	release?: {
		/**
		 * Base URL for artifact distribution (e.g., S3 bucket, GitHub Releases)
		 * Used for auto-updates and patch generation
		 */
		baseUrl?: string;
		/**
		 * Generate delta patch files by diffing against the previous release.
		 * Disable to skip patch generation for local canary/stable testing.
		 * @default true
		 */
		generatePatch?: boolean;
	};
}
