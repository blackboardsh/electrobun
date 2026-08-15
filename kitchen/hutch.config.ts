// @hutch cli=0.10.0 cottontail=0.4.4
export default {
	electrobun: {
		version: "2.0.1-beta.13",
	},
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: ["hutch", "electrobun", "run"],
		dev: ["hutch", "electrobun", "dev"],
		matrix: ["hutch", "scripts/kitchen-matrix.ts"],
		"matrix:full": ["hutch", "scripts/kitchen-matrix.ts", "--full"],
		"matrix:test": ["hutch", "test", "scripts/kitchen-matrix.test.ts"],
		"package-boundary:test": [
			"node",
			"--test",
			"scripts/package-boundary.test.mjs",
		],
		"check:zig-mirrors": ["hutch", "scripts/check-zig-test-mirrors.ts"],
		"check:odin-mirrors": ["hutch", "scripts/check-odin-test-mirrors.ts"],
		"build:canary":
			"cd ../package && hutch build:release && cd ../kitchen && hutch electrobun build --env=canary",
		"build:production":
			"cd ../package && hutch build:release && cd ../kitchen && hutch electrobun build --env=production",
		"start:canary": ["hutch", "electrobun", "dev", "--env=canary"],
	},
};
