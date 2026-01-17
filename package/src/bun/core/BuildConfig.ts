export type BuildConfigType = {
  defaultRenderer: 'native' | 'cef';
  availableRenderers: ('native' | 'cef')[];
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
      const resourcesDir = 'Resources';
      buildConfig = await Bun.file(`../${resourcesDir}/build.json`).json();
      return buildConfig!;
    } catch (error) {
      // Fallback for dev mode or missing file
      buildConfig = {
        defaultRenderer: 'native',
        availableRenderers: ['native'],
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
