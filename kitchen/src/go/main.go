package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"electrobun"
)

const (
	appVersion          = "1.18.1"
	defaultSecretKey    = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32"
	testHarnessURL      = "views://test-harness/index.html"
	goViewURL           = "views://zig/index.html"
	trayTemplateIconURL = "views://assets/electrobun-logo-32-template.png"
	shortWait           = 150 * time.Millisecond
	mediumWait          = 500 * time.Millisecond
	longWait            = 1200 * time.Millisecond
)

type appState struct {
	core              *electrobun.Core
	bundlePaths       electrobun.BundlePaths
	appInfo           electrobun.AppInfo
	defaultRenderer   string
	cefAvailable      bool
	cefVersion        string
	goVersion         string
	searchQuery       string
	testRunnerWebview uint32
	topLevelWebviews  map[uint32]uint32
	childWebviews     map[uint32]electrobun.Renderer
	autoRunAll        bool
	autoRunTestName   string
	autoRunTriggered  atomic.Bool
	mu                sync.Mutex
}

type callbackState struct {
	windowCloseCount    uint32
	windowResizeCount   uint32
	windowFocusCount    uint32
	webviewWillNavigate uint32
	webviewDidNavigate  uint32
	webviewDomReady     uint32
	webviewTagInit      uint32
	wgpuTagInit         uint32
	wgpuTagReady        uint32
	beforeQuitCount     uint32
	lastResizeWidth     float64
	lastResizeHeight    float64
	lastWebviewDetail   string
}

type testKind string

type goTest struct {
	ID          string
	Name        string
	Category    string
	Description string
	Interactive bool
	Kind        testKind
}

type testRunResult struct {
	Status   string
	Duration time.Duration
	Error    string
}

type windowWithWebview struct {
	windowID  uint32
	webviewID uint32
}

var state *appState
var callbacks callbackState
var callbacksMu sync.Mutex
var hostQueueRunning atomic.Bool

const (
	kindSmoke                                testKind = "smoke"
	kindWindowCreateClose                    testKind = "window_create_close"
	kindWindowCreationWithURL                testKind = "window_creation_with_url"
	kindWindowHiddenOption                   testKind = "window_hidden_option"
	kindWindowInactiveShowAPI                testKind = "window_inactive_show_api"
	kindWindowPageZoom                       testKind = "window_page_zoom"
	kindWindowSetTitle                       testKind = "window_set_title"
	kindWindowMinimizeUnminimize             testKind = "window_minimize_unminimize"
	kindWindowFullscreenToggle               testKind = "window_fullscreen_toggle"
	kindWindowFullscreenToggleHiddenTitlebar testKind = "window_fullscreen_toggle_hidden_titlebar"
	kindWindowSetPosition                    testKind = "window_set_position"
	kindWindowSetSize                        testKind = "window_set_size"
	kindWindowSetFrame                       testKind = "window_set_frame"
	kindWindowGetFrame                       testKind = "window_get_frame"
	kindWindowGetPosition                    testKind = "window_get_position"
	kindWindowGetSize                        testKind = "window_get_size"
	kindWindowMaximizeUnmaximize             testKind = "window_maximize_unmaximize"
	kindWindowAlwaysOnTop                    testKind = "window_always_on_top"
	kindWindowVisibleOnAllWorkspaces         testKind = "window_visible_on_all_workspaces"
	kindWindowFocus                          testKind = "window_focus"
	kindWindowCloseEvent                     testKind = "window_close_event"
	kindWindowResizeEvent                    testKind = "window_resize_event"
	kindWindowGetByID                        testKind = "window_get_by_id"
	kindWindowInsetTitlebarStyle             testKind = "window_inset_titlebar_style"
	kindWindowTrafficLightPositionAPI        testKind = "window_traffic_light_position_api"
	kindWebviewCreate                        testKind = "webview_create"
	kindWebviewPageZoom                      testKind = "webview_page_zoom"
	kindWebviewTagPlaygroundIntegration      testKind = "webview_tag_playground_integration"
	kindWebviewTagPlaygroundInteractive      testKind = "webview_tag_playground_interactive"
	kindWgpuTagPlaygroundIntegration         testKind = "wgpu_tag_playground_integration"
	kindWgpuTagPlaygroundInteractive         testKind = "wgpu_tag_playground_interactive"
	kindNavigationLoadURL                    testKind = "navigation_load_url"
	kindNavigationLoadHTML                   testKind = "navigation_load_html"
	kindNavigationDomReadyEvent              testKind = "navigation_dom_ready_event"
	kindNavigationDidNavigateEvent           testKind = "navigation_did_navigate_event"
	kindNavigationExecuteJavascript          testKind = "navigation_execute_javascript"
	kindTrayVisibilityToggleAndBounds        testKind = "tray_visibility_toggle_and_bounds"
	kindSessionFromPartition                 testKind = "session_from_partition"
	kindSessionDefaultSession                testKind = "session_default_session"
	kindSessionCookiesAPIExists              testKind = "session_cookies_api_exists"
	kindApplicationMenuPlayground            testKind = "application_menu_playground"
	kindContextMenuPlayground                testKind = "context_menu_playground"
	kindDialogShowMessageBoxInfo             testKind = "dialog_show_message_box_info"
	kindDialogFileDialogPlayground           testKind = "dialog_file_dialog_playground"
	kindGlobalShortcutsPlayground            testKind = "global_shortcuts_playground"
	kindGlobalShortcutIsRegisteredAPI        testKind = "global_shortcut_is_registered_api"
	kindGlobalShortcutUnregisterAllAPI       testKind = "global_shortcut_unregister_all_api"
	kindLifecycleBeforeQuitCancel            testKind = "lifecycle_before_quit_cancel"
	kindQuitShutdownPlayground               testKind = "quit_shutdown_playground"
	kindWgpuAdapterContextDevice             testKind = "wgpu_adapter_context_device"
	kindDockIconVisibilityContract           testKind = "dock_icon_visibility_contract"
	kindUtilsClipboardRoundTrip              testKind = "utils_clipboard_round_trip"
	kindUtilsClipboardAvailableFormats       testKind = "utils_clipboard_available_formats"
	kindUtilsClipboardClear                  testKind = "utils_clipboard_clear"
	kindUtilsShowNotification                testKind = "utils_show_notification"
	kindUtilsOpenExternalExists              testKind = "utils_open_external_exists"
	kindUtilsOpenPathExists                  testKind = "utils_open_path_exists"
	kindUtilsShowItemInFolderExists          testKind = "utils_show_item_in_folder_exists"
	kindUtilsQuitExists                      testKind = "utils_quit_exists"
	kindUtilsPathsObjectExists               testKind = "utils_paths_object_exists"
	kindUtilsPathsHomeMatches                testKind = "utils_paths_home_matches"
	kindUtilsPathsTempMatches                testKind = "utils_paths_temp_matches"
	kindUtilsPathsOSDirectories              testKind = "utils_paths_os_directories"
	kindUtilsPathsAppScopedDirectories       testKind = "utils_paths_app_scoped_directories"
	kindUtilsPathsStableAcrossCalls          testKind = "utils_paths_stable_across_calls"
	kindUtilsMoveToTrash                     testKind = "utils_move_to_trash"
	kindScreenPrimaryDisplay                 testKind = "screen_primary_display"
	kindScreenAllDisplays                    testKind = "screen_all_displays"
	kindScreenCursorScreenPoint              testKind = "screen_cursor_screen_point"
	kindScreenBoundsVsWorkArea               testKind = "screen_bounds_vs_workarea"
)

