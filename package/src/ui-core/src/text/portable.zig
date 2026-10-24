//! Portable text backend: pure-Zig OpenType parsing, shaping (GSUB
//! ligatures, GPOS/kern kerning), font fallback and glyph rasterization.
//! Platform APIs are only used to find font files: the backend scans the
//! system font directories lazily, reading just each file's name/OS/2
//! tables, and memory-maps a font when it is first used.
//!
//! Not yet: bidi reordering and complex-script shaping (Arabic, Indic, ...),
//! color glyphs, variable-font instances. The interface keeps room for a
//! HarfBuzz shaper later.
const std = @import("std");
const builtin = @import("builtin");
const font = @import("font.zig");
const otf = @import("otf.zig");
const raster = @import("../raster/path.zig");
const png = @import("../image/png.zig");

const Allocator = std.mem.Allocator;
const FontId = font.FontId;

pub const Options = struct {
    /// scan the platform's font directories (off for hermetic tests)
    system_fonts: bool = true,
    /// extra directories to scan
    extra_dirs: []const []const u8 = &.{},
};

const Backing = union(enum) {
    /// caller-owned memory that outlives the backend (embedded fonts)
    borrowed,
    owned: []u8,
    mapped: std.Io.File.MemoryMap,
};

const Face = struct {
    font: otf.Font,
    backing: Backing,
    file: ?std.Io.File = null,
    family: []u8,
    weight: u16,
    italic: bool,
    /// GPOS kern lookup indices, resolved on first use
    kern: ?[]u16 = null,
};

/// A font file face found on disk but not loaded yet.
const SysEntry = struct {
    path: []u8,
    index: u32,
    family: []u8,
    weight: u16,
    italic: bool,
    /// index into `faces` once loaded
    face: ?u32 = null,
    failed: bool = false,
};

const Instance = struct {
    face: ?u32,
    size: f32,
    synth_bold: bool = false,
    synth_italic: bool = false,
};

