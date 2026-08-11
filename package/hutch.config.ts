// @hutch cli=0.6.0 cottontail=0.4.0
export default {
	packageManager: "npm",
	scripts: {
		install: ["hutch", "pm", "ci"],
		start: "hutch src/sdks/main/index.ts",
		"check-zig-version": "vendors/zig/zig version",
		"check-rust-version": "vendors/rust/bin/rustc --version",
		"build:dev": "hutch build.ts",
		"build:local": ["node", "scripts/build-local.js"],
		"build:release": "hutch build.ts --release",
		dev: ["hutch", "scripts/dev.ts"],
		"dev:matrix": ["hutch", "scripts/dev-matrix.ts"],
		"dev:test": ["hutch", "scripts/dev.test.ts"],
		"dev:clean": "cd ../kitchen && rm -rf node_modules vendors/cef && cd ../package && hutch dev",
		"dev:canary": "hutch run install && hutch build:release && cd ../kitchen && hutch run install && hutch electrobun build --env=canary",
		"dev:production": "hutch run install && hutch build:release && cd ../kitchen && hutch run install && hutch electrobun build --env=production",
		"build:docs:release": "cd ../docs && hutch run build",
		typecheck:
			"node node_modules/typescript/bin/tsc --noEmit && cd ../kitchen && node node_modules/typescript/bin/tsc --noEmit",
		"check:release": "hutch typecheck && hutch test:devkit-manifest && hutch test:version-bump && hutch test:templates && hutch test:odin-templates && hutch test:template-publisher && hutch test:signing && hutch test:deployment-target && hutch test:linux-abi && hutch test:linux-extractor && hutch test:npm-bootstrap && hutch test:release-notes",
		"push:beta": "hutch check:release && node scripts/push-version.js beta",
		"push:patch": "hutch check:release && node scripts/push-version.js patch",
		"push:minor": "hutch check:release && node scripts/push-version.js minor",
		"push:major": "hutch check:release && node scripts/push-version.js major",
		"push:stable": "hutch check:release && node scripts/push-version.js stable",
		"test:dialog-paths-native": "hutch scripts/test-dialog-paths-native.js",
		"test:linux-cef-idle": "node scripts/test-linux-cef-idle.js",
		"test:linux-dpi-native": "hutch scripts/test-linux-dpi-native.js",
		"test:linux-x11-geometry-native":
			"hutch scripts/test-linux-x11-geometry-native.js",
		"test:views-url-native": "hutch scripts/test-views-url-native.js",
		"test:windows-ui-native": "hutch scripts/test-windows-ui-native.js",
		"test:windows-ui-native-integration":
			"hutch scripts/test-windows-ui-native.js --require-native-wrapper",
		"test:unit": "node scripts/run-cottontail-test.js src/shared src/sdks/main src/config src/preload && hutch test:dialog-paths-native && hutch test:linux-dpi-native && hutch test:linux-x11-geometry-native && hutch test:views-url-native && hutch test:webview2-permissions && hutch test:windows-ui-native",
		"test:devkit-manifest":
			"node --test scripts/validate-native-devkit.test.mjs scripts/bun-vendor.test.mjs",
		"test:version-bump":
			"node --test scripts/version-config.test.mjs scripts/verify-release-version.test.mjs scripts/create-artifact-index.test.mjs",
		"test:linux-native-dialog":
			"node scripts/run-cottontail-test.js src/shared/linux-native-file-dialog.test.ts && scripts/test-linux-native-file-dialog.sh",
		"test:cef-debug": ["hutch", "scripts/test-cef-remote-debugging.ts"],
		"test:webview2-permissions": [
			"hutch",
			"scripts/test-webview2-permissions.ts",
		],
		"test:macos-inspector-layout": "scripts/test-macos-inspector-layout.sh",
		"test:templates": "node scripts/run-cottontail-test.js ../templates/template-manifests.test.ts ../templates/all-template-orchestrator.test.ts && node --test ../templates/vite-devkit-resolution.test.mjs",
		"test:odin-templates": "node scripts/test-odin-templates.mjs",
		"test:template-publisher": "node --test ../scripts/publish-templates.test.mjs",
		"test:signing": "node scripts/run-cottontail-test.js scripts/verify-macho-code-signing.test.ts",
		"test:deployment-target": "node scripts/run-cottontail-test.js scripts/verify-macho-deployment-target.test.ts",
		"test:linux-abi": "node scripts/run-cottontail-test.js scripts/verify-linux-elf-abi.test.ts",
		"test:linux-extractor": "node scripts/test-linux-adjacent-extractor.mjs",
		"test:npm-bootstrap":
			"node --test ../npm/electrobun/test/bootstrap.test.mjs ../npm/electrobun/test/package.test.mjs",
		"test:release-notes": "node scripts/release-notes-contract.test.mjs",
		"test:spell-check": "node --test src/shared/spell-check.test.js",
		"test:macos-spell-check": "scripts/test-macos-spell-check.sh",
		"bump-cef": "hutch scripts/update-cef-version.ts",
	},
};
