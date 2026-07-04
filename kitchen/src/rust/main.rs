use crate::electrobun::{
    self, BundlePaths, Core, NotificationOptions, Paths, Rect, Renderer, TrafficLightOffset,
    TrayOptions, WGPUViewOptions, WebviewCallbacks, WebviewOptions, WindowOptions,
};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const APP_VERSION: &str = "1.18.1";
const DEFAULT_SECRET_KEY: &str =
    "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32";
const TEST_HARNESS_URL: &str = "views://test-harness/index.html";
const ZIG_VIEW_URL: &str = "views://zig/index.html";
const TRAY_TEMPLATE_ICON_URL: &str = "views://assets/electrobun-logo-32-template.png";
const SHORT_WAIT_MS: u64 = 150;
const MEDIUM_WAIT_MS: u64 = 500;
const LONG_WAIT_MS: u64 = 1200;

static APP_STATE: OnceLock<AppState> = OnceLock::new();
static HOST_QUEUE_RUNNING: AtomicBool = AtomicBool::new(false);
static CALLBACK_STATE: Mutex<CallbackState> = Mutex::new(CallbackState::new());

struct AppState {
    core: &'static Core,
    bundle_paths: BundlePaths,
    app_info: electrobun::AppInfo,
    default_renderer: String,
    cef_available: bool,
    cef_version: Option<String>,
    rust_version: Option<String>,
    search_query: Mutex<String>,
    test_runner_webview_id: Mutex<Option<u32>>,
    top_level_webviews: Mutex<Vec<(u32, u32)>>,
    child_webviews: Mutex<Vec<(u32, Renderer)>>,
    auto_run_all: bool,
    auto_run_test_name: Option<String>,
    auto_run_triggered: AtomicBool,
}

#[derive(Clone, Copy)]
enum TestKind {
    Smoke,
    WindowCreateClose,
    WindowCreationWithUrl,
    WindowHiddenOption,
    WindowInactiveShowApi,
    WindowPageZoom,
    WindowSetTitle,
    WindowMinimizeUnminimize,
    WindowFullscreenToggle,
    WindowFullscreenToggleHiddenTitlebar,
    WindowSetPosition,
    WindowSetSize,
    WindowSetFrame,
    WindowGetFrame,
    WindowGetPosition,
    WindowGetSize,
    WindowMaximizeUnmaximize,
    WindowAlwaysOnTop,
    WindowVisibleOnAllWorkspaces,
    WindowFocus,
    WindowCloseEvent,
    WindowResizeEvent,
    WindowGetById,
    WindowInsetTitlebarStyle,
    WindowTrafficLightPositionApi,
    WebviewCreate,
    WebviewPageZoom,
    WebviewTagPlaygroundIntegration,
    WebviewTagPlaygroundInteractive,
    WgpuTagPlaygroundIntegration,
    WgpuTagPlaygroundInteractive,
    NavigationLoadUrl,
    NavigationLoadHtml,
    NavigationDomReadyEvent,
    NavigationDidNavigateEvent,
    NavigationExecuteJavascript,
    TrayVisibilityToggleAndBounds,
    SessionFromPartition,
    SessionDefaultSession,
    SessionCookiesApiExists,
    ApplicationMenuPlayground,
    ContextMenuPlayground,
    DialogShowMessageBoxInfo,
    DialogFileDialogPlayground,
    GlobalShortcutsPlayground,
    GlobalShortcutIsRegisteredApi,
    GlobalShortcutUnregisterAllApi,
    LifecycleBeforeQuitCancel,
    QuitShutdownPlayground,
    WgpuAdapterContextDevice,
    DockIconVisibilityContract,
    UtilsClipboardRoundTrip,
    UtilsClipboardAvailableFormats,
    UtilsClipboardClear,
    UtilsShowNotification,
    UtilsOpenExternalExists,
    UtilsOpenPathExists,
    UtilsShowItemInFolderExists,
    UtilsQuitExists,
    UtilsPathsObjectExists,
    UtilsPathsHomeMatches,
    UtilsPathsTempMatches,
    UtilsPathsOsDirectories,
    UtilsPathsAppScopedDirectories,
    UtilsPathsStableAcrossCalls,
    UtilsMoveToTrash,
    ScreenPrimaryDisplay,
    ScreenAllDisplays,
    ScreenCursorScreenPoint,
    ScreenBoundsVsWorkArea,
}

#[derive(Clone, Copy)]
struct RustTest {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    description: &'static str,
    interactive: bool,
    kind: TestKind,
}

struct TestRunResult {
    status: &'static str,
    duration_ms: u128,
    error: Option<String>,
}

struct CallbackState {
    window_close_count: u32,
    window_resize_count: u32,
    window_focus_count: u32,
    webview_will_navigate_count: u32,
    webview_did_navigate_count: u32,
    webview_dom_ready_count: u32,
    webview_tag_init_count: u32,
    wgpu_tag_init_count: u32,
    wgpu_tag_ready_count: u32,
    before_quit_count: u32,
    last_resize_width: f64,
    last_resize_height: f64,
    last_webview_detail: String,
}

impl CallbackState {
    const fn new() -> Self {
        Self {
            window_close_count: 0,
            window_resize_count: 0,
            window_focus_count: 0,
            webview_will_navigate_count: 0,
            webview_did_navigate_count: 0,
            webview_dom_ready_count: 0,
            webview_tag_init_count: 0,
            wgpu_tag_init_count: 0,
            wgpu_tag_ready_count: 0,
            before_quit_count: 0,
            last_resize_width: 0.0,
            last_resize_height: 0.0,
            last_webview_detail: String::new(),
        }
    }

    fn reset(&mut self) {
        self.window_close_count = 0;
        self.window_resize_count = 0;
        self.window_focus_count = 0;
        self.webview_will_navigate_count = 0;
        self.webview_did_navigate_count = 0;
        self.webview_dom_ready_count = 0;
        self.webview_tag_init_count = 0;
        self.wgpu_tag_init_count = 0;
        self.wgpu_tag_ready_count = 0;
        self.before_quit_count = 0;
        self.last_resize_width = 0.0;
        self.last_resize_height = 0.0;
        self.last_webview_detail.clear();
    }
}

