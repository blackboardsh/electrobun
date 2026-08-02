import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const linuxWrapper = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);
const overlaySync = readFileSync(
	join(import.meta.dirname, "../preload/overlaySync.ts"),
	"utf8",
);
const cefWrapper = linuxWrapper.slice(
	linuxWrapper.indexOf("class CEFWebViewImpl : public AbstractView"),
);

function sourceBetween(start: string, end: string) {
	const startIndex = cefWrapper.indexOf(start);
	const endIndex = cefWrapper.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) {
		throw new Error(`Could not find native source section: ${start} ... ${end}`);
	}
	return cefWrapper.slice(startIndex, endIndex);
}

describe("Linux CEF child-view DPI bounds", () => {
	it("keeps overlay geometry in DIPs until the native boundary", () => {
		expect(overlaySync).not.toContain("devicePixelRatio");
		expect(overlaySync).toContain(
			"this.options.onSync(newRect, JSON.stringify(masks))",
		);
	});

	it("uses the CEF display scale for the X11 parent", () => {
		const scaleFactor = sourceBetween(
			"double parentDeviceScaleFactor() const",
			"electrobun::LinuxPhysicalRect toPhysicalOverlayRect(",
		);

		expect(scaleFactor).toContain("XTranslateCoordinates(");
		expect(scaleFactor).toContain("GetDisplayMatchingBounds(");
		expect(scaleFactor).toContain("physicalBounds, true");
		expect(scaleFactor).toContain("GetDeviceScaleFactor()");
	});

	it("converts initial, resized, and mask bounds to X11 pixels", () => {
		const boundsConversion = sourceBetween(
			"electrobun::LinuxPhysicalRect toX11BoundsRect(",
			"void createCEFBrowser(",
		);
		const creation = sourceBetween(
			"void createCEFBrowser(",
			"void syncCEFPositionWithFrame(",
		);
		const resize = sourceBetween(
			"void syncCEFPositionWithFrame(",
			"void syncCEFPositionWithWidget()",
		);
		const masks = sourceBetween(
			"void applyVisualMask() override",
			"void removeMasks() override",
		);

		expect(boundsConversion).toContain("if (fullSize)");
		expect(boundsConversion).toContain("x, y, width, height, 1.0");
		expect(boundsConversion).toContain(
			"return toPhysicalOverlayRect(x, y, width, height)",
		);
		expect(creation).toContain("const auto physicalRect = toX11BoundsRect(");
		expect(creation).toContain("window_info.SetAsChild(x11win->window, cef_rect)");
		expect(resize).toContain("const auto physicalRect = toX11BoundsRect(");
		expect(resize).toContain("XMoveResizeWindow(");
		expect(resize).toContain("physicalRect.width");
		expect(masks).toContain(
			"const auto physicalMask = toPhysicalOverlayRect(",
		);
		expect(masks).toContain(
			"const auto physicalBounds = toX11BoundsRect(",
		);
	});
});
