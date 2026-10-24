//! CSS property ids, typed declaration values, and per-property parsing
//! including shorthand expansion. Values that reference var() are kept raw
//! and re-parsed after substitution at cascade time.
const std = @import("std");
const tok = @import("tokenizer.zig");
const values = @import("values.zig");
const geom = @import("../geom.zig");

const Token = tok.Token;
const Stream = values.Stream;
const Length = values.Length;
const ColorValue = values.ColorValue;
const Allocator = std.mem.Allocator;

// ---------------------------------------------------------------------------
// Keyword enums
// ---------------------------------------------------------------------------

pub const Display = enum(u8) { block, inline_, inline_block, flex, inline_flex, grid, inline_grid, none, contents, list_item };
pub const Position = enum(u8) { static, relative, absolute, fixed, sticky };
pub const BoxSizing = enum(u8) { content_box, border_box };
pub const FlexDirection = enum(u8) { row, row_reverse, column, column_reverse };
pub const FlexWrap = enum(u8) { nowrap, wrap, wrap_reverse };
pub const Justify = enum(u8) { normal, flex_start, flex_end, start, end, center, space_between, space_around, space_evenly, stretch, left, right };
pub const Align = enum(u8) { auto, normal, stretch, flex_start, flex_end, start, end, center, baseline, space_between, space_around, space_evenly, self_start, self_end };
pub const Overflow = enum(u8) { visible, hidden, clip, scroll, auto };
pub const Visibility = enum(u8) { visible, hidden, collapse };
pub const FontStyle = enum(u8) { normal, italic, oblique };
pub const TextAlign = enum(u8) { start, end, left, right, center, justify };
pub const WhiteSpace = enum(u8) { normal, nowrap, pre, pre_wrap, pre_line, break_spaces };
pub const TextOverflow = enum(u8) { clip, ellipsis };
pub const TextTransform = enum(u8) { none, uppercase, lowercase, capitalize };
pub const Cursor = enum(u8) { auto, default, pointer, text, move, grab, grabbing, not_allowed, wait, progress, crosshair, help, col_resize, row_resize, ew_resize, ns_resize, nesw_resize, nwse_resize, e_resize, w_resize, n_resize, s_resize, ne_resize, nw_resize, se_resize, sw_resize, zoom_in, zoom_out, none, copy, alias, context_menu, cell, vertical_text, no_drop, all_scroll };
pub const PointerEvents = enum(u8) { auto, none };
pub const UserSelect = enum(u8) { auto, none, text, all, contain };
pub const BorderStyle = enum(u8) { none, hidden, solid, dashed, dotted, double, groove, ridge, inset, outset };
pub const ObjectFit = enum(u8) { fill, contain, cover, none, scale_down };
pub const WordBreak = enum(u8) { normal, break_all, keep_all, break_word };
pub const OverflowWrap = enum(u8) { normal, break_word, anywhere };
pub const AppRegion = enum(u8) { none, drag, no_drag };
pub const VerticalAlign = enum(u8) { baseline, top, middle, bottom, text_top, text_bottom, sub, super };
pub const ListStyleType = enum(u8) { disc, circle, square, decimal, none };
pub const Resize = enum(u8) { none, both, horizontal, vertical };
pub const BackgroundRepeat = enum(u8) { repeat, no_repeat, repeat_x, repeat_y };
pub const BackgroundClip = enum(u8) { border_box, padding_box, content_box, text };
pub const AnimationDirection = enum(u8) { normal, reverse, alternate, alternate_reverse };
pub const AnimationFill = enum(u8) { none, forwards, backwards, both };
pub const AnimationPlayState = enum(u8) { running, paused };
pub const ScrollBehavior = enum(u8) { auto, smooth };
pub const GridAutoFlow = enum(u8) { row, column, row_dense, column_dense };

pub const TextDecoration = packed struct(u8) {
    underline: bool = false,
    overline: bool = false,
    line_through: bool = false,
    _pad: u5 = 0,
};

// ---------------------------------------------------------------------------
// Compound value types
// ---------------------------------------------------------------------------

pub const Shadow = struct {
    x: Length = .{},
    y: Length = .{},
    blur: Length = .{},
    spread: Length = .{},
    color: ColorValue = .current_color,
    inset: bool = false,
};

pub const TransformOp = union(enum) {
    translate: struct { x: Length, y: Length },
    scale: struct { x: f32, y: f32 },
    rotate: f32, // radians
    skew: struct { x: f32, y: f32 },
    matrix: geom.Transform,
};

pub const Timing = union(enum) {
    cubic: [4]f32,
    steps: struct { n: u16, jump_start: bool },

    pub const linear: Timing = .{ .cubic = .{ 0, 0, 1, 1 } };
    pub const ease: Timing = .{ .cubic = .{ 0.25, 0.1, 0.25, 1 } };
    pub const ease_in: Timing = .{ .cubic = .{ 0.42, 0, 1, 1 } };
    pub const ease_out: Timing = .{ .cubic = .{ 0, 0, 0.58, 1 } };
    pub const ease_in_out: Timing = .{ .cubic = .{ 0.42, 0, 0.58, 1 } };
};

pub const Transition = struct {
    property: ?PropId = null, // null = all
    duration: f32 = 0,
    delay: f32 = 0,
    timing: Timing = Timing.ease,
};

pub const Animation = struct {
    name: []const u8 = "",
    duration: f32 = 0,
    delay: f32 = 0,
    timing: Timing = Timing.ease,
    iterations: f32 = 1, // inf = infinite
    direction: AnimationDirection = .normal,
    fill: AnimationFill = .none,
    play_state: AnimationPlayState = .running,
};

pub const GradientStop = struct {
    color: ColorValue,
    pos: ?Length = null,
};

pub const Gradient = struct {
    kind: enum { linear, radial, conic } = .linear,
    angle: f32 = std.math.pi, // linear: radians, 0 = to top, pi = to bottom
    /// linear: "to <corner>" keeps the angle resolved at paint time
    to_corner: ?struct { x: i8, y: i8 } = null,
    circle: bool = false,
    cx: Length = .{ .pct = 0.5 },
    cy: Length = .{ .pct = 0.5 },
    repeating: bool = false,
    stops: []const GradientStop,
};

pub const Image = union(enum) {
    none,
    url: []const u8,
    gradient: *const Gradient,
};

pub const Track = union(enum) {
    fixed: Length,
    fr: f32,
    auto,
    min_content,
    max_content,
    minmax: struct { min: *const Track, max: *const Track },
};

pub const TrackList = struct {
    tracks: []const Track = &.{},
    /// repeat(auto-fill|auto-fit, track): when set, `tracks` holds the repeated pattern.
    auto_repeat: enum { none, fill, fit } = .none,
};

pub const GridLine = struct {
    start: i16 = 0, // 0 = auto
    span: u16 = 0, // >0 means "span n"
    end: i16 = 0,
};

// ---------------------------------------------------------------------------
// Property ids
// ---------------------------------------------------------------------------

pub const PropId = enum(u16) {
    // layout
    display,
    position,
    box_sizing,
    top,
    right,
    bottom,
    left,
    width,
    height,
    min_width,
    min_height,
    max_width,
    max_height,
    aspect_ratio,
    margin_top,
    margin_right,
    margin_bottom,
    margin_left,
    padding_top,
    padding_right,
    padding_bottom,
    padding_left,
    border_top_width,
    border_right_width,
    border_bottom_width,
    border_left_width,
    border_top_style,
    border_right_style,
    border_bottom_style,
    border_left_style,
    border_top_color,
    border_right_color,
    border_bottom_color,
    border_left_color,
    border_top_left_radius,
    border_top_right_radius,
    border_bottom_right_radius,
    border_bottom_left_radius,
    flex_direction,
    flex_wrap,
    flex_grow,
    flex_shrink,
    flex_basis,
    order,
    justify_content,
    justify_items,
    justify_self,
    align_items,
    align_self,
    align_content,
    row_gap,
    column_gap,
    grid_template_columns,
    grid_template_rows,
    grid_auto_columns,
    grid_auto_rows,
    grid_auto_flow,
    grid_column,
    grid_row,
    overflow_x,
    overflow_y,
    z_index,
    vertical_align,
    // visual
    color,
    background_color,
    background_image,
    background_size,
    background_position,
    background_repeat,
    background_clip,
    opacity,
    visibility,
    box_shadow,
    transform,
    transform_origin,
    translate,
    scale,
    rotate,
    outline_width,
    outline_style,
    outline_color,
    outline_offset,
    cursor,
    pointer_events,
    user_select,
    object_fit,
    filter,
    backdrop_filter,
    // text
    font_family,
    font_size,
    font_weight,
    font_style,
    line_height,
    letter_spacing,
    word_spacing,
    text_align,
    text_decoration_line,
    text_decoration_color,
    text_transform,
    text_overflow,
    text_indent,
    text_shadow,
    white_space,
    word_break,
    overflow_wrap,
    line_clamp,
    tab_size,
    caret_color,
    accent_color,
    list_style_type,
    content,
    // animation
    transition_property,
    transition_duration,
    transition_delay,
    transition_timing_function,
    transition,
    animation,
    // misc
    app_region,
    resize,
    scroll_behavior,
    // shorthands (only stored when they contain var())
    margin,
    padding,
    inset,
    border,
    border_top,
    border_right,
    border_bottom,
    border_left,
    border_width,
    border_style,
    border_color,
    border_radius,
    flex,
    flex_flow,
    gap,
    overflow,
    background,
    font,
    outline,
    place_items,
    place_content,
    place_self,
    text_decoration,
    grid_template,
    grid_area,
    // custom property: name kept on the declaration
    custom,

    pub fn fromName(name: []const u8) ?PropId {
        var buf: [48]u8 = undefined;
        if (name.len > buf.len) return null;
        for (name, 0..) |c, i| buf[i] = if (c == '-') '_' else std.ascii.toLower(c);
        const n = buf[0..name.len];
        if (aliases.get(n)) |p| return p;
        return std.meta.stringToEnum(PropId, n);
    }

    pub fn isInherited(p: PropId) bool {
        return switch (p) {
            .color, .font_family, .font_size, .font_weight, .font_style, .line_height, .letter_spacing, .word_spacing, .text_align, .text_transform, .text_indent, .text_shadow, .white_space, .word_break, .overflow_wrap, .tab_size, .caret_color, .accent_color, .list_style_type, .cursor, .visibility, .pointer_events, .custom => true,
            else => false,
        };
    }
};

