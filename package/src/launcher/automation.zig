const std = @import("std");

pub const launcher_flag = "--automation";
pub const environment_variable = "ELECTROBUN_WEBKIT_AUTOMATION";
pub const inspector_server_environment_variable = "WEBKIT_INSPECTOR_SERVER";
pub const private_inspector_server_environment_variable =
    "ELECTROBUN_WEBKIT_AUTOMATION_INSPECTOR_SERVER";

/// WebKitGTK automation is deliberately opt-in. The launcher consumes this
/// exact flag and translates it into a private child-process environment
/// marker so it does not become an argument to the application's main process.
pub fn requested(args: []const []const u8) bool {
    if (args.len < 2) return false;

    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, launcher_flag)) return true;
    }
    return false;
}

test "automation requires the exact launcher flag" {
    try std.testing.expect(!requested(&.{"launcher"}));
    try std.testing.expect(requested(&.{ "launcher", "--automation" }));
    try std.testing.expect(requested(&.{ "launcher", "app-url", "--automation" }));

    try std.testing.expect(!requested(&.{ "launcher", "automation" }));
    try std.testing.expect(!requested(&.{ "launcher", "--automation=true" }));
    try std.testing.expect(!requested(&.{ "launcher", "--automation-port=4444" }));
    try std.testing.expect(!requested(&.{ "--automation", "app-url" }));
}
