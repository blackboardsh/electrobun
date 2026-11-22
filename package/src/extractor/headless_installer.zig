//! Small, noninteractive installer for the existing full update artifacts.
//! The executable contains public release configuration; private per-machine
//! settings arrive through a file or stdin and are never included in output.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const A = std.mem.Allocator;
const protocol = @import("updater_protocol");
const http = @import("prepare_update_http.zig");
// Frontend unit tests exercise the wire/CLI contract independently from the
// platform installer integration, which has its own extractor test suite.
const backend = if (builtin.is_test) struct {} else @import("main.zig");

pub const max_document_bytes = 1024 * 1024;
pub const slot_start = "ELECTROBUN_HEADLESS_CONFIG_V1_START";
pub const slot_end = "ELECTROBUN_HEADLESS_CONFIG_V1_END";
pub const slot_size = slot_start.len + 8 + max_document_bytes + slot_end.len;
// Hutch patches this fixed file-backed data before signing the app-specific
// executable. Appending a footer would invalidate Mach-O signing structure.
export var electrobun_headless_config_slot: [slot_size]u8 = blk: {
    var bytes: [slot_size]u8 = @splat(0);
    @memcpy(bytes[0..slot_start.len], slot_start);
    @memcpy(bytes[bytes.len - slot_end.len ..], slot_end);
    break :blk bytes;
};
const max_archive_bytes = 16 * 1024 * 1024 * 1024;

pub const Config = struct {
    schemaVersion: u32,
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    baseUrl: []const u8,
    platform: protocol.Platform,
    arch: protocol.Arch,
    defaults: ?std.json.Value = null,
};

const Options = struct {
    settings_file: ?[]const u8 = null,
    settings_stdin: bool = false,
    json: bool = false,
    help: bool = false,
};

fn parseOptions(args: []const []const u8) !Options {
    var options: Options = .{};
    var index: usize = 0;
    while (index < args.len) : (index += 1) {
        const arg = args[index];
        if (std.mem.eql(u8, arg, "--json")) {
            if (options.json) return error.InvalidArguments;
            options.json = true;
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            if (options.help) return error.InvalidArguments;
            options.help = true;
        } else if (std.mem.eql(u8, arg, "--settings-stdin")) {
            if (options.settings_stdin or options.settings_file != null) return error.InvalidArguments;
            options.settings_stdin = true;
        } else if (std.mem.eql(u8, arg, "--settings-file")) {
            if (options.settings_stdin or options.settings_file != null or index + 1 == args.len) return error.InvalidArguments;
            index += 1;
            if (args[index].len == 0 or std.mem.startsWith(u8, args[index], "--")) return error.InvalidArguments;
            options.settings_file = args[index];
        } else return error.InvalidArguments;
    }
    if (options.help and (options.settings_file != null or options.settings_stdin)) return error.InvalidArguments;
    return options;
}

pub fn slotJson(bytes: []const u8) ![]const u8 {
    if (bytes.len != slot_size or !std.mem.eql(u8, bytes[0..slot_start.len], slot_start) or
        !std.mem.eql(u8, bytes[bytes.len - slot_end.len ..], slot_end)) return error.InvalidInstallerConfiguration;
    const length = std.mem.readInt(u64, bytes[slot_start.len..][0..8], .little);
    if (length == 0 or length > max_document_bytes) return error.InvalidInstallerConfiguration;
    return bytes[slot_start.len + 8 ..][0..@intCast(length)];
}

fn validateConfig(config: Config, platform: protocol.Platform, arch: protocol.Arch) !void {
    if (config.schemaVersion != 1) return error.UnsupportedInstallerConfiguration;
    if (config.platform != platform or config.arch != arch) return error.InstallerTargetMismatch;
    // Separators are forbidden even on hosts where backslash is a legal name.
    if (!protocol.validIdentity(config.identifier, platform) or
        !protocol.validIdentity(config.name, platform) or
        std.mem.indexOfScalar(u8, config.identifier, '\\') != null or
        std.mem.indexOfScalar(u8, config.name, '\\') != null or
        !protocol.validChannel(config.channel)) return error.InvalidInstallerIdentity;
    if (config.defaults) |value| {
        if (value != .object) return error.InvalidInstallerDefaults;
        validateSettingsDepth(value, 0) catch return error.InvalidInstallerDefaults;
    }
    const uri = try http.checkedUri(config.baseUrl);
    if (uri.query != null) return error.InvalidUpdateUrl;
}