const aliases = std.StaticStringMap(PropId).initComptime(.{
    .{ "_webkit_app_region", .app_region },
    .{ "_webkit_user_select", .user_select },
    .{ "_webkit_line_clamp", .line_clamp },
    .{ "word_wrap", .overflow_wrap },
    .{ "grid_gap", .gap },
    .{ "grid_row_gap", .row_gap },
    .{ "grid_column_gap", .column_gap },
    .{ "_webkit_backdrop_filter", .backdrop_filter },
    .{ "_webkit_text_decoration", .text_decoration },
    .{ "inset_block", .inset },
    .{ "_webkit_box_shadow", .box_shadow },
});

pub const Keyword = enum(u8) { initial, inherit, unset, revert, auto, none, normal, content, min_content, max_content, fit_content };

pub const Filter = union(enum) {
    blur: Length,
    brightness: f32,
    contrast: f32,
    grayscale: f32,
    saturate: f32,
    invert: f32,
    sepia: f32,
    opacity: f32,
    hue_rotate: f32,
    drop_shadow: Shadow,
};

pub const BackgroundSize = union(enum) {
    cover,
    contain,
    size: struct { w: ?Length, h: ?Length }, // null = auto
};

pub const Value = union(enum) {
    keyword: Keyword,
    enum_val: u8,
    length: Length,
    number: f32,
    color: ColorValue,
    font_family: []const []const u8,
    shadows: []const Shadow,
    transform: []const TransformOp,
    transitions: []const Transition,
    transition_props: []const ?PropId,
    times: []const f32,
    timings: []const Timing,
    animations: []const Animation,
    images: []const Image,
    string: []const u8,
    raw: []const u8,
    tracks: TrackList,
    grid_line: GridLine,
    text_decoration: TextDecoration,
    pair: struct { a: Length, b: Length }, // transform-origin, background-position, translate
    scale2: struct { x: f32, y: f32 },
    filters: []const Filter,
    bg_size: BackgroundSize,
};

pub const Declaration = struct {
    prop: PropId,
    value: Value,
    important: bool = false,
    /// custom property name (with leading "--"), for prop == .custom
    name: []const u8 = "",
};

// ---------------------------------------------------------------------------
// Parsing entry point
// ---------------------------------------------------------------------------

pub const ParseError = error{ OutOfMemory, Invalid };

/// Parse `name: <tokens>` into one or more declarations (shorthands expand).
/// Strings referenced by the result are allocated from `arena`.
pub fn parseDeclaration(
    arena: Allocator,
    name: []const u8,
    value_toks: []const Token,
    value_src: []const u8,
    important: bool,
    out: *std.ArrayList(Declaration),
) ParseError!void {
    if (name.len > 2 and name[0] == '-' and name[1] == '-') {
        try out.append(arena, .{
            .prop = .custom,
            .name = try arena.dupe(u8, name),
            .value = .{ .raw = try arena.dupe(u8, std.mem.trim(u8, value_src, " \t\r\n")) },
            .important = important,
        });
        return;
    }
    const prop = PropId.fromName(name) orelse return error.Invalid;
    if (containsVar(value_toks)) {
        try out.append(arena, .{ .prop = prop, .value = .{ .raw = try arena.dupe(u8, std.mem.trim(u8, value_src, " \t\r\n")) }, .important = important });
        return;
    }
    var s = Stream.init(value_toks);
    // global keywords
    if (s.peek().tag == .ident) {
        const t = s.peek();
        inline for (.{ "initial", "inherit", "unset", "revert" }) |kw| {
            if (std.ascii.eqlIgnoreCase(t.text, kw)) {
                _ = s.next();
                if (!s.atEnd()) return error.Invalid;
                const k = std.meta.stringToEnum(Keyword, kw).?;
                for (longhandsOf(prop)) |lp| try out.append(arena, .{ .prop = lp, .value = .{ .keyword = k }, .important = important });
                if (longhandsOf(prop).len == 0) try out.append(arena, .{ .prop = prop, .value = .{ .keyword = k }, .important = important });
                return;
            }
        }
    }
    const start_len = out.items.len;
    errdefer out.shrinkRetainingCapacity(start_len);
    var p = Parser{ .arena = arena, .s = &s, .out = out, .important = important };
    try p.parse(prop);
    if (!s.atEnd()) {
        out.shrinkRetainingCapacity(start_len);
        return error.Invalid;
    }
}

pub fn containsVar(toks: []const Token) bool {
    for (toks) |t| {
        if (t.tag == .function and (std.ascii.eqlIgnoreCase(t.text, "var") or std.ascii.eqlIgnoreCase(t.text, "env"))) return true;
    }
    return false;
}

pub fn longhandsOf(p: PropId) []const PropId {
    return switch (p) {
        .margin => &.{ .margin_top, .margin_right, .margin_bottom, .margin_left },
        .padding => &.{ .padding_top, .padding_right, .padding_bottom, .padding_left },
        .inset => &.{ .top, .right, .bottom, .left },
        .border => &.{ .border_top_width, .border_right_width, .border_bottom_width, .border_left_width, .border_top_style, .border_right_style, .border_bottom_style, .border_left_style, .border_top_color, .border_right_color, .border_bottom_color, .border_left_color },
        .border_top => &.{ .border_top_width, .border_top_style, .border_top_color },
        .border_right => &.{ .border_right_width, .border_right_style, .border_right_color },
        .border_bottom => &.{ .border_bottom_width, .border_bottom_style, .border_bottom_color },
        .border_left => &.{ .border_left_width, .border_left_style, .border_left_color },
        .border_width => &.{ .border_top_width, .border_right_width, .border_bottom_width, .border_left_width },
        .border_style => &.{ .border_top_style, .border_right_style, .border_bottom_style, .border_left_style },
        .border_color => &.{ .border_top_color, .border_right_color, .border_bottom_color, .border_left_color },
        .border_radius => &.{ .border_top_left_radius, .border_top_right_radius, .border_bottom_right_radius, .border_bottom_left_radius },
        .flex => &.{ .flex_grow, .flex_shrink, .flex_basis },
        .flex_flow => &.{ .flex_direction, .flex_wrap },
        .gap => &.{ .row_gap, .column_gap },
        .overflow => &.{ .overflow_x, .overflow_y },
        .background => &.{ .background_color, .background_image, .background_size, .background_position, .background_repeat },
        .font => &.{ .font_style, .font_weight, .font_size, .line_height, .font_family },
        .outline => &.{ .outline_width, .outline_style, .outline_color },
        .place_items => &.{ .align_items, .justify_items },
        .place_content => &.{ .align_content, .justify_content },
        .place_self => &.{ .align_self, .justify_self },
        .text_decoration => &.{ .text_decoration_line, .text_decoration_color },
        .transition => &.{ .transition_property, .transition_duration, .transition_delay, .transition_timing_function },
        .grid_template => &.{ .grid_template_rows, .grid_template_columns },
        .grid_area => &.{ .grid_row, .grid_column },
        else => &.{},
    };
}

