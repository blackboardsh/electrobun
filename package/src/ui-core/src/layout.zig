//! Layout: CSS box model, block flow (with margin collapsing), inline
//! formatting contexts, flexbox, grid, absolute/fixed positioning and
//! replaced elements. Results are stored on each node's Box with
//! parent-relative coordinates so clean subtrees can be reused untouched.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const style_mod = @import("style.zig");
const font = @import("text/font.zig");
const props = @import("css/properties.zig");
const values = @import("css/values.zig");
const inline_mod = @import("inline.zig");
const grid = @import("grid.zig");

const Allocator = std.mem.Allocator;
const Document = dom.Document;
const NodeId = dom.NodeId;
const null_id = dom.null_id;
const Style = style_mod.Style;
const Edges = geom.Edges;
const InlineLayout = inline_mod.InlineLayout;

pub const Pseudo = enum(u2) { none = 0, before = 1, after = 2, marker = 3 };

/// A layout participant: an element, a text node, or a generated pseudo-element.
pub const Item = struct {
    node: NodeId,
    pseudo: Pseudo = .none,

    pub fn eql(a: Item, b: Item) bool {
        return a.node == b.node and a.pseudo == b.pseudo;
    }
};

pub const Avail = union(enum) {
    definite: f32,
    min_content,
    max_content,

    pub fn val(a: Avail) ?f32 {
        return switch (a) {
            .definite => |v| v,
            else => null,
        };
    }
    pub fn minus(a: Avail, d: f32) Avail {
        return switch (a) {
            .definite => |v| .{ .definite = @max(0, v - d) },
            else => a,
        };
    }
};

pub const Sizing = enum { fill, fit };

pub const Inputs = struct {
    /// border-box sizes imposed by the parent (flex/grid resolution, stretch)
    known_w: ?f32 = null,
    known_h: ?f32 = null,
    avail_w: Avail,
    avail_h: Avail = .max_content,
    /// percentage bases (containing block content box)
    cb_w: ?f32 = null,
    cb_h: ?f32 = null,
    sizing: Sizing = .fill,
    perform: bool = true,
    /// measure the content size, ignoring the box's own width/height
    /// properties (flex "content size suggestion")
    content_only: bool = false,

    fn eql(a: Inputs, b: Inputs) bool {
        return std.meta.eql(a, b);
    }
};

pub const Output = struct {
    w: f32 = 0,
    h: f32 = 0,
    /// first baseline from the border-box top
    baseline: ?f32 = null,
    /// last baseline (inline-block alignment)
    last_baseline: ?f32 = null,
    /// margins collapsed through this box from its first/last child
    collapsed_mt: ?MarginPair = null,
    collapsed_mb: ?MarginPair = null,
};

pub const MarginPair = struct {
    pos: f32 = 0,
    neg: f32 = 0,

    pub fn add(m: MarginPair, v: f32) MarginPair {
        var r = m;
        if (v >= 0) r.pos = @max(r.pos, v) else r.neg = @min(r.neg, v);
        return r;
    }
    pub fn join(a: MarginPair, b: MarginPair) MarginPair {
        return .{ .pos = @max(a.pos, b.pos), .neg = @min(a.neg, b.neg) };
    }
    pub fn resolve(m: MarginPair) f32 {
        return m.pos + m.neg;
    }
};

const CacheEntry = struct {
    in: Inputs,
    out: Output,
};

pub const AnonBlock = struct {
    y: f32,
    il: *InlineLayout,
};

pub const Box = struct {
    /// border box, relative to the parent box's border-box origin (or to the
    /// IFC owner's content box for atomic inlines)
    x: f32 = 0,
    y: f32 = 0,
    w: f32 = 0,
    h: f32 = 0,
    margin: Edges = .{},
    border: Edges = .{},
    padding: Edges = .{},
    /// scrollable overflow size measured from the padding-box origin
    scroll_w: f32 = 0,
    scroll_h: f32 = 0,
    baseline: ?f32 = null,
    /// relative-positioning offset (applied at paint/hit time)
    rel_x: f32 = 0,
    rel_y: f32 = 0,
    /// IFC when every child is inline-level
    inline_layout: ?*InlineLayout = null,
    /// anonymous block boxes for inline runs in mixed content
    anon: std.ArrayList(AnonBlock) = .empty,
    /// the parent that laid out this box this pass (display:none => false)
    placed: bool = false,
    /// laid out by its IFC owner as an atomic inline
    in_inline: bool = false,
    cache: [6]CacheEntry = undefined,
    cache_len: u8 = 0,
    cache_next: u8 = 0,
    final: ?Inputs = null,
    final_out: Output = .{},
    pseudo: [3]?*Box = .{ null, null, null },
    /// shaping cache for text nodes
    text_key: u64 = 0,

    pub fn borderBox(b: *const Box) geom.Rect {
        return .{ .x = b.x, .y = b.y, .w = b.w, .h = b.h };
    }
    pub fn paddingBox(b: *const Box) geom.Rect {
        return .{ .x = b.border.left, .y = b.border.top, .w = @max(0, b.w - b.border.left - b.border.right), .h = @max(0, b.h - b.border.top - b.border.bottom) };
    }
    pub fn contentBox(b: *const Box) geom.Rect {
        const pb = b.border.add(b.padding);
        return .{ .x = pb.left, .y = pb.top, .w = @max(0, b.w - pb.left - pb.right), .h = @max(0, b.h - pb.top - pb.bottom) };
    }

    fn clearLayoutData(b: *Box, gpa: Allocator) void {
        if (b.inline_layout) |il| il.destroy(gpa);
        b.inline_layout = null;
        for (b.anon.items) |a| a.il.destroy(gpa);
        b.anon.clearRetainingCapacity();
    }

    fn destroy(b: *Box, gpa: Allocator) void {
        b.clearLayoutData(gpa);
        b.anon.deinit(gpa);
        for (b.pseudo) |p| if (p) |pb| pb.destroy(gpa);
        gpa.destroy(b);
    }
};

pub fn boxOfNode(n: *const dom.Node) ?*Box {
    return @ptrCast(@alignCast(n.box));
}

/// node_finalizer hook
pub fn finalizeNode(doc: *Document, n: *dom.Node) void {
    if (boxOfNode(n)) |b| b.destroy(doc.gpa);
    n.box = null;
}

pub const ReplacedHooks = struct {
    ctx: ?*anyopaque = null,
    /// natural size of an image-like element (img src loaded), if known
    natural_size: ?*const fn (ctx: ?*anyopaque, doc: *Document, node: NodeId) ?[2]f32 = null,
    /// current text of a text control (input/textarea), if overridden
    control_text: ?*const fn (ctx: ?*anyopaque, doc: *Document, node: NodeId) ?[]const u8 = null,
};

const AbsPending = struct {
    item: Item,
    parent: Item,
    /// static position relative to the parent's border box
    sx: f32,
    sy: f32,
};

