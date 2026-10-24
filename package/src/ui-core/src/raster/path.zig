//! Vector paths and an anti-aliased coverage rasterizer, shared by glyph
//! outlines, inline SVG and color-font layers. Pure Zig, no platform APIs.
//!
//! The rasterizer accumulates signed area per pixel (the approach used by
//! font-rs and stb_truetype's v2 rasterizer): each edge deposits the exact
//! area it covers in the cells it crosses, and a prefix sum along each row
//! yields the winding density. That gives exact anti-aliasing for any path
//! without supersampling.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Point = struct {
    x: f32,
    y: f32,

    pub fn lerp(a: Point, b: Point, t: f32) Point {
        return .{ .x = a.x + (b.x - a.x) * t, .y = a.y + (b.y - a.y) * t };
    }
};

/// 2D affine transform: x' = a*x + c*y + e, y' = b*x + d*y + f.
pub const Affine = struct {
    a: f32 = 1,
    b: f32 = 0,
    c: f32 = 0,
    d: f32 = 1,
    e: f32 = 0,
    f: f32 = 0,

    pub const identity: Affine = .{};

    pub fn apply(t: Affine, p: Point) Point {
        return .{ .x = t.a * p.x + t.c * p.y + t.e, .y = t.b * p.x + t.d * p.y + t.f };
    }

    /// `t` then `o` (apply t first).
    pub fn then(t: Affine, o: Affine) Affine {
        return .{
            .a = o.a * t.a + o.c * t.b,
            .b = o.b * t.a + o.d * t.b,
            .c = o.a * t.c + o.c * t.d,
            .d = o.b * t.c + o.d * t.d,
            .e = o.a * t.e + o.c * t.f + o.e,
            .f = o.b * t.e + o.d * t.f + o.f,
        };
    }

    pub fn translate(x: f32, y: f32) Affine {
        return .{ .e = x, .f = y };
    }

    pub fn scale(sx: f32, sy: f32) Affine {
        return .{ .a = sx, .d = sy };
    }

    /// Largest linear scale factor (for curve flattening tolerance).
    pub fn maxScale(t: Affine) f32 {
        const sx = @sqrt(t.a * t.a + t.b * t.b);
        const sy = @sqrt(t.c * t.c + t.d * t.d);
        return @max(sx, sy);
    }
};

pub const Verb = enum(u8) { move, line, quad, cubic, close };

