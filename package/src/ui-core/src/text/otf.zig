//! OpenType / TrueType font parsing in pure Zig: table directory (incl. TTC
//! collections), metrics, names, character mapping, TrueType (glyf) and CFF
//! outlines, and the GSUB/GPOS lookups used for ligatures and kerning.
//!
//! Every read is bounds-checked: malformed fonts produce errors or empty
//! results, never out-of-bounds access.
const std = @import("std");
const path_mod = @import("../raster/path.zig");
const Allocator = std.mem.Allocator;
const Path = path_mod.Path;

pub const Error = error{Malformed} || Allocator.Error;

// ---------------------------------------------------------------------------
// Bounds-checked big-endian reads
// ---------------------------------------------------------------------------

fn u8At(d: []const u8, off: usize) error{Malformed}!u8 {
    if (off >= d.len) return error.Malformed;
    return d[off];
}
fn u16At(d: []const u8, off: usize) error{Malformed}!u16 {
    if (off > d.len or d.len - off < 2) return error.Malformed;
    return std.mem.readInt(u16, d[off..][0..2], .big);
}
fn i16At(d: []const u8, off: usize) error{Malformed}!i16 {
    return @bitCast(try u16At(d, off));
}
fn u32At(d: []const u8, off: usize) error{Malformed}!u32 {
    if (off > d.len or d.len - off < 4) return error.Malformed;
    return std.mem.readInt(u32, d[off..][0..4], .big);
}
fn sub(d: []const u8, off: usize, len: usize) error{Malformed}![]const u8 {
    if (off > d.len or d.len - off < len) return error.Malformed;
    return d[off..][0..len];
}
fn from(d: []const u8, off: usize) error{Malformed}![]const u8 {
    if (off > d.len) return error.Malformed;
    return d[off..];
}

