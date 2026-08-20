#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareSemver } from "./check-published-bootstrap.mjs";

const defaultRegistry = "https://registry.npmjs.org";
const publicReleasesBaseUrl =
	"https://github.com/blackboardsh/electrobun/releases/download";
export const MIGRATION_BASELINE_VERSION = "1.18.1";
const commandTimeoutMs = 5 * 60_000;
const publicationTimeoutMs = 3 * 60_000;
const publicationPollMs = 5_000;
const requestTimeoutMs = 20_000;
const maxIndexBytes = 1024 * 1024;
const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const dependencyFields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"bundleDependencies",
	"bundledDependencies",
];
const releasedPlatforms = {
	"darwin-arm64": "macos-arm64",
	"linux-arm64": "linux-arm64",
	"linux-x64": "linux-x64",
	"win32-x64": "windows-x64",
};

function fail(message) {
	throw new Error(`published npm acceptance: ${message}`);
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail(`${label} must be an object`);
	}
	return value;
}

function hasEntries(value) {
	if (Array.isArray(value)) return value.length !== 0;
	return (
		value !== undefined &&
		value !== null &&
		(typeof value !== "object" || Object.keys(value).length !== 0)
	);
}

export function validateReleaseCoordinates({
	distTag,
	releaseTag,
	repository,
	version,
}) {
	const versionMatch =
		typeof version === "string" ? version.match(strictSemver) : null;
	if (!versionMatch) {
		fail(`version is not exact SemVer: ${JSON.stringify(version)}`);
	}
	if (releaseTag !== `v${version}`) {
		fail(
			`release tag ${JSON.stringify(releaseTag)} does not exactly match v${version}`,
		);
	}
	const expectedDistTag = versionMatch[4] ? "beta" : "latest";
	if (distTag !== expectedDistTag) {
		fail(
			`npm dist-tag ${JSON.stringify(distTag)} does not match ${expectedDistTag} for ${version}`,
		);
	}
	if (typeof repository !== "string" || !repositoryPattern.test(repository)) {
		fail(`invalid GitHub repository ${JSON.stringify(repository)}`);
	}
	if (repository !== "blackboardsh/electrobun") {
		fail(
			`acceptance must exercise the public blackboardsh/electrobun release, got ${repository}`,
		);
	}
	return {
		distTag,
		releaseTag,
		repository,
		version,
	};
}

export function validateRunnerPlatform(
	expected,
	platform = process.platform,
	arch = process.arch,
) {
	const actual = releasedPlatforms[`${platform}-${arch}`];
	if (!actual) fail(`unsupported acceptance host ${platform}-${arch}`);
	if (expected !== actual) {
		fail(`workflow expected ${JSON.stringify(expected)}, but runner is ${actual}`);
	}
	return actual;
}

export function validatePublishedManifest(manifestValue, version) {
	const manifest = object(manifestValue, "installed electrobun manifest");
	if (manifest.name !== "electrobun" || manifest.version !== version) {
		fail(
			`installed package identity is ${JSON.stringify(manifest.name)}@${JSON.stringify(manifest.version)}, expected electrobun@${version}`,
		);
	}
	if (
		manifest.bin === null ||
		typeof manifest.bin !== "object" ||
		Array.isArray(manifest.bin) ||
		Object.keys(manifest.bin).length !== 1 ||
		manifest.bin.electrobun !== "bin/electrobun.cjs"
	) {
		fail("installed package does not expose only the electrobun bootstrap bin");
	}
	for (const field of dependencyFields) {
		if (hasEntries(manifest[field])) {
			fail(`installed package must not publish ${field}`);
		}
	}
	if (manifest.scripts !== undefined) {
		const scripts = object(manifest.scripts, "installed package scripts");
		if (Object.keys(scripts).length !== 0) {
			fail("installed package must not publish lifecycle scripts");
		}
	}
	return manifest;
}

export function expectedHutchCache({
	hutchHome,
	platform = process.platform,
	arch = process.arch,
	version,
}) {
	const platformKey = releasedPlatforms[`${platform}-${arch}`];
	if (!platformKey) {
		fail(`unsupported acceptance host ${platform}-${arch}`);
	}
	const root = join(hutchHome, "npm", "electrobun", version, platformKey);
	return {
		binary: join(root, "bin", platform === "win32" ? "hutch.exe" : "hutch"),
		manifest: join(root, ".electrobun-cache.json"),
		platformKey,
		releaseMetadata: join(root, "hutch-release.json"),
		root,
	};
}