fn validateSettingsDepth(value: std.json.Value, depth: usize) !void {
    if (depth > 64) return error.InvalidSettingsDepth;
    switch (value) {
        .object => |object| {
            var iterator = object.iterator();
            while (iterator.next()) |entry| try validateSettingsDepth(entry.value_ptr.*, depth + 1);
        },
        .array => |array| for (array.items) |item| try validateSettingsDepth(item, depth + 1),
        else => {},
    }
}

fn parseSettings(a: A, bytes: []const u8) !std.json.Parsed(std.json.Value) {
    if (bytes.len > max_document_bytes) return error.SettingsTooLarge;
    var document = std.json.parseFromSlice(std.json.Value, a, bytes, .{ .allocate = .alloc_always, .parse_numbers = false }) catch return error.InvalidSettingsJson;
    errdefer document.deinit();
    if (document.value != .object) return error.InvalidSettingsObject;
    try validateSettingsDepth(document.value, 0);
    return document;
}

fn readConfig(a: A, io: Io) !std.json.Parsed(Config) {
    _ = io;
    const bytes = try a.alloc(u8, slot_size);
    defer a.free(bytes);
    // Volatile loads are intentional: these initialized bytes are patched after
    // compilation, so optimization must never substitute their original zeros.
    const source: [*]volatile u8 = @ptrCast(&electrobun_headless_config_slot);
    for (bytes, 0..) |*byte, index| byte.* = source[index];
    var document = std.json.parseFromSlice(Config, a, try slotJson(bytes), .{ .allocate = .alloc_always, .parse_numbers = false }) catch return error.InvalidInstallerConfiguration;
    errdefer document.deinit();
    try validateConfig(document.value, protocol.native_platform, protocol.native_arch);
    return document;
}

fn readSettings(a: A, io: Io, options: Options) !?std.json.Parsed(std.json.Value) {
    if (options.settings_file == null and !options.settings_stdin) return null;
    const file = if (options.settings_file) |path|
        try Io.Dir.cwd().openFile(io, path, .{ .allow_directory = false, .follow_symlinks = false })
    else
        Io.File.stdin();
    defer if (options.settings_file != null) file.close(io);
    if (options.settings_file != null) {
        const stat = try file.stat(io);
        if (stat.kind != .file) return error.InvalidSettingsFile;
        if (stat.size > max_document_bytes) return error.SettingsTooLarge;
    }
    var buffer: [4096]u8 = undefined;
    var reader = file.readerStreaming(io, &buffer);
    const bytes = reader.interface.allocRemaining(a, .limited(max_document_bytes)) catch |err| switch (err) {
        error.StreamTooLong => return error.SettingsTooLarge,
        error.ReadFailed => return reader.err orelse err,
        else => return err,
    };
    defer a.free(bytes);
    return try parseSettings(a, bytes);
}

fn fetchDocument(a: A, io: Io, url: []const u8) ![]u8 {
    const Context = struct {
        allocator: A,
        bytes: ?[]u8 = null,
        fn consume(pointer: *anyopaque, reader: *Io.Reader) !void {
            const self: *@This() = @ptrCast(@alignCast(pointer));
            self.bytes = try reader.allocRemaining(self.allocator, .limited(max_document_bytes));
        }
    };
    var context: Context = .{ .allocator = a };
    errdefer if (context.bytes) |bytes| a.free(bytes);
    try http.fetch(a, io, url, &context, Context.consume, .{ .max_bytes = max_document_bytes, .timeout_ms = 60_000 });
    return context.bytes orelse error.EmptyUpdateDownload;
}

fn documentUrl(a: A, config: Config, suffix: []const u8) ![]u8 {
    // All components after the base are validated enum/channel constants.
    return std.fmt.allocPrint(a, "{s}/{s}-{s}-{s}-{s}", .{
        std.mem.trimEnd(u8, config.baseUrl, "/"), config.channel, @tagName(config.platform), @tagName(config.arch), suffix,
    });
}

fn validateRelease(a: A, config: Config, manifest: protocol.Manifest) !void {
    try protocol.validateManifest(a, manifest, .{
        .identifier = config.identifier,
        .channel = config.channel,
        // No installed version exists yet. Local validation still checks
        // identity while the manifest carries the selected release version.
        .version = "0",
        .hash = "0",
        .baseUrl = config.baseUrl,
        .name = config.name,
    }, config.platform, config.arch);
}

fn validateIntegrity(manifest: protocol.Manifest, checksum: protocol.Checksum) !void {
    try protocol.validateChecksum(checksum);
    if (checksum.hash) |hash| {
        if (!std.mem.eql(u8, hash, manifest.hash)) return error.UpdateChecksumMismatch;
    } else return error.UpdateChecksumMismatch;
    if (checksum.tarSize < 1024 or checksum.tarSize % 512 != 0 or checksum.tarSize > max_archive_bytes)
        return error.InvalidUpdateArchiveIntegrity;
}

