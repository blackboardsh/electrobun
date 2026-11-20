//! Optional per-mount text backend. Layout asks it for synchronous metrics and
//! the GPU renderer calls it, between quad batches, to draw whole runs.
//! The built-in shaper and atlas stay in place when no backend is installed.
const std = @import("std");
const font = @import("font.zig");
const geom = @import("../geom.zig");

const Allocator = std.mem.Allocator;

/// High bit on a glyph's font id: the glyph id is an index into the backend's
/// recorded strings, not a font glyph.
const mark: u32 = 0x8000_0000;

pub const MeasureFn = *const fn (?*anyopaque, [*]const u8, usize, f32, *f32, *f32) callconv(.c) u8;
pub const PrepareFn = *const fn (?*anyopaque, [*]const CRun, usize, *const Viewport) callconv(.c) u8;
pub const DrawFn = *const fn (?*anyopaque, ?*anyopaque, *const CRun) callconv(.c) u8;
pub const DisposeFn = *const fn (?*anyopaque) callconv(.c) void;

pub const Hook = struct {
    ctx: ?*anyopaque,
    measure: MeasureFn,
    prepare: PrepareFn,
    draw: DrawFn,
    dispose: DisposeFn,
};

/// What the GPU renderer needs at draw time. `prepare`/`draw` are null when
/// the mount uses the built-in atlas.
pub const DrawHook = struct {
    ctx: ?*anyopaque = null,
    prepare: ?PrepareFn = null,
    draw: ?DrawFn = null,
};

pub const Viewport = extern struct {
    width: f32,
    height: f32,
    pixel_width: f32,
    pixel_height: f32,
};

/// ABI shared with the TypeScript binding. Field offsets are asserted below.
pub const CRun = extern struct {
    id: u32,
    _pad: u32 = 0,
    text: [*]const u8,
    text_len: usize,
    size: f32,
    /// 0xRRGGBBAA
    color: u32,
    x: f32,
    y: f32,
    clip_x: f32,
    clip_y: f32,
    clip_w: f32,
    clip_h: f32,
};

pub const Scissor = struct { x: u32, y: u32, width: u32, height: u32 };

pub fn packRgba(c: geom.Color) u32 {
    return (@as(u32, c.r) << 24) | (@as(u32, c.g) << 16) | (@as(u32, c.b) << 8) | c.a;
}

fn snap(v: f32, limit: u32) u32 {
    const c = @ceil(v);
    if (!(c > 0)) return 0;
    const lim: f32 = @floatFromInt(limit);
    if (c >= lim) return limit;
    return @intFromFloat(c);
}

/// Match the fragment-center clipping used by the quad shader.
pub fn textScissor(clip_x: f32, clip_y: f32, clip_w: f32, clip_h: f32, logical_w: f32, logical_h: f32, pixel_w: u32, pixel_h: u32) Scissor {
    if (!(logical_w > 0) or !(logical_h > 0) or pixel_w == 0 or pixel_h == 0) return .{ .x = 0, .y = 0, .width = 0, .height = 0 };
    const sx = @as(f32, @floatFromInt(pixel_w)) / logical_w;
    const sy = @as(f32, @floatFromInt(pixel_h)) / logical_h;
    const x = snap(clip_x * sx - 0.5, pixel_w);
    const y = snap(clip_y * sy - 0.5, pixel_h);
    const right = snap((clip_x + clip_w) * sx - 0.5, pixel_w);
    const bottom = snap((clip_y + clip_h) * sy - 0.5, pixel_h);
    return .{ .x = x, .y = y, .width = right -| x, .height = bottom -| y };
}

pub const Wrap = struct {
    gpa: Allocator,
    inner: font.Backend,
    hook: Hook,
    sizes: std.AutoHashMapUnmanaged(font.FontId, f32) = .empty,
    last_h: std.AutoHashMapUnmanaged(font.FontId, f32) = .empty,
    strings: std.ArrayList([]u8) = .empty,

    pub fn init(gpa: Allocator, inner: font.Backend, hook: Hook) Wrap {
        return .{ .gpa = gpa, .inner = inner, .hook = hook };
    }

    pub fn backend(self: *Wrap) font.Backend {
        return .{ .ptr = self, .vtable = &vtable };
    }

    pub fn deinit(self: *Wrap) void {
        for (self.strings.items) |t| self.gpa.free(t);
        self.strings.deinit(self.gpa);
        self.sizes.deinit(self.gpa);
        self.last_h.deinit(self.gpa);
    }
};

fn self_(p: *anyopaque) *Wrap {
    return @ptrCast(@alignCast(p));
}

fn lineMetrics(h: f32) font.Metrics {
    return .{
        .ascent = h * 0.8,
        .descent = h * 0.2,
        .x_height = h * 0.5,
        .cap_height = h * 0.7,
        .underline_pos = 1,
        .underline_thickness = 1,
    };
}

