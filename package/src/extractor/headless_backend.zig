//! Transactional, UI-free full installation. Keep application settings outside
//! the signed bundle and retained archive recipe so ordinary updates preserve it.
const std = @import("std");
const builtin = @import("builtin");
const archive = @import("archive_recipe.zig");
const http = @import("prepare_update_http.zig");
const A = std.mem.Allocator;
const Io = std.Io;
const max_archive_bytes = 16 * 1024 * 1024 * 1024;
const max_settings_bytes = 1024 * 1024;

pub const Request = struct {
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
    base_url: []const u8,
    artifact_url: []const u8,
    tar_sha256: []const u8,
    tar_size: u64,
    defaults: std.json.Value,
    settings: ?std.json.Value,
};
pub const Result = struct {
    user_data: []const u8,
    app_path: []const u8,
    launcher_path: []const u8,
    settings_path: []const u8,

    pub fn deinit(self: *Result, a: A) void {
        a.free(self.user_data);
        a.free(self.app_path);
        a.free(self.launcher_path);
        a.free(self.settings_path);
        self.* = undefined;
    }
};
const Integrate = *const fn (A, []const u8, []const u8, Request) anyerror!void;
const Publish = *const fn (A, []const u8, []const u8) anyerror!void;
const ResolveAppPath = *const fn (A, []const u8, []const u8, Request) anyerror![]const u8;

fn permissions(mode: u32) Io.File.Permissions {
    return if (builtin.os.tag == .windows) .default_file else .fromMode(@intCast(mode));
}
fn component(value: []const u8) !void {
    try archive.validatePath(value);
    if (std.mem.indexOfAny(u8, value, "/\\") != null) return error.InvalidInstallIdentity;
}

pub fn userData(a: A, env: *const std.process.Environ.Map, identifier: []const u8, channel: []const u8) ![]u8 {
    try component(identifier);
    try component(channel);
    const home = env.get("HOME") orelse env.get("USERPROFILE");
    return switch (builtin.os.tag) {
        .macos => std.fs.path.join(a, &.{ home orelse return error.MissingHomeDirectory, "Library", "Application Support", identifier, channel }),
        .linux => blk: {
            if (env.get("XDG_DATA_HOME")) |xdg| {
                if (!std.fs.path.isAbsolute(xdg)) return error.InvalidInstallPath;
                break :blk std.fs.path.join(a, &.{ xdg, identifier, channel });
            }
            break :blk std.fs.path.join(a, &.{ home orelse return error.MissingHomeDirectory, ".local", "share", identifier, channel });
        },
        .windows => blk: {
            if (env.get("LOCALAPPDATA")) |local| break :blk std.fs.path.join(a, &.{ local, identifier, channel });
            break :blk std.fs.path.join(a, &.{ env.get("USERPROFILE") orelse home orelse return error.MissingHomeDirectory, "AppData", "Local", identifier, channel });
        },
        else => @compileError("Unsupported installer platform"),
    };
}

/// Open/create one component at a time. Never recurse through a symlink or
/// junction supplied in the installation hierarchy, including stale stages.
fn ensureRoot(a: A, io: Io, path: []const u8) !Io.Dir {
    if (!std.fs.path.isAbsolute(path)) return error.InvalidInstallPath;
    const normalized = try std.fs.path.resolve(a, &.{path});
    defer a.free(normalized);
    if (!std.mem.eql(u8, normalized, path)) return error.InvalidInstallPath;
    const prefix_len: usize = if (builtin.os.tag == .windows) blk: {
        if (path.len < 3 or path[1] != ':' or (path[2] != '\\' and path[2] != '/')) return error.InvalidInstallPath;
        break :blk 3;
    } else 1;
    var current = try Io.Dir.openDirAbsolute(io, path[0..prefix_len], .{ .follow_symlinks = false, .iterate = true });
    errdefer current.close(io);
    var parts = std.mem.tokenizeAny(u8, path[prefix_len..], if (builtin.os.tag == .windows) "/\\" else "/");
    while (parts.next()) |part| {
        try component(part);
        current.createDir(io, part, permissions(0o700)) catch |err| if (err != error.PathAlreadyExists) return err;
        if ((try current.statFile(io, part, .{ .follow_symlinks = false })).kind != .directory) return error.InvalidInstallPath;
        const next = try current.openDir(io, part, .{ .follow_symlinks = false, .iterate = true });
        current.close(io);
        current = next;
    }
    return current;
}

