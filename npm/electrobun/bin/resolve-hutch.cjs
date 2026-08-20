"use strict";

// Hutch resolution for the electrobun npm bin.
//
// The published electrobun package carries the Hutch launcher and engine for
// the host platform as an optionalDependency, so `npm install` fully
// provisions the toolchain: nothing global is created, no shell profile is
// modified, and the paired versions below ride the project's lockfile.
// Machine-wide installs under ~/.hutch (the curl installer) keep working and
// are the fallback when the platform package is absent.

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { get } = require("node:https");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

// Stamped by push-version.js at release time; the release provenance test
// requires it to equal the repository pragma's cli pin. This is what makes
// the npm install deterministic: the vendored launcher runs the engine it
// shipped with instead of resolving the release channel's current head.
// (Cottontail needs no equivalent: the build-time Cottontail is paired with
// this Hutch release inside Hutch itself, and the app-bundled Cottontail is
// pinned by the Electrobun release's devkit manifest.)
const PAIRED_HUTCH_VERSION = "0.23.0";

const ELECTROBUN_VERSION = require("../package.json").version;

const installerBaseUrl = "https://hutch.blackboard.sh/hutch";
const maxInstallerBytes = 1024 * 1024;
const maxInstallerRedirects = 5;

// Hutch owns a separate release-channel contract: its stable executable is
// still published under Hutch's "production" channel.
function normalizeHutchChannel(value) {
	if (value === "stable") return "production";
	if (value === "production" || value === "canary") return value;
	return null;
}

function hutchChannel(environment) {
	for (const key of ["ELECTROBUN_HUTCH_CHANNEL", "HUTCH_ACTIVE_CHANNEL"]) {
		const selected = normalizeHutchChannel(environment[key]);
		if (selected) return selected;
	}
	return "production";
}

function environmentFlagEnabled(environment, name) {
	const value = environment[name];
	return (
		value === "1" ||
		(typeof value === "string" &&
			["true", "yes"].includes(value.toLowerCase()))
	);
}

function platformPackageName(platform, arch) {
	const os =
		platform === "darwin" ? "darwin" :
		platform === "linux" ? "linux" :
		platform === "win32" ? "win32" : null;
	const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
	if (!os || !cpu) return null;
	if (os === "win32" && cpu === "arm64") return null;
	if (os === "darwin" || os === "linux" || cpu === "x64") {
		return `@electrobun/hutch-${os}-${cpu}`;
	}
	return null;
}

function platformPackageBinary(platform, arch, resolvePackageJson, fileExists = existsSync) {
	const name = platformPackageName(platform, arch);
	if (!name) return null;
	let packageJsonPath;
	try {
		packageJsonPath = resolvePackageJson(`${name}/package.json`);
	} catch {
		return null;
	}
	const binary = path.join(
		path.dirname(packageJsonPath),
		"bin",
		platform === "win32" ? "hutch.exe" : "hutch",
	);
	return fileExists(binary) ? binary : null;
}

function globalHutchBinaryPath(channel, environment, platform, userHome) {
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	// HUTCH_HOME is Hutch's own home; DASH_HOME stays honored as a deprecated
	// fallback for Dash Desktop and older setups.
	const hutchHome =
		environment.HUTCH_HOME ||
		environment.DASH_HOME ||
		pathApi.join(userHome, ".hutch");
	const command = channel === "canary" ? "hutch-canary" : "hutch";
	return pathApi.join(
		hutchHome,
		"bin",
		`${command}${platform === "win32" ? ".exe" : ""}`,
	);
}

function download(url, redirects = 0) {
	if (redirects > maxInstallerRedirects) {
		return Promise.reject(new Error("too many installer redirects"));
	}

	let target;
	try {
		target = new URL(url);
	} catch {
		return Promise.reject(new Error("invalid Hutch installer URL"));
	}
	if (target.protocol !== "https:") {
		return Promise.reject(
			new Error("the Hutch installer must be downloaded over HTTPS"),
		);
	}

	return new Promise((resolve, reject) => {
		const request = get(target, (response) => {
			if (
				response.statusCode >= 300 &&
				response.statusCode < 400 &&
				response.headers.location
			) {
				response.resume();
				let redirected;
				try {
					redirected = new URL(response.headers.location, target);
				} catch {
					reject(new Error("invalid Hutch installer redirect URL"));
					return;
				}
				resolve(download(redirected.href, redirects + 1));
				return;
			}

			if (response.statusCode !== 200) {
				response.resume();
				reject(
					new Error(
						`installer download returned HTTP ${response.statusCode ?? "unknown"}`,
					),
				);
				return;
			}

			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxInstallerBytes) {
					request.destroy(
						new Error("installer download exceeded the 1 MiB limit"),
					);
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => resolve(Buffer.concat(chunks)));
			response.on("error", reject);
		});
		request.on("error", reject);
	});
}

