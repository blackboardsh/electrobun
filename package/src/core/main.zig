const std = @import("std");
const builtin = @import("builtin");

const allocator = std.heap.c_allocator;
const install_root_name_environment_variable = "ELECTROBUN_INSTALL_ROOT_NAME";

fn processEnviron() std.process.Environ {
    return switch (builtin.os.tag) {
        .windows => .{ .block = .global },
        else => blk: {
            const c_environ = std.c.environ;
            var count: usize = 0;
            while (c_environ[count] != null) : (count += 1) {}
            break :blk .{ .block = .{ .slice = @ptrCast(c_environ[0..count :null]) } };
        },
    };
}

fn isSafeInstallRootName(value: []const u8) bool {
    if (value.len == 0 or value.len > 256 or
        std.mem.eql(u8, value, ".") or std.mem.eql(u8, value, "..")) return false;
    for (value) |byte| {
        if (byte < 0x20 or byte == 0x7f or byte == '/' or byte == '\\') return false;
    }
    if (builtin.os.tag == .windows) {
        if (value[value.len - 1] == ' ' or value[value.len - 1] == '.') return false;
        if (std.mem.indexOfAny(u8, value, "\"%*:<>?|") != null) return false;
    }
    return true;
}

fn installRootNameOverride() ?[:0]u8 {
    const value = processEnviron().getAlloc(allocator, install_root_name_environment_variable) catch return null;
    defer allocator.free(value);
    if (!isSafeInstallRootName(value)) return null;
    return allocator.dupeZ(u8, value) catch null;
}

// Lazily-initialized event-loop-free Io implementation. The library keeps its
// C-ABI surface unchanged, so `std.Io` is not threaded through call sites.
var io_state: struct {
    status: std.atomic.Value(u8) = .init(0), // 0 = uninitialized, 1 = initializing, 2 = ready
    threaded: std.Io.Threaded = undefined,
} = .{};

fn coreIo() std.Io {
    while (true) {
        switch (io_state.status.load(.acquire)) {
            2 => return io_state.threaded.io(),
            0 => {
                if (io_state.status.cmpxchgStrong(0, 1, .acquire, .acquire) == null) {
                    io_state.threaded = std.Io.Threaded.init(allocator, .{});
                    io_state.status.store(2, .release);
                    return io_state.threaded.io();
                }
            },
            else => std.atomic.spinLoopHint(),
        }
    }
}

fn allocPrintZ(gpa: std.mem.Allocator, comptime fmt: []const u8, args: anytype) std.mem.Allocator.Error![:0]u8 {
    return std.fmt.allocPrintSentinel(gpa, fmt, args, 0);
}

// std.DynLib no longer supports Windows, so provide a LoadLibrary-backed
// equivalent with the same open/close/lookup surface there.
const CoreDynLib = if (builtin.os.tag == .windows) struct {
    const win = std.os.windows;

    extern "kernel32" fn LoadLibraryW(lpLibFileName: [*:0]const u16) callconv(.winapi) ?win.HMODULE;
    extern "kernel32" fn FreeLibrary(hModule: win.HMODULE) callconv(.winapi) win.BOOL;
    extern "kernel32" fn GetProcAddress(hModule: win.HMODULE, lpProcName: [*:0]const u8) callconv(.winapi) ?win.FARPROC;

    module: win.HMODULE,

    pub fn open(path: []const u8) !@This() {
        const path_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, path);
        defer allocator.free(path_w);
        const module = LoadLibraryW(path_w.ptr) orelse return error.FileNotFound;
        return .{ .module = module };
    }

    pub fn close(self: *@This()) void {
        _ = FreeLibrary(self.module);
    }

    pub fn lookup(self: *@This(), comptime T: type, name: [:0]const u8) ?T {
        const address = GetProcAddress(self.module, name.ptr) orelse return null;
        return @ptrCast(@alignCast(address));
    }
} else std.DynLib;

const StartEventLoopFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8) callconv(.c) void;
const ForceExitFn = *const fn (c_int) callconv(.c) void;
const WindowPtr = ?*anyopaque;
const WebviewPtr = ?*anyopaque;
const WgpuViewPtr = ?*anyopaque;
const TrayPtr = ?*anyopaque;
const WindowCloseHandler = *const fn (u32) callconv(.c) void;
const WindowShouldCloseHandler = *const fn (u32) callconv(.c) void;
const WindowMoveHandler = *const fn (u32, f64, f64) callconv(.c) void;
const WindowResizeHandler = *const fn (u32, f64, f64, f64, f64) callconv(.c) void;
const WindowFocusHandler = *const fn (u32) callconv(.c) void;
const WindowBlurHandler = *const fn (u32) callconv(.c) void;
const WindowKeyHandler = *const fn (u32, u32, u32, u32, u32) callconv(.c) void;
const DecideNavigationHandler = *const fn (u32, [*:0]const u8) callconv(.c) u32;
const WebviewEventHandler = *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.c) void;
const WebviewPostMessageHandler = *const fn (u32, [*:0]const u8) callconv(.c) void;
const StatusItemHandler = *const fn (u32, [*:0]const u8) callconv(.c) void;
const GlobalShortcutHandler = *const fn ([*:0]const u8) callconv(.c) void;
const QuitRequestedHandler = *const fn () callconv(.c) void;
const URLOpenHandler = *const fn ([*:0]const u8) callconv(.c) void;
const AppReopenHandler = *const fn () callconv(.c) void;
const Aes256Gcm = std.crypto.aead.aes_gcm.Aes256Gcm;
const WebviewSecretKey = [Aes256Gcm.key_length]u8;
const websocket_magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const websocket_payload_limit: usize = 1024 * 1024 * 500;
const websocket_port_range_start: u16 = 50000;
const websocket_port_range_end: u16 = 65535;

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
    should_close_handler: ?WindowShouldCloseHandler,
    move_handler: ?WindowMoveHandler,
    resize_handler: ?WindowResizeHandler,
    focus_handler: ?WindowFocusHandler,
    blur_handler: ?WindowBlurHandler,
    key_handler: ?WindowKeyHandler,
};

const WebviewRendererKind = enum {
    native,
    cef,
};

const PendingHostMessage = struct {
    webview_id: u32,
    message: [:0]u8,
};

const PendingHostTransportSend = struct {
    webview_id: u32,
    socket_handle: std.posix.socket_t,
    opcode: u8,
    payload: []u8,
};

const WebviewState = struct {
    ptr: WebviewPtr,
    window_id: u32,
    host_webview_id: ?u32,
    renderer: WebviewRendererKind,
    webview_event_handler: ?WebviewEventHandler,
    event_bridge_handler: ?WebviewPostMessageHandler,
    internal_bridge_handler: ?WebviewPostMessageHandler,
    secret_key: WebviewSecretKey,
    socket_handle: ?std.posix.socket_t,
    transport_ready: bool,
    plaintext_transport: bool,
};

const WgpuViewState = struct {
    ptr: WgpuViewPtr,
    window_id: u32,
};

const WebviewRuntimeState = struct {
    rpc_port: u32 = 0,
    preload_script: ?[:0]u8 = null,
    preload_script_sandboxed: ?[:0]u8 = null,
    configured: bool = false,
};

const HostTransportState = struct {
    started: bool = false,
    port: u32 = 0,
};

const DefaultWebviewCallbacks = struct {
    navigation_callback: ?DecideNavigationHandler = null,
    webview_event_handler: ?WebviewEventHandler = null,
    event_bridge_handler: ?WebviewPostMessageHandler = null,
};

const HostMessageWakeupState = struct {
    initialized: bool = false,
    read_fd: ?std.posix.fd_t = null,
    write_fd: ?std.posix.fd_t = null,
    signaled: bool = false,
};

const HostTransportDebugState = struct {
    connections: u64 = 0,
    frames_read: u64 = 0,
    frames_dispatched: u64 = 0,
    decrypt_ok: u64 = 0,
    decrypt_errors: u64 = 0,
    enqueued: u64 = 0,
    wakeup_signals: u64 = 0,
    wakeup_write_errors: u64 = 0,
    socket_write_queued: u64 = 0,
    socket_write_frames: u64 = 0,
    socket_write_errors: u64 = 0,
    socket_write_stale: u64 = 0,
};

