//! CSS Grid layout (the commonly used subset): explicit/implicit tracks,
//! repeat() incl. auto-fill/auto-fit, minmax(), fr, line and span placement,
//! row/column auto-placement (sparse/dense), gaps and box alignment.
const std = @import("std");
const dom = @import("dom.zig");
const geom = @import("geom.zig");
const style_mod = @import("style.zig");
const props = @import("css/properties.zig");
const values = @import("css/values.zig");
const layout = @import("layout.zig");

const Layout = layout.Layout;
const Item = layout.Item;
const Inputs = layout.Inputs;
const Output = layout.Output;
const Box = layout.Box;
const Style = style_mod.Style;
const Edges = geom.Edges;

const Track = struct {
    def: props.Track,
    base: f32 = 0,
    limit: f32 = std.math.inf(f32),
    fr: f32 = 0,
    pos: f32 = 0,
    size: f32 = 0,
};

const GItem = struct {
    item: Item,
    st: *const Style,
    margin: Edges,
    col: u32 = 0,
    col_span: u32 = 1,
    row: u32 = 0,
    row_span: u32 = 1,
    min_w: f32 = 0,
    max_w: f32 = 0,
    w: f32 = 0,
    h: f32 = 0,
};

fn resolveTrackSize(t: props.Track, basis: ?f32, ctx: values.Ctx) ?f32 {
    return switch (t) {
        .fixed => |l| blk: {
            const lp = values.computeLength(l, ctx);
            if (lp.pct != 0 and basis == null) break :blk null;
            break :blk lp.resolve(basis orelse 0);
        },
        else => null,
    };
}

fn expandTracks(a: std.mem.Allocator, list: props.TrackList, inner: ?f32, gap: f32, ctx: values.Ctx) ![]props.Track {
    var out: std.ArrayList(props.Track) = .empty;
    if (list.auto_repeat == .none or inner == null) {
        try out.appendSlice(a, list.tracks);
        return out.items;
    }
    // auto-fill: as many repetitions as fit
    var pattern_size: f32 = 0;
    for (list.tracks) |t| {
        const sz = switch (t) {
            .minmax => |mm| resolveTrackSize(mm.min.*, inner, ctx) orelse resolveTrackSize(mm.max.*, inner, ctx) orelse 0,
            else => resolveTrackSize(t, inner, ctx) orelse 0,
        };
        pattern_size += sz;
    }
    const n_pat: f32 = @floatFromInt(list.tracks.len);
    var reps: usize = 1;
    if (pattern_size > 0) {
        const fit = (inner.? + gap) / (pattern_size + gap * n_pat);
        reps = @max(1, @as(usize, @intFromFloat(@floor(fit))));
    }
    for (0..@min(reps, 500)) |_| try out.appendSlice(a, list.tracks);
    return out.items;
}

