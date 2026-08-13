const std = @import("std");

pub const Platform = enum {
    macos,
    windows,
    linux,
};

pub const Request = struct {
    quiet: bool = false,
    delete_data: bool = false,
};

pub const InstallIdentity = struct {
    identifier: []const u8,
    channel: []const u8,
};

pub const Environment = struct {
    home: ?[]const u8 = null,
    local_appdata: ?[]const u8 = null,
    xdg_data_home: ?[]const u8 = null,
};

fn isSafePathComponent(value: []const u8) bool {
    return value.len != 0 and
        !std.mem.eql(u8, value, ".") and
        !std.mem.eql(u8, value, "..") and
        std.mem.indexOfAny(u8, value, "/\\\x00") == null;
}

/// Recognize only the launcher's public uninstall command. Anything outside
/// this compact grammar remains an application argument.
pub fn parseRequest(args: []const []const u8) ?Request {
    if (args.len < 2 or !std.mem.eql(u8, args[1], "--uninstall")) return null;

    var request = Request{};
    for (args[2..]) |arg| {
        if (std.mem.eql(u8, arg, "--quiet") and !request.quiet) {
            request.quiet = true;
        } else if (std.mem.eql(u8, arg, "--delete-data") and !request.delete_data) {
            request.delete_data = true;
        } else {
            return null;
        }
    }
    return request;
}

pub fn parseInstallIdentity(allocator: std.mem.Allocator, version_json: []const u8) !InstallIdentity {
    const parsed = try std.json.parseFromSlice(
        struct {
            identifier: []const u8,
            channel: []const u8,
        },
        allocator,
        version_json,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();

    if (!isSafePathComponent(parsed.value.identifier) or !isSafePathComponent(parsed.value.channel)) {
        return error.InvalidInstallIdentity;
    }

    return .{
        .identifier = try allocator.dupe(u8, parsed.value.identifier),
        .channel = try allocator.dupe(u8, parsed.value.channel),
    };
}

pub fn appDataBase(allocator: std.mem.Allocator, platform: Platform, environment: Environment) ![]u8 {
    return switch (platform) {
        .macos => macosAppDataBase(
            allocator,
            environment.home orelse return error.EnvironmentVariableNotFound,
        ),
        .windows => allocator.dupe(u8, environment.local_appdata orelse return error.EnvironmentVariableNotFound),
        .linux => if (environment.xdg_data_home) |xdg_data_home|
            allocator.dupe(u8, xdg_data_home)
        else blk: {
            const home = environment.home orelse return error.EnvironmentVariableNotFound;
            break :blk std.fs.path.join(allocator, &.{ home, ".local", "share" });
        },
    } catch |err| return err;
}

pub fn macosAppDataBase(allocator: std.mem.Allocator, home: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ home, "Library", "Application Support" });
}

pub fn channelRootPath(
    allocator: std.mem.Allocator,
    app_data_base: []const u8,
    identity: InstallIdentity,
) ![]u8 {
    return std.fs.path.join(allocator, &.{ app_data_base, identity.identifier, identity.channel });
}

pub fn managerName(platform: Platform) []const u8 {
    return if (platform == .windows) "uninstall.exe" else "uninstall";
}

pub fn versionJsonPath(allocator: std.mem.Allocator, exe_dir: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ exe_dir, "..", "Resources", "version.json" });
}

test "uninstall parser accepts only the exact supported grammar" {
    const plain = parseRequest(&.{ "launcher", "--uninstall" }).?;
    try std.testing.expect(!plain.quiet);
    try std.testing.expect(!plain.delete_data);

    const both = parseRequest(&.{ "launcher", "--uninstall", "--delete-data", "--quiet" }).?;
    try std.testing.expect(both.quiet);
    try std.testing.expect(both.delete_data);

    try std.testing.expect(parseRequest(&.{"--uninstall"}) == null);
    try std.testing.expect(parseRequest(&.{ "launcher", "uninstall" }) == null);
    try std.testing.expect(parseRequest(&.{ "launcher", "--uninstall=true" }) == null);
    try std.testing.expect(parseRequest(&.{ "launcher", "--uninstall", "--quiet", "--quiet" }) == null);
    try std.testing.expect(parseRequest(&.{ "launcher", "--uninstall", "--other" }) == null);
    try std.testing.expect(parseRequest(&.{ "launcher", "--uninstall", "--quiet", "app-url" }) == null);
}

test "uninstall metadata and channel-root paths are derived independently of the app" {
    const allocator = std.testing.allocator;
    const identity = try parseInstallIdentity(
        allocator,
        \\{"identifier":"com.example.app","channel":"canary","version":"1.2.3"}
    );
    defer allocator.free(identity.identifier);
    defer allocator.free(identity.channel);

    const macos_base = try appDataBase(allocator, .macos, .{ .home = "/Users/test" });
    defer allocator.free(macos_base);
    try std.testing.expectEqualStrings("/Users/test/Library/Application Support", macos_base);

    const macos_root = try channelRootPath(allocator, macos_base, identity);
    defer allocator.free(macos_root);
    try std.testing.expectEqualStrings(
        "/Users/test/Library/Application Support/com.example.app/canary",
        macos_root,
    );

    const windows_base = try appDataBase(allocator, .windows, .{ .local_appdata = "C:/Users/test/AppData/Local" });
    defer allocator.free(windows_base);
    try std.testing.expectEqualStrings("C:/Users/test/AppData/Local", windows_base);

    const linux_xdg_base = try appDataBase(allocator, .linux, .{ .xdg_data_home = "/state/data" });
    defer allocator.free(linux_xdg_base);
    try std.testing.expectEqualStrings("/state/data", linux_xdg_base);

    const linux_fallback_base = try appDataBase(allocator, .linux, .{ .home = "/home/test" });
    defer allocator.free(linux_fallback_base);
    try std.testing.expectEqualStrings("/home/test/.local/share", linux_fallback_base);

    try std.testing.expectEqualStrings("uninstall", managerName(.macos));
    try std.testing.expectEqualStrings("uninstall.exe", managerName(.windows));

    const version_path = try versionJsonPath(allocator, "/Bundle/Contents/MacOS");
    defer allocator.free(version_path);
    try std.testing.expectEqualStrings("/Bundle/Contents/MacOS/../Resources/version.json", version_path);
}

test "uninstall metadata requires identifier and channel" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(
        error.InvalidInstallIdentity,
        parseInstallIdentity(allocator, "{\"identifier\":\"\",\"channel\":\"production\"}"),
    );
    try std.testing.expectError(
        error.InvalidInstallIdentity,
        parseInstallIdentity(allocator, "{\"identifier\":\"com.example.app\",\"channel\":\"\"}"),
    );
    try std.testing.expectError(
        error.InvalidInstallIdentity,
        parseInstallIdentity(allocator, "{\"identifier\":\"../other\",\"channel\":\"production\"}"),
    );
}
