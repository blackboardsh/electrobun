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
const cefClassStart = linuxWrapper.indexOf(
	"class CEFWebViewImpl : public AbstractView",
);
if (cefClassStart < 0) throw new Error("Could not find Linux CEF view class");
const cefWrapper = linuxWrapper.slice(cefClassStart);

function sectionFrom(source: string, marker: string, length = 5_000) {
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`Could not find native source marker: ${marker}`);
	return source.slice(start, start + length);
}

describe("Linux CEF child-view DPI bounds", () => {
	it("keeps fractional overlay geometry in DIPs until the native boundary", () => {
		const abstractView = sectionFrom(linuxWrapper, "class AbstractView {", 9_000);
		const resizeExport = sectionFrom(
			linuxWrapper,
			"ELECTROBUN_EXPORT void resizeWebview",
			1_000,
		);
		const maskParser = sectionFrom(linuxWrapper, "struct MaskRect", 4_000);

		expect(overlaySync).not.toContain("devicePixelRatio");
		expect(overlaySync).toContain(
			"this.options.onSync(newRect, JSON.stringify(masks))",
		);
		expect(abstractView).toContain("LogicalRect pendingResizeFrame");
		expect(abstractView).toContain("resizeLogical(const LogicalRect& frame");
		expect(abstractView).toContain("storePendingResize(const LogicalRect& frame");
		expect(resizeExport).toContain("LogicalRect frame");
		expect(resizeExport).not.toContain("GdkRectangle frame");
		expect(maskParser).toContain("double x, y, width, height");
		expect(maskParser).toContain("strtod(");
	});

	it("resolves scale from the physical monitor containing the X11 parent", () => {
		const scaleFactor = sectionFrom(
			cefWrapper,
			"double parentDeviceScaleFactor() const",
			3_500,
		);

		expect(cefWrapper).toContain("Display* parentXDisplay");
		expect(scaleFactor).toContain("XTranslateCoordinates(");
		expect(scaleFactor).toContain("CefDisplay::GetDisplayMatchingBounds(");
		expect(scaleFactor).toMatch(/physical\w*Bounds,\s*true/);
		expect(scaleFactor).toContain("GetDeviceScaleFactor()");
		expect(scaleFactor).toContain("normalizeLinuxScaleFactor(");
	});

	it("uses edge conversion for initial, deferred, and resized child bounds", () => {
		const boundsConversion = sectionFrom(
			cefWrapper,
			"double x11BoundsScaleFactor() const",
			2_000,
		);
		const creation = sectionFrom(cefWrapper, "void createCEFBrowser(", 10_000);
		const browserCreated = sectionFrom(
			creation,
			"SetBrowserCreatedCallback",
			3_000,
		);
		const positionSync = sectionFrom(
			cefWrapper,
			"void syncCEFPositionWithFrame(",
			5_000,
		);
		const logicalResize = sectionFrom(
			cefWrapper,
			"void resizeLogical(const LogicalRect& frame",
			4_000,
		);

		expect(boundsConversion).toContain("fullSize ? 1.0");
		expect(boundsConversion).toContain("LinuxPhysicalRect toX11BoundsRect(");
		expect(boundsConversion).toContain("clipLinuxLogicalRectToOrigin(");
		expect(boundsConversion).toContain("x11BoundsScaleFactor()");
		expect(creation).toContain("toX11BoundsRect(initialBounds)");
		expect(creation).toContain("window_info.SetAsChild(");
		expect(cefWrapper).toContain("LogicalRect pendingFrame");
		expect(browserCreated).toContain("finalBounds = pendingFrame");
		expect(browserCreated).toContain("resizeLogical(finalBounds");
		expect(positionSync).toContain("toX11BoundsRect(frame)");
		expect(positionSync).toContain("XMoveResizeWindow(");
		expect(logicalResize).toContain("rememberLogicalBounds(frame)");
		expect(logicalResize).toContain("syncCEFPositionWithFrame(");
	});

	it("anchors visual masks to the rounded child origin", () => {
		const masks = sectionFrom(
			cefWrapper,
			"void applyVisualMask() override",
			5_000,
		);

		expect(masks).toContain("logicalSubrectToLinuxPhysicalRect(");
		expect(masks).toContain("linuxPhysicalRectToXRectangleFields(");
		expect(masks).toContain("toX11BoundsRect(");
	});

	it("relayouts nested views and masks when their parent changes monitors", () => {
		const parentGeometry = sectionFrom(
			cefWrapper,
			"void handleParentGeometryChanged(",
			5_000,
		);
		const hookOccurrences =
			cefWrapper.match(/handleParentGeometryChanged\(/g)?.length ?? 0;

		expect(cefWrapper).toContain("double lastAppliedScaleFactor");
		expect(parentGeometry).toContain("scaleChanged");
		expect(parentGeometry).toContain("NotifyScreenInfoChanged()");
		// resizeLogical owns both the windowed/OSR bounds path and mask rebuild.
		expect(parentGeometry).toContain(
			"resizeLogical(logicalBounds, maskJSON.c_str())",
		);
		// One declaration plus at least one parent ConfigureNotify call site.
		expect(hookOccurrences).toBeGreaterThanOrEqual(2);
	});
});
