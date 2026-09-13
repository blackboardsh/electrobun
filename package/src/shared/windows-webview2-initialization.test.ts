import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source contracts complement the real delayed-controller Kitchen regression.
// These assertions alone do not establish Windows runtime or visible UI coverage.
const source = readFileSync(join(import.meta.dirname, "../native/win/nativeWrapper.cpp"), "utf8");

function section(start: string, end: string, text = source) {
	const offset = text.indexOf(start);
	const limit = text.indexOf(end, offset + start.length);
	if (offset < 0 || limit < 0) throw new Error(`Missing native section: ${start} ... ${end}`);
	return text.slice(offset, limit);
}

function precedes(text: string, earlier: string, later: string) {
	expect(text).toContain(earlier);
	expect(text).toContain(later);
	expect(text.indexOf(earlier)).toBeLessThan(text.indexOf(later));
}

const view = section("class WebView2View : public AbstractView", "ComPtr<ICoreWebView2Controller> getController()");
const controllerCompletion = section("auto controllerCompletedHandler =", "const auto held = g_webview2TestHeldControllers.find(view->webviewId);");

describe("Windows WebView2 asynchronous initialization source contracts", () => {
	test("retains the latest visibility request before checking controller readiness", () => {
		const transparent = section("void setTransparent(bool transparent) override", "// Override passthrough implementation", view);
		precedes(transparent, "if (removed) return;", "pendingStartTransparent = transparent;");
		precedes(transparent, "pendingStartTransparent = transparent;", "if (!controller || !isCreationComplete)");
		expect(transparent).toContain("controller->put_IsVisible(transparent ? FALSE : TRUE)");
	});

	test("retains both desired and logical passthrough state before controller readiness", () => {
		const passthrough = section("void setPassthrough(bool enable) override", "void resize(const RECT& frame", view);
		precedes(passthrough, "if (removed) return;", "pendingStartPassthrough = enable;");
		precedes(passthrough, "pendingStartPassthrough = enable;", "if (!controller || !containerHwnd)");
		precedes(passthrough, "AbstractView::setPassthrough(enable)", "if (!controller || !containerHwnd)");
	});

	test("retains bounds and masks without a controller and applies COM bounds without a second queue", () => {
		const resize = view.slice(view.indexOf("void resize(const RECT& frame"));
		precedes(resize, "if (removed) return;", "visualBounds = frame;");
		precedes(resize, "visualBounds = frame;", "if (!controller) return;");
		precedes(resize, "maskJSON = newMaskJSON;", "if (!controller) return;");
		precedes(resize, "maskJSON.clear();", "if (!controller) return;");
		precedes(resize, "if (!controller) return;", "controller->put_Bounds(frame)");
		expect(resize).not.toContain("MainThreadDispatcher::dispatch_async");
		expect(resize).not.toContain("Controller is NULL, cannot resize");
	});

	test("reconciles current geometry, masks and input before revealing and marking the controller ready", () => {
		const reconcile = controllerCompletion.slice(controllerCompletion.indexOf("// The resize queue can have been drained before"));
		precedes(controllerCompletion, "ctrl->put_IsVisible(FALSE)", "view->setController(");
		precedes(reconcile, "view->consumePendingResize(pendingFrame, pendingMasks)", "bounds = initialWebView2Bounds(container->GetHwnd(), view.get());");
		precedes(reconcile, "view->resize(pendingFrame, pendingMasks.c_str());", "view->resize(bounds, view->maskJSON.c_str());");
		precedes(reconcile, "view->resize(bounds, view->maskJSON.c_str());", "view->applyVisualMask();");
		precedes(reconcile, "view->applyVisualMask();", "view->setPassthrough(view->pendingStartPassthrough);");
		precedes(reconcile, "view->setPassthrough(view->pendingStartPassthrough);", "ctrl->put_IsVisible(view->pendingStartTransparent ? FALSE : TRUE);");
		precedes(reconcile, "ctrl->put_IsVisible(view->pendingStartTransparent ? FALSE : TRUE);", "view->setCreationComplete(true);");
		precedes(reconcile, "view->setCreationComplete(true);", "trackAbstractView(view.get());");
		expect(controllerCompletion).not.toContain("pendingStartTransparent = false");
		expect(controllerCompletion).not.toContain("pendingStartPassthrough = false");
	});

	test("checks parent identity before either asynchronous callback uses the captured container", () => {
		const current = section("static bool isCurrentWebView2Container(", "// Private native regression seam");
		expect(current).toContain("view->isRemoved() || view->creationFailed || g_eventLoopStopping.load()");
		expect(current).toContain("!IsWindow(view->parentWindow)");
		expect(current).toContain("g_containerViews.find(view->parentWindow)");
		expect(current).toContain("current->second.get() == container");
		expect(current).not.toContain("container->");
		const environment = section("auto environmentCompletedHandler =", "auto controllerCompletedHandler =");
		precedes(environment, "if (!isCurrentWebView2Container(view.get(), container))", "container->GetHwnd()");
		precedes(controllerCompletion, "if (!isCurrentWebView2Container(view.get(), container))", "container->GetHwnd()");
		const staleController = section("if (!isCurrentWebView2Container(view.get(), container))", "if (FAILED(result))", controllerCompletion);
		precedes(staleController, "if (controller) controller->Close();", "return S_OK;");
	});

	test("removal cancels queued and held initialization before closing controller references", () => {
		const removal = section("void remove() override", "// Override transparency implementation", view);
		precedes(removal, "removed = true;", "controller->Close()");
		precedes(removal, "isCreationComplete = false;", "controller->Close()");
		precedes(removal, "g_pendingResizeQueue.remove(this);", "controller->Close()");
		precedes(removal, "g_webview2TestHeldControllers.erase(webviewId);", "controller->Close()");
		expect(view).toContain("return isCreationComplete && !creationFailed && !removed;");
	});

	test("limits diagnostic controls to opt-in processes, the native thread and an exact held view", () => {
		const hooks = section("static bool webview2KitchenTestsEnabled()", "// Internal factory method for creating WebView2 instances");
		for (const name of ["webview2TestHoldNextController", "webview2TestReleaseController", "webview2TestGetState"]) {
			expect(hooks).toContain(`extern "C" ELECTROBUN_EXPORT bool ${name}(`);
		}
		expect(hooks).toContain('g_electrobunChannel == "dev" ||');
		expect(hooks).toContain('getEnvironmentVariableWide(L"ELECTROBUN_KITCHEN_WEBVIEW2_TEST") == L"1"');
		expect(hooks.match(/MainThreadDispatcher::dispatch_sync/g)).toHaveLength(3);
		expect(hooks.match(/if \(!webview2KitchenTestsEnabled\(\)/g)).toHaveLength(3);
		const release = section("ELECTROBUN_EXPORT bool webview2TestReleaseController(", "ELECTROBUN_EXPORT bool webview2TestGetState(", hooks);
		expect(release).toContain("g_webview2TestHeldControllers.find(webviewId)");
		precedes(release, "g_webview2TestHeldControllers.erase(held);", "createController();");
		const snapshot = hooks.slice(hooks.indexOf("ELECTROBUN_EXPORT bool webview2TestGetState("));
		expect(snapshot).toContain("view->consumePendingResize(pendingFrame, pendingMasks)");
		expect(snapshot).toContain("controller->get_Bounds(&bounds)");
		expect(snapshot).toContain("controller->get_IsVisible(&visible)");
		expect(snapshot).toContain("view->pendingResizeGeneration.load()");
		expect(snapshot).not.toContain("storePendingResize(");
		expect(snapshot).not.toContain("setLogicalFrame(");
	});
});
