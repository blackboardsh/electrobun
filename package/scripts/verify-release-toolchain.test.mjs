import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	parseAppCottontailVersion,
	parseHutchPragma,
	verifyAppCottontailVersion,
	verifyReleaseToolchain,
} from "./verify-release-toolchain.mjs";

test("app runtime provenance accepts an independent exact source pin", () => {
	const build = parseHutchPragma("// @hutch cli=0.27.0-canary.6 cottontail=0.7.0-canary.7\n");
	const source = '// App runtime component, independent of build tools.\r\nexport const COTTONTAIL_VERSION = "0.7.0-canary.6";\r\n';
	const app = parseAppCottontailVersion(source);
	assert.notEqual(app, build.cottontail);
	assert.equal(verifyAppCottontailVersion({
		source,
		manifest: { toolchains: { cottontail: { defaultVersion: app } } },
		expectedVersion: app,
	}), app);
});

test("app runtime provenance rejects stale source and emitted pins independently", () => {
	const expectedVersion = "0.7.0-canary.7";
	const source = `export const COTTONTAIL_VERSION = "${expectedVersion}";\n`;
	const manifest = { toolchains: { cottontail: { defaultVersion: expectedVersion } } };
	assert.throws(() => verifyAppCottontailVersion({
		source: source.replace("canary.7", "canary.6"), manifest, expectedVersion,
	}), /source app Cottontail pin: expected "0\.7\.0-canary\.7", got "0\.7\.0-canary\.6"/);
	assert.throws(() => verifyAppCottontailVersion({
		source,
		manifest: { toolchains: { cottontail: { defaultVersion: "0.7.0-canary.6" } } },
		expectedVersion,
	}), /emitted app Cottontail pin: expected "0\.7\.0-canary\.7", got "0\.7\.0-canary\.6"/);
	assert.throws(() => verifyAppCottontailVersion({ source, manifest: {}, expectedVersion }),
		/emitted app Cottontail pin must be an exact SemVer/);
});

test("app runtime source parsing rejects missing, duplicate, and non-exact constants", () => {
	for (const source of ["", 'const COTTONTAIL_VERSION = "0.7.0";\n']) {
		assert.throws(() => parseAppCottontailVersion(source), /exactly one exported COTTONTAIL_VERSION constant; found 0/);
	}
	assert.throws(() => parseAppCottontailVersion('export const COTTONTAIL_VERSION = "0.7.0";\n'.repeat(2)),
		/exactly one exported COTTONTAIL_VERSION constant; found 2/);
	assert.throws(() => parseAppCottontailVersion('export const COTTONTAIL_VERSION = otherPin;\n'), /quoted const declaration/);
	for (const version of ["canary", "^0.7.0", "0.7.0-canary.01"]) {
		assert.throws(() => parseAppCottontailVersion(`export const COTTONTAIL_VERSION = "${version}";\n`), /app Cottontail pin must be an exact SemVer/);
	}
});

test("release provenance requires a separate exact app expectation before probing", () => {
	for (const version of [undefined, "canary", "^0.7.0", "0.7.0-canary.01"]) {
		assert.throws(() => verifyReleaseToolchain({
			EXPECTED_HUTCH_VERSION: "0.27.0-canary.6",
			EXPECTED_COTTONTAIL_VERSION: "0.7.0-canary.7",
			EXPECTED_APP_COTTONTAIL_VERSION: version,
		}), /EXPECTED_APP_COTTONTAIL_VERSION must be an exact SemVer/);
	}
});

test("release provenance accepts only the exact Hutch pragma format", () => {
	assert.deepEqual(
		parseHutchPragma("// @hutch cli=0.5.0 cottontail=0.3.0\nexport default {};\n"),
		{ hutch: "0.5.0", cottontail: "0.3.0" },
	);
	assert.throws(
		() => parseHutchPragma("// @dash cli=0.5.0 cottontail=0.3.0\n"),
		/must start with an exact \/\/ @hutch/,
	);
	assert.throws(
		() => parseHutchPragma("// @hutch cottontail=0.3.0 cli=0.5.0\n"),
		/must start with an exact \/\/ @hutch/,
	);
});

test("release provenance accepts exact stable and prerelease SemVer", () => {
	assert.deepEqual(
		parseHutchPragma(
			"// @hutch cli=0.5.0+release.01 cottontail=0.3.0+macos-arm64\n",
		),
		{
			hutch: "0.5.0+release.01",
			cottontail: "0.3.0+macos-arm64",
		},
	);
	assert.deepEqual(
		parseHutchPragma(
			"// @hutch cli=0.26.0-canary.1 cottontail=0.6.0-canary.5\n",
		),
		{
			hutch: "0.26.0-canary.1",
			cottontail: "0.6.0-canary.5",
		},
	);
});