fn exists(io: Io, dir: Io.Dir, name: []const u8, kind: Io.File.Kind) !bool {
    const stat = dir.statFile(io, name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return false,
        else => return err,
    };
    if (stat.kind != kind) return error.InvalidInstallPath;
    return true;
}

pub fn acquireLifecycleLock(io: Io, root: Io.Dir) !Io.File {
    // Same advisory lock as preparation: do not mutate a baseline while an
    // updater is reconstructing its exact archive from the installed files.
    const name = ".electrobun-prepare.lock";
    const file = root.createFile(io, name, .{ .exclusive = true, .read = true, .truncate = false, .permissions = permissions(0o600) }) catch |err| switch (err) {
        error.PathAlreadyExists => try root.openFile(io, name, .{ .mode = .read_write, .follow_symlinks = false, .allow_directory = false }),
        else => return err,
    };
    errdefer file.close(io);
    if ((try file.stat(io)).kind != .file) return error.InvalidInstallPath;
    if (!try file.tryLock(io, .exclusive)) return error.InstallationBusy;
    return file;
}

fn readFile(a: A, io: Io, dir: Io.Dir, name: []const u8, limit: usize) ![]u8 {
    const file = try archive.openRegularFile(io, dir, name);
    defer file.close(io);
    var buffer: [4096]u8 = undefined;
    var reader = file.reader(io, &buffer);
    return reader.interface.allocRemaining(a, .limited(limit));
}

fn merge(a: A, base: std.json.Value, overrides: std.json.Value, depth: usize) !std.json.Value {
    if (depth > 64) return error.InstallSettingsTooDeep;
    if (base != .object or overrides != .object) return overrides;
    var result: std.json.ObjectMap = .empty;
    var iterator = base.object.iterator();
    while (iterator.next()) |entry| try result.put(a, entry.key_ptr.*, entry.value_ptr.*);
    iterator = overrides.object.iterator();
    while (iterator.next()) |entry| {
        const value = if (result.get(entry.key_ptr.*)) |old| try merge(a, old, entry.value_ptr.*, depth + 1) else entry.value_ptr.*;
        try result.put(a, entry.key_ptr.*, value);
    }
    return .{ .object = result };
}

fn validateSettingsDepth(value: std.json.Value, depth: usize) !void {
    if (depth > 64) return error.InstallSettingsTooDeep;
    switch (value) {
        .object => |object| {
            var iterator = object.iterator();
            while (iterator.next()) |entry| try validateSettingsDepth(entry.value_ptr.*, depth + 1);
        },
        .array => |array| for (array.items) |item| try validateSettingsDepth(item, depth + 1),
        else => {},
    }
}

/// A repeat install without explicit settings leaves the existing file exactly
/// as written. With settings, defaults < existing values < caller overrides;
/// objects merge recursively and arrays/scalars/null replace their old value.
fn settingsDocument(a: A, io: Io, root: Io.Dir, request: Request) !?[]const u8 {
    if (request.defaults != .object or (request.settings != null and request.settings.? != .object)) return error.InvalidInstallSettings;
    try validateSettingsDepth(request.defaults, 0);
    if (request.settings) |value| try validateSettingsDepth(value, 0);
    const present = try exists(io, root, "install.json", .file);
    if (present and request.settings == null) return null;
    var value = request.defaults;
    if (present) {
        const bytes = try readFile(a, io, root, "install.json", max_settings_bytes);
        const previous = try std.json.parseFromSlice(struct { schemaVersion: u32, settings: std.json.Value }, a, bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always, .parse_numbers = false });
        if (previous.value.schemaVersion != 1 or previous.value.settings != .object) return error.InvalidInstallSettings;
        try validateSettingsDepth(previous.value.settings, 0);
        value = try merge(a, value, previous.value.settings, 0);
    }
    if (request.settings) |overrides| value = try merge(a, value, overrides, 0);
    const bytes = try std.json.Stringify.valueAlloc(a, .{ .schemaVersion = @as(u32, 1), .settings = value }, .{});
    if (bytes.len > max_settings_bytes) return error.InstallSettingsTooLarge;
    return bytes;
}

