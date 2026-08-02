import { join, resolve } from "node:path";
import {
	createDevCommands,
	parseDevArgs,
	resolveHutchBinary,
	runCommand,
	type DevCommand,
} from "./dev";
import { prepareLocalStack } from "./local-stack.js";

type CreateMatrixDevCommandsOptions = {
	hutchBinary: string;
	packageDir: string;
	kitchenDir: string;
	platform: string;
	comSpec?: string;
	matrixArgs?: string[];
	skipPackageBuild?: boolean;
};

export function createMatrixDevCommands({
	hutchBinary,
	packageDir,
	kitchenDir,
	platform,
	comSpec = "cmd.exe",
	matrixArgs = [],
	skipPackageBuild = false,
}: CreateMatrixDevCommandsOptions): DevCommand[] {
	const commands = createDevCommands({
		hutchBinary,
		packageDir,
		kitchenDir,
		platform,
		comSpec,
		skipPackageBuild,
	});
	commands[commands.length - 1] = {
		label: "Run Kitchen interactive matrix",
		command: hutchBinary,
		args: ["scripts/kitchen-matrix.ts", ...matrixArgs],
		cwd: kitchenDir,
	};
	return commands;
}

function main(): void {
	const packageDir = resolve(import.meta.dirname, "..");
	const kitchenDir = resolve(packageDir, "..", "kitchen");
	const parsedArgs = parseDevArgs(process.argv.slice(2));
	if (parsedArgs.local) prepareLocalStack(packageDir);

	const hutchBinary = resolveHutchBinary(packageDir);
	const comSpec =
		process.env["ComSpec"] ??
		join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe");
	const commands = createMatrixDevCommands({
		hutchBinary,
		packageDir,
		kitchenDir,
		platform: process.platform,
		comSpec,
		matrixArgs: parsedArgs.devArgs,
		skipPackageBuild: parsedArgs.local,
	});

	console.log(`[dev:matrix] Hutch: ${hutchBinary}`);
	for (const command of commands) runCommand(command);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		const status = (error as { status?: number | null })?.status;
		process.exit(typeof status === "number" && Number.isInteger(status) ? status : 1);
	}
}
