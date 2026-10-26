//! Painting: walks the laid-out tree in CSS painting order (stacking contexts,
//! z-index, positioned elements) and emits a backend-agnostic display list.
//! All coordinates are absolute CSS pixels; transforms and clips are explicit
//! stack operations so the GPU and CPU renderers interpret them identically.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const style_mod = @import("style.zig");
const layout = @import("layout.zig");
const inline_mod = @import("inline.zig");
const font = @import("text/font.zig");
const props = @import("css/properties.zig");

const Allocator = std.mem.Allocator;
const Document = dom.Document;
const NodeId = dom.NodeId;
const null_id = dom.null_id;
const Style = style_mod.Style;
const Rect = geom.Rect;
const Color = geom.Color;
const Corners = geom.Corners;
const Edges = geom.Edges;
const Item = layout.Item;
const Box = layout.Box;

pub const BorderSide = struct {
    width: f32,
    color: Color,
    style: props.BorderStyle,
};

pub const GlyphInstance = struct {
    id: u32,
    font: font.FontId,
    x: f32, // baseline origin, absolute
    y: f32,
};

pub const Cmd = union(enum) {
    /// filled (rounded) rectangle
    rect: struct { rect: Rect, radii: Corners, color: Color },
    /// border ring between the border box and the padding box
    border: struct { rect: Rect, radii: Corners, sides: [4]BorderSide },
    /// box-shadow; outer shadows are clipped to outside `box`, inset inside it
    shadow: struct { box: Rect, radii: Corners, offset_x: f32, offset_y: f32, blur: f32, spread: f32, color: Color, inset: bool },
    gradient: struct { rect: Rect, radii: Corners, clip: Rect, gradient: style_mod.Gradient },
    glyphs: struct { glyphs: []const GlyphInstance, color: Color, size: f32, shadow: ?style_mod.Shadow = null },
    image: struct { rect: Rect, radii: Corners, image: u32, src: Rect, opacity: f32 = 1 },
    /// a native surface (webview, wgpu view) occupies this rect
    surface: struct { rect: Rect, node: NodeId },
    push_clip: struct { rect: Rect, radii: Corners },
    pop_clip,
    push_layer: struct { opacity: f32, bounds: Rect, filters: []const style_mod.Filter = &.{}, backdrop: []const style_mod.Filter = &.{}, radii: Corners = .{} },
    pop_layer,
    push_transform: geom.Transform,
    pop_transform,
};

pub const HitRegion = struct {
    node: NodeId,
    rect: Rect,
    radii: Corners,
    /// intersection of active overflow clips (same space as `rect`)
    clip: Rect,
    /// maps window coordinates into the region's coordinate space
    inv: geom.Transform,
};

pub const DisplayList = struct {
    arena: std.heap.ArenaAllocator,
    cmds: std.ArrayList(Cmd) = .empty,
    /// hit-test regions in paint order (last = topmost)
    hits: std.ArrayList(HitRegion) = .empty,
    /// hit regions for native-surface anchoring
    surfaces: std.ArrayList(struct { node: NodeId, rect: Rect }) = .empty,
    /// window drag regions (app-region: drag)
    drag_regions: std.ArrayList(Rect) = .empty,
    no_drag_regions: std.ArrayList(Rect) = .empty,
    width: f32 = 0,
    height: f32 = 0,
    background: Color = Color.white,

    pub fn init(gpa: Allocator) DisplayList {
        return .{ .arena = std.heap.ArenaAllocator.init(gpa) };
    }
    pub fn deinit(dl: *DisplayList) void {
        dl.arena.deinit();
    }
    pub fn reset(dl: *DisplayList) void {
        _ = dl.arena.reset(.retain_capacity);
        dl.cmds = .empty;
        dl.hits = .empty;
        dl.surfaces = .empty;
        dl.drag_regions = .empty;
        dl.no_drag_regions = .empty;
    }
    fn a(dl: *DisplayList) Allocator {
        return dl.arena.allocator();
    }
    pub fn push(dl: *DisplayList, c: Cmd) !void {
        try dl.cmds.append(dl.a(), c);
    }

    /// Topmost node under a window-space point.
    pub fn hitTest(dl: *const DisplayList, x: f32, y: f32) NodeId {
        return dl.hitTestLive(x, y, null);
    }

    /// Hit test, skipping regions whose node was destroyed since the last
    /// paint (e.g. a closed popup) when `doc` is given.
    pub fn hitTestLive(dl: *const DisplayList, x: f32, y: f32, doc: ?*const dom.Document) NodeId {
        var i = dl.hits.items.len;
        while (i > 0) {
            i -= 1;
            const h = dl.hits.items[i];
            if (doc) |d| if (d.get(h.node) == null) continue;
            const p = h.inv.apply(.{ .x = x, .y = y });
            if (!h.clip.contains(p)) continue;
            if (!h.rect.contains(p)) continue;
            if (!h.radii.isZero() and @import("render/sdf.zig").roundedRect(p.x, p.y, h.rect, h.radii) > 0) continue;
            return h.node;
        }
        return null_id;
    }
};

pub const Hooks = struct {
    ctx: ?*anyopaque = null,
    /// image id for an <img> / url(), or null if not loaded
    image_for: ?*const fn (ctx: ?*anyopaque, url: []const u8) ?ImageRef = null,
    /// caret / selection for focused text controls
    text_state: ?*const fn (ctx: ?*anyopaque, node: NodeId) ?TextState = null,
    /// rasterize an inline <svg> at a size (CSS px) with currentColor
    svg_image: ?*const fn (ctx: ?*anyopaque, node: NodeId, w: f32, h: f32, color: Color) ?ImageRef = null,
    /// time in seconds for caret blinking
    caret_visible: bool = true,
};

pub const ImageRef = struct { id: u32, w: f32, h: f32 };

