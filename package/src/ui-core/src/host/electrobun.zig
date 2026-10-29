//! Electrobun host: renders a UI instance into an Electrobun WGPU view.
//! Input, IME and frame callbacks arrive on the main thread from
//! libNativeWrapper (wgpuViewSetUIHandlers); the app thread mutates the UI
//! through the C ABI. Both take the UI lock (capi.lock).
const std = @import("std");
const builtin = @import("builtin");
const capi = @import("../capi.zig");
const ui_mod = @import("../ui.zig");
const events = @import("../events.zig");
const wgpu = @import("../render/wgpu.zig");
const gpu = @import("../render/gpu.zig");
const geom = @import("../geom.zig");
const a11y = @import("../a11y.zig");
const dynlib = @import("../platform/dynlib.zig");

const gpa = std.heap.c_allocator;

const PointerCb = *const fn (?*anyopaque, u32, f64, f64, f64, f64, u32) callconv(.c) void;
const KeyCb = *const fn (?*anyopaque, u32, u32, u32, u32, [*:0]const u8, [*:0]const u8) callconv(.c) u32;
const TextCb = *const fn (?*anyopaque, u32, [*:0]const u8, u32) callconv(.c) void;
const FrameCb = *const fn (?*anyopaque, f64) callconv(.c) void;
const A11yRequestCb = *const fn (?*anyopaque) callconv(.c) void;
const A11yActionCb = *const fn (?*anyopaque, u32, u32, [*:0]const u8) callconv(.c) void;

const Native = struct {
    /// Synthetic input can call native clipboard/window-drag APIs. Dispatch
    /// input before acquiring capi.lock, just like real native input.
    runOnMainThread: ?capi.ThreadDispatch,
    setUIHandlers: *const fn (?*anyopaque, ?*anyopaque, ?PointerCb, ?KeyCb, ?TextCb, ?FrameCb) callconv(.c) void,
    requestFrame: *const fn (?*anyopaque) callconv(.c) void,
    setImeRect: *const fn (?*anyopaque, f64, f64, f64, f64) callconv(.c) void,
    getMetrics: *const fn (?*anyopaque, *f64, *f64, *f64) callconv(.c) void,
    /// macOS: the CAMetalLayer; Windows: the HWND; Linux: the X11 window XID
    getNativeHandle: *const fn (?*anyopaque) callconv(.c) ?*anyopaque,
    /// Linux: the Xlib Display* the view's window lives on
    getNativeDisplay: ?*const fn (?*anyopaque) callconv(.c) ?*anyopaque,
    /// modal on macOS: returns after release, true if the window moved
    beginWindowDrag: *const fn (?*anyopaque) callconv(.c) bool,
    setCursor: *const fn ([*:0]const u8) callconv(.c) void,
    setA11yHandlers: ?*const fn (?*anyopaque, ?*anyopaque, ?A11yRequestCb, ?A11yActionCb) callconv(.c) void,
    setA11yTree: ?*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void,
    clipboardReadText: ?*const fn () callconv(.c) ?[*:0]const u8,
    clipboardWriteText: ?*const fn ([*:0]const u8) callconv(.c) void,
    /// frees clipboardReadText's result with the wrapper's C runtime
    clipboardFreeText: ?*const fn ([*:0]const u8) callconv(.c) void,
    /// Windows: render through a premultiplied DirectComposition swapchain
    /// instead of the view's (opaque) HWND surface; see `Composition`
    composition: ?Composition = null,
};

/// The Windows wrapper's composition bridge (wgpuViewComposition*). Dawn's
/// own swapchains ignore alpha on Windows, so a transparent UI renders into
/// a texture the wrapper shows with DirectComposition. Main thread.
const Composition = struct {
    configure: *const fn (?*anyopaque, wgpu.Device, u32, u32) callconv(.c) bool,
    acquire: *const fn (?*anyopaque) callconv(.c) ?wgpu.Texture,
    present: *const fn (?*anyopaque) callconv(.c) bool,
    release: *const fn (?*anyopaque) callconv(.c) void,

    fn load() ?Composition {
        if (builtin.os.tag != .windows) return null;
        return .{
            .configure = sym(@FieldType(Composition, "configure"), "wgpuViewCompositionConfigure") orelse return null,
            .acquire = sym(@FieldType(Composition, "acquire"), "wgpuViewCompositionAcquire") orelse return null,
            .present = sym(@FieldType(Composition, "present"), "wgpuViewCompositionPresent") orelse return null,
            .release = sym(@FieldType(Composition, "release"), "wgpuViewCompositionRelease") orelse return null,
        };
    }
};

var native: ?Native = null;

