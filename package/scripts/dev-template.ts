import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertStrictSemVer } from "../src/shared/strict-semver.js";
import { validateNativeDevkitManifest } from "./validate-native-devkit.mjs";
import {
	resolveHutchBinary,
	runCommandWithSignalForwarding,
	type DevCommand,
} from "./dev.ts";

type JsonObject = Record<string, unknown>;

export type ExactHutchPins = {
	cli: string;
	cottontail: string;
};

export type TemplateDevPlan = {
	build: DevCommand;
	verifyCli: DevCommand;
	verifyCottontail: DevCommand;
	install: DevCommand;
	dev: DevCommand;
	expectedHutch: ExactHutchPins;
};

export type TemplateDevExecution = {
	validateBuiltDevkit: (packageDir: string, expectedVersion: string) => string;
	runAndCaptureWithSignalForwarding: (command: DevCommand) => Promise<string>;
	runWithSignalForwarding: (command: DevCommand) => Promise<void>;
};

type NativeDevkitTarget = {
	os: "macos" | "linux" | "win";
	arch: "arm64" | "x64";
};

type NativeDevkitValidator = (options: {
	coreRoot: string;
	expectedVersion: string;
	expectedTarget: NativeDevkitTarget;
}) => unknown;

function object(value: unknown, label: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as JsonObject;
}

function readText(path: string, label: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(`Could not read ${label} at ${path}`, { cause });
	}
}