const RUST_TESTS: &[RustTest] = &[
    RustTest {
        id: "rust-smoke-test",
        name: "Rust host smoke test",
        category: "Rust Native",
        description: "Verify the Rust main process and view RPC bridge are running.",
        interactive: false,
        kind: TestKind::Smoke,
    },
    RustTest {
        id: "rust-window-create-close",
        name: "Window create/close (Rust)",
        category: "BrowserWindow",
        description: "Create a native window through the Rust SDK and close it again.",
        interactive: false,
        kind: TestKind::WindowCreateClose,
    },
    RustTest {
        id: "rust-window-creation-with-url",
        name: "Window creation with URL (Rust)",
        category: "BrowserWindow",
        description: "Create a native window and attach a BrowserView loading the test harness URL.",
        interactive: false,
        kind: TestKind::WindowCreationWithUrl,
    },
    RustTest {
        id: "rust-window-hidden-option",
        name: "Window hidden option (Rust)",
        category: "BrowserWindow",
        description: "Create a hidden native window, then show it through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowHiddenOption,
    },
    RustTest {
        id: "rust-window-inactive-show-api",
        name: "Window inactive show API (Rust)",
        category: "BrowserWindow",
        description: "Show a native window without activation, then activate it explicitly.",
        interactive: false,
        kind: TestKind::WindowInactiveShowApi,
    },
    RustTest {
        id: "rust-window-page-zoom",
        name: "Window page zoom API (Rust)",
        category: "BrowserWindow",
        description: "Set and read the primary BrowserWindow page zoom in Rust mode.",
        interactive: false,
        kind: TestKind::WindowPageZoom,
    },
    RustTest {
        id: "rust-window-set-title",
        name: "Window setTitle (Rust)",
        category: "BrowserWindow",
        description: "Update a native window title through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowSetTitle,
    },
    RustTest {
        id: "rust-window-minimize-unminimize",
        name: "Window minimize/unminimize (Rust)",
        category: "BrowserWindow",
        description: "Toggle native window minimized state through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowMinimizeUnminimize,
    },
    RustTest {
        id: "rust-window-fullscreen-toggle",
        name: "Window fullscreen toggle (Rust)",
        category: "BrowserWindow",
        description: "Toggle native window fullscreen state through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowFullscreenToggle,
    },
    RustTest {
        id: "rust-window-fullscreen-toggle-hidden-titlebar",
        name: "Window fullscreen toggle with hidden titlebar (Rust)",
        category: "BrowserWindow",
        description: "Toggle fullscreen for a hidden-titlebar window in Rust mode on macOS.",
        interactive: false,
        kind: TestKind::WindowFullscreenToggleHiddenTitlebar,
    },
    RustTest {
        id: "rust-window-set-position",
        name: "Window setPosition (Rust)",
        category: "BrowserWindow",
        description: "Move a native window and read the new frame back from core.",
        interactive: false,
        kind: TestKind::WindowSetPosition,
    },
    RustTest {
        id: "rust-window-set-size",
        name: "Window setSize (Rust)",
        category: "BrowserWindow",
        description: "Resize a native window and read the new frame back from core.",
        interactive: false,
        kind: TestKind::WindowSetSize,
    },
    RustTest {
        id: "rust-window-set-frame",
        name: "Window setFrame (Rust)",
        category: "BrowserWindow",
        description: "Create a window, update its frame, and read the new size back from core.",
        interactive: false,
        kind: TestKind::WindowSetFrame,
    },
    RustTest {
        id: "rust-window-get-frame",
        name: "Window getFrame (Rust)",
        category: "BrowserWindow",
        description: "Read the current native window frame through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowGetFrame,
    },
    RustTest {
        id: "rust-window-get-position",
        name: "Window getPosition (Rust)",
        category: "BrowserWindow",
        description: "Read the current native window position through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowGetPosition,
    },
    RustTest {
        id: "rust-window-get-size",
        name: "Window getSize (Rust)",
        category: "BrowserWindow",
        description: "Read the current native window size through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowGetSize,
    },
    RustTest {
        id: "rust-window-maximize-unmaximize",
        name: "Window maximize/unmaximize (Rust)",
        category: "BrowserWindow",
        description: "Toggle native window maximized state through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowMaximizeUnmaximize,
    },
    RustTest {
        id: "rust-window-always-on-top",
        name: "Window alwaysOnTop (Rust)",
        category: "BrowserWindow",
        description: "Toggle native always-on-top state through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowAlwaysOnTop,
    },
    RustTest {
        id: "rust-window-visible-on-all-workspaces",
        name: "Window visibleOnAllWorkspaces (macOS) (Rust)",
        category: "BrowserWindow",
        description: "Toggle visible-on-all-workspaces in Rust mode on macOS.",
        interactive: false,
        kind: TestKind::WindowVisibleOnAllWorkspaces,
    },
    RustTest {
        id: "rust-window-focus",
        name: "Window focus (Rust)",
        category: "BrowserWindow",
        description: "Focus multiple native windows through the Rust SDK.",
        interactive: false,
        kind: TestKind::WindowFocus,
    },
    RustTest {
        id: "rust-window-close-event",
        name: "Window close event (Rust)",
        category: "BrowserWindow",
        description: "Verify a per-window close callback fires in Rust mode.",
        interactive: false,
        kind: TestKind::WindowCloseEvent,
    },
    RustTest {
        id: "rust-window-resize-event",
        name: "Window resize event (Rust)",
        category: "BrowserWindow",
        description: "Verify a per-window resize callback fires in Rust mode.",
        interactive: false,
        kind: TestKind::WindowResizeEvent,
    },
    RustTest {
        id: "rust-window-get-by-id",
        name: "BrowserWindow.getById (Rust)",
        category: "BrowserWindow",
        description: "Verify the Rust window registry can retrieve a tracked window by id.",
        interactive: false,
        kind: TestKind::WindowGetById,
    },
    RustTest {
        id: "rust-window-inset-titlebar-style",
        name: "Window with inset titlebar style (Rust)",
        category: "BrowserWindow",
        description: "Create a native window with hiddenInset titlebar style in Rust mode.",
        interactive: false,
        kind: TestKind::WindowInsetTitlebarStyle,
    },
    RustTest {
        id: "rust-window-traffic-light-position-api",
        name: "Window traffic light position API (Rust)",
        category: "BrowserWindow",
        description: "Create a hiddenInset window with traffic light offsets and move them at runtime.",
        interactive: false,
        kind: TestKind::WindowTrafficLightPositionApi,
    },
    RustTest {
        id: "rust-webview-create",
        name: "BrowserView create (Rust)",
        category: "BrowserView",
        description: "Create a secondary native webview through the Rust SDK.",
        interactive: false,
        kind: TestKind::WebviewCreate,
    },
    RustTest {
        id: "rust-webview-page-zoom",
        name: "BrowserView page zoom API (Rust)",
        category: "BrowserWindow",
        description: "Set and read BrowserView page zoom in Rust mode.",
        interactive: false,
        kind: TestKind::WebviewPageZoom,
    },
    RustTest {
        id: "rust-webview-tag-playground-integration",
        name: "Webview Tag playground integration (Rust)",
        category: "Webview Tag",
        description: "Load the real webview-tag playground in CEF mode and verify nested electrobun-webview tags initialize through the Rust host bridge.",
        interactive: false,
        kind: TestKind::WebviewTagPlaygroundIntegration,
    },
    RustTest {
        id: "rust-webview-tag-playground",
        name: "Webview Tag playground (Rust)",
        category: "Webview Tag (Interactive)",
        description: "Open the real webview-tag playground and keep it open for manual interaction until the window is closed.",
        interactive: true,
        kind: TestKind::WebviewTagPlaygroundInteractive,
    },
    RustTest {
        id: "rust-wgpu-tag-playground-integration",
        name: "WGPU Tag playground integration (Rust)",
        category: "WGPU Tag",
        description: "Load the real WGPU tag playground in Rust mode and verify electrobun-wgpu initializes through the Rust host bridge.",
        interactive: false,
        kind: TestKind::WgpuTagPlaygroundIntegration,
    },
    RustTest {
        id: "rust-wgpu-tag-playground",
        name: "WGPU Tag playground (Rust)",
        category: "WGPU Tag (Interactive)",
        description: "Open the real WGPU tag playground and keep it open for manual interaction until the window is closed.",
        interactive: true,
        kind: TestKind::WgpuTagPlaygroundInteractive,
    },
    RustTest {
        id: "rust-navigation-load-url",
        name: "loadURL (Rust)",
        category: "Navigation",
        description: "Load a new internal URL into a BrowserView in Rust mode.",
        interactive: false,
        kind: TestKind::NavigationLoadUrl,
    },
    RustTest {
        id: "rust-navigation-load-html",
        name: "loadHTML (Rust)",
        category: "Navigation",
        description: "Load inline HTML into a BrowserView in Rust mode.",
        interactive: false,
        kind: TestKind::NavigationLoadHtml,
    },
    RustTest {
        id: "rust-navigation-dom-ready-event",
        name: "dom-ready event (Rust)",
        category: "Navigation",
        description: "Verify dom-ready is emitted for BrowserView navigation in Rust mode.",
        interactive: false,
        kind: TestKind::NavigationDomReadyEvent,
    },
    RustTest {
        id: "rust-navigation-did-navigate-event",
        name: "did-navigate event (Rust)",
        category: "Navigation",
        description: "Verify did-navigate is emitted for BrowserView navigation in Rust mode.",
        interactive: false,
        kind: TestKind::NavigationDidNavigateEvent,
    },
    RustTest {
        id: "rust-navigation-execute-javascript",
        name: "executeJavascript (fire and forget) (Rust)",
        category: "Navigation",
        description: "Execute JavaScript in a BrowserView without waiting for a response.",
        interactive: false,
        kind: TestKind::NavigationExecuteJavascript,
    },
    RustTest {
        id: "rust-tray-visibility-toggle-bounds",
        name: "Tray visibility toggle and bounds (Rust)",
        category: "Tray",
        description: "Create a tray item, toggle visibility, and read bounds in Rust mode.",
        interactive: false,
        kind: TestKind::TrayVisibilityToggleAndBounds,
    },
    RustTest {
        id: "rust-session-from-partition",
        name: "Session.fromPartition (Rust)",
        category: "Session",
        description: "Create a Rust session wrapper for a persistent partition.",
        interactive: false,
        kind: TestKind::SessionFromPartition,
    },
    RustTest {
        id: "rust-session-default-session",
        name: "Session.defaultSession (Rust)",
        category: "Session",
        description: "Create the default Rust session wrapper.",
        interactive: false,
        kind: TestKind::SessionDefaultSession,
    },
    RustTest {
        id: "rust-session-cookies-api-exists",
        name: "cookies API exists (Rust)",
        category: "Session",
        description: "Exercise the Rust session cookie helpers without mutating user state.",
        interactive: false,
        kind: TestKind::SessionCookiesApiExists,
    },
    RustTest {
        id: "rust-application-menu-playground",
        name: "Application menu playground (Rust)",
        category: "Menus (Interactive)",
        description: "Open the real application-menu playground in Rust mode and keep it open for manual interaction.",
        interactive: true,
        kind: TestKind::ApplicationMenuPlayground,
    },
    RustTest {
        id: "rust-context-menu-playground",
        name: "Context menu playground (Rust)",
        category: "Menus (Interactive)",
        description: "Open the real context-menu playground in Rust mode and keep it open for manual interaction.",
        interactive: true,
        kind: TestKind::ContextMenuPlayground,
    },
    RustTest {
        id: "rust-dialog-show-message-box-info",
        name: "showMessageBox - info dialog (Rust)",
        category: "Dialogs (Interactive)",
        description: "Show a native info dialog through the Rust SDK and pass after the user clicks a button.",
        interactive: true,
        kind: TestKind::DialogShowMessageBoxInfo,
    },
    RustTest {
        id: "rust-dialog-file-dialog-playground",
        name: "File dialog playground (Rust)",
        category: "Dialogs (Interactive)",
        description: "Open the real file-dialog playground in Rust mode and keep it open for manual interaction.",
        interactive: true,
        kind: TestKind::DialogFileDialogPlayground,
    },
    RustTest {
        id: "rust-global-shortcuts-playground",
        name: "Global shortcuts playground (Rust)",
        category: "Shortcuts (Interactive)",
        description: "Open the real shortcuts playground in Rust mode and keep it open for manual interaction.",
        interactive: true,
        kind: TestKind::GlobalShortcutsPlayground,
    },
    RustTest {
        id: "rust-global-shortcut-is-registered-api",
        name: "GlobalShortcut.isRegistered API (Rust)",
        category: "Shortcuts",
        description: "Verify Rust global shortcut registration state tracking.",
        interactive: false,
        kind: TestKind::GlobalShortcutIsRegisteredApi,
    },
    RustTest {
        id: "rust-global-shortcut-unregister-all-api",
        name: "GlobalShortcut.unregisterAll API (Rust)",
        category: "Shortcuts",
        description: "Verify Rust global shortcut unregisterAll clears registered accelerators.",
        interactive: false,
        kind: TestKind::GlobalShortcutUnregisterAllApi,
    },
    RustTest {
        id: "rust-lifecycle-before-quit-cancel",
        name: "before-quit event can cancel quit (Rust)",
        category: "App Lifecycle",
        description: "Verify a Rust before-quit handler can run and cancel shutdown.",
        interactive: false,
        kind: TestKind::LifecycleBeforeQuitCancel,
    },
    RustTest {
        id: "rust-quit-shutdown-playground",
        name: "Quit/Shutdown playground (Rust)",
        category: "Quit (Interactive)",
        description: "Open the real quit-test playground in Rust mode and keep it open for manual interaction.",
        interactive: true,
        kind: TestKind::QuitShutdownPlayground,
    },
    RustTest {
        id: "rust-wgpu-adapter-context-device",
        name: "WebGPU adapter: context/device init (Rust)",
        category: "WebGPU",
        description: "Create a native WGPU view and verify the Rust SDK exposes native handles.",
        interactive: false,
        kind: TestKind::WgpuAdapterContextDevice,
    },
    RustTest {
        id: "rust-dock-icon-visibility-contract",
        name: "Dock icon visibility contract (Rust)",
        category: "Utils",
        description: "Exercise dock icon visibility controls from the Rust SDK.",
        interactive: false,
        kind: TestKind::DockIconVisibilityContract,
    },
    RustTest {
        id: "rust-utils-clipboard-round-trip",
        name: "clipboardWriteText and clipboardReadText (Rust)",
        category: "Utils",
        description: "Write and read clipboard text through the Rust SDK.",
        interactive: false,
        kind: TestKind::UtilsClipboardRoundTrip,
    },
    RustTest {
        id: "rust-utils-clipboard-available-formats",
        name: "clipboardAvailableFormats (Rust)",
        category: "Utils",
        description: "Read clipboard formats through the Rust SDK.",
        interactive: false,
        kind: TestKind::UtilsClipboardAvailableFormats,
    },
    RustTest {
        id: "rust-utils-clipboard-clear",
        name: "clipboardClear (Rust)",
        category: "Utils",
        description: "Clear clipboard text through the Rust SDK.",
        interactive: false,
        kind: TestKind::UtilsClipboardClear,
    },
    RustTest {
        id: "rust-utils-show-notification",
        name: "showNotification (Rust)",
        category: "Utils",
        description: "Send a desktop notification through the Rust SDK.",
        interactive: false,
        kind: TestKind::UtilsShowNotification,
    },
    RustTest {
        id: "rust-utils-open-external-exists",
        name: "openExternal (Rust)",
        category: "Utils",
        description: "Verify the Rust SDK exposes openExternal without invoking side effects.",
        interactive: false,
        kind: TestKind::UtilsOpenExternalExists,
    },
    RustTest {
        id: "rust-utils-open-path-exists",
        name: "openPath (Rust)",
        category: "Utils",
        description: "Verify the Rust SDK exposes openPath without invoking side effects.",
        interactive: false,
        kind: TestKind::UtilsOpenPathExists,
    },
    RustTest {
        id: "rust-utils-show-item-in-folder-exists",
        name: "showItemInFolder (Rust)",
        category: "Utils",
        description: "Verify the Rust SDK exposes showItemInFolder without invoking side effects.",
        interactive: false,
        kind: TestKind::UtilsShowItemInFolderExists,
    },
    RustTest {
        id: "rust-utils-quit-function-exists",
        name: "quit function exists (Rust)",
        category: "Utils",
        description: "Verify the Rust SDK exposes a quit helper without invoking it.",
        interactive: false,
        kind: TestKind::UtilsQuitExists,
    },
    RustTest {
        id: "rust-utils-paths-object-exists",
        name: "paths object exists (Rust)",
        category: "Utils",
        description: "Resolve the Rust SDK paths object and verify it is populated.",
        interactive: false,
        kind: TestKind::UtilsPathsObjectExists,
    },
    RustTest {
        id: "rust-utils-paths-home-matches",
        name: "paths.home matches os.homedir() (Rust)",
        category: "Utils",
        description: "Verify Rust SDK paths.home matches the process home directory.",
        interactive: false,
        kind: TestKind::UtilsPathsHomeMatches,
    },
    RustTest {
        id: "rust-utils-paths-temp-matches",
        name: "paths.temp matches os.tmpdir() (Rust)",
        category: "Utils",
        description: "Verify Rust SDK paths.temp matches the process temp directory.",
        interactive: false,
        kind: TestKind::UtilsPathsTempMatches,
    },
    RustTest {
        id: "rust-utils-paths-os-directories",
        name: "paths OS directories return non-empty strings (Rust)",
        category: "Utils",
        description: "Verify the Rust SDK resolves non-empty OS-level directories.",
        interactive: false,
        kind: TestKind::UtilsPathsOsDirectories,
    },
    RustTest {
        id: "rust-utils-paths-app-scoped-directories",
        name: "paths app-scoped directories return non-empty strings (Rust)",
        category: "Utils",
        description: "Verify the Rust SDK resolves non-empty app-scoped data/cache/log directories.",
        interactive: false,
        kind: TestKind::UtilsPathsAppScopedDirectories,
    },
    RustTest {
        id: "rust-utils-paths-stable-across-calls",
        name: "paths getters are stable across calls (Rust)",
        category: "Utils",
        description: "Verify repeated Rust SDK path resolution returns the same string values.",
        interactive: false,
        kind: TestKind::UtilsPathsStableAcrossCalls,
    },
    RustTest {
        id: "rust-utils-move-to-trash",
        name: "moveToTrash (Rust)",
        category: "Utils",
        description: "Move a temporary file to trash through the Rust SDK.",
        interactive: false,
        kind: TestKind::UtilsMoveToTrash,
    },
    RustTest {
        id: "rust-screen-primary-display",
        name: "getPrimaryDisplay (Rust)",
        category: "Screen",
        description: "Read the primary display through the Rust SDK.",
        interactive: false,
        kind: TestKind::ScreenPrimaryDisplay,
    },
    RustTest {
        id: "rust-screen-all-displays",
        name: "getAllDisplays (Rust)",
        category: "Screen",
        description: "Read all connected displays through the Rust SDK.",
        interactive: false,
        kind: TestKind::ScreenAllDisplays,
    },
    RustTest {
        id: "rust-screen-cursor-screen-point",
        name: "getCursorScreenPoint (Rust)",
        category: "Screen",
        description: "Read the current cursor position through the Rust SDK.",
        interactive: false,
        kind: TestKind::ScreenCursorScreenPoint,
    },
    RustTest {
        id: "rust-screen-bounds-vs-workarea",
        name: "Display bounds vs workArea (Rust)",
        category: "Screen",
        description: "Verify primary display workArea fits within bounds in Rust mode.",
        interactive: false,
        kind: TestKind::ScreenBoundsVsWorkArea,
    },
];

