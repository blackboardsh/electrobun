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
	// One bin, one door: raw Hutch access stays with the machine install
	// (and the `hutch` bin name stays free for a future standalone package).
	assert.deepEqual(manifest.bin, {
		electrobun: "bin/electrobun.cjs",
	});
	assert.deepEqual(manifest.files, [
		"bin/electrobun.cjs",
		"bin/resolve-hutch.cjs",
		"lib/moved.cjs",
		"README.md",
		"LICENSE",
	]);

	// Application APIs are not distributed through npm: every import path
	// resolves to the tombstone that points at the Hutch devkit.
	assert.deepEqual(manifest.exports, {
		".": "./lib/moved.cjs",
		"./package.json": "./package.json",
		"./*": "./lib/moved.cjs",
	});

	for (const field of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
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
		[
			"LICENSE",
			"README.md",
			"bin/electrobun.cjs",
			"bin/resolve-hutch.cjs",
			"lib/moved.cjs",
			"package.json",
		],
	);
	assert.ok(report.size < 24 * 1024, `packed size was ${report.size} bytes`);
	assert.ok(
		report.unpackedSize < 64 * 1024,
		`unpacked size was ${report.unpackedSize} bytes`,
	);
});

test("ships executable CommonJS entry points", () => {
	for (const bin of ["electrobun.cjs"]) {
		const source = readFileSync(join(packageRoot, "bin", bin), "utf8");
		assert.match(
			gitStdout(["ls-files", "--stage", "--", `npm/electrobun/bin/${bin}`]),
			/^100755 /,
		);
		assert.match(source, /^#!\/usr\/bin\/env node\r?\n/);
	}
});

test("the stamped paired versions mirror the repository pragma", () => {
	const resolverSource = readFileSync(
		join(packageRoot, "bin", "resolve-hutch.cjs"),
		"utf8",
	);
	const pragma = readFileSync(
		join(repositoryRoot, "package", "hutch.config.ts"),
		"utf8",
	).split(/\r?\n/, 1)[0];
	const pins = pragma.match(
		/^\/\/ @hutch cli=([0-9A-Za-z.\-]+) cottontail=([0-9A-Za-z.\-]+)$/,
	);
	assert.ok(pins, `unrecognized pragma: ${pragma}`);
	assert.match(
		resolverSource,
		new RegExp(`const PAIRED_HUTCH_VERSION = "${pins[1].replace(/\./g, "\\.")}";`),
		"PAIRED_HUTCH_VERSION must equal the repository pragma cli pin",
	);
	assert.doesNotMatch(
		resolverSource,
		/PAIRED_COTTONTAIL_VERSION|HUTCH_DEFAULT_COTTONTAIL/,
		"cottontail is paired inside Hutch (build-time) and the Electrobun devkit manifest (bundled runtime), never the shim",
	);
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
		/^  npm-acceptance:\n    needs: \[npm-publish\]$/m,
	);
	assert.match(
		productWorkflow,
		/^  publish-templates:\n    needs: \[npm-acceptance\]$/m,
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
	assert.match(
		productWorkflow,
		/node npm\/scripts\/stage-hutch-release-artifacts\.mjs/,
	);
	assert.ok(
		productWorkflow.indexOf("- name: Stage paired Hutch archives") <
			productWorkflow.indexOf("- name: Create or refresh draft Release"),
		"paired Hutch assets must be staged before the GitHub Release is created",
	);
	assert.match(productWorkflow, /artifacts\/\*\*\/\*\.tar\.gz/);
	assert.match(productWorkflow, /artifacts\/hutch\/hutch-artifacts\.json/);
	assert.match(
		productWorkflow,
		/node package\/scripts\/verify-release-assets\.mjs[\s\S]*?--actual "\$existing_assets"[\s\S]*?--repository "\$GITHUB_REPOSITORY"[\s\S]*?--tag "\$RELEASE_TAG"/,
	);
	assert.match(
		productWorkflow,
		/- name: Create or refresh draft Release\n        if: steps\.release-state\.outputs\.upload == 'true'[\s\S]*?          draft: true/,
	);
	assert.match(
		productWorkflow,
		/node npm\/scripts\/check-published-bootstrap\.mjs[\s\S]*?--tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"/,
	);
	assert.match(
		productWorkflow,
		/- name: Publish npm bootstrap\n        if: steps\.npm-state\.outputs\.exists != 'true'/,
	);
	assert.ok(
		productWorkflow.indexOf("- name: Publish npm bootstrap") <
			productWorkflow.indexOf("- name: Verify published npm bootstrap"),
		"the exact npm integrity and dist-tag must be verified after publication",
	);
	assert.match(
		productWorkflow,
		/node npm\/scripts\/accept-published-bootstrap\.mjs[\s\S]*?--version "\$\{\{ steps\.release-type\.outputs\.version \}\}"[\s\S]*?--release-tag "\$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}"[\s\S]*?--dist-tag "\$\{\{ steps\.release-type\.outputs\.dist-tag \}\}"[\s\S]*?--platform "\$\{\{ matrix\.platform \}\}"/,
	);
	for (const runner of [
		"macos-14",
		"ubuntu-24.04",
		"ubuntu-24.04-arm",
		"windows-2025",
	]) {
		assert.match(productWorkflow, new RegExp(`- os: ${runner}`));
	}
	assert.equal(
		(productWorkflow.match(/npm publish /g) ?? []).length,
		1,
		"the release must publish exactly one npm package",
	);
	assert.doesNotMatch(productWorkflow, /npm\/platform-packages|@electrobun\/hutch-/);
	assert.equal(
		existsSync(join(repositoryRoot, "npm", "scripts", "build-platform-packages.mjs")),
		false,
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
