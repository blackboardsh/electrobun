// @hutch cli=0.16.0 cottontail=0.5.0
export default {
	electrobun: {
		version: "2.0.1-beta.19",
	},
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
		"build:canary": ["hutch", "electrobun", "build", "--env=canary"],
	},
};
