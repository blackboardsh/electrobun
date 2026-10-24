//! Decoder tests against testdata/images (see gen.py there). Lossless
//! fixtures are checked pixel-exact against the generator's pattern on every
//! platform; JPEGs within a tolerance; and on macOS every fixture is also
//! compared with ImageIO's decode of the same bytes.
const std = @import("std");
const builtin = @import("builtin");
const testdata = @import("testdata");
const common = @import("common.zig");
const portable = @import("../platform/image_portable.zig");
const jpeg = @import("jpeg.zig");

const gpa = std.testing.allocator;
const W = 37;
const H = 29;
const fx = testdata.images;

fn pat(x: usize, y: usize) [4]u8 {
    return .{
        @intCast(x * 255 / (W - 1)),
        @intCast(y * 255 / (H - 1)),
        @intCast(((x * 7) ^ (y * 5)) & 255),
        @intCast((x * 11 + y * 17) & 255),
    };
}

fn smooth(x: usize, y: usize) [3]u8 {
    return .{ @intCast(x * 255 / (W - 1)), @intCast(y * 255 / (H - 1)), @intCast((x + y) * 255 / (W + H - 2)) };
}

fn paletteColor(i: usize) [4]u8 {
    return .{ @intCast((i * 37) & 255), @intCast((i * 91) & 255), @intCast((i * 13 + 40) & 255), 255 };
}

fn premul(c: [4]u8) [4]u8 {
    return .{ common.mulDiv255(c[0], c[3]), common.mulDiv255(c[1], c[3]), common.mulDiv255(c[2], c[3]), c[3] };
}

fn scaleTo8(v: u32, depth: u5) u8 {
    const max = (@as(u32, 1) << depth) - 1;
    return @intCast(v * 255 / max);
}

fn decodeOrFail(data: []const u8) !common.Decoded {
    return portable.decode(gpa, data) orelse error.DecodeFailed;
}

fn expectImage(data: []const u8, expected: *const fn (usize, usize) [4]u8) !void {
    const img = try decodeOrFail(data);
    defer gpa.free(img.px);
    try std.testing.expectEqual(@as(u32, W), img.w);
    try std.testing.expectEqual(@as(u32, H), img.h);
    for (0..H) |y| for (0..W) |x| {
        const got = img.px[(y * W + x) * 4 ..][0..4].*;
        const want = expected(x, y);
        if (!std.mem.eql(u8, &got, &want)) {
            std.debug.print("pixel ({d},{d}): got {any}, want {any}\n", .{ x, y, got, want });
            return error.TestUnexpectedResult;
        }
    };
}

fn grayExpect(comptime depth: u5) fn (usize, usize) [4]u8 {
    return struct {
        fn f(x: usize, y: usize) [4]u8 {
            const r: u32 = pat(x, y)[0];
            const g = if (depth == 16) @as(u8, @intCast(r)) else scaleTo8(r * ((@as(u32, 1) << depth) - 1) / 255, depth);
            return .{ g, g, g, 255 };
        }
    }.f;
}

fn paletteExpect(comptime depth: u5) fn (usize, usize) [4]u8 {
    return struct {
        fn f(x: usize, y: usize) [4]u8 {
            return paletteColor((x + 2 * y) % (@as(usize, 1) << depth));
        }
    }.f;
}

fn rgbaPremul(x: usize, y: usize) [4]u8 {
    return premul(pat(x, y));
}

fn rgbOpaque(x: usize, y: usize) [4]u8 {
    const p = pat(x, y);
    return .{ p[0], p[1], p[2], 255 };
}

fn grayAlpha(x: usize, y: usize) [4]u8 {
    const p = pat(x, y);
    return premul(.{ p[0], p[0], p[0], p[3] });
}

test "png: grayscale at every bit depth" {
    try expectImage(fx.g1_png, grayExpect(1));
    try expectImage(fx.g2_png, grayExpect(2));
    try expectImage(fx.g4_png, grayExpect(4));
    try expectImage(fx.g8_png, grayExpect(8));
    try expectImage(fx.g16_png, grayExpect(16));
}

test "png: gray+alpha, RGB, RGBA at 8 and 16 bits, interlaced" {
    try expectImage(fx.ga8_png, grayAlpha);
    try expectImage(fx.ga16_png, grayAlpha);
    try expectImage(fx.rgb8_png, rgbOpaque);
    try expectImage(fx.rgb16_png, rgbOpaque);
    try expectImage(fx.rgb8_i_png, rgbOpaque);
    try expectImage(fx.rgba8_png, rgbaPremul);
    try expectImage(fx.rgba16_png, rgbaPremul);
    try expectImage(fx.rgba8_i_png, rgbaPremul);
}