/// Electrobun's native wrapper is already loaded in the process; its file
/// names per platform (CEF builds on Linux use a separate wrapper).
const native_wrapper_names: []const [:0]const u8 = switch (builtin.os.tag) {
    .windows => &.{"libNativeWrapper.dll"},
    .macos => &.{},
    else => &.{ "libNativeWrapper.so", "libNativeWrapper_cef.so" },
};

fn sym(comptime T: type, name: [:0]const u8) ?T {
    return dynlib.loadedSymbol(T, native_wrapper_names, name);
}

fn loadNative() ?Native {
    if (native) |n| return n;
    native = .{
        .runOnMainThread = sym(capi.ThreadDispatch, "uiRunOnMainThread") orelse return null,
        .setUIHandlers = sym(@FieldType(Native, "setUIHandlers"), "wgpuViewSetUIHandlers") orelse return null,
        .requestFrame = sym(@FieldType(Native, "requestFrame"), "wgpuViewRequestFrame") orelse return null,
        .setImeRect = sym(@FieldType(Native, "setImeRect"), "wgpuViewSetImeRect") orelse return null,
        .getMetrics = sym(@FieldType(Native, "getMetrics"), "wgpuViewGetMetrics") orelse return null,
        .getNativeHandle = sym(@FieldType(Native, "getNativeHandle"), "wgpuViewGetNativeHandle") orelse return null,
        .getNativeDisplay = sym(*const fn (?*anyopaque) callconv(.c) ?*anyopaque, "wgpuViewGetNativeDisplay"),
        .beginWindowDrag = sym(@FieldType(Native, "beginWindowDrag"), "wgpuViewBeginWindowDrag") orelse return null,
        .setCursor = sym(@FieldType(Native, "setCursor"), "uiSetCursor") orelse return null,
        .setA11yHandlers = sym(*const fn (?*anyopaque, ?*anyopaque, ?A11yRequestCb, ?A11yActionCb) callconv(.c) void, "wgpuViewSetAccessibilityHandlers"),
        .setA11yTree = sym(*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void, "wgpuViewSetAccessibilityTree"),
        .clipboardReadText = sym(*const fn () callconv(.c) ?[*:0]const u8, "clipboardReadText"),
        .clipboardWriteText = sym(*const fn ([*:0]const u8) callconv(.c) void, "clipboardWriteText"),
        .clipboardFreeText = sym(*const fn ([*:0]const u8) callconv(.c) void, "clipboardFreeText"),
        .composition = Composition.load(),
    };
    return native;
}

// Dawn is shared by every view.
var dawn_api: ?*wgpu.Api = null;
var dawn_instance: ?wgpu.Instance = null;
var dawn_ctx: ?wgpu.Context = null;

const View = struct {
    /// Never reused: a queued callback must not resolve to a new attachment
    /// merely because its predecessor's allocation address was recycled.
    callback_id: usize,
    ui_id: u32,
    view: *anyopaque,
    surface: wgpu.Surface,
    renderer: *gpu.Renderer,
    px_w: u32 = 0,
    px_h: u32 = 0,
    scale: f32 = 2,
    alpha_mode: u32 = wgpu.alpha_mode_premultiplied,
    /// how frames reach the screen; decided at the first frame from
    /// Ui.transparent (a transparent UI on Windows needs composition)
    present_path: enum { undecided, surface, composition } = .undecided,
    /// the surface or composition bridge matches px_w x px_h
    configured: bool = false,
    start: f64 = 0,
    force: bool = true,
    in_frame: bool = false,
    /// an assistive technology has queried the view
    a11y_active: bool = false,
    a11y_version: u64 = 0,
    a11y_time: f64 = 0,
    /// presented frames (tests)
    frames: u64 = 0,
    capture_requested: bool = false,
    capture: ?[]u8 = null,
    capture_w: u32 = 0,
    capture_h: u32 = 0,
};

var views: std.ArrayList(*View) = .empty;
var next_callback_id: usize = 1;

fn viewFor(ui_id: u32) ?*View {
    for (views.items) |v| if (v.ui_id == ui_id) return v;
    return null;
}

/// The view behind a native callback's ctx, or null once it is detached.
/// Callbacks run on the main thread and can race ebui_detach_view on the app
/// thread (a callback already dispatched when the handlers are cleared), so
/// every callback resolves its opaque attachment ID here, under the lock,
/// before using it. Native callbacks never retain a dereferenceable View*.
fn liveView(ctx: ?*anyopaque) ?*View {
    const p = ctx orelse return null;
    for (views.items) |v| if (v.callback_id == @intFromPtr(p)) return v;
    return null;
}

fn callbackContext(hv: *View) ?*anyopaque {
    return @ptrFromInt(hv.callback_id);
}

