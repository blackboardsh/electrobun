#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { get } = require("node:https");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

const installerBaseUrl = "https://hutch.blackboard.sh/hutch";
const maxInstallerBytes = 1024 * 1024;
const maxInstallerRedirects = 5;

function normalizeChannel(value) {
	if (value === "stable") return "production";
	if (value === "production" || value === "canary") return value;
	return null;
}

function hutchChannel(environment) {
	for (const key of ["ELECTROBUN_HUTCH_CHANNEL", "HUTCH_ACTIVE_CHANNEL"]) {
		const selected = normalizeChannel(environment[key]);
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

function hutchBinaryPath(channel, environment, platform, userHome) {
	if (environment.ELECTROBUN_HUTCH_BINARY) {
		return environment.ELECTROBUN_HUTCH_BINARY;
	}

	// HUTCH_HOME is Hutch's own home; DASH_HOME stays honored as a deprecated
	// fallback for Dash Desktop and older setups.
	const hutchHome =
		environment.HUTCH_HOME ||
		environment.DASH_HOME ||
		path.join(userHome, ".hutch");
	const command = channel === "canary" ? "hutch-canary" : "hutch";
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	return pathApi.join(
		hutchHome,
		"bin",
		`${command}${platform === "win32" ? ".exe" : ""}`,
	);
}

function hutchArguments(args) {
	const forwarded = Array.from(args);
	if (forwarded[0] !== "init") return forwarded;

	const explicitTemplateChannel = forwarded.some(
		(argument) =>
			argument === "--beta" ||
			argument.startsWith("--channel="),
	);
	return explicitTemplateChannel
		? forwarded
		: [...forwarded, "--channel=stable"];
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

function runHutch({ binary, args, environment }) {
	const result = spawnSync(binary, ["electrobun", ...args], {
		env: environment,
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== null) return result.status;
	if (result.signal === "SIGINT") return 130;
	if (result.signal === "SIGTERM") return 143;
	return 1;
}

async function main(options = {}) {
	const args = hutchArguments(options.args ?? process.argv.slice(2));
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const userHome = options.userHome ?? homedir();
	const fileExists = options.existsSync ?? existsSync;
	const install = options.installHutch ?? installHutch;
	const run = options.runHutch ?? runHutch;
	const channel = hutchChannel(environment);
	const binary = hutchBinaryPath(channel, environment, platform, userHome);

	if (!fileExists(binary)) {
		if (environment.ELECTROBUN_HUTCH_BINARY) {
			throw new Error(`ELECTROBUN_HUTCH_BINARY does not exist: ${binary}`);
		}
		if (environmentFlagEnabled(environment, "DASH_RELEASE_OFFLINE")) {
			throw new Error(
				`Hutch is not installed at ${binary}; DASH_RELEASE_OFFLINE prevents downloading it`,
			);
		}
		console.error(
			`Electrobun requires Hutch; installing the latest ${channel} release...`,
		);
		await install({ channel, environment, platform });
	}

	if (!fileExists(binary)) {
		throw new Error(`Hutch was not installed at ${binary}`);
	}
	return run({ binary, args, environment });
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
	hutchArguments,
	hutchBinaryPath,
	hutchChannel,
	main,
};
