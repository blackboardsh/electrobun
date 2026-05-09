const std = @import("std");
const builtin = @import("builtin");

pub const WindowCloseHandler = *const fn (u32) callconv(.C) void;
pub const WindowMoveHandler = *const fn (u32, f64, f64) callconv(.C) void;
pub const WindowResizeHandler = *const fn (u32, f64, f64, f64, f64) callconv(.C) void;
pub const WindowFocusHandler = *const fn (u32) callconv(.C) void;
pub const WindowBlurHandler = *const fn (u32) callconv(.C) void;
pub const WindowKeyHandler = *const fn (u32, u32, u32, u32, u32) callconv(.C) void;
pub const DecideNavigationHandler = *const fn (u32, [*:0]const u8) callconv(.C) u32;
pub const WebviewEventHandler = *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) void;
pub const WebviewPostMessageHandler = *const fn (u32, [*:0]const u8) callconv(.C) u32;
pub const StatusItemHandler = *const fn (u32, [*:0]const u8) callconv(.C) void;
pub const GlobalShortcutHandler = *const fn ([*:0]const u8) callconv(.C) void;
pub const QuitRequestedHandler = *const fn () callconv(.C) void;
pub const URLOpenHandler = *const fn ([*:0]const u8) callconv(.C) void;
pub const AppReopenHandler = *const fn () callconv(.C) void;

pub const Renderer = enum {
    native,
    cef,
};

pub const AppInfo = struct {
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
};

pub const OwnedAppInfo = struct {
    identifier: []u8,
    name: []u8,
    channel: []u8,

    pub fn deinit(self: *const OwnedAppInfo, allocator: std.mem.Allocator) void {
        allocator.free(self.identifier);
        allocator.free(self.name);
        allocator.free(self.channel);
    }

    pub fn borrowed(self: *const OwnedAppInfo) AppInfo {
        return .{
            .identifier = self.identifier,
            .name = self.name,
            .channel = self.channel,
        };
    }
};

pub const Rect = struct {
    x: f64 = 0,
    y: f64 = 0,
    width: f64 = 800,
    height: f64 = 600,
};

pub const TrafficLightOffset = struct {
    x: f64 = 0,
    y: f64 = 0,
};

pub const WindowStyle = struct {
    borderless: bool = false,
    titled: bool = true,
    closable: bool = true,
    miniaturizable: bool = true,
    resizable: bool = true,
    unified_title_and_toolbar: bool = false,
    full_screen: bool = false,
    full_size_content_view: bool = false,
    utility_window: bool = false,
    doc_modal_window: bool = false,
    nonactivating_panel: bool = false,
    hud_window: bool = false,
};

pub const WindowCallbacks = struct {
    close: ?WindowCloseHandler = null,
    move: ?WindowMoveHandler = null,
    resize: ?WindowResizeHandler = null,
    focus: ?WindowFocusHandler = null,
    blur: ?WindowBlurHandler = null,
    key: ?WindowKeyHandler = null,
};

pub const WindowOptions = struct {
    title: []const u8,
    frame: Rect,
    style: WindowStyle = .{},
    title_bar_style: []const u8 = "default",
    transparent: bool = false,
    hidden: bool = false,
    activate: bool = true,
    traffic_light_offset: TrafficLightOffset = .{},
    callbacks: WindowCallbacks = .{},
};

pub const WebviewCallbacks = struct {
    decide_navigation: ?DecideNavigationHandler = null,
    event: ?WebviewEventHandler = null,
    event_bridge: ?WebviewPostMessageHandler = null,
    bun_bridge: ?WebviewPostMessageHandler = null,
    internal_bridge: ?WebviewPostMessageHandler = null,
};

pub const WebviewOptions = struct {
    window_id: u32,
    host_webview_id: u32 = 0,
    renderer: Renderer = .native,
    url: []const u8 = "",
    frame: Rect = .{},
    auto_resize: bool = true,
    partition: []const u8 = "persist:default",
    callbacks: WebviewCallbacks = .{},
    secret_key: []const u8 = "",
    preload: []const u8 = "",
    views_root: []const u8 = "",
    sandbox: bool = true,
    start_transparent: bool = false,
    start_passthrough: bool = false,
};

pub const WGPUViewOptions = struct {
    window_id: u32,
    frame: Rect = .{},
    auto_resize: bool = true,
    start_transparent: bool = false,
    start_passthrough: bool = false,
};

pub const TrayOptions = struct {
    title: []const u8 = "",
    image: []const u8,
    is_template: bool = false,
    width: u32 = 18,
    height: u32 = 18,
};

pub const Display = struct {
    id: i64,
    bounds: Rect,
    workArea: Rect,
    scaleFactor: f64,
    isPrimary: bool,
};

pub const Point = struct {
    x: f64,
    y: f64,
};

pub const NotificationOptions = struct {
    title: []const u8,
    body: []const u8 = "",
    subtitle: []const u8 = "",
    silent: bool = false,
};

pub const Cookie = struct {
    name: []const u8,
    value: []const u8,
    domain: ?[]const u8 = null,
    path: ?[]const u8 = null,
    secure: ?bool = null,
    httpOnly: ?bool = null,
    sameSite: ?[]const u8 = null,
    expirationDate: ?f64 = null,
};

pub const CookieFilter = struct {
    url: ?[]const u8 = null,
    name: ?[]const u8 = null,
    domain: ?[]const u8 = null,
    path: ?[]const u8 = null,
    secure: ?bool = null,
    session: ?bool = null,
};

pub const StorageType = enum {
    cookies,
    localStorage,
    sessionStorage,
    indexedDB,
    webSQL,
    cache,
    all,
};

pub const OpenFileDialogOptions = struct {
    starting_folder: []const u8 = "~/",
    allowed_file_types: []const u8 = "*",
    can_choose_files: bool = true,
    can_choose_directory: bool = true,
    allows_multiple_selection: bool = true,
};

pub const MessageBoxOptions = struct {
    box_type: []const u8 = "info",
    title: []const u8 = "",
    message: []const u8 = "",
    detail: []const u8 = "",
    buttons: []const []const u8 = &.{ "OK" },
    default_id: c_int = 0,
    cancel_id: c_int = -1,
};

pub const Paths = struct {
    home: []u8,
    appData: []u8,
    config: []u8,
    cache: []u8,
    temp: []u8,
    logs: []u8,
    documents: []u8,
    downloads: []u8,
    desktop: []u8,
    pictures: []u8,
    music: []u8,
    videos: []u8,
    userData: []u8,
    userCache: []u8,
    userLogs: []u8,

    pub fn deinit(self: *const Paths, allocator: std.mem.Allocator) void {
        allocator.free(self.home);
        allocator.free(self.appData);
        allocator.free(self.config);
        allocator.free(self.cache);
        allocator.free(self.temp);
        allocator.free(self.logs);
        allocator.free(self.documents);
        allocator.free(self.downloads);
        allocator.free(self.desktop);
        allocator.free(self.pictures);
        allocator.free(self.music);
        allocator.free(self.videos);
        allocator.free(self.userData);
        allocator.free(self.userCache);
        allocator.free(self.userLogs);
    }

    pub fn resolve(allocator: std.mem.Allocator, app_info: AppInfo) !Paths {
        const home = try getHomeDirOwned(allocator);
        errdefer allocator.free(home);

        const app_data = try getAppDataDirOwned(allocator, home);
        errdefer allocator.free(app_data);
        const config = try getConfigDirOwned(allocator, home);
        errdefer allocator.free(config);
        const cache = try getCacheDirOwned(allocator, home);
        errdefer allocator.free(cache);
        const temp = try getTempDirOwned(allocator, home);
        errdefer allocator.free(temp);
        const logs = try getLogsDirOwned(allocator, home);
        errdefer allocator.free(logs);

        const documents = try getUserDirOwned(allocator, home, "Documents", "Documents", "XDG_DOCUMENTS_DIR", "Documents");
        errdefer allocator.free(documents);
        const downloads = try getUserDirOwned(allocator, home, "Downloads", "Downloads", "XDG_DOWNLOAD_DIR", "Downloads");
        errdefer allocator.free(downloads);
        const desktop = try getUserDirOwned(allocator, home, "Desktop", "Desktop", "XDG_DESKTOP_DIR", "Desktop");
        errdefer allocator.free(desktop);
        const pictures = try getUserDirOwned(allocator, home, "Pictures", "Pictures", "XDG_PICTURES_DIR", "Pictures");
        errdefer allocator.free(pictures);
        const music = try getUserDirOwned(allocator, home, "Music", "Music", "XDG_MUSIC_DIR", "Music");
        errdefer allocator.free(music);
        const videos = try getUserDirOwned(allocator, home, "Movies", "Videos", "XDG_VIDEOS_DIR", "Videos");
        errdefer allocator.free(videos);

        const user_data = try buildAppScopedDir(allocator, app_data, app_info);
        errdefer allocator.free(user_data);
        const user_cache = try buildAppScopedDir(allocator, cache, app_info);
        errdefer allocator.free(user_cache);
        const user_logs = try buildAppScopedDir(allocator, logs, app_info);
        errdefer allocator.free(user_logs);

        return .{
            .home = home,
            .appData = app_data,
            .config = config,
            .cache = cache,
            .temp = temp,
            .logs = logs,
            .documents = documents,
            .downloads = downloads,
            .desktop = desktop,
            .pictures = pictures,
            .music = music,
            .videos = videos,
            .userData = user_data,
            .userCache = user_cache,
            .userLogs = user_logs,
        };
    }
};

pub const BrowserWindowRef = struct {
    registry: *WindowRegistry,
    id: u32,

    pub fn close(self: BrowserWindowRef) !void {
        try self.registry.core.closeWindow(self.id);
        _ = self.registry.ids.remove(self.id);
    }

    pub fn getFrame(self: BrowserWindowRef) !Rect {
        return try self.registry.core.getWindowFrame(self.id);
    }

    pub fn setWindowButtonPosition(self: BrowserWindowRef, x: f64, y: f64) !void {
        try self.registry.core.setWindowButtonPosition(self.id, x, y);
    }
};

