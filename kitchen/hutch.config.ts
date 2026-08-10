// @hutch cli=0.5.0 cottontail=0.3.0
export default {
	scripts: {
		matrix: "scripts/kitchen-matrix.ts",
		"matrix:full": "scripts/kitchen-matrix.ts --full",
		"matrix:test": "hutch test scripts/kitchen-matrix.test.ts",
	},
};
