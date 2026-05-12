const std = @import("std");
const builtin = @import("builtin");

const allocator = std.heap.c_allocator;

const StartEventLoopFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8) callconv(.C) void;
const ForceExitFn = *const fn (c_int) callconv(.C) void;
const WindowPtr = ?*anyopaque;
const WebviewPtr = ?*anyopaque;
const WgpuViewPtr = ?*anyopaque;
const TrayPtr = ?*anyopaque;
const WindowCloseHandler = *const fn (u32) callconv(.C) void;
const WindowMoveHandler = *const fn (u32, f64, f64) callconv(.C) void;
const WindowResizeHandler = *const fn (u32, f64, f64, f64, f64) callconv(.C) void;
const WindowFocusHandler = *const fn (u32) callconv(.C) void;
const WindowBlurHandler = *const fn (u32) callconv(.C) void;
const WindowKeyHandler = *const fn (u32, u32, u32, u32, u32) callconv(.C) void;
const DecideNavigationHandler = *const fn (u32, [*:0]const u8) callconv(.C) u32;
const WebviewEventHandler = *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) void;
const WebviewPostMessageHandler = *const fn (u32, [*:0]const u8) callconv(.C) u32;
const StatusItemHandler = *const fn (u32, [*:0]const u8) callconv(.C) void;
const GlobalShortcutHandler = *const fn ([*:0]const u8) callconv(.C) void;
const QuitRequestedHandler = *const fn () callconv(.C) void;
const URLOpenHandler = *const fn ([*:0]const u8) callconv(.C) void;
const AppReopenHandler = *const fn () callconv(.C) void;

const TrayState = struct {
    title: [:0]u8,
    image: [:0]u8,
    menu_config: ?[:0]u8,
    is_template: bool,
    width: u32,
    height: u32,
    handler: ?StatusItemHandler,
    ptr: TrayPtr,
    visible: bool,
};

const WindowState = struct {
    ptr: WindowPtr,
    transparent: bool,
    close_handler: ?WindowCloseHandler,
    move_handler: ?WindowMoveHandler,
    resize_handler: ?WindowResizeHandler,
    focus_handler: ?WindowFocusHandler,
    blur_handler: ?WindowBlurHandler,
    key_handler: ?WindowKeyHandler,
};

const WebviewState = struct {
    ptr: WebviewPtr,
    host_webview_id: ?u32,
};

const WgpuViewState = struct {
    ptr: WgpuViewPtr,
};

const WebviewRuntimeState = struct {
    rpc_port: u32 = 0,
    preload_script: ?[:0]u8 = null,
    preload_script_sandboxed: ?[:0]u8 = null,
    configured: bool = false,
};

const NativeWrapperState = struct {
    lib: std.DynLib,
    path: []u8,
    start_event_loop: StartEventLoopFn,
    force_exit: ForceExitFn,
};

var last_error: ?[:0]u8 = null;
var native_wrapper_loaded = false;
var native_wrapper_state: NativeWrapperState = undefined;
var next_tray_id: u32 = 1;
var next_window_id: u32 = 1;
var next_webview_id: u32 = 1;
var next_wgpu_view_id: u32 = 1;
var tray_registry = std.AutoHashMap(u32, TrayState).init(allocator);
var window_registry = std.AutoHashMap(u32, WindowState).init(allocator);
var window_registry_mutex: std.Thread.Mutex = .{};
var webview_registry = std.AutoHashMap(u32, WebviewState).init(allocator);
var webview_registry_mutex: std.Thread.Mutex = .{};
var wgpu_view_registry = std.AutoHashMap(u32, WgpuViewState).init(allocator);
var wgpu_view_registry_mutex: std.Thread.Mutex = .{};
var webview_runtime_state = WebviewRuntimeState{};

const empty_rect_json: [*:0]const u8 = "{\"x\":0,\"y\":0,\"width\":0,\"height\":0}";

fn clearLastError() void {
    if (last_error) |message| {
        allocator.free(message);
        last_error = null;
    }
}

fn setLastError(comptime fmt: []const u8, args: anytype) void {
    clearLastError();
    last_error = std.fmt.allocPrintZ(allocator, fmt, args) catch null;
}

fn dupeZ(input: [*:0]const u8) ![:0]u8 {
    return allocator.dupeZ(u8, std.mem.span(input));
}

fn replaceOwnedZ(target: *[:0]u8, input: [*:0]const u8) bool {
    const next = dupeZ(input) catch |err| {
        setLastError("Failed to allocate string: {s}", .{@errorName(err)});
        return false;
    };

    allocator.free(target.*);
    target.* = next;
    return true;
}

fn replaceOptionalOwnedZ(target: *?[:0]u8, input: [*:0]const u8) bool {
    const next = dupeZ(input) catch |err| {
        setLastError("Failed to allocate string: {s}", .{@errorName(err)});
        return false;
    };

    if (target.*) |current| {
        allocator.free(current);
    }
    target.* = next;
    return true;
}

fn freeTrayState(state: *TrayState) void {
    allocator.free(state.title);
    allocator.free(state.image);
    if (state.menu_config) |menu_config| {
        allocator.free(menu_config);
    }
}

export fn electrobun_core_last_error() [*:0]const u8 {
    if (last_error) |message| {
        return message.ptr;
    }
    return "";
}

fn ensureWebviewRuntimeConfigured() bool {
    if (!webview_runtime_state.configured) {
        setLastError("Webview runtime is not configured", .{});
        return false;
    }

    if (webview_runtime_state.preload_script == null or webview_runtime_state.preload_script_sandboxed == null) {
        setLastError("Webview runtime preload scripts are not configured", .{});
        return false;
    }

    return true;
}

fn buildElectrobunPreload(
    webview_id: u32,
    window_id: u32,
    secret_key: [*:0]const u8,
    sandbox: bool,
) ?[:0]u8 {
    if (!ensureWebviewRuntimeConfigured()) {
        return null;
    }

    if (sandbox) {
        const sandboxed_preload_script = webview_runtime_state.preload_script_sandboxed.?;
        return std.fmt.allocPrintZ(
            allocator,
            \\window.__electrobunWebviewId = {d};
            \\window.__electrobunWindowId = {d};
            \\window.__electrobunEventBridge = window.__electrobunEventBridge || window.webkit?.messageHandlers?.eventBridge || window.eventBridge || window.chrome?.webview?.hostObjects?.eventBridge;
            \\window.__electrobunInternalBridge = window.__electrobunInternalBridge || window.webkit?.messageHandlers?.internalBridge || window.internalBridge || window.chrome?.webview?.hostObjects?.internalBridge;
            \\{s}
        ,
            .{ webview_id, window_id, sandboxed_preload_script },
        ) catch |err| {
            setLastError("Failed to build sandboxed preload script: {s}", .{@errorName(err)});
            return null;
        };
    }

    const preload_script = webview_runtime_state.preload_script.?;
    return std.fmt.allocPrintZ(
        allocator,
        \\window.__electrobunWebviewId = {d};
        \\window.__electrobunWindowId = {d};
        \\window.__electrobunRpcSocketPort = {d};
        \\window.__electrobunSecretKeyBytes = [{s}];
        \\window.__electrobunEventBridge = window.__electrobunEventBridge || window.webkit?.messageHandlers?.eventBridge || window.eventBridge || window.chrome?.webview?.hostObjects?.eventBridge;
        \\window.__electrobunInternalBridge = window.__electrobunInternalBridge || window.webkit?.messageHandlers?.internalBridge || window.internalBridge || window.chrome?.webview?.hostObjects?.internalBridge;
        \\window.__electrobunBunBridge = window.__electrobunBunBridge || window.webkit?.messageHandlers?.bunBridge || window.bunBridge || window.chrome?.webview?.hostObjects?.bunBridge;
        \\{s}
    ,
        .{
            webview_id,
            window_id,
            webview_runtime_state.rpc_port,
            std.mem.span(secret_key),
            preload_script,
        },
    ) catch |err| {
        setLastError("Failed to build preload script: {s}", .{@errorName(err)});
        return null;
    };
}

export fn configureWebviewRuntime(
    rpc_port: u32,
    preload_script: [*:0]const u8,
    preload_script_sandboxed: [*:0]const u8,
) bool {
    clearLastError();

    webview_runtime_state.rpc_port = rpc_port;

    if (!replaceOptionalOwnedZ(&webview_runtime_state.preload_script, preload_script)) {
        return false;
    }

    if (!replaceOptionalOwnedZ(
        &webview_runtime_state.preload_script_sandboxed,
        preload_script_sandboxed,
    )) {
        return false;
    }

    webview_runtime_state.configured = true;
    return true;
}

fn nativeWrapperFileName() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "libNativeWrapper.dll",
        .macos => "libNativeWrapper.dylib",
        else => "libNativeWrapper.so",
    };
}

