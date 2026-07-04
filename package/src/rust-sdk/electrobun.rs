use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;

#[cfg(unix)]
mod dynlib {
    use super::*;

    const RTLD_NOW: c_int = 2;

    #[cfg(target_os = "linux")]
    #[link(name = "dl")]
    unsafe extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlclose(handle: *mut c_void) -> c_int;
        fn dlerror() -> *const c_char;
    }

    #[cfg(not(target_os = "linux"))]
    unsafe extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlclose(handle: *mut c_void) -> c_int;
        fn dlerror() -> *const c_char;
    }

    pub struct DynamicLibrary {
        handle: *mut c_void,
    }

    unsafe impl Send for DynamicLibrary {}
    unsafe impl Sync for DynamicLibrary {}

    impl DynamicLibrary {
        pub fn open(path: &PathBuf) -> Result<Self, String> {
            let path = CString::new(path.to_string_lossy().as_bytes())
                .map_err(|_| format!("invalid dynamic library path: {}", path.display()))?;
            let handle = unsafe { dlopen(path.as_ptr(), RTLD_NOW) };
            if handle.is_null() {
                return Err(last_dl_error());
            }
            Ok(Self { handle })
        }

        pub fn symbol<T: Copy>(&self, name: &str) -> Result<T, String> {
            let name_c = CString::new(name)
                .map_err(|_| format!("invalid dynamic library symbol: {name}"))?;
            let ptr = unsafe { dlsym(self.handle, name_c.as_ptr()) };
            if ptr.is_null() {
                return Err(format!("missing core symbol {name}: {}", last_dl_error()));
            }
            Ok(unsafe { std::mem::transmute_copy(&ptr) })
        }
    }

    impl Drop for DynamicLibrary {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    dlclose(self.handle);
                }
            }
        }
    }

    fn last_dl_error() -> String {
        let ptr = unsafe { dlerror() };
        if ptr.is_null() {
            return "unknown dynamic loader error".to_string();
        }
        unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

#[cfg(windows)]
mod dynlib {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut c_void;
        fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const c_char) -> *mut c_void;
        fn FreeLibrary(h_lib_module: *mut c_void) -> i32;
    }

    pub struct DynamicLibrary {
        handle: *mut c_void,
    }

    unsafe impl Send for DynamicLibrary {}
    unsafe impl Sync for DynamicLibrary {}

    impl DynamicLibrary {
        pub fn open(path: &PathBuf) -> Result<Self, String> {
            let mut path_w: Vec<u16> = path.as_os_str().encode_wide().collect();
            path_w.push(0);
            let handle = unsafe { LoadLibraryW(path_w.as_ptr()) };
            if handle.is_null() {
                return Err(format!(
                    "failed to load dynamic library: {}",
                    path.display()
                ));
            }
            Ok(Self { handle })
        }

        pub fn symbol<T: Copy>(&self, name: &str) -> Result<T, String> {
            let name_c = CString::new(name)
                .map_err(|_| format!("invalid dynamic library symbol: {name}"))?;
            let ptr = unsafe { GetProcAddress(self.handle, name_c.as_ptr()) };
            if ptr.is_null() {
                return Err(format!("missing core symbol {name}"));
            }
            Ok(unsafe { std::mem::transmute_copy(&ptr) })
        }
    }

    impl Drop for DynamicLibrary {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    FreeLibrary(self.handle);
                }
            }
        }
    }
}

pub type WindowCloseHandler = extern "C" fn(u32);
pub type WindowMoveHandler = extern "C" fn(u32, f64, f64);
pub type WindowResizeHandler = extern "C" fn(u32, f64, f64, f64, f64);
pub type WindowFocusHandler = extern "C" fn(u32);
pub type WindowBlurHandler = extern "C" fn(u32);
pub type WindowKeyHandler = extern "C" fn(u32, u32, u32, u32, u32);
pub type DecideNavigationHandler = extern "C" fn(u32, *const c_char) -> u32;
pub type WebviewEventHandler = extern "C" fn(u32, *const c_char, *const c_char);
pub type WebviewPostMessageHandler = extern "C" fn(u32, *const c_char);
pub type StatusItemHandler = extern "C" fn(u32, *const c_char);
pub type GlobalShortcutHandler = extern "C" fn(*const c_char);
pub type QuitRequestedHandler = extern "C" fn();
pub type URLOpenHandler = extern "C" fn(*const c_char);
pub type AppReopenHandler = extern "C" fn();

#[derive(Clone, Copy)]
pub enum Renderer {
    Native,
    Cef,
}

impl Renderer {
    fn as_str(self) -> &'static str {
        match self {
            Renderer::Native => "native",
            Renderer::Cef => "cef",
        }
    }
}

#[derive(Clone)]
pub struct AppInfo {
    pub identifier: String,
    pub name: String,
    pub channel: String,
}

#[derive(Clone, Copy)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

impl Default for Rect {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        }
    }
}

#[derive(Default)]
pub struct WindowStyle {
    pub borderless: bool,
    pub titled: bool,
    pub closable: bool,
    pub miniaturizable: bool,
    pub resizable: bool,
    pub unified_title_and_toolbar: bool,
    pub full_screen: bool,
    pub full_size_content_view: bool,
    pub utility_window: bool,
    pub doc_modal_window: bool,
    pub nonactivating_panel: bool,
    pub hud_window: bool,
}

impl WindowStyle {
    pub fn standard() -> Self {
        Self {
            borderless: false,
            titled: true,
            closable: true,
            miniaturizable: true,
            resizable: true,
            unified_title_and_toolbar: false,
            full_screen: false,
            full_size_content_view: false,
            utility_window: false,
            doc_modal_window: false,
            nonactivating_panel: false,
            hud_window: false,
        }
    }
}

#[derive(Default)]
pub struct WindowCallbacks {
    pub close: Option<WindowCloseHandler>,
    pub move_handler: Option<WindowMoveHandler>,
    pub resize: Option<WindowResizeHandler>,
    pub focus: Option<WindowFocusHandler>,
    pub blur: Option<WindowBlurHandler>,
    pub key: Option<WindowKeyHandler>,
}

#[derive(Default)]
pub struct TrafficLightOffset {
    pub x: f64,
    pub y: f64,
}

pub struct WindowOptions<'a> {
    pub title: &'a str,
    pub frame: Rect,
    pub style: WindowStyle,
    pub title_bar_style: &'a str,
    pub transparent: bool,
    pub hidden: bool,
    pub activate: bool,
    pub traffic_light_offset: TrafficLightOffset,
    pub callbacks: WindowCallbacks,
}

impl<'a> WindowOptions<'a> {
    pub fn new(title: &'a str, frame: Rect) -> Self {
        Self {
            title,
            frame,
            style: WindowStyle::standard(),
            title_bar_style: "default",
            transparent: false,
            hidden: false,
            activate: true,
            traffic_light_offset: TrafficLightOffset::default(),
            callbacks: WindowCallbacks::default(),
        }
    }
}

#[derive(Default)]
pub struct WebviewCallbacks {
    pub decide_navigation: Option<DecideNavigationHandler>,
    pub event: Option<WebviewEventHandler>,
    pub event_bridge: Option<WebviewPostMessageHandler>,
    pub host_bridge: Option<WebviewPostMessageHandler>,
    pub bun_bridge: Option<WebviewPostMessageHandler>,
    pub internal_bridge: Option<WebviewPostMessageHandler>,
}

pub struct WebviewOptions<'a> {
    pub window_id: u32,
    pub host_webview_id: u32,
    pub renderer: Renderer,
    pub url: &'a str,
    pub frame: Rect,
    pub auto_resize: bool,
    pub partition: &'a str,
    pub callbacks: WebviewCallbacks,
    pub secret_key: &'a str,
    pub preload: &'a str,
    pub views_root: &'a str,
    pub sandbox: bool,
    pub start_transparent: bool,
    pub start_passthrough: bool,
}

impl<'a> WebviewOptions<'a> {
    pub fn new(window_id: u32, url: &'a str, frame: Rect) -> Self {
        Self {
            window_id,
            host_webview_id: 0,
            renderer: Renderer::Native,
            url,
            frame,
            auto_resize: true,
            partition: "persist:default",
            callbacks: WebviewCallbacks::default(),
            secret_key: "",
            preload: "",
            views_root: "",
            sandbox: true,
            start_transparent: false,
            start_passthrough: false,
        }
    }
}

pub struct WGPUViewOptions {
    pub window_id: u32,
    pub frame: Rect,
    pub auto_resize: bool,
    pub start_transparent: bool,
    pub start_passthrough: bool,
}