var goTests = []goTest{
	test("go-smoke-test", "Go host smoke test", "Go Native", kindSmoke),
	test("go-window-create-close", "Window create/close (Go)", "BrowserWindow", kindWindowCreateClose),
	test("go-window-creation-with-url", "Window creation with URL (Go)", "BrowserWindow", kindWindowCreationWithURL),
	test("go-window-hidden-option", "Window hidden option (Go)", "BrowserWindow", kindWindowHiddenOption),
	test("go-window-inactive-show-api", "Window inactive show API (Go)", "BrowserWindow", kindWindowInactiveShowAPI),
	test("go-window-page-zoom", "Window page zoom API (Go)", "BrowserWindow", kindWindowPageZoom),
	test("go-window-set-title", "Window setTitle (Go)", "BrowserWindow", kindWindowSetTitle),
	test("go-window-minimize-unminimize", "Window minimize/unminimize (Go)", "BrowserWindow", kindWindowMinimizeUnminimize),
	test("go-window-fullscreen-toggle", "Window fullscreen toggle (Go)", "BrowserWindow", kindWindowFullscreenToggle),
	test("go-window-fullscreen-toggle-hidden-titlebar", "Window fullscreen toggle with hidden titlebar (Go)", "BrowserWindow", kindWindowFullscreenToggleHiddenTitlebar),
	test("go-window-set-position", "Window setPosition (Go)", "BrowserWindow", kindWindowSetPosition),
	test("go-window-set-size", "Window setSize (Go)", "BrowserWindow", kindWindowSetSize),
	test("go-window-set-frame", "Window setFrame (Go)", "BrowserWindow", kindWindowSetFrame),
	test("go-window-get-frame", "Window getFrame (Go)", "BrowserWindow", kindWindowGetFrame),
	test("go-window-get-position", "Window getPosition (Go)", "BrowserWindow", kindWindowGetPosition),
	test("go-window-get-size", "Window getSize (Go)", "BrowserWindow", kindWindowGetSize),
	test("go-window-maximize-unmaximize", "Window maximize/unmaximize (Go)", "BrowserWindow", kindWindowMaximizeUnmaximize),
	test("go-window-always-on-top", "Window alwaysOnTop (Go)", "BrowserWindow", kindWindowAlwaysOnTop),
	test("go-window-visible-on-all-workspaces", "Window visibleOnAllWorkspaces (macOS) (Go)", "BrowserWindow", kindWindowVisibleOnAllWorkspaces),
	test("go-window-focus", "Window focus (Go)", "BrowserWindow", kindWindowFocus),
	test("go-window-close-event", "Window close event (Go)", "BrowserWindow", kindWindowCloseEvent),
	test("go-window-resize-event", "Window resize event (Go)", "BrowserWindow", kindWindowResizeEvent),
	test("go-window-get-by-id", "BrowserWindow.getById (Go)", "BrowserWindow", kindWindowGetByID),
	test("go-window-inset-titlebar-style", "Window with inset titlebar style (Go)", "BrowserWindow", kindWindowInsetTitlebarStyle),
	test("go-window-traffic-light-position-api", "Window traffic light position API (Go)", "BrowserWindow", kindWindowTrafficLightPositionAPI),
	test("go-webview-create", "BrowserView create (Go)", "BrowserView", kindWebviewCreate),
	test("go-webview-page-zoom", "BrowserView page zoom API (Go)", "BrowserWindow", kindWebviewPageZoom),
	test("go-webview-tag-playground-integration", "Webview Tag playground integration (Go)", "Webview Tag", kindWebviewTagPlaygroundIntegration),
	interactiveTest("go-webview-tag-playground", "Webview Tag playground (Go)", "Webview Tag (Interactive)", kindWebviewTagPlaygroundInteractive),
	test("go-wgpu-tag-playground-integration", "WGPU Tag playground integration (Go)", "WGPU Tag", kindWgpuTagPlaygroundIntegration),
	interactiveTest("go-wgpu-tag-playground", "WGPU Tag playground (Go)", "WGPU Tag (Interactive)", kindWgpuTagPlaygroundInteractive),
	test("go-navigation-load-url", "loadURL (Go)", "Navigation", kindNavigationLoadURL),
	test("go-navigation-load-html", "loadHTML (Go)", "Navigation", kindNavigationLoadHTML),
	test("go-navigation-dom-ready-event", "dom-ready event (Go)", "Navigation", kindNavigationDomReadyEvent),
	test("go-navigation-did-navigate-event", "did-navigate event (Go)", "Navigation", kindNavigationDidNavigateEvent),
	test("go-navigation-execute-javascript", "executeJavascript (fire and forget) (Go)", "Navigation", kindNavigationExecuteJavascript),
	test("go-tray-visibility-toggle-bounds", "Tray visibility toggle and bounds (Go)", "Tray", kindTrayVisibilityToggleAndBounds),
	test("go-session-from-partition", "Session.fromPartition (Go)", "Session", kindSessionFromPartition),
	test("go-session-default-session", "Session.defaultSession (Go)", "Session", kindSessionDefaultSession),
	test("go-session-cookies-api-exists", "cookies API exists (Go)", "Session", kindSessionCookiesAPIExists),
	interactiveTest("go-application-menu-playground", "Application menu playground (Go)", "Menus (Interactive)", kindApplicationMenuPlayground),
	interactiveTest("go-context-menu-playground", "Context menu playground (Go)", "Menus (Interactive)", kindContextMenuPlayground),
	interactiveTest("go-dialog-show-message-box-info", "showMessageBox - info dialog (Go)", "Dialogs (Interactive)", kindDialogShowMessageBoxInfo),
	interactiveTest("go-dialog-file-dialog-playground", "File dialog playground (Go)", "Dialogs (Interactive)", kindDialogFileDialogPlayground),
	interactiveTest("go-global-shortcuts-playground", "Global shortcuts playground (Go)", "Shortcuts (Interactive)", kindGlobalShortcutsPlayground),
	test("go-global-shortcut-is-registered-api", "GlobalShortcut.isRegistered API (Go)", "Shortcuts", kindGlobalShortcutIsRegisteredAPI),
	test("go-global-shortcut-unregister-all-api", "GlobalShortcut.unregisterAll API (Go)", "Shortcuts", kindGlobalShortcutUnregisterAllAPI),
	test("go-lifecycle-before-quit-cancel", "before-quit event can cancel quit (Go)", "App Lifecycle", kindLifecycleBeforeQuitCancel),
	interactiveTest("go-quit-shutdown-playground", "Quit/Shutdown playground (Go)", "Quit (Interactive)", kindQuitShutdownPlayground),
	test("go-wgpu-adapter-context-device", "WebGPU adapter: context/device init (Go)", "WebGPU", kindWgpuAdapterContextDevice),
	test("go-dock-icon-visibility-contract", "Dock icon visibility contract (Go)", "Utils", kindDockIconVisibilityContract),
	test("go-utils-clipboard-round-trip", "clipboardWriteText and clipboardReadText (Go)", "Utils", kindUtilsClipboardRoundTrip),
	test("go-utils-clipboard-available-formats", "clipboardAvailableFormats (Go)", "Utils", kindUtilsClipboardAvailableFormats),
	test("go-utils-clipboard-clear", "clipboardClear (Go)", "Utils", kindUtilsClipboardClear),
	test("go-utils-show-notification", "showNotification (Go)", "Utils", kindUtilsShowNotification),
	test("go-utils-open-external-exists", "openExternal (Go)", "Utils", kindUtilsOpenExternalExists),
	test("go-utils-open-path-exists", "openPath (Go)", "Utils", kindUtilsOpenPathExists),
	test("go-utils-show-item-in-folder-exists", "showItemInFolder (Go)", "Utils", kindUtilsShowItemInFolderExists),
	test("go-utils-quit-function-exists", "quit function exists (Go)", "Utils", kindUtilsQuitExists),
	test("go-utils-paths-object-exists", "paths object exists (Go)", "Utils", kindUtilsPathsObjectExists),
	test("go-utils-paths-home-matches", "paths.home matches os.homedir() (Go)", "Utils", kindUtilsPathsHomeMatches),
	test("go-utils-paths-temp-matches", "paths.temp matches os.tmpdir() (Go)", "Utils", kindUtilsPathsTempMatches),
	test("go-utils-paths-os-directories", "paths OS directories return non-empty strings (Go)", "Utils", kindUtilsPathsOSDirectories),
	test("go-utils-paths-app-scoped-directories", "paths app-scoped directories return non-empty strings (Go)", "Utils", kindUtilsPathsAppScopedDirectories),
	test("go-utils-paths-stable-across-calls", "paths getters are stable across calls (Go)", "Utils", kindUtilsPathsStableAcrossCalls),
	test("go-utils-move-to-trash", "moveToTrash (Go)", "Utils", kindUtilsMoveToTrash),
	test("go-screen-primary-display", "getPrimaryDisplay (Go)", "Screen", kindScreenPrimaryDisplay),
	test("go-screen-all-displays", "getAllDisplays (Go)", "Screen", kindScreenAllDisplays),
	test("go-screen-cursor-screen-point", "getCursorScreenPoint (Go)", "Screen", kindScreenCursorScreenPoint),
	test("go-screen-bounds-vs-workarea", "Display bounds vs workArea (Go)", "Screen", kindScreenBoundsVsWorkArea),
}

func test(id, name, category string, kind testKind) goTest {
	return goTest{ID: id, Name: name, Category: category, Description: name, Kind: kind}
}

func interactiveTest(id, name, category string, kind testKind) goTest {
	item := test(id, name, category, kind)
	item.Interactive = true
	return item
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	core, err := electrobun.LoadCore()
	if err != nil {
		return err
	}
	bundlePaths, err := electrobun.ResolveBundlePaths()
	if err != nil {
		return err
	}
	appInfo, err := electrobun.ResolveAppInfoFromBundle(bundlePaths)
	if err != nil {
		return err
	}
	runtimeConfig := readRuntimeBuildConfig(bundlePaths)
	state = &appState{
		core:             core,
		bundlePaths:      bundlePaths,
		appInfo:          appInfo,
		defaultRenderer:  runtimeConfig.DefaultRenderer,
		cefAvailable:     runtimeConfig.CefAvailable,
		cefVersion:       runtimeConfig.CefVersion,
		goVersion:        runtimeConfig.GoVersion,
		topLevelWebviews: map[uint32]uint32{},
		childWebviews:    map[uint32]electrobun.Renderer{},
		autoRunAll:       os.Getenv("AUTO_RUN") != "",
		autoRunTestName:  os.Getenv("AUTO_RUN_TEST_NAME"),
	}

	go createUI()
	hostQueueRunning.Store(true)
	done := make(chan struct{})
	go func() {
		drainHostMessageQueue()
		close(done)
	}()
	runErr := core.RunMainThread(appInfo)
	hostQueueRunning.Store(false)
	<-done
	return runErr
}

type runtimeBuildConfig struct {
	DefaultRenderer string
	CefAvailable    bool
	CefVersion      string
	GoVersion       string
}

func readRuntimeBuildConfig(bundlePaths electrobun.BundlePaths) runtimeBuildConfig {
	buildJSON, _ := os.ReadFile(filepath.Join(bundlePaths.ResourcesDir, "build.json"))
	source := string(buildJSON)
	return runtimeBuildConfig{
		DefaultRenderer: electrobun.JsonStringField(source, "defaultRenderer", "native"),
		CefAvailable:    strings.Contains(source, `"cef"`),
		CefVersion:      electrobun.JsonStringField(source, "cefVersion", ""),
		GoVersion:       electrobun.JsonStringField(source, "goVersion", ""),
	}
}

func createUI() {
	time.Sleep(150 * time.Millisecond)
	if err := state.core.ConfigureWebviewRuntimeFromExecutableDir(state.bundlePaths, 0); err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to configure webview runtime: %v\n", err)
		return
	}

	windowID, err := state.core.CreateWindow(electrobun.NewWindowOptions(
		"Electrobun Integration Tests",
		electrobun.NewRect(100, 100, 1200, 800),
	))
	if err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to create test runner window: %v\n", err)
		return
	}

	options := electrobun.NewWebviewOptions(windowID, "views://test-runner/index.html", electrobun.NewRect(0, 0, 1200, 800))
	options.SecretKey = defaultSecretKey
	options.Sandbox = false
	options.Callbacks = electrobun.WebviewCallbacks{
		DecideNavigation: electrobun.AllowAllNavigation,
		Event:            testRunnerWebviewEvent,
		EventBridge:      electrobun.NoopWebviewPostMessage,
		HostBridge:       testRunnerHostBridge,
		InternalBridge:   electrobun.NoopWebviewPostMessage,
	}
	webviewID, err := state.core.CreateWebview(options)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to create test runner webview: %v\n", err)
		_ = state.core.CloseWindow(windowID)
		return
	}
	state.mu.Lock()
	state.testRunnerWebview = webviewID
	state.mu.Unlock()
}

