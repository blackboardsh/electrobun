import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const productSourceManifest = JSON.parse(
	readFileSync(join(repositoryRoot, "package", "package.json"), "utf8"),
);

test("is an independently versioned, dependency-free command package", () => {
	assert.equal(manifest.name, "electrobun");
	assert.equal(manifest.version, "2.0.0");
	assert.deepEqual(manifest.bin, {
		electrobun: "bin/electrobun.cjs",
	});
	assert.deepEqual(manifest.files, [
		"bin/electrobun.cjs",
		"README.md",
		"LICENSE",
	]);

	for (const field of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
		"exports",
		"main",
	]) {
		assert.equal(manifest[field], undefined, `${field} must not be published`);
	}

	for (const lifecycle of ["preinstall", "install", "postinstall"]) {
		assert.equal(
			manifest.scripts?.[lifecycle],
			undefined,
			`${lifecycle} must not run during package installation`,
		);
	}
});

test("packs only the allowlisted bootstrap files and stays tiny", () => {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(
		npm,
		["pack", "--dry-run", "--json", "--ignore-scripts"],
		{
			cwd: packageRoot,
			encoding: "utf8",
		},
	);

	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stderr);
	const [report] = JSON.parse(result.stdout);
	assert.deepEqual(
		report.files.map(({ path }) => path).sort(),
		["LICENSE", "README.md", "bin/electrobun.cjs", "package.json"],
	);
	assert.ok(report.size < 16 * 1024, `packed size was ${report.size} bytes`);
	assert.ok(
		report.unpackedSize < 32 * 1024,
		`unpacked size was ${report.unpackedSize} bytes`,
	);
});

test("ships an executable CommonJS entry point", () => {
	const bootstrapPath = join(packageRoot, "bin", "electrobun.cjs");
	const bootstrapSource = readFileSync(bootstrapPath, "utf8");
	assert.notEqual(statSync(bootstrapPath).mode & 0o111, 0);
	assert.match(bootstrapSource, /^#!\/usr\/bin\/env node\n/);
	assert.doesNotMatch(bootstrapSource, /package\.json|packageVersion/);
});

test("publishes on its own tag lane, outside product releases", () => {
	const productWorkflow = readFileSync(
		join(repositoryRoot, ".github", "workflows", "release.yml"),
		"utf8",
	);
	const npmWorkflow = readFileSync(
		join(repositoryRoot, ".github", "workflows", "npm-bootstrap.yml"),
		"utf8",
	);

	assert.doesNotMatch(productWorkflow, /^  npm-publish:\s*$/m);
	assert.match(productWorkflow, /^  publish-templates:\n    needs: \[release\]$/m);
	assert.match(npmWorkflow, /^      - 'npm-v\*'$/m);
	assert.match(npmWorkflow, /EXPECTED_TAG="npm-v\$\{VERSION\}"/);
	assert.match(npmWorkflow, /working-directory: npm\/electrobun/g);
	assert.doesNotMatch(npmWorkflow, /hutch install|build\.ts|working-directory: package$/m);
});

test("the product source tree cannot be published in place", () => {
	assert.equal(productSourceManifest.private, true);
	assert.equal(productSourceManifest.bin, undefined);
	assert.equal(
		existsSync(join(repositoryRoot, "package", "src", "cli")),
		false,
		"the retired product CLI must not coexist with the thin Hutch bootstrap",
	);
});
