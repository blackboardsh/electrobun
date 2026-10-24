//! Shape math shared by the CPU renderer and mirrored by the WGSL shaders.
const std = @import("std");
const geom = @import("../geom.zig");
const style_mod = @import("../style.zig");

const Rect = geom.Rect;
const Corners = geom.Corners;

/// Signed distance to a rounded rectangle (negative inside).
pub fn roundedRect(x: f32, y: f32, r: Rect, radii: Corners) f32 {
    const hw = r.w / 2;
    const hh = r.h / 2;
    const px = x - (r.x + hw);
    const py = y - (r.y + hh);
    const rad = if (px < 0) (if (py < 0) radii.tl else radii.bl) else (if (py < 0) radii.tr else radii.br);
    const qx = @abs(px) - hw + rad;
    const qy = @abs(py) - hh + rad;
    const ox = @max(qx, 0);
    const oy = @max(qy, 0);
    return @sqrt(ox * ox + oy * oy) + @min(@max(qx, qy), 0) - rad;
}

pub fn innerRadii(r: Corners, w: geom.Edges) Corners {
    return .{
        .tl = @max(0, r.tl - @max(w.left, w.top)),
        .tr = @max(0, r.tr - @max(w.right, w.top)),
        .br = @max(0, r.br - @max(w.right, w.bottom)),
        .bl = @max(0, r.bl - @max(w.left, w.bottom)),
    };
}

/// Which border side (0 top, 1 right, 2 bottom, 3 left) owns a point.
pub fn borderSide(x: f32, y: f32, r: Rect, w: geom.Edges) usize {
    const dt = (y - r.y) / @max(w.top, 0.001);
    const db = (r.bottom() - y) / @max(w.bottom, 0.001);
    const dl = (x - r.x) / @max(w.left, 0.001);
    const dr = (r.right() - x) / @max(w.right, 0.001);
    var best: usize = 0;
    var bd = if (w.top > 0) dt else std.math.inf(f32);
    if (w.right > 0 and dr < bd) {
        bd = dr;
        best = 1;
    }
    if (w.bottom > 0 and db < bd) {
        bd = db;
        best = 2;
    }
    if (w.left > 0 and dl < bd) {
        best = 3;
    }
    return best;
}

pub fn dashMask(x: f32, y: f32, r: Rect, side: usize, width: f32, dotted: bool) f32 {
    const pos = if (side == 0 or side == 2) x - r.x else y - r.y;
    const w = @max(width, 1);
    if (dotted) {
        const period = 2 * w;
        const m = @mod(pos, period);
        // round dots
        const across = if (side == 0) y - r.y else if (side == 2) r.bottom() - y else if (side == 1) r.right() - x else x - r.x;
        const dx = m - w / 2;
        const dy = across - w / 2;
        const d = @sqrt(dx * dx + dy * dy) - w / 2;
        return std.math.clamp(0.5 - d, 0, 1);
    }
    const period = 6 * w;
    const m = @mod(pos, period);
    return if (m < 3 * w) 1 else 0;
}

fn erf(x: f32) f32 {
    // Abramowitz-Stegun 7.1.26
    const s: f32 = if (x < 0) -1 else 1;
    const ax = @abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * @exp(-ax * ax);
    return s * y;
}

/// Coverage of a gaussian-blurred rounded rect (erf of the signed distance).
pub fn shadowAlpha(x: f32, y: f32, shape: Rect, radii: Corners, sigma: f32) f32 {
    const d = roundedRect(x, y, shape, radii);
    if (sigma < 0.01) return std.math.clamp(0.5 - d, 0, 1);
    return 0.5 * (1 - erf(d / (std.math.sqrt2 * sigma)));
}

pub const GradientGeom = struct {
    cx: f32,
    cy: f32,
    dx: f32,
    dy: f32,
    len: f32,
    rx: f32,
    ry: f32,
};

