import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);
const configSource = readFileSync(
  new URL("hutch.config.ts", projectRoot),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(new URL("package.json", projectRoot), "utf8"),
);
const lockfile = JSON.parse(
  readFileSync(new URL("package-lock.json", projectRoot), "utf8"),
);
const exampleChecker = readFileSync(
  new URL("scripts/check-code-examples.mjs", projectRoot),
  "utf8",
);

test("Hutch owns the reproducible docs install", () => {
  assert.match(configSource, /\bpackageManager:\s*"npm"/);
  assert.match(
    configSource,
    /\binstall:\s*\[\s*"hutch"\s*,\s*"pm"\s*,\s*"ci"\s*\]/,
  );
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts, undefined);
  assert.equal(lockfile.lockfileVersion, 3);
  assert.deepEqual(lockfile.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(
    lockfile.packages[""].devDependencies,
    manifest.devDependencies,
  );
  assert.equal(existsSync(new URL("bun.lock", projectRoot)), false);
});

test("documentation examples own their ambient runtime types", () => {
  assert.equal(manifest.devDependencies["@types/bun"], "^1.4.0");
  assert.match(
    exampleChecker,
    /typeRoots:\s*\[join\(docsRoot, "node_modules", "@types"\)\]/,
  );
  assert.doesNotMatch(exampleChecker, /join\(packageRoot, "node_modules"/);
});

test("the private framework-docs site owns deployment", () => {
  assert.doesNotMatch(configSource, /\bdeploy\s*:|wrangler\s+pages\s+deploy/);
});

test("docs tools delegate explicitly to the selected npm executable", () => {
  for (const command of [
    "hutch pm exec -- astro dev",
    "hutch pm exec -- astro build",
    "hutch pm exec -- astro preview",
    "hutch pm exec -- astro check",
  ]) {
    assert.match(configSource, new RegExp(command.replaceAll(" ", "\\s+")));
  }

  assert.doesNotMatch(configSource, /:\s*["'`](?:astro|wrangler)\b/);
});
