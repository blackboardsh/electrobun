import { spawn, type ChildProcess } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
	createKitchenMatrix,
	KITCHEN_MAIN_PROCESSES,
	KITCHEN_RENDERERS,
	kitchenVariantEnvironment,
	kitchenVariantKey,
	type KitchenMainProcess,
	type KitchenRenderer,
	type KitchenVariant,
} from "./kitchen-matrix-plan";

export type KitchenMatrixOptions = {
	full: boolean;
	buildOnly: boolean;
	launchOnly: boolean;
	list: boolean;
	help: boolean;
	jobs: number;
	selectedVariants: KitchenVariant[] | null;
};

const activeChildren = new Set<ChildProcess>();
const workspaceExcludedEntries = new Set([
	".hutch",
	".cottontail-tmp",
	"artifacts",
	"build",
]);
const workspaceSharedDirectoryEntries = new Set(["node_modules", "vendors"]);

export type KitchenVariantWorkspace = {
	root: string;
	buildOutput: string;
	artifactOutput: string;
	publishedBuildOutput: string;
	publishedArtifactOutput: string;
};

export function createKitchenMatrixRunRoot(kitchenRoot: string): string {
	const scratchRoot = join(kitchenRoot, ".cottontail-tmp", "kitchen-matrix");
	mkdirSync(scratchRoot, { recursive: true });
	return mkdtempSync(join(scratchRoot, `${process.pid}-`));
}

function mirrorWorkspaceEntry(
	entryName: string,
	source: string,
	destination: string,
): void {
	const stat = statSync(source);
	if (stat.isDirectory()) {
		if (workspaceSharedDirectoryEntries.has(entryName)) {
			symlinkSync(
				source,
				destination,
				process.platform === "win32" ? "junction" : "dir",
			);
		} else {
			cpSync(source, destination, { recursive: true, dereference: true });
		}
		return;
	}
	if (stat.isFile()) copyFileSync(source, destination);
}

export function prepareKitchenVariantWorkspace(
	kitchenRoot: string,
	runRoot: string,
	variant: KitchenVariant,
): KitchenVariantWorkspace {
	const key = kitchenVariantKey(variant);
	const root = join(runRoot, key);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });

	for (const entry of readdirSync(kitchenRoot, { withFileTypes: true })) {
		if (workspaceExcludedEntries.has(entry.name)) continue;
		mirrorWorkspaceEntry(
			entry.name,
			join(kitchenRoot, entry.name),
			join(root, entry.name),
		);
	}

	return {
		root,
		buildOutput: join(root, "build", "matrix", key),
		artifactOutput: join(root, "artifacts", "matrix", key),
		publishedBuildOutput: join(kitchenRoot, "build", "matrix", key),
		publishedArtifactOutput: join(kitchenRoot, "artifacts", "matrix", key),
	};
}

function replacePublishedOutput(source: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true });
	rmSync(destination, { recursive: true, force: true });
	renameSync(source, destination);
}

export function publishKitchenVariantWorkspace(
	workspace: KitchenVariantWorkspace,
): void {
	if (!existsSync(workspace.buildOutput)) {
		throw new Error(
			`Matrix build completed without variant output: ${workspace.buildOutput}`,
		);
	}
	replacePublishedOutput(workspace.buildOutput, workspace.publishedBuildOutput);
	if (existsSync(workspace.artifactOutput)) {
		replacePublishedOutput(
			workspace.artifactOutput,
			workspace.publishedArtifactOutput,
		);
	}
}

function defaultJobCount(): number {
	return Math.max(1, Math.min(4, availableParallelism()));
}

