#!/usr/bin/env node
/**
 * Version bump, commit, tag, and push script
 *
 * Usage: node scripts/push-version.js <type>
 *
 * Types:
 *   beta   - prerelease bump (0.5.0-beta.0 -> 0.5.0-beta.1)
 *   patch  - prepatch bump (0.5.0-beta.0 -> 0.5.1-beta.0)
 *   minor  - preminor bump (0.5.0-beta.0 -> 0.6.0-beta.0)
 *   major  - premajor bump (0.5.0-beta.0 -> 1.0.0-beta.0)
 *   stable - patch bump without beta (0.5.0 -> 0.5.1)
 */

import { execFileSync, execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { assertStrictSemVer } from "../src/shared/strict-semver.js";
import {
	assertTemplatesFloat,
	createRustSdkVersionUpdates,
	parseRepositoryPragmaPins,
	stampNpmBootstrapPairedVersions,
	updateKitchenVersions,
	updateNpmBootstrapVersion,
} from "./version-config.mjs";
import {
	assertReleaseGitState,
	pushReleaseAtomically,
} from "./release-git.mjs";

const type = process.argv[2];

if (!type || !["beta", "patch", "minor", "major", "stable"].includes(type)) {
	console.error(
		"Usage: node scripts/push-version.js <beta|patch|minor|major|stable>",
	);
	process.exit(1);
}

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageDir, "..");
const packageJsonPath = join(packageDir, "package.json");
const templatesDir = join(repoRoot, "templates");
const npmBootstrapPath = join(repoRoot, "npm", "electrobun", "package.json");

// Read current version
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const currentVersion = assertStrictSemVer(
	packageJson.version,
	"package/package.json version",
);

// Refuse to mutate release identities unless this checkout is the clean branch
// that the exact commit and tag will be published from.
assertReleaseGitState(repoRoot);

// Determine npm version command
const versionCmd = {
	beta: "prerelease --preid=beta",
	patch: "prepatch --preid=beta",
	minor: "preminor --preid=beta",
	major: "premajor --preid=beta",
	stable: "patch",
}[type];

console.log(`Current version: ${currentVersion}`);
console.log(`Running: npm version ${versionCmd}`);

// Bump version (without git operations)
execSync(`npm version ${versionCmd} --no-git-tag-version`, {
	cwd: packageDir,
	stdio: "inherit",
});

// Read new version
const updatedPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const newVersion = assertStrictSemVer(
	updatedPackageJson.version,
	"npm version result",
);
const tagName = `v${newVersion}`;

console.log(`New version: ${newVersion}`);

// Update kitchen sink version to match
const kitchenConfigPath = join(repoRoot, "kitchen", "electrobun.config.ts");
const kitchenHutchConfigPath = join(repoRoot, "kitchen", "hutch.config.ts");
const kitchenVersions = updateKitchenVersions(
	readFileSync(kitchenHutchConfigPath, "utf-8"),
	readFileSync(kitchenConfigPath, "utf-8"),
	newVersion,
);
assertTemplatesFloat(templatesDir);
const npmBootstrap = updateNpmBootstrapVersion(
	readFileSync(npmBootstrapPath, "utf-8"),
	newVersion,
);
const npmResolverPath = join(
	repoRoot,
	"npm",
	"electrobun",
	"bin",
	"resolve-hutch.cjs",
);
const npmResolver = stampNpmBootstrapPairedVersions(
	readFileSync(npmResolverPath, "utf-8"),
	parseRepositoryPragmaPins(
		readFileSync(join(packageDir, "hutch.config.ts"), "utf-8"),
	),
);
const rustSdkVersions = createRustSdkVersionUpdates(repoRoot, newVersion);

writeFileSync(kitchenHutchConfigPath, kitchenVersions.hutchConfig);
writeFileSync(kitchenConfigPath, kitchenVersions.electrobunConfig);
writeFileSync(npmBootstrapPath, npmBootstrap);
writeFileSync(npmResolverPath, npmResolver);
for (const rustSdkVersion of rustSdkVersions) {
	writeFileSync(rustSdkVersion.path, rustSdkVersion.source);
}
console.log(
	`Updated Kitchen, npm bootstrap (with paired toolchain pins), and Rust SDK identities to ${newVersion}; templates float`,
);

// Git operations from repo root
console.log(`Creating commit and tag: ${tagName}`);

execFileSync(
	"git",
	[
		"add",
		"package/package.json",
		"package/package-lock.json",
		"kitchen/hutch.config.ts",
		"kitchen/electrobun.config.ts",
		"npm/electrobun/package.json",
		"npm/electrobun/bin/resolve-hutch.cjs",
		...rustSdkVersions.map(({ path }) => relative(repoRoot, path)),
	],
	{ cwd: repoRoot, stdio: "inherit" },
);
execFileSync("git", ["commit", "-m", tagName], {
	cwd: repoRoot,
	stdio: "inherit",
});
execFileSync("git", ["tag", tagName], { cwd: repoRoot, stdio: "inherit" });

console.log(`Pushing to origin...`);
pushReleaseAtomically(repoRoot, tagName);

console.log(`\n✓ Successfully pushed ${tagName}`);