fn resolveNativeWrapperPath() ![]u8 {
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);

    const exe_dir = std.fs.path.dirname(exe_path) orelse return error.InvalidExePath;
    return std.fs.path.join(allocator, &.{ exe_dir, nativeWrapperFileName() });
}

fn ensureNativeWrapperLoaded() bool {
    if (native_wrapper_loaded) {
        return true;
    }

    const native_wrapper_path = resolveNativeWrapperPath() catch |err| {
        setLastError("Failed to resolve native wrapper path: {s}", .{@errorName(err)});
        return false;
    };

    var native_wrapper = std.DynLib.open(native_wrapper_path) catch |err| {
        setLastError("Failed to open native wrapper at {s}: {s}", .{
            native_wrapper_path,
            @errorName(err),
        });
        allocator.free(native_wrapper_path);
        return false;
    };

    const start_event_loop = native_wrapper.lookup(
        StartEventLoopFn,
        "startEventLoop",
    ) orelse {
        setLastError("Native wrapper is missing startEventLoop", .{});
        native_wrapper.close();
        allocator.free(native_wrapper_path);
        return false;
    };

    const force_exit = native_wrapper.lookup(
        ForceExitFn,
        "forceExit",
    ) orelse {
        setLastError("Native wrapper is missing forceExit", .{});
        native_wrapper.close();
        allocator.free(native_wrapper_path);
        return false;
    };

    native_wrapper_state = .{
        .lib = native_wrapper,
        .path = native_wrapper_path,
        .start_event_loop = start_event_loop,
        .force_exit = force_exit,
    };
    native_wrapper_loaded = true;
    return true;
}

fn lookupNativeSymbol(comptime T: type, comptime name: [:0]const u8) ?T {
    if (!ensureNativeWrapperLoaded()) {
        return null;
    }

    return native_wrapper_state.lib.lookup(T, name) orelse {
        setLastError("Native wrapper is missing {s}", .{name});
        return null;
    };
}

fn createNativeTrayForState(tray_id: u32, state: *TrayState) bool {
    const CreateNativeTrayFn = *const fn (
        u32,
        [*:0]const u8,
        [*:0]const u8,
        bool,
        u32,
        u32,
        ?StatusItemHandler,
    ) callconv(.C) TrayPtr;
    const SetNativeTrayMenuFn = *const fn (TrayPtr, [*:0]const u8) callconv(.C) void;

    const create_native_tray = lookupNativeSymbol(CreateNativeTrayFn, "createTray") orelse return false;
    const tray_ptr = create_native_tray(
        tray_id,
        state.title.ptr,
        state.image.ptr,
        state.is_template,
        state.width,
        state.height,
        state.handler,
    );

    if (tray_ptr == null) {
        setLastError("Failed to create tray", .{});
        return false;
    }

    state.ptr = tray_ptr;
    state.visible = true;

    if (state.menu_config) |menu_config| {
        const set_native_tray_menu = lookupNativeSymbol(SetNativeTrayMenuFn, "setTrayMenu") orelse return false;
        set_native_tray_menu(tray_ptr, menu_config.ptr);
    }

    return true;
}

fn hideNativeTray(state: *TrayState) void {
    const RemoveNativeTrayFn = *const fn (TrayPtr) callconv(.C) void;

    if (state.ptr) |tray_ptr| {
        const remove_native_tray = lookupNativeSymbol(RemoveNativeTrayFn, "removeTray") orelse {
            state.ptr = null;
            state.visible = false;
            return;
        };
        remove_native_tray(tray_ptr);
    }

    state.ptr = null;
    state.visible = false;
}

fn lookupWindowState(window_id: u32) ?WindowState {
    window_registry_mutex.lock();
    defer window_registry_mutex.unlock();
    return window_registry.get(window_id);
}

fn lookupWindowPtr(window_id: u32) WindowPtr {
    const state = lookupWindowState(window_id) orelse return null;
    return state.ptr;
}

fn requireWindowPtr(window_id: u32) WindowPtr {
    const window_ptr = lookupWindowPtr(window_id);
    if (window_ptr == null) {
        setLastError("Window {d} not found", .{window_id});
    }
    return window_ptr;
}

fn lookupWebviewState(webview_id: u32) ?WebviewState {
    webview_registry_mutex.lock();
    defer webview_registry_mutex.unlock();
    return webview_registry.get(webview_id);
}

fn lookupWebviewPtr(webview_id: u32) WebviewPtr {
    const state = lookupWebviewState(webview_id) orelse return null;
    return state.ptr;
}

fn lookupWebviewHostId(webview_id: u32) ?u32 {
    const state = lookupWebviewState(webview_id) orelse return null;
    return state.host_webview_id;
}

fn requireWebviewPtr(webview_id: u32) WebviewPtr {
    const webview_ptr = lookupWebviewPtr(webview_id);
    if (webview_ptr == null) {
        setLastError("Webview {d} not found", .{webview_id});
    }
    return webview_ptr;
}

fn lookupWgpuViewState(wgpu_view_id: u32) ?WgpuViewState {
    wgpu_view_registry_mutex.lock();
    defer wgpu_view_registry_mutex.unlock();
    return wgpu_view_registry.get(wgpu_view_id);
}

fn lookupWgpuViewPtr(wgpu_view_id: u32) WgpuViewPtr {
    const state = lookupWgpuViewState(wgpu_view_id) orelse return null;
    return state.ptr;
}

fn requireWgpuViewPtr(wgpu_view_id: u32) WgpuViewPtr {
    const wgpu_view_ptr = lookupWgpuViewPtr(wgpu_view_id);
    if (wgpu_view_ptr == null) {
        setLastError("WGPUView {d} not found", .{wgpu_view_id});
    }
    return wgpu_view_ptr;
}

fn allocateOwnedJavascriptString(
    comptime fmt: []const u8,
    args: anytype,
) ?[:0]u8 {
    return std.fmt.allocPrintZ(allocator, fmt, args) catch |err| {
        setLastError("Failed to allocate javascript string: {s}", .{@errorName(err)});
        return null;
    };
}

fn quoteJavascriptString(value: [*:0]const u8) ?[]u8 {
    return std.json.stringifyAlloc(allocator, std.mem.span(value), .{}) catch |err| {
        setLastError("Failed to encode javascript string: {s}", .{@errorName(err)});
        return null;
    };
}

fn buildHostWebviewEventJavascript(
    webview_id: u32,
    event_name: [*:0]const u8,
    detail: [*:0]const u8,
) ?[:0]u8 {
    const encoded_event_name = quoteJavascriptString(event_name) orelse return null;
    defer allocator.free(encoded_event_name);

    const event_name_slice = std.mem.span(event_name);
    if (std.mem.eql(u8, event_name_slice, "new-window-open") or std.mem.eql(u8, event_name_slice, "host-message")) {
        return allocateOwnedJavascriptString(
            "document.querySelector('#electrobun-webview-{d}').emit({s}, {s});",
            .{ webview_id, encoded_event_name, std.mem.span(detail) },
        );
    }

    const encoded_detail = quoteJavascriptString(detail) orelse return null;
    defer allocator.free(encoded_detail);

    return allocateOwnedJavascriptString(
        "document.querySelector('#electrobun-webview-{d}').emit({s}, {s});",
        .{ webview_id, encoded_event_name, encoded_detail },
    );
}

fn buildInternalMessageJavascript(message_json: [*:0]const u8) ?[:0]u8 {
    return allocateOwnedJavascriptString(
        "window.__electrobun.receiveInternalMessageFromBun({s});",
        .{std.mem.span(message_json)},
    );
}

fn windowCloseTrampoline(window_id: u32) callconv(.C) void {
    var close_handler: ?WindowCloseHandler = null;

    window_registry_mutex.lock();
    if (window_registry.fetchRemove(window_id)) |removed| {
        close_handler = removed.value.close_handler;
    }
    window_registry_mutex.unlock();

    if (close_handler) |handler| {
        handler(window_id);
    }
}

fn windowMoveTrampoline(window_id: u32, x: f64, y: f64) callconv(.C) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.move_handler) |handler| {
        handler(window_id, x, y);
    }
}

fn windowResizeTrampoline(window_id: u32, x: f64, y: f64, width: f64, height: f64) callconv(.C) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.resize_handler) |handler| {
        handler(window_id, x, y, width, height);
    }
}

fn windowFocusTrampoline(window_id: u32) callconv(.C) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.focus_handler) |handler| {
        handler(window_id);
    }
}

fn windowBlurTrampoline(window_id: u32) callconv(.C) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.blur_handler) |handler| {
        handler(window_id);
    }
}

fn windowKeyTrampoline(window_id: u32, key_code: u32, modifiers: u32, is_down: u32, is_repeat: u32) callconv(.C) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.key_handler) |handler| {
        handler(window_id, key_code, modifiers, is_down, is_repeat);
    }
}

