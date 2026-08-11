import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kitchenRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("Kitchen keeps npm dependencies separate from Hutch tasks", () => {
	const manifest = JSON.parse(
		readFileSync(join(kitchenRoot, "package.json"), "utf8"),
	);
	assert.equal(manifest.scripts, undefined);
	assert.equal(manifest.dependencies.electrobun, undefined);
	assert.equal(manifest.dependencies["@babylonjs/core"], "^7.45.0");
	assert.equal(manifest.dependencies.three, "^0.165.0");

	const lock = JSON.parse(
		readFileSync(join(kitchenRoot, "package-lock.json"), "utf8"),
	);
	assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
	assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
	assert.equal(
		Object.values(lock.packages).some((entry) => entry?.name === "electrobun"),
		false,
	);
	assert.equal(existsSync(join(kitchenRoot, "bun.lock")), false);
});

test("Kitchen resolves tasks and SDK types through Hutch", () => {
	const hutch = readFileSync(join(kitchenRoot, "hutch.config.ts"), "utf8");
	const electrobun = readFileSync(
		join(kitchenRoot, "electrobun.config.ts"),
		"utf8",
	);
	const packageVersion = JSON.parse(
		readFileSync(join(kitchenRoot, "..", "package", "package.json"), "utf8"),
	).version;
	assert.match(hutch, /\bpackageManager:\s*"npm"/);
	assert.equal(
		hutch.match(/\belectrobun:\s*\{\s*version:\s*"([^"]+)"/)?.[1],
		packageVersion,
	);
	assert.doesNotMatch(electrobun, /\belectrobun\s*:\s*\{/);
	const scriptBody = hutch.match(/\bscripts:\s*\{([\s\S]*?)\n\t\},/)?.[1] ?? "";
	const scriptNames = [...scriptBody.matchAll(/^\t\t(?:"([^"]+)"|([A-Za-z]+)):/gm)]
		.map((match) => match[1] ?? match[2])
		.sort();
	assert.deepEqual(scriptNames, [
		"build:canary",
		"build:production",
		"check:odin-mirrors",
		"check:zig-mirrors",
		"dev",
		"install",
		"matrix",
		"matrix:full",
		"matrix:test",
		"package-boundary:test",
		"start",
		"start:canary",
	]);
	for (const command of [
		'install: ["hutch", "pm", "ci"]',
		'start: ["hutch", "electrobun", "run"]',
		'dev: ["hutch", "electrobun", "dev"]',
		'matrix: ["hutch", "scripts/kitchen-matrix.ts"]',
		'"matrix:full": ["hutch", "scripts/kitchen-matrix.ts", "--full"]',
		'"check:zig-mirrors": ["hutch", "scripts/check-zig-test-mirrors.ts"]',
		'"check:odin-mirrors": ["hutch", "scripts/check-odin-test-mirrors.ts"]',
		'"start:canary": ["hutch", "electrobun", "dev", "--env=canary"]',
	]) {
		assert.match(hutch, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}

	const tsconfig = JSON.parse(
		readFileSync(join(kitchenRoot, "tsconfig.json"), "utf8"),
	);
	assert.equal(tsconfig.extends, "./.hutch/devkit/tsconfig.json");
	assert.match(readFileSync(join(kitchenRoot, ".gitignore"), "utf8"), /^\.hutch\/$/m);
});

test("Kitchen matrix uses the projected devkit without an npm package bridge", () => {
	const matrix = readFileSync(
		join(kitchenRoot, "scripts", "kitchen-matrix.ts"),
		"utf8",
	);
	assert.doesNotMatch(matrix, /COTTONTAIL_ELECTROBUN_PACKAGE/);
	assert.doesNotMatch(matrix, /node_modules["'],\s*["']electrobun/);
	assert.doesNotMatch(matrix, /HUTCH_ELECTROBUN_DEVKIT_ROOT/);

	const releaseWorkflow = readFileSync(
		join(kitchenRoot, "..", ".github", "workflows", "release.yml"),
		"utf8",
	);
	assert.equal(
		(releaseWorkflow.match(/HUTCH_ELECTROBUN_DEVKIT_ROOT/g) ?? []).length,
		1,
	);
	assert.match(
		releaseWorkflow,
		/HUTCH_ELECTROBUN_DEVKIT_ROOT: \$\{\{ github\.workspace \}\}\/package\/dist/,
	);
});
