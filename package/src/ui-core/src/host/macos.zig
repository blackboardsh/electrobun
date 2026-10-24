//! Standalone macOS host: an AppKit window with a CAMetalLayer-backed view,
//! driven entirely from Zig through the Objective-C runtime. Translates
//! mouse, wheel, keyboard and IME (NSTextInputClient) input into the UI
//! engine and renders with the WebGPU renderer on demand.
const std = @import("std");
const objc = @import("objc.zig");
const ui_mod = @import("../ui.zig");
const events = @import("../events.zig");
const wgpu = @import("../render/wgpu.zig");
const gpu = @import("../render/gpu.zig");
const geom = @import("../geom.zig");

const id = objc.id;
const SEL = objc.SEL;
const msg = objc.msg;
const CGRect = objc.CGRect;
const CGPoint = objc.CGPoint;
const CGSize = objc.CGSize;
const NSRange = objc.NSRange;

pub const Options = struct {
    title: []const u8 = "Electrobun UI",
    width: f32 = 900,
    height: f32 = 600,
    dawn_path: []const u8 = "libwebgpu_dawn.dylib",
    /// called every frame before update (e.g. file watching, app logic)
    on_frame: ?*const fn (ctx: ?*anyopaque, win: *Window) void = null,
    ctx: ?*anyopaque = null,
};

