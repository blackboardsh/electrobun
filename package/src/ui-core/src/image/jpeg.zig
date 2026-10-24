//! JPEG decoder: baseline and extended sequential (SOF0/SOF1) and
//! progressive (SOF2) Huffman-coded images with 1 (grayscale) or 3
//! components, any sampling factors, restart intervals, and EXIF
//! orientation. Arithmetic coding, lossless, hierarchical and 4-component
//! (CMYK/YCCK) images are rejected (decode returns null).
//!
//! All coefficients are stored per block and transformed once the last
//! scan is read, so baseline images go through the same path as
//! progressive ones. Chroma is upsampled with a triangle filter (libjpeg's
//! "fancy" upsampling) and converted from YCbCr with the JFIF matrix.
const std = @import("std");
const common = @import("common.zig");
const Allocator = std.mem.Allocator;
const Decoded = common.Decoded;
const Cursor = common.Cursor;

pub fn isJpeg(data: []const u8) bool {
    return data.len >= 3 and data[0] == 0xFF and data[1] == 0xD8 and data[2] == 0xFF;
}

pub fn decode(gpa: Allocator, data: []const u8) ?Decoded {
    var d = Decoder{ .gpa = gpa, .data = data };
    defer d.deinit();
    return d.run() catch null;
}

const Error = error{ Invalid, Unsupported, Truncated, OutOfMemory };

/// Zig-zag scan position -> natural (row-major) position in an 8x8 block.
const zigzag = [64]u8{
    0,  1,  8,  16, 9,  2,  3,  10, 17, 24, 32, 25, 18, 11, 4,  5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6,  7,  14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
};

const Huffman = struct {
    /// per code length 1..16: smallest code, number of codes, index of first value
    mincode: [17]i32 = @splat(0),
    maxcode: [18]i32 = @splat(-1),
    valptr: [17]i32 = @splat(0),
    values: [256]u8 = @splat(0),
    defined: bool = false,

    fn build(h: *Huffman, counts: *const [16]u8, values: []const u8) Error!void {
        var code: i32 = 0;
        var k: i32 = 0;
        for (1..17) |len| {
            const n: i32 = counts[len - 1];
            h.valptr[len] = k;
            h.mincode[len] = code;
            code += n;
            k += n;
            h.maxcode[len] = if (n > 0) code - 1 else -1;
            // codes must fit in `len` bits
            if (code > (@as(i32, 1) << @intCast(len))) return error.Invalid;
            code <<= 1;
        }
        h.maxcode[17] = std.math.maxInt(i32);
        if (values.len > 256) return error.Invalid;
        @memcpy(h.values[0..values.len], values);
        h.defined = true;
    }
};

const Component = struct {
    id: u8,
    h: u8,
    v: u8,
    tq: u8,
    td: u8 = 0,
    ta: u8 = 0,
    /// blocks per line / column, padded to whole MCUs
    bw: usize = 0,
    bh: usize = 0,
    /// unpadded blocks needed to cover the component's own extent
    bw_used: usize = 0,
    bh_used: usize = 0,
    coeffs: []i16 = &.{},
    dc_pred: i32 = 0,
};

