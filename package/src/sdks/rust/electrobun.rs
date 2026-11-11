use std::ffi::{CStr, CString};
use std::fs;
use std::mem;
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Mutex;

pub const INSTALL_ROOT_NAME_ENVIRONMENT_VARIABLE: &str = "ELECTROBUN_INSTALL_ROOT_NAME";

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
pub type WindowShouldCloseHandler = extern "C" fn(u32);
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

// Quit-requested plumbing.
//
// The core invokes its quit-requested handler when the last window closes (see
// `set_exit_on_last_window_closed`, on by default), when the app is asked to
// terminate (Cmd+Q), and on SIGINT/SIGTERM. The JS SDK always registers a
// handler, which is why closing the last window quits a Bun app. Rust apps used
// to leave the handler unset, so the process kept running headless after the
// last window closed. `Core::load` now installs the trampoline below so every
// Rust app gets the same default: stop the event loop, which lets
// `run_main_thread` return and `main` unwind normally.
static QUIT_REQUESTED_STOP_EVENT_LOOP: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
static QUIT_REQUESTED_USER_HANDLER: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());

extern "C" fn quit_requested_trampoline() {
    let user = QUIT_REQUESTED_USER_HANDLER.load(Ordering::Acquire);
    if !user.is_null() {
        let handler: QuitRequestedHandler = unsafe { mem::transmute(user) };
        handler();
        return;
    }
    let stop = QUIT_REQUESTED_STOP_EVENT_LOOP.load(Ordering::Acquire);
    if !stop.is_null() {
        let stop_event_loop: StopEventLoopFn = unsafe { mem::transmute(stop) };
        unsafe { stop_event_loop() };
    }
}

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

impl AppInfo {
    /// Returns true only for the canonical stable and canary release channels.
    pub fn is_packaged(&self) -> bool {
        matches!(self.channel.as_str(), "stable" | "canary")
    }
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
    pub should_close: Option<WindowShouldCloseHandler>,
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
    pub centered: bool,
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
            centered: false,
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

#[derive(Clone, Copy)]
pub struct AllowedProtocols {
    pub views: bool,
    pub app_data: bool,
}

impl Default for AllowedProtocols {
    fn default() -> Self {
        Self {
            views: true,
            app_data: false,
        }
    }
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
    pub allowed_protocols: AllowedProtocols,
    pub sandbox: bool,
    pub start_transparent: bool,
    pub start_passthrough: bool,
    /// Effective only for macOS native WKWebView. Other renderers report false.
    pub spell_check: bool,
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
            allowed_protocols: AllowedProtocols::default(),
            sandbox: true,
            start_transparent: false,
            start_passthrough: false,
            spell_check: false,
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

        Ok(Self {
            home,
            user_data: app_scoped_dir(&app_data, app_info),
            user_cache: app_scoped_dir(&cache, app_info),
            user_logs: app_scoped_dir(&logs, app_info),
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

pub struct WgpuAdapterDevice {
    pub adapter: *mut c_void,
    pub device: *mut c_void,
}

pub struct WgpuNative {
    _lib: dynlib::DynamicLibrary,
    create_instance: unsafe extern "C" fn(*const c_void) -> *mut c_void,
    device_get_queue: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
}

unsafe impl Send for WgpuNative {}
unsafe impl Sync for WgpuNative {}

impl WgpuNative {
    pub fn load() -> Result<Self, String> {
        let bundle_paths = resolve_bundle_paths()?;
        let lib_path = bundle_paths.exe_dir.join(wgpu_library_name());
        let lib = dynlib::DynamicLibrary::open(&lib_path)?;

        Ok(Self {
            create_instance: lib.symbol("wgpuCreateInstance")?,
            device_get_queue: lib.symbol("wgpuDeviceGetQueue")?,
            _lib: lib,
        })
    }

    pub fn symbol<T: Copy>(&self, name: &str) -> Result<T, String> {
        self._lib.symbol(name)
    }

    pub fn create_instance(&self) -> Result<*mut c_void, String> {
        let instance = unsafe { (self.create_instance)(std::ptr::null()) };
        if instance.is_null() {
            Err("failed to create WGPU instance".to_string())
        } else {
            Ok(instance)
        }
    }

    pub fn device_get_queue(&self, device: *mut c_void) -> Result<*mut c_void, String> {
        let queue = unsafe { (self.device_get_queue)(device) };
        if queue.is_null() {
            Err("failed to get WGPU queue".to_string())
        } else {
            Ok(queue)
        }
    }
}

#[derive(Clone, Copy)]
pub struct WgpuContext {
    pub view_ptr: *mut c_void,
    pub instance_ptr: *mut c_void,
    pub surface_ptr: *mut c_void,
    pub adapter_ptr: *mut c_void,
    pub device_ptr: *mut c_void,
}

impl WgpuContext {
    pub fn create_for_view(
        core: &Core,
        native: &WgpuNative,
        view_ptr: *mut c_void,
    ) -> Result<Self, String> {
        let instance_ptr = native.create_instance()?;
        let surface_ptr = core.wgpu_create_surface_for_view(instance_ptr, view_ptr)?;
        let adapter_device =
            core.wgpu_create_adapter_device_main_thread(instance_ptr, surface_ptr)?;

        Ok(Self {
            view_ptr,
            instance_ptr,
            surface_ptr,
            adapter_ptr: adapter_device.adapter,
            device_ptr: adapter_device.device,
        })
    }

    pub fn create_for_wgpu_view(
        core: &Core,
        native: &WgpuNative,
        wgpu_view_id: u32,
    ) -> Result<Self, String> {
        let view_ptr = core.get_wgpu_view_pointer(wgpu_view_id)?;
        Self::create_for_view(core, native, view_ptr)
    }

    pub fn get_queue(&self, native: &WgpuNative) -> Result<*mut c_void, String> {
        native.device_get_queue(self.device_ptr)
    }
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

/// Reads `runtime.exitOnLastWindowClosed` out of the bundled
/// Resources/build.json, the same value the JS SDK reads through BuildConfig.
/// Anything missing or malformed falls back to the documented default: quit when
/// the last window closes.
pub fn exit_on_last_window_closed_from_build_config(bundle_paths: &BundlePaths) -> bool {
    let Ok(build_json) = fs::read_to_string(bundle_paths.resources_dir.join("build.json")) else {
        return true;
    };
    let Some(runtime_object) = json_object_field(&build_json, "runtime") else {
        return true;
    };
    json_bool_field(runtime_object, "exitOnLastWindowClosed").unwrap_or(true)
}

pub const DEFAULT_INSIGHTS_API_URL: &str = "https://api.electrobun.dev";

/// App-scoped installation identity shared by managed updates and Insights.
/// Configuring this local identity never enables analytics or starts a session.
#[derive(Clone, Debug, Default)]
pub struct InstallationConfig {
    /// Optional managed-service app ID used to migrate an older Insights identity.
    pub app_id: Option<String>,
    /// Use the same directory as Insights to preserve existing installation IDs.
    pub storage_path: String,
}

impl InstallationConfig {
    fn to_json(&self) -> String {
        let mut json = format!("{{\"storagePath\":{}", json_string_literal(&self.storage_path));
        if let Some(app_id) = &self.app_id {
            json.push_str(&format!(",\"appId\":{}", json_string_literal(app_id)));
        }
        json.push('}');
        json
    }
}

/// Resolves the app's shared identity, with or without managed services.
/// The Insights collection preference does not affect installation identity.
pub fn installation_config_from_bundle(bundle_paths: &BundlePaths) -> Option<InstallationConfig> {
    let build_json = fs::read_to_string(bundle_paths.resources_dir.join("build.json")).ok()?;
    let version_json = fs::read_to_string(bundle_paths.resources_dir.join("version.json")).ok()?;
    let app_info = insights_app_info_from_json(&version_json)?;
    let storage_path = PathBuf::from(Paths::resolve(&app_info).ok()?.user_data)
        .join("insights")
        .to_string_lossy()
        .into_owned();
    installation_config_from_json(&build_json, &version_json, storage_path)
}

fn installation_config_from_json(
    build_json: &str,
    version_json: &str,
    storage_path: String,
) -> Option<InstallationConfig> {
    insights_json_object_fields(build_json)?;
    insights_json_object_fields(version_json)?;
    let mut app_id: Option<String> = None;
    for (source, key) in [
        (build_json, "insights"),
        (build_json, "managed"),
        (version_json, "managed"),
    ] {
        if let Some(settings) = insights_json_field(source, key) {
            // Optional settings may be null when the corresponding service is off.
            if settings == "null" {
                continue;
            }
            let candidate = insights_json_string(settings, "appId")?;
            if candidate.is_empty()
                || app_id.as_ref().is_some_and(|existing| existing != &candidate)
            {
                return None;
            }
            app_id = Some(candidate);
        }
    }
    Some(InstallationConfig {
        app_id,
        storage_path,
    })
}

/// Native Electrobun Insights configuration. Network requests and the bounded
/// offline queue are owned by the core, independently of the update mechanism.
#[derive(Clone, Debug)]
pub struct InsightsConfig {
    pub app_id: String,
    /// Defaults to Electrobun Insights; override only for local or staging services.
    pub api_url: String,
    /// Parent directory for app-scoped identity and queued events.
    pub storage_path: String,
    /// Initial collection preference, disabled unless explicitly enabled.
    /// The native core preserves a user's later runtime choice across launches.
    pub enabled: bool,
    pub version: String,
    pub build_hash: String,
    pub channel: String,
    pub distribution: String,
    pub update_authority: String,
    pub platform: String,
    pub arch: String,
}

impl Default for InsightsConfig {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            api_url: DEFAULT_INSIGHTS_API_URL.into(),
            storage_path: String::new(),
            enabled: false,
            version: "0.0.0".into(),
            build_hash: String::new(),
            channel: "dev".into(),
            distribution: "direct".into(),
            update_authority: "direct".into(),
            platform: if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(target_os = "windows") {
                "win"
            } else {
                std::env::consts::OS
            }
            .into(),
            arch: match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                arch => arch,
            }
            .into(),
        }
    }
}

impl InsightsConfig {
    fn to_json(&self) -> String {
        let fields = [
            ("appId", &self.app_id),
            ("apiUrl", &self.api_url),
            ("storagePath", &self.storage_path),
            ("version", &self.version),
            ("buildHash", &self.build_hash),
            ("channel", &self.channel),
            ("distribution", &self.distribution),
            ("updateAuthority", &self.update_authority),
            ("platform", &self.platform),
            ("arch", &self.arch),
        ];
        let mut json = format!("{{\"enabled\":{}", self.enabled);
        for (name, value) in fields {
            json.push_str(&format!(",\"{name}\":{}", json_string_literal(value)));
        }
        json.push('}');
        json
    }
}

/// Missing or malformed configuration leaves telemetry off. Every channel
/// defaults to disabled unless `insights.enabled: true` is explicitly supplied.
pub fn insights_config_from_bundle(bundle_paths: &BundlePaths) -> Option<InsightsConfig> {
    let build_json = fs::read_to_string(bundle_paths.resources_dir.join("build.json")).ok()?;
    let version_json = fs::read_to_string(bundle_paths.resources_dir.join("version.json")).ok()?;
    let app_info = insights_app_info_from_json(&version_json)?;
    let storage_path = PathBuf::from(Paths::resolve(&app_info).ok()?.user_data)
        .join("insights")
        .to_string_lossy()
        .into_owned();
    insights_config_from_json(&build_json, &version_json, storage_path)
}

fn insights_app_info_from_json(version_json: &str) -> Option<AppInfo> {
    let identifier = insights_json_string(version_json, "identifier")?;
    if identifier.is_empty() {
        return None;
    }
    Some(AppInfo {
        identifier,
        name: insights_json_string(version_json, "name").unwrap_or_else(|| "Electrobun".into()),
        channel: insights_json_string(version_json, "channel").unwrap_or_else(|| "dev".into()),
    })
}

fn insights_config_from_json(
    build_json: &str,
    version_json: &str,
    storage_path: String,
) -> Option<InsightsConfig> {
    let insights = insights_json_field(build_json, "insights")?;
    let app_id = insights_json_string(insights, "appId")?;
    let api_url = match insights_json_field(insights, "apiUrl") {
        None => DEFAULT_INSIGHTS_API_URL.into(),
        Some(value) => insights_decode_string(value)?,
    };
    if app_id.is_empty() || api_url.is_empty() {
        return None;
    }
    // Also validate version.json even when all optional fields are absent.
    insights_json_object_fields(version_json)?;
    let channel = insights_json_string(version_json, "channel").unwrap_or_else(|| "dev".into());
    let enabled = match insights_json_field(insights, "enabled") {
        Some("true") => true,
        Some("false") => false,
        None => false,
        _ => return None,
    };
    let update_authority = insights_json_string(version_json, "updateAuthority")
        .or_else(|| insights_json_string(build_json, "updateAuthority"))
        .unwrap_or_else(|| "direct".into());
    if !matches!(update_authority.as_str(), "direct" | "external" | "none") {
        return None;
    }
    Some(InsightsConfig {
        app_id,
        api_url,
        storage_path,
        enabled,
        channel,
        update_authority,
        version: insights_json_string(version_json, "version").unwrap_or_else(|| "0.0.0".into()),
        build_hash: insights_json_string(version_json, "hash").unwrap_or_default(),
        distribution: insights_json_string(version_json, "distribution")
            .or_else(|| insights_json_string(build_json, "distribution"))
            .unwrap_or_else(|| "direct".into()),
        ..InsightsConfig::default()
    })
}

// These readers deliberately inspect only direct object members. The older
// general SDK helpers search strings by key, which could enable collection
// from a nested `insights` example or read a nested `enabled` flag by mistake.
fn insights_json_field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    insights_json_object_fields(source)?
        .into_iter()
        .find_map(|(name, value)| if name == key { Some(value) } else { None })
}

fn insights_json_string(source: &str, key: &str) -> Option<String> {
    insights_decode_string(insights_json_field(source, key)?)
}

fn insights_json_object_fields(source: &str) -> Option<Vec<(String, &str)>> {
    let source = source.trim();
    // Validate the complete object, including trailing members and values.
    if !source.starts_with('{') || insights_json_value_end(source, 0, 0)? != source.len() {
        return None;
    }
    let mut fields = Vec::new();
    let mut offset = 1;
    loop {
        offset = insights_skip_space(source, offset);
        if source.as_bytes().get(offset) == Some(&b'}') {
            return Some(fields);
        }
        let end = insights_json_string_end(source, offset)?;
        let key = insights_decode_string(&source[offset..end])?;
        if fields.iter().any(|(name, _)| name == &key) {
            return None;
        }
        offset = insights_skip_space(source, end) + 1; // Validated colon.
        offset = insights_skip_space(source, offset);
        let end = insights_json_value_end(source, offset, 0)?;
        fields.push((key, &source[offset..end]));
        offset = insights_skip_space(source, end);
        if source.as_bytes().get(offset) == Some(&b'}') {
            return Some(fields);
        }
        offset += 1; // Validated comma.
    }
}

fn insights_skip_space(source: &str, mut offset: usize) -> usize {
    while matches!(
        source.as_bytes().get(offset),
        Some(b' ' | b'\t' | b'\r' | b'\n')
    ) {
        offset += 1;
    }
    offset
}

fn insights_json_string_end(source: &str, start: usize) -> Option<usize> {
    if source.as_bytes().get(start) != Some(&b'"') {
        return None;
    }
    let mut offset = start + 1;
    while let Some(&byte) = source.as_bytes().get(offset) {
        match byte {
            b'"' => {
                let end = offset + 1;
                insights_decode_string(&source[start..end])?;
                return Some(end);
            }
            b'\\' => {
                offset += 1;
                source.as_bytes().get(offset)?;
            }
            0..=31 => return None,
            _ => {}
        }
        offset += 1;
    }
    None
}

fn insights_decode_string(source: &str) -> Option<String> {
    let mut chars = source.strip_prefix('"')?.strip_suffix('"')?.chars();
    let mut result = String::new();
    while let Some(ch) = chars.next() {
        match ch {
            '"' | '\u{0000}'..='\u{001f}' => return None,
            '\\' => result.push(match chars.next()? {
                '"' => '"',
                '\\' => '\\',
                '/' => '/',
                'b' => '\u{0008}',
                'f' => '\u{000c}',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'u' => {
                    let mut code = 0u32;
                    for _ in 0..4 {
                        code = code * 16 + chars.next()?.to_digit(16)?;
                    }
                    if (0xd800..=0xdbff).contains(&code) {
                        if chars.next()? != '\\' || chars.next()? != 'u' {
                            return None;
                        }
                        let mut low = 0u32;
                        for _ in 0..4 {
                            low = low * 16 + chars.next()?.to_digit(16)?;
                        }
                        if !(0xdc00..=0xdfff).contains(&low) {
                            return None;
                        }
                        code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
                    }
                    char::from_u32(code)?
                }
                _ => return None,
            }),
            _ => result.push(ch),
        }
    }
    Some(result)
}

fn insights_json_value_end(source: &str, start: usize, depth: usize) -> Option<usize> {
    if depth > 64 {
        return None;
    }
    let bytes = source.as_bytes();
    match *bytes.get(start)? {
        b'"' => insights_json_string_end(source, start),
        b'{' | b'[' => {
            let object = bytes[start] == b'{';
            let close = if object { b'}' } else { b']' };
            let mut offset = insights_skip_space(source, start + 1);
            if bytes.get(offset) == Some(&close) {
                return Some(offset + 1);
            }
            loop {
                if object {
                    offset = insights_skip_space(source, insights_json_string_end(source, offset)?);
                    if bytes.get(offset) != Some(&b':') {
                        return None;
                    }
                    offset = insights_skip_space(source, offset + 1);
                }
                offset = insights_skip_space(
                    source,
                    insights_json_value_end(source, offset, depth + 1)?,
                );
                if bytes.get(offset) == Some(&close) {
                    return Some(offset + 1);
                }
                if bytes.get(offset) != Some(&b',') {
                    return None;
                }
                offset = insights_skip_space(source, offset + 1);
            }
        }
        b't' if source[start..].starts_with("true") => Some(start + 4),
        b'f' if source[start..].starts_with("false") => Some(start + 5),
        b'n' if source[start..].starts_with("null") => Some(start + 4),
        b'-' | b'0'..=b'9' => {
            let mut offset = start;
            if bytes.get(offset) == Some(&b'-') {
                offset += 1;
            }
            match bytes.get(offset) {
                Some(b'0') => offset += 1,
                Some(b'1'..=b'9') => {
                    offset += 1;
                    while matches!(bytes.get(offset), Some(b'0'..=b'9')) {
                        offset += 1;
                    }
                }
                _ => return None,
            }
            if bytes.get(offset) == Some(&b'.') {
                offset += 1;
                let digit_start = offset;
                while matches!(bytes.get(offset), Some(b'0'..=b'9')) {
                    offset += 1;
                }
                if digit_start == offset {
                    return None;
                }
            }
            if matches!(bytes.get(offset), Some(b'e' | b'E')) {
                offset += 1;
                if matches!(bytes.get(offset), Some(b'+' | b'-')) {
                    offset += 1;
                }
                let digit_start = offset;
                while matches!(bytes.get(offset), Some(b'0'..=b'9')) {
                    offset += 1;
                }
                if digit_start == offset {
                    return None;
                }
            }
            Some(offset)
        }
        _ => None,
    }
}

/// Updater failures are reported explicitly, including cores predating this API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdaterError {
    Unavailable(String),
    InvalidConfiguration(String),
    InvalidResponse(String),
    CoreFailure(String),
    Rejected {
        operation_id: Option<String>,
        message: String,
    },
}

