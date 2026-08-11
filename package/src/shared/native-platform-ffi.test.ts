import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nativeSource = readFileSync(
	join(import.meta.dirname, "../sdks/main/proc/native.ts"),
	"utf8",
);

function sourceBetween(start: string, end: string) {
	const startIndex = nativeSource.indexOf(start);
	const endIndex = nativeSource.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`Could not find native source section: ${start} ... ${end}`);
	}
	return nativeSource.slice(startIndex, endIndex);
}

const macOSOnlySymbols = [
	"wgpuViewSetAlphaBlending",
	"setWGPUPointerHandler",
	"setWGPUKeyHandler",
	"uiMeasureText",
	"uiRasterizeText",
	"uiFreeTextBitmap",
];

describe("platform-specific native FFI", () => {
	it("binds macOS-only exports only on macOS", () => {
		const macOSBindings = sourceBetween(
			"const macOSNative",
			"export const native",
		);
		const commonBindings = sourceBetween(
			"export const native",
			"export const hasFFI",
		);

		expect(macOSBindings).toContain('process.platform !== "darwin"');
		expect(macOSBindings).toContain("tryDlopenCandidates");
		for (const symbol of macOSOnlySymbols) {
			expect(macOSBindings).toContain(`${symbol}: {`);
			expect(commonBindings).not.toContain(`${symbol}: {`);
		}
	});

	it("guards optional macOS capabilities before invoking them", () => {
		expect(nativeSource).toContain(
			'if (typeof setAlphaBlending !== "function") return;',
		);
		expect(nativeSource).toContain(
			'if (typeof measureText !== "function")',
		);
		expect(nativeSource).toContain(
			'typeof rasterizeText !== "function"',
		);
		expect(nativeSource).toContain(
			'typeof freeTextBitmap !== "function"',
		);
		expect(nativeSource).toContain(
			'if (typeof setKeyHandler !== "function")',
		);
		expect(nativeSource).toContain(
			'if (typeof setPointerHandler !== "function")',
		);
	});
});