pub const Window = struct {
    gpa: std.mem.Allocator,
    ui: *ui_mod.Ui,
    opts: Options,
    api: *wgpu.Api,
    ctx: wgpu.Context,
    renderer: *gpu.Renderer,
    surface: wgpu.Surface,
    format: u32 = wgpu.TextureFormat.bgra8_unorm,
    window: id,
    view: id,
    layer: id,
    px_w: u32 = 0,
    px_h: u32 = 0,
    scale: f32 = 2,
    start: f64 = 0,
    last_event: id = null,
    ime_rect: geom.Rect = .{},
    frames: u64 = 0,
    force_render: bool = true,
    io: std.Io,

    pub fn create(gpa: std.mem.Allocator, io: std.Io, ui: *ui_mod.Ui, opts: Options) !*Window {
        const w = try gpa.create(Window);
        errdefer gpa.destroy(w);
        const app = msg(id, objc.class("NSApplication"), "sharedApplication", .{});
        _ = msg(bool, app, "setActivationPolicy:", .{@as(isize, 0)});

        const style: usize = 1 | 2 | 4 | 8; // titled, closable, miniaturizable, resizable
        const rect = CGRect{ .origin = .{ .x = 200, .y = 200 }, .size = .{ .width = opts.width, .height = opts.height } };
        const window = msg(id, msg(id, objc.class("NSWindow"), "alloc", .{}), "initWithContentRect:styleMask:backing:defer:", .{ rect, style, @as(usize, 2), false });
        _ = msg(void, window, "setTitle:", .{objc.nsString(opts.title)});
        _ = msg(void, window, "setReleasedWhenClosed:", .{false});

        const cls = try viewClass();
        const view = msg(id, msg(id, cls, "alloc", .{}), "initWithFrame:", .{CGRect{ .origin = .{ .x = 0, .y = 0 }, .size = rect.size }});
        _ = objc.object_setInstanceVariable(view, "zigwin", w);
        _ = msg(void, view, "setWantsLayer:", .{true});
        const layer = msg(id, objc.class("CAMetalLayer"), "layer", .{});
        _ = msg(void, view, "setLayer:", .{layer});
        _ = msg(void, layer, "setOpaque:", .{true});
        _ = msg(void, window, "setContentView:", .{view});
        _ = msg(void, window, "setDelegate:", .{view});
        _ = msg(bool, window, "makeFirstResponder:", .{view});
        // mouse tracking
        const tracking_opts: usize = 0x01 | 0x02 | 0x80 | 0x200; // entered/exited, moved, active always, in visible rect
        const area = msg(id, msg(id, objc.class("NSTrackingArea"), "alloc", .{}), "initWithRect:options:owner:userInfo:", .{ CGRect{ .origin = .{ .x = 0, .y = 0 }, .size = .{ .width = 0, .height = 0 } }, tracking_opts, view, @as(id, null) });
        _ = msg(void, view, "addTrackingArea:", .{area});
        _ = msg(void, window, "setAcceptsMouseMovedEvents:", .{true});

        // WebGPU
        const api = try gpa.create(wgpu.Api);
        api.* = try wgpu.Api.load(opts.dawn_path);
        const instance = api.createInstance(null) orelse return error.NoInstance;
        var src = wgpu.SurfaceSourceMetalLayer{ .layer = layer.? };
        const sd = wgpu.SurfaceDescriptor{ .next = &src.chain };
        const surface = api.instanceCreateSurface(instance, &sd) orelse return error.NoSurface;
        const ctx = try wgpu.Context.createWithInstance(api, instance, surface);

        w.* = .{
            .gpa = gpa,
            .ui = ui,
            .opts = opts,
            .api = api,
            .ctx = ctx,
            .renderer = undefined,
            .surface = surface,
            .window = window,
            .view = view,
            .layer = layer,
            .io = io,
        };
        w.renderer = try gpu.Renderer.init(gpa, api, ctx, ui.fonts, w.format);
        w.renderer.store = &ui.images;
        ui.images.io = io;
        w.start = w.clock();
        ui.ix.host = .{
            .ctx = w,
            .set_cursor = setCursor,
            .clipboard_read = clipboardRead,
            .clipboard_write = clipboardWrite,
            .ime_rect = imeRect,
            .begin_window_drag = beginDrag,
            .request_frame = requestFrame,
        };
        // render loop timer (frames are only drawn when something changed)
        _ = msg(id, objc.class("NSTimer"), "scheduledTimerWithTimeInterval:target:selector:userInfo:repeats:", .{ @as(f64, 1.0 / 120.0), view, objc.sel("tick:"), @as(id, null), true });
        _ = msg(void, window, "center", .{});
        _ = msg(void, window, "makeKeyAndOrderFront:", .{@as(id, null)});
        _ = msg(void, app, "activateIgnoringOtherApps:", .{true});
        w.syncSize();
        return w;
    }

    pub fn run(w: *Window) void {
        _ = w;
        const app = msg(id, objc.class("NSApplication"), "sharedApplication", .{});
        _ = msg(void, app, "run", .{});
    }

    fn clock(w: *Window) f64 {
        const t = std.Io.Timestamp.now(w.io, .awake);
        return @as(f64, @floatFromInt(t.toNanoseconds())) / 1e9;
    }

    fn syncSize(w: *Window) void {
        const bounds = msg(CGRect, w.view, "bounds", .{});
        const scale: f32 = @floatCast(msg(f64, w.window, "backingScaleFactor", .{}));
        const pw: u32 = @intFromFloat(@max(1, @round(bounds.size.width * scale)));
        const ph: u32 = @intFromFloat(@max(1, @round(bounds.size.height * scale)));
        if (pw == w.px_w and ph == w.px_h and scale == w.scale) return;
        w.px_w = pw;
        w.px_h = ph;
        w.scale = scale;
        _ = msg(void, w.layer, "setContentsScale:", .{@as(f64, scale)});
        _ = msg(void, w.layer, "setDrawableSize:", .{CGSize{ .width = @floatFromInt(pw), .height = @floatFromInt(ph) }});
        w.api.surfaceConfigure(w.surface, &.{ .device = w.ctx.device, .format = w.format, .width = pw, .height = ph, .alpha_mode = wgpu.alpha_mode_opaque });
        w.ui.resize(@floatCast(bounds.size.width), @floatCast(bounds.size.height), scale);
        w.force_render = true;
    }

    pub fn frame(w: *Window) void {
        if (std.c.getenv("EBUI_DEBUG") != null) std.log.info("frame {d} size {d}x{d}", .{ w.frames, w.px_w, w.px_h });
        w.syncSize();
        if (w.opts.on_frame) |f| f(w.opts.ctx, w);
        w.ui.tick(w.clock() - w.start);
        const changed = w.ui.update() catch |e| blk: {
            std.log.err("ui update failed: {}", .{e});
            break :blk false;
        };
        if (!changed and !w.force_render) return;
        w.force_render = false;
        w.render() catch |e| std.log.err("render failed: {}", .{e});
    }

    fn render(w: *Window) !void {
        try w.renderer.render(&w.ui.dl, w.px_w, w.px_h, w.scale);
        var st = wgpu.SurfaceTexture{};
        w.api.surfaceGetCurrentTexture(w.surface, &st);
        if (st.status != wgpu.surface_status_optimal and st.status != wgpu.surface_status_suboptimal) {
            if (w.frames == 0) std.log.warn("surface texture status {d}", .{st.status});
            w.force_render = true;
            return;
        }
        const tex = st.texture orelse return;
        defer w.api.textureRelease(tex);
        const view = w.api.textureCreateView(tex, null) orelse return;
        defer w.api.textureViewRelease(view);
        try w.renderer.present(view);
        _ = w.api.surfacePresent(w.surface);
        w.frames += 1;
    }

    /// Capture the current frame as a PNG (premultiplied RGBA readback).
    pub fn screenshot(w: *Window, path: []const u8) !void {
        const px = try w.renderer.readPixels(w.gpa);
        defer w.gpa.free(px);
        var img = @import("../render/cpu.zig").Image{ .w = w.px_w, .h = w.px_h, .px = px };
        const png = try @import("../render/cpu.zig").encodePng(w.gpa, &img);
        defer w.gpa.free(png);
        try std.Io.Dir.cwd().writeFile(w.io, .{ .sub_path = path, .data = png });
    }

    // ------------------------------------------------------------------
    // Host callbacks
    // ------------------------------------------------------------------

    fn setCursor(ctx: ?*anyopaque, c: events.Cursor) void {
        _ = ctx;
        const name: [*:0]const u8 = switch (c) {
            .pointer => "pointingHandCursor",
            .text, .vertical_text => "IBeamCursor",
            .crosshair, .cell => "crosshairCursor",
            .grab, .move, .all_scroll => "openHandCursor",
            .grabbing => "closedHandCursor",
            .not_allowed, .no_drop => "operationNotAllowedCursor",
            .ew_resize, .col_resize, .e_resize, .w_resize => "resizeLeftRightCursor",
            .ns_resize, .row_resize, .n_resize, .s_resize => "resizeUpDownCursor",
            .copy => "dragCopyCursor",
            .alias => "dragLinkCursor",
            .context_menu => "contextualMenuCursor",
            else => "arrowCursor",
        };
        const cur = msg(id, objc.class("NSCursor"), name, .{});
        _ = msg(void, cur, "set", .{});
    }

    fn pasteboardType() id {
        return objc.nsStringZ("public.utf8-plain-text");
    }

    fn clipboardRead(ctx: ?*anyopaque, gpa: std.mem.Allocator) ?[]u8 {
        _ = ctx;
        const pb = msg(id, objc.class("NSPasteboard"), "generalPasteboard", .{});
        const s = msg(id, pb, "stringForType:", .{pasteboardType()});
        if (s == null) return null;
        return gpa.dupe(u8, objc.utf8(s)) catch null;
    }

    fn clipboardWrite(ctx: ?*anyopaque, text: []const u8) void {
        _ = ctx;
        const pb = msg(id, objc.class("NSPasteboard"), "generalPasteboard", .{});
        _ = msg(isize, pb, "clearContents", .{});
        _ = msg(bool, pb, "setString:forType:", .{ objc.nsString(text), pasteboardType() });
    }

    fn imeRect(ctx: ?*anyopaque, r: geom.Rect) void {
        const w: *Window = @ptrCast(@alignCast(ctx.?));
        w.ime_rect = r;
    }

    fn beginDrag(ctx: ?*anyopaque) bool {
        const w: *Window = @ptrCast(@alignCast(ctx.?));
        if (w.last_event == null) return true;
        _ = msg(void, w.window, "performWindowDragWithEvent:", .{w.last_event});
        // the dev host doesn't track the frame: treat any drag as a move
        return true;
    }

    fn requestFrame(ctx: ?*anyopaque) void {
        const w: *Window = @ptrCast(@alignCast(ctx.?));
        w.force_render = true;
    }
};

