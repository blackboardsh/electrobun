//! Inline formatting context: white-space processing, shaping, line breaking
//! and line-box construction for a run of inline-level content. The result is
//! a flat list of lines and fragments that painting, hit-testing and caret
//! positioning share.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const style_mod = @import("style.zig");
const font = @import("text/font.zig");
const props = @import("css/properties.zig");
const layout = @import("layout.zig");

const Allocator = std.mem.Allocator;
const NodeId = dom.NodeId;
const null_id = dom.null_id;
const Style = style_mod.Style;
const Item = layout.Item;

pub const FragKind = enum(u8) { text, atomic, inline_box };

pub const Frag = struct {
    kind: FragKind,
    item: Item,
    style: *const Style,
    line: u32,
    /// IFC-relative position (top-left of the fragment's content area)
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    /// absolute baseline y in IFC coordinates
    baseline: f32,
    glyph_start: u32 = 0,
    glyph_end: u32 = 0,
    /// byte range in the source node text (text frags)
    text_start: u32 = 0,
    text_end: u32 = 0,
    /// inline boxes: whether the box starts/ends on this line (for borders)
    first: bool = true,
    last: bool = true,
    /// this text fragment is a generated ellipsis
    ellipsis: bool = false,
};

pub const PGlyph = struct {
    id: u32,
    font: font.FontId,
    /// pen x relative to the fragment x
    x: f32,
    /// offset from the baseline (positive = down)
    y: f32,
    advance: f32,
    /// byte offset in the source node text
    src: u32,
};

pub const Line = struct {
    y: f32,
    h: f32,
    baseline: f32,
    x: f32,
    w: f32,
    frag_start: u32,
    frag_end: u32,
};

/// Byte offset into the text as laid out. For form controls this is not the
/// value: a password shows bullets and an empty control shows its placeholder.
/// A distinct type so value offsets can't be passed where layout ones are
/// expected; convert with events.Interaction.layoutOffset / valueOffset.
/// Shown in place of each character of a password control's value.
pub const password_bullet = "\u{2022}";

pub const TextOffset = enum(u32) {
    _,
    pub fn of(v: u32) TextOffset {
        return @enumFromInt(v);
    }
    pub fn int(t: TextOffset) u32 {
        return @intFromEnum(t);
    }
};

pub const InlineLayout = struct {
    arena: std.heap.ArenaAllocator,
    lines: []Line = &.{},
    frags: []Frag = &.{},
    glyphs: []PGlyph = &.{},
    width: f32 = 0,
    height: f32 = 0,
    first_baseline: f32 = 0,
    last_baseline: f32 = 0,
    min_content: f32 = 0,
    max_content: f32 = 0,

    pub fn destroy(il: *InlineLayout, gpa: Allocator) void {
        il.arena.deinit();
        gpa.destroy(il);
    }

    /// Caret rectangle (IFC coordinates) for an offset in `node`'s laid-out text.
    pub const Caret = struct { x: f32, y: f32, h: f32 };

    pub fn caretAt(il: *const InlineLayout, node: NodeId, at: TextOffset) ?Caret {
        const offset = at.int();
        var best: ?Caret = null;
        for (il.frags) |f| {
            if (f.kind != .text or f.item.node != node or f.ellipsis) continue;
            if (offset < f.text_start or offset > f.text_end) continue;
            var x = f.x;
            for (il.glyphs[f.glyph_start..f.glyph_end]) |g| {
                if (g.src >= offset) break;
                x = f.x + g.x + g.advance;
            }
            const line = il.lines[f.line];
            const r = Caret{ .x = x, .y = line.y, .h = line.h };
            if (offset < f.text_end) return r;
            best = r;
        }
        if (best == null and il.lines.len > 0) {
            const l = il.lines[0];
            return Caret{ .x = l.x, .y = l.y, .h = l.h };
        }
        return best;
    }

    /// Offset in `node`'s laid-out text nearest to an IFC-relative point.
    pub fn offsetAt(il: *const InlineLayout, node: NodeId, px: f32, py: f32) ?TextOffset {
        return if (il.offsetAtRaw(node, px, py)) |o| TextOffset.of(o) else null;
    }

    fn offsetAtRaw(il: *const InlineLayout, node: NodeId, px: f32, py: f32) ?u32 {
        if (il.lines.len == 0) return null;
        var li: usize = 0;
        for (il.lines, 0..) |l, i| {
            if (py >= l.y) li = i;
        }
        const line = il.lines[li];
        var best: ?u32 = null;
        var best_d: f32 = std.math.inf(f32);
        for (il.frags[line.frag_start..line.frag_end]) |f| {
            if (f.kind != .text or f.item.node != node or f.ellipsis) continue;
            // candidate caret positions at each glyph boundary
            var x = f.x;
            var off = f.text_start;
            consider(&best, &best_d, x, off, px);
            for (il.glyphs[f.glyph_start..f.glyph_end], 0..) |g, gi| {
                x = f.x + g.x + g.advance;
                const next_src = if (f.glyph_start + gi + 1 < f.glyph_end) il.glyphs[f.glyph_start + gi + 1].src else f.text_end;
                off = next_src;
                consider(&best, &best_d, x, off, px);
            }
        }
        if (best == null) {
            // no text of this node on that line: closest line end
            for (il.frags) |f| {
                if (f.kind == .text and f.item.node == node and !f.ellipsis) {
                    if (f.line == li) return f.text_start;
                    if (f.line > li) return f.text_start;
                    best = f.text_end;
                }
            }
        }
        return best;
    }

    fn consider(best: *?u32, best_d: *f32, x: f32, off: u32, px: f32) void {
        const d = @abs(x - px);
        if (d < best_d.*) {
            best_d.* = d;
            best.* = off;
        }
    }
};

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const UnitKind = enum(u8) { glyph, atomic, open, close, forced_break };

