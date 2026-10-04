import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse as parseYaml } from "yaml";

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
const docsWorkflow = readFileSync(
  new URL("../.github/workflows/docs-deploy.yml", projectRoot),
  "utf8",
);
const workflow = parseYaml(docsWorkflow);
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
  assert.match(docsWorkflow, /run:\s*hutch run install\s*\n/);
});

test("documentation examples own their ambient runtime types", () => {
  assert.equal(manifest.devDependencies["@types/bun"], "^1.4.0");
  assert.match(
    exampleChecker,
    /typeRoots:\s*\[join\(docsRoot, "node_modules", "@types"\)\]/,
  );
  assert.doesNotMatch(exampleChecker, /join\(packageRoot, "node_modules"/);
});

test("local docs validation covers pull requests, main, tags, and manual runs", () => {
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  for (const event of ["push", "pull_request"]) {
    for (const path of [
      "docs/**",
      "package/src/**",
      ".github/workflows/docs-deploy.yml",
    ]) {
      assert.ok(
        workflow.on[event].paths.includes(path),
        `${event} must validate changes to ${path}`,
      );
    }
  }

  const steps = workflow.jobs.check.steps;
  assert.ok(steps.some((step) => step.uses === "./.github/actions/install-hutch"));
  for (const command of ["install", "test:project-boundary", "check", "build"]) {
    const step = steps.find(
      (candidate) => candidate.run === `hutch run ${command}`,
    );
    assert.ok(step, `missing docs ${command} step`);
    assert.equal(step["working-directory"], "docs");
    assert.equal(step.if, undefined, `${command} must validate all supported events`);
  }
});

test("only tag pushes use the canonical strict release version gate", () => {
  const steps = workflow.jobs.check.steps;
  const gate = steps.find((step) => step.id === "release-type");
  assert.ok(gate);
  assert.equal(
    gate.if,
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')",
  );
  assert.equal(gate.run, "node package/scripts/verify-release-version.mjs");
  assert.equal(gate.env.RELEASE_TAG, "${{ github.ref_name }}");
  assert.equal(gate.env.RELEASE_PACKAGE_JSON, "package/package.json");
  assert.ok(
    steps.indexOf(gate) <
      steps.findIndex((step) => step.run === "hutch run install"),
  );
});

test("the private framework-docs site owns deployment", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["check"]);
  assert.doesNotMatch(
    docsWorkflow,
    /CLOUDFLARE_|hutch run deploy|wrangler|workflow_dispatch:\s*\n\s*inputs:/,
  );
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
