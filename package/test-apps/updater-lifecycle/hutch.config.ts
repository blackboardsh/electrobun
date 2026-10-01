// @hutch cli=0.28.0-canary.1 cottontail=0.7.2-canary.3
const electrobunVersion = process.env.ELECTROBUN_UPDATER_E2E_SDK_VERSION;

if (!electrobunVersion) {
	throw new Error("ELECTROBUN_UPDATER_E2E_SDK_VERSION is required");
}

export default {
	electrobun: {
		version: electrobunVersion,
	},
	packageManager: "npm",
	scripts: {},
};
