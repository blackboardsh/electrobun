// @hutch cli=0.8.0 cottontail=0.4.4
export default {
	electrobun: {
		version: "2.0.1-beta.7",
	},
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=production"],
		"build:canary": ["hutch", "electrobun", "build", "--env=canary"],
	},
};