pub fn layoutGrid(L: *Layout, it: Item, st: *const Style, box: *Box, in: Inputs) !Output {
    const a = L.scratch.allocator();
    const pb = box.padding.add(box.border);
    const r = Layout.resolveSizes(st, box, in.cb_w, in.cb_h);
    const margins = layout.resolveMargins(st, in.cb_w orelse 0);
    const ctx: values.Ctx = .{ .em = st.font_size, .rem = st.font_size, .vw = L.viewport_w, .vh = L.viewport_h };

    var bw: ?f32 = in.known_w orelse (if (r.w) |w| @max(r.min_w, @min(w, r.max_w)) else null);
    if (bw == null and in.sizing == .fill and in.avail_w == .definite) bw = @max(r.min_w, @min(in.avail_w.definite - margins.left - margins.right, r.max_w));
    var bh: ?f32 = in.known_h orelse (if (r.h) |h| @max(r.min_h, @min(h, r.max_h)) else null);
    var inner_w: ?f32 = if (bw) |w| @max(0, w - pb.horizontal()) else null;
    const col_gap = st.column_gap.resolve(inner_w orelse 0);
    const row_gap = st.row_gap.resolve(if (bh) |h| h - pb.vertical() else 0);

    // ---- items ----
    var kids: std.ArrayList(Item) = .empty;
    try L.children(it, &kids, a);
    var items: std.ArrayList(GItem) = .empty;
    for (kids.items) |k| {
        const kst = L.styleOf(k);
        const kn = L.doc.node(k.node);
        if (kst.display == .none) {
            if (in.perform) (try L.boxOf(k)).placed = false;
            continue;
        }
        if (kn.kind == .text and k.pseudo == .none) {
            var ws = true;
            for (kn.text.items) |c| if (!std.ascii.isWhitespace(c)) {
                ws = false;
                break;
            };
            if (ws) continue;
        } else if (kst.isOutOfFlow()) {
            if (in.perform) {
                try L.pending_abs.append(L.gpa, .{ .item = k, .parent = it, .sx = pb.left, .sy = pb.top });
                (try L.boxOf(k)).placed = true;
            }
            continue;
        }
        try items.append(a, .{ .item = k, .st = kst, .margin = layout.resolveMargins(kst, inner_w orelse 0) });
    }
    std.mem.sort(GItem, items.items, {}, struct {
        fn lt(_: void, x: GItem, y: GItem) bool {
            return x.st.order < y.st.order;
        }
    }.lt);

    // ---- explicit tracks ----
    const col_defs = try expandTracks(a, st.grid_template_columns, inner_w, col_gap, ctx);
    const row_defs = try expandTracks(a, st.grid_template_rows, if (bh) |h| h - pb.vertical() else null, row_gap, ctx);
    var n_cols: u32 = @intCast(@max(1, col_defs.len));
    var n_rows: u32 = @intCast(row_defs.len);

    // ---- placement ----
    const col_flow = st.grid_auto_flow == .column or st.grid_auto_flow == .column_dense;
    const dense = st.grid_auto_flow == .row_dense or st.grid_auto_flow == .column_dense;
    for (items.items) |*g| {
        resolveLine(g.st.grid_column, @intCast(col_defs.len), &g.col, &g.col_span);
        resolveLine(g.st.grid_row, @intCast(row_defs.len), &g.row, &g.row_span);
        if (g.col != std.math.maxInt(u32)) n_cols = @max(n_cols, g.col + g.col_span);
        if (g.col == std.math.maxInt(u32)) n_cols = @max(n_cols, g.col_span);
        if (g.row != std.math.maxInt(u32)) n_rows = @max(n_rows, g.row + g.row_span);
    }
    var occ = Occupancy{ .a = a, .cols = n_cols };
    // items with both positions definite
    for (items.items) |*g| {
        if (g.col != std.math.maxInt(u32) and g.row != std.math.maxInt(u32)) try occ.mark(g.row, g.col, g.row_span, g.col_span);
    }
    var cur_r: u32 = 0;
    var cur_c: u32 = 0;
    for (items.items) |*g| {
        const auto_c = g.col == std.math.maxInt(u32);
        const auto_r = g.row == std.math.maxInt(u32);
        if (!auto_c and !auto_r) continue;
        if (dense) {
            cur_r = 0;
            cur_c = 0;
        }
        if (!col_flow) {
            if (!auto_r and auto_c) {
                // row fixed: first free column in that row
                var c: u32 = 0;
                while (!try occ.free(g.row, c, g.row_span, g.col_span)) c += 1;
                g.col = c;
            } else if (auto_r and !auto_c) {
                var rr: u32 = if (dense) 0 else cur_r;
                if (!dense and g.col < cur_c) rr += 1;
                while (!try occ.free(rr, g.col, g.row_span, g.col_span)) rr += 1;
                g.row = rr;
                cur_r = rr;
                cur_c = g.col;
            } else {
                var rr = cur_r;
                var c = cur_c;
                while (true) {
                    if (c + g.col_span > occ.cols) {
                        c = 0;
                        rr += 1;
                        continue;
                    }
                    if (try occ.free(rr, c, g.row_span, g.col_span)) break;
                    c += 1;
                }
                g.row = rr;
                g.col = c;
                cur_r = rr;
                cur_c = c + g.col_span;
            }
        } else {
            // column flow: fill columns top to bottom
            const rows_avail = @max(n_rows, 1);
            if (auto_c and auto_r) {
                var c = cur_c;
                var rr = cur_r;
                while (true) {
                    if (rr + g.row_span > rows_avail) {
                        rr = 0;
                        c += 1;
                        continue;
                    }
                    if (c + g.col_span > occ.cols) occ.cols = c + g.col_span;
                    if (try occ.free(rr, c, g.row_span, g.col_span)) break;
                    rr += 1;
                }
                g.row = rr;
                g.col = c;
                cur_c = c;
                cur_r = rr + g.row_span;
            } else if (auto_r) {
                var rr: u32 = 0;
                while (!try occ.free(rr, g.col, g.row_span, g.col_span)) rr += 1;
                g.row = rr;
            } else {
                var c: u32 = 0;
                while (true) {
                    if (c + g.col_span > occ.cols) occ.cols = c + g.col_span;
                    if (try occ.free(g.row, c, g.row_span, g.col_span)) break;
                    c += 1;
                }
                g.col = c;
            }
        }
        try occ.mark(g.row, g.col, g.row_span, g.col_span);
        n_cols = @max(n_cols, g.col + g.col_span);
        n_rows = @max(n_rows, g.row + g.row_span);
    }
    n_cols = @max(n_cols, occ.cols);

    // ---- track lists (explicit + implicit) ----
    var cols = try a.alloc(Track, n_cols);
    for (cols, 0..) |*t, i| t.* = .{ .def = if (i < col_defs.len) col_defs[i] else autoTrack(st.grid_auto_columns, i - col_defs.len) };
    var rows = try a.alloc(Track, n_rows);
    for (rows, 0..) |*t, i| t.* = .{ .def = if (i < row_defs.len) row_defs[i] else autoTrack(st.grid_auto_rows, i - row_defs.len) };

    // ---- column sizing ----
    for (items.items) |*g| {
        g.min_w = try L.intrinsicWidth(g.item, .min, inner_w);
        g.max_w = try L.intrinsicWidth(g.item, .max, inner_w);
    }
    const width_mode: Mode = if (inner_w != null) .definite else switch (in.avail_w) {
        .min_content => .min,
        else => .max,
    };
    sizeTracks(cols, items.items, true, inner_w, col_gap, ctx, width_mode, &[_]f32{});
    if (inner_w == null) {
        var total: f32 = col_gap * @as(f32, @floatFromInt(cols.len - 1));
        for (cols) |t| total += t.size;
        if (in.avail_w == .definite) {
            const avail = @max(0, in.avail_w.definite - margins.left - margins.right - pb.horizontal());
            if (total > avail and in.sizing == .fit) {
                // shrink-to-fit: re-run with the available width
                sizeTracks(cols, items.items, true, avail, col_gap, ctx, .definite, &[_]f32{});
                total = avail;
            }
        }
        inner_w = total;
        bw = @max(r.min_w, @min(total + pb.horizontal(), r.max_w));
        inner_w = bw.? - pb.horizontal();
    }
    // column positions
    placeTracks(cols, inner_w.?, col_gap, st.justify_content);

    // ---- row sizing: heights at the resolved column widths ----
    for (items.items) |*g| {
        var w: f32 = col_gap * @as(f32, @floatFromInt(g.col_span - 1));
        for (cols[g.col .. g.col + g.col_span]) |t| w += t.size;
        g.w = w;
        const ja = justifyOf(st, g.st);
        const known_w: ?f32 = if (ja == .stretch and g.st.width == .auto) @max(0, w - g.margin.left - g.margin.right) else null;
        const o = try L.compute(g.item, .{ .known_w = known_w, .avail_w = .{ .definite = @max(0, w - g.margin.left - g.margin.right) }, .cb_w = w, .sizing = .fit, .perform = false });
        g.h = o.h + g.margin.top + g.margin.bottom;
    }
    const inner_h_known: ?f32 = if (bh) |h| @max(0, h - pb.vertical()) else null;
    var heights = try a.alloc(f32, items.items.len);
    for (items.items, 0..) |g, i| heights[i] = g.h;
    sizeTracks(rows, items.items, false, inner_h_known, row_gap, ctx, if (inner_h_known != null) .definite else .max, heights);
    var total_h: f32 = row_gap * @as(f32, @floatFromInt(@max(1, rows.len) - 1));
    for (rows) |t| total_h += t.size;
    if (rows.len == 0) total_h = 0;
    if (bh == null) bh = @max(r.min_h, @min(total_h + pb.vertical(), r.max_h));
    const inner_h = bh.? - pb.vertical();
    placeTracks(rows, inner_h, row_gap, alignToJustify(st.align_content));

    // ---- place items ----
    var first_baseline: ?f32 = null;
    for (items.items) |*g| {
        const cell_x = cols[g.col].pos;
        const cell_y = if (rows.len > 0) rows[g.row].pos else 0;
        var cell_w: f32 = col_gap * @as(f32, @floatFromInt(g.col_span - 1));
        for (cols[g.col .. g.col + g.col_span]) |t| cell_w += t.size;
        var cell_h: f32 = row_gap * @as(f32, @floatFromInt(g.row_span - 1));
        if (rows.len > 0) for (rows[g.row .. g.row + g.row_span]) |t| {
            cell_h += t.size;
        };
        const ja = justifyOf(st, g.st);
        const aa = alignOf(st, g.st);
        const avail_w = @max(0, cell_w - g.margin.left - g.margin.right);
        const avail_h = @max(0, cell_h - g.margin.top - g.margin.bottom);
        const known_w: ?f32 = if (ja == .stretch and g.st.width == .auto and g.st.margin[1] != .auto and g.st.margin[3] != .auto) avail_w else null;
        const known_h: ?f32 = if (aa == .stretch and g.st.height == .auto and g.st.margin[0] != .auto and g.st.margin[2] != .auto) avail_h else null;
        const o = try L.compute(g.item, .{ .known_w = known_w, .known_h = known_h, .avail_w = .{ .definite = avail_w }, .avail_h = .{ .definite = avail_h }, .cb_w = cell_w, .cb_h = cell_h, .sizing = .fit, .perform = in.perform });
        var x = cell_x + g.margin.left;
        var y = cell_y + g.margin.top;
        const fx = avail_w - o.w;
        const fy = avail_h - o.h;
        if (g.st.margin[3] == .auto and g.st.margin[1] == .auto) {
            x += fx / 2;
        } else if (g.st.margin[3] == .auto) {
            x += fx;
        } else switch (ja) {
            .center => x += fx / 2,
            .end, .flex_end, .right => x += fx,
            else => {},
        }
        if (g.st.margin[0] == .auto and g.st.margin[2] == .auto) {
            y += fy / 2;
        } else if (g.st.margin[0] == .auto) {
            y += fy;
        } else switch (aa) {
            .center => y += fy / 2,
            .end, .flex_end => y += fy,
            else => {},
        }
        if (first_baseline == null) if (o.baseline) |b| {
            first_baseline = pb.top + y + b;
        };
        if (in.perform) {
            const kb = try L.boxOf(g.item);
            kb.x = pb.left + x;
            kb.y = pb.top + y;
            kb.margin = g.margin;
            kb.placed = true;
            kb.in_inline = false;
        }
    }
    const out: Output = .{ .w = bw.?, .h = bh.?, .baseline = first_baseline, .last_baseline = first_baseline };
    if (in.perform) {
        var tw: f32 = col_gap * @as(f32, @floatFromInt(cols.len - 1));
        for (cols) |t| tw += t.size;
        box.scroll_w = @max(out.w - box.border.horizontal(), tw + box.padding.horizontal());
        box.scroll_h = @max(out.h - box.border.vertical(), total_h + box.padding.vertical());
    }
    return out;
}

