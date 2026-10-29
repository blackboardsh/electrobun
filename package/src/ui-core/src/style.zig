//! Style engine: selector matching, the cascade (origins, layers, specificity,
//! !important, inline styles), custom properties with var() substitution,
//! inheritance, and computed values. Computed styles live on each node.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const atom_mod = @import("atom.zig");
const tok = @import("css/tokenizer.zig");
const values = @import("css/values.zig");
const props = @import("css/properties.zig");
const sel_mod = @import("css/selector.zig");
const sheet_mod = @import("css/stylesheet.zig");

const Allocator = std.mem.Allocator;
const Document = dom.Document;
const Node = dom.Node;
const NodeId = dom.NodeId;
const null_id = dom.null_id;
const Atom = atom_mod.Atom;
const Color = geom.Color;
const LengthPct = values.LengthPct;
const Length = values.Length;
const Selector = sel_mod.Selector;
const Compound = sel_mod.Compound;
const Declaration = props.Declaration;
const PropId = props.PropId;

pub const ua_css = @embedFile("ua.css");

// ---------------------------------------------------------------------------
// Computed style
// ---------------------------------------------------------------------------

pub const LenAuto = union(enum) {
    auto,
    len: LengthPct,

    pub fn isAuto(l: LenAuto) bool {
        return l == .auto;
    }
    pub fn resolve(l: LenAuto, basis: f32) ?f32 {
        return switch (l) {
            .auto => null,
            .len => |v| v.resolve(basis),
        };
    }
};

pub const SizeVal = union(enum) {
    auto,
    none,
    len: LengthPct,
    min_content,
    max_content,
    fit_content,

    pub fn resolve(s: SizeVal, basis: ?f32) ?f32 {
        return switch (s) {
            .len => |v| if (v.pct != 0 and basis == null) null else v.resolve(basis orelse 0),
            else => null,
        };
    }
    pub fn isDefinite(s: SizeVal, basis: ?f32) bool {
        return s.resolve(basis) != null;
    }
};

pub const LineHeight = union(enum) {
    normal,
    number: f32,
    px: f32,

    pub fn resolve(l: LineHeight, font_size: f32, normal_factor: f32) f32 {
        return switch (l) {
            .normal => font_size * normal_factor,
            .number => |n| font_size * n,
            .px => |p| p,
        };
    }
};

/// A shadow with lengths resolved to pixels.
pub const Shadow = struct {
    x: f32 = 0,
    y: f32 = 0,
    blur: f32 = 0,
    spread: f32 = 0,
    color: Color = .{},
    inset: bool = false,
};

pub const TransformOp = union(enum) {
    translate: struct { x: LengthPct, y: LengthPct },
    scale: struct { x: f32, y: f32 },
    rotate: f32,
    skew: struct { x: f32, y: f32 },
    matrix: geom.Transform,
};