fn writeSettings(io: Io, root: Io.Dir, bytes: []const u8) !void {
    _ = try exists(io, root, "install.json", .file);
    var atomic = try root.createFileAtomic(io, "install.json", .{ .replace = true, .permissions = permissions(0o600) });
    defer atomic.deinit(io);
    var buffer: [4096]u8 = undefined;
    var writer = atomic.file.writer(io, &buffer);
    try writer.interface.writeAll(bytes);
    try writer.flush();
    try atomic.file.sync(io);
    try atomic.replace(io);
}

const Download = struct {
    a: A,
    io: Io,
    stage: Io.Dir,
    request: Request,
    result: ?archive.Owned = null,

    fn consume(pointer: *anyopaque, compressed: *Io.Reader) !void {
        const self: *@This() = @ptrCast(@alignCast(pointer));
        const zstd = std.compress.zstd;
        const window = try self.a.alloc(u8, zstd.default_window_len + zstd.block_size_max);
        defer self.a.free(window);
        // Stdlib's Zstd checksum verification is not implemented. Authenticate
        // the complete decompressed tar against the release SHA-256 instead.
        var decoder: zstd.Decompress = .init(compressed, window, .{ .verify_checksum = false });
        var buffer: [4096]u8 = undefined;
        var limited = decoder.reader.limited(.limited64(self.request.tar_size + 1), &buffer);
        self.result = archive.extractReader(self.a, self.io, &limited.interface, self.request.tar_size, self.stage) catch |err| return decoder.err orelse err;
        const receipt = self.result.?.value;
        if (receipt.archive_size != self.request.tar_size or !std.mem.eql(u8, receipt.archive_sha256, self.request.tar_sha256)) return error.InstallArchiveIntegrityMismatch;
    }
};

fn validateIdentity(a: A, io: Io, app: Io.Dir, request: Request, exact_release: bool) !void {
    const bytes = try readFile(a, io, app, if (builtin.os.tag == .macos) "Contents/Resources/version.json" else "Resources/version.json", 1024 * 1024);
    const document = try std.json.parseFromSlice(struct {
        identifier: []const u8,
        channel: []const u8,
        hash: []const u8,
        version: []const u8,
        baseUrl: ?[]const u8 = null,
    }, a, bytes, .{ .ignore_unknown_fields = true });
    const value = document.value;
    if (!std.mem.eql(u8, value.identifier, request.identifier) or !std.mem.eql(u8, value.channel, request.channel)) return error.InstallPayloadIdentityMismatch;
    if (exact_release and (!std.mem.eql(u8, value.hash, request.hash) or !std.mem.eql(u8, value.version, request.version) or
        !std.mem.eql(u8, std.mem.trimEnd(u8, value.baseUrl orelse return error.InstallPayloadIdentityMismatch, "/"), std.mem.trimEnd(u8, request.base_url, "/")))) return error.InstallPayloadIdentityMismatch;
    const launcher = try archive.openRegularFile(io, app, launcherRelative());
    launcher.close(io);
    const manager = try archive.openRegularFile(io, app, if (builtin.os.tag == .macos) "Contents/Resources/uninstall" else "Resources/uninstall");
    manager.close(io);
}

fn launcherRelative() []const u8 {
    return switch (builtin.os.tag) {
        .macos => "Contents/MacOS/launcher",
        .linux => "bin/launcher",
        .windows => "bin/launcher.exe",
        else => unreachable,
    };
}

