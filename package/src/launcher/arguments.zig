const std = @import("std");
const automation = @import("automation.zig");

/// Prefix the application's arguments with its native executable or runtime
/// and script. Uninstall requests have already been handled by the caller.
/// The exact automation flag remains private to the launcher on all platforms.
/// Strings are borrowed from the input; the caller owns the returned slice.
pub fn childArgv(
    allocator: std.mem.Allocator,
    command: []const []const u8,
    launcher_args: []const []const u8,
) ![][]const u8 {
    var result: std.ArrayList([]const u8) = .empty;
    errdefer result.deinit(allocator);
    try result.appendSlice(allocator, command);
    if (launcher_args.len > 1) {
        for (launcher_args[1..]) |arg| {
            if (std.mem.eql(u8, arg, automation.launcher_flag)) continue;
            try result.append(allocator, arg);
        }
    }
    return result.toOwnedSlice(allocator);
}

test "native app arguments retain order and exact values" {
    const args = try childArgv(std.testing.allocator, &.{"/app/bin/main"}, &.{
        "launcher", "--headless",        "--settings-file",
        "a path/é.json",
        "",         "quote\"and\\slash", "--",
        "tail",
    });
    defer std.testing.allocator.free(args);
    try std.testing.expectEqualDeep(&[_][]const u8{
        "/app/bin/main", "--headless",        "--settings-file",
        "a path/é.json",
        "",              "quote\"and\\slash", "--",
        "tail",
    }, args);
}

test "script arguments follow the script and consume only exact automation flags" {
    const args = try childArgv(std.testing.allocator, &.{ "/app/bin/bun", "/app/Resources/main.js" }, &.{
        "launcher", "--automation", "--headless", "--automation=true", "--automation", "--uninstall-option",
    });
    defer std.testing.allocator.free(args);
    try std.testing.expectEqualDeep(&[_][]const u8{
        "/app/bin/bun", "/app/Resources/main.js", "--headless", "--automation=true", "--uninstall-option",
    }, args);
}

test "launch without app arguments preserves the runtime command" {
    const args = try childArgv(std.testing.allocator, &.{"main"}, &.{"launcher"});
    defer std.testing.allocator.free(args);
    try std.testing.expectEqualDeep(&[_][]const u8{"main"}, args);
}
