//! Pure-Zig image decoding (PNG, JPEG, GIF, BMP), dispatched by magic
//! bytes. Used on Windows and Linux, and on macOS when
//! ELECTROBUN_UI_PORTABLE_IMAGES=1 (ImageIO is the default there).
const std = @import("std");
const common = @import("../image/common.zig");
const png = @import("../image/png.zig");
const jpeg = @import("../image/jpeg.zig");
const gif = @import("../image/gif.zig");
const bmp = @import("../image/bmp.zig");

pub const Decoded = common.Decoded;

pub fn decode(gpa: std.mem.Allocator, data: []const u8) ?Decoded {
    if (png.isPng(data)) return png.decode(gpa, data);
    if (jpeg.isJpeg(data)) return jpeg.decode(gpa, data);
    if (gif.isGif(data)) return gif.decode(gpa, data);
    if (bmp.isBmp(data)) return bmp.decode(gpa, data);
    return null;
}

test {
    _ = @import("../image/tests.zig");
}
