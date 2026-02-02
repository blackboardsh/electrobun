#!/usr/bin/env bun

/**
 * Checks Spotify CDN for the latest stable CEF version and compares it
 * with the default CEF version in src/shared/cef-version.ts.
 *
 * Emits a GitHub Actions ::notice if a newer version is available.
 * Designed to run in the cef-check workflow on a weekly schedule.
 */

import { CEF_VERSION } from "../src/shared/cef-version";

const CEF_INDEX_URL =
	"https://cef-builds.spotifycdn.com/linux64_builds_index.json";

// Fetch the latest stable CEF version from Spotify CDN
async function getLatestStableCEFVersion(): Promise<string> {
	const response = await fetch(CEF_INDEX_URL);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch CEF builds index: HTTP ${response.status}`,
		);
	}

	const data = (await response.json()) as {
		linux64: {
			versions: Array<{
				cef_version: string;
				chromium_version: string;
				channel: string;
			}>;
		};
	};

	const versions = data.linux64?.versions;
	if (!versions || versions.length === 0) {
		throw new Error("No versions found in CEF builds index");
	}

	// Find the latest stable version
	const stable = versions.find((v) => v.channel === "stable");
	if (!stable) {
		throw new Error("No stable CEF version found in builds index");
	}

	return stable.cef_version;
}

async function main() {
	const currentVersion = CEF_VERSION;
	console.log(`Current CEF_VERSION: ${currentVersion}`);

	const latestVersion = await getLatestStableCEFVersion();
	console.log(`Latest stable CEF version on Spotify CDN: ${latestVersion}`);

	if (currentVersion === latestVersion) {
		console.log("CEF version is up to date.");
	} else {
		const message = `New stable CEF version available: ${latestVersion} (current: ${currentVersion})`;
		console.log(message);

		// Emit GitHub Actions notice annotation
		if (process.env.GITHUB_ACTIONS) {
			console.log(`::notice title=New CEF Version Available::${message}`);
		}
	}
}

main().catch((err) => {
	console.error("Error checking CEF version:", err);
	process.exit(1);
});
