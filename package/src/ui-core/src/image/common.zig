//! Shared pieces of the pure-Zig image decoders.
const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Decoded = struct { w: u32, h: u32, px: []u8 };

/// Largest accepted dimension (either axis).
pub const max_dim: u32 = 16384;
/// Largest accepted pixel count (bounds the RGBA allocation to 1 GiB).
pub const max_pixels: u64 = @as(u64, max_dim) * max_dim;

pub fn validDims(w: u64, h: u64) bool {
    return w > 0 and h > 0 and w <= max_dim and h <= max_dim and w * h <= max_pixels;
}

/// Allocate a zeroed RGBA8 canvas, or null if the size is invalid.
pub fn allocRgba(gpa: Allocator, w: u32, h: u32) ?[]u8 {
    if (!validDims(w, h)) return null;
    const px = gpa.alloc(u8, @as(usize, w) * h * 4) catch return null;
    @memset(px, 0);
    return px;
}

/// Convert straight-alpha RGBA8 to premultiplied, in place.
pub fn premultiply(px: []u8) void {
    var i: usize = 0;
    while (i + 3 < px.len) : (i += 4) {
        const a: u32 = px[i + 3];
        if (a == 255) continue;
        px[i] = mulDiv255(px[i], a);
        px[i + 1] = mulDiv255(px[i + 1], a);
        px[i + 2] = mulDiv255(px[i + 2], a);
    }
}

pub fn mulDiv255(c: u32, a: u32) u8 {
    const t = c * a + 128;
    return @intCast((t + (t >> 8)) >> 8);
}

/// Bounds-checked big-endian reader over a byte slice. Every read either
/// succeeds or reports `error.Truncated`, so malformed input can't index
/// out of bounds.
pub const Cursor = struct {
    data: []const u8,
    pos: usize = 0,

    pub const Error = error{Truncated};

    /// Bytes left; zero if `pos` was set past the end (e.g. from a bogus offset).
    pub fn remaining(c: *const Cursor) usize {
        return c.data.len -| c.pos;
    }
    pub fn bytes(c: *Cursor, n: usize) Error![]const u8 {
        if (n > c.remaining()) return error.Truncated;
        const s = c.data[c.pos..][0..n];
        c.pos += n;
        return s;
    }
    pub fn skip(c: *Cursor, n: usize) Error!void {
        _ = try c.bytes(n);
    }
    pub fn u8_(c: *Cursor) Error!u8 {
        return (try c.bytes(1))[0];
    }
    pub fn u16be(c: *Cursor) Error!u16 {
        return std.mem.readInt(u16, (try c.bytes(2))[0..2], .big);
    }
    pub fn u32be(c: *Cursor) Error!u32 {
        return std.mem.readInt(u32, (try c.bytes(4))[0..4], .big);
    }
    pub fn u16le(c: *Cursor) Error!u16 {
        return std.mem.readInt(u16, (try c.bytes(2))[0..2], .little);
    }
    pub fn u32le(c: *Cursor) Error!u32 {
        return std.mem.readInt(u32, (try c.bytes(4))[0..4], .little);
    }
};