impl std::fmt::Display for UpdaterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(message) => write!(formatter, "updater unavailable: {message}"),
            Self::InvalidConfiguration(message) => {
                write!(formatter, "invalid updater configuration: {message}")
            }
            Self::InvalidResponse(message) => {
                write!(formatter, "invalid updater response: {message}")
            }
            Self::CoreFailure(message) => write!(formatter, "updater failed: {message}"),
            Self::Rejected { message, .. } => {
                write!(formatter, "updater request rejected: {message}")
            }
        }
    }
}

impl std::error::Error for UpdaterError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterManagedInfo {
    pub app_id: String,
    pub api_url: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalUpdateInfo {
    pub version: String,
    pub hash: String,
    pub base_url: String,
    pub channel: String,
    pub name: String,
    pub display_name: Option<String>,
    pub identifier: String,
    pub managed: Option<UpdaterManagedInfo>,
    pub update_authority: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub hash: String,
    pub update_available: bool,
    pub update_ready: bool,
    pub error: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdaterOperationState {
    Idle,
    Queued,
    Running,
    AwaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterApproval {
    pub id: String,
    pub prepared_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterOperation {
    pub operation_id: String,
    pub operation: String,
    pub state: UpdaterOperationState,
    pub error: Option<String>,
    pub update_info: Option<UpdateInfo>,
}

/// A snapshot of core-owned update work. Approval alone does not mean that the
/// application can quit: wait for `quit_ready` before normal event-loop teardown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterState {
    pub schema_version: u32,
    pub revision: u64,
    pub operation_id: Option<String>,
    pub operation: Option<String>,
    pub operation_state: UpdaterOperationState,
    pub local_info: LocalUpdateInfo,
    pub update_info: UpdateInfo,
    pub approval: Option<UpdaterApproval>,
    pub quit_ready: bool,
    pub channel_root: String,
    /// Bounded terminal operation history retained by the core.
    pub operations: Vec<UpdaterOperation>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdaterRequestResult {
    pub schema_version: u32,
    pub accepted: bool,
    pub operation_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpdateStatusDetails {
    pub from_hash: Option<String>,
    pub to_hash: Option<String>,
    pub current_hash: Option<String>,
    pub latest_hash: Option<String>,
    pub patch_number: Option<u64>,
    pub total_patches_applied: Option<u64>,
    pub progress: Option<f64>,
    pub bytes_downloaded: Option<u64>,
    pub total_bytes: Option<u64>,
    pub used_patch_path: Option<bool>,
    pub error_message: Option<String>,
    pub url: Option<String>,
    pub zstd_path: Option<String>,
    pub exit_code: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdaterEvent {
    pub sequence: u64,
    pub operation_id: Option<String>,
    /// Uses the same status names as the JavaScript updater.
    pub status: String,
    pub message: String,
    pub timestamp: i64,
    pub details: Option<UpdateStatusDetails>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdaterEvents {
    pub schema_version: u32,
    pub entries: Vec<UpdaterEvent>,
    pub next_sequence: u64,
    pub oldest_sequence: u64,
    /// True when the caller's cursor predates the bounded event buffer.
    pub overflow: bool,
}

// The SDK remains a standalone, dependency-free Rust source file. These typed
// readers reuse the strict JSON tokenizer used for bundled service settings.
struct UpdaterJson<'a>(Vec<(String, &'a str)>);

impl<'a> UpdaterJson<'a> {
    fn new(source: &'a str) -> Result<Self, UpdaterError> {
        insights_json_object_fields(source)
            .map(Self)
            .ok_or_else(|| UpdaterError::InvalidResponse("expected a valid JSON object".into()))
    }

    fn get(&self, key: &str) -> Option<&'a str> {
        self.0
            .iter()
            .find_map(|(name, value)| (name == key).then_some(*value))
    }

    fn required(&self, key: &str) -> Result<&'a str, UpdaterError> {
        self.get(key).ok_or_else(|| Self::invalid(key))
    }

    fn invalid(key: &str) -> UpdaterError {
        UpdaterError::InvalidResponse(format!("missing or invalid {key}"))
    }

    fn string(&self, key: &str) -> Result<String, UpdaterError> {
        insights_decode_string(self.required(key)?).ok_or_else(|| Self::invalid(key))
    }

    fn optional_string(&self, key: &str) -> Result<Option<String>, UpdaterError> {
        self.optional(key, |source| {
            insights_decode_string(source).ok_or_else(|| Self::invalid(key))
        })
    }

    fn nullable_string(&self, key: &str) -> Result<Option<String>, UpdaterError> {
        self.required(key)?;
        self.optional_string(key)
    }

    fn nullable<T>(
        &self,
        key: &str,
        parse: impl FnOnce(&'a str) -> Result<T, UpdaterError>,
    ) -> Result<Option<T>, UpdaterError> {
        self.required(key)?;
        self.optional(key, parse)
    }

    fn boolean(&self, key: &str) -> Result<bool, UpdaterError> {
        match self.required(key)? {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(Self::invalid(key)),
        }
    }

    fn number<T: std::str::FromStr>(&self, key: &str) -> Result<T, UpdaterError> {
        self.required(key)?.parse().map_err(|_| Self::invalid(key))
    }

    fn optional_number<T: std::str::FromStr>(&self, key: &str) -> Result<Option<T>, UpdaterError> {
        self.optional(key, |source| source.parse().map_err(|_| Self::invalid(key)))
    }

    fn optional<T>(
        &self,
        key: &str,
        parse: impl FnOnce(&'a str) -> Result<T, UpdaterError>,
    ) -> Result<Option<T>, UpdaterError> {
        match self.get(key) {
            None | Some("null") => Ok(None),
            Some(source) => parse(source).map(Some),
        }
    }

    fn schema(&self) -> Result<u32, UpdaterError> {
        match self.number::<u32>("schemaVersion")? {
            1 => Ok(1),
            version => Err(UpdaterError::InvalidResponse(format!(
                "unsupported schemaVersion {version}"
            ))),
        }
    }

    fn array<T>(
        &self,
        key: &str,
        parse: impl Fn(&str) -> Result<T, UpdaterError>,
    ) -> Result<Vec<T>, UpdaterError> {
        let source = self.required(key)?;
        if !source.starts_with('[') {
            return Err(Self::invalid(key));
        }
        let mut values = Vec::new();
        let mut offset = 1;
        loop {
            offset = insights_skip_space(source, offset);
            if source.as_bytes().get(offset) == Some(&b']') {
                return Ok(values);
            }
            let end =
                insights_json_value_end(source, offset, 0).ok_or_else(|| Self::invalid(key))?;
            values.push(parse(&source[offset..end])?);
            offset = insights_skip_space(source, end);
            if source.as_bytes().get(offset) == Some(&b',') {
                offset += 1;
            }
        }
    }
}

impl LocalUpdateInfo {
    fn from_json(source: &str) -> Result<Self, UpdaterError> {
        let json = UpdaterJson::new(source)?;
        Ok(Self {
            version: json.string("version")?,
            hash: json.string("hash")?,
            base_url: json.string("baseUrl")?,
            channel: json.string("channel")?,
            name: json.string("name")?,
            display_name: json.optional_string("displayName")?,
            identifier: json.string("identifier")?,
            managed: json.optional("managed", |source| {
                let managed = UpdaterJson::new(source)?;
                Ok(UpdaterManagedInfo {
                    app_id: managed.string("appId")?,
                    api_url: managed.optional_string("apiUrl")?,
                    base_url: managed.optional_string("baseUrl")?,
                })
            })?,
            update_authority: json.optional_string("updateAuthority")?,
        })
    }
}

impl UpdateInfo {
    fn from_json(source: &str) -> Result<Self, UpdaterError> {
        let json = UpdaterJson::new(source)?;
        Ok(Self {
            version: json.string("version")?,
            hash: json.string("hash")?,
            update_available: json.boolean("updateAvailable")?,
            update_ready: json.boolean("updateReady")?,
            error: json.string("error")?,
        })
    }
}

impl UpdaterOperationState {
    fn parse(state: &str) -> Result<Self, UpdaterError> {
        match state {
            "idle" => Ok(Self::Idle),
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "awaitingApproval" => Ok(Self::AwaitingApproval),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(UpdaterError::InvalidResponse(format!(
                "unknown operation state {state}"
            ))),
        }
    }
}

impl UpdaterState {
    fn from_json(source: &str) -> Result<Self, UpdaterError> {
        let json = UpdaterJson::new(source)?;
        Ok(Self {
            schema_version: json.schema()?,
            revision: json.number("revision")?,
            operation_id: json.nullable_string("operationId")?,
            operation: json.nullable_string("operation")?,
            operation_state: UpdaterOperationState::parse(&json.string("operationState")?)?,
            local_info: LocalUpdateInfo::from_json(json.required("localInfo")?)?,
            update_info: UpdateInfo::from_json(json.required("updateInfo")?)?,
            approval: json.nullable("approval", |source| {
                let approval = UpdaterJson::new(source)?;
                Ok(UpdaterApproval {
                    id: approval.string("id")?,
                    prepared_hash: approval.string("preparedHash")?,
                })
            })?,
            quit_ready: json.boolean("quitReady")?,
            channel_root: json.string("channelRoot")?,
            operations: json.array("operations", |source| {
                let operation = UpdaterJson::new(source)?;
                Ok(UpdaterOperation {
                    operation_id: operation.string("operationId")?,
                    operation: operation.string("operation")?,
                    state: UpdaterOperationState::parse(&operation.string("state")?)?,
                    error: operation.nullable_string("error")?,
                    update_info: operation.nullable("updateInfo", UpdateInfo::from_json)?,
                })
            })?,
        })
    }
}

impl UpdaterRequestResult {
    fn from_json(source: &str) -> Result<Self, UpdaterError> {
        let json = UpdaterJson::new(source)?;
        let result = Self {
            schema_version: json.schema()?,
            accepted: json.boolean("accepted")?,
            operation_id: json.nullable_string("operationId")?,
            error: json.nullable_string("error")?,
        };
        if !result.accepted {
            return Err(UpdaterError::Rejected {
                operation_id: result.operation_id,
                message: result
                    .error
                    .unwrap_or_else(|| "core rejected the request".into()),
            });
        }
        if result.operation_id.as_deref().is_none_or(str::is_empty) || result.error.is_some() {
            return Err(UpdaterError::InvalidResponse(
                "accepted request has no operation ID or contains an error".into(),
            ));
        }
        Ok(result)
    }
}

impl UpdateStatusDetails {
    fn from_json(source: &str) -> Result<Self, UpdaterError> {
        let json = UpdaterJson::new(source)?;
        let progress: Option<f64> = json.optional_number("progress")?;
        if progress.is_some_and(|value| !value.is_finite()) {
            return Err(UpdaterJson::invalid("progress"));
        }
        Ok(Self {
            from_hash: json.optional_string("fromHash")?,
            to_hash: json.optional_string("toHash")?,
            current_hash: json.optional_string("currentHash")?,
            latest_hash: json.optional_string("latestHash")?,
            patch_number: json.optional_number("patchNumber")?,
            total_patches_applied: json.optional_number("totalPatchesApplied")?,
            progress,
            bytes_downloaded: json.optional_number("bytesDownloaded")?,
            total_bytes: json.optional_number("totalBytes")?,
            used_patch_path: json.optional("usedPatchPath", |source| match source {
                "true" => Ok(true),
                "false" => Ok(false),
                _ => Err(UpdaterJson::invalid("usedPatchPath")),
            })?,
            error_message: json.optional_string("errorMessage")?,
            url: json.optional_string("url")?,
            zstd_path: json.optional_string("zstdPath")?,
            exit_code: json.optional_number("exitCode")?,
        })
    }
}

impl UpdaterEvents {
    fn from_json(source: &str) -> Result<Self, UpdaterError> {
        let json = UpdaterJson::new(source)?;
        Ok(Self {
            schema_version: json.schema()?,
            next_sequence: json.number("nextSequence")?,
            oldest_sequence: json.number("oldestSequence")?,
            overflow: json.boolean("overflow")?,
            entries: json.array("entries", |source| {
                let event = UpdaterJson::new(source)?;
                Ok(UpdaterEvent {
                    sequence: event.number("sequence")?,
                    operation_id: event.optional_string("operationId")?,
                    status: event.string("status")?,
                    message: event.string("message")?,
                    timestamp: event.number("timestamp")?,
                    details: event.optional("details", UpdateStatusDetails::from_json)?,
                })
            })?,
        })
    }
}

enum UpdaterRequest<'a> {
    Check,
    Download,
    RequestApply,
    ApproveApply {
        operation_id: &'a str,
        approval_id: &'a str,
        approved: bool,
    },
    Reconcile,
    Cancel {
        operation_id: &'a str,
    },
}

impl UpdaterRequest<'_> {
    fn to_json(&self) -> String {
        match self {
            Self::ApproveApply { operation_id, approval_id, approved } => format!(
                "{{\"schemaVersion\":1,\"action\":\"approveApply\",\"operationId\":{},\"approvalId\":{},\"approved\":{approved}}}",
                json_string_literal(operation_id), json_string_literal(approval_id),
            ),
            Self::Cancel { operation_id } => format!(
                "{{\"schemaVersion\":1,\"action\":\"cancel\",\"operationId\":{}}}", json_string_literal(operation_id),
            ),
            action => {
                let name = match action {
                    Self::Check => "check",
                    Self::Download => "download",
                    Self::RequestApply => "requestApply",
                    Self::Reconcile => "reconcile",
                    _ => unreachable!(),
                };
                format!("{{\"schemaVersion\":1,\"action\":\"{name}\"}}")
            }
        }
    }
}

type UpdaterConfigureFn = unsafe extern "C" fn(*const c_char) -> bool;
type UpdaterRequestFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type UpdaterGetStateFn = unsafe extern "C" fn() -> *mut c_char;
type UpdaterGetEventsFn = unsafe extern "C" fn(u64, u32) -> *mut c_char;
type UpdaterShutdownFn = unsafe extern "C" fn();

#[derive(Default)]
struct UpdaterSymbols {
    configure: Option<UpdaterConfigureFn>,
    request: Option<UpdaterRequestFn>,
    get_state: Option<UpdaterGetStateFn>,
    get_events: Option<UpdaterGetEventsFn>,
    shutdown: Option<UpdaterShutdownFn>,
}

impl UpdaterSymbols {
    fn load(lib: &dynlib::DynamicLibrary) -> Self {
        Self {
            configure: lib.symbol("updaterConfigure").ok(),
            request: lib.symbol("updaterRequest").ok(),
            get_state: lib.symbol("updaterGetState").ok(),
            get_events: lib.symbol("updaterGetEvents").ok(),
            shutdown: lib.symbol("updaterShutdown").ok(),
        }
    }

    fn available(&self) -> Result<(), UpdaterError> {
        for (present, name) in [
            (self.configure.is_some(), "updaterConfigure"),
            (self.request.is_some(), "updaterRequest"),
            (self.get_state.is_some(), "updaterGetState"),
            (self.get_events.is_some(), "updaterGetEvents"),
            (self.shutdown.is_some(), "updaterShutdown"),
        ] {
            if !present {
                return Err(UpdaterError::Unavailable(format!(
                    "loaded core is missing {name}"
                )));
            }
        }
        Ok(())
    }
}

struct UpdaterLifecycle {
    bundle_paths: BundlePaths,
    configured: bool,
}

struct UpdaterBinding {
    symbols: UpdaterSymbols,
    // Serializes lazy configuration, API calls and shutdown. The core owns the
    // asynchronous worker; this mutex never waits for operation completion.
    lifecycle: Mutex<UpdaterLifecycle>,
}

impl UpdaterBinding {
    fn new(symbols: UpdaterSymbols, paths: &BundlePaths) -> Self {
        Self {
            symbols,
            lifecycle: Mutex::new(UpdaterLifecycle {
                bundle_paths: BundlePaths {
                    exe_dir: paths.exe_dir.clone(),
                    resources_dir: paths.resources_dir.clone(),
                },
                configured: false,
            }),
        }
    }

    fn configuration_json(paths: &BundlePaths) -> Result<CString, UpdaterError> {
        let exe_dir = paths
            .exe_dir
            .to_str()
            .ok_or_else(|| UpdaterError::InvalidConfiguration("exeDir is not UTF-8".into()))?;
        let resources_dir = paths.resources_dir.to_str().ok_or_else(|| {
            UpdaterError::InvalidConfiguration("resourcesDir is not UTF-8".into())
        })?;
        let json = format!(
            "{{\"schemaVersion\":1,\"exeDir\":{},\"resourcesDir\":{}}}",
            json_string_literal(exe_dir),
            json_string_literal(resources_dir)
        );
        CString::new(json).map_err(|error| UpdaterError::InvalidConfiguration(error.to_string()))
    }

    fn configure_locked(
        &self,
        lifecycle: &mut UpdaterLifecycle,
        paths: &BundlePaths,
        last_error: LastErrorFn,
    ) -> Result<(), UpdaterError> {
        self.symbols.available()?;
        let json = Self::configuration_json(paths)?;
        if !unsafe { (self.symbols.configure.unwrap())(json.as_ptr()) } {
            return Err(Self::core_error(last_error, "updater configuration failed"));
        }
        lifecycle.bundle_paths = BundlePaths {
            exe_dir: paths.exe_dir.clone(),
            resources_dir: paths.resources_dir.clone(),
        };
        lifecycle.configured = true;
        Ok(())
    }

    fn configure(&self, paths: &BundlePaths, last_error: LastErrorFn) -> Result<(), UpdaterError> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.configure_locked(&mut lifecycle, paths, last_error)
    }

    fn ensure_configured(
        &self,
        lifecycle: &mut UpdaterLifecycle,
        last_error: LastErrorFn,
    ) -> Result<(), UpdaterError> {
        self.symbols.available()?;
        if !lifecycle.configured {
            let paths = BundlePaths {
                exe_dir: lifecycle.bundle_paths.exe_dir.clone(),
                resources_dir: lifecycle.bundle_paths.resources_dir.clone(),
            };
            self.configure_locked(lifecycle, &paths, last_error)?;
        }
        Ok(())
    }

    fn core_error(last_error: LastErrorFn, fallback: &str) -> UpdaterError {
        let message = c_string_to_string(unsafe { last_error() });
        UpdaterError::CoreFailure(if message.is_empty() {
            fallback.into()
        } else {
            message
        })
    }

    fn take_string(
        value: *mut c_char,
        free: FreeCoreStringFn,
        last_error: LastErrorFn,
    ) -> Result<String, UpdaterError> {
        if value.is_null() {
            return Err(Self::core_error(
                last_error,
                "core returned a null updater response",
            ));
        }
        let result = unsafe { CStr::from_ptr(value) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| UpdaterError::InvalidResponse("core returned non-UTF-8 JSON".into()));
        // Return ownership even when validation or decoding fails.
        unsafe { free(value) };
        result
    }

    fn request(
        &self,
        request: UpdaterRequest<'_>,
        free: FreeCoreStringFn,
        last_error: LastErrorFn,
    ) -> Result<UpdaterRequestResult, UpdaterError> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_configured(&mut lifecycle, last_error)?;
        let json = CString::new(request.to_json())
            .map_err(|error| UpdaterError::InvalidConfiguration(error.to_string()))?;
        let response = unsafe { (self.symbols.request.unwrap())(json.as_ptr()) };
        UpdaterRequestResult::from_json(&Self::take_string(response, free, last_error)?)
    }

    fn state(
        &self,
        free: FreeCoreStringFn,
        last_error: LastErrorFn,
    ) -> Result<UpdaterState, UpdaterError> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_configured(&mut lifecycle, last_error)?;
        let response = unsafe { (self.symbols.get_state.unwrap())() };
        UpdaterState::from_json(&Self::take_string(response, free, last_error)?)
    }

