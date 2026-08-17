const std = @import("std");
const builtin = @import("builtin");

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

pub const InstallMetadata = struct {
    identifier: []const u8,
    channel: []const u8,
    name: ?[]const u8,
    display_name: ?[]const u8,
    hash: ?[]const u8,

    pub fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.identifier);
        allocator.free(self.channel);
        if (self.name) |value| allocator.free(value);
        if (self.display_name) |value| allocator.free(value);
        if (self.hash) |value| allocator.free(value);
        self.* = undefined;
    }

    pub fn identity(self: *const @This()) InstallIdentity {
        return .{ .identifier = self.identifier, .channel = self.channel };
    }
};

pub const Environment = struct {
    home: ?[]const u8 = null,
    local_appdata: ?[]const u8 = null,
    xdg_data_home: ?[]const u8 = null,
};

pub const install_root_name_environment_variable = "ELECTROBUN_INSTALL_ROOT_NAME";

pub fn isSafePathComponent(value: []const u8) bool {
    if (value.len == 0 or value.len > 256 or
        std.mem.eql(u8, value, ".") or std.mem.eql(u8, value, "..")) return false;
    for (value) |byte| {
        if (byte < 0x20 or byte == 0x7f or byte == '/' or byte == '\\') return false;
    }
    return true;
}

pub fn isSafeInstallRootName(value: []const u8, platform: Platform) bool {
    if (!isSafePathComponent(value)) return false;
    if (platform != .windows) return true;
    if (value[value.len - 1] == ' ' or value[value.len - 1] == '.') return false;
    return std.mem.indexOfAny(u8, value, "\"%*:<>?|") == null;
}

