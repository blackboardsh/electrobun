//! Pure-Zig SVG rasterization on the shared path rasterizer: the same
//! contract as the CoreGraphics backend (premultiplied RGBA8, viewBox mapped
//! to the bitmap with preserveAspectRatio meet/none, shape transforms,
//! fill-rule, strokes with caps/joins, painter's order, source-over).
const std = @import("std");
const svg = @import("../svg.zig");
const raster = @import("../raster/path.zig");
const stroke_mod = @import("../raster/stroke.zig");

const Allocator = std.mem.Allocator;

/// Device-space flattening tolerance (px).
const tolerance: f32 = 0.05;

pub fn rasterizeSvg(gpa: Allocator, pic: *const svg.Picture, w: u32, h: u32) ?[]u8 {
    if (w == 0 or h == 0) return null;
    const px = gpa.alloc(u8, @as(usize, w) * h * 4) catch return null;
    @memset(px, 0);
    var r = raster.Rasterizer.init(gpa, w, h) catch {
        gpa.free(px);
        return null;
    };
    defer r.deinit(gpa);
    const cov = gpa.alloc(u8, @as(usize, w) * h) catch {
        gpa.free(px);
        return null;
    };
    defer gpa.free(cov);

    const view = viewTransform(pic, w, h);
    var path: raster.Path = .{};
    defer path.deinit(gpa);
    var outline: raster.Path = .{};
    defer outline.deinit(gpa);

    for (pic.shapes) |shape| {
        const st = shape.transform;
        const t = (raster.Affine{ .a = st.a, .b = st.b, .c = st.c, .d = st.d, .e = st.e, .f = st.f }).then(view);
        path.clear();
        buildPath(gpa, &path, shape.segs) catch continue;
        if (shape.fill) |f| if (f.a > 0) {
            r.reset();
            r.fill(&path, t);
            r.coverage(cov, if (shape.even_odd) .even_odd else .nonzero);
            composite(px, cov, f.toF32());
        };
        if (shape.stroke) |sc| if (sc.a > 0 and shape.stroke_width > 0) {
            outline.clear();
            const scale = t.maxScale();
            const user_tol = if (scale > 0 and std.math.isFinite(scale)) tolerance / scale else tolerance;
            stroke_mod.stroke(gpa, &path, .{
                .width = shape.stroke_width,
                .cap = switch (shape.cap) {
                    .butt => .butt,
                    .round => .round,
                    .square => .square,
                },
                .join = switch (shape.join) {
                    .miter => .miter,
                    .round => .round,
                    .bevel => .bevel,
                },
            }, user_tol, &outline) catch continue;
            r.reset();
            r.fill(&outline, t);
            r.coverage(cov, .nonzero);
            composite(px, cov, sc.toF32());
        };
    }
    return px;
}

/// viewBox → bitmap, top-left origin (matches the CoreGraphics backend).
fn viewTransform(pic: *const svg.Picture, w: u32, h: u32) raster.Affine {
    const vb = pic.view_box;
    const wf: f32 = @floatFromInt(w);
    const hf: f32 = @floatFromInt(h);
    var sx = wf / @max(0.0001, vb[2]);
    var sy = hf / @max(0.0001, vb[3]);
    var ox: f32 = 0;
    var oy: f32 = 0;
    if (pic.preserve_aspect) {
        const s = @min(sx, sy);
        ox = (wf - vb[2] * s) / 2;
        oy = (hf - vb[3] * s) / 2;
        sx = s;
        sy = s;
    }
    return raster.Affine.translate(-vb[0], -vb[1]).then(raster.Affine.scale(sx, sy)).then(raster.Affine.translate(ox, oy));
}

fn buildPath(gpa: Allocator, p: *raster.Path, segs: []const svg.Seg) !void {
    var open = false;
    for (segs) |s| switch (s) {
        .move => |m| {
            try p.moveTo(gpa, m[0], m[1]);
            open = true;
        },
        .line => |l| if (open) try p.lineTo(gpa, l[0], l[1]),
        .cubic => |c| if (open) try p.cubicTo(gpa, c[0], c[1], c[2], c[3], c[4], c[5]),
        .close => if (open) try p.close(gpa),
    };
}