impl WGPUViewOptions {
    pub fn new(window_id: u32, frame: Rect) -> Self {
        Self {
            window_id,
            frame,
            auto_resize: true,
            start_transparent: false,
            start_passthrough: false,
        }
    }
}

pub struct TrayOptions<'a> {
    pub title: &'a str,
    pub image: &'a str,
    pub is_template: bool,
    pub width: u32,
    pub height: u32,
}

pub struct NotificationOptions<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub subtitle: &'a str,
    pub silent: bool,
}

pub struct MessageBoxOptions<'a> {
    pub box_type: &'a str,
    pub title: &'a str,
    pub message: &'a str,
    pub detail: &'a str,
    pub buttons: &'a [&'a str],
    pub default_id: c_int,
    pub cancel_id: c_int,
}

pub struct OpenFileDialogOptions<'a> {
    pub starting_folder: &'a str,
    pub allowed_file_types: &'a str,
    pub can_choose_files: bool,
    pub can_choose_directory: bool,
    pub allows_multiple_selection: bool,
}

#[derive(Clone, Copy, Default)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Default)]
pub struct Display {
    pub id: i64,
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Clone)]
pub struct Paths {
    pub home: String,
    pub app_data: String,
    pub config: String,
    pub cache: String,
    pub temp: String,
    pub logs: String,
    pub documents: String,
    pub downloads: String,
    pub desktop: String,
    pub pictures: String,
    pub music: String,
    pub videos: String,
    pub user_data: String,
    pub user_cache: String,
    pub user_logs: String,
}

impl Paths {
    pub fn resolve(app_info: &AppInfo) -> Result<Self, String> {
        let home = home_dir()?;
        let app_data = app_data_dir(&home);
        let config = config_dir(&home);
        let cache = cache_dir(&home);
        let temp = temp_dir();
        let logs = logs_dir(&home);
        let documents = user_dir(&home, "Documents");
        let downloads = user_dir(&home, "Downloads");
        let desktop = user_dir(&home, "Desktop");
        let pictures = user_dir(&home, "Pictures");
        let music = user_dir(&home, "Music");
        let videos = user_dir(&home, "Videos");
        let scoped = app_scoped_name(app_info);

        Ok(Self {
            home,
            user_data: join_path(&app_data, &scoped),
            user_cache: join_path(&cache, &scoped),
            user_logs: join_path(&logs, &scoped),
            app_data,
            config,
            cache,
            temp,
            logs,
            documents,
            downloads,
            desktop,
            pictures,
            music,
            videos,
        })
    }
}

pub struct BundlePaths {
    pub exe_dir: PathBuf,
    pub resources_dir: PathBuf,
}

pub fn resolve_bundle_paths() -> Result<BundlePaths, String> {
    let exe_path = std::env::current_exe()
        .map_err(|err| format!("failed to resolve executable path: {err}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "executable path has no parent".to_string())?
        .to_path_buf();
    let resources_dir = exe_dir.join("..").join("Resources");

    Ok(BundlePaths {
        exe_dir,
        resources_dir,
    })
}

pub fn resolve_app_info_from_bundle(bundle_paths: &BundlePaths) -> Result<AppInfo, String> {
    let version_json_path = bundle_paths.resources_dir.join("version.json");
    let version_json = fs::read_to_string(&version_json_path)
        .map_err(|err| format!("failed to read {}: {err}", version_json_path.display()))?;

    Ok(AppInfo {
        identifier: json_string_field(&version_json, "identifier")
            .unwrap_or_else(|| "sh.blackboard.electrobun".to_string()),
        name: json_string_field(&version_json, "name").unwrap_or_else(|| "Electrobun".to_string()),
        channel: json_string_field(&version_json, "channel").unwrap_or_else(|| "dev".to_string()),
    })
}

type LastErrorFn = unsafe extern "C" fn() -> *const c_char;
type RunMainThreadFn =
    unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, c_int) -> c_int;
type ConfigureWebviewRuntimeFn = unsafe extern "C" fn(u32, *const c_char, *const c_char) -> bool;
type GetWindowStyleFn = unsafe extern "C" fn(
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
) -> u32;
type CreateWindowFn = unsafe extern "C" fn(
    f64,
    f64,
    f64,
    f64,
    u32,
    *const c_char,
    bool,
    *const c_char,
    bool,
    bool,
    f64,
    f64,
    Option<WindowCloseHandler>,
    Option<WindowMoveHandler>,
    Option<WindowResizeHandler>,
    Option<WindowFocusHandler>,
    Option<WindowBlurHandler>,
    Option<WindowKeyHandler>,
) -> u32;
type CreateWebviewFn = unsafe extern "C" fn(
    u32,
    u32,
    *const c_char,
    *const c_char,
    f64,
    f64,
    f64,
    f64,
    bool,
    *const c_char,
    Option<DecideNavigationHandler>,
    Option<WebviewEventHandler>,
    Option<WebviewPostMessageHandler>,
    Option<WebviewPostMessageHandler>,
    Option<WebviewPostMessageHandler>,
    *const c_char,
    *const c_char,
    *const c_char,
    bool,
    bool,
    bool,
) -> u32;
type CreateWGPUViewFn = unsafe extern "C" fn(u32, f64, f64, f64, f64, bool, bool, bool) -> u32;
type SetWindowTitleFn = unsafe extern "C" fn(u32, *const c_char);
type MinimizeWindowFn = unsafe extern "C" fn(u32);
type RestoreWindowFn = unsafe extern "C" fn(u32);
type IsWindowMinimizedFn = unsafe extern "C" fn(u32) -> bool;
type MaximizeWindowFn = unsafe extern "C" fn(u32);
type UnmaximizeWindowFn = unsafe extern "C" fn(u32);
type IsWindowMaximizedFn = unsafe extern "C" fn(u32) -> bool;
type SetWindowFullScreenFn = unsafe extern "C" fn(u32, bool);
type IsWindowFullScreenFn = unsafe extern "C" fn(u32) -> bool;
type SetWindowAlwaysOnTopFn = unsafe extern "C" fn(u32, bool);
type IsWindowAlwaysOnTopFn = unsafe extern "C" fn(u32) -> bool;
type SetWindowVisibleOnAllWorkspacesFn = unsafe extern "C" fn(u32, bool);
type IsWindowVisibleOnAllWorkspacesFn = unsafe extern "C" fn(u32) -> bool;
type ShowWindowFn = unsafe extern "C" fn(u32, bool);
type ActivateWindowFn = unsafe extern "C" fn(u32);
type HideWindowFn = unsafe extern "C" fn(u32);
type SetWindowButtonPositionFn = unsafe extern "C" fn(u32, f64, f64);
type SetWindowPositionFn = unsafe extern "C" fn(u32, f64, f64);
type SetWindowSizeFn = unsafe extern "C" fn(u32, f64, f64);
type SetWindowFrameFn = unsafe extern "C" fn(u32, f64, f64, f64, f64);
type GetWindowFrameFn = unsafe extern "C" fn(u32, *mut f64, *mut f64, *mut f64, *mut f64);
type CloseWindowFn = unsafe extern "C" fn(u32);
type ResizeWebviewFn = unsafe extern "C" fn(u32, f64, f64, f64, f64, *const c_char);
type LoadURLInWebViewFn = unsafe extern "C" fn(u32, *const c_char);
type LoadHTMLInWebViewFn = unsafe extern "C" fn(u32, *const c_char);
type WebviewCanGoBackFn = unsafe extern "C" fn(u32) -> bool;
type WebviewCanGoForwardFn = unsafe extern "C" fn(u32) -> bool;
type WebviewGoBackFn = unsafe extern "C" fn(u32);
type WebviewGoForwardFn = unsafe extern "C" fn(u32);
type WebviewReloadFn = unsafe extern "C" fn(u32);
type WebviewRemoveFn = unsafe extern "C" fn(u32);
type SetWebviewHTMLContentFn = unsafe extern "C" fn(u32, *const c_char);
type WebviewSetTransparentFn = unsafe extern "C" fn(u32, bool);
type WebviewSetPassthroughFn = unsafe extern "C" fn(u32, bool);
type WebviewSetHiddenFn = unsafe extern "C" fn(u32, bool);
type SetWebviewNavigationRulesFn = unsafe extern "C" fn(u32, *const c_char);
type WebviewFindInPageFn = unsafe extern "C" fn(u32, *const c_char, bool, bool);
type WebviewStopFindFn = unsafe extern "C" fn(u32);
type WebviewOpenDevToolsFn = unsafe extern "C" fn(u32);
type WebviewCloseDevToolsFn = unsafe extern "C" fn(u32);
type WebviewToggleDevToolsFn = unsafe extern "C" fn(u32);
type WebviewSetPageZoomFn = unsafe extern "C" fn(u32, f64);
type WebviewGetPageZoomFn = unsafe extern "C" fn(u32) -> f64;
type SendInternalMessageToWebviewFn = unsafe extern "C" fn(u32, *const c_char) -> bool;
type SetWGPUViewFrameFn = unsafe extern "C" fn(u32, f64, f64, f64, f64);
type ResizeWGPUViewFn = unsafe extern "C" fn(u32, f64, f64, f64, f64, *const c_char);
type SetWGPUViewTransparentFn = unsafe extern "C" fn(u32, bool);
type SetWGPUViewPassthroughFn = unsafe extern "C" fn(u32, bool);
type SetWGPUViewHiddenFn = unsafe extern "C" fn(u32, bool);
type RemoveWGPUViewFn = unsafe extern "C" fn(u32);
type GetWGPUViewPointerFn = unsafe extern "C" fn(u32) -> *mut c_void;
type GetWGPUViewNativeHandleFn = unsafe extern "C" fn(u32) -> *mut c_void;
type RunWGPUViewTestFn = unsafe extern "C" fn(u32);
type ToggleWGPUViewTestShaderFn = unsafe extern "C" fn(u32);
type SendHostMessageToWebviewViaTransportFn = unsafe extern "C" fn(u32, *const c_char) -> bool;
type PopNextQueuedHostMessageFn = unsafe extern "C" fn(*mut u32) -> *mut c_char;
type FreeCoreStringFn = unsafe extern "C" fn(*mut c_char);
type EvaluateJavaScriptWithNoCompletionFn = unsafe extern "C" fn(u32, *const c_char);
type CreateTrayFn = unsafe extern "C" fn(
    *const c_char,
    *const c_char,
    bool,
    u32,
    u32,
    Option<StatusItemHandler>,
) -> u32;
type ShowTrayFn = unsafe extern "C" fn(u32) -> bool;
type HideTrayFn = unsafe extern "C" fn(u32);
type SetTrayTitleFn = unsafe extern "C" fn(u32, *const c_char);
type RemoveTrayFn = unsafe extern "C" fn(u32);
type GetTrayBoundsFn = unsafe extern "C" fn(u32) -> *const c_char;
type SetDockIconVisibleFn = unsafe extern "C" fn(bool);
type IsDockIconVisibleFn = unsafe extern "C" fn() -> bool;
type GetPrimaryDisplayFn = unsafe extern "C" fn() -> *mut c_char;
type GetAllDisplaysFn = unsafe extern "C" fn() -> *mut c_char;
type GetCursorScreenPointFn = unsafe extern "C" fn() -> *mut c_char;
type MoveToTrashFn = unsafe extern "C" fn(*const c_char) -> bool;
type ShowItemInFolderFn = unsafe extern "C" fn(*const c_char);
type OpenExternalFn = unsafe extern "C" fn(*const c_char) -> bool;
type OpenPathFn = unsafe extern "C" fn(*const c_char) -> bool;
type ShowNotificationFn = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char, bool);
type ClipboardReadTextFn = unsafe extern "C" fn() -> *mut c_char;
type ClipboardWriteTextFn = unsafe extern "C" fn(*const c_char);
type ClipboardClearFn = unsafe extern "C" fn();
type ClipboardAvailableFormatsFn = unsafe extern "C" fn() -> *mut c_char;
type SetApplicationMenuFn = unsafe extern "C" fn(*const c_char, Option<StatusItemHandler>);
type ShowContextMenuFn = unsafe extern "C" fn(*const c_char, Option<StatusItemHandler>);
type OpenFileDialogFn =
    unsafe extern "C" fn(*const c_char, *const c_char, c_int, c_int, c_int) -> *mut c_char;