pub fn tag(comptime s: *const [4]u8) u32 {
    return std.mem.readInt(u32, s, .big);
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

pub const Tables = struct {
    head: []const u8 = &.{},
    hhea: []const u8 = &.{},
    hmtx: []const u8 = &.{},
    maxp: []const u8 = &.{},
    cmap: []const u8 = &.{},
    os2: []const u8 = &.{},
    post: []const u8 = &.{},
    name: []const u8 = &.{},
    glyf: []const u8 = &.{},
    loca: []const u8 = &.{},
    cff: []const u8 = &.{},
    gsub: []const u8 = &.{},
    gpos: []const u8 = &.{},
    kern: []const u8 = &.{},
    colr: []const u8 = &.{},
    cpal: []const u8 = &.{},
    cbdt: []const u8 = &.{},
    cblc: []const u8 = &.{},
    sbix: []const u8 = &.{},
};

/// A lookup's subtables (Extension lookups resolved) and its real type.
pub const Lookup = struct { kind: u16, n: usize };

pub const VMetrics = struct {
    ascent: i32,
    descent: i32, // positive
    line_gap: i32,
    x_height: i32,
    cap_height: i32,
    underline_pos: i32, // positive = below baseline
    underline_thickness: i32,
};

/// Number of faces in a font file (1 unless it is a TrueType collection).
pub fn faceCount(data: []const u8) u32 {
    const t = u32At(data, 0) catch return 0;
    if (t == tag("ttcf")) return u32At(data, 8) catch 0;
    return 1;
}

pub const Font = struct {
    /// the whole file (table offsets are file-relative, also in collections)
    data: []const u8,
    tables: Tables,
    units_per_em: u16,
    num_glyphs: u16,
    num_hmetrics: u16,
    loca_long: bool,
    cmap_sub: []const u8 = &.{},
    cmap_format: u16 = 0,
    cff: ?Cff = null,

    pub fn parse(data: []const u8, index: u32) Error!Font {
        var off: usize = 0;
        if ((try u32At(data, 0)) == tag("ttcf")) {
            const n = try u32At(data, 8);
            if (index >= n) return error.Malformed;
            off = try u32At(data, 12 + 4 * @as(usize, index));
        } else if (index != 0) return error.Malformed;
        const version = try u32At(data, off);
        if (version != 0x00010000 and version != tag("OTTO") and version != tag("true")) return error.Malformed;
        const num_tables = try u16At(data, off + 4);
        var t: Tables = .{};
        for (0..num_tables) |i| {
            const rec = off + 12 + 16 * i;
            const tg = try u32At(data, rec);
            const toff = try u32At(data, rec + 8);
            const tlen = try u32At(data, rec + 12);
            const body = try sub(data, toff, tlen);
            switch (tg) {
                tag("head") => t.head = body,
                tag("hhea") => t.hhea = body,
                tag("hmtx") => t.hmtx = body,
                tag("maxp") => t.maxp = body,
                tag("cmap") => t.cmap = body,
                tag("OS/2") => t.os2 = body,
                tag("post") => t.post = body,
                tag("name") => t.name = body,
                tag("glyf") => t.glyf = body,
                tag("loca") => t.loca = body,
                tag("CFF ") => t.cff = body,
                tag("GSUB") => t.gsub = body,
                tag("GPOS") => t.gpos = body,
                tag("kern") => t.kern = body,
                tag("COLR") => t.colr = body,
                tag("CPAL") => t.cpal = body,
                tag("CBDT") => t.cbdt = body,
                tag("CBLC") => t.cblc = body,
                tag("sbix") => t.sbix = body,
                else => {},
            }
        }
        if (t.head.len < 54 or t.hhea.len < 36 or t.maxp.len < 6) return error.Malformed;
        var f = Font{
            .data = data,
            .tables = t,
            .units_per_em = try u16At(t.head, 18),
            .num_glyphs = try u16At(t.maxp, 4),
            .num_hmetrics = try u16At(t.hhea, 34),
            .loca_long = (try i16At(t.head, 50)) != 0,
        };
        if (f.units_per_em < 16 or f.units_per_em > 16384) return error.Malformed;
        f.pickCmap() catch {};
        if (t.cff.len > 0) f.cff = Cff.parse(t.cff) catch null;
        return f;
    }

    // ---- metrics ------------------------------------------------------------

    pub fn vmetrics(f: *const Font) VMetrics {
        var m = VMetrics{
            .ascent = i16At(f.tables.hhea, 4) catch 0,
            .descent = -(i16At(f.tables.hhea, 6) catch 0),
            .line_gap = i16At(f.tables.hhea, 8) catch 0,
            .x_height = 0,
            .cap_height = 0,
            .underline_pos = 0,
            .underline_thickness = @max(1, @divTrunc(f.units_per_em, 14)),
        };
        const os2 = f.tables.os2;
        if (os2.len >= 78) {
            const fs_selection = u16At(os2, 62) catch 0;
            // USE_TYPO_METRICS, or no usable hhea values
            if (fs_selection & (1 << 7) != 0 or (m.ascent == 0 and m.descent == 0)) {
                m.ascent = i16At(os2, 68) catch m.ascent;
                m.descent = -(i16At(os2, 70) catch -m.descent);
                m.line_gap = i16At(os2, 72) catch m.line_gap;
            }
            if (os2.len >= 90) {
                m.x_height = i16At(os2, 86) catch 0;
                m.cap_height = i16At(os2, 88) catch 0;
            }
        }
        if (m.x_height == 0) m.x_height = @divTrunc(@as(i32, f.units_per_em) * 1, 2);
        if (m.cap_height == 0) m.cap_height = @divTrunc(@as(i32, f.units_per_em) * 7, 10);
        if (f.tables.post.len >= 12) {
            m.underline_pos = -(i16At(f.tables.post, 8) catch 0);
            m.underline_thickness = @max(1, i16At(f.tables.post, 10) catch 1);
        }
        return m;
    }

    pub fn advance(f: *const Font, gid: u32) u16 {
        if (f.num_hmetrics == 0) return 0;
        const i = @min(gid, @as(u32, f.num_hmetrics) - 1);
        return u16At(f.tables.hmtx, 4 * @as(usize, i)) catch 0;
    }

    /// usWeightClass (100..900), 400 if unknown.
    pub fn weight(f: *const Font) u16 {
        const w = u16At(f.tables.os2, 4) catch return 400;
        return if (w >= 1 and w <= 1000) w else 400;
    }

    pub fn isItalic(f: *const Font) bool {
        const sel = u16At(f.tables.os2, 62) catch return (u16At(f.tables.head, 44) catch 0) & 2 != 0;
        return sel & 1 != 0 or sel & (1 << 9) != 0;
    }

    pub fn isMonospace(f: *const Font) bool {
        return (u32At(f.tables.post, 12) catch 0) != 0;
    }

    pub fn hasColor(f: *const Font) bool {
        return f.tables.colr.len > 0 or f.tables.cbdt.len > 0 or f.tables.sbix.len > 0;
    }

    // ---- names --------------------------------------------------------------

    /// Family name (typographic family preferred) decoded to UTF-8 into `buf`.
    pub fn familyName(f: *const Font, buf: []u8) ?[]const u8 {
        return f.nameString(16, buf) orelse f.nameString(1, buf);
    }

    pub fn subfamilyName(f: *const Font, buf: []u8) ?[]const u8 {
        return f.nameString(17, buf) orelse f.nameString(2, buf);
    }

    pub fn nameString(f: *const Font, name_id: u16, buf: []u8) ?[]const u8 {
        const n = f.tables.name;
        const count = u16At(n, 2) catch return null;
        const storage = u16At(n, 4) catch return null;
        var best: ?struct { off: usize, len: usize, utf16: bool, score: u8 } = null;
        for (0..count) |i| {
            const rec = 6 + 12 * i;
            const platform = u16At(n, rec) catch break;
            const encoding = u16At(n, rec + 2) catch break;
            const lang = u16At(n, rec + 4) catch break;
            const id = u16At(n, rec + 6) catch break;
            if (id != name_id) continue;
            const len = u16At(n, rec + 8) catch break;
            const off = u16At(n, rec + 10) catch break;
            // prefer Windows English (US), then any Unicode, then Mac Roman
            const score: u8 = if (platform == 3 and (encoding == 1 or encoding == 10) and lang == 0x409) 3 else if (platform == 3 or platform == 0) 2 else if (platform == 1 and encoding == 0) 1 else 0;
            if (score == 0) continue;
            if (best == null or score > best.?.score) best = .{ .off = @as(usize, storage) + off, .len = len, .utf16 = platform != 1, .score = score };
        }
        const b = best orelse return null;
        const raw = sub(n, b.off, b.len) catch return null;
        if (!b.utf16) {
            const m = @min(raw.len, buf.len);
            for (raw[0..m], 0..) |c, i| buf[i] = if (c < 0x80) c else '?';
            return buf[0..m];
        }
        var o: usize = 0;
        var i: usize = 0;
        while (i + 1 < raw.len) : (i += 2) {
            var cp: u21 = std.mem.readInt(u16, raw[i..][0..2], .big);
            if (cp >= 0xD800 and cp < 0xDC00 and i + 3 < raw.len) {
                const lo = std.mem.readInt(u16, raw[i + 2 ..][0..2], .big);
                if (lo >= 0xDC00 and lo < 0xE000) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    i += 2;
                }
            }
            if (cp >= 0xD800 and cp < 0xE000) cp = 0xFFFD;
            var tmp: [4]u8 = undefined;
            const l = std.unicode.utf8Encode(cp, &tmp) catch continue;
            if (o + l > buf.len) break;
            @memcpy(buf[o..][0..l], tmp[0..l]);
            o += l;
        }
        return buf[0..o];
    }

    // ---- cmap ---------------------------------------------------------------

    fn pickCmap(f: *Font) !void {
        const c = f.tables.cmap;
        const n = try u16At(c, 2);
        var best: u8 = 0;
        for (0..n) |i| {
            const rec = 4 + 8 * i;
            const platform = try u16At(c, rec);
            const encoding = try u16At(c, rec + 2);
            const off = try u32At(c, rec + 4);
            const body = try from(c, off);
            const format = try u16At(body, 0);
            const score: u8 = switch (format) {
                12 => if ((platform == 3 and encoding == 10) or platform == 0) 4 else 0,
                4 => if ((platform == 3 and encoding == 1) or platform == 0) 3 else 0,
                6 => if (platform == 3 or platform == 0) 2 else 0,
                0 => if (platform == 1 or platform == 3 or platform == 0) 1 else 0,
                else => 0,
            };
            // symbol fonts (3,0) map U+F0xx; accept as a last resort
            const sym: u8 = if (platform == 3 and encoding == 0 and format == 4) 1 else 0;
            const s = @max(score, sym);
            if (s > best) {
                best = s;
                f.cmap_sub = body;
                f.cmap_format = format;
            }
        }
    }

    /// Glyph id for a code point (0 = .notdef / missing).
    pub fn glyphIndex(f: *const Font, cp: u21) u32 {
        return f.lookupCmap(cp) catch 0;
    }

    fn lookupCmap(f: *const Font, cp: u21) error{Malformed}!u32 {
        const s = f.cmap_sub;
        switch (f.cmap_format) {
            0 => return if (cp < 256) try u8At(s, 6 + cp) else 0,
            6 => {
                const first = try u16At(s, 6);
                const count = try u16At(s, 8);
                if (cp < first or cp >= @as(u32, first) + count) return 0;
                return try u16At(s, 10 + 2 * (cp - first));
            },
            4 => {
                if (cp > 0xFFFF) return 0;
                const segx2 = try u16At(s, 6);
                const segs = segx2 / 2;
                // binary search on endCode
                var lo: usize = 0;
                var hi: usize = segs;
                while (lo < hi) {
                    const mid = (lo + hi) / 2;
                    const end = try u16At(s, 14 + 2 * mid);
                    if (end < cp) lo = mid + 1 else hi = mid;
                }
                if (lo >= segs) return 0;
                const end_off = 14 + 2 * lo;
                const start_off = end_off + segx2 + 2;
                const delta_off = start_off + segx2;
                const range_off = delta_off + segx2;
                const start = try u16At(s, start_off);
                if (cp < start) return 0;
                const delta = try u16At(s, delta_off);
                const range = try u16At(s, range_off);
                if (range == 0) return @as(u16, @truncate(cp +% delta));
                const g = try u16At(s, range_off + range + 2 * (cp - start));
                return if (g == 0) 0 else @as(u16, g +% delta);
            },
            12 => {
                const n = try u32At(s, 12);
                var lo: usize = 0;
                var hi: usize = n;
                while (lo < hi) {
                    const mid = (lo + hi) / 2;
                    const rec = 16 + 12 * mid;
                    const start = try u32At(s, rec);
                    const end = try u32At(s, rec + 4);
                    if (cp < start) {
                        hi = mid;
                    } else if (cp > end) {
                        lo = mid + 1;
                    } else return (try u32At(s, rec + 8)) + (cp - start);
                }
                return 0;
            },
            else => return 0,
        }
    }

    // ---- outlines -----------------------------------------------------------

    /// Append the glyph's outline to `path` in font units (y up).
    pub fn outline(f: *const Font, gpa: Allocator, gid: u32, path: *Path) Error!void {
        if (gid >= f.num_glyphs) return;
        if (f.cff) |*c| return c.outline(gpa, gid, path);
        if (f.tables.glyf.len > 0) return f.glyfOutline(gpa, gid, path, .identity, 0);
    }

    fn glyphRange(f: *const Font, gid: u32) error{Malformed}![]const u8 {
        const l = f.tables.loca;
        var start: usize = undefined;
        var end: usize = undefined;
        if (f.loca_long) {
            start = try u32At(l, 4 * gid);
            end = try u32At(l, 4 * gid + 4);
        } else {
            start = @as(usize, try u16At(l, 2 * gid)) * 2;
            end = @as(usize, try u16At(l, 2 * gid + 2)) * 2;
        }
        if (end <= start) return &.{};
        return sub(f.tables.glyf, start, end - start);
    }

    fn glyfOutline(f: *const Font, gpa: Allocator, gid: u32, path: *Path, t: path_mod.Affine, depth: u8) Error!void {
        if (depth > 8) return error.Malformed;
        const g = try f.glyphRange(gid);
        if (g.len < 10) return;
        const ncont = try i16At(g, 0);
        if (ncont >= 0) return simpleGlyph(gpa, g, @intCast(ncont), path, t);
        // composite
        var off: usize = 10;
        while (true) {
            const flags = try u16At(g, off);
            const cgid = try u16At(g, off + 2);
            off += 4;
            var dx: f32 = 0;
            var dy: f32 = 0;
            if (flags & 1 != 0) { // ARG_1_AND_2_ARE_WORDS
                dx = @floatFromInt(try i16At(g, off));
                dy = @floatFromInt(try i16At(g, off + 2));
                off += 4;
            } else {
                dx = @floatFromInt(@as(i8, @bitCast(try u8At(g, off))));
                dy = @floatFromInt(@as(i8, @bitCast(try u8At(g, off + 1))));
                off += 2;
            }
            if (flags & 2 == 0) { // point matching: unsupported, ignore offset
                dx = 0;
                dy = 0;
            }
            var m = path_mod.Affine{ .e = dx, .f = dy };
            if (flags & 0x8 != 0) { // WE_HAVE_A_SCALE
                const s = f2dot14(try i16At(g, off));
                m.a = s;
                m.d = s;
                off += 2;
            } else if (flags & 0x40 != 0) { // X_AND_Y_SCALE
                m.a = f2dot14(try i16At(g, off));
                m.d = f2dot14(try i16At(g, off + 2));
                off += 4;
            } else if (flags & 0x80 != 0) { // TWO_BY_TWO
                m.a = f2dot14(try i16At(g, off));
                m.b = f2dot14(try i16At(g, off + 2));
                m.c = f2dot14(try i16At(g, off + 4));
                m.d = f2dot14(try i16At(g, off + 6));
                off += 8;
            }
            try f.glyfOutline(gpa, cgid, path, m.then(t), depth + 1);
            if (flags & 0x20 == 0) break; // MORE_COMPONENTS
        }
    }

    // ---- layout features ----------------------------------------------------

    /// Lookup indices for `feature` in a GSUB/GPOS table, using the DFLT or
    /// latn script's default language system (else the first script).
    pub fn featureLookups(table: []const u8, feature: u32, out: []u16) usize {
        return featureLookupsImpl(table, feature, out) catch 0;
    }

    fn featureLookupsImpl(table: []const u8, feature: u32, out: []u16) error{Malformed}!usize {
        if (table.len < 10) return 0;
        const script_list = try from(table, try u16At(table, 4));
        const feature_list = try from(table, try u16At(table, 6));
        const nscripts = try u16At(script_list, 0);
        var chosen: ?[]const u8 = null;
        for (0..nscripts) |i| {
            const st = try u32At(script_list, 2 + 6 * i);
            const s = try from(script_list, try u16At(script_list, 2 + 6 * i + 4));
            if (st == tag("DFLT") or st == tag("latn")) {
                chosen = s;
                if (st == tag("DFLT")) break;
            } else if (chosen == null and i == 0) chosen = s;
        }
        const script = chosen orelse return 0;
        const dls_off = try u16At(script, 0);
        if (dls_off == 0) return 0;
        const ls = try from(script, dls_off);
        const nfi = try u16At(ls, 4);
        var n: usize = 0;
        for (0..nfi) |i| {
            const fi = try u16At(ls, 6 + 2 * i);
            const rec = 2 + 6 * @as(usize, fi);
            if ((try u32At(feature_list, rec)) != feature) continue;
            const feat = try from(feature_list, try u16At(feature_list, rec + 4));
            const nl = try u16At(feat, 2);
            for (0..nl) |k| {
                if (n >= out.len) return n;
                out[n] = try u16At(feat, 4 + 2 * k);
                n += 1;
            }
        }
        std.mem.sort(u16, out[0..n], {}, std.sort.asc(u16));
        return n;
    }

    /// The subtables of lookup `index` (resolving Extension lookups) and their real type.
    pub fn lookup(table: []const u8, index: u16, ext_type: u16, out: [][]const u8) Lookup {
        return lookupImpl(table, index, ext_type, out) catch .{ .kind = 0, .n = 0 };
    }

    fn lookupImpl(table: []const u8, index: u16, ext_type: u16, out: [][]const u8) error{Malformed}!Lookup {
        const ll = try from(table, try u16At(table, 8));
        if (index >= try u16At(ll, 0)) return .{ .kind = 0, .n = 0 };
        const l = try from(ll, try u16At(ll, 2 + 2 * @as(usize, index)));
        var kind = try u16At(l, 0);
        const nsub = try u16At(l, 4);
        var n: usize = 0;
        for (0..nsub) |i| {
            if (n >= out.len) break;
            var st = try from(l, try u16At(l, 6 + 2 * i));
            if (kind == ext_type) {
                kind = try u16At(st, 2);
                st = try from(st, try u32At(st, 4));
            }
            out[n] = st;
            n += 1;
        }
        return .{ .kind = kind, .n = n };
    }
};

