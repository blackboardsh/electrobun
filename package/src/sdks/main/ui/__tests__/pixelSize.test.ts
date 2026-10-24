import { describe, expect, test } from "bun:test";
import { physicalSize, pixelRatioForFrame } from "../pixelSize";

describe("drawable size", () => {
	test("scales attachments once and rounds fractional pixels", () => {
		expect(physicalSize(900, 540, 2)).toEqual({ width: 1800, height: 1080 });
		expect(physicalSize(101, 51, 1.25)).toEqual({ width: 126, height: 64 });
		expect(physicalSize(900, 540, 1)).toEqual({ width: 900, height: 540 });
	});

	test("rejects invalid pixel ratios", () => {
		for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => physicalSize(900, 540, ratio)).toThrow(RangeError);
		}
	});
});

describe("display scale", () => {
	const displays = [
		{ bounds: { x: -1000, y: 0, width: 1000, height: 800 }, scaleFactor: 1.25 },
		{ bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 2 },
	];

	test("selects the largest overlap in logical screen coordinates", () => {
		expect(pixelRatioForFrame({ x: -600, y: 50, width: 800, height: 400 }, displays)).toBe(1.25);
		expect(pixelRatioForFrame({ x: -200, y: 50, width: 800, height: 400 }, displays)).toBe(2);
	});

	test("uses the fallback for an off-screen window or missing displays", () => {
		const frame = { x: 2000, y: 50, width: 800, height: 400 };
		expect(pixelRatioForFrame(frame, displays, 1.5)).toBe(1.5);
		expect(pixelRatioForFrame(frame, [], 2)).toBe(2);
	});

	test("compares vertically arranged displays in one coordinate space", () => {
		const vertical = [
			{ bounds: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2 },
			{ bounds: { x: 0, y: -900, width: 1440, height: 900 }, scaleFactor: 1 },
		];
		expect(pixelRatioForFrame({ x: 100, y: -800, width: 900, height: 540 }, vertical)).toBe(1);
	});
});