test("release provenance rejects non-exact Hutch pragma pins", () => {
	for (const version of [
		"0.5.0-beta.01",
		"^0.5.0",
		"latest",
		"file:../hutch",
		"../hutch",
		"v0.5.0",
		"00.5.0",
	]) {
		assert.throws(
			() =>
				parseHutchPragma(
					`// @hutch cli=${version} cottontail=0.3.0\n`,
				),
			/exact SemVer 2\.0\.0/,
			`expected Hutch pin ${JSON.stringify(version)} to be rejected`,
		);
		assert.throws(
			() =>
				parseHutchPragma(
					`// @hutch cli=0.5.0 cottontail=${version}\n`,
				),
			/exact SemVer 2\.0\.0/,
			`expected Cottontail pin ${JSON.stringify(version)} to be rejected`,
		);
	}
});

test("release provenance rejects invalid expected production versions before probing", () => {
	for (const version of [
		"0.5.0-01",
		"~0.5.0",
		"production",
		"file:../hutch",
		"0.5",
	]) {
		assert.throws(
			() =>
				verifyReleaseToolchain({
					EXPECTED_HUTCH_VERSION: version,
					EXPECTED_COTTONTAIL_VERSION: "0.3.0",
				}),
			/EXPECTED_HUTCH_VERSION must be an exact SemVer 2\.0\.0/,
		);
		assert.throws(
			() =>
				verifyReleaseToolchain({
					EXPECTED_HUTCH_VERSION: "0.5.0",
					EXPECTED_COTTONTAIL_VERSION: version,
				}),
			/EXPECTED_COTTONTAIL_VERSION must be an exact SemVer 2\.0\.0/,
		);
	}
});