const NativeWrapperState = struct {
    lib: CoreDynLib,
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
var window_registry_mutex: std.Io.Mutex = .init;
var webview_registry = std.AutoHashMap(u32, WebviewState).init(allocator);
var webview_registry_mutex: std.Io.Mutex = .init;
var wgpu_view_registry = std.AutoHashMap(u32, WgpuViewState).init(allocator);
var wgpu_view_registry_mutex: std.Io.Mutex = .init;
var pending_host_messages: std.ArrayList(PendingHostMessage) = .empty;
var pending_host_messages_mutex: std.Io.Mutex = .init;
var pending_host_transport_sends: std.ArrayList(PendingHostTransportSend) = .empty;
var pending_host_transport_sends_head: usize = 0;
var pending_host_transport_sends_mutex: std.Io.Mutex = .init;
var pending_host_transport_sends_condition: std.Io.Condition = .init;
var pending_host_transport_send_worker_started = false;
var host_transport_socket_write_mutex: std.Io.Mutex = .init;
var webview_runtime_state = WebviewRuntimeState{};
var host_transport_state = HostTransportState{};
var host_transport_mutex: std.Io.Mutex = .init;
var host_transport_debug_state = HostTransportDebugState{};
var host_transport_debug_mutex: std.Io.Mutex = .init;
var default_webview_callbacks = DefaultWebviewCallbacks{};
var managed_quit_requested_handler: ?QuitRequestedHandler = null;
var exit_on_last_window_closed: bool = true;
var host_message_wakeup_state = HostMessageWakeupState{};
var host_message_wakeup_mutex: std.Io.Mutex = .init;
var runtime_callbacks_async = false;
var pending_runtime_callback_payloads = std.AutoHashMap(usize, [:0]u8).init(allocator);
var pending_runtime_callback_payloads_mutex: std.Io.Mutex = .init;

const empty_rect_json: [*:0]const u8 = "{\"x\":0,\"y\":0,\"width\":0,\"height\":0}";

fn setNonblocking(fd: std.posix.fd_t) void {
    if (builtin.os.tag == .windows) return;

    const flags_bits = std.c.fcntl(fd, std.c.F.GETFL, @as(c_int, 0));
    if (flags_bits < 0) return;
    var flags: std.c.O = @bitCast(@as(u32, @bitCast(flags_bits)));
    flags.NONBLOCK = true;
    _ = std.c.fcntl(fd, std.c.F.SETFL, @as(c_int, @bitCast(@as(u32, @bitCast(flags)))));
}

fn drainHostMessageWakeupLocked() void {
    if (builtin.os.tag == .windows) {
        host_message_wakeup_state.signaled = false;
        return;
    }

    const read_fd = host_message_wakeup_state.read_fd orelse {
        host_message_wakeup_state.signaled = false;
        return;
    };
    var buffer: [64]u8 = undefined;
    while (true) {
        const read_count = std.c.read(read_fd, &buffer, buffer.len);
        if (read_count <= 0 or @as(usize, @intCast(read_count)) < buffer.len) {
            break;
        }
    }
    host_message_wakeup_state.signaled = false;
}

fn incrementHostTransportDebug(comptime field: []const u8) void {
    host_transport_debug_mutex.lockUncancelable(coreIo());
    defer host_transport_debug_mutex.unlock(coreIo());
    @field(host_transport_debug_state, field) += 1;
}

fn clearLastError() void {
    if (last_error) |message| {
        allocator.free(message);
        last_error = null;
    }
}

fn setLastError(comptime fmt: []const u8, args: anytype) void {
    clearLastError();
    last_error = allocPrintZ(allocator, fmt, args) catch null;
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

fn parseWebviewRenderer(renderer: [*:0]const u8) WebviewRendererKind {
    if (std.mem.eql(u8, std.mem.span(renderer), "cef")) {
        return .cef;
    }
    return .native;
}

fn rememberDefaultWebviewCallbacks(
    navigation_callback: ?DecideNavigationHandler,
    webview_event_handler: ?WebviewEventHandler,
    event_bridge_handler: ?WebviewPostMessageHandler,
) void {
    if (navigation_callback) |handler| {
        default_webview_callbacks.navigation_callback = handler;
    }
    if (webview_event_handler) |handler| {
        default_webview_callbacks.webview_event_handler = handler;
    }
    if (event_bridge_handler) |handler| {
        default_webview_callbacks.event_bridge_handler = handler;
    }
}

fn ensureHostMessageWakeupInitialized() bool {
    if (builtin.os.tag == .windows) {
        return false;
    }

    host_message_wakeup_mutex.lockUncancelable(coreIo());
    defer host_message_wakeup_mutex.unlock(coreIo());

    if (host_message_wakeup_state.initialized) {
        return true;
    }

    var fds: [2]std.c.fd_t = undefined;
    if (std.c.pipe(&fds) != 0) return false;
    setNonblocking(fds[0]);
    setNonblocking(fds[1]);
    host_message_wakeup_state.read_fd = fds[0];
    host_message_wakeup_state.write_fd = fds[1];
    host_message_wakeup_state.initialized = true;
    host_message_wakeup_state.signaled = false;
    return true;
}

fn signalHostMessageWakeup() void {
    if (builtin.os.tag == .windows) {
        return;
    }

    if (!ensureHostMessageWakeupInitialized()) {
        return;
    }

    host_message_wakeup_mutex.lockUncancelable(coreIo());
    defer host_message_wakeup_mutex.unlock(coreIo());

    if (host_message_wakeup_state.signaled) {
        return;
    }

    const byte: [1]u8 = .{1};
    const write_fd = host_message_wakeup_state.write_fd orelse return;
    if (std.c.write(write_fd, &byte, byte.len) != byte.len) {
        incrementHostTransportDebug("wakeup_write_errors");
        return;
    }
    incrementHostTransportDebug("wakeup_signals");
    host_message_wakeup_state.signaled = true;
}

fn enqueuePendingHostMessage(webview_id: u32, message: [*:0]const u8) void {
    const owned_message = dupeZ(message) catch return;

    pending_host_messages_mutex.lockUncancelable(coreIo());
    defer pending_host_messages_mutex.unlock(coreIo());

    pending_host_messages.append(allocator, .{
        .webview_id = webview_id,
        .message = owned_message,
    }) catch {
        allocator.free(owned_message);
        return;
    };
    incrementHostTransportDebug("enqueued");

    signalHostMessageWakeup();
}

fn hostBridgeQueueTrampoline(webview_id: u32, message: [*:0]const u8) callconv(.c) void {
    enqueuePendingHostMessage(webview_id, message);
}

fn dispatchRuntimePostMessage(
    handler: WebviewPostMessageHandler,
    webview_id: u32,
    message: []const u8,
) void {
    const owned_message = allocator.dupeZ(u8, message) catch return;

    if (!runtime_callbacks_async) {
        defer allocator.free(owned_message);
        handler(webview_id, owned_message.ptr);
        return;
    }

    pending_runtime_callback_payloads_mutex.lockUncancelable(coreIo());
    pending_runtime_callback_payloads.put(
        @intFromPtr(owned_message.ptr),
        owned_message,
    ) catch {
        pending_runtime_callback_payloads_mutex.unlock(coreIo());
        allocator.free(owned_message);
        return;
    };
    pending_runtime_callback_payloads_mutex.unlock(coreIo());

    handler(webview_id, owned_message.ptr);
}

export fn setRuntimeCallbacksAsync(enabled: bool) void {
    runtime_callbacks_async = enabled;
}

export fn releaseRuntimeCallbackPayload(payload: ?[*:0]const u8) bool {
    const payload_ptr = payload orelse return false;

    pending_runtime_callback_payloads_mutex.lockUncancelable(coreIo());
    const removed = pending_runtime_callback_payloads.fetchRemove(@intFromPtr(payload_ptr));
    pending_runtime_callback_payloads_mutex.unlock(coreIo());

    if (removed) |entry| {
        allocator.free(entry.value);
        return true;
    }
    return false;
}

fn clearPendingRuntimeCallbackPayloads() void {
    pending_runtime_callback_payloads_mutex.lockUncancelable(coreIo());
    defer pending_runtime_callback_payloads_mutex.unlock(coreIo());

    var iterator = pending_runtime_callback_payloads.valueIterator();
    while (iterator.next()) |payload| {
        allocator.free(payload.*);
    }
    pending_runtime_callback_payloads.clearRetainingCapacity();
}

export fn popNextQueuedHostMessage(out_webview_id: *u32) ?[*:0]u8 {
    clearLastError();

    pending_host_messages_mutex.lockUncancelable(coreIo());
    defer pending_host_messages_mutex.unlock(coreIo());

    if (pending_host_messages.items.len == 0) {
        return null;
    }

    const entry = pending_host_messages.orderedRemove(0);
    if (pending_host_messages.items.len == 0) {
        host_message_wakeup_mutex.lockUncancelable(coreIo());
        drainHostMessageWakeupLocked();
        host_message_wakeup_mutex.unlock(coreIo());
    }
    out_webview_id.* = entry.webview_id;
    return entry.message.ptr;
}

export fn freeCoreString(value: ?[*:0]u8) void {
    if (value) |ptr_value| {
        const slice = std.mem.sliceTo(ptr_value, 0);
        allocator.free(@constCast(slice));
    }
}

export fn getHostTransportDebugJSON() ?[*:0]u8 {
    clearLastError();

    host_transport_debug_mutex.lockUncancelable(coreIo());
    const debug = host_transport_debug_state;
    host_transport_debug_mutex.unlock(coreIo());

    pending_host_messages_mutex.lockUncancelable(coreIo());
    const pending_count = pending_host_messages.items.len;
    pending_host_messages_mutex.unlock(coreIo());

    pending_host_transport_sends_mutex.lockUncancelable(coreIo());
    const pending_socket_write_count = pending_host_transport_sends.items.len - pending_host_transport_sends_head;
    const socket_write_worker_started = pending_host_transport_send_worker_started;
    pending_host_transport_sends_mutex.unlock(coreIo());

    host_message_wakeup_mutex.lockUncancelable(coreIo());
    const wakeup_initialized = host_message_wakeup_state.initialized;
    const wakeup_signaled = host_message_wakeup_state.signaled;
    host_message_wakeup_mutex.unlock(coreIo());

    const json = std.json.Stringify.valueAlloc(allocator, .{
        .connections = debug.connections,
        .framesRead = debug.frames_read,
        .framesDispatched = debug.frames_dispatched,
        .decryptOk = debug.decrypt_ok,
        .decryptErrors = debug.decrypt_errors,
        .enqueued = debug.enqueued,
        .pendingHostMessages = pending_count,
        .wakeupInitialized = wakeup_initialized,
        .wakeupSignaled = wakeup_signaled,
        .wakeupSignals = debug.wakeup_signals,
        .wakeupWriteErrors = debug.wakeup_write_errors,
        .socketWriteQueued = debug.socket_write_queued,
        .pendingSocketWrites = pending_socket_write_count,
        .socketWriteWorkerStarted = socket_write_worker_started,
        .socketWriteFrames = debug.socket_write_frames,
        .socketWriteErrors = debug.socket_write_errors,
        .socketWriteStale = debug.socket_write_stale,
    }, .{}) catch |err| {
        setLastError("Failed to build host transport debug JSON: {s}", .{@errorName(err)});
        return null;
    };
    defer allocator.free(json);
    return allocator.dupeZ(u8, json) catch |err| {
        setLastError("Failed to allocate host transport debug JSON: {s}", .{@errorName(err)});
        return null;
    };
}

export fn getHostMessageWakeupReadFD() c_int {
    clearLastError();
    if (!ensureHostMessageWakeupInitialized()) {
        return -1;
    }
    if (builtin.os.tag == .windows) {
        return -1;
    }
    return @intCast(host_message_wakeup_state.read_fd orelse return -1);
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

fn parseWebviewSecretKey(secret_key: [*:0]const u8) ?WebviewSecretKey {
    const input = std.mem.trim(u8, std.mem.span(secret_key), " \t\r\n");
    var parsed: WebviewSecretKey = [_]u8{0} ** Aes256Gcm.key_length;
    var iterator = std.mem.splitScalar(u8, input, ',');
    var index: usize = 0;

    while (iterator.next()) |part| {
        const trimmed = std.mem.trim(u8, part, " \t\r\n");
        if (trimmed.len == 0) {
            continue;
        }
        if (index >= parsed.len) {
            setLastError("Webview secret key must contain exactly {d} bytes", .{Aes256Gcm.key_length});
            return null;
        }
        parsed[index] = std.fmt.parseInt(u8, trimmed, 10) catch |err| {
            setLastError("Failed to parse webview secret key byte: {s}", .{@errorName(err)});
            return null;
        };
        index += 1;
    }

    if (index != parsed.len) {
        setLastError("Webview secret key must contain exactly {d} bytes", .{Aes256Gcm.key_length});
        return null;
    }

    return parsed;
}

fn streamFromSocketHandle(handle: std.posix.socket_t) std.Io.net.Stream {
    return .{ .socket = .{ .handle = handle, .address = undefined } };
}

fn shutdownSocketHandle(handle: std.posix.socket_t) void {
    streamFromSocketHandle(handle).shutdown(coreIo(), .both) catch {};
}

fn clearWebviewSocketHandleIfCurrent(webview_id: u32, handle: std.posix.socket_t) void {
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());

    const state = webview_registry.getPtr(webview_id) orelse return;
    if (state.socket_handle != null and state.socket_handle.? == handle) {
        state.socket_handle = null;
        state.transport_ready = false;
    }
}

fn closeAndClearWebviewSocketHandle(webview_id: u32) void {
    var handle_to_close: ?std.posix.socket_t = null;

    webview_registry_mutex.lockUncancelable(coreIo());
    if (webview_registry.getPtr(webview_id)) |state| {
        handle_to_close = state.socket_handle;
        state.socket_handle = null;
        state.transport_ready = false;
    }
    webview_registry_mutex.unlock(coreIo());

    if (handle_to_close) |handle| {
        shutdownSocketHandle(handle);
    }
}

fn attachWebviewSocketHandle(webview_id: u32, handle: std.posix.socket_t) bool {
    var handle_to_close: ?std.posix.socket_t = null;

    webview_registry_mutex.lockUncancelable(coreIo());
    const state = webview_registry.getPtr(webview_id) orelse {
        webview_registry_mutex.unlock(coreIo());
        return false;
    };
    if (state.socket_handle) |previous_handle| {
        if (previous_handle != handle) {
            handle_to_close = previous_handle;
        }
    }
    state.socket_handle = handle;
    state.transport_ready = false;
    webview_registry_mutex.unlock(coreIo());

    if (handle_to_close) |previous_handle| {
        shutdownSocketHandle(previous_handle);
    }

    return true;
}

const WebviewTransportContext = struct {
    secret_key: WebviewSecretKey,
    socket_handle: ?std.posix.socket_t,
    transport_ready: bool,
    plaintext_transport: bool,
};

fn lookupWebviewTransportContext(webview_id: u32) ?WebviewTransportContext {
    const state = lookupWebviewState(webview_id) orelse return null;
    return .{
        .secret_key = state.secret_key,
        .socket_handle = state.socket_handle,
        .transport_ready = state.transport_ready,
        .plaintext_transport = state.plaintext_transport,
    };
}

fn markWebviewTransportReady(webview_id: u32, handle: std.posix.socket_t) void {
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());

    const state = webview_registry.getPtr(webview_id) orelse return;
    if (state.socket_handle != null and state.socket_handle.? == handle) {
        state.transport_ready = true;
    }
}

fn isCurrentWebviewSocketHandle(webview_id: u32, handle: std.posix.socket_t) bool {
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());

    const state = webview_registry.getPtr(webview_id) orelse return false;
    return state.socket_handle != null and state.socket_handle.? == handle;
}

fn decodeBase64Alloc(input: []const u8) ![]u8 {
    const decoded_len = try std.base64.standard.Decoder.calcSizeForSlice(input);
    const decoded = try allocator.alloc(u8, decoded_len);
    errdefer allocator.free(decoded);
    try std.base64.standard.Decoder.decode(decoded, input);
    return decoded;
}

fn encodeBase64Alloc(input: []const u8) ![]u8 {
    const encoded_len = std.base64.standard.Encoder.calcSize(input.len);
    const encoded = try allocator.alloc(u8, encoded_len);
    _ = std.base64.standard.Encoder.encode(encoded, input);
    return encoded;
}

fn parseRequestHeaderValue(headers: []const u8, header_name: []const u8) ?[]const u8 {
    var lines = std.mem.splitSequence(u8, headers, "\r\n");
    _ = lines.next();

    while (lines.next()) |line| {
        if (line.len == 0) {
            break;
        }
        const separator_index = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = line[0..separator_index];
        if (!std.ascii.eqlIgnoreCase(name, header_name)) {
            continue;
        }
        return std.mem.trim(u8, line[separator_index + 1 ..], " \t");
    }

    return null;
}

fn parseWebviewIdFromTarget(target: []const u8) ?u32 {
    const query_index = std.mem.indexOfScalar(u8, target, '?') orelse return null;
    const path = target[0..query_index];
    if (!std.mem.eql(u8, path, "/socket")) {
        return null;
    }

    const query = target[query_index + 1 ..];
    var pairs = std.mem.splitScalar(u8, query, '&');
    while (pairs.next()) |pair| {
        const separator_index = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        const name = pair[0..separator_index];
        if (!std.mem.eql(u8, name, "webviewId")) {
            continue;
        }
        const value = pair[separator_index + 1 ..];
        return std.fmt.parseInt(u32, value, 10) catch null;
    }

    return null;
}

fn writeSimpleHttpResponse(out: *std.Io.Writer, status: []const u8, body: []const u8) !void {
    try out.print(
        "HTTP/1.1 {s}\r\nContent-Type: text/plain\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n{s}",
        .{ status, body.len, body },
    );
    try out.flush();
}

fn writeWebSocketHandshake(out: *std.Io.Writer, websocket_key: []const u8) !void {
    var sha1 = std.crypto.hash.Sha1.init(.{});
    sha1.update(websocket_key);
    sha1.update(websocket_magic);

    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    sha1.final(&digest);

    var accept_buffer: [std.base64.standard.Encoder.calcSize(digest.len)]u8 = undefined;
    const accept_value = std.base64.standard.Encoder.encode(&accept_buffer, &digest);

    try out.print(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n",
        .{accept_value},
    );
    try out.flush();
}

const WebSocketFrame = struct {
    opcode: u8,
    payload: []u8,
};

const WebSocketFrameFragment = struct {
    fin: bool,
    opcode: u8,
    payload: []u8,
};

fn readWebSocketFrameFragment(reader: *std.Io.Reader) !WebSocketFrameFragment {
    var header: [2]u8 = undefined;
    reader.readSliceAll(&header) catch |err| switch (err) {
        error.EndOfStream => return error.ConnectionClosed,
        else => return err,
    };

    const fin = (header[0] & 0x80) != 0;
    const opcode = header[0] & 0x0F;
    const masked = (header[1] & 0x80) != 0;
    var payload_len: usize = header[1] & 0x7F;

    if (!masked) {
        return error.InvalidWebSocketFrame;
    }
    if (!fin and opcode >= 0x8) {
        return error.InvalidWebSocketFrame;
    }

    if (payload_len == 126) {
        var extended: [2]u8 = undefined;
        try reader.readSliceAll(&extended);
        payload_len = (@as(usize, extended[0]) << 8) | @as(usize, extended[1]);
    } else if (payload_len == 127) {
        var extended: [8]u8 = undefined;
        try reader.readSliceAll(&extended);
        var parsed_len: u64 = 0;
        for (extended) |byte| {
            parsed_len = (parsed_len << 8) | @as(u64, byte);
        }
        payload_len = std.math.cast(usize, parsed_len) orelse return error.WebSocketFrameTooLarge;
    }

    if (payload_len > websocket_payload_limit) {
        return error.WebSocketFrameTooLarge;
    }

    var mask: [4]u8 = undefined;
    try reader.readSliceAll(&mask);

    const payload = try allocator.alloc(u8, payload_len);
    errdefer allocator.free(payload);
    try reader.readSliceAll(payload);

    for (payload, 0..) |*byte, index| {
        byte.* ^= mask[index % mask.len];
    }

    return .{
        .fin = fin,
        .opcode = opcode,
        .payload = payload,
    };
}

fn readWebSocketFrame(reader: *std.Io.Reader) !WebSocketFrame {
    const first = try readWebSocketFrameFragment(reader);

    if (first.fin or first.opcode >= 0x8) {
        return .{
            .opcode = first.opcode,
            .payload = first.payload,
        };
    }

    if (first.opcode == 0x0) {
        allocator.free(first.payload);
        return error.InvalidWebSocketFrame;
    }

    // Chromium may fragment large client sends; reassemble continuation frames before dispatch.
    var payload: std.ArrayList(u8) = .empty;
    errdefer payload.deinit(allocator);

    payload.appendSlice(allocator, first.payload) catch |err| {
        allocator.free(first.payload);
        return err;
    };
    allocator.free(first.payload);

    while (true) {
        const next = try readWebSocketFrameFragment(reader);
        defer allocator.free(next.payload);

        if (next.opcode >= 0x8) {
            continue;
        }
        if (next.opcode != 0x0) {
            return error.InvalidWebSocketFrame;
        }
        if (payload.items.len + next.payload.len > websocket_payload_limit) {
            return error.WebSocketFrameTooLarge;
        }

        try payload.appendSlice(allocator, next.payload);

        if (next.fin) {
            break;
        }
    }

    return .{
        .opcode = first.opcode,
        .payload = try payload.toOwnedSlice(allocator),
    };
}

fn writeWebSocketFrame(stream: std.Io.net.Stream, opcode: u8, payload: []const u8) !void {
    var header: [10]u8 = undefined;
    var header_len: usize = 0;

    header[header_len] = 0x80 | (opcode & 0x0F);
    header_len += 1;

    if (payload.len <= 125) {
        header[header_len] = @intCast(payload.len);
        header_len += 1;
    } else if (payload.len <= std.math.maxInt(u16)) {
        header[header_len] = 126;
        header_len += 1;
        header[header_len] = @intCast((payload.len >> 8) & 0xFF);
        header[header_len + 1] = @intCast(payload.len & 0xFF);
        header_len += 2;
    } else {
        header[header_len] = 127;
        header_len += 1;
        var shift: u6 = 56;
        while (true) {
            header[header_len] = @intCast((@as(u64, @intCast(payload.len)) >> shift) & 0xFF);
            header_len += 1;
            if (shift == 0) {
                break;
            }
            shift -= 8;
        }
    }

    var write_buffer: [1024]u8 = undefined;
    var stream_writer = stream.writer(coreIo(), &write_buffer);
    const out = &stream_writer.interface;
    try out.writeAll(header[0..header_len]);
    if (payload.len > 0) {
        try out.writeAll(payload);
    }
    try out.flush();
}

