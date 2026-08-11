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
const deployWorkflow = readFileSync(
  new URL("../.github/workflows/docs-deploy.yml", projectRoot),
  "utf8",
);

test("Hutch owns the reproducible docs install", () => {
  assert.match(configSource, /\binstall:\s*\[\s*"npm"\s*,\s*"ci"\s*\]/);
  assert.equal(manifest.private, true);
  assert.equal(manifest.scripts, undefined);
  assert.equal(lockfile.lockfileVersion, 3);
  assert.deepEqual(lockfile.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(
    lockfile.packages[""].devDependencies,
    manifest.devDependencies,
  );
  assert.equal(existsSync(new URL("bun.lock", projectRoot)), false);
  assert.match(deployWorkflow, /run:\s*hutch install\s*\n/);
  assert.doesNotMatch(deployWorkflow, /hutch install --frozen-lockfile/);
});

test("tag deployments use the canonical strict release version gate", () => {
  assert.match(
    deployWorkflow,
    /^      - name: Verify release tag and version\n        if: github\.event_name == 'push'\n        id: release-type$/m,
  );
  assert.match(
    deployWorkflow,
    /^        run: node package\/scripts\/verify-release-version\.mjs$/m,
  );
  assert.ok(
    deployWorkflow.indexOf("- name: Verify release tag and version") <
      deployWorkflow.indexOf("- name: Install docs dependencies"),
  );

  const stableOrManual =
    "if: github.event_name == 'workflow_dispatch' || steps.release-type.outputs.prerelease != 'true'";
  for (const step of [
    "Install docs dependencies",
    "Check docs",
    "Build docs",
    "Deploy to Cloudflare Pages",
  ]) {
    const start = deployWorkflow.indexOf(`      - name: ${step}\n`);
    assert.notEqual(start, -1, `missing ${step}`);
    const next = deployWorkflow.indexOf("\n      - ", start + 1);
    const stepSource = deployWorkflow.slice(
      start,
      next === -1 ? undefined : next,
    );
    assert.ok(
      stepSource.includes(stableOrManual),
      `${step} must skip SemVer prereleases but run for manual dispatches`,
    );
  }
  assert.doesNotMatch(deployWorkflow, /contains\(github\.ref_name/);
});

test("docs tools resolve explicitly through npm", () => {
  for (const command of [
    "npm exec -- astro dev",
    "npm exec -- astro build",
    "npm exec -- astro preview",
    "npm exec -- astro check",
    "npm exec -- wrangler pages deploy",
  ]) {
    assert.match(configSource, new RegExp(command.replaceAll(" ", "\\s+")));
  }

  assert.doesNotMatch(configSource, /:\s*["'`](?:astro|wrangler)\b/);
});