pub const Layout = struct {
    gpa: Allocator,
    doc: *Document,
    fonts: font.Backend,
    viewport_w: f32 = 800,
    viewport_h: f32 = 600,
    hooks: ReplacedHooks = .{},
    shape_cache: std.AutoHashMapUnmanaged(u64, []const font.Glyph) = .empty,
    shape_arena: std.heap.ArenaAllocator,
    shape_count: usize = 0,
    pending_abs: std.ArrayList(AbsPending) = .empty,
    scratch: std.heap.ArenaAllocator,
    /// statistics for the last pass
    computed: u32 = 0,
    cache_hits: u32 = 0,

    pub fn init(gpa: Allocator, doc: *Document, fonts: font.Backend) Layout {
        return .{ .gpa = gpa, .doc = doc, .fonts = fonts, .shape_arena = std.heap.ArenaAllocator.init(gpa), .scratch = std.heap.ArenaAllocator.init(gpa) };
    }

    pub fn deinit(L: *Layout) void {
        L.shape_cache.deinit(L.gpa);
        L.shape_arena.deinit();
        L.pending_abs.deinit(L.gpa);
        L.scratch.deinit();
    }

    pub fn shapeCached(L: *Layout, fid: font.FontId, text: []const u8, out: *std.ArrayList(font.Glyph), a: Allocator) !void {
        var h = std.hash.Wyhash.init(fid);
        h.update(text);
        const key = h.final();
        if (L.shape_cache.get(key)) |g| {
            try out.appendSlice(a, g);
            return;
        }
        if (L.shape_count > 20000) {
            L.shape_cache.clearRetainingCapacity();
            _ = L.shape_arena.reset(.retain_capacity);
            L.shape_count = 0;
        }
        var tmp: std.ArrayList(font.Glyph) = .empty;
        try L.fonts.shape(fid, text, &tmp, L.shape_arena.allocator());
        try L.shape_cache.put(L.gpa, key, tmp.items);
        L.shape_count += 1;
        try out.appendSlice(a, tmp.items);
    }

    // -----------------------------------------------------------------------
    // Tree access
    // -----------------------------------------------------------------------

    pub fn styleOf(L: *const Layout, it: Item) *const Style {
        const n = L.doc.node(it.node);
        if (it.pseudo != .none) {
            const ns = style_mod.get(n) orelse return &style_mod.default_style;
            const p = switch (it.pseudo) {
                .before => ns.before,
                .after => ns.after,
                .marker => ns.marker,
                .none => unreachable,
            };
            return p orelse &ns.s;
        }
        return style_mod.of(L.doc, it.node);
    }

    pub fn boxOf(L: *Layout, it: Item) !*Box {
        const n = L.doc.node(it.node);
        var b = boxOfNode(n);
        if (b == null) {
            const nb = try L.gpa.create(Box);
            nb.* = .{};
            n.box = nb;
            b = nb;
        }
        if (it.pseudo == .none) return b.?;
        const slot = &b.?.pseudo[@intFromEnum(it.pseudo) - 1];
        if (slot.* == null) {
            const pb = try L.gpa.create(Box);
            pb.* = .{};
            slot.* = pb;
        }
        return slot.*.?;
    }

    pub fn getBox(L: *const Layout, it: Item) ?*Box {
        const b = boxOfNode(L.doc.node(it.node)) orelse return null;
        if (it.pseudo == .none) return b;
        return b.pseudo[@intFromEnum(it.pseudo) - 1];
    }

    fn isWhitespaceText(L: *const Layout, id: NodeId) bool {
        const n = L.doc.node(id);
        if (n.kind != .text) return false;
        for (n.text.items) |c| if (!std.ascii.isWhitespace(c)) return false;
        return true;
    }

    /// Layout children of an element: ::before, element/text children, ::after.
    pub fn children(L: *const Layout, owner: Item, out: *std.ArrayList(Item), a: Allocator) !void {
        if (owner.pseudo != .none) return;
        const n = L.doc.node(owner.node);
        if (n.kind != .element) return;
        if (isReplaced(L.doc, owner.node)) return;
        const ns = style_mod.get(n);
        if (ns) |s| if (s.before != null) try out.append(a, .{ .node = owner.node, .pseudo = .before });
        var c = n.first_child;
        while (c != null_id) : (c = L.doc.node(c).next) {
            const cn = L.doc.node(c);
            if (cn.kind == .comment) continue;
            if (cn.kind == .element and style_mod.get(cn) == null) continue;
            try out.append(a, .{ .node = c });
        }
        if (ns) |s| if (s.after != null) try out.append(a, .{ .node = owner.node, .pseudo = .after });
    }

    // -----------------------------------------------------------------------
    // Entry point
    // -----------------------------------------------------------------------

    /// Lay out the document into a viewport. Returns true if anything was recomputed.
    pub fn run(L: *Layout, vw: f32, vh: f32) !bool {
        const doc = L.doc;
        const root_el = doc.documentElement();
        if (root_el == null_id) return false;
        if (vw != L.viewport_w or vh != L.viewport_h) {
            L.viewport_w = vw;
            L.viewport_h = vh;
            doc.node(root_el).flags.layout_dirty = true;
        }
        if (!doc.node(root_el).flags.layout_dirty and !doc.node(doc.root).flags.layout_dirty) return false;
        L.computed = 0;
        L.cache_hits = 0;
        _ = L.scratch.reset(.retain_capacity);
        L.invalidateDirty(doc.root);
        L.pending_abs.clearRetainingCapacity();
        const root = Item{ .node = root_el };
        const rb = try L.boxOf(root);
        const st = L.styleOf(root);
        const cb_w = vw;
        const m = resolveMargins(st, cb_w);
        _ = try L.compute(root, .{ .avail_w = .{ .definite = vw - m.left - m.right }, .avail_h = .{ .definite = vh }, .cb_w = vw, .cb_h = vh, .sizing = .fill });
        rb.x = m.left;
        rb.y = m.top;
        rb.margin = m;
        rb.placed = true;
        // the root establishes the initial containing block for everything left
        try L.layoutAbsolute(root, true);
        L.clearDirty(doc.root);
        return true;
    }

    fn invalidateDirty(L: *Layout, id: NodeId) void {
        const n = L.doc.node(id);
        if (!n.flags.layout_dirty) return;
        if (boxOfNode(n)) |b| {
            b.cache_len = 0;
            b.final = null;
            for (b.pseudo) |p| if (p) |pb| {
                pb.cache_len = 0;
                pb.final = null;
            };
        }
        var c = n.first_child;
        while (c != null_id) : (c = L.doc.node(c).next) L.invalidateDirty(c);
    }

    fn clearDirty(L: *Layout, id: NodeId) void {
        const n = L.doc.node(id);
        if (!n.flags.layout_dirty) return;
        n.flags.layout_dirty = false;
        n.flags.text_dirty = false;
        var c = n.first_child;
        while (c != null_id) : (c = L.doc.node(c).next) L.clearDirty(c);
    }

    // -----------------------------------------------------------------------
    // Dispatcher
    // -----------------------------------------------------------------------

    pub fn compute(L: *Layout, it: Item, in: Inputs) Allocator.Error!Output {
        const st = L.styleOf(it);
        const box = try L.boxOf(it);
        if (st.display == .none) {
            box.placed = false;
            box.w = 0;
            box.h = 0;
            return .{};
        }
        // cache
        if (in.perform) {
            if (box.final) |f| if (f.eql(in)) {
                L.cache_hits += 1;
                return box.final_out;
            };
        } else {
            for (box.cache[0..box.cache_len]) |e| if (e.in.eql(in)) {
                L.cache_hits += 1;
                return e.out;
            };
        }
        L.computed += 1;
        const cb_w = in.cb_w orelse 0;
        box.padding = resolvePadding(st, cb_w);
        box.border = st.borderWidths();
        if (in.perform) box.clearLayoutData(L.gpa);

        var out: Output = undefined;
        if (L.doc.node(it.node).kind == .text) {
            out = try L.layoutAnonText(it, st, box, in);
        } else if (it.pseudo == .none and isReplaced(L.doc, it.node)) {
            out = try L.layoutReplaced(it, st, box, in);
        } else if (st.isFlexContainer()) {
            out = try L.layoutFlex(it, st, box, in);
        } else if (st.isGridContainer()) {
            out = try grid.layoutGrid(L, it, st, box, in);
        } else {
            out = try L.layoutBlock(it, st, box, in);
        }
        if (in.perform) {
            box.w = out.w;
            box.h = out.h;
            box.baseline = out.baseline;
            box.final = in;
            box.final_out = out;
            if (st.position == .relative or st.position == .sticky) {
                const rel = relativeOffset(st, in.cb_w orelse 0, in.cb_h orelse 0);
                box.rel_x = rel[0];
                box.rel_y = rel[1];
            } else {
                box.rel_x = 0;
                box.rel_y = 0;
            }
            if (st.position != .static and it.pseudo == .none) try L.layoutAbsolute(it, false);
        } else {
            const slot = box.cache_next;
            box.cache[slot] = .{ .in = in, .out = out };
            box.cache_next = @intCast((slot + 1) % box.cache.len);
            if (box.cache_len < box.cache.len) box.cache_len += 1;
        }
        return out;
    }

    /// Border-box width for min-/max-content sizing.
    pub fn intrinsicWidth(L: *Layout, it: Item, which: enum { min, max }, cb_w: ?f32) !f32 {
        const out = try L.compute(it, .{ .avail_w = if (which == .min) .min_content else .max_content, .cb_w = cb_w, .sizing = .fit, .perform = false });
        return out.w;
    }

    // -----------------------------------------------------------------------
    // Size resolution helpers
    // -----------------------------------------------------------------------

    pub const Resolved = struct {
        w: ?f32,
        h: ?f32,
        min_w: f32,
        max_w: f32,
        min_h: f32,
        max_h: f32,
    };

    /// Specified sizes converted to border-box values (null = auto/indefinite).
    pub fn resolveSizes(st: *const Style, box: *const Box, cb_w: ?f32, cb_h: ?f32) Resolved {
        const pbw = box.padding.horizontal() + box.border.horizontal();
        const pbh = box.padding.vertical() + box.border.vertical();
        const bb = st.box_sizing == .border_box;
        const adjW = struct {
            fn f(v: ?f32, pb: f32, is_bb: bool) ?f32 {
                const x = v orelse return null;
                return if (is_bb) @max(x, pb) else x + pb;
            }
        }.f;
        var r: Resolved = .{
            .w = adjW(st.width.resolve(cb_w), pbw, bb),
            .h = adjW(st.height.resolve(cb_h), pbh, bb),
            .min_w = adjW(st.min_width.resolve(cb_w), pbw, bb) orelse pbw,
            .max_w = adjW(st.max_width.resolve(cb_w), pbw, bb) orelse std.math.inf(f32),
            .min_h = adjW(st.min_height.resolve(cb_h), pbh, bb) orelse pbh,
            .max_h = adjW(st.max_height.resolve(cb_h), pbh, bb) orelse std.math.inf(f32),
        };
        r.min_w = @max(r.min_w, pbw);
        r.min_h = @max(r.min_h, pbh);
        return r;
    }

    fn clampW(r: Resolved, w: f32) f32 {
        return @max(r.min_w, @min(w, r.max_w));
    }
    fn clampH(r: Resolved, h: f32) f32 {
        return @max(r.min_h, @min(h, r.max_h));
    }

    // -----------------------------------------------------------------------
    // Block layout
    // -----------------------------------------------------------------------

    const Run = struct {
        kind: enum { block, inline_run },
        start: usize,
        end: usize,
    };

    fn isBlockLevel(L: *const Layout, it: Item) bool {
        const st = L.styleOf(it);
        if (L.doc.node(it.node).kind == .text and it.pseudo == .none) return false;
        return switch (st.display) {
            .block, .flex, .grid, .list_item => true,
            else => false,
        };
    }

    fn establishesBfc(L: *const Layout, it: Item, st: *const Style) bool {
        if (L.doc.documentElement() == it.node and it.pseudo == .none) return true;
        if (st.clipsContent() or st.isOutOfFlow()) return true;
        if (st.display == .inline_block or st.isFlexContainer() or st.isGridContainer()) return true;
        if (it.pseudo == .none) {
            const p = L.doc.node(it.node).parent;
            if (p != null_id and L.doc.node(p).kind == .element) {
                const ps = style_mod.of(L.doc, p);
                if (ps.isFlexContainer() or ps.isGridContainer()) return true;
            }
        }
        return false;
    }

    fn layoutBlock(L: *Layout, it: Item, st: *const Style, box: *Box, in: Inputs) !Output {
        const a = L.scratch.allocator();
        var kids: std.ArrayList(Item) = .empty;
        try L.children(it, &kids, a);
        const pb = box.padding.add(box.border);
        var r = resolveSizes(st, box, in.cb_w, in.cb_h);
        if (in.content_only) {
            r.w = null;
            r.min_w = pb.horizontal();
            r.max_w = std.math.inf(f32);
        }
        const margins = resolveMargins(st, in.cb_w orelse 0);
        const mh = margins.left + margins.right;

        // ---- width ----
        var bw: f32 = undefined;
        if (in.known_w) |kw| {
            bw = kw;
        } else if (r.w) |w| {
            bw = clampW(r, w);
        } else {
            const fit = in.sizing == .fit or in.avail_w != .definite;
            if (!fit) {
                bw = clampW(r, in.avail_w.definite - mh);
            } else {
                const min_c = try L.blockIntrinsic(it, st, kids.items, .min, in) + pb.horizontal();
                const max_c = try L.blockIntrinsic(it, st, kids.items, .max, in) + pb.horizontal();
                bw = switch (in.avail_w) {
                    .definite => |av| @min(@max(min_c, av - mh), max_c),
                    .min_content => min_c,
                    .max_content => max_c,
                };
                bw = clampW(r, bw);
            }
        }
        const content_w = @max(0, bw - pb.horizontal());

        // definite height for percentage resolution of children
        var def_h: ?f32 = in.known_h orelse r.h;
        if (def_h == null and st.aspect_ratio != null and in.known_w == null and r.w != null) def_h = bw / st.aspect_ratio.?;
        const content_h_def: ?f32 = if (def_h) |h| @max(0, clampH(r, h) - pb.vertical()) else null;

        // When only measuring width, skip the children's vertical layout.
        if (!in.perform and in.known_h == null and in.avail_w != .definite and false) {}

        // ---- children ----
        const bfc = L.establishesBfc(it, st);
        const collapse_top = !bfc and pb.top == 0;
        const collapse_bottom = !bfc and pb.bottom == 0 and r.h == null and in.known_h == null;
        var y: f32 = pb.top;
        var prev_mb: MarginPair = .{};
        var first = true;
        var out: Output = .{};
        var max_right: f32 = 0;
        var first_baseline: ?f32 = null;
        var last_baseline: ?f32 = null;

        var runs: std.ArrayList(Run) = .empty;
        {
            var i: usize = 0;
            while (i < kids.items.len) {
                const k = kids.items[i];
                const kst = L.styleOf(k);
                if (kst.display == .none) {
                    if (in.perform) (try L.boxOf(k)).placed = false;
                    i += 1;
                    continue;
                }
                if (L.isBlockLevel(k) or (kst.isOutOfFlow() and L.doc.node(k.node).kind == .element)) {
                    try runs.append(a, .{ .kind = .block, .start = i, .end = i + 1 });
                    i += 1;
                    continue;
                }
                var j = i;
                while (j < kids.items.len) : (j += 1) {
                    const kk = kids.items[j];
                    const ks = L.styleOf(kk);
                    if (ks.display == .none) continue;
                    if (L.isBlockLevel(kk) or (ks.isOutOfFlow() and L.doc.node(kk.node).kind == .element)) break;
                }
                // skip runs that are only collapsible whitespace
                var only_ws = true;
                for (kids.items[i..j]) |kk| {
                    if (!(L.doc.node(kk.node).kind == .text and kk.pseudo == .none and L.isWhitespaceText(kk.node) and collapsesWs(L.styleOf(kk)))) {
                        only_ws = false;
                        break;
                    }
                }
                if (!only_ws) try runs.append(a, .{ .kind = .inline_run, .start = i, .end = j });
                i = j;
            }
        }
        const sole_inline = runs.items.len == 1 and runs.items[0].kind == .inline_run;

        for (runs.items) |rn| {
            switch (rn.kind) {
                .block => {
                    const k = kids.items[rn.start];
                    const kst = L.styleOf(k);
                    const kbox = try L.boxOf(k);
                    if (kst.isOutOfFlow()) {
                        if (in.perform) {
                            // static position: where it would have been in flow
                            try L.pending_abs.append(L.gpa, .{ .item = k, .parent = it, .sx = pb.left, .sy = y + prev_mb.resolve() });
                            kbox.placed = true;
                        }
                        continue;
                    }
                    const km = resolveMargins(kst, content_w);
                    const kout = try L.compute(k, .{ .avail_w = .{ .definite = content_w }, .avail_h = if (content_h_def) |h| .{ .definite = h } else .max_content, .cb_w = content_w, .cb_h = content_h_def, .sizing = .fill, .perform = in.perform });
                    var mt = MarginPair{};
                    mt = mt.add(km.top);
                    if (kout.collapsed_mt) |cm| mt = mt.join(cm);
                    const joined = prev_mb.join(mt);
                    var ky: f32 = undefined;
                    if (first and collapse_top) {
                        out.collapsed_mt = joined;
                        ky = y;
                    } else {
                        ky = y + joined.resolve();
                    }
                    first = false;
                    // horizontal placement with auto margins
                    var ml = km.left;
                    const free = content_w - kout.w - km.left - km.right;
                    const auto_l = kst.margin[3] == .auto;
                    const auto_r = kst.margin[1] == .auto;
                    if (auto_l and auto_r) {
                        ml = @max(0, free / 2);
                    } else if (auto_l) {
                        ml = @max(0, free + km.left);
                    }
                    if (in.perform) {
                        kbox.x = pb.left + ml;
                        kbox.y = ky;
                        kbox.margin = .{ .top = km.top, .right = km.right, .bottom = km.bottom, .left = ml };
                        kbox.placed = true;
                        kbox.in_inline = false;
                    }
                    if (first_baseline == null) if (kout.baseline) |b| {
                        first_baseline = ky + b;
                    };
                    if (kout.last_baseline orelse kout.baseline) |b| last_baseline = ky + b;
                    y = ky + kout.h;
                    max_right = @max(max_right, ml + kout.w + km.right);
                    var mb = MarginPair{};
                    mb = mb.add(km.bottom);
                    if (kout.collapsed_mb) |cm| mb = mb.join(cm);
                    prev_mb = mb;
                },
                .inline_run => {
                    const il = try L.buildInline(it, st, kids.items[rn.start..rn.end], if (in.avail_w == .definite or in.known_w != null or r.w != null or in.perform) content_w else null, in.perform, content_w);
                    const ky = y + prev_mb.resolve();
                    prev_mb = .{};
                    first = false;
                    if (first_baseline == null and il.lines.len > 0) first_baseline = ky + il.first_baseline;
                    if (il.lines.len > 0) last_baseline = ky + il.last_baseline;
                    y = ky + il.height;
                    max_right = @max(max_right, il.width);
                    if (in.perform) {
                        try L.placeAtomics(il, ky, pb);
                        if (sole_inline) {
                            box.inline_layout = il;
                        } else {
                            try box.anon.append(L.gpa, .{ .y = ky, .il = il });
                        }
                    } else il.destroy(L.gpa);
                },
            }
        }

        var content_h = y - pb.top;
        if (collapse_bottom and !first) {
            out.collapsed_mb = prev_mb;
        } else {
            content_h += prev_mb.resolve();
        }
        var bh: f32 = undefined;
        if (in.known_h) |kh| {
            bh = kh;
        } else if (def_h) |h| {
            bh = clampH(r, h);
        } else {
            bh = clampH(r, content_h + pb.vertical());
        }
        // a box with min-height/height larger than content keeps collapsed margins inside
        if (out.collapsed_mb != null and bh > content_h + pb.vertical() + 0.01) {
            out.collapsed_mb = null;
        }
        // <button> centers its content vertically
        if (it.pseudo == .none and L.doc.node(it.node).tag == L.doc.atoms.button and in.perform) {
            const extra = bh - pb.vertical() - content_h;
            if (extra > 0.5) L.shiftChildren(it, box, extra / 2);
        }
        out.w = bw;
        out.h = bh;
        out.baseline = first_baseline;
        out.last_baseline = last_baseline;
        if (st.clipsContent()) {
            // scroll containers: baseline synthesized from the bottom edge for inline-block
            if (st.display == .inline_block) out.last_baseline = bh;
        }
        if (in.perform) {
            box.scroll_w = @max(box.w - box.border.horizontal(), max_right + pb.left - box.border.left + box.padding.right);
            box.scroll_h = @max(box.h - box.border.vertical(), y - box.border.top + box.padding.bottom);
        }
        return out;
    }

    fn shiftChildren(L: *Layout, it: Item, box: *Box, dy: f32) void {
        if (box.inline_layout) |il| shiftInline(il, dy);
        for (box.anon.items) |*an| an.y += dy;
        var kids: std.ArrayList(Item) = .empty;
        L.children(it, &kids, L.scratch.allocator()) catch return;
        for (kids.items) |k| {
            if (L.getBox(k)) |kb| if (kb.placed) {
                kb.y += dy;
            };
        }
    }

    fn blockIntrinsic(L: *Layout, it: Item, st: *const Style, kids: []const Item, which: enum { min, max }, in: Inputs) !f32 {
        _ = in;
        var w: f32 = 0;
        var i: usize = 0;
        while (i < kids.len) {
            const k = kids[i];
            const kst = L.styleOf(k);
            if (kst.display == .none or (kst.isOutOfFlow() and L.doc.node(k.node).kind == .element)) {
                i += 1;
                continue;
            }
            if (L.isBlockLevel(k)) {
                const km = resolveMargins(kst, 0);
                const kw = try L.intrinsicWidth(k, if (which == .min) .min else .max, null);
                w = @max(w, kw + km.left + km.right);
                i += 1;
                continue;
            }
            var j = i;
            while (j < kids.len and !L.isBlockLevel(kids[j])) : (j += 1) {}
            const il = try L.buildInline(it, st, kids[i..j], null, false, 0);
            w = @max(w, if (which == .min) il.min_content else il.max_content);
            il.destroy(L.gpa);
            i = j;
        }
        return w;
    }

    fn placeAtomics(L: *Layout, il: *InlineLayout, dy: f32, pb: Edges) !void {
        for (il.frags) |f| {
            if (f.kind != .atomic) continue;
            const kb = try L.boxOf(f.item);
            kb.x = pb.left + f.x;
            kb.y = dy + f.y;
            kb.placed = true;
            kb.in_inline = true;
        }
    }

    /// Text directly inside a flex/grid container becomes an anonymous block.
    fn layoutAnonText(L: *Layout, it: Item, st: *const Style, box: *Box, in: Inputs) !Output {
        _ = st;
        const parent = L.doc.node(it.node).parent;
        const pst = style_mod.of(L.doc, parent);
        box.padding = .{};
        box.border = .{};
        const items = [_]Item{it};
        const avail: ?f32 = in.known_w orelse switch (in.avail_w) {
            .definite => |v| v,
            .min_content => 0,
            .max_content => null,
        };
        const il = try L.buildInline(.{ .node = parent }, pst, &items, avail, in.perform, avail orelse 0);
        const w = in.known_w orelse switch (in.avail_w) {
            .definite => |v| if (in.sizing == .fit) @min(v, il.max_content) else v,
            .min_content => il.min_content,
            .max_content => il.max_content,
        };
        const out: Output = .{ .w = w, .h = in.known_h orelse il.height, .baseline = il.first_baseline, .last_baseline = il.last_baseline };
        if (in.perform) {
            box.inline_layout = il;
            box.scroll_w = w;
            box.scroll_h = il.height;
        } else il.destroy(L.gpa);
        return out;
    }

    // -----------------------------------------------------------------------
    // Inline formatting context
    // -----------------------------------------------------------------------

    pub fn buildInline(L: *Layout, owner: Item, owner_st: *const Style, kids: []const Item, avail: ?f32, perform: bool, cb_w: f32) !*InlineLayout {
        var arena_state = std.heap.ArenaAllocator.init(L.gpa);
        defer arena_state.deinit();
        var b = inline_mod.Builder{ .L = L, .gpa = L.gpa, .arena = arena_state.allocator() };
        // ::marker for list items
        if (owner.pseudo == .none and owner_st.display == .list_item and kids.len > 0) {
            try L.addMarker(&b, owner, owner_st);
        }
        for (kids) |k| try L.collectInline(&b, k, cb_w, avail);
        const clip = owner_st.overflow_x != .visible;
        return b.finish(.{ .owner = owner, .owner_style = owner_st, .avail = avail, .perform = perform, .indent = owner_st.text_indent.resolve(cb_w), .clip_x = clip });
    }

    fn addMarker(L: *Layout, b: *inline_mod.Builder, owner: Item, st: *const Style) !void {
        _ = L;
        var buf: [32]u8 = undefined;
        const text: []const u8 = switch (st.list_style_type) {
            .none => return,
            .disc => "\u{2022} ",
            .circle => "\u{25e6} ",
            .square => "\u{25aa} ",
            .decimal => blk: {
                // ordinal among list-item siblings
                const doc = b.L.doc;
                var idx: usize = 1;
                var p = doc.node(owner.node).prev;
                while (p != null_id) : (p = doc.node(p).prev) {
                    if (doc.node(p).kind == .element and style_mod.of(doc, p).display == .list_item) idx += 1;
                }
                break :blk std.fmt.bufPrint(&buf, "{d}. ", .{idx}) catch "";
            },
        };
        try b.addText(.{ .node = owner.node, .pseudo = .marker }, st, text);
    }

    fn collectInline(L: *Layout, b: *inline_mod.Builder, k: Item, cb_w: f32, avail: ?f32) Allocator.Error!void {
        const doc = L.doc;
        const n = doc.node(k.node);
        const kst = L.styleOf(k);
        if (kst.display == .none) {
            if (L.getBox(k)) |kb| kb.placed = false;
            return;
        }
        if (n.kind == .text and k.pseudo == .none) {
            try b.addText(k, kst, n.text.items);
            return;
        }
        if (k.pseudo == .before or k.pseudo == .after) {
            if (kst.isOutOfFlow()) {
                try L.pending_abs.append(L.gpa, .{ .item = k, .parent = .{ .node = k.node }, .sx = 0, .sy = 0 });
                (try L.boxOf(k)).placed = true;
                return;
            }
            if (kst.display == .inline_) {
                try b.addOpen(k, kst, inlineEdge(kst, cb_w, true));
                try b.addText(k, kst, kst.content orelse "");
                try b.addClose(k, kst, inlineEdge(kst, cb_w, false));
                return;
            }
            // inline-block pseudo: atomic box with the content as text
            try L.addAtomicItem(b, k, kst, cb_w, avail);
            return;
        }
        if (kst.isOutOfFlow()) {
            // static position is approximated at the line start
            try L.pending_abs.append(L.gpa, .{ .item = k, .parent = .{ .node = n.parent }, .sx = 0, .sy = 0 });
            (try L.boxOf(k)).placed = true;
            return;
        }
        if (n.tag == doc.atoms.br) {
            try b.addBreak(k, kst);
            return;
        }
        if (kst.display == .inline_ and !isReplaced(doc, k.node)) {
            if (L.getBox(k)) |kb| kb.placed = false;
            try b.addOpen(k, kst, inlineEdge(kst, cb_w, true));
            var kids: std.ArrayList(Item) = .empty;
            try L.children(k, &kids, L.scratch.allocator());
            for (kids.items) |c| try L.collectInline(b, c, cb_w, avail);
            try b.addClose(k, kst, inlineEdge(kst, cb_w, false));
            return;
        }
        try L.addAtomicItem(b, k, kst, cb_w, avail);
    }

    fn addAtomicItem(L: *Layout, b: *inline_mod.Builder, k: Item, kst: *const Style, cb_w: f32, avail: ?f32) !void {
        const km = resolveMargins(kst, cb_w);
        const avail_w: Avail = if (avail) |av| .{ .definite = @max(0, av - km.left - km.right) } else .max_content;
        const out = try L.compute(k, .{ .avail_w = avail_w, .cb_w = cb_w, .sizing = .fit, .perform = true });
        const kb = try L.boxOf(k);
        kb.margin = km;
        try b.addAtomic(k, kst, out.w, out.h, out.last_baseline orelse out.baseline, km);
    }

    // -----------------------------------------------------------------------
    // Replaced elements and form controls
    // -----------------------------------------------------------------------

    fn layoutReplaced(L: *Layout, it: Item, st: *const Style, box: *Box, in: Inputs) !Output {
        const doc = L.doc;
        const n = doc.node(it.node);
        const w = &doc.atoms;
        const r = resolveSizes(st, box, in.cb_w, in.cb_h);
        const pbw = box.padding.horizontal() + box.border.horizontal();
        const pbh = box.padding.vertical() + box.border.vertical();

        const is_text_control = n.tag == w.textarea or (n.tag == w.input and isTextInput(doc, it.node)) or n.tag == w.select;
        // natural content size
        var nat_w: f32 = 0;
        var nat_h: f32 = 0;
        var ratio: ?f32 = st.aspect_ratio;
        var il: ?*InlineLayout = null;
        if (is_text_control) {
            const text = L.controlText(it.node);
            const placeholder = if (text.len == 0) doc.node(it.node).getAttr(w.placeholder) else null;
            var arena_state = std.heap.ArenaAllocator.init(L.gpa);
            defer arena_state.deinit();
            var b = inline_mod.Builder{ .L = L, .gpa = L.gpa, .arena = arena_state.allocator() };
            const ns = style_mod.get(n);
            if (placeholder) |ph| {
                const ph_style: *const Style = if (ns) |s| (s.placeholder orelse st) else st;
                try b.addText(.{ .node = it.node, .pseudo = .marker }, ph_style, ph);
            } else {
                try b.addText(.{ .node = it.node }, st, text);
            }
            const fid = L.fonts.resolve(fontSpec(st));
            const m = L.fonts.metrics(fid);
            nat_h = st.line_height.resolve(st.font_size, (m.ascent + m.descent + m.line_gap) / st.font_size);
            const multiline = n.tag == w.textarea;
            const known_content_w: ?f32 = if (in.known_w) |kw| kw - pbw else if (r.w) |rw| rw - pbw else null;
            const lay = try b.finish(.{ .owner = it, .owner_style = st, .avail = if (multiline) known_content_w else null, .perform = in.perform, .clip_x = false });
            il = lay;
            const line_h = nat_h;
            // intrinsic sizes as in HTML: `size` (input, default 20) or
            // `cols` x `rows` (textarea, default 20 x 2) average characters
            const avg_char = st.font_size * if (multiline) @as(f32, 0.6) else 0.55;
            nat_w = if (n.tag == w.select)
                lay.max_content + 16
            else if (multiline)
                (attrNumber(n, w.cols) orelse 20) * avg_char
            else
                (attrNumber(n, w.size) orelse 20) * avg_char;
            if (multiline) nat_h = line_h * (attrNumber(n, w.rows) orelse 2);
        } else if (n.tag == w.img) {
            if (L.hooks.natural_size) |f| if (f(L.hooks.ctx, doc, it.node)) |sz| {
                nat_w = sz[0];
                nat_h = sz[1];
                if (sz[1] > 0) ratio = ratio orelse sz[0] / sz[1];
            };
            if (attrNumber(n, w.width)) |aw| nat_w = aw;
            if (attrNumber(n, w.height)) |ah| nat_h = ah;
            if (attrNumber(n, w.width) != null and attrNumber(n, w.height) != null and nat_h > 0) ratio = ratio orelse nat_w / nat_h;
        } else if (n.tag == w.input or n.tag == w.progress) {
            nat_w = 0;
            nat_h = 0;
        } else {
            // canvas, electrobun-wgpu, electrobun-webview, video, iframe-like
            nat_w = attrNumber(n, w.width) orelse 300;
            nat_h = attrNumber(n, w.height) orelse 150;
            ratio = ratio orelse nat_w / nat_h;
        }

        var bw: ?f32 = in.known_w orelse r.w;
        var bh: ?f32 = in.known_h orelse r.h;
        if (bw == null and bh != null and ratio != null) bw = (bh.? - pbh) * ratio.? + pbw;
        if (bh == null and bw != null and ratio != null and ratio.? > 0) bh = (bw.? - pbw) / ratio.? + pbh;
        var fw = bw orelse nat_w + pbw;
        if (bw == null and in.sizing == .fill and n.tag != w.img and !is_text_control and false) fw = in.avail_w.val() orelse fw;
        fw = clampW(r, fw);
        var fh = bh orelse nat_h + pbh;
        fh = clampH(r, fh);
        const out: Output = .{ .w = fw, .h = fh, .baseline = if (il) |l| box.padding.top + box.border.top + l.first_baseline + centerOffset(fh - pbh, l, n.tag == w.textarea) else null };
        if (in.perform) {
            if (il) |l| {
                if (n.tag != w.textarea) shiftInline(l, centerOffset(fh - pbh, l, false));
                box.inline_layout = l;
                box.scroll_w = @max(fw - box.border.horizontal(), l.width + box.padding.horizontal());
                box.scroll_h = @max(fh - box.border.vertical(), l.height + box.padding.vertical());
            } else {
                box.scroll_w = fw - box.border.horizontal();
                box.scroll_h = fh - box.border.vertical();
            }
        } else if (il) |l| l.destroy(L.gpa);
        return out;
    }

    fn centerOffset(content_h: f32, il: *const InlineLayout, top_aligned: bool) f32 {
        if (top_aligned) return 0;
        return @max(0, (content_h - il.height) / 2);
    }

    pub fn controlText(L: *Layout, id: NodeId) []const u8 {
        const doc = L.doc;
        if (L.hooks.control_text) |f| if (f(L.hooks.ctx, doc, id)) |t| return t;
        const n = doc.node(id);
        if (n.tag == doc.atoms.select) {
            // text of the selected (or first) option
            var first: ?NodeId = null;
            var cur = doc.nextInTree(id, id);
            while (cur != null_id) : (cur = doc.nextInTree(cur, id)) {
                const cn = doc.node(cur);
                if (cn.kind == .element and cn.tag == doc.atoms.option) {
                    if (first == null) first = cur;
                    if (cn.hasAttr(doc.atoms.selected)) {
                        first = cur;
                        break;
                    }
                }
            }
            if (first) |o| {
                const on = doc.node(o);
                if (on.first_child != null_id and doc.node(on.first_child).kind == .text) return std.mem.trim(u8, doc.node(on.first_child).text.items, " \n\t");
            }
            return "";
        }
        if (n.tag == doc.atoms.textarea) {
            if (n.first_child != null_id and doc.node(n.first_child).kind == .text) return doc.node(n.first_child).text.items;
            return "";
        }
        const v = n.getAttr(doc.atoms.value) orelse return "";
        if (n.getAttr(doc.atoms.type)) |t| if (std.ascii.eqlIgnoreCase(t, "password")) return L.passwordMask(v);
        return v;
    }

    /// The bullets shown for a password value: one per codepoint.
    pub fn passwordMask(L: *Layout, value: []const u8) []const u8 {
        const bullet = inline_mod.password_bullet;
        const n = std.unicode.utf8CountCodepoints(value) catch value.len;
        const buf = L.scratch.allocator().alloc(u8, n * bullet.len) catch return "";
        for (0..n) |i| @memcpy(buf[i * bullet.len ..][0..bullet.len], bullet);
        return buf;
    }

    // -----------------------------------------------------------------------
    // Flexbox
    // -----------------------------------------------------------------------

    const FlexItem = struct {
        item: Item,
        st: *const Style,
        margin: Edges,
        auto_ms: bool = false,
        auto_me: bool = false,
        auto_cs: bool = false,
        auto_ce: bool = false,
        base: f32 = 0,
        hyp: f32 = 0,
        min_main: f32 = 0,
        max_main: f32 = std.math.inf(f32),
        min_cross: f32 = 0,
        max_cross: f32 = std.math.inf(f32),
        target: f32 = 0,
        frozen: bool = false,
        cross: f32 = 0,
        definite_cross: ?f32 = null,
        baseline: f32 = 0,
        main_pos: f32 = 0,
        cross_pos: f32 = 0,
        order: i32 = 0,
        index: usize = 0,

        fn outerMain(f: *const FlexItem, row: bool) f32 {
            return if (row) f.margin.left + f.margin.right else f.margin.top + f.margin.bottom;
        }
        fn outerCross(f: *const FlexItem, row: bool) f32 {
            return if (row) f.margin.top + f.margin.bottom else f.margin.left + f.margin.right;
        }
    };

    const FlexLine = struct {
        start: usize,
        end: usize,
        cross: f32 = 0,
        pos: f32 = 0,
        max_baseline: f32 = 0,
    };

    fn layoutFlex(L: *Layout, it: Item, st: *const Style, box: *Box, in: Inputs) !Output {
        const a = L.scratch.allocator();
        const row = st.isRow();
        const main_reverse = st.flex_direction == .row_reverse or st.flex_direction == .column_reverse;
        const wrap = st.flex_wrap != .nowrap;
        const cross_reverse = st.flex_wrap == .wrap_reverse;
        const pb = box.padding.add(box.border);
        const r = resolveSizes(st, box, in.cb_w, in.cb_h);
        const margins = resolveMargins(st, in.cb_w orelse 0);

        // container border-box width when known
        var bw: ?f32 = in.known_w orelse (if (r.w) |w| clampW(r, w) else null);
        if (bw == null and in.sizing == .fill and in.avail_w == .definite) bw = clampW(r, in.avail_w.definite - margins.left - margins.right);
        var bh: ?f32 = in.known_h orelse (if (r.h) |h| clampH(r, h) else null);
        if (bh == null and st.aspect_ratio != null and bw != null) bh = bw.? / st.aspect_ratio.?;

        // collect items
        var kids: std.ArrayList(Item) = .empty;
        try L.children(it, &kids, a);
        var items: std.ArrayList(FlexItem) = .empty;
        for (kids.items) |k| {
            const kst = L.styleOf(k);
            const kn = L.doc.node(k.node);
            if (kst.display == .none) {
                if (in.perform) (try L.boxOf(k)).placed = false;
                continue;
            }
            if (kn.kind == .text and k.pseudo == .none and L.isWhitespaceText(k.node)) continue;
            if (kst.isOutOfFlow() and !(kn.kind == .text and k.pseudo == .none)) {
                if (in.perform) {
                    try L.pending_abs.append(L.gpa, .{ .item = k, .parent = it, .sx = pb.left, .sy = pb.top });
                    (try L.boxOf(k)).placed = true;
                }
                continue;
            }
            const cbw_for_margin = if (bw) |w| w - pb.horizontal() else 0;
            const m = resolveMargins(kst, cbw_for_margin);
            try items.append(a, .{
                .item = k,
                .st = kst,
                .margin = m,
                .order = kst.order,
                .index = items.items.len,
                .auto_ms = if (row) kst.margin[3] == .auto else kst.margin[0] == .auto,
                .auto_me = if (row) kst.margin[1] == .auto else kst.margin[2] == .auto,
                .auto_cs = if (row) kst.margin[0] == .auto else kst.margin[3] == .auto,
                .auto_ce = if (row) kst.margin[2] == .auto else kst.margin[1] == .auto,
            });
        }
        std.mem.sort(FlexItem, items.items, {}, struct {
            fn lt(_: void, x: FlexItem, y: FlexItem) bool {
                if (x.order != y.order) return x.order < y.order;
                return x.index < y.index;
            }
        }.lt);

        // inner sizes
        var inner_w: ?f32 = if (bw) |w| @max(0, w - pb.horizontal()) else null;
        var inner_h: ?f32 = if (bh) |h| @max(0, h - pb.vertical()) else null;
        const main_gap = if (row) st.column_gap.resolve(inner_w orelse 0) else st.row_gap.resolve(inner_h orelse 0);
        const cross_gap = if (row) st.row_gap.resolve(inner_h orelse 0) else st.column_gap.resolve(inner_w orelse 0);

        // intrinsic container width when not known (row: sum/max; column: max)
        if (inner_w == null) {
            const mode: enum { min, max } = switch (in.avail_w) {
                .min_content => .min,
                else => .max,
            };
            var acc: f32 = 0;
            var mx: f32 = 0;
            for (items.items, 0..) |*f, i| {
                const iw = try L.intrinsicWidth(f.item, if (mode == .min) .min else .max, null);
                const ow = iw + f.margin.left + f.margin.right;
                if (row) {
                    if (mode == .min and wrap) {
                        mx = @max(mx, ow);
                    } else {
                        acc += ow;
                        if (i > 0) acc += main_gap;
                    }
                } else mx = @max(mx, ow);
            }
            var cw = if (row and !(mode == .min and wrap)) acc else mx;
            if (in.avail_w == .definite) cw = @min(cw, @max(0, in.avail_w.definite - margins.left - margins.right - pb.horizontal()));
            // flex items' min-content contributions can still exceed avail
            const full = clampW(r, cw + pb.horizontal());
            bw = full;
            inner_w = full - pb.horizontal();
        }
        const inner_main: ?f32 = if (row) inner_w else inner_h;
        const inner_cross: ?f32 = if (row) inner_h else inner_w;
        const cb_w = inner_w;
        const cb_h = inner_h;

        // ---- flex base sizes ----
        for (items.items) |*f| {
            const kbox = try L.boxOf(f.item);
            kbox.padding = resolvePadding(f.st, cb_w orelse 0);
            kbox.border = f.st.borderWidths();
            const kr = resolveSizes(f.st, kbox, cb_w, cb_h);
            const spec_main: ?f32 = if (row) kr.w else kr.h;
            const kpb_main = if (row) kbox.padding.horizontal() + kbox.border.horizontal() else kbox.padding.vertical() + kbox.border.vertical();
            f.min_cross = if (row) kr.min_h else kr.min_w;
            f.max_cross = if (row) kr.max_h else kr.max_w;
            f.max_main = if (row) kr.max_w else kr.max_h;
            f.definite_cross = if (row) kr.h else kr.w;

            var base: ?f32 = null;
            switch (f.st.flex_basis) {
                .len => |l| if (!(l.pct != 0 and inner_main == null)) {
                    const v = l.resolve(inner_main orelse 0);
                    base = if (f.st.box_sizing == .border_box) @max(v, kpb_main) else v + kpb_main;
                },
                .auto => base = spec_main,
                else => {},
            }
            if (base == null) {
                // content size
                if (row) {
                    const known_h: ?f32 = f.definite_cross;
                    const o = try L.compute(f.item, .{ .known_h = known_h, .avail_w = .max_content, .avail_h = if (inner_cross) |c| .{ .definite = c } else .max_content, .cb_w = cb_w, .cb_h = cb_h, .sizing = .fit, .perform = false });
                    base = o.w;
                } else {
                    var known_w: ?f32 = f.definite_cross;
                    if (known_w == null and inner_cross != null and itemAlign(st, f.st) == .stretch and !f.auto_cs and !f.auto_ce) known_w = clampCross(f, inner_cross.? - f.outerCross(row));
                    const o = try L.compute(f.item, .{ .known_w = known_w, .avail_w = if (inner_cross) |c| .{ .definite = c - f.outerCross(row) } else .max_content, .avail_h = .max_content, .cb_w = cb_w, .cb_h = cb_h, .sizing = .fit, .perform = false });
                    base = o.h;
                }
            }
            f.base = base.?;
            // automatic minimum size
            const spec_min: ?f32 = if (row) (if (f.st.min_width == .auto) null else kr.min_w) else (if (f.st.min_height == .auto) null else kr.min_h);
            if (spec_min) |sm| {
                f.min_main = sm;
            } else if (f.st.clipsContent()) {
                f.min_main = kpb_main;
            } else {
                var content_min: f32 = undefined;
                if (row) {
                    const o = try L.compute(f.item, .{ .avail_w = .min_content, .cb_w = cb_w, .sizing = .fit, .perform = false, .content_only = !isReplaced(L.doc, f.item.node) });
                    content_min = o.w;
                } else {
                    var known_w: ?f32 = f.definite_cross;
                    if (known_w == null and inner_cross != null and itemAlign(st, f.st) == .stretch) known_w = clampCross(f, inner_cross.? - f.outerCross(row));
                    const o = try L.compute(f.item, .{ .known_w = known_w, .avail_w = if (inner_cross) |c| .{ .definite = c - f.outerCross(row) } else .max_content, .avail_h = .min_content, .cb_w = cb_w, .cb_h = null, .sizing = .fit, .perform = false });
                    content_min = o.h;
                }
                if (spec_main) |sm| content_min = @min(content_min, sm);
                content_min = @min(content_min, f.max_main);
                f.min_main = @max(content_min, kpb_main);
            }
            f.hyp = @max(f.min_main, @min(f.base, f.max_main));
        }

        // ---- lines ----
        var lines: std.ArrayList(FlexLine) = .empty;
        {
            var start: usize = 0;
            var used: f32 = 0;
            for (items.items, 0..) |*f, i| {
                const outer = f.hyp + f.outerMain(row);
                if (wrap and inner_main != null and i > start and used + main_gap + outer > inner_main.? + 0.01) {
                    try lines.append(a, .{ .start = start, .end = i });
                    start = i;
                    used = 0;
                }
                used += outer + (if (i > start) main_gap else 0);
            }
            try lines.append(a, .{ .start = start, .end = items.items.len });
        }

        // ---- resolve flexible lengths ----
        var max_line_main: f32 = 0;
        for (lines.items) |*line| {
            const li = items.items[line.start..line.end];
            const gaps = main_gap * @as(f32, @floatFromInt(@max(1, li.len) - 1));
            var sum_hyp: f32 = 0;
            for (li) |*f| sum_hyp += f.hyp + f.outerMain(row);
            const container_main = inner_main orelse (sum_hyp + gaps);
            resolveFlexible(li, container_main - gaps, row);
            var used: f32 = gaps;
            for (li) |*f| used += f.target + f.outerMain(row);
            max_line_main = @max(max_line_main, used);
        }

        // ---- cross sizes ----
        for (items.items) |*f| {
            const known_main = f.target;
            var o: Output = undefined;
            const stretch_cross: ?f32 = if (f.definite_cross == null and !wrap and inner_cross != null and itemAlign(st, f.st) == .stretch and !f.auto_cs and !f.auto_ce) clampCross(f, inner_cross.? - f.outerCross(row)) else null;
            if (row) {
                o = try L.compute(f.item, .{ .known_w = known_main, .known_h = f.definite_cross orelse stretch_cross, .avail_w = .{ .definite = known_main }, .avail_h = if (inner_cross) |c| .{ .definite = c } else .max_content, .cb_w = cb_w, .cb_h = cb_h, .perform = false });
                f.cross = o.h;
            } else {
                o = try L.compute(f.item, .{ .known_h = known_main, .known_w = f.definite_cross orelse stretch_cross, .avail_w = if (inner_cross) |c| .{ .definite = c - f.outerCross(row) } else .max_content, .avail_h = .{ .definite = known_main }, .cb_w = cb_w, .cb_h = cb_h, .sizing = .fit, .perform = false });
                f.cross = o.w;
            }
            f.baseline = if (row) (o.baseline orelse o.h) + f.margin.top else 0;
        }
        for (lines.items) |*line| {
            var mx: f32 = 0;
            var max_base: f32 = 0;
            var max_below: f32 = 0;
            for (items.items[line.start..line.end]) |*f| {
                if (row and itemAlign(st, f.st) == .baseline and !f.auto_cs and !f.auto_ce) {
                    max_base = @max(max_base, f.baseline);
                    max_below = @max(max_below, f.cross + f.outerCross(row) - f.baseline);
                } else mx = @max(mx, f.cross + f.outerCross(row));
            }
            line.max_baseline = max_base;
            line.cross = @max(mx, max_base + max_below);
        }
        if (!wrap and inner_cross != null and lines.items.len == 1) lines.items[0].cross = inner_cross.?;

        // container cross size
        var total_cross: f32 = 0;
        for (lines.items, 0..) |l, i| total_cross += l.cross + (if (i > 0) cross_gap else 0);
        if (row) {
            if (bh == null) {
                bh = clampH(r, total_cross + pb.vertical());
                inner_h = bh.? - pb.vertical();
            }
        } else {
            if (bh == null) {
                bh = clampH(r, max_line_main + pb.vertical());
                inner_h = bh.? - pb.vertical();
            }
        }
        const final_inner_main = (if (row) inner_w else inner_h).?;
        const final_inner_cross = (if (row) inner_h else inner_w).?;

        // align-content
        if (wrap or lines.items.len > 1 or true) {
            const free = final_inner_cross - total_cross;
            var pos: f32 = 0;
            var between: f32 = cross_gap;
            const n_lines: f32 = @floatFromInt(lines.items.len);
            const ac = st.align_content;
            if (wrap and (ac == .normal or ac == .stretch) and free > 0) {
                const add = free / n_lines;
                for (lines.items) |*l| l.cross += add;
            } else if (wrap) {
                switch (ac) {
                    .center => pos = free / 2,
                    .flex_end, .end => pos = free,
                    .space_between => if (lines.items.len > 1) {
                        between += @max(0, free) / (n_lines - 1);
                    },
                    .space_around => {
                        pos = @max(0, free) / n_lines / 2;
                        between += @max(0, free) / n_lines;
                    },
                    .space_evenly => {
                        pos = @max(0, free) / (n_lines + 1);
                        between += @max(0, free) / (n_lines + 1);
                    },
                    else => {},
                }
            }
            if (!wrap and lines.items.len == 1) lines.items[0].cross = final_inner_cross;
            for (lines.items) |*l| {
                l.pos = pos;
                pos += l.cross + between;
            }
        }

        // ---- main-axis alignment, stretch and final layout ----
        var first_baseline: ?f32 = null;
        for (lines.items) |*line| {
            const li = items.items[line.start..line.end];
            const n: f32 = @floatFromInt(li.len);
            var used: f32 = main_gap * @max(0, n - 1);
            var auto_count: f32 = 0;
            for (li) |*f| {
                used += f.target + f.outerMain(row);
                if (f.auto_ms) auto_count += 1;
                if (f.auto_me) auto_count += 1;
            }
            const free = final_inner_main - used;
            var pos: f32 = 0;
            var between: f32 = main_gap;
            var auto_size: f32 = 0;
            if (auto_count > 0 and free > 0) {
                auto_size = free / auto_count;
            } else {
                const jc = st.justify_content;
                switch (jc) {
                    .center => pos = free / 2,
                    .flex_end => pos = free,
                    .end, .right => pos = if (main_reverse) 0 else free,
                    .start, .left => pos = if (main_reverse) free else 0,
                    .space_between => if (li.len > 1 and free > 0) {
                        between += free / (n - 1);
                    },
                    .space_around => if (free > 0) {
                        pos = free / n / 2;
                        between += free / n;
                    } else {
                        pos = free / 2;
                    },
                    .space_evenly => if (free > 0) {
                        pos = free / (n + 1);
                        between += free / (n + 1);
                    } else {
                        pos = free / 2;
                    },
                    else => {},
                }
            }
            for (li) |*f| {
                const ms = if (row) f.margin.left else f.margin.top;
                const me = if (row) f.margin.right else f.margin.bottom;
                pos += ms + (if (f.auto_ms) auto_size else 0);
                f.main_pos = pos;
                pos += f.target + me + (if (f.auto_me) auto_size else 0) + between;
            }

            for (li) |*f| {
                // cross size: stretch
                const al = itemAlign(st, f.st);
                var cross = f.cross;
                if (al == .stretch and f.definite_cross == null and !f.auto_cs and !f.auto_ce) {
                    cross = clampCross(f, line.cross - f.outerCross(row));
                }
                const kin: Inputs = if (row)
                    .{ .known_w = f.target, .known_h = if (al == .stretch and f.definite_cross == null and !f.auto_cs and !f.auto_ce) cross else f.definite_cross, .avail_w = .{ .definite = f.target }, .avail_h = .{ .definite = line.cross }, .cb_w = cb_w, .cb_h = cb_h, .perform = in.perform }
                else
                    .{ .known_h = f.target, .known_w = cross, .avail_w = .{ .definite = cross }, .avail_h = .{ .definite = f.target }, .cb_w = cb_w, .cb_h = cb_h, .perform = in.perform };
                const o = try L.compute(f.item, kin);
                cross = if (row) o.h else o.w;
                f.cross = cross;
                const cs = if (row) f.margin.top else f.margin.left;
                const ce = if (row) f.margin.bottom else f.margin.right;
                const free_c = line.cross - cross - cs - ce;
                var cpos: f32 = cs;
                if (f.auto_cs and f.auto_ce) {
                    cpos += @max(0, free_c) / 2;
                } else if (f.auto_cs) {
                    cpos += @max(0, free_c);
                } else if (!f.auto_ce) {
                    switch (al) {
                        .center => cpos += free_c / 2,
                        .flex_end, .end, .self_end => cpos += free_c,
                        .baseline => if (row) {
                            cpos = line.max_baseline - (o.baseline orelse o.h);
                        },
                        else => {},
                    }
                }
                if (cross_reverse) cpos = line.cross - cpos - cross;
                f.cross_pos = line.pos + cpos;
                if (cross_reverse) f.cross_pos = final_inner_cross - line.pos - line.cross + cpos;
                if (first_baseline == null and row) {
                    first_baseline = pb.top + f.cross_pos + (o.baseline orelse o.h);
                } else if (first_baseline == null and !row and o.baseline != null) {
                    first_baseline = pb.top + f.main_pos + o.baseline.?;
                }
                if (in.perform) {
                    const kb = try L.boxOf(f.item);
                    var mp = f.main_pos;
                    if (main_reverse) mp = final_inner_main - f.main_pos - f.target;
                    if (row) {
                        kb.x = pb.left + mp;
                        kb.y = pb.top + f.cross_pos;
                    } else {
                        kb.x = pb.left + f.cross_pos;
                        kb.y = pb.top + mp;
                    }
                    kb.margin = f.margin;
                    kb.placed = true;
                    kb.in_inline = false;
                }
            }
        }

        const out: Output = .{ .w = bw.?, .h = bh.?, .baseline = first_baseline, .last_baseline = first_baseline };
        if (in.perform) {
            var max_x: f32 = 0;
            var max_y: f32 = 0;
            for (items.items) |*f| {
                const kb = L.getBox(f.item).?;
                max_x = @max(max_x, kb.x + kb.w + kb.margin.right);
                max_y = @max(max_y, kb.y + kb.h + kb.margin.bottom);
            }
            box.scroll_w = @max(out.w - box.border.horizontal(), max_x - box.border.left + box.padding.right);
            box.scroll_h = @max(out.h - box.border.vertical(), max_y - box.border.top + box.padding.bottom);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Absolute positioning
    // -----------------------------------------------------------------------

    fn containingBlockOf(L: *const Layout, k: Item, fixed: bool) NodeId {
        const doc = L.doc;
        const root = doc.documentElement();
        if (fixed) return root;
        var p = if (k.pseudo != .none) k.node else doc.node(k.node).parent;
        while (p != null_id and p != root) : (p = doc.node(p).parent) {
            if (doc.node(p).kind != .element) continue;
            const ps = style_mod.of(doc, p);
            if (ps.position != .static or ps.hasTransform()) return p;
        }
        return root;
    }

    /// Lay out the pending absolutely positioned boxes whose containing block is `cb`.
    fn layoutAbsolute(L: *Layout, cb: Item, is_root: bool) !void {
        var i: usize = 0;
        while (i < L.pending_abs.items.len) {
            const pa = L.pending_abs.items[i];
            const kst = L.styleOf(pa.item);
            const cb_node = L.containingBlockOf(pa.item, kst.position == .fixed);
            if (cb_node != cb.node and !is_root) {
                i += 1;
                continue;
            }
            _ = L.pending_abs.swapRemove(i);
            try L.placeAbsolute(pa, cb, kst, is_root and kst.position == .fixed);
        }
    }

    fn offsetToAncestor(L: *Layout, from: Item, ancestor: NodeId) [2]f32 {
        // sum of border-box offsets from `from` up to (excluding) `ancestor`
        var x: f32 = 0;
        var y: f32 = 0;
        var cur = from;
        const doc = L.doc;
        while (true) {
            if (cur.pseudo == .none and cur.node == ancestor) break;
            const b = L.getBox(cur) orelse break;
            x += b.x;
            y += b.y;
            // atomic inlines are positioned relative to their IFC owner's anonymous block
            const parent = if (cur.pseudo != .none) cur.node else doc.node(cur.node).parent;
            if (parent == null_id) break;
            if (parent == ancestor) break;
            if (doc.node(parent).kind != .element) break;
            cur = .{ .node = parent };
        }
        return .{ x, y };
    }

    fn placeAbsolute(L: *Layout, pa: AbsPending, cb: Item, kst: *const Style, viewport: bool) !void {
        const cbb = L.getBox(cb).?;
        var cb_x: f32 = cbb.border.left;
        var cb_y: f32 = cbb.border.top;
        var cb_w = @max(0, cbb.w - cbb.border.horizontal());
        var cb_h = @max(0, cbb.h - cbb.border.vertical());
        if (viewport) {
            // relative to the viewport, expressed in root coordinates
            cb_x = -cbb.x;
            cb_y = -cbb.y;
            cb_w = L.viewport_w;
            cb_h = L.viewport_h;
        }
        const kbox = try L.boxOf(pa.item);
        kbox.padding = resolvePadding(kst, cb_w);
        kbox.border = kst.borderWidths();
        const m = resolveMargins(kst, cb_w);
        const r = resolveSizes(kst, kbox, cb_w, cb_h);
        const left = kst.inset[3].resolve(cb_w);
        const right = kst.inset[1].resolve(cb_w);
        const top = kst.inset[0].resolve(cb_h);
        const bottom = kst.inset[2].resolve(cb_h);
        // parent offset relative to the containing block's border box
        const parent_off = if (pa.parent.node == cb.node and pa.parent.pseudo == .none) [2]f32{ 0, 0 } else L.offsetToAncestor(pa.parent, cb.node);

        var known_w: ?f32 = r.w;
        if (known_w == null and left != null and right != null) known_w = clampW(r, cb_w - left.? - right.? - m.left - m.right);
        var known_h: ?f32 = r.h;
        if (known_h == null and top != null and bottom != null) known_h = clampH(r, cb_h - top.? - bottom.? - m.top - m.bottom);
        if (known_w != null and known_h == null and kst.aspect_ratio != null) known_h = known_w.? / kst.aspect_ratio.?;
        const avail_w = if (left != null or right != null) cb_w - (left orelse 0) - (right orelse 0) - m.left - m.right else cb_w - m.left - m.right;
        const o = try L.compute(pa.item, .{ .known_w = known_w, .known_h = known_h, .avail_w = .{ .definite = @max(0, avail_w) }, .avail_h = .{ .definite = cb_h }, .cb_w = cb_w, .cb_h = cb_h, .sizing = .fit, .perform = true });
        var x: f32 = undefined;
        var y: f32 = undefined;
        // auto margins center when both insets are set
        var ml = m.left;
        var mt = m.top;
        if (left != null and right != null and kst.margin[3] == .auto and kst.margin[1] == .auto) ml = @max(0, (cb_w - left.? - right.? - o.w) / 2);
        if (top != null and bottom != null and kst.margin[0] == .auto and kst.margin[2] == .auto) mt = @max(0, (cb_h - top.? - bottom.? - o.h) / 2);
        if (left) |l| {
            x = cb_x + l + ml;
        } else if (right) |rr| {
            x = cb_x + cb_w - rr - o.w - m.right;
        } else {
            x = parent_off[0] + pa.sx + ml;
        }
        if (top) |t| {
            y = cb_y + t + mt;
        } else if (bottom) |bb| {
            y = cb_y + cb_h - bb - o.h - m.bottom;
        } else {
            y = parent_off[1] + pa.sy + mt;
        }
        // store relative to the DOM parent
        kbox.x = x - parent_off[0];
        kbox.y = y - parent_off[1];
        kbox.margin = m;
        kbox.placed = true;
        kbox.in_inline = false;
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn fontSpec(st: *const Style) font.FontSpec {
    return .{ .families = st.font_family, .size = st.font_size, .weight = st.font_weight, .italic = st.font_style != .normal };
}

pub fn resolvePadding(st: *const Style, cb_w: f32) Edges {
    return .{
        .top = @max(0, st.padding[0].resolve(cb_w)),
        .right = @max(0, st.padding[1].resolve(cb_w)),
        .bottom = @max(0, st.padding[2].resolve(cb_w)),
        .left = @max(0, st.padding[3].resolve(cb_w)),
    };
}

/// Margins with `auto` treated as 0 (callers handle auto separately).
pub fn resolveMargins(st: *const Style, cb_w: f32) Edges {
    return .{
        .top = st.margin[0].resolve(cb_w) orelse 0,
        .right = st.margin[1].resolve(cb_w) orelse 0,
        .bottom = st.margin[2].resolve(cb_w) orelse 0,
        .left = st.margin[3].resolve(cb_w) orelse 0,
    };
}

fn relativeOffset(st: *const Style, cb_w: f32, cb_h: f32) [2]f32 {
    var dx: f32 = 0;
    var dy: f32 = 0;
    if (st.inset[3].resolve(cb_w)) |l| {
        dx = l;
    } else if (st.inset[1].resolve(cb_w)) |r| dx = -r;
    if (st.inset[0].resolve(cb_h)) |t| {
        dy = t;
    } else if (st.inset[2].resolve(cb_h)) |b| dy = -b;
    if (st.position == .sticky) return .{ 0, 0 };
    return .{ dx, dy };
}

fn inlineEdge(st: *const Style, cb_w: f32, start: bool) f32 {
    const bw = st.borderWidths();
    if (start) return (st.margin[3].resolve(cb_w) orelse 0) + bw.left + @max(0, st.padding[3].resolve(cb_w));
    return (st.margin[1].resolve(cb_w) orelse 0) + bw.right + @max(0, st.padding[1].resolve(cb_w));
}

fn collapsesWs(st: *const Style) bool {
    return st.white_space == .normal or st.white_space == .nowrap or st.white_space == .pre_line;
}

pub fn isReplaced(doc: *const Document, id: NodeId) bool {
    const n = doc.node(id);
    if (n.kind != .element) return false;
    const w = &doc.atoms;
    const t = n.tag;
    return t == w.img or t == w.input or t == w.textarea or t == w.select or t == w.canvas or t == w.progress or t == w.webview or t == w.wgpu or t == w.svg or
        (doc.interner.lookup("video") != null and t == doc.interner.lookup("video").?) or
        (doc.interner.lookup("iframe") != null and t == doc.interner.lookup("iframe").?);
}

pub fn isPassword(doc: *const Document, id: NodeId) bool {
    const n = doc.node(id);
    if (n.tag != doc.atoms.input) return false;
    const t = n.getAttr(doc.atoms.type) orelse return false;
    return std.ascii.eqlIgnoreCase(t, "password");
}

pub fn isTextInput(doc: *const Document, id: NodeId) bool {
    const n = doc.node(id);
    if (n.tag == doc.atoms.textarea) return true;
    if (n.tag != doc.atoms.input) return false;
    const t = n.getAttr(doc.atoms.type) orelse return true;
    const non_text = [_][]const u8{ "checkbox", "radio", "range", "color", "file", "hidden", "image", "button", "submit", "reset" };
    for (non_text) |x| if (std.ascii.eqlIgnoreCase(t, x)) return false;
    return true;
}

fn attrNumber(n: *const dom.Node, name: dom.Atom) ?f32 {
    const v = n.getAttr(name) orelse return null;
    return std.fmt.parseFloat(f32, std.mem.trim(u8, v, " px")) catch null;
}

fn itemAlign(container: *const Style, item_st: *const Style) props.Align {
    const a = if (item_st.align_self == .auto) container.align_items else item_st.align_self;
    return switch (a) {
        .normal, .auto => .stretch,
        .start, .self_start => .flex_start,
        .end, .self_end => .flex_end,
        else => a,
    };
}

fn clampCross(f: *const Layout.FlexItem, v: f32) f32 {
    return @max(f.min_cross, @min(v, f.max_cross));
}

fn shiftInline(il: *InlineLayout, dy: f32) void {
    if (dy == 0) return;
    for (il.lines) |*l| {
        l.y += dy;
        l.baseline += dy;
    }
    for (il.frags) |*f| {
        f.y += dy;
        f.baseline += dy;
    }
    il.first_baseline += dy;
    il.last_baseline += dy;
}

/// CSS Flexbox §9.7 "Resolving Flexible Lengths".
fn resolveFlexible(items: []Layout.FlexItem, avail: f32, row: bool) void {
    var sum_hyp: f32 = 0;
    for (items) |*f| sum_hyp += f.hyp + f.outerMain(row);
    const grow = sum_hyp < avail;
    for (items) |*f| {
        f.frozen = false;
        f.target = f.hyp;
        const factor = if (grow) f.st.flex_grow else f.st.flex_shrink;
        if (factor == 0 or (grow and f.base > f.hyp) or (!grow and f.base < f.hyp)) {
            f.frozen = true;
        }
    }
    var initial_free: f32 = avail;
    for (items) |*f| initial_free -= (if (f.frozen) f.target else f.base) + f.outerMain(row);
    var iter: usize = 0;
    while (iter < items.len + 1) : (iter += 1) {
        var unfrozen: usize = 0;
        var free = avail;
        var factor_sum: f32 = 0;
        var scaled_sum: f32 = 0;
        for (items) |*f| {
            free -= f.outerMain(row);
            if (f.frozen) {
                free -= f.target;
            } else {
                free -= f.base;
                unfrozen += 1;
                if (grow) factor_sum += f.st.flex_grow else {
                    factor_sum += f.st.flex_shrink;
                    scaled_sum += f.st.flex_shrink * f.base;
                }
            }
        }
        if (unfrozen == 0) break;
        if (factor_sum < 1 and factor_sum > 0) {
            const alt = initial_free * factor_sum;
            if (@abs(alt) < @abs(free)) free = alt;
        }
        var total_violation: f32 = 0;
        for (items) |*f| {
            if (f.frozen) continue;
            var t = f.base;
            if (grow) {
                if (factor_sum > 0) t = f.base + free * (f.st.flex_grow / factor_sum);
            } else if (scaled_sum > 0) {
                t = f.base + free * (f.st.flex_shrink * f.base / scaled_sum);
            }
            const clamped = @max(f.min_main, @min(t, f.max_main));
            total_violation += clamped - t;
            f.target = clamped;
        }
        // freeze
        var any = false;
        for (items) |*f| {
            if (f.frozen) continue;
            const t_un = f.target;
            const is_min = t_un <= f.min_main and f.min_main > 0 and t_un == f.min_main;
            const is_max = t_un >= f.max_main;
            if (total_violation == 0 or (total_violation > 0 and is_min) or (total_violation < 0 and is_max)) {
                f.frozen = true;
                any = true;
            }
        }
        if (!any) {
            for (items) |*f| f.frozen = true;
        }
    }
}

// ---------------------------------------------------------------------------
// Tests (mock font: every glyph is 0.5em wide; ascent .8em, descent .2em)
// ---------------------------------------------------------------------------

const html = @import("html.zig");

pub const TestDoc = struct {
    doc: *Document,
    engine: style_mod.Engine,
    fonts: font.Backend,
    L: Layout,

    pub fn init(markup: []const u8, w: f32, h: f32) !*TestDoc {
        const gpa = std.testing.allocator;
        const t = try gpa.create(TestDoc);
        t.doc = try Document.init(gpa);
        t.doc.node_finalizer = finalizeAll;
        try html.parseInto(t.doc, t.doc.root, markup, .{});
        t.engine = style_mod.Engine.init(gpa);
        t.fonts = try font.MockBackend.create(gpa);
        t.L = Layout.init(gpa, t.doc, t.fonts);
        t.engine.setEnv(.{ .width = w, .height = h });
        _ = try t.engine.update(t.doc);
        _ = try t.L.run(w, h);
        return t;
    }
    fn finalizeAll(doc: *Document, n: *dom.Node) void {
        style_mod.finalizeNode(doc, n);
        finalizeNode(doc, n);
    }
    pub fn deinit(t: *TestDoc) void {
        const gpa = std.testing.allocator;
        t.doc.deinit();
        t.engine.deinit();
        t.L.deinit();
        t.fonts.deinit();
        gpa.destroy(t);
    }
    pub fn relayout(t: *TestDoc) !void {
        _ = try t.engine.update(t.doc);
        _ = try t.L.run(t.L.viewport_w, t.L.viewport_h);
    }
    pub fn q(t: *TestDoc, sel: []const u8) NodeId {
        return style_mod.querySelector(t.doc, t.doc.root, sel) catch unreachable;
    }
    /// absolute border-box rect of an element
    pub fn rect(t: *TestDoc, sel: []const u8) geom.Rect {
        const id = t.q(sel);
        var x: f32 = 0;
        var y: f32 = 0;
        var cur = id;
        const b = boxOfNode(t.doc.node(id)).?;
        while (cur != null_id and t.doc.node(cur).kind == .element) : (cur = t.doc.node(cur).parent) {
            const cb = boxOfNode(t.doc.node(cur)) orelse break;
            x += cb.x;
            y += cb.y;
        }
        return .{ .x = x, .y = y, .w = b.w, .h = b.h };
    }
};

fn expectRect(r: geom.Rect, x: f32, y: f32, w: f32, h: f32) !void {
    errdefer std.debug.print("rect = {d} {d} {d} {d}, expected {d} {d} {d} {d}\n", .{ r.x, r.y, r.w, r.h, x, y, w, h });
    try std.testing.expectApproxEqAbs(x, r.x, 0.01);
    try std.testing.expectApproxEqAbs(y, r.y, 0.01);
    try std.testing.expectApproxEqAbs(w, r.w, 0.01);
    try std.testing.expectApproxEqAbs(h, r.h, 0.01);
}

test "block layout and margin collapsing" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0; font-size: 10px; line-height: 20px; } .a { margin: 10px 0; height: 30px } .b { margin: 20px 5px; padding: 5px; border: 1px solid; }</style>
        \\<div class="a" id="a1"></div><div class="a" id="a2"></div><div class="b" id="b">hello</div>
    , 200, 100);
    defer t.deinit();
    // body has no padding: first child's top margin collapses through body/html
    // (html is the root and does not collapse; body does)
    try expectRect(t.rect("#a1"), 0, 10, 200, 30);
    try expectRect(t.rect("#a2"), 0, 50, 200, 30);
    // max(10, 20) = 20 between a2 and b
    try expectRect(t.rect("#b"), 5, 100, 190, 32);
    // b's bottom margin collapses through body too
    try expectRect(t.rect("body"), 0, 10, 200, 122);
}

test "inline wrapping" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0; font-size: 10px; line-height: 10px; width: 50px } </style>
        \\<p id="p" style="margin:0">aaaa bbbb cccc dd</p>
    , 200, 100);
    defer t.deinit();
    // each char 5px; "aaaa bbbb" = 45px fits in 50; "cccc dd" = 35
    try expectRect(t.rect("#p"), 0, 0, 50, 20);
    const b = boxOfNode(t.doc.node(t.q("#p"))).?;
    const il = b.inline_layout.?;
    try std.testing.expectEqual(@as(usize, 2), il.lines.len);
    try std.testing.expectApproxEqAbs(@as(f32, 45), il.lines[0].w, 0.01);
}

