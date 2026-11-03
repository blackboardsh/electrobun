//! Prepares archive-free updates while leaving the running app untouched.
//! Exact archive recipes reconstruct one immutable old tar in RAM. TRDIFF10
//! output and full-download fallback stream directly into a private sibling
//! stage; only a validated stage and its recipe are published for activation.
const std = @import("std");
const builtin = @import("builtin");
const archive = @import("archive_recipe.zig");
const patch = @import("stream_patch.zig");
const http = @import("prepare_update_http.zig");
const A = std.mem.Allocator;
const Io = std.Io;
const max_archive_bytes = 16 * 1024 * 1024 * 1024;
const prepared_name = ".electrobun-prepared-update.json";
const prepare_lock_name = ".electrobun-prepare.lock";

fn sha256(bytes: []const u8) [64]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

pub const Request = struct {
    schema_version: u32,
    transaction_id: []const u8,
    identifier: []const u8,
    channel: []const u8,
    platform: []const u8,
    arch: []const u8,
    version: []const u8,
    hash: []const u8,
    base_hash: []const u8,
    base_url: []const u8,
    artifact_file: []const u8,
    channel_root: []const u8,
    app_bundle_path: []const u8,
    tar_sha256: ?[]const u8 = null,
    tar_size: ?u64 = null,
};

pub const Prepared = struct {
    schema_version: u32 = 2,
    identifier: []const u8,
    channel: []const u8,
    platform: []const u8,
    arch: []const u8,
    version: []const u8,
    hash: []const u8,
    staging_path: []const u8,
    recipe_path: []const u8,
    recipe_sha256: []const u8,
    artifact_file: []const u8,
};

const Identity = struct {
    identifier: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
    name: ?[]const u8 = null,
    displayName: ?[]const u8 = null,
    baseUrl: ?[]const u8 = null,
};