fn f2dot14(v: i16) f32 {
    return @as(f32, @floatFromInt(v)) / 16384.0;
}

fn simpleGlyph(gpa: Allocator, g: []const u8, ncont: usize, path: *Path, t: path_mod.Affine) Error!void {
    if (ncont == 0) return;
    const ends_off: usize = 10;
    const npts = @as(usize, try u16At(g, ends_off + 2 * (ncont - 1))) + 1;
    if (npts > 65535) return error.Malformed;
    const ilen = try u16At(g, ends_off + 2 * ncont);
    var off = ends_off + 2 * ncont + 2 + ilen;
    const flags = try gpa.alloc(u8, npts);
    defer gpa.free(flags);
    const xs = try gpa.alloc(f32, npts);
    defer gpa.free(xs);
    const ys = try gpa.alloc(f32, npts);
    defer gpa.free(ys);
    // flags (with repeats)
    var i: usize = 0;
    while (i < npts) {
        const fl = try u8At(g, off);
        off += 1;
        flags[i] = fl;
        i += 1;
        if (fl & 8 != 0) {
            var rep = try u8At(g, off);
            off += 1;
            while (rep > 0 and i < npts) : (rep -= 1) {
                flags[i] = fl;
                i += 1;
            }
        }
    }
    // coordinates
    var v: i32 = 0;
    for (0..npts) |k| {
        const fl = flags[k];
        if (fl & 2 != 0) {
            const d: i32 = try u8At(g, off);
            off += 1;
            v += if (fl & 16 != 0) d else -d;
        } else if (fl & 16 == 0) {
            v += try i16At(g, off);
            off += 2;
        }
        xs[k] = @floatFromInt(v);
    }
    v = 0;
    for (0..npts) |k| {
        const fl = flags[k];
        if (fl & 4 != 0) {
            const d: i32 = try u8At(g, off);
            off += 1;
            v += if (fl & 32 != 0) d else -d;
        } else if (fl & 32 == 0) {
            v += try i16At(g, off);
            off += 2;
        }
        ys[k] = @floatFromInt(v);
    }
    // contours: quadratic B-splines with implied on-curve midpoints
    var start: usize = 0;
    for (0..ncont) |c| {
        const end = @as(usize, try u16At(g, ends_off + 2 * c));
        if (end < start or end >= npts) return error.Malformed;
        try contour(gpa, path, t, flags[start .. end + 1], xs[start .. end + 1], ys[start .. end + 1]);
        start = end + 1;
    }
}

fn contour(gpa: Allocator, path: *Path, t: path_mod.Affine, fl: []const u8, xs: []const f32, ys: []const f32) Allocator.Error!void {
    const n = fl.len;
    if (n == 0) return;
    const P = path_mod.Point;
    const pt = struct {
        fn at(xs_: []const f32, ys_: []const f32, tt: path_mod.Affine, k: usize) P {
            return tt.apply(.{ .x = xs_[k], .y = ys_[k] });
        }
    }.at;
    const on = struct {
        fn f(fl_: []const u8, k: usize) bool {
            return fl_[k] & 1 != 0;
        }
    }.f;
    // starting point: first on-curve point, or the midpoint of the first two off-curve points
    var first: usize = 0;
    var start_pt: P = undefined;
    if (on(fl, 0)) {
        start_pt = pt(xs, ys, t, 0);
    } else if (on(fl, n - 1)) {
        start_pt = pt(xs, ys, t, n - 1);
        first = n - 1;
    } else {
        start_pt = P.lerp(pt(xs, ys, t, 0), pt(xs, ys, t, n - 1), 0.5);
        first = n - 1;
    }
    try path.moveTo(gpa, start_pt.x, start_pt.y);
    var ctrl: ?P = null;
    var k: usize = 0;
    while (k < n) : (k += 1) {
        const idx = (first + 1 + k) % n;
        const p = pt(xs, ys, t, idx);
        if (on(fl, idx)) {
            if (ctrl) |c| try path.quadTo(gpa, c.x, c.y, p.x, p.y) else try path.lineTo(gpa, p.x, p.y);
            ctrl = null;
        } else {
            if (ctrl) |c| {
                const mid = P.lerp(c, p, 0.5);
                try path.quadTo(gpa, c.x, c.y, mid.x, mid.y);
            }
            ctrl = p;
        }
    }
    if (ctrl) |c| try path.quadTo(gpa, c.x, c.y, start_pt.x, start_pt.y);
    try path.close(gpa);
}

// ---------------------------------------------------------------------------
// CFF (Compact Font Format, Type 2 charstrings)
// ---------------------------------------------------------------------------

const Index = struct {
    data: []const u8,
    count: u32,
    off_size: u8,
    /// byte offset of the object data (just before the first object)
    base: usize,
    /// total encoded length of the INDEX
    len: usize,

    fn parse(d: []const u8, off: usize) error{Malformed}!Index {
        const count = try u16At(d, off);
        if (count == 0) return .{ .data = d, .count = 0, .off_size = 1, .base = off + 2, .len = 2 };
        const os = try u8At(d, off + 2);
        if (os < 1 or os > 4) return error.Malformed;
        const offsets = off + 3;
        const base = offsets + (@as(usize, count) + 1) * os - 1;
        var idx = Index{ .data = d, .count = count, .off_size = os, .base = base, .len = 0 };
        const last = try idx.offsetAt(count);
        idx.len = base + last - off;
        if (base + last > d.len) return error.Malformed;
        return idx;
    }

    fn offsetAt(idx: *const Index, i: usize) error{Malformed}!usize {
        const p = idx.base + 1 - (@as(usize, idx.count) + 1) * idx.off_size + i * idx.off_size;
        var v: usize = 0;
        for (0..idx.off_size) |k| v = (v << 8) | try u8At(idx.data, p + k);
        return v;
    }

    fn get(idx: *const Index, i: usize) error{Malformed}![]const u8 {
        if (i >= idx.count) return error.Malformed;
        const a = try idx.offsetAt(i);
        const b = try idx.offsetAt(i + 1);
        if (b < a) return error.Malformed;
        return sub(idx.data, idx.base + a, b - a);
    }
};

/// A parsed DICT: operator → operands (only what we need).
const Dict = struct {
    charstrings: usize = 0,
    private_size: usize = 0,
    private_off: usize = 0,
    subrs: usize = 0,
    fd_array: usize = 0,
    fd_select: usize = 0,
    is_cid: bool = false,

    fn parse(d: []const u8) error{Malformed}!Dict {
        var out: Dict = .{};
        var stack: [48]f64 = undefined;
        var sp: usize = 0;
        var i: usize = 0;
        while (i < d.len) {
            const b0 = d[i];
            if (b0 <= 21) {
                var op: u16 = b0;
                i += 1;
                if (b0 == 12) {
                    op = 1200 + @as(u16, try u8At(d, i));
                    i += 1;
                }
                const a0: usize = if (sp > 0) @intFromFloat(@max(0, stack[0])) else 0;
                const a1: usize = if (sp > 1) @intFromFloat(@max(0, stack[1])) else 0;
                switch (op) {
                    17 => out.charstrings = a0,
                    18 => {
                        out.private_size = a0;
                        out.private_off = a1;
                    },
                    19 => out.subrs = a0,
                    1230 => out.is_cid = true,
                    1236 => out.fd_array = a0,
                    1237 => out.fd_select = a0,
                    else => {},
                }
                sp = 0;
                continue;
            }
            // operand
            var v: f64 = 0;
            if (b0 == 28) {
                v = @floatFromInt(try i16At(d, i + 1));
                i += 3;
            } else if (b0 == 29) {
                v = @floatFromInt(@as(i32, @bitCast(try u32At(d, i + 1))));
                i += 5;
            } else if (b0 == 30) { // real: skip nibbles
                i += 1;
                while (i < d.len) : (i += 1) {
                    const b = d[i];
                    if (b & 0xF == 0xF or b >> 4 == 0xF) {
                        i += 1;
                        break;
                    }
                }
            } else if (b0 >= 32 and b0 <= 246) {
                v = @as(f64, @floatFromInt(b0)) - 139;
                i += 1;
            } else if (b0 >= 247 and b0 <= 250) {
                v = @as(f64, @floatFromInt((@as(i32, b0) - 247) * 256 + @as(i32, try u8At(d, i + 1)) + 108));
                i += 2;
            } else if (b0 >= 251 and b0 <= 254) {
                v = @as(f64, @floatFromInt(-(@as(i32, b0) - 251) * 256 - @as(i32, try u8At(d, i + 1)) - 108));
                i += 2;
            } else {
                i += 1;
                continue;
            }
            if (sp < stack.len) {
                stack[sp] = v;
                sp += 1;
            }
        }
        return out;
    }
};