/// A path: verbs plus their points (move/line: 1, quad: 2, cubic: 3).
pub const Path = struct {
    verbs: std.ArrayList(Verb) = .empty,
    points: std.ArrayList(Point) = .empty,

    pub fn deinit(p: *Path, gpa: Allocator) void {
        p.verbs.deinit(gpa);
        p.points.deinit(gpa);
    }

    pub fn clear(p: *Path) void {
        p.verbs.clearRetainingCapacity();
        p.points.clearRetainingCapacity();
    }

    pub fn moveTo(p: *Path, gpa: Allocator, x: f32, y: f32) !void {
        try p.verbs.append(gpa, .move);
        try p.points.append(gpa, .{ .x = x, .y = y });
    }

    pub fn lineTo(p: *Path, gpa: Allocator, x: f32, y: f32) !void {
        try p.verbs.append(gpa, .line);
        try p.points.append(gpa, .{ .x = x, .y = y });
    }

    pub fn quadTo(p: *Path, gpa: Allocator, cx: f32, cy: f32, x: f32, y: f32) !void {
        try p.verbs.append(gpa, .quad);
        try p.points.appendSlice(gpa, &.{ .{ .x = cx, .y = cy }, .{ .x = x, .y = y } });
    }

    pub fn cubicTo(p: *Path, gpa: Allocator, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) !void {
        try p.verbs.append(gpa, .cubic);
        try p.points.appendSlice(gpa, &.{ .{ .x = c1x, .y = c1y }, .{ .x = c2x, .y = c2y }, .{ .x = x, .y = y } });
    }

    pub fn close(p: *Path, gpa: Allocator) !void {
        try p.verbs.append(gpa, .close);
    }

    pub fn isEmpty(p: *const Path) bool {
        return p.verbs.items.len == 0;
    }

    /// Bounds of the control points after `t` (conservative for curves).
    pub fn bounds(p: *const Path, t: Affine) ?[4]f32 {
        if (p.points.items.len == 0) return null;
        var b = [4]f32{ std.math.inf(f32), std.math.inf(f32), -std.math.inf(f32), -std.math.inf(f32) };
        for (p.points.items) |pt| {
            const q = t.apply(pt);
            b[0] = @min(b[0], q.x);
            b[1] = @min(b[1], q.y);
            b[2] = @max(b[2], q.x);
            b[3] = @max(b[3], q.y);
        }
        return b;
    }

    /// Walk the path as line segments (curves flattened to within
    /// `tolerance` px after `t`), with implicit closing of every subpath.
    pub fn flatten(p: *const Path, t: Affine, tolerance: f32, ctx: anytype, comptime emit: fn (@TypeOf(ctx), Point, Point) void) void {
        const pts = p.points.items;
        var i: usize = 0;
        var start: Point = .{ .x = 0, .y = 0 };
        var cur: Point = start;
        var open = false;
        const tol = @max(tolerance, 0.01);
        for (p.verbs.items) |v| switch (v) {
            .move => {
                if (open and (cur.x != start.x or cur.y != start.y)) emit(ctx, cur, start);
                start = t.apply(pts[i]);
                cur = start;
                open = true;
                i += 1;
            },
            .line => {
                const q = t.apply(pts[i]);
                emit(ctx, cur, q);
                cur = q;
                i += 1;
            },
            .quad => {
                const c = t.apply(pts[i]);
                const q = t.apply(pts[i + 1]);
                // Wang's formula: segments needed to stay within `tol`
                const dd = norm(cur.x - 2 * c.x + q.x, cur.y - 2 * c.y + q.y);
                const n = segmentCount(@sqrt(dd / (4 * tol)), 128);
                var prev = cur;
                var k: u32 = 1;
                while (k <= n) : (k += 1) {
                    const s = @as(f32, @floatFromInt(k)) / @as(f32, @floatFromInt(n));
                    const nx = Point.lerp(Point.lerp(cur, c, s), Point.lerp(c, q, s), s);
                    emit(ctx, prev, nx);
                    prev = nx;
                }
                cur = q;
                i += 2;
            },
            .cubic => {
                const c1 = t.apply(pts[i]);
                const c2 = t.apply(pts[i + 1]);
                const q = t.apply(pts[i + 2]);
                const d1 = norm(cur.x - 2 * c1.x + c2.x, cur.y - 2 * c1.y + c2.y);
                const d2 = norm(c1.x - 2 * c2.x + q.x, c1.y - 2 * c2.y + q.y);
                const dd = @max(d1, d2);
                const n = segmentCount(@sqrt(3 * dd / (4 * tol)), 192);
                var prev = cur;
                var k: u32 = 1;
                while (k <= n) : (k += 1) {
                    const s = @as(f32, @floatFromInt(k)) / @as(f32, @floatFromInt(n));
                    const a = Point.lerp(cur, c1, s);
                    const bb = Point.lerp(c1, c2, s);
                    const cc = Point.lerp(c2, q, s);
                    const nx = Point.lerp(Point.lerp(a, bb, s), Point.lerp(bb, cc, s), s);
                    emit(ctx, prev, nx);
                    prev = nx;
                }
                cur = q;
                i += 3;
            },
            .close => {
                if (open and (cur.x != start.x or cur.y != start.y)) emit(ctx, cur, start);
                cur = start;
            },
        };
        if (open and (cur.x != start.x or cur.y != start.y)) emit(ctx, cur, start);
    }
};

fn norm(x: f32, y: f32) f32 {
    return @sqrt(x * x + y * y);
}

/// Coordinates are clamped to ±this before rasterizing; far beyond any
/// raster, small enough that span arithmetic stays finite.
const coord_limit: f32 = 1e7;

fn finitePoint(p: Point) bool {
    return std.math.isFinite(p.x) and std.math.isFinite(p.y);
}

fn clampPoint(p: Point) Point {
    return .{ .x = std.math.clamp(p.x, -coord_limit, coord_limit), .y = std.math.clamp(p.y, -coord_limit, coord_limit) };
}

