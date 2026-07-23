import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { prepareLocalStack } from "./local-stack.js";

export type DevCommand = {
	label: string;
	command: string;
	args: string[];
	cwd: string;
};

type CreateDevCommandsOptions = {
	dashBinary: string;
	packageDir: string;
	kitchenDir: string;
	platform: string;
	comSpec?: string;
	devArgs?: string[];
	skipPackageBuild?: boolean;
};

export function createDevCommands({
	dashBinary,
	packageDir,
	kitchenDir,
	platform,
	comSpec = "cmd.exe",
	devArgs = [],
	skipPackageBuild = false,
}: CreateDevCommandsOptions): DevCommand[] {
	const installCommand: DevCommand =
		platform === "win32"
			? {
					label: "Install Kitchen dependencies",
					command: comSpec,
					args: ["/D", "/S", "/C", "npm.cmd", "install"],
					cwd: kitchenDir,
				}
			: {
					label: "Install Kitchen dependencies",
					command: "npm",
					args: ["install"],
					cwd: kitchenDir,
				};

	const commands: DevCommand[] = [];
	if (!skipPackageBuild) {
		commands.push({
			label: "Build Electrobun package",
			command: dashBinary,
			args: [join(packageDir, "build.ts")],
			cwd: packageDir,
		});
	}
	commands.push(
		installCommand,
		{
			label: "Launch Kitchen development app",
			command: dashBinary,
			args: ["electrobun", "dev", ...devArgs],
			cwd: kitchenDir,
		},
	);
	return commands;
}

function isAbsoluteExecutablePath(value: string) {
	return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function resolveDashBinary(packageDir: string, configuredBinary = process.env.DASH_BINARY) {
	const binaryName = process.platform === "win32" ? "dash.exe" : "dash";
	const candidate = configuredBinary
		? isAbsoluteExecutablePath(configuredBinary)
			? configuredBinary
			: resolve(packageDir, configuredBinary)
		: join(packageDir, "vendors", "dash-cli", binaryName);

	if (!existsSync(candidate)) {
		const source = configuredBinary ? "DASH_BINARY" : "vendored Dash CLI";
		throw new Error(`${source} points to a missing executable: ${candidate}`);
	}

	return candidate;
}

function formatCommand(command: DevCommand) {
	return [command.command, ...command.args].map((value) => JSON.stringify(value)).join(" ");
}

function formatExitStatus(status: number | null) {
	const value = status ?? 1;
	return process.platform === "win32"
		? `0x${(value >>> 0).toString(16).padStart(8, "0").toUpperCase()}`
		: String(value);
}

function runCommand(command: DevCommand) {
	console.log(`[dev] ${command.label}...`);
	const result = spawnSync(command.command, command.args, {
		cwd: command.cwd,
		env: process.env,
		stdio: "inherit",
	});

	if (result.error) {
		throw new Error(
			`[dev] Failed to start ${formatCommand(command)} in ${command.cwd}: ${result.error.message}`,
		);
	}
	if (result.status !== 0) {
		const failure = new Error(
			`[dev] ${command.label} failed with ${result.signal ? `signal ${result.signal}` : `exit status ${formatExitStatus(result.status)}`}\n` +
				`Command: ${formatCommand(command)}\n` +
				`Working directory: ${command.cwd}`,
		) as Error & { status?: number | null };
		failure.status = result.status;
		throw failure;
	}
}

export function parseDevArgs(args: string[]) {
	return {
		local: args.includes("--local"),
		devArgs: args.filter((arg) => arg !== "--local"),
	};
}

function main() {
	const packageDir = resolve(import.meta.dirname, "..");
	const kitchenDir = resolve(packageDir, "..", "kitchen");
	const parsedArgs = parseDevArgs(process.argv.slice(2));
	if (parsedArgs.local) {
		prepareLocalStack(packageDir);
	}
	const dashBinary = resolveDashBinary(packageDir);
	const comSpec =
		process.env["ComSpec"] ??
		join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe");
	const commands = createDevCommands({
		dashBinary,
		packageDir,
		kitchenDir,
		platform: process.platform,
		comSpec,
		devArgs: parsedArgs.devArgs,
		skipPackageBuild: parsedArgs.local,
	});

	console.log(`[dev] Dash: ${dashBinary}`);
	for (const command of commands) {
		runCommand(command);
	}
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