const Unit = struct {
    kind: UnitKind,
    item: u32, // index into items
    /// glyph index into item glyphs (glyph units)
    glyph: u32 = 0,
    width: f32,
    /// a collapsible/hanging space (removed at line end)
    space: bool = false,
    /// a break opportunity exists after this unit
    break_after: bool = false,
    /// emergency break allowed after this unit (overflow-wrap)
    emergency_after: bool = false,
};

const ItemKind = enum(u8) { text, atomic, open, close, br };

const ItemData = struct {
    kind: ItemKind,
    item: Item,
    style: *const Style,
    /// processed text (text items)
    text: []const u8 = "",
    /// processed byte -> source byte
    src_map: []const u32 = &.{},
    glyphs: []const font.Glyph = &.{},
    /// distinct glyph cluster offsets in logical (text) order; glyphs may be
    /// in visual order (right-to-left runs), so cluster extents come from here
    cluster_starts: []const u32 = &.{},
    font: font.FontId = 0,
    ascent: f32 = 0,
    descent: f32 = 0,
    /// atomic box size (border box) and margins
    aw: f32 = 0,
    ah: f32 = 0,
    abaseline: ?f32 = null,
    amargin: geom.Edges = .{},
    /// inline box inline-start/end edge (margin+border+padding)
    edge: f32 = 0,
    /// vertical baseline shift for sub/super
    shift: f32 = 0,
    depth: u16 = 0,

    /// End (exclusive, in processed text) of the cluster starting at `start`:
    /// the next cluster in text order, whatever order the glyphs are in.
    fn clusterEnd(it: *const @This(), start: u32) u32 {
        const cs = it.cluster_starts;
        var lo: usize = 0;
        var hi: usize = cs.len;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            if (cs[mid] <= start) lo = mid + 1 else hi = mid;
        }
        return if (lo < cs.len) cs[lo] else @intCast(it.text.len);
    }
};

pub const Input = struct {
    owner: Item,
    owner_style: *const Style,
    /// content-box width available for lines (null = max-content measuring)
    avail: ?f32,
    /// emit fragments (false = measure only)
    perform: bool,
    /// first line text-indent
    indent: f32 = 0,
    /// owner clips inline overflow (enables text-overflow: ellipsis)
    clip_x: bool = false,
};

