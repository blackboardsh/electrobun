const std = @import("std");
const builtin = @import("builtin");
const electrobun = @import("electrobun");

const app_version = "1.18.1";
const default_secret_key = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32";
const available_renderers_native = [_][]const u8{"native"};
const available_renderers_cef = [_][]const u8{ "native", "cef" };
const visible_test_window_delay_ms: u64 = 1000;
const short_wait_ms: u64 = 150;
const medium_wait_ms: u64 = 500;
const long_wait_ms: u64 = 1200;
const test_harness_url = "views://test-harness/index.html";
const tray_template_icon_url = "views://assets/electrobun-logo-32-template.png";

const BuildConfigPayload = struct {
    defaultRenderer: []const u8,
    availableRenderers: []const []const u8,
    mainProcess: []const u8,
    cefVersion: ?[]const u8 = null,
    bunVersion: ?[]const u8 = null,
    zigVersion: ?[]const u8 = null,
};

const UpdateInfo = struct {
    status: []const u8,
    currentVersion: []const u8,
    newVersion: ?[]const u8 = null,
    @"error": ?[]const u8 = null,
};

const TestInfo = struct {
    id: []const u8,
    name: []const u8,
    category: []const u8,
    description: []const u8,
    interactive: bool,
};

const TestResult = struct {
    testId: []const u8,
    name: []const u8,
    status: []const u8,
    duration: u64,
    @"error": ?[]const u8 = null,
};

const TestKind = enum {
    smoke,
    window_create_close,
    window_creation_with_url,
    window_hidden_option,
    window_inactive_show_api,
    window_page_zoom,
    window_set_title,
    window_minimize_unminimize,
    window_fullscreen_toggle,
    window_fullscreen_toggle_hidden_titlebar,
    window_set_position,
    window_set_size,
    window_set_frame,
    window_get_frame,
    window_get_position,
    window_get_size,
    window_maximize_unmaximize,
    window_always_on_top,
    window_visible_on_all_workspaces,
    window_focus,
    window_close_event,
    window_resize_event,
    window_get_by_id,
    window_inset_titlebar_style,
    window_traffic_light_position_api,
    webview_create,
    webview_page_zoom,
    webview_tag_playground_integration,
    webview_tag_playground_interactive,
    wgpu_tag_playground_integration,
    wgpu_tag_playground_interactive,
    navigation_load_url,
    navigation_load_html,
    navigation_dom_ready_event,
    navigation_did_navigate_event,
    navigation_execute_javascript,
    tray_visibility_toggle_and_bounds,
    session_from_partition,
    session_default_session,
    session_cookies_api_exists,
    application_menu_playground,
    context_menu_playground,
    dialog_show_message_box_info,
    dialog_file_dialog_playground,
    global_shortcuts_playground,
    global_shortcut_is_registered_api,
    global_shortcut_unregister_all_api,
    lifecycle_before_quit_cancel,
    quit_shutdown_playground,
    wgpu_adapter_context_device,
    dock_icon_visibility_contract,
    utils_clipboard_round_trip,
    utils_clipboard_available_formats,
    utils_clipboard_clear,
    utils_show_notification,
    utils_open_external_exists,
    utils_open_path_exists,
    utils_show_item_in_folder_exists,
    utils_quit_exists,
    utils_paths_object_exists,
    utils_paths_home_matches,
    utils_paths_temp_matches,
    utils_paths_os_directories,
    utils_paths_app_scoped_directories,
    utils_paths_stable_across_calls,
    utils_move_to_trash,
    screen_primary_display,
    screen_all_displays,
    screen_cursor_screen_point,
    screen_bounds_vs_workarea,
};

const ZigTest = struct {
    id: []const u8,
    name: []const u8,
    category: []const u8,
    description: []const u8,
    interactive: bool = false,
    mirrors_bun_test_name: ?[]const u8 = null,
    kind: TestKind,

    fn toInfo(self: ZigTest) TestInfo {
        return .{
            .id = self.id,
            .name = self.name,
            .category = self.category,
            .description = self.description,
            .interactive = self.interactive,
        };
    }
};

const zig_tests = [_]ZigTest{
    .{
        .id = "zig-smoke-test",
        .name = "Zig host smoke test",
        .category = "Zig Native",
        .description = "Verify the Zig main process and view RPC bridge are running.",
        .kind = .smoke,
    },
    .{
        .id = "zig-window-create-close",
        .name = "Window create/close (Zig)",
        .category = "BrowserWindow",
        .description = "Create a native window through the Zig SDK and close it again.",
        .kind = .window_create_close,
    },
    .{
        .id = "zig-window-creation-with-url",
        .name = "Window creation with URL (Zig)",
        .category = "BrowserWindow",
        .description = "Create a native window and attach a BrowserView loading the test harness URL.",
        .mirrors_bun_test_name = "Window creation with URL",
        .kind = .window_creation_with_url,
    },
    .{
        .id = "zig-window-hidden-option",
        .name = "Window hidden option (Zig)",
        .category = "BrowserWindow",
        .description = "Create a hidden native window, then show it through the Zig SDK.",
        .mirrors_bun_test_name = "Window hidden option",
        .kind = .window_hidden_option,
    },
    .{
        .id = "zig-window-inactive-show-api",
        .name = "Window inactive show API (Zig)",
        .category = "BrowserWindow",
        .description = "Show a native window without activation, then activate it explicitly.",
        .mirrors_bun_test_name = "Window inactive show API",
        .kind = .window_inactive_show_api,
    },
    .{
        .id = "zig-window-page-zoom",
        .name = "Window page zoom API (Zig)",
        .category = "BrowserWindow",
        .description = "Set and read the primary BrowserWindow page zoom in Zig mode.",
        .mirrors_bun_test_name = "Window page zoom API",
        .kind = .window_page_zoom,
    },
    .{
        .id = "zig-window-set-title",
        .name = "Window setTitle (Zig)",
        .category = "BrowserWindow",
        .description = "Update a native window title through the Zig SDK.",
        .mirrors_bun_test_name = "Window setTitle",
        .kind = .window_set_title,
    },
    .{
        .id = "zig-window-minimize-unminimize",
        .name = "Window minimize/unminimize (Zig)",
        .category = "BrowserWindow",
        .description = "Toggle native window minimized state through the Zig SDK.",
        .mirrors_bun_test_name = "Window minimize/unminimize",
        .kind = .window_minimize_unminimize,
    },
    .{
        .id = "zig-window-fullscreen-toggle",
        .name = "Window fullscreen toggle (Zig)",
        .category = "BrowserWindow",
        .description = "Toggle native window fullscreen state through the Zig SDK.",
        .mirrors_bun_test_name = "Window fullscreen toggle",
        .kind = .window_fullscreen_toggle,
    },
    .{
        .id = "zig-window-fullscreen-toggle-hidden-titlebar",
        .name = "Window fullscreen toggle with hidden titlebar (Zig)",
        .category = "BrowserWindow",
        .description = "Toggle fullscreen for a hidden-titlebar window in Zig mode on macOS.",
        .mirrors_bun_test_name = "Window fullscreen toggle with hidden titlebar",
        .kind = .window_fullscreen_toggle_hidden_titlebar,
    },
    .{
        .id = "zig-window-set-position",
        .name = "Window setPosition (Zig)",
        .category = "BrowserWindow",
        .description = "Move a native window and read the new frame back from core.",
        .mirrors_bun_test_name = "Window setPosition",
        .kind = .window_set_position,
    },
    .{
        .id = "zig-window-set-size",
        .name = "Window setSize (Zig)",
        .category = "BrowserWindow",
        .description = "Resize a native window and read the new frame back from core.",
        .mirrors_bun_test_name = "Window setSize",
        .kind = .window_set_size,
    },
    .{
        .id = "zig-window-set-frame",
        .name = "Window setFrame (Zig)",
        .category = "BrowserWindow",
        .description = "Create a window, update its frame, and read the new size back from core.",
        .mirrors_bun_test_name = "Window setFrame",
        .kind = .window_set_frame,
    },
    .{
        .id = "zig-window-get-frame",
        .name = "Window getFrame (Zig)",
        .category = "BrowserWindow",
        .description = "Read the current native window frame through the Zig SDK.",
        .mirrors_bun_test_name = "Window getFrame",
        .kind = .window_get_frame,
    },
    .{
        .id = "zig-window-get-position",
        .name = "Window getPosition (Zig)",
        .category = "BrowserWindow",
        .description = "Read the current native window position through the Zig SDK.",
        .mirrors_bun_test_name = "Window getPosition",
        .kind = .window_get_position,
    },
    .{
        .id = "zig-window-get-size",
        .name = "Window getSize (Zig)",
        .category = "BrowserWindow",
        .description = "Read the current native window size through the Zig SDK.",
        .mirrors_bun_test_name = "Window getSize",
        .kind = .window_get_size,
    },
    .{
        .id = "zig-window-maximize-unmaximize",
        .name = "Window maximize/unmaximize (Zig)",
        .category = "BrowserWindow",
        .description = "Toggle native window maximized state through the Zig SDK.",
        .mirrors_bun_test_name = "Window maximize/unmaximize",
        .kind = .window_maximize_unmaximize,
    },
    .{
        .id = "zig-window-always-on-top",
        .name = "Window alwaysOnTop (Zig)",
        .category = "BrowserWindow",
        .description = "Toggle native always-on-top state through the Zig SDK.",
        .mirrors_bun_test_name = "Window alwaysOnTop",
        .kind = .window_always_on_top,
    },
    .{
        .id = "zig-window-visible-on-all-workspaces",
        .name = "Window visibleOnAllWorkspaces (macOS) (Zig)",
        .category = "BrowserWindow",
        .description = "Toggle visible-on-all-workspaces in Zig mode on macOS.",
        .mirrors_bun_test_name = "Window visibleOnAllWorkspaces (macOS)",
        .kind = .window_visible_on_all_workspaces,
    },
    .{
        .id = "zig-window-focus",
        .name = "Window focus (Zig)",
        .category = "BrowserWindow",
        .description = "Focus multiple native windows through the Zig SDK.",
        .mirrors_bun_test_name = "Window focus",
        .kind = .window_focus,
    },
    .{
        .id = "zig-window-close-event",
        .name = "Window close event (Zig)",
        .category = "BrowserWindow",
        .description = "Verify a per-window close callback fires in Zig mode.",
        .mirrors_bun_test_name = "Window close event",
        .kind = .window_close_event,
    },
    .{
        .id = "zig-window-resize-event",
        .name = "Window resize event (Zig)",
        .category = "BrowserWindow",
        .description = "Verify a per-window resize callback fires in Zig mode.",
        .mirrors_bun_test_name = "Window resize event",
        .kind = .window_resize_event,
    },
    .{
        .id = "zig-window-get-by-id",
        .name = "BrowserWindow.getById (Zig)",
        .category = "BrowserWindow",
        .description = "Verify the Zig window registry can retrieve a tracked window by id.",
        .mirrors_bun_test_name = "BrowserWindow.getById",
        .kind = .window_get_by_id,
    },
    .{
        .id = "zig-window-inset-titlebar-style",
        .name = "Window with inset titlebar style (Zig)",
        .category = "BrowserWindow",
        .description = "Create a native window with hiddenInset titlebar style in Zig mode.",
        .mirrors_bun_test_name = "Window with inset titlebar style",
        .kind = .window_inset_titlebar_style,
    },
    .{
        .id = "zig-window-traffic-light-position-api",
        .name = "Window traffic light position API (Zig)",
        .category = "BrowserWindow",
        .description = "Create a hiddenInset window with traffic light offsets and move them at runtime.",
        .mirrors_bun_test_name = "Window traffic light position API",
        .kind = .window_traffic_light_position_api,
    },
    .{
        .id = "zig-webview-create",
        .name = "BrowserView create (Zig)",
        .category = "BrowserView",
        .description = "Create a secondary native webview through the Zig SDK.",
        .kind = .webview_create,
    },
    .{
        .id = "zig-webview-page-zoom",
        .name = "BrowserView page zoom API (Zig)",
        .category = "BrowserWindow",
        .description = "Set and read BrowserView page zoom in Zig mode.",
        .mirrors_bun_test_name = "BrowserView page zoom API",
        .kind = .webview_page_zoom,
    },
    .{
        .id = "zig-webview-tag-playground-integration",
        .name = "Webview Tag playground integration (Zig)",
        .category = "Webview Tag",
        .description = "Load the real webview-tag playground in CEF mode and verify nested electrobun-webview tags initialize through the Zig host bridge.",
        .kind = .webview_tag_playground_integration,
    },
    .{
        .id = "zig-webview-tag-playground",
        .name = "Webview Tag playground (Zig)",
        .category = "Webview Tag (Interactive)",
        .description = "Open the real webview-tag playground and keep it open for manual interaction until the window is closed.",
        .interactive = true,
        .mirrors_bun_test_name = "Webview Tag playground",
        .kind = .webview_tag_playground_interactive,
    },
    .{
        .id = "zig-wgpu-tag-playground-integration",
        .name = "WGPU Tag playground integration (Zig)",
        .category = "WGPU Tag",
        .description = "Load the real WGPU tag playground in Zig mode and verify electrobun-wgpu initializes through the Zig host bridge.",
        .kind = .wgpu_tag_playground_integration,
    },
    .{
        .id = "zig-wgpu-tag-playground",
        .name = "WGPU Tag playground (Zig)",
        .category = "WGPU Tag (Interactive)",
        .description = "Open the real WGPU tag playground and keep it open for manual interaction until the window is closed.",
        .interactive = true,
        .mirrors_bun_test_name = "WGPU Tag playground",
        .kind = .wgpu_tag_playground_interactive,
    },
    .{
        .id = "zig-navigation-load-url",
        .name = "loadURL (Zig)",
        .category = "Navigation",
        .description = "Load a new internal URL into a BrowserView in Zig mode.",
        .mirrors_bun_test_name = "loadURL",
        .kind = .navigation_load_url,
    },
    .{
        .id = "zig-navigation-load-html",
        .name = "loadHTML (Zig)",
        .category = "Navigation",
        .description = "Load inline HTML into a BrowserView in Zig mode.",
        .mirrors_bun_test_name = "loadHTML",
        .kind = .navigation_load_html,
    },
    .{
        .id = "zig-navigation-dom-ready-event",
        .name = "dom-ready event (Zig)",
        .category = "Navigation",
        .description = "Verify dom-ready is emitted for BrowserView navigation in Zig mode.",
        .mirrors_bun_test_name = "dom-ready event",
        .kind = .navigation_dom_ready_event,
    },
    .{
        .id = "zig-navigation-did-navigate-event",
        .name = "did-navigate event (Zig)",
        .category = "Navigation",
        .description = "Verify did-navigate is emitted for BrowserView navigation in Zig mode.",
        .mirrors_bun_test_name = "did-navigate event",
        .kind = .navigation_did_navigate_event,
    },
    .{
        .id = "zig-navigation-execute-javascript",
        .name = "executeJavascript (fire and forget) (Zig)",
        .category = "Navigation",
        .description = "Execute JavaScript in a BrowserView without waiting for a response.",
        .mirrors_bun_test_name = "executeJavascript (fire and forget)",
        .kind = .navigation_execute_javascript,
    },
    .{
        .id = "zig-tray-visibility-toggle-bounds",
        .name = "Tray visibility toggle and bounds (Zig)",
        .category = "Tray",
        .description = "Create a tray item, toggle visibility, and read bounds in Zig mode.",
        .mirrors_bun_test_name = "Tray visibility toggle and bounds",
        .kind = .tray_visibility_toggle_and_bounds,
    },
    .{
        .id = "zig-session-from-partition",
        .name = "Session.fromPartition (Zig)",
        .category = "Session",
        .description = "Create a Zig session wrapper for a persistent partition.",
        .mirrors_bun_test_name = "Session.fromPartition",
        .kind = .session_from_partition,
    },
    .{
        .id = "zig-session-default-session",
        .name = "Session.defaultSession (Zig)",
        .category = "Session",
        .description = "Create the default Zig session wrapper.",
        .mirrors_bun_test_name = "Session.defaultSession",
        .kind = .session_default_session,
    },
    .{
        .id = "zig-session-cookies-api-exists",
        .name = "cookies API exists (Zig)",
        .category = "Session",
        .description = "Exercise the Zig session cookie helpers without mutating user state.",
        .mirrors_bun_test_name = "cookies API exists",
        .kind = .session_cookies_api_exists,
    },
    .{
        .id = "zig-application-menu-playground",
        .name = "Application menu playground (Zig)",
        .category = "Menus (Interactive)",
        .description = "Open the real application-menu playground in Zig mode and keep it open for manual interaction.",
        .interactive = true,
        .mirrors_bun_test_name = "Application menu playground",
        .kind = .application_menu_playground,
    },
    .{
        .id = "zig-context-menu-playground",
        .name = "Context menu playground (Zig)",
        .category = "Menus (Interactive)",
        .description = "Open the real context-menu playground in Zig mode and keep it open for manual interaction.",
        .interactive = true,
        .mirrors_bun_test_name = "Context menu playground",
        .kind = .context_menu_playground,
    },
    .{
        .id = "zig-dialog-show-message-box-info",
        .name = "showMessageBox - info dialog (Zig)",
        .category = "Dialogs (Interactive)",
        .description = "Show a native info dialog through the Zig SDK and pass after the user clicks a button.",
        .interactive = true,
        .mirrors_bun_test_name = "showMessageBox - info dialog",
        .kind = .dialog_show_message_box_info,
    },
    .{
        .id = "zig-dialog-file-dialog-playground",
        .name = "File dialog playground (Zig)",
        .category = "Dialogs (Interactive)",
        .description = "Open the real file-dialog playground in Zig mode and keep it open for manual interaction.",
        .interactive = true,
        .mirrors_bun_test_name = "File dialog playground",
        .kind = .dialog_file_dialog_playground,
    },
    .{
        .id = "zig-global-shortcuts-playground",
        .name = "Global shortcuts playground (Zig)",
        .category = "Shortcuts (Interactive)",
        .description = "Open the real shortcuts playground in Zig mode and keep it open for manual interaction.",
        .interactive = true,
        .mirrors_bun_test_name = "Global shortcuts playground",
        .kind = .global_shortcuts_playground,
    },
    .{
        .id = "zig-global-shortcut-is-registered-api",
        .name = "GlobalShortcut.isRegistered API (Zig)",
        .category = "Shortcuts",
        .description = "Verify Zig global shortcut registration state tracking.",
        .mirrors_bun_test_name = "GlobalShortcut.isRegistered API",
        .kind = .global_shortcut_is_registered_api,
    },
    .{
        .id = "zig-global-shortcut-unregister-all-api",
        .name = "GlobalShortcut.unregisterAll API (Zig)",
        .category = "Shortcuts",
        .description = "Verify Zig global shortcut unregisterAll clears registered accelerators.",
        .mirrors_bun_test_name = "GlobalShortcut.unregisterAll API",
        .kind = .global_shortcut_unregister_all_api,
    },
    .{
        .id = "zig-lifecycle-before-quit-cancel",
        .name = "before-quit event can cancel quit (Zig)",
        .category = "App Lifecycle",
        .description = "Verify a Zig before-quit handler can run and cancel shutdown.",
        .mirrors_bun_test_name = "before-quit event can cancel quit",
        .kind = .lifecycle_before_quit_cancel,
    },
    .{
        .id = "zig-quit-shutdown-playground",
        .name = "Quit/Shutdown playground (Zig)",
        .category = "Quit (Interactive)",
        .description = "Open the real quit-test playground in Zig mode and keep it open for manual interaction.",
        .interactive = true,
        .mirrors_bun_test_name = "Quit/Shutdown playground",
        .kind = .quit_shutdown_playground,
    },
    .{
        .id = "zig-wgpu-adapter-context-device",
        .name = "WebGPU adapter: context/device init (Zig)",
        .category = "WebGPU",
        .description = "Create a native WGPU view, then build a direct Zig WGPU context and device pointer pair.",
        .kind = .wgpu_adapter_context_device,
    },
    .{
        .id = "zig-dock-icon-visibility-contract",
        .name = "Dock icon visibility contract (Zig)",
        .category = "Utils",
        .description = "Exercise dock icon visibility controls from the Zig SDK.",
        .mirrors_bun_test_name = "Dock icon visibility contract",
        .kind = .dock_icon_visibility_contract,
    },
    .{
        .id = "zig-utils-clipboard-round-trip",
        .name = "clipboardWriteText and clipboardReadText (Zig)",
        .category = "Utils",
        .description = "Write and read clipboard text through the Zig SDK.",
        .mirrors_bun_test_name = "clipboardWriteText and clipboardReadText",
        .kind = .utils_clipboard_round_trip,
    },
    .{
        .id = "zig-utils-clipboard-available-formats",
        .name = "clipboardAvailableFormats (Zig)",
        .category = "Utils",
        .description = "Read clipboard formats through the Zig SDK.",
        .mirrors_bun_test_name = "clipboardAvailableFormats",
        .kind = .utils_clipboard_available_formats,
    },
    .{
        .id = "zig-utils-clipboard-clear",
        .name = "clipboardClear (Zig)",
        .category = "Utils",
        .description = "Clear clipboard text through the Zig SDK.",
        .mirrors_bun_test_name = "clipboardClear",
        .kind = .utils_clipboard_clear,
    },
    .{
        .id = "zig-utils-show-notification",
        .name = "showNotification (Zig)",
        .category = "Utils",
        .description = "Send a desktop notification through the Zig SDK.",
        .mirrors_bun_test_name = "showNotification",
        .kind = .utils_show_notification,
    },
    .{
        .id = "zig-utils-open-external-exists",
        .name = "openExternal (Zig)",
        .category = "Utils",
        .description = "Verify the Zig SDK exposes openExternal without invoking side effects.",
        .mirrors_bun_test_name = "openExternal",
        .kind = .utils_open_external_exists,
    },
    .{
        .id = "zig-utils-open-path-exists",
        .name = "openPath (Zig)",
        .category = "Utils",
        .description = "Verify the Zig SDK exposes openPath without invoking side effects.",
        .mirrors_bun_test_name = "openPath",
        .kind = .utils_open_path_exists,
    },
    .{
        .id = "zig-utils-show-item-in-folder-exists",
        .name = "showItemInFolder (Zig)",
        .category = "Utils",
        .description = "Verify the Zig SDK exposes showItemInFolder without invoking side effects.",
        .mirrors_bun_test_name = "showItemInFolder",
        .kind = .utils_show_item_in_folder_exists,
    },
    .{
        .id = "zig-utils-quit-function-exists",
        .name = "quit function exists (Zig)",
        .category = "Utils",
        .description = "Verify the Zig SDK exposes a quit helper without invoking it.",
        .mirrors_bun_test_name = "quit function exists",
        .kind = .utils_quit_exists,
    },
    .{
        .id = "zig-utils-paths-object-exists",
        .name = "paths object exists (Zig)",
        .category = "Utils",
        .description = "Resolve the Zig SDK paths object and verify it is populated.",
        .mirrors_bun_test_name = "paths object exists",
        .kind = .utils_paths_object_exists,
    },
    .{
        .id = "zig-utils-paths-home-matches",
        .name = "paths.home matches os.homedir() (Zig)",
        .category = "Utils",
        .description = "Verify Zig SDK paths.home matches the process home directory.",
        .mirrors_bun_test_name = "paths.home matches os.homedir()",
        .kind = .utils_paths_home_matches,
    },
    .{
        .id = "zig-utils-paths-temp-matches",
        .name = "paths.temp matches os.tmpdir() (Zig)",
        .category = "Utils",
        .description = "Verify Zig SDK paths.temp matches the process temp directory.",
        .mirrors_bun_test_name = "paths.temp matches os.tmpdir()",
        .kind = .utils_paths_temp_matches,
    },
    .{
        .id = "zig-utils-paths-os-directories",
        .name = "paths OS directories return non-empty strings (Zig)",
        .category = "Utils",
        .description = "Verify the Zig SDK resolves non-empty OS-level directories.",
        .mirrors_bun_test_name = "paths OS directories return non-empty strings",
        .kind = .utils_paths_os_directories,
    },
    .{
        .id = "zig-utils-paths-app-scoped-directories",
        .name = "paths app-scoped directories return non-empty strings (Zig)",
        .category = "Utils",
        .description = "Verify the Zig SDK resolves non-empty app-scoped data/cache/log directories.",
        .mirrors_bun_test_name = "paths app-scoped directories return non-empty strings",
        .kind = .utils_paths_app_scoped_directories,
    },
    .{
        .id = "zig-utils-paths-stable-across-calls",
        .name = "paths getters are stable across calls (Zig)",
        .category = "Utils",
        .description = "Verify repeated Zig SDK path resolution returns the same string values.",
        .mirrors_bun_test_name = "paths getters are stable across calls",
        .kind = .utils_paths_stable_across_calls,
    },
    .{
        .id = "zig-utils-move-to-trash",
        .name = "moveToTrash (Zig)",
        .category = "Utils",
        .description = "Move a temporary file to trash through the Zig SDK.",
        .mirrors_bun_test_name = "moveToTrash",
        .kind = .utils_move_to_trash,
    },
    .{
        .id = "zig-screen-primary-display",
        .name = "getPrimaryDisplay (Zig)",
        .category = "Screen",
        .description = "Read the primary display through the Zig SDK.",
        .mirrors_bun_test_name = "getPrimaryDisplay",
        .kind = .screen_primary_display,
    },
    .{
        .id = "zig-screen-all-displays",
        .name = "getAllDisplays (Zig)",
        .category = "Screen",
        .description = "Read all connected displays through the Zig SDK.",
        .mirrors_bun_test_name = "getAllDisplays",
        .kind = .screen_all_displays,
    },
    .{
        .id = "zig-screen-cursor-screen-point",
        .name = "getCursorScreenPoint (Zig)",
        .category = "Screen",
        .description = "Read the current cursor position through the Zig SDK.",
        .mirrors_bun_test_name = "getCursorScreenPoint",
        .kind = .screen_cursor_screen_point,
    },
    .{
        .id = "zig-screen-bounds-vs-workarea",
        .name = "Display bounds vs workArea (Zig)",
        .category = "Screen",
        .description = "Verify primary display workArea fits within bounds in Zig mode.",
        .mirrors_bun_test_name = "Display bounds vs workArea",
        .kind = .screen_bounds_vs_workarea,
    },
};