pub const SessionPartition = struct {
    core: *Core,
    partition: []const u8,

    pub fn getCookies(self: SessionPartition, filter: ?CookieFilter) ![]Cookie {
        const filter_json = try std.json.stringifyAlloc(self.core.allocator, filter orelse CookieFilter{}, .{});
        defer self.core.allocator.free(filter_json);
        return self.core.sessionGetCookies(self.partition, filter_json);
    }

    pub fn setCookie(self: SessionPartition, cookie: Cookie) !bool {
        const cookie_json = try std.json.stringifyAlloc(self.core.allocator, cookie, .{});
        defer self.core.allocator.free(cookie_json);
        return self.core.sessionSetCookie(self.partition, cookie_json);
    }

    pub fn removeCookie(self: SessionPartition, url: []const u8, name: []const u8) !bool {
        return self.core.sessionRemoveCookie(self.partition, url, name);
    }

    pub fn clearCookies(self: SessionPartition) !void {
        try self.core.sessionClearCookies(self.partition);
    }

    pub fn clearStorageData(self: SessionPartition, storage_types: []const StorageType) !void {
        if (storage_types.len == 0) {
            try self.core.sessionClearStorageData(self.partition, "[\"all\"]");
            return;
        }

        const names = try self.core.allocator.alloc([]const u8, storage_types.len);
        defer self.core.allocator.free(names);
        for (storage_types, 0..) |storage_type, index| {
            names[index] = @tagName(storage_type);
        }

        const storage_types_json = try std.json.stringifyAlloc(self.core.allocator, names, .{});
        defer self.core.allocator.free(storage_types_json);
        try self.core.sessionClearStorageData(self.partition, storage_types_json);
    }
};

pub const Session = struct {
    pub fn fromPartition(core: *Core, partition: []const u8) SessionPartition {
        return .{
            .core = core,
            .partition = partition,
        };
    }

    pub fn defaultSession(core: *Core) SessionPartition {
        return fromPartition(core, "persist:default");
    }
};

pub const WgpuAdapterDevice = struct {
    adapter: ?*anyopaque,
    device: ?*anyopaque,
};

pub const WgpuNative = struct {
    lib: std.DynLib,
    symbols: Symbols,

    const CreateInstanceFn = *const fn (?*const anyopaque) callconv(.C) ?*anyopaque;
    const DeviceGetQueueFn = *const fn (?*anyopaque) callconv(.C) ?*anyopaque;

    const Symbols = struct {
        create_instance: CreateInstanceFn,
        device_get_queue: DeviceGetQueueFn,
    };

    pub fn load(allocator: std.mem.Allocator) !WgpuNative {
        const bundle_paths = try resolveBundlePaths(allocator);
        defer bundle_paths.deinit(allocator);

        const lib_name = switch (builtin.os.tag) {
            .windows => "webgpu_dawn.dll",
            .macos => "libwebgpu_dawn.dylib",
            else => "libwebgpu_dawn.so",
        };
        const lib_path = try std.fs.path.join(allocator, &.{ bundle_paths.exe_dir, lib_name });
        defer allocator.free(lib_path);

        var lib = try std.DynLib.open(lib_path);
        return .{
            .lib = lib,
            .symbols = .{
                .create_instance = lib.lookup(CreateInstanceFn, "wgpuCreateInstance") orelse return error.MissingCoreSymbol,
                .device_get_queue = lib.lookup(DeviceGetQueueFn, "wgpuDeviceGetQueue") orelse return error.MissingCoreSymbol,
            },
        };
    }

    pub fn close(self: *WgpuNative) void {
        self.lib.close();
    }

    pub fn createInstance(self: *WgpuNative) ?*anyopaque {
        return self.symbols.create_instance(null);
    }

    pub fn deviceGetQueue(self: *WgpuNative, device: ?*anyopaque) ?*anyopaque {
        return self.symbols.device_get_queue(device);
    }
};

pub const WgpuContext = struct {
    view_ptr: ?*anyopaque,
    instance_ptr: ?*anyopaque,
    surface_ptr: ?*anyopaque,
    adapter_ptr: ?*anyopaque,
    device_ptr: ?*anyopaque,

    pub fn createForView(core: *Core, native: *WgpuNative, view_ptr: ?*anyopaque) !WgpuContext {
        const instance_ptr = native.createInstance() orelse return error.ElectrobunCoreFailure;
        const surface_ptr = try core.wgpuCreateSurfaceForView(instance_ptr, view_ptr);

        var adapter_device = [2]usize{ 0, 0 };
        try core.wgpuCreateAdapterDeviceMainThread(
            instance_ptr,
            surface_ptr,
            @ptrCast(&adapter_device),
        );

        const adapter_ptr: ?*anyopaque = @ptrFromInt(adapter_device[0]);
        const device_ptr: ?*anyopaque = @ptrFromInt(adapter_device[1]);
        if (device_ptr == null) {
            return error.ElectrobunCoreFailure;
        }

        return .{
            .view_ptr = view_ptr,
            .instance_ptr = instance_ptr,
            .surface_ptr = surface_ptr,
            .adapter_ptr = adapter_ptr,
            .device_ptr = device_ptr,
        };
    }

    pub fn createForWgpuView(core: *Core, native: *WgpuNative, wgpu_view_id: u32) !WgpuContext {
        const view_ptr = try core.getWGPUViewPointer(wgpu_view_id);
        return createForView(core, native, view_ptr);
    }

    pub fn getQueue(self: WgpuContext, native: *WgpuNative) ?*anyopaque {
        return native.deviceGetQueue(self.device_ptr);
    }
};

pub const WindowRegistry = struct {
    allocator: std.mem.Allocator,
    core: *Core,
    ids: std.AutoHashMap(u32, void),

    pub fn init(allocator: std.mem.Allocator, core: *Core) WindowRegistry {
        return .{
            .allocator = allocator,
            .core = core,
            .ids = std.AutoHashMap(u32, void).init(allocator),
        };
    }

    pub fn deinit(self: *WindowRegistry) void {
        self.ids.deinit();
    }

    pub fn createBrowserWindow(self: *WindowRegistry, options: WindowOptions) !BrowserWindowRef {
        const id = try self.core.createWindow(options);
        try self.ids.put(id, {});
        return .{
            .registry = self,
            .id = id,
        };
    }

    pub fn getById(self: *WindowRegistry, id: u32) ?BrowserWindowRef {
        if (!self.ids.contains(id)) {
            return null;
        }
        return .{
            .registry = self,
            .id = id,
        };
    }
};

pub const BundlePaths = struct {
    exe_dir: []u8,
    resources_dir: []u8,

    pub fn deinit(self: *const BundlePaths, allocator: std.mem.Allocator) void {
        allocator.free(self.exe_dir);
        allocator.free(self.resources_dir);
    }
};

pub fn resolveBundlePaths(allocator: std.mem.Allocator) !BundlePaths {
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);

    const exe_dir_name = std.fs.path.dirname(exe_path) orelse return error.InvalidExePath;
    const exe_dir = try allocator.dupe(u8, exe_dir_name);
    const resources_dir = try std.fs.path.join(allocator, &.{ exe_dir_name, "..", "Resources" });

    return .{
        .exe_dir = exe_dir,
        .resources_dir = resources_dir,
    };
}

pub fn resolveAppInfoFromBundle(allocator: std.mem.Allocator, bundle_paths: *const BundlePaths) !OwnedAppInfo {
    const version_json_path = try std.fs.path.join(allocator, &.{ bundle_paths.resources_dir, "version.json" });
    defer allocator.free(version_json_path);

    const version_json = try readFileAlloc(allocator, version_json_path);
    defer allocator.free(version_json);

    const ParsedAppInfo = struct {
        identifier: []const u8,
        name: []const u8,
        channel: []const u8,
    };

    var parsed = try std.json.parseFromSlice(ParsedAppInfo, allocator, version_json, .{
        .ignore_unknown_fields = true,
    });
    defer parsed.deinit();

    return .{
        .identifier = try allocator.dupe(u8, parsed.value.identifier),
        .name = try allocator.dupe(u8, parsed.value.name),
        .channel = try allocator.dupe(u8, parsed.value.channel),
    };
}