const Release = struct {
    manifest: std.json.Parsed(protocol.Manifest),
    checksum: ?std.json.Parsed(protocol.Checksum),
    tar_sha256: []const u8,
    tar_size: u64,

    fn deinit(self: *Release) void {
        if (self.checksum) |*checksum| checksum.deinit();
        self.manifest.deinit();
    }
};

fn resolveRelease(a: A, io: Io, config: Config) !Release {
    const manifest_url = try documentUrl(a, config, "update.json");
    defer a.free(manifest_url);
    const checksum_url = try documentUrl(a, config, "checksum.json");
    defer a.free(checksum_url);
    // A release publisher replaces two fixed-name documents. Retry a mismatched
    // pair, but never install an archive without integrity bound to its hash.
    for (0..3) |_| {
        const manifest_bytes = try fetchDocument(a, io, manifest_url);
        defer a.free(manifest_bytes);
        var manifest = try std.json.parseFromSlice(protocol.Manifest, a, manifest_bytes, .{ .allocate = .alloc_always });
        errdefer manifest.deinit();
        try validateRelease(a, config, manifest.value);
        if (manifest.value.artifact.tarSha256) |digest| {
            const checksum: protocol.Checksum = .{ .hash = manifest.value.hash, .tarSha256 = digest, .tarSize = manifest.value.artifact.tarSize.? };
            try validateIntegrity(manifest.value, checksum);
            return .{ .manifest = manifest, .checksum = null, .tar_sha256 = digest, .tar_size = checksum.tarSize };
        }
        const checksum_bytes = try fetchDocument(a, io, checksum_url);
        defer a.free(checksum_bytes);
        var checksum = try std.json.parseFromSlice(protocol.Checksum, a, checksum_bytes, .{ .allocate = .alloc_always });
        errdefer checksum.deinit();
        validateIntegrity(manifest.value, checksum.value) catch |err| {
            if (err != error.UpdateChecksumMismatch) return err;
            checksum.deinit();
            manifest.deinit();
            continue;
        };
        return .{ .manifest = manifest, .checksum = checksum, .tar_sha256 = checksum.value.tarSha256, .tar_size = checksum.value.tarSize };
    }
    return error.UpdateChecksumMismatch;
}

const Phase = enum { arguments, settings, configuration, release, installing, complete };

fn writeJson(io: Io, value: anytype) !void {
    var buffer: [4096]u8 = undefined;
    var writer = Io.File.stdout().writer(io, &buffer);
    try std.json.Stringify.value(value, .{}, &writer.interface);
    try writer.interface.writeByte('\n');
    try writer.interface.flush();
}

fn failure(io: Io, json: bool, phase: Phase, err: anyerror) u8 {
    const code: u8 = switch (err) {
        error.InvalidArguments, error.InvalidSettingsJson, error.InvalidSettingsObject, error.InvalidSettingsFile, error.InvalidSettingsDepth, error.SettingsTooLarge => 2,
        else => 1,
    };
    if (json) {
        writeJson(io, .{ .schemaVersion = @as(u32, 1), .success = false, .status = "failed", .phase = @tagName(phase), .@"error" = @errorName(err), .exitCode = code }) catch {};
    } else std.debug.print("Installation failed ({s}): {s}\n", .{ @tagName(phase), @errorName(err) });
    return code;
}

const help =
    \\Usage: Headless-Setup [--settings-file PATH | --settings-stdin] [--json]
    \\
    \\Install the latest configured release for this user without opening the app.
    \\  --settings-file PATH  Read an app-owned JSON object from a private file.
    \\  --settings-stdin      Read that JSON object from stdin (at most 1 MiB).
    \\  --json                Print one machine-readable result to stdout.
    \\  --help, -h            Show this help without downloading or installing.
    \\
    \\Settings are stored in the app's user-data install.json, outside its bundle.
    \\Existing settings survive a repeat install without supplied settings.
    \\Exit codes: 0 success; 1 installation failure; 2 invalid arguments/settings.
    \\
;

