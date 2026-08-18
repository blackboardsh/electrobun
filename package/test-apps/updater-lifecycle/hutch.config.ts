// @hutch cli=0.13.0 cottontail=0.5.0
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
