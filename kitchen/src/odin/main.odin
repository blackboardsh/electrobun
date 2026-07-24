// Electrobun Kitchen Sink - Odin main process.
//
// A faithful port of kitchen/src/zig/main.zig using the Odin SDK
// (package/src/sdks/odin/electrobun.odin). Behavior, JSON payload shapes,
// timing, and test coverage mirror the Zig main process.
package main

import "base:intrinsics"
import "base:runtime"
import "core:encoding/json"
import "core:fmt"
import "core:math"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:sync"
import "core:thread"
import "core:time"

import electrobun "electrobun_sdk:electrobun"

app_version :: "1.18.1"
default_secret_key :: "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32"
visible_test_window_delay_ms :: 1000
short_wait_ms :: 150
medium_wait_ms :: 500
long_wait_ms :: 1200
test_harness_url :: "views://test-harness/index.html"
tray_template_icon_url :: "views://assets/electrobun-logo-32-template.png"

available_renderers_native := []string{"native"}
available_renderers_cef := []string{"native", "cef"}

BuildConfigPayload :: struct {
	defaultRenderer:    string,
	availableRenderers: []string,
	mainProcess:        string,
	cefVersion:         Maybe(string),
	odinVersion:        Maybe(string),
}

UpdateInfo :: struct {
	status:         string,
	currentVersion: string,
	newVersion:     Maybe(string),
	error:          Maybe(string),
}

TestInfo :: struct {
	id:          string,
	name:        string,
	category:    string,
	description: string,
	interactive: bool,
}

TestResult :: struct {
	testId:   string,
	name:     string,
	status:   string,
	duration: u64,
	error:    Maybe(string),
}

TestKind :: enum {
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
}

OdinTest :: struct {
	id:                    string,
	name:                  string,
	category:              string,
	description:           string,
	interactive:           bool,
	mirrors_bun_test_name: string,
	kind:                  TestKind,
}

testToInfo :: proc(self: OdinTest) -> TestInfo {
	return {
		id = self.id,
		name = self.name,
		category = self.category,
		description = self.description,
		interactive = self.interactive,
	}
}

odin_tests := [?]OdinTest {
	{
		id = "odin-smoke-test",
		name = "Odin host smoke test",
		category = "Odin Native",
		description = "Verify the Odin main process and view RPC bridge are running.",
		kind = .smoke,
	},
	{
		id = "odin-window-create-close",
		name = "Window create/close (Odin)",
		category = "BrowserWindow",
		description = "Create a native window through the Odin SDK and close it again.",
		kind = .window_create_close,
	},
	{
		id = "odin-window-creation-with-url",
		name = "Window creation with URL (Odin)",
		category = "BrowserWindow",
		description = "Create a native window and attach a BrowserView loading the test harness URL.",
		mirrors_bun_test_name = "Window creation with URL",
		kind = .window_creation_with_url,
	},
	{
		id = "odin-window-hidden-option",
		name = "Window hidden option (Odin)",
		category = "BrowserWindow",
		description = "Create a hidden native window, then show it through the Odin SDK.",
		mirrors_bun_test_name = "Window hidden option",
		kind = .window_hidden_option,
	},
	{
		id = "odin-window-inactive-show-api",
		name = "Window inactive show API (Odin)",
		category = "BrowserWindow",
		description = "Show a native window without activation, then activate it explicitly.",
		mirrors_bun_test_name = "Window inactive show API",
		kind = .window_inactive_show_api,
	},
	{
		id = "odin-window-page-zoom",
		name = "Window page zoom API (Odin)",
		category = "BrowserWindow",
		description = "Set and read the primary BrowserWindow page zoom in Odin mode.",
		mirrors_bun_test_name = "Window page zoom API",
		kind = .window_page_zoom,
	},
	{
		id = "odin-window-set-title",
		name = "Window setTitle (Odin)",
		category = "BrowserWindow",
		description = "Update a native window title through the Odin SDK.",
		mirrors_bun_test_name = "Window setTitle",
		kind = .window_set_title,
	},
	{
		id = "odin-window-minimize-unminimize",
		name = "Window minimize/unminimize (Odin)",
		category = "BrowserWindow",
		description = "Toggle native window minimized state through the Odin SDK.",
		mirrors_bun_test_name = "Window minimize/unminimize",
		kind = .window_minimize_unminimize,
	},
	{
		id = "odin-window-fullscreen-toggle",
		name = "Window fullscreen toggle (Odin)",
		category = "BrowserWindow",
		description = "Toggle native window fullscreen state through the Odin SDK.",
		mirrors_bun_test_name = "Window fullscreen toggle",
		kind = .window_fullscreen_toggle,
	},
	{
		id = "odin-window-fullscreen-toggle-hidden-titlebar",
		name = "Window fullscreen toggle with hidden titlebar (Odin)",
		category = "BrowserWindow",
		description = "Toggle fullscreen for a hidden-titlebar window in Odin mode on macOS.",
		mirrors_bun_test_name = "Window fullscreen toggle with hidden titlebar",
		kind = .window_fullscreen_toggle_hidden_titlebar,
	},
	{
		id = "odin-window-set-position",
		name = "Window setPosition (Odin)",
		category = "BrowserWindow",
		description = "Move a native window and read the new frame back from core.",
		mirrors_bun_test_name = "Window setPosition",
		kind = .window_set_position,
	},
	{
		id = "odin-window-set-size",
		name = "Window setSize (Odin)",
		category = "BrowserWindow",
		description = "Resize a native window and read the new frame back from core.",
		mirrors_bun_test_name = "Window setSize",
		kind = .window_set_size,
	},
	{
		id = "odin-window-set-frame",
		name = "Window setFrame (Odin)",
		category = "BrowserWindow",
		description = "Create a window, update its frame, and read the new size back from core.",
		mirrors_bun_test_name = "Window setFrame",
		kind = .window_set_frame,
	},
	{
		id = "odin-window-get-frame",
		name = "Window getFrame (Odin)",
		category = "BrowserWindow",
		description = "Read the current native window frame through the Odin SDK.",
		mirrors_bun_test_name = "Window getFrame",
		kind = .window_get_frame,
	},
	{
		id = "odin-window-get-position",
		name = "Window getPosition (Odin)",
		category = "BrowserWindow",
		description = "Read the current native window position through the Odin SDK.",
		mirrors_bun_test_name = "Window getPosition",
		kind = .window_get_position,
	},
	{
		id = "odin-window-get-size",
		name = "Window getSize (Odin)",
		category = "BrowserWindow",
		description = "Read the current native window size through the Odin SDK.",
		mirrors_bun_test_name = "Window getSize",
		kind = .window_get_size,
	},
	{
		id = "odin-window-maximize-unmaximize",
		name = "Window maximize/unmaximize (Odin)",
		category = "BrowserWindow",
		description = "Toggle native window maximized state through the Odin SDK.",
		mirrors_bun_test_name = "Window maximize/unmaximize",
		kind = .window_maximize_unmaximize,
	},
	{
		id = "odin-window-always-on-top",
		name = "Window alwaysOnTop (Odin)",
		category = "BrowserWindow",
		description = "Toggle native always-on-top state through the Odin SDK.",
		mirrors_bun_test_name = "Window alwaysOnTop",
		kind = .window_always_on_top,
	},
	{
		id = "odin-window-visible-on-all-workspaces",
		name = "Window visibleOnAllWorkspaces (macOS) (Odin)",
		category = "BrowserWindow",
		description = "Toggle visible-on-all-workspaces in Odin mode on macOS.",
		mirrors_bun_test_name = "Window visibleOnAllWorkspaces (macOS)",
		kind = .window_visible_on_all_workspaces,
	},
	{
		id = "odin-window-focus",
		name = "Window focus (Odin)",
		category = "BrowserWindow",
		description = "Focus multiple native windows through the Odin SDK.",
		mirrors_bun_test_name = "Window focus",
		kind = .window_focus,
	},
	{
		id = "odin-window-close-event",
		name = "Window close event (Odin)",
		category = "BrowserWindow",
		description = "Verify a per-window close callback fires in Odin mode.",
		mirrors_bun_test_name = "Window close event",
		kind = .window_close_event,
	},
	{
		id = "odin-window-resize-event",
		name = "Window resize event (Odin)",
		category = "BrowserWindow",
		description = "Verify a per-window resize callback fires in Odin mode.",
		mirrors_bun_test_name = "Window resize event",
		kind = .window_resize_event,
	},
	{
		id = "odin-window-get-by-id",
		name = "BrowserWindow.getById (Odin)",
		category = "BrowserWindow",
		description = "Verify the Odin window registry can retrieve a tracked window by id.",
		mirrors_bun_test_name = "BrowserWindow.getById",
		kind = .window_get_by_id,
	},
	{
		id = "odin-window-inset-titlebar-style",
		name = "Window with inset titlebar style (Odin)",
		category = "BrowserWindow",
		description = "Create a native window with hiddenInset titlebar style in Odin mode.",
		mirrors_bun_test_name = "Window with inset titlebar style",
		kind = .window_inset_titlebar_style,
	},
	{
		id = "odin-window-traffic-light-position-api",
		name = "Window traffic light position API (Odin)",
		category = "BrowserWindow",
		description = "Create a hiddenInset window with traffic light offsets and move them at runtime.",
		mirrors_bun_test_name = "Window traffic light position API",
		kind = .window_traffic_light_position_api,
	},
	{
		id = "odin-webview-create",
		name = "BrowserView create (Odin)",
		category = "BrowserView",
		description = "Create a secondary native webview through the Odin SDK.",
		kind = .webview_create,
	},
	{
		id = "odin-webview-page-zoom",
		name = "BrowserView page zoom API (Odin)",
		category = "BrowserWindow",
		description = "Set and read BrowserView page zoom in Odin mode.",
		mirrors_bun_test_name = "BrowserView page zoom API",
		kind = .webview_page_zoom,
	},
	{
		id = "odin-webview-tag-playground-integration",
		name = "Webview Tag playground integration (Odin)",
		category = "Webview Tag",
		description = "Load the real webview-tag playground in CEF mode and verify nested electrobun-webview tags initialize through the Odin host bridge.",
		kind = .webview_tag_playground_integration,
	},
	{
		id = "odin-webview-tag-playground",
		name = "Webview Tag playground (Odin)",
		category = "Webview Tag (Interactive)",
		description = "Open the real webview-tag playground and keep it open for manual interaction until the window is closed.",
		interactive = true,
		mirrors_bun_test_name = "Webview Tag playground",
		kind = .webview_tag_playground_interactive,
	},
	{
		id = "odin-wgpu-tag-playground-integration",
		name = "WGPU Tag playground integration (Odin)",
		category = "WGPU Tag",
		description = "Load the real WGPU tag playground in Odin mode and verify electrobun-wgpu initializes through the Odin host bridge.",
		kind = .wgpu_tag_playground_integration,
	},
	{
		id = "odin-wgpu-tag-playground",
		name = "WGPU Tag playground (Odin)",
		category = "WGPU Tag (Interactive)",
		description = "Open the real WGPU tag playground and keep it open for manual interaction until the window is closed.",
		interactive = true,
		mirrors_bun_test_name = "WGPU Tag playground",
		kind = .wgpu_tag_playground_interactive,
	},
	{
		id = "odin-navigation-load-url",
		name = "loadURL (Odin)",
		category = "Navigation",
		description = "Load a new internal URL into a BrowserView in Odin mode.",
		mirrors_bun_test_name = "loadURL",
		kind = .navigation_load_url,
	},
	{
		id = "odin-navigation-load-html",
		name = "loadHTML (Odin)",
		category = "Navigation",
		description = "Load inline HTML into a BrowserView in Odin mode.",
		mirrors_bun_test_name = "loadHTML",
		kind = .navigation_load_html,
	},
	{
		id = "odin-navigation-dom-ready-event",
		name = "dom-ready event (Odin)",
		category = "Navigation",
		description = "Verify dom-ready is emitted for BrowserView navigation in Odin mode.",
		mirrors_bun_test_name = "dom-ready event",
		kind = .navigation_dom_ready_event,
	},
	{
		id = "odin-navigation-did-navigate-event",
		name = "did-navigate event (Odin)",
		category = "Navigation",
		description = "Verify did-navigate is emitted for BrowserView navigation in Odin mode.",
		mirrors_bun_test_name = "did-navigate event",
		kind = .navigation_did_navigate_event,
	},
	{
		id = "odin-navigation-execute-javascript",
		name = "executeJavascript (fire and forget) (Odin)",
		category = "Navigation",
		description = "Execute JavaScript in a BrowserView without waiting for a response.",
		mirrors_bun_test_name = "executeJavascript (fire and forget)",
		kind = .navigation_execute_javascript,
	},
	{
		id = "odin-tray-visibility-toggle-bounds",
		name = "Tray visibility toggle and bounds (Odin)",
		category = "Tray",
		description = "Create a tray item, toggle visibility, and read bounds in Odin mode.",
		mirrors_bun_test_name = "Tray visibility toggle and bounds",
		kind = .tray_visibility_toggle_and_bounds,
	},
	{
		id = "odin-session-from-partition",
		name = "Session.fromPartition (Odin)",
		category = "Session",
		description = "Create an Odin session wrapper for a persistent partition.",
		mirrors_bun_test_name = "Session.fromPartition",
		kind = .session_from_partition,
	},
	{
		id = "odin-session-default-session",
		name = "Session.defaultSession (Odin)",
		category = "Session",
		description = "Create the default Odin session wrapper.",
		mirrors_bun_test_name = "Session.defaultSession",
		kind = .session_default_session,
	},
	{
		id = "odin-session-cookies-api-exists",
		name = "cookies API exists (Odin)",
		category = "Session",
		description = "Exercise the Odin session cookie helpers without mutating user state.",
		mirrors_bun_test_name = "cookies API exists",
		kind = .session_cookies_api_exists,
	},
	{
		id = "odin-application-menu-playground",
		name = "Application menu playground (Odin)",
		category = "Menus (Interactive)",
		description = "Open the real application-menu playground in Odin mode and keep it open for manual interaction.",
		interactive = true,
		mirrors_bun_test_name = "Application menu playground",
		kind = .application_menu_playground,
	},
	{
		id = "odin-context-menu-playground",
		name = "Context menu playground (Odin)",
		category = "Menus (Interactive)",
		description = "Open the real context-menu playground in Odin mode and keep it open for manual interaction.",
		interactive = true,
		mirrors_bun_test_name = "Context menu playground",
		kind = .context_menu_playground,
	},
	{
		id = "odin-dialog-show-message-box-info",
		name = "showMessageBox - info dialog (Odin)",
		category = "Dialogs (Interactive)",
		description = "Show a native info dialog through the Odin SDK and pass after the user clicks a button.",
		interactive = true,
		mirrors_bun_test_name = "showMessageBox - info dialog",
		kind = .dialog_show_message_box_info,
	},
	{
		id = "odin-dialog-file-dialog-playground",
		name = "File dialog playground (Odin)",
		category = "Dialogs (Interactive)",
		description = "Open the real file-dialog playground in Odin mode and keep it open for manual interaction.",
		interactive = true,
		mirrors_bun_test_name = "File dialog playground",
		kind = .dialog_file_dialog_playground,
	},
	{
		id = "odin-global-shortcuts-playground",
		name = "Global shortcuts playground (Odin)",
		category = "Shortcuts (Interactive)",
		description = "Open the real shortcuts playground in Odin mode and keep it open for manual interaction.",
		interactive = true,
		mirrors_bun_test_name = "Global shortcuts playground",
		kind = .global_shortcuts_playground,
	},
	{
		id = "odin-global-shortcut-is-registered-api",
		name = "GlobalShortcut.isRegistered API (Odin)",
		category = "Shortcuts",
		description = "Verify Odin global shortcut registration state tracking.",
		mirrors_bun_test_name = "GlobalShortcut.isRegistered API",
		kind = .global_shortcut_is_registered_api,
	},
	{
		id = "odin-global-shortcut-unregister-all-api",
		name = "GlobalShortcut.unregisterAll API (Odin)",
		category = "Shortcuts",
		description = "Verify Odin global shortcut unregisterAll clears registered accelerators.",
		mirrors_bun_test_name = "GlobalShortcut.unregisterAll API",
		kind = .global_shortcut_unregister_all_api,
	},
	{
		id = "odin-lifecycle-before-quit-cancel",
		name = "before-quit event can cancel quit (Odin)",
		category = "App Lifecycle",
		description = "Verify an Odin before-quit handler can run and cancel shutdown.",
		mirrors_bun_test_name = "before-quit event can cancel quit",
		kind = .lifecycle_before_quit_cancel,
	},
	{
		id = "odin-quit-shutdown-playground",
		name = "Quit/Shutdown playground (Odin)",
		category = "Quit (Interactive)",
		description = "Open the real quit-test playground in Odin mode and keep it open for manual interaction.",
		interactive = true,
		mirrors_bun_test_name = "Quit/Shutdown playground",
		kind = .quit_shutdown_playground,
	},
	{
		id = "odin-wgpu-adapter-context-device",
		name = "WebGPU adapter: context/device init (Odin)",
		category = "WebGPU",
		description = "Create a native WGPU view, then build a direct Odin WGPU context and device pointer pair.",
		kind = .wgpu_adapter_context_device,
	},
	{
		id = "odin-dock-icon-visibility-contract",
		name = "Dock icon visibility contract (Odin)",
		category = "Utils",
		description = "Exercise dock icon visibility controls from the Odin SDK.",
		mirrors_bun_test_name = "Dock icon visibility contract",
		kind = .dock_icon_visibility_contract,
	},
	{
		id = "odin-utils-clipboard-round-trip",
		name = "clipboardWriteText and clipboardReadText (Odin)",
		category = "Utils",
		description = "Write and read clipboard text through the Odin SDK.",
		mirrors_bun_test_name = "clipboardWriteText and clipboardReadText",
		kind = .utils_clipboard_round_trip,
	},
	{
		id = "odin-utils-clipboard-available-formats",
		name = "clipboardAvailableFormats (Odin)",
		category = "Utils",
		description = "Read clipboard formats through the Odin SDK.",
		mirrors_bun_test_name = "clipboardAvailableFormats",
		kind = .utils_clipboard_available_formats,
	},
	{
		id = "odin-utils-clipboard-clear",
		name = "clipboardClear (Odin)",
		category = "Utils",
		description = "Clear clipboard text through the Odin SDK.",
		mirrors_bun_test_name = "clipboardClear",
		kind = .utils_clipboard_clear,
	},
	{
		id = "odin-utils-show-notification",
		name = "showNotification (Odin)",
		category = "Utils",
		description = "Send a desktop notification through the Odin SDK.",
		mirrors_bun_test_name = "showNotification",
		kind = .utils_show_notification,
	},
	{
		id = "odin-utils-open-external-exists",
		name = "openExternal (Odin)",
		category = "Utils",
		description = "Verify the Odin SDK exposes openExternal without invoking side effects.",
		mirrors_bun_test_name = "openExternal",
		kind = .utils_open_external_exists,
	},
	{
		id = "odin-utils-open-path-exists",
		name = "openPath (Odin)",
		category = "Utils",
		description = "Verify the Odin SDK exposes openPath without invoking side effects.",
		mirrors_bun_test_name = "openPath",
		kind = .utils_open_path_exists,
	},
	{
		id = "odin-utils-show-item-in-folder-exists",
		name = "showItemInFolder (Odin)",
		category = "Utils",
		description = "Verify the Odin SDK exposes showItemInFolder without invoking side effects.",
		mirrors_bun_test_name = "showItemInFolder",
		kind = .utils_show_item_in_folder_exists,
	},
	{
		id = "odin-utils-quit-function-exists",
		name = "quit function exists (Odin)",
		category = "Utils",
		description = "Verify the Odin SDK exposes a quit helper without invoking it.",
		mirrors_bun_test_name = "quit function exists",
		kind = .utils_quit_exists,
	},
	{
		id = "odin-utils-paths-object-exists",
		name = "paths object exists (Odin)",
		category = "Utils",
		description = "Resolve the Odin SDK paths object and verify it is populated.",
		mirrors_bun_test_name = "paths object exists",
		kind = .utils_paths_object_exists,
	},
	{
		id = "odin-utils-paths-home-matches",
		name = "paths.home matches os.homedir() (Odin)",
		category = "Utils",
		description = "Verify Odin SDK paths.home matches the process home directory.",
		mirrors_bun_test_name = "paths.home matches os.homedir()",
		kind = .utils_paths_home_matches,
	},
	{
		id = "odin-utils-paths-temp-matches",
		name = "paths.temp matches os.tmpdir() (Odin)",
		category = "Utils",
		description = "Verify Odin SDK paths.temp matches the process temp directory.",
		mirrors_bun_test_name = "paths.temp matches os.tmpdir()",
		kind = .utils_paths_temp_matches,
	},
	{
		id = "odin-utils-paths-os-directories",
		name = "paths OS directories return non-empty strings (Odin)",
		category = "Utils",
		description = "Verify the Odin SDK resolves non-empty OS-level directories.",
		mirrors_bun_test_name = "paths OS directories return non-empty strings",
		kind = .utils_paths_os_directories,
	},
	{
		id = "odin-utils-paths-app-scoped-directories",
		name = "paths app-scoped directories return non-empty strings (Odin)",
		category = "Utils",
		description = "Verify the Odin SDK resolves non-empty app-scoped data/cache/log directories.",
		mirrors_bun_test_name = "paths app-scoped directories return non-empty strings",
		kind = .utils_paths_app_scoped_directories,
	},
	{
		id = "odin-utils-paths-stable-across-calls",
		name = "paths getters are stable across calls (Odin)",
		category = "Utils",
		description = "Verify repeated Odin SDK path resolution returns the same string values.",
		mirrors_bun_test_name = "paths getters are stable across calls",
		kind = .utils_paths_stable_across_calls,
	},
	{
		id = "odin-utils-move-to-trash",
		name = "moveToTrash (Odin)",
		category = "Utils",
		description = "Move a temporary file to trash through the Odin SDK.",
		mirrors_bun_test_name = "moveToTrash",
		kind = .utils_move_to_trash,
	},
	{
		id = "odin-screen-primary-display",
		name = "getPrimaryDisplay (Odin)",
		category = "Screen",
		description = "Read the primary display through the Odin SDK.",
		mirrors_bun_test_name = "getPrimaryDisplay",
		kind = .screen_primary_display,
	},
	{
		id = "odin-screen-all-displays",
		name = "getAllDisplays (Odin)",
		category = "Screen",
		description = "Read all connected displays through the Odin SDK.",
		mirrors_bun_test_name = "getAllDisplays",
		kind = .screen_all_displays,
	},
	{
		id = "odin-screen-cursor-screen-point",
		name = "getCursorScreenPoint (Odin)",
		category = "Screen",
		description = "Read the current cursor position through the Odin SDK.",
		mirrors_bun_test_name = "getCursorScreenPoint",
		kind = .screen_cursor_screen_point,
	},
	{
		id = "odin-screen-bounds-vs-workarea",
		name = "Display bounds vs workArea (Odin)",
		category = "Screen",
		description = "Verify primary display workArea fits within bounds in Odin mode.",
		mirrors_bun_test_name = "Display bounds vs workArea",
		kind = .screen_bounds_vs_workarea,
	},
}