const Cff = struct {
    data: []const u8,
    charstrings: Index,
    gsubrs: Index,
    /// local subrs: one per font dict (CID fonts) or a single entry
    lsubrs: [32]?Index = @splat(null),
    fd_select: []const u8 = &.{},
    is_cid: bool = false,

    fn parse(d: []const u8) error{Malformed}!Cff {
        const hdr_size = try u8At(d, 2);
        const names = try Index.parse(d, hdr_size);
        const top = try Index.parse(d, hdr_size + names.len);
        const strings = try Index.parse(d, hdr_size + names.len + top.len);
        const gsubrs = try Index.parse(d, hdr_size + names.len + top.len + strings.len);
        const top_dict = try Dict.parse(try top.get(0));
        if (top_dict.charstrings == 0) return error.Malformed;
        var c = Cff{
            .data = d,
            .charstrings = try Index.parse(d, top_dict.charstrings),
            .gsubrs = gsubrs,
            .is_cid = top_dict.is_cid,
        };
        if (top_dict.is_cid and top_dict.fd_array != 0) {
            const fds = try Index.parse(d, top_dict.fd_array);
            for (0..@min(fds.count, c.lsubrs.len)) |i| {
                const fd = try Dict.parse(try fds.get(i));
                c.lsubrs[i] = privateSubrs(d, fd);
            }
            if (top_dict.fd_select != 0) c.fd_select = try from(d, top_dict.fd_select);
        } else {
            c.lsubrs[0] = privateSubrs(d, top_dict);
        }
        return c;
    }

    fn privateSubrs(d: []const u8, dict: Dict) ?Index {
        if (dict.private_size == 0) return null;
        const pd = sub(d, dict.private_off, dict.private_size) catch return null;
        const priv = Dict.parse(pd) catch return null;
        if (priv.subrs == 0) return null;
        return Index.parse(d, dict.private_off + priv.subrs) catch null;
    }

    fn fdIndex(c: *const Cff, gid: u32) usize {
        if (!c.is_cid or c.fd_select.len == 0) return 0;
        const s = c.fd_select;
        const format = u8At(s, 0) catch return 0;
        if (format == 0) return u8At(s, 1 + gid) catch 0;
        if (format == 3) {
            const n = u16At(s, 1) catch return 0;
            var i: usize = 0;
            while (i < n) : (i += 1) {
                const first = u16At(s, 3 + 3 * i) catch return 0;
                const next = u16At(s, 3 + 3 * (i + 1)) catch return 0;
                if (gid >= first and gid < next) return u8At(s, 3 + 3 * i + 2) catch 0;
            }
        }
        return 0;
    }

    fn outline(c: *const Cff, gpa: Allocator, gid: u32, path: *Path) Error!void {
        const cs = try c.charstrings.get(gid);
        const fd = c.fdIndex(gid);
        var interp = Charstring{ .gpa = gpa, .path = path, .gsubrs = c.gsubrs, .lsubrs = if (fd < c.lsubrs.len) c.lsubrs[fd] else null };
        try interp.run(cs, 0);
        if (interp.open) try path.close(gpa);
    }
};

fn subrBias(n: u32) i32 {
    return if (n < 1240) 107 else if (n < 33900) 1131 else 32768;
}

const Charstring = struct {
    gpa: Allocator,
    path: *Path,
    gsubrs: Index,
    lsubrs: ?Index,
    stack: [48]f32 = undefined,
    sp: usize = 0,
    x: f32 = 0,
    y: f32 = 0,
    nstems: usize = 0,
    width_done: bool = false,
    open: bool = false,
    done: bool = false,

    fn push(s: *Charstring, v: f32) void {
        if (s.sp < s.stack.len) {
            s.stack[s.sp] = v;
            s.sp += 1;
        }
    }

    fn moveTo(s: *Charstring, dx: f32, dy: f32) Error!void {
        if (s.open) try s.path.close(s.gpa);
        s.x += dx;
        s.y += dy;
        try s.path.moveTo(s.gpa, s.x, s.y);
        s.open = true;
    }

    fn lineTo(s: *Charstring, dx: f32, dy: f32) Error!void {
        s.x += dx;
        s.y += dy;
        try s.path.lineTo(s.gpa, s.x, s.y);
    }

    fn curveTo(s: *Charstring, dx1: f32, dy1: f32, dx2: f32, dy2: f32, dx3: f32, dy3: f32) Error!void {
        const x1 = s.x + dx1;
        const y1 = s.y + dy1;
        const x2 = x1 + dx2;
        const y2 = y1 + dy2;
        s.x = x2 + dx3;
        s.y = y2 + dy3;
        try s.path.cubicTo(s.gpa, x1, y1, x2, y2, s.x, s.y);
    }

    /// Strip the optional leading width argument (first stack-clearing op).
    fn width(s: *Charstring, expected: usize) void {
        if (s.width_done) return;
        s.width_done = true;
        if (s.sp > expected) {
            std.mem.copyForwards(f32, s.stack[0 .. s.sp - 1], s.stack[1..s.sp]);
            s.sp -= 1;
        }
    }

    fn run(s: *Charstring, code: []const u8, depth: u8) Error!void {
        if (depth > 10) return error.Malformed;
        var i: usize = 0;
        while (i < code.len and !s.done) {
            const b0 = code[i];
            if (b0 >= 32 or b0 == 28) {
                if (b0 == 28) {
                    s.push(@floatFromInt(try i16At(code, i + 1)));
                    i += 3;
                } else if (b0 <= 246) {
                    s.push(@as(f32, @floatFromInt(b0)) - 139);
                    i += 1;
                } else if (b0 <= 250) {
                    s.push(@floatFromInt((@as(i32, b0) - 247) * 256 + @as(i32, try u8At(code, i + 1)) + 108));
                    i += 2;
                } else if (b0 <= 254) {
                    s.push(@floatFromInt(-(@as(i32, b0) - 251) * 256 - @as(i32, try u8At(code, i + 1)) - 108));
                    i += 2;
                } else {
                    const v: i32 = @bitCast(try u32At(code, i + 1));
                    s.push(@as(f32, @floatFromInt(v)) / 65536.0);
                    i += 5;
                }
                continue;
            }
            i += 1;
            const st = s.stack[0..s.sp];
            switch (b0) {
                1, 3, 18, 23 => { // hstem vstem hstemhm vstemhm
                    s.width(st.len - st.len % 2);
                    s.nstems += s.sp / 2;
                    s.sp = 0;
                },
                19, 20 => { // hintmask cntrmask
                    s.width(s.sp - s.sp % 2);
                    s.nstems += s.sp / 2;
                    s.sp = 0;
                    i += (s.nstems + 7) / 8;
                },
                21 => { // rmoveto
                    s.width(2);
                    if (s.sp >= 2) try s.moveTo(s.stack[s.sp - 2], s.stack[s.sp - 1]);
                    s.sp = 0;
                },
                22 => { // hmoveto
                    s.width(1);
                    if (s.sp >= 1) try s.moveTo(s.stack[s.sp - 1], 0);
                    s.sp = 0;
                },
                4 => { // vmoveto
                    s.width(1);
                    if (s.sp >= 1) try s.moveTo(0, s.stack[s.sp - 1]);
                    s.sp = 0;
                },
                5 => { // rlineto
                    var k: usize = 0;
                    while (k + 1 < st.len) : (k += 2) try s.lineTo(st[k], st[k + 1]);
                    s.sp = 0;
                },
                6, 7 => { // hlineto vlineto: alternate
                    var horiz = b0 == 6;
                    for (st) |v| {
                        if (horiz) try s.lineTo(v, 0) else try s.lineTo(0, v);
                        horiz = !horiz;
                    }
                    s.sp = 0;
                },
                8 => { // rrcurveto
                    var k: usize = 0;
                    while (k + 5 < st.len) : (k += 6) try s.curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
                    s.sp = 0;
                },
                24 => { // rcurveline
                    var k: usize = 0;
                    while (k + 7 < st.len) : (k += 6) try s.curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
                    if (k + 1 < st.len) try s.lineTo(st[k], st[k + 1]);
                    s.sp = 0;
                },
                25 => { // rlinecurve
                    var k: usize = 0;
                    while (k + 7 < st.len) : (k += 2) try s.lineTo(st[k], st[k + 1]);
                    if (k + 5 < st.len) try s.curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
                    s.sp = 0;
                },
                26 => { // vvcurveto
                    var k: usize = 0;
                    var dx1: f32 = 0;
                    if (st.len % 4 == 1) {
                        dx1 = st[0];
                        k = 1;
                    }
                    while (k + 3 < st.len) : (k += 4) {
                        try s.curveTo(dx1, st[k], st[k + 1], st[k + 2], 0, st[k + 3]);
                        dx1 = 0;
                    }
                    s.sp = 0;
                },
                27 => { // hhcurveto
                    var k: usize = 0;
                    var dy1: f32 = 0;
                    if (st.len % 4 == 1) {
                        dy1 = st[0];
                        k = 1;
                    }
                    while (k + 3 < st.len) : (k += 4) {
                        try s.curveTo(st[k], dy1, st[k + 1], st[k + 2], st[k + 3], 0);
                        dy1 = 0;
                    }
                    s.sp = 0;
                },
                30, 31 => { // vhcurveto hvcurveto: alternating
                    var horiz = b0 == 31;
                    var k: usize = 0;
                    while (k + 3 < st.len) : (k += 4) {
                        const last = k + 4 == st.len - 1;
                        const extra: f32 = if (last) st[k + 4] else 0;
                        if (horiz) {
                            try s.curveTo(st[k], 0, st[k + 1], st[k + 2], extra, st[k + 3]);
                        } else {
                            try s.curveTo(0, st[k], st[k + 1], st[k + 2], st[k + 3], extra);
                        }
                        horiz = !horiz;
                    }
                    s.sp = 0;
                },
                10, 29 => { // callsubr callgsubr
                    if (s.sp == 0) return error.Malformed;
                    s.sp -= 1;
                    const idx = if (b0 == 10) (s.lsubrs orelse return error.Malformed) else s.gsubrs;
                    const n: i32 = @as(i32, @intFromFloat(s.stack[s.sp])) + subrBias(idx.count);
                    if (n < 0) return error.Malformed;
                    try s.run(try idx.get(@intCast(n)), depth + 1);
                },
                11 => return, // return
                14 => { // endchar
                    s.width(0);
                    if (s.open) {
                        try s.path.close(s.gpa);
                        s.open = false;
                    }
                    s.done = true;
                    s.sp = 0;
                },
                12 => {
                    const op = try u8At(code, i);
                    i += 1;
                    switch (op) {
                        35 => { // flex
                            if (st.len >= 12) {
                                try s.curveTo(st[0], st[1], st[2], st[3], st[4], st[5]);
                                try s.curveTo(st[6], st[7], st[8], st[9], st[10], st[11]);
                            }
                        },
                        34 => { // hflex: dx1 dx2 dy2 dx3 dx4 dx5 dx6
                            if (st.len >= 7) {
                                try s.curveTo(st[0], 0, st[1], st[2], st[3], 0);
                                try s.curveTo(st[4], 0, st[5], -st[2], st[6], 0);
                            }
                        },
                        36 => { // hflex1: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6
                            if (st.len >= 9) {
                                try s.curveTo(st[0], st[1], st[2], st[3], st[4], 0);
                                try s.curveTo(st[5], 0, st[6], st[7], st[8], -(st[1] + st[3] + st[7]));
                            }
                        },
                        37 => { // flex1: five delta pairs, then d6 along the dominant axis
                            if (st.len >= 11) {
                                var dx: f32 = 0;
                                var dy: f32 = 0;
                                var k: usize = 0;
                                while (k < 10) : (k += 2) {
                                    dx += st[k];
                                    dy += st[k + 1];
                                }
                                try s.curveTo(st[0], st[1], st[2], st[3], st[4], st[5]);
                                if (@abs(dx) > @abs(dy)) {
                                    try s.curveTo(st[6], st[7], st[8], st[9], st[10], -dy);
                                } else {
                                    try s.curveTo(st[6], st[7], st[8], st[9], -dx, st[10]);
                                }
                            }
                        },
                        else => {}, // arithmetic/storage ops are not used by real fonts
                    }
                    s.sp = 0;
                },
                else => s.sp = 0,
            }
        }
    }
};