test "png: palettes and tRNS" {
    try expectImage(fx.p1_png, paletteExpect(1));
    try expectImage(fx.p2_png, paletteExpect(2));
    try expectImage(fx.p4_png, paletteExpect(4));
    try expectImage(fx.p8_png, paletteExpect(8));
    try expectImage(fx.p8_trns_png, struct {
        fn f(x: usize, y: usize) [4]u8 {
            const i = (x + 2 * y) % 256;
            var c = paletteColor(i);
            if (i < 200) c[3] = @intCast((i * 29) & 255);
            return premul(c);
        }
    }.f);
    try expectImage(fx.g8_trns_png, struct {
        fn f(x: usize, y: usize) [4]u8 {
            const g = pat(x, y)[0];
            return if (g == pat(18, 0)[0]) .{ 0, 0, 0, 0 } else .{ g, g, g, 255 };
        }
    }.f);
    try expectImage(fx.rgb8_trns_png, struct {
        fn f(x: usize, y: usize) [4]u8 {
            const p = pat(x, y);
            const k = pat(3, 4);
            return if (p[0] == k[0] and p[1] == k[1] and p[2] == k[2]) .{ 0, 0, 0, 0 } else .{ p[0], p[1], p[2], 255 };
        }
    }.f);
}

test "gif: first frame, transparency, interlacing" {
    try expectImage(fx.plain_gif, struct {
        fn f(x: usize, y: usize) [4]u8 {
            return paletteColor((x * 3 + y) % 64);
        }
    }.f);
    try expectImage(fx.interlaced_trns_gif, struct {
        fn f(x: usize, y: usize) [4]u8 {
            const i = (x * 3 + y) % 64;
            return if (i == 5) .{ 0, 0, 0, 0 } else paletteColor(i);
        }
    }.f);
}

test "bmp: 24-bit bottom-up and top-down, 32-bit V5 bitfields, palettes" {
    try expectImage(fx.rgb24_bmp, rgbOpaque);
    try expectImage(fx.rgb24_topdown_bmp, rgbOpaque);
    try expectImage(fx.argb32_v5_bmp, rgbaPremul);
    try expectImage(fx.pal8_bmp, paletteExpect(8));
    try expectImage(fx.pal4_bmp, paletteExpect(4));
    try expectImage(fx.pal1_bmp, paletteExpect(1));
}

/// Mean and max per-channel error against the smooth source pattern.
fn jpegError(data: []const u8, gray: bool) ![2]f32 {
    const img = try decodeOrFail(data);
    defer gpa.free(img.px);
    try std.testing.expectEqual(@as(u32, W), img.w);
    try std.testing.expectEqual(@as(u32, H), img.h);
    var sum: f32 = 0;
    var max: f32 = 0;
    for (0..H) |y| for (0..W) |x| {
        const s = smooth(x, y);
        const want: [3]f32 = if (gray) blk: {
            const l = 0.299 * @as(f32, @floatFromInt(s[0])) + 0.587 * @as(f32, @floatFromInt(s[1])) + 0.114 * @as(f32, @floatFromInt(s[2]));
            break :blk .{ l, l, l };
        } else .{ @floatFromInt(s[0]), @floatFromInt(s[1]), @floatFromInt(s[2]) };
        for (0..3) |c| {
            const e = @abs(@as(f32, @floatFromInt(img.px[(y * W + x) * 4 + c])) - want[c]);
            sum += e;
            max = @max(max, e);
        }
        try std.testing.expectEqual(@as(u8, 255), img.px[(y * W + x) * 4 + 3]);
    };
    return .{ sum / (W * H * 3), max };
}

test "jpeg: baseline, progressive, subsampling, restarts, grayscale, RGB" {
    // quality-92 encodes of a smooth gradient: mean error stays small, the
    // worst pixel is bounded by chroma subsampling at the image corners
    const cases = [_]struct { data: []const u8, gray: bool = false, max_mean: f32, max_err: f32 }{
        .{ .data = fx.base444_jpg, .max_mean = 1.5, .max_err = 8 },
        .{ .data = fx.base422_jpg, .max_mean = 2, .max_err = 16 },
        .{ .data = fx.base420_jpg, .max_mean = 2, .max_err = 16 },
        .{ .data = fx.prog444_jpg, .max_mean = 1.5, .max_err = 8 },
        .{ .data = fx.prog420_jpg, .max_mean = 2, .max_err = 16 },
        .{ .data = fx.restart420_jpg, .max_mean = 2, .max_err = 16 },
        .{ .data = fx.optimized_jpg, .max_mean = 2, .max_err = 16 },
        .{ .data = fx.rgb_jpg, .max_mean = 1.5, .max_err = 8 },
        .{ .data = fx.gray_jpg, .gray = true, .max_mean = 1.5, .max_err = 6 },
    };
    for (cases) |cs| {
        const e = try jpegError(cs.data, cs.gray);
        if (e[0] > cs.max_mean or e[1] > cs.max_err) {
            std.debug.print("jpeg error mean {d:.2} max {d:.0}\n", .{ e[0], e[1] });
            return error.TestUnexpectedResult;
        }
    }
    // progressive and baseline encodes of the same image decode alike
    const a = try decodeOrFail(fx.base420_jpg);
    defer gpa.free(a.px);
    const b = try decodeOrFail(fx.prog420_jpg);
    defer gpa.free(b.px);
    var maxd: u8 = 0;
    for (a.px, b.px) |p, q| maxd = @max(maxd, if (p > q) p - q else q - p);
    try std.testing.expect(maxd <= 2);
}