pub const Builder = struct {
    L: *layout.Layout,
    gpa: Allocator,
    arena: Allocator,
    items: std.ArrayList(ItemData) = .empty,
    units: std.ArrayList(Unit) = .empty,
    collapse_space: bool = true,
    owner_wraps: bool = true,

    pub fn addText(b: *Builder, item: Item, st: *const Style, src: []const u8) !void {
        if (src.len == 0) return;
        const ws = st.white_space;
        const collapse = ws == .normal or ws == .nowrap or ws == .pre_line;
        var out: std.ArrayList(u8) = .empty;
        var map: std.ArrayList(u32) = .empty;
        var i: usize = 0;
        while (i < src.len) {
            const c = src[i];
            if (c == '\r') {
                i += 1;
                continue;
            }
            if (c == '\n' and !(ws == .normal or ws == .nowrap)) {
                // preserved newline: forced break item
                if (out.items.len > 0) {
                    try map.append(b.arena, @intCast(i)); // end sentinel: the newline
                    try b.pushTextItem(item, st, out.items, map.items);
                }
                out = .empty;
                map = .empty;
                try b.items.append(b.arena, .{ .kind = .br, .item = item, .style = st });
                b.collapse_space = true;
                i += 1;
                // pre-line: whitespace after a newline collapses
                continue;
            }
            const is_space = c == ' ' or c == '\t' or c == '\n' or c == 0x0c;
            if (collapse and is_space) {
                if (!b.collapse_space) {
                    try out.append(b.arena, ' ');
                    try map.append(b.arena, @intCast(i));
                    b.collapse_space = true;
                }
                i += 1;
                continue;
            }
            if (c == '\t' and !collapse) {
                const n: usize = @intFromFloat(@max(1, st.tab_size));
                for (0..n) |_| {
                    try out.append(b.arena, ' ');
                    try map.append(b.arena, @intCast(i));
                }
                i += 1;
                continue;
            }
            // copy one UTF-8 sequence, applying text-transform
            const len = std.unicode.utf8ByteSequenceLength(c) catch 1;
            const end = @min(src.len, i + len);
            switch (st.text_transform) {
                .uppercase, .lowercase, .capitalize => if (len == 1) {
                    var ch = c;
                    if (st.text_transform == .uppercase) ch = std.ascii.toUpper(c);
                    if (st.text_transform == .lowercase) ch = std.ascii.toLower(c);
                    if (st.text_transform == .capitalize) {
                        const prev_alpha = out.items.len > 0 and std.ascii.isAlphanumeric(out.items[out.items.len - 1]);
                        if (!prev_alpha) ch = std.ascii.toUpper(c);
                    }
                    try out.append(b.arena, ch);
                    try map.append(b.arena, @intCast(i));
                    i += 1;
                    b.collapse_space = false;
                    continue;
                },
                else => {},
            }
            for (src[i..end], i..) |byte, si| {
                try out.append(b.arena, byte);
                try map.append(b.arena, @intCast(si));
            }
            b.collapse_space = false;
            i = end;
        }
        if (!collapse) b.collapse_space = false;
        if (out.items.len > 0) {
            try map.append(b.arena, @intCast(i)); // end sentinel
            try b.pushTextItem(item, st, out.items, map.items);
        }
    }

    /// `map[k]` is the source byte offset of `text[k]`; `map[text.len]` is
    /// the source offset just past the run.
    fn pushTextItem(b: *Builder, item: Item, st: *const Style, text: []const u8, map: []const u32) !void {
        std.debug.assert(map.len == text.len + 1);
        const spec = layout.fontSpec(st);
        const fid = b.L.fonts.resolve(spec);
        var glyphs: std.ArrayList(font.Glyph) = .empty;
        try b.L.shapeCached(fid, text, &glyphs, b.arena);
        const m = b.L.fonts.metrics(fid);
        var asc = m.ascent;
        var desc = m.descent;
        if (st.line_height == .normal) {
            // fallback fonts (emoji) can grow normal line boxes
            var last_font: font.FontId = fid;
            for (glyphs.items) |g| {
                if (g.font != last_font) {
                    last_font = g.font;
                    const fm = b.L.fonts.metrics(g.font);
                    asc = @max(asc, fm.ascent);
                    desc = @max(desc, fm.descent);
                }
            }
        }
        const starts = try b.arena.alloc(u32, glyphs.items.len);
        for (glyphs.items, starts) |g, *c| c.* = @min(g.cluster, @as(u32, @intCast(text.len)));
        std.mem.sort(u32, starts, {}, std.sort.asc(u32));
        var n_uniq: usize = 0;
        for (starts) |c| {
            if (n_uniq == 0 or starts[n_uniq - 1] != c) {
                starts[n_uniq] = c;
                n_uniq += 1;
            }
        }
        const uniq = starts[0..n_uniq];
        try b.items.append(b.arena, .{
            .kind = .text,
            .item = item,
            .style = st,
            .text = text,
            .src_map = map,
            .glyphs = glyphs.items,
            .cluster_starts = uniq,
            .font = fid,
            .ascent = asc,
            .descent = desc,
            .shift = verticalShift(st),
        });
    }

    pub fn addAtomic(b: *Builder, item: Item, st: *const Style, w: f32, h: f32, baseline: ?f32, margin: geom.Edges) !void {
        b.collapse_space = false;
        try b.items.append(b.arena, .{ .kind = .atomic, .item = item, .style = st, .aw = w, .ah = h, .abaseline = baseline, .amargin = margin, .shift = verticalShift(st) });
    }

    pub fn addOpen(b: *Builder, item: Item, st: *const Style, edge: f32) !void {
        const spec = layout.fontSpec(st);
        const fid = b.L.fonts.resolve(spec);
        const m = b.L.fonts.metrics(fid);
        if (edge > 0) b.collapse_space = false;
        try b.items.append(b.arena, .{ .kind = .open, .item = item, .style = st, .edge = edge, .font = fid, .ascent = m.ascent, .descent = m.descent, .shift = verticalShift(st) });
    }

    pub fn addClose(b: *Builder, item: Item, st: *const Style, edge: f32) !void {
        if (edge > 0) b.collapse_space = false;
        try b.items.append(b.arena, .{ .kind = .close, .item = item, .style = st, .edge = edge });
    }

    pub fn addBreak(b: *Builder, item: Item, st: *const Style) !void {
        try b.items.append(b.arena, .{ .kind = .br, .item = item, .style = st });
        b.collapse_space = true;
    }

    // -------------------------------------------------------------------

    fn buildUnits(b: *Builder) !void {
        for (b.items.items, 0..) |*it, ii| {
            const idx: u32 = @intCast(ii);
            switch (it.kind) {
                .text => {
                    const st = it.style;
                    const wrap = st.white_space != .nowrap and st.white_space != .pre;
                    const break_all = st.word_break == .break_all;
                    const emergency = st.overflow_wrap != .normal or st.word_break == .break_word;
                    const collapsible = st.white_space == .normal or st.white_space == .nowrap or st.white_space == .pre_line or st.white_space == .pre_wrap;
                    const gs = it.glyphs;
                    var gi: usize = 0;
                    while (gi < gs.len) {
                        // a cluster = consecutive glyphs with the same cluster offset
                        var ge = gi + 1;
                        var w: f32 = gs[gi].advance;
                        while (ge < gs.len and gs[ge].cluster == gs[gi].cluster) : (ge += 1) w += gs[ge].advance;
                        const cstart = @min(gs[gi].cluster, @as(u32, @intCast(it.text.len)));
                        const ch = it.text[cstart..it.clusterEnd(cstart)];
                        const cp = firstCodepoint(ch);
                        const is_space = cp == ' ';
                        w += st.letter_spacing;
                        if (is_space) w += st.word_spacing;
                        var brk = false;
                        if (wrap) {
                            if (is_space) brk = true;
                            if (cp == '-' or cp == 0x2010 or cp == 0x2013 or cp == 0x2014 or cp == 0x200b or cp == '/' or cp == 0xad) brk = true;
                            if (isCjk(cp)) brk = true;
                            if (break_all) brk = true;
                            // break before a CJK character
                            if (ge < gs.len) {
                                const nstart = @min(gs[ge].cluster, @as(u32, @intCast(it.text.len)));
                                const ncp = firstCodepoint(it.text[nstart..]);
                                if (isCjk(ncp)) brk = true;
                                // no break before closing punctuation
                                if (ncp == ',' or ncp == '.' or ncp == ')' or ncp == ';' or ncp == ':' or ncp == '!' or ncp == '?') {
                                    if (!is_space) brk = false;
                                }
                            }
                        }
                        // the unit for each glyph of the cluster; width on the first
                        for (gi..ge) |g| {
                            try b.units.append(b.arena, .{
                                .kind = .glyph,
                                .item = idx,
                                .glyph = @intCast(g),
                                .width = if (g == gi) w else 0,
                                .space = is_space and collapsible,
                                .break_after = brk and g == ge - 1,
                                .emergency_after = (emergency and wrap) and g == ge - 1,
                            });
                        }
                        gi = ge;
                    }
                },
                .atomic => {
                    const wrap = b.ownerWraps();
                    // break opportunities around atomic inlines
                    if (b.units.items.len > 0 and wrap) b.units.items[b.units.items.len - 1].break_after = true;
                    try b.units.append(b.arena, .{ .kind = .atomic, .item = idx, .width = it.aw + it.amargin.left + it.amargin.right, .break_after = wrap });
                },
                .open => try b.units.append(b.arena, .{ .kind = .open, .item = idx, .width = it.edge }),
                .close => try b.units.append(b.arena, .{ .kind = .close, .item = idx, .width = it.edge }),
                .br => try b.units.append(b.arena, .{ .kind = .forced_break, .item = idx, .width = 0, .break_after = true }),
            }
        }
    }

    fn ownerWraps(b: *Builder) bool {
        return b.owner_wraps;
    }

    /// Lay out the collected content.
    pub fn finish(b: *Builder, in: Input) !*InlineLayout {
        const il = try b.gpa.create(InlineLayout);
        il.* = .{ .arena = std.heap.ArenaAllocator.init(b.gpa) };
        errdefer il.destroy(b.gpa);
        const out_a = il.arena.allocator();
        b.owner_wraps = in.owner_style.white_space != .nowrap and in.owner_style.white_space != .pre;
        try b.buildUnits();
        const units = b.units.items;

        // intrinsic widths
        {
            // min-content: widest unbreakable segment. Spaces inside a
            // segment count (nowrap/pre text); only spaces trailing a break
            // opportunity hang and are excluded.
            var seg: f32 = 0;
            var trailing: f32 = 0;
            var line: f32 = 0;
            var min: f32 = 0;
            var max: f32 = 0;
            for (units) |u| {
                if (u.kind == .forced_break) {
                    max = @max(max, line);
                    min = @max(min, seg - trailing);
                    line = 0;
                    seg = 0;
                    trailing = 0;
                    continue;
                }
                line += u.width;
                seg += u.width;
                trailing = if (u.space) trailing + u.width else 0;
                if (u.break_after) {
                    min = @max(min, seg - trailing);
                    seg = 0;
                    trailing = 0;
                }
            }
            min = @max(min, seg - trailing);
            max = @max(max, line);
            il.min_content = min + in.indent;
            il.max_content = max + in.indent;
        }

        // ---- line breaking ----
        const LineRange = struct { start: usize, end: usize };
        var ranges: std.ArrayList(LineRange) = .empty;
        const avail = in.avail orelse std.math.inf(f32);
        {
            var line_start: usize = 0;
            // skip leading collapsible spaces
            while (line_start < units.len and units[line_start].space) line_start += 1;
            var w: f32 = in.indent;
            var last_break: ?usize = null;
            var last_emergency: ?usize = null;
            var i: usize = line_start;
            while (i < units.len) {
                const u = units[i];
                if (u.kind == .forced_break) {
                    try ranges.append(b.arena, .{ .start = line_start, .end = i + 1 });
                    line_start = i + 1;
                    w = 0;
                    last_break = null;
                    last_emergency = null;
                    i += 1;
                    continue;
                }
                const fits = w + u.width <= avail + 0.01 or u.space;
                if (!fits and i > line_start) {
                    var brk: ?usize = last_break;
                    if (brk == null) brk = last_emergency;
                    if (brk) |bi| {
                        try ranges.append(b.arena, .{ .start = line_start, .end = bi + 1 });
                        line_start = bi + 1;
                        while (line_start < units.len and units[line_start].space and units[line_start].kind != .forced_break) line_start += 1;
                        // re-measure from new line start to i
                        w = 0;
                        last_break = null;
                        last_emergency = null;
                        var k = line_start;
                        while (k < i) : (k += 1) {
                            w += units[k].width;
                            if (units[k].break_after) last_break = k;
                            if (units[k].emergency_after) last_emergency = k;
                        }
                        if (line_start > i) i = line_start;
                        continue;
                    }
                }
                w += u.width;
                if (u.break_after) last_break = i;
                if (u.emergency_after) last_emergency = i;
                i += 1;
            }
            if (line_start < units.len or ranges.items.len == 0) {
                try ranges.append(b.arena, .{ .start = line_start, .end = units.len });
            }
        }

        // line-clamp
        var clamp_ellipsis = false;
        if (in.owner_style.line_clamp) |n| {
            if (ranges.items.len > n) {
                ranges.shrinkRetainingCapacity(n);
                clamp_ellipsis = true;
            }
        }

        // ---- line boxes ----
        var lines: std.ArrayList(Line) = .empty;
        var frags: std.ArrayList(Frag) = .empty;
        var glyphs: std.ArrayList(PGlyph) = .empty;
        const owner_fid = b.L.fonts.resolve(layout.fontSpec(in.owner_style));
        const owner_m = b.L.fonts.metrics(owner_fid);
        var y: f32 = 0;
        var max_w: f32 = 0;
        // inline boxes open across lines
        var open_stack: std.ArrayList(u32) = .empty;

        for (ranges.items, 0..) |r, li| {
            var end = r.end;
            const is_last_line = li == ranges.items.len - 1;
            // trailing hanging spaces / forced break
            var content_end = end;
            while (content_end > r.start and (units[content_end - 1].space or units[content_end - 1].kind == .forced_break)) content_end -= 1;
            var line_w: f32 = if (li == 0) in.indent else 0;
            for (units[r.start..content_end]) |u| line_w += u.width;

            // ellipsis
            const want_ellipsis = (in.clip_x and in.owner_style.text_overflow == .ellipsis and line_w > avail + 0.01) or (clamp_ellipsis and is_last_line);
            var ellipsis_item: ?u32 = null;
            var ellipsis_glyphs: []const font.Glyph = &.{};
            var ellipsis_w: f32 = 0;
            if (want_ellipsis and in.perform) {
                // style of the last text unit on the line
                var k = content_end;
                while (k > r.start) {
                    k -= 1;
                    if (units[k].kind == .glyph) {
                        ellipsis_item = units[k].item;
                        break;
                    }
                }
                if (ellipsis_item) |ei| {
                    const it = &b.items.items[ei];
                    var eg: std.ArrayList(font.Glyph) = .empty;
                    try b.L.fonts.shape(it.font, "\u{2026}", &eg, b.arena);
                    ellipsis_glyphs = eg.items;
                    for (eg.items) |g| ellipsis_w += g.advance;
                    // drop units until the ellipsis fits
                    const limit = if (clamp_ellipsis and is_last_line and line_w + ellipsis_w <= avail) line_w else avail - ellipsis_w;
                    var acc: f32 = if (li == 0) in.indent else 0;
                    var cut = r.start;
                    while (cut < content_end and acc + units[cut].width <= limit + 0.01) : (cut += 1) acc += units[cut].width;
                    // keep whole clusters: zero-width continuation glyphs stay
                    while (cut < content_end and units[cut].kind == .glyph and units[cut].width == 0 and !units[cut].space) cut += 1;
                    // trailing spaces before the ellipsis are trimmed
                    while (cut > r.start and units[cut - 1].space) cut -= 1;
                    // keep closing edges so inline boxes stay balanced
                    content_end = cut;
                    end = cut;
                    line_w = acc + ellipsis_w;
                    var kk = r.start;
                    line_w = if (li == 0) in.indent else 0;
                    while (kk < cut) : (kk += 1) line_w += units[kk].width;
                    line_w += ellipsis_w;
                }
            }

            // vertical metrics: strut first
            const strut_lh = lineHeightFor(in.owner_style, owner_m);
            const strut_half = (strut_lh - (owner_m.ascent + owner_m.descent)) / 2;
            var top: f32 = -(owner_m.ascent + strut_half);
            var bottom: f32 = owner_m.descent + strut_half;
            const has_content = content_end > r.start or (clamp_ellipsis and is_last_line);
            // an empty line (only spaces) collapses unless it holds a forced break
            const empty_line = !has_content;
            for (units[r.start..content_end]) |u| {
                const it = &b.items.items[u.item];
                switch (u.kind) {
                    .glyph => if (u.glyph == 0 or u.width > 0) {
                        const lh = lineHeightFor(it.style, .{ .ascent = it.ascent, .descent = it.descent });
                        const half = (lh - (it.ascent + it.descent)) / 2;
                        top = @min(top, -(it.ascent + half) + it.shift);
                        bottom = @max(bottom, it.descent + half + it.shift);
                    },
                    .atomic => {
                        const va = it.style.vertical_align;
                        if (va == .top or va == .bottom) continue;
                        const asc = atomicAscent(it, owner_m);
                        top = @min(top, -asc + it.shift);
                        bottom = @max(bottom, it.ah + it.amargin.top + it.amargin.bottom - asc + it.shift);
                    },
                    else => {},
                }
            }
            // top/bottom aligned atomics may grow the line
            for (units[r.start..content_end]) |u| {
                if (u.kind != .atomic) continue;
                const it = &b.items.items[u.item];
                const oh = it.ah + it.amargin.top + it.amargin.bottom;
                if (it.style.vertical_align == .top) bottom = @max(bottom, top + oh);
                if (it.style.vertical_align == .bottom) top = @min(top, bottom - oh);
            }
            var line_h = bottom - top;
            if (empty_line and units.len > 0 and r.end > r.start and units[r.end - 1].kind != .forced_break) line_h = 0;
            const baseline = y - top;

            // horizontal alignment
            const align_w = if (in.avail) |a| a else line_w;
            var x0: f32 = if (li == 0) in.indent else 0;
            var justify_extra: f32 = 0;
            const ta = resolveAlign(in.owner_style.text_align);
            if (in.avail != null and line_w < align_w) {
                const free = align_w - line_w;
                switch (ta) {
                    .left => {},
                    .right => x0 += free,
                    .center => x0 += free / 2,
                    .justify => if (!is_last_line and units[r.end - 1].kind != .forced_break) {
                        var spaces: usize = 0;
                        for (units[r.start..content_end]) |u| if (u.space and u.width > 0) {
                            spaces += 1;
                        };
                        if (spaces > 0) justify_extra = free / @as(f32, @floatFromInt(spaces));
                    },
                }
            }

            const frag_start: u32 = @intCast(frags.items.len);
            if (in.perform) {
                // inline boxes continuing from the previous line
                for (open_stack.items) |oi| {
                    const it = &b.items.items[oi];
                    try frags.append(out_a, .{ .kind = .inline_box, .item = it.item, .style = it.style, .line = @intCast(li), .x = x0, .y = 0, .w = 0, .h = 0, .baseline = baseline, .first = false, .last = false, .glyph_start = oi });
                }
                var x = x0;
                var k = r.start;
                while (k < end) {
                    const u = units[k];
                    const it = &b.items.items[u.item];
                    switch (u.kind) {
                        .glyph => {
                            // a text fragment: consecutive glyph units of one item
                            const fx = x;
                            const gstart: u32 = @intCast(glyphs.items.len);
                            // logical text range covered by the fragment's
                            // glyphs (any order: right-to-left runs are reversed)
                            var cmin: u32 = std.math.maxInt(u32);
                            var cmax: u32 = 0;
                            var pen: f32 = 0;
                            var kk = k;
                            while (kk < end and units[kk].kind == .glyph and units[kk].item == u.item) : (kk += 1) {
                                const uu = units[kk];
                                const g = it.glyphs[uu.glyph];
                                const gc = @min(g.cluster, @as(u32, @intCast(it.text.len)));
                                cmin = @min(cmin, gc);
                                cmax = @max(cmax, it.clusterEnd(gc));
                                const extra = if (uu.space and uu.width > 0) justify_extra else 0;
                                const src = it.src_map[@min(g.cluster, it.src_map.len - 1)];
                                try glyphs.append(out_a, .{ .id = g.id, .font = g.font, .x = pen + g.x_offset, .y = g.y_offset + it.shift, .advance = g.advance, .src = src });
                                pen += uu.width + extra;
                            }
                            const tstart = it.src_map[@min(cmin, it.src_map.len - 1)];
                            const tend = it.src_map[@min(cmax, it.src_map.len - 1)];


                            try frags.append(out_a, .{
                                .kind = .text,
                                .item = it.item,
                                .style = it.style,
                                .line = @intCast(li),
                                .x = fx,
                                .y = baseline - it.ascent + it.shift,
                                .w = pen,
                                .h = it.ascent + it.descent,
                                .baseline = baseline + it.shift,
                                .glyph_start = gstart,
                                .glyph_end = @intCast(glyphs.items.len),
                                .text_start = tstart,
                                .text_end = @max(tstart, tend),
                            });
                            x += pen;
                            k = kk;
                            continue;
                        },
                        .atomic => {
                            const asc = atomicAscent(it, owner_m);
                            var ty = baseline - asc + it.shift + it.amargin.top;
                            if (it.style.vertical_align == .top) ty = y + it.amargin.top;
                            if (it.style.vertical_align == .bottom) ty = y + line_h - it.ah - it.amargin.bottom;
                            try frags.append(out_a, .{ .kind = .atomic, .item = it.item, .style = it.style, .line = @intCast(li), .x = x + it.amargin.left, .y = ty, .w = it.aw, .h = it.ah, .baseline = baseline });
                            x += u.width;
                        },
                        .open => {
                            try frags.append(out_a, .{ .kind = .inline_box, .item = it.item, .style = it.style, .line = @intCast(li), .x = x, .y = baseline - it.ascent + it.shift, .w = 0, .h = it.ascent + it.descent, .baseline = baseline, .first = true, .last = false, .glyph_start = u.item });
                            try open_stack.append(b.arena, u.item);
                            x += u.width;
                        },
                        .close => {
                            x += u.width;
                            // close the matching inline box fragment on this line
                            var fi = frags.items.len;
                            while (fi > frag_start) {
                                fi -= 1;
                                const f = &frags.items[fi];
                                if (f.kind == .inline_box and f.item.node == it.item.node and f.item.pseudo == it.item.pseudo and f.w == 0 and !f.last) {
                                    f.w = x - f.x;
                                    f.last = true;
                                    break;
                                }
                            }
                            if (open_stack.items.len > 0) _ = open_stack.pop();
                        },
                        .forced_break => {},
                    }
                    k += 1;
                }
                if (ellipsis_item) |ei| {
                    const it = &b.items.items[ei];
                    const gstart: u32 = @intCast(glyphs.items.len);
                    var pen: f32 = 0;
                    for (ellipsis_glyphs) |g| {
                        try glyphs.append(out_a, .{ .id = g.id, .font = g.font, .x = pen + g.x_offset, .y = g.y_offset, .advance = g.advance, .src = 0 });
                        pen += g.advance;
                    }
                    try frags.append(out_a, .{ .kind = .text, .item = it.item, .style = it.style, .line = @intCast(li), .x = x, .y = baseline - it.ascent, .w = pen, .h = it.ascent + it.descent, .baseline = baseline, .glyph_start = gstart, .glyph_end = @intCast(glyphs.items.len), .ellipsis = true });
                    x += pen;
                }
                // inline boxes still open at the end of this line extend to the line end
                for (frags.items[frag_start..]) |*f| {
                    if (f.kind == .inline_box and !f.last and f.w == 0) f.w = x - f.x;
                }
                // fix up vertical extent of continued inline boxes
                for (frags.items[frag_start..]) |*f| {
                    if (f.kind == .inline_box and !f.first) {
                        const it = &b.items.items[f.glyph_start];
                        f.y = baseline - it.ascent + it.shift;
                        f.h = it.ascent + it.descent;
                    }
                }
            }
            try lines.append(out_a, .{ .y = y, .h = line_h, .baseline = baseline, .x = x0, .w = line_w, .frag_start = frag_start, .frag_end = @intCast(frags.items.len) });
            max_w = @max(max_w, line_w);
            y += line_h;
        }

        il.lines = lines.items;
        il.frags = frags.items;
        il.glyphs = glyphs.items;
        il.width = max_w;
        il.height = y;
        if (lines.items.len > 0) {
            il.first_baseline = lines.items[0].baseline;
            il.last_baseline = lines.items[lines.items.len - 1].baseline;
        }
        return il;
    }
};

