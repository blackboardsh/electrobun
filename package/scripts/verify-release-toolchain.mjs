#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseStrictSemVer } from "../src/shared/strict-semver.js";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = dirname(dirname(dirname(scriptPath)));
const runtimeProbePath = join(
	repositoryRoot,
	"package",
	"scripts",
	"release-runtime-probe.mjs",
);
const forbiddenOverrides = [
	"HUTCH_ENGINE_BINARY",
	"DASH_COTTONTAIL",
	"COTTONTAIL_BINARY",
	"DASH_COTTONTAIL_SELECTOR",
	"DASH_USE_LOCAL_COTTONTAIL",
	"DASH_ARTIFACTS_BASE_URL",
	"DASH_RELEASE_OFFLINE",
];

function fail(message) {
	throw new Error(`Electrobun release toolchain: ${message}`);
}

function assertEqual(actual, expected, label) {
	if (actual !== expected) {
		fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertExactVersion(value, label) {
	const parsed = parseStrictSemVer(value);
	if (!parsed) {
		fail(
			`${label} must be an exact SemVer 2.0.0 version, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

function releaseChannel(version, label) {
	const parsed = parseStrictSemVer(version);
	if (!parsed) fail(`${label} must be an exact SemVer 2.0.0 version`);
	return parsed.prerelease === null ? "production" : "canary";
}

export function parseHutchPragma(source, label = "hutch.config.ts") {
	const firstLine = source.split(/\r?\n/, 1)[0];
	const match = firstLine.match(
		/^\/\/ @hutch cli=(\S+) cottontail=(\S+)$/,
	);
	if (!match) {
		fail(`${label} must start with an exact // @hutch cli=... cottontail=... pragma`);
	}
	return {
		hutch: assertExactVersion(match[1], `${label} Hutch pin`),
		cottontail: assertExactVersion(match[2], `${label} Cottontail pin`),
	};
}

export function parseAppCottontailVersion(source, label = "package/src/shared/cottontail-version.ts") {
	const declarations = [...source.matchAll(/^[\t ]*export[\t ]+const[\t ]+COTTONTAIL_VERSION\b[^\r\n]*$/gm)];
	if (declarations.length !== 1) {
		fail(`${label} must contain exactly one exported COTTONTAIL_VERSION constant; found ${declarations.length}`);
	}
	const match = /^[\t ]*export[\t ]+const[\t ]+COTTONTAIL_VERSION[\t ]*=[\t ]*(["'])([^"'\r\n]+)\1;[\t ]*$/.exec(declarations[0][0]);
	if (!match) fail(`${label} COTTONTAIL_VERSION must be a quoted const declaration ending in a semicolon`);
	return assertExactVersion(match[2], `${label} app Cottontail pin`);
}

export function verifyAppCottontailVersion({ source, manifest, expectedVersion }) {
	assertExactVersion(expectedVersion, "EXPECTED_APP_COTTONTAIL_VERSION");
	const sourceVersion = parseAppCottontailVersion(source);
	assertEqual(sourceVersion, expectedVersion, "source app Cottontail pin");
	const emittedVersion = manifest?.toolchains?.cottontail?.defaultVersion;
	assertExactVersion(emittedVersion, "emitted app Cottontail pin");
	assertEqual(emittedVersion, expectedVersion, "emitted app Cottontail pin");
	return emittedVersion;
}

function run(command, args, cwd, environment = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			...environment,
			HUTCH_NO_UPDATE_CHECK: "1",
		},
		shell: false,
		windowsHide: true,
	});
	if (result.error) {
		fail(`${command} ${args.join(" ")} failed to start in ${cwd}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
		fail(
			`${command} ${args.join(" ")} failed in ${cwd} with exit ${result.status}${
				output ? `: ${output}` : ""
			}`,
		);
	}
	return result.stdout.trim();
}

function singleLine(output, label) {
	const lines = output.split(/\r?\n/).filter(Boolean);
	if (lines.length !== 1) {
		fail(`${label} returned ${lines.length} output lines instead of one`);
	}
	return lines[0];
}

function canonicalPath(output, label) {
	const path = singleLine(output, label);
	if (!existsSync(path)) fail(`${label} returned a missing path: ${path}`);
	return realpathSync(path);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cottontailVersion(executable, cwd) {
	if (process.platform !== "win32") {
		return run(executable, ["--version"], cwd);
	}
	return run(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"& $env:ELECTROBUN_RELEASE_COTTONTAIL --version; exit $LASTEXITCODE",
		],
		cwd,
		{ ELECTROBUN_RELEASE_COTTONTAIL: executable },
	);
}

function verifyReleaseMetadata({ executable, product, version, channel }) {
	const releaseRoot = dirname(dirname(executable));
	const manifestPath = join(releaseRoot, `${product}-release.json`);
	if (!existsSync(manifestPath)) fail(`missing release metadata ${manifestPath}`);

	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		fail(`invalid release metadata ${manifestPath}: ${error.message}`);
	}
	assertEqual(manifest.product, product, `${product} metadata product`);
	assertEqual(manifest.channel, channel, `${product} metadata channel`);
	assertEqual(manifest.version, version, `${product} metadata version`);
	if (!/^[0-9a-f]{40}$/.test(manifest.revision ?? "")) {
		fail(`${product} metadata has an invalid revision: ${JSON.stringify(manifest.revision)}`);
	}

	return { manifestPath, revision: manifest.revision };
}

function verifyProjectSelection({ directory, expectedHutch, expectedCottontail }) {
	const selectedHutch = singleLine(
		run("hutch", ["--version"], directory),
		`${directory} Hutch version`,
	);
	assertEqual(selectedHutch, expectedHutch, `${directory} selected Hutch`);

	const probeOutput = run("hutch", [runtimeProbePath], directory);
	const marker = "ELECTROBUN_RUNTIME_PROVENANCE=";
	const probeLine = probeOutput
		.split(/\r?\n/)
		.find((line) => line.startsWith(marker));
	if (!probeLine) fail(`${directory} runtime probe did not report provenance`);

	let provenance;
	try {
		provenance = JSON.parse(probeLine.slice(marker.length));
	} catch (error) {
		fail(`${directory} runtime probe returned invalid JSON: ${error.message}`);
	}
	assertEqual(
		provenance.cottontail,
		expectedCottontail,
		`${directory} selected Cottontail`,
	);

	console.log(
		`${directory}: Hutch ${selectedHutch}, Cottontail ${provenance.cottontail}`,
	);
}

export function verifyReleaseToolchain(environment = process.env) {
	const expectedHutch = environment.EXPECTED_HUTCH_VERSION;
	const expectedCottontail = environment.EXPECTED_COTTONTAIL_VERSION;
	const expectedAppCottontail = environment.EXPECTED_APP_COTTONTAIL_VERSION;
	assertExactVersion(expectedHutch, "EXPECTED_HUTCH_VERSION");
	assertExactVersion(expectedCottontail, "EXPECTED_COTTONTAIL_VERSION");
	assertExactVersion(expectedAppCottontail, "EXPECTED_APP_COTTONTAIL_VERSION");
	const expectedHutchChannel = releaseChannel(expectedHutch, "EXPECTED_HUTCH_VERSION");
	const expectedCottontailChannel = releaseChannel(
		expectedCottontail,
		"EXPECTED_COTTONTAIL_VERSION",
	);
	if (environment.HUTCH_ACTIVE_CHANNEL !== undefined) {
		assertEqual(
			environment.HUTCH_ACTIVE_CHANNEL,
			expectedHutchChannel,
			"HUTCH_ACTIVE_CHANNEL",
		);
	}

	for (const name of forbiddenOverrides) {
		if (environment[name] !== undefined) {
			fail(`${name} must be unset for a release provenance check`);
		}
	}

	const projects = ["package", "kitchen", "docs"].map((name) => ({
		name,
		directory: join(repositoryRoot, name),
		config: join(repositoryRoot, name, "hutch.config.ts"),
	}));
	for (const project of projects) {
		if (!existsSync(project.config)) fail(`missing ${project.config}`);
		const pins = parseHutchPragma(
			readFileSync(project.config, "utf8"),
			`${project.name}/hutch.config.ts`,
		);
		assertEqual(pins.hutch, expectedHutch, `${project.name} Hutch pin`);
		assertEqual(
			pins.cottontail,
			expectedCottontail,
			`${project.name} Cottontail pin`,
		);
	}

	// The SDK's application runtime is an independent release component. Verify
	// both its source pin and the emitted devkit, without equating it to the
	// Cottontail that executes the build through Hutch's pragma.
	const appSourcePath = join(repositoryRoot, "package", "src", "shared", "cottontail-version.ts");
	const devkitPath = join(repositoryRoot, "package", "dist", "native-devkit.json");
	verifyAppCottontailVersion({
		source: readFileSync(appSourcePath, "utf8"),
		manifest: JSON.parse(readFileSync(devkitPath, "utf8")),
		expectedVersion: expectedAppCottontail,
	});
	console.log(`App Cottontail ${expectedAppCottontail}: ${appSourcePath} and ${devkitPath}`);

	// `hutch self update` advances the tested Hutch+Cottontail pair together;
	// there is no separate cottontail update. The no-selector cottontail
	// verbs report the launcher's paired release, which is the provenance
	// claim this gate exists to check.
	run("hutch", ["self", "update", expectedHutchChannel], repositoryRoot);
	assertEqual(
		singleLine(
			run("hutch", ["self", "version", expectedHutchChannel], repositoryRoot),
			`${expectedHutchChannel} Hutch version`,
		),
		expectedHutch,
		`${expectedHutchChannel} Hutch channel`,
	);
	const hutchExecutable = canonicalPath(
		run("hutch", ["self", "path", expectedHutchChannel], repositoryRoot),
		`${expectedHutchChannel} Hutch path`,
	);
	assertEqual(
		singleLine(run(hutchExecutable, ["--version"], repositoryRoot), "Hutch executable version"),
		expectedHutch,
		"Hutch executable",
	);
	assertEqual(
		singleLine(
			run(hutchExecutable, ["cottontail", "version"], repositoryRoot),
			"paired Cottontail version",
		),
		expectedCottontail,
		"paired Cottontail release",
	);
	const cottontailExecutable = canonicalPath(
		run(hutchExecutable, ["cottontail", "path"], repositoryRoot),
		"paired Cottontail path",
	);
	assertEqual(
		singleLine(
			cottontailVersion(cottontailExecutable, repositoryRoot),
			"Cottontail executable version",
		),
		expectedCottontail,
		"Cottontail executable",
	);

	const hutchMetadata = verifyReleaseMetadata({
		executable: hutchExecutable,
		product: "hutch",
		version: expectedHutch,
		channel: expectedHutchChannel,
	});
	const cottontailMetadata = verifyReleaseMetadata({
		executable: cottontailExecutable,
		product: "cottontail",
		version: expectedCottontail,
		channel: expectedCottontailChannel,
	});
	console.log(
		`Hutch ${expectedHutch}: ${hutchExecutable} (revision ${hutchMetadata.revision}, sha256 ${sha256(hutchExecutable)})`,
	);
	console.log(
		`Cottontail ${expectedCottontail}: ${cottontailExecutable} (revision ${cottontailMetadata.revision}, sha256 ${sha256(cottontailExecutable)})`,
	);

	for (const project of projects) {
		verifyProjectSelection({
			directory: project.directory,
			expectedHutch,
			expectedCottontail,
		});
	}

	console.log("Electrobun release toolchain provenance verified.");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
	try {
		verifyReleaseToolchain();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
