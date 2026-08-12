// @hutch cli=0.7.3 cottontail=0.4.3
export default {
	electrobun: {
		version: "2.0.1-beta.6",
	},
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev"],
		build: ["hutch", "electrobun", "build", "--env=production"],
	},
};