fn writeWebSocketFrameSerialized(stream: std.Io.net.Stream, opcode: u8, payload: []const u8) !void {
    host_transport_socket_write_mutex.lockUncancelable(coreIo());
    defer host_transport_socket_write_mutex.unlock(coreIo());
    try writeWebSocketFrame(stream, opcode, payload);
}

fn compactPendingHostTransportSendsLocked() void {
    if (pending_host_transport_sends_head == 0) {
        return;
    }

    const len = pending_host_transport_sends.items.len;
    if (pending_host_transport_sends_head >= len) {
        pending_host_transport_sends.clearRetainingCapacity();
        pending_host_transport_sends_head = 0;
        return;
    }

    if (pending_host_transport_sends_head < 1024 and pending_host_transport_sends_head * 2 < len) {
        return;
    }

    const remaining = len - pending_host_transport_sends_head;
    std.mem.copyForwards(
        PendingHostTransportSend,
        pending_host_transport_sends.items[0..remaining],
        pending_host_transport_sends.items[pending_host_transport_sends_head..len],
    );
    pending_host_transport_sends.shrinkRetainingCapacity(remaining);
    pending_host_transport_sends_head = 0;
}

fn hostTransportSendWorker() void {
    while (true) {
        pending_host_transport_sends_mutex.lockUncancelable(coreIo());
        while (pending_host_transport_sends_head >= pending_host_transport_sends.items.len) {
            compactPendingHostTransportSendsLocked();
            pending_host_transport_sends_condition.waitUncancelable(coreIo(), &pending_host_transport_sends_mutex);
        }
        const entry = pending_host_transport_sends.items[pending_host_transport_sends_head];
        pending_host_transport_sends_head += 1;
        compactPendingHostTransportSendsLocked();
        pending_host_transport_sends_mutex.unlock(coreIo());

        defer allocator.free(entry.payload);

        if (!isCurrentWebviewSocketHandle(entry.webview_id, entry.socket_handle)) {
            incrementHostTransportDebug("socket_write_stale");
            continue;
        }

        const stream = streamFromSocketHandle(entry.socket_handle);
        writeWebSocketFrameSerialized(stream, entry.opcode, entry.payload) catch {
            incrementHostTransportDebug("socket_write_errors");
            clearWebviewSocketHandleIfCurrent(entry.webview_id, entry.socket_handle);
            continue;
        };
        incrementHostTransportDebug("socket_write_frames");
    }
}

fn ensureHostTransportSendWorkerStarted() bool {
    pending_host_transport_sends_mutex.lockUncancelable(coreIo());
    defer pending_host_transport_sends_mutex.unlock(coreIo());

    if (pending_host_transport_send_worker_started) {
        return true;
    }

    const thread = std.Thread.spawn(.{}, hostTransportSendWorker, .{}) catch |err| {
        setLastError("Failed to start host transport send worker: {s}", .{@errorName(err)});
        return false;
    };
    thread.detach();
    pending_host_transport_send_worker_started = true;
    return true;
}

fn enqueueHostTransportSend(webview_id: u32, socket_handle: std.posix.socket_t, opcode: u8, payload: []u8) bool {
    if (!ensureHostTransportSendWorkerStarted()) {
        allocator.free(payload);
        return false;
    }

    pending_host_transport_sends_mutex.lockUncancelable(coreIo());
    defer pending_host_transport_sends_mutex.unlock(coreIo());

    pending_host_transport_sends.append(allocator, .{
        .webview_id = webview_id,
        .socket_handle = socket_handle,
        .opcode = opcode,
        .payload = payload,
    }) catch |err| {
        allocator.free(payload);
        setLastError("Failed to queue host transport send: {s}", .{@errorName(err)});
        return false;
    };
    incrementHostTransportDebug("socket_write_queued");
    pending_host_transport_sends_condition.signal(coreIo());
    return true;
}

fn encryptHostTransportPacket(message_json: []const u8, secret_key: WebviewSecretKey) ![]u8 {
    var nonce: [Aes256Gcm.nonce_length]u8 = undefined;
    coreIo().random(&nonce);

    const ciphertext = try allocator.alloc(u8, message_json.len);
    defer allocator.free(ciphertext);

    var tag: [Aes256Gcm.tag_length]u8 = undefined;
    Aes256Gcm.encrypt(ciphertext, &tag, message_json, "", nonce, secret_key);

    const encrypted_data_b64 = try encodeBase64Alloc(ciphertext);
    defer allocator.free(encrypted_data_b64);
    const nonce_b64 = try encodeBase64Alloc(&nonce);
    defer allocator.free(nonce_b64);
    const tag_b64 = try encodeBase64Alloc(&tag);
    defer allocator.free(tag_b64);

    return try std.json.Stringify.valueAlloc(allocator, .{
        .encryptedData = encrypted_data_b64,
        .iv = nonce_b64,
        .tag = tag_b64,
    }, .{});
}

fn decryptHostTransportPacket(message_json: []const u8, secret_key: WebviewSecretKey) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, message_json, .{});
    defer parsed.deinit();

    if (parsed.value != .object) {
        return error.InvalidTransportPacket;
    }

    const encrypted_data_value = parsed.value.object.get("encryptedData") orelse return error.InvalidTransportPacket;
    const iv_value = parsed.value.object.get("iv") orelse return error.InvalidTransportPacket;
    const tag_value = parsed.value.object.get("tag") orelse return error.InvalidTransportPacket;

    if (encrypted_data_value != .string or iv_value != .string or tag_value != .string) {
        return error.InvalidTransportPacket;
    }

    const encrypted_data = try decodeBase64Alloc(encrypted_data_value.string);
    defer allocator.free(encrypted_data);
    const nonce_bytes = try decodeBase64Alloc(iv_value.string);
    defer allocator.free(nonce_bytes);
    const tag_bytes = try decodeBase64Alloc(tag_value.string);
    defer allocator.free(tag_bytes);

    if (nonce_bytes.len != Aes256Gcm.nonce_length or tag_bytes.len != Aes256Gcm.tag_length) {
        return error.InvalidTransportPacket;
    }

    var nonce: [Aes256Gcm.nonce_length]u8 = undefined;
    @memcpy(nonce[0..], nonce_bytes);

    var tag: [Aes256Gcm.tag_length]u8 = undefined;
    @memcpy(tag[0..], tag_bytes);

    const plaintext = try allocator.alloc(u8, encrypted_data.len);
    errdefer allocator.free(plaintext);
    try Aes256Gcm.decrypt(plaintext, encrypted_data, tag, "", nonce, secret_key);
    return plaintext;
}

fn isPlaintextHostTransportPacket(message_json: []const u8) bool {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, message_json, .{}) catch return false;
    defer parsed.deinit();

    if (parsed.value != .object) return false;
    const type_value = parsed.value.object.get("type") orelse return false;
    if (type_value != .string) return false;

    return std.mem.eql(u8, type_value.string, "message") or
        std.mem.eql(u8, type_value.string, "request") or
        std.mem.eql(u8, type_value.string, "response");
}

fn enqueueHostTransportPlaintext(webview_id: u32, context: WebviewTransportContext, plaintext: []const u8) void {
    if (context.socket_handle) |socket_handle| {
        markWebviewTransportReady(webview_id, socket_handle);
    }

    const message_z = allocator.dupeZ(u8, plaintext) catch return;
    defer allocator.free(message_z);

    enqueuePendingHostMessage(webview_id, message_z.ptr);
}

fn dispatchHostTransportMessage(webview_id: u32, encrypted_packet: []const u8) void {
    incrementHostTransportDebug("frames_dispatched");
    const context = lookupWebviewTransportContext(webview_id) orelse return;

    const plaintext = decryptHostTransportPacket(encrypted_packet, context.secret_key) catch {
        if (context.plaintext_transport and isPlaintextHostTransportPacket(encrypted_packet)) {
            enqueueHostTransportPlaintext(webview_id, context, encrypted_packet);
            return;
        }
        incrementHostTransportDebug("decrypt_errors");
        return;
    };
    incrementHostTransportDebug("decrypt_ok");
    defer allocator.free(plaintext);
    enqueueHostTransportPlaintext(webview_id, context, plaintext);
}

fn handleHostTransportConnection(stream: std.Io.net.Stream) void {
    const io = coreIo();
    incrementHostTransportDebug("connections");
    defer stream.close(io);

    var read_buffer: [16 * 1024]u8 = undefined;
    var write_buffer: [1024]u8 = undefined;
    var stream_reader = stream.reader(io, &read_buffer);
    var stream_writer = stream.writer(io, &write_buffer);
    const in = &stream_reader.interface;
    const out = &stream_writer.interface;
    var server = std.http.Server.init(in, out);
    const request = server.receiveHead() catch return;

    const websocket_key = parseRequestHeaderValue(request.head_buffer, "Sec-WebSocket-Key") orelse {
        writeSimpleHttpResponse(out, "400 Bad Request", "Missing Sec-WebSocket-Key") catch {};
        return;
    };
    const webview_id = parseWebviewIdFromTarget(request.head.target) orelse {
        writeSimpleHttpResponse(out, "400 Bad Request", "Missing webviewId") catch {};
        return;
    };

    if (lookupWebviewState(webview_id) == null) {
        writeSimpleHttpResponse(out, "404 Not Found", "Unknown webviewId") catch {};
        return;
    }

    writeWebSocketHandshake(out, websocket_key) catch return;

    if (!attachWebviewSocketHandle(webview_id, stream.socket.handle)) {
        return;
    }

    // Any bytes the client sent after the HTTP head remain buffered in `in`,
    // so WebSocket frames are read from the same reader.
    while (true) {
        const frame = readWebSocketFrame(in) catch |err| switch (err) {
            error.ConnectionClosed => break,
            else => break,
        };
        incrementHostTransportDebug("frames_read");
        defer allocator.free(frame.payload);

        switch (frame.opcode) {
            0x1 => dispatchHostTransportMessage(webview_id, frame.payload),
            0x8 => {
                writeWebSocketFrameSerialized(stream, 0x8, "") catch {};
                break;
            },
            0x9 => writeWebSocketFrameSerialized(stream, 0xA, frame.payload) catch break,
            else => {},
        }
    }

    clearWebviewSocketHandleIfCurrent(webview_id, stream.socket.handle);
}

fn hostTransportAcceptLoop(server: std.Io.net.Server) void {
    const io = coreIo();
    var listener = server;
    while (true) {
        const connection_stream = listener.accept(io) catch break;
        const thread = std.Thread.spawn(.{}, handleHostTransportConnection, .{connection_stream}) catch {
            connection_stream.close(io);
            continue;
        };
        thread.detach();
    }

    host_transport_mutex.lockUncancelable(coreIo());
    host_transport_state.started = false;
    host_transport_state.port = 0;
    host_transport_mutex.unlock(coreIo());
}

