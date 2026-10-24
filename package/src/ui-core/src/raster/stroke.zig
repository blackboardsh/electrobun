//! Stroking: converts a path into closed outlines covering its stroke, to be
//! filled with the non-zero rule.
//!
//! The stroke is built in the path's own (user) space and transformed
//! afterwards, so non-uniform transforms stretch strokes the way SVG
//! specifies. Each subpath becomes one outline (open: left offset forward,
//! end cap, right offset back, start cap; closed: two opposite rings), with
//! joins on the outer side and a pivot through the vertex on the inner side.
//! Anti-aliased edges are therefore true boundaries of a single shape;
//! emitting overlapping pieces instead would over-cover edge pixels where
//! pieces overlap (the coverage of overlapping polygons sums before clamping).
const std = @import("std");
const path_mod = @import("path.zig");
const Path = path_mod.Path;
const Point = path_mod.Point;
const Allocator = std.mem.Allocator;

pub const Cap = enum { butt, round, square };
pub const Join = enum { miter, round, bevel };

pub const Style = struct {
    width: f32,
    cap: Cap = .butt,
    join: Join = .miter,
    /// ratio of miter length to stroke width (SVG/CoreGraphics default 4/10)
    miter_limit: f32 = 10,
};

/// Coordinates beyond this are treated as degenerate input.
const max_coord: f32 = 1e7;

fn finite(p: Point) bool {
    return std.math.isFinite(p.x) and std.math.isFinite(p.y) and @abs(p.x) < max_coord and @abs(p.y) < max_coord;
}

fn sub(a: Point, b: Point) Point {
    return .{ .x = a.x - b.x, .y = a.y - b.y };
}
fn add(a: Point, b: Point) Point {
    return .{ .x = a.x + b.x, .y = a.y + b.y };
}
fn mul(a: Point, s: f32) Point {
    return .{ .x = a.x * s, .y = a.y * s };
}
fn len(a: Point) f32 {
    return @sqrt(a.x * a.x + a.y * a.y);
}
fn cross(a: Point, b: Point) f32 {
    return a.x * b.y - a.y * b.x;
}
fn dot(a: Point, b: Point) f32 {
    return a.x * b.x + a.y * b.y;
}