const SurfaceHandles = struct {
    handle: *anyopaque,
    display: ?*anyopaque = null,

    /// Native handle lookup may synchronously dispatch to the event thread
    /// (AppKit's CAMetalLayer). Do this before locking the shared UI state.
    /// The caller owns the native view for the entire attach/detach operation.
    fn resolve(n: Native, v: *anyopaque) ?SurfaceHandles {
        const handle = n.getNativeHandle(v) orelse {
            std.log.err("ebui: view has no native surface handle", .{});
            return null;
        };
        if (builtin.os.tag == .macos or builtin.os.tag == .windows) return .{ .handle = handle };
        const getDisplay = n.getNativeDisplay orelse {
            std.log.err("ebui: native wrapper lacks wgpuViewGetNativeDisplay", .{});
            return null;
        };
        const display = getDisplay(v) orelse {
            std.log.err("ebui: view has no X11 display", .{});
            return null;
        };
        return .{ .handle = handle, .display = display };
    }
};

/// A Dawn surface using handles already sampled outside the UI lock.
fn createSurface(api: *wgpu.Api, instance: wgpu.Instance, handles: SurfaceHandles) ?wgpu.Surface {
    switch (builtin.os.tag) {
        .macos => {
            var src = wgpu.SurfaceSourceMetalLayer{ .layer = handles.handle };
            return api.instanceCreateSurface(instance, &.{ .next = &src.chain });
        },
        .windows => {
            var src = wgpu.SurfaceSourceWindowsHWND{ .hinstance = GetModuleHandleW(null), .hwnd = handles.handle };
            return api.instanceCreateSurface(instance, &.{ .next = &src.chain });
        },
        else => {
            var src = wgpu.SurfaceSourceXlibWindow{ .display = handles.display.?, .window = @intFromPtr(handles.handle) };
            return api.instanceCreateSurface(instance, &.{ .next = &src.chain });
        },
    }
}

extern "kernel32" fn GetModuleHandleW(name: ?[*:0]const u16) callconv(.winapi) ?*anyopaque;

/// Premultiplied alpha where the surface supports it (Metal, DirectComposition),
/// opaque otherwise (X11/Vulkan surfaces usually offer only opaque/inherit).
fn pickAlphaMode(api: *wgpu.Api, surface: wgpu.Surface, adapter: wgpu.Adapter) u32 {
    var caps = wgpu.SurfaceCapabilities{};
    if (api.surfaceGetCapabilities(surface, adapter, &caps) != wgpu.status_success) return wgpu.alpha_mode_auto;
    defer api.surfaceCapabilitiesFreeMembers(caps);
    const modes = if (caps.alpha_modes) |m| m[0..caps.alpha_mode_count] else &[_]u32{};
    for ([_]u32{ wgpu.alpha_mode_premultiplied, wgpu.alpha_mode_opaque }) |want| {
        for (modes) |m| if (m == want) return want;
    }
    return wgpu.alpha_mode_auto;
}

/// Attach a UI instance to an Electrobun WGPU view (AbstractView*). Call
/// from any thread; returns false if the native wrapper or Dawn is missing.
pub export fn ebui_attach_wgpu_view(ui_id: u32, view: ?*anyopaque, dawn_path: ?[*:0]const u8) bool {
    capi.lock();
    const resolved = loadNative();
    capi.unlock();
    const n = resolved orelse {
        std.log.err("ebui: native wrapper symbols missing", .{});
        return false;
    };
    const v = view orelse return false;
    const handles = SurfaceHandles.resolve(n, v) orelse return false;
    capi.lock();
    const hv = attachLocked(ui_id, v, dawn_path, n, handles);
    capi.unlock();
    const attached = hv orelse return false;
    // Publish only the fully initialized context. AppKit handler registration
    // waits for main, whose existing frame callbacks may need the UI lock.
    n.setUIHandlers(attached.view, callbackContext(attached), onPointer, onKey, onText, onFrame);
    if (n.setA11yHandlers) |f| f(attached.view, callbackContext(attached), onA11yRequest, onA11yAction);
    n.requestFrame(attached.view);
    return true;
}

