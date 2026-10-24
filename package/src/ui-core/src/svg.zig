//! Inline SVG: converts an <svg> subtree into a flat list of filled/stroked
//! paths (path data, basic shapes, groups, transforms, presentation
//! attributes). Rasterization is done by the platform backend.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const values = @import("css/values.zig");
const tok = @import("css/tokenizer.zig");

const Allocator = std.mem.Allocator;
const Color = geom.Color;

pub const Seg = union(enum) {
    move: [2]f32,
    line: [2]f32,
    cubic: [6]f32,
    close,
};

pub const LineCap = enum { butt, round, square };
pub const LineJoin = enum { miter, round, bevel };

pub const Shape = struct {
    segs: []const Seg,
    fill: ?Color,
    stroke: ?Color,
    stroke_width: f32,
    cap: LineCap,
    join: LineJoin,
    even_odd: bool,
    transform: geom.Transform,
};

pub const Picture = struct {
    arena: std.heap.ArenaAllocator,
    shapes: []const Shape = &.{},
    view_box: [4]f32 = .{ 0, 0, 24, 24 },
    preserve_aspect: bool = true,

    pub fn deinit(p: *Picture) void {
        p.arena.deinit();
    }
};

const Paint = struct {
    fill: ?Color = Color.black,
    stroke: ?Color = null,
    stroke_width: f32 = 1,
    cap: LineCap = .butt,
    join: LineJoin = .miter,
    opacity: f32 = 1,
    fill_opacity: f32 = 1,
    stroke_opacity: f32 = 1,
    even_odd: bool = false,
};

/// Build a picture from an <svg> element; `current_color` resolves currentColor.
pub fn fromDom(gpa: Allocator, doc: *const dom.Document, svg: dom.NodeId, current_color: Color) !*Picture {
    const pic = try gpa.create(Picture);
    pic.* = .{ .arena = std.heap.ArenaAllocator.init(gpa) };
    errdefer {
        pic.deinit();
        gpa.destroy(pic);
    }
    const a = pic.arena.allocator();
    var shapes: std.ArrayList(Shape) = .empty;
    const n = doc.node(svg);
    if (attr(doc, n, "viewbox")) |vb| {
        var nums: [4]f32 = undefined;
        if (parseNumbers(vb, &nums) == 4) pic.view_box = nums;
    } else {
        const w = std.fmt.parseFloat(f32, std.mem.trim(u8, attr(doc, n, "width") orelse "24", " px")) catch 24;
        const h = std.fmt.parseFloat(f32, std.mem.trim(u8, attr(doc, n, "height") orelse "24", " px")) catch 24;
        pic.view_box = .{ 0, 0, w, h };
    }
    if (attr(doc, n, "preserveaspectratio")) |par| pic.preserve_aspect = !std.mem.eql(u8, std.mem.trim(u8, par, " "), "none");
    var paint = Paint{};
    applyPaint(doc, n, &paint, current_color);
    try walk(a, doc, svg, paint, geom.Transform.identity, current_color, &shapes);
    pic.shapes = shapes.items;
    return pic;
}

fn attr(doc: *const dom.Document, n: *const dom.Node, name: []const u8) ?[]const u8 {
    const a = doc.interner.lookup(name) orelse return null;
    return n.getAttr(a);
}

fn parseColorStr(s: []const u8, current: Color) ?Color {
    const t = std.mem.trim(u8, s, " ");
    if (std.mem.eql(u8, t, "none") or std.mem.eql(u8, t, "transparent")) return null;
    if (std.ascii.eqlIgnoreCase(t, "currentcolor")) return current;
    var buf: [32]tok.Token = undefined;
    var t2 = tok.Tokenizer.init(t);
    var n: usize = 0;
    while (n < buf.len) {
        const x = t2.next();
        buf[n] = x;
        n += 1;
        if (x.tag == .eof) break;
    }
    var stream = values.Stream.init(buf[0..n]);
    const cv = values.parseColor(&stream) orelse return current;
    return switch (cv) {
        .rgba => |c| c,
        .current_color => current,
    };
}

