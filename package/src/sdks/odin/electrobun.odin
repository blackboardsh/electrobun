// Electrobun Odin SDK.
//
// A faithful port of package/src/sdks/zig/electrobun.zig. Dynamically loads the
// Electrobun native wrapper shared library (libElectrobunCore) at runtime and
// wraps its C ABI entry points.
//
// Naming follows the zig SDK (camelCase procs) so that porting a zig main to
// Odin is mechanical: zig `core.createWindow(options)` becomes
// `electrobun.createWindow(&core, options)`.
package electrobun

import "base:runtime"
import "core:c"
import "core:dynlib"
import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:reflect"
import "core:strings"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

Error :: enum {
	None,
	MissingCoreSymbol,
	LibraryLoadFailed,
	ElectrobunCoreFailure,
	InvalidExePath,
	InvalidRectJson,
	InvalidJson,
	FileReadFailed,
	EnvVarNotFound,
}

// ---------------------------------------------------------------------------
// C ABI callback types (must match the zig SDK's callconv(.C) handler types)
// ---------------------------------------------------------------------------

WindowCloseHandler :: proc "c" (u32)
WindowMoveHandler :: proc "c" (u32, f64, f64)
WindowResizeHandler :: proc "c" (u32, f64, f64, f64, f64)
WindowFocusHandler :: proc "c" (u32)
WindowBlurHandler :: proc "c" (u32)
WindowKeyHandler :: proc "c" (u32, u32, u32, u32, u32)
DecideNavigationHandler :: proc "c" (u32, cstring) -> u32
WebviewEventHandler :: proc "c" (u32, cstring, cstring)
WebviewPostMessageHandler :: proc "c" (u32, cstring)
StatusItemHandler :: proc "c" (u32, cstring)
GlobalShortcutHandler :: proc "c" (cstring)
QuitRequestedHandler :: proc "c" ()
URLOpenHandler :: proc "c" (cstring)
AppReopenHandler :: proc "c" ()

// ---------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------

Renderer :: enum {
	native,
	cef,
}

rendererName :: proc(renderer: Renderer) -> string {
	switch renderer {
	case .native:
		return "native"
	case .cef:
		return "cef"
	}
	return "native"
}

AppInfo :: struct {
	identifier: string,
	name:       string,
	channel:    string,
}

OwnedAppInfo :: struct {
	identifier: string,
	name:       string,
	channel:    string,
}

ownedAppInfoDeinit :: proc(self: ^OwnedAppInfo, allocator: runtime.Allocator) {
	delete(self.identifier, allocator)
	delete(self.name, allocator)
	delete(self.channel, allocator)
}

borrowed :: proc(self: OwnedAppInfo) -> AppInfo {
	return {identifier = self.identifier, name = self.name, channel = self.channel}
}

Rect :: struct {
	x:      f64,
	y:      f64,
	width:  f64,
	height: f64,
}

DEFAULT_RECT :: Rect{0, 0, 800, 600}

TrafficLightOffset :: struct {
	x: f64,
	y: f64,
}

WindowStyle :: struct {
	borderless:                bool,
	titled:                    bool,
	closable:                  bool,
	miniaturizable:            bool,
	resizable:                 bool,
	unified_title_and_toolbar: bool,
	full_screen:               bool,
	full_size_content_view:    bool,
	utility_window:            bool,
	doc_modal_window:          bool,
	nonactivating_panel:       bool,
	hud_window:                bool,
}

DEFAULT_WINDOW_STYLE :: WindowStyle {
	titled         = true,
	closable       = true,
	miniaturizable = true,
	resizable      = true,
}

WindowCallbacks :: struct {
	close:  WindowCloseHandler,
	move:   WindowMoveHandler,
	resize: WindowResizeHandler,
	focus:  WindowFocusHandler,
	blur:   WindowBlurHandler,
	key:    WindowKeyHandler,
}

WindowOptions :: struct {
	title:                string,
	frame:                Rect,
	style:                WindowStyle,
	title_bar_style:      string,
	transparent:          bool,
	hidden:               bool,
	activate:             bool,
	traffic_light_offset: TrafficLightOffset,
	callbacks:            WindowCallbacks,
}

// Mirrors the zig SDK's WindowOptions default field values.
defaultWindowOptions :: proc(title: string) -> WindowOptions {
	return {
		title = title,
		frame = DEFAULT_RECT,
		style = DEFAULT_WINDOW_STYLE,
		title_bar_style = "default",
		activate = true,
	}
}

WebviewCallbacks :: struct {
	decide_navigation: DecideNavigationHandler,
	event:             WebviewEventHandler,
	event_bridge:      WebviewPostMessageHandler,
	host_bridge:       WebviewPostMessageHandler,
	bun_bridge:        WebviewPostMessageHandler,
	internal_bridge:   WebviewPostMessageHandler,
}

WebviewOptions :: struct {
	window_id:         u32,
	host_webview_id:   u32,
	renderer:          Renderer,
	url:               string,
	frame:             Rect,
	auto_resize:       bool,
	partition:         string,
	callbacks:         WebviewCallbacks,
	secret_key:        string,
	preload:           string,
	views_root:        string,
	sandbox:           bool,
	start_transparent: bool,
	start_passthrough: bool,
}

// Mirrors the zig SDK's WebviewOptions default field values.
defaultWebviewOptions :: proc(window_id: u32) -> WebviewOptions {
	return {
		window_id = window_id,
		renderer = .native,
		frame = DEFAULT_RECT,
		auto_resize = true,
		partition = "persist:default",
		sandbox = true,
	}
}

WGPUViewOptions :: struct {
	window_id:         u32,
	frame:             Rect,
	auto_resize:       bool,
	start_transparent: bool,
	start_passthrough: bool,
}

defaultWGPUViewOptions :: proc(window_id: u32) -> WGPUViewOptions {
	return {window_id = window_id, frame = DEFAULT_RECT, auto_resize = true}
}

TrayOptions :: struct {
	title:       string,
	image:       string,
	is_template: bool,
	width:       u32,
	height:      u32,
}

defaultTrayOptions :: proc(image: string) -> TrayOptions {
	return {image = image, width = 18, height = 18}
}

Display :: struct {
	id:          i64,
	bounds:      Rect,
	workArea:    Rect,
	scaleFactor: f64,
	isPrimary:   bool,
}

Point :: struct {
	x: f64,
	y: f64,
}

NotificationOptions :: struct {
	title:    string,
	body:     string,
	subtitle: string,
	silent:   bool,
}

Cookie :: struct {
	name:           string,
	value:          string,
	domain:         Maybe(string),
	path:           Maybe(string),
	secure:         Maybe(bool),
	httpOnly:       Maybe(bool),
	sameSite:       Maybe(string),
	expirationDate: Maybe(f64),
}

CookieFilter :: struct {
	url:     Maybe(string),
	name:    Maybe(string),
	domain:  Maybe(string),
	path:    Maybe(string),
	secure:  Maybe(bool),
	session: Maybe(bool),
}

StorageType :: enum {
	cookies,
	localStorage,
	sessionStorage,
	indexedDB,
	webSQL,
	cache,
	all,
}

@(private = "file")
STORAGE_TYPE_NAMES :: [StorageType]string {
	.cookies        = "cookies",
	.localStorage   = "localStorage",
	.sessionStorage = "sessionStorage",
	.indexedDB      = "indexedDB",
	.webSQL         = "webSQL",
	.cache          = "cache",
	.all            = "all",
}

OpenFileDialogOptions :: struct {
	starting_folder:           string,
	allowed_file_types:        string,
	can_choose_files:          bool,
	can_choose_directory:      bool,
	allows_multiple_selection: bool,
}

defaultOpenFileDialogOptions :: proc() -> OpenFileDialogOptions {
	return {
		starting_folder = "~/",
		allowed_file_types = "*",
		can_choose_files = true,
		can_choose_directory = true,
		allows_multiple_selection = true,
	}
}

DEFAULT_MESSAGE_BOX_BUTTONS := []string{"OK"}

MessageBoxOptions :: struct {
	box_type:   string,
	title:      string,
	message:    string,
	detail:     string,
	buttons:    []string,
	default_id: c.int,
	cancel_id:  c.int,
}

defaultMessageBoxOptions :: proc() -> MessageBoxOptions {
	return {box_type = "info", buttons = DEFAULT_MESSAGE_BOX_BUTTONS, default_id = 0, cancel_id = -1}
}

Paths :: struct {
	home:      string,
	appData:   string,
	config:    string,
	cache:     string,
	temp:      string,
	logs:      string,
	documents: string,
	downloads: string,
	desktop:   string,
	pictures:  string,
	music:     string,
	videos:    string,
	userData:  string,
	userCache: string,
	userLogs:  string,
}

pathsDeinit :: proc(self: ^Paths, allocator: runtime.Allocator) {
	delete(self.home, allocator)
	delete(self.appData, allocator)
	delete(self.config, allocator)
	delete(self.cache, allocator)
	delete(self.temp, allocator)
	delete(self.logs, allocator)
	delete(self.documents, allocator)
	delete(self.downloads, allocator)
	delete(self.desktop, allocator)
	delete(self.pictures, allocator)
	delete(self.music, allocator)
	delete(self.videos, allocator)
	delete(self.userData, allocator)
	delete(self.userCache, allocator)
	delete(self.userLogs, allocator)
}

// Mirrors zig's Paths.resolve.
resolvePaths :: proc(allocator: runtime.Allocator, app_info: AppInfo) -> (paths: Paths, err: Error) {
	defer if err != .None {
		pathsDeinit(&paths, allocator)
	}

	paths.home = get_home_dir(allocator) or_return
	paths.appData = get_app_data_dir(allocator, paths.home)
	paths.config = get_config_dir(allocator, paths.home)
	paths.cache = get_cache_dir(allocator, paths.home)
	paths.temp = get_temp_dir(allocator, paths.home)
	paths.logs = get_logs_dir(allocator, paths.home)

	paths.documents = get_user_dir(allocator, paths.home, "Documents", "Documents", "XDG_DOCUMENTS_DIR", "Documents")
	paths.downloads = get_user_dir(allocator, paths.home, "Downloads", "Downloads", "XDG_DOWNLOAD_DIR", "Downloads")
	paths.desktop = get_user_dir(allocator, paths.home, "Desktop", "Desktop", "XDG_DESKTOP_DIR", "Desktop")
	paths.pictures = get_user_dir(allocator, paths.home, "Pictures", "Pictures", "XDG_PICTURES_DIR", "Pictures")
	paths.music = get_user_dir(allocator, paths.home, "Music", "Music", "XDG_MUSIC_DIR", "Music")
	paths.videos = get_user_dir(allocator, paths.home, "Movies", "Videos", "XDG_VIDEOS_DIR", "Videos")

	paths.userData = build_app_scoped_dir(allocator, paths.appData, app_info)
	paths.userCache = build_app_scoped_dir(allocator, paths.cache, app_info)
	paths.userLogs = build_app_scoped_dir(allocator, paths.logs, app_info)

	return paths, .None
}