// ---------------------------------------------------------------------------
// The NSView subclass
// ---------------------------------------------------------------------------

var view_class: objc.Class = null;

fn viewClass() !objc.Class {
    if (view_class != null) return view_class;
    const cls = objc.objc_allocateClassPair(objc.class("NSView"), "EBUIView", 0) orelse return error.ObjcClass;
    _ = objc.class_addIvar(cls, "zigwin", @sizeOf(usize), @intCast(std.math.log2(@alignOf(usize))), "^v");
    const add = struct {
        fn f(c: objc.Class, name: [*:0]const u8, imp: anytype, types: [*:0]const u8) void {
            _ = objc.class_addMethod(c, objc.sel(name), @ptrCast(imp), types);
        }
    }.f;
    add(cls, "isFlipped", &yes, "B@:");
    add(cls, "acceptsFirstResponder", &yes, "B@:");
    add(cls, "acceptsFirstMouse:", &yes1, "B@:@");
    add(cls, "tick:", &tick, "v@:@");
    add(cls, "mouseDown:", &mouseDown, "v@:@");
    add(cls, "mouseUp:", &mouseUp, "v@:@");
    add(cls, "mouseDragged:", &mouseMoved, "v@:@");
    add(cls, "mouseMoved:", &mouseMoved, "v@:@");
    add(cls, "rightMouseDown:", &rightDown, "v@:@");
    add(cls, "rightMouseUp:", &rightUp, "v@:@");
    add(cls, "rightMouseDragged:", &mouseMoved, "v@:@");
    add(cls, "otherMouseDown:", &otherDown, "v@:@");
    add(cls, "otherMouseUp:", &otherUp, "v@:@");
    add(cls, "mouseExited:", &mouseExited, "v@:@");
    add(cls, "scrollWheel:", &scrollWheel, "v@:@");
    add(cls, "keyDown:", &keyDown, "v@:@");
    add(cls, "keyUp:", &keyUp, "v@:@");
    add(cls, "windowWillClose:", &windowWillClose, "v@:@");
    add(cls, "windowDidChangeEffectiveAppearance:", &noopNotify, "v@:@");
    // NSTextInputClient
    add(cls, "insertText:replacementRange:", &insertText, "v@:@{_NSRange=QQ}");
    add(cls, "setMarkedText:selectedRange:replacementRange:", &setMarkedText, "v@:@{_NSRange=QQ}{_NSRange=QQ}");
    add(cls, "unmarkText", &unmarkText, "v@:");
    add(cls, "hasMarkedText", &hasMarkedText, "B@:");
    add(cls, "markedRange", &markedRange, "{_NSRange=QQ}@:");
    add(cls, "selectedRange", &selectedRange, "{_NSRange=QQ}@:");
    add(cls, "attributedSubstringForProposedRange:actualRange:", &attributedSubstring, "@@:{_NSRange=QQ}^{_NSRange=QQ}");
    add(cls, "validAttributesForMarkedText", &validAttributes, "@@:");
    add(cls, "firstRectForCharacterRange:actualRange:", &firstRect, "{CGRect={CGPoint=dd}{CGSize=dd}}@:{_NSRange=QQ}^{_NSRange=QQ}");
    add(cls, "characterIndexForPoint:", &characterIndex, "Q@:{CGPoint=dd}");
    add(cls, "doCommandBySelector:", &doCommand, "v@::");
    _ = objc.class_addProtocol(cls, objc.objc_getProtocol("NSTextInputClient"));
    _ = objc.class_addProtocol(cls, objc.objc_getProtocol("NSWindowDelegate"));
    objc.objc_registerClassPair(cls);
    view_class = cls;
    return cls;
}

