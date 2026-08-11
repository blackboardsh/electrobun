// @hutch cli=0.6.0 cottontail=0.4.1
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
	},
};
