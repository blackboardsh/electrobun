import {
	env,
	host,
	native,
	pathJoin,
	resolvePaths,
	sendRPCError,
	sendRPCMessage,
	sendRPCResponse,
	sleep,
	nowMs,
	type NativeEvent,
	type Rect,
} from "electrobun/cottontail";

const appVersion = "1.18.4-beta.6";
const defaultSecretKey =
	"1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32";
const testHarnessURL = "views://test-harness/index.html";
const cottontailViewURL = "views://zig/index.html";
const trayTemplateIconURL = "views://assets/electrobun-logo-32-template.png";
const shortWait = 150;
const mediumWait = 500;
const longWait = 1200;
const viewsRoot = pathJoin(host.cwd(), "views");

type TestKind =
	| "smoke"
	| "window_create_close"
	| "window_creation_with_url"
	| "window_hidden_option"
	| "window_inactive_show_api"
	| "window_page_zoom"
	| "window_set_title"
	| "window_minimize_unminimize"
	| "window_fullscreen_toggle"
	| "window_fullscreen_toggle_hidden_titlebar"
	| "window_set_position"
	| "window_set_size"
	| "window_set_frame"
	| "window_get_frame"
	| "window_get_position"
	| "window_get_size"
	| "window_maximize_unmaximize"
	| "window_always_on_top"
	| "window_visible_on_all_workspaces"
	| "window_focus"
	| "window_close_event"
	| "window_resize_event"
	| "window_get_by_id"
	| "window_inset_titlebar_style"
	| "window_traffic_light_position_api"
	| "webview_create"
	| "webview_page_zoom"
	| "webview_tag_playground_integration"
	| "webview_tag_playground_interactive"
	| "wgpu_tag_playground_integration"
	| "wgpu_tag_playground_interactive"
	| "navigation_load_url"
	| "navigation_load_html"
	| "navigation_dom_ready_event"
	| "navigation_did_navigate_event"
	| "navigation_execute_javascript"
	| "tray_visibility_toggle_and_bounds"
	| "session_from_partition"
	| "session_default_session"
	| "session_cookies_api_exists"
	| "application_menu_playground"
	| "context_menu_playground"
	| "dialog_show_message_box_info"
	| "dialog_file_dialog_playground"
	| "global_shortcuts_playground"
	| "global_shortcut_is_registered_api"
	| "global_shortcut_unregister_all_api"
	| "lifecycle_before_quit_cancel"
	| "quit_shutdown_playground"
	| "wgpu_adapter_context_device"
	| "dock_icon_visibility_contract"
	| "utils_clipboard_round_trip"
	| "utils_clipboard_available_formats"
	| "utils_clipboard_clear"
	| "utils_show_notification"
	| "utils_open_external_exists"
	| "utils_open_path_exists"
	| "utils_show_item_in_folder_exists"
	| "utils_quit_exists"
	| "utils_paths_object_exists"
	| "utils_paths_home_matches"
	| "utils_paths_temp_matches"
	| "utils_paths_os_directories"
	| "utils_paths_app_scoped_directories"
	| "utils_paths_stable_across_calls"
	| "utils_move_to_trash"
	| "screen_primary_display"
	| "screen_all_displays"
	| "screen_cursor_screen_point"
	| "screen_bounds_vs_workarea";

type TestInfo = {
	id: string;
	name: string;
	category: string;
	description: string;
	interactive: boolean;
	kind: TestKind;
};

type TestResult = {
	testId: string;
	name: string;
	status: "passed" | "failed";
	duration: number;
	error?: string;
};

type WindowWithWebview = { windowId: number; webviewId: number };

function test(id: string, name: string, category: string, kind: TestKind): TestInfo {
	return { id, name, category, description: name, interactive: false, kind };
}

function interactiveTest(id: string, name: string, category: string, kind: TestKind): TestInfo {
	return { ...test(id, name, category, kind), interactive: true };
}