fn applyPaint(doc: *const dom.Document, n: *const dom.Node, p: *Paint, current: Color) void {
    // presentation attributes and the style attribute (simple declarations)
    const names = [_][]const u8{ "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "color" };
    var cur = current;
    for (names) |name| {
        const v = attr(doc, n, name) orelse styleValue(doc, n, name) orelse continue;
        applyOne(p, name, v, &cur);
    }
}

fn styleValue(doc: *const dom.Document, n: *const dom.Node, name: []const u8) ?[]const u8 {
    const st = n.getAttr(doc.atoms.style) orelse return null;
    var it = std.mem.splitScalar(u8, st, ';');
    while (it.next()) |decl| {
        const i = std.mem.indexOfScalar(u8, decl, ':') orelse continue;
        if (std.mem.eql(u8, std.mem.trim(u8, decl[0..i], " "), name)) return std.mem.trim(u8, decl[i + 1 ..], " ");
    }
    return null;
}

fn applyOne(p: *Paint, name: []const u8, v: []const u8, cur: *Color) void {
    if (std.mem.eql(u8, name, "color")) {
        if (parseColorStr(v, cur.*)) |c| cur.* = c;
    } else if (std.mem.eql(u8, name, "fill")) {
        p.fill = parseColorStr(v, cur.*);
    } else if (std.mem.eql(u8, name, "stroke")) {
        p.stroke = parseColorStr(v, cur.*);
    } else if (std.mem.eql(u8, name, "stroke-width")) {
        p.stroke_width = std.fmt.parseFloat(f32, std.mem.trim(u8, v, " px")) catch p.stroke_width;
    } else if (std.mem.eql(u8, name, "stroke-linecap")) {
        p.cap = std.meta.stringToEnum(LineCap, std.mem.trim(u8, v, " ")) orelse p.cap;
    } else if (std.mem.eql(u8, name, "stroke-linejoin")) {
        p.join = std.meta.stringToEnum(LineJoin, std.mem.trim(u8, v, " ")) orelse p.join;
    } else if (std.mem.eql(u8, name, "opacity")) {
        p.opacity *= std.fmt.parseFloat(f32, std.mem.trim(u8, v, " ")) catch 1;
    } else if (std.mem.eql(u8, name, "fill-opacity")) {
        p.fill_opacity = std.fmt.parseFloat(f32, std.mem.trim(u8, v, " ")) catch 1;
    } else if (std.mem.eql(u8, name, "stroke-opacity")) {
        p.stroke_opacity = std.fmt.parseFloat(f32, std.mem.trim(u8, v, " ")) catch 1;
    } else if (std.mem.eql(u8, name, "fill-rule")) {
        p.even_odd = std.mem.eql(u8, std.mem.trim(u8, v, " "), "evenodd");
    }
}

fn walk(a: Allocator, doc: *const dom.Document, id: dom.NodeId, inherited: Paint, xf: geom.Transform, current: Color, out: *std.ArrayList(Shape)) !void {
    var c = doc.node(id).first_child;
    while (c != dom.null_id) : (c = doc.node(c).next) {
        const n = doc.node(c);
        if (n.kind != .element) continue;
        const tag = doc.interner.str(n.tag);
        if (std.mem.eql(u8, tag, "defs") or std.mem.eql(u8, tag, "title") or std.mem.eql(u8, tag, "desc") or std.mem.eql(u8, tag, "clippath") or std.mem.eql(u8, tag, "mask")) continue;
        var paint = inherited;
        applyPaint(doc, n, &paint, current);
        var t = xf;
        if (attr(doc, n, "transform")) |tr| t = parseTransform(tr).then(xf);
        if (std.mem.eql(u8, tag, "g") or std.mem.eql(u8, tag, "a") or std.mem.eql(u8, tag, "svg")) {
            try walk(a, doc, c, paint, t, current, out);
            continue;
        }
        var segs: std.ArrayList(Seg) = .empty;
        const num = struct {
            fn f(d: *const dom.Document, nn: *const dom.Node, name: []const u8) f32 {
                const v = attr(d, nn, name) orelse return 0;
                return std.fmt.parseFloat(f32, std.mem.trim(u8, v, " px")) catch 0;
            }
        }.f;
        if (std.mem.eql(u8, tag, "path")) {
            try parsePath(a, attr(doc, n, "d") orelse "", &segs);
        } else if (std.mem.eql(u8, tag, "rect")) {
            const x = num(doc, n, "x");
            const y = num(doc, n, "y");
            const w = num(doc, n, "width");
            const h = num(doc, n, "height");
            var rx = num(doc, n, "rx");
            var ry = num(doc, n, "ry");
            if (attr(doc, n, "ry") == null) ry = rx;
            if (attr(doc, n, "rx") == null) rx = ry;
            rx = @min(rx, w / 2);
            ry = @min(ry, h / 2);
            if (rx > 0 or ry > 0) {
                try roundedRect(a, &segs, x, y, w, h, rx, ry);
            } else {
                try segs.appendSlice(a, &.{ .{ .move = .{ x, y } }, .{ .line = .{ x + w, y } }, .{ .line = .{ x + w, y + h } }, .{ .line = .{ x, y + h } }, .close });
            }
        } else if (std.mem.eql(u8, tag, "circle")) {
            const r = num(doc, n, "r");
            try ellipse(a, &segs, num(doc, n, "cx"), num(doc, n, "cy"), r, r);
        } else if (std.mem.eql(u8, tag, "ellipse")) {
            try ellipse(a, &segs, num(doc, n, "cx"), num(doc, n, "cy"), num(doc, n, "rx"), num(doc, n, "ry"));
        } else if (std.mem.eql(u8, tag, "line")) {
            try segs.appendSlice(a, &.{ .{ .move = .{ num(doc, n, "x1"), num(doc, n, "y1") } }, .{ .line = .{ num(doc, n, "x2"), num(doc, n, "y2") } } });
            paint.fill = null;
        } else if (std.mem.eql(u8, tag, "polyline") or std.mem.eql(u8, tag, "polygon")) {
            var pts: [512]f32 = undefined;
            const cnt = parseNumbers(attr(doc, n, "points") orelse "", &pts);
            var i: usize = 0;
            while (i + 1 < cnt) : (i += 2) {
                try segs.append(a, if (i == 0) .{ .move = .{ pts[0], pts[1] } } else .{ .line = .{ pts[i], pts[i + 1] } });
            }
            if (std.mem.eql(u8, tag, "polygon")) try segs.append(a, .close);
        } else continue;
        if (segs.items.len == 0) continue;
        try out.append(a, .{
            .segs = segs.items,
            .fill = if (paint.fill) |f| f.withAlpha(paint.opacity * paint.fill_opacity) else null,
            .stroke = if (paint.stroke) |s| s.withAlpha(paint.opacity * paint.stroke_opacity) else null,
            .stroke_width = paint.stroke_width,
            .cap = paint.cap,
            .join = paint.join,
            .even_odd = paint.even_odd,
            .transform = t,
        });
    }
}

fn roundedRect(a: Allocator, segs: *std.ArrayList(Seg), x: f32, y: f32, w: f32, h: f32, rx: f32, ry: f32) !void {
    const k: f32 = 0.5522847;
    try segs.appendSlice(a, &.{
        .{ .move = .{ x + rx, y } },
        .{ .line = .{ x + w - rx, y } },
        .{ .cubic = .{ x + w - rx + rx * k, y, x + w, y + ry - ry * k, x + w, y + ry } },
        .{ .line = .{ x + w, y + h - ry } },
        .{ .cubic = .{ x + w, y + h - ry + ry * k, x + w - rx + rx * k, y + h, x + w - rx, y + h } },
        .{ .line = .{ x + rx, y + h } },
        .{ .cubic = .{ x + rx - rx * k, y + h, x, y + h - ry + ry * k, x, y + h - ry } },
        .{ .line = .{ x, y + ry } },
        .{ .cubic = .{ x, y + ry - ry * k, x + rx - rx * k, y, x + rx, y } },
        .close,
    });
}

fn ellipse(a: Allocator, segs: *std.ArrayList(Seg), cx: f32, cy: f32, rx: f32, ry: f32) !void {
    if (rx <= 0 or ry <= 0) return;
    const k: f32 = 0.5522847;
    try segs.appendSlice(a, &.{
        .{ .move = .{ cx + rx, cy } },
        .{ .cubic = .{ cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry } },
        .{ .cubic = .{ cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy } },
        .{ .cubic = .{ cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry } },
        .{ .cubic = .{ cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy } },
        .close,
    });
}

fn parseNumbers(s: []const u8, out: []f32) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len and n < out.len) {
        while (i < s.len and (std.ascii.isWhitespace(s[i]) or s[i] == ',')) i += 1;
        if (i >= s.len) break;
        const start = i;
        if (s[i] == '-' or s[i] == '+') i += 1;
        var dot = false;
        while (i < s.len and (std.ascii.isDigit(s[i]) or (s[i] == '.' and !dot))) : (i += 1) {
            if (s[i] == '.') dot = true;
        }
        if (i < s.len and (s[i] == 'e' or s[i] == 'E')) {
            i += 1;
            if (i < s.len and (s[i] == '-' or s[i] == '+')) i += 1;
            while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
        }
        if (i == start) {
            i += 1;
            continue;
        }
        out[n] = std.fmt.parseFloat(f32, s[start..i]) catch 0;
        n += 1;
    }
    return n;
}