const Stroker = struct {
    gpa: Allocator,
    out: *Path,
    hw: f32,
    style: Style,
    tol: f32,
    poly: std.ArrayList(Point) = .empty,

    /// Emit `pts` as one closed polygon with positive signed area.
    fn polygon(s: *Stroker, pts: []const Point) !void {
        if (pts.len < 3) return;
        var area: f32 = 0;
        for (pts, 0..) |p, i| {
            const q = pts[(i + 1) % pts.len];
            area += p.x * q.y - q.x * p.y;
        }
        if (@abs(area) < 1e-12) return;
        const rev = area < 0;
        for (0..pts.len) |k| {
            const p = if (rev) pts[pts.len - 1 - k] else pts[k];
            if (k == 0) try s.out.moveTo(s.gpa, p.x, p.y) else try s.out.lineTo(s.gpa, p.x, p.y);
        }
        try s.out.close(s.gpa);
    }

    /// Points on a circle arc around `c` from angle a0 sweeping `sweep`.
    fn arcSteps(s: *Stroker, sweep: f32) u32 {
        const r = s.hw;
        const ratio = std.math.clamp(1 - s.tol / @max(r, 1e-6), -1, 1);
        const step = @max(2 * std.math.acos(ratio), 0.05);
        return @intFromFloat(std.math.clamp(@ceil(@abs(sweep) / step), 2, 256));
    }

    fn circle(s: *Stroker, c: Point) !void {
        const n = s.arcSteps(2 * std.math.pi);
        s.poly.clearRetainingCapacity();
        for (0..n) |i| {
            const a = 2 * std.math.pi * @as(f32, @floatFromInt(i)) / @as(f32, @floatFromInt(n));
            try s.poly.append(s.gpa, .{ .x = c.x + s.hw * @cos(a), .y = c.y + s.hw * @sin(a) });
        }
        try s.polygon(s.poly.items);
    }

    fn put(s: *Stroker, p: Point) !void {
        try s.poly.append(s.gpa, p);
    }

    /// Emit the points collected in `poly` as one closed contour, as is.
    fn flush(s: *Stroker) !void {
        const pts = s.poly.items;
        if (pts.len >= 3) {
            try s.out.moveTo(s.gpa, pts[0].x, pts[0].y);
            for (pts[1..]) |p| try s.out.lineTo(s.gpa, p.x, p.y);
            try s.out.close(s.gpa);
        }
        s.poly.clearRetainingCapacity();
    }

    /// Arc points around `c` from offset `from` sweeping `sweep` radians
    /// (excluding the start point, including the end).
    fn arc(s: *Stroker, c: Point, from: Point, sweep: f32) !void {
        const n = s.arcSteps(sweep);
        const a0 = std.math.atan2(from.y, from.x);
        for (1..n + 1) |k| {
            const a = a0 + sweep * @as(f32, @floatFromInt(k)) / @as(f32, @floatFromInt(n));
            try s.put(.{ .x = c.x + s.hw * @cos(a), .y = c.y + s.hw * @sin(a) });
        }
    }

    /// Walk one side of the stroke across vertex `v` (directions d0 → d1),
    /// where `side` is +1 for the left offset (normal (-dy, dx)) and -1 for
    /// the right. Appends the points from the incoming offset to the
    /// outgoing offset.
    fn corner(s: *Stroker, v: Point, d0: Point, d1: Point, side: f32, len0: f32, len1: f32) !void {
        const n0 = Point{ .x = -d0.y * s.hw * side, .y = d0.x * s.hw * side };
        const n1 = Point{ .x = -d1.y * s.hw * side, .y = d1.x * s.hw * side };
        const p0 = add(v, n0);
        const p1 = add(v, n1);
        const cr = cross(d0, d1);
        const dt = dot(d0, d1);
        if (@abs(cr) < 1e-6 and dt > 0) {
            try s.put(p0);
            return;
        }
        // this side is outer when the path turns away from it
        const outer = (cr < 0) == (side > 0) or (@abs(cr) < 1e-6);
        try s.put(p0);
        if (!outer) {
            // inner side: the offset lines cross at X, hw/tan(θ/2) along each
            // segment from v. Use X when it lies within both segments (exact
            // boundary); otherwise pivot through the vertex, which keeps the
            // winding consistent when segments are shorter than the stroke
            // is wide (tight curves).
            const cos_theta = std.math.clamp(-dt, -1, 1);
            const sin_half = @sqrt(@max(0, (1 - cos_theta) / 2));
            const cos_half = @sqrt(@max(0, (1 + cos_theta) / 2));
            if (sin_half > 1e-6) {
                const along = s.hw * cos_half / sin_half;
                if (along <= len0 and along <= len1) {
                    const bis = add(n0, n1);
                    const bl = len(bis);
                    if (bl > 1e-9) {
                        s.poly.items.len -= 1; // replace p0 with X
                        try s.put(add(v, mul(bis, (s.hw / sin_half) / bl)));
                        return;
                    }
                }
            }
            try s.put(v);
            try s.put(p1);
            return;
        }
        switch (s.style.join) {
            .bevel => {},
            .miter => {
                const cos_theta = std.math.clamp(-dt, -1, 1);
                const sin_half = @sqrt(@max(0, (1 - cos_theta) / 2));
                if (sin_half > 1e-6 and 1 / sin_half <= s.style.miter_limit) {
                    const bis = add(n0, n1);
                    const bl = len(bis);
                    if (bl > 1e-9) try s.put(add(v, mul(bis, (s.hw / sin_half) / bl)));
                }
            },
            .round => {
                // sweep the outer side from n0 to n1
                var sweep = std.math.atan2(cross(n0, n1), dot(n0, n1));
                if (@abs(cr) < 1e-6) sweep = std.math.pi * side; // 180° reversal
                try s.arc(v, n0, sweep);
                return;
            },
        }
        try s.put(p1);
    }

    /// Cap at `end` heading in unit direction `dir`, from the left offset
    /// to the right offset.
    fn capTo(s: *Stroker, end: Point, dir: Point) !void {
        const nl = Point{ .x = -dir.y * s.hw, .y = dir.x * s.hw };
        const left = add(end, nl);
        const right = sub(end, nl);
        switch (s.style.cap) {
            .butt => {
                try s.put(left);
                try s.put(right);
            },
            .square => {
                const e = mul(dir, s.hw);
                try s.put(left);
                try s.put(add(left, e));
                try s.put(add(right, e));
                try s.put(right);
            },
            .round => {
                try s.put(left);
                // from the left normal through the forward direction to the right
                try s.arc(end, nl, -std.math.pi);
            },
        }
    }

    /// Stroke one flattened subpath.
    fn polyline(s: *Stroker, pts_in: []const Point, closed: bool) !void {
        // drop consecutive duplicates
        var pts: std.ArrayList(Point) = .empty;
        defer pts.deinit(s.gpa);
        for (pts_in) |p| {
            if (!finite(p)) return;
            if (pts.items.len > 0) {
                const last = pts.items[pts.items.len - 1];
                if (last.x == p.x and last.y == p.y) continue;
            }
            try pts.append(s.gpa, p);
        }
        var p = pts.items;
        if (closed and p.len > 1 and p[0].x == p[p.len - 1].x and p[0].y == p[p.len - 1].y) p = p[0 .. p.len - 1];
        if (p.len == 0) return;
        if (p.len == 1) {
            // zero-length subpath: caps draw a dot (SVG), butt draws nothing
            switch (s.style.cap) {
                .round => try s.circle(p[0]),
                .square => try s.polygon(&.{
                    .{ .x = p[0].x - s.hw, .y = p[0].y - s.hw }, .{ .x = p[0].x + s.hw, .y = p[0].y - s.hw },
                    .{ .x = p[0].x + s.hw, .y = p[0].y + s.hw }, .{ .x = p[0].x - s.hw, .y = p[0].y + s.hw },
                }),
                .butt => {},
            }
            return;
        }
        const n = p.len;
        s.poly.clearRetainingCapacity();
        if (closed) {
            // left ring forward, then right ring backward (opposite winding)
            for (0..n) |i| {
                const a = p[(i + n - 1) % n];
                const b = p[(i + 1) % n];
                try s.corner(p[i], dirOf(a, p[i]), dirOf(p[i], b), 1, dist(a, p[i]), dist(p[i], b));
            }
            try s.flush();
            var k: usize = n;
            while (k > 0) {
                k -= 1;
                // walking backwards, directions are reversed; the right side
                // of the forward path is the left side of the reversed one
                const a = p[(k + 1) % n];
                const b = p[(k + n - 1) % n];
                try s.corner(p[k], dirOf(a, p[k]), dirOf(p[k], b), 1, dist(a, p[k]), dist(p[k], b));
            }
            try s.flush();
            return;
        }
        // open: start offset, left side forward, end cap, right side back, start cap
        const d_first = dirOf(p[0], p[1]);
        try s.put(add(p[0], Point{ .x = -d_first.y * s.hw, .y = d_first.x * s.hw }));
        for (1..n - 1) |i| try s.corner(p[i], dirOf(p[i - 1], p[i]), dirOf(p[i], p[i + 1]), 1, dist(p[i - 1], p[i]), dist(p[i], p[i + 1]));
        try s.capTo(p[n - 1], dirOf(p[n - 2], p[n - 1]));
        var k: usize = n - 1;
        while (k > 1) {
            k -= 1;
            try s.corner(p[k], dirOf(p[k + 1], p[k]), dirOf(p[k], p[k - 1]), 1, dist(p[k + 1], p[k]), dist(p[k], p[k - 1]));
        }
        try s.capTo(p[0], dirOf(p[1], p[0]));
        try s.flush();
    }
};

