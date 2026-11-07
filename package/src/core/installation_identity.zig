//! Local application-install identity shared by managed updates and Insights.
//! Loading an identity does not create an analytics reporter or send requests.
const std = @import("std");
const persistence = @import("insights_spool.zig");
const A = std.mem.Allocator;
const Io = std.Io;

pub const Options = struct {
    /// Optional cloud application ID used only to migrate an existing Insights
    /// identity. The canonical ID belongs to this local app installation.
    appId: ?[]const u8 = null,
    /// Per-app storage root (historically named "insights" by SDKs).
    storagePath: []const u8,
};

pub fn validId(value: []const u8) bool {
    if (value.len != 32) return false;
    for (value) |c| if (!std.ascii.isDigit(c) and (c < 'a' or c > 'f')) return false;
    return true;
}

pub fn validate(options: Options) !void {
    if (options.storagePath.len == 0 or
        std.mem.indexOfScalar(u8, options.storagePath, 0) != null) return error.InvalidInstallationConfiguration;
    if (options.appId) |app_id| {
        if (app_id.len == 0 or app_id.len > 128) return error.InvalidInstallationConfiguration;
        for (app_id) |c| if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_') return error.InvalidInstallationConfiguration;
    }
}

/// Insights preferences and pending events retain their existing app scope.
pub fn directory(a: A, options: Options) ![]u8 {
    try validate(options);
    const app_id = options.appId orelse return error.InvalidInstallationConfiguration;
    var hash: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(app_id, &hash, .{});
    const scope = std.fmt.bytesToHex(hash, .lower);
    return std.fs.path.join(a, &.{ options.storagePath, &scope });
}

fn decode(a: A, bytes: []const u8) ![32]u8 {
    // Insights stores consent and user association alongside the identity. The
    // shared facility reads those fields without altering them.
    const parsed = try std.json.parseFromSlice(struct { installationId: []const u8 }, a, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    if (!validId(parsed.value.installationId)) return error.InvalidInstallationIdentity;
    return parsed.value.installationId[0..32].*;
}

fn legacyWithoutHint(a: A, io: Io, root: []const u8) !?[32]u8 {
    // Older apps can configure Insights manually after displaying their ID.
    // Adopt an unambiguous old identity even before that app ID is supplied.
    var dir = Io.Dir.cwd().openDir(io, root, .{ .iterate = true }) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => return err,
    };
    defer dir.close(io);
    var iterator = dir.iterate();
    var found: ?[32]u8 = null;
    var scopes: usize = 0;
    while (try iterator.next(io)) |entry| {
        if (entry.kind != .directory or entry.name.len != 64) continue;
        var hashed_scope = true;
        for (entry.name) |c| if (!std.ascii.isDigit(c) and (c < 'a' or c > 'f')) {
            hashed_scope = false;
            break;
        };
        if (!hashed_scope) continue;
        scopes += 1;
        if (scopes > 128) return error.AmbiguousInstallationIdentity;
        const path = try std.fs.path.join(a, &.{ root, entry.name, "identity.json" });
        defer a.free(path);
        const bytes = persistence.read(a, io, path, 4096) catch |err| switch (err) {
            error.FileNotFound => continue,
            else => return err,
        };
        defer a.free(bytes);
        const id = try decode(a, bytes);
        if (found) |previous| {
            if (!std.mem.eql(u8, &previous, &id)) return error.AmbiguousInstallationIdentity;
        } else found = id;
    }
    return found;
}

pub fn loadOrCreate(a: A, io: Io, options: Options) ![32]u8 {
    try validate(options);
    const path = try std.fs.path.join(a, &.{ options.storagePath, "installation.json" });
    defer a.free(path);
    const existing = persistence.read(a, io, path, 4096) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    if (existing) |bytes| {
        defer a.free(bytes);
        return decode(a, bytes);
    }
    const migrated: ?[32]u8 = if (options.appId != null) blk: {
        const dir = try directory(a, options);
        defer a.free(dir);
        const legacy_path = try std.fs.path.join(a, &.{ dir, "identity.json" });
        defer a.free(legacy_path);
        const legacy = persistence.read(a, io, legacy_path, 4096) catch |err| switch (err) {
            error.FileNotFound => break :blk null,
            else => return err,
        };
        defer a.free(legacy);
        break :blk try decode(a, legacy);
    } else try legacyWithoutHint(a, io, options.storagePath);
    try Io.Dir.cwd().createDirPath(io, options.storagePath);
    const id = migrated orelse blk: {
        var random: [16]u8 = undefined;
        io.random(&random);
        break :blk std.fmt.bytesToHex(random, .lower);
    };
    const initial = try std.json.Stringify.valueAlloc(a, .{ .installationId = &id }, .{});
    defer a.free(initial);
    // Concurrent first launches agree on the winning identity. Losing callers
    // re-read it rather than returning the value they attempted to write.
    persistence.write(a, io, path, initial, 4096, false) catch |err| if (err != error.PathAlreadyExists) return err;
    const bytes = try persistence.read(a, io, path, 4096);
    defer a.free(bytes);
    return decode(a, bytes);
}