pub fn parseTransform(s: []const u8) geom.Transform {
    var t = geom.Transform.identity;
    var i: usize = 0;
    while (i < s.len) {
        while (i < s.len and (std.ascii.isWhitespace(s[i]) or s[i] == ',')) i += 1;
        const ns = i;
        while (i < s.len and std.ascii.isAlphabetic(s[i])) i += 1;
        const name = s[ns..i];
        while (i < s.len and s[i] != '(') i += 1;
        if (i >= s.len) break;
        const as = i + 1;
        while (i < s.len and s[i] != ')') i += 1;
        var a: [6]f32 = .{ 0, 0, 0, 0, 0, 0 };
        const n = parseNumbers(s[as..@min(i, s.len)], &a);
        i += 1;
        const m: geom.Transform = if (std.mem.eql(u8, name, "translate"))
            geom.Transform.translation(a[0], if (n > 1) a[1] else 0)
        else if (std.mem.eql(u8, name, "scale"))
            geom.Transform.scaling(a[0], if (n > 1) a[1] else a[0])
        else if (std.mem.eql(u8, name, "rotate")) blk: {
            const r = geom.Transform.rotation(a[0] * std.math.pi / 180);
            if (n >= 3) break :blk geom.Transform.translation(-a[1], -a[2]).then(r).then(geom.Transform.translation(a[1], a[2]));
            break :blk r;
        } else if (std.mem.eql(u8, name, "matrix"))
            .{ .a = a[0], .b = a[1], .c = a[2], .d = a[3], .e = a[4], .f = a[5] }
        else if (std.mem.eql(u8, name, "skewX"))
            .{ .c = @tan(a[0] * std.math.pi / 180) }
        else if (std.mem.eql(u8, name, "skewY"))
            .{ .b = @tan(a[0] * std.math.pi / 180) }
        else
            geom.Transform.identity;
        // transform lists apply right-to-left
        t = m.then(t);
    }
    return t;
}

