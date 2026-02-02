#!/usr/bin/env bun

/**
 * Checks Spotify CDN for the latest stable CEF version and compares it
 * with the version in src/shared/cef-version.ts.
 *
 * When a newer version exists:
 *   - Overwrites src/shared/cef-version.ts with the new version pair
 *   - Sets has_update=true in $GITHUB_OUTPUT
 *
 * Always outputs version info to $GITHUB_OUTPUT and a human-readable
 * summary to $GITHUB_STEP_SUMMARY.
 */

import { CEF_VERSION, CHROMIUM_VERSION } from "../src/shared/cef-version";
import { appendFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const CEF_INDEX_URL =
	"https://cef-builds.spotifycdn.com/index.json";

interface StableVersion {
	cef_version: string;
	chromium_version: string;
}

async function getLatestStableCEFVersion(): Promise<StableVersion> {
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

	const stable = versions.find((v) => v.channel === "stable");
	if (!stable) {
		throw new Error("No stable CEF version found in builds index");
	}

	return {
		cef_version: stable.cef_version,
		chromium_version: stable.chromium_version,
	};
}

function setOutput(key: string, value: string) {
	const outputFile = process.env.GITHUB_OUTPUT;
	if (outputFile) {
		appendFileSync(outputFile, `${key}=${value}\n`);
	}
}

function writeSummary(markdown: string) {
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) {
		appendFileSync(summaryFile, markdown + "\n");
	}
}

async function main() {
	const currentCef = CEF_VERSION;
	const currentChromium = CHROMIUM_VERSION;
	console.log(`Current:  CEF ${currentCef}  Chromium ${currentChromium}`);

	const latest = await getLatestStableCEFVersion();
	console.log(
		`Latest:   CEF ${latest.cef_version}  Chromium ${latest.chromium_version}`,
	);

	const hasUpdate =
		currentCef !== latest.cef_version ||
		currentChromium !== latest.chromium_version;

	// Always emit version outputs
	setOutput("current_cef_version", currentCef);
	setOutput("current_chromium_version", currentChromium);
	setOutput("latest_cef_version", latest.cef_version);
	setOutput("latest_chromium_version", latest.chromium_version);
	setOutput("has_update", hasUpdate ? "true" : "false");

	if (hasUpdate) {
		console.log("Version mismatch — updating src/shared/cef-version.ts");

		const cefVersionPath = resolve(
			import.meta.dir,
			"../src/shared/cef-version.ts",
		);
		const newContent = [
			"// Default CEF version shipped with this Electrobun release.",
			"// All platforms use the same version. Update this single pair when bumping CEF.",
			`export const CEF_VERSION = \`${latest.cef_version}\`;`,
			`export const CHROMIUM_VERSION = \`${latest.chromium_version}\`;`,
			"export const DEFAULT_CEF_VERSION_STRING = `${CEF_VERSION}+chromium-${CHROMIUM_VERSION}`;",
			"",
		].join("\n");
		writeFileSync(cefVersionPath, newContent);
		console.log(`Wrote ${cefVersionPath}`);
	} else {
		console.log("CEF version is up to date.");
	}

	// Step summary
	const summary = hasUpdate
		? [
				"## CEF Compatibility Check",
				"",
				`| | CEF | Chromium |`,
				`|---|---|---|`,
				`| **Current** | \`${currentCef}\` | \`${currentChromium}\` |`,
				`| **Latest** | \`${latest.cef_version}\` | \`${latest.chromium_version}\` |`,
				"",
				"New version detected — build step will run.",
			].join("\n")
		: [
				"## CEF Compatibility Check",
				"",
				`CEF \`${currentCef}\` is the latest stable version. No build needed.`,
			].join("\n");

	writeSummary(summary);
}

main().catch((err) => {
	console.error("Error checking CEF version:", err);
	process.exit(1);
});