export function migrationInstallArguments(version) {
	if (typeof version !== "string" || !strictSemver.test(version)) {
		fail(`migration install version is not exact SemVer: ${JSON.stringify(version)}`);
	}
	return [
		"install",
		"--ignore-scripts",
		"--include=optional",
		"--no-audit",
		"--no-fund",
		"--prefer-online",
		"--save-dev",
		"--save-exact",
		`--registry=${defaultRegistry}`,
		`electrobun@${version}`,
	];
}

export function validatePublicArtifactIndex(
	indexValue,
	{ pairedHutchVersion, platformKey, version },
) {
	const index = object(indexValue, "public Hutch artifact index");
	if (index.schemaVersion !== 1) fail("unsupported public Hutch artifact index schema");
	const product = object(index.product, "public Hutch artifact index product");
	if (product.name !== "electrobun" || product.version !== version) {
		fail("public Hutch artifact index has the wrong Electrobun identity");
	}
	const hutch = object(index.hutch, "public Hutch artifact index Hutch release");
	if (hutch.version !== pairedHutchVersion) {
		fail("public Hutch artifact index has the wrong paired Hutch version");
	}
	const platforms = object(index.platforms, "public Hutch artifact index platforms");
	const expectedPlatforms = [...new Set(Object.values(releasedPlatforms))].sort();
	if (
		JSON.stringify(Object.keys(platforms).sort()) !==
		JSON.stringify(expectedPlatforms)
	) {
		fail("public Hutch artifact index does not contain the exact release matrix");
	}
	const selected = object(platforms[platformKey], `${platformKey} public artifact`);
	const archive = object(selected.archive, `${platformKey} public archive`);
	const filename = `electrobun-hutch-${platformKey}.tar.gz`;
	const expectedUrl = `${publicReleasesBaseUrl}/v${version}/${filename}`;
	if (archive.url !== expectedUrl) {
		fail(`${platformKey} public archive URL does not match the exact release`);
	}
	if (!Number.isSafeInteger(archive.size) || archive.size < 1) {
		fail(`${platformKey} public archive size is invalid`);
	}
	if (typeof archive.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(archive.sha256)) {
		fail(`${platformKey} public archive SHA-256 is invalid`);
	}
	return { ...archive, filename };
}

function parseJsonOutput(output, label) {
	try {
		return JSON.parse(output);
	} catch (error) {
		fail(`${label} returned invalid JSON: ${error.message}`);
	}
}

function commandFailure(label, result) {
	const details = [result.stderr, result.stdout]
		.filter((value) => typeof value === "string" && value.trim())
		.map((value) => value.trim())
		.join("\n");
	const suffix = details ? `\n${details}` : "";
	if (result.error) fail(`${label} could not start: ${result.error.message}${suffix}`);
	fail(`${label} exited with status ${result.status ?? "unknown"}${suffix}`);
}

function runCommand(command, args, options = {}) {
	return spawnSync(command, args, {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: commandTimeoutMs,
		windowsHide: true,
		...options,
	});
}

function runChecked(command, args, options, label) {
	const result = runCommand(command, args, options);
	if (result.error || result.status !== 0) commandFailure(label, result);
	return result.stdout;
}

export function npmInvocation(
	args,
	platform = process.platform,
	environment = process.env,
) {
	if (platform !== "win32") return { args, command: "npm" };
	if (args.some((argument) => !/^[A-Za-z0-9@._:/=+?-]+$/.test(argument))) {
		fail("Windows npm invocation received an unsafe command-string argument");
	}
	const systemRoot = environment.SystemRoot || "C:\\Windows";
	const command =
		environment.ComSpec ||
		environment.COMSPEC ||
		join(systemRoot, "System32", "cmd.exe");
	return {
		args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")],
		command,
	};
}

function runNpmResult(args, options) {
	const invocation = npmInvocation(args);
	return runCommand(invocation.command, invocation.args, options);
}