const BitReader = struct {
    data: []const u8,
    pos: usize,
    acc: u32 = 0,
    nbits: u32 = 0,
    marker: bool = false,

    fn fill(b: *BitReader) void {
        while (b.nbits <= 24) {
            var byte: u8 = 0;
            if (!b.marker and b.pos < b.data.len) {
                byte = b.data[b.pos];
                if (byte == 0xFF) {
                    const next: u8 = if (b.pos + 1 < b.data.len) b.data[b.pos + 1] else 0xD9;
                    if (next == 0x00) {
                        b.pos += 2;
                    } else {
                        // a marker ends the entropy-coded segment; pad with zeros
                        b.marker = true;
                        byte = 0;
                    }
                } else b.pos += 1;
            } else b.marker = true;
            b.acc |= @as(u32, byte) << @intCast(24 - b.nbits);
            b.nbits += 8;
        }
    }

    fn bits(b: *BitReader, n: u5) u32 {
        if (n == 0) return 0;
        if (b.nbits < n) b.fill();
        const v = b.acc >> @intCast(32 - @as(u32, n));
        b.acc <<= n;
        b.nbits -= n;
        return v;
    }

    fn bit(b: *BitReader) u32 {
        return b.bits(1);
    }

    fn decode(b: *BitReader, h: *const Huffman) Error!u8 {
        if (!h.defined) return error.Invalid;
        var code: i32 = 0;
        for (1..17) |len| {
            code = (code << 1) | @as(i32, @intCast(b.bit()));
            if (code <= h.maxcode[len]) {
                const idx = h.valptr[len] + code - h.mincode[len];
                if (idx < 0 or idx > 255) return error.Invalid;
                return h.values[@intCast(idx)];
            }
        }
        return error.Invalid;
    }

    /// Value of `s` bits, sign-extended per JPEG's magnitude coding.
    fn receiveExtend(b: *BitReader, s: u8) i32 {
        if (s == 0) return 0;
        if (s > 16) return 0;
        const v: i32 = @intCast(b.bits(@intCast(s)));
        const half: i32 = @as(i32, 1) << @intCast(s - 1);
        return if (v < half) v - (@as(i32, 1) << @intCast(s)) + 1 else v;
    }

    /// Skip to just after the next RSTn marker and reset the bit buffer.
    fn restart(b: *BitReader) void {
        b.acc = 0;
        b.nbits = 0;
        b.marker = false;
        while (b.pos + 1 < b.data.len) {
            if (b.data[b.pos] == 0xFF and b.data[b.pos + 1] >= 0xD0 and b.data[b.pos + 1] <= 0xD7) {
                b.pos += 2;
                return;
            }
            if (b.data[b.pos] == 0xFF and b.data[b.pos + 1] != 0 and b.data[b.pos + 1] != 0xFF) return; // other marker: leave it
            b.pos += 1;
        }
    }
};