fn attachLocked(ui_id: u32, v: *anyopaque, dawn_path: ?[*:0]const u8, n: Native, handles: SurfaceHandles) ?*View {
    const ui = capi.engine(ui_id) orelse return null;
    if (viewFor(ui_id) != null) return null;
    if (next_callback_id == std.math.maxInt(usize)) return null;
    if (dawn_api == null) {
        const api = gpa.create(wgpu.Api) catch return null;
        const path = if (dawn_path) |p| std.mem.span(p) else wgpu.defaultLibraryPath();
        api.* = wgpu.Api.load(path) catch |e| {
            std.log.err("ebui: cannot load Dawn from {s}: {}", .{ path, e });
            gpa.destroy(api);
            return null;
        };
        dawn_api = api;
        dawn_instance = api.createInstance(null);
    }
    const api = dawn_api.?;
    const instance = dawn_instance orelse return null;
    const surface = createSurface(api, instance, handles) orelse return null;
    if (dawn_ctx == null) {
        dawn_ctx = wgpu.Context.createWithInstance(api, instance, surface) catch |e| {
            std.log.err("ebui: no WebGPU device: {}", .{e});
            return null;
        };
        dawn_ctx.?.logAdapter();
    }
    const r = gpu.Renderer.init(gpa, api, dawn_ctx.?, ui.fonts, wgpu.TextureFormat.bgra8_unorm) catch return null;
    r.store = &ui.images;
    const hv = gpa.create(View) catch return null;
    hv.* = .{ .callback_id = next_callback_id, .ui_id = ui_id, .view = v, .surface = surface, .renderer = r, .start = now(), .alpha_mode = pickAlphaMode(api, surface, dawn_ctx.?.adapter) };
    next_callback_id += 1;
    views.append(gpa, hv) catch return null;
    ui.ix.host = .{
        .ctx = callbackContext(hv),
        .set_cursor = setCursor,
        .clipboard_read = clipboardRead,
        .clipboard_write = clipboardWrite,
        .ime_rect = imeRect,
        .begin_window_drag = beginDrag,
        .request_frame = requestFrameCb,
    };
    if (capi.instance(ui_id)) |inst| {
        inst.request_frame = requestFrameFromCapi;
        inst.request_frame_ctx = callbackContext(hv);
        inst.input_dispatch = n.runOnMainThread;
    }
    return hv;
}

pub export fn ebui_detach_view(ui_id: u32) void {
    detachView(ui_id, releaseView);
}

fn detachView(ui_id: u32, comptime release: fn (*View) void) void {
    capi.lock();
    const hv = retireView(ui_id);
    const n = native;
    capi.unlock();
    const retired = hv orelse return;
    // Keep the context allocated until main has removed its handlers. A frame
    // already dispatched before retirement can acquire the lock and find no
    // liveView; it cannot mistake this address for a subsequently attached UI.
    // Never wait for main while holding capi.lock (main may be in onFrame).
    if (n) |api| {
        api.setUIHandlers(retired.view, null, null, null, null, null);
        if (api.setA11yHandlers) |f| f(retired.view, null, null, null);
        if (retired.present_path == .composition) if (api.composition) |c| c.release(retired.view);
    }
    capi.lock();
    defer capi.unlock();
    release(retired);
}

/// Stop accepting callbacks before dropping the lock to unregister with the
/// native host. An in-progress callback holds this lock, so it finishes first.
fn retireView(ui_id: u32) ?*View {
    const hv = viewFor(ui_id) orelse return null;
    for (views.items, 0..) |x, i| if (x == hv) {
        _ = views.swapRemove(i);
        break;
    };
    if (capi.instance(ui_id)) |inst| {
        inst.request_frame = null;
        inst.request_frame_ctx = null;
        inst.input_dispatch = null;
        inst.ui.ix.host = .{};
    }
    return hv;
}

fn releaseView(hv: *View) void {
    hv.renderer.deinit();
    if (dawn_api) |api| api.surfaceRelease(hv.surface);
    if (hv.capture) |pixels| gpa.free(pixels);
    gpa.destroy(hv);
}

fn now() f64 {
    if (builtin.os.tag == .windows) {
        var freq: i64 = 0;
        var counter: i64 = 0;
        _ = QueryPerformanceFrequency(&freq);
        _ = QueryPerformanceCounter(&counter);
        return @as(f64, @floatFromInt(counter)) / @as(f64, @floatFromInt(@max(freq, 1)));
    }
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) + @as(f64, @floatFromInt(ts.nsec)) / 1e9;
}

extern "kernel32" fn QueryPerformanceFrequency(freq: *i64) callconv(.winapi) c_int;
extern "kernel32" fn QueryPerformanceCounter(count: *i64) callconv(.winapi) c_int;

fn requestFrameFromCapi(ctx: ?*anyopaque) void {
    const hv = liveView(ctx) orelse return;
    if (hv.in_frame) return;
    if (native) |n| n.requestFrame(hv.view);
}

fn requestFrameCb(ctx: ?*anyopaque) void {
    requestFrameFromCapi(ctx);
}

fn uiOf(hv: *View) ?*ui_mod.Ui {
    return capi.engine(hv.ui_id);
}

