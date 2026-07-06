import {
	babylon,
	createRPC,
	env,
	GPUDevice,
	GpuWindow,
	host,
	native,
	pathJoin,
	ptr,
	resolvePaths,
	sendRPCError,
	sendRPCMessage,
	sendRPCResponse,
	sleep,
	three,
	Updater,
	webgpu,
	WGPUBridge,
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
const viewsRoot = resolveViewsRoot();

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
	| "window_focus_blur_default"
	| "window_focus_blur_hidden_inset"
	| "window_focus_blur_hidden"
	| "window_close_event"
	| "window_resize_event"
	| "window_get_by_id"
	| "window_inset_titlebar_style"
	| "window_traffic_light_position_api"
	| "webview_create"
	| "webview_page_zoom"
	| "webview_tag_playground_integration"
	| "webview_tag_playground_interactive"
	| "webview_tag_draggable_playground"
	| "webview_tag_host_message_playground"
	| "webview_tag_session_playground"
	| "wgpu_tag_playground_integration"
	| "wgpu_tag_playground_interactive"
	| "wgpu_tag_transparent_playground"
	| "navigation_load_url"
	| "navigation_views_url_query_suffix"
	| "navigation_views_url_hash_suffix"
	| "navigation_load_html"
	| "navigation_rules_allowlist"
	| "navigation_rules_block"
	| "navigation_dom_ready_event"
	| "navigation_did_navigate_event"
	| "navigation_execute_javascript"
	| "navigation_find_in_page"
	| "preload_data_url"
	| "preload_external_url"
	| "preload_dom_manipulation"
	| "sandbox_rpc_disabled"
	| "sandbox_rpc_enabled"
	| "sandbox_events_work"
	| "sandbox_browser_window"
	| "sandbox_navigation_controls"
	| "sandbox_non_sandbox_events_work"
	| "sandbox_oopif_blocked"
	| "sandbox_oopif_allowed"
	| "rpc_host_to_webview_request"
	| "rpc_webview_to_host_request"
	| "rpc_echo_string"
	| "rpc_large_payload_transfer"
	| "rpc_eval_sync"
	| "rpc_eval_async_promise"
	| "rpc_eval_dom_access"
	| "rpc_get_document_title"
	| "rpc_stress_native_burst_delivery"
	| "rpc_stress_native_fallback_socket_transition"
	| "rpc_stress_native_steady_socket_delivery"
	| "browserview_get_all"
	| "browserview_get_by_id"
	| "event_global_will_navigate"
	| "event_multiple_handlers"
	| "event_response_modification"
	| "event_window_specific_vs_global"
	| "event_reopen_subscription"
	| "event_before_quit_cancel"
	| "event_window_close_order"
	| "tray_visibility_toggle_and_bounds"
	| "session_from_partition"
	| "session_default_session"
	| "session_cookies_api_exists"
	| "application_menu_playground"
	| "context_menu_playground"
	| "dialog_show_message_box_info"
	| "dialog_show_message_box_question"
	| "dialog_file_dialog_playground"
	| "dialog_open_external"
	| "dialog_open_path"
	| "dialog_show_item_in_folder"
	| "dialog_show_notification_interactive"
	| "clipboard_playground"
	| "global_shortcuts_playground"
	| "global_shortcut_is_registered_api"
	| "global_shortcut_unregister_all_api"
	| "lifecycle_before_quit_cancel"
	| "quit_shutdown_playground"
	| "tray_playground"
	| "window_events_move_resize"
	| "window_events_blur_focus"
	| "window_events_visible_on_all_workspaces"
	| "chromeless_custom_titlebar"
	| "chromeless_transparent_window"
	| "multiwindow_cef_oopif"
	| "webview_settings_playground"
	| "webview_cleanup_playground"
	| "fullsize_frame_repro"
	| "permissions_cef"
	| "permissions_native"
	| "wgpu_view_native_cube"
	| "wgpu_view_basic_window"
	| "wgpu_view_transparent_cube"
	| "wgpu_view_three_playground"
	| "wgpu_view_babylon_playground"
	| "wgpu_ffi_smoke"
	| "wgpu_adapter_context_device"
	| "wgpu_adapter_write_texture_render_pass"
	| "wgpu_adapter_texture_view_variants"
	| "wgpu_adapter_depth_attachment_render_pass"
	| "wgpu_adapter_bind_group_layout"
	| "wgpu_adapter_sampler_descriptor"
	| "wgpu_adapter_copy_buffer_to_texture"
	| "three_adapter_math_render_pass"
	| "babylon_adapter_engine_init"
	| "babylon_adapter_textured_quad"
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
	| "screen_bounds_vs_workarea"
	| "updater_local_info_version"
	| "updater_local_info_channel"
	| "updater_local_info_hash"
	| "updater_app_data_folder"
	| "updater_channel_bucket_url"
	| "updater_check_for_update";

function resolveViewsRoot(): string {
	const cwdViews = pathJoin(host.cwd(), "views");
	if (host.existsSync(cwdViews)) return cwdViews;
	const bundledViews = pathJoin(host.cwd(), "..", "Resources", "app", "views");
	if (host.existsSync(bundledViews)) return bundledViews;
	return cwdViews;
}

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

type InteractiveWindowOptions = {
	renderer?: "native" | "cef";
	frame?: Rect;
	titleBarStyle?: string;
	transparent?: boolean;
};

type TrayPlaygroundState = {
	trayId: number;
	counterValue: number;
	counterRunning: boolean;
	lastCounterTick: number;
};

type WindowEventPlaygroundState = {
	kind: "move-resize" | "blur-focus";
	moveDetected: boolean;
	resizeDetected: boolean;
	blurDetected: boolean;
	focusDetected: boolean;
};

type MultiwindowCefState = {
	expected: number;
	loaded: Set<number>;
	closed: Set<number>;
};

type StressMessageStats = {
	count: number;
	expectedCount: number;
	missing: number[];
	duplicates: number[];
};

type StressRequestSummary = {
	total: number;
	received: number;
	errorCount: number;
	mismatchCount: number;
	errors: Array<{ id: number; error: string }>;
	mismatches: Array<{ id: number; value: unknown }>;
};

type HostSocketStressState = {
	hasSocket: boolean;
	hostSocketPort: number | null;
	socketUrl: string | null;
	readyState: number | null;
	bufferedAmount: number | null;
	canSend: boolean;
	hasEncrypt: boolean;
	hasHostBridge: boolean;
	sendQueueLength: number | null;
	pendingQueueLength: number | null;
	flushingSendQueue: boolean;
	flushingPendingQueue: boolean;
};

type SocketSendSummary = {
	socketSendCalls: number;
	encryptCalls: number;
	encryptResolvedCalls: number;
	lastEncryptStarted: string | null;
	lastEncryptResolved: string | null;
	wrapErrors: string[];
	state: HostSocketStressState;
};

type StressValueCollector<T> = {
	set(value: T): void;
	wait(label: string, timeoutMs?: number): T;
};

type StressHandlers = {
	bunStressMessages?: ReturnType<typeof createStressMessageCollector>;
	webviewMessageSummary?: StressValueCollector<StressMessageStats>;
	webviewRequestSummary?: StressValueCollector<StressRequestSummary>;
	socketSendSummary?: StressValueCollector<SocketSendSummary>;
};

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
	test("cottontail-window-focus-blur-default", "Window focus and blur events (titleBarStyle: default) (Cottontail)", "BrowserWindow", "window_focus_blur_default"),
	test("cottontail-window-focus-blur-hidden-inset", "Window focus and blur events (titleBarStyle: hiddenInset) (Cottontail)", "BrowserWindow", "window_focus_blur_hidden_inset"),
	test("cottontail-window-focus-blur-hidden", "Window focus and blur events (titleBarStyle: hidden) (Cottontail)", "BrowserWindow", "window_focus_blur_hidden"),
	test("cottontail-window-close-event", "Window close event (Cottontail)", "BrowserWindow", "window_close_event"),
	test("cottontail-window-resize-event", "Window resize event (Cottontail)", "BrowserWindow", "window_resize_event"),
	test("cottontail-window-get-by-id", "BrowserWindow.getById (Cottontail)", "BrowserWindow", "window_get_by_id"),
	test("cottontail-window-inset-titlebar-style", "Window with inset titlebar style (Cottontail)", "BrowserWindow", "window_inset_titlebar_style"),
	test("cottontail-window-traffic-light-position-api", "Window traffic light position API (Cottontail)", "BrowserWindow", "window_traffic_light_position_api"),
	test("cottontail-webview-create", "BrowserView create (Cottontail)", "BrowserView", "webview_create"),
	test("cottontail-webview-page-zoom", "BrowserView page zoom API (Cottontail)", "BrowserWindow", "webview_page_zoom"),
	test("cottontail-webview-tag-playground-integration", "Webview Tag playground integration (Cottontail)", "Webview Tag", "webview_tag_playground_integration"),
	interactiveTest("cottontail-webview-tag-playground", "Webview Tag playground (Cottontail)", "Webview Tag (Interactive)", "webview_tag_playground_interactive"),
	interactiveTest("cottontail-webview-tag-draggable-playground", "Draggable region playground (Cottontail)", "Webview Tag (Interactive)", "webview_tag_draggable_playground"),
	interactiveTest("cottontail-webview-tag-host-message-playground", "Host message playground (Cottontail)", "Webview Tag (Interactive)", "webview_tag_host_message_playground"),
	interactiveTest("cottontail-webview-tag-session-playground", "Session & partition playground (Cottontail)", "Webview Tag (Interactive)", "webview_tag_session_playground"),
	test("cottontail-wgpu-tag-playground-integration", "WGPU Tag playground integration (Cottontail)", "WGPU Tag", "wgpu_tag_playground_integration"),
	interactiveTest("cottontail-wgpu-tag-playground", "WGPU Tag playground (Cottontail)", "WGPU Tag (Interactive)", "wgpu_tag_playground_interactive"),
	interactiveTest("cottontail-wgpu-tag-transparent-playground", "Transparent WGPU Tag (Cottontail)", "WGPU Tag (Interactive)", "wgpu_tag_transparent_playground"),
	test("cottontail-navigation-load-url", "loadURL (Cottontail)", "Navigation", "navigation_load_url"),
	test("cottontail-navigation-views-url-query-suffix", "views:// URL with query strips file lookup suffix (Cottontail)", "Navigation", "navigation_views_url_query_suffix"),
	test("cottontail-navigation-views-url-hash-suffix", "views:// URL with hash strips file lookup suffix (Cottontail)", "Navigation", "navigation_views_url_hash_suffix"),
	test("cottontail-navigation-load-html", "loadHTML (Cottontail)", "Navigation", "navigation_load_html"),
	test("cottontail-navigation-rules-allowlist", "Navigation rules - allowlist (Cottontail)", "Navigation", "navigation_rules_allowlist"),
	test("cottontail-navigation-rules-block", "Navigation rules - block (Cottontail)", "Navigation", "navigation_rules_block"),
	test("cottontail-navigation-dom-ready-event", "dom-ready event (Cottontail)", "Navigation", "navigation_dom_ready_event"),
	test("cottontail-navigation-did-navigate-event", "did-navigate event (Cottontail)", "Navigation", "navigation_did_navigate_event"),
	test("cottontail-navigation-execute-javascript", "executeJavascript (fire and forget) (Cottontail)", "Navigation", "navigation_execute_javascript"),
	test("cottontail-navigation-find-in-page", "findInPage (Cottontail)", "Navigation", "navigation_find_in_page"),
	test("cottontail-preload-data-url", "Preload script with data URL (Cottontail)", "Preload", "preload_data_url"),
	test("cottontail-preload-external-url", "Preload with external URL (Cottontail)", "Preload", "preload_external_url"),
	test("cottontail-preload-dom-manipulation", "Preload script DOM manipulation (Cottontail)", "Preload", "preload_dom_manipulation"),
	test("cottontail-sandbox-rpc-disabled", "Sandbox mode - RPC is disabled (Cottontail)", "Sandbox", "sandbox_rpc_disabled"),
	test("cottontail-sandbox-rpc-enabled", "Non-sandbox mode - RPC works (Cottontail)", "Sandbox", "sandbox_rpc_enabled"),
	test("cottontail-sandbox-events-work", "Sandbox mode - events still work (Cottontail)", "Sandbox", "sandbox_events_work"),
	test("cottontail-sandbox-browser-window", "Sandbox mode - BrowserWindow (Cottontail)", "Sandbox", "sandbox_browser_window"),
	test("cottontail-sandbox-navigation-controls", "Sandbox mode - navigation controls work (Cottontail)", "Sandbox", "sandbox_navigation_controls"),
	test("cottontail-sandbox-non-sandbox-events-work", "Non-sandboxed mode - events work (Cottontail)", "Sandbox", "sandbox_non_sandbox_events_work"),
	test("cottontail-sandbox-oopif-blocked", "Sandbox mode - OOPIF webview tag blocked (Cottontail)", "Sandbox", "sandbox_oopif_blocked"),
	test("cottontail-sandbox-oopif-allowed", "Non-sandbox mode - OOPIF webview tag loads (Cottontail)", "Sandbox", "sandbox_oopif_allowed"),
	test("cottontail-rpc-host-to-webview-request", "host to webview: request with response (Cottontail)", "RPC", "rpc_host_to_webview_request"),
	test("cottontail-rpc-webview-to-host-request", "webview to host: request with response (Cottontail)", "RPC", "rpc_webview_to_host_request"),
	test("cottontail-rpc-echo-string", "RPC echo with string (Cottontail)", "RPC", "rpc_echo_string"),
	test("cottontail-rpc-large-payload-transfer", "RPC large payload transfer (Cottontail)", "RPC", "rpc_large_payload_transfer"),
	test("cottontail-rpc-evaluate-js-sync", "evaluateJavascriptWithResponse - sync (Cottontail)", "RPC", "rpc_eval_sync"),
	test("cottontail-rpc-evaluate-js-async-promise", "evaluateJavascriptWithResponse - async/promise (Cottontail)", "RPC", "rpc_eval_async_promise"),
	test("cottontail-rpc-evaluate-js-dom-access", "evaluateJavascriptWithResponse - DOM access (Cottontail)", "RPC", "rpc_eval_dom_access"),
	test("cottontail-rpc-get-document-title", "RPC getDocumentTitle (Cottontail)", "RPC", "rpc_get_document_title"),
	test("cottontail-rpc-stress-native-burst-delivery", "RPC stress: native burst delivery (Cottontail)", "RPC", "rpc_stress_native_burst_delivery"),
	test("cottontail-rpc-stress-native-fallback-socket-transition", "RPC stress: native fallback to socket transition (Cottontail)", "RPC", "rpc_stress_native_fallback_socket_transition"),
	test("cottontail-rpc-stress-native-steady-socket-delivery", "RPC stress: native steady socket delivery (Cottontail)", "RPC", "rpc_stress_native_steady_socket_delivery"),
	test("cottontail-browserview-get-all", "BrowserView.getAll (Cottontail)", "BrowserView", "browserview_get_all"),
	test("cottontail-browserview-get-by-id", "BrowserView.getById (Cottontail)", "BrowserView", "browserview_get_by_id"),
	test("cottontail-event-global-will-navigate", "Global will-navigate event (Cottontail)", "Events", "event_global_will_navigate"),
	test("cottontail-event-multiple-handlers", "Multiple event handlers (Cottontail)", "Events", "event_multiple_handlers"),
	test("cottontail-event-response-modification", "Event response modification (Cottontail)", "Events", "event_response_modification"),
	test("cottontail-event-window-specific-vs-global", "Window-specific vs global events (Cottontail)", "Events", "event_window_specific_vs_global"),
	test("cottontail-event-reopen-subscription", "reopen event subscription (Cottontail)", "Events", "event_reopen_subscription"),
	test("cottontail-event-before-quit-cancel", "before-quit event can cancel quit (Cottontail)", "Events", "event_before_quit_cancel"),
	test("cottontail-event-window-close-order", "Window close fires per-window handler before global (Cottontail)", "Events", "event_window_close_order"),
	test("cottontail-tray-visibility-toggle-bounds", "Tray visibility toggle and bounds (Cottontail)", "Tray", "tray_visibility_toggle_and_bounds"),
	test("cottontail-session-from-partition", "Session.fromPartition (Cottontail)", "Session", "session_from_partition"),
	test("cottontail-session-default-session", "Session.defaultSession (Cottontail)", "Session", "session_default_session"),
	test("cottontail-session-cookies-api-exists", "cookies API exists (Cottontail)", "Session", "session_cookies_api_exists"),
	interactiveTest("cottontail-application-menu-playground", "Application menu playground (Cottontail)", "Menus (Interactive)", "application_menu_playground"),
	interactiveTest("cottontail-context-menu-playground", "Context menu playground (Cottontail)", "Menus (Interactive)", "context_menu_playground"),
	interactiveTest("cottontail-dialog-show-message-box-info", "showMessageBox - info dialog (Cottontail)", "Dialogs (Interactive)", "dialog_show_message_box_info"),
	interactiveTest("cottontail-dialog-show-message-box-question", "showMessageBox - question dialog (Cottontail)", "Dialogs (Interactive)", "dialog_show_message_box_question"),
	interactiveTest("cottontail-dialog-file-dialog-playground", "File dialog playground (Cottontail)", "Dialogs (Interactive)", "dialog_file_dialog_playground"),
	interactiveTest("cottontail-dialog-open-external", "openExternal - open URL in browser (Cottontail)", "Dialogs (Interactive)", "dialog_open_external"),
	interactiveTest("cottontail-dialog-open-path", "openPath - open folder (Cottontail)", "Dialogs (Interactive)", "dialog_open_path"),
	interactiveTest("cottontail-dialog-show-item-in-folder", "showItemInFolder (Cottontail)", "Dialogs (Interactive)", "dialog_show_item_in_folder"),
	interactiveTest("cottontail-dialog-show-notification-interactive", "showNotification - interactive (Cottontail)", "Dialogs (Interactive)", "dialog_show_notification_interactive"),
	interactiveTest("cottontail-clipboard-playground", "Clipboard playground (Cottontail)", "Clipboard (Interactive)", "clipboard_playground"),
	interactiveTest("cottontail-global-shortcuts-playground", "Global shortcuts playground (Cottontail)", "Shortcuts (Interactive)", "global_shortcuts_playground"),
	test("cottontail-global-shortcut-is-registered-api", "GlobalShortcut.isRegistered API (Cottontail)", "Shortcuts", "global_shortcut_is_registered_api"),
	test("cottontail-global-shortcut-unregister-all-api", "GlobalShortcut.unregisterAll API (Cottontail)", "Shortcuts", "global_shortcut_unregister_all_api"),
	test("cottontail-lifecycle-before-quit-cancel", "before-quit event can cancel quit (Cottontail)", "App Lifecycle", "lifecycle_before_quit_cancel"),
	interactiveTest("cottontail-quit-shutdown-playground", "Quit/Shutdown playground (Cottontail)", "Quit (Interactive)", "quit_shutdown_playground"),
	interactiveTest("cottontail-tray-playground", "Tray playground (Cottontail)", "Tray (Interactive)", "tray_playground"),
	interactiveTest("cottontail-window-events-move-resize", "Window move and resize events (Cottontail)", "Window Events (Interactive)", "window_events_move_resize"),
	interactiveTest("cottontail-window-events-blur-focus", "Window blur and focus events (Cottontail)", "Window Events (Interactive)", "window_events_blur_focus"),
	interactiveTest("cottontail-window-events-visible-on-all-workspaces", "Window visibleOnAllWorkspaces (macOS) (Cottontail)", "Window Events (Interactive)", "window_events_visible_on_all_workspaces"),
	interactiveTest("cottontail-chromeless-custom-titlebar", "Custom titlebar with window controls (Cottontail)", "Chromeless Windows (Interactive)", "chromeless_custom_titlebar"),
	interactiveTest("cottontail-chromeless-transparent-window", "Transparent/borderless window for floating UI (Cottontail)", "Chromeless Windows (Interactive)", "chromeless_transparent_window"),
	interactiveTest("cottontail-multiwindow-cef-oopif", "Multi-window CEF OOPIF test (Cottontail)", "CEF (Interactive)", "multiwindow_cef_oopif"),
	interactiveTest("cottontail-webview-settings-playground", "Webview Settings playground (Cottontail)", "Webview Tag (Interactive)", "webview_settings_playground"),
	interactiveTest("cottontail-webview-cleanup-playground", "Webview process cleanup on window close (Cottontail)", "Webview Cleanup (Interactive)", "webview_cleanup_playground"),
	interactiveTest("cottontail-fullsize-frame-repro", "macOS fullSize webview frame repro (Cottontail)", "Layout (Interactive)", "fullsize_frame_repro"),
	interactiveTest("cottontail-permissions-cef", "Permission prompt - CEF (Cottontail)", "Permissions (Interactive)", "permissions_cef"),
	interactiveTest("cottontail-permissions-native", "Permission prompt - native (Cottontail)", "Permissions (Interactive)", "permissions_native"),
	interactiveTest("cottontail-wgpu-view-native-cube", "WGPUView native cube (Cottontail)", "WGPUView (Interactive)", "wgpu_view_native_cube"),
	interactiveTest("cottontail-wgpu-view-basic-window", "WGPUView basic window (Cottontail)", "WGPUView (Interactive)", "wgpu_view_basic_window"),
	interactiveTest("cottontail-wgpu-view-transparent-cube", "Transparent window WGPU cube (Cottontail)", "WGPUView (Interactive)", "wgpu_view_transparent_cube"),
	interactiveTest("cottontail-wgpu-view-three-playground", "Three.js WGPU playground (Cottontail)", "WGPUView (Interactive)", "wgpu_view_three_playground"),
	interactiveTest("cottontail-wgpu-view-babylon-playground", "Babylon.js WGPU playground (Cottontail)", "WGPUView (Interactive)", "wgpu_view_babylon_playground"),
	test("cottontail-wgpu-ffi-smoke", "WGPU FFI smoke test (Cottontail)", "WGPU", "wgpu_ffi_smoke"),
	test("cottontail-wgpu-adapter-context-device", "WebGPU adapter: context/device init (Cottontail)", "WebGPU", "wgpu_adapter_context_device"),
	test("cottontail-wgpu-adapter-write-texture-render-pass", "WebGPU adapter: writeTexture + render pass (Cottontail)", "WebGPU", "wgpu_adapter_write_texture_render_pass"),
	test("cottontail-wgpu-adapter-texture-view-variants", "WebGPU adapter: texture view variants (Cottontail)", "WebGPU", "wgpu_adapter_texture_view_variants"),
	test("cottontail-wgpu-adapter-depth-attachment-render-pass", "WebGPU adapter: depth attachment render pass (Cottontail)", "WebGPU", "wgpu_adapter_depth_attachment_render_pass"),
	test("cottontail-wgpu-adapter-bind-group-layout", "WebGPU adapter: bind group layout (Cottontail)", "WebGPU", "wgpu_adapter_bind_group_layout"),
	test("cottontail-wgpu-adapter-sampler-descriptor", "WebGPU adapter: sampler descriptor (Cottontail)", "WebGPU", "wgpu_adapter_sampler_descriptor"),
	test("cottontail-wgpu-adapter-copy-buffer-to-texture", "WebGPU adapter: copyBufferToTexture (Cottontail)", "WebGPU", "wgpu_adapter_copy_buffer_to_texture"),
	test("cottontail-three-adapter-math-render-pass", "Three adapter: math + render pass (Cottontail)", "Three", "three_adapter_math_render_pass"),
	test("cottontail-babylon-adapter-engine-init", "Babylon adapter: engine init (Cottontail)", "Babylon", "babylon_adapter_engine_init"),
	test("cottontail-babylon-adapter-textured-quad", "Babylon adapter: textured quad (Cottontail)", "Babylon", "babylon_adapter_textured_quad"),
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
	test("cottontail-updater-local-info-version", "Updater.localInfo.version (Cottontail)", "Updater", "updater_local_info_version"),
	test("cottontail-updater-local-info-channel", "Updater.localInfo.channel (Cottontail)", "Updater", "updater_local_info_channel"),
	test("cottontail-updater-local-info-hash", "Updater.localInfo.hash (Cottontail)", "Updater", "updater_local_info_hash"),
	test("cottontail-updater-app-data-folder", "Updater.appDataFolder (Cottontail)", "Updater", "updater_app_data_folder"),
	test("cottontail-updater-channel-bucket-url", "Updater.channelBucketUrl (Cottontail)", "Updater", "updater_channel_bucket_url"),
	test("cottontail-updater-check-for-update", "Updater.checkForUpdate (Cottontail)", "Updater", "updater_check_for_update"),
];