fn dist(a: Point, b: Point) f32 {
    return len(sub(b, a));
}

fn dirOf(a: Point, b: Point) Point {
    const d = sub(b, a);
    const l = len(d);
    return .{ .x = d.x / l, .y = d.y / l };
}

/// Append polygons covering the stroke of `src` to `out`. `tolerance` is the
/// flattening tolerance in `src` units (device tolerance / transform scale).
pub fn stroke(gpa: Allocator, src: *const Path, style: Style, tolerance: f32, out: *Path) !void {
    if (!(style.width > 0) or !std.math.isFinite(style.width)) return;
    var s = Stroker{ .gpa = gpa, .out = out, .hw = style.width / 2, .style = style, .tol = @max(tolerance, 1e-4) };
    defer s.poly.deinit(gpa);
    var line: std.ArrayList(Point) = .empty;
    defer line.deinit(gpa);
    const pts = src.points.items;
    var i: usize = 0;
    // a subpath is stroked only if it has a drawing command (SVG: a lone
    // moveto draws nothing; "M x y Z" or a zero-length lineto draws caps)
    var drawn = false;
    for (src.verbs.items) |v| switch (v) {
        .move => {
            if (drawn) try s.polyline(line.items, false);
            line.clearRetainingCapacity();
            try line.append(gpa, pts[i]);
            drawn = false;
            i += 1;
        },
        .line => {
            if (line.items.len > 0) {
                try line.append(gpa, pts[i]);
                drawn = true;
            }
            i += 1;
        },
        .quad => {
            if (line.items.len > 0) {
                try flattenQuad(gpa, &line, pts[i], pts[i + 1], s.tol);
                drawn = true;
            }
            i += 2;
        },
        .cubic => {
            if (line.items.len > 0) {
                try flattenCubic(gpa, &line, pts[i], pts[i + 1], pts[i + 2], s.tol);
                drawn = true;
            }
            i += 3;
        },
        .close => if (line.items.len > 0) {
            try s.polyline(line.items, true);
            // drawing continues from the closed subpath's start point
            const start = line.items[0];
            line.clearRetainingCapacity();
            try line.append(gpa, start);
            drawn = false;
        },
    };
    if (drawn) try s.polyline(line.items, false);
}

