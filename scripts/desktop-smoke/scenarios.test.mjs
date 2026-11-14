// Kitchen smoke scenarios launch a test by name from the tagged Kitchen
// sources. A renamed or removed test only surfaces after a release has been
// published, so tie every scenario to the Kitchen sources before publishing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { kitchenScenarios, templateScenarios } from "./scenarios.mjs";
import { DESKTOP_DRIVER_TIMEOUT_MS, kitchenDesktopPlan, runDesktopDriver } from "./driver-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kitchenSrc = join(root, "kitchen", "src");
const testsDir = join(kitchenSrc, "tests");

test("Kitchen cleanup fallback cannot interrupt the driver's observation budget", async () => {
	const scenario = kitchenScenarios.find(({ id }) => id === "kitchen-native-ui");
	const plan = kitchenDesktopPlan(scenario, { hutch: "/tools/hutch", kitchen: "/source/kitchen", output: "/evidence" });
	assert.deepEqual(plan.command, ["/tools/hutch", "scripts/kitchen-matrix.ts", "--with=cottontail:cef", "--launch-only", "--timeout=930"]);
	assert.deepEqual(plan.env, { AUTO_RUN_TEST_NAME: scenario.test });
	assert.equal(plan.cwd, "/source/kitchen");
	assert.equal(plan.output, "/evidence");
	assert.deepEqual(plan.actions, scenario.actions);
	const options = { cwd: "/scratch", env: { CI: "1" }, log: "/evidence/driver.log" };
	let invocation;
	const result = await runDesktopDriver("python", "/driver/desktop.py", "/evidence/plan.json", options,
		async (...args) => { invocation = args; return "driver result"; });
	assert.equal(result, "driver result");
	assert.equal(DESKTOP_DRIVER_TIMEOUT_MS, 900_000);
	assert.deepEqual(invocation, ["python", ["/driver/desktop.py", "/evidence/plan.json"],
		{ ...options, timeout: 900_000 }]);
	const fallbackMs = Number(plan.command.find(arg => arg.startsWith("--timeout=")).split("=")[1]) * 1000;
	assert.equal(fallbackMs - invocation[2].timeout, 30_000,
		"the separate POSIX app group needs a bounded cleanup fallback after the driver deadline");
	assert.equal(options.timeout, undefined, "the caller's options should remain unchanged");
});

for (const script of ["run.mjs", "source-run.mjs"]) {
	test(`${script} shares the template and Kitchen driver supervisor`, () => {
		const source = readFileSync(join(root, "scripts/desktop-smoke", script), "utf8");
		assert.match(source, /const plan = kitchenDesktopPlan\(scenario,/);
		assert.equal([...source.matchAll(/await runDesktopDriver\(/g)].length, 2);
		assert.doesNotMatch(source, /--timeout=300|timeout:\s*330_000/);
	});
}

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

test("Bunny input tilts from a settled neutral baseline and then returns to neutral", () => {
	const bunny = templateScenarios.find(({ id }) => id === "bunny");
	assert.ok(bunny.readyImage);
	assert.deepEqual(bunny.initialPointer, [0.5, 0.5]);
	assert.equal(bunny.actions.length, 2);
	for (const action of bunny.actions) {
		assert.equal(action.expectBunnyRotation, true);
		assert.equal(action.expectChange, undefined, "transparent desktop pixels cannot prove rotation");
	}
	assert.ok(bunny.actions[0].move.every(value => value > 0 && value < 1 && Math.abs(value - 0.5) >= 0.3));
	assert.deepEqual(bunny.actions[1].move, bunny.initialPointer);
});

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
