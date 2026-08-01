import { describe, expect, test } from "bun:test";
import {
	formatWindowsBatchCommand,
	serializeNativeCompileFlags,
} from "./native-compile-flags";

describe("native compile flags", () => {
	test("serializes macOS SDK and include paths one argument per line", () => {
		const flags = serializeNativeCompileFlags("macos", [
			"-std=c++20",
			"-fobjc-arc",
			"-I/checkout with spaces/package/vendors/cef",
			"-isysroot",
			"/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
		]);

		expect(flags).toBe(
			[
				"-std=c++20",
				"-fobjc-arc",
				"-I/checkout with spaces/package/vendors/cef",
				"-isysroot",
				"/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
				"",
			].join("\n"),
		);
	});

	test("preserves Linux pkg-config output and fallback defines", () => {
		const flags = serializeNativeCompileFlags("linux", [
			"-std=c++20",
			"-I/usr/include/webkitgtk-4.1",
			"-I/opt/electrobun/vendors/cef",
			"-DNO_APPINDICATOR",
		]);

		expect(flags.split("\n")).toEqual([
			"-std=c++20",
			"-I/usr/include/webkitgtk-4.1",
			"-I/opt/electrobun/vendors/cef",
			"-DNO_APPINDICATOR",
			"",
		]);
	});

	test("selects clang's CL parser for the real Windows MSVC flags", () => {
		const flags = serializeNativeCompileFlags("win", [
			"/EHsc",
			"/std:c++20",
			"/DNOMINMAX",
			"/IC:\\checkout with spaces\\vendors\\webview2",
		]);

		expect(flags.split("\n")).toEqual([
			"--driver-mode=cl",
			"/EHsc",
			"/std:c++20",
			"/DNOMINMAX",
			"/IC:\\checkout with spaces\\vendors\\webview2",
			"",
		]);
	});

	test("formats the same Windows arguments for a vcvars batch command", () => {
		expect(
			formatWindowsBatchCommand([
				"cl",
				"/c",
				"/std:c++20",
				"/IC:\\checkout with spaces\\vendors\\cef",
			]),
		).toBe(
			'cl /c /std:c++20 "/IC:\\checkout with spaces\\vendors\\cef"',
		);
	});

	test("rejects flags that would corrupt the line-oriented file", () => {
		expect(() =>
			serializeNativeCompileFlags("linux", ["-std=c++20", "-DBAD\nFLAG"]),
		).toThrow("must not contain newlines");
	});
});