fn install(init: std.process.Init, options: Options, phase: *Phase) !void {
    const a = init.gpa;
    phase.* = .settings;
    var settings = try readSettings(a, init.io, options);
    defer if (settings) |*value| value.deinit();
    phase.* = .configuration;
    var config = try readConfig(a, init.io);
    defer config.deinit();
    phase.* = .release;
    var release = try resolveRelease(a, init.io, config.value);
    defer release.deinit();
    const artifact_url = try protocol.artifactUrl(a, config.value.baseUrl, release.manifest.value.artifact.file);
    defer a.free(artifact_url);
    phase.* = .installing;
    const result = try backend.headlessInstall(init, .{
        .identifier = config.value.identifier,
        .name = config.value.name,
        .channel = config.value.channel,
        .version = release.manifest.value.version,
        .hash = release.manifest.value.hash,
        .base_url = config.value.baseUrl,
        .artifact_url = artifact_url,
        .tar_sha256 = release.tar_sha256,
        .tar_size = release.tar_size,
        .defaults = config.value.defaults orelse .{ .object = .empty },
        .settings = if (settings) |value| value.value else null,
    });
    phase.* = .complete;
    if (options.json) {
        try writeJson(init.io, .{
            .schemaVersion = @as(u32, 1),
            .success = true,
            .status = "installed",
            .identifier = config.value.identifier,
            .channel = config.value.channel,
            .version = release.manifest.value.version,
            .hash = release.manifest.value.hash,
            .userData = result.user_data,
            .appPath = result.app_path,
            .launcherPath = result.launcher_path,
            .settingsPath = result.settings_path,
        });
    } else {
        var buffer: [4096]u8 = undefined;
        var writer = Io.File.stdout().writer(init.io, &buffer);
        try writer.interface.print("Installed {s} {s} ({s}).\nLauncher: {s}\nSettings: {s}\n", .{ config.value.name, release.manifest.value.version, config.value.channel, result.launcher_path, result.settings_path });
        try writer.interface.flush();
    }
}

pub fn main(original_init: std.process.Init) u8 {
    var arena: std.heap.ArenaAllocator = .init(original_init.gpa);
    defer arena.deinit();
    var init = original_init;
    init.gpa = arena.allocator();
    var args: std.ArrayList([]const u8) = .empty;
    var iterator = std.process.Args.Iterator.initAllocator(init.minimal.args, init.gpa) catch |err| return failure(init.io, false, .arguments, err);
    defer iterator.deinit();
    _ = iterator.next();
    var json = false;
    while (iterator.next()) |arg| {
        if (std.mem.eql(u8, arg, "--json")) json = true;
        args.append(init.gpa, arg) catch |err| return failure(init.io, json, .arguments, err);
    }
    const options = parseOptions(args.items) catch |err| return failure(init.io, json, .arguments, err);
    if (options.help) {
        if (options.json) {
            writeJson(init.io, .{ .schemaVersion = @as(u32, 1), .success = true, .status = "help", .help = help }) catch return 1;
        } else Io.File.stdout().writeStreamingAll(init.io, help) catch return 1;
        return 0;
    }
    var phase: Phase = .arguments;
    install(init, options, &phase) catch |err| return failure(init.io, options.json, phase, err);
    return 0;
}

fn fixtureSlot(a: A, json: []const u8) ![]u8 {
    const bytes = try a.alloc(u8, slot_size);
    @memset(bytes, 0);
    @memcpy(bytes[0..slot_start.len], slot_start);
    std.mem.writeInt(u64, bytes[slot_start.len..][0..8], json.len, .little);
    @memcpy(bytes[slot_start.len + 8 ..][0..json.len], json);
    @memcpy(bytes[bytes.len - slot_end.len ..], slot_end);
    return bytes;
}

test "installer config slot bounds its JSON without depending on padding" {
    const a = std.testing.allocator;
    const bytes = try fixtureSlot(a, "{\"schemaVersion\":1}");
    defer a.free(bytes);
    try std.testing.expectEqualStrings("{\"schemaVersion\":1}", try slotJson(bytes));
    try std.testing.expectError(error.InvalidInstallerConfiguration, slotJson(slot_start ++ "not a slot"));
    try std.testing.expectError(error.InvalidInstallerConfiguration, slotJson(bytes[0 .. bytes.len - 1]));
}

test "installer config slot rejects empty or oversized lengths and changed markers" {
    const a = std.testing.allocator;
    const bytes = try fixtureSlot(a, "{}");
    defer a.free(bytes);
    std.mem.writeInt(u64, bytes[slot_start.len..][0..8], max_document_bytes + 1, .little);
    try std.testing.expectError(error.InvalidInstallerConfiguration, slotJson(bytes));
    std.mem.writeInt(u64, bytes[slot_start.len..][0..8], 0, .little);
    try std.testing.expectError(error.InvalidInstallerConfiguration, slotJson(bytes));
    std.mem.writeInt(u64, bytes[slot_start.len..][0..8], 2, .little);
    bytes[0] = '!';
    try std.testing.expectError(error.InvalidInstallerConfiguration, slotJson(bytes));
    bytes[0] = slot_start[0];
    bytes[bytes.len - 1] = '!';
    try std.testing.expectError(error.InvalidInstallerConfiguration, slotJson(bytes));
}