fn nativePlatform() []const u8 {
    return switch (builtin.os.tag) {
        .macos => "macos",
        .windows => "win",
        .linux => "linux",
        else => @compileError("Unsupported update platform"),
    };
}
fn nativeArch() []const u8 {
    return switch (builtin.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        else => @compileError("Unsupported update architecture"),
    };
}
fn permissions(mode: u32) Io.File.Permissions {
    return if (builtin.os.tag == .windows) .default_file else .fromMode(@intCast(mode));
}
fn validComponent(value: []const u8) bool {
    archive.validatePath(value) catch return false;
    if (std.mem.indexOfScalar(u8, value, '/') != null) return false;
    // Request identities and artifact names use a portable namespace even
    // though application payload files may use native-only valid names.
    if (value[value.len - 1] == '.' or value[value.len - 1] == ' ') return false;
    for (value) |c| if (std.mem.indexOfScalar(u8, "\\:*?\"<>|", c) != null) return false;
    const stem = value[0 .. std.mem.indexOfScalar(u8, value, '.') orelse value.len];
    for ([_][]const u8{ "con", "prn", "aux", "nul" }) |reserved| if (std.ascii.eqlIgnoreCase(stem, reserved)) return false;
    if (stem.len == 4 and (std.ascii.eqlIgnoreCase(stem[0..3], "com") or std.ascii.eqlIgnoreCase(stem[0..3], "lpt")) and stem[3] >= '1' and stem[3] <= '9') return false;
    return true;
}
fn validHash(value: []const u8) bool {
    if (value.len == 0 or value.len > 13) return false;
    for (value) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'z')) return false;
    return true;
}
fn validVersion(value: []const u8) bool {
    if (value.len == 0 or value.len > 256 or !std.unicode.utf8ValidateSlice(value)) return false;
    for (value) |c| if (c < 32 or c == 127) return false;
    return true;
}
fn equalPath(a: []const u8, b: []const u8) bool {
    return if (builtin.os.tag == .windows) std.ascii.eqlIgnoreCase(a, b) else std.mem.eql(u8, a, b);
}
fn requireCanonical(a: A, path: []const u8) !void {
    if (!std.fs.path.isAbsolute(path)) return error.InvalidUpdatePath;
    const resolved = try std.fs.path.resolve(a, &.{path});
    defer a.free(resolved);
    if (!equalPath(resolved, path)) return error.InvalidUpdatePath;
    if (std.mem.indexOfScalar(u8, path, 0) != null) return error.InvalidUpdatePath;
}
fn requireAbsent(io: Io, parent: Io.Dir, name: []const u8) !void {
    _ = parent.statFile(io, name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    return error.UpdateStageAlreadyExists;
}
fn requireReplaceableFile(io: Io, parent: Io.Dir, name: []const u8) !void {
    const stat = parent.statFile(io, name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    if (stat.kind != .file) return error.InvalidUpdatePath;
}

/// The inode remains in place across runs. Unlinking an advisory lock would
/// permit another process to lock a new inode while the first still owns it.
/// Closing the handle (including process death) releases the operating-system
/// lock, so an interrupted helper cannot leave a permanently busy channel.
fn acquirePrepareLock(io: Io, channel: Io.Dir) !Io.File {
    const file = channel.createFile(io, prepare_lock_name, .{
        .read = true,
        .truncate = false,
        .exclusive = true,
        .permissions = permissions(0o600),
    }) catch |err| switch (err) {
        error.PathAlreadyExists => try channel.openFile(io, prepare_lock_name, .{
            .mode = .read_write,
            .follow_symlinks = false,
            .allow_directory = false,
        }),
        else => return err,
    };
    errdefer file.close(io);
    if ((try file.stat(io)).kind != .file) return error.InvalidUpdateLock;
    if (!try file.tryLock(io, .exclusive)) return error.UpdatePreparationBusy;
    if (builtin.os.tag != .windows) try file.setPermissions(io, permissions(0o600));
    return file;
}

/// Called only with this channel's exclusive prepare lock. An incomplete
/// private stage cannot belong to another live helper while the lock is held.
/// Published `.prepared-<hash>` directories have a separate recipe/record
/// validation path and are intentionally not included in this namespace.
fn pruneInterruptedStages(a: A, io: Io, app_parent: Io.Dir, app_name: []const u8) !void {
    const prefix = try std.fmt.allocPrint(a, "{s}.prepare-", .{app_name});
    defer a.free(prefix);
    var directory = try app_parent.openDir(io, ".", .{ .iterate = true });
    defer directory.close(io);
    var candidates: std.ArrayList([]u8) = .empty;
    defer {
        for (candidates.items) |name| a.free(name);
        candidates.deinit(a);
    }
    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        if (!std.mem.startsWith(u8, entry.name, prefix) or entry.name.len != prefix.len + 32) continue;
        var valid = true;
        for (entry.name[prefix.len..]) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) {
            valid = false;
            break;
        };
        if (!valid) continue;
        const stat = try directory.statFile(io, entry.name, .{ .follow_symlinks = false });
        if (stat.kind != .directory) return error.InvalidInterruptedUpdateStage;
        const copy = try a.dupe(u8, entry.name);
        errdefer a.free(copy);
        try candidates.append(a, copy);
    }
    for (candidates.items) |name| {
        // Check again immediately before deletion. deleteTree itself does not
        // traverse symlinks, including links inside an interrupted stage.
        if ((try directory.statFile(io, name, .{ .follow_symlinks = false })).kind != .directory)
            return error.InvalidInterruptedUpdateStage;
        try directory.deleteTree(io, name);
    }
}
fn readFile(a: A, io: Io, directory: Io.Dir, name: []const u8, limit: usize) ![]u8 {
    const file = try archive.openRegularFile(io, directory, name);
    defer file.close(io);
    const size = (try file.stat(io)).size;
    if (size > limit) return error.UpdateDocumentTooLarge;
    var buffer: [4096]u8 = undefined;
    var reader = file.reader(io, &buffer);
    return reader.interface.allocRemaining(a, .limited(limit));
}
fn readIdentity(a: A, io: Io, root: Io.Dir) !std.json.Parsed(Identity) {
    const bytes = try readFile(a, io, root, if (builtin.os.tag == .macos) "Contents/Resources/version.json" else "Resources/version.json", 1024 * 1024);
    defer a.free(bytes);
    return std.json.parseFromSlice(Identity, a, bytes, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
}
fn identifierRoot(a: A, env: *const std.process.Environ.Map, identifier: []const u8) ![]u8 {
    if (builtin.os.tag == .windows) {
        if (env.get("LOCALAPPDATA")) |base| return std.fs.path.resolve(a, &.{ base, identifier });
        const home = env.get("USERPROFILE") orelse return error.MissingUpdateHome;
        return std.fs.path.resolve(a, &.{ home, "AppData", "Local", identifier });
    }
    const home = env.get("HOME") orelse return error.MissingUpdateHome;
    if (builtin.os.tag == .macos) return std.fs.path.resolve(a, &.{ home, "Library", "Application Support", identifier });
    if (env.get("XDG_DATA_HOME")) |base| if (std.fs.path.isAbsolute(base)) return std.fs.path.resolve(a, &.{ base, identifier });
    return std.fs.path.resolve(a, &.{ home, ".local", "share", identifier });
}

fn validateRequest(a: A, io: Io, env: *const std.process.Environ.Map, request_path: []const u8, request: Request) !void {
    if (request.schema_version != 1 or request.transaction_id.len != 32 or !validComponent(request.identifier) or
        !validVersion(request.version) or !validHash(request.hash) or !validHash(request.base_hash) or
        !std.mem.eql(u8, request.platform, nativePlatform()) or !std.mem.eql(u8, request.arch, nativeArch())) return error.InvalidPrepareRequest;
    for (request.transaction_id) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return error.InvalidPrepareRequest;
    if (!std.mem.eql(u8, request.channel, "stable") and !std.mem.eql(u8, request.channel, "canary") and !std.mem.eql(u8, request.channel, "dev")) return error.InvalidPrepareRequest;
    if (!validComponent(request.artifact_file) or !std.mem.endsWith(u8, request.artifact_file, ".tar.zst")) return error.InvalidPrepareRequest;
    const prefix = try std.fmt.allocPrint(a, "{s}-{s}-{s}-", .{ request.channel, request.platform, request.arch });
    defer a.free(prefix);
    if (!std.mem.startsWith(u8, request.artifact_file, prefix)) return error.InvalidPrepareRequest;
    if (request.tar_sha256) |digest| if (!archive.isDigest(digest)) return error.InvalidPrepareRequest;
    if (request.tar_size) |size| if (size < 1024 or size > max_archive_bytes or size % 512 != 0) return error.InvalidPrepareRequest;
    if ((request.tar_sha256 == null) != (request.tar_size == null)) return error.InvalidPrepareRequest;
    const base_uri = try http.checkedUri(request.base_url);
    if (base_uri.query != null) return error.InvalidUpdateUrl;
    try requireCanonical(a, request_path);
    try requireCanonical(a, request.channel_root);
    try requireCanonical(a, request.app_bundle_path);
    const expected_identifier = try identifierRoot(a, env, request.identifier);
    defer a.free(expected_identifier);
    if (!equalPath(std.fs.path.dirname(request.channel_root) orelse return error.InvalidUpdatePath, expected_identifier)) return error.InvalidUpdatePath;
    const expected_name = try std.fmt.allocPrint(a, ".electrobun-prepare-{s}.json", .{request.transaction_id});
    defer a.free(expected_name);
    if (!equalPath(std.fs.path.dirname(request_path) orelse return error.InvalidUpdatePath, request.channel_root) or !std.mem.eql(u8, std.fs.path.basename(request_path), expected_name)) return error.InvalidUpdatePath;
    var identifier_directory = try Io.Dir.openDirAbsolute(io, expected_identifier, .{ .follow_symlinks = false });
    defer identifier_directory.close(io);
    var root = try identifier_directory.openDir(io, std.fs.path.basename(request.channel_root), .{ .follow_symlinks = false });
    defer root.close(io);
    const document = try archive.openRegularFile(io, root, expected_name);
    document.close(io);
    var app = try Io.Dir.openDirAbsolute(io, request.app_bundle_path, .{ .follow_symlinks = false });
    defer app.close(io);
    var identity = try readIdentity(a, io, app);
    defer identity.deinit();
    if (!std.mem.eql(u8, identity.value.identifier, request.identifier) or !std.mem.eql(u8, identity.value.channel, request.channel) or !std.mem.eql(u8, identity.value.hash, request.base_hash) or
        !std.mem.eql(u8, std.mem.trimEnd(u8, identity.value.baseUrl orelse return error.InvalidUpdateIdentity, "/"), std.mem.trimEnd(u8, request.base_url, "/"))) return error.InvalidUpdateIdentity;
    const root_name = std.fs.path.basename(request.channel_root);
    var root_matches = std.mem.eql(u8, root_name, request.channel);
    if (identity.value.name) |name| root_matches = root_matches or (validComponent(name) and std.mem.eql(u8, root_name, name));
    if (identity.value.displayName) |display| {
        const legacy_name = if (std.mem.eql(u8, request.channel, "stable")) try a.dupe(u8, display) else try std.fmt.allocPrint(a, "{s}-{s}", .{ display, request.channel });
        defer a.free(legacy_name);
        root_matches = root_matches or (validComponent(legacy_name) and std.mem.eql(u8, root_name, legacy_name));
    }
    if (!root_matches) return error.InvalidUpdatePath;
    if (builtin.os.tag != .macos) {
        const expected_app = try std.fs.path.join(a, &.{ request.channel_root, "app" });
        defer a.free(expected_app);
        if (!equalPath(expected_app, request.app_bundle_path)) return error.InvalidUpdatePath;
    }
}

fn atomicJson(io: Io, directory: Io.Dir, name: []const u8, value: anytype) !void {
    try requireReplaceableFile(io, directory, name);
    var atomic = try directory.createFileAtomic(io, name, .{ .replace = true, .permissions = permissions(0o600) });
    defer atomic.deinit(io);
    var buffer: [16 * 1024]u8 = undefined;
    var writer = atomic.file.writer(io, &buffer);
    try std.json.Stringify.value(value, .{}, &writer.interface);
    try writer.interface.flush();
    try atomic.file.sync(io);
    try atomic.replace(io);
}

fn artifactUrl(a: A, base: []const u8, file: []const u8, transaction: []const u8) ![]u8 {
    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(a);
    try result.appendSlice(a, std.mem.trimEnd(u8, base, "/"));
    try result.append(a, '/');
    const digits = "0123456789ABCDEF";
    for (file) |c| {
        if (std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "-_.~", c) != null) try result.append(a, c) else try result.appendSlice(a, &.{ '%', digits[c >> 4], digits[c & 15] });
    }
    try result.appendSlice(a, "?cache=");
    try result.appendSlice(a, transaction);
    return result.toOwnedSlice(a);
}