    fn events(
        &self,
        after: u64,
        limit: u32,
        free: FreeCoreStringFn,
        last_error: LastErrorFn,
    ) -> Result<UpdaterEvents, UpdaterError> {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_configured(&mut lifecycle, last_error)?;
        let response = unsafe { (self.symbols.get_events.unwrap())(after, limit) };
        UpdaterEvents::from_json(&Self::take_string(response, free, last_error)?)
    }

    fn shutdown(&self) -> Result<(), UpdaterError> {
        self.symbols.available()?;
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        unsafe { (self.symbols.shutdown.unwrap())() };
        lifecycle.configured = false;
        Ok(())
    }

    fn shutdown_if_configured(&self) {
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if lifecycle.configured {
            if let Some(shutdown) = self.symbols.shutdown {
                unsafe { shutdown() };
            }
            lifecycle.configured = false;
        }
    }
}

type InsightsConfigureFn = unsafe extern "C" fn(*const c_char) -> bool;
type InsightsTrackFn = unsafe extern "C" fn(*const c_char, *const c_char) -> bool;
type InsightsIdentifyFn = unsafe extern "C" fn(*const c_char);
type InsightsActionFn = unsafe extern "C" fn();
type InsightsSetEnabledFn = unsafe extern "C" fn(bool);
type InsightsGetInstallationIdFn = unsafe extern "C" fn() -> *mut c_char;