function runNpm(args, options, label) {
	const result = runNpmResult(args, options);
	if (result.error || result.status !== 0) commandFailure(label, result);
	return result.stdout;
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function runNpmEventually(args, options, label, attempts = 3) {
	let result;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		result = runNpmResult(args, options);
		if (!result.error && result.status === 0) return result.stdout;
		if (attempt < attempts) await delay(publicationPollMs);
	}
	commandFailure(label, result);
}

function commandResultSummary(result) {
	if (result.error) return result.error.message;
	const details = [result.stderr, result.stdout]
		.filter((value) => typeof value === "string" && value.trim())
		.map((value) => value.trim())
		.join("; ");
	return details || `status ${result.status ?? "unknown"}`;
}

async function waitForExactNpmTag({ distTag, npmOptions, registry, version }) {
	const deadline = Date.now() + publicationTimeoutMs;
	let lastState = "not queried";
	while (true) {
		const result = runNpmResult(
			[
				"view",
				`electrobun@${distTag}`,
				"version",
				"--json",
				`--registry=${registry}`,
			],
			{ ...npmOptions, timeout: 30_000 },
		);
		if (!result.error && result.status === 0) {
			const taggedVersion = parseJsonOutput(result.stdout, "npm dist-tag query");
			if (taggedVersion === version) return;
			if (typeof taggedVersion !== "string" || !strictSemver.test(taggedVersion)) {
				fail(`npm dist-tag ${distTag} returned invalid version metadata`);
			}
			const comparison = compareSemver(taggedVersion, version);
			if (comparison >= 0) {
				fail(
					`npm dist-tag ${distTag} points to ${taggedVersion}, refusing acceptance of ${version}`,
				);
			}
			lastState = `still points to older ${taggedVersion}`;
		} else {
			lastState = commandResultSummary(result);
		}
		if (Date.now() >= deadline) {
			fail(
				`npm dist-tag ${distTag} did not expose exact ${version} before the publication timeout: ${lastState}`,
			);
		}
		await delay(publicationPollMs);
	}
}

async function fetchPublicIndex(version) {
	const url = `${publicReleasesBaseUrl}/v${version}/hutch-artifacts.json`;
	const deadline = Date.now() + publicationTimeoutMs;
	let lastState = "not fetched";
	while (true) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
		try {
			const response = await fetch(url, {
				headers: { accept: "application/json" },
				redirect: "follow",
				signal: controller.signal,
			});
			if (response.ok) {
				const declared = Number(response.headers.get("content-length"));
				if (Number.isFinite(declared) && declared > maxIndexBytes) {
					fail("public Hutch artifact index exceeds its size limit");
				}
				const bytes = Buffer.from(await response.arrayBuffer());
				if (bytes.length > maxIndexBytes) {
					fail("public Hutch artifact index exceeds its size limit");
				}
				return parseJsonOutput(bytes.toString("utf8"), "public Hutch artifact index");
			}
			lastState = `HTTP ${response.status}`;
		} catch (error) {
			if (error.message?.startsWith("published npm acceptance:")) throw error;
			lastState = error.message;
		} finally {
			clearTimeout(timeout);
		}
		if (Date.now() >= deadline) {
			fail(
				`exact public GitHub Release index did not become readable before the publication timeout: ${lastState}`,
			);
		}
		await delay(publicationPollMs);
	}
}

function deleteEnvironmentKeys(environment, names) {
	const normalized = new Set(names.map((name) => name.toUpperCase()));
	for (const key of Object.keys(environment)) {
		if (normalized.has(key.toUpperCase())) delete environment[key];
	}
}

