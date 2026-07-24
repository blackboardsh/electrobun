import { describe, expect, it } from "bun:test";
import { resolveTrayLength } from "./TrayLength";

describe("resolveTrayLength", () => {
	it("resolves fixed and square lengths", () => {
		expect(resolveTrayLength(18)).toBe(18);
		expect(resolveTrayLength("square")).toBe(-2);
		expect(resolveTrayLength()).toBeUndefined();
	});

	it("rejects invalid fixed lengths", () => {
		for (const length of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveTrayLength(length)).toThrow(RangeError);
		}
	});
});
