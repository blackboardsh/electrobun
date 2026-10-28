// Kitchen smoke scenarios launch a test by name from the tagged Kitchen
// sources. A renamed or removed test only surfaces after a release has been
// published, so tie every scenario to the Kitchen sources before publishing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { kitchenScenarios } from "./scenarios.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kitchenSrc = join(root, "kitchen", "src");
const testsDir = join(kitchenSrc, "tests");

function sources(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.(tsx?|html|zig|go|rs|odin)$/.test(entry.name) ? [path] : [];
	});
}

const kitchenFiles = sources(kitchenSrc).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const testIndex = readFileSync(join(testsDir, "index.ts"), "utf8");
const definitions = new Map();
for (const { path, text } of kitchenFiles) {
	if (!path.startsWith(testsDir) || !/\.tsx?$/.test(path)) continue;
	for (const match of text.matchAll(/defineTest\(\{\s*name:\s*(["'`])(.*?)\1/gs)) {
		definitions.set(match[2], { path, text });
	}
}

function visibleLabels(scenario) {
	return [
		scenario.readyText,
		scenario.scrollReadyText,
		...scenario.actions.flatMap((action) => [
			action.click,
			action.doubleClick,
			action.expectText,
			action.absentText,
			action.hostAnchor,
			action.childAnchor,
		]),
	].filter(Boolean);
}

for (const scenario of kitchenScenarios) {
	test(`${scenario.id} launches a registered Kitchen test`, () => {
		const definition = definitions.get(scenario.test);
		assert.ok(definition, `No Kitchen test named ${JSON.stringify(scenario.test)}`);
		const module = "./" + relative(testsDir, definition.path).replace(/\\/g, "/").replace(/\.tsx?$/, "");
		assert.ok(testIndex.includes(`"${module}"`), `${module} is not registered in kitchen/src/tests/index.ts`);
		assert.ok(definition.text.includes(`"${scenario.title}"`),
			`${module} does not open a window titled ${JSON.stringify(scenario.title)}`);
	});

	test(`${scenario.id} only targets text present in Kitchen sources`, () => {
		for (const label of visibleLabels(scenario)) {
			assert.ok(kitchenFiles.some(({ text }) => text.includes(label)), `No Kitchen source contains ${JSON.stringify(label)}`);
		}
		if (scenario.minimizeWindow) {
			assert.ok(kitchenFiles.some(({ text }) => text.includes(scenario.minimizeWindow)),
				`No Kitchen source opens ${JSON.stringify(scenario.minimizeWindow)}`);
		}
	});
}
