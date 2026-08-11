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
	kitchenVariantKey,
	readKitchenVariant,
} from "./kitchen-matrix-plan";
import {
	createKitchenMatrixRunRoot,
	parseKitchenMatrixArguments,
	prepareKitchenVariantWorkspace,
	publishKitchenVariantWorkspace,
} from "./kitchen-matrix";

describe("kitchen matrix", () => {
	it("owns the Zig build graph used by Hutch", () => {
		const build = readFileSync(
			join(import.meta.dirname, "..", "build.zig"),
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
