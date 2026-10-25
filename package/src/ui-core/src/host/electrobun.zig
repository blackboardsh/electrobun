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
    };
    return native;
}

// Dawn is shared by every view.
var dawn_api: ?*wgpu.Api = null;
var dawn_instance: ?wgpu.Instance = null;
var dawn_ctx: ?wgpu.Context = null;

const View = struct {
    ui_id: u32,
    view: *anyopaque,
    surface: wgpu.Surface,
    renderer: *gpu.Renderer,
    px_w: u32 = 0,
    px_h: u32 = 0,
    scale: f32 = 2,
    alpha_mode: u32 = wgpu.alpha_mode_premultiplied,
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

fn viewFor(ui_id: u32) ?*View {
    for (views.items) |v| if (v.ui_id == ui_id) return v;
    return null;
}

/// The view behind a native callback's ctx, or null once it is detached.
/// Callbacks run on the main thread and can race ebui_detach_view on the app
/// thread (a callback already dispatched when the handlers are cleared), so
/// every callback resolves its ctx here, under the lock, before using it.
fn liveView(ctx: ?*anyopaque) ?*View {
    const p = ctx orelse return null;
    for (views.items) |v| if (@as(*anyopaque, v) == p) return v;
    return null;
}

/// A Dawn surface for the view's native handle.
fn createSurface(api: *wgpu.Api, instance: wgpu.Instance, n: Native, v: *anyopaque) ?wgpu.Surface {
    const handle = n.getNativeHandle(v) orelse {
        std.log.err("ebui: view has no native surface handle", .{});
        return null;
    };
    switch (builtin.os.tag) {
        .macos => {
            var src = wgpu.SurfaceSourceMetalLayer{ .layer = handle };
            return api.instanceCreateSurface(instance, &.{ .next = &src.chain });
        },
        .windows => {
            var src = wgpu.SurfaceSourceWindowsHWND{ .hinstance = GetModuleHandleW(null), .hwnd = handle };
            return api.instanceCreateSurface(instance, &.{ .next = &src.chain });
        },
        else => {
            const getDisplay = n.getNativeDisplay orelse {
                std.log.err("ebui: native wrapper lacks wgpuViewGetNativeDisplay", .{});
                return null;
            };
            const display = getDisplay(v) orelse {
                std.log.err("ebui: view has no X11 display", .{});
                return null;
            };
            var src = wgpu.SurfaceSourceXlibWindow{ .display = display, .window = @intFromPtr(handle) };
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
    defer capi.unlock();
    const n = loadNative() orelse {
        std.log.err("ebui: native wrapper symbols missing", .{});
        return false;
    };
    const v = view orelse return false;
    const ui = capi.engine(ui_id) orelse return false;
    if (dawn_api == null) {
        const api = gpa.create(wgpu.Api) catch return false;
        const path = if (dawn_path) |p| std.mem.span(p) else wgpu.defaultLibraryPath();
        api.* = wgpu.Api.load(path) catch |e| {
            std.log.err("ebui: cannot load Dawn from {s}: {}", .{ path, e });
            gpa.destroy(api);
            return false;
        };
        dawn_api = api;
        dawn_instance = api.createInstance(null);
    }
    const api = dawn_api.?;
    const instance = dawn_instance orelse return false;
    const surface = createSurface(api, instance, n, v) orelse return false;
    if (dawn_ctx == null) {
        dawn_ctx = wgpu.Context.createWithInstance(api, instance, surface) catch |e| {
            std.log.err("ebui: no WebGPU device: {}", .{e});
            return false;
        };
        dawn_ctx.?.logAdapter();
    }
    const r = gpu.Renderer.init(gpa, api, dawn_ctx.?, ui.fonts, wgpu.TextureFormat.bgra8_unorm) catch return false;
    r.store = &ui.images;
    const hv = gpa.create(View) catch return false;
    hv.* = .{ .ui_id = ui_id, .view = v, .surface = surface, .renderer = r, .start = now(), .alpha_mode = pickAlphaMode(api, surface, dawn_ctx.?.adapter) };
    views.append(gpa, hv) catch return false;
    ui.ix.host = .{
        .ctx = hv,
        .set_cursor = setCursor,
        .clipboard_read = clipboardRead,
        .clipboard_write = clipboardWrite,
        .ime_rect = imeRect,
        .begin_window_drag = beginDrag,
        .request_frame = requestFrameCb,
    };
    if (capi.instance(ui_id)) |inst| {
        inst.request_frame = requestFrameFromCapi;
        inst.request_frame_ctx = hv;
    }
    n.setUIHandlers(v, hv, onPointer, onKey, onText, onFrame);
    if (n.setA11yHandlers) |f| f(v, hv, onA11yRequest, onA11yAction);
    n.requestFrame(v);
    return true;
}

pub export fn ebui_detach_view(ui_id: u32) void {
    capi.lock();
    defer capi.unlock();
    const hv = viewFor(ui_id) orelse return;
    if (native) |n| n.setUIHandlers(hv.view, null, null, null, null, null);
    hv.renderer.deinit();
    if (dawn_api) |api| api.surfaceRelease(hv.surface);
    for (views.items, 0..) |x, i| if (x == hv) {
        _ = views.swapRemove(i);
        break;
    };
    if (capi.instance(ui_id)) |inst| inst.request_frame = null;
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
    const api = dawn_api.?;
    if (pw != hv.px_w or ph != hv.px_h or @as(f32, @floatCast(scale)) != hv.scale) {
        hv.px_w = pw;
        hv.px_h = ph;
        hv.scale = @floatCast(scale);
        api.surfaceConfigure(hv.surface, &.{ .device = dawn_ctx.?.device, .format = wgpu.TextureFormat.bgra8_unorm, .width = pw, .height = ph, .alpha_mode = hv.alpha_mode });
        ui.resize(@floatCast(w), @floatCast(h), hv.scale);
        hv.force = true;
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

fn render(hv: *View, ui: *ui_mod.Ui) !void {
    const api = dawn_api.?;
    try hv.renderer.render(&ui.dl, hv.px_w, hv.px_h, hv.scale);
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
    // the wrappers return a malloc'd copy owned by the caller. On Windows the
    // wrapper's CRT may differ from ours, so it is not freed here (TODO: a
    // wrapper-side free export).
    const p = f() orelse return null;
    defer if (builtin.os.tag != .windows) std.c.free(@constCast(p));
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