fn rollbackRegistration(a: A, io: Io, app: Io.Dir, request: Request) !Request {
    const bytes = try readFile(a, io, app, if (builtin.os.tag == .macos) "Contents/Resources/version.json" else "Resources/version.json", 1024 * 1024);
    const parsed = try std.json.parseFromSlice(struct { hash: []const u8, version: []const u8, displayName: ?[]const u8 = null }, a, bytes, .{ .ignore_unknown_fields = true });
    var old = request;
    old.hash = parsed.value.hash;
    old.version = parsed.value.version;
    old.name = parsed.value.displayName orelse request.name;
    return old;
}

pub fn install(init: std.process.Init, request: Request, integrate: Integrate, publish: Publish, resolve_app_path: ResolveAppPath) !Result {
    var arena: std.heap.ArenaAllocator = .init(init.gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const io = init.io;
    try component(request.identifier);
    try component(request.channel);
    try component(request.hash);
    if (request.tar_size == 0 or request.tar_size > max_archive_bytes or !archive.isDigest(request.tar_sha256)) return error.InvalidInstallIntegrity;
    const root_path = try userData(a, init.environ_map, request.identifier, request.channel);
    var root = try ensureRoot(a, io, root_path);
    defer root.close(io);
    if (builtin.os.tag != .windows) try root.setPermissions(io, permissions(0o700));
    const install_lock = try acquireLifecycleLock(io, root);
    defer install_lock.close(io);
    // Parse settings before downloads or replacing an installed app. Secret
    // values are only serialized to the private configuration file, never logs.
    const settings = try settingsDocument(a, io, root, request);
    const old_settings = if (settings != null and try exists(io, root, "install.json", .file)) try readFile(a, io, root, "install.json", max_settings_bytes) else null;
    const stage_name = ".electrobun-headless-stage";
    if (try exists(io, root, stage_name, .directory)) try root.deleteTree(io, stage_name);
    try root.createDir(io, stage_name, permissions(0o700));
    defer root.deleteTree(io, stage_name) catch {};
    var stage = try root.openDir(io, stage_name, .{ .follow_symlinks = false, .iterate = true });
    var stage_open = true;
    defer if (stage_open) stage.close(io);
    var download: Download = .{ .a = a, .io = io, .stage = stage, .request = request };
    defer if (download.result) |*receipt| receipt.deinit();
    try http.fetch(a, io, request.artifact_url, &download, Download.consume, .{});
    const receipt = download.result.?.value;
    const bundle_name = receipt.root;
    if (builtin.os.tag == .macos and !std.mem.endsWith(u8, bundle_name, ".app")) return error.InstallPayloadIdentityMismatch;
    {
        var staged_app = try stage.openDir(io, bundle_name, .{ .follow_symlinks = false });
        defer staged_app.close(io);
        try validateIdentity(a, io, staged_app, request, true);
    }

    const default_app_path = try std.fs.path.join(a, &.{ root_path, if (builtin.os.tag == .macos) bundle_name else "app" });
    // A previous graphical macOS installation may live in /Applications. Reuse
    // its registered, identity-checked target instead of leaving two bundles
    // sharing one updater state. Fresh unattended installs stay in userData.
    const app_path = try resolve_app_path(a, root_path, default_app_path, request);
    const app_parent_path = std.fs.path.dirname(app_path) orelse return error.InvalidInstallPath;
    var app_parent = try ensureRoot(a, io, app_parent_path);
    defer app_parent.close(io);
    const app_name = std.fs.path.basename(app_path);
    const previous_name = try std.fmt.allocPrint(a, "{s}.previous", .{app_name});
    const previous_exists = try exists(io, app_parent, previous_name, .directory);
    if (previous_exists) {
        var previous = try app_parent.openDir(io, previous_name, .{ .follow_symlinks = false });
        defer previous.close(io);
        try validateIdentity(a, io, previous, request, false);
    }
    if (!try exists(io, app_parent, app_name, .directory) and previous_exists) try app_parent.rename(previous_name, app_parent, app_name, io);
    const had_previous = try exists(io, app_parent, app_name, .directory);
    var old_registration = request;
    if (had_previous) {
        var old = try app_parent.openDir(io, app_name, .{ .follow_symlinks = false });
        defer old.close(io);
        try validateIdentity(a, io, old, request, false);
        old_registration = try rollbackRegistration(a, io, old, request);
    }
    if (try exists(io, app_parent, previous_name, .directory)) try app_parent.deleteTree(io, previous_name);
    const recipe_name = try std.fmt.allocPrint(a, "{s}.recipe.json", .{request.hash});
    const recipe_file = try stage.createFile(io, recipe_name, .{ .exclusive = true, .permissions = permissions(0o600) });
    {
        defer recipe_file.close(io);
        var buffer: [16 * 1024]u8 = undefined;
        var writer = recipe_file.writer(io, &buffer);
        try archive.writeJson(receipt, &writer.interface);
        try writer.flush();
        try recipe_file.sync(io);
    }
    // Validate managed-state targets before the shared publisher performs any
    // cleanup. Stale interrupted stages are safe because the lock is held.
    const had_state = try exists(io, root, "self-extraction", .directory);
    const had_previous_state = try exists(io, root, "self-extraction.previous", .directory);
    // Allocate the public result before committing any app/configuration state.
    const result_root = try init.gpa.dupe(u8, root_path);
    errdefer init.gpa.free(result_root);
    const result_app = try init.gpa.dupe(u8, app_path);
    errdefer init.gpa.free(result_app);
    // Archive entry names are POSIX paths, but the public result must use the
    // host's native separators throughout (join preserves inner separators).
    const launcher = try std.fs.path.join(init.gpa, switch (builtin.os.tag) {
        .macos => &.{ app_path, "Contents", "MacOS", "launcher" },
        .linux => &.{ app_path, "bin", "launcher" },
        .windows => &.{ app_path, "bin", "launcher.exe" },
        else => unreachable,
    });
    errdefer init.gpa.free(launcher);
    const settings_path = try std.fs.path.join(init.gpa, &.{ root_path, "install.json" });
    errdefer init.gpa.free(settings_path);

    const stage_path = try std.fs.path.join(a, &.{ root_path, stage_name });
    const extraction_path = try std.fs.path.join(a, &.{ root_path, "self-extraction" });
    if (had_previous) try app_parent.rename(app_name, app_parent, previous_name, io);
    var app_published = false;
    var state_published = false;
    var settings_written = false;
    var integration_attempted = false;
    const failure: ?anyerror = transaction: {
        stage.rename(bundle_name, app_parent, app_name, io) catch |err| break :transaction err;
        app_published = true;
        stage.close(io);
        stage_open = false;
        publish(a, stage_path, extraction_path) catch |err| break :transaction err;
        state_published = true;
        // Complete fallible settings I/O before OS registration. A registration
        // failure restores the previous bytes (or removes the newly made file).
        if (settings) |bytes| {
            writeSettings(io, root, bytes) catch |err| break :transaction err;
            settings_written = true;
        }
        integration_attempted = true;
        integrate(a, root_path, app_path, request) catch |err| break :transaction err;
        break :transaction null;
    };
    if (failure) |original_error| {
        var recovered = true;
        if (app_published) app_parent.deleteTree(io, app_name) catch {
            recovered = false;
        };
        if (had_previous) app_parent.rename(previous_name, app_parent, app_name, io) catch {
            recovered = false;
        };
        if (state_published) {
            root.deleteTree(io, "self-extraction") catch {
                recovered = false;
            };
            if (had_state or had_previous_state) root.rename("self-extraction.previous", root, "self-extraction", io) catch {
                recovered = false;
            };
        }
        if (settings_written) {
            if (old_settings) |bytes| {
                writeSettings(io, root, bytes) catch {
                    recovered = false;
                };
            } else root.deleteFile(io, "install.json") catch {
                recovered = false;
            };
        }
        // Platform integration can be partially updated before it reports an
        // error. Restore the previous app's registration after rollback.
        if (had_previous and integration_attempted and recovered) integrate(a, root_path, app_path, old_registration) catch {};
        return if (recovered) original_error else error.InstallRollbackFailed;
    }
    if (had_previous) app_parent.deleteTree(io, previous_name) catch {};
    root.deleteTree(io, "self-extraction.previous") catch {};
    return .{ .user_data = result_root, .app_path = result_app, .launcher_path = launcher, .settings_path = settings_path };
}

test "settings recursively merge objects and replace arrays and explicit null" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const base = try std.json.parseFromSlice(std.json.Value, a, "{\"startup\":{\"window\":true,\"tray\":true},\"list\":[1],\"token\":\"old\"}", .{});
    const override = try std.json.parseFromSlice(std.json.Value, a, "{\"startup\":{\"window\":false},\"list\":[2,3],\"token\":null}", .{});
    const value = try merge(a, base.value, override.value, 0);
    try std.testing.expect(!value.object.get("startup").?.object.get("window").?.bool);
    try std.testing.expect(value.object.get("startup").?.object.get("tray").?.bool);
    try std.testing.expectEqual(@as(usize, 2), value.object.get("list").?.array.items.len);
    try std.testing.expect(value.object.get("token").? == .null);
}

