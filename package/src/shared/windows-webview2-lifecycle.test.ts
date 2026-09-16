import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "../native/win/nativeWrapper.cpp"), "utf8");
const section = (start: string, end: string) => {
	const offset = source.indexOf(start);
	expect(offset).toBeGreaterThanOrEqual(0);
	const limit = source.indexOf(end, offset + start.length);
	expect(limit).toBeGreaterThan(offset);
	return source.slice(offset, limit);
};

describe("Windows WebView2 shutdown", () => {
	test("closes every retained root and nested view, not only the last view in a container", () => {
		const close = section("static void closeWebView2ViewsOnMainThread()", "ELECTROBUN_EXPORT void stopEventLoop()");
		expect(close).toContain("g_retainedAbstractViews");
		expect(close).toContain("std::dynamic_pointer_cast<WebView2View>(view)");
		expect(close).toContain("g_pendingResizeQueue.remove(view.get())");
		expect(close).toContain("view->remove()");
		expect(close).not.toContain("g_webview2Views");
	});

	test("closes WebView2 controllers on the native thread before either renderer loop exits", () => {
		const stop = section("ELECTROBUN_EXPORT void stopEventLoop()", "ELECTROBUN_EXPORT void killApp()");
		expect(stop.match(/MainThreadDispatcher::dispatch_async/g)).toHaveLength(2);
		expect(stop.match(/closeWebView2ViewsOnMainThread\(\)/g)).toHaveLength(2);
		expect(stop.indexOf("closeWebView2ViewsOnMainThread()")).toBeLessThan(stop.indexOf("beginCEFShutdownOnMainThread()"));
		expect(stop.lastIndexOf("closeWebView2ViewsOnMainThread()")).toBeLessThan(stop.indexOf("PostThreadMessage(g_mainThreadId, WM_QUIT"));
	});

	test("releases controller and composition references on removal", () => {
		const view = section("class WebView2View : public AbstractView", "// Override transparency implementation for WebView2");
		expect(view).toContain("controller->Close()");
		expect(view).toContain("compositionController = nullptr");
		expect(view).toContain("webview = nullptr");
	});

	test("fails visibly instead of opening a shared or non-persistent profile when the base path is too long", () => {
		const creation = section("// Create user data folder path based on partition", "    return view;");
		expect(creation).toContain("canPersistWebView2UserDataPath(userDataFolder)");
		expect(creation).toContain("view->setCreationFailed(true)");
	});
});
