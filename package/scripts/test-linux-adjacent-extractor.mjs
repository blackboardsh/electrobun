#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
	console.log("Linux adjacent extractor integration: skipped on non-Linux host");
	process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(packageRoot, "src", "extractor");
const launcherRoot = join(packageRoot, "src", "launcher");
const zig = process.env.ELECTROBUN_ZIG ?? join(packageRoot, "vendors", "zig", "zig");
const zigZstd = join(packageRoot, "vendors", "zig-zstd", "zig-zstd");
const temporaryRoot = mkdtempSync(join(tmpdir(), "electrobun-extractor-e2e-"));

const embeddedMetadataMarker = "ELECTROBUN_METADATA_V1";
const embeddedArchiveMarker = "ELECTROBUN_ARCHIVE_V1";

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
		...options,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
			{ cause: result.error },
		);
	}
	return result;
};

const assertExists = (path, message = `${path} should exist`) => {
	assert.equal(existsSync(path), true, message);
};

const assertMissing = (path, message = `${path} should not exist`) => {
	assert.equal(existsSync(path), false, message);
};

const sha256 = (path) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");

const adjacentIdentifier = "com.example.extractor-integration";
const uninstallIdentifier = "com.example.embedded-uninstaller";
const uninstallAppName = "Embedded Archive App";
const home = join(temporaryRoot, "home directory with spaces");
const dataHome = join(temporaryRoot, "non-default XDG data home with spaces");
const cacheHome = join(temporaryRoot, "non-default XDG cache home with spaces");
const stateHome = join(temporaryRoot, "non-default XDG state home with spaces");
const desktopDir = join(home, "Desktop");
const applicationsDir = join(dataHome, "applications");
const helperDir = join(temporaryRoot, "desktop helper bin");
const emptyHelperDir = join(temporaryRoot, "empty helper bin");
const dialogHelperDir = join(temporaryRoot, "dialog helper bin");
const desktopDatabaseLog = join(temporaryRoot, "desktop database calls.log");
const dialogHelperLog = join(temporaryRoot, "dialog helper calls.log");

mkdirSync(desktopDir, { recursive: true });
mkdirSync(dataHome, { recursive: true });
mkdirSync(cacheHome, { recursive: true });
mkdirSync(stateHome, { recursive: true });
mkdirSync(helperDir, { recursive: true });
mkdirSync(emptyHelperDir, { recursive: true });
mkdirSync(dialogHelperDir, { recursive: true });
writeFileSync(desktopDatabaseLog, "");
writeFileSync(dialogHelperLog, "");

const desktopDatabaseHelper = join(helperDir, "update-desktop-database");
writeFileSync(
	desktopDatabaseHelper,
	'#!/bin/sh\nprintf "%s\\n" "$@" >> "$ELECTROBUN_DESKTOP_DB_LOG"\n',
);
chmodSync(desktopDatabaseHelper, 0o755);

const writeDialogHelper = (name) => {
	const helper = join(dialogHelperDir, name);
	writeFileSync(
		helper,
		name === "zenity"
			? [
					"#!/bin/sh",
					'printf "zenity\\n" >> "$ELECTROBUN_DIALOG_LOG"',
					'case "$ELECTROBUN_DIALOG_RESPONSE" in',
					"  app) exit 0 ;;",
					"  data) printf 'App and Data\\n'; exit 1 ;;",
					"  cancel) exit 1 ;;",
					"  *) printf 'simulated zenity failure\\n' >&2; exit 5 ;;",
					"esac",
					"",
				].join("\n")
			: [
					"#!/bin/sh",
					'printf "kdialog\\n" >> "$ELECTROBUN_DIALOG_LOG"',
					'case "$ELECTROBUN_DIALOG_RESPONSE" in',
					"  app) exit 0 ;;",
					"  data) exit 1 ;;",
					"  cancel) exit 2 ;;",
					"  *) printf 'simulated kdialog failure\\n' >&2; exit 5 ;;",
					"esac",
					"",
				].join("\n"),
	);
	chmodSync(helper, 0o755);
};
writeDialogHelper("zenity");
writeDialogHelper("kdialog");
copyFileSync(desktopDatabaseHelper, join(dialogHelperDir, "update-desktop-database"));
chmodSync(join(dialogHelperDir, "update-desktop-database"), 0o755);

const defaultRoots = {
	home,
	dataHome,
	cacheHome,
	stateHome,
};

const makeRoots = (label, { desktop = true } = {}) => {
	const root = join(temporaryRoot, `${label} roots`);
	const roots = {
		home: join(root, "home with spaces"),
		dataHome: join(root, "data home with spaces"),
		cacheHome: join(root, "cache home with spaces"),
		stateHome: join(root, "state home with spaces"),
	};
	mkdirSync(roots.home, { recursive: true });
	if (desktop) mkdirSync(join(roots.home, "Desktop"), { recursive: true });
	for (const path of [roots.dataHome, roots.cacheHome, roots.stateHome]) {
		mkdirSync(path, { recursive: true });
	}
	return roots;
};

const environmentFor = (
	roots,
	path,
	{
		dialogResponse,
		gui = true,
		includeXdg = true,
		xdgCacheHome = roots.cacheHome,
		xdgDataHome = roots.dataHome,
		xdgStateHome = roots.stateHome,
	} = {},
) => {
	const environment = {
		...process.env,
		ELECTROBUN_DESKTOP_DB_LOG: desktopDatabaseLog,
		ELECTROBUN_DIALOG_LOG: dialogHelperLog,
		HOME: roots.home,
		PATH: path,
	};
	if (includeXdg) {
		environment.XDG_CACHE_HOME = xdgCacheHome;
		environment.XDG_DATA_HOME = xdgDataHome;
		environment.XDG_STATE_HOME = xdgStateHome;
	} else {
		delete environment.XDG_CACHE_HOME;
		delete environment.XDG_DATA_HOME;
		delete environment.XDG_STATE_HOME;
	}
	if (gui) {
		environment.DISPLAY = process.env.DISPLAY || ":99";
		environment.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || "wayland-test";
	} else {
		delete environment.DISPLAY;
		delete environment.WAYLAND_DISPLAY;
	}
	if (dialogResponse !== undefined) {
		environment.ELECTROBUN_DIALOG_RESPONSE = dialogResponse;
	} else {
		delete environment.ELECTROBUN_DIALOG_RESPONSE;
	}
	return environment;
};

const installerEnv = (path, options) =>
	environmentFor(defaultRoots, path, options);