const Engine = struct {
    allocator: A,
    io: Io,
    request: Request,
    extraction: Io.Dir,
    app_parent: Io.Dir,
    temporary_name: []const u8,
    temporary_path: []const u8,
    staging_name: []const u8,
    staging_path: []const u8,
    stage_owned: bool = false,

    fn clearStage(self: *Engine) !void {
        if (!self.stage_owned) return;
        const stat = try self.app_parent.statFile(self.io, self.temporary_name, .{ .follow_symlinks = false });
        if (stat.kind != .directory) return error.InvalidUpdateStage;
        try self.app_parent.deleteTree(self.io, self.temporary_name);
        self.stage_owned = false;
    }
    fn createStage(self: *Engine) !Io.Dir {
        try self.app_parent.createDir(self.io, self.temporary_name, permissions(0o700));
        self.stage_owned = true;
        return self.app_parent.openDir(self.io, self.temporary_name, .{ .follow_symlinks = false });
    }
    fn recipeName(self: *Engine, hash: []const u8) ![]u8 {
        return std.fmt.allocPrint(self.allocator, "{s}.recipe.json", .{hash});
    }
    fn baseline(self: *Engine) !archive.Owned {
        const name = try self.recipeName(self.request.base_hash);
        defer self.allocator.free(name);
        if (readFile(self.allocator, self.io, self.extraction, name, archive.max_recipe_bytes)) |bytes| {
            defer self.allocator.free(bytes);
            return archive.parse(self.allocator, bytes);
        } else |err| if (err != error.FileNotFound) return err;
        const old_name = try std.fmt.allocPrint(self.allocator, "{s}.tar", .{self.request.base_hash});
        defer self.allocator.free(old_name);
        const old = try archive.openRegularFile(self.io, self.extraction, old_name);
        defer old.close(self.io);
        return archive.index(self.allocator, self.io, old);
    }
    fn snapshot(self: *Engine, record: archive.Recipe, root_path: []const u8) ![]u8 {
        if (record.archive_size > max_archive_bytes) return error.UpdateArchiveTooLarge;
        const size = std.math.cast(usize, record.archive_size) orelse return error.UpdateArchiveTooLarge;
        const bytes = try self.allocator.alloc(u8, size);
        errdefer self.allocator.free(bytes);
        var output: Io.Writer = .fixed(bytes);
        var root = try Io.Dir.openDirAbsolute(self.io, root_path, .{ .follow_symlinks = false });
        defer root.close(self.io);
        try archive.reconstruct(self.allocator, self.io, record, root, &output);
        if (output.end != size) return error.ArchiveSizeMismatch;
        return bytes;
    }
    fn migrateBaseline(self: *Engine, record: archive.Recipe) !void {
        const name = try self.recipeName(self.request.base_hash);
        defer self.allocator.free(name);
        try atomicJson(self.io, self.extraction, name, record);
        const old_name = try std.fmt.allocPrint(self.allocator, "{s}.tar", .{self.request.base_hash});
        defer self.allocator.free(old_name);
        try requireReplaceableFile(self.io, self.extraction, old_name);
        self.extraction.deleteFile(self.io, old_name) catch |err| if (err != error.FileNotFound) return err;
    }
    fn stageIdentity(self: *Engine, record: archive.Recipe) !std.json.Parsed(Identity) {
        return self.stageIdentityAt(record, self.temporary_name, false);
    }
    fn stageIdentityAt(self: *Engine, record: archive.Recipe, stage_name: []const u8, verify: bool) !std.json.Parsed(Identity) {
        var stage = try self.app_parent.openDir(self.io, stage_name, .{ .follow_symlinks = false, .iterate = true });
        defer stage.close(self.io);
        var iterator = stage.iterate();
        const only = try iterator.next(self.io) orelse return error.InvalidUpdateStage;
        if (only.kind != .directory or !std.mem.eql(u8, only.name, record.root) or try iterator.next(self.io) != null) return error.InvalidUpdateStage;
        var root = try stage.openDir(self.io, record.root, .{ .follow_symlinks = false, .iterate = verify });
        defer root.close(self.io);
        if (verify) try archive.verifyTree(self.allocator, self.io, record, root);
        var identity = try readIdentity(self.allocator, self.io, root);
        errdefer identity.deinit();
        if (!std.mem.eql(u8, identity.value.identifier, self.request.identifier) or !std.mem.eql(u8, identity.value.channel, self.request.channel) or !validHash(identity.value.hash) or !validVersion(identity.value.version)) return error.InvalidUpdateIdentity;
        const launcher = try archive.openRegularFile(self.io, root, if (builtin.os.tag == .macos) "Contents/MacOS/launcher" else if (builtin.os.tag == .windows) "bin/launcher.exe" else "bin/launcher");
        launcher.close(self.io);
        return identity;
    }
    fn prepared(self: *Engine, a: A) !Prepared {
        const recipe_name = try std.fmt.allocPrint(a, "{s}.recipe.json", .{self.request.hash});
        const file = try archive.openRegularFile(self.io, self.extraction, recipe_name);
        defer file.close(self.io);
        const recipe_size = (try file.stat(self.io)).size;
        if (recipe_size > archive.max_recipe_bytes) return error.RecipeTooLarge;
        const digest = try archive.hashFile(self.io, file, recipe_size);
        return .{
            .identifier = self.request.identifier,
            .channel = self.request.channel,
            .platform = self.request.platform,
            .arch = self.request.arch,
            .version = self.request.version,
            .hash = self.request.hash,
            .staging_path = self.staging_path,
            .recipe_path = try std.fs.path.join(a, &.{ self.request.channel_root, "self-extraction", recipe_name }),
            .recipe_sha256 = try a.dupe(u8, &digest),
            .artifact_file = self.request.artifact_file,
        };
    }
    fn reuseOrphan(self: *Engine) !bool {
        const stat = self.app_parent.statFile(self.io, self.staging_name, .{ .follow_symlinks = false }) catch |err| switch (err) {
            error.FileNotFound => return false,
            else => return err,
        };
        if (stat.kind != .directory) return error.InvalidOrphanedUpdateStage;
        const name = try self.recipeName(self.request.hash);
        defer self.allocator.free(name);
        const bytes = try readFile(self.allocator, self.io, self.extraction, name, archive.max_recipe_bytes);
        defer self.allocator.free(bytes);
        if (readFile(self.allocator, self.io, self.extraction, prepared_name, 64 * 1024)) |prepared_bytes| {
            defer self.allocator.free(prepared_bytes);
            const schema = try std.json.parseFromSlice(struct { schema_version: u32 }, self.allocator, prepared_bytes, .{ .ignore_unknown_fields = true });
            defer schema.deinit();
            if (schema.value.schema_version == 2) {
                const saved = try std.json.parseFromSlice(Prepared, self.allocator, prepared_bytes, .{});
                defer saved.deinit();
                if (std.mem.eql(u8, saved.value.hash, self.request.hash)) {
                    if (!archive.isDigest(saved.value.recipe_sha256)) return error.InvalidPreparedUpdate;
                    const digest = sha256(bytes);
                    if (!std.mem.eql(u8, &digest, saved.value.recipe_sha256)) return error.PreparedRecipeHashMismatch;
                }
            }
        } else |err| if (err != error.FileNotFound) return err;
        var record = try archive.parse(self.allocator, bytes);
        defer record.deinit();
        var identity = try self.stageIdentityAt(record.value, self.staging_name, true);
        defer identity.deinit();
        try self.validateFinal(record.value, identity.value);
        return true;
    }
    fn pruneSupersededStage(self: *Engine) !void {
        const a = self.allocator;
        const bytes = readFile(a, self.io, self.extraction, prepared_name, 64 * 1024) catch |err| switch (err) {
            error.FileNotFound => return,
            else => return err,
        };
        defer a.free(bytes);
        // Legacy prepared archives are pruned only after replacement is ready.
        var document = std.json.parseFromSlice(Prepared, a, bytes, .{}) catch return;
        defer document.deinit();
        const old = document.value;
        if (old.schema_version != 2 or !validHash(old.hash) or std.mem.eql(u8, old.hash, self.request.base_hash) or std.mem.eql(u8, old.hash, self.request.hash)) return;
        if (!std.mem.eql(u8, old.identifier, self.request.identifier) or !std.mem.eql(u8, old.channel, self.request.channel) or !std.mem.eql(u8, old.platform, self.request.platform) or !std.mem.eql(u8, old.arch, self.request.arch)) return error.InvalidPreparedUpdate;
        const stage_name = try std.fmt.allocPrint(a, "{s}.prepared-{s}", .{ std.fs.path.basename(self.request.app_bundle_path), old.hash });
        defer a.free(stage_name);
        const expected_stage = try std.fs.path.join(a, &.{ std.fs.path.dirname(self.request.app_bundle_path).?, stage_name });
        defer a.free(expected_stage);
        const recipe_name = try self.recipeName(old.hash);
        defer a.free(recipe_name);
        const expected_recipe = try std.fs.path.join(a, &.{ self.request.channel_root, "self-extraction", recipe_name });
        defer a.free(expected_recipe);
        if (!equalPath(old.staging_path, expected_stage) or !equalPath(old.recipe_path, expected_recipe)) return error.InvalidPreparedUpdate;
        const recipe_bytes = try readFile(a, self.io, self.extraction, recipe_name, archive.max_recipe_bytes);
        defer a.free(recipe_bytes);
        if (!archive.isDigest(old.recipe_sha256)) return error.InvalidPreparedUpdate;
        const digest = sha256(recipe_bytes);
        if (!std.mem.eql(u8, &digest, old.recipe_sha256)) return error.PreparedRecipeHashMismatch;
        var recipe = try archive.parse(a, recipe_bytes);
        defer recipe.deinit();
        var identity = try self.stageIdentityAt(recipe.value, stage_name, true);
        defer identity.deinit();
        if (!std.mem.eql(u8, identity.value.hash, old.hash) or !std.mem.eql(u8, identity.value.version, old.version)) return error.InvalidPreparedUpdate;
        try self.app_parent.deleteTree(self.io, stage_name);
        try self.extraction.deleteFile(self.io, recipe_name);
        try self.extraction.deleteFile(self.io, prepared_name);
    }
    fn pruneObsoleteArchives(self: *Engine) !void {
        var directory = try self.extraction.openDir(self.io, ".", .{ .iterate = true });
        defer directory.close(self.io);
        var iterator = directory.iterate();
        while (try iterator.next(self.io)) |entry| {
            if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".tar")) continue;
            const hash = entry.name[0 .. entry.name.len - 4];
            if (!validHash(hash) or std.mem.eql(u8, hash, self.request.base_hash)) continue;
            try directory.deleteFile(self.io, entry.name);
        }
    }
    fn validateFinal(self: *Engine, record: archive.Recipe, identity: Identity) !void {
        if (!std.mem.eql(u8, identity.hash, self.request.hash) or !std.mem.eql(u8, identity.version, self.request.version)) return error.InvalidUpdateIdentity;
        if (self.request.tar_size) |size| if (size != record.archive_size) return error.ArchiveSizeMismatch;
        if (self.request.tar_sha256) |digest| if (!std.mem.eql(u8, digest, record.archive_sha256)) return error.ArchiveHashMismatch;
    }
    fn patchChain(self: *Engine) !archive.Owned {
        var arena: std.heap.ArenaAllocator = .init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        var current = try self.baseline();
        defer current.deinit();
        var hash = self.request.base_hash;
        var source_path = self.request.app_bundle_path;
        var visited: std.StringHashMapUnmanaged(void) = .empty;
        defer visited.deinit(a);
        for (0..64) |index| {
            try self.io.checkCancel();
            if (visited.contains(hash)) return error.UpdatePatchCycle;
            try visited.put(a, hash, {});
            const old_tar = try self.snapshot(current.value, source_path);
            defer self.allocator.free(old_tar);
            if (index == 0) try self.migrateBaseline(current.value);
            // Once reconstructed, no subsequent patch read depends on this
            // intermediate stage. Delete it before writing the next stage.
            try self.clearStage();
            const patch_name = try std.fmt.allocPrint(a, ".patch-{s}-{d}.partial", .{ self.request.transaction_id, index });
            const patch_file = try self.extraction.createFile(self.io, patch_name, .{ .read = true, .exclusive = true, .permissions = permissions(0o600) });
            defer self.extraction.deleteFile(self.io, patch_name) catch {};
            defer patch_file.close(self.io);
            const remote_name = try std.fmt.allocPrint(a, "{s}-{s}-{s}-{s}.patch", .{ self.request.channel, self.request.platform, self.request.arch, hash });
            const url = try artifactUrl(a, self.request.base_url, remote_name, self.request.transaction_id);
            try http.download(self.allocator, self.io, url, patch_file, .{});
            var memory: patch.MemorySource = .{ .bytes = old_tar };
            var reader: patch.PatchReader = undefined;
            try reader.init(self.allocator, self.io, patch_file, memory.source());
            defer reader.deinit();
            if (reader.expectedSize() > max_archive_bytes) return error.UpdateArchiveTooLarge;
            var stage = try self.createStage();
            var next = blk: {
                defer stage.close(self.io);
                break :blk archive.extractReader(self.allocator, self.io, &reader.interface, reader.expectedSize(), stage) catch |err| return reader.err orelse err;
            };
            errdefer next.deinit();
            if (!reader.finished) return error.IncompleteUpdatePatch;
            var identity = try self.stageIdentity(next.value);
            defer identity.deinit();
            if (std.mem.eql(u8, identity.value.hash, self.request.hash)) {
                try self.validateFinal(next.value, identity.value);
                return next;
            }
            hash = try a.dupe(u8, identity.value.hash);
            source_path = try std.fs.path.join(a, &.{ self.temporary_path, next.value.root });
            current.deinit();
            current = next;
        }
        return error.UpdatePatchChainTooLong;
    }
    fn fullDownload(self: *Engine) !archive.Owned {
        try self.clearStage();
        var stage = try self.createStage();
        defer stage.close(self.io);
        const Context = struct {
            engine: *Engine,
            stage: Io.Dir,
            result: ?archive.Owned = null,
            fn consume(pointer: *anyopaque, compressed: *Io.Reader) !void {
                const context: *@This() = @ptrCast(@alignCast(pointer));
                const a = context.engine.allocator;
                const zstd = std.compress.zstd;
                const window = try a.alloc(u8, zstd.default_window_len + zstd.block_size_max);
                defer a.free(window);
                var decoder: zstd.Decompress = .init(compressed, window, .{ .verify_checksum = false });
                var limit_buffer: [4096]u8 = undefined;
                var limited = decoder.reader.limited(.limited64(max_archive_bytes + 1), &limit_buffer);
                context.result = archive.extractReader(a, context.engine.io, &limited.interface, context.engine.request.tar_size, context.stage) catch |err| return decoder.err orelse err;
                if (context.result.?.value.archive_size > max_archive_bytes) return error.UpdateArchiveTooLarge;
            }
        };
        var context: Context = .{ .engine = self, .stage = stage };
        errdefer if (context.result) |*record| record.deinit();
        const url = try artifactUrl(self.allocator, self.request.base_url, self.request.artifact_file, self.request.transaction_id);
        defer self.allocator.free(url);
        try http.fetch(self.allocator, self.io, url, &context, Context.consume, .{});
        var identity = try self.stageIdentity(context.result.?.value);
        defer identity.deinit();
        try self.validateFinal(context.result.?.value, identity.value);
        return context.result.?;
    }
};