/// Recognize only the launcher's public uninstall command. Anything outside
/// this compact grammar remains an application argument, while a malformed
/// command that starts with the exact `--uninstall` token is rejected instead
/// of being forwarded to the application runtime.
pub fn parseRequest(args: []const []const u8) !?Request {
    if (args.len < 2 or !std.mem.eql(u8, args[1], "--uninstall")) return null;

    return switch (args.len) {
        2 => Request{},
        3 => if (std.mem.eql(u8, args[2], "--quiet"))
            Request{ .quiet = true }
        else
            error.InvalidArguments,
        4 => if (std.mem.eql(u8, args[2], "--quiet") and
            std.mem.eql(u8, args[3], "--delete-data"))
            Request{ .quiet = true, .delete_data = true }
        else
            error.InvalidArguments,
        else => error.InvalidArguments,
    };
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

pub fn parseInstallMetadata(allocator: std.mem.Allocator, version_json: []const u8) !InstallMetadata {
    const parsed = try std.json.parseFromSlice(
        struct {
            identifier: []const u8,
            channel: []const u8,
            name: ?[]const u8 = null,
            displayName: ?[]const u8 = null,
            hash: ?[]const u8 = null,
        },
        allocator,
        version_json,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();

    if (!isSafePathComponent(parsed.value.identifier) or
        !isSafePathComponent(parsed.value.channel) or
        (parsed.value.name != null and !isSafePathComponent(parsed.value.name.?)) or
        (parsed.value.displayName != null and !isSafePathComponent(parsed.value.displayName.?)) or
        (parsed.value.hash != null and !isSafePathComponent(parsed.value.hash.?)))
    {
        return error.InvalidInstallIdentity;
    }

    const identifier = try allocator.dupe(u8, parsed.value.identifier);
    errdefer allocator.free(identifier);
    const channel = try allocator.dupe(u8, parsed.value.channel);
    errdefer allocator.free(channel);
    const name = if (parsed.value.name) |value| try allocator.dupe(u8, value) else null;
    errdefer if (name) |value| allocator.free(value);
    const display_name = if (parsed.value.displayName) |value| try allocator.dupe(u8, value) else null;
    errdefer if (display_name) |value| allocator.free(value);
    const hash = if (parsed.value.hash) |value| try allocator.dupe(u8, value) else null;
    return .{
        .identifier = identifier,
        .channel = channel,
        .name = name,
        .display_name = display_name,
        .hash = hash,
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

/// Resolve the channel root from the installed launcher's physical layout.
/// Windows and Linux use `<identifier>/<root-name>/app/bin/launcher`.
///
/// `root-name` intentionally does not have to equal `version.json.channel`.
/// Electrobun v1 called production `stable`, and early macOS releases used a
/// display-name-derived root. The physical root is the durable profile and
/// uninstall scope when those apps update to v2.
pub fn channelRootFromLauncherPath(
    allocator: std.mem.Allocator,
    platform: Platform,
    launcher_path: []const u8,
    identity: InstallIdentity,
) ![]u8 {
    if (!isSafePathComponent(identity.identifier) or !isSafePathComponent(identity.channel)) {
        return error.InvalidInstallIdentity;
    }
    if (platform == .macos) return error.InvalidInstallLocation;
    const expected_launcher = if (platform == .windows) "launcher.exe" else "launcher";
    if (!std.fs.path.isAbsolute(launcher_path) or
        !std.mem.eql(u8, std.fs.path.basename(launcher_path), expected_launcher))
    {
        return error.InvalidInstallLocation;
    }
    var components = std.mem.splitAny(u8, launcher_path, "/\\");
    while (components.next()) |component| {
        if (std.mem.eql(u8, component, ".") or std.mem.eql(u8, component, "..")) {
            return error.InvalidInstallLocation;
        }
    }

    const channel_root = switch (platform) {
        .windows, .linux => blk: {
            const bin_dir = std.fs.path.dirname(launcher_path) orelse return error.InvalidInstallLocation;
            if (!std.mem.eql(u8, std.fs.path.basename(bin_dir), "bin")) return error.InvalidInstallLocation;
            const app_dir = std.fs.path.dirname(bin_dir) orelse return error.InvalidInstallLocation;
            if (!std.mem.eql(u8, std.fs.path.basename(app_dir), "app")) return error.InvalidInstallLocation;
            break :blk std.fs.path.dirname(app_dir) orelse return error.InvalidInstallLocation;
        },
        .macos => unreachable,
    };
    if (!isSafeInstallRootName(std.fs.path.basename(channel_root), platform)) return error.InvalidInstallLocation;
    const identifier_root = std.fs.path.dirname(channel_root) orelse return error.InvalidInstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(identifier_root), identity.identifier) or
        std.fs.path.dirname(identifier_root) == null)
    {
        return error.InvalidInstallLocation;
    }
    return allocator.dupe(u8, channel_root);
}

fn isRegularFile(io: std.Io, path: []const u8) bool {
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch return false;
    return stat.kind == .file;
}

pub fn bootstrapRequired(
    allocator: std.mem.Allocator,
    io: std.Io,
    channel_root: []const u8,
    platform: Platform,
) !bool {
    const manager_path = try std.fs.path.join(allocator, &.{ channel_root, managerName(platform) });
    defer allocator.free(manager_path);
    const manifest_path = try std.fs.path.join(allocator, &.{ channel_root, ".electrobun-uninstall.json" });
    defer allocator.free(manifest_path);
    return !isRegularFile(io, manager_path) or !isRegularFile(io, manifest_path);
}

/// macOS installs the app bundle under /Applications, separately from its
/// updater/profile state. Probe the known v2 and v1 state roots using durable
/// files written by the installer instead of guessing from the app path.
pub fn macosChannelRootFromMetadata(
    allocator: std.mem.Allocator,
    io: std.Io,
    app_data_base: []const u8,
    metadata: *const InstallMetadata,
) ![]u8 {
    const identifier_root = try std.fs.path.join(allocator, &.{ app_data_base, metadata.identifier });
    defer allocator.free(identifier_root);

    var candidates: [4]?[]u8 = .{ null, null, null, null };
    var count: usize = 0;
    defer for (candidates[0..count]) |candidate| allocator.free(candidate.?);

    candidates[count] = try std.fs.path.join(allocator, &.{ identifier_root, metadata.channel });
    count += 1;
    if (std.mem.eql(u8, metadata.channel, "production")) {
        candidates[count] = try std.fs.path.join(allocator, &.{ identifier_root, "stable" });
        count += 1;
    }
    if (metadata.name) |name| {
        candidates[count] = try std.fs.path.join(allocator, &.{ identifier_root, name });
        count += 1;
    }
    if (metadata.display_name) |display_name| {
        const legacy_name = if (std.mem.eql(u8, metadata.channel, "production"))
            try allocator.dupe(u8, display_name)
        else
            try std.fmt.allocPrint(allocator, "{s}-{s}", .{ display_name, metadata.channel });
        defer allocator.free(legacy_name);
        if (isSafeInstallRootName(legacy_name, .macos) and count < candidates.len) {
            candidates[count] = try std.fs.path.join(allocator, &.{ identifier_root, legacy_name });
            count += 1;
        }
    }

    if (metadata.hash) |hash| {
        const tar_filename = try std.fmt.allocPrint(allocator, "{s}.tar", .{hash});
        defer allocator.free(tar_filename);
        for (candidates[0..count]) |candidate| {
            const retained_tar = try std.fs.path.join(
                allocator,
                &.{ candidate.?, "self-extraction", tar_filename },
            );
            defer allocator.free(retained_tar);
            if (isRegularFile(io, retained_tar)) return allocator.dupe(u8, candidate.?);
        }
    }
    for (candidates[0..count]) |candidate| {
        const manifest = try std.fs.path.join(allocator, &.{ candidate.?, ".electrobun-uninstall.json" });
        defer allocator.free(manifest);
        if (isRegularFile(io, manifest)) return allocator.dupe(u8, candidate.?);
    }
    return allocator.dupe(u8, candidates[0].?);
}

pub fn linuxChannelRootFromLauncherPath(
    allocator: std.mem.Allocator,
    launcher_path: []const u8,
    identity: InstallIdentity,
) ![]u8 {
    return channelRootFromLauncherPath(allocator, .linux, launcher_path, identity);
}

pub fn versionJsonPath(allocator: std.mem.Allocator, exe_dir: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ exe_dir, "..", "Resources", "version.json" });
}

