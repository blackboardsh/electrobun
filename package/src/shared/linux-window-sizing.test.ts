import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nativeWrapper = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux GTK window sizing source contract", () => {
	it("does not turn full-size child allocations into window minimums", () => {
		// gtk_widget_set_size_request() defines a minimum. Initial/full-size
		// allocations must remain unset so a window can shrink after it grows.
		expect(nativeWrapper).not.toContain(
			"gtk_widget_set_size_request(webview, (int)width, (int)height);",
		);
		expect(nativeWrapper).toContain(
			"gtk_widget_set_size_request(webview, -1, -1);",
		);
		expect(
			nativeWrapper.match(/autoResize \? -1 : \(int\)width/g)?.length,
		).toBe(2);
		expect(
			nativeWrapper.match(/autoResize \? -1 : \(int\)height/g)?.length,
		).toBe(2);
	});

	it("keeps WGPU native-layer masks across GTK configure events", () => {
		// configure-event also fires for pure moves. Reapplying an unchanged
		// full-size frame with an empty mask would cover positioned GTK views
		// until a later resize made the SDK send its masks again.
		const methodStart = nativeWrapper.indexOf("void resizeAutoSizingViews(");
		const methodEnd = nativeWrapper.indexOf("\n    }\n};", methodStart);
		expect(methodStart).toBeGreaterThanOrEqual(0);
		expect(methodEnd).toBeGreaterThan(methodStart);
		const resizeAutoSizingViews = nativeWrapper.slice(methodStart, methodEnd);

		expect(resizeAutoSizingViews).toContain(
			"currentBounds.width == width &&\n                    currentBounds.height == height",
		);
		expect(resizeAutoSizingViews).toContain(
			"const std::string masks = view->maskJSON;",
		);
		expect(resizeAutoSizingViews).toContain(
			"view->resize(frame, masks.c_str());",
		);
		expect(resizeAutoSizingViews).not.toContain('view->resize(frame, "");');
	});

	it("uses the full clipped offset for positioned WebKit views", () => {
		const classStart = nativeWrapper.indexOf("class WebKitWebViewImpl");
		const classEnd = nativeWrapper.indexOf("class WGPUViewImpl", classStart);
		expect(classStart).toBeGreaterThanOrEqual(0);
		expect(classEnd).toBeGreaterThan(classStart);
		const webKitView = nativeWrapper.slice(classStart, classEnd);

		expect(webKitView).toContain(
			"gtk_fixed_move(GTK_FIXED(wrapper), webview, offsetX, offsetY);",
		);
		expect(webKitView).not.toContain("offsetX / 2");
		expect(webKitView).not.toContain("offsetY / 2");

		const addStart = nativeWrapper.indexOf("void addWebview(");
		const addEnd = nativeWrapper.indexOf("void removeView(", addStart);
		expect(addStart).toBeGreaterThanOrEqual(0);
		expect(addEnd).toBeGreaterThan(addStart);
		const addWebview = nativeWrapper.slice(addStart, addEnd);
		expect(addWebview).toContain(
			"gtk_widget_set_halign(wrapper, GTK_ALIGN_START);",
		);
		expect(addWebview).toContain(
			"gtk_widget_set_valign(wrapper, GTK_ALIGN_START);",
		);
	});

	it("uses software compositing only for positioned WebKit views", () => {
		const classStart = nativeWrapper.indexOf("class WebKitWebViewImpl");
		const classEnd = nativeWrapper.indexOf("class WGPUViewImpl", classStart);
		expect(classStart).toBeGreaterThanOrEqual(0);
		expect(classEnd).toBeGreaterThan(classStart);
		const webKitView = nativeWrapper.slice(classStart, classEnd);

		expect(webKitView).toMatch(
			/if \(!autoResize\) \{\s*webkit_settings_set_hardware_acceleration_policy\(\s*settings,\s*WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER\);\s*\}/,
		);
		expect(
			webKitView.match(
				/webkit_settings_set_hardware_acceleration_policy/g,
			)?.length,
		).toBe(1);
	});

	it("implements page zoom for WebKitGTK views", () => {
		const setStart = nativeWrapper.indexOf(
			"ELECTROBUN_EXPORT void webviewSetPageZoom",
		);
		const getEnd = nativeWrapper.indexOf(
			"ELECTROBUN_EXPORT void updatePreloadScriptToWebView",
			setStart,
		);
		expect(setStart).toBeGreaterThanOrEqual(0);
		expect(getEnd).toBeGreaterThan(setStart);
		const pageZoomExports = nativeWrapper.slice(setStart, getEnd);

		expect(pageZoomExports).toContain(
			"dynamic_cast<WebKitWebViewImpl*>(abstractView)",
		);
		expect(pageZoomExports).toContain("webkit_web_view_set_zoom_level");
		expect(pageZoomExports).toContain("webkit_web_view_get_zoom_level");
	});
});