// ---------------------------------------------------------------------------
// Color fonts: COLR v0 layers + CPAL palettes
// ---------------------------------------------------------------------------

pub const ColorLayer = struct {
    glyph: u16,
    /// CPAL palette entry, or 0xFFFF for the text (foreground) color
    palette_index: u16,
};

/// COLR v0 layers of a base glyph (bottom to top); 0 if it has none.
pub fn colrLayers(colr: []const u8, gid: u32, out: []ColorLayer) usize {
    return colrImpl(colr, gid, out) catch 0;
}

fn colrImpl(c: []const u8, gid: u32, out: []ColorLayer) error{Malformed}!usize {
    if (c.len < 14) return 0;
    const nbase = try u16At(c, 2);
    const base_off = try u32At(c, 4);
    const layer_off = try u32At(c, 8);
    const nlayers = try u16At(c, 12);
    var lo: usize = 0;
    var hi: usize = nbase;
    while (lo < hi) {
        const mid = (lo + hi) / 2;
        const rec = base_off + 6 * mid;
        const g = try u16At(c, rec);
        if (g < gid) lo = mid + 1 else if (g > gid) hi = mid else {
            const first = try u16At(c, rec + 2);
            const n = try u16At(c, rec + 4);
            if (@as(usize, first) + n > nlayers) return error.Malformed;
            const m = @min(n, out.len);
            for (0..m) |i| {
                const l = layer_off + 4 * (@as(usize, first) + i);
                out[i] = .{ .glyph = try u16At(c, l), .palette_index = try u16At(c, l + 2) };
            }
            return m;
        }
    }
    return 0;
}

/// Color of a CPAL entry in palette 0 as straight RGBA, or null.
pub fn paletteColor(cpal: []const u8, index: u16) ?[4]u8 {
    return paletteImpl(cpal, index) catch null;
}

fn paletteImpl(p: []const u8, index: u16) error{Malformed}!?[4]u8 {
    const nentries = try u16At(p, 2);
    if (index >= nentries) return null;
    const records = try u32At(p, 8);
    const first = try u16At(p, 12); // palette 0's first record
    const rec = records + 4 * (@as(usize, first) + index);
    const bgra = try sub(p, rec, 4);
    return .{ bgra[2], bgra[1], bgra[0], bgra[3] };
}

// ---------------------------------------------------------------------------
// Color bitmap fonts: CBDT/CBLC (Noto Color Emoji) and sbix (Apple)
// ---------------------------------------------------------------------------

pub const BitmapGlyph = struct {
    png: []const u8,
    /// pixels per em of the strike the bitmap was drawn for
    ppem: u16,
    /// bitmap position in strike pixels: left edge from the pen, top edge
    /// above the baseline (sbix: bottom edge, see `origin_is_bottom`)
    bearing_x: i16,
    bearing_y: i16,
    origin_is_bottom: bool = false,
};

/// The CBDT bitmap of `gid` from the strike closest to `want_ppem`.
pub fn cbdtGlyph(cblc: []const u8, cbdt: []const u8, gid: u32, want_ppem: f32) ?BitmapGlyph {
    return cbdtImpl(cblc, cbdt, gid, want_ppem) catch null;
}

fn cbdtImpl(cblc: []const u8, cbdt: []const u8, gid: u32, want_ppem: f32) error{Malformed}!?BitmapGlyph {
    const nsizes = try u32At(cblc, 4);
    // smallest strike at least as large as wanted, else the largest
    var best: ?usize = null;
    var best_ppem: u16 = 0;
    for (0..@min(nsizes, 64)) |i| {
        const bs = 8 + 48 * i;
        const start = try u16At(cblc, bs + 40);
        const end = try u16At(cblc, bs + 42);
        if (gid < start or gid > end) continue;
        const ppem: u16 = try u8At(cblc, bs + 44);
        const better = if (best == null) true else if (best_ppem < @as(u16, @intFromFloat(@ceil(want_ppem)))) ppem > best_ppem else (ppem >= @as(u16, @intFromFloat(@ceil(want_ppem))) and ppem < best_ppem);
        if (better) {
            best = bs;
            best_ppem = ppem;
        }
    }
    const bs = best orelse return null;
    const arr = try u32At(cblc, bs);
    const nsub = try u32At(cblc, bs + 8);
    for (0..@min(nsub, 1024)) |k| {
        const rec = arr + 8 * k;
        const first = try u16At(cblc, rec);
        const last = try u16At(cblc, rec + 2);
        if (gid < first or gid > last) continue;
        const st = arr + try u32At(cblc, rec + 4);
        const index_format = try u16At(cblc, st);
        const image_format = try u16At(cblc, st + 2);
        const data_off = try u32At(cblc, st + 4);
        const i = gid - first;
        var off: usize = undefined;
        var end: usize = undefined;
        var big: ?[]const u8 = null;
        switch (index_format) {
            1 => {
                off = try u32At(cblc, st + 8 + 4 * i);
                end = try u32At(cblc, st + 8 + 4 * (i + 1));
            },
            3 => {
                off = try u16At(cblc, st + 8 + 2 * i);
                end = try u16At(cblc, st + 8 + 2 * (i + 1));
            },
            2 => {
                const size = try u32At(cblc, st + 8);
                big = try sub(cblc, st + 12, 8);
                off = @as(usize, size) * i;
                end = off + size;
            },
            else => return null,
        }
        if (end <= off) return null;
        const img = try sub(cbdt, @as(usize, data_off) + off, end - off);
        switch (image_format) {
            17 => { // small metrics + PNG
                const len = try u32At(img, 5);
                return .{ .png = try sub(img, 9, len), .ppem = best_ppem, .bearing_x = @as(i8, @bitCast(try u8At(img, 2))), .bearing_y = @as(i8, @bitCast(try u8At(img, 3))) };
            },
            18 => { // big metrics + PNG
                const len = try u32At(img, 8);
                return .{ .png = try sub(img, 12, len), .ppem = best_ppem, .bearing_x = @as(i8, @bitCast(try u8At(img, 2))), .bearing_y = @as(i8, @bitCast(try u8At(img, 3))) };
            },
            19 => { // PNG, metrics in the index (format 2/5)
                const m = big orelse return null;
                const len = try u32At(img, 0);
                return .{ .png = try sub(img, 4, len), .ppem = best_ppem, .bearing_x = @as(i8, @bitCast(m[2])), .bearing_y = @as(i8, @bitCast(m[3])) };
            },
            else => return null,
        }
    }
    return null;
}

/// The sbix bitmap of `gid` from the strike closest to `want_ppem`.
pub fn sbixGlyph(sbix: []const u8, num_glyphs: u16, gid: u32, want_ppem: f32) ?BitmapGlyph {
    return sbixImpl(sbix, num_glyphs, gid, want_ppem, 0) catch null;
}