test "flex row with grow and gap" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0 } .row { display: flex; gap: 10px; width: 300px; height: 50px }
        \\ .f { flex: 1 } .fixed { width: 40px } .two { flex: 2 }</style>
        \\<div class="row"><div class="fixed" id="x"></div><div class="f" id="y"></div><div class="two" id="z"></div></div>
    , 400, 300);
    defer t.deinit();
    // free = 300 - 40 - 20 gaps = 240; y = 80, z = 160
    try expectRect(t.rect("#x"), 0, 0, 40, 50);
    try expectRect(t.rect("#y"), 50, 0, 80, 50);
    try expectRect(t.rect("#z"), 140, 0, 160, 50);
}

test "flex column, centering and auto margins" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0 } .c { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 200px; width: 100px }
        \\ .i { width: 20px; height: 20px } .push { margin-top: auto }</style>
        \\<div class="c"><div class="i" id="a"></div><div class="i" id="b"></div></div>
        \\<div class="c" style="justify-content:flex-start"><div class="i" id="c"></div><div class="i push" id="d"></div></div>
    , 400, 600);
    defer t.deinit();
    try expectRect(t.rect("#a"), 40, 80, 20, 20);
    try expectRect(t.rect("#b"), 40, 100, 20, 20);
    try expectRect(t.rect("#c"), 40, 200, 20, 20);
    try expectRect(t.rect("#d"), 40, 380, 20, 20);
}

