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
			"// Internal factory method for creating WebView2 instances",
		);
		const controllerSetup = sourceBetween(
			"// Set bounds and visibility. BrowserWindow's full-size view must use",
			"// Make sure the controller is visible",
		);

		expect(boundsHelper).toContain("if (fullSize)");
		expect(boundsHelper).toContain("GetClientRect(containerHwnd, &clientBounds)");
		expect(controllerSetup).toContain("RECT bounds = initialWebView2Bounds(");
		expect(controllerSetup).toContain("ctrl->put_Bounds(bounds)");
		expect(controllerSetup).toContain("view->visualBounds = bounds");
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