AppState :: struct {
	allocator:                          runtime.Allocator,
	core:                               ^electrobun.Core,
	bundle_paths:                       ^electrobun.BundlePaths,
	app_info:                           electrobun.AppInfo,
	default_renderer:                   electrobun.Renderer,
	cef_available:                      bool,
	cef_version:                        Maybe(string),
	child_webviews:                     map[u32]ChildWebviewState,
	top_level_webview_windows:          map[u32]u32,
	test_runner_window_id:              u32,
	test_runner_webview_id:             u32,
	search_query:                       Maybe(string),
	auto_run_test_name:                 Maybe(string),
	auto_run_all:                       bool,
	auto_run_triggered:                 bool,
	application_menu_target_webview_id: u32,
	context_menu_target_webview_id:     u32,
	shortcut_target_webview_id:         u32,
	quit_target_webview_id:             u32,
	before_quit_should_cancel:          bool,
	menu_data_counter:                  u32,
	menu_data_registry:                 map[string]string,
	mutex:                              sync.Mutex,
}

appStateDeinit :: proc(self: ^AppState) {
	sync.mutex_lock(&self.mutex)
	defer sync.mutex_unlock(&self.mutex)
	if query, ok := self.search_query.?; ok {
		delete(query, self.allocator)
		self.search_query = nil
	}
	if test_name, ok := self.auto_run_test_name.?; ok {
		delete(test_name, self.allocator)
		self.auto_run_test_name = nil
	}
	if cef_version, ok := self.cef_version.?; ok {
		delete(cef_version, self.allocator)
		self.cef_version = nil
	}
	for key, value in self.menu_data_registry {
		delete(key, self.allocator)
		delete(value, self.allocator)
	}
	delete(self.menu_data_registry)
	delete(self.child_webviews)
	delete(self.top_level_webview_windows)
}

ChildWebviewState :: struct {
	renderer: electrobun.Renderer,
}

CreateUiContext :: struct {
	state: ^AppState,
}

SingleTestJob :: struct {
	webview_id: u32,
	request_id: Maybe(u64),
	odin_test:  OdinTest,
}

AllTestsJob :: struct {
	webview_id:       u32,
	request_id:       Maybe(u64),
	interactive_only: bool,
}

g_state: ^AppState
host_queue_running: bool

appState :: proc() -> ^AppState {
	if g_state == nil {
		panic("electrobun kitchen odin state not initialized")
	}
	return g_state
}

errName :: proc(err: electrobun.Error) -> string {
	switch err {
	case .None:
		return "None"
	case .MissingCoreSymbol:
		return "MissingCoreSymbol"
	case .LibraryLoadFailed:
		return "LibraryLoadFailed"
	case .ElectrobunCoreFailure:
		return "ElectrobunCoreFailure"
	case .InvalidExePath:
		return "InvalidExePath"
	case .InvalidRectJson:
		return "InvalidRectJson"
	case .InvalidJson:
		return "InvalidJson"
	case .FileReadFailed:
		return "FileReadFailed"
	case .EnvVarNotFound:
		return "EnvVarNotFound"
	}
	return "UnknownError"
}

drainHostMessageQueue :: proc() {
	for intrinsics.atomic_load_explicit(&host_queue_running, .Acquire) {
		state := g_state
		if state == nil {
			time.sleep(10 * time.Millisecond)
			continue
		}

		drained_any := false
		for intrinsics.atomic_load_explicit(&host_queue_running, .Acquire) {
			webview_id: u32 = 0
			message := electrobun.popNextQueuedHostMessage(state.core, &webview_id)
			if message == nil {
				break
			}
			testRunnerHostBridge(webview_id, message)
			electrobun.freeCoreString(state.core, message)
			drained_any = true
		}

		if !drained_any {
			time.sleep(10 * time.Millisecond)
		}
	}
}

configureRuntimeBuildConfig :: proc(state: ^AppState) -> string {
	build_json_path, _ := filepath.join({state.bundle_paths.resources_dir, "build.json"}, state.allocator)
	defer delete(build_json_path, state.allocator)

	build_json, read_err := os.read_entire_file(build_json_path, state.allocator)
	if read_err != nil {
		return "BuildJsonReadFailed"
	}
	defer delete(build_json, state.allocator)

	parsed, parse_err := json.parse(build_json, json.DEFAULT_SPECIFICATION, true, state.allocator)
	if parse_err != .None {
		return "BuildJsonParseFailed"
	}
	defer json.destroy_value(parsed, state.allocator)

	obj, is_object := parsed.(json.Object)
	if !is_object {
		return ""
	}

	if default_renderer_value, found := obj["defaultRenderer"]; found {
		if renderer_string, is_string := default_renderer_value.(json.String); is_string && renderer_string == "cef" {
			state.default_renderer = .cef
		}
	}

	if available_renderers_value, found := obj["availableRenderers"]; found {
		if renderers, is_array := available_renderers_value.(json.Array); is_array {
			for renderer_value in renderers {
				if renderer_string, is_string := renderer_value.(json.String); is_string && renderer_string == "cef" {
					state.cef_available = true
					break
				}
			}
		}
	}

	if cef_version_value, found := obj["cefVersion"]; found {
		if cef_version, is_string := cef_version_value.(json.String); is_string {
			cloned, _ := strings.clone(cef_version, state.allocator)
			state.cef_version = cloned
		}
	}

	return ""
}

buildConfigPayload :: proc() -> BuildConfigPayload {
	state := appState()
	renderers := available_renderers_cef if state.cef_available else available_renderers_native

	payload := BuildConfigPayload {
		defaultRenderer = electrobun.rendererName(state.default_renderer),
		availableRenderers = renderers,
		mainProcess = "odin",
		cefVersion = state.cef_version,
		odinVersion = ODIN_VERSION,
	}
	return payload
}

updateInfoPayload :: proc() -> UpdateInfo {
	return {status = "no-update", currentVersion = app_version}
}

RpcMessagePacket :: struct($T: typeid) {
	type:    string,
	id:      string,
	payload: T,
}

RpcResponsePacket :: struct($T: typeid) {
	type:    string,
	id:      u64,
	success: bool,
	payload: T,
}

RpcErrorPacket :: struct {
	type:    string,
	id:      u64,
	success: bool,
	error:   string,
}

InternalResponsePacket :: struct($T: typeid) {
	type:    string,
	id:      string,
	success: bool,
	payload: T,
}

EmptyPayload :: struct {}

TestStartedPayload :: struct {
	testId: string,
	name:   string,
}

TestLogPayload :: struct {
	testId:  string,
	message: string,
}

TestCompletedPayload :: struct {
	testId: string,
	result: TestResult,
}

AllCompletedPayload :: struct {
	results: []TestResult,
}

SearchPreferencesPayload :: struct {
	searchQuery: string,
}

SuccessPayload :: struct {
	success: bool,
}

RegisteredPayload :: struct {
	registered: bool,
}

SuccessMessagePayload :: struct {
	success: bool,
	message: string,
}

ActionPayload :: struct {
	action: string,
}

ActionDataPayload :: struct {
	action: string,
	data:   json.Value,
}

AcceleratorPayload :: struct {
	accelerator: string,
}

MessagePayload :: struct {
	message: string,
}

sendRpcMessage :: proc(webview_id: u32, message_id: string, payload: $T) {
	packet := RpcMessagePacket(T) {
		type = "message",
		id = message_id,
		payload = payload,
	}

	if err := electrobun.sendHostMessageToWebview(appState().core, webview_id, packet); err != .None {
		fmt.eprintf("[kitchen odin] failed to send RPC message '%s': %s\n", message_id, errName(err))
	}
}

sendRpcResponseSuccess :: proc(webview_id: u32, request_id: u64, payload: $T) {
	packet := RpcResponsePacket(T) {
		type = "response",
		id = request_id,
		success = true,
		payload = payload,
	}

	if err := electrobun.sendHostMessageToWebview(appState().core, webview_id, packet); err != .None {
		fmt.eprintf("[kitchen odin] failed to send RPC response #%d: %s\n", request_id, errName(err))
	}
}

sendRpcResponseError :: proc(webview_id: u32, request_id: u64, error_message: string) {
	packet := RpcErrorPacket {
		type = "response",
		id = request_id,
		success = false,
		error = error_message,
	}

	if err := electrobun.sendHostMessageToWebview(appState().core, webview_id, packet); err != .None {
		fmt.eprintf("[kitchen odin] failed to send RPC error #%d: %s\n", request_id, errName(err))
	}
}

sendBuildConfig :: proc(webview_id: u32) {
	sendRpcMessage(webview_id, "buildConfig", buildConfigPayload())
}

sendUpdateStatus :: proc(webview_id: u32) {
	sendRpcMessage(webview_id, "updateStatus", updateInfoPayload())
}

sendInitialUiState :: proc(webview_id: u32) {
	sendBuildConfig(webview_id)
	sendUpdateStatus(webview_id)
}

sendTestLog :: proc(webview_id: u32, test_id: string, message: string) {
	sendRpcMessage(webview_id, "testLog", TestLogPayload{testId = test_id, message = message})
}

findTestById :: proc(test_id: string) -> (OdinTest, bool) {
	for odin_test in odin_tests {
		if odin_test.id == test_id {
			return odin_test, true
		}
	}
	return {}, false
}

findTestByName :: proc(test_name: string) -> (OdinTest, bool) {
	for odin_test in odin_tests {
		if odin_test.name == test_name {
			return odin_test, true
		}
	}
	return {}, false
}

getSearchQuery :: proc() -> string {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	if query, ok := state.search_query.?; ok {
		return query
	}
	return ""
}

setSearchQuery :: proc(next: string) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)

	query_copy, _ := strings.clone(next, state.allocator)
	if existing, ok := state.search_query.?; ok {
		delete(existing, state.allocator)
	}
	state.search_query = query_copy
}

getJsonStringField :: proc(obj: json.Object, key: string) -> (string, bool) {
	value, found := obj[key]
	if !found {
		return "", false
	}
	value_string, is_string := value.(json.String)
	if !is_string {
		return "", false
	}
	return value_string, true
}

getJsonBoolField :: proc(obj: json.Object, key: string, default_value: bool) -> bool {
	value, found := obj[key]
	if !found {
		return default_value
	}
	value_bool, is_bool := value.(json.Boolean)
	if !is_bool {
		return default_value
	}
	return value_bool
}

getJsonF64Field :: proc(obj: json.Object, key: string, default_value: f64) -> f64 {
	value, found := obj[key]
	if !found {
		return default_value
	}
	#partial switch v in value {
	case json.Float:
		return f64(v)
	case json.Integer:
		return f64(v)
	}
	return default_value
}

getJsonU32Field :: proc(obj: json.Object, key: string, default_value: u32) -> u32 {
	value, found := obj[key]
	if !found {
		return default_value
	}
	if value_int, is_int := value.(json.Integer); is_int {
		if value_int >= 0 {
			return u32(value_int)
		}
	}
	return default_value
}

rectFromJsonObject :: proc(obj: json.Object) -> electrobun.Rect {
	return {
		x = getJsonF64Field(obj, "x", 0),
		y = getJsonF64Field(obj, "y", 0),
		width = getJsonF64Field(obj, "width", 0),
		height = getJsonF64Field(obj, "height", 0),
	}
}

milliTimestamp :: proc() -> i64 {
	return time.to_unix_nanoseconds(time.now()) / 1_000_000
}

WindowWithWebview :: struct {
	window_id:  u32,
	webview_id: u32,
}

CallbackState :: struct {
	mutex:                      sync.Mutex,
	window_close_count:         u32,
	window_resize_count:        u32,
	window_focus_count:         u32,
	last_resize_width:          f64,
	last_resize_height:         f64,
	webview_will_navigate_count: u32,
	webview_did_navigate_count: u32,
	webview_dom_ready_count:    u32,
	webview_tag_init_count:     u32,
	wgpu_tag_init_count:        u32,
	wgpu_tag_ready_count:       u32,
	before_quit_count:          u32,
	reopen_count:               u32,
	url_open_count:             u32,
	last_open_url:              [1024]u8,
	last_open_url_len:          int,
	last_webview_detail:        [1024]u8,
	last_webview_detail_len:    int,
}

g_callback_state: CallbackState

sleepMs :: proc(ms: u64) {
	time.sleep(time.Duration(ms) * time.Millisecond)
}

approxEq :: proc(a: f64, b: f64, tolerance: f64) -> bool {
	return abs(a - b) <= tolerance
}

resetCallbackState :: proc() {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.window_close_count = 0
	g_callback_state.window_resize_count = 0
	g_callback_state.window_focus_count = 0
	g_callback_state.last_resize_width = 0
	g_callback_state.last_resize_height = 0
	g_callback_state.webview_will_navigate_count = 0
	g_callback_state.webview_did_navigate_count = 0
	g_callback_state.webview_dom_ready_count = 0
	g_callback_state.webview_tag_init_count = 0
	g_callback_state.wgpu_tag_init_count = 0
	g_callback_state.wgpu_tag_ready_count = 0
	g_callback_state.before_quit_count = 0
	g_callback_state.reopen_count = 0
	g_callback_state.url_open_count = 0
	g_callback_state.last_open_url_len = 0
	g_callback_state.last_webview_detail_len = 0
}

getWindowCloseCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.window_close_count
}

getWindowResizeCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.window_resize_count
}

getWindowFocusCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.window_focus_count
}

getLastResizeSize :: proc() -> electrobun.Rect {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return {width = g_callback_state.last_resize_width, height = g_callback_state.last_resize_height}
}

getWebviewWillNavigateCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.webview_will_navigate_count
}

getWebviewDidNavigateCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.webview_did_navigate_count
}

getWebviewDomReadyCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.webview_dom_ready_count
}

getWebviewTagInitCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.webview_tag_init_count
}

getWgpuTagInitCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.wgpu_tag_init_count
}

getWgpuTagReadyCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.wgpu_tag_ready_count
}

getBeforeQuitCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.before_quit_count
}

getReopenCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.reopen_count
}

getUrlOpenCount :: proc() -> u32 {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return g_callback_state.url_open_count
}

getLastOpenUrl :: proc() -> string {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return string(g_callback_state.last_open_url[:g_callback_state.last_open_url_len])
}

lastWebviewDetailContains :: proc(needle: string) -> bool {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	return strings.contains(
		string(g_callback_state.last_webview_detail[:g_callback_state.last_webview_detail_len]),
		needle,
	)
}

observedWindowClose :: proc "c" (_: u32) {
	context = runtime.default_context()
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.window_close_count += 1
}

observedWindowResize :: proc "c" (_: u32, _: f64, _: f64, width: f64, height: f64) {
	context = runtime.default_context()
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.window_resize_count += 1
	g_callback_state.last_resize_width = width
	g_callback_state.last_resize_height = height
}

observedWindowFocus :: proc "c" (_: u32) {
	context = runtime.default_context()
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.window_focus_count += 1
}

recordObservedWebviewEvent :: proc(event_name_slice: string, detail_slice: string) {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)

	if event_name_slice == "will-navigate" {
		g_callback_state.webview_will_navigate_count += 1
	} else if event_name_slice == "did-navigate" {
		g_callback_state.webview_did_navigate_count += 1
	} else if event_name_slice == "dom-ready" {
		g_callback_state.webview_dom_ready_count += 1
	}

	copy_len := min(len(detail_slice), len(g_callback_state.last_webview_detail) - 1)
	copy(g_callback_state.last_webview_detail[:copy_len], detail_slice[:copy_len])
	g_callback_state.last_webview_detail_len = copy_len
	if copy_len < len(g_callback_state.last_webview_detail) {
		g_callback_state.last_webview_detail[copy_len] = 0
	}
}

recordWebviewTagInit :: proc() {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.webview_tag_init_count += 1
}

recordWgpuTagInit :: proc() {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.wgpu_tag_init_count += 1
}

recordWgpuTagReady :: proc() {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.wgpu_tag_ready_count += 1
}

recordBeforeQuit :: proc() {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.before_quit_count += 1
}

recordReopen :: proc() {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.reopen_count += 1
}

recordUrlOpen :: proc(url: string) {
	sync.mutex_lock(&g_callback_state.mutex)
	defer sync.mutex_unlock(&g_callback_state.mutex)
	g_callback_state.url_open_count += 1
	copy_len := min(len(url), len(g_callback_state.last_open_url) - 1)
	copy(g_callback_state.last_open_url[:copy_len], url[:copy_len])
	g_callback_state.last_open_url_len = copy_len
	if copy_len < len(g_callback_state.last_open_url) {
		g_callback_state.last_open_url[copy_len] = 0
	}
}

observedWebviewEvent :: proc "c" (_: u32, event_name: cstring, detail: cstring) {
	context = runtime.default_context()
	recordObservedWebviewEvent(string(event_name), string(detail))
}

observedWebviewBridge :: proc "c" (_: u32, message: cstring) {
	context = runtime.default_context()
	message_slice := string(message)
	if len(message_slice) == 0 {
		return
	}

	parsed, parse_err := json.parse_string(message_slice, json.DEFAULT_SPECIFICATION, true, context.allocator)
	if parse_err != .None {
		return
	}
	defer json.destroy_value(parsed, context.allocator)

	obj, is_object := parsed.(json.Object)
	if !is_object {
		return
	}

	id_string, id_is_string := getJsonStringField(obj, "id")
	type_string, type_is_string := getJsonStringField(obj, "type")
	if !id_is_string || !type_is_string {
		return
	}

	if id_string != "webviewEvent" || type_string != "message" {
		return
	}

	payload_value, has_payload := obj["payload"]
	if !has_payload {
		return
	}
	payload_obj, payload_is_object := payload_value.(json.Object)
	if !payload_is_object {
		return
	}

	event_name, has_event_name := getJsonStringField(payload_obj, "eventName")
	detail, has_detail := getJsonStringField(payload_obj, "detail")
	if !has_event_name || !has_detail {
		return
	}

	recordObservedWebviewEvent(event_name, detail)
}

childWebviewRenderer :: proc(webview_id: u32) -> electrobun.Renderer {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	if child_state, found := state.child_webviews[webview_id]; found {
		return child_state.renderer
	}
	return .native
}

rememberChildWebview :: proc(webview_id: u32, renderer: electrobun.Renderer) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.child_webviews[webview_id] = {renderer = renderer}
}

forgetChildWebview :: proc(webview_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	delete_key(&state.child_webviews, webview_id)
}

rememberTopLevelWebview :: proc(webview_id: u32, window_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.top_level_webview_windows[webview_id] = window_id
}

forgetTopLevelWebview :: proc(webview_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	delete_key(&state.top_level_webview_windows, webview_id)
}

windowIdForTopLevelWebview :: proc(webview_id: u32) -> (u32, bool) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	window_id, found := state.top_level_webview_windows[webview_id]
	return window_id, found
}

clearChildWebviews :: proc() {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	clear(&state.child_webviews)
}

electrobun_menu_delimiter :: "|EB|"

activePlaygroundRenderer :: proc(state: ^AppState) -> electrobun.Renderer {
	return .cef if state.cef_available && state.default_renderer == .cef else .native
}

defaultMenuRoleLabel :: proc(role: string) -> (string, bool) {
	switch role {
	case "about":
		return "About", true
	case "quit":
		return "Quit", true
	case "hide":
		return "Hide", true
	case "hideOthers":
		return "Hide Others", true
	case "showAll":
		return "Show All", true
	case "minimize":
		return "Minimize", true
	case "zoom":
		return "Zoom", true
	case "close":
		return "Close", true
	case "bringAllToFront":
		return "Bring All To Front", true
	case "cycleThroughWindows":
		return "Cycle Through Windows", true
	case "enterFullScreen":
		return "Enter Full Screen", true
	case "exitFullScreen":
		return "Exit Full Screen", true
	case "toggleFullScreen":
		return "Toggle Full Screen", true
	case "undo":
		return "Undo", true
	case "redo":
		return "Redo", true
	case "cut":
		return "Cut", true
	case "copy":
		return "Copy", true
	case "paste":
		return "Paste", true
	case "pasteAndMatchStyle":
		return "Paste and Match Style", true
	case "delete":
		return "Delete", true
	case "selectAll":
		return "Select All", true
	case "startSpeaking":
		return "Start Speaking", true
	case "stopSpeaking":
		return "Stop Speaking", true
	case "showHelp":
		return "Show Help", true
	}
	return "", false
}

setApplicationMenuTargetWebview :: proc(webview_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.application_menu_target_webview_id = webview_id
}

applicationMenuTargetWebview :: proc() -> u32 {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	return state.application_menu_target_webview_id
}

setContextMenuTargetWebview :: proc(webview_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.context_menu_target_webview_id = webview_id
}

contextMenuTargetWebview :: proc() -> u32 {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	return state.context_menu_target_webview_id
}

setShortcutTargetWebview :: proc(webview_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.shortcut_target_webview_id = webview_id
}

shortcutTargetWebview :: proc() -> u32 {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	return state.shortcut_target_webview_id
}

setQuitTargetWebview :: proc(webview_id: u32) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.quit_target_webview_id = webview_id
}

quitTargetWebview :: proc() -> u32 {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	return state.quit_target_webview_id
}

setBeforeQuitShouldCancel :: proc(cancel: bool) {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	state.before_quit_should_cancel = cancel
}

beforeQuitShouldCancel :: proc() -> bool {
	state := appState()
	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)
	return state.before_quit_should_cancel
}

storeMenuData :: proc(value: json.Value) -> (string, bool) {
	state := appState()
	data_json_bytes, marshal_err := json.marshal(value, {}, state.allocator)
	if marshal_err != nil {
		return "", false
	}
	data_json := string(data_json_bytes)

	sync.mutex_lock(&state.mutex)
	defer sync.mutex_unlock(&state.mutex)

	state.menu_data_counter += 1
	data_id := fmt.aprintf("menuData_%d", state.menu_data_counter, allocator = state.allocator)

	state.menu_data_registry[data_id] = data_json
	return data_id, true
}

writeJsonString :: proc(b: ^strings.Builder, value: string) {
	data, err := json.marshal(value, {}, context.allocator)
	if err == nil {
		strings.write_string(b, string(data))
		delete(data, context.allocator)
	} else {
		strings.write_string(b, "\"\"")
	}
}

writeMarshaledValue :: proc(b: ^strings.Builder, value: json.Value) -> bool {
	data, err := json.marshal(value, {}, context.allocator)
	if err != nil {
		return false
	}
	strings.write_string(b, string(data))
	delete(data, context.allocator)
	return true
}

// Emits the menu JSON while applying the same rewrites as the zig main's
// rewriteMenuActions: fill enabled/checked/hidden/type/label defaults, recurse
// into submenus, and encode actions that carry data payloads.
writeMenuValue :: proc(b: ^strings.Builder, value: json.Value) -> bool {
	#partial switch v in value {
	case json.Array:
		strings.write_string(b, "[")
		for item, index in v {
			if index > 0 {
				strings.write_string(b, ",")
			}
			if !writeMenuValue(b, item) {
				return false
			}
		}
		strings.write_string(b, "]")
		return true
	case json.Object:
		return writeMenuObject(b, v)
	}
	return writeMarshaledValue(b, value)
}

writeMenuObject :: proc(b: ^strings.Builder, obj: json.Object) -> bool {
	encoded_action: string
	has_encoded_action := false
	if action_value, has_action := obj["action"]; has_action {
		if action_string, action_is_string := action_value.(json.String); action_is_string {
			if data_value, has_data := obj["data"]; has_data {
				data_id, stored := storeMenuData(data_value)
				if !stored {
					return false
				}
				encoded_action = fmt.aprintf("%s%s|%s", electrobun_menu_delimiter, data_id, action_string)
				has_encoded_action = true
			}
		}
	}
	defer if has_encoded_action {
		delete(encoded_action)
	}

	strings.write_string(b, "{")
	first := true
	for key, value in obj {
		if !first {
			strings.write_string(b, ",")
		}
		first = false
		writeJsonString(b, key)
		strings.write_string(b, ":")
		if key == "submenu" {
			if !writeMenuValue(b, value) {
				return false
			}
		} else if key == "action" && has_encoded_action {
			writeJsonString(b, encoded_action)
		} else {
			if !writeMarshaledValue(b, value) {
				return false
			}
		}
	}

	if _, has_enabled := obj["enabled"]; !has_enabled {
		if !first {
			strings.write_string(b, ",")
		}
		first = false
		strings.write_string(b, "\"enabled\":true")
	}
	if _, has_checked := obj["checked"]; !has_checked {
		if !first {
			strings.write_string(b, ",")
		}
		first = false
		strings.write_string(b, "\"checked\":false")
	}
	if _, has_hidden := obj["hidden"]; !has_hidden {
		if !first {
			strings.write_string(b, ",")
		}
		first = false
		strings.write_string(b, "\"hidden\":false")
	}
	if _, has_type := obj["type"]; !has_type {
		type_name := "normal"
		if _, has_submenu := obj["submenu"]; has_submenu {
			type_name = "submenu"
		} else if label_value, has_label := obj["label"]; has_label {
			if label_string, label_is_string := label_value.(json.String); label_is_string && (len(label_string) == 0 || label_string == "-") {
				type_name = "divider"
			} else {
				type_name = "normal"
			}
		}
		if !first {
			strings.write_string(b, ",")
		}
		first = false
		strings.write_string(b, "\"type\":")
		writeJsonString(b, type_name)
	}
	if _, has_label := obj["label"]; !has_label {
		if role_value, has_role := obj["role"]; has_role {
			if role_string, role_is_string := role_value.(json.String); role_is_string {
				if label, label_found := defaultMenuRoleLabel(role_string); label_found {
					if !first {
						strings.write_string(b, ",")
					}
					first = false
					strings.write_string(b, "\"label\":")
					writeJsonString(b, label)
				}
			}
		}
	}
	strings.write_string(b, "}")
	return true
}

prepareMenuJson :: proc(menu_value: json.Value) -> (string, bool) {
	state := appState()
	b := strings.builder_make(state.allocator)
	if !writeMenuValue(&b, menu_value) {
		strings.builder_destroy(&b)
		return "", false
	}
	return strings.to_string(b), true
}

sendMenuClick :: proc(webview_id: u32, message_id: string, encoded_action: string) {
	if webview_id == 0 {
		return
	}

	if !strings.has_prefix(encoded_action, electrobun_menu_delimiter) {
		sendRpcMessage(webview_id, message_id, ActionPayload{action = encoded_action})
		return
	}

	remainder := encoded_action[len(electrobun_menu_delimiter):]
	separator_index := strings.index_byte(remainder, '|')
	if separator_index < 0 {
		sendRpcMessage(webview_id, message_id, ActionPayload{action = encoded_action})
		return
	}

	data_id := remainder[:separator_index]
	action := remainder[separator_index + 1:]

	state := appState()
	removed_key: string
	removed_value: string
	removed := false
	sync.mutex_lock(&state.mutex)
	for key, value in state.menu_data_registry {
		if key == data_id {
			removed_key = key
			removed_value = value
			removed = true
			break
		}
	}
	if removed {
		delete_key(&state.menu_data_registry, data_id)
	}
	sync.mutex_unlock(&state.mutex)

	if removed {
		defer {
			delete(removed_key, state.allocator)
			delete(removed_value, state.allocator)
		}

		parsed, parse_err := json.parse_string(removed_value, json.DEFAULT_SPECIFICATION, true, state.allocator)
		if parse_err != .None {
			sendRpcMessage(webview_id, message_id, ActionPayload{action = action})
			return
		}
		defer json.destroy_value(parsed, state.allocator)

		sendRpcMessage(webview_id, message_id, ActionDataPayload{action = action, data = parsed})
		return
	}

	sendRpcMessage(webview_id, message_id, ActionPayload{action = action})
}

applicationMenuHandler :: proc "c" (_: u32, encoded_action: cstring) {
	context = runtime.default_context()
	sendMenuClick(applicationMenuTargetWebview(), "menuClicked", string(encoded_action))
}

contextMenuHandler :: proc "c" (_: u32, encoded_action: cstring) {
	context = runtime.default_context()
	sendMenuClick(contextMenuTargetWebview(), "contextMenuClicked", string(encoded_action))
}

shortcutTriggeredHandler :: proc "c" (accelerator: cstring) {
	context = runtime.default_context()
	webview_id := shortcutTargetWebview()
	if webview_id == 0 {
		return
	}
	sendRpcMessage(webview_id, "shortcutTriggered", AcceleratorPayload{accelerator = string(accelerator)})
}

quitRequestedHandler :: proc "c" () {
	context = runtime.default_context()
	recordBeforeQuit()
	webview_id := quitTargetWebview()
	if webview_id != 0 {
		sendRpcMessage(webview_id, "beforeQuitFired", MessagePayload{
			message = "beforeQuit handler fired! Waiting 2 seconds for cleanup...",
		})
	}

	sleepMs(2000)

	if webview_id != 0 {
		done_message :=
			"beforeQuit cleanup complete (2s elapsed). Quit cancelled in Odin mode." if beforeQuitShouldCancel() else "beforeQuit cleanup complete (2s elapsed). Quitting now."
		sendRpcMessage(webview_id, "beforeQuitDone", MessagePayload{message = done_message})
	}

	if !beforeQuitShouldCancel() {
		electrobun.quitGracefully(appState().core, 0)
	}
}

urlOpenHandler :: proc "c" (url: cstring) {
	context = runtime.default_context()
	recordUrlOpen(string(url))
}

appReopenHandler :: proc "c" () {
	context = runtime.default_context()
	when ODIN_OS == .Darwin {
		_ = electrobun.setDockIconVisible(appState().core, true)
	}
	recordReopen()
}

splitCsvPaths :: proc(allocator: runtime.Allocator, csv: string) -> []string {
	if len(csv) == 0 {
		return make([]string, 0, allocator)
	}
	parts, _ := strings.split(csv, ",", allocator)
	return parts
}

expandTildePathAlloc :: proc(allocator: runtime.Allocator, path: string) -> (string, bool) {
	if len(path) == 0 || path[0] != '~' {
		cloned, _ := strings.clone(path, allocator)
		return cloned, true
	}

	home, home_found := os.lookup_env("HOME", allocator)
	if !home_found {
		return "", false
	}
	defer delete(home, allocator)

	if len(path) == 1 {
		cloned, _ := strings.clone(home, allocator)
		return cloned, true
	}
	if len(path) >= 2 && path[1] == '/' {
		joined, _ := filepath.join({home, path[2:]}, allocator)
		return joined, true
	}
	cloned, _ := strings.clone(path, allocator)
	return cloned, true
}