test "flex wrap and shrink" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0 } .w { display: flex; flex-wrap: wrap; width: 100px } .i { width: 40px; height: 10px; flex-shrink: 0 }
        \\ .s { display: flex; width: 100px } .s > div { width: 80px; height: 5px }</style>
        \\<div class="w"><div class="i" id="a"></div><div class="i" id="b"></div><div class="i" id="c"></div></div>
        \\<div class="s"><div id="d"></div><div id="e"></div></div>
    , 400, 600);
    defer t.deinit();
    try expectRect(t.rect("#a"), 0, 0, 40, 10);
    try expectRect(t.rect("#b"), 40, 0, 40, 10);
    try expectRect(t.rect("#c"), 0, 10, 40, 10);
    try expectRect(t.rect("#d"), 0, 20, 50, 5);
    try expectRect(t.rect("#e"), 50, 20, 50, 5);
}

test "text controls size intrinsically and stretch like other items" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0; font-size: 10px; line-height: 10px } .col { display: flex; flex-direction: column; width: 300px }
        \\ input, textarea { padding: 0; border: 0; font-size: 10px; line-height: 10px }</style>
        \\<input id="i"><input id="s" size="4"><textarea id="t">a
        \\b
        \\c
        \\d</textarea><div class="col"><input id="f"></div>
    , 400, 600);
    defer t.deinit();
    // block context: intrinsic width from `size` (default 20 avg chars)
    try std.testing.expectApproxEqAbs(@as(f32, 20 * 5.5), t.rect("#i").w, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 4 * 5.5), t.rect("#s").w, 0.01);
    // textarea: cols x rows, regardless of content (it scrolls)
    try std.testing.expectApproxEqAbs(@as(f32, 20 * 6), t.rect("#t").w, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 2 * 10), t.rect("#t").h, 0.01);
    // flex column: stretches to the container like any auto-width item
    try std.testing.expectApproxEqAbs(@as(f32, 300), t.rect("#f").w, 0.01);
}