test "uninstall parser accepts only the exact supported grammar" {
    const plain = (try parseRequest(&.{ "launcher", "--uninstall" })).?;
    try std.testing.expect(!plain.quiet);
    try std.testing.expect(!plain.delete_data);

    const quiet = (try parseRequest(&.{ "launcher", "--uninstall", "--quiet" })).?;
    try std.testing.expect(quiet.quiet);
    try std.testing.expect(!quiet.delete_data);

    const both = (try parseRequest(&.{ "launcher", "--uninstall", "--quiet", "--delete-data" })).?;
    try std.testing.expect(both.quiet);
    try std.testing.expect(both.delete_data);

    try std.testing.expect((try parseRequest(&.{"--uninstall"})) == null);
    try std.testing.expect((try parseRequest(&.{ "launcher", "uninstall" })) == null);
    try std.testing.expect((try parseRequest(&.{ "launcher", "--uninstall=true" })) == null);
    try std.testing.expect((try parseRequest(&.{ "launcher", "app-url", "--uninstall" })) == null);

    // Data deletion is an explicit unattended mode. Interactive callers make
    // that choice in the native prompt instead of bypassing it with a flag.
    const invalid = [_][]const []const u8{
        &.{ "launcher", "--uninstall", "--delete-data" },
        &.{ "launcher", "--uninstall", "--delete-data", "--quiet" },
        &.{ "launcher", "--uninstall", "--quiet", "--quiet" },
        &.{ "launcher", "--uninstall", "--other" },
        &.{ "launcher", "--uninstall", "--quiet", "app-url" },
        &.{ "launcher", "--uninstall", "--quiet", "--delete-data", "extra" },
    };
    for (invalid) |args| {
        try std.testing.expectError(error.InvalidArguments, parseRequest(args));
    }
}

test "installed root is bound to the physical launcher layout and identity" {
    const allocator = std.testing.allocator;
    const identity = InstallIdentity{
        .identifier = "com.example.app",
        .channel = "canary",
    };
    const channel_root = try linuxChannelRootFromLauncherPath(
        allocator,
        "/custom XDG data/com.example.app/stable/app/bin/launcher",
        identity,
    );
    defer allocator.free(channel_root);
    try std.testing.expectEqualStrings(
        "/custom XDG data/com.example.app/stable",
        channel_root,
    );

    if (builtin.os.tag == .windows) {
        const windows_root = try channelRootFromLauncherPath(
            allocator,
            .windows,
            "C:/Users/test/AppData/Local/com.example.app/stable/app/bin/launcher.exe",
            identity,
        );
        defer allocator.free(windows_root);
        try std.testing.expectEqualStrings(
            "C:/Users/test/AppData/Local/com.example.app/stable",
            windows_root,
        );
    }

    const invalid_paths = [_][]const u8{
        "relative/com.example.app/canary/app/bin/launcher",
        "/custom/com.example.app/canary/app/bin/not-launcher",
        "/custom/com.example.app/canary/app/not-bin/launcher",
        "/custom/com.example.app/canary/not-app/bin/launcher",
        "/custom/com.other.app/canary/app/bin/launcher",
        "/custom/com.example.app/canary/app/../app/bin/launcher",
    };
    for (invalid_paths) |path| {
        try std.testing.expectError(
            error.InvalidInstallLocation,
            linuxChannelRootFromLauncherPath(allocator, path, identity),
        );
    }
    try std.testing.expectError(
        error.InvalidInstallIdentity,
        linuxChannelRootFromLauncherPath(
            allocator,
            "/custom/com.example.app/canary/app/bin/launcher",
            .{ .identifier = "../com.example.app", .channel = "canary" },
        ),
    );
}

