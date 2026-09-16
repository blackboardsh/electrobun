import { resolve } from "node:path";
import {
	resolveHutchBinary,
	runCommandWithSignalForwarding,
	type DevCommand,
} from "./dev";

export const releaseCheckTasks = [
	["Clean template artifacts", "clean:templates"],
	["Typecheck", "typecheck"],
	["Development command tests", "dev:test"],
	["Core host transport tests", "test:core-host-transport"],
	["Native symbol contract tests", "test:native-symbol-contract"],
	["Native devkit manifest tests", "test:devkit-manifest"],
	["Version bump tests", "test:version-bump"],
	["Template tests", "test:templates"],
	["Odin template tests", "test:odin-templates"],
	["Template publisher tests", "test:template-publisher"],
	["Signing tests", "test:signing"],
	["Deployment target tests", "test:deployment-target"],
	["Linux ABI tests", "test:linux-abi"],
	["Installer UI tests", "test:installer-ui"],
	["Updater unit tests", "test:updater-unit"],
	["npm bootstrap tests", "test:npm-bootstrap"],
	["Release notes tests", "test:release-notes"],
] as const;

type CreateCheckCommandsOptions = {
	hutchBinary: string;
	packageDir: string;
};

export type CheckFailure = {
	command: DevCommand;
	error: unknown;
};

type CommandRunner = (command: DevCommand) => Promise<void>;
type FailureReporter = (failure: CheckFailure) => void;

export function createReleaseCheckCommands({
	hutchBinary,
	packageDir,
}: CreateCheckCommandsOptions): DevCommand[] {
	return releaseCheckTasks.map(([label, task]) => ({
		label,
		command: hutchBinary,
		args: [task],
		cwd: packageDir,
	}));
}

export function createDevTestCommands({
	hutchBinary,
	packageDir,
}: CreateCheckCommandsOptions): DevCommand[] {
	return [
		{
			label: "Development command plan tests",
			command: hutchBinary,
			args: ["scripts/dev.test.ts"],
			cwd: packageDir,
		},
		{
			label: "Development template plan tests",
			command: hutchBinary,
			args: ["scripts/dev-template.test.ts"],
			cwd: packageDir,
		},
		{
			label: "Template artifact cleanup tests",
			command: "node",
			args: ["--test", "scripts/clean-template-artifacts.test.mjs"],
			cwd: packageDir,
		},
		{
			label: "Cottontail test wrapper tests",
			command: "node",
			args: ["--test", "scripts/run-cottontail-test.test.mjs"],
			cwd: packageDir,
		},
		{
			label: "Release check runner tests",
			command: hutchBinary,
			args: ["scripts/check-release.test.ts"],
			cwd: packageDir,
		},
	];
}

export function createTemplateTestCommands({
	packageDir,
}: CreateCheckCommandsOptions): DevCommand[] {
	return [
		{
			label: "Cottontail template tests",
			command: "node",
			args: [
				"scripts/run-cottontail-test.js",
				"../templates/template-manifests.test.ts",
				"../templates/all-template-orchestrator.test.ts",
				"src/shared/ui-color-picker.test.ts",
			],
			cwd: packageDir,
		},
		{
			label: "Vite devkit resolution tests",
			command: "node",
			args: ["--test", "../templates/vite-devkit-resolution.test.mjs"],
			cwd: packageDir,
		},
	];
}

function errorStatus(error: unknown): number | null {
	const status = (error as { status?: unknown })?.status;
	return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function defaultFailureReporter(failure: CheckFailure): void {
	const detail =
		failure.error instanceof Error
			? failure.error.message
			: String(failure.error);
	console.error(
		`[check:release] ${failure.command.label} failed; continuing with the remaining checks.\n${detail}`,
	);
}

export async function runCheckCommands(
	commands: DevCommand[],
	runCommand: CommandRunner = runCommandWithSignalForwarding,
	reportFailure: FailureReporter = defaultFailureReporter,
): Promise<CheckFailure[]> {
	const failures: CheckFailure[] = [];
	for (const command of commands) {
		try {
			await runCommand(command);
		} catch (error) {
			const status = errorStatus(error);
			if (status === 130 || status === 143) throw error;
			const failure = { command, error };
			failures.push(failure);
			reportFailure(failure);
		}
	}
	return failures;
}

export function checkExitCode(failures: readonly CheckFailure[]): 0 | 1 {
	return failures.length === 0 ? 0 : 1;
}

type CheckSuite = "release" | "dev" | "templates";

function parseSuite(value: string | undefined): CheckSuite {
	if (value === undefined || value === "release") return "release";
	if (value === "dev" || value === "templates") return value;
	throw new Error(`Unknown check suite: ${value}`);
}

async function main(): Promise<void> {
	const packageDir = resolve(import.meta.dirname, "..");
	const hutchBinary = resolveHutchBinary(packageDir);
	const suite = parseSuite(process.argv[2]);
	const options = { hutchBinary, packageDir };
	const commands =
		suite === "dev"
			? createDevTestCommands(options)
			: suite === "templates"
				? createTemplateTestCommands(options)
				: createReleaseCheckCommands(options);
	const failures = await runCheckCommands(commands);

	if (checkExitCode(failures) === 0) {
		console.log(`[check:release] All ${suite} checks passed.`);
		return;
	}

	console.error(
		`[check:release] ${failures.length} of ${commands.length} ${suite} checks failed:\n${failures
			.map((failure) => `  - ${failure.command.label}`)
			.join("\n")}`,
	);
	process.exitCode = checkExitCode(failures);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = errorStatus(error) ?? 1;
	});
}