fn startHostTransportServer(requested_port: u32) bool {
    host_transport_mutex.lockUncancelable(coreIo());
    defer host_transport_mutex.unlock(coreIo());

    if (host_transport_state.started) {
        webview_runtime_state.rpc_port = host_transport_state.port;
        return true;
    }

    var current_port: u16 = if (requested_port == 0)
        websocket_port_range_start
    else
        std.math.cast(u16, requested_port) orelse {
            setLastError("Requested websocket port is out of range: {d}", .{requested_port});
            return false;
        };
    const port_limit: u16 = if (requested_port == 0)
        websocket_port_range_end
    else
        current_port;

    while (true) {
        const address = std.Io.net.IpAddress.parse("127.0.0.1", current_port) catch |err| {
            setLastError("Failed to parse websocket listen address: {s}", .{@errorName(err)});
            return false;
        };

        var server = address.listen(coreIo(), .{ .reuse_address = true }) catch |err| switch (err) {
            error.AddressInUse => {
                if (current_port == port_limit) {
                    break;
                }
                current_port += 1;
                continue;
            },
            else => {
                setLastError("Failed to start websocket server: {s}", .{@errorName(err)});
                return false;
            },
        };

        // The loop always binds a concrete port, so the bound port is known.
        const actual_port = current_port;
        const thread = std.Thread.spawn(.{}, hostTransportAcceptLoop, .{server}) catch |err| {
            server.deinit(coreIo());
            setLastError("Failed to spawn websocket server thread: {s}", .{@errorName(err)});
            return false;
        };
        thread.detach();

        host_transport_state.started = true;
        host_transport_state.port = actual_port;
        webview_runtime_state.rpc_port = actual_port;
        return true;
    }

    setLastError("Unable to find an available websocket port", .{});
    return false;
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
        return allocPrintZ(
            allocator,
            \\window.__electrobunPlatform = "{s}";
            \\window.__electrobunWebviewId = {d};
            \\window.__electrobunWindowId = {d};
            \\window.__electrobunEventBridge = window.__electrobunEventBridge || window.webkit?.messageHandlers?.eventBridge || window.eventBridge || window.chrome?.webview?.hostObjects?.eventBridge;
            \\window.__electrobunInternalBridge = window.__electrobunInternalBridge || window.webkit?.messageHandlers?.internalBridge || window.internalBridge || window.chrome?.webview?.hostObjects?.internalBridge;
            \\{s}
        ,
            .{ @tagName(builtin.os.tag), webview_id, window_id, sandboxed_preload_script },
        ) catch |err| {
            setLastError("Failed to build sandboxed preload script: {s}", .{@errorName(err)});
            return null;
        };
    }

    const preload_script = webview_runtime_state.preload_script.?;
    return allocPrintZ(
        allocator,
        \\window.__electrobunPlatform = "{s}";
        \\window.__electrobunWebviewId = {d};
        \\window.__electrobunWindowId = {d};
        \\window.__electrobunHostSocketPort = {d};
        \\window.__electrobunRpcSocketPort = {d};
        \\window.__electrobunSecretKeyBytes = [{s}];
        \\window.__electrobunEventBridge = window.__electrobunEventBridge || window.webkit?.messageHandlers?.eventBridge || window.eventBridge || window.chrome?.webview?.hostObjects?.eventBridge;
        \\window.__electrobunInternalBridge = window.__electrobunInternalBridge || window.webkit?.messageHandlers?.internalBridge || window.internalBridge || window.chrome?.webview?.hostObjects?.internalBridge;
        \\window.__electrobunHostBridge = window.__electrobunHostBridge || window.__electrobunBunBridge || window.webkit?.messageHandlers?.hostBridge || window.webkit?.messageHandlers?.bunBridge || window.hostBridge || window.bunBridge || window.chrome?.webview?.hostObjects?.hostBridge || window.chrome?.webview?.hostObjects?.bunBridge;
        \\window.__electrobunBunBridge = window.__electrobunBunBridge || window.webkit?.messageHandlers?.bunBridge || window.bunBridge || window.chrome?.webview?.hostObjects?.bunBridge;
        \\{s}
    ,
        .{
            @tagName(builtin.os.tag),
            webview_id,
            window_id,
            webview_runtime_state.rpc_port,
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

    if (!startHostTransportServer(rpc_port)) {
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
    const exe_path = try std.process.executablePathAlloc(coreIo(), allocator);
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

    var native_wrapper = CoreDynLib.open(native_wrapper_path) catch |err| {
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

// Platform-specific wrapper capabilities are optional so adding one does not
// expand the common NativeWrapper ABI required from every operating system.
fn lookupOptionalNativeSymbol(comptime T: type, comptime name: [:0]const u8) ?T {
    if (!ensureNativeWrapperLoaded()) {
        return null;
    }
    return native_wrapper_state.lib.lookup(T, name);
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
    ) callconv(.c) TrayPtr;
    const SetNativeTrayMenuFn = *const fn (TrayPtr, [*:0]const u8) callconv(.c) void;

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
    const RemoveNativeTrayFn = *const fn (TrayPtr) callconv(.c) void;

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
    window_registry_mutex.lockUncancelable(coreIo());
    defer window_registry_mutex.unlock(coreIo());
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
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());
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
    wgpu_view_registry_mutex.lockUncancelable(coreIo());
    defer wgpu_view_registry_mutex.unlock(coreIo());
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

fn hasOpenWindows() bool {
    window_registry_mutex.lockUncancelable(coreIo());
    defer window_registry_mutex.unlock(coreIo());
    return window_registry.count() > 0;
}

fn collectWebviewIdsForWindow(window_id: u32, list: *std.ArrayList(u32)) void {
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());

    var iterator = webview_registry.iterator();
    while (iterator.next()) |entry| {
        if (entry.value_ptr.window_id == window_id) {
            list.append(allocator, entry.key_ptr.*) catch return;
        }
    }
}

fn collectWgpuViewIdsForWindow(window_id: u32, list: *std.ArrayList(u32)) void {
    wgpu_view_registry_mutex.lockUncancelable(coreIo());
    defer wgpu_view_registry_mutex.unlock(coreIo());

    var iterator = wgpu_view_registry.iterator();
    while (iterator.next()) |entry| {
        if (entry.value_ptr.window_id == window_id) {
            list.append(allocator, entry.key_ptr.*) catch return;
        }
    }
}

fn loadManagedHTMLForWebview(webview_id: u32, html: [*:0]const u8) void {
    const state = lookupWebviewState(webview_id) orelse return;

    if (state.renderer == .cef) {
        const SetWebviewHTMLContentFn = *const fn (u32, [*:0]const u8) callconv(.c) void;
        const set_webview_html_content = lookupNativeSymbol(SetWebviewHTMLContentFn, "setWebviewHTMLContent") orelse return;
        set_webview_html_content(webview_id, html);
        loadURLInWebView(webview_id, "views://internal/index.html");
        return;
    }

    loadHTMLInWebView(webview_id, html);
}

fn allocateOwnedJavascriptString(
    comptime fmt: []const u8,
    args: anytype,
) ?[:0]u8 {
    return allocPrintZ(allocator, fmt, args) catch |err| {
        setLastError("Failed to allocate javascript string: {s}", .{@errorName(err)});
        return null;
    };
}

fn quoteJavascriptString(value: [*:0]const u8) ?[]u8 {
    return std.json.Stringify.valueAlloc(allocator, std.mem.span(value), .{}) catch |err| {
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

    const encoded_detail = quoteJavascriptString(detail) orelse return null;
    defer allocator.free(encoded_detail);

    const event_name_slice = std.mem.span(event_name);
    if (std.mem.eql(u8, event_name_slice, "new-window-open") or std.mem.eql(u8, event_name_slice, "host-message")) {
        return allocateOwnedJavascriptString(
            "document.querySelector('#electrobun-webview-{d}').emit({s}, (() => {{ try {{ return JSON.parse({s}); }} catch {{ return {s}; }} }})());",
            .{ webview_id, encoded_event_name, encoded_detail, encoded_detail },
        );
    }

    return allocateOwnedJavascriptString(
        "document.querySelector('#electrobun-webview-{d}').emit({s}, {s});",
        .{ webview_id, encoded_event_name, encoded_detail },
    );
}

fn buildInternalMessageJavascript(message_json: [*:0]const u8) ?[:0]u8 {
    return allocateOwnedJavascriptString(
        "window.__electrobun.receiveInternalMessageFromHost({s});",
        .{std.mem.span(message_json)},
    );
}

fn jsonString(value: std.json.Value) ?[]const u8 {
    return switch (value) {
        .string => |string_value| string_value,
        .number_string => |string_value| string_value,
        else => null,
    };
}

fn jsonBool(value: std.json.Value) ?bool {
    return switch (value) {
        .bool => |bool_value| bool_value,
        else => null,
    };
}

fn jsonU32(value: std.json.Value) ?u32 {
    return switch (value) {
        .integer => |integer_value| blk: {
            if (integer_value < 0 or integer_value > std.math.maxInt(u32)) break :blk null;
            break :blk @intCast(integer_value);
        },
        .float => |float_value| blk: {
            if (!std.math.isFinite(float_value)) break :blk null;
            if (@floor(float_value) != float_value) break :blk null;
            if (float_value < 0 or float_value > std.math.maxInt(u32)) break :blk null;
            break :blk @intFromFloat(float_value);
        },
        .number_string => |string_value| std.fmt.parseInt(u32, string_value, 10) catch null,
        else => null,
    };
}

fn jsonF64(value: std.json.Value) ?f64 {
    return switch (value) {
        .integer => |integer_value| @floatFromInt(integer_value),
        .float => |float_value| float_value,
        .number_string => |string_value| std.fmt.parseFloat(f64, string_value) catch null,
        else => null,
    };
}

fn duplicateSentinelString(value: []const u8) ?[:0]u8 {
    return allocator.dupeZ(u8, value) catch null;
}

const InternalRect = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

fn parseInternalRect(value: std.json.Value) ?InternalRect {
    if (value != .object) {
        return null;
    }

    const object = value.object;
    const x = jsonF64(object.get("x") orelse return null) orelse return null;
    const y = jsonF64(object.get("y") orelse return null) orelse return null;
    const width = jsonF64(object.get("width") orelse return null) orelse return null;
    const height = jsonF64(object.get("height") orelse return null) orelse return null;
    return .{ .x = x, .y = y, .width = width, .height = height };
}

fn sendInternalBridgeResponse(
    host_webview_id: u32,
    request_id: []const u8,
    success: bool,
    payload: anytype,
) void {
    const encoded_id = std.json.Stringify.valueAlloc(allocator, request_id, .{}) catch return;
    defer allocator.free(encoded_id);

    const payload_json = std.json.Stringify.valueAlloc(allocator, payload, .{}) catch return;
    defer allocator.free(payload_json);

    const response_json = allocPrintZ(
        allocator,
        "{{\"type\":\"response\",\"id\":{s},\"success\":{s},\"payload\":{s}}}",
        .{ encoded_id, if (success) "true" else "false", payload_json },
    ) catch return;
    defer allocator.free(response_json);

    _ = sendInternalMessageToWebview(host_webview_id, response_json.ptr);
}

fn dispatchStoredWebviewEvent(source_webview_id: u32, payload: std.json.Value) void {
    if (payload != .object) {
        return;
    }

    const state = lookupWebviewState(source_webview_id) orelse return;
    const handler = state.webview_event_handler orelse return;
    const payload_object = payload.object;
    const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
    if (webview_id != source_webview_id) return;
    const event_name = jsonString(payload_object.get("eventName") orelse return) orelse return;
    const detail = jsonString(payload_object.get("detail") orelse return) orelse return;

    const event_name_z = allocator.dupeZ(u8, event_name) catch return;
    defer allocator.free(event_name_z);
    const detail_z = allocator.dupeZ(u8, detail) catch return;
    defer allocator.free(detail_z);

    handler(webview_id, event_name_z.ptr, detail_z.ptr);
}

fn createManagedWebviewFromInternalRequest(params: std.json.Value) ?u32 {
    if (params != .object) {
        return null;
    }

    const callbacks = default_webview_callbacks;
    if (callbacks.webview_event_handler == null or callbacks.event_bridge_handler == null) {
        return null;
    }

    const params_object = params.object;
    const host_webview_id = jsonU32(params_object.get("hostWebviewId") orelse return null) orelse return null;
    const window_id = jsonU32(params_object.get("windowId") orelse return null) orelse return null;
    const renderer = jsonString(params_object.get("renderer") orelse return null) orelse return null;
    const partition = jsonString(params_object.get("partition") orelse return null) orelse "persist:default";
    const frame = parseInternalRect(params_object.get("frame") orelse return null) orelse return null;
    const sandbox = jsonBool(params_object.get("sandbox") orelse .{ .bool = false }) orelse false;
    const transparent = jsonBool(params_object.get("transparent") orelse .{ .bool = false }) orelse false;
    const passthrough = jsonBool(params_object.get("passthrough") orelse .{ .bool = false }) orelse false;
    const spell_check = jsonBool(params_object.get("spellCheck") orelse .{ .bool = false }) orelse false;
    const url_value = params_object.get("url");
    const html_value = params_object.get("html");
    const preload_value = params_object.get("preload");
    const navigation_rules_value = params_object.get("navigationRules");

    var secret_key: WebviewSecretKey = undefined;
    coreIo().random(&secret_key);

    var secret_key_buffer: std.ArrayList(u8) = .empty;
    defer secret_key_buffer.deinit(allocator);
    for (secret_key, 0..) |byte, index| {
        if (index > 0) {
            secret_key_buffer.append(allocator, ',') catch return null;
        }
        secret_key_buffer.print(allocator, "{d}", .{byte}) catch return null;
    }
    secret_key_buffer.append(allocator, 0) catch return null;
    const secret_key_z = secret_key_buffer.toOwnedSliceSentinel(allocator, 0) catch return null;
    defer allocator.free(secret_key_z);

    const url = if (url_value) |value| jsonString(value) orelse "" else "";
    const preload = if (preload_value) |value| jsonString(value) orelse "" else "";
    const renderer_z = duplicateSentinelString(renderer) orelse return null;
    defer allocator.free(renderer_z);
    const partition_z = duplicateSentinelString(partition) orelse return null;
    defer allocator.free(partition_z);
    const url_z = duplicateSentinelString(if (html_value != null and html_value.? != .null) "" else url) orelse return null;
    defer allocator.free(url_z);
    const preload_z = duplicateSentinelString(preload) orelse return null;
    defer allocator.free(preload_z);

    const rules_json = if (navigation_rules_value) |value|
        if (value == .null)
            null
        else
            std.json.Stringify.valueAlloc(allocator, value, .{}) catch return null
    else
        null;
    defer if (rules_json) |allocated| allocator.free(allocated);

    const webview_id = createWebview(
        window_id,
        host_webview_id,
        renderer_z.ptr,
        url_z.ptr,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        false,
        partition_z.ptr,
        callbacks.navigation_callback,
        callbacks.webview_event_handler,
        callbacks.event_bridge_handler,
        null,
        null,
        secret_key_z.ptr,
        preload_z.ptr,
        "",
        sandbox,
        transparent,
        passthrough,
        spell_check,
    );

    if (webview_id == 0) {
        return null;
    }

    if (html_value) |value| {
        const html = jsonString(value) orelse "";
        if (html.len > 0) {
            const html_z = duplicateSentinelString(html) orelse return webview_id;
            defer allocator.free(html_z);
            loadManagedHTMLForWebview(webview_id, html_z.ptr);
        }
    }

    if (rules_json) |allocated| {
        const rules_json_z = duplicateSentinelString(allocated) orelse return webview_id;
        defer allocator.free(rules_json_z);
        setWebviewNavigationRules(webview_id, rules_json_z.ptr);
    }

    return webview_id;
}

fn createManagedWgpuViewFromInternalRequest(params: std.json.Value) ?u32 {
    if (params != .object) {
        return null;
    }

    const params_object = params.object;
    const window_id = jsonU32(params_object.get("windowId") orelse return null) orelse return null;
    const frame = parseInternalRect(params_object.get("frame") orelse return null) orelse return null;
    const transparent = jsonBool(params_object.get("transparent") orelse .{ .bool = false }) orelse false;
    const passthrough = jsonBool(params_object.get("passthrough") orelse .{ .bool = false }) orelse false;

    const wgpu_view_id = createWGPUView(
        window_id,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        false,
        transparent,
        passthrough,
    );
    if (wgpu_view_id == 0) {
        return null;
    }
    return wgpu_view_id;
}

fn handleInternalRequest(request_object: std.json.ObjectMap) void {
    const method = jsonString(request_object.get("method") orelse return) orelse return;
    const request_id = jsonString(request_object.get("id") orelse return) orelse return;
    const host_webview_id = jsonU32(request_object.get("hostWebviewId") orelse return) orelse return;
    const params = request_object.get("params") orelse .null;

    if (std.mem.eql(u8, method, "webviewTagInit")) {
        const webview_id = createManagedWebviewFromInternalRequest(params) orelse {
            sendInternalBridgeResponse(host_webview_id, request_id, false, "Failed to create webview tag");
            return;
        };
        sendInternalBridgeResponse(host_webview_id, request_id, true, webview_id);
        return;
    }

    if (std.mem.eql(u8, method, "wgpuTagInit")) {
        const wgpu_view_id = createManagedWgpuViewFromInternalRequest(params) orelse {
            sendInternalBridgeResponse(host_webview_id, request_id, false, "Failed to create WGPU view");
            return;
        };
        sendInternalBridgeResponse(host_webview_id, request_id, true, wgpu_view_id);
        return;
    }

    if (std.mem.eql(u8, method, "webviewTagCanGoBack")) {
        if (params != .object) return;
        const webview_id = jsonU32(params.object.get("id") orelse return) orelse return;
        sendInternalBridgeResponse(host_webview_id, request_id, true, webviewCanGoBack(webview_id));
        return;
    }

    if (std.mem.eql(u8, method, "webviewTagCanGoForward")) {
        if (params != .object) return;
        const webview_id = jsonU32(params.object.get("id") orelse return) orelse return;
        sendInternalBridgeResponse(host_webview_id, request_id, true, webviewCanGoForward(webview_id));
        return;
    }

    if (std.mem.eql(u8, method, "webviewTagSetSpellCheck")) {
        if (params != .object) return;
        const webview_id = jsonU32(params.object.get("id") orelse return) orelse return;
        const enabled = jsonBool(params.object.get("enabled") orelse return) orelse return;
        sendInternalBridgeResponse(
            host_webview_id,
            request_id,
            true,
            webviewSetSpellCheck(webview_id, enabled),
        );
        return;
    }

    if (std.mem.eql(u8, method, "restoreWindowFocusAfterExternalDrop")) {
        if (params != .object) return;
        const window_id = jsonU32(params.object.get("windowId") orelse return) orelse return;
        activateWindow(window_id);
        sendInternalBridgeResponse(host_webview_id, request_id, true, true);
        return;
    }

    sendInternalBridgeResponse(host_webview_id, request_id, false, "Unknown internal request");
}

fn handleInternalMessage(source_webview_id: u32, message_id: []const u8, payload: std.json.Value) void {
    if (std.mem.eql(u8, message_id, "webviewEvent")) {
        dispatchStoredWebviewEvent(source_webview_id, payload);
        return;
    }

    if (payload != .object) {
        return;
    }

    const payload_object = payload.object;

    if (std.mem.eql(u8, message_id, "webviewTagResize")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const frame = parseInternalRect(payload_object.get("frame") orelse return) orelse return;
        const masks = if (payload_object.get("masks")) |value| jsonString(value) orelse "[]" else "[]";
        const masks_z = duplicateSentinelString(masks) orelse return;
        defer allocator.free(masks_z);
        resizeWebview(webview_id, frame.x, frame.y, frame.width, frame.height, masks_z.ptr);
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagResize")) {
        const wgpu_view_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const frame = parseInternalRect(payload_object.get("frame") orelse return) orelse return;
        const masks = if (payload_object.get("masks")) |value| jsonString(value) orelse "[]" else "[]";
        const masks_z = duplicateSentinelString(masks) orelse return;
        defer allocator.free(masks_z);
        resizeWGPUView(wgpu_view_id, frame.x, frame.y, frame.width, frame.height, masks_z.ptr);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagUpdateSrc")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const url = jsonString(payload_object.get("url") orelse return) orelse return;
        const url_z = duplicateSentinelString(url) orelse return;
        defer allocator.free(url_z);
        loadURLInWebView(webview_id, url_z.ptr);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagUpdateHtml")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const html = jsonString(payload_object.get("html") orelse return) orelse return;
        const html_z = duplicateSentinelString(html) orelse return;
        defer allocator.free(html_z);
        loadManagedHTMLForWebview(webview_id, html_z.ptr);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagUpdatePreload")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const preload = jsonString(payload_object.get("preload") orelse return) orelse return;
        const preload_z = duplicateSentinelString(preload) orelse return;
        defer allocator.free(preload_z);
        updatePreloadScriptToWebView(webview_id, "electrobun_custom_preload_script", preload_z.ptr, true);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagGoBack")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewGoBack(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagGoForward")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewGoForward(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagReload")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewReload(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagRemove")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewRemove(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "startWindowMove")) {
        const window_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        beginWindowMove(window_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "stopWindowMove")) {
        endWindowMove();
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetTransparent")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const transparent = jsonBool(payload_object.get("transparent") orelse return) orelse return;
        webviewSetTransparent(webview_id, transparent);
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagSetTransparent")) {
        const wgpu_view_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const transparent = jsonBool(payload_object.get("transparent") orelse return) orelse return;
        setWGPUViewTransparent(wgpu_view_id, transparent);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetPassthrough")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const passthrough = jsonBool(payload_object.get("enablePassthrough") orelse return) orelse return;
        webviewSetPassthrough(webview_id, passthrough);
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagSetPassthrough")) {
        const wgpu_view_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const passthrough = jsonBool(payload_object.get("passthrough") orelse return) orelse return;
        setWGPUViewPassthrough(wgpu_view_id, passthrough);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetHidden")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const hidden = jsonBool(payload_object.get("hidden") orelse return) orelse return;
        webviewSetHidden(webview_id, hidden);
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagSetHidden")) {
        const wgpu_view_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const hidden = jsonBool(payload_object.get("hidden") orelse return) orelse return;
        setWGPUViewHidden(wgpu_view_id, hidden);
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagRemove")) {
        const wgpu_view_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        removeWGPUView(wgpu_view_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "wgpuTagRunTest")) {
        const wgpu_view_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        runWGPUViewTest(wgpu_view_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagSetNavigationRules")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const rules_value = payload_object.get("rules") orelse return;
        const rules_json = std.json.Stringify.valueAlloc(allocator, rules_value, .{}) catch return;
        defer allocator.free(rules_json);
        const rules_json_z = duplicateSentinelString(rules_json) orelse return;
        defer allocator.free(rules_json_z);
        setWebviewNavigationRules(webview_id, rules_json_z.ptr);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagFindInPage")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const search_text = jsonString(payload_object.get("searchText") orelse return) orelse return;
        const forward = jsonBool(payload_object.get("forward") orelse return) orelse return;
        const match_case = jsonBool(payload_object.get("matchCase") orelse return) orelse return;
        const search_text_z = duplicateSentinelString(search_text) orelse return;
        defer allocator.free(search_text_z);
        webviewFindInPage(webview_id, search_text_z.ptr, forward, match_case);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagStopFind")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewStopFind(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagOpenDevTools")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewOpenDevTools(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagCloseDevTools")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewCloseDevTools(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagToggleDevTools")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        webviewToggleDevTools(webview_id);
        return;
    }

    if (std.mem.eql(u8, message_id, "webviewTagExecuteJavascript")) {
        const webview_id = jsonU32(payload_object.get("id") orelse return) orelse return;
        const js = jsonString(payload_object.get("js") orelse return) orelse return;
        const js_z = duplicateSentinelString(js) orelse return;
        defer allocator.free(js_z);
        evaluateJavaScriptWithNoCompletion(webview_id, js_z.ptr);
        return;
    }
}

fn handleInternalBridgePacket(source_webview_id: u32, packet: std.json.Value) void {
    if (packet != .object) {
        return;
    }

    const object = packet.object;
    const packet_type = jsonString(object.get("type") orelse return) orelse return;

    if (std.mem.eql(u8, packet_type, "request")) {
        handleInternalRequest(object);
        return;
    }

    if (std.mem.eql(u8, packet_type, "message")) {
        const message_id = jsonString(object.get("id") orelse return) orelse return;
        const payload = object.get("payload") orelse .null;
        handleInternalMessage(source_webview_id, message_id, payload);
    }
}

fn processInternalBridgeBatch(source_webview_id: u32, message_json: []const u8) void {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, message_json, .{}) catch return;
    defer parsed.deinit();

    if (parsed.value == .array) {
        for (parsed.value.array.items) |item| {
            const item_json = jsonString(item) orelse continue;
            var nested = std.json.parseFromSlice(std.json.Value, allocator, item_json, .{}) catch continue;
            defer nested.deinit();
            handleInternalBridgePacket(source_webview_id, nested.value);
        }
        return;
    }

    handleInternalBridgePacket(source_webview_id, parsed.value);
}

fn internalBridgeCoreTrampoline(webview_id: u32, message: [*:0]const u8) callconv(.c) void {
    const state = lookupWebviewState(webview_id) orelse return;
    const message_slice = std.mem.span(message);
    if (state.internal_bridge_handler) |handler| {
        dispatchRuntimePostMessage(handler, webview_id, message_slice);
        return;
    }
    processInternalBridgeBatch(webview_id, message_slice);
}

fn isValidEventBridgeMessage(source_webview_id: u32, message: []const u8) bool {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, message, .{}) catch return false;
    defer parsed.deinit();

    if (parsed.value != .object) return false;
    const object = parsed.value.object;
    const message_id = jsonString(object.get("id") orelse return false) orelse return false;
    if (!std.mem.eql(u8, message_id, "webviewEvent")) return false;
    const message_type = jsonString(object.get("type") orelse return false) orelse return false;
    if (!std.mem.eql(u8, message_type, "message")) return false;

    const payload = object.get("payload") orelse return false;
    if (payload != .object) return false;
    const payload_object = payload.object;
    const claimed_webview_id = jsonU32(payload_object.get("id") orelse return false) orelse return false;
    if (claimed_webview_id != source_webview_id) return false;
    if (jsonString(payload_object.get("eventName") orelse return false) == null) return false;
    if (jsonString(payload_object.get("detail") orelse return false) == null) return false;
    return true;
}