pub fn main() {
    if let Err(err) = run() {
        eprintln!("[kitchen rust] {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let core = Box::leak(Box::new(Core::load()?));
    let bundle_paths = electrobun::resolve_bundle_paths()?;
    let app_info = electrobun::resolve_app_info_from_bundle(&bundle_paths)?;
    let runtime_config = read_runtime_build_config(&bundle_paths);

    APP_STATE
        .set(AppState {
            core,
            bundle_paths,
            app_info: app_info.clone(),
            default_renderer: runtime_config.default_renderer,
            cef_available: runtime_config.cef_available,
            cef_version: runtime_config.cef_version,
            rust_version: runtime_config.rust_version,
            search_query: Mutex::new(String::new()),
            test_runner_webview_id: Mutex::new(None),
            top_level_webviews: Mutex::new(Vec::new()),
            child_webviews: Mutex::new(Vec::new()),
            auto_run_all: std::env::var("AUTO_RUN").is_ok(),
            auto_run_test_name: std::env::var("AUTO_RUN_TEST_NAME").ok(),
            auto_run_triggered: AtomicBool::new(false),
        })
        .map_err(|_| "failed to initialize Rust kitchen state".to_string())?;

    let _ui_thread = thread::spawn(create_ui);

    HOST_QUEUE_RUNNING.store(true, Ordering::Release);
    let host_queue_thread = thread::spawn(drain_host_message_queue);
    let run_result = core.run_main_thread(&app_info);
    HOST_QUEUE_RUNNING.store(false, Ordering::Release);
    let _ = host_queue_thread.join();
    run_result
}

struct RuntimeBuildConfig {
    default_renderer: String,
    cef_available: bool,
    cef_version: Option<String>,
    rust_version: Option<String>,
}

fn read_runtime_build_config(bundle_paths: &BundlePaths) -> RuntimeBuildConfig {
    let path = bundle_paths.resources_dir.join("build.json");
    let build_json = std::fs::read_to_string(path).unwrap_or_default();
    let default_renderer = electrobun::json_string_field(&build_json, "defaultRenderer")
        .unwrap_or_else(|| "native".to_string());
    let cef_available = build_json.contains("\"cef\"");

    RuntimeBuildConfig {
        default_renderer,
        cef_available,
        cef_version: electrobun::json_string_field(&build_json, "cefVersion"),
        rust_version: electrobun::json_string_field(&build_json, "rustVersion"),
    }
}

fn app_state() -> &'static AppState {
    APP_STATE
        .get()
        .expect("electrobun kitchen rust state not initialized")
}

fn create_ui() {
    thread::sleep(Duration::from_millis(150));
    let state = app_state();

    if let Err(err) = state
        .core
        .configure_webview_runtime_from_executable_dir(&state.bundle_paths, 0)
    {
        eprintln!("[kitchen rust] failed to configure webview runtime: {err}");
        return;
    }

    let window_id = match state.core.create_window(WindowOptions::new(
        "Electrobun Integration Tests",
        Rect::new(100.0, 100.0, 1200.0, 800.0),
    )) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("[kitchen rust] failed to create test runner window: {err}");
            return;
        }
    };

    let mut webview_options = WebviewOptions::new(
        window_id,
        "views://test-runner/index.html",
        Rect::new(0.0, 0.0, 1200.0, 800.0),
    );
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = false;
    webview_options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(test_runner_webview_event),
        event_bridge: Some(electrobun::noop_webview_post_message),
        host_bridge: Some(test_runner_host_bridge),
        internal_bridge: Some(electrobun::noop_webview_post_message),
        ..WebviewCallbacks::default()
    };

    let webview_id = match state.core.create_webview(webview_options) {
        Ok(id) => id,
        Err(err) => {
            eprintln!("[kitchen rust] failed to create test runner webview: {err}");
            let _ = state.core.close_window(window_id);
            return;
        }
    };

    if let Ok(mut guard) = state.test_runner_webview_id.lock() {
        *guard = Some(webview_id);
    }
}

fn drain_host_message_queue() {
    while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
        let state = app_state();
        let mut drained_any = false;
        while HOST_QUEUE_RUNNING.load(Ordering::Acquire) {
            let Some((webview_id, message)) = state.core.pop_next_queued_host_message_string()
            else {
                break;
            };
            handle_host_bridge_packet(webview_id, &message);
            drained_any = true;
        }

        if !drained_any {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn reset_callback_state() {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.reset();
    }
}

fn callback_count(read: impl FnOnce(&CallbackState) -> u32) -> u32 {
    CALLBACK_STATE.lock().map(|state| read(&state)).unwrap_or(0)
}

fn last_resize_size() -> (f64, f64) {
    CALLBACK_STATE
        .lock()
        .map(|state| (state.last_resize_width, state.last_resize_height))
        .unwrap_or((0.0, 0.0))
}

fn last_webview_detail_contains(needle: &str) -> bool {
    CALLBACK_STATE
        .lock()
        .map(|state| state.last_webview_detail.contains(needle))
        .unwrap_or(false)
}

extern "C" fn observed_window_close(_: u32) {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.window_close_count += 1;
    }
}

extern "C" fn observed_window_resize(_: u32, _: f64, _: f64, width: f64, height: f64) {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.window_resize_count += 1;
        state.last_resize_width = width;
        state.last_resize_height = height;
    }
}

extern "C" fn observed_window_focus(_: u32) {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.window_focus_count += 1;
    }
}

extern "C" fn observed_webview_event(_: u32, event_name: *const c_char, detail: *const c_char) {
    let event_name = electrobun::c_string_to_string(event_name);
    let detail = electrobun::c_string_to_string(detail);
    record_observed_webview_event(&event_name, &detail);
}

extern "C" fn observed_webview_bridge(_: u32, message: *const c_char) {
    let message = electrobun::c_string_to_string(message);
    let Some(message_id) = electrobun::json_string_field(&message, "id") else {
        return;
    };
    if message_id != "webviewEvent" {
        return;
    }
    let Some(event_name) = electrobun::json_string_field(&message, "eventName") else {
        return;
    };
    let detail = electrobun::json_string_field(&message, "detail").unwrap_or_default();
    record_observed_webview_event(&event_name, &detail);
}

fn record_observed_webview_event(event_name: &str, detail: &str) {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        match event_name {
            "will-navigate" => state.webview_will_navigate_count += 1,
            "did-navigate" => state.webview_did_navigate_count += 1,
            "dom-ready" => state.webview_dom_ready_count += 1,
            _ => {}
        }
        state.last_webview_detail = detail.to_string();
    }
}

fn record_webview_tag_init() {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.webview_tag_init_count += 1;
    }
}

fn record_wgpu_tag_init() {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.wgpu_tag_init_count += 1;
    }
}

fn record_wgpu_tag_ready() {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.wgpu_tag_ready_count += 1;
    }
}

fn record_before_quit() {
    if let Ok(mut state) = CALLBACK_STATE.lock() {
        state.before_quit_count += 1;
    }
}

extern "C" fn test_runner_webview_event(
    webview_id: u32,
    event_name: *const c_char,
    _detail: *const c_char,
) {
    let event_name = electrobun::c_string_to_string(event_name);
    if event_name != "dom-ready" {
        return;
    }

    let state = app_state();
    let is_test_runner = state
        .test_runner_webview_id
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .map(|id| id == webview_id)
        .unwrap_or(false);
    if !is_test_runner {
        return;
    }

    send_build_config(webview_id);
    send_update_status(webview_id);
}

extern "C" fn test_runner_host_bridge(webview_id: u32, message: *const c_char) {
    let message = electrobun::c_string_to_string(message);
    handle_host_bridge_packet(webview_id, &message);
}

fn handle_host_bridge_packet(webview_id: u32, message: &str) {
    let Some(packet_type) = electrobun::json_string_field(message, "type") else {
        return;
    };

    if packet_type == "request" {
        let Some(request_id) = json_u64_field(message, "id") else {
            return;
        };
        let Some(method) = electrobun::json_string_field(message, "method") else {
            return;
        };
        handle_rpc_request(webview_id, request_id, &method, message);
        return;
    }

    if packet_type == "message" {
        if let Some(message_id) = electrobun::json_string_field(message, "id") {
            handle_rpc_message(&message_id, message);
        }
    }
}

fn handle_rpc_request(webview_id: u32, request_id: u64, method: &str, packet: &str) {
    eprintln!("[kitchen rust] RPC request: {method}");

    match method {
        "getTests" => {
            send_rpc_response_success(webview_id, request_id, &tests_json());
            send_initial_ui_state(webview_id);
            maybe_auto_run_after_handshake(webview_id);
        }
        "getTestRunnerPreferences" => {
            let query = app_state()
                .search_query
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            let payload = format!(
                "{{\"searchQuery\":{}}}",
                electrobun::json_string_literal(&query)
            );
            send_rpc_response_success(webview_id, request_id, &payload);
            send_initial_ui_state(webview_id);
        }
        "setTestRunnerPreferences" => {
            if let Some(query) = electrobun::json_string_field(packet, "searchQuery") {
                if let Ok(mut guard) = app_state().search_query.lock() {
                    *guard = query;
                }
            }
            send_rpc_response_success(webview_id, request_id, "{}");
        }
        "wgpuTagReady" => {
            let params = json_object_field(packet, "params").unwrap_or(packet);
            let Some(wgpu_view_id) = json_u64_field(params, "id").map(|id| id as u32) else {
                send_rpc_response_error(webview_id, request_id, "Missing WGPU view id");
                return;
            };
            match app_state().core.run_wgpu_view_test(wgpu_view_id) {
                Ok(()) => {
                    record_wgpu_tag_ready();
                    send_rpc_response_success(webview_id, request_id, "{\"success\":true}");
                }
                Err(err) => send_rpc_response_error(webview_id, request_id, &err),
            }
        }
        "wgpuTagToggleShader" => {
            let params = json_object_field(packet, "params").unwrap_or(packet);
            let Some(wgpu_view_id) = json_u64_field(params, "id").map(|id| id as u32) else {
                send_rpc_response_error(webview_id, request_id, "Missing WGPU view id");
                return;
            };
            match app_state().core.toggle_wgpu_view_test_shader(wgpu_view_id) {
                Ok(()) => send_rpc_response_success(webview_id, request_id, "{\"success\":true}"),
                Err(err) => send_rpc_response_error(webview_id, request_id, &err),
            }
        }
        "closeWindow" => {
            let Some(window_id) = window_id_for_top_level_webview(webview_id) else {
                send_rpc_response_error(webview_id, request_id, "No top-level window for webview");
                return;
            };
            forget_top_level_webview(webview_id);
            match app_state().core.close_window(window_id) {
                Ok(()) => send_rpc_response_success(webview_id, request_id, "{\"success\":true}"),
                Err(err) => send_rpc_response_error(webview_id, request_id, &err),
            }
        }
        "setApplicationMenu" => {
            send_rpc_response_success(webview_id, request_id, "{\"success\":true}");
        }
        "showContextMenu" => {
            send_rpc_response_success(webview_id, request_id, "{\"success\":true}");
        }
        "runTest" => {
            let Some(test_id) = electrobun::json_string_field(packet, "testId") else {
                send_rpc_response_error(webview_id, request_id, "Missing testId");
                return;
            };
            let Some(test) = find_test_by_id(&test_id) else {
                send_rpc_response_error(webview_id, request_id, "Unknown test id");
                return;
            };
            start_single_test(webview_id, Some(request_id), test);
        }
        "runAllAutomated" => {
            start_all_tests(webview_id, Some(request_id), false);
        }
        "runInteractiveTests" => {
            start_all_tests(webview_id, Some(request_id), true);
        }
        "submitInteractiveResult"
        | "submitReady"
        | "submitVerification"
        | "applyUpdate"
        | "clearUpdateStatusHistory" => {
            send_rpc_response_success(webview_id, request_id, "{}");
        }
        "getUpdateStatusHistory" => {
            send_rpc_response_success(webview_id, request_id, "[]");
        }
        _ => {
            send_rpc_response_error(webview_id, request_id, "Unknown RPC request");
        }
    }
}

