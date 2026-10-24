//! Animation engine: CSS transitions, @keyframes animations and programmatic
//! spring animations. Animated values are written over the cascaded computed
//! style after each restyle, so the rest of the pipeline sees plain styles.
//! Transitions and springs are interruptible: a new target starts from the
//! current animated value (springs also keep their velocity).
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const style_mod = @import("style.zig");
const props = @import("css/properties.zig");
const values = @import("css/values.zig");
const sheet_mod = @import("css/stylesheet.zig");

const Allocator = std.mem.Allocator;
const Document = dom.Document;
const NodeId = dom.NodeId;
const Style = style_mod.Style;
const PropId = props.PropId;
const Color = geom.Color;
const LengthPct = values.LengthPct;

/// A single animatable value.
pub const Value = union(enum) {
    num: f32,
    color: Color,
    len: LengthPct,
    /// 2D transform resolved per box at paint time; we animate the op lists
    transform: TransformValue,
    shadows: ShadowsValue,
    filters: FiltersValue,
    discrete: Style, // snapshot for non-interpolable properties

    pub fn lerp(a: Value, b: Value, t: f32, arena: Allocator) Value {
        switch (a) {
            .num => |x| if (b == .num) return .{ .num = x + (b.num - x) * t },
            .color => |x| if (b == .color) return .{ .color = Color.lerp(x, b.color, std.math.clamp(t, 0, 1)) },
            .len => |x| if (b == .len) return .{ .len = LengthPct.lerp(x, b.len, t) },
            .transform => |x| if (b == .transform) return .{ .transform = x.lerp(b.transform, t, arena) },
            .shadows => |x| if (b == .shadows) return .{ .shadows = x.lerp(b.shadows, t, arena) },
            .filters => |x| if (b == .filters) return .{ .filters = x.lerp(b.filters, t, arena) },
            .discrete => {},
        }
        return if (t < 0.5) a else b;
    }

    pub fn eql(a: Value, b: Value) bool {
        if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
        return switch (a) {
            .num => |x| x == b.num,
            .color => |x| x.eql(b.color),
            .len => |x| x.px == b.len.px and x.pct == b.len.pct,
            .transform => |x| x.eql(b.transform),
            .shadows => |x| x.eql(b.shadows),
            .filters => |x| x.eql(b.filters),
            .discrete => false,
        };
    }

    /// Distance used for spring rest detection.
    fn magnitude(a: Value, b: Value) f32 {
        return switch (a) {
            .num => |x| @abs(x - b.num),
            .len => |x| @abs(x.px - b.len.px) + @abs(x.pct - b.len.pct) * 100,
            .color => |x| @as(f32, @floatFromInt(@abs(@as(i32, x.r) - @as(i32, b.color.r)) + @abs(@as(i32, x.a) - @as(i32, b.color.a)))) / 255,
            else => 0,
        };
    }
};

pub const TransformValue = struct {
    ops: []const style_mod.TransformOp,
    translate: ?[2]LengthPct,
    scale: ?[2]f32,
    rotate: ?f32,

    fn eql(a: TransformValue, b: TransformValue) bool {
        if (a.ops.len != b.ops.len) return false;
        for (a.ops, b.ops) |x, y| if (!std.meta.eql(x, y)) return false;
        return std.meta.eql(a.translate, b.translate) and std.meta.eql(a.scale, b.scale) and std.meta.eql(a.rotate, b.rotate);
    }

    fn lerp(a: TransformValue, b: TransformValue, t: f32, arena: Allocator) TransformValue {
        var out: TransformValue = .{ .ops = b.ops, .translate = lerpOpt2L(a.translate, b.translate, t), .scale = lerpOpt2(a.scale, b.scale, t, 1), .rotate = lerpOptF(a.rotate, b.rotate, t) };
        // same structure (or one side empty): interpolate per function
        const n = @max(a.ops.len, b.ops.len);
        if (n == 0) return out;
        const ops = arena.alloc(style_mod.TransformOp, n) catch return if (t < 0.5) a else b;
        for (0..n) |i| {
            const x: ?style_mod.TransformOp = if (i < a.ops.len) a.ops[i] else null;
            const y: ?style_mod.TransformOp = if (i < b.ops.len) b.ops[i] else null;
            const xa = x orelse identityLike(y.?);
            const yb = y orelse identityLike(x.?);
            if (std.meta.activeTag(xa) != std.meta.activeTag(yb)) {
                // mismatched lists: matrix interpolation of the whole list is
                // not supported; switch at the midpoint
                return if (t < 0.5) a else b;
            }
            ops[i] = switch (xa) {
                .translate => |p| .{ .translate = .{ .x = LengthPct.lerp(p.x, yb.translate.x, t), .y = LengthPct.lerp(p.y, yb.translate.y, t) } },
                .scale => |p| .{ .scale = .{ .x = p.x + (yb.scale.x - p.x) * t, .y = p.y + (yb.scale.y - p.y) * t } },
                .rotate => |r| .{ .rotate = r + (yb.rotate - r) * t },
                .skew => |p| .{ .skew = .{ .x = p.x + (yb.skew.x - p.x) * t, .y = p.y + (yb.skew.y - p.y) * t } },
                .matrix => |m| .{ .matrix = lerpMatrix(m, yb.matrix, t) },
            };
        }
        out.ops = ops;
        return out;
    }
};

