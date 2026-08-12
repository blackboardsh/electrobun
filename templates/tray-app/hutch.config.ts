// @hutch cli=0.7.1 cottontail=0.4.3
export default {
	electrobun: {
		version: "2.0.1-beta.5",
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