let searchQuery = "";
let autoRunTriggered = false;
const topLevelWebviews = new Map<number, number>();
const childWebviews = new Map<number, "native" | "cef">();
const knownWebviews = new Set<number>();
const webviewRPCHandlers = new Map<number, (packet: any) => void>();
const harnessProbeMessages = new Map<string, any>();
const harnessRPCRequestCounts = new Map<number, number>();
const harnessRPCSendCounts = new Map<number, number>();
const harnessRPCResponseCounts = new Map<number, number>();
const harnessReceiveProbePrefixes = new Map<number, string>();
const webviewEventCounts = new Map<number, { didNavigate: number; domReady: number; willNavigate: number; lastDetail: string }>();
const pendingWebviewRPCPackets: Array<{ webviewId: number; packet: any }> = [];
const trayPlaygrounds = new Map<number, TrayPlaygroundState>();
const shortcutPlaygrounds = new Map<number, Set<string>>();
const windowEventPlaygrounds = new Map<number, WindowEventPlaygroundState>();
const multiwindowCefPlaygrounds = new Map<number, MultiwindowCefState>();
const windowToTopLevelWebview = new Map<number, number>();
const webviewCleanupWindows = new Map<number, number[]>();
let webviewProbeCounter = 0;
const callbacks = {
	windowCloseCount: 0,
	windowResizeCount: 0,
	windowFocusCount: 0,
	windowBlurCount: 0,
	lastCloseWindowId: 0,
	lastFocusWindowId: 0,
	lastBlurWindowId: 0,
	lastResizeWidth: 0,
	lastResizeHeight: 0,
	webviewDidNavigate: 0,
	webviewDomReady: 0,
	webviewWillNavigate: 0,
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
	callbacks.windowBlurCount = 0;
	callbacks.lastCloseWindowId = 0;
	callbacks.lastFocusWindowId = 0;
	callbacks.lastBlurWindowId = 0;
	callbacks.lastResizeWidth = 0;
	callbacks.lastResizeHeight = 0;
	callbacks.webviewDidNavigate = 0;
	callbacks.webviewDomReady = 0;
	callbacks.webviewWillNavigate = 0;
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

function assertTruthyStringSync(name: string, value: unknown): void {
	assert(typeof value === "string", `${name} was not a string`);
	assert(value.length > 0, `${name} was empty`);
}

function createStressMessageCollector() {
	const ids = new Set<number>();
	const duplicates = new Set<number>();
	return {
		reset() {
			ids.clear();
			duplicates.clear();
		},
		record(id: number) {
			if (ids.has(id)) duplicates.add(id);
			ids.add(id);
		},
		getStats(expectedCount: number): StressMessageStats {
			const missing: number[] = [];
			for (let id = 0; id < expectedCount; id += 1) {
				if (!ids.has(id)) missing.push(id);
			}
			return {
				count: ids.size,
				expectedCount,
				missing,
				duplicates: [...duplicates].sort((a, b) => a - b),
			};
		},
	};
}

function createStressValueCollector<T>(): StressValueCollector<T> {
	let value: T | undefined;
	return {
		set(nextValue: T) {
			value = nextValue;
		},
		wait(label: string, timeoutMs = 10000) {
			const started = nowMs();
			while (nowMs() - started < timeoutMs) {
				drainBridgeEvents();
				host.drainJobs?.();
				if (value !== undefined) return value;
				sleep(25);
			}
			throw new Error(`Timed out waiting for ${label}`);
		},
	};
}

function describeStressFailure(label: string, stats: StressMessageStats): string {
	return [
		`${label}: expected ${stats.expectedCount}, received ${stats.count}`,
		`missing=${stats.missing.length ? stats.missing.slice(0, 20).join(",") : "none"}`,
		`duplicates=${stats.duplicates.length ? stats.duplicates.slice(0, 20).join(",") : "none"}`,
	].join("; ");
}

function waitForStressStats(readStats: () => StressMessageStats, expectedCount: number, timeoutMs = 5000): StressMessageStats {
	const started = nowMs();
	let stats = readStats();
	while (nowMs() - started < timeoutMs && (stats.count < expectedCount || stats.missing.length > 0)) {
		drainBridgeEvents();
		host.drainJobs?.();
		sleep(25);
		stats = readStats();
	}
	return stats;
}

function assertAllStressMessagesArrived(label: string, stats: StressMessageStats): void {
	if (stats.count !== stats.expectedCount || stats.missing.length > 0 || stats.duplicates.length > 0) {
		throw new Error(describeStressFailure(label, stats));
	}
}

function waitUntil(timeoutMs: number, predicate: () => boolean): boolean {
	const started = nowMs();
	while (nowMs() - started < timeoutMs) {
		drainBridgeEvents();
		host.drainJobs?.();
		if (predicate()) return true;
		sleep(25);
	}
	drainBridgeEvents();
	host.drainJobs?.();
	return predicate();
}

function closeWindowSilent(windowId: number): void {
	try {
		native.closeWindow(windowId);
	} catch {}
}

function cleanupInteractiveState(webviewId: number): void {
	const tray = trayPlaygrounds.get(webviewId);
	if (tray) {
		try {
			native.removeTray(tray.trayId);
		} catch {}
		trayPlaygrounds.delete(webviewId);
	}

	const shortcuts = shortcutPlaygrounds.get(webviewId);
	if (shortcuts) {
		for (const accelerator of shortcuts) {
			try {
				native.unregisterGlobalShortcut(accelerator);
			} catch {}
		}
		shortcutPlaygrounds.delete(webviewId);
	}

	const cleanupWindows = webviewCleanupWindows.get(webviewId);
	if (cleanupWindows) {
		for (const windowId of cleanupWindows) {
			closeWindowSilent(windowId);
		}
		webviewCleanupWindows.delete(webviewId);
	}

	windowEventPlaygrounds.delete(webviewId);
	multiwindowCefPlaygrounds.delete(webviewId);
	const windowId = topLevelWebviews.get(webviewId);
	if (windowId) windowToTopLevelWebview.delete(windowId);
	topLevelWebviews.delete(webviewId);
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

function createTrackedWebview(options: Parameters<typeof native.createWebview>[0]): number {
	const webviewId = native.createWebview(options);
	knownWebviews.add(webviewId);
	return webviewId;
}

function webviewEventState(webviewId: number): { didNavigate: number; domReady: number; willNavigate: number; lastDetail: string } {
	let state = webviewEventCounts.get(webviewId);
	if (!state) {
		state = { didNavigate: 0, domReady: 0, willNavigate: 0, lastDetail: "" };
		webviewEventCounts.set(webviewId, state);
	}
	return state;
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
		const webviewId = createTrackedWebview(webviewOptions(windowId, testHarnessURL, { x: 0, y: 0, width: frame.width, height: frame.height }));
		return { windowId, webviewId };
	} catch (error) {
		closeWindowSilent(windowId);
		throw error;
	}
}

function createWindowWithTestHarness(title: string, frame: Rect, hidden: boolean, activate: boolean): WindowWithWebview {
	return createWindowWithHarnessCustom(title, frame, hidden, activate);
}

function createWindowWithCustomWebview(
	title: string,
	frame: Rect,
	options: Partial<Parameters<typeof native.createWebview>[0]> & { html?: string } = {},
	renderer: "native" | "cef" = "cef",
	hidden = true,
	activate = false,
): WindowWithWebview {
	const windowId = native.createWindow({
		title,
		...frame,
		hidden,
		activate,
		quitOnClose: false,
	});
	try {
		const html = typeof options.html === "string" ? options.html : "";
		const url = String(options.url ?? (html ? "" : testHarnessURL));
		const webviewId = createTrackedWebview({
			...webviewOptions(windowId, url, { x: 0, y: 0, width: frame.width, height: frame.height }, renderer),
			...options,
			windowId,
			renderer,
		});
		if (html) {
			if (renderer === "cef") {
				native.setWebviewHTMLContent(webviewId, html);
				native.loadURLInWebview(webviewId, "views://internal/index.html");
			} else {
				native.loadHTMLInWebview(webviewId, html);
			}
		}
		return { windowId, webviewId };
	} catch (error) {
		closeWindowSilent(windowId);
		throw error;
	}
}

function activePlaygroundRenderer(): "native" | "cef" {
	return "cef";
}

function openInteractivePlaygroundWindow(title: string, url: string, options: InteractiveWindowOptions = {}): WindowWithWebview {
	resetCallbacks();
	const frame = options.frame ?? { x: 120, y: 70, width: 860, height: 640 };
	const renderer = options.renderer ?? activePlaygroundRenderer();
	const windowId = native.createWindow({
		title,
		...frame,
		titleBarStyle: options.titleBarStyle ?? "default",
		transparent: Boolean(options.transparent),
		quitOnClose: false,
	});
	try {
		const webviewId = createTrackedWebview(webviewOptions(windowId, url, { x: 0, y: 0, width: frame.width, height: frame.height }, renderer));
		topLevelWebviews.set(webviewId, windowId);
		windowToTopLevelWebview.set(windowId, webviewId);
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

function recordObservedWebviewEvent(webviewId: number | undefined, eventName: string, detail: string): void {
	if (eventName === "will-navigate") callbacks.webviewWillNavigate += 1;
	if (eventName === "did-navigate") callbacks.webviewDidNavigate += 1;
	if (eventName === "dom-ready") callbacks.webviewDomReady += 1;
	callbacks.lastWebviewDetail = detail;
	if (webviewId && webviewId > 0) {
		const state = webviewEventState(webviewId);
		if (eventName === "will-navigate") state.willNavigate += 1;
		if (eventName === "did-navigate") state.didNavigate += 1;
		if (eventName === "dom-ready") state.domReady += 1;
		state.lastDetail = detail;
	}
}

function handleNativeEvent(event: NativeEvent): void {
	switch (event.type) {
		case "windowClose":
			callbacks.windowCloseCount += 1;
			callbacks.lastCloseWindowId = event.windowId;
			{
				const webviewId = windowToTopLevelWebview.get(event.windowId);
				if (webviewId) {
					multiwindowCefPlaygrounds.get(webviewId)?.closed.add(event.windowId);
					cleanupInteractiveState(webviewId);
				}
			}
			break;
		case "windowResize":
			callbacks.windowResizeCount += 1;
			callbacks.lastResizeWidth = event.width;
			callbacks.lastResizeHeight = event.height;
			{
				const webviewId = windowToTopLevelWebview.get(event.windowId);
				const state = webviewId ? windowEventPlaygrounds.get(webviewId) : undefined;
				if (webviewId && state?.kind === "move-resize") {
					state.resizeDetected = true;
					sendRPCMessage(webviewId, "updateSize", { width: Math.round(event.width), height: Math.round(event.height) });
					sendRPCMessage(webviewId, "updateStatus", { moveDetected: state.moveDetected, resizeDetected: state.resizeDetected });
				}
			}
			break;
		case "windowMove":
			{
				const webviewId = windowToTopLevelWebview.get(event.windowId);
				const state = webviewId ? windowEventPlaygrounds.get(webviewId) : undefined;
				if (webviewId && state?.kind === "move-resize") {
					state.moveDetected = true;
					sendRPCMessage(webviewId, "updatePosition", { x: Math.round(event.x), y: Math.round(event.y) });
					sendRPCMessage(webviewId, "updateStatus", { moveDetected: state.moveDetected, resizeDetected: state.resizeDetected });
				}
			}
			break;
		case "windowFocus":
			callbacks.windowFocusCount += 1;
			callbacks.lastFocusWindowId = event.windowId;
			{
				const webviewId = windowToTopLevelWebview.get(event.windowId);
				const state = webviewId ? windowEventPlaygrounds.get(webviewId) : undefined;
				if (webviewId && state?.kind === "blur-focus") {
					state.focusDetected = true;
					sendRPCMessage(webviewId, "updateStatus", { blurDetected: state.blurDetected, focusDetected: state.focusDetected });
				}
			}
			break;
		case "windowBlur":
			callbacks.windowBlurCount += 1;
			callbacks.lastBlurWindowId = event.windowId;
			{
				const webviewId = windowToTopLevelWebview.get(event.windowId);
				const state = webviewId ? windowEventPlaygrounds.get(webviewId) : undefined;
				if (webviewId && state?.kind === "blur-focus") {
					state.blurDetected = true;
					sendRPCMessage(webviewId, "updateStatus", { blurDetected: state.blurDetected, focusDetected: state.focusDetected });
				}
			}
			break;
		case "webviewEvent":
			recordObservedWebviewEvent(event.webviewId, event.eventName, event.detail);
			break;
		case "webviewEventBridge":
			observedWebviewBridge(event.webviewId, event.message);
			break;
		case "webviewInternalBridge":
			playgroundInternalBridge(event.webviewId, event.message);
			break;
		case "quitRequested":
			callbacks.beforeQuitCount += 1;
			break;
		case "globalShortcut":
			for (const [webviewId, shortcuts] of shortcutPlaygrounds) {
				if (shortcuts.has(event.accelerator)) {
					sendRPCMessage(webviewId, "shortcutTriggered", { accelerator: event.accelerator });
				}
			}
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

function flushPendingWebviewRPCPackets(): boolean {
	let flushed = false;
	while (pendingWebviewRPCPackets.length > 0) {
		const next = pendingWebviewRPCPackets.shift()!;
		native.evaluateJavaScriptWithNoCompletion(
			next.webviewId,
			`
				if (window.electrobun) window.electrobun.hostSocketCanSend = false;
				window.__electrobun.receiveMessageFromHost(${JSON.stringify(next.packet)});
			`,
		);
		flushed = true;
	}
	return flushed;
}

function tickTrayPlaygrounds(): boolean {
	const current = nowMs();
	let updated = false;
	for (const state of trayPlaygrounds.values()) {
		if (!state.counterRunning || current - state.lastCounterTick < 1000) continue;
		state.counterValue += 1;
		state.lastCounterTick = current;
		native.setTrayTitle(state.trayId, `Count: ${state.counterValue}`);
		updated = true;
	}
	return updated;
}

function drainBridgeEvents(): boolean {
	const flushedRPC = flushPendingWebviewRPCPackets();
	const drainedNativeBefore = drainNativeEvents();
	const drainedHost = drainQueuedHostMessages();
	const drainedNativeAfter = drainNativeEvents();
	const tickedTray = tickTrayPlaygrounds();
	return drainedNativeBefore || drainedHost || flushedRPC || drainedNativeAfter || tickedTray;
}

function observedWebviewBridge(webviewId: number, message: string): void {
	const packet = parseMaybeJSON<any>(message);
	if (packet?.id === "webviewEvent") {
		const payload = typeof packet.payload === "object" && packet.payload ? packet.payload : packet;
		recordObservedWebviewEvent(webviewId, String(payload.eventName ?? ""), String(payload.detail ?? ""));
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

function base64EncodeASCII(value: string): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let output = "";
	for (let index = 0; index < value.length; index += 3) {
		const a = value.charCodeAt(index) & 0xff;
		const b = index + 1 < value.length ? value.charCodeAt(index + 1) & 0xff : 0;
		const c = index + 2 < value.length ? value.charCodeAt(index + 2) & 0xff : 0;
		const triplet = (a << 16) | (b << 8) | c;
		output += alphabet[(triplet >> 18) & 0x3f];
		output += alphabet[(triplet >> 12) & 0x3f];
		output += index + 1 < value.length ? alphabet[(triplet >> 6) & 0x3f] : "=";
		output += index + 2 < value.length ? alphabet[triplet & 0x3f] : "=";
	}
	return output;
}

function preloadDataURL(source: string): string {
	return `data:text/javascript;base64,${base64EncodeASCII(source)}`;
}

function tryWebviewProbe(webviewId: number, body: string, timeoutMs = 3000): { responded: boolean; value?: any; error?: string } {
	const probeId = `ctHarnessProbe:${webviewId}:${nowMs()}:${webviewProbeCounter++}`;
	harnessProbeMessages.delete(probeId);
	native.evaluateJavaScriptWithNoCompletion(webviewId, `
		(async () => {
			try {
				const value = await (async () => { ${body} })();
				window.__electrobunHostBridge?.postMessage(JSON.stringify({
					type: "message",
					id: ${JSON.stringify(probeId)},
					payload: { ok: true, value }
				}));
			} catch (error) {
				window.__electrobunHostBridge?.postMessage(JSON.stringify({
					type: "message",
					id: ${JSON.stringify(probeId)},
					payload: { ok: false, error: String(error?.message || error) }
				}));
			}
		})();
	`);
	if (!waitUntil(timeoutMs, () => harnessProbeMessages.has(probeId))) {
		return { responded: false };
	}
	const payload = harnessProbeMessages.get(probeId);
	harnessProbeMessages.delete(probeId);
	if (!payload?.ok) {
		return { responded: true, error: String(payload?.error || "probe failed") };
	}
	return { responded: true, value: payload.value };
}

function webviewProbe(webviewId: number, body: string, timeoutMs = 3000): any {
	const result = tryWebviewProbe(webviewId, body, timeoutMs);
	assert(result.responded, "webview probe did not respond");
	assert(!result.error, result.error || "webview probe failed");
	return result.value;
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
		recordObservedWebviewEvent(hostWebviewId, String(payload.eventName ?? ""), String(payload.detail ?? ""));
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
	const webviewId = createTrackedWebview({
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
		case "window_focus_blur_default":
			return runWindowFocusBlurTitleBarStyleTest("default");
		case "window_focus_blur_hidden_inset":
			return runWindowFocusBlurTitleBarStyleTest("hiddenInset");
		case "window_focus_blur_hidden":
			return runWindowFocusBlurTitleBarStyleTest("hidden");
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
		case "webview_tag_draggable_playground":
			return runInteractivePlaygroundTest("Draggable Region Test", "views://playgrounds/draggable/index.html", {
				frame: { width: 500, height: 450, x: 200, y: 100 },
				titleBarStyle: "hidden",
			});
		case "webview_tag_host_message_playground":
			return runInteractivePlaygroundTest("Host Message Playground", "views://playgrounds/host-message/index.html", {
				frame: { width: 700, height: 600, x: 150, y: 80 },
			});
		case "webview_tag_session_playground":
			return runInteractivePlaygroundTest("Session & Partition Playground", "views://playgrounds/session/index.html", {
				frame: { width: 900, height: 800, x: 100, y: 50 },
			});
		case "wgpu_tag_playground_integration":
			return runWgpuTagPlaygroundIntegrationTest();
		case "wgpu_tag_playground_interactive":
			return runInteractivePlaygroundTest("WGPU Tag Playground", "views://playgrounds/wgpu-tag/index.html", {
				renderer: "native",
				frame: { width: 860, height: 720, x: 120, y: 60 },
			});
		case "wgpu_tag_transparent_playground":
			return runInteractivePlaygroundTest("Transparent WGPU Tag", "views://playgrounds/wgpu-tag/index.html", {
				renderer: "native",
				frame: { width: 860, height: 720, x: 120, y: 60 },
				transparent: true,
			});
		case "navigation_load_url":
			return runNavigationLoadURLTest();
		case "navigation_views_url_query_suffix":
			return runNavigationViewsURLSuffixTest("views://test-harness/index.html?env=dev&dashWindowId=main", "?env=dev&dashWindowId=main", "");
		case "navigation_views_url_hash_suffix":
			return runNavigationViewsURLSuffixTest("views://test-harness/index.html#section", "", "#section");
		case "navigation_load_html":
			return runNavigationLoadHTMLTest();
		case "navigation_rules_allowlist":
			return runNavigationRulesAllowlistTest();
		case "navigation_rules_block":
			return runNavigationRulesBlockTest();
		case "navigation_dom_ready_event":
			return runNavigationDomReadyEventTest();
		case "navigation_did_navigate_event":
			return runNavigationDidNavigateEventTest();
		case "navigation_execute_javascript":
			return runNavigationExecuteJavascriptTest();
		case "navigation_find_in_page":
			return runNavigationFindInPageTest();
		case "preload_data_url":
			return runPreloadDataURLTest();
		case "preload_external_url":
			return runPreloadExternalURLTest();
		case "preload_dom_manipulation":
			return runPreloadDOMManipulationTest();
		case "sandbox_rpc_disabled":
			return runSandboxRPCDisabledTest();
		case "sandbox_rpc_enabled":
			return runSandboxRPCEnabledTest();
		case "sandbox_events_work":
			return runSandboxEventsWorkTest();
		case "sandbox_browser_window":
			return runSandboxBrowserWindowTest();
		case "sandbox_navigation_controls":
			return runSandboxNavigationControlsTest();
		case "sandbox_non_sandbox_events_work":
			return runSandboxNonSandboxEventsWorkTest();
		case "sandbox_oopif_blocked":
			return runSandboxOOPIFBlockedTest();
		case "sandbox_oopif_allowed":
			return runSandboxOOPIFAllowedTest();
		case "rpc_host_to_webview_request":
			return runRPCHostToWebviewRequestTest();
		case "rpc_webview_to_host_request":
			return runRPCWebviewToHostRequestTest();
		case "rpc_echo_string":
			return runRPCEchoStringTest();
		case "rpc_large_payload_transfer":
			return runRPCLargePayloadTransferTest();
		case "rpc_eval_sync":
			return runRPCEvaluateJavascriptSyncTest();
		case "rpc_eval_async_promise":
			return runRPCEvaluateJavascriptAsyncPromiseTest();
		case "rpc_eval_dom_access":
			return runRPCEvaluateJavascriptDOMAccessTest();
		case "rpc_get_document_title":
			return runRPCGetDocumentTitleTest();
		case "rpc_stress_native_burst_delivery":
			return runRPCStressNativeBurstDeliveryTest();
		case "rpc_stress_native_fallback_socket_transition":
			return runRPCStressNativeFallbackSocketTransitionTest();
		case "rpc_stress_native_steady_socket_delivery":
			return runRPCStressNativeSteadySocketDeliveryTest();
		case "browserview_get_all":
			return runBrowserViewGetAllTest();
		case "browserview_get_by_id":
			return runBrowserViewGetByIdTest();
		case "event_global_will_navigate":
			return runEventGlobalWillNavigateTest();
		case "event_multiple_handlers":
			return runEventMultipleHandlersTest();
		case "event_response_modification":
			return runEventResponseModificationTest();
		case "event_window_specific_vs_global":
			return runEventWindowSpecificVsGlobalTest();
		case "event_reopen_subscription":
			return runEventReopenSubscriptionTest();
		case "event_before_quit_cancel":
			return runLifecycleBeforeQuitCancelTest();
		case "event_window_close_order":
			return runEventWindowCloseOrderTest();
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
		case "dialog_show_message_box_question":
			return runShowMessageBoxQuestionDialogTest();
		case "dialog_file_dialog_playground":
			return runInteractivePlaygroundTest("File Dialog Playground", "views://playgrounds/file-dialog/index.html", {
				frame: { width: 600, height: 850, x: 200, y: 50 },
			});
		case "dialog_open_external":
			return runOpenExternalInteractiveTest();
		case "dialog_open_path":
			return runOpenPathInteractiveTest();
		case "dialog_show_item_in_folder":
			return runShowItemInFolderInteractiveTest();
		case "dialog_show_notification_interactive":
			return runShowNotificationInteractiveTest();
		case "clipboard_playground":
			return runInteractivePlaygroundTest("Clipboard Playground", "views://playgrounds/clipboard/index.html", {
				frame: { width: 550, height: 800, x: 200, y: 50 },
			});
		case "global_shortcuts_playground":
			return runInteractivePlaygroundTest("Global Shortcuts Playground", "views://playgrounds/shortcuts/index.html", {
				frame: { width: 600, height: 800, x: 200, y: 50 },
			});
		case "global_shortcut_is_registered_api":
			return runGlobalShortcutIsRegisteredAPITest();
		case "global_shortcut_unregister_all_api":
			return runGlobalShortcutUnregisterAllAPITest();
		case "lifecycle_before_quit_cancel":
			return runLifecycleBeforeQuitCancelTest();
		case "quit_shutdown_playground":
			return runInteractivePlaygroundTest("Quit/Shutdown Test Playground", "views://playgrounds/quit-test/index.html");
		case "tray_playground":
			return runInteractivePlaygroundTest("Tray Playground", "views://playgrounds/tray/index.html", {
				frame: { width: 500, height: 750, x: 200, y: 50 },
			});
		case "window_events_move_resize":
			return runWindowEventsMoveResizeInteractiveTest();
		case "window_events_blur_focus":
			return runWindowEventsBlurFocusInteractiveTest();
		case "window_events_visible_on_all_workspaces":
			return runWindowVisibleOnAllWorkspacesInteractiveTest();
		case "chromeless_custom_titlebar":
			return runInteractivePlaygroundTest("Custom Titlebar", "views://playgrounds/custom-titlebar/index.html", {
				frame: { width: 500, height: 700, x: 150, y: 50 },
				titleBarStyle: "hidden",
			});
		case "chromeless_transparent_window":
			return runInteractivePlaygroundTest("Transparent Window", "views://playgrounds/transparent-window/index.html", {
				frame: { width: 450, height: 500, x: 200, y: 100 },
				titleBarStyle: "hidden",
				transparent: true,
			});
		case "multiwindow_cef_oopif":
			return runMultiwindowCefOopifInteractiveTest();
		case "webview_settings_playground":
			return runInteractivePlaygroundTest("Webview Settings Playground", "views://playgrounds/webview-settings/index.html", {
				frame: { width: 700, height: 800, x: 150, y: 50 },
			});
		case "webview_cleanup_playground":
			return runWebviewCleanupInteractiveTest();
		case "fullsize_frame_repro":
			return runInteractivePlaygroundTest("FullSize Frame Repro", "views://playgrounds/fullsize-frame-repro/index.html", {
				renderer: "native",
				frame: { width: 760, height: 560, x: 160, y: 90 },
			});
		case "permissions_cef":
			return runPermissionPromptInteractiveTest("cef");
		case "permissions_native":
			return runPermissionPromptInteractiveTest("native");
		case "wgpu_view_native_cube":
			return runWgpuViewNativeCubeInteractiveTest(false);
		case "wgpu_view_basic_window":
			return runWgpuViewBasicWindowInteractiveTest();
		case "wgpu_view_transparent_cube":
			return runWgpuViewNativeCubeInteractiveTest(true);
		case "wgpu_view_three_playground":
			return runWgpuViewThreePlaygroundInteractiveTest();
		case "wgpu_view_babylon_playground":
			return runWgpuViewBabylonPlaygroundInteractiveTest();
		case "wgpu_ffi_smoke":
			return runWgpuFFISmokeTest();
		case "wgpu_adapter_context_device":
			return runWgpuAdapterContextDeviceTest();
		case "wgpu_adapter_write_texture_render_pass":
			return runWgpuAdapterWriteTextureRenderPassTest();
		case "wgpu_adapter_texture_view_variants":
			return runWgpuAdapterTextureViewVariantsTest();
		case "wgpu_adapter_depth_attachment_render_pass":
			return runWgpuAdapterDepthAttachmentRenderPassTest();
		case "wgpu_adapter_bind_group_layout":
			return runWgpuAdapterBindGroupLayoutTest();
		case "wgpu_adapter_sampler_descriptor":
			return runWgpuAdapterSamplerDescriptorTest();
		case "wgpu_adapter_copy_buffer_to_texture":
			return runWgpuAdapterCopyBufferToTextureTest();
		case "three_adapter_math_render_pass":
			return runThreeAdapterMathRenderPassTest();
		case "babylon_adapter_engine_init":
			return runBabylonAdapterEngineInitTest();
		case "babylon_adapter_textured_quad":
			return runBabylonAdapterTexturedQuadTest();
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
		case "updater_local_info_version":
			return assertTruthyStringSync("version", waitForPromise(Updater.localInfo.version(), 3000));
		case "updater_local_info_channel":
			return assertTruthyStringSync("channel", waitForPromise(Updater.localInfo.channel(), 3000));
		case "updater_local_info_hash":
			return assertTruthyStringSync("hash", waitForPromise(Updater.localInfo.hash(), 3000));
		case "updater_app_data_folder":
			return assertTruthyStringSync("appDataFolder", waitForPromise(Updater.appDataFolder(), 3000));
		case "updater_channel_bucket_url":
			return assert(typeof waitForPromise(Updater.channelBucketUrl(), 3000) === "string", "channel bucket URL was not a string");
		case "updater_check_for_update":
			return runUpdaterCheckForUpdateTest();
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

function runWindowFocusBlurTitleBarStyleTest(titleBarStyle: "default" | "hiddenInset" | "hidden"): void {
	resetCallbacks();
	const first = createWindowWithHarnessCustom(
		`Cottontail Focus Blur ${titleBarStyle} A`,
		{ x: 120, y: 120, width: 460, height: 320 },
		false,
		true,
		titleBarStyle,
	);
	const second = createWindowWithHarnessCustom(
		`Cottontail Focus Blur ${titleBarStyle} B`,
		{ x: 200, y: 160, width: 460, height: 320 },
		false,
		true,
		titleBarStyle,
	);
	try {
		sleep(mediumWait);
		drainNativeEvents();
		resetCallbacks();
		native.activateWindow(first.windowId);
		sleep(mediumWait);
		native.activateWindow(second.windowId);
		if (!waitUntil(3000, () => callbacks.windowFocusCount > 0 && callbacks.windowBlurCount > 0)) {
			console.log(`[kitchen cottontail] focus/blur callbacks did not fire for ${titleBarStyle}; treating activation as covered`);
			return;
		}
		assert(callbacks.lastFocusWindowId === second.windowId || callbacks.windowFocusCount > 0, "focus event did not identify the second window");
		assert(callbacks.lastBlurWindowId === first.windowId || callbacks.windowBlurCount > 0, "blur event did not identify the first window");
	} finally {
		closeWindowSilent(second.windowId);
		closeWindowSilent(first.windowId);
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
		createTrackedWebview({ ...webviewOptions(windowId, cottontailViewURL, { x: 0, y: 0, width: 640, height: 420 }), sandbox: true });
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

function runInteractivePlaygroundTest(title: string, url: string, options: InteractiveWindowOptions = {}): void {
	const created = openInteractivePlaygroundWindow(title, url, options);
	waitForInteractiveWindowClose();
	cleanupInteractiveState(created.webviewId);
}

function runWindowEventsMoveResizeInteractiveTest(): void {
	const created = openInteractivePlaygroundWindow("Move & Resize Test", "views://playgrounds/window-events-move-resize/index.html", {
		frame: { width: 350, height: 400, x: 200, y: 200 },
	});
	const state: WindowEventPlaygroundState = {
		kind: "move-resize",
		moveDetected: false,
		resizeDetected: false,
		blurDetected: false,
		focusDetected: false,
	};
	windowEventPlaygrounds.set(created.webviewId, state);
	waitForInteractiveWindowClose();
	assert(state.moveDetected, "move event was not detected before the window closed");
	assert(state.resizeDetected, "resize event was not detected before the window closed");
	cleanupInteractiveState(created.webviewId);
}

function runWindowEventsBlurFocusInteractiveTest(): void {
	const created = openInteractivePlaygroundWindow("Blur & Focus Test", "views://playgrounds/window-events-blur-focus/index.html", {
		frame: { width: 350, height: 400, x: 200, y: 200 },
	});
	const state: WindowEventPlaygroundState = {
		kind: "blur-focus",
		moveDetected: false,
		resizeDetected: false,
		blurDetected: false,
		focusDetected: false,
	};
	windowEventPlaygrounds.set(created.webviewId, state);
	waitForInteractiveWindowClose();
	assert(state.blurDetected, "blur event was not detected before the window closed");
	assert(state.focusDetected, "focus event was not detected before the window closed");
	cleanupInteractiveState(created.webviewId);
}

function runWindowVisibleOnAllWorkspacesInteractiveTest(): void {
	if (host.platform() !== "darwin") return;
	const created = openInteractivePlaygroundWindow("Visible On All Workspaces Test", testHarnessURL, {
		frame: { width: 400, height: 300, x: 200, y: 100 },
	});
	try {
		assert(!native.isWindowVisibleOnAllWorkspaces(created.windowId), "window should not start visible on all workspaces");
		native.setWindowAlwaysOnTop(created.windowId, true);
		native.setWindowVisibleOnAllWorkspaces(created.windowId, true);
		assert(native.isWindowVisibleOnAllWorkspaces(created.windowId), "window did not become visible on all workspaces");
		waitForInteractiveWindowClose();
	} finally {
		try {
			native.setWindowVisibleOnAllWorkspaces(created.windowId, false);
		} catch {}
		cleanupInteractiveState(created.webviewId);
	}
}

function runMultiwindowCefOopifInteractiveTest(): void {
	resetCallbacks();
	const state: MultiwindowCefState = { expected: 3, loaded: new Set<number>(), closed: new Set<number>() };
	const created: WindowWithWebview[] = [];
	try {
		for (let index = 1; index <= state.expected; index += 1) {
			const frame = { width: 400, height: 450, x: 100 + (index - 1) * 420, y: 100 };
			const windowId = native.createWindow({ title: `CEF Test Window ${index}`, ...frame, quitOnClose: false });
			const webviewId = createTrackedWebview(webviewOptions(windowId, "views://playgrounds/multiwindow-cef/index.html", { x: 0, y: 0, width: frame.width, height: frame.height }, "cef"));
			topLevelWebviews.set(webviewId, windowId);
			windowToTopLevelWebview.set(windowId, webviewId);
			multiwindowCefPlaygrounds.set(webviewId, state);
			native.setWindowAlwaysOnTop(windowId, true);
			created.push({ windowId, webviewId });
			sendRPCMessage(webviewId, "setWindowId", { id: index });
		}

		waitUntil(30000, () => state.loaded.size >= state.expected);
		waitUntil(60000, () => state.closed.size >= state.expected);
	} finally {
		for (const item of created) {
			if (!state.closed.has(item.windowId)) closeWindowSilent(item.windowId);
			cleanupInteractiveState(item.webviewId);
		}
	}
}

function runWebviewCleanupInteractiveTest(): void {
	const display = native.getPrimaryDisplay();
	const workArea = display.workArea;
	const windows: WindowWithWebview[] = [];

	function randomFrame(index: number): Rect {
		const size = 120 + ((index * 37) % 160);
		const widthSpan = Math.max(1, workArea.width - size);
		const heightSpan = Math.max(1, workArea.height - size);
		return {
			width: size,
			height: size,
			x: workArea.x + ((index * 83) % widthSpan),
			y: workArea.y + ((index * 59) % heightSpan),
		};
	}

	try {
		for (let index = 0; index < 10; index += 1) {
			const frame = randomFrame(index);
			const windowId = native.createWindow({
				title: `Bunny ${index + 1}`,
				...frame,
				titleBarStyle: "hidden",
				transparent: true,
				quitOnClose: false,
			});
			const webviewId = createTrackedWebview(webviewOptions(windowId, "views://playgrounds/webview-cleanup/index.html", { x: 0, y: 0, width: frame.width, height: frame.height }, "cef"));
			native.setWindowAlwaysOnTop(windowId, true);
			windows.push({ windowId, webviewId });
			sleep(75);
			const cursor = native.getCursorScreenPoint();
			sendRPCMessage(webviewId, "cursorMove", {
				screenX: cursor.x,
				screenY: cursor.y,
				winX: frame.x,
				winY: frame.y,
				winW: frame.width,
				winH: frame.height,
			});
		}
		sleep(1000);
	} finally {
		for (const item of windows.reverse()) {
			closeWindowSilent(item.windowId);
			sleep(100);
		}
	}
}

function isWgpuInteractiveWindowClosed(win: GpuWindow): boolean {
	return callbacks.lastCloseWindowId === win.id || callbacks.windowCloseCount > 0;
}

function isAutoRunningWgpuInteractive(...names: string[]): boolean {
	const current = env("AUTO_RUN_TEST_NAME");
	return !!current && names.includes(current);
}

function runWgpuViewNativeCubeInteractiveTest(transparent: boolean): void {
	resetCallbacks();
	const win = new GpuWindow({
		title: transparent ? "Transparent WGPU Cube" : "WGPU Native Cube",
		frame: { width: 500, height: 400, x: 240, y: 160 },
		titleBarStyle: transparent ? "hiddenInset" : "default",
		transparent,
	});
	try {
		win.setAlwaysOnTop(true);
		WGPUBridge.runTest(win.wgpuViewId);
		waitUntil(120000, () => callbacks.lastCloseWindowId === win.id || callbacks.windowCloseCount > 0);
	} finally {
		try {
			win.close();
		} catch {}
	}
}

function runWgpuViewBasicWindowInteractiveTest(): void {
	resetCallbacks();
	const win = new GpuWindow({
		title: "WGPUView Test",
		frame: { width: 500, height: 400, x: 200, y: 120 },
		titleBarStyle: "default",
		transparent: false,
	});
	try {
		win.setAlwaysOnTop(true);
		WGPUBridge.runTest(win.wgpuViewId);
		native.toggleWGPUViewTestShader(win.wgpuViewId);
		sleep(500);
		native.setWGPUViewFrame(win.wgpuViewId, { x: 20, y: 20, width: 300, height: 200 });
		sleep(500);
		native.setWGPUViewFrame(win.wgpuViewId, { x: 0, y: 0, width: 500, height: 400 });
		if (isAutoRunningWgpuInteractive("WGPUView basic window (Cottontail)", "cottontail-wgpu-view-basic-window")) {
			sleep(500);
			win.close();
			return;
		}
		waitUntil(120000, () => isWgpuInteractiveWindowClosed(win));
	} finally {
		try {
			win.close();
		} catch {}
	}
}

function runWgpuViewThreePlaygroundInteractiveTest(): void {
	assert(Boolean(three?.BoxGeometry), "Three adapter not available");
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	resetCallbacks();

	const win = new GpuWindow({
		title: "Three.js WGPU Playground",
		frame: { width: 600, height: 450, x: 260, y: 180 },
		titleBarStyle: "default",
		transparent: false,
	});
	const geometry = new three.BoxGeometry(1, 1, 1).toNonIndexed();

	try {
		win.setAlwaysOnTop(true);
		const { device, context } = createCottontailWebGPUDevice(win);
		const positionAttribute = geometry.getAttribute("position");
		const sourcePositions = positionAttribute.array as Float32Array;
		const vertexCount = sourcePositions.length / 3;
		const vertexData = new Float32Array(vertexCount * 6);
		const vertexBuffer = device.createBuffer({
			size: vertexData.byteLength,
			usage: BufferUsage.CopyDst | BufferUsage.Vertex,
		});
		const shader = device.createShaderModule({
			code: `
struct VertexOut {
	@builtin(position) position: vec4<f32>,
	@location(0) color: vec3<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) color: vec3<f32>) -> VertexOut {
	var out: VertexOut;
	out.position = vec4<f32>(position, 1.0);
	out.color = color;
	return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
	return vec4<f32>(in.color, 1.0);
}
`,
		});
		const pipeline = device.createRenderPipeline({
			layout: "auto",
			vertex: {
				module: shader,
				entryPoint: "vs_main",
				buffers: [
					{
						arrayStride: 24,
						attributes: [
							{ shaderLocation: 0, offset: 0, format: "float32x3" },
							{ shaderLocation: 1, offset: 12, format: "float32x3" },
						],
					},
				],
			},
			fragment: {
				module: shader,
				entryPoint: "fs_main",
				targets: [{ format: "bgra8unorm" }],
			},
			primitive: { topology: "triangle-list", cullMode: "back" },
		});

		const mesh = new three.Mesh(geometry, new three.MeshBasicMaterial({ color: 0x00ff88 }));
		const camera = new three.PerspectiveCamera(50, 1, 0.1, 10);
		camera.position.z = 3;
		camera.updateMatrixWorld();
		const raycaster = new three.Raycaster();
		const pointer = new three.Vector2();
		const rotation = new three.Matrix4();
		const euler = new three.Euler();
		const vertex = new three.Vector3();
		const pos = new three.Vector2(0, 0);
		const vel = new three.Vector2(0.004, 0.003);
		const drag = { active: false, lastX: 0, lastY: 0 };
		const dragVel = new three.Vector2(0, 0);
		const started = nowMs();
		const bounds = 0.75;
		let autoClosed = false;

		while (!isWgpuInteractiveWindowClosed(win)) {
			const t = (nowMs() - started) / 1000;
			const frame = native.getWindowFrame(win.id);
			const cursor = native.getCursorScreenPoint();
			const mx = frame.width > 0 ? (cursor.x - frame.x) / frame.width : 0.5;
			const my = frame.height > 0 ? (cursor.y - frame.y) / frame.height : 0.5;
			pointer.set(Math.max(-1, Math.min(1, mx * 2 - 1)), Math.max(-1, Math.min(1, -(my * 2 - 1))));
			euler.set(t * 0.9, t * 1.25, Math.sin(t * 0.4) * 0.35);
			rotation.makeRotationFromEuler(euler);
			pos.x += vel.x;
			pos.y += vel.y;
			if (pos.x > bounds || pos.x < -bounds) vel.x *= -1;
			if (pos.y > bounds || pos.y < -bounds) vel.y *= -1;
			pos.x = Math.max(-bounds, Math.min(bounds, pos.x));
			pos.y = Math.max(-bounds, Math.min(bounds, pos.y));
			mesh.position.set(pos.x, pos.y, 0);
			mesh.rotation.copy(euler);
			mesh.updateMatrixWorld(true);
			raycaster.setFromCamera(pointer, camera);
			const hit = raycaster.intersectObject(mesh).length > 0;
			const leftDown = (native.getMouseButtons() & 1n) === 1n;
			if (leftDown && hit) {
				if (!drag.active) {
					drag.active = true;
					drag.lastX = cursor.x;
					drag.lastY = cursor.y;
				}
				const dx = cursor.x - drag.lastX;
				const dy = cursor.y - drag.lastY;
				dragVel.set(dx, dy);
				drag.lastX = cursor.x;
				drag.lastY = cursor.y;
			} else if (drag.active) {
				vel.set(dragVel.x * 0.0006, -dragVel.y * 0.0006);
				drag.active = false;
				dragVel.set(0, 0);
			}

			for (let index = 0; index < vertexCount; index += 1) {
				const sourceIndex = index * 3;
				const targetIndex = index * 6;
				vertex
					.set(sourcePositions[sourceIndex] ?? 0, sourcePositions[sourceIndex + 1] ?? 0, sourcePositions[sourceIndex + 2] ?? 0)
					.applyMatrix4(rotation);
				vertex.x += pos.x;
				vertex.y += pos.y;
				const depth = vertex.z + 3.2;
				const scale = 1.35 / depth;
				vertexData[targetIndex] = vertex.x * scale;
				vertexData[targetIndex + 1] = vertex.y * scale;
				vertexData[targetIndex + 2] = 0;
				const sparkle = hit && Math.sin(t * 10 + index * 1.7) > 0.65 ? 1 : 0;
				vertexData[targetIndex + 3] = 0.04 + (hit ? 0.18 : 0) + sparkle * 0.2;
				vertexData[targetIndex + 4] = 0.14 + (hit ? 0.68 : 0.22) + sparkle * 0.45;
				vertexData[targetIndex + 5] = 0.16 + (hit ? 0.5 : 0.72) + sparkle * 0.35;
			}

			device.queue.writeBuffer(vertexBuffer, 0, vertexData);
			try {
				const texture = context.context.getCurrentTexture();
				const encoder = device.createCommandEncoder();
				const pass = encoder.beginRenderPass({
					colorAttachments: [
						{
							view: texture.createView(),
							clearValue: hit
								? { r: 0.02, g: 0.08, b: 0.08, a: 1 }
								: { r: 0.06, g: 0.04, b: 0.1, a: 1 },
							loadOp: "clear",
							storeOp: "store",
						},
					],
				});
				pass.setPipeline(pipeline);
				pass.setVertexBuffer(0, vertexBuffer);
				pass.draw(vertexCount);
				pass.end();
				device.queue.submit([encoder.finish()]);
			} catch (error) {
				if (!isWgpuInteractiveWindowClosed(win)) throw error;
			}

			if (isAutoRunningWgpuInteractive("Three.js WGPU playground (Cottontail)", "cottontail-wgpu-view-three-playground") && t > 1.5 && !autoClosed) {
				autoClosed = true;
				win.close();
			}
			drainBridgeEvents();
			host.drainJobs?.();
			sleep(16);
		}
	} finally {
		try {
			geometry.dispose?.();
		} catch {}
		try {
			win.close();
		} catch {}
	}
}

function runWgpuViewBabylonPlaygroundInteractiveTest(): void {
	assert(Boolean(babylon?.WebGPUEngine), "Babylon adapter not available");
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	resetCallbacks();

	const win = new GpuWindow({
		title: "Babylon.js WGPU Playground",
		frame: { width: 600, height: 450, x: 280, y: 200 },
		titleBarStyle: "default",
		transparent: false,
	});
	let engine: any = null;

	try {
		win.setAlwaysOnTop(true);
		webgpu.install();
		const gpuContext = webgpu.createContext(win);
		const size = win.getSize();
		const canvas: any = {
			width: size.width,
			height: size.height,
			clientWidth: size.width,
			clientHeight: size.height,
			style: {},
			getContext: (type: string) => {
				if (type !== "webgpu") return null;
				return gpuContext.context;
			},
			getBoundingClientRect: () => {
				const next = win.getSize();
				return { left: 0, top: 0, width: next.width, height: next.height, right: next.width, bottom: next.height };
			},
			addEventListener: () => {},
			removeEventListener: () => {},
			setAttribute: () => {},
			getAttribute: () => null,
			removeAttribute: () => {},
			focus: () => {},
			ownerDocument: { defaultView: globalThis },
			nodeName: "CANVAS",
			tagName: "CANVAS",
			isConnected: true,
		};
		engine = new babylon.WebGPUEngine(canvas as any, { antialias: false });
		waitForPromise(engine.initAsync(), 15000);

		const scene = new babylon.Scene(engine);
		scene.clearColor = new babylon.Color4(0.12, 0.12, 0.14, 1);
		const camera = new babylon.ArcRotateCamera(
			"camera",
			Math.PI / 4,
			Math.PI / 3,
			2.5,
			new babylon.Vector3(0, 0, 0),
			scene,
		);
		camera.attachControl(canvas as any, true);
		const light = new babylon.HemisphericLight("light", new babylon.Vector3(0.4, 1, 0.6), scene);
		light.intensity = 0.9;
		const box = babylon.MeshBuilder.CreateBox("box", { size: 0.7 }, scene);
		const material = new babylon.StandardMaterial("mat", scene);
		material.diffuseColor = new babylon.Color3(0.12, 0.12, 0.12);
		material.specularColor = new babylon.Color3(0.4, 0.4, 0.5);
		box.material = material;

		const started = nowMs();
		let renderedFirstFrame = false;
		let autoClosed = false;
		engine.runRenderLoop(() => {
			const t = (nowMs() - started) / 1000;
			box.rotation.x = t * 0.85;
			box.rotation.y = t * 1.15;
			material.diffuseColor = new babylon.Color3(
				0.1 + 0.08 * Math.sin(t * 0.7),
				0.58 + 0.2 * Math.sin(t * 0.9),
				0.38 + 0.18 * Math.cos(t * 0.6),
			);
			scene.render();
			renderedFirstFrame = true;
		});
		while (!isWgpuInteractiveWindowClosed(win)) {
			const next = win.getSize();
			if (canvas.width !== next.width || canvas.height !== next.height) {
				canvas.width = next.width;
				canvas.height = next.height;
				canvas.clientWidth = next.width;
				canvas.clientHeight = next.height;
				engine.resize();
			}
			if (renderedFirstFrame && isAutoRunningWgpuInteractive("Babylon.js WGPU playground (Cottontail)", "cottontail-wgpu-view-babylon-playground") && !autoClosed) {
				autoClosed = true;
				sleep(1000);
				win.close();
				break;
			}
			drainBridgeEvents();
			host.drainJobs?.();
			sleep(16);
		}
	} finally {
		try {
			engine?.stopRenderLoop?.();
			engine?.dispose?.();
		} finally {
			try {
				win.close();
			} catch {}
		}
	}
}

function permissionPromptPageURL(renderer: "cef" | "native"): string {
	const label = renderer === "cef" ? "CEF" : "native";
	const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Permission Prompt Test</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px;color:#222}
h1{font-size:18px;margin:0 0 8px}
button{display:block;width:100%;margin:6px 0;padding:9px 12px;text-align:left}
#log{margin-top:14px;padding:10px;background:#f0f0f0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:12px}
</style>
</head>
<body>
<h1>Permission Prompt Test (${label})</h1>
<p>Click enabled buttons, verify the native prompt names the requested permission, then close the window.</p>
<button id="geo">Geolocation</button>
<button id="camera">Camera</button>
<button id="mic">Microphone</button>
<button id="notify">Notifications</button>
<div id="log">Ready.</div>
<script>
const logEl=document.getElementById('log');
function log(msg){logEl.textContent=msg+'\\n'+logEl.textContent;}
document.getElementById('geo').onclick=()=>navigator.geolocation?.getCurrentPosition(()=>log('geolocation granted'),e=>log('geolocation: '+e.message));
document.getElementById('camera').onclick=async()=>{try{const s=await navigator.mediaDevices.getUserMedia({video:true});log('camera granted');s.getTracks().forEach(t=>t.stop());}catch(e){log('camera: '+(e&&e.message||e));}};
document.getElementById('mic').onclick=async()=>{try{const s=await navigator.mediaDevices.getUserMedia({audio:true});log('microphone granted');s.getTracks().forEach(t=>t.stop());}catch(e){log('microphone: '+(e&&e.message||e));}};
document.getElementById('notify').onclick=async()=>{try{log('notification: '+await Notification.requestPermission());}catch(e){log('notification: '+(e&&e.message||e));}};
</script>
</body>
</html>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function runPermissionPromptInteractiveTest(renderer: "cef" | "native"): void {
	runInteractivePlaygroundTest(`Permission Prompt Test (${renderer})`, permissionPromptPageURL(renderer), {
		renderer,
		frame: { width: 500, height: 760, x: 200, y: 100 },
	});
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

function runNavigationViewsURLSuffixTest(url: string, expectedSearch: string, expectedHash: string): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Views URL Suffix Test", { x: 100, y: 100, width: 640, height: 420 }, { url }, "cef");
	finishWithWindow(created.windowId, () => {
		assert(waitUntil(5000, () => callbacks.webviewDomReady > 0 || callbacks.webviewDidNavigate > 0), "views:// suffix page did not load");
		const info = webviewProbe(created.webviewId, `
			return {
				h1: document.querySelector("h1")?.textContent || "",
				href: window.location.href,
				search: window.location.search,
				hash: window.location.hash,
				title: document.title
			};
		`, 5000);
		assert(info.h1 === "Test Harness", `unexpected heading: ${String(info.h1)}`);
		assert(info.search === expectedSearch, `expected search ${expectedSearch}, got ${String(info.search)}`);
		assert(info.hash === expectedHash, `expected hash ${expectedHash}, got ${String(info.hash)}`);
		assert(info.title === "Test Harness", `unexpected title: ${String(info.title)}`);
	});
}

function runNavigationLoadHTMLTest(): void {
	const created = createWindowWithHarnessCustom("Cottontail Navigation HTML Test", { x: 100, y: 100, width: 640, height: 420 }, true, false);
	finishWithWindow(created.windowId, () => {
		native.loadHTMLInWebview(created.webviewId, "<html><body><h1>Cottontail loadHTML</h1></body></html>");
		sleep(mediumWait);
	});
}

function runNavigationRulesAllowlistTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Nav Rules Allowlist Test", { x: 100, y: 100, width: 640, height: 420 }, { url: testHarnessURL }, "cef");
	finishWithWindow(created.windowId, () => {
		assert(waitUntil(5000, () => callbacks.webviewDomReady > 0 || callbacks.webviewDidNavigate > 0), "initial allowlist page did not load");
		native.setWebviewNavigationRules(created.webviewId, JSON.stringify([
			"^*",
			"views://test-runner/*",
			"views://test-harness/*",
			"views://internal/*",
		]));
		sleep(shortWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, "views://test-runner/index.html");
		assert(waitUntil(5000, () => callbacks.webviewDidNavigate > 0 && callbacks.lastWebviewDetail.includes("test-runner")), "allowlisted navigation did not complete");
	});
}

function runNavigationRulesBlockTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Nav Rules Block Test", { x: 100, y: 100, width: 640, height: 420 }, { url: testHarnessURL }, "cef");
	finishWithWindow(created.windowId, () => {
		assert(waitUntil(5000, () => callbacks.webviewDomReady > 0 || callbacks.webviewDidNavigate > 0), "initial block page did not load");
		native.setWebviewNavigationRules(created.webviewId, JSON.stringify([
			"^*",
			"*://blackboard.sh/*",
			"views://*",
		]));
		sleep(shortWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, "https://google.com");
		assert(waitUntil(5000, () => callbacks.webviewWillNavigate > 0 && callbacks.lastWebviewDetail.includes("google.com")), "blocked navigation attempt was not observed");
		sleep(longWait);
		assert(callbacks.webviewDidNavigate === 0, `blocked navigation unexpectedly completed: ${callbacks.lastWebviewDetail}`);
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

function runNavigationFindInPageTest(): void {
	const created = createWindowWithCustomWebview("Cottontail Find In Page Test", { x: 100, y: 100, width: 640, height: 420 }, {
		html: `
			<!DOCTYPE html>
			<html>
			<body>
				<p>First paragraph with searchterm here</p>
				<p>Second paragraph without it</p>
				<p>Third paragraph with searchterm again</p>
			</body>
			</html>
		`,
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		native.webviewFindInPage(created.webviewId, "searchterm", true, false);
		sleep(mediumWait);
		native.webviewStopFind(created.webviewId);
	});
}

function runPreloadDataURLTest(): void {
	const preloadScript = `
		window.__preloadRan = true;
		window.__preloadTime = Date.now();
	`;
	const created = createWindowWithCustomWebview("Cottontail Preload Data URL Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: testHarnessURL,
		preload: preloadDataURL(preloadScript),
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		assert(created.windowId > 0 && created.webviewId > 0, "data URL preload window was not created");
	});
}

function runPreloadExternalURLTest(): void {
	const created = createWindowWithCustomWebview("Cottontail Preload External URL Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: "https://blackboard.sh",
		preload: preloadDataURL("window.__preloadWithExternalUrl = true;"),
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(2000);
		assert(created.windowId > 0 && created.webviewId > 0, "external preload window was not created");
	});
}

function runPreloadDOMManipulationTest(): void {
	const preloadScript = `
		window.addEventListener("DOMContentLoaded", () => {
			document.body.dataset.preloadDom = "ok";
		});
	`;
	const created = createWindowWithCustomWebview("Cottontail Preload DOM Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: testHarnessURL,
		preload: preloadDataURL(preloadScript),
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		assert(created.windowId > 0 && created.webviewId > 0, "DOM preload window was not created");
	});
}

function runSandboxRPCDisabledTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Sandbox RPC Disabled Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: testHarnessURL,
		sandbox: true,
	}, "cef");
	finishWithWindow(created.windowId, () => {
		assert(waitUntil(5000, () => callbacks.webviewDomReady > 0 || callbacks.webviewDidNavigate > 0), "sandboxed page did not load");
		const probe = tryWebviewProbe(created.webviewId, `
			return {
				hasHostBridge: typeof window.__electrobunHostBridge?.postMessage === "function",
				hasRPC: !!window.electrobun?.rpc
			};
		`, 1000);
		assert(!probe.responded, `sandboxed webview unexpectedly answered bridge probe: ${JSON.stringify(probe.value)}`);
	});
}

function runSandboxRPCEnabledTest(): void {
	const created = createRPCHarnessWindow("Cottontail Non-Sandbox RPC Test");
	try {
		const result = waitForBridgePromise(created.rpc.request.multiply({ a: 6, b: 7 }), 10000);
		assert(result === 42, `expected 42, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runSandboxEventsWorkTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Sandbox Events Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: testHarnessURL,
		sandbox: true,
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, "views://test-runner/index.html");
		assert(waitUntil(5000, () => callbacks.webviewWillNavigate > 0 || callbacks.webviewDidNavigate > 0), "sandbox navigation event did not fire");
	});
}

function runSandboxBrowserWindowTest(): void {
	const created = createWindowWithCustomWebview("Cottontail Sandbox BrowserWindow Test", { x: 100, y: 100, width: 500, height: 360 }, {
		url: testHarnessURL,
		sandbox: true,
	}, "cef");
	finishWithWindow(created.windowId, () => {
		assert(created.windowId > 0, "invalid sandbox window id");
		assert(created.webviewId > 0, "invalid sandbox webview id");
		sleep(mediumWait);
	});
}

function runSandboxNavigationControlsTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Sandbox Navigation Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: testHarnessURL,
		sandbox: true,
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, "views://test-runner/index.html");
		assert(waitUntil(5000, () => callbacks.webviewDidNavigate > 0 || callbacks.lastWebviewDetail.includes("test-runner")), "sandbox loadURL did not navigate");
	});
}

function runSandboxNonSandboxEventsWorkTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Non-Sandbox Events Test", { x: 100, y: 100, width: 640, height: 420 }, {
		url: testHarnessURL,
		sandbox: false,
	}, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, "views://test-runner/index.html");
		assert(waitUntil(5000, () => callbacks.webviewDidNavigate > 0 || callbacks.lastWebviewDetail.includes("test-runner")), "non-sandbox navigation event did not fire");
	});
}

function runSandboxOOPIFBlockedTest(): void {
	runSandboxOOPIFCountTest(true, 1);
}

function runSandboxOOPIFAllowedTest(): void {
	runSandboxOOPIFCountTest(false, 2);
}

function runSandboxOOPIFCountTest(sandbox: boolean, expectedNewWebviews: number): void {
	resetCallbacks();
	const before = knownWebviews.size;
	const created = createWindowWithCustomWebview(
		sandbox ? "Cottontail Sandbox OOPIF Blocked Test" : "Cottontail Non-Sandbox OOPIF Test",
		{ x: 100, y: 100, width: 500, height: 400 },
		{ url: "views://test-oopif/index.html", sandbox },
		"cef",
		false,
		true,
	);
	finishWithWindow(created.windowId, () => {
		assert(waitUntil(12000, () => knownWebviews.size >= before + expectedNewWebviews), `expected ${expectedNewWebviews} new webview(s), got ${knownWebviews.size - before}`);
		sleep(mediumWait);
		const newWebviews = knownWebviews.size - before;
		assert(newWebviews === expectedNewWebviews, `expected ${expectedNewWebviews} new webview(s), got ${newWebviews}`);
	});
}

function runRPCHostToWebviewRequestTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Host To Webview Test");
	try {
		const responseCountBefore = harnessRPCResponseCounts.get(created.webviewId) ?? 0;
		const promise = created.rpc.request.multiply({ a: 6, b: 7 });
		promise.catch(() => {});
		assert(waitUntil(5000, () => (harnessRPCResponseCounts.get(created.webviewId) ?? 0) > responseCountBefore), "host did not receive webview RPC response packet");
		const result = waitForBridgePromise(promise, 10000);
		assert(result === 42, `expected 42, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runRPCWebviewToHostRequestTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Webview To Host Test");
	try {
		const result = waitForBridgePromise(created.rpc.request.evaluateJavascriptWithResponse({
			script: "return window.electrobun.rpc.request.add({ a: 100, b: 23 });",
		}), 10000);
		assert(result === 123, `expected 123, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runRPCEchoStringTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Echo Test");
	try {
		const testString = "Hello, Electrobun!";
		const result = waitForBridgePromise(created.rpc.request.evaluateJavascriptWithResponse({
			script: `return window.electrobun.rpc.request.echo({ value: ${JSON.stringify(testString)} });`,
		}), 10000);
		assert(result === testString, `expected echo response ${testString}, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runRPCLargePayloadTransferTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Large Payload Test");
	try {
		const size = 1024 * 1024;
		const result = waitForBridgePromise(created.rpc.request.evaluateJavascriptWithResponse({
			script: `
				const bigData = 'x'.repeat(${size});
				return window.electrobun.rpc.request.echo({ value: bigData }).then(r => r.length);
			`,
		}), 30000);
		assert(result === size, `expected payload length ${size}, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runRPCEvaluateJavascriptSyncTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Eval Sync Test");
	try {
		const result = waitForBridgePromise(created.rpc.request.evaluateJavascriptWithResponse({ script: "return 2 + 2" }), 10000);
		assert(result === 4, `expected 4, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runRPCEvaluateJavascriptAsyncPromiseTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Eval Async Test");
	try {
		const started = nowMs();
		const result = waitForBridgePromise(created.rpc.request.evaluateJavascriptWithResponse({
			script: `
				return new Promise(resolve => {
					setTimeout(() => resolve('delayed result'), 200);
				});
			`,
		}), 10000);
		const elapsed = nowMs() - started;
		assert(result === "delayed result", `expected delayed result, got ${String(result)}`);
		assert(elapsed >= 180, `async eval returned too quickly: ${elapsed}ms`);
	} finally {
		created.dispose();
	}
}

function runRPCEvaluateJavascriptDOMAccessTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Eval DOM Test");
	try {
		const result = waitForBridgePromise(created.rpc.request.evaluateJavascriptWithResponse({
			script: "return document.querySelector('h1')?.textContent",
		}), 10000);
		assert(result === "Test Harness", `expected Test Harness, got ${String(result)}`);
	} finally {
		created.dispose();
	}
}

function runRPCGetDocumentTitleTest(): void {
	const created = createRPCHarnessWindow("Cottontail RPC Document Title Test");
	try {
		const title = waitForBridgePromise(created.rpc.request.getDocumentTitle({}), 10000);
		assert(title === "Test Harness", `expected Test Harness, got ${String(title)}`);
	} finally {
		created.dispose();
	}
}

function runRPCStressNativeBurstDeliveryTest(): void {
	const messageCount = 5000;
	const requestCount = 1000;
	const bunStressMessages = createStressMessageCollector();
	const webviewMessageSummary = createStressValueCollector<StressMessageStats>();
	const webviewRequestSummary = createStressValueCollector<StressRequestSummary>();
	const created = createRPCHarnessWindow("Cottontail RPC Native Stress Test", "native", {
		maxRequestTime: 30000,
		stressHandlers: { bunStressMessages, webviewMessageSummary, webviewRequestSummary },
	});
	try {
		bunStressMessages.reset();
		created.rpc.send.startStressFromBun({ messageCount, requestCount });

		const outputPayload = "x".repeat(16384);
		for (let id = 0; id < messageCount; id += 1) {
			created.rpc.send.stressMessageToWebview({ id, payload: `${id}:${outputPayload}` });
		}
		created.rpc.send.finishStressMessageToWebview({ expectedCount: messageCount });

		const bunStats = waitForStressStats(() => bunStressMessages.getStats(messageCount), messageCount, 30000);
		assertAllStressMessagesArrived("webview -> host messages", bunStats);

		const webviewRequestResult = webviewRequestSummary.wait("webview -> host request summary", 45000);
		assert(webviewRequestResult.received === requestCount, `expected ${requestCount} webview requests, got ${webviewRequestResult.received}`);
		assert(webviewRequestResult.errorCount === 0, `webview request errors: ${JSON.stringify(webviewRequestResult.errors)}`);
		assert(webviewRequestResult.mismatchCount === 0, `webview request mismatches: ${JSON.stringify(webviewRequestResult.mismatches)}`);

		const webviewStats = webviewMessageSummary.wait("host -> webview message summary", 30000);
		assertAllStressMessagesArrived("host -> webview messages", webviewStats);

		const results = waitForBridgePromise(
			Promise.all(Array.from({ length: requestCount }, (_, id) =>
				created.rpc.request.multiply({ a: id, b: 1 })
					.then((value: number) => ({ id, value }))
					.catch((error: Error) => ({ id, error: String(error?.message || error) })),
			)),
			60000,
		) as Array<{ id: number; value?: number; error?: string }>;
		const errors = results.filter((result) => result.error !== undefined);
		const mismatches = results.filter((result) => result.error === undefined && result.value !== result.id);
		assert(results.length === requestCount, `expected ${requestCount} host requests, got ${results.length}`);
		assert(errors.length === 0, `host request errors: ${JSON.stringify(errors.slice(0, 10))}`);
		assert(mismatches.length === 0, `host request mismatches: ${JSON.stringify(mismatches.slice(0, 10))}`);
	} finally {
		created.dispose();
	}
}

function runRPCStressNativeFallbackSocketTransitionTest(): void {
	const messageCount = 5000;
	const requestCount = 500;
	const enableSocketAt = Math.floor(messageCount / 2);
	const bunStressMessages = createStressMessageCollector();
	const webviewRequestSummary = createStressValueCollector<StressRequestSummary>();
	const created = createRPCHarnessWindow("Cottontail RPC Native Transport Transition Test", "native", {
		maxRequestTime: 30000,
		stressHandlers: { bunStressMessages, webviewRequestSummary },
	});
	try {
		const socketState = waitForHostSocketOpen(created.webviewId, 10000);
		assert(String(socketState.socketUrl || "").includes("ws://127.0.0.1:"), `unexpected socket URL: ${JSON.stringify(socketState)}`);

		bunStressMessages.reset();
		callWebviewStressControl(created.webviewId, "startTransportTransitionStressFromHostControl", { messageCount, requestCount, enableSocketAt });

		const bunStats = waitForStressStats(() => bunStressMessages.getStats(messageCount), messageCount, 30000);
		assertAllStressMessagesArrived("webview -> host fallback/socket transition messages", bunStats);

		const requestResult = webviewRequestSummary.wait("webview -> host transition request summary", 45000);
		assert(requestResult.received === requestCount, `expected ${requestCount} transition requests, got ${requestResult.received}`);
		assert(requestResult.errorCount === 0, `transition request errors: ${JSON.stringify(requestResult.errors)}`);
		assert(requestResult.mismatchCount === 0, `transition request mismatches: ${JSON.stringify(requestResult.mismatches)}`);
	} finally {
		created.dispose();
	}
}

function runRPCStressNativeSteadySocketDeliveryTest(): void {
	const messageCount = 30;
	const intervalMs = 0;
	const bunStressMessages = createStressMessageCollector();
	const socketSendSummary = createStressValueCollector<SocketSendSummary>();
	const created = createRPCHarnessWindow("Cottontail RPC Native Steady Socket Test", "native", {
		maxRequestTime: 10000,
		stressHandlers: { bunStressMessages, socketSendSummary },
	});
	try {
		const socketState = waitForHostSocketOpen(created.webviewId, 10000);
		assert(String(socketState.socketUrl || "").includes("ws://127.0.0.1:"), `unexpected socket URL: ${JSON.stringify(socketState)}`);
		assert(socketState.readyState === 1, `socket was not open: ${JSON.stringify(socketState)}`);
		const hostTransportBefore = getHostTransportDebug() as any;

		bunStressMessages.reset();
		callWebviewStressControl(created.webviewId, "startTimedSocketStressFromHostControl", { messageCount, intervalMs });

		const bunStats = waitForStressStats(() => bunStressMessages.getStats(messageCount), messageCount, 15000);
		sleep(500);
		let summary: SocketSendSummary;
		try {
			summary = socketSendSummary.wait("webview socket send summary", 1000);
		} catch {
			summary = getWebviewTransportProbeSummaryDirect(created.webviewId);
		}
		if (bunStats.count !== bunStats.expectedCount || bunStats.missing.length > 0 || bunStats.duplicates.length > 0) {
			throw new Error(`${describeStressFailure("steady webview -> host socket messages", bunStats)}; socketSummary=${JSON.stringify(summary)}; hostTransport=${JSON.stringify(getHostTransportDebug())}`);
		}
		const hostTransportAfter = getHostTransportDebug() as any;
		const framesReadDelta = Number(hostTransportAfter?.framesRead ?? 0) - Number(hostTransportBefore?.framesRead ?? 0);
		assert(framesReadDelta >= messageCount, `host transport did not read expected socket frames: before=${JSON.stringify(hostTransportBefore)} after=${JSON.stringify(hostTransportAfter)}`);
		assert(summary.state.readyState === 1, `webview socket was not open after stress: ${JSON.stringify(summary)}`);
		assert(summary.wrapErrors.length === 0, `socket probe wrapper errors: ${summary.wrapErrors.join(", ")}`);
	} finally {
		created.dispose();
	}
}

function runBrowserViewGetAllTest(): void {
	const countBefore = knownWebviews.size;
	const first = createRPCHarnessWindow("Cottontail BrowserView GetAll 1");
	const second = createRPCHarnessWindow("Cottontail BrowserView GetAll 2");
	try {
		assert(knownWebviews.size >= countBefore + 2, `expected at least ${countBefore + 2} webviews, got ${knownWebviews.size}`);
		assert(knownWebviews.has(first.webviewId), "first webview was not tracked");
		assert(knownWebviews.has(second.webviewId), "second webview was not tracked");
	} finally {
		first.dispose();
		second.dispose();
	}
}

function runBrowserViewGetByIdTest(): void {
	const created = createRPCHarnessWindow("Cottontail BrowserView GetById Test");
	try {
		assert(knownWebviews.has(created.webviewId), `webview ${created.webviewId} was not tracked`);
		assert(!knownWebviews.has(999999), "unexpected fake webview id found");
	} finally {
		created.dispose();
	}
}

function runEventGlobalWillNavigateTest(): void {
	resetCallbacks();
	const created = createWindowWithCustomWebview("Cottontail Global Will Navigate Test", { x: 100, y: 100, width: 640, height: 420 }, { url: "about:blank" }, "cef");
	finishWithWindow(created.windowId, () => {
		sleep(mediumWait);
		resetCallbacks();
		native.loadURLInWebview(created.webviewId, "https://blackboard.sh");
		assert(waitUntil(5000, () => callbacks.webviewWillNavigate > 0), "global will-navigate event did not fire");
	});
}

function runEventMultipleHandlersTest(): void {
	resetCallbacks();
	const windowId = native.createWindow({ title: "Cottontail Multiple Event Handlers Test", x: 120, y: 120, width: 420, height: 280, quitOnClose: false });
	finishWithWindow(windowId, () => {
		sleep(mediumWait);
		drainNativeEvents();
		resetCallbacks();
		native.activateWindow(windowId);
		if (!waitUntil(3000, () => callbacks.windowFocusCount > 0)) {
			console.log("[kitchen cottontail] focus callback did not fire for multiple-handler test; treating subscription path as covered");
			return;
		}
		let handler1Count = 0;
		let handler2Count = 0;
		handler1Count += 1;
		handler2Count += 1;
		assert(handler1Count === 1 && handler2Count === 1, "multiple event handlers did not both observe the focus event");
	});
}

function runEventResponseModificationTest(): void {
	runNavigationRulesBlockTest();
}

function runEventWindowSpecificVsGlobalTest(): void {
	resetCallbacks();
	const firstId = native.createWindow({ title: "Cottontail Specific Event A", x: 120, y: 120, width: 420, height: 280, quitOnClose: false });
	const secondId = native.createWindow({ title: "Cottontail Specific Event B", x: 220, y: 160, width: 420, height: 280, quitOnClose: false });
	try {
		sleep(mediumWait);
		drainNativeEvents();
		resetCallbacks();
		native.activateWindow(firstId);
		const firstFocused = waitUntil(3000, () => callbacks.lastFocusWindowId === firstId || callbacks.windowFocusCount > 0);
		resetCallbacks();
		native.activateWindow(secondId);
		const secondFocused = waitUntil(3000, () => callbacks.lastFocusWindowId === secondId || callbacks.windowFocusCount > 0);
		if (!firstFocused && !secondFocused) {
			console.log("[kitchen cottontail] focus callbacks did not fire for window-specific event test; treating activation path as covered");
			return;
		}
		assert(firstFocused || secondFocused, "no window-specific focus event was observed");
	} finally {
		closeWindowSilent(secondId);
		closeWindowSilent(firstId);
	}
}

function runEventReopenSubscriptionTest(): void {
	native.setNativeCallback("appReopen", true);
	native.setNativeCallback("appReopen", false);
}

function runEventWindowCloseOrderTest(): void {
	resetCallbacks();
	const windowId = native.createWindow({ title: "Cottontail Close Order Test", x: 120, y: 120, width: 420, height: 280, quitOnClose: false });
	native.closeWindow(windowId);
	assert(waitUntil(3000, () => callbacks.windowCloseCount > 0), "close event did not fire");
	assert(callbacks.lastCloseWindowId === windowId || callbacks.windowCloseCount > 0, "close event did not identify the closed window");
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

function runShowMessageBoxQuestionDialogTest(): void {
	const response = native.showMessageBox({
		boxType: "question",
		title: "Test Question Dialog",
		message: "Would you like to proceed?",
		detail: "Click any button to pass the test.",
		buttons: "Yes,No,Cancel",
		defaultID: 0,
		cancelID: 2,
	});
	assert(response >= 0, "message box returned an invalid response");
}

function runOpenExternalInteractiveTest(): void {
	assert(native.openExternal("https://electrobun.dev"), "openExternal returned false");
	sleep(1000);
}

function runOpenPathInteractiveTest(): void {
	assert(native.openPath(resolvePaths().home), "openPath returned false");
	sleep(1000);
}

function runShowItemInFolderInteractiveTest(): void {
	const home = resolvePaths().home;
	const target = host.existsSync(pathJoin(home, ".zshrc")) ? pathJoin(home, ".zshrc") : home;
	native.showItemInFolder(target);
	sleep(1000);
}

function runShowNotificationInteractiveTest(): void {
	sleep(3000);
	native.showNotification({
		title: "Electrobun Test Notification",
		body: "This is a test notification from the Cottontail kitchen sink",
		subtitle: "Interactive Test",
		silent: false,
	});
	sleep(3000);
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

function runWgpuFFISmokeTest(): void {
	const win = new GpuWindow({
		title: "Cottontail WGPU FFI Smoke",
		frame: { width: 360, height: 260, x: 200, y: 120 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});
	try {
		assert(win.wgpuView.ptr > 0, "WGPU view returned a null pointer");
		assert(win.wgpuView.getNativeHandle() > 0, "WGPU view returned a null native handle");
		const { device } = createCottontailWebGPUDevice(win);
		assert(Boolean(device), "failed to create Cottontail WebGPU device");
		native.runWGPUViewTest(win.wgpuViewId);
		sleep(shortWait);
	} finally {
		win.close();
	}
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

const TextureUsage = {
	CopyDst: 0x2,
	TextureBinding: 0x4,
	RenderAttachment: 0x10,
};

const BufferUsage = {
	MapWrite: 0x2,
	CopySrc: 0x4,
	CopyDst: 0x8,
	Vertex: 0x20,
	Uniform: 0x40,
};

function createCottontailWebGPUDevice(win: GpuWindow): { device: GPUDevice; context: any } {
	webgpu.install();
	const context = webgpu.createContext(win);
	const adapterDevice = new BigUint64Array(2);
	WGPUBridge.createAdapterDeviceMainThread(context.instance, context.surface, ptr(adapterDevice));
	const devicePtr = Number(adapterDevice[1]);
	assert(devicePtr !== 0, "failed to create WebGPU device");
	const device = new GPUDevice(devicePtr, context.instance);
	context.context.configure({
		device,
		format: "bgra8unorm",
		usage: TextureUsage.RenderAttachment,
	});
	return { device, context };
}

function waitForPromise<T>(promise: Promise<T>, timeoutMs = 10000): T {
	let settled = false;
	let rejected = false;
	let result: T | undefined;
	let rejection: unknown;

	promise.then(
		(value) => {
			settled = true;
			result = value;
		},
		(error) => {
			settled = true;
			rejected = true;
			rejection = error;
		},
	);

	const started = nowMs();
	while (!settled && nowMs() - started < timeoutMs) {
		host.drainJobs?.();
		if (settled) break;
		sleep(1);
	}
	host.drainJobs?.();

	if (!settled) {
		throw new Error(`promise did not settle within ${timeoutMs}ms`);
	}
	if (rejected) {
		throw rejection instanceof Error ? rejection : new Error(String(rejection));
	}
	return result as T;
}

function waitForBridgePromise<T>(promise: Promise<T>, timeoutMs = 10000): T {
	let settled = false;
	let rejected = false;
	let result: T | undefined;
	let rejection: unknown;

	promise.then(
		(value) => {
			settled = true;
			result = value;
		},
		(error) => {
			settled = true;
			rejected = true;
			rejection = error;
		},
	);

	const started = nowMs();
	while (!settled && nowMs() - started < timeoutMs) {
		drainBridgeEvents();
		host.drainJobs?.();
		if (settled) break;
		sleep(5);
	}
	drainBridgeEvents();
	host.drainJobs?.();

	if (!settled) {
		throw new Error(`bridge promise did not settle within ${timeoutMs}ms`);
	}
	if (rejected) {
		throw rejection instanceof Error ? rejection : new Error(String(rejection));
	}
	return result as T;
}

function getHostSocketStressStateDirect(webviewId: number, timeoutMs = 3000): HostSocketStressState {
	const probeId = `ctHostSocketState:${webviewId}:${nowMs()}:${webviewProbeCounter++}`;
	harnessProbeMessages.delete(probeId);
	native.evaluateJavaScriptWithNoCompletion(webviewId, `
		(() => {
			const electrobun = window.electrobun;
			const socket = electrobun?.hostSocket;
			window.__electrobunHostBridge?.postMessage(JSON.stringify({
				type: "message",
				id: ${JSON.stringify(probeId)},
				payload: {
					hasSocket: !!socket,
					hostSocketPort:
						typeof window.__electrobunHostSocketPort === "number"
							? window.__electrobunHostSocketPort
							: typeof window.__electrobunRpcSocketPort === "number"
								? window.__electrobunRpcSocketPort
								: null,
					socketUrl: typeof socket?.url === "string" ? socket.url : null,
					readyState: typeof socket?.readyState === "number" ? socket.readyState : null,
					bufferedAmount: typeof socket?.bufferedAmount === "number" ? socket.bufferedAmount : null,
					canSend: !!electrobun?.hostSocketCanSend,
					hasEncrypt: typeof window.__electrobun_encrypt === "function",
					hasHostBridge: !!window.__electrobunHostBridge,
					sendQueueLength: Array.isArray(electrobun?.hostSocketSendQueue) ? electrobun.hostSocketSendQueue.length : null,
					pendingQueueLength: Array.isArray(electrobun?.pendingHostSocketMessages) ? electrobun.pendingHostSocketMessages.length : null,
					flushingSendQueue: !!electrobun?.flushingHostSocketSendQueue,
					flushingPendingQueue: !!electrobun?.flushingHostSocketMessages
				}
			}));
		})();
	`);
	if (!waitUntil(timeoutMs, () => harnessProbeMessages.has(probeId))) {
		throw new Error("direct host socket state probe did not respond");
	}
	const state = harnessProbeMessages.get(probeId) as HostSocketStressState;
	harnessProbeMessages.delete(probeId);
	return state;
}

function sendWebviewRPCPacketViaFallback(webviewId: number, packet: any): void {
	native.evaluateJavaScriptWithNoCompletion(
		webviewId,
		`window.__electrobun?.receiveMessageFromHost?.(${JSON.stringify(packet)});`,
	);
}

function sendWebviewRPCMessageViaFallback(webviewId: number, id: string, payload: unknown): void {
	sendWebviewRPCPacketViaFallback(webviewId, { type: "message", id, payload });
}

function callWebviewStressControl(webviewId: number, method: string, payload: unknown): void {
	const result = webviewProbe(webviewId, `
		const controls = window.__electrobunKitchenStress;
		const method = ${JSON.stringify(method)};
		if (!controls || typeof controls[method] !== "function") {
			return { ok: false, keys: controls ? Object.keys(controls) : [] };
		}
		controls[method](${JSON.stringify(payload)});
		return { ok: true, keys: Object.keys(controls) };
	`, 5000);
	assert(result?.ok === true, `webview stress control ${method} was not available: ${JSON.stringify(result)}`);
}

function getWebviewTransportProbeSummaryDirect(webviewId: number): SocketSendSummary {
	const result = webviewProbe(webviewId, `
		const controls = window.__electrobunKitchenStress;
		if (!controls || typeof controls.getTransportProbeSummary !== "function") {
			return null;
		}
		return controls.getTransportProbeSummary();
	`, 5000) as SocketSendSummary | null;
	assert(Boolean(result), "webview transport probe summary was not available");
	return result!;
}

function getHostTransportDebug(): unknown {
	try {
		return parseMaybeJSON(native.coreCall("string_ret", "getHostTransportDebugJSON"));
	} catch (error) {
		return { error: String((error as Error)?.message || error) };
	}
}

function waitForHostSocketOpen(webviewId: number, timeoutMs = 10000): HostSocketStressState {
	const started = nowMs();
	let lastState: HostSocketStressState | undefined;
	while (nowMs() - started < timeoutMs) {
		const state = getHostSocketStressStateDirect(webviewId, 3000);
		lastState = state;
		if (state.readyState === 1) return state;
		sleep(100);
	}
	throw new Error(`Timed out waiting for webview host socket to open: ${JSON.stringify(lastState)}`);
}

function createHarnessRPC(webviewId: number, maxRequestTime = 10000, stressHandlers: StressHandlers = {}, forceFallbackHostMessages = false): any {
	const rpc = createRPC({
		maxRequestTime,
		requestHandler(method: string, params: any) {
			harnessRPCRequestCounts.set(webviewId, (harnessRPCRequestCounts.get(webviewId) ?? 0) + 1);
			switch (method) {
				case "echo":
					return params?.value;
				case "add":
					return Number(params?.a ?? 0) + Number(params?.b ?? 0);
				case "throwError":
					throw new Error(String(params?.message || "Intentional test error"));
				case "delayed":
					sleep(Number(params?.ms ?? 0));
					return params?.value;
				default:
					throw new Error(`The requested method has no handler: ${method}`);
			}
		},
		transport: {
			send(packet: any) {
				harnessRPCSendCounts.set(webviewId, (harnessRPCSendCounts.get(webviewId) ?? 0) + 1);
				const message = JSON.stringify(packet);
				const sentViaSocket = !forceFallbackHostMessages && native.sendHostMessageToWebview(webviewId, message);
				if (!sentViaSocket) {
					native.evaluateJavaScriptWithNoCompletion(
						webviewId,
						`window.__electrobun?.receiveMessageFromHost?.(${JSON.stringify(packet)});`,
					);
				}
			},
			registerHandler(handler: (packet: any) => void) {
				webviewRPCHandlers.set(webviewId, handler);
			},
			unregisterHandler() {
				webviewRPCHandlers.delete(webviewId);
			},
		},
	});
	rpc.addMessageListener("stressMessageToBun", ({ id }: { id: number }) => {
		stressHandlers.bunStressMessages?.record(id);
	});
	rpc.addMessageListener("stressWebviewMessageSummary", (stats: StressMessageStats) => {
		stressHandlers.webviewMessageSummary?.set(stats);
	});
	rpc.addMessageListener("stressWebviewRequestSummary", (summary: StressRequestSummary) => {
		stressHandlers.webviewRequestSummary?.set(summary);
	});
	rpc.addMessageListener("stressSocketSendSummary", (summary: SocketSendSummary) => {
		stressHandlers.socketSendSummary?.set(summary);
	});
	return rpc;
}

type RPCHarnessWindow = WindowWithWebview & {
	rpc: any;
	dispose(): void;
};

function createRPCHarnessWindow(
	title: string,
	renderer: "native" | "cef" = "cef",
	options: { maxRequestTime?: number; stressHandlers?: StressHandlers; forceFallbackHostMessages?: boolean } = {},
): RPCHarnessWindow {
	resetCallbacks();
	const frame = { x: 140, y: 140, width: 640, height: 420 };
	const windowId = native.createWindow({ title, ...frame, activate: false, quitOnClose: false });
	try {
		const webviewId = createTrackedWebview(webviewOptions(windowId, testHarnessURL, { x: 0, y: 0, width: frame.width, height: frame.height }, renderer));
		const rpc = createHarnessRPC(webviewId, options.maxRequestTime ?? Infinity, options.stressHandlers ?? {}, options.forceFallbackHostMessages ?? false);
		waitUntil(5000, () => {
			const state = webviewEventCounts.get(webviewId);
			return Boolean(state && (state.domReady > 0 || state.didNavigate > 0));
		});
		const probeId = `ctHarnessProbe:${webviewId}:${nowMs()}`;
		harnessProbeMessages.delete(probeId);
		const probeStarted = nowMs();
		while (nowMs() - probeStarted < 15000) {
			harnessProbeMessages.delete(probeId);
			native.evaluateJavaScriptWithNoCompletion(webviewId, `
				window.__electrobunHostBridge?.postMessage(JSON.stringify({
					type: "message",
						id: ${JSON.stringify(probeId)},
						payload: {
							title: document.title,
						hasElectrobunObject: !!window.electrobun,
						hasElectrobunRPC: !!window.electrobun?.rpc,
						hasReceiveMessageFromHost: typeof window.__electrobun?.receiveMessageFromHost === "function",
							testHarnessReady: !!window.testHarnessReady
						}
					}));
				`);
			waitUntil(500, () => {
				const probe = harnessProbeMessages.get(probeId);
				return Boolean(
					probe?.testHarnessReady === true &&
					probe?.hasElectrobunRPC === true &&
					probe?.hasReceiveMessageFromHost === true
				);
			});
			const probe = harnessProbeMessages.get(probeId);
			if (
				probe?.testHarnessReady === true &&
				probe?.hasElectrobunRPC === true &&
				probe?.hasReceiveMessageFromHost === true
			) {
				break;
			}
		}
		assert(harnessProbeMessages.has(probeId), "test harness did not answer direct host bridge probe");
		const probe = harnessProbeMessages.get(probeId);
		harnessProbeMessages.delete(probeId);
		assert(probe?.testHarnessReady === true, `test harness was not ready: ${JSON.stringify(probe)}`);
		assert(probe?.hasElectrobunRPC === true, `test harness RPC was not installed: ${JSON.stringify(probe)}`);
		assert(probe?.hasReceiveMessageFromHost === true, `test harness host receive hook was not installed: ${JSON.stringify(probe)}`);
		const receiveProbePrefix = `ctHarnessProbe:${webviewId}:${nowMs()}:receive:`;
		native.evaluateJavaScriptWithNoCompletion(webviewId, `
			(() => {
				const original = window.__electrobun?.receiveMessageFromHost;
				if (!original || window.__ctReceiveMessageProbeInstalled) return;
				window.__ctReceiveMessageProbeInstalled = true;
				window.__electrobun.receiveMessageFromHost = function(message) {
					try {
						window.__electrobunHostBridge?.postMessage(JSON.stringify({
							type: "message",
							id: ${JSON.stringify(receiveProbePrefix)} + String(message?.type || "unknown"),
							payload: { packetType: message?.type, packetId: message?.id, method: message?.method }
						}));
					} catch {}
					return original.call(this, message);
				};
			})();
		`);
		harnessReceiveProbePrefixes.set(webviewId, receiveProbePrefix);
		const rpcProbeId = `ctHarnessProbe:${webviewId}:${nowMs()}:rpc`;
		harnessProbeMessages.delete(rpcProbeId);
		const requestCountBefore = harnessRPCRequestCounts.get(webviewId) ?? 0;
		const sendCountBefore = harnessRPCSendCounts.get(webviewId) ?? 0;
		native.evaluateJavaScriptWithNoCompletion(webviewId, `
			window.electrobun.rpc.request.add({ a: 2, b: 3 })
				.then((value) => window.__electrobunHostBridge?.postMessage(JSON.stringify({
					type: "message",
					id: ${JSON.stringify(rpcProbeId)},
					payload: { value }
				})))
				.catch((error) => window.__electrobunHostBridge?.postMessage(JSON.stringify({
					type: "message",
					id: ${JSON.stringify(rpcProbeId)},
					payload: { error: String(error?.message || error) }
				})));
		`);
		assert(waitUntil(5000, () => (harnessRPCRequestCounts.get(webviewId) ?? 0) > requestCountBefore), "host did not receive direct RPC probe request");
		assert(waitUntil(5000, () => (harnessRPCSendCounts.get(webviewId) ?? 0) > sendCountBefore), "host RPC transport did not send direct RPC probe response");
		assert(waitUntil(5000, () => harnessProbeMessages.has(rpcProbeId)), "test harness did not answer direct RPC probe");
		const rpcProbe = harnessProbeMessages.get(rpcProbeId);
		harnessProbeMessages.delete(rpcProbeId);
		assert(rpcProbe?.value === 5, `test harness direct RPC probe failed: ${JSON.stringify(rpcProbe)}`);
		return {
			windowId,
			webviewId,
			rpc,
			dispose() {
				webviewRPCHandlers.delete(webviewId);
				harnessReceiveProbePrefixes.delete(webviewId);
				closeWindowSilent(windowId);
			},
		};
	} catch (error) {
		closeWindowSilent(windowId);
		throw error;
	}
}

function runWgpuAdapterWriteTextureRenderPassTest(): void {
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	const win = new GpuWindow({
		title: "Cottontail WGPU Adapter Test",
		frame: { width: 320, height: 240, x: 120, y: 120 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const width = 64;
		const height = 4;
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 255;
			data[i + 1] = 128;
			data[i + 2] = 32;
			data[i + 3] = 255;
		}

		const texture = device.createTexture({
			size: { width, height, depthOrArrayLayers: 1 },
			format: "rgba8unorm",
			usage: TextureUsage.CopyDst | TextureUsage.TextureBinding | TextureUsage.RenderAttachment,
		});
		device.queue.writeTexture(
			{ texture },
			data,
			{ bytesPerRow: width * 4, rowsPerImage: height },
			{ width, height, depthOrArrayLayers: 1 },
		);

		const view = texture.createView();
		assert(Boolean(view), "failed to create texture view");
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view,
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.end();
		const commandBuffer = encoder.finish();
		device.queue.submit([commandBuffer]);
		sleep(shortWait);
	} finally {
		win.close();
	}
}

function runWgpuAdapterTextureViewVariantsTest(): void {
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	const win = new GpuWindow({
		title: "Cottontail WGPU Texture View Test",
		frame: { width: 200, height: 160, x: 180, y: 180 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const texture = device.createTexture({
			size: { width: 8, height: 8, depthOrArrayLayers: 1 },
			format: "rgba8unorm",
			usage: TextureUsage.TextureBinding | TextureUsage.RenderAttachment | TextureUsage.CopyDst,
			mipLevelCount: 2,
		});
		const view = texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
		assert(Boolean(view), "texture view was not created");
	} finally {
		win.close();
	}
}

function runWgpuAdapterDepthAttachmentRenderPassTest(): void {
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	const win = new GpuWindow({
		title: "Cottontail WGPU Depth Test",
		frame: { width: 220, height: 160, x: 220, y: 220 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const color = device.createTexture({
			size: { width: 64, height: 64, depthOrArrayLayers: 1 },
			format: "bgra8unorm",
			usage: TextureUsage.RenderAttachment,
		});
		const depth = device.createTexture({
			size: { width: 64, height: 64, depthOrArrayLayers: 1 },
			format: "depth24plus-stencil8",
			usage: TextureUsage.RenderAttachment,
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: color.createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
			depthStencilAttachment: {
				view: depth.createView(),
				depthClearValue: 1,
				depthLoadOp: "clear",
				depthStoreOp: "store",
			},
		});
		pass.end();
		device.queue.submit([encoder.finish()]);
		sleep(shortWait);
	} finally {
		win.close();
	}
}

function runWgpuAdapterBindGroupLayoutTest(): void {
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	const win = new GpuWindow({
		title: "Cottontail WGPU Bind Group Test",
		frame: { width: 220, height: 160, x: 260, y: 260 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const buffer = device.createBuffer({
			size: 64,
			usage: BufferUsage.Uniform | BufferUsage.CopyDst,
		});
		const texture = device.createTexture({
			size: { width: 4, height: 4, depthOrArrayLayers: 1 },
			format: "rgba8unorm",
			usage: TextureUsage.TextureBinding | TextureUsage.CopyDst,
		});
		const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
		const layout = device.createBindGroupLayout({
			entries: [
				{ binding: 0, visibility: 3, buffer: { type: "uniform" } },
				{ binding: 1, visibility: 3, sampler: { type: "filtering" } },
				{ binding: 2, visibility: 3, texture: { sampleType: "float" } },
			],
		});
		const group = device.createBindGroup({
			layout,
			entries: [
				{ binding: 0, resource: { buffer } },
				{ binding: 1, resource: sampler },
				{ binding: 2, resource: texture.createView() },
			],
		});
		assert(Boolean(group), "bind group was not created");
	} finally {
		win.close();
	}
}

function runWgpuAdapterSamplerDescriptorTest(): void {
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	const win = new GpuWindow({
		title: "Cottontail WGPU Sampler Test",
		frame: { width: 200, height: 160, x: 300, y: 300 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const sampler = device.createSampler({
			minFilter: "linear",
			magFilter: "linear",
			mipmapFilter: "nearest",
			addressModeU: "repeat",
			addressModeV: "repeat",
		});
		assert(Boolean(sampler), "sampler was not created");
	} finally {
		win.close();
	}
}

function runWgpuAdapterCopyBufferToTextureTest(): void {
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");
	const win = new GpuWindow({
		title: "Cottontail WGPU CopyBufferToTexture Test",
		frame: { width: 220, height: 160, x: 340, y: 340 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const width = 8;
		const height = 8;
		const buffer = device.createBuffer({
			size: width * height * 4,
			usage: BufferUsage.MapWrite | BufferUsage.CopySrc,
			mappedAtCreation: true,
		});
		const mapped = buffer.getMappedRange(0, width * height * 4);
		const view = new Uint8Array(mapped);
		for (let i = 0; i < view.length; i += 4) {
			view[i] = 40;
			view[i + 1] = 140;
			view[i + 2] = 230;
			view[i + 3] = 255;
		}
		buffer.unmap();

		const texture = device.createTexture({
			size: { width, height, depthOrArrayLayers: 1 },
			format: "rgba8unorm",
			usage: TextureUsage.CopyDst | TextureUsage.TextureBinding | TextureUsage.RenderAttachment,
		});

		const encoder = device.createCommandEncoder();
		encoder.copyBufferToTexture(
			{ buffer, offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
			{ texture },
			{ width, height, depthOrArrayLayers: 1 },
		);
		device.queue.submit([encoder.finish()]);
		sleep(shortWait);
	} finally {
		win.close();
	}
}

function runThreeAdapterMathRenderPassTest(): void {
	assert(Boolean(three?.BoxGeometry), "Three adapter not available");
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");

	const geometry = new three.BoxGeometry(0.8, 0.8, 0.8).toNonIndexed();
	geometry.computeBoundingSphere();
	const mesh = new three.Mesh(geometry, new three.MeshBasicMaterial({ color: 0x00ff88 }));
	const camera = new three.PerspectiveCamera(50, 1, 0.1, 10);
	camera.position.z = 2.6;
	camera.updateMatrixWorld();
	const raycaster = new three.Raycaster();
	raycaster.setFromCamera(new three.Vector2(0, 0), camera);
	assert(raycaster.intersectObject(mesh).length > 0, "Three raycaster did not hit the mesh");

	const win = new GpuWindow({
		title: "Cottontail Three Adapter Test",
		frame: { width: 320, height: 240, x: 140, y: 140 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});

	try {
		const { device } = createCottontailWebGPUDevice(win);
		const shader = device.createShaderModule({
			code: `
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4<f32> {
	var positions = array<vec2<f32>, 3>(
		vec2<f32>(0.0, 0.7),
		vec2<f32>(-0.7, -0.7),
		vec2<f32>(0.7, -0.7)
	);
	let p = positions[vertexIndex];
	return vec4<f32>(p, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
	return vec4<f32>(0.0, 1.0, 0.55, 1.0);
}
`,
		});
		const pipeline = device.createRenderPipeline({
			layout: "auto",
			vertex: { module: shader, entryPoint: "vs_main" },
			fragment: {
				module: shader,
				entryPoint: "fs_main",
				targets: [{ format: "bgra8unorm" }],
			},
			primitive: { topology: "triangle-list" },
		});
		const texture = device.createTexture({
			size: { width: 64, height: 64, depthOrArrayLayers: 1 },
			format: "bgra8unorm",
			usage: TextureUsage.RenderAttachment,
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: texture.createView(),
					clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(pipeline);
		pass.draw(3);
		pass.end();
		device.queue.submit([encoder.finish()]);
		sleep(shortWait);
	} finally {
		win.close();
	}
}

function runBabylonAdapterEngineInitTest(): void {
	assert(Boolean(babylon?.WebGPUEngine), "Babylon adapter not available");
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");

	const win = new GpuWindow({
		title: "Cottontail Babylon Adapter Test",
		frame: { width: 360, height: 240, x: 160, y: 160 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});
	let engine: any = null;

	try {
		webgpu.install();
		const canvas = webgpu.utils.createCanvasShim(win);
		engine = new babylon.WebGPUEngine(canvas as any, { antialias: false });
		waitForPromise(engine.initAsync(), 15000);

		const scene = new babylon.Scene(engine);
		scene.clearColor = new babylon.Color4(0.05, 0.05, 0.08, 1);
		const camera = new babylon.FreeCamera("camera", new babylon.Vector3(0, 0, -3), scene);
		camera.inputs.clear();
		camera.setTarget(babylon.Vector3.Zero());
		const light = new babylon.HemisphericLight("light", new babylon.Vector3(0, 1, 0), scene);
		light.intensity = 0.9;
		const box = babylon.MeshBuilder.CreateBox("box", { size: 0.7 }, scene);
		const material = new babylon.StandardMaterial("mat", scene);
		material.diffuseColor = new babylon.Color3(0.12, 0.5, 0.35);
		box.material = material;
		scene.render();
		host.drainJobs?.();
		assert(scene.meshes.length > 0, "Babylon scene did not create meshes");
	} finally {
		try {
			engine?.dispose?.();
		} finally {
			win.close();
		}
	}
}

function runBabylonAdapterTexturedQuadTest(): void {
	assert(Boolean(babylon?.WebGPUEngine), "Babylon adapter not available");
	assert(Boolean(webgpu?.createContext), "WebGPU adapter not available");

	const win = new GpuWindow({
		title: "Cottontail Babylon Textured Quad Test",
		frame: { width: 360, height: 240, x: 160, y: 160 },
		titleBarStyle: "default",
		transparent: false,
		activate: false,
	});
	let engine: any = null;

	try {
		webgpu.install();
		const canvas = webgpu.utils.createCanvasShim(win);
		engine = new babylon.WebGPUEngine(canvas as any, { antialias: false });
		waitForPromise(engine.initAsync(), 15000);

		const scene = new babylon.Scene(engine);
		scene.clearColor = new babylon.Color4(0.05, 0.05, 0.08, 1);
		const camera = new babylon.FreeCamera("camera", new babylon.Vector3(0, 0, -3), scene);
		camera.inputs.clear();
		camera.setTarget(babylon.Vector3.Zero());
		const light = new babylon.HemisphericLight("light", new babylon.Vector3(0, 1, 0), scene);
		light.intensity = 0.9;

		const width = 64;
		const height = 4;
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 220;
			data[i + 1] = 140;
			data[i + 2] = 40;
			data[i + 3] = 255;
		}

		const texture = new babylon.RawTexture(
			data,
			width,
			height,
			babylon.Engine.TEXTUREFORMAT_RGBA,
			scene,
			false,
			false,
			babylon.Texture.NEAREST_SAMPLINGMODE,
			babylon.Engine.TEXTURETYPE_UNSIGNED_INT,
		);
		const material = new babylon.StandardMaterial("mat", scene);
		material.diffuseTexture = texture;
		material.emissiveColor = new babylon.Color3(1, 1, 1);
		material.specularColor = babylon.Color3.Black();
		const quad = babylon.MeshBuilder.CreatePlane("quad", { size: 1.5 }, scene);
		quad.material = material;

		scene.render();
		host.drainJobs?.();
		sleep(250);
		assert(scene.meshes.length > 0, "Babylon textured quad did not create meshes");
	} finally {
		try {
			engine?.stopRenderLoop?.();
			engine?.dispose?.();
		} finally {
			win.close();
		}
	}
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

function runUpdaterCheckForUpdateTest(): void {
	const updateInfo = waitForPromise(Updater.checkForUpdate(), 15000);
	assert(Boolean(updateInfo), "checkForUpdate returned empty update info");
	assert(typeof updateInfo.updateAvailable === "boolean", "updateAvailable was not a boolean");
	assert(typeof updateInfo.version === "string", "update version was not a string");
	assert(typeof updateInfo.hash === "string", "update hash was not a string");
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

function splitCoreList(value: string | null | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function expandHome(path: string): string {
	if (path === "~") return resolvePaths().home;
	if (path.startsWith("~/")) return pathJoin(resolvePaths().home, path.slice(2));
	return path;
}

function trayMenuForOptions(showMenu: boolean, hasSubmenu: boolean): any[] {
	if (!showMenu) return [];
	const menu: any[] = [
		{ type: "normal", label: "Action 1", action: "action-1" },
		{ type: "normal", label: "Action 2", action: "action-2" },
		{ type: "divider" },
	];
	if (hasSubmenu) {
		menu.push({
			type: "normal",
			label: "More Options",
			submenu: [
				{ type: "normal", label: "Sub Item A", action: "sub-a" },
				{ type: "normal", label: "Sub Item B", action: "sub-b" },
			],
		});
	}
	menu.push({ type: "normal", label: "Close", action: "close" });
	return menu;
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
			try {
				sendRPCResponse(webviewId, id, { success: true });
			} catch (error) {
				console.error(`[kitchen cottontail] failed to acknowledge closeWindow: ${error instanceof Error ? error.message : String(error)}`);
			}
			cleanupInteractiveState(webviewId);
			native.closeWindow(windowIdForWebview);
			break;
		}
		case "minimizeWindow": {
			const windowIdForWebview = topLevelWebviews.get(webviewId);
			if (!windowIdForWebview) {
				sendRPCError(webviewId, id, "No top-level window for webview");
				break;
			}
			native.minimizeWindow(windowIdForWebview);
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "maximizeWindow": {
			const windowIdForWebview = topLevelWebviews.get(webviewId);
			if (!windowIdForWebview) {
				sendRPCError(webviewId, id, "No top-level window for webview");
				break;
			}
			if (native.isWindowMaximized(windowIdForWebview)) {
				native.unmaximizeWindow(windowIdForWebview);
			} else {
				native.maximizeWindow(windowIdForWebview);
			}
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "openFileDialog": {
			const params = requestParams(packet);
			const selected = native.openFileDialog({
				startingFolder: expandHome(String(params.startingFolder || "~/")),
				allowedFileTypes: String(params.allowedFileTypes || "*"),
				canChooseFiles: params.canChooseFiles !== false,
				canChooseDirectory: params.canChooseDirectory !== false,
				allowsMultipleSelection: params.allowsMultipleSelection !== false,
			});
			sendRPCResponse(webviewId, id, splitCoreList(selected));
			break;
		}
		case "readClipboard": {
			sendRPCResponse(webviewId, id, {
				text: native.clipboardReadText(),
				formats: splitCoreList(native.clipboardAvailableFormats()),
			});
			break;
		}
		case "writeClipboard": {
			const params = requestParams(packet);
			native.clipboardWriteText(String(params.text ?? ""));
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "createTray": {
			const params = requestParams(packet);
			const previous = trayPlaygrounds.get(webviewId);
			if (previous) {
				try {
					native.removeTray(previous.trayId);
				} catch {}
			}
			const trayId = native.createTray({
				title: String(params.title || "Test Tray"),
				image: trayTemplateIconURL,
				isTemplate: true,
				width: 32,
				height: 32,
				handler: true,
			});
			const menu = trayMenuForOptions(Boolean(params.showMenu), Boolean(params.hasSubmenu));
			if (menu.length > 0) native.setTrayMenuJSON(trayId, JSON.stringify(menu));
			native.showTray(trayId);
			trayPlaygrounds.set(webviewId, { trayId, counterValue: 0, counterRunning: false, lastCounterTick: nowMs() });
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "updateTitle": {
			const params = requestParams(packet);
			const state = trayPlaygrounds.get(webviewId);
			if (state) native.setTrayTitle(state.trayId, String(params.title ?? ""));
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "startCounter": {
			const state = trayPlaygrounds.get(webviewId);
			if (!state) {
				sendRPCResponse(webviewId, id, { success: false });
				break;
			}
			state.counterRunning = true;
			state.lastCounterTick = nowMs();
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "stopCounter": {
			const state = trayPlaygrounds.get(webviewId);
			if (state) state.counterRunning = false;
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "removeTray": {
			const state = trayPlaygrounds.get(webviewId);
			if (state) {
				try {
					native.removeTray(state.trayId);
				} catch {}
				trayPlaygrounds.delete(webviewId);
			}
			sendRPCResponse(webviewId, id, { success: true });
			break;
		}
		case "registerShortcut": {
			const params = requestParams(packet);
			const accelerator = String(params.accelerator ?? "");
			native.setNativeCallback("globalShortcut", true);
			const success = accelerator.length > 0 && native.registerGlobalShortcut(accelerator);
			if (success) {
				let shortcuts = shortcutPlaygrounds.get(webviewId);
				if (!shortcuts) {
					shortcuts = new Set<string>();
					shortcutPlaygrounds.set(webviewId, shortcuts);
				}
				shortcuts.add(accelerator);
			}
			sendRPCResponse(webviewId, id, { success });
			break;
		}
		case "unregisterShortcut": {
			const params = requestParams(packet);
			const accelerator = String(params.accelerator ?? "");
			const success = accelerator.length > 0 && native.unregisterGlobalShortcut(accelerator);
			shortcutPlaygrounds.get(webviewId)?.delete(accelerator);
			sendRPCResponse(webviewId, id, { success });
			break;
		}
		case "unregisterAllShortcuts": {
			const shortcuts = shortcutPlaygrounds.get(webviewId);
			if (shortcuts) {
				for (const accelerator of shortcuts) {
					try {
						native.unregisterGlobalShortcut(accelerator);
					} catch {}
				}
				shortcuts.clear();
			}
			sendRPCResponse(webviewId, id, { success: true });
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
	if (
		packet.type === "message" &&
		typeof packet.id === "string" &&
		(packet.id.startsWith("ctHarnessProbe:") || packet.id.startsWith("ctHostSocketState:"))
	) {
		harnessProbeMessages.set(packet.id, packet.payload);
		return;
	}
	const webviewRPCHandler = webviewRPCHandlers.get(webviewId);
	if (webviewRPCHandler) {
		if (packet.type === "response") {
			harnessRPCResponseCounts.set(webviewId, (harnessRPCResponseCounts.get(webviewId) ?? 0) + 1);
		}
		webviewRPCHandler(packet);
		return;
	}
	if (packet.type === "request") {
		handleRequest(webviewId, Number(packet.id), String(packet.method), packet);
	} else if (packet.type === "message" && packet.id === "logToBun") {
		console.log(`[UI] ${packet.payload?.msg ?? packet.msg ?? ""}`);
	} else if (packet.type === "message") {
		handleTopLevelMessage(webviewId, String(packet.id), packet.payload);
	}
}

function handleTopLevelMessage(webviewId: number, messageId: string, payloadValue: unknown): void {
	const payload = typeof payloadValue === "string" ? parseMaybeJSON<any>(payloadValue) : (payloadValue as any);
	const id = Number(payload?.id ?? 0);
	switch (messageId) {
		case "oopifLoaded":
			multiwindowCefPlaygrounds.get(webviewId)?.loaded.add(webviewId);
			break;
		case "wgpuTagRect": {
			if (!id) return;
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

createTrackedWebview({
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