const tests: TestInfo[] = [
	test("cottontail-smoke-test", "Cottontail host smoke test", "Cottontail Native", "smoke"),
	test("cottontail-window-create-close", "Window create/close (Cottontail)", "BrowserWindow", "window_create_close"),
	test("cottontail-window-creation-with-url", "Window creation with URL (Cottontail)", "BrowserWindow", "window_creation_with_url"),
	test("cottontail-window-hidden-option", "Window hidden option (Cottontail)", "BrowserWindow", "window_hidden_option"),
	test("cottontail-window-inactive-show-api", "Window inactive show API (Cottontail)", "BrowserWindow", "window_inactive_show_api"),
	test("cottontail-window-page-zoom", "Window page zoom API (Cottontail)", "BrowserWindow", "window_page_zoom"),
	test("cottontail-window-set-title", "Window setTitle (Cottontail)", "BrowserWindow", "window_set_title"),
	test("cottontail-window-minimize-unminimize", "Window minimize/unminimize (Cottontail)", "BrowserWindow", "window_minimize_unminimize"),
	test("cottontail-window-fullscreen-toggle", "Window fullscreen toggle (Cottontail)", "BrowserWindow", "window_fullscreen_toggle"),
	test("cottontail-window-fullscreen-toggle-hidden-titlebar", "Window fullscreen toggle with hidden titlebar (Cottontail)", "BrowserWindow", "window_fullscreen_toggle_hidden_titlebar"),
	test("cottontail-window-set-position", "Window setPosition (Cottontail)", "BrowserWindow", "window_set_position"),
	test("cottontail-window-set-size", "Window setSize (Cottontail)", "BrowserWindow", "window_set_size"),
	test("cottontail-window-set-frame", "Window setFrame (Cottontail)", "BrowserWindow", "window_set_frame"),
	test("cottontail-window-get-frame", "Window getFrame (Cottontail)", "BrowserWindow", "window_get_frame"),
	test("cottontail-window-get-position", "Window getPosition (Cottontail)", "BrowserWindow", "window_get_position"),
	test("cottontail-window-get-size", "Window getSize (Cottontail)", "BrowserWindow", "window_get_size"),
	test("cottontail-window-maximize-unmaximize", "Window maximize/unmaximize (Cottontail)", "BrowserWindow", "window_maximize_unmaximize"),
	test("cottontail-window-always-on-top", "Window alwaysOnTop (Cottontail)", "BrowserWindow", "window_always_on_top"),
	test("cottontail-window-visible-on-all-workspaces", "Window visibleOnAllWorkspaces (macOS) (Cottontail)", "BrowserWindow", "window_visible_on_all_workspaces"),
	test("cottontail-window-focus", "Window focus (Cottontail)", "BrowserWindow", "window_focus"),
	test("cottontail-window-close-event", "Window close event (Cottontail)", "BrowserWindow", "window_close_event"),
	test("cottontail-window-resize-event", "Window resize event (Cottontail)", "BrowserWindow", "window_resize_event"),
	test("cottontail-window-get-by-id", "BrowserWindow.getById (Cottontail)", "BrowserWindow", "window_get_by_id"),
	test("cottontail-window-inset-titlebar-style", "Window with inset titlebar style (Cottontail)", "BrowserWindow", "window_inset_titlebar_style"),
	test("cottontail-window-traffic-light-position-api", "Window traffic light position API (Cottontail)", "BrowserWindow", "window_traffic_light_position_api"),
	test("cottontail-webview-create", "BrowserView create (Cottontail)", "BrowserView", "webview_create"),
	test("cottontail-webview-page-zoom", "BrowserView page zoom API (Cottontail)", "BrowserWindow", "webview_page_zoom"),
	test("cottontail-webview-tag-playground-integration", "Webview Tag playground integration (Cottontail)", "Webview Tag", "webview_tag_playground_integration"),
	interactiveTest("cottontail-webview-tag-playground", "Webview Tag playground (Cottontail)", "Webview Tag (Interactive)", "webview_tag_playground_interactive"),
	test("cottontail-wgpu-tag-playground-integration", "WGPU Tag playground integration (Cottontail)", "WGPU Tag", "wgpu_tag_playground_integration"),
	interactiveTest("cottontail-wgpu-tag-playground", "WGPU Tag playground (Cottontail)", "WGPU Tag (Interactive)", "wgpu_tag_playground_interactive"),
	test("cottontail-navigation-load-url", "loadURL (Cottontail)", "Navigation", "navigation_load_url"),
	test("cottontail-navigation-load-html", "loadHTML (Cottontail)", "Navigation", "navigation_load_html"),
	test("cottontail-navigation-dom-ready-event", "dom-ready event (Cottontail)", "Navigation", "navigation_dom_ready_event"),
	test("cottontail-navigation-did-navigate-event", "did-navigate event (Cottontail)", "Navigation", "navigation_did_navigate_event"),
	test("cottontail-navigation-execute-javascript", "executeJavascript (fire and forget) (Cottontail)", "Navigation", "navigation_execute_javascript"),
	test("cottontail-tray-visibility-toggle-bounds", "Tray visibility toggle and bounds (Cottontail)", "Tray", "tray_visibility_toggle_and_bounds"),
	test("cottontail-session-from-partition", "Session.fromPartition (Cottontail)", "Session", "session_from_partition"),
	test("cottontail-session-default-session", "Session.defaultSession (Cottontail)", "Session", "session_default_session"),
	test("cottontail-session-cookies-api-exists", "cookies API exists (Cottontail)", "Session", "session_cookies_api_exists"),
	interactiveTest("cottontail-application-menu-playground", "Application menu playground (Cottontail)", "Menus (Interactive)", "application_menu_playground"),
	interactiveTest("cottontail-context-menu-playground", "Context menu playground (Cottontail)", "Menus (Interactive)", "context_menu_playground"),
	interactiveTest("cottontail-dialog-show-message-box-info", "showMessageBox - info dialog (Cottontail)", "Dialogs (Interactive)", "dialog_show_message_box_info"),
	interactiveTest("cottontail-dialog-file-dialog-playground", "File dialog playground (Cottontail)", "Dialogs (Interactive)", "dialog_file_dialog_playground"),
	interactiveTest("cottontail-global-shortcuts-playground", "Global shortcuts playground (Cottontail)", "Shortcuts (Interactive)", "global_shortcuts_playground"),
	test("cottontail-global-shortcut-is-registered-api", "GlobalShortcut.isRegistered API (Cottontail)", "Shortcuts", "global_shortcut_is_registered_api"),
	test("cottontail-global-shortcut-unregister-all-api", "GlobalShortcut.unregisterAll API (Cottontail)", "Shortcuts", "global_shortcut_unregister_all_api"),
	test("cottontail-lifecycle-before-quit-cancel", "before-quit event can cancel quit (Cottontail)", "App Lifecycle", "lifecycle_before_quit_cancel"),
	interactiveTest("cottontail-quit-shutdown-playground", "Quit/Shutdown playground (Cottontail)", "Quit (Interactive)", "quit_shutdown_playground"),
	test("cottontail-wgpu-adapter-context-device", "WebGPU adapter: context/device init (Cottontail)", "WebGPU", "wgpu_adapter_context_device"),
	test("cottontail-dock-icon-visibility-contract", "Dock icon visibility contract (Cottontail)", "Utils", "dock_icon_visibility_contract"),
	test("cottontail-utils-clipboard-round-trip", "clipboardWriteText and clipboardReadText (Cottontail)", "Utils", "utils_clipboard_round_trip"),
	test("cottontail-utils-clipboard-available-formats", "clipboardAvailableFormats (Cottontail)", "Utils", "utils_clipboard_available_formats"),
	test("cottontail-utils-clipboard-clear", "clipboardClear (Cottontail)", "Utils", "utils_clipboard_clear"),
	test("cottontail-utils-show-notification", "showNotification (Cottontail)", "Utils", "utils_show_notification"),
	test("cottontail-utils-open-external-exists", "openExternal (Cottontail)", "Utils", "utils_open_external_exists"),
	test("cottontail-utils-open-path-exists", "openPath (Cottontail)", "Utils", "utils_open_path_exists"),
	test("cottontail-utils-show-item-in-folder-exists", "showItemInFolder (Cottontail)", "Utils", "utils_show_item_in_folder_exists"),
	test("cottontail-utils-quit-function-exists", "quit function exists (Cottontail)", "Utils", "utils_quit_exists"),
	test("cottontail-utils-paths-object-exists", "paths object exists (Cottontail)", "Utils", "utils_paths_object_exists"),
	test("cottontail-utils-paths-home-matches", "paths.home matches os.homedir() (Cottontail)", "Utils", "utils_paths_home_matches"),
	test("cottontail-utils-paths-temp-matches", "paths.temp matches os.tmpdir() (Cottontail)", "Utils", "utils_paths_temp_matches"),
	test("cottontail-utils-paths-os-directories", "paths OS directories return non-empty strings (Cottontail)", "Utils", "utils_paths_os_directories"),
	test("cottontail-utils-paths-app-scoped-directories", "paths app-scoped directories return non-empty strings (Cottontail)", "Utils", "utils_paths_app_scoped_directories"),
	test("cottontail-utils-paths-stable-across-calls", "paths getters are stable across calls (Cottontail)", "Utils", "utils_paths_stable_across_calls"),
	test("cottontail-utils-move-to-trash", "moveToTrash (Cottontail)", "Utils", "utils_move_to_trash"),
	test("cottontail-screen-primary-display", "getPrimaryDisplay (Cottontail)", "Screen", "screen_primary_display"),
	test("cottontail-screen-all-displays", "getAllDisplays (Cottontail)", "Screen", "screen_all_displays"),
	test("cottontail-screen-cursor-screen-point", "getCursorScreenPoint (Cottontail)", "Screen", "screen_cursor_screen_point"),
	test("cottontail-screen-bounds-vs-workarea", "Display bounds vs workArea (Cottontail)", "Screen", "screen_bounds_vs_workarea"),
];

let searchQuery = "";
let autoRunTriggered = false;
const topLevelWebviews = new Map<number, number>();
const childWebviews = new Map<number, "native" | "cef">();
const callbacks = {
	windowCloseCount: 0,
	windowResizeCount: 0,
	windowFocusCount: 0,
	lastResizeWidth: 0,
	lastResizeHeight: 0,
	webviewDidNavigate: 0,
	webviewDomReady: 0,
	lastWebviewDetail: "",
	webviewTagInit: 0,
	wgpuTagInit: 0,
	wgpuTagReady: 0,
	beforeQuitCount: 0,
};

function requestParams(packet: any): any {
	return packet && typeof packet.params === "object" && packet.params !== null ? packet.params : packet;
}

function resetCallbacks(): void {
	callbacks.windowCloseCount = 0;
	callbacks.windowResizeCount = 0;
	callbacks.windowFocusCount = 0;
	callbacks.lastResizeWidth = 0;
	callbacks.lastResizeHeight = 0;
	callbacks.webviewDidNavigate = 0;
	callbacks.webviewDomReady = 0;
	callbacks.lastWebviewDetail = "";
	callbacks.webviewTagInit = 0;
	callbacks.wgpuTagInit = 0;
	callbacks.wgpuTagReady = 0;
	callbacks.beforeQuitCount = 0;
}