function parseJobCount(value: string): number {
	const jobs = Number.parseInt(value, 10);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs must be a positive integer, received ${JSON.stringify(value)}`);
	}
	return jobs;
}

function parseSelectedVariants(value: string): KitchenVariant[] {
	const variants: KitchenVariant[] = [];
	const keys = new Set<string>();
	for (const item of value.split(",")) {
		const parts = item.trim().toLowerCase().split(":");
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			throw new Error(
				`--with entries must use <main>:<webview>, received ${JSON.stringify(item)}`,
			);
		}

		const mainProcess = KITCHEN_MAIN_PROCESSES.find(
			(candidate) => candidate === parts[0],
		) as KitchenMainProcess | undefined;
		if (!mainProcess) {
			throw new Error(`--with received an unsupported main process: ${JSON.stringify(parts[0])}`);
		}

		const rendererName = parts[1] === "system" ? "native" : parts[1];
		const renderer = KITCHEN_RENDERERS.find(
			(candidate) => candidate === rendererName,
		) as KitchenRenderer | undefined;
		if (!renderer) {
			throw new Error(`--with received an unsupported webview: ${JSON.stringify(parts[1])}`);
		}

		const variant = { mainProcess, renderer };
		const key = kitchenVariantKey(variant);
		if (!keys.has(key)) {
			keys.add(key);
			variants.push(variant);
		}
	}
	if (variants.length === 0) throw new Error("--with requires at least one variant");
	return variants;
}

export function parseKitchenMatrixArguments(
	args: string[],
	defaultJobs = defaultJobCount(),
): KitchenMatrixOptions {
	const options: KitchenMatrixOptions = {
		full: false,
		buildOnly: false,
		launchOnly: false,
		list: false,
		help: false,
		jobs: defaultJobs,
		selectedVariants: null,
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--full") options.full = true;
		else if (arg === "--build-only") options.buildOnly = true;
		else if (arg === "--launch-only") options.launchOnly = true;
		else if (arg === "--list") options.list = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg.startsWith("--with=")) {
			options.selectedVariants = parseSelectedVariants(arg.slice("--with=".length));
		} else if (arg === "--with") {
			const value = args[index + 1];
			if (!value) throw new Error("--with requires a value");
			options.selectedVariants = parseSelectedVariants(value);
			index += 1;
		} else if (arg.startsWith("--jobs=")) {
			options.jobs = parseJobCount(arg.slice("--jobs=".length));
		} else if (arg === "--jobs") {
			const value = args[index + 1];
			if (!value) throw new Error("--jobs requires a value");
			options.jobs = parseJobCount(value);
			index += 1;
		} else {
			throw new Error(`Unknown matrix option: ${arg}`);
		}
	}

	if (options.buildOnly && options.launchOnly) {
		throw new Error("--build-only and --launch-only cannot be used together");
	}
	if (options.full && options.selectedVariants) {
		throw new Error("--full and --with cannot be used together");
	}
	return options;
}

function printHelp(): void {
	console.log(`Electrobun kitchen matrix

Usage: hutch scripts/kitchen-matrix.ts [options]

Options:
  --full          Build all 12 main-process x renderer variants
  --with LIST     Build exact variants (for example: go:system,rust:cef)
  --build-only    Build variants without launching them
  --launch-only   Launch existing variants without rebuilding
  --jobs N        Maximum concurrent builds (default: up to 4)
  --list          Print the selected variants and exit
  -h, --help      Show this help

The default matrix launches all six main-process backends with the system
renderer, plus Cottontail with CEF. Use --with for a focused pass or --full
after renderer-plumbing changes.`);
}

function pipePrefixed(stream: Readable, prefix: string, target: NodeJS.WriteStream): void {
	let pending = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		pending += chunk;
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			target.write(`${prefix}${pending.slice(0, newline + 1)}`);
			pending = pending.slice(newline + 1);
		}
	});
	stream.on("end", () => {
		if (pending) target.write(`${prefix}${pending}\n`);
	});
}

function runHutchForVariant(
	hutchBinary: string,
	workingRoot: string,
	variant: KitchenVariant,
	command: "build" | "run",
): Promise<void> {
	const key = kitchenVariantKey(variant);
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(hutchBinary, ["electrobun", command], {
			cwd: workingRoot,
			env: kitchenVariantEnvironment(process.env, variant),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: false,
		});
		activeChildren.add(child);
		if (child.stdout) pipePrefixed(child.stdout, `[${key}] `, process.stdout);
		if (child.stderr) pipePrefixed(child.stderr, `[${key}] `, process.stderr);

		let settled = false;
		const reject = (error: Error) => {
			if (settled) return;
			settled = true;
			activeChildren.delete(child);
			rejectPromise(error);
		};

		child.on("error", (error) => {
			reject(new Error(`${key}: failed to start Hutch: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			activeChildren.delete(child);
			if (code === 0) resolvePromise();
			else {
				rejectPromise(
					new Error(
						`${key}: Hutch ${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}`,
					),
				);
			}
		});
	});
}