/// Number of flattening segments: `x` rounded up, within [1, max]; NaN/inf → 1.
fn segmentCount(x: f32, max: u32) u32 {
    if (!std.math.isFinite(x)) return 1;
    return @intFromFloat(std.math.clamp(@ceil(x), 1, @as(f32, @floatFromInt(max))));
}

pub const FillRule = enum { nonzero, even_odd };

/// Signed-area accumulation rasterizer over a w×h pixel grid.
pub const Rasterizer = struct {
    w: u32,
    h: u32,
    /// one extra cell per row so edges at the right border have somewhere to land
    acc: []f32,

    pub fn init(gpa: Allocator, w: u32, h: u32) !Rasterizer {
        const acc = try gpa.alloc(f32, @as(usize, w + 1) * h);
        @memset(acc, 0);
        return .{ .w = w, .h = h, .acc = acc };
    }

    pub fn deinit(r: *Rasterizer, gpa: Allocator) void {
        gpa.free(r.acc);
    }

    pub fn reset(r: *Rasterizer) void {
        @memset(r.acc, 0);
    }

    /// Add `path` transformed by `t` (to pixel coordinates).
    pub fn fill(r: *Rasterizer, path: *const Path, t: Affine) void {
        path.flatten(t, 0.05, r, Rasterizer.edge);
    }

    /// Deposit the signed area of the line p0→p1 (pixel coordinates).
    pub fn edge(r: *Rasterizer, p0_in: Point, p1_in: Point) void {
        // degenerate input: drop non-finite edges, bound huge coordinates so
        // the span arithmetic below can't overflow to inf/NaN
        if (!finitePoint(p0_in) or !finitePoint(p1_in)) return;
        const p0 = clampPoint(p0_in);
        const p1 = clampPoint(p1_in);
        if (p0.y == p1.y) return;
        const dir: f32 = if (p0.y < p1.y) 1 else -1;
        const a = if (p0.y < p1.y) p0 else p1;
        const b = if (p0.y < p1.y) p1 else p0;
        const hf: f32 = @floatFromInt(r.h);
        const y0 = std.math.clamp(a.y, 0, hf);
        const y1 = std.math.clamp(b.y, 0, hf);
        if (y0 >= y1) return;
        const dxdy = (b.x - a.x) / (b.y - a.y);
        var x = a.x + (y0 - a.y) * dxdy;
        const stride = r.w + 1;
        const wf: f32 = @floatFromInt(r.w);
        var y_row: usize = @intFromFloat(@floor(y0));
        while (@as(f32, @floatFromInt(y_row)) < y1) : (y_row += 1) {
            const row_top: f32 = @floatFromInt(y_row);
            const ya = @max(row_top, y0);
            const yb = @min(row_top + 1, y1);
            const dy = yb - ya;
            if (dy <= 0) continue;
            const xnext = x + dxdy * dy;
            const row = r.acc[y_row * stride ..][0..stride];
            // horizontal extent of this row's piece of the edge; parts left
            // of the grid cover the whole row (deposit at column 0), parts
            // right of it cover nothing
            const lo = @min(x, xnext);
            const hi = @max(x, xnext);
            const d = dy * dir;
            if (hi <= 0) {
                row[0] += d;
            } else if (lo >= wf) {
                // entirely right of the grid
            } else if (hi - lo < 1e-6) {
                spanCells(row, lo, hi, d);
            } else {
                const span = hi - lo;
                const left = @max(0, -lo) / span;
                const right = @max(0, hi - wf) / span;
                if (left > 0) row[0] += d * left;
                spanCells(row, @max(lo, 0), @min(hi, wf), d * (1 - left - right));
            }
            x = xnext;
        }
    }

    /// Deposit an edge piece spanning x ∈ [xa, xb] with vertical extent `d`
    /// (signed) into one row. Within each cell the edge covers a vertical
    /// share proportional to its horizontal overlap; the area to the right of
    /// the edge in that cell is the share times (1 - mean x offset), and the
    /// rest carries into the next cell for the row's prefix sum.
    fn spanCells(row: []f32, xa: f32, xb: f32, d: f32) void {
        const span = xb - xa;
        const k0: usize = @intFromFloat(@floor(xa));
        if (span < 1e-6) {
            // vertical edge piece
            const xm = xa - @as(f32, @floatFromInt(k0));
            row[k0] += d * (1 - xm);
            if (k0 + 1 < row.len) row[k0 + 1] += d * xm;
            return;
        }
        const kend: usize = @intFromFloat(@floor(xb));
        var k = k0;
        while (k <= kend and k < row.len) : (k += 1) {
            const kf: f32 = @floatFromInt(k);
            const lo = @max(xa, kf);
            const hi = @min(xb, kf + 1);
            if (hi <= lo) continue;
            const part = d * (hi - lo) / span;
            const xm = (lo + hi) / 2 - kf;
            row[k] += part * (1 - xm);
            if (k + 1 < row.len) row[k + 1] += part * xm;
        }
    }

    /// Resolve accumulated area into A8 coverage (`out` is w*h).
    pub fn coverage(r: *const Rasterizer, out: []u8, rule: FillRule) void {
        const stride = r.w + 1;
        for (0..r.h) |y| {
            var sum: f32 = 0;
            const row = r.acc[y * stride ..][0..stride];
            for (0..r.w) |x| {
                sum += row[x];
                const v = switch (rule) {
                    .nonzero => @min(1, @abs(sum)),
                    .even_odd => blk: {
                        const m = @mod(@abs(sum), 2);
                        break :blk if (m > 1) 2 - m else m;
                    },
                };
                out[y * r.w + x] = if (std.math.isFinite(v)) @intFromFloat(@round(std.math.clamp(v, 0, 1) * 255)) else 0;
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

fn rect(gpa: Allocator, p: *Path, x0: f32, y0: f32, x1: f32, y1: f32) !void {
    try p.moveTo(gpa, x0, y0);
    try p.lineTo(gpa, x1, y0);
    try p.lineTo(gpa, x1, y1);
    try p.lineTo(gpa, x0, y1);
    try p.close(gpa);
}

fn render(gpa: Allocator, p: *const Path, w: u32, h: u32, rule: FillRule) ![]u8 {
    var r = try Rasterizer.init(gpa, w, h);
    defer r.deinit(gpa);
    r.fill(p, .identity);
    const out = try gpa.alloc(u8, w * h);
    r.coverage(out, rule);
    return out;
}

test "pixel-aligned rectangle is exact" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try rect(gpa, &p, 2, 1, 6, 4);
    const out = try render(gpa, &p, 8, 6, .nonzero);
    defer gpa.free(out);
    for (0..6) |y| for (0..8) |x| {
        const inside = x >= 2 and x < 6 and y >= 1 and y < 4;
        try std.testing.expectEqual(@as(u8, if (inside) 255 else 0), out[y * 8 + x]);
    };
}

test "half-pixel edges give half coverage" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try rect(gpa, &p, 1.5, 1, 3.5, 3);
    const out = try render(gpa, &p, 5, 4, .nonzero);
    defer gpa.free(out);
    try std.testing.expectEqual(@as(u8, 128), out[1 * 5 + 1]);
    try std.testing.expectEqual(@as(u8, 255), out[1 * 5 + 2]);
    try std.testing.expectEqual(@as(u8, 128), out[1 * 5 + 3]);
}

test "diagonal edges conserve area" {
    // a right triangle covering half of a 16x16 square, crossing many cells
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, 0, 0);
    try p.lineTo(gpa, 16, 16);
    try p.lineTo(gpa, 0, 16);
    try p.close(gpa);
    const out = try render(gpa, &p, 16, 16, .nonzero);
    defer gpa.free(out);
    var total: f32 = 0;
    for (out) |v| total += @as(f32, @floatFromInt(v)) / 255;
    try std.testing.expectApproxEqAbs(@as(f32, 128), total, 0.6);
    // shallow edge crossing several cells per row
    var q: Path = .{};
    defer q.deinit(gpa);
    try q.moveTo(gpa, 0, 0);
    try q.lineTo(gpa, 16, 2);
    try q.lineTo(gpa, 0, 2);
    try q.close(gpa);
    const out2 = try render(gpa, &q, 16, 2, .nonzero);
    defer gpa.free(out2);
    var t2: f32 = 0;
    for (out2) |v| t2 += @as(f32, @floatFromInt(v)) / 255;
    try std.testing.expectApproxEqAbs(@as(f32, 16), t2, 0.2);
}

test "fill rules: nested squares" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try rect(gpa, &p, 0, 0, 10, 10);
    try rect(gpa, &p, 3, 3, 7, 7); // same winding direction
    const nz = try render(gpa, &p, 10, 10, .nonzero);
    defer gpa.free(nz);
    const eo = try render(gpa, &p, 10, 10, .even_odd);
    defer gpa.free(eo);
    try std.testing.expectEqual(@as(u8, 255), nz[5 * 10 + 5]);
    try std.testing.expectEqual(@as(u8, 0), eo[5 * 10 + 5]);
    try std.testing.expectEqual(@as(u8, 255), eo[1 * 10 + 1]);
}