fn flattenQuad(gpa: Allocator, line: *std.ArrayList(Point), c: Point, q: Point, tol: f32) !void {
    const cur = line.items[line.items.len - 1];
    const dd = len(.{ .x = cur.x - 2 * c.x + q.x, .y = cur.y - 2 * c.y + q.y });
    const n = segments(@sqrt(dd / (4 * tol)), 128);
    for (1..n + 1) |k| {
        const t = @as(f32, @floatFromInt(k)) / @as(f32, @floatFromInt(n));
        try line.append(gpa, Point.lerp(Point.lerp(cur, c, t), Point.lerp(c, q, t), t));
    }
}

fn flattenCubic(gpa: Allocator, line: *std.ArrayList(Point), c1: Point, c2: Point, q: Point, tol: f32) !void {
    const cur = line.items[line.items.len - 1];
    const d1 = len(.{ .x = cur.x - 2 * c1.x + c2.x, .y = cur.y - 2 * c1.y + c2.y });
    const d2 = len(.{ .x = c1.x - 2 * c2.x + q.x, .y = c1.y - 2 * c2.y + q.y });
    const n = segments(@sqrt(3 * @max(d1, d2) / (4 * tol)), 192);
    for (1..n + 1) |k| {
        const t = @as(f32, @floatFromInt(k)) / @as(f32, @floatFromInt(n));
        const a = Point.lerp(cur, c1, t);
        const b = Point.lerp(c1, c2, t);
        const cc = Point.lerp(c2, q, t);
        try line.append(gpa, Point.lerp(Point.lerp(a, b, t), Point.lerp(b, cc, t), t));
    }
}

fn segments(x: f32, max: u32) usize {
    if (!std.math.isFinite(x)) return 1;
    return @intFromFloat(std.math.clamp(@ceil(x), 1, @as(f32, @floatFromInt(max))));
}

// ---------------------------------------------------------------------------
// Tests: stroked areas are measured by rasterizing the outline.
// ---------------------------------------------------------------------------

fn strokedArea(gpa: Allocator, src: *const Path, style: Style) !f32 {
    var out: Path = .{};
    defer out.deinit(gpa);
    try stroke(gpa, src, style, 0.01, &out);
    var r = try path_mod.Rasterizer.init(gpa, 64, 64);
    defer r.deinit(gpa);
    r.fill(&out, .identity);
    var cov: [64 * 64]u8 = undefined;
    r.coverage(&cov, .nonzero);
    var total: f32 = 0;
    for (cov) |v| total += @as(f32, @floatFromInt(v)) / 255;
    return total;
}

fn hline(gpa: Allocator) !Path {
    var p: Path = .{};
    try p.moveTo(gpa, 20, 32);
    try p.lineTo(gpa, 30, 32);
    return p;
}

test "caps: butt, square, round" {
    const gpa = std.testing.allocator;
    var p = try hline(gpa);
    defer p.deinit(gpa);
    try std.testing.expectApproxEqAbs(@as(f32, 20), try strokedArea(gpa, &p, .{ .width = 2 }), 0.05);
    try std.testing.expectApproxEqAbs(@as(f32, 24), try strokedArea(gpa, &p, .{ .width = 2, .cap = .square }), 0.05);
    try std.testing.expectApproxEqAbs(@as(f32, 20 + std.math.pi), try strokedArea(gpa, &p, .{ .width = 2, .cap = .round }), 0.1);
}

