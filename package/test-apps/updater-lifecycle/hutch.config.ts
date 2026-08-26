// @hutch cli=0.26.0-canary.8 cottontail=0.6.0-canary.12
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