fn win(self: id) *Window {
    var p: ?*anyopaque = null;
    _ = objc.object_getInstanceVariable(self, "zigwin", &p);
    return @ptrCast(@alignCast(p.?));
}

fn yes(_: id, _: SEL) callconv(.c) bool {
    return true;
}
fn yes1(_: id, _: SEL, _: id) callconv(.c) bool {
    return true;
}
fn noopNotify(_: id, _: SEL, _: id) callconv(.c) void {}

fn tick(self: id, _: SEL, _: id) callconv(.c) void {
    win(self).frame();
}

fn windowWillClose(self: id, _: SEL, _: id) callconv(.c) void {
    _ = self;
    const app = msg(id, objc.class("NSApplication"), "sharedApplication", .{});
    _ = msg(void, app, "terminate:", .{@as(id, null)});
}

fn location(self: id, event: id) [2]f32 {
    const p = msg(CGPoint, event, "locationInWindow", .{});
    const v = msg(CGPoint, self, "convertPoint:fromView:", .{ p, @as(id, null) });
    return .{ @floatCast(v.x), @floatCast(v.y) };
}

fn mods(event: id) events.Modifiers {
    const f = msg(usize, event, "modifierFlags", .{});
    return .{ .shift = f & (1 << 17) != 0, .ctrl = f & (1 << 18) != 0, .alt = f & (1 << 19) != 0, .meta = f & (1 << 20) != 0 };
}

