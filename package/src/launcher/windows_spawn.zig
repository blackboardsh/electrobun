const std = @import("std");

/// Build the compact command line used by the Windows production launcher.
/// Every launcher-owned argument is a filesystem path; quotes are impossible
/// in Windows path components, so rejecting them keeps escaping unambiguous.
pub fn commandLine(allocator: std.mem.Allocator, argv: []const []const u8) ![:0]u8 {
    if (argv.len == 0) return error.InvalidArguments;
    var byte_len: usize = 0;
    for (argv, 0..) |arg, index| {
        if (std.mem.indexOfScalar(u8, arg, '"') != null or
            std.mem.indexOfScalar(u8, arg, 0) != null)
        {
            return error.InvalidArguments;
        }
        byte_len = try std.math.add(usize, byte_len, arg.len + 2);
        if (index != 0) byte_len = try std.math.add(usize, byte_len, 1);
    }

    const result = try allocator.allocSentinel(u8, byte_len, 0);
    var cursor: usize = 0;
    for (argv, 0..) |arg, index| {
        if (index != 0) {
            result[cursor] = ' ';
            cursor += 1;
        }
        result[cursor] = '"';
        cursor += 1;
        @memcpy(result[cursor..][0..arg.len], arg);
        cursor += arg.len;
        result[cursor] = '"';
        cursor += 1;
    }
    std.debug.assert(cursor == byte_len);
    return result;
}

test "Windows command line supports native and script main processes" {
    const allocator = std.testing.allocator;
    const native = try commandLine(allocator, &.{"C:\\Program Files\\Example\\main.exe"});
    defer allocator.free(native);
    try std.testing.expectEqualStrings("\"C:\\Program Files\\Example\\main.exe\"", native);

    const script = try commandLine(allocator, &.{
        "C:\\Program Files\\Example\\cottontail.exe",
        "C:\\Program Files\\Example\\Resources\\main.js",
    });
    defer allocator.free(script);
    try std.testing.expectEqualStrings(
        "\"C:\\Program Files\\Example\\cottontail.exe\" \"C:\\Program Files\\Example\\Resources\\main.js\"",
        script,
    );

    try std.testing.expectError(error.InvalidArguments, commandLine(allocator, &.{}));
    try std.testing.expectError(error.InvalidArguments, commandLine(allocator, &.{"bad\"path"}));
}