type ShowMessageBoxFn = unsafe extern "C" fn(
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    *const c_char,
    c_int,
    c_int,
) -> c_int;
type SetGlobalShortcutCallbackFn = unsafe extern "C" fn(Option<GlobalShortcutHandler>);
type RegisterGlobalShortcutFn = unsafe extern "C" fn(*const c_char) -> bool;
type UnregisterGlobalShortcutFn = unsafe extern "C" fn(*const c_char) -> bool;
type UnregisterAllGlobalShortcutsFn = unsafe extern "C" fn();
type IsGlobalShortcutRegisteredFn = unsafe extern "C" fn(*const c_char) -> bool;
type SessionGetCookiesFn = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_char;
type SessionSetCookieFn = unsafe extern "C" fn(*const c_char, *const c_char) -> bool;
type SessionRemoveCookieFn =
    unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> bool;
type SessionClearCookiesFn = unsafe extern "C" fn(*const c_char);
type SessionClearStorageDataFn = unsafe extern "C" fn(*const c_char, *const c_char);
type SetURLOpenHandlerFn = unsafe extern "C" fn(Option<URLOpenHandler>);
type SetAppReopenHandlerFn = unsafe extern "C" fn(Option<AppReopenHandler>);
type SetQuitRequestedHandlerFn = unsafe extern "C" fn(Option<QuitRequestedHandler>);
type StopEventLoopFn = unsafe extern "C" fn();
type WaitForShutdownCompleteFn = unsafe extern "C" fn(c_int);
type ForceExitFn = unsafe extern "C" fn(c_int);

struct Symbols {
    last_error: LastErrorFn,
    run_main_thread: RunMainThreadFn,
    configure_webview_runtime: ConfigureWebviewRuntimeFn,
    get_window_style: GetWindowStyleFn,
    create_window: CreateWindowFn,
    create_webview: CreateWebviewFn,
    create_wgpu_view: CreateWGPUViewFn,
    set_window_title: SetWindowTitleFn,
    minimize_window: MinimizeWindowFn,
    restore_window: RestoreWindowFn,
    is_window_minimized: IsWindowMinimizedFn,
    maximize_window: MaximizeWindowFn,
    unmaximize_window: UnmaximizeWindowFn,
    is_window_maximized: IsWindowMaximizedFn,
    set_window_full_screen: SetWindowFullScreenFn,
    is_window_full_screen: IsWindowFullScreenFn,
    set_window_always_on_top: SetWindowAlwaysOnTopFn,
    is_window_always_on_top: IsWindowAlwaysOnTopFn,
    set_window_visible_on_all_workspaces: SetWindowVisibleOnAllWorkspacesFn,
    is_window_visible_on_all_workspaces: IsWindowVisibleOnAllWorkspacesFn,
    show_window: ShowWindowFn,
    activate_window: ActivateWindowFn,
    hide_window: HideWindowFn,
    set_window_button_position: SetWindowButtonPositionFn,
    set_window_position: SetWindowPositionFn,
    set_window_size: SetWindowSizeFn,
    set_window_frame: SetWindowFrameFn,
    get_window_frame: GetWindowFrameFn,
    close_window: CloseWindowFn,
    resize_webview: ResizeWebviewFn,
    load_url_in_webview: LoadURLInWebViewFn,
    load_html_in_webview: LoadHTMLInWebViewFn,
    webview_can_go_back: WebviewCanGoBackFn,
    webview_can_go_forward: WebviewCanGoForwardFn,
    webview_go_back: WebviewGoBackFn,
    webview_go_forward: WebviewGoForwardFn,
    webview_reload: WebviewReloadFn,
    webview_remove: WebviewRemoveFn,
    set_webview_html_content: SetWebviewHTMLContentFn,
    webview_set_transparent: WebviewSetTransparentFn,
    webview_set_passthrough: WebviewSetPassthroughFn,
    webview_set_hidden: WebviewSetHiddenFn,
    set_webview_navigation_rules: SetWebviewNavigationRulesFn,
    webview_find_in_page: WebviewFindInPageFn,
    webview_stop_find: WebviewStopFindFn,
    webview_open_devtools: WebviewOpenDevToolsFn,
    webview_close_devtools: WebviewCloseDevToolsFn,
    webview_toggle_devtools: WebviewToggleDevToolsFn,
    webview_set_page_zoom: WebviewSetPageZoomFn,
    webview_get_page_zoom: WebviewGetPageZoomFn,
    send_internal_message_to_webview: SendInternalMessageToWebviewFn,
    set_wgpu_view_frame: SetWGPUViewFrameFn,
    resize_wgpu_view: ResizeWGPUViewFn,
    set_wgpu_view_transparent: SetWGPUViewTransparentFn,
    set_wgpu_view_passthrough: SetWGPUViewPassthroughFn,
    set_wgpu_view_hidden: SetWGPUViewHiddenFn,
    remove_wgpu_view: RemoveWGPUViewFn,
    get_wgpu_view_pointer: GetWGPUViewPointerFn,
    get_wgpu_view_native_handle: GetWGPUViewNativeHandleFn,
    run_wgpu_view_test: RunWGPUViewTestFn,
    toggle_wgpu_view_test_shader: ToggleWGPUViewTestShaderFn,
    send_host_message_to_webview_via_transport: SendHostMessageToWebviewViaTransportFn,
    pop_next_queued_host_message: PopNextQueuedHostMessageFn,
    free_core_string: FreeCoreStringFn,
    evaluate_javascript_with_no_completion: EvaluateJavaScriptWithNoCompletionFn,
    create_tray: CreateTrayFn,
    show_tray: ShowTrayFn,
    hide_tray: HideTrayFn,
    set_tray_title: SetTrayTitleFn,
    remove_tray: RemoveTrayFn,
    get_tray_bounds: GetTrayBoundsFn,
    set_dock_icon_visible: SetDockIconVisibleFn,
    is_dock_icon_visible: IsDockIconVisibleFn,
    get_primary_display: GetPrimaryDisplayFn,
    get_all_displays: GetAllDisplaysFn,
    get_cursor_screen_point: GetCursorScreenPointFn,
    move_to_trash: MoveToTrashFn,
    show_item_in_folder: ShowItemInFolderFn,
    open_external: OpenExternalFn,
    open_path: OpenPathFn,
    show_notification: ShowNotificationFn,
    clipboard_read_text: ClipboardReadTextFn,
    clipboard_write_text: ClipboardWriteTextFn,
    clipboard_clear: ClipboardClearFn,
    clipboard_available_formats: ClipboardAvailableFormatsFn,
    set_application_menu: SetApplicationMenuFn,
    show_context_menu: ShowContextMenuFn,
    open_file_dialog: OpenFileDialogFn,
    show_message_box: ShowMessageBoxFn,
    set_global_shortcut_callback: SetGlobalShortcutCallbackFn,
    register_global_shortcut: RegisterGlobalShortcutFn,
    unregister_global_shortcut: UnregisterGlobalShortcutFn,
    unregister_all_global_shortcuts: UnregisterAllGlobalShortcutsFn,
    is_global_shortcut_registered: IsGlobalShortcutRegisteredFn,
    session_get_cookies: SessionGetCookiesFn,
    session_set_cookie: SessionSetCookieFn,
    session_remove_cookie: SessionRemoveCookieFn,
    session_clear_cookies: SessionClearCookiesFn,
    session_clear_storage_data: SessionClearStorageDataFn,
    set_url_open_handler: SetURLOpenHandlerFn,
    set_app_reopen_handler: SetAppReopenHandlerFn,
    set_quit_requested_handler: SetQuitRequestedHandlerFn,
    stop_event_loop: StopEventLoopFn,
    wait_for_shutdown_complete: WaitForShutdownCompleteFn,
    force_exit: ForceExitFn,
}