async function runBuildPool(
	variants: KitchenVariant[],
	jobs: number,
	build: (variant: KitchenVariant) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const failures: Error[] = [];
	const workers = Array.from(
		{ length: Math.min(jobs, variants.length) },
		async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				const variant = variants[index];
				if (!variant) return;
				try {
					await build(variant);
				} catch (error) {
					failures.push(error instanceof Error ? error : new Error(String(error)));
				}
			}
		},
	);
	await Promise.all(workers);
	if (failures.length > 0) {
		throw new Error(failures.map((failure) => failure.message).join("\n"));
	}
}

function stopChildren(): void {
	for (const child of activeChildren) child.kill();
}

export async function runKitchenMatrix(args: string[]): Promise<void> {
	const options = parseKitchenMatrixArguments(args);
	if (options.help) {
		printHelp();
		return;
	}

	const variants = createKitchenMatrix(
		options.full,
		options.selectedVariants ?? undefined,
	);
	console.log(
		`Kitchen matrix (${options.selectedVariants ? "selected" : options.full ? "full" : "reduced"}, ${variants.length} variants):`,
	);
	for (const variant of variants) console.log(`  ${kitchenVariantKey(variant)}`);
	if (options.list) return;

	const kitchenRoot = resolve(import.meta.dirname, "..");
	const hutchBinary = process.env["HUTCH_BINARY"] || "hutch";
	const interrupt = () => stopChildren();
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	let matrixRunRoot: string | null = null;

	try {
		if (!options.launchOnly) {
			const runRoot = createKitchenMatrixRunRoot(kitchenRoot);
			matrixRunRoot = runRoot;
			const workspaces = new Map(
				variants.map((variant) => [
					kitchenVariantKey(variant),
					prepareKitchenVariantWorkspace(kitchenRoot, runRoot, variant),
				]),
			);
			console.log(`Building with up to ${options.jobs} concurrent jobs...`);
			await runBuildPool(variants, options.jobs, async (variant) => {
				const key = kitchenVariantKey(variant);
				const workspace = workspaces.get(key);
				if (!workspace) throw new Error(`${key}: matrix workspace was not prepared`);
				await runHutchForVariant(
					hutchBinary,
					workspace.root,
					variant,
					"build",
				);
				publishKitchenVariantWorkspace(workspace);
			});
			rmSync(matrixRunRoot, { recursive: true, force: true });
			matrixRunRoot = null;
			console.log("Kitchen matrix build complete.");
		}

		if (options.buildOnly) return;
		console.log(`Launching ${variants.length} kitchen variants. Close each app as it passes.`);
		const results = await Promise.all(
			variants.map(async (variant) => {
				try {
					await runHutchForVariant(
						hutchBinary,
						kitchenRoot,
						variant,
						"run",
					);
					return null;
				} catch (error) {
					return error instanceof Error ? error : new Error(String(error));
				}
			}),
		);
		const failures = results.filter((result): result is Error => result !== null);
		if (failures.length > 0) {
			throw new Error(failures.map((failure) => failure.message).join("\n"));
		}
		console.log("All kitchen variants closed successfully.");
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		stopChildren();
		if (matrixRunRoot) rmSync(matrixRunRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	runKitchenMatrix(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