const Mode = enum { definite, min, max };

fn autoTrack(list: props.TrackList, i: usize) props.Track {
    if (list.tracks.len == 0) return .auto;
    return list.tracks[i % list.tracks.len];
}

fn resolveLine(gl: props.GridLine, explicit: i32, start: *u32, span: *u32) void {
    var s: ?i32 = null;
    var e: ?i32 = null;
    if (gl.start != 0) s = if (gl.start > 0) gl.start - 1 else explicit + 1 + gl.start;
    if (gl.end != 0) e = if (gl.end > 0) gl.end - 1 else explicit + 1 + gl.end;
    var sp: u32 = if (gl.span > 0) gl.span else 1;
    if (s != null and e != null) {
        var lo = s.?;
        var hi = e.?;
        if (hi < lo) std.mem.swap(i32, &lo, &hi);
        if (hi == lo) hi = lo + 1;
        start.* = @intCast(@max(0, lo));
        span.* = @intCast(hi - lo);
        return;
    }
    if (s) |v| {
        start.* = @intCast(@max(0, v));
        span.* = sp;
        return;
    }
    if (e) |v| {
        if (gl.span == 0) sp = 1;
        start.* = @intCast(@max(0, v - @as(i32, @intCast(sp))));
        span.* = sp;
        return;
    }
    start.* = std.math.maxInt(u32);
    span.* = sp;
}