test "repeat install preserves settings bytes unless caller supplies settings" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const original = "{\"schemaVersion\":1,\"settings\":{\"kept\":true}}\n";
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "install.json", .data = original });
    const defaults = try std.json.parseFromSlice(std.json.Value, a, "{\"kept\":false,\"added\":1}", .{});
    const request: Request = .{ .identifier = "com.test", .name = "Test", .channel = "canary", .hash = "abc", .version = "1", .base_url = "https://example.com", .artifact_url = "https://example.com/app.tar.zst", .tar_sha256 = "", .tar_size = 1, .defaults = defaults.value, .settings = null };
    try std.testing.expect(try settingsDocument(a, std.testing.io, tmp.dir, request) == null);
    var changed = request;
    changed.settings = .{ .object = .empty };
    const bytes = (try settingsDocument(a, std.testing.io, tmp.dir, changed)).?;
    const document = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    try std.testing.expect(document.value.object.get("settings").?.object.get("kept").?.bool);
    try std.testing.expectEqual(@as(i64, 1), document.value.object.get("settings").?.object.get("added").?.integer);
    try writeSettings(std.testing.io, tmp.dir, bytes);
    if (builtin.os.tag != .windows) {
        const stat = try tmp.dir.statFile(std.testing.io, "install.json", .{});
        try std.testing.expectEqual(@as(u32, 0o600), stat.permissions.toMode() & 0o777);
    }
}

