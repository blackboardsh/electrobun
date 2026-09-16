import { resolve } from "node:path";
import {
	resolveHutchBinary,
	runCommandWithSignalForwarding,
	type DevCommand,
} from "./dev";

type CreateVmTestCommandsOptions = {
	hutchBinary: string;
	packageDir: string;
};

export type VmTestFailure = {
	command: DevCommand;
	error: unknown;
};

type VmCommandRunner = (command: DevCommand) => Promise<void>;
type VmFailureReporter = (failure: VmTestFailure) => void;

export function createVmTestCommands({
	hutchBinary,
	packageDir,
}: CreateVmTestCommandsOptions): DevCommand[] {
	return [
		{
			label: "Kitchen automated tests (Cottontail + system webview)",
			command: hutchBinary,
			// Keep the explicit system-only matrix entry: plain `hutch dev`
			// bundles CEF and would not exercise CEF-request fallback.
			args: ["dev:matrix", "--with=cottontail:system"],
			cwd: packageDir,
			env: { AUTO_RUN: "1" },
		},
		{
			label: "Full install/update/uninstall lifecycle",
			command: hutchBinary,
			args: ["test:updater-lifecycle"],
			cwd: packageDir,
		},
		{
			label: "Release checks",
			command: hutchBinary,
			args: ["check:release"],
			cwd: packageDir,
		},
	];
}

function errorStatus(error: unknown): number | null {
	const status = (error as { status?: unknown })?.status;
	return typeof status === "number" && Number.isInteger(status) ? status : null;
}

function defaultFailureReporter(failure: VmTestFailure): void {
	const detail =
		failure.error instanceof Error
			? failure.error.message
			: String(failure.error);
	console.error(
		`[test:vm] ${failure.command.label} failed; continuing with the remaining stages.\n${detail}`,
	);
}

export async function runVmTestCommands(
	commands: DevCommand[],
	runCommand: VmCommandRunner = runCommandWithSignalForwarding,
	reportFailure: VmFailureReporter = defaultFailureReporter,
): Promise<VmTestFailure[]> {
	const failures: VmTestFailure[] = [];
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

async function main(): Promise<void> {
	const packageDir = resolve(import.meta.dirname, "..");
	const hutchBinary = resolveHutchBinary(packageDir);
	const commands = createVmTestCommands({ hutchBinary, packageDir });
	const failures = await runVmTestCommands(commands);

	if (failures.length === 0) {
		console.log("[test:vm] All VM test stages passed.");
		return;
	}

	console.error(
		`[test:vm] ${failures.length} of ${commands.length} stages failed:\n${failures
			.map((failure) => `  - ${failure.command.label}`)
			.join("\n")}`,
	);
	process.exitCode = 1;
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = errorStatus(error) ?? 1;
	});
}