fn onPointer(ctx: ?*anyopaque, kind: u32, x: f64, y: f64, a: f64, b: f64, mods_raw: u32) callconv(.c) void {
    capi.lock();
    defer capi.unlock();
    const hv = liveView(ctx) orelse return;
    const ui = uiOf(hv) orelse return;
    const m = mods(mods_raw);
    const fx: f32 = @floatCast(x);
    const fy: f32 = @floatCast(y);
    switch (kind) {
        0 => ui.ix.pointerMove(fx, fy, m),
        1 => ui.ix.pointerDown(fx, fy, @intFromFloat(a), m),
        2 => ui.ix.pointerUp(fx, fy, @intFromFloat(a), m),
        3 => ui.ix.wheel(fx, fy, @floatCast(-a), @floatCast(-b), m),
        5 => ui.ix.pointerLeaveWindow(),
        else => {},
    }
    hv.force = hv.force or ui.doc.needs_paint;
    if (native) |n| n.requestFrame(hv.view);
}

fn mods(raw: u32) events.Modifiers {
    return .{ .shift = raw & 1 != 0, .ctrl = raw & 2 != 0, .alt = raw & 4 != 0, .meta = raw & 8 != 0 };
}

/// The DOM key name of a non-printable key, or null for printable keys.
///
/// Key contract: on Windows and Linux `code` is unused (0) and
/// `charactersIgnoringModifiers` carries the DOM `key` value ("Enter",
/// "ArrowLeft", "a", "A", ...), so each wrapper maps its own key codes once.
/// The macOS wrapper still sends virtual key codes (TODO: move it to the same
/// contract and drop macNamedKey).
fn namedKey(code: u32, key: []const u8) ?[]const u8 {
    if (builtin.os.tag == .macos) return macNamedKey(code);
    return if (isNamedKeyValue(key)) key else null;
}

/// DOM named key values are ASCII identifiers ("Enter", "F5"); printable key
/// values are a single character (possibly multi-byte).
fn isNamedKeyValue(key: []const u8) bool {
    if (key.len < 2) return false;
    for (key) |c| if (!std.ascii.isAlphanumeric(c)) return false;
    return std.ascii.isUpper(key[0]);
}

fn macNamedKey(code: u32) ?[]const u8 {
    return switch (code) {
        36, 76 => "Enter",
        48 => "Tab",
        51 => "Backspace",
        53 => "Escape",
        117 => "Delete",
        115 => "Home",
        119 => "End",
        116 => "PageUp",
        121 => "PageDown",
        123 => "ArrowLeft",
        124 => "ArrowRight",
        125 => "ArrowDown",
        126 => "ArrowUp",
        else => null,
    };
}

fn onKey(ctx: ?*anyopaque, code: u32, mods_raw: u32, down: u32, repeat: u32, chars: [*:0]const u8, raw: [*:0]const u8) callconv(.c) u32 {
    _ = repeat;
    capi.lock();
    defer capi.unlock();
    const hv = liveView(ctx) orelse return 0;
    const ui = uiOf(hv) orelse return 0;
    const m = mods(mods_raw);
    defer if (native) |n| n.requestFrame(hv.view);
    if (namedKey(code, std.mem.span(raw))) |k| {
        if (down != 0) ui.ix.keyDown(k, m) else ui.ix.keyUp(k, m);
        return 1;
    }
    if (m.meta or m.ctrl) {
        const k = std.mem.span(raw);
        if (down != 0) ui.ix.keyDown(k, m) else ui.ix.keyUp(k, m);
        return 1;
    }
    const k = std.mem.span(chars);
    if (down != 0) ui.ix.keyDown(k, m) else ui.ix.keyUp(std.mem.span(raw), m);
    // printable keys go on to the input method for text insertion
    return 0;
}

fn onText(ctx: ?*anyopaque, kind: u32, text: [*:0]const u8, sel: u32) callconv(.c) void {
    capi.lock();
    defer capi.unlock();
    const hv = liveView(ctx) orelse return;
    const ui = uiOf(hv) orelse return;
    const t = std.mem.span(text);
    switch (kind) {
        0 => ui.ix.textInput(t),
        1 => ui.ix.setComposition(t, sel),
        2 => {
            // commit the current composition as-is
            const doc = ui.doc;
            if (doc.focused != 0) if (ui.ix.edits.get(doc.focused)) |e| if (e.composing) |cr| {
                const committed = gpa.dupe(u8, e.text.items[cr[0]..cr[1]]) catch return;
                defer gpa.free(committed);
                ui.ix.textInput(committed);
            };
        },
        else => {},
    }
    if (native) |n| n.requestFrame(hv.view);
}

