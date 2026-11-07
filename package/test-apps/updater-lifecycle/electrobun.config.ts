const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const version = requiredEnvironment("ELECTROBUN_UPDATER_E2E_VERSION");
const appName = requiredEnvironment("ELECTROBUN_UPDATER_E2E_NAME");
const identifier = requiredEnvironment("ELECTROBUN_UPDATER_E2E_IDENTIFIER");
const baseUrl = requiredEnvironment("ELECTROBUN_UPDATER_E2E_BASE_URL");
const managedAppId = process.env.ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID;
const managedApiUrl = process.env.ELECTROBUN_UPDATER_E2E_MANAGED_API_URL;
const insightsEnabled = process.env.ELECTROBUN_UPDATER_E2E_INSIGHTS === "1";
if (Boolean(managedAppId) !== Boolean(managedApiUrl) || (insightsEnabled && !managedAppId)) {
	throw new Error("Managed lifecycle requires both an app ID and an explicit test API URL");
}

if (!["1.0.0", "2.0.0", "3.0.0", "4.0.0"].includes(version)) {
	throw new Error(`unsupported updater lifecycle fixture version: ${version}`);
}

export default {
	app: {
		name: appName,
		identifier,
		version,
		description: "Updater lifecycle test fixture",
	},
	runtime: {
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		buildFolder: "build",
		artifactFolder: "artifacts",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"src/release-marker.txt": "updater-lifecycle-release-marker.txt",
		},
		mac: {
			bundleCEF: false,
			bundleWGPU: false,
			codesign: false,
			notarize: false,
			createDmg: true,
		},
		linux: {
			bundleCEF: false,
			bundleWGPU: false,
		},
		win: {
			bundleCEF: false,
			bundleWGPU: false,
		},
	},
	release: {
		...(managedAppId ? { managed: { appId: managedAppId, apiUrl: managedApiUrl } } : { baseUrl }),
		generatePatch: true,
	},
	...(insightsEnabled ? { insights: { appId: managedAppId, apiUrl: managedApiUrl, enabled: true } } : {}),
};
