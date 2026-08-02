// @dash cli=0.5.0-canary.4 cottontail=0.2.3
export default {
	scripts: {
		matrix: "scripts/kitchen-matrix.ts",
		"matrix:full": "scripts/kitchen-matrix.ts --full",
		"matrix:test": "hutch test scripts/kitchen-matrix.test.ts",
	},
};