test "installer CLI permits one settings source and never launch arguments" {
    const options = try parseOptions(&.{ "--json", "--settings-file", "private.json" });
    try std.testing.expect(options.json);
    try std.testing.expectEqualStrings("private.json", options.settings_file.?);
    try std.testing.expect((try parseOptions(&.{"--settings-stdin"})).settings_stdin);
    for ([_][]const []const u8{
        &.{ "--settings-file", "a", "--settings-stdin" },
        &.{ "--settings-stdin", "--settings-stdin" },
        &.{ "--settings-file", "--json" },
        &.{"--settings-file"},
        &.{ "--help", "--settings-stdin" },
        &.{"--launch"},
        &.{"secret=value"},
    }) |args| try std.testing.expectError(error.InvalidArguments, parseOptions(args));
}

test "installer config binds target and rejects unsafe identity and origins" {
    var config: Config = .{ .schemaVersion = 1, .identifier = "dev.example.app", .name = "Example", .channel = "canary", .baseUrl = "https://example.com/releases/", .platform = .macos, .arch = .arm64 };
    try validateConfig(config, .macos, .arm64);
    try std.testing.expectError(error.InstallerTargetMismatch, validateConfig(config, .linux, .arm64));
    config.identifier = "../escape";
    try std.testing.expectError(error.InvalidInstallerIdentity, validateConfig(config, .macos, .arm64));
    config.identifier = "dev.example.app";
    config.baseUrl = "https://example.com/releases?token=ignored";
    try std.testing.expectError(error.InvalidUpdateUrl, validateConfig(config, .macos, .arm64));
    config.baseUrl = "http://example.com/releases/";
    try std.testing.expectError(error.InsecureUpdateUrl, validateConfig(config, .macos, .arm64));
    config.baseUrl = "https://example.com/releases/";
    config.defaults = .{ .bool = true };
    try std.testing.expectError(error.InvalidInstallerDefaults, validateConfig(config, .macos, .arm64));
}

test "installer requires a release-bound digest and bounded aligned tar" {
    const manifest: protocol.Manifest = .{ .schemaVersion = 1, .identifier = "dev.example.app", .channel = "canary", .version = "1.2.3", .hash = "abc123", .platform = .macos, .arch = .arm64, .artifact = .{ .file = "canary-macos-arm64-Example.app.tar.zst" } };
    var checksum: protocol.Checksum = .{ .hash = "abc123", .tarSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .tarSize = 1024 };
    try validateIntegrity(manifest, checksum);
    checksum.hash = null;
    try std.testing.expectError(error.UpdateChecksumMismatch, validateIntegrity(manifest, checksum));
    checksum.hash = "another";
    try std.testing.expectError(error.UpdateChecksumMismatch, validateIntegrity(manifest, checksum));
    checksum.hash = "abc123";
    checksum.tarSize = 1025;
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, validateIntegrity(manifest, checksum));
    checksum.tarSize = max_archive_bytes + 512;
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, validateIntegrity(manifest, checksum));
}

test "installer settings keep arbitrary app keys and exact decimal numbers" {
    const a = std.testing.allocator;
    var parsed = try parseSettings(a, "{\"startup\":{\"openWindow\":false},\"precision\":0.123456789012345678901,\"unknown\":null}");
    defer parsed.deinit();
    try std.testing.expect(!parsed.value.object.get("startup").?.object.get("openWindow").?.bool);
    try std.testing.expectEqualStrings("0.123456789012345678901", parsed.value.object.get("precision").?.number_string);
    try std.testing.expect(parsed.value.object.get("unknown").? == .null);
    try std.testing.expectError(error.InvalidSettingsObject, parseSettings(a, "[]"));
    try std.testing.expectError(error.InvalidSettingsJson, parseSettings(a, "{\"same\":1,\"same\":2}"));
    var nested: std.ArrayList(u8) = .empty;
    defer nested.deinit(a);
    try nested.appendSlice(a, "{\"nested\":");
    for (0..65) |_| try nested.append(a, '[');
    try nested.appendSlice(a, "true");
    for (0..65) |_| try nested.append(a, ']');
    try nested.append(a, '}');
    try std.testing.expectError(error.InvalidSettingsDepth, parseSettings(a, nested.items));
}
