import { describe, expect, test } from "bun:test";
import {
	GLYPH_H,
	GLYPH_W,
	glyphNames,
	glyphRows,
	glyphRuns,
	hasGlyph,
	measureText,
} from "../font";

describe("bitmap font", () => {
	test("every glyph is exactly 7 rows of 5 cells", () => {
		for (const name of glyphNames()) {
			const rows = glyphRows(name);
			expect(rows.length).toBe(GLYPH_H);
			for (const row of rows) {
				expect(row.length).toBe(GLYPH_W);
				expect(row).toMatch(/^[.#]{5}$/);
			}
		}
	});

	test("covers printable ASCII", () => {
		for (let code = 0x20; code < 0x7f; code++) {
			expect(hasGlyph(String.fromCharCode(code))).toBe(true);
		}
	});

	test("runs cover exactly the on-cells", () => {
		for (const name of glyphNames()) {
			const rows = glyphRows(name);
			const onCells = rows.join("").split("").filter((c) => c === "#").length;
			const runTotal = glyphRuns(name).reduce((sum, [, , len]) => sum + len, 0);
			expect(runTotal).toBe(onCells);
		}
	});

	test("unknown characters fall back to a box", () => {
		expect(glyphRuns("❤").length).toBeGreaterThan(0);
	});

	test("measureText scales with size and length", () => {
		expect(measureText("", 14)).toEqual({ w: 0, h: 14 });
		const cell = 14 / GLYPH_H;
		expect(measureText("ab", 14).w).toBeCloseTo((2 * 6 - 1) * cell);
		expect(measureText("ab", 28).w).toBeCloseTo(measureText("ab", 14).w * 2);
	});
});