pub struct Core {
    _lib: dynlib::DynamicLibrary,
    symbols: Symbols,
}

unsafe impl Send for Core {}
unsafe impl Sync for Core {}

impl Core {
    pub fn load() -> Result<Self, String> {
        let bundle_paths = resolve_bundle_paths()?;
        let lib_path = bundle_paths.exe_dir.join(core_library_name());
        let lib = dynlib::DynamicLibrary::open(&lib_path)?;

        let symbols = Symbols {
            last_error: lib.symbol("electrobun_core_last_error")?,
            run_main_thread: lib.symbol("electrobun_core_run_main_thread")?,
            configure_webview_runtime: lib.symbol("configureWebviewRuntime")?,
            get_window_style: lib.symbol("getWindowStyle")?,
            create_window: lib.symbol("createWindow")?,
            create_webview: lib.symbol("createWebview")?,
            create_wgpu_view: lib.symbol("createWGPUView")?,
            set_window_title: lib.symbol("setWindowTitle")?,
            minimize_window: lib.symbol("minimizeWindow")?,
            restore_window: lib.symbol("restoreWindow")?,
            is_window_minimized: lib.symbol("isWindowMinimized")?,
            maximize_window: lib.symbol("maximizeWindow")?,
            unmaximize_window: lib.symbol("unmaximizeWindow")?,
            is_window_maximized: lib.symbol("isWindowMaximized")?,
            set_window_full_screen: lib.symbol("setWindowFullScreen")?,
            is_window_full_screen: lib.symbol("isWindowFullScreen")?,
            set_window_always_on_top: lib.symbol("setWindowAlwaysOnTop")?,
            is_window_always_on_top: lib.symbol("isWindowAlwaysOnTop")?,
            set_window_visible_on_all_workspaces: lib.symbol("setWindowVisibleOnAllWorkspaces")?,
            is_window_visible_on_all_workspaces: lib.symbol("isWindowVisibleOnAllWorkspaces")?,
            show_window: lib.symbol("showWindow")?,
            activate_window: lib.symbol("activateWindow")?,
            hide_window: lib.symbol("hideWindow")?,
            set_window_button_position: lib.symbol("setWindowButtonPosition")?,
            set_window_position: lib.symbol("setWindowPosition")?,
            set_window_size: lib.symbol("setWindowSize")?,
            set_window_frame: lib.symbol("setWindowFrame")?,
            get_window_frame: lib.symbol("getWindowFrame")?,
            close_window: lib.symbol("closeWindow")?,
            resize_webview: lib.symbol("resizeWebview")?,
            load_url_in_webview: lib.symbol("loadURLInWebView")?,
            load_html_in_webview: lib.symbol("loadHTMLInWebView")?,
            webview_can_go_back: lib.symbol("webviewCanGoBack")?,
            webview_can_go_forward: lib.symbol("webviewCanGoForward")?,
            webview_go_back: lib.symbol("webviewGoBack")?,
            webview_go_forward: lib.symbol("webviewGoForward")?,
            webview_reload: lib.symbol("webviewReload")?,
            webview_remove: lib.symbol("webviewRemove")?,
            set_webview_html_content: lib.symbol("setWebviewHTMLContent")?,
            webview_set_transparent: lib.symbol("webviewSetTransparent")?,
            webview_set_passthrough: lib.symbol("webviewSetPassthrough")?,
            webview_set_hidden: lib.symbol("webviewSetHidden")?,
            set_webview_navigation_rules: lib.symbol("setWebviewNavigationRules")?,
            webview_find_in_page: lib.symbol("webviewFindInPage")?,
            webview_stop_find: lib.symbol("webviewStopFind")?,
            webview_open_devtools: lib.symbol("webviewOpenDevTools")?,
            webview_close_devtools: lib.symbol("webviewCloseDevTools")?,
            webview_toggle_devtools: lib.symbol("webviewToggleDevTools")?,
            webview_set_page_zoom: lib.symbol("webviewSetPageZoom")?,
            webview_get_page_zoom: lib.symbol("webviewGetPageZoom")?,
            send_internal_message_to_webview: lib.symbol("sendInternalMessageToWebview")?,
            set_wgpu_view_frame: lib.symbol("setWGPUViewFrame")?,
            resize_wgpu_view: lib.symbol("resizeWGPUView")?,
            set_wgpu_view_transparent: lib.symbol("setWGPUViewTransparent")?,
            set_wgpu_view_passthrough: lib.symbol("setWGPUViewPassthrough")?,
            set_wgpu_view_hidden: lib.symbol("setWGPUViewHidden")?,
            remove_wgpu_view: lib.symbol("removeWGPUView")?,
            get_wgpu_view_pointer: lib.symbol("getWGPUViewPointer")?,
            get_wgpu_view_native_handle: lib.symbol("getWGPUViewNativeHandle")?,
            run_wgpu_view_test: lib.symbol("runWGPUViewTest")?,
            toggle_wgpu_view_test_shader: lib.symbol("toggleWGPUViewTestShader")?,
            send_host_message_to_webview_via_transport: lib
                .symbol("sendHostMessageToWebviewViaTransport")?,
            pop_next_queued_host_message: lib.symbol("popNextQueuedHostMessage")?,
            free_core_string: lib.symbol("freeCoreString")?,
            evaluate_javascript_with_no_completion: lib
                .symbol("evaluateJavaScriptWithNoCompletion")?,
            create_tray: lib.symbol("createTray")?,
            show_tray: lib.symbol("showTray")?,
            hide_tray: lib.symbol("hideTray")?,
            set_tray_title: lib.symbol("setTrayTitle")?,
            remove_tray: lib.symbol("removeTray")?,
            get_tray_bounds: lib.symbol("getTrayBounds")?,
            set_dock_icon_visible: lib.symbol("setDockIconVisible")?,
            is_dock_icon_visible: lib.symbol("isDockIconVisible")?,
            get_primary_display: lib.symbol("getPrimaryDisplay")?,
            get_all_displays: lib.symbol("getAllDisplays")?,
            get_cursor_screen_point: lib.symbol("getCursorScreenPoint")?,
            move_to_trash: lib.symbol("moveToTrash")?,
            show_item_in_folder: lib.symbol("showItemInFolder")?,
            open_external: lib.symbol("openExternal")?,
            open_path: lib.symbol("openPath")?,
            show_notification: lib.symbol("showNotification")?,
            clipboard_read_text: lib.symbol("clipboardReadText")?,
            clipboard_write_text: lib.symbol("clipboardWriteText")?,
            clipboard_clear: lib.symbol("clipboardClear")?,
            clipboard_available_formats: lib.symbol("clipboardAvailableFormats")?,
            set_application_menu: lib.symbol("setApplicationMenu")?,
            show_context_menu: lib.symbol("showContextMenu")?,
            open_file_dialog: lib.symbol("openFileDialog")?,
            show_message_box: lib.symbol("showMessageBox")?,
            set_global_shortcut_callback: lib.symbol("setGlobalShortcutCallback")?,
            register_global_shortcut: lib.symbol("registerGlobalShortcut")?,
            unregister_global_shortcut: lib.symbol("unregisterGlobalShortcut")?,
            unregister_all_global_shortcuts: lib.symbol("unregisterAllGlobalShortcuts")?,
            is_global_shortcut_registered: lib.symbol("isGlobalShortcutRegistered")?,
            session_get_cookies: lib.symbol("sessionGetCookies")?,
            session_set_cookie: lib.symbol("sessionSetCookie")?,
            session_remove_cookie: lib.symbol("sessionRemoveCookie")?,
            session_clear_cookies: lib.symbol("sessionClearCookies")?,
            session_clear_storage_data: lib.symbol("sessionClearStorageData")?,
            set_url_open_handler: lib.symbol("setURLOpenHandler")?,
            set_app_reopen_handler: lib.symbol("setAppReopenHandler")?,
            set_quit_requested_handler: lib.symbol("setQuitRequestedHandler")?,
            stop_event_loop: lib.symbol("stopEventLoop")?,
            wait_for_shutdown_complete: lib.symbol("waitForShutdownComplete")?,
            force_exit: lib.symbol("forceExit")?,
        };

        Ok(Self { _lib: lib, symbols })
    }