pub fn gradientGeom(g: style_mod.Gradient, r: Rect) GradientGeom {
    const cx = r.x + g.cx.resolve(r.w);
    const cy = r.y + g.cy.resolve(r.h);
    switch (g.kind) {
        .linear => {
            var dx: f32 = undefined;
            var dy: f32 = undefined;
            if (g.to_corner) |tc| {
                dx = @as(f32, @floatFromInt(tc.x)) * r.h;
                dy = @as(f32, @floatFromInt(tc.y)) * r.w;
                const n = @sqrt(dx * dx + dy * dy);
                dx /= n;
                dy /= n;
            } else {
                dx = @sin(g.angle);
                dy = -@cos(g.angle);
            }
            const len = @abs(r.w * dx) + @abs(r.h * dy);
            return .{ .cx = r.x + r.w / 2, .cy = r.y + r.h / 2, .dx = dx, .dy = dy, .len = @max(len, 0.0001), .rx = 0, .ry = 0 };
        },
        .radial => {
            const fx = @max(cx - r.x, r.right() - cx);
            const fy = @max(cy - r.y, r.bottom() - cy);
            var rx: f32 = undefined;
            var ry: f32 = undefined;
            if (g.circle) {
                rx = @sqrt(fx * fx + fy * fy);
                ry = rx;
            } else {
                rx = fx * std.math.sqrt2;
                ry = fy * std.math.sqrt2;
            }
            return .{ .cx = cx, .cy = cy, .dx = 0, .dy = 0, .len = @max(rx, 0.0001), .rx = @max(rx, 0.0001), .ry = @max(ry, 0.0001) };
        },
        .conic => return .{ .cx = cx, .cy = cy, .dx = 0, .dy = 0, .len = 1, .rx = 1, .ry = 1 },
    }
}

/// Position along the gradient line in [0, 1] (before stop mapping).
pub fn gradientT(g: style_mod.Gradient, r: Rect, x: f32, y: f32) f32 {
    const gg = gradientGeom(g, r);
    var t: f32 = switch (g.kind) {
        .linear => ((x - gg.cx) * gg.dx + (y - gg.cy) * gg.dy) / gg.len + 0.5,
        .radial => blk: {
            const ux = (x - gg.cx) / gg.rx;
            const uy = (y - gg.cy) / gg.ry;
            break :blk @sqrt(ux * ux + uy * uy);
        },
        .conic => blk: {
            var a = std.math.atan2(x - gg.cx, -(y - gg.cy)) - g.angle;
            a = @mod(a, 2 * std.math.pi);
            break :blk a / (2 * std.math.pi);
        },
    };
    if (g.repeating) {
        const range = stopRange(g, r);
        const span = range[1] - range[0];
        if (span > 0.0001) t = range[0] + @mod(t - range[0], span);
    }
    return std.math.clamp(t, 0, 1);
}

fn stopRange(g: style_mod.Gradient, r: Rect) [2]f32 {
    var pos: [64]f32 = undefined;
    const n = resolveStops(g, r, &pos);
    if (n == 0) return .{ 0, 1 };
    return .{ pos[0], pos[n - 1] };
}

/// Resolve stop positions to [0,1] along the gradient line (CSS fixup rules).
pub fn resolveStops(g: style_mod.Gradient, r: Rect, out: []f32) usize {
    const gg = gradientGeom(g, r);
    const n = @min(g.stops.len, out.len);
    if (n == 0) return 0;
    const len = if (g.kind == .linear) gg.len else gg.rx;
    var have: [64]bool = @splat(false);
    for (g.stops[0..n], 0..) |s, i| {
        if (s.pos) |p| {
            out[i] = if (g.kind == .conic) p.pct + p.px / 360 else (p.px / len + p.pct);
            have[i] = true;
        }
    }
    if (!have[0]) {
        out[0] = 0;
        have[0] = true;
    }
    if (!have[n - 1]) {
        out[n - 1] = @max(1, out[0]);
        have[n - 1] = true;
    }
    // monotonic
    var mx = out[0];
    for (1..n) |i| if (have[i]) {
        if (out[i] < mx) out[i] = mx;
        mx = out[i];
    };
    // fill gaps evenly
    var i: usize = 1;
    while (i < n) : (i += 1) {
        if (have[i]) continue;
        var j = i;
        while (!have[j]) j += 1;
        const a = out[i - 1];
        const b = out[j];
        const steps: f32 = @floatFromInt(j - i + 1);
        for (i..j) |k| out[k] = a + (b - a) * @as(f32, @floatFromInt(k - i + 1)) / steps;
        i = j;
    }
    return n;
}

