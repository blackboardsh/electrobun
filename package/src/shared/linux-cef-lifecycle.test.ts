import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

describe("Linux CEF view lifecycle", () => {
	test("detaches owner callbacks on explicit removal and destruction", () => {
		const cefClass = source.indexOf(
			"class CEFWebViewImpl : public AbstractView",
		);
		const destructor = source.slice(
			source.indexOf("~CEFWebViewImpl()", cefClass),
			source.indexOf(
				"void createCEFBrowser",
				source.indexOf("~CEFWebViewImpl()", cefClass),
			),
		);
		const removeStart = source.indexOf("void remove() override", cefClass);
		const remove = source.slice(
			removeStart,
			source.indexOf("bool canGoBack() override", removeStart),
		);

		expect(destructor).toContain("client->DetachOwnerCallbacks()");
		expect(destructor).toContain("browser->GetHost()->CloseBrowser(false)");
		expect(remove).toContain("client->DetachOwnerCallbacks()");
	});

	test("closes a browser created after its owner was removed", () => {
		const afterCreated = source.slice(
			source.indexOf("void OnAfterCreated"),
			source.indexOf("void OnBeforeClose"),
		);

		expect(afterCreated).toContain(
			"if (g_shuttingDown.load() || owner_detached_.load())",
		);
		expect(afterCreated).toContain(
			"browser->GetHost()->CloseBrowser(g_shuttingDown.load())",
		);
	});

	test("drains every live and pending CEF browser before shutdown", () => {
		const afterCreatedStart = source.indexOf("void OnAfterCreated");
		const afterCreated = source.slice(
			afterCreatedStart,
			source.indexOf("void OnBeforeClose", afterCreatedStart),
		);
		const beforeCloseStart = source.indexOf(
			"void OnBeforeClose",
			afterCreatedStart,
		);
		const beforeClose = source.slice(
			beforeCloseStart,
			source.indexOf("void OnLoadingStateChange", beforeCloseStart),
		);
		const drainStart = source.indexOf("static bool cefBrowsersFinishedClosing");
		const drain = source.slice(
			drainStart,
			source.indexOf("// Global debounce state", drainStart),
		);
		const runLoopStart = source.indexOf("void runCEFEventLoop()");
		const runLoop = source.slice(
			runLoopStart,
			source.indexOf("void runGTKEventLoop()", runLoopStart),
		);

		expect(afterCreated).toContain("ResolveInitialBrowserCreationPending()");
		expect(afterCreated).toContain(
			"g_liveCefBrowsers[browser->GetIdentifier()] = browser",
		);
		expect(beforeClose).toContain(
			"g_liveCefBrowsers.erase(browser->GetIdentifier())",
		);
		expect(drain).toContain("g_pendingCefBrowserCreations.load() != 0");
		expect(drain).toContain("g_liveCefBrowsers.empty()");
		expect(drain).toContain("CefDoMessageLoopWork()");
		expect(drain).toContain("if (!cefBrowsersFinishedClosing())");
		expect(drain.indexOf("if (!cefBrowsersFinishedClosing())")).toBeLessThan(
			drain.indexOf("gtk_main_quit()"),
		);
		expect(runLoop.indexOf("gtk_main()")).toBeLessThan(
			runLoop.indexOf("CefShutdown()"),
		);
	});

	test("routes the legacy native shutdown export through the coordinated path", () => {
		const shutdownStart = source.indexOf("void shutdownNativeWrapper()");
		const shutdown = source.slice(
			shutdownStart,
			source.indexOf("\n}\n", shutdownStart),
		);

		expect(shutdown).toContain("stopEventLoop()");
		expect(shutdown).not.toContain("CefShutdown()");
	});

	test("removes CEF children before destroying their X11 parent", () => {
		expect(source).toContain("removeCEFViewsForParentWindow(x11_window)");
		expect(source).toContain(
			"never invoke it while holding the map lock",
		);
	});

	test("removes GLib OSR sources before releasing their shared state", () => {
		expect(source).toContain("g_source_remove(osr_timeout_source_id_)");
		expect(source).toContain("g_source_remove(osr_idle_source_id_)");
		expect(source).toContain("std::shared_ptr<OSREventData>");
	});
});