pub const PortableBackend = struct {
    gpa: Allocator,
    opts: Options,
    threaded: ?std.Io.Threaded = null,
    faces: std.ArrayList(*Face) = .empty,
    sys: std.ArrayList(SysEntry) = .empty,
    sys_scanned: bool = false,
    instances: std.ArrayList(Instance) = .empty,
    inst_map: std.AutoHashMapUnmanaged(u64, FontId) = .empty,
    /// (code point, emoji presentation) -> face that covers it (null: none)
    fallback: std.AutoHashMapUnmanaged(u32, ?u32) = .empty,
    path: raster.Path = .{},
    bitmap: std.ArrayList(u8) = .empty,

    pub fn create(gpa: Allocator, opts: Options) !font.Backend {
        const self = try gpa.create(PortableBackend);
        self.* = .{ .gpa = gpa, .opts = opts };
        // FontId 0: "no font" sentinel until something resolves
        try self.instances.append(gpa, .{ .face = null, .size = 16 });
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: font.Backend.VTable = .{
        .resolve = resolve,
        .metrics = metrics,
        .shape = shape,
        .rasterize = rasterize,
        .isColor = isColor,
        .deinit = deinit,
        .registerFont = registerFont,
    };

    fn me(p: *anyopaque) *PortableBackend {
        return @ptrCast(@alignCast(p));
    }

    fn io(s: *PortableBackend) std.Io {
        if (s.threaded == null) s.threaded = std.Io.Threaded.init(s.gpa, .{});
        return s.threaded.?.io();
    }

    fn deinit(p: *anyopaque) void {
        const s = me(p);
        for (s.faces.items) |f| s.freeFace(f);
        s.faces.deinit(s.gpa);
        for (s.sys.items) |e| {
            s.gpa.free(e.path);
            s.gpa.free(e.family);
        }
        s.sys.deinit(s.gpa);
        s.instances.deinit(s.gpa);
        s.inst_map.deinit(s.gpa);
        s.fallback.deinit(s.gpa);
        s.path.deinit(s.gpa);
        s.bitmap.deinit(s.gpa);
        if (s.threaded) |*t| t.deinit();
        s.gpa.destroy(s);
    }

    fn freeFace(s: *PortableBackend, f: *Face) void {
        switch (f.backing) {
            .borrowed => {},
            .owned => |b| s.gpa.free(b),
            .mapped => |*m| {
                var mm = m.*;
                mm.destroy(s.io());
            },
        }
        if (f.file) |file| file.close(s.io());
        if (f.kern) |k| s.gpa.free(k);
        s.gpa.free(f.family);
        s.gpa.destroy(f);
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /// Add font data that outlives the backend (e.g. @embedFile).
    pub fn addBorrowed(s: *PortableBackend, data: []const u8) !void {
        const n = @max(1, otf.faceCount(data));
        for (0..n) |i| _ = try s.addFace(data, @intCast(i), .borrowed, null);
    }

    fn addFace(s: *PortableBackend, data: []const u8, index: u32, backing: Backing, family_override: ?[]const u8) !u32 {
        const f = try otf.Font.parse(data, index);
        var name_buf: [256]u8 = undefined;
        const fam = family_override orelse (f.familyName(&name_buf) orelse "");
        const face = try s.gpa.create(Face);
        errdefer s.gpa.destroy(face);
        face.* = .{
            .font = f,
            .backing = backing,
            .family = try s.gpa.dupe(u8, fam),
            .weight = f.weight(),
            .italic = f.isItalic(),
        };
        try s.faces.append(s.gpa, face);
        return @intCast(s.faces.items.len - 1);
    }

    fn registerFont(p: *anyopaque, family: []const u8, data: []const u8, weight: f32, italic: bool) bool {
        const s = me(p);
        const copy = s.gpa.dupe(u8, data) catch return false;
        const idx = s.addFace(copy, 0, .{ .owned = copy }, family) catch {
            s.gpa.free(copy);
            return false;
        };
        // @font-face descriptors override the font's own
        s.faces.items[idx].weight = @intFromFloat(std.math.clamp(weight, 1, 1000));
        s.faces.items[idx].italic = italic;
        s.fallback.clearRetainingCapacity();
        return true;
    }

    // -----------------------------------------------------------------------
    // Font matching
    // -----------------------------------------------------------------------

    fn resolve(p: *anyopaque, spec: font.FontSpec) FontId {
        const s = me(p);
        const want_w: u16 = @intFromFloat(std.math.clamp(spec.weight, 1, 1000));
        for (spec.families) |fam| {
            if (s.findFamily(fam, want_w, spec.italic)) |fi| return s.instanceFor(fi, spec);
        }
        for (platform.sans) |fam| {
            if (s.findFamily(fam, want_w, spec.italic)) |fi| return s.instanceFor(fi, spec);
        }
        // anything at all
        if (s.faces.items.len > 0) return s.instanceFor(0, spec);
        s.scanSystem();
        for (s.sys.items, 0..) |_, i| if (s.loadSys(i)) |fi| return s.instanceFor(fi, spec);
        return s.instanceFor(null, spec);
    }

    fn instanceFor(s: *PortableBackend, face: ?u32, spec: font.FontSpec) FontId {
        var synth_bold = false;
        var synth_italic = false;
        if (face) |fi| {
            const f = s.faces.items[fi];
            synth_bold = spec.weight >= 600 and f.weight <= 500;
            synth_italic = spec.italic and !f.italic;
        }
        return s.instance(face, spec.size, synth_bold, synth_italic);
    }

    fn instance(s: *PortableBackend, face: ?u32, size: f32, synth_bold: bool, synth_italic: bool) FontId {
        const fbits: u64 = if (face) |f| f + 1 else 0;
        const key = (fbits << 34) | (@as(u64, @intFromBool(synth_bold)) << 33) | (@as(u64, @intFromBool(synth_italic)) << 32) | @as(u64, @as(u32, @bitCast(size)));
        if (s.inst_map.get(key)) |id| return id;
        s.instances.append(s.gpa, .{ .face = face, .size = size, .synth_bold = synth_bold, .synth_italic = synth_italic }) catch return 0;
        const id: FontId = @intCast(s.instances.items.len - 1);
        s.inst_map.put(s.gpa, key, id) catch {};
        return id;
    }

    /// Best face of `family` (generic names expand to the platform's list).
    fn findFamily(s: *PortableBackend, family: []const u8, weight: u16, italic: bool) ?u32 {
        const name = std.mem.trim(u8, family, " \"'");
        if (generic(name)) |list| {
            for (list) |fam| if (s.findExact(fam, weight, italic)) |fi| return fi;
            return null;
        }
        return s.findExact(name, weight, italic);
    }

    fn findExact(s: *PortableBackend, family: []const u8, weight: u16, italic: bool) ?u32 {
        // registered/loaded faces first (@font-face beats system fonts)
        var best: ?u32 = null;
        var best_score: i32 = std.math.maxInt(i32);
        for (s.faces.items, 0..) |f, i| {
            if (!std.ascii.eqlIgnoreCase(f.family, family)) continue;
            const sc = matchScore(f.weight, f.italic, weight, italic);
            if (sc < best_score) {
                best_score = sc;
                best = @intCast(i);
            }
        }
        // a system face may match better (e.g. bold requested, regular loaded)
        s.scanSystem();
        var best_sys: ?usize = null;
        for (s.sys.items, 0..) |e, i| {
            if (e.failed or !std.ascii.eqlIgnoreCase(e.family, family)) continue;
            const sc = matchScore(e.weight, e.italic, weight, italic);
            if (sc < best_score) {
                best_score = sc;
                best_sys = i;
            }
        }
        if (best_sys) |i| if (s.loadSys(i)) |fi| return fi;
        return best;
    }

    // -----------------------------------------------------------------------
    // System fonts
    // -----------------------------------------------------------------------

    pub fn scanSystem(s: *PortableBackend) void {
        if (s.sys_scanned) return;
        s.sys_scanned = true;
        if (s.opts.system_fonts) {
            var buf: [8][512]u8 = undefined;
            var dirs: [8][]const u8 = undefined;
            const n = platform.fontDirs(&buf, &dirs);
            for (dirs[0..n]) |d| s.scanDir(d);
        }
        for (s.opts.extra_dirs) |d| s.scanDir(d);
    }

    fn scanDir(s: *PortableBackend, dir_path: []const u8) void {
        const i = s.io();
        var dir = std.Io.Dir.cwd().openDir(i, dir_path, .{ .iterate = true }) catch return;
        defer dir.close(i);
        var walker = dir.walk(s.gpa) catch return;
        defer walker.deinit();
        while (walker.next(i) catch null) |entry| {
            if (entry.kind != .file and entry.kind != .sym_link) continue;
            const ext = std.fs.path.extension(entry.basename);
            const ok = std.ascii.eqlIgnoreCase(ext, ".ttf") or std.ascii.eqlIgnoreCase(ext, ".otf") or std.ascii.eqlIgnoreCase(ext, ".ttc") or std.ascii.eqlIgnoreCase(ext, ".otc");
            if (!ok) continue;
            const full = std.fs.path.join(s.gpa, &.{ dir_path, entry.path }) catch continue;
            defer s.gpa.free(full);
            s.indexFile(full);
        }
    }

    /// Read just the tables needed to describe each face in a font file.
    fn indexFile(s: *PortableBackend, path: []const u8) void {
        const i = s.io();
        var file = std.Io.Dir.cwd().openFile(i, path, .{}) catch return;
        defer file.close(i);
        var head: [12]u8 = undefined;
        if ((file.readPositionalAll(i, &head, 0) catch 0) != 12) return;
        var offsets: [64]u32 = undefined;
        var nfaces: usize = 1;
        offsets[0] = 0;
        if (std.mem.eql(u8, head[0..4], "ttcf")) {
            const n = std.mem.readInt(u32, head[8..12], .big);
            nfaces = @min(n, offsets.len);
            var tbl: [256]u8 = undefined;
            const got = file.readPositionalAll(i, tbl[0 .. nfaces * 4], 12) catch return;
            if (got != nfaces * 4) return;
            for (0..nfaces) |k| offsets[k] = std.mem.readInt(u32, tbl[k * 4 ..][0..4], .big);
        }
        for (0..nfaces) |k| s.indexFace(&file, path, offsets[k], @intCast(k));
    }

    fn indexFace(s: *PortableBackend, file: *std.Io.File, path: []const u8, off: u32, index: u32) void {
        const i = s.io();
        var hdr: [12]u8 = undefined;
        if ((file.readPositionalAll(i, &hdr, off) catch 0) != 12) return;
        const ntables = std.mem.readInt(u16, hdr[4..6], .big);
        if (ntables == 0 or ntables > 64) return;
        var dir: [64 * 16]u8 = undefined;
        const dlen = @as(usize, ntables) * 16;
        if ((file.readPositionalAll(i, dir[0..dlen], off + 12) catch 0) != dlen) return;
        var name_t: []u8 = &.{};
        var os2_t: []u8 = &.{};
        var head_t: []u8 = &.{};
        defer s.gpa.free(name_t);
        defer s.gpa.free(os2_t);
        defer s.gpa.free(head_t);
        var has_outlines = false;
        for (0..ntables) |t| {
            const rec = dir[t * 16 ..][0..16];
            const tg = rec[0..4];
            const toff = std.mem.readInt(u32, rec[8..12], .big);
            const tlen = std.mem.readInt(u32, rec[12..16], .big);
            if (std.mem.eql(u8, tg, "glyf") or std.mem.eql(u8, tg, "CFF ") or std.mem.eql(u8, tg, "CBDT") or std.mem.eql(u8, tg, "sbix")) has_outlines = true;
            const which: ?*[]u8 = if (std.mem.eql(u8, tg, "name")) &name_t else if (std.mem.eql(u8, tg, "OS/2")) &os2_t else if (std.mem.eql(u8, tg, "head")) &head_t else null;
            if (which) |w| {
                if (tlen > 1 << 20) continue;
                const b = s.gpa.alloc(u8, tlen) catch return;
                if ((file.readPositionalAll(i, b, toff) catch 0) != tlen) {
                    s.gpa.free(b);
                    continue;
                }
                w.* = b;
            }
        }
        // fonts with nothing to draw (e.g. bitmap formats we don't read)
        if (!has_outlines or name_t.len == 0) return;
        const f = otf.Font{ .data = &.{}, .tables = .{ .name = name_t, .os2 = os2_t, .head = head_t }, .units_per_em = 1000, .num_glyphs = 0, .num_hmetrics = 0, .loca_long = false };
        var nb: [256]u8 = undefined;
        const fam = f.familyName(&nb) orelse return;
        const p = s.gpa.dupe(u8, path) catch return;
        const fm = s.gpa.dupe(u8, fam) catch {
            s.gpa.free(p);
            return;
        };
        s.sys.append(s.gpa, .{ .path = p, .index = index, .family = fm, .weight = f.weight(), .italic = f.isItalic() }) catch {
            s.gpa.free(p);
            s.gpa.free(fm);
        };
    }

    fn loadSys(s: *PortableBackend, idx: usize) ?u32 {
        const e = &s.sys.items[idx];
        if (e.face) |f| return f;
        if (e.failed) return null;
        e.failed = true; // until it loads
        const i = s.io();
        const file = std.Io.Dir.cwd().openFile(i, e.path, .{}) catch return null;
        const len = file.length(i) catch {
            file.close(i);
            return null;
        };
        if (len == 0 or len > 1 << 31) {
            file.close(i);
            return null;
        }
        var mm = std.Io.File.MemoryMap.create(i, file, .{ .len = @intCast(len), .protection = .{ .read = true, .write = false }, .populate = false }) catch {
            file.close(i);
            return null;
        };
        mm.read(i) catch {
            mm.destroy(i);
            file.close(i);
            return null;
        };
        const fi = s.addFace(mm.memory, e.index, .{ .mapped = mm }, e.family) catch {
            mm.destroy(i);
            file.close(i);
            return null;
        };
        s.faces.items[fi].file = file;
        s.faces.items[fi].weight = e.weight;
        s.faces.items[fi].italic = e.italic;
        e.face = fi;
        e.failed = false;
        return fi;
    }

    // -----------------------------------------------------------------------
    // Fallback
    // -----------------------------------------------------------------------

    fn covers(s: *PortableBackend, fi: u32, cp: u21) bool {
        return s.faces.items[fi].font.glyphIndex(cp) != 0;
    }

    /// A face that has a glyph for `cp`, preferring `primary`. With `emoji`
    /// (emoji presentation), color fonts win over monochrome glyphs.
    fn faceFor(s: *PortableBackend, primary: ?u32, cp: u21, emoji: bool) ?u32 {
        if (primary) |p| if (s.covers(p, cp) and (!emoji or s.faces.items[p].font.hasColor())) return p;
        const key = @as(u32, cp) | (@as(u32, @intFromBool(emoji)) << 21);
        if (s.fallback.get(key)) |r| return r;
        const r = s.findFallback(cp, emoji) orelse if (primary) |p| (if (s.covers(p, cp)) p else null) else null;
        s.fallback.put(s.gpa, key, r) catch {};
        return r;
    }

    fn findFallback(s: *PortableBackend, cp: u21, emoji: bool) ?u32 {
        if (emoji) {
            for (s.faces.items, 0..) |f, i| if (f.font.hasColor() and s.covers(@intCast(i), cp)) return @intCast(i);
            for (platform.emoji) |fam| {
                if (s.findExact(fam, 400, false)) |fi| if (s.covers(fi, cp)) return fi;
            }
        }
        // loaded faces (registered fonts, already-used system fonts)
        for (s.faces.items, 0..) |_, i| if (s.covers(@intCast(i), cp)) return @intCast(i);
        // the platform's preferred fallback families, in order
        for (platform.fallback) |fam| {
            if (s.findExact(fam, 400, false)) |fi| if (s.covers(fi, cp)) return fi;
        }
        // finally every system font (regular faces first)
        s.scanSystem();
        for ([_]bool{ true, false }) |regular_pass| {
            for (s.sys.items, 0..) |e, i| {
                if (e.face != null or e.failed) continue;
                const regular = e.weight == 400 and !e.italic;
                if (regular != regular_pass) continue;
                const fi = s.loadSys(i) orelse continue;
                if (s.covers(fi, cp)) return fi;
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Metrics and shaping
    // -----------------------------------------------------------------------

    fn metrics(p: *anyopaque, id: FontId) font.Metrics {
        const s = me(p);
        const inst = s.instances.items[@min(id, s.instances.items.len - 1)];
        const fi = inst.face orelse return .{ .ascent = inst.size * 0.8, .descent = inst.size * 0.2, .x_height = inst.size * 0.5, .cap_height = inst.size * 0.7, .underline_pos = inst.size * 0.1, .underline_thickness = @max(1, inst.size / 14) };
        const f = &s.faces.items[fi].font;
        const k = inst.size / @as(f32, @floatFromInt(f.units_per_em));
        const m = f.vmetrics();
        return .{
            .ascent = @as(f32, @floatFromInt(m.ascent)) * k,
            .descent = @as(f32, @floatFromInt(m.descent)) * k,
            .line_gap = @as(f32, @floatFromInt(m.line_gap)) * k,
            .x_height = @as(f32, @floatFromInt(m.x_height)) * k,
            .cap_height = @as(f32, @floatFromInt(m.cap_height)) * k,
            .underline_pos = @as(f32, @floatFromInt(m.underline_pos)) * k,
            .underline_thickness = @max(0.5, @as(f32, @floatFromInt(m.underline_thickness)) * k),
        };
    }

    /// GPOS kern lookup indices, resolved once per face.
    fn kernLookups(s: *PortableBackend, f: *Face) []const u16 {
        if (f.kern) |l| return l;
        var buf: [64]u16 = undefined;
        const n = otf.Font.featureLookups(f.font.tables.gpos, otf.tag("kern"), &buf);
        const l = s.gpa.dupe(u16, buf[0..n]) catch return &.{};
        f.kern = l;
        return l;
    }

    const Unit = struct { cp: u21, cluster: u32, face: ?u32 };

    fn shape(p: *anyopaque, id: FontId, text: []const u8, out: *std.ArrayList(font.Glyph), gpa: Allocator) Allocator.Error!void {
        const s = me(p);
        if (text.len == 0) return;
        const inst = s.instances.items[@min(id, s.instances.items.len - 1)];
        // decode and pick a face per character
        var units: std.ArrayList(Unit) = .empty;
        defer units.deinit(gpa);
        var i: usize = 0;
        while (i < text.len) {
            const len = std.unicode.utf8ByteSequenceLength(text[i]) catch 1;
            const end = @min(text.len, i + len);
            const cp: u21 = std.unicode.utf8Decode(text[i..end]) catch 0xFFFD;
            // emoji presentation: default-emoji code points, or text-default
            // ones followed by VS16 (U+FE0F)
            const vs16 = std.mem.startsWith(u8, text[end..], "\u{FE0F}");
            const emoji = isEmojiPresentation(cp) or vs16;
            var face = s.faceFor(inst.face, cp, emoji);
            // combining marks stay with their base's font when it has them;
            // default-ignorables (ZWJ, variation selectors) always do
            if (units.items.len > 0) {
                const prev = units.items[units.items.len - 1].face;
                if (isDefaultIgnorable(cp)) {
                    face = prev;
                } else if (isMark(cp)) {
                    if (prev) |pf| if (s.covers(pf, cp)) {
                        face = pf;
                    };
                }
            }
            try units.append(gpa, .{ .cp = cp, .cluster = @intCast(i), .face = face orelse inst.face });
            i = end;
        }
        // shape each run of one face
        var start: usize = 0;
        while (start < units.items.len) {
            var end = start + 1;
            while (end < units.items.len and units.items[end].face == units.items[start].face) end += 1;
            try s.shapeRun(units.items[start..end], inst, out, gpa);
            start = end;
        }
    }

    fn shapeRun(s: *PortableBackend, run: []const Unit, primary: Instance, out: *std.ArrayList(font.Glyph), gpa: Allocator) Allocator.Error!void {
        const fi = run[0].face orelse {
            // no font at all: boxes so layout still works
            for (run) |u| try out.append(gpa, .{ .id = 0, .font = 0, .advance = primary.size * 0.5, .cluster = u.cluster });
            return;
        };
        const face = s.faces.items[fi];
        const f = &face.font;
        const same = primary.face != null and primary.face.? == fi;
        const fid = if (same) s.instance(fi, primary.size, primary.synth_bold, primary.synth_italic) else s.instance(fi, primary.size, false, false);
        const k = primary.size / @as(f32, @floatFromInt(f.units_per_em));

        var buf: otf.GlyphBuf = .{};
        defer buf.deinit(gpa);
        for (run) |u| {
            try buf.gids.append(gpa, f.glyphIndex(u.cp));
            try buf.clusters.append(gpa, u.cluster);
        }
        // GSUB: composition (ccmp: emoji sequences, accents), required and
        // common ligatures, contextual alternates -- the browser defaults
        try otf.applyGsub(gpa, f.tables.gsub, &otf.default_gsub_features, &buf);
        // default-ignorables the font didn't consume are invisible, not boxes
        {
            var w: usize = 0;
            for (buf.gids.items, buf.clusters.items) |g, c| {
                if (g == 0 and isDefaultIgnorable(cpAt(run, c))) continue;
                buf.gids.items[w] = g;
                buf.clusters.items[w] = c;
                w += 1;
            }
            buf.gids.shrinkRetainingCapacity(w);
            buf.clusters.shrinkRetainingCapacity(w);
        }
        const gids = buf.gids;
        const clusters = buf.clusters;

        // advances + kerning
        const first = out.items.len;
        for (gids.items, clusters.items) |g, c| {
            try out.append(gpa, .{ .id = g, .font = fid, .advance = @as(f32, @floatFromInt(f.advance(g))) * k, .cluster = c });
        }
        const glyphs = out.items[first..];
        const kern = s.kernLookups(face);
        if (glyphs.len > 1) {
            for (0..glyphs.len - 1) |gi| {
                const a = glyphs[gi].id;
                const b = glyphs[gi + 1].id;
                var adj: i32 = 0;
                var placement: i32 = 0;
                if (kern.len > 0) {
                    for (kern) |li| {
                        var subs: [64][]const u8 = undefined;
                        const l = otf.Font.lookup(f.tables.gpos, li, 9, &subs);
                        if (l.kind != 2) continue;
                        for (subs[0..l.n]) |st| if (otf.pairAdjust(st, a, b)) |pa| {
                            adj += pa.first_advance;
                            placement += pa.second_placement;
                            break;
                        };
                    }
                } else if (f.tables.kern.len > 0) {
                    adj = otf.legacyKern(f.tables.kern, a, b);
                }
                glyphs[gi].advance += @as(f32, @floatFromInt(adj)) * k;
                glyphs[gi + 1].x_offset += @as(f32, @floatFromInt(placement)) * k;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Rasterization
    // -----------------------------------------------------------------------

    fn rasterize(p: *anyopaque, id: FontId, glyph: u32, scale: f32, subpixel: f32) ?font.GlyphBitmap {
        const s = me(p);
        const inst = s.instances.items[@min(id, s.instances.items.len - 1)];
        const fi = inst.face orelse return null;
        const f = &s.faces.items[fi].font;
        const px_size = inst.size * scale;
        if (f.tables.cbdt.len > 0 and f.tables.cblc.len > 0) {
            if (otf.cbdtGlyph(f.tables.cblc, f.tables.cbdt, glyph, px_size)) |bg| return s.rasterizeBitmap(bg, px_size);
        }
        if (f.tables.sbix.len > 0) {
            if (otf.sbixGlyph(f.tables.sbix, f.num_glyphs, glyph, px_size)) |bg| return s.rasterizeBitmap(bg, px_size);
        }
        if (f.tables.colr.len > 0 and f.tables.cpal.len > 0) {
            var layers: [64]otf.ColorLayer = undefined;
            const n = otf.colrLayers(f.tables.colr, glyph, &layers);
            if (n > 0) return s.rasterizeColor(inst, f, layers[0..n], scale, subpixel);
        }
        s.path.clear();
        f.outline(s.gpa, glyph, &s.path) catch return null;
        if (s.path.isEmpty()) return null;
        const k = inst.size * scale / @as(f32, @floatFromInt(f.units_per_em));
        // font units (y up) -> device px relative to the pen, y down
        var t = raster.Affine{ .a = k, .d = -k, .e = subpixel };
        if (inst.synth_italic) t.c = -0.2 * k; // ~11.3° oblique
        const embolden: f32 = if (inst.synth_bold) @max(0.5, inst.size * scale / 28) else 0;
        const b = s.path.bounds(t) orelse return null;
        const pad: f32 = 1;
        const x0 = @floor(b[0]) - pad;
        const y0 = @floor(b[1]) - pad;
        const x1 = @ceil(b[2] + embolden) + pad;
        const y1 = @ceil(b[3]) + pad;
        const w: u32 = @intFromFloat(@max(1, x1 - x0));
        const h: u32 = @intFromFloat(@max(1, y1 - y0));
        if (w > 2048 or h > 2048) return null;
        var r = raster.Rasterizer.init(s.gpa, w, h) catch return null;
        defer r.deinit(s.gpa);
        const to_bitmap = t.then(raster.Affine.translate(-x0, -y0));
        r.fill(&s.path, to_bitmap);
        // synthetic bold: overstrike shifted copies (union under non-zero)
        if (embolden > 0) {
            r.fill(&s.path, to_bitmap.then(raster.Affine.translate(embolden * 0.5, 0)));
            r.fill(&s.path, to_bitmap.then(raster.Affine.translate(embolden, 0)));
        }
        s.bitmap.resize(s.gpa, @as(usize, w) * h) catch return null;
        r.coverage(s.bitmap.items, .nonzero);
        return .{
            .width = w,
            .height = h,
            .left = @intFromFloat(x0),
            .top = @intFromFloat(-y0), // y0 is device-down; top is up from the baseline
            .channels = 1,
            .pixels = s.bitmap.items,
        };
    }

    /// COLR v0: draw each layer's outline in its palette color, bottom to
    /// top, into premultiplied BGRA.
    fn rasterizeColor(s: *PortableBackend, inst: Instance, f: *const otf.Font, layers: []const otf.ColorLayer, scale: f32, subpixel: f32) ?font.GlyphBitmap {
        const k = inst.size * scale / @as(f32, @floatFromInt(f.units_per_em));
        const t = raster.Affine{ .a = k, .d = -k, .e = subpixel };
        // union of the layers' bounds
        var b = [4]f32{ std.math.inf(f32), std.math.inf(f32), -std.math.inf(f32), -std.math.inf(f32) };
        for (layers) |l| {
            s.path.clear();
            f.outline(s.gpa, l.glyph, &s.path) catch continue;
            const lb = s.path.bounds(t) orelse continue;
            b = .{ @min(b[0], lb[0]), @min(b[1], lb[1]), @max(b[2], lb[2]), @max(b[3], lb[3]) };
        }
        if (!(b[2] > b[0] and b[3] > b[1])) return null;
        const x0 = @floor(b[0]) - 1;
        const y0 = @floor(b[1]) - 1;
        const w: u32 = @intFromFloat(@ceil(b[2]) + 1 - x0);
        const h: u32 = @intFromFloat(@ceil(b[3]) + 1 - y0);
        if (w > 2048 or h > 2048) return null;
        const n = @as(usize, w) * h;
        s.bitmap.resize(s.gpa, n * 4 + n) catch return null;
        const bgra = s.bitmap.items[0 .. n * 4];
        const cov = s.bitmap.items[n * 4 ..];
        @memset(bgra, 0);
        var r = raster.Rasterizer.init(s.gpa, w, h) catch return null;
        defer r.deinit(s.gpa);
        const to_bitmap = t.then(raster.Affine.translate(-x0, -y0));
        for (layers) |l| {
            // 0xFFFF = text color; color bitmaps don't carry it, so use black
            const c = if (l.palette_index == 0xFFFF) [4]u8{ 0, 0, 0, 255 } else (otf.paletteColor(f.tables.cpal, l.palette_index) orelse continue);
            s.path.clear();
            f.outline(s.gpa, l.glyph, &s.path) catch continue;
            r.reset();
            r.fill(&s.path, to_bitmap);
            r.coverage(cov, .nonzero);
            const ca = @as(f32, @floatFromInt(c[3])) / 255;
            for (0..n) |i| {
                const a = @as(f32, @floatFromInt(cov[i])) / 255 * ca;
                if (a <= 0) continue;
                const px = bgra[i * 4 ..][0..4];
                const keep = 1 - a;
                // source-over, premultiplied, BGRA order
                px[0] = @intFromFloat(@round(@as(f32, @floatFromInt(c[2])) * a + @as(f32, @floatFromInt(px[0])) * keep));
                px[1] = @intFromFloat(@round(@as(f32, @floatFromInt(c[1])) * a + @as(f32, @floatFromInt(px[1])) * keep));
                px[2] = @intFromFloat(@round(@as(f32, @floatFromInt(c[0])) * a + @as(f32, @floatFromInt(px[2])) * keep));
                px[3] = @intFromFloat(@round(255 * a + @as(f32, @floatFromInt(px[3])) * keep));
            }
        }
        return .{ .width = w, .height = h, .left = @intFromFloat(x0), .top = @intFromFloat(-y0), .channels = 4, .pixels = bgra };
    }

    /// Embedded PNG glyph (CBDT/sbix): decode, scale from the strike's ppem to
    /// the requested pixel size with an area filter, convert to BGRA.
    fn rasterizeBitmap(s: *PortableBackend, bg: otf.BitmapGlyph, px_size: f32) ?font.GlyphBitmap {
        const img = png.decode(s.gpa, bg.png) orelse return null;
        defer s.gpa.free(img.px);
        const k = px_size / @as(f32, @floatFromInt(@max(1, bg.ppem)));
        const w: u32 = @intFromFloat(@max(1, @round(@as(f32, @floatFromInt(img.w)) * k)));
        const h: u32 = @intFromFloat(@max(1, @round(@as(f32, @floatFromInt(img.h)) * k)));
        if (w > 2048 or h > 2048) return null;
        s.bitmap.resize(s.gpa, @as(usize, w) * h * 4) catch return null;
        resampleToBgra(img.px, img.w, img.h, s.bitmap.items, w, h);
        const left: i32 = @intFromFloat(@round(@as(f32, @floatFromInt(bg.bearing_x)) * k));
        const top: i32 = if (bg.origin_is_bottom)
            @as(i32, @intFromFloat(@round(@as(f32, @floatFromInt(bg.bearing_y)) * k))) + @as(i32, @intCast(h))
        else
            @intFromFloat(@round(@as(f32, @floatFromInt(bg.bearing_y)) * k));
        return .{ .width = w, .height = h, .left = left, .top = top, .channels = 4, .pixels = s.bitmap.items };
    }

    fn isColor(p: *anyopaque, id: FontId) bool {
        const s = me(p);
        const inst = s.instances.items[@min(id, s.instances.items.len - 1)];
        const fi = inst.face orelse return false;
        return s.faces.items[fi].font.hasColor();
    }
};

/// Area-averaging resample of premultiplied RGBA into premultiplied BGRA.
/// Each destination pixel averages the source area it covers, so large
/// strike bitmaps shrink without aliasing (and grow with nearest-area).
fn resampleToBgra(src: []const u8, sw: u32, sh: u32, dst: []u8, dw: u32, dh: u32) void {
    const fx = @as(f32, @floatFromInt(sw)) / @as(f32, @floatFromInt(dw));
    const fy = @as(f32, @floatFromInt(sh)) / @as(f32, @floatFromInt(dh));
    for (0..dh) |y| {
        const y0 = @as(f32, @floatFromInt(y)) * fy;
        const y1 = y0 + fy;
        for (0..dw) |x| {
            const x0 = @as(f32, @floatFromInt(x)) * fx;
            const x1 = x0 + fx;
            var acc = [4]f32{ 0, 0, 0, 0 };
            var wsum: f32 = 0;
            var sy: u32 = @intFromFloat(@floor(y0));
            while (sy < sh and @as(f32, @floatFromInt(sy)) < y1) : (sy += 1) {
                const wy = @min(y1, @as(f32, @floatFromInt(sy + 1))) - @max(y0, @as(f32, @floatFromInt(sy)));
                if (wy <= 0) continue;
                var sx: u32 = @intFromFloat(@floor(x0));
                while (sx < sw and @as(f32, @floatFromInt(sx)) < x1) : (sx += 1) {
                    const wx = @min(x1, @as(f32, @floatFromInt(sx + 1))) - @max(x0, @as(f32, @floatFromInt(sx)));
                    if (wx <= 0) continue;
                    const wgt = wx * wy;
                    const i = (@as(usize, sy) * sw + sx) * 4;
                    for (0..4) |c| acc[c] += @as(f32, @floatFromInt(src[i + c])) * wgt;
                    wsum += wgt;
                }
            }
            const o = (@as(usize, y) * dw + x) * 4;
            const inv: f32 = if (wsum > 0) 1 / wsum else 0;
            // RGBA -> BGRA
            dst[o + 0] = @intFromFloat(@round(std.math.clamp(acc[2] * inv, 0, 255)));
            dst[o + 1] = @intFromFloat(@round(std.math.clamp(acc[1] * inv, 0, 255)));
            dst[o + 2] = @intFromFloat(@round(std.math.clamp(acc[0] * inv, 0, 255)));
            dst[o + 3] = @intFromFloat(@round(std.math.clamp(acc[3] * inv, 0, 255)));
        }
    }
}

fn matchScore(have_w: u16, have_italic: bool, want_w: u16, want_italic: bool) i32 {
    // italic mismatch dominates; then CSS-like weight preference
    var sc: i32 = if (have_italic != want_italic) 10000 else 0;
    const hw: i32 = have_w;
    const ww: i32 = want_w;
    const d = hw - ww;
    if (d == 0) return sc;
    if (ww == 400 and hw == 500) return sc + 1;
    if (ww == 500 and hw == 400) return sc + 1;
    // lighter wanted (< 400): prefer lighter; heavier wanted (> 500): prefer heavier
    const prefer_heavier = ww > 500;
    if ((d > 0) == prefer_heavier) sc += @intCast(@abs(d)) else sc += 1000 + @as(i32, @intCast(@abs(d)));
    return sc;
}

/// Code points that default to emoji presentation (the common blocks; text-
/// default symbols become emoji when followed by VS16).
fn isEmojiPresentation(cp: u21) bool {
    return (cp >= 0x1F300 and cp <= 0x1F5FF) or (cp >= 0x1F600 and cp <= 0x1F64F) or (cp >= 0x1F680 and cp <= 0x1F6FF) or
        (cp >= 0x1F900 and cp <= 0x1FAFF) or (cp >= 0x1F1E6 and cp <= 0x1F1FF) or cp == 0x1F004 or cp == 0x1F0CF or
        cp == 0x2705 or cp == 0x274C or cp == 0x2728 or cp == 0x2B50 or cp == 0x23F0 or cp == 0x231A or cp == 0x231B;
}

/// Default_Ignorable_Code_Point (the ranges that occur in practice).
fn isDefaultIgnorable(cp: u21) bool {
    return cp == 0xAD or cp == 0x034F or cp == 0x061C or (cp >= 0x115F and cp <= 0x1160) or (cp >= 0x17B4 and cp <= 0x17B5) or
        (cp >= 0x180B and cp <= 0x180F) or (cp >= 0x200B and cp <= 0x200F) or (cp >= 0x202A and cp <= 0x202E) or
        (cp >= 0x2060 and cp <= 0x206F) or cp == 0x3164 or (cp >= 0xFE00 and cp <= 0xFE0F) or cp == 0xFEFF or cp == 0xFFA0 or
        (cp >= 0x1BCA0 and cp <= 0x1BCA3) or (cp >= 0x1D173 and cp <= 0x1D17A) or (cp >= 0xE0000 and cp <= 0xE0FFF);
}

fn cpAt(run: []const PortableBackend.Unit, cluster: u32) u21 {
    for (run) |u| if (u.cluster == cluster) return u.cp;
    return 0;
}

fn isMark(cp: u21) bool {
    return (cp >= 0x0300 and cp <= 0x036F) or (cp >= 0x1AB0 and cp <= 0x1AFF) or (cp >= 0x1DC0 and cp <= 0x1DFF) or
        (cp >= 0x20D0 and cp <= 0x20FF) or (cp >= 0xFE20 and cp <= 0xFE2F) or cp == 0x200D or (cp >= 0xFE00 and cp <= 0xFE0F);
}

fn generic(name: []const u8) ?[]const []const u8 {
    const eq = std.ascii.eqlIgnoreCase;
    if (eq(name, "sans-serif") or eq(name, "system-ui") or eq(name, "ui-sans-serif") or eq(name, "-apple-system") or eq(name, "BlinkMacSystemFont") or eq(name, "ui-rounded") or eq(name, "cursive") or eq(name, "fantasy")) return platform.sans;
    if (eq(name, "serif") or eq(name, "ui-serif")) return platform.serif;
    if (eq(name, "monospace") or eq(name, "ui-monospace")) return platform.mono;
    if (eq(name, "emoji")) return platform.emoji;
    return null;
}

/// Per-platform font directories and default/fallback family lists.
const platform = switch (builtin.os.tag) {
    .windows => struct {
        const sans: []const []const u8 = &.{ "Segoe UI", "Arial" };
        const serif: []const []const u8 = &.{ "Times New Roman", "Georgia" };
        const mono: []const []const u8 = &.{ "Cascadia Mono", "Consolas", "Courier New" };
        const emoji: []const []const u8 = &.{ "Segoe UI Emoji", "Segoe UI Symbol" };
        const fallback: []const []const u8 = &.{ "Segoe UI", "Segoe UI Symbol", "Segoe UI Emoji", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", "Nirmala UI", "Leelawadee UI", "Ebrima", "Gadugi", "Segoe UI Historic", "Arial Unicode MS", "Arial" };
        fn fontDirs(buf: *[8][512]u8, out: *[8][]const u8) usize {
            var n: usize = 0;
            if (envDir(&buf[n], "WINDIR", "Fonts")) |d| {
                out[n] = d;
                n += 1;
            }
            if (envDir(&buf[n], "LOCALAPPDATA", "Microsoft\\Windows\\Fonts")) |d| {
                out[n] = d;
                n += 1;
            }
            return n;
        }
    },
    .macos => struct {
        const sans: []const []const u8 = &.{ "Helvetica Neue", "Helvetica", "Arial" };
        const serif: []const []const u8 = &.{ "Times New Roman", "Times", "Georgia" };
        const mono: []const []const u8 = &.{ "Menlo", "Monaco", "Courier New" };
        const emoji: []const []const u8 = &.{"Apple Color Emoji"};
        const fallback: []const []const u8 = &.{ "Helvetica Neue", "Apple Symbols", "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", "Arial Unicode MS", "STIXGeneral" };
        fn fontDirs(buf: *[8][512]u8, out: *[8][]const u8) usize {
            out[0] = "/System/Library/Fonts";
            out[1] = "/Library/Fonts";
            var n: usize = 2;
            if (envDir(&buf[0], "HOME", "Library/Fonts")) |d| {
                out[n] = d;
                n += 1;
            }
            return n;
        }
    },
    else => struct {
        const sans: []const []const u8 = &.{ "Noto Sans", "DejaVu Sans", "Liberation Sans", "Ubuntu", "Cantarell", "Roboto" };
        const serif: []const []const u8 = &.{ "Noto Serif", "DejaVu Serif", "Liberation Serif" };
        const mono: []const []const u8 = &.{ "Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono" };
        const emoji: []const []const u8 = &.{"Noto Color Emoji"};
        const fallback: []const []const u8 = &.{ "Noto Sans", "DejaVu Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans Symbols", "Noto Sans Symbols2", "FreeSans", "Symbola" };
        fn fontDirs(buf: *[8][512]u8, out: *[8][]const u8) usize {
            out[0] = "/usr/share/fonts";
            out[1] = "/usr/local/share/fonts";
            var n: usize = 2;
            if (envDir(&buf[0], "HOME", ".local/share/fonts")) |d| {
                out[n] = d;
                n += 1;
            }
            if (envDir(&buf[1], "HOME", ".fonts")) |d| {
                out[n] = d;
                n += 1;
            }
            return n;
        }
    },
};

fn envDir(buf: *[512]u8, name: [:0]const u8, suffix: []const u8) ?[]const u8 {
    const v = std.c.getenv(name) orelse return null;
    const base = std.mem.span(v);
    const sep = if (builtin.os.tag == .windows) "\\" else "/";
    return std.fmt.bufPrint(buf, "{s}{s}{s}", .{ base, sep, suffix }) catch null;
}

// ---------------------------------------------------------------------------
// Tests (hermetic: bundled fonts only)
// ---------------------------------------------------------------------------

const testdata = @import("testdata");

fn testBackend() !font.Backend {
    const b = try PortableBackend.create(std.testing.allocator, .{ .system_fonts = false });
    const s = PortableBackend.me(b.ptr);
    try s.addBorrowed(testdata.fonts.roboto);
    try s.addBorrowed(testdata.fonts.source_sans);
    return b;
}

test "resolve families, generic fallback and synthetic styles" {
    const b = try testBackend();
    defer b.deinit();
    const s = PortableBackend.me(b.ptr);
    const roboto = b.resolve(.{ .families = &.{"Roboto"}, .size = 16 });
    const ss = b.resolve(.{ .families = &.{ "Missing Font", "Source Sans 3" }, .size = 16 });
    try std.testing.expect(roboto != ss);
    try std.testing.expect(s.instances.items[roboto].face.? != s.instances.items[ss].face.?);
    // bold/italic requests on regular-only families synthesize
    const bold = b.resolve(.{ .families = &.{"Roboto"}, .size = 16, .weight = 700 });
    try std.testing.expect(s.instances.items[bold].synth_bold);
    const it = b.resolve(.{ .families = &.{"Roboto"}, .size = 16, .italic = true });
    try std.testing.expect(s.instances.items[it].synth_italic);
    // same spec -> same id
    try std.testing.expectEqual(roboto, b.resolve(.{ .families = &.{"roboto"}, .size = 16 }));
}

test "shaping matches HarfBuzz advances (kerning) and ligatures" {
    const gpa = std.testing.allocator;
    const b = try testBackend();
    defer b.deinit();
    var out: std.ArrayList(font.Glyph) = .empty;
    defer out.deinit(gpa);
    // Roboto at upem size: advances are font units
    const r = b.resolve(.{ .families = &.{"Roboto"}, .size = 2048 });
    try b.shape(r, "AVATAR Wavy é Ω", &out, gpa);
    const want = [_]f32{ 1249, 1228, 1207, 1143, 1336, 1261, 507, 1784, 1099, 992, 969, 507, 1085, 507, 1362 };
    try std.testing.expectEqual(want.len, out.items.len);
    for (want, out.items) |w, g| try std.testing.expectApproxEqAbs(w, g.advance, 0.01);
    try std.testing.expectEqual(@as(u32, 225), out.items[12].id); // é
    try std.testing.expectEqual(@as(u32, 12), out.items[12].cluster); // byte offset
    try std.testing.expectEqual(@as(u32, 15), out.items[14].cluster); // Ω after the 2-byte é and a space
    // Source Sans: "ff" ligature, cluster of the first f
    out.clearRetainingCapacity();
    const ss = b.resolve(.{ .families = &.{"Source Sans 3"}, .size = 1000 });
    try b.shape(ss, "office", &out, gpa);
    try std.testing.expectEqual(@as(usize, 5), out.items.len);
    try std.testing.expectEqual(@as(u32, 57), out.items[1].id);
    try std.testing.expectEqual(@as(u32, 1), out.items[1].cluster);
    try std.testing.expectEqual(@as(u32, 3), out.items[2].cluster);
}

test "fallback picks a face that covers the character" {
    const gpa = std.testing.allocator;
    const b = try testBackend();
    defer b.deinit();
    var out: std.ArrayList(font.Glyph) = .empty;
    defer out.deinit(gpa);
    // Source Sans subset has no Greek; Roboto does
    const ss = b.resolve(.{ .families = &.{"Source Sans 3"}, .size = 16 });
    try b.shape(ss, "AΩ", &out, gpa);
    try std.testing.expectEqual(@as(usize, 2), out.items.len);
    try std.testing.expect(out.items[0].font != out.items[1].font);
    const s = PortableBackend.me(b.ptr);
    var nb: [64]u8 = undefined;
    const fb = s.instances.items[out.items[1].font].face.?;
    try std.testing.expectEqualStrings("Roboto", s.faces.items[fb].font.familyName(&nb).?);
    try std.testing.expect(out.items[1].id != 0);
}

test "metrics scale with size" {
    const b = try testBackend();
    defer b.deinit();
    const r = b.resolve(.{ .families = &.{"Roboto"}, .size = 20.48 });
    const m = b.metrics(r);
    try std.testing.expectApproxEqAbs(@as(f32, 21.46), m.ascent, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 5.55), m.descent, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 10.82), m.x_height, 0.01);
}

test "rasterized glyphs sit on the baseline with the expected ink" {
    const b = try testBackend();
    defer b.deinit();
    const r = b.resolve(.{ .families = &.{"Roboto"}, .size = 48 });
    const s = PortableBackend.me(b.ptr);
    const gid = s.faces.items[s.instances.items[r].face.?].font.glyphIndex('H');
    const bm = b.rasterize(r, gid, 1, 0).?;
    // cap height 1456/2048 * 48 = 34.1 px above the baseline
    try std.testing.expect(bm.top >= 34 and bm.top <= 36);
    try std.testing.expectEqual(@as(u8, 1), bm.channels);
    // the bottom row of ink is at the baseline: last bitmap row (pad) empty, one above has ink
    var ink_rows: u32 = 0;
    for (0..bm.height) |y| {
        var any = false;
        for (0..bm.width) |x| if (bm.pixels[y * bm.width + x] > 128) {
            any = true;
        };
        if (any) ink_rows += 1;
    }
    try std.testing.expect(ink_rows >= 33 and ink_rows <= 35);
    // a stem of H is fully covered somewhere
    var max: u8 = 0;
    for (bm.pixels) |v| max = @max(max, v);
    try std.testing.expectEqual(@as(u8, 255), max);
}

test "COLR glyphs rasterize as layered color, others as coverage" {
    const gpa = std.testing.allocator;
    const b = try PortableBackend.create(gpa, .{ .system_fonts = false });
    defer b.deinit();
    const s = PortableBackend.me(b.ptr);
    try s.addBorrowed(testdata.fonts.color_test);
    const id = b.resolve(.{ .families = &.{"Color Test"}, .size = 64 });
    try std.testing.expect(b.isColor(id));
    const f = &s.faces.items[s.instances.items[id].face.?].font;
    // 'A': red O underneath, blue A on top
    const bm = b.rasterize(id, f.glyphIndex('A'), 1, 0).?;
    try std.testing.expectEqual(@as(u8, 4), bm.channels);
    var saw_red = false;
    var saw_blue = false;
    for (0..@as(usize, bm.width) * bm.height) |i| {
        const px = bm.pixels[i * 4 ..][0..4]; // B G R A
        if (px[3] == 255 and px[2] == 255 and px[0] == 0) saw_red = true;
        if (px[3] == 255 and px[0] == 255 and px[2] == 0) saw_blue = true;
        try std.testing.expect(px[0] <= px[3] and px[1] <= px[3] and px[2] <= px[3]); // premultiplied
    }
    try std.testing.expect(saw_red and saw_blue);
    // 'H': one 50% green layer
    const hm = b.rasterize(id, f.glyphIndex('H'), 1, 0).?;
    var max_a: u8 = 0;
    for (0..@as(usize, hm.width) * hm.height) |i| max_a = @max(max_a, hm.pixels[i * 4 + 3]);
    try std.testing.expectEqual(@as(u8, 128), max_a);
    // glyphs without color layers stay coverage masks
    const vm = b.rasterize(id, f.glyphIndex('V'), 1, 0).?;
    try std.testing.expectEqual(@as(u8, 1), vm.channels);
}

test "system fonts: discover, resolve generic families, shape and rasterize" {
    // Runs against the real fonts of whatever OS the tests run on (CI covers
    // macOS, Windows and Linux), so discovery and parsing of the platform's
    // actual font files are exercised, not just the bundled fixtures.
    const gpa = std.testing.allocator;
    const b = try PortableBackend.create(gpa, .{});
    defer b.deinit();
    const s = PortableBackend.me(b.ptr);
    s.scanSystem();
    if (s.sys.items.len == 0) return error.SkipZigTest; // minimal containers
    var out: std.ArrayList(font.Glyph) = .empty;
    defer out.deinit(gpa);
    for ([_][]const u8{ "sans-serif", "serif", "monospace" }) |generic_name| {
        const id = b.resolve(.{ .families = &.{generic_name}, .size = 16 });
        const fi = s.instances.items[id].face orelse return error.NoFontResolved;
        var nb: [128]u8 = undefined;
        std.debug.print("  {s} -> {s} ({d} system faces)\n", .{ generic_name, s.faces.items[fi].font.familyName(&nb) orelse "?", s.sys.items.len });
        out.clearRetainingCapacity();
        try b.shape(id, "Hello, world", &out, gpa);
        try std.testing.expectEqual(@as(usize, 12), out.items.len);
        for (out.items) |g| {
            if (g.cluster == 5 or g.cluster == 6) continue; // ',' and ' '
            try std.testing.expect(g.id != 0); // real glyphs, not .notdef
            try std.testing.expect(g.advance > 2 and g.advance < 16);
        }
        const bm = b.rasterize(out.items[0].font, out.items[0].id, 2, 0) orelse return error.NoBitmap;
        var ink: u32 = 0;
        for (bm.pixels[0 .. @as(usize, bm.width) * bm.height * bm.channels]) |v| ink += v;
        try std.testing.expect(ink > 0);
    }
}

test "emoji: color bitmap fallback, scaled to the text size" {
    const gpa = std.testing.allocator;
    const b = try testBackend();
    defer b.deinit();
    const s = PortableBackend.me(b.ptr);
    try s.addBorrowed(testdata.fonts.noto_emoji);
    var out: std.ArrayList(font.Glyph) = .empty;
    defer out.deinit(gpa);
    const id = b.resolve(.{ .families = &.{"Roboto"}, .size = 32 });
    try b.shape(id, "a\u{1F600}\u{2764}\u{FE0F}", &out, gpa);
    try std.testing.expect(out.items.len >= 3);
    const emoji_font = out.items[1].font;
    try std.testing.expect(emoji_font != out.items[0].font);
    try std.testing.expect(b.isColor(emoji_font));
    try std.testing.expectEqual(emoji_font, out.items[2].font); // ❤ + VS16 -> emoji font too
    // 136x128 at 109 ppem scaled to 32 px: about 40x38, top ~30 px above the baseline
    const bm = b.rasterize(emoji_font, out.items[1].id, 1, 0).?;
    try std.testing.expectEqual(@as(u8, 4), bm.channels);
    try std.testing.expect(bm.width >= 38 and bm.width <= 42);
    try std.testing.expect(bm.height >= 36 and bm.height <= 40);
    try std.testing.expect(bm.top >= 28 and bm.top <= 31);
    // opaque yellow-ish face pixels in the middle (BGRA)
    const mid = (@as(usize, bm.height / 2) * bm.width + bm.width / 2) * 4;
    try std.testing.expect(bm.pixels[mid + 3] > 200 and bm.pixels[mid + 2] > 150);
    // advance comes from hmtx, scaled to the font size
    const ef = &s.faces.items[s.instances.items[emoji_font].face.?].font;
    const want = @as(f32, @floatFromInt(ef.advance(out.items[1].id))) * 32 / @as(f32, @floatFromInt(ef.units_per_em));
    try std.testing.expectApproxEqAbs(want, out.items[1].advance, 0.001);
}

test "emoji sequences compose via GSUB ccmp (matches HarfBuzz)" {
    const gpa = std.testing.allocator;
    const b = try PortableBackend.create(gpa, .{ .system_fonts = false });
    defer b.deinit();
    const s = PortableBackend.me(b.ptr);
    try s.addBorrowed(testdata.fonts.noto_emoji);
    const id = b.resolve(.{ .families = &.{"Noto Color Emoji"}, .size = 2048 });
    var out: std.ArrayList(font.Glyph) = .empty;
    defer out.deinit(gpa);
    const cases = [_]struct { text: []const u8, gid: u32 }{
        .{ .text = "\u{1F1E8}\u{1F1E6}", .gid = 13 }, // flag: regional indicator pair
        .{ .text = "\u{1F44D}\u{1F3FD}", .gid = 15 }, // skin tone modifier
        .{ .text = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", .gid = 22 }, // ZWJ family
        .{ .text = "\u{2764}\u{FE0F}", .gid = 2 }, // VS16 drops
        .{ .text = "\u{1F600}", .gid = 10 },
    };
    for (cases) |c| {
        out.clearRetainingCapacity();
        try b.shape(id, c.text, &out, gpa);
        try std.testing.expectEqual(@as(usize, 1), out.items.len);
        try std.testing.expectEqual(c.gid, out.items[0].id);
        try std.testing.expectEqual(@as(u32, 0), out.items[0].cluster);
        try std.testing.expectApproxEqAbs(@as(f32, 2550), out.items[0].advance, 0.01);
    }
}

test "missing fonts degrade to boxes without crashing" {
    const gpa = std.testing.allocator;
    const b = try PortableBackend.create(gpa, .{ .system_fonts = false });
    defer b.deinit();
    const id = b.resolve(.{ .families = &.{"Nothing"}, .size = 10 });
    var out: std.ArrayList(font.Glyph) = .empty;
    defer out.deinit(gpa);
    try b.shape(id, "abc", &out, gpa);
    try std.testing.expectEqual(@as(usize, 3), out.items.len);
    try std.testing.expectApproxEqAbs(@as(f32, 5), out.items[0].advance, 0.01);
    try std.testing.expect(b.rasterize(id, 0, 1, 0) == null);
    _ = b.metrics(id);
}