const AppState = struct {
    allocator: std.mem.Allocator,
    core: *electrobun.Core,
    bundle_paths: *const electrobun.BundlePaths,
    app_info: electrobun.AppInfo,
    default_renderer: electrobun.Renderer = .native,
    cef_available: bool = false,
    cef_version: ?[]u8 = null,
    child_webviews: std.AutoHashMap(u32, ChildWebviewState),
    top_level_webview_windows: std.AutoHashMap(u32, u32),
    test_runner_window_id: u32 = 0,
    test_runner_webview_id: u32 = 0,
    search_query: ?[]u8 = null,
    auto_run_test_name: ?[]u8 = null,
    auto_run_all: bool = false,
    auto_run_triggered: bool = false,
    application_menu_target_webview_id: u32 = 0,
    context_menu_target_webview_id: u32 = 0,
    shortcut_target_webview_id: u32 = 0,
    quit_target_webview_id: u32 = 0,
    before_quit_should_cancel: bool = false,
    menu_data_counter: u32 = 0,
    menu_data_registry: std.StringHashMap([]u8),
    mutex: std.Thread.Mutex = .{},

    fn deinit(self: *AppState) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.search_query) |query| {
            self.allocator.free(query);
            self.search_query = null;
        }
        if (self.auto_run_test_name) |test_name| {
            self.allocator.free(test_name);
            self.auto_run_test_name = null;
        }
        if (self.cef_version) |cef_version| {
            self.allocator.free(cef_version);
            self.cef_version = null;
        }
        var iterator = self.menu_data_registry.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.*);
        }
        self.menu_data_registry.deinit();
        self.child_webviews.deinit();
        self.top_level_webview_windows.deinit();
    }
};

const ChildWebviewState = struct {
    renderer: electrobun.Renderer,
};

const CreateUiContext = struct {
    state: *AppState,
};

const SingleTestJob = struct {
    webview_id: u32,
    request_id: ?u64,
    zig_test: ZigTest,
};

const AllTestsJob = struct {
    webview_id: u32,
    request_id: ?u64,
    interactive_only: bool,
};

var g_state: ?*AppState = null;

fn appState() *AppState {
    return g_state orelse @panic("electrobun kitchen zig state not initialized");
}

fn configureRuntimeBuildConfig(state: *AppState) !void {
    const build_json_path = try std.fs.path.join(state.allocator, &.{ state.bundle_paths.resources_dir, "build.json" });
    defer state.allocator.free(build_json_path);

    const build_json = try std.fs.cwd().readFileAlloc(state.allocator, build_json_path, 1024 * 1024);
    defer state.allocator.free(build_json);

    var parsed = try std.json.parseFromSlice(std.json.Value, state.allocator, build_json, .{});
    defer parsed.deinit();

    if (parsed.value != .object) {
        return;
    }

    if (parsed.value.object.get("defaultRenderer")) |default_renderer_value| {
        if (default_renderer_value == .string and std.mem.eql(u8, default_renderer_value.string, "cef")) {
            state.default_renderer = .cef;
        }
    }

    if (parsed.value.object.get("availableRenderers")) |available_renderers_value| {
        if (available_renderers_value == .array) {
            for (available_renderers_value.array.items) |renderer_value| {
                if (renderer_value == .string and std.mem.eql(u8, renderer_value.string, "cef")) {
                    state.cef_available = true;
                    break;
                }
            }
        }
    }

    if (parsed.value.object.get("cefVersion")) |cef_version_value| {
        if (cef_version_value == .string) {
            state.cef_version = try state.allocator.dupe(u8, cef_version_value.string);
        }
    }
}

fn buildConfigPayload() BuildConfigPayload {
    const state = appState();
    const available_renderers = if (state.cef_available)
        available_renderers_cef[0..]
    else
        available_renderers_native[0..];

    return .{
        .defaultRenderer = @tagName(state.default_renderer),
        .availableRenderers = available_renderers,
        .mainProcess = "zig",
        .cefVersion = state.cef_version,
        .zigVersion = builtin.zig_version_string,
    };
}

fn updateInfoPayload() UpdateInfo {
    return .{
        .status = "no-update",
        .currentVersion = app_version,
    };
}

fn sendRpcMessage(webview_id: u32, message_id: []const u8, payload: anytype) void {
    const packet = .{
        .type = "message",
        .id = message_id,
        .payload = payload,
    };

    appState().core.sendHostMessageToWebview(webview_id, packet) catch |err| {
        std.debug.print("[kitchen zig] failed to send RPC message '{s}': {s}\n", .{ message_id, @errorName(err) });
    };
}

fn sendRpcResponseSuccess(webview_id: u32, request_id: u64, payload: anytype) void {
    const packet = .{
        .type = "response",
        .id = request_id,
        .success = true,
        .payload = payload,
    };

    appState().core.sendHostMessageToWebview(webview_id, packet) catch |err| {
        std.debug.print("[kitchen zig] failed to send RPC response #{d}: {s}\n", .{ request_id, @errorName(err) });
    };
}

fn sendRpcResponseError(webview_id: u32, request_id: u64, error_message: []const u8) void {
    const packet = .{
        .type = "response",
        .id = request_id,
        .success = false,
        .@"error" = error_message,
    };

    appState().core.sendHostMessageToWebview(webview_id, packet) catch |err| {
        std.debug.print("[kitchen zig] failed to send RPC error #{d}: {s}\n", .{ request_id, @errorName(err) });
    };
}

fn sendBuildConfig(webview_id: u32) void {
    sendRpcMessage(webview_id, "buildConfig", buildConfigPayload());
}

fn sendUpdateStatus(webview_id: u32) void {
    sendRpcMessage(webview_id, "updateStatus", updateInfoPayload());
}

fn sendInitialUiState(webview_id: u32) void {
    sendBuildConfig(webview_id);
    sendUpdateStatus(webview_id);
}

fn sendTestLog(webview_id: u32, test_id: []const u8, message: []const u8) void {
    sendRpcMessage(webview_id, "testLog", .{
        .testId = test_id,
        .message = message,
    });
}

fn findTestById(test_id: []const u8) ?ZigTest {
    for (zig_tests) |zig_test| {
        if (std.mem.eql(u8, zig_test.id, test_id)) {
            return zig_test;
        }
    }
    return null;
}

fn findTestByName(test_name: []const u8) ?ZigTest {
    for (zig_tests) |zig_test| {
        if (std.mem.eql(u8, zig_test.name, test_name)) {
            return zig_test;
        }
    }
    return null;
}

fn getSearchQuery() []const u8 {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.search_query orelse "";
}

fn setSearchQuery(next: []const u8) !void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();

    const query_copy = try state.allocator.dupe(u8, next);
    if (state.search_query) |existing| {
        state.allocator.free(existing);
    }
    state.search_query = query_copy;
}

fn getJsonField(object: *const std.json.ObjectMap, key: []const u8) ?std.json.Value {
    return object.get(key);
}

fn getJsonStringField(object: *const std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = getJsonField(object, key) orelse return null;
    return if (value == .string) value.string else null;
}

fn getJsonNullableStringField(object: *const std.json.ObjectMap, key: []const u8) ?[]const u8 {
    const value = getJsonField(object, key) orelse return null;
    return switch (value) {
        .string => value.string,
        .null => null,
        else => null,
    };
}