pub fn gradientLut(g: style_mod.Gradient, r: Rect, lut: *[256][4]f32) void {
    var pos: [64]f32 = undefined;
    const n = resolveStops(g, r, &pos);
    var cols: [64][4]f32 = undefined;
    for (g.stops[0..n], 0..) |s, i| {
        const a = @as(f32, @floatFromInt(s.color.a)) / 255;
        cols[i] = .{ @as(f32, @floatFromInt(s.color.r)) / 255 * a, @as(f32, @floatFromInt(s.color.g)) / 255 * a, @as(f32, @floatFromInt(s.color.b)) / 255 * a, a };
    }
    for (0..256) |k| {
        const t = @as(f32, @floatFromInt(k)) / 255;
        var c = cols[0];
        if (n > 0) {
            if (t <= pos[0]) {
                c = cols[0];
            } else if (t >= pos[n - 1]) {
                c = cols[n - 1];
            } else {
                var i: usize = 0;
                while (i + 1 < n and pos[i + 1] < t) i += 1;
                const span = pos[i + 1] - pos[i];
                const f = if (span <= 0) 1 else (t - pos[i]) / span;
                for (0..4) |ch| c[ch] = cols[i][ch] + (cols[i + 1][ch] - cols[i][ch]) * f;
            }
        }
        lut[k] = c;
    }
}

pub fn applyColorFilter(f: style_mod.Filter, c: [3]f32) [3]f32 {
    var out = c;
    switch (f) {
        .grayscale => |amt| {
            const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            for (0..3) |k| out[k] = c[k] + (l - c[k]) * amt;
        },
        .sepia => |amt| {
            const sr = 0.393 * c[0] + 0.769 * c[1] + 0.189 * c[2];
            const sg = 0.349 * c[0] + 0.686 * c[1] + 0.168 * c[2];
            const sb = 0.272 * c[0] + 0.534 * c[1] + 0.131 * c[2];
            out = .{ c[0] + (sr - c[0]) * amt, c[1] + (sg - c[1]) * amt, c[2] + (sb - c[2]) * amt };
        },
        .saturate => |amt| {
            const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            for (0..3) |k| out[k] = l + (c[k] - l) * amt;
        },
        .brightness => |amt| for (0..3) |k| {
            out[k] = c[k] * amt;
        },
        .contrast => |amt| for (0..3) |k| {
            out[k] = (c[k] - 0.5) * amt + 0.5;
        },
        .invert => |amt| for (0..3) |k| {
            out[k] = c[k] + (1 - 2 * c[k]) * amt;
        },
        .hue_rotate => |a| {
            const cosv = @cos(a);
            const sinv = @sin(a);
            const m = [9]f32{
                0.213 + cosv * 0.787 - sinv * 0.213, 0.715 - cosv * 0.715 - sinv * 0.715, 0.072 - cosv * 0.072 + sinv * 0.928,
                0.213 - cosv * 0.213 + sinv * 0.143, 0.715 + cosv * 0.285 + sinv * 0.140, 0.072 - cosv * 0.072 - sinv * 0.283,
                0.213 - cosv * 0.213 - sinv * 0.787, 0.715 - cosv * 0.715 + sinv * 0.715, 0.072 + cosv * 0.928 + sinv * 0.072,
            };
            out = .{ m[0] * c[0] + m[1] * c[1] + m[2] * c[2], m[3] * c[0] + m[4] * c[1] + m[5] * c[2], m[6] * c[0] + m[7] * c[1] + m[8] * c[2] };
        },
        else => {},
    }
    for (0..3) |k| out[k] = std.math.clamp(out[k], 0, 1);
    return out;
}

test "rounded rect sdf" {
    const r = Rect{ .x = 0, .y = 0, .w = 100, .h = 50 };
    try std.testing.expect(roundedRect(50, 25, r, Corners.all(10)) < 0);
    try std.testing.expectApproxEqAbs(@as(f32, 0), roundedRect(100, 25, r, Corners.all(10)), 0.001);
    // corner is cut
    try std.testing.expect(roundedRect(1, 1, r, Corners.all(10)) > 0);
}