fn eventBridgeCoreTrampoline(webview_id: u32, message: [*:0]const u8) callconv(.c) void {
    const state = lookupWebviewState(webview_id) orelse return;
    const handler = state.event_bridge_handler orelse return;
    const message_slice = std.mem.span(message);
    if (!isValidEventBridgeMessage(webview_id, message_slice)) return;
    dispatchRuntimePostMessage(handler, webview_id, message_slice);
}

fn windowCloseTrampoline(window_id: u32) callconv(.c) void {
    var close_handler: ?WindowCloseHandler = null;
    var child_webview_ids: std.ArrayList(u32) = .empty;
    defer child_webview_ids.deinit(allocator);
    var child_wgpu_view_ids: std.ArrayList(u32) = .empty;
    defer child_wgpu_view_ids.deinit(allocator);

    window_registry_mutex.lockUncancelable(coreIo());
    if (window_registry.fetchRemove(window_id)) |removed| {
        close_handler = removed.value.close_handler;
    }
    window_registry_mutex.unlock(coreIo());

    // Give JS mounts a chance to stop render loops and destroy their devices
    // while child views and WebGPU surfaces are still valid. The global close
    // event then removes JS-owned views; the collection below cleans up any
    // native children that remain.
    if (close_handler) |handler| {
        handler(window_id);
    }

    collectWebviewIdsForWindow(window_id, &child_webview_ids);
    for (child_webview_ids.items) |webview_id| {
        webviewRemove(webview_id);
    }

    collectWgpuViewIdsForWindow(window_id, &child_wgpu_view_ids);
    for (child_wgpu_view_ids.items) |wgpu_view_id| {
        removeWGPUView(wgpu_view_id);
    }

    if (exit_on_last_window_closed and !hasOpenWindows()) {
        if (managed_quit_requested_handler) |handler| {
            handler();
        }
    }
}

fn windowMoveTrampoline(window_id: u32, x: f64, y: f64) callconv(.c) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.move_handler) |handler| {
        handler(window_id, x, y);
    }
}

fn windowResizeTrampoline(window_id: u32, x: f64, y: f64, width: f64, height: f64) callconv(.c) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.resize_handler) |handler| {
        handler(window_id, x, y, width, height);
    }
}

fn windowFocusTrampoline(window_id: u32) callconv(.c) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.focus_handler) |handler| {
        handler(window_id);
    }
}

fn windowBlurTrampoline(window_id: u32) callconv(.c) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.blur_handler) |handler| {
        handler(window_id);
    }
}

fn windowKeyTrampoline(window_id: u32, key_code: u32, modifiers: u32, is_down: u32, is_repeat: u32) callconv(.c) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.key_handler) |handler| {
        handler(window_id, key_code, modifiers, is_down, is_repeat);
    }
}

fn windowShouldCloseTrampoline(window_id: u32) callconv(.c) void {
    const state = lookupWindowState(window_id) orelse return;
    if (state.should_close_handler) |handler| {
        handler(window_id);
    }
}

fn managedQuitRequestedTrampoline() callconv(.c) void {
    if (managed_quit_requested_handler) |handler| {
        handler();
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

    const install_root_name = installRootNameOverride();
    defer if (install_root_name) |value| allocator.free(value);
    native_wrapper_state.start_event_loop(
        identifier,
        name,
        if (install_root_name) |value| value.ptr else channel,
    );
    native_wrapper_state.force_exit(exit_code);
    return 0;
}

test "native profile root override accepts only a safe root leaf" {
    try std.testing.expect(isSafeInstallRootName("stable"));
    try std.testing.expect(isSafeInstallRootName("Legacy App"));
    const invalid = [_][]const u8{ "", ".", "..", "nested/root", "nested\\root", "line\nbreak" };
    for (invalid) |value| try std.testing.expect(!isSafeInstallRootName(value));
    if (builtin.os.tag == .windows) {
        try std.testing.expect(!isSafeInstallRootName("bad:name"));
        try std.testing.expect(!isSafeInstallRootName("trailing."));
    }
}

export fn runNativeEventLoopTick(timeout_ms: c_int) void {
    clearLastError();
    const RunNativeEventLoopTickFn = *const fn (c_int) callconv(.c) void;
    const run_native_event_loop_tick = lookupNativeSymbol(RunNativeEventLoopTickFn, "runNativeEventLoopTick") orelse return;
    run_native_event_loop_tick(timeout_ms);
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
    ) callconv(.c) u32;

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
    centered: bool,
    traffic_light_offset_x: f64,
    traffic_light_offset_y: f64,
    close_handler: ?WindowCloseHandler,
    move_handler: ?WindowMoveHandler,
    resize_handler: ?WindowResizeHandler,
    focus_handler: ?WindowFocusHandler,
    blur_handler: ?WindowBlurHandler,
    key_handler: ?WindowKeyHandler,
    should_close_handler: ?WindowShouldCloseHandler,
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
        ?WindowShouldCloseHandler,
    ) callconv(.c) WindowPtr;
    const SetWindowTitleFn = *const fn (WindowPtr, [*:0]const u8) callconv(.c) void;
    const CenterWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const ShowWindowFn = *const fn (WindowPtr, bool) callconv(.c) void;

    const create_window = lookupNativeSymbol(
        CreateWindowFn,
        "createWindowWithFrameAndStyleFromWorker",
    ) orelse return 0;
    const set_window_title = lookupNativeSymbol(SetWindowTitleFn, "setWindowTitle") orelse return 0;
    const center_window = lookupNativeSymbol(CenterWindowFn, "centerWindow") orelse return 0;
    const show_window = lookupNativeSymbol(ShowWindowFn, "showWindow") orelse return 0;

    window_registry_mutex.lockUncancelable(coreIo());
    const start_id = next_window_id;
    var window_id = next_window_id;

    while (window_id == 0 or window_registry.contains(window_id)) {
        window_id +%= 1;
        if (window_id == 0) {
            window_id = 1;
        }
        if (window_id == start_id) {
            window_registry_mutex.unlock(coreIo());
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
        .should_close_handler = should_close_handler,
        .move_handler = move_handler,
        .resize_handler = resize_handler,
        .focus_handler = focus_handler,
        .blur_handler = blur_handler,
        .key_handler = key_handler,
    }) catch |err| {
        window_registry_mutex.unlock(coreIo());
        setLastError("Failed to store window state: {s}", .{@errorName(err)});
        return 0;
    };
    window_registry_mutex.unlock(coreIo());

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
        if (should_close_handler != null) windowShouldCloseTrampoline else null,
    );

    if (window_ptr == null) {
        window_registry_mutex.lockUncancelable(coreIo());
        _ = window_registry.remove(window_id);
        window_registry_mutex.unlock(coreIo());
        setLastError("Failed to create window", .{});
        return 0;
    }

    window_registry_mutex.lockUncancelable(coreIo());
    const state = window_registry.getPtr(window_id) orelse {
        window_registry_mutex.unlock(coreIo());
        setLastError("Window {d} disappeared during creation", .{window_id});
        return 0;
    };
    state.ptr = window_ptr;
    window_registry_mutex.unlock(coreIo());

    set_window_title(window_ptr, title);
    if (centered) {
        center_window(window_ptr);
    }
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
    const SetWindowTitleFn = *const fn (WindowPtr, [*:0]const u8) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_title = lookupNativeSymbol(SetWindowTitleFn, "setWindowTitle") orelse return;
    set_window_title(window, title);
}

export fn minimizeWindow(window_id: u32) void {
    const MinimizeWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const minimize_window = lookupNativeSymbol(MinimizeWindowFn, "minimizeWindow") orelse return;
    minimize_window(window);
}

export fn restoreWindow(window_id: u32) void {
    const RestoreWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const restore_window = lookupNativeSymbol(RestoreWindowFn, "restoreWindow") orelse return;
    restore_window(window);
}

export fn isWindowMinimized(window_id: u32) bool {
    const IsWindowMinimizedFn = *const fn (WindowPtr) callconv(.c) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_minimized = lookupNativeSymbol(IsWindowMinimizedFn, "isWindowMinimized") orelse return false;
    return is_window_minimized(window);
}

export fn maximizeWindow(window_id: u32) void {
    const MaximizeWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const maximize_window = lookupNativeSymbol(MaximizeWindowFn, "maximizeWindow") orelse return;
    maximize_window(window);
}

export fn unmaximizeWindow(window_id: u32) void {
    const UnmaximizeWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const unmaximize_window = lookupNativeSymbol(UnmaximizeWindowFn, "unmaximizeWindow") orelse return;
    unmaximize_window(window);
}

export fn isWindowMaximized(window_id: u32) bool {
    const IsWindowMaximizedFn = *const fn (WindowPtr) callconv(.c) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_maximized = lookupNativeSymbol(IsWindowMaximizedFn, "isWindowMaximized") orelse return false;
    return is_window_maximized(window);
}

export fn setWindowFullScreen(window_id: u32, full_screen: bool) void {
    const SetWindowFullScreenFn = *const fn (WindowPtr, bool) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_full_screen = lookupNativeSymbol(SetWindowFullScreenFn, "setWindowFullScreen") orelse return;
    set_window_full_screen(window, full_screen);
}

