// @hutch cli=0.16.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.21",
	},
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		watch: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
};