const vtable: font.Backend.VTable = .{
    .resolve = resolve,
    .metrics = metrics,
    .shape = shape,
    .rasterize = rasterize,
    .isColor = isColor,
    .deinit = deinitBackend,
    .registerFont = registerFont,
};

fn resolve(p: *anyopaque, spec: font.FontSpec) font.FontId {
    const s = self_(p);
    const id = s.inner.resolve(spec);
    s.sizes.put(s.gpa, id, spec.size) catch {};
    return id;
}

fn metrics(p: *anyopaque, id: font.FontId) font.Metrics {
    const s = self_(p);
    if (s.last_h.get(id)) |h| if (h > 0) return lineMetrics(h);
    const size = s.sizes.get(id) orelse 16;
    var w: f32 = 0;
    var h: f32 = 0;
    const sample = "M";
    if (s.hook.measure(s.hook.ctx, sample.ptr, sample.len, size, &w, &h) != 0 and h > 0) return lineMetrics(h);
    return s.inner.metrics(id);
}

fn shape(p: *anyopaque, id: font.FontId, text: []const u8, out: *std.ArrayList(font.Glyph), gpa: Allocator) Allocator.Error!void {
    const s = self_(p);
    if (text.len == 0) return;
    const size = s.sizes.get(id) orelse 16;
    var w: f32 = 0;
    var h: f32 = 0;
    if (s.hook.measure(s.hook.ctx, text.ptr, text.len, size, &w, &h) == 0) {
        return s.inner.shape(id, text, out, gpa);
    }
    const copy = try s.gpa.dupe(u8, text);
    s.strings.append(s.gpa, copy) catch {
        s.gpa.free(copy);
        return error.OutOfMemory;
    };
    const gid: u32 = @intCast(s.strings.items.len - 1);
    s.last_h.put(s.gpa, id, @max(h, 0)) catch {};
    try out.append(gpa, .{ .id = gid, .font = id | mark, .advance = @max(w, 0), .cluster = 0 });
}

fn rasterize(p: *anyopaque, id: font.FontId, glyph: u32, scale: f32, subpixel: f32) ?font.GlyphBitmap {
    return self_(p).inner.rasterize(id, glyph, scale, subpixel);
}

fn isColor(p: *anyopaque, id: font.FontId) bool {
    return self_(p).inner.isColor(id);
}

fn deinitBackend(p: *anyopaque) void {
    self_(p).deinit();
}

fn registerFont(p: *anyopaque, family: []const u8, data: []const u8, weight: f32, italic: bool) bool {
    return self_(p).inner.registerFont(family, data, weight, italic);
}

/// The string measured for a glyph emitted by this backend, if `font_id`
/// carries the external mark.
pub fn textForGlyph(fonts: font.Backend, font_id: u32, glyph: u32) ?[]const u8 {
    if (fonts.vtable != &vtable or font_id & mark == 0) return null;
    const s: *Wrap = @ptrCast(@alignCast(fonts.ptr));
    if (glyph >= s.strings.items.len) return null;
    return s.strings.items[glyph];
}

test "text run abi matches the typescript binding" {
    try std.testing.expectEqual(@as(usize, 56), @sizeOf(CRun));
    try std.testing.expectEqual(@as(usize, 0), @offsetOf(CRun, "id"));
    try std.testing.expectEqual(@as(usize, 8), @offsetOf(CRun, "text"));
    try std.testing.expectEqual(@as(usize, 16), @offsetOf(CRun, "text_len"));
    try std.testing.expectEqual(@as(usize, 24), @offsetOf(CRun, "size"));
    try std.testing.expectEqual(@as(usize, 28), @offsetOf(CRun, "color"));
    try std.testing.expectEqual(@as(usize, 32), @offsetOf(CRun, "x"));
    try std.testing.expectEqual(@as(usize, 36), @offsetOf(CRun, "y"));
    try std.testing.expectEqual(@as(usize, 40), @offsetOf(CRun, "clip_x"));
    try std.testing.expectEqual(@as(usize, 44), @offsetOf(CRun, "clip_y"));
    try std.testing.expectEqual(@as(usize, 48), @offsetOf(CRun, "clip_w"));
    try std.testing.expectEqual(@as(usize, 52), @offsetOf(CRun, "clip_h"));
    try std.testing.expectEqual(@as(usize, 16), @sizeOf(Viewport));
}

test "physical text clipping uses attachment pixels and pixel centers" {
    const a = textScissor(1.25, 2.5, 4, 6, 100, 100, 200, 150);
    try std.testing.expectEqual(Scissor{ .x = 2, .y = 4, .width = 8, .height = 9 }, a);
    const b = textScissor(-20, -10, 200, 100, 100, 40, 125, 50);
    try std.testing.expectEqual(Scissor{ .x = 0, .y = 0, .width = 125, .height = 50 }, b);
}