fn mouseDown(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    w.last_event = event;
    const p = location(self, event);
    w.ui.ix.pointerDown(p[0], p[1], 0, mods(event));
    w.last_event = null;
    w.frame();
}
fn mouseUp(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    w.ui.ix.pointerUp(p[0], p[1], 0, mods(event));
    w.frame();
}
fn rightDown(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    w.ui.ix.pointerDown(p[0], p[1], 2, mods(event));
}
fn rightUp(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    w.ui.ix.pointerUp(p[0], p[1], 2, mods(event));
}
fn otherDown(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    w.ui.ix.pointerDown(p[0], p[1], 1, mods(event));
}
fn otherUp(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    w.ui.ix.pointerUp(p[0], p[1], 1, mods(event));
}
fn mouseMoved(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    w.ui.ix.pointerMove(p[0], p[1], mods(event));
}
fn mouseExited(self: id, _: SEL, _: id) callconv(.c) void {
    win(self).ui.ix.pointerLeaveWindow();
}
fn scrollWheel(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const p = location(self, event);
    var dx: f32 = @floatCast(msg(f64, event, "scrollingDeltaX", .{}));
    var dy: f32 = @floatCast(msg(f64, event, "scrollingDeltaY", .{}));
    if (!msg(bool, event, "hasPreciseScrollingDeltas", .{})) {
        dx *= 16;
        dy *= 16;
    }
    // AppKit deltas are "content moves"; DOM wheel deltas are "scroll by"
    w.ui.ix.wheel(p[0], p[1], -dx, -dy, mods(event));
    w.frame();
}

fn namedKey(code: u16) ?[]const u8 {
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
        122 => "F1",
        120 => "F2",
        99 => "F3",
        118 => "F4",
        else => null,
    };
}

fn keyDown(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const m = mods(event);
    const code = msg(u16, event, "keyCode", .{});
    const composing = hasMarkedText(self, null);
    if (!composing) {
        if (namedKey(code)) |k| {
            w.ui.ix.keyDown(k, m);
            w.frame();
            return;
        }
        if (m.meta or m.ctrl) {
            const chars = objc.utf8(msg(id, event, "charactersIgnoringModifiers", .{}));
            w.ui.ix.keyDown(chars, m);
            w.frame();
            return;
        }
        const chars = objc.utf8(msg(id, event, "characters", .{}));
        w.ui.ix.keyDown(chars, m);
    }
    // text and IME go through the input method system
    const arr = msg(id, objc.class("NSArray"), "arrayWithObject:", .{event});
    _ = msg(void, self, "interpretKeyEvents:", .{arr});
    w.frame();
}