// ---------------------------------------------------------------------------
// Bundle paths / app info
// ---------------------------------------------------------------------------

BundlePaths :: struct {
	exe_dir:       string,
	resources_dir: string,
}

bundlePathsDeinit :: proc(self: ^BundlePaths, allocator: runtime.Allocator) {
	delete(self.exe_dir, allocator)
	delete(self.resources_dir, allocator)
}

resolveBundlePaths :: proc(allocator := context.allocator) -> (bundle_paths: BundlePaths, err: Error) {
	exe_path, exe_err := os.get_executable_path(allocator)
	if exe_err != nil {
		return {}, .InvalidExePath
	}
	defer delete(exe_path, allocator)

	exe_dir_name := os.dir(exe_path)
	if len(exe_dir_name) == 0 {
		return {}, .InvalidExePath
	}

	bundle_paths.exe_dir = clone_string(exe_dir_name, allocator)
	bundle_paths.resources_dir = join_path(allocator, {exe_dir_name, "..", "Resources"})
	return bundle_paths, .None
}

resolveAppInfoFromBundle :: proc(
	allocator: runtime.Allocator,
	bundle_paths: ^BundlePaths,
) -> (
	app_info: OwnedAppInfo,
	err: Error,
) {
	version_json_path := join_path(allocator, {bundle_paths.resources_dir, "version.json"})
	defer delete(version_json_path, allocator)

	version_json, read_err := os.read_entire_file(version_json_path, allocator)
	if read_err != nil {
		return {}, .FileReadFailed
	}
	defer delete(version_json, allocator)

	value, parse_err := json.parse(version_json, json.DEFAULT_SPECIFICATION, true, allocator)
	if parse_err != .None {
		return {}, .InvalidJson
	}
	defer json.destroy_value(value, allocator)

	obj, is_object := value.(json.Object)
	if !is_object {
		return {}, .InvalidJson
	}

	identifier, identifier_ok := object_string(obj, "identifier")
	name, name_ok := object_string(obj, "name")
	channel, channel_ok := object_string(obj, "channel")
	if !identifier_ok || !name_ok || !channel_ok {
		return {}, .InvalidJson
	}

	app_info.identifier = clone_string(identifier, allocator)
	app_info.name = clone_string(name, allocator)
	app_info.channel = clone_string(channel, allocator)
	return app_info, .None
}

// ---------------------------------------------------------------------------
// Window registry
// ---------------------------------------------------------------------------

BrowserWindowRef :: struct {
	registry: ^WindowRegistry,
	id:       u32,
}

WindowRegistry :: struct {
	allocator: runtime.Allocator,
	core:      ^Core,
	ids:       map[u32]bool,
}

windowRegistryInit :: proc(allocator: runtime.Allocator, core: ^Core) -> WindowRegistry {
	return {allocator = allocator, core = core, ids = make(map[u32]bool, allocator)}
}

windowRegistryDeinit :: proc(self: ^WindowRegistry) {
	delete(self.ids)
}

createBrowserWindow :: proc(self: ^WindowRegistry, options: WindowOptions) -> (window: BrowserWindowRef, err: Error) {
	id := createWindow(self.core, options) or_return
	self.ids[id] = true
	return BrowserWindowRef{registry = self, id = id}, .None
}

getById :: proc(self: ^WindowRegistry, id: u32) -> (window: BrowserWindowRef, ok: bool) {
	if id not_in self.ids {
		return {}, false
	}
	return BrowserWindowRef{registry = self, id = id}, true
}

windowClose :: proc(self: BrowserWindowRef) -> Error {
	closeWindow(self.registry.core, self.id) or_return
	delete_key(&self.registry.ids, self.id)
	return .None
}

getFrame :: proc(self: BrowserWindowRef) -> (Rect, Error) {
	return getWindowFrame(self.registry.core, self.id)
}