test("pin:latest bootstraps through the old self-update verb before repinning", () => {
	const config = readFileSync(
		new URL("../hutch.config.ts", import.meta.url),
		"utf8",
	);
	// This task is initially interpreted by the repository's old pinned engine.
	// Keep its first verb compatible with Hutch releases that predate the
	// user-facing `hutch upgrade` alias.
	assert.match(
		config,
		/"pin:latest":\s*"hutch self update && cd \.\. && hutch self pin --recursive && hutch cottontail pin --recursive && node package\/scripts\/sync-release-toolchain-pins\.mjs"/,
	);
	assert.doesNotMatch(config, /"pin:latest":\s*"hutch upgrade\b/);
	assert.doesNotMatch(config, /\bhutch cottontail update\b/);
});

test("release provenance probes the exact Hutch engine's compiled Cottontail pair", () => {
	const verifier = readFileSync(
		new URL("./verify-release-toolchain.mjs", import.meta.url),
		"utf8",
	);
	assert.match(
		verifier,
		/run\(hutchExecutable, \["cottontail", "version"\], repositoryRoot\)/,
	);
	assert.match(
		verifier,
		/run\(hutchExecutable, \["cottontail", "path"\], repositoryRoot\)/,
	);
	assert.doesNotMatch(
		verifier,
		/run\("hutch", \["cottontail", "(?:version|path)", expectedCottontailChannel\]/,
	);
});

test("release CI verifies provenance before all four Kitchen builds", () => {
	// Normalize CRLF -> LF: on Windows runners Git checks the workflow out with
	// CRLF, which breaks the explicit `\n` line separators in the regexes below.
	const workflow = readFileSync(
		new URL("../../.github/workflows/release.yml", import.meta.url),
		"utf8",
	).replace(/\r\n/g, "\n");
	const installAction = readFileSync(
		new URL("../../.github/actions/install-hutch/action.yml", import.meta.url),
		"utf8",
	).replace(/\r\n/g, "\n");
	assert.match(installAction, /installed_name=hutch[\s\S]*installed_name=hutch-canary/);
	assert.match(installAction, /printf '#!\/bin\/sh\\nexec "%s" "\$@"\\n'/);
	assert.match(installAction, /"hutch-canary\.exe"[\s\S]*"hutch\.exe"/);
	assert.equal((installAction.match(/HUTCH_ACTIVE_CHANNEL=/g) ?? []).length, 2);
	const matrix = workflow.slice(
		workflow.indexOf("        include:"),
		workflow.indexOf("    runs-on:", workflow.indexOf("        include:")),
	);
	assert.equal((matrix.match(/^          - os:/gm) ?? []).length, 4);
	for (const runner of [
		"macos-14",
		"ubuntu-24.04",
		"ubuntu-24.04-arm",
		"windows-2025",
	]) {
		assert.match(matrix, new RegExp(`^          - os: ${runner}$`, "m"));
	}
	assert.match(
		workflow,
		/^  build:\n    strategy:\n      fail-fast: false\n      matrix:/m,
		"all release build platforms should finish their test jobs after another platform fails",
	);
	assert.match(
		workflow,
		/^      - name: Test npm bootstrap and release tooling\n        run: hutch test:npm-bootstrap\n        working-directory: package$/m,
		"the portable npm bootstrap suite should run on every release build platform",
	);
	for (const [name, testFile] of [
		["Test Kitchen AUTO_RUN exit propagation", "src/test-framework/auto-run-exit.test.ts"],
		["Test Kitchen renderer requirements", "src/test-framework/requirements.test.ts"],
		["Test Kitchen result summary", "src/test-runner/test-summary.test.ts"],
		["Test Kitchen quit exit codes", "../package/src/sdks/main/__tests__/utils-quit-exit-code.test.ts"],
	]) {
		assert.match(
			workflow,
			new RegExp(
				`^      - name: ${name}\\n        if: \\$\\{\\{ !cancelled\\(\\) \\}\\}\\n        run: hutch test ${testFile.replaceAll("/", "\\/").replaceAll(".", "\\.")}\\n        working-directory: kitchen$`,
				"m",
			),
			`${testFile} should run independently on every release build platform`,
		);
	}

	// The workflow env must mirror the canonical pragma pin, whatever it is.
	const pins = parseHutchPragma(
		readFileSync(new URL("../hutch.config.ts", import.meta.url), "utf8"),
	);
	const exact = (version) => version.replaceAll(".", "\\.").replaceAll("+", "\\+");
	assert.match(
		workflow,
		new RegExp(`^      EXPECTED_HUTCH_VERSION: '${exact(pins.hutch)}'$`, "m"),
	);
	assert.match(
		workflow,
		new RegExp(`^      EXPECTED_COTTONTAIL_VERSION: '${exact(pins.cottontail)}'$`, "m"),
	);
	const appVersion = parseAppCottontailVersion(readFileSync(
		new URL("../src/shared/cottontail-version.ts", import.meta.url), "utf8",
	));
	assert.match(
		workflow,
		new RegExp(`^      EXPECTED_APP_COTTONTAIL_VERSION: '${exact(appVersion)}'$`, "m"),
	);
	for (const lifecycleToken of [
		"test:linux-extractor",
		"test:macos-uninstaller",
		"test:windows-uninstaller",
		"test:updater-lifecycle",
		"test-updater-lifecycle.mjs",
	]) {
		assert.equal(
			workflow.includes(lifecycleToken),
			false,
			`${lifecycleToken} must remain opt-in rather than running for every release`,
		);
	}
	assert.match(
		workflow,
		/^      - name: Install Hutch\n        uses: \.\/\.github\/actions\/install-hutch\n        with:\n          channel: \$\{\{ contains\(env\.EXPECTED_HUTCH_VERSION, '-'\) && 'canary' \|\| 'production' \}\}$/m,
	);
	assert.match(
		workflow,
		/^      - name: Install Kitchen dependencies\n        run: hutch run install\n        working-directory: kitchen\n\n      - name: Typecheck Kitchen against local devkit\n        run: \|\n          hutch electrobun prepare\n          node \.\.\/package\/node_modules\/typescript\/bin\/tsc --noEmit\n        working-directory: kitchen\n        env:\n          HUTCH_ELECTROBUN_DEVKIT_ROOT: \$\{\{ github\.workspace \}\}\/package\/dist$/m,
	);
	const macCleanupStart = workflow.indexOf(
		"      - name: Free disk space (macOS)",
	);
	const macCleanup = workflow.slice(
		macCleanupStart,
		workflow.indexOf("\n      - name:", macCleanupStart + 1),
	);
	assert.match(
		macCleanup,
		/selected_xcode_root="\$\(cd "\$\(xcode-select -p\)\/\.\.\/\.\." && pwd -P\)"/,
		"macOS cleanup must resolve and preserve the selected Xcode",
	);
	assert.match(
		macCleanup,
		/for xcode_root in \/Applications\/Xcode_\*\.app; do\n            \[\[ -d "\$xcode_root" && ! -L "\$xcode_root" \]\] \|\| continue/,
		"macOS cleanup must only consider real versioned Xcode directories",
	);
	assert.match(
		macCleanup,
		/case "\$resolved_xcode_root" in\n              \/Applications\/Xcode_\*\.app\) ;;[\s\S]*?if \[\[ "\$resolved_xcode_root" != "\$selected_xcode_root" \]\]; then\n              echo "Removing unused Xcode: \$resolved_xcode_root"\n              sudo rm -rf "\$resolved_xcode_root"/,
		"macOS cleanup must not remove the selected Xcode",
	);

	const provenance = workflow.indexOf(
		"      - name: Verify pinned Hutch and Cottontail provenance",
	);
	const build = workflow.indexOf("      - name: Build Kitchen");
	const validate = workflow.indexOf("      - name: Validate Kitchen artifacts");
	assert.ok(provenance !== -1 && provenance < build);
	assert.equal(
		workflow.slice(provenance, build).match(/^      - name:/gm)?.length,
		1,
		"the live provenance gate must be the direct predecessor of the Kitchen build",
	);
	assert.ok(build !== -1 && build < validate);
	const buildStep = workflow.slice(
		build,
		workflow.indexOf("\n      - name:", build + 1),
	);
	assert.match(
		buildStep,
		/^          HUTCH_ELECTROBUN_DEVKIT_ROOT: \$\{\{ github\.workspace \}\}\/package\/dist$/m,
		"Kitchen must bootstrap against the core/devkit built earlier in the same job",
	);
	assert.equal(
		(workflow.match(/HUTCH_ELECTROBUN_DEVKIT_ROOT/g) ?? []).length,
		2,
		"the local devkit override must remain scoped to Kitchen typechecking and building",
	);
});