const Decoder = struct {
    gpa: Allocator,
    data: []const u8,
    qt: [4][64]u16 = @splat(@splat(1)),
    dc: [4]Huffman = @splat(.{}),
    ac: [4]Huffman = @splat(.{}),
    comps: [3]Component = undefined,
    ncomp: usize = 0,
    w: u32 = 0,
    h: u32 = 0,
    hmax: u8 = 1,
    vmax: u8 = 1,
    mcux: usize = 0,
    mcuy: usize = 0,
    progressive: bool = false,
    restart_interval: u32 = 0,
    adobe_transform: ?u8 = null,
    orientation: u8 = 1,
    eobrun: u32 = 0,
    frame_seen: bool = false,

    fn deinit(d: *Decoder) void {
        for (d.comps[0..d.ncomp]) |c| if (c.coeffs.len > 0) d.gpa.free(c.coeffs);
    }

    fn run(d: *Decoder) Error!Decoded {
        if (!isJpeg(d.data)) return error.Invalid;
        var c = Cursor{ .data = d.data, .pos = 2 };
        while (true) {
            // find the next marker (tolerate fill bytes)
            var m = try c.u8_();
            if (m != 0xFF) return error.Invalid;
            while (m == 0xFF) m = try c.u8_();
            switch (m) {
                0xD9 => break, // EOI
                0xD0...0xD7, 0x01 => continue, // stray RST/TEM
                0xC4 => try d.readDht(try segment(&c)),
                0xDB => try d.readDqt(try segment(&c)),
                0xDD => {
                    const s = try segment(&c);
                    if (s.len < 2) return error.Invalid;
                    d.restart_interval = std.mem.readInt(u16, s[0..2], .big);
                },
                0xC0, 0xC1, 0xC2 => {
                    if (d.frame_seen) return error.Invalid;
                    d.progressive = m == 0xC2;
                    try d.readSof(try segment(&c));
                },
                0xC3, 0xC5...0xC7, 0xC9...0xCB, 0xCD...0xCF => return error.Unsupported,
                0xDA => {
                    if (!d.frame_seen) return error.Invalid;
                    try d.readScan(try segment(&c), &c);
                },
                0xE1 => d.readExif(try segment(&c)),
                0xEE => {
                    const s = try segment(&c);
                    if (s.len >= 12 and std.mem.eql(u8, s[0..5], "Adobe")) d.adobe_transform = s[11];
                },
                else => _ = try segment(&c), // APPn, COM, etc.
            }
        }
        if (!d.frame_seen) return error.Invalid;
        return d.output();
    }

    fn segment(c: *Cursor) Error![]const u8 {
        const len = try c.u16be();
        if (len < 2) return error.Invalid;
        return c.bytes(len - 2);
    }

    fn readDqt(d: *Decoder, s: []const u8) Error!void {
        var c = Cursor{ .data = s };
        while (c.remaining() > 0) {
            const pq_tq = try c.u8_();
            const precision = pq_tq >> 4;
            const id = pq_tq & 15;
            if (id > 3 or precision > 1) return error.Invalid;
            for (0..64) |i| {
                const v: u16 = if (precision == 1) try c.u16be() else try c.u8_();
                d.qt[id][zigzag[i]] = v;
            }
        }
    }

    fn readDht(d: *Decoder, s: []const u8) Error!void {
        var c = Cursor{ .data = s };
        while (c.remaining() > 0) {
            const tc_th = try c.u8_();
            const class = tc_th >> 4;
            const id = tc_th & 15;
            if (class > 1 or id > 3) return error.Invalid;
            const counts = (try c.bytes(16))[0..16];
            var total: usize = 0;
            for (counts) |n| total += n;
            const values = try c.bytes(total);
            const t = if (class == 0) &d.dc[id] else &d.ac[id];
            t.* = .{};
            try t.build(counts, values);
        }
    }

    fn readSof(d: *Decoder, s: []const u8) Error!void {
        var c = Cursor{ .data = s };
        if (try c.u8_() != 8) return error.Unsupported; // 12-bit samples
        d.h = try c.u16be();
        d.w = try c.u16be();
        const n = try c.u8_();
        if (n != 1 and n != 3) return error.Unsupported; // CMYK/YCCK
        if (!common.validDims(d.w, d.h)) return error.Invalid;
        d.ncomp = 0;
        for (0..n) |i| {
            const id = try c.u8_();
            const hv = try c.u8_();
            const tq = try c.u8_();
            const hs = hv >> 4;
            const vs = hv & 15;
            if (hs < 1 or hs > 4 or vs < 1 or vs > 4 or tq > 3) return error.Invalid;
            d.comps[i] = .{ .id = id, .h = hs, .v = vs, .tq = tq };
            d.ncomp += 1;
        }
        for (d.comps[0..d.ncomp]) |cp| {
            d.hmax = @max(d.hmax, cp.h);
            d.vmax = @max(d.vmax, cp.v);
        }
        d.mcux = (d.w + 8 * @as(usize, d.hmax) - 1) / (8 * @as(usize, d.hmax));
        d.mcuy = (d.h + 8 * @as(usize, d.vmax) - 1) / (8 * @as(usize, d.vmax));
        for (d.comps[0..d.ncomp]) |*cp| {
            cp.bw = d.mcux * cp.h;
            cp.bh = d.mcuy * cp.v;
            const cw = (@as(usize, d.w) * cp.h + d.hmax - 1) / d.hmax;
            const ch = (@as(usize, d.h) * cp.v + d.vmax - 1) / d.vmax;
            cp.bw_used = (cw + 7) / 8;
            cp.bh_used = (ch + 7) / 8;
            const n_coeffs = std.math.mul(usize, std.math.mul(usize, cp.bw, cp.bh) catch return error.Invalid, 64) catch return error.Invalid;
            cp.coeffs = try d.gpa.alloc(i16, n_coeffs);
            @memset(cp.coeffs, 0);
        }
        d.frame_seen = true;
    }

    fn readExif(d: *Decoder, s: []const u8) void {
        if (s.len < 14 or !std.mem.eql(u8, s[0..6], "Exif\x00\x00")) return;
        const t = s[6..];
        const endian: std.builtin.Endian = if (std.mem.eql(u8, t[0..2], "II")) .little else if (std.mem.eql(u8, t[0..2], "MM")) .big else return;
        const ifd = std.mem.readInt(u32, t[4..8], endian);
        if (ifd > t.len or t.len - ifd < 2) return;
        const n = std.mem.readInt(u16, t[ifd..][0..2], endian);
        var i: usize = 0;
        while (i < n) : (i += 1) {
            const off = ifd + 2 + i * 12;
            if (off + 12 > t.len) return;
            const tag = std.mem.readInt(u16, t[off..][0..2], endian);
            if (tag == 0x0112) {
                const v = std.mem.readInt(u16, t[off + 8 ..][0..2], endian);
                if (v >= 1 and v <= 8) d.orientation = @intCast(v);
                return;
            }
        }
    }

    fn readScan(d: *Decoder, s: []const u8, c: *Cursor) Error!void {
        var h = Cursor{ .data = s };
        const n = try h.u8_();
        if (n < 1 or n > d.ncomp) return error.Invalid;
        var scomps: [3]usize = undefined;
        for (0..n) |i| {
            const id = try h.u8_();
            const tables = try h.u8_();
            const idx = for (d.comps[0..d.ncomp], 0..) |cp, j| {
                if (cp.id == id) break j;
            } else return error.Invalid;
            d.comps[idx].td = tables >> 4;
            d.comps[idx].ta = tables & 15;
            if (d.comps[idx].td > 3 or d.comps[idx].ta > 3) return error.Invalid;
            scomps[i] = idx;
        }
        const ss = try h.u8_();
        const se = try h.u8_();
        const ahal = try h.u8_();
        const ah: u4 = @intCast(ahal >> 4);
        const al: u4 = @intCast(ahal & 15);
        if (d.progressive) {
            if (ss > se or se > 63 or (ss == 0 and se != 0) or (ss > 0 and n != 1) or al > 13) return error.Invalid;
        } else if (ss != 0 or se != 63 or ahal != 0) return error.Invalid;

        var br = BitReader{ .data = d.data, .pos = c.pos };
        for (d.comps[0..d.ncomp]) |*cp| cp.dc_pred = 0;
        d.eobrun = 0;

        var mcu_count: u32 = 0;
        if (n == 1) {
            // non-interleaved: one block per MCU, over the component's own extent
            const cp = &d.comps[scomps[0]];
            for (0..cp.bh_used) |by| for (0..cp.bw_used) |bx| {
                try d.restartIfDue(&br, &mcu_count);
                try d.decodeBlock(&br, cp, by * cp.bw + bx, ss, se, ah, al);
            };
        } else {
            for (0..d.mcuy) |my| for (0..d.mcux) |mx| {
                try d.restartIfDue(&br, &mcu_count);
                for (scomps[0..n]) |ci| {
                    const cp = &d.comps[ci];
                    for (0..cp.v) |yy| for (0..cp.h) |xx| {
                        const by = my * cp.v + yy;
                        const bx = mx * cp.h + xx;
                        try d.decodeBlock(&br, cp, by * cp.bw + bx, ss, se, ah, al);
                    };
                }
            };
        }
        // continue parsing at the marker that ended the entropy-coded data
        var p = br.pos;
        while (p + 1 < d.data.len and !(d.data[p] == 0xFF and d.data[p + 1] != 0 and (d.data[p + 1] < 0xD0 or d.data[p + 1] > 0xD7))) p += 1;
        c.pos = @min(p, d.data.len);
    }

    fn restartIfDue(d: *Decoder, br: *BitReader, count: *u32) Error!void {
        if (d.restart_interval == 0) return;
        if (count.* != 0 and count.* % d.restart_interval == 0) {
            br.restart();
            for (d.comps[0..d.ncomp]) |*cp| cp.dc_pred = 0;
            d.eobrun = 0;
        }
        count.* += 1;
    }

    fn decodeBlock(d: *Decoder, br: *BitReader, cp: *Component, block: usize, ss: u8, se: u8, ah: u4, al: u4) Error!void {
        const coef = cp.coeffs[block * 64 ..][0..64];
        if (!d.progressive) {
            // DC
            const t = try br.decode(&d.dc[cp.td]);
            if (t > 16) return error.Invalid;
            cp.dc_pred += br.receiveExtend(t);
            coef[0] = clamp16(cp.dc_pred);
            // AC
            var k: usize = 1;
            while (k < 64) {
                const rs = try br.decode(&d.ac[cp.ta]);
                const r = rs >> 4;
                const sz = rs & 15;
                if (sz == 0) {
                    if (r != 15) break;
                    k += 16;
                    continue;
                }
                k += r;
                if (k > 63) return error.Invalid;
                coef[zigzag[k]] = clamp16(br.receiveExtend(sz));
                k += 1;
            }
            return;
        }
        if (ss == 0) {
            // DC scan
            if (ah == 0) {
                const t = try br.decode(&d.dc[cp.td]);
                if (t > 16) return error.Invalid;
                cp.dc_pred += br.receiveExtend(t);
                coef[0] = clamp16(cp.dc_pred * (@as(i32, 1) << al));
            } else if (br.bit() != 0) {
                coef[0] = coef[0] | (@as(i16, 1) << al);
            }
            return;
        }
        if (ah == 0) {
            // AC first pass
            if (d.eobrun > 0) {
                d.eobrun -= 1;
                return;
            }
            var k: usize = ss;
            while (k <= se) {
                const rs = try br.decode(&d.ac[cp.ta]);
                const r = rs >> 4;
                const sz = rs & 15;
                if (sz == 0) {
                    if (r < 15) {
                        d.eobrun = (@as(u32, 1) << @intCast(r)) - 1;
                        if (r > 0) d.eobrun += br.bits(@intCast(r));
                        break;
                    }
                    k += 16;
                    continue;
                }
                k += r;
                if (k > 63) return error.Invalid;
                coef[zigzag[k]] = clamp16(br.receiveExtend(sz) * (@as(i32, 1) << al));
                k += 1;
            }
            return;
        }
        // AC refinement (libjpeg decode_mcu_AC_refine)
        const p1: i16 = @as(i16, 1) << al;
        const m1: i16 = -p1;
        var k: usize = ss;
        if (d.eobrun == 0) {
            while (k <= se) : (k += 1) {
                const rs = try br.decode(&d.ac[cp.ta]);
                var r: i32 = rs >> 4;
                const sz = rs & 15;
                var value: i16 = 0;
                if (sz != 0) {
                    if (sz != 1) return error.Invalid;
                    value = if (br.bit() != 0) p1 else m1;
                } else if (r != 15) {
                    d.eobrun = @as(u32, 1) << @intCast(r);
                    if (r > 0) d.eobrun += br.bits(@intCast(r));
                    break;
                }
                while (k <= se) : (k += 1) {
                    const z = &coef[zigzag[k]];
                    if (z.* != 0) {
                        if (br.bit() != 0 and (z.* & p1) == 0) z.* += if (z.* >= 0) p1 else m1;
                    } else {
                        r -= 1;
                        if (r < 0) break;
                    }
                }
                if (value != 0 and k <= se) coef[zigzag[k]] = value;
            }
        }
        if (d.eobrun > 0) {
            while (k <= se) : (k += 1) {
                const z = &coef[zigzag[k]];
                if (z.* != 0 and br.bit() != 0 and (z.* & p1) == 0) z.* += if (z.* >= 0) p1 else m1;
            }
            d.eobrun -= 1;
        }
    }

    fn output(d: *Decoder) Error!Decoded {
        // dequantize + IDCT each component into a padded plane
        var planes: [3][]u8 = .{ &.{}, &.{}, &.{} };
        defer for (planes[0..d.ncomp]) |p| if (p.len > 0) d.gpa.free(p);
        for (d.comps[0..d.ncomp], 0..) |*cp, ci| {
            const pw = cp.bw * 8;
            const plane = try d.gpa.alloc(u8, pw * cp.bh * 8);
            planes[ci] = plane;
            const q = &d.qt[cp.tq];
            var tmp: [64]f32 = undefined;
            for (0..cp.bh) |by| for (0..cp.bw) |bx| {
                const coef = cp.coeffs[(by * cp.bw + bx) * 64 ..][0..64];
                for (0..64) |i| tmp[i] = @as(f32, @floatFromInt(coef[i])) * @as(f32, @floatFromInt(q[i]));
                idct8x8(&tmp);
                for (0..8) |y| for (0..8) |x| {
                    const v = @round(tmp[y * 8 + x] + 128);
                    plane[(by * 8 + y) * pw + bx * 8 + x] = @intFromFloat(std.math.clamp(v, 0, 255));
                };
            };
        }

        const out = common.allocRgba(d.gpa, d.w, d.h) orelse return error.OutOfMemory;
        errdefer d.gpa.free(out);
        const rgb_direct = d.ncomp == 3 and (d.adobe_transform == 0 or (d.adobe_transform == null and d.comps[0].id == 'R' and d.comps[1].id == 'G' and d.comps[2].id == 'B'));
        for (0..d.h) |y| for (0..d.w) |x| {
            const px = out[(y * d.w + x) * 4 ..][0..4];
            if (d.ncomp == 1) {
                const v = d.sampleAt(0, planes[0], x, y);
                px.* = .{ v, v, v, 255 };
                continue;
            }
            const c0: f32 = @floatFromInt(d.sampleAt(0, planes[0], x, y));
            const c1: f32 = @floatFromInt(d.sampleAt(1, planes[1], x, y));
            const c2: f32 = @floatFromInt(d.sampleAt(2, planes[2], x, y));
            if (rgb_direct) {
                px.* = .{ @intFromFloat(c0), @intFromFloat(c1), @intFromFloat(c2), 255 };
            } else {
                const cb = c1 - 128;
                const cr = c2 - 128;
                px.* = .{ toByte(c0 + 1.402 * cr), toByte(c0 - 0.344136 * cb - 0.714136 * cr), toByte(c0 + 1.772 * cb), 255 };
            }
        };
        return orient(d.gpa, .{ .w = d.w, .h = d.h, .px = out }, d.orientation);
    }

    /// Component sample for output pixel (x, y): triangle-filtered when the
    /// component is subsampled.
    fn sampleAt(d: *const Decoder, ci: usize, plane: []const u8, x: usize, y: usize) u8 {
        const cp = &d.comps[ci];
        const pw = cp.bw * 8;
        if (cp.h == d.hmax and cp.v == d.vmax) return plane[y * pw + x];
        const cw = (@as(usize, d.w) * cp.h + d.hmax - 1) / d.hmax;
        const ch = (@as(usize, d.h) * cp.v + d.vmax - 1) / d.vmax;
        const fx = (@as(f32, @floatFromInt(x)) + 0.5) * @as(f32, @floatFromInt(cp.h)) / @as(f32, @floatFromInt(d.hmax)) - 0.5;
        const fy = (@as(f32, @floatFromInt(y)) + 0.5) * @as(f32, @floatFromInt(cp.v)) / @as(f32, @floatFromInt(d.vmax)) - 0.5;
        const maxx: f32 = @floatFromInt(cw - 1);
        const maxy: f32 = @floatFromInt(ch - 1);
        const cx = std.math.clamp(fx, 0, maxx);
        const cy = std.math.clamp(fy, 0, maxy);
        const x0: usize = @intFromFloat(@floor(cx));
        const y0: usize = @intFromFloat(@floor(cy));
        const x1 = @min(x0 + 1, cw - 1);
        const y1 = @min(y0 + 1, ch - 1);
        const tx = cx - @as(f32, @floatFromInt(x0));
        const ty = cy - @as(f32, @floatFromInt(y0));
        const a: f32 = @floatFromInt(plane[y0 * pw + x0]);
        const b: f32 = @floatFromInt(plane[y0 * pw + x1]);
        const c: f32 = @floatFromInt(plane[y1 * pw + x0]);
        const e: f32 = @floatFromInt(plane[y1 * pw + x1]);
        const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
        return toByte(v);
    }
};