#[derive(Default)]
struct InstallationSymbols {
    configure: Option<InsightsConfigureFn>,
    installation_id: Option<InsightsGetInstallationIdFn>,
}

impl InstallationSymbols {
    fn load(lib: &dynlib::DynamicLibrary) -> Self {
        Self {
            configure: lib.symbol("installationConfigure").ok(),
            installation_id: lib.symbol("getInstallationId").ok(),
        }
    }

    fn configure(&self, config: &InstallationConfig) -> Result<bool, String> {
        let Some(configure) = self.configure else {
            return Ok(false);
        };
        let json = to_c_string(&config.to_json(), "Installation configuration")?;
        Ok(unsafe { configure(json.as_ptr()) })
    }

    fn get_id(&self, free: FreeCoreStringFn) -> Option<String> {
        let value = unsafe { (self.installation_id?)() };
        if value.is_null() {
            return None;
        }
        let result = c_string_to_string(value);
        unsafe { free(value) };
        if result.is_empty() { None } else { Some(result) }
    }
}

#[derive(Default)]
struct InsightsSymbols {
    configure: Option<InsightsConfigureFn>,
    track: Option<InsightsTrackFn>,
    identify: Option<InsightsIdentifyFn>,
    reset: Option<InsightsActionFn>,
    set_enabled: Option<InsightsSetEnabledFn>,
    installation_id: Option<InsightsGetInstallationIdFn>,
    flush: Option<InsightsActionFn>,
    shutdown: Option<InsightsActionFn>,
}

impl InsightsSymbols {
    fn load(lib: &dynlib::DynamicLibrary) -> Self {
        Self {
            configure: lib.symbol("insightsConfigure").ok(),
            track: lib.symbol("insightsTrack").ok(),
            identify: lib.symbol("insightsIdentify").ok(),
            reset: lib.symbol("insightsReset").ok(),
            set_enabled: lib.symbol("insightsSetEnabled").ok(),
            installation_id: lib.symbol("insightsGetInstallationId").ok(),
            flush: lib.symbol("insightsFlush").ok(),
            shutdown: lib.symbol("insightsShutdown").ok(),
        }
    }
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
    bool,
    f64,
    f64,
    Option<WindowCloseHandler>,
    Option<WindowMoveHandler>,
    Option<WindowResizeHandler>,
    Option<WindowFocusHandler>,
    Option<WindowBlurHandler>,
    Option<WindowKeyHandler>,
    Option<WindowShouldCloseHandler>,
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
    bool,
) -> u32;
type SetNextWebviewAllowedProtocolsFn = unsafe extern "C" fn(bool, bool);
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
type IsWindowVisibleFn = unsafe extern "C" fn(u32) -> bool;
type SetWindowButtonPositionFn = unsafe extern "C" fn(u32, f64, f64);
type GetWindowButtonPositionFn = unsafe extern "C" fn(u32, *mut f64, *mut f64);
type SetWindowPositionFn = unsafe extern "C" fn(u32, f64, f64);
type CenterWindowFn = unsafe extern "C" fn(u32);
type SetWindowSizeFn = unsafe extern "C" fn(u32, f64, f64);
type SetWindowFrameFn = unsafe extern "C" fn(u32, f64, f64, f64, f64);
type GetWindowFrameFn = unsafe extern "C" fn(u32, *mut f64, *mut f64, *mut f64, *mut f64);
type CloseWindowFn = unsafe extern "C" fn(u32);
type RequestWindowCloseFn = unsafe extern "C" fn(u32);
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
type WebviewSetSpellCheckFn = unsafe extern "C" fn(u32, bool) -> bool;
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
type CaptureScreenRegionFn = unsafe extern "C" fn(f64, f64, u32, u32, *mut u8, u64) -> bool;
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
type SetExitOnLastWindowClosedFn = unsafe extern "C" fn(bool);
type StopEventLoopFn = unsafe extern "C" fn();
type WaitForShutdownCompleteFn = unsafe extern "C" fn(c_int);
type ForceExitFn = unsafe extern "C" fn(c_int);
type WgpuCreateSurfaceForViewFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
type WgpuCreateAdapterDeviceMainThreadFn =
    unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void);
type WgpuSurfaceConfigureMainThreadFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
type WgpuSurfaceGetCurrentTextureMainThreadFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
type WgpuSurfacePresentMainThreadFn = unsafe extern "C" fn(*mut c_void) -> c_int;

struct Symbols {
    last_error: LastErrorFn,
    run_main_thread: RunMainThreadFn,
    configure_webview_runtime: ConfigureWebviewRuntimeFn,
    get_window_style: GetWindowStyleFn,
    create_window: CreateWindowFn,
    create_webview: CreateWebviewFn,
    set_next_webview_allowed_protocols: SetNextWebviewAllowedProtocolsFn,
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
    is_window_visible: IsWindowVisibleFn,
    set_window_button_position: SetWindowButtonPositionFn,
    get_window_button_position: GetWindowButtonPositionFn,
    set_window_position: SetWindowPositionFn,
    center_window: CenterWindowFn,
    set_window_size: SetWindowSizeFn,
    set_window_frame: SetWindowFrameFn,
    get_window_frame: GetWindowFrameFn,
    close_window: CloseWindowFn,
    request_window_close: RequestWindowCloseFn,
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
    webview_set_spell_check: WebviewSetSpellCheckFn,
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
    capture_screen_region: CaptureScreenRegionFn,
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
    set_exit_on_last_window_closed: SetExitOnLastWindowClosedFn,
    stop_event_loop: StopEventLoopFn,
    wait_for_shutdown_complete: WaitForShutdownCompleteFn,
    force_exit: ForceExitFn,
    wgpu_create_surface_for_view: WgpuCreateSurfaceForViewFn,
    wgpu_create_adapter_device_main_thread: WgpuCreateAdapterDeviceMainThreadFn,
    wgpu_surface_configure_main_thread: WgpuSurfaceConfigureMainThreadFn,
    wgpu_surface_get_current_texture_main_thread: WgpuSurfaceGetCurrentTextureMainThreadFn,
    wgpu_surface_present_main_thread: WgpuSurfacePresentMainThreadFn,
}

pub struct Core {
    _lib: dynlib::DynamicLibrary,
    symbols: Symbols,
    installation: InstallationSymbols,
    insights: InsightsSymbols,
    insights_configured: AtomicBool,
    updater: UpdaterBinding,
}

unsafe impl Send for Core {}
unsafe impl Sync for Core {}

impl Core {
    pub fn load() -> Result<Self, String> {
        Self::load_bundle(resolve_bundle_paths()?)
    }

    fn load_bundle(bundle_paths: BundlePaths) -> Result<Self, String> {
        let lib_path = bundle_paths.exe_dir.join(core_library_name());
        let lib = dynlib::DynamicLibrary::open(&lib_path)?;

        let symbols = Symbols {
            last_error: lib.symbol("electrobun_core_last_error")?,
            run_main_thread: lib.symbol("electrobun_core_run_main_thread")?,
            configure_webview_runtime: lib.symbol("configureWebviewRuntime")?,
            get_window_style: lib.symbol("getWindowStyle")?,
            create_window: lib.symbol("createWindow")?,
            create_webview: lib.symbol("createWebview")?,
            set_next_webview_allowed_protocols: lib.symbol("setNextWebviewAllowedProtocols")?,
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
            is_window_visible: lib.symbol("isWindowVisible")?,
            set_window_button_position: lib.symbol("setWindowButtonPosition")?,
            get_window_button_position: lib.symbol("getWindowButtonPosition")?,
            set_window_position: lib.symbol("setWindowPosition")?,
            center_window: lib.symbol("centerWindow")?,
            set_window_size: lib.symbol("setWindowSize")?,
            set_window_frame: lib.symbol("setWindowFrame")?,
            get_window_frame: lib.symbol("getWindowFrame")?,
            close_window: lib.symbol("closeWindow")?,
            request_window_close: lib.symbol("requestWindowClose")?,
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
            webview_set_spell_check: lib.symbol("webviewSetSpellCheck")?,
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
            capture_screen_region: lib.symbol("captureScreenRegion")?,
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
            set_exit_on_last_window_closed: lib.symbol("setExitOnLastWindowClosed")?,
            stop_event_loop: lib.symbol("stopEventLoop")?,
            wait_for_shutdown_complete: lib.symbol("waitForShutdownComplete")?,
            force_exit: lib.symbol("forceExit")?,
            wgpu_create_surface_for_view: lib.symbol("wgpuCreateSurfaceForView")?,
            wgpu_create_adapter_device_main_thread: lib
                .symbol("wgpuCreateAdapterDeviceMainThread")?,
            wgpu_surface_configure_main_thread: lib.symbol("wgpuSurfaceConfigureMainThread")?,
            wgpu_surface_get_current_texture_main_thread: lib
                .symbol("wgpuSurfaceGetCurrentTextureMainThread")?,
            wgpu_surface_present_main_thread: lib.symbol("wgpuSurfacePresentMainThread")?,
        };

        // Honour the app's `runtime.exitOnLastWindowClosed` setting, which the
        // JS SDK applies at startup too. The core only acts on it when a
        // quit-requested handler is registered, so install one as well.
        unsafe {
            (symbols.set_exit_on_last_window_closed)(exit_on_last_window_closed_from_build_config(
                &bundle_paths,
            ));
        }
        QUIT_REQUESTED_STOP_EVENT_LOOP
            .store(symbols.stop_event_loop as *mut c_void, Ordering::Release);
        QUIT_REQUESTED_USER_HANDLER.store(ptr::null_mut(), Ordering::Release);
        unsafe {
            (symbols.set_quit_requested_handler)(Some(quit_requested_trampoline));
        }

        let installation = InstallationSymbols::load(&lib);
        let insights = InsightsSymbols::load(&lib);
        // Loading the SDK does not configure or request an update. The core
        // resolves bundle metadata only when the updater is first used.
        let updater = UpdaterBinding::new(UpdaterSymbols::load(&lib), &bundle_paths);
        let core = Self {
            _lib: lib,
            symbols,
            installation,
            insights,
            insights_configured: AtomicBool::new(false),
            updater,
        };
        if let Some(config) = installation_config_from_bundle(&bundle_paths) {
            // Identity is local and independent of the Insights background worker.
            let _ = core.installation_configure(&config);
            if let Some(config) = insights_config_from_bundle(&bundle_paths) {
                // Analytics initialization must never prevent the app from opening.
                let _ = core.insights_configure(&config);
            }
        }
        Ok(core)
    }

