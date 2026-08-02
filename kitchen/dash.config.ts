// @dash cli=0.3.1 cottontail=0.2.3
export default {
	scripts: {
		matrix: "scripts/kitchen-matrix.ts",
		"matrix:full": "scripts/kitchen-matrix.ts --full",
		"matrix:test": "hutch test scripts/kitchen-matrix.test.ts",
	},
};
