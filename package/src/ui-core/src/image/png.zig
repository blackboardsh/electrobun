//! PNG decoder: every color type and bit depth, palettes with tRNS,
//! Adam7 interlacing and 16-bit samples. Output is premultiplied RGBA8.
//! Color management chunks (gAMA, iCCP, cHRM) are ignored: samples are
//! treated as sRGB.
const std = @import("std");
const common = @import("common.zig");
const Allocator = std.mem.Allocator;
const Decoded = common.Decoded;
const Cursor = common.Cursor;

pub const signature = "\x89PNG\r\n\x1a\n";

pub fn isPng(data: []const u8) bool {
    return std.mem.startsWith(u8, data, signature);
}

const Header = struct {
    w: u32,
    h: u32,
    depth: u8,
    color: u8,
    interlace: bool,

    fn channels(hd: Header) u8 {
        return switch (hd.color) {
            0 => 1,
            2 => 3,
            3 => 1,
            4 => 2,
            6 => 4,
            else => 0,
        };
    }
    fn bitsPerPixel(hd: Header) u32 {
        return @as(u32, hd.channels()) * hd.depth;
    }
    /// Bytes per row of a (sub)image `w` pixels wide, without the filter byte.
    fn rowBytes(hd: Header, w: u32) usize {
        return (@as(usize, w) * hd.bitsPerPixel() + 7) / 8;
    }
    fn valid(hd: Header) bool {
        const ok_depth = switch (hd.color) {
            0 => hd.depth == 1 or hd.depth == 2 or hd.depth == 4 or hd.depth == 8 or hd.depth == 16,
            3 => hd.depth == 1 or hd.depth == 2 or hd.depth == 4 or hd.depth == 8,
            2, 4, 6 => hd.depth == 8 or hd.depth == 16,
            else => false,
        };
        return ok_depth and common.validDims(hd.w, hd.h);
    }
};

const Pass = struct { x0: u32, y0: u32, dx: u32, dy: u32 };
const adam7 = [_]Pass{
    .{ .x0 = 0, .y0 = 0, .dx = 8, .dy = 8 },
    .{ .x0 = 4, .y0 = 0, .dx = 8, .dy = 8 },
    .{ .x0 = 0, .y0 = 4, .dx = 4, .dy = 8 },
    .{ .x0 = 2, .y0 = 0, .dx = 4, .dy = 4 },
    .{ .x0 = 0, .y0 = 2, .dx = 2, .dy = 4 },
    .{ .x0 = 1, .y0 = 0, .dx = 2, .dy = 2 },
    .{ .x0 = 0, .y0 = 1, .dx = 1, .dy = 2 },
};
const no_interlace = [_]Pass{.{ .x0 = 0, .y0 = 0, .dx = 1, .dy = 1 }};

fn passSize(p: Pass, w: u32, h: u32) [2]u32 {
    const pw = if (w > p.x0) (w - p.x0 + p.dx - 1) / p.dx else 0;
    const ph = if (h > p.y0) (h - p.y0 + p.dy - 1) / p.dy else 0;
    return .{ pw, ph };
}

pub fn decode(gpa: Allocator, data: []const u8) ?Decoded {
    return decodeImpl(gpa, data) catch null;
}

const Error = error{ Invalid, Truncated, OutOfMemory };

