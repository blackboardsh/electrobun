// @hutch cli=0.21.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.24",
	},
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
};
