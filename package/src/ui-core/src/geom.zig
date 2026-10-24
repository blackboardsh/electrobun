const std = @import("std");

pub const Point = struct {
    x: f32 = 0,
    y: f32 = 0,
};

pub const Size = struct {
    w: f32 = 0,
    h: f32 = 0,
};

pub const Rect = struct {
    x: f32 = 0,
    y: f32 = 0,
    w: f32 = 0,
    h: f32 = 0,

    pub fn right(r: Rect) f32 {
        return r.x + r.w;
    }
    pub fn bottom(r: Rect) f32 {
        return r.y + r.h;
    }
    pub fn contains(r: Rect, p: Point) bool {
        return p.x >= r.x and p.y >= r.y and p.x < r.x + r.w and p.y < r.y + r.h;
    }
    pub fn intersect(a: Rect, b: Rect) Rect {
        const x0 = @max(a.x, b.x);
        const y0 = @max(a.y, b.y);
        const x1 = @min(a.right(), b.right());
        const y1 = @min(a.bottom(), b.bottom());
        return .{ .x = x0, .y = y0, .w = @max(0, x1 - x0), .h = @max(0, y1 - y0) };
    }
    pub fn unite(a: Rect, b: Rect) Rect {
        if (a.isEmpty()) return b;
        if (b.isEmpty()) return a;
        const x0 = @min(a.x, b.x);
        const y0 = @min(a.y, b.y);
        return .{ .x = x0, .y = y0, .w = @max(a.right(), b.right()) - x0, .h = @max(a.bottom(), b.bottom()) - y0 };
    }
    pub fn isEmpty(r: Rect) bool {
        return r.w <= 0 or r.h <= 0;
    }
    pub fn inset(r: Rect, e: Edges) Rect {
        return .{ .x = r.x + e.left, .y = r.y + e.top, .w = @max(0, r.w - e.left - e.right), .h = @max(0, r.h - e.top - e.bottom) };
    }
    pub fn outset(r: Rect, d: f32) Rect {
        return .{ .x = r.x - d, .y = r.y - d, .w = r.w + 2 * d, .h = r.h + 2 * d };
    }
    pub fn translate(r: Rect, dx: f32, dy: f32) Rect {
        return .{ .x = r.x + dx, .y = r.y + dy, .w = r.w, .h = r.h };
    }
    pub fn eql(a: Rect, b: Rect) bool {
        return a.x == b.x and a.y == b.y and a.w == b.w and a.h == b.h;
    }
};

pub const Edges = struct {
    top: f32 = 0,
    right: f32 = 0,
    bottom: f32 = 0,
    left: f32 = 0,

    pub fn all(v: f32) Edges {
        return .{ .top = v, .right = v, .bottom = v, .left = v };
    }
    pub fn horizontal(e: Edges) f32 {
        return e.left + e.right;
    }
    pub fn vertical(e: Edges) f32 {
        return e.top + e.bottom;
    }
    pub fn add(a: Edges, b: Edges) Edges {
        return .{ .top = a.top + b.top, .right = a.right + b.right, .bottom = a.bottom + b.bottom, .left = a.left + b.left };
    }
};

/// Corner radii, clockwise from top-left.
pub const Corners = struct {
    tl: f32 = 0,
    tr: f32 = 0,
    br: f32 = 0,
    bl: f32 = 0,

    pub fn all(v: f32) Corners {
        return .{ .tl = v, .tr = v, .br = v, .bl = v };
    }
    pub fn isZero(c: Corners) bool {
        return c.tl == 0 and c.tr == 0 and c.br == 0 and c.bl == 0;
    }
    /// CSS radius clamping: scale all radii down uniformly when adjacent radii overflow the box.
    pub fn clampTo(c: Corners, w: f32, h: f32) Corners {
        var f: f32 = 1;
        if (c.tl + c.tr > w and c.tl + c.tr > 0) f = @min(f, w / (c.tl + c.tr));
        if (c.bl + c.br > w and c.bl + c.br > 0) f = @min(f, w / (c.bl + c.br));
        if (c.tl + c.bl > h and c.tl + c.bl > 0) f = @min(f, h / (c.tl + c.bl));
        if (c.tr + c.br > h and c.tr + c.br > 0) f = @min(f, h / (c.tr + c.br));
        return .{ .tl = c.tl * f, .tr = c.tr * f, .br = c.br * f, .bl = c.bl * f };
    }
    pub fn shrink(c: Corners, d: f32) Corners {
        return .{ .tl = @max(0, c.tl - d), .tr = @max(0, c.tr - d), .br = @max(0, c.br - d), .bl = @max(0, c.bl - d) };
    }
};