function isolatedEnvironment({
	hutchHome,
	npmCache,
	npmrc,
	registry,
}) {
	const environment = { ...process.env };
	deleteEnvironmentKeys(environment, [
		"DASH_HOME",
		"DASH_RELEASE_BASE_URL",
		"DASH_RELEASE_OFFLINE",
		"ELECTROBUN_HUTCH_BINARY",
		"ELECTROBUN_RELEASES_BASE_URL",
		"HUTCH_ACTIVE_CHANNEL",
		"HUTCH_DEFAULT_CLI",
		"HUTCH_DEFAULT_COTTONTAIL",
		"HUTCH_DEFAULT_ELECTROBUN",
		"HUTCH_HOME",
		"HUTCH_RELEASE_BASE_URL",
		"NODE_PATH",
		"NODE_AUTH_TOKEN",
		"NPM_CONFIG_CACHE",
		"NPM_CONFIG_GLOBALCONFIG",
		"NPM_CONFIG_OMIT",
		"NPM_CONFIG_REGISTRY",
		"NPM_CONFIG_USERCONFIG",
		"NPM_TOKEN",
	]);
	return {
		...environment,
		HUTCH_ACTIVE_CHANNEL: "production",
		HUTCH_HOME: hutchHome,
		HUTCH_NO_UPDATE_CHECK: "1",
		NO_UPDATE_NOTIFIER: "1",
		npm_config_cache: npmCache,
		npm_config_registry: registry,
		npm_config_update_notifier: "false",
		npm_config_userconfig: npmrc,
	};
}

function assertPathWithin(candidate, parent, label) {
	const fromParent = relative(realpathSync(parent), realpathSync(candidate));
	if (
		fromParent === "" ||
		fromParent === ".." ||
		fromParent.startsWith(`..${sep}`) ||
		resolve(fromParent) === fromParent
	) {
		fail(`${label} escaped its isolated root`);
	}
}

function isRecursivelyEmptyDirectory(path) {
	if (!lstatSync(path).isDirectory()) return false;
	return readdirSync(path).every((entry) =>
		isRecursivelyEmptyDirectory(join(path, entry)),
	);
}

export function validateMigratedNodeModules(nodeModules) {
	const installedEntries = readdirSync(nodeModules).sort();
	const expectedEntries = [".bin", ".package-lock.json", "electrobun"];
	if (installedEntries.includes("@electrobun")) {
		fail("node_modules/@electrobun exists; platform packages must not be installed");
	}
	const missingEntries = expectedEntries.filter(
		(entry) => !installedEntries.includes(entry),
	);
	if (missingEntries.length !== 0) {
		fail(`node_modules is missing required entries: ${missingEntries.join(", ")}`);
	}
	const residualEntries = installedEntries.filter(
		(entry) => !expectedEntries.includes(entry),
	);
	const nonemptyEntries = residualEntries.filter(
		(entry) => !isRecursivelyEmptyDirectory(join(nodeModules, entry)),
	);
	if (nonemptyEntries.length !== 0) {
		fail(
			`node_modules contains files or packages left by the v1 migration: ${nonemptyEntries.join(", ")}`,
		);
	}
}

function inspectInstalledPackage(project, version) {
	const nodeModules = join(project, "node_modules");
	const packageRoot = join(nodeModules, "electrobun");
	const manifestPath = join(packageRoot, "package.json");
	const manifest = validatePublishedManifest(
		parseJsonOutput(readFileSync(manifestPath, "utf8"), "installed manifest"),
		version,
	);
	assertPathWithin(packageRoot, nodeModules, "installed electrobun package");
	validateMigratedNodeModules(nodeModules);
	if (existsSync(join(packageRoot, "node_modules"))) {
		fail("the electrobun bootstrap unexpectedly contains nested node_modules");
	}
	const entry = join(packageRoot, ...manifest.bin.electrobun.split("/"));
	if (!lstatSync(entry).isFile()) fail("published electrobun bin is not a file");
	const npmBin = join(
		nodeModules,
		".bin",
		process.platform === "win32" ? "electrobun.cmd" : "electrobun",
	);
	if (!existsSync(npmBin)) fail("npm did not create the electrobun bin shim");

	const projectManifest = object(
		parseJsonOutput(
			readFileSync(join(project, "package.json"), "utf8"),
			"acceptance project manifest",
		),
		"acceptance project manifest",
	);
	if (
		projectManifest.devDependencies?.electrobun !== version ||
		projectManifest.dependencies?.electrobun !== undefined
	) {
		fail("v1 to v2 migration did not save exact Electrobun as a dev dependency");
	}

	const lock = object(
		parseJsonOutput(
			readFileSync(join(project, "package-lock.json"), "utf8"),
			"acceptance package lock",
		),
		"acceptance package lock",
	);
	const packages = object(lock.packages, "acceptance package lock packages");
	const lockedPaths = Object.keys(packages).sort();
	if (
		JSON.stringify(lockedPaths) !==
		JSON.stringify(["", "node_modules/electrobun"])
	) {
		fail(`package lock retained old or platform packages: ${lockedPaths.join(", ")}`);
	}
	if (packages[""].devDependencies?.electrobun !== version) {
		fail("package lock root does not pin exact Electrobun as a dev dependency");
	}
	const lockedPackage = object(
		packages["node_modules/electrobun"],
		"locked electrobun package",
	);
	let resolvedPackage;
	try {
		resolvedPackage = new URL(lockedPackage.resolved);
	} catch {
		fail("package lock electrobun tarball URL is invalid");
	}
	if (
		lockedPackage.version !== version ||
		lockedPackage.dev !== true ||
		resolvedPackage.origin !== new URL(defaultRegistry).origin ||
		!resolvedPackage.pathname.startsWith("/electrobun/-/electrobun-") ||
		!resolvedPackage.pathname.endsWith(".tgz") ||
		typeof lockedPackage.integrity !== "string" ||
		!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(lockedPackage.integrity)
	) {
		fail("package lock has an invalid exact electrobun package entry");
	}
	return { entry, manifest, packageRoot };
}