export fn electrobun_core_run_main_thread(
    identifier: [*:0]const u8,
    name: [*:0]const u8,
    channel: [*:0]const u8,
    exit_code: c_int,
) c_int {
    clearLastError();

    if (!ensureNativeWrapperLoaded()) {
        return 1;
    }

    native_wrapper_state.start_event_loop(identifier, name, channel);
    native_wrapper_state.force_exit(exit_code);
    return 0;
}

export fn getWindowStyle(
    borderless: bool,
    titled: bool,
    closable: bool,
    miniaturizable: bool,
    resizable: bool,
    unified_title_and_toolbar: bool,
    full_screen: bool,
    full_size_content_view: bool,
    utility_window: bool,
    doc_modal_window: bool,
    nonactivating_panel: bool,
    hud_window: bool,
) u32 {
    const GetWindowStyleFn = *const fn (
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
    ) callconv(.C) u32;

    const get_window_style = lookupNativeSymbol(GetWindowStyleFn, "getWindowStyle") orelse return 0;
    return get_window_style(
        borderless,
        titled,
        closable,
        miniaturizable,
        resizable,
        unified_title_and_toolbar,
        full_screen,
        full_size_content_view,
        utility_window,
        doc_modal_window,
        nonactivating_panel,
        hud_window,
    );
}

export fn createWindow(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    style_mask: u32,
    title_bar_style: [*:0]const u8,
    transparent: bool,
    title: [*:0]const u8,
    hidden: bool,
    activate: bool,
    traffic_light_offset_x: f64,
    traffic_light_offset_y: f64,
    close_handler: ?WindowCloseHandler,
    move_handler: ?WindowMoveHandler,
    resize_handler: ?WindowResizeHandler,
    focus_handler: ?WindowFocusHandler,
    blur_handler: ?WindowBlurHandler,
    key_handler: ?WindowKeyHandler,
) u32 {
    clearLastError();

    const CreateWindowFn = *const fn (
        u32,
        f64,
        f64,
        f64,
        f64,
        u32,
        [*:0]const u8,
        bool,
        f64,
        f64,
        ?WindowCloseHandler,
        ?WindowMoveHandler,
        ?WindowResizeHandler,
        ?WindowFocusHandler,
        ?WindowBlurHandler,
        ?WindowKeyHandler,
    ) callconv(.C) WindowPtr;
    const SetWindowTitleFn = *const fn (WindowPtr, [*:0]const u8) callconv(.C) void;
    const ShowWindowFn = *const fn (WindowPtr, bool) callconv(.C) void;

    const create_window = lookupNativeSymbol(
        CreateWindowFn,
        "createWindowWithFrameAndStyleFromWorker",
    ) orelse return 0;
    const set_window_title = lookupNativeSymbol(SetWindowTitleFn, "setWindowTitle") orelse return 0;
    const show_window = lookupNativeSymbol(ShowWindowFn, "showWindow") orelse return 0;

    window_registry_mutex.lock();
    const start_id = next_window_id;
    var window_id = next_window_id;

    while (window_id == 0 or window_registry.contains(window_id)) {
        window_id +%= 1;
        if (window_id == 0) {
            window_id = 1;
        }
        if (window_id == start_id) {
            window_registry_mutex.unlock();
            setLastError("Failed to allocate window id", .{});
            return 0;
        }
    }

    next_window_id = window_id +% 1;
    if (next_window_id == 0) {
        next_window_id = 1;
    }

    window_registry.put(window_id, .{
        .ptr = null,
        .transparent = transparent,
        .close_handler = close_handler,
        .move_handler = move_handler,
        .resize_handler = resize_handler,
        .focus_handler = focus_handler,
        .blur_handler = blur_handler,
        .key_handler = key_handler,
    }) catch |err| {
        window_registry_mutex.unlock();
        setLastError("Failed to store window state: {s}", .{@errorName(err)});
        return 0;
    };
    window_registry_mutex.unlock();

    const window_ptr = create_window(
        window_id,
        x,
        y,
        width,
        height,
        style_mask,
        title_bar_style,
        transparent,
        traffic_light_offset_x,
        traffic_light_offset_y,
        windowCloseTrampoline,
        windowMoveTrampoline,
        windowResizeTrampoline,
        windowFocusTrampoline,
        windowBlurTrampoline,
        windowKeyTrampoline,
    );

    if (window_ptr == null) {
        window_registry_mutex.lock();
        _ = window_registry.remove(window_id);
        window_registry_mutex.unlock();
        setLastError("Failed to create window", .{});
        return 0;
    }

    window_registry_mutex.lock();
    const state = window_registry.getPtr(window_id) orelse {
        window_registry_mutex.unlock();
        setLastError("Window {d} disappeared during creation", .{window_id});
        return 0;
    };
    state.ptr = window_ptr;
    window_registry_mutex.unlock();

    set_window_title(window_ptr, title);
    if (!hidden) {
        show_window(window_ptr, activate);
    }

    return window_id;
}

export fn getWindowPointer(window_id: u32) WindowPtr {
    clearLastError();
    return lookupWindowPtr(window_id);
}

export fn setWindowTitle(window_id: u32, title: [*:0]const u8) void {
    const SetWindowTitleFn = *const fn (WindowPtr, [*:0]const u8) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_title = lookupNativeSymbol(SetWindowTitleFn, "setWindowTitle") orelse return;
    set_window_title(window, title);
}

export fn minimizeWindow(window_id: u32) void {
    const MinimizeWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const minimize_window = lookupNativeSymbol(MinimizeWindowFn, "minimizeWindow") orelse return;
    minimize_window(window);
}

export fn restoreWindow(window_id: u32) void {
    const RestoreWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const restore_window = lookupNativeSymbol(RestoreWindowFn, "restoreWindow") orelse return;
    restore_window(window);
}

export fn isWindowMinimized(window_id: u32) bool {
    const IsWindowMinimizedFn = *const fn (WindowPtr) callconv(.C) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_minimized = lookupNativeSymbol(IsWindowMinimizedFn, "isWindowMinimized") orelse return false;
    return is_window_minimized(window);
}

export fn maximizeWindow(window_id: u32) void {
    const MaximizeWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const maximize_window = lookupNativeSymbol(MaximizeWindowFn, "maximizeWindow") orelse return;
    maximize_window(window);
}

export fn unmaximizeWindow(window_id: u32) void {
    const UnmaximizeWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const unmaximize_window = lookupNativeSymbol(UnmaximizeWindowFn, "unmaximizeWindow") orelse return;
    unmaximize_window(window);
}

export fn isWindowMaximized(window_id: u32) bool {
    const IsWindowMaximizedFn = *const fn (WindowPtr) callconv(.C) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_maximized = lookupNativeSymbol(IsWindowMaximizedFn, "isWindowMaximized") orelse return false;
    return is_window_maximized(window);
}

export fn setWindowFullScreen(window_id: u32, full_screen: bool) void {
    const SetWindowFullScreenFn = *const fn (WindowPtr, bool) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_full_screen = lookupNativeSymbol(SetWindowFullScreenFn, "setWindowFullScreen") orelse return;
    set_window_full_screen(window, full_screen);
}

export fn isWindowFullScreen(window_id: u32) bool {
    const IsWindowFullScreenFn = *const fn (WindowPtr) callconv(.C) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_full_screen = lookupNativeSymbol(IsWindowFullScreenFn, "isWindowFullScreen") orelse return false;
    return is_window_full_screen(window);
}

export fn setWindowAlwaysOnTop(window_id: u32, always_on_top: bool) void {
    const SetWindowAlwaysOnTopFn = *const fn (WindowPtr, bool) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_always_on_top = lookupNativeSymbol(SetWindowAlwaysOnTopFn, "setWindowAlwaysOnTop") orelse return;
    set_window_always_on_top(window, always_on_top);
}

export fn isWindowAlwaysOnTop(window_id: u32) bool {
    const IsWindowAlwaysOnTopFn = *const fn (WindowPtr) callconv(.C) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_always_on_top = lookupNativeSymbol(IsWindowAlwaysOnTopFn, "isWindowAlwaysOnTop") orelse return false;
    return is_window_always_on_top(window);
}

export fn setWindowVisibleOnAllWorkspaces(window_id: u32, visible_on_all_workspaces: bool) void {
    const SetWindowVisibleOnAllWorkspacesFn = *const fn (WindowPtr, bool) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_visible_on_all_workspaces = lookupNativeSymbol(
        SetWindowVisibleOnAllWorkspacesFn,
        "setWindowVisibleOnAllWorkspaces",
    ) orelse return;
    set_window_visible_on_all_workspaces(window, visible_on_all_workspaces);
}

