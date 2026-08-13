#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
	console.log("Linux adjacent extractor integration: skipped on non-Linux host");
	process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(packageRoot, "src", "extractor");
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
const desktopDatabaseLog = join(temporaryRoot, "desktop database calls.log");

mkdirSync(desktopDir, { recursive: true });
mkdirSync(dataHome, { recursive: true });
mkdirSync(cacheHome, { recursive: true });
mkdirSync(stateHome, { recursive: true });
mkdirSync(helperDir, { recursive: true });
mkdirSync(emptyHelperDir, { recursive: true });
writeFileSync(desktopDatabaseLog, "");

const desktopDatabaseHelper = join(helperDir, "update-desktop-database");
writeFileSync(
	desktopDatabaseHelper,
	'#!/bin/sh\nprintf "%s\\n" "$@" >> "$ELECTROBUN_DESKTOP_DB_LOG"\n',
);
chmodSync(desktopDatabaseHelper, 0o755);

const installerEnv = (path) => ({
	...process.env,
	ELECTROBUN_DESKTOP_DB_LOG: desktopDatabaseLog,
	HOME: home,
	PATH: path,
	XDG_CACHE_HOME: cacheHome,
	XDG_DATA_HOME: dataHome,
	XDG_STATE_HOME: stateHome,
});

