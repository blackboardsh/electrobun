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
	"HUTCH_ACTIVE_CHANNEL",
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

function assertStableVersion(value, label) {
	const parsed = parseStrictSemVer(value);
	if (!parsed || parsed.prerelease !== null) {
		fail(
			`${label} must be an exact stable SemVer 2.0.0 version, got ${JSON.stringify(value)}`,
		);
	}
	return value;
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
		hutch: assertStableVersion(match[1], `${label} Hutch pin`),
		cottontail: assertStableVersion(match[2], `${label} Cottontail pin`),
	};
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

function verifyReleaseMetadata({ executable, product, version }) {
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
	assertEqual(manifest.channel, "production", `${product} metadata channel`);
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
	assertStableVersion(expectedHutch, "EXPECTED_HUTCH_VERSION");
	assertStableVersion(expectedCottontail, "EXPECTED_COTTONTAIL_VERSION");

	for (const name of forbiddenOverrides) {
		if (environment[name] !== undefined) {
			fail(`${name} must be unset for a production provenance check`);
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

	// `hutch self update` advances the tested Hutch+Cottontail pair together;
	// there is no separate cottontail update. The no-selector cottontail
	// verbs report the launcher's paired release, which is the provenance
	// claim this gate exists to check.
	run("hutch", ["self", "update", "production"], repositoryRoot);
	assertEqual(
		singleLine(run("hutch", ["self", "version"], repositoryRoot), "production Hutch version"),
		expectedHutch,
		"production Hutch channel",
	);
	assertEqual(
		singleLine(
			run("hutch", ["cottontail", "version"], repositoryRoot),
			"paired Cottontail version",
		),
		expectedCottontail,
		"paired Cottontail release",
	);

	const hutchExecutable = canonicalPath(
		run("hutch", ["self", "path", "production"], repositoryRoot),
		"production Hutch path",
	);
	const cottontailExecutable = canonicalPath(
		run("hutch", ["cottontail", "path"], repositoryRoot),
		"paired Cottontail path",
	);
	assertEqual(
		singleLine(run(hutchExecutable, ["--version"], repositoryRoot), "Hutch executable version"),
		expectedHutch,
		"Hutch executable",
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
	});
	const cottontailMetadata = verifyReleaseMetadata({
		executable: cottontailExecutable,
		product: "cottontail",
		version: expectedCottontail,
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
