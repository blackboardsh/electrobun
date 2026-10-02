import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join(import.meta.dirname, "..");
const readSource = (relativePath: string) =>
	readFileSync(join(sourceRoot, relativePath), "utf8");

const core = readSource("core/main.zig");
const macos = readSource("native/macos/nativeWrapper.mm");
const windows = readSource("native/win/nativeWrapper.cpp");

function sourceSection(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	if (startIndex === -1 || endIndex === -1) {
		throw new Error(`Could not find source section: ${start}`);
	}
	return source.slice(startIndex, endIndex);
}

describe("tray image update appearance", () => {
	test("passes the stored tray appearance through the native ABI", () => {
		const setTrayImage = sourceSection(
			core,
			"export fn setTrayImage(",
			"export fn setTrayMenu(",
		);

		expect(setTrayImage).toContain(
			"*const fn (TrayPtr, [*:0]const u8, bool, u32, u32)",
		);
		expect(setTrayImage).toContain("state.is_template");
		expect(setTrayImage).toContain("state.width");
		expect(setTrayImage).toContain("state.height");
	});

	test("restores macOS template mode and size on the replacement image", () => {
		const setTrayImage = sourceSection(
			macos,
			'extern "C" void setTrayImage(',
			'extern "C" void setTrayMenuFromJSON(',
		);

		expect(setTrayImage).toContain("[trayImage setTemplate:isTemplate]");
		expect(setTrayImage).toContain("NSMakeSize(width, height)");
		expect(setTrayImage).toContain("statusItem.button.image = trayImage");
	});

	test("uses the configured dimensions for Windows image updates", () => {
		const setTrayImage = sourceSection(
			windows,
			"ELECTROBUN_EXPORT void setTrayImage(",
			"ELECTROBUN_EXPORT void setTrayMenuFromJSON(",
		);

		expect(setTrayImage).toContain("width, height, LR_LOADFROMFILE");
		expect(setTrayImage).not.toContain("LR_DEFAULTSIZE");
	});
});