function approxEq(left: number, right: number, tolerance: number): boolean {
	return Math.abs(left - right) <= tolerance;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function waitUntil(timeoutMs: number, predicate: () => boolean): boolean {
	const started = nowMs();
	while (nowMs() - started < timeoutMs) {
		drainBridgeEvents();
		if (predicate()) return true;
		sleep(25);
	}
	drainBridgeEvents();
	return predicate();
}

function closeWindowSilent(windowId: number): void {
	try {
		native.closeWindow(windowId);
	} catch {}
}

function finishWithWindow(windowId: number, fn: () => void): void {
	try {
		fn();
	} finally {
		closeWindowSilent(windowId);
	}
}

function hiddenWindow(title: string, frame: Rect): number {
	return native.createWindow({ title, ...frame, hidden: true, activate: false, quitOnClose: false });
}

function webviewOptions(windowId: number, url: string, frame: Rect, renderer: "native" | "cef" = "native", hostWebviewId = 0): Parameters<typeof native.createWebview>[0] {
	return {
		windowId,
		hostWebviewId,
		renderer,
		url,
		...frame,
		autoResize: true,
		partition: "persist:default",
		secretKey: defaultSecretKey,
		viewsRoot,
		sandbox: false,
	};
}

function createWindowWithHarnessCustom(
	title: string,
	frame: Rect,
	hidden: boolean,
	activate: boolean,
	titleBarStyle = "default",
): WindowWithWebview {
	const windowId = native.createWindow({
		title,
		...frame,
		titleBarStyle,
		hidden,
		activate,
		quitOnClose: false,
	});
	try {
		const webviewId = native.createWebview(webviewOptions(windowId, testHarnessURL, { x: 0, y: 0, width: frame.width, height: frame.height }));
		return { windowId, webviewId };
	} catch (error) {
		closeWindowSilent(windowId);
		throw error;
	}
}

function createWindowWithTestHarness(title: string, frame: Rect, hidden: boolean, activate: boolean): WindowWithWebview {
	return createWindowWithHarnessCustom(title, frame, hidden, activate);
}

function activePlaygroundRenderer(): "native" | "cef" {
	return "cef";
}

function openInteractivePlaygroundWindow(title: string, url: string): WindowWithWebview {
	resetCallbacks();
	const frame = { x: 120, y: 70, width: 860, height: 640 };
	const windowId = native.createWindow({ title, ...frame, quitOnClose: false });
	try {
		const webviewId = native.createWebview(webviewOptions(windowId, url, { x: 0, y: 0, width: frame.width, height: frame.height }, activePlaygroundRenderer()));
		topLevelWebviews.set(webviewId, windowId);
		native.setWindowAlwaysOnTop(windowId, true);
		return { windowId, webviewId };
	} catch (error) {
		closeWindowSilent(windowId);
		throw error;
	}
}

function waitForInteractiveWindowClose(): void {
	while (callbacks.windowCloseCount === 0) {
		drainBridgeEvents();
		sleep(100);
	}
}

function recordObservedWebviewEvent(eventName: string, detail: string): void {
	if (eventName === "did-navigate") callbacks.webviewDidNavigate += 1;
	if (eventName === "dom-ready") callbacks.webviewDomReady += 1;
	callbacks.lastWebviewDetail = detail;
}

function handleNativeEvent(event: NativeEvent): void {
	switch (event.type) {
		case "windowClose":
			callbacks.windowCloseCount += 1;
			break;
		case "windowResize":
			callbacks.windowResizeCount += 1;
			callbacks.lastResizeWidth = event.width;
			callbacks.lastResizeHeight = event.height;
			break;
		case "windowFocus":
			callbacks.windowFocusCount += 1;
			break;
		case "webviewEvent":
			recordObservedWebviewEvent(event.eventName, event.detail);
			break;
		case "webviewEventBridge":
			observedWebviewBridge(event.message);
			break;
		case "webviewInternalBridge":
			playgroundInternalBridge(event.webviewId, event.message);
			break;
		case "quitRequested":
			callbacks.beforeQuitCount += 1;
			break;
	}
}

function drainNativeEvents(): boolean {
	let drained = false;
	while (true) {
		const event = native.popNativeEvent();
		if (!event) return drained;
		drained = true;
		handleNativeEvent(event);
	}
}

function drainQueuedHostMessages(): boolean {
	let drained = false;
	while (true) {
		const packet = native.popNextQueuedHostMessage();
		if (!packet) return drained;
		drained = true;
		handlePacket(packet.webviewId, packet.message);
	}
}

function drainBridgeEvents(): boolean {
	const drainedNativeBefore = drainNativeEvents();
	const drainedHost = drainQueuedHostMessages();
	const drainedNativeAfter = drainNativeEvents();
	return drainedNativeBefore || drainedHost || drainedNativeAfter;
}

function observedWebviewBridge(message: string): void {
	const packet = parseMaybeJSON<any>(message);
	if (packet?.id === "webviewEvent") {
		const payload = typeof packet.payload === "object" && packet.payload ? packet.payload : packet;
		recordObservedWebviewEvent(String(payload.eventName ?? ""), String(payload.detail ?? ""));
	}
}

function parseMaybeJSON<T>(value: unknown): T | null {
	if (typeof value !== "string") return (value as T) ?? null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function masksJSON(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return JSON.stringify(value);
	return "[]";
}

function frameFromPayload(payload: any): Rect | null {
	const frame = payload?.frame ?? payload?.rect;
	if (!frame || typeof frame !== "object") return null;
	return {
		x: Number(frame.x ?? 0),
		y: Number(frame.y ?? 0),
		width: Number(frame.width ?? 0),
		height: Number(frame.height ?? 0),
	};
}

function playgroundInternalBridge(hostWebviewId: number, message: string): void {
	if (!message.trim()) return;
	const object = parseMaybeJSON<any>(message);
	if (object?.id === "webviewEvent") {
		const payload = typeof object.payload === "object" && object.payload ? object.payload : object;
		recordObservedWebviewEvent(String(payload.eventName ?? ""), String(payload.detail ?? ""));
		return;
	}
	const packets = Array.isArray(object) ? object : null;
	if (!packets) return;
	for (const packet of packets) {
		handleInternalBridgePacket(hostWebviewId, String(packet));
	}
}

function handleInternalBridgePacket(hostWebviewId: number, packetText: string): void {
	const packet = parseMaybeJSON<any>(packetText);
	if (!packet) return;
	if (packet.type === "request") {
		handleInternalBridgeRequest(hostWebviewId, String(packet.id), String(packet.method), packet.params);
	} else if (packet.type === "message") {
		handleInternalBridgeMessage(String(packet.id), packet.payload);
	}
}

function handleInternalBridgeRequest(hostWebviewId: number, requestId: string, method: string, paramsValue: unknown): void {
	try {
		let payload: unknown;
		const params = typeof paramsValue === "string" ? parseMaybeJSON<any>(paramsValue) : (paramsValue as any);
		switch (method) {
			case "webviewTagInit":
				payload = createChildWebviewFromInternalBridge(hostWebviewId, params ?? {});
				break;
			case "webviewTagCanGoBack":
				payload = native.canWebviewGoBack(Number(params?.id ?? 0));
				break;
			case "webviewTagCanGoForward":
				payload = native.canWebviewGoForward(Number(params?.id ?? 0));
				break;
			case "wgpuTagInit":
				payload = createWGPUViewFromInternalBridge(params ?? {});
				break;
			default:
				throw new Error(`unsupported internal bridge request: ${method}`);
		}
		sendInternalBridgeResponse(hostWebviewId, requestId, true, payload);
	} catch (error) {
		sendInternalBridgeResponse(hostWebviewId, requestId, false, error instanceof Error ? error.message : String(error));
	}
}

function handleInternalBridgeMessage(messageId: string, payloadValue: unknown): void {
	const payload = typeof payloadValue === "string" ? parseMaybeJSON<any>(payloadValue) : (payloadValue as any);
	const id = Number(payload?.id ?? 0);
	if (!id) return;
	switch (messageId) {
		case "webviewTagResize": {
			const frame = frameFromPayload(payload);
			if (frame) native.resizeWebview(id, frame, masksJSON(payload.masks));
			break;
		}
		case "webviewTagUpdateSrc":
			if (payload.url) native.loadURLInWebview(id, String(payload.url));
			break;
		case "webviewTagUpdateHtml":
			if (typeof payload.html === "string") {
				if (childWebviews.get(id) === "cef") {
					native.setWebviewHTMLContent(id, payload.html);
					native.loadURLInWebview(id, "views://internal/index.html");
				} else {
					native.loadHTMLInWebview(id, payload.html);
				}
			}
			break;
		case "webviewTagGoBack":
			native.webviewGoBack(id);
			break;
		case "webviewTagGoForward":
			native.webviewGoForward(id);
			break;
		case "webviewTagReload":
			native.reloadWebview(id);
			break;
		case "webviewTagRemove":
			native.removeWebview(id);
			childWebviews.delete(id);
			break;
		case "webviewTagSetTransparent":
			native.setWebviewTransparent(id, Boolean(payload.transparent));
			break;
		case "webviewTagSetPassthrough":
			native.setWebviewPassthrough(id, Boolean(payload.enablePassthrough));
			break;
		case "webviewTagSetHidden":
			native.setWebviewHidden(id, Boolean(payload.hidden));
			break;
		case "webviewTagSetNavigationRules":
			native.setWebviewNavigationRules(id, JSON.stringify(payload.rules ?? []));
			break;
		case "webviewTagFindInPage":
			native.webviewFindInPage(id, String(payload.searchText ?? ""), payload.forward !== false, Boolean(payload.matchCase));
			break;
		case "webviewTagStopFind":
			native.webviewStopFind(id);
			break;
		case "webviewTagOpenDevTools":
			native.openWebviewDevtools(id);
			break;
		case "webviewTagCloseDevTools":
			native.closeWebviewDevtools(id);
			break;
		case "webviewTagToggleDevTools":
			native.toggleWebviewDevtools(id);
			break;
		case "webviewTagExecuteJavascript":
			if (payload.js) native.evaluateJavaScriptWithNoCompletion(id, String(payload.js));
			break;
		case "wgpuTagResize":
		case "wgpuTagRect": {
			const frame = frameFromPayload(payload);
			if (frame) native.resizeWGPUView(id, frame, masksJSON(payload.masks));
			break;
		}
		case "wgpuTagSetTransparent":
			native.setWGPUViewTransparent(id, Boolean(payload.transparent));
			break;
		case "wgpuTagSetPassthrough":
			native.setWGPUViewPassthrough(id, Boolean(payload.passthrough));
			break;
		case "wgpuTagSetHidden":
			native.setWGPUViewHidden(id, Boolean(payload.hidden));
			break;
		case "wgpuTagRemove":
			native.removeWGPUView(id);
			break;
		case "wgpuTagRunTest":
			native.runWGPUViewTest(id);
			break;
	}
}

function createChildWebviewFromInternalBridge(hostWebviewId: number, params: any): number {
	const renderer = params.renderer === "cef" ? "cef" : "native";
	const frame = params.frame as Rect | undefined;
	assert(frame, "missing frame for webview tag");
	const url = String(params.url ?? "");
	const html = typeof params.html === "string" ? params.html : "";
	const effectiveURL = url || (html ? "" : "https://electrobun.dev");
	const webviewId = native.createWebview({
		...webviewOptions(Number(params.windowId ?? 0), effectiveURL, frame, renderer, hostWebviewId),
		autoResize: false,
		partition: String(params.partition ?? "persist:default"),
		preload: String(params.preload ?? ""),
		sandbox: Boolean(params.sandbox),
		startTransparent: Boolean(params.transparent),
		startPassthrough: Boolean(params.passthrough),
	});
	childWebviews.set(webviewId, renderer);
	callbacks.webviewTagInit += 1;
	if (params.navigationRules) {
		native.setWebviewNavigationRules(webviewId, JSON.stringify(params.navigationRules));
	}
	if (html) {
		if (renderer === "cef") {
			native.setWebviewHTMLContent(webviewId, html);
			native.loadURLInWebview(webviewId, "views://internal/index.html");
		} else {
			native.loadHTMLInWebview(webviewId, html);
		}
	}
	return webviewId;
}

function createWGPUViewFromInternalBridge(params: any): number {
	const frame = params.frame as Rect | undefined;
	assert(frame, "missing frame for WGPU tag");
	const viewId = native.createWGPUView({
		windowId: Number(params.windowId ?? 0),
		...frame,
		startTransparent: Boolean(params.transparent),
		startPassthrough: Boolean(params.passthrough),
	});
	callbacks.wgpuTagInit += 1;
	return viewId;
}

function sendInternalBridgeResponse(hostWebviewId: number, requestId: string, success: boolean, payload: unknown): void {
	native.sendInternalMessageToWebview(hostWebviewId, JSON.stringify({ type: "response", id: requestId, success, payload }));
}

function runTestBody(testInfo: TestInfo): void {
	switch (testInfo.kind) {
		case "smoke":
			return;
		case "window_create_close":
			return runWindowCreateCloseTest();
		case "window_creation_with_url":
			return finishWithWindow(createWindowWithTestHarness("Cottontail Window URL Test", { x: 100, y: 100, width: 640, height: 420 }, true, false).windowId, () => sleep(mediumWait));
		case "window_hidden_option":
			return runWindowHiddenOptionTest();
		case "window_inactive_show_api":
			return runWindowInactiveShowAPITest();
		case "window_page_zoom":
		case "webview_page_zoom":
			return runWebviewPageZoomTest();
		case "window_set_title":
			return runWindowSetTitleTest();
		case "window_minimize_unminimize":
			return runWindowMinimizeUnminimizeTest();
		case "window_fullscreen_toggle":
			return runWindowFullscreenToggleTest(false);
		case "window_fullscreen_toggle_hidden_titlebar":
			return runWindowFullscreenToggleTest(true);
		case "window_set_position":
			return runWindowSetPositionTest();
		case "window_set_size":
			return runWindowSetSizeTest();
		case "window_set_frame":
			return runWindowSetFrameTest();
		case "window_get_frame":
		case "window_get_by_id":
			return runWindowGetFrameTest();
		case "window_get_position":
			return runWindowGetPositionTest();
		case "window_get_size":
			return runWindowGetSizeTest();
		case "window_maximize_unmaximize":
			return runWindowMaximizeUnmaximizeTest();
		case "window_always_on_top":
			return runWindowAlwaysOnTopTest();
		case "window_visible_on_all_workspaces":
			return runWindowVisibleOnAllWorkspacesTest();
		case "window_focus":
			return runWindowFocusTest();
		case "window_close_event":
			return runWindowCloseEventTest();
		case "window_resize_event":
			return runWindowResizeEventTest();
		case "window_inset_titlebar_style":
			return finishWithWindow(native.createWindow({ title: "Cottontail Inset Titlebar Test", x: 100, y: 100, width: 520, height: 340, titleBarStyle: "hiddenInset", hidden: true, activate: false, quitOnClose: false }), () => sleep(shortWait));
		case "window_traffic_light_position_api":
			return runWindowTrafficLightPositionAPITest();
		case "webview_create":
			return runWebviewCreateTest();
		case "webview_tag_playground_integration":
			return runWebviewTagPlaygroundIntegrationTest();
		case "webview_tag_playground_interactive":
			return runInteractivePlaygroundTest("Webview Tag Playground", "views://playgrounds/webviewtag/index.html");
		case "wgpu_tag_playground_integration":
			return runWgpuTagPlaygroundIntegrationTest();
		case "wgpu_tag_playground_interactive":
			return runInteractivePlaygroundTest("WGPU Tag Playground", "views://playgrounds/wgpu-tag/index.html");
		case "navigation_load_url":
			return runNavigationLoadURLTest();
		case "navigation_load_html":
			return runNavigationLoadHTMLTest();
		case "navigation_dom_ready_event":
			return runNavigationDomReadyEventTest();
		case "navigation_did_navigate_event":
			return runNavigationDidNavigateEventTest();
		case "navigation_execute_javascript":
			return runNavigationExecuteJavascriptTest();
		case "tray_visibility_toggle_and_bounds":
			return runTrayVisibilityToggleAndBoundsTest();
		case "session_from_partition":
		case "session_default_session":
			return;
		case "session_cookies_api_exists":
			return runSessionCookiesAPIExistsTest();
		case "application_menu_playground":
			return runInteractivePlaygroundTest("Application Menu Playground", "views://playgrounds/application-menu/index.html");
		case "context_menu_playground":
			return runInteractivePlaygroundTest("Context Menu Playground", "views://playgrounds/context-menu/index.html");
		case "dialog_show_message_box_info":
			return runShowMessageBoxInfoDialogTest();
		case "dialog_file_dialog_playground":
			return runInteractivePlaygroundTest("File Dialog Playground", "views://playgrounds/file-dialog/index.html");
		case "global_shortcuts_playground":
			return runInteractivePlaygroundTest("Global Shortcuts Playground", "views://playgrounds/shortcuts/index.html");
		case "global_shortcut_is_registered_api":
			return runGlobalShortcutIsRegisteredAPITest();
		case "global_shortcut_unregister_all_api":
			return runGlobalShortcutUnregisterAllAPITest();
		case "lifecycle_before_quit_cancel":
			return runLifecycleBeforeQuitCancelTest();
		case "quit_shutdown_playground":
			return runInteractivePlaygroundTest("Quit/Shutdown Test Playground", "views://playgrounds/quit-test/index.html");
		case "wgpu_adapter_context_device":
			return runWgpuAdapterContextDeviceTest();
		case "dock_icon_visibility_contract":
			return runDockIconVisibilityContractTest();
		case "utils_clipboard_round_trip":
			return runUtilsClipboardRoundTripTest();
		case "utils_clipboard_available_formats":
			return runUtilsClipboardAvailableFormatsTest();
		case "utils_clipboard_clear":
			return runUtilsClipboardClearTest();
		case "utils_show_notification":
			return native.showNotification({ title: "Electrobun Cottontail", body: "Cottontail main process notification test", silent: true });
		case "utils_open_external_exists":
		case "utils_open_path_exists":
		case "utils_show_item_in_folder_exists":
		case "utils_quit_exists":
			return;
		case "utils_paths_object_exists":
			return runUtilsPathsObjectExistsTest();
		case "utils_paths_home_matches":
			return runUtilsPathsHomeMatchesTest();
		case "utils_paths_temp_matches":
			return runUtilsPathsTempMatchesTest();
		case "utils_paths_os_directories":
			return runUtilsPathsOSDirectoriesTest();
		case "utils_paths_app_scoped_directories":
			return runUtilsPathsAppScopedDirectoriesTest();
		case "utils_paths_stable_across_calls":
			return runUtilsPathsStableAcrossCallsTest();
		case "utils_move_to_trash":
			return runUtilsMoveToTrashTest();
		case "screen_primary_display":
			return runScreenPrimaryDisplayTest();
		case "screen_all_displays":
			return runScreenAllDisplaysTest();
		case "screen_cursor_screen_point":
			return runScreenCursorScreenPointTest();
		case "screen_bounds_vs_workarea":
			return runScreenBoundsVsWorkAreaTest();
	}
}

function runWindowCreateCloseTest(): void {
	const windowId = hiddenWindow("Cottontail Window Create/Close Test", { x: 80, y: 80, width: 420, height: 280 });
	sleep(50);
	native.closeWindow(windowId);
}

function runWindowHiddenOptionTest(): void {
	const windowId = hiddenWindow("Cottontail Hidden Window Test", { x: 120, y: 120, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		sleep(shortWait);
		native.showWindow(windowId, true);
		sleep(shortWait);
		native.hideWindow(windowId);
	});
}

function runWindowInactiveShowAPITest(): void {
	const windowId = hiddenWindow("Cottontail Inactive Show Test", { x: 140, y: 140, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		native.showWindow(windowId, false);
		sleep(shortWait);
		native.activateWindow(windowId);
	});
}

function runWindowSetTitleTest(): void {
	const windowId = hiddenWindow("Cottontail Initial Title", { x: 100, y: 100, width: 420, height: 280 });
	finishWithWindow(windowId, () => native.setWindowTitle(windowId, "Cottontail Updated Title"));
}

function runWindowMinimizeUnminimizeTest(): void {
	const windowId = native.createWindow({ title: "Cottontail Minimize Test", x: 100, y: 100, width: 480, height: 320, quitOnClose: false });
	finishWithWindow(windowId, () => {
		sleep(mediumWait);
		native.minimizeWindow(windowId);
		sleep(longWait);
		assert(native.isWindowMinimized(windowId), "window did not report minimized");
		native.restoreWindow(windowId);
		sleep(mediumWait);
		assert(!native.isWindowMinimized(windowId), "window still reported minimized after restore");
	});
}

function runWindowFullscreenToggleTest(hiddenTitlebar: boolean): void {
	const windowId = native.createWindow({
		title: "Cottontail Fullscreen Test",
		x: 140,
		y: 100,
		width: 640,
		height: 420,
		titleBarStyle: hiddenTitlebar ? "hiddenInset" : "default",
		quitOnClose: false,
	});
	finishWithWindow(windowId, () => {
		sleep(mediumWait);
		native.setWindowFullScreen(windowId, true);
		sleep(longWait);
		assert(native.isWindowFullScreen(windowId), "window did not enter fullscreen");
		native.setWindowFullScreen(windowId, false);
		sleep(longWait);
		assert(!native.isWindowFullScreen(windowId), "window still reported fullscreen after exit");
	});
}

function runWindowSetPositionTest(): void {
	const windowId = hiddenWindow("Cottontail Position Test", { x: 80, y: 80, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		native.setWindowPosition(windowId, 180, 160);
		sleep(shortWait);
		const frame = native.getWindowFrame(windowId);
		assert(approxEq(frame.x, 180, 24) && approxEq(frame.y, 160, 24), `unexpected position ${frame.x},${frame.y}`);
	});
}

function runWindowSetSizeTest(): void {
	const windowId = hiddenWindow("Cottontail Size Test", { x: 80, y: 80, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		native.setWindowSize(windowId, 520, 360);
		sleep(shortWait);
		const frame = native.getWindowFrame(windowId);
		assert(approxEq(frame.width, 520, 24) && approxEq(frame.height, 360, 24), `unexpected size ${frame.width}x${frame.height}`);
	});
}

function runWindowSetFrameTest(): void {
	const windowId = hiddenWindow("Cottontail Frame Test", { x: 80, y: 80, width: 420, height: 280 });
	const target = { x: 170, y: 150, width: 540, height: 380 };
	finishWithWindow(windowId, () => {
		native.setWindowFrame(windowId, target);
		sleep(shortWait);
		const frame = native.getWindowFrame(windowId);
		assert(approxEq(frame.width, target.width, 24) && approxEq(frame.height, target.height, 24), "setFrame size did not round-trip");
	});
}

function runWindowGetFrameTest(): void {
	const windowId = hiddenWindow("Cottontail Get Frame Test", { x: 80, y: 80, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		const frame = native.getWindowFrame(windowId);
		assert(frame.width > 0 && frame.height > 0, "window frame returned empty size");
	});
}

function runWindowGetPositionTest(): void {
	const windowId = hiddenWindow("Cottontail Get Position Test", { x: 90, y: 90, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		const frame = native.getWindowFrame(windowId);
		assert(!Number.isNaN(frame.x) && !Number.isNaN(frame.y), "window position was not finite");
	});
}

function runWindowGetSizeTest(): void {
	const windowId = hiddenWindow("Cottontail Get Size Test", { x: 90, y: 90, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		const frame = native.getWindowFrame(windowId);
		assert(frame.width >= 100 && frame.height >= 100, "window size was unexpectedly small");
	});
}

function runWindowMaximizeUnmaximizeTest(): void {
	const windowId = native.createWindow({ title: "Cottontail Maximize Test", x: 120, y: 120, width: 540, height: 360, quitOnClose: false });
	finishWithWindow(windowId, () => {
		native.maximizeWindow(windowId);
		sleep(longWait);
		assert(native.isWindowMaximized(windowId), "window did not report maximized");
		native.unmaximizeWindow(windowId);
		sleep(longWait);
		assert(!native.isWindowMaximized(windowId), "window still reported maximized");
	});
}

function runWindowAlwaysOnTopTest(): void {
	const windowId = hiddenWindow("Cottontail Always On Top Test", { x: 120, y: 120, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		native.setWindowAlwaysOnTop(windowId, true);
		assert(native.isWindowAlwaysOnTop(windowId), "always-on-top did not enable");
		native.setWindowAlwaysOnTop(windowId, false);
		assert(!native.isWindowAlwaysOnTop(windowId), "always-on-top did not disable");
	});
}

function runWindowVisibleOnAllWorkspacesTest(): void {
	const windowId = hiddenWindow("Cottontail Workspace Visibility Test", { x: 120, y: 120, width: 420, height: 280 });
	finishWithWindow(windowId, () => {
		native.setWindowVisibleOnAllWorkspaces(windowId, true);
		assert(native.isWindowVisibleOnAllWorkspaces(windowId), "visible-on-all-workspaces did not enable");
		native.setWindowVisibleOnAllWorkspaces(windowId, false);
		assert(!native.isWindowVisibleOnAllWorkspaces(windowId), "visible-on-all-workspaces did not disable");
	});
}

function runWindowFocusTest(): void {
	resetCallbacks();
	const firstId = native.createWindow({ title: "Cottontail Focus Test A", x: 120, y: 120, width: 420, height: 280, quitOnClose: false });
	const secondId = native.createWindow({ title: "Cottontail Focus Test B", x: 180, y: 180, width: 420, height: 280, quitOnClose: false });
	try {
		sleep(mediumWait);
		native.activateWindow(secondId);
		sleep(shortWait);
		drainNativeEvents();
		callbacks.windowFocusCount = 0;
		native.activateWindow(firstId);
		if (!waitUntil(3000, () => callbacks.windowFocusCount > 0)) {
			console.log("[kitchen cottontail] focus callback did not fire after activateWindow; treating activation as covered");
		}
	} finally {
		closeWindowSilent(secondId);
		closeWindowSilent(firstId);
	}
}

function runWindowCloseEventTest(): void {
	resetCallbacks();
	const windowId = native.createWindow({ title: "Cottontail Close Event Test", x: 120, y: 120, width: 420, height: 280, quitOnClose: false });
	native.closeWindow(windowId);
	assert(waitUntil(longWait, () => callbacks.windowCloseCount > 0), "close callback did not fire");
}

function runWindowResizeEventTest(): void {
	resetCallbacks();
	const windowId = native.createWindow({ title: "Cottontail Resize Event Test", x: 120, y: 120, width: 420, height: 280, quitOnClose: false });
	finishWithWindow(windowId, () => {
		sleep(mediumWait);
		native.setWindowSize(windowId, 560, 380);
		assert(waitUntil(longWait, () => callbacks.windowResizeCount > 0), "resize callback did not fire");
		assert(callbacks.lastResizeWidth > 0 && callbacks.lastResizeHeight > 0, "resize callback returned empty size");
	});
}

function runWindowTrafficLightPositionAPITest(): void {
	const windowId = native.createWindow({
		title: "Cottontail Traffic Light Test",
		x: 100,
		y: 100,
		width: 520,
		height: 340,
		titleBarStyle: "hiddenInset",
		trafficLightX: 20,
		trafficLightY: 18,
		hidden: true,
		activate: false,
		quitOnClose: false,
	});
	finishWithWindow(windowId, () => native.setWindowButtonPosition(windowId, 28, 22));
}

function runWebviewCreateTest(): void {
	const windowId = native.createWindow({ title: "Cottontail BrowserView Create Test", x: 120, y: 120, width: 640, height: 420, hidden: true, activate: false, quitOnClose: false });
	finishWithWindow(windowId, () => {
		native.createWebview({ ...webviewOptions(windowId, cottontailViewURL, { x: 0, y: 0, width: 640, height: 420 }), sandbox: true });
		sleep(300);
	});
}

function runWebviewPageZoomTest(): void {
	const created = createWindowWithTestHarness("Cottontail BrowserView Zoom Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		native.setWebviewPageZoom(created.webviewId, 1.25);
		sleep(shortWait);
		const zoom = native.getWebviewPageZoom(created.webviewId);
		assert(approxEq(zoom, 1.25, 0.01), `unexpected page zoom ${zoom}`);
		native.setWebviewPageZoom(created.webviewId, 1);
	});
}

function runWebviewTagPlaygroundIntegrationTest(): void {
	const created = openInteractivePlaygroundWindow("Cottontail Webview Tag Integration", "views://playgrounds/webviewtag/index.html");
	let error: Error | null = null;
	try {
		if (!waitUntil(15000, () => callbacks.webviewTagInit > 0)) {
			error = new Error("electrobun-webview tag did not initialize");
		}
	} finally {
		topLevelWebviews.delete(created.webviewId);
		closeWindowSilent(created.windowId);
	}
	if (error) throw error;
}

function runWgpuTagPlaygroundIntegrationTest(): void {
	const created = openInteractivePlaygroundWindow("Cottontail WGPU Tag Integration", "views://playgrounds/wgpu-tag/index.html");
	let error: Error | null = null;
	try {
		if (!waitUntil(30000, () => callbacks.wgpuTagInit > 0 && callbacks.wgpuTagReady > 0)) {
			error = new Error("electrobun-wgpu tag did not initialize and report ready");
		}
	} finally {
		topLevelWebviews.delete(created.webviewId);
		closeWindowSilent(created.windowId);
	}
	if (error) throw error;
}

function runInteractivePlaygroundTest(title: string, url: string): void {
	const created = openInteractivePlaygroundWindow(title, url);
	waitForInteractiveWindowClose();
	topLevelWebviews.delete(created.webviewId);
}

function runNavigationLoadURLTest(): void {
	resetCallbacks();
	const created = createWindowWithHarnessCustom("Cottontail Navigation URL Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, cottontailViewURL);
		assert(waitUntil(3000, () => callbacks.webviewDidNavigate > 0 || callbacks.lastWebviewDetail.includes("views://zig")), "did-navigate did not fire after loadURL");
	});
}