test "closed rectangle: miter, bevel and round joins" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, 16, 16);
    try p.lineTo(gpa, 48, 16);
    try p.lineTo(gpa, 48, 48);
    try p.lineTo(gpa, 16, 48);
    try p.close(gpa);
    // width 4: band between a 36x36 and a 28x28 square
    const band: f32 = 36 * 36 - 28 * 28;
    try std.testing.expectApproxEqAbs(band, try strokedArea(gpa, &p, .{ .width = 4, .join = .miter }), 0.2);
    // bevel cuts each outer corner by a 2x2 right triangle
    try std.testing.expectApproxEqAbs(band - 4 * 2, try strokedArea(gpa, &p, .{ .width = 4, .join = .bevel }), 0.2);
    // round: each outer corner is a quarter circle of radius 2 instead of a 2x2 square
    try std.testing.expectApproxEqAbs(band - 4 * (4 - std.math.pi), try strokedArea(gpa, &p, .{ .width = 4, .join = .round }), 0.3);
}

test "miter limit falls back to bevel" {
    const gpa = std.testing.allocator;
    // a ~22° spike: miter ratio 1/sin(11°) ≈ 5.2, over a limit of 4
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, 20, 50);
    try p.lineTo(gpa, 30, 20);
    try p.lineTo(gpa, 32, 50);
    const limited = try strokedArea(gpa, &p, .{ .width = 2, .join = .miter, .miter_limit = 4 });
    const bevel = try strokedArea(gpa, &p, .{ .width = 2, .join = .bevel });
    const long = try strokedArea(gpa, &p, .{ .width = 2, .join = .miter, .miter_limit = 100 });
    try std.testing.expectApproxEqAbs(bevel, limited, 0.01);
    try std.testing.expect(long > bevel + 1);
}

test "zero-length subpaths draw cap dots; lone moveto draws nothing" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, 32, 32);
    try p.lineTo(gpa, 32, 32);
    try std.testing.expectApproxEqAbs(std.math.pi * 9, try strokedArea(gpa, &p, .{ .width = 6, .cap = .round }), 0.2);
    try std.testing.expectApproxEqAbs(@as(f32, 36), try strokedArea(gpa, &p, .{ .width = 6, .cap = .square }), 0.05);
    try std.testing.expectApproxEqAbs(@as(f32, 0), try strokedArea(gpa, &p, .{ .width = 6 }), 0.001);
    var m: Path = .{};
    defer m.deinit(gpa);
    try m.moveTo(gpa, 10, 10);
    try m.moveTo(gpa, 20, 20);
    try std.testing.expectApproxEqAbs(@as(f32, 0), try strokedArea(gpa, &m, .{ .width = 6, .cap = .round }), 0.001);
}

test "open curve stroke has length times width" {
    const gpa = std.testing.allocator;
    // a semicircle of radius 16 stroked width 2: area ≈ pi*16*2
    var p: Path = .{};
    defer p.deinit(gpa);
    const k: f32 = 0.5522847 * 16;
    try p.moveTo(gpa, 16, 32);
    try p.cubicTo(gpa, 16, 32 - k, 32 - k, 16, 32, 16);
    try p.cubicTo(gpa, 32 + k, 16, 48, 32 - k, 48, 32);
    try std.testing.expectApproxEqRel(@as(f32, std.math.pi * 16 * 2), try strokedArea(gpa, &p, .{ .width = 2 }), 0.01);
}

test "reversals, duplicates and degenerate input don't crash" {
    const gpa = std.testing.allocator;
    var p: Path = .{};
    defer p.deinit(gpa);
    try p.moveTo(gpa, 10, 10);
    try p.lineTo(gpa, 30, 10);
    try p.lineTo(gpa, 10, 10); // 180° turn
    try p.lineTo(gpa, 10, 10); // duplicate
    try p.close(gpa);
    try p.lineTo(gpa, std.math.nan(f32), 5);
    try p.moveTo(gpa, 1e30, -1e30);
    try p.cubicTo(gpa, std.math.inf(f32), 0, 0, 0, 1, 1);
    for ([_]Join{ .miter, .round, .bevel }) |j| for ([_]Cap{ .butt, .round, .square }) |c| {
        _ = try strokedArea(gpa, &p, .{ .width = 3, .join = j, .cap = c });
    };
    _ = try strokedArea(gpa, &p, .{ .width = std.math.nan(f32) });
    _ = try strokedArea(gpa, &p, .{ .width = -1 });
}