fn enumFromIdent(comptime E: type, text: []const u8) ?E {
    var buf: [32]u8 = undefined;
    if (text.len > buf.len) return null;
    for (text, 0..) |c, i| buf[i] = if (c == '-') '_' else std.ascii.toLower(c);
    const n = buf[0..text.len];
    if (E == Display and std.mem.eql(u8, n, "inline")) return .inline_;
    return std.meta.stringToEnum(E, n);
}

fn enumFor(p: PropId) ?type {
    return switch (p) {
        .display => Display,
        .position => Position,
        .box_sizing => BoxSizing,
        .flex_direction => FlexDirection,
        .flex_wrap => FlexWrap,
        .justify_content, .justify_items, .justify_self => Justify,
        .align_items, .align_self, .align_content => Align,
        .overflow_x, .overflow_y => Overflow,
        .visibility => Visibility,
        .font_style => FontStyle,
        .text_align => TextAlign,
        .white_space => WhiteSpace,
        .text_overflow => TextOverflow,
        .text_transform => TextTransform,
        .cursor => Cursor,
        .pointer_events => PointerEvents,
        .user_select => UserSelect,
        .border_top_style, .border_right_style, .border_bottom_style, .border_left_style, .outline_style => BorderStyle,
        .object_fit => ObjectFit,
        .word_break => WordBreak,
        .overflow_wrap => OverflowWrap,
        .app_region => AppRegion,
        .vertical_align => VerticalAlign,
        .list_style_type => ListStyleType,
        .resize => Resize,
        .background_repeat => BackgroundRepeat,
        .background_clip => BackgroundClip,
        .scroll_behavior => ScrollBehavior,
        .grid_auto_flow => GridAutoFlow,
        else => null,
    };
}

