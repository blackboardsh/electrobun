import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getWindowsPermissionBuildConfig,
	WINDOWS_WEBVIEW2_AUTO_GRANT_PERMISSIONS,
} from "../config/windowsPermissions";

const windowsWrapper = readFileSync(
	join(import.meta.dirname, "../native/win/nativeWrapper.cpp"),
	"utf8",
).replaceAll("\r\n", "\n");

describe("Windows WebView2 auto-grant permissions", () => {
	test("emits a deduplicated Windows-only build.json field", () => {
		expect(WINDOWS_WEBVIEW2_AUTO_GRANT_PERMISSIONS).toEqual([
			"camera",
			"microphone",
			"geolocation",
			"notifications",
		]);

		expect(
			getWindowsPermissionBuildConfig("win", [
				"microphone",
				"camera",
				"microphone",
			]),
		).toEqual({ autoGrantPermissions: ["microphone", "camera"] });
		expect(getWindowsPermissionBuildConfig("win", [])).toEqual({});
		expect(
			getWindowsPermissionBuildConfig("macos", ["microphone"]),
		).toEqual({});
		expect(
			getWindowsPermissionBuildConfig("linux", ["camera"]),
		).toEqual({});
	});

	test("checks explicit policy before the existing cache and dialog path", () => {
		const handlerStart = windowsWrapper.indexOf(
			"webview->add_PermissionRequested(",
		);
		const handlerEnd = windowsWrapper.indexOf(
			"// Add file dialog handler",
			handlerStart,
		);
		const handler = windowsWrapper.slice(handlerStart, handlerEnd);

		expect(handlerStart).toBeGreaterThan(-1);
		expect(handlerEnd).toBeGreaterThan(handlerStart);
		expect(handler).toContain("shouldAutoGrantWebView2Permission(kind)");
		expect(handler).toContain("COREWEBVIEW2_PERMISSION_STATE_ALLOW");
		expect(handler.indexOf("shouldAutoGrantWebView2Permission(kind)")).toBeLessThan(
			handler.indexOf("getPermissionFromCache(origin, permType)"),
		);
	});

	test("maps only the documented WebView2 permission kinds", () => {
		for (const nativeKind of [
			"COREWEBVIEW2_PERMISSION_KIND_CAMERA",
			"COREWEBVIEW2_PERMISSION_KIND_MICROPHONE",
			"COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION",
			"COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS",
		]) {
			expect(windowsWrapper).toContain(nativeKind);
		}
		expect(windowsWrapper).toContain("default:\n            return false;");
		expect(windowsWrapper).toContain("loadWebView2PermissionPolicy();");
	});
});
