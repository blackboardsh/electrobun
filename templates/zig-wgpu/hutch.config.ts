// @hutch cli=0.10.0 cottontail=0.4.4
export default {
	electrobun: {
		version: "2.0.1-beta.13",
	},
	scripts: {
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		watch: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=production"],
	},
};