const Parser = struct {
    arena: Allocator,
    s: *Stream,
    out: *std.ArrayList(Declaration),
    important: bool,

    fn emit(p: *Parser, prop: PropId, v: Value) !void {
        try p.out.append(p.arena, .{ .prop = prop, .value = v, .important = p.important });
    }

    fn parse(p: *Parser, prop: PropId) ParseError!void {
        const s = p.s;
        switch (prop) {
            inline .display, .position, .box_sizing, .flex_direction, .flex_wrap, .justify_content, .justify_items, .justify_self, .align_items, .align_self, .align_content, .overflow_x, .overflow_y, .visibility, .font_style, .text_align, .white_space, .text_overflow, .text_transform, .cursor, .pointer_events, .user_select, .border_top_style, .border_right_style, .border_bottom_style, .border_left_style, .outline_style, .object_fit, .word_break, .overflow_wrap, .app_region, .vertical_align, .list_style_type, .resize, .background_repeat, .background_clip, .scroll_behavior => |pp| {
                const E = comptime enumFor(pp).?;
                const v = try p.enumValue(E);
                try p.emit(pp, .{ .enum_val = @intFromEnum(v) });
            },
            .grid_auto_flow => {
                var col = false;
                var dense = false;
                while (!s.atEnd()) {
                    const t = s.next();
                    if (t.tag != .ident) return error.Invalid;
                    if (std.ascii.eqlIgnoreCase(t.text, "column")) col = true else if (std.ascii.eqlIgnoreCase(t.text, "dense")) dense = true else if (!std.ascii.eqlIgnoreCase(t.text, "row")) return error.Invalid;
                }
                const v: GridAutoFlow = if (col) (if (dense) .column_dense else .column) else (if (dense) .row_dense else .row);
                try p.emit(.grid_auto_flow, .{ .enum_val = @intFromEnum(v) });
            },
            .top, .right, .bottom, .left, .width, .height, .min_width, .min_height, .margin_top, .margin_right, .margin_bottom, .margin_left, .flex_basis => {
                try p.emit(prop, try p.lengthOrKeyword(&.{ .auto, .content, .min_content, .max_content, .fit_content }));
            },
            .max_width, .max_height => try p.emit(prop, try p.lengthOrKeyword(&.{ .none, .min_content, .max_content, .fit_content })),
            .padding_top, .padding_right, .padding_bottom, .padding_left, .text_indent, .outline_offset => try p.emit(prop, .{ .length = try p.length() }),
            .border_top_width, .border_right_width, .border_bottom_width, .border_left_width, .outline_width => try p.emit(prop, .{ .length = try p.borderWidth() }),
            .border_top_left_radius, .border_top_right_radius, .border_bottom_right_radius, .border_bottom_left_radius => {
                const a = try p.length();
                _ = values.parseLength(s, false); // elliptical second radius: ignored
                try p.emit(prop, .{ .length = a });
            },
            .row_gap, .column_gap, .letter_spacing, .word_spacing => try p.emit(prop, try p.lengthOrKeyword(&.{.normal})),
            .flex_grow, .flex_shrink, .opacity => {
                const t = s.peek();
                if (t.tag == .percentage) {
                    _ = s.next();
                    try p.emit(prop, .{ .number = t.num / 100 });
                } else try p.emit(prop, .{ .number = values.parseNumber(s) orelse return error.Invalid });
            },
            .order, .line_clamp, .tab_size => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .keyword = .none });
                try p.emit(prop, .{ .number = values.parseNumber(s) orelse return error.Invalid });
            },
            .z_index => {
                if (s.eatIdent("auto")) return p.emit(prop, .{ .keyword = .auto });
                try p.emit(prop, .{ .number = values.parseNumber(s) orelse return error.Invalid });
            },
            .aspect_ratio => {
                if (s.eatIdent("auto")) return p.emit(prop, .{ .keyword = .auto });
                const a = values.parseNumber(s) orelse return error.Invalid;
                var r = a;
                if (s.eatDelim('/')) {
                    const b = values.parseNumber(s) orelse return error.Invalid;
                    if (b == 0) return error.Invalid;
                    r = a / b;
                }
                try p.emit(prop, .{ .number = r });
            },
            .color, .background_color, .border_top_color, .border_right_color, .border_bottom_color, .border_left_color, .outline_color, .text_decoration_color, .caret_color, .accent_color => {
                if (s.eatIdent("auto")) return p.emit(prop, .{ .keyword = .auto });
                try p.emit(prop, .{ .color = values.parseColor(s) orelse return error.Invalid });
            },
            .font_size => try p.emit(prop, try p.fontSize()),
            .font_weight => try p.emit(prop, .{ .number = try p.fontWeight() }),
            .line_height => {
                if (s.eatIdent("normal")) return p.emit(prop, .{ .keyword = .normal });
                if (values.parseNumber(s)) |n| return p.emit(prop, .{ .number = n });
                try p.emit(prop, .{ .length = try p.length() });
            },
            .font_family => try p.emit(prop, .{ .font_family = try p.fontFamily() }),
            .box_shadow, .text_shadow => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .shadows = &.{} });
                try p.emit(prop, .{ .shadows = try p.shadowList() });
            },
            .transform => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .transform = &.{} });
                try p.emit(prop, .{ .transform = try p.transformList() });
            },
            .translate => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .keyword = .none });
                const x = try p.length();
                const y = values.parseLength(s, false) orelse Length{};
                _ = values.parseLength(s, false); // z ignored
                try p.emit(prop, .{ .pair = .{ .a = x, .b = y } });
            },
            .scale => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .keyword = .none });
                const x = try p.numberOrPct();
                const y = p.optNumberOrPct() orelse x;
                _ = p.optNumberOrPct();
                try p.emit(prop, .{ .scale2 = .{ .x = x, .y = y } });
            },
            .rotate => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .keyword = .none });
                try p.emit(prop, .{ .number = values.parseAngle(s) orelse return error.Invalid });
            },
            .transform_origin, .background_position => try p.emit(prop, try p.position()),
            .text_decoration_line => try p.emit(prop, .{ .text_decoration = try p.decorationLine() }),
            .text_decoration => {
                var line: TextDecoration = .{};
                var color: ?ColorValue = null;
                while (!s.atEnd()) {
                    if (values.parseColor(s)) |c| {
                        color = c;
                        continue;
                    }
                    const t = s.next();
                    if (t.tag != .ident) return error.Invalid;
                    if (!applyDecoration(&line, t.text)) {
                        // style/thickness keywords tolerated
                        if (enumFromIdent(BorderStyle, t.text) == null and !std.ascii.eqlIgnoreCase(t.text, "wavy")) return error.Invalid;
                    }
                }
                try p.emit(.text_decoration_line, .{ .text_decoration = line });
                try p.emit(.text_decoration_color, if (color) |c| .{ .color = c } else .{ .color = .current_color });
            },
            .transition_property => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .transition_props = &.{} });
                var list: std.ArrayList(?PropId) = .empty;
                while (true) {
                    const t = s.next();
                    if (t.tag != .ident) return error.Invalid;
                    try list.append(p.arena, if (std.ascii.eqlIgnoreCase(t.text, "all")) null else PropId.fromName(t.text) orelse .custom);
                    if (!s.eatComma()) break;
                }
                try p.emit(prop, .{ .transition_props = list.items });
            },
            .transition_duration, .transition_delay => {
                var list: std.ArrayList(f32) = .empty;
                while (true) {
                    try list.append(p.arena, values.parseTime(s) orelse return error.Invalid);
                    if (!s.eatComma()) break;
                }
                try p.emit(prop, .{ .times = list.items });
            },
            .transition_timing_function => {
                var list: std.ArrayList(Timing) = .empty;
                while (true) {
                    try list.append(p.arena, p.timing() orelse return error.Invalid);
                    if (!s.eatComma()) break;
                }
                try p.emit(prop, .{ .timings = list.items });
            },
            .transition => try p.transitionShorthand(),
            .animation => try p.emit(prop, .{ .animations = try p.animationList() }),
            .background_image => try p.emit(prop, .{ .images = try p.imageList() }),
            .background_size => {
                if (s.eatIdent("cover")) return p.emit(prop, .{ .bg_size = .cover });
                if (s.eatIdent("contain")) return p.emit(prop, .{ .bg_size = .contain });
                const w: ?Length = if (s.eatIdent("auto")) null else try p.length();
                const h: ?Length = if (s.atEnd()) w else if (s.eatIdent("auto")) null else try p.length();
                try p.emit(prop, .{ .bg_size = .{ .size = .{ .w = w, .h = h } } });
            },
            .filter, .backdrop_filter => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .filters = &.{} });
                try p.emit(prop, .{ .filters = try p.filterList() });
            },
            .content => {
                if (s.eatIdent("none") or s.eatIdent("normal")) return p.emit(prop, .{ .keyword = .none });
                var buf: std.ArrayList(u8) = .empty;
                while (!s.atEnd()) {
                    const t = s.next();
                    if (t.tag != .string) return error.Invalid;
                    try buf.appendSlice(p.arena, t.text);
                }
                try p.emit(prop, .{ .string = try decodeCssEscapes(p.arena, buf.items) });
            },
            .grid_template_columns, .grid_template_rows, .grid_auto_columns, .grid_auto_rows => {
                if (s.eatIdent("none")) return p.emit(prop, .{ .tracks = .{} });
                try p.emit(prop, .{ .tracks = try p.trackList() });
            },
            .grid_column, .grid_row => try p.emit(prop, .{ .grid_line = try p.gridLine() }),
            .grid_template => {
                const rows = try p.trackList();
                if (!s.eatDelim('/')) return error.Invalid;
                const cols = try p.trackList();
                try p.emit(.grid_template_rows, .{ .tracks = rows });
                try p.emit(.grid_template_columns, .{ .tracks = cols });
            },
            .grid_area => {
                const row = try p.gridLine();
                const col = if (s.eatDelim('/')) try p.gridLine() else GridLine{};
                try p.emit(.grid_row, .{ .grid_line = row });
                try p.emit(.grid_column, .{ .grid_line = col });
            },
            // ---- shorthands ----
            .margin, .inset => {
                var vs: [4]Value = undefined;
                const n = try p.upTo4(&vs, struct {
                    fn f(pp: *Parser) ParseError!Value {
                        return pp.lengthOrKeyword(&.{.auto});
                    }
                }.f);
                try p.emitBox(longhandsOf(prop), vs[0..n]);
            },
            .padding => {
                var vs: [4]Value = undefined;
                const n = try p.upTo4(&vs, struct {
                    fn f(pp: *Parser) ParseError!Value {
                        return .{ .length = try pp.length() };
                    }
                }.f);
                try p.emitBox(longhandsOf(prop), vs[0..n]);
            },
            .border_width => {
                var vs: [4]Value = undefined;
                const n = try p.upTo4(&vs, struct {
                    fn f(pp: *Parser) ParseError!Value {
                        return .{ .length = try pp.borderWidth() };
                    }
                }.f);
                try p.emitBox(longhandsOf(prop), vs[0..n]);
            },
            .border_style => {
                var vs: [4]Value = undefined;
                const n = try p.upTo4(&vs, struct {
                    fn f(pp: *Parser) ParseError!Value {
                        return .{ .enum_val = @intFromEnum(try pp.enumValue(BorderStyle)) };
                    }
                }.f);
                try p.emitBox(longhandsOf(prop), vs[0..n]);
            },
            .border_color => {
                var vs: [4]Value = undefined;
                const n = try p.upTo4(&vs, struct {
                    fn f(pp: *Parser) ParseError!Value {
                        return .{ .color = values.parseColor(pp.s) orelse return error.Invalid };
                    }
                }.f);
                try p.emitBox(longhandsOf(prop), vs[0..n]);
            },
            .border_radius => {
                var vs: [4]Value = undefined;
                const n = try p.upTo4(&vs, struct {
                    fn f(pp: *Parser) ParseError!Value {
                        return .{ .length = try pp.length() };
                    }
                }.f);
                if (s.eatDelim('/')) {
                    // elliptical radii: vertical radii ignored
                    while (values.parseLength(s, false) != null) {}
                }
                try p.emitBox(longhandsOf(prop), vs[0..n]);
            },
            .border, .border_top, .border_right, .border_bottom, .border_left, .outline => {
                var width: Length = .{ .px = 3 }; // medium
                var style: BorderStyle = .none;
                var color: ColorValue = .current_color;
                var any = false;
                while (!s.atEnd()) {
                    any = true;
                    if (values.parseColor(s)) |c| {
                        color = c;
                        continue;
                    }
                    const t = s.peek();
                    if (t.tag == .ident) {
                        if (enumFromIdent(BorderStyle, t.text)) |bs| {
                            _ = s.next();
                            style = bs;
                            continue;
                        }
                    }
                    width = try p.borderWidth();
                }
                if (!any) return error.Invalid;
                const sides: []const PropId = switch (prop) {
                    .border => &.{ .border_top_width, .border_right_width, .border_bottom_width, .border_left_width },
                    .border_top => &.{.border_top_width},
                    .border_right => &.{.border_right_width},
                    .border_bottom => &.{.border_bottom_width},
                    .border_left => &.{.border_left_width},
                    .outline => &.{.outline_width},
                    else => unreachable,
                };
                for (sides) |w| {
                    try p.emit(w, .{ .length = width });
                    try p.emit(styleFor(w), .{ .enum_val = @intFromEnum(style) });
                    try p.emit(colorFor(w), .{ .color = color });
                }
            },
            .flex => {
                if (s.eatIdent("none")) {
                    try p.emit(.flex_grow, .{ .number = 0 });
                    try p.emit(.flex_shrink, .{ .number = 0 });
                    return p.emit(.flex_basis, .{ .keyword = .auto });
                }
                if (s.eatIdent("auto")) {
                    try p.emit(.flex_grow, .{ .number = 1 });
                    try p.emit(.flex_shrink, .{ .number = 1 });
                    return p.emit(.flex_basis, .{ .keyword = .auto });
                }
                var grow: ?f32 = null;
                var shrink: ?f32 = null;
                var basis: ?Value = null;
                while (!s.atEnd()) {
                    const t = s.peek();
                    if (t.tag == .number and grow == null) {
                        grow = t.num;
                        _ = s.next();
                        if (s.peek().tag == .number) shrink = s.next().num;
                        continue;
                    }
                    if (basis == null) {
                        basis = try p.lengthOrKeyword(&.{ .auto, .content });
                        continue;
                    }
                    return error.Invalid;
                }
                try p.emit(.flex_grow, .{ .number = grow orelse 1 });
                try p.emit(.flex_shrink, .{ .number = shrink orelse 1 });
                try p.emit(.flex_basis, basis orelse .{ .length = .{} });
            },
            .flex_flow => {
                while (!s.atEnd()) {
                    const t = s.next();
                    if (t.tag != .ident) return error.Invalid;
                    if (enumFromIdent(FlexDirection, t.text)) |d| {
                        try p.emit(.flex_direction, .{ .enum_val = @intFromEnum(d) });
                    } else if (enumFromIdent(FlexWrap, t.text)) |w| {
                        try p.emit(.flex_wrap, .{ .enum_val = @intFromEnum(w) });
                    } else return error.Invalid;
                }
            },
            .gap => {
                const a = try p.lengthOrKeyword(&.{.normal});
                const b = if (s.atEnd()) a else try p.lengthOrKeyword(&.{.normal});
                try p.emit(.row_gap, a);
                try p.emit(.column_gap, b);
            },
            .overflow => {
                const a = try p.enumValue(Overflow);
                const b = if (s.atEnd()) a else try p.enumValue(Overflow);
                try p.emit(.overflow_x, .{ .enum_val = @intFromEnum(a) });
                try p.emit(.overflow_y, .{ .enum_val = @intFromEnum(b) });
            },
            .place_items, .place_content, .place_self => {
                const lh = longhandsOf(prop);
                const a = try p.enumValue(Align);
                var j: Justify = alignToJustify(a);
                if (!s.atEnd()) j = try p.enumValue(Justify);
                try p.emit(lh[0], .{ .enum_val = @intFromEnum(a) });
                try p.emit(lh[1], .{ .enum_val = @intFromEnum(j) });
            },
            .background => try p.backgroundShorthand(),
            .font => try p.fontShorthand(),
            .custom => return error.Invalid,
        }
    }

    fn enumValue(p: *Parser, comptime E: type) ParseError!E {
        const t = p.s.next();
        if (t.tag != .ident) return error.Invalid;
        return enumFromIdent(E, t.text) orelse error.Invalid;
    }

    fn length(p: *Parser) ParseError!Length {
        return values.parseLength(p.s, false) orelse error.Invalid;
    }

    fn lengthOrKeyword(p: *Parser, allowed: []const Keyword) ParseError!Value {
        const t = p.s.peek();
        if (t.tag == .ident) {
            for (allowed) |k| {
                if (std.ascii.eqlIgnoreCase(t.text, keywordName(k))) {
                    _ = p.s.next();
                    return .{ .keyword = k };
                }
            }
            return error.Invalid;
        }
        if (t.tag == .function and std.ascii.eqlIgnoreCase(t.text, "fit-content")) {
            _ = p.s.next();
            _ = p.s.functionBody();
            return .{ .keyword = .fit_content };
        }
        return .{ .length = try p.length() };
    }

    fn borderWidth(p: *Parser) ParseError!Length {
        const s = p.s;
        if (s.eatIdent("thin")) return .{ .px = 1 };
        if (s.eatIdent("medium")) return .{ .px = 3 };
        if (s.eatIdent("thick")) return .{ .px = 5 };
        return p.length();
    }

    fn numberOrPct(p: *Parser) ParseError!f32 {
        return p.optNumberOrPct() orelse error.Invalid;
    }
    fn optNumberOrPct(p: *Parser) ?f32 {
        const t = p.s.peek();
        if (t.tag == .percentage) {
            _ = p.s.next();
            return t.num / 100;
        }
        return values.parseNumber(p.s);
    }

    fn upTo4(p: *Parser, out: *[4]Value, comptime f: fn (*Parser) ParseError!Value) ParseError!usize {
        var n: usize = 0;
        while (n < 4 and !p.s.atEnd()) : (n += 1) {
            if (p.s.peek().tag == .delim) break;
            out[n] = try f(p);
        }
        if (n == 0) return error.Invalid;
        return n;
    }

    fn emitBox(p: *Parser, props: []const PropId, vs: []const Value) !void {
        const top = vs[0];
        const right = if (vs.len > 1) vs[1] else top;
        const bottom = if (vs.len > 2) vs[2] else top;
        const left = if (vs.len > 3) vs[3] else right;
        try p.emit(props[0], top);
        try p.emit(props[1], right);
        try p.emit(props[2], bottom);
        try p.emit(props[3], left);
    }

    fn fontSize(p: *Parser) ParseError!Value {
        const s = p.s;
        const t = s.peek();
        if (t.tag == .ident) {
            const table = .{
                .{ "xx-small", 9.0 }, .{ "x-small", 10.0 }, .{ "small", 13.0 }, .{ "medium", 16.0 },
                .{ "large", 18.0 },   .{ "x-large", 24.0 }, .{ "xx-large", 32.0 }, .{ "xxx-large", 48.0 },
            };
            inline for (table) |e| {
                if (std.ascii.eqlIgnoreCase(t.text, e[0])) {
                    _ = s.next();
                    return .{ .length = .{ .px = e[1] } };
                }
            }
            if (std.ascii.eqlIgnoreCase(t.text, "smaller")) {
                _ = s.next();
                return .{ .length = .{ .em = 0.833 } };
            }
            if (std.ascii.eqlIgnoreCase(t.text, "larger")) {
                _ = s.next();
                return .{ .length = .{ .em = 1.2 } };
            }
            return error.Invalid;
        }
        var l = try p.length();
        // percentages on font-size are relative to the parent font size
        l.em += l.pct;
        l.pct = 0;
        return .{ .length = l };
    }

    fn fontWeight(p: *Parser) ParseError!f32 {
        const s = p.s;
        if (s.eatIdent("normal")) return 400;
        if (s.eatIdent("bold")) return 700;
        if (s.eatIdent("bolder")) return -1; // resolved against parent
        if (s.eatIdent("lighter")) return -2;
        const n = values.parseNumber(s) orelse return error.Invalid;
        if (n < 1 or n > 1000) return error.Invalid;
        return n;
    }

    fn fontFamily(p: *Parser) ParseError![]const []const u8 {
        const s = p.s;
        var list: std.ArrayList([]const u8) = .empty;
        while (true) {
            const t = s.next();
            switch (t.tag) {
                .string => try list.append(p.arena, try p.arena.dupe(u8, t.text)),
                .ident => {
                    // multi-word unquoted family names
                    var buf: std.ArrayList(u8) = .empty;
                    try buf.appendSlice(p.arena, t.text);
                    while (true) {
                        const save = s.i;
                        const n = s.next();
                        if (n.tag == .ident) {
                            try buf.append(p.arena, ' ');
                            try buf.appendSlice(p.arena, n.text);
                        } else {
                            s.i = save;
                            break;
                        }
                    }
                    try list.append(p.arena, buf.items);
                },
                else => return error.Invalid,
            }
            if (!s.eatComma()) break;
        }
        return list.items;
    }

    fn shadowList(p: *Parser) ParseError![]const Shadow {
        const s = p.s;
        var list: std.ArrayList(Shadow) = .empty;
        while (true) {
            var sh: Shadow = .{};
            var lens: [4]Length = undefined;
            var nl: usize = 0;
            var have_color = false;
            while (!s.atEnd() and s.peek().tag != .comma) {
                if (s.eatIdent("inset")) {
                    sh.inset = true;
                    continue;
                }
                if (!have_color) {
                    if (values.parseColor(s)) |c| {
                        sh.color = c;
                        have_color = true;
                        continue;
                    }
                }
                if (nl >= 4) return error.Invalid;
                lens[nl] = try p.length();
                nl += 1;
            }
            if (nl < 2) return error.Invalid;
            sh.x = lens[0];
            sh.y = lens[1];
            if (nl > 2) sh.blur = lens[2];
            if (nl > 3) sh.spread = lens[3];
            try list.append(p.arena, sh);
            if (!s.eatComma()) break;
        }
        return list.items;
    }

    fn transformList(p: *Parser) ParseError![]const TransformOp {
        const s = p.s;
        var list: std.ArrayList(TransformOp) = .empty;
        while (!s.atEnd()) {
            const t = s.next();
            if (t.tag != .function) return error.Invalid;
            const body = s.functionBody();
            var bs = Stream.init(body);
            const name = t.text;
            const op: TransformOp = blk: {
                if (eq(name, "translate")) {
                    const x = values.parseLength(&bs, false) orelse return error.Invalid;
                    const y = if (bs.eatComma()) values.parseLength(&bs, false) orelse return error.Invalid else Length{};
                    break :blk .{ .translate = .{ .x = x, .y = y } };
                }
                if (eq(name, "translatex")) break :blk .{ .translate = .{ .x = values.parseLength(&bs, false) orelse return error.Invalid, .y = .{} } };
                if (eq(name, "translatey")) break :blk .{ .translate = .{ .x = .{}, .y = values.parseLength(&bs, false) orelse return error.Invalid } };
                if (eq(name, "translate3d")) {
                    const x = values.parseLength(&bs, false) orelse return error.Invalid;
                    _ = bs.eatComma();
                    const y = values.parseLength(&bs, false) orelse return error.Invalid;
                    break :blk .{ .translate = .{ .x = x, .y = y } };
                }
                if (eq(name, "scale")) {
                    const x = numOrPct(&bs) orelse return error.Invalid;
                    const y = if (bs.eatComma()) numOrPct(&bs) orelse return error.Invalid else x;
                    break :blk .{ .scale = .{ .x = x, .y = y } };
                }
                if (eq(name, "scalex")) break :blk .{ .scale = .{ .x = numOrPct(&bs) orelse return error.Invalid, .y = 1 } };
                if (eq(name, "scaley")) break :blk .{ .scale = .{ .x = 1, .y = numOrPct(&bs) orelse return error.Invalid } };
                if (eq(name, "rotate") or eq(name, "rotatez")) break :blk .{ .rotate = values.parseAngle(&bs) orelse return error.Invalid };
                if (eq(name, "skew")) {
                    const x = values.parseAngle(&bs) orelse return error.Invalid;
                    const y = if (bs.eatComma()) values.parseAngle(&bs) orelse return error.Invalid else 0;
                    break :blk .{ .skew = .{ .x = x, .y = y } };
                }
                if (eq(name, "skewx")) break :blk .{ .skew = .{ .x = values.parseAngle(&bs) orelse return error.Invalid, .y = 0 } };
                if (eq(name, "skewy")) break :blk .{ .skew = .{ .x = 0, .y = values.parseAngle(&bs) orelse return error.Invalid } };
                if (eq(name, "matrix")) {
                    var m: [6]f32 = undefined;
                    for (0..6) |i| {
                        if (i > 0) _ = bs.eatComma();
                        m[i] = values.parseNumber(&bs) orelse return error.Invalid;
                    }
                    break :blk .{ .matrix = .{ .a = m[0], .b = m[1], .c = m[2], .d = m[3], .e = m[4], .f = m[5] } };
                }
                return error.Invalid;
            };
            try list.append(p.arena, op);
        }
        return list.items;
    }

    fn position(p: *Parser) ParseError!Value {
        const s = p.s;
        var x: Length = .{ .pct = 0.5 };
        var y: Length = .{ .pct = 0.5 };
        var n: usize = 0;
        while (!s.atEnd() and n < 3) : (n += 1) {
            const t = s.peek();
            if (t.tag == .delim or t.tag == .comma) break;
            if (t.tag == .ident) {
                _ = s.next();
                if (eq(t.text, "left")) x = .{ .pct = 0 } else if (eq(t.text, "right")) x = .{ .pct = 1 } else if (eq(t.text, "top")) y = .{ .pct = 0 } else if (eq(t.text, "bottom")) y = .{ .pct = 1 } else if (eq(t.text, "center")) {
                    if (n == 0) x = .{ .pct = 0.5 } else y = .{ .pct = 0.5 };
                } else return error.Invalid;
                continue;
            }
            const l = try p.length();
            if (n == 0) x = l else y = l;
        }
        return .{ .pair = .{ .a = x, .b = y } };
    }

    fn decorationLine(p: *Parser) ParseError!TextDecoration {
        var d: TextDecoration = .{};
        if (p.s.eatIdent("none")) return d;
        while (!p.s.atEnd()) {
            const t = p.s.next();
            if (t.tag != .ident or !applyDecoration(&d, t.text)) return error.Invalid;
        }
        return d;
    }

    fn timing(p: *Parser) ?Timing {
        return parseTiming(p.s);
    }

    fn transitionShorthand(p: *Parser) ParseError!void {
        const s = p.s;
        var props: std.ArrayList(?PropId) = .empty;
        var durs: std.ArrayList(f32) = .empty;
        var delays: std.ArrayList(f32) = .empty;
        var timings: std.ArrayList(Timing) = .empty;
        if (s.eatIdent("none")) {
            try p.emit(.transition_property, .{ .transition_props = &.{} });
            return;
        }
        while (true) {
            var prop: ?PropId = null;
            var dur: ?f32 = null;
            var delay: ?f32 = null;
            var tm: ?Timing = null;
            while (!s.atEnd() and s.peek().tag != .comma) {
                if (values.parseTime(s)) |t| {
                    if (dur == null) dur = t else delay = t;
                    continue;
                }
                if (parseTiming(s)) |t| {
                    tm = t;
                    continue;
                }
                const t = s.next();
                if (t.tag != .ident) return error.Invalid;
                prop = if (eq(t.text, "all")) null else PropId.fromName(t.text) orelse .custom;
            }
            try props.append(p.arena, prop);
            try durs.append(p.arena, dur orelse 0);
            try delays.append(p.arena, delay orelse 0);
            try timings.append(p.arena, tm orelse Timing.ease);
            if (!s.eatComma()) break;
        }
        try p.emit(.transition_property, .{ .transition_props = props.items });
        try p.emit(.transition_duration, .{ .times = durs.items });
        try p.emit(.transition_delay, .{ .times = delays.items });
        try p.emit(.transition_timing_function, .{ .timings = timings.items });
    }

    fn animationList(p: *Parser) ParseError![]const Animation {
        const s = p.s;
        var list: std.ArrayList(Animation) = .empty;
        if (s.eatIdent("none")) return list.items;
        while (true) {
            var a: Animation = .{};
            var have_dur = false;
            while (!s.atEnd() and s.peek().tag != .comma) {
                if (values.parseTime(s)) |t| {
                    if (!have_dur) {
                        a.duration = t;
                        have_dur = true;
                    } else a.delay = t;
                    continue;
                }
                if (parseTiming(s)) |t| {
                    a.timing = t;
                    continue;
                }
                const t = s.next();
                switch (t.tag) {
                    .number => a.iterations = t.num,
                    .ident => {
                        if (eq(t.text, "infinite")) {
                            a.iterations = std.math.inf(f32);
                        } else if (enumFromIdent(AnimationDirection, t.text)) |d| {
                            if (d == .normal and a.name.len == 0 and false) {} else a.direction = d;
                        } else if (enumFromIdent(AnimationFill, t.text)) |f| {
                            a.fill = f;
                        } else if (enumFromIdent(AnimationPlayState, t.text)) |ps| {
                            a.play_state = ps;
                        } else {
                            a.name = try p.arena.dupe(u8, t.text);
                        }
                    },
                    .string => a.name = try p.arena.dupe(u8, t.text),
                    else => return error.Invalid,
                }
            }
            try list.append(p.arena, a);
            if (!s.eatComma()) break;
        }
        return list.items;
    }

    fn imageList(p: *Parser) ParseError![]const Image {
        const s = p.s;
        var list: std.ArrayList(Image) = .empty;
        if (s.eatIdent("none")) return list.items;
        while (true) {
            try list.append(p.arena, try p.image());
            if (!s.eatComma()) break;
        }
        return list.items;
    }

    fn image(p: *Parser) ParseError!Image {
        const s = p.s;
        const t = s.next();
        switch (t.tag) {
            .url => return .{ .url = try p.arena.dupe(u8, t.text) },
            .ident => if (eq(t.text, "none")) return .none,
            .function => {
                const body = s.functionBody();
                if (eq(t.text, "url")) {
                    var bs = Stream.init(body);
                    const u = bs.next();
                    if (u.tag != .string) return error.Invalid;
                    return .{ .url = try p.arena.dupe(u8, u.text) };
                }
                const g = try p.arena.create(Gradient);
                g.* = try parseGradient(p.arena, t.text, body);
                return .{ .gradient = g };
            },
            else => {},
        }
        return error.Invalid;
    }

    fn filterList(p: *Parser) ParseError![]const Filter {
        const s = p.s;
        var list: std.ArrayList(Filter) = .empty;
        while (!s.atEnd()) {
            const t = s.next();
            if (t.tag != .function) return error.Invalid;
            const body = s.functionBody();
            var bs = Stream.init(body);
            const f: Filter = blk: {
                if (eq(t.text, "blur")) break :blk .{ .blur = values.parseLength(&bs, false) orelse Length{} };
                if (eq(t.text, "brightness")) break :blk .{ .brightness = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "contrast")) break :blk .{ .contrast = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "grayscale")) break :blk .{ .grayscale = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "saturate")) break :blk .{ .saturate = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "invert")) break :blk .{ .invert = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "sepia")) break :blk .{ .sepia = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "opacity")) break :blk .{ .opacity = numOrPct(&bs) orelse 1 };
                if (eq(t.text, "hue-rotate")) break :blk .{ .hue_rotate = values.parseAngle(&bs) orelse 0 };
                if (eq(t.text, "drop-shadow")) {
                    var sub = Parser{ .arena = p.arena, .s = &bs, .out = p.out, .important = false };
                    const l = try sub.shadowList();
                    break :blk .{ .drop_shadow = if (l.len > 0) l[0] else .{} };
                }
                return error.Invalid;
            };
            try list.append(p.arena, f);
        }
        return list.items;
    }

    fn trackList(p: *Parser) ParseError!TrackList {
        const s = p.s;
        var list: std.ArrayList(Track) = .empty;
        var auto_repeat: @FieldType(TrackList, "auto_repeat") = .none;
        while (!s.atEnd() and !(s.peek().tag == .delim and s.peek().delim == '/')) {
            const t = s.peek();
            if (t.tag == .function and eq(t.text, "repeat")) {
                _ = s.next();
                const body = s.functionBody();
                var bs = Stream.init(body);
                var count: usize = 1;
                const c = bs.next();
                if (c.tag == .number) {
                    count = @intFromFloat(@max(1, c.num));
                } else if (c.tag == .ident and eq(c.text, "auto-fill")) {
                    auto_repeat = .fill;
                } else if (c.tag == .ident and eq(c.text, "auto-fit")) {
                    auto_repeat = .fit;
                } else return error.Invalid;
                if (!bs.eatComma()) return error.Invalid;
                var pattern: std.ArrayList(Track) = .empty;
                var sub = Parser{ .arena = p.arena, .s = &bs, .out = p.out, .important = false };
                while (!bs.atEnd()) try pattern.append(p.arena, try sub.track());
                for (0..@min(count, 1000)) |_| try list.appendSlice(p.arena, pattern.items);
                continue;
            }
            if (t.tag == .lbracket) {
                // line names: skipped
                while (!s.atEnd() and s.next().tag != .rbracket) {}
                continue;
            }
            try list.append(p.arena, try p.track());
        }
        if (list.items.len == 0) return error.Invalid;
        return .{ .tracks = list.items, .auto_repeat = auto_repeat };
    }

    fn track(p: *Parser) ParseError!Track {
        const s = p.s;
        const t = s.peek();
        if (t.tag == .dimension and eq(t.text, "fr")) {
            _ = s.next();
            return .{ .fr = t.num };
        }
        if (t.tag == .ident) {
            _ = s.next();
            if (eq(t.text, "auto")) return .auto;
            if (eq(t.text, "min-content")) return .min_content;
            if (eq(t.text, "max-content")) return .max_content;
            return error.Invalid;
        }
        if (t.tag == .function and eq(t.text, "minmax")) {
            _ = s.next();
            const body = s.functionBody();
            var bs = Stream.init(body);
            var sub = Parser{ .arena = p.arena, .s = &bs, .out = p.out, .important = false };
            const mn = try p.arena.create(Track);
            mn.* = try sub.track();
            if (!bs.eatComma()) return error.Invalid;
            const mx = try p.arena.create(Track);
            mx.* = try sub.track();
            return .{ .minmax = .{ .min = mn, .max = mx } };
        }
        return .{ .fixed = try p.length() };
    }

    fn gridLine(p: *Parser) ParseError!GridLine {
        const s = p.s;
        var g: GridLine = .{};
        // start
        if (s.eatIdent("span")) {
            const n = values.parseNumber(s) orelse return error.Invalid;
            g.span = @intFromFloat(@max(1, n));
        } else if (s.eatIdent("auto")) {} else if (values.parseNumber(s)) |n| {
            g.start = @intFromFloat(n);
        } else return error.Invalid;
        if (s.eatDelim('/')) {
            if (s.eatIdent("span")) {
                const n = values.parseNumber(s) orelse return error.Invalid;
                g.span = @intFromFloat(@max(1, n));
            } else if (s.eatIdent("auto")) {} else if (values.parseNumber(s)) |n| {
                g.end = @intFromFloat(n);
            } else return error.Invalid;
        }
        return g;
    }

    fn backgroundShorthand(p: *Parser) ParseError!void {
        const s = p.s;
        var color: ?ColorValue = null;
        var images: std.ArrayList(Image) = .empty;
        var repeat: ?BackgroundRepeat = null;
        var pos: ?Value = null;
        var size: ?Value = null;
        while (!s.atEnd()) {
            if (s.eatComma()) continue;
            if (values.parseColor(s)) |c| {
                color = c;
                continue;
            }
            const t = s.peek();
            if (t.tag == .function or t.tag == .url) {
                try images.append(p.arena, try p.image());
                continue;
            }
            if (t.tag == .ident) {
                if (eq(t.text, "none")) {
                    _ = s.next();
                    continue;
                }
                if (enumFromIdent(BackgroundRepeat, t.text)) |r| {
                    _ = s.next();
                    repeat = r;
                    continue;
                }
                if (eq(t.text, "fixed") or eq(t.text, "scroll") or eq(t.text, "local") or eq(t.text, "border-box") or eq(t.text, "padding-box") or eq(t.text, "content-box")) {
                    _ = s.next();
                    continue;
                }
            }
            if (t.tag == .delim and t.delim == '/') {
                _ = s.next();
                if (s.eatIdent("cover")) size = .{ .bg_size = .cover } else if (s.eatIdent("contain")) size = .{ .bg_size = .contain } else {
                    const w: ?Length = if (s.eatIdent("auto")) null else try p.length();
                    var h: ?Length = w;
                    if (s.eatIdent("auto")) h = null else if (values.parseLength(s, false)) |l| {
                        h = l;
                    }
                    size = .{ .bg_size = .{ .size = .{ .w = w, .h = h } } };
                }
                continue;
            }
            pos = try p.position();
        }
        try p.emit(.background_color, .{ .color = color orelse .{ .rgba = geom.Color.transparent } });
        try p.emit(.background_image, .{ .images = images.items });
        try p.emit(.background_repeat, .{ .enum_val = @intFromEnum(repeat orelse .repeat) });
        try p.emit(.background_position, pos orelse .{ .pair = .{ .a = .{}, .b = .{} } });
        try p.emit(.background_size, size orelse .{ .bg_size = .{ .size = .{ .w = null, .h = null } } });
    }

    fn fontShorthand(p: *Parser) ParseError!void {
        const s = p.s;
        var style: FontStyle = .normal;
        var weight: f32 = 400;
        // system font keywords
        if (s.peek().tag == .ident) {
            const t = s.peek();
            if (eq(t.text, "caption") or eq(t.text, "menu") or eq(t.text, "message-box") or eq(t.text, "status-bar") or eq(t.text, "small-caption") or eq(t.text, "icon")) {
                _ = s.next();
                try p.emit(.font_family, .{ .font_family = &.{"system-ui"} });
                return;
            }
        }
        while (true) {
            const t = s.peek();
            if (t.tag == .ident) {
                if (enumFromIdent(FontStyle, t.text)) |fs| {
                    _ = s.next();
                    if (fs != .normal) style = fs;
                    continue;
                }
                if (eq(t.text, "bold")) {
                    _ = s.next();
                    weight = 700;
                    continue;
                }
                if (eq(t.text, "small-caps")) {
                    _ = s.next();
                    continue;
                }
            }
            if (t.tag == .number and t.num >= 100 and t.num <= 1000) {
                _ = s.next();
                weight = t.num;
                continue;
            }
            break;
        }
        const size = try p.fontSize();
        var lh: Value = .{ .keyword = .normal };
        if (s.eatDelim('/')) {
            if (s.eatIdent("normal")) {} else if (values.parseNumber(s)) |n| {
                lh = .{ .number = n };
            } else lh = .{ .length = try p.length() };
        }
        const fam = try p.fontFamily();
        try p.emit(.font_style, .{ .enum_val = @intFromEnum(style) });
        try p.emit(.font_weight, .{ .number = weight });
        try p.emit(.font_size, size);
        try p.emit(.line_height, lh);
        try p.emit(.font_family, .{ .font_family = fam });
    }
};