test "hosting-only identity persists without creating a session or analytics queue" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const a = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    const options: Options = .{ .appId = "app-one", .storagePath = path };
    const first = try loadOrCreate(a, std.testing.io, options);
    const second = try loadOrCreate(a, std.testing.io, options);
    try std.testing.expect(validId(&first));
    try std.testing.expectEqualStrings(&first, &second);
    var stored = try Io.Dir.cwd().openDir(std.testing.io, path, .{ .iterate = true });
    defer stored.close(std.testing.io);
    var iterator = stored.iterate();
    var count: usize = 0;
    while (try iterator.next(std.testing.io)) |entry| {
        try std.testing.expect(std.mem.eql(u8, entry.name, "installation.json") or std.mem.eql(u8, entry.name, "installation.json.key"));
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), count);
}

test "shared identity reads existing Insights state without changing consent or user association" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const a = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    const options: Options = .{ .appId = "app-one", .storagePath = path };
    const dir = try directory(a, options);
    defer a.free(dir);
    try Io.Dir.cwd().createDirPath(std.testing.io, dir);
    const filename = try std.fs.path.join(a, &.{ dir, "identity.json" });
    defer a.free(filename);
    const original = "{\"installationId\":\"1234567890abcdef1234567890abcdef\",\"enabled\":false,\"customEventsEnabled\":false,\"userId\":\"existing-user\",\"retryAfterMs\":123}";
    try persistence.write(a, std.testing.io, filename, original, 4096, false);
    const first = try loadOrCreate(a, std.testing.io, options);
    try std.testing.expectEqualStrings("1234567890abcdef1234567890abcdef", &first);
    const after = try persistence.read(a, std.testing.io, filename, 4096);
    defer a.free(after);
    try std.testing.expectEqualStrings(original, after);
}

test "identities are scoped to local app storage and concurrent initial readers agree" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const a = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    const options: Options = .{ .appId = "app-one", .storagePath = path };
    var left = try Io.concurrent(std.testing.io, loadOrCreate, .{ a, std.testing.io, options });
    var right = try Io.concurrent(std.testing.io, loadOrCreate, .{ a, std.testing.io, options });
    const first = try left.await(std.testing.io);
    const second = try right.await(std.testing.io);
    try std.testing.expectEqualStrings(&first, &second);
    const another_path = try std.fs.path.join(a, &.{ path, "another-app-profile" });
    defer a.free(another_path);
    const other = try loadOrCreate(a, std.testing.io, .{ .appId = "app-two", .storagePath = another_path });
    try std.testing.expect(!std.mem.eql(u8, &first, &other));
}

test "local identity requires no cloud app configuration and later Insights reuses it" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const a = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    const local = try loadOrCreate(a, std.testing.io, .{ .storagePath = path });
    const configured = try loadOrCreate(a, std.testing.io, .{ .appId = "managed-app", .storagePath = path });
    try std.testing.expectEqualStrings(&local, &configured);
}

test "manual Insights legacy identity is preserved before its cloud app ID is configured" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const a = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    const dir = try directory(a, .{ .appId = "manually-configured-app", .storagePath = path });
    defer a.free(dir);
    try Io.Dir.cwd().createDirPath(std.testing.io, dir);
    const filename = try std.fs.path.join(a, &.{ dir, "identity.json" });
    defer a.free(filename);
    try persistence.write(a, std.testing.io, filename, "{\"installationId\":\"1234567890abcdef1234567890abcdef\",\"enabled\":false}", 4096, false);
    const local = try loadOrCreate(a, std.testing.io, .{ .storagePath = path });
    try std.testing.expectEqualStrings("1234567890abcdef1234567890abcdef", &local);
    const configured = try loadOrCreate(a, std.testing.io, .{ .appId = "manually-configured-app", .storagePath = path });
    try std.testing.expectEqualStrings(&local, &configured);
}

test "ambiguous legacy identities require a migration hint without creating a replacement ID" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const a = std.testing.allocator;
    const path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    for ([_][]const u8{ "first-app", "second-app" }, [_][]const u8{ "11111111111111111111111111111111", "22222222222222222222222222222222" }) |app_id, id| {
        const dir = try directory(a, .{ .appId = app_id, .storagePath = path });
        defer a.free(dir);
        try Io.Dir.cwd().createDirPath(std.testing.io, dir);
        const filename = try std.fs.path.join(a, &.{ dir, "identity.json" });
        defer a.free(filename);
        const json = try std.json.Stringify.valueAlloc(a, .{ .installationId = id }, .{});
        defer a.free(json);
        try persistence.write(a, std.testing.io, filename, json, 4096, false);
    }
    try std.testing.expectError(error.AmbiguousInstallationIdentity, loadOrCreate(a, std.testing.io, .{ .storagePath = path }));
    const canonical = try std.fs.path.join(a, &.{ path, "installation.json" });
    defer a.free(canonical);
    try std.testing.expectError(error.FileNotFound, persistence.read(a, std.testing.io, canonical, 4096));
    const chosen = try loadOrCreate(a, std.testing.io, .{ .appId = "second-app", .storagePath = path });
    try std.testing.expectEqualStrings("22222222222222222222222222222222", &chosen);
}