test "macOS state root preserves the v1 stable profile scope" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(std.testing.io, "com.example.app/stable");
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "com.example.app/stable/.electrobun-uninstall.json",
        .data = "{}",
    });
    const app_data_base = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(app_data_base);
    const metadata = InstallMetadata{
        .identifier = "com.example.app",
        .channel = "production",
        .name = "example-app",
        .display_name = "Example App",
        .hash = "currenthash",
    };
    const root = try macosChannelRootFromMetadata(
        std.testing.allocator,
        std.testing.io,
        app_data_base,
        &metadata,
    );
    defer std.testing.allocator.free(root);
    const expected = try std.fs.path.join(
        std.testing.allocator,
        &.{ app_data_base, "com.example.app", "stable" },
    );
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, root);
}

test "macOS state root finds the early v1 display-name layout by current tar" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(std.testing.io, "com.example.app/Example App/self-extraction");
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "com.example.app/Example App/self-extraction/currenthash.tar",
        .data = "current archive",
    });
    // A stale modern candidate must not win over the root that owns the
    // running version's retained archive.
    try tmp.dir.createDirPath(std.testing.io, "com.example.app/production");
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "com.example.app/production/.electrobun-uninstall.json",
        .data = "{}",
    });
    const app_data_base = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(app_data_base);
    const metadata = InstallMetadata{
        .identifier = "com.example.app",
        .channel = "production",
        .name = "example-app",
        .display_name = "Example App",
        .hash = "currenthash",
    };
    const root = try macosChannelRootFromMetadata(
        std.testing.allocator,
        std.testing.io,
        app_data_base,
        &metadata,
    );
    defer std.testing.allocator.free(root);
    const expected = try std.fs.path.join(
        std.testing.allocator,
        &.{ app_data_base, "com.example.app", "Example App" },
    );
    defer std.testing.allocator.free(expected);
    try std.testing.expectEqualStrings(expected, root);
}

test "bootstrap is required until both standalone install records exist" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(root);
    try std.testing.expect(try bootstrapRequired(
        std.testing.allocator,
        std.testing.io,
        root,
        .windows,
    ));
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "uninstall.exe", .data = "manager" });
    try std.testing.expect(try bootstrapRequired(
        std.testing.allocator,
        std.testing.io,
        root,
        .windows,
    ));
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = ".electrobun-uninstall.json", .data = "{}" });
    try std.testing.expect(!try bootstrapRequired(
        std.testing.allocator,
        std.testing.io,
        root,
        .windows,
    ));
}

test "uninstall metadata and channel-root paths are derived independently of the app" {
    const allocator = std.testing.allocator;
    const identity = try parseInstallIdentity(allocator,
        \\{"identifier":"com.example.app","channel":"canary","version":"1.2.3"}
    );
    defer allocator.free(identity.identifier);
    defer allocator.free(identity.channel);

    const macos_base = try appDataBase(allocator, .macos, .{ .home = "/Users/test" });
    defer allocator.free(macos_base);
    const expected_macos_base = try std.fs.path.join(allocator, &.{
        "/Users/test",
        "Library",
        "Application Support",
    });
    defer allocator.free(expected_macos_base);
    try std.testing.expectEqualStrings(expected_macos_base, macos_base);

    const macos_root = try channelRootPath(allocator, macos_base, identity);
    defer allocator.free(macos_root);
    const expected_macos_root = try std.fs.path.join(allocator, &.{
        expected_macos_base,
        "com.example.app",
        "canary",
    });
    defer allocator.free(expected_macos_root);
    try std.testing.expectEqualStrings(expected_macos_root, macos_root);

    const windows_base = try appDataBase(allocator, .windows, .{ .local_appdata = "C:/Users/test/AppData/Local" });
    defer allocator.free(windows_base);
    try std.testing.expectEqualStrings("C:/Users/test/AppData/Local", windows_base);

    const linux_xdg_base = try appDataBase(allocator, .linux, .{ .xdg_data_home = "/state/data" });
    defer allocator.free(linux_xdg_base);
    try std.testing.expectEqualStrings("/state/data", linux_xdg_base);

    const linux_fallback_base = try appDataBase(allocator, .linux, .{ .home = "/home/test" });
    defer allocator.free(linux_fallback_base);
    const expected_linux_fallback_base = try std.fs.path.join(allocator, &.{
        "/home/test",
        ".local",
        "share",
    });
    defer allocator.free(expected_linux_fallback_base);
    try std.testing.expectEqualStrings(expected_linux_fallback_base, linux_fallback_base);

    try std.testing.expectEqualStrings("uninstall", managerName(.macos));
    try std.testing.expectEqualStrings("uninstall.exe", managerName(.windows));

    const version_path = try versionJsonPath(allocator, "/Bundle/Contents/MacOS");
    defer allocator.free(version_path);
    const expected_version_path = try std.fs.path.join(allocator, &.{
        "/Bundle/Contents/MacOS",
        "..",
        "Resources",
        "version.json",
    });
    defer allocator.free(expected_version_path);
    try std.testing.expectEqualStrings(expected_version_path, version_path);
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
