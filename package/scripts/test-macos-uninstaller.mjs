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
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.log("macOS uninstaller integration: skipped on non-macOS host");
	process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(packageRoot, "src", "extractor");
const zig = process.env.ELECTROBUN_ZIG ?? join(packageRoot, "vendors", "zig", "zig");
const temporaryRoot = realpathSync(
	mkdtempSync(join(tmpdir(), "electrobun-macos-uninstaller-e2e-")),
);

const identifier = "com.example.uninstaller-e2e";
const unrelatedIdentifier = "com.example.unrelated";
const channel = "production";
const siblingChannel = "canary";
const name = "Uninstaller E2E App";
const version = "9.8.7";

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 120_000,
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

const runExpectingFailure = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `${command} was terminated by ${result.signal}`);
	assert.notEqual(
		result.status,
		0,
		`${command} ${args.join(" ")} unexpectedly succeeded`,
	);
	return result;
};

const pathNodeExists = (path) => {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
};

const assertExists = (path, message = `${path} should exist`) => {
	assert.equal(existsSync(path), true, message);
};

const assertNodeMissing = (path, message = `${path} should not exist`) => {
	assert.equal(pathNodeExists(path), false, message);
};

const writeSentinel = (path, contents) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
};

const createAppBundle = (path, appIdentifier = identifier) => {
	const resources = join(path, "Contents", "Resources");
	mkdirSync(resources, { recursive: true });
	writeFileSync(
		join(resources, "version.json"),
		`${JSON.stringify({
			channel,
			identifier: appIdentifier,
			name,
			version,
		})}\n`,
	);
	writeFileSync(join(resources, "app.keep"), "installed application\n");
};

const createFixture = (
	extractor,
	label,
	{ symlinkCacheIdentifier = false } = {},
) => {
	const root = join(temporaryRoot, `${label} fixture`);
	const home = join(root, "home directory with spaces");
	const applicationSupport = join(home, "Library", "Application Support");
	const caches = join(home, "Library", "Caches");
	const logs = join(home, "Library", "Logs");
	const dataRoot = join(applicationSupport, identifier, channel);
	const cacheIdentifierRoot = join(caches, identifier);
	const cacheRoot = join(caches, identifier, channel);
	const logsRoot = join(logs, identifier, channel);
	const manager = join(dataRoot, "uninstall");
	const manifest = join(dataRoot, ".electrobun-uninstall.json");
	const selfExtraction = join(dataRoot, "self-extraction");
	const app = join(root, "Applications", `${name}.app`);

	mkdirSync(selfExtraction, { recursive: true });
	mkdirSync(logsRoot, { recursive: true });
	createAppBundle(app);
	copyFileSync(extractor, manager);
	chmodSync(manager, 0o755);

	const dataSentinel = join(dataRoot, "application-data.keep");
	const cacheSentinel = join(cacheRoot, "application-cache.keep");
	const logsSentinel = join(logsRoot, "application.log");
	const selfExtractionSentinel = join(selfExtraction, "archive.keep");
	const siblingDataSentinel = join(
		applicationSupport,
		identifier,
		siblingChannel,
		"sibling-data.keep",
	);
	const siblingCacheSentinel = join(
		caches,
		identifier,
		siblingChannel,
		"sibling-cache.keep",
	);
	const siblingLogsSentinel = join(
		logs,
		identifier,
		siblingChannel,
		"sibling.log",
	);
	const unrelatedDataSentinel = join(
		applicationSupport,
		unrelatedIdentifier,
		channel,
		"unrelated-data.keep",
	);
	const unrelatedDocument = join(home, "Documents", "unrelated document.keep");
	const outsideCacheTarget = join(root, "outside managed roots", "cache target");
	const outsideLogsTarget = join(root, "outside managed roots", "logs target");
	const outsideCacheSentinel = join(outsideCacheTarget, "outside-cache.keep");
	const outsideLogsSentinel = join(outsideLogsTarget, "outside-logs.keep");

	writeSentinel(dataSentinel, "application data\n");
	writeSentinel(selfExtractionSentinel, "self extraction state\n");
	writeSentinel(siblingDataSentinel, "sibling channel data\n");
	writeSentinel(siblingLogsSentinel, "sibling channel logs\n");
	writeSentinel(unrelatedDataSentinel, "unrelated application data\n");
	writeSentinel(unrelatedDocument, "unrelated user document\n");
	writeSentinel(outsideCacheSentinel, "outside cache target\n");
	writeSentinel(outsideLogsSentinel, "outside logs target\n");

	if (symlinkCacheIdentifier) {
		mkdirSync(caches, { recursive: true });
		// This is an intermediate component, not the final channel deletion
		// target. The manager must reject it before performing any cleanup.
		symlinkSync(outsideCacheTarget, cacheIdentifierRoot);
	}
	writeSentinel(siblingCacheSentinel, "sibling channel cache\n");
	writeSentinel(cacheSentinel, "application cache\n");
	writeSentinel(logsSentinel, "application logs\n");
	symlinkSync(outsideLogsTarget, join(logsRoot, "outside-target"));

	const installNonce = "0123456789abcdef0123456789abcdef";
	const appPathToken = createHash("sha256")
		.update(installNonce)
		.update("\0")
		.update(identifier)
		.update("\0")
		.update(channel)
		.update("\0")
		.update(app)
		.update("\0")
		.digest("hex");
	writeFileSync(
		manifest,
		`${JSON.stringify(
			{
				app_bundle_path: app,
				app_path_token: appPathToken,
				channel,
				data_path_versions: [1],
				identifier,
				install_nonce: installNonce,
				name,
				schema_version: 1,
				version,
			},
			null,
			2,
		)}\n`,
	);

	return {
		app,
		cacheIdentifierRoot,
		cacheRoot,
		cacheSentinel,
		dataRoot,
		dataSentinel,
		home,
		logsRoot,
		logsSentinel,
		manager,
		manifest,
		outsideCacheSentinel,
		outsideLogsSentinel,
		root,
		selfExtraction,
		selfExtractionSentinel,
		siblingCacheSentinel,
		siblingDataSentinel,
		siblingLogsSentinel,
		unrelatedDataSentinel,
		unrelatedDocument,
	};
};