windowSetWindowButtonPosition :: proc(self: BrowserWindowRef, x: f64, y: f64) -> Error {
	return coreSetWindowButtonPosition(self.registry.core, self.id, x, y)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

SessionPartition :: struct {
	core:      ^Core,
	partition: string,
}

// Mirrors zig's Session.fromPartition.
sessionFromPartition :: proc(core: ^Core, partition: string) -> SessionPartition {
	return {core = core, partition = partition}
}

// Mirrors zig's Session.defaultSession.
defaultSession :: proc(core: ^Core) -> SessionPartition {
	return sessionFromPartition(core, "persist:default")
}

getCookies :: proc(self: SessionPartition, filter: Maybe(CookieFilter) = nil) -> ([]Cookie, Error) {
	filter_value := filter.? or_else CookieFilter{}
	filter_json := marshal_cookie_filter(self.core.allocator, filter_value)
	defer delete(filter_json, self.core.allocator)
	return sessionGetCookies(self.core, self.partition, filter_json)
}

setCookie :: proc(self: SessionPartition, cookie: Cookie) -> bool {
	cookie_json := marshal_cookie(self.core.allocator, cookie)
	defer delete(cookie_json, self.core.allocator)
	return sessionSetCookie(self.core, self.partition, cookie_json)
}

removeCookie :: proc(self: SessionPartition, url: string, name: string) -> bool {
	return sessionRemoveCookie(self.core, self.partition, url, name)
}

clearCookies :: proc(self: SessionPartition) -> Error {
	return sessionClearCookies(self.core, self.partition)
}

clearStorageData :: proc(self: SessionPartition, storage_types: []StorageType) -> Error {
	if len(storage_types) == 0 {
		return sessionClearStorageData(self.core, self.partition, "[\"all\"]")
	}

	names := STORAGE_TYPE_NAMES
	b := strings.builder_make(self.core.allocator)
	defer strings.builder_destroy(&b)
	strings.write_string(&b, "[")
	for storage_type, index in storage_types {
		if index > 0 {
			strings.write_string(&b, ",")
		}
		write_json_string(&b, names[storage_type])
	}
	strings.write_string(&b, "]")
	return sessionClearStorageData(self.core, self.partition, strings.to_string(b))
}

// ---------------------------------------------------------------------------
// WGPU (dawn) native library
// ---------------------------------------------------------------------------

WgpuAdapterDevice :: struct {
	adapter: rawptr,
	device:  rawptr,
}

WgpuCreateInstanceFn :: proc "c" (rawptr) -> rawptr
WgpuDeviceGetQueueFn :: proc "c" (rawptr) -> rawptr

WgpuSymbols :: struct {
	__handle:           dynlib.Library,
	wgpuCreateInstance: WgpuCreateInstanceFn,
	wgpuDeviceGetQueue: WgpuDeviceGetQueueFn,
}

WgpuNative :: struct {
	symbols: WgpuSymbols,
}

when ODIN_OS == .Windows {
	@(private = "file")
	CORE_LIB_NAME :: "ElectrobunCore.dll"
	@(private = "file")
	WGPU_LIB_NAME :: "webgpu_dawn.dll"
} else when ODIN_OS == .Darwin {
	@(private = "file")
	CORE_LIB_NAME :: "libElectrobunCore.dylib"
	@(private = "file")
	WGPU_LIB_NAME :: "libwebgpu_dawn.dylib"
} else {
	@(private = "file")
	CORE_LIB_NAME :: "libElectrobunCore.so"
	@(private = "file")
	WGPU_LIB_NAME :: "libwebgpu_dawn.so"
}

// Mirrors zig's WgpuNative.load.
wgpuNativeLoad :: proc(allocator := context.allocator) -> (native: WgpuNative, err: Error) {
	bundle_paths := resolveBundlePaths(allocator) or_return
	defer bundlePathsDeinit(&bundle_paths, allocator)

	lib_path := join_path(allocator, {bundle_paths.exe_dir, WGPU_LIB_NAME})
	defer delete(lib_path, allocator)

	count, _ := dynlib.initialize_symbols(&native.symbols, lib_path)
	if count == -1 || native.symbols.__handle == nil {
		fmt.eprintf("[electrobun-odin] failed to load %s: %s\n", lib_path, dynlib.last_error())
		return {}, .LibraryLoadFailed
	}
	if name, missing := missing_symbol_name(&native.symbols); missing {
		fmt.eprintf("[electrobun-odin] missing wgpu symbol: %s\n", name)
		dynlib.unload_library(native.symbols.__handle)
		return {}, .MissingCoreSymbol
	}
	return native, .None
}

wgpuNativeClose :: proc(self: ^WgpuNative) {
	dynlib.unload_library(self.symbols.__handle)
	self.symbols.__handle = nil
}

createInstance :: proc(self: ^WgpuNative) -> rawptr {
	return self.symbols.wgpuCreateInstance(nil)
}

deviceGetQueue :: proc(self: ^WgpuNative, device: rawptr) -> rawptr {
	return self.symbols.wgpuDeviceGetQueue(device)
}

WgpuContext :: struct {
	view_ptr:     rawptr,
	instance_ptr: rawptr,
	surface_ptr:  rawptr,
	adapter_ptr:  rawptr,
	device_ptr:   rawptr,
}

createForView :: proc(core: ^Core, native: ^WgpuNative, view_ptr: rawptr) -> (ctx: WgpuContext, err: Error) {
	instance_ptr := createInstance(native)
	if instance_ptr == nil {
		return {}, .ElectrobunCoreFailure
	}
	surface_ptr := wgpuCreateSurfaceForView(core, instance_ptr, view_ptr) or_return

	adapter_device := [2]uintptr{0, 0}
	wgpuCreateAdapterDeviceMainThread(core, instance_ptr, surface_ptr, &adapter_device) or_return

	adapter_ptr := rawptr(adapter_device[0])
	device_ptr := rawptr(adapter_device[1])
	if device_ptr == nil {
		return {}, .ElectrobunCoreFailure
	}

	return WgpuContext{
			view_ptr = view_ptr,
			instance_ptr = instance_ptr,
			surface_ptr = surface_ptr,
			adapter_ptr = adapter_ptr,
			device_ptr = device_ptr,
		},
		.None
}

createForWgpuView :: proc(core: ^Core, native: ^WgpuNative, wgpu_view_id: u32) -> (ctx: WgpuContext, err: Error) {
	view_ptr := getWGPUViewPointer(core, wgpu_view_id) or_return
	return createForView(core, native, view_ptr)
}

getQueue :: proc(self: WgpuContext, native: ^WgpuNative) -> rawptr {
	return deviceGetQueue(native, self.device_ptr)
}

// ---------------------------------------------------------------------------
// Core symbol table (field names are the exact C ABI symbol names)
// ---------------------------------------------------------------------------

LastErrorFn :: proc "c" () -> cstring
RunMainThreadFn :: proc "c" (cstring, cstring, cstring, c.int) -> c.int
ConfigureWebviewRuntimeFn :: proc "c" (u32, cstring, cstring) -> bool
GetWindowStyleFn :: proc "c" (bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool) -> u32
CreateWindowFn :: proc "c" (f64, f64, f64, f64, u32, cstring, bool, cstring, bool, bool, f64, f64, WindowCloseHandler, WindowMoveHandler, WindowResizeHandler, WindowFocusHandler, WindowBlurHandler, WindowKeyHandler) -> u32
CreateWebviewFn :: proc "c" (u32, u32, cstring, cstring, f64, f64, f64, f64, bool, cstring, DecideNavigationHandler, WebviewEventHandler, WebviewPostMessageHandler, WebviewPostMessageHandler, WebviewPostMessageHandler, cstring, cstring, cstring, bool, bool, bool) -> u32
CreateWGPUViewFn :: proc "c" (u32, f64, f64, f64, f64, bool, bool, bool) -> u32
SetWindowTitleFn :: proc "c" (u32, cstring)
WindowIdFn :: proc "c" (u32)
WindowIdBoolFn :: proc "c" (u32) -> bool
SetWindowBoolFn :: proc "c" (u32, bool)
SetWindowXYFn :: proc "c" (u32, f64, f64)
SetWindowFrameFn :: proc "c" (u32, f64, f64, f64, f64)
GetWindowFrameFn :: proc "c" (u32, ^f64, ^f64, ^f64, ^f64)
ResizeViewFn :: proc "c" (u32, f64, f64, f64, f64, cstring)
IdCstringFn :: proc "c" (u32, cstring)
UpdatePreloadScriptToWebViewFn :: proc "c" (u32, cstring, cstring, bool)
SendMessageToWebviewFn :: proc "c" (u32, cstring) -> bool
PopNextQueuedHostMessageFn :: proc "c" (^u32) -> cstring
FreeCoreStringFn :: proc "c" (cstring)
WebviewSetPageZoomFn :: proc "c" (u32, f64)
WebviewGetPageZoomFn :: proc "c" (u32) -> f64
WebviewFindInPageFn :: proc "c" (u32, cstring, bool, bool)
GetViewPointerFn :: proc "c" (u32) -> rawptr
CreateTrayFn :: proc "c" (cstring, cstring, bool, u32, u32, StatusItemHandler) -> u32
GetTrayBoundsFn :: proc "c" (u32) -> cstring
SetBoolFn :: proc "c" (bool)
GetBoolFn :: proc "c" () -> bool
GetCstringFn :: proc "c" () -> cstring
CstringToBoolFn :: proc "c" (cstring) -> bool
CstringVoidFn :: proc "c" (cstring)
ShowNotificationFn :: proc "c" (cstring, cstring, cstring, bool)
VoidFn :: proc "c" ()
SetMenuFn :: proc "c" (cstring, StatusItemHandler)
OpenFileDialogFn :: proc "c" (cstring, cstring, c.int, c.int, c.int) -> cstring
ShowMessageBoxFn :: proc "c" (cstring, cstring, cstring, cstring, cstring, c.int, c.int) -> c.int
SetGlobalShortcutCallbackFn :: proc "c" (GlobalShortcutHandler)
SessionGetCookiesFn :: proc "c" (cstring, cstring) -> cstring
SessionSetCookieFn :: proc "c" (cstring, cstring) -> bool
SessionRemoveCookieFn :: proc "c" (cstring, cstring, cstring) -> bool
SetURLOpenHandlerFn :: proc "c" (URLOpenHandler)
SetAppReopenHandlerFn :: proc "c" (AppReopenHandler)
SetQuitRequestedHandlerFn :: proc "c" (QuitRequestedHandler)
IntVoidFn :: proc "c" (c.int)
WgpuCreateSurfaceForViewFn :: proc "c" (rawptr, rawptr) -> rawptr
WgpuTwoPtrVoidFn :: proc "c" (rawptr, rawptr)
WgpuThreePtrVoidFn :: proc "c" (rawptr, rawptr, rawptr)
WgpuPresentFn :: proc "c" (rawptr) -> i32

Symbols :: struct {
	__handle:                               dynlib.Library,
	electrobun_core_last_error:             LastErrorFn,
	electrobun_core_run_main_thread:        RunMainThreadFn,
	configureWebviewRuntime:                ConfigureWebviewRuntimeFn,
	getWindowStyle:                         GetWindowStyleFn,
	createWindow:                           CreateWindowFn,
	createWebview:                          CreateWebviewFn,
	createWGPUView:                         CreateWGPUViewFn,
	setWindowTitle:                         SetWindowTitleFn,
	minimizeWindow:                         WindowIdFn,
	restoreWindow:                          WindowIdFn,
	isWindowMinimized:                      WindowIdBoolFn,
	maximizeWindow:                         WindowIdFn,
	unmaximizeWindow:                       WindowIdFn,
	isWindowMaximized:                      WindowIdBoolFn,
	setWindowFullScreen:                    SetWindowBoolFn,
	isWindowFullScreen:                     WindowIdBoolFn,
	setWindowAlwaysOnTop:                   SetWindowBoolFn,
	isWindowAlwaysOnTop:                    WindowIdBoolFn,
	setWindowVisibleOnAllWorkspaces:        SetWindowBoolFn,
	isWindowVisibleOnAllWorkspaces:         WindowIdBoolFn,
	showWindow:                             SetWindowBoolFn,
	activateWindow:                         WindowIdFn,
	hideWindow:                             WindowIdFn,
	setWindowButtonPosition:                SetWindowXYFn,
	setWindowPosition:                      SetWindowXYFn,
	setWindowSize:                          SetWindowXYFn,
	setWindowFrame:                         SetWindowFrameFn,
	getWindowFrame:                         GetWindowFrameFn,
	closeWindow:                            WindowIdFn,
	resizeWebview:                          ResizeViewFn,
	loadURLInWebView:                       IdCstringFn,
	loadHTMLInWebView:                      IdCstringFn,
	updatePreloadScriptToWebView:           UpdatePreloadScriptToWebViewFn,
	webviewCanGoBack:                       WindowIdBoolFn,
	webviewCanGoForward:                    WindowIdBoolFn,
	webviewGoBack:                          WindowIdFn,
	webviewGoForward:                       WindowIdFn,
	webviewReload:                          WindowIdFn,
	webviewRemove:                          WindowIdFn,
	setWebviewHTMLContent:                  IdCstringFn,
	webviewSetTransparent:                  SetWindowBoolFn,
	webviewSetPassthrough:                  SetWindowBoolFn,
	webviewSetHidden:                       SetWindowBoolFn,
	setWebviewNavigationRules:              IdCstringFn,
	webviewFindInPage:                      WebviewFindInPageFn,
	webviewStopFind:                        WindowIdFn,
	sendInternalMessageToWebview:           SendMessageToWebviewFn,
	sendHostMessageToWebviewViaTransport:   SendMessageToWebviewFn,
	popNextQueuedHostMessage:               PopNextQueuedHostMessageFn,
	freeCoreString:                         FreeCoreStringFn,
	webviewOpenDevTools:                    WindowIdFn,
	webviewCloseDevTools:                   WindowIdFn,
	webviewToggleDevTools:                  WindowIdFn,
	webviewSetPageZoom:                     WebviewSetPageZoomFn,
	webviewGetPageZoom:                     WebviewGetPageZoomFn,
	setWGPUViewFrame:                       SetWindowFrameFn,
	resizeWGPUView:                         ResizeViewFn,
	setWGPUViewTransparent:                 SetWindowBoolFn,
	setWGPUViewPassthrough:                 SetWindowBoolFn,
	setWGPUViewHidden:                      SetWindowBoolFn,
	removeWGPUView:                         WindowIdFn,
	getWGPUViewPointer:                     GetViewPointerFn,
	getWGPUViewNativeHandle:                GetViewPointerFn,
	runWGPUViewTest:                        WindowIdFn,
	toggleWGPUViewTestShader:               WindowIdFn,
	evaluateJavaScriptWithNoCompletion:     IdCstringFn,
	createTray:                             CreateTrayFn,
	showTray:                               WindowIdBoolFn,
	hideTray:                               WindowIdFn,
	setTrayTitle:                           IdCstringFn,
	removeTray:                             WindowIdFn,
	getTrayBounds:                          GetTrayBoundsFn,
	setDockIconVisible:                     SetBoolFn,
	isDockIconVisible:                      GetBoolFn,
	getPrimaryDisplay:                      GetCstringFn,
	getAllDisplays:                         GetCstringFn,
	getCursorScreenPoint:                   GetCstringFn,
	moveToTrash:                            CstringToBoolFn,
	showItemInFolder:                       CstringVoidFn,
	openExternal:                           CstringToBoolFn,
	openPath:                               CstringToBoolFn,
	showNotification:                       ShowNotificationFn,
	clipboardReadText:                      GetCstringFn,
	clipboardWriteText:                     CstringVoidFn,
	clipboardClear:                         VoidFn,
	clipboardAvailableFormats:              GetCstringFn,
	setApplicationMenu:                     SetMenuFn,
	showContextMenu:                        SetMenuFn,
	openFileDialog:                         OpenFileDialogFn,
	showMessageBox:                         ShowMessageBoxFn,
	setGlobalShortcutCallback:              SetGlobalShortcutCallbackFn,
	registerGlobalShortcut:                 CstringToBoolFn,
	unregisterGlobalShortcut:               CstringToBoolFn,
	unregisterAllGlobalShortcuts:           VoidFn,
	isGlobalShortcutRegistered:             CstringToBoolFn,
	sessionGetCookies:                      SessionGetCookiesFn,
	sessionSetCookie:                       SessionSetCookieFn,
	sessionRemoveCookie:                    SessionRemoveCookieFn,
	sessionClearCookies:                    CstringVoidFn,
	sessionClearStorageData:                proc "c" (cstring, cstring),
	setURLOpenHandler:                      SetURLOpenHandlerFn,
	setAppReopenHandler:                    SetAppReopenHandlerFn,
	setQuitRequestedHandler:                SetQuitRequestedHandlerFn,
	stopEventLoop:                          VoidFn,
	waitForShutdownComplete:                IntVoidFn,
	forceExit:                              IntVoidFn,
	wgpuCreateSurfaceForView:               WgpuCreateSurfaceForViewFn,
	wgpuCreateAdapterDeviceMainThread:      WgpuThreePtrVoidFn,
	wgpuSurfaceConfigureMainThread:         WgpuTwoPtrVoidFn,
	wgpuSurfaceGetCurrentTextureMainThread: WgpuTwoPtrVoidFn,
	wgpuSurfacePresentMainThread:           WgpuPresentFn,
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

Core :: struct {
	allocator: runtime.Allocator,
	symbols:   Symbols,
}

// Mirrors zig's Core.load. Loads libElectrobunCore from the executable's
// directory and resolves every required symbol.
coreLoad :: proc(allocator := context.allocator) -> (core: Core, err: Error) {
	bundle_paths := resolveBundlePaths(allocator) or_return
	defer bundlePathsDeinit(&bundle_paths, allocator)

	lib_path := join_path(allocator, {bundle_paths.exe_dir, CORE_LIB_NAME})
	defer delete(lib_path, allocator)

	core.allocator = allocator
	count, _ := dynlib.initialize_symbols(&core.symbols, lib_path)
	if count == -1 || core.symbols.__handle == nil {
		fmt.eprintf("[electrobun-odin] failed to load %s: %s\n", lib_path, dynlib.last_error())
		return {}, .LibraryLoadFailed
	}
	if name, missing := missing_symbol_name(&core.symbols); missing {
		fmt.eprintf("[electrobun-odin] missing core symbol: %s\n", name)
		dynlib.unload_library(core.symbols.__handle)
		return {}, .MissingCoreSymbol
	}
	return core, .None
}

coreClose :: proc(self: ^Core) {
	dynlib.unload_library(self.symbols.__handle)
	self.symbols.__handle = nil
}

configureWebviewRuntimeFromExecutableDir :: proc(
	self: ^Core,
	bundle_paths: ^BundlePaths,
	rpc_port: u32,
) -> Error {
	full_path := join_path(self.allocator, {bundle_paths.resources_dir, "preload-full.js"})
	defer delete(full_path, self.allocator)
	sandboxed_path := join_path(self.allocator, {bundle_paths.resources_dir, "preload-sandboxed.js"})
	defer delete(sandboxed_path, self.allocator)

	full_preload, full_err := read_file_cstring(self, full_path)
	if full_err != .None {
		return full_err
	}
	defer delete(full_preload, self.allocator)
	sandboxed_preload, sandboxed_err := read_file_cstring(self, sandboxed_path)
	if sandboxed_err != .None {
		return sandboxed_err
	}
	defer delete(sandboxed_preload, self.allocator)

	if !self.symbols.configureWebviewRuntime(rpc_port, full_preload, sandboxed_preload) {
		return error_from_last_error(last_error_string(self))
	}
	return .None
}

defaultWindowStyle :: proc(self: ^Core) -> u32 {
	return self.symbols.getWindowStyle(
		false,
		true,
		true,
		true,
		true,
		false,
		false,
		false,
		false,
		false,
		false,
		false,
	)
}

createWindow :: proc(self: ^Core, options: WindowOptions) -> (window_id: u32, err: Error) {
	title_z := dupe_cstring(self, options.title)
	defer delete(title_z, self.allocator)
	title_bar_style_z := dupe_cstring(self, options.title_bar_style)
	defer delete(title_bar_style_z, self.allocator)

	style_mask := self.symbols.getWindowStyle(
		options.style.borderless,
		options.style.titled,
		options.style.closable,
		options.style.miniaturizable,
		options.style.resizable,
		options.style.unified_title_and_toolbar,
		options.style.full_screen,
		options.style.full_size_content_view,
		options.style.utility_window,
		options.style.doc_modal_window,
		options.style.nonactivating_panel,
		options.style.hud_window,
	)

	window_id = self.symbols.createWindow(
		options.frame.x,
		options.frame.y,
		options.frame.width,
		options.frame.height,
		style_mask,
		title_bar_style_z,
		options.transparent,
		title_z,
		options.hidden,
		options.activate,
		options.traffic_light_offset.x,
		options.traffic_light_offset.y,
		options.callbacks.close,
		options.callbacks.move,
		options.callbacks.resize,
		options.callbacks.focus,
		options.callbacks.blur,
		options.callbacks.key,
	)

	if window_id == 0 {
		return 0, error_from_last_error(last_error_string(self))
	}
	return window_id, .None
}

setWindowTitle :: proc(self: ^Core, window_id: u32, title: string) -> Error {
	title_z := dupe_cstring(self, title)
	defer delete(title_z, self.allocator)
	self.symbols.setWindowTitle(window_id, title_z)
	return ensure_last_call_succeeded(self)
}

minimizeWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.minimizeWindow(window_id)
	return ensure_last_call_succeeded(self)
}

restoreWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.restoreWindow(window_id)
	return ensure_last_call_succeeded(self)
}