fn getJsonBoolField(object: *const std.json.ObjectMap, key: []const u8, default_value: bool) bool {
    const value = getJsonField(object, key) orelse return default_value;
    return if (value == .bool) value.bool else default_value;
}

fn getJsonF64Field(object: *const std.json.ObjectMap, key: []const u8, default_value: f64) f64 {
    const value = getJsonField(object, key) orelse return default_value;
    return switch (value) {
        .float => value.float,
        .integer => @floatFromInt(value.integer),
        else => default_value,
    };
}

fn getJsonU32Field(object: *const std.json.ObjectMap, key: []const u8, default_value: u32) u32 {
    const value = getJsonField(object, key) orelse return default_value;
    return switch (value) {
        .integer => if (value.integer >= 0) @intCast(value.integer) else default_value,
        else => default_value,
    };
}

fn runZigTest(zig_test: ZigTest) TestResult {
    const state = appState();
    const started_ns = std.time.nanoTimestamp();

    const run_result = switch (zig_test.kind) {
        .smoke => runSmokeTest(),
        .window_create_close => runWindowCreateCloseTest(state),
        .window_creation_with_url => runWindowCreationWithUrlTest(state),
        .window_hidden_option => runWindowHiddenOptionTest(state),
        .window_inactive_show_api => runWindowInactiveShowApiTest(state),
        .window_page_zoom => runWindowPageZoomTest(state),
        .window_set_title => runWindowSetTitleTest(state),
        .window_minimize_unminimize => runWindowMinimizeUnminimizeTest(state),
        .window_fullscreen_toggle => runWindowFullscreenToggleTest(state),
        .window_fullscreen_toggle_hidden_titlebar => runWindowFullscreenToggleHiddenTitlebarTest(state),
        .window_set_position => runWindowSetPositionTest(state),
        .window_set_size => runWindowSetSizeTest(state),
        .window_set_frame => runWindowSetFrameTest(state),
        .window_get_frame => runWindowGetFrameTest(state),
        .window_get_position => runWindowGetPositionTest(state),
        .window_get_size => runWindowGetSizeTest(state),
        .window_maximize_unmaximize => runWindowMaximizeUnmaximizeTest(state),
        .window_always_on_top => runWindowAlwaysOnTopTest(state),
        .window_visible_on_all_workspaces => runWindowVisibleOnAllWorkspacesTest(state),
        .window_focus => runWindowFocusTest(state),
        .window_close_event => runWindowCloseEventTest(state),
        .window_resize_event => runWindowResizeEventTest(state),
        .window_get_by_id => runWindowGetByIdTest(state),
        .window_inset_titlebar_style => runWindowInsetTitlebarStyleTest(state),
        .window_traffic_light_position_api => runWindowTrafficLightPositionApiTest(state),
        .webview_create => runWebviewCreateTest(state),
        .webview_page_zoom => runWebviewPageZoomTest(state),
        .webview_tag_playground_integration => runWebviewTagPlaygroundIntegrationTest(state),
        .webview_tag_playground_interactive => runWebviewTagPlaygroundInteractiveTest(state),
        .wgpu_tag_playground_integration => runWgpuTagPlaygroundIntegrationTest(state),
        .wgpu_tag_playground_interactive => runWgpuTagPlaygroundInteractiveTest(state),
        .navigation_load_url => runNavigationLoadUrlTest(state),
        .navigation_load_html => runNavigationLoadHtmlTest(state),
        .navigation_dom_ready_event => runNavigationDomReadyEventTest(state),
        .navigation_did_navigate_event => runNavigationDidNavigateEventTest(state),
        .navigation_execute_javascript => runNavigationExecuteJavascriptTest(state),
        .tray_visibility_toggle_and_bounds => runTrayVisibilityToggleAndBoundsTest(state),
        .session_from_partition => runSessionFromPartitionTest(state),
        .session_default_session => runSessionDefaultSessionTest(state),
        .session_cookies_api_exists => runSessionCookiesApiExistsTest(state),
        .application_menu_playground => runApplicationMenuPlaygroundTest(state),
        .context_menu_playground => runContextMenuPlaygroundTest(state),
        .dialog_show_message_box_info => runShowMessageBoxInfoDialogTest(state),
        .dialog_file_dialog_playground => runFileDialogPlaygroundTest(state),
        .global_shortcuts_playground => runGlobalShortcutsPlaygroundTest(state),
        .global_shortcut_is_registered_api => runGlobalShortcutIsRegisteredApiTest(state),
        .global_shortcut_unregister_all_api => runGlobalShortcutUnregisterAllApiTest(state),
        .lifecycle_before_quit_cancel => runLifecycleBeforeQuitCancelTest(state),
        .quit_shutdown_playground => runQuitShutdownPlaygroundTest(state),
        .wgpu_adapter_context_device => runWgpuAdapterContextDeviceTest(state),
        .dock_icon_visibility_contract => runDockIconVisibilityContractTest(state),
        .utils_clipboard_round_trip => runUtilsClipboardRoundTripTest(state),
        .utils_clipboard_available_formats => runUtilsClipboardAvailableFormatsTest(state),
        .utils_clipboard_clear => runUtilsClipboardClearTest(state),
        .utils_show_notification => runUtilsShowNotificationTest(state),
        .utils_open_external_exists => runUtilsOpenExternalExistsTest(),
        .utils_open_path_exists => runUtilsOpenPathExistsTest(),
        .utils_show_item_in_folder_exists => runUtilsShowItemInFolderExistsTest(),
        .utils_quit_exists => runUtilsQuitExistsTest(),
        .utils_paths_object_exists => runUtilsPathsObjectExistsTest(state),
        .utils_paths_home_matches => runUtilsPathsHomeMatchesTest(state),
        .utils_paths_temp_matches => runUtilsPathsTempMatchesTest(state),
        .utils_paths_os_directories => runUtilsPathsOsDirectoriesTest(state),
        .utils_paths_app_scoped_directories => runUtilsPathsAppScopedDirectoriesTest(state),
        .utils_paths_stable_across_calls => runUtilsPathsStableAcrossCallsTest(state),
        .utils_move_to_trash => runUtilsMoveToTrashTest(state),
        .screen_primary_display => runScreenPrimaryDisplayTest(state),
        .screen_all_displays => runScreenAllDisplaysTest(state),
        .screen_cursor_screen_point => runScreenCursorScreenPointTest(state),
        .screen_bounds_vs_workarea => runScreenBoundsVsWorkAreaTest(state),
    };

    const elapsed_ns = std.time.nanoTimestamp() - started_ns;
    const elapsed_ms: u64 = @intCast(@divTrunc(elapsed_ns, std.time.ns_per_ms));

    if (run_result) {
        return .{
            .testId = zig_test.id,
            .name = zig_test.name,
            .status = "passed",
            .duration = elapsed_ms,
        };
    } else |err| {
        return .{
            .testId = zig_test.id,
            .name = zig_test.name,
            .status = "failed",
            .duration = elapsed_ms,
            .@"error" = @errorName(err),
        };
    }
}

fn runSmokeTest() !void {
    return;
}

const WindowWithWebview = struct {
    window_id: u32,
    webview_id: u32,
};

const CallbackState = struct {
    mutex: std.Thread.Mutex = .{},
    window_close_count: u32 = 0,
    window_resize_count: u32 = 0,
    window_focus_count: u32 = 0,
    last_resize_width: f64 = 0,
    last_resize_height: f64 = 0,
    webview_will_navigate_count: u32 = 0,
    webview_did_navigate_count: u32 = 0,
    webview_dom_ready_count: u32 = 0,
    webview_tag_init_count: u32 = 0,
    wgpu_tag_init_count: u32 = 0,
    wgpu_tag_ready_count: u32 = 0,
    before_quit_count: u32 = 0,
    reopen_count: u32 = 0,
    url_open_count: u32 = 0,
    last_open_url: [1024]u8 = [_]u8{0} ** 1024,
    last_open_url_len: usize = 0,
    last_webview_detail: [1024]u8 = [_]u8{0} ** 1024,
    last_webview_detail_len: usize = 0,

    fn reset(self: *CallbackState) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.window_close_count = 0;
        self.window_resize_count = 0;
        self.window_focus_count = 0;
        self.last_resize_width = 0;
        self.last_resize_height = 0;
        self.webview_will_navigate_count = 0;
        self.webview_did_navigate_count = 0;
        self.webview_dom_ready_count = 0;
        self.webview_tag_init_count = 0;
        self.wgpu_tag_init_count = 0;
        self.wgpu_tag_ready_count = 0;
        self.before_quit_count = 0;
        self.reopen_count = 0;
        self.url_open_count = 0;
        self.last_open_url_len = 0;
        self.last_webview_detail_len = 0;
    }
};

var g_callback_state = CallbackState{};

fn sleepMs(ms: u64) void {
    std.time.sleep(ms * std.time.ns_per_ms);
}

fn approxEq(a: f64, b: f64, tolerance: f64) bool {
    return @abs(a - b) <= tolerance;
}

fn resetCallbackState() void {
    g_callback_state.reset();
}

fn getWindowCloseCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.window_close_count;
}

fn getWindowResizeCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.window_resize_count;
}

fn getWindowFocusCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.window_focus_count;
}

fn getLastResizeSize() electrobun.Rect {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return .{
        .width = g_callback_state.last_resize_width,
        .height = g_callback_state.last_resize_height,
    };
}

fn getWebviewWillNavigateCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.webview_will_navigate_count;
}

fn getWebviewDidNavigateCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.webview_did_navigate_count;
}

fn getWebviewDomReadyCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.webview_dom_ready_count;
}

fn getWebviewTagInitCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.webview_tag_init_count;
}

fn getWgpuTagInitCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.wgpu_tag_init_count;
}

fn getWgpuTagReadyCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.wgpu_tag_ready_count;
}

fn getBeforeQuitCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.before_quit_count;
}

fn getReopenCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.reopen_count;
}

fn getUrlOpenCount() u32 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.url_open_count;
}

fn getLastOpenUrl() []const u8 {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return g_callback_state.last_open_url[0..g_callback_state.last_open_url_len];
}

fn lastWebviewDetailContains(needle: []const u8) bool {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    return std.mem.indexOf(
        u8,
        g_callback_state.last_webview_detail[0..g_callback_state.last_webview_detail_len],
        needle,
    ) != null;
}

fn observedWindowClose(_: u32) callconv(.C) void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.window_close_count += 1;
}

fn observedWindowResize(_: u32, _: f64, _: f64, width: f64, height: f64) callconv(.C) void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.window_resize_count += 1;
    g_callback_state.last_resize_width = width;
    g_callback_state.last_resize_height = height;
}

fn observedWindowFocus(_: u32) callconv(.C) void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.window_focus_count += 1;
}

fn recordObservedWebviewEvent(event_name_slice: []const u8, detail_slice: []const u8) void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();

    if (std.mem.eql(u8, event_name_slice, "will-navigate")) {
        g_callback_state.webview_will_navigate_count += 1;
    } else if (std.mem.eql(u8, event_name_slice, "did-navigate")) {
        g_callback_state.webview_did_navigate_count += 1;
    } else if (std.mem.eql(u8, event_name_slice, "dom-ready")) {
        g_callback_state.webview_dom_ready_count += 1;
    }

    const copy_len = @min(detail_slice.len, g_callback_state.last_webview_detail.len - 1);
    @memcpy(g_callback_state.last_webview_detail[0..copy_len], detail_slice[0..copy_len]);
    g_callback_state.last_webview_detail_len = copy_len;
    if (copy_len < g_callback_state.last_webview_detail.len) {
        g_callback_state.last_webview_detail[copy_len] = 0;
    }
}

fn recordWebviewTagInit() void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.webview_tag_init_count += 1;
}

fn recordWgpuTagInit() void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.wgpu_tag_init_count += 1;
}

fn recordWgpuTagReady() void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.wgpu_tag_ready_count += 1;
}

fn recordBeforeQuit() void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.before_quit_count += 1;
}

fn recordReopen() void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.reopen_count += 1;
}

fn recordUrlOpen(url: []const u8) void {
    g_callback_state.mutex.lock();
    defer g_callback_state.mutex.unlock();
    g_callback_state.url_open_count += 1;
    const copy_len = @min(url.len, g_callback_state.last_open_url.len - 1);
    @memcpy(g_callback_state.last_open_url[0..copy_len], url[0..copy_len]);
    g_callback_state.last_open_url_len = copy_len;
    if (copy_len < g_callback_state.last_open_url.len) {
        g_callback_state.last_open_url[copy_len] = 0;
    }
}

fn observedWebviewEvent(_: u32, event_name: [*:0]const u8, detail: [*:0]const u8) callconv(.C) void {
    recordObservedWebviewEvent(std.mem.span(event_name), std.mem.span(detail));
}

fn observedWebviewBridge(_: u32, message: [*:0]const u8) callconv(.C) u32 {
    const message_slice = std.mem.span(message);
    if (message_slice.len == 0) {
        return 0;
    }

    var parsed = std.json.parseFromSlice(std.json.Value, std.heap.page_allocator, message_slice, .{}) catch {
        return 0;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return 0;
    }

    const id_value = parsed.value.object.get("id") orelse return 0;
    const type_value = parsed.value.object.get("type") orelse return 0;
    if (id_value != .string or type_value != .string) {
        return 0;
    }

    if (!std.mem.eql(u8, id_value.string, "webviewEvent") or !std.mem.eql(u8, type_value.string, "message")) {
        return 0;
    }

    const payload_value = parsed.value.object.get("payload") orelse return 0;
    if (payload_value != .object) {
        return 0;
    }

    const event_name_value = payload_value.object.get("eventName") orelse return 0;
    const detail_value = payload_value.object.get("detail") orelse return 0;
    if (event_name_value != .string or detail_value != .string) {
        return 0;
    }

    recordObservedWebviewEvent(event_name_value.string, detail_value.string);
    return 0;
}

fn childWebviewRenderer(webview_id: u32) electrobun.Renderer {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    if (state.child_webviews.get(webview_id)) |child_state| {
        return child_state.renderer;
    }
    return .native;
}

fn rememberChildWebview(webview_id: u32, renderer: electrobun.Renderer) !void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    try state.child_webviews.put(webview_id, .{ .renderer = renderer });
}

fn forgetChildWebview(webview_id: u32) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    _ = state.child_webviews.remove(webview_id);
}

fn rememberTopLevelWebview(webview_id: u32, window_id: u32) !void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    try state.top_level_webview_windows.put(webview_id, window_id);
}

fn forgetTopLevelWebview(webview_id: u32) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    _ = state.top_level_webview_windows.remove(webview_id);
}

fn windowIdForTopLevelWebview(webview_id: u32) ?u32 {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.top_level_webview_windows.get(webview_id);
}

fn clearChildWebviews() void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    state.child_webviews.clearRetainingCapacity();
}

const electrobun_menu_delimiter = "|EB|";

fn activePlaygroundRenderer(state: *AppState) electrobun.Renderer {
    return if (state.cef_available and state.default_renderer == .cef) .cef else .native;
}

fn defaultMenuRoleLabel(role: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, role, "about")) return "About";
    if (std.mem.eql(u8, role, "quit")) return "Quit";
    if (std.mem.eql(u8, role, "hide")) return "Hide";
    if (std.mem.eql(u8, role, "hideOthers")) return "Hide Others";
    if (std.mem.eql(u8, role, "showAll")) return "Show All";
    if (std.mem.eql(u8, role, "minimize")) return "Minimize";
    if (std.mem.eql(u8, role, "zoom")) return "Zoom";
    if (std.mem.eql(u8, role, "close")) return "Close";
    if (std.mem.eql(u8, role, "bringAllToFront")) return "Bring All To Front";
    if (std.mem.eql(u8, role, "cycleThroughWindows")) return "Cycle Through Windows";
    if (std.mem.eql(u8, role, "enterFullScreen")) return "Enter Full Screen";
    if (std.mem.eql(u8, role, "exitFullScreen")) return "Exit Full Screen";
    if (std.mem.eql(u8, role, "toggleFullScreen")) return "Toggle Full Screen";
    if (std.mem.eql(u8, role, "undo")) return "Undo";
    if (std.mem.eql(u8, role, "redo")) return "Redo";
    if (std.mem.eql(u8, role, "cut")) return "Cut";
    if (std.mem.eql(u8, role, "copy")) return "Copy";
    if (std.mem.eql(u8, role, "paste")) return "Paste";
    if (std.mem.eql(u8, role, "pasteAndMatchStyle")) return "Paste and Match Style";
    if (std.mem.eql(u8, role, "delete")) return "Delete";
    if (std.mem.eql(u8, role, "selectAll")) return "Select All";
    if (std.mem.eql(u8, role, "startSpeaking")) return "Start Speaking";
    if (std.mem.eql(u8, role, "stopSpeaking")) return "Stop Speaking";
    if (std.mem.eql(u8, role, "showHelp")) return "Show Help";
    return null;
}