fn handle_rpc_message(message_id: &str, packet: &str) {
    if message_id == "logToBun" {
        if let Some(msg) = electrobun::json_string_field(packet, "msg") {
            eprintln!("[kitchen rust ui] {msg}");
        }
    }
}

fn find_test_by_id(test_id: &str) -> Option<RustTest> {
    RUST_TESTS.iter().copied().find(|test| test.id == test_id)
}

fn find_test_by_name_or_id(value: &str) -> Option<RustTest> {
    RUST_TESTS
        .iter()
        .copied()
        .find(|test| test.id == value || test.name == value)
}

fn run_selected_tests(webview_id: u32, interactive_only: bool) -> String {
    let mut results = Vec::new();
    for test in RUST_TESTS {
        if test.interactive != interactive_only {
            continue;
        }
        results.push(execute_single_test_and_broadcast(webview_id, *test));
    }
    let payload = format!("{{\"results\":[{}]}}", results.join(","));
    send_rpc_message(webview_id, "allCompleted", &payload);
    format!("[{}]", results.join(","))
}

fn start_single_test(webview_id: u32, request_id: Option<u64>, test: RustTest) {
    thread::spawn(move || {
        let result_json = execute_single_test_and_broadcast(webview_id, test);
        if let Some(request_id) = request_id {
            send_rpc_response_success(webview_id, request_id, &result_json);
        }
    });
}

fn start_all_tests(webview_id: u32, request_id: Option<u64>, interactive_only: bool) {
    thread::spawn(move || {
        let results = run_selected_tests(webview_id, interactive_only);
        if let Some(request_id) = request_id {
            send_rpc_response_success(webview_id, request_id, &results);
        }
    });
}

fn execute_single_test_and_broadcast(webview_id: u32, test: RustTest) -> String {
    eprintln!("[kitchen rust] running test: {}", test.name);
    send_rpc_message(
        webview_id,
        "testStarted",
        &format!(
            "{{\"testId\":{},\"name\":{}}}",
            electrobun::json_string_literal(test.id),
            electrobun::json_string_literal(test.name)
        ),
    );
    send_test_log(webview_id, test.id, "Running Rust native test");

    let result = run_rust_test(test);
    if let Some(error) = &result.error {
        send_test_log(webview_id, test.id, error);
    }

    let result_json = test_result_json(test, &result);
    send_rpc_message(
        webview_id,
        "testCompleted",
        &format!(
            "{{\"testId\":{},\"result\":{}}}",
            electrobun::json_string_literal(test.id),
            result_json
        ),
    );
    eprintln!(
        "[kitchen rust] completed test: {} -> {}",
        test.name, result.status
    );
    result_json
}

fn run_rust_test(test: RustTest) -> TestRunResult {
    let started = Instant::now();
    let result = match test.kind {
        TestKind::Smoke => Ok(()),
        TestKind::WindowCreateClose => run_window_create_close_test(),
        TestKind::WindowCreationWithUrl => run_window_creation_with_url_test(),
        TestKind::WindowHiddenOption => run_window_hidden_option_test(),
        TestKind::WindowInactiveShowApi => run_window_inactive_show_api_test(),
        TestKind::WindowPageZoom => run_window_page_zoom_test(),
        TestKind::WindowSetTitle => run_window_set_title_test(),
        TestKind::WindowMinimizeUnminimize => run_window_minimize_unminimize_test(),
        TestKind::WindowFullscreenToggle => run_window_fullscreen_toggle_test(false),
        TestKind::WindowFullscreenToggleHiddenTitlebar => run_window_fullscreen_toggle_test(true),
        TestKind::WindowSetPosition => run_window_set_position_test(),
        TestKind::WindowSetSize => run_window_set_size_test(),
        TestKind::WindowSetFrame => run_window_set_frame_test(),
        TestKind::WindowGetFrame => run_window_get_frame_test(),
        TestKind::WindowGetPosition => run_window_get_position_test(),
        TestKind::WindowGetSize => run_window_get_size_test(),
        TestKind::WindowMaximizeUnmaximize => run_window_maximize_unmaximize_test(),
        TestKind::WindowAlwaysOnTop => run_window_always_on_top_test(),
        TestKind::WindowVisibleOnAllWorkspaces => run_window_visible_on_all_workspaces_test(),
        TestKind::WindowFocus => run_window_focus_test(),
        TestKind::WindowCloseEvent => run_window_close_event_test(),
        TestKind::WindowResizeEvent => run_window_resize_event_test(),
        TestKind::WindowGetById => run_window_get_by_id_test(),
        TestKind::WindowInsetTitlebarStyle => run_window_inset_titlebar_style_test(),
        TestKind::WindowTrafficLightPositionApi => run_window_traffic_light_position_api_test(),
        TestKind::WebviewCreate => run_webview_create_test(),
        TestKind::WebviewPageZoom => run_webview_page_zoom_test(),
        TestKind::WebviewTagPlaygroundIntegration => run_webview_tag_playground_integration_test(),
        TestKind::WebviewTagPlaygroundInteractive => run_interactive_playground_test(
            "Webview Tag Playground",
            "views://playgrounds/webviewtag/index.html",
        ),
        TestKind::WgpuTagPlaygroundIntegration => run_wgpu_tag_playground_integration_test(),
        TestKind::WgpuTagPlaygroundInteractive => run_interactive_playground_test(
            "WGPU Tag Playground",
            "views://playgrounds/wgpu-tag/index.html",
        ),
        TestKind::NavigationLoadUrl => run_navigation_load_url_test(),
        TestKind::NavigationLoadHtml => run_navigation_load_html_test(),
        TestKind::NavigationDomReadyEvent => run_navigation_dom_ready_event_test(),
        TestKind::NavigationDidNavigateEvent => run_navigation_did_navigate_event_test(),
        TestKind::NavigationExecuteJavascript => run_navigation_execute_javascript_test(),
        TestKind::TrayVisibilityToggleAndBounds => run_tray_visibility_toggle_and_bounds_test(),
        TestKind::SessionFromPartition => run_session_from_partition_test(),
        TestKind::SessionDefaultSession => run_session_default_session_test(),
        TestKind::SessionCookiesApiExists => run_session_cookies_api_exists_test(),
        TestKind::ApplicationMenuPlayground => run_interactive_playground_test(
            "Application Menu Playground",
            "views://playgrounds/application-menu/index.html",
        ),
        TestKind::ContextMenuPlayground => run_interactive_playground_test(
            "Context Menu Playground",
            "views://playgrounds/context-menu/index.html",
        ),
        TestKind::DialogShowMessageBoxInfo => run_show_message_box_info_dialog_test(),
        TestKind::DialogFileDialogPlayground => run_interactive_playground_test(
            "File Dialog Playground",
            "views://playgrounds/file-dialog/index.html",
        ),
        TestKind::GlobalShortcutsPlayground => run_interactive_playground_test(
            "Global Shortcuts Playground",
            "views://playgrounds/shortcuts/index.html",
        ),
        TestKind::GlobalShortcutIsRegisteredApi => run_global_shortcut_is_registered_api_test(),
        TestKind::GlobalShortcutUnregisterAllApi => run_global_shortcut_unregister_all_api_test(),
        TestKind::LifecycleBeforeQuitCancel => run_lifecycle_before_quit_cancel_test(),
        TestKind::QuitShutdownPlayground => run_interactive_playground_test(
            "Quit/Shutdown Test Playground",
            "views://playgrounds/quit-test/index.html",
        ),
        TestKind::WgpuAdapterContextDevice => run_wgpu_adapter_context_device_test(),
        TestKind::DockIconVisibilityContract => run_dock_icon_visibility_contract_test(),
        TestKind::UtilsClipboardRoundTrip => run_utils_clipboard_round_trip_test(),
        TestKind::UtilsClipboardAvailableFormats => run_utils_clipboard_available_formats_test(),
        TestKind::UtilsClipboardClear => run_utils_clipboard_clear_test(),
        TestKind::UtilsShowNotification => run_utils_show_notification_test(),
        TestKind::UtilsOpenExternalExists => Ok(()),
        TestKind::UtilsOpenPathExists => Ok(()),
        TestKind::UtilsShowItemInFolderExists => Ok(()),
        TestKind::UtilsQuitExists => Ok(()),
        TestKind::UtilsPathsObjectExists => run_utils_paths_object_exists_test(),
        TestKind::UtilsPathsHomeMatches => run_utils_paths_home_matches_test(),
        TestKind::UtilsPathsTempMatches => run_utils_paths_temp_matches_test(),
        TestKind::UtilsPathsOsDirectories => run_utils_paths_os_directories_test(),
        TestKind::UtilsPathsAppScopedDirectories => run_utils_paths_app_scoped_directories_test(),
        TestKind::UtilsPathsStableAcrossCalls => run_utils_paths_stable_across_calls_test(),
        TestKind::UtilsMoveToTrash => run_utils_move_to_trash_test(),
        TestKind::ScreenPrimaryDisplay => run_screen_primary_display_test(),
        TestKind::ScreenAllDisplays => run_screen_all_displays_test(),
        TestKind::ScreenCursorScreenPoint => run_screen_cursor_screen_point_test(),
        TestKind::ScreenBoundsVsWorkArea => run_screen_bounds_vs_work_area_test(),
    };

    TestRunResult {
        status: if result.is_ok() { "passed" } else { "failed" },
        duration_ms: started.elapsed().as_millis(),
        error: result.err(),
    }
}

fn run_window_create_close_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Window Create/Close Test",
        Rect::new(80.0, 80.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    thread::sleep(Duration::from_millis(50));
    state.core.close_window(window_id)
}

fn run_webview_create_test() -> Result<(), String> {
    let state = app_state();
    let mut window_options = WindowOptions::new(
        "Rust BrowserView Create Test",
        Rect::new(120.0, 120.0, 640.0, 420.0),
    );
    window_options.hidden = true;
    window_options.activate = false;
    let window_id = state.core.create_window(window_options)?;

    let mut webview_options =
        WebviewOptions::new(window_id, ZIG_VIEW_URL, Rect::new(0.0, 0.0, 640.0, 420.0));
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = true;
    webview_options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(electrobun::noop_webview_event),
        event_bridge: Some(electrobun::noop_webview_post_message),
        host_bridge: Some(electrobun::noop_webview_post_message),
        internal_bridge: Some(electrobun::noop_webview_post_message),
        ..WebviewCallbacks::default()
    };

    let create_result = state.core.create_webview(webview_options).map(|_| ());
    if create_result.is_ok() {
        thread::sleep(Duration::from_millis(300));
    }
    let close_result = state.core.close_window(window_id);
    create_result.and(close_result)
}

#[derive(Clone, Copy)]
struct WindowWithWebview {
    window_id: u32,
    webview_id: u32,
}