pub const Filter = union(enum) {
    blur: f32,
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

pub const GradientStop = struct {
    color: Color,
    pos: ?LengthPct,
};

pub const Gradient = struct {
    kind: @FieldType(props.Gradient, "kind"),
    angle: f32,
    to_corner: ?struct { x: i8, y: i8 },
    circle: bool,
    cx: LengthPct,
    cy: LengthPct,
    repeating: bool,
    stops: []const GradientStop,
};

pub const Image = union(enum) {
    url: []const u8,
    gradient: Gradient,
};

pub const Style = struct {
    // box
    display: props.Display = .inline_,
    position: props.Position = .static,
    box_sizing: props.BoxSizing = .content_box,
    inset: [4]LenAuto = .{ .auto, .auto, .auto, .auto }, // top right bottom left
    width: SizeVal = .auto,
    height: SizeVal = .auto,
    min_width: SizeVal = .auto,
    min_height: SizeVal = .auto,
    max_width: SizeVal = .none,
    max_height: SizeVal = .none,
    aspect_ratio: ?f32 = null,
    margin: [4]LenAuto = .{ zeroLA(), zeroLA(), zeroLA(), zeroLA() },
    padding: [4]LengthPct = .{ .{}, .{}, .{}, .{} },
    border_width: [4]f32 = .{ 3, 3, 3, 3 }, // used widths are 0 unless style != none (see borderWidths)
    border_style: [4]props.BorderStyle = .{ .none, .none, .none, .none },
    border_color: [4]Color = .{ .{}, .{}, .{}, .{} },
    radius: [4]LengthPct = .{ .{}, .{}, .{}, .{} }, // tl tr br bl
    // flex / grid
    flex_direction: props.FlexDirection = .row,
    flex_wrap: props.FlexWrap = .nowrap,
    flex_grow: f32 = 0,
    flex_shrink: f32 = 1,
    flex_basis: SizeVal = .auto,
    order: i32 = 0,
    justify_content: props.Justify = .normal,
    justify_items: props.Justify = .normal,
    justify_self: props.Justify = .normal,
    align_items: props.Align = .normal,
    align_self: props.Align = .auto,
    align_content: props.Align = .normal,
    row_gap: LengthPct = .{},
    column_gap: LengthPct = .{},
    grid_template_columns: props.TrackList = .{},
    grid_template_rows: props.TrackList = .{},
    grid_auto_columns: props.TrackList = .{},
    grid_auto_rows: props.TrackList = .{},
    grid_auto_flow: props.GridAutoFlow = .row,
    grid_column: props.GridLine = .{},
    grid_row: props.GridLine = .{},
    overflow_x: props.Overflow = .visible,
    overflow_y: props.Overflow = .visible,
    z_index: ?i32 = null,
    vertical_align: props.VerticalAlign = .baseline,
    // visual
    color: Color = Color.black,
    background_color: Color = .{},
    background_image: []const Image = &.{},
    background_size: props.BackgroundSize = .{ .size = .{ .w = null, .h = null } },
    background_position: [2]LengthPct = .{ .{}, .{} },
    background_repeat: props.BackgroundRepeat = .repeat,
    background_clip: props.BackgroundClip = .border_box,
    opacity: f32 = 1,
    visibility: props.Visibility = .visible,
    box_shadow: []const Shadow = &.{},
    transform: []const TransformOp = &.{},
    transform_origin: [2]LengthPct = .{ .{ .pct = 0.5 }, .{ .pct = 0.5 } },
    translate: ?[2]LengthPct = null,
    scale: ?[2]f32 = null,
    rotate: ?f32 = null,
    outline_width: f32 = 3,
    outline_style: props.BorderStyle = .none,
    outline_color: Color = Color.black,
    outline_offset: f32 = 0,
    cursor: props.Cursor = .auto,
    pointer_events: props.PointerEvents = .auto,
    user_select: props.UserSelect = .auto,
    object_fit: props.ObjectFit = .fill,
    filter: []const Filter = &.{},
    backdrop_filter: []const Filter = &.{},
    // text
    font_family: []const []const u8 = &.{"system-ui"},
    font_size: f32 = 16,
    font_weight: f32 = 400,
    font_style: props.FontStyle = .normal,
    line_height: LineHeight = .normal,
    letter_spacing: f32 = 0,
    word_spacing: f32 = 0,
    text_align: props.TextAlign = .start,
    text_decoration: props.TextDecoration = .{},
    text_decoration_color: Color = Color.black,
    text_transform: props.TextTransform = .none,
    text_overflow: props.TextOverflow = .clip,
    text_indent: LengthPct = .{},
    text_shadow: []const Shadow = &.{},
    white_space: props.WhiteSpace = .normal,
    word_break: props.WordBreak = .normal,
    overflow_wrap: props.OverflowWrap = .normal,
    line_clamp: ?u32 = null,
    tab_size: f32 = 8,
    caret_color: ?Color = null,
    accent_color: ?Color = null,
    list_style_type: props.ListStyleType = .disc,
    content: ?[]const u8 = null,
    // animation
    transitions: []const props.Transition = &.{},
    animations: []const props.Animation = &.{},
    // misc
    app_region: props.AppRegion = .none,
    resize: props.Resize = .none,
    scroll_behavior: props.ScrollBehavior = .auto,
    /// custom properties visible to this element
    customs: ?*const CustomMap = null,

    pub fn borderWidths(s: *const Style) geom.Edges {
        return .{
            .top = if (hasBorder(s.border_style[0])) s.border_width[0] else 0,
            .right = if (hasBorder(s.border_style[1])) s.border_width[1] else 0,
            .bottom = if (hasBorder(s.border_style[2])) s.border_width[2] else 0,
            .left = if (hasBorder(s.border_style[3])) s.border_width[3] else 0,
        };
    }
    pub fn isFlexContainer(s: *const Style) bool {
        return s.display == .flex or s.display == .inline_flex;
    }
    pub fn isGridContainer(s: *const Style) bool {
        return s.display == .grid or s.display == .inline_grid;
    }
    pub fn isInlineLevel(s: *const Style) bool {
        return s.display == .inline_ or s.display == .inline_block or s.display == .inline_flex or s.display == .inline_grid;
    }
    pub fn isOutOfFlow(s: *const Style) bool {
        return s.position == .absolute or s.position == .fixed;
    }
    pub fn isScrollContainer(s: *const Style) bool {
        return s.overflow_x == .scroll or s.overflow_x == .auto or s.overflow_y == .scroll or s.overflow_y == .auto or s.overflow_x == .hidden or s.overflow_y == .hidden;
    }
    pub fn clipsContent(s: *const Style) bool {
        return s.overflow_x != .visible or s.overflow_y != .visible;
    }
    pub fn isRow(s: *const Style) bool {
        return s.flex_direction == .row or s.flex_direction == .row_reverse;
    }
    pub fn hasTransform(s: *const Style) bool {
        return s.transform.len > 0 or s.translate != null or s.scale != null or s.rotate != null;
    }
    pub fn lineHeightPx(s: *const Style) f32 {
        return s.line_height.resolve(s.font_size, 1.2);
    }
};

fn zeroLA() LenAuto {
    return .{ .len = .{} };
}

fn hasBorder(b: props.BorderStyle) bool {
    return b != .none and b != .hidden;
}

pub const CustomMap = struct {
    parent: ?*const CustomMap,
    owner: NodeId,
    names: []const []const u8,
    vals: []const []const u8,

    pub fn lookup(m: *const CustomMap, name: []const u8, self_id: NodeId, registry: *const Registry) ?[]const u8 {
        const reg = registry.get(name);
        const inherits = if (reg) |r| r.inherits else true;
        var cur: ?*const CustomMap = m;
        while (cur) |c| : (cur = c.parent) {
            if (!inherits and c.owner != self_id) break;
            var i = c.names.len;
            while (i > 0) {
                i -= 1;
                if (std.mem.eql(u8, c.names[i], name)) return c.vals[i];
            }
        }
        if (reg) |r| return r.initial;
        return null;
    }
};

pub const Registry = struct {
    map: std.StringHashMapUnmanaged(sheet_mod.PropertyRegistration) = .empty,
    pub fn get(r: *const Registry, name: []const u8) ?sheet_mod.PropertyRegistration {
        return r.map.get(name);
    }
};

/// Per-node style storage: the element style plus generated pseudo-element styles.
pub const NodeStyle = struct {
    s: Style,
    arena: std.heap.ArenaAllocator,
    before: ?*Style = null,
    after: ?*Style = null,
    placeholder: ?*Style = null,
    marker: ?*Style = null,
    /// keyframe animation names currently applied (for animation restarts)
    generation: u32 = 0,
};

pub fn get(n: *const Node) ?*NodeStyle {
    return @ptrCast(@alignCast(n.style));
}

/// Computed style of a node. Text nodes have an anonymous style holding the
/// inherited properties of their parent.
pub fn of(doc: *const Document, id: NodeId) *const Style {
    var n = doc.node(id);
    if (get(n)) |ns| return &ns.s;
    if (n.kind != .element and n.parent != null_id) {
        n = doc.node(n.parent);
        if (get(n)) |ns| return &ns.s;
    }
    return &default_style;
}

pub const default_style: Style = .{};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const RuleRef = struct {
    decls: []const Declaration,
    sel: *const Selector,
    specificity: u32,
    order: u32,
    layer_rank: u32,
    media: []const *const sheet_mod.MediaQuery,
    ua: bool,
    pseudo: sel_mod.PseudoElement,
};

pub const Engine = struct {
    gpa: Allocator,
    ua_sheet: ?*sheet_mod.Stylesheet = null,
    by_id: std.AutoHashMapUnmanaged(Atom, std.ArrayList(RuleRef)) = .empty,
    by_class: std.AutoHashMapUnmanaged(Atom, std.ArrayList(RuleRef)) = .empty,
    by_tag: std.AutoHashMapUnmanaged(Atom, std.ArrayList(RuleRef)) = .empty,
    universal: std.ArrayList(RuleRef) = .empty,
    keyframes: std.StringHashMapUnmanaged(*const sheet_mod.Keyframes) = .empty,
    registry: Registry = .{},
    font_faces: std.ArrayList(sheet_mod.FontFace) = .empty,
    env: sheet_mod.MediaEnv = .{},
    env_dirty: bool = true,
    root_font_size: f32 = 16,
    has_pseudo_rules: bool = false,
    /// called when a node's computed style changes (old may be null)
    on_style_change: ?*const fn (ctx: ?*anyopaque, doc: *Document, id: NodeId, old: ?*const Style, new: *const Style) void = null,
    on_style_change_ctx: ?*anyopaque = null,
    scratch: std.ArrayList(Match) = .empty,
    restyled: u32 = 0,

    pub fn init(gpa: Allocator) Engine {
        return .{ .gpa = gpa };
    }

    pub fn deinit(e: *Engine) void {
        e.clearIndex();
        e.by_id.deinit(e.gpa);
        e.by_class.deinit(e.gpa);
        e.by_tag.deinit(e.gpa);
        e.universal.deinit(e.gpa);
        e.keyframes.deinit(e.gpa);
        e.registry.map.deinit(e.gpa);
        e.font_faces.deinit(e.gpa);
        e.scratch.deinit(e.gpa);
        if (e.ua_sheet) |s| {
            s.deinit();
            e.gpa.destroy(s);
        }
    }

    pub fn setEnv(e: *Engine, env: sheet_mod.MediaEnv) void {
        if (std.meta.eql(env, e.env)) return;
        e.env = env;
        e.env_dirty = true;
    }

    fn clearIndex(e: *Engine) void {
        inline for (.{ &e.by_id, &e.by_class, &e.by_tag }) |m| {
            var it = m.valueIterator();
            while (it.next()) |l| l.deinit(e.gpa);
            m.clearRetainingCapacity();
        }
        e.universal.clearRetainingCapacity();
        e.keyframes.clearRetainingCapacity();
        e.registry.map.clearRetainingCapacity();
        e.font_faces.clearRetainingCapacity();
    }

    fn rebuildIndex(e: *Engine, doc: *Document) !void {
        e.clearIndex();
        if (e.ua_sheet == null) e.ua_sheet = try sheet_mod.parse(e.gpa, &doc.interner, ua_css);
        // global layer ordering (layers with the same name merge across sheets)
        var layer_names: std.ArrayList([]const u8) = .empty;
        defer layer_names.deinit(e.gpa);
        for (doc.sheets.items) |s| {
            for (s.layer_names.items) |n| {
                const found = for (layer_names.items) |x| {
                    if (std.mem.eql(u8, x, n)) break true;
                } else false;
                if (!found) try layer_names.append(e.gpa, n);
            }
        }
        var sens: dom.Sensitivity = .{ .ancestor_states = 0, .ancestor_attrs = false, .siblings = false, .has = false };
        e.has_pseudo_rules = false;
        var order_base: u32 = 0;
        const all = [_]?*sheet_mod.Stylesheet{e.ua_sheet};
        for (all) |ua| try e.indexSheet(ua.?, true, &layer_names, order_base, &sens);
        order_base += 1 << 24;
        for (doc.sheets.items) |s| {
            try e.indexSheet(s, false, &layer_names, order_base, &sens);
            order_base += 1 << 24;
            for (s.keyframes.items) |*k| try e.keyframes.put(e.gpa, k.name, k);
            for (s.properties.items) |p| try e.registry.map.put(e.gpa, p.name, p);
            try e.font_faces.appendSlice(e.gpa, s.font_faces.items);
        }
        doc.sensitivity = sens;
    }

    fn indexSheet(e: *Engine, s: *sheet_mod.Stylesheet, ua: bool, layer_names: *std.ArrayList([]const u8), order_base: u32, sens: *dom.Sensitivity) !void {
        for (s.rules.items) |*rule| {
            if (rule.decls.len == 0) continue;
            var rank: u32 = 0xffff;
            if (rule.layer != sheet_mod.unlayered) {
                const name = s.layer_names.items[rule.layer];
                for (layer_names.items, 0..) |n, i| {
                    if (std.mem.eql(u8, n, name)) {
                        rank = @intCast(i);
                        break;
                    }
                }
            }
            for (rule.selectors) |*sel| {
                noteSensitivity(sel, sens);
                const subj = sel.subject();
                const ref: RuleRef = .{
                    .decls = rule.decls,
                    .sel = sel,
                    .specificity = sel.specificity,
                    .order = order_base + rule.order,
                    .layer_rank = rank,
                    .media = rule.media,
                    .ua = ua,
                    .pseudo = subj.pseudo_element,
                };
                if (subj.pseudo_element != .none) e.has_pseudo_rules = true;
                if (subj.id != atom_mod.none) {
                    try addTo(e.gpa, &e.by_id, subj.id, ref);
                } else if (subj.classes.len > 0) {
                    try addTo(e.gpa, &e.by_class, subj.classes[0], ref);
                } else if (subj.tag != atom_mod.none) {
                    try addTo(e.gpa, &e.by_tag, subj.tag, ref);
                } else {
                    try e.universal.append(e.gpa, ref);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Restyle
    // -----------------------------------------------------------------------

    /// Recompute styles for every dirty node. Returns true if anything changed.
    pub fn update(e: *Engine, doc: *Document) !bool {
        // A partial pass leaves styles still pointing into retired data that
        // a later pass might not revisit: recompute everything next time.
        errdefer doc.markAllStyleDirty();
        if (doc.sheets_dirty or e.ua_sheet == null) {
            try e.rebuildIndex(doc);
            doc.sheets_dirty = false;
            doc.markAllStyleDirty();
        }
        if (e.env_dirty) {
            e.env_dirty = false;
            doc.markAllStyleDirty();
        }
        const root = doc.node(doc.root);
        if (!root.flags.style_dirty and !root.flags.child_style_dirty) return false;
        e.restyled = 0;
        root.flags.style_dirty = false;
        root.flags.child_style_dirty = false;
        root.flags.force_subtree = false;
        var c = root.first_child;
        while (c != null_id) : (c = doc.node(c).next) try e.visit(doc, c, null, false, false);
        return e.restyled > 0;
    }

    /// `force`: recompute this node. `deep`: recompute the whole subtree (an
    /// ancestor's selector-visible state changed).
    fn visit(e: *Engine, doc: *Document, id: NodeId, parent: ?*const NodeStyle, force: bool, deep: bool) Allocator.Error!void {
        const n = doc.node(id);
        if (n.kind != .element) {
            // text nodes get an anonymous-box style: inherited values only
            if (n.kind == .text and (force or deep or n.flags.style_dirty or n.style == null)) {
                if (parent) |p| {
                    // updated in place: inline layouts cache pointers to it
                    const ns = get(n) orelse blk: {
                        const fresh = try e.gpa.create(NodeStyle);
                        fresh.* = .{ .s = .{}, .arena = std.heap.ArenaAllocator.init(e.gpa) };
                        n.style = fresh;
                        break :blk fresh;
                    };
                    ns.s = inheritFrom(&p.s);
                    ns.s.display = .inline_;
                }
            }
            n.flags.style_dirty = false;
            n.flags.child_style_dirty = false;
            n.flags.force_subtree = false;
            return;
        }
        const needs = force or deep or n.flags.style_dirty;
        const child_deep = deep or n.flags.force_subtree;
        var child_force = false;
        if (needs) {
            const old = get(n);
            // reserve first so retiring the replaced arena below cannot fail
            if (old != null) try doc.reserveRetired(1);
            const fresh = try e.computeNode(doc, id, if (parent) |p| &p.s else null);
            if (doc.documentElement() == id) e.root_font_size = fresh.s.font_size;
            // Children always recompute: they shallow-copy inherited slices
            // (font_family, text_shadow, custom properties) out of this
            // node's arena, which is replaced below. Their old styles keep
            // pointing into the replaced arena (layoutEqual and
            // on_style_change read them), so it is retired, not freed.
            child_force = true;
            const layout_changed = if (old) |o| !layoutEqual(&o.s, &fresh.s) or hasPseudo(o) or hasPseudo(fresh) else true;
            if (layout_changed) {
                n.flags.layout_dirty = true;
                n.flags.text_dirty = true;
                doc.markLayoutDirty(id);
            }
            if (e.on_style_change) |cb| cb(e.on_style_change_ctx, doc, id, if (old) |o| &o.s else null, &fresh.s);
            if (old) |o| {
                // Keep the NodeStyle address stable: inline layouts cache
                // *Style pointers and are reused when layout is unchanged.
                // Pseudo styles live in the arena, so their presence above
                // forces a relayout that drops those cached pointers (and
                // until then the retired arena keeps them valid).
                o.s = fresh.s;
                o.before = fresh.before;
                o.after = fresh.after;
                o.placeholder = fresh.placeholder;
                o.marker = fresh.marker;
                std.mem.swap(std.heap.ArenaAllocator, &o.arena, &fresh.arena);
                doc.retire(fresh, retiredNodeStyleFree);
            } else n.style = fresh;
            e.restyled += 1;
            doc.needs_paint = true;
        }
        const recurse = needs or n.flags.child_style_dirty;
        n.flags.style_dirty = false;
        n.flags.child_style_dirty = false;
        n.flags.force_subtree = false;
        if (recurse) {
            const me = get(n).?;
            var c = n.first_child;
            while (c != null_id) : (c = doc.node(c).next) try e.visit(doc, c, me, child_force, child_deep);
        }
    }

    fn computeNode(e: *Engine, doc: *Document, id: NodeId, parent: ?*const Style) Allocator.Error!*NodeStyle {
        const ns = try e.gpa.create(NodeStyle);
        ns.* = .{ .s = .{}, .arena = std.heap.ArenaAllocator.init(e.gpa) };
        errdefer destroyNodeStyle(e.gpa, ns);
        const a = ns.arena.allocator();

        e.scratch.clearRetainingCapacity();
        try e.collect(doc, id, .none);
        var computer = Computer{ .e = e, .doc = doc, .id = id, .arena = a, .parent = parent };
        ns.s = try computer.compute(e.scratch.items, doc.node(id).inline_decls.items);
        if (e.has_pseudo_rules) {
            inline for (.{ .{ sel_mod.PseudoElement.before, "before" }, .{ sel_mod.PseudoElement.after, "after" }, .{ sel_mod.PseudoElement.placeholder, "placeholder" }, .{ sel_mod.PseudoElement.marker, "marker" } }) |pe| {
                e.scratch.clearRetainingCapacity();
                try e.collect(doc, id, pe[0]);
                if (e.scratch.items.len > 0) {
                    var pc = Computer{ .e = e, .doc = doc, .id = id, .arena = a, .parent = &ns.s, .is_pseudo = true };
                    const ps = try a.create(Style);
                    ps.* = try pc.compute(e.scratch.items, &.{});
                    if ((pe[0] != .before and pe[0] != .after) or (ps.content != null and ps.display != .none)) {
                        @field(ns, pe[1]) = ps;
                    }
                }
            }
        }
        return ns;
    }

    fn collect(e: *Engine, doc: *Document, id: NodeId, pseudo: sel_mod.PseudoElement) !void {
        const n = doc.node(id);
        if (n.id_attr != atom_mod.none) if (e.by_id.get(n.id_attr)) |l| try e.matchList(doc, id, l.items, pseudo);
        for (n.classes.items, 0..) |c, i| {
            // a class listed twice must not match rules twice
            const dup = for (n.classes.items[0..i]) |x| {
                if (x == c) break true;
            } else false;
            if (dup) continue;
            if (e.by_class.get(c)) |l| try e.matchList(doc, id, l.items, pseudo);
        }
        if (e.by_tag.get(n.tag)) |l| try e.matchList(doc, id, l.items, pseudo);
        try e.matchList(doc, id, e.universal.items, pseudo);
        std.mem.sort(Match, e.scratch.items, {}, Match.lessThan);
    }

    fn matchList(e: *Engine, doc: *Document, id: NodeId, list: []const RuleRef, pseudo: sel_mod.PseudoElement) !void {
        for (list) |*r| {
            if (r.pseudo != pseudo) continue;
            var media_ok = true;
            for (r.media) |m| if (!m.matches(e.env)) {
                media_ok = false;
                break;
            };
            if (!media_ok) continue;
            if (!matchSelector(doc, r.sel, id, pseudo, null)) continue;
            try e.scratch.append(e.gpa, .{ .rule = r });
        }
    }
};

fn addTo(gpa: Allocator, m: *std.AutoHashMapUnmanaged(Atom, std.ArrayList(RuleRef)), key: Atom, ref: RuleRef) !void {
    const gop = try m.getOrPut(gpa, key);
    if (!gop.found_existing) gop.value_ptr.* = .empty;
    try gop.value_ptr.append(gpa, ref);
}

fn noteSensitivity(sel: *const Selector, sens: *dom.Sensitivity) void {
    for (sel.combinators) |c| {
        if (c == .next_sibling or c == .subsequent_sibling) sens.siblings = true;
    }
    for (sel.compounds, 0..) |*c, i| {
        const is_subject = i == sel.compounds.len - 1;
        noteCompound(c, is_subject, sens);
    }
}

fn noteCompound(c: *const Compound, is_subject: bool, sens: *dom.Sensitivity) void {
    if (!is_subject and (c.classes.len > 0 or c.id != atom_mod.none or c.attrs.len > 0)) sens.ancestor_attrs = true;
    for (c.pseudos) |p| {
        switch (p) {
            .first_child, .last_child, .only_child, .nth_child, .nth_last_child, .first_of_type, .last_of_type, .only_of_type, .nth_of_type, .nth_last_of_type, .empty => sens.siblings = true,
            .has => sens.has = true,
            .not, .is, .where => |list| for (list) |*s| {
                // nested selectors observe the state of their own compounds
                for (s.compounds, 0..) |*nc, k| noteCompound(nc, is_subject and k == s.compounds.len - 1, sens);
                for (s.combinators) |cb| if (cb == .next_sibling or cb == .subsequent_sibling) {
                    sens.siblings = true;
                };
                if (s.compounds.len > 1) sens.ancestor_attrs = true;
            },
            else => {},
        }
        if (!is_subject) {
            const bit: u16 = switch (p) {
                .hover => 1 << 0,
                .active => 1 << 1,
                .focus => 1 << 2,
                .focus_visible => 1 << 3,
                .focus_within => 1 << 4,
                .checked => 1 << 5,
                .open => 1 << 6,
                .indeterminate => 1 << 7,
                else => 0,
            };
            sens.ancestor_states |= bit;
            if (p == .disabled or p == .enabled) sens.ancestor_attrs = true;
        }
    }
}

const Match = struct {
    rule: *const RuleRef,

    fn lessThan(_: void, a: Match, b: Match) bool {
        // normal-declaration cascade order: UA < author; layers ascending,
        // unlayered last; then specificity; then source order
        const ra = a.rule;
        const rb = b.rule;
        if (ra.ua != rb.ua) return ra.ua;
        if (ra.layer_rank != rb.layer_rank) return ra.layer_rank < rb.layer_rank;
        if (ra.specificity != rb.specificity) return ra.specificity < rb.specificity;
        return ra.order < rb.order;
    }
};

fn hasPseudo(ns: *const NodeStyle) bool {
    return ns.before != null or ns.after != null or ns.placeholder != null or ns.marker != null;
}

pub fn destroyNodeStyle(gpa: Allocator, ns: *NodeStyle) void {
    ns.arena.deinit();
    gpa.destroy(ns);
}

fn retiredNodeStyleFree(gpa: Allocator, ptr: *anyopaque) void {
    destroyNodeStyle(gpa, @ptrCast(@alignCast(ptr)));
}

/// node_finalizer hook for Document. A node moved out of this subtree still
/// inherits from these styles until its next restyle, so they are retired.
pub fn finalizeNode(doc: *Document, n: *Node) void {
    if (get(n)) |ns| doc.retire(ns, retiredNodeStyleFree);
    n.style = null;
}

fn fontFamilyEqual(a: []const []const u8, b: []const []const u8) bool {
    if (a.ptr == b.ptr and a.len == b.len) return true;
    if (a.len != b.len) return false;
    for (a, b) |x, y| if (!std.mem.eql(u8, x, y)) return false;
    return true;
}

fn customsEqual(a: ?*const CustomMap, b: ?*const CustomMap) bool {
    if (a == b) return true;
    const x = a orelse return false;
    const y = b orelse return false;
    if (x.parent != y.parent) return false;
    if (x.names.len != y.names.len) return false;
    for (x.names, y.names, x.vals, y.vals) |n1, n2, v1, v2| {
        if (!std.mem.eql(u8, n1, n2) or !std.mem.eql(u8, v1, v2)) return false;
    }
    return true;
}

/// True when two styles produce identical layout (paint-only differences).
pub fn layoutEqual(a: *const Style, b: *const Style) bool {
    if (a.display != b.display or a.position != b.position or a.box_sizing != b.box_sizing) return false;
    if (!std.meta.eql(a.inset, b.inset) or !std.meta.eql(a.width, b.width) or !std.meta.eql(a.height, b.height)) return false;
    if (!std.meta.eql(a.min_width, b.min_width) or !std.meta.eql(a.min_height, b.min_height)) return false;
    if (!std.meta.eql(a.max_width, b.max_width) or !std.meta.eql(a.max_height, b.max_height)) return false;
    if (!std.meta.eql(a.aspect_ratio, b.aspect_ratio)) return false;
    if (!std.meta.eql(a.margin, b.margin) or !std.meta.eql(a.padding, b.padding)) return false;
    if (!std.meta.eql(a.borderWidths(), b.borderWidths())) return false;
    if (a.flex_direction != b.flex_direction or a.flex_wrap != b.flex_wrap or a.flex_grow != b.flex_grow or a.flex_shrink != b.flex_shrink) return false;
    if (!std.meta.eql(a.flex_basis, b.flex_basis) or a.order != b.order) return false;
    if (a.justify_content != b.justify_content or a.justify_items != b.justify_items or a.justify_self != b.justify_self) return false;
    if (a.align_items != b.align_items or a.align_self != b.align_self or a.align_content != b.align_content) return false;
    if (!std.meta.eql(a.row_gap, b.row_gap) or !std.meta.eql(a.column_gap, b.column_gap)) return false;
    if (!tracksEqual(a.grid_template_columns, b.grid_template_columns) or !tracksEqual(a.grid_template_rows, b.grid_template_rows)) return false;
    if (!tracksEqual(a.grid_auto_columns, b.grid_auto_columns) or !tracksEqual(a.grid_auto_rows, b.grid_auto_rows)) return false;
    if (a.grid_auto_flow != b.grid_auto_flow or !std.meta.eql(a.grid_column, b.grid_column) or !std.meta.eql(a.grid_row, b.grid_row)) return false;
    if (a.overflow_x != b.overflow_x or a.overflow_y != b.overflow_y or a.vertical_align != b.vertical_align) return false;
    if (!fontFamilyEqual(a.font_family, b.font_family) or a.font_size != b.font_size or a.font_weight != b.font_weight or a.font_style != b.font_style) return false;
    if (!std.meta.eql(a.line_height, b.line_height) or a.letter_spacing != b.letter_spacing or a.word_spacing != b.word_spacing) return false;
    if (a.text_align != b.text_align or a.text_transform != b.text_transform or a.text_overflow != b.text_overflow) return false;
    if (!std.meta.eql(a.text_indent, b.text_indent) or a.white_space != b.white_space or a.word_break != b.word_break or a.overflow_wrap != b.overflow_wrap) return false;
    if (!std.meta.eql(a.line_clamp, b.line_clamp) or a.tab_size != b.tab_size or a.list_style_type != b.list_style_type) return false;
    if (!std.meta.eql(a.content != null, b.content != null)) return false;
    if (a.content) |ca| if (!std.mem.eql(u8, ca, b.content.?)) return false;
    if (a.visibility == .collapse or b.visibility == .collapse) {
        if (a.visibility != b.visibility) return false;
    }
    return true;
}

fn tracksEqual(a: props.TrackList, b: props.TrackList) bool {
    if (a.auto_repeat != b.auto_repeat or a.tracks.len != b.tracks.len) return false;
    if (a.tracks.ptr == b.tracks.ptr) return true;
    for (a.tracks, b.tracks) |x, y| if (!trackEqual(x, y)) return false;
    return true;
}

fn trackEqual(a: props.Track, b: props.Track) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    return switch (a) {
        .minmax => |m| trackEqual(m.min.*, b.minmax.min.*) and trackEqual(m.max.*, b.minmax.max.*),
        .fixed => |f| std.meta.eql(f, b.fixed),
        .fr => |f| f == b.fr,
        else => true,
    };
}

// ---------------------------------------------------------------------------
// Selector matching
// ---------------------------------------------------------------------------

fn parentElement(doc: *const Document, id: NodeId) NodeId {
    const p = doc.node(id).parent;
    if (p == null_id) return null_id;
    if (doc.node(p).kind != .element) return null_id;
    return p;
}

fn prevElement(doc: *const Document, id: NodeId) NodeId {
    var c = doc.node(id).prev;
    while (c != null_id) : (c = doc.node(c).prev) if (doc.node(c).kind == .element) return c;
    return null_id;
}

fn nextElement(doc: *const Document, id: NodeId) NodeId {
    var c = doc.node(id).next;
    while (c != null_id) : (c = doc.node(c).next) if (doc.node(c).kind == .element) return c;
    return null_id;
}

pub fn matchSelector(doc: *const Document, sel: *const Selector, id: NodeId, pseudo: sel_mod.PseudoElement, scope: ?NodeId) bool {
    return matchFrom(doc, sel, sel.compounds.len - 1, id, pseudo, scope);
}

fn matchFrom(doc: *const Document, sel: *const Selector, i: usize, id: NodeId, pseudo: sel_mod.PseudoElement, scope: ?NodeId) bool {
    const want_pe = if (i == sel.compounds.len - 1) pseudo else .none;
    if (!matchCompound(doc, &sel.compounds[i], id, want_pe, scope)) return false;
    if (i == 0) return true;
    switch (sel.combinators[i - 1]) {
        .descendant => {
            var a = parentElement(doc, id);
            while (a != null_id) : (a = parentElement(doc, a)) {
                if (matchFrom(doc, sel, i - 1, a, .none, scope)) return true;
            }
            // relative selectors in :has() may anchor at a scope that is the document
            return false;
        },
        .child => {
            const p = parentElement(doc, id);
            return p != null_id and matchFrom(doc, sel, i - 1, p, .none, scope);
        },
        .next_sibling => {
            const p = prevElement(doc, id);
            return p != null_id and matchFrom(doc, sel, i - 1, p, .none, scope);
        },
        .subsequent_sibling => {
            var p = prevElement(doc, id);
            while (p != null_id) : (p = prevElement(doc, p)) {
                if (matchFrom(doc, sel, i - 1, p, .none, scope)) return true;
            }
            return false;
        },
    }
}

fn matchCompound(doc: *const Document, c: *const Compound, id: NodeId, want_pe: sel_mod.PseudoElement, scope: ?NodeId) bool {
    const n = doc.node(id);
    if (n.kind != .element) return false;
    if (c.pseudo_element != want_pe) return false;
    if (c.nesting) {
        // relative-selector anchor (from :has) or an unresolved `&`
        if (scope) |s| {
            if (s != id) return false;
        }
    }
    if (c.tag != atom_mod.none and c.tag != n.tag) return false;
    if (c.id != atom_mod.none and c.id != n.id_attr) return false;
    for (c.classes) |cl| if (!n.hasClass(cl)) return false;
    for (c.attrs) |*a| if (!matchAttr(n, a)) return false;
    for (c.pseudos) |*p| if (!matchPseudo(doc, p, id)) return false;
    return true;
}

fn matchAttr(n: *const Node, a: *const sel_mod.AttrSel) bool {
    const v = n.getAttr(a.name) orelse return false;
    const want = a.value;
    const ci = a.case_insensitive;
    return switch (a.op) {
        .exists => true,
        .eq => strEq(v, want, ci),
        .includes => blk: {
            var it = std.mem.tokenizeAny(u8, v, " \t\n");
            while (it.next()) |w| if (strEq(w, want, ci)) break :blk true;
            break :blk false;
        },
        .dash => strEq(v, want, ci) or (v.len > want.len and v[want.len] == '-' and strEq(v[0..want.len], want, ci)),
        .prefix => want.len > 0 and v.len >= want.len and strEq(v[0..want.len], want, ci),
        .suffix => want.len > 0 and v.len >= want.len and strEq(v[v.len - want.len ..], want, ci),
        .substring => want.len > 0 and (if (ci) std.ascii.findIgnoreCase(v, want) != null else std.mem.indexOf(u8, v, want) != null),
    };
}

fn strEq(a: []const u8, b: []const u8, ci: bool) bool {
    return if (ci) std.ascii.eqlIgnoreCase(a, b) else std.mem.eql(u8, a, b);
}

fn isFormControl(doc: *const Document, n: *const Node) bool {
    const w = &doc.atoms;
    return n.tag == w.input or n.tag == w.button or n.tag == w.select or n.tag == w.textarea or n.tag == w.option or n.tag == doc.interner.lookup("fieldset");
}

fn isDisabled(doc: *const Document, id: NodeId) bool {
    const n = doc.node(id);
    if (!isFormControl(doc, n)) return false;
    if (n.hasAttr(doc.atoms.disabled)) return true;
    // inside a disabled fieldset
    var p = parentElement(doc, id);
    while (p != null_id) : (p = parentElement(doc, p)) {
        const pn = doc.node(p);
        if (doc.interner.lookup("fieldset")) |fs| if (pn.tag == fs and pn.hasAttr(doc.atoms.disabled)) return true;
    }
    return false;
}

fn elementIndex(doc: *const Document, id: NodeId, of_type: bool, from_end: bool) i32 {
    const tag = doc.node(id).tag;
    var idx: i32 = 1;
    var c = if (from_end) nextElement(doc, id) else prevElement(doc, id);
    while (c != null_id) : (c = if (from_end) nextElement(doc, c) else prevElement(doc, c)) {
        if (!of_type or doc.node(c).tag == tag) idx += 1;
    }
    return idx;
}

fn isTextEntry(doc: *const Document, n: *const Node) bool {
    const w = &doc.atoms;
    if (n.tag == w.textarea) return true;
    if (n.tag != w.input) return false;
    const t = n.getAttr(w.type) orelse return true;
    const non_text = [_][]const u8{ "checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "hidden", "image" };
    for (non_text) |x| if (std.ascii.eqlIgnoreCase(t, x)) return false;
    return true;
}

fn matchPseudo(doc: *const Document, p: *const sel_mod.Pseudo, id: NodeId) bool {
    const n = doc.node(id);
    const w = &doc.atoms;
    return switch (p.*) {
        .hover => n.state.hover,
        .active => n.state.active,
        .focus => n.state.focus,
        .focus_visible => n.state.focus_visible,
        .focus_within => n.state.focus_within or n.state.focus,
        .checked => n.state.checked or (n.tag == w.option and n.hasAttr(w.selected)),
        .indeterminate => n.state.indeterminate,
        .open => n.state.open,
        .disabled => isDisabled(doc, id),
        .enabled => isFormControl(doc, n) and !isDisabled(doc, id),
        .required => n.hasAttr(w.required),
        .optional => isFormControl(doc, n) and !n.hasAttr(w.required),
        .read_only => !(isTextEntry(doc, n) and !n.hasAttr(w.readonly) and !isDisabled(doc, id)) and !n.hasAttr(w.contenteditable),
        .read_write => (isTextEntry(doc, n) and !n.hasAttr(w.readonly) and !isDisabled(doc, id)) or n.hasAttr(w.contenteditable),
        .placeholder_shown => isTextEntry(doc, n) and n.hasAttr(w.placeholder) and (n.getAttr(w.value) orelse @as([]const u8, "")).len == 0,
        .first_child => prevElement(doc, id) == null_id,
        .last_child => nextElement(doc, id) == null_id,
        .only_child => prevElement(doc, id) == null_id and nextElement(doc, id) == null_id,
        .first_of_type => elementIndex(doc, id, true, false) == 1,
        .last_of_type => elementIndex(doc, id, true, true) == 1,
        .only_of_type => elementIndex(doc, id, true, false) == 1 and elementIndex(doc, id, true, true) == 1,
        .nth_child => |nth| nth.matches(elementIndex(doc, id, false, false)),
        .nth_last_child => |nth| nth.matches(elementIndex(doc, id, false, true)),
        .nth_of_type => |nth| nth.matches(elementIndex(doc, id, true, false)),
        .nth_last_of_type => |nth| nth.matches(elementIndex(doc, id, true, true)),
        .empty => blk: {
            var c = n.first_child;
            while (c != null_id) : (c = doc.node(c).next) {
                const cn = doc.node(c);
                if (cn.kind == .element) break :blk false;
                if (cn.kind == .text and cn.text.items.len > 0) break :blk false;
            }
            break :blk true;
        },
        .root => parentElement(doc, id) == null_id,
        .scope => parentElement(doc, id) == null_id,
        .link => n.tag == w.a and n.hasAttr(w.href),
        .visited, .target => false,
        .not => |list| blk: {
            for (list) |*s| if (matchSelector(doc, s, id, .none, null)) break :blk false;
            break :blk true;
        },
        .is, .where => |list| blk: {
            for (list) |*s| if (matchSelector(doc, s, id, .none, null)) break :blk true;
            break :blk false;
        },
        .has => |list| blk: {
            for (list) |*s| if (matchHas(doc, s, id)) break :blk true;
            break :blk false;
        },
        .dark, .never => false,
        .always => true,
    };
}

fn matchHas(doc: *const Document, s: *const Selector, id: NodeId) bool {
    const relative = s.compounds.len > 1 and s.compounds[0].nesting and s.compounds[0].tag == atom_mod.none and s.compounds[0].classes.len == 0;
    if (relative and (s.combinators[0] == .next_sibling or s.combinators[0] == .subsequent_sibling)) {
        var c = nextElement(doc, id);
        while (c != null_id) : (c = nextElement(doc, c)) {
            if (matchSelector(doc, s, c, .none, id)) return true;
            if (s.combinators[0] == .next_sibling and s.compounds.len == 2) break;
        }
        return false;
    }
    // descendants
    var cur = doc.node(id).first_child;
    while (cur != null_id) {
        const cn = doc.node(cur);
        if (cn.kind == .element) {
            if (relative) {
                if (matchSelector(doc, s, cur, .none, id)) return true;
            } else {
                // non-relative :has(.x) means descendant .x
                if (matchSelector(doc, s, cur, .none, null)) return true;
            }
        }
        cur = doc.nextInTree(cur, id);
    }
    return false;
}

// ---------------------------------------------------------------------------
// Computing values
// ---------------------------------------------------------------------------

/// Apply declarations (e.g. one @keyframes step) on top of an already
/// computed style. Used by the animation engine.
pub fn applyDeclsTo(e: *Engine, doc: *Document, id: NodeId, base: *const Style, parent: ?*const Style, decls: []const Declaration, arena: Allocator) Allocator.Error!Style {
    var c = Computer{ .e = e, .doc = doc, .id = id, .arena = arena, .parent = parent };
    c.s = base.*;
    c.border_cc = .{ false, false, false, false };
    c.outline_cc = false;
    c.deco_cc = false;
    inline for (.{ Computer.Pass.font, Computer.Pass.rest }) |pass| {
        for (decls) |*d| try c.applyDecl(d, pass);
    }
    c.finish();
    return c.s;
}

const Computer = struct {
    e: *Engine,
    doc: *Document,
    id: NodeId,
    arena: Allocator,
    parent: ?*const Style,
    is_pseudo: bool = false,
    s: Style = .{},
    // pending currentColor-relative colors
    border_cc: [4]bool = .{ true, true, true, true },
    outline_cc: bool = true,
    deco_cc: bool = true,
    // transition longhand lists
    t_props: ?[]const ?PropId = null,
    t_durs: ?[]const f32 = null,
    t_delays: ?[]const f32 = null,
    t_timings: ?[]const props.Timing = null,
    bolder: ?f32 = null,
    custom_names: std.ArrayList([]const u8) = .empty,
    custom_vals: std.ArrayList([]const u8) = .empty,

    fn compute(c: *Computer, matches: []const Match, inline_decls: []const Declaration) Allocator.Error!Style {
        // start from inherited values
        if (c.parent) |p| {
            c.s = inheritFrom(p);
        } else {
            c.s = .{};
        }
        // 1) custom properties, 2) font-size, 3) everything else
        inline for (.{ Pass.custom, Pass.font, Pass.rest }) |pass| {
            // normal: matched rules ascending, then inline
            for (matches) |m| for (m.rule.decls) |*d| if (!d.important) try c.applyDecl(d, pass);
            for (inline_decls) |*d| if (!d.important) try c.applyDecl(d, pass);
            // important: reverse layer order, inline important last
            try c.applyImportant(matches, pass);
            for (inline_decls) |*d| if (d.important) try c.applyDecl(d, pass);
            if (pass == .custom) try c.finishCustoms();
        }
        c.finish();
        return c.s;
    }

    fn applyImportant(c: *Computer, matches: []const Match, pass: Pass) !void {
        // important order: UA important beats author important (ignored here),
        // earlier layers beat later layers, unlayered important is weakest.
        var buf: std.ArrayList(*const RuleRef) = .empty;
        defer buf.deinit(c.e.gpa);
        for (matches) |m| {
            for (m.rule.decls) |d| if (d.important) {
                try buf.append(c.e.gpa, m.rule);
                break;
            };
        }
        std.mem.sort(*const RuleRef, buf.items, {}, struct {
            fn lt(_: void, a: *const RuleRef, b: *const RuleRef) bool {
                if (a.ua != b.ua) return !a.ua;
                if (a.layer_rank != b.layer_rank) return a.layer_rank > b.layer_rank;
                if (a.specificity != b.specificity) return a.specificity < b.specificity;
                return a.order < b.order;
            }
        }.lt);
        for (buf.items) |r| for (r.decls) |*d| if (d.important) try c.applyDecl(d, pass);
    }

    const Pass = enum { custom, font, rest };

    fn applyDecl(c: *Computer, d: *const Declaration, pass: Pass) Allocator.Error!void {
        switch (pass) {
            .custom => {
                if (d.prop == .custom) {
                    var val = d.value.raw;
                    if (std.mem.indexOf(u8, val, "var(") != null) {
                        val = (try c.substitute(val, 0)) orelse return;
                    }
                    try c.custom_names.append(c.arena, d.name);
                    try c.custom_vals.append(c.arena, val);
                }
                return;
            },
            .font => if (d.prop != .font_size and d.prop != .font and d.prop != .font_weight) return,
            .rest => if (d.prop == .custom or d.prop == .font_size or d.prop == .font_weight) return,
        }
        if (d.value == .raw) {
            const substituted = (try c.substitute(d.value.raw, 0)) orelse {
                // invalid at computed-value time: behaves as unset
                for (longhandsOrSelf(d.prop)) |lp| c.applyKeyword(lp, .unset);
                return;
            };
            var list: std.ArrayList(Declaration) = .empty;
            const toks = try tok.tokenizeAll(c.arena, substituted);
            const name = propName(d.prop);
            props.parseDeclaration(c.arena, name, toks.items[0 .. toks.items.len - 1], substituted, d.important, &list) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.Invalid => {
                    for (longhandsOrSelf(d.prop)) |lp| c.applyKeyword(lp, .unset);
                    return;
                },
            };
            for (list.items) |*sub| {
                if (pass == .font and sub.prop != .font_size and sub.prop != .font_weight) continue;
                if (pass == .rest and (sub.prop == .font_size or sub.prop == .font_weight)) continue;
                try c.apply(sub);
            }
            return;
        }
        if (pass == .font and d.prop == .font) return; // font shorthand is expanded at parse time
        try c.apply(d);
    }

    fn finishCustoms(c: *Computer) !void {
        const parent_map = if (c.parent) |p| p.customs else null;
        if (c.custom_names.items.len == 0) {
            c.s.customs = parent_map;
            return;
        }
        const m = try c.arena.create(CustomMap);
        m.* = .{ .parent = parent_map, .owner = c.id, .names = c.custom_names.items, .vals = c.custom_vals.items };
        c.s.customs = m;
    }

    fn lookupVar(c: *Computer, name: []const u8) ?[]const u8 {
        // during the custom pass, earlier declarations on this element are visible
        var i = c.custom_names.items.len;
        while (i > 0) {
            i -= 1;
            if (std.mem.eql(u8, c.custom_names.items[i], name)) return c.custom_vals.items[i];
        }
        const m = c.s.customs orelse (if (c.parent) |p| p.customs else null);
        if (m) |map| return map.lookup(name, c.id, &c.e.registry);
        if (c.e.registry.get(name)) |r| return r.initial;
        return null;
    }

    /// Replace var()/env() references. Returns null when a reference cannot be
    /// resolved and has no fallback (invalid at computed-value time).
    fn substitute(c: *Computer, src: []const u8, depth: u8) Allocator.Error!?[]const u8 {
        if (depth > 16) return null;
        var out: std.ArrayList(u8) = .empty;
        var i: usize = 0;
        while (i < src.len) {
            const is_var = std.mem.startsWith(u8, src[i..], "var(");
            const is_env = std.mem.startsWith(u8, src[i..], "env(");
            if ((is_var or is_env) and (i == 0 or !isIdentChar(src[i - 1]))) {
                const open = i + 4;
                var j = open;
                var pd: usize = 1;
                var comma: ?usize = null;
                while (j < src.len) : (j += 1) {
                    switch (src[j]) {
                        '(' => pd += 1,
                        ')' => {
                            pd -= 1;
                            if (pd == 0) break;
                        },
                        ',' => if (pd == 1 and comma == null) {
                            comma = j;
                        },
                        else => {},
                    }
                }
                const name = std.mem.trim(u8, src[open .. comma orelse j], " \t\r\n");
                const fallback: ?[]const u8 = if (comma) |cm| std.mem.trim(u8, src[cm + 1 .. @min(j, src.len)], " \t\r\n") else null;
                const value: ?[]const u8 = if (is_var) c.lookupVar(name) else null;
                if (value) |v| {
                    const r = (try c.substitute(v, depth + 1)) orelse return null;
                    // `initial` as a var value (tailwind's --tw-x: initial) means
                    // the guaranteed-invalid value: use the fallback
                    if (std.mem.eql(u8, std.mem.trim(u8, r, " "), "initial")) {
                        if (fallback) |f| {
                            const fr = (try c.substitute(f, depth + 1)) orelse return null;
                            try out.appendSlice(c.arena, fr);
                        } else return null;
                    } else try out.appendSlice(c.arena, r);
                } else if (fallback) |f| {
                    const r = (try c.substitute(f, depth + 1)) orelse return null;
                    try out.appendSlice(c.arena, r);
                } else if (is_env) {
                    try out.appendSlice(c.arena, "0px");
                } else return null;
                i = @min(j + 1, src.len);
                continue;
            }
            try out.append(c.arena, src[i]);
            i += 1;
        }
        return out.items;
    }

    fn ctx(c: *const Computer) values.Ctx {
        return .{ .em = c.s.font_size, .rem = c.e.root_font_size, .vw = c.e.env.width, .vh = c.e.env.height };
    }

    fn len(c: *const Computer, l: Length) LengthPct {
        return values.computeLength(l, c.ctx());
    }

    fn px(c: *const Computer, l: Length) f32 {
        return values.computeLength(l, c.ctx()).px;
    }

    fn color(c: *const Computer, v: values.ColorValue) Color {
        return switch (v) {
            .rgba => |col| col,
            .current_color => c.s.color,
        };
    }

    fn applyKeyword(c: *Computer, p: PropId, k: props.Keyword) void {
        const inherit = switch (k) {
            .inherit => true,
            .initial => false,
            .unset, .revert => p.isInherited(),
            else => return,
        };
        const src: *const Style = if (inherit) (c.parent orelse &default_style) else &initial_style;
        copyProp(&c.s, src, p);
        switch (p) {
            .border_top_color => c.border_cc[0] = !inherit,
            .border_right_color => c.border_cc[1] = !inherit,
            .border_bottom_color => c.border_cc[2] = !inherit,
            .border_left_color => c.border_cc[3] = !inherit,
            .outline_color => c.outline_cc = !inherit,
            .text_decoration_color => c.deco_cc = !inherit,
            else => {},
        }
    }

    fn apply(c: *Computer, d: *const Declaration) Allocator.Error!void {
        const v = d.value;
        if (v == .keyword) {
            switch (v.keyword) {
                .initial, .inherit, .unset, .revert => {
                    for (longhandsOrSelf(d.prop)) |lp| c.applyKeyword(lp, v.keyword);
                    return;
                },
                else => {},
            }
        }
        const s = &c.s;
        switch (d.prop) {
            .display => s.display = @enumFromInt(v.enum_val),
            .position => s.position = @enumFromInt(v.enum_val),
            .box_sizing => s.box_sizing = @enumFromInt(v.enum_val),
            .top => s.inset[0] = c.lenAuto(v),
            .right => s.inset[1] = c.lenAuto(v),
            .bottom => s.inset[2] = c.lenAuto(v),
            .left => s.inset[3] = c.lenAuto(v),
            .width => s.width = c.size(v),
            .height => s.height = c.size(v),
            .min_width => s.min_width = c.size(v),
            .min_height => s.min_height = c.size(v),
            .max_width => s.max_width = c.size(v),
            .max_height => s.max_height = c.size(v),
            .aspect_ratio => s.aspect_ratio = if (v == .number) v.number else null,
            .margin_top => s.margin[0] = c.lenAuto(v),
            .margin_right => s.margin[1] = c.lenAuto(v),
            .margin_bottom => s.margin[2] = c.lenAuto(v),
            .margin_left => s.margin[3] = c.lenAuto(v),
            .padding_top => s.padding[0] = c.len(v.length),
            .padding_right => s.padding[1] = c.len(v.length),
            .padding_bottom => s.padding[2] = c.len(v.length),
            .padding_left => s.padding[3] = c.len(v.length),
            .border_top_width => s.border_width[0] = snapBorder(c.px(v.length)),
            .border_right_width => s.border_width[1] = snapBorder(c.px(v.length)),
            .border_bottom_width => s.border_width[2] = snapBorder(c.px(v.length)),
            .border_left_width => s.border_width[3] = snapBorder(c.px(v.length)),
            .border_top_style => s.border_style[0] = @enumFromInt(v.enum_val),
            .border_right_style => s.border_style[1] = @enumFromInt(v.enum_val),
            .border_bottom_style => s.border_style[2] = @enumFromInt(v.enum_val),
            .border_left_style => s.border_style[3] = @enumFromInt(v.enum_val),
            .border_top_color => c.setBorderColor(0, v.color),
            .border_right_color => c.setBorderColor(1, v.color),
            .border_bottom_color => c.setBorderColor(2, v.color),
            .border_left_color => c.setBorderColor(3, v.color),
            .border_top_left_radius => s.radius[0] = c.len(v.length),
            .border_top_right_radius => s.radius[1] = c.len(v.length),
            .border_bottom_right_radius => s.radius[2] = c.len(v.length),
            .border_bottom_left_radius => s.radius[3] = c.len(v.length),
            .flex_direction => s.flex_direction = @enumFromInt(v.enum_val),
            .flex_wrap => s.flex_wrap = @enumFromInt(v.enum_val),
            .flex_grow => s.flex_grow = @max(0, v.number),
            .flex_shrink => s.flex_shrink = @max(0, v.number),
            .flex_basis => s.flex_basis = c.size(v),
            .order => s.order = if (v == .number) toI32(v.number) else 0,
            .justify_content => s.justify_content = @enumFromInt(v.enum_val),
            .justify_items => s.justify_items = @enumFromInt(v.enum_val),
            .justify_self => s.justify_self = @enumFromInt(v.enum_val),
            .align_items => s.align_items = @enumFromInt(v.enum_val),
            .align_self => s.align_self = @enumFromInt(v.enum_val),
            .align_content => s.align_content = @enumFromInt(v.enum_val),
            .row_gap => s.row_gap = if (v == .length) c.len(v.length) else .{},
            .column_gap => s.column_gap = if (v == .length) c.len(v.length) else .{},
            .grid_template_columns => s.grid_template_columns = v.tracks,
            .grid_template_rows => s.grid_template_rows = v.tracks,
            .grid_auto_columns => s.grid_auto_columns = v.tracks,
            .grid_auto_rows => s.grid_auto_rows = v.tracks,
            .grid_auto_flow => s.grid_auto_flow = @enumFromInt(v.enum_val),
            .grid_column => s.grid_column = v.grid_line,
            .grid_row => s.grid_row = v.grid_line,
            .overflow_x => s.overflow_x = @enumFromInt(v.enum_val),
            .overflow_y => s.overflow_y = @enumFromInt(v.enum_val),
            .z_index => s.z_index = if (v == .number) toI32(v.number) else null,
            .vertical_align => s.vertical_align = @enumFromInt(v.enum_val),
            .color => {
                // currentColor on `color` means the inherited color
                s.color = switch (v.color) {
                    .rgba => |col| col,
                    .current_color => if (c.parent) |p| p.color else Color.black,
                };
            },
            .background_color => s.background_color = c.color(v.color),
            .background_image => s.background_image = try c.images(v.images),
            .background_size => s.background_size = v.bg_size,
            .background_position => s.background_position = .{ c.len(v.pair.a), c.len(v.pair.b) },
            .background_repeat => s.background_repeat = @enumFromInt(v.enum_val),
            .background_clip => s.background_clip = @enumFromInt(v.enum_val),
            .opacity => s.opacity = std.math.clamp(v.number, 0, 1),
            .visibility => s.visibility = @enumFromInt(v.enum_val),
            .box_shadow => s.box_shadow = try c.shadows(v.shadows),
            .text_shadow => s.text_shadow = try c.shadows(v.shadows),
            .transform => s.transform = try c.transforms(v.transform),
            .transform_origin => s.transform_origin = .{ c.len(v.pair.a), c.len(v.pair.b) },
            .translate => s.translate = if (v == .pair) .{ c.len(v.pair.a), c.len(v.pair.b) } else null,
            .scale => s.scale = if (v == .scale2) .{ v.scale2.x, v.scale2.y } else null,
            .rotate => s.rotate = if (v == .number) v.number else null,
            .outline_width => s.outline_width = c.px(v.length),
            .outline_style => s.outline_style = @enumFromInt(v.enum_val),
            .outline_color => switch (v.color) {
                .rgba => |col| {
                    s.outline_color = col;
                    c.outline_cc = false;
                },
                .current_color => c.outline_cc = true,
            },
            .outline_offset => s.outline_offset = c.px(v.length),
            .cursor => s.cursor = @enumFromInt(v.enum_val),
            .pointer_events => s.pointer_events = @enumFromInt(v.enum_val),
            .user_select => s.user_select = @enumFromInt(v.enum_val),
            .object_fit => s.object_fit = @enumFromInt(v.enum_val),
            .filter => s.filter = try c.filters(v.filters),
            .backdrop_filter => s.backdrop_filter = try c.filters(v.filters),
            .font_family => s.font_family = v.font_family,
            .font_size => {
                // em/% are relative to the parent's font size
                const parent_fs = if (c.parent) |p| p.font_size else 16;
                const l = v.length;
                const pxv = l.px + l.em * parent_fs + l.rem * (if (c.doc.documentElement() == c.id) 16 else c.e.root_font_size) + l.vw * c.e.env.width + l.vh * c.e.env.height;
                s.font_size = @max(0, pxv);
            },
            .font_weight => {
                const parent_w = if (c.parent) |p| p.font_weight else 400;
                s.font_weight = if (v.number == -1) bolderOf(parent_w) else if (v.number == -2) lighterOf(parent_w) else v.number;
            },
            .font_style => s.font_style = @enumFromInt(v.enum_val),
            .line_height => s.line_height = switch (v) {
                .number => |n| .{ .number = n },
                .length => |l| blk: {
                    const r = c.len(l);
                    break :blk .{ .px = r.px + r.pct * s.font_size };
                },
                else => .normal,
            },
            .letter_spacing => s.letter_spacing = if (v == .length) c.px(v.length) else 0,
            .word_spacing => s.word_spacing = if (v == .length) c.px(v.length) else 0,
            .text_align => s.text_align = @enumFromInt(v.enum_val),
            .text_decoration_line => s.text_decoration = v.text_decoration,
            .text_decoration_color => switch (v.color) {
                .rgba => |col| {
                    s.text_decoration_color = col;
                    c.deco_cc = false;
                },
                .current_color => c.deco_cc = true,
            },
            .text_transform => s.text_transform = @enumFromInt(v.enum_val),
            .text_overflow => s.text_overflow = @enumFromInt(v.enum_val),
            .text_indent => s.text_indent = c.len(v.length),
            .white_space => s.white_space = @enumFromInt(v.enum_val),
            .word_break => s.word_break = @enumFromInt(v.enum_val),
            .overflow_wrap => s.overflow_wrap = @enumFromInt(v.enum_val),
            .line_clamp => s.line_clamp = if (v == .number and v.number >= 1) @intFromFloat(@min(v.number, 100000)) else null,
            .tab_size => s.tab_size = if (v == .number) v.number else 8,
            .caret_color => s.caret_color = if (v == .color) c.color(v.color) else null,
            .accent_color => s.accent_color = if (v == .color) c.color(v.color) else null,
            .list_style_type => s.list_style_type = @enumFromInt(v.enum_val),
            .content => s.content = if (v == .string) v.string else null,
            .transition_property => c.t_props = v.transition_props,
            .transition_duration => c.t_durs = v.times,
            .transition_delay => c.t_delays = v.times,
            .transition_timing_function => c.t_timings = v.timings,
            .animation => s.animations = v.animations,
            .app_region => s.app_region = @enumFromInt(v.enum_val),
            .resize => s.resize = @enumFromInt(v.enum_val),
            .scroll_behavior => s.scroll_behavior = @enumFromInt(v.enum_val),
            .text_decoration, .margin, .padding, .inset, .border, .border_top, .border_right, .border_bottom, .border_left, .border_width, .border_style, .border_color, .border_radius, .flex, .flex_flow, .gap, .overflow, .background, .font, .outline, .place_items, .place_content, .place_self, .transition, .grid_template, .grid_area, .custom => {},
        }
    }

    fn setBorderColor(c: *Computer, i: usize, v: values.ColorValue) void {
        switch (v) {
            .rgba => |col| {
                c.s.border_color[i] = col;
                c.border_cc[i] = false;
            },
            .current_color => c.border_cc[i] = true,
        }
    }

    fn lenAuto(c: *const Computer, v: props.Value) LenAuto {
        return switch (v) {
            .length => |l| .{ .len = c.len(l) },
            else => .auto,
        };
    }

    fn size(c: *const Computer, v: props.Value) SizeVal {
        return switch (v) {
            .length => |l| .{ .len = c.len(l) },
            .keyword => |k| switch (k) {
                .none => .none,
                .min_content => .min_content,
                .max_content => .max_content,
                .fit_content => .fit_content,
                .content => .auto,
                else => .auto,
            },
            else => .auto,
        };
    }

    fn shadows(c: *Computer, list: []const props.Shadow) ![]const Shadow {
        if (list.len == 0) return &.{};
        const out = try c.arena.alloc(Shadow, list.len);
        for (list, out) |sh, *o| o.* = .{
            .x = c.px(sh.x),
            .y = c.px(sh.y),
            .blur = @max(0, c.px(sh.blur)),
            .spread = c.px(sh.spread),
            .color = c.colorDeferred(sh.color),
            .inset = sh.inset,
        };
        return out;
    }

    fn colorDeferred(c: *const Computer, v: values.ColorValue) Color {
        // currentColor inside lists resolves against the color known so far;
        // `color` is applied before most visual properties in practice
        return c.color(v);
    }

    fn transforms(c: *Computer, list: []const props.TransformOp) ![]const TransformOp {
        if (list.len == 0) return &.{};
        const out = try c.arena.alloc(TransformOp, list.len);
        for (list, out) |op, *o| o.* = switch (op) {
            .translate => |t| .{ .translate = .{ .x = c.len(t.x), .y = c.len(t.y) } },
            .scale => |sc| .{ .scale = .{ .x = sc.x, .y = sc.y } },
            .rotate => |r| .{ .rotate = r },
            .skew => |sk| .{ .skew = .{ .x = sk.x, .y = sk.y } },
            .matrix => |m| .{ .matrix = m },
        };
        return out;
    }

    fn filters(c: *Computer, list: []const props.Filter) ![]const Filter {
        if (list.len == 0) return &.{};
        const out = try c.arena.alloc(Filter, list.len);
        for (list, out) |f, *o| o.* = switch (f) {
            .blur => |l| .{ .blur = c.px(l) },
            .brightness => |x| .{ .brightness = x },
            .contrast => |x| .{ .contrast = x },
            .grayscale => |x| .{ .grayscale = x },
            .saturate => |x| .{ .saturate = x },
            .invert => |x| .{ .invert = x },
            .sepia => |x| .{ .sepia = x },
            .opacity => |x| .{ .opacity = x },
            .hue_rotate => |x| .{ .hue_rotate = x },
            .drop_shadow => |sh| .{ .drop_shadow = .{ .x = c.px(sh.x), .y = c.px(sh.y), .blur = c.px(sh.blur), .color = c.color(sh.color) } },
        };
        return out;
    }

    fn images(c: *Computer, list: []const props.Image) ![]const Image {
        var out: std.ArrayList(Image) = .empty;
        for (list) |img| switch (img) {
            .none => {},
            .url => |u| try out.append(c.arena, .{ .url = u }),
            .gradient => |g| {
                const stops = try c.arena.alloc(GradientStop, g.stops.len);
                for (g.stops, stops) |st, *o| o.* = .{ .color = c.color(st.color), .pos = if (st.pos) |p| c.len(p) else null };
                try out.append(c.arena, .{ .gradient = .{
                    .kind = g.kind,
                    .angle = g.angle,
                    .to_corner = if (g.to_corner) |tc| .{ .x = tc.x, .y = tc.y } else null,
                    .circle = g.circle,
                    .cx = c.len(g.cx),
                    .cy = c.len(g.cy),
                    .repeating = g.repeating,
                    .stops = stops,
                } });
            },
        };
        return out.items;
    }

    fn finish(c: *Computer) void {
        const s = &c.s;
        for (0..4) |i| if (c.border_cc[i]) {
            s.border_color[i] = s.color;
        };
        if (c.outline_cc) s.outline_color = s.color;
        if (c.deco_cc) s.text_decoration_color = s.color;
        // assemble transitions from longhand lists (lists repeat to the longest)
        if (c.t_props) |tp| {
            if (tp.len > 0) {
                const durs = c.t_durs orelse &[_]f32{0};
                const delays = c.t_delays orelse &[_]f32{0};
                const timings = c.t_timings orelse &[_]props.Timing{props.Timing.ease};
                if (c.arena.alloc(props.Transition, tp.len)) |out| {
                    for (tp, 0..) |p, i| out[i] = .{
                        .property = p,
                        .duration = if (durs.len > 0) durs[i % durs.len] else 0,
                        .delay = if (delays.len > 0) delays[i % delays.len] else 0,
                        .timing = if (timings.len > 0) timings[i % timings.len] else props.Timing.ease,
                    };
                    s.transitions = out;
                } else |_| {}
            } else s.transitions = &.{};
        } else if (c.t_durs) |durs| {
            // `transition-duration` alone applies to `all`
            if (durs.len > 0 and durs[0] > 0) {
                if (c.arena.alloc(props.Transition, 1)) |out| {
                    out[0] = .{ .property = null, .duration = durs[0], .delay = if (c.t_delays) |d| (if (d.len > 0) d[0] else 0) else 0, .timing = if (c.t_timings) |t| (if (t.len > 0) t[0] else props.Timing.ease) else props.Timing.ease };
                    s.transitions = out;
                } else |_| {}
            }
        }
        // display fixups (CSS 2.1 §9.7): absolutely positioned and floated
        // boxes are blockified; so are flex/grid items (done by layout)
        if (s.position == .absolute or s.position == .fixed) {
            s.display = switch (s.display) {
                .inline_, .inline_block => .block,
                .inline_flex => .flex,
                .inline_grid => .grid,
                else => s.display,
            };
        }
        if (c.parent) |p| {
            if ((p.isFlexContainer() or p.isGridContainer()) and !c.is_pseudo) {
                s.display = switch (s.display) {
                    .inline_, .inline_block, .list_item => .block,
                    .inline_flex => .flex,
                    .inline_grid => .grid,
                    else => s.display,
                };
            }
        }
        // a scroll container can't be visible on one axis only
        if (s.overflow_x != .visible and s.overflow_y == .visible) s.overflow_y = .auto;
        if (s.overflow_y != .visible and s.overflow_x == .visible) s.overflow_x = .auto;
        if (c.is_pseudo and s.content == null and s.display != .none) {
            // ::placeholder and ::marker do not need content
        }
    }

    fn isIdentChar(ch: u8) bool {
        return std.ascii.isAlphanumeric(ch) or ch == '-' or ch == '_';
    }
};

fn toI32(v: f32) i32 {
    if (std.math.isNan(v)) return 0;
    return @intFromFloat(std.math.clamp(@round(v), -2147483520.0, 2147483520.0));
}

fn snapBorder(v: f32) f32 {
    // browsers floor border widths to device pixels, with a 1px minimum for >0
    if (v <= 0) return 0;
    if (v < 1) return 1;
    return @floor(v);
}

fn bolderOf(w: f32) f32 {
    if (w < 350) return 400;
    if (w < 550) return 700;
    if (w < 900) return 900;
    return w;
}

fn lighterOf(w: f32) f32 {
    if (w < 100) return w;
    if (w < 550) return 100;
    if (w < 750) return 400;
    return 700;
}

fn longhandsOrSelf(p: PropId) []const PropId {
    const l = props.longhandsOf(p);
    if (l.len > 0) return l;
    return switch (p) {
        inline else => |pp| &[_]PropId{pp},
    };
}

fn propName(p: PropId) []const u8 {
    return switch (p) {
        inline else => |pp| comptime blk: {
            @setEvalBranchQuota(100000);
            const raw = @tagName(pp);
            var buf: [raw.len]u8 = undefined;
            for (raw, 0..) |ch, i| buf[i] = if (ch == '_') '-' else ch;
            const final = buf;
            break :blk &final;
        },
    };
}

const initial_style: Style = .{};

fn inheritFrom(p: *const Style) Style {
    var s: Style = .{};
    s.color = p.color;
    s.font_family = p.font_family;
    s.font_size = p.font_size;
    s.font_weight = p.font_weight;
    s.font_style = p.font_style;
    s.line_height = p.line_height;
    s.letter_spacing = p.letter_spacing;
    s.word_spacing = p.word_spacing;
    s.text_align = p.text_align;
    s.text_transform = p.text_transform;
    s.text_indent = p.text_indent;
    s.text_shadow = p.text_shadow;
    s.white_space = p.white_space;
    s.word_break = p.word_break;
    s.overflow_wrap = p.overflow_wrap;
    s.tab_size = p.tab_size;
    s.caret_color = p.caret_color;
    s.accent_color = p.accent_color;
    s.list_style_type = p.list_style_type;
    s.cursor = p.cursor;
    s.visibility = p.visibility;
    s.pointer_events = p.pointer_events;
    s.user_select = p.user_select;
    s.customs = p.customs;
    // text-decoration is not inherited but propagates to inline descendants;
    // handled at paint time by walking ancestors
    return s;
}

fn copyProp(dst: *Style, src: *const Style, p: PropId) void {
    switch (p) {
        .display => dst.display = src.display,
        .position => dst.position = src.position,
        .box_sizing => dst.box_sizing = src.box_sizing,
        .top => dst.inset[0] = src.inset[0],
        .right => dst.inset[1] = src.inset[1],
        .bottom => dst.inset[2] = src.inset[2],
        .left => dst.inset[3] = src.inset[3],
        .width => dst.width = src.width,
        .height => dst.height = src.height,
        .min_width => dst.min_width = src.min_width,
        .min_height => dst.min_height = src.min_height,
        .max_width => dst.max_width = src.max_width,
        .max_height => dst.max_height = src.max_height,
        .aspect_ratio => dst.aspect_ratio = src.aspect_ratio,
        .margin_top => dst.margin[0] = src.margin[0],
        .margin_right => dst.margin[1] = src.margin[1],
        .margin_bottom => dst.margin[2] = src.margin[2],
        .margin_left => dst.margin[3] = src.margin[3],
        .padding_top => dst.padding[0] = src.padding[0],
        .padding_right => dst.padding[1] = src.padding[1],
        .padding_bottom => dst.padding[2] = src.padding[2],
        .padding_left => dst.padding[3] = src.padding[3],
        .border_top_width => dst.border_width[0] = src.border_width[0],
        .border_right_width => dst.border_width[1] = src.border_width[1],
        .border_bottom_width => dst.border_width[2] = src.border_width[2],
        .border_left_width => dst.border_width[3] = src.border_width[3],
        .border_top_style => dst.border_style[0] = src.border_style[0],
        .border_right_style => dst.border_style[1] = src.border_style[1],
        .border_bottom_style => dst.border_style[2] = src.border_style[2],
        .border_left_style => dst.border_style[3] = src.border_style[3],
        .border_top_color => dst.border_color[0] = src.border_color[0],
        .border_right_color => dst.border_color[1] = src.border_color[1],
        .border_bottom_color => dst.border_color[2] = src.border_color[2],
        .border_left_color => dst.border_color[3] = src.border_color[3],
        .border_top_left_radius => dst.radius[0] = src.radius[0],
        .border_top_right_radius => dst.radius[1] = src.radius[1],
        .border_bottom_right_radius => dst.radius[2] = src.radius[2],
        .border_bottom_left_radius => dst.radius[3] = src.radius[3],
        .flex_direction => dst.flex_direction = src.flex_direction,
        .flex_wrap => dst.flex_wrap = src.flex_wrap,
        .flex_grow => dst.flex_grow = src.flex_grow,
        .flex_shrink => dst.flex_shrink = src.flex_shrink,
        .flex_basis => dst.flex_basis = src.flex_basis,
        .order => dst.order = src.order,
        .justify_content => dst.justify_content = src.justify_content,
        .justify_items => dst.justify_items = src.justify_items,
        .justify_self => dst.justify_self = src.justify_self,
        .align_items => dst.align_items = src.align_items,
        .align_self => dst.align_self = src.align_self,
        .align_content => dst.align_content = src.align_content,
        .row_gap => dst.row_gap = src.row_gap,
        .column_gap => dst.column_gap = src.column_gap,
        .grid_template_columns => dst.grid_template_columns = src.grid_template_columns,
        .grid_template_rows => dst.grid_template_rows = src.grid_template_rows,
        .grid_auto_columns => dst.grid_auto_columns = src.grid_auto_columns,
        .grid_auto_rows => dst.grid_auto_rows = src.grid_auto_rows,
        .grid_auto_flow => dst.grid_auto_flow = src.grid_auto_flow,
        .grid_column => dst.grid_column = src.grid_column,
        .grid_row => dst.grid_row = src.grid_row,
        .overflow_x => dst.overflow_x = src.overflow_x,
        .overflow_y => dst.overflow_y = src.overflow_y,
        .z_index => dst.z_index = src.z_index,
        .vertical_align => dst.vertical_align = src.vertical_align,
        .color => dst.color = src.color,
        .background_color => dst.background_color = src.background_color,
        .background_image => dst.background_image = src.background_image,
        .background_size => dst.background_size = src.background_size,
        .background_position => dst.background_position = src.background_position,
        .background_repeat => dst.background_repeat = src.background_repeat,
        .background_clip => dst.background_clip = src.background_clip,
        .opacity => dst.opacity = src.opacity,
        .visibility => dst.visibility = src.visibility,
        .box_shadow => dst.box_shadow = src.box_shadow,
        .transform => dst.transform = src.transform,
        .transform_origin => dst.transform_origin = src.transform_origin,
        .translate => dst.translate = src.translate,
        .scale => dst.scale = src.scale,
        .rotate => dst.rotate = src.rotate,
        .outline_width => dst.outline_width = src.outline_width,
        .outline_style => dst.outline_style = src.outline_style,
        .outline_color => dst.outline_color = src.outline_color,
        .outline_offset => dst.outline_offset = src.outline_offset,
        .cursor => dst.cursor = src.cursor,
        .pointer_events => dst.pointer_events = src.pointer_events,
        .user_select => dst.user_select = src.user_select,
        .object_fit => dst.object_fit = src.object_fit,
        .filter => dst.filter = src.filter,
        .backdrop_filter => dst.backdrop_filter = src.backdrop_filter,
        .font_family => dst.font_family = src.font_family,
        .font_size => dst.font_size = src.font_size,
        .font_weight => dst.font_weight = src.font_weight,
        .font_style => dst.font_style = src.font_style,
        .line_height => dst.line_height = src.line_height,
        .letter_spacing => dst.letter_spacing = src.letter_spacing,
        .word_spacing => dst.word_spacing = src.word_spacing,
        .text_align => dst.text_align = src.text_align,
        .text_decoration_line => dst.text_decoration = src.text_decoration,
        .text_decoration_color => dst.text_decoration_color = src.text_decoration_color,
        .text_transform => dst.text_transform = src.text_transform,
        .text_overflow => dst.text_overflow = src.text_overflow,
        .text_indent => dst.text_indent = src.text_indent,
        .text_shadow => dst.text_shadow = src.text_shadow,
        .white_space => dst.white_space = src.white_space,
        .word_break => dst.word_break = src.word_break,
        .overflow_wrap => dst.overflow_wrap = src.overflow_wrap,
        .line_clamp => dst.line_clamp = src.line_clamp,
        .tab_size => dst.tab_size = src.tab_size,
        .caret_color => dst.caret_color = src.caret_color,
        .accent_color => dst.accent_color = src.accent_color,
        .list_style_type => dst.list_style_type = src.list_style_type,
        .content => dst.content = src.content,
        .transition_property, .transition_duration, .transition_delay, .transition_timing_function, .transition => dst.transitions = src.transitions,
        .animation => dst.animations = src.animations,
        .app_region => dst.app_region = src.app_region,
        .resize => dst.resize = src.resize,
        .scroll_behavior => dst.scroll_behavior = src.scroll_behavior,
        else => {},
    }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// querySelectorAll over the subtree of `scope`.
pub fn querySelectorAll(doc: *Document, scope: NodeId, selector_text: []const u8, out: *std.ArrayList(NodeId)) !void {
    var arena_state = std.heap.ArenaAllocator.init(doc.gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const toks = try tok.tokenizeAll(a, selector_text);
    const list = sel_mod.parseList(a, &doc.interner, toks.items[0 .. toks.items.len - 1]) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        error.Invalid => return error.InvalidSelector,
    };
    var cur = doc.nextInTree(scope, scope);
    while (cur != null_id) : (cur = doc.nextInTree(cur, scope)) {
        if (doc.node(cur).kind != .element) continue;
        for (list) |*s| {
            if (matchSelector(doc, s, cur, .none, null)) {
                try out.append(doc.gpa, cur);
                break;
            }
        }
    }
}

pub fn querySelector(doc: *Document, scope: NodeId, selector_text: []const u8) !NodeId {
    var list: std.ArrayList(NodeId) = .empty;
    defer list.deinit(doc.gpa);
    try querySelectorAll(doc, scope, selector_text, &list);
    return if (list.items.len > 0) list.items[0] else null_id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const html = @import("html.zig");

const TestEnv = struct {
    doc: *Document,
    engine: Engine,

    fn init(markup: []const u8) !TestEnv {
        const doc = try Document.init(std.testing.allocator);
        doc.node_finalizer = finalizeNode;
        try html.parseInto(doc, doc.root, markup, .{});
        var e = Engine.init(std.testing.allocator);
        _ = try e.update(doc);
        return .{ .doc = doc, .engine = e };
    }
    fn deinit(t: *TestEnv) void {
        t.doc.deinit();
        t.engine.deinit();
    }
    fn styleOf(t: *TestEnv, sel: []const u8) *const Style {
        const id = querySelector(t.doc, t.doc.root, sel) catch unreachable;
        return of(t.doc, id);
    }
};

test "cascade, specificity, inheritance" {
    var t = try TestEnv.init(
        \\<style>
        \\  :root { --brand: rgb(10, 20, 30); --pad: 6px; }
        \\  p { color: red; }
        \\  .x { color: blue; padding: var(--pad) calc(var(--pad) * 2); }
        \\  #y { color: green; }
        \\  p.x { font-size: 20px; }
        \\  .card .title { color: var(--brand); }
        \\  .imp { color: purple !important; }
        \\  .missing { width: var(--nope); height: var(--nope, 33px); }
        \\  h1 { margin: 1em 0; }
        \\</style>
        \\<p class="x" id="y">a <span>b</span></p>
        \\<p class="x">c</p>
        \\<div class="card"><h1 class="title imp" style="color: orange">T</h1></div>
        \\<div class="missing"></div>
    );
    defer t.deinit();
    try std.testing.expect(t.styleOf("#y").color.eql(Color.rgb(0, 128, 0)));
    try std.testing.expect(t.styleOf("#y span").color.eql(Color.rgb(0, 128, 0))); // inherited
    try std.testing.expectEqual(@as(f32, 20), t.styleOf("#y").font_size);
    try std.testing.expectEqual(@as(f32, 20), t.styleOf("#y span").font_size);
    const px2 = t.styleOf("p:nth-child(3)");
    try std.testing.expect(px2.color.eql(Color.rgb(0, 0, 255)));
    try std.testing.expectEqual(@as(f32, 6), px2.padding[0].px);
    try std.testing.expectEqual(@as(f32, 12), px2.padding[1].px);
    const title = t.styleOf(".title");
    try std.testing.expect(title.color.eql(Color.rgb(128, 0, 128))); // !important beats inline
    try std.testing.expectEqual(@as(f32, 32), title.margin[0].len.px); // 1em of its own 2em*16 font-size
    try std.testing.expect(title.display == .block);
    try std.testing.expectEqual(@as(f32, 700), title.font_weight);
    const missing = t.styleOf(".missing");
    try std.testing.expect(missing.width == .auto);
    try std.testing.expectEqual(@as(f32, 33), missing.height.len.px);
}

test "dynamic restyle and state" {
    var t = try TestEnv.init(
        \\<style>
        \\  .btn { background-color: #111; transition: background-color .2s }
        \\  .btn:hover { background-color: #222 }
        \\  .group:hover .label { color: #333 }
        \\  .on > .label { color: #444 }
        \\  li:first-child { color: #555 }
        \\  .row:has(> .sel) { color: #666 }
        \\</style>
        \\<div class="group"><button class="btn"><span class="label">x</span></button></div>
        \\<ul><li>a</li><li>b</li></ul>
        \\<div class="row"><i></i><b class="other"></b></div>
    );
    defer t.deinit();
    const doc = t.doc;
    const btn = try querySelector(doc, doc.root, ".btn");
    try std.testing.expect(of(doc, btn).background_color.eql(Color.hex(0x111111)));
    try std.testing.expectEqual(@as(usize, 1), of(doc, btn).transitions.len);
    doc.setState(btn, .{ .hover = true });
    _ = try t.engine.update(doc);
    try std.testing.expect(of(doc, btn).background_color.eql(Color.hex(0x222222)));
    // ancestor :hover affects descendant
    const group = try querySelector(doc, doc.root, ".group");
    const label = try querySelector(doc, doc.root, ".label");
    try std.testing.expect(of(doc, label).color.eql(Color.black));
    doc.setState(group, .{ .hover = true });
    _ = try t.engine.update(doc);
    try std.testing.expect(of(doc, label).color.eql(Color.hex(0x333333)));
    // class change on parent (un-hover first: .group:hover .label is more specific)
    doc.setState(group, .{});
    try doc.setAttribute(btn, "class", "btn on");
    _ = try t.engine.update(doc);
    try std.testing.expect(of(doc, label).color.eql(Color.hex(0x444444)));
    // structural: insert a new first li
    const ul = try querySelector(doc, doc.root, "ul");
    const first = doc.node(ul).first_child;
    const li = try doc.createElement("li");
    doc.insertBefore(ul, li, first);
    _ = try t.engine.update(doc);
    try std.testing.expect(of(doc, li).color.eql(Color.hex(0x555555)));
    const old_first = try querySelector(doc, doc.root, "li:nth-child(2)");
    try std.testing.expect(of(doc, old_first).color.eql(Color.black));
    // :has
    const row = try querySelector(doc, doc.root, ".row");
    try std.testing.expect(of(doc, row).color.eql(Color.black));
    const b = try querySelector(doc, doc.root, ".other");
    try doc.setAttribute(b, "class", "sel");
    _ = try t.engine.update(doc);
    try std.testing.expect(of(doc, row).color.eql(Color.hex(0x666666)));
}

test "layers, media and pseudo elements" {
    var t = try TestEnv.init(
        \\<style>
        \\  @layer base, utilities;
        \\  @layer utilities { .u { color: #010101 } }
        \\  @layer base { div.u { color: #020202 } }
        \\  .plain { color: #030303 }
        \\  @layer base { .plain { color: #040404 } }
        \\  @media (min-width: 1000px) { .wide { display: none } }
        \\  .tag::before { content: "\2022  "; color: red }
        \\  @media (prefers-color-scheme: dark) { .theme { color: white } }
        \\</style>
        \\<div class="u"></div><div class="plain"></div><div class="wide"></div><span class="tag"></span><p class="theme"></p>
    );
    defer t.deinit();
    // later layer wins regardless of specificity
    try std.testing.expect(t.styleOf(".u").color.eql(Color.hex(0x010101)));
    // unlayered beats layered
    try std.testing.expect(t.styleOf(".plain").color.eql(Color.hex(0x030303)));
    try std.testing.expect(t.styleOf(".wide").display == .block);
    t.engine.setEnv(.{ .width = 1200, .dark = true });
    _ = try t.engine.update(t.doc);
    try std.testing.expect(t.styleOf(".wide").display == .none);
    try std.testing.expect(t.styleOf(".theme").color.eql(Color.white));
    const tag = try querySelector(t.doc, t.doc.root, ".tag");
    const ns = get(t.doc.node(tag)).?;
    try std.testing.expect(ns.before != null);
    try std.testing.expectEqualStrings("\u{2022} ", ns.before.?.content.?);
    try std.testing.expect(ns.before.?.color.eql(Color.rgb(255, 0, 0)));
}

test "tailwind v4 style utilities" {
    var t = try TestEnv.init(
        \\<style>
        \\@layer theme { :root, :host { --color-blue-500: oklch(62.3% 0.214 259.815); --spacing: 0.25rem; --radius-lg: 0.5rem; } }
        \\@layer utilities {
        \\  .bg-blue-500 { background-color: var(--color-blue-500); }
        \\  .p-4 { padding: calc(var(--spacing) * 4); }
        \\  .rounded-lg { border-radius: var(--radius-lg); }
        \\  .hover\:bg-blue-500 { &:hover { @media (hover: hover) { background-color: var(--color-blue-500); } } }
        \\  .shadow { --tw-shadow: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)); box-shadow: var(--tw-inset-shadow), var(--tw-shadow); }
        \\}
        \\@property --tw-inset-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
        \\</style>
        \\<div class="bg-blue-500 p-4 rounded-lg shadow"></div><a class="hover:bg-blue-500"></a>
    );
    defer t.deinit();
    const s = t.styleOf("div");
    try std.testing.expect(s.background_color.eql(Color.rgb(0x2b, 0x7f, 0xff)));
    try std.testing.expectEqual(@as(f32, 16), s.padding[0].px);
    try std.testing.expectEqual(@as(f32, 8), s.radius[0].px);
    try std.testing.expectEqual(@as(usize, 2), s.box_shadow.len);
    try std.testing.expectEqual(@as(f32, 3), s.box_shadow[1].blur);
    const a = try querySelector(t.doc, t.doc.root, "a");
    t.doc.setState(a, .{ .hover = true });
    _ = try t.engine.update(t.doc);
    try std.testing.expect(of(t.doc, a).background_color.eql(Color.rgb(0x2b, 0x7f, 0xff)));
}