fn numOrPct(s: *Stream) ?f32 {
    const t = s.peek();
    if (t.tag == .percentage) {
        _ = s.next();
        return t.num / 100;
    }
    return values.parseNumber(s);
}

fn alignToJustify(a: Align) Justify {
    return switch (a) {
        .auto, .normal => .normal,
        .stretch => .stretch,
        .flex_start => .flex_start,
        .flex_end => .flex_end,
        .start, .self_start => .start,
        .end, .self_end => .end,
        .center => .center,
        .baseline => .start,
        .space_between => .space_between,
        .space_around => .space_around,
        .space_evenly => .space_evenly,
    };
}

fn applyDecoration(d: *TextDecoration, text: []const u8) bool {
    if (eq(text, "underline")) d.underline = true else if (eq(text, "overline")) d.overline = true else if (eq(text, "line-through")) d.line_through = true else if (eq(text, "none")) {} else return false;
    return true;
}

fn styleFor(w: PropId) PropId {
    return switch (w) {
        .border_top_width => .border_top_style,
        .border_right_width => .border_right_style,
        .border_bottom_width => .border_bottom_style,
        .border_left_width => .border_left_style,
        .outline_width => .outline_style,
        else => unreachable,
    };
}
fn colorFor(w: PropId) PropId {
    return switch (w) {
        .border_top_width => .border_top_color,
        .border_right_width => .border_right_color,
        .border_bottom_width => .border_bottom_color,
        .border_left_width => .border_left_color,
        .outline_width => .outline_color,
        else => unreachable,
    };
}