export fn isWindowFullScreen(window_id: u32) bool {
    const IsWindowFullScreenFn = *const fn (WindowPtr) callconv(.c) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_full_screen = lookupNativeSymbol(IsWindowFullScreenFn, "isWindowFullScreen") orelse return false;
    return is_window_full_screen(window);
}

export fn setWindowAlwaysOnTop(window_id: u32, always_on_top: bool) void {
    const SetWindowAlwaysOnTopFn = *const fn (WindowPtr, bool) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_always_on_top = lookupNativeSymbol(SetWindowAlwaysOnTopFn, "setWindowAlwaysOnTop") orelse return;
    set_window_always_on_top(window, always_on_top);
}

export fn isWindowAlwaysOnTop(window_id: u32) bool {
    const IsWindowAlwaysOnTopFn = *const fn (WindowPtr) callconv(.c) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_always_on_top = lookupNativeSymbol(IsWindowAlwaysOnTopFn, "isWindowAlwaysOnTop") orelse return false;
    return is_window_always_on_top(window);
}

export fn setWindowVisibleOnAllWorkspaces(window_id: u32, visible_on_all_workspaces: bool) void {
    const SetWindowVisibleOnAllWorkspacesFn = *const fn (WindowPtr, bool) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_visible_on_all_workspaces = lookupNativeSymbol(
        SetWindowVisibleOnAllWorkspacesFn,
        "setWindowVisibleOnAllWorkspaces",
    ) orelse return;
    set_window_visible_on_all_workspaces(window, visible_on_all_workspaces);
}

export fn isWindowVisibleOnAllWorkspaces(window_id: u32) bool {
    const IsWindowVisibleOnAllWorkspacesFn = *const fn (WindowPtr) callconv(.c) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_visible_on_all_workspaces = lookupNativeSymbol(
        IsWindowVisibleOnAllWorkspacesFn,
        "isWindowVisibleOnAllWorkspaces",
    ) orelse return false;
    return is_window_visible_on_all_workspaces(window);
}

export fn setWindowButtonPosition(window_id: u32, x: f64, y: f64) void {
    const SetWindowButtonPositionFn = *const fn (WindowPtr, f64, f64) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_button_position = lookupNativeSymbol(
        SetWindowButtonPositionFn,
        "setWindowButtonPosition",
    ) orelse return;
    set_window_button_position(window, x, y);
}

export fn getWindowButtonPosition(window_id: u32, x: *f64, y: *f64) void {
    x.* = 0;
    y.* = 0;
    const GetWindowButtonPositionFn = *const fn (WindowPtr, *f64, *f64) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const get_window_button_position = lookupNativeSymbol(
        GetWindowButtonPositionFn,
        "getWindowButtonPosition",
    ) orelse return;
    get_window_button_position(window, x, y);
}

export fn showWindow(window_id: u32, activate: bool) void {
    const ShowWindowFn = *const fn (WindowPtr, bool) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const show_window = lookupNativeSymbol(ShowWindowFn, "showWindow") orelse return;
    show_window(window, activate);
}

export fn activateWindow(window_id: u32) void {
    const ActivateWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const activate_window = lookupNativeSymbol(ActivateWindowFn, "activateWindow") orelse return;
    activate_window(window);
}

export fn hideWindow(window_id: u32) void {
    const HideWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const hide_window = lookupNativeSymbol(HideWindowFn, "hideWindow") orelse return;
    hide_window(window);
}

export fn isWindowVisible(window_id: u32) bool {
    const IsWindowVisibleFn = *const fn (WindowPtr) callconv(.c) bool;
    const window = lookupWindowPtr(window_id) orelse return false;
    const is_window_visible = lookupNativeSymbol(IsWindowVisibleFn, "isWindowVisible") orelse return false;
    return is_window_visible(window);
}

export fn closeWindow(window_id: u32) void {
    const CloseWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const close_window = lookupNativeSymbol(CloseWindowFn, "closeWindow") orelse return;
    close_window(window);
}

export fn requestWindowClose(window_id: u32) void {
    const RequestWindowCloseFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const request_window_close = lookupNativeSymbol(
        RequestWindowCloseFn,
        "requestWindowClose",
    ) orelse return;
    request_window_close(window);
}

export fn setWindowPosition(window_id: u32, x: f64, y: f64) void {
    const SetWindowPositionFn = *const fn (WindowPtr, f64, f64) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_position = lookupNativeSymbol(SetWindowPositionFn, "setWindowPosition") orelse return;
    set_window_position(window, x, y);
}

export fn centerWindow(window_id: u32) void {
    const CenterWindowFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const center_window = lookupNativeSymbol(CenterWindowFn, "centerWindow") orelse return;
    center_window(window);
}

export fn setWindowSize(window_id: u32, width: f64, height: f64) void {
    const SetWindowSizeFn = *const fn (WindowPtr, f64, f64) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const set_window_size = lookupNativeSymbol(SetWindowSizeFn, "setWindowSize") orelse return;
    set_window_size(window, width, height);
}

export fn setWindowFrame(window_id: u32, x: f64, y: f64, width: f64, height: f64) void {
    const SetWindowFrameFn = *const fn (WindowPtr, f64, f64, f64, f64) callconv(.c) void;
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
    const GetWindowFrameFn = *const fn (WindowPtr, *f64, *f64, *f64, *f64) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const get_window_frame = lookupNativeSymbol(GetWindowFrameFn, "getWindowFrame") orelse return;
    get_window_frame(window, x, y, width, height);
}

export fn getWindowContentOrigin(window_id: u32, x: *f64, y: *f64) void {
    const GetWindowContentOriginFn = *const fn (WindowPtr, *f64, *f64) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const get_window_content_origin = lookupOptionalNativeSymbol(
        GetWindowContentOriginFn,
        "getWindowContentOrigin",
    );
    if (get_window_content_origin) |get_origin| {
        get_origin(window, x, y);
        return;
    }

    // Wrappers without a distinct content-origin query fall back to their
    // existing frame coordinates. Linux and Windows expose the native client
    // origin because their public frame includes window-manager decorations.
    var width: f64 = 0;
    var height: f64 = 0;
    getWindowFrame(window_id, x, y, &width, &height);
}

export fn beginWindowMove(window_id: u32) void {
    clearLastError();
    const StartWindowMoveFn = *const fn (WindowPtr) callconv(.c) void;
    const window = requireWindowPtr(window_id) orelse return;
    const start_window_move = lookupNativeSymbol(StartWindowMoveFn, "startWindowMove") orelse return;
    start_window_move(window);
}

export fn endWindowMove() void {
    clearLastError();
    const StopWindowMoveFn = *const fn () callconv(.c) void;
    const stop_window_move = lookupNativeSymbol(StopWindowMoveFn, "stopWindowMove") orelse return;
    stop_window_move();
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
    _host_bridge_handler: ?WebviewPostMessageHandler,
    _internal_bridge_handler: ?WebviewPostMessageHandler,
    secret_key: [*:0]const u8,
    custom_preload_script: [*:0]const u8,
    views_root: [*:0]const u8,
    sandbox: bool,
    start_transparent: bool,
    start_passthrough: bool,
    spell_check: bool,
) u32 {
    clearLastError();
    _ = _host_bridge_handler;
    rememberDefaultWebviewCallbacks(
        navigation_callback,
        webview_event_handler,
        event_bridge_handler,
    );

    const SetNextWebviewFlagsFn = *const fn (bool, bool) callconv(.c) void;
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
    ) callconv(.c) WebviewPtr;

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
    const parsed_secret_key = parseWebviewSecretKey(secret_key) orelse return 0;

    webview_registry_mutex.lockUncancelable(coreIo());
    const start_id = next_webview_id;
    var webview_id = next_webview_id;

    while (webview_id == 0 or webview_registry.contains(webview_id)) {
        webview_id +%= 1;
        if (webview_id == 0) {
            webview_id = 1;
        }
        if (webview_id == start_id) {
            webview_registry_mutex.unlock(coreIo());
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
        .window_id = window_id,
        .host_webview_id = if (host_webview_id == 0) null else host_webview_id,
        .renderer = parseWebviewRenderer(renderer),
        .webview_event_handler = webview_event_handler,
        .event_bridge_handler = event_bridge_handler,
        .internal_bridge_handler = _internal_bridge_handler,
        .secret_key = parsed_secret_key,
        .socket_handle = null,
        .transport_ready = false,
        .plaintext_transport = false,
    }) catch |err| {
        webview_registry_mutex.unlock(coreIo());
        setLastError("Failed to store webview state: {s}", .{@errorName(err)});
        return 0;
    };
    webview_registry_mutex.unlock(coreIo());

    const electrobun_preload_script = buildElectrobunPreload(
        webview_id,
        window_id,
        secret_key,
        sandbox,
    ) orelse {
        webview_registry_mutex.lockUncancelable(coreIo());
        _ = webview_registry.remove(webview_id);
        webview_registry_mutex.unlock(coreIo());
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
        if (event_bridge_handler != null) eventBridgeCoreTrampoline else null,
        hostBridgeQueueTrampoline,
        internalBridgeCoreTrampoline,
        electrobun_preload_script.ptr,
        custom_preload_script,
        views_root,
        window_state.transparent,
        sandbox,
    );

    if (webview_ptr == null) {
        webview_registry_mutex.lockUncancelable(coreIo());
        _ = webview_registry.remove(webview_id);
        webview_registry_mutex.unlock(coreIo());
        setLastError("Failed to create webview", .{});
        return 0;
    }

    webview_registry_mutex.lockUncancelable(coreIo());
    const state = webview_registry.getPtr(webview_id) orelse {
        webview_registry_mutex.unlock(coreIo());
        setLastError("Webview {d} disappeared during creation", .{webview_id});
        return 0;
    };
    state.ptr = webview_ptr;
    webview_registry_mutex.unlock(coreIo());

    // `false` preserves the renderer/platform default. An explicit runtime
    // setter can still be used to disable spell checking after enabling it.
    if (spell_check) {
        _ = webviewSetSpellCheck(webview_id, true);
    }

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
    const ResizeWebviewFn = *const fn (WebviewPtr, f64, f64, f64, f64, [*:0]const u8) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const resize_webview = lookupNativeSymbol(ResizeWebviewFn, "resizeWebview") orelse return;
    resize_webview(webview, x, y, width, height, masks_json);
}

export fn loadURLInWebView(webview_id: u32, url: [*:0]const u8) void {
    clearLastError();
    const LoadURLInWebViewFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const load_url_in_webview = lookupNativeSymbol(LoadURLInWebViewFn, "loadURLInWebView") orelse return;
    load_url_in_webview(webview, url);
}

export fn loadHTMLInWebView(webview_id: u32, html: [*:0]const u8) void {
    clearLastError();
    const LoadHTMLInWebViewFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.c) void;
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
    const UpdatePreloadScriptToWebViewFn = *const fn (WebviewPtr, [*:0]const u8, [*:0]const u8, bool) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const update_preload_script_to_webview = lookupNativeSymbol(
        UpdatePreloadScriptToWebViewFn,
        "updatePreloadScriptToWebView",
    ) orelse return;
    update_preload_script_to_webview(webview, script_identifier, script, all_frames);
}

export fn webviewCanGoBack(webview_id: u32) bool {
    clearLastError();
    const WebviewCanGoBackFn = *const fn (WebviewPtr) callconv(.c) bool;
    const webview = lookupWebviewPtr(webview_id) orelse return false;
    const webview_can_go_back = lookupNativeSymbol(WebviewCanGoBackFn, "webviewCanGoBack") orelse return false;
    return webview_can_go_back(webview);
}

export fn webviewCanGoForward(webview_id: u32) bool {
    clearLastError();
    const WebviewCanGoForwardFn = *const fn (WebviewPtr) callconv(.c) bool;
    const webview = lookupWebviewPtr(webview_id) orelse return false;
    const webview_can_go_forward = lookupNativeSymbol(WebviewCanGoForwardFn, "webviewCanGoForward") orelse return false;
    return webview_can_go_forward(webview);
}

export fn webviewGoBack(webview_id: u32) void {
    clearLastError();
    const WebviewGoBackFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_go_back = lookupNativeSymbol(WebviewGoBackFn, "webviewGoBack") orelse return;
    webview_go_back(webview);
}

export fn webviewGoForward(webview_id: u32) void {
    clearLastError();
    const WebviewGoForwardFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_go_forward = lookupNativeSymbol(WebviewGoForwardFn, "webviewGoForward") orelse return;
    webview_go_forward(webview);
}

export fn webviewReload(webview_id: u32) void {
    clearLastError();
    const WebviewReloadFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_reload = lookupNativeSymbol(WebviewReloadFn, "webviewReload") orelse return;
    webview_reload(webview);
}

export fn webviewRemove(webview_id: u32) void {
    clearLastError();
    const WebviewRemoveFn = *const fn (WebviewPtr) callconv(.c) void;

    webview_registry_mutex.lockUncancelable(coreIo());
    const removed = webview_registry.fetchRemove(webview_id);
    webview_registry_mutex.unlock(coreIo());

    const webview = if (removed) |entry| entry.value.ptr else null;
    const socket_handle = if (removed) |entry| entry.value.socket_handle else null;
    if (socket_handle) |handle| {
        // On Windows the connection thread owns a blocking read on this
        // socket. Shutting it down from the UI thread can wedge inside
        // Winsock while the peer WebView2 controller is still alive. Closing
        // the controller below closes the browser endpoint; the connection
        // thread then returns from its read loop and closes its own socket.
        if (builtin.os.tag != .windows) {
            shutdownSocketHandle(handle);
        }
    }
    if (webview == null) {
        return;
    }

    const webview_remove = lookupNativeSymbol(WebviewRemoveFn, "webviewRemove") orelse return;
    webview_remove(webview);
}

export fn setWebviewHTMLContent(webview_id: u32, html: [*:0]const u8) void {
    clearLastError();
    const SetWebviewHTMLContentFn = *const fn (u32, [*:0]const u8) callconv(.c) void;
    const set_webview_html_content = lookupNativeSymbol(SetWebviewHTMLContentFn, "setWebviewHTMLContent") orelse return;
    set_webview_html_content(webview_id, html);
}

export fn webviewSetTransparent(webview_id: u32, transparent: bool) void {
    clearLastError();
    const WebviewSetTransparentFn = *const fn (WebviewPtr, bool) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_transparent = lookupNativeSymbol(WebviewSetTransparentFn, "webviewSetTransparent") orelse return;
    webview_set_transparent(webview, transparent);
}

export fn webviewSetPassthrough(webview_id: u32, passthrough: bool) void {
    clearLastError();
    const WebviewSetPassthroughFn = *const fn (WebviewPtr, bool) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_passthrough = lookupNativeSymbol(WebviewSetPassthroughFn, "webviewSetPassthrough") orelse return;
    webview_set_passthrough(webview, passthrough);
}

export fn webviewSetHidden(webview_id: u32, hidden: bool) void {
    clearLastError();
    const WebviewSetHiddenFn = *const fn (WebviewPtr, bool) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_hidden = lookupNativeSymbol(WebviewSetHiddenFn, "webviewSetHidden") orelse return;
    webview_set_hidden(webview, hidden);
}

export fn webviewSetSpellCheck(webview_id: u32, enabled: bool) bool {
    clearLastError();
    const WebviewSetSpellCheckFn = *const fn (WebviewPtr, bool) callconv(.c) bool;
    const webview = requireWebviewPtr(webview_id) orelse return false;
    const webview_set_spell_check = lookupNativeSymbol(
        WebviewSetSpellCheckFn,
        "webviewSetSpellCheck",
    ) orelse return false;
    return webview_set_spell_check(webview, enabled);
}