fn sbixImpl(sb: []const u8, num_glyphs: u16, gid: u32, want_ppem: f32, depth: u8) error{Malformed}!?BitmapGlyph {
    if (depth > 4 or gid >= num_glyphs) return null;
    const nstrikes = try u32At(sb, 4);
    var best: ?usize = null;
    var best_ppem: u16 = 0;
    const want: u16 = @intFromFloat(@ceil(@max(1, want_ppem)));
    for (0..@min(nstrikes, 64)) |i| {
        const so = try u32At(sb, 8 + 4 * i);
        const ppem = try u16At(sb, so);
        const better = if (best == null) true else if (best_ppem < want) ppem > best_ppem else (ppem >= want and ppem < best_ppem);
        if (better) {
            best = so;
            best_ppem = ppem;
        }
    }
    const so = best orelse return null;
    const a = try u32At(sb, so + 4 + 4 * @as(usize, gid));
    const b = try u32At(sb, so + 4 + 4 * (@as(usize, gid) + 1));
    if (b <= a + 8) return null;
    const g = try sub(sb, so + a, b - a);
    const kind = try u32At(g, 4);
    if (kind == tag("dupe")) return sbixImpl(sb, num_glyphs, try u16At(g, 8), want_ppem, depth + 1);
    if (kind != tag("png ")) return null;
    return .{ .png = g[8..], .ppem = best_ppem, .bearing_x = try i16At(g, 0), .bearing_y = try i16At(g, 2), .origin_is_bottom = true };
}

// ---------------------------------------------------------------------------
// Coverage and class definitions (GSUB/GPOS)
// ---------------------------------------------------------------------------

/// Index of `gid` in a Coverage table, or null.
pub fn coverageIndex(cov: []const u8, gid: u32) ?u16 {
    return coverageImpl(cov, gid) catch null;
}

fn coverageImpl(cov: []const u8, gid: u32) error{Malformed}!?u16 {
    const format = try u16At(cov, 0);
    const n = try u16At(cov, 2);
    if (format == 1) {
        var lo: usize = 0;
        var hi: usize = n;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            const g = try u16At(cov, 4 + 2 * mid);
            if (g < gid) lo = mid + 1 else if (g > gid) hi = mid else return @intCast(mid);
        }
        return null;
    }
    if (format == 2) {
        var lo: usize = 0;
        var hi: usize = n;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            const rec = 4 + 6 * mid;
            const start = try u16At(cov, rec);
            const end = try u16At(cov, rec + 2);
            if (gid < start) hi = mid else if (gid > end) lo = mid + 1 else return @intCast(@as(u32, try u16At(cov, rec + 4)) + gid - start);
        }
        return null;
    }
    return null;
}

pub fn classOf(cd: []const u8, gid: u32) u16 {
    return classImpl(cd, gid) catch 0;
}

fn classImpl(cd: []const u8, gid: u32) error{Malformed}!u16 {
    const format = try u16At(cd, 0);
    if (format == 1) {
        const start = try u16At(cd, 2);
        const n = try u16At(cd, 4);
        if (gid < start or gid >= @as(u32, start) + n) return 0;
        return try u16At(cd, 6 + 2 * (gid - start));
    }
    if (format == 2) {
        const n = try u16At(cd, 2);
        var lo: usize = 0;
        var hi: usize = n;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            const rec = 4 + 6 * mid;
            const start = try u16At(cd, rec);
            const end = try u16At(cd, rec + 2);
            if (gid < start) hi = mid else if (gid > end) lo = mid + 1 else return try u16At(cd, rec + 4);
        }
    }
    return 0;
}

fn valueRecordSize(format: u16) usize {
    return 2 * @popCount(format & 0xFF);
}

/// x-advance adjustment from a ValueRecord.
fn valueXAdvance(rec: []const u8, format: u16) i16 {
    if (format & 4 == 0) return 0;
    var off: usize = 0;
    if (format & 1 != 0) off += 2;
    if (format & 2 != 0) off += 2;
    return i16At(rec, off) catch 0;
}

fn valueXPlacement(rec: []const u8, format: u16) i16 {
    if (format & 1 == 0) return 0;
    return i16At(rec, 0) catch 0;
}

pub const PairAdjust = struct { first_advance: i16 = 0, second_placement: i16 = 0, second_advance: i16 = 0 };

/// Pair adjustment (GPOS lookup type 2 subtable) for (left, right), or null.
pub fn pairAdjust(st: []const u8, left: u32, right: u32) ?PairAdjust {
    return pairImpl(st, left, right) catch null;
}

fn pairImpl(st: []const u8, left: u32, right: u32) error{Malformed}!?PairAdjust {
    const format = try u16At(st, 0);
    const cov = try from(st, try u16At(st, 2));
    const ci = coverageIndex(cov, left) orelse return null;
    const vf1 = try u16At(st, 4);
    const vf2 = try u16At(st, 6);
    const s1 = valueRecordSize(vf1);
    const s2 = valueRecordSize(vf2);
    if (format == 1) {
        const nsets = try u16At(st, 8);
        if (ci >= nsets) return null;
        const set = try from(st, try u16At(st, 10 + 2 * @as(usize, ci)));
        const n = try u16At(set, 0);
        const rec_size = 2 + s1 + s2;
        var lo: usize = 0;
        var hi: usize = n;
        while (lo < hi) {
            const mid = (lo + hi) / 2;
            const rec = 2 + rec_size * mid;
            const g = try u16At(set, rec);
            if (g < right) lo = mid + 1 else if (g > right) hi = mid else {
                const v1 = try sub(set, rec + 2, s1);
                const v2 = try sub(set, rec + 2 + s1, s2);
                return .{ .first_advance = valueXAdvance(v1, vf1), .second_placement = valueXPlacement(v2, vf2), .second_advance = valueXAdvance(v2, vf2) };
            }
        }
        return null;
    }
    if (format == 2) {
        const cd1 = try from(st, try u16At(st, 8));
        const cd2 = try from(st, try u16At(st, 10));
        const n1 = try u16At(st, 12);
        const n2 = try u16At(st, 14);
        const c1 = classOf(cd1, left);
        const c2 = classOf(cd2, right);
        if (c1 >= n1 or c2 >= n2) return null;
        const rec_size = s1 + s2;
        const rec = 16 + (@as(usize, c1) * n2 + c2) * rec_size;
        const v1 = try sub(st, rec, s1);
        const v2 = try sub(st, rec + s1, s2);
        const a = PairAdjust{ .first_advance = valueXAdvance(v1, vf1), .second_placement = valueXPlacement(v2, vf2), .second_advance = valueXAdvance(v2, vf2) };
        if (a.first_advance == 0 and a.second_placement == 0 and a.second_advance == 0) return null;
        return a;
    }
    return null;
}

/// Legacy 'kern' table (format 0) pair value.
pub fn legacyKern(kern: []const u8, left: u32, right: u32) i16 {
    return legacyImpl(kern, left, right) catch 0;
}

fn legacyImpl(k: []const u8, left: u32, right: u32) error{Malformed}!i16 {
    if (k.len < 4 or (try u16At(k, 0)) != 0) return 0;
    const ntables = try u16At(k, 2);
    var off: usize = 4;
    for (0..ntables) |_| {
        const len = try u16At(k, off + 2);
        const coverage = try u16At(k, off + 4);
        if (coverage >> 8 == 0 and coverage & 1 != 0) { // format 0, horizontal
            const n = try u16At(k, off + 6);
            const key = (left << 16) | right;
            var lo: usize = 0;
            var hi: usize = n;
            while (lo < hi) {
                const mid = (lo + hi) / 2;
                const rec = off + 14 + 6 * mid;
                const kk = try u32At(k, rec);
                if (kk < key) lo = mid + 1 else if (kk > key) hi = mid else return try i16At(k, rec + 4);
            }
        }
        off += len;
    }
    return 0;
}

/// GSUB ligature subtable (lookup type 4): if a ligature starts at
/// `glyphs[0]`, return (ligature glyph, components consumed).
pub const Ligature = struct { glyph: u16, len: usize };

pub fn ligature(st: []const u8, glyphs: []const u32) ?Ligature {
    return ligImpl(st, glyphs) catch null;
}

fn ligImpl(st: []const u8, glyphs: []const u32) error{Malformed}!?Ligature {
    if (glyphs.len == 0 or (try u16At(st, 0)) != 1) return null;
    const cov = try from(st, try u16At(st, 2));
    const ci = coverageIndex(cov, glyphs[0]) orelse return null;
    const nsets = try u16At(st, 4);
    if (ci >= nsets) return null;
    const set = try from(st, try u16At(st, 6 + 2 * @as(usize, ci)));
    const nligs = try u16At(set, 0);
    for (0..nligs) |li| {
        const lig = try from(set, try u16At(set, 2 + 2 * li));
        const glyph = try u16At(lig, 0);
        const ncomp = try u16At(lig, 2);
        if (ncomp == 0 or ncomp > glyphs.len) continue;
        var ok = true;
        for (1..ncomp) |c| {
            if ((try u16At(lig, 4 + 2 * (c - 1))) != glyphs[c]) {
                ok = false;
                break;
            }
        }
        if (ok) return .{ .glyph = glyph, .len = ncomp };
    }
    return null;
}

// ---------------------------------------------------------------------------
// GSUB engine: single, multiple, ligature, context and chained-context
// substitutions over a glyph buffer that tracks source clusters.
// ---------------------------------------------------------------------------

pub const GlyphBuf = struct {
    gids: std.ArrayList(u32) = .empty,
    clusters: std.ArrayList(u32) = .empty,

    pub fn deinit(b: *GlyphBuf, gpa: Allocator) void {
        b.gids.deinit(gpa);
        b.clusters.deinit(gpa);
    }

    fn replaceRange(b: *GlyphBuf, gpa: Allocator, at: usize, n: usize, with: []const u32) Allocator.Error!void {
        const cl = b.clusters.items[at];
        try b.gids.replaceRange(gpa, at, n, with);
        // new glyphs inherit the first replaced glyph's cluster
        var tmp: [32]u32 = undefined;
        const m = @min(with.len, tmp.len);
        @memset(tmp[0..m], cl);
        try b.clusters.replaceRange(gpa, at, n, tmp[0..m]);
        if (with.len > m) return error.OutOfMemory; // sequences are short in practice
    }
};