test "flex stretch and content sizing" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0; font-size: 10px; line-height: 10px } .r { display: flex } .r > div { padding: 2px }</style>
        \\<div class="r"><div id="a">abc</div><div id="b">x<br>y<br>z</div></div>
    , 400, 600);
    defer t.deinit();
    // a: 15px text + 4 padding = 19 wide; stretched to b's height (30 + 4)
    try expectRect(t.rect("#a"), 0, 0, 19, 34);
    try expectRect(t.rect("#b"), 19, 0, 9, 34);
}

test "absolute positioning" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0 } .rel { position: relative; width: 200px; height: 100px; margin: 10px; padding: 5px; border: 2px solid }
        \\ .abs { position: absolute; right: 10px; bottom: 0; width: 30px; height: 20px }
        \\ .fill { position: absolute; inset: 0 } .fixed { position: fixed; left: 0; top: 0; width: 10px; height: 10px }</style>
        \\<div class="rel" id="r"><div><div class="abs" id="a"></div></div><div class="fill" id="f"></div></div><div class="fixed" id="x"></div>
    , 400, 300);
    defer t.deinit();
    // padding box of .rel: x=12, y=12, w=210, h=110
    try expectRect(t.rect("#a"), 12 + 210 - 10 - 30, 12 + 110 - 20, 30, 20);
    try expectRect(t.rect("#f"), 12, 12, 210, 110);
    try expectRect(t.rect("#x"), 0, 0, 10, 10);
}