test "circle from cubics has the right area" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    const k: f32 = 0.5522847;
    const cx: f32 = 16;
    const cy: f32 = 16;
    const rr: f32 = 12;
    try p.moveTo(gpa, cx + rr, cy);
    try p.cubicTo(gpa, cx + rr, cy + rr * k, cx + rr * k, cy + rr, cx, cy + rr);
    try p.cubicTo(gpa, cx - rr * k, cy + rr, cx - rr, cy + rr * k, cx - rr, cy);
    try p.cubicTo(gpa, cx - rr, cy - rr * k, cx - rr * k, cy - rr, cx, cy - rr);
    try p.cubicTo(gpa, cx + rr * k, cy - rr, cx + rr, cy - rr * k, cx + rr, cy);
    try p.close(gpa);
    const out = try render(gpa, &p, 32, 32, .nonzero);
    defer gpa.free(out);
    var total: f32 = 0;
    for (out) |v| total += @as(f32, @floatFromInt(v)) / 255;
    try std.testing.expectApproxEqRel(@as(f32, std.math.pi * rr * rr), total, 0.01);
}

test "edges partly outside the grid keep exact coverage" {
    const gpa = std.testing.allocator;
    // triangle whose sloped edge starts left of the grid
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, -4, 0);
    try p.lineTo(gpa, 4, 4);
    try p.lineTo(gpa, 8, 4);
    try p.lineTo(gpa, 8, 0);
    try p.close(gpa);
    const out = try render(gpa, &p, 8, 4, .nonzero);
    defer gpa.free(out);
    var total: f32 = 0;
    for (out) |v| total += @as(f32, @floatFromInt(v)) / 255;
    // area inside the grid: 8*4 minus the triangle below the edge (x<4 part)
    // edge x(y) = -4 + 2y; uncovered region left of it within [0,8]: ∫ max(0, x(y)) dy over y∈[2,4] = 4
    try std.testing.expectApproxEqAbs(@as(f32, 32 - 4), total, 0.1);
}