function checkedSpawn(command, args, options) {
	const result = spawnSync(command, args, options);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} exited with status ${result.status ?? "unknown"}`,
		);
	}
}

async function installHutch({ channel, environment, platform }) {
	const temporary = mkdtempSync(path.join(tmpdir(), "electrobun-hutch-"));
	try {
		if (platform === "win32") {
			const installer = path.join(temporary, "install.ps1");
			writeFileSync(
				installer,
				await download(`${installerBaseUrl}/install.ps1`),
			);
			checkedSpawn(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					installer,
					"-Channel",
					channel,
				],
				{ env: environment, stdio: "inherit" },
			);
		} else {
			const installer = path.join(temporary, "install.sh");
			writeFileSync(
				installer,
				await download(`${installerBaseUrl}/install.sh`),
				{ mode: 0o700 },
			);
			checkedSpawn("sh", [installer, "--channel", channel], {
				env: environment,
				stdio: "inherit",
			});
		}
	} finally {
		rmSync(temporary, { force: true, recursive: true });
	}
}

// The paired versions are defaults, never overrides: an explicit
// // @hutch pragma or hutch.config.ts pin always wins inside Hutch.
// HUTCH_DEFAULT_CLI selects the vendored engine; HUTCH_DEFAULT_ELECTROBUN
// makes the installed package's own version the project's Electrobun
// release, so the lockfile — not the release channel — decides what an
// unpinned npm project builds against.
function environmentWithPairedDefaults(environment) {
	const enriched = { ...environment };
	if (!enriched.HUTCH_DEFAULT_CLI) {
		enriched.HUTCH_DEFAULT_CLI = PAIRED_HUTCH_VERSION;
	}
	if (!enriched.HUTCH_DEFAULT_ELECTROBUN) {
		enriched.HUTCH_DEFAULT_ELECTROBUN = ELECTROBUN_VERSION;
	}
	return enriched;
}

async function resolveHutchBinary(options = {}) {
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const userHome = options.userHome ?? homedir();
	const fileExists = options.existsSync ?? existsSync;
	const install = options.installHutch ?? installHutch;
	const resolvePackageJson = options.resolvePackageJson ?? require.resolve;

	if (environment.ELECTROBUN_HUTCH_BINARY) {
		const configured = environment.ELECTROBUN_HUTCH_BINARY;
		if (!fileExists(configured)) {
			throw new Error(
				`ELECTROBUN_HUTCH_BINARY does not exist: ${configured}`,
			);
		}
		return configured;
	}

	// `init` bootstraps a machine: a transient npx cache satisfies this run,
	// but the created project's workflow expects `hutch` afterward, so a
	// missing machine-wide launcher is installed as well.
	if (options.ensureGlobalHutch) {
		const channel = hutchChannel(environment);
		const global = globalHutchBinaryPath(channel, environment, platform, userHome);
		if (
			!fileExists(global) &&
			!environmentFlagEnabled(environment, "DASH_RELEASE_OFFLINE")
		) {
			console.error(
				`Electrobun projects use Hutch; installing the latest ${channel} release...`,
			);
			await install({ channel, environment, platform });
		}
	}

	const vendored = platformPackageBinary(platform, arch, resolvePackageJson, fileExists);
	if (vendored) return vendored;

	const channel = hutchChannel(environment);
	const global = globalHutchBinaryPath(channel, environment, platform, userHome);
	if (fileExists(global)) return global;

	if (environmentFlagEnabled(environment, "DASH_RELEASE_OFFLINE")) {
		throw new Error(
			`Hutch is not installed at ${global}; DASH_RELEASE_OFFLINE prevents downloading it`,
		);
	}
	console.error(
		`Electrobun requires Hutch; installing the latest ${channel} release...`,
	);
	await install({ channel, environment, platform });
	if (!fileExists(global)) {
		throw new Error(`Hutch was not installed at ${global}`);
	}
	return global;
}

function runHutch({ binary, args, environment }) {
	const result = spawnSync(binary, args, {
		env: environmentWithPairedDefaults(environment),
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== null) return result.status;
	if (result.signal === "SIGINT") return 130;
	if (result.signal === "SIGTERM") return 143;
	return 1;
}

module.exports = {
	ELECTROBUN_VERSION,
	PAIRED_HUTCH_VERSION,
	environmentWithPairedDefaults,
	globalHutchBinaryPath,
	hutchChannel,
	platformPackageBinary,
	platformPackageName,
	resolveHutchBinary,
	runHutch,
};