/// SVG path data -> absolute segments (arcs and quadratics become cubics).
pub fn parsePath(a: Allocator, d: []const u8, out: *std.ArrayList(Seg)) !void {
    var i: usize = 0;
    var cmd: u8 = 0;
    var cx: f32 = 0;
    var cy: f32 = 0;
    var sx: f32 = 0;
    var sy: f32 = 0;
    var last_ctrl: ?[2]f32 = null;
    var last_quad: ?[2]f32 = null;
    while (i < d.len) {
        while (i < d.len and (std.ascii.isWhitespace(d[i]) or d[i] == ',')) i += 1;
        if (i >= d.len) break;
        if (std.ascii.isAlphabetic(d[i])) {
            cmd = d[i];
            i += 1;
            if (cmd == 'Z' or cmd == 'z') {
                try out.append(a, .close);
                cx = sx;
                cy = sy;
                last_ctrl = null;
                last_quad = null;
                continue;
            }
        }
        if (cmd == 0) break;
        const rel = std.ascii.isLower(cmd);
        const ox: f32 = if (rel) cx else 0;
        const oy: f32 = if (rel) cy else 0;
        const need: usize = switch (std.ascii.toUpper(cmd)) {
            'M', 'L', 'T' => 2,
            'H', 'V' => 1,
            'C' => 6,
            'S', 'Q' => 4,
            'A' => 7,
            else => 0,
        };
        if (need == 0) break;
        var v: [7]f32 = undefined;
        var got: usize = 0;
        while (got < need) : (got += 1) {
            while (i < d.len and (std.ascii.isWhitespace(d[i]) or d[i] == ',')) i += 1;
            if (i >= d.len) break;
            // arc flags may be written without separators ("a1 1 0 01 1 1")
            if (std.ascii.toUpper(cmd) == 'A' and (got == 3 or got == 4) and (d[i] == '0' or d[i] == '1')) {
                v[got] = @floatFromInt(d[i] - '0');
                i += 1;
                continue;
            }
            const start = i;
            if (d[i] == '-' or d[i] == '+') i += 1;
            var dot = false;
            while (i < d.len and (std.ascii.isDigit(d[i]) or (d[i] == '.' and !dot))) : (i += 1) {
                if (d[i] == '.') dot = true;
            }
            if (i < d.len and (d[i] == 'e' or d[i] == 'E')) {
                i += 1;
                if (i < d.len and (d[i] == '-' or d[i] == '+')) i += 1;
                while (i < d.len and std.ascii.isDigit(d[i])) i += 1;
            }
            if (i == start) break;
            v[got] = std.fmt.parseFloat(f32, d[start..i]) catch 0;
        }
        if (got < need) break;
        switch (std.ascii.toUpper(cmd)) {
            'M' => {
                cx = ox + v[0];
                cy = oy + v[1];
                sx = cx;
                sy = cy;
                try out.append(a, .{ .move = .{ cx, cy } });
                // subsequent pairs are implicit linetos
                cmd = if (rel) 'l' else 'L';
                last_ctrl = null;
                last_quad = null;
            },
            'L' => {
                cx = ox + v[0];
                cy = oy + v[1];
                try out.append(a, .{ .line = .{ cx, cy } });
                last_ctrl = null;
                last_quad = null;
            },
            'H' => {
                cx = ox + v[0];
                try out.append(a, .{ .line = .{ cx, cy } });
                last_ctrl = null;
                last_quad = null;
            },
            'V' => {
                cy = oy + v[0];
                try out.append(a, .{ .line = .{ cx, cy } });
                last_ctrl = null;
                last_quad = null;
            },
            'C' => {
                try out.append(a, .{ .cubic = .{ ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5] } });
                last_ctrl = .{ ox + v[2], oy + v[3] };
                cx = ox + v[4];
                cy = oy + v[5];
                last_quad = null;
            },
            'S' => {
                const c1 = if (last_ctrl) |lc| [2]f32{ 2 * cx - lc[0], 2 * cy - lc[1] } else [2]f32{ cx, cy };
                try out.append(a, .{ .cubic = .{ c1[0], c1[1], ox + v[0], oy + v[1], ox + v[2], oy + v[3] } });
                last_ctrl = .{ ox + v[0], oy + v[1] };
                cx = ox + v[2];
                cy = oy + v[3];
                last_quad = null;
            },
            'Q', 'T' => {
                var q: [2]f32 = undefined;
                var e: [2]f32 = undefined;
                if (std.ascii.toUpper(cmd) == 'Q') {
                    q = .{ ox + v[0], oy + v[1] };
                    e = .{ ox + v[2], oy + v[3] };
                } else {
                    q = if (last_quad) |lq| [2]f32{ 2 * cx - lq[0], 2 * cy - lq[1] } else [2]f32{ cx, cy };
                    e = .{ ox + v[0], oy + v[1] };
                }
                try out.append(a, .{ .cubic = .{ cx + 2.0 / 3.0 * (q[0] - cx), cy + 2.0 / 3.0 * (q[1] - cy), e[0] + 2.0 / 3.0 * (q[0] - e[0]), e[1] + 2.0 / 3.0 * (q[1] - e[1]), e[0], e[1] } });
                last_quad = q;
                last_ctrl = null;
                cx = e[0];
                cy = e[1];
            },
            'A' => {
                const ex = ox + v[5];
                const ey = oy + v[6];
                try arcToCubics(a, out, cx, cy, v[0], v[1], v[2], v[3] != 0, v[4] != 0, ex, ey);
                cx = ex;
                cy = ey;
                last_ctrl = null;
                last_quad = null;
            },
            else => break,
        }
    }
}