test "grid layout" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0 } .g { display: grid; grid-template-columns: 100px 1fr 2fr; gap: 10px; width: 400px; grid-auto-rows: 50px }
        \\ .span { grid-column: span 2 } .placed { grid-column: 1 / -1; grid-row: 3 }</style>
        \\<div class="g"><div id="a"></div><div id="b"></div><div id="c"></div><div class="span" id="d"></div><div id="e"></div><div class="placed" id="f"></div></div>
    , 600, 600);
    defer t.deinit();
    // free for fr = 400 - 100 - 20 = 280 -> 1fr = 93.33, 2fr = 186.67
    try expectRect(t.rect("#a"), 0, 0, 100, 50);
    try expectRect(t.rect("#b"), 110, 0, 93.333, 50);
    try expectRect(t.rect("#c"), 213.333, 0, 186.667, 50);
    try expectRect(t.rect("#d"), 0, 60, 203.333, 50);
    try expectRect(t.rect("#e"), 213.333, 60, 186.667, 50);
    try expectRect(t.rect("#f"), 0, 120, 400, 50);
}

test "inline-block and baseline" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0; font-size: 10px; line-height: 10px } .ib { display: inline-block; width: 20px; height: 30px }</style>
        \\<div id="d">ab<span class="ib" id="i"></span>cd</div>
    , 400, 600);
    defer t.deinit();
    // inline-block without text: baseline = bottom margin edge -> sits on the text baseline
    const i = t.rect("#i");
    try std.testing.expectApproxEqAbs(@as(f32, 10), i.x, 0.01);
    const d = t.rect("#d");
    try std.testing.expect(d.h >= 30);
}