pub const TextState = struct {
    caret: inline_mod.TextOffset,
    anchor: inline_mod.TextOffset,
    scroll_x: f32 = 0,
    scroll_y: f32 = 0,
};

const ClipEntry = struct { rect: Rect, radii: Corners };

const Deferred = struct {
    it: Item,
    z: i32,
    order: u32,
    /// absolute position of the element's parent box origin
    px: f32,
    py: f32,
    clips: []const ClipEntry,
    transforms: []const geom.Transform,
};

pub const Painter = struct {
    doc: *Document,
    L: *layout.Layout,
    dl: *DisplayList,
    hooks: Hooks = .{},
    clips: std.ArrayList(ClipEntry) = .empty,
    transforms: std.ArrayList(geom.Transform) = .empty,
    order: u32 = 0,
    scale: f32 = 1,
    /// no html/body background leaves the canvas transparent, not white
    transparent_canvas: bool = false,

    pub fn paint(p: *Painter) !void {
        const doc = p.doc;
        p.dl.reset();
        p.dl.width = p.L.viewport_w;
        p.dl.height = p.L.viewport_h;
        const root = doc.documentElement();
        if (root == null_id) return;
        // canvas background propagates from html, else body (CSS 2.1 §14.2)
        const rst = style_mod.of(doc, root);
        var bg = rst.background_color;
        if (bg.a == 0) {
            const body = firstChildTag(doc, root, doc.atoms.body);
            if (body != null_id) bg = style_mod.of(doc, body).background_color;
        }
        p.dl.background = if (bg.a != 0) bg else if (p.transparent_canvas) Color.transparent else Color.white;
        try p.paintStackingContext(.{ .node = root }, 0, 0, true);
    }

    fn a(p: *Painter) Allocator {
        return p.dl.arena.allocator();
    }

    fn currentInverse(p: *Painter) geom.Transform {
        var t = geom.Transform.identity;
        for (p.transforms.items) |x| t = x.then(t);
        return t.invert() orelse geom.Transform.identity;
    }

    fn currentClip(p: *Painter) Rect {
        var r = Rect{ .x = -1e9, .y = -1e9, .w = 2e9, .h = 2e9 };
        for (p.clips.items) |c| r = r.intersect(c.rect);
        return r;
    }

    fn addHit(p: *Painter, node: NodeId, st: *const Style, r: Rect, radii: Corners) !void {
        if (st.pointer_events == .none or st.visibility != .visible) return;
        try p.dl.hits.append(p.a(), .{ .node = node, .rect = r, .radii = radii, .clip = p.currentClip(), .inv = p.currentInverse() });
    }

    fn createsStackingContext(st: *const Style, is_root: bool) bool {
        if (is_root) return true;
        if (st.position != .static and st.z_index != null) return true;
        if (st.opacity < 1 or st.hasTransform() or st.filter.len > 0 or st.backdrop_filter.len > 0) return true;
        if (st.position == .fixed or st.position == .sticky) return true;
        return false;
    }

    fn isDeferred(st: *const Style) bool {
        return st.position != .static or st.z_index != null or st.opacity < 1 or st.hasTransform() or st.filter.len > 0;
    }

    /// Paint an element that forms a stacking context (or positioned element)
    /// at parent origin (px, py).
    fn paintStackingContext(p: *Painter, it: Item, px: f32, py: f32, is_root: bool) Allocator.Error!void {
        const st = p.L.styleOf(it);
        const box = p.L.getBox(it) orelse return;
        if (!box.placed and !is_root) return;
        if (st.display == .none) return;
        const x = px + box.x + box.rel_x;
        const y = py + box.y + box.rel_y;
        const bb = Rect{ .x = x, .y = y, .w = box.w, .h = box.h };

        // transform
        var pushed_transform = false;
        if (st.hasTransform()) {
            const t = computeTransform(st, bb);
            if (!t.isIdentity()) {
                try p.dl.push(.{ .push_transform = t });
                try p.transforms.append(p.a(), t);
                pushed_transform = true;
            }
        }
        var pushed_layer = false;
        if (st.opacity < 1 or st.filter.len > 0 or st.backdrop_filter.len > 0) {
            if (st.opacity <= 0.001 and st.filter.len == 0) {
                if (pushed_transform) {
                    try p.dl.push(.pop_transform);
                    _ = p.transforms.pop();
                }
                return;
            }
            try p.dl.push(.{ .push_layer = .{ .opacity = st.opacity, .bounds = bb, .filters = st.filter, .backdrop = st.backdrop_filter, .radii = radiiOf(st, bb) } });
            pushed_layer = true;
        }
        const layer_cmd = if (pushed_layer) p.dl.cmds.items.len - 1 else 0;

        var deferred: std.ArrayList(Deferred) = .empty;
        try p.paintElement(it, st, box, x, y, &deferred, true);

        // positioned descendants and child stacking contexts, by z-index
        std.mem.sort(Deferred, deferred.items, {}, struct {
            fn lt(_: void, l: Deferred, r: Deferred) bool {
                if (l.z != r.z) return l.z < r.z;
                return l.order < r.order;
            }
        }.lt);
        // negative z-index should paint below normal flow; approximate by
        // painting them first among deferred (normal flow is already emitted)
        for (deferred.items) |d| try p.paintDeferred(d);

        if (pushed_layer) {
            // the layer must cover everything painted into it: shadows and
            // overflowing descendants extend past the border box
            const cmds = p.dl.cmds.items;
            if (inkBounds(cmds[layer_cmd + 1 ..])) |ink| {
                const l = &cmds[layer_cmd].push_layer;
                l.bounds = l.bounds.unite(ink);
            }
            try p.dl.push(.pop_layer);
        }
        if (pushed_transform) {
            try p.dl.push(.pop_transform);
            _ = p.transforms.pop();
        }
    }

    /// Union of the ink rects of `cmds`, in the coordinate space they start
    /// in (nested transforms are applied the way the renderers apply them).
    fn inkBounds(cmds: []const Cmd) ?Rect {
        var stack: [32]geom.Transform = undefined;
        var depth: usize = 0;
        var cur = geom.Transform.identity;
        var acc: ?Rect = null;
        for (cmds) |c| {
            const r: ?Rect = switch (c) {
                .rect => |x| x.rect,
                .border => |x| x.rect,
                .shadow => |x| if (x.inset) x.box else x.box.outset(x.spread + x.blur * 1.5 + 1).translate(x.offset_x, x.offset_y),
                .gradient => |x| x.rect,
                .image => |x| x.rect,
                .surface => |x| x.rect,
                .glyphs => |x| blk: {
                    if (x.glyphs.len == 0) break :blk null;
                    var g: ?Rect = null;
                    for (x.glyphs) |gi| {
                        const gr = Rect{ .x = gi.x - x.size * 0.25, .y = gi.y - x.size * 1.25, .w = x.size * 1.5, .h = x.size * 1.75 };
                        g = if (g) |prev| prev.unite(gr) else gr;
                    }
                    if (x.shadow) |sh| if (g) |gg| {
                        g = gg.unite(gg.outset(sh.blur * 1.5 + 1).translate(sh.x, sh.y));
                    };
                    break :blk g;
                },
                .push_transform => |t| {
                    if (depth < stack.len) stack[depth] = cur;
                    depth += 1;
                    cur = t.then(cur);
                    continue;
                },
                .pop_transform => {
                    if (depth > 0) depth -= 1;
                    cur = if (depth < stack.len) stack[depth] else geom.Transform.identity;
                    continue;
                },
                else => null,
            };
            if (r) |rr| {
                const br = cur.boundsOf(rr);
                acc = if (acc) |prev| prev.unite(br) else br;
            }
        }
        return acc;
    }

    fn paintDeferred(p: *Painter, d: Deferred) !void {
        // re-establish the clip/transform context captured at deferral
        const saved_clips = p.clips;
        const saved_tf = p.transforms;
        p.clips = .empty;
        p.transforms = .empty;
        for (d.transforms) |t| {
            try p.dl.push(.{ .push_transform = t });
            try p.transforms.append(p.a(), t);
        }
        for (d.clips) |c| {
            try p.dl.push(.{ .push_clip = .{ .rect = c.rect, .radii = c.radii } });
            try p.clips.append(p.a(), c);
        }
        try p.paintStackingContext(d.it, d.px, d.py, false);
        for (d.clips) |_| try p.dl.push(.pop_clip);
        for (d.transforms) |_| try p.dl.push(.pop_transform);
        p.clips = saved_clips;
        p.transforms = saved_tf;
    }

    fn defer_(p: *Painter, list: *std.ArrayList(Deferred), it: Item, st: *const Style, px: f32, py: f32) !void {
        p.order += 1;
        // fixed elements escape scroll clips of ancestors (but keep transforms)
        const clips: []const ClipEntry = if (st.position == .fixed) &.{} else try p.a().dupe(ClipEntry, p.clips.items);
        try list.append(p.a(), .{
            .it = it,
            .z = st.z_index orelse 0,
            .order = p.order,
            .px = px,
            .py = py,
            .clips = clips,
            .transforms = try p.a().dupe(geom.Transform, p.transforms.items),
        });
    }

    /// Background, border, content and outline of one element. Positioned
    /// children are deferred to the enclosing stacking context.
    fn paintElement(p: *Painter, it: Item, st: *const Style, box: *Box, x: f32, y: f32, deferred: *std.ArrayList(Deferred), is_sc_root: bool) Allocator.Error!void {
        _ = is_sc_root;
        const doc = p.doc;
        const bb = Rect{ .x = x, .y = y, .w = box.w, .h = box.h };
        const visible = st.visibility == .visible;
        const radii = radiiOf(st, bb);
        const is_root = it.pseudo == .none and it.node == doc.documentElement();
        const is_body = it.pseudo == .none and doc.node(it.node).tag == doc.atoms.body and doc.node(it.node).parent == doc.documentElement();

        if (it.pseudo == .none) try p.addHit(it.node, st, bb, radii) else try p.addHit(it.node, st, bb, radii);
        if (visible) {
            // background propagated to the canvas is not painted again
            const skip_bg = is_root or (is_body and style_mod.of(doc, doc.documentElement()).background_color.a == 0);
            try p.paintBoxDecorations(it, st, box, bb, radii, skip_bg);
            if (st.app_region == .drag) try p.dl.drag_regions.append(p.a(), bb);
            if (st.app_region == .no_drag) try p.dl.no_drag_regions.append(p.a(), bb);
        }

        // replaced content
        if (it.pseudo == .none and layout.isReplaced(doc, it.node)) {
            if (visible) try p.paintReplaced(it, st, box, bb);
            try p.paintOutline(st, bb, radii);
            return;
        }

        // clip for overflow
        const clip = st.clipsContent();
        var pushed_clip = false;
        if (clip) {
            const pad = Rect{ .x = x + box.border.left, .y = y + box.border.top, .w = @max(0, box.w - box.border.horizontal()), .h = @max(0, box.h - box.border.vertical()) };
            const inner_r = radii.shrink(@max(box.border.left, box.border.top));
            try p.dl.push(.{ .push_clip = .{ .rect = pad, .radii = inner_r } });
            try p.clips.append(p.a(), .{ .rect = pad, .radii = inner_r });
            pushed_clip = true;
        }
        const sx: f32 = if (clip) p.doc.node(it.node).scroll_x else 0;
        const sy: f32 = if (clip) p.doc.node(it.node).scroll_y else 0;
        const cx = x - sx;
        const cy = y - sy;

        // inline content
        if (visible or true) {
            const pb = box.padding.add(box.border);
            if (box.inline_layout) |il| try p.paintInline(il, cx + pb.left, cy + pb.top, deferred, cx, cy);
            for (box.anon.items) |an| try p.paintInline(an.il, cx + pb.left, cy + an.y, deferred, cx, cy);
        }

        // block-level children (tree order); positioned ones are deferred
        var kids: std.ArrayList(Item) = .empty;
        try p.L.children(it, &kids, p.a());
        for (kids.items) |k| {
            if (doc.node(k.node).kind == .text and k.pseudo == .none) {
                // anonymous text blocks in flex/grid containers
                const kb = p.L.getBox(k) orelse continue;
                if (!kb.placed) continue;
                if (kb.inline_layout) |il| try p.paintInline(il, cx + kb.x, cy + kb.y, deferred, cx, cy);
                continue;
            }
            const kst = p.L.styleOf(k);
            if (kst.display == .none) continue;
            const kb = p.L.getBox(k) orelse continue;
            if (!kb.placed or kb.in_inline) continue;
            if (isDeferred(kst)) {
                try p.defer_(deferred, k, kst, cx, cy);
                continue;
            }
            const kx = cx + kb.x + kb.rel_x;
            const ky = cy + kb.y + kb.rel_y;
            try p.paintElement(k, kst, kb, kx, ky, deferred, false);
        }

        if (pushed_clip) {
            try p.dl.push(.pop_clip);
            _ = p.clips.pop();
            // scrollbars for scroll containers
            if (visible) try p.paintScrollbars(it, st, box, bb);
        }
        if (visible) try p.paintOutline(st, bb, radii);
    }

    fn paintBoxDecorations(p: *Painter, it: Item, st: *const Style, box: *Box, bb: Rect, radii: Corners, skip_bg: bool) !void {
        _ = it;
        // outer shadows (painted before the background, clipped outside)
        var i = st.box_shadow.len;
        while (i > 0) {
            i -= 1;
            const sh = st.box_shadow[i];
            if (sh.inset or sh.color.a == 0) continue;
            try p.dl.push(.{ .shadow = .{ .box = bb, .radii = radii, .offset_x = sh.x, .offset_y = sh.y, .blur = sh.blur, .spread = sh.spread, .color = sh.color, .inset = false } });
        }
        if (!skip_bg) {
            const clip_rect = switch (st.background_clip) {
                .padding_box => bb.inset(box.border),
                .content_box => bb.inset(box.border.add(box.padding)),
                else => bb,
            };
            const clip_radii = if (st.background_clip == .border_box) radii else radii.shrink(@max(box.border.left, box.border.top));
            if (st.background_color.a > 0) {
                try p.dl.push(.{ .rect = .{ .rect = clip_rect, .radii = clip_radii, .color = st.background_color } });
            }
            // background images paint top layer first in the list -> draw in reverse
            var k = st.background_image.len;
            while (k > 0) {
                k -= 1;
                switch (st.background_image[k]) {
                    .gradient => |g| try p.dl.push(.{ .gradient = .{ .rect = bgPositioningArea(st, bb, box), .radii = clip_radii, .clip = clip_rect, .gradient = g } }),
                    .url => |u| if (p.hooks.image_for) |f| if (f(p.hooks.ctx, u)) |img| {
                        const area = bgPositioningArea(st, bb, box);
                        const dst = bgImageRect(st, area, img.w, img.h);
                        try p.dl.push(.{ .push_clip = .{ .rect = clip_rect, .radii = clip_radii } });
                        try p.dl.push(.{ .image = .{ .rect = dst, .radii = .{}, .image = img.id, .src = .{ .w = img.w, .h = img.h } } });
                        try p.dl.push(.pop_clip);
                    },
                }
            }
        }
        // inset shadows
        i = st.box_shadow.len;
        while (i > 0) {
            i -= 1;
            const sh = st.box_shadow[i];
            if (!sh.inset or sh.color.a == 0) continue;
            const pad = bb.inset(box.border);
            try p.dl.push(.{ .shadow = .{ .box = pad, .radii = radii.shrink(@max(box.border.left, box.border.top)), .offset_x = sh.x, .offset_y = sh.y, .blur = sh.blur, .spread = sh.spread, .color = sh.color, .inset = true } });
        }
        // border
        const bw = box.border;
        if (bw.top > 0 or bw.right > 0 or bw.bottom > 0 or bw.left > 0) {
            try p.dl.push(.{ .border = .{ .rect = bb, .radii = radii, .sides = .{
                .{ .width = bw.top, .color = st.border_color[0], .style = st.border_style[0] },
                .{ .width = bw.right, .color = st.border_color[1], .style = st.border_style[1] },
                .{ .width = bw.bottom, .color = st.border_color[2], .style = st.border_style[2] },
                .{ .width = bw.left, .color = st.border_color[3], .style = st.border_style[3] },
            } } });
        }
    }

    fn paintOutline(p: *Painter, st: *const Style, bb: Rect, radii: Corners) !void {
        if (st.outline_style == .none or st.outline_width <= 0 or st.outline_color.a == 0) return;
        const o = st.outline_offset + st.outline_width;
        const r = bb.outset(o);
        const rr = Corners{ .tl = if (radii.tl > 0) radii.tl + o else 0, .tr = if (radii.tr > 0) radii.tr + o else 0, .br = if (radii.br > 0) radii.br + o else 0, .bl = if (radii.bl > 0) radii.bl + o else 0 };
        const side: BorderSide = .{ .width = st.outline_width, .color = st.outline_color, .style = st.outline_style };
        try p.dl.push(.{ .border = .{ .rect = r, .radii = rr, .sides = .{ side, side, side, side } } });
    }

    fn paintScrollbars(p: *Painter, it: Item, st: *const Style, box: *Box, bb: Rect) !void {
        const n = p.doc.node(it.node);
        const pad_w = box.w - box.border.horizontal();
        const pad_h = box.h - box.border.vertical();
        const thumb_color = Color.rgba(0, 0, 0, 90);
        if ((st.overflow_y == .scroll or st.overflow_y == .auto) and box.scroll_h > pad_h + 0.5) {
            const track_h = pad_h - 4;
            const th = @max(20, track_h * pad_h / box.scroll_h);
            const max_scroll = box.scroll_h - pad_h;
            const ty = bb.y + box.border.top + 2 + (track_h - th) * (n.scroll_y / max_scroll);
            try p.dl.push(.{ .rect = .{ .rect = .{ .x = bb.x + bb.w - box.border.right - 8, .y = ty, .w = 6, .h = th }, .radii = Corners.all(3), .color = thumb_color } });
        }
        if ((st.overflow_x == .scroll or st.overflow_x == .auto) and box.scroll_w > pad_w + 0.5) {
            const track_w = pad_w - 4;
            const tw = @max(20, track_w * pad_w / box.scroll_w);
            const max_scroll = box.scroll_w - pad_w;
            const tx = bb.x + box.border.left + 2 + (track_w - tw) * (n.scroll_x / max_scroll);
            try p.dl.push(.{ .rect = .{ .rect = .{ .x = tx, .y = bb.y + bb.h - box.border.bottom - 8, .w = tw, .h = 6 }, .radii = Corners.all(3), .color = thumb_color } });
        }
    }

    fn paintReplaced(p: *Painter, it: Item, st: *const Style, box: *Box, bb: Rect) !void {
        const doc = p.doc;
        const n = doc.node(it.node);
        const w = &doc.atoms;
        const content = bb.inset(box.border.add(box.padding));
        const radii = radiiOf(st, bb);
        const accent = st.accent_color orelse Color.hex(0x0075ff);
        if (n.tag == w.img) {
            const src = n.getAttr(w.src) orelse return;
            const f = p.hooks.image_for orelse return;
            const img = f(p.hooks.ctx, src) orelse return;
            const fit = objectFit(st.object_fit, content, img.w, img.h);
            const inner_radii = radii.shrink(@max(box.border.left + box.padding.left, box.border.top + box.padding.top));
            try p.dl.push(.{ .push_clip = .{ .rect = content, .radii = inner_radii } });
            try p.dl.push(.{ .image = .{ .rect = fit.dst, .radii = .{}, .image = img.id, .src = fit.src } });
            try p.dl.push(.pop_clip);
            return;
        }
        if (n.tag == w.svg) {
            const f = p.hooks.svg_image orelse return;
            const img = f(p.hooks.ctx, it.node, content.w, content.h, st.color) orelse return;
            try p.dl.push(.{ .image = .{ .rect = content, .radii = .{}, .image = img.id, .src = .{ .w = img.w, .h = img.h } } });
            return;
        }
        if (n.tag == w.webview or n.tag == w.wgpu or (doc.interner.lookup("video") != null and n.tag == doc.interner.lookup("video").?)) {
            try p.dl.push(.{ .surface = .{ .rect = content, .node = it.node } });
            try p.dl.surfaces.append(p.a(), .{ .node = it.node, .rect = content });
            return;
        }
        if (n.tag == w.progress) {
            const max = attrF(n, w.max) orelse 1;
            const val = attrF(n, w.value) orelse 0;
            const frac = std.math.clamp(val / @max(0.0001, max), 0, 1);
            try p.dl.push(.{ .rect = .{ .rect = .{ .x = content.x, .y = content.y, .w = content.w * frac, .h = content.h }, .radii = radii, .color = accent } });
            return;
        }
        if (n.tag == w.input) {
            const t = n.getAttr(w.type) orelse "";
            if (std.ascii.eqlIgnoreCase(t, "checkbox") and n.state.checked) {
                try p.checkmark(bb, Color.white);
                return;
            }
            if (std.ascii.eqlIgnoreCase(t, "radio") and n.state.checked) {
                const d = @min(bb.w, bb.h) * 0.4;
                try p.dl.push(.{ .rect = .{ .rect = .{ .x = bb.x + (bb.w - d) / 2, .y = bb.y + (bb.h - d) / 2, .w = d, .h = d }, .radii = Corners.all(d / 2), .color = Color.white } });
                return;
            }
            if (std.ascii.eqlIgnoreCase(t, "range")) {
                const min = attrF(n, w.min) orelse 0;
                const max = attrF(n, w.max) orelse 100;
                const val = attrF(n, w.value) orelse (min + max) / 2;
                const frac = std.math.clamp((val - min) / @max(0.0001, max - min), 0, 1);
                const track_h: f32 = 4;
                const ty = content.y + (content.h - track_h) / 2;
                try p.dl.push(.{ .rect = .{ .rect = .{ .x = content.x, .y = ty, .w = content.w, .h = track_h }, .radii = Corners.all(2), .color = Color.hex(0xd0d0d0) } });
                try p.dl.push(.{ .rect = .{ .rect = .{ .x = content.x, .y = ty, .w = content.w * frac, .h = track_h }, .radii = Corners.all(2), .color = accent } });
                const kd: f32 = @min(16, content.h);
                const kx = content.x + (content.w - kd) * frac;
                try p.dl.push(.{ .shadow = .{ .box = .{ .x = kx, .y = content.y + (content.h - kd) / 2, .w = kd, .h = kd }, .radii = Corners.all(kd / 2), .offset_x = 0, .offset_y = 1, .blur = 2, .spread = 0, .color = Color.rgba(0, 0, 0, 80), .inset = false } });
                try p.dl.push(.{ .rect = .{ .rect = .{ .x = kx, .y = content.y + (content.h - kd) / 2, .w = kd, .h = kd }, .radii = Corners.all(kd / 2), .color = accent } });
                return;
            }
            if (std.ascii.eqlIgnoreCase(t, "color")) {
                const v = n.getAttr(w.value) orelse "#000000";
                const c = if (v.len > 1 and v[0] == '#') (@import("css/values.zig").parseHex(v[1..]) orelse Color.black) else Color.black;
                try p.dl.push(.{ .rect = .{ .rect = content, .radii = Corners.all(2), .color = c } });
                return;
            }
        }
        // text controls (input, textarea, select)
        if (box.inline_layout) |il| {
            const ts: ?TextState = if (p.hooks.text_state) |f| f(p.hooks.ctx, it.node) else null;
            const scroll_x: f32 = if (ts) |s| s.scroll_x else 0;
            const scroll_y: f32 = if (ts) |s| s.scroll_y else 0;
            try p.dl.push(.{ .push_clip = .{ .rect = bb.inset(box.border), .radii = radii.shrink(box.border.left) } });
            const ox = content.x - scroll_x;
            const oy = content.y - scroll_y;
            // selection highlight
            if (ts) |s| if (s.caret != s.anchor) {
                const lo = @min(s.caret.int(), s.anchor.int());
                const hi = @max(s.caret.int(), s.anchor.int());
                try p.paintSelection(il, it.node, lo, hi, ox, oy, Color.rgba(0, 117, 255, 70));
            };
            var dummy: std.ArrayList(Deferred) = .empty;
            try p.paintInline(il, ox, oy, &dummy, ox, oy);
            if (ts) |s| if (s.caret == s.anchor and p.hooks.caret_visible) {
                if (il.caretAt(it.node, s.caret)) |c| {
                    const caret_color = st.caret_color orelse st.color;
                    try p.dl.push(.{ .rect = .{ .rect = .{ .x = @round((ox + c.x) * p.scale) / p.scale, .y = oy + c.y, .w = 1.5, .h = c.h }, .radii = .{}, .color = caret_color } });
                }
            };
            try p.dl.push(.pop_clip);
            if (n.tag == w.select) {
                // dropdown chevron
                const cx = bb.x + bb.w - box.border.right - 12;
                const cy = bb.y + bb.h / 2;
                try p.chevron(cx, cy, st.color);
            }
        }
    }

    /// A stroke between two points with round caps (a rotated capsule). Glyphs
    /// are drawn as polylines through explicit points, so joints always meet.
    fn segment(p: *Painter, from: geom.Point, to: geom.Point, width: f32, color: Color) !void {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = @sqrt(dx * dx + dy * dy);
        const cx = (from.x + to.x) / 2;
        const cy = (from.y + to.y) / 2;
        const r = width / 2;
        const t = geom.Transform.translation(-cx, -cy).then(geom.Transform.rotation(std.math.atan2(dy, dx))).then(geom.Transform.translation(cx, cy));
        try p.dl.push(.{ .push_transform = t });
        try p.dl.push(.{ .rect = .{ .rect = .{ .x = cx - len / 2 - r, .y = cy - r, .w = len + width, .h = width }, .radii = Corners.all(r), .color = color } });
        try p.dl.push(.pop_transform);
    }

    fn polyline(p: *Painter, pts: []const geom.Point, width: f32, color: Color) !void {
        for (pts[0 .. pts.len - 1], pts[1..]) |from, to| try p.segment(from, to, width, color);
    }

    /// Checkmark inside a checkbox's border box.
    fn checkmark(p: *Painter, bb: Rect, color: Color) !void {
        const u = @min(bb.w, bb.h);
        const ox = bb.x + (bb.w - u) / 2;
        const oy = bb.y + (bb.h - u) / 2;
        const pts = [_]geom.Point{
            .{ .x = ox + u * 0.26, .y = oy + u * 0.53 },
            .{ .x = ox + u * 0.43, .y = oy + u * 0.70 },
            .{ .x = ox + u * 0.75, .y = oy + u * 0.32 },
        };
        try p.polyline(&pts, @max(1.5, u * 0.13), color);
    }

    /// Downward chevron centred on (cx, cy), for select boxes.
    fn chevron(p: *Painter, cx: f32, cy: f32, color: Color) !void {
        const pts = [_]geom.Point{
            .{ .x = cx - 3.5, .y = cy - 1.75 },
            .{ .x = cx, .y = cy + 1.75 },
            .{ .x = cx + 3.5, .y = cy - 1.75 },
        };
        try p.polyline(&pts, 1.5, color);
    }

    pub fn paintSelection(p: *Painter, il: *const inline_mod.InlineLayout, node: NodeId, lo: u32, hi: u32, ox: f32, oy: f32, color: Color) !void {
        for (il.frags) |f| {
            if (f.kind != .text or f.item.node != node or f.ellipsis) continue;
            if (hi <= f.text_start or lo >= f.text_end) continue;
            var x0: ?f32 = null;
            var x1: f32 = f.x;
            for (il.glyphs[f.glyph_start..f.glyph_end]) |g| {
                if (g.src >= lo and g.src < hi) {
                    if (x0 == null) x0 = f.x + g.x;
                    x1 = f.x + g.x + g.advance;
                }
            }
            if (x0) |sx| {
                const line = il.lines[f.line];
                try p.dl.push(.{ .rect = .{ .rect = .{ .x = ox + sx, .y = oy + line.y, .w = x1 - sx, .h = line.h }, .radii = .{}, .color = color } });
            }
        }
    }

    /// Inline content: inline-box decorations, text runs, decorations; atomic
    /// inlines are painted as their own (non-stacking) boxes.
    fn paintInline(p: *Painter, il: *const inline_mod.InlineLayout, ox: f32, oy: f32, deferred: *std.ArrayList(Deferred), parent_x: f32, parent_y: f32) Allocator.Error!void {
        const doc = p.doc;
        // inline box backgrounds and borders
        for (il.frags) |f| {
            if (f.kind != .inline_box) continue;
            const st = f.style;
            if (st.visibility != .visible) continue;
            const bw = st.borderWidths();
            const pad = layout.resolvePadding(st, 0);
            const x0 = ox + f.x + (if (f.first) (st.margin[3].resolve(0) orelse 0) else 0);
            var x1 = ox + f.x + f.w;
            if (f.last) x1 -= st.margin[1].resolve(0) orelse 0;
            const r = Rect{ .x = x0, .y = oy + f.y - pad.top - bw.top, .w = @max(0, x1 - x0), .h = f.h + pad.vertical() + bw.vertical() };
            var radii = radiiOf(st, r);
            if (!f.first) {
                radii.tl = 0;
                radii.bl = 0;
            }
            if (!f.last) {
                radii.tr = 0;
                radii.br = 0;
            }
            for (st.box_shadow) |sh| if (!sh.inset and sh.color.a > 0) {
                try p.dl.push(.{ .shadow = .{ .box = r, .radii = radii, .offset_x = sh.x, .offset_y = sh.y, .blur = sh.blur, .spread = sh.spread, .color = sh.color, .inset = false } });
            };
            if (st.background_color.a > 0) try p.dl.push(.{ .rect = .{ .rect = r, .radii = radii, .color = st.background_color } });
            for (st.background_image) |img| switch (img) {
                .gradient => |g| try p.dl.push(.{ .gradient = .{ .rect = r, .radii = radii, .clip = r, .gradient = g } }),
                else => {},
            };
            if (bw.top > 0 or bw.bottom > 0 or (f.first and bw.left > 0) or (f.last and bw.right > 0)) {
                try p.dl.push(.{ .border = .{ .rect = r, .radii = radii, .sides = .{
                    .{ .width = bw.top, .color = st.border_color[0], .style = st.border_style[0] },
                    .{ .width = if (f.last) bw.right else 0, .color = st.border_color[1], .style = st.border_style[1] },
                    .{ .width = bw.bottom, .color = st.border_color[2], .style = st.border_style[2] },
                    .{ .width = if (f.first) bw.left else 0, .color = st.border_color[3], .style = st.border_style[3] },
                } } });
            }
            if (st.app_region == .drag) try p.dl.drag_regions.append(p.a(), r);
            if (f.item.pseudo == .none) try p.addHit(f.item.node, st, r, radii);
        }
        // atomic inlines and text, in order
        for (il.frags) |f| {
            switch (f.kind) {
                .text => {
                    const st = f.style;
                    if (st.visibility != .visible) continue;
                    {
                        // text hits resolve to the element containing the text
                        var hn = f.item.node;
                        if (doc.node(hn).kind == .text) hn = doc.node(hn).parent;
                        try p.addHit(hn, st, .{ .x = ox + f.x, .y = oy + p.lineTop(il, f), .w = f.w, .h = il.lines[f.line].h }, .{});
                    }
                    const n_glyphs = f.glyph_end - f.glyph_start;
                    if (n_glyphs == 0) continue;
                    const out = try p.a().alloc(GlyphInstance, n_glyphs);
                    for (il.glyphs[f.glyph_start..f.glyph_end], out) |g, *o| {
                        o.* = .{ .id = g.id, .font = g.font, .x = ox + f.x + g.x, .y = oy + f.baseline + g.y };
                    }
                    for (st.text_shadow) |sh| {
                        if (sh.color.a == 0) continue;
                        try p.dl.push(.{ .glyphs = .{ .glyphs = out, .color = sh.color, .size = st.font_size, .shadow = sh } });
                    }
                    try p.dl.push(.{ .glyphs = .{ .glyphs = out, .color = st.color, .size = st.font_size } });
                    try p.paintDecorations(f, st, ox, oy);
                },
                .atomic => {
                    const kst = p.L.styleOf(f.item);
                    const kb = p.L.getBox(f.item) orelse continue;
                    if (isDeferred(kst)) {
                        try p.defer_(deferred, f.item, kst, parent_x, parent_y);
                        continue;
                    }
                    try p.paintElement(f.item, kst, kb, parent_x + kb.x + kb.rel_x, parent_y + kb.y + kb.rel_y, deferred, false);
                },
                .inline_box => {},
            }
        }
    }

    fn lineTop(p: *Painter, il: *const inline_mod.InlineLayout, f: inline_mod.Frag) f32 {
        _ = p;
        return il.lines[f.line].y;
    }

    fn paintDecorations(p: *Painter, f: inline_mod.Frag, st: *const Style, ox: f32, oy: f32) !void {
        // decorations propagate from inline ancestors up to the block owner
        var deco = st.text_decoration;
        var color = st.text_decoration_color;
        var cur = f.item.node;
        const doc = p.doc;
        if (doc.node(cur).kind == .text) cur = doc.node(cur).parent;
        var depth: usize = 0;
        while (cur != null_id and doc.node(cur).kind == .element and depth < 32) : (depth += 1) {
            const s = style_mod.of(doc, cur);
            if (s.text_decoration.underline or s.text_decoration.line_through or s.text_decoration.overline) {
                deco.underline = deco.underline or s.text_decoration.underline;
                deco.line_through = deco.line_through or s.text_decoration.line_through;
                deco.overline = deco.overline or s.text_decoration.overline;
                color = s.text_decoration_color;
            }
            if (s.display != .inline_) break;
            cur = doc.node(cur).parent;
        }
        if (!deco.underline and !deco.line_through and !deco.overline) return;
        const fid = p.L.fonts.resolve(layout.fontSpec(st));
        const m = p.L.fonts.metrics(fid);
        const th = @max(1, @round(m.underline_thickness * p.scale) / p.scale);
        const x = ox + f.x;
        const w = f.w;
        const base = oy + f.baseline;
        if (deco.underline) try p.dl.push(.{ .rect = .{ .rect = .{ .x = x, .y = snap(base + @max(m.underline_pos, 1), p.scale), .w = w, .h = th }, .radii = .{}, .color = color } });
        if (deco.line_through) try p.dl.push(.{ .rect = .{ .rect = .{ .x = x, .y = snap(base - m.x_height / 2 - th / 2, p.scale), .w = w, .h = th }, .radii = .{}, .color = color } });
        if (deco.overline) try p.dl.push(.{ .rect = .{ .rect = .{ .x = x, .y = snap(base - m.ascent, p.scale), .w = w, .h = th }, .radii = .{}, .color = color } });
    }
};