export fn isWindowVisibleOnAllWorkspaces(window_id: u32) bool {
    const IsWindowVisibleOnAllWorkspacesFn = *const fn (WindowPtr) callconv(.C) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_visible_on_all_workspaces = lookupNativeSymbol(
        IsWindowVisibleOnAllWorkspacesFn,
        "isWindowVisibleOnAllWorkspaces",
    ) orelse return false;
    return is_window_visible_on_all_workspaces(window);
}

export fn setWindowButtonPosition(window_id: u32, x: f64, y: f64) void {
    const SetWindowButtonPositionFn = *const fn (WindowPtr, f64, f64) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_button_position = lookupNativeSymbol(
        SetWindowButtonPositionFn,
        "setWindowButtonPosition",
    ) orelse return;
    set_window_button_position(window, x, y);
}

export fn showWindow(window_id: u32, activate: bool) void {
    const ShowWindowFn = *const fn (WindowPtr, bool) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const show_window = lookupNativeSymbol(ShowWindowFn, "showWindow") orelse return;
    show_window(window, activate);
}

export fn activateWindow(window_id: u32) void {
    const ActivateWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const activate_window = lookupNativeSymbol(ActivateWindowFn, "activateWindow") orelse return;
    activate_window(window);
}

export fn hideWindow(window_id: u32) void {
    const HideWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const hide_window = lookupNativeSymbol(HideWindowFn, "hideWindow") orelse return;
    hide_window(window);
}

export fn closeWindow(window_id: u32) void {
    const CloseWindowFn = *const fn (WindowPtr) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const close_window = lookupNativeSymbol(CloseWindowFn, "closeWindow") orelse return;
    close_window(window);
}

export fn setWindowPosition(window_id: u32, x: f64, y: f64) void {
    const SetWindowPositionFn = *const fn (WindowPtr, f64, f64) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_position = lookupNativeSymbol(SetWindowPositionFn, "setWindowPosition") orelse return;
    set_window_position(window, x, y);
}

export fn setWindowSize(window_id: u32, width: f64, height: f64) void {
    const SetWindowSizeFn = *const fn (WindowPtr, f64, f64) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_size = lookupNativeSymbol(SetWindowSizeFn, "setWindowSize") orelse return;
    set_window_size(window, width, height);
}

export fn setWindowFrame(window_id: u32, x: f64, y: f64, width: f64, height: f64) void {
    const SetWindowFrameFn = *const fn (WindowPtr, f64, f64, f64, f64) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_frame = lookupNativeSymbol(SetWindowFrameFn, "setWindowFrame") orelse return;
    set_window_frame(window, x, y, width, height);
}

export fn getWindowFrame(
    window_id: u32,
    x: *f64,
    y: *f64,
    width: *f64,
    height: *f64,
) void {
    const GetWindowFrameFn = *const fn (WindowPtr, *f64, *f64, *f64, *f64) callconv(.C) void;
    const window = requireWindowPtr(window_id) orelse return;
    const get_window_frame = lookupNativeSymbol(GetWindowFrameFn, "getWindowFrame") orelse return;
    get_window_frame(window, x, y, width, height);
}

export fn createWebview(
    window_id: u32,
    host_webview_id: u32,
    renderer: [*:0]const u8,
    url: [*:0]const u8,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    auto_resize: bool,
    partition_identifier: [*:0]const u8,
    navigation_callback: ?DecideNavigationHandler,
    webview_event_handler: ?WebviewEventHandler,
    event_bridge_handler: ?WebviewPostMessageHandler,
    bun_bridge_handler: ?WebviewPostMessageHandler,
    internal_bridge_handler: ?WebviewPostMessageHandler,
    secret_key: [*:0]const u8,
    custom_preload_script: [*:0]const u8,
    views_root: [*:0]const u8,
    sandbox: bool,
    start_transparent: bool,
    start_passthrough: bool,
) u32 {
    clearLastError();

    const SetNextWebviewFlagsFn = *const fn (bool, bool) callconv(.C) void;
    const InitWebviewFn = *const fn (
        u32,
        WindowPtr,
        [*:0]const u8,
        [*:0]const u8,
        f64,
        f64,
        f64,
        f64,
        bool,
        [*:0]const u8,
        ?DecideNavigationHandler,
        ?WebviewEventHandler,
        ?WebviewPostMessageHandler,
        ?WebviewPostMessageHandler,
        ?WebviewPostMessageHandler,
        [*:0]const u8,
        [*:0]const u8,
        [*:0]const u8,
        bool,
        bool,
    ) callconv(.C) WebviewPtr;

    const window_state = lookupWindowState(window_id) orelse {
        setLastError("Window {d} not found", .{window_id});
        return 0;
    };
    const window = window_state.ptr orelse {
        setLastError("Window {d} not found", .{window_id});
        return 0;
    };
    const set_next_webview_flags = lookupNativeSymbol(SetNextWebviewFlagsFn, "setNextWebviewFlags") orelse return 0;
    const init_webview = lookupNativeSymbol(InitWebviewFn, "initWebview") orelse return 0;

    webview_registry_mutex.lock();
    const start_id = next_webview_id;
    var webview_id = next_webview_id;

    while (webview_id == 0 or webview_registry.contains(webview_id)) {
        webview_id +%= 1;
        if (webview_id == 0) {
            webview_id = 1;
        }
        if (webview_id == start_id) {
            webview_registry_mutex.unlock();
            setLastError("Failed to allocate webview id", .{});
            return 0;
        }
    }

    next_webview_id = webview_id +% 1;
    if (next_webview_id == 0) {
        next_webview_id = 1;
    }

    webview_registry.put(webview_id, .{
        .ptr = null,
        .host_webview_id = if (host_webview_id == 0) null else host_webview_id,
    }) catch |err| {
        webview_registry_mutex.unlock();
        setLastError("Failed to store webview state: {s}", .{@errorName(err)});
        return 0;
    };
    webview_registry_mutex.unlock();

    const electrobun_preload_script = buildElectrobunPreload(
        webview_id,
        window_id,
        secret_key,
        sandbox,
    ) orelse {
        webview_registry_mutex.lock();
        _ = webview_registry.remove(webview_id);
        webview_registry_mutex.unlock();
        return 0;
    };
    defer allocator.free(electrobun_preload_script);

    set_next_webview_flags(start_transparent, start_passthrough);

    const webview_ptr = init_webview(
        webview_id,
        window,
        renderer,
        url,
        x,
        y,
        width,
        height,
        auto_resize,
        partition_identifier,
        navigation_callback,
        webview_event_handler,
        event_bridge_handler,
        bun_bridge_handler,
        internal_bridge_handler,
        electrobun_preload_script.ptr,
        custom_preload_script,
        views_root,
        window_state.transparent,
        sandbox,
    );

    if (webview_ptr == null) {
        webview_registry_mutex.lock();
        _ = webview_registry.remove(webview_id);
        webview_registry_mutex.unlock();
        setLastError("Failed to create webview", .{});
        return 0;
    }

    webview_registry_mutex.lock();
    const state = webview_registry.getPtr(webview_id) orelse {
        webview_registry_mutex.unlock();
        setLastError("Webview {d} disappeared during creation", .{webview_id});
        return 0;
    };
    state.ptr = webview_ptr;
    webview_registry_mutex.unlock();

    return webview_id;
}

export fn getWebviewPointer(webview_id: u32) WebviewPtr {
    clearLastError();
    return lookupWebviewPtr(webview_id);
}

export fn resizeWebview(
    webview_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    masks_json: [*:0]const u8,
) void {
    clearLastError();
    const ResizeWebviewFn = *const fn (WebviewPtr, f64, f64, f64, f64, [*:0]const u8) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const resize_webview = lookupNativeSymbol(ResizeWebviewFn, "resizeWebview") orelse return;
    resize_webview(webview, x, y, width, height, masks_json);
}

export fn loadURLInWebView(webview_id: u32, url: [*:0]const u8) void {
    clearLastError();
    const LoadURLInWebViewFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const load_url_in_webview = lookupNativeSymbol(LoadURLInWebViewFn, "loadURLInWebView") orelse return;
    load_url_in_webview(webview, url);
}

export fn loadHTMLInWebView(webview_id: u32, html: [*:0]const u8) void {
    clearLastError();
    const LoadHTMLInWebViewFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const load_html_in_webview = lookupNativeSymbol(LoadHTMLInWebViewFn, "loadHTMLInWebView") orelse return;
    load_html_in_webview(webview, html);
}

export fn updatePreloadScriptToWebView(
    webview_id: u32,
    script_identifier: [*:0]const u8,
    script: [*:0]const u8,
    all_frames: bool,
) void {
    clearLastError();
    const UpdatePreloadScriptToWebViewFn = *const fn (WebviewPtr, [*:0]const u8, [*:0]const u8, bool) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const update_preload_script_to_webview = lookupNativeSymbol(
        UpdatePreloadScriptToWebViewFn,
        "updatePreloadScriptToWebView",
    ) orelse return;
    update_preload_script_to_webview(webview, script_identifier, script, all_frames);
}