    pub fn configure_webview_runtime_from_executable_dir(
        &self,
        bundle_paths: &BundlePaths,
        rpc_port: u32,
    ) -> Result<(), String> {
        let full_path = bundle_paths.resources_dir.join("preload-full.js");
        let sandboxed_path = bundle_paths.resources_dir.join("preload-sandboxed.js");
        let full_preload = fs::read_to_string(&full_path)
            .map_err(|err| format!("failed to read {}: {err}", full_path.display()))?;
        let sandboxed_preload = fs::read_to_string(&sandboxed_path)
            .map_err(|err| format!("failed to read {}: {err}", sandboxed_path.display()))?;
        let full_preload = to_c_string(&full_preload, "preload-full.js")?;
        let sandboxed_preload = to_c_string(&sandboxed_preload, "preload-sandboxed.js")?;

        let ok = unsafe {
            (self.symbols.configure_webview_runtime)(
                rpc_port,
                full_preload.as_ptr(),
                sandboxed_preload.as_ptr(),
            )
        };
        if !ok {
            return Err(self.last_error());
        }
        Ok(())
    }

    pub fn create_window(&self, options: WindowOptions<'_>) -> Result<u32, String> {
        let title = to_c_string(options.title, "window title")?;
        let title_bar_style = to_c_string(options.title_bar_style, "title bar style")?;
        let style = &options.style;

        let style_mask = unsafe {
            (self.symbols.get_window_style)(
                style.borderless,
                style.titled,
                style.closable,
                style.miniaturizable,
                style.resizable,
                style.unified_title_and_toolbar,
                style.full_screen,
                style.full_size_content_view,
                style.utility_window,
                style.doc_modal_window,
                style.nonactivating_panel,
                style.hud_window,
            )
        };

        let window_id = unsafe {
            (self.symbols.create_window)(
                options.frame.x,
                options.frame.y,
                options.frame.width,
                options.frame.height,
                style_mask,
                title_bar_style.as_ptr(),
                options.transparent,
                title.as_ptr(),
                options.hidden,
                options.activate,
                options.traffic_light_offset.x,
                options.traffic_light_offset.y,
                options.callbacks.close,
                options.callbacks.move_handler,
                options.callbacks.resize,
                options.callbacks.focus,
                options.callbacks.blur,
                options.callbacks.key,
            )
        };

        if window_id == 0 {
            return Err(self.last_error());
        }
        Ok(window_id)
    }

    pub fn set_window_title(&self, window_id: u32, title: &str) -> Result<(), String> {
        let title = to_c_string(title, "window title")?;
        unsafe {
            (self.symbols.set_window_title)(window_id, title.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn minimize_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.minimize_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn restore_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.restore_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_window_minimized(&self, window_id: u32) -> bool {
        unsafe { (self.symbols.is_window_minimized)(window_id) }
    }

    pub fn maximize_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.maximize_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn unmaximize_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.unmaximize_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_window_maximized(&self, window_id: u32) -> bool {
        unsafe { (self.symbols.is_window_maximized)(window_id) }
    }

    pub fn set_window_full_screen(&self, window_id: u32, full_screen: bool) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_full_screen)(window_id, full_screen);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_window_full_screen(&self, window_id: u32) -> bool {
        unsafe { (self.symbols.is_window_full_screen)(window_id) }
    }

    pub fn set_window_always_on_top(
        &self,
        window_id: u32,
        always_on_top: bool,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_always_on_top)(window_id, always_on_top);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_window_always_on_top(&self, window_id: u32) -> bool {
        unsafe { (self.symbols.is_window_always_on_top)(window_id) }
    }

    pub fn set_window_visible_on_all_workspaces(
        &self,
        window_id: u32,
        visible: bool,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_visible_on_all_workspaces)(window_id, visible);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_window_visible_on_all_workspaces(&self, window_id: u32) -> bool {
        unsafe { (self.symbols.is_window_visible_on_all_workspaces)(window_id) }
    }

    pub fn show_window(&self, window_id: u32, activate: bool) -> Result<(), String> {
        unsafe {
            (self.symbols.show_window)(window_id, activate);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn activate_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.activate_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn hide_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.hide_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_window_button_position(&self, window_id: u32, x: f64, y: f64) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_button_position)(window_id, x, y);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_window_position(&self, window_id: u32, x: f64, y: f64) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_position)(window_id, x, y);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_window_size(&self, window_id: u32, width: f64, height: f64) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_size)(window_id, width, height);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_window_frame(&self, window_id: u32, frame: Rect) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_frame)(window_id, frame.x, frame.y, frame.width, frame.height);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn get_window_frame(&self, window_id: u32) -> Result<Rect, String> {
        let mut x = 0.0;
        let mut y = 0.0;
        let mut width = 0.0;
        let mut height = 0.0;
        unsafe {
            (self.symbols.get_window_frame)(
                window_id,
                &mut x as *mut f64,
                &mut y as *mut f64,
                &mut width as *mut f64,
                &mut height as *mut f64,
            );
        }
        self.ensure_last_call_succeeded()?;
        Ok(Rect::new(x, y, width, height))
    }

    pub fn create_webview(&self, options: WebviewOptions<'_>) -> Result<u32, String> {
        let renderer = to_c_string(options.renderer.as_str(), "renderer")?;
        let url = to_c_string(options.url, "webview url")?;
        let partition = to_c_string(options.partition, "partition")?;
        let secret_key = to_c_string(options.secret_key, "secret key")?;
        let preload = to_c_string(options.preload, "preload")?;
        let views_root = to_c_string(options.views_root, "views root")?;

        let webview_id = unsafe {
            (self.symbols.create_webview)(
                options.window_id,
                options.host_webview_id,
                renderer.as_ptr(),
                url.as_ptr(),
                options.frame.x,
                options.frame.y,
                options.frame.width,
                options.frame.height,
                options.auto_resize,
                partition.as_ptr(),
                options.callbacks.decide_navigation,
                options.callbacks.event,
                options.callbacks.event_bridge,
                options
                    .callbacks
                    .host_bridge
                    .or(options.callbacks.bun_bridge),
                options.callbacks.internal_bridge,
                secret_key.as_ptr(),
                preload.as_ptr(),
                views_root.as_ptr(),
                options.sandbox,
                options.start_transparent,
                options.start_passthrough,
            )
        };

        if webview_id == 0 {
            return Err(self.last_error());
        }
        Ok(webview_id)
    }

