#!/usr/bin/env bun

/**
 * Checks GitHub for the latest stable Bun release and compares it
 * with the version in src/shared/bun-version.ts.
 *
 * When a newer version exists:
 *   - Overwrites src/shared/bun-version.ts with the new version
 *   - Sets has_update=true in $GITHUB_OUTPUT
 *
 * Always outputs version info to $GITHUB_OUTPUT and a human-readable
 * summary to $GITHUB_STEP_SUMMARY.
 */

import { BUN_VERSION } from "../src/shared/bun-version";
import { appendFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const BUN_RELEASES_URL =
	"https://api.github.com/repos/oven-sh/bun/releases/latest";

async function getLatestStableBunVersion(): Promise<string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = process.env["GITHUB_TOKEN"];
	if (token) {
		headers["Authorization"] = `Bearer ${token}`;
	}

	const response = await fetch(BUN_RELEASES_URL, { headers });
	if (!response.ok) {
		throw new Error(
			`Failed to fetch Bun latest release: HTTP ${response.status}`,
		);
	}

	const data = (await response.json()) as { tag_name?: string };
	if (!data.tag_name) {
		throw new Error("No tag_name in Bun latest release response");
	}

	// Bun release tags look like "bun-v1.3.11" — strip the prefix.
	const match = /^bun-v(.+)$/.exec(data.tag_name);
	if (!match) {
		throw new Error(`Unexpected Bun release tag format: ${data.tag_name}`);
	}

	return match[1]!;
}

function setOutput(key: string, value: string) {
	const outputFile = process.env["GITHUB_OUTPUT"];
	if (outputFile) {
		appendFileSync(outputFile, `${key}=${value}\n`);
	}
}

function writeSummary(markdown: string) {
	const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
	if (summaryFile) {
		appendFileSync(summaryFile, markdown + "\n");
	}
}

async function main() {
	const currentBun = BUN_VERSION;
	console.log(`Current:  Bun ${currentBun}`);

	const latest = await getLatestStableBunVersion();
	console.log(`Latest:   Bun ${latest}`);

	const hasUpdate = currentBun !== latest;

	setOutput("current_bun_version", currentBun);
	setOutput("latest_bun_version", latest);
	setOutput("has_update", hasUpdate ? "true" : "false");

	if (hasUpdate) {
		console.log("Version mismatch — updating src/shared/bun-version.ts");

		const bunVersionPath = resolve(
			import.meta.dir,
			"../src/shared/bun-version.ts",
		);
		const newContent = [
			"// Default Bun version shipped with this Electrobun release.",
			"// All platforms use the same version. Update this when bumping Bun.",
			`export const BUN_VERSION = "${latest}";`,
			"",
		].join("\n");
		writeFileSync(bunVersionPath, newContent);
		console.log(`Wrote ${bunVersionPath}`);
	} else {
		console.log("Bun version is up to date.");
	}

	const summary = hasUpdate
		? [
				"## Bun Compatibility Check",
				"",
				`| | Bun |`,
				`|---|---|`,
				`| **Current** | \`${currentBun}\` |`,
				`| **Latest** | \`${latest}\` |`,
				"",
				"New version detected — build step will run.",
			].join("\n")
		: [
				"## Bun Compatibility Check",
				"",
				`Bun \`${currentBun}\` is the latest stable version. No build needed.`,
			].join("\n");

	writeSummary(summary);
}

main().catch((err) => {
	console.error("Error checking Bun version:", err);
	process.exit(1);
});