const createPayload = ({
	artifact,
	bundleArtifact = artifact,
	channel,
	extractor,
	fixtureRoot,
	icon,
	identifier,
	includeManager = true,
	launcher,
	name,
	version,
}) => {
	const innerRoot = join(fixtureRoot, "inner", bundleArtifact);
	const innerBin = join(innerRoot, "bin");
	const innerResources = join(innerRoot, "Resources");
	mkdirSync(innerBin, { recursive: true });
	mkdirSync(innerResources, { recursive: true });

	const installedLauncher = join(innerBin, "launcher");
	copyFileSync(launcher, installedLauncher);
	chmodSync(installedLauncher, 0o755);
	const runtime = join(innerBin, "cottontail");
	writeFileSync(
		runtime,
		'#!/bin/sh\nprintf "runtime loaded\\n" > "$ELECTROBUN_RUNTIME_LOG"\nexit 0\n',
	);
	chmodSync(runtime, 0o755);
	if (includeManager) {
		copyFileSync(extractor, join(innerResources, "uninstall"));
		chmodSync(join(innerResources, "uninstall"), 0o755);
	}

	writeFileSync(
		join(innerRoot, `${artifact}.desktop`),
		[
			"[Desktop Entry]",
			"Version=1.0",
			"Type=Application",
			`Name=${name}${channel === "canary" ? " (Canary)" : ""}`,
			"Comment=Extractor integration fixture",
			"Exec=launcher",
			...(icon ? ["Icon=appIcon"] : []),
			"Terminal=false",
			`StartupWMClass=${artifact}`,
			"Categories=Utility;",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(innerResources, "version.json"),
		JSON.stringify({ channel, identifier, name, version }),
	);
	writeFileSync(
		join(innerResources, "build.json"),
		JSON.stringify({ mainProcess: "cottontail" }),
	);
	writeFileSync(join(innerResources, "main.js"), "// runtime sentinel fixture\n");
	writeFileSync(join(innerResources, "payload-version.txt"), `${version}\n`);
	if (icon) {
		writeFileSync(join(innerResources, "appIcon.png"), "fixture-icon");
	}

	const tarPath = join(fixtureRoot, `${channel}-${version}.tar`);
	const hash = `${channel}-${version.replaceAll(".", "-")}-hash`;
	const archivePath = join(fixtureRoot, `${hash}.tar.zst`);
	run("tar", [
		"-cf",
		tarPath,
		"-C",
		join(fixtureRoot, "inner"),
		bundleArtifact,
	]);
	run(zigZstd, [
		"compress",
		"-i",
		tarPath,
		"-o",
		archivePath,
		"--no-timing",
	]);

	return {
		archivePath,
		metadata: { channel, hash, identifier, name },
	};
};

const createAdjacentFixture = (extractor, launcherBinary, fixture) => {
	const fixtureRoot = join(
		temporaryRoot,
		`adjacent fixture ${fixture.channel}`,
	);
	const payload = createPayload({
		...fixture,
		extractor,
		fixtureRoot,
		identifier: adjacentIdentifier,
		launcher: launcherBinary,
		name: "Archive App",
	});
	const outerRoot = join(fixtureRoot, "outer", fixture.artifact);
	const outerBin = join(outerRoot, "bin");
	const outerResources = join(outerRoot, "Resources");
	mkdirSync(outerBin, { recursive: true });
	mkdirSync(outerResources, { recursive: true });
	copyFileSync(
		payload.archivePath,
		join(outerResources, `${payload.metadata.hash}.tar.zst`),
	);
	writeFileSync(
		join(outerResources, "metadata.json"),
		JSON.stringify(payload.metadata),
	);
	const launcher = join(outerBin, "launcher");
	copyFileSync(extractor, launcher);
	chmodSync(launcher, 0o755);
	return launcher;
};

const createEmbeddedSetupFixture = (extractor, launcherBinary, fixture) => {
	const fixtureRoot = join(
		temporaryRoot,
		`embedded Setup fixture ${fixture.channel} ${fixture.version}`,
	);
	const payload = createPayload({
		...fixture,
		bundleArtifact:
			fixture.channel === "stable"
				? "EmbeddedArchiveApp"
				: `EmbeddedArchiveApp-${fixture.channel}`,
		extractor,
		fixtureRoot,
		identifier: uninstallIdentifier,
		launcher: launcherBinary,
		name: uninstallAppName,
	});
	const setupName =
		fixture.channel === "stable"
			? `${uninstallAppName}-Setup`
			: `${uninstallAppName}-Setup-${fixture.channel}`;
	const setup = join(fixtureRoot, setupName);
	writeFileSync(
		setup,
		Buffer.concat([
			readFileSync(extractor),
			...(fixture.includeDecoyMarkers
				? [
						Buffer.from(embeddedMetadataMarker),
						Buffer.from("not embedded metadata"),
						Buffer.from(embeddedArchiveMarker),
					]
				: []),
			Buffer.from(embeddedMetadataMarker),
			Buffer.from(JSON.stringify(payload.metadata)),
			Buffer.from(embeddedArchiveMarker),
			readFileSync(payload.archivePath),
		]),
	);
	chmodSync(setup, 0o755);
	return setup;
};

const createEmbeddedSetupWithoutManager = (extractor, launcherBinary, fixture) => {
	return createEmbeddedSetupFixture(extractor, launcherBinary, {
		...fixture,
		includeManager: false,
	});
};

const installPaths = (
	identifier,
	channel,
	artifact,
	roots = defaultRoots,
) => {
	const channelRoot = join(roots.dataHome, identifier, channel);
	return {
		app: join(channelRoot, "app"),
		applicationEntry: join(
			roots.dataHome,
			"applications",
			`${artifact}.desktop`,
		),
		channelRoot,
		desktopEntry: join(roots.home, "Desktop", `${artifact}.desktop`),
		launcher: join(channelRoot, "app", "bin", "launcher"),
		manifest: join(channelRoot, ".electrobun-uninstall.json"),
		selfExtraction: join(channelRoot, "self-extraction"),
		uninstaller: join(channelRoot, "uninstall"),
	};
};

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"));

const assertInstalled = ({
	artifact,
	channel,
	desktopEntry = true,
	icon,
	identifier,
	name,
	paths,
	roots = defaultRoots,
	version,
}) => {
	assertExists(paths.app);
	assertExists(paths.launcher);
	assertExists(paths.selfExtraction);
	assertExists(paths.uninstaller);
	assertExists(paths.manifest);
	assertExists(paths.applicationEntry);
	const bundledUninstaller = join(paths.app, "Resources", "uninstall");
	assertExists(bundledUninstaller);
	assert.equal(sha256(paths.uninstaller), sha256(bundledUninstaller));
	assert.equal(
		readFileSync(
			join(paths.app, "Resources", "payload-version.txt"),
			"utf8",
		).trim(),
		version,
	);

	const applicationContents = readFileSync(paths.applicationEntry, "utf8");
	assert.equal(applicationContents.includes(`Exec="${paths.launcher}"`), true);
	assert.equal(
		applicationContents.includes(`StartupWMClass=${artifact}`),
		true,
	);
	if (icon) {
		const iconPath = join(paths.app, "Resources", "appIcon.png");
		assertExists(iconPath);
		assert.equal(applicationContents.includes(`Icon=${iconPath}`), true);
	} else {
		assert.doesNotMatch(applicationContents, /^Icon=/m);
	}

	if (desktopEntry) {
		assertExists(paths.desktopEntry);
		assert.equal(
			readFileSync(paths.desktopEntry, "utf8").includes(
				`Exec="${paths.launcher}"`,
			),
			true,
		);
	} else {
		assertMissing(paths.desktopEntry);
	}

	const manifest = readManifest(paths.manifest);
	assert.equal(manifest.schema_version, 2);
	assert.equal(manifest.identifier, identifier);
	assert.equal(manifest.name, name);
	assert.equal(manifest.channel, channel);
	assert.equal(manifest.version, version);
	assert.equal(manifest.application_entry, paths.applicationEntry);
	assert.equal(
		manifest.desktop_entry,
		desktopEntry ? paths.desktopEntry : "",
	);
	assert.match(manifest.application_entry_sha256, /^[0-9a-f]{64}$/);
	if (desktopEntry) {
		assert.match(manifest.desktop_entry_sha256, /^[0-9a-f]{64}$/);
	} else {
		assert.equal(manifest.desktop_entry_sha256, "");
	}
	assert.deepEqual(manifest.data_path_versions, [1]);
	assert.equal(manifest.home, roots.home);
	assert.equal(manifest.xdg_cache_home, roots.cacheHome);
	assert.equal(manifest.xdg_state_home, roots.stateHome);
	assert.equal(lstatSync(paths.uninstaller).mode & 0o777, 0o755);

	const validation = spawnSync("desktop-file-validate", [paths.applicationEntry], {
		encoding: "utf8",
	});
	if (!validation.error) {
		assert.equal(
			validation.status,
			0,
			validation.stderr || validation.stdout,
		);
	}
};

const assertManagedArtifactsRemoved = (paths, { preservedDesktop = false } = {}) => {
	assertMissing(paths.app);
	assertMissing(paths.selfExtraction);
	assertMissing(paths.applicationEntry);
	if (!preservedDesktop) assertMissing(paths.desktopEntry);
	assertMissing(paths.uninstaller);
	assertMissing(paths.manifest);
};

const assertUninstallNotStarted = (paths) => {
	for (const path of [
		paths.app,
		paths.selfExtraction,
		paths.uninstaller,
		paths.manifest,
		paths.applicationEntry,
	]) {
		assertExists(path);
	}
};

const runExpectingFailure = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `${command} was terminated by ${result.signal}`);
	assert.notEqual(result.status, 0, `${command} ${args.join(" ")} succeeded`);
	return result;
};

