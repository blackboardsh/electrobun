import { describe, expect, test } from "bun:test";
import { normalizeExtent3D } from "./webgpuExtent";

describe("WebGPU texture extents", () => {
	test("accepts readonly tuples and defaults omitted dimensions", () => {
		expect(normalizeExtent3D([128] as const)).toEqual({
			width: 128,
			height: 1,
			depthOrArrayLayers: 1,
		});
		expect(normalizeExtent3D([128, 64, 3] as const)).toEqual({
			width: 128,
			height: 64,
			depthOrArrayLayers: 3,
		});
	});

	test("normalizes dictionaries without replacing explicit zero values", () => {
		expect(normalizeExtent3D({ width: 128 })).toEqual({
			width: 128,
			height: 1,
			depthOrArrayLayers: 1,
		});
		expect(normalizeExtent3D({ width: 128, height: 0 })).toEqual({
			width: 128,
			height: 0,
			depthOrArrayLayers: 1,
		});
	});
});