sendInternalBridgeResponse :: proc(host_webview_id: u32, request_id: string, success: bool, payload: $T) {
	packet := InternalResponsePacket(T) {
		type = "response",
		id = request_id,
		success = success,
		payload = payload,
	}
	if err := electrobun.sendInternalMessageToWebview(appState().core, host_webview_id, packet); err != .None {
		fmt.eprintf("[kitchen odin] failed to send internal bridge response '%s': %s\n", request_id, errName(err))
	}
}

sendInternalBridgeError :: proc(host_webview_id: u32, request_id: string, message: string) {
	sendInternalBridgeResponse(host_webview_id, request_id, false, message)
}

createChildWebviewFromInternalBridge :: proc(host_webview_id: u32, params_obj: json.Object) -> (u32, string) {
	renderer_string, has_renderer := getJsonStringField(params_obj, "renderer")
	if !has_renderer {
		renderer_string = "native"
	}
	renderer: electrobun.Renderer = .cef if renderer_string == "cef" else .native
	url, has_url := getJsonStringField(params_obj, "url")
	html, has_html := getJsonStringField(params_obj, "html")
	preload, has_preload := getJsonStringField(params_obj, "preload")
	if !has_preload {
		preload = ""
	}
	partition, has_partition := getJsonStringField(params_obj, "partition")
	if !has_partition {
		partition = "persist:default"
	}
	window_id := getJsonU32Field(params_obj, "windowId", 0)
	sandbox := getJsonBoolField(params_obj, "sandbox", false)
	transparent := getJsonBoolField(params_obj, "transparent", false)
	passthrough := getJsonBoolField(params_obj, "passthrough", false)

	frame_value, has_frame := params_obj["frame"]
	if !has_frame {
		return 0, "MissingFrame"
	}
	frame_obj, frame_is_object := frame_value.(json.Object)
	if !frame_is_object {
		return 0, "InvalidFrame"
	}
	frame := rectFromJsonObject(frame_obj)

	effective_url: string
	if has_url {
		effective_url = url
	} else if !has_html {
		effective_url = "https://electrobun.dev"
	} else {
		effective_url = ""
	}

	options := electrobun.defaultWebviewOptions(window_id)
	options.host_webview_id = host_webview_id
	options.renderer = renderer
	options.url = effective_url
	options.frame = frame
	options.auto_resize = false
	options.partition = partition
	options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = electrobun.noopWebviewEvent,
		event_bridge = electrobun.noopWebviewPostMessage,
		host_bridge = electrobun.noopWebviewPostMessage,
		internal_bridge = electrobun.noopWebviewPostMessage,
	}
	options.secret_key = default_secret_key
	options.preload = preload
	options.sandbox = sandbox
	options.start_transparent = transparent
	options.start_passthrough = passthrough

	webview_id, create_err := electrobun.createWebview(appState().core, options)
	if create_err != .None {
		return 0, errName(create_err)
	}

	rememberChildWebview(webview_id, renderer)
	recordWebviewTagInit()

	if has_html {
		if renderer == .cef {
			if err := electrobun.setWebviewHTMLContent(appState().core, webview_id, html); err != .None {
				return 0, errName(err)
			}
			if err := electrobun.loadURLInWebview(appState().core, webview_id, "views://internal/index.html"); err != .None {
				return 0, errName(err)
			}
		} else {
			if err := electrobun.loadHTMLInWebview(appState().core, webview_id, html); err != .None {
				return 0, errName(err)
			}
		}
	}

	return webview_id, ""
}

createWgpuViewFromInternalBridge :: proc(params_obj: json.Object) -> (u32, string) {
	window_id := getJsonU32Field(params_obj, "windowId", 0)
	transparent := getJsonBoolField(params_obj, "transparent", false)
	passthrough := getJsonBoolField(params_obj, "passthrough", false)

	frame_value, has_frame := params_obj["frame"]
	if !has_frame {
		return 0, "MissingFrame"
	}
	frame_obj, frame_is_object := frame_value.(json.Object)
	if !frame_is_object {
		return 0, "InvalidFrame"
	}
	frame := rectFromJsonObject(frame_obj)

	options := electrobun.defaultWGPUViewOptions(window_id)
	options.frame = frame
	options.auto_resize = false
	options.start_transparent = transparent
	options.start_passthrough = passthrough

	wgpu_view_id, create_err := electrobun.createWGPUView(appState().core, options)
	if create_err != .None {
		return 0, errName(create_err)
	}

	recordWgpuTagInit()
	return wgpu_view_id, ""
}

handleInternalBridgeRequest :: proc(host_webview_id: u32, request_id: string, method: string, params_obj: json.Object) {
	if method == "webviewTagInit" {
		webview_id, err_name := createChildWebviewFromInternalBridge(host_webview_id, params_obj)
		if err_name != "" {
			sendInternalBridgeError(host_webview_id, request_id, err_name)
			return
		}
		sendInternalBridgeResponse(host_webview_id, request_id, true, webview_id)
		return
	}

	if method == "webviewTagCanGoBack" {
		sendInternalBridgeResponse(
			host_webview_id,
			request_id,
			true,
			electrobun.canWebviewGoBack(appState().core, getJsonU32Field(params_obj, "id", 0)),
		)
		return
	}

	if method == "webviewTagCanGoForward" {
		sendInternalBridgeResponse(
			host_webview_id,
			request_id,
			true,
			electrobun.canWebviewGoForward(appState().core, getJsonU32Field(params_obj, "id", 0)),
		)
		return
	}

	if method == "wgpuTagInit" {
		wgpu_view_id, err_name := createWgpuViewFromInternalBridge(params_obj)
		if err_name != "" {
			sendInternalBridgeError(host_webview_id, request_id, err_name)
			return
		}
		sendInternalBridgeResponse(host_webview_id, request_id, true, wgpu_view_id)
		return
	}

	sendInternalBridgeError(host_webview_id, request_id, "Unsupported internal bridge request")
}

handleInternalBridgeMessage :: proc(message_id: string, params_obj: json.Object) {
	webview_id := getJsonU32Field(params_obj, "id", 0)
	if webview_id == 0 {
		return
	}

	if message_id == "webviewTagResize" {
		frame_value, has_frame := params_obj["frame"]
		if !has_frame {
			return
		}
		frame_obj, frame_is_object := frame_value.(json.Object)
		if !frame_is_object {
			return
		}
		frame := rectFromJsonObject(frame_obj)
		masks, has_masks := getJsonStringField(params_obj, "masks")
		if !has_masks {
			masks = "[]"
		}
		_ = electrobun.resizeWebview(appState().core, webview_id, frame, masks)
		return
	}

	if message_id == "webviewTagUpdateSrc" {
		url, has_url := getJsonStringField(params_obj, "url")
		if !has_url {
			return
		}
		_ = electrobun.loadURLInWebview(appState().core, webview_id, url)
		return
	}

	if message_id == "webviewTagUpdateHtml" {
		html, has_html := getJsonStringField(params_obj, "html")
		if !has_html {
			return
		}
		if childWebviewRenderer(webview_id) == .cef {
			_ = electrobun.setWebviewHTMLContent(appState().core, webview_id, html)
			_ = electrobun.loadURLInWebview(appState().core, webview_id, "views://internal/index.html")
		} else {
			_ = electrobun.loadHTMLInWebview(appState().core, webview_id, html)
		}
		return
	}

	if message_id == "webviewTagGoBack" {
		_ = electrobun.webviewGoBack(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagGoForward" {
		_ = electrobun.webviewGoForward(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagReload" {
		_ = electrobun.reloadWebview(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagRemove" {
		_ = electrobun.removeWebview(appState().core, webview_id)
		forgetChildWebview(webview_id)
		return
	}

	if message_id == "webviewTagSetTransparent" {
		_ = electrobun.setWebviewTransparent(appState().core, webview_id, getJsonBoolField(params_obj, "transparent", false))
		return
	}

	if message_id == "webviewTagSetPassthrough" {
		_ = electrobun.setWebviewPassthrough(appState().core, webview_id, getJsonBoolField(params_obj, "enablePassthrough", false))
		return
	}

	if message_id == "webviewTagSetHidden" {
		_ = electrobun.setWebviewHidden(appState().core, webview_id, getJsonBoolField(params_obj, "hidden", false))
		return
	}

	if message_id == "webviewTagSetNavigationRules" {
		rules_value, has_rules := params_obj["rules"]
		if !has_rules {
			return
		}
		rules_json, marshal_err := json.marshal(rules_value, {}, appState().allocator)
		if marshal_err != nil {
			return
		}
		defer delete(rules_json, appState().allocator)
		_ = electrobun.setWebviewNavigationRules(appState().core, webview_id, string(rules_json))
		return
	}

	if message_id == "webviewTagFindInPage" {
		search_text, has_search_text := getJsonStringField(params_obj, "searchText")
		if !has_search_text {
			return
		}
		forward := getJsonBoolField(params_obj, "forward", true)
		match_case := getJsonBoolField(params_obj, "matchCase", false)
		_ = electrobun.webviewFindInPage(appState().core, webview_id, search_text, forward, match_case)
		return
	}

	if message_id == "webviewTagStopFind" {
		_ = electrobun.webviewStopFind(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagOpenDevTools" {
		_ = electrobun.openWebviewDevTools(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagCloseDevTools" {
		_ = electrobun.closeWebviewDevTools(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagToggleDevTools" {
		_ = electrobun.toggleWebviewDevTools(appState().core, webview_id)
		return
	}

	if message_id == "webviewTagExecuteJavascript" {
		js, has_js := getJsonStringField(params_obj, "js")
		if !has_js {
			return
		}
		_ = electrobun.evaluateJavaScriptWithNoCompletion(appState().core, webview_id, js)
		return
	}

	if message_id == "wgpuTagResize" {
		frame_value, has_frame := params_obj["frame"]
		if !has_frame {
			return
		}
		frame_obj, frame_is_object := frame_value.(json.Object)
		if !frame_is_object {
			return
		}
		frame := rectFromJsonObject(frame_obj)
		masks, has_masks := getJsonStringField(params_obj, "masks")
		if !has_masks {
			masks = "[]"
		}
		_ = electrobun.resizeWGPUView(appState().core, webview_id, frame, masks)
		return
	}

	if message_id == "wgpuTagSetTransparent" {
		_ = electrobun.setWGPUViewTransparent(appState().core, webview_id, getJsonBoolField(params_obj, "transparent", false))
		return
	}

	if message_id == "wgpuTagSetPassthrough" {
		_ = electrobun.setWGPUViewPassthrough(appState().core, webview_id, getJsonBoolField(params_obj, "passthrough", false))
		return
	}

	if message_id == "wgpuTagSetHidden" {
		_ = electrobun.setWGPUViewHidden(appState().core, webview_id, getJsonBoolField(params_obj, "hidden", false))
		return
	}

	if message_id == "wgpuTagRemove" {
		_ = electrobun.removeWGPUView(appState().core, webview_id)
		return
	}

	if message_id == "wgpuTagRunTest" {
		_ = electrobun.runWGPUViewTest(appState().core, webview_id)
		return
	}
}

playgroundInternalBridge :: proc "c" (host_webview_id: u32, message: cstring) {
	context = runtime.default_context()
	message_slice := string(message)
	if len(message_slice) == 0 {
		return
	}

	parsed, parse_err := json.parse_string(message_slice, json.DEFAULT_SPECIFICATION, true, context.allocator)
	if parse_err != .None {
		fmt.eprintf("[kitchen odin] failed to parse internal bridge packet: %v\n", parse_err)
		return
	}
	defer json.destroy_value(parsed, context.allocator)

	if obj, is_object := parsed.(json.Object); is_object {
		id_string, id_is_string := getJsonStringField(obj, "id")
		type_string, type_is_string := getJsonStringField(obj, "type")
		if !id_is_string || !type_is_string {
			return
		}
		if id_string == "webviewEvent" && type_string == "message" {
			payload_value, has_payload := obj["payload"]
			if !has_payload {
				return
			}
			if payload_obj, payload_is_object := payload_value.(json.Object); payload_is_object {
				event_name, has_event_name := getJsonStringField(payload_obj, "eventName")
				if !has_event_name {
					return
				}
				detail, has_detail := getJsonStringField(payload_obj, "detail")
				if !has_detail {
					return
				}
				recordObservedWebviewEvent(event_name, detail)
			}
			return
		}
	}

	items, is_array := parsed.(json.Array)
	if !is_array {
		return
	}

	for item in items {
		item_string, item_is_string := item.(json.String)
		if !item_is_string {
			continue
		}

		packet, packet_err := json.parse_string(item_string, json.DEFAULT_SPECIFICATION, true, context.allocator)
		if packet_err != .None {
			continue
		}
		defer json.destroy_value(packet, context.allocator)
		packet_obj, packet_is_object := packet.(json.Object)
		if !packet_is_object {
			continue
		}

		packet_type, has_packet_type := getJsonStringField(packet_obj, "type")
		if !has_packet_type {
			continue
		}
		if packet_type == "message" {
			message_id, has_message_id := getJsonStringField(packet_obj, "id")
			if !has_message_id {
				continue
			}
			payload_value, has_payload := packet_obj["payload"]
			if !has_payload {
				continue
			}
			payload_obj, payload_is_object := payload_value.(json.Object)
			if !payload_is_object {
				continue
			}
			handleInternalBridgeMessage(message_id, payload_obj)
		} else if packet_type == "request" {
			request_id, has_request_id := getJsonStringField(packet_obj, "id")
			if !has_request_id {
				continue
			}
			method, has_method := getJsonStringField(packet_obj, "method")
			if !has_method {
				continue
			}
			params_value, has_params := packet_obj["params"]
			if !has_params {
				continue
			}
			params_obj, params_is_object := params_value.(json.Object)
			if !params_is_object {
				continue
			}
			handleInternalBridgeRequest(host_webview_id, request_id, method, params_obj)
		}
	}
}

noopHarnessWebviewCallbacks :: proc() -> electrobun.WebviewCallbacks {
	return {
		decide_navigation = electrobun.allowAllNavigation,
		event = electrobun.noopWebviewEvent,
		event_bridge = electrobun.noopWebviewPostMessage,
		host_bridge = electrobun.noopWebviewPostMessage,
		internal_bridge = electrobun.noopWebviewPostMessage,
	}
}

observedHarnessWebviewCallbacks :: proc() -> electrobun.WebviewCallbacks {
	return {
		decide_navigation = electrobun.allowAllNavigation,
		event = observedWebviewEvent,
		event_bridge = observedWebviewBridge,
		host_bridge = electrobun.noopWebviewPostMessage,
		internal_bridge = observedWebviewBridge,
	}
}

createWindowWithHarnessCustom :: proc(
	state: ^AppState,
	title: string,
	frame: electrobun.Rect,
	hidden: bool,
	activate: bool,
	title_bar_style: string,
	window_callbacks: electrobun.WindowCallbacks,
	webview_callbacks: electrobun.WebviewCallbacks,
) -> (WindowWithWebview, string) {
	window_options := electrobun.defaultWindowOptions(title)
	window_options.frame = frame
	window_options.hidden = hidden
	window_options.activate = activate
	window_options.title_bar_style = title_bar_style
	window_options.callbacks = window_callbacks

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return {}, errName(window_err)
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .native
	webview_options.url = test_harness_url
	webview_options.frame = {0, 0, frame.width, frame.height}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = webview_callbacks
	webview_options.sandbox = false

	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return {}, errName(webview_err)
	}

	return {window_id = window_id, webview_id = webview_id}, ""
}

openInteractivePlaygroundWindow :: proc(
	state: ^AppState,
	title: string,
	url: string,
	renderer: electrobun.Renderer,
	frame: electrobun.Rect,
) -> (WindowWithWebview, string) {
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions(title)
	window_options.frame = frame
	window_options.hidden = false
	window_options.activate = true
	window_options.callbacks = {
		close = observedWindowClose,
	}

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return {}, errName(window_err)
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = renderer
	webview_options.url = url
	webview_options.frame = {0, 0, frame.width, frame.height}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = observedWebviewEvent,
		event_bridge = observedWebviewBridge,
		host_bridge = testRunnerHostBridge,
		internal_bridge = playgroundInternalBridge,
	}
	webview_options.sandbox = false

	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return {}, errName(webview_err)
	}
	rememberTopLevelWebview(webview_id, window_id)

	if err := electrobun.setWindowAlwaysOnTop(state.core, window_id, true); err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return {}, errName(err)
	}
	return {window_id = window_id, webview_id = webview_id}, ""
}

createWindowWithTestHarness :: proc(
	state: ^AppState,
	title: string,
	frame: electrobun.Rect,
	hidden: bool,
	activate: bool,
) -> (WindowWithWebview, string) {
	return createWindowWithHarnessCustom(
		state,
		title,
		frame,
		hidden,
		activate,
		"default",
		{},
		noopHarnessWebviewCallbacks(),
	)
}

runSmokeTest :: proc() -> string {
	return ""
}

runWindowCreateCloseTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Electrobun Odin Window Test")
	window_options.frame = {60, 60, 320, 240}
	window_options.hidden = false
	window_options.activate = true

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	sleepMs(visible_test_window_delay_ms)
	if err := electrobun.closeWindow(state.core, window_id); err != .None {
		return errName(err)
	}
	return ""
}

runWindowCreationWithUrlTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"URL Window Test",
		{120, 120, 400, 300},
		true,
		false,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	if created.window_id == 0 || created.webview_id == 0 {
		return "InvalidWindowOrWebviewId"
	}
	return ""
}

runWindowHiddenOptionTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Hidden Window Test",
		{140, 140, 400, 300},
		true,
		false,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	if err := electrobun.showWindow(state.core, created.window_id, true); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)
	return ""
}

runWindowInactiveShowApiTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Inactive Show Test",
		{150, 150, 400, 300},
		true,
		false,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	if err := electrobun.showWindow(state.core, created.window_id, false); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)
	if err := electrobun.activateWindow(state.core, created.window_id); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)
	return ""
}

runWindowPageZoomTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Page Zoom Test",
		{150, 150, 420, 320},
		true,
		false,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	target_zoom := 1.25
	if err := electrobun.setWebviewPageZoom(state.core, created.webview_id, target_zoom); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)

	zoom := electrobun.getWebviewPageZoom(state.core, created.webview_id)
	when ODIN_OS == .Darwin || ODIN_OS == .Windows {
		if !approxEq(zoom, target_zoom, 0.02) {
			return "UnexpectedWindowZoom"
		}
	} else {
		if !approxEq(zoom, 1.0, 0.02) {
			return "UnexpectedWindowZoom"
		}
	}
	return ""
}

runWindowSetTitleTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Original Title")
	window_options.frame = {160, 160, 400, 300}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	if err := electrobun.setWindowTitle(state.core, window_id, "New Title From Odin Test"); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)
	return ""
}

runWindowMinimizeUnminimizeTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Minimize Test",
		{160, 160, 420, 320},
		false,
		true,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(long_wait_ms)
	if electrobun.isWindowMinimized(state.core, created.window_id) {
		return "UnexpectedInitialMinimizedState"
	}

	if err := electrobun.minimizeWindow(state.core, created.window_id); err != .None {
		return errName(err)
	}
	sleepMs(2000)
	if !electrobun.isWindowMinimized(state.core, created.window_id) {
		return "WindowDidNotMinimize"
	}

	if err := electrobun.restoreWindow(state.core, created.window_id); err != .None {
		return errName(err)
	}
	sleepMs(3000)
	if electrobun.isWindowMinimized(state.core, created.window_id) {
		return "WindowDidNotRestore"
	}
	return ""
}

runWindowFullscreenToggleTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Fullscreen Test",
		{170, 170, 420, 320},
		false,
		true,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(medium_wait_ms)
	if electrobun.isWindowFullScreen(state.core, created.window_id) {
		return "UnexpectedInitialFullscreenState"
	}

	if err := electrobun.setWindowFullScreen(state.core, created.window_id, true); err != .None {
		return errName(err)
	}
	sleepMs(long_wait_ms)
	if !electrobun.isWindowFullScreen(state.core, created.window_id) {
		return "WindowDidNotEnterFullscreen"
	}

	if err := electrobun.setWindowFullScreen(state.core, created.window_id, false); err != .None {
		return errName(err)
	}
	sleepMs(long_wait_ms)
	if electrobun.isWindowFullScreen(state.core, created.window_id) {
		return "WindowDidNotExitFullscreen"
	}
	return ""
}

runWindowFullscreenToggleHiddenTitlebarTest :: proc(state: ^AppState) -> string {
	when ODIN_OS != .Darwin {
		return ""
	} else {
		created, create_err := createWindowWithHarnessCustom(
			state,
			"Hidden Fullscreen Test",
			{180, 180, 420, 320},
			false,
			true,
			"hidden",
			{},
			noopHarnessWebviewCallbacks(),
		)
		if create_err != "" {
			return create_err
		}
		defer electrobun.closeWindow(state.core, created.window_id)

		sleepMs(medium_wait_ms)
		if electrobun.isWindowFullScreen(state.core, created.window_id) {
			return "UnexpectedInitialFullscreenState"
		}

		if err := electrobun.setWindowFullScreen(state.core, created.window_id, true); err != .None {
			return errName(err)
		}
		sleepMs(long_wait_ms)
		if !electrobun.isWindowFullScreen(state.core, created.window_id) {
			return "WindowDidNotEnterFullscreen"
		}

		if err := electrobun.setWindowFullScreen(state.core, created.window_id, false); err != .None {
			return errName(err)
		}
		sleepMs(long_wait_ms)
		if electrobun.isWindowFullScreen(state.core, created.window_id) {
			return "WindowDidNotExitFullscreen"
		}
		return ""
	}
}

runWindowSetPositionTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Position Test")
	window_options.frame = {50, 60, 420, 320}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	if err := electrobun.setWindowPosition(state.core, window_id, 200, 200); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)

	frame, frame_err := electrobun.getWindowFrame(state.core, window_id)
	if frame_err != .None {
		return errName(frame_err)
	}
	if !approxEq(frame.x, 200, 4) || !approxEq(frame.y, 200, 4) {
		return "UnexpectedWindowPosition"
	}
	return ""
}

runWindowSetSizeTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Size Test")
	window_options.frame = {70, 80, 420, 320}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	if err := electrobun.setWindowSize(state.core, window_id, 600, 500); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)

	frame, frame_err := electrobun.getWindowFrame(state.core, window_id)
	if frame_err != .None {
		return errName(frame_err)
	}
	if !approxEq(frame.width, 600, 4) || !approxEq(frame.height, 500, 4) {
		return "UnexpectedWindowSize"
	}
	return ""
}

runWindowSetFrameTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Electrobun Odin Frame Test")
	window_options.frame = {80, 80, 320, 240}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	if err := electrobun.setWindowFrame(state.core, window_id, {120, 140, 640, 480}); err != .None {
		return errName(err)
	}

	frame, frame_err := electrobun.getWindowFrame(state.core, window_id)
	if frame_err != .None {
		return errName(frame_err)
	}
	if frame.width != 640 || frame.height != 480 {
		return "UnexpectedWindowFrame"
	}
	return ""
}

runWindowGetFrameTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("GetFrame Test")
	window_options.frame = {150, 150, 500, 400}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	sleepMs(short_wait_ms)
	frame, frame_err := electrobun.getWindowFrame(state.core, window_id)
	if frame_err != .None {
		return errName(frame_err)
	}
	if frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0 {
		return "InvalidWindowFrame"
	}
	if !approxEq(frame.width, 500, 100) || !approxEq(frame.height, 400, 100) {
		return "UnexpectedWindowFrame"
	}
	return ""
}

runWindowGetPositionTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("GetPosition Test")
	window_options.frame = {200, 180, 400, 300}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	sleepMs(short_wait_ms)
	frame, frame_err := electrobun.getWindowFrame(state.core, window_id)
	if frame_err != .None {
		return errName(frame_err)
	}
	if frame.x < 0 || frame.y < 0 {
		return "InvalidWindowPosition"
	}
	return ""
}

runWindowGetSizeTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("GetSize Test")
	window_options.frame = {100, 100, 600, 450}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	sleepMs(short_wait_ms)
	frame, frame_err := electrobun.getWindowFrame(state.core, window_id)
	if frame_err != .None {
		return errName(frame_err)
	}
	if frame.width <= 0 || frame.height <= 0 {
		return "InvalidWindowSize"
	}
	if !approxEq(frame.width, 600, 100) || !approxEq(frame.height, 450, 100) {
		return "UnexpectedWindowSize"
	}
	return ""
}

runWindowMaximizeUnmaximizeTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Maximize Test",
		{180, 180, 420, 320},
		false,
		true,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(medium_wait_ms)
	if electrobun.isWindowMaximized(state.core, created.window_id) {
		return "UnexpectedInitialMaximizedState"
	}

	if err := electrobun.maximizeWindow(state.core, created.window_id); err != .None {
		return errName(err)
	}
	sleepMs(long_wait_ms)
	if !electrobun.isWindowMaximized(state.core, created.window_id) {
		return "WindowDidNotMaximize"
	}

	if err := electrobun.unmaximizeWindow(state.core, created.window_id); err != .None {
		return errName(err)
	}
	sleepMs(long_wait_ms)
	if electrobun.isWindowMaximized(state.core, created.window_id) {
		return "WindowDidNotUnmaximize"
	}
	return ""
}

runWindowAlwaysOnTopTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Always On Top Test",
		{200, 200, 420, 320},
		false,
		true,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(short_wait_ms)
	if electrobun.isWindowAlwaysOnTop(state.core, created.window_id) {
		return "UnexpectedInitialAlwaysOnTopState"
	}

	if err := electrobun.setWindowAlwaysOnTop(state.core, created.window_id, true); err != .None {
		return errName(err)
	}
	sleepMs(long_wait_ms)
	if !electrobun.isWindowAlwaysOnTop(state.core, created.window_id) {
		return "WindowDidNotBecomeAlwaysOnTop"
	}

	if err := electrobun.setWindowAlwaysOnTop(state.core, created.window_id, false); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)
	if electrobun.isWindowAlwaysOnTop(state.core, created.window_id) {
		return "WindowDidNotClearAlwaysOnTop"
	}
	return ""
}

runWindowVisibleOnAllWorkspacesTest :: proc(state: ^AppState) -> string {
	when ODIN_OS != .Darwin {
		return ""
	} else {
		created, create_err := createWindowWithTestHarness(
			state,
			"Visible On All Workspaces Test",
			{220, 220, 420, 320},
			false,
			true,
		)
		if create_err != "" {
			return create_err
		}
		defer electrobun.closeWindow(state.core, created.window_id)

		sleepMs(short_wait_ms)
		if electrobun.isWindowVisibleOnAllWorkspaces(state.core, created.window_id) {
			return "UnexpectedInitialVisibleOnAllWorkspacesState"
		}

		if err := electrobun.setWindowVisibleOnAllWorkspaces(state.core, created.window_id, true); err != .None {
			return errName(err)
		}
		sleepMs(long_wait_ms)
		if !electrobun.isWindowVisibleOnAllWorkspaces(state.core, created.window_id) {
			return "WindowDidNotBecomeVisibleOnAllWorkspaces"
		}

		if err := electrobun.setWindowVisibleOnAllWorkspaces(state.core, created.window_id, false); err != .None {
			return errName(err)
		}
		sleepMs(medium_wait_ms)
		if electrobun.isWindowVisibleOnAllWorkspaces(state.core, created.window_id) {
			return "WindowDidNotClearVisibleOnAllWorkspaces"
		}
		return ""
	}
}

runWindowFocusTest :: proc(state: ^AppState) -> string {
	resetCallbackState()

	win1_options := electrobun.defaultWindowOptions("Focus Test 1")
	win1_options.frame = {100, 100, 360, 260}
	win1_options.callbacks = {
		focus = observedWindowFocus,
	}

	win1, win1_err := electrobun.createWindow(state.core, win1_options)
	if win1_err != .None {
		return errName(win1_err)
	}
	defer electrobun.closeWindow(state.core, win1)

	win2_options := electrobun.defaultWindowOptions("Focus Test 2")
	win2_options.frame = {220, 220, 360, 260}
	win2_options.callbacks = {
		focus = observedWindowFocus,
	}

	win2, win2_err := electrobun.createWindow(state.core, win2_options)
	if win2_err != .None {
		return errName(win2_err)
	}
	defer electrobun.closeWindow(state.core, win2)

	sleepMs(medium_wait_ms)
	resetCallbackState()
	if err := electrobun.activateWindow(state.core, win1); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)
	if err := electrobun.activateWindow(state.core, win2); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)

	if getWindowFocusCount() == 0 {
		return "WindowFocusEventDidNotFire"
	}
	return ""
}

runWindowCloseEventTest :: proc(state: ^AppState) -> string {
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions("Close Event Test")
	window_options.frame = {120, 120, 360, 260}
	window_options.callbacks = {
		close = observedWindowClose,
	}

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}

	sleepMs(short_wait_ms)
	if err := electrobun.closeWindow(state.core, window_id); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)

	if getWindowCloseCount() == 0 {
		return "WindowCloseEventDidNotFire"
	}
	return ""
}

runWindowResizeEventTest :: proc(state: ^AppState) -> string {
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions("Resize Event Test")
	window_options.frame = {120, 120, 400, 300}
	window_options.callbacks = {
		resize = observedWindowResize,
	}

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	sleepMs(short_wait_ms)
	resetCallbackState()
	if err := electrobun.setWindowSize(state.core, window_id, 700, 520); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)

	resize_count := getWindowResizeCount()
	last_size := getLastResizeSize()
	if resize_count == 0 {
		return "WindowResizeEventDidNotFire"
	}
	if last_size.width <= 400 || last_size.height <= 300 {
		return "WindowResizeEventDidNotReportUpdatedSize"
	}
	return ""
}

runWindowGetByIdTest :: proc(state: ^AppState) -> string {
	registry := electrobun.windowRegistryInit(state.allocator, state.core)
	defer electrobun.windowRegistryDeinit(&registry)

	window_options := electrobun.defaultWindowOptions("GetById Test")
	window_options.frame = {260, 260, 420, 320}
	window_options.hidden = true
	window_options.activate = false

	window, window_err := electrobun.createBrowserWindow(&registry, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.windowClose(window)

	retrieved, found := electrobun.getById(&registry, window.id)
	if !found {
		return "WindowRegistryLookupFailed"
	}
	if retrieved.id != window.id {
		return "WindowRegistryReturnedUnexpectedId"
	}
	return ""
}

runWindowInsetTitlebarStyleTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Inset Titlebar")
	window_options.frame = {270, 270, 420, 320}
	window_options.title_bar_style = "hiddenInset"

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	if window_id == 0 {
		return "InvalidInsetTitlebarWindowId"
	}
	sleepMs(300)
	return ""
}

runWindowTrafficLightPositionApiTest :: proc(state: ^AppState) -> string {
	when ODIN_OS != .Darwin {
		return ""
	} else {
		registry := electrobun.windowRegistryInit(state.allocator, state.core)
		defer electrobun.windowRegistryDeinit(&registry)

		window_options := electrobun.defaultWindowOptions("Traffic Light Position Test")
		window_options.frame = {280, 280, 480, 340}
		window_options.title_bar_style = "hiddenInset"
		window_options.traffic_light_offset = {x = 24, y = 18}

		window, window_err := electrobun.createBrowserWindow(&registry, window_options)
		if window_err != .None {
			return errName(window_err)
		}
		defer electrobun.windowClose(window)

		sleepMs(300)
		if err := electrobun.windowSetWindowButtonPosition(window, 52, 22); err != .None {
			return errName(err)
		}
		sleepMs(300)
		return ""
	}
}

runWebviewCreateTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("Electrobun Odin Webview Test")
	window_options.frame = {100, 100, 500, 360}
	window_options.hidden = true
	window_options.activate = false

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .native
	webview_options.url = "views://zig/index.html"
	webview_options.frame = {0, 0, 500, 360}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = noopHarnessWebviewCallbacks()
	webview_options.sandbox = true

	_, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		return errName(webview_err)
	}
	return ""
}

runWebviewPageZoomTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"View Zoom Test",
		{240, 240, 420, 320},
		true,
		false,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	target_zoom := 1.1
	if err := electrobun.setWebviewPageZoom(state.core, created.webview_id, target_zoom); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)

	zoom := electrobun.getWebviewPageZoom(state.core, created.webview_id)
	when ODIN_OS == .Darwin || ODIN_OS == .Windows {
		if !approxEq(zoom, target_zoom, 0.02) {
			return "UnexpectedWebviewZoom"
		}
	} else {
		if !approxEq(zoom, 1.0, 0.02) {
			return "UnexpectedWebviewZoom"
		}
	}
	return ""
}

runWebviewTagPlaygroundIntegrationTest :: proc(state: ^AppState) -> string {
	clearChildWebviews()
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions("Webview Tag Playground Integration")
	window_options.frame = {220, 120, 900, 1000}
	window_options.hidden = false
	window_options.activate = true

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer {
		_ = electrobun.closeWindow(state.core, window_id)
		clearChildWebviews()
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .cef
	webview_options.url = "views://playgrounds/webviewtag/index.html"
	webview_options.frame = {0, 0, 900, 1000}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = observedWebviewEvent,
		event_bridge = observedWebviewBridge,
		host_bridge = testRunnerHostBridge,
		internal_bridge = playgroundInternalBridge,
	}
	webview_options.sandbox = false

	_, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		return errName(webview_err)
	}

	deadline_start := time.tick_now()
	for time.tick_since(deadline_start) < 8000 * time.Millisecond {
		if getWebviewDomReadyCount() > 0 && getWebviewTagInitCount() >= 2 {
			sleepMs(medium_wait_ms)
			return ""
		}
		sleepMs(50)
	}

	return "WebviewTagIntegrationTimedOut"
}

runWgpuTagPlaygroundIntegrationTest :: proc(state: ^AppState) -> string {
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions("WGPU Tag Playground Integration")
	window_options.frame = {240, 140, 860, 720}
	window_options.hidden = false
	window_options.activate = true

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .native
	webview_options.url = "views://playgrounds/wgpu-tag/index.html"
	webview_options.frame = {0, 0, 860, 720}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = observedWebviewEvent,
		event_bridge = observedWebviewBridge,
		host_bridge = testRunnerHostBridge,
		internal_bridge = playgroundInternalBridge,
	}
	webview_options.sandbox = false

	_, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		return errName(webview_err)
	}

	deadline_start := time.tick_now()
	for time.tick_since(deadline_start) < 8000 * time.Millisecond {
		if getWebviewDomReadyCount() > 0 && getWgpuTagInitCount() > 0 && getWgpuTagReadyCount() > 0 {
			sleepMs(medium_wait_ms)
			return ""
		}
		sleepMs(50)
	}

	return "WgpuTagIntegrationTimedOut"
}

waitForInteractiveWindowClose :: proc() {
	for getWindowCloseCount() == 0 {
		sleepMs(100)
	}
}

runWebviewTagPlaygroundInteractiveTest :: proc(state: ^AppState) -> string {
	clearChildWebviews()
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions("Webview Tag Playground")
	window_options.frame = {100, 50, 800, 900}
	window_options.hidden = false
	window_options.activate = true
	window_options.callbacks = {
		close = observedWindowClose,
	}

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .cef
	webview_options.url = "views://playgrounds/webviewtag/index.html"
	webview_options.frame = {0, 0, 800, 900}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = observedWebviewEvent,
		event_bridge = observedWebviewBridge,
		host_bridge = testRunnerHostBridge,
		internal_bridge = playgroundInternalBridge,
	}
	webview_options.sandbox = false

	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return errName(webview_err)
	}
	rememberTopLevelWebview(webview_id, window_id)
	defer {
		forgetTopLevelWebview(webview_id)
		clearChildWebviews()
	}

	if err := electrobun.setWindowAlwaysOnTop(state.core, window_id, true); err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return errName(err)
	}
	waitForInteractiveWindowClose()
	return ""
}