/// Apply GSUB `features` (each lookup once, in lookup order) to `buf`.
pub fn applyGsub(gpa: Allocator, gsub: []const u8, features: []const u32, buf: *GlyphBuf) Allocator.Error!void {
    if (gsub.len < 10 or buf.gids.items.len == 0) return;
    var all: [128]u16 = undefined;
    var n: usize = 0;
    for (features) |ft| {
        var tmp: [64]u16 = undefined;
        const k = Font.featureLookups(gsub, ft, &tmp);
        for (tmp[0..k]) |li| {
            if (std.mem.indexOfScalar(u16, all[0..n], li) == null and n < all.len) {
                all[n] = li;
                n += 1;
            }
        }
    }
    std.mem.sort(u16, all[0..n], {}, std.sort.asc(u16));
    for (all[0..n]) |li| {
        var i: usize = 0;
        while (i < buf.gids.items.len) {
            const adv = applyLookupAt(gpa, gsub, li, buf, i, 0) catch |e| switch (e) {
                error.Malformed => null,
                error.OutOfMemory => return error.OutOfMemory,
            };
            i += adv orelse 1;
        }
    }
}

/// Try lookup `li` at position `i`; returns how many glyphs to advance past
/// on success (null if nothing applied).
fn applyLookupAt(gpa: Allocator, gsub: []const u8, li: u16, buf: *GlyphBuf, i: usize, depth: u8) Error!?usize {
    if (depth > 8) return null;
    var subs: [64][]const u8 = undefined;
    const l = Font.lookup(gsub, li, 7, &subs);
    const g = buf.gids.items[i];
    for (subs[0..l.n]) |st| {
        switch (l.kind) {
            1 => { // single
                const format = try u16At(st, 0);
                const ci = coverageIndex(try from(st, try u16At(st, 2)), g) orelse continue;
                buf.gids.items[i] = if (format == 1)
                    @as(u16, @truncate(g +% @as(u32, @bitCast(@as(i32, try i16At(st, 4))))))
                else
                    try u16At(st, 6 + 2 * @as(usize, ci));
                return 1;
            },
            2 => { // multiple
                const ci = coverageIndex(try from(st, try u16At(st, 2)), g) orelse continue;
                const seq = try from(st, try u16At(st, 6 + 2 * @as(usize, ci)));
                const cnt = try u16At(seq, 0);
                if (cnt == 0 or cnt > 32) return null;
                var out: [32]u32 = undefined;
                for (0..cnt) |k| out[k] = try u16At(seq, 2 + 2 * k);
                try buf.replaceRange(gpa, i, 1, out[0..cnt]);
                return cnt;
            },
            4 => { // ligature
                const r = ligature(st, buf.gids.items[i..]) orelse continue;
                try buf.replaceRange(gpa, i, r.len, &.{r.glyph});
                return 1;
            },
            5, 6 => if (try contextual(gpa, gsub, st, l.kind == 6, buf, i, depth)) |adv| return adv,
            else => {},
        }
    }
    return null;
}

/// Context (5) and chained context (6) substitutions, formats 1-3.
fn contextual(gpa: Allocator, gsub: []const u8, st: []const u8, chained: bool, buf: *GlyphBuf, i: usize, depth: u8) Error!?usize {
    const format = try u16At(st, 0);
    const gids = buf.gids.items;
    var rules: Rule = undefined;
    switch (format) {
        3 => {
            var off: usize = 2;
            var back: []const u8 = &.{};
            var bn: u16 = 0;
            if (chained) {
                bn = try u16At(st, off);
                back = try sub(st, off + 2, 2 * @as(usize, bn));
                off += 2 + 2 * @as(usize, bn);
            }
            const in_n = try u16At(st, off);
            var in_cov: []const u8 = undefined;
            var la: []const u8 = &.{};
            var la_n: u16 = 0;
            var recs_off: usize = undefined;
            var nrecs: u16 = undefined;
            if (chained) {
                in_cov = try sub(st, off + 2, 2 * @as(usize, in_n));
                off += 2 + 2 * @as(usize, in_n);
                la_n = try u16At(st, off);
                la = try sub(st, off + 2, 2 * @as(usize, la_n));
                off += 2 + 2 * @as(usize, la_n);
                nrecs = try u16At(st, off);
                recs_off = off + 2;
            } else {
                nrecs = try u16At(st, off + 2);
                in_cov = try sub(st, off + 4, 2 * @as(usize, in_n));
                recs_off = off + 4 + 2 * @as(usize, in_n);
            }
            if (in_n == 0 or i + in_n > gids.len or i < bn or i + in_n + la_n > gids.len) return null;
            for (0..in_n) |k| if (coverageIndex(try from(st, try u16At(in_cov, 2 * k)), gids[i + k]) == null) return null;
            for (0..bn) |k| if (coverageIndex(try from(st, try u16At(back, 2 * k)), gids[i - 1 - k]) == null) return null;
            for (0..la_n) |k| if (coverageIndex(try from(st, try u16At(la, 2 * k)), gids[i + in_n + k]) == null) return null;
            rules = .{ .recs = try sub(st, recs_off, 4 * @as(usize, nrecs)), .input_len = in_n };
        },
        1, 2 => {
            const cov = try from(st, try u16At(st, 2));
            _ = coverageIndex(cov, gids[i]) orelse return null;
            // class definitions (format 2): backtrack, input, lookahead
            var cd_b: []const u8 = &.{};
            var cd_i: []const u8 = &.{};
            var cd_l: []const u8 = &.{};
            var sets_off: usize = 6;
            if (format == 2) {
                if (chained) {
                    cd_b = try from(st, try u16At(st, 4));
                    cd_i = try from(st, try u16At(st, 6));
                    cd_l = try from(st, try u16At(st, 8));
                    sets_off = 10;
                } else {
                    cd_i = try from(st, try u16At(st, 4));
                    sets_off = 6;
                }
            } else sets_off = 4;
            const nsets = try u16At(st, sets_off);
            const key: u32 = if (format == 2) classOf(cd_i, gids[i]) else (coverageIndex(cov, gids[i]) orelse return null);
            if (key >= nsets) return null;
            const set_off = try u16At(st, sets_off + 2 + 2 * @as(usize, key));
            if (set_off == 0) return null;
            const set = try from(st, set_off);
            const nrules = try u16At(set, 0);
            for (0..nrules) |ri| {
                const r = try from(set, try u16At(set, 2 + 2 * ri));
                const m = struct {
                    fn val(fmt: u16, cd: []const u8, gid: u32) u32 {
                        return if (fmt == 2) classOf(cd, gid) else gid;
                    }
                };
                var o: usize = 0;
                var bn: u16 = 0;
                if (chained) {
                    bn = try u16At(r, 0);
                    if (i < bn) continue;
                    var ok = true;
                    for (0..bn) |k| if ((try u16At(r, 2 + 2 * k)) != m.val(format, cd_b, gids[i - 1 - k])) {
                        ok = false;
                        break;
                    };
                    if (!ok) continue;
                    o = 2 + 2 * @as(usize, bn);
                }
                const in_n = try u16At(r, o);
                var nrecs: u16 = undefined;
                var in_off: usize = undefined;
                if (chained) {
                    in_off = o + 2;
                } else {
                    nrecs = try u16At(r, o + 2);
                    in_off = o + 4;
                }
                if (in_n == 0 or i + in_n > gids.len) continue;
                var ok = true;
                for (1..in_n) |k| if ((try u16At(r, in_off + 2 * (k - 1))) != m.val(format, cd_i, gids[i + k])) {
                    ok = false;
                    break;
                };
                if (!ok) continue;
                var p = in_off + 2 * (@as(usize, in_n) - 1);
                if (chained) {
                    const la_n = try u16At(r, p);
                    if (i + in_n + la_n > gids.len) continue;
                    for (0..la_n) |k| if ((try u16At(r, p + 2 + 2 * k)) != m.val(format, cd_l, gids[i + in_n + k])) {
                        ok = false;
                        break;
                    };
                    if (!ok) continue;
                    p += 2 + 2 * @as(usize, la_n);
                    nrecs = try u16At(r, p);
                    p += 2;
                }
                rules = .{ .recs = try sub(r, p, 4 * @as(usize, nrecs)), .input_len = in_n };
                break;
            } else return null;
        },
        else => return null,
    }
    // apply nested lookups at their sequence positions
    var len: usize = rules.input_len;
    var k: usize = 0;
    while (k + 3 < rules.recs.len) : (k += 4) {
        const seq_idx = try u16At(rules.recs, k);
        const nested = try u16At(rules.recs, k + 2);
        if (seq_idx >= len) continue;
        const before = buf.gids.items.len;
        _ = try applyLookupAt(gpa, gsub, nested, buf, i + seq_idx, depth + 1);
        // ligatures shrink, multiple substitutions grow the matched span
        const after = buf.gids.items.len;
        if (after < before) len -|= before - after else len += after - before;
    }
    return @max(1, len);
}

const Rule = struct { recs: []const u8, input_len: usize };

/// GSUB features browsers apply by default for horizontal text.
pub const default_gsub_features = [_]u32{ tag("ccmp"), tag("locl"), tag("rlig"), tag("liga"), tag("clig"), tag("calt") };

// ---------------------------------------------------------------------------
// Tests (reference values from HarfBuzz / fontTools for the bundled fonts)
// ---------------------------------------------------------------------------

