import { readFileSync } from "node:fs";
import {
	checkExitCode,
	createDevTestCommands,
	createReleaseCheckCommands,
	createTemplateTestCommands,
	releaseCheckTasks,
	runCheckCommands,
} from "./check-release.ts";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertArray(
	actual: readonly string[],
	expected: readonly string[],
	message: string,
): void {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}

const hutchConfig = readFileSync(
	new URL("../hutch.config.ts", import.meta.url),
	"utf8",
);
assert(
	/"check:release":\s*\["hutch", "scripts\/check-release\.ts"\]/.test(
		hutchConfig,
	),
	"check:release should use the failure-collecting runner",
);
assert(
	/"dev:test":\s*\["hutch", "scripts\/check-release\.ts", "dev"\]/.test(
		hutchConfig,
	),
	"dev:test should use the failure-collecting runner",
);
assert(
	/"test:templates":\s*\["hutch", "scripts\/check-release\.ts", "templates"\]/.test(
		hutchConfig,
	),
	"test:templates should use the failure-collecting runner",
);

const expectedReleaseTasks = [
	"clean:templates",
	"typecheck",
	"dev:test",
	"test:core-host-transport",
	"test:native-symbol-contract",
	"test:devkit-manifest",
	"test:version-bump",
	"test:templates",
	"test:odin-templates",
	"test:template-publisher",
	"test:signing",
	"test:deployment-target",
	"test:linux-abi",
	"test:installer-ui",
	"test:updater-unit",
	"test:npm-bootstrap",
	"test:release-notes",
] as const;
assertArray(
	releaseCheckTasks.map(([, task]) => task),
	expectedReleaseTasks,
	"Release check task order",
);

const options = {
	hutchBinary: "hutch",
	packageDir: "C:\\work tree\\electrobun\\package",
};
const releaseCommands = createReleaseCheckCommands(options);
assertArray(
	releaseCommands.map((command) => command.args[0] ?? ""),
	expectedReleaseTasks,
	"Release check command order",
);

const devCommands = createDevTestCommands(options);
assert(devCommands.length === 5, "dev:test should expose five independent checks");
assertArray(
	devCommands.map((command) => command.args.at(-1) ?? ""),
	[
		"scripts/dev.test.ts",
		"scripts/dev-template.test.ts",
		"scripts/clean-template-artifacts.test.mjs",
		"scripts/run-cottontail-test.test.mjs",
		"scripts/check-release.test.ts",
	],
	"Development test command order",
);

const templateCommands = createTemplateTestCommands(options);
assert(
	templateCommands.length === 2,
	"test:templates should expose both independent checks",
);

const attempted: string[] = [];
const failures = await runCheckCommands(
	releaseCommands,
	async (command) => {
		attempted.push(command.label);
		if (command === releaseCommands[0] || command === releaseCommands[5]) {
			throw new Error(`${command.label} failed`);
		}
	},
	() => {},
);
assertArray(
	attempted,
	releaseCommands.map((command) => command.label),
	"The release runner should attempt every check after failures",
);
assert(failures.length === 2, "The release runner should collect every failure");
assert(checkExitCode(failures) === 1, "Any failure should produce a nonzero exit");
assert(checkExitCode([]) === 0, "No failures should produce a zero exit");

for (const status of [130, 143]) {
	const attemptedBeforeInterrupt: string[] = [];
	let caught: unknown;
	try {
		await runCheckCommands(
			releaseCommands.slice(0, 3),
			async (command) => {
				attemptedBeforeInterrupt.push(command.label);
				if (attemptedBeforeInterrupt.length === 2) {
					throw Object.assign(new Error("interrupted"), { status });
				}
			},
			() => {},
		);
	} catch (error) {
		caught = error;
	}
	assert(
		(caught as { status?: unknown })?.status === status,
		`Signal exit ${status} should abort the suite`,
	);
	assert(
		attemptedBeforeInterrupt.length === 2,
		`Signal exit ${status} should prevent later checks from starting`,
	);
}

console.log("Electrobun release check runner passed");