fn snap(v: f32, scale: f32) f32 {
    return @round(v * scale) / scale;
}

fn attrF(n: *const dom.Node, a: dom.Atom) ?f32 {
    const v = n.getAttr(a) orelse return null;
    return std.fmt.parseFloat(f32, std.mem.trim(u8, v, " ")) catch null;
}

fn firstChildTag(doc: *const Document, parent: NodeId, tag: dom.Atom) NodeId {
    var c = doc.node(parent).first_child;
    while (c != null_id) : (c = doc.node(c).next) if (doc.node(c).kind == .element and doc.node(c).tag == tag) return c;
    return null_id;
}

pub fn radiiOf(st: *const Style, r: Rect) Corners {
    const c = Corners{
        .tl = st.radius[0].resolve(@min(r.w, r.h)),
        .tr = st.radius[1].resolve(@min(r.w, r.h)),
        .br = st.radius[2].resolve(@min(r.w, r.h)),
        .bl = st.radius[3].resolve(@min(r.w, r.h)),
    };
    // percentages resolve per axis in CSS; using the smaller side keeps 50% circular
    return c.clampTo(r.w, r.h);
}

pub fn computeTransform(st: *const Style, bb: Rect) geom.Transform {
    const ox = bb.x + st.transform_origin[0].resolve(bb.w);
    const oy = bb.y + st.transform_origin[1].resolve(bb.h);
    var t = geom.Transform.translation(-ox, -oy);
    // individual properties apply before `transform`: translate, rotate, scale, then transform list
    var m = geom.Transform.identity;
    for (st.transform) |op| {
        const om: geom.Transform = switch (op) {
            .translate => |tr| geom.Transform.translation(tr.x.resolve(bb.w), tr.y.resolve(bb.h)),
            .scale => |s| geom.Transform.scaling(s.x, s.y),
            .rotate => |r| geom.Transform.rotation(r),
            .skew => |s| .{ .a = 1, .b = @tan(s.y), .c = @tan(s.x), .d = 1 },
            .matrix => |mm| mm,
        };
        // CSS transform lists compose left-to-right as post-multiplication:
        // the rightmost function applies first.
        m = om.then(m);
    }
    t = t.then(m);
    if (st.scale) |s| t = t.then(geom.Transform.scaling(s[0], s[1]));
    if (st.rotate) |r| t = t.then(geom.Transform.rotation(r));
    if (st.translate) |tr| t = t.then(geom.Transform.translation(tr[0].resolve(bb.w), tr[1].resolve(bb.h)));
    return t.then(geom.Transform.translation(ox, oy));
}

