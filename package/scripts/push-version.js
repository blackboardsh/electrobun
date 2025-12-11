#!/usr/bin/env bun
/**
 * Version bump, commit, tag, and push script
 *
 * Usage: bun scripts/push-version.js <type>
 *
 * Types:
 *   beta   - prerelease bump (0.5.0-beta.0 -> 0.5.0-beta.1)
 *   patch  - prepatch bump (0.5.0-beta.0 -> 0.5.1-beta.0)
 *   minor  - preminor bump (0.5.0-beta.0 -> 0.6.0-beta.0)
 *   major  - premajor bump (0.5.0-beta.0 -> 1.0.0-beta.0)
 *   stable - patch bump without beta (0.5.0 -> 0.5.1)
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const type = process.argv[2];

if (!type || !["beta", "patch", "minor", "major", "stable"].includes(type)) {
  console.error("Usage: bun scripts/push-version.js <beta|patch|minor|major|stable>");
  process.exit(1);
}

const packageDir = import.meta.dir.replace("/scripts", "");
const repoRoot = join(packageDir, "..");
const packageJsonPath = join(packageDir, "package.json");

// Read current version
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const currentVersion = packageJson.version;

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
const newVersion = updatedPackageJson.version;
const tagName = `v${newVersion}`;

console.log(`New version: ${newVersion}`);

// Git operations from repo root
console.log(`Creating commit and tag: ${tagName}`);

execSync(`git add package/package.json`, { cwd: repoRoot, stdio: "inherit" });
execSync(`git commit -m "${tagName}"`, { cwd: repoRoot, stdio: "inherit" });
execSync(`git tag ${tagName}`, { cwd: repoRoot, stdio: "inherit" });

console.log(`Pushing to origin...`);
execSync(`git push origin main --tags`, { cwd: repoRoot, stdio: "inherit" });

console.log(`\n✓ Successfully pushed ${tagName}`);
