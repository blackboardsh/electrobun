// @hutch cli=0.21.0 cottontail=0.5.0
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
		"preview:installer-ui": "node scripts/preview-installer-ui.mjs",
		"preview:installer-ui:error":
			"node scripts/preview-installer-ui.mjs --error",
		"dev:clean": "cd ../kitchen && rm -rf node_modules vendors/cef && cd ../package && hutch dev",
		"dev:canary": "hutch run install && hutch build:release && cd ../kitchen && hutch run install && hutch electrobun build --env=canary",
		"dev:stable": "hutch run install && hutch build:release && cd ../kitchen && hutch run install && hutch electrobun build --env=stable",
		"build:docs:release": "cd ../docs && hutch run build",
		typecheck:
			"hutch src/preload/build.ts && node node_modules/typescript/bin/tsc --noEmit",
		"check:release": "hutch typecheck && hutch test:native-symbol-contract && hutch test:devkit-manifest && hutch test:version-bump && hutch test:templates && hutch test:odin-templates && hutch test:template-publisher && hutch test:signing && hutch test:deployment-target && hutch test:linux-abi && hutch test:installer-ui && hutch test:updater-unit && hutch test:npm-bootstrap && hutch test:release-notes",
		"pin:latest":
			"hutch self update && hutch cottontail update && cd .. && hutch self pin --recursive && hutch cottontail pin --recursive",
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
		"test:installer-ui":
			"node scripts/run-cottontail-test.js src/shared/windows-installer-progress.test.ts",
		"test:unit": "node scripts/run-cottontail-test.js src/shared src/sdks/main src/config src/preload && hutch test:dialog-paths-native && hutch test:linux-dpi-native && hutch test:linux-x11-geometry-native && hutch test:views-url-native && hutch test:webview2-permissions && hutch test:windows-ui-native",
		"test:native-symbol-contract":
			"node scripts/run-cottontail-test.js src/shared/native-symbol-contract.test.ts",
		"test:devkit-manifest":
			"node --test scripts/validate-native-devkit.test.mjs scripts/electrobun-version-runtime.test.mjs",
		"test:version-bump":
			"node --test scripts/version-config.test.mjs scripts/release-git.test.mjs scripts/verify-release-version.test.mjs scripts/create-artifact-index.test.mjs",
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
		"test:macos-uninstaller": "node scripts/test-macos-uninstaller.mjs",
		"test:windows-uninstaller":
			"node scripts/test-windows-uninstaller.mjs",
		"test:updater-unit":
			"node scripts/run-cottontail-test.js src/sdks/main/core/UpdaterPreparation.test.ts src/sdks/main/core/UpdaterResult.test.ts src/sdks/main/core/UtilsInstalledRoot.test.ts src/sdks/main/core/UtilsQuitApproval.test.ts src/sdks/main/core/WindowsUpdateTask.test.ts",
		"test:updater-lifecycle":
			"hutch build:release && node scripts/test-updater-lifecycle.mjs",
		"test:npm-bootstrap":
			"node --test ../npm/electrobun/test/bootstrap.test.mjs ../npm/electrobun/test/package.test.mjs",
		"test:release-notes": "node scripts/release-notes-contract.test.mjs",
		"test:spell-check": "node --test src/shared/spell-check.test.js",
		"test:macos-spell-check": "scripts/test-macos-spell-check.sh",
		"bump-cef": "hutch scripts/update-cef-version.ts",
	},
};