isWindowMinimized :: proc(self: ^Core, window_id: u32) -> bool {
	return self.symbols.isWindowMinimized(window_id)
}

maximizeWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.maximizeWindow(window_id)
	return ensure_last_call_succeeded(self)
}

unmaximizeWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.unmaximizeWindow(window_id)
	return ensure_last_call_succeeded(self)
}

isWindowMaximized :: proc(self: ^Core, window_id: u32) -> bool {
	return self.symbols.isWindowMaximized(window_id)
}

setWindowFullScreen :: proc(self: ^Core, window_id: u32, full_screen: bool) -> Error {
	self.symbols.setWindowFullScreen(window_id, full_screen)
	return ensure_last_call_succeeded(self)
}

isWindowFullScreen :: proc(self: ^Core, window_id: u32) -> bool {
	return self.symbols.isWindowFullScreen(window_id)
}

setWindowAlwaysOnTop :: proc(self: ^Core, window_id: u32, always_on_top: bool) -> Error {
	self.symbols.setWindowAlwaysOnTop(window_id, always_on_top)
	return ensure_last_call_succeeded(self)
}

isWindowAlwaysOnTop :: proc(self: ^Core, window_id: u32) -> bool {
	return self.symbols.isWindowAlwaysOnTop(window_id)
}

setWindowVisibleOnAllWorkspaces :: proc(self: ^Core, window_id: u32, visible: bool) -> Error {
	self.symbols.setWindowVisibleOnAllWorkspaces(window_id, visible)
	return ensure_last_call_succeeded(self)
}

isWindowVisibleOnAllWorkspaces :: proc(self: ^Core, window_id: u32) -> bool {
	return self.symbols.isWindowVisibleOnAllWorkspaces(window_id)
}

showWindow :: proc(self: ^Core, window_id: u32, activate: bool) -> Error {
	self.symbols.showWindow(window_id, activate)
	return ensure_last_call_succeeded(self)
}

activateWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.activateWindow(window_id)
	return ensure_last_call_succeeded(self)
}

hideWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.hideWindow(window_id)
	return ensure_last_call_succeeded(self)
}

coreSetWindowButtonPosition :: proc(self: ^Core, window_id: u32, x: f64, y: f64) -> Error {
	self.symbols.setWindowButtonPosition(window_id, x, y)
	return ensure_last_call_succeeded(self)
}

setWindowPosition :: proc(self: ^Core, window_id: u32, x: f64, y: f64) -> Error {
	self.symbols.setWindowPosition(window_id, x, y)
	return ensure_last_call_succeeded(self)
}

setWindowSize :: proc(self: ^Core, window_id: u32, width: f64, height: f64) -> Error {
	self.symbols.setWindowSize(window_id, width, height)
	return ensure_last_call_succeeded(self)
}

setWindowFrame :: proc(self: ^Core, window_id: u32, frame: Rect) -> Error {
	self.symbols.setWindowFrame(window_id, frame.x, frame.y, frame.width, frame.height)
	return ensure_last_call_succeeded(self)
}

getWindowFrame :: proc(self: ^Core, window_id: u32) -> (frame: Rect, err: Error) {
	x, y, width, height: f64
	self.symbols.getWindowFrame(window_id, &x, &y, &width, &height)
	ensure_last_call_succeeded(self) or_return
	return Rect{x = x, y = y, width = width, height = height}, .None
}

closeWindow :: proc(self: ^Core, window_id: u32) -> Error {
	self.symbols.closeWindow(window_id)
	return ensure_last_call_succeeded(self)
}

createWebview :: proc(self: ^Core, options: WebviewOptions) -> (webview_id: u32, err: Error) {
	renderer_z := dupe_cstring(self, rendererName(options.renderer))
	defer delete(renderer_z, self.allocator)
	url_z := dupe_cstring(self, options.url)
	defer delete(url_z, self.allocator)
	partition_z := dupe_cstring(self, options.partition)
	defer delete(partition_z, self.allocator)
	secret_key_z := dupe_cstring(self, options.secret_key)
	defer delete(secret_key_z, self.allocator)
	preload_z := dupe_cstring(self, options.preload)
	defer delete(preload_z, self.allocator)
	views_root_z := dupe_cstring(self, options.views_root)
	defer delete(views_root_z, self.allocator)

	host_bridge := options.callbacks.host_bridge
	if host_bridge == nil {
		host_bridge = options.callbacks.bun_bridge
	}

	webview_id = self.symbols.createWebview(
		options.window_id,
		options.host_webview_id,
		renderer_z,
		url_z,
		options.frame.x,
		options.frame.y,
		options.frame.width,
		options.frame.height,
		options.auto_resize,
		partition_z,
		options.callbacks.decide_navigation,
		options.callbacks.event,
		options.callbacks.event_bridge,
		host_bridge,
		options.callbacks.internal_bridge,
		secret_key_z,
		preload_z,
		views_root_z,
		options.sandbox,
		options.start_transparent,
		options.start_passthrough,
	)

	if webview_id == 0 {
		return 0, error_from_last_error(last_error_string(self))
	}
	return webview_id, .None
}

resizeWebview :: proc(self: ^Core, webview_id: u32, frame: Rect, masks_json: string) -> Error {
	masks_json_z := dupe_cstring(self, masks_json)
	defer delete(masks_json_z, self.allocator)
	self.symbols.resizeWebview(webview_id, frame.x, frame.y, frame.width, frame.height, masks_json_z)
	return ensure_last_call_succeeded(self)
}

loadURLInWebview :: proc(self: ^Core, webview_id: u32, url: string) -> Error {
	url_z := dupe_cstring(self, url)
	defer delete(url_z, self.allocator)
	self.symbols.loadURLInWebView(webview_id, url_z)
	return ensure_last_call_succeeded(self)
}

