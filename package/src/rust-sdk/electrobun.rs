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
                return Err(format!("failed to load dynamic library: {}", path.display()));
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
type ConfigureWebviewRuntimeFn =
    unsafe extern "C" fn(u32, *const c_char, *const c_char) -> bool;
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
type CloseWindowFn = unsafe extern "C" fn(u32);
type SendHostMessageToWebviewViaTransportFn =
    unsafe extern "C" fn(u32, *const c_char) -> bool;
type PopNextQueuedHostMessageFn = unsafe extern "C" fn(*mut u32) -> *mut c_char;
type FreeCoreStringFn = unsafe extern "C" fn(*mut c_char);
type EvaluateJavaScriptWithNoCompletionFn = unsafe extern "C" fn(u32, *const c_char);

struct Symbols {
    last_error: LastErrorFn,
    run_main_thread: RunMainThreadFn,
    configure_webview_runtime: ConfigureWebviewRuntimeFn,
    get_window_style: GetWindowStyleFn,
    create_window: CreateWindowFn,
    create_webview: CreateWebviewFn,
    close_window: CloseWindowFn,
    send_host_message_to_webview_via_transport: SendHostMessageToWebviewViaTransportFn,
    pop_next_queued_host_message: PopNextQueuedHostMessageFn,
    free_core_string: FreeCoreStringFn,
    evaluate_javascript_with_no_completion: EvaluateJavaScriptWithNoCompletionFn,
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
            close_window: lib.symbol("closeWindow")?,
            send_host_message_to_webview_via_transport: lib
                .symbol("sendHostMessageToWebviewViaTransport")?,
            pop_next_queued_host_message: lib.symbol("popNextQueuedHostMessage")?,
            free_core_string: lib.symbol("freeCoreString")?,
            evaluate_javascript_with_no_completion: lib
                .symbol("evaluateJavaScriptWithNoCompletion")?,
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
                options.callbacks.host_bridge.or(options.callbacks.bun_bridge),
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

    pub fn run_main_thread(&self, app_info: &AppInfo) -> Result<(), String> {
        let identifier = to_c_string(&app_info.identifier, "app identifier")?;
        let name = to_c_string(&app_info.name, "app name")?;
        let channel = to_c_string(&app_info.channel, "app channel")?;
        let status = unsafe {
            (self.symbols.run_main_thread)(
                identifier.as_ptr(),
                name.as_ptr(),
                channel.as_ptr(),
                0,
            )
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