export fn webviewCanGoBack(webview_id: u32) bool {
    clearLastError();
    const WebviewCanGoBackFn = *const fn (WebviewPtr) callconv(.C) bool;
    const webview = lookupWebviewPtr(webview_id) orelse return false;
    const webview_can_go_back = lookupNativeSymbol(WebviewCanGoBackFn, "webviewCanGoBack") orelse return false;
    return webview_can_go_back(webview);
}

export fn webviewCanGoForward(webview_id: u32) bool {
    clearLastError();
    const WebviewCanGoForwardFn = *const fn (WebviewPtr) callconv(.C) bool;
    const webview = lookupWebviewPtr(webview_id) orelse return false;
    const webview_can_go_forward = lookupNativeSymbol(WebviewCanGoForwardFn, "webviewCanGoForward") orelse return false;
    return webview_can_go_forward(webview);
}

export fn webviewGoBack(webview_id: u32) void {
    clearLastError();
    const WebviewGoBackFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_go_back = lookupNativeSymbol(WebviewGoBackFn, "webviewGoBack") orelse return;
    webview_go_back(webview);
}

export fn webviewGoForward(webview_id: u32) void {
    clearLastError();
    const WebviewGoForwardFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_go_forward = lookupNativeSymbol(WebviewGoForwardFn, "webviewGoForward") orelse return;
    webview_go_forward(webview);
}

export fn webviewReload(webview_id: u32) void {
    clearLastError();
    const WebviewReloadFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_reload = lookupNativeSymbol(WebviewReloadFn, "webviewReload") orelse return;
    webview_reload(webview);
}

export fn webviewRemove(webview_id: u32) void {
    clearLastError();
    const WebviewRemoveFn = *const fn (WebviewPtr) callconv(.C) void;

    webview_registry_mutex.lock();
    const removed = webview_registry.fetchRemove(webview_id);
    webview_registry_mutex.unlock();

    const webview = if (removed) |entry| entry.value.ptr else null;
    if (webview == null) {
        return;
    }

    const webview_remove = lookupNativeSymbol(WebviewRemoveFn, "webviewRemove") orelse return;
    webview_remove(webview);
}

export fn setWebviewHTMLContent(webview_id: u32, html: [*:0]const u8) void {
    clearLastError();
    const SetWebviewHTMLContentFn = *const fn (u32, [*:0]const u8) callconv(.C) void;
    const set_webview_html_content = lookupNativeSymbol(SetWebviewHTMLContentFn, "setWebviewHTMLContent") orelse return;
    set_webview_html_content(webview_id, html);
}

export fn webviewSetTransparent(webview_id: u32, transparent: bool) void {
    clearLastError();
    const WebviewSetTransparentFn = *const fn (WebviewPtr, bool) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_transparent = lookupNativeSymbol(WebviewSetTransparentFn, "webviewSetTransparent") orelse return;
    webview_set_transparent(webview, transparent);
}

export fn webviewSetPassthrough(webview_id: u32, passthrough: bool) void {
    clearLastError();
    const WebviewSetPassthroughFn = *const fn (WebviewPtr, bool) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_passthrough = lookupNativeSymbol(WebviewSetPassthroughFn, "webviewSetPassthrough") orelse return;
    webview_set_passthrough(webview, passthrough);
}

export fn webviewSetHidden(webview_id: u32, hidden: bool) void {
    clearLastError();
    const WebviewSetHiddenFn = *const fn (WebviewPtr, bool) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_hidden = lookupNativeSymbol(WebviewSetHiddenFn, "webviewSetHidden") orelse return;
    webview_set_hidden(webview, hidden);
}

export fn setWebviewNavigationRules(webview_id: u32, rules_json: [*:0]const u8) void {
    clearLastError();
    const SetWebviewNavigationRulesFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const set_webview_navigation_rules = lookupNativeSymbol(
        SetWebviewNavigationRulesFn,
        "setWebviewNavigationRules",
    ) orelse return;
    set_webview_navigation_rules(webview, rules_json);
}

export fn webviewFindInPage(
    webview_id: u32,
    search_text: [*:0]const u8,
    forward: bool,
    match_case: bool,
) void {
    clearLastError();
    const WebviewFindInPageFn = *const fn (WebviewPtr, [*:0]const u8, bool, bool) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_find_in_page = lookupNativeSymbol(WebviewFindInPageFn, "webviewFindInPage") orelse return;
    webview_find_in_page(webview, search_text, forward, match_case);
}

export fn webviewStopFind(webview_id: u32) void {
    clearLastError();
    const WebviewStopFindFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_stop_find = lookupNativeSymbol(WebviewStopFindFn, "webviewStopFind") orelse return;
    webview_stop_find(webview);
}

export fn evaluateJavaScriptWithNoCompletion(webview_id: u32, js: [*:0]const u8) void {
    clearLastError();
    const EvaluateJavaScriptWithNoCompletionFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const evaluate_javascript_with_no_completion = lookupNativeSymbol(
        EvaluateJavaScriptWithNoCompletionFn,
        "evaluateJavaScriptWithNoCompletion",
    ) orelse return;
    evaluate_javascript_with_no_completion(webview, js);
}

export fn dispatchHostWebviewEvent(
    webview_id: u32,
    event_name: [*:0]const u8,
    detail: [*:0]const u8,
) bool {
    clearLastError();

    const host_webview_id = lookupWebviewHostId(webview_id) orelse return false;
    const js = buildHostWebviewEventJavascript(webview_id, event_name, detail) orelse return false;
    defer allocator.free(js);

    evaluateJavaScriptWithNoCompletion(host_webview_id, js.ptr);
    return true;
}

export fn sendInternalMessageToWebview(webview_id: u32, message_json: [*:0]const u8) bool {
    clearLastError();

    const js = buildInternalMessageJavascript(message_json) orelse return false;
    defer allocator.free(js);

    evaluateJavaScriptWithNoCompletion(webview_id, js.ptr);
    return true;
}

export fn webviewOpenDevTools(webview_id: u32) void {
    clearLastError();
    const WebviewOpenDevToolsFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_open_devtools = lookupNativeSymbol(WebviewOpenDevToolsFn, "webviewOpenDevTools") orelse return;
    webview_open_devtools(webview);
}

export fn webviewCloseDevTools(webview_id: u32) void {
    clearLastError();
    const WebviewCloseDevToolsFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_close_devtools = lookupNativeSymbol(WebviewCloseDevToolsFn, "webviewCloseDevTools") orelse return;
    webview_close_devtools(webview);
}

export fn webviewToggleDevTools(webview_id: u32) void {
    clearLastError();
    const WebviewToggleDevToolsFn = *const fn (WebviewPtr) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_toggle_devtools = lookupNativeSymbol(WebviewToggleDevToolsFn, "webviewToggleDevTools") orelse return;
    webview_toggle_devtools(webview);
}

export fn webviewSetPageZoom(webview_id: u32, zoom_level: f64) void {
    clearLastError();
    const WebviewSetPageZoomFn = *const fn (WebviewPtr, f64) callconv(.C) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_page_zoom = lookupNativeSymbol(WebviewSetPageZoomFn, "webviewSetPageZoom") orelse return;
    webview_set_page_zoom(webview, zoom_level);
}

export fn webviewGetPageZoom(webview_id: u32) f64 {
    clearLastError();
    const WebviewGetPageZoomFn = *const fn (WebviewPtr) callconv(.C) f64;
    const webview = lookupWebviewPtr(webview_id) orelse return 1.0;
    const webview_get_page_zoom = lookupNativeSymbol(WebviewGetPageZoomFn, "webviewGetPageZoom") orelse return 1.0;
    return webview_get_page_zoom(webview);
}