fn eq(a: []const u8, b: []const u8) bool {
    return std.ascii.eqlIgnoreCase(a, b);
}

pub fn keywordName(k: Keyword) []const u8 {
    return switch (k) {
        .min_content => "min-content",
        .max_content => "max-content",
        .fit_content => "fit-content",
        inline else => |kk| @tagName(kk),
    };
}

pub fn parseTiming(s: *Stream) ?Timing {
    const save = s.i;
    const t = s.next();
    if (t.tag == .ident) {
        if (eq(t.text, "linear")) return Timing.linear;
        if (eq(t.text, "ease")) return Timing.ease;
        if (eq(t.text, "ease-in")) return Timing.ease_in;
        if (eq(t.text, "ease-out")) return Timing.ease_out;
        if (eq(t.text, "ease-in-out")) return Timing.ease_in_out;
        if (eq(t.text, "step-start")) return .{ .steps = .{ .n = 1, .jump_start = true } };
        if (eq(t.text, "step-end")) return .{ .steps = .{ .n = 1, .jump_start = false } };
    } else if (t.tag == .function) {
        const body = s.functionBody();
        var bs = Stream.init(body);
        if (eq(t.text, "cubic-bezier")) {
            var v: [4]f32 = undefined;
            for (0..4) |i| {
                if (i > 0) _ = bs.eatComma();
                v[i] = values.parseNumber(&bs) orelse {
                    s.i = save;
                    return null;
                };
            }
            return .{ .cubic = v };
        }
        if (eq(t.text, "steps")) {
            const n = values.parseNumber(&bs) orelse 1;
            var start = false;
            if (bs.eatComma()) start = bs.eatIdent("start") or bs.eatIdent("jump-start");
            return .{ .steps = .{ .n = @intFromFloat(@max(1, n)), .jump_start = start } };
        }
        if (eq(t.text, "linear")) return Timing.linear;
    }
    s.i = save;
    return null;
}