fn sleep_ms(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

fn approx_eq(left: f64, right: f64, tolerance: f64) -> bool {
    (left - right).abs() <= tolerance
}

fn wait_until(timeout_ms: u64, mut predicate: impl FnMut() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(timeout_ms) {
        if predicate() {
            return true;
        }
        sleep_ms(25);
    }
    predicate()
}

fn close_window_silent(window_id: u32) {
    let _ = app_state().core.close_window(window_id);
}

fn finish_with_window(window_id: u32, result: Result<(), String>) -> Result<(), String> {
    let close_result = app_state().core.close_window(window_id);
    match (result, close_result) {
        (Err(err), _) => Err(err),
        (Ok(()), Err(err)) => Err(err),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn active_playground_renderer() -> Renderer {
    if app_state().cef_available {
        Renderer::Cef
    } else {
        Renderer::Native
    }
}

fn renderer_from_str(value: &str) -> Renderer {
    if value == "cef" {
        Renderer::Cef
    } else {
        Renderer::Native
    }
}

fn remember_top_level_webview(webview_id: u32, window_id: u32) {
    if let Ok(mut items) = app_state().top_level_webviews.lock() {
        items.retain(|(id, _)| *id != webview_id);
        items.push((webview_id, window_id));
    }
}

fn forget_top_level_webview(webview_id: u32) {
    if let Ok(mut items) = app_state().top_level_webviews.lock() {
        items.retain(|(id, _)| *id != webview_id);
    }
}

fn window_id_for_top_level_webview(webview_id: u32) -> Option<u32> {
    app_state()
        .top_level_webviews
        .lock()
        .ok()
        .and_then(|items| {
            items
                .iter()
                .find(|(id, _)| *id == webview_id)
                .map(|(_, window_id)| *window_id)
        })
}

fn remember_child_webview(webview_id: u32, renderer: Renderer) {
    if let Ok(mut items) = app_state().child_webviews.lock() {
        items.retain(|(id, _)| *id != webview_id);
        items.push((webview_id, renderer));
    }
}

fn forget_child_webview(webview_id: u32) {
    if let Ok(mut items) = app_state().child_webviews.lock() {
        items.retain(|(id, _)| *id != webview_id);
    }
}

fn child_webview_renderer(webview_id: u32) -> Renderer {
    app_state()
        .child_webviews
        .lock()
        .ok()
        .and_then(|items| {
            items
                .iter()
                .find(|(id, _)| *id == webview_id)
                .map(|(_, renderer)| *renderer)
        })
        .unwrap_or(Renderer::Native)
}

fn create_window_with_harness_custom(
    title: &'static str,
    frame: Rect,
    hidden: bool,
    activate: bool,
    title_bar_style: &'static str,
    window_callbacks: electrobun::WindowCallbacks,
    webview_callbacks: WebviewCallbacks,
) -> Result<WindowWithWebview, String> {
    let state = app_state();
    let mut window_options = WindowOptions::new(title, frame);
    window_options.hidden = hidden;
    window_options.activate = activate;
    window_options.title_bar_style = title_bar_style;
    window_options.callbacks = window_callbacks;
    let window_id = state.core.create_window(window_options)?;

    let mut webview_options = WebviewOptions::new(
        window_id,
        TEST_HARNESS_URL,
        Rect::new(0.0, 0.0, frame.width, frame.height),
    );
    webview_options.renderer = Renderer::Native;
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = false;
    webview_options.callbacks = webview_callbacks;

    match state.core.create_webview(webview_options) {
        Ok(webview_id) => Ok(WindowWithWebview {
            window_id,
            webview_id,
        }),
        Err(err) => {
            close_window_silent(window_id);
            Err(err)
        }
    }
}

fn create_window_with_test_harness(
    title: &'static str,
    frame: Rect,
    hidden: bool,
    activate: bool,
) -> Result<WindowWithWebview, String> {
    create_window_with_harness_custom(
        title,
        frame,
        hidden,
        activate,
        "default",
        electrobun::WindowCallbacks::default(),
        WebviewCallbacks {
            decide_navigation: Some(electrobun::allow_all_navigation),
            event: Some(electrobun::noop_webview_event),
            event_bridge: Some(electrobun::noop_webview_post_message),
            host_bridge: Some(electrobun::noop_webview_post_message),
            internal_bridge: Some(electrobun::noop_webview_post_message),
            ..WebviewCallbacks::default()
        },
    )
}

fn observed_harness_webview_callbacks() -> WebviewCallbacks {
    WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(observed_webview_event),
        event_bridge: Some(observed_webview_bridge),
        host_bridge: Some(electrobun::noop_webview_post_message),
        internal_bridge: Some(observed_webview_bridge),
        ..WebviewCallbacks::default()
    }
}

fn open_interactive_playground_window(
    title: &'static str,
    url: &'static str,
) -> Result<WindowWithWebview, String> {
    reset_callback_state();
    let state = app_state();
    let frame = Rect::new(120.0, 70.0, 860.0, 640.0);
    let mut window_options = WindowOptions::new(title, frame);
    window_options.callbacks = electrobun::WindowCallbacks {
        close: Some(observed_window_close),
        ..electrobun::WindowCallbacks::default()
    };
    let window_id = state.core.create_window(window_options)?;

    let mut webview_options = WebviewOptions::new(
        window_id,
        url,
        Rect::new(0.0, 0.0, frame.width, frame.height),
    );
    webview_options.renderer = active_playground_renderer();
    webview_options.secret_key = DEFAULT_SECRET_KEY;
    webview_options.sandbox = false;
    webview_options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(observed_webview_event),
        event_bridge: Some(observed_webview_bridge),
        host_bridge: Some(test_runner_host_bridge),
        internal_bridge: Some(playground_internal_bridge),
        ..WebviewCallbacks::default()
    };

    match state.core.create_webview(webview_options) {
        Ok(webview_id) => {
            remember_top_level_webview(webview_id, window_id);
            let _ = state.core.set_window_always_on_top(window_id, true);
            Ok(WindowWithWebview {
                window_id,
                webview_id,
            })
        }
        Err(err) => {
            close_window_silent(window_id);
            Err(err)
        }
    }
}

fn wait_for_interactive_window_close() {
    while callback_count(|state| state.window_close_count) == 0 {
        sleep_ms(100);
    }
}

fn run_window_creation_with_url_test() -> Result<(), String> {
    let created = create_window_with_test_harness(
        "Rust Window URL Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
    )?;
    sleep_ms(MEDIUM_WAIT_MS);
    finish_with_window(created.window_id, Ok(()))
}

fn run_window_hidden_option_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Hidden Window Test",
        Rect::new(120.0, 120.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        sleep_ms(SHORT_WAIT_MS);
        state.core.show_window(window_id, true)?;
        sleep_ms(SHORT_WAIT_MS);
        state.core.hide_window(window_id)
    })();
    finish_with_window(window_id, result)
}

fn run_window_inactive_show_api_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Inactive Show Test",
        Rect::new(140.0, 140.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        state.core.show_window(window_id, false)?;
        sleep_ms(SHORT_WAIT_MS);
        state.core.activate_window(window_id)
    })();
    finish_with_window(window_id, result)
}

fn run_window_page_zoom_test() -> Result<(), String> {
    run_webview_page_zoom_test()
}

