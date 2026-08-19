#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FOCUSES = new Set(["build", "install", "update", "uninstall", "full"]);
const INITIAL_VERSION = "1.0.0";
const INTERMEDIATE_VERSION = "2.0.0";
const PATCH_TARGET_VERSION = "3.0.0";
const FALLBACK_TARGET_VERSION = "4.0.0";
const RELEASE_VERSIONS = [
	INITIAL_VERSION,
	INTERMEDIATE_VERSION,
	PATCH_TARGET_VERSION,
	FALLBACK_TARGET_VERSION,
];
const CHANNEL = "stable";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const RESULT_PATTERN = /^\.electrobun-update-([0-9a-f]{32})\.result\.json$/;
const PLAN_PATTERN = /^\.electrobun-update-([0-9a-f]{32})\.json$/;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureTemplate = join(packageRoot, "test-apps", "updater-lifecycle");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const packageHutchPragma = readFileSync(
	join(packageRoot, "hutch.config.ts"),
	"utf8",
).split(/\r?\n/, 1)[0];
const focus = parseFocus(process.argv.slice(2));
const token = randomBytes(6).toString("hex");
const identifier = `dev.example.updater-lifecycle.${token}`;
const appName = `UpdaterLifecycleE2E-${token}`;
const artifactAppName = appName;
const temporaryBase = realpathSync(tmpdir());
const temporaryRoot = realpathSync(
	mkdtempSync(join(temporaryBase, `updater-lifecycle-e2e-${token}-`)),
);
const releaseRoot = join(temporaryRoot, "releases");
const serverRoot = join(temporaryRoot, "server");
const signalDirectory = join(temporaryRoot, "signals");
const eventLogPath = join(signalDirectory, "events.jsonl");
const failurePath = join(signalDirectory, "failure.json");
const patchRelaunchSentinelPath = join(signalDirectory, "v3-relaunched.json");
const fallbackRelaunchSentinelPath = join(signalDirectory, "v4-relaunched.json");
const updateActivationPath = join(signalDirectory, "activate-update");
const bootstrapVerificationPath = join(signalDirectory, "verify-v2-bootstrap");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
let hutchLauncher = process.env.ELECTROBUN_UPDATER_E2E_HUTCH || "hutch";
let hutchEngine = process.env.HUTCH_ENGINE_BINARY;
const timeoutMs = Number(
	process.env.ELECTROBUN_UPDATER_E2E_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
);
const keepTemporary = process.env.ELECTROBUN_UPDATER_E2E_KEEP === "1";
const v1CompatibilitySimulationEnabled =
	process.env.ELECTROBUN_UPDATER_E2E_MIGRATION !== "0";
const devkitRoot = resolve(
	process.env.HUTCH_ELECTROBUN_DEVKIT_ROOT || join(packageRoot, "dist"),
);

assert.equal(FOCUSES.has(focus), true, `unsupported focus ${JSON.stringify(focus)}`);
assert.match(
	packageHutchPragma,
	/^\/\/ @hutch cli=\S+ cottontail=\S+$/,
	"package Hutch config must start with the exact project pragma",
);
assert.doesNotMatch(appName, /electrobun/i, "fixture display name must be neutral");
assert.doesNotMatch(identifier, /electrobun/i, "fixture identifier must be neutral");
assert.equal(
	Number.isFinite(timeoutMs) && timeoutMs >= 10_000,
	true,
	"ELECTROBUN_UPDATER_E2E_TIMEOUT_MS must be at least 10000",
);
assert.equal(
	existsSync(join(devkitRoot, "native-devkit.json")),
	true,
	`local Electrobun devkit is missing at ${devkitRoot}; run hutch build:release first`,
);

const platform = platformAdapter();
const profile = platform.createProfile(temporaryRoot, identifier);
const channelRoot = profile.channelRoot;
const appBundlePath = platform.appBundlePath(profile, appName, channelRoot);
const expectedBrowserProfileRoot =
	process.platform === "linux"
		? join(
				profile.home,
				".cache",
				identifier,
				basename(channelRoot),
				"CEF",
			)
		: join(channelRoot, "CEF");
const requests = [];
const backgroundChildren = new Set();
let launcherFailure;
let installed = false;
let uninstallVerified = false;
const completedUpdateResults = [];
let cleanupManifest;
const cleanupTransactionIds = new Set();
let server;

function parseFocus(args) {
	let selected = process.env.ELECTROBUN_UPDATER_E2E_FOCUS || "full";
	for (const arg of args) {
		if (arg === "--help") {
			console.log(
				"Usage: node scripts/test-updater-lifecycle.mjs [--focus=build|install|update|uninstall|full]\n" +
					"Environment: ELECTROBUN_UPDATER_E2E_HUTCH=<launcher> selects a local Hutch launcher; " +
					"HUTCH_ENGINE_BINARY=<engine> overrides its engine; " +
					"ELECTROBUN_UPDATER_E2E_MIGRATION=0 disables the v1 manager/manifest compatibility simulation; " +
					"ELECTROBUN_UPDATER_E2E_KEEP=1 preserves the isolated temporary root.",
			);
			process.exit(0);
		}
		if (arg.startsWith("--focus=")) selected = arg.slice("--focus=".length);
		else throw new Error(`unknown argument: ${arg}`);
	}
	return selected;
}

function pathExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function removeTreeWithRetry(path, limit = 20_000) {
	const deadline = Date.now() + limit;
	for (;;) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (
				!["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) ||
				Date.now() >= deadline
			) {
				throw error;
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
		}
	}
}

function normalized(path) {
	const value = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function assertWithin(root, candidate, label) {
	const fromRoot = relative(resolve(root), resolve(candidate));
	assert.equal(
		fromRoot === "" ||
			(!isAbsolute(fromRoot) &&
				!fromRoot.startsWith(`..${sep}`) &&
				fromRoot !== ".."),
		true,
		`${label} escaped the temporary root: ${candidate}`,
	);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function copyDirectoryContents(source, destination) {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source)) {
		const from = join(source, entry);
		const to = join(destination, entry);
		if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true });
		else copyFileSync(from, to);
	}
}

function listFilesRecursively(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path);
		}
	};
	visit(root);
	return files;
}

function exactlyOne(values, label) {
	assert.equal(values.length, 1, `${label}: expected one, found ${values.length}`);
	return values[0];
}

