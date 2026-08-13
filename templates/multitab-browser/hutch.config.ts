// @hutch cli=0.7.3 cottontail=0.4.4
export default {
	electrobun: {
		version: "2.0.1-beta.6",
	},
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=production"],
	},
};