    /// Configures the updater from bundle directories. The core reads all
    /// metadata and owns installation identity. This does not check the network.
    /// Other updater methods lazily configure the current bundle if needed.
    /// The updater is process-wide; use one application Core handle.
    pub fn updater_configure(&self, bundle_paths: &BundlePaths) -> Result<(), UpdaterError> {
        self.updater
            .configure(bundle_paths, self.symbols.last_error)
    }

    pub fn updater_local_info(&self) -> Result<LocalUpdateInfo, UpdaterError> {
        Ok(self.updater_state()?.local_info)
    }

    /// Queues an asynchronous check. Poll state or events for completion.
    pub fn updater_check(&self) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater_request(UpdaterRequest::Check)
    }

    /// Queues preparation of the update selected by the core.
    pub fn updater_download(&self) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater_request(UpdaterRequest::Download)
    }

    /// Requests an approval token for a prepared update. This never quits.
    /// Run the app's normal quit policy before approving, then wait for
    /// `updater_state()?.quit_ready` before stopping the event loop.
    pub fn updater_request_apply(&self) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater_request(UpdaterRequest::RequestApply)
    }

    /// Approves or vetoes the exact operation and approval token returned by
    /// the core. Approval is asynchronous and does not itself mean quit-ready.
    pub fn updater_approve_apply(
        &self,
        operation_id: &str,
        approval_id: &str,
        approved: bool,
    ) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater_request(UpdaterRequest::ApproveApply {
            operation_id,
            approval_id,
            approved,
        })
    }

    /// Reconciles the previous apply result through the core.
    pub fn updater_reconcile(&self) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater_request(UpdaterRequest::Reconcile)
    }

    pub fn updater_cancel(&self, operation_id: &str) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater_request(UpdaterRequest::Cancel { operation_id })
    }

    pub fn updater_state(&self) -> Result<UpdaterState, UpdaterError> {
        self.updater
            .state(self.symbols.free_core_string, self.symbols.last_error)
    }

    /// Reads the bounded event stream. Pass `next_sequence` unchanged as the
    /// next `after` cursor. Start at zero; inspect `overflow` for missed events.
    pub fn updater_events(&self, after: u64, limit: u32) -> Result<UpdaterEvents, UpdaterError> {
        self.updater.events(
            after,
            limit,
            self.symbols.free_core_string,
            self.symbols.last_error,
        )
    }

    /// Stops and joins core updater work. Also called before Core unloads.
    /// Calling another updater method afterwards configures the worker again.
    pub fn updater_shutdown(&self) -> Result<(), UpdaterError> {
        self.updater.shutdown()
    }

    fn updater_request(
        &self,
        request: UpdaterRequest<'_>,
    ) -> Result<UpdaterRequestResult, UpdaterError> {
        self.updater.request(
            request,
            self.symbols.free_core_string,
            self.symbols.last_error,
        )
    }

    /// Configures only the persisted installation identity, without telemetry.
    /// Normal bundled apps are configured automatically by `Core::load`.
    pub fn installation_configure(&self, config: &InstallationConfig) -> Result<bool, String> {
        self.installation.configure(config)
    }

    /// Shared app/profile installation ID. This works with Insights disabled.
    /// Applications may display it in About, Help, or their own settings UI.
    pub fn installation_id(&self) -> Option<String> {
        self.installation.get_id(self.symbols.free_core_string)
    }

    /// Configures the native worker without waiting for a network request.
    /// Returns false when the loaded core does not provide Insights.
    pub fn insights_configure(&self, config: &InsightsConfig) -> Result<bool, String> {
        let Some(configure) = self.insights.configure else {
            return Ok(false);
        };
        // Starting a worker is unsafe if this core cannot stop it before unload.
        if self.insights.shutdown.is_none() {
            return Ok(false);
        }
        let json = to_c_string(&config.to_json(), "Insights configuration")?;
        let configured = unsafe { configure(json.as_ptr()) };
        if configured {
            self.insights_configured.store(true, Ordering::Release);
        }
        Ok(configured)
    }

    /// Enqueues a custom event. `properties_json` must be a JSON object; the
    /// native core validates and bounds it. False means the event was not queued.
    pub fn insights_track(&self, name: &str, properties_json: &str) -> Result<bool, String> {
        let Some(track) = self.insights.track else {
            return Ok(false);
        };
        let name = to_c_string(name, "Insights event name")?;
        let properties = to_c_string(properties_json, "Insights event properties")?;
        Ok(unsafe { track(name.as_ptr(), properties.as_ptr()) })
    }

    /// Associates subsequent custom events with an application-defined opaque user ID.
    /// None clears the association without changing historical events.
    /// Neither operation changes the app session or its duration.
    pub fn insights_identify(&self, user_id: Option<&str>) -> Result<(), String> {
        let Some(identify) = self.insights.identify else {
            return Ok(());
        };
        let user_id = user_id
            .map(|value| to_c_string(value, "Insights user ID"))
            .transpose()?;
        unsafe { identify(user_id.as_ref().map_or(ptr::null(), |value| value.as_ptr())) };
        Ok(())
    }

    /// Clears the user association. The native core owns installation identity.
    pub fn insights_reset(&self) {
        if let Some(reset) = self.insights.reset {
            unsafe { reset() };
        }
    }

    pub fn insights_set_enabled(&self, enabled: bool) {
        if let Some(set_enabled) = self.insights.set_enabled {
            unsafe { set_enabled(enabled) };
        }
    }

    /// Returns the app/profile-scoped random installation ID, when configured.
    pub fn insights_installation_id(&self) -> Option<String> {
        let installation_id = self.insights.installation_id?;
        let value = unsafe { installation_id() };
        if value.is_null() {
            return None;
        }
        let result = c_string_to_string(value);
        unsafe { (self.symbols.free_core_string)(value) };
        if result.is_empty() {
            None
        } else {
            Some(result)
        }
    }

    /// Requests a background send; this does not wait for network availability.
    pub fn insights_flush(&self) {
        if let Some(flush) = self.insights.flush {
            unsafe { flush() };
        }
    }

    /// Stops the native worker before unloading the core. Queued events remain
    /// on disk for the next launch; shutdown does not force a network delivery.
    pub fn insights_shutdown(&self) {
        if self.insights_configured.swap(false, Ordering::AcqRel) {
            if let Some(shutdown) = self.insights.shutdown {
                unsafe { shutdown() };
            }
        }
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
                options.centered,
                options.traffic_light_offset.x,
                options.traffic_light_offset.y,
                options.callbacks.close,
                options.callbacks.move_handler,
                options.callbacks.resize,
                options.callbacks.focus,
                options.callbacks.blur,
                options.callbacks.key,
                options.callbacks.should_close,
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

    pub fn is_window_visible(&self, window_id: u32) -> bool {
        unsafe { (self.symbols.is_window_visible)(window_id) }
    }

    pub fn set_window_button_position(&self, window_id: u32, x: f64, y: f64) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_button_position)(window_id, x, y);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn get_window_button_position(&self, window_id: u32) -> Result<Point, String> {
        let mut x = 0.0;
        let mut y = 0.0;
        unsafe {
            (self.symbols.get_window_button_position)(window_id, &mut x, &mut y);
        }
        self.ensure_last_call_succeeded()?;
        Ok(Point { x, y })
    }

    pub fn set_window_position(&self, window_id: u32, x: f64, y: f64) -> Result<(), String> {
        unsafe {
            (self.symbols.set_window_position)(window_id, x, y);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn center_window(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.center_window)(window_id);
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

        unsafe {
            (self.symbols.set_next_webview_allowed_protocols)(
                options.allowed_protocols.views,
                options.allowed_protocols.app_data,
            );
        }

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
                options.spell_check,
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

    pub fn set_webview_spell_check(&self, webview_id: u32, enabled: bool) -> Result<bool, String> {
        let supported = unsafe { (self.symbols.webview_set_spell_check)(webview_id, enabled) };
        self.ensure_last_call_succeeded()?;
        Ok(supported)
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

    pub fn request_window_close(&self, window_id: u32) -> Result<(), String> {
        unsafe {
            (self.symbols.request_window_close)(window_id);
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
        Ok(parse_display_json(&json))
    }

    pub fn get_all_displays(&self) -> Result<Vec<Display>, String> {
        let ptr = unsafe { (self.symbols.get_all_displays)() };
        if ptr.is_null() {
            return Err(self.last_error());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        Ok(parse_display_array_json(&json))
    }

    pub fn get_cursor_screen_point(&self) -> Result<Point, String> {
        let ptr = unsafe { (self.symbols.get_cursor_screen_point)() };
        if ptr.is_null() {
            return Err(self.last_error());
        }
        let json = unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() };
        Ok(parse_point_json(&json))
    }

    /// Captures a logical desktop rectangle as tightly packed, row-major RGBA pixels.
    /// Fractional origins are aligned down to the logical pixel grid.
    pub fn capture_screen_region(&self, rectangle: Rect) -> Result<Vec<u8>, String> {
        let layout = screen_capture_layout(rectangle)?;
        let mut pixels = Vec::new();
        pixels.try_reserve_exact(layout.byte_len).map_err(|_| {
            format!(
                "failed to allocate {} bytes for screen capture",
                layout.byte_len
            )
        })?;
        pixels.resize(layout.byte_len, 0);

        let captured = unsafe {
            (self.symbols.capture_screen_region)(
                layout.x,
                layout.y,
                layout.width,
                layout.height,
                pixels.as_mut_ptr(),
                layout.byte_len_u64,
            )
        };
        if !captured {
            return Err("failed to capture screen region".to_string());
        }
        Ok(pixels)
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
        // The low-level C ABI returns a JSON array of selected paths.
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

    /// Override the default quit behaviour. Pass `None` to restore the SDK
    /// default (stop the event loop so `run_main_thread` returns).
    pub fn set_quit_requested_handler(
        &self,
        handler: Option<QuitRequestedHandler>,
    ) -> Result<(), String> {
        let handler_ptr = match handler {
            Some(handler) => handler as *mut c_void,
            None => ptr::null_mut(),
        };
        QUIT_REQUESTED_USER_HANDLER.store(handler_ptr, Ordering::Release);
        unsafe {
            (self.symbols.set_quit_requested_handler)(Some(quit_requested_trampoline));
        }
        self.ensure_last_call_succeeded()
    }

    /// When enabled (the default), closing the last window quits the app.
    pub fn set_exit_on_last_window_closed(&self, enabled: bool) -> Result<(), String> {
        unsafe {
            (self.symbols.set_exit_on_last_window_closed)(enabled);
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

    pub fn wgpu_create_surface_for_view(
        &self,
        instance: *mut c_void,
        view: *mut c_void,
    ) -> Result<*mut c_void, String> {
        let surface = unsafe { (self.symbols.wgpu_create_surface_for_view)(instance, view) };
        if surface.is_null() {
            Err(self.last_error())
        } else {
            Ok(surface)
        }
    }

    pub fn wgpu_create_adapter_device_main_thread(
        &self,
        instance: *mut c_void,
        surface: *mut c_void,
    ) -> Result<WgpuAdapterDevice, String> {
        let mut adapter_device = [0_usize; 2];
        unsafe {
            (self.symbols.wgpu_create_adapter_device_main_thread)(
                instance,
                surface,
                adapter_device.as_mut_ptr() as *mut c_void,
            );
        }
        let adapter = adapter_device[0] as *mut c_void;
        let device = adapter_device[1] as *mut c_void;
        if device.is_null() {
            Err(self.last_error())
        } else {
            Ok(WgpuAdapterDevice { adapter, device })
        }
    }

    pub fn wgpu_surface_configure_main_thread(
        &self,
        surface: *mut c_void,
        config: *mut c_void,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.wgpu_surface_configure_main_thread)(surface, config);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn wgpu_surface_get_current_texture_main_thread(
        &self,
        surface: *mut c_void,
        surface_texture: *mut c_void,
    ) -> Result<(), String> {
        unsafe {
            (self.symbols.wgpu_surface_get_current_texture_main_thread)(surface, surface_texture);
        }
        self.ensure_last_call_succeeded()
    }

    pub fn wgpu_surface_present_main_thread(&self, surface: *mut c_void) -> Result<c_int, String> {
        let status = unsafe { (self.symbols.wgpu_surface_present_main_thread)(surface) };
        self.ensure_last_call_succeeded()?;
        Ok(status)
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

impl Drop for Core {
    fn drop(&mut self) {
        // The core joins its updater worker before the library can unload.
        self.updater.shutdown_if_configured();
        self.insights_shutdown();
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

#[derive(Debug, PartialEq)]
struct ScreenCaptureLayout {
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    byte_len: usize,
    byte_len_u64: u64,
}

fn screen_capture_layout(rectangle: Rect) -> Result<ScreenCaptureLayout, String> {
    if !rectangle.x.is_finite() || !rectangle.y.is_finite() {
        return Err("screen capture origin must be finite".to_string());
    }
    if !rectangle.width.is_finite()
        || !rectangle.height.is_finite()
        || rectangle.width <= 0.0
        || rectangle.height <= 0.0
        || rectangle.width.fract() != 0.0
        || rectangle.height.fract() != 0.0
        || rectangle.width > u32::MAX as f64
        || rectangle.height > u32::MAX as f64
    {
        return Err(
            "screen capture dimensions must be positive integers no greater than u32::MAX"
                .to_string(),
        );
    }

    let width = rectangle.width as u32;
    let height = rectangle.height as u32;
    let byte_len_u64 = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "screen capture byte length overflowed u64".to_string())?;
    let byte_len = usize::try_from(byte_len_u64)
        .map_err(|_| "screen capture exceeds the addressable memory size".to_string())?;
    if byte_len > isize::MAX as usize {
        return Err("screen capture exceeds the maximum allocation size".to_string());
    }

    Ok(ScreenCaptureLayout {
        x: rectangle.x.floor(),
        y: rectangle.y.floor(),
        width,
        height,
        byte_len,
        byte_len_u64,
    })
}

fn wgpu_library_name() -> &'static str {
    if cfg!(windows) {
        "webgpu_dawn.dll"
    } else if cfg!(target_os = "macos") {
        "libwebgpu_dawn.dylib"
    } else {
        "libwebgpu_dawn.so"
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

/// Returns the text of a nested JSON object, braces included, so the field
/// helpers above can be scoped to it instead of scanning the whole document.
pub fn json_object_field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let key_index = source.find(&needle)?;
    let after_key = &source[key_index + needle.len()..];
    let colon_index = after_key.find(':')?;
    let value = after_key[colon_index + 1..].trim_start();
    let value_offset = after_key.len() - value.len();
    if !value.starts_with('{') {
        return None;
    }

    let start = key_index + needle.len() + value_offset;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in source[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if in_string {
            match ch {
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&source[start..start + index + 1]);
                }
            }
            _ => {}
        }
    }

    None
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
        std::env::var("LOCALAPPDATA").unwrap_or_else(|_| join_path(home, "AppData/Local"))
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

fn app_scoped_dir(base: &str, app_info: &AppInfo) -> String {
    if app_info.identifier.is_empty() || app_info.channel.is_empty() {
        return base.to_string();
    }
    let install_root_name = effective_install_root_name(&app_info.channel);
    join_path(&join_path(base, &app_info.identifier), &install_root_name)
}

fn is_safe_install_root_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 || value == "." || value == ".." {
        return false;
    }
    if value
        .bytes()
        .any(|byte| byte < 0x20 || byte == 0x7f || byte == b'/' || byte == b'\\')
    {
        return false;
    }
    if cfg!(windows)
        && (value.ends_with(' ')
            || value.ends_with('.')
            || value.bytes().any(|byte| b"\"%*:<>?|".contains(&byte)))
    {
        return false;
    }
    true
}

fn effective_install_root_name(fallback: &str) -> String {
    match std::env::var(INSTALL_ROOT_NAME_ENVIRONMENT_VARIABLE) {
        Ok(candidate) if is_safe_install_root_name(&candidate) => candidate,
        _ => fallback.to_string(),
    }
}

#[cfg(test)]
mod installation_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex;

    static CONFIGURATION: Mutex<Option<String>> = Mutex::new(None);
    static FREED: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn configure(config: *const c_char) -> bool {
        *CONFIGURATION.lock().unwrap() = Some(c_string_to_string(config));
        true
    }

    unsafe extern "C" fn installation_id() -> *mut c_char {
        CString::new("0123456789abcdef0123456789abcdef").unwrap().into_raw()
    }

    unsafe extern "C" fn free(value: *mut c_char) {
        drop(CString::from_raw(value));
        FREED.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn hosting_only_and_disabled_insights_resolve_the_same_local_identity() {
        let version = r#"{"managed":{"appId":"app_123"},"channel":"stable"}"#;
        for build in [
            "{}",
            r#"{"insights":null}"#,
            r#"{"insights":{"appId":"app_123","enabled":false}}"#,
            r#"{"insights":{"appId":"app_123","enabled":true}}"#,
        ] {
            let config = installation_config_from_json(build, version, "/profile/insights".into()).unwrap();
            assert_eq!(config.app_id.as_deref(), Some("app_123"));
            assert_eq!(config.storage_path, "/profile/insights");
            let json = config.to_json();
            assert_eq!(insights_json_object_fields(&json).unwrap().len(), 2);
            assert!(insights_json_field(&json, "enabled").is_none());
        }
        assert!(insights_config_from_json("{}", version, "/profile/insights".into()).is_none());
        let config = installation_config_from_json(
            r#"{"insights":{"appId":"app_123","enabled":false}}"#,
            "{}",
            "/profile/insights".into(),
        ).unwrap();
        assert_eq!(config.app_id.as_deref(), Some("app_123"));
        let config = installation_config_from_json(
            r#"{"managed":{"appId":"app_123"}}"#,
            "{}",
            "/profile/insights".into(),
        ).unwrap();
        assert_eq!(config.app_id.as_deref(), Some("app_123"));
    }

    #[test]
    fn applications_without_managed_services_still_have_local_identity() {
        for build in ["{}", r#"{"example":{"managed":{"appId":"other_app"}}}"#] {
            let config = installation_config_from_json(build, "{}", "/profile/insights".into()).unwrap();
            assert!(config.app_id.is_none());
            assert_eq!(config.storage_path, "/profile/insights");
            let json = config.to_json();
            assert!(insights_json_field(&json, "appId").is_none());
            assert_eq!(insights_json_object_fields(&json).unwrap().len(), 1);
        }
    }

    #[test]
    fn identity_rejects_conflicting_or_malformed_service_scopes() {
        for (build, version) in [
            (r#"{"insights":{"appId":"app_one"}}"#, r#"{"managed":{"appId":"app_two"}}"#),
            (r#"{"managed":{"appId":"app_one"}}"#, r#"{"managed":{"appId":"app_two"}}"#),
            (r#"{"insights":{"appId":null}}"#, r#"{"managed":{"appId":"app_one"}}"#),
            ("{}", r#"{"managed":{"appId":""}}"#),
            ("{}", r#"{"managed":"app_one"}"#),
            ("{", r#"{"managed":{"appId":"app_one"}}"#),
        ] {
            assert!(installation_config_from_json(build, version, "profile".into()).is_none(), "{build} / {version}");
        }
    }

    #[test]
    fn shared_getter_calls_only_identity_symbols_and_frees_native_string() {
        let api = InstallationSymbols { configure: Some(configure), installation_id: Some(installation_id) };
        let config = InstallationConfig { app_id: Some("app_123".into()), storage_path: "/profile with spaces/insights".into() };
        assert!(api.configure(&config).unwrap());
        let payload = CONFIGURATION.lock().unwrap().clone().unwrap();
        assert_eq!(insights_json_string(&payload, "appId"), config.app_id);
        assert_eq!(insights_json_string(&payload, "storagePath").unwrap(), config.storage_path);
        assert_eq!(api.get_id(free).as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(FREED.load(Ordering::SeqCst), 1);

        let unavailable = InstallationSymbols::default();
        assert!(!unavailable.configure(&config).unwrap());
        assert!(unavailable.get_id(free).is_none());
        assert_eq!(FREED.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod insights_tests {
    use super::{
        insights_app_info_from_json, insights_config_from_json, insights_decode_string,
        insights_json_field, InsightsConfig, DEFAULT_INSIGHTS_API_URL,
    };

    #[test]
    fn managed_service_defaults_without_an_api_url_and_keeps_explicit_overrides() {
        let config = insights_config_from_json(
            r#"{"insights":{"appId":"app_123"}}"#,
            r#"{"channel":"stable"}"#,
            "/profile/insights".into(),
        ).unwrap();
        assert_eq!(config.api_url, DEFAULT_INSIGHTS_API_URL);
        assert!(!config.enabled);
        assert_eq!(InsightsConfig::default().api_url, DEFAULT_INSIGHTS_API_URL);
        assert!(!InsightsConfig::default().enabled);
        assert_eq!(
            insights_decode_string(insights_json_field(&config.to_json(), "apiUrl").unwrap()).unwrap(),
            DEFAULT_INSIGHTS_API_URL,
        );
        let override_config = insights_config_from_json(
            r#"{"insights":{"appId":"app_123","apiUrl":"http://127.0.0.1:8787"}}"#,
            r#"{"channel":"canary"}"#,
            "/profile/insights".into(),
        ).unwrap();
        assert_eq!(override_config.api_url, "http://127.0.0.1:8787");
        for value in ["null", "false", "123", r#""""#] {
            let build = format!(r#"{{"insights":{{"appId":"app_123","apiUrl":{value}}}}}"#);
            assert!(insights_config_from_json(&build, r#"{"channel":"stable"}"#, "profile".into()).is_none());
        }
    }

    #[test]
    fn storage_profile_requires_top_level_app_identifier() {
        for version in [
            "{}",
            r#"{"identifier":""}"#,
            r#"{"identifier":null}"#,
            r#"{"example":{"identifier":"other.app","name":"Other","channel":"stable"}}"#,
        ] {
            assert!(insights_app_info_from_json(version).is_none(), "{version}");
        }
        let info = insights_app_info_from_json(
            r#"{"example":{"identifier":"other.app","name":"Other","channel":"stable"},"identifier":"actual.app"}"#,
        ).unwrap();
        assert_eq!(info.identifier, "actual.app");
        assert_eq!(info.name, "Electrobun");
        assert_eq!(info.channel, "dev");
    }

    #[test]
    fn bundled_managed_custom_origin_preserves_identity_and_disabled_collection() {
        // Hutch has already selected this origin for both managed updates and
        // Insights; the SDK passes it to the core without changing its scope.
        let config = insights_config_from_json(
            r#"{"insights":{"appId":"app_123","apiUrl":"https://updates.example.test"},"managed":{"appId":"app_123","baseUrl":"https://updates.example.test"}}"#,
            r#"{"version":"1.5.0","hash":"custom-build","channel":"stable","managed":{"appId":"app_123","baseUrl":"https://updates.example.test"}}"#,
            "/profile/insights".into(),
        ).unwrap();
        assert_eq!(config.api_url, "https://updates.example.test");
        assert_eq!(config.app_id, "app_123");
        assert_eq!(config.version, "1.5.0");
        assert_eq!(config.build_hash, "custom-build");
        assert_eq!(config.channel, "stable");
        assert!(!config.enabled);
        assert_eq!(
            insights_decode_string(insights_json_field(&config.to_json(), "apiUrl").unwrap()).unwrap(),
            "https://updates.example.test",
        );
    }

    #[test]
    fn bundled_insights_preserve_external_distribution_and_build_identity() {
        let config = insights_config_from_json(
            r#"{"insights":{"appId":"app_123","apiUrl":"https://cloud.example/v1/electrobun","enabled":true},"updateAuthority":"external","distribution":"app-store"}"#,
            r#"{"version":"2.1.0","hash":"abc123","channel":"stable"}"#,
            "/profile/insights".into(),
        ).unwrap();
        assert_eq!(config.app_id, "app_123");
        assert_eq!(config.storage_path, "/profile/insights");
        assert_eq!(config.version, "2.1.0");
        assert_eq!(config.build_hash, "abc123");
        assert_eq!(config.update_authority, "external");
        assert_eq!(config.distribution, "app-store");
        assert!(config.enabled);
    }

    #[test]
    fn immutable_packaged_distribution_takes_precedence_over_build_defaults() {
        let config = insights_config_from_json(
            r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example"},"updateAuthority":"direct","distribution":"direct"}"#,
            r#"{"channel":"stable","updateAuthority":"external","distribution":"app-store"}"#,
            "profile".into(),
        ).unwrap();
        assert_eq!(config.update_authority, "external");
        assert_eq!(config.distribution, "app-store");
    }

    #[test]
    fn every_channel_requires_explicit_opt_in_and_nested_flags_do_not_opt_in() {
        for channel in [None, Some("dev"), Some("canary"), Some("stable")] {
            let version = channel.map_or_else(|| "{}".into(), |value| format!(r#"{{"channel":"{value}"}}"#));
            for extras in [
                "",
                r#", "example":{"enabled":true}"#,
                r#", "enabled":false"#,
            ] {
                let build = format!(
                    r#"{{"insights":{{"appId":"a","apiUrl":"https://cloud.example"{extras}}}}}"#
                );
                assert!(
                    !insights_config_from_json(&build, &version, "profile".into())
                        .unwrap()
                        .enabled
                );
            }
            let build = r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example","enabled":true}}"#;
            assert!(
                insights_config_from_json(build, &version, "profile".into())
                    .unwrap()
                    .enabled
            );
        }
    }

    #[test]
    fn malformed_or_nested_configuration_cannot_enable_collection() {
        for build in [
            "{}",
            r#"{"example":{"insights":{"appId":"a","apiUrl":"https://cloud.example"}}}"#,
            r#"{"insights":{"example":{"appId":"a","apiUrl":"https://cloud.example"}}}"#,
            r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example","enabled":"true"}}"#,
            r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example","enabled":true,"enabled":false}}"#,
            r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example"},}"#,
            r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example"}} garbage"#,
            r#"{"insights":{"appId":"a","apiUrl":"https://cloud.example"},"bad":01}"#,
        ] {
            assert!(
                insights_config_from_json(build, r#"{"channel":"stable"}"#, "profile".into())
                    .is_none(),
                "{build}"
            );
        }
    }

    #[test]
    fn serialization_escapes_paths_and_ids_and_preserves_unicode() {
        let config = InsightsConfig {
            app_id: "app\"\\\n雪".into(),
            storage_path: "C:\\Users\\Name\\insights".into(),
            ..InsightsConfig::default()
        };
        let json = config.to_json();
        assert_eq!(
            insights_decode_string(insights_json_field(&json, "appId").unwrap()).unwrap(),
            config.app_id
        );
        assert_eq!(
            insights_decode_string(insights_json_field(&json, "storagePath").unwrap()).unwrap(),
            config.storage_path
        );
        assert_eq!(
            insights_decode_string(r#""\u96ea\ud83d\ude00""#).unwrap(),
            "雪😀"
        );
        assert!(insights_decode_string(r#""\ud800""#).is_none());
    }
}

#[cfg(test)]
mod install_root_name_tests {
    use super::{is_safe_install_root_name, AppInfo};

    #[test]
    fn validates_launcher_install_root_leaf() {
        assert!(is_safe_install_root_name("stable"));
        assert!(is_safe_install_root_name("Legacy App"));
        for invalid in ["", ".", "..", "nested/root", "nested\\root", "line\nbreak"] {
            assert!(!is_safe_install_root_name(invalid));
        }
    }

    #[test]
    fn packaged_mode_uses_canonical_release_channels() {
        for channel in ["stable", "canary"] {
            assert!(AppInfo {
                identifier: String::new(),
                name: String::new(),
                channel: channel.to_string(),
            }
            .is_packaged());
        }
        for channel in ["", "dev", "production", "nightly"] {
            assert!(!AppInfo {
                identifier: String::new(),
                name: String::new(),
                channel: channel.to_string(),
            }
            .is_packaged());
        }
    }
}

#[cfg(test)]
mod screen_capture_tests {
    use super::{screen_capture_layout, Rect};

    #[test]
    fn validates_and_aligns_capture_rectangle() {
        let layout = screen_capture_layout(Rect::new(-1.25, 3.99, 2.0, 3.0)).unwrap();
        assert_eq!(layout.x, -2.0);
        assert_eq!(layout.y, 3.0);
        assert_eq!(layout.width, 2);
        assert_eq!(layout.height, 3);
        assert_eq!(layout.byte_len, 24);
        assert_eq!(layout.byte_len_u64, 24);
    }

    #[test]
    fn rejects_invalid_capture_rectangles_before_allocation() {
        for rectangle in [
            Rect::new(f64::NAN, 0.0, 1.0, 1.0),
            Rect::new(0.0, f64::INFINITY, 1.0, 1.0),
            Rect::new(0.0, 0.0, 0.0, 1.0),
            Rect::new(0.0, 0.0, 1.0, -1.0),
            Rect::new(0.0, 0.0, 1.5, 1.0),
            Rect::new(0.0, 0.0, u32::MAX as f64 + 1.0, 1.0),
        ] {
            assert!(screen_capture_layout(rectangle).is_err());
        }
    }

    #[test]
    fn rejects_capture_byte_length_overflow() {
        let error = screen_capture_layout(Rect::new(0.0, 0.0, u32::MAX as f64, u32::MAX as f64))
            .unwrap_err();
        assert!(error.contains("overflowed u64"));
    }
}

#[cfg(test)]
mod updater_tests {
    use super::*;

    const LOCAL: &str = r#"{"version":"1.0","hash":"old","baseUrl":"https://example.invalid","channel":"stable","name":"Demo","displayName":"Demo 雪","identifier":"dev.demo","managed":{"appId":"app_1","apiUrl":"https://managed.invalid"},"updateAuthority":"direct"}"#;
    const UPDATE: &str =
        r#"{"version":"2.0","hash":"new","updateAvailable":true,"updateReady":true,"error":""}"#;
    const ACCEPTED: &str =
        r#"{"schemaVersion":1,"accepted":true,"operationId":"operation-1","error":null}"#;

    fn state_json(quit_ready: bool) -> String {
        format!(
            r#"{{"schemaVersion":1,"revision":18446744073709551615,"operationId":"operation-1","operation":"requestApply","operationState":"awaitingApproval","localInfo":{LOCAL},"updateInfo":{UPDATE},"approval":{{"id":"approval-1","preparedHash":"new"}},"quitReady":{quit_ready},"channelRoot":"/profile/update","operations":[{{"operationId":"prior-check","operation":"check","state":"completed","error":null,"updateInfo":{UPDATE}}}]}}"#
        )
    }

    fn events_json() -> &'static str {
        r#"{"schemaVersion":1,"entries":[{"sequence":18446744073709551615,"operationId":"operation-1","status":"download-progress","message":"Downloading 雪","timestamp":-123,"details":{"fromHash":"old","toHash":"new","currentHash":"old","latestHash":"new","patchNumber":2,"totalPatchesApplied":1,"progress":12.5,"bytesDownloaded":18446744073709551615,"totalBytes":18446744073709551615,"usedPatchPath":true,"errorMessage":"","url":"https://example.invalid/update","zstdPath":"/app/bin/zstd","exitCode":null}}],"nextSequence":18446744073709551615,"oldestSequence":4,"overflow":true}"#
    }

    #[derive(Default)]
    struct FakeCore {
        configured: Vec<String>,
        requests: Vec<String>,
        event_cursors: Vec<(u64, u32)>,
        calls: Vec<&'static str>,
        freed: usize,
        configuration_fails: bool,
        response: Option<Vec<u8>>,
        null_response: bool,
    }

    static TEST_LOCK: Mutex<()> = Mutex::new(());
    static FAKE: Mutex<Option<FakeCore>> = Mutex::new(None);

    fn reset_fake() {
        *FAKE.lock().unwrap() = Some(FakeCore::default());
    }

    fn fake_response(default: &str) -> *mut c_char {
        let fake = FAKE.lock().unwrap();
        let fake = fake.as_ref().unwrap();
        if fake.null_response {
            return ptr::null_mut();
        }
        let response = fake.response.as_deref().unwrap_or(default.as_bytes());
        CString::new(response).unwrap().into_raw()
    }

    unsafe extern "C" fn configure(value: *const c_char) -> bool {
        let mut fake = FAKE.lock().unwrap();
        let fake = fake.as_mut().unwrap();
        fake.calls.push("configure");
        fake.configured.push(c_string_to_string(value));
        !fake.configuration_fails
    }

    unsafe extern "C" fn request(value: *const c_char) -> *mut c_char {
        {
            let mut fake = FAKE.lock().unwrap();
            let fake = fake.as_mut().unwrap();
            fake.calls.push("request");
            fake.requests.push(c_string_to_string(value));
        }
        fake_response(ACCEPTED)
    }

    unsafe extern "C" fn get_state() -> *mut c_char {
        FAKE.lock().unwrap().as_mut().unwrap().calls.push("state");
        fake_response(&state_json(false))
    }

    unsafe extern "C" fn get_events(after: u64, limit: u32) -> *mut c_char {
        {
            let mut fake = FAKE.lock().unwrap();
            let fake = fake.as_mut().unwrap();
            fake.calls.push("events");
            fake.event_cursors.push((after, limit));
        }
        fake_response(events_json())
    }

    unsafe extern "C" fn shutdown() {
        FAKE.lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .calls
            .push("shutdown");
    }

    unsafe extern "C" fn free(value: *mut c_char) {
        drop(CString::from_raw(value));
        let mut fake = FAKE.lock().unwrap();
        let fake = fake.as_mut().unwrap();
        fake.calls.push("free");
        fake.freed += 1;
    }

    unsafe extern "C" fn last_error() -> *const c_char {
        b"native updater error\0".as_ptr().cast()
    }

    fn symbols() -> UpdaterSymbols {
        UpdaterSymbols {
            configure: Some(configure),
            request: Some(request),
            get_state: Some(get_state),
            get_events: Some(get_events),
            shutdown: Some(shutdown),
        }
    }

    fn bundle() -> BundlePaths {
        BundlePaths {
            exe_dir: "/app/quote\" and 雪/bin".into(),
            resources_dir: "/app/quote\" and 雪/Resources".into(),
        }
    }

    #[test]
    fn binding_is_lazy_and_only_passes_bundle_paths_to_core() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_fake();
        let api = UpdaterBinding::new(symbols(), &bundle());
        api.shutdown_if_configured();
        assert!(FAKE.lock().unwrap().as_ref().unwrap().calls.is_empty());
        let state = api.state(free, last_error).unwrap();
        assert!(!state.quit_ready);
        assert_eq!(state.approval.unwrap().id, "approval-1");
        let events = api.events(u64::MAX - 1, 37, free, last_error).unwrap();
        assert_eq!(events.next_sequence, u64::MAX);
        let fake = FAKE.lock().unwrap();
        let fake = fake.as_ref().unwrap();
        assert_eq!(fake.configured.len(), 1);
        let configuration = UpdaterJson::new(&fake.configured[0]).unwrap();
        assert_eq!(configuration.0.len(), 3);
        assert_eq!(configuration.schema().unwrap(), 1);
        assert_eq!(
            configuration.string("exeDir").unwrap(),
            bundle().exe_dir.to_str().unwrap()
        );
        assert_eq!(
            configuration.string("resourcesDir").unwrap(),
            bundle().resources_dir.to_str().unwrap()
        );
        assert!(fake.requests.is_empty());
        assert_eq!(fake.event_cursors, vec![(u64::MAX - 1, 37)]);
        assert_eq!(fake.freed, 2);
    }

    #[test]
    fn state_and_events_preserve_schema_types_and_approval_does_not_mean_quit_ready() {
        let state = UpdaterState::from_json(&state_json(false)).unwrap();
        assert_eq!(state.revision, u64::MAX);
        assert_eq!(
            state.operation_state,
            UpdaterOperationState::AwaitingApproval
        );
        assert!(state.update_info.update_ready);
        assert!(state.approval.is_some());
        assert!(!state.quit_ready);
        assert!(
            UpdaterState::from_json(&state_json(true))
                .unwrap()
                .quit_ready
        );
        assert_eq!(state.local_info.display_name.as_deref(), Some("Demo 雪"));
        assert_eq!(state.local_info.managed.unwrap().app_id, "app_1");
        assert_eq!(state.operations[0].operation_id, "prior-check");
        assert_eq!(
            state.operations[0].update_info.as_ref().unwrap().hash,
            "new"
        );
        let events = UpdaterEvents::from_json(events_json()).unwrap();
        assert!(events.overflow);
        assert_eq!(events.entries[0].timestamp, -123);
        let details = events.entries[0].details.as_ref().unwrap();
        assert_eq!(details.progress, Some(12.5));
        assert_eq!(details.bytes_downloaded, Some(u64::MAX));
        assert_eq!(details.exit_code, None);
        assert_eq!(details.used_patch_path, Some(true));
    }

    #[test]
    fn events_accept_operation_ids_omitted_by_the_core_serializer() {
        for operation_field in ["", "\"operationId\":null,"] {
            let source = format!(
                r#"{{"schemaVersion":1,"entries":[{{"sequence":1,{operation_field}"status":"idle","message":"Updater configured","timestamp":123}}],"nextSequence":1,"oldestSequence":1,"overflow":false}}"#
            );
            let events = UpdaterEvents::from_json(&source).unwrap();
            assert_eq!(events.entries[0].operation_id, None);
            assert_eq!(events.entries[0].details, None);
            assert_eq!(events.entries[0].status, "idle");
        }
    }

    #[test]
    fn requests_preserve_tokens_and_veto_without_quit_side_effects() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_fake();
        let api = UpdaterBinding::new(symbols(), &bundle());
        for request in [
            UpdaterRequest::Check,
            UpdaterRequest::Download,
            UpdaterRequest::RequestApply,
            UpdaterRequest::Reconcile,
        ] {
            assert!(api.request(request, free, last_error).unwrap().accepted);
        }
        api.request(
            UpdaterRequest::ApproveApply {
                operation_id: "operation\"雪",
                approval_id: "token\\\n",
                approved: false,
            },
            free,
            last_error,
        )
        .unwrap();
        api.request(
            UpdaterRequest::Cancel {
                operation_id: "operation\"雪",
            },
            free,
            last_error,
        )
        .unwrap();
        let fake = FAKE.lock().unwrap();
        let fake = fake.as_ref().unwrap();
        let actions: Vec<String> = fake
            .requests
            .iter()
            .map(|request| UpdaterJson::new(request).unwrap().string("action").unwrap())
            .collect();
        assert_eq!(
            actions,
            [
                "check",
                "download",
                "requestApply",
                "reconcile",
                "approveApply",
                "cancel"
            ]
        );
        let approval = UpdaterJson::new(&fake.requests[4]).unwrap();
        assert_eq!(approval.schema().unwrap(), 1);
        assert_eq!(approval.string("operationId").unwrap(), "operation\"雪");
        assert_eq!(approval.string("approvalId").unwrap(), "token\\\n");
        assert!(!approval.boolean("approved").unwrap());
        let cancel = UpdaterJson::new(&fake.requests[5]).unwrap();
        assert_eq!(cancel.string("operationId").unwrap(), "operation\"雪");
        assert_eq!(fake.freed, 6);
        assert!(!fake.calls.contains(&"shutdown"));
    }

    #[test]
    fn every_owned_response_is_freed_on_rejection_invalid_json_and_invalid_utf8() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_fake();
        let api = UpdaterBinding::new(symbols(), &bundle());
        let cases = [
            br#"{"schemaVersion":1,"accepted":false,"operationId":"busy-operation","error":"updater busy"}"#.to_vec(),
            b"{invalid".to_vec(),
            vec![0xff],
        ];
        for response in cases {
            FAKE.lock().unwrap().as_mut().unwrap().response = Some(response);
            assert!(api
                .request(UpdaterRequest::Check, free, last_error)
                .is_err());
        }
        assert_eq!(FAKE.lock().unwrap().as_ref().unwrap().freed, 3);
        FAKE.lock().unwrap().as_mut().unwrap().null_response = true;
        assert!(
            matches!(api.state(free, last_error), Err(UpdaterError::CoreFailure(message)) if message == "native updater error")
        );
        assert_eq!(FAKE.lock().unwrap().as_ref().unwrap().freed, 3);
    }

    #[test]
    fn missing_symbols_and_configuration_failures_do_not_start_operations() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_fake();
        let missing = UpdaterBinding::new(UpdaterSymbols::default(), &bundle());
        assert!(matches!(
            missing.state(free, last_error),
            Err(UpdaterError::Unavailable(_))
        ));
        assert!(matches!(
            missing.shutdown(),
            Err(UpdaterError::Unavailable(_))
        ));
        let mut incomplete_symbols = symbols();
        incomplete_symbols.shutdown = None;
        let incomplete = UpdaterBinding::new(incomplete_symbols, &bundle());
        assert!(
            matches!(incomplete.request(UpdaterRequest::Check, free, last_error), Err(UpdaterError::Unavailable(message)) if message.contains("updaterShutdown"))
        );
        assert!(FAKE.lock().unwrap().as_ref().unwrap().calls.is_empty());
        FAKE.lock().unwrap().as_mut().unwrap().configuration_fails = true;
        let api = UpdaterBinding::new(symbols(), &bundle());
        assert!(
            matches!(api.request(UpdaterRequest::Check, free, last_error), Err(UpdaterError::CoreFailure(message)) if message == "native updater error")
        );
        let fake = FAKE.lock().unwrap();
        let fake = fake.as_ref().unwrap();
        assert_eq!(fake.calls, vec!["configure"]);
        assert!(!api.lifecycle.lock().unwrap().configured);
    }

    #[test]
    fn shutdown_joins_core_and_next_use_reconfigures_without_implicit_requests() {
        let _guard = TEST_LOCK.lock().unwrap();
        reset_fake();
        let api = UpdaterBinding::new(symbols(), &bundle());
        api.state(free, last_error).unwrap();
        api.shutdown().unwrap();
        assert!(!api.lifecycle.lock().unwrap().configured);
        api.state(free, last_error).unwrap();
        api.shutdown().unwrap();
        let fake = FAKE.lock().unwrap();
        let fake = fake.as_ref().unwrap();
        assert_eq!(
            fake.calls,
            vec![
                "configure",
                "state",
                "free",
                "shutdown",
                "configure",
                "state",
                "free",
                "shutdown"
            ]
        );
        assert!(fake.requests.is_empty());
    }

    #[test]
    fn core_drop_shuts_down_before_the_native_library_unloads() {
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct FixtureDir(PathBuf);
        impl Drop for FixtureDir {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = FixtureDir(std::env::temp_dir().join(format!(
            "electrobun-rust-updater-{}-{unique}",
            std::process::id()
        )));
        fs::create_dir_all(directory.0.join("Resources")).unwrap();
        let log = directory.0.join("calls.log");
        let c_file = directory.0.join("core_fixture.c");
        let library = directory.0.join(core_library_name());
        let mut source = format!(
            r#"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#define EB_EXPORT __declspec(dllexport)
#define fixture_strdup _strdup
static void record(const char *value) {{ FILE *f = _wfopen(L{log_path}, L"ab"); if (f) {{ fputs(value, f); fclose(f); }} }}
#else
#define EB_EXPORT __attribute__((visibility("default")))
#define fixture_strdup strdup
static void record(const char *value) {{ FILE *f = fopen({log_path}, "ab"); if (f) {{ fputs(value, f); fclose(f); }} }}
#endif
EB_EXPORT const char *electrobun_core_last_error(void) {{ return ""; }}
EB_EXPORT void setExitOnLastWindowClosed(bool enabled) {{ (void)enabled; }}
EB_EXPORT void setQuitRequestedHandler(void (*handler)(void)) {{ (void)handler; }}
EB_EXPORT void stopEventLoop(void) {{ record("quit\n"); }}
EB_EXPORT void forceExit(int code) {{ (void)code; record("force-exit\n"); }}
EB_EXPORT void freeCoreString(char *value) {{ record("free\n"); free(value); }}
EB_EXPORT bool updaterConfigure(const char *json) {{ (void)json; record("configure\n"); return true; }}
EB_EXPORT char *updaterRequest(const char *json) {{ (void)json; record("request\n"); return fixture_strdup({accepted}); }}
EB_EXPORT char *updaterGetState(void) {{ record("state\n"); return fixture_strdup({state}); }}
EB_EXPORT char *updaterGetEvents(uint64_t after, uint32_t limit) {{ (void)after; (void)limit; return fixture_strdup({events}); }}
EB_EXPORT void updaterShutdown(void) {{ record("shutdown\n"); }}
#ifdef _WIN32
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {{
    (void)instance; (void)reserved;
    if (reason == DLL_PROCESS_DETACH) record("unload\n");
    return TRUE;
}}
#else
__attribute__((destructor)) static void fixture_unload(void) {{ record("unload\n"); }}
#endif
"#,
            log_path = json_string_literal(log.to_str().unwrap()),
            accepted = json_string_literal(ACCEPTED),
            state = json_string_literal(&state_json(false)),
            events = json_string_literal(events_json())
        );
        // The fixture supplies inert exports for the rest of the required GUI
        // ABI; updater and lifetime entry points above have their exact types.
        let sdk_source = include_str!("electrobun.rs");
        let table = sdk_source
            .split("let symbols = Symbols {")
            .nth(1)
            .unwrap()
            .split("\n        };")
            .next()
            .unwrap();
        let implemented = [
            "electrobun_core_last_error",
            "setExitOnLastWindowClosed",
            "setQuitRequestedHandler",
            "stopEventLoop",
            "forceExit",
            "freeCoreString",
        ];
        for symbol in table
            .split(".symbol(\"")
            .skip(1)
            .map(|part| part.split('"').next().unwrap())
        {
            if !implemented.contains(&symbol) {
                source.push_str(&format!("EB_EXPORT void {symbol}(void) {{}}\n"));
            }
        }
        fs::write(&c_file, source).unwrap();
        // Pass the executable path directly so spaces work on every platform.
        // Darwin uses the system linker: the vendored Zig linker does not run
        // this fixture's C destructor at dlclose. Linux/Windows CI can use Zig.
        let zig = std::env::var_os("ELECTROBUN_TEST_ZIG")
            .filter(|_| !cfg!(target_os = "macos"));
        let mut compiler = if let Some(zig) = zig {
            let mut command = Command::new(zig);
            // Keep the fixture's lifetime independent of sanitizer runtimes.
            command.args(["cc", "-fno-sanitize=all"]);
            if cfg!(windows) {
                command.args([
                    "-target",
                    if cfg!(target_arch = "aarch64") {
                        "aarch64-windows-gnu"
                    } else {
                        "x86_64-windows-gnu"
                    },
                ]);
            }
            command
        } else {
            Command::new("cc")
        };
        compiler.arg(if cfg!(target_os = "macos") {
            "-dynamiclib"
        } else {
            "-shared"
        });
        if cfg!(unix) {
            compiler.arg("-fPIC");
        }
        let compiled = compiler
            .arg("-o")
            .arg(&library)
            .arg(&c_file)
            .output()
            .expect("cannot execute fixture C compiler; set ELECTROBUN_TEST_ZIG to a Zig executable");
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let core = Core::load_bundle(BundlePaths {
            exe_dir: directory.0.clone(),
            resources_dir: directory.0.join("Resources"),
        })
        .unwrap();
        assert!(
            !log.exists(),
            "loading the SDK called an updater entry point"
        );
        let request = core.updater_request_apply().unwrap();
        assert!(request.accepted);
        let state = core.updater_state().unwrap();
        assert!(state.approval.is_some());
        assert!(!state.quit_ready);
        core.updater_approve_apply("operation-1", "approval-1", false)
            .unwrap();
        assert_eq!(
            fs::read_to_string(&log).unwrap(),
            "configure\nrequest\nfree\nstate\nfree\nrequest\nfree\n"
        );
        drop(core);
        assert_eq!(
            fs::read_to_string(&log).unwrap(),
            "configure\nrequest\nfree\nstate\nfree\nrequest\nfree\nshutdown\nunload\n"
        );
    }

    #[test]
    fn rejects_missing_fields_wrong_types_duplicate_keys_and_unsupported_schemas() {
        for source in [
            "{}",
            "null",
            "[]",
            "{",
            r#"{"schemaVersion":2,"accepted":true,"operationId":"id","error":null}"#,
            r#"{"schemaVersion":1,"accepted":"true","operationId":"id","error":null}"#,
            r#"{"schemaVersion":1,"accepted":true,"operationId":null,"error":null}"#,
            r#"{"schemaVersion":1,"accepted":true,"operationId":"id"}"#,
            r#"{"schemaVersion":1,"accepted":true,"operationId":"id","error":"failure"}"#,
            r#"{"schemaVersion":1,"schemaVersion":1,"accepted":true,"operationId":"id","error":null}"#,
        ] {
            assert!(
                matches!(
                    UpdaterRequestResult::from_json(source),
                    Err(UpdaterError::InvalidResponse(_))
                ),
                "{source}"
            );
        }
        for source in [
            state_json(false).replace("\"quitReady\":false", "\"quitReady\":\"false\""),
            state_json(false).replace(
                "\"operationState\":\"awaitingApproval\"",
                "\"operationState\":\"quitNow\"",
            ),
            state_json(false).replace("\"revision\":18446744073709551615", "\"revision\":-1"),
            state_json(false).replace("\"operations\":[", "\"operations\":{\"items\":["),
        ] {
            assert!(matches!(
                UpdaterState::from_json(&source),
                Err(UpdaterError::InvalidResponse(_))
            ));
        }
        let rejection = UpdaterRequestResult::from_json(
            r#"{"schemaVersion":1,"accepted":false,"operationId":"id","error":"stale approval"}"#,
        );
        assert_eq!(
            rejection.unwrap_err(),
            UpdaterError::Rejected {
                operation_id: Some("id".into()),
                message: "stale approval".into()
            }
        );
        let overflow = events_json().replace("\"progress\":12.5", "\"progress\":1e999");
        assert!(matches!(
            UpdaterEvents::from_json(&overflow),
            Err(UpdaterError::InvalidResponse(_))
        ));
    }
}