runWgpuTagPlaygroundInteractiveTest :: proc(state: ^AppState) -> string {
	resetCallbackState()

	window_options := electrobun.defaultWindowOptions("WGPU Tag Playground")
	window_options.frame = {120, 60, 860, 720}
	window_options.hidden = false
	window_options.activate = true
	window_options.callbacks = {
		close = observedWindowClose,
	}

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .native
	webview_options.url = "views://playgrounds/wgpu-tag/index.html"
	webview_options.frame = {0, 0, 860, 720}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = observedWebviewEvent,
		event_bridge = observedWebviewBridge,
		host_bridge = testRunnerHostBridge,
		internal_bridge = playgroundInternalBridge,
	}
	webview_options.sandbox = false

	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return errName(webview_err)
	}
	rememberTopLevelWebview(webview_id, window_id)
	defer forgetTopLevelWebview(webview_id)

	if err := electrobun.setWindowAlwaysOnTop(state.core, window_id, true); err != .None {
		_ = electrobun.closeWindow(state.core, window_id)
		return errName(err)
	}
	waitForInteractiveWindowClose()
	return ""
}

runNavigationLoadUrlTest :: proc(state: ^AppState) -> string {
	resetCallbackState()
	created, create_err := createWindowWithHarnessCustom(
		state,
		"LoadURL Test",
		{260, 260, 500, 360},
		false,
		true,
		"default",
		{},
		observedHarnessWebviewCallbacks(),
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(medium_wait_ms)
	resetCallbackState()
	if err := electrobun.loadURLInWebview(state.core, created.webview_id, "views://test-runner/index.html"); err != .None {
		return errName(err)
	}
	sleepMs(1500)

	if getWebviewWillNavigateCount() == 0 {
		return "LoadUrlDidNotTriggerWillNavigate"
	}
	return ""
}

runNavigationLoadHtmlTest :: proc(state: ^AppState) -> string {
	resetCallbackState()
	created, create_err := createWindowWithHarnessCustom(
		state,
		"LoadHTML Test",
		{270, 270, 500, 360},
		false,
		true,
		"default",
		{},
		observedHarnessWebviewCallbacks(),
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(medium_wait_ms)
	resetCallbackState()
	if err := electrobun.loadHTMLInWebview(
		state.core,
		created.webview_id,
		"<html><body><h1 id='test-heading'>Custom HTML Content</h1></body></html>",
	); err != .None {
		return errName(err)
	}
	sleepMs(1500)

	if getWebviewWillNavigateCount() == 0 {
		return "LoadHtmlDidNotTriggerWillNavigate"
	}
	return ""
}

runNavigationDomReadyEventTest :: proc(state: ^AppState) -> string {
	resetCallbackState()
	created, create_err := createWindowWithHarnessCustom(
		state,
		"DOM Ready Test",
		{280, 280, 500, 360},
		false,
		true,
		"default",
		{},
		observedHarnessWebviewCallbacks(),
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(800)
	resetCallbackState()
	if err := electrobun.loadURLInWebview(state.core, created.webview_id, "views://test-runner/index.html"); err != .None {
		return errName(err)
	}
	sleepMs(1500)

	if getWebviewDomReadyCount() == 0 {
		return "DomReadyDidNotFire"
	}
	return ""
}

runNavigationDidNavigateEventTest :: proc(state: ^AppState) -> string {
	resetCallbackState()
	created, create_err := createWindowWithHarnessCustom(
		state,
		"Did Navigate Test",
		{290, 290, 500, 360},
		false,
		true,
		"default",
		{},
		observedHarnessWebviewCallbacks(),
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(medium_wait_ms)
	resetCallbackState()
	if err := electrobun.loadURLInWebview(state.core, created.webview_id, "views://test-runner/index.html"); err != .None {
		return errName(err)
	}
	sleepMs(2000)

	if getWebviewDidNavigateCount() == 0 {
		return "DidNavigateDidNotFire"
	}
	if !lastWebviewDetailContains("test-runner") {
		return "DidNavigateMissingExpectedUrl"
	}
	return ""
}

runNavigationExecuteJavascriptTest :: proc(state: ^AppState) -> string {
	created, create_err := createWindowWithTestHarness(
		state,
		"Execute JS Test",
		{300, 300, 500, 360},
		false,
		true,
	)
	if create_err != "" {
		return create_err
	}
	defer electrobun.closeWindow(state.core, created.window_id)

	sleepMs(medium_wait_ms)
	if err := electrobun.evaluateJavaScriptWithNoCompletion(
		state.core,
		created.webview_id,
		"document.body.innerHTML = '<h1>Modified by executeJavascript</h1>';",
	); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)
	return ""
}

runTrayVisibilityToggleAndBoundsTest :: proc(state: ^AppState) -> string {
	tray_options := electrobun.defaultTrayOptions(tray_template_icon_url)
	tray_options.title = "Kitchen Tray API Test"
	tray_options.is_template = true
	tray_options.width = 32
	tray_options.height = 32

	tray_id, tray_err := electrobun.createTray(state.core, tray_options)
	if tray_err != .None {
		return errName(tray_err)
	}
	defer electrobun.removeTray(state.core, tray_id)

	if err := electrobun.hideTray(state.core, tray_id); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)
	if err := electrobun.showTray(state.core, tray_id); err != .None {
		return errName(err)
	}
	sleepMs(short_wait_ms)

	bounds, bounds_err := electrobun.getTrayBounds(state.core, tray_id)
	if bounds_err != .None {
		return errName(bounds_err)
	}
	if bounds.width < 0 || bounds.height < 0 {
		return "InvalidTrayBounds"
	}
	return ""
}

runSessionFromPartitionTest :: proc(state: ^AppState) -> string {
	session := electrobun.sessionFromPartition(state.core, "persist:test-partition")
	if session.partition != "persist:test-partition" {
		return "SessionPartitionMismatch"
	}
	return ""
}

runSessionDefaultSessionTest :: proc(state: ^AppState) -> string {
	session := electrobun.defaultSession(state.core)
	if session.partition != "persist:default" {
		return "DefaultSessionPartitionMismatch"
	}
	return ""
}

runSessionCookiesApiExistsTest :: proc(state: ^AppState) -> string {
	session := electrobun.sessionFromPartition(state.core, "persist:cookie-api-test")
	get_fn: proc(electrobun.SessionPartition, Maybe(electrobun.CookieFilter)) -> ([]electrobun.Cookie, electrobun.Error) = electrobun.getCookies
	set_fn: proc(electrobun.SessionPartition, electrobun.Cookie) -> bool = electrobun.setCookie
	remove_fn: proc(electrobun.SessionPartition, string, string) -> bool = electrobun.removeCookie
	clear_fn: proc(electrobun.SessionPartition) -> electrobun.Error = electrobun.clearCookies
	_ = get_fn
	_ = set_fn
	_ = remove_fn
	_ = clear_fn

	cookies, cookies_err := electrobun.getCookies(session, nil)
	if cookies_err != .None {
		return errName(cookies_err)
	}
	defer delete(cookies, state.core.allocator)
	return ""
}

runApplicationMenuPlaygroundTest :: proc(state: ^AppState) -> string {
	when ODIN_OS == .Linux {
		return ""
	} else {
		created, create_err := openInteractivePlaygroundWindow(
			state,
			"Application Menu Playground",
			"views://playgrounds/application-menu/index.html",
			activePlaygroundRenderer(state),
			{100, 50, 800, 600},
		)
		if create_err != "" {
			return create_err
		}
		defer forgetTopLevelWebview(created.webview_id)

		setApplicationMenuTargetWebview(created.webview_id)
		waitForInteractiveWindowClose()
		return ""
	}
}

runContextMenuPlaygroundTest :: proc(state: ^AppState) -> string {
	when ODIN_OS == .Linux {
		return ""
	} else {
		created, create_err := openInteractivePlaygroundWindow(
			state,
			"Context Menu Playground",
			"views://playgrounds/context-menu/index.html",
			activePlaygroundRenderer(state),
			{150, 80, 800, 600},
		)
		if create_err != "" {
			return create_err
		}
		defer forgetTopLevelWebview(created.webview_id)

		setContextMenuTargetWebview(created.webview_id)
		waitForInteractiveWindowClose()
		return ""
	}
}

runShowMessageBoxInfoDialogTest :: proc(state: ^AppState) -> string {
	buttons := []string{"OK", "Cancel"}
	options := electrobun.defaultMessageBoxOptions()
	options.box_type = "info"
	options.title = "Test Info Dialog"
	options.message = "This is an Odin-mode test info dialog"
	options.detail = "Click any button to pass the test."
	options.buttons = buttons
	options.default_id = 0
	options.cancel_id = 1

	response, response_err := electrobun.showMessageBox(state.core, options)
	if response_err != .None {
		return errName(response_err)
	}
	if response < 0 {
		return "MessageBoxFailed"
	}
	return ""
}

runFileDialogPlaygroundTest :: proc(state: ^AppState) -> string {
	created, create_err := openInteractivePlaygroundWindow(
		state,
		"File Dialog Playground",
		"views://playgrounds/file-dialog/index.html",
		activePlaygroundRenderer(state),
		{200, 50, 600, 850},
	)
	if create_err != "" {
		return create_err
	}
	defer forgetTopLevelWebview(created.webview_id)

	waitForInteractiveWindowClose()
	return ""
}

runGlobalShortcutsPlaygroundTest :: proc(state: ^AppState) -> string {
	if err := electrobun.unregisterAllGlobalShortcuts(state.core); err != .None {
		return errName(err)
	}

	created, create_err := openInteractivePlaygroundWindow(
		state,
		"Global Shortcuts Playground",
		"views://playgrounds/shortcuts/index.html",
		activePlaygroundRenderer(state),
		{200, 50, 550, 750},
	)
	if create_err != "" {
		return create_err
	}
	defer {
		forgetTopLevelWebview(created.webview_id)
		_ = electrobun.unregisterAllGlobalShortcuts(state.core)
	}

	setShortcutTargetWebview(created.webview_id)
	waitForInteractiveWindowClose()
	return ""
}

runGlobalShortcutIsRegisteredApiTest :: proc(state: ^AppState) -> string {
	if err := electrobun.unregisterAllGlobalShortcuts(state.core); err != .None {
		return errName(err)
	}
	defer electrobun.unregisterAllGlobalShortcuts(state.core)

	candidates := []string{
		"Alt+Shift+Super+F11",
		"Alt+Shift+Super+F12",
		"Alt+Shift+Super+Insert",
		"CommandOrControl+Shift+Super+F11",
		"CommandOrControl+Alt+Super+F11",
		"Alt+Shift+Super+Delete",
	}

	registered_accelerator: string
	has_registered := false
	for candidate in candidates {
		if electrobun.registerGlobalShortcut(state.core, candidate) {
			registered_accelerator = candidate
			has_registered = true
			break
		}
	}

	if !has_registered {
		return ""
	}

	if !electrobun.isGlobalShortcutRegistered(state.core, registered_accelerator) {
		return "GlobalShortcutDidNotRegister"
	}

	if !electrobun.unregisterGlobalShortcut(state.core, registered_accelerator) {
		return "GlobalShortcutDidNotUnregister"
	}

	if electrobun.isGlobalShortcutRegistered(state.core, registered_accelerator) {
		return "GlobalShortcutStillRegistered"
	}
	return ""
}

runGlobalShortcutUnregisterAllApiTest :: proc(state: ^AppState) -> string {
	if err := electrobun.unregisterAllGlobalShortcuts(state.core); err != .None {
		return errName(err)
	}
	defer electrobun.unregisterAllGlobalShortcuts(state.core)

	candidates := []string{
		"Alt+Shift+Super+F9",
		"Alt+Shift+Super+F10",
		"Alt+Shift+Super+PageUp",
		"CommandOrControl+Shift+Super+F9",
		"CommandOrControl+Alt+Super+F9",
		"CommandOrControl+Alt+Super+F10",
	}

	registered: [dynamic]string
	defer delete(registered)

	for candidate in candidates {
		if electrobun.registerGlobalShortcut(state.core, candidate) {
			append(&registered, candidate)
			if len(registered) >= 3 {
				break
			}
		}
	}

	if len(registered) == 0 {
		return ""
	}

	if err := electrobun.unregisterAllGlobalShortcuts(state.core); err != .None {
		return errName(err)
	}
	for candidate in registered {
		if electrobun.isGlobalShortcutRegistered(state.core, candidate) {
			return "GlobalShortcutUnregisterAllFailed"
		}
	}
	return ""
}

runLifecycleBeforeQuitCancelTest :: proc(state: ^AppState) -> string {
	_ = state
	resetCallbackState()
	setBeforeQuitShouldCancel(true)
	quitRequestedHandler()

	if getBeforeQuitCount() == 0 {
		return "BeforeQuitDidNotFire"
	}
	return ""
}

runQuitShutdownPlaygroundTest :: proc(state: ^AppState) -> string {
	created, create_err := openInteractivePlaygroundWindow(
		state,
		"Quit/Shutdown Test Playground",
		"views://playgrounds/quit-test/index.html",
		activePlaygroundRenderer(state),
		{200, 50, 600, 700},
	)
	if create_err != "" {
		return create_err
	}
	defer forgetTopLevelWebview(created.webview_id)

	setQuitTargetWebview(created.webview_id)
	setBeforeQuitShouldCancel(true)
	waitForInteractiveWindowClose()
	return ""
}

runWgpuAdapterContextDeviceTest :: proc(state: ^AppState) -> string {
	window_options := electrobun.defaultWindowOptions("WGPU Adapter Context Test")
	window_options.frame = {120, 120, 320, 240}
	window_options.hidden = false
	window_options.activate = true

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		return errName(window_err)
	}
	defer electrobun.closeWindow(state.core, window_id)

	wgpu_view_options := electrobun.defaultWGPUViewOptions(window_id)
	wgpu_view_options.frame = {0, 0, 320, 240}
	wgpu_view_options.auto_resize = true

	wgpu_view_id, wgpu_view_err := electrobun.createWGPUView(state.core, wgpu_view_options)
	if wgpu_view_err != .None {
		return errName(wgpu_view_err)
	}
	defer electrobun.removeWGPUView(state.core, wgpu_view_id)

	sleepMs(short_wait_ms)

	native, native_err := electrobun.wgpuNativeLoad(state.allocator)
	if native_err != .None {
		return errName(native_err)
	}
	defer electrobun.wgpuNativeClose(&native)

	wgpu_context, context_err := electrobun.createForWgpuView(state.core, &native, wgpu_view_id)
	if context_err != .None {
		return errName(context_err)
	}
	if wgpu_context.instance_ptr == nil || wgpu_context.surface_ptr == nil || wgpu_context.device_ptr == nil {
		return "WgpuContextMissingPointers"
	}

	if electrobun.getQueue(wgpu_context, &native) == nil {
		return "WgpuQueueMissing"
	}
	return ""
}

runDockIconVisibilityContractTest :: proc(state: ^AppState) -> string {
	initial_visible := electrobun.isDockIconVisible(state.core)
	defer electrobun.setDockIconVisible(state.core, initial_visible)

	when ODIN_OS == .Darwin {
		if err := electrobun.setDockIconVisible(state.core, false); err != .None {
			return errName(err)
		}
		sleepMs(200)
		if electrobun.isDockIconVisible(state.core) {
			return "DockIconDidNotHide"
		}

		if err := electrobun.setDockIconVisible(state.core, true); err != .None {
			return errName(err)
		}
		sleepMs(200)
		if !electrobun.isDockIconVisible(state.core) {
			return "DockIconDidNotShow"
		}
	} else {
		if err := electrobun.setDockIconVisible(state.core, false); err != .None {
			return errName(err)
		}
		sleepMs(50)
		_ = electrobun.isDockIconVisible(state.core)
	}
	return ""
}

runUtilsClipboardRoundTripTest :: proc(state: ^AppState) -> string {
	test_text := fmt.aprintf("Test clipboard %d", milliTimestamp(), allocator = state.allocator)
	defer delete(test_text, state.allocator)

	if err := electrobun.clipboardWriteText(state.core, test_text); err != .None {
		return errName(err)
	}
	read_text, has_text := electrobun.clipboardReadText(state.core)
	defer if has_text {
		delete(read_text, state.core.allocator)
	}

	if !has_text {
		return "MissingClipboardText"
	}
	if read_text != test_text {
		return "ClipboardRoundTripMismatch"
	}
	return ""
}

runUtilsClipboardAvailableFormatsTest :: proc(state: ^AppState) -> string {
	if err := electrobun.clipboardWriteText(state.core, "test"); err != .None {
		return errName(err)
	}
	formats_csv := electrobun.clipboardAvailableFormatsCsv(state.core)
	defer delete(formats_csv, state.core.allocator)

	if len(formats_csv) == 0 {
		return "EmptyClipboardFormats"
	}
	return ""
}

runUtilsClipboardClearTest :: proc(state: ^AppState) -> string {
	if err := electrobun.clipboardWriteText(state.core, "text to clear"); err != .None {
		return errName(err)
	}
	if err := electrobun.clipboardClear(state.core); err != .None {
		return errName(err)
	}

	text, has_text := electrobun.clipboardReadText(state.core)
	defer if has_text {
		delete(text, state.core.allocator)
	}

	if has_text && len(text) != 0 {
		return "ClipboardDidNotClear"
	}
	return ""
}

runUtilsShowNotificationTest :: proc(state: ^AppState) -> string {
	if err := electrobun.showNotification(state.core, {
		title = "Test Notification",
		body = "This is a test notification from the Odin integration tests",
		subtitle = "Electrobun Odin Tests",
		silent = true,
	}); err != .None {
		return errName(err)
	}
	sleepMs(medium_wait_ms)
	return ""
}

runUtilsOpenExternalExistsTest :: proc() -> string {
	fn_ptr: proc(^electrobun.Core, string) -> bool = electrobun.openExternal
	_ = fn_ptr
	return ""
}

runUtilsOpenPathExistsTest :: proc() -> string {
	fn_ptr: proc(^electrobun.Core, string) -> bool = electrobun.openPath
	_ = fn_ptr
	return ""
}

runUtilsShowItemInFolderExistsTest :: proc() -> string {
	fn_ptr: proc(^electrobun.Core, string) -> electrobun.Error = electrobun.showItemInFolder
	_ = fn_ptr
	return ""
}

runUtilsQuitExistsTest :: proc() -> string {
	fn_ptr: proc(int) -> ! = electrobun.quit
	_ = fn_ptr
	return ""
}

runUtilsPathsObjectExistsTest :: proc(state: ^AppState) -> string {
	paths, paths_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_err != .None {
		return errName(paths_err)
	}
	defer electrobun.pathsDeinit(&paths, state.allocator)

	if len(paths.home) == 0 || len(paths.appData) == 0 || len(paths.userData) == 0 {
		return "PathsObjectMissingExpectedValues"
	}
	return ""
}

runUtilsPathsHomeMatchesTest :: proc(state: ^AppState) -> string {
	paths, paths_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_err != .None {
		return errName(paths_err)
	}
	defer electrobun.pathsDeinit(&paths, state.allocator)

	expected_home, home_found := expectedHomePath(state.allocator)
	if !home_found {
		return "EnvVarNotFound"
	}
	defer delete(expected_home, state.allocator)

	if paths.home != expected_home {
		return "PathsHomeMismatch"
	}
	return ""
}

runUtilsPathsTempMatchesTest :: proc(state: ^AppState) -> string {
	paths, paths_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_err != .None {
		return errName(paths_err)
	}
	defer electrobun.pathsDeinit(&paths, state.allocator)

	expected_temp := expectedTempPath(state.allocator)
	defer delete(expected_temp, state.allocator)

	if paths.temp != expected_temp {
		return "PathsTempMismatch"
	}
	return ""
}

runUtilsPathsOsDirectoriesTest :: proc(state: ^AppState) -> string {
	paths, paths_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_err != .None {
		return errName(paths_err)
	}
	defer electrobun.pathsDeinit(&paths, state.allocator)

	values := []string{
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
	}

	for value in values {
		if len(value) == 0 {
			return "EmptyOsDirectoryPath"
		}
	}
	return ""
}

runUtilsPathsAppScopedDirectoriesTest :: proc(state: ^AppState) -> string {
	paths, paths_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_err != .None {
		return errName(paths_err)
	}
	defer electrobun.pathsDeinit(&paths, state.allocator)

	values := []string{
		paths.userData,
		paths.userCache,
		paths.userLogs,
	}

	for value in values {
		if len(value) == 0 {
			return "EmptyAppScopedPath"
		}
	}

	if len(paths.userData) <= len(paths.appData) ||
	   len(paths.userCache) <= len(paths.cache) ||
	   len(paths.userLogs) <= len(paths.logs) {
		return "AppScopedPathsDidNotExtendBasePaths"
	}
	return ""
}

runUtilsPathsStableAcrossCallsTest :: proc(state: ^AppState) -> string {
	paths_a, paths_a_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_a_err != .None {
		return errName(paths_a_err)
	}
	defer electrobun.pathsDeinit(&paths_a, state.allocator)

	paths_b, paths_b_err := electrobun.resolvePaths(state.allocator, state.app_info)
	if paths_b_err != .None {
		return errName(paths_b_err)
	}
	defer electrobun.pathsDeinit(&paths_b, state.allocator)

	if paths_a.home != paths_b.home ||
	   paths_a.downloads != paths_b.downloads ||
	   paths_a.userData != paths_b.userData {
		return "PathsWereNotStableAcrossCalls"
	}
	return ""
}

runUtilsMoveToTrashTest :: proc(state: ^AppState) -> string {
	test_file := fmt.aprintf("/tmp/electrobun-odin-trash-%d.txt", milliTimestamp(), allocator = state.allocator)
	defer delete(test_file, state.allocator)

	write_err := os.write_entire_file(test_file, "This file will be moved to trash")
	if write_err != nil {
		return "CreateTrashTestFileFailed"
	}

	moved := electrobun.moveToTrash(state.core, test_file)
	if !moved {
		return "MoveToTrashFailed"
	}

	if os.exists(test_file) {
		return "FileStillExistsAfterMoveToTrash"
	}
	return ""
}

runScreenPrimaryDisplayTest :: proc(state: ^AppState) -> string {
	display, display_err := electrobun.getPrimaryDisplay(state.core)
	if display_err != .None {
		return errName(display_err)
	}
	if display.bounds.width <= 0 || display.bounds.height <= 0 {
		return "InvalidPrimaryDisplayBounds"
	}
	if !display.isPrimary {
		return "PrimaryDisplayNotMarkedPrimary"
	}
	return ""
}

runScreenAllDisplaysTest :: proc(state: ^AppState) -> string {
	displays, displays_err := electrobun.getAllDisplays(state.core)
	if displays_err != .None {
		return errName(displays_err)
	}
	defer delete(displays, state.core.allocator)

	if len(displays) == 0 {
		return "NoDisplaysFound"
	}

	primary_count := 0
	for display in displays {
		if display.bounds.width <= 0 || display.bounds.height <= 0 {
			return "InvalidDisplayBounds"
		}
		if display.isPrimary {
			primary_count += 1
		}
	}

	if primary_count != 1 {
		return "UnexpectedPrimaryDisplayCount"
	}
	return ""
}

runScreenCursorScreenPointTest :: proc(state: ^AppState) -> string {
	point, point_err := electrobun.getCursorScreenPoint(state.core)
	if point_err != .None {
		return errName(point_err)
	}
	if math.is_nan(point.x) || math.is_inf(point.x) || math.is_nan(point.y) || math.is_inf(point.y) {
		return "InvalidCursorPoint"
	}
	return ""
}

runScreenBoundsVsWorkAreaTest :: proc(state: ^AppState) -> string {
	display, display_err := electrobun.getPrimaryDisplay(state.core)
	if display_err != .None {
		return errName(display_err)
	}
	if display.workArea.width > display.bounds.width || display.workArea.height > display.bounds.height {
		return "WorkAreaExceedsBounds"
	}
	return ""
}

expectedHomePath :: proc(allocator: runtime.Allocator) -> (string, bool) {
	when ODIN_OS == .Windows {
		if value, found := os.lookup_env("USERPROFILE", allocator); found {
			return value, true
		}
	}
	if value, found := os.lookup_env("HOME", allocator); found {
		return value, true
	}
	return "", false
}

expectedTempPath :: proc(allocator: runtime.Allocator) -> string {
	when ODIN_OS == .Windows {
		if value, found := os.lookup_env("TEMP", allocator); found {
			return value
		}
		if value, found := os.lookup_env("TMP", allocator); found {
			return value
		}
		joined, _ := filepath.join({"C:\\", "Temp"}, allocator)
		return joined
	} else {
		if value, found := os.lookup_env("TMPDIR", allocator); found {
			return value
		}
		cloned, _ := strings.clone("/tmp", allocator)
		return cloned
	}
}

runOdinTest :: proc(odin_test: OdinTest) -> TestResult {
	state := appState()
	started := time.tick_now()

	error_name: string
	switch odin_test.kind {
	case .smoke:
		error_name = runSmokeTest()
	case .window_create_close:
		error_name = runWindowCreateCloseTest(state)
	case .window_creation_with_url:
		error_name = runWindowCreationWithUrlTest(state)
	case .window_hidden_option:
		error_name = runWindowHiddenOptionTest(state)
	case .window_inactive_show_api:
		error_name = runWindowInactiveShowApiTest(state)
	case .window_page_zoom:
		error_name = runWindowPageZoomTest(state)
	case .window_set_title:
		error_name = runWindowSetTitleTest(state)
	case .window_minimize_unminimize:
		error_name = runWindowMinimizeUnminimizeTest(state)
	case .window_fullscreen_toggle:
		error_name = runWindowFullscreenToggleTest(state)
	case .window_fullscreen_toggle_hidden_titlebar:
		error_name = runWindowFullscreenToggleHiddenTitlebarTest(state)
	case .window_set_position:
		error_name = runWindowSetPositionTest(state)
	case .window_set_size:
		error_name = runWindowSetSizeTest(state)
	case .window_set_frame:
		error_name = runWindowSetFrameTest(state)
	case .window_get_frame:
		error_name = runWindowGetFrameTest(state)
	case .window_get_position:
		error_name = runWindowGetPositionTest(state)
	case .window_get_size:
		error_name = runWindowGetSizeTest(state)
	case .window_maximize_unmaximize:
		error_name = runWindowMaximizeUnmaximizeTest(state)
	case .window_always_on_top:
		error_name = runWindowAlwaysOnTopTest(state)
	case .window_visible_on_all_workspaces:
		error_name = runWindowVisibleOnAllWorkspacesTest(state)
	case .window_focus:
		error_name = runWindowFocusTest(state)
	case .window_close_event:
		error_name = runWindowCloseEventTest(state)
	case .window_resize_event:
		error_name = runWindowResizeEventTest(state)
	case .window_get_by_id:
		error_name = runWindowGetByIdTest(state)
	case .window_inset_titlebar_style:
		error_name = runWindowInsetTitlebarStyleTest(state)
	case .window_traffic_light_position_api:
		error_name = runWindowTrafficLightPositionApiTest(state)
	case .webview_create:
		error_name = runWebviewCreateTest(state)
	case .webview_page_zoom:
		error_name = runWebviewPageZoomTest(state)
	case .webview_tag_playground_integration:
		error_name = runWebviewTagPlaygroundIntegrationTest(state)
	case .webview_tag_playground_interactive:
		error_name = runWebviewTagPlaygroundInteractiveTest(state)
	case .wgpu_tag_playground_integration:
		error_name = runWgpuTagPlaygroundIntegrationTest(state)
	case .wgpu_tag_playground_interactive:
		error_name = runWgpuTagPlaygroundInteractiveTest(state)
	case .navigation_load_url:
		error_name = runNavigationLoadUrlTest(state)
	case .navigation_load_html:
		error_name = runNavigationLoadHtmlTest(state)
	case .navigation_dom_ready_event:
		error_name = runNavigationDomReadyEventTest(state)
	case .navigation_did_navigate_event:
		error_name = runNavigationDidNavigateEventTest(state)
	case .navigation_execute_javascript:
		error_name = runNavigationExecuteJavascriptTest(state)
	case .tray_visibility_toggle_and_bounds:
		error_name = runTrayVisibilityToggleAndBoundsTest(state)
	case .session_from_partition:
		error_name = runSessionFromPartitionTest(state)
	case .session_default_session:
		error_name = runSessionDefaultSessionTest(state)
	case .session_cookies_api_exists:
		error_name = runSessionCookiesApiExistsTest(state)
	case .application_menu_playground:
		error_name = runApplicationMenuPlaygroundTest(state)
	case .context_menu_playground:
		error_name = runContextMenuPlaygroundTest(state)
	case .dialog_show_message_box_info:
		error_name = runShowMessageBoxInfoDialogTest(state)
	case .dialog_file_dialog_playground:
		error_name = runFileDialogPlaygroundTest(state)
	case .global_shortcuts_playground:
		error_name = runGlobalShortcutsPlaygroundTest(state)
	case .global_shortcut_is_registered_api:
		error_name = runGlobalShortcutIsRegisteredApiTest(state)
	case .global_shortcut_unregister_all_api:
		error_name = runGlobalShortcutUnregisterAllApiTest(state)
	case .lifecycle_before_quit_cancel:
		error_name = runLifecycleBeforeQuitCancelTest(state)
	case .quit_shutdown_playground:
		error_name = runQuitShutdownPlaygroundTest(state)
	case .wgpu_adapter_context_device:
		error_name = runWgpuAdapterContextDeviceTest(state)
	case .dock_icon_visibility_contract:
		error_name = runDockIconVisibilityContractTest(state)
	case .utils_clipboard_round_trip:
		error_name = runUtilsClipboardRoundTripTest(state)
	case .utils_clipboard_available_formats:
		error_name = runUtilsClipboardAvailableFormatsTest(state)
	case .utils_clipboard_clear:
		error_name = runUtilsClipboardClearTest(state)
	case .utils_show_notification:
		error_name = runUtilsShowNotificationTest(state)
	case .utils_open_external_exists:
		error_name = runUtilsOpenExternalExistsTest()
	case .utils_open_path_exists:
		error_name = runUtilsOpenPathExistsTest()
	case .utils_show_item_in_folder_exists:
		error_name = runUtilsShowItemInFolderExistsTest()
	case .utils_quit_exists:
		error_name = runUtilsQuitExistsTest()
	case .utils_paths_object_exists:
		error_name = runUtilsPathsObjectExistsTest(state)
	case .utils_paths_home_matches:
		error_name = runUtilsPathsHomeMatchesTest(state)
	case .utils_paths_temp_matches:
		error_name = runUtilsPathsTempMatchesTest(state)
	case .utils_paths_os_directories:
		error_name = runUtilsPathsOsDirectoriesTest(state)
	case .utils_paths_app_scoped_directories:
		error_name = runUtilsPathsAppScopedDirectoriesTest(state)
	case .utils_paths_stable_across_calls:
		error_name = runUtilsPathsStableAcrossCallsTest(state)
	case .utils_move_to_trash:
		error_name = runUtilsMoveToTrashTest(state)
	case .screen_primary_display:
		error_name = runScreenPrimaryDisplayTest(state)
	case .screen_all_displays:
		error_name = runScreenAllDisplaysTest(state)
	case .screen_cursor_screen_point:
		error_name = runScreenCursorScreenPointTest(state)
	case .screen_bounds_vs_workarea:
		error_name = runScreenBoundsVsWorkAreaTest(state)
	}

	elapsed_ms := u64(time.duration_milliseconds(time.tick_since(started)))

	if error_name == "" {
		return {
			testId = odin_test.id,
			name = odin_test.name,
			status = "passed",
			duration = elapsed_ms,
		}
	}
	return {
		testId = odin_test.id,
		name = odin_test.name,
		status = "failed",
		duration = elapsed_ms,
		error = error_name,
	}
}

executeSingleTestAndBroadcast :: proc(webview_id: u32, odin_test: OdinTest) -> TestResult {
	fmt.eprintf("[kitchen odin] running test: %s\n", odin_test.name)
	sendRpcMessage(webview_id, "testStarted", TestStartedPayload{
		testId = odin_test.id,
		name = odin_test.name,
	})
	sendTestLog(webview_id, odin_test.id, "Running Odin native test")

	result := runOdinTest(odin_test)
	if message, has_error := result.error.?; has_error {
		sendTestLog(webview_id, odin_test.id, message)
	}

	sendRpcMessage(webview_id, "testCompleted", TestCompletedPayload{
		testId = odin_test.id,
		result = result,
	})
	fmt.eprintf("[kitchen odin] completed test: %s -> %s\n", odin_test.name, result.status)

	return result
}

runSelectedTests :: proc(webview_id: u32, interactive_only: bool) -> [dynamic]TestResult {
	results: [dynamic]TestResult
	for odin_test in odin_tests {
		if odin_test.interactive != interactive_only {
			continue
		}
		append(&results, executeSingleTestAndBroadcast(webview_id, odin_test))
	}
	sendRpcMessage(webview_id, "allCompleted", AllCompletedPayload{results = results[:]})
	return results
}

runSingleTestJob :: proc(job: ^SingleTestJob) {
	defer free(job)

	result := executeSingleTestAndBroadcast(job.webview_id, job.odin_test)
	if request_id, has_request_id := job.request_id.?; has_request_id {
		sendRpcResponseSuccess(job.webview_id, request_id, result)
	}
}

runAllTestsJob :: proc(job: ^AllTestsJob) {
	defer free(job)

	results := runSelectedTests(job.webview_id, job.interactive_only)
	defer delete(results)
	if request_id, has_request_id := job.request_id.?; has_request_id {
		sendRpcResponseSuccess(job.webview_id, request_id, results[:])
	}
}

startSingleTest :: proc(webview_id: u32, request_id: Maybe(u64), odin_test: OdinTest) -> bool {
	job := new(SingleTestJob)
	if job == nil {
		fmt.eprintf("[kitchen odin] failed to allocate single test job\n")
		if rid, has_rid := request_id.?; has_rid {
			sendRpcResponseError(webview_id, rid, "Failed to allocate test job")
		}
		return false
	}
	job^ = {
		webview_id = webview_id,
		request_id = request_id,
		odin_test = odin_test,
	}

	test_thread := thread.create_and_start_with_poly_data(job, runSingleTestJob, nil, .Normal, true)
	if test_thread == nil {
		free(job)
		fmt.eprintf("[kitchen odin] failed to spawn single test thread\n")
		if rid, has_rid := request_id.?; has_rid {
			sendRpcResponseError(webview_id, rid, "Failed to spawn test thread")
		}
		return false
	}
	return true
}

startAllTests :: proc(webview_id: u32, request_id: Maybe(u64), interactive_only: bool) -> bool {
	job := new(AllTestsJob)
	if job == nil {
		fmt.eprintf("[kitchen odin] failed to allocate all-tests job\n")
		if rid, has_rid := request_id.?; has_rid {
			sendRpcResponseError(webview_id, rid, "Failed to allocate all-tests job")
		}
		return false
	}
	job^ = {
		webview_id = webview_id,
		request_id = request_id,
		interactive_only = interactive_only,
	}

	test_thread := thread.create_and_start_with_poly_data(job, runAllTestsJob, nil, .Normal, true)
	if test_thread == nil {
		free(job)
		fmt.eprintf("[kitchen odin] failed to spawn all-tests thread\n")
		if rid, has_rid := request_id.?; has_rid {
			sendRpcResponseError(webview_id, rid, "Failed to spawn all-tests thread")
		}
		return false
	}
	return true
}

maybeAutoRunAfterHandshake :: proc(webview_id: u32) {
	state := appState()
	auto_run_all := false
	auto_run_test: OdinTest
	auto_run_test_found := false
	auto_run_test_name: string
	has_auto_run_test_name := false

	sync.mutex_lock(&state.mutex)
	if state.auto_run_triggered {
		sync.mutex_unlock(&state.mutex)
		return
	}

	if !state.auto_run_all && state.auto_run_test_name == nil {
		sync.mutex_unlock(&state.mutex)
		return
	}

	state.auto_run_triggered = true
	auto_run_all = state.auto_run_all
	if test_name, has_test_name := state.auto_run_test_name.?; has_test_name {
		auto_run_test_name = test_name
		has_auto_run_test_name = true
		auto_run_test, auto_run_test_found = findTestByName(test_name)
	}
	sync.mutex_unlock(&state.mutex)

	if has_auto_run_test_name {
		fmt.eprintf("[kitchen odin] auto-running test: %s\n", auto_run_test_name)
		if auto_run_test_found {
			_ = startSingleTest(webview_id, nil, auto_run_test)
		} else {
			fmt.eprintf("[kitchen odin] failed to find auto-run test: %s\n", auto_run_test_name)
		}
		return
	}

	if auto_run_all {
		fmt.eprintf("[kitchen odin] auto-running all automated tests\n")
		_ = startAllTests(webview_id, nil, false)
	}
}

handleRpcRequest :: proc(webview_id: u32, request_id: u64, method: string, params: json.Value) {
	fmt.eprintf("[kitchen odin] RPC request: %s\n", method)

	if method == "getTests" {
		tests: [len(odin_tests)]TestInfo
		for odin_test, index in odin_tests {
			tests[index] = testToInfo(odin_test)
		}
		sendRpcResponseSuccess(webview_id, request_id, tests[:])
		sendInitialUiState(webview_id)
		maybeAutoRunAfterHandshake(webview_id)
		return
	}

	if method == "getTestRunnerPreferences" {
		sendRpcResponseSuccess(webview_id, request_id, SearchPreferencesPayload{
			searchQuery = getSearchQuery(),
		})
		sendInitialUiState(webview_id)
		return
	}

	if method == "setTestRunnerPreferences" {
		if params_obj, params_is_object := params.(json.Object); params_is_object {
			if query, has_query := getJsonStringField(params_obj, "searchQuery"); has_query {
				setSearchQuery(query)
			}
		}
		sendRpcResponseSuccess(webview_id, request_id, EmptyPayload{})
		return
	}

	if method == "wgpuTagReady" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing wgpuTagReady params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid wgpuTagReady params")
			return
		}

		wgpu_view_id := getJsonU32Field(params_obj, "id", 0)
		if wgpu_view_id == 0 {
			sendRpcResponseError(webview_id, request_id, "Missing WGPU view id")
			return
		}

		if err := electrobun.runWGPUViewTest(appState().core, wgpu_view_id); err != .None {
			sendRpcResponseError(webview_id, request_id, errName(err))
			return
		}

		recordWgpuTagReady()
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = true})
		return
	}

	if method == "wgpuTagToggleShader" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing wgpuTagToggleShader params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid wgpuTagToggleShader params")
			return
		}

		wgpu_view_id := getJsonU32Field(params_obj, "id", 0)
		if wgpu_view_id == 0 {
			sendRpcResponseError(webview_id, request_id, "Missing WGPU view id")
			return
		}

		if err := electrobun.toggleWGPUViewTestShader(appState().core, wgpu_view_id); err != .None {
			sendRpcResponseError(webview_id, request_id, errName(err))
			return
		}

		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = true})
		return
	}

	if method == "closeWindow" {
		window_id, window_found := windowIdForTopLevelWebview(webview_id)
		if !window_found {
			sendRpcResponseError(webview_id, request_id, "No top-level window for requesting webview")
			return
		}

		if err := electrobun.closeWindow(appState().core, window_id); err != .None {
			sendRpcResponseError(webview_id, request_id, errName(err))
			return
		}

		forgetTopLevelWebview(webview_id)
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = true})
		return
	}

	if method == "setApplicationMenu" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing setApplicationMenu params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid setApplicationMenu params")
			return
		}
		menu_value, has_menu := params_obj["menu"]
		if !has_menu {
			sendRpcResponseError(webview_id, request_id, "Missing menu payload")
			return
		}
		menu_json, menu_json_ok := prepareMenuJson(menu_value)
		if !menu_json_ok {
			sendRpcResponseError(webview_id, request_id, "PrepareMenuJsonFailed")
			return
		}
		defer delete(menu_json, appState().allocator)

		setApplicationMenuTargetWebview(webview_id)
		if err := electrobun.setApplicationMenuJson(appState().core, menu_json, applicationMenuHandler); err != .None {
			sendRpcResponseError(webview_id, request_id, errName(err))
			return
		}
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = true})
		return
	}

	if method == "showContextMenu" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing showContextMenu params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid showContextMenu params")
			return
		}
		menu_value, has_menu := params_obj["menu"]
		if !has_menu {
			sendRpcResponseError(webview_id, request_id, "Missing menu payload")
			return
		}
		menu_json, menu_json_ok := prepareMenuJson(menu_value)
		if !menu_json_ok {
			sendRpcResponseError(webview_id, request_id, "PrepareMenuJsonFailed")
			return
		}
		defer delete(menu_json, appState().allocator)

		setContextMenuTargetWebview(webview_id)
		if err := electrobun.showContextMenuJson(appState().core, menu_json, contextMenuHandler); err != .None {
			sendRpcResponseError(webview_id, request_id, errName(err))
			return
		}
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = true})
		return
	}

	if method == "openFileDialog" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing openFileDialog params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid openFileDialog params")
			return
		}

		starting_folder_input, has_starting_folder := getJsonStringField(params_obj, "startingFolder")
		if !has_starting_folder {
			starting_folder_input = "~/"
		}
		starting_folder, expanded := expandTildePathAlloc(appState().allocator, starting_folder_input)
		if !expanded {
			sendRpcResponseError(webview_id, request_id, "EnvVarNotFound")
			return
		}
		defer delete(starting_folder, appState().allocator)

		options := electrobun.defaultOpenFileDialogOptions()
		options.starting_folder = starting_folder
		if allowed_file_types, has_allowed := getJsonStringField(params_obj, "allowedFileTypes"); has_allowed {
			options.allowed_file_types = allowed_file_types
		}
		options.can_choose_files = getJsonBoolField(params_obj, "canChooseFiles", true)
		options.can_choose_directory = getJsonBoolField(params_obj, "canChooseDirectory", true)
		options.allows_multiple_selection = getJsonBoolField(params_obj, "allowsMultipleSelection", true)

		csv := electrobun.openFileDialog(appState().core, options)
		defer delete(csv, appState().core.allocator)

		paths := splitCsvPaths(appState().allocator, csv)
		defer delete(paths, appState().allocator)

		sendRpcResponseSuccess(webview_id, request_id, paths)
		return
	}

	if method == "registerShortcut" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing registerShortcut params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid registerShortcut params")
			return
		}
		accelerator, has_accelerator := getJsonStringField(params_obj, "accelerator")
		if !has_accelerator {
			sendRpcResponseError(webview_id, request_id, "Missing accelerator")
			return
		}

		setShortcutTargetWebview(webview_id)
		success := electrobun.registerGlobalShortcut(appState().core, accelerator)
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = success})
		return
	}

	if method == "unregisterShortcut" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing unregisterShortcut params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid unregisterShortcut params")
			return
		}
		accelerator, has_accelerator := getJsonStringField(params_obj, "accelerator")
		if !has_accelerator {
			sendRpcResponseError(webview_id, request_id, "Missing accelerator")
			return
		}

		success := electrobun.unregisterGlobalShortcut(appState().core, accelerator)
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = success})
		return
	}

	if method == "unregisterAllShortcuts" {
		if err := electrobun.unregisterAllGlobalShortcuts(appState().core); err != .None {
			sendRpcResponseError(webview_id, request_id, errName(err))
			return
		}
		sendRpcResponseSuccess(webview_id, request_id, SuccessPayload{success = true})
		return
	}

	if method == "isRegistered" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing isRegistered params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid isRegistered params")
			return
		}
		accelerator, has_accelerator := getJsonStringField(params_obj, "accelerator")
		if !has_accelerator {
			sendRpcResponseError(webview_id, request_id, "Missing accelerator")
			return
		}

		registered := electrobun.isGlobalShortcutRegistered(appState().core, accelerator)
		sendRpcResponseSuccess(webview_id, request_id, RegisteredPayload{registered = registered})
		return
	}

	if method == "triggerQuit" {
		setQuitTargetWebview(webview_id)
		setBeforeQuitShouldCancel(true)
		quitRequestedHandler()
		sendRpcResponseSuccess(webview_id, request_id, SuccessMessagePayload{
			success = true,
			message = "Quit handled through Odin before-quit callback and cancelled for playground mode.",
		})
		return
	}

	if method == "runTest" {
		if params == nil {
			sendRpcResponseError(webview_id, request_id, "Missing runTest params")
			return
		}
		params_obj, params_is_object := params.(json.Object)
		if !params_is_object {
			sendRpcResponseError(webview_id, request_id, "Invalid runTest params")
			return
		}
		test_id_value, has_test_id := params_obj["testId"]
		if !has_test_id {
			sendRpcResponseError(webview_id, request_id, "Missing testId")
			return
		}
		test_id, test_id_is_string := test_id_value.(json.String)
		if !test_id_is_string {
			sendRpcResponseError(webview_id, request_id, "Invalid testId")
			return
		}

		odin_test, test_found := findTestById(test_id)
		if !test_found {
			sendRpcResponseError(webview_id, request_id, "Unknown test id")
			return
		}

		_ = startSingleTest(webview_id, request_id, odin_test)
		return
	}

	if method == "runAllAutomated" {
		_ = startAllTests(webview_id, request_id, false)
		return
	}

	if method == "runInteractiveTests" {
		_ = startAllTests(webview_id, request_id, true)
		return
	}

	if method == "submitInteractiveResult" ||
	   method == "submitReady" ||
	   method == "submitVerification" ||
	   method == "applyUpdate" ||
	   method == "clearUpdateStatusHistory" {
		sendRpcResponseSuccess(webview_id, request_id, EmptyPayload{})
		return
	}

	if method == "getUpdateStatusHistory" {
		empty_history := []TestResult{}
		sendRpcResponseSuccess(webview_id, request_id, empty_history)
		return
	}

	sendRpcResponseError(webview_id, request_id, "Unknown RPC request")
}