fn identityLike(op: style_mod.TransformOp) style_mod.TransformOp {
    return switch (op) {
        .translate => .{ .translate = .{ .x = .{}, .y = .{} } },
        .scale => .{ .scale = .{ .x = 1, .y = 1 } },
        .rotate => .{ .rotate = 0 },
        .skew => .{ .skew = .{ .x = 0, .y = 0 } },
        .matrix => .{ .matrix = geom.Transform.identity },
    };
}

fn lerpMatrix(a: geom.Transform, b: geom.Transform, t: f32) geom.Transform {
    return .{ .a = a.a + (b.a - a.a) * t, .b = a.b + (b.b - a.b) * t, .c = a.c + (b.c - a.c) * t, .d = a.d + (b.d - a.d) * t, .e = a.e + (b.e - a.e) * t, .f = a.f + (b.f - a.f) * t };
}

fn lerpOpt2L(a: ?[2]LengthPct, b: ?[2]LengthPct, t: f32) ?[2]LengthPct {
    if (a == null and b == null) return null;
    const x = a orelse [2]LengthPct{ .{}, .{} };
    const y = b orelse [2]LengthPct{ .{}, .{} };
    return .{ LengthPct.lerp(x[0], y[0], t), LengthPct.lerp(x[1], y[1], t) };
}

fn lerpOpt2(a: ?[2]f32, b: ?[2]f32, t: f32, ident: f32) ?[2]f32 {
    if (a == null and b == null) return null;
    const x = a orelse [2]f32{ ident, ident };
    const y = b orelse [2]f32{ ident, ident };
    return .{ x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t };
}

fn lerpOptF(a: ?f32, b: ?f32, t: f32) ?f32 {
    if (a == null and b == null) return null;
    const x = a orelse 0;
    const y = b orelse 0;
    return x + (y - x) * t;
}

pub const ShadowsValue = struct {
    list: []const style_mod.Shadow,

    fn eql(a: ShadowsValue, b: ShadowsValue) bool {
        if (a.list.len != b.list.len) return false;
        for (a.list, b.list) |x, y| if (!std.meta.eql(x, y)) return false;
        return true;
    }
    fn lerp(a: ShadowsValue, b: ShadowsValue, t: f32, arena: Allocator) ShadowsValue {
        const n = @max(a.list.len, b.list.len);
        const out = arena.alloc(style_mod.Shadow, n) catch return if (t < 0.5) a else b;
        for (0..n) |i| {
            const none = style_mod.Shadow{ .color = .{} };
            const x = if (i < a.list.len) a.list[i] else blk: {
                var z = none;
                z.inset = b.list[i].inset;
                break :blk z;
            };
            const y = if (i < b.list.len) b.list[i] else blk: {
                var z = none;
                z.inset = a.list[i].inset;
                break :blk z;
            };
            out[i] = .{
                .x = x.x + (y.x - x.x) * t,
                .y = x.y + (y.y - x.y) * t,
                .blur = @max(0, x.blur + (y.blur - x.blur) * t),
                .spread = x.spread + (y.spread - x.spread) * t,
                .color = Color.lerp(x.color, y.color, std.math.clamp(t, 0, 1)),
                .inset = y.inset,
            };
        }
        return .{ .list = out };
    }
};

pub const FiltersValue = struct {
    list: []const style_mod.Filter,

    fn eql(a: FiltersValue, b: FiltersValue) bool {
        if (a.list.len != b.list.len) return false;
        for (a.list, b.list) |x, y| if (!std.meta.eql(x, y)) return false;
        return true;
    }
    fn lerp(a: FiltersValue, b: FiltersValue, t: f32, arena: Allocator) FiltersValue {
        const n = @max(a.list.len, b.list.len);
        const out = arena.alloc(style_mod.Filter, n) catch return if (t < 0.5) a else b;
        for (0..n) |i| {
            const y = if (i < b.list.len) b.list[i] else filterIdentity(a.list[i]);
            const x = if (i < a.list.len) a.list[i] else filterIdentity(y);
            if (std.meta.activeTag(x) != std.meta.activeTag(y)) return if (t < 0.5) a else b;
            out[i] = switch (x) {
                .blur => |v| .{ .blur = v + (y.blur - v) * t },
                .brightness => |v| .{ .brightness = v + (y.brightness - v) * t },
                .contrast => |v| .{ .contrast = v + (y.contrast - v) * t },
                .grayscale => |v| .{ .grayscale = v + (y.grayscale - v) * t },
                .saturate => |v| .{ .saturate = v + (y.saturate - v) * t },
                .invert => |v| .{ .invert = v + (y.invert - v) * t },
                .sepia => |v| .{ .sepia = v + (y.sepia - v) * t },
                .opacity => |v| .{ .opacity = v + (y.opacity - v) * t },
                .hue_rotate => |v| .{ .hue_rotate = v + (y.hue_rotate - v) * t },
                .drop_shadow => y,
            };
        }
        return .{ .list = out };
    }
};