fn bgPositioningArea(st: *const Style, bb: Rect, box: *const Box) Rect {
    _ = st;
    return bb.inset(box.border);
}

fn bgImageRect(st: *const Style, area: Rect, iw: f32, ih: f32) Rect {
    var w = iw;
    var h = ih;
    switch (st.background_size) {
        .cover => {
            const s = @max(area.w / iw, area.h / ih);
            w = iw * s;
            h = ih * s;
        },
        .contain => {
            const s = @min(area.w / iw, area.h / ih);
            w = iw * s;
            h = ih * s;
        },
        .size => |sz| {
            const ctx = @import("css/values.zig").Ctx{};
            if (sz.w) |lw| w = @import("css/values.zig").computeLength(lw, ctx).resolve(area.w);
            if (sz.h) |lh| h = @import("css/values.zig").computeLength(lh, ctx).resolve(area.h);
            if (sz.w != null and sz.h == null) h = ih * (w / iw);
            if (sz.h != null and sz.w == null) w = iw * (h / ih);
        },
    }
    const px = area.x + st.background_position[0].px + st.background_position[0].pct * (area.w - w);
    const py = area.y + st.background_position[1].px + st.background_position[1].pct * (area.h - h);
    return .{ .x = px, .y = py, .w = w, .h = h };
}

fn objectFit(fit: props.ObjectFit, content: Rect, iw: f32, ih: f32) struct { dst: Rect, src: Rect } {
    const full_src = Rect{ .w = iw, .h = ih };
    if (iw <= 0 or ih <= 0) return .{ .dst = content, .src = full_src };
    switch (fit) {
        .fill => return .{ .dst = content, .src = full_src },
        .contain, .scale_down => {
            var s = @min(content.w / iw, content.h / ih);
            if (fit == .scale_down) s = @min(s, 1);
            const w = iw * s;
            const h = ih * s;
            return .{ .dst = .{ .x = content.x + (content.w - w) / 2, .y = content.y + (content.h - h) / 2, .w = w, .h = h }, .src = full_src };
        },
        .cover => {
            const s = @max(content.w / iw, content.h / ih);
            const sw = content.w / s;
            const sh = content.h / s;
            return .{ .dst = content, .src = .{ .x = (iw - sw) / 2, .y = (ih - sh) / 2, .w = sw, .h = sh } };
        },
        .none => {
            return .{ .dst = .{ .x = content.x + (content.w - iw) / 2, .y = content.y + (content.h - ih) / 2, .w = iw, .h = ih }, .src = full_src };
        },
    }
}