loadHTMLInWebview :: proc(self: ^Core, webview_id: u32, html: string) -> Error {
	html_z := dupe_cstring(self, html)
	defer delete(html_z, self.allocator)
	self.symbols.loadHTMLInWebView(webview_id, html_z)
	return ensure_last_call_succeeded(self)
}

updatePreloadScriptToWebview :: proc(
	self: ^Core,
	webview_id: u32,
	script_identifier: string,
	script: string,
	all_frames: bool,
) -> Error {
	script_identifier_z := dupe_cstring(self, script_identifier)
	defer delete(script_identifier_z, self.allocator)
	script_z := dupe_cstring(self, script)
	defer delete(script_z, self.allocator)
	self.symbols.updatePreloadScriptToWebView(webview_id, script_identifier_z, script_z, all_frames)
	return ensure_last_call_succeeded(self)
}

canWebviewGoBack :: proc(self: ^Core, webview_id: u32) -> bool {
	return self.symbols.webviewCanGoBack(webview_id)
}

canWebviewGoForward :: proc(self: ^Core, webview_id: u32) -> bool {
	return self.symbols.webviewCanGoForward(webview_id)
}

webviewGoBack :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewGoBack(webview_id)
	return ensure_last_call_succeeded(self)
}

webviewGoForward :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewGoForward(webview_id)
	return ensure_last_call_succeeded(self)
}

reloadWebview :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewReload(webview_id)
	return ensure_last_call_succeeded(self)
}

removeWebview :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewRemove(webview_id)
	return ensure_last_call_succeeded(self)
}

setWebviewHTMLContent :: proc(self: ^Core, webview_id: u32, html: string) -> Error {
	html_z := dupe_cstring(self, html)
	defer delete(html_z, self.allocator)
	self.symbols.setWebviewHTMLContent(webview_id, html_z)
	return ensure_last_call_succeeded(self)
}

setWebviewTransparent :: proc(self: ^Core, webview_id: u32, transparent: bool) -> Error {
	self.symbols.webviewSetTransparent(webview_id, transparent)
	return ensure_last_call_succeeded(self)
}

setWebviewPassthrough :: proc(self: ^Core, webview_id: u32, passthrough: bool) -> Error {
	self.symbols.webviewSetPassthrough(webview_id, passthrough)
	return ensure_last_call_succeeded(self)
}

setWebviewHidden :: proc(self: ^Core, webview_id: u32, hidden: bool) -> Error {
	self.symbols.webviewSetHidden(webview_id, hidden)
	return ensure_last_call_succeeded(self)
}

setWebviewNavigationRules :: proc(self: ^Core, webview_id: u32, rules_json: string) -> Error {
	rules_json_z := dupe_cstring(self, rules_json)
	defer delete(rules_json_z, self.allocator)
	self.symbols.setWebviewNavigationRules(webview_id, rules_json_z)
	return ensure_last_call_succeeded(self)
}

webviewFindInPage :: proc(self: ^Core, webview_id: u32, search_text: string, forward: bool, match_case: bool) -> Error {
	search_text_z := dupe_cstring(self, search_text)
	defer delete(search_text_z, self.allocator)
	self.symbols.webviewFindInPage(webview_id, search_text_z, forward, match_case)
	return ensure_last_call_succeeded(self)
}

webviewStopFind :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewStopFind(webview_id)
	return ensure_last_call_succeeded(self)
}

openWebviewDevTools :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewOpenDevTools(webview_id)
	return ensure_last_call_succeeded(self)
}

closeWebviewDevTools :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewCloseDevTools(webview_id)
	return ensure_last_call_succeeded(self)
}

toggleWebviewDevTools :: proc(self: ^Core, webview_id: u32) -> Error {
	self.symbols.webviewToggleDevTools(webview_id)
	return ensure_last_call_succeeded(self)
}

setWebviewPageZoom :: proc(self: ^Core, webview_id: u32, zoom_level: f64) -> Error {
	self.symbols.webviewSetPageZoom(webview_id, zoom_level)
	return ensure_last_call_succeeded(self)
}

getWebviewPageZoom :: proc(self: ^Core, webview_id: u32) -> f64 {
	return self.symbols.webviewGetPageZoom(webview_id)
}

createWGPUView :: proc(self: ^Core, options: WGPUViewOptions) -> (wgpu_view_id: u32, err: Error) {
	wgpu_view_id = self.symbols.createWGPUView(
		options.window_id,
		options.frame.x,
		options.frame.y,
		options.frame.width,
		options.frame.height,
		options.auto_resize,
		options.start_transparent,
		options.start_passthrough,
	)
	if wgpu_view_id == 0 {
		return 0, error_from_last_error(last_error_string(self))
	}
	return wgpu_view_id, .None
}

setWGPUViewFrame :: proc(self: ^Core, wgpu_view_id: u32, frame: Rect) -> Error {
	self.symbols.setWGPUViewFrame(wgpu_view_id, frame.x, frame.y, frame.width, frame.height)
	return ensure_last_call_succeeded(self)
}

resizeWGPUView :: proc(self: ^Core, wgpu_view_id: u32, frame: Rect, masks_json: string) -> Error {
	masks_json_z := dupe_cstring(self, masks_json)
	defer delete(masks_json_z, self.allocator)
	self.symbols.resizeWGPUView(wgpu_view_id, frame.x, frame.y, frame.width, frame.height, masks_json_z)
	return ensure_last_call_succeeded(self)
}

setWGPUViewTransparent :: proc(self: ^Core, wgpu_view_id: u32, transparent: bool) -> Error {
	self.symbols.setWGPUViewTransparent(wgpu_view_id, transparent)
	return ensure_last_call_succeeded(self)
}

setWGPUViewPassthrough :: proc(self: ^Core, wgpu_view_id: u32, passthrough: bool) -> Error {
	self.symbols.setWGPUViewPassthrough(wgpu_view_id, passthrough)
	return ensure_last_call_succeeded(self)
}

setWGPUViewHidden :: proc(self: ^Core, wgpu_view_id: u32, hidden: bool) -> Error {
	self.symbols.setWGPUViewHidden(wgpu_view_id, hidden)
	return ensure_last_call_succeeded(self)
}

removeWGPUView :: proc(self: ^Core, wgpu_view_id: u32) -> Error {
	self.symbols.removeWGPUView(wgpu_view_id)
	return ensure_last_call_succeeded(self)
}

getWGPUViewPointer :: proc(self: ^Core, wgpu_view_id: u32) -> (handle: rawptr, err: Error) {
	handle = self.symbols.getWGPUViewPointer(wgpu_view_id)
	ensure_last_call_succeeded(self) or_return
	return handle, .None
}

getWGPUViewNativeHandle :: proc(self: ^Core, wgpu_view_id: u32) -> (handle: rawptr, err: Error) {
	handle = self.symbols.getWGPUViewNativeHandle(wgpu_view_id)
	ensure_last_call_succeeded(self) or_return
	return handle, .None
}

runWGPUViewTest :: proc(self: ^Core, wgpu_view_id: u32) -> Error {
	self.symbols.runWGPUViewTest(wgpu_view_id)
	return ensure_last_call_succeeded(self)
}

toggleWGPUViewTestShader :: proc(self: ^Core, wgpu_view_id: u32) -> Error {
	self.symbols.toggleWGPUViewTestShader(wgpu_view_id)
	return ensure_last_call_succeeded(self)
}

evaluateJavaScriptWithNoCompletion :: proc(self: ^Core, webview_id: u32, js: string) -> Error {
	js_z := dupe_cstring(self, js)
	defer delete(js_z, self.allocator)
	self.symbols.evaluateJavaScriptWithNoCompletion(webview_id, js_z)
	return ensure_last_call_succeeded(self)
}

// `message` is JSON-encoded with core:encoding/json (mirrors zig's
// std.json.stringifyAlloc of an anytype message).
sendHostMessageToWebview :: proc(self: ^Core, webview_id: u32, message: any) -> Error {
	message_json_bytes, marshal_err := json.marshal(message, {}, self.allocator)
	if marshal_err != nil {
		return .InvalidJson
	}
	defer delete(message_json_bytes, self.allocator)
	message_json := string(message_json_bytes)

	message_json_z := dupe_cstring(self, message_json)
	defer delete(message_json_z, self.allocator)

	if self.symbols.sendHostMessageToWebviewViaTransport(webview_id, message_json_z) {
		return .None
	}

	js := fmt.aprintf(
		"window.__electrobun.receiveMessageFromHost(%s);",
		message_json,
		allocator = self.allocator,
	)
	defer delete(js, self.allocator)
	return evaluateJavaScriptWithNoCompletion(self, webview_id, js)
}

sendMessageToWebview :: proc(self: ^Core, webview_id: u32, message: any) -> Error {
	return sendHostMessageToWebview(self, webview_id, message)
}

// The returned cstring is owned by the native layer; release it with
// freeCoreString. Returns nil when the queue is empty.
popNextQueuedHostMessage :: proc(self: ^Core, out_webview_id: ^u32) -> cstring {
	return self.symbols.popNextQueuedHostMessage(out_webview_id)
}

freeCoreString :: proc(self: ^Core, value: cstring) {
	self.symbols.freeCoreString(value)
}

sendInternalMessageToWebview :: proc(self: ^Core, webview_id: u32, message: any) -> Error {
	message_json_bytes, marshal_err := json.marshal(message, {}, self.allocator)
	if marshal_err != nil {
		return .InvalidJson
	}
	defer delete(message_json_bytes, self.allocator)

	message_json_z := dupe_cstring(self, string(message_json_bytes))
	defer delete(message_json_z, self.allocator)

	if !self.symbols.sendInternalMessageToWebview(webview_id, message_json_z) {
		return error_from_last_error(last_error_string(self))
	}
	return .None
}

createTray :: proc(self: ^Core, options: TrayOptions) -> (tray_id: u32, err: Error) {
	title_z := dupe_cstring(self, options.title)
	defer delete(title_z, self.allocator)
	image_z := dupe_cstring(self, options.image)
	defer delete(image_z, self.allocator)

	tray_id = self.symbols.createTray(title_z, image_z, options.is_template, options.width, options.height, nil)
	if tray_id == 0 {
		return 0, error_from_last_error(last_error_string(self))
	}
	return tray_id, .None
}

setApplicationMenuJson :: proc(self: ^Core, menu_json: string, handler: StatusItemHandler) -> Error {
	menu_json_z := dupe_cstring(self, menu_json)
	defer delete(menu_json_z, self.allocator)
	self.symbols.setApplicationMenu(menu_json_z, handler)
	return ensure_last_call_succeeded(self)
}