fn setApplicationMenuTargetWebview(webview_id: u32) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    state.application_menu_target_webview_id = webview_id;
}

fn applicationMenuTargetWebview() u32 {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.application_menu_target_webview_id;
}

fn setContextMenuTargetWebview(webview_id: u32) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    state.context_menu_target_webview_id = webview_id;
}

fn contextMenuTargetWebview() u32 {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.context_menu_target_webview_id;
}

fn setShortcutTargetWebview(webview_id: u32) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    state.shortcut_target_webview_id = webview_id;
}

fn shortcutTargetWebview() u32 {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.shortcut_target_webview_id;
}

fn setQuitTargetWebview(webview_id: u32) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    state.quit_target_webview_id = webview_id;
}

fn quitTargetWebview() u32 {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.quit_target_webview_id;
}

fn setBeforeQuitShouldCancel(cancel: bool) void {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    state.before_quit_should_cancel = cancel;
}

fn beforeQuitShouldCancel() bool {
    const state = appState();
    state.mutex.lock();
    defer state.mutex.unlock();
    return state.before_quit_should_cancel;
}

fn storeMenuData(value: std.json.Value) ![]const u8 {
    const state = appState();
    const data_json = try std.json.stringifyAlloc(state.allocator, value, .{});
    errdefer state.allocator.free(data_json);

    state.mutex.lock();
    defer state.mutex.unlock();

    state.menu_data_counter += 1;
    const data_id = try std.fmt.allocPrint(state.allocator, "menuData_{d}", .{state.menu_data_counter});
    errdefer state.allocator.free(data_id);

    try state.menu_data_registry.put(data_id, data_json);
    return data_id;
}

fn rewriteMenuActions(value: *std.json.Value, arena_allocator: std.mem.Allocator) !void {
    switch (value.*) {
        .array => |*array| {
            for (array.items) |*item| {
                try rewriteMenuActions(item, arena_allocator);
            }
        },
        .object => |*object| {
            if (!object.contains("enabled")) {
                try object.put("enabled", .{ .bool = true });
            }
            if (!object.contains("checked")) {
                try object.put("checked", .{ .bool = false });
            }
            if (!object.contains("hidden")) {
                try object.put("hidden", .{ .bool = false });
            }
            if (!object.contains("type")) {
                if (object.get("submenu") != null) {
                    try object.put("type", .{ .string = "submenu" });
                } else if (object.get("label")) |label_value| {
                    if (label_value == .string and (label_value.string.len == 0 or std.mem.eql(u8, label_value.string, "-"))) {
                        try object.put("type", .{ .string = "divider" });
                    } else {
                        try object.put("type", .{ .string = "normal" });
                    }
                } else {
                    try object.put("type", .{ .string = "normal" });
                }
            }
            if (!object.contains("label")) {
                if (object.get("role")) |role_value| {
                    if (role_value == .string) {
                        if (defaultMenuRoleLabel(role_value.string)) |label| {
                            try object.put("label", .{ .string = label });
                        }
                    }
                }
            }
            if (object.getPtr("submenu")) |submenu| {
                try rewriteMenuActions(submenu, arena_allocator);
            }
            if (object.getPtr("action")) |action_value| {
                if (action_value.* == .string) {
                    if (object.get("data")) |data_value| {
                        const data_id = try storeMenuData(data_value);
                        const encoded_action = try std.fmt.allocPrint(
                            arena_allocator,
                            "{s}{s}|{s}",
                            .{ electrobun_menu_delimiter, data_id, action_value.string },
                        );
                        action_value.* = .{ .string = encoded_action };
                    }
                }
            }
        },
        else => {},
    }
}

fn prepareMenuJson(menu_value: std.json.Value) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(appState().allocator);
    defer arena.deinit();

    var mutable_menu = menu_value;
    try rewriteMenuActions(&mutable_menu, arena.allocator());
    return try std.json.stringifyAlloc(appState().allocator, mutable_menu, .{});
}

fn sendMenuClick(webview_id: u32, message_id: []const u8, encoded_action: []const u8) void {
    if (webview_id == 0) {
        return;
    }

    if (!std.mem.startsWith(u8, encoded_action, electrobun_menu_delimiter)) {
        sendRpcMessage(webview_id, message_id, .{
            .action = encoded_action,
        });
        return;
    }

    const remainder = encoded_action[electrobun_menu_delimiter.len..];
    const separator_index = std.mem.indexOfScalar(u8, remainder, '|') orelse {
        sendRpcMessage(webview_id, message_id, .{
            .action = encoded_action,
        });
        return;
    };

    const data_id = remainder[0..separator_index];
    const action = remainder[separator_index + 1 ..];

    const state = appState();
    state.mutex.lock();
    const removed = state.menu_data_registry.fetchRemove(data_id);
    state.mutex.unlock();

    if (removed) |entry| {
        defer {
            state.allocator.free(entry.key);
            state.allocator.free(entry.value);
        }

        var parsed = std.json.parseFromSlice(std.json.Value, state.allocator, entry.value, .{}) catch {
            sendRpcMessage(webview_id, message_id, .{ .action = action });
            return;
        };
        defer parsed.deinit();

        sendRpcMessage(webview_id, message_id, .{
            .action = action,
            .data = parsed.value,
        });
        return;
    }

    sendRpcMessage(webview_id, message_id, .{
        .action = action,
    });
}

fn applicationMenuHandler(_: u32, encoded_action: [*:0]const u8) callconv(.C) void {
    sendMenuClick(applicationMenuTargetWebview(), "menuClicked", std.mem.span(encoded_action));
}

fn contextMenuHandler(_: u32, encoded_action: [*:0]const u8) callconv(.C) void {
    sendMenuClick(contextMenuTargetWebview(), "contextMenuClicked", std.mem.span(encoded_action));
}

fn shortcutTriggeredHandler(accelerator: [*:0]const u8) callconv(.C) void {
    const webview_id = shortcutTargetWebview();
    if (webview_id == 0) {
        return;
    }
    sendRpcMessage(webview_id, "shortcutTriggered", .{
        .accelerator = std.mem.span(accelerator),
    });
}

fn quitRequestedHandler() callconv(.C) void {
    recordBeforeQuit();
    const webview_id = quitTargetWebview();
    if (webview_id != 0) {
        sendRpcMessage(webview_id, "beforeQuitFired", .{
            .message = "beforeQuit handler fired! Waiting 2 seconds for cleanup...",
        });
    }

    sleepMs(2000);

    if (webview_id != 0) {
        sendRpcMessage(webview_id, "beforeQuitDone", .{
            .message = if (beforeQuitShouldCancel())
                "beforeQuit cleanup complete (2s elapsed). Quit cancelled in Zig mode."
            else
                "beforeQuit cleanup complete (2s elapsed). Quitting now.",
        });
    }

    if (!beforeQuitShouldCancel()) {
        appState().core.quitGracefully(0);
    }
}

fn urlOpenHandler(url: [*:0]const u8) callconv(.C) void {
    recordUrlOpen(std.mem.span(url));
}

fn appReopenHandler() callconv(.C) void {
    if (builtin.os.tag == .macos) {
        appState().core.setDockIconVisible(true) catch {};
    }
    recordReopen();
}

fn splitCsvPaths(allocator: std.mem.Allocator, csv: []const u8) ![][]u8 {
    if (csv.len == 0) {
        return allocator.alloc([]u8, 0);
    }

    var list = std.ArrayList([]u8).init(allocator);
    errdefer {
        for (list.items) |item| {
            allocator.free(item);
        }
        list.deinit();
    }

    var iterator = std.mem.splitScalar(u8, csv, ',');
    while (iterator.next()) |part| {
        try list.append(try allocator.dupe(u8, part));
    }

    return try list.toOwnedSlice();
}

fn releaseSplitCsvPaths(allocator: std.mem.Allocator, items: [][]u8) void {
    for (items) |item| {
        allocator.free(item);
    }
    allocator.free(items);
}

fn expandTildePathAlloc(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    if (path.len == 0 or path[0] != '~') {
        return allocator.dupe(u8, path);
    }

    const home = try std.process.getEnvVarOwned(allocator, "HOME");
    defer allocator.free(home);

    if (path.len == 1) {
        return allocator.dupe(u8, home);
    }
    if (path.len >= 2 and path[1] == '/') {
        return std.fs.path.join(allocator, &.{ home, path[2..] });
    }
    return allocator.dupe(u8, path);
}

fn sendInternalBridgeResponse(host_webview_id: u32, request_id: []const u8, success: bool, payload: anytype) void {
    appState().core.sendInternalMessageToWebview(host_webview_id, .{
        .type = "response",
        .id = request_id,
        .success = success,
        .payload = payload,
    }) catch |err| {
        std.debug.print("[kitchen zig] failed to send internal bridge response '{s}': {s}\n", .{ request_id, @errorName(err) });
    };
}

fn sendInternalBridgeError(host_webview_id: u32, request_id: []const u8, message: []const u8) void {
    sendInternalBridgeResponse(host_webview_id, request_id, false, message);
}

fn createChildWebviewFromInternalBridge(host_webview_id: u32, params_object: *const std.json.ObjectMap) !u32 {
    const renderer_string = getJsonStringField(params_object, "renderer") orelse "native";
    const renderer: electrobun.Renderer = if (std.mem.eql(u8, renderer_string, "cef")) .cef else .native;
    const url = getJsonNullableStringField(params_object, "url");
    const html = getJsonNullableStringField(params_object, "html");
    const preload = getJsonNullableStringField(params_object, "preload") orelse "";
    const partition = getJsonNullableStringField(params_object, "partition") orelse "persist:default";
    const window_id = getJsonU32Field(params_object, "windowId", 0);
    const sandbox = getJsonBoolField(params_object, "sandbox", false);
    const transparent = getJsonBoolField(params_object, "transparent", false);
    const passthrough = getJsonBoolField(params_object, "passthrough", false);

    const frame_value = getJsonField(params_object, "frame") orelse return error.MissingFrame;
    if (frame_value != .object) {
        return error.InvalidFrame;
    }

    const frame = electrobun.Rect{
        .x = getJsonF64Field(&frame_value.object, "x", 0),
        .y = getJsonF64Field(&frame_value.object, "y", 0),
        .width = getJsonF64Field(&frame_value.object, "width", 0),
        .height = getJsonF64Field(&frame_value.object, "height", 0),
    };

    const effective_url = if (url != null)
        url.?
    else if (html == null)
        "https://electrobun.dev"
    else
        "";

    const webview_id = try appState().core.createWebview(.{
        .window_id = window_id,
        .host_webview_id = host_webview_id,
        .renderer = renderer,
        .url = effective_url,
        .frame = frame,
        .auto_resize = false,
        .partition = partition,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = electrobun.noopWebviewEvent,
            .event_bridge = electrobun.noopWebviewPostMessage,
            .host_bridge = electrobun.noopWebviewPostMessage,
            .internal_bridge = electrobun.noopWebviewPostMessage,
        },
        .secret_key = default_secret_key,
        .preload = preload,
        .sandbox = sandbox,
        .start_transparent = transparent,
        .start_passthrough = passthrough,
    });

    try rememberChildWebview(webview_id, renderer);
    recordWebviewTagInit();

    if (html) |html_value| {
        if (renderer == .cef) {
            try appState().core.setWebviewHTMLContent(webview_id, html_value);
            try appState().core.loadURLInWebview(webview_id, "views://internal/index.html");
        } else {
            try appState().core.loadHTMLInWebview(webview_id, html_value);
        }
    }

    return webview_id;
}

fn createWgpuViewFromInternalBridge(params_object: *const std.json.ObjectMap) !u32 {
    const window_id = getJsonU32Field(params_object, "windowId", 0);
    const transparent = getJsonBoolField(params_object, "transparent", false);
    const passthrough = getJsonBoolField(params_object, "passthrough", false);

    const frame_value = getJsonField(params_object, "frame") orelse return error.MissingFrame;
    if (frame_value != .object) {
        return error.InvalidFrame;
    }

    const frame = electrobun.Rect{
        .x = getJsonF64Field(&frame_value.object, "x", 0),
        .y = getJsonF64Field(&frame_value.object, "y", 0),
        .width = getJsonF64Field(&frame_value.object, "width", 0),
        .height = getJsonF64Field(&frame_value.object, "height", 0),
    };

    const wgpu_view_id = try appState().core.createWGPUView(.{
        .window_id = window_id,
        .frame = frame,
        .auto_resize = false,
        .start_transparent = transparent,
        .start_passthrough = passthrough,
    });

    recordWgpuTagInit();
    return wgpu_view_id;
}

fn handleInternalBridgeRequest(host_webview_id: u32, request_id: []const u8, method: []const u8, params_object: *const std.json.ObjectMap) void {
    if (std.mem.eql(u8, method, "webviewTagInit")) {
        const webview_id = createChildWebviewFromInternalBridge(host_webview_id, params_object) catch |err| {
            sendInternalBridgeError(host_webview_id, request_id, @errorName(err));
            return;
        };
        sendInternalBridgeResponse(host_webview_id, request_id, true, webview_id);
        return;
    }

    if (std.mem.eql(u8, method, "webviewTagCanGoBack")) {
        sendInternalBridgeResponse(host_webview_id, request_id, true, appState().core.canWebviewGoBack(getJsonU32Field(params_object, "id", 0)));
        return;
    }

    if (std.mem.eql(u8, method, "webviewTagCanGoForward")) {
        sendInternalBridgeResponse(host_webview_id, request_id, true, appState().core.canWebviewGoForward(getJsonU32Field(params_object, "id", 0)));
        return;
    }

    if (std.mem.eql(u8, method, "wgpuTagInit")) {
        const wgpu_view_id = createWgpuViewFromInternalBridge(params_object) catch |err| {
            sendInternalBridgeError(host_webview_id, request_id, @errorName(err));
            return;
        };
        sendInternalBridgeResponse(host_webview_id, request_id, true, wgpu_view_id);
        return;
    }

    sendInternalBridgeError(host_webview_id, request_id, "Unsupported internal bridge request");
}