/// Source-over a solid color (straight RGBA floats) through `cov` into
/// premultiplied RGBA8.
fn composite(px: []u8, cov: []const u8, c: [4]f32) void {
    for (cov, 0..) |cv, i| {
        if (cv == 0) continue;
        const a = c[3] * @as(f32, @floatFromInt(cv)) / 255;
        const inv = 1 - a;
        const o = px[i * 4 ..][0..4];
        inline for (0..3) |k| {
            const v = c[k] * a * 255 + @as(f32, @floatFromInt(o[k])) * inv;
            o[k] = @intFromFloat(@round(std.math.clamp(v, 0, 255)));
        }
        const va = a * 255 + @as(f32, @floatFromInt(o[3])) * inv;
        o[3] = @intFromFloat(@round(std.math.clamp(va, 0, 255)));
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const builtin = @import("builtin");
const dom = @import("../dom.zig");
const html = @import("../html.zig");
const style_mod = @import("../style.zig");
const geom = @import("../geom.zig");

const icons = [_][]const u8{
    // Lucide-style: strokes with round caps/joins, no fill
    \\<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    ,
    \\<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    ,
    // Heroicons-style solid with an even-odd hole
    \\<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6z"/></svg>
    ,
    // transforms, opacity, rounded rect, ellipse, polygon
    \\<svg viewBox="0 0 32 32"><g transform="translate(16 16) rotate(30) scale(1.2 0.8)"><rect x="-10" y="-6" width="20" height="12" rx="3" fill="#3b82f6" opacity="0.7"/><ellipse cx="0" cy="0" rx="6" ry="3" fill="#f59e0b"/></g><polygon points="2,30 8,20 14,30" fill="#10b981" stroke="#065f46" stroke-width="1.5" stroke-linejoin="miter"/></svg>
    ,
    // miter joins and square caps on a non-square viewBox
    \\<svg viewBox="0 0 40 20" fill="none" stroke="#111" stroke-width="3" stroke-linejoin="miter" stroke-linecap="square"><polyline points="4,16 12,4 20,16 28,4 36,16"/></svg>
    ,
    // arcs and many curves
    \\<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><circle cx="12" cy="12" r="3"/></svg>
    ,
};

fn pictureFrom(gpa: Allocator, src: []const u8) !struct { doc: *dom.Document, pic: *svg.Picture } {
    const doc = try dom.Document.init(gpa);
    errdefer doc.deinit();
    try html.parseInto(doc, doc.root, src, .{});
    const node = try style_mod.querySelector(doc, doc.root, "svg");
    const pic = try svg.fromDom(gpa, doc, node, geom.Color.rgb(20, 20, 30));
    return .{ .doc = doc, .pic = pic };
}

fn freePicture(gpa: Allocator, p: anytype) void {
    p.pic.deinit();
    gpa.destroy(p.pic);
    p.doc.deinit(); // frees the document too
}

test "portable SVG renders shapes, strokes and transparency" {
    const gpa = std.testing.allocator;
    for (icons) |src| {
        const p = try pictureFrom(gpa, src);
        defer freePicture(gpa, p);
        const px = rasterizeSvg(gpa, p.pic, 48, 48) orelse return error.RenderFailed;
        defer gpa.free(px);
        var opaque_px: usize = 0;
        var transparent_px: usize = 0;
        var i: usize = 0;
        while (i < px.len) : (i += 4) {
            // premultiplied: color channels never exceed alpha
            try std.testing.expect(px[i] <= px[i + 3] and px[i + 1] <= px[i + 3] and px[i + 2] <= px[i + 3]);
            if (px[i + 3] > 200) opaque_px += 1;
            if (px[i + 3] == 0) transparent_px += 1;
        }
        try std.testing.expect(opaque_px > 20);
        try std.testing.expect(transparent_px > 200);
    }
}

test "portable SVG matches CoreGraphics" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    const gpa = std.testing.allocator;
    const cg = @import("image_mac.zig");
    var worst_mean: f32 = 0;
    var worst_max: u8 = 0;
    for (icons) |src| {
        const p = try pictureFrom(gpa, src);
        defer freePicture(gpa, p);
        for ([_][2]u32{ .{ 24, 24 }, .{ 96, 64 } }) |size| {
            const a = rasterizeSvg(gpa, p.pic, size[0], size[1]) orelse return error.RenderFailed;
            defer gpa.free(a);
            const b = cg.rasterizeSvg(gpa, p.pic, size[0], size[1]) orelse return error.RenderFailed;
            defer gpa.free(b);
            var sum: u64 = 0;
            var max: u8 = 0;
            for (a, b) |x, y| {
                const d: u8 = if (x > y) x - y else y - x;
                sum += d;
                max = @max(max, d);
            }
            const mean = @as(f32, @floatFromInt(sum)) / @as(f32, @floatFromInt(a.len));
            worst_mean = @max(worst_mean, mean);
            worst_max = @max(worst_max, max);
            // measured: worst mean 0.24, worst max 67 (a pixel on the gear's
            // arcs whose radius is below half the stroke width); typical max
            // is under 10 of 255
            try std.testing.expect(mean < 0.5);
            try std.testing.expect(max < 80);
        }
    }
    @import("testdata").log("svg portable vs CoreGraphics: worst mean abs diff {d:.3}, worst max {d}\n", .{ worst_mean, worst_max });
}

test "portable SVG survives degenerate pictures" {
    const gpa = std.testing.allocator;
    const nasty = [_][]const u8{
        \\<svg viewBox="0 0 0 0"><path d="M0 0L10 10" stroke="red"/></svg>
        ,
        \\<svg viewBox="0 0 24 24"><path d="M1e30 1e30L-1e30 5 C 1e38 1e38 -1e38 1 3 3Z" fill="red" stroke="blue" stroke-width="1e9"/></svg>
        ,
        \\<svg viewBox="0 0 24 24"><g transform="scale(0)"><circle cx="12" cy="12" r="10" stroke="red" stroke-width="3"/></g><path d="" stroke="red"/><path d="M5 5" stroke="red" stroke-linecap="round"/></svg>
        ,
        \\<svg viewBox="0 0 24 24"><g transform="matrix(1e20 0 0 1e-20 5 5)"><rect width="10" height="10" fill="red" stroke="red"/></g></svg>
        ,
    };
    for (nasty) |src| {
        const p = try pictureFrom(gpa, src);
        defer freePicture(gpa, p);
        if (rasterizeSvg(gpa, p.pic, 32, 32)) |px| gpa.free(px);
    }
}