showContextMenuJson :: proc(self: ^Core, menu_json: string, handler: StatusItemHandler) -> Error {
	menu_json_z := dupe_cstring(self, menu_json)
	defer delete(menu_json_z, self.allocator)
	self.symbols.showContextMenu(menu_json_z, handler)
	return ensure_last_call_succeeded(self)
}

showTray :: proc(self: ^Core, tray_id: u32) -> Error {
	if !self.symbols.showTray(tray_id) {
		return error_from_last_error(last_error_string(self))
	}
	return .None
}

hideTray :: proc(self: ^Core, tray_id: u32) -> Error {
	self.symbols.hideTray(tray_id)
	return ensure_last_call_succeeded(self)
}

setTrayTitle :: proc(self: ^Core, tray_id: u32, title: string) -> Error {
	title_z := dupe_cstring(self, title)
	defer delete(title_z, self.allocator)
	self.symbols.setTrayTitle(tray_id, title_z)
	return ensure_last_call_succeeded(self)
}

getTrayBounds :: proc(self: ^Core, tray_id: u32) -> (Rect, Error) {
	bounds_json := self.symbols.getTrayBounds(tray_id)
	return parse_rect_json(self.allocator, string(bounds_json))
}

removeTray :: proc(self: ^Core, tray_id: u32) -> Error {
	self.symbols.removeTray(tray_id)
	return ensure_last_call_succeeded(self)
}

setDockIconVisible :: proc(self: ^Core, visible: bool) -> Error {
	self.symbols.setDockIconVisible(visible)
	return ensure_last_call_succeeded(self)
}

isDockIconVisible :: proc(self: ^Core) -> bool {
	return self.symbols.isDockIconVisible()
}

getPrimaryDisplay :: proc(self: ^Core) -> (display: Display, err: Error) {
	json_text := self.symbols.getPrimaryDisplay()
	if json_text == nil {
		return {}, .ElectrobunCoreFailure
	}
	return parse_display_json(self.allocator, string(json_text))
}

// The returned slice is allocated with core.allocator; free with delete().
getAllDisplays :: proc(self: ^Core) -> (displays: []Display, err: Error) {
	json_text := self.symbols.getAllDisplays()
	if json_text == nil {
		return nil, .ElectrobunCoreFailure
	}
	return parse_displays_json(self.allocator, string(json_text))
}

getCursorScreenPoint :: proc(self: ^Core) -> (point: Point, err: Error) {
	json_text := self.symbols.getCursorScreenPoint()
	if json_text == nil {
		return {}, .ElectrobunCoreFailure
	}
	return parse_point_json(self.allocator, string(json_text))
}

moveToTrash :: proc(self: ^Core, path: string) -> bool {
	path_z := dupe_cstring(self, path)
	defer delete(path_z, self.allocator)
	return self.symbols.moveToTrash(path_z)
}

showItemInFolder :: proc(self: ^Core, path: string) -> Error {
	path_z := dupe_cstring(self, path)
	defer delete(path_z, self.allocator)
	self.symbols.showItemInFolder(path_z)
	return ensure_last_call_succeeded(self)
}

openExternal :: proc(self: ^Core, url: string) -> bool {
	url_z := dupe_cstring(self, url)
	defer delete(url_z, self.allocator)
	return self.symbols.openExternal(url_z)
}

openPath :: proc(self: ^Core, path: string) -> bool {
	path_z := dupe_cstring(self, path)
	defer delete(path_z, self.allocator)
	return self.symbols.openPath(path_z)
}

// Returns a comma-separated list of selected paths ("" when cancelled).
// The returned string is allocated with core.allocator; free with delete().
openFileDialog :: proc(self: ^Core, options: OpenFileDialogOptions) -> string {
	starting_folder_z := dupe_cstring(self, options.starting_folder)
	defer delete(starting_folder_z, self.allocator)
	allowed_file_types_z := dupe_cstring(self, options.allowed_file_types)
	defer delete(allowed_file_types_z, self.allocator)

	result := self.symbols.openFileDialog(
		starting_folder_z,
		allowed_file_types_z,
		c.int(1) if options.can_choose_files else c.int(0),
		c.int(1) if options.can_choose_directory else c.int(0),
		c.int(1) if options.allows_multiple_selection else c.int(0),
	)
	if result == nil {
		return clone_string("", self.allocator)
	}
	return clone_string(string(result), self.allocator)
}

showMessageBox :: proc(self: ^Core, options: MessageBoxOptions) -> (response: c.int, err: Error) {
	box_type_z := dupe_cstring(self, options.box_type)
	defer delete(box_type_z, self.allocator)
	title_z := dupe_cstring(self, options.title)
	defer delete(title_z, self.allocator)
	message_z := dupe_cstring(self, options.message)
	defer delete(message_z, self.allocator)
	detail_z := dupe_cstring(self, options.detail)
	defer delete(detail_z, self.allocator)
	buttons_joined := strings.join(options.buttons, ",", self.allocator)
	defer delete(buttons_joined, self.allocator)
	buttons_z := dupe_cstring(self, buttons_joined)
	defer delete(buttons_z, self.allocator)

	response = self.symbols.showMessageBox(
		box_type_z,
		title_z,
		message_z,
		detail_z,
		buttons_z,
		options.default_id,
		options.cancel_id,
	)
	ensure_last_call_succeeded(self) or_return
	return response, .None
}

showNotification :: proc(self: ^Core, options: NotificationOptions) -> Error {
	title_z := dupe_cstring(self, options.title)
	defer delete(title_z, self.allocator)
	body_z := dupe_cstring(self, options.body)
	defer delete(body_z, self.allocator)
	subtitle_z := dupe_cstring(self, options.subtitle)
	defer delete(subtitle_z, self.allocator)

	self.symbols.showNotification(title_z, body_z, subtitle_z, options.silent)
	return ensure_last_call_succeeded(self)
}

setGlobalShortcutCallback :: proc(self: ^Core, callback: GlobalShortcutHandler) -> Error {
	self.symbols.setGlobalShortcutCallback(callback)
	return ensure_last_call_succeeded(self)
}

registerGlobalShortcut :: proc(self: ^Core, accelerator: string) -> bool {
	accelerator_z := dupe_cstring(self, accelerator)
	defer delete(accelerator_z, self.allocator)
	return self.symbols.registerGlobalShortcut(accelerator_z)
}

unregisterGlobalShortcut :: proc(self: ^Core, accelerator: string) -> bool {
	accelerator_z := dupe_cstring(self, accelerator)
	defer delete(accelerator_z, self.allocator)
	return self.symbols.unregisterGlobalShortcut(accelerator_z)
}

unregisterAllGlobalShortcuts :: proc(self: ^Core) -> Error {
	self.symbols.unregisterAllGlobalShortcuts()
	return ensure_last_call_succeeded(self)
}

isGlobalShortcutRegistered :: proc(self: ^Core, accelerator: string) -> bool {
	accelerator_z := dupe_cstring(self, accelerator)
	defer delete(accelerator_z, self.allocator)
	return self.symbols.isGlobalShortcutRegistered(accelerator_z)
}

// Returns (text, true) when the clipboard has text. The returned string is
// allocated with core.allocator; free with delete().
clipboardReadText :: proc(self: ^Core) -> (text: string, has_text: bool) {
	value := self.symbols.clipboardReadText()
	if value == nil {
		return "", false
	}
	return clone_string(string(value), self.allocator), true
}

clipboardWriteText :: proc(self: ^Core, text: string) -> Error {
	text_z := dupe_cstring(self, text)
	defer delete(text_z, self.allocator)
	self.symbols.clipboardWriteText(text_z)
	return ensure_last_call_succeeded(self)
}

clipboardClear :: proc(self: ^Core) -> Error {
	self.symbols.clipboardClear()
	return ensure_last_call_succeeded(self)
}

// The returned string is allocated with core.allocator; free with delete().
clipboardAvailableFormatsCsv :: proc(self: ^Core) -> string {
	formats := self.symbols.clipboardAvailableFormats()
	if formats == nil {
		return clone_string("", self.allocator)
	}
	return clone_string(string(formats), self.allocator)
}

// The returned slice (and its strings) are allocated with core.allocator.
sessionGetCookies :: proc(self: ^Core, partition: string, filter_json: string) -> (cookies: []Cookie, err: Error) {
	partition_z := dupe_cstring(self, partition)
	defer delete(partition_z, self.allocator)
	filter_json_z := dupe_cstring(self, filter_json)
	defer delete(filter_json_z, self.allocator)

	json_text := self.symbols.sessionGetCookies(partition_z, filter_json_z)
	if json_text == nil {
		return make([]Cookie, 0, self.allocator), .None
	}
	return parse_cookies_json(self.allocator, string(json_text))
}

sessionSetCookie :: proc(self: ^Core, partition: string, cookie_json: string) -> bool {
	partition_z := dupe_cstring(self, partition)
	defer delete(partition_z, self.allocator)
	cookie_json_z := dupe_cstring(self, cookie_json)
	defer delete(cookie_json_z, self.allocator)
	return self.symbols.sessionSetCookie(partition_z, cookie_json_z)
}

sessionRemoveCookie :: proc(self: ^Core, partition: string, url: string, name: string) -> bool {
	partition_z := dupe_cstring(self, partition)
	defer delete(partition_z, self.allocator)
	url_z := dupe_cstring(self, url)
	defer delete(url_z, self.allocator)
	name_z := dupe_cstring(self, name)
	defer delete(name_z, self.allocator)
	return self.symbols.sessionRemoveCookie(partition_z, url_z, name_z)
}

sessionClearCookies :: proc(self: ^Core, partition: string) -> Error {
	partition_z := dupe_cstring(self, partition)
	defer delete(partition_z, self.allocator)
	self.symbols.sessionClearCookies(partition_z)
	return ensure_last_call_succeeded(self)
}

sessionClearStorageData :: proc(self: ^Core, partition: string, storage_types_json: string) -> Error {
	partition_z := dupe_cstring(self, partition)
	defer delete(partition_z, self.allocator)
	storage_types_json_z := dupe_cstring(self, storage_types_json)
	defer delete(storage_types_json_z, self.allocator)
	self.symbols.sessionClearStorageData(partition_z, storage_types_json_z)
	return ensure_last_call_succeeded(self)
}

setURLOpenHandler :: proc(self: ^Core, handler: URLOpenHandler) -> Error {
	self.symbols.setURLOpenHandler(handler)
	return ensure_last_call_succeeded(self)
}

