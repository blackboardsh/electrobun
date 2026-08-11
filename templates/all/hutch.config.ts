// @hutch cli=0.5.1 cottontail=0.3.0
export default {
	electrobun: {
		version: "2.0.1-beta.0",
	},
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev"],
		build: ["hutch", "electrobun", "build", "--env=production"],
	},
};