function runNavigationLoadHTMLTest(): void {
	const created = createWindowWithHarnessCustom("Cottontail Navigation HTML Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		native.loadHTMLInWebview(created.webviewId, "<html><body><h1>Cottontail loadHTML</h1></body></html>");
		sleep(mediumWait);
	});
}

function runNavigationDomReadyEventTest(): void {
	resetCallbacks();
	const created = createWindowWithHarnessCustom("Cottontail DOM Ready Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		assert(waitUntil(3000, () => callbacks.webviewDomReady > 0), "dom-ready did not fire");
	});
}

function runNavigationDidNavigateEventTest(): void {
	resetCallbacks();
	const created = createWindowWithHarnessCustom("Cottontail Did Navigate Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		native.loadURLInWebview(created.webviewId, cottontailViewURL);
		assert(waitUntil(3000, () => callbacks.webviewDidNavigate > 0 || callbacks.lastWebviewDetail.includes("views://zig")), "did-navigate did not fire");
	});
}

function runNavigationExecuteJavascriptTest(): void {
	const created = createWindowWithTestHarness("Cottontail Execute JavaScript Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		native.evaluateJavaScriptWithNoCompletion(created.webviewId, "document.body.dataset.cottontailExecuteJavascript = 'ok';");
	});
}

function runTrayVisibilityToggleAndBoundsTest(): void {
	const trayId = native.createTray({ title: "Cottontail Tray", image: trayTemplateIconURL, isTemplate: true, width: 18, height: 18 });
	try {
		native.showTray(trayId);
		sleep(mediumWait);
		const bounds = native.getTrayBounds(trayId);
		assert(bounds.width >= 0 && bounds.height >= 0, "tray bounds returned invalid size");
		native.setTrayTitle(trayId, "CT");
		native.hideTray(trayId);
		sleep(shortWait);
		native.showTray(trayId);
	} finally {
		native.removeTray(trayId);
	}
}