pub fn run(allocator: A, io: Io, environ_map: *const std.process.Environ.Map, request_path: []const u8) !void {
    try requireCanonical(allocator, request_path);
    var request_parent = try Io.Dir.openDirAbsolute(io, std.fs.path.dirname(request_path) orelse return error.InvalidUpdatePath, .{ .follow_symlinks = false });
    defer request_parent.close(io);
    const contents = try readFile(allocator, io, request_parent, std.fs.path.basename(request_path), 64 * 1024);
    defer allocator.free(contents);
    var document = try std.json.parseFromSlice(Request, allocator, contents, .{});
    defer document.deinit();
    const request = document.value;
    try validateRequest(allocator, io, environ_map, request_path, request);
    var arena: std.heap.ArenaAllocator = .init(allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var root = try Io.Dir.openDirAbsolute(io, request.channel_root, .{ .follow_symlinks = false });
    defer root.close(io);
    const prepare_lock = try acquirePrepareLock(io, root);
    defer prepare_lock.close(io);
    root.createDir(io, "self-extraction", permissions(0o700)) catch |err| if (err != error.PathAlreadyExists) return err;
    var extraction = try root.openDir(io, "self-extraction", .{ .follow_symlinks = false });
    defer extraction.close(io);
    const app_parent_path = std.fs.path.dirname(request.app_bundle_path) orelse return error.InvalidUpdatePath;
    var parent = try Io.Dir.openDirAbsolute(io, app_parent_path, .{ .follow_symlinks = false });
    defer parent.close(io);
    const app_name = std.fs.path.basename(request.app_bundle_path);
    try pruneInterruptedStages(allocator, io, parent, app_name);
    const temporary_name = try std.fmt.allocPrint(a, "{s}.prepare-{s}", .{ app_name, request.transaction_id });
    const staging_name = try std.fmt.allocPrint(a, "{s}.prepared-{s}", .{ app_name, request.hash });
    try requireAbsent(io, parent, temporary_name);
    var engine: Engine = .{
        .allocator = allocator,
        .io = io,
        .request = request,
        .extraction = extraction,
        .app_parent = parent,
        .temporary_name = temporary_name,
        .temporary_path = try std.fs.path.join(a, &.{ app_parent_path, temporary_name }),
        .staging_name = staging_name,
        .staging_path = try std.fs.path.join(a, &.{ app_parent_path, staging_name }),
    };
    defer engine.clearStage() catch {};
    try engine.pruneSupersededStage();
    if (try engine.reuseOrphan()) {
        try atomicJson(io, extraction, prepared_name, try engine.prepared(a));
        engine.pruneObsoleteArchives() catch |err| std.debug.print("Could not remove obsolete update archives: {s}\n", .{@errorName(err)});
        return;
    }
    var record = engine.patchChain() catch |err| blk: {
        if (err == error.Canceled) return err;
        std.debug.print("Delta preparation unavailable ({s}); streaming the full update.\n", .{@errorName(err)});
        break :blk try engine.fullDownload();
    };
    defer record.deinit();
    var final_identity = try engine.stageIdentityAt(record.value, temporary_name, true);
    defer final_identity.deinit();
    try engine.validateFinal(record.value, final_identity.value);
    const recipe_name = try std.fmt.allocPrint(a, "{s}.recipe.json", .{request.hash});
    try atomicJson(io, extraction, recipe_name, record.value);
    try parent.renamePreserve(temporary_name, parent, staging_name, io);
    engine.stage_owned = false;
    var published = false;
    defer if (!published) parent.deleteTree(io, staging_name) catch {};
    try atomicJson(io, extraction, prepared_name, try engine.prepared(a));
    published = true;
    engine.pruneObsoleteArchives() catch |err| std.debug.print("Could not remove obsolete update archives: {s}\n", .{@errorName(err)});
}

test "prepare update URL encoding preserves artifact as one segment" {
    const a = std.testing.allocator;
    const url = try artifactUrl(a, "https://example.test/releases/", "stable-macos-arm64-My App.tar.zst", "abc");
    defer a.free(url);
    try std.testing.expectEqualStrings("https://example.test/releases/stable-macos-arm64-My%20App.tar.zst?cache=abc", url);
}

test "prepare update paths reject traversal and noncanonical absolutes" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.InvalidUpdatePath, requireCanonical(a, "relative/request.json"));
    if (builtin.os.tag != .windows) try std.testing.expectError(error.InvalidUpdatePath, requireCanonical(a, "/tmp/../tmp/request.json"));
    for ([_][]const u8{ "../escape", "/absolute", "CON", "file.", "foo/bar", "bad\\name" }) |name| try std.testing.expect(!validComponent(name));
}