/// SVG endpoint-parameterized elliptical arc -> cubic béziers (SVG 1.1 F.6).
fn arcToCubics(a: Allocator, out: *std.ArrayList(Seg), x1: f32, y1: f32, rx0: f32, ry0: f32, angle: f32, large: bool, sweep: bool, x2: f32, y2: f32) !void {
    var rx = @abs(rx0);
    var ry = @abs(ry0);
    if (rx == 0 or ry == 0 or (x1 == x2 and y1 == y2)) {
        try out.append(a, .{ .line = .{ x2, y2 } });
        return;
    }
    const phi = angle * std.math.pi / 180;
    const cp = @cos(phi);
    const sp = @sin(phi);
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy;
    const y1p = -sp * dx + cp * dy;
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        rx *= @sqrt(lambda);
        ry *= @sqrt(lambda);
    }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    var coef = @sqrt(@max(0, num / den));
    if (large == sweep) coef = -coef;
    const cxp = coef * rx * y1p / ry;
    const cyp = -coef * ry * x1p / rx;
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
    const cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const angleOf = struct {
        fn f(ux: f32, uy: f32, vx: f32, vy: f32) f32 {
            const dot = ux * vx + uy * vy;
            const len = @sqrt(ux * ux + uy * uy) * @sqrt(vx * vx + vy * vy);
            var r = std.math.acos(std.math.clamp(dot / len, -1, 1));
            if (ux * vy - uy * vx < 0) r = -r;
            return r;
        }
    }.f;
    const theta1 = angleOf(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    var dtheta = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep and dtheta > 0) dtheta -= 2 * std.math.pi;
    if (sweep and dtheta < 0) dtheta += 2 * std.math.pi;
    const n_seg: usize = @intFromFloat(@ceil(@abs(dtheta) / (std.math.pi / 2.0)));
    const delta = dtheta / @as(f32, @floatFromInt(@max(1, n_seg)));
    const t = 4.0 / 3.0 * @tan(delta / 4);
    var th = theta1;
    for (0..@max(1, n_seg)) |_| {
        const c1 = @cos(th);
        const s1 = @sin(th);
        const c2 = @cos(th + delta);
        const s2 = @sin(th + delta);
        const p1 = [2]f32{ c1 - t * s1, s1 + t * c1 };
        const p2 = [2]f32{ c2 + t * s2, s2 - t * c2 };
        const p3 = [2]f32{ c2, s2 };
        const map = struct {
            fn f(p: [2]f32, rxx: f32, ryy: f32, cpp: f32, spp: f32, ccx: f32, ccy: f32) [2]f32 {
                const xx = p[0] * rxx;
                const yy = p[1] * ryy;
                return .{ cpp * xx - spp * yy + ccx, spp * xx + cpp * yy + ccy };
            }
        }.f;
        const q1 = map(p1, rx, ry, cp, sp, cx, cy);
        const q2 = map(p2, rx, ry, cp, sp, cx, cy);
        const q3 = map(p3, rx, ry, cp, sp, cx, cy);
        try out.append(a, .{ .cubic = .{ q1[0], q1[1], q2[0], q2[1], q3[0], q3[1] } });
        th += delta;
    }
}

test "path parsing" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var segs: std.ArrayList(Seg) = .empty;
    try parsePath(arena.allocator(), "M3 12h18M12 3v18 m-2-2l4 4a2 2 0 1 1-4 0z", &segs);
    try std.testing.expectEqual(@as(usize, 9), segs.items.len);
    try std.testing.expectEqual(@as(f32, 21), segs.items[1].line[0]);
    try std.testing.expectEqual(@as(f32, 10), segs.items[4].move[0]);
    try std.testing.expectEqual(@as(f32, 19), segs.items[4].move[1]);
}