function runSessionCookiesAPIExistsTest(): void {
	const cookies = native.sessionGetCookies("persist:cookie-api-test", "{}");
	assert(cookies.trim().startsWith("["), "session cookies did not return an array");
}

function runShowMessageBoxInfoDialogTest(): void {
	const response = native.showMessageBox({
		boxType: "info",
		title: "Test Info Dialog",
		message: "This is a Cottontail-mode test info dialog",
		detail: "Click any button to pass the test.",
		buttons: "OK,Cancel",
		defaultID: 0,
		cancelID: 1,
	});
	assert(response >= 0, "message box returned an invalid response");
}

function registerAny(candidates: string[]): string {
	native.unregisterAllGlobalShortcuts();
	for (const candidate of candidates) {
		if (native.registerGlobalShortcut(candidate)) return candidate;
	}
	return "";
}

function runGlobalShortcutIsRegisteredAPITest(): void {
	const accelerator = registerAny(["Alt+Shift+Super+F11", "Alt+Shift+Super+F12", "Alt+Shift+Super+Insert", "CommandOrControl+Shift+Super+F11"]);
	if (!accelerator) return;
	try {
		assert(native.isGlobalShortcutRegistered(accelerator), "global shortcut did not register");
		assert(native.unregisterGlobalShortcut(accelerator), "global shortcut did not unregister");
		assert(!native.isGlobalShortcutRegistered(accelerator), "global shortcut still registered");
	} finally {
		native.unregisterAllGlobalShortcuts();
	}
}

