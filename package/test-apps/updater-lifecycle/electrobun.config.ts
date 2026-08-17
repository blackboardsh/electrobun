const requiredEnvironment = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const version = requiredEnvironment("ELECTROBUN_UPDATER_E2E_VERSION");
const appName = requiredEnvironment("ELECTROBUN_UPDATER_E2E_NAME");
const identifier = requiredEnvironment("ELECTROBUN_UPDATER_E2E_IDENTIFIER");
const baseUrl = requiredEnvironment("ELECTROBUN_UPDATER_E2E_BASE_URL");

if (version !== "1.0.0" && version !== "2.0.0") {
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
		mainProcess: "cottontail",
		buildFolder: "build",
		artifactFolder: "artifacts",
		cottontail: {
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
		baseUrl,
		// Version 2.0's supported updater path is the full archive. Keeping
		// patches disabled makes this fixture exercise exactly the shipped path.
		generatePatch: false,
	},
};
