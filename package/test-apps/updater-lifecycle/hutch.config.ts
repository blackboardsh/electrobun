// @hutch cli=0.27.0-canary.11 cottontail=0.7.0-canary.13
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