export fn setWebviewNavigationRules(webview_id: u32, rules_json: [*:0]const u8) void {
    clearLastError();
    const SetWebviewNavigationRulesFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.c) void;
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
    const WebviewFindInPageFn = *const fn (WebviewPtr, [*:0]const u8, bool, bool) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_find_in_page = lookupNativeSymbol(WebviewFindInPageFn, "webviewFindInPage") orelse return;
    webview_find_in_page(webview, search_text, forward, match_case);
}

export fn webviewStopFind(webview_id: u32) void {
    clearLastError();
    const WebviewStopFindFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_stop_find = lookupNativeSymbol(WebviewStopFindFn, "webviewStopFind") orelse return;
    webview_stop_find(webview);
}

export fn evaluateJavaScriptWithNoCompletion(webview_id: u32, js: [*:0]const u8) void {
    clearLastError();
    const EvaluateJavaScriptWithNoCompletionFn = *const fn (WebviewPtr, [*:0]const u8) callconv(.c) void;
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

export fn clearWebviewHostTransport(webview_id: u32) void {
    clearLastError();
    closeAndClearWebviewSocketHandle(webview_id);
}

export fn setWebviewPlaintextHostTransport(webview_id: u32, enabled: bool) void {
    clearLastError();
    webview_registry_mutex.lockUncancelable(coreIo());
    defer webview_registry_mutex.unlock(coreIo());

    const state = webview_registry.getPtr(webview_id) orelse {
        setLastError("Webview {d} not found", .{webview_id});
        return;
    };
    state.plaintext_transport = enabled;
}

export fn sendHostMessageToWebviewViaTransport(webview_id: u32, message_json: [*:0]const u8) bool {
    clearLastError();

    if (builtin.os.tag == .windows) {
        return false;
    }

    const context = lookupWebviewTransportContext(webview_id) orelse return false;
    if (!context.transport_ready) {
        return false;
    }
    const socket_handle = context.socket_handle orelse return false;

    if (context.plaintext_transport) {
        const plaintext_packet = allocator.dupe(u8, std.mem.span(message_json)) catch |err| {
            setLastError("Failed to allocate host transport packet: {s}", .{@errorName(err)});
            return false;
        };
        return enqueueHostTransportSend(webview_id, socket_handle, 0x1, plaintext_packet);
    }

    const encrypted_packet = encryptHostTransportPacket(std.mem.span(message_json), context.secret_key) catch |err| {
        setLastError("Failed to encrypt host transport packet: {s}", .{@errorName(err)});
        return false;
    };

    return enqueueHostTransportSend(webview_id, socket_handle, 0x1, encrypted_packet);
}

export fn sendPreEncryptedHostMessageToWebviewViaTransport(
    webview_id: u32,
    encrypted_packet_json: [*:0]const u8,
) bool {
    clearLastError();

    if (builtin.os.tag != .linux) {
        return false;
    }

    const context = lookupWebviewTransportContext(webview_id) orelse return false;
    if (!context.transport_ready) {
        return false;
    }
    const socket_handle = context.socket_handle orelse return false;
    const encrypted_packet = allocator.dupe(u8, std.mem.span(encrypted_packet_json)) catch |err| {
        setLastError("Failed to allocate pre-encrypted host transport packet: {s}", .{@errorName(err)});
        return false;
    };

    return enqueueHostTransportSend(webview_id, socket_handle, 0x1, encrypted_packet);
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
    const WebviewOpenDevToolsFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_open_devtools = lookupNativeSymbol(WebviewOpenDevToolsFn, "webviewOpenDevTools") orelse return;
    webview_open_devtools(webview);
}

export fn webviewCloseDevTools(webview_id: u32) void {
    clearLastError();
    const WebviewCloseDevToolsFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_close_devtools = lookupNativeSymbol(WebviewCloseDevToolsFn, "webviewCloseDevTools") orelse return;
    webview_close_devtools(webview);
}

export fn webviewToggleDevTools(webview_id: u32) void {
    clearLastError();
    const WebviewToggleDevToolsFn = *const fn (WebviewPtr) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_toggle_devtools = lookupNativeSymbol(WebviewToggleDevToolsFn, "webviewToggleDevTools") orelse return;
    webview_toggle_devtools(webview);
}

export fn webviewSetPageZoom(webview_id: u32, zoom_level: f64) void {
    clearLastError();
    const WebviewSetPageZoomFn = *const fn (WebviewPtr, f64) callconv(.c) void;
    const webview = requireWebviewPtr(webview_id) orelse return;
    const webview_set_page_zoom = lookupNativeSymbol(WebviewSetPageZoomFn, "webviewSetPageZoom") orelse return;
    webview_set_page_zoom(webview, zoom_level);
}

export fn webviewGetPageZoom(webview_id: u32) f64 {
    clearLastError();
    const WebviewGetPageZoomFn = *const fn (WebviewPtr) callconv(.c) f64;
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
    ) callconv(.c) WgpuViewPtr;

    const window = requireWindowPtr(window_id) orelse return 0;
    const init_wgpu_view = lookupNativeSymbol(InitWGPUViewFn, "initWGPUView") orelse return 0;

    wgpu_view_registry_mutex.lockUncancelable(coreIo());
    const start_id = next_wgpu_view_id;
    var wgpu_view_id = next_wgpu_view_id;

    while (wgpu_view_id == 0 or wgpu_view_registry.contains(wgpu_view_id)) {
        wgpu_view_id +%= 1;
        if (wgpu_view_id == 0) {
            wgpu_view_id = 1;
        }
        if (wgpu_view_id == start_id) {
            wgpu_view_registry_mutex.unlock(coreIo());
            setLastError("Failed to allocate WGPUView id", .{});
            return 0;
        }
    }

    next_wgpu_view_id = wgpu_view_id +% 1;
    if (next_wgpu_view_id == 0) {
        next_wgpu_view_id = 1;
    }

    wgpu_view_registry.put(wgpu_view_id, .{
        .ptr = null,
        .window_id = window_id,
    }) catch |err| {
        wgpu_view_registry_mutex.unlock(coreIo());
        setLastError("Failed to store WGPUView state: {s}", .{@errorName(err)});
        return 0;
    };
    wgpu_view_registry_mutex.unlock(coreIo());

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
        wgpu_view_registry_mutex.lockUncancelable(coreIo());
        _ = wgpu_view_registry.remove(wgpu_view_id);
        wgpu_view_registry_mutex.unlock(coreIo());
        setLastError("Failed to create WGPUView", .{});
        return 0;
    }

    wgpu_view_registry_mutex.lockUncancelable(coreIo());
    const state = wgpu_view_registry.getPtr(wgpu_view_id) orelse {
        wgpu_view_registry_mutex.unlock(coreIo());
        setLastError("WGPUView {d} disappeared during creation", .{wgpu_view_id});
        return 0;
    };
    state.ptr = wgpu_view_ptr;
    wgpu_view_registry_mutex.unlock(coreIo());

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
    const SetWGPUViewFrameFn = *const fn (WgpuViewPtr, f64, f64, f64, f64) callconv(.c) void;
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
    const ResizeWGPUViewFn = *const fn (WgpuViewPtr, f64, f64, f64, f64, [*:0]const u8) callconv(.c) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const resize_wgpu_view = lookupNativeSymbol(ResizeWGPUViewFn, "resizeWebview") orelse return;
    resize_wgpu_view(wgpu_view, x, y, width, height, masks_json);
}

export fn setWGPUViewTransparent(wgpu_view_id: u32, transparent: bool) void {
    clearLastError();
    const SetWGPUViewTransparentFn = *const fn (WgpuViewPtr, bool) callconv(.c) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_transparent = lookupNativeSymbol(
        SetWGPUViewTransparentFn,
        "wgpuViewSetTransparent",
    ) orelse return;
    set_wgpu_view_transparent(wgpu_view, transparent);
}

export fn setWGPUViewPassthrough(wgpu_view_id: u32, passthrough: bool) void {
    clearLastError();
    const SetWGPUViewPassthroughFn = *const fn (WgpuViewPtr, bool) callconv(.c) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_passthrough = lookupNativeSymbol(
        SetWGPUViewPassthroughFn,
        "wgpuViewSetPassthrough",
    ) orelse return;
    set_wgpu_view_passthrough(wgpu_view, passthrough);
}

export fn setWGPUViewHidden(wgpu_view_id: u32, hidden: bool) void {
    clearLastError();
    const SetWGPUViewHiddenFn = *const fn (WgpuViewPtr, bool) callconv(.c) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const set_wgpu_view_hidden = lookupNativeSymbol(SetWGPUViewHiddenFn, "wgpuViewSetHidden") orelse return;
    set_wgpu_view_hidden(wgpu_view, hidden);
}

export fn removeWGPUView(wgpu_view_id: u32) void {
    clearLastError();
    const RemoveWGPUViewFn = *const fn (WgpuViewPtr) callconv(.c) void;

    wgpu_view_registry_mutex.lockUncancelable(coreIo());
    const removed = wgpu_view_registry.fetchRemove(wgpu_view_id);
    wgpu_view_registry_mutex.unlock(coreIo());

    const wgpu_view = if (removed) |entry| entry.value.ptr else null;
    if (wgpu_view == null) {
        return;
    }

    const remove_wgpu_view = lookupNativeSymbol(RemoveWGPUViewFn, "wgpuViewRemove") orelse return;
    remove_wgpu_view(wgpu_view);
}

export fn getWGPUViewNativeHandle(wgpu_view_id: u32) WgpuViewPtr {
    clearLastError();
    const GetWGPUViewNativeHandleFn = *const fn (WgpuViewPtr) callconv(.c) WgpuViewPtr;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return null;
    const get_wgpu_view_native_handle = lookupNativeSymbol(
        GetWGPUViewNativeHandleFn,
        "wgpuViewGetNativeHandle",
    ) orelse return null;
    return get_wgpu_view_native_handle(wgpu_view);
}

export fn runWGPUViewTest(wgpu_view_id: u32) void {
    clearLastError();
    const RunWGPUViewTestFn = *const fn (WgpuViewPtr) callconv(.c) void;
    const wgpu_view = requireWgpuViewPtr(wgpu_view_id) orelse return;
    const run_wgpu_view_test = lookupNativeSymbol(RunWGPUViewTestFn, "wgpuRunGPUTest") orelse return;
    run_wgpu_view_test(wgpu_view);
}

export fn toggleWGPUViewTestShader(wgpu_view_id: u32) void {
    clearLastError();
    const ToggleWGPUViewTestShaderFn = *const fn (WgpuViewPtr) callconv(.c) void;
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

    const SetNativeTrayTitleFn = *const fn (TrayPtr, [*:0]const u8) callconv(.c) void;
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

    const SetNativeTrayImageFn = *const fn (TrayPtr, [*:0]const u8, bool, u32, u32) callconv(.c) void;
    const state = tray_registry.getPtr(tray_id) orelse return;
    if (!replaceOwnedZ(&state.image, image)) {
        return;
    }

    if (state.ptr) |tray_ptr| {
        const set_native_tray_image = lookupNativeSymbol(SetNativeTrayImageFn, "setTrayImage") orelse return;
        set_native_tray_image(
            tray_ptr,
            state.image.ptr,
            state.is_template,
            state.width,
            state.height,
        );
    }
}

export fn setTrayMenu(tray_id: u32, menu_config: [*:0]const u8) void {
    clearLastError();

    const SetNativeTrayMenuFn = *const fn (TrayPtr, [*:0]const u8) callconv(.c) void;
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

    const GetNativeTrayBoundsFn = *const fn (TrayPtr) callconv(.c) ?[*:0]const u8;
    const state = tray_registry.getPtr(tray_id) orelse return empty_rect_json;
    const tray_ptr = state.ptr orelse return empty_rect_json;

    const get_native_tray_bounds = lookupNativeSymbol(GetNativeTrayBoundsFn, "getTrayBounds") orelse {
        return empty_rect_json;
    };
    return get_native_tray_bounds(tray_ptr) orelse empty_rect_json;
}

export fn setApplicationMenu(menu_config: [*:0]const u8, application_menu_handler: ?StatusItemHandler) void {
    const SetApplicationMenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.c) void;
    const set_application_menu = lookupNativeSymbol(
        SetApplicationMenuFn,
        "setApplicationMenu",
    ) orelse return;
    set_application_menu(menu_config, application_menu_handler);
}

export fn showContextMenu(menu_config: [*:0]const u8, context_menu_handler: ?StatusItemHandler) void {
    const ShowContextMenuFn = *const fn ([*:0]const u8, ?StatusItemHandler) callconv(.c) void;
    const show_context_menu = lookupNativeSymbol(
        ShowContextMenuFn,
        "showContextMenu",
    ) orelse return;
    show_context_menu(menu_config, context_menu_handler);
}

export fn moveToTrash(path: [*:0]const u8) bool {
    const MoveToTrashFn = *const fn ([*:0]const u8) callconv(.c) bool;
    const move_to_trash = lookupNativeSymbol(MoveToTrashFn, "moveToTrash") orelse return false;
    return move_to_trash(path);
}

export fn showItemInFolder(path: [*:0]const u8) void {
    const ShowItemInFolderFn = *const fn ([*:0]const u8) callconv(.c) void;
    const show_item_in_folder = lookupNativeSymbol(ShowItemInFolderFn, "showItemInFolder") orelse return;
    show_item_in_folder(path);
}

export fn openExternal(url: [*:0]const u8) bool {
    const OpenExternalFn = *const fn ([*:0]const u8) callconv(.c) bool;
    const open_external = lookupNativeSymbol(OpenExternalFn, "openExternal") orelse return false;
    return open_external(url);
}

export fn openPath(path: [*:0]const u8) bool {
    const OpenPathFn = *const fn ([*:0]const u8) callconv(.c) bool;
    const open_path = lookupNativeSymbol(OpenPathFn, "openPath") orelse return false;
    return open_path(path);
}

export fn showNotification(
    title: [*:0]const u8,
    body: [*:0]const u8,
    subtitle: [*:0]const u8,
    silent: bool,
) void {
    const ShowNotificationFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8, bool) callconv(.c) void;
    const show_notification = lookupNativeSymbol(ShowNotificationFn, "showNotification") orelse return;
    show_notification(title, body, subtitle, silent);
}

export fn setDockIconVisible(visible: bool) void {
    const SetDockIconVisibleFn = *const fn (bool) callconv(.c) void;
    const set_dock_icon_visible = lookupNativeSymbol(SetDockIconVisibleFn, "setDockIconVisible") orelse return;
    set_dock_icon_visible(visible);
}

export fn isDockIconVisible() bool {
    const IsDockIconVisibleFn = *const fn () callconv(.c) bool;
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
    // The native wrapper returns a JSON array so path contents remain lossless.
    const OpenFileDialogFn = *const fn ([*:0]const u8, [*:0]const u8, c_int, c_int, c_int) callconv(.c) ?[*:0]const u8;
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
    ) callconv(.c) c_int;
    const show_message_box = lookupNativeSymbol(ShowMessageBoxFn, "showMessageBox") orelse return -1;
    return show_message_box(box_type, title, message, detail, buttons, default_id, cancel_id);
}

export fn clipboardReadText() ?[*:0]const u8 {
    const ClipboardReadTextFn = *const fn () callconv(.c) ?[*:0]const u8;
    const clipboard_read_text = lookupNativeSymbol(ClipboardReadTextFn, "clipboardReadText") orelse return null;
    return clipboard_read_text();
}