setAppReopenHandler :: proc(self: ^Core, handler: AppReopenHandler) -> Error {
	self.symbols.setAppReopenHandler(handler)
	return ensure_last_call_succeeded(self)
}

setQuitRequestedHandler :: proc(self: ^Core, handler: QuitRequestedHandler) -> Error {
	self.symbols.setQuitRequestedHandler(handler)
	return ensure_last_call_succeeded(self)
}

stopEventLoop :: proc(self: ^Core) -> Error {
	self.symbols.stopEventLoop()
	return ensure_last_call_succeeded(self)
}

waitForShutdownComplete :: proc(self: ^Core, timeout_ms: c.int) -> Error {
	self.symbols.waitForShutdownComplete(timeout_ms)
	return ensure_last_call_succeeded(self)
}

forceExit :: proc(self: ^Core, code: c.int) -> ! {
	self.symbols.forceExit(code)
	os.exit(int(code))
}

quitGracefully :: proc(self: ^Core, code: c.int) -> ! {
	_ = stopEventLoop(self)
	_ = waitForShutdownComplete(self, 5000)
	forceExit(self, code)
}

wgpuCreateSurfaceForView :: proc(self: ^Core, instance_ptr: rawptr, view_ptr: rawptr) -> (surface_ptr: rawptr, err: Error) {
	surface_ptr = self.symbols.wgpuCreateSurfaceForView(instance_ptr, view_ptr)
	ensure_last_call_succeeded(self) or_return
	return surface_ptr, .None
}

wgpuCreateAdapterDeviceMainThread :: proc(
	self: ^Core,
	instance_ptr: rawptr,
	surface_ptr: rawptr,
	out_adapter_device: rawptr,
) -> Error {
	self.symbols.wgpuCreateAdapterDeviceMainThread(instance_ptr, surface_ptr, out_adapter_device)
	return ensure_last_call_succeeded(self)
}

wgpuSurfaceConfigureMainThread :: proc(self: ^Core, surface_ptr: rawptr, config_ptr: rawptr) -> Error {
	self.symbols.wgpuSurfaceConfigureMainThread(surface_ptr, config_ptr)
	return ensure_last_call_succeeded(self)
}

wgpuSurfaceGetCurrentTextureMainThread :: proc(self: ^Core, surface_ptr: rawptr, surface_texture_ptr: rawptr) -> Error {
	self.symbols.wgpuSurfaceGetCurrentTextureMainThread(surface_ptr, surface_texture_ptr)
	return ensure_last_call_succeeded(self)
}

wgpuSurfacePresentMainThread :: proc(self: ^Core, surface_ptr: rawptr) -> (result: i32, err: Error) {
	result = self.symbols.wgpuSurfacePresentMainThread(surface_ptr)
	ensure_last_call_succeeded(self) or_return
	return result, .None
}

// Blocks running the native event loop until the app quits.
runMainThread :: proc(self: ^Core, app_info: AppInfo) -> Error {
	identifier_z := dupe_cstring(self, app_info.identifier)
	defer delete(identifier_z, self.allocator)
	name_z := dupe_cstring(self, app_info.name)
	defer delete(name_z, self.allocator)
	channel_z := dupe_cstring(self, app_info.channel)
	defer delete(channel_z, self.allocator)

	status := self.symbols.electrobun_core_run_main_thread(identifier_z, name_z, channel_z, 0)
	if status != 0 {
		return error_from_last_error(last_error_string(self))
	}
	return .None
}

// ---------------------------------------------------------------------------
// Convenience callbacks / process helpers
// ---------------------------------------------------------------------------

quit :: proc(code: int) -> ! {
	os.exit(code)
}

allowAllNavigation :: proc "c" (_: u32, _: cstring) -> u32 {
	return 1
}

noopWebviewEvent :: proc "c" (_: u32, _: cstring, _: cstring) {
}

noopWebviewPostMessage :: proc "c" (_: u32, _: cstring) {
}

// ---------------------------------------------------------------------------
// Overload groups / aliases mirroring the zig SDK's method names
// ---------------------------------------------------------------------------

// zig: Core.load
load :: coreLoad
// zig: Core.close / WgpuNative.close / BrowserWindowRef.close
close :: proc {
	coreClose,
	wgpuNativeClose,
	windowClose,
}
// zig: Core.setWindowButtonPosition / BrowserWindowRef.setWindowButtonPosition
setWindowButtonPosition :: proc {
	coreSetWindowButtonPosition,
	windowSetWindowButtonPosition,
}
// zig: OwnedAppInfo.deinit / Paths.deinit / WindowRegistry.deinit / BundlePaths.deinit
deinit :: proc {
	ownedAppInfoDeinit,
	pathsDeinit,
	windowRegistryDeinit,
	bundlePathsDeinit,
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

@(private = "file")
clone_string :: proc(value: string, allocator: runtime.Allocator) -> string {
	result, _ := strings.clone(value, allocator)
	return result
}

@(private = "file")
join_path :: proc(allocator: runtime.Allocator, parts: []string) -> string {
	result, _ := filepath.join(parts, allocator)
	return result
}

@(private = "file")
dupe_cstring :: proc(self: ^Core, value: string) -> cstring {
	result, _ := strings.clone_to_cstring(value, self.allocator)
	return result
}

@(private = "file")
last_error_string :: proc(self: ^Core) -> string {
	return string(self.symbols.electrobun_core_last_error())
}

@(private = "file")
ensure_last_call_succeeded :: proc(self: ^Core) -> Error {
	message := last_error_string(self)
	if len(message) != 0 {
		return error_from_last_error(message)
	}
	return .None
}

@(private = "file")
error_from_last_error :: proc(message: string) -> Error {
	if len(message) != 0 {
		fmt.eprintf("[electrobun-odin] core error: %s\n", message)
	}
	return .ElectrobunCoreFailure
}

@(private = "file")
missing_symbol_name :: proc(table: ^$T) -> (name: string, missing: bool) {
	for field in reflect.struct_fields_zipped(T) {
		if field.name == "__handle" || !reflect.is_procedure(field.type) {
			continue
		}
		field_ptr := rawptr(uintptr(table) + field.offset)
		if (^rawptr)(field_ptr)^ == nil {
			return field.name, true
		}
	}
	return "", false
}

@(private = "file")
read_file_cstring :: proc(self: ^Core, path: string) -> (result: cstring, err: Error) {
	data, read_err := os.read_entire_file(path, self.allocator)
	if read_err != nil {
		return nil, .FileReadFailed
	}
	defer delete(data, self.allocator)
	result, _ = strings.clone_to_cstring(string(data), self.allocator)
	return result, .None
}

// --- JSON helpers ----------------------------------------------------------

@(private = "file")
write_json_string :: proc(b: ^strings.Builder, value: string) {
	data, err := json.marshal(value, {}, context.temp_allocator)
	if err == nil {
		strings.write_string(b, string(data))
	} else {
		strings.write_string(b, "\"\"")
	}
}

@(private = "file")
write_opt_string_value :: proc(b: ^strings.Builder, value: Maybe(string)) {
	if v, ok := value.?; ok {
		write_json_string(b, v)
	} else {
		strings.write_string(b, "null")
	}
}

@(private = "file")
write_opt_bool_value :: proc(b: ^strings.Builder, value: Maybe(bool)) {
	if v, ok := value.?; ok {
		strings.write_string(b, "true" if v else "false")
	} else {
		strings.write_string(b, "null")
	}
}

@(private = "file")
write_opt_f64_value :: proc(b: ^strings.Builder, value: Maybe(f64)) {
	if v, ok := value.?; ok {
		strings.write_f64(b, v, 'g')
	} else {
		strings.write_string(b, "null")
	}
}

// Emits every field, using null for unset optionals (mirrors zig's
// std.json.stringify of the Cookie struct).
@(private = "file")
marshal_cookie :: proc(allocator: runtime.Allocator, cookie: Cookie) -> string {
	b := strings.builder_make(allocator)
	strings.write_string(&b, "{\"name\":")
	write_json_string(&b, cookie.name)
	strings.write_string(&b, ",\"value\":")
	write_json_string(&b, cookie.value)
	strings.write_string(&b, ",\"domain\":")
	write_opt_string_value(&b, cookie.domain)
	strings.write_string(&b, ",\"path\":")
	write_opt_string_value(&b, cookie.path)
	strings.write_string(&b, ",\"secure\":")
	write_opt_bool_value(&b, cookie.secure)
	strings.write_string(&b, ",\"httpOnly\":")
	write_opt_bool_value(&b, cookie.httpOnly)
	strings.write_string(&b, ",\"sameSite\":")
	write_opt_string_value(&b, cookie.sameSite)
	strings.write_string(&b, ",\"expirationDate\":")
	write_opt_f64_value(&b, cookie.expirationDate)
	strings.write_string(&b, "}")
	return strings.to_string(b)
}

@(private = "file")
marshal_cookie_filter :: proc(allocator: runtime.Allocator, filter: CookieFilter) -> string {
	b := strings.builder_make(allocator)
	strings.write_string(&b, "{\"url\":")
	write_opt_string_value(&b, filter.url)
	strings.write_string(&b, ",\"name\":")
	write_opt_string_value(&b, filter.name)
	strings.write_string(&b, ",\"domain\":")
	write_opt_string_value(&b, filter.domain)
	strings.write_string(&b, ",\"path\":")
	write_opt_string_value(&b, filter.path)
	strings.write_string(&b, ",\"secure\":")
	write_opt_bool_value(&b, filter.secure)
	strings.write_string(&b, ",\"session\":")
	write_opt_bool_value(&b, filter.session)
	strings.write_string(&b, "}")
	return strings.to_string(b)
}

@(private = "file")
number_from_value :: proc(value: json.Value) -> (result: f64, ok: bool) {
	#partial switch v in value {
	case json.Float:
		return f64(v), true
	case json.Integer:
		return f64(v), true
	}
	return 0, false
}

@(private = "file")
object_string :: proc(obj: json.Object, key: string) -> (result: string, ok: bool) {
	value, found := obj[key]
	if !found {
		return "", false
	}
	s, is_string := value.(json.String)
	if !is_string {
		return "", false
	}
	return s, true
}

@(private = "file")
object_number :: proc(obj: json.Object, key: string) -> (result: f64, ok: bool) {
	value, found := obj[key]
	if !found {
		return 0, false
	}
	return number_from_value(value)
}

@(private = "file")
object_bool :: proc(obj: json.Object, key: string) -> (result: bool, ok: bool) {
	value, found := obj[key]
	if !found {
		return false, false
	}
	v, is_bool := value.(json.Boolean)
	if !is_bool {
		return false, false
	}
	return v, true
}