test "degenerate input never crashes or poisons coverage" {
    const gpa = std.testing.allocator;
    const nan = std.math.nan(f32);
    const inf = std.math.inf(f32);
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, nan, 1);
    try p.lineTo(gpa, 3, inf);
    try p.cubicTo(gpa, nan, nan, 1e30, -1e30, 2, 2);
    try p.quadTo(gpa, inf, 0, 1, 1);
    try p.moveTo(gpa, -1e30, -1e30);
    try p.lineTo(gpa, 1e30, 1e30);
    try p.lineTo(gpa, -1e30, 1e30);
    try p.close(gpa);
    try rect(gpa, &p, 1, 1, 3, 3);
    const out = try render(gpa, &p, 4, 4, .nonzero);
    defer gpa.free(out);
    // the well-formed square still renders fully
    try std.testing.expectEqual(@as(u8, 255), out[2 * 4 + 2]);
    // huge transforms are fine too
    var r = try Rasterizer.init(gpa, 4, 4);
    defer r.deinit(gpa);
    r.fill(&p, .{ .a = 1e20, .d = -1e20, .e = nan });
    var cov: [16]u8 = undefined;
    r.coverage(&cov, .even_odd);
}

test "edges outside the grid are clipped without crashing" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try rect(gpa, &p, -5, -5, 20, 20);
    const out = try render(gpa, &p, 4, 4, .nonzero);
    defer gpa.free(out);
    for (out) |v| try std.testing.expectEqual(@as(u8, 255), v);
}
