import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nativeWrapper = readFileSync(
	join(import.meta.dirname, "../native/win/nativeWrapper.cpp"),
	"utf8",
);
const browserView = readFileSync(
	join(import.meta.dirname, "../sdks/bun/core/BrowserView.ts"),
	"utf8",
);
const packageBuild = readFileSync(
	join(import.meta.dirname, "../../build.ts"),
	"utf8",
);
const dashConfig = readFileSync(
	join(import.meta.dirname, "../../dash.config.ts"),
	"utf8",
);
const nativeUiTestScript = readFileSync(
	join(import.meta.dirname, "../../scripts/test-windows-ui-native.js"),
	"utf8",
);

function sourceBetween(start: string, end: string): string {
	const startIndex = nativeWrapper.indexOf(start);
	const endIndex = nativeWrapper.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return nativeWrapper.slice(startIndex, endIndex);
}

describe("Windows Unicode native UI source contract", () => {
	test("uses Unicode window, menu, tray, and message APIs", () => {
		expect(nativeWrapper).not.toContain("AppendMenuA(");
		expect(nativeWrapper).not.toContain("ModifyMenuA(");
		expect(nativeWrapper).not.toContain("MessageBoxA(");
		expect(nativeWrapper).not.toContain("RegisterClassA(");
		expect(nativeWrapper).not.toContain("CreateWindowExA(");
		expect(nativeWrapper).toContain("electrobun::appendMenuUtf8(");
		expect(nativeWrapper).toContain("electrobun::setWindowTextUtf8(");
		expect(nativeWrapper).toContain("Shell_NotifyIconW(");
	});

	test("binds a ContainerView HWND before dispatching WM_NCCREATE", () => {
		const windowProc = sourceBetween(
			"static LRESULT CALLBACK ContainerWndProc",
			"LRESULT HandleMessage",
		);
		expect(windowProc).toContain("container->m_hwnd = hwnd;");
		expect(windowProc.indexOf("container->m_hwnd = hwnd;")).toBeLessThan(
			windowProc.indexOf("container->HandleMessage("),
		);
	});

	test("uses TaskDialogIndirect for custom indexed message-box buttons", () => {
		const dialog = sourceBetween(
			"using TaskDialogIndirectFn",
			"// Clipboard API",
		);
		expect(dialog).toContain('GetProcAddress(commonControls, "TaskDialogIndirect")');
		expect(dialog).toContain(
			"activationConfig.lpResourceName = MAKEINTRESOURCEW(2);",
		);
		expect(dialog).toContain("config.pButtons = taskButtons.data();");
		expect(dialog).toContain("config.nDefaultButton");
		expect(dialog).toContain("windowsTaskDialogButtonIndex(");
		expect(nativeWrapper).toContain("Microsoft.Windows.Common-Controls");
		expect(packageBuild).toContain("link /DLL /MANIFEST:EMBED");
	});

	test("owns notification icons with the dispatcher HWND until shell completion", () => {
		const notification = sourceBetween(
			"ELECTROBUN_EXPORT void showNotification",
			"ELECTROBUN_EXPORT const char* openFileDialog",
		);
		expect(notification).toContain(
			"HWND owner = MainThreadDispatcher::message_window();",
		);
		expect(notification).toContain("nid.hWnd = owner;");
		expect(notification).toContain("nid.uCallbackMessage = WM_ELECTROBUN_NOTIFICATION;");
		expect(notification).toContain("Shell_NotifyIconW(NIM_ADD, &nid)");
		expect(notification).toContain("Shell_NotifyIconW(NIM_MODIFY, &nid)");
		expect(notification).not.toContain("nid.hWnd = NULL");
	});

	test("wires native Unicode UI coverage without compiling it off Windows", () => {
		expect(dashConfig).toContain(
			'"test:windows-ui-native": "hutch scripts/test-windows-ui-native.js"',
		);
		expect(dashConfig).toContain("hutch test:windows-ui-native");
		expect(nativeUiTestScript).toContain(
			'if (process.platform !== "win32")',
		);
		expect(nativeUiTestScript).toContain("windows_ui_test.cpp");
		expect(nativeUiTestScript).toContain("ELECTROBUN_NATIVE_WRAPPER_DLL");
		expect(nativeUiTestScript).toContain("libNativeWrapper.dll");
	});
});

describe("Windows RPC Unicode transport source contract", () => {
	test("strictly converts every user-controlled WebView2 string", () => {
		for (const conversion of [
			"electrobun::utf8ToWide(suggestedStr, suggestedNameW)",
			"electrobun::utf8ToWide(urlStr, url)",
			"electrobun::utf8ToWide(htmlCopy, html)",
			"electrobun::utf8ToWide(jsStringCopy, js)",
			"electrobun::utf8ToWide(scriptContent, wScript)",
			"electrobun::utf8ToWide(combinedScript, wScript)",
			"electrobun::utf8ToWide(view->pendingHtml, html)",
			"electrobun::wideToUtf8(destPath, utf8Path)",
		]) {
			expect(nativeWrapper).toContain(conversion);
		}
		expect(nativeWrapper).not.toMatch(
			/std::wstring\s+\w+\([^\n;]*\.begin\(\)[^\n;]*\.end\(\)/,
		);
		expect(nativeWrapper).not.toContain("WideCharToMultiByte(");
		expect(nativeWrapper).not.toContain("MultiByteToWideChar(");
	});

	test("batches Bun-to-webview messages through JSON execute fallback", () => {
		expect(browserView).toContain(
			'const HOST_MESSAGE_SOCKET_AVAILABLE = process.platform !== "win32";',
		);
		expect(browserView).toContain(
			"message: JSON.stringify(queuedMessage.message)",
		);
		expect(browserView).toContain("sendHostMessagesToWebviewViaExecute(");
		expect(browserView).toContain(
			"window.__electrobun.receiveMessageFromHost(${message});",
		);
	});
});
