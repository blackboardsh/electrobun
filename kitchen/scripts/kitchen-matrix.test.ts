import { describe, expect, it } from "bun:test";
import {
	createKitchenMatrix,
	KITCHEN_MAIN_PROCESSES,
	kitchenVariantKey,
	readKitchenVariant,
} from "./kitchen-matrix-plan";
import { parseKitchenMatrixArguments } from "./kitchen-matrix";

describe("kitchen matrix", () => {
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
});