fn handleInternalBridgeMessage(message_id: []const u8, params_object: *const std.json.ObjectMap) void {
    const webview_id = getJsonU32Field(params_object, "id", 0);
    if (webview_id == 0) {
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagResize")) {
        const frame_value = getJsonField(params_object, "frame") orelse return;
        if (frame_value != .object) {
            return;
        }
        const frame = electrobun.Rect{
            .x = getJsonF64Field(&frame_value.object, "x", 0),
            .y = getJsonF64Field(&frame_value.object, "y", 0),
            .width = getJsonF64Field(&frame_value.object, "width", 0),
            .height = getJsonF64Field(&frame_value.object, "height", 0),
        };
        const masks = getJsonStringField(params_object, "masks") orelse "[]";
        appState().core.resizeWebview(webview_id, frame, masks) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagUpdateSrc")) {
        const url = getJsonStringField(params_object, "url") orelse return;
        appState().core.loadURLInWebview(webview_id, url) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagUpdateHtml")) {
        const html = getJsonStringField(params_object, "html") orelse return;
        if (childWebviewRenderer(webview_id) == .cef) {
            appState().core.setWebviewHTMLContent(webview_id, html) catch {};
            appState().core.loadURLInWebview(webview_id, "views://internal/index.html") catch {};
        } else {
            appState().core.loadHTMLInWebview(webview_id, html) catch {};
        }
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagGoBack")) {
        appState().core.webviewGoBack(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagGoForward")) {
        appState().core.webviewGoForward(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagReload")) {
        appState().core.reloadWebview(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagRemove")) {
        appState().core.removeWebview(webview_id) catch {};
        forgetChildWebview(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetTransparent")) {
        appState().core.setWebviewTransparent(webview_id, getJsonBoolField(params_object, "transparent", false)) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetPassthrough")) {
        appState().core.setWebviewPassthrough(webview_id, getJsonBoolField(params_object, "enablePassthrough", false)) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetHidden")) {
        appState().core.setWebviewHidden(webview_id, getJsonBoolField(params_object, "hidden", false)) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetNavigationRules")) {
        const rules_value = getJsonField(params_object, "rules") orelse return;
        const rules_json = std.json.stringifyAlloc(appState().allocator, rules_value, .{}) catch return;
        defer appState().allocator.free(rules_json);
        appState().core.setWebviewNavigationRules(webview_id, rules_json) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagFindInPage")) {
        const search_text = getJsonStringField(params_object, "searchText") orelse return;
        const forward = getJsonBoolField(params_object, "forward", true);
        const match_case = getJsonBoolField(params_object, "matchCase", false);
        appState().core.webviewFindInPage(webview_id, search_text, forward, match_case) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagStopFind")) {
        appState().core.webviewStopFind(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagOpenDevTools")) {
        appState().core.openWebviewDevTools(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagCloseDevTools")) {
        appState().core.closeWebviewDevTools(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagToggleDevTools")) {
        appState().core.toggleWebviewDevTools(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagExecuteJavascript")) {
        const js = getJsonStringField(params_object, "js") orelse return;
        appState().core.evaluateJavaScriptWithNoCompletion(webview_id, js) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagResize")) {
        const frame_value = getJsonField(params_object, "frame") orelse return;
        if (frame_value != .object) {
            return;
        }
        const frame = electrobun.Rect{
            .x = getJsonF64Field(&frame_value.object, "x", 0),
            .y = getJsonF64Field(&frame_value.object, "y", 0),
            .width = getJsonF64Field(&frame_value.object, "width", 0),
            .height = getJsonF64Field(&frame_value.object, "height", 0),
        };
        const masks = getJsonStringField(params_object, "masks") orelse "[]";
        appState().core.resizeWGPUView(webview_id, frame, masks) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagSetTransparent")) {
        appState().core.setWGPUViewTransparent(webview_id, getJsonBoolField(params_object, "transparent", false)) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagSetPassthrough")) {
        appState().core.setWGPUViewPassthrough(webview_id, getJsonBoolField(params_object, "passthrough", false)) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagSetHidden")) {
        appState().core.setWGPUViewHidden(webview_id, getJsonBoolField(params_object, "hidden", false)) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagRemove")) {
        appState().core.removeWGPUView(webview_id) catch {};
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagRunTest")) {
        appState().core.runWGPUViewTest(webview_id) catch {};
        return;
    }
}

fn playgroundInternalBridge(host_webview_id: u32, message: [*:0]const u8) callconv(.C) u32 {
    const message_slice = std.mem.span(message);
    if (message_slice.len == 0) {
        return 0;
    }

    var parsed = std.json.parseFromSlice(std.json.Value, appState().allocator, message_slice, .{}) catch |err| {
        std.debug.print("[kitchen zig] failed to parse internal bridge packet: {s}\n", .{@errorName(err)});
        return 0;
    };
    defer parsed.deinit();

    if (parsed.value == .object) {
        const id_value = parsed.value.object.get("id") orelse return 0;
        const type_value = parsed.value.object.get("type") orelse return 0;
        if (id_value == .string and type_value == .string and
            std.mem.eql(u8, id_value.string, "webviewEvent") and
            std.mem.eql(u8, type_value.string, "message"))
        {
            const payload_value = parsed.value.object.get("payload") orelse return 0;
            if (payload_value == .object) {
                const event_name = getJsonStringField(&payload_value.object, "eventName") orelse return 0;
                const detail = getJsonStringField(&payload_value.object, "detail") orelse return 0;
                recordObservedWebviewEvent(event_name, detail);
            }
            return 0;
        }
    }

    if (parsed.value != .array) {
        return 0;
    }

    for (parsed.value.array.items) |item| {
        if (item != .string) {
            continue;
        }

        var packet = std.json.parseFromSlice(std.json.Value, appState().allocator, item.string, .{}) catch continue;
        defer packet.deinit();
        if (packet.value != .object) {
            continue;
        }

        const packet_type = getJsonStringField(&packet.value.object, "type") orelse continue;
        if (std.mem.eql(u8, packet_type, "message")) {
            const message_id = getJsonStringField(&packet.value.object, "id") orelse continue;
            const payload_value = getJsonField(&packet.value.object, "payload") orelse continue;
            if (payload_value != .object) {
                continue;
            }
            handleInternalBridgeMessage(message_id, &payload_value.object);
        } else if (std.mem.eql(u8, packet_type, "request")) {
            const request_id = getJsonStringField(&packet.value.object, "id") orelse continue;
            const method = getJsonStringField(&packet.value.object, "method") orelse continue;
            const params_value = getJsonField(&packet.value.object, "params") orelse continue;
            if (params_value != .object) {
                continue;
            }
            handleInternalBridgeRequest(host_webview_id, request_id, method, &params_value.object);
        }
    }

    return 0;
}

fn createWindowWithHarnessCustom(
    state: *AppState,
    title: []const u8,
    frame: electrobun.Rect,
    hidden: bool,
    activate: bool,
    title_bar_style: []const u8,
    window_callbacks: electrobun.WindowCallbacks,
    webview_callbacks: electrobun.WebviewCallbacks,
) !WindowWithWebview {
    const window_id = try state.core.createWindow(.{
        .title = title,
        .frame = frame,
        .hidden = hidden,
        .activate = activate,
        .title_bar_style = title_bar_style,
        .callbacks = window_callbacks,
    });
    errdefer state.core.closeWindow(window_id) catch {};

    const webview_id = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .native,
        .url = test_harness_url,
        .frame = .{
            .x = 0,
            .y = 0,
            .width = frame.width,
            .height = frame.height,
        },
        .secret_key = default_secret_key,
        .callbacks = webview_callbacks,
        .sandbox = false,
    });

    return .{
        .window_id = window_id,
        .webview_id = webview_id,
    };
}

fn openInteractivePlaygroundWindow(
    state: *AppState,
    title: []const u8,
    url: []const u8,
    renderer: electrobun.Renderer,
    frame: electrobun.Rect,
) !WindowWithWebview {
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = title,
        .frame = frame,
        .hidden = false,
        .activate = true,
        .callbacks = .{
            .close = observedWindowClose,
        },
    });
    errdefer state.core.closeWindow(window_id) catch {};

    const webview_id = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = renderer,
        .url = url,
        .frame = .{
            .x = 0,
            .y = 0,
            .width = frame.width,
            .height = frame.height,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = observedWebviewEvent,
            .event_bridge = observedWebviewBridge,
            .host_bridge = testRunnerHostBridge,
            .internal_bridge = playgroundInternalBridge,
        },
        .sandbox = false,
    });
    try rememberTopLevelWebview(webview_id, window_id);

    try state.core.setWindowAlwaysOnTop(window_id, true);
    return .{
        .window_id = window_id,
        .webview_id = webview_id,
    };
}

fn createWindowWithTestHarness(
    state: *AppState,
    title: []const u8,
    frame: electrobun.Rect,
    hidden: bool,
    activate: bool,
) !WindowWithWebview {
    return createWindowWithHarnessCustom(
        state,
        title,
        frame,
        hidden,
        activate,
        "default",
        .{},
        .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = electrobun.noopWebviewEvent,
            .event_bridge = electrobun.noopWebviewPostMessage,
            .host_bridge = electrobun.noopWebviewPostMessage,
            .internal_bridge = electrobun.noopWebviewPostMessage,
        },
    );
}

fn observedHarnessWebviewCallbacks() electrobun.WebviewCallbacks {
    return .{
        .decide_navigation = electrobun.allowAllNavigation,
        .event = observedWebviewEvent,
        .event_bridge = observedWebviewBridge,
        .host_bridge = electrobun.noopWebviewPostMessage,
        .internal_bridge = observedWebviewBridge,
    };
}

fn runWindowCreateCloseTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Electrobun Zig Window Test",
        .frame = .{
            .x = 60,
            .y = 60,
            .width = 320,
            .height = 240,
        },
        .hidden = false,
        .activate = true,
    });
    sleepMs(visible_test_window_delay_ms);
    try state.core.closeWindow(window_id);
}

fn runWindowCreationWithUrlTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "URL Window Test",
        .{ .x = 120, .y = 120, .width = 400, .height = 300 },
        true,
        false,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    if (created.window_id == 0 or created.webview_id == 0) {
        return error.InvalidWindowOrWebviewId;
    }
}

fn runWindowHiddenOptionTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Hidden Window Test",
        .{ .x = 140, .y = 140, .width = 400, .height = 300 },
        true,
        false,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    try state.core.showWindow(created.window_id, true);
    sleepMs(medium_wait_ms);
}

fn runWindowInactiveShowApiTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Inactive Show Test",
        .{ .x = 150, .y = 150, .width = 400, .height = 300 },
        true,
        false,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    try state.core.showWindow(created.window_id, false);
    sleepMs(medium_wait_ms);
    try state.core.activateWindow(created.window_id);
    sleepMs(medium_wait_ms);
}

fn runWindowPageZoomTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Page Zoom Test",
        .{ .x = 150, .y = 150, .width = 420, .height = 320 },
        true,
        false,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    const target_zoom = 1.25;
    try state.core.setWebviewPageZoom(created.webview_id, target_zoom);
    sleepMs(medium_wait_ms);

    const zoom = state.core.getWebviewPageZoom(created.webview_id);
    if (builtin.os.tag == .macos) {
        if (!approxEq(zoom, target_zoom, 0.02)) {
            return error.UnexpectedWindowZoom;
        }
    } else if (!approxEq(zoom, 1.0, 0.02)) {
        return error.UnexpectedWindowZoom;
    }
}

fn runWindowSetTitleTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Original Title",
        .frame = .{ .x = 160, .y = 160, .width = 400, .height = 300 },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    try state.core.setWindowTitle(window_id, "New Title From Zig Test");
    sleepMs(short_wait_ms);
}

fn runWindowMinimizeUnminimizeTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Minimize Test",
        .{ .x = 160, .y = 160, .width = 420, .height = 320 },
        false,
        true,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(long_wait_ms);
    if (state.core.isWindowMinimized(created.window_id)) {
        return error.UnexpectedInitialMinimizedState;
    }

    try state.core.minimizeWindow(created.window_id);
    sleepMs(2000);
    if (!state.core.isWindowMinimized(created.window_id)) {
        return error.WindowDidNotMinimize;
    }

    try state.core.restoreWindow(created.window_id);
    sleepMs(3000);
    if (state.core.isWindowMinimized(created.window_id)) {
        return error.WindowDidNotRestore;
    }
}

fn runWindowFullscreenToggleTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Fullscreen Test",
        .{ .x = 170, .y = 170, .width = 420, .height = 320 },
        false,
        true,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    if (state.core.isWindowFullScreen(created.window_id)) {
        return error.UnexpectedInitialFullscreenState;
    }

    try state.core.setWindowFullScreen(created.window_id, true);
    sleepMs(long_wait_ms);
    if (!state.core.isWindowFullScreen(created.window_id)) {
        return error.WindowDidNotEnterFullscreen;
    }

    try state.core.setWindowFullScreen(created.window_id, false);
    sleepMs(long_wait_ms);
    if (state.core.isWindowFullScreen(created.window_id)) {
        return error.WindowDidNotExitFullscreen;
    }
}

fn runWindowFullscreenToggleHiddenTitlebarTest(state: *AppState) !void {
    if (builtin.os.tag != .macos) {
        return;
    }

    const created = try createWindowWithHarnessCustom(
        state,
        "Hidden Fullscreen Test",
        .{ .x = 180, .y = 180, .width = 420, .height = 320 },
        false,
        true,
        "hidden",
        .{},
        .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = electrobun.noopWebviewEvent,
            .event_bridge = electrobun.noopWebviewPostMessage,
            .host_bridge = electrobun.noopWebviewPostMessage,
            .internal_bridge = electrobun.noopWebviewPostMessage,
        },
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    if (state.core.isWindowFullScreen(created.window_id)) {
        return error.UnexpectedInitialFullscreenState;
    }

    try state.core.setWindowFullScreen(created.window_id, true);
    sleepMs(long_wait_ms);
    if (!state.core.isWindowFullScreen(created.window_id)) {
        return error.WindowDidNotEnterFullscreen;
    }

    try state.core.setWindowFullScreen(created.window_id, false);
    sleepMs(long_wait_ms);
    if (state.core.isWindowFullScreen(created.window_id)) {
        return error.WindowDidNotExitFullscreen;
    }
}

fn runWindowSetPositionTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Position Test",
        .frame = .{ .x = 50, .y = 60, .width = 420, .height = 320 },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    try state.core.setWindowPosition(window_id, 200, 200);
    sleepMs(short_wait_ms);

    const frame = try state.core.getWindowFrame(window_id);
    if (!approxEq(frame.x, 200, 4) or !approxEq(frame.y, 200, 4)) {
        return error.UnexpectedWindowPosition;
    }
}

fn runWindowSetSizeTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Size Test",
        .frame = .{ .x = 70, .y = 80, .width = 420, .height = 320 },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    try state.core.setWindowSize(window_id, 600, 500);
    sleepMs(short_wait_ms);

    const frame = try state.core.getWindowFrame(window_id);
    if (!approxEq(frame.width, 600, 4) or !approxEq(frame.height, 500, 4)) {
        return error.UnexpectedWindowSize;
    }
}

fn runWindowSetFrameTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Electrobun Zig Frame Test",
        .frame = .{
            .x = 80,
            .y = 80,
            .width = 320,
            .height = 240,
        },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    try state.core.setWindowFrame(window_id, .{
        .x = 120,
        .y = 140,
        .width = 640,
        .height = 480,
    });

    const frame = try state.core.getWindowFrame(window_id);
    if (frame.width != 640 or frame.height != 480) {
        return error.UnexpectedWindowFrame;
    }
}

fn runWindowGetFrameTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "GetFrame Test",
        .frame = .{ .x = 150, .y = 150, .width = 500, .height = 400 },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    sleepMs(short_wait_ms);
    const frame = try state.core.getWindowFrame(window_id);
    if (frame.x < 0 or frame.y < 0 or frame.width <= 0 or frame.height <= 0) {
        return error.InvalidWindowFrame;
    }
    if (!approxEq(frame.width, 500, 100) or !approxEq(frame.height, 400, 100)) {
        return error.UnexpectedWindowFrame;
    }
}

fn runWindowGetPositionTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "GetPosition Test",
        .frame = .{ .x = 200, .y = 180, .width = 400, .height = 300 },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    sleepMs(short_wait_ms);
    const frame = try state.core.getWindowFrame(window_id);
    if (frame.x < 0 or frame.y < 0) {
        return error.InvalidWindowPosition;
    }
}

fn runWindowGetSizeTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "GetSize Test",
        .frame = .{ .x = 100, .y = 100, .width = 600, .height = 450 },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    sleepMs(short_wait_ms);
    const frame = try state.core.getWindowFrame(window_id);
    if (frame.width <= 0 or frame.height <= 0) {
        return error.InvalidWindowSize;
    }
    if (!approxEq(frame.width, 600, 100) or !approxEq(frame.height, 450, 100)) {
        return error.UnexpectedWindowSize;
    }
}

fn runWindowMaximizeUnmaximizeTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Maximize Test",
        .{ .x = 180, .y = 180, .width = 420, .height = 320 },
        false,
        true,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    if (state.core.isWindowMaximized(created.window_id)) {
        return error.UnexpectedInitialMaximizedState;
    }

    try state.core.maximizeWindow(created.window_id);
    sleepMs(long_wait_ms);
    if (!state.core.isWindowMaximized(created.window_id)) {
        return error.WindowDidNotMaximize;
    }

    try state.core.unmaximizeWindow(created.window_id);
    sleepMs(long_wait_ms);
    if (state.core.isWindowMaximized(created.window_id)) {
        return error.WindowDidNotUnmaximize;
    }
}

fn runWindowAlwaysOnTopTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Always On Top Test",
        .{ .x = 200, .y = 200, .width = 420, .height = 320 },
        false,
        true,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(short_wait_ms);
    if (state.core.isWindowAlwaysOnTop(created.window_id)) {
        return error.UnexpectedInitialAlwaysOnTopState;
    }

    try state.core.setWindowAlwaysOnTop(created.window_id, true);
    sleepMs(long_wait_ms);
    if (!state.core.isWindowAlwaysOnTop(created.window_id)) {
        return error.WindowDidNotBecomeAlwaysOnTop;
    }

    try state.core.setWindowAlwaysOnTop(created.window_id, false);
    sleepMs(medium_wait_ms);
    if (state.core.isWindowAlwaysOnTop(created.window_id)) {
        return error.WindowDidNotClearAlwaysOnTop;
    }
}

