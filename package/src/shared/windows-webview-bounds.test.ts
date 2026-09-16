import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const windowsWrapper = readFileSync(
	join(import.meta.dirname, "../native/win/nativeWrapper.cpp"),
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

describe("Windows WebView2 viewport bounds", () => {
	it("uses the live container client rect when a full-size controller becomes ready", () => {
		const boundsHelper = sourceBetween(
			"static RECT initialWebView2Bounds(",
			"static bool isCurrentWebView2Container(",
		);
		const controllerSetup = sourceBetween(
			"// Set initial bounds from the latest requested state.",
			"view->applyPageZoom();",
		);

		expect(boundsHelper).toContain("if (view->fullSize)");
		expect(boundsHelper).toContain("GetClientRect(containerHwnd, &clientBounds)");
		expect(controllerSetup).toContain("RECT bounds = initialWebView2Bounds(");
		expect(controllerSetup).toContain("ctrl->put_Bounds(bounds)");
		expect(controllerSetup).toContain("view->visualBounds = bounds");
	});

	it("resolves fixed-size views from their latest logical frame at the current DPI", () => {
		const boundsHelper = sourceBetween(
			"static RECT initialWebView2Bounds(",
			"static bool isCurrentWebView2Container(",
		);

		expect(boundsHelper).toContain("WebView2View* view");
		expect(boundsHelper).toContain("view->physicalFrameForDpi(");
		expect(boundsHelper).toContain("electrobun::windowsDpiForWindow(containerHwnd), bounds");
		expect(boundsHelper).not.toContain("double x");
		expect(boundsHelper).not.toContain("double width");
		expect(boundsHelper.indexOf("view->physicalFrameForDpi(")).toBeLessThan(
			boundsHelper.indexOf("if (view->fullSize)"),
		);
	});

	it("keeps resize handling on the parent client-area path", () => {
		const windowResize = sourceBetween(
			"// Resize container to match window client area",
			"if (data && data->resizeHandler)",
		);

		expect(windowResize).toContain("GetClientRect(hwnd, &clientRect)");
		expect(windowResize).toContain("ResizeAutoSizingViews(width, height)");
	});
});