export fn createWGPUView(
    window_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    auto_resize: bool,
    start_transparent: bool,
    start_passthrough: bool,
) u32 {
    clearLastError();

    const InitWGPUViewFn = *const fn (
        u32,
        WindowPtr,
        f64,
        f64,
        f64,
        f64,
        bool,
        bool,
        bool,
    ) callconv(.C) WgpuViewPtr;

    const window = requireWindowPtr(window_id) orelse return 0;
    const init_wgpu_view = lookupNativeSymbol(InitWGPUViewFn, "initWGPUView") orelse return 0;

    wgpu_view_registry_mutex.lock();
    const start_id = next_wgpu_view_id;
    var wgpu_view_id = next_wgpu_view_id;

    while (wgpu_view_id == 0 or wgpu_view_registry.contains(wgpu_view_id)) {
        wgpu_view_id +%= 1;
        if (wgpu_view_id == 0) {
            wgpu_view_id = 1;
        }
        if (wgpu_view_id == start_id) {
            wgpu_view_registry_mutex.unlock();
            setLastError("Failed to allocate WGPUView id", .{});
            return 0;
        }
    }

    next_wgpu_view_id = wgpu_view_id +% 1;
    if (next_wgpu_view_id == 0) {
        next_wgpu_view_id = 1;
    }

    wgpu_view_registry.put(wgpu_view_id, .{ .ptr = null }) catch |err| {
        wgpu_view_registry_mutex.unlock();
        setLastError("Failed to store WGPUView state: {s}", .{@errorName(err)});
        return 0;
    };
    wgpu_view_registry_mutex.unlock();

    const wgpu_view_ptr = init_wgpu_view(
        wgpu_view_id,
        window,
        x,
        y,
        width,
        height,
        auto_resize,
        start_transparent,
        start_passthrough,
    );

    if (wgpu_view_ptr == null) {
        wgpu_view_registry_mutex.lock();
        _ = wgpu_view_registry.remove(wgpu_view_id);
        wgpu_view_registry_mutex.unlock();
        setLastError("Failed to create WGPUView", .{});
        return 0;
    }

    wgpu_view_registry_mutex.lock();
    const state = wgpu_view_registry.getPtr(wgpu_view_id) orelse {
        wgpu_view_registry_mutex.unlock();
        setLastError("WGPUView {d} disappeared during creation", .{wgpu_view_id});
        return 0;
    };
    state.ptr = wgpu_view_ptr;
    wgpu_view_registry_mutex.unlock();

    return wgpu_view_id;
}

export fn getWGPUViewPointer(wgpu_view_id: u32) WgpuViewPtr {
    clearLastError();
    return lookupWgpuViewPtr(wgpu_view_id);
}

export fn setWGPUViewFrame(
    wgpu_view_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) void {
    clearLastError();
    const SetWGPUViewFrameFn = *const fn (WgpuViewPtr, f64, f64, f64, f64) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_frame = lookupNativeSymbol(SetWGPUViewFrameFn, "wgpuViewSetFrame") orelse return;
    set_wgpu_view_frame(wgpu_view, x, y, width, height);
}

export fn resizeWGPUView(
    wgpu_view_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    masks_json: [*:0]const u8,
) void {
    clearLastError();
    const ResizeWGPUViewFn = *const fn (WgpuViewPtr, f64, f64, f64, f64, [*:0]const u8) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const resize_wgpu_view = lookupNativeSymbol(ResizeWGPUViewFn, "resizeWebview") orelse return;
    resize_wgpu_view(wgpu_view, x, y, width, height, masks_json);
}

export fn setWGPUViewTransparent(wgpu_view_id: u32, transparent: bool) void {
    clearLastError();
    const SetWGPUViewTransparentFn = *const fn (WgpuViewPtr, bool) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_transparent = lookupNativeSymbol(
        SetWGPUViewTransparentFn,
        "wgpuViewSetTransparent",
    ) orelse return;
    set_wgpu_view_transparent(wgpu_view, transparent);
}

export fn setWGPUViewPassthrough(wgpu_view_id: u32, passthrough: bool) void {
    clearLastError();
    const SetWGPUViewPassthroughFn = *const fn (WgpuViewPtr, bool) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_passthrough = lookupNativeSymbol(
        SetWGPUViewPassthroughFn,
        "wgpuViewSetPassthrough",
    ) orelse return;
    set_wgpu_view_passthrough(wgpu_view, passthrough);
}

export fn setWGPUViewHidden(wgpu_view_id: u32, hidden: bool) void {
    clearLastError();
    const SetWGPUViewHiddenFn = *const fn (WgpuViewPtr, bool) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_hidden = lookupNativeSymbol(SetWGPUViewHiddenFn, "wgpuViewSetHidden") orelse return;
    set_wgpu_view_hidden(wgpu_view, hidden);
}

export fn removeWGPUView(wgpu_view_id: u32) void {
    clearLastError();
    const RemoveWGPUViewFn = *const fn (WgpuViewPtr) callconv(.C) void;

    wgpu_view_registry_mutex.lock();
    const removed = wgpu_view_registry.fetchRemove(wgpu_view_id);
    wgpu_view_registry_mutex.unlock();

    const wgpu_view = if (removed) |entry| entry.value.ptr else null;
    if (wgpu_view == null) {
        return;
    }

    const remove_wgpu_view = lookupNativeSymbol(RemoveWGPUViewFn, "wgpuViewRemove") orelse return;
    remove_wgpu_view(wgpu_view);
}

export fn getWGPUViewNativeHandle(wgpu_view_id: u32) WgpuViewPtr {
    clearLastError();
    const GetWGPUViewNativeHandleFn = *const fn (WgpuViewPtr) callconv(.C) WgpuViewPtr;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return null;
    const get_wgpu_view_native_handle = lookupNativeSymbol(
        GetWGPUViewNativeHandleFn,
        "wgpuViewGetNativeHandle",
    ) orelse return null;
    return get_wgpu_view_native_handle(wgpu_view);
}

export fn runWGPUViewTest(wgpu_view_id: u32) void {
    clearLastError();
    const RunWGPUViewTestFn = *const fn (WgpuViewPtr) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const run_wgpu_view_test = lookupNativeSymbol(RunWGPUViewTestFn, "wgpuRunGPUTest") orelse return;
    run_wgpu_view_test(wgpu_view);
}

export fn toggleWGPUViewTestShader(wgpu_view_id: u32) void {
    clearLastError();
    const ToggleWGPUViewTestShaderFn = *const fn (WgpuViewPtr) callconv(.C) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const toggle_wgpu_view_test_shader = lookupNativeSymbol(
        ToggleWGPUViewTestShaderFn,
        "wgpuToggleGPUTestShader",
    ) orelse return;
    toggle_wgpu_view_test_shader(wgpu_view);
}

export fn createTray(
    title: [*:0]const u8,
    image: [*:0]const u8,
    is_template: bool,
    width: u32,
    height: u32,
    tray_item_handler: ?StatusItemHandler,
) u32 {
    clearLastError();

    const owned_title = dupeZ(title) catch |err| {
        setLastError("Failed to allocate tray title: {s}", .{@errorName(err)});
        return 0;
    };
    errdefer allocator.free(owned_title);

    const owned_image = dupeZ(image) catch |err| {
        setLastError("Failed to allocate tray image: {s}", .{@errorName(err)});
        return 0;
    };
    errdefer allocator.free(owned_image);

    const tray_id = next_tray_id;
    next_tray_id += 1;

    tray_registry.put(tray_id, .{
        .title = owned_title,
        .image = owned_image,
        .menu_config = null,
        .is_template = is_template,
        .width = width,
        .height = height,
        .handler = tray_item_handler,
        .ptr = null,
        .visible = false,
    }) catch |err| {
        setLastError("Failed to store tray state: {s}", .{@errorName(err)});
        return 0;
    };

    const state = tray_registry.getPtr(tray_id).?;
    if (!createNativeTrayForState(tray_id, state)) {
        var removed = tray_registry.fetchRemove(tray_id).?;
        freeTrayState(&removed.value);
        return 0;
    }

    return tray_id;
}

export fn showTray(tray_id: u32) bool {
    clearLastError();

    const state = tray_registry.getPtr(tray_id) orelse {
        setLastError("Tray {d} not found", .{tray_id});
        return false;
    };

    if (state.visible and state.ptr != null) {
        return true;
    }

    return createNativeTrayForState(tray_id, state);
}

export fn hideTray(tray_id: u32) void {
    clearLastError();

    const state = tray_registry.getPtr(tray_id) orelse return;
    hideNativeTray(state);
}

export fn setTrayTitle(tray_id: u32, title: [*:0]const u8) void {
    clearLastError();

    const SetNativeTrayTitleFn = *const fn (TrayPtr, [*:0]const u8) callconv(.C) void;
    const state = tray_registry.getPtr(tray_id) orelse return;
    if (!replaceOwnedZ(&state.title, title)) {
        return;
    }

    if (state.ptr) |tray_ptr| {
        const set_native_tray_title = lookupNativeSymbol(SetNativeTrayTitleFn, "setTrayTitle") orelse return;
        set_native_tray_title(tray_ptr, state.title.ptr);
    }
}

export fn setTrayImage(tray_id: u32, image: [*:0]const u8) void {
    clearLastError();

    const SetNativeTrayImageFn = *const fn (TrayPtr, [*:0]const u8) callconv(.C) void;
    const state = tray_registry.getPtr(tray_id) orelse return;
    if (!replaceOwnedZ(&state.image, image)) {
        return;
    }

    if (state.ptr) |tray_ptr| {
        const set_native_tray_image = lookupNativeSymbol(SetNativeTrayImageFn, "setTrayImage") orelse return;
        set_native_tray_image(tray_ptr, state.image.ptr);
    }
}

