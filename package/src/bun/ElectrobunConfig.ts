/**
 * Electrobun configuration type definitions
 * Used in electrobun.config.ts files
 */

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
     * Bun process build configuration
     */
    bun?: {
      /**
       * Entry point for the main Bun process
       * @default "src/bun/index.ts"
       */
      entrypoint?: string;
      
      /**
       * External modules to exclude from bundling
       * @default []
       */
      external?: string[];
    };

    /**
     * Browser view build configurations
     */
    views?: {
      [viewName: string]: {
        /**
         * Entry point for this view's TypeScript code
         */
        entrypoint: string;
        
        /**
         * External modules to exclude from bundling for this view
         */
        external?: string[];
      };
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
      defaultRenderer?: 'native' | 'cef';

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
      defaultRenderer?: 'native' | 'cef';
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
      defaultRenderer?: 'native' | 'cef';
    };
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
     * Base URL for artifact distribution (e.g., S3 bucket URL)
     * Used for auto-updates and patch generation
     */
    bucketUrl?: string;
  };
}