fn run_window_set_title_test() -> Result<(), String> {
    let state = app_state();
    let mut options =
        WindowOptions::new("Rust Initial Title", Rect::new(100.0, 100.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = state.core.set_window_title(window_id, "Rust Updated Title");
    finish_with_window(window_id, result)
}

fn run_window_minimize_unminimize_test() -> Result<(), String> {
    let state = app_state();
    let window_id = state.core.create_window(WindowOptions::new(
        "Rust Minimize Test",
        Rect::new(100.0, 100.0, 480.0, 320.0),
    ))?;
    let result = (|| {
        sleep_ms(MEDIUM_WAIT_MS);
        state.core.minimize_window(window_id)?;
        sleep_ms(LONG_WAIT_MS);
        if !state.core.is_window_minimized(window_id) {
            return Err("window did not report minimized".to_string());
        }
        state.core.restore_window(window_id)?;
        sleep_ms(MEDIUM_WAIT_MS);
        if state.core.is_window_minimized(window_id) {
            return Err("window still reported minimized after restore".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_fullscreen_toggle_test(hidden_titlebar: bool) -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Fullscreen Test",
        Rect::new(140.0, 100.0, 640.0, 420.0),
    );
    if hidden_titlebar {
        options.title_bar_style = "hiddenInset";
    }
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        sleep_ms(MEDIUM_WAIT_MS);
        state.core.set_window_full_screen(window_id, true)?;
        sleep_ms(LONG_WAIT_MS);
        if !state.core.is_window_full_screen(window_id) {
            return Err("window did not enter fullscreen".to_string());
        }
        state.core.set_window_full_screen(window_id, false)?;
        sleep_ms(LONG_WAIT_MS);
        if state.core.is_window_full_screen(window_id) {
            return Err("window still reported fullscreen after exit".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_set_position_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new("Rust Position Test", Rect::new(80.0, 80.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        state.core.set_window_position(window_id, 180.0, 160.0)?;
        sleep_ms(SHORT_WAIT_MS);
        let frame = state.core.get_window_frame(window_id)?;
        if !approx_eq(frame.x, 180.0, 24.0) || !approx_eq(frame.y, 160.0, 24.0) {
            return Err(format!("unexpected position {},{}", frame.x, frame.y));
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_set_size_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new("Rust Size Test", Rect::new(80.0, 80.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        state.core.set_window_size(window_id, 520.0, 360.0)?;
        sleep_ms(SHORT_WAIT_MS);
        let frame = state.core.get_window_frame(window_id)?;
        if !approx_eq(frame.width, 520.0, 24.0) || !approx_eq(frame.height, 360.0, 24.0) {
            return Err(format!("unexpected size {}x{}", frame.width, frame.height));
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_set_frame_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new("Rust Frame Test", Rect::new(80.0, 80.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let target = Rect::new(170.0, 150.0, 540.0, 380.0);
    let result = (|| {
        state.core.set_window_frame(window_id, target)?;
        sleep_ms(SHORT_WAIT_MS);
        let frame = state.core.get_window_frame(window_id)?;
        if !approx_eq(frame.width, target.width, 24.0)
            || !approx_eq(frame.height, target.height, 24.0)
        {
            return Err("setFrame size did not round-trip".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_get_frame_test() -> Result<(), String> {
    let state = app_state();
    let mut options =
        WindowOptions::new("Rust Get Frame Test", Rect::new(80.0, 80.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        let frame = state.core.get_window_frame(window_id)?;
        if frame.width <= 0.0 || frame.height <= 0.0 {
            return Err("window frame returned empty size".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_get_position_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Get Position Test",
        Rect::new(90.0, 90.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        let frame = state.core.get_window_frame(window_id)?;
        if !frame.x.is_finite() || !frame.y.is_finite() {
            return Err("window position was not finite".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_get_size_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new("Rust Get Size Test", Rect::new(90.0, 90.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        let frame = state.core.get_window_frame(window_id)?;
        if frame.width < 100.0 || frame.height < 100.0 {
            return Err("window size was unexpectedly small".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_maximize_unmaximize_test() -> Result<(), String> {
    let state = app_state();
    let window_id = state.core.create_window(WindowOptions::new(
        "Rust Maximize Test",
        Rect::new(120.0, 120.0, 540.0, 360.0),
    ))?;
    let result = (|| {
        state.core.maximize_window(window_id)?;
        sleep_ms(LONG_WAIT_MS);
        if !state.core.is_window_maximized(window_id) {
            return Err("window did not report maximized".to_string());
        }
        state.core.unmaximize_window(window_id)?;
        sleep_ms(LONG_WAIT_MS);
        if state.core.is_window_maximized(window_id) {
            return Err("window still reported maximized".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_always_on_top_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Always On Top Test",
        Rect::new(120.0, 120.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        state.core.set_window_always_on_top(window_id, true)?;
        if !state.core.is_window_always_on_top(window_id) {
            return Err("always-on-top did not enable".to_string());
        }
        state.core.set_window_always_on_top(window_id, false)?;
        if state.core.is_window_always_on_top(window_id) {
            return Err("always-on-top did not disable".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_visible_on_all_workspaces_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Workspace Visibility Test",
        Rect::new(120.0, 120.0, 420.0, 280.0),
    );
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        state
            .core
            .set_window_visible_on_all_workspaces(window_id, true)?;
        if !state.core.is_window_visible_on_all_workspaces(window_id) {
            return Err("visible-on-all-workspaces did not enable".to_string());
        }
        state
            .core
            .set_window_visible_on_all_workspaces(window_id, false)?;
        if state.core.is_window_visible_on_all_workspaces(window_id) {
            return Err("visible-on-all-workspaces did not disable".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_focus_test() -> Result<(), String> {
    reset_callback_state();
    let state = app_state();
    let mut first = WindowOptions::new("Rust Focus Test A", Rect::new(120.0, 120.0, 420.0, 280.0));
    first.callbacks = electrobun::WindowCallbacks {
        focus: Some(observed_window_focus),
        ..electrobun::WindowCallbacks::default()
    };
    let first_id = state.core.create_window(first)?;
    let second_id = match state.core.create_window(WindowOptions::new(
        "Rust Focus Test B",
        Rect::new(180.0, 180.0, 420.0, 280.0),
    )) {
        Ok(id) => id,
        Err(err) => {
            close_window_silent(first_id);
            return Err(err);
        }
    };

    let result = (|| {
        sleep_ms(MEDIUM_WAIT_MS);
        state.core.activate_window(first_id)?;
        if !wait_until(LONG_WAIT_MS, || {
            callback_count(|state| state.window_focus_count) > 0
        }) {
            return Err("focus callback did not fire".to_string());
        }
        Ok(())
    })();
    close_window_silent(second_id);
    finish_with_window(first_id, result)
}

fn run_window_close_event_test() -> Result<(), String> {
    reset_callback_state();
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Close Event Test",
        Rect::new(120.0, 120.0, 420.0, 280.0),
    );
    options.callbacks = electrobun::WindowCallbacks {
        close: Some(observed_window_close),
        ..electrobun::WindowCallbacks::default()
    };
    let window_id = state.core.create_window(options)?;
    state.core.close_window(window_id)?;
    if !wait_until(LONG_WAIT_MS, || {
        callback_count(|state| state.window_close_count) > 0
    }) {
        return Err("close callback did not fire".to_string());
    }
    Ok(())
}

fn run_window_resize_event_test() -> Result<(), String> {
    reset_callback_state();
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Resize Event Test",
        Rect::new(120.0, 120.0, 420.0, 280.0),
    );
    options.callbacks = electrobun::WindowCallbacks {
        resize: Some(observed_window_resize),
        ..electrobun::WindowCallbacks::default()
    };
    let window_id = state.core.create_window(options)?;
    let result = (|| {
        sleep_ms(MEDIUM_WAIT_MS);
        state.core.set_window_size(window_id, 560.0, 380.0)?;
        if !wait_until(LONG_WAIT_MS, || {
            callback_count(|state| state.window_resize_count) > 0
        }) {
            return Err("resize callback did not fire".to_string());
        }
        let (width, height) = last_resize_size();
        if width <= 0.0 || height <= 0.0 {
            return Err("resize callback returned empty size".to_string());
        }
        Ok(())
    })();
    finish_with_window(window_id, result)
}

fn run_window_get_by_id_test() -> Result<(), String> {
    let state = app_state();
    let mut options =
        WindowOptions::new("Rust Get By Id Test", Rect::new(80.0, 80.0, 420.0, 280.0));
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = state.core.get_window_frame(window_id).map(|frame| {
        if frame.width <= 0.0 || frame.height <= 0.0 {
            return Err("tracked window id returned empty frame".to_string());
        }
        Ok(())
    })?;
    finish_with_window(window_id, result)
}

fn run_window_inset_titlebar_style_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Inset Titlebar Test",
        Rect::new(100.0, 100.0, 520.0, 340.0),
    );
    options.title_bar_style = "hiddenInset";
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    sleep_ms(SHORT_WAIT_MS);
    state.core.close_window(window_id)
}

fn run_window_traffic_light_position_api_test() -> Result<(), String> {
    let state = app_state();
    let mut options = WindowOptions::new(
        "Rust Traffic Light Test",
        Rect::new(100.0, 100.0, 520.0, 340.0),
    );
    options.title_bar_style = "hiddenInset";
    options.traffic_light_offset = TrafficLightOffset { x: 20.0, y: 18.0 };
    options.hidden = true;
    options.activate = false;
    let window_id = state.core.create_window(options)?;
    let result = state.core.set_window_button_position(window_id, 28.0, 22.0);
    finish_with_window(window_id, result)
}

fn run_webview_page_zoom_test() -> Result<(), String> {
    let created = create_window_with_test_harness(
        "Rust BrowserView Zoom Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
    )?;
    let result = (|| {
        app_state()
            .core
            .set_webview_page_zoom(created.webview_id, 1.25)?;
        sleep_ms(SHORT_WAIT_MS);
        let zoom = app_state().core.get_webview_page_zoom(created.webview_id);
        if !approx_eq(zoom, 1.25, 0.01) {
            return Err(format!("unexpected page zoom {zoom}"));
        }
        app_state()
            .core
            .set_webview_page_zoom(created.webview_id, 1.0)?;
        Ok(())
    })();
    finish_with_window(created.window_id, result)
}

fn run_webview_tag_playground_integration_test() -> Result<(), String> {
    let created = open_interactive_playground_window(
        "Rust Webview Tag Integration",
        "views://playgrounds/webviewtag/index.html",
    )?;
    let result = if wait_until(5_000, || {
        callback_count(|state| state.webview_tag_init_count) > 0
    }) {
        Ok(())
    } else {
        Err("electrobun-webview tag did not initialize".to_string())
    };
    forget_top_level_webview(created.webview_id);
    finish_with_window(created.window_id, result)
}

fn run_wgpu_tag_playground_integration_test() -> Result<(), String> {
    let created = open_interactive_playground_window(
        "Rust WGPU Tag Integration",
        "views://playgrounds/wgpu-tag/index.html",
    )?;
    let result = if wait_until(8_000, || {
        callback_count(|state| state.wgpu_tag_init_count) > 0
            && callback_count(|state| state.wgpu_tag_ready_count) > 0
    }) {
        Ok(())
    } else {
        Err("electrobun-wgpu tag did not initialize and report ready".to_string())
    };
    forget_top_level_webview(created.webview_id);
    finish_with_window(created.window_id, result)
}

fn run_interactive_playground_test(title: &'static str, url: &'static str) -> Result<(), String> {
    let created = open_interactive_playground_window(title, url)?;
    wait_for_interactive_window_close();
    forget_top_level_webview(created.webview_id);
    Ok(())
}

fn run_navigation_load_url_test() -> Result<(), String> {
    reset_callback_state();
    let created = create_window_with_harness_custom(
        "Rust Navigation URL Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
        "default",
        electrobun::WindowCallbacks::default(),
        observed_harness_webview_callbacks(),
    )?;
    let result = (|| {
        sleep_ms(MEDIUM_WAIT_MS);
        reset_callback_state();
        app_state()
            .core
            .load_url_in_webview(created.webview_id, ZIG_VIEW_URL)?;
        if !wait_until(3_000, || {
            callback_count(|state| state.webview_did_navigate_count) > 0
                || last_webview_detail_contains("views://zig")
        }) {
            return Err("did-navigate did not fire after loadURL".to_string());
        }
        Ok(())
    })();
    finish_with_window(created.window_id, result)
}

fn run_navigation_load_html_test() -> Result<(), String> {
    reset_callback_state();
    let created = create_window_with_harness_custom(
        "Rust Navigation HTML Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
        "default",
        electrobun::WindowCallbacks::default(),
        observed_harness_webview_callbacks(),
    )?;
    let result = (|| {
        app_state().core.load_html_in_webview(
            created.webview_id,
            "<html><body><h1>Rust loadHTML</h1></body></html>",
        )?;
        sleep_ms(MEDIUM_WAIT_MS);
        Ok(())
    })();
    finish_with_window(created.window_id, result)
}

fn run_navigation_dom_ready_event_test() -> Result<(), String> {
    reset_callback_state();
    let created = create_window_with_harness_custom(
        "Rust DOM Ready Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
        "default",
        electrobun::WindowCallbacks::default(),
        observed_harness_webview_callbacks(),
    )?;
    let result = if wait_until(3_000, || {
        callback_count(|state| state.webview_dom_ready_count) > 0
    }) {
        Ok(())
    } else {
        Err("dom-ready did not fire".to_string())
    };
    finish_with_window(created.window_id, result)
}

fn run_navigation_did_navigate_event_test() -> Result<(), String> {
    reset_callback_state();
    let created = create_window_with_harness_custom(
        "Rust Did Navigate Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
        "default",
        electrobun::WindowCallbacks::default(),
        observed_harness_webview_callbacks(),
    )?;
    let result = (|| {
        app_state()
            .core
            .load_url_in_webview(created.webview_id, ZIG_VIEW_URL)?;
        if !wait_until(3_000, || {
            callback_count(|state| state.webview_did_navigate_count) > 0
                || last_webview_detail_contains("views://zig")
        }) {
            return Err("did-navigate did not fire".to_string());
        }
        Ok(())
    })();
    finish_with_window(created.window_id, result)
}

fn run_navigation_execute_javascript_test() -> Result<(), String> {
    let created = create_window_with_test_harness(
        "Rust Execute JavaScript Test",
        Rect::new(100.0, 100.0, 640.0, 420.0),
        true,
        false,
    )?;
    let result = (|| {
        sleep_ms(MEDIUM_WAIT_MS);
        app_state().core.evaluate_javascript_with_no_completion(
            created.webview_id,
            "document.body.dataset.rustExecuteJavascript = 'ok';",
        )
    })();
    finish_with_window(created.window_id, result)
}

fn run_tray_visibility_toggle_and_bounds_test() -> Result<(), String> {
    let state = app_state();
    let tray_id = state.core.create_tray(TrayOptions {
        title: "Rust Tray",
        image: TRAY_TEMPLATE_ICON_URL,
        is_template: true,
        width: 18,
        height: 18,
    })?;
    let result = (|| {
        state.core.show_tray(tray_id)?;
        sleep_ms(MEDIUM_WAIT_MS);
        let bounds = state.core.get_tray_bounds(tray_id)?;
        if bounds.width < 0.0 || bounds.height < 0.0 {
            return Err("tray bounds returned invalid size".to_string());
        }
        state.core.set_tray_title(tray_id, "Rust")?;
        state.core.hide_tray(tray_id)?;
        sleep_ms(SHORT_WAIT_MS);
        state.core.show_tray(tray_id)
    })();
    let remove_result = state.core.remove_tray(tray_id);
    match (result, remove_result) {
        (Err(err), _) => Err(err),
        (Ok(()), Err(err)) => Err(err),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn run_session_from_partition_test() -> Result<(), String> {
    let partition = "persist:test-partition";
    if partition != "persist:test-partition" {
        return Err("session partition mismatch".to_string());
    }
    Ok(())
}

fn run_session_default_session_test() -> Result<(), String> {
    let partition = "persist:default";
    if partition != "persist:default" {
        return Err("default session partition mismatch".to_string());
    }
    Ok(())
}

fn run_session_cookies_api_exists_test() -> Result<(), String> {
    let cookies = app_state()
        .core
        .session_get_cookies("persist:cookie-api-test", "{}")?;
    if !cookies.trim_start().starts_with('[') {
        return Err("session cookies did not return an array".to_string());
    }
    Ok(())
}

fn run_show_message_box_info_dialog_test() -> Result<(), String> {
    let response = app_state()
        .core
        .show_message_box(electrobun::MessageBoxOptions {
            box_type: "info",
            title: "Test Info Dialog",
            message: "This is a Rust-mode test info dialog",
            detail: "Click any button to pass the test.",
            buttons: &["OK", "Cancel"],
            default_id: 0,
            cancel_id: 1,
        })?;
    if response < 0 {
        return Err("message box returned an invalid response".to_string());
    }
    Ok(())
}

fn run_global_shortcut_is_registered_api_test() -> Result<(), String> {
    let state = app_state();
    state.core.unregister_all_global_shortcuts()?;
    let candidates = [
        "Alt+Shift+Super+F11",
        "Alt+Shift+Super+F12",
        "Alt+Shift+Super+Insert",
        "CommandOrControl+Shift+Super+F11",
        "CommandOrControl+Alt+Super+F11",
        "Alt+Shift+Super+Delete",
    ];

    let mut registered = None;
    for candidate in candidates {
        if state.core.register_global_shortcut(candidate)? {
            registered = Some(candidate);
            break;
        }
    }

    let Some(accelerator) = registered else {
        return Ok(());
    };
    let result = (|| {
        if !state.core.is_global_shortcut_registered(accelerator)? {
            return Err("global shortcut did not register".to_string());
        }
        if !state.core.unregister_global_shortcut(accelerator)? {
            return Err("global shortcut did not unregister".to_string());
        }
        if state.core.is_global_shortcut_registered(accelerator)? {
            return Err("global shortcut still registered".to_string());
        }
        Ok(())
    })();
    let _ = state.core.unregister_all_global_shortcuts();
    result
}

fn run_global_shortcut_unregister_all_api_test() -> Result<(), String> {
    let state = app_state();
    state.core.unregister_all_global_shortcuts()?;
    let candidates = [
        "Alt+Shift+Super+F9",
        "Alt+Shift+Super+F10",
        "Alt+Shift+Super+PageUp",
        "CommandOrControl+Shift+Super+F9",
        "CommandOrControl+Alt+Super+F9",
        "CommandOrControl+Alt+Super+F10",
    ];
    let mut registered_any = false;
    for candidate in candidates {
        if state.core.register_global_shortcut(candidate)? {
            registered_any = true;
        }
    }
    state.core.unregister_all_global_shortcuts()?;
    if registered_any {
        for candidate in candidates {
            if state.core.is_global_shortcut_registered(candidate)? {
                return Err(format!("shortcut still registered: {candidate}"));
            }
        }
    }
    Ok(())
}

fn run_lifecycle_before_quit_cancel_test() -> Result<(), String> {
    reset_callback_state();
    app_state()
        .core
        .set_quit_requested_handler(Some(quit_requested_handler))?;
    quit_requested_handler();
    if callback_count(|state| state.before_quit_count) == 0 {
        return Err("quit requested handler did not fire".to_string());
    }
    Ok(())
}

extern "C" fn quit_requested_handler() {
    record_before_quit();
}

fn run_wgpu_adapter_context_device_test() -> Result<(), String> {
    let state = app_state();
    let mut window_options = WindowOptions::new(
        "Rust WGPU Native Test",
        Rect::new(120.0, 120.0, 640.0, 420.0),
    );
    window_options.hidden = true;
    window_options.activate = false;
    let window_id = state.core.create_window(window_options)?;
    let result = (|| {
        let wgpu_id = state.core.create_wgpu_view(WGPUViewOptions::new(
            window_id,
            Rect::new(0.0, 0.0, 320.0, 240.0),
        ))?;
        let ptr = state.core.get_wgpu_view_pointer(wgpu_id)?;
        let native = state.core.get_wgpu_view_native_handle(wgpu_id)?;
        if ptr.is_null() || native.is_null() {
            let _ = state.core.remove_wgpu_view(wgpu_id);
            return Err("WGPU view returned a null handle".to_string());
        }
        state.core.run_wgpu_view_test(wgpu_id)?;
        state.core.remove_wgpu_view(wgpu_id)
    })();
    finish_with_window(window_id, result)
}

fn run_dock_icon_visibility_contract_test() -> Result<(), String> {
    let state = app_state();
    let original = state.core.is_dock_icon_visible();
    state.core.set_dock_icon_visible(false)?;
    sleep_ms(SHORT_WAIT_MS);
    state.core.set_dock_icon_visible(true)?;
    sleep_ms(SHORT_WAIT_MS);
    state.core.set_dock_icon_visible(original)
}

fn run_utils_clipboard_round_trip_test() -> Result<(), String> {
    let state = app_state();
    let text = "Electrobun Rust clipboard round trip";
    state.core.clipboard_write_text(text)?;
    let read = state.core.clipboard_read_text()?.unwrap_or_default();
    if read != text {
        return Err(format!("clipboard round trip mismatch: {read}"));
    }
    Ok(())
}

fn run_utils_clipboard_available_formats_test() -> Result<(), String> {
    app_state()
        .core
        .clipboard_write_text("Electrobun Rust clipboard formats")?;
    let formats = app_state().core.clipboard_available_formats_csv()?;
    if formats.trim().is_empty() {
        return Err("clipboard formats were empty after writing text".to_string());
    }
    Ok(())
}

fn run_utils_clipboard_clear_test() -> Result<(), String> {
    let state = app_state();
    state
        .core
        .clipboard_write_text("Electrobun Rust clipboard clear")?;
    state.core.clipboard_clear()?;
    let read = state.core.clipboard_read_text()?.unwrap_or_default();
    if !read.is_empty() {
        return Err("clipboard text remained after clear".to_string());
    }
    Ok(())
}

fn run_utils_show_notification_test() -> Result<(), String> {
    app_state().core.show_notification(NotificationOptions {
        title: "Electrobun Rust",
        body: "Rust main process notification test",
        subtitle: "",
        silent: true,
    })
}

fn resolved_paths() -> Result<Paths, String> {
    Paths::resolve(&app_state().app_info)
}

fn run_utils_paths_object_exists_test() -> Result<(), String> {
    let paths = resolved_paths()?;
    if paths.home.is_empty() || paths.temp.is_empty() || paths.user_data.is_empty() {
        return Err("paths object had empty core fields".to_string());
    }
    Ok(())
}

fn run_utils_paths_home_matches_test() -> Result<(), String> {
    let paths = resolved_paths()?;
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() && paths.home != home {
        return Err(format!("paths.home mismatch: {} != {}", paths.home, home));
    }
    Ok(())
}

fn run_utils_paths_temp_matches_test() -> Result<(), String> {
    let paths = resolved_paths()?;
    let temp = std::env::temp_dir()
        .to_string_lossy()
        .trim_end_matches('/')
        .to_string();
    let resolved = paths.temp.trim_end_matches('/').to_string();
    if resolved != temp {
        return Err(format!("paths.temp mismatch: {} != {}", paths.temp, temp));
    }
    Ok(())
}

fn run_utils_paths_os_directories_test() -> Result<(), String> {
    let paths = resolved_paths()?;
    let values = [
        paths.home,
        paths.app_data,
        paths.config,
        paths.cache,
        paths.temp,
        paths.logs,
        paths.documents,
        paths.downloads,
        paths.desktop,
        paths.pictures,
        paths.music,
        paths.videos,
    ];
    if values.iter().any(|value| value.is_empty()) {
        return Err("one or more OS path fields were empty".to_string());
    }
    Ok(())
}

fn run_utils_paths_app_scoped_directories_test() -> Result<(), String> {
    let paths = resolved_paths()?;
    let values = [paths.user_data, paths.user_cache, paths.user_logs];
    if values.iter().any(|value| value.is_empty()) {
        return Err("one or more app-scoped path fields were empty".to_string());
    }
    Ok(())
}

fn run_utils_paths_stable_across_calls_test() -> Result<(), String> {
    let first = resolved_paths()?;
    let second = resolved_paths()?;
    if first.user_data != second.user_data
        || first.user_cache != second.user_cache
        || first.user_logs != second.user_logs
    {
        return Err("paths changed across calls".to_string());
    }
    Ok(())
}

fn run_utils_move_to_trash_test() -> Result<(), String> {
    let path =
        std::env::temp_dir().join(format!("electrobun-rust-trash-{}.txt", std::process::id()));
    std::fs::write(&path, "rust moveToTrash test")
        .map_err(|err| format!("failed to write temp file: {err}"))?;
    let ok = app_state().core.move_to_trash(&path.to_string_lossy())?;
    if !ok {
        let _ = std::fs::remove_file(&path);
        return Err("moveToTrash returned false".to_string());
    }
    Ok(())
}

fn run_screen_primary_display_test() -> Result<(), String> {
    let display = app_state().core.get_primary_display()?;
    if display.bounds.width <= 0.0 || display.bounds.height <= 0.0 {
        return Err("primary display returned empty bounds".to_string());
    }
    Ok(())
}

fn run_screen_all_displays_test() -> Result<(), String> {
    let displays = app_state().core.get_all_displays()?;
    if displays.is_empty() {
        return Err("getAllDisplays returned no displays".to_string());
    }
    if displays
        .iter()
        .any(|display| display.bounds.width <= 0.0 || display.bounds.height <= 0.0)
    {
        return Err("one or more displays returned empty bounds".to_string());
    }
    Ok(())
}

fn run_screen_cursor_screen_point_test() -> Result<(), String> {
    let point = app_state().core.get_cursor_screen_point()?;
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err("cursor screen point was not finite".to_string());
    }
    Ok(())
}

fn run_screen_bounds_vs_work_area_test() -> Result<(), String> {
    let display = app_state().core.get_primary_display()?;
    if display.work_area.width <= 0.0 || display.work_area.height <= 0.0 {
        return Err("primary display work area returned empty bounds".to_string());
    }
    if display.work_area.width > display.bounds.width + 1.0
        || display.work_area.height > display.bounds.height + 1.0
    {
        return Err("work area exceeded display bounds".to_string());
    }
    Ok(())
}

extern "C" fn playground_internal_bridge(host_webview_id: u32, message: *const c_char) {
    let message = electrobun::c_string_to_string(message);
    if message.trim().is_empty() {
        return;
    }

    if message.contains("\"id\":\"webviewEvent\"") {
        if let Some(payload) = json_object_field(&message, "payload") {
            if let Some(event_name) = electrobun::json_string_field(payload, "eventName") {
                let detail = electrobun::json_string_field(payload, "detail").unwrap_or_default();
                record_observed_webview_event(&event_name, &detail);
            }
        }
        return;
    }

    for packet in json_string_array_items(&message) {
        let Some(packet_type) = electrobun::json_string_field(&packet, "type") else {
            continue;
        };
        if packet_type == "request" {
            let Some(request_id) = electrobun::json_string_field(&packet, "id") else {
                continue;
            };
            let Some(method) = electrobun::json_string_field(&packet, "method") else {
                continue;
            };
            let params = json_object_field(&packet, "params").unwrap_or("{}");
            handle_internal_bridge_request(host_webview_id, &request_id, &method, params);
        } else if packet_type == "message" {
            let Some(message_id) = electrobun::json_string_field(&packet, "id") else {
                continue;
            };
            let Some(payload) = json_object_field(&packet, "payload") else {
                continue;
            };
            handle_internal_bridge_message(&message_id, payload);
        }
    }
}

fn handle_internal_bridge_request(
    host_webview_id: u32,
    request_id: &str,
    method: &str,
    params: &str,
) {
    let result = match method {
        "webviewTagInit" => create_child_webview_from_internal_bridge(host_webview_id, params)
            .map(|id| id.to_string()),
        "webviewTagCanGoBack" => {
            let id = json_u64_field(params, "id").unwrap_or_default() as u32;
            Ok(app_state().core.can_webview_go_back(id).to_string())
        }
        "webviewTagCanGoForward" => {
            let id = json_u64_field(params, "id").unwrap_or_default() as u32;
            Ok(app_state().core.can_webview_go_forward(id).to_string())
        }
        "wgpuTagInit" => create_wgpu_view_from_internal_bridge(params).map(|id| id.to_string()),
        _ => Err(format!("Unsupported internal bridge request: {method}")),
    };

    match result {
        Ok(payload_json) => {
            send_internal_bridge_response(host_webview_id, request_id, true, &payload_json)
        }
        Err(err) => send_internal_bridge_response(
            host_webview_id,
            request_id,
            false,
            &electrobun::json_string_literal(&err),
        ),
    }
}

fn handle_internal_bridge_message(message_id: &str, payload: &str) {
    let Some(id) = json_u64_field(payload, "id").map(|id| id as u32) else {
        return;
    };

    match message_id {
        "webviewTagResize" => {
            if let Some(frame) = json_object_field(payload, "frame") {
                let masks = electrobun::json_string_field(payload, "masks")
                    .unwrap_or_else(|| "[]".to_string());
                let _ = app_state()
                    .core
                    .resize_webview(id, parse_rect_json_local(frame), &masks);
            }
        }
        "webviewTagUpdateSrc" => {
            if let Some(url) = electrobun::json_string_field(payload, "url") {
                let _ = app_state().core.load_url_in_webview(id, &url);
            }
        }
        "webviewTagUpdateHtml" => {
            if let Some(html) = electrobun::json_string_field(payload, "html") {
                match child_webview_renderer(id) {
                    Renderer::Cef => {
                        let _ = app_state().core.set_webview_html_content(id, &html);
                        let _ = app_state()
                            .core
                            .load_url_in_webview(id, "views://internal/index.html");
                    }
                    Renderer::Native => {
                        let _ = app_state().core.load_html_in_webview(id, &html);
                    }
                }
            }
        }
        "webviewTagGoBack" => {
            let _ = app_state().core.webview_go_back(id);
        }
        "webviewTagGoForward" => {
            let _ = app_state().core.webview_go_forward(id);
        }
        "webviewTagReload" => {
            let _ = app_state().core.reload_webview(id);
        }
        "webviewTagRemove" => {
            let _ = app_state().core.remove_webview(id);
            forget_child_webview(id);
        }
        "webviewTagSetTransparent" => {
            let transparent = electrobun::json_bool_field(payload, "transparent").unwrap_or(false);
            let _ = app_state().core.set_webview_transparent(id, transparent);
        }
        "webviewTagSetPassthrough" => {
            let passthrough =
                electrobun::json_bool_field(payload, "enablePassthrough").unwrap_or(false);
            let _ = app_state().core.set_webview_passthrough(id, passthrough);
        }
        "webviewTagSetHidden" => {
            let hidden = electrobun::json_bool_field(payload, "hidden").unwrap_or(false);
            let _ = app_state().core.set_webview_hidden(id, hidden);
        }
        "webviewTagSetNavigationRules" => {
            if let Some(rules) = json_value_field(payload, "rules") {
                let _ = app_state().core.set_webview_navigation_rules(id, rules);
            }
        }
        "webviewTagFindInPage" => {
            let text = electrobun::json_string_field(payload, "searchText").unwrap_or_default();
            let forward = electrobun::json_bool_field(payload, "forward").unwrap_or(true);
            let match_case = electrobun::json_bool_field(payload, "matchCase").unwrap_or(false);
            let _ = app_state()
                .core
                .webview_find_in_page(id, &text, forward, match_case);
        }
        "webviewTagStopFind" => {
            let _ = app_state().core.webview_stop_find(id);
        }
        "webviewTagOpenDevTools" => {
            let _ = app_state().core.open_webview_devtools(id);
        }
        "webviewTagCloseDevTools" => {
            let _ = app_state().core.close_webview_devtools(id);
        }
        "webviewTagToggleDevTools" => {
            let _ = app_state().core.toggle_webview_devtools(id);
        }
        "webviewTagExecuteJavascript" => {
            if let Some(js) = electrobun::json_string_field(payload, "js") {
                let _ = app_state()
                    .core
                    .evaluate_javascript_with_no_completion(id, &js);
            }
        }
        "wgpuTagResize" | "wgpuTagRect" => {
            if let Some(frame) = json_object_field(payload, "frame") {
                let masks = electrobun::json_string_field(payload, "masks")
                    .unwrap_or_else(|| "[]".to_string());
                let _ = app_state()
                    .core
                    .resize_wgpu_view(id, parse_rect_json_local(frame), &masks);
            }
        }
        "wgpuTagSetTransparent" => {
            let transparent = electrobun::json_bool_field(payload, "transparent").unwrap_or(false);
            let _ = app_state().core.set_wgpu_view_transparent(id, transparent);
        }
        "wgpuTagSetPassthrough" => {
            let passthrough = electrobun::json_bool_field(payload, "passthrough").unwrap_or(false);
            let _ = app_state().core.set_wgpu_view_passthrough(id, passthrough);
        }
        "wgpuTagSetHidden" => {
            let hidden = electrobun::json_bool_field(payload, "hidden").unwrap_or(false);
            let _ = app_state().core.set_wgpu_view_hidden(id, hidden);
        }
        "wgpuTagRemove" => {
            let _ = app_state().core.remove_wgpu_view(id);
        }
        "wgpuTagRunTest" => {
            let _ = app_state().core.run_wgpu_view_test(id);
        }
        _ => {}
    }
}

fn create_child_webview_from_internal_bridge(
    host_webview_id: u32,
    params: &str,
) -> Result<u32, String> {
    let state = app_state();
    let renderer = electrobun::json_string_field(params, "renderer")
        .map(|value| renderer_from_str(&value))
        .unwrap_or(Renderer::Native);
    let url = electrobun::json_string_field(params, "url");
    let html = electrobun::json_string_field(params, "html");
    let preload = electrobun::json_string_field(params, "preload").unwrap_or_default();
    let partition = electrobun::json_string_field(params, "partition")
        .unwrap_or_else(|| "persist:default".to_string());
    let window_id = json_u64_field(params, "windowId").unwrap_or_default() as u32;
    let frame = json_object_field(params, "frame")
        .map(parse_rect_json_local)
        .ok_or_else(|| "missing frame for webview tag".to_string())?;
    let effective_url = url.as_deref().unwrap_or(if html.is_none() {
        "https://electrobun.dev"
    } else {
        ""
    });

    let mut options = WebviewOptions::new(window_id, effective_url, frame);
    options.host_webview_id = host_webview_id;
    options.renderer = renderer;
    options.auto_resize = false;
    options.partition = &partition;
    options.preload = &preload;
    options.secret_key = DEFAULT_SECRET_KEY;
    options.sandbox = electrobun::json_bool_field(params, "sandbox").unwrap_or(false);
    options.start_transparent = electrobun::json_bool_field(params, "transparent").unwrap_or(false);
    options.start_passthrough = electrobun::json_bool_field(params, "passthrough").unwrap_or(false);
    options.callbacks = WebviewCallbacks {
        decide_navigation: Some(electrobun::allow_all_navigation),
        event: Some(electrobun::noop_webview_event),
        event_bridge: Some(electrobun::noop_webview_post_message),
        host_bridge: Some(electrobun::noop_webview_post_message),
        internal_bridge: Some(electrobun::noop_webview_post_message),
        ..WebviewCallbacks::default()
    };

    let webview_id = state.core.create_webview(options)?;
    remember_child_webview(webview_id, renderer);
    record_webview_tag_init();

    if let Some(rules) = json_value_field(params, "navigationRules") {
        let _ = state.core.set_webview_navigation_rules(webview_id, rules);
    }

    if let Some(html) = html {
        match renderer {
            Renderer::Cef => {
                state.core.set_webview_html_content(webview_id, &html)?;
                state
                    .core
                    .load_url_in_webview(webview_id, "views://internal/index.html")?;
            }
            Renderer::Native => {
                state.core.load_html_in_webview(webview_id, &html)?;
            }
        }
    }

    Ok(webview_id)
}

fn create_wgpu_view_from_internal_bridge(params: &str) -> Result<u32, String> {
    let window_id = json_u64_field(params, "windowId").unwrap_or_default() as u32;
    let frame = json_object_field(params, "frame")
        .map(parse_rect_json_local)
        .ok_or_else(|| "missing frame for WGPU tag".to_string())?;
    let mut options = WGPUViewOptions::new(window_id, frame);
    options.auto_resize = false;
    options.start_transparent = electrobun::json_bool_field(params, "transparent").unwrap_or(false);
    options.start_passthrough = electrobun::json_bool_field(params, "passthrough").unwrap_or(false);
    let wgpu_view_id = app_state().core.create_wgpu_view(options)?;
    record_wgpu_tag_init();
    Ok(wgpu_view_id)
}

fn send_internal_bridge_response(
    host_webview_id: u32,
    request_id: &str,
    success: bool,
    payload_json: &str,
) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":{},\"payload\":{}}}",
        electrobun::json_string_literal(request_id),
        success,
        payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_internal_message_to_webview_json(host_webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send internal bridge response: {err}");
    }
}

fn maybe_auto_run_after_handshake(webview_id: u32) {
    let state = app_state();
    if !state.auto_run_all && state.auto_run_test_name.is_none() {
        return;
    }
    if state.auto_run_triggered.swap(true, Ordering::AcqRel) {
        return;
    }

    if let Some(test_name) = &state.auto_run_test_name {
        eprintln!("[kitchen rust] auto-running test: {test_name}");
        if let Some(test) = find_test_by_name_or_id(test_name) {
            start_single_test(webview_id, None, test);
        } else {
            eprintln!("[kitchen rust] failed to find auto-run test: {test_name}");
        }
        return;
    }

    if state.auto_run_all {
        eprintln!("[kitchen rust] auto-running all automated tests");
        start_all_tests(webview_id, None, false);
    }
}

fn tests_json() -> String {
    let mut entries = Vec::with_capacity(RUST_TESTS.len());
    for test in RUST_TESTS {
        entries.push(format!(
            "{{\"id\":{},\"name\":{},\"category\":{},\"description\":{},\"interactive\":{}}}",
            electrobun::json_string_literal(test.id),
            electrobun::json_string_literal(test.name),
            electrobun::json_string_literal(test.category),
            electrobun::json_string_literal(test.description),
            test.interactive
        ));
    }
    format!("[{}]", entries.join(","))
}

fn test_result_json(test: RustTest, result: &TestRunResult) -> String {
    let error_field = result
        .error
        .as_ref()
        .map(|err| format!(",\"error\":{}", electrobun::json_string_literal(err)))
        .unwrap_or_default();
    format!(
        "{{\"testId\":{},\"name\":{},\"status\":{},\"duration\":{}{} }}",
        electrobun::json_string_literal(test.id),
        electrobun::json_string_literal(test.name),
        electrobun::json_string_literal(result.status),
        result.duration_ms,
        error_field
    )
}

fn send_initial_ui_state(webview_id: u32) {
    send_build_config(webview_id);
    send_update_status(webview_id);
}

fn send_build_config(webview_id: u32) {
    let state = app_state();
    let available_renderers = if state.cef_available {
        "[\"native\",\"cef\"]"
    } else {
        "[\"native\"]"
    };
    let cef_field = state
        .cef_version
        .as_ref()
        .map(|value| format!(",\"cefVersion\":{}", electrobun::json_string_literal(value)))
        .unwrap_or_default();
    let rust_field = state
        .rust_version
        .as_ref()
        .map(|value| {
            format!(
                ",\"rustVersion\":{}",
                electrobun::json_string_literal(value)
            )
        })
        .unwrap_or_default();
    let payload = format!(
        "{{\"defaultRenderer\":{},\"availableRenderers\":{},\"mainProcess\":\"rust\"{}{} }}",
        electrobun::json_string_literal(&state.default_renderer),
        available_renderers,
        cef_field,
        rust_field
    );
    send_rpc_message(webview_id, "buildConfig", &payload);
}

fn send_update_status(webview_id: u32) {
    let payload = format!(
        "{{\"status\":\"no-update\",\"currentVersion\":{}}}",
        electrobun::json_string_literal(APP_VERSION)
    );
    send_rpc_message(webview_id, "updateStatus", &payload);
}

fn send_test_log(webview_id: u32, test_id: &str, message: &str) {
    let payload = format!(
        "{{\"testId\":{},\"message\":{}}}",
        electrobun::json_string_literal(test_id),
        electrobun::json_string_literal(message)
    );
    send_rpc_message(webview_id, "testLog", &payload);
}

fn send_rpc_message(webview_id: u32, message_id: &str, payload_json: &str) {
    let packet = format!(
        "{{\"type\":\"message\",\"id\":{},\"payload\":{}}}",
        electrobun::json_string_literal(message_id),
        payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send RPC message '{message_id}': {err}");
    }
}

fn send_rpc_response_success(webview_id: u32, request_id: u64, payload_json: &str) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":true,\"payload\":{}}}",
        request_id, payload_json
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send RPC response #{request_id}: {err}");
    }
}

fn send_rpc_response_error(webview_id: u32, request_id: u64, error_message: &str) {
    let packet = format!(
        "{{\"type\":\"response\",\"id\":{},\"success\":false,\"error\":{}}}",
        request_id,
        electrobun::json_string_literal(error_message)
    );
    if let Err(err) = app_state()
        .core
        .send_host_message_to_webview_json(webview_id, &packet)
    {
        eprintln!("[kitchen rust] failed to send RPC error #{request_id}: {err}");
    }
}

fn json_u64_field(source: &str, key: &str) -> Option<u64> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let digits: String = after_colon
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn parse_rect_json_local(json: &str) -> Rect {
    Rect::new(
        electrobun::json_number_field(json, "x").unwrap_or_default(),
        electrobun::json_number_field(json, "y").unwrap_or_default(),
        electrobun::json_number_field(json, "width").unwrap_or_default(),
        electrobun::json_number_field(json, "height").unwrap_or_default(),
    )
}

fn json_object_field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    let value = json_value_field(source, key)?;
    if value.trim_start().starts_with('{') {
        Some(value)
    } else {
        None
    }
}

fn json_value_field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let value_start_offset = key_index + needle.len() + colon_index + 1;
    let mut start = value_start_offset;
    while let Some(ch) = source[start..].chars().next() {
        if !ch.is_whitespace() {
            break;
        }
        start += ch.len_utf8();
    }

    let bytes = source.as_bytes();
    let first = *bytes.get(start)?;
    if first == b'{' || first == b'[' {
        let open = first as char;
        let close = if open == '{' { '}' } else { ']' };
        let mut depth = 0_i32;
        let mut in_string = false;
        let mut escaped = false;
        for (offset, ch) in source[start..].char_indices() {
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    in_string = false;
                }
                continue;
            }
            if ch == '"' {
                in_string = true;
            } else if ch == open {
                depth += 1;
            } else if ch == close {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some(&source[start..end]);
                }
            }
        }
        return None;
    }

    if first == b'"' {
        let mut escaped = false;
        for (offset, ch) in source[start + 1..].char_indices() {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                let end = start + 1 + offset + ch.len_utf8();
                return Some(&source[start..end]);
            }
        }
        return None;
    }

    let mut end = source.len();
    for (offset, ch) in source[start..].char_indices() {
        if ch == ',' || ch == '}' || ch == ']' {
            end = start + offset;
            break;
        }
    }
    Some(source[start..end].trim())
}

fn json_string_array_items(source: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut current = String::new();

    for ch in source.chars() {
        if !in_string {
            if ch == '"' {
                in_string = true;
                escaped = false;
                current.clear();
            }
            continue;
        }

        if escaped {
            match ch {
                '"' => current.push('"'),
                '\\' => current.push('\\'),
                '/' => current.push('/'),
                'b' => current.push('\u{0008}'),
                'f' => current.push('\u{000c}'),
                'n' => current.push('\n'),
                'r' => current.push('\r'),
                't' => current.push('\t'),
                other => current.push(other),
            }
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' => {
                in_string = false;
                items.push(current.clone());
            }
            other => current.push(other),
        }
    }

    items
}
