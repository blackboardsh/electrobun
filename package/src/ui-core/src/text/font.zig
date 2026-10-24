//! Text backend interface. A backend resolves CSS font specs to fonts,
//! shapes runs of text into positioned glyphs (with font fallback), and
//! rasterizes glyphs. Line breaking and inline layout are done in Zig on top
//! of this, so wrapping behaves identically on every platform.
const std = @import("std");

pub const FontId = u32;

pub const FontSpec = struct {
    families: []const []const u8,
    size: f32,
    weight: f32 = 400,
    italic: bool = false,
};

pub const Metrics = struct {
    ascent: f32,
    descent: f32, // positive
    line_gap: f32 = 0,
    x_height: f32 = 0,
    cap_height: f32 = 0,
    underline_pos: f32 = 0, // positive = below baseline
    underline_thickness: f32 = 1,
};

pub const Glyph = struct {
    id: u32,
    font: FontId,
    /// advance in px (letter-spacing not included)
    advance: f32,
    x_offset: f32 = 0,
    y_offset: f32 = 0,
    /// byte offset of the cluster start in the shaped text
    cluster: u32,
};

pub const GlyphBitmap = struct {
    width: u32,
    height: u32,
    /// offset from the pen position (baseline origin) to the bitmap's top-left, in device px
    left: i32,
    top: i32,
    /// 1 = A8 coverage, 4 = BGRA premultiplied (color emoji)
    channels: u8,
    pixels: []u8,
};

pub const Backend = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        resolve: *const fn (ptr: *anyopaque, spec: FontSpec) FontId,
        metrics: *const fn (ptr: *anyopaque, font: FontId) Metrics,
        /// Shape `text` (UTF-8) with `font`, appending glyphs in visual order.
        /// Fallback fonts may appear in the output.
        shape: *const fn (ptr: *anyopaque, font: FontId, text: []const u8, out: *std.ArrayList(Glyph), gpa: std.mem.Allocator) std.mem.Allocator.Error!void,
        /// Rasterize a glyph at `scale` (device pixels per CSS px) with a
        /// horizontal subpixel offset in [0, 1). Pixels are owned by the
        /// backend until the next call.
        rasterize: *const fn (ptr: *anyopaque, font: FontId, glyph: u32, scale: f32, subpixel: f32) ?GlyphBitmap,
        /// Is this a color (emoji) font?
        isColor: *const fn (ptr: *anyopaque, font: FontId) bool,
        deinit: *const fn (ptr: *anyopaque) void,
        /// Register font data (from @font-face). Returns false if unsupported.
        registerFont: *const fn (ptr: *anyopaque, family: []const u8, data: []const u8, weight: f32, italic: bool) bool,
    };

    pub fn resolve(b: Backend, spec: FontSpec) FontId {
        return b.vtable.resolve(b.ptr, spec);
    }
    pub fn metrics(b: Backend, f: FontId) Metrics {
        return b.vtable.metrics(b.ptr, f);
    }
    pub fn shape(b: Backend, f: FontId, text: []const u8, out: *std.ArrayList(Glyph), gpa: std.mem.Allocator) std.mem.Allocator.Error!void {
        return b.vtable.shape(b.ptr, f, text, out, gpa);
    }
    pub fn rasterize(b: Backend, f: FontId, glyph: u32, scale: f32, subpixel: f32) ?GlyphBitmap {
        return b.vtable.rasterize(b.ptr, f, glyph, scale, subpixel);
    }
    pub fn isColor(b: Backend, f: FontId) bool {
        return b.vtable.isColor(b.ptr, f);
    }
    pub fn deinit(b: Backend) void {
        b.vtable.deinit(b.ptr);
    }
    pub fn registerFont(b: Backend, family: []const u8, data: []const u8, weight: f32, italic: bool) bool {
        return b.vtable.registerFont(b.ptr, family, data, weight, italic);
    }
};

/// Deterministic backend for tests and headless use: every character is a
/// box 0.5em wide (spaces too), ascent 0.8em, descent 0.2em.
pub const MockBackend = struct {
    gpa: std.mem.Allocator,
    sizes: std.ArrayList(f32) = .empty,
    bitmap: std.ArrayList(u8) = .empty,

    pub fn create(gpa: std.mem.Allocator) !Backend {
        const self = try gpa.create(MockBackend);
        self.* = .{ .gpa = gpa };
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: Backend.VTable = .{
        .resolve = resolve,
        .metrics = metrics,
        .shape = shape,
        .rasterize = rasterize,
        .isColor = isColor,
        .deinit = deinit,
        .registerFont = registerFont,
    };

    fn self_(p: *anyopaque) *MockBackend {
        return @ptrCast(@alignCast(p));
    }

    fn resolve(p: *anyopaque, spec: FontSpec) FontId {
        const s = self_(p);
        for (s.sizes.items, 0..) |sz, i| if (sz == spec.size) return @intCast(i);
        s.sizes.append(s.gpa, spec.size) catch return 0;
        return @intCast(s.sizes.items.len - 1);
    }
    fn sizeOf(s: *MockBackend, f: FontId) f32 {
        return if (f < s.sizes.items.len) s.sizes.items[f] else 16;
    }
    fn metrics(p: *anyopaque, f: FontId) Metrics {
        const sz = sizeOf(self_(p), f);
        return .{ .ascent = sz * 0.8, .descent = sz * 0.2, .x_height = sz * 0.5, .cap_height = sz * 0.7, .underline_pos = sz * 0.1, .underline_thickness = @max(1, sz / 16) };
    }
    fn shape(p: *anyopaque, f: FontId, text: []const u8, out: *std.ArrayList(Glyph), gpa: std.mem.Allocator) std.mem.Allocator.Error!void {
        const sz = sizeOf(self_(p), f);
        var it = std.unicode.Utf8Iterator{ .bytes = text, .i = 0 };
        var pos: usize = 0;
        while (it.nextCodepoint()) |cp| {
            const adv: f32 = if (cp == 0x200b or cp == 0xad) 0 else sz * 0.5;
            try out.append(gpa, .{ .id = cp, .font = f, .advance = adv, .cluster = @intCast(pos) });
            pos = it.i;
        }
    }
    fn rasterize(p: *anyopaque, f: FontId, glyph: u32, scale: f32, subpixel: f32) ?GlyphBitmap {
        _ = subpixel;
        const s = self_(p);
        if (glyph == ' ') return null;
        const sz = sizeOf(s, f) * scale;
        const w: u32 = @intFromFloat(@max(1, @round(sz * 0.4)));
        const h: u32 = @intFromFloat(@max(1, @round(sz * 0.7)));
        s.bitmap.resize(s.gpa, w * h) catch return null;
        @memset(s.bitmap.items, 255);
        return .{ .width = w, .height = h, .left = @intFromFloat(@round(sz * 0.05)), .top = @intCast(h), .channels = 1, .pixels = s.bitmap.items };
    }
    fn isColor(_: *anyopaque, _: FontId) bool {
        return false;
    }
    fn deinit(p: *anyopaque) void {
        const s = self_(p);
        s.sizes.deinit(s.gpa);
        s.bitmap.deinit(s.gpa);
        s.gpa.destroy(s);
    }
    fn registerFont(_: *anyopaque, _: []const u8, _: []const u8, _: f32, _: bool) bool {
        return false;
    }
};
