// @hutch cli=0.9.0 cottontail=0.4.4
export default {
	electrobun: {
		version: "2.0.1-beta.12",
	},
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev"],
		build: ["hutch", "electrobun", "build", "--env=production"],
	},
};
