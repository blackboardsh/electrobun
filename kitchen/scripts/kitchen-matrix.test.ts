import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createKitchenMatrix,
	KITCHEN_MAIN_PROCESSES,
	kitchenVariantEnvironment,
	kitchenVariantKey,
	readKitchenVariant,
} from "./kitchen-matrix-plan";
import {
	createKitchenMatrixRunRoot,
	parseKitchenMatrixArguments,
	prepareKitchenVariantWorkspace,
	publishKitchenVariantWorkspace,
	stopChildProcessTree,
} from "./kitchen-matrix";

describe("kitchen matrix", () => {
	it("owns the native project build graphs used by Hutch", () => {
		const kitchenRoot = join(import.meta.dirname, "..");
		const build = readFileSync(
			join(kitchenRoot, "build.zig"),
			"utf8",
		);
		for (const contract of [
			'"electrobun-sdk"',
			'b.path("src/zig/main.zig")',
			'.name = "main"',
			"installArtifact",
		]) {
			expect(build).toContain(contract);
		}

		const cargo = readFileSync(join(kitchenRoot, "Cargo.toml"), "utf8");
		for (const contract of [
			'name = "main"',
			'path = "src/rust/main.rs"',
			'electrobun = { path = ".hutch/devkit/rust-sdk" }',
		]) {
			expect(cargo).toContain(contract);
		}
		const cargoLock = readFileSync(join(kitchenRoot, "Cargo.lock"), "utf8");
		expect(cargoLock).toContain('name = "electrobun-kitchen"');
		expect(cargoLock).toContain('name = "electrobun"');

		const goModule = readFileSync(join(kitchenRoot, "go.mod"), "utf8");
		expect(goModule).toContain("require electrobun v0.0.0");
		expect(goModule).toContain(
			"replace electrobun => ./.hutch/devkit/go-sdk",
		);

		const config = readFileSync(
			join(kitchenRoot, "electrobun.config.ts"),
			"utf8",
		);
		expect(config).toContain('manifest: "Cargo.toml"');
		expect(config).toContain('binary: "main"');
		expect(config).toContain('package: "./src/go"');
		expect(config).not.toContain('entrypoint: "src/rust/main.rs"');
		expect(config).not.toContain('entrypoint: "src/go/main.go"');

		const rustSource = readFileSync(
			join(kitchenRoot, "src", "rust", "main.rs"),
			"utf8",
		);
		expect(rustSource).toStartWith("use electrobun::{");
	});

	it("uses the reduced seven-variant interactive matrix by default", () => {
		const matrix = createKitchenMatrix(false);
		expect(matrix).toHaveLength(7);
		expect(new Set(matrix.map(kitchenVariantKey)).size).toBe(7);
		for (const mainProcess of KITCHEN_MAIN_PROCESSES) {
			expect(matrix).toContainEqual({ mainProcess, renderer: "native" });
		}
		expect(matrix.filter((variant) => variant.renderer === "cef")).toEqual([
			{ mainProcess: "cottontail", renderer: "cef" },
		]);
	});

	it("can expand to the complete twelve-variant matrix", () => {
		const matrix = createKitchenMatrix(true);
		expect(matrix).toHaveLength(12);
		expect(new Set(matrix.map(kitchenVariantKey)).size).toBe(12);
		for (const mainProcess of KITCHEN_MAIN_PROCESSES) {
			expect(matrix).toContainEqual({ mainProcess, renderer: "native" });
			expect(matrix).toContainEqual({ mainProcess, renderer: "cef" });
		}
	});

	it("selects explicit main-process and webview combinations", () => {
		expect(
			createKitchenMatrix(false, [
				{ mainProcess: "go", renderer: "native" },
				{ mainProcess: "rust", renderer: "cef" },
			]),
		).toEqual([
			{ mainProcess: "go", renderer: "native" },
			{ mainProcess: "rust", renderer: "cef" },
		]);
	});

	it("requires a complete and valid environment override", () => {
		expect(readKitchenVariant({})).toBeNull();
		expect(
			readKitchenVariant({
				ELECTROBUN_KITCHEN_MAIN_PROCESS: "bun",
				ELECTROBUN_KITCHEN_RENDERER: "cef",
			}),
		).toEqual({ mainProcess: "bun", renderer: "cef" });
		expect(() =>
			readKitchenVariant({ ELECTROBUN_KITCHEN_MAIN_PROCESS: "zig" }),
		).toThrow("must be set together");
		expect(() =>
			readKitchenVariant({
				ELECTROBUN_KITCHEN_MAIN_PROCESS: "node",
				ELECTROBUN_KITCHEN_RENDERER: "native",
			}),
		).toThrow("Unsupported kitchen main process");
		expect(
			kitchenVariantEnvironment(
				{ HUTCH_ELECTROBUN_DEVKIT_ROOT: "/local/devkit" },
				{ mainProcess: "go", renderer: "native" },
			),
		).toMatchObject({
			HUTCH_ELECTROBUN_DEVKIT_ROOT: "/local/devkit",
			ELECTROBUN_KITCHEN_MAIN_PROCESS: "go",
			ELECTROBUN_KITCHEN_RENDERER: "native",
		});
	});

	it("parses repeatable workflow modes and job limits", () => {
		expect(parseKitchenMatrixArguments([], 3)).toMatchObject({ jobs: 3 });
		expect(
			parseKitchenMatrixArguments(["--full", "--build-only", "--jobs=8"], 3),
		).toMatchObject({ full: true, buildOnly: true, jobs: 8 });
		expect(() =>
			parseKitchenMatrixArguments(["--build-only", "--launch-only"], 3),
		).toThrow("cannot be used together");
	});

	it("parses an exact comma-separated variant list", () => {
		expect(
			parseKitchenMatrixArguments(
				["--with=go:system,rust:cef,go:cef", "--launch-only"],
				3,
			),
		).toMatchObject({
			selectedVariants: [
				{ mainProcess: "go", renderer: "native" },
				{ mainProcess: "rust", renderer: "cef" },
				{ mainProcess: "go", renderer: "cef" },
			],
			launchOnly: true,
		});
		expect(() => parseKitchenMatrixArguments(["--with=node:system"], 3)).toThrow(
			"unsupported main process",
		);
		expect(() => parseKitchenMatrixArguments(["--with=go:webkit"], 3)).toThrow(
			"unsupported webview",
		);
		expect(() =>
			parseKitchenMatrixArguments(["--full", "--with=go:system"], 3),
		).toThrow("cannot be used together");
	});

	it("terminates the isolated POSIX variant process group", () => {
		const directSignals: Array<NodeJS.Signals | number | undefined> = [];
		const groupSignals: Array<{
			pid: number;
			signal: NodeJS.Signals | number | undefined;
		}> = [];
		const child: Parameters<typeof stopChildProcessTree>[0] = {
			pid: 4321,
			exitCode: null,
			signalCode: null,
			kill: (signal) => {
				directSignals.push(signal);
				return true;
			},
		};
		const killProcess = ((
			pid: number,
			signal?: NodeJS.Signals | number,
		) => {
			groupSignals.push({ pid, signal });
			return true;
		}) as typeof process.kill;

		stopChildProcessTree(child, true, "SIGTERM", "linux", killProcess);

		expect(groupSignals).toEqual([{ pid: -4321, signal: "SIGTERM" }]);
		expect(directSignals).toEqual([]);
	});

	it("terminates a foreground variant directly", () => {
		const directSignals: Array<NodeJS.Signals | number | undefined> = [];
		const child: Parameters<typeof stopChildProcessTree>[0] = {
			pid: 4321,
			exitCode: null,
			signalCode: null,
			kill: (signal) => {
				directSignals.push(signal);
				return true;
			},
		};

		stopChildProcessTree(child, false, "SIGTERM", "linux");

		expect(directSignals).toEqual(["SIGTERM"]);
	});

	it("isolates and publishes staging output for every native runtime variant", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-kitchen-matrix-"));
		const kitchenRoot = join(fixtureRoot, "kitchen");
		const variants = (["zig", "rust", "go", "odin"] as const).map(
			(mainProcess) => ({ mainProcess, renderer: "native" as const }),
		);

		try {
			mkdirSync(join(kitchenRoot, "src"), { recursive: true });
			writeFileSync(join(kitchenRoot, "src", "shared.ts"), "export {};\n");
			writeFileSync(join(kitchenRoot, "electrobun.config.ts"), "export default {};\n");
			for (const projectFile of ["build.zig", "Cargo.toml", "Cargo.lock", "go.mod"]) {
				writeFileSync(join(kitchenRoot, projectFile), `${projectFile}\n`);
			}
			mkdirSync(join(kitchenRoot, ".hutch", "devkit"), { recursive: true });
			writeFileSync(join(kitchenRoot, ".hutch", "devkit", "stale"), "stale\n");
			mkdirSync(join(kitchenRoot, "build", "matrix", "rust-native"), {
				recursive: true,
			});
			writeFileSync(
				join(kitchenRoot, "build", "matrix", "rust-native", "stale.txt"),
				"stale",
			);

			const runRoot = createKitchenMatrixRunRoot(kitchenRoot);
			const workspaces = variants.map((variant) =>
				prepareKitchenVariantWorkspace(kitchenRoot, runRoot, variant),
			);
			expect(new Set(workspaces.map((workspace) => workspace.root)).size).toBe(4);
			for (const workspace of workspaces) {
				for (const projectFile of [
					"build.zig",
					"Cargo.toml",
					"Cargo.lock",
					"go.mod",
				]) {
					expect(existsSync(join(workspace.root, projectFile))).toBe(true);
				}
				expect(existsSync(join(workspace.root, ".hutch"))).toBe(false);
			}
			writeFileSync(join(workspaces[0]!.root, "src", "shared.ts"), "zig only\n");
			expect(readFileSync(join(kitchenRoot, "src", "shared.ts"), "utf8")).toBe(
				"export {};\n",
			);

			for (const [index, workspace] of workspaces.entries()) {
				const key = kitchenVariantKey(variants[index]!);
				const scratchFile = join(
					workspace.root,
					".cottontail-tmp",
					"electrobun",
					"cottontail-build-spec.json",
				);
				const bundledView = join(
					workspace.buildOutput,
					"dev-test-arch",
					"app",
					"views",
					"test-runner",
					"index.js",
				);
				mkdirSync(dirname(scratchFile), { recursive: true });
				mkdirSync(dirname(bundledView), { recursive: true });
				writeFileSync(scratchFile, key);
				writeFileSync(bundledView, key);
			}

			for (const [index, workspace] of workspaces.entries()) {
				const key = kitchenVariantKey(variants[index]!);
				expect(
					readFileSync(
						join(
							workspace.root,
							".cottontail-tmp",
							"electrobun",
							"cottontail-build-spec.json",
						),
						"utf8",
					),
				).toBe(key);
				publishKitchenVariantWorkspace(workspace);
			}

			for (const variant of variants) {
				const key = kitchenVariantKey(variant);
				const bundledView = join(
					kitchenRoot,
					"build",
					"matrix",
					key,
					"dev-test-arch",
					"app",
					"views",
					"test-runner",
					"index.js",
				);
				expect(readFileSync(bundledView, "utf8")).toBe(key);
			}
			expect(
				existsSync(join(kitchenRoot, "build", "matrix", "rust-native", "stale.txt")),
			).toBe(false);
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