function readJson(path: string, label: string): unknown {
	const source = readText(path, label);
	try {
		return JSON.parse(source);
	} catch (cause) {
		throw new Error(`Could not parse ${label} at ${path}`, { cause });
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function parseTemplateName(args: string[]): string {
	if (args.length !== 1 || !args[0]) {
		throw new Error("Usage: hutch dev:template <template-name>");
	}
	return args[0];
}

export function availableTemplateNames(templatesDir: string): string[] {
	let entries;
	try {
		entries = readdirSync(templatesDir, { withFileTypes: true });
	} catch (cause) {
		throw new Error(`Could not read templates directory at ${templatesDir}`, {
			cause,
		});
	}

	return entries
		.filter((entry) => {
			if (!entry.isDirectory()) return false;
			const directory = join(templatesDir, entry.name);
			return (
				isFile(join(directory, "hutch.config.ts")) &&
				isFile(join(directory, "electrobun.config.ts"))
			);
		})
		.map((entry) => entry.name)
		.sort();
}

export function resolveTemplateDirectory(
	templatesDir: string,
	templateName: string,
): string {
	const names = availableTemplateNames(templatesDir);
	if (!names.includes(templateName)) {
		const available = names.length > 0 ? names.join(", ") : "none";
		throw new Error(
			`Unknown Electrobun template ${JSON.stringify(templateName)}. Available templates: ${available}`,
		);
	}
	return join(resolve(templatesDir), templateName);
}

export function readPackageVersion(packageDir: string): string {
	const path = join(packageDir, "package.json");
	const manifest = object(readJson(path, "package manifest"), "package manifest");
	return assertStrictSemVer(manifest.version, "package/package.json version");
}

export function readPackageHutchPins(packageDir: string): ExactHutchPins {
	const path = join(packageDir, "hutch.config.ts");
	const source = readText(path, "package Hutch config");
	const lineEnd = source.search(/[\r\n]/);
	const firstLine = lineEnd === -1 ? source : source.slice(0, lineEnd);
	const prefix = "// @hutch";
	if (
		!firstLine.startsWith(prefix) ||
		(firstLine.length > prefix.length &&
			firstLine[prefix.length] !== " " &&
			firstLine[prefix.length] !== "\t")
	) {
		throw new Error(
			`Package Hutch config must begin with ${JSON.stringify(prefix)} and exact cli/cottontail pins`,
		);
	}

	const fields = firstLine.slice(prefix.length).trim().split(/[ \t]+/);
	const pins: Partial<ExactHutchPins> = {};
	for (const field of fields) {
		const match = /^(cli|cottontail)=([^=]+)$/.exec(field);
		if (!match) {
			throw new Error(
				`Invalid package Hutch pragma field ${JSON.stringify(field)}`,
			);
		}
		const key = match[1] as keyof ExactHutchPins;
		if (pins[key] !== undefined) {
			throw new Error(`Duplicate package Hutch pragma field ${key}`);
		}
		pins[key] = assertStrictSemVer(
			match[2],
			`package hutch.config.ts ${key} pin`,
		);
	}
	if (pins.cli === undefined || pins.cottontail === undefined) {
		throw new Error(
			"Package Hutch config must pin exact cli and cottontail versions",
		);
	}
	return { cli: pins.cli, cottontail: pins.cottontail };
}

export function hostDevkitTarget(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): NativeDevkitTarget {
	if (arch !== "arm64" && arch !== "x64") {
		throw new Error(`Unsupported host architecture ${JSON.stringify(arch)}`);
	}

	if (platform === "darwin") return { os: "macos", arch };
	if (platform === "linux") return { os: "linux", arch };
	if (platform === "win32") return { os: "win", arch: "x64" };
	throw new Error(`Unsupported host platform ${JSON.stringify(platform)}`);
}

export function validateBuiltDevkitVersion(
	packageDir: string,
	expectedVersion: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	validator: NativeDevkitValidator = validateNativeDevkitManifest,
): string {
	const expected = assertStrictSemVer(
		expectedVersion,
		"expected Electrobun version",
	);
	const manifest = validator({
		coreRoot: join(packageDir, "dist"),
		expectedVersion: expected,
		expectedTarget: hostDevkitTarget(platform, arch),
	});
	const manifestObject = object(
		manifest,
		"validated native devkit manifest",
	);
	const product = object(
		manifestObject.product,
		"validated native devkit manifest product",
	);
	const built = assertStrictSemVer(
		product.version,
		"validated native devkit product.version",
	);
	if (built !== expected) {
		throw new Error(
			`Built native devkit version ${JSON.stringify(built)} does not match package version ${JSON.stringify(expected)}`,
		);
	}
	return built;
}

function formatCommand(command: DevCommand): string {
	return [command.command, ...command.args]
		.map((value) => JSON.stringify(value))
		.join(" ");
}

function signalExitStatus(signal: NodeJS.Signals): number {
	if (signal === "SIGINT") return 130;
	if (signal === "SIGTERM") return 143;
	return 1;
}

export async function runCommandAndCaptureWithSignalForwarding(
	command: DevCommand,
): Promise<string> {
	console.log(`[dev] ${command.label}...`);
	const child = spawn(command.command, command.args, {
		cwd: command.cwd,
		env: command.env ? { ...process.env, ...command.env } : process.env,
		stdio: ["inherit", "pipe", "inherit"],
	});
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
	});

	let interruptedBy: NodeJS.Signals | null = null;
	const forwardSignal = (signal: NodeJS.Signals) => {
		if (interruptedBy) return;
		interruptedBy = signal;
		if (child.exitCode === null && child.signalCode === null) {
			child.kill(process.platform === "win32" ? undefined : signal);
		}
	};
	const onSigint = () => forwardSignal("SIGINT");
	const onSigterm = () => forwardSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	const result = await new Promise<{
		status: number | null;
		signal: NodeJS.Signals | null;
		error: Error | null;
	}>((resolveResult) => {
		let settled = false;
		const settle = (
			status: number | null,
			signal: NodeJS.Signals | null,
			error: Error | null,
		) => {
			if (settled) return;
			settled = true;
			resolveResult({ status, signal, error });
		};
		child.once("error", (error) => settle(null, null, error));
		child.once("close", (status, signal) => settle(status, signal, null));
	}).finally(() => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	});

	if (result.error) {
		throw new Error(
			`[dev] Failed to start ${formatCommand(command)} in ${command.cwd}: ${result.error.message}`,
		);
	}
	if (interruptedBy) {
		const interruption = new Error(
			`[dev] ${command.label} interrupted by ${interruptedBy}`,
		) as Error & { status?: number };
		interruption.status = signalExitStatus(interruptedBy);
		throw interruption;
	}
	if (result.status !== 0) {
		const failure = new Error(
			`[dev] ${command.label} failed with ${result.signal ? `signal ${result.signal}` : `exit status ${result.status ?? 1}`}\n` +
				`Command: ${formatCommand(command)}\n` +
				`Working directory: ${command.cwd}`,
		) as Error & { status?: number | null };
		failure.status = result.status;
		throw failure;
	}
	return output;
}

export function verifySelectedHutchVersion(
	output: string,
	expectedVersion: string,
	product: "CLI" | "Cottontail",
): string {
	const expected = assertStrictSemVer(
		expectedVersion,
		`expected Hutch ${product} version`,
	);
	const selected = assertStrictSemVer(
		output.trim(),
		`selected Hutch ${product} version`,
	);
	if (selected !== expected) {
		throw new Error(
			`Selected Hutch ${product} ${JSON.stringify(selected)} does not match package pin ${JSON.stringify(expected)}`,
		);
	}
	return selected;
}

export function resolvedHutchEnginePath(output: string): string {
	const path = output.trim();
	if (!isAbsolute(path) || !isFile(path)) {
		throw new Error(
			`hutch self path did not resolve an absolute engine executable: ${JSON.stringify(path)}`,
		);
	}
	return path;
}

