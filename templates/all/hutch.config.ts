// @hutch cli=0.21.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.23",
	},
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
};