const Occupancy = struct {
    a: std.mem.Allocator,
    cols: u32,
    cells: std.ArrayList(bool) = .empty,

    fn ensure(o: *Occupancy, rows: u32) !void {
        const need = rows * o.cols;
        while (o.cells.items.len < need) try o.cells.append(o.a, false);
    }
    fn free(o: *Occupancy, r: u32, c: u32, rs: u32, cs: u32) !bool {
        if (c + cs > o.cols) return false;
        try o.ensure(r + rs);
        for (r..r + rs) |rr| for (c..c + cs) |cc| {
            if (o.cells.items[rr * o.cols + cc]) return false;
        };
        return true;
    }
    fn mark(o: *Occupancy, r: u32, c: u32, rs: u32, cs: u32) !void {
        if (c + cs > o.cols) {
            // widen the grid: rebuild with more columns
            const new_cols = c + cs;
            var cells: std.ArrayList(bool) = .empty;
            const rows: u32 = if (o.cols > 0) @intCast(o.cells.items.len / o.cols) else 0;
            for (0..rows) |rr| {
                for (0..new_cols) |cc| try cells.append(o.a, if (cc < o.cols) o.cells.items[rr * o.cols + cc] else false);
            }
            o.cells = cells;
            o.cols = new_cols;
        }
        try o.ensure(r + rs);
        for (r..r + rs) |rr| for (c..c + cs) |cc| {
            o.cells.items[rr * o.cols + cc] = true;
        };
    }
};

