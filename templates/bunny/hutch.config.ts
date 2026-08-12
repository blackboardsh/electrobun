// @hutch cli=0.6.4 cottontail=0.4.2
export default {
	electrobun: {
		version: "2.0.1-beta.0",
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