fn onFrame(ctx: ?*anyopaque, t: f64) callconv(.c) void {
    _ = t;
    capi.lock();
    defer capi.unlock();
    const hv = liveView(ctx) orelse return;
    const ui = uiOf(hv) orelse return;
    const n = native orelse return;
    hv.in_frame = true;
    defer hv.in_frame = false;
    var w: f64 = 0;
    var h: f64 = 0;
    var scale: f64 = 2;
    n.getMetrics(hv.view, &w, &h, &scale);
    if (w < 1 or h < 1) return;
    const pw: u32 = @intFromFloat(@round(w * scale));
    const ph: u32 = @intFromFloat(@round(h * scale));
    if (pw != hv.px_w or ph != hv.px_h or @as(f32, @floatCast(scale)) != hv.scale) {
        hv.px_w = pw;
        hv.px_h = ph;
        hv.scale = @floatCast(scale);
        hv.configured = false;
        ui.resize(@floatCast(w), @floatCast(h), hv.scale);
        hv.force = true;
    }
    if (!hv.configured) {
        configurePresent(hv, ui, n);
        hv.configured = true;
    }
    ui.tick(now() - hv.start);
    const changed = ui.update() catch false;
    if (capi.instance(hv.ui_id)) |inst| capi.reportWatchedRects(inst);
    if (changed or hv.force or hv.capture_requested) {
        hv.force = false;
        render(hv, ui) catch |e| std.log.err("ebui render: {}", .{e});
        if (hv.capture_requested) {
            hv.capture_requested = false;
            if (hv.capture) |c| gpa.free(c);
            hv.capture = hv.renderer.readPixels(gpa) catch null;
            hv.capture_w = hv.px_w;
            hv.capture_h = hv.px_h;
        }
    }
    if (hv.a11y_active and ui.doc.version != hv.a11y_version and now() - hv.a11y_time > 0.1) pushA11y(hv, ui);
    if (ui.wantsFrames()) n.requestFrame(hv.view);
}

fn pushA11y(hv: *View, ui: *ui_mod.Ui) void {
    const n = native orelse return;
    const f = n.setA11yTree orelse return;
    hv.a11y_version = ui.doc.version;
    hv.a11y_time = now();
    _ = ui.update() catch {};
    const tree = a11y.build(gpa, ui) catch return;
    defer {
        tree.deinit();
        gpa.destroy(tree);
    }
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(gpa);
    a11y.serialize(tree, gpa, &buf) catch return;
    f(hv.view, buf.items.ptr, buf.items.len);
}

fn onA11yRequest(ctx: ?*anyopaque) callconv(.c) void {
    capi.lock();
    defer capi.unlock();
    const hv = liveView(ctx) orelse return;
    const ui = uiOf(hv) orelse return;
    hv.a11y_active = true;
    pushA11y(hv, ui);
}

fn onA11yAction(ctx: ?*anyopaque, node: u32, action: u32, value: [*:0]const u8) callconv(.c) void {
    capi.lock();
    defer capi.unlock();
    const hv = liveView(ctx) orelse return;
    const ui = uiOf(hv) orelse return;
    const act = std.enums.fromInt(a11y.Action, action) orelse return;
    a11y.perform(ui, node, act, std.mem.span(value));
    if (native) |n| n.requestFrame(hv.view);
}

/// Size the surface (or composition bridge) to px_w x px_h. A transparent UI
/// composites with alpha where the platform needs a separate path for it
/// (Windows: Dawn's HWND swapchains are opaque); if that is unavailable the
/// view falls back to its surface, with opaque transparent areas.
fn configurePresent(hv: *View, ui: *ui_mod.Ui, n: Native) void {
    const device = dawn_ctx.?.device;
    if (hv.present_path == .undecided) {
        hv.present_path = if (ui.transparent and n.composition != null) .composition else .surface;
    }
    if (hv.present_path == .composition) {
        if (n.composition.?.configure(hv.view, device, hv.px_w, hv.px_h)) return;
        std.log.warn("ebui: no DirectComposition for a transparent view; drawing it opaque", .{});
        n.composition.?.release(hv.view);
        hv.present_path = .surface;
    }
    dawn_api.?.surfaceConfigure(hv.surface, &.{ .device = device, .format = wgpu.TextureFormat.bgra8_unorm, .width = hv.px_w, .height = hv.px_h, .alpha_mode = hv.alpha_mode });
}

fn render(hv: *View, ui: *ui_mod.Ui) !void {
    const api = dawn_api.?;
    try hv.renderer.render(&ui.dl, hv.px_w, hv.px_h, hv.scale);
    if (hv.present_path == .composition) return renderComposited(hv);
    var st = wgpu.SurfaceTexture{};
    api.surfaceGetCurrentTexture(hv.surface, &st);
    if (st.status != wgpu.surface_status_optimal and st.status != wgpu.surface_status_suboptimal) {
        hv.force = true;
        return;
    }
    const tex = st.texture orelse return;
    defer api.textureRelease(tex);
    const view = api.textureCreateView(tex, null) orelse return;
    defer api.textureViewRelease(view);
    try hv.renderer.present(view);
    _ = api.surfacePresent(hv.surface);
    hv.frames += 1;
}