test "prepare update refuses a missing request before creating state" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(root);
    const request_path = try std.fs.path.join(a, &.{ root, "missing.json" });
    defer a.free(request_path);
    var env = std.process.Environ.Map.init(a);
    defer env.deinit();
    try std.testing.expectError(error.FileNotFound, run(a, io, &env, request_path));
}

fn testTarEntry(writer: *Io.Writer, name: []const u8, kind: u8, data: []const u8) !void {
    if (name.len > 100) return error.TestPathTooLong;
    var header: [512]u8 = @splat(0);
    @memcpy(header[0..name.len], name);
    @memcpy(header[100..108], "0000755\x00");
    @memcpy(header[108..116], "0000000\x00");
    @memcpy(header[116..124], "0000000\x00");
    _ = try std.fmt.bufPrint(header[124..135], "{o:0>11}", .{data.len});
    @memcpy(header[136..148], "00000000000\x00");
    @memset(header[148..156], ' ');
    header[156] = kind;
    @memcpy(header[257..263], "ustar\x00");
    @memcpy(header[263..265], "00");
    var checksum: u32 = 0;
    for (header) |byte| checksum += byte;
    _ = try std.fmt.bufPrint(header[148..154], "{o:0>6}", .{checksum});
    header[154] = 0;
    header[155] = ' ';
    try writer.writeAll(&header);
    try writer.writeAll(data);
    try writer.splatByteAll(0, (512 - data.len % 512) % 512);
}

fn testTar(a: A, root: []const u8, identity: Identity) ![]u8 {
    var writer: Io.Writer.Allocating = .init(a);
    defer writer.deinit();
    try testTarEntry(&writer.writer, root, '5', "");
    const resources = if (builtin.os.tag == .macos) "Contents/Resources" else "Resources";
    const binary = if (builtin.os.tag == .macos) "Contents/MacOS" else "bin";
    if (builtin.os.tag == .macos) try testTarEntry(&writer.writer, try std.fmt.allocPrint(a, "{s}/Contents", .{root}), '5', "");
    try testTarEntry(&writer.writer, try std.fmt.allocPrint(a, "{s}/{s}", .{ root, resources }), '5', "");
    try testTarEntry(&writer.writer, try std.fmt.allocPrint(a, "{s}/{s}", .{ root, binary }), '5', "");
    const json = try std.json.Stringify.valueAlloc(a, identity, .{});
    try testTarEntry(&writer.writer, try std.fmt.allocPrint(a, "{s}/{s}/version.json", .{ root, resources }), '0', json);
    try testTarEntry(&writer.writer, try std.fmt.allocPrint(a, "{s}/{s}/launcher{s}", .{ root, binary, if (builtin.os.tag == .windows) ".exe" else "" }), '0', "launcher fixture bytes");
    try writer.writer.splatByteAll(0, 1024);
    return writer.toOwnedSlice();
}