export function createTemplateDevPlan(options: {
	hutchBinary: string;
	hutchEngineBinary: string;
	packageDir: string;
	templateDir: string;
	version: string;
	hutchPins: ExactHutchPins;
}): TemplateDevPlan {
	const packageDir = resolve(options.packageDir);
	const templateDir = resolve(options.templateDir);
	const version = assertStrictSemVer(
		options.version,
		"template development Electrobun version",
	);
	const hutchPins = {
		cli: assertStrictSemVer(
			options.hutchPins.cli,
			"template development Hutch CLI version",
		),
		cottontail: assertStrictSemVer(
			options.hutchPins.cottontail,
			"template development Cottontail version",
		),
	};
	const devkitRoot = join(packageDir, "dist");
	if (!isAbsolute(options.hutchEngineBinary)) {
		throw new Error("Template development Hutch engine path must be absolute");
	}
	const localDevkitEnvironment = {
		HUTCH_ELECTROBUN_DEVKIT_ROOT: devkitRoot,
		HUTCH_DEFAULT_ELECTROBUN: version,
		HUTCH_DEFAULT_CLI: hutchPins.cli,
		HUTCH_ENGINE_BINARY: options.hutchEngineBinary,
	};

	return {
		build: {
			label: "Build Electrobun package",
			command: options.hutchBinary,
			args: [join(packageDir, "build.ts")],
			cwd: packageDir,
		},
		verifyCli: {
			label: "Verify template Hutch CLI",
			command: options.hutchBinary,
			args: ["--version"],
			cwd: templateDir,
			env: { ...localDevkitEnvironment },
		},
		verifyCottontail: {
			label: "Verify template Cottontail",
			command: options.hutchBinary,
			args: [
				"-e",
				'process.stdout.write(process.versions.cottontail ?? "")',
			],
			cwd: templateDir,
			env: { ...localDevkitEnvironment },
		},
		install: {
			label: "Install template dependencies",
			command: options.hutchBinary,
			args: ["run", "--if-configured", "install"],
			cwd: templateDir,
			env: { ...localDevkitEnvironment },
		},
		dev: {
			label: "Launch template development app",
			command: options.hutchBinary,
			args: ["run", "dev"],
			cwd: templateDir,
			env: { ...localDevkitEnvironment },
		},
		expectedHutch: hutchPins,
	};
}

export async function executeTemplateDevPlan(
	plan: TemplateDevPlan,
	packageDir: string,
	expectedVersion: string,
	execution: TemplateDevExecution = {
		validateBuiltDevkit: validateBuiltDevkitVersion,
		runAndCaptureWithSignalForwarding:
			runCommandAndCaptureWithSignalForwarding,
		runWithSignalForwarding: runCommandWithSignalForwarding,
	},
): Promise<void> {
	await execution.runWithSignalForwarding(plan.build);
	execution.validateBuiltDevkit(packageDir, expectedVersion);
	verifySelectedHutchVersion(
		await execution.runAndCaptureWithSignalForwarding(plan.verifyCli),
		plan.expectedHutch.cli,
		"CLI",
	);
	verifySelectedHutchVersion(
		await execution.runAndCaptureWithSignalForwarding(plan.verifyCottontail),
		plan.expectedHutch.cottontail,
		"Cottontail",
	);
	await execution.runWithSignalForwarding(plan.install);
	await execution.runWithSignalForwarding(plan.dev);
}

async function main(): Promise<void> {
	const packageDir = resolve(import.meta.dirname, "..");
	const templatesDir = resolve(packageDir, "..", "templates");
	const templateName = parseTemplateName(process.argv.slice(2));
	const templateDir = resolveTemplateDirectory(templatesDir, templateName);
	const packageVersion = readPackageVersion(packageDir);
	const hutchPins = readPackageHutchPins(packageDir);
	const hutchBinary = resolveHutchBinary(packageDir);
	const hutchEngineBinary = resolvedHutchEnginePath(
		await runCommandAndCaptureWithSignalForwarding({
			label: "Resolve package Hutch engine",
			command: hutchBinary,
			args: ["self", "path", hutchPins.cli],
			cwd: packageDir,
			env: { HUTCH_DEFAULT_CLI: hutchPins.cli },
		}),
	);
	const plan = createTemplateDevPlan({
		hutchBinary,
		hutchEngineBinary,
		packageDir,
		templateDir,
		version: packageVersion,
		hutchPins,
	});

	console.log(`[dev:template] Template: ${templateName}`);
	console.log(`[dev:template] Electrobun: ${packageVersion}`);
	console.log(
		`[dev:template] Hutch: ${hutchPins.cli} / Cottontail: ${hutchPins.cottontail} (${hutchEngineBinary})`,
	);

	await executeTemplateDevPlan(plan, packageDir, packageVersion);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		const status = (error as { status?: number | null })?.status;
		process.exitCode =
			typeof status === "number" && Number.isInteger(status) ? status : 1;
	});
}