function inspectDownloadedCache({
	cache,
	archive,
	pairedHutchVersion,
	version,
}) {
	if (!existsSync(cache.binary)) fail(`paired Hutch was not cached at ${cache.binary}`);
	if (!lstatSync(cache.binary).isFile()) fail("cached Hutch binary is not a file");
	assertPathWithin(cache.binary, cache.root, "cached Hutch binary");

	const cacheManifest = object(
		parseJsonOutput(readFileSync(cache.manifest, "utf8"), "Hutch cache manifest"),
		"Hutch cache manifest",
	);
	if (
		cacheManifest.electrobunVersion !== version ||
		cacheManifest.hutchVersion !== pairedHutchVersion ||
		cacheManifest.platform !== cache.platformKey ||
		cacheManifest.archiveSha256 !== archive.sha256
	) {
		fail("Hutch cache manifest does not match the exact public GitHub archive");
	}

	const releaseMetadata = object(
		parseJsonOutput(
			readFileSync(cache.releaseMetadata, "utf8"),
			"cached Hutch release metadata",
		),
		"cached Hutch release metadata",
	);
	if (
		releaseMetadata.product !== "hutch" ||
		releaseMetadata.version !== pairedHutchVersion ||
		releaseMetadata.platform !== cache.platformKey
	) {
		fail("cached Hutch release metadata has the wrong identity");
	}
}