fn testZstd(a: A, bytes: []const u8) ![]u8 {
    var writer: Io.Writer.Allocating = .init(a);
    defer writer.deinit();
    try writer.writer.writeAll("\x28\xb5\x2f\xfd\x00\x38");
    var position: usize = 0;
    while (true) {
        const count = @min(bytes.len - position, std.compress.zstd.block_size_max);
        const last: u24 = @intFromBool(position + count == bytes.len);
        try writer.writer.writeInt(u24, @as(u24, @intCast(count)) << 3 | last, .little);
        try writer.writer.writeAll(bytes[position..][0..count]);
        position += count;
        if (last != 0) break;
    }
    return writer.toOwnedSlice();
}

fn testLiteralPatch(a: A, target_tar: []const u8) ![]u8 {
    var control: [24]u8 = @splat(0);
    std.mem.writeInt(u64, control[8..16], target_tar.len, .little);
    const control_frame = try testZstd(a, &control);
    const diff_frame = try testZstd(a, "");
    const extra_frame = try testZstd(a, target_tar);
    var header: [32]u8 = @splat(0);
    @memcpy(header[0..8], "TRDIFF10");
    std.mem.writeInt(u64, header[8..16], control_frame.len, .little);
    std.mem.writeInt(u64, header[16..24], diff_frame.len, .little);
    std.mem.writeInt(u64, header[24..32], target_tar.len, .little);
    return std.mem.concat(a, u8, &.{ &header, control_frame, diff_frame, extra_frame });
}

const TestServer = struct {
    listener: Io.net.Server,
    responses: []const Response = &.{},
    closed: bool = false,
    const Response = struct { path: []const u8, body: []const u8, code: u16 = 200 };

    fn init() !TestServer {
        const address = try Io.net.IpAddress.parse("127.0.0.1", 0);
        return .{ .listener = try address.listen(std.testing.io, .{}) };
    }
    fn deinit(self: *TestServer) void {
        if (!self.closed) self.listener.deinit(std.testing.io);
        self.closed = true;
    }
    fn baseUrl(self: *TestServer, a: A) ![]u8 {
        return std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{self.listener.socket.address.getPort()});
    }
    fn serve(self: *TestServer) !void {
        const io = std.testing.io;
        for (self.responses) |response| {
            const connection = try self.listener.accept(io);
            defer connection.close(io);
            var buffer: [4096]u8 = undefined;
            var reader = connection.reader(io, &buffer);
            const line = try reader.interface.takeDelimiterInclusive('\n');
            var parts = std.mem.splitScalar(u8, line, ' ');
            try std.testing.expectEqualStrings("GET", parts.next().?);
            const target = parts.next().?;
            const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
            try std.testing.expectEqualStrings(response.path, path);
            while (!std.mem.eql(u8, try reader.interface.takeDelimiterInclusive('\n'), "\r\n")) {}
            var output_buffer: [4096]u8 = undefined;
            var writer = connection.writer(io, &output_buffer);
            try writer.interface.print("HTTP/1.1 {d} Response\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ response.code, response.body.len });
            try writer.interface.writeAll(response.body);
            try writer.interface.flush();
        }
    }
};

const TestFixture = struct {
    arena: std.heap.ArenaAllocator,
    temporary: std.testing.TmpDir,
    environment: std.process.Environ.Map,
    request: Request,
    request_path: []const u8,
    old_tar: []const u8,
    new_tar: []const u8,
    stage_path: []const u8,
    extraction_path: []const u8,
    root_name: []const u8,

    fn init(base_url: []const u8) !TestFixture {
        const io = std.testing.io;
        var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        var temporary = std.testing.tmpDir(.{});
        errdefer temporary.cleanup();
        const home = try temporary.dir.realPathFileAlloc(io, ".", a);
        var env: std.process.Environ.Map = .init(a);
        try env.put("HOME", home);
        try env.put("USERPROFILE", home);
        const data_root = try std.fs.path.join(a, &.{ home, "data" });
        try env.put("XDG_DATA_HOME", data_root);
        try env.put("LOCALAPPDATA", data_root);
        const identifier = "dev.example.prepare";
        const channel_root = try std.fs.path.join(a, &.{ try identifierRoot(a, &env, identifier), "stable" });
        const extraction_path = try std.fs.path.join(a, &.{ channel_root, "self-extraction" });
        try Io.Dir.cwd().createDirPath(io, extraction_path);
        const parent_path = if (builtin.os.tag == .macos) try std.fs.path.join(a, &.{ home, "Installed" }) else channel_root;
        try Io.Dir.cwd().createDirPath(io, parent_path);
        const root_name = if (builtin.os.tag == .macos) "Test.app" else "app";
        const installed_path = try std.fs.path.join(a, &.{ parent_path, root_name });
        const old_tar = try testTar(a, root_name, .{ .identifier = identifier, .channel = "stable", .version = "1.0.0", .hash = "base123", .name = "Test", .displayName = "Test", .baseUrl = base_url });
        const new_tar = try testTar(a, root_name, .{ .identifier = identifier, .channel = "stable", .version = "2.0.0", .hash = "next123", .name = "Test", .displayName = "Test", .baseUrl = base_url });
        var parent = try Io.Dir.openDirAbsolute(io, parent_path, .{});
        defer parent.close(io);
        var source: Io.Reader = .fixed(old_tar);
        var initial_recipe = try archive.extractReader(a, io, &source, old_tar.len, parent);
        defer initial_recipe.deinit();
        var next_source: Io.Reader = .fixed(new_tar);
        var next_recipe = try archive.indexReader(a, &next_source, new_tar.len, null);
        defer next_recipe.deinit();
        var extraction = try Io.Dir.openDirAbsolute(io, extraction_path, .{});
        defer extraction.close(io);
        try extraction.writeFile(io, .{ .sub_path = "base123.tar", .data = old_tar });
        const transaction = "0123456789abcdef0123456789abcdef";
        const request: Request = .{
            .schema_version = 1,
            .transaction_id = transaction,
            .identifier = identifier,
            .channel = "stable",
            .platform = nativePlatform(),
            .arch = nativeArch(),
            .version = "2.0.0",
            .hash = "next123",
            .base_hash = "base123",
            .base_url = try a.dupe(u8, base_url),
            .artifact_file = try std.fmt.allocPrint(a, "stable-{s}-{s}-Test.tar.zst", .{ nativePlatform(), nativeArch() }),
            .channel_root = channel_root,
            .app_bundle_path = installed_path,
            .tar_size = new_tar.len,
            .tar_sha256 = try a.dupe(u8, next_recipe.value.archive_sha256),
        };
        var fixture: TestFixture = .{
            .arena = arena,
            .temporary = temporary,
            .environment = env,
            .request = request,
            .request_path = try std.fs.path.join(a, &.{ channel_root, try std.fmt.allocPrint(a, ".electrobun-prepare-{s}.json", .{transaction}) }),
            .old_tar = old_tar,
            .new_tar = new_tar,
            .stage_path = try std.fmt.allocPrint(a, "{s}.prepared-next123", .{installed_path}),
            .extraction_path = extraction_path,
            .root_name = root_name,
        };
        try fixture.writeRequest();
        return fixture;
    }
    fn deinit(self: *TestFixture) void {
        self.temporary.cleanup();
        self.arena.deinit();
    }
    fn writeRequest(self: *TestFixture) !void {
        const a = self.arena.allocator();
        const json = try std.json.Stringify.valueAlloc(a, self.request, .{});
        try Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = self.request_path, .data = json });
    }
    fn expectPrepared(self: *TestFixture) !void {
        const a = self.arena.allocator();
        const io = std.testing.io;
        var extraction = try Io.Dir.openDirAbsolute(io, self.extraction_path, .{});
        defer extraction.close(io);
        const json = try readFile(a, io, extraction, prepared_name, 64 * 1024);
        const prepared = try std.json.parseFromSlice(Prepared, a, json, .{});
        try std.testing.expectEqual(@as(u32, 2), prepared.value.schema_version);
        try std.testing.expectEqualStrings(self.stage_path, prepared.value.staging_path);
        const recipe_bytes = try readFile(a, io, extraction, try std.fmt.allocPrint(a, "{s}.recipe.json", .{self.request.hash}), archive.max_recipe_bytes);
        try std.testing.expectEqualStrings(&sha256(recipe_bytes), prepared.value.recipe_sha256);
        var record = try archive.parse(a, recipe_bytes);
        defer record.deinit();
        var root = try Io.Dir.openDirAbsolute(io, try std.fs.path.join(a, &.{ self.stage_path, self.root_name }), .{});
        defer root.close(io);
        var output: Io.Writer.Allocating = .init(a);
        try archive.reconstruct(a, io, record.value, root, &output.writer);
        try std.testing.expectEqualSlices(u8, self.new_tar, output.written());
        var installed = try Io.Dir.openDirAbsolute(io, self.request.app_bundle_path, .{});
        defer installed.close(io);
        var identity = try readIdentity(a, io, installed);
        defer identity.deinit();
        try std.testing.expectEqualStrings("base123", identity.value.hash);
        try std.testing.expectError(error.FileNotFound, extraction.access(io, try std.fmt.allocPrint(a, "{s}.tar", .{self.request.hash}), .{}));
    }
};