fn filterIdentity(f: style_mod.Filter) style_mod.Filter {
    return switch (f) {
        .blur => .{ .blur = 0 },
        .brightness => .{ .brightness = 1 },
        .contrast => .{ .contrast = 1 },
        .grayscale => .{ .grayscale = 0 },
        .saturate => .{ .saturate = 1 },
        .invert => .{ .invert = 0 },
        .sepia => .{ .sepia = 0 },
        .opacity => .{ .opacity = 1 },
        .hue_rotate => .{ .hue_rotate = 0 },
        .drop_shadow => f,
    };
}

// ---------------------------------------------------------------------------
// Property access
// ---------------------------------------------------------------------------

pub const animatable = [_]PropId{
    .opacity,                .color,              .background_color,          .border_top_color,           .border_right_color,
    .border_bottom_color,    .border_left_color,  .outline_color,             .text_decoration_color,      .width,
    .height,                 .min_width,          .min_height,                .max_width,                  .max_height,
    .top,                    .right,              .bottom,                    .left,                       .margin_top,
    .margin_right,           .margin_bottom,      .margin_left,               .padding_top,                .padding_right,
    .padding_bottom,         .padding_left,       .border_top_width,          .border_right_width,         .border_bottom_width,
    .border_left_width,      .border_top_left_radius, .border_top_right_radius, .border_bottom_right_radius, .border_bottom_left_radius,
    .row_gap,                .column_gap,         .font_size,                 .letter_spacing,             .flex_grow,
    .flex_shrink,            .transform,          .box_shadow,                .filter,                     .backdrop_filter,
    .outline_width,          .outline_offset,     .visibility,                .z_index,                    .flex_basis,
};

pub fn affectsLayout(p: PropId) bool {
    return switch (p) {
        .opacity, .color, .background_color, .border_top_color, .border_right_color, .border_bottom_color, .border_left_color, .outline_color, .text_decoration_color, .transform, .box_shadow, .filter, .backdrop_filter, .outline_width, .outline_offset, .visibility, .z_index, .border_top_left_radius, .border_top_right_radius, .border_bottom_right_radius, .border_bottom_left_radius => false,
        else => true,
    };
}

fn sizeLen(v: style_mod.SizeVal) ?LengthPct {
    return switch (v) {
        .len => |l| l,
        else => null,
    };
}
fn autoLen(v: style_mod.LenAuto) ?LengthPct {
    return switch (v) {
        .len => |l| l,
        .auto => null,
    };
}

pub fn read(s: *const Style, p: PropId) ?Value {
    return switch (p) {
        .opacity => .{ .num = s.opacity },
        .color => .{ .color = s.color },
        .background_color => .{ .color = s.background_color },
        .border_top_color => .{ .color = s.border_color[0] },
        .border_right_color => .{ .color = s.border_color[1] },
        .border_bottom_color => .{ .color = s.border_color[2] },
        .border_left_color => .{ .color = s.border_color[3] },
        .outline_color => .{ .color = s.outline_color },
        .text_decoration_color => .{ .color = s.text_decoration_color },
        .width => if (sizeLen(s.width)) |l| .{ .len = l } else null,
        .height => if (sizeLen(s.height)) |l| .{ .len = l } else null,
        .min_width => if (sizeLen(s.min_width)) |l| .{ .len = l } else null,
        .min_height => if (sizeLen(s.min_height)) |l| .{ .len = l } else null,
        .max_width => if (sizeLen(s.max_width)) |l| .{ .len = l } else null,
        .max_height => if (sizeLen(s.max_height)) |l| .{ .len = l } else null,
        .flex_basis => if (sizeLen(s.flex_basis)) |l| .{ .len = l } else null,
        .top => if (autoLen(s.inset[0])) |l| .{ .len = l } else null,
        .right => if (autoLen(s.inset[1])) |l| .{ .len = l } else null,
        .bottom => if (autoLen(s.inset[2])) |l| .{ .len = l } else null,
        .left => if (autoLen(s.inset[3])) |l| .{ .len = l } else null,
        .margin_top => if (autoLen(s.margin[0])) |l| .{ .len = l } else null,
        .margin_right => if (autoLen(s.margin[1])) |l| .{ .len = l } else null,
        .margin_bottom => if (autoLen(s.margin[2])) |l| .{ .len = l } else null,
        .margin_left => if (autoLen(s.margin[3])) |l| .{ .len = l } else null,
        .padding_top => .{ .len = s.padding[0] },
        .padding_right => .{ .len = s.padding[1] },
        .padding_bottom => .{ .len = s.padding[2] },
        .padding_left => .{ .len = s.padding[3] },
        .border_top_width => .{ .num = s.border_width[0] },
        .border_right_width => .{ .num = s.border_width[1] },
        .border_bottom_width => .{ .num = s.border_width[2] },
        .border_left_width => .{ .num = s.border_width[3] },
        .border_top_left_radius => .{ .len = s.radius[0] },
        .border_top_right_radius => .{ .len = s.radius[1] },
        .border_bottom_right_radius => .{ .len = s.radius[2] },
        .border_bottom_left_radius => .{ .len = s.radius[3] },
        .row_gap => .{ .len = s.row_gap },
        .column_gap => .{ .len = s.column_gap },
        .font_size => .{ .num = s.font_size },
        .letter_spacing => .{ .num = s.letter_spacing },
        .flex_grow => .{ .num = s.flex_grow },
        .flex_shrink => .{ .num = s.flex_shrink },
        .outline_width => .{ .num = s.outline_width },
        .outline_offset => .{ .num = s.outline_offset },
        .z_index => if (s.z_index) |z| .{ .num = @floatFromInt(z) } else null,
        .transform => .{ .transform = .{ .ops = s.transform, .translate = s.translate, .scale = s.scale, .rotate = s.rotate } },
        .box_shadow => .{ .shadows = .{ .list = s.box_shadow } },
        .filter => .{ .filters = .{ .list = s.filter } },
        .backdrop_filter => .{ .filters = .{ .list = s.backdrop_filter } },
        .visibility => .{ .discrete = s.* },
        else => null,
    };
}