export async function acceptPublishedBootstrap(options) {
	const coordinates = validateReleaseCoordinates(options);
	const platformKey = validateRunnerPlatform(options.platform);
	const registry = defaultRegistry;
	const temporary = mkdtempSync(join(tmpdir(), "electrobun npm Ω-"));
	const project = join(temporary, "migration project");
	const hutchHome = join(temporary, "isolated hutch home Ω");
	const npmCache = join(temporary, "isolated npm cache Ω");
	const npmrc = join(temporary, "empty.npmrc");

	try {
		for (const directory of [project, hutchHome, npmCache]) {
			mkdirSync(directory, { recursive: true });
		}
		writeFileSync(npmrc, "", { flag: "wx" });
		writeFileSync(
			join(project, "package.json"),
			`${JSON.stringify({
				name: "electrobun-published-acceptance",
				private: true,
				scripts: { "acceptance:shim": "electrobun --help" },
			})}\n`,
			{ flag: "wx" },
		);

		const environment = isolatedEnvironment({
			hutchHome,
			npmCache,
			npmrc,
			registry,
		});
		const npmOptions = { cwd: project, env: environment };
		await waitForExactNpmTag({
			distTag: coordinates.distTag,
			npmOptions,
			registry,
			version: coordinates.version,
		});

		runNpm(
			migrationInstallArguments(MIGRATION_BASELINE_VERSION),
			npmOptions,
			`install migration baseline electrobun@${MIGRATION_BASELINE_VERSION}`,
		);
		await runNpmEventually(
			migrationInstallArguments(coordinates.version),
			npmOptions,
			`upgrade v1 project to electrobun@${coordinates.version}`,
		);

		const installed = inspectInstalledPackage(project, coordinates.version);
		const require = createRequire(import.meta.url);
		const resolver = require(join(installed.packageRoot, "bin", "resolve-hutch.cjs"));
		if (
			resolver.ELECTROBUN_VERSION !== coordinates.version ||
			typeof resolver.PAIRED_HUTCH_VERSION !== "string" ||
			!strictSemver.test(resolver.PAIRED_HUTCH_VERSION)
		) {
			fail("published resolver has invalid stamped product or Hutch versions");
		}
		const cache = expectedHutchCache({
			hutchHome,
			version: coordinates.version,
		});
		if (
			cache.platformKey !== platformKey ||
			resolver.hutchPlatformKey(process.platform, process.arch) !== platformKey
		) {
			fail("published resolver disagrees with the release platform matrix");
		}
		const publicIndex = await fetchPublicIndex(coordinates.version);
		const archive = validatePublicArtifactIndex(publicIndex, {
			pairedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
			platformKey,
			version: coordinates.version,
		});
		runNpm(
			["run", "--silent", "acceptance:shim"],
			npmOptions,
			"cold published electrobun npm bin",
		);
		const globalFallback = join(
			hutchHome,
			"bin",
			process.platform === "win32" ? "hutch.exe" : "hutch",
		);
		if (existsSync(globalFallback)) {
			fail(`shim installed a global Hutch fallback at ${globalFallback}`);
		}
		const resolverRoot = resolver.downloadedHutchRoot(
			environment,
			process.platform,
			temporary,
			cache.platformKey,
		);
		if (resolve(resolverRoot) !== resolve(cache.root)) {
			fail(`published resolver selected unexpected cache root ${resolverRoot}`);
		}
		inspectDownloadedCache({
			archive,
			cache,
			pairedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
			version: coordinates.version,
		});
		const cachedVersion = runChecked(
			cache.binary,
			["--version"],
			{ cwd: project, env: environment },
			"cached Hutch version probe",
		).trim();
		if (cachedVersion !== resolver.PAIRED_HUTCH_VERSION) {
			fail(
				`cached Hutch reported ${JSON.stringify(cachedVersion)}, expected ${resolver.PAIRED_HUTCH_VERSION}`,
			);
		}

		const offlineEnvironment = {
			...environment,
			DASH_RELEASE_OFFLINE: "1",
		};
		const offlineResolved = await resolver.resolveHutchBinary({
			environment: offlineEnvironment,
		});
		if (realpathSync(offlineResolved) !== realpathSync(cache.binary)) {
			fail(`offline resolver selected unexpected Hutch path ${offlineResolved}`);
		}
		runNpm(
			["run", "--silent", "acceptance:shim"],
			{ cwd: project, env: offlineEnvironment },
			"warm offline published electrobun npm bin",
		);
		if (existsSync(globalFallback)) {
			fail(`offline shim installed a global Hutch fallback at ${globalFallback}`);
		}

		return {
			cacheRoot: cache.root,
			hutchVersion: resolver.PAIRED_HUTCH_VERSION,
			platform: cache.platformKey,
			version: coordinates.version,
		};
	} finally {
		try {
			rmSync(temporary, {
				force: true,
				maxRetries: 8,
				recursive: true,
				retryDelay: 100,
			});
		} catch (error) {
			console.warn(
				`published npm acceptance: could not remove private temporary directory: ${error.message}`,
			);
		}
	}
}

function parseArguments(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined) fail("invalid arguments");
		if (flag === "--version") options.version = value;
		else if (flag === "--release-tag") options.releaseTag = value;
		else if (flag === "--dist-tag") options.distTag = value;
		else if (flag === "--repository") options.repository = value;
		else if (flag === "--platform") options.platform = value;
		else fail(`unknown argument ${flag}`);
	}
	for (const key of [
		"version",
		"releaseTag",
		"distTag",
		"repository",
		"platform",
	]) {
		if (!options[key]) fail(`missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
	}
	return options;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const result = await acceptPublishedBootstrap(
			parseArguments(process.argv.slice(2)),
		);
		console.log(
			`Accepted electrobun@${result.version} on ${result.platform} with paired Hutch ${result.hutchVersion}; cold GitHub acquisition and warm offline reuse passed.`,
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