fn runWindowVisibleOnAllWorkspacesTest(state: *AppState) !void {
    if (builtin.os.tag != .macos) {
        return;
    }

    const created = try createWindowWithTestHarness(
        state,
        "Visible On All Workspaces Test",
        .{ .x = 220, .y = 220, .width = 420, .height = 320 },
        false,
        true,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(short_wait_ms);
    if (state.core.isWindowVisibleOnAllWorkspaces(created.window_id)) {
        return error.UnexpectedInitialVisibleOnAllWorkspacesState;
    }

    try state.core.setWindowVisibleOnAllWorkspaces(created.window_id, true);
    sleepMs(long_wait_ms);
    if (!state.core.isWindowVisibleOnAllWorkspaces(created.window_id)) {
        return error.WindowDidNotBecomeVisibleOnAllWorkspaces;
    }

    try state.core.setWindowVisibleOnAllWorkspaces(created.window_id, false);
    sleepMs(medium_wait_ms);
    if (state.core.isWindowVisibleOnAllWorkspaces(created.window_id)) {
        return error.WindowDidNotClearVisibleOnAllWorkspaces;
    }
}

fn runWindowFocusTest(state: *AppState) !void {
    resetCallbackState();

    const win1 = try state.core.createWindow(.{
        .title = "Focus Test 1",
        .frame = .{ .x = 100, .y = 100, .width = 360, .height = 260 },
        .callbacks = .{
            .focus = observedWindowFocus,
        },
    });
    defer state.core.closeWindow(win1) catch {};

    const win2 = try state.core.createWindow(.{
        .title = "Focus Test 2",
        .frame = .{ .x = 220, .y = 220, .width = 360, .height = 260 },
        .callbacks = .{
            .focus = observedWindowFocus,
        },
    });
    defer state.core.closeWindow(win2) catch {};

    sleepMs(medium_wait_ms);
    resetCallbackState();
    try state.core.activateWindow(win1);
    sleepMs(medium_wait_ms);
    try state.core.activateWindow(win2);
    sleepMs(medium_wait_ms);

    if (getWindowFocusCount() == 0) {
        return error.WindowFocusEventDidNotFire;
    }
}

fn runWindowCloseEventTest(state: *AppState) !void {
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = "Close Event Test",
        .frame = .{ .x = 120, .y = 120, .width = 360, .height = 260 },
        .callbacks = .{
            .close = observedWindowClose,
        },
    });

    sleepMs(short_wait_ms);
    try state.core.closeWindow(window_id);
    sleepMs(short_wait_ms);

    if (getWindowCloseCount() == 0) {
        return error.WindowCloseEventDidNotFire;
    }
}

fn runWindowResizeEventTest(state: *AppState) !void {
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = "Resize Event Test",
        .frame = .{ .x = 120, .y = 120, .width = 400, .height = 300 },
        .callbacks = .{
            .resize = observedWindowResize,
        },
    });
    defer state.core.closeWindow(window_id) catch {};

    sleepMs(short_wait_ms);
    resetCallbackState();
    try state.core.setWindowSize(window_id, 700, 520);
    sleepMs(medium_wait_ms);

    const resize_count = getWindowResizeCount();
    const last_size = getLastResizeSize();
    if (resize_count == 0) {
        return error.WindowResizeEventDidNotFire;
    }
    if (last_size.width <= 400 or last_size.height <= 300) {
        return error.WindowResizeEventDidNotReportUpdatedSize;
    }
}

fn runWindowGetByIdTest(state: *AppState) !void {
    var registry = electrobun.WindowRegistry.init(state.allocator, state.core);
    defer registry.deinit();

    const window = try registry.createBrowserWindow(.{
        .title = "GetById Test",
        .frame = .{ .x = 260, .y = 260, .width = 420, .height = 320 },
        .hidden = true,
        .activate = false,
    });
    defer window.close() catch {};

    const retrieved = registry.getById(window.id) orelse return error.WindowRegistryLookupFailed;
    if (retrieved.id != window.id) {
        return error.WindowRegistryReturnedUnexpectedId;
    }
}

fn runWindowInsetTitlebarStyleTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Inset Titlebar",
        .frame = .{ .x = 270, .y = 270, .width = 420, .height = 320 },
        .title_bar_style = "hiddenInset",
    });
    defer state.core.closeWindow(window_id) catch {};

    if (window_id == 0) {
        return error.InvalidInsetTitlebarWindowId;
    }
    sleepMs(300);
}

fn runWindowTrafficLightPositionApiTest(state: *AppState) !void {
    if (builtin.os.tag != .macos) {
        return;
    }

    var registry = electrobun.WindowRegistry.init(state.allocator, state.core);
    defer registry.deinit();

    const window = try registry.createBrowserWindow(.{
        .title = "Traffic Light Position Test",
        .frame = .{ .x = 280, .y = 280, .width = 480, .height = 340 },
        .title_bar_style = "hiddenInset",
        .traffic_light_offset = .{ .x = 24, .y = 18 },
    });
    defer window.close() catch {};

    sleepMs(300);
    try window.setWindowButtonPosition(52, 22);
    sleepMs(300);
}

fn runWebviewCreateTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "Electrobun Zig Webview Test",
        .frame = .{
            .x = 100,
            .y = 100,
            .width = 500,
            .height = 360,
        },
        .hidden = true,
        .activate = false,
    });
    defer state.core.closeWindow(window_id) catch {};

    _ = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .native,
        .url = "views://zig/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 500,
            .height = 360,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = electrobun.noopWebviewEvent,
            .event_bridge = electrobun.noopWebviewPostMessage,
            .host_bridge = electrobun.noopWebviewPostMessage,
            .internal_bridge = electrobun.noopWebviewPostMessage,
        },
        .sandbox = true,
    });
}

fn runWebviewPageZoomTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "View Zoom Test",
        .{ .x = 240, .y = 240, .width = 420, .height = 320 },
        true,
        false,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    const target_zoom = 1.1;
    try state.core.setWebviewPageZoom(created.webview_id, target_zoom);
    sleepMs(medium_wait_ms);

    const zoom = state.core.getWebviewPageZoom(created.webview_id);
    if (builtin.os.tag == .macos) {
        if (!approxEq(zoom, target_zoom, 0.02)) {
            return error.UnexpectedWebviewZoom;
        }
    } else if (!approxEq(zoom, 1.0, 0.02)) {
        return error.UnexpectedWebviewZoom;
    }
}

fn runWebviewTagPlaygroundIntegrationTest(state: *AppState) !void {
    clearChildWebviews();
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = "Webview Tag Playground Integration",
        .frame = .{ .x = 220, .y = 120, .width = 900, .height = 1000 },
        .hidden = false,
        .activate = true,
    });
    defer {
        state.core.closeWindow(window_id) catch {};
        clearChildWebviews();
    }

    _ = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .cef,
        .url = "views://playgrounds/webviewtag/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 900,
            .height = 1000,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = observedWebviewEvent,
            .event_bridge = observedWebviewBridge,
            .host_bridge = testRunnerHostBridge,
            .internal_bridge = playgroundInternalBridge,
        },
        .sandbox = false,
    });

    const deadline_ms = std.time.milliTimestamp() + 8000;
    while (std.time.milliTimestamp() < deadline_ms) {
        if (getWebviewDomReadyCount() > 0 and getWebviewTagInitCount() >= 2) {
            sleepMs(medium_wait_ms);
            return;
        }
        sleepMs(50);
    }

    return error.WebviewTagIntegrationTimedOut;
}

fn runWgpuTagPlaygroundIntegrationTest(state: *AppState) !void {
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = "WGPU Tag Playground Integration",
        .frame = .{ .x = 240, .y = 140, .width = 860, .height = 720 },
        .hidden = false,
        .activate = true,
    });
    defer state.core.closeWindow(window_id) catch {};

    _ = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .native,
        .url = "views://playgrounds/wgpu-tag/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 860,
            .height = 720,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = observedWebviewEvent,
            .event_bridge = observedWebviewBridge,
            .host_bridge = testRunnerHostBridge,
            .internal_bridge = playgroundInternalBridge,
        },
        .sandbox = false,
    });

    const deadline_ms = std.time.milliTimestamp() + 8000;
    while (std.time.milliTimestamp() < deadline_ms) {
        if (getWebviewDomReadyCount() > 0 and getWgpuTagInitCount() > 0 and getWgpuTagReadyCount() > 0) {
            sleepMs(medium_wait_ms);
            return;
        }
        sleepMs(50);
    }

    return error.WgpuTagIntegrationTimedOut;
}

fn waitForInteractiveWindowClose() void {
    while (getWindowCloseCount() == 0) {
        sleepMs(100);
    }
}

fn runWebviewTagPlaygroundInteractiveTest(state: *AppState) !void {
    clearChildWebviews();
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = "Webview Tag Playground",
        .frame = .{ .x = 100, .y = 50, .width = 800, .height = 900 },
        .hidden = false,
        .activate = true,
        .callbacks = .{
            .close = observedWindowClose,
        },
    });
    errdefer state.core.closeWindow(window_id) catch {};

    const webview_id = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .cef,
        .url = "views://playgrounds/webviewtag/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 800,
            .height = 900,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = observedWebviewEvent,
            .event_bridge = observedWebviewBridge,
            .host_bridge = testRunnerHostBridge,
            .internal_bridge = playgroundInternalBridge,
        },
        .sandbox = false,
    });
    try rememberTopLevelWebview(webview_id, window_id);
    defer {
        forgetTopLevelWebview(webview_id);
        clearChildWebviews();
    }

    try state.core.setWindowAlwaysOnTop(window_id, true);
    waitForInteractiveWindowClose();
}

fn runWgpuTagPlaygroundInteractiveTest(state: *AppState) !void {
    resetCallbackState();

    const window_id = try state.core.createWindow(.{
        .title = "WGPU Tag Playground",
        .frame = .{ .x = 120, .y = 60, .width = 860, .height = 720 },
        .hidden = false,
        .activate = true,
        .callbacks = .{
            .close = observedWindowClose,
        },
    });
    errdefer state.core.closeWindow(window_id) catch {};

    const webview_id = try state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .native,
        .url = "views://playgrounds/wgpu-tag/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 860,
            .height = 720,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = observedWebviewEvent,
            .event_bridge = observedWebviewBridge,
            .host_bridge = testRunnerHostBridge,
            .internal_bridge = playgroundInternalBridge,
        },
        .sandbox = false,
    });
    try rememberTopLevelWebview(webview_id, window_id);
    defer forgetTopLevelWebview(webview_id);

    try state.core.setWindowAlwaysOnTop(window_id, true);
    waitForInteractiveWindowClose();
}