pub fn write(s: *Style, p: PropId, v: Value) void {
    switch (p) {
        .opacity => s.opacity = std.math.clamp(v.num, 0, 1),
        .color => s.color = v.color,
        .background_color => s.background_color = v.color,
        .border_top_color => s.border_color[0] = v.color,
        .border_right_color => s.border_color[1] = v.color,
        .border_bottom_color => s.border_color[2] = v.color,
        .border_left_color => s.border_color[3] = v.color,
        .outline_color => s.outline_color = v.color,
        .text_decoration_color => s.text_decoration_color = v.color,
        .width => s.width = .{ .len = v.len },
        .height => s.height = .{ .len = v.len },
        .min_width => s.min_width = .{ .len = v.len },
        .min_height => s.min_height = .{ .len = v.len },
        .max_width => s.max_width = .{ .len = v.len },
        .max_height => s.max_height = .{ .len = v.len },
        .flex_basis => s.flex_basis = .{ .len = v.len },
        .top => s.inset[0] = .{ .len = v.len },
        .right => s.inset[1] = .{ .len = v.len },
        .bottom => s.inset[2] = .{ .len = v.len },
        .left => s.inset[3] = .{ .len = v.len },
        .margin_top => s.margin[0] = .{ .len = v.len },
        .margin_right => s.margin[1] = .{ .len = v.len },
        .margin_bottom => s.margin[2] = .{ .len = v.len },
        .margin_left => s.margin[3] = .{ .len = v.len },
        .padding_top => s.padding[0] = v.len,
        .padding_right => s.padding[1] = v.len,
        .padding_bottom => s.padding[2] = v.len,
        .padding_left => s.padding[3] = v.len,
        .border_top_width => s.border_width[0] = @max(0, v.num),
        .border_right_width => s.border_width[1] = @max(0, v.num),
        .border_bottom_width => s.border_width[2] = @max(0, v.num),
        .border_left_width => s.border_width[3] = @max(0, v.num),
        .border_top_left_radius => s.radius[0] = v.len,
        .border_top_right_radius => s.radius[1] = v.len,
        .border_bottom_right_radius => s.radius[2] = v.len,
        .border_bottom_left_radius => s.radius[3] = v.len,
        .row_gap => s.row_gap = v.len,
        .column_gap => s.column_gap = v.len,
        .font_size => s.font_size = @max(0, v.num),
        .letter_spacing => s.letter_spacing = v.num,
        .flex_grow => s.flex_grow = @max(0, v.num),
        .flex_shrink => s.flex_shrink = @max(0, v.num),
        .outline_width => s.outline_width = @max(0, v.num),
        .outline_offset => s.outline_offset = v.num,
        .z_index => s.z_index = @intFromFloat(@round(v.num)),
        .transform => {
            s.transform = v.transform.ops;
            s.translate = v.transform.translate;
            s.scale = v.transform.scale;
            s.rotate = v.transform.rotate;
        },
        .box_shadow => s.box_shadow = v.shadows.list,
        .filter => s.filter = v.filters.list,
        .backdrop_filter => s.backdrop_filter = v.filters.list,
        .visibility => s.visibility = v.discrete.visibility,
        else => {},
    }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

fn cubicBezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) f32 {
    // solve for t with Newton-Raphson, then evaluate y(t)
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var t = x;
    var i: usize = 0;
    while (i < 8) : (i += 1) {
        const cx = 3 * x1;
        const bx = 3 * (x2 - x1) - cx;
        const ax = 1 - cx - bx;
        const fx = ((ax * t + bx) * t + cx) * t - x;
        const dfx = (3 * ax * t + 2 * bx) * t + cx;
        if (@abs(fx) < 1e-5) break;
        if (@abs(dfx) < 1e-6) break;
        t -= fx / dfx;
    }
    // bisection fallback
    if (t < 0 or t > 1) {
        var lo: f32 = 0;
        var hi: f32 = 1;
        t = x;
        var k: usize = 0;
        while (k < 30) : (k += 1) {
            const cx = 3 * x1;
            const bx = 3 * (x2 - x1) - cx;
            const ax = 1 - cx - bx;
            const fx = ((ax * t + bx) * t + cx) * t;
            if (@abs(fx - x) < 1e-5) break;
            if (fx < x) lo = t else hi = t;
            t = (lo + hi) / 2;
        }
    }
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    return ((ay * t + by) * t + cy) * t;
}