test "native preparation migrates legacy tar, streams patch, and recovers published orphan without network" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var server = try TestServer.init();
    defer server.deinit();
    const base = try server.baseUrl(a);
    defer a.free(base);
    var fixture = try TestFixture.init(base);
    defer fixture.deinit();
    const arena = fixture.arena.allocator();
    const abandoned = try std.fmt.allocPrint(arena, "{s}.prepare-ffffffffffffffffffffffffffffffff", .{fixture.request.app_bundle_path});
    const same_transaction = try std.fmt.allocPrint(arena, "{s}.prepare-{s}", .{ fixture.request.app_bundle_path, fixture.request.transaction_id });
    const unrelated = try std.fmt.allocPrint(arena, "{s}.prepare-user-backup", .{fixture.request.app_bundle_path});
    for ([_][]const u8{ abandoned, same_transaction, unrelated }) |path| {
        try Io.Dir.cwd().createDirPath(io, path);
        try Io.Dir.cwd().writeFile(io, .{ .sub_path = try std.fs.path.join(arena, &.{ path, "partial" }), .data = "interrupted extraction" });
    }
    const patch_bytes = try testLiteralPatch(arena, fixture.new_tar);
    server.responses = &.{.{ .path = try std.fmt.allocPrint(arena, "/stable-{s}-{s}-base123.patch", .{ nativePlatform(), nativeArch() }), .body = patch_bytes }};
    var serving = try io.concurrent(TestServer.serve, .{&server});
    defer serving.cancel(io) catch {};
    try run(a, io, &fixture.environment, fixture.request_path);
    try serving.await(io);
    server.deinit();
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().access(io, abandoned, .{}));
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().access(io, same_transaction, .{}));
    try Io.Dir.cwd().access(io, unrelated, .{});
    try fixture.expectPrepared();
    var extraction = try Io.Dir.openDirAbsolute(io, fixture.extraction_path, .{});
    defer extraction.close(io);
    try std.testing.expectError(error.FileNotFound, extraction.access(io, "base123.tar", .{}));
    try extraction.access(io, "base123.recipe.json", .{});
    // Simulate a crash after the complete stage/recipe publish but before the
    // prepared pointer is committed. Recovery must work with the server gone.
    try extraction.deleteFile(io, prepared_name);
    try run(a, io, &fixture.environment, fixture.request_path);
    try fixture.expectPrepared();
    const recipe_bytes = try readFile(arena, io, extraction, "next123.recipe.json", archive.max_recipe_bytes);
    try extraction.writeFile(io, .{ .sub_path = "next123.recipe.json", .data = try std.mem.concat(arena, u8, &.{ recipe_bytes, "\n" }) });
    try std.testing.expectError(error.PreparedRecipeHashMismatch, run(a, io, &fixture.environment, fixture.request_path));
}

test "native preparation falls back from missing patch and rejects wrong full archive digest" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    for ([_]bool{ false, true }) |wrong_digest| {
        var server = try TestServer.init();
        defer server.deinit();
        const base = try server.baseUrl(a);
        defer a.free(base);
        var fixture = try TestFixture.init(base);
        defer fixture.deinit();
        const arena = fixture.arena.allocator();
        if (wrong_digest) {
            fixture.request.tar_sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
            try fixture.writeRequest();
        }
        const compressed = try testZstd(arena, fixture.new_tar);
        server.responses = &.{
            .{ .path = try std.fmt.allocPrint(arena, "/stable-{s}-{s}-base123.patch", .{ nativePlatform(), nativeArch() }), .body = "missing", .code = 404 },
            .{ .path = try std.fmt.allocPrint(arena, "/{s}", .{fixture.request.artifact_file}), .body = compressed },
        };
        var serving = try io.concurrent(TestServer.serve, .{&server});
        defer serving.cancel(io) catch {};
        if (wrong_digest) {
            try std.testing.expectError(error.ArchiveHashMismatch, run(a, io, &fixture.environment, fixture.request_path));
            try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().access(io, fixture.stage_path, .{}));
        } else {
            try run(a, io, &fixture.environment, fixture.request_path);
            try fixture.expectPrepared();
        }
        try serving.await(io);
    }
}

test "native prepare rejects a symlink request and unmatched integrity metadata" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var fixture = try TestFixture.init("https://example.test/releases");
    defer fixture.deinit();
    fixture.request.tar_size = null;
    try fixture.writeRequest();
    try std.testing.expectError(error.InvalidPrepareRequest, run(a, io, &fixture.environment, fixture.request_path));
    if (builtin.os.tag != .windows) {
        const real = try std.fmt.allocPrint(fixture.arena.allocator(), "{s}.real", .{fixture.request_path});
        try Io.Dir.cwd().rename(fixture.request_path, Io.Dir.cwd(), real, io);
        try Io.Dir.cwd().symLink(io, real, fixture.request_path, .{});
        if (run(a, io, &fixture.environment, fixture.request_path)) |_| return error.TestUnexpectedResult else |_| {}
    }
}

test "native preparation follows patches through an intermediate staged app" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var server = try TestServer.init();
    defer server.deinit();
    const base = try server.baseUrl(a);
    defer a.free(base);
    var fixture = try TestFixture.init(base);
    defer fixture.deinit();
    const arena = fixture.arena.allocator();
    const middle = try testTar(arena, fixture.root_name, .{ .identifier = fixture.request.identifier, .channel = "stable", .version = "1.5.0", .hash = "middle123", .baseUrl = base });
    server.responses = &.{
        .{ .path = try std.fmt.allocPrint(arena, "/stable-{s}-{s}-base123.patch", .{ nativePlatform(), nativeArch() }), .body = try testLiteralPatch(arena, middle) },
        .{ .path = try std.fmt.allocPrint(arena, "/stable-{s}-{s}-middle123.patch", .{ nativePlatform(), nativeArch() }), .body = try testLiteralPatch(arena, fixture.new_tar) },
    };
    var serving = try io.concurrent(TestServer.serve, .{&server});
    defer serving.cancel(io) catch {};
    try run(a, io, &fixture.environment, fixture.request_path);
    try serving.await(io);
    try fixture.expectPrepared();
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().access(io, try std.fmt.allocPrint(arena, "{s}.prepare-{s}", .{ fixture.request.app_bundle_path, fixture.request.transaction_id }), .{}));
}