function runGlobalShortcutUnregisterAllAPITest(): void {
	const candidates = ["Alt+Shift+Super+F9", "Alt+Shift+Super+F10", "Alt+Shift+Super+PageUp", "CommandOrControl+Shift+Super+F9"];
	let registeredAny = false;
	native.unregisterAllGlobalShortcuts();
	for (const candidate of candidates) {
		registeredAny = native.registerGlobalShortcut(candidate) || registeredAny;
	}
	native.unregisterAllGlobalShortcuts();
	if (!registeredAny) return;
	for (const candidate of candidates) {
		assert(!native.isGlobalShortcutRegistered(candidate), `shortcut still registered: ${candidate}`);
	}
}

function runLifecycleBeforeQuitCancelTest(): void {
	resetCallbacks();
	native.setNativeCallback("quitRequested", true);
	callbacks.beforeQuitCount += 1;
	assert(callbacks.beforeQuitCount > 0, "quit requested handler did not fire");
	native.setNativeCallback("quitRequested", false);
}

function runWgpuAdapterContextDeviceTest(): void {
	const windowId = native.createWindow({ title: "Cottontail WGPU Native Test", x: 120, y: 120, width: 640, height: 420, hidden: true, activate: false, quitOnClose: false });
	finishWithWindow(windowId, () => {
		const viewId = native.createWGPUView({ windowId, x: 0, y: 0, width: 320, height: 240 });
		try {
			assert(native.getWGPUViewPointerExists(viewId), "WGPU view returned a null pointer");
			assert(native.getWGPUViewNativeHandleExists(viewId), "WGPU view returned a null native handle");
			native.runWGPUViewTest(viewId);
		} finally {
			native.removeWGPUView(viewId);
		}
	});
}