pub fn ease(t: props.Timing, x: f32) f32 {
    return switch (t) {
        .cubic => |c| cubicBezier(c[0], c[1], c[2], c[3], x),
        .steps => |s| blk: {
            const n: f32 = @floatFromInt(s.n);
            var step = @floor(x * n);
            if (s.jump_start) step += 1;
            break :blk std.math.clamp(step / n, 0, 1);
        },
    };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

pub const Spring = struct {
    stiffness: f32 = 170,
    damping: f32 = 26,
    mass: f32 = 1,

    pub const gentle: Spring = .{ .stiffness = 120, .damping = 14 };
    pub const wobbly: Spring = .{ .stiffness = 180, .damping = 12 };
    pub const stiff: Spring = .{ .stiffness = 210, .damping = 20 };
    pub const snappy: Spring = .{ .stiffness = 400, .damping = 30 };
};

const Kind = enum { transition, spring, keyframes };

const Running = struct {
    kind: Kind,
    node: NodeId,
    prop: PropId,
    from: Value,
    to: Value,
    start: f64,
    duration: f32,
    delay: f32,
    timing: props.Timing,
    /// spring state: progress in [0,1]-space from `from` to `to`, and velocity
    pos: f32 = 0,
    vel: f32 = 0,
    spring: Spring = .{},
    current: ?Value = null,
    done: bool = false,
    /// a spring that reached its target keeps holding the value
    resting: bool = false,
    /// transitions: the cascaded end value the transition is heading to
    reverse_from: ?Value = null,
};

const KeyframeRun = struct {
    node: NodeId,
    name: []const u8,
    anim: props.Animation,
    start: f64,
    /// computed style at each keyframe (allocated in `arena`)
    frames: []const struct { offset: f32, style: Style, timing: ?props.Timing },
    props_used: []const PropId,
    arena: std.heap.ArenaAllocator,
    finished: bool = false,
};

pub const Animator = struct {
    gpa: Allocator,
    doc: *Document,
    engine: *style_mod.Engine,
    running: std.ArrayList(Running) = .empty,
    keyframes: std.ArrayList(*KeyframeRun) = .empty,
    /// values allocated for the current frame's interpolations
    frame_arena: std.heap.ArenaAllocator,
    now: f64 = 0,
    reduced_motion: bool = false,

    pub fn init(gpa: Allocator, doc: *Document, engine: *style_mod.Engine) Animator {
        return .{ .gpa = gpa, .doc = doc, .engine = engine, .frame_arena = std.heap.ArenaAllocator.init(gpa) };
    }

    pub fn deinit(a: *Animator) void {
        for (a.running.items) |r| a.freeRunning(r);
        a.running.deinit(a.gpa);
        for (a.keyframes.items) |k| {
            k.arena.deinit();
            a.gpa.destroy(k);
        }
        a.keyframes.deinit(a.gpa);
        a.frame_arena.deinit();
    }

    /// Hook for style.Engine.on_style_change.
    pub fn onStyleChange(ctx: ?*anyopaque, doc: *Document, id: NodeId, old: ?*const Style, new: *const Style) void {
        const a: *Animator = @ptrCast(@alignCast(ctx.?));
        _ = doc;
        a.styleChanged(id, old, new) catch {};
    }

    fn findRunning(a: *Animator, id: NodeId, p: PropId, kind: Kind) ?*Running {
        for (a.running.items) |*r| if (r.node == id and r.prop == p and r.kind == kind and !r.done) return r;
        return null;
    }

    fn styleChanged(a: *Animator, id: NodeId, old: ?*const Style, new: *const Style) !void {
        // keyframe animations: (re)start when the animation-name list changes
        try a.syncKeyframes(id, old, new);
        const o = old orelse return;
        if (new.transitions.len == 0 and !a.hasAny(id)) return;
        for (animatable) |p| {
            const tr = transitionFor(new, p) orelse continue;
            if (tr.duration <= 0 and tr.delay <= 0) continue;
            const end = read(new, p) orelse continue;
            // start value: the currently displayed value (interruption)
            var start: Value = undefined;
            var duration = tr.duration;
            if (a.findRunning(id, p, .transition)) |r| {
                if (r.to.eql(end)) continue; // already heading there
                start = r.current orelse r.from;
                // reversing a partially complete transition shortens it by
                // the portion already run (CSS Transitions §3.1)
                if (r.from.eql(end)) {
                    const elapsed: f32 = @floatCast(a.now - r.start - r.delay);
                    const x = if (r.duration > 0) std.math.clamp(elapsed / r.duration, 0, 1) else 1;
                    duration = tr.duration * x;
                }
                r.done = true;
            } else if (a.findRunning(id, p, .spring) != null) {
                continue; // springs own this property
            } else {
                const ov = read(o, p) orelse continue;
                if (ov.eql(end)) continue;
                if (std.meta.activeTag(ov) != std.meta.activeTag(end)) continue;
                start = ov;
            }
            if (a.reduced_motion) continue;
            try a.running.append(a.gpa, .{
                .kind = .transition,
                .node = id,
                .prop = p,
                .from = try a.persist(start),
                .to = try a.persist(end),
                .start = a.now,
                .duration = duration,
                .delay = tr.delay,
                .timing = tr.timing,
            });
        }
    }

    fn hasAny(a: *Animator, id: NodeId) bool {
        for (a.running.items) |r| if (r.node == id and !r.done) return true;
        return false;
    }

    fn transitionFor(s: *const Style, p: PropId) ?props.Transition {
        var found: ?props.Transition = null;
        for (s.transitions) |t| {
            if (t.property == null or t.property.? == p or shorthandCovers(t.property.?, p)) found = t;
        }
        return found;
    }

    fn shorthandCovers(sh: PropId, p: PropId) bool {
        for (props.longhandsOf(sh)) |l| if (l == p) return true;
        if (sh == .inset) return p == .top or p == .right or p == .bottom or p == .left;
        if (sh == .border_color) return p == .border_top_color or p == .border_right_color or p == .border_bottom_color or p == .border_left_color;
        if (sh == .translate or sh == .scale or sh == .rotate) return p == .transform;
        return false;
    }

    /// Values referencing style arenas must outlive restyles: copy list data.
    fn persist(a: *Animator, v: Value) !Value {
        // persistent storage: the frame arena is reset each frame, so use the
        // engine-lifetime allocator for animation endpoints
        return switch (v) {
            .transform => |t| .{ .transform = .{ .ops = try a.gpa.dupe(style_mod.TransformOp, t.ops), .translate = t.translate, .scale = t.scale, .rotate = t.rotate } },
            .shadows => |s| .{ .shadows = .{ .list = try a.gpa.dupe(style_mod.Shadow, s.list) } },
            .filters => |f| .{ .filters = .{ .list = try a.gpa.dupe(style_mod.Filter, f.list) } },
            else => v,
        };
    }

    /// A run owns its persisted endpoints; every removal goes through here.
    fn freeRunning(a: *Animator, r: Running) void {
        a.freeValue(r.from);
        a.freeValue(r.to);
    }

    fn freeValue(a: *Animator, v: Value) void {
        switch (v) {
            .transform => |t| a.gpa.free(t.ops),
            .shadows => |s| a.gpa.free(s.list),
            .filters => |f| a.gpa.free(f.list),
            else => {},
        }
    }

    // -----------------------------------------------------------------------
    // Springs (programmatic)
    // -----------------------------------------------------------------------

    /// Stop a programmatic spring; the cascaded value applies again.
    pub fn cancelSpring(a: *Animator, id: NodeId, p: PropId) void {
        if (a.findRunning(id, p, .spring)) |r| {
            r.done = true;
            a.doc.markStyleDirty(id);
        }
    }

    /// Animate a property toward `to` with a spring. Interrupting keeps velocity.
    pub fn springTo(a: *Animator, id: NodeId, p: PropId, to: Value, spring: Spring) !void {
        const ns = style_mod.get(a.doc.node(id)) orelse return;
        if (a.findRunning(id, p, .spring)) |r| {
            const cur = r.current orelse r.from;
            // re-base: keep the physical velocity in value space
            const old_span = Value.magnitude(r.from, r.to);
            const new_span = Value.magnitude(cur, to);
            const vel_scale = if (new_span > 0.0001) old_span / new_span else 0;
            a.freeValue(r.from);
            a.freeValue(r.to);
            r.from = try a.persist(cur);
            r.to = try a.persist(to);
            r.pos = 0;
            r.vel = r.vel * vel_scale;
            r.spring = spring;
            r.resting = false;
            return;
        }
        const from = read(&ns.s, p) orelse return;
        try a.running.append(a.gpa, .{ .kind = .spring, .node = id, .prop = p, .from = try a.persist(from), .to = try a.persist(to), .start = a.now, .duration = 0, .delay = 0, .timing = props.Timing.linear, .spring = spring });
    }

    // -----------------------------------------------------------------------
    // Keyframes
    // -----------------------------------------------------------------------

    fn syncKeyframes(a: *Animator, id: NodeId, old: ?*const Style, new: *const Style) !void {
        const old_anims: []const props.Animation = if (old) |o| o.animations else &.{};
        // stop animations no longer listed
        var i: usize = 0;
        while (i < a.keyframes.items.len) {
            const k = a.keyframes.items[i];
            if (k.node == id and !listed(new.animations, k.name)) {
                k.arena.deinit();
                a.gpa.destroy(k);
                _ = a.keyframes.swapRemove(i);
                continue;
            }
            i += 1;
        }
        for (new.animations) |an| {
            if (an.name.len == 0 or std.mem.eql(u8, an.name, "none")) continue;
            var exists = false;
            for (a.keyframes.items) |k| if (k.node == id and std.mem.eql(u8, k.name, an.name)) {
                exists = true;
                k.anim = an; // duration/iteration changes apply live
            };
            if (exists and listed(old_anims, an.name)) continue;
            if (exists) continue;
            const kf = a.engine.keyframes.get(an.name) orelse continue;
            try a.startKeyframes(id, an, kf, new);
        }
    }

    fn listed(list: []const props.Animation, name: []const u8) bool {
        for (list) |x| if (std.mem.eql(u8, x.name, name)) return true;
        return false;
    }

    fn startKeyframes(a: *Animator, id: NodeId, an: props.Animation, kf: *const sheet_mod.Keyframes, base: *const Style) !void {
        const run = try a.gpa.create(KeyframeRun);
        run.* = .{ .node = id, .name = undefined, .anim = an, .start = a.now, .frames = &.{}, .props_used = &.{}, .arena = std.heap.ArenaAllocator.init(a.gpa) };
        errdefer {
            run.arena.deinit();
            a.gpa.destroy(run);
        }
        const ar = run.arena.allocator();
        run.name = try ar.dupe(u8, an.name);
        const parent_id = a.doc.node(id).parent;
        const parent: ?*const Style = if (parent_id != dom.null_id and a.doc.node(parent_id).kind == .element) style_mod.of(a.doc, parent_id) else null;
        var frames: std.ArrayList(@typeInfo(@TypeOf(run.frames)).pointer.child) = .empty;
        var used: std.ArrayList(PropId) = .empty;
        const has_from = kf.frames.len > 0 and kf.frames[0].offset == 0;
        const has_to = kf.frames.len > 0 and kf.frames[kf.frames.len - 1].offset == 1;
        // implicit from/to keyframes use the element's own style
        if (!has_from) try frames.append(ar, .{ .offset = 0, .style = base.*, .timing = null });
        for (kf.frames) |f| {
            const st = try style_mod.applyDeclsTo(a.engine, a.doc, id, base, parent, f.decls, ar);
            try frames.append(ar, .{ .offset = f.offset, .style = st, .timing = f.timing });
            for (f.decls) |d| {
                const lh = props.longhandsOf(d.prop);
                if (lh.len > 0) {
                    for (lh) |p| try addUnique(ar, &used, p);
                } else try addUnique(ar, &used, d.prop);
                if (d.prop == .translate or d.prop == .scale or d.prop == .rotate) try addUnique(ar, &used, .transform);
            }
        }
        if (!has_to) try frames.append(ar, .{ .offset = 1, .style = base.*, .timing = null });
        // frames' list values live in style arenas that a restyle may free:
        // deep-copy list fields we animate
        for (frames.items) |*f| {
            f.style.transform = try ar.dupe(style_mod.TransformOp, f.style.transform);
            f.style.box_shadow = try ar.dupe(style_mod.Shadow, f.style.box_shadow);
            f.style.filter = try ar.dupe(style_mod.Filter, f.style.filter);
            f.style.backdrop_filter = try ar.dupe(style_mod.Filter, f.style.backdrop_filter);
        }
        run.frames = frames.items;
        run.props_used = used.items;
        try a.keyframes.append(a.gpa, run);
    }

    fn addUnique(ar: Allocator, list: *std.ArrayList(PropId), p: PropId) !void {
        for (list.items) |x| if (x == p) return;
        try list.append(ar, p);
    }

    // -----------------------------------------------------------------------
    // Per-frame application
    // -----------------------------------------------------------------------

    /// Whether anything is animating (the host should keep producing frames).
    pub fn active(a: *const Animator) bool {
        for (a.running.items) |r| if (!r.done and !r.resting) return true;
        for (a.keyframes.items) |k| if (!k.finished) return true;
        return false;
    }

    /// Advance to `now` and write animated values into computed styles.
    /// Call after style.Engine.update and before layout.
    pub fn apply(a: *Animator, now: f64) void {
        const dt: f32 = @floatCast(std.math.clamp(now - a.now, 0, 0.1));
        a.now = now;
        _ = a.frame_arena.reset(.retain_capacity);
        const fa = a.frame_arena.allocator();
        // keyframes first, transitions/springs override them
        for (a.keyframes.items) |k| a.applyKeyframes(k, now, fa);
        var i: usize = 0;
        while (i < a.running.items.len) {
            const r = &a.running.items[i];
            const node = a.doc.get(r.node);
            if (r.done or node == null or style_mod.get(node.?) == null) {
                a.freeRunning(r.*);
                _ = a.running.swapRemove(i);
                continue;
            }
            const ns = style_mod.get(node.?).?;
            var v: Value = undefined;
            switch (r.kind) {
                .transition => {
                    const elapsed: f32 = @floatCast(now - r.start - r.delay);
                    if (elapsed < 0) {
                        v = r.from;
                    } else {
                        const x = if (r.duration <= 0) 1 else std.math.clamp(elapsed / r.duration, 0, 1);
                        v = Value.lerp(r.from, r.to, ease(r.timing, x), fa);
                        if (x >= 1) {
                            r.done = true;
                            // the run is dropped next frame: restyle so the
                            // cascaded end value replaces this frame's value
                            a.doc.markStyleDirty(r.node);
                        }
                    }
                },
                .spring => if (r.resting) {
                    v = r.to;
                } else {
                    // semi-implicit Euler with substeps; pos 0 -> 1
                    const steps: usize = 4;
                    const h = dt / @as(f32, @floatFromInt(steps));
                    for (0..steps) |_| {
                        const force = -r.spring.stiffness * (r.pos - 1) - r.spring.damping * r.vel;
                        r.vel += force / r.spring.mass * h;
                        r.pos += r.vel * h;
                    }
                    v = Value.lerp(r.from, r.to, r.pos, fa);
                    if (@abs(r.pos - 1) < 0.001 and @abs(r.vel) < 0.01) {
                        v = r.to;
                        // the final value keeps overriding the cascade
                        r.resting = true;
                    }
                },
                .keyframes => unreachable,
            }
            r.current = v;
            write(&ns.s, r.prop, v);
            a.markDirty(r.node, r.prop);
            i += 1;
        }
        // finished keyframe runs with fill none are kept (cheap) but inactive
    }

    fn markDirty(a: *Animator, id: NodeId, p: PropId) void {
        a.doc.needs_paint = true;
        if (affectsLayout(p)) a.doc.markLayoutDirty(id);
    }

    fn applyKeyframes(a: *Animator, k: *KeyframeRun, now: f64, fa: Allocator) void {
        const node = a.doc.get(k.node) orelse return;
        const ns = style_mod.get(node) orelse return;
        const an = k.anim;
        if (an.play_state == .paused) {
            k.start += now - a.now;
        }
        const elapsed: f32 = @floatCast(now - k.start - an.delay);
        if (an.duration <= 0) return;
        var iter = elapsed / an.duration;
        if (elapsed < 0) {
            if (an.fill != .backwards and an.fill != .both) return;
            iter = 0;
        }
        if (iter >= an.iterations) {
            const holds = an.fill == .forwards or an.fill == .both;
            if (k.finished and !holds) return;
            if (!k.finished) {
                k.finished = true;
                // Without fill the cascaded values apply again: restyle next
                // frame. This frame still writes the end values so the style
                // never keeps list data from the frame arena being reset.
                if (!holds) a.doc.markStyleDirty(k.node);
            }
            iter = an.iterations;
        }
        var whole = @floor(iter);
        var frac = iter - whole;
        if (iter >= an.iterations and frac == 0 and iter > 0) {
            whole -= 1;
            frac = 1;
        }
        const odd = @mod(whole, 2) == 1;
        const reverse = switch (an.direction) {
            .normal => false,
            .reverse => true,
            .alternate => odd,
            .alternate_reverse => !odd,
        };
        const p = if (reverse) 1 - frac else frac;
        // find the segment
        var seg: usize = 0;
        while (seg + 1 < k.frames.len and k.frames[seg + 1].offset < p) seg += 1;
        if (seg + 1 >= k.frames.len) seg = if (k.frames.len >= 2) k.frames.len - 2 else 0;
        const f0 = k.frames[seg];
        const f1 = if (seg + 1 < k.frames.len) k.frames[seg + 1] else f0;
        const span = f1.offset - f0.offset;
        const local = if (span <= 0) 1 else std.math.clamp((p - f0.offset) / span, 0, 1);
        const eased = ease(f0.timing orelse an.timing, local);
        for (k.props_used) |prop| {
            const va = read(&f0.style, prop) orelse continue;
            const vb = read(&f1.style, prop) orelse continue;
            write(&ns.s, prop, Value.lerp(va, vb, eased, fa));
            a.markDirty(k.node, prop);
        }
    }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test "cubic bezier easing" {
    try std.testing.expectApproxEqAbs(@as(f32, 0.5), ease(props.Timing.linear, 0.5), 0.001);
    const e = ease(props.Timing.ease, 0.5);
    try std.testing.expect(e > 0.75 and e < 0.85);
    try std.testing.expectApproxEqAbs(@as(f32, 0.5), ease(.{ .steps = .{ .n = 2, .jump_start = false } }, 0.6), 0.001);
}
