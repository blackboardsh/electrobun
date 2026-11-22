const std = @import("std");

/// Serialize the executable path and application arguments for CreateProcessW.
/// argv[0] uses the executable-path grammar; subsequent arguments use Windows
/// CRT quoting, including doubled backslashes before quotes and at the end of
/// a quoted argument. No command shell participates in this launch.
pub fn commandLine(allocator: std.mem.Allocator, argv: []const []const u8) ![:0]u8 {
    if (argv.len == 0) return error.InvalidArguments;
    if (std.mem.indexOfScalar(u8, argv[0], '"') != null) return error.InvalidArguments;
    for (argv) |arg| {
        if (std.mem.indexOfScalar(u8, arg, 0) != null) return error.InvalidArguments;
    }

    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);
    try result.append(allocator, '"');
    try result.appendSlice(allocator, argv[0]);
    try result.append(allocator, '"');

    for (argv[1..]) |arg| {
        try result.appendSlice(allocator, " \"");
        var backslashes: usize = 0;
        for (arg) |byte| {
            switch (byte) {
                '\\' => backslashes += 1,
                '"' => {
                    try result.appendNTimes(allocator, '\\', backslashes * 2 + 1);
                    try result.append(allocator, '"');
                    backslashes = 0;
                },
                else => {
                    try result.appendNTimes(allocator, '\\', backslashes);
                    try result.append(allocator, byte);
                    backslashes = 0;
                },
            }
        }
        try result.appendNTimes(allocator, '\\', backslashes * 2);
        try result.append(allocator, '"');
    }
    return result.toOwnedSliceSentinel(allocator, 0);
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
    try std.testing.expectError(error.InvalidArguments, commandLine(allocator, &.{ "main", "nul\x00arg" }));
}

test "Windows command line round trips arbitrary app arguments" {
    const allocator = std.testing.allocator;
    const expected = [_][]const u8{
        "C:\\Program Files\\Example\\main.exe",
        "--headless",
        "",
        "spaces and\ttabs",
        "é and 𐐷",
        "C:\\trailing slash\\",
        "double trailing\\\\",
        "\"quoted\"",
        "slash before\\\"quote",
        "double slash before\\\\\"quote",
        "quote then slash\"\\",
        "--",
        "&<>|%PATH%",
    };
    const serialized = try commandLine(allocator, &expected);
    defer allocator.free(serialized);
    const wide = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, serialized);
    defer allocator.free(wide);
    var iterator = try std.process.Args.Iterator.Windows.init(allocator, wide);
    defer iterator.deinit();
    for (expected) |arg| try std.testing.expectEqualStrings(arg, iterator.next().?);
    try std.testing.expect(iterator.next() == null);
}