fn runNavigationLoadUrlTest(state: *AppState) !void {
    resetCallbackState();
    const created = try createWindowWithHarnessCustom(
        state,
        "LoadURL Test",
        .{ .x = 260, .y = 260, .width = 500, .height = 360 },
        false,
        true,
        "default",
        .{},
        observedHarnessWebviewCallbacks(),
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    resetCallbackState();
    try state.core.loadURLInWebview(created.webview_id, "views://test-runner/index.html");
    sleepMs(1500);

    if (getWebviewWillNavigateCount() == 0) {
        return error.LoadUrlDidNotTriggerWillNavigate;
    }
}

fn runNavigationLoadHtmlTest(state: *AppState) !void {
    resetCallbackState();
    const created = try createWindowWithHarnessCustom(
        state,
        "LoadHTML Test",
        .{ .x = 270, .y = 270, .width = 500, .height = 360 },
        false,
        true,
        "default",
        .{},
        observedHarnessWebviewCallbacks(),
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    resetCallbackState();
    try state.core.loadHTMLInWebview(
        created.webview_id,
        "<html><body><h1 id='test-heading'>Custom HTML Content</h1></body></html>",
    );
    sleepMs(1500);

    if (getWebviewWillNavigateCount() == 0) {
        return error.LoadHtmlDidNotTriggerWillNavigate;
    }
}

fn runNavigationDomReadyEventTest(state: *AppState) !void {
    resetCallbackState();
    const created = try createWindowWithHarnessCustom(
        state,
        "DOM Ready Test",
        .{ .x = 280, .y = 280, .width = 500, .height = 360 },
        false,
        true,
        "default",
        .{},
        observedHarnessWebviewCallbacks(),
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(800);
    resetCallbackState();
    try state.core.loadURLInWebview(created.webview_id, "views://test-runner/index.html");
    sleepMs(1500);

    if (getWebviewDomReadyCount() == 0) {
        return error.DomReadyDidNotFire;
    }
}

fn runNavigationDidNavigateEventTest(state: *AppState) !void {
    resetCallbackState();
    const created = try createWindowWithHarnessCustom(
        state,
        "Did Navigate Test",
        .{ .x = 290, .y = 290, .width = 500, .height = 360 },
        false,
        true,
        "default",
        .{},
        observedHarnessWebviewCallbacks(),
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    resetCallbackState();
    try state.core.loadURLInWebview(created.webview_id, "views://test-runner/index.html");
    sleepMs(2000);

    if (getWebviewDidNavigateCount() == 0) {
        return error.DidNavigateDidNotFire;
    }
    if (!lastWebviewDetailContains("test-runner")) {
        return error.DidNavigateMissingExpectedUrl;
    }
}

fn runNavigationExecuteJavascriptTest(state: *AppState) !void {
    const created = try createWindowWithTestHarness(
        state,
        "Execute JS Test",
        .{ .x = 300, .y = 300, .width = 500, .height = 360 },
        false,
        true,
    );
    defer state.core.closeWindow(created.window_id) catch {};

    sleepMs(medium_wait_ms);
    try state.core.evaluateJavaScriptWithNoCompletion(
        created.webview_id,
        "document.body.innerHTML = '<h1>Modified by executeJavascript</h1>';",
    );
    sleepMs(short_wait_ms);
}

fn runTrayVisibilityToggleAndBoundsTest(state: *AppState) !void {
    const tray_id = try state.core.createTray(.{
        .title = "Kitchen Tray API Test",
        .image = tray_template_icon_url,
        .is_template = true,
        .width = 32,
        .height = 32,
    });
    defer state.core.removeTray(tray_id) catch {};

    try state.core.hideTray(tray_id);
    sleepMs(short_wait_ms);
    try state.core.showTray(tray_id);
    sleepMs(short_wait_ms);

    const bounds = try state.core.getTrayBounds(tray_id);
    if (bounds.width < 0 or bounds.height < 0) {
        return error.InvalidTrayBounds;
    }
}

fn runSessionFromPartitionTest(state: *AppState) !void {
    const session = electrobun.Session.fromPartition(state.core, "persist:test-partition");
    if (!std.mem.eql(u8, session.partition, "persist:test-partition")) {
        return error.SessionPartitionMismatch;
    }
}

fn runSessionDefaultSessionTest(state: *AppState) !void {
    const session = electrobun.Session.defaultSession(state.core);
    if (!std.mem.eql(u8, session.partition, "persist:default")) {
        return error.DefaultSessionPartitionMismatch;
    }
}

fn runSessionCookiesApiExistsTest(state: *AppState) !void {
    const session = electrobun.Session.fromPartition(state.core, "persist:cookie-api-test");
    const get_fn: *const fn (electrobun.SessionPartition, ?electrobun.CookieFilter) anyerror![]electrobun.Cookie = electrobun.SessionPartition.getCookies;
    const set_fn: *const fn (electrobun.SessionPartition, electrobun.Cookie) anyerror!bool = electrobun.SessionPartition.setCookie;
    const remove_fn: *const fn (electrobun.SessionPartition, []const u8, []const u8) anyerror!bool = electrobun.SessionPartition.removeCookie;
    const clear_fn: *const fn (electrobun.SessionPartition) anyerror!void = electrobun.SessionPartition.clearCookies;
    _ = get_fn;
    _ = set_fn;
    _ = remove_fn;
    _ = clear_fn;

    const cookies = try session.getCookies(null);
    defer state.allocator.free(cookies);
}

fn runApplicationMenuPlaygroundTest(state: *AppState) !void {
    if (builtin.os.tag == .linux) {
        return;
    }

    const created = try openInteractivePlaygroundWindow(
        state,
        "Application Menu Playground",
        "views://playgrounds/application-menu/index.html",
        activePlaygroundRenderer(state),
        .{ .x = 100, .y = 50, .width = 800, .height = 600 },
    );
    defer forgetTopLevelWebview(created.webview_id);

    setApplicationMenuTargetWebview(created.webview_id);
    waitForInteractiveWindowClose();
}

fn runContextMenuPlaygroundTest(state: *AppState) !void {
    if (builtin.os.tag == .linux) {
        return;
    }

    const created = try openInteractivePlaygroundWindow(
        state,
        "Context Menu Playground",
        "views://playgrounds/context-menu/index.html",
        activePlaygroundRenderer(state),
        .{ .x = 150, .y = 80, .width = 800, .height = 600 },
    );
    defer forgetTopLevelWebview(created.webview_id);

    setContextMenuTargetWebview(created.webview_id);
    waitForInteractiveWindowClose();
}

fn runShowMessageBoxInfoDialogTest(state: *AppState) !void {
    const response = try state.core.showMessageBox(.{
        .box_type = "info",
        .title = "Test Info Dialog",
        .message = "This is a Zig-mode test info dialog",
        .detail = "Click any button to pass the test.",
        .buttons = &.{ "OK", "Cancel" },
        .default_id = 0,
        .cancel_id = 1,
    });
    if (response < 0) {
        return error.MessageBoxFailed;
    }
}

fn runFileDialogPlaygroundTest(state: *AppState) !void {
    const created = try openInteractivePlaygroundWindow(
        state,
        "File Dialog Playground",
        "views://playgrounds/file-dialog/index.html",
        activePlaygroundRenderer(state),
        .{ .x = 200, .y = 50, .width = 600, .height = 850 },
    );
    defer forgetTopLevelWebview(created.webview_id);

    waitForInteractiveWindowClose();
}

fn runGlobalShortcutsPlaygroundTest(state: *AppState) !void {
    try state.core.unregisterAllGlobalShortcuts();

    const created = try openInteractivePlaygroundWindow(
        state,
        "Global Shortcuts Playground",
        "views://playgrounds/shortcuts/index.html",
        activePlaygroundRenderer(state),
        .{ .x = 200, .y = 50, .width = 550, .height = 750 },
    );
    defer {
        forgetTopLevelWebview(created.webview_id);
        state.core.unregisterAllGlobalShortcuts() catch {};
    }

    setShortcutTargetWebview(created.webview_id);
    waitForInteractiveWindowClose();
}

fn runGlobalShortcutIsRegisteredApiTest(state: *AppState) !void {
    try state.core.unregisterAllGlobalShortcuts();
    defer state.core.unregisterAllGlobalShortcuts() catch {};

    const candidates = [_][]const u8{
        "Alt+Shift+Super+F11",
        "Alt+Shift+Super+F12",
        "Alt+Shift+Super+Insert",
        "CommandOrControl+Shift+Super+F11",
        "CommandOrControl+Alt+Super+F11",
        "Alt+Shift+Super+Delete",
    };

    var registered_accelerator: ?[]const u8 = null;
    for (candidates) |candidate| {
        if (try state.core.registerGlobalShortcut(candidate)) {
            registered_accelerator = candidate;
            break;
        }
    }

    if (registered_accelerator == null) {
        return;
    }

    if (!(try state.core.isGlobalShortcutRegistered(registered_accelerator.?))) {
        return error.GlobalShortcutDidNotRegister;
    }

    if (!(try state.core.unregisterGlobalShortcut(registered_accelerator.?))) {
        return error.GlobalShortcutDidNotUnregister;
    }

    if (try state.core.isGlobalShortcutRegistered(registered_accelerator.?)) {
        return error.GlobalShortcutStillRegistered;
    }
}

fn runGlobalShortcutUnregisterAllApiTest(state: *AppState) !void {
    try state.core.unregisterAllGlobalShortcuts();
    defer state.core.unregisterAllGlobalShortcuts() catch {};

    const candidates = [_][]const u8{
        "Alt+Shift+Super+F9",
        "Alt+Shift+Super+F10",
        "Alt+Shift+Super+PageUp",
        "CommandOrControl+Shift+Super+F9",
        "CommandOrControl+Alt+Super+F9",
        "CommandOrControl+Alt+Super+F10",
    };

    var registered = std.ArrayList([]const u8).init(state.allocator);
    defer registered.deinit();

    for (candidates) |candidate| {
        if (try state.core.registerGlobalShortcut(candidate)) {
            try registered.append(candidate);
            if (registered.items.len >= 3) break;
        }
    }

    if (registered.items.len == 0) {
        return;
    }

    try state.core.unregisterAllGlobalShortcuts();
    for (registered.items) |candidate| {
        if (try state.core.isGlobalShortcutRegistered(candidate)) {
            return error.GlobalShortcutUnregisterAllFailed;
        }
    }
}

fn runLifecycleBeforeQuitCancelTest(state: *AppState) !void {
    _ = state;
    resetCallbackState();
    setBeforeQuitShouldCancel(true);
    quitRequestedHandler();

    if (getBeforeQuitCount() == 0) {
        return error.BeforeQuitDidNotFire;
    }
}

fn runQuitShutdownPlaygroundTest(state: *AppState) !void {
    const created = try openInteractivePlaygroundWindow(
        state,
        "Quit/Shutdown Test Playground",
        "views://playgrounds/quit-test/index.html",
        activePlaygroundRenderer(state),
        .{ .x = 200, .y = 50, .width = 600, .height = 700 },
    );
    defer forgetTopLevelWebview(created.webview_id);

    setQuitTargetWebview(created.webview_id);
    setBeforeQuitShouldCancel(true);
    waitForInteractiveWindowClose();
}

fn runWgpuAdapterContextDeviceTest(state: *AppState) !void {
    const window_id = try state.core.createWindow(.{
        .title = "WGPU Adapter Context Test",
        .frame = .{ .x = 120, .y = 120, .width = 320, .height = 240 },
        .hidden = false,
        .activate = true,
    });
    defer state.core.closeWindow(window_id) catch {};

    const wgpu_view_id = try state.core.createWGPUView(.{
        .window_id = window_id,
        .frame = .{ .x = 0, .y = 0, .width = 320, .height = 240 },
        .auto_resize = true,
    });
    defer state.core.removeWGPUView(wgpu_view_id) catch {};

    sleepMs(short_wait_ms);

    var native = try electrobun.WgpuNative.load(state.allocator);
    defer native.close();

    const context = try electrobun.WgpuContext.createForWgpuView(state.core, &native, wgpu_view_id);
    if (context.instance_ptr == null or context.surface_ptr == null or context.device_ptr == null) {
        return error.WgpuContextMissingPointers;
    }

    if (context.getQueue(&native) == null) {
        return error.WgpuQueueMissing;
    }
}

fn runDockIconVisibilityContractTest(state: *AppState) !void {
    const initial_visible = state.core.isDockIconVisible();
    defer state.core.setDockIconVisible(initial_visible) catch {};

    if (builtin.os.tag == .macos) {
        try state.core.setDockIconVisible(false);
        sleepMs(200);
        if (state.core.isDockIconVisible()) {
            return error.DockIconDidNotHide;
        }

        try state.core.setDockIconVisible(true);
        sleepMs(200);
        if (!state.core.isDockIconVisible()) {
            return error.DockIconDidNotShow;
        }
    } else {
        try state.core.setDockIconVisible(false);
        sleepMs(50);
        _ = state.core.isDockIconVisible();
    }
}

fn runUtilsClipboardRoundTripTest(state: *AppState) !void {
    const test_text = try std.fmt.allocPrint(state.allocator, "Test clipboard {d}", .{std.time.milliTimestamp()});
    defer state.allocator.free(test_text);

    try state.core.clipboardWriteText(test_text);
    const read_text = try state.core.clipboardReadText();
    defer if (read_text) |value| state.allocator.free(value);

    if (read_text == null) return error.MissingClipboardText;
    if (!std.mem.eql(u8, read_text.?, test_text)) {
        return error.ClipboardRoundTripMismatch;
    }
}

fn runUtilsClipboardAvailableFormatsTest(state: *AppState) !void {
    try state.core.clipboardWriteText("test");
    const formats_csv = try state.core.clipboardAvailableFormatsCsv();
    defer state.allocator.free(formats_csv);

    if (formats_csv.len == 0) {
        return error.EmptyClipboardFormats;
    }
}

fn runUtilsClipboardClearTest(state: *AppState) !void {
    try state.core.clipboardWriteText("text to clear");
    try state.core.clipboardClear();

    const text = try state.core.clipboardReadText();
    defer if (text) |value| state.allocator.free(value);

    if (text) |value| {
        if (value.len != 0) {
            return error.ClipboardDidNotClear;
        }
    }
}

fn runUtilsShowNotificationTest(state: *AppState) !void {
    try state.core.showNotification(.{
        .title = "Test Notification",
        .body = "This is a test notification from the Zig integration tests",
        .subtitle = "Electrobun Zig Tests",
        .silent = true,
    });
    sleepMs(medium_wait_ms);
}

fn runUtilsOpenExternalExistsTest() !void {
    const fn_ptr: *const fn (*electrobun.Core, []const u8) anyerror!bool = electrobun.Core.openExternal;
    _ = fn_ptr;
}

fn runUtilsOpenPathExistsTest() !void {
    const fn_ptr: *const fn (*electrobun.Core, []const u8) anyerror!bool = electrobun.Core.openPath;
    _ = fn_ptr;
}

fn runUtilsShowItemInFolderExistsTest() !void {
    const fn_ptr: *const fn (*electrobun.Core, []const u8) anyerror!void = electrobun.Core.showItemInFolder;
    _ = fn_ptr;
}

fn runUtilsQuitExistsTest() !void {
    const fn_ptr: *const fn (u8) noreturn = electrobun.quit;
    _ = fn_ptr;
}

fn runUtilsPathsObjectExistsTest(state: *AppState) !void {
    var paths = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths.deinit(state.allocator);

    if (paths.home.len == 0 or paths.appData.len == 0 or paths.userData.len == 0) {
        return error.PathsObjectMissingExpectedValues;
    }
}

fn runUtilsPathsHomeMatchesTest(state: *AppState) !void {
    var paths = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths.deinit(state.allocator);

    const expected_home = try expectedHomePath(state.allocator);
    defer state.allocator.free(expected_home);

    if (!std.mem.eql(u8, paths.home, expected_home)) {
        return error.PathsHomeMismatch;
    }
}

fn runUtilsPathsTempMatchesTest(state: *AppState) !void {
    var paths = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths.deinit(state.allocator);

    const expected_temp = try expectedTempPath(state.allocator);
    defer state.allocator.free(expected_temp);

    if (!std.mem.eql(u8, paths.temp, expected_temp)) {
        return error.PathsTempMismatch;
    }
}

fn runUtilsPathsOsDirectoriesTest(state: *AppState) !void {
    var paths = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths.deinit(state.allocator);

    const values = [_][]const u8{
        paths.appData,
        paths.config,
        paths.cache,
        paths.logs,
        paths.documents,
        paths.downloads,
        paths.desktop,
        paths.pictures,
        paths.music,
        paths.videos,
    };

    for (values) |value| {
        if (value.len == 0) {
            return error.EmptyOsDirectoryPath;
        }
    }
}

fn runUtilsPathsAppScopedDirectoriesTest(state: *AppState) !void {
    var paths = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths.deinit(state.allocator);

    const values = [_][]const u8{
        paths.userData,
        paths.userCache,
        paths.userLogs,
    };

    for (values) |value| {
        if (value.len == 0) {
            return error.EmptyAppScopedPath;
        }
    }

    if (paths.userData.len <= paths.appData.len or
        paths.userCache.len <= paths.cache.len or
        paths.userLogs.len <= paths.logs.len)
    {
        return error.AppScopedPathsDidNotExtendBasePaths;
    }
}

fn runUtilsPathsStableAcrossCallsTest(state: *AppState) !void {
    var paths_a = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths_a.deinit(state.allocator);

    var paths_b = try electrobun.Paths.resolve(state.allocator, state.app_info);
    defer paths_b.deinit(state.allocator);

    if (!std.mem.eql(u8, paths_a.home, paths_b.home) or
        !std.mem.eql(u8, paths_a.downloads, paths_b.downloads) or
        !std.mem.eql(u8, paths_a.userData, paths_b.userData))
    {
        return error.PathsWereNotStableAcrossCalls;
    }
}

fn runUtilsMoveToTrashTest(state: *AppState) !void {
    const test_file = try std.fmt.allocPrint(
        state.allocator,
        "/tmp/electrobun-zig-trash-{d}.txt",
        .{std.time.milliTimestamp()},
    );
    defer state.allocator.free(test_file);

    {
        const file = try std.fs.createFileAbsolute(test_file, .{});
        defer file.close();
        try file.writeAll("This file will be moved to trash");
    }

    const moved = try state.core.moveToTrash(test_file);
    if (!moved) {
        return error.MoveToTrashFailed;
    }

    if (std.fs.openFileAbsolute(test_file, .{})) |still_exists| {
        still_exists.close();
        return error.FileStillExistsAfterMoveToTrash;
    } else |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    }
}

fn runScreenPrimaryDisplayTest(state: *AppState) !void {
    const display = try state.core.getPrimaryDisplay();
    if (display.bounds.width <= 0 or display.bounds.height <= 0) {
        return error.InvalidPrimaryDisplayBounds;
    }
    if (!display.isPrimary) {
        return error.PrimaryDisplayNotMarkedPrimary;
    }
}

fn runScreenAllDisplaysTest(state: *AppState) !void {
    const displays = try state.core.getAllDisplays();
    defer state.allocator.free(displays);

    if (displays.len == 0) {
        return error.NoDisplaysFound;
    }

    var primary_count: usize = 0;
    for (displays) |display| {
        if (display.bounds.width <= 0 or display.bounds.height <= 0) {
            return error.InvalidDisplayBounds;
        }
        if (display.isPrimary) {
            primary_count += 1;
        }
    }

    if (primary_count != 1) {
        return error.UnexpectedPrimaryDisplayCount;
    }
}

fn runScreenCursorScreenPointTest(state: *AppState) !void {
    const point = try state.core.getCursorScreenPoint();
    if (!std.math.isFinite(point.x) or !std.math.isFinite(point.y)) {
        return error.InvalidCursorPoint;
    }
}

fn runScreenBoundsVsWorkAreaTest(state: *AppState) !void {
    const display = try state.core.getPrimaryDisplay();
    if (display.workArea.width > display.bounds.width or display.workArea.height > display.bounds.height) {
        return error.WorkAreaExceedsBounds;
    }
}

fn expectedHomePath(allocator: std.mem.Allocator) ![]u8 {
    return switch (builtin.os.tag) {
        .windows => std.process.getEnvVarOwned(allocator, "USERPROFILE") catch
            std.process.getEnvVarOwned(allocator, "HOME"),
        else => std.process.getEnvVarOwned(allocator, "HOME"),
    };
}

fn expectedTempPath(allocator: std.mem.Allocator) ![]u8 {
    return switch (builtin.os.tag) {
        .windows => blk: {
            break :blk std.process.getEnvVarOwned(allocator, "TEMP") catch
                std.process.getEnvVarOwned(allocator, "TMP") catch
                std.fs.path.join(allocator, &.{ "C:\\", "Temp" });
        },
        else => std.process.getEnvVarOwned(allocator, "TMPDIR") catch allocator.dupe(u8, "/tmp"),
    };
}

fn executeSingleTestAndBroadcast(webview_id: u32, zig_test: ZigTest) TestResult {
    std.debug.print("[kitchen zig] running test: {s}\n", .{zig_test.name});
    sendRpcMessage(webview_id, "testStarted", .{
        .testId = zig_test.id,
        .name = zig_test.name,
    });
    sendTestLog(webview_id, zig_test.id, "Running Zig native test");

    const result = runZigTest(zig_test);
    if (result.@"error") |message| {
        sendTestLog(webview_id, zig_test.id, message);
    }

    sendRpcMessage(webview_id, "testCompleted", .{
        .testId = zig_test.id,
        .result = result,
    });
    std.debug.print("[kitchen zig] completed test: {s} -> {s}\n", .{ zig_test.name, result.status });

    return result;
}

fn runSelectedTests(webview_id: u32, interactive_only: bool) [zig_tests.len]TestResult {
    var results: [zig_tests.len]TestResult = undefined;
    var count: usize = 0;
    for (zig_tests) |zig_test| {
        if (zig_test.interactive != interactive_only) {
            continue;
        }
        results[count] = executeSingleTestAndBroadcast(webview_id, zig_test);
        count += 1;
    }
    sendRpcMessage(webview_id, "allCompleted", .{ .results = results[0..count] });
    return results;
}

fn runSingleTestJob(job: *SingleTestJob) void {
    defer std.heap.c_allocator.destroy(job);

    const result = executeSingleTestAndBroadcast(job.webview_id, job.zig_test);
    if (job.request_id) |request_id| {
        sendRpcResponseSuccess(job.webview_id, request_id, result);
    }
}

fn runAllTestsJob(job: *AllTestsJob) void {
    defer std.heap.c_allocator.destroy(job);

    const results = runSelectedTests(job.webview_id, job.interactive_only);
    var count: usize = 0;
    for (zig_tests) |zig_test| {
        if (zig_test.interactive == job.interactive_only) {
            count += 1;
        }
    }
    if (job.request_id) |request_id| {
        sendRpcResponseSuccess(job.webview_id, request_id, results[0..count]);
    }
}

fn startSingleTest(webview_id: u32, request_id: ?u64, zig_test: ZigTest) bool {
    const job = std.heap.c_allocator.create(SingleTestJob) catch |err| {
        std.debug.print("[kitchen zig] failed to allocate single test job: {s}\n", .{@errorName(err)});
        if (request_id) |rid| {
            sendRpcResponseError(webview_id, rid, "Failed to allocate test job");
        }
        return false;
    };
    job.* = .{
        .webview_id = webview_id,
        .request_id = request_id,
        .zig_test = zig_test,
    };

    const thread = std.Thread.spawn(.{}, runSingleTestJob, .{job}) catch |err| {
        std.heap.c_allocator.destroy(job);
        std.debug.print("[kitchen zig] failed to spawn single test thread: {s}\n", .{@errorName(err)});
        if (request_id) |rid| {
            sendRpcResponseError(webview_id, rid, "Failed to spawn test thread");
        }
        return false;
    };
    thread.detach();
    return true;
}

fn startAllTests(webview_id: u32, request_id: ?u64, interactive_only: bool) bool {
    const job = std.heap.c_allocator.create(AllTestsJob) catch |err| {
        std.debug.print("[kitchen zig] failed to allocate all-tests job: {s}\n", .{@errorName(err)});
        if (request_id) |rid| {
            sendRpcResponseError(webview_id, rid, "Failed to allocate all-tests job");
        }
        return false;
    };
    job.* = .{
        .webview_id = webview_id,
        .request_id = request_id,
        .interactive_only = interactive_only,
    };

    const thread = std.Thread.spawn(.{}, runAllTestsJob, .{job}) catch |err| {
        std.heap.c_allocator.destroy(job);
        std.debug.print("[kitchen zig] failed to spawn all-tests thread: {s}\n", .{@errorName(err)});
        if (request_id) |rid| {
            sendRpcResponseError(webview_id, rid, "Failed to spawn all-tests thread");
        }
        return false;
    };
    thread.detach();
    return true;
}

fn maybeAutoRunAfterHandshake(webview_id: u32) void {
    const state = appState();
    var auto_run_all = false;
    var auto_run_test: ?ZigTest = null;
    var auto_run_test_name: ?[]const u8 = null;

    state.mutex.lock();
    if (state.auto_run_triggered) {
        state.mutex.unlock();
        return;
    }

    if (!state.auto_run_all and state.auto_run_test_name == null) {
        state.mutex.unlock();
        return;
    }

    state.auto_run_triggered = true;
    auto_run_all = state.auto_run_all;
    auto_run_test_name = state.auto_run_test_name;
    if (auto_run_test_name) |test_name| {
        auto_run_test = findTestByName(test_name);
    }
    state.mutex.unlock();

    if (auto_run_test_name) |test_name| {
        std.debug.print("[kitchen zig] auto-running test: {s}\n", .{test_name});
        if (auto_run_test) |zig_test| {
            _ = startSingleTest(webview_id, null, zig_test);
        } else {
            std.debug.print("[kitchen zig] failed to find auto-run test: {s}\n", .{test_name});
        }
        return;
    }

    if (auto_run_all) {
        std.debug.print("[kitchen zig] auto-running all automated tests\n", .{});
        _ = startAllTests(webview_id, null, false);
    }
}

fn handleRpcRequest(webview_id: u32, request_id: u64, method: []const u8, params: ?std.json.Value) void {
    std.debug.print("[kitchen zig] RPC request: {s}\n", .{method});

    if (std.mem.eql(u8, method, "getTests")) {
        var tests: [zig_tests.len]TestInfo = undefined;
        for (zig_tests, 0..) |zig_test, index| {
            tests[index] = zig_test.toInfo();
        }
        sendRpcResponseSuccess(webview_id, request_id, tests[0..]);
        sendInitialUiState(webview_id);
        maybeAutoRunAfterHandshake(webview_id);
        return;
    }

    if (std.mem.eql(u8, method, "getTestRunnerPreferences")) {
        sendRpcResponseSuccess(webview_id, request_id, .{
            .searchQuery = getSearchQuery(),
        });
        sendInitialUiState(webview_id);
        return;
    }

    if (std.mem.eql(u8, method, "setTestRunnerPreferences")) {
        if (params) |params_value| {
            if (params_value == .object) {
                if (params_value.object.get("searchQuery")) |query_value| {
                    if (query_value == .string) {
                        setSearchQuery(query_value.string) catch |err| {
                            sendRpcResponseError(webview_id, request_id, @errorName(err));
                            return;
                        };
                    }
                }
            }
        }
        sendRpcResponseSuccess(webview_id, request_id, .{});
        return;
    }

    if (std.mem.eql(u8, method, "wgpuTagReady")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing wgpuTagReady params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid wgpuTagReady params");
            return;
        }

        const wgpu_view_id = getJsonU32Field(&params_value.object, "id", 0);
        if (wgpu_view_id == 0) {
            sendRpcResponseError(webview_id, request_id, "Missing WGPU view id");
            return;
        }

        appState().core.runWGPUViewTest(wgpu_view_id) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };

        recordWgpuTagReady();
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = true });
        return;
    }

    if (std.mem.eql(u8, method, "wgpuTagToggleShader")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing wgpuTagToggleShader params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid wgpuTagToggleShader params");
            return;
        }

        const wgpu_view_id = getJsonU32Field(&params_value.object, "id", 0);
        if (wgpu_view_id == 0) {
            sendRpcResponseError(webview_id, request_id, "Missing WGPU view id");
            return;
        }

        appState().core.toggleWGPUViewTestShader(wgpu_view_id) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };

        sendRpcResponseSuccess(webview_id, request_id, .{ .success = true });
        return;
    }

    if (std.mem.eql(u8, method, "closeWindow")) {
        const window_id = windowIdForTopLevelWebview(webview_id) orelse {
            sendRpcResponseError(webview_id, request_id, "No top-level window for requesting webview");
            return;
        };

        appState().core.closeWindow(window_id) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };

        forgetTopLevelWebview(webview_id);
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = true });
        return;
    }

    if (std.mem.eql(u8, method, "setApplicationMenu")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing setApplicationMenu params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid setApplicationMenu params");
            return;
        }
        const menu_value = getJsonField(&params_value.object, "menu") orelse {
            sendRpcResponseError(webview_id, request_id, "Missing menu payload");
            return;
        };
        const menu_json = prepareMenuJson(menu_value) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        defer appState().allocator.free(menu_json);

        setApplicationMenuTargetWebview(webview_id);
        appState().core.setApplicationMenuJson(menu_json, applicationMenuHandler) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = true });
        return;
    }

    if (std.mem.eql(u8, method, "showContextMenu")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing showContextMenu params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid showContextMenu params");
            return;
        }
        const menu_value = getJsonField(&params_value.object, "menu") orelse {
            sendRpcResponseError(webview_id, request_id, "Missing menu payload");
            return;
        };
        const menu_json = prepareMenuJson(menu_value) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        defer appState().allocator.free(menu_json);

        setContextMenuTargetWebview(webview_id);
        appState().core.showContextMenuJson(menu_json, contextMenuHandler) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = true });
        return;
    }

    if (std.mem.eql(u8, method, "openFileDialog")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing openFileDialog params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid openFileDialog params");
            return;
        }

        const starting_folder_input = getJsonStringField(&params_value.object, "startingFolder") orelse "~/";
        const starting_folder = expandTildePathAlloc(appState().allocator, starting_folder_input) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        defer appState().allocator.free(starting_folder);

        const csv = appState().core.openFileDialog(.{
            .starting_folder = starting_folder,
            .allowed_file_types = getJsonStringField(&params_value.object, "allowedFileTypes") orelse "*",
            .can_choose_files = getJsonBoolField(&params_value.object, "canChooseFiles", true),
            .can_choose_directory = getJsonBoolField(&params_value.object, "canChooseDirectory", true),
            .allows_multiple_selection = getJsonBoolField(&params_value.object, "allowsMultipleSelection", true),
        }) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        defer appState().allocator.free(csv);

        const paths = splitCsvPaths(appState().allocator, csv) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        defer releaseSplitCsvPaths(appState().allocator, paths);

        sendRpcResponseSuccess(webview_id, request_id, paths);
        return;
    }

    if (std.mem.eql(u8, method, "registerShortcut")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing registerShortcut params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid registerShortcut params");
            return;
        }
        const accelerator = getJsonStringField(&params_value.object, "accelerator") orelse {
            sendRpcResponseError(webview_id, request_id, "Missing accelerator");
            return;
        };

        setShortcutTargetWebview(webview_id);
        const success = appState().core.registerGlobalShortcut(accelerator) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = success });
        return;
    }

    if (std.mem.eql(u8, method, "unregisterShortcut")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing unregisterShortcut params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid unregisterShortcut params");
            return;
        }
        const accelerator = getJsonStringField(&params_value.object, "accelerator") orelse {
            sendRpcResponseError(webview_id, request_id, "Missing accelerator");
            return;
        };

        const success = appState().core.unregisterGlobalShortcut(accelerator) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = success });
        return;
    }

    if (std.mem.eql(u8, method, "unregisterAllShortcuts")) {
        appState().core.unregisterAllGlobalShortcuts() catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .success = true });
        return;
    }

    if (std.mem.eql(u8, method, "isRegistered")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing isRegistered params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid isRegistered params");
            return;
        }
        const accelerator = getJsonStringField(&params_value.object, "accelerator") orelse {
            sendRpcResponseError(webview_id, request_id, "Missing accelerator");
            return;
        };

        const registered = appState().core.isGlobalShortcutRegistered(accelerator) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .registered = registered });
        return;
    }

    if (std.mem.eql(u8, method, "triggerQuit")) {
        setQuitTargetWebview(webview_id);
        setBeforeQuitShouldCancel(true);
        quitRequestedHandler();
        sendRpcResponseSuccess(webview_id, request_id, .{
            .success = true,
            .message = "Quit handled through Zig before-quit callback and cancelled for playground mode.",
        });
        return;
    }

    if (std.mem.eql(u8, method, "runTest")) {
        const params_value = params orelse {
            sendRpcResponseError(webview_id, request_id, "Missing runTest params");
            return;
        };
        if (params_value != .object) {
            sendRpcResponseError(webview_id, request_id, "Invalid runTest params");
            return;
        }
        const test_id_value = params_value.object.get("testId") orelse {
            sendRpcResponseError(webview_id, request_id, "Missing testId");
            return;
        };
        if (test_id_value != .string) {
            sendRpcResponseError(webview_id, request_id, "Invalid testId");
            return;
        }

        const zig_test = findTestById(test_id_value.string) orelse {
            sendRpcResponseError(webview_id, request_id, "Unknown test id");
            return;
        };

        _ = startSingleTest(webview_id, request_id, zig_test);
        return;
    }

    if (std.mem.eql(u8, method, "runAllAutomated")) {
        _ = startAllTests(webview_id, request_id, false);
        return;
    }

    if (std.mem.eql(u8, method, "runInteractiveTests")) {
        _ = startAllTests(webview_id, request_id, true);
        return;
    }

    if (std.mem.eql(u8, method, "submitInteractiveResult") or
        std.mem.eql(u8, method, "submitReady") or
        std.mem.eql(u8, method, "submitVerification") or
        std.mem.eql(u8, method, "applyUpdate") or
        std.mem.eql(u8, method, "clearUpdateStatusHistory"))
    {
        sendRpcResponseSuccess(webview_id, request_id, .{});
        return;
    }

    if (std.mem.eql(u8, method, "getUpdateStatusHistory")) {
        const empty_history = [_]TestResult{};
        sendRpcResponseSuccess(webview_id, request_id, empty_history[0..]);
        return;
    }

    sendRpcResponseError(webview_id, request_id, "Unknown RPC request");
}