const createPayload = ({
	artifact,
	channel,
	fixtureRoot,
	icon,
	identifier,
	name,
	version,
}) => {
	const innerRoot = join(fixtureRoot, "inner", artifact);
	const innerBin = join(innerRoot, "bin");
	const innerResources = join(innerRoot, "Resources");
	mkdirSync(innerBin, { recursive: true });
	mkdirSync(innerResources, { recursive: true });

	const installedLauncher = join(innerBin, "launcher");
	writeFileSync(
		installedLauncher,
		`#!/bin/sh\nprintf '%s\\n' '${channel}:${version}' > "$HOME/${artifact}-launched"\n`,
	);
	chmodSync(installedLauncher, 0o755);

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
	writeFileSync(join(innerResources, "payload-version.txt"), `${version}\n`);
	if (icon) {
		writeFileSync(join(innerResources, "appIcon.png"), "fixture-icon");
	}

	const tarPath = join(fixtureRoot, `${channel}-${version}.tar`);
	const hash = `${channel}-${version.replaceAll(".", "-")}-hash`;
	const archivePath = join(fixtureRoot, `${hash}.tar.zst`);
	run("tar", ["-cf", tarPath, "-C", join(fixtureRoot, "inner"), artifact]);
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

const createAdjacentFixture = (extractor, fixture) => {
	const fixtureRoot = join(
		temporaryRoot,
		`adjacent fixture ${fixture.channel}`,
	);
	const payload = createPayload({
		...fixture,
		fixtureRoot,
		identifier: adjacentIdentifier,
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

const createEmbeddedSetupFixture = (extractor, fixture) => {
	const fixtureRoot = join(
		temporaryRoot,
		`embedded Setup fixture ${fixture.channel} ${fixture.version}`,
	);
	const payload = createPayload({
		...fixture,
		fixtureRoot,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
	});
	const setupName =
		fixture.channel === "production"
			? `${uninstallAppName}-Setup`
			: `${uninstallAppName}-Setup-${fixture.channel}`;
	const setup = join(fixtureRoot, setupName);
	writeFileSync(
		setup,
		Buffer.concat([
			readFileSync(extractor),
			Buffer.from(embeddedMetadataMarker),
			Buffer.from(JSON.stringify(payload.metadata)),
			Buffer.from(embeddedArchiveMarker),
			readFileSync(payload.archivePath),
		]),
	);
	chmodSync(setup, 0o755);
	return setup;
};

const installPaths = (identifier, channel, artifact) => {
	const channelRoot = join(dataHome, identifier, channel);
	return {
		app: join(channelRoot, "app"),
		applicationEntry: join(applicationsDir, `${artifact}.desktop`),
		channelRoot,
		desktopEntry: join(desktopDir, `${artifact}.desktop`),
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
	version,
}) => {
	assertExists(paths.app);
	assertExists(paths.launcher);
	assertExists(paths.selfExtraction);
	assertExists(paths.uninstaller);
	assertExists(paths.manifest);
	assertExists(paths.applicationEntry);
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
	assert.equal(manifest.schema_version, 1);
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

try {
	run(zig, ["build", "test"], { cwd: extractorRoot });
	run(zig, ["build"], { cwd: extractorRoot });
	const extractor = join(extractorRoot, "zig-out", "bin", "extractor");
	assertExists(extractor, "extractor build output is missing");

	// Preserve coverage for the adjacent Resources/metadata.json distribution.
	const adjacentFixtures = [
		{
			artifact: "ArchiveApp",
			channel: "production",
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
		const launcher = createAdjacentFixture(extractor, fixture);
		run(launcher, [], {
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
		run(paths.launcher, [], { env: installerEnv(emptyHelperDir) });
		assert.equal(
			readFileSync(join(home, `${fixture.artifact}-launched`), "utf8").trim(),
			`${fixture.channel}:${fixture.version}`,
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
	const collisionLauncher = createAdjacentFixture(extractor, collisionFixture);
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
	const adjacentProductionPaths = adjacentPaths.get("production");
	const adjacentCanaryPaths = adjacentPaths.get("canary");
	run(adjacentProductionPaths.uninstaller, ["--uninstall", "--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertManagedArtifactsRemoved(adjacentProductionPaths);
	assertMissing(adjacentProductionPaths.channelRoot);
	assertExists(adjacentCanaryPaths.channelRoot);
	assertExists(adjacentCanaryPaths.desktopEntry);

	// Build real self-contained Setup executables, including the exact embedded
	// metadata/archive markers used by shipped Electrobun Linux installers.
	const productionV1 = {
		artifact: "EmbeddedArchiveApp",
		channel: "production",
		icon: true,
		version: "2.3.4",
	};
	const productionV2 = { ...productionV1, version: "2.4.0" };
	const canaryV1 = {
		artifact: "EmbeddedArchiveApp-canary",
		channel: "canary",
		icon: false,
		version: "2.4.0-canary.3",
	};
	const productionSetupV1 = createEmbeddedSetupFixture(
		extractor,
		productionV1,
	);
	const productionSetupV2 = createEmbeddedSetupFixture(
		extractor,
		productionV2,
	);
	const canarySetupV1 = createEmbeddedSetupFixture(extractor, canaryV1);

	run(productionSetupV1, [], {
		cwd: temporaryRoot,
		env: installerEnv(helperDir),
	});
	run(canarySetupV1, [], {
		cwd: temporaryRoot,
		env: installerEnv(helperDir),
	});

	const productionPaths = installPaths(
		uninstallIdentifier,
		productionV1.channel,
		productionV1.artifact,
	);
	const canaryPaths = installPaths(
		uninstallIdentifier,
		canaryV1.channel,
		canaryV1.artifact,
	);
	assertInstalled({
		...productionV1,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: productionPaths,
	});
	assertInstalled({
		...canaryV1,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: canaryPaths,
	});

	const productionSentinel = join(
		productionPaths.channelRoot,
		"user data",
		"keep me.txt",
	);
	const canarySentinel = join(
		canaryPaths.channelRoot,
		"user data",
		"keep me too.txt",
	);
	const unknownChannelFile = join(
		productionPaths.channelRoot,
		"unknown file.keep",
	);
	const cacheSentinel = join(
		cacheHome,
		uninstallIdentifier,
		"production",
		"cache.keep",
	);
	const logSentinel = join(
		stateHome,
		uninstallIdentifier,
		"production",
		"application.log",
	);
	const userDocument = join(home, "Documents", "user document.txt");
	const unrelatedApplicationEntry = join(
		applicationsDir,
		"unrelated-user-entry.desktop",
	);
	const unrelatedDesktopEntry = join(desktopDir, "unrelated-user-entry.desktop");
	const mimePreferences = join(applicationsDir, "mimeapps.list");
	mkdirSync(dirname(productionSentinel), { recursive: true });
	mkdirSync(dirname(canarySentinel), { recursive: true });
	mkdirSync(dirname(cacheSentinel), { recursive: true });
	mkdirSync(dirname(logSentinel), { recursive: true });
	mkdirSync(dirname(userDocument), { recursive: true });
	writeFileSync(productionSentinel, "production application data\n");
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
	run(productionSetupV2, [], {
		cwd: temporaryRoot,
		env: installerEnv(helperDir),
	});
	assertExists(productionSentinel);
	assertInstalled({
		...productionV2,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: productionPaths,
	});
	assert.deepEqual(
		readdirSync(productionPaths.channelRoot).filter((entry) =>
			entry.startsWith("uninstall"),
		),
		["uninstall"],
	);
	assert.equal(sha256(productionPaths.uninstaller), sha256(productionSetupV2));

	// Exercise the updater-facing refresh command and prove it repairs stale
	// name/version metadata from the newly installed app.
	const staleManifest = readManifest(productionPaths.manifest);
	const installedDesktopSource = join(
		productionPaths.app,
		`${productionV2.artifact}.desktop`,
	);
	writeFileSync(
		installedDesktopSource,
		readFileSync(installedDesktopSource, "utf8").replace(
			`Name=${uninstallAppName}`,
			"Name=Renamed Embedded Archive App",
		),
	);
	writeFileSync(
		productionPaths.manifest,
		JSON.stringify({
			...staleManifest,
			name: "Stale App Name",
			version: "stale-version",
		}),
	);
	run(
		productionPaths.uninstaller,
		["--refresh-metadata", "--quiet"],
		{ env: installerEnv(emptyHelperDir) },
	);
	const refreshedManifest = readManifest(productionPaths.manifest);
	assert.equal(refreshedManifest.version, productionV2.version);
	assert.equal(refreshedManifest.name, "Renamed Embedded Archive App");

	// Interactive uninstall removes only Electrobun-owned state, refreshes the
	// desktop database, preserves a user-edited Desktop entry, and leaves the
	// canary installation and user data alone.
	const editedDesktopContents = `${readFileSync(productionPaths.desktopEntry, "utf8")}# user customization\n`;
	writeFileSync(productionPaths.desktopEntry, editedDesktopContents);
	writeFileSync(desktopDatabaseLog, "");
	const interactiveUninstall = run(productionPaths.uninstaller, ["--uninstall"], {
		env: installerEnv(helperDir),
	});
	assert.match(
		interactiveUninstall.stderr,
		/Uninstalling Renamed Embedded Archive App/,
	);
	assertManagedArtifactsRemoved(productionPaths, { preservedDesktop: true });
	assert.equal(
		readFileSync(productionPaths.desktopEntry, "utf8"),
		editedDesktopContents,
	);
	assertExists(productionSentinel);
	assert.equal(
		readFileSync(productionSentinel, "utf8"),
		"production application data\n",
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
	run(productionSetupV2, [], {
		cwd: temporaryRoot,
		env: installerEnv(emptyHelperDir),
	});
	assertExists(productionSentinel);
	assertInstalled({
		...productionV2,
		desktopEntry: false,
		identifier: uninstallIdentifier,
		name: uninstallAppName,
		paths: productionPaths,
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
	assertExists(productionPaths.app);
	assertExists(productionPaths.selfExtraction);
	assertExists(productionPaths.uninstaller);
	assertExists(productionPaths.manifest);
	assertExists(productionPaths.applicationEntry);

	// A repeated install/uninstall cycle also succeeds when every managed child
	// except the installed uninstaller and manifest has already disappeared.
	rmSync(productionPaths.app, { recursive: true, force: true });
	rmSync(productionPaths.selfExtraction, { recursive: true, force: true });
	rmSync(productionPaths.applicationEntry, { force: true });
	run(productionPaths.uninstaller, ["--uninstall", "--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertManagedArtifactsRemoved(productionPaths);
	assertExists(productionSentinel);
	assert.equal(
		readFileSync(productionSentinel, "utf8"),
		"production application data\n",
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
	assertExists(productionPaths.channelRoot);
	assertExists(canaryPaths.channelRoot);

	// Removing the remaining channel also removes the now-empty identity
	// directory while retaining the adjacent-installer regression coverage.
	run(adjacentCanaryPaths.uninstaller, ["--quiet"], {
		env: installerEnv(emptyHelperDir),
	});
	assertMissing(join(dataHome, adjacentIdentifier));

	console.log(
		"Linux extractor integration passed (adjacent + embedded Setup, production + canary, uninstall + preservation)",
	);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