fn keyUp(self: id, _: SEL, event: id) callconv(.c) void {
    const w = win(self);
    const code = msg(u16, event, "keyCode", .{});
    const key = namedKey(code) orelse objc.utf8(msg(id, event, "charactersIgnoringModifiers", .{}));
    w.ui.ix.keyUp(key, mods(event));
}

fn stringOf(obj: id) []const u8 {
    if (obj == null) return "";
    // NSAttributedString -> its string
    if (msg(bool, obj, "isKindOfClass:", .{objc.class("NSAttributedString")})) return objc.utf8(msg(id, obj, "string", .{}));
    return objc.utf8(obj);
}

fn insertText(self: id, _: SEL, text: id, _: NSRange) callconv(.c) void {
    const w = win(self);
    w.ui.ix.textInput(stringOf(text));
}

fn setMarkedText(self: id, _: SEL, text: id, sel_range: NSRange, _: NSRange) callconv(.c) void {
    const w = win(self);
    const s = stringOf(text);
    // selection is in UTF-16 units; approximate as bytes for ASCII-dominant IMEs
    w.ui.ix.setComposition(s, @intCast(@min(sel_range.location, s.len)));
}

fn unmarkText(self: id, _: SEL) callconv(.c) void {
    const w = win(self);
    const doc = w.ui.doc;
    if (doc.focused == 0) return;
    if (w.ui.ix.edits.get(doc.focused)) |e| {
        if (e.composing) |cr| {
            const committed = w.gpa.dupe(u8, e.text.items[cr[0]..cr[1]]) catch return;
            defer w.gpa.free(committed);
            w.ui.ix.textInput(committed);
        }
    }
}

fn hasMarkedText(self: id, _: SEL) callconv(.c) bool {
    const w = win(self);
    const doc = w.ui.doc;
    if (doc.focused == 0) return false;
    const e = w.ui.ix.edits.get(doc.focused) orelse return false;
    return e.composing != null;
}

fn markedRange(self: id, _: SEL) callconv(.c) NSRange {
    const w = win(self);
    const doc = w.ui.doc;
    const not_found = NSRange{ .location = std.math.maxInt(isize), .length = 0 };
    if (doc.focused == 0) return not_found;
    const e = w.ui.ix.edits.get(doc.focused) orelse return not_found;
    const cr = e.composing orelse return not_found;
    return .{ .location = cr[0], .length = cr[1] - cr[0] };
}

fn selectedRange(self: id, _: SEL) callconv(.c) NSRange {
    const w = win(self);
    const doc = w.ui.doc;
    if (doc.focused == 0) return .{ .location = 0, .length = 0 };
    const e = w.ui.ix.edits.get(doc.focused) orelse return .{ .location = 0, .length = 0 };
    const s = e.selection();
    return .{ .location = s[0], .length = s[1] - s[0] };
}

fn attributedSubstring(_: id, _: SEL, _: NSRange, _: ?*NSRange) callconv(.c) id {
    return null;
}

fn validAttributes(_: id, _: SEL) callconv(.c) id {
    return msg(id, objc.class("NSArray"), "array", .{});
}

fn firstRect(self: id, _: SEL, _: NSRange, _: ?*NSRange) callconv(.c) CGRect {
    const w = win(self);
    const r = w.ime_rect;
    const view_rect = CGRect{ .origin = .{ .x = r.x, .y = r.y }, .size = .{ .width = @max(1, r.w), .height = r.h } };
    const in_window = msg(CGRect, self, "convertRect:toView:", .{ view_rect, @as(id, null) });
    return msg(CGRect, w.window, "convertRectToScreen:", .{in_window});
}

fn characterIndex(_: id, _: SEL, _: CGPoint) callconv(.c) usize {
    return 0;
}

fn doCommand(_: id, _: SEL, _: SEL) callconv(.c) void {
    // named keys are handled in keyDown before interpretKeyEvents
}