test "jpeg: arithmetic coding is rejected, EXIF orientation is applied" {
    try std.testing.expect(portable.decode(gpa, fx.arith_jpg) == null);
    const base = try decodeOrFail(fx.base444_jpg);
    defer gpa.free(base.px);
    const rot = try decodeOrFail(fx.orient6_jpg);
    defer gpa.free(rot.px);
    // orientation 6: rotate 90° clockwise
    try std.testing.expectEqual(@as(u32, H), rot.w);
    try std.testing.expectEqual(@as(u32, W), rot.h);
    for (0..H) |y| for (0..W) |x| {
        const src = base.px[(y * W + x) * 4 ..][0..4];
        const dst = rot.px[(x * H + (H - 1 - y)) * 4 ..][0..4];
        try std.testing.expectEqualSlices(u8, src, dst);
    };
}

const fixture_names = std.meta.declarations(fx);

const all_fixtures = blk: {
    var list: [fixture_names.len][]const u8 = undefined;
    for (fixture_names, 0..) |name, i| list[i] = @field(fx, name);
    break :blk list;
};

test "malformed input never crashes or leaks" {
    var prng = std.Random.DefaultPrng.init(0x5eed);
    const r = prng.random();
    for (all_fixtures) |data| {
        // every truncation length on a sparse grid, plus the tail
        var len: usize = 0;
        while (len < data.len) : (len += @max(1, data.len / 97)) {
            if (portable.decode(gpa, data[0..len])) |img| gpa.free(img.px);
        }
        // random byte mutations
        const buf = try gpa.dupe(u8, data);
        defer gpa.free(buf);
        for (0..60) |_| {
            @memcpy(buf, data);
            const flips = 1 + r.uintLessThan(usize, 6);
            for (0..flips) |_| buf[r.uintLessThan(usize, buf.len)] = r.int(u8);
            if (portable.decode(gpa, buf)) |img| gpa.free(img.px);
        }
    }
    // garbage and empty input
    try std.testing.expect(portable.decode(gpa, "") == null);
    try std.testing.expect(portable.decode(gpa, "\x89PNG\r\n\x1a\n") == null);
    try std.testing.expect(portable.decode(gpa, "\xFF\xD8\xFF") == null);
    try std.testing.expect(portable.decode(gpa, "GIF89a") == null);
}

test "matches ImageIO on macOS" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    const mac = @import("../platform/image_mac.zig");
    inline for (fixture_names) |name| {
        // ImageIO decodes arithmetic JPEGs (we reject them) and ignores EXIF
        // orientation (we apply it, like browsers)
        if (comptime std.mem.eql(u8, name, "arith_jpg") or std.mem.eql(u8, name, "orient6_jpg")) continue;
        const data = @field(fx, name);
        const ours = portable.decode(gpa, data) orelse {
            std.debug.print("{s}: portable decode failed\n", .{name});
            return error.TestUnexpectedResult;
        };
        defer gpa.free(ours.px);
        const theirs = mac.decode(gpa, data) orelse {
            std.debug.print("{s}: ImageIO decode failed\n", .{name});
            return error.TestUnexpectedResult;
        };
        defer gpa.free(theirs.px);
        try std.testing.expectEqual(theirs.w, ours.w);
        try std.testing.expectEqual(theirs.h, ours.h);
        const is_jpeg = comptime std.mem.endsWith(u8, name, "_jpg");
        var maxd: u8 = 0;
        var sum: u64 = 0;
        for (ours.px, theirs.px) |p, q| {
            const diff = if (p > q) p - q else q - p;
            maxd = @max(maxd, diff);
            sum += diff;
        }
        const mean = @as(f32, @floatFromInt(sum)) / @as(f32, @floatFromInt(ours.px.len));
        // lossless formats: identical up to premultiplication rounding;
        // JPEG: IDCT and upsampling rounding differences only
        const ok = if (is_jpeg) maxd <= 6 and mean <= 0.6 else maxd <= 1;
        if (!ok) {
            std.debug.print("{s}: max diff {d}, mean {d:.3}\n", .{ name, maxd, mean });
            return error.TestUnexpectedResult;
        }
    }
}