handleRpcMessage :: proc(message_id: string, payload: json.Value) {
	if message_id == "logToBun" {
		if payload_obj, payload_is_object := payload.(json.Object); payload_is_object {
			if msg, has_msg := getJsonStringField(payload_obj, "msg"); has_msg {
				fmt.eprintf("[kitchen odin ui] %s\n", msg)
			}
		}
	}
}

testRunnerWebviewEvent :: proc "c" (webview_id: u32, event_name: cstring, _: cstring) {
	context = runtime.default_context()
	event_name_slice := string(event_name)
	state := appState()

	sync.mutex_lock(&state.mutex)
	is_test_runner := state.test_runner_webview_id == webview_id
	sync.mutex_unlock(&state.mutex)

	if !is_test_runner {
		return
	}

	if event_name_slice == "dom-ready" {
		fmt.eprintf("[kitchen odin] test runner dom-ready\n")
		sendBuildConfig(webview_id)
		sendUpdateStatus(webview_id)
	}
}

testRunnerHostBridge :: proc "c" (webview_id: u32, message: cstring) {
	context = runtime.default_context()
	state := appState()
	message_slice := string(message)
	if len(message_slice) == 0 {
		return
	}

	parsed, parse_err := json.parse_string(message_slice, json.DEFAULT_SPECIFICATION, true, state.allocator)
	if parse_err != .None {
		fmt.eprintf("[kitchen odin] failed to parse RPC packet: %v\n", parse_err)
		return
	}
	defer json.destroy_value(parsed, state.allocator)

	obj, is_object := parsed.(json.Object)
	if !is_object {
		return
	}

	packet_type, has_packet_type := getJsonStringField(obj, "type")
	if !has_packet_type {
		return
	}

	if packet_type == "request" {
		request_id_value, has_request_id := obj["id"]
		if !has_request_id {
			return
		}
		method, has_method := getJsonStringField(obj, "method")
		if !has_method {
			return
		}
		request_id_int, request_id_is_int := request_id_value.(json.Integer)
		if !request_id_is_int {
			return
		}

		params := obj["params"]
		handleRpcRequest(webview_id, u64(request_id_int), method, params)
		return
	}

	if packet_type == "message" {
		message_id, has_message_id := getJsonStringField(obj, "id")
		if !has_message_id {
			return
		}
		payload := obj["payload"]
		handleRpcMessage(message_id, payload)
		return
	}
}