pub fn parseGradient(arena: Allocator, name: []const u8, body: []const Token) ParseError!Gradient {
    var g: Gradient = .{ .stops = &.{} };
    var fname = name;
    if (std.ascii.startsWithIgnoreCase(fname, "repeating-")) {
        g.repeating = true;
        fname = fname["repeating-".len..];
    }
    if (eq(fname, "linear-gradient")) g.kind = .linear else if (eq(fname, "radial-gradient")) g.kind = .radial else if (eq(fname, "conic-gradient")) g.kind = .conic else return error.Invalid;
    var parts: [64][]const Token = undefined;
    const n = Stream.splitCommas(body, &parts);
    if (n > parts.len or n == 0) return error.Invalid;
    var first: usize = 0;
    // optional direction / shape
    {
        var s = Stream.init(parts[0]);
        if (g.kind == .linear) {
            if (values.parseAngle(&s)) |a| {
                g.angle = a;
                first = 1;
            } else if (s.eatIdent("to")) {
                var x: i8 = 0;
                var y: i8 = 0;
                while (!s.atEnd()) {
                    const t = s.next();
                    if (t.tag != .ident) return error.Invalid;
                    if (eq(t.text, "left")) x = -1 else if (eq(t.text, "right")) x = 1 else if (eq(t.text, "top")) y = -1 else if (eq(t.text, "bottom")) y = 1 else return error.Invalid;
                }
                if (x != 0 and y != 0) {
                    g.to_corner = .{ .x = x, .y = y };
                } else {
                    g.angle = if (y == -1) 0 else if (x == 1) std.math.pi / 2.0 else if (y == 1) std.math.pi else 3 * std.math.pi / 2.0;
                }
                first = 1;
            }
        } else {
            var consumed = false;
            while (!s.atEnd()) {
                const t = s.peek();
                if (t.tag == .ident and eq(t.text, "circle")) {
                    g.circle = true;
                } else if (t.tag == .ident and (eq(t.text, "ellipse") or eq(t.text, "farthest-corner") or eq(t.text, "closest-side") or eq(t.text, "closest-corner") or eq(t.text, "farthest-side"))) {} else if (t.tag == .ident and eq(t.text, "from")) {
                    _ = s.next();
                    g.angle = values.parseAngle(&s) orelse 0;
                    consumed = true;
                    continue;
                } else if (t.tag == .ident and eq(t.text, "at")) {
                    _ = s.next();
                    var pp = Parser{ .arena = arena, .s = &s, .out = undefined, .important = false };
                    const pos = try pp.position();
                    g.cx = pos.pair.a;
                    g.cy = pos.pair.b;
                    consumed = true;
                    continue;
                } else if (values.parseColor(&s) != null) {
                    break;
                } else {
                    // explicit size: ignored
                    if (values.parseLength(&s, false) == null) break;
                    consumed = true;
                    continue;
                }
                _ = s.next();
                consumed = true;
            }
            if (consumed and values.parseColor(&s) == null) first = 1;
        }
    }
    var stops: std.ArrayList(GradientStop) = .empty;
    for (parts[first..n]) |part| {
        var s = Stream.init(part);
        const c = values.parseColor(&s) orelse {
            // color hint (bare position): ignored
            continue;
        };
        const pos1 = values.parseLength(&s, false) orelse (if (values.parseAngle(&s)) |a| Length{ .pct = a / (2 * std.math.pi) } else null);
        try stops.append(arena, .{ .color = c, .pos = pos1 });
        if (values.parseLength(&s, false)) |pos2| try stops.append(arena, .{ .color = c, .pos = pos2 });
    }
    if (stops.items.len == 0) return error.Invalid;
    g.stops = stops.items;
    return g;
}