export fn setTrayMenu(tray_id: u32, menu_config: [*:0]const u8) void {
    clearLastError();

    const SetNativeTrayMenuFn = *const fn (TrayPtr, [*:0]const u8) callconv(.C) void;
    const state = tray_registry.getPtr(tray_id) orelse return;
    if (!replaceOptionalOwnedZ(&state.menu_config, menu_config)) {
        return;
    }

    if (state.ptr) |tray_ptr| {
        const set_native_tray_menu = lookupNativeSymbol(SetNativeTrayMenuFn, "setTrayMenu") orelse return;
        set_native_tray_menu(tray_ptr, state.menu_config.?.ptr);
    }
}

export fn removeTray(tray_id: u32) void {
    clearLastError();

    var removed = tray_registry.fetchRemove(tray_id) orelse return;
    hideNativeTray(&removed.value);
    freeTrayState(&removed.value);
}

export fn getTrayBounds(tray_id: u32) [*:0]const u8 {
    clearLastError();

    const GetNativeTrayBoundsFn = *const fn (TrayPtr) callconv(.C) ?[*:0]const u8;
    const state = tray_registry.getPtr(tray_id) orelse return empty_rect_json;
    const tray_ptr = state.ptr orelse return empty_rect_json;

    const get_native_tray_bounds = lookupNativeSymbol(GetNativeTrayBoundsFn, "getTrayBounds") orelse {
        return empty_rect_json;
    };
    return get_native_tray_bounds(tray_ptr) orelse empty_rect_json;
}

export fn setApplicationMenu(menu_config: [*:0]const u8, application_menu_handler: ?StatusItemHandler) void {
    const SetApplicationMenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.C) void;
    const set_application_menu = lookupNativeSymbol(
        SetApplicationMenuFn,
        "setApplicationMenu",
    ) orelse return;
    set_application_menu(menu_config, application_menu_handler);
}

export fn showContextMenu(menu_config: [*:0]const u8, context_menu_handler: ?StatusItemHandler) void {
    const ShowContextMenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.C) void;
    const show_context_menu = lookupNativeSymbol(
        ShowContextMenuFn,
        "showContextMenu",
    ) orelse return;
    show_context_menu(menu_config, context_menu_handler);
}

export fn moveToTrash(path: [*:0]const u8) bool {
    const MoveToTrashFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const move_to_trash = lookupNativeSymbol(MoveToTrashFn, "moveToTrash") orelse return false;
    return move_to_trash(path);
}

export fn showItemInFolder(path: [*:0]const u8) void {
    const ShowItemInFolderFn = *const fn ([*:0]const u8) callconv(.C) void;
    const show_item_in_folder = lookupNativeSymbol(ShowItemInFolderFn, "showItemInFolder") orelse return;
    show_item_in_folder(path);
}

export fn openExternal(url: [*:0]const u8) bool {
    const OpenExternalFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const open_external = lookupNativeSymbol(OpenExternalFn, "openExternal") orelse return false;
    return open_external(url);
}

export fn openPath(path: [*:0]const u8) bool {
    const OpenPathFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const open_path = lookupNativeSymbol(OpenPathFn, "openPath") orelse return false;
    return open_path(path);
}

export fn showNotification(
    title: [*:0]const u8,
    body: [*:0]const u8,
    subtitle: [*:0]const u8,
    silent: bool,
) void {
    const ShowNotificationFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, bool) callconv(.C) void;
    const show_notification = lookupNativeSymbol(ShowNotificationFn, "showNotification") orelse return;
    show_notification(title, body, subtitle, silent);
}

export fn setDockIconVisible(visible: bool) void {
    const SetDockIconVisibleFn = *const fn (bool) callconv(.C) void;
    const set_dock_icon_visible = lookupNativeSymbol(SetDockIconVisibleFn, "setDockIconVisible") orelse return;
    set_dock_icon_visible(visible);
}

export fn isDockIconVisible() bool {
    const IsDockIconVisibleFn = *const fn () callconv(.C) bool;
    const is_dock_icon_visible = lookupNativeSymbol(IsDockIconVisibleFn, "isDockIconVisible") orelse return false;
    return is_dock_icon_visible();
}

export fn openFileDialog(
    starting_folder: [*:0]const u8,
    allowed_file_types: [*:0]const u8,
    can_choose_files: c_int,
    can_choose_directories: c_int,
    allows_multiple_selection: c_int,
) ?[*:0]const u8 {
    const OpenFileDialogFn = *const fn ([*:0]const u8, [*:0]const u8, c_int, c_int, c_int) callconv(.C) ?[*:0]const u8;
    const open_file_dialog = lookupNativeSymbol(OpenFileDialogFn, "openFileDialog") orelse return null;
    return open_file_dialog(
        starting_folder,
        allowed_file_types,
        can_choose_files,
        can_choose_directories,
        allows_multiple_selection,
    );
}

export fn showMessageBox(
    box_type: [*:0]const u8,
    title: [*:0]const u8,
    message: [*:0]const u8,
    detail: [*:0]const u8,
    buttons: [*:0]const u8,
    default_id: c_int,
    cancel_id: c_int,
) c_int {
    const ShowMessageBoxFn = *const fn (
        [*:0]const u8,
        [*:0]const u8,
        [*:0]const u8,
        [*:0]const u8,
        [*:0]const u8,
        c_int,
        c_int,
    ) callconv(.C) c_int;
    const show_message_box = lookupNativeSymbol(ShowMessageBoxFn, "showMessageBox") orelse return -1;
    return show_message_box(box_type, title, message, detail, buttons, default_id, cancel_id);
}

export fn clipboardReadText() ?[*:0]const u8 {
    const ClipboardReadTextFn = *const fn () callconv(.C) ?[*:0]const u8;
    const clipboard_read_text = lookupNativeSymbol(ClipboardReadTextFn, "clipboardReadText") orelse return null;
    return clipboard_read_text();
}

export fn clipboardWriteText(text: [*:0]const u8) void {
    const ClipboardWriteTextFn = *const fn ([*:0]const u8) callconv(.C) void;
    const clipboard_write_text = lookupNativeSymbol(ClipboardWriteTextFn, "clipboardWriteText") orelse return;
    clipboard_write_text(text);
}

export fn clipboardReadImage(out_size: *u64) ?*const anyopaque {
    const ClipboardReadImageFn = *const fn (*u64) callconv(.C) ?*const anyopaque;
    const clipboard_read_image = lookupNativeSymbol(ClipboardReadImageFn, "clipboardReadImage") orelse return null;
    return clipboard_read_image(out_size);
}

export fn clipboardWriteImage(data: ?*const anyopaque, size: u64) void {
    const ClipboardWriteImageFn = *const fn (?*const anyopaque, u64) callconv(.C) void;
    const clipboard_write_image = lookupNativeSymbol(ClipboardWriteImageFn, "clipboardWriteImage") orelse return;
    clipboard_write_image(data, size);
}

export fn clipboardClear() void {
    const ClipboardClearFn = *const fn () callconv(.C) void;
    const clipboard_clear = lookupNativeSymbol(ClipboardClearFn, "clipboardClear") orelse return;
    clipboard_clear();
}

export fn clipboardAvailableFormats() ?[*:0]const u8 {
    const ClipboardAvailableFormatsFn = *const fn () callconv(.C) ?[*:0]const u8;
    const clipboard_available_formats = lookupNativeSymbol(
        ClipboardAvailableFormatsFn,
        "clipboardAvailableFormats",
    ) orelse return null;
    return clipboard_available_formats();
}

export fn getPrimaryDisplay() ?[*:0]const u8 {
    const GetPrimaryDisplayFn = *const fn () callconv(.C) ?[*:0]const u8;
    const get_primary_display = lookupNativeSymbol(GetPrimaryDisplayFn, "getPrimaryDisplay") orelse return null;
    return get_primary_display();
}

export fn getAllDisplays() ?[*:0]const u8 {
    const GetAllDisplaysFn = *const fn () callconv(.C) ?[*:0]const u8;
    const get_all_displays = lookupNativeSymbol(GetAllDisplaysFn, "getAllDisplays") orelse return null;
    return get_all_displays();
}

export fn getCursorScreenPoint() ?[*:0]const u8 {
    const GetCursorScreenPointFn = *const fn () callconv(.C) ?[*:0]const u8;
    const get_cursor_screen_point = lookupNativeSymbol(
        GetCursorScreenPointFn,
        "getCursorScreenPoint",
    ) orelse return null;
    return get_cursor_screen_point();
}

export fn getMouseButtons() u64 {
    const GetMouseButtonsFn = *const fn () callconv(.C) u64;
    const get_mouse_buttons = lookupNativeSymbol(GetMouseButtonsFn, "getMouseButtons") orelse return 0;
    return get_mouse_buttons();
}