fn handleRpcMessage(message_id: []const u8, payload: ?std.json.Value) void {
    if (std.mem.eql(u8, message_id, "logToBun")) {
        if (payload) |payload_value| {
            if (payload_value == .object) {
                if (payload_value.object.get("msg")) |msg_value| {
                    if (msg_value == .string) {
                        std.debug.print("[kitchen zig ui] {s}\n", .{msg_value.string});
                    }
                }
            }
        }
    }
}

fn testRunnerWebviewEvent(webview_id: u32, event_name: [*:0]const u8, _: [*:0]const u8) callconv(.C) void {
    const event_name_slice = std.mem.span(event_name);
    const state = appState();

    state.mutex.lock();
    const is_test_runner = state.test_runner_webview_id == webview_id;
    state.mutex.unlock();

    if (!is_test_runner) {
        return;
    }

    if (std.mem.eql(u8, event_name_slice, "dom-ready")) {
        std.debug.print("[kitchen zig] test runner dom-ready\n", .{});
        sendBuildConfig(webview_id);
        sendUpdateStatus(webview_id);
    }
}

fn testRunnerHostBridge(webview_id: u32, message: [*:0]const u8) callconv(.C) u32 {
    const state = appState();
    const message_slice = std.mem.span(message);
    if (message_slice.len == 0) {
        return 0;
    }

    var parsed = std.json.parseFromSlice(std.json.Value, state.allocator, message_slice, .{}) catch |err| {
        std.debug.print("[kitchen zig] failed to parse RPC packet: {s}\n", .{@errorName(err)});
        return 0;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        return 0;
    }

    const packet_type_value = parsed.value.object.get("type") orelse return 0;
    if (packet_type_value != .string) {
        return 0;
    }

    if (std.mem.eql(u8, packet_type_value.string, "request")) {
        const request_id_value = parsed.value.object.get("id") orelse {
            return 0;
        };
        const method_value = parsed.value.object.get("method") orelse {
            return 0;
        };
        if (request_id_value != .integer or method_value != .string) {
            return 0;
        }

        const params = parsed.value.object.get("params");
        handleRpcRequest(
            webview_id,
            @intCast(request_id_value.integer),
            method_value.string,
            params,
        );
        return 0;
    }

    if (std.mem.eql(u8, packet_type_value.string, "message")) {
        const message_id_value = parsed.value.object.get("id") orelse return 0;
        if (message_id_value != .string) {
            return 0;
        }
        const payload = parsed.value.object.get("payload");
        handleRpcMessage(message_id_value.string, payload);
        return 0;
    }

    return 0;
}

fn createUi(context: *CreateUiContext) void {
    std.time.sleep(150 * std.time.ns_per_ms);

    context.state.core.configureWebviewRuntimeFromExecutableDir(context.state.bundle_paths, 0) catch |err| {
        std.debug.print("[kitchen zig] failed to configure webview runtime: {s}\n", .{@errorName(err)});
        return;
    };

    const window_id = context.state.core.createWindow(.{
        .title = "Electrobun Integration Tests",
        .frame = .{
            .x = 100,
            .y = 100,
            .width = 1200,
            .height = 800,
        },
    }) catch |err| {
        std.debug.print("[kitchen zig] failed to create test runner window: {s}\n", .{@errorName(err)});
        return;
    };

    const webview_id = context.state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .native,
        .url = "views://test-runner/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 1200,
            .height = 800,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = testRunnerWebviewEvent,
            .event_bridge = electrobun.noopWebviewPostMessage,
            .host_bridge = testRunnerHostBridge,
            .internal_bridge = electrobun.noopWebviewPostMessage,
        },
        .sandbox = false,
    }) catch |err| {
        std.debug.print("[kitchen zig] failed to create test runner webview: {s}\n", .{@errorName(err)});
        context.state.core.closeWindow(window_id) catch {};
        return;
    };

    context.state.mutex.lock();
    context.state.test_runner_window_id = window_id;
    context.state.test_runner_webview_id = webview_id;
    context.state.mutex.unlock();
}

pub fn main() !void {
    const allocator = std.heap.c_allocator;

    var core = try electrobun.Core.load(allocator);
    defer core.close();

    var bundle_paths = try electrobun.resolveBundlePaths(allocator);
    defer bundle_paths.deinit(allocator);

    var owned_app_info = try electrobun.resolveAppInfoFromBundle(allocator, &bundle_paths);
    defer owned_app_info.deinit(allocator);
    const app_info = owned_app_info.borrowed();

    const auto_run_test_name = std.process.getEnvVarOwned(allocator, "AUTO_RUN_TEST_NAME") catch null;
    const auto_run_all = blk: {
        const value = std.process.getEnvVarOwned(allocator, "AUTO_RUN") catch break :blk false;
        allocator.free(value);
        break :blk true;
    };

    var state = AppState{
        .allocator = allocator,
        .core = &core,
        .bundle_paths = &bundle_paths,
        .app_info = app_info,
        .child_webviews = std.AutoHashMap(u32, ChildWebviewState).init(allocator),
        .top_level_webview_windows = std.AutoHashMap(u32, u32).init(allocator),
        .menu_data_registry = std.StringHashMap([]u8).init(allocator),
        .auto_run_test_name = auto_run_test_name,
        .auto_run_all = auto_run_all,
    };
    defer state.deinit();

    try configureRuntimeBuildConfig(&state);

    g_state = &state;
    defer g_state = null;

    try core.setGlobalShortcutCallback(shortcutTriggeredHandler);
    try core.setQuitRequestedHandler(quitRequestedHandler);
    if (builtin.os.tag == .macos) {
        try core.setAppReopenHandler(appReopenHandler);
        try core.setURLOpenHandler(urlOpenHandler);
    }

    var context = CreateUiContext{
        .state = &state,
    };

    const ui_thread = try std.Thread.spawn(.{}, createUi, .{&context});
    ui_thread.detach();

    try core.runMainThread(app_info);
}
