// @hutch cli=0.27.0-canary.14 cottontail=0.7.0-canary.15
export default {
	electrobun: {
		version: "2.0.2-beta.31",
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
		// Kitchen's own tooling tests (not the in-app suite). The node:test files
		// need Node's runner; the rest use Cottontail's bun:test runner.
		"test:tooling":
			"hutch test scripts/kitchen-matrix.test.ts && hutch test src/test-framework/auto-run-exit.test.ts && hutch test src/test-framework/exclusive-run.test.ts && hutch test src/test-framework/native-auto-run-exit.test.ts && hutch test src/test-framework/requirements.test.ts && hutch test src/test-runner/test-summary.test.ts && node --experimental-strip-types --test src/test-runner/interactive-contract.test.ts src/test-runner/test-order.test.ts && node --test scripts/package-boundary.test.mjs && hutch check:zig-mirrors && hutch check:odin-mirrors",
		"build:canary":
			"cd ../package && hutch build:release && cd ../kitchen && hutch electrobun build --env=canary",
		"build:stable":
			"cd ../package && hutch build:release && cd ../kitchen && hutch electrobun build --env=stable",
		"start:canary": ["hutch", "electrobun", "dev", "--env=canary"],
	},
};