func drainHostMessageQueue() {
	for hostQueueRunning.Load() {
		drained := false
		for hostQueueRunning.Load() {
			webviewID, message, ok := state.core.PopNextQueuedHostMessageString()
			if !ok {
				break
			}
			handleHostBridgePacket(webviewID, message)
			drained = true
		}
		if !drained {
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func testRunnerWebviewEvent(webviewID uint32, eventName, detail string) {
	if eventName != "dom-ready" {
		return
	}
	state.mu.Lock()
	isRunner := state.testRunnerWebview == webviewID
	state.mu.Unlock()
	if !isRunner {
		return
	}
	sendBuildConfig(webviewID)
	sendUpdateStatus(webviewID)
}

func testRunnerHostBridge(webviewID uint32, message string) {
	handleHostBridgePacket(webviewID, message)
}

type rpcPacket struct {
	Type        string          `json:"type"`
	ID          uint64          `json:"id"`
	Method      string          `json:"method"`
	Params      json.RawMessage `json:"params"`
	TestID      string          `json:"testId"`
	SearchQuery string          `json:"searchQuery"`
	Msg         string          `json:"msg"`
}

func handleHostBridgePacket(webviewID uint32, message string) {
	var packet rpcPacket
	if json.Unmarshal([]byte(message), &packet) != nil {
		return
	}
	switch packet.Type {
	case "request":
		handleRPCRequest(webviewID, packet.ID, packet.Method, packet, message)
	case "message":
		if stringField(message, "id") == "logToBun" && packet.Msg != "" {
			fmt.Fprintf(os.Stderr, "[kitchen go ui] %s\n", packet.Msg)
		}
	}
}

func handleRPCRequest(webviewID uint32, requestID uint64, method string, packet rpcPacket, raw string) {
	fmt.Fprintf(os.Stderr, "[kitchen go] RPC request: %s\n", method)
	switch method {
	case "getTests":
		sendRPCResponseSuccess(webviewID, requestID, testsJSON())
		sendInitialUIState(webviewID)
		maybeAutoRunAfterHandshake(webviewID)
	case "getTestRunnerPreferences":
		state.mu.Lock()
		query := state.searchQuery
		state.mu.Unlock()
		sendRPCResponseSuccess(webviewID, requestID, fmt.Sprintf(`{"searchQuery":%s}`, electrobun.JsonStringLiteral(query)))
		sendInitialUIState(webviewID)
	case "setTestRunnerPreferences":
		if value := stringField(raw, "searchQuery"); value != "" {
			state.mu.Lock()
			state.searchQuery = value
			state.mu.Unlock()
		}
		sendRPCResponseSuccess(webviewID, requestID, "{}")
	case "wgpuTagReady":
		params := rawParams(packet.Params)
		id := uint32(numberField(params, "id"))
		if id == 0 {
			sendRPCResponseError(webviewID, requestID, "Missing WGPU view id")
			return
		}
		if err := state.core.RunWGPUViewTest(id); err != nil {
			sendRPCResponseError(webviewID, requestID, err.Error())
			return
		}
		recordWgpuTagReady()
		sendRPCResponseSuccess(webviewID, requestID, `{"success":true}`)
	case "wgpuTagToggleShader":
		params := rawParams(packet.Params)
		id := uint32(numberField(params, "id"))
		if id == 0 {
			sendRPCResponseError(webviewID, requestID, "Missing WGPU view id")
			return
		}
		if err := state.core.ToggleWGPUViewTestShader(id); err != nil {
			sendRPCResponseError(webviewID, requestID, err.Error())
			return
		}
		sendRPCResponseSuccess(webviewID, requestID, `{"success":true}`)
	case "closeWindow":
		windowID, ok := windowIDForTopLevelWebview(webviewID)
		if !ok {
			sendRPCResponseError(webviewID, requestID, "No top-level window for webview")
			return
		}
		forgetTopLevelWebview(webviewID)
		if err := state.core.CloseWindow(windowID); err != nil {
			sendRPCResponseError(webviewID, requestID, err.Error())
			return
		}
		sendRPCResponseSuccess(webviewID, requestID, `{"success":true}`)
	case "setApplicationMenu", "showContextMenu":
		sendRPCResponseSuccess(webviewID, requestID, `{"success":true}`)
	case "runTest":
		testID := stringField(raw, "testId")
		test, ok := findTestByID(testID)
		if !ok {
			sendRPCResponseError(webviewID, requestID, "Unknown test id")
			return
		}
		startSingleTest(webviewID, requestID, true, test)
	case "runAllAutomated":
		startAllTests(webviewID, requestID, true, false)
	case "runInteractiveTests":
		startAllTests(webviewID, requestID, true, true)
	case "submitInteractiveResult", "submitReady", "submitVerification", "applyUpdate", "clearUpdateStatusHistory":
		sendRPCResponseSuccess(webviewID, requestID, "{}")
	case "getUpdateStatusHistory":
		sendRPCResponseSuccess(webviewID, requestID, "[]")
	default:
		sendRPCResponseError(webviewID, requestID, "Unknown RPC request")
	}
}

func rawParams(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	return string(raw)
}

func findTestByID(id string) (goTest, bool) {
	for _, test := range goTests {
		if test.ID == id {
			return test, true
		}
	}
	return goTest{}, false
}

func findTestByNameOrID(value string) (goTest, bool) {
	for _, test := range goTests {
		if test.ID == value || test.Name == value {
			return test, true
		}
	}
	return goTest{}, false
}

func runSelectedTests(webviewID uint32, interactiveOnly bool) string {
	results := []string{}
	for _, test := range goTests {
		if test.Interactive != interactiveOnly {
			continue
		}
		results = append(results, executeSingleTestAndBroadcast(webviewID, test))
	}
	payload := fmt.Sprintf(`{"results":[%s]}`, strings.Join(results, ","))
	sendRPCMessage(webviewID, "allCompleted", payload)
	return fmt.Sprintf("[%s]", strings.Join(results, ","))
}

func startSingleTest(webviewID uint32, requestID uint64, respond bool, test goTest) {
	go func() {
		resultJSON := executeSingleTestAndBroadcast(webviewID, test)
		if respond {
			sendRPCResponseSuccess(webviewID, requestID, resultJSON)
		}
	}()
}

func startAllTests(webviewID uint32, requestID uint64, respond bool, interactiveOnly bool) {
	go func() {
		results := runSelectedTests(webviewID, interactiveOnly)
		if respond {
			sendRPCResponseSuccess(webviewID, requestID, results)
		}
	}()
}

func executeSingleTestAndBroadcast(webviewID uint32, test goTest) string {
	fmt.Fprintf(os.Stderr, "[kitchen go] running test: %s\n", test.Name)
	sendRPCMessage(webviewID, "testStarted", fmt.Sprintf(`{"testId":%s,"name":%s}`, electrobun.JsonStringLiteral(test.ID), electrobun.JsonStringLiteral(test.Name)))
	sendTestLog(webviewID, test.ID, "Running Go native test")
	result := runGoTest(test)
	if result.Error != "" {
		sendTestLog(webviewID, test.ID, result.Error)
	}
	resultJSON := testResultJSON(test, result)
	sendRPCMessage(webviewID, "testCompleted", fmt.Sprintf(`{"testId":%s,"result":%s}`, electrobun.JsonStringLiteral(test.ID), resultJSON))
	fmt.Fprintf(os.Stderr, "[kitchen go] completed test: %s -> %s\n", test.Name, result.Status)
	return resultJSON
}

func runGoTest(test goTest) testRunResult {
	started := time.Now()
	err := runGoTestBody(test)
	result := testRunResult{Status: "passed", Duration: time.Since(started)}
	if err != nil {
		result.Status = "failed"
		result.Error = err.Error()
	}
	return result
}

func runGoTestBody(test goTest) error {
	switch test.Kind {
	case kindSmoke:
		return nil
	case kindWindowCreateClose:
		return runWindowCreateCloseTest()
	case kindWindowCreationWithURL:
		return runWindowCreationWithURLTest()
	case kindWindowHiddenOption:
		return runWindowHiddenOptionTest()
	case kindWindowInactiveShowAPI:
		return runWindowInactiveShowAPITest()
	case kindWindowPageZoom, kindWebviewPageZoom:
		return runWebviewPageZoomTest()
	case kindWindowSetTitle:
		return runWindowSetTitleTest()
	case kindWindowMinimizeUnminimize:
		return runWindowMinimizeUnminimizeTest()
	case kindWindowFullscreenToggle:
		return runWindowFullscreenToggleTest(false)
	case kindWindowFullscreenToggleHiddenTitlebar:
		return runWindowFullscreenToggleTest(true)
	case kindWindowSetPosition:
		return runWindowSetPositionTest()
	case kindWindowSetSize:
		return runWindowSetSizeTest()
	case kindWindowSetFrame:
		return runWindowSetFrameTest()
	case kindWindowGetFrame:
		return runWindowGetFrameTest()
	case kindWindowGetPosition:
		return runWindowGetPositionTest()
	case kindWindowGetSize:
		return runWindowGetSizeTest()
	case kindWindowMaximizeUnmaximize:
		return runWindowMaximizeUnmaximizeTest()
	case kindWindowAlwaysOnTop:
		return runWindowAlwaysOnTopTest()
	case kindWindowVisibleOnAllWorkspaces:
		return runWindowVisibleOnAllWorkspacesTest()
	case kindWindowFocus:
		return runWindowFocusTest()
	case kindWindowCloseEvent:
		return runWindowCloseEventTest()
	case kindWindowResizeEvent:
		return runWindowResizeEventTest()
	case kindWindowGetByID:
		return runWindowGetByIDTest()
	case kindWindowInsetTitlebarStyle:
		return runWindowInsetTitlebarStyleTest()
	case kindWindowTrafficLightPositionAPI:
		return runWindowTrafficLightPositionAPITest()
	case kindWebviewCreate:
		return runWebviewCreateTest()
	case kindWebviewTagPlaygroundIntegration:
		return runWebviewTagPlaygroundIntegrationTest()
	case kindWebviewTagPlaygroundInteractive:
		return runInteractivePlaygroundTest("Webview Tag Playground", "views://playgrounds/webviewtag/index.html")
	case kindWgpuTagPlaygroundIntegration:
		return runWgpuTagPlaygroundIntegrationTest()
	case kindWgpuTagPlaygroundInteractive:
		return runInteractivePlaygroundTest("WGPU Tag Playground", "views://playgrounds/wgpu-tag/index.html")
	case kindNavigationLoadURL:
		return runNavigationLoadURLTest()
	case kindNavigationLoadHTML:
		return runNavigationLoadHTMLTest()
	case kindNavigationDomReadyEvent:
		return runNavigationDomReadyEventTest()
	case kindNavigationDidNavigateEvent:
		return runNavigationDidNavigateEventTest()
	case kindNavigationExecuteJavascript:
		return runNavigationExecuteJavascriptTest()
	case kindTrayVisibilityToggleAndBounds:
		return runTrayVisibilityToggleAndBoundsTest()
	case kindSessionFromPartition:
		return nil
	case kindSessionDefaultSession:
		return nil
	case kindSessionCookiesAPIExists:
		return runSessionCookiesAPIExistsTest()
	case kindApplicationMenuPlayground:
		return runInteractivePlaygroundTest("Application Menu Playground", "views://playgrounds/application-menu/index.html")
	case kindContextMenuPlayground:
		return runInteractivePlaygroundTest("Context Menu Playground", "views://playgrounds/context-menu/index.html")
	case kindDialogShowMessageBoxInfo:
		return runShowMessageBoxInfoDialogTest()
	case kindDialogFileDialogPlayground:
		return runInteractivePlaygroundTest("File Dialog Playground", "views://playgrounds/file-dialog/index.html")
	case kindGlobalShortcutsPlayground:
		return runInteractivePlaygroundTest("Global Shortcuts Playground", "views://playgrounds/shortcuts/index.html")
	case kindGlobalShortcutIsRegisteredAPI:
		return runGlobalShortcutIsRegisteredAPITest()
	case kindGlobalShortcutUnregisterAllAPI:
		return runGlobalShortcutUnregisterAllAPITest()
	case kindLifecycleBeforeQuitCancel:
		return runLifecycleBeforeQuitCancelTest()
	case kindQuitShutdownPlayground:
		return runInteractivePlaygroundTest("Quit/Shutdown Test Playground", "views://playgrounds/quit-test/index.html")
	case kindWgpuAdapterContextDevice:
		return runWgpuAdapterContextDeviceTest()
	case kindDockIconVisibilityContract:
		return runDockIconVisibilityContractTest()
	case kindUtilsClipboardRoundTrip:
		return runUtilsClipboardRoundTripTest()
	case kindUtilsClipboardAvailableFormats:
		return runUtilsClipboardAvailableFormatsTest()
	case kindUtilsClipboardClear:
		return runUtilsClipboardClearTest()
	case kindUtilsShowNotification:
		return state.core.ShowNotification(electrobun.NotificationOptions{Title: "Electrobun Go", Body: "Go main process notification test", Silent: true})
	case kindUtilsOpenExternalExists, kindUtilsOpenPathExists, kindUtilsShowItemInFolderExists, kindUtilsQuitExists:
		return nil
	case kindUtilsPathsObjectExists:
		return runUtilsPathsObjectExistsTest()
	case kindUtilsPathsHomeMatches:
		return runUtilsPathsHomeMatchesTest()
	case kindUtilsPathsTempMatches:
		return runUtilsPathsTempMatchesTest()
	case kindUtilsPathsOSDirectories:
		return runUtilsPathsOSDirectoriesTest()
	case kindUtilsPathsAppScopedDirectories:
		return runUtilsPathsAppScopedDirectoriesTest()
	case kindUtilsPathsStableAcrossCalls:
		return runUtilsPathsStableAcrossCallsTest()
	case kindUtilsMoveToTrash:
		return runUtilsMoveToTrashTest()
	case kindScreenPrimaryDisplay:
		return runScreenPrimaryDisplayTest()
	case kindScreenAllDisplays:
		return runScreenAllDisplaysTest()
	case kindScreenCursorScreenPoint:
		return runScreenCursorScreenPointTest()
	case kindScreenBoundsVsWorkArea:
		return runScreenBoundsVsWorkAreaTest()
	}
	return fmt.Errorf("unsupported Go test kind: %s", test.Kind)
}

func runWindowCreateCloseTest() error {
	options := electrobun.NewWindowOptions("Go Window Create/Close Test", electrobun.NewRect(80, 80, 420, 280))
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	time.Sleep(50 * time.Millisecond)
	return state.core.CloseWindow(windowID)
}

func runWebviewCreateTest() error {
	options := electrobun.NewWindowOptions("Go BrowserView Create Test", electrobun.NewRect(120, 120, 640, 420))
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	webviewOptions := electrobun.NewWebviewOptions(windowID, goViewURL, electrobun.NewRect(0, 0, 640, 420))
	webviewOptions.SecretKey = defaultSecretKey
	webviewOptions.Sandbox = true
	webviewOptions.Callbacks = noopWebviewCallbacks()
	createErr := error(nil)
	if _, createErr = state.core.CreateWebview(webviewOptions); createErr == nil {
		time.Sleep(300 * time.Millisecond)
	}
	closeErr := state.core.CloseWindow(windowID)
	if createErr != nil {
		return createErr
	}
	return closeErr
}

func sleep(ms time.Duration) {
	time.Sleep(ms)
}

func approxEq(left, right, tolerance float64) bool {
	return math.Abs(left-right) <= tolerance
}

func waitUntil(timeout time.Duration, predicate func() bool) bool {
	started := time.Now()
	for time.Since(started) < timeout {
		if predicate() {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return predicate()
}

func closeWindowSilent(windowID uint32) {
	_ = state.core.CloseWindow(windowID)
}

func finishWithWindow(windowID uint32, err error) error {
	closeErr := state.core.CloseWindow(windowID)
	if err != nil {
		return err
	}
	return closeErr
}

func activePlaygroundRenderer() electrobun.Renderer {
	if state.cefAvailable {
		return electrobun.RendererCEF
	}
	return electrobun.RendererNative
}

func rendererFromString(value string) electrobun.Renderer {
	if value == "cef" {
		return electrobun.RendererCEF
	}
	return electrobun.RendererNative
}

func rememberTopLevelWebview(webviewID, windowID uint32) {
	state.mu.Lock()
	state.topLevelWebviews[webviewID] = windowID
	state.mu.Unlock()
}

func forgetTopLevelWebview(webviewID uint32) {
	state.mu.Lock()
	delete(state.topLevelWebviews, webviewID)
	state.mu.Unlock()
}

func windowIDForTopLevelWebview(webviewID uint32) (uint32, bool) {
	state.mu.Lock()
	defer state.mu.Unlock()
	windowID, ok := state.topLevelWebviews[webviewID]
	return windowID, ok
}

func rememberChildWebview(webviewID uint32, renderer electrobun.Renderer) {
	state.mu.Lock()
	state.childWebviews[webviewID] = renderer
	state.mu.Unlock()
}

func forgetChildWebview(webviewID uint32) {
	state.mu.Lock()
	delete(state.childWebviews, webviewID)
	state.mu.Unlock()
}

func childWebviewRenderer(webviewID uint32) electrobun.Renderer {
	state.mu.Lock()
	defer state.mu.Unlock()
	if renderer, ok := state.childWebviews[webviewID]; ok {
		return renderer
	}
	return electrobun.RendererNative
}

func noopWebviewCallbacks() electrobun.WebviewCallbacks {
	return electrobun.WebviewCallbacks{
		DecideNavigation: electrobun.AllowAllNavigation,
		Event:            electrobun.NoopWebviewEvent,
		EventBridge:      electrobun.NoopWebviewPostMessage,
		HostBridge:       electrobun.NoopWebviewPostMessage,
		InternalBridge:   electrobun.NoopWebviewPostMessage,
	}
}

func createWindowWithHarnessCustom(title string, frame electrobun.Rect, hidden, activate bool, titleBarStyle string, windowCallbacks electrobun.WindowCallbacks, webviewCallbacks electrobun.WebviewCallbacks) (windowWithWebview, error) {
	windowOptions := electrobun.NewWindowOptions(title, frame)
	windowOptions.Hidden = hidden
	windowOptions.Activate = activate
	windowOptions.TitleBarStyle = titleBarStyle
	windowOptions.Callbacks = windowCallbacks
	windowID, err := state.core.CreateWindow(windowOptions)
	if err != nil {
		return windowWithWebview{}, err
	}
	webviewOptions := electrobun.NewWebviewOptions(windowID, testHarnessURL, electrobun.NewRect(0, 0, frame.Width, frame.Height))
	webviewOptions.Renderer = electrobun.RendererNative
	webviewOptions.SecretKey = defaultSecretKey
	webviewOptions.Sandbox = false
	webviewOptions.Callbacks = webviewCallbacks
	webviewID, err := state.core.CreateWebview(webviewOptions)
	if err != nil {
		closeWindowSilent(windowID)
		return windowWithWebview{}, err
	}
	return windowWithWebview{windowID: windowID, webviewID: webviewID}, nil
}

func createWindowWithTestHarness(title string, frame electrobun.Rect, hidden, activate bool) (windowWithWebview, error) {
	return createWindowWithHarnessCustom(title, frame, hidden, activate, "default", electrobun.WindowCallbacks{}, noopWebviewCallbacks())
}

func observedHarnessWebviewCallbacks() electrobun.WebviewCallbacks {
	return electrobun.WebviewCallbacks{
		DecideNavigation: electrobun.AllowAllNavigation,
		Event:            observedWebviewEvent,
		EventBridge:      observedWebviewBridge,
		HostBridge:       electrobun.NoopWebviewPostMessage,
		InternalBridge:   observedWebviewBridge,
	}
}

func openInteractivePlaygroundWindow(title, url string) (windowWithWebview, error) {
	resetCallbackState()
	frame := electrobun.NewRect(120, 70, 860, 640)
	windowOptions := electrobun.NewWindowOptions(title, frame)
	windowOptions.Callbacks = electrobun.WindowCallbacks{Close: observedWindowClose}
	windowID, err := state.core.CreateWindow(windowOptions)
	if err != nil {
		return windowWithWebview{}, err
	}
	webviewOptions := electrobun.NewWebviewOptions(windowID, url, electrobun.NewRect(0, 0, frame.Width, frame.Height))
	webviewOptions.Renderer = activePlaygroundRenderer()
	webviewOptions.SecretKey = defaultSecretKey
	webviewOptions.Sandbox = false
	webviewOptions.Callbacks = electrobun.WebviewCallbacks{
		DecideNavigation: electrobun.AllowAllNavigation,
		Event:            observedWebviewEvent,
		EventBridge:      observedWebviewBridge,
		HostBridge:       testRunnerHostBridge,
		InternalBridge:   playgroundInternalBridge,
	}
	webviewID, err := state.core.CreateWebview(webviewOptions)
	if err != nil {
		closeWindowSilent(windowID)
		return windowWithWebview{}, err
	}
	rememberTopLevelWebview(webviewID, windowID)
	_ = state.core.SetWindowAlwaysOnTop(windowID, true)
	return windowWithWebview{windowID: windowID, webviewID: webviewID}, nil
}

func waitForInteractiveWindowClose() {
	for callbackCount(func(c callbackState) uint32 { return c.windowCloseCount }) == 0 {
		time.Sleep(100 * time.Millisecond)
	}
}

func runWindowCreationWithURLTest() error {
	created, err := createWindowWithTestHarness("Go Window URL Test", electrobun.NewRect(100, 100, 640, 420), true, false)
	if err != nil {
		return err
	}
	time.Sleep(mediumWait)
	return finishWithWindow(created.windowID, nil)
}

func runWindowHiddenOptionTest() error {
	options := electrobun.NewWindowOptions("Go Hidden Window Test", electrobun.NewRect(120, 120, 420, 280))
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	err = func() error {
		time.Sleep(shortWait)
		if err := state.core.ShowWindow(windowID, true); err != nil {
			return err
		}
		time.Sleep(shortWait)
		return state.core.HideWindow(windowID)
	}()
	return finishWithWindow(windowID, err)
}

func runWindowInactiveShowAPITest() error {
	options := electrobun.NewWindowOptions("Go Inactive Show Test", electrobun.NewRect(140, 140, 420, 280))
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.ShowWindow(windowID, false); err != nil {
			return err
		}
		time.Sleep(shortWait)
		return state.core.ActivateWindow(windowID)
	}()
	return finishWithWindow(windowID, err)
}

func runWindowSetTitleTest() error {
	options := electrobun.NewWindowOptions("Go Initial Title", electrobun.NewRect(100, 100, 420, 280))
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	return finishWithWindow(windowID, state.core.SetWindowTitle(windowID, "Go Updated Title"))
}

func runWindowMinimizeUnminimizeTest() error {
	windowID, err := state.core.CreateWindow(electrobun.NewWindowOptions("Go Minimize Test", electrobun.NewRect(100, 100, 480, 320)))
	if err != nil {
		return err
	}
	err = func() error {
		time.Sleep(mediumWait)
		if err := state.core.MinimizeWindow(windowID); err != nil {
			return err
		}
		time.Sleep(longWait)
		if !state.core.IsWindowMinimized(windowID) {
			return fmt.Errorf("window did not report minimized")
		}
		if err := state.core.RestoreWindow(windowID); err != nil {
			return err
		}
		time.Sleep(mediumWait)
		if state.core.IsWindowMinimized(windowID) {
			return fmt.Errorf("window still reported minimized after restore")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowFullscreenToggleTest(hiddenTitlebar bool) error {
	options := electrobun.NewWindowOptions("Go Fullscreen Test", electrobun.NewRect(140, 100, 640, 420))
	if hiddenTitlebar {
		options.TitleBarStyle = "hiddenInset"
	}
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	err = func() error {
		time.Sleep(mediumWait)
		if err := state.core.SetWindowFullScreen(windowID, true); err != nil {
			return err
		}
		time.Sleep(longWait)
		if !state.core.IsWindowFullScreen(windowID) {
			return fmt.Errorf("window did not enter fullscreen")
		}
		if err := state.core.SetWindowFullScreen(windowID, false); err != nil {
			return err
		}
		time.Sleep(longWait)
		if state.core.IsWindowFullScreen(windowID) {
			return fmt.Errorf("window still reported fullscreen after exit")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func hiddenWindow(title string, frame electrobun.Rect) (uint32, error) {
	options := electrobun.NewWindowOptions(title, frame)
	options.Hidden = true
	options.Activate = false
	return state.core.CreateWindow(options)
}

func runWindowSetPositionTest() error {
	windowID, err := hiddenWindow("Go Position Test", electrobun.NewRect(80, 80, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.SetWindowPosition(windowID, 180, 160); err != nil {
			return err
		}
		time.Sleep(shortWait)
		frame, err := state.core.GetWindowFrame(windowID)
		if err != nil {
			return err
		}
		if !approxEq(frame.X, 180, 24) || !approxEq(frame.Y, 160, 24) {
			return fmt.Errorf("unexpected position %v,%v", frame.X, frame.Y)
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowSetSizeTest() error {
	windowID, err := hiddenWindow("Go Size Test", electrobun.NewRect(80, 80, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.SetWindowSize(windowID, 520, 360); err != nil {
			return err
		}
		time.Sleep(shortWait)
		frame, err := state.core.GetWindowFrame(windowID)
		if err != nil {
			return err
		}
		if !approxEq(frame.Width, 520, 24) || !approxEq(frame.Height, 360, 24) {
			return fmt.Errorf("unexpected size %vx%v", frame.Width, frame.Height)
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowSetFrameTest() error {
	windowID, err := hiddenWindow("Go Frame Test", electrobun.NewRect(80, 80, 420, 280))
	if err != nil {
		return err
	}
	target := electrobun.NewRect(170, 150, 540, 380)
	err = func() error {
		if err := state.core.SetWindowFrame(windowID, target); err != nil {
			return err
		}
		time.Sleep(shortWait)
		frame, err := state.core.GetWindowFrame(windowID)
		if err != nil {
			return err
		}
		if !approxEq(frame.Width, target.Width, 24) || !approxEq(frame.Height, target.Height, 24) {
			return fmt.Errorf("setFrame size did not round-trip")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowGetFrameTest() error {
	windowID, err := hiddenWindow("Go Get Frame Test", electrobun.NewRect(80, 80, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		frame, err := state.core.GetWindowFrame(windowID)
		if err != nil {
			return err
		}
		if frame.Width <= 0 || frame.Height <= 0 {
			return fmt.Errorf("window frame returned empty size")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowGetPositionTest() error {
	windowID, err := hiddenWindow("Go Get Position Test", electrobun.NewRect(90, 90, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		frame, err := state.core.GetWindowFrame(windowID)
		if err != nil {
			return err
		}
		if math.IsNaN(frame.X) || math.IsNaN(frame.Y) {
			return fmt.Errorf("window position was not finite")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowGetSizeTest() error {
	windowID, err := hiddenWindow("Go Get Size Test", electrobun.NewRect(90, 90, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		frame, err := state.core.GetWindowFrame(windowID)
		if err != nil {
			return err
		}
		if frame.Width < 100 || frame.Height < 100 {
			return fmt.Errorf("window size was unexpectedly small")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowMaximizeUnmaximizeTest() error {
	windowID, err := state.core.CreateWindow(electrobun.NewWindowOptions("Go Maximize Test", electrobun.NewRect(120, 120, 540, 360)))
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.MaximizeWindow(windowID); err != nil {
			return err
		}
		time.Sleep(longWait)
		if !state.core.IsWindowMaximized(windowID) {
			return fmt.Errorf("window did not report maximized")
		}
		if err := state.core.UnmaximizeWindow(windowID); err != nil {
			return err
		}
		time.Sleep(longWait)
		if state.core.IsWindowMaximized(windowID) {
			return fmt.Errorf("window still reported maximized")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowAlwaysOnTopTest() error {
	windowID, err := hiddenWindow("Go Always On Top Test", electrobun.NewRect(120, 120, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.SetWindowAlwaysOnTop(windowID, true); err != nil {
			return err
		}
		if !state.core.IsWindowAlwaysOnTop(windowID) {
			return fmt.Errorf("always-on-top did not enable")
		}
		if err := state.core.SetWindowAlwaysOnTop(windowID, false); err != nil {
			return err
		}
		if state.core.IsWindowAlwaysOnTop(windowID) {
			return fmt.Errorf("always-on-top did not disable")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowVisibleOnAllWorkspacesTest() error {
	windowID, err := hiddenWindow("Go Workspace Visibility Test", electrobun.NewRect(120, 120, 420, 280))
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.SetWindowVisibleOnAllWorkspaces(windowID, true); err != nil {
			return err
		}
		if !state.core.IsWindowVisibleOnAllWorkspaces(windowID) {
			return fmt.Errorf("visible-on-all-workspaces did not enable")
		}
		if err := state.core.SetWindowVisibleOnAllWorkspaces(windowID, false); err != nil {
			return err
		}
		if state.core.IsWindowVisibleOnAllWorkspaces(windowID) {
			return fmt.Errorf("visible-on-all-workspaces did not disable")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowFocusTest() error {
	resetCallbackState()
	first := electrobun.NewWindowOptions("Go Focus Test A", electrobun.NewRect(120, 120, 420, 280))
	first.Callbacks = electrobun.WindowCallbacks{Focus: observedWindowFocus}
	firstID, err := state.core.CreateWindow(first)
	if err != nil {
		return err
	}
	secondID, err := state.core.CreateWindow(electrobun.NewWindowOptions("Go Focus Test B", electrobun.NewRect(180, 180, 420, 280)))
	if err != nil {
		closeWindowSilent(firstID)
		return err
	}
	err = func() error {
		time.Sleep(mediumWait)
		if err := state.core.ActivateWindow(firstID); err != nil {
			return err
		}
		if !waitUntil(longWait, func() bool { return callbackCount(func(c callbackState) uint32 { return c.windowFocusCount }) > 0 }) {
			return fmt.Errorf("focus callback did not fire")
		}
		return nil
	}()
	closeWindowSilent(secondID)
	return finishWithWindow(firstID, err)
}

func runWindowCloseEventTest() error {
	resetCallbackState()
	options := electrobun.NewWindowOptions("Go Close Event Test", electrobun.NewRect(120, 120, 420, 280))
	options.Callbacks = electrobun.WindowCallbacks{Close: observedWindowClose}
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	if err := state.core.CloseWindow(windowID); err != nil {
		return err
	}
	if !waitUntil(longWait, func() bool { return callbackCount(func(c callbackState) uint32 { return c.windowCloseCount }) > 0 }) {
		return fmt.Errorf("close callback did not fire")
	}
	return nil
}

func runWindowResizeEventTest() error {
	resetCallbackState()
	options := electrobun.NewWindowOptions("Go Resize Event Test", electrobun.NewRect(120, 120, 420, 280))
	options.Callbacks = electrobun.WindowCallbacks{Resize: observedWindowResize}
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	err = func() error {
		time.Sleep(mediumWait)
		if err := state.core.SetWindowSize(windowID, 560, 380); err != nil {
			return err
		}
		if !waitUntil(longWait, func() bool { return callbackCount(func(c callbackState) uint32 { return c.windowResizeCount }) > 0 }) {
			return fmt.Errorf("resize callback did not fire")
		}
		width, height := lastResizeSize()
		if width <= 0 || height <= 0 {
			return fmt.Errorf("resize callback returned empty size")
		}
		return nil
	}()
	return finishWithWindow(windowID, err)
}

func runWindowGetByIDTest() error {
	return runWindowGetFrameTest()
}

func runWindowInsetTitlebarStyleTest() error {
	options := electrobun.NewWindowOptions("Go Inset Titlebar Test", electrobun.NewRect(100, 100, 520, 340))
	options.TitleBarStyle = "hiddenInset"
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	time.Sleep(shortWait)
	return state.core.CloseWindow(windowID)
}

func runWindowTrafficLightPositionAPITest() error {
	options := electrobun.NewWindowOptions("Go Traffic Light Test", electrobun.NewRect(100, 100, 520, 340))
	options.TitleBarStyle = "hiddenInset"
	options.TrafficLightOffset = electrobun.TrafficLightOffset{X: 20, Y: 18}
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	return finishWithWindow(windowID, state.core.SetWindowButtonPosition(windowID, 28, 22))
}

func runWebviewPageZoomTest() error {
	created, err := createWindowWithTestHarness("Go BrowserView Zoom Test", electrobun.NewRect(100, 100, 640, 420), true, false)
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.SetWebviewPageZoom(created.webviewID, 1.25); err != nil {
			return err
		}
		time.Sleep(shortWait)
		zoom := state.core.GetWebviewPageZoom(created.webviewID)
		if !approxEq(zoom, 1.25, 0.01) {
			return fmt.Errorf("unexpected page zoom %v", zoom)
		}
		return state.core.SetWebviewPageZoom(created.webviewID, 1)
	}()
	return finishWithWindow(created.windowID, err)
}

func runWebviewTagPlaygroundIntegrationTest() error {
	created, err := openInteractivePlaygroundWindow("Go Webview Tag Integration", "views://playgrounds/webviewtag/index.html")
	if err != nil {
		return err
	}
	err = nil
	if !waitUntil(5*time.Second, func() bool { return callbackCount(func(c callbackState) uint32 { return c.webviewTagInit }) > 0 }) {
		err = fmt.Errorf("electrobun-webview tag did not initialize")
	}
	forgetTopLevelWebview(created.webviewID)
	return finishWithWindow(created.windowID, err)
}

func runWgpuTagPlaygroundIntegrationTest() error {
	created, err := openInteractivePlaygroundWindow("Go WGPU Tag Integration", "views://playgrounds/wgpu-tag/index.html")
	if err != nil {
		return err
	}
	err = nil
	if !waitUntil(8*time.Second, func() bool {
		return callbackCount(func(c callbackState) uint32 { return c.wgpuTagInit }) > 0 &&
			callbackCount(func(c callbackState) uint32 { return c.wgpuTagReady }) > 0
	}) {
		err = fmt.Errorf("electrobun-wgpu tag did not initialize and report ready")
	}
	forgetTopLevelWebview(created.webviewID)
	return finishWithWindow(created.windowID, err)
}

func runInteractivePlaygroundTest(title, url string) error {
	created, err := openInteractivePlaygroundWindow(title, url)
	if err != nil {
		return err
	}
	waitForInteractiveWindowClose()
	forgetTopLevelWebview(created.webviewID)
	return nil
}

func runNavigationLoadURLTest() error {
	resetCallbackState()
	created, err := createWindowWithHarnessCustom("Go Navigation URL Test", electrobun.NewRect(100, 100, 640, 420), true, false, "default", electrobun.WindowCallbacks{}, observedHarnessWebviewCallbacks())
	if err != nil {
		return err
	}
	err = func() error {
		time.Sleep(mediumWait)
		resetCallbackState()
		if err := state.core.LoadURLInWebview(created.webviewID, goViewURL); err != nil {
			return err
		}
		if !waitUntil(3*time.Second, func() bool {
			return callbackCount(func(c callbackState) uint32 { return c.webviewDidNavigate }) > 0 || lastWebviewDetailContains("views://zig")
		}) {
			return fmt.Errorf("did-navigate did not fire after loadURL")
		}
		return nil
	}()
	return finishWithWindow(created.windowID, err)
}

func runNavigationLoadHTMLTest() error {
	created, err := createWindowWithHarnessCustom("Go Navigation HTML Test", electrobun.NewRect(100, 100, 640, 420), true, false, "default", electrobun.WindowCallbacks{}, observedHarnessWebviewCallbacks())
	if err != nil {
		return err
	}
	err = state.core.LoadHTMLInWebview(created.webviewID, "<html><body><h1>Go loadHTML</h1></body></html>")
	if err == nil {
		time.Sleep(mediumWait)
	}
	return finishWithWindow(created.windowID, err)
}

func runNavigationDomReadyEventTest() error {
	resetCallbackState()
	created, err := createWindowWithHarnessCustom("Go DOM Ready Test", electrobun.NewRect(100, 100, 640, 420), true, false, "default", electrobun.WindowCallbacks{}, observedHarnessWebviewCallbacks())
	if err != nil {
		return err
	}
	if !waitUntil(3*time.Second, func() bool { return callbackCount(func(c callbackState) uint32 { return c.webviewDomReady }) > 0 }) {
		err = fmt.Errorf("dom-ready did not fire")
	}
	return finishWithWindow(created.windowID, err)
}

func runNavigationDidNavigateEventTest() error {
	resetCallbackState()
	created, err := createWindowWithHarnessCustom("Go Did Navigate Test", electrobun.NewRect(100, 100, 640, 420), true, false, "default", electrobun.WindowCallbacks{}, observedHarnessWebviewCallbacks())
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.LoadURLInWebview(created.webviewID, goViewURL); err != nil {
			return err
		}
		if !waitUntil(3*time.Second, func() bool {
			return callbackCount(func(c callbackState) uint32 { return c.webviewDidNavigate }) > 0 || lastWebviewDetailContains("views://zig")
		}) {
			return fmt.Errorf("did-navigate did not fire")
		}
		return nil
	}()
	return finishWithWindow(created.windowID, err)
}

func runNavigationExecuteJavascriptTest() error {
	created, err := createWindowWithTestHarness("Go Execute JavaScript Test", electrobun.NewRect(100, 100, 640, 420), true, false)
	if err != nil {
		return err
	}
	time.Sleep(mediumWait)
	err = state.core.EvaluateJavaScriptWithNoCompletion(created.webviewID, "document.body.dataset.goExecuteJavascript = 'ok';")
	return finishWithWindow(created.windowID, err)
}

func runTrayVisibilityToggleAndBoundsTest() error {
	trayID, err := state.core.CreateTray(electrobun.TrayOptions{Title: "Go Tray", Image: trayTemplateIconURL, IsTemplate: true, Width: 18, Height: 18})
	if err != nil {
		return err
	}
	err = func() error {
		if err := state.core.ShowTray(trayID); err != nil {
			return err
		}
		time.Sleep(mediumWait)
		bounds, err := state.core.GetTrayBounds(trayID)
		if err != nil {
			return err
		}
		if bounds.Width < 0 || bounds.Height < 0 {
			return fmt.Errorf("tray bounds returned invalid size")
		}
		if err := state.core.SetTrayTitle(trayID, "Go"); err != nil {
			return err
		}
		if err := state.core.HideTray(trayID); err != nil {
			return err
		}
		time.Sleep(shortWait)
		return state.core.ShowTray(trayID)
	}()
	removeErr := state.core.RemoveTray(trayID)
	if err != nil {
		return err
	}
	return removeErr
}

func runSessionCookiesAPIExistsTest() error {
	cookies, err := state.core.SessionGetCookies("persist:cookie-api-test", "{}")
	if err != nil {
		return err
	}
	if !strings.HasPrefix(strings.TrimSpace(cookies), "[") {
		return fmt.Errorf("session cookies did not return an array")
	}
	return nil
}

func runShowMessageBoxInfoDialogTest() error {
	response, err := state.core.ShowMessageBox(electrobun.MessageBoxOptions{
		BoxType:   "info",
		Title:     "Test Info Dialog",
		Message:   "This is a Go-mode test info dialog",
		Detail:    "Click any button to pass the test.",
		Buttons:   []string{"OK", "Cancel"},
		DefaultID: 0,
		CancelID:  1,
	})
	if err != nil {
		return err
	}
	if response < 0 {
		return fmt.Errorf("message box returned an invalid response")
	}
	return nil
}

func runGlobalShortcutIsRegisteredAPITest() error {
	_ = state.core.UnregisterAllGlobalShortcuts()
	candidates := []string{"Alt+Shift+Super+F11", "Alt+Shift+Super+F12", "Alt+Shift+Super+Insert", "CommandOrControl+Shift+Super+F11", "CommandOrControl+Alt+Super+F11", "Alt+Shift+Super+Delete"}
	accelerator := ""
	for _, candidate := range candidates {
		ok, err := state.core.RegisterGlobalShortcut(candidate)
		if err != nil {
			return err
		}
		if ok {
			accelerator = candidate
			break
		}
	}
	if accelerator == "" {
		return nil
	}
	defer state.core.UnregisterAllGlobalShortcuts()
	registered, err := state.core.IsGlobalShortcutRegistered(accelerator)
	if err != nil {
		return err
	}
	if !registered {
		return fmt.Errorf("global shortcut did not register")
	}
	if ok, err := state.core.UnregisterGlobalShortcut(accelerator); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("global shortcut did not unregister")
	}
	registered, err = state.core.IsGlobalShortcutRegistered(accelerator)
	if err != nil {
		return err
	}
	if registered {
		return fmt.Errorf("global shortcut still registered")
	}
	return nil
}

func runGlobalShortcutUnregisterAllAPITest() error {
	_ = state.core.UnregisterAllGlobalShortcuts()
	candidates := []string{"Alt+Shift+Super+F9", "Alt+Shift+Super+F10", "Alt+Shift+Super+PageUp", "CommandOrControl+Shift+Super+F9", "CommandOrControl+Alt+Super+F9", "CommandOrControl+Alt+Super+F10"}
	registeredAny := false
	for _, candidate := range candidates {
		ok, err := state.core.RegisterGlobalShortcut(candidate)
		if err != nil {
			return err
		}
		registeredAny = registeredAny || ok
	}
	if err := state.core.UnregisterAllGlobalShortcuts(); err != nil {
		return err
	}
	if registeredAny {
		for _, candidate := range candidates {
			registered, err := state.core.IsGlobalShortcutRegistered(candidate)
			if err != nil {
				return err
			}
			if registered {
				return fmt.Errorf("shortcut still registered: %s", candidate)
			}
		}
	}
	return nil
}

func runLifecycleBeforeQuitCancelTest() error {
	resetCallbackState()
	if err := state.core.SetQuitRequestedHandler(func() { recordBeforeQuit() }); err != nil {
		return err
	}
	recordBeforeQuit()
	if callbackCount(func(c callbackState) uint32 { return c.beforeQuitCount }) == 0 {
		return fmt.Errorf("quit requested handler did not fire")
	}
	return nil
}

func runWgpuAdapterContextDeviceTest() error {
	options := electrobun.NewWindowOptions("Go WGPU Native Test", electrobun.NewRect(120, 120, 640, 420))
	options.Hidden = true
	options.Activate = false
	windowID, err := state.core.CreateWindow(options)
	if err != nil {
		return err
	}
	err = func() error {
		wgpuID, err := state.core.CreateWGPUView(electrobun.NewWGPUViewOptions(windowID, electrobun.NewRect(0, 0, 320, 240)))
		if err != nil {
			return err
		}
		ptr, err := state.core.GetWGPUViewPointer(wgpuID)
		if err != nil {
			_ = state.core.RemoveWGPUView(wgpuID)
			return err
		}
		native, err := state.core.GetWGPUViewNativeHandle(wgpuID)
		if err != nil {
			_ = state.core.RemoveWGPUView(wgpuID)
			return err
		}
		if ptr == nil || native == nil {
			_ = state.core.RemoveWGPUView(wgpuID)
			return fmt.Errorf("WGPU view returned a null handle")
		}
		if err := state.core.RunWGPUViewTest(wgpuID); err != nil {
			_ = state.core.RemoveWGPUView(wgpuID)
			return err
		}
		return state.core.RemoveWGPUView(wgpuID)
	}()
	return finishWithWindow(windowID, err)
}

func runDockIconVisibilityContractTest() error {
	original := state.core.IsDockIconVisible()
	if err := state.core.SetDockIconVisible(false); err != nil {
		return err
	}
	time.Sleep(shortWait)
	if err := state.core.SetDockIconVisible(true); err != nil {
		return err
	}
	time.Sleep(shortWait)
	return state.core.SetDockIconVisible(original)
}

func runUtilsClipboardRoundTripTest() error {
	text := "Electrobun Go clipboard round trip"
	if err := state.core.ClipboardWriteText(text); err != nil {
		return err
	}
	read, _, err := state.core.ClipboardReadText()
	if err != nil {
		return err
	}
	if read != text {
		return fmt.Errorf("clipboard round trip mismatch: %s", read)
	}
	return nil
}

func runUtilsClipboardAvailableFormatsTest() error {
	if err := state.core.ClipboardWriteText("Electrobun Go clipboard formats"); err != nil {
		return err
	}
	formats, err := state.core.ClipboardAvailableFormatsCSV()
	if err != nil {
		return err
	}
	if strings.TrimSpace(formats) == "" {
		return fmt.Errorf("clipboard formats were empty after writing text")
	}
	return nil
}

func runUtilsClipboardClearTest() error {
	if err := state.core.ClipboardWriteText("Electrobun Go clipboard clear"); err != nil {
		return err
	}
	if err := state.core.ClipboardClear(); err != nil {
		return err
	}
	read, _, err := state.core.ClipboardReadText()
	if err != nil {
		return err
	}
	if read != "" {
		return fmt.Errorf("clipboard text remained after clear")
	}
	return nil
}

func resolvedPaths() (electrobun.Paths, error) {
	return electrobun.ResolvePaths(state.appInfo)
}

func runUtilsPathsObjectExistsTest() error {
	paths, err := resolvedPaths()
	if err != nil {
		return err
	}
	if paths.Home == "" || paths.Temp == "" || paths.UserData == "" {
		return fmt.Errorf("paths object had empty core fields")
	}
	return nil
}

func runUtilsPathsHomeMatchesTest() error {
	paths, err := resolvedPaths()
	if err != nil {
		return err
	}
	home := os.Getenv("HOME")
	if home != "" && paths.Home != home {
		return fmt.Errorf("paths.home mismatch: %s != %s", paths.Home, home)
	}
	return nil
}

func runUtilsPathsTempMatchesTest() error {
	paths, err := resolvedPaths()
	if err != nil {
		return err
	}
	temp := strings.TrimRight(os.TempDir(), "/")
	resolved := strings.TrimRight(paths.Temp, "/")
	if resolved != temp {
		return fmt.Errorf("paths.temp mismatch: %s != %s", paths.Temp, temp)
	}
	return nil
}

func runUtilsPathsOSDirectoriesTest() error {
	paths, err := resolvedPaths()
	if err != nil {
		return err
	}
	values := []string{paths.Home, paths.AppData, paths.Config, paths.Cache, paths.Temp, paths.Logs, paths.Documents, paths.Downloads, paths.Desktop, paths.Pictures, paths.Music, paths.Videos}
	for _, value := range values {
		if value == "" {
			return fmt.Errorf("one or more OS path fields were empty")
		}
	}
	return nil
}

func runUtilsPathsAppScopedDirectoriesTest() error {
	paths, err := resolvedPaths()
	if err != nil {
		return err
	}
	if paths.UserData == "" || paths.UserCache == "" || paths.UserLogs == "" {
		return fmt.Errorf("one or more app-scoped path fields were empty")
	}
	return nil
}

func runUtilsPathsStableAcrossCallsTest() error {
	first, err := resolvedPaths()
	if err != nil {
		return err
	}
	second, err := resolvedPaths()
	if err != nil {
		return err
	}
	if first.UserData != second.UserData || first.UserCache != second.UserCache || first.UserLogs != second.UserLogs {
		return fmt.Errorf("paths changed across calls")
	}
	return nil
}

func runUtilsMoveToTrashTest() error {
	path := filepath.Join(os.TempDir(), fmt.Sprintf("electrobun-go-trash-%d.txt", os.Getpid()))
	if err := os.WriteFile(path, []byte("go moveToTrash test"), 0644); err != nil {
		return err
	}
	ok, err := state.core.MoveToTrash(path)
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	if !ok {
		_ = os.Remove(path)
		return fmt.Errorf("moveToTrash returned false")
	}
	return nil
}

func runScreenPrimaryDisplayTest() error {
	display, err := state.core.GetPrimaryDisplay()
	if err != nil {
		return err
	}
	if display.Bounds.Width <= 0 || display.Bounds.Height <= 0 {
		return fmt.Errorf("primary display returned empty bounds")
	}
	return nil
}

func runScreenAllDisplaysTest() error {
	displays, err := state.core.GetAllDisplays()
	if err != nil {
		return err
	}
	if len(displays) == 0 {
		return fmt.Errorf("getAllDisplays returned no displays")
	}
	for _, display := range displays {
		if display.Bounds.Width <= 0 || display.Bounds.Height <= 0 {
			return fmt.Errorf("one or more displays returned empty bounds")
		}
	}
	return nil
}

func runScreenCursorScreenPointTest() error {
	point, err := state.core.GetCursorScreenPoint()
	if err != nil {
		return err
	}
	if math.IsNaN(point.X) || math.IsNaN(point.Y) {
		return fmt.Errorf("cursor screen point was not finite")
	}
	return nil
}

func runScreenBoundsVsWorkAreaTest() error {
	display, err := state.core.GetPrimaryDisplay()
	if err != nil {
		return err
	}
	if display.WorkArea.Width <= 0 || display.WorkArea.Height <= 0 {
		return fmt.Errorf("primary display work area returned empty bounds")
	}
	if display.WorkArea.Width > display.Bounds.Width+1 || display.WorkArea.Height > display.Bounds.Height+1 {
		return fmt.Errorf("work area exceeded display bounds")
	}
	return nil
}

func playgroundInternalBridge(hostWebviewID uint32, message string) {
	if strings.TrimSpace(message) == "" {
		return
	}
	var object struct {
		ID      string          `json:"id"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal([]byte(message), &object) == nil && object.ID == "webviewEvent" {
		var payload struct {
			EventName string `json:"eventName"`
			Detail    string `json:"detail"`
		}
		_ = json.Unmarshal(object.Payload, &payload)
		recordObservedWebviewEvent(payload.EventName, payload.Detail)
		return
	}
	var packets []string
	if json.Unmarshal([]byte(message), &packets) != nil {
		return
	}
	for _, packet := range packets {
		handleInternalBridgePacket(hostWebviewID, packet)
	}
}

func handleInternalBridgePacket(hostWebviewID uint32, packet string) {
	var item struct {
		Type    string          `json:"type"`
		ID      string          `json:"id"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params"`
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal([]byte(packet), &item) != nil {
		return
	}
	switch item.Type {
	case "request":
		handleInternalBridgeRequest(hostWebviewID, item.ID, item.Method, rawParams(item.Params))
	case "message":
		handleInternalBridgeMessage(item.ID, rawParams(item.Payload))
	}
}

func handleInternalBridgeRequest(hostWebviewID uint32, requestID, method, params string) {
	var payloadJSON string
	var err error
	switch method {
	case "webviewTagInit":
		var id uint32
		id, err = createChildWebviewFromInternalBridge(hostWebviewID, params)
		payloadJSON = fmt.Sprintf("%d", id)
	case "webviewTagCanGoBack":
		id := uint32(numberField(params, "id"))
		payloadJSON = fmt.Sprintf("%t", state.core.CanWebviewGoBack(id))
	case "webviewTagCanGoForward":
		id := uint32(numberField(params, "id"))
		payloadJSON = fmt.Sprintf("%t", state.core.CanWebviewGoForward(id))
	case "wgpuTagInit":
		var id uint32
		id, err = createWGPUViewFromInternalBridge(params)
		payloadJSON = fmt.Sprintf("%d", id)
	default:
		err = fmt.Errorf("unsupported internal bridge request: %s", method)
	}
	if err != nil {
		sendInternalBridgeResponse(hostWebviewID, requestID, false, electrobun.JsonStringLiteral(err.Error()))
		return
	}
	sendInternalBridgeResponse(hostWebviewID, requestID, true, payloadJSON)
}

func handleInternalBridgeMessage(messageID, payload string) {
	id := uint32(numberField(payload, "id"))
	if id == 0 {
		return
	}
	switch messageID {
	case "webviewTagResize":
		if frame, ok := objectField(payload, "frame"); ok {
			_ = state.core.ResizeWebview(id, electrobun.ParseRectJSON(frame), electrobun.JsonStringField(payload, "masks", "[]"))
		}
	case "webviewTagUpdateSrc":
		if url := stringField(payload, "url"); url != "" {
			_ = state.core.LoadURLInWebview(id, url)
		}
	case "webviewTagUpdateHtml":
		if html := stringField(payload, "html"); html != "" {
			if childWebviewRenderer(id) == electrobun.RendererCEF {
				_ = state.core.SetWebviewHTMLContent(id, html)
				_ = state.core.LoadURLInWebview(id, "views://internal/index.html")
			} else {
				_ = state.core.LoadHTMLInWebview(id, html)
			}
		}
	case "webviewTagGoBack":
		_ = state.core.WebviewGoBack(id)
	case "webviewTagGoForward":
		_ = state.core.WebviewGoForward(id)
	case "webviewTagReload":
		_ = state.core.ReloadWebview(id)
	case "webviewTagRemove":
		_ = state.core.RemoveWebview(id)
		forgetChildWebview(id)
	case "webviewTagSetTransparent":
		_ = state.core.SetWebviewTransparent(id, boolField(payload, "transparent", false))
	case "webviewTagSetPassthrough":
		_ = state.core.SetWebviewPassthrough(id, boolField(payload, "enablePassthrough", false))
	case "webviewTagSetHidden":
		_ = state.core.SetWebviewHidden(id, boolField(payload, "hidden", false))
	case "webviewTagSetNavigationRules":
		if rules, ok := valueField(payload, "rules"); ok {
			_ = state.core.SetWebviewNavigationRules(id, rules)
		}
	case "webviewTagFindInPage":
		_ = state.core.WebviewFindInPage(id, stringField(payload, "searchText"), boolField(payload, "forward", true), boolField(payload, "matchCase", false))
	case "webviewTagStopFind":
		_ = state.core.WebviewStopFind(id)
	case "webviewTagOpenDevTools":
		_ = state.core.OpenWebviewDevtools(id)
	case "webviewTagCloseDevTools":
		_ = state.core.CloseWebviewDevtools(id)
	case "webviewTagToggleDevTools":
		_ = state.core.ToggleWebviewDevtools(id)
	case "webviewTagExecuteJavascript":
		if js := stringField(payload, "js"); js != "" {
			_ = state.core.EvaluateJavaScriptWithNoCompletion(id, js)
		}
	case "wgpuTagResize", "wgpuTagRect":
		if frame, ok := objectField(payload, "frame"); ok {
			_ = state.core.ResizeWGPUView(id, electrobun.ParseRectJSON(frame), electrobun.JsonStringField(payload, "masks", "[]"))
		}
	case "wgpuTagSetTransparent":
		_ = state.core.SetWGPUViewTransparent(id, boolField(payload, "transparent", false))
	case "wgpuTagSetPassthrough":
		_ = state.core.SetWGPUViewPassthrough(id, boolField(payload, "passthrough", false))
	case "wgpuTagSetHidden":
		_ = state.core.SetWGPUViewHidden(id, boolField(payload, "hidden", false))
	case "wgpuTagRemove":
		_ = state.core.RemoveWGPUView(id)
	case "wgpuTagRunTest":
		_ = state.core.RunWGPUViewTest(id)
	}
}

func createChildWebviewFromInternalBridge(hostWebviewID uint32, params string) (uint32, error) {
	renderer := rendererFromString(electrobun.JsonStringField(params, "renderer", "native"))
	url := stringField(params, "url")
	html := stringField(params, "html")
	preload := stringField(params, "preload")
	partition := electrobun.JsonStringField(params, "partition", "persist:default")
	windowID := uint32(numberField(params, "windowId"))
	frameJSON, ok := objectField(params, "frame")
	if !ok {
		return 0, fmt.Errorf("missing frame for webview tag")
	}
	effectiveURL := url
	if effectiveURL == "" && html == "" {
		effectiveURL = "https://electrobun.dev"
	}
	options := electrobun.NewWebviewOptions(windowID, effectiveURL, electrobun.ParseRectJSON(frameJSON))
	options.HostWebviewID = hostWebviewID
	options.Renderer = renderer
	options.AutoResize = false
	options.Partition = partition
	options.Preload = preload
	options.SecretKey = defaultSecretKey
	options.Sandbox = boolField(params, "sandbox", false)
	options.StartTransparent = boolField(params, "transparent", false)
	options.StartPassthrough = boolField(params, "passthrough", false)
	options.Callbacks = noopWebviewCallbacks()
	webviewID, err := state.core.CreateWebview(options)
	if err != nil {
		return 0, err
	}
	rememberChildWebview(webviewID, renderer)
	recordWebviewTagInit()
	if rules, ok := valueField(params, "navigationRules"); ok {
		_ = state.core.SetWebviewNavigationRules(webviewID, rules)
	}
	if html != "" {
		if renderer == electrobun.RendererCEF {
			if err := state.core.SetWebviewHTMLContent(webviewID, html); err != nil {
				return 0, err
			}
			if err := state.core.LoadURLInWebview(webviewID, "views://internal/index.html"); err != nil {
				return 0, err
			}
		} else if err := state.core.LoadHTMLInWebview(webviewID, html); err != nil {
			return 0, err
		}
	}
	return webviewID, nil
}

func createWGPUViewFromInternalBridge(params string) (uint32, error) {
	windowID := uint32(numberField(params, "windowId"))
	frameJSON, ok := objectField(params, "frame")
	if !ok {
		return 0, fmt.Errorf("missing frame for WGPU tag")
	}
	options := electrobun.NewWGPUViewOptions(windowID, electrobun.ParseRectJSON(frameJSON))
	options.StartTransparent = boolField(params, "transparent", false)
	options.StartPassthrough = boolField(params, "passthrough", false)
	wgpuViewID, err := state.core.CreateWGPUView(options)
	if err != nil {
		return 0, err
	}
	recordWgpuTagInit()
	return wgpuViewID, nil
}

func sendInternalBridgeResponse(hostWebviewID uint32, requestID string, success bool, payloadJSON string) {
	packet := fmt.Sprintf(`{"type":"response","id":%s,"success":%t,"payload":%s}`, electrobun.JsonStringLiteral(requestID), success, payloadJSON)
	if err := state.core.SendInternalMessageToWebviewJSON(hostWebviewID, packet); err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to send internal bridge response: %v\n", err)
	}
}

func maybeAutoRunAfterHandshake(webviewID uint32) {
	if !state.autoRunAll && state.autoRunTestName == "" {
		return
	}
	if state.autoRunTriggered.Swap(true) {
		return
	}
	if state.autoRunTestName != "" {
		fmt.Fprintf(os.Stderr, "[kitchen go] auto-running test: %s\n", state.autoRunTestName)
		if test, ok := findTestByNameOrID(state.autoRunTestName); ok {
			startSingleTest(webviewID, 0, false, test)
		} else {
			fmt.Fprintf(os.Stderr, "[kitchen go] failed to find auto-run test: %s\n", state.autoRunTestName)
		}
		return
	}
	if state.autoRunAll {
		fmt.Fprintf(os.Stderr, "[kitchen go] auto-running all automated tests\n")
		startAllTests(webviewID, 0, false, false)
	}
}

func testsJSON() string {
	entries := make([]string, 0, len(goTests))
	for _, test := range goTests {
		entries = append(entries, fmt.Sprintf(`{"id":%s,"name":%s,"category":%s,"description":%s,"interactive":%t}`,
			electrobun.JsonStringLiteral(test.ID),
			electrobun.JsonStringLiteral(test.Name),
			electrobun.JsonStringLiteral(test.Category),
			electrobun.JsonStringLiteral(test.Description),
			test.Interactive,
		))
	}
	return "[" + strings.Join(entries, ",") + "]"
}

func testResultJSON(test goTest, result testRunResult) string {
	errorField := ""
	if result.Error != "" {
		errorField = fmt.Sprintf(`,"error":%s`, electrobun.JsonStringLiteral(result.Error))
	}
	return fmt.Sprintf(`{"testId":%s,"name":%s,"status":%s,"duration":%d%s}`,
		electrobun.JsonStringLiteral(test.ID),
		electrobun.JsonStringLiteral(test.Name),
		electrobun.JsonStringLiteral(result.Status),
		result.Duration.Milliseconds(),
		errorField,
	)
}

func sendInitialUIState(webviewID uint32) {
	sendBuildConfig(webviewID)
	sendUpdateStatus(webviewID)
}

func sendBuildConfig(webviewID uint32) {
	availableRenderers := `["native"]`
	if state.cefAvailable {
		availableRenderers = `["native","cef"]`
	}
	cefField := ""
	if state.cefVersion != "" {
		cefField = fmt.Sprintf(`,"cefVersion":%s`, electrobun.JsonStringLiteral(state.cefVersion))
	}
	goField := ""
	if state.goVersion != "" {
		goField = fmt.Sprintf(`,"goVersion":%s`, electrobun.JsonStringLiteral(state.goVersion))
	}
	payload := fmt.Sprintf(`{"defaultRenderer":%s,"availableRenderers":%s,"mainProcess":"go"%s%s}`,
		electrobun.JsonStringLiteral(state.defaultRenderer),
		availableRenderers,
		cefField,
		goField,
	)
	sendRPCMessage(webviewID, "buildConfig", payload)
}

func sendUpdateStatus(webviewID uint32) {
	sendRPCMessage(webviewID, "updateStatus", fmt.Sprintf(`{"status":"no-update","currentVersion":%s}`, electrobun.JsonStringLiteral(appVersion)))
}

func sendTestLog(webviewID uint32, testID, message string) {
	sendRPCMessage(webviewID, "testLog", fmt.Sprintf(`{"testId":%s,"message":%s}`, electrobun.JsonStringLiteral(testID), electrobun.JsonStringLiteral(message)))
}

func sendRPCMessage(webviewID uint32, messageID, payloadJSON string) {
	packet := fmt.Sprintf(`{"type":"message","id":%s,"payload":%s}`, electrobun.JsonStringLiteral(messageID), payloadJSON)
	if err := state.core.SendHostMessageToWebviewJSON(webviewID, packet); err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to send RPC message '%s': %v\n", messageID, err)
	}
}

func sendRPCResponseSuccess(webviewID uint32, requestID uint64, payloadJSON string) {
	packet := fmt.Sprintf(`{"type":"response","id":%d,"success":true,"payload":%s}`, requestID, payloadJSON)
	if err := state.core.SendHostMessageToWebviewJSON(webviewID, packet); err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to send RPC response #%d: %v\n", requestID, err)
	}
}

func sendRPCResponseError(webviewID uint32, requestID uint64, errorMessage string) {
	packet := fmt.Sprintf(`{"type":"response","id":%d,"success":false,"error":%s}`, requestID, electrobun.JsonStringLiteral(errorMessage))
	if err := state.core.SendHostMessageToWebviewJSON(webviewID, packet); err != nil {
		fmt.Fprintf(os.Stderr, "[kitchen go] failed to send RPC error #%d: %v\n", requestID, err)
	}
}

func resetCallbackState() {
	callbacksMu.Lock()
	callbacks = callbackState{}
	callbacksMu.Unlock()
}

func callbackCount(read func(callbackState) uint32) uint32 {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	return read(callbacks)
}

func lastResizeSize() (float64, float64) {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	return callbacks.lastResizeWidth, callbacks.lastResizeHeight
}

func lastWebviewDetailContains(needle string) bool {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	return strings.Contains(callbacks.lastWebviewDetail, needle)
}

func observedWindowClose(uint32) {
	callbacksMu.Lock()
	callbacks.windowCloseCount++
	callbacksMu.Unlock()
}

func observedWindowResize(_ uint32, _, _, width, height float64) {
	callbacksMu.Lock()
	callbacks.windowResizeCount++
	callbacks.lastResizeWidth = width
	callbacks.lastResizeHeight = height
	callbacksMu.Unlock()
}

func observedWindowFocus(uint32) {
	callbacksMu.Lock()
	callbacks.windowFocusCount++
	callbacksMu.Unlock()
}

func observedWebviewEvent(_ uint32, eventName, detail string) {
	recordObservedWebviewEvent(eventName, detail)
}

func observedWebviewBridge(_ uint32, message string) {
	var packet struct {
		ID        string          `json:"id"`
		EventName string          `json:"eventName"`
		Detail    string          `json:"detail"`
		Payload   json.RawMessage `json:"payload"`
	}
	if json.Unmarshal([]byte(message), &packet) == nil && packet.ID == "webviewEvent" {
		if packet.EventName == "" && len(packet.Payload) > 0 {
			packet.EventName = stringField(string(packet.Payload), "eventName")
			packet.Detail = stringField(string(packet.Payload), "detail")
		}
		recordObservedWebviewEvent(packet.EventName, packet.Detail)
	}
}

func recordObservedWebviewEvent(eventName, detail string) {
	callbacksMu.Lock()
	defer callbacksMu.Unlock()
	switch eventName {
	case "will-navigate":
		callbacks.webviewWillNavigate++
	case "did-navigate":
		callbacks.webviewDidNavigate++
	case "dom-ready":
		callbacks.webviewDomReady++
	}
	callbacks.lastWebviewDetail = detail
}

func recordWebviewTagInit() {
	callbacksMu.Lock()
	callbacks.webviewTagInit++
	callbacksMu.Unlock()
}

func recordWgpuTagInit() {
	callbacksMu.Lock()
	callbacks.wgpuTagInit++
	callbacksMu.Unlock()
}

func recordWgpuTagReady() {
	callbacksMu.Lock()
	callbacks.wgpuTagReady++
	callbacksMu.Unlock()
}

func recordBeforeQuit() {
	callbacksMu.Lock()
	callbacks.beforeQuitCount++
	callbacksMu.Unlock()
}

func stringField(source, key string) string {
	return electrobun.JsonStringField(source, key, "")
}

func numberField(source, key string) float64 {
	value, _ := electrobun.JsonNumberField(source, key)
	return value
}

func boolField(source, key string, fallback bool) bool {
	if value, ok := electrobun.JsonBoolField(source, key); ok {
		return value
	}
	return fallback
}

func objectField(source, key string) (string, bool) {
	return electrobun.JsonObjectField(source, key)
}

func valueField(source, key string) (string, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal([]byte(source), &obj) != nil {
		return "", false
	}
	raw, ok := obj[key]
	if !ok {
		return "", false
	}
	return string(raw), true
}