fn sizeTracks(tracks: []Track, items: []GItem, is_col: bool, inner: ?f32, gap: f32, ctx: values.Ctx, mode: Mode, heights: []const f32) void {
    // 1. initialize base sizes / growth limits
    for (tracks) |*t| {
        t.fr = 0;
        t.base = 0;
        t.limit = std.math.inf(f32);
        const min_def: props.Track = switch (t.def) {
            .minmax => |mm| mm.min.*,
            else => t.def,
        };
        const max_def: props.Track = switch (t.def) {
            .minmax => |mm| mm.max.*,
            else => t.def,
        };
        if (resolveTrackSize(min_def, inner, ctx)) |v| t.base = v;
        if (resolveTrackSize(max_def, inner, ctx)) |v| t.limit = @max(v, t.base);
        if (max_def == .fr) t.fr = max_def.fr;
    }
    // 2. intrinsic contributions of single-span items
    for (items, 0..) |*g, gi| {
        const start = if (is_col) g.col else g.row;
        const span = if (is_col) g.col_span else g.row_span;
        if (start + span > tracks.len) continue;
        const min_c = if (is_col) g.min_w + g.margin.left + g.margin.right else heights[gi];
        const max_c = if (is_col) g.max_w + g.margin.left + g.margin.right else heights[gi];
        if (span == 1) {
            const t = &tracks[start];
            const min_def: props.Track = switch (t.def) {
                .minmax => |mm| mm.min.*,
                else => if (t.def == .fr) .auto else t.def,
            };
            const max_def: props.Track = switch (t.def) {
                .minmax => |mm| mm.max.*,
                else => t.def,
            };
            switch (min_def) {
                .auto, .min_content => t.base = @max(t.base, min_c),
                .max_content => t.base = @max(t.base, max_c),
                else => {},
            }
            switch (max_def) {
                .auto, .max_content => t.limit = if (std.math.isInf(t.limit)) max_c else @max(t.limit, max_c),
                .min_content => t.limit = if (std.math.isInf(t.limit)) min_c else @max(t.limit, min_c),
                else => {},
            }
        }
    }
    // spanning items: distribute any shortfall across spanned non-flexible tracks
    for (items, 0..) |*g, gi| {
        const start = if (is_col) g.col else g.row;
        const span = if (is_col) g.col_span else g.row_span;
        if (span <= 1 or start + span > tracks.len) continue;
        const need = if (is_col) g.min_w + g.margin.left + g.margin.right else heights[gi];
        var have: f32 = gap * @as(f32, @floatFromInt(span - 1));
        var n_flex: usize = 0;
        for (tracks[start .. start + span]) |t| {
            have += t.base;
            if (t.fr == 0 and t.def != .fixed) n_flex += 1;
        }
        if (need > have and n_flex > 0) {
            const add = (need - have) / @as(f32, @floatFromInt(n_flex));
            for (tracks[start .. start + span]) |*t| if (t.fr == 0 and t.def != .fixed) {
                t.base += add;
            };
        }
    }
    for (tracks) |*t| {
        if (std.math.isInf(t.limit) and t.fr == 0) t.limit = t.base;
        if (t.limit < t.base) t.limit = t.base;
        t.size = t.base;
    }
    const total_gap = gap * @as(f32, @floatFromInt(@max(1, tracks.len) - 1));
    // 3. maximize tracks: grow toward limits when space is available
    if (inner) |space| {
        var used: f32 = total_gap;
        for (tracks) |t| used += t.base;
        var free = space - used;
        if (free > 0) {
            var growable: f32 = 0;
            for (tracks) |t| if (t.fr == 0) {
                growable += t.limit - t.base;
            };
            if (growable > 0) {
                const f = @min(1, free / growable);
                for (tracks) |*t| if (t.fr == 0) {
                    t.size = t.base + (t.limit - t.base) * f;
                };
                free -= @min(free, growable);
            }
        }
        // 4. flexible tracks
        var fr_sum: f32 = 0;
        var non_flex: f32 = total_gap;
        for (tracks) |t| {
            if (t.fr > 0) fr_sum += t.fr else non_flex += t.size;
        }
        if (fr_sum > 0) {
            var leftover = @max(0, space - non_flex);
            var hyp = leftover / @max(1, fr_sum);
            // tracks whose base exceeds their fr share are treated as inflexible
            var iter: usize = 0;
            while (iter < tracks.len) : (iter += 1) {
                var changed = false;
                var sum2: f32 = 0;
                var left2 = leftover;
                for (tracks) |t| {
                    if (t.fr == 0) continue;
                    if (t.base > hyp * t.fr) {
                        left2 -= t.base;
                        changed = true;
                    } else sum2 += t.fr;
                }
                if (!changed or sum2 == 0) break;
                const new_hyp = @max(0, left2) / @max(1, sum2);
                if (new_hyp == hyp) break;
                hyp = new_hyp;
                leftover = leftover;
            }
            for (tracks) |*t| if (t.fr > 0) {
                t.size = @max(t.base, hyp * t.fr);
            };
        }
    } else {
        // indefinite: fr tracks sized to their max-content contribution per fr
        var fr_unit: f32 = 0;
        for (items, 0..) |*g, gi| {
            const start = if (is_col) g.col else g.row;
            const span = if (is_col) g.col_span else g.row_span;
            if (span != 1 or start >= tracks.len) continue;
            const t = tracks[start];
            if (t.fr > 0) {
                const c = if (is_col) (if (mode == .min) g.min_w else g.max_w) + g.margin.left + g.margin.right else heights[gi];
                fr_unit = @max(fr_unit, c / t.fr);
            }
        }
        for (tracks) |*t| {
            if (t.fr > 0) {
                t.size = @max(t.base, fr_unit * t.fr);
            } else if (mode == .max) {
                t.size = t.limit;
            } else {
                t.size = t.base;
            }
        }
    }
}