createUi :: proc(ui_context: ^CreateUiContext) {
	time.sleep(150 * time.Millisecond)

	state := ui_context.state

	if err := electrobun.configureWebviewRuntimeFromExecutableDir(state.core, state.bundle_paths, 0); err != .None {
		fmt.eprintf("[kitchen odin] failed to configure webview runtime: %s\n", errName(err))
		return
	}

	window_options := electrobun.defaultWindowOptions("Electrobun Integration Tests")
	window_options.frame = {100, 100, 1200, 800}

	window_id, window_err := electrobun.createWindow(state.core, window_options)
	if window_err != .None {
		fmt.eprintf("[kitchen odin] failed to create test runner window: %s\n", errName(window_err))
		return
	}

	webview_options := electrobun.defaultWebviewOptions(window_id)
	webview_options.renderer = .native
	webview_options.url = "views://test-runner/index.html"
	webview_options.frame = {0, 0, 1200, 800}
	webview_options.secret_key = default_secret_key
	webview_options.callbacks = {
		decide_navigation = electrobun.allowAllNavigation,
		event = testRunnerWebviewEvent,
		event_bridge = electrobun.noopWebviewPostMessage,
		host_bridge = testRunnerHostBridge,
		internal_bridge = electrobun.noopWebviewPostMessage,
	}
	webview_options.sandbox = false

	webview_id, webview_err := electrobun.createWebview(state.core, webview_options)
	if webview_err != .None {
		fmt.eprintf("[kitchen odin] failed to create test runner webview: %s\n", errName(webview_err))
		_ = electrobun.closeWindow(state.core, window_id)
		return
	}

	sync.mutex_lock(&state.mutex)
	state.test_runner_window_id = window_id
	state.test_runner_webview_id = webview_id
	sync.mutex_unlock(&state.mutex)
}

main :: proc() {
	allocator := context.allocator

	core, core_err := electrobun.load(allocator)
	if core_err != .None {
		fmt.eprintf("[kitchen odin] failed to load Electrobun core: %s\n", errName(core_err))
		os.exit(1)
	}
	defer electrobun.close(&core)

	bundle_paths, bundle_paths_err := electrobun.resolveBundlePaths(allocator)
	if bundle_paths_err != .None {
		fmt.eprintf("[kitchen odin] failed to resolve bundle paths: %s\n", errName(bundle_paths_err))
		os.exit(1)
	}
	defer electrobun.bundlePathsDeinit(&bundle_paths, allocator)

	owned_app_info, app_info_err := electrobun.resolveAppInfoFromBundle(allocator, &bundle_paths)
	if app_info_err != .None {
		fmt.eprintf("[kitchen odin] failed to resolve app info: %s\n", errName(app_info_err))
		os.exit(1)
	}
	defer electrobun.ownedAppInfoDeinit(&owned_app_info, allocator)
	app_info := electrobun.borrowed(owned_app_info)

	auto_run_test_name_value, auto_run_test_name_found := os.lookup_env("AUTO_RUN_TEST_NAME", allocator)
	auto_run_all := false
	if auto_run_value, auto_run_found := os.lookup_env("AUTO_RUN", allocator); auto_run_found {
		delete(auto_run_value, allocator)
		auto_run_all = true
	}

	state := AppState {
		allocator = allocator,
		core = &core,
		bundle_paths = &bundle_paths,
		app_info = app_info,
		default_renderer = .native,
		child_webviews = make(map[u32]ChildWebviewState),
		top_level_webview_windows = make(map[u32]u32),
		menu_data_registry = make(map[string]string),
		auto_run_all = auto_run_all,
	}
	if auto_run_test_name_found {
		state.auto_run_test_name = auto_run_test_name_value
	}
	defer appStateDeinit(&state)

	if config_err := configureRuntimeBuildConfig(&state); config_err != "" {
		fmt.eprintf("[kitchen odin] failed to read runtime build config: %s\n", config_err)
		os.exit(1)
	}

	g_state = &state
	defer g_state = nil

	if err := electrobun.setGlobalShortcutCallback(&core, shortcutTriggeredHandler); err != .None {
		fmt.eprintf("[kitchen odin] failed to set global shortcut callback: %s\n", errName(err))
		os.exit(1)
	}
	if err := electrobun.setQuitRequestedHandler(&core, quitRequestedHandler); err != .None {
		fmt.eprintf("[kitchen odin] failed to set quit requested handler: %s\n", errName(err))
		os.exit(1)
	}
	when ODIN_OS == .Darwin {
		if err := electrobun.setAppReopenHandler(&core, appReopenHandler); err != .None {
			fmt.eprintf("[kitchen odin] failed to set app reopen handler: %s\n", errName(err))
			os.exit(1)
		}
		if err := electrobun.setURLOpenHandler(&core, urlOpenHandler); err != .None {
			fmt.eprintf("[kitchen odin] failed to set URL open handler: %s\n", errName(err))
			os.exit(1)
		}
	}

	ui_context := CreateUiContext {
		state = &state,
	}

	ui_thread := thread.create_and_start_with_poly_data(&ui_context, createUi, nil, .Normal, true)
	if ui_thread == nil {
		fmt.eprintf("[kitchen odin] failed to spawn UI thread\n")
		os.exit(1)
	}

	intrinsics.atomic_store_explicit(&host_queue_running, true, .Release)
	host_queue_thread := thread.create_and_start(drainHostMessageQueue)
	if host_queue_thread == nil {
		fmt.eprintf("[kitchen odin] failed to spawn host message queue thread\n")
		os.exit(1)
	}
	defer {
		intrinsics.atomic_store_explicit(&host_queue_running, false, .Release)
		thread.destroy(host_queue_thread)
	}

	if err := electrobun.runMainThread(&core, app_info); err != .None {
		fmt.eprintf("[kitchen odin] main thread exited with error: %s\n", errName(err))
		os.exit(1)
	}
}
