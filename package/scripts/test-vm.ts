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

// Every main-process SDK bridges renderer callbacks differently, so each
// backend runs its automated suite against both renderers. CEF delivers
// callbacks on threads/message-pump states the system webview never does (for
// example re-entrant webview-tag creation from a CEF process message), and
// system variants are built without CEF so renderer-neutral tests exercise
// the CEF-to-system fallback.
export const VM_MAIN_PROCESSES = [
	"cottontail",
	"bun",
	"zig",
	"rust",
	"go",
	"odin",
] as const;
export const VM_WEBVIEWS = ["system", "cef"] as const;

// A deadlocked app never exits on its own; fail the stage instead of hanging
// the whole VM run.
export const VM_KITCHEN_TIMEOUT_SECONDS = 1200;

const displayNames: Record<(typeof VM_MAIN_PROCESSES)[number], string> = {
	cottontail: "Cottontail",
	bun: "Bun",
	zig: "Zig",
	rust: "Rust",
	go: "Go",
	odin: "Odin",
};
const webviewNames: Record<(typeof VM_WEBVIEWS)[number], string> = {
	system: "system webview",
	cef: "CEF",
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
	// The build stage builds the package devkit and every Kitchen variant;
	// launch stages reuse both through the same override dev:matrix uses.
	const kitchenEnv = { HUTCH_ELECTROBUN_DEVKIT_ROOT: join(packageDir, "dist") };
	const variants = VM_WEBVIEWS.flatMap((webview) =>
		VM_MAIN_PROCESSES.map((main) => ({ main, webview })),
	);
	const buildLabel = "Build Electrobun package and Kitchen variants";
	return [
		{
			label: buildLabel,
			command: hutchBinary,
			args: [
				"dev:matrix",
				"--build-only",
				`--with=${variants.map(({ main, webview }) => `${main}:${webview}`).join(",")}`,
			],
			cwd: packageDir,
		},
		// Launch one at a time: concurrent apps contend for focus, the CEF
		// remote-debugging port, and window-manager state that tests assert.
		...variants.map(({ main, webview }) => ({
			label: `Kitchen automated tests (${displayNames[main]} + ${webviewNames[webview]})`,
			command: hutchBinary,
			args: [
				"scripts/kitchen-matrix.ts",
				"--launch-only",
				`--with=${main}:${webview}`,
				`--timeout=${VM_KITCHEN_TIMEOUT_SECONDS}`,
			],
			cwd: kitchenDir,
			env: { ...kitchenEnv, AUTO_RUN: "1" },
			requires: buildLabel,
		})),
		{
			// Includes the desktop-only native tests (dialogs, DPI, X11 geometry,
			// Wayland capture, views URLs, WebView2, Windows UI) that need a real
			// session; they skip themselves on other platforms.
			label: "Unit and native tests",
			command: hutchBinary,
			args: ["test:unit"],
			cwd: packageDir,
		},
		{
			label: "Kitchen tooling tests",
			command: hutchBinary,
			args: ["test:tooling"],
			cwd: kitchenDir,
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