fn decodeImpl(gpa: Allocator, data: []const u8) Error!Decoded {
    if (!isPng(data)) return error.Invalid;
    var c = Cursor{ .data = data, .pos = signature.len };
    var hdr: ?Header = null;
    var palette: [256][4]u8 = undefined;
    var palette_len: usize = 0;
    var trns_key: ?[3]u16 = null; // gray uses [0]
    var idat: std.ArrayList(u8) = .empty;
    defer idat.deinit(gpa);

    while (c.remaining() >= 12) {
        const len = try c.u32be();
        const kind = try c.bytes(4);
        if (len > c.remaining()) return error.Truncated;
        const body = try c.bytes(len);
        try c.skip(4); // CRC
        if (std.mem.eql(u8, kind, "IHDR")) {
            if (body.len < 13) return error.Invalid;
            var b = Cursor{ .data = body };
            const h = Header{
                .w = try b.u32be(),
                .h = try b.u32be(),
                .depth = try b.u8_(),
                .color = try b.u8_(),
                .interlace = blk: {
                    _ = try b.u8_(); // compression
                    _ = try b.u8_(); // filter method
                    break :blk (try b.u8_()) == 1;
                },
            };
            if (!h.valid()) return error.Invalid;
            hdr = h;
        } else if (std.mem.eql(u8, kind, "PLTE")) {
            if (body.len % 3 != 0 or body.len > 768) return error.Invalid;
            palette_len = body.len / 3;
            for (0..palette_len) |i| palette[i] = .{ body[i * 3], body[i * 3 + 1], body[i * 3 + 2], 255 };
        } else if (std.mem.eql(u8, kind, "tRNS")) {
            const h = hdr orelse return error.Invalid;
            switch (h.color) {
                3 => for (body, 0..) |a, i| {
                    if (i < palette_len) palette[i][3] = a;
                },
                0 => if (body.len >= 2) {
                    trns_key = .{ std.mem.readInt(u16, body[0..2], .big), 0, 0 };
                },
                2 => if (body.len >= 6) {
                    trns_key = .{ std.mem.readInt(u16, body[0..2], .big), std.mem.readInt(u16, body[2..4], .big), std.mem.readInt(u16, body[4..6], .big) };
                },
                else => {},
            }
        } else if (std.mem.eql(u8, kind, "IDAT")) {
            try idat.appendSlice(gpa, body);
        } else if (std.mem.eql(u8, kind, "IEND")) {
            break;
        }
    }
    const h = hdr orelse return error.Invalid;
    if (h.color == 3 and palette_len == 0) return error.Invalid;

    // total size of the filtered, decompressed stream
    const passes: []const Pass = if (h.interlace) &adam7 else &no_interlace;
    var raw_len: usize = 0;
    for (passes) |p| {
        const sz = passSize(p, h.w, h.h);
        if (sz[0] == 0 or sz[1] == 0) continue;
        raw_len = std.math.add(usize, raw_len, std.math.mul(usize, sz[1], h.rowBytes(sz[0]) + 1) catch return error.Invalid) catch return error.Invalid;
    }
    const raw = try gpa.alloc(u8, raw_len);
    defer gpa.free(raw);
    try inflate(gpa, idat.items, raw);

    const out = common.allocRgba(gpa, h.w, h.h) orelse return error.OutOfMemory;
    errdefer gpa.free(out);

    const bpp = @max(1, h.bitsPerPixel() / 8);
    var off: usize = 0;
    var prev: std.ArrayList(u8) = .empty;
    defer prev.deinit(gpa);
    for (passes) |p| {
        const sz = passSize(p, h.w, h.h);
        if (sz[0] == 0 or sz[1] == 0) continue;
        const rb = h.rowBytes(sz[0]);
        try prev.resize(gpa, rb);
        @memset(prev.items, 0);
        for (0..sz[1]) |py| {
            const filter = raw[off];
            const row = raw[off + 1 ..][0..rb];
            off += rb + 1;
            try unfilter(filter, row, prev.items, bpp);
            @memcpy(prev.items, row);
            const y = p.y0 + @as(u32, @intCast(py)) * p.dy;
            for (0..sz[0]) |px| {
                const x = p.x0 + @as(u32, @intCast(px)) * p.dx;
                const dst = out[(@as(usize, y) * h.w + x) * 4 ..][0..4];
                dst.* = pixel(h, row, px, &palette, palette_len, trns_key);
            }
        }
    }
    common.premultiply(out);
    return .{ .w = h.w, .h = h.h, .px = out };
}