const managerEnv = (fixture) => ({
	...process.env,
	HOME: fixture.home,
});

const assertUserStatePreserved = (fixture) => {
	for (const path of [
		fixture.dataSentinel,
		fixture.cacheSentinel,
		fixture.logsSentinel,
		fixture.siblingDataSentinel,
		fixture.siblingCacheSentinel,
		fixture.siblingLogsSentinel,
		fixture.unrelatedDataSentinel,
		fixture.unrelatedDocument,
		fixture.outsideCacheSentinel,
		fixture.outsideLogsSentinel,
	]) {
		assertExists(path);
	}
};

const assertUninstallDidNotStart = (fixture) => {
	for (const path of [
		fixture.app,
		fixture.manager,
		fixture.manifest,
		fixture.selfExtractionSentinel,
	]) {
		assertExists(path);
	}
	assertUserStatePreserved(fixture);
};

try {
	run(zig, ["build", "test"], { cwd: extractorRoot });
	run(zig, ["build"], { cwd: extractorRoot });
	const extractor = join(extractorRoot, "zig-out", "bin", "extractor");
	assertExists(extractor, "extractor build output is missing");

	const appOnly = createFixture(extractor, "app only");
	run(appOnly.manager, ["--uninstall", "--quiet"], {
		cwd: appOnly.root,
		env: managerEnv(appOnly),
		timeout: 30_000,
	});
	assertNodeMissing(appOnly.app);
	assertNodeMissing(appOnly.selfExtraction);
	assertNodeMissing(appOnly.manager);
	assertNodeMissing(appOnly.manifest);
	assertExists(appOnly.dataRoot);
	assertUserStatePreserved(appOnly);

	const appAndData = createFixture(extractor, "app and data");
	run(appAndData.manager, ["--quiet", "--delete-data"], {
		cwd: appAndData.root,
		env: managerEnv(appAndData),
		timeout: 30_000,
	});
	assertNodeMissing(appAndData.app);
	assertNodeMissing(appAndData.dataRoot);
	assertNodeMissing(appAndData.cacheRoot);
	assertNodeMissing(appAndData.logsRoot);
	for (const path of [
		appAndData.siblingDataSentinel,
		appAndData.siblingCacheSentinel,
		appAndData.siblingLogsSentinel,
		appAndData.unrelatedDataSentinel,
		appAndData.unrelatedDocument,
		appAndData.outsideCacheSentinel,
		appAndData.outsideLogsSentinel,
	]) {
		assertExists(path);
	}

	const symlinkedCache = createFixture(extractor, "intermediate symlink", {
		symlinkCacheIdentifier: true,
	});
	runExpectingFailure(
		symlinkedCache.manager,
		["--quiet", "--delete-data"],
		{
			cwd: symlinkedCache.root,
			env: managerEnv(symlinkedCache),
		},
	);
	assert.equal(lstatSync(symlinkedCache.cacheIdentifierRoot).isSymbolicLink(), true);
	assertUninstallDidNotStart(symlinkedCache);
	assertExists(symlinkedCache.siblingLogsSentinel);

	const tampered = createFixture(extractor, "tampered manifest");
	const protectedApp = join(
		tampered.root,
		"Applications",
		"Unrelated Protected App.app",
	);
	createAppBundle(protectedApp, unrelatedIdentifier);
	const tamperedManifest = JSON.parse(readFileSync(tampered.manifest, "utf8"));
	tamperedManifest.app_bundle_path = protectedApp;
	writeFileSync(
		tampered.manifest,
		`${JSON.stringify(tamperedManifest, null, 2)}\n`,
	);
	runExpectingFailure(tampered.manager, ["--uninstall", "--quiet"], {
		cwd: tampered.root,
		env: managerEnv(tampered),
	});
	assertExists(protectedApp);
	assertUninstallDidNotStart(tampered);

	console.log(
		"macOS uninstaller integration passed (app-only, app-and-data, preservation, symlink safety, tamper rejection)",
	);
} finally {
	rmSync(temporaryRoot, { force: true, recursive: true });
}