const writeSentinel = (path, contents = "sentinel\n") => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
};

try {
	const zigBuildOptions = { timeout: 120_000 };
	run(zig, ["build", "test"], {
		cwd: extractorRoot,
		...zigBuildOptions,
	});
	run(zig, ["build"], { cwd: extractorRoot, ...zigBuildOptions });
	const extractor = join(extractorRoot, "zig-out", "bin", "extractor");
	assertExists(extractor, "extractor build output is missing");
	run(zig, ["build", "test"], {
		cwd: launcherRoot,
		...zigBuildOptions,
	});
	run(zig, ["build"], { cwd: launcherRoot, ...zigBuildOptions });
	const launcherBinary = join(launcherRoot, "zig-out", "bin", "launcher");
	assertExists(launcherBinary, "launcher build output is missing");

	// A malformed self-extracting bundle that omits the thin manager must fail
	// before creating or replacing any desktop integration.
	const missingManagerRoots = makeRoots("missing manager resource");
	const missingManagerFixture = {
		artifact: "MissingManagerApp",
		channel: "missing-manager",
		icon: false,
		version: "1.0.0",
	};
	const missingManagerSetup = createEmbeddedSetupWithoutManager(
		extractor,
		launcherBinary,
		missingManagerFixture,
	);
	const missingManagerPaths = installPaths(
		uninstallIdentifier,
		missingManagerFixture.channel,
		missingManagerFixture.artifact,
		missingManagerRoots,
	);
	runExpectingFailure(missingManagerSetup, [], {
		cwd: temporaryRoot,
		env: environmentFor(missingManagerRoots, emptyHelperDir),
	});
	assertMissing(missingManagerPaths.uninstaller);
	assertMissing(missingManagerPaths.manifest);
	assertMissing(missingManagerPaths.applicationEntry);
	assertMissing(missingManagerPaths.desktopEntry);

	const installScenario = ({
		artifact,
		channel,
		desktopEntry = true,
		environmentOptions,
		icon = false,
		roots,
		version = "1.0.0",
	}) => {
		const fixture = { artifact, channel, icon, version };
		const setup = createEmbeddedSetupFixture(
			extractor,
			launcherBinary,
			fixture,
		);
		run(setup, [], {
			cwd: temporaryRoot,
			env: environmentFor(
				roots,
				emptyHelperDir,
				environmentOptions,
			),
		});
		const paths = installPaths(
			uninstallIdentifier,
			channel,
			artifact,
			roots,
		);
		assertInstalled({
			...fixture,
			desktopEntry,
			identifier: uninstallIdentifier,
			name: uninstallAppName,
			paths,
			roots,
		});
		assert.equal(sha256(paths.uninstaller), sha256(extractor));
		assert.notEqual(sha256(paths.uninstaller), sha256(setup));
		return { fixture, paths, setup };
	};

	// Unsafe integration roots are skipped at install time so a Desktop or
	// applications symlink can neither redirect writes nor make uninstall fail.
	const integrationLinkRoots = makeRoots("symlinked integration roots");
	const outsideDesktop = join(temporaryRoot, "outside Desktop integration");
	const outsideApplications = join(
		temporaryRoot,
		"outside applications integration",
	);
	rmSync(join(integrationLinkRoots.home, "Desktop"), { recursive: true });
	mkdirSync(outsideDesktop);
	mkdirSync(outsideApplications);
	writeSentinel(join(outsideDesktop, "outside.keep"));
	writeSentinel(join(outsideApplications, "outside.keep"));
	symlinkSync(outsideDesktop, join(integrationLinkRoots.home, "Desktop"));
	symlinkSync(
		outsideApplications,
		join(integrationLinkRoots.dataHome, "applications"),
	);
	const integrationLinkFixture = {
		artifact: "IntegrationSymlinkApp",
		channel: "integration-symlink",
		icon: false,
		// Debug Linux binaries can contain more than one copy of each marker.
		// Keep this fixture independent of compiler layout by adding a decoy pair.
		includeDecoyMarkers: true,
		version: "1.0.0",
	};
	const integrationLinkSetup = createEmbeddedSetupFixture(
		extractor,
		launcherBinary,
		integrationLinkFixture,
	);
	run(integrationLinkSetup, [], {
		cwd: temporaryRoot,
		env: environmentFor(integrationLinkRoots, emptyHelperDir),
	});
	const integrationLinkPaths = installPaths(
		uninstallIdentifier,
		integrationLinkFixture.channel,
		integrationLinkFixture.artifact,
		integrationLinkRoots,
	);
	const integrationLinkManifest = readManifest(integrationLinkPaths.manifest);
	assert.equal(integrationLinkManifest.application_entry, "");
	assert.equal(integrationLinkManifest.desktop_entry, "");
	assertExists(join(outsideDesktop, "outside.keep"));
	assertExists(join(outsideApplications, "outside.keep"));
	run(integrationLinkPaths.uninstaller, ["--quiet"], {
		env: environmentFor(integrationLinkRoots, emptyHelperDir),
	});
	assertMissing(integrationLinkPaths.app);
	assertMissing(integrationLinkPaths.uninstaller);
	assertExists(join(outsideDesktop, "outside.keep"));
	assertExists(join(outsideApplications, "outside.keep"));

	// Preserve coverage for the adjacent Resources/metadata.json distribution.
	const adjacentFixtures = [
		{
			artifact: "ArchiveApp",
			channel: "stable",
			icon: true,
			version: "1.0.0",
		},
		{
			artifact: "ArchiveApp-canary",
			channel: "canary",
			icon: false,
			version: "1.0.0-canary.1",
		},
	];
	const adjacentPaths = new Map();
	for (const fixture of adjacentFixtures) {
		const adjacentInstaller = createAdjacentFixture(
			extractor,
			launcherBinary,
			fixture,
		);
		run(adjacentInstaller, [], {
			cwd: temporaryRoot,
			env: installerEnv(emptyHelperDir),
		});
		const paths = installPaths(
			adjacentIdentifier,
			fixture.channel,
			fixture.artifact,
		);
		adjacentPaths.set(fixture.channel, paths);
		assertInstalled({
			...fixture,
			identifier: adjacentIdentifier,
			name: "Archive App",
			paths,
		});
		const runtimeLog = join(home, `${fixture.artifact}-launched`);
		run(paths.launcher, [], {
			env: {
				...installerEnv(emptyHelperDir),
				ELECTROBUN_RUNTIME_LOG: runtimeLog,
			},
		});
		assert.equal(
			readFileSync(runtimeLog, "utf8").trim(),
			"runtime loaded",
		);
	}

	// A fresh install must not claim or overwrite same-named desktop integration
	// files that already belong to the user or another package.
	const collisionFixture = {
		artifact: "ArchiveApp-collision",
		channel: "collision",
		icon: false,
		version: "1.0.0",
	};
	const collisionPaths = installPaths(
		adjacentIdentifier,
		collisionFixture.channel,
		collisionFixture.artifact,
	);
	const preexistingApplicationContents =
		"[Desktop Entry]\nName=User-owned menu entry\nExec=/usr/bin/true\n";
	const preexistingDesktopContents =
		"[Desktop Entry]\nName=User-owned Desktop entry\nExec=/usr/bin/false\n";
	writeFileSync(collisionPaths.applicationEntry, preexistingApplicationContents);
	writeFileSync(collisionPaths.desktopEntry, preexistingDesktopContents);
	const collisionLauncher = createAdjacentFixture(
		extractor,
		launcherBinary,
		collisionFixture,
	);
	run(collisionLauncher, [], {
		cwd: temporaryRoot,
		env: installerEnv(emptyHelperDir),
	});
	assertExists(collisionPaths.app);
	assertExists(collisionPaths.selfExtraction);
	assertExists(collisionPaths.uninstaller);
	assert.equal(
		readFileSync(collisionPaths.applicationEntry, "utf8"),
		preexistingApplicationContents,
	);
	assert.equal(
		readFileSync(collisionPaths.desktopEntry, "utf8"),
		preexistingDesktopContents,
	);
	const collisionManifest = readManifest(collisionPaths.manifest);
	assert.equal(collisionManifest.application_entry, "");
	assert.equal(collisionManifest.application_entry_sha256, "");
	assert.equal(collisionManifest.desktop_entry, "");
	assert.equal(collisionManifest.desktop_entry_sha256, "");
	run(collisionPaths.uninstaller, ["--uninstall", "--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertMissing(collisionPaths.app);
	assertMissing(collisionPaths.selfExtraction);
	assertMissing(collisionPaths.uninstaller);
	assertMissing(collisionPaths.manifest);
	assertMissing(collisionPaths.channelRoot);
	assert.equal(
		readFileSync(collisionPaths.applicationEntry, "utf8"),
		preexistingApplicationContents,
	);
	assert.equal(
		readFileSync(collisionPaths.desktopEntry, "utf8"),
		preexistingDesktopContents,
	);

	// Remove one pristine Desktop shortcut before any test deletes the Desktop
	// directory itself. This distinguishes Electrobun cleanup from a false pass
	// caused by the later missing-Desktop scenario.
	const adjacentStablePaths = adjacentPaths.get("stable");
	const adjacentCanaryPaths = adjacentPaths.get("canary");
	run(adjacentStablePaths.uninstaller, ["--uninstall", "--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertManagedArtifactsRemoved(adjacentStablePaths);
	assertMissing(adjacentStablePaths.channelRoot);
	assertExists(adjacentCanaryPaths.channelRoot);
	assertExists(adjacentCanaryPaths.desktopEntry);

	// Build real self-contained Setup executables, including the exact embedded
	// metadata/archive markers used by shipped Electrobun Linux installers.
	const stableV1 = {
		artifact: "EmbeddedArchiveApp",
		channel: "stable",
		icon: true,
		version: "2.3.4",
	};
	const stableV2 = { ...stableV1, version: "2.4.0" };
	const canaryV1 = {
		artifact: "EmbeddedArchiveApp-canary",
		channel: "canary",
		icon: false,
		version: "2.4.0-canary.3",
	};
	const stableSetupV1 = createEmbeddedSetupFixture(
		extractor,
		launcherBinary,
		stableV1,
	);
	const stableSetupV2 = createEmbeddedSetupFixture(
		extractor,
		launcherBinary,
		stableV2,
	);
	const canarySetupV1 = createEmbeddedSetupFixture(
		extractor,
		launcherBinary,
		canaryV1,
	);

	// Shipped archives instruct users to launch `./installer`; keep relative
	// Setup invocation working while installed managers require absolute paths.
	run(`./${basename(stableSetupV1)}`, [], {
		cwd: dirname(stableSetupV1),
		env: installerEnv(helperDir),
	});
	run(canarySetupV1, [], {
		cwd: temporaryRoot,
		env: installerEnv(helperDir),
	});

	const stablePaths = installPaths(
		uninstallIdentifier,
		stableV1.channel,
		stableV1.artifact,
	);
	const canaryPaths = installPaths(
		uninstallIdentifier,
		canaryV1.channel,
		canaryV1.artifact,
	);
	assertInstalled({
		...stableV1,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: stablePaths,
	});
	assertInstalled({
		...canaryV1,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: canaryPaths,
	});

	const stableSentinel = join(
		stablePaths.channelRoot,
		"user data",
		"keep me.txt",
	);
	const canarySentinel = join(
		canaryPaths.channelRoot,
		"user data",
		"keep me too.txt",
	);
	const unknownChannelFile = join(
		stablePaths.channelRoot,
		"unknown file.keep",
	);
	const cacheSentinel = join(
		cacheHome,
		uninstallIdentifier,
		"stable",
		"cache.keep",
	);
	const logSentinel = join(
		stateHome,
		uninstallIdentifier,
		"stable",
		"application.log",
	);
	const userDocument = join(home, "Documents", "user document.txt");
	const unrelatedApplicationEntry = join(
		applicationsDir,
		"unrelated-user-entry.desktop",
	);
	const unrelatedDesktopEntry = join(desktopDir, "unrelated-user-entry.desktop");
	const mimePreferences = join(applicationsDir, "mimeapps.list");
	mkdirSync(dirname(stableSentinel), { recursive: true });
	mkdirSync(dirname(canarySentinel), { recursive: true });
	mkdirSync(dirname(cacheSentinel), { recursive: true });
	mkdirSync(dirname(logSentinel), { recursive: true });
	mkdirSync(dirname(userDocument), { recursive: true });
	writeFileSync(stableSentinel, "stable application data\n");
	writeFileSync(canarySentinel, "canary application data\n");
	writeFileSync(unknownChannelFile, "unknown channel state\n");
	writeFileSync(cacheSentinel, "application cache\n");
	writeFileSync(logSentinel, "application log\n");
	writeFileSync(userDocument, "user document\n");
	writeFileSync(unrelatedApplicationEntry, "unrelated application entry\n");
	writeFileSync(unrelatedDesktopEntry, "unrelated Desktop entry\n");
	writeFileSync(mimePreferences, "[Default Applications]\ntext/plain=user.desktop\n");

	// A reinstall replaces the managed app/update state and leaves exactly one
	// current, runnable channel-root uninstaller without touching user data.
	run(stableSetupV2, [], {
		cwd: temporaryRoot,
		env: installerEnv(helperDir),
	});
	assertExists(stableSentinel);
	assertInstalled({
		...stableV2,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: stablePaths,
	});
	assert.deepEqual(
		readdirSync(stablePaths.channelRoot).filter((entry) =>
			entry.startsWith("uninstall"),
		),
		["uninstall"],
	);
	assert.equal(sha256(stablePaths.uninstaller), sha256(extractor));
	assert.notEqual(sha256(stablePaths.uninstaller), sha256(stableSetupV2));
	assert.ok(
		lstatSync(stablePaths.uninstaller).size <
			lstatSync(stableSetupV2).size,
		"the external manager must be the thin resource, not archive-bearing Setup",
	);

	// Exercise the updater-facing refresh command and prove it repairs stale
	// name/version metadata from the newly installed app.
	const staleManifest = readManifest(stablePaths.manifest);
	const installedDesktopSource = join(
		stablePaths.app,
		`${stableV2.artifact}.desktop`,
	);
	writeFileSync(
		installedDesktopSource,
		readFileSync(installedDesktopSource, "utf8").replace(
			`Name=${uninstallAppName}`,
			"Name=Renamed Embedded Archive App",
		),
	);
	writeFileSync(
		stablePaths.manifest,
		JSON.stringify({
			...staleManifest,
			name: "Stale App Name",
			version: "stale-version",
		}),
	);
	run(
		stablePaths.uninstaller,
		["--refresh-metadata", "--quiet"],
		{ env: installerEnv(emptyHelperDir) },
	);
	const refreshedManifest = readManifest(stablePaths.manifest);
	assert.equal(refreshedManifest.version, stableV2.version);
	assert.equal(refreshedManifest.name, "Renamed Embedded Archive App");
	assert.deepEqual(refreshedManifest.data_path_versions, [1]);
	assert.equal(refreshedManifest.home, staleManifest.home);
	assert.equal(refreshedManifest.xdg_cache_home, staleManifest.xdg_cache_home);
	assert.equal(refreshedManifest.xdg_state_home, staleManifest.xdg_state_home);

	// Interactive uninstall removes only Electrobun-owned state, refreshes the
	// desktop database, preserves a user-edited Desktop entry, and leaves the
	// canary installation and user data alone.
	const editedDesktopContents = `${readFileSync(stablePaths.desktopEntry, "utf8")}# user customization\n`;
	writeFileSync(stablePaths.desktopEntry, editedDesktopContents);
	writeFileSync(desktopDatabaseLog, "");
	writeFileSync(dialogHelperLog, "");
	const interactiveUninstall = run(stablePaths.uninstaller, ["--uninstall"], {
		env: installerEnv(dialogHelperDir, { dialogResponse: "app" }),
	});
	assert.equal(interactiveUninstall.status, 0);
	assert.deepEqual(
		readFileSync(dialogHelperLog, "utf8").trim().split("\n"),
		["zenity"],
	);
	assertManagedArtifactsRemoved(stablePaths, { preservedDesktop: true });
	assert.equal(
		readFileSync(stablePaths.desktopEntry, "utf8"),
		editedDesktopContents,
	);
	assertExists(stableSentinel);
	assert.equal(
		readFileSync(stableSentinel, "utf8"),
		"stable application data\n",
	);
	assertExists(unknownChannelFile);
	assertExists(cacheSentinel);
	assertExists(logSentinel);
	assertExists(userDocument);
	assertExists(unrelatedApplicationEntry);
	assertExists(unrelatedDesktopEntry);
	assertExists(mimePreferences);
	assertExists(canaryPaths.app);
	assertExists(canaryPaths.selfExtraction);
	assertExists(canaryPaths.uninstaller);
	assertExists(canaryPaths.manifest);
	assertExists(canaryPaths.applicationEntry);
	assertExists(canaryPaths.desktopEntry);
	assert.deepEqual(
		readFileSync(desktopDatabaseLog, "utf8")
			.split("\n")
			.filter(Boolean),
		[applicationsDir],
		"uninstall should refresh the XDG applications desktop database",
	);

	// Reinstall the same channel after uninstalling it, this time with neither a
	// Desktop directory nor desktop integration helpers available.
	rmSync(desktopDir, { recursive: true, force: true });
	run(stableSetupV2, [], {
		cwd: temporaryRoot,
		env: installerEnv(emptyHelperDir),
	});
	assertExists(stableSentinel);
	assertInstalled({
		...stableV2,
		desktopEntry: false,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: stablePaths,
	});

	// Quiet uninstall is tolerant of already-missing managed files and a missing
	// Desktop directory. It still must not disturb the other channel.
	rmSync(canaryPaths.selfExtraction, { recursive: true, force: true });
	rmSync(canaryPaths.applicationEntry, { force: true });
	const quietCanaryUninstall = run(
		canaryPaths.uninstaller,
		["--uninstall", "--quiet"],
		{
			env: installerEnv(emptyHelperDir),
		},
	);
	assert.equal(quietCanaryUninstall.stdout, "");
	assert.equal(quietCanaryUninstall.stderr, "");
	assertManagedArtifactsRemoved(canaryPaths);
	assertExists(canarySentinel);
	assert.equal(
		readFileSync(canarySentinel, "utf8"),
		"canary application data\n",
	);
	assertExists(stablePaths.app);
	assertExists(stablePaths.selfExtraction);
	assertExists(stablePaths.uninstaller);
	assertExists(stablePaths.manifest);
	assertExists(stablePaths.applicationEntry);

	// A repeated install/uninstall cycle also succeeds when every managed child
	// except the installed uninstaller and manifest has already disappeared.
	rmSync(stablePaths.app, { recursive: true, force: true });
	rmSync(stablePaths.selfExtraction, { recursive: true, force: true });
	rmSync(stablePaths.applicationEntry, { force: true });
	run(stablePaths.uninstaller, ["--uninstall", "--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertManagedArtifactsRemoved(stablePaths);
	assertExists(stableSentinel);
	assert.equal(
		readFileSync(stableSentinel, "utf8"),
		"stable application data\n",
	);
	assert.equal(readFileSync(unknownChannelFile, "utf8"), "unknown channel state\n");
	assert.equal(readFileSync(cacheSentinel, "utf8"), "application cache\n");
	assert.equal(readFileSync(logSentinel, "utf8"), "application log\n");
	assert.equal(readFileSync(userDocument, "utf8"), "user document\n");
	assert.equal(
		readFileSync(unrelatedApplicationEntry, "utf8"),
		"unrelated application entry\n",
	);
	assert.equal(
		readFileSync(mimePreferences, "utf8"),
		"[Default Applications]\ntext/plain=user.desktop\n",
	);
	assertExists(stablePaths.channelRoot);
	assertExists(canaryPaths.channelRoot);

	// Invalid, duplicated, incomplete, and reordered manager arguments must be
	// rejected before UI or filesystem mutation. The same fixture then proves
	// that graphical-helper failure and a headless/non-TTY invocation are also
	// non-mutating, while quiet success never launches a dialog.
	const guardRoots = makeRoots("strict argv and UI guard");
	const priorUmask = process.umask(0o077);
	let guard;
	try {
		guard = installScenario({
			artifact: "StrictArgvApp",
			channel: "strict-argv",
			environmentOptions: {
				xdgCacheHome: `${guardRoots.cacheHome}/./`,
				xdgDataHome: `${guardRoots.dataHome}/`,
				xdgStateHome: `${guardRoots.stateHome}/nested/../`,
			},
			roots: guardRoots,
		});
	} finally {
		process.umask(priorUmask);
	}
	const guardManifestBefore = readFileSync(guard.paths.manifest, "utf8");
	const guardApplicationBefore = readFileSync(
		guard.paths.applicationEntry,
		"utf8",
	);
	const invalidManagerArguments = [
		["--delete-data"],
		["--uninstall", "--delete-data"],
		["--uninstall", "--delete-data", "--quiet"],
		["--quiet", "--uninstall"],
		["--quiet", "--quiet"],
		["--uninstall", "--quiet", "--quiet"],
		["--uninstall", "--quiet", "--delete-data", "extra"],
		["--refresh-metadata"],
		["--refresh-metadata", "--quiet", "extra"],
		["--unknown"],
	];
	for (const args of invalidManagerArguments) {
		writeFileSync(dialogHelperLog, "");
		runExpectingFailure(guard.paths.uninstaller, args, {
			env: environmentFor(guardRoots, dialogHelperDir, {
				dialogResponse: "app",
			}),
		});
		assertUninstallNotStarted(guard.paths);
		assert.equal(readFileSync(guard.paths.manifest, "utf8"), guardManifestBefore);
		assert.equal(
			readFileSync(guard.paths.applicationEntry, "utf8"),
			guardApplicationBefore,
		);
		assert.equal(readFileSync(dialogHelperLog, "utf8"), "");
	}

	writeFileSync(dialogHelperLog, "");
	runExpectingFailure(guard.paths.uninstaller, [], {
		env: environmentFor(guardRoots, dialogHelperDir, {
			dialogResponse: "fail",
		}),
	});
	assertUninstallNotStarted(guard.paths);
	assert.deepEqual(
		readFileSync(dialogHelperLog, "utf8").trim().split("\n"),
		["zenity", "kdialog"],
	);

	writeFileSync(dialogHelperLog, "");
	const headlessFailure = runExpectingFailure(
		guard.paths.uninstaller,
		["--uninstall"],
		{
			env: environmentFor(guardRoots, dialogHelperDir, {
				dialogResponse: "app",
				gui: false,
			}),
		},
	);
	assert.match(headlessFailure.stderr, /--quiet/);
	assertUninstallNotStarted(guard.paths);
	assert.equal(readFileSync(dialogHelperLog, "utf8"), "");

	const unknownPolicyManifest = JSON.parse(guardManifestBefore);
	unknownPolicyManifest.cleanup_paths = ["/tmp/developer-controlled"];
	writeFileSync(guard.paths.manifest, JSON.stringify(unknownPolicyManifest));
	runExpectingFailure(guard.paths.uninstaller, ["--quiet"], {
		env: environmentFor(guardRoots, emptyHelperDir),
	});
	assertUninstallNotStarted(guard.paths);
	writeFileSync(guard.paths.manifest, guardManifestBefore);

	const guardData = join(guard.paths.channelRoot, "user-data.keep");
	writeSentinel(guardData, "safe app-only data\n");
	writeFileSync(dialogHelperLog, "");
	const guardedQuiet = run(
		guard.paths.uninstaller,
		["--uninstall", "--quiet"],
		{
			env: environmentFor(guardRoots, dialogHelperDir, {
				dialogResponse: "data",
			}),
		},
	);
	assert.equal(guardedQuiet.stdout, "");
	assert.equal(guardedQuiet.stderr, "");
	assert.equal(readFileSync(dialogHelperLog, "utf8"), "");
	assertManagedArtifactsRemoved(guard.paths);
	assertExists(guardData);

	// The immediately preceding schema remains usable for App-only cleanup, but
	// cannot authorize data deletion because it did not persist cache/state roots.
	const legacyRoots = makeRoots("legacy schema one");
	const legacy = installScenario({
		artifact: "LegacySchemaApp",
		channel: "legacy-schema",
		roots: legacyRoots,
	});
	const legacyManifest = readManifest(legacy.paths.manifest);
	legacyManifest.schema_version = 1;
	delete legacyManifest.data_path_versions;
	delete legacyManifest.home;
	delete legacyManifest.xdg_cache_home;
	delete legacyManifest.xdg_state_home;
	writeFileSync(legacy.paths.manifest, JSON.stringify(legacyManifest));
	runExpectingFailure(legacy.paths.uninstaller, ["--quiet", "--delete-data"], {
		env: environmentFor(legacyRoots, emptyHelperDir),
	});
	assertUninstallNotStarted(legacy.paths);
	run(legacy.paths.uninstaller, ["--quiet"], {
		env: environmentFor(legacyRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(legacy.paths);

	// Launcher delegation must reach the external manager before selecting or
	// loading the application runtime. Cancel/close is a successful no-op, and
	// KDE sessions prefer KDialog when both helpers are available.
	const cancelRoots = makeRoots("launcher delegated cancel");
	const cancel = installScenario({
		artifact: "DelegatedCancelApp",
		channel: "delegated-cancel",
		roots: cancelRoots,
	});
	const runtimeShouldNotLoad = join(cancelRoots.home, "runtime-loaded.fail");
	writeFileSync(dialogHelperLog, "");
	run(cancel.paths.launcher, ["--uninstall"], {
		env: {
			...environmentFor(cancelRoots, dialogHelperDir, {
				dialogResponse: "cancel",
			}),
			ELECTROBUN_RUNTIME_LOG: runtimeShouldNotLoad,
		},
	});
	assertUninstallNotStarted(cancel.paths);
	assertMissing(runtimeShouldNotLoad);
	assert.deepEqual(
		readFileSync(dialogHelperLog, "utf8").trim().split("\n"),
		["zenity"],
	);

	writeFileSync(dialogHelperLog, "");
	run(cancel.paths.uninstaller, [], {
		env: {
			...environmentFor(cancelRoots, dialogHelperDir, {
				dialogResponse: "cancel",
			}),
			XDG_CURRENT_DESKTOP: "KDE",
		},
	});
	assertUninstallNotStarted(cancel.paths);
	assert.deepEqual(
		readFileSync(dialogHelperLog, "utf8").trim().split("\n"),
		["kdialog"],
	);
	run(cancel.paths.uninstaller, ["--quiet"], {
		env: environmentFor(cancelRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(cancel.paths);

	const delegatedAppRoots = makeRoots("launcher delegated App");
	const delegatedApp = installScenario({
		artifact: "DelegatedApp",
		channel: "delegated-app",
		roots: delegatedAppRoots,
	});
	const delegatedRuntimeLog = join(delegatedAppRoots.home, "runtime-loaded.fail");
	const delegatedData = join(delegatedApp.paths.channelRoot, "user-data.keep");
	writeSentinel(delegatedData);
	writeFileSync(dialogHelperLog, "");
	run(delegatedApp.paths.launcher, ["--uninstall"], {
		env: {
			...environmentFor(delegatedAppRoots, dialogHelperDir, {
				dialogResponse: "app",
			}),
			ELECTROBUN_RUNTIME_LOG: delegatedRuntimeLog,
		},
	});
	assertManagedArtifactsRemoved(delegatedApp.paths);
	assertExists(delegatedData);
	assertMissing(delegatedRuntimeLog);
	assert.deepEqual(
		readFileSync(dialogHelperLog, "utf8").trim().split("\n"),
		["zenity"],
	);

	// Zenity's App-and-Data extra button has the unusual verified contract of
	// exit 1 plus its exact label on stdout. Exercise that interactive response
	// end-to-end and confirm all three current-channel roots are removed.
	const dialogDataRoots = makeRoots("interactive app and data");
	const dialogData = installScenario({
		artifact: "InteractiveDataApp",
		channel: "interactive-data",
		roots: dialogDataRoots,
	});
	const dialogDataSentinel = join(
		dialogData.paths.channelRoot,
		"interactive-data.keep",
	);
	const dialogCacheRoot = join(
		dialogDataRoots.cacheHome,
		uninstallIdentifier,
		dialogData.fixture.channel,
	);
	const dialogStateRoot = join(
		dialogDataRoots.stateHome,
		uninstallIdentifier,
		dialogData.fixture.channel,
	);
	writeSentinel(dialogDataSentinel);
	writeSentinel(join(dialogCacheRoot, "cache.keep"));
	writeSentinel(join(dialogStateRoot, "state.keep"));
	writeFileSync(dialogHelperLog, "");
	run(dialogData.paths.uninstaller, ["--uninstall"], {
		env: environmentFor(dialogDataRoots, dialogHelperDir, {
			dialogResponse: "data",
		}),
	});
	assertMissing(dialogData.paths.channelRoot);
	assertMissing(dialogCacheRoot);
	assertMissing(dialogStateRoot);
	assertMissing(dialogData.paths.applicationEntry);
	assertMissing(dialogData.paths.desktopEntry);
	assert.deepEqual(
		readFileSync(dialogHelperLog, "utf8").trim().split("\n"),
		["zenity"],
	);

	// Persist install-time custom cache/state roots. Unsetting every XDG variable
	// later must not redirect App-and-Data cleanup to HOME fallbacks. Sibling
	// channels, sibling identifiers, and files at each platform root survive.
	const customRoots = makeRoots("custom XDG roots later unset");
	const custom = installScenario({
		artifact: "CustomRootsApp",
		channel: "custom-roots",
		roots: customRoots,
	});
	const customCacheRoot = join(
		customRoots.cacheHome,
		uninstallIdentifier,
		custom.fixture.channel,
	);
	const customStateRoot = join(
		customRoots.stateHome,
		uninstallIdentifier,
		custom.fixture.channel,
	);
	const siblingChannel = "sibling-channel";
	const customSiblingData = join(
		customRoots.dataHome,
		uninstallIdentifier,
		siblingChannel,
		"data.keep",
	);
	const customSiblingCache = join(
		customRoots.cacheHome,
		uninstallIdentifier,
		siblingChannel,
		"cache.keep",
	);
	const customSiblingState = join(
		customRoots.stateHome,
		uninstallIdentifier,
		siblingChannel,
		"state.keep",
	);
	const unrelatedIdentifierRoot = join(
		customRoots.cacheHome,
		"com.example.unrelated",
		"stable",
		"unrelated.keep",
	);
	const customRootMarker = join(customRoots.stateHome, "root.keep");
	writeSentinel(join(custom.paths.channelRoot, "unknown-managed-data.keep"));
	writeSentinel(join(customCacheRoot, "cache.keep"));
	writeSentinel(join(customStateRoot, "state.keep"));
	for (const path of [
		customSiblingData,
		customSiblingCache,
		customSiblingState,
		unrelatedIdentifierRoot,
		customRootMarker,
	]) {
		writeSentinel(path);
	}
	writeFileSync(dialogHelperLog, "");
	run(
		custom.paths.uninstaller,
		["--uninstall", "--quiet", "--delete-data"],
		{
			env: environmentFor(customRoots, dialogHelperDir, {
				dialogResponse: "app",
				includeXdg: false,
			}),
		},
	);
	assertMissing(custom.paths.channelRoot);
	assertMissing(customCacheRoot);
	assertMissing(customStateRoot);
	for (const path of [
		customSiblingData,
		customSiblingCache,
		customSiblingState,
		unrelatedIdentifierRoot,
		customRootMarker,
	]) {
		assertExists(path);
	}
	assert.equal(readFileSync(dialogHelperLog, "utf8"), "");

	// App-only must not even inspect cache/state identifier roots. Symlink both
	// of them outside the XDG roots and verify the uninstall still succeeds while
	// preserving application data and the symlink targets.
	const appOnlySymlinkRoots = makeRoots("app only ignores cache state");
	const appOnlySymlink = installScenario({
		artifact: "AppOnlySymlinkApp",
		channel: "app-only-symlink",
		roots: appOnlySymlinkRoots,
	});
	const appOnlyData = join(appOnlySymlink.paths.channelRoot, "user-data.keep");
	const outsideCache = join(temporaryRoot, "outside app-only cache");
	const outsideState = join(temporaryRoot, "outside app-only state");
	writeSentinel(join(outsideCache, "outside.keep"));
	writeSentinel(join(outsideState, "outside.keep"));
	const cacheIdentifierLink = join(
		appOnlySymlinkRoots.cacheHome,
		uninstallIdentifier,
	);
	const stateIdentifierLink = join(
		appOnlySymlinkRoots.stateHome,
		uninstallIdentifier,
	);
	symlinkSync(outsideCache, cacheIdentifierLink);
	symlinkSync(outsideState, stateIdentifierLink);
	writeSentinel(appOnlyData);
	run(appOnlySymlink.paths.uninstaller, ["--quiet"], {
		env: environmentFor(appOnlySymlinkRoots, emptyHelperDir, {
			includeXdg: false,
		}),
	});
	assertManagedArtifactsRemoved(appOnlySymlink.paths);
	assertExists(appOnlyData);
	assert.equal(lstatSync(cacheIdentifierLink).isSymbolicLink(), true);
	assert.equal(lstatSync(stateIdentifierLink).isSymbolicLink(), true);
	assertExists(join(outsideCache, "outside.keep"));
	assertExists(join(outsideState, "outside.keep"));

	// App-and-Data must preflight data, cache, and state before deleting any of
	// them. A symlinked state identifier is discovered after a valid cache root;
	// nevertheless every app and user-data artifact remains untouched.
	const preflightRoots = makeRoots("app and data symlink preflight");
	const preflight = installScenario({
		artifact: "PreflightSymlinkApp",
		channel: "preflight-symlink",
		roots: preflightRoots,
	});
	const preflightData = join(preflight.paths.channelRoot, "data.keep");
	const preflightCache = join(
		preflightRoots.cacheHome,
		uninstallIdentifier,
		preflight.fixture.channel,
		"cache.keep",
	);
	const outsidePreflightState = join(temporaryRoot, "outside preflight state");
	writeSentinel(preflightData);
	writeSentinel(preflightCache);
	writeSentinel(join(outsidePreflightState, "outside.keep"));
	symlinkSync(
		outsidePreflightState,
		join(preflightRoots.stateHome, uninstallIdentifier),
	);
	runExpectingFailure(
		preflight.paths.uninstaller,
		["--quiet", "--delete-data"],
		{
			env: environmentFor(preflightRoots, emptyHelperDir, {
				includeXdg: false,
			}),
		},
	);
	assertUninstallNotStarted(preflight.paths);
	assertExists(preflightData);
	assertExists(preflightCache);
	assertExists(join(outsidePreflightState, "outside.keep"));
	run(preflight.paths.uninstaller, ["--quiet"], {
		env: environmentFor(preflightRoots, emptyHelperDir, {
			includeXdg: false,
		}),
	});
	assertManagedArtifactsRemoved(preflight.paths);

	// The running executable's physical /proc path must not hide a symlinked
	// identifier/channel in the lexical manager path used by the caller.
	const managerLinkRoots = makeRoots("manager symlink preflight");
	const managerLink = installScenario({
		artifact: "ManagerSymlinkApp",
		channel: "manager-symlink",
		roots: managerLinkRoots,
	});
	const movedChannelRoot = join(temporaryRoot, "moved manager channel");
	renameSync(managerLink.paths.channelRoot, movedChannelRoot);
	symlinkSync(movedChannelRoot, managerLink.paths.channelRoot);
	runExpectingFailure(managerLink.paths.uninstaller, ["--quiet"], {
		env: environmentFor(managerLinkRoots, emptyHelperDir),
	});
	for (const path of [
		join(movedChannelRoot, "app"),
		join(movedChannelRoot, "self-extraction"),
		join(movedChannelRoot, "uninstall"),
		join(movedChannelRoot, ".electrobun-uninstall.json"),
	]) {
		assertExists(path);
	}
	rmSync(managerLink.paths.channelRoot);
	renameSync(movedChannelRoot, managerLink.paths.channelRoot);
	run(managerLink.paths.uninstaller, ["--quiet"], {
		env: environmentFor(managerLinkRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(managerLink.paths);

	// A damaged or entirely missing app remains uninstallable because desktop
	// ownership is proven from recorded content and the expected lexical launcher
	// target, not by loading or resolving the app runtime.
	const damagedRoots = makeRoots("damaged app");
	const damaged = installScenario({
		artifact: "DamagedApp",
		channel: "damaged-app",
		roots: damagedRoots,
	});
	rmSync(damaged.paths.app, { force: true, recursive: true });
	run(damaged.paths.uninstaller, ["--uninstall", "--quiet"], {
		env: environmentFor(damagedRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(damaged.paths);
	assertMissing(damaged.paths.channelRoot);

	// Reinstall and repeat with multiple already-missing managed children.
	run(damaged.setup, [], {
		cwd: temporaryRoot,
		env: environmentFor(damagedRoots, emptyHelperDir),
	});
	rmSync(damaged.paths.app, { force: true, recursive: true });
	rmSync(damaged.paths.selfExtraction, { force: true, recursive: true });
	rmSync(damaged.paths.applicationEntry, { force: true });
	run(damaged.paths.uninstaller, ["--quiet"], {
		env: environmentFor(damagedRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(damaged.paths);
	assertMissing(damaged.paths.channelRoot);

	// Empty and relative XDG variables are invalid per the XDG contract and must
	// resolve to HOME fallbacks both in the install path and persisted manifest.
	for (const invalidXdg of [
		{ channel: "empty-xdg", value: "" },
		{ channel: "relative-xdg", value: "relative/platform/root" },
	]) {
		const createdRoots = makeRoots(`${invalidXdg.channel} environment`);
		const fallbackRoots = {
			home: createdRoots.home,
			dataHome: join(createdRoots.home, ".local", "share"),
			cacheHome: join(createdRoots.home, ".cache"),
			stateHome: join(createdRoots.home, ".local", "state"),
		};
		const fallback = installScenario({
			artifact: `Fallback-${invalidXdg.channel}`,
			channel: invalidXdg.channel,
			environmentOptions: {
				xdgCacheHome: invalidXdg.value,
				xdgDataHome: invalidXdg.value,
				xdgStateHome: invalidXdg.value,
			},
			roots: fallbackRoots,
		});
		const fallbackCache = join(
			fallbackRoots.cacheHome,
			uninstallIdentifier,
			invalidXdg.channel,
			"cache.keep",
		);
		const fallbackState = join(
			fallbackRoots.stateHome,
			uninstallIdentifier,
			invalidXdg.channel,
			"state.keep",
		);
		writeSentinel(fallbackCache);
		writeSentinel(fallbackState);
		run(fallback.paths.uninstaller, ["--quiet", "--delete-data"], {
			env: environmentFor(fallbackRoots, emptyHelperDir, {
					includeXdg: false,
			}),
		});
		assertMissing(fallback.paths.channelRoot);
		assertMissing(dirname(fallbackCache));
		assertMissing(dirname(fallbackState));
	}

	// Missing Desktop and update-desktop-database remain benign across repeated
	// install/uninstall cycles.
	const missingDesktopRoots = makeRoots("missing Desktop", { desktop: false });
	const missingDesktop = installScenario({
		artifact: "MissingDesktopApp",
		channel: "missing-desktop",
		desktopEntry: false,
		roots: missingDesktopRoots,
	});
	run(missingDesktop.paths.uninstaller, ["--quiet"], {
		env: environmentFor(missingDesktopRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(missingDesktop.paths);
	run(missingDesktop.setup, [], {
		cwd: temporaryRoot,
		env: environmentFor(missingDesktopRoots, emptyHelperDir),
	});
	run(missingDesktop.paths.uninstaller, ["--uninstall", "--quiet"], {
		env: environmentFor(missingDesktopRoots, emptyHelperDir),
	});
	assertManagedArtifactsRemoved(missingDesktop.paths);

	// Removing the remaining channel also removes the now-empty identity
	// directory while retaining the adjacent-installer regression coverage.
	run(adjacentCanaryPaths.uninstaller, ["--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertMissing(join(dataHome, adjacentIdentifier));

	console.log(
		"Linux extractor integration passed (adjacent + embedded Setup, stable + canary, uninstall + preservation)",
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