/// Used line-height; `normal` uses the font's own ascent+descent+gap.
fn lineHeightFor(st: *const Style, m: font.Metrics) f32 {
    return switch (st.line_height) {
        .normal => m.ascent + m.descent + m.line_gap,
        .number => |n| st.font_size * n,
        .px => |p| p,
    };
}

fn atomicAscent(it: *const ItemData, owner_m: font.Metrics) f32 {
    // distance from the top margin edge to the baseline
    const oh = it.ah + it.amargin.top + it.amargin.bottom;
    return switch (it.style.vertical_align) {
        .middle => oh / 2 + owner_m.x_height / 2,
        .text_top => owner_m.ascent,
        .text_bottom => oh - owner_m.descent,
        else => if (it.abaseline) |b| b + it.amargin.top else oh,
    };
}

fn verticalShift(st: *const Style) f32 {
    return switch (st.vertical_align) {
        .sub => st.font_size * 0.2,
        .super => -st.font_size * 0.35,
        else => 0,
    };
}

const HAlign = enum { left, right, center, justify };

fn resolveAlign(a: props.TextAlign) HAlign {
    return switch (a) {
        .start, .left => .left,
        .end, .right => .right,
        .center => .center,
        .justify => .justify,
    };
}

fn firstCodepoint(s: []const u8) u21 {
    if (s.len == 0) return 0;
    const len = std.unicode.utf8ByteSequenceLength(s[0]) catch return s[0];
    if (len > s.len) return s[0];
    return std.unicode.utf8Decode(s[0..len]) catch s[0];
}

fn isCjk(cp: u21) bool {
    return (cp >= 0x2e80 and cp <= 0x9fff) or (cp >= 0xac00 and cp <= 0xd7af) or (cp >= 0xf900 and cp <= 0xfaff) or (cp >= 0xff00 and cp <= 0xffef) or (cp >= 0x20000 and cp <= 0x2fa1f);
}