const roboto = @import("testdata").fonts.roboto;
const source_sans = @import("testdata").fonts.source_sans;

test "parse tables, metrics and names" {
    const f = try Font.parse(roboto, 0);
    try std.testing.expectEqual(@as(u16, 2048), f.units_per_em);
    const m = f.vmetrics();
    try std.testing.expectEqual(@as(i32, 2146), m.ascent);
    try std.testing.expectEqual(@as(i32, 555), m.descent);
    try std.testing.expectEqual(@as(i32, 1082), m.x_height);
    try std.testing.expectEqual(@as(i32, 1456), m.cap_height);
    try std.testing.expectEqual(@as(i32, 150), m.underline_pos);
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("Roboto", f.familyName(&buf).?);
    try std.testing.expectEqual(@as(u16, 400), f.weight());
    try std.testing.expect(!f.isItalic());
    const g = try Font.parse(source_sans, 0);
    try std.testing.expectEqual(@as(u16, 1000), g.units_per_em);
    try std.testing.expectEqual(@as(i32, 486), g.vmetrics().x_height);
    try std.testing.expect(g.cff != null);
}

test "cmap lookups match HarfBuzz glyph ids" {
    const f = try Font.parse(roboto, 0);
    try std.testing.expectEqual(@as(u32, 34), f.glyphIndex('A'));
    try std.testing.expectEqual(@as(u32, 55), f.glyphIndex('V'));
    try std.testing.expectEqual(@as(u32, 225), f.glyphIndex(0xE9)); // é
    try std.testing.expectEqual(@as(u32, 152), f.glyphIndex(0x3A9)); // Ω
    try std.testing.expectEqual(@as(u32, 0), f.glyphIndex(0x4E00)); // not in subset
    const g = try Font.parse(source_sans, 0);
    try std.testing.expectEqual(@as(u32, 2), g.glyphIndex('A'));
    try std.testing.expectEqual(@as(u32, 23), g.glyphIndex('V'));
}

test "advances and GPOS pair kerning match HarfBuzz" {
    const f = try Font.parse(roboto, 0);
    try std.testing.expectEqual(@as(u16, 1336), f.advance(34)); // A unkerned
    var lookups: [16]u16 = undefined;
    const n = Font.featureLookups(f.tables.gpos, tag("kern"), &lookups);
    try std.testing.expect(n > 0);
    // A followed by V: HarfBuzz advances 1249 = 1336 - 87
    var total: i32 = 0;
    for (lookups[0..n]) |li| {
        var subs: [64][]const u8 = undefined;
        const l = Font.lookup(f.tables.gpos, li, 9, &subs);
        if (l.kind != 2) continue;
        for (subs[0..l.n]) |st| if (pairAdjust(st, 34, 55)) |a| {
            total += a.first_advance;
            break;
        };
    }
    try std.testing.expectEqual(@as(i32, 1249 - 1336), total);
}

test "GSUB ligature: Source Sans ff" {
    const g = try Font.parse(source_sans, 0);
    var lookups: [16]u16 = undefined;
    const n = Font.featureLookups(g.tables.gsub, tag("liga"), &lookups);
    try std.testing.expect(n > 0);
    const ff = [_]u32{ g.glyphIndex('f'), g.glyphIndex('f'), g.glyphIndex('i') };
    var found: ?u16 = null;
    var consumed: usize = 0;
    for (lookups[0..n]) |li| {
        var subs: [64][]const u8 = undefined;
        const l = Font.lookup(g.tables.gsub, li, 7, &subs);
        if (l.kind != 4) continue;
        for (subs[0..l.n]) |st| if (ligature(st, &ff)) |r| {
            found = r.glyph;
            consumed = r.len;
            break;
        };
    }
    // HarfBuzz shapes "office" with glyph 57 covering "ff"
    try std.testing.expectEqual(@as(?u16, 57), found);
    try std.testing.expectEqual(@as(usize, 2), consumed);
}

fn pathBounds(p: *const Path) [4]f32 {
    return p.bounds(.identity).?;
}

test "glyf outlines (quadratic) have the reference bounds" {
    const gpa = std.testing.allocator;
    const f = try Font.parse(roboto, 0);
    var p: Path = .{};
    defer p.deinit(gpa);
    try f.outline(gpa, f.glyphIndex('A'), &p);
    const b = pathBounds(&p);
    try std.testing.expectEqual(@as(f32, 28), b[0]);
    try std.testing.expectEqual(@as(f32, 0), b[1]);
    try std.testing.expectEqual(@as(f32, 1309), b[2]);
    try std.testing.expectEqual(@as(f32, 1456), b[3]);
    // 'é' is a composite glyph (e + acute)
    p.clear();
    try f.outline(gpa, f.glyphIndex(0xE9), &p);
    try std.testing.expect(p.verbs.items.len > 10);
}

test "CFF outlines (cubic) have the reference bounds" {
    const gpa = std.testing.allocator;
    const g = try Font.parse(source_sans, 0);
    var p: Path = .{};
    defer p.deinit(gpa);
    try g.outline(gpa, g.glyphIndex('A'), &p);
    const b = pathBounds(&p);
    try std.testing.expectApproxEqAbs(@as(f32, 3), b[0], 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 0), b[1], 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 541), b[2], 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 656), b[3], 0.01);
    // 'O': control points can exceed the tight bounds slightly
    p.clear();
    try g.outline(gpa, g.glyphIndex('O'), &p);
    const o = pathBounds(&p);
    try std.testing.expectApproxEqAbs(@as(f32, 52), o[0], 1);
    try std.testing.expectApproxEqAbs(@as(f32, 613), o[2], 1);
}

test "COLR v0 layers and CPAL colors" {
    const f = try Font.parse(@import("testdata").fonts.color_test, 0);
    var layers: [8]ColorLayer = undefined;
    const n = colrLayers(f.tables.colr, f.glyphIndex('A'), &layers);
    try std.testing.expectEqual(@as(usize, 2), n);
    try std.testing.expectEqual(@as(u16, @intCast(f.glyphIndex('O'))), layers[0].glyph);
    try std.testing.expectEqual(@as(u16, 0), layers[0].palette_index);
    try std.testing.expectEqual(@as(u16, @intCast(f.glyphIndex('A'))), layers[1].glyph);
    try std.testing.expectEqual([4]u8{ 255, 0, 0, 255 }, paletteColor(f.tables.cpal, 0).?);
    try std.testing.expectEqual([4]u8{ 0, 0, 255, 255 }, paletteColor(f.tables.cpal, 1).?);
    try std.testing.expectEqual(@as(u8, 128), paletteColor(f.tables.cpal, 2).?[3]);
    try std.testing.expectEqual(@as(usize, 0), colrLayers(f.tables.colr, f.glyphIndex('V'), &layers));
}

test "CBDT bitmap glyph lookup (Noto Color Emoji subset)" {
    const f = try Font.parse(@import("testdata").fonts.noto_emoji, 0);
    try std.testing.expect(f.hasColor());
    const gid = f.glyphIndex(0x1F600);
    try std.testing.expect(gid != 0);
    const g = cbdtGlyph(f.tables.cblc, f.tables.cbdt, gid, 32).?;
    try std.testing.expectEqual(@as(u16, 109), g.ppem);
    try std.testing.expectEqual(@as(i16, 0), g.bearing_x);
    try std.testing.expectEqual(@as(i16, 101), g.bearing_y);
    try std.testing.expectEqualSlices(u8, "\x89PNG", g.png[0..4]);
    try std.testing.expect(cbdtGlyph(f.tables.cblc, f.tables.cbdt, 999, 32) == null);
}

test "malformed fonts never crash" {
    const gpa = std.testing.allocator;
    var prng = std.Random.DefaultPrng.init(7);
    const r = prng.random();
    for ([_][]const u8{ roboto, source_sans, @import("testdata").fonts.color_test, @import("testdata").fonts.noto_emoji }) |orig| {
        const buf = try gpa.dupe(u8, orig);
        defer gpa.free(buf);
        for (0..300) |iter| {
            @memcpy(buf, orig);
            // corrupt a few bytes, sometimes truncate
            for (0..1 + iter % 8) |_| buf[r.uintLessThan(usize, buf.len)] = r.int(u8);
            const len = if (iter % 5 == 0) r.uintLessThan(usize, buf.len) else buf.len;
            const f = Font.parse(buf[0..len], 0) catch continue;
            var p: Path = .{};
            defer p.deinit(gpa);
            _ = f.vmetrics();
            var nb: [64]u8 = undefined;
            _ = f.familyName(&nb);
            for ("AVOfé") |c| {
                const gid = f.glyphIndex(c);
                _ = f.advance(gid);
                f.outline(gpa, gid, &p) catch {};
            }
            var layers: [16]ColorLayer = undefined;
            for (0..8) |gi| {
                _ = colrLayers(f.tables.colr, @intCast(gi), &layers);
                _ = cbdtGlyph(f.tables.cblc, f.tables.cbdt, @intCast(gi), 32);
                for (0..4) |li| _ = paletteColor(f.tables.cpal, @intCast(li));
            }
            {
                var gb: GlyphBuf = .{};
                defer gb.deinit(gpa);
                for ("AV\x01ff", 0..) |c, ci| {
                    gb.gids.append(gpa, f.glyphIndex(c)) catch break;
                    gb.clusters.append(gpa, @intCast(ci)) catch break;
                }
                applyGsub(gpa, f.tables.gsub, &default_gsub_features, &gb) catch {};
            }
            var lk: [16]u16 = undefined;
            const n = Font.featureLookups(f.tables.gpos, tag("kern"), &lk);
            for (lk[0..n]) |li| {
                var subs: [64][]const u8 = undefined;
                const l = Font.lookup(f.tables.gpos, li, 9, &subs);
                for (subs[0..l.n]) |st| _ = pairAdjust(st, 34, 55);
            }
        }
    }
}