test "incremental relayout" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0 } .row { display: flex } .row > div { flex: 1; height: 10px }</style>
        \\<div class="row" id="r"><div id="a"></div><div id="b"></div></div><div id="other"><p>x</p><p>y</p></div>
    , 200, 100);
    defer t.deinit();
    try expectRect(t.rect("#b"), 100, 0, 100, 10);
    const a = t.q("#a");
    try t.doc.setStyleProperty(a, "flex", "3");
    try t.relayout();
    try expectRect(t.rect("#b"), 150, 0, 50, 10);
    // only the dirty path is recomputed
    try std.testing.expect(t.L.cache_hits > 0);
}

test "abs flex container centers text; code is monospace" {
    const t = try TestDoc.init(
        \\<style>body { margin: 0; font-size: 10px; line-height: 10px } .rel { position: relative; width: 200px; height: 100px }
        \\ .p { position: absolute; left: 0; top: 0; width: 100px; height: 50px; display: flex; align-items: center; justify-content: center }</style>
        \\<div class="rel"><div class="p" id="p">abcd</div></div><p><span>x <code id="c">y</code></span></p>
    , 400, 300);
    defer t.deinit();
    const p = t.q("#p");
    const text = t.doc.node(p).first_child;
    const tb = boxOfNode(t.doc.node(text)).?;
    try std.testing.expectApproxEqAbs(@as(f32, 40), tb.x, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 20), tb.y, 0.01);
    const cs = style_mod.of(t.doc, t.q("#c"));
    try std.testing.expectEqualStrings("monospace", cs.font_family[0]);
}

