import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const windowsWrapper = readFileSync(
	join(import.meta.dirname, "../native/win/nativeWrapper.cpp"),
	"utf8",
);
const overlaySync = readFileSync(
	join(import.meta.dirname, "../preload/overlaySync.ts"),
	"utf8",
);
const webviewTag = readFileSync(
	join(import.meta.dirname, "../preload/webviewTag.ts"),
	"utf8",
);
const wgpuTag = readFileSync(
	join(import.meta.dirname, "../preload/wgpuTag.ts"),
	"utf8",
);

function sourceBetween(start: string, end: string) {
	const startIndex = windowsWrapper.indexOf(start);
	const endIndex = windowsWrapper.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`Could not find native source section: ${start} ... ${end}`);
	}
	return windowsWrapper.slice(startIndex, endIndex);
}

describe("Windows per-monitor DPI and window shell", () => {
	it("selects PMv2 before creating the event-loop HWND", () => {
		const eventLoop = sourceBetween(
			"ELECTROBUN_EXPORT void startEventLoop(",
			"ELECTROBUN_EXPORT void stopEventLoop()",
		);

		expect(windowsWrapper).toContain("SetProcessDpiAwarenessContext");
		expect(windowsWrapper).toContain("SetThreadDpiAwarenessContext");
		expect(eventLoop.indexOf("configurePerMonitorDpiAwareness()"))
			.toBeLessThan(eventLoop.indexOf("CreateWindow"));
	});

	it("accepts the suggested per-monitor rectangle on DPI changes", () => {
		const dpiChange = sourceBetween("case WM_DPICHANGED:", "case WM_NCCALCSIZE:");
		expect(dpiChange).toContain("suggested->left");
		expect(dpiChange).toContain("suggested->right - suggested->left");
		expect(dpiChange).toContain("SetWindowPos(");
		expect(dpiChange).toContain("NotifyParentWindowPositionChanged()");
	});

	it("updates WebView2 and reports topology-aware logical coordinates on move", () => {
		const move = sourceBetween("case WM_MOVE:", "case WM_SIZE:");
		expect(move).toContain("NotifyParentWindowPositionChanged()");
		expect(move).toContain("GetWindowRect(hwnd, &physicalFrame)");
		expect(move).toContain("windowsMonitorForHandle(");
		expect(move).toContain("physicalScreenPointToLogical(");
		expect(move).toContain("data->moveHandler(");
		expect(move.indexOf("physicalScreenPointToLogical(")).toBeLessThan(
			move.indexOf("data->moveHandler("),
		);
		expect(move).not.toContain("GET_X_LPARAM(lParam)");
		expect(move).not.toContain("GET_Y_LPARAM(lParam)");
	});

	it("uses the logical monitor topology for public window and screen geometry", () => {
		const creation = sourceBetween(
			"ELECTROBUN_EXPORT HWND createWindowWithFrameAndStyleFromWorker(",
			"ELECTROBUN_EXPORT void setWindowTitle(",
		);
		const windowGeometry = sourceBetween(
			"ELECTROBUN_EXPORT void setWindowPosition(",
			"ELECTROBUN_EXPORT void resizeWebview(",
		);
		const screenGeometry = sourceBetween(
			"static std::string serializeWindowsDisplay(",
			" * COOKIE MANAGEMENT API",
		);

		expect(creation).toContain("windowsMonitorForLogicalPoint(");
		expect(creation).toContain("logicalToPhysicalScreenRect(");
		expect(windowGeometry).toContain("logicalScreenPointToPhysical(");
		expect(windowGeometry).toContain("physicalScreenPointToLogical(");
		expect(windowGeometry).toContain("physicalToLogicalCoordinate(");
		expect(screenGeometry).toContain("windowsLogicalMonitors()");
		expect(screenGeometry).toContain("windowsMonitorForHandle(");
		expect(screenGeometry).toContain("const RECT& bounds = monitor.logicalBounds");
		expect(screenGeometry).toContain(
			"const RECT& workArea = monitor.logicalWorkArea",
		);
		expect(screenGeometry).toContain("physicalScreenPointToLogical(");
	});

	it("converts public child-view DIPs to raw Win32 pixels and reapplies them on DPI changes", () => {
		const initialWebView2Bounds = sourceBetween(
			"static RECT initialWebView2Bounds(",
			"// Internal factory method for creating WebView2 instances",
		);
		const resizeWebview = sourceBetween(
			"ELECTROBUN_EXPORT void resizeWebview(",
			"// Internal function to stop window movement",
		);
		const dpiChange = sourceBetween("case WM_DPICHANGED:", "case WM_NCCALCSIZE:");

		expect(initialWebView2Bounds).toContain("logicalToPhysicalRect(");
		expect(initialWebView2Bounds).toContain("windowsDpiForWindow(containerHwnd)");
		expect(resizeWebview).toContain("setLogicalFrame(x, y, width, height)");
		expect(resizeWebview).toContain("logicalToPhysicalRect(");
		expect(resizeWebview).toContain("abstractView->parentDpi()");
		expect(dpiChange).toContain("ResizeFixedViewsForDpi(");
	});

	it("keeps preload overlay frames and masks in DIPs until the native boundary", () => {
		const preloadOverlaySources = `${overlaySync}\n${webviewTag}\n${wgpuTag}`;

		expect(preloadOverlaySources).not.toContain("devicePixelRatio");
		expect(preloadOverlaySources).not.toContain("toNativeOverlayRect");
		expect(preloadOverlaySources).not.toContain("rectTransform");
		expect(webviewTag).toContain("frame: initialRect");
		expect(wgpuTag).toContain("frame: initialRect");
		expect(overlaySync).toContain("this.options.onSync(newRect, JSON.stringify(masks))");
	});

	it("reports CEF OSR geometry in DIPs while retaining physical paint buffers", () => {
		const renderGeometry = sourceBetween(
			"void GetViewRect(",
			"void OnPaint(",
		);

		expect(renderGeometry).toContain("physicalToLogicalSize(");
		expect(renderGeometry).toContain("CefDisplay::ConvertScreenRectFromPixels(");
		expect(renderGeometry).toContain(
			"CefDisplay::GetDisplayMatchingBounds(pixelRoot, true)",
		);
		expect(renderGeometry).toContain("display->GetDeviceScaleFactor()");
		expect(renderGeometry).toContain("display->GetBounds()");
		expect(renderGeometry).toContain("display->GetWorkArea()");
		expect(windowsWrapper).toContain("browser->GetHost()->NotifyScreenInfoChanged()");
		expect(windowsWrapper).toContain("browser->GetHost()->NotifyMoveOrResizeStarted()");
	});

	it("keeps DIP masks aligned with physical child-view hit tests and regions", () => {
		const maskHitTest = sourceBetween(
			"bool isPointInMask(POINT localPoint)",
			"// Virtual methods for subclass-specific functionality",
		);
		expect(maskHitTest).toContain("physicalToLogicalCoordinate(");
		expect(maskHitTest).toContain("parentDpi()");
		expect(windowsWrapper).toContain("const RECT holeBounds =");
		expect(windowsWrapper).toContain("maskWidth,");
		expect(windowsWrapper).toContain("maskHeight,");
	});

	it("keeps popup maximize inside the destination monitor work area", () => {
		const minMax = sourceBetween("case WM_GETMINMAXINFO:", "case WM_DPICHANGED:");
		expect(minMax).toContain("(style & WS_POPUP) != 0");
		expect(minMax).toContain("MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)");
		expect(minMax).toContain("rcWork.left - monitorInfo.rcMonitor.left");
		expect(minMax).toContain("rcWork.right - monitorInfo.rcWork.left");
	});

	it("lets WebView2 follow monitor scale/origin and native app-region hit testing", () => {
		expect(windowsWrapper).toContain(
			"ctrl3->put_ShouldDetectMonitorScaleChanges(TRUE)",
		);
		expect(windowsWrapper).toContain(
			"COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS",
		);
		expect(windowsWrapper).toContain(
			"settings9->put_IsNonClientRegionSupportEnabled(TRUE)",
		);
	});

	it("keeps native title bars synchronized with the Windows app theme", () => {
		expect(windowsWrapper).toContain('L"AppsUseLightTheme"');
		expect(windowsWrapper).toContain("case WM_SETTINGCHANGE:");
		expect(windowsWrapper).toContain("updateWindowTheme(hwnd)");
		expect(windowsWrapper).toContain(
			"setWindowAttribute(hwnd, 19, &useDarkTheme, sizeof(useDarkTheme))",
		);
	});

	it("returns focus to embedded web content when a window is activated", () => {
		const activation = sourceBetween(
			"static void activateVisibleWindow(HWND hwnd)",
			"ELECTROBUN_EXPORT void showWindow",
		);
		expect(windowsWrapper).toContain(
			"controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)",
		);
		expect(windowsWrapper).toContain("browser->GetHost()->SetFocus(true)");
		expect(windowsWrapper).toContain("void FocusActiveView()");
		expect(activation).toContain("FocusActiveView()");
	});

	it("resizes the windowless CEF viewport before requesting a repaint", () => {
		const cefResize = sourceBetween(
			"void resize(const RECT& frame, const char* masksJson) override {",
			"// CEF-specific implementation of mask functionality",
		);
		expect(cefResize).toContain("if (is_osr_mode)");
		expect(cefResize).toContain("client->SetOSRViewSize(width, height)");
		expect(cefResize.indexOf("SetOSRViewSize"))
			.toBeLessThan(cefResize.indexOf("WasResized"));
	});

	it("keeps native child views alive until the core close callback unregisters them", () => {
		const closeWindow = sourceBetween(
			"ELECTROBUN_EXPORT void closeWindow(",
			"ELECTROBUN_EXPORT void requestWindowClose(",
		);
		const windowProc = sourceBetween(
			"LRESULT CALLBACK WindowProc(",
			"static void removeTransientNotificationIcon(",
		);

		expect(closeWindow).toContain("PostMessage(hwnd, WM_CLOSE");
		expect(closeWindow).not.toContain("g_containerViews.erase");
		expect(windowProc).toContain("case WM_DESTROY:");
		expect(windowProc).toContain("g_containerViews.erase(hwnd)");
	});
});