    pub fn resize_webview(
        &self,
        webview_id: u32,
        frame: Rect,
        masks_json: &str,
    ) -> Result<(), String> {
        let masks_json = to_c_string(masks_json, "resize masks json")?;
        unsafe {
            (self.symbols.resize_webview)(
                webview_id,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                masks_json.as_ptr(),
            );
        }
        self.ensure_last_call_succeeded()
    }

    pub fn load_url_in_webview(&self, webview_id: u32, url: &str) -> Result<(), String> {
        let url = to_c_string(url, "webview url")?;
        unsafe {
            (self.symbols.load_url_in_webview)(webview_id, url.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn load_html_in_webview(&self, webview_id: u32, html: &str) -> Result<(), String> {
        let html = to_c_string(html, "webview html")?;
        unsafe {
            (self.symbols.load_html_in_webview)(webview_id, html.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn can_webview_go_back(&self, webview_id: u32) -> bool {
        unsafe { (self.symbols.webview_can_go_back)(webview_id) }
    }

    pub fn can_webview_go_forward(&self, webview_id: u32) -> bool {
        unsafe { (self.symbols.webview_can_go_forward)(webview_id) }
    }

    pub fn webview_go_back(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_go_back)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn webview_go_forward(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_go_forward)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn reload_webview(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_reload)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn remove_webview(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_remove)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_webview_html_content(&self, webview_id: u32, html: &str) -> Result<(), String> {
        let html = to_c_string(html, "webview html")?;
        unsafe {
            (self.symbols.set_webview_html_content)(webview_id, html.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_webview_transparent(
        &self,
        webview_id: u32,
        transparent: bool,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_set_transparent)(webview_id, transparent);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_webview_passthrough(
        &self,
        webview_id: u32,
        passthrough: bool,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_set_passthrough)(webview_id, passthrough);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_webview_hidden(&self, webview_id: u32, hidden: bool) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_set_hidden)(webview_id, hidden);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_webview_navigation_rules(
        &self,
        webview_id: u32,
        rules_json: &str,
    ) -> Result<(), String> {
        let rules_json = to_c_string(rules_json, "navigation rules json")?;
        unsafe {
            (self.symbols.set_webview_navigation_rules)(webview_id, rules_json.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn webview_find_in_page(
        &self,
        webview_id: u32,
        search_text: &str,
        forward: bool,
        match_case: bool,
    ) -> Result<(), String> {
        let search_text = to_c_string(search_text, "find text")?;
        unsafe {
            (self.symbols.webview_find_in_page)(
                webview_id,
                search_text.as_ptr(),
                forward,
                match_case,
            );
        }
        self.ensure_last_call_succeeded()
    }

    pub fn webview_stop_find(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_stop_find)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn open_webview_devtools(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_open_devtools)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn close_webview_devtools(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_close_devtools)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn toggle_webview_devtools(&self, webview_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_toggle_devtools)(webview_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_webview_page_zoom(&self, webview_id: u32, zoom_level: f64) -> Result<(), String> {
        unsafe {
            (self.symbols.webview_set_page_zoom)(webview_id, zoom_level);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn get_webview_page_zoom(&self, webview_id: u32) -> f64 {
        unsafe { (self.symbols.webview_get_page_zoom)(webview_id) }
    }

    pub fn send_internal_message_to_webview_json(
        &self,
        webview_id: u32,
        message_json: &str,
    ) -> Result<(), String> {
        let message_json = to_c_string(message_json, "internal message json")?;
        let sent = unsafe {
            (self.symbols.send_internal_message_to_webview)(webview_id, message_json.as_ptr())
        };
        if sent {
            Ok(())
        } else {
            Err(self.last_error())
        }
    }

    pub fn create_wgpu_view(&self, options: WGPUViewOptions) -> Result<u32, String> {
        let wgpu_view_id = unsafe {
            (self.symbols.create_wgpu_view)(
                options.window_id,
                options.frame.x,
                options.frame.y,
                options.frame.width,
                options.frame.height,
                options.auto_resize,
                options.start_transparent,
                options.start_passthrough,
            )
        };

        if wgpu_view_id == 0 {
            return Err(self.last_error());
        }
        Ok(wgpu_view_id)
    }

    pub fn set_wgpu_view_frame(&self, wgpu_view_id: u32, frame: Rect) -> Result<(), String> {
        unsafe {
            (self.symbols.set_wgpu_view_frame)(
                wgpu_view_id,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
            );
        }
        self.ensure_last_call_succeeded()
    }

    pub fn resize_wgpu_view(
        &self,
        wgpu_view_id: u32,
        frame: Rect,
        masks_json: &str,
    ) -> Result<(), String> {
        let masks_json = to_c_string(masks_json, "WGPU resize masks json")?;
        unsafe {
            (self.symbols.resize_wgpu_view)(
                wgpu_view_id,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                masks_json.as_ptr(),
            );
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_wgpu_view_transparent(
        &self,
        wgpu_view_id: u32,
        transparent: bool,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.set_wgpu_view_transparent)(wgpu_view_id, transparent);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_wgpu_view_passthrough(
        &self,
        wgpu_view_id: u32,
        passthrough: bool,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.set_wgpu_view_passthrough)(wgpu_view_id, passthrough);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_wgpu_view_hidden(&self, wgpu_view_id: u32, hidden: bool) -> Result<(), String> {
        unsafe {
            (self.symbols.set_wgpu_view_hidden)(wgpu_view_id, hidden);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn remove_wgpu_view(&self, wgpu_view_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.remove_wgpu_view)(wgpu_view_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn get_wgpu_view_pointer(&self, wgpu_view_id: u32) -> Result<*mut c_void, String> {
        let ptr = unsafe { (self.symbols.get_wgpu_view_pointer)(wgpu_view_id) };
        self.ensure_last_call_succeeded()?;
        Ok(ptr)
    }

    pub fn get_wgpu_view_native_handle(&self, wgpu_view_id: u32) -> Result<*mut c_void, String> {
        let ptr = unsafe { (self.symbols.get_wgpu_view_native_handle)(wgpu_view_id) };
        self.ensure_last_call_succeeded()?;
        Ok(ptr)
    }

    pub fn run_wgpu_view_test(&self, wgpu_view_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.run_wgpu_view_test)(wgpu_view_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn toggle_wgpu_view_test_shader(&self, wgpu_view_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.toggle_wgpu_view_test_shader)(wgpu_view_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn close_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.close_window)(window_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn evaluate_javascript_with_no_completion(
        &self,
        webview_id: u32,
        js: &str,
    ) -> Result<(), String> {
        let js = to_c_string(js, "javascript")?;
        unsafe {
            (self.symbols.evaluate_javascript_with_no_completion)(webview_id, js.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn send_host_message_to_webview_json(
        &self,
        webview_id: u32,
        message_json: &str,
    ) -> Result<(), String> {
        let message_json_c = to_c_string(message_json, "host message json")?;
        let sent = unsafe {
            (self.symbols.send_host_message_to_webview_via_transport)(
                webview_id,
                message_json_c.as_ptr(),
            )
        };
        if sent {
            return Ok(());
        }

        let js = format!("window.__electrobun.receiveMessageFromHost({message_json});");
        self.evaluate_javascript_with_no_completion(webview_id, &js)
    }

    pub fn pop_next_queued_host_message_string(&self) -> Option<(u32, String)> {
        let mut webview_id = 0_u32;
        let message_ptr =
            unsafe { (self.symbols.pop_next_queued_host_message)(&mut webview_id as *mut u32) };
        if message_ptr.is_null() {
            return None;
        }

        let message = unsafe { CStr::from_ptr(message_ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(message_ptr);
        }
        Some((webview_id, message))
    }

    pub fn create_tray(&self, options: TrayOptions<'_>) -> Result<u32, String> {
        let title = to_c_string(options.title, "tray title")?;
        let image = to_c_string(options.image, "tray image")?;
        let tray_id = unsafe {
            (self.symbols.create_tray)(
                title.as_ptr(),
                image.as_ptr(),
                options.is_template,
                options.width,
                options.height,
                None,
            )
        };
        if tray_id == 0 {
            return Err(self.last_error());
        }
        Ok(tray_id)
    }

    pub fn show_tray(&self, tray_id: u32) -> Result<(), String> {
        let ok = unsafe { (self.symbols.show_tray)(tray_id) };
        if ok {
            Ok(())
        } else {
            Err(self.last_error())
        }
    }

    pub fn hide_tray(&self, tray_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.hide_tray)(tray_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_tray_title(&self, tray_id: u32, title: &str) -> Result<(), String> {
        let title = to_c_string(title, "tray title")?;
        unsafe {
            (self.symbols.set_tray_title)(tray_id, title.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn remove_tray(&self, tray_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.remove_tray)(tray_id);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn get_tray_bounds(&self, tray_id: u32) -> Result<Rect, String> {
        let ptr = unsafe { (self.symbols.get_tray_bounds)(tray_id) };
        if ptr.is_null() {
            return Err(self.last_error());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        Ok(parse_rect_json(&json))
    }

    pub fn set_dock_icon_visible(&self, visible: bool) -> Result<(), String> {
        unsafe {
            (self.symbols.set_dock_icon_visible)(visible);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_dock_icon_visible(&self) -> bool {
        unsafe { (self.symbols.is_dock_icon_visible)() }
    }

    pub fn get_primary_display(&self) -> Result<Display, String> {
        let ptr = unsafe { (self.symbols.get_primary_display)() };
        if ptr.is_null() {
            return Err(self.last_error());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(parse_display_json(&json))
    }

    pub fn get_all_displays(&self) -> Result<Vec<Display>, String> {
        let ptr = unsafe { (self.symbols.get_all_displays)() };
        if ptr.is_null() {
            return Err(self.last_error());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(parse_display_array_json(&json))
    }

    pub fn get_cursor_screen_point(&self) -> Result<Point, String> {
        let ptr = unsafe { (self.symbols.get_cursor_screen_point)() };
        if ptr.is_null() {
            return Err(self.last_error());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(parse_point_json(&json))
    }

    pub fn move_to_trash(&self, path: &str) -> Result<bool, String> {
        let path = to_c_string(path, "path")?;
        Ok(unsafe { (self.symbols.move_to_trash)(path.as_ptr()) })
    }

    pub fn show_item_in_folder(&self, path: &str) -> Result<(), String> {
        let path = to_c_string(path, "path")?;
        unsafe {
            (self.symbols.show_item_in_folder)(path.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn open_external(&self, url: &str) -> Result<bool, String> {
        let url = to_c_string(url, "url")?;
        Ok(unsafe { (self.symbols.open_external)(url.as_ptr()) })
    }

    pub fn open_path(&self, path: &str) -> Result<bool, String> {
        let path = to_c_string(path, "path")?;
        Ok(unsafe { (self.symbols.open_path)(path.as_ptr()) })
    }

    pub fn show_notification(&self, options: NotificationOptions<'_>) -> Result<(), String> {
        let title = to_c_string(options.title, "notification title")?;
        let body = to_c_string(options.body, "notification body")?;
        let subtitle = to_c_string(options.subtitle, "notification subtitle")?;
        unsafe {
            (self.symbols.show_notification)(
                title.as_ptr(),
                body.as_ptr(),
                subtitle.as_ptr(),
                options.silent,
            );
        }
        self.ensure_last_call_succeeded()
    }

    pub fn clipboard_read_text(&self) -> Result<Option<String>, String> {
        let ptr = unsafe { (self.symbols.clipboard_read_text)() };
        if ptr.is_null() {
            return Ok(None);
        }
        let text = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(Some(text))
    }

    pub fn clipboard_write_text(&self, text: &str) -> Result<(), String> {
        let text = to_c_string(text, "clipboard text")?;
        unsafe {
            (self.symbols.clipboard_write_text)(text.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn clipboard_clear(&self) -> Result<(), String> {
        unsafe {
            (self.symbols.clipboard_clear)();
        }
        self.ensure_last_call_succeeded()
    }

    pub fn clipboard_available_formats_csv(&self) -> Result<String, String> {
        let ptr = unsafe { (self.symbols.clipboard_available_formats)() };
        if ptr.is_null() {
            return Ok(String::new());
        }
        let formats = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(formats)
    }

    pub fn set_application_menu_json(
        &self,
        menu_json: &str,
        handler: Option<StatusItemHandler>,
    ) -> Result<(), String> {
        let menu_json = to_c_string(menu_json, "application menu json")?;
        unsafe {
            (self.symbols.set_application_menu)(menu_json.as_ptr(), handler);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn show_context_menu_json(
        &self,
        menu_json: &str,
        handler: Option<StatusItemHandler>,
    ) -> Result<(), String> {
        let menu_json = to_c_string(menu_json, "context menu json")?;
        unsafe {
            (self.symbols.show_context_menu)(menu_json.as_ptr(), handler);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn open_file_dialog(&self, options: OpenFileDialogOptions<'_>) -> Result<String, String> {
        let starting_folder = to_c_string(options.starting_folder, "starting folder")?;
        let allowed_file_types = to_c_string(options.allowed_file_types, "allowed file types")?;
        let ptr = unsafe {
            (self.symbols.open_file_dialog)(
                starting_folder.as_ptr(),
                allowed_file_types.as_ptr(),
                if options.can_choose_files { 1 } else { 0 },
                if options.can_choose_directory { 1 } else { 0 },
                if options.allows_multiple_selection {
                    1
                } else {
                    0
                },
            )
        };
        if ptr.is_null() {
            return Ok(String::new());
        }
        let value = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(value)
    }

    pub fn show_message_box(&self, options: MessageBoxOptions<'_>) -> Result<c_int, String> {
        let box_type = to_c_string(options.box_type, "message box type")?;
        let title = to_c_string(options.title, "message box title")?;
        let message = to_c_string(options.message, "message box message")?;
        let detail = to_c_string(options.detail, "message box detail")?;
        let buttons_joined = options.buttons.join(",");
        let buttons = to_c_string(&buttons_joined, "message box buttons")?;
        let response = unsafe {
            (self.symbols.show_message_box)(
                box_type.as_ptr(),
                title.as_ptr(),
                message.as_ptr(),
                detail.as_ptr(),
                buttons.as_ptr(),
                options.default_id,
                options.cancel_id,
            )
        };
        self.ensure_last_call_succeeded()?;
        Ok(response)
    }

    pub fn set_global_shortcut_callback(
        &self,
        callback: Option<GlobalShortcutHandler>,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.set_global_shortcut_callback)(callback);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn register_global_shortcut(&self, accelerator: &str) -> Result<bool, String> {
        let accelerator = to_c_string(accelerator, "accelerator")?;
        Ok(unsafe { (self.symbols.register_global_shortcut)(accelerator.as_ptr()) })
    }

    pub fn unregister_global_shortcut(&self, accelerator: &str) -> Result<bool, String> {
        let accelerator = to_c_string(accelerator, "accelerator")?;
        Ok(unsafe { (self.symbols.unregister_global_shortcut)(accelerator.as_ptr()) })
    }

    pub fn unregister_all_global_shortcuts(&self) -> Result<(), String> {
        unsafe {
            (self.symbols.unregister_all_global_shortcuts)();
        }
        self.ensure_last_call_succeeded()
    }

    pub fn is_global_shortcut_registered(&self, accelerator: &str) -> Result<bool, String> {
        let accelerator = to_c_string(accelerator, "accelerator")?;
        Ok(unsafe { (self.symbols.is_global_shortcut_registered)(accelerator.as_ptr()) })
    }

    pub fn session_get_cookies(
        &self,
        partition: &str,
        filter_json: &str,
    ) -> Result<String, String> {
        let partition = to_c_string(partition, "session partition")?;
        let filter_json = to_c_string(filter_json, "cookie filter json")?;
        let ptr =
            unsafe { (self.symbols.session_get_cookies)(partition.as_ptr(), filter_json.as_ptr()) };
        if ptr.is_null() {
            return Ok("[]".to_string());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        unsafe {
            (self.symbols.free_core_string)(ptr);
        }
        Ok(json)
    }

    pub fn session_set_cookie(&self, partition: &str, cookie_json: &str) -> Result<bool, String> {
        let partition = to_c_string(partition, "session partition")?;
        let cookie_json = to_c_string(cookie_json, "cookie json")?;
        Ok(unsafe { (self.symbols.session_set_cookie)(partition.as_ptr(), cookie_json.as_ptr()) })
    }

    pub fn session_remove_cookie(
        &self,
        partition: &str,
        url: &str,
        name: &str,
    ) -> Result<bool, String> {
        let partition = to_c_string(partition, "session partition")?;
        let url = to_c_string(url, "cookie url")?;
        let name = to_c_string(name, "cookie name")?;
        Ok(unsafe {
            (self.symbols.session_remove_cookie)(partition.as_ptr(), url.as_ptr(), name.as_ptr())
        })
    }

    pub fn session_clear_cookies(&self, partition: &str) -> Result<(), String> {
        let partition = to_c_string(partition, "session partition")?;
        unsafe {
            (self.symbols.session_clear_cookies)(partition.as_ptr());
        }
        self.ensure_last_call_succeeded()
    }

    pub fn session_clear_storage_data(
        &self,
        partition: &str,
        storage_types_json: &str,
    ) -> Result<(), String> {
        let partition = to_c_string(partition, "session partition")?;
        let storage_types_json = to_c_string(storage_types_json, "storage types json")?;
        unsafe {
            (self.symbols.session_clear_storage_data)(
                partition.as_ptr(),
                storage_types_json.as_ptr(),
            );
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_url_open_handler(&self, handler: Option<URLOpenHandler>) -> Result<(), String> {
        unsafe {
            (self.symbols.set_url_open_handler)(handler);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_app_reopen_handler(&self, handler: Option<AppReopenHandler>) -> Result<(), String> {
        unsafe {
            (self.symbols.set_app_reopen_handler)(handler);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn set_quit_requested_handler(
        &self,
        handler: Option<QuitRequestedHandler>,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.set_quit_requested_handler)(handler);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn stop_event_loop(&self) -> Result<(), String> {
        unsafe {
            (self.symbols.stop_event_loop)();
        }
        self.ensure_last_call_succeeded()
    }

    pub fn wait_for_shutdown_complete(&self, timeout_ms: c_int) -> Result<(), String> {
        unsafe {
            (self.symbols.wait_for_shutdown_complete)(timeout_ms);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn force_exit(&self, code: c_int) -> ! {
        unsafe {
            (self.symbols.force_exit)(code);
        }
        std::process::exit(code);
    }

    pub fn run_main_thread(&self, app_info: &AppInfo) -> Result<(), String> {
        let identifier = to_c_string(&app_info.identifier, "app identifier")?;
        let name = to_c_string(&app_info.name, "app name")?;
        let channel = to_c_string(&app_info.channel, "app channel")?;
        let status = unsafe {
            (self.symbols.run_main_thread)(identifier.as_ptr(), name.as_ptr(), channel.as_ptr(), 0)
        };
        if status != 0 {
            return Err(self.last_error());
        }
        Ok(())
    }

    fn ensure_last_call_succeeded(&self) -> Result<(), String> {
        let message = self.last_error();
        if message.is_empty() {
            Ok(())
        } else {
            Err(message)
        }
    }

    fn last_error(&self) -> String {
        let ptr = unsafe { (self.symbols.last_error)() };
        if ptr.is_null() {
            return String::new();
        }
        unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

fn core_library_name() -> &'static str {
    if cfg!(windows) {
        "ElectrobunCore.dll"
    } else if cfg!(target_os = "macos") {
        "libElectrobunCore.dylib"
    } else {
        "libElectrobunCore.so"
    }
}

fn to_c_string(value: &str, label: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("{label} contains an interior null byte"))
}

pub extern "C" fn allow_all_navigation(_: u32, _: *const c_char) -> u32 {
    1
}

pub extern "C" fn noop_webview_event(_: u32, _: *const c_char, _: *const c_char) {}

pub extern "C" fn noop_webview_post_message(_: u32, _: *const c_char) {}

pub fn c_string_to_string(value: *const c_char) -> String {
    if value.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(value).to_string_lossy().into_owned() }
}

pub fn json_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch < ' ' => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

pub fn json_string_field(source: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let mut chars = after_colon.char_indices();
    let (_, first) = chars.next()?;
    if first != '"' {
        return None;
    }

    let mut value = String::new();
    let mut escaped = false;
    for (_, ch) in chars {
        if escaped {
            match ch {
                '"' => value.push('"'),
                '\\' => value.push('\\'),
                '/' => value.push('/'),
                'b' => value.push('\u{0008}'),
                'f' => value.push('\u{000c}'),
                'n' => value.push('\n'),
                'r' => value.push('\r'),
                't' => value.push('\t'),
                'u' => {
                    return None;
                }
                other => value.push(other),
            }
            escaped = false;
            continue;
        }

        match ch {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }

    None
}

pub fn json_number_field(source: &str, key: &str) -> Option<f64> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    let number: String = after_colon
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || matches!(ch, '-' | '+' | '.' | 'e' | 'E'))
        .collect();
    number.parse().ok()
}

pub fn json_bool_field(source: &str, key: &str) -> Option<bool> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon = after_key[colon_index + 1..].trim_start();
    if after_colon.starts_with("true") {
        Some(true)
    } else if after_colon.starts_with("false") {
        Some(false)
    } else {
        None
    }
}

fn parse_rect_json(json: &str) -> Rect {
    Rect {
        x: json_number_field(json, "x").unwrap_or_default(),
        y: json_number_field(json, "y").unwrap_or_default(),
        width: json_number_field(json, "width").unwrap_or_default(),
        height: json_number_field(json, "height").unwrap_or_default(),
    }
}

fn parse_point_json(json: &str) -> Point {
    Point {
        x: json_number_field(json, "x").unwrap_or_default(),
        y: json_number_field(json, "y").unwrap_or_default(),
    }
}

fn parse_display_json(json: &str) -> Display {
    let bounds = extract_object_field(json, "bounds")
        .map(|value| parse_rect_json(value))
        .unwrap_or_default();
    let work_area = extract_object_field(json, "workArea")
        .map(|value| parse_rect_json(value))
        .unwrap_or_default();
    Display {
        id: json_number_field(json, "id").unwrap_or_default() as i64,
        bounds,
        work_area,
        scale_factor: json_number_field(json, "scaleFactor").unwrap_or(1.0),
        is_primary: json_bool_field(json, "isPrimary").unwrap_or(false),
    }
}

fn parse_display_array_json(json: &str) -> Vec<Display> {
    let mut displays = Vec::new();
    let mut depth = 0_i32;
    let mut object_start: Option<usize> = None;

    for (index, ch) in json.char_indices() {
        match ch {
            '{' => {
                if depth == 0 {
                    object_start = Some(index);
                }
                depth += 1;
            }
            '}' => {
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = object_start.take() {
                        displays.push(parse_display_json(&json[start..=index]));
                    }
                }
            }
            _ => {}
        }
    }

    displays
}

fn extract_object_field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let key_index = json.find(&needle)?;
    let after_key = &json[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let after_colon_offset = key_index + needle.len() + colon_index + 1;
    let after_colon = json[after_colon_offset..].trim_start();
    let trim_offset = json[after_colon_offset..].len() - after_colon.len();
    let start = after_colon_offset + trim_offset;
    if !json[start..].starts_with('{') {
        return None;
    }

    let mut depth = 0_i32;
    for (relative_index, ch) in json[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&json[start..=start + relative_index]);
                }
            }
            _ => {}
        }
    }

    None
}

fn home_dir() -> Result<String, String> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "failed to resolve home directory".to_string())
}

fn temp_dir() -> String {
    std::env::var(if cfg!(windows) { "TEMP" } else { "TMPDIR" })
        .or_else(|_| std::env::var("TMP"))
        .unwrap_or_else(|_| if cfg!(windows) { "C:\\Temp" } else { "/tmp" }.to_string())
}

fn app_data_dir(home: &str) -> String {
    if cfg!(target_os = "macos") {
        join_path(home, "Library/Application Support")
    } else if cfg!(windows) {
        std::env::var("APPDATA").unwrap_or_else(|_| join_path(home, "AppData/Roaming"))
    } else {
        std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| join_path(home, ".local/share"))
    }
}

fn config_dir(home: &str) -> String {
    if cfg!(target_os = "macos") {
        join_path(home, "Library/Application Support")
    } else if cfg!(windows) {
        std::env::var("APPDATA").unwrap_or_else(|_| join_path(home, "AppData/Roaming"))
    } else {
        std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| join_path(home, ".config"))
    }
}

fn cache_dir(home: &str) -> String {
    if cfg!(target_os = "macos") {
        join_path(home, "Library/Caches")
    } else if cfg!(windows) {
        std::env::var("LOCALAPPDATA").unwrap_or_else(|_| join_path(home, "AppData/Local"))
    } else {
        std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| join_path(home, ".cache"))
    }
}

fn logs_dir(home: &str) -> String {
    if cfg!(target_os = "macos") {
        join_path(home, "Library/Logs")
    } else {
        cache_dir(home)
    }
}

fn user_dir(home: &str, name: &str) -> String {
    join_path(home, name)
}

fn join_path(base: &str, child: &str) -> String {
    let mut path = PathBuf::from(base);
    path.push(child);
    path.to_string_lossy().into_owned()
}

fn app_scoped_name(app_info: &AppInfo) -> String {
    if app_info.identifier.is_empty() {
        app_info.name.clone()
    } else {
        app_info.identifier.clone()
    }
}