export fn clipboardWriteText(text: [*:0]const u8) void {
    const ClipboardWriteTextFn = *const fn ([*:0]const u8) callconv(.c) void;
    const clipboard_write_text = lookupNativeSymbol(ClipboardWriteTextFn, "clipboardWriteText") orelse return;
    clipboard_write_text(text);
}

export fn clipboardReadImage(out_size: *u64) ?*const anyopaque {
    const ClipboardReadImageFn = *const fn (*u64) callconv(.c) ?*const anyopaque;
    const clipboard_read_image = lookupNativeSymbol(ClipboardReadImageFn, "clipboardReadImage") orelse return null;
    return clipboard_read_image(out_size);
}

export fn clipboardWriteImage(data: ?*const anyopaque, size: u64) void {
    const ClipboardWriteImageFn = *const fn (?*const anyopaque, u64) callconv(.c) void;
    const clipboard_write_image = lookupNativeSymbol(ClipboardWriteImageFn, "clipboardWriteImage") orelse return;
    clipboard_write_image(data, size);
}

export fn clipboardClear() void {
    const ClipboardClearFn = *const fn () callconv(.c) void;
    const clipboard_clear = lookupNativeSymbol(ClipboardClearFn, "clipboardClear") orelse return;
    clipboard_clear();
}

export fn clipboardAvailableFormats() ?[*:0]const u8 {
    const ClipboardAvailableFormatsFn = *const fn () callconv(.c) ?[*:0]const u8;
    const clipboard_available_formats = lookupNativeSymbol(
        ClipboardAvailableFormatsFn,
        "clipboardAvailableFormats",
    ) orelse return null;
    return clipboard_available_formats();
}

export fn getPrimaryDisplay() ?[*:0]const u8 {
    const GetPrimaryDisplayFn = *const fn () callconv(.c) ?[*:0]const u8;
    const get_primary_display = lookupNativeSymbol(GetPrimaryDisplayFn, "getPrimaryDisplay") orelse return null;
    return get_primary_display();
}

export fn getAllDisplays() ?[*:0]const u8 {
    const GetAllDisplaysFn = *const fn () callconv(.c) ?[*:0]const u8;
    const get_all_displays = lookupNativeSymbol(GetAllDisplaysFn, "getAllDisplays") orelse return null;
    return get_all_displays();
}

export fn getCursorScreenPoint() ?[*:0]const u8 {
    const GetCursorScreenPointFn = *const fn () callconv(.c) ?[*:0]const u8;
    const get_cursor_screen_point = lookupNativeSymbol(
        GetCursorScreenPointFn,
        "getCursorScreenPoint",
    ) orelse return null;
    return get_cursor_screen_point();
}

export fn captureScreenRegion(
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    out_rgba: ?[*]u8,
    out_len: u64,
) bool {
    const CaptureScreenRegionFn = *const fn (
        f64,
        f64,
        u32,
        u32,
        ?[*]u8,
        u64,
    ) callconv(.c) bool;
    const capture_screen_region = lookupNativeSymbol(
        CaptureScreenRegionFn,
        "captureScreenRegion",
    ) orelse return false;
    return capture_screen_region(x, y, width, height, out_rgba, out_len);
}

export fn getMouseButtons() u64 {
    const GetMouseButtonsFn = *const fn () callconv(.c) u64;
    const get_mouse_buttons = lookupNativeSymbol(GetMouseButtonsFn, "getMouseButtons") orelse return 0;
    return get_mouse_buttons();
}

export fn setGlobalShortcutCallback(callback: ?GlobalShortcutHandler) void {
    clearLastError();
    const SetGlobalShortcutCallbackFn = *const fn (?GlobalShortcutHandler) callconv(.c) void;
    const set_global_shortcut_callback = lookupNativeSymbol(
        SetGlobalShortcutCallbackFn,
        "setGlobalShortcutCallback",
    ) orelse return;
    set_global_shortcut_callback(callback);
}

export fn registerGlobalShortcut(accelerator: [*:0]const u8) bool {
    clearLastError();
    const RegisterGlobalShortcutFn = *const fn ([*:0]const u8) callconv(.c) bool;
    const register_global_shortcut = lookupNativeSymbol(
        RegisterGlobalShortcutFn,
        "registerGlobalShortcut",
    ) orelse return false;
    return register_global_shortcut(accelerator);
}

export fn unregisterGlobalShortcut(accelerator: [*:0]const u8) bool {
    clearLastError();
    const UnregisterGlobalShortcutFn = *const fn ([*:0]const u8) callconv(.c) bool;
    const unregister_global_shortcut = lookupNativeSymbol(
        UnregisterGlobalShortcutFn,
        "unregisterGlobalShortcut",
    ) orelse return false;
    return unregister_global_shortcut(accelerator);
}

export fn unregisterAllGlobalShortcuts() void {
    clearLastError();
    const UnregisterAllGlobalShortcutsFn = *const fn () callconv(.c) void;
    const unregister_all_global_shortcuts = lookupNativeSymbol(
        UnregisterAllGlobalShortcutsFn,
        "unregisterAllGlobalShortcuts",
    ) orelse return;
    unregister_all_global_shortcuts();
}

export fn isGlobalShortcutRegistered(accelerator: [*:0]const u8) bool {
    clearLastError();
    const IsGlobalShortcutRegisteredFn = *const fn ([*:0]const u8) callconv(.c) bool;
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
    const SessionGetCookiesFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.c) ?[*:0]const u8;
    const session_get_cookies = lookupNativeSymbol(SessionGetCookiesFn, "sessionGetCookies") orelse return null;
    return session_get_cookies(partition_identifier, filter_json);
}

export fn sessionSetCookie(
    partition_identifier: [*:0]const u8,
    cookie_json: [*:0]const u8,
) bool {
    clearLastError();
    const SessionSetCookieFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.c) bool;
    const session_set_cookie = lookupNativeSymbol(SessionSetCookieFn, "sessionSetCookie") orelse return false;
    return session_set_cookie(partition_identifier, cookie_json);
}

export fn sessionRemoveCookie(
    partition_identifier: [*:0]const u8,
    url: [*:0]const u8,
    cookie_name: [*:0]const u8,
) bool {
    clearLastError();
    const SessionRemoveCookieFn = *const fn ([*:0]const u8, [*:0]const u8, [*:0]const u8) callconv(.c) bool;
    const session_remove_cookie = lookupNativeSymbol(SessionRemoveCookieFn, "sessionRemoveCookie") orelse return false;
    return session_remove_cookie(partition_identifier, url, cookie_name);
}

export fn sessionClearCookies(partition_identifier: [*:0]const u8) void {
    clearLastError();
    const SessionClearCookiesFn = *const fn ([*:0]const u8) callconv(.c) void;
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
    const SessionClearStorageDataFn = *const fn ([*:0]const u8, [*:0]const u8) callconv(.c) void;
    const session_clear_storage_data = lookupNativeSymbol(
        SessionClearStorageDataFn,
        "sessionClearStorageData",
    ) orelse return;
    session_clear_storage_data(partition_identifier, storage_types_json);
}

export fn setURLOpenHandler(handler: ?URLOpenHandler) void {
    clearLastError();
    const SetURLOpenHandlerFn = *const fn (?URLOpenHandler) callconv(.c) void;
    const set_url_open_handler = lookupNativeSymbol(SetURLOpenHandlerFn, "setURLOpenHandler") orelse return;
    set_url_open_handler(handler);
}

export fn setAppReopenHandler(handler: ?AppReopenHandler) void {
    clearLastError();
    const SetAppReopenHandlerFn = *const fn (?AppReopenHandler) callconv(.c) void;
    const set_app_reopen_handler = lookupNativeSymbol(
        SetAppReopenHandlerFn,
        "setAppReopenHandler",
    ) orelse return;
    set_app_reopen_handler(handler);
}

export fn setQuitRequestedHandler(handler: ?QuitRequestedHandler) void {
    clearLastError();
    managed_quit_requested_handler = handler;
    const SetQuitRequestedHandlerFn = *const fn (?QuitRequestedHandler) callconv(.c) void;
    const set_quit_requested_handler = lookupNativeSymbol(
        SetQuitRequestedHandlerFn,
        "setQuitRequestedHandler",
    ) orelse return;
    set_quit_requested_handler(if (handler != null) managedQuitRequestedTrampoline else null);
}

export fn setExitOnLastWindowClosed(enabled: bool) void {
    clearLastError();
    exit_on_last_window_closed = enabled;
}

export fn quitGracefully(code: c_int, timeout_ms: c_int) void {
    clearLastError();

    const StopEventLoopFn = *const fn () callconv(.c) void;
    const WaitForShutdownCompleteFn = *const fn (c_int) callconv(.c) void;

    if (lookupNativeSymbol(StopEventLoopFn, "stopEventLoop")) |stop_event_loop| {
        stop_event_loop();
    }

    if (lookupNativeSymbol(WaitForShutdownCompleteFn, "waitForShutdownComplete")) |wait_for_shutdown_complete| {
        wait_for_shutdown_complete(timeout_ms);
    }

    clearPendingRuntimeCallbackPayloads();

    if (ensureNativeWrapperLoaded()) {
        native_wrapper_state.force_exit(code);
    }
}

export fn stopEventLoop() void {
    clearLastError();
    const StopEventLoopFn = *const fn () callconv(.c) void;
    const stop_event_loop = lookupNativeSymbol(StopEventLoopFn, "stopEventLoop") orelse return;
    stop_event_loop();
}

export fn waitForShutdownComplete(timeout_ms: c_int) void {
    clearLastError();
    const WaitForShutdownCompleteFn = *const fn (c_int) callconv(.c) void;
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
    const WgpuCreateSurfaceForViewFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) ?*anyopaque;
    const wgpu_create_surface_for_view = lookupNativeSymbol(
        WgpuCreateSurfaceForViewFn,
        "wgpuCreateSurfaceForView",
    ) orelse return null;
    return wgpu_create_surface_for_view(instance, view_ptr);
}

export fn wgpuReleaseSurfaceForView(surface_ptr: ?*anyopaque) bool {
    clearLastError();
    const WgpuReleaseSurfaceForViewFn = *const fn (?*anyopaque) callconv(.c) void;
    const wgpu_release_surface_for_view = lookupOptionalNativeSymbol(
        WgpuReleaseSurfaceForViewFn,
        "wgpuReleaseSurfaceForView",
    ) orelse return false;
    wgpu_release_surface_for_view(surface_ptr);
    return true;
}

export fn wgpuCreateAdapterDeviceMainThread(
    instance_ptr: ?*anyopaque,
    surface_ptr: ?*anyopaque,
    out_adapter_device: ?*anyopaque,
) void {
    clearLastError();
    const WgpuCreateAdapterDeviceMainThreadFn = *const fn (?*anyopaque, ?*anyopaque, ?*anyopaque) callconv(.c) void;
    const wgpu_create_adapter_device_main_thread = lookupNativeSymbol(
        WgpuCreateAdapterDeviceMainThreadFn,
        "wgpuCreateAdapterDeviceMainThread",
    ) orelse return;
    wgpu_create_adapter_device_main_thread(instance_ptr, surface_ptr, out_adapter_device);
}

export fn wgpuSurfaceConfigureMainThread(surface_ptr: ?*anyopaque, config_ptr: ?*anyopaque) void {
    clearLastError();
    const WgpuSurfaceConfigureMainThreadFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
    const wgpu_surface_configure_main_thread = lookupNativeSymbol(
        WgpuSurfaceConfigureMainThreadFn,
        "wgpuSurfaceConfigureMainThread",
    ) orelse return;
    wgpu_surface_configure_main_thread(surface_ptr, config_ptr);
}

export fn wgpuSurfaceCapabilitiesFreeMembersShim(capabilities_ptr: ?*anyopaque) void {
    clearLastError();
    const WgpuSurfaceCapabilitiesFreeMembersShimFn = *const fn (?*anyopaque) callconv(.c) void;
    const wgpu_surface_capabilities_free_members = lookupNativeSymbol(
        WgpuSurfaceCapabilitiesFreeMembersShimFn,
        "wgpuSurfaceCapabilitiesFreeMembersShim",
    ) orelse return;
    wgpu_surface_capabilities_free_members(capabilities_ptr);
}

export fn wgpuSurfaceGetCurrentTextureMainThread(surface_ptr: ?*anyopaque, surface_texture_ptr: ?*anyopaque) void {
    clearLastError();
    const WgpuSurfaceGetCurrentTextureMainThreadFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.c) void;
    const wgpu_surface_get_current_texture_main_thread = lookupNativeSymbol(
        WgpuSurfaceGetCurrentTextureMainThreadFn,
        "wgpuSurfaceGetCurrentTextureMainThread",
    ) orelse return;
    wgpu_surface_get_current_texture_main_thread(surface_ptr, surface_texture_ptr);
}

export fn wgpuSurfacePresentMainThread(surface_ptr: ?*anyopaque) i32 {
    clearLastError();
    const WgpuSurfacePresentMainThreadFn = *const fn (?*anyopaque) callconv(.c) i32;
    const wgpu_surface_present_main_thread = lookupNativeSymbol(
        WgpuSurfacePresentMainThreadFn,
        "wgpuSurfacePresentMainThread",
    ) orelse return -1;
    return wgpu_surface_present_main_thread(surface_ptr);
}

test "event bridge requires the native sender identity" {
    try std.testing.expect(isValidEventBridgeMessage(
        17,
        "{\"id\":\"webviewEvent\",\"type\":\"message\",\"payload\":{\"id\":17,\"eventName\":\"host-message\",\"detail\":\"{\\\"message\\\":\\\"hello\\\"}\"}}",
    ));
    try std.testing.expect(!isValidEventBridgeMessage(
        17,
        "{\"id\":\"webviewEvent\",\"type\":\"message\",\"payload\":{\"id\":99,\"eventName\":\"host-message\",\"detail\":\"spoofed\"}}",
    ));
    try std.testing.expect(!isValidEventBridgeMessage(
        17,
        "{\"id\":\"webviewEvent\",\"type\":\"message\",\"payload\":{\"id\":17,\"eventName\":42,\"detail\":\"invalid\"}}",
    ));
}

test "host webview JSON events encode detail as data" {
    const js = buildHostWebviewEventJavascript(
        7,
        "host-message",
        "null); globalThis.pwned = \"yes\"; //",
    ) orelse return error.OutOfMemory;
    defer allocator.free(js);

    try std.testing.expect(std.mem.indexOf(
        u8,
        js,
        "JSON.parse(\"null); globalThis.pwned = \\\"yes\\\"; //\")",
    ) != null);
    try std.testing.expect(std.mem.indexOf(
        u8,
        js,
        "catch { return \"null); globalThis.pwned = \\\"yes\\\"; //\"; }",
    ) != null);
}

var captured_runtime_callback_payload: ?[*:0]const u8 = null;

fn captureRuntimeCallbackPayload(_: u32, payload: [*:0]const u8) callconv(.c) void {
    captured_runtime_callback_payload = payload;
}

test "asynchronous runtime bridge payloads require explicit release" {
    clearPendingRuntimeCallbackPayloads();
    runtime_callbacks_async = true;
    defer {
        runtime_callbacks_async = false;
        clearPendingRuntimeCallbackPayloads();
        captured_runtime_callback_payload = null;
    }

    dispatchRuntimePostMessage(captureRuntimeCallbackPayload, 7, "owned payload");
    const payload = captured_runtime_callback_payload orelse return error.MissingPayload;

    try std.testing.expectEqualStrings("owned payload", std.mem.span(payload));
    try std.testing.expect(releaseRuntimeCallbackPayload(payload));
    try std.testing.expect(!releaseRuntimeCallbackPayload(payload));
}