pub const Core = struct {
    allocator: std.mem.Allocator,
    lib: std.DynLib,
    symbols: Symbols,

    const LastErrorFn = *const fn () callconv(.C) [*:0]const u8;
    const RunMainThreadFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, c_int) callconv(.C) c_int;
    const ConfigureWebviewRuntimeFn = *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) bool;
    const GetWindowStyleFn = *const fn (bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool) callconv(.C) u32;
    const CreateWindowFn = *const fn (f64, f64, f64, f64, u32, [*:0]const u8, bool, [*:0]const u8, bool, bool, f64, f64, ?WindowCloseHandler, ?WindowMoveHandler, ?WindowResizeHandler, ?WindowFocusHandler, ?WindowBlurHandler, ?WindowKeyHandler) callconv(.C) u32;
    const CreateWebviewFn = *const fn (u32, u32, [*:0]const u8, [*:0]const u8, f64, f64, f64, f64, bool, [*:0]const u8, ?DecideNavigationHandler, ?WebviewEventHandler, ?WebviewPostMessageHandler, ?WebviewPostMessageHandler, ?WebviewPostMessageHandler, [*:0]const u8, [*:0]const u8, [*:0]const u8, bool, bool, bool) callconv(.C) u32;
    const CreateWGPUViewFn = *const fn (u32, f64, f64, f64, f64, bool, bool, bool) callconv(.C) u32;
    const SetWindowTitleFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const MinimizeWindowFn = *const fn (u32) callconv(.C) void;
    const RestoreWindowFn = *const fn (u32) callconv(.C) void;
    const IsWindowMinimizedFn = *const fn (u32) callconv(.C) bool;
    const MaximizeWindowFn = *const fn (u32) callconv(.C) void;
    const UnmaximizeWindowFn = *const fn (u32) callconv(.C) void;
    const IsWindowMaximizedFn = *const fn (u32) callconv(.C) bool;
    const SetWindowFullScreenFn = *const fn (u32, bool) callconv(.C) void;
    const IsWindowFullScreenFn = *const fn (u32) callconv(.C) bool;
    const SetWindowAlwaysOnTopFn = *const fn (u32, bool) callconv(.C) void;
    const IsWindowAlwaysOnTopFn = *const fn (u32) callconv(.C) bool;
    const SetWindowVisibleOnAllWorkspacesFn = *const fn (u32, bool) callconv(.C) void;
    const IsWindowVisibleOnAllWorkspacesFn = *const fn (u32) callconv(.C) bool;
    const ShowWindowFn = *const fn (u32, bool) callconv(.C) void;
    const ActivateWindowFn = *const fn (u32) callconv(.C) void;
    const HideWindowFn = *const fn (u32) callconv(.C) void;
    const SetWindowButtonPositionFn = *const fn (u32, f64, f64) callconv(.C) void;
    const SetWindowPositionFn = *const fn (u32, f64, f64) callconv(.C) void;
    const SetWindowSizeFn = *const fn (u32, f64, f64) callconv(.C) void;
    const SetWindowFrameFn = *const fn (u32, f64, f64, f64, f64) callconv(.C) void;
    const GetWindowFrameFn = *const fn (u32, *f64, *f64, *f64, *f64) callconv(.C) void;
    const CloseWindowFn = *const fn (u32) callconv(.C) void;
    const ResizeWebviewFn = *const fn (u32, f64, f64, f64, f64, [*:0]const u8) callconv(.C) void;
    const LoadURLInWebViewFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const LoadHTMLInWebViewFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const UpdatePreloadScriptToWebViewFn = *const fn (u32, [*:0]const u8, [*:0]const u8, bool) callconv(.C) void;
    const WebviewCanGoBackFn = *const fn (u32) callconv(.C) bool;
    const WebviewCanGoForwardFn = *const fn (u32) callconv(.C) bool;
    const WebviewGoBackFn = *const fn (u32) callconv(.C) void;
    const WebviewGoForwardFn = *const fn (u32) callconv(.C) void;
    const WebviewReloadFn = *const fn (u32) callconv(.C) void;
    const WebviewRemoveFn = *const fn (u32) callconv(.C) void;
    const SetWebviewHTMLContentFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const WebviewSetTransparentFn = *const fn (u32, bool) callconv(.C) void;
    const WebviewSetPassthroughFn = *const fn (u32, bool) callconv(.C) void;
    const WebviewSetHiddenFn = *const fn (u32, bool) callconv(.C) void;
    const SetWebviewNavigationRulesFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const WebviewFindInPageFn = *const fn (u32, [*:0]const u8, bool, bool) callconv(.C) void;
    const WebviewStopFindFn = *const fn (u32) callconv(.C) void;
    const SendInternalMessageToWebviewFn = *const fn (u32, [*:0]const u8) callconv(.C) bool;
    const WebviewOpenDevToolsFn = *const fn (u32) callconv(.C) void;
    const WebviewCloseDevToolsFn = *const fn (u32) callconv(.C) void;
    const WebviewToggleDevToolsFn = *const fn (u32) callconv(.C) void;
    const WebviewSetPageZoomFn = *const fn (u32, f64) callconv(.C) void;
    const WebviewGetPageZoomFn = *const fn (u32) callconv(.C) f64;
    const SetWGPUViewFrameFn = *const fn (u32, f64, f64, f64, f64) callconv(.C) void;
    const ResizeWGPUViewFn = *const fn (u32, f64, f64, f64, f64, [*:0]const u8) callconv(.C) void;
    const SetWGPUViewTransparentFn = *const fn (u32, bool) callconv(.C) void;
    const SetWGPUViewPassthroughFn = *const fn (u32, bool) callconv(.C) void;
    const SetWGPUViewHiddenFn = *const fn (u32, bool) callconv(.C) void;
    const RemoveWGPUViewFn = *const fn (u32) callconv(.C) void;
    const GetWGPUViewPointerFn = *const fn (u32) callconv(.C) ?*anyopaque;
    const GetWGPUViewNativeHandleFn = *const fn (u32) callconv(.C) ?*anyopaque;
    const RunWGPUViewTestFn = *const fn (u32) callconv(.C) void;
    const ToggleWGPUViewTestShaderFn = *const fn (u32) callconv(.C) void;
    const EvaluateJavaScriptWithNoCompletionFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const CreateTrayFn = *const fn ([*:0]const u8, [*:0]const u8, bool, u32, u32, ?*const fn (u32, [*:0]const u8) callconv(.C) void) callconv(.C) u32;
    const ShowTrayFn = *const fn (u32) callconv(.C) bool;
    const HideTrayFn = *const fn (u32) callconv(.C) void;
    const SetTrayTitleFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const RemoveTrayFn = *const fn (u32) callconv(.C) void;
    const GetTrayBoundsFn = *const fn (u32) callconv(.C) [*:0]const u8;
    const SetDockIconVisibleFn = *const fn (bool) callconv(.C) void;
    const IsDockIconVisibleFn = *const fn () callconv(.C) bool;
    const GetPrimaryDisplayFn = *const fn () callconv(.C) ?[*:0]const u8;
    const GetAllDisplaysFn = *const fn () callconv(.C) ?[*:0]const u8;
    const GetCursorScreenPointFn = *const fn () callconv(.C) ?[*:0]const u8;
    const MoveToTrashFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const ShowItemInFolderFn = *const fn ([*:0]const u8) callconv(.C) void;
    const OpenExternalFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const OpenPathFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const ShowNotificationFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, bool) callconv(.C) void;
    const ClipboardReadTextFn = *const fn () callconv(.C) ?[*:0]const u8;
    const ClipboardWriteTextFn = *const fn ([*:0]const u8) callconv(.C) void;
    const ClipboardClearFn = *const fn () callconv(.C) void;
    const ClipboardAvailableFormatsFn = *const fn () callconv(.C) ?[*:0]const u8;
    const SetApplicationMenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.C) void;
    const ShowContextMenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.C) void;
    const OpenFileDialogFn = *const fn ([*:0]const u8, [*:0]const u8, c_int, c_int, c_int) callconv(.C) ?[*:0]const u8;
    const ShowMessageBoxFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, [*:0]const u8, [*:0]const u8, c_int, c_int) callconv(.C) c_int;
    const SetGlobalShortcutCallbackFn = *const fn (?GlobalShortcutHandler) callconv(.C) void;
    const RegisterGlobalShortcutFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const UnregisterGlobalShortcutFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const UnregisterAllGlobalShortcutsFn = *const fn () callconv(.C) void;
    const IsGlobalShortcutRegisteredFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const SessionGetCookiesFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.C) ?[*:0]const u8;
    const SessionSetCookieFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.C) bool;
    const SessionRemoveCookieFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8) callconv(.C) bool;
    const SessionClearCookiesFn = *const fn ([*:0]const u8) callconv(.C) void;
    const SessionClearStorageDataFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.C) void;
    const SetURLOpenHandlerFn = *const fn (?URLOpenHandler) callconv(.C) void;
    const SetAppReopenHandlerFn = *const fn (?AppReopenHandler) callconv(.C) void;
    const SetQuitRequestedHandlerFn = *const fn (?QuitRequestedHandler) callconv(.C) void;
    const StopEventLoopFn = *const fn () callconv(.C) void;
    const WaitForShutdownCompleteFn = *const fn (c_int) callconv(.C) void;
    const ForceExitFn = *const fn (c_int) callconv(.C) void;
    const WgpuCreateSurfaceForViewFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const WgpuCreateAdapterDeviceMainThreadFn = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.C) void;
    const WgpuSurfaceConfigureMainThreadFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) void;
    const WgpuSurfaceGetCurrentTextureMainThreadFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) void;
    const WgpuSurfacePresentMainThreadFn = *const fn (?*anyopaque) callconv(.C) i32;

    const Symbols = struct {
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
        update_preload_script_to_webview: UpdatePreloadScriptToWebViewFn,
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
        send_internal_message_to_webview: SendInternalMessageToWebviewFn,
        webview_open_devtools: WebviewOpenDevToolsFn,
        webview_close_devtools: WebviewCloseDevToolsFn,
        webview_toggle_devtools: WebviewToggleDevToolsFn,
        webview_set_page_zoom: WebviewSetPageZoomFn,
        webview_get_page_zoom: WebviewGetPageZoomFn,
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
        wgpu_create_surface_for_view: WgpuCreateSurfaceForViewFn,
        wgpu_create_adapter_device_main_thread: WgpuCreateAdapterDeviceMainThreadFn,
        wgpu_surface_configure_main_thread: WgpuSurfaceConfigureMainThreadFn,
        wgpu_surface_get_current_texture_main_thread: WgpuSurfaceGetCurrentTextureMainThreadFn,
        wgpu_surface_present_main_thread: WgpuSurfacePresentMainThreadFn,
    };

    pub fn load(allocator: std.mem.Allocator) !Core {
        const bundle_paths = try resolveBundlePaths(allocator);
        defer bundle_paths.deinit(allocator);

        const lib_name = switch (builtin.os.tag) {
            .windows => "ElectrobunCore.dll",
            .macos => "libElectrobunCore.dylib",
            else => "libElectrobunCore.so",
        };
        const lib_path = try std.fs.path.join(allocator, &.{ bundle_paths.exe_dir, lib_name });
        defer allocator.free(lib_path);

        var lib = try std.DynLib.open(lib_path);

        return .{
            .allocator = allocator,
            .lib = lib,
            .symbols = .{
                .last_error = lib.lookup(LastErrorFn, "electrobun_core_last_error") orelse return error.MissingCoreSymbol,
                .run_main_thread = lib.lookup(RunMainThreadFn, "electrobun_core_run_main_thread") orelse return error.MissingCoreSymbol,
                .configure_webview_runtime = lib.lookup(ConfigureWebviewRuntimeFn, "configureWebviewRuntime") orelse return error.MissingCoreSymbol,
                .get_window_style = lib.lookup(GetWindowStyleFn, "getWindowStyle") orelse return error.MissingCoreSymbol,
                .create_window = lib.lookup(CreateWindowFn, "createWindow") orelse return error.MissingCoreSymbol,
                .create_webview = lib.lookup(CreateWebviewFn, "createWebview") orelse return error.MissingCoreSymbol,
                .create_wgpu_view = lib.lookup(CreateWGPUViewFn, "createWGPUView") orelse return error.MissingCoreSymbol,
                .set_window_title = lib.lookup(SetWindowTitleFn, "setWindowTitle") orelse return error.MissingCoreSymbol,
                .minimize_window = lib.lookup(MinimizeWindowFn, "minimizeWindow") orelse return error.MissingCoreSymbol,
                .restore_window = lib.lookup(RestoreWindowFn, "restoreWindow") orelse return error.MissingCoreSymbol,
                .is_window_minimized = lib.lookup(IsWindowMinimizedFn, "isWindowMinimized") orelse return error.MissingCoreSymbol,
                .maximize_window = lib.lookup(MaximizeWindowFn, "maximizeWindow") orelse return error.MissingCoreSymbol,
                .unmaximize_window = lib.lookup(UnmaximizeWindowFn, "unmaximizeWindow") orelse return error.MissingCoreSymbol,
                .is_window_maximized = lib.lookup(IsWindowMaximizedFn, "isWindowMaximized") orelse return error.MissingCoreSymbol,
                .set_window_full_screen = lib.lookup(SetWindowFullScreenFn, "setWindowFullScreen") orelse return error.MissingCoreSymbol,
                .is_window_full_screen = lib.lookup(IsWindowFullScreenFn, "isWindowFullScreen") orelse return error.MissingCoreSymbol,
                .set_window_always_on_top = lib.lookup(SetWindowAlwaysOnTopFn, "setWindowAlwaysOnTop") orelse return error.MissingCoreSymbol,
                .is_window_always_on_top = lib.lookup(IsWindowAlwaysOnTopFn, "isWindowAlwaysOnTop") orelse return error.MissingCoreSymbol,
                .set_window_visible_on_all_workspaces = lib.lookup(SetWindowVisibleOnAllWorkspacesFn, "setWindowVisibleOnAllWorkspaces") orelse return error.MissingCoreSymbol,
                .is_window_visible_on_all_workspaces = lib.lookup(IsWindowVisibleOnAllWorkspacesFn, "isWindowVisibleOnAllWorkspaces") orelse return error.MissingCoreSymbol,
                .show_window = lib.lookup(ShowWindowFn, "showWindow") orelse return error.MissingCoreSymbol,
                .activate_window = lib.lookup(ActivateWindowFn, "activateWindow") orelse return error.MissingCoreSymbol,
                .hide_window = lib.lookup(HideWindowFn, "hideWindow") orelse return error.MissingCoreSymbol,
                .set_window_button_position = lib.lookup(SetWindowButtonPositionFn, "setWindowButtonPosition") orelse return error.MissingCoreSymbol,
                .set_window_position = lib.lookup(SetWindowPositionFn, "setWindowPosition") orelse return error.MissingCoreSymbol,
                .set_window_size = lib.lookup(SetWindowSizeFn, "setWindowSize") orelse return error.MissingCoreSymbol,
                .set_window_frame = lib.lookup(SetWindowFrameFn, "setWindowFrame") orelse return error.MissingCoreSymbol,
                .get_window_frame = lib.lookup(GetWindowFrameFn, "getWindowFrame") orelse return error.MissingCoreSymbol,
                .close_window = lib.lookup(CloseWindowFn, "closeWindow") orelse return error.MissingCoreSymbol,
                .resize_webview = lib.lookup(ResizeWebviewFn, "resizeWebview") orelse return error.MissingCoreSymbol,
                .load_url_in_webview = lib.lookup(LoadURLInWebViewFn, "loadURLInWebView") orelse return error.MissingCoreSymbol,
                .load_html_in_webview = lib.lookup(LoadHTMLInWebViewFn, "loadHTMLInWebView") orelse return error.MissingCoreSymbol,
                .update_preload_script_to_webview = lib.lookup(UpdatePreloadScriptToWebViewFn, "updatePreloadScriptToWebView") orelse return error.MissingCoreSymbol,
                .webview_can_go_back = lib.lookup(WebviewCanGoBackFn, "webviewCanGoBack") orelse return error.MissingCoreSymbol,
                .webview_can_go_forward = lib.lookup(WebviewCanGoForwardFn, "webviewCanGoForward") orelse return error.MissingCoreSymbol,
                .webview_go_back = lib.lookup(WebviewGoBackFn, "webviewGoBack") orelse return error.MissingCoreSymbol,
                .webview_go_forward = lib.lookup(WebviewGoForwardFn, "webviewGoForward") orelse return error.MissingCoreSymbol,
                .webview_reload = lib.lookup(WebviewReloadFn, "webviewReload") orelse return error.MissingCoreSymbol,
                .webview_remove = lib.lookup(WebviewRemoveFn, "webviewRemove") orelse return error.MissingCoreSymbol,
                .set_webview_html_content = lib.lookup(SetWebviewHTMLContentFn, "setWebviewHTMLContent") orelse return error.MissingCoreSymbol,
                .webview_set_transparent = lib.lookup(WebviewSetTransparentFn, "webviewSetTransparent") orelse return error.MissingCoreSymbol,
                .webview_set_passthrough = lib.lookup(WebviewSetPassthroughFn, "webviewSetPassthrough") orelse return error.MissingCoreSymbol,
                .webview_set_hidden = lib.lookup(WebviewSetHiddenFn, "webviewSetHidden") orelse return error.MissingCoreSymbol,
                .set_webview_navigation_rules = lib.lookup(SetWebviewNavigationRulesFn, "setWebviewNavigationRules") orelse return error.MissingCoreSymbol,
                .webview_find_in_page = lib.lookup(WebviewFindInPageFn, "webviewFindInPage") orelse return error.MissingCoreSymbol,
                .webview_stop_find = lib.lookup(WebviewStopFindFn, "webviewStopFind") orelse return error.MissingCoreSymbol,
                .send_internal_message_to_webview = lib.lookup(SendInternalMessageToWebviewFn, "sendInternalMessageToWebview") orelse return error.MissingCoreSymbol,
                .webview_open_devtools = lib.lookup(WebviewOpenDevToolsFn, "webviewOpenDevTools") orelse return error.MissingCoreSymbol,
                .webview_close_devtools = lib.lookup(WebviewCloseDevToolsFn, "webviewCloseDevTools") orelse return error.MissingCoreSymbol,
                .webview_toggle_devtools = lib.lookup(WebviewToggleDevToolsFn, "webviewToggleDevTools") orelse return error.MissingCoreSymbol,
                .webview_set_page_zoom = lib.lookup(WebviewSetPageZoomFn, "webviewSetPageZoom") orelse return error.MissingCoreSymbol,
                .webview_get_page_zoom = lib.lookup(WebviewGetPageZoomFn, "webviewGetPageZoom") orelse return error.MissingCoreSymbol,
                .set_wgpu_view_frame = lib.lookup(SetWGPUViewFrameFn, "setWGPUViewFrame") orelse return error.MissingCoreSymbol,
                .resize_wgpu_view = lib.lookup(ResizeWGPUViewFn, "resizeWGPUView") orelse return error.MissingCoreSymbol,
                .set_wgpu_view_transparent = lib.lookup(SetWGPUViewTransparentFn, "setWGPUViewTransparent") orelse return error.MissingCoreSymbol,
                .set_wgpu_view_passthrough = lib.lookup(SetWGPUViewPassthroughFn, "setWGPUViewPassthrough") orelse return error.MissingCoreSymbol,
                .set_wgpu_view_hidden = lib.lookup(SetWGPUViewHiddenFn, "setWGPUViewHidden") orelse return error.MissingCoreSymbol,
                .remove_wgpu_view = lib.lookup(RemoveWGPUViewFn, "removeWGPUView") orelse return error.MissingCoreSymbol,
                .get_wgpu_view_pointer = lib.lookup(GetWGPUViewPointerFn, "getWGPUViewPointer") orelse return error.MissingCoreSymbol,
                .get_wgpu_view_native_handle = lib.lookup(GetWGPUViewNativeHandleFn, "getWGPUViewNativeHandle") orelse return error.MissingCoreSymbol,
                .run_wgpu_view_test = lib.lookup(RunWGPUViewTestFn, "runWGPUViewTest") orelse return error.MissingCoreSymbol,
                .toggle_wgpu_view_test_shader = lib.lookup(ToggleWGPUViewTestShaderFn, "toggleWGPUViewTestShader") orelse return error.MissingCoreSymbol,
                .evaluate_javascript_with_no_completion = lib.lookup(EvaluateJavaScriptWithNoCompletionFn, "evaluateJavaScriptWithNoCompletion") orelse return error.MissingCoreSymbol,
                .create_tray = lib.lookup(CreateTrayFn, "createTray") orelse return error.MissingCoreSymbol,
                .show_tray = lib.lookup(ShowTrayFn, "showTray") orelse return error.MissingCoreSymbol,
                .hide_tray = lib.lookup(HideTrayFn, "hideTray") orelse return error.MissingCoreSymbol,
                .set_tray_title = lib.lookup(SetTrayTitleFn, "setTrayTitle") orelse return error.MissingCoreSymbol,
                .remove_tray = lib.lookup(RemoveTrayFn, "removeTray") orelse return error.MissingCoreSymbol,
                .get_tray_bounds = lib.lookup(GetTrayBoundsFn, "getTrayBounds") orelse return error.MissingCoreSymbol,
                .set_dock_icon_visible = lib.lookup(SetDockIconVisibleFn, "setDockIconVisible") orelse return error.MissingCoreSymbol,
                .is_dock_icon_visible = lib.lookup(IsDockIconVisibleFn, "isDockIconVisible") orelse return error.MissingCoreSymbol,
                .get_primary_display = lib.lookup(GetPrimaryDisplayFn, "getPrimaryDisplay") orelse return error.MissingCoreSymbol,
                .get_all_displays = lib.lookup(GetAllDisplaysFn, "getAllDisplays") orelse return error.MissingCoreSymbol,
                .get_cursor_screen_point = lib.lookup(GetCursorScreenPointFn, "getCursorScreenPoint") orelse return error.MissingCoreSymbol,
                .move_to_trash = lib.lookup(MoveToTrashFn, "moveToTrash") orelse return error.MissingCoreSymbol,
                .show_item_in_folder = lib.lookup(ShowItemInFolderFn, "showItemInFolder") orelse return error.MissingCoreSymbol,
                .open_external = lib.lookup(OpenExternalFn, "openExternal") orelse return error.MissingCoreSymbol,
                .open_path = lib.lookup(OpenPathFn, "openPath") orelse return error.MissingCoreSymbol,
                .show_notification = lib.lookup(ShowNotificationFn, "showNotification") orelse return error.MissingCoreSymbol,
                .clipboard_read_text = lib.lookup(ClipboardReadTextFn, "clipboardReadText") orelse return error.MissingCoreSymbol,
                .clipboard_write_text = lib.lookup(ClipboardWriteTextFn, "clipboardWriteText") orelse return error.MissingCoreSymbol,
                .clipboard_clear = lib.lookup(ClipboardClearFn, "clipboardClear") orelse return error.MissingCoreSymbol,
                .clipboard_available_formats = lib.lookup(ClipboardAvailableFormatsFn, "clipboardAvailableFormats") orelse return error.MissingCoreSymbol,
                .set_application_menu = lib.lookup(SetApplicationMenuFn, "setApplicationMenu") orelse return error.MissingCoreSymbol,
                .show_context_menu = lib.lookup(ShowContextMenuFn, "showContextMenu") orelse return error.MissingCoreSymbol,
                .open_file_dialog = lib.lookup(OpenFileDialogFn, "openFileDialog") orelse return error.MissingCoreSymbol,
                .show_message_box = lib.lookup(ShowMessageBoxFn, "showMessageBox") orelse return error.MissingCoreSymbol,
                .set_global_shortcut_callback = lib.lookup(SetGlobalShortcutCallbackFn, "setGlobalShortcutCallback") orelse return error.MissingCoreSymbol,
                .register_global_shortcut = lib.lookup(RegisterGlobalShortcutFn, "registerGlobalShortcut") orelse return error.MissingCoreSymbol,
                .unregister_global_shortcut = lib.lookup(UnregisterGlobalShortcutFn, "unregisterGlobalShortcut") orelse return error.MissingCoreSymbol,
                .unregister_all_global_shortcuts = lib.lookup(UnregisterAllGlobalShortcutsFn, "unregisterAllGlobalShortcuts") orelse return error.MissingCoreSymbol,
                .is_global_shortcut_registered = lib.lookup(IsGlobalShortcutRegisteredFn, "isGlobalShortcutRegistered") orelse return error.MissingCoreSymbol,
                .session_get_cookies = lib.lookup(SessionGetCookiesFn, "sessionGetCookies") orelse return error.MissingCoreSymbol,
                .session_set_cookie = lib.lookup(SessionSetCookieFn, "sessionSetCookie") orelse return error.MissingCoreSymbol,
                .session_remove_cookie = lib.lookup(SessionRemoveCookieFn, "sessionRemoveCookie") orelse return error.MissingCoreSymbol,
                .session_clear_cookies = lib.lookup(SessionClearCookiesFn, "sessionClearCookies") orelse return error.MissingCoreSymbol,
                .session_clear_storage_data = lib.lookup(SessionClearStorageDataFn, "sessionClearStorageData") orelse return error.MissingCoreSymbol,
                .set_url_open_handler = lib.lookup(SetURLOpenHandlerFn, "setURLOpenHandler") orelse return error.MissingCoreSymbol,
                .set_app_reopen_handler = lib.lookup(SetAppReopenHandlerFn, "setAppReopenHandler") orelse return error.MissingCoreSymbol,
                .set_quit_requested_handler = lib.lookup(SetQuitRequestedHandlerFn, "setQuitRequestedHandler") orelse return error.MissingCoreSymbol,
                .stop_event_loop = lib.lookup(StopEventLoopFn, "stopEventLoop") orelse return error.MissingCoreSymbol,
                .wait_for_shutdown_complete = lib.lookup(WaitForShutdownCompleteFn, "waitForShutdownComplete") orelse return error.MissingCoreSymbol,
                .force_exit = lib.lookup(ForceExitFn, "forceExit") orelse return error.MissingCoreSymbol,
                .wgpu_create_surface_for_view = lib.lookup(WgpuCreateSurfaceForViewFn, "wgpuCreateSurfaceForView") orelse return error.MissingCoreSymbol,
                .wgpu_create_adapter_device_main_thread = lib.lookup(WgpuCreateAdapterDeviceMainThreadFn, "wgpuCreateAdapterDeviceMainThread") orelse return error.MissingCoreSymbol,
                .wgpu_surface_configure_main_thread = lib.lookup(WgpuSurfaceConfigureMainThreadFn, "wgpuSurfaceConfigureMainThread") orelse return error.MissingCoreSymbol,
                .wgpu_surface_get_current_texture_main_thread = lib.lookup(WgpuSurfaceGetCurrentTextureMainThreadFn, "wgpuSurfaceGetCurrentTextureMainThread") orelse return error.MissingCoreSymbol,
                .wgpu_surface_present_main_thread = lib.lookup(WgpuSurfacePresentMainThreadFn, "wgpuSurfacePresentMainThread") orelse return error.MissingCoreSymbol,
            },
        };
    }

    pub fn close(self: *Core) void {
        self.lib.close();
    }

    fn lastError(self: *Core) []const u8 {
        return std.mem.span(self.symbols.last_error());
    }

    fn dupeZ(self: *Core, value: []const u8) ![:0]u8 {
        return try self.allocator.dupeZ(u8, value);
    }

    pub fn configureWebviewRuntimeFromExecutableDir(self: *Core, bundle_paths: *const BundlePaths, rpc_port: u32) !void {
        const full_path = try std.fs.path.join(self.allocator, &.{ bundle_paths.exe_dir, "preload-full.js" });
        defer self.allocator.free(full_path);
        const sandboxed_path = try std.fs.path.join(self.allocator, &.{ bundle_paths.exe_dir, "preload-sandboxed.js" });
        defer self.allocator.free(sandboxed_path);

        const full_preload = try readFileZ(self.allocator, full_path);
        defer self.allocator.free(full_preload);
        const sandboxed_preload = try readFileZ(self.allocator, sandboxed_path);
        defer self.allocator.free(sandboxed_preload);

        if (!self.symbols.configure_webview_runtime(rpc_port, full_preload.ptr, sandboxed_preload.ptr)) {
            return errorFromLastError(self.lastError());
        }
    }

    pub fn defaultWindowStyle(self: *Core) u32 {
        return self.symbols.get_window_style(
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
        );
    }

    pub fn createWindow(self: *Core, options: WindowOptions) !u32 {
        const title_z = try self.dupeZ(options.title);
        defer self.allocator.free(title_z);
        const title_bar_style_z = try self.dupeZ(options.title_bar_style);
        defer self.allocator.free(title_bar_style_z);

        const style_mask = self.symbols.get_window_style(
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
        );

        const window_id = self.symbols.create_window(
            options.frame.x,
            options.frame.y,
            options.frame.width,
            options.frame.height,
            style_mask,
            title_bar_style_z.ptr,
            options.transparent,
            title_z.ptr,
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
        );

        if (window_id == 0) {
            return errorFromLastError(self.lastError());
        }

        return window_id;
    }

    pub fn setWindowTitle(self: *Core, window_id: u32, title: []const u8) !void {
        const title_z = try self.dupeZ(title);
        defer self.allocator.free(title_z);
        self.symbols.set_window_title(window_id, title_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn minimizeWindow(self: *Core, window_id: u32) !void {
        self.symbols.minimize_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn restoreWindow(self: *Core, window_id: u32) !void {
        self.symbols.restore_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn isWindowMinimized(self: *Core, window_id: u32) bool {
        return self.symbols.is_window_minimized(window_id);
    }

    pub fn maximizeWindow(self: *Core, window_id: u32) !void {
        self.symbols.maximize_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn unmaximizeWindow(self: *Core, window_id: u32) !void {
        self.symbols.unmaximize_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn isWindowMaximized(self: *Core, window_id: u32) bool {
        return self.symbols.is_window_maximized(window_id);
    }

    pub fn setWindowFullScreen(self: *Core, window_id: u32, full_screen: bool) !void {
        self.symbols.set_window_full_screen(window_id, full_screen);
        try self.ensureLastCallSucceeded();
    }

    pub fn isWindowFullScreen(self: *Core, window_id: u32) bool {
        return self.symbols.is_window_full_screen(window_id);
    }

    pub fn setWindowAlwaysOnTop(self: *Core, window_id: u32, always_on_top: bool) !void {
        self.symbols.set_window_always_on_top(window_id, always_on_top);
        try self.ensureLastCallSucceeded();
    }

    pub fn isWindowAlwaysOnTop(self: *Core, window_id: u32) bool {
        return self.symbols.is_window_always_on_top(window_id);
    }

    pub fn setWindowVisibleOnAllWorkspaces(self: *Core, window_id: u32, visible: bool) !void {
        self.symbols.set_window_visible_on_all_workspaces(window_id, visible);
        try self.ensureLastCallSucceeded();
    }

    pub fn isWindowVisibleOnAllWorkspaces(self: *Core, window_id: u32) bool {
        return self.symbols.is_window_visible_on_all_workspaces(window_id);
    }

    pub fn showWindow(self: *Core, window_id: u32, activate: bool) !void {
        self.symbols.show_window(window_id, activate);
        try self.ensureLastCallSucceeded();
    }

    pub fn activateWindow(self: *Core, window_id: u32) !void {
        self.symbols.activate_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn hideWindow(self: *Core, window_id: u32) !void {
        self.symbols.hide_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWindowButtonPosition(self: *Core, window_id: u32, x: f64, y: f64) !void {
        self.symbols.set_window_button_position(window_id, x, y);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWindowPosition(self: *Core, window_id: u32, x: f64, y: f64) !void {
        self.symbols.set_window_position(window_id, x, y);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWindowSize(self: *Core, window_id: u32, width: f64, height: f64) !void {
        self.symbols.set_window_size(window_id, width, height);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWindowFrame(self: *Core, window_id: u32, frame: Rect) !void {
        self.symbols.set_window_frame(
            window_id,
            frame.x,
            frame.y,
            frame.width,
            frame.height,
        );
        try self.ensureLastCallSucceeded();
    }

    pub fn getWindowFrame(self: *Core, window_id: u32) !Rect {
        var x: f64 = 0;
        var y: f64 = 0;
        var width: f64 = 0;
        var height: f64 = 0;

        self.symbols.get_window_frame(window_id, &x, &y, &width, &height);
        try self.ensureLastCallSucceeded();

        return .{
            .x = x,
            .y = y,
            .width = width,
            .height = height,
        };
    }

    pub fn closeWindow(self: *Core, window_id: u32) !void {
        self.symbols.close_window(window_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn createWebview(self: *Core, options: WebviewOptions) !u32 {
        const renderer_z = try self.dupeZ(@tagName(options.renderer));
        defer self.allocator.free(renderer_z);
        const url_z = try self.dupeZ(options.url);
        defer self.allocator.free(url_z);
        const partition_z = try self.dupeZ(options.partition);
        defer self.allocator.free(partition_z);
        const secret_key_z = try self.dupeZ(options.secret_key);
        defer self.allocator.free(secret_key_z);
        const preload_z = try self.dupeZ(options.preload);
        defer self.allocator.free(preload_z);
        const views_root_z = try self.dupeZ(options.views_root);
        defer self.allocator.free(views_root_z);

        const webview_id = self.symbols.create_webview(
            options.window_id,
            options.host_webview_id,
            renderer_z.ptr,
            url_z.ptr,
            options.frame.x,
            options.frame.y,
            options.frame.width,
            options.frame.height,
            options.auto_resize,
            partition_z.ptr,
            options.callbacks.decide_navigation,
            options.callbacks.event,
            options.callbacks.event_bridge,
            options.callbacks.bun_bridge,
            options.callbacks.internal_bridge,
            secret_key_z.ptr,
            preload_z.ptr,
            views_root_z.ptr,
            options.sandbox,
            options.start_transparent,
            options.start_passthrough,
        );

        if (webview_id == 0) {
            return errorFromLastError(self.lastError());
        }

        return webview_id;
    }

    pub fn resizeWebview(self: *Core, webview_id: u32, frame: Rect, masks_json: []const u8) !void {
        const masks_json_z = try self.dupeZ(masks_json);
        defer self.allocator.free(masks_json_z);

        self.symbols.resize_webview(
            webview_id,
            frame.x,
            frame.y,
            frame.width,
            frame.height,
            masks_json_z.ptr,
        );
        try self.ensureLastCallSucceeded();
    }

    pub fn loadURLInWebview(self: *Core, webview_id: u32, url: []const u8) !void {
        const url_z = try self.dupeZ(url);
        defer self.allocator.free(url_z);
        self.symbols.load_url_in_webview(webview_id, url_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn loadHTMLInWebview(self: *Core, webview_id: u32, html: []const u8) !void {
        const html_z = try self.dupeZ(html);
        defer self.allocator.free(html_z);
        self.symbols.load_html_in_webview(webview_id, html_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn updatePreloadScriptToWebview(self: *Core, webview_id: u32, script_identifier: []const u8, script: []const u8, all_frames: bool) !void {
        const script_identifier_z = try self.dupeZ(script_identifier);
        defer self.allocator.free(script_identifier_z);
        const script_z = try self.dupeZ(script);
        defer self.allocator.free(script_z);

        self.symbols.update_preload_script_to_webview(
            webview_id,
            script_identifier_z.ptr,
            script_z.ptr,
            all_frames,
        );
        try self.ensureLastCallSucceeded();
    }

    pub fn canWebviewGoBack(self: *Core, webview_id: u32) bool {
        return self.symbols.webview_can_go_back(webview_id);
    }

    pub fn canWebviewGoForward(self: *Core, webview_id: u32) bool {
        return self.symbols.webview_can_go_forward(webview_id);
    }

    pub fn webviewGoBack(self: *Core, webview_id: u32) !void {
        self.symbols.webview_go_back(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn webviewGoForward(self: *Core, webview_id: u32) !void {
        self.symbols.webview_go_forward(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn reloadWebview(self: *Core, webview_id: u32) !void {
        self.symbols.webview_reload(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn removeWebview(self: *Core, webview_id: u32) !void {
        self.symbols.webview_remove(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWebviewHTMLContent(self: *Core, webview_id: u32, html: []const u8) !void {
        const html_z = try self.dupeZ(html);
        defer self.allocator.free(html_z);
        self.symbols.set_webview_html_content(webview_id, html_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWebviewTransparent(self: *Core, webview_id: u32, transparent: bool) !void {
        self.symbols.webview_set_transparent(webview_id, transparent);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWebviewPassthrough(self: *Core, webview_id: u32, passthrough: bool) !void {
        self.symbols.webview_set_passthrough(webview_id, passthrough);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWebviewHidden(self: *Core, webview_id: u32, hidden: bool) !void {
        self.symbols.webview_set_hidden(webview_id, hidden);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWebviewNavigationRules(self: *Core, webview_id: u32, rules_json: []const u8) !void {
        const rules_json_z = try self.dupeZ(rules_json);
        defer self.allocator.free(rules_json_z);
        self.symbols.set_webview_navigation_rules(webview_id, rules_json_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn webviewFindInPage(self: *Core, webview_id: u32, search_text: []const u8, forward: bool, match_case: bool) !void {
        const search_text_z = try self.dupeZ(search_text);
        defer self.allocator.free(search_text_z);
        self.symbols.webview_find_in_page(webview_id, search_text_z.ptr, forward, match_case);
        try self.ensureLastCallSucceeded();
    }

    pub fn webviewStopFind(self: *Core, webview_id: u32) !void {
        self.symbols.webview_stop_find(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn openWebviewDevTools(self: *Core, webview_id: u32) !void {
        self.symbols.webview_open_devtools(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn closeWebviewDevTools(self: *Core, webview_id: u32) !void {
        self.symbols.webview_close_devtools(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn toggleWebviewDevTools(self: *Core, webview_id: u32) !void {
        self.symbols.webview_toggle_devtools(webview_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWebviewPageZoom(self: *Core, webview_id: u32, zoom_level: f64) !void {
        self.symbols.webview_set_page_zoom(webview_id, zoom_level);
        try self.ensureLastCallSucceeded();
    }

    pub fn getWebviewPageZoom(self: *Core, webview_id: u32) f64 {
        return self.symbols.webview_get_page_zoom(webview_id);
    }

    pub fn createWGPUView(self: *Core, options: WGPUViewOptions) !u32 {
        const wgpu_view_id = self.symbols.create_wgpu_view(
            options.window_id,
            options.frame.x,
            options.frame.y,
            options.frame.width,
            options.frame.height,
            options.auto_resize,
            options.start_transparent,
            options.start_passthrough,
        );

        if (wgpu_view_id == 0) {
            return errorFromLastError(self.lastError());
        }

        return wgpu_view_id;
    }

    pub fn setWGPUViewFrame(self: *Core, wgpu_view_id: u32, frame: Rect) !void {
        self.symbols.set_wgpu_view_frame(
            wgpu_view_id,
            frame.x,
            frame.y,
            frame.width,
            frame.height,
        );
        try self.ensureLastCallSucceeded();
    }

    pub fn resizeWGPUView(self: *Core, wgpu_view_id: u32, frame: Rect, masks_json: []const u8) !void {
        const masks_json_z = try self.dupeZ(masks_json);
        defer self.allocator.free(masks_json_z);

        self.symbols.resize_wgpu_view(
            wgpu_view_id,
            frame.x,
            frame.y,
            frame.width,
            frame.height,
            masks_json_z.ptr,
        );
        try self.ensureLastCallSucceeded();
    }

    pub fn setWGPUViewTransparent(self: *Core, wgpu_view_id: u32, transparent: bool) !void {
        self.symbols.set_wgpu_view_transparent(wgpu_view_id, transparent);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWGPUViewPassthrough(self: *Core, wgpu_view_id: u32, passthrough: bool) !void {
        self.symbols.set_wgpu_view_passthrough(wgpu_view_id, passthrough);
        try self.ensureLastCallSucceeded();
    }

    pub fn setWGPUViewHidden(self: *Core, wgpu_view_id: u32, hidden: bool) !void {
        self.symbols.set_wgpu_view_hidden(wgpu_view_id, hidden);
        try self.ensureLastCallSucceeded();
    }

    pub fn removeWGPUView(self: *Core, wgpu_view_id: u32) !void {
        self.symbols.remove_wgpu_view(wgpu_view_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn getWGPUViewPointer(self: *Core, wgpu_view_id: u32) !?*anyopaque {
        const handle = self.symbols.get_wgpu_view_pointer(wgpu_view_id);
        try self.ensureLastCallSucceeded();
        return handle;
    }

    pub fn getWGPUViewNativeHandle(self: *Core, wgpu_view_id: u32) !?*anyopaque {
        const handle = self.symbols.get_wgpu_view_native_handle(wgpu_view_id);
        try self.ensureLastCallSucceeded();
        return handle;
    }

    pub fn runWGPUViewTest(self: *Core, wgpu_view_id: u32) !void {
        self.symbols.run_wgpu_view_test(wgpu_view_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn toggleWGPUViewTestShader(self: *Core, wgpu_view_id: u32) !void {
        self.symbols.toggle_wgpu_view_test_shader(wgpu_view_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn evaluateJavaScriptWithNoCompletion(self: *Core, webview_id: u32, js: []const u8) !void {
        const js_z = try self.dupeZ(js);
        defer self.allocator.free(js_z);

        self.symbols.evaluate_javascript_with_no_completion(webview_id, js_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn sendMessageToWebview(self: *Core, webview_id: u32, message: anytype) !void {
        const message_json = try std.json.stringifyAlloc(self.allocator, message, .{});
        defer self.allocator.free(message_json);

        const js = try std.fmt.allocPrint(
            self.allocator,
            "window.__electrobun.receiveMessageFromBun({s});",
            .{message_json},
        );
        defer self.allocator.free(js);

        try self.evaluateJavaScriptWithNoCompletion(webview_id, js);
    }

    pub fn sendInternalMessageToWebview(self: *Core, webview_id: u32, message: anytype) !void {
        const message_json = try std.json.stringifyAlloc(self.allocator, message, .{});
        defer self.allocator.free(message_json);
        const message_json_z = try self.dupeZ(message_json);
        defer self.allocator.free(message_json_z);

        if (!self.symbols.send_internal_message_to_webview(webview_id, message_json_z.ptr)) {
            return errorFromLastError(self.lastError());
        }
    }

    pub fn createTray(self: *Core, options: TrayOptions) !u32 {
        const title_z = try self.dupeZ(options.title);
        defer self.allocator.free(title_z);
        const image_z = try self.dupeZ(options.image);
        defer self.allocator.free(image_z);

        const tray_id = self.symbols.create_tray(
            title_z.ptr,
            image_z.ptr,
            options.is_template,
            options.width,
            options.height,
            null,
        );
        if (tray_id == 0) {
            return errorFromLastError(self.lastError());
        }
        return tray_id;
    }

    pub fn setApplicationMenuJson(self: *Core, menu_json: []const u8, handler: ?StatusItemHandler) !void {
        const menu_json_z = try self.dupeZ(menu_json);
        defer self.allocator.free(menu_json_z);
        self.symbols.set_application_menu(menu_json_z.ptr, handler);
        try self.ensureLastCallSucceeded();
    }

    pub fn showContextMenuJson(self: *Core, menu_json: []const u8, handler: ?StatusItemHandler) !void {
        const menu_json_z = try self.dupeZ(menu_json);
        defer self.allocator.free(menu_json_z);
        self.symbols.show_context_menu(menu_json_z.ptr, handler);
        try self.ensureLastCallSucceeded();
    }

    pub fn showTray(self: *Core, tray_id: u32) !void {
        if (!self.symbols.show_tray(tray_id)) {
            return errorFromLastError(self.lastError());
        }
    }

    pub fn hideTray(self: *Core, tray_id: u32) !void {
        self.symbols.hide_tray(tray_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn setTrayTitle(self: *Core, tray_id: u32, title: []const u8) !void {
        const title_z = try self.dupeZ(title);
        defer self.allocator.free(title_z);
        self.symbols.set_tray_title(tray_id, title_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn getTrayBounds(self: *Core, tray_id: u32) !Rect {
        const bounds_json = self.symbols.get_tray_bounds(tray_id);
        return try parseRectJson(self.allocator, std.mem.span(bounds_json));
    }

    pub fn removeTray(self: *Core, tray_id: u32) !void {
        self.symbols.remove_tray(tray_id);
        try self.ensureLastCallSucceeded();
    }

    pub fn setDockIconVisible(self: *Core, visible: bool) !void {
        self.symbols.set_dock_icon_visible(visible);
        try self.ensureLastCallSucceeded();
    }

    pub fn isDockIconVisible(self: *Core) bool {
        return self.symbols.is_dock_icon_visible();
    }

    pub fn getPrimaryDisplay(self: *Core) !Display {
        const json = self.symbols.get_primary_display() orelse return error.ElectrobunCoreFailure;
        return try parseJsonOwned(self.allocator, Display, std.mem.span(json));
    }

    pub fn getAllDisplays(self: *Core) ![]Display {
        const json = self.symbols.get_all_displays() orelse return error.ElectrobunCoreFailure;
        return try parseJsonSliceOwned(self.allocator, Display, std.mem.span(json));
    }

    pub fn getCursorScreenPoint(self: *Core) !Point {
        const json = self.symbols.get_cursor_screen_point() orelse return error.ElectrobunCoreFailure;
        return try parseJsonOwned(self.allocator, Point, std.mem.span(json));
    }

    pub fn moveToTrash(self: *Core, path: []const u8) !bool {
        const path_z = try self.dupeZ(path);
        defer self.allocator.free(path_z);
        return self.symbols.move_to_trash(path_z.ptr);
    }

    pub fn showItemInFolder(self: *Core, path: []const u8) !void {
        const path_z = try self.dupeZ(path);
        defer self.allocator.free(path_z);
        self.symbols.show_item_in_folder(path_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn openExternal(self: *Core, url: []const u8) !bool {
        const url_z = try self.dupeZ(url);
        defer self.allocator.free(url_z);
        return self.symbols.open_external(url_z.ptr);
    }

    pub fn openPath(self: *Core, path: []const u8) !bool {
        const path_z = try self.dupeZ(path);
        defer self.allocator.free(path_z);
        return self.symbols.open_path(path_z.ptr);
    }

    pub fn openFileDialog(self: *Core, options: OpenFileDialogOptions) ![]u8 {
        const starting_folder_z = try self.dupeZ(options.starting_folder);
        defer self.allocator.free(starting_folder_z);
        const allowed_file_types_z = try self.dupeZ(options.allowed_file_types);
        defer self.allocator.free(allowed_file_types_z);

        const result = self.symbols.open_file_dialog(
            starting_folder_z.ptr,
            allowed_file_types_z.ptr,
            if (options.can_choose_files) 1 else 0,
            if (options.can_choose_directory) 1 else 0,
            if (options.allows_multiple_selection) 1 else 0,
        ) orelse return try self.allocator.dupe(u8, "");
        return try self.allocator.dupe(u8, std.mem.span(result));
    }

    pub fn showMessageBox(self: *Core, options: MessageBoxOptions) !c_int {
        const box_type_z = try self.dupeZ(options.box_type);
        defer self.allocator.free(box_type_z);
        const title_z = try self.dupeZ(options.title);
        defer self.allocator.free(title_z);
        const message_z = try self.dupeZ(options.message);
        defer self.allocator.free(message_z);
        const detail_z = try self.dupeZ(options.detail);
        defer self.allocator.free(detail_z);
        const buttons_joined = try std.mem.join(self.allocator, ",", options.buttons);
        defer self.allocator.free(buttons_joined);
        const buttons_z = try self.dupeZ(buttons_joined);
        defer self.allocator.free(buttons_z);

        const response = self.symbols.show_message_box(
            box_type_z.ptr,
            title_z.ptr,
            message_z.ptr,
            detail_z.ptr,
            buttons_z.ptr,
            options.default_id,
            options.cancel_id,
        );
        try self.ensureLastCallSucceeded();
        return response;
    }

    pub fn showNotification(self: *Core, options: NotificationOptions) !void {
        const title_z = try self.dupeZ(options.title);
        defer self.allocator.free(title_z);
        const body_z = try self.dupeZ(options.body);
        defer self.allocator.free(body_z);
        const subtitle_z = try self.dupeZ(options.subtitle);
        defer self.allocator.free(subtitle_z);

        self.symbols.show_notification(title_z.ptr, body_z.ptr, subtitle_z.ptr, options.silent);
        try self.ensureLastCallSucceeded();
    }

    pub fn setGlobalShortcutCallback(self: *Core, callback: ?GlobalShortcutHandler) !void {
        self.symbols.set_global_shortcut_callback(callback);
        try self.ensureLastCallSucceeded();
    }

    pub fn registerGlobalShortcut(self: *Core, accelerator: []const u8) !bool {
        const accelerator_z = try self.dupeZ(accelerator);
        defer self.allocator.free(accelerator_z);
        return self.symbols.register_global_shortcut(accelerator_z.ptr);
    }

    pub fn unregisterGlobalShortcut(self: *Core, accelerator: []const u8) !bool {
        const accelerator_z = try self.dupeZ(accelerator);
        defer self.allocator.free(accelerator_z);
        return self.symbols.unregister_global_shortcut(accelerator_z.ptr);
    }

    pub fn unregisterAllGlobalShortcuts(self: *Core) !void {
        self.symbols.unregister_all_global_shortcuts();
        try self.ensureLastCallSucceeded();
    }

    pub fn isGlobalShortcutRegistered(self: *Core, accelerator: []const u8) !bool {
        const accelerator_z = try self.dupeZ(accelerator);
        defer self.allocator.free(accelerator_z);
        return self.symbols.is_global_shortcut_registered(accelerator_z.ptr);
    }

    pub fn clipboardReadText(self: *Core) !?[]u8 {
        const text = self.symbols.clipboard_read_text() orelse return null;
        return try self.allocator.dupe(u8, std.mem.span(text));
    }

    pub fn clipboardWriteText(self: *Core, text: []const u8) !void {
        const text_z = try self.dupeZ(text);
        defer self.allocator.free(text_z);
        self.symbols.clipboard_write_text(text_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn clipboardClear(self: *Core) !void {
        self.symbols.clipboard_clear();
        try self.ensureLastCallSucceeded();
    }

    pub fn clipboardAvailableFormatsCsv(self: *Core) ![]u8 {
        const formats = self.symbols.clipboard_available_formats() orelse return try self.allocator.dupe(u8, "");
        return try self.allocator.dupe(u8, std.mem.span(formats));
    }

    pub fn sessionGetCookies(self: *Core, partition: []const u8, filter_json: []const u8) ![]Cookie {
        const partition_z = try self.dupeZ(partition);
        defer self.allocator.free(partition_z);
        const filter_json_z = try self.dupeZ(filter_json);
        defer self.allocator.free(filter_json_z);
        const json = self.symbols.session_get_cookies(partition_z.ptr, filter_json_z.ptr) orelse return try self.allocator.alloc(Cookie, 0);
        const parsed = try std.json.parseFromSlice([]Cookie, self.allocator, std.mem.span(json), .{});
        return parsed.value;
    }

    pub fn sessionSetCookie(self: *Core, partition: []const u8, cookie_json: []const u8) !bool {
        const partition_z = try self.dupeZ(partition);
        defer self.allocator.free(partition_z);
        const cookie_json_z = try self.dupeZ(cookie_json);
        defer self.allocator.free(cookie_json_z);
        return self.symbols.session_set_cookie(partition_z.ptr, cookie_json_z.ptr);
    }

    pub fn sessionRemoveCookie(self: *Core, partition: []const u8, url: []const u8, name: []const u8) !bool {
        const partition_z = try self.dupeZ(partition);
        defer self.allocator.free(partition_z);
        const url_z = try self.dupeZ(url);
        defer self.allocator.free(url_z);
        const name_z = try self.dupeZ(name);
        defer self.allocator.free(name_z);
        return self.symbols.session_remove_cookie(partition_z.ptr, url_z.ptr, name_z.ptr);
    }

    pub fn sessionClearCookies(self: *Core, partition: []const u8) !void {
        const partition_z = try self.dupeZ(partition);
        defer self.allocator.free(partition_z);
        self.symbols.session_clear_cookies(partition_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn sessionClearStorageData(self: *Core, partition: []const u8, storage_types_json: []const u8) !void {
        const partition_z = try self.dupeZ(partition);
        defer self.allocator.free(partition_z);
        const storage_types_json_z = try self.dupeZ(storage_types_json);
        defer self.allocator.free(storage_types_json_z);
        self.symbols.session_clear_storage_data(partition_z.ptr, storage_types_json_z.ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn setURLOpenHandler(self: *Core, handler: ?URLOpenHandler) !void {
        self.symbols.set_url_open_handler(handler);
        try self.ensureLastCallSucceeded();
    }

    pub fn setAppReopenHandler(self: *Core, handler: ?AppReopenHandler) !void {
        self.symbols.set_app_reopen_handler(handler);
        try self.ensureLastCallSucceeded();
    }

    pub fn setQuitRequestedHandler(self: *Core, handler: ?QuitRequestedHandler) !void {
        self.symbols.set_quit_requested_handler(handler);
        try self.ensureLastCallSucceeded();
    }

    pub fn stopEventLoop(self: *Core) !void {
        self.symbols.stop_event_loop();
        try self.ensureLastCallSucceeded();
    }

    pub fn waitForShutdownComplete(self: *Core, timeout_ms: c_int) !void {
        self.symbols.wait_for_shutdown_complete(timeout_ms);
        try self.ensureLastCallSucceeded();
    }

    pub fn forceExit(self: *Core, code: c_int) noreturn {
        self.symbols.force_exit(code);
        std.process.exit(@intCast(code));
    }

    pub fn quitGracefully(self: *Core, code: c_int) noreturn {
        self.stopEventLoop() catch {};
        self.waitForShutdownComplete(5000) catch {};
        self.forceExit(code);
    }

    pub fn wgpuCreateSurfaceForView(self: *Core, instance_ptr: ?*anyopaque, view_ptr: ?*anyopaque) !?*anyopaque {
        const surface_ptr = self.symbols.wgpu_create_surface_for_view(instance_ptr, view_ptr);
        try self.ensureLastCallSucceeded();
        return surface_ptr;
    }

    pub fn wgpuCreateAdapterDeviceMainThread(
        self: *Core,
        instance_ptr: ?*anyopaque,
        surface_ptr: ?*anyopaque,
        out_adapter_device: ?*anyopaque,
    ) !void {
        self.symbols.wgpu_create_adapter_device_main_thread(instance_ptr, surface_ptr, out_adapter_device);
        try self.ensureLastCallSucceeded();
    }

    pub fn wgpuSurfaceConfigureMainThread(self: *Core, surface_ptr: ?*anyopaque, config_ptr: ?*anyopaque) !void {
        self.symbols.wgpu_surface_configure_main_thread(surface_ptr, config_ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn wgpuSurfaceGetCurrentTextureMainThread(self: *Core, surface_ptr: ?*anyopaque, surface_texture_ptr: ?*anyopaque) !void {
        self.symbols.wgpu_surface_get_current_texture_main_thread(surface_ptr, surface_texture_ptr);
        try self.ensureLastCallSucceeded();
    }

    pub fn wgpuSurfacePresentMainThread(self: *Core, surface_ptr: ?*anyopaque) !i32 {
        const result = self.symbols.wgpu_surface_present_main_thread(surface_ptr);
        try self.ensureLastCallSucceeded();
        return result;
    }

    pub fn runMainThread(self: *Core, app_info: AppInfo) !void {
        const identifier_z = try self.dupeZ(app_info.identifier);
        defer self.allocator.free(identifier_z);
        const name_z = try self.dupeZ(app_info.name);
        defer self.allocator.free(name_z);
        const channel_z = try self.dupeZ(app_info.channel);
        defer self.allocator.free(channel_z);

        const status = self.symbols.run_main_thread(
            identifier_z.ptr,
            name_z.ptr,
            channel_z.ptr,
            0,
        );

        if (status != 0) {
            return errorFromLastError(self.lastError());
        }
    }

    fn ensureLastCallSucceeded(self: *Core) !void {
        const message = self.lastError();
        if (message.len != 0) {
            return errorFromLastError(message);
        }
    }
};

pub fn quit(code: u8) noreturn {
    std.process.exit(code);
}

fn getHomeDirOwned(allocator: std.mem.Allocator) ![]u8 {
    return switch (builtin.os.tag) {
        .windows => std.process.getEnvVarOwned(allocator, "USERPROFILE") catch
            std.process.getEnvVarOwned(allocator, "HOME"),
        else => std.process.getEnvVarOwned(allocator, "HOME"),
    };
}

fn getAppDataDirOwned(allocator: std.mem.Allocator, home: []const u8) ![]u8 {
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(allocator, &.{ home, "Library", "Application Support" }),
        .windows => envOrJoin(allocator, "LOCALAPPDATA", &.{ home, "AppData", "Local" }),
        else => envOrJoin(allocator, "XDG_DATA_HOME", &.{ home, ".local", "share" }),
    };
}

fn getCacheDirOwned(allocator: std.mem.Allocator, home: []const u8) ![]u8 {
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(allocator, &.{ home, "Library", "Caches" }),
        .windows => envOrJoin(allocator, "LOCALAPPDATA", &.{ home, "AppData", "Local" }),
        else => envOrJoin(allocator, "XDG_CACHE_HOME", &.{ home, ".cache" }),
    };
}

fn getLogsDirOwned(allocator: std.mem.Allocator, home: []const u8) ![]u8 {
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(allocator, &.{ home, "Library", "Logs" }),
        .windows => envOrJoin(allocator, "LOCALAPPDATA", &.{ home, "AppData", "Local" }),
        else => envOrJoin(allocator, "XDG_STATE_HOME", &.{ home, ".local", "state" }),
    };
}

fn getConfigDirOwned(allocator: std.mem.Allocator, home: []const u8) ![]u8 {
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(allocator, &.{ home, "Library", "Application Support" }),
        .windows => envOrJoin(allocator, "APPDATA", &.{ home, "AppData", "Roaming" }),
        else => envOrJoin(allocator, "XDG_CONFIG_HOME", &.{ home, ".config" }),
    };
}

fn getTempDirOwned(allocator: std.mem.Allocator, home: []const u8) ![]u8 {
    return switch (builtin.os.tag) {
        .windows => blk: {
            break :blk std.process.getEnvVarOwned(allocator, "TEMP") catch
                std.process.getEnvVarOwned(allocator, "TMP") catch
                std.fs.path.join(allocator, &.{ home, "AppData", "Local", "Temp" });
        },
        else => std.process.getEnvVarOwned(allocator, "TMPDIR") catch allocator.dupe(u8, "/tmp"),
    };
}

fn getUserDirOwned(
    allocator: std.mem.Allocator,
    home: []const u8,
    mac_name: []const u8,
    win_name: []const u8,
    xdg_key: []const u8,
    fallback_name: []const u8,
) ![]u8 {
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(allocator, &.{ home, mac_name }),
        .windows => std.fs.path.join(allocator, &.{ home, win_name }),
        else => linuxXdgUserDirOwned(allocator, home, xdg_key, fallback_name),
    };
}

fn envOrJoin(allocator: std.mem.Allocator, env_name: []const u8, fallback_parts: []const []const u8) ![]u8 {
    return std.process.getEnvVarOwned(allocator, env_name) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => std.fs.path.join(allocator, fallback_parts),
        else => err,
    };
}

fn linuxXdgUserDirOwned(
    allocator: std.mem.Allocator,
    home: []const u8,
    key: []const u8,
    fallback_name: []const u8,
) ![]u8 {
    const config_path = try std.fs.path.join(allocator, &.{ home, ".config", "user-dirs.dirs" });
    defer allocator.free(config_path);

    const fallback = try std.fs.path.join(allocator, &.{ home, fallback_name });
    errdefer allocator.free(fallback);

    const file = std.fs.openFileAbsolute(config_path, .{}) catch return fallback;
    defer file.close();

    const content = file.readToEndAlloc(allocator, 64 * 1024) catch return fallback;
    defer allocator.free(content);

    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        const trimmed = std.mem.trim(u8, line, " \t\r");
        if (trimmed.len == 0 or trimmed[0] == '#') continue;

        const eq_index = std.mem.indexOfScalar(u8, trimmed, '=') orelse continue;
        const line_key = trimmed[0..eq_index];
        if (!std.mem.eql(u8, line_key, key)) continue;

        var value = trimmed[eq_index + 1 ..];
        value = std.mem.trim(u8, value, " \t\r");
        if (value.len >= 2 and value[0] == '"' and value[value.len - 1] == '"') {
            value = value[1 .. value.len - 1];
        }

        const replaced = try std.mem.replaceOwned(u8, allocator, value, "$HOME", home);
        allocator.free(fallback);
        return replaced;
    }

    return fallback;
}

fn buildAppScopedDir(allocator: std.mem.Allocator, base: []const u8, app_info: AppInfo) ![]u8 {
    if (app_info.identifier.len == 0 or app_info.channel.len == 0) {
        return allocator.dupe(u8, base);
    }
    return std.fs.path.join(allocator, &.{ base, app_info.identifier, app_info.channel });
}

fn readFileZ(allocator: std.mem.Allocator, path: []const u8) ![:0]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();

    const content = try file.readToEndAlloc(allocator, 1024 * 1024);
    defer allocator.free(content);
    return try allocator.dupeZ(u8, content);
}

fn readFileAlloc(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    const file = try std.fs.openFileAbsolute(path, .{});
    defer file.close();

    return try file.readToEndAlloc(allocator, 1024 * 1024);
}

fn parseRectJson(allocator: std.mem.Allocator, json: []const u8) !Rect {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, json, .{});
    defer parsed.deinit();

    if (parsed.value != .object) return error.InvalidRectJson;

    const x = parsed.value.object.get("x") orelse return error.InvalidRectJson;
    const y = parsed.value.object.get("y") orelse return error.InvalidRectJson;
    const width = parsed.value.object.get("width") orelse return error.InvalidRectJson;
    const height = parsed.value.object.get("height") orelse return error.InvalidRectJson;

    return .{
        .x = jsonValueToF64(x) orelse return error.InvalidRectJson,
        .y = jsonValueToF64(y) orelse return error.InvalidRectJson,
        .width = jsonValueToF64(width) orelse return error.InvalidRectJson,
        .height = jsonValueToF64(height) orelse return error.InvalidRectJson,
    };
}

fn parseJsonOwned(allocator: std.mem.Allocator, comptime T: type, json: []const u8) !T {
    var parsed = try std.json.parseFromSlice(T, allocator, json, .{});
    defer parsed.deinit();
    return parsed.value;
}

fn parseJsonSliceOwned(allocator: std.mem.Allocator, comptime T: type, json: []const u8) ![]T {
    var parsed = try std.json.parseFromSlice([]T, allocator, json, .{});
    defer parsed.deinit();
    return try allocator.dupe(T, parsed.value);
}

fn jsonValueToF64(value: std.json.Value) ?f64 {
    return switch (value) {
        .float => |float_value| float_value,
        .integer => |int_value| @floatFromInt(int_value),
        else => null,
    };
}

fn errorFromLastError(message: []const u8) anyerror {
    if (message.len == 0) {
        return error.ElectrobunCoreFailure;
    }
    std.debug.print("[electrobun-zig] core error: {s}\n", .{message});
    return error.ElectrobunCoreFailure;
}

pub fn allowAllNavigation(_: u32, _: [*:0]const u8) callconv(.C) u32 {
    return 1;
}

pub fn noopWebviewEvent(_: u32, _: [*:0]const u8, _: [*:0]const u8) callconv(.C) void {}

pub fn noopWebviewPostMessage(_: u32, _: [*:0]const u8) callconv(.C) u32 {
    return 0;
}