fn inflate(gpa: Allocator, compressed: []const u8, out: []u8) Error!void {
    const window = try gpa.alloc(u8, std.compress.flate.max_window_len);
    defer gpa.free(window);
    var in: std.Io.Reader = .fixed(compressed);
    var d = std.compress.flate.Decompress.init(&in, .zlib, window);
    d.reader.readSliceAll(out) catch return error.Truncated;
}

fn unfilter(filter: u8, row: []u8, prev: []const u8, bpp: usize) Error!void {
    switch (filter) {
        0 => {},
        1 => for (bpp..row.len) |i| {
            row[i] +%= row[i - bpp];
        },
        2 => for (row, prev) |*r, p| {
            r.* +%= p;
        },
        3 => for (row, 0..) |*r, i| {
            const left: u16 = if (i >= bpp) row[i - bpp] else 0;
            r.* +%= @intCast((left + prev[i]) / 2);
        },
        4 => for (row, 0..) |*r, i| {
            const a: i16 = if (i >= bpp) row[i - bpp] else 0;
            const b: i16 = prev[i];
            const cc: i16 = if (i >= bpp) prev[i - bpp] else 0;
            r.* +%= paeth(a, b, cc);
        },
        else => return error.Invalid,
    }
}

fn paeth(a: i16, b: i16, c: i16) u8 {
    const p = a + b - c;
    const pa = @abs(p - a);
    const pb = @abs(p - b);
    const pc = @abs(p - c);
    const v = if (pa <= pb and pa <= pc) a else if (pb <= pc) b else c;
    return @intCast(v);
}

/// Sample `i` (0-based channel index across the row) at `depth` bits.
fn sample(row: []const u8, i: usize, depth: u8) u16 {
    return switch (depth) {
        16 => std.mem.readInt(u16, row[i * 2 ..][0..2], .big),
        8 => row[i],
        else => blk: {
            const per_byte = 8 / depth;
            const byte = row[i / per_byte];
            const shift: u3 = @intCast(8 - depth * (1 + i % per_byte));
            const mask: u8 = @intCast((@as(u16, 1) << @intCast(depth)) - 1);
            break :blk (byte >> shift) & mask;
        },
    };
}

/// Scale a sample to 8 bits.
fn to8(v: u16, depth: u8) u8 {
    return switch (depth) {
        16 => @intCast((@as(u32, v) * 255 + 32767) / 65535),
        8 => @intCast(v),
        4 => @intCast(v * 17),
        2 => @intCast(v * 85),
        1 => @intCast(v * 255),
        else => 0,
    };
}

fn pixel(h: Header, row: []const u8, x: usize, palette: *const [256][4]u8, palette_len: usize, key: ?[3]u16) [4]u8 {
    const d = h.depth;
    switch (h.color) {
        0 => {
            const g = sample(row, x, d);
            const a: u8 = if (key) |k| (if (g == k[0]) 0 else 255) else 255;
            const v = to8(g, d);
            return .{ v, v, v, a };
        },
        2 => {
            const r = sample(row, x * 3, d);
            const g = sample(row, x * 3 + 1, d);
            const b = sample(row, x * 3 + 2, d);
            const a: u8 = if (key) |k| (if (r == k[0] and g == k[1] and b == k[2]) 0 else 255) else 255;
            return .{ to8(r, d), to8(g, d), to8(b, d), a };
        },
        3 => {
            const idx = sample(row, x, d);
            if (idx >= palette_len) return .{ 0, 0, 0, 255 };
            return palette[idx];
        },
        4 => {
            const v = to8(sample(row, x * 2, d), d);
            return .{ v, v, v, to8(sample(row, x * 2 + 1, d), d) };
        },
        6 => return .{
            to8(sample(row, x * 4, d), d),
            to8(sample(row, x * 4 + 1, d), d),
            to8(sample(row, x * 4 + 2, d), d),
            to8(sample(row, x * 4 + 3, d), d),
        },
        else => return .{ 0, 0, 0, 0 },
    }
}
