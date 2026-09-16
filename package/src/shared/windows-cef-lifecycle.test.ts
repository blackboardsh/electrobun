import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
	join(import.meta.dirname, "../native/win/nativeWrapper.cpp"),
	"utf8",
);

describe("Windows CEF lifecycle", () => {
	test("waits for every browser to reach OnBeforeClose", () => {
		const shutdownStart = source.indexOf("static void beginCEFShutdownOnMainThread");
		const shutdown = source.slice(
			shutdownStart,
			source.indexOf("static void releaseCEFReferencesBeforeShutdown", shutdownStart),
		);
		const beforeCloseStart = source.indexOf(
			"void OnBeforeClose(CefRefPtr<CefBrowser> browser) override",
		);
		const beforeClose = source.slice(
			beforeCloseStart,
			source.indexOf("private:", beforeCloseStart),
		);

		expect(shutdown).toContain("host->CloseBrowser(true)");
		expect(shutdown).toContain("while ((!g_cefBrowsers.empty()");
		expect(shutdown).toContain("g_pendingCefBrowserCreations.load() != 0");
		expect(shutdown).toContain("CefDoMessageLoopWork()");
		expect(beforeClose).toContain(
			"untrackCEFBrowser(browser)",
		);
		expect(beforeClose).toContain("quitCEFMessageLoopWhenDrained()");
	});

	test("tracks all browsers and has an in-loop shutdown deadline", () => {
		const lifeSpanStart = source.indexOf("class ElectrobunLifeSpanHandler");
		const lifeSpan = source.slice(
			lifeSpanStart,
			source.indexOf("class RemoteDevToolsClient", lifeSpanStart),
		);
		const loopStart = source.indexOf("ELECTROBUN_EXPORT void startEventLoop");
		const loop = source.slice(
			loopStart,
			source.indexOf("ELECTROBUN_EXPORT void stopEventLoop", loopStart),
		);

		expect(lifeSpan).toContain("trackCEFBrowser(browser)");
		expect(lifeSpan).toContain(
			"DoClose: Returning true to preserve parent window",
		);
		expect(lifeSpan).toContain(
			"DoClose: Returning false for final owner teardown",
		);
		expect(loop).toContain("CEF_SHUTDOWN_TIMER_ID");
		expect(loop).toContain("g_cefShutdownTimedOut.store(true)");
		expect(loop).toContain("PostQuitMessage(0)");
	});

	test("marshals stop requests to the native UI thread", () => {
		const stopStart = source.indexOf("ELECTROBUN_EXPORT void stopEventLoop()");
		const stop = source.slice(
			stopStart,
			source.indexOf("ELECTROBUN_EXPORT void killApp()", stopStart),
		);

		expect(stop).toContain("MainThreadDispatcher::dispatch_async");
		expect(stop).toContain("beginCEFShutdownOnMainThread()");
		expect(stop).not.toContain("PostQuitMessage(0)");
	});

	test("releases contexts before CEF shutdown without killing the host job", () => {
		const loopStart = source.indexOf("ELECTROBUN_EXPORT void startEventLoop");
		const loop = source.slice(
			loopStart,
			source.indexOf("ELECTROBUN_EXPORT void stopEventLoop", loopStart),
		);

		expect(loop.indexOf("drainCEFForShutdownOnMainThread")).toBeLessThan(
			loop.indexOf("releaseCEFReferencesBeforeShutdown"),
		);
		expect(loop.indexOf("releaseCEFReferencesBeforeShutdown")).toBeLessThan(
			loop.indexOf("CefShutdown()"),
		);
		expect(source).toContain("electrobun::partitionContextMap_().clear()");
		expect(source).toContain("container->ReleaseCEFReferencesForShutdown()");
		expect(source).toContain("g_retainedAbstractViews");
		expect(source).toContain("cefView->ReleaseCEFReferencesForShutdown()");
		expect(source).not.toContain("TerminateCEFHelperProcesses");
		expect(loop).not.toContain("CloseHandle(g_job_object)");
	});

	test("releases a client when isolated request-context creation fails", () => {
		const contextStart = source.indexOf(
			"CefRefPtr<CefRequestContext> requestContext = CreateRequestContextForPartition",
		);
		const contextFailure = source.slice(
			contextStart,
			source.indexOf("// Pass sandbox flag", contextStart),
		);

		expect(contextFailure).toContain("if (!requestContext)");
		expect(contextFailure).toContain("client->PrepareForBrowserClose()");
		expect(contextFailure).toContain("view->setClient(nullptr)");
	});

	test("cancels and joins remote DevTools work before CEF teardown", () => {
		expect(source).toContain("trackRemoteDevToolsThread(std::thread(");
		expect(source).toContain("joinRemoteDevToolsThreads()");
		expect(source).toContain("CanCreateRemoteDevTools()");
		expect(source).toContain("host.client->DetachCallback()");
		expect(source).toContain("host.dt_ctx->browser = nullptr");
	});

	test("creates browsers asynchronously without re-entering the runtime FFI call", () => {
		const browserStart = source.indexOf("static std::shared_ptr<CEFView> createCEFView");
		const browserCreation = source.slice(
			browserStart,
			source.indexOf("// Console control handler", browserStart),
		);

		expect(source).not.toContain("class WindowsPartitionContextHandler");
		expect(source).not.toContain("WaitUntilInitialized");
		expect(browserCreation).toContain("CefBrowserHost::CreateBrowser(");
		expect(browserCreation).not.toContain("CreateBrowserSync(");
		expect(browserCreation).toContain('"about:blank"');
		expect(browserCreation).toContain("MarkInitialBrowserCreationPending()");
		expect(browserCreation).toContain("SetBrowserCreatedCallback(");
		expect(browserCreation.indexOf("browserToWebviewMap[browser->GetIdentifier()]")).toBeLessThan(
			browserCreation.indexOf("readyView->setBrowser(browser)"),
		);
		expect(browserCreation.indexOf("view->pendingStartTransparent = startTransparent")).toBeLessThan(
			browserCreation.indexOf("CefBrowserHost::CreateBrowser("),
		);
		expect(source).toContain("retainAbstractView(cefView)");
		expect(source).toContain("CefString(&settings.root_cache_path) = userDataDir");
		expect(source).toContain(
			"electrobun::WINDOWS_CEF_CACHE_FORMAT_VERSION",
		);
		expect(source).not.toContain("settings.persist_session_cookies = true");
	});

	test("retains constructor-adjacent navigation until OnAfterCreated", () => {
		const cefViewStart = source.indexOf("class CEFView : public AbstractView");
		const cefView = source.slice(
			cefViewStart,
			source.indexOf("// Helper function to set browser on CEFView", cefViewStart),
		);

		expect(cefView).toContain("has_pending_url = true");
		expect(cefView).toContain("has_pending_html = true");
		expect(cefView).toContain("if (browser && has_pending_html)");
		expect(cefView).toContain("else if (browser && has_pending_url)");
		expect(source).toContain("MainThreadDispatcher::dispatch_sync([abstractView, url]");
		expect(source).toContain("MainThreadDispatcher::dispatch_sync([abstractView, html]");
	});

	test("serializes removal with asynchronous browser creation", () => {
		const removeStart = source.indexOf("ELECTROBUN_EXPORT void webviewRemove");
		const remove = source.slice(
			removeStart,
			source.indexOf("ELECTROBUN_EXPORT BOOL webviewCanGoBack", removeStart),
		);

		expect(remove).toContain("MainThreadDispatcher::dispatch_sync");
		expect(source).toContain("DetachOwnerCallback()");
		expect(source).toContain("pendingClient->PrepareForBrowserClose()");
	});

	test("serializes browser-dependent exports with OnAfterCreated", () => {
		const navigationStart = source.indexOf("ELECTROBUN_EXPORT void webviewGoBack");
		const navigation = source.slice(
			navigationStart,
			source.indexOf("ELECTROBUN_EXPORT void testFFI", navigationStart),
		);

		expect(navigation.match(/MainThreadDispatcher::dispatch_sync/g)?.length).toBe(7);
		expect(navigation).toContain("const std::string scriptCopy(script)");
		expect(navigation).toContain("abstractView->hasCreationFailed()");
	});

	test("allows enough time for CEF's bounded shutdown on slow hosts", () => {
		expect(source).toContain(
			"static constexpr int CEF_GRACEFUL_SHUTDOWN_WAIT_MS = 15000",
		);
		expect(source).toContain(
			"(std::max)(timeoutMs, CEF_GRACEFUL_SHUTDOWN_WAIT_MS)",
		);
	});
});