/// Non-premultiplied 8-bit sRGB color.
pub const Color = packed struct(u32) {
    r: u8 = 0,
    g: u8 = 0,
    b: u8 = 0,
    a: u8 = 0,

    pub const transparent: Color = .{};
    pub const black: Color = .{ .a = 255 };
    pub const white: Color = .{ .r = 255, .g = 255, .b = 255, .a = 255 };

    pub fn rgba(r: u8, g: u8, b: u8, a: u8) Color {
        return .{ .r = r, .g = g, .b = b, .a = a };
    }
    pub fn rgb(r: u8, g: u8, b: u8) Color {
        return .{ .r = r, .g = g, .b = b, .a = 255 };
    }
    pub fn hex(v: u32) Color {
        return .{ .r = @truncate(v >> 16), .g = @truncate(v >> 8), .b = @truncate(v), .a = 255 };
    }
    pub fn withAlpha(c: Color, alpha: f32) Color {
        var out = c;
        out.a = @intFromFloat(std.math.clamp(@as(f32, @floatFromInt(c.a)) * alpha + 0.5, 0, 255));
        return out;
    }
    pub fn isTransparent(c: Color) bool {
        return c.a == 0;
    }
    pub fn eql(a: Color, b: Color) bool {
        return @as(u32, @bitCast(a)) == @as(u32, @bitCast(b));
    }
    pub fn toF32(c: Color) [4]f32 {
        return .{
            @as(f32, @floatFromInt(c.r)) / 255.0,
            @as(f32, @floatFromInt(c.g)) / 255.0,
            @as(f32, @floatFromInt(c.b)) / 255.0,
            @as(f32, @floatFromInt(c.a)) / 255.0,
        };
    }
    /// Interpolate in non-premultiplied sRGB space (what browsers do for transitions by default).
    pub fn lerp(a: Color, b: Color, t: f32) Color {
        const fa = a.toF32();
        const fb = b.toF32();
        // premultiply so fading to transparent does not darken
        const pa = [4]f32{ fa[0] * fa[3], fa[1] * fa[3], fa[2] * fa[3], fa[3] };
        const pb = [4]f32{ fb[0] * fb[3], fb[1] * fb[3], fb[2] * fb[3], fb[3] };
        var o: [4]f32 = undefined;
        for (0..4) |i| o[i] = pa[i] + (pb[i] - pa[i]) * t;
        if (o[3] <= 0) return .{};
        return .{
            .r = toByte(o[0] / o[3]),
            .g = toByte(o[1] / o[3]),
            .b = toByte(o[2] / o[3]),
            .a = toByte(o[3]),
        };
    }
};

fn toByte(v: f32) u8 {
    return @intFromFloat(std.math.clamp(v * 255.0 + 0.5, 0, 255));
}

/// 2D affine transform [a c e; b d f].
pub const Transform = struct {
    a: f32 = 1,
    b: f32 = 0,
    c: f32 = 0,
    d: f32 = 1,
    e: f32 = 0,
    f: f32 = 0,

    pub const identity: Transform = .{};

    pub fn isIdentity(t: Transform) bool {
        return t.a == 1 and t.b == 0 and t.c == 0 and t.d == 1 and t.e == 0 and t.f == 0;
    }
    pub fn translation(x: f32, y: f32) Transform {
        return .{ .e = x, .f = y };
    }
    pub fn scaling(sx: f32, sy: f32) Transform {
        return .{ .a = sx, .d = sy };
    }
    pub fn rotation(rad: f32) Transform {
        const c = @cos(rad);
        const s = @sin(rad);
        return .{ .a = c, .b = s, .c = -s, .d = c };
    }
    /// self then other  (apply self first)
    pub fn then(t: Transform, o: Transform) Transform {
        return .{
            .a = o.a * t.a + o.c * t.b,
            .b = o.b * t.a + o.d * t.b,
            .c = o.a * t.c + o.c * t.d,
            .d = o.b * t.c + o.d * t.d,
            .e = o.a * t.e + o.c * t.f + o.e,
            .f = o.b * t.e + o.d * t.f + o.f,
        };
    }
    pub fn apply(t: Transform, p: Point) Point {
        return .{ .x = t.a * p.x + t.c * p.y + t.e, .y = t.b * p.x + t.d * p.y + t.f };
    }
    pub fn invert(t: Transform) ?Transform {
        const det = t.a * t.d - t.b * t.c;
        if (@abs(det) < 1e-12) return null;
        const id = 1.0 / det;
        return .{
            .a = t.d * id,
            .b = -t.b * id,
            .c = -t.c * id,
            .d = t.a * id,
            .e = (t.c * t.f - t.d * t.e) * id,
            .f = (t.b * t.e - t.a * t.f) * id,
        };
    }
    pub fn boundsOf(t: Transform, r: Rect) Rect {
        const pts = [_]Point{
            t.apply(.{ .x = r.x, .y = r.y }),
            t.apply(.{ .x = r.right(), .y = r.y }),
            t.apply(.{ .x = r.x, .y = r.bottom() }),
            t.apply(.{ .x = r.right(), .y = r.bottom() }),
        };
        var x0 = pts[0].x;
        var y0 = pts[0].y;
        var x1 = x0;
        var y1 = y0;
        for (pts[1..]) |p| {
            x0 = @min(x0, p.x);
            y0 = @min(y0, p.y);
            x1 = @max(x1, p.x);
            y1 = @max(y1, p.y);
        }
        return .{ .x = x0, .y = y0, .w = x1 - x0, .h = y1 - y0 };
    }
};

test "transform invert" {
    const t = Transform.translation(10, 5).then(Transform.scaling(2, 3));
    const inv = t.invert().?;
    const p = inv.apply(t.apply(.{ .x = 3, .y = 4 }));
    try std.testing.expectApproxEqAbs(@as(f32, 3), p.x, 1e-4);
    try std.testing.expectApproxEqAbs(@as(f32, 4), p.y, 1e-4);
}