@(private = "file")
rect_from_value :: proc(value: json.Value) -> (rect: Rect, ok: bool) {
	obj, is_object := value.(json.Object)
	if !is_object {
		return {}, false
	}
	x, x_ok := object_number(obj, "x")
	y, y_ok := object_number(obj, "y")
	width, width_ok := object_number(obj, "width")
	height, height_ok := object_number(obj, "height")
	if !x_ok || !y_ok || !width_ok || !height_ok {
		return {}, false
	}
	return Rect{x = x, y = y, width = width, height = height}, true
}

@(private = "file")
parse_rect_json :: proc(allocator: runtime.Allocator, text: string) -> (rect: Rect, err: Error) {
	value, parse_err := json.parse_string(text, json.DEFAULT_SPECIFICATION, true, allocator)
	if parse_err != .None {
		return {}, .InvalidRectJson
	}
	defer json.destroy_value(value, allocator)

	result, ok := rect_from_value(value)
	if !ok {
		return {}, .InvalidRectJson
	}
	return result, .None
}

@(private = "file")
display_from_value :: proc(value: json.Value) -> (display: Display, ok: bool) {
	obj, is_object := value.(json.Object)
	if !is_object {
		return {}, false
	}
	id, id_ok := object_number(obj, "id")
	if !id_ok {
		return {}, false
	}
	bounds, bounds_ok := rect_from_value(obj["bounds"])
	work_area, work_area_ok := rect_from_value(obj["workArea"])
	if !bounds_ok || !work_area_ok {
		return {}, false
	}
	scale_factor, _ := object_number(obj, "scaleFactor")
	is_primary, _ := object_bool(obj, "isPrimary")
	return Display{
			id = i64(id),
			bounds = bounds,
			workArea = work_area,
			scaleFactor = scale_factor,
			isPrimary = is_primary,
		},
		true
}

@(private = "file")
parse_display_json :: proc(allocator: runtime.Allocator, text: string) -> (display: Display, err: Error) {
	value, parse_err := json.parse_string(text, json.DEFAULT_SPECIFICATION, true, allocator)
	if parse_err != .None {
		return {}, .InvalidJson
	}
	defer json.destroy_value(value, allocator)

	result, ok := display_from_value(value)
	if !ok {
		return {}, .InvalidJson
	}
	return result, .None
}

@(private = "file")
parse_displays_json :: proc(allocator: runtime.Allocator, text: string) -> (displays: []Display, err: Error) {
	value, parse_err := json.parse_string(text, json.DEFAULT_SPECIFICATION, true, allocator)
	if parse_err != .None {
		return nil, .InvalidJson
	}
	defer json.destroy_value(value, allocator)

	arr, is_array := value.(json.Array)
	if !is_array {
		return nil, .InvalidJson
	}

	result := make([]Display, len(arr), allocator)
	for item, index in arr {
		display, ok := display_from_value(item)
		if !ok {
			delete(result, allocator)
			return nil, .InvalidJson
		}
		result[index] = display
	}
	return result, .None
}

@(private = "file")
parse_point_json :: proc(allocator: runtime.Allocator, text: string) -> (point: Point, err: Error) {
	value, parse_err := json.parse_string(text, json.DEFAULT_SPECIFICATION, true, allocator)
	if parse_err != .None {
		return {}, .InvalidJson
	}
	defer json.destroy_value(value, allocator)

	obj, is_object := value.(json.Object)
	if !is_object {
		return {}, .InvalidJson
	}
	x, x_ok := object_number(obj, "x")
	y, y_ok := object_number(obj, "y")
	if !x_ok || !y_ok {
		return {}, .InvalidJson
	}
	return Point{x = x, y = y}, .None
}

@(private = "file")
cookie_from_object :: proc(allocator: runtime.Allocator, obj: json.Object) -> (cookie: Cookie) {
	if name, ok := object_string(obj, "name"); ok {
		cookie.name = clone_string(name, allocator)
	}
	if value, ok := object_string(obj, "value"); ok {
		cookie.value = clone_string(value, allocator)
	}
	if domain, ok := object_string(obj, "domain"); ok {
		cookie.domain = clone_string(domain, allocator)
	}
	if path, ok := object_string(obj, "path"); ok {
		cookie.path = clone_string(path, allocator)
	}
	if secure, ok := object_bool(obj, "secure"); ok {
		cookie.secure = secure
	}
	if http_only, ok := object_bool(obj, "httpOnly"); ok {
		cookie.httpOnly = http_only
	}
	if same_site, ok := object_string(obj, "sameSite"); ok {
		cookie.sameSite = clone_string(same_site, allocator)
	}
	if expiration_date, ok := object_number(obj, "expirationDate"); ok {
		cookie.expirationDate = expiration_date
	}
	return cookie
}

@(private = "file")
parse_cookies_json :: proc(allocator: runtime.Allocator, text: string) -> (cookies: []Cookie, err: Error) {
	value, parse_err := json.parse_string(text, json.DEFAULT_SPECIFICATION, true, allocator)
	if parse_err != .None {
		return nil, .InvalidJson
	}
	defer json.destroy_value(value, allocator)

	arr, is_array := value.(json.Array)
	if !is_array {
		return nil, .InvalidJson
	}

	result := make([]Cookie, len(arr), allocator)
	for item, index in arr {
		obj, is_object := item.(json.Object)
		if !is_object {
			continue
		}
		result[index] = cookie_from_object(allocator, obj)
	}
	return result, .None
}

// --- Paths helpers ---------------------------------------------------------

@(private = "file")
get_home_dir :: proc(allocator: runtime.Allocator) -> (home: string, err: Error) {
	when ODIN_OS == .Windows {
		if value, found := os.lookup_env("USERPROFILE", allocator); found {
			return value, .None
		}
	}
	if value, found := os.lookup_env("HOME", allocator); found {
		return value, .None
	}
	return "", .EnvVarNotFound
}

@(private = "file")
env_or_join :: proc(allocator: runtime.Allocator, env_name: string, fallback_parts: []string) -> string {
	if value, found := os.lookup_env(env_name, allocator); found {
		return value
	}
	return join_path(allocator, fallback_parts)
}

@(private = "file")
get_app_data_dir :: proc(allocator: runtime.Allocator, home: string) -> string {
	when ODIN_OS == .Darwin {
		return join_path(allocator, {home, "Library", "Application Support"})
	} else when ODIN_OS == .Windows {
		return env_or_join(allocator, "LOCALAPPDATA", {home, "AppData", "Local"})
	} else {
		return env_or_join(allocator, "XDG_DATA_HOME", {home, ".local", "share"})
	}
}

@(private = "file")
get_cache_dir :: proc(allocator: runtime.Allocator, home: string) -> string {
	when ODIN_OS == .Darwin {
		return join_path(allocator, {home, "Library", "Caches"})
	} else when ODIN_OS == .Windows {
		return env_or_join(allocator, "LOCALAPPDATA", {home, "AppData", "Local"})
	} else {
		return env_or_join(allocator, "XDG_CACHE_HOME", {home, ".cache"})
	}
}

@(private = "file")
get_logs_dir :: proc(allocator: runtime.Allocator, home: string) -> string {
	when ODIN_OS == .Darwin {
		return join_path(allocator, {home, "Library", "Logs"})
	} else when ODIN_OS == .Windows {
		return env_or_join(allocator, "LOCALAPPDATA", {home, "AppData", "Local"})
	} else {
		return env_or_join(allocator, "XDG_STATE_HOME", {home, ".local", "state"})
	}
}

@(private = "file")
get_config_dir :: proc(allocator: runtime.Allocator, home: string) -> string {
	when ODIN_OS == .Darwin {
		return join_path(allocator, {home, "Library", "Application Support"})
	} else when ODIN_OS == .Windows {
		return env_or_join(allocator, "APPDATA", {home, "AppData", "Roaming"})
	} else {
		return env_or_join(allocator, "XDG_CONFIG_HOME", {home, ".config"})
	}
}

@(private = "file")
get_temp_dir :: proc(allocator: runtime.Allocator, home: string) -> string {
	when ODIN_OS == .Windows {
		if value, found := os.lookup_env("TEMP", allocator); found {
			return value
		}
		if value, found := os.lookup_env("TMP", allocator); found {
			return value
		}
		return join_path(allocator, {home, "AppData", "Local", "Temp"})
	} else {
		if value, found := os.lookup_env("TMPDIR", allocator); found {
			return value
		}
		return clone_string("/tmp", allocator)
	}
}

@(private = "file")
get_user_dir :: proc(
	allocator: runtime.Allocator,
	home: string,
	mac_name: string,
	win_name: string,
	xdg_key: string,
	fallback_name: string,
) -> string {
	when ODIN_OS == .Darwin {
		return join_path(allocator, {home, mac_name})
	} else when ODIN_OS == .Windows {
		return join_path(allocator, {home, win_name})
	} else {
		return linux_xdg_user_dir(allocator, home, xdg_key, fallback_name)
	}
}

@(private = "file")
linux_xdg_user_dir :: proc(
	allocator: runtime.Allocator,
	home: string,
	key: string,
	fallback_name: string,
) -> string {
	config_path := join_path(allocator, {home, ".config", "user-dirs.dirs"})
	defer delete(config_path, allocator)

	fallback := join_path(allocator, {home, fallback_name})

	content, read_err := os.read_entire_file(config_path, allocator)
	if read_err != nil {
		return fallback
	}
	defer delete(content, allocator)

	iterator := string(content)
	for line in strings.split_lines_iterator(&iterator) {
		trimmed := strings.trim(line, " \t\r")
		if len(trimmed) == 0 || trimmed[0] == '#' {
			continue
		}

		eq_index := strings.index_byte(trimmed, '=')
		if eq_index < 0 {
			continue
		}
		line_key := trimmed[:eq_index]
		if line_key != key {
			continue
		}

		value := strings.trim(trimmed[eq_index + 1:], " \t\r")
		if len(value) >= 2 && value[0] == '"' && value[len(value) - 1] == '"' {
			value = value[1:len(value) - 1]
		}

		replaced, was_allocation := strings.replace_all(value, "$HOME", home, allocator)
		if !was_allocation {
			replaced = clone_string(replaced, allocator)
		}
		delete(fallback, allocator)
		return replaced
	}

	return fallback
}

@(private = "file")
build_app_scoped_dir :: proc(allocator: runtime.Allocator, base: string, app_info: AppInfo) -> string {
	if len(app_info.identifier) == 0 || len(app_info.channel) == 0 {
		return clone_string(base, allocator)
	}
	return join_path(allocator, {base, app_info.identifier, app_info.channel})
}
