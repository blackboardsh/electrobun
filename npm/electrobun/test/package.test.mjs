import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function gitStdout(args) {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("shares the product release version and remains dependency-free", () => {
	assert.equal(manifest.name, "electrobun");
	assert.equal(manifest.version, productSourceManifest.version);
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
	const packArguments = ["pack", "--dry-run", "--json", "--ignore-scripts"];
	const command =
		process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
	const arguments_ =
		process.platform === "win32"
			? ["/d", "/s", "/c", ["npm.cmd", ...packArguments].join(" ")]
			: packArguments;
	const result = spawnSync(command, arguments_, {
		cwd: packageRoot,
		encoding: "utf8",
	});

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
	assert.match(
		gitStdout([
			"ls-files",
			"--stage",
			"--",
			"npm/electrobun/bin/electrobun.cjs",
		]),
		/^100755 /,
	);
	assert.match(bootstrapSource, /^#!\/usr\/bin\/env node\r?\n/);
	assert.doesNotMatch(bootstrapSource, /package\.json|packageVersion/);
});

test("publishes from the unified product release lane before templates", () => {
	const productWorkflow = readFileSync(
		join(repositoryRoot, ".github", "workflows", "release.yml"),
		"utf8",
	).replace(/\r\n/g, "\n");

	assert.equal(
		existsSync(
			join(repositoryRoot, ".github", "workflows", "npm-bootstrap.yml"),
		),
		false,
	);
	assert.match(productWorkflow, /^  npm-publish:\n    needs: \[release\]$/m);
	assert.match(
		productWorkflow,
		/^  publish-templates:\n    needs: \[npm-publish\]$/m,
	);
	assert.match(
		productWorkflow,
		/^          ref: \$\{\{ github\.event_name == 'workflow_dispatch' && format\('refs\/tags\/\{0\}', github\.event\.inputs\.tag\) \|\| github\.ref \}\}$/m,
	);
	assert.match(
		productWorkflow,
		/^          RELEASE_PACKAGE_JSON: npm\/electrobun\/package\.json$/m,
	);
	assert.match(
		productWorkflow,
		/^        run: node package\/scripts\/verify-release-version\.mjs$/m,
	);
	assert.match(productWorkflow, /working-directory: npm\/electrobun/g);
	assert.match(
		productWorkflow,
		/npm publish --access public --tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"/,
	);
	assert.doesNotMatch(
		productWorkflow,
		/^  npm-publish:[\s\S]*?hutch install|^  npm-publish:[\s\S]*?build\.ts/m,
	);
});

test("the product source tree cannot be published in place", () => {
	assert.equal(productSourceManifest.private, true);
	assert.equal(productSourceManifest.bin, undefined);
	assert.equal(
		gitStdout(["ls-files", "--", "package/src/cli"]).trim(),
		"",
		"the retired product CLI must not coexist with the thin Hutch bootstrap",
	);
});