test "native preparation replaces superseded staged payload and prunes obsolete tars" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var server = try TestServer.init();
    defer server.deinit();
    const base = try server.baseUrl(a);
    defer a.free(base);
    var fixture = try TestFixture.init(base);
    defer fixture.deinit();
    const arena = fixture.arena.allocator();
    const remote = try std.fmt.allocPrint(arena, "/stable-{s}-{s}-base123.patch", .{ nativePlatform(), nativeArch() });
    const old_stage_path = fixture.stage_path;
    {
        server.responses = &.{.{ .path = remote, .body = try testLiteralPatch(arena, fixture.new_tar) }};
        var serving = try io.concurrent(TestServer.serve, .{&server});
        defer serving.cancel(io) catch {};
        try run(a, io, &fixture.environment, fixture.request_path);
        try serving.await(io);
    }
    fixture.request.hash = "last123";
    fixture.request.version = "3.0.0";
    fixture.new_tar = try testTar(arena, fixture.root_name, .{ .identifier = fixture.request.identifier, .channel = "stable", .version = "3.0.0", .hash = "last123", .baseUrl = base });
    var source: Io.Reader = .fixed(fixture.new_tar);
    var record = try archive.indexReader(arena, &source, fixture.new_tar.len, null);
    defer record.deinit();
    fixture.request.tar_size = fixture.new_tar.len;
    fixture.request.tar_sha256 = record.value.archive_sha256;
    fixture.stage_path = try std.fmt.allocPrint(arena, "{s}.prepared-last123", .{fixture.request.app_bundle_path});
    try fixture.writeRequest();
    var extraction = try Io.Dir.openDirAbsolute(io, fixture.extraction_path, .{});
    defer extraction.close(io);
    try extraction.writeFile(io, .{ .sub_path = "obsolete123.tar", .data = "obsolete tar" });
    server.responses = &.{.{ .path = remote, .body = try testLiteralPatch(arena, fixture.new_tar) }};
    var serving = try io.concurrent(TestServer.serve, .{&server});
    defer serving.cancel(io) catch {};
    try run(a, io, &fixture.environment, fixture.request_path);
    try serving.await(io);
    try fixture.expectPrepared();
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().access(io, old_stage_path, .{}));
    try std.testing.expectError(error.FileNotFound, extraction.access(io, "next123.recipe.json", .{}));
    try std.testing.expectError(error.FileNotFound, extraction.access(io, "obsolete123.tar", .{}));
}

test "modified installed files force full download without deleting an unverified baseline" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var server = try TestServer.init();
    defer server.deinit();
    const base = try server.baseUrl(a);
    defer a.free(base);
    var fixture = try TestFixture.init(base);
    defer fixture.deinit();
    const arena = fixture.arena.allocator();
    const launcher_path = try std.fs.path.join(arena, &.{ fixture.request.app_bundle_path, if (builtin.os.tag == .macos) "Contents/MacOS/launcher" else if (builtin.os.tag == .windows) "bin/launcher.exe" else "bin/launcher" });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = launcher_path, .data = "modified launcher" });
    server.responses = &.{.{ .path = try std.fmt.allocPrint(arena, "/{s}", .{fixture.request.artifact_file}), .body = try testZstd(arena, fixture.new_tar) }};
    var serving = try io.concurrent(TestServer.serve, .{&server});
    defer serving.cancel(io) catch {};
    try run(a, io, &fixture.environment, fixture.request_path);
    try serving.await(io);
    try fixture.expectPrepared();
    var extraction = try Io.Dir.openDirAbsolute(io, fixture.extraction_path, .{});
    defer extraction.close(io);
    try extraction.access(io, "base123.tar", .{});
    const installed = try Io.Dir.cwd().readFileAlloc(io, launcher_path, arena, .limited(1024));
    try std.testing.expectEqualStrings("modified launcher", installed);
}

test "prepare lock rejects a competing helper before reclaiming its active stage" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var fixture = try TestFixture.init("https://example.test/releases");
    defer fixture.deinit();
    const arena = fixture.arena.allocator();
    var channel = try Io.Dir.openDirAbsolute(io, fixture.request.channel_root, .{});
    defer channel.close(io);
    const active = try std.fmt.allocPrint(arena, "{s}.prepare-ffffffffffffffffffffffffffffffff", .{fixture.request.app_bundle_path});
    try Io.Dir.cwd().createDirPath(io, active);
    const marker = try std.fs.path.join(arena, &.{ active, "active-marker" });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = marker, .data = "owned by live helper" });
    {
        const owner = try acquirePrepareLock(io, channel);
        defer owner.close(io);
        try std.testing.expectError(error.UpdatePreparationBusy, run(a, io, &fixture.environment, fixture.request_path));
        try Io.Dir.cwd().access(io, marker, .{});
    }
    // A closed/dead owner's OS lock is immediately reusable. Reclaiming only
    // happens after that exclusive lock has actually been obtained.
    const successor = try acquirePrepareLock(io, channel);
    defer successor.close(io);
    var parent = try Io.Dir.openDirAbsolute(io, std.fs.path.dirname(fixture.request.app_bundle_path).?, .{});
    defer parent.close(io);
    try pruneInterruptedStages(a, io, parent, std.fs.path.basename(fixture.request.app_bundle_path));
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().access(io, active, .{}));
    try channel.access(io, prepare_lock_name, .{});
}

test "interrupted stage and lock symlinks never redirect cleanup or lock acquisition" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const a = std.testing.allocator;
    const io = std.testing.io;
    var fixture = try TestFixture.init("https://example.test/releases");
    defer fixture.deinit();
    const arena = fixture.arena.allocator();
    const outsider = try std.fs.path.join(arena, &.{ fixture.request.channel_root, "unrelated" });
    try Io.Dir.cwd().createDirPath(io, outsider);
    const marker = try std.fs.path.join(arena, &.{ outsider, "keep" });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = marker, .data = "preserve" });
    const staged_link = try std.fmt.allocPrint(arena, "{s}.prepare-ffffffffffffffffffffffffffffffff", .{fixture.request.app_bundle_path});
    try Io.Dir.cwd().symLink(io, outsider, staged_link, .{ .is_directory = true });
    try std.testing.expectError(error.InvalidInterruptedUpdateStage, run(a, io, &fixture.environment, fixture.request_path));
    try Io.Dir.cwd().access(io, marker, .{});
    try Io.Dir.cwd().deleteFile(io, staged_link);
    var channel = try Io.Dir.openDirAbsolute(io, fixture.request.channel_root, .{});
    defer channel.close(io);
    try channel.deleteFile(io, prepare_lock_name);
    try channel.symLink(io, marker, prepare_lock_name, .{});
    if (run(a, io, &fixture.environment, fixture.request_path)) |_| return error.TestUnexpectedResult else |_| {}
    const bytes = try Io.Dir.cwd().readFileAlloc(io, marker, arena, .limited(1024));
    try std.testing.expectEqualStrings("preserve", bytes);
}