fn placeTracks(tracks: []Track, inner: f32, gap: f32, jc: props.Justify) void {
    var used: f32 = gap * @as(f32, @floatFromInt(@max(1, tracks.len) - 1));
    for (tracks) |t| used += t.size;
    if (tracks.len == 0) return;
    const free = inner - used;
    const n: f32 = @floatFromInt(tracks.len);
    var pos: f32 = 0;
    var between = gap;
    if (free > 0) switch (jc) {
        .center => pos = free / 2,
        .end, .flex_end, .right => pos = free,
        .space_between => if (tracks.len > 1) {
            between += free / (n - 1);
        },
        .space_around => {
            pos = free / n / 2;
            between += free / n;
        },
        .space_evenly => {
            pos = free / (n + 1);
            between += free / (n + 1);
        },
        .stretch => {
            // auto tracks stretch to fill
            var autos: f32 = 0;
            for (tracks) |t| if (t.def == .auto) {
                autos += 1;
            };
            if (autos > 0) for (tracks) |*t| if (t.def == .auto) {
                t.size += free / autos;
            };
        },
        else => {},
    };
    // `normal` content distribution stretches auto tracks too
    if (free > 0 and jc == .normal) {
        var autos: f32 = 0;
        for (tracks) |t| if (t.def == .auto) {
            autos += 1;
        };
        if (autos > 0) for (tracks) |*t| if (t.def == .auto) {
            t.size += free / autos;
        };
    }
    for (tracks) |*t| {
        t.pos = pos;
        pos += t.size + between;
    }
}

fn justifyOf(container: *const Style, item: *const Style) props.Justify {
    const j = if (item.justify_self == .normal) container.justify_items else item.justify_self;
    return switch (j) {
        .normal => if (item.aspect_ratio != null) .start else .stretch,
        .left, .flex_start => .start,
        .right, .flex_end => .end,
        else => j,
    };
}

fn alignOf(container: *const Style, item: *const Style) props.Align {
    const a = if (item.align_self == .auto) container.align_items else item.align_self;
    return switch (a) {
        .normal => .stretch,
        .flex_start, .self_start => .start,
        .flex_end, .self_end => .end,
        else => a,
    };
}

fn alignToJustify(a: props.Align) props.Justify {
    return switch (a) {
        .normal => .normal,
        .stretch => .stretch,
        .center => .center,
        .flex_start, .start, .self_start, .auto, .baseline => .start,
        .flex_end, .end, .self_end => .end,
        .space_between => .space_between,
        .space_around => .space_around,
        .space_evenly => .space_evenly,
    };
}