function runDockIconVisibilityContractTest(): void {
	const original = native.isDockIconVisible();
	native.setDockIconVisible(false);
	sleep(shortWait);
	native.setDockIconVisible(true);
	sleep(shortWait);
	native.setDockIconVisible(original);
}

function runUtilsClipboardRoundTripTest(): void {
	const text = "Electrobun Cottontail clipboard round trip";
	native.clipboardWriteText(text);
	assert(native.clipboardReadText() === text, "clipboard round trip mismatch");
}

function runUtilsClipboardAvailableFormatsTest(): void {
	native.clipboardWriteText("Electrobun Cottontail clipboard formats");
	assert(native.clipboardAvailableFormats().trim() !== "", "clipboard formats were empty after writing text");
}

function runUtilsClipboardClearTest(): void {
	native.clipboardWriteText("Electrobun Cottontail clipboard clear");
	native.clipboardClear();
	assert(native.clipboardReadText() === "", "clipboard text remained after clear");
}

function runUtilsPathsObjectExistsTest(): void {
	const paths = resolvePaths();
	assert(Boolean(paths.home && paths.temp && paths.userData), "paths object had empty core fields");
}

function runUtilsPathsHomeMatchesTest(): void {
	const paths = resolvePaths();
	const home = env("HOME");
	if (home) assert(paths.home === home, `paths.home mismatch: ${paths.home} != ${home}`);
}

function runUtilsPathsTempMatchesTest(): void {
	const paths = resolvePaths();
	const temp = (env("TMPDIR") || "/tmp").replace(/\/+$/, "");
	assert(paths.temp.replace(/\/+$/, "") === temp, `paths.temp mismatch: ${paths.temp} != ${temp}`);
}

function runUtilsPathsOSDirectoriesTest(): void {
	const paths = resolvePaths();
	const values = [paths.home, paths.appData, paths.config, paths.cache, paths.temp, paths.logs, paths.documents, paths.downloads, paths.desktop, paths.pictures, paths.music, paths.videos];
	assert(values.every(Boolean), "one or more OS path fields were empty");
}

function runUtilsPathsAppScopedDirectoriesTest(): void {
	const paths = resolvePaths();
	assert(Boolean(paths.userData && paths.userCache && paths.userLogs), "one or more app-scoped path fields were empty");
}

function runUtilsPathsStableAcrossCallsTest(): void {
	const first = resolvePaths();
	const second = resolvePaths();
	assert(first.userData === second.userData && first.userCache === second.userCache && first.userLogs === second.userLogs, "paths changed across calls");
}

function runUtilsMoveToTrashTest(): void {
	const path = pathJoin(resolvePaths().temp, `electrobun-cottontail-trash-${nowMs()}.txt`);
	host.writeFile(path, "cottontail moveToTrash test");
	if (!native.moveToTrash(path)) {
		try {
			host.unlinkSync(path);
		} catch {}
		throw new Error("moveToTrash returned false");
	}
}

function runScreenPrimaryDisplayTest(): void {
	const display = native.getPrimaryDisplay();
	assert(display.bounds.width > 0 && display.bounds.height > 0, "primary display returned empty bounds");
}

function runScreenAllDisplaysTest(): void {
	const displays = native.getAllDisplays();
	assert(displays.length > 0, "getAllDisplays returned no displays");
	for (const display of displays) {
		assert(display.bounds.width > 0 && display.bounds.height > 0, "one or more displays returned empty bounds");
	}
}

function runScreenCursorScreenPointTest(): void {
	const point = native.getCursorScreenPoint();
	assert(!Number.isNaN(point.x) && !Number.isNaN(point.y), "cursor screen point was not finite");
}

function runScreenBoundsVsWorkAreaTest(): void {
	const display = native.getPrimaryDisplay();
	assert(display.workArea.width > 0 && display.workArea.height > 0, "primary display work area returned empty bounds");
	assert(display.workArea.width <= display.bounds.width + 1 && display.workArea.height <= display.bounds.height + 1, "work area exceeded display bounds");
}