export fn setGlobalShortcutCallback(callback: ?GlobalShortcutHandler) void {
    clearLastError();
    const SetGlobalShortcutCallbackFn = *const fn (?GlobalShortcutHandler) callconv(.C) void;
    const set_global_shortcut_callback = lookupNativeSymbol(
        SetGlobalShortcutCallbackFn,
        "setGlobalShortcutCallback",
    ) orelse return;
    set_global_shortcut_callback(callback);
}

export fn registerGlobalShortcut(accelerator: [*:0]const u8) bool {
    clearLastError();
    const RegisterGlobalShortcutFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const register_global_shortcut = lookupNativeSymbol(
        RegisterGlobalShortcutFn,
        "registerGlobalShortcut",
    ) orelse return false;
    return register_global_shortcut(accelerator);
}

export fn unregisterGlobalShortcut(accelerator: [*:0]const u8) bool {
    clearLastError();
    const UnregisterGlobalShortcutFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const unregister_global_shortcut = lookupNativeSymbol(
        UnregisterGlobalShortcutFn,
        "unregisterGlobalShortcut",
    ) orelse return false;
    return unregister_global_shortcut(accelerator);
}

export fn unregisterAllGlobalShortcuts() void {
    clearLastError();
    const UnregisterAllGlobalShortcutsFn = *const fn () callconv(.C) void;
    const unregister_all_global_shortcuts = lookupNativeSymbol(
        UnregisterAllGlobalShortcutsFn,
        "unregisterAllGlobalShortcuts",
    ) orelse return;
    unregister_all_global_shortcuts();
}

export fn isGlobalShortcutRegistered(accelerator: [*:0]const u8) bool {
    clearLastError();
    const IsGlobalShortcutRegisteredFn = *const fn ([*:0]const u8) callconv(.C) bool;
    const is_global_shortcut_registered = lookupNativeSymbol(
        IsGlobalShortcutRegisteredFn,
        "isGlobalShortcutRegistered",
    ) orelse return false;
    return is_global_shortcut_registered(accelerator);
}

export fn sessionGetCookies(
    partition_identifier: [*:0]const u8,
    filter_json: [*:0]const u8,
) ?[*:0]const u8 {
    clearLastError();
    const SessionGetCookiesFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.C) ?[*:0]const u8;
    const session_get_cookies = lookupNativeSymbol(SessionGetCookiesFn, "sessionGetCookies") orelse return null;
    return session_get_cookies(partition_identifier, filter_json);
}

export fn sessionSetCookie(
    partition_identifier: [*:0]const u8,
    cookie_json: [*:0]const u8,
) bool {
    clearLastError();
    const SessionSetCookieFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.C) bool;
    const session_set_cookie = lookupNativeSymbol(SessionSetCookieFn, "sessionSetCookie") orelse return false;
    return session_set_cookie(partition_identifier, cookie_json);
}

export fn sessionRemoveCookie(
    partition_identifier: [*:0]const u8,
    url: [*:0]const u8,
    cookie_name: [*:0]const u8,
) bool {
    clearLastError();
    const SessionRemoveCookieFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8) callconv(.C) bool;
    const session_remove_cookie = lookupNativeSymbol(SessionRemoveCookieFn, "sessionRemoveCookie") orelse return false;
    return session_remove_cookie(partition_identifier, url, cookie_name);
}

export fn sessionClearCookies(partition_identifier: [*:0]const u8) void {
    clearLastError();
    const SessionClearCookiesFn = *const fn ([*:0]const u8) callconv(.C) void;
    const session_clear_cookies = lookupNativeSymbol(
        SessionClearCookiesFn,
        "sessionClearCookies",
    ) orelse return;
    session_clear_cookies(partition_identifier);
}

export fn sessionClearStorageData(
    partition_identifier: [*:0]const u8,
    storage_types_json: [*:0]const u8,
) void {
    clearLastError();
    const SessionClearStorageDataFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.C) void;
    const session_clear_storage_data = lookupNativeSymbol(
        SessionClearStorageDataFn,
        "sessionClearStorageData",
    ) orelse return;
    session_clear_storage_data(partition_identifier, storage_types_json);
}

export fn setURLOpenHandler(handler: ?URLOpenHandler) void {
    clearLastError();
    const SetURLOpenHandlerFn = *const fn (?URLOpenHandler) callconv(.C) void;
    const set_url_open_handler = lookupNativeSymbol(SetURLOpenHandlerFn, "setURLOpenHandler") orelse return;
    set_url_open_handler(handler);
}

export fn setAppReopenHandler(handler: ?AppReopenHandler) void {
    clearLastError();
    const SetAppReopenHandlerFn = *const fn (?AppReopenHandler) callconv(.C) void;
    const set_app_reopen_handler = lookupNativeSymbol(
        SetAppReopenHandlerFn,
        "setAppReopenHandler",
    ) orelse return;
    set_app_reopen_handler(handler);
}

export fn setQuitRequestedHandler(handler: ?QuitRequestedHandler) void {
    clearLastError();
    const SetQuitRequestedHandlerFn = *const fn (?QuitRequestedHandler) callconv(.C) void;
    const set_quit_requested_handler = lookupNativeSymbol(
        SetQuitRequestedHandlerFn,
        "setQuitRequestedHandler",
    ) orelse return;
    set_quit_requested_handler(handler);
}

export fn stopEventLoop() void {
    clearLastError();
    const StopEventLoopFn = *const fn () callconv(.C) void;
    const stop_event_loop = lookupNativeSymbol(StopEventLoopFn, "stopEventLoop") orelse return;
    stop_event_loop();
}

export fn waitForShutdownComplete(timeout_ms: c_int) void {
    clearLastError();
    const WaitForShutdownCompleteFn = *const fn (c_int) callconv(.C) void;
    const wait_for_shutdown_complete = lookupNativeSymbol(
        WaitForShutdownCompleteFn,
        "waitForShutdownComplete",
    ) orelse return;
    wait_for_shutdown_complete(timeout_ms);
}

export fn forceExit(code: c_int) void {
    clearLastError();
    if (!ensureNativeWrapperLoaded()) {
        return;
    }
    native_wrapper_state.force_exit(code);
}

export fn wgpuCreateSurfaceForView(instance: ?*anyopaque, view_ptr: ?*anyopaque) ?*anyopaque {
    clearLastError();
    const WgpuCreateSurfaceForViewFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const wgpu_create_surface_for_view = lookupNativeSymbol(
        WgpuCreateSurfaceForViewFn,
        "wgpuCreateSurfaceForView",
    ) orelse return null;
    return wgpu_create_surface_for_view(instance, view_ptr);
}

export fn wgpuCreateAdapterDeviceMainThread(
    instance_ptr: ?*anyopaque,
    surface_ptr: ?*anyopaque,
    out_adapter_device: ?*anyopaque,
) void {
    clearLastError();
    const WgpuCreateAdapterDeviceMainThreadFn = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.C) void;
    const wgpu_create_adapter_device_main_thread = lookupNativeSymbol(
        WgpuCreateAdapterDeviceMainThreadFn,
        "wgpuCreateAdapterDeviceMainThread",
    ) orelse return;
    wgpu_create_adapter_device_main_thread(instance_ptr, surface_ptr, out_adapter_device);
}

export fn wgpuSurfaceConfigureMainThread(surface_ptr: ?*anyopaque, config_ptr: ?*anyopaque) void {
    clearLastError();
    const WgpuSurfaceConfigureMainThreadFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) void;
    const wgpu_surface_configure_main_thread = lookupNativeSymbol(
        WgpuSurfaceConfigureMainThreadFn,
        "wgpuSurfaceConfigureMainThread",
    ) orelse return;
    wgpu_surface_configure_main_thread(surface_ptr, config_ptr);
}

export fn wgpuSurfaceGetCurrentTextureMainThread(surface_ptr: ?*anyopaque, surface_texture_ptr: ?*anyopaque) void {
    clearLastError();
    const WgpuSurfaceGetCurrentTextureMainThreadFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) void;
    const wgpu_surface_get_current_texture_main_thread = lookupNativeSymbol(
        WgpuSurfaceGetCurrentTextureMainThreadFn,
        "wgpuSurfaceGetCurrentTextureMainThread",
    ) orelse return;
    wgpu_surface_get_current_texture_main_thread(surface_ptr, surface_texture_ptr);
}

export fn wgpuSurfacePresentMainThread(surface_ptr: ?*anyopaque) i32 {
    clearLastError();
    const WgpuSurfacePresentMainThreadFn = *const fn (?*anyopaque) callconv(.C) i32;
    const wgpu_surface_present_main_thread = lookupNativeSymbol(
        WgpuSurfacePresentMainThreadFn,
        "wgpuSurfacePresentMainThread",
    ) orelse return -1;
    return wgpu_surface_present_main_thread(surface_ptr);
}