fn renderComposited(hv: *View) !void {
    const api = dawn_api.?;
    const comp = native.?.composition.?;
    // a failed bridge is retired by the wrapper; configure it again next frame
    const tex = comp.acquire(hv.view) orelse {
        hv.configured = false;
        hv.force = true;
        return;
    };
    defer api.textureRelease(tex);
    const view = api.textureCreateView(tex, null) orelse return;
    defer api.textureViewRelease(view);
    try hv.renderer.present(view);
    if (!comp.present(hv.view)) {
        hv.configured = false;
        hv.force = true;
        return;
    }
    hv.frames += 1;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export fn ebui_host_frames(ui_id: u32) u64 {
    capi.lock();
    defer capi.unlock();
    const hv = viewFor(ui_id) orelse return 0;
    return hv.frames;
}

/// Ask the next frame to read back its pixels (see ebui_capture_pixel).
export fn ebui_request_capture(ui_id: u32) void {
    capi.lock();
    defer capi.unlock();
    const hv = viewFor(ui_id) orelse return;
    if (hv.capture) |c| gpa.free(c);
    hv.capture = null;
    hv.capture_requested = true;
    if (native) |n| n.requestFrame(hv.view);
}

export fn ebui_capture_ready(ui_id: u32) bool {
    capi.lock();
    defer capi.unlock();
    const hv = viewFor(ui_id) orelse return false;
    return hv.capture != null;
}

/// RGBA (premultiplied) of the captured frame at a point in CSS px.
export fn ebui_capture_pixel(ui_id: u32, x: f32, y: f32, out: *[4]u8) bool {
    capi.lock();
    defer capi.unlock();
    const hv = viewFor(ui_id) orelse return false;
    const px = hv.capture orelse return false;
    const dx: u32 = @intFromFloat(@max(0, x * hv.scale));
    const dy: u32 = @intFromFloat(@max(0, y * hv.scale));
    if (dx >= hv.capture_w or dy >= hv.capture_h) return false;
    const i = (@as(usize, dy) * hv.capture_w + dx) * 4;
    out.* = px[i..][0..4].*;
    return true;
}

fn setCursor(ctx: ?*anyopaque, c: events.Cursor) void {
    _ = ctx;
    const n = native orelse return;
    var buf: [32]u8 = undefined;
    const name = @tagName(c);
    var len: usize = 0;
    for (name) |ch| {
        if (len + 1 >= buf.len) break;
        buf[len] = if (ch == '_') '-' else ch;
        len += 1;
    }
    buf[len] = 0;
    n.setCursor(@ptrCast(&buf));
}

fn clipboardRead(ctx: ?*anyopaque, a: std.mem.Allocator) ?[]u8 {
    _ = ctx;
    const n = native orelse return null;
    const f = n.clipboardReadText orelse return null;
    // the wrappers return a malloc'd copy owned by the caller. The wrapper's C
    // runtime may not be ours (Windows links it statically), so free it with
    // the wrapper's own free where it exports one.
    const p = f() orelse return null;
    defer if (n.clipboardFreeText) |free| free(p) else if (builtin.os.tag != .windows) std.c.free(@constCast(p));
    return a.dupe(u8, std.mem.span(p)) catch null;
}

fn clipboardWrite(ctx: ?*anyopaque, text: []const u8) void {
    _ = ctx;
    const n = native orelse return;
    const f = n.clipboardWriteText orelse return;
    const z = gpa.dupeSentinel(u8, text, 0) catch return;
    defer gpa.free(z);
    f(z.ptr);
}

fn imeRect(ctx: ?*anyopaque, r: geom.Rect) void {
    const hv = liveView(ctx) orelse return;
    if (native) |n| n.setImeRect(hv.view, r.x, r.y, r.w, r.h);
}

fn beginDrag(ctx: ?*anyopaque) bool {
    const hv = liveView(ctx) orelse return false;
    const n = native orelse return false;
    return n.beginWindowDrag(hv.view);
}

test "host attach resolves native handles without holding the UI lock" {
    const Harness = struct {
        callback_done: std.atomic.Value(bool) = .init(false),
        completed_during_lookup: bool = false,
        worker: ?std.Thread = null,

        fn callback(h: *@This()) void {
            // Models another UI's frame callback already running on main
            // when the app requests the new view's native surface handle.
            capi.lock();
            capi.unlock();
            h.callback_done.store(true, .release);
        }

        fn getHandle(view: ?*anyopaque) callconv(.c) ?*anyopaque {
            const h: *@This() = @ptrCast(@alignCast(view.?));
            h.worker = std.Thread.spawn(.{}, callback, .{h}) catch @panic("cannot start attach test callback");
            const start = std.Io.Clock.awake.now(std.testing.io);
            // A synchronous AppKit lookup waits behind the frame callback.
            // Bound the wait so regressions fail without hanging the runner.
            while (!h.callback_done.load(.acquire) and start.durationTo(std.Io.Clock.awake.now(std.testing.io)).toMilliseconds() < 5_000) {
                std.Thread.yield() catch {};
            }
            h.completed_during_lookup = h.callback_done.load(.acquire);
            return view;
        }

        fn getDisplay(view: ?*anyopaque) callconv(.c) ?*anyopaque {
            return view;
        }
    };
    var h: Harness = .{};
    const saved_native = native;
    defer native = saved_native;
    var fixture: Native = undefined;
    fixture.getNativeHandle = Harness.getHandle;
    fixture.getNativeDisplay = Harness.getDisplay;
    native = fixture;
    // Exercise the exported attach entrypoint. A missing UI ID stops it after
    // handle resolution, before Dawn initialization, so no GPU is necessary.
    const attached = ebui_attach_wgpu_view(std.math.maxInt(u32), &h, null);
    if (h.worker) |worker| worker.join();
    try std.testing.expect(!attached);
    try std.testing.expect(h.completed_during_lookup);
}

test "host detach retires callbacks before native unregister without holding the UI lock" {
    const Harness = struct {
        ctx: ?*anyopaque = null,
        callback_done: std.atomic.Value(bool) = .init(false),
        callback_saw_retired: bool = false,
        completed_during_unregister: bool = false,
        released: bool = false,
        a11y_cleared: bool = false,
        worker: ?std.Thread = null,

        fn callback(h: *@This()) void {
            capi.lock();
            h.callback_saw_retired = liveView(h.ctx) == null;
            capi.unlock();
            // Real stale callbacks must return without reading the renderer or
            // engine. This fixture deliberately has neither GPU resource.
            onFrame(h.ctx, 0);
            onPointer(h.ctx, 0, 10, 10, 0, 0, 0);
            h.callback_done.store(true, .release);
        }

        fn unregister(view: ?*anyopaque, ctx: ?*anyopaque, pointer: ?PointerCb, key: ?KeyCb, text: ?TextCb, frame: ?FrameCb) callconv(.c) void {
            std.debug.assert(ctx == null and pointer == null and key == null and text == null and frame == null);
            const h: *@This() = @ptrCast(@alignCast(view.?));
            h.worker = std.Thread.spawn(.{}, callback, .{h}) catch @panic("cannot start lifecycle test callback");
            const start = std.Io.Clock.awake.now(std.testing.io);
            // Models unregister dispatch_sync waiting for an in-flight native
            // callback. Bound this so the old lock inversion fails rather than
            // hanging the test runner; join only after detach releases its lock.
            while (!h.callback_done.load(.acquire) and start.durationTo(std.Io.Clock.awake.now(std.testing.io)).toMilliseconds() < 5_000) {
                std.Thread.yield() catch {};
            }
            h.completed_during_unregister = h.callback_done.load(.acquire);
            std.debug.assert(!h.released);
        }

        fn unregisterA11y(view: ?*anyopaque, ctx: ?*anyopaque, request: ?A11yRequestCb, action: ?A11yActionCb) callconv(.c) void {
            const h: *@This() = @ptrCast(@alignCast(view.?));
            h.a11y_cleared = ctx == null and request == null and action == null;
        }

        fn release(hv: *View) void {
            const h: *@This() = @ptrCast(@alignCast(hv.view));
            h.released = true;
        }
    };
    var h: Harness = .{};
    var hv = View{ .callback_id = std.math.maxInt(usize) - 2, .ui_id = std.math.maxInt(u32), .view = &h, .surface = undefined, .renderer = undefined };
    h.ctx = callbackContext(&hv);
    const saved_native = native;
    defer native = saved_native;
    // Only these native methods participate in detach. No GPU or OS window is
    // needed to exercise its real registry, synchronization and release order.
    var fixture: Native = undefined;
    fixture.setUIHandlers = Harness.unregister;
    fixture.setA11yHandlers = Harness.unregisterA11y;
    fixture.composition = null;
    native = fixture;
    try views.append(gpa, &hv);
    detachView(hv.ui_id, Harness.release);
    h.worker.?.join();
    try std.testing.expect(h.completed_during_unregister);
    try std.testing.expect(h.callback_saw_retired);
    try std.testing.expect(h.a11y_cleared);
    try std.testing.expect(h.released);

    // Reuse exactly the same View address for another attachment. A delayed
    // native callback carrying the previous token must still be ignored.
    hv.callback_id += 1;
    try views.append(gpa, &hv);
    defer _ = retireView(hv.ui_id);
    try std.testing.expect(liveView(h.ctx) == null);
    try std.testing.expect(liveView(callbackContext(&hv)) == &hv);
    onFrame(h.ctx, 0);
}
