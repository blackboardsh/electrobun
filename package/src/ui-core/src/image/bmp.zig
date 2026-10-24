//! BMP decoder: uncompressed 1/4/8-bit palette, 24-bit and 32-bit images
//! (BI_RGB and BI_BITFIELDS), bottom-up or top-down. RLE and embedded
//! PNG/JPEG BMPs are rejected.
const std = @import("std");
const common = @import("common.zig");
const Allocator = std.mem.Allocator;
const Decoded = common.Decoded;
const Cursor = common.Cursor;

pub fn isBmp(data: []const u8) bool {
    return data.len >= 26 and data[0] == 'B' and data[1] == 'M';
}

pub fn decode(gpa: Allocator, data: []const u8) ?Decoded {
    return decodeImpl(gpa, data) catch null;
}

const Error = error{ Invalid, Unsupported, Truncated, OutOfMemory };

fn decodeImpl(gpa: Allocator, data: []const u8) Error!Decoded {
    if (!isBmp(data)) return error.Invalid;
    var c = Cursor{ .data = data, .pos = 10 };
    const pixel_offset = try c.u32le();
    const header_size = try c.u32le();
    if (header_size < 40) return error.Unsupported; // OS/2 BITMAPCOREHEADER
    const w_raw: i32 = @bitCast(try c.u32le());
    const h_raw: i32 = @bitCast(try c.u32le());
    _ = try c.u16le(); // planes
    const bpp = try c.u16le();
    const compression = try c.u32le();
    try c.skip(12); // image size, resolution
    const colors_used = try c.u32le();
    try c.skip(4); // important colors
    if (w_raw <= 0 or h_raw == 0 or h_raw == std.math.minInt(i32)) return error.Invalid;
    const w: u32 = @intCast(w_raw);
    const top_down = h_raw < 0;
    const h: u32 = @intCast(@abs(h_raw));
    if (!common.validDims(w, h)) return error.Invalid;

    var masks = [4]u32{ 0x00FF0000, 0x0000FF00, 0x000000FF, 0 };
    if (compression == 3 or compression == 6) {
        // BI_BITFIELDS / BI_ALPHABITFIELDS: masks follow the 40-byte header
        var m = Cursor{ .data = data, .pos = 14 + 40 };
        masks[0] = try m.u32le();
        masks[1] = try m.u32le();
        masks[2] = try m.u32le();
        if (header_size >= 56 or compression == 6) masks[3] = try m.u32le();
    } else if (compression != 0) return error.Unsupported;
    if (bpp == 32 and compression == 0) masks[3] = 0xFF000000;

    var palette: [256][4]u8 = @splat(.{ 0, 0, 0, 255 });
    if (bpp <= 8) {
        const n: usize = if (colors_used == 0) @as(usize, 1) << @intCast(bpp) else @min(colors_used, 256);
        var p = Cursor{ .data = data, .pos = 14 + @as(usize, header_size) };
        for (0..n) |i| {
            const e = try p.bytes(4);
            palette[i] = .{ e[2], e[1], e[0], 255 };
        }
    } else if (bpp != 24 and bpp != 32 and bpp != 16) return error.Unsupported;
    if (bpp != 1 and bpp != 4 and bpp != 8 and bpp != 16 and bpp != 24 and bpp != 32) return error.Unsupported;

    const stride = ((@as(usize, w) * bpp + 31) / 32) * 4;
    const needed = std.math.mul(usize, stride, h) catch return error.Invalid;
    if (pixel_offset > data.len or data.len - pixel_offset < needed) return error.Truncated;
    const pixels = data[pixel_offset..][0..needed];

    const out = common.allocRgba(gpa, w, h) orelse return error.OutOfMemory;
    errdefer gpa.free(out);
    var any_alpha = false;
    for (0..h) |y| {
        const src_row = pixels[(if (top_down) y else h - 1 - y) * stride ..][0..stride];
        for (0..w) |x| {
            const dst = out[(y * w + x) * 4 ..][0..4];
            switch (bpp) {
                1, 4, 8 => {
                    const per = 8 / bpp;
                    const byte = src_row[x / per];
                    const shift: u3 = @intCast(8 - bpp * (1 + x % per));
                    const idx = (byte >> shift) & @as(u8, @intCast((@as(u16, 1) << @intCast(bpp)) - 1));
                    dst.* = palette[idx];
                },
                24 => dst.* = .{ src_row[x * 3 + 2], src_row[x * 3 + 1], src_row[x * 3], 255 },
                16, 32 => {
                    const v: u32 = if (bpp == 32) std.mem.readInt(u32, src_row[x * 4 ..][0..4], .little) else std.mem.readInt(u16, src_row[x * 2 ..][0..2], .little);
                    const m16 = if (bpp == 16 and compression == 0) [4]u32{ 0x7C00, 0x03E0, 0x001F, 0 } else masks;
                    dst.* = .{ field(v, m16[0]), field(v, m16[1]), field(v, m16[2]), if (m16[3] != 0) field(v, m16[3]) else 255 };
                    if (m16[3] != 0 and dst[3] != 0) any_alpha = true;
                },
                else => unreachable,
            }
        }
    }
    // 32-bit BI_RGB files often leave alpha zeroed: treat all-zero as opaque
    if (bpp == 32 and !any_alpha) {
        var i: usize = 3;
        while (i < out.len) : (i += 4) out[i] = 255;
    }
    common.premultiply(out);
    return .{ .w = w, .h = h, .px = out };
}

/// Extract the channel selected by `mask` and scale it to 8 bits.
fn field(v: u32, mask: u32) u8 {
    if (mask == 0) return 0;
    const shift: u5 = @intCast(@ctz(mask));
    // the mask's span, so non-contiguous (malformed) masks still stay in range
    const max: u64 = mask >> shift;
    const raw: u64 = (v & mask) >> shift;
    return @intCast(@min(255, (raw * 255 + max / 2) / max));
}