test "settings and installation lock reject symlink targets" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "secret", .data = "unchanged" });
    try tmp.dir.symLink(std.testing.io, "secret", "install.json", .{});
    try std.testing.expectError(error.InvalidInstallPath, writeSettings(std.testing.io, tmp.dir, "{}"));
    try tmp.dir.symLink(std.testing.io, "secret", ".electrobun-prepare.lock", .{});
    try std.testing.expectError(error.SymLinkLoop, acquireLifecycleLock(std.testing.io, tmp.dir));
}

test "lifecycle lock refuses concurrent writers and is reusable after close" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const first = try acquireLifecycleLock(std.testing.io, tmp.dir);
    try std.testing.expectError(error.InstallationBusy, acquireLifecycleLock(std.testing.io, tmp.dir));
    first.close(std.testing.io);
    const next = try acquireLifecycleLock(std.testing.io, tmp.dir);
    next.close(std.testing.io);
}

test "installation hierarchy rejects symlink parents without touching target" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(std.testing.io, "actual", .default_dir);
    try tmp.dir.symLink(std.testing.io, "actual", "redirect", .{ .is_directory = true });
    const physical = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(physical);
    const path = try std.fs.path.join(std.testing.allocator, &.{ physical, "redirect", "new-install" });
    defer std.testing.allocator.free(path);
    try std.testing.expectError(error.InvalidInstallPath, ensureRoot(std.testing.allocator, std.testing.io, path));
    try std.testing.expectError(error.FileNotFound, tmp.dir.access(std.testing.io, "actual/new-install", .{}));
}
