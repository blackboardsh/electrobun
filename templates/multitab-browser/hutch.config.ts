// @hutch cli=0.5.1 cottontail=0.3.0
export default {
	scripts: {
		install: ["npm", "ci"],
		start: ["hutch", "electrobun", "dev"],
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=production"],
	},
};