fn toByte(v: f32) u8 {
    return @intFromFloat(std.math.clamp(@round(v), 0, 255));
}

fn clamp16(v: i32) i16 {
    return @intCast(std.math.clamp(v, std.math.minInt(i16), std.math.maxInt(i16)));
}

/// cos table: c[x][u] = C(u)/2 * cos((2x+1)uπ/16)
const idct_table: [8][8]f32 = blk: {
    @setEvalBranchQuota(10000);
    var t: [8][8]f32 = undefined;
    for (0..8) |x| for (0..8) |u| {
        const cu: f64 = if (u == 0) 1.0 / @sqrt(2.0) else 1.0;
        t[x][u] = @floatCast(cu / 2.0 * @cos(@as(f64, @floatFromInt((2 * x + 1) * u)) * std.math.pi / 16.0));
    };
    break :blk t;
};

/// Separable 2D inverse DCT, in place (row-major, natural order).
fn idct8x8(b: *[64]f32) void {
    var tmp: [64]f32 = undefined;
    // rows: for each row v, transform along u
    for (0..8) |v| for (0..8) |x| {
        var s: f32 = 0;
        for (0..8) |u| s += idct_table[x][u] * b[v * 8 + u];
        tmp[v * 8 + x] = s;
    };
    for (0..8) |x| for (0..8) |y| {
        var s: f32 = 0;
        for (0..8) |v| s += idct_table[y][v] * tmp[v * 8 + x];
        b[y * 8 + x] = s;
    };
}

/// Apply an EXIF orientation (1..8) by remapping pixels.
pub fn orient(gpa: Allocator, img: Decoded, o: u8) Error!Decoded {
    if (o <= 1 or o > 8) return img;
    const swap = o >= 5;
    const nw = if (swap) img.h else img.w;
    const nh = if (swap) img.w else img.h;
    const out = try gpa.alloc(u8, img.px.len);
    for (0..img.h) |y| for (0..img.w) |x| {
        const W: usize = img.w - 1;
        const H: usize = img.h - 1;
        const dst: [2]usize = switch (o) {
            2 => .{ W - x, y },
            3 => .{ W - x, H - y },
            4 => .{ x, H - y },
            5 => .{ y, x },
            6 => .{ H - y, x },
            7 => .{ H - y, W - x },
            8 => .{ y, W - x },
            else => .{ x, y },
        };
        @memcpy(out[(dst[1] * @as(usize, nw) + dst[0]) * 4 ..][0..4], img.px[(y * @as(usize, img.w) + x) * 4 ..][0..4]);
    };
    gpa.free(img.px);
    return .{ .w = nw, .h = nh, .px = out };
}
