import { describe, expect, test } from "bun:test";
import {
	packRgbaPixels,
	packedPixelsEqual,
} from "../../../templates/ui-color-picker/src/colorSampling";

describe("ui-color-picker pixel conversion", () => {
	test("packs row-major RGBA bytes without changing channel order", () => {
		expect(
			Array.from(
				packRgbaPixels(
					new Uint8Array([0x12, 0x34, 0x56, 0xff, 0xaa, 0xbb, 0xcc, 0x80]),
				),
			),
		).toEqual([0x123456ff, 0xaabbcc80]);
	});

	test("rejects partial pixels", () => {
		expect(() => packRgbaPixels(new Uint8Array(3))).toThrow(RangeError);
	});

	test("detects changed and unchanged samples", () => {
		const sample = new Uint32Array([1, 2, 3]);
		expect(packedPixelsEqual(sample, new Uint32Array([1, 2, 3]))).toBe(true);
		expect(packedPixelsEqual(sample, new Uint32Array([1, 4, 3]))).toBe(false);
		expect(packedPixelsEqual(sample, new Uint32Array([1, 2]))).toBe(false);
	});
});
