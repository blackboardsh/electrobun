import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(
	join(import.meta.dirname, "../native/linux/nativeWrapper.cpp"),
	"utf8",
);

const countNoArgumentCalls = (functionName: string) =>
	[
		...source.matchAll(
			new RegExp(`\\b${functionName}\\s*\\(\\s*\\)\\s*;`, "g"),
		),
	].length;

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
		const removeStart = source.indexOf("void removeInternal", cefClass);
		const remove = source.slice(
			removeStart,
			source.indexOf("bool canGoBack() override", removeStart),
		);

		expect(destructor).toContain("client->DetachOwnerCallbacks()");
		expect(destructor).toContain("browser->GetHost()->CloseBrowser(false)");
		expect(remove).toContain("client->DetachOwnerCallbacks()");
		expect(remove).not.toContain("OperationGuard guard;");
		expect(remove).toContain("if (isRemoved) return");
		expect(remove).toContain("CloseBrowser(true)");
		expect(remove).toContain("removeForParentDestruction()");
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

	test("runs CEF's supported message loop and drains browsers before shutdown", () => {
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
		const webKitLoopStart = source.indexOf("void runGTKEventLoop()");
		const webKitLoop = source.slice(
			webKitLoopStart,
			source.indexOf("void runEventLoop()", webKitLoopStart),
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
		expect(drain).toContain("if (!cefBrowsersFinishedClosing())");
		expect(drain).toContain("CefQuitMessageLoop()");
		expect(drain.indexOf("if (!cefBrowsersFinishedClosing())")).toBeLessThan(
			drain.indexOf("CefQuitMessageLoop()"),
		);

		// CEF owns the GLib integration on Linux. Initialization must happen before
		// entering its loop, and its one shutdown call belongs after the loop exits.
		expect(runLoop).toContain("initializeCEF()");
		expect(runLoop.indexOf("initializeCEF()")).toBeLessThan(
			runLoop.indexOf("CefRunMessageLoop()"),
		);
		expect(runLoop.indexOf("CefRunMessageLoop()")).toBeLessThan(
			runLoop.indexOf("CefShutdown()"),
		);
		expect(countNoArgumentCalls("CefRunMessageLoop")).toBe(1);
		expect(countNoArgumentCalls("CefQuitMessageLoop")).toBe(1);
		expect(countNoArgumentCalls("CefShutdown")).toBe(1);

		// The WebKit-only path still uses GTK's loop and never enters CEF.
		expect(webKitLoop).toContain("gtk_main()");
		expect(webKitLoop).not.toContain("CefRunMessageLoop");
		expect(webKitLoop).not.toContain("CefShutdown");
	});

	test("does not poll CEF from a fixed-interval GTK source", () => {
		expect(countNoArgumentCalls("CefDoMessageLoopWork")).toBe(0);
		expect(source.includes("cef_timer_callback")).toBe(false);
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
		expect(source).toContain("view->removeForParentDestruction()");
		expect(source).toContain(
			"never invoke it while holding the map lock",
		);
	});

	test("owns and cancels the temporary OOPIF layout source", () => {
		const clientStart = source.indexOf("class ElectrobunClient");
		const client = source.slice(
			clientStart,
			source.indexOf(
				"// Initialize static debounce timestamp",
				clientStart,
			),
		);
		const detachStart = client.indexOf("void DetachOwnerCallbacks()");
		const detach = client.slice(
			detachStart,
			client.indexOf("void SetBrowserPreloadScript", detachStart),
		);
		const beforeCloseStart = client.indexOf("void OnBeforeClose");
		const beforeClose = client.slice(
			beforeCloseStart,
			client.indexOf("void OnLoadingStateChange", beforeCloseStart),
		);

		expect(client).toContain("guint layout_interval_source_id_");
		expect(client).toContain("layout_interval_source_id_ = g_timeout_add_full(");
		expect(client).toContain("delete static_cast<LayoutIntervalData*>(data)");
		expect(detach).toContain("CancelLayoutInterval()");
		expect(beforeClose).toContain("CancelLayoutInterval()");
	});

	test("forwards OSR input from the shared X11 loop without per-view polling", () => {
		const osrSetupStart = source.indexOf(
			"if (this->parentTransparent && x11win && x11win->transparent)",
		);
		const osrSetup = source.slice(
			osrSetupStart,
			source.indexOf("SetBrowserCloseCallback", osrSetupStart),
		);
		const x11LoopStart = source.indexOf("gboolean process_x11_events");
		const x11Loop = source.slice(
			x11LoopStart,
			source.indexOf("void runCEFEventLoop()", x11LoopStart),
		);

		expect(osrSetup).toContain("registerOSRClientForWindow");
		expect(osrSetup.includes("g_timeout_add_full")).toBe(false);
		expect(osrSetup.includes("g_idle_add_full")).toBe(false);
		expect(osrSetup.includes("processX11EventsForOSR")).toBe(false);
		expect(source.includes("osr_timeout_source_id_")).toBe(false);
		expect(source.includes("osr_idle_source_id_")).toBe(false);
		expect(x11Loop).toContain("forwardX11EventToOSRClient");
	});
});