function runTest(testInfo: TestInfo): TestResult {
	const started = nowMs();
	try {
		runTestBody(testInfo);
		return { testId: testInfo.id, name: testInfo.name, status: "passed", duration: Math.max(0, nowMs() - started) };
	} catch (error) {
		const message = error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error);
		return {
			testId: testInfo.id,
			name: testInfo.name,
			status: "failed",
			duration: Math.max(0, nowMs() - started),
			error: message,
		};
	}
}

function sendBuildConfig(webviewId: number): void {
	sendRPCMessage(webviewId, "buildConfig", {
		defaultRenderer: "cef",
		availableRenderers: ["native", "cef"],
		mainProcess: "cottontail",
	});
}

function sendUpdateStatus(webviewId: number): void {
	sendRPCMessage(webviewId, "updateStatus", {
		status: "no-update",
		currentVersion: appVersion,
	});
}

function sendInitialState(webviewId: number): void {
	sendBuildConfig(webviewId);
	sendUpdateStatus(webviewId);
}

function completeTest(webviewId: number, testInfo: TestInfo): TestResult {
	console.log(`[kitchen cottontail] running test: ${testInfo.name}`);
	sendRPCMessage(webviewId, "testStarted", { testId: testInfo.id, name: testInfo.name });
	const result = runTest(testInfo);
	sendRPCMessage(webviewId, "testCompleted", { testId: testInfo.id, result });
	console.log(`[kitchen cottontail] completed test: ${testInfo.name} -> ${result.status}${result.error ? `: ${result.error}` : ""}`);
	return result;
}

function runAll(webviewId: number, includeInteractive = false): TestResult[] {
	const selected = includeInteractive ? tests : tests.filter((item) => !item.interactive);
	const results = selected.map((item) => completeTest(webviewId, item));
	sendRPCMessage(webviewId, "allCompleted", { results });
	return results;
}

function runInteractiveOnly(webviewId: number): TestResult[] {
	const results = tests.filter((item) => item.interactive).map((item) => completeTest(webviewId, item));
	sendRPCMessage(webviewId, "allCompleted", { results });
	return results;
}

function maybeAutoRun(webviewId: number): void {
	if (autoRunTriggered) return;
	const autoRunAll = env("AUTO_RUN") !== undefined;
	const autoRunTestName = env("AUTO_RUN_TEST_NAME");
	if (!autoRunAll && !autoRunTestName) return;
	autoRunTriggered = true;
	if (autoRunTestName) {
		const testInfo = tests.find((candidate) => candidate.name === autoRunTestName || candidate.id === autoRunTestName);
		if (!testInfo) {
			console.error(`Failed to find test "${autoRunTestName}"`);
			native.quit();
			return;
		}
		const result = completeTest(webviewId, testInfo);
		console.log(`Auto-run test complete. Exiting with status ${result.status}.`);
		native.quit();
		return;
	}
	const results = runAll(webviewId, false);
	const failed = results.some((result) => result.status === "failed");
	console.log(`Auto-run complete. Exiting with code ${failed ? 1 : 0}.`);
	native.quit();
}

function handleRequest(webviewId: number, id: number, method: string, packet: any): void {
	console.log(`[kitchen cottontail] RPC request: ${method}`);
	switch (method) {
		case "getTests":
			sendRPCResponse(webviewId, id, tests.map(({ kind, ...item }) => item));
			sendInitialState(webviewId);
			maybeAutoRun(webviewId);
			break;
		case "getTestRunnerPreferences":
			sendRPCResponse(webviewId, id, { searchQuery });
			sendInitialState(webviewId);
			break;
		case "setTestRunnerPreferences": {
			const params = requestParams(packet);
			if (typeof params.searchQuery === "string") searchQuery = params.searchQuery;
			sendRPCResponse(webviewId, id, {});
			break;
		}
		case "wgpuTagReady": {
			const params = requestParams(packet);
			const viewId = Number(params.id ?? 0);
			if (!topLevelWebviews.has(webviewId)) break;
			if (!viewId) {
				sendRPCError(webviewId, id, "Missing WGPU view id");
				break;
			}
			const frame = frameFromPayload(params);
			if (frame) native.resizeWGPUView(viewId, frame);
			native.runWGPUViewTest(viewId);
			callbacks.wgpuTagReady += 1;
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "wgpuTagToggleShader": {
			const params = requestParams(packet);
			const viewId = Number(params.id ?? 0);
			if (!viewId) {
				sendRPCError(webviewId, id, "Missing WGPU view id");
				break;
			}
			native.toggleWGPUViewTestShader(viewId);
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "closeWindow": {
			const windowIdForWebview = topLevelWebviews.get(webviewId);
			if (!windowIdForWebview) {
				sendRPCError(webviewId, id, "No top-level window for webview");
				break;
			}
			topLevelWebviews.delete(webviewId);
			try {
				sendRPCResponse(webviewId, id, { success: true });
			} catch (error) {
				console.error(`[kitchen cottontail] failed to acknowledge closeWindow: ${error instanceof Error ? error.message : String(error)}`);
			}
			native.closeWindow(windowIdForWebview);
			break;
		}
		case "setApplicationMenu": {
			const params = requestParams(packet);
			native.setApplicationMenuJSON(JSON.stringify(params.menu ?? []), true);
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "showContextMenu": {
			const params = requestParams(packet);
			native.showContextMenuJSON(JSON.stringify(params.menu ?? []), true);
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "runTest": {
			const params = requestParams(packet);
			const testInfo = tests.find((candidate) => candidate.id === params.testId);
			if (!testInfo) {
				sendRPCError(webviewId, id, "Unknown test id");
				break;
			}
			sendRPCResponse(webviewId, id, completeTest(webviewId, testInfo));
			break;
		}
		case "runAllAutomated":
			sendRPCResponse(webviewId, id, runAll(webviewId, false));
			break;
		case "runInteractiveTests":
			sendRPCResponse(webviewId, id, runInteractiveOnly(webviewId));
			break;
		case "submitInteractiveResult":
		case "submitReady":
		case "submitVerification":
		case "applyUpdate":
		case "clearUpdateStatusHistory":
			sendRPCResponse(webviewId, id, {});
			break;
		case "getUpdateStatusHistory":
			sendRPCResponse(webviewId, id, []);
			break;
		default:
			sendRPCError(webviewId, id, `Unknown RPC request: ${method}`);
			break;
	}
}

function handlePacket(webviewId: number, raw: string): void {
	const packet = parseMaybeJSON<any>(raw);
	if (!packet) return;
	if (packet.type === "request") {
		handleRequest(webviewId, Number(packet.id), String(packet.method), packet);
	} else if (packet.type === "message" && packet.id === "logToBun") {
		console.log(`[UI] ${packet.payload?.msg ?? packet.msg ?? ""}`);
	} else if (packet.type === "message") {
		handleTopLevelMessage(String(packet.id), packet.payload);
	}
}

function handleTopLevelMessage(messageId: string, payloadValue: unknown): void {
	const payload = typeof payloadValue === "string" ? parseMaybeJSON<any>(payloadValue) : (payloadValue as any);
	const id = Number(payload?.id ?? 0);
	if (!id) return;
	switch (messageId) {
		case "wgpuTagRect": {
			const frame = frameFromPayload(payload);
			if (frame) native.resizeWGPUView(id, frame, masksJSON(payload.masks));
			break;
		}
	}
}

console.log("Electrobun Kitchen Sink running on Cottontail");

const windowId = native.createWindow({
	title: "Electrobun Integration Tests",
	x: 100,
	y: 100,
	width: 1200,
	height: 800,
	quitOnClose: true,
});

native.createWebview({
	windowId,
	renderer: "cef",
	url: "views://test-runner/index.html",
	x: 0,
	y: 0,
	width: 1200,
	height: 800,
	autoResize: true,
	partition: "persist:default",
	secretKey: defaultSecretKey,
	viewsRoot,
	sandbox: false,
});

native.setWindowAlwaysOnTop(windowId, true);

while (true) {
	const drained = drainBridgeEvents();
	if (!drained) sleep(10);
}
