import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
});

test("Kitchen resolves tasks and SDK types through Hutch", () => {
	const hutch = readFileSync(join(kitchenRoot, "hutch.config.ts"), "utf8");
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
		'install: ["npm", "ci"]',
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
