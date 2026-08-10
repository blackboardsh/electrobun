#!/usr/bin/env node
"use strict";

const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { get } = require("node:https");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageVersion = require("../package.json").version;
const installerBaseUrl = "https://hutch.blackboard.sh/hutch";
const maxInstallerBytes = 1024 * 1024;

function normalizeChannel(value) {
	if (value === "stable") return "production";
	if (value === "production" || value === "canary") return value;
	return null;
}

// Electrobun (beta or stable) always runs on STABLE Hutch. Only an explicit
// ELECTROBUN_HUTCH_CHANNEL / HUTCH_ACTIVE_CHANNEL override changes that (e.g. to
// test against a hutch-canary build) — the electrobun version never does.
function hutchChannel(environment) {
	for (const key of ["ELECTROBUN_HUTCH_CHANNEL", "HUTCH_ACTIVE_CHANNEL"]) {
		const selected = normalizeChannel(environment[key]);
		if (selected) return selected;
	}
	return "production";
}

// The Electrobun template channel: "beta" for prerelease builds or an explicit
// --beta, else "stable". Forwarded to `hutch electrobun` as the --beta flag.
function electrobunChannel(version, args) {
	if (Array.isArray(args) && args.includes("--beta")) return "beta";
	return version.includes("-") ? "beta" : "stable";
}

function hutchBinaryPath(channel, environment, platform, userHome) {
	if (environment.ELECTROBUN_HUTCH_BINARY) {
		return environment.ELECTROBUN_HUTCH_BINARY;
	}
	const dashHome = environment.DASH_HOME || path.join(userHome, ".dash");
	const command = channel === "canary" ? "hutch-canary" : "hutch";
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	return pathApi.join(dashHome, "bin", `${command}${platform === "win32" ? ".exe" : ""}`);
}

function download(url, redirects = 0) {
	if (redirects > 5) return Promise.reject(new Error("too many installer redirects"));
	return new Promise((resolve, reject) => {
		const request = get(url, (response) => {
			if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				response.resume();
				resolve(download(new URL(response.headers.location, url).href, redirects + 1));
				return;
			}
			if (response.statusCode !== 200) {
				response.resume();
				reject(new Error(`installer download returned HTTP ${response.statusCode}`));
				return;
			}

			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxInstallerBytes) {
					request.destroy(new Error("installer download exceeded 1 MiB"));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => resolve(Buffer.concat(chunks)));
		});
		request.on("error", reject);
	});
}

function checkedSpawn(command, args, options) {
	const result = spawnSync(command, args, options);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
	}
}

async function installHutch({ channel, environment, platform }) {
	const temporary = mkdtempSync(path.join(tmpdir(), "electrobun-hutch-"));
	try {
		if (platform === "win32") {
			const installer = path.join(temporary, "install.ps1");
			writeFileSync(installer, await download(`${installerBaseUrl}/install.ps1`));
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
			writeFileSync(installer, await download(`${installerBaseUrl}/install.sh`), {
				mode: 0o700,
			});
			checkedSpawn("sh", [installer, "--channel", channel], {
				env: environment,
				stdio: "inherit",
			});
		}
	} finally {
		rmSync(temporary, { force: true, recursive: true });
	}
}

function runHutch({ binary, args, environment }) {
	const result = spawnSync(binary, ["electrobun", ...args], {
		env: environment,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== null) return result.status;
	return result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1;
}

async function main(options = {}) {
	const args = options.args || process.argv.slice(2);
	if (args[0] !== "init") {
		throw new Error(
			"the npm entry point supports only `electrobun init`; use `hutch electrobun` for project commands",
		);
	}
	const environment = options.environment || process.env;
	const platform = options.platform || process.platform;
	const version = options.version || packageVersion;
	const userHome = options.userHome || homedir();
	const fileExists = options.existsSync || existsSync;
	const install = options.installHutch || installHutch;
	const run = options.runHutch || runHutch;
	const channel = hutchChannel(environment);
	const binary = hutchBinaryPath(channel, environment, platform, userHome);

	// Forward the electrobun template channel as --beta to `hutch electrobun`.
	const templateChannel = electrobunChannel(version, args);
	const hutchArgs =
		templateChannel === "beta" && !args.includes("--beta") ? [...args, "--beta"] : args;

	if (!fileExists(binary)) {
		if (environment.ELECTROBUN_HUTCH_BINARY) {
			throw new Error(`ELECTROBUN_HUTCH_BINARY does not exist: ${binary}`);
		}
		console.error(`Electrobun requires Hutch; installing the latest ${channel} release...`);
		await install({ channel, environment, platform });
	}
	if (!fileExists(binary)) throw new Error(`Hutch was not installed at ${binary}`);
	return run({ binary, args: hutchArgs, environment });
}

if (require.main === module) {
	main()
		.then((status) => {
			process.exitCode = status;
		})
		.catch((error) => {
			console.error(`electrobun: ${error.message}`);
			process.exitCode = 1;
		});
}

module.exports = {
	hutchChannel,
	electrobunChannel,
	hutchBinaryPath,
	main,
};
