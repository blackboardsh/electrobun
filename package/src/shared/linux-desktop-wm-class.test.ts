import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux desktop WM class", () => {
	test("derives the native class from app name and channel", () => {
		expect(source).toContain("deriveLinuxWindowClass(");
		expect(source).toContain("character != ' '");
		expect(source).toContain('channel != "production"');
		expect(source).toContain('channel != "stable"');
		expect(source).not.toContain("ElectrobunKitchenSink-dev");
	});

	test("uses the same class for X11/CEF and GTK/WebKit windows", () => {
		expect(
			source.match(/g_electrobunWindowClass\.c_str\(\)/g)?.length,
		).toBeGreaterThanOrEqual(4);
		expect(source).toContain("XSetClassHint");
		expect(source).toContain("gtk_window_set_wmclass");
	});
});
