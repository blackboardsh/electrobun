//! GIF decoder: the first frame of a GIF87a/89a, composited onto a
//! transparent canvas of the logical screen size, with local/global color
//! tables, the graphic control extension's transparent index, and
//! interlaced frames.
const std = @import("std");
const common = @import("common.zig");
const Allocator = std.mem.Allocator;
const Decoded = common.Decoded;
const Cursor = common.Cursor;

pub fn isGif(data: []const u8) bool {
    return std.mem.startsWith(u8, data, "GIF87a") or std.mem.startsWith(u8, data, "GIF89a");
}

pub fn decode(gpa: Allocator, data: []const u8) ?Decoded {
    return decodeImpl(gpa, data) catch null;
}

const Error = error{ Invalid, Truncated, OutOfMemory };

fn decodeImpl(gpa: Allocator, data: []const u8) Error!Decoded {
    if (!isGif(data)) return error.Invalid;
    var c = Cursor{ .data = data, .pos = 6 };
    const sw = try c.u16le();
    const sh = try c.u16le();
    const flags = try c.u8_();
    _ = try c.u8_(); // background index (canvas starts transparent, as in browsers)
    _ = try c.u8_(); // aspect
    if (!common.validDims(sw, sh)) return error.Invalid;
    var global: []const u8 = &.{};
    if (flags & 0x80 != 0) global = try c.bytes(3 * (@as(usize, 1) << @intCast((flags & 7) + 1)));

    var transparent: ?u8 = null;
    while (true) {
        const block = try c.u8_();
        switch (block) {
            0x21 => { // extension
                const label = try c.u8_();
                if (label == 0xF9) {
                    const len = try c.u8_();
                    const body = try c.bytes(len);
                    if (len >= 4 and body[0] & 1 != 0) transparent = body[3];
                }
                try skipSubBlocks(&c);
            },
            0x2C => { // image descriptor
                const ix = try c.u16le();
                const iy = try c.u16le();
                const iw = try c.u16le();
                const ih = try c.u16le();
                const iflags = try c.u8_();
                var table = global;
                if (iflags & 0x80 != 0) table = try c.bytes(3 * (@as(usize, 1) << @intCast((iflags & 7) + 1)));
                if (table.len == 0) return error.Invalid;
                const interlaced = iflags & 0x40 != 0;
                const min_code = try c.u8_();
                if (min_code < 2 or min_code > 8) return error.Invalid;
                var lzw: std.ArrayList(u8) = .empty;
                defer lzw.deinit(gpa);
                while (true) {
                    const n = try c.u8_();
                    if (n == 0) break;
                    try lzw.appendSlice(gpa, try c.bytes(n));
                }
                const npix = std.math.mul(usize, iw, ih) catch return error.Invalid;
                const indices = try gpa.alloc(u8, npix);
                defer gpa.free(indices);
                @memset(indices, transparent orelse 0);
                decompress(lzw.items, min_code, indices);

                const out = common.allocRgba(gpa, sw, sh) orelse return error.OutOfMemory;
                errdefer gpa.free(out);
                for (0..ih) |row| {
                    const y = iy + interlacedRow(row, ih, interlaced);
                    if (y >= sh) continue;
                    for (0..iw) |col| {
                        const x = ix + col;
                        if (x >= sw) continue;
                        const idx = indices[row * iw + col];
                        if (transparent != null and idx == transparent.?) continue;
                        if (@as(usize, idx) * 3 + 2 >= table.len) continue;
                        const p = out[(y * sw + x) * 4 ..][0..4];
                        p.* = .{ table[@as(usize, idx) * 3], table[@as(usize, idx) * 3 + 1], table[@as(usize, idx) * 3 + 2], 255 };
                    }
                }
                return .{ .w = sw, .h = sh, .px = out };
            },
            else => return error.Invalid, // trailer (0x3B) before any frame, or garbage
        }
    }
}

fn skipSubBlocks(c: *Cursor) Error!void {
    while (true) {
        const n = try c.u8_();
        if (n == 0) return;
        try c.skip(n);
    }
}

/// Canvas row for stored row `i` of an `h`-row frame.
fn interlacedRow(i: usize, h: usize, interlaced: bool) usize {
    if (!interlaced) return i;
    const starts = [_]usize{ 0, 4, 2, 1 };
    const steps = [_]usize{ 8, 8, 4, 2 };
    var remaining = i;
    for (starts, steps) |s, st| {
        const n = if (h > s) (h - s + st - 1) / st else 0;
        if (remaining < n) return s + remaining * st;
        remaining -= n;
    }
    return i;
}

/// LZW-decode into `out` (stops when `out` is full or the data ends).
fn decompress(data: []const u8, min_code: u8, out: []u8) void {
    const clear: u16 = @as(u16, 1) << @intCast(min_code);
    const eoi = clear + 1;
    var prefix: [4096]u16 = undefined;
    var suffix: [4096]u8 = undefined;
    var first: [4096]u8 = undefined;
    var stack: [4097]u8 = undefined;
    for (0..clear) |i| {
        suffix[i] = @intCast(i);
        first[i] = @intCast(i);
        prefix[i] = 0xFFFF;
    }
    var size: u5 = @intCast(min_code + 1);
    var next: u16 = eoi + 1;
    var prev: ?u16 = null;
    var acc: u32 = 0;
    var nbits: u5 = 0;
    var pos: usize = 0;
    var o: usize = 0;
    while (o < out.len) {
        while (nbits < size) {
            if (pos >= data.len) return;
            acc |= @as(u32, data[pos]) << nbits;
            pos += 1;
            nbits += 8;
        }
        const code: u16 = @intCast(acc & ((@as(u32, 1) << size) - 1));
        acc >>= size;
        nbits -= size;
        if (code == clear) {
            size = @intCast(min_code + 1);
            next = eoi + 1;
            prev = null;
            continue;
        }
        if (code == eoi) return;
        const p = prev orelse {
            if (code >= clear) return; // must start with a literal
            out[o] = @intCast(code);
            o += 1;
            prev = code;
            continue;
        };
        var cur = code;
        var sp: usize = 0;
        if (code >= next) {
            if (code != next) return; // corrupt
            stack[sp] = first[p];
            sp += 1;
            cur = p;
        }
        while (cur >= clear) {
            if (cur >= 4096 or sp >= stack.len - 1) return;
            stack[sp] = suffix[cur];
            sp += 1;
            cur = prefix[cur];
        }
        stack[sp] = @intCast(cur);
        sp += 1;
        if (next < 4096) {
            prefix[next] = p;
            suffix[next] = @intCast(cur);
            first[next] = first[p];
            next += 1;
            if (next == (@as(u32, 1) << size) and size < 12) size += 1;
        }
        while (sp > 0 and o < out.len) {
            sp -= 1;
            out[o] = stack[sp];
            o += 1;
        }
        prev = code;
    }
}
