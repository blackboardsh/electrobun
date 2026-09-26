import { join, resolve } from "node:path";
import {
	resolveHutchBinary,
	runCommandWithSignalForwarding,
	type DevCommand,
} from "./dev";

type CreateVmTestCommandsOptions = {
	hutchBinary: string;
	packageDir: string;
	kitchenDir?: string;
};

// Every main-process SDK bridges renderer callbacks differently, and CEF
// delivers them on threads/message-pump states the system webview never does
// (for example re-entrant webview-tag creation from a CEF process message).
// The system-webview pass alone cannot catch those, so each backend also runs
// its automated suite against CEF.
export const VM_CEF_MAIN_PROCESSES = [
	"cottontail",
	"bun",
	"zig",
	"rust",
	"go",
	"odin",
] as const;

// A deadlocked app never exits on its own; fail the stage instead of hanging
// the whole VM run.
export const VM_KITCHEN_SYSTEM_TIMEOUT_SECONDS = 1200;
export const VM_KITCHEN_CEF_TIMEOUT_SECONDS = 600;

const displayNames: Record<(typeof VM_CEF_MAIN_PROCESSES)[number], string> = {
	cottontail: "Cottontail",
	bun: "Bun",
	zig: "Zig",
	rust: "Rust",
	go: "Go",
	odin: "Odin",
};

export type VmTestCommand = DevCommand & {
	// Label of an earlier stage whose failure makes this one meaningless (for
	// example, launching variants whose build failed would run stale output).
	requires?: string;
};

export type VmTestFailure = {
	command: VmTestCommand;
	error: unknown;
};

type VmCommandRunner = (command: VmTestCommand) => Promise<void>;
type VmFailureReporter = (failure: VmTestFailure) => void;

export function createVmTestCommands({
	hutchBinary,
	packageDir,
	kitchenDir = join(packageDir, "..", "kitchen"),
}: CreateVmTestCommandsOptions): VmTestCommand[] {
	// The first stage builds the package devkit; later Kitchen stages reuse it
	// through the same override dev:matrix uses instead of rebuilding it.
	const kitchenEnv = { HUTCH_ELECTROBUN_DEVKIT_ROOT: join(packageDir, "dist") };
	const cefVariants = VM_CEF_MAIN_PROCESSES.map((main) => `${main}:cef`);
	const cefBuildLabel = "Build Kitchen CEF variants";
	return [
		{
			label: "Kitchen automated tests (Cottontail + system webview)",
			command: hutchBinary,
			// Keep the explicit system-only matrix entry: plain `hutch dev`
			// bundles CEF and would not exercise CEF-request fallback.
			args: [
				"dev:matrix",
				"--with=cottontail:system",
				`--timeout=${VM_KITCHEN_SYSTEM_TIMEOUT_SECONDS}`,
			],
			cwd: packageDir,
			env: { AUTO_RUN: "1" },
		},
		{
			label: cefBuildLabel,
			command: hutchBinary,
			args: [
				"scripts/kitchen-matrix.ts",
				"--build-only",
				`--with=${cefVariants.join(",")}`,
			],
			cwd: kitchenDir,
			env: kitchenEnv,
		},
		// Launch one at a time: concurrent CEF apps contend for focus, the
		// remote-debugging port, and window-manager state that tests assert.
		...VM_CEF_MAIN_PROCESSES.map((main) => ({
			label: `Kitchen automated tests (${displayNames[main]} + CEF)`,
			command: hutchBinary,
			args: [
				"scripts/kitchen-matrix.ts",
				"--launch-only",
				`--with=${main}:cef`,
				`--timeout=${VM_KITCHEN_CEF_TIMEOUT_SECONDS}`,
			],
			cwd: kitchenDir,
			env: { ...kitchenEnv, AUTO_RUN: "1" },
			requires: cefBuildLabel,
		})),
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
	commands: VmTestCommand[],
	runCommand: VmCommandRunner = runCommandWithSignalForwarding,
	reportFailure: VmFailureReporter = defaultFailureReporter,
): Promise<VmTestFailure[]> {
	const failures: VmTestFailure[] = [];
	for (const command of commands) {
		if (
			command.requires &&
			failures.some((failure) => failure.command.label === command.requires)
		) {
			const failure = {
				command,
				error: new Error(`Skipped because "${command.requires}" failed.`),
			};
			failures.push(failure);
			reportFailure(failure);
			continue;
		}
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