/// Decode CSS escapes like "\f101" in content strings.
pub fn decodeCssEscapes(arena: Allocator, s: []const u8) ![]const u8 {
    if (std.mem.indexOfScalar(u8, s, '\\') == null) return arena.dupe(u8, s);
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == '\\' and i + 1 < s.len) {
            var j = i + 1;
            var cp: u21 = 0;
            var nd: usize = 0;
            while (j < s.len and nd < 6) : (j += 1) {
                const d = std.fmt.charToDigit(s[j], 16) catch break;
                cp = cp * 16 + d;
                nd += 1;
            }
            if (nd > 0) {
                if (j < s.len and s[j] == ' ') j += 1;
                var buf: [4]u8 = undefined;
                const len = std.unicode.utf8Encode(cp, &buf) catch 0;
                try out.appendSlice(arena, buf[0..len]);
                i = j;
            } else {
                try out.append(arena, s[i + 1]);
                i += 2;
            }
        } else {
            try out.append(arena, s[i]);
            i += 1;
        }
    }
    return out.items;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

fn testParse(arena: Allocator, name: []const u8, src: []const u8) !std.ArrayList(Declaration) {
    var toks = try tok.tokenizeAll(arena, src);
    _ = &toks;
    var out: std.ArrayList(Declaration) = .empty;
    try parseDeclaration(arena, name, toks.items[0 .. toks.items.len - 1], src, false, &out);
    return out;
}

test "shorthand expansion" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const m = try testParse(a, "margin", "4px auto");
    try std.testing.expectEqual(@as(usize, 4), m.items.len);
    try std.testing.expectEqual(PropId.margin_right, m.items[1].prop);
    try std.testing.expectEqual(Keyword.auto, m.items[1].value.keyword);
    try std.testing.expectEqual(@as(f32, 4), m.items[2].value.length.px);

    const b = try testParse(a, "border", "1px solid #ccc");
    try std.testing.expectEqual(@as(usize, 12), b.items.len);

    const f = try testParse(a, "flex", "1");
    try std.testing.expectEqual(@as(f32, 1), f.items[0].value.number);
    try std.testing.expectEqual(@as(f32, 0), f.items[2].value.length.px);

    const t = try testParse(a, "transition", "opacity 200ms ease-out, transform .3s");
    try std.testing.expectEqual(@as(usize, 4), t.items.len);
    try std.testing.expectEqual(@as(?PropId, .transform), t.items[0].value.transition_props[1]);
    try std.testing.expectEqual(@as(f32, 0.3), t.items[1].value.times[1]);

    const v = try testParse(a, "padding", "var(--pad) 2px");
    try std.testing.expectEqual(PropId.padding, v.items[0].prop);
    try std.testing.expectEqualStrings("var(--pad) 2px", v.items[0].value.raw);

    const fnt = try testParse(a, "font", "italic bold 12px/1.5 \"Helvetica Neue\", Arial, sans-serif");
    try std.testing.expectEqual(@as(usize, 5), fnt.items.len);
    try std.testing.expectEqual(@as(usize, 3), fnt.items[4].value.font_family.len);

    const g = try testParse(a, "background", "linear-gradient(to right, #fff 0%, rgba(0,0,0,.5) 100%)");
    try std.testing.expectEqual(@as(usize, 2), g.items[1].value.images[0].gradient.stops.len);

    const sh = try testParse(a, "box-shadow", "0 1px 3px rgba(0,0,0,.1), inset 0 0 0 1px red");
    try std.testing.expectEqual(@as(usize, 2), sh.items[0].value.shadows.len);
    try std.testing.expect(sh.items[0].value.shadows[1].inset);

    const gt = try testParse(a, "grid-template-columns", "repeat(3, minmax(0, 1fr)) 200px");
    try std.testing.expectEqual(@as(usize, 4), gt.items[0].value.tracks.tracks.len);

    const tr = try testParse(a, "transform", "translate(-50%, 10px) rotate(45deg) scale(1.5)");
    try std.testing.expectEqual(@as(usize, 3), tr.items[0].value.transform.len);

    try std.testing.expectError(error.Invalid, testParse(a, "width", "banana"));
    try std.testing.expectError(error.Invalid, testParse(a, "not-a-prop", "1px"));
}