function commandText(command, args) {
	return [command, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function run(command, args = [], options = {}) {
	const display = options.label || commandText(command, args);
	console.log(`[updater-e2e] ${display}`);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd || temporaryRoot,
			env: options.env || process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const append = (streamName, chunk) => {
			const text = chunk.toString();
			if (streamName === "stdout") stdout = (stdout + text).slice(-4 * 1024 * 1024);
			else stderr = (stderr + text).slice(-4 * 1024 * 1024);
			if (options.echo) process[streamName].write(text);
		};
		child.stdout.on("data", (chunk) => append("stdout", chunk));
		child.stderr.on("data", (chunk) => append("stderr", chunk));
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${display} timed out after ${options.timeout || timeoutMs}ms`));
		}, options.timeout || timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolvePromise({ stdout, stderr });
				return;
			}
			reject(
				new Error(
					`${display} failed (${code ?? signal}):\n${stdout}\n${stderr}`,
				),
			);
		});
	});
}

async function prepareHutch() {
	const explicitLauncher = process.env.ELECTROBUN_UPDATER_E2E_HUTCH;
	if (explicitLauncher) {
		hutchLauncher = resolve(explicitLauncher);
		if (!hutchEngine) {
			const adjacentEngine = join(
				dirname(hutchLauncher),
				`hutch-engine${executableSuffix}`,
			);
			if (pathExists(adjacentEngine)) hutchEngine = adjacentEngine;
		}
	}

	if (hutchLauncher !== "hutch") {
		assert.equal(pathExists(hutchLauncher), true, `Hutch launcher is missing: ${hutchLauncher}`);
	}
	if (hutchEngine) {
		hutchEngine = resolve(hutchEngine);
		assert.equal(pathExists(hutchEngine), true, `Hutch engine is missing: ${hutchEngine}`);
	}
	console.log(
		`[updater-e2e] Hutch launcher=${hutchLauncher}${hutchEngine ? ` engine=${hutchEngine}` : " (launcher-selected engine)"}`,
	);
}

function runStatus(command, args = [], options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd || temporaryRoot,
			env: options.env || process.env,
			stdio: "ignore",
			windowsHide: true,
		});
		const timer = setTimeout(() => child.kill(), options.timeout || 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolvePromise(code);
		});
	});
}

function launch(command, args = [], options = {}) {
	const display = commandText(command, args);
	console.log(`[updater-e2e] launch ${display}`);
	const child = spawn(command, args, {
		cwd: options.cwd || dirname(command),
		env: options.env || process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	backgroundChildren.add(child);
	child.stdout.on("data", (chunk) => process.stdout.write(`[fixture] ${chunk}`));
	child.stderr.on("data", (chunk) => process.stderr.write(`[fixture] ${chunk}`));
	child.once("error", (error) => {
		launcherFailure ??= new Error(
			`launched process ${display} failed to start: ${error.message}`,
			{ cause: error },
		);
	});
	child.once("exit", (code) => {
		backgroundChildren.delete(child);
		if (code !== null && code !== 0) {
			launcherFailure ??= new Error(
				`launched process ${display} exited with code ${code}`,
			);
		}
	});
	return child;
}

function assertLauncherHealthy(description) {
	if (launcherFailure) {
		throw new Error(
			`launcher failed while waiting for ${description}: ${launcherFailure.message}`,
			{ cause: launcherFailure },
		);
	}
}

async function waitFor(description, predicate, limit = timeoutMs) {
	const deadline = Date.now() + limit;
	while (Date.now() < deadline) {
		assertLauncherHealthy(description);
		if (pathExists(failurePath)) {
			throw new Error(
				`fixture reported failure while waiting for ${description}:\n${readFileSync(failurePath, "utf8")}`,
			);
		}
		const result = await predicate();
		if (result) return result;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
	}
	throw new Error(`timed out waiting for ${description} after ${limit}ms`);
}

async function waitForOptional(predicate, limit) {
	const deadline = Date.now() + limit;
	while (Date.now() < deadline) {
		assertLauncherHealthy("optional fixture event");
		if (pathExists(failurePath)) {
			throw new Error(readFileSync(failurePath, "utf8"));
		}
		if (await predicate()) return true;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	return false;
}

function recordedEvents() {
	if (!pathExists(eventLogPath)) return [];
	return readFileSync(eventLogPath, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function eventWasRecorded(event, version) {
	const events = recordedEvents();
	return events.some(
		(entry) =>
			entry.event === event &&
			(version === undefined || entry.version === version),
	);
}

function createFixtureProject(projectRoot, builtVersion) {
	assertWithin(temporaryRoot, projectRoot, "fixture project");
	cpSync(fixtureTemplate, projectRoot, { recursive: true });
	const fixtureHutchConfigPath = join(projectRoot, "hutch.config.ts");
	const fixtureHutchConfig = readFileSync(fixtureHutchConfigPath, "utf8");
	assert.match(
		fixtureHutchConfig,
		/^\/\/ @hutch cli=\S+ cottontail=\S+$/m,
		"fixture Hutch config is missing its replaceable pragma",
	);
	writeFileSync(
		fixtureHutchConfigPath,
		fixtureHutchConfig.replace(/^\/\/ @hutch[^\r\n]*$/m, packageHutchPragma),
		"utf8",
	);
	mkdirSync(signalDirectory, { recursive: true });
	const control = {
		runToken: token,
		identifier,
		builtVersion,
		initialVersion: INITIAL_VERSION,
		intermediateVersion: INTERMEDIATE_VERSION,
		patchTargetVersion: PATCH_TARGET_VERSION,
		fallbackTargetVersion: FALLBACK_TARGET_VERSION,
		channel: CHANNEL,
		channelRoot,
		appBundlePath,
		browserProfileRoot: expectedBrowserProfileRoot,
		signalDirectory,
		eventLogPath,
		failurePath,
		patchRelaunchSentinelPath,
		fallbackRelaunchSentinelPath,
		updateActivationPath,
		bootstrapVerificationPath,
	};
	writeFileSync(
		join(projectRoot, "src", "control.ts"),
		`export const control = ${JSON.stringify(control, null, 2)} as const;\n`,
		"utf8",
	);
}

function buildEnvironment(version, baseUrl) {
	const environment = {
		...process.env,
		HUTCH_ELECTROBUN_DEVKIT_ROOT: devkitRoot,
		ELECTROBUN_UPDATER_E2E_SDK_VERSION: packageJson.version,
		ELECTROBUN_UPDATER_E2E_VERSION: version,
		ELECTROBUN_UPDATER_E2E_NAME: appName,
		ELECTROBUN_UPDATER_E2E_IDENTIFIER: identifier,
		ELECTROBUN_UPDATER_E2E_BASE_URL: baseUrl,
		ELECTROBUN_SKIP_NOTARIZATION: "1",
	};
	if (hutchEngine) environment.HUTCH_ENGINE_BINARY = hutchEngine;
	return environment;
}

async function buildRelease(version, baseUrl, label, previousRelease) {
	// Keep releases in separate project roots so neither Hutch nor the
	// main-process compiler can reuse an earlier entrypoint.
	const projectRoot = join(temporaryRoot, `project-${label}`);
	createFixtureProject(projectRoot, version);
	const releaseMarker = `Updater lifecycle fixture ${version}\n`;
	assert.equal(
		Buffer.byteLength(releaseMarker),
		Buffer.byteLength("Updater lifecycle fixture 1.0.0\n"),
		"release markers must remain equal-length to exercise content hashing",
	);
	writeFileSync(
		join(projectRoot, "src", "release-marker.txt"),
		releaseMarker,
		"utf8",
	);
	await run(hutchLauncher, ["electrobun", "build", "--env=stable"], {
		cwd: projectRoot,
		env: buildEnvironment(version, baseUrl),
		label: `build ${label} (${version})`,
		echo: true,
		timeout: 20 * 60_000,
	});
	const artifactRoot = join(projectRoot, "artifacts");
	assert.equal(pathExists(artifactRoot), true, `${label} artifact directory missing`);
	const destination = join(releaseRoot, label);
	copyDirectoryContents(artifactRoot, destination);
	return await inspectArtifacts(
		destination,
		version,
		label,
		previousRelease,
	);
}

async function inspectArtifacts(root, version, label, previousRelease) {
	const names = readdirSync(root);
	const releasePrefix = `${CHANNEL}-${platform.updatePlatform}-${platform.updateArch}`;
	const installerPrefix = `${platform.updatePlatform}-${platform.updateArch}-`;
	const updatePath = join(root, `${releasePrefix}-update.json`);
	assert.equal(pathExists(updatePath), true, `${label} stable update metadata`);
	assert.deepEqual(
		new Set(names.filter((name) => name.endsWith("-update.json"))),
		new Set([basename(updatePath)]),
		`${label} update metadata names`,
	);
	const metadata = readJson(updatePath);
	assert.equal(
		basename(metadata.artifact?.file || ""),
		metadata.artifact?.file,
		`${label} artifact filename must be a basename`,
	);
	const archivePath = join(root, metadata.artifact.file);
	assert.equal(pathExists(archivePath), true, `${label} full update archive`);
	const installerPath = exactlyOne(
		names.filter((name) => platform.isInstaller(name)).map((name) => join(root, name)),
		`${label} installer`,
	);
	assert.doesNotMatch(
		basename(installerPath),
		/electrobun/i,
		`${label} installer leaked a framework brand`,
	);
	assert.equal(
		basename(installerPath).startsWith(installerPrefix),
		true,
		`${label} stable installer must use the unprefixed main-release name`,
	);
	assert.equal(
		basename(installerPath).startsWith(`${CHANNEL}-`),
		false,
		`${label} stable installer unexpectedly has a channel prefix`,
	);
	assert.equal(metadata.schemaVersion, 1, `${label} metadata schema`);
	assert.equal(metadata.identifier, identifier, `${label} metadata identifier`);
	assert.equal(metadata.channel, CHANNEL, `${label} metadata channel`);
	assert.equal(metadata.version, version, `${label} metadata version`);
	assert.equal(metadata.platform, platform.updatePlatform, `${label} metadata platform`);
	assert.equal(metadata.arch, platform.updateArch, `${label} metadata arch`);
	assert.match(metadata.hash, /^[a-z0-9_-]+$/, `${label} metadata hash`);
	assert.equal(metadata.artifact?.file, basename(archivePath), `${label} artifact filename`);
	assert.equal(
		metadata.artifact.file.startsWith(`${releasePrefix}-`),
		true,
		`${label} updater archive must retain the stable protocol prefix`,
	);
	assert.deepEqual(
		new Set(Object.keys(metadata.artifact || {})),
		new Set(["file"]),
		`${label} artifact metadata must use the historical filename-only protocol`,
	);
	assert.equal(metadata.patch, undefined, `${label} metadata unexpectedly advertised a patch descriptor`);
	let patchPath;
	if (previousRelease) {
		patchPath = join(
			root,
			`${releasePrefix}-${previousRelease.metadata.hash}.patch`,
		);
		assert.equal(pathExists(patchPath), true, `${label} filename-addressed patch`);
	}
	assert.deepEqual(
		new Set(names.filter((name) => name.endsWith(".tar.zst"))),
		new Set([basename(archivePath)]),
		`${label} full update archive names`,
	);
	assert.deepEqual(
		new Set(names.filter((name) => name.endsWith(".patch"))),
		new Set(previousRelease ? [basename(patchPath)] : []),
		`${label} filename-addressed patch names`,
	);
	return {
		root,
		updatePath,
		archivePath,
		patchPath,
		installerPath,
		metadata,
	};
}

function publishRelease(release, options = {}) {
	const includePatch = options.includePatch !== false;
	mkdirSync(serverRoot, { recursive: true });
	// Publish immutable payloads before the mutable target document. Deliberately
	// leave every older source-hash patch in place so clients can traverse the
	// complete release chain even after the update document advances.
	copyFileSync(release.archivePath, join(serverRoot, basename(release.archivePath)));
	if (includePatch && release.patchPath) {
		copyFileSync(release.patchPath, join(serverRoot, basename(release.patchPath)));
	}
	copyFileSync(release.updatePath, join(serverRoot, basename(release.updatePath)));
}

async function startReleaseServer() {
	server = createServer((request, response) => {
		let requestUrl;
		let pathname;
		try {
			requestUrl = new URL(request.url || "/", "http://localhost");
			pathname = decodeURIComponent(requestUrl.pathname);
		} catch {
			response.writeHead(400).end();
			return;
		}
		const name = pathname.slice(1);
		if (!name || name !== basename(name)) {
			requests.push({ method: request.method, pathname, search: requestUrl.search, status: 404 });
			response.writeHead(404).end();
			return;
		}
		const path = join(serverRoot, name);
		if (!pathExists(path) || !statSync(path).isFile()) {
			requests.push({ method: request.method, pathname, search: requestUrl.search, status: 404 });
			response.writeHead(404).end();
			return;
		}
		const size = statSync(path).size;
		requests.push({ method: request.method, pathname, search: requestUrl.search, status: 200, bytes: size });
		response.writeHead(200, {
			"content-length": String(size),
			"content-type": name.endsWith(".json")
				? "application/json"
				: "application/octet-stream",
			"cache-control": "no-store",
		});
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		const stream = createReadStream(path);
		stream.once("error", (error) => response.destroy(error));
		stream.pipe(response);
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object", "release server did not bind");
	return `http://127.0.0.1:${address.port}`;
}

function assertInstalledIdentity(expected) {
	const versionPath = platform.versionPath(appBundlePath);
	assert.equal(pathExists(versionPath), true, `installed version metadata missing: ${versionPath}`);
	const actual = readJson(versionPath);
	assert.equal(actual.identifier, identifier);
	assert.equal(actual.channel, CHANNEL);
	assert.equal(actual.version, expected.metadata.version);
	assert.equal(actual.hash, expected.metadata.hash);
	assert.equal(actual.name, artifactAppName, "installed artifact name");
	assert.equal(actual.displayName, appName, "installed display name");
	const retainedTar = join(
		channelRoot,
		"self-extraction",
		`${expected.metadata.hash}.tar`,
	);
	assert.equal(pathExists(retainedTar), true, `retained updater tar missing: ${retainedTar}`);
	const manager = platform.uninstallerPath(channelRoot);
	const manifestPath = join(channelRoot, ".electrobun-uninstall.json");
	assert.equal(pathExists(manager), true, `installed uninstaller missing: ${manager}`);
	assert.equal(pathExists(manifestPath), true, `uninstall manifest missing: ${manifestPath}`);
	const manifest = readJson(manifestPath);
	assert.equal(manifest.identifier, identifier);
	assert.equal(manifest.channel, CHANNEL);
	if (platform.uninstallManifestHasVersion) {
		assert.equal(manifest.version, expected.metadata.version);
	}
	return { actual, retainedTar, manager, manifestPath, manifest };
}

function bundledUninstallerPath() {
	return platform.bundledUninstallerPath(appBundlePath);
}

async function simulateV1InstallLayout() {
	assert.equal(pathExists(channelRoot), true, "installed v1 stable root is missing");
	const manager = platform.uninstallerPath(channelRoot);
	const manifest = join(channelRoot, ".electrobun-uninstall.json");
	const bundled = bundledUninstallerPath();
	assert.equal(pathExists(bundled), true, `bundled update helper missing: ${bundled}`);
	assert.equal(pathExists(manager), true, `standalone manager missing: ${manager}`);
	assert.equal(pathExists(manifest), true, `uninstall manifest missing: ${manifest}`);
	// Electrobun v1 used the same stable root and updater protocol, but it did not
	// install the standalone v2 manager/manifest pair. Removing those two files
	// exercises the first-v2-runtime launcher bootstrap without inventing a
	// second channel root or any channel-name translation.
	rmSync(manager, { force: true });
	rmSync(manifest, { force: true });
	assert.equal(pathExists(manager), false);
	assert.equal(pathExists(manifest), false);
	console.log(
		`[updater-e2e] simulated v1 stable layout without manager/manifest: ${channelRoot}`,
	);
}

async function installInitialRelease(release) {
	console.log(`[updater-e2e] install v1 with ${platform.name} adapter`);
	await platform.install(release.installerPath, profile, appName);
	await waitFor("installed uninstaller", () => pathExists(platform.uninstallerPath(channelRoot)));
	installed = true;
	cleanupManifest = assertInstalledIdentity(release).manifest;
	if (platform.installerRelaunches) {
		await waitFor(
			"installer-triggered app relaunch",
			() => eventWasRecorded("ignored-installer-relaunch"),
			60_000,
		);
	} else {
		await waitForOptional(
			() => eventWasRecorded("ignored-installer-relaunch"),
			2_000,
		);
	}
}

function launchInstalledApp(targetVersion) {
	const launcher = platform.launcherPath(appBundlePath);
	assert.equal(pathExists(launcher), true, `installed launcher missing: ${launcher}`);
	if (targetVersion) {
		assert.equal(
			RELEASE_VERSIONS.includes(targetVersion),
			true,
			`unsupported activation target: ${targetVersion}`,
		);
		writeFileSync(
			updateActivationPath,
			`${JSON.stringify({ runToken: token, targetVersion })}\n`,
			"utf8",
		);
	}
	launch(launcher, [], {
		cwd: dirname(launcher),
		env: profile.environment,
	});
}

function resultFiles() {
	if (!pathExists(channelRoot)) return [];
	return readdirSync(channelRoot)
		.filter((name) => RESULT_PATTERN.test(name))
		.map((name) => join(channelRoot, name));
}

function rememberUpdateTransactions(roots) {
	for (const root of roots) {
		if (!pathExists(root)) continue;
		for (const name of readdirSync(root)) {
			const match = name.match(PLAN_PATTERN) || name.match(RESULT_PATTERN);
			if (match) cleanupTransactionIds.add(match[1]);
		}
	}
	for (const result of completedUpdateResults) {
		cleanupTransactionIds.add(result.transaction_id);
	}
}

function assertOrderedPhaseEvents(events, expectedEvents, label) {
	let cursor = -1;
	for (const expected of expectedEvents) {
		cursor = events.findIndex(
			(entry, index) =>
				index > cursor &&
				entry.event === expected.event &&
				(expected.version === undefined || entry.version === expected.version) &&
				(expected.status === undefined || entry.details?.status === expected.status) &&
				(expected.verify === undefined || expected.verify(entry)),
		);
		assert.notEqual(
			cursor,
			-1,
			`${label} event is missing or out of order: ${expected.event}${expected.status ? `/${expected.status}` : ""}${expected.version ? ` ${expected.version}` : ""}`,
		);
	}
}

async function verifySuccessfulUpdate({
	fromRelease,
	toRelease,
	relaunchSentinelPath,
	expectedDownloadPath,
	patchReleases,
	requestStart,
	eventStart,
	previousResultPaths,
}) {
	const sentinel = readJson(relaunchSentinelPath);
	assert.equal(sentinel.runToken, token);
	assert.equal(sentinel.identifier, identifier);
	assert.equal(sentinel.channel, CHANNEL);
	assert.equal(sentinel.version, toRelease.metadata.version);
	assert.equal(sentinel.hash, toRelease.metadata.hash);

	const resultPath = exactlyOne(
		resultFiles().filter((path) => !previousResultPaths.has(path)),
		`${toRelease.metadata.version} durable updater result`,
	);
	const result = readJson(resultPath);
	const transactionId = basename(resultPath).match(RESULT_PATTERN)?.[1];
	assert.equal(result.schema_version, 1);
	assert.equal(result.transaction_id, transactionId);
	assert.match(result.transaction_id, /^[0-9a-f]{32}$/);
	completedUpdateResults.push(result);
	cleanupTransactionIds.add(result.transaction_id);
	assert.equal(result.success, true);
	assert.equal(result.phase, "complete");
	assert.equal(result.identifier, identifier);
	assert.equal(result.channel, CHANNEL);
	assert.equal(result.version, toRelease.metadata.version);
	assert.equal(result.hash, toRelease.metadata.hash);
	assert.equal(typeof result.message, "string");
	if (process.platform === "win32") {
		const temporaryHelper = join(
			profile.environment.TEMP,
			`electrobun-update-${result.transaction_id}.exe`,
		);
		await waitFor(
			"deferred native update helper cleanup",
			() => !pathExists(temporaryHelper),
			45_000,
		);
	}

	cleanupManifest = assertInstalledIdentity(toRelease).manifest;
	await platform.verifyInstalled(
		channelRoot,
		appBundlePath,
		cleanupManifest,
		toRelease,
	);
	assert.equal(
		pathExists(join(channelRoot, "self-extraction", `${fromRelease.metadata.hash}.tar`)),
		false,
		"the previous retained tar survived a committed update",
	);
	for (const stale of [
		"self-extraction.partial",
		"self-extraction.previous",
		"app.partial",
		"app.previous",
		"update.bat",
	]) {
		assert.equal(pathExists(join(channelRoot, stale)), false, `stale update state remains: ${stale}`);
	}
	for (const entry of readdirSync(join(channelRoot, "self-extraction"))) {
		assert.equal(
			entry.endsWith(".patch") || entry.endsWith(".partial"),
			false,
			`stale patch preparation state remains: ${entry}`,
		);
	}

	const phaseRequests = requests.slice(requestStart);
	const updateName = `/${basename(toRelease.updatePath)}`;
	const archiveName = `/${basename(toRelease.archivePath)}`;
	const metadataRequest = phaseRequests.findIndex(
		(request) =>
			request.pathname === updateName &&
			request.status === 200,
	);
	assert.notEqual(metadataRequest, -1, `updater never fetched ${updateName}`);
	assert.equal(
		phaseRequests.every(
			(request) => !request.search.toLowerCase().includes("sha256"),
		),
		true,
		"historical updater artifact requests must not add SHA-256 query parameters",
	);
	assert.equal(
		phaseRequests.some((request) => request.pathname.startsWith("/production-")),
		false,
		"stable updater unexpectedly requested a removed production alias",
	);

	assert.equal(
		patchReleases.length > 0,
		true,
		"update verification requires at least one filename-addressed patch edge",
	);
	const patchRequestIndexes = [];
	for (const [index, patchRelease] of patchReleases.entries()) {
		const patchName = `/${basename(patchRelease.patchPath)}`;
		const expectedStatus = expectedDownloadPath === "patch" ? 200 : 404;
		const matchingRequests = phaseRequests
			.map((request, requestIndex) => ({ request, requestIndex }))
			.filter(
				({ request }) =>
					request.pathname === patchName &&
					request.search === "" &&
					request.status === expectedStatus,
			);
		assert.equal(
			matchingRequests.length,
			1,
			`updater must request filename-addressed patch ${patchName} exactly once`,
		);
		const requestIndex = matchingRequests[0].requestIndex;
		assert.equal(
			requestIndex > (patchRequestIndexes.at(-1) ?? metadataRequest),
			true,
			`patch request ${index + 1} was out of order: ${patchName}`,
		);
		patchRequestIndexes.push(requestIndex);
	}
	if (expectedDownloadPath === "patch") {
		assert.equal(
			phaseRequests.some((request) => request.pathname.endsWith(".tar.zst")),
			false,
			"multi-hop patch update unexpectedly fetched a full archive",
		);
	} else {
		const archiveRequests = phaseRequests
			.map((request, requestIndex) => ({ request, requestIndex }))
			.filter(({ request }) => request.pathname === archiveName);
		assert.equal(
			archiveRequests.length,
			1,
			`full fallback must request ${archiveName} exactly once`,
		);
		const archiveRequest = archiveRequests[0];
		assert.match(
			archiveRequest.request.search,
			/^\?cache=[0-9a-f]{32}$/,
			"full fallback must keep only the historical cache buster",
		);
		assert.equal(archiveRequest.request.status, 200, "full fallback request status");
		assert.equal(
			archiveRequest.requestIndex > patchRequestIndexes.at(-1),
			true,
			`full fallback did not follow the missing patch request`,
		);
	}

	const phaseEvents = recordedEvents().slice(eventStart);
	const sourceVersion = fromRelease.metadata.version;
	const targetVersion = toRelease.metadata.version;
	const sourceStateEvents =
		sourceVersion === INITIAL_VERSION
			? [
					{ event: "integration-bootstrapped", version: sourceVersion },
					{ event: "user-data-seeded", version: sourceVersion },
				]
			: [{ event: "source-data-preserved", version: sourceVersion }];
	const expectedStatuses = [
		{ event: "updater-status", version: sourceVersion, status: "checking-local-tar" },
		{ event: "updater-status", version: sourceVersion, status: "local-tar-found" },
	];
	if (expectedDownloadPath === "patch") {
		for (const [index, patchRelease] of patchReleases.entries()) {
			const source = index === 0 ? fromRelease : patchReleases[index - 1];
			expectedStatuses.push(
				{ event: "updater-status", version: sourceVersion, status: "fetching-patch" },
				{ event: "updater-status", version: sourceVersion, status: "patch-found" },
				{ event: "updater-status", version: sourceVersion, status: "downloading-patch" },
				{ event: "updater-status", version: sourceVersion, status: "applying-patch" },
				{
					event: "updater-status",
					version: sourceVersion,
					status: "patch-applied",
					verify: (entry) =>
						entry.details?.details?.patchNumber === index + 1 &&
						entry.details?.details?.totalPatchesApplied === index + 1 &&
						entry.details?.details?.fromHash === source.metadata.hash &&
						entry.details?.details?.toHash === patchRelease.metadata.hash &&
						entry.details?.details?.currentHash === patchRelease.metadata.hash,
				},
			);
		}
		expectedStatuses.push({
			event: "updater-status",
			version: sourceVersion,
			status: "patch-chain-complete",
			verify: (entry) =>
				entry.details?.details?.usedPatchPath === true &&
				entry.details?.details?.totalPatchesApplied === patchReleases.length,
		});
	} else {
		expectedStatuses.push(
			{ event: "updater-status", version: sourceVersion, status: "fetching-patch" },
			{
				event: "updater-status",
				version: sourceVersion,
				status: "patch-not-found",
				verify: (entry) => entry.details?.details?.totalPatchesApplied === 0,
			},
			{ event: "updater-status", version: sourceVersion, status: "downloading-full-bundle" },
		);
	}
	assertOrderedPhaseEvents(
		phaseEvents,
		[
			{ event: "launched", version: sourceVersion },
			...sourceStateEvents,
			...expectedStatuses,
			{
				event: "updater-status",
				version: sourceVersion,
				status: "download-complete",
				verify: (entry) =>
					entry.details?.details?.usedPatchPath ===
						(expectedDownloadPath === "patch") &&
					entry.details?.details?.totalPatchesApplied ===
						(expectedDownloadPath === "patch" ? patchReleases.length : 0),
			},
			{ event: "download-completed", version: sourceVersion },
			{ event: "launched", version: targetVersion },
			{ event: "user-data-preserved", version: targetVersion },
			{ event: "update-result-reconciled", version: targetVersion },
			{ event: "target-relaunched", version: targetVersion },
		],
		`${sourceVersion} -> ${targetVersion}`,
	);
	assert.equal(
		phaseEvents.filter(
			(entry) =>
				entry.event === "updater-status" &&
				entry.version === sourceVersion &&
				entry.details?.status === "patch-applied",
		).length,
		expectedDownloadPath === "patch" ? patchReleases.length : 0,
		`${sourceVersion} -> ${targetVersion} patch-applied count`,
	);
	for (const intermediateRelease of patchReleases.slice(0, -1)) {
		assert.equal(
			phaseEvents.some(
				(entry) =>
					entry.event === "launched" &&
					entry.version === intermediateRelease.metadata.version,
			),
			false,
			`patch chain unexpectedly launched intermediate ${intermediateRelease.metadata.version}`,
		);
	}
	assert.equal(
		phaseEvents.some(
			(entry) =>
				entry.event === "updater-status" &&
				entry.version === sourceVersion &&
				entry.details?.status ===
					(expectedDownloadPath === "patch" ? "downloading-full-bundle" : "patch-applied"),
		),
		false,
		`${sourceVersion} -> ${targetVersion} mixed patch and fallback success paths`,
	);
	return { resultPath, result };
}

async function verifyFirstPostV1LaunchBootstrap(release) {
	const manager = platform.uninstallerPath(channelRoot);
	const manifestPath = join(channelRoot, ".electrobun-uninstall.json");
	assert.equal(pathExists(manager), true, "pre-bootstrap manager is missing");
	assert.equal(pathExists(manifestPath), true, "pre-bootstrap manifest is missing");
	rmSync(manager, { force: true });
	rmSync(manifestPath, { force: true });
	assert.equal(pathExists(manager), false);
	assert.equal(pathExists(manifestPath), false);
	writeFileSync(bootstrapVerificationPath, `${token}\n`, "utf8");
	// Let the first target runtime and its outer launcher finish before asking
	// the installed launcher to exercise the first-v2-runtime repair independently.
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
	launchInstalledApp();
	await waitFor("first-v2-runtime integration bootstrap", () =>
		eventWasRecorded("target-bootstrap-repaired", PATCH_TARGET_VERSION),
	);
	await waitFor("bootstrapped standalone manager", () =>
		pathExists(manager) && pathExists(manifestPath),
	);
	cleanupManifest = assertInstalledIdentity(release).manifest;
	await platform.verifyInstalled(
		channelRoot,
		appBundlePath,
		cleanupManifest,
		release,
	);
	rmSync(bootstrapVerificationPath, { force: true });
}

async function uninstallAndVerify() {
	const manager = platform.uninstallerPath(channelRoot);
	assert.equal(pathExists(manager), true, `cannot run missing uninstaller: ${manager}`);
	const launcher = platform.launcherPath(appBundlePath);
	assert.equal(pathExists(launcher), true, `cannot run missing launcher: ${launcher}`);
	await run(launcher, ["--uninstall", "--quiet", "--delete-data"], {
		cwd: dirname(launcher),
		env: profile.environment,
		label: "delegate app-and-data uninstall through installed launcher",
		timeout: 2 * 60_000,
	});
	await waitFor("uninstaller cleanup", () => !pathExists(channelRoot), 90_000);
	assert.equal(pathExists(appBundlePath), false, "uninstaller left the installed app bundle");
	assert.equal(pathExists(channelRoot), false, `uninstaller left install state: ${channelRoot}`);
	await platform.verifyUninstalled(
		identifier,
		completedUpdateResults,
		cleanupManifest,
	);
	uninstallVerified = true;
	installed = false;
}

async function bestEffortCleanup() {
	let cleanupFailure;
	rememberUpdateTransactions([channelRoot]);
	for (const child of backgroundChildren) {
		try {
			child.kill();
		} catch {}
	}
	if (installed && pathExists(platform.uninstallerPath(channelRoot))) {
		try {
			await run(platform.uninstallerPath(channelRoot), ["--uninstall", "--quiet", "--delete-data"], {
				cwd: temporaryRoot,
				env: profile.environment,
				label: "best-effort fixture uninstall",
				timeout: 90_000,
			});
			await waitFor("best-effort fixture cleanup", () => !pathExists(channelRoot), 45_000);
		} catch (error) {
			console.error(`[updater-e2e] cleanup warning: ${error.message}`);
		}
	}
	try {
		await platform.cleanup(
			identifier,
			[channelRoot],
			[appBundlePath],
			[...cleanupTransactionIds],
			cleanupManifest,
		);
	} catch (error) {
		console.error(`[updater-e2e] platform cleanup warning: ${error.message}`);
		cleanupFailure = error;
	}
	if (server) {
		server.closeAllConnections?.();
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
	if (!keepTemporary) {
		assertWithin(temporaryBase, temporaryRoot, "temporary cleanup root");
		await removeTreeWithRetry(temporaryRoot);
	} else {
		console.log(`[updater-e2e] preserved temporary root: ${temporaryRoot}`);
	}
	if (cleanupFailure) throw cleanupFailure;
}

function platformAdapter() {
	const commonProfile = (root, identifierValue) => {
		const home = join(root, "profile");
		mkdirSync(home, { recursive: true });
		return { home, identifier: identifierValue };
	};

	if (process.platform === "win32") {
		return {
			name: "Windows",
			uninstallManifestHasVersion: false,
			installerRelaunches: true,
			updatePlatform: "win",
			updateArch: "x64",
			isInstaller: (name) => name.endsWith(".zip") && name.includes("Setup"),
			createProfile(root, identifierValue) {
				const value = commonProfile(root, identifierValue);
				const localAppData = resolve(
					process.env.LOCALAPPDATA ||
						join(process.env.USERPROFILE || process.env.HOME || "", "AppData", "Local"),
				);
				const roaming = resolve(
					process.env.APPDATA ||
						join(process.env.USERPROFILE || process.env.HOME || "", "AppData", "Roaming"),
				);
				const temp = resolve(process.env.TEMP || process.env.TMP || join(localAppData, "Temp"));
				for (const path of [localAppData, roaming, temp]) {
					assert.equal(resolve(path).length > 3, true, `unsafe Windows profile path: ${path}`);
				}
				return {
					...value,
					dataRoot: localAppData,
					channelRoot: join(localAppData, identifierValue, CHANNEL),
					environment: {
						...process.env,
						LOCALAPPDATA: localAppData,
						APPDATA: roaming,
						TEMP: temp,
						TMP: temp,
						ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1",
					},
				};
			},
			appBundlePath: (_profileValue, _name, root) => join(root, "app"),
			versionPath: (app) => join(app, "Resources", "version.json"),
			launcherPath: (app) => join(app, "bin", "launcher.exe"),
			bundledUninstallerPath: (app) => join(app, "Resources", "uninstall"),
			uninstallerPath: (root) => join(root, "uninstall.exe"),
			async install(installer, profileValue) {
				const staging = join(temporaryRoot, "windows-installer");
				mkdirSync(staging, { recursive: true });
				await run("tar.exe", ["-xf", installer, "-C", staging], {
					cwd: temporaryRoot,
					label: "unpack Windows installer",
				});
				const setup = exactlyOne(
					listFilesRecursively(staging).filter(
						(path) => basename(path).toLowerCase() === `${artifactAppName}-setup.exe`.toLowerCase(),
					),
					"Windows Setup executable",
				);
				await run(setup, [], {
					cwd: dirname(setup),
					env: profileValue.environment,
					label: "run Windows Setup",
					timeout: 5 * 60_000,
				});
			},
			async verifyInstalled(root, app, manifest, release) {
				assert.equal(manifest.name, appName);
				const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifier}.${CHANNEL}`;
				const registryValue = async (name) => {
					const { stdout } = await run(
						"reg.exe",
						["query", registryKey, "/v", name, "/reg:64"],
						{ cwd: temporaryRoot, label: `query Windows ${name}` },
					);
					const line = stdout
						.split(/\r?\n/)
						.find((candidate) => new RegExp(`\\s${name}\\s`, "i").test(candidate));
					assert.ok(line, `Windows registry value ${name} is missing`);
					const match = line.match(/\sREG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
					assert.ok(match, `could not parse Windows registry value ${name}: ${line}`);
					return match[1].trim();
				};
				assert.equal(
					normalized(await registryValue("InstallLocation")),
					normalized(app),
					"Windows InstallLocation did not migrate",
				);
				assert.equal(
					await registryValue("DisplayVersion"),
					release.metadata.version,
					"Windows DisplayVersion was not refreshed",
				);
				const expectedManager = platform.uninstallerPath(root);
				assert.equal(
					await registryValue("UninstallString"),
					`"${expectedManager}" --uninstall`,
					"Windows UninstallString did not migrate",
				);

				const shortcutTargetScript =
					"$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:UPDATER_LIFECYCLE_E2E_SHORTCUT); [Console]::Out.Write($shortcut.TargetPath)";
				for (const shortcut of [
					manifest.desktop_shortcut,
					manifest.start_menu_shortcut,
				]) {
					assert.equal(pathExists(shortcut), true, `Windows shortcut missing: ${shortcut}`);
					const { stdout } = await run(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							shortcutTargetScript,
						],
						{
							cwd: temporaryRoot,
							env: {
								...process.env,
								UPDATER_LIFECYCLE_E2E_SHORTCUT: shortcut,
							},
							label: `resolve Windows shortcut ${basename(shortcut)}`,
						},
					);
					assert.equal(
						normalized(stdout.trim()),
						normalized(platform.launcherPath(app)),
						`Windows shortcut did not migrate: ${shortcut}`,
					);
				}
			},
			async verifyUninstalled(identifierValue, results, manifest) {
				for (const result of results) {
					const task = `ApplicationUpdate_${result.transaction_id.slice(0, 24)}`;
					assert.notEqual(
						await runStatus("schtasks.exe", ["/query", "/tn", task]),
						0,
						`scheduled updater task survived uninstall: ${task}`,
					);
				}
				const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifierValue}.${CHANNEL}`;
				assert.notEqual(
					await runStatus("reg.exe", ["query", registryKey, "/reg:64"]),
					0,
					`uninstall registry key survived cleanup: ${registryKey}`,
				);
				for (const shortcut of [
					manifest?.desktop_shortcut,
					manifest?.start_menu_shortcut,
				]) {
					if (shortcut) {
						assert.equal(pathExists(shortcut), false, `shortcut survived uninstall: ${shortcut}`);
					}
				}
			},
			async cleanup(identifierValue, roots, apps, transactionIds, manifest) {
				const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifierValue}.${CHANNEL}`;
				const expectedApps = roots.map((root) => join(root, "app"));
				assert.deepEqual(
					new Set(apps.map(normalized)),
					new Set(expectedApps.map(normalized)),
					"Windows cleanup app identities",
				);
				const stopExactProcesses =
					"$root = [IO.Path]::GetFullPath($env:UPDATER_LIFECYCLE_E2E_APP_ROOT).TrimEnd('\\') + '\\'; " +
					"Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | " +
					"ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
				for (const app of apps) {
					await runStatus(
						"powershell.exe",
						["-NoProfile", "-NonInteractive", "-Command", stopExactProcesses],
						{
							env: {
								...process.env,
								UPDATER_LIFECYCLE_E2E_APP_ROOT: app,
							},
							timeout: 30_000,
						},
					);
				}
				await runStatus("reg.exe", ["delete", registryKey, "/f", "/reg:64"]);
				for (const transactionId of transactionIds) {
					assert.match(transactionId, /^[0-9a-f]{32}$/);
					const task = `ApplicationUpdate_${transactionId.slice(0, 24)}`;
					await runStatus("schtasks.exe", ["/end", "/tn", task]);
					await runStatus("schtasks.exe", ["/delete", "/tn", task, "/f"]);
				}
				const expectedRoot = join(
					resolve(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local")),
					identifierValue,
					CHANNEL,
				);
				assert.deepEqual(
					new Set(roots.map(normalized)),
					new Set([normalized(expectedRoot)]),
					"Windows cleanup root identities",
				);
				if (manifest) {
					const expectedShortcutName = `${appName}.lnk`;
					for (const shortcut of [
						manifest.desktop_shortcut,
						manifest.start_menu_shortcut,
					]) {
						assert.equal(typeof shortcut, "string", "recorded shortcut path");
						assert.equal(
							basename(shortcut),
							expectedShortcutName,
							"refusing to clean an unexpected shortcut",
						);
						rmSync(shortcut, { force: true });
					}
				}
				for (const root of roots) {
					await removeTreeWithRetry(root);
				}
				const identifierRoot = dirname(expectedRoot);
				assert.equal(basename(identifierRoot), identifierValue);
				await removeTreeWithRetry(identifierRoot);
				const roamingIdentifierRoot = join(
					resolve(process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming")),
					identifierValue,
				);
				assert.equal(basename(roamingIdentifierRoot), identifierValue);
				await removeTreeWithRetry(roamingIdentifierRoot);
			},
		};
	}

	if (process.platform === "darwin") {
		return {
			name: "macOS",
			uninstallManifestHasVersion: true,
			installerRelaunches: true,
			updatePlatform: "macos",
			updateArch: process.arch === "arm64" ? "arm64" : "x64",
			isInstaller: (name) => name.endsWith(".dmg"),
			createProfile(_root, identifierValue) {
				const home = resolve(homedir());
				const dataRoot = join(home, "Library", "Application Support");
				assert.equal(home.length > 1, true, `unsafe macOS home path: ${home}`);
				return {
					home,
					identifier: identifierValue,
					dataRoot,
					channelRoot: join(
						dataRoot,
						identifierValue,
						CHANNEL,
					),
					environment: {
						...process.env,
						HOME: home,
						ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1",
					},
				};
			},
			appBundlePath: (_profileValue, name) =>
				join(temporaryRoot, "Applications", `${name}.app`),
			versionPath: (app) => join(app, "Contents", "Resources", "version.json"),
			launcherPath: (app) => join(app, "Contents", "MacOS", "launcher"),
			bundledUninstallerPath: (app) =>
				join(app, "Contents", "Resources", "uninstall"),
			uninstallerPath: (root) => join(root, "uninstall"),
			async install(installer, profileValue, name) {
				const mount = join(temporaryRoot, "dmg-mount");
				mkdirSync(mount, { recursive: true });
				await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, installer], {
					cwd: temporaryRoot,
					label: "mount macOS installer image",
				});
				try {
					const sourceApp = exactlyOne(
						readdirSync(mount)
							.filter((entry) => entry.endsWith(".app"))
							.map((entry) => join(mount, entry)),
						"macOS installer app",
					);
					mkdirSync(dirname(appBundlePath), { recursive: true });
					await run("ditto", [sourceApp, appBundlePath], {
						cwd: temporaryRoot,
						label: "copy macOS installer app",
					});
				} finally {
					await run("hdiutil", ["detach", mount], {
						cwd: temporaryRoot,
						label: "detach macOS installer image",
					});
				}
				const installerExecutable = join(appBundlePath, "Contents", "MacOS", "launcher");
				await run(installerExecutable, [], {
					cwd: dirname(installerExecutable),
					env: profileValue.environment,
					label: "run macOS installer app",
					timeout: 5 * 60_000,
				});
			},
			async verifyInstalled(_root, app, manifest, release) {
				assert.equal(manifest.name, appName);
				assert.equal(manifest.version, release.metadata.version);
				assert.equal(
					normalized(manifest.app_bundle_path),
					normalized(app),
					"macOS uninstall manifest did not retain the installed bundle identity",
				);
			},
			async verifyUninstalled(identifierValue) {
				for (const category of ["Caches", "Logs"]) {
					const identifierRoot = join(
						resolve(homedir()),
						"Library",
						category,
						identifierValue,
					);
					const path = join(identifierRoot, CHANNEL);
					assert.equal(pathExists(path), false, `macOS data survived uninstall: ${path}`);
				}
			},
			async cleanup(identifierValue, roots, apps) {
				for (const app of new Set(apps.map(normalized))) {
					assertWithin(temporaryRoot, app, "macOS cleanup app");
					await removeTreeWithRetry(app);
				}
				const identifierRoot = join(
					resolve(homedir()),
					"Library",
					"Application Support",
					identifierValue,
				);
				const expectedRoots = [join(identifierRoot, CHANNEL)];
				assert.deepEqual(
					new Set(roots.map(normalized)),
					new Set(expectedRoots.map(normalized)),
					"macOS cleanup root identities",
				);
				for (const category of ["Application Support", "Caches", "Logs"]) {
					const categoryIdentifierRoot = join(
						resolve(homedir()),
						"Library",
						category,
						identifierValue,
					);
					assert.equal(basename(categoryIdentifierRoot), identifierValue);
					await removeTreeWithRetry(categoryIdentifierRoot);
				}
			},
		};
	}

	if (process.platform === "linux") {
		return {
			name: "Linux",
			uninstallManifestHasVersion: true,
			installerRelaunches: true,
			updatePlatform: "linux",
			updateArch: process.arch === "arm64" ? "arm64" : "x64",
			isInstaller: (name) => name.endsWith("-Setup.tar.gz"),
			createProfile(root, identifierValue) {
				const value = commonProfile(root, identifierValue);
				const data = join(value.home, ".local", "share");
				const config = join(value.home, ".config");
				const cache = join(value.home, ".cache");
				const state = join(value.home, ".local", "state");
				const desktop = join(value.home, "Desktop");
				for (const path of [data, config, cache, state, desktop]) mkdirSync(path, { recursive: true });
				return {
					...value,
					dataRoot: data,
					cacheRoot: cache,
					stateRoot: state,
					channelRoot: join(data, identifierValue, CHANNEL),
					environment: {
						...process.env,
						HOME: value.home,
						XDG_DATA_HOME: data,
						XDG_CONFIG_HOME: config,
						XDG_CACHE_HOME: cache,
						XDG_STATE_HOME: state,
						ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1",
					},
				};
			},
			appBundlePath: (_profileValue, _name, root) => join(root, "app"),
			versionPath: (app) => join(app, "Resources", "version.json"),
			launcherPath: (app) => join(app, "bin", "launcher"),
			bundledUninstallerPath: (app) => join(app, "Resources", "uninstall"),
			uninstallerPath: (root) => join(root, "uninstall"),
			async install(installer, profileValue) {
				const staging = join(temporaryRoot, "linux-installer");
				mkdirSync(staging, { recursive: true });
				await run("tar", ["-xzf", installer, "-C", staging], {
					cwd: temporaryRoot,
					label: "unpack Linux installer",
				});
				const executable = join(staging, "installer");
				chmodSync(executable, 0o755);
				await run(executable, [], {
					cwd: staging,
					env: profileValue.environment,
					label: "run Linux installer",
					timeout: 5 * 60_000,
				});
			},
			async verifyInstalled(_root, app, manifest, release) {
				assert.equal(manifest.name, appName);
				assert.equal(manifest.version, release.metadata.version);
				const launcher = platform.launcherPath(app);
				for (const entry of [manifest.application_entry, manifest.desktop_entry]) {
					assert.equal(typeof entry, "string", "Linux desktop integration path");
					assert.equal(pathExists(entry), true, `Linux desktop integration missing: ${entry}`);
					assert.equal(
						readFileSync(entry, "utf8").includes(launcher),
						true,
						`Linux desktop integration did not migrate to ${launcher}: ${entry}`,
					);
				}
			},
			async verifyUninstalled(identifierValue, _result, manifest) {
				for (const entry of [manifest?.application_entry, manifest?.desktop_entry]) {
					if (entry) {
						assert.equal(pathExists(entry), false, `desktop integration survived uninstall: ${entry}`);
					}
				}
				for (const base of [profile.dataRoot, profile.cacheRoot, profile.stateRoot]) {
					const identifierRoot = join(base, identifierValue);
					const path = join(identifierRoot, CHANNEL);
					assert.equal(pathExists(path), false, `Linux data survived uninstall: ${path}`);
				}
				assert.equal(
					pathExists(expectedBrowserProfileRoot),
					false,
					`Linux browser profile survived uninstall: ${expectedBrowserProfileRoot}`,
				);
			},
			async cleanup(_identifierValue, roots) {
				for (const root of roots) {
					assertWithin(temporaryRoot, root, "Linux cleanup root");
					await removeTreeWithRetry(root);
				}
			},
		};
	}

	throw new Error(`updater lifecycle E2E is unsupported on ${process.platform}`);
}

async function main() {
	console.log(`[updater-e2e] platform=${platform.name} focus=${focus}`);
	console.log(`[updater-e2e] isolated root=${temporaryRoot}`);
	await prepareHutch();
	const baseUrl = await startReleaseServer();
	const v1 = await buildRelease(INITIAL_VERSION, baseUrl, "v1");
	let v2;
	let v3;
	if (focus === "build" || focus === "update" || focus === "full") {
		publishRelease(v1);
		v2 = await buildRelease(INTERMEDIATE_VERSION, baseUrl, "v2", v1);
		assert.notEqual(v1.metadata.hash, v2.metadata.hash, "v1 and v2 produced the same hash");
		publishRelease(v2);
		v3 = await buildRelease(PATCH_TARGET_VERSION, baseUrl, "v3", v2);
		assert.notEqual(v2.metadata.hash, v3.metadata.hash, "v2 and v3 produced the same hash");
		assert.notEqual(v1.metadata.hash, v3.metadata.hash, "v1 and v3 produced the same hash");
		publishRelease(v3);
		for (const release of [v2, v3]) {
			assert.equal(
				pathExists(join(serverRoot, basename(release.patchPath))),
				true,
				`historical patch was not retained after publishing v3: ${basename(release.patchPath)}`,
			);
		}
	}
	if (focus === "build") {
		const v4 = await buildRelease(FALLBACK_TARGET_VERSION, baseUrl, "v4", v3);
		assert.notEqual(v3.metadata.hash, v4.metadata.hash, "v3 and v4 produced the same hash");
		publishRelease(v4, { includePatch: false });
		assert.equal(
			pathExists(join(serverRoot, basename(v4.patchPath))),
			false,
			"v4 fallback patch was unexpectedly published",
		);
		return;
	}

	await installInitialRelease(v1);
	if (focus === "install") return;
	if (focus === "uninstall") {
		await uninstallAndVerify();
		return;
	}

	if (v1CompatibilitySimulationEnabled) await simulateV1InstallLayout();
	const firstRequestStart = requests.length;
	const firstEventStart = recordedEvents().length;
	const firstPriorResults = new Set(resultFiles());
	launchInstalledApp(PATCH_TARGET_VERSION);
	await waitFor("v3 relaunch sentinel", () => pathExists(patchRelaunchSentinelPath));
	await waitFor("first durable updater result", () =>
		resultFiles().some((path) => !firstPriorResults.has(path)),
	);
	await verifySuccessfulUpdate({
		fromRelease: v1,
		toRelease: v3,
		relaunchSentinelPath: patchRelaunchSentinelPath,
		expectedDownloadPath: "patch",
		patchReleases: [v2, v3],
		requestStart: firstRequestStart,
		eventStart: firstEventStart,
		previousResultPaths: firstPriorResults,
	});
	await verifyFirstPostV1LaunchBootstrap(v3);

	const v4 = await buildRelease(FALLBACK_TARGET_VERSION, baseUrl, "v4", v3);
	assert.notEqual(v3.metadata.hash, v4.metadata.hash, "v3 and v4 produced the same hash");
	assert.notEqual(v2.metadata.hash, v4.metadata.hash, "v2 and v4 produced the same hash");
	assert.notEqual(v1.metadata.hash, v4.metadata.hash, "v1 and v4 produced the same hash");
	publishRelease(v4, { includePatch: false });
	assert.equal(
		pathExists(join(serverRoot, basename(v4.patchPath))),
		false,
		"v4 fallback patch was unexpectedly published",
	);
	for (const release of [v2, v3]) {
		assert.equal(
			pathExists(join(serverRoot, basename(release.patchPath))),
			true,
			`publishing v4 discarded historical patch: ${basename(release.patchPath)}`,
		);
	}
	const secondRequestStart = requests.length;
	const secondEventStart = recordedEvents().length;
	const secondPriorResults = new Set(resultFiles());
	launchInstalledApp(FALLBACK_TARGET_VERSION);
	await waitFor("v4 relaunch sentinel", () => pathExists(fallbackRelaunchSentinelPath));
	await waitFor("second durable updater result", () =>
		resultFiles().some((path) => !secondPriorResults.has(path)),
	);
	await verifySuccessfulUpdate({
		fromRelease: v3,
		toRelease: v4,
		relaunchSentinelPath: fallbackRelaunchSentinelPath,
		expectedDownloadPath: "full",
		patchReleases: [v4],
		requestStart: secondRequestStart,
		eventStart: secondEventStart,
		previousResultPaths: secondPriorResults,
	});
	if (focus === "update") return;
	await uninstallAndVerify();
}

let failure;
try {
	await main();
	console.log(
		`[updater-e2e] PASS ${platform.name} ${focus}${uninstallVerified ? " with cleanup" : ""}`,
	);
} catch (error) {
	failure = error;
	console.error(`[updater-e2e] FAIL: ${error.stack || error}`);
} finally {
	try {
		await bestEffortCleanup();
	} catch (cleanupError) {
		if (failure) {
			console.error(`[updater-e2e] cleanup failed: ${cleanupError.stack || cleanupError}`);
		} else {
			failure = cleanupError;
		}
	}
}

if (failure) throw failure;
