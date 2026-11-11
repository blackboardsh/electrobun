//! Electrobun v2 update documents. These retain the installed artifact protocol;
//! the release hash identifies an artifact and is not a cryptographic signature.
const std = @import("std");
const builtin = @import("builtin");
const A = std.mem.Allocator;
const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;
pub const prepared_filename = ".electrobun-prepared-update.json";
pub const max_prepared_bytes = 64 * 1024;

pub const max_document_bytes = 1024 * 1024;
pub const Platform = enum { macos, linux, win };
pub const Arch = enum { x64, arm64 };
pub const native_platform: Platform = switch (builtin.os.tag) {
    .macos => .macos,
    .linux => .linux,
    .windows => .win,
    else => @compileError("Unsupported updater OS"),
};
pub const native_arch: Arch = switch (builtin.cpu.arch) {
    .aarch64 => .arm64,
    .x86_64 => .x64,
    else => @compileError("Unsupported updater architecture"),
};
pub const LocalInfo = struct {
    identifier: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
    baseUrl: []const u8,
    name: []const u8,
    displayName: ?[]const u8 = null,
    managed: ?Managed = null,
    updateAuthority: enum { direct, external, none } = .direct,
};
pub const Managed = struct {
    appId: []const u8,
    apiUrl: []const u8 = "https://api.electrobun.dev",
    /// Optional verified custom update origin. Artifact names are served at its root.
    baseUrl: ?[]const u8 = null,
};
pub const Manifest = struct {
    schemaVersion: u32,
    identifier: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
    platform: Platform,
    arch: Arch,
    artifact: struct { file: []const u8, tarSha256: ?[]const u8 = null, tarSize: ?u64 = null },
};
pub const Checksum = struct { tarSha256: []const u8, tarSize: u64 };
pub const Prepared = struct {
    schema_version: u32 = 1,
    identifier: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
    platform: Platform,
    arch: Arch,
    retained_tar_path: []const u8 = "",
    staging_path: []const u8 = "",
    recipe_path: []const u8 = "",
    recipe_sha256: []const u8 = "",
    artifact_file: []const u8,
};
pub const Plan = struct {
    schema_version: u32 = 1,
    transaction_id: []const u8,
    identifier: []const u8,
    channel: []const u8,
    platform: Platform,
    arch: Arch,
    version: []const u8,
    hash: []const u8,
    channel_root: []const u8,
    app_bundle_path: []const u8,
    retained_tar_path: []const u8 = "",
    staging_path: []const u8 = "",
    recipe_path: []const u8 = "",
    recipe_sha256: []const u8 = "",
    parent_pid: i32,
    result_path: []const u8,
};
pub const Result = struct {
    schema_version: u32,
    transaction_id: []const u8,
    success: bool,
    phase: enum { validating, waiting_for_parent, extracting, validating_payload, swapping, integrating, launching, complete },
    message: []const u8,
    identifier: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
};
pub const Info = struct { version: []const u8 = "", hash: []const u8 = "", updateAvailable: bool = false, updateReady: bool = false, error_message: []const u8 = "" };

pub fn validChannel(value: []const u8) bool {
    return std.mem.eql(u8, value, "stable") or std.mem.eql(u8, value, "canary") or std.mem.eql(u8, value, "dev");
}
pub fn validHash(value: []const u8) bool {
    if (value.len == 0 or value.len > 13) return false;
    for (value) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'z')) return false;
    return true;
}
pub fn validTransaction(value: []const u8) bool {
    if (value.len != 32) return false;
    for (value) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return false;
    return true;
}
pub fn validVersion(value: []const u8) bool {
    if (value.len == 0 or value.len > 256 or !std.unicode.utf8ValidateSlice(value)) return false;
    for (value) |c| if (c < 32 or c == 127) return false;
    return true;
}
pub fn validIdentity(value: []const u8, platform: Platform) bool {
    if (!validVersion(value) or std.mem.eql(u8, value, ".") or std.mem.eql(u8, value, "..")) return false;
    for (value) |c| {
        if (c == '/') return false;
        if (platform != .linux and c == '\\') return false;
        if (platform == .win and std.mem.indexOfScalar(u8, "\"%*:<>?|", c) != null) return false;
    }
    if (platform == .win and (value[value.len - 1] == ' ' or value[value.len - 1] == '.')) return false;
    return true;
}
pub fn validArtifact(value: []const u8) bool {
    if (value.len <= ".tar.zst".len or value.len > 1024 or !std.mem.endsWith(u8, value, ".tar.zst") or !std.unicode.utf8ValidateSlice(value)) return false;
    for (value) |c| if (c < 32 or c == 127 or c == '/' or c == '\\' or c == ':') return false;
    return true;
}
pub fn validateLocal(info: LocalInfo, platform: Platform) !void {
    if (!validIdentity(info.identifier, platform) or !validChannel(info.channel) or !validVersion(info.version) or !validHash(info.hash)) return error.InvalidInstalledUpdateIdentity;
}
pub fn validateManifest(a: A, manifest: Manifest, info: LocalInfo, platform: Platform, arch: Arch) !void {
    try validateLocal(info, platform);
    if (manifest.schemaVersion != 1) return error.UnsupportedUpdateManifest;
    if (!std.mem.eql(u8, manifest.identifier, info.identifier) or !std.mem.eql(u8, manifest.channel, info.channel) or manifest.platform != platform or manifest.arch != arch) return error.UpdateIdentityMismatch;
    if (!validVersion(manifest.version) or !validHash(manifest.hash) or !validArtifact(manifest.artifact.file)) return error.UnsafeUpdateMetadata;
    const prefix = try std.fmt.allocPrint(a, "{s}-{s}-{s}-", .{ info.channel, @tagName(platform), @tagName(arch) });
    defer a.free(prefix);
    if (!std.mem.startsWith(u8, manifest.artifact.file, prefix)) return error.UpdateArtifactPlatformMismatch;
    if ((manifest.artifact.tarSha256 == null) != (manifest.artifact.tarSize == null)) return error.InvalidUpdateArchiveIntegrity;
    if (manifest.artifact.tarSha256) |digest| {
        try validateChecksum(.{ .tarSha256 = digest, .tarSize = manifest.artifact.tarSize.? });
    }
}
pub fn validateChecksum(checksum: Checksum) !void {
    if (checksum.tarSha256.len != 64) return error.InvalidUpdateArchiveIntegrity;
    for (checksum.tarSha256) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return error.InvalidUpdateArchiveIntegrity;
    if (checksum.tarSize == 0 or checksum.tarSize > 9007199254740991) return error.InvalidUpdateArchiveIntegrity;
}
pub fn checksumFilename(a: A, manifest: Manifest) ![]u8 {
    if (!validChannel(manifest.channel) or !validHash(manifest.hash)) return error.UnsafeUpdateMetadata;
    return std.fmt.allocPrint(a, "{s}-{s}-{s}-{s}-checksum.json", .{ manifest.channel, @tagName(manifest.platform), @tagName(manifest.arch), manifest.hash });
}
pub fn artifactUrl(a: A, base: []const u8, file: []const u8) ![]u8 {
    if (!validArtifact(file)) return error.UnsafeUpdateArtifact;
    const trimmed = std.mem.trimEnd(u8, base, "/");
    var result = try std.ArrayList(u8).initCapacity(a, trimmed.len + 1 + file.len);
    errdefer result.deinit(a);
    try result.appendSlice(a, trimmed);
    try result.append(a, '/');
    for (file) |c| {
        if (std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "-_.!~*'()", c) != null) {
            try result.append(a, c);
        } else {
            try result.appendSlice(a, &.{ '%', "0123456789ABCDEF"[c >> 4], "0123456789ABCDEF"[c & 15] });
        }
    }
    return result.toOwnedSlice(a);
}
pub fn preparedMatches(record: Prepared, manifest: Manifest) bool {
    return (record.schema_version == 1 or record.schema_version == 2) and std.mem.eql(u8, record.identifier, manifest.identifier) and std.mem.eql(u8, record.channel, manifest.channel) and
        std.mem.eql(u8, record.version, manifest.version) and std.mem.eql(u8, record.hash, manifest.hash) and record.platform == manifest.platform and record.arch == manifest.arch and
        std.mem.eql(u8, record.artifact_file, manifest.artifact.file);
}
pub fn validateResult(result: Result, info: LocalInfo) !void {
    if (result.schema_version != 1 or !validTransaction(result.transaction_id) or !validVersion(result.version) or !validHash(result.hash) or result.message.len == 0 or result.message.len > 4096) return error.InvalidNativeUpdateResult;
    if (!std.mem.eql(u8, result.identifier, info.identifier) or !std.mem.eql(u8, result.channel, info.channel)) return error.UpdateIdentityMismatch;
    if (result.success != (result.phase == .complete)) return error.InvalidNativeUpdateResult;
    for (result.message) |c| if (c < 32 or c == 127) return error.InvalidNativeUpdateResult;
}
pub fn parentPid(value: ?[]const u8, fallback: i32) i32 {
    const text = value orelse return fallback;
    if (text.len == 0 or text.len > 10 or text[0] == '0') return fallback;
    for (text) |c| if (!std.ascii.isDigit(c)) return fallback;
    const pid = std.fmt.parseInt(i32, text, 10) catch return fallback;
    return if (pid > 0) pid else fallback;
}

const fixture = LocalInfo{ .identifier = "sh.blackboard.dash.zig", .channel = "canary", .version = "1.0.0", .hash = "abc123", .baseUrl = "https://example.invalid/desktop/canary/", .name = "DashZig-canary" };
test "update manifest binds identity channel OS architecture and artifact path" {
    const a = std.testing.allocator;
    var manifest = Manifest{ .schemaVersion = 1, .identifier = fixture.identifier, .channel = fixture.channel, .version = "1.0.1", .hash = "def456", .platform = .macos, .arch = .arm64, .artifact = .{ .file = "canary-macos-arm64-DashZig-canary.app.tar.zst" } };
    try validateManifest(a, manifest, fixture, .macos, .arm64);
    manifest.identifier = "other.app";
    try std.testing.expectError(error.UpdateIdentityMismatch, validateManifest(a, manifest, fixture, .macos, .arm64));
    manifest.identifier = fixture.identifier;
    manifest.artifact.file = "../malicious.tar.zst";
    try std.testing.expectError(error.UnsafeUpdateMetadata, validateManifest(a, manifest, fixture, .macos, .arm64));
    manifest.artifact.file = "stable-macos-arm64-Dash.tar.zst";
    try std.testing.expectError(error.UpdateArtifactPlatformMismatch, validateManifest(a, manifest, fixture, .macos, .arm64));
    manifest.artifact.file = "canary-macos-arm64-Dash.tar.zst";
    manifest.hash = "../escape";
    try std.testing.expectError(error.UnsafeUpdateMetadata, validateManifest(a, manifest, fixture, .macos, .arm64));
}
test "artifact URL encodes a single name rather than interpreting query or fragment bytes" {
    const url = try artifactUrl(std.testing.allocator, fixture.baseUrl, "canary-macos-arm64-Dash #1?.app.tar.zst");
    defer std.testing.allocator.free(url);
    try std.testing.expectEqualStrings("https://example.invalid/desktop/canary/canary-macos-arm64-Dash%20%231%3F.app.tar.zst", url);
}
test "native update result cannot claim success before commit or cross application identity" {
    var result = Result{ .schema_version = 1, .transaction_id = "0123456789abcdef0123456789abcdef", .success = true, .phase = .complete, .message = "Installed", .identifier = fixture.identifier, .channel = fixture.channel, .version = "1.0.1", .hash = "new123" };
    try validateResult(result, fixture);
    result.phase = .swapping;
    try std.testing.expectError(error.InvalidNativeUpdateResult, validateResult(result, fixture));
    result.success = false;
    try validateResult(result, fixture);
    result.channel = "stable";
    try std.testing.expectError(error.UpdateIdentityMismatch, validateResult(result, fixture));
}
test "update helper follows the validated outer launcher PID" {
    try std.testing.expectEqual(@as(i32, 42), parentPid("42", 12));
    for ([_]?[]const u8{ null, "", "0", "-1", "2x", "2147483648", "00042" }) |value| try std.testing.expectEqual(@as(i32, 12), parentPid(value, 12));
}

fn permissions(mode: u16) File.Permissions {
    return if (builtin.os.tag == .windows) .default_file else .fromMode(mode);
}
fn resolveFor(a: A, platform: Platform, parts: []const []const u8) ![]u8 {
    return if (platform == .win) std.fs.path.resolveWindows(a, parts) else std.fs.path.resolvePosix(a, parts);
}
fn absoluteFor(platform: Platform, path: []const u8) bool {
    return if (platform == .win) std.fs.path.isAbsoluteWindows(path) else std.fs.path.isAbsolutePosix(path);
}
fn dirnameFor(platform: Platform, path: []const u8) ?[]const u8 {
    return if (platform == .win) std.fs.path.dirnameWindows(path) else std.fs.path.dirnamePosix(path);
}
fn pathEqual(platform: Platform, first: []const u8, second: []const u8) bool {
    return if (platform == .win) std.ascii.eqlIgnoreCase(first, second) else std.mem.eql(u8, first, second);
}

pub fn appDataRoot(a: A, environ: *const std.process.Environ.Map, platform: Platform) ![]u8 {
    if (platform == .win) {
        if (environ.get("LOCALAPPDATA")) |path| {
            if (absoluteFor(platform, path)) return resolveFor(a, platform, &.{path});
        }
    } else if (platform == .linux) {
        if (environ.get("XDG_DATA_HOME")) |path| {
            if (absoluteFor(platform, path)) {
                const normalized = try resolveFor(a, platform, &.{path});
                if (!std.mem.eql(u8, normalized, "/")) return normalized;
                a.free(normalized);
            }
        }
    }
    const home = (if (platform == .win) environ.get("USERPROFILE") orelse environ.get("HOME") else environ.get("HOME")) orelse return error.UpdateHomeUnavailable;
    if (!absoluteFor(platform, home)) return error.UpdateHomeMustBeAbsolute;
    return switch (platform) {
        .macos => resolveFor(a, platform, &.{ home, "Library", "Application Support" }),
        .linux => resolveFor(a, platform, &.{ home, ".local", "share" }),
        .win => resolveFor(a, platform, &.{ home, "AppData", "Local" }),
    };
}

/// exe_dir is BundlePaths.exe_dir, not the launcher file itself.
pub fn resolveChannelRoot(a: A, io: std.Io, info: LocalInfo, exe_dir: []const u8, environ: *const std.process.Environ.Map) ![]u8 {
    const data_root = try appDataRoot(a, environ, native_platform);
    defer a.free(data_root);
    const executable = try std.fs.path.join(a, &.{ exe_dir, if (builtin.os.tag == .windows) "main.exe" else "main" });
    defer a.free(executable);
    return resolveInstalledChannelRootForPlatform(a, io, info, native_platform, executable, data_root);
}

pub fn resolveInstalledChannelRootForPlatform(a: A, io: std.Io, info: LocalInfo, platform: Platform, executable_path: []const u8, app_data_root: []const u8) ![]u8 {
    try validateLocal(info, platform);
    if (!absoluteFor(platform, app_data_root)) return error.UpdateDataRootMustBeAbsolute;
    const identifier_root = try resolveFor(a, platform, &.{ app_data_root, info.identifier });
    defer a.free(identifier_root);
    const modern = try resolveFor(a, platform, &.{ identifier_root, info.channel });
    errdefer a.free(modern);
    if (platform != .macos) {
        if (!absoluteFor(platform, executable_path)) return error.UpdateExecutableMustBeAbsolute;
        const exe_dir = dirnameFor(platform, executable_path) orelse return error.InvalidUpdateExecutable;
        const derived = try resolveFor(a, platform, &.{ exe_dir, "..", ".." });
        errdefer a.free(derived);
        const parent = dirnameFor(platform, derived) orelse return error.InvalidUpdateExecutable;
        if (!pathEqual(platform, parent, identifier_root)) {
            if (std.mem.eql(u8, info.channel, "dev")) {
                a.free(derived);
                return modern;
            }
            return error.UnmanagedUpdateDirectory;
        }
        a.free(modern);
        return derived;
    }

    // Select any current-hash archive before considering installer markers.
    // The first candidate wins ties, preserving modern-root precedence.
    var candidates: [3][]const u8 = .{ modern, "", "" };
    var count: usize = 1;
    defer for (candidates[1..count]) |candidate| a.free(candidate);
    if (validIdentity(info.name, .macos)) {
        candidates[count] = try resolveFor(a, .macos, &.{ identifier_root, info.name });
        count += 1;
    }
    if (info.displayName) |display| {
        if (validIdentity(display, .macos)) {
            const name = if (std.mem.eql(u8, info.channel, "stable")) try a.dupe(u8, display) else try std.fmt.allocPrint(a, "{s}-{s}", .{ display, info.channel });
            defer a.free(name);
            if (validIdentity(name, .macos)) {
                candidates[count] = try resolveFor(a, .macos, &.{ identifier_root, name });
                count += 1;
            }
        }
    }
    for ([_]bool{ true, false }) |archive| {
        for (candidates[0..count]) |candidate| {
            const recipe = try std.fmt.allocPrint(a, "{s}/self-extraction/{s}.recipe.json", .{ candidate, info.hash });
            defer a.free(recipe);
            if (archive) {
                if (openManagedFile(a, io, candidate, recipe)) |file| {
                    file.close(io);
                    const chosen = try a.dupe(u8, candidate);
                    a.free(modern);
                    return chosen;
                } else |_| {}
            }
            const path = if (archive) try retainedTarPath(a, candidate, info.hash) else try std.fs.path.join(a, &.{ candidate, ".electrobun-uninstall.json" });
            defer a.free(path);
            const file = openManagedFile(a, io, candidate, path) catch continue;
            file.close(io);
            const chosen = try a.dupe(u8, candidate);
            a.free(modern);
            return chosen;
        }
    }
    return modern;
}

pub fn extractionPath(a: A, root: []const u8) ![]u8 {
    try requireCanonicalPath(a, root);
    return std.fs.path.join(a, &.{ root, "self-extraction" });
}
pub fn retainedTarPath(a: A, root: []const u8, hash: []const u8) ![]u8 {
    if (!validHash(hash)) return error.InvalidUpdateHash;
    const extraction = try extractionPath(a, root);
    defer a.free(extraction);
    const name = try std.fmt.allocPrint(a, "{s}.tar", .{hash});
    defer a.free(name);
    return std.fs.path.join(a, &.{ extraction, name });
}
pub fn preparedPath(a: A, root: []const u8) ![]u8 {
    const extraction = try extractionPath(a, root);
    defer a.free(extraction);
    return std.fs.path.join(a, &.{ extraction, prepared_filename });
}

pub fn requireCanonicalPath(a: A, path: []const u8) !void {
    if (path.len == 0 or path.len > 32768 or std.mem.indexOfScalar(u8, path, 0) != null or !std.fs.path.isAbsolute(path)) return error.UnsafeUpdatePath;
    const normalized = try std.fs.path.resolve(a, &.{path});
    defer a.free(normalized);
    if (!std.mem.eql(u8, normalized, path)) return error.UnsafeUpdatePath;
}

/// Create only real directories, following no symlink in the supplied path.
/// Existing ancestors retain their modes; the requested directory is private.
pub fn ensurePrivateDirectory(a: A, io: std.Io, path: []const u8) !void {
    var directory = try walkDirectory(a, io, path, true);
    defer directory.close(io);
    if (builtin.os.tag != .windows) try directory.setPermissions(io, permissions(0o700));
}

pub fn walkDirectory(a: A, io: std.Io, path: []const u8, create: bool) !Dir {
    try requireCanonicalPath(a, path);
    var components = std.fs.path.componentIterator(path);
    const filesystem_root = components.root() orelse return error.UnsafeUpdatePath;
    if (path.len == filesystem_root.len) return error.UnsafeUpdatePath;
    var current = try Dir.cwd().openDir(io, filesystem_root, .{ .follow_symlinks = false, .iterate = true });
    errdefer current.close(io);
    while (components.next()) |component| {
        var created = false;
        if (create) {
            if (current.createDir(io, component.name, permissions(0o700))) |_| {
                created = true;
            } else |err| switch (err) {
                error.PathAlreadyExists => {},
                else => return err,
            }
        }
        const next = try current.openDir(io, component.name, .{ .follow_symlinks = false, .iterate = true });
        errdefer next.close(io);
        if (created) try syncDirectory(io, current);
        current.close(io);
        current = next;
    }
    return current;
}

const ManagedParent = struct { dir: Dir, basename: []const u8 };
fn managedParent(a: A, io: std.Io, root: []const u8, path: []const u8) !ManagedParent {
    try requireCanonicalPath(a, root);
    try requireCanonicalPath(a, path);
    if (path.len <= root.len or !pathEqual(native_platform, path[0..root.len], root) or !std.fs.path.isSep(path[root.len])) return error.UpdatePathOutsideRoot;
    const relative = path[root.len + 1 ..];
    var current = try walkDirectory(a, io, root, false);
    errdefer current.close(io);
    var components = std.fs.path.componentIterator(relative);
    var component = components.next() orelse return error.UpdatePathOutsideRoot;
    while (components.next()) |next_component| {
        const next = try current.openDir(io, component.name, .{ .follow_symlinks = false, .iterate = true });
        current.close(io);
        current = next;
        component = next_component;
    }
    return .{ .dir = current, .basename = component.name };
}

pub fn openManagedFile(a: A, io: std.Io, root: []const u8, path: []const u8) !File {
    return openManagedFileMode(a, io, root, path, .read_only);
}
fn openManagedFileMode(a: A, io: std.Io, root: []const u8, path: []const u8, mode: Dir.OpenFileOptions.Mode) !File {
    const parent = try managedParent(a, io, root, path);
    defer parent.dir.close(io);
    // Inspect first to avoid opening a FIFO/device, then validate the handle as
    // well. O_NOFOLLOW binds the final component to a non-symlink file.
    const before = try parent.dir.statFile(io, parent.basename, .{ .follow_symlinks = false });
    if (before.kind != .file) return error.UnsafeUpdateFile;
    const file = try parent.dir.openFile(io, parent.basename, .{ .follow_symlinks = false, .mode = mode });
    errdefer file.close(io);
    const after = try file.stat(io);
    if (after.kind != .file or after.inode != before.inode) return error.UnsafeUpdateFile;
    return file;
}

pub fn readBounded(a: A, io: std.Io, root: []const u8, path: []const u8, max_bytes: usize) ![]u8 {
    const file = try openManagedFile(a, io, root, path);
    defer file.close(io);
    const stat = try file.stat(io);
    if (stat.size > max_bytes) return error.UpdateDocumentTooLarge;
    const bytes = try a.alloc(u8, @intCast(stat.size));
    errdefer a.free(bytes);
    if (try file.readPositionalAll(io, bytes, 0) != bytes.len) return error.UpdateDocumentChanged;
    var extra: [1]u8 = undefined;
    if (try file.readPositionalAll(io, &extra, stat.size) != 0) return error.UpdateDocumentChanged;
    return bytes;
}

pub fn readJson(comptime T: type, a: A, io: std.Io, root: []const u8, path: []const u8, max_bytes: usize) !std.json.Parsed(T) {
    const bytes = try readBounded(a, io, root, path, max_bytes);
    defer a.free(bytes);
    return std.json.parseFromSlice(T, a, bytes, .{ .allocate = .alloc_always });
}

/// Public update documents may add optional fields independently of installed
/// clients. Existing private-record parsing remains unchanged.
pub fn readPublicJson(comptime T: type, a: A, io: std.Io, root: []const u8, path: []const u8, max_bytes: usize) !std.json.Parsed(T) {
    const bytes = try readBounded(a, io, root, path, max_bytes);
    defer a.free(bytes);
    return std.json.parseFromSlice(T, a, bytes, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
}

fn requireReplaceable(io: std.Io, parent: ManagedParent) !void {
    const stat = parent.dir.statFile(io, parent.basename, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    if (stat.kind != .file) return error.UnsafeUpdateFile;
}
fn syncDirectory(io: std.Io, dir: Dir) !void {
    if (builtin.os.tag != .windows) {
        const file = try dir.openFile(io, ".", .{ .allow_directory = true });
        defer file.close(io);
        try file.sync(io);
    }
}
pub fn atomicWriteJson(a: A, io: std.Io, root: []const u8, path: []const u8, value: anytype, mode: u16) !void {
    if (mode != 0o400 and mode != 0o600) return error.UnsafeUpdateFilePermissions;
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(bytes);
    if (bytes.len > max_document_bytes) return error.UpdateDocumentTooLarge;
    const parent = try managedParent(a, io, root, path);
    defer parent.dir.close(io);
    try requireReplaceable(io, parent);
    var fresh = try parent.dir.createFileAtomic(io, parent.basename, .{ .permissions = permissions(mode), .replace = true });
    defer fresh.deinit(io);
    try fresh.file.writeStreamingAll(io, bytes);
    try fresh.file.writeStreamingAll(io, "\n");
    try fresh.file.sync(io);
    try requireReplaceable(io, parent);
    try fresh.replace(io);
    try syncDirectory(io, parent.dir);
}

/// Publish a completed archive on the same managed filesystem. The source
/// handle is closed before rename so Windows can replace the destination.
pub fn publishFileReplacingRegular(a: A, io: std.Io, root: []const u8, source: []const u8, destination: []const u8) !void {
    if (pathEqual(native_platform, source, destination)) return error.InvalidUpdatePublication;
    const source_parent = try managedParent(a, io, root, source);
    defer source_parent.dir.close(io);
    const destination_parent = try managedParent(a, io, root, destination);
    defer destination_parent.dir.close(io);
    try requireReplaceable(io, destination_parent);
    var source_inode: File.INode = undefined;
    {
        const file = try openManagedFileMode(a, io, root, source, .read_write);
        defer file.close(io);
        source_inode = (try file.stat(io)).inode;
        if (builtin.os.tag != .windows) try file.setPermissions(io, permissions(0o600));
        try file.sync(io);
    }
    const current = try source_parent.dir.statFile(io, source_parent.basename, .{ .follow_symlinks = false });
    if (current.kind != .file or current.inode != source_inode) return error.UnsafeUpdateFile;
    try requireReplaceable(io, destination_parent);
    try source_parent.dir.rename(source_parent.basename, destination_parent.dir, destination_parent.basename, io);
    try syncDirectory(io, destination_parent.dir);
    if (!pathEqual(native_platform, std.fs.path.dirname(source).?, std.fs.path.dirname(destination).?)) try syncDirectory(io, source_parent.dir);
}

pub fn validatePrepared(a: A, io: Io, record: Prepared, info: LocalInfo, root: []const u8, bundle: []const u8) !void {
    try validateLocal(info, native_platform);
    if ((record.schema_version != 1 and record.schema_version != 2) or !std.mem.eql(u8, record.identifier, info.identifier) or !std.mem.eql(u8, record.channel, info.channel) or record.platform != native_platform or record.arch != native_arch or !validVersion(record.version) or !validHash(record.hash) or !validArtifact(record.artifact_file)) return error.InvalidPreparedUpdate;
    if (record.schema_version == 1) {
        const expected = try retainedTarPath(a, root, record.hash);
        defer a.free(expected);
        if (!std.mem.eql(u8, expected, record.retained_tar_path)) return error.InvalidPreparedUpdate;
        const tar = try openManagedFile(a, io, root, record.retained_tar_path);
        defer tar.close(io);
    } else {
        try requireCanonicalPath(a, record.staging_path);
        try requireCanonicalPath(a, record.recipe_path);
        const expected_stage = try std.fmt.allocPrint(a, "{s}.prepared-{s}", .{ bundle, record.hash });
        defer a.free(expected_stage);
        const expected_recipe = try recipePath(a, root, record.hash);
        defer a.free(expected_recipe);
        if (!std.mem.eql(u8, record.staging_path, expected_stage) or !std.mem.eql(u8, record.recipe_path, expected_recipe) or !validDigest(record.recipe_sha256)) return error.InvalidPreparedUpdate;
        const recipe = try openManagedFile(a, io, root, record.recipe_path);
        defer recipe.close(io);
        var stage = try walkDirectory(a, io, record.staging_path, false);
        defer stage.close(io);
    }
}

pub fn recipePath(a: A, root: []const u8, hash: []const u8) ![]u8 {
    if (!validHash(hash)) return error.InvalidUpdateHash;
    const filename = try std.fmt.allocPrint(a, "{s}.recipe.json", .{hash});
    defer a.free(filename);
    return std.fs.path.join(a, &.{ root, "self-extraction", filename });
}

pub fn loadPrepared(a: A, io: Io, config: Config) !std.json.Parsed(Prepared) {
    const path = try preparedPath(a, config.channel_root);
    defer a.free(path);
    const bytes = try readBounded(a, io, config.channel_root, path, max_prepared_bytes);
    defer a.free(bytes);
    const document = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer document.deinit();
    if (document.value != .object) return error.InvalidPreparedUpdate;
    const schema = document.value.object.get("schema_version") orelse return error.InvalidPreparedUpdate;
    if (!jsonNumberEquals(schema, 1) and !jsonNumberEquals(schema, 2)) return error.InvalidPreparedUpdate;
    const platform = document.value.object.get("platform") orelse return error.InvalidPreparedUpdate;
    const arch = document.value.object.get("arch") orelse return error.InvalidPreparedUpdate;
    if (platform != .string or arch != .string or !std.mem.eql(u8, platform.string, @tagName(native_platform)) or !std.mem.eql(u8, arch.string, @tagName(native_arch))) return error.InvalidPreparedUpdate;
    var parsed = try std.json.parseFromSlice(Prepared, a, bytes, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
    errdefer parsed.deinit();
    try validatePrepared(a, io, parsed.value, config.local, config.channel_root, config.app_bundle_path);
    return parsed;
}

fn jsonNumberEquals(value: std.json.Value, expected: i64) bool {
    return switch (value) {
        .integer => |v| v == expected,
        .float => |v| v == @as(f64, @floatFromInt(expected)),
        else => false,
    };
}

pub fn validDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return false;
    return true;
}

pub fn validatePlan(a: A, plan: Plan) !void {
    if ((plan.schema_version != 1 and plan.schema_version != 2) or !validTransaction(plan.transaction_id) or !validIdentity(plan.identifier, native_platform) or !validChannel(plan.channel) or !validVersion(plan.version) or !validHash(plan.hash) or plan.parent_pid <= 0 or plan.platform != native_platform or plan.arch != native_arch) return error.InvalidUpdatePlan;
    for ([_][]const u8{ plan.channel_root, plan.app_bundle_path, plan.result_path }) |path| try requireCanonicalPath(a, path);
    const result = try std.fmt.allocPrint(a, "{s}{s}.electrobun-update-{s}.result.json", .{ plan.channel_root, std.fs.path.sep_str, plan.transaction_id });
    defer a.free(result);
    if (!std.mem.eql(u8, result, plan.result_path)) return error.InvalidUpdatePlan;
    if (plan.schema_version == 1) {
        const expected = try retainedTarPath(a, plan.channel_root, plan.hash);
        defer a.free(expected);
        if (!std.mem.eql(u8, expected, plan.retained_tar_path)) return error.InvalidUpdatePlan;
    } else {
        const stage = try std.fmt.allocPrint(a, "{s}.prepared-{s}", .{ plan.app_bundle_path, plan.hash });
        defer a.free(stage);
        const recipe = try recipePath(a, plan.channel_root, plan.hash);
        defer a.free(recipe);
        if (plan.retained_tar_path.len != 0 or !std.mem.eql(u8, stage, plan.staging_path) or !std.mem.eql(u8, recipe, plan.recipe_path) or !validDigest(plan.recipe_sha256)) return error.InvalidUpdatePlan;
    }
}

pub fn checkedUpdateUri(url: []const u8, allow_query: bool) !std.Uri {
    if (url.len == 0 or url.len > 8192) return error.InvalidUpdateUrl;
    for (url) |c| if (c < 0x21 or c == 0x7f or c == '\\') return error.InvalidUpdateUrl;
    const uri = std.Uri.parse(url) catch return error.InvalidUpdateUrl;
    if (uri.user != null or uri.password != null or uri.fragment != null or (!allow_query and uri.query != null) or uri.port == 0) return error.InvalidUpdateUrl;
    const host = switch (uri.host orelse return error.InvalidUpdateUrl) {
        .raw, .percent_encoded => |value| value,
    };
    if (host.len == 0 or std.mem.indexOfScalar(u8, host, '%') != null) return error.InvalidUpdateUrl;
    const loopback = std.ascii.eqlIgnoreCase(host, "localhost") or std.mem.eql(u8, host, "127.0.0.1") or std.mem.eql(u8, host, "[::1]") or std.mem.eql(u8, host, "::1");
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "https") and !(std.ascii.eqlIgnoreCase(uri.scheme, "http") and loopback)) return error.InsecureUpdateUrl;
    return uri;
}

pub fn validManagedAppId(value: []const u8) bool {
    if (value.len == 0 or value.len > 240 or !std.ascii.isAlphanumeric(value[0]) or std.mem.indexOf(u8, value, "..") != null or value[value.len - 1] == ' ' or value[value.len - 1] == '.') return false;
    for (value) |c| if (!std.ascii.isAlphanumeric(c) and std.mem.indexOfScalar(u8, "._+ -", c) == null) return false;
    return true;
}

fn encodedComponent(a: A, value: []const u8) ![]u8 {
    var encoded: std.ArrayList(u8) = .empty;
    errdefer encoded.deinit(a);
    for (value) |c| {
        if (std.ascii.isAlphanumeric(c) or std.mem.indexOfScalar(u8, "-_.~", c) != null) try encoded.append(a, c) else try encoded.appendSlice(a, &.{ '%', "0123456789ABCDEF"[c >> 4], "0123456789ABCDEF"[c & 15] });
    }
    return encoded.toOwnedSlice(a);
}

pub fn managedUpdateBaseUrl(a: A, managed: Managed) ![]u8 {
    if (!validManagedAppId(managed.appId)) return error.InvalidManagedUpdateConfig;
    const configured = managed.baseUrl orelse managed.apiUrl;
    var uri = try checkedUpdateUri(configured, false);
    const path = switch (uri.path) {
        .raw, .percent_encoded => |value| value,
    };
    if (managed.baseUrl != null) {
        if (path.len != 0 and !std.mem.eql(u8, path, "/")) return error.InvalidManagedUpdateUrl;
        const host = switch (uri.host.?) {
            .raw, .percent_encoded => |value| value,
        };
        if (!std.mem.eql(u8, host, "[::1]") and !std.mem.eql(u8, host, "::1")) for (host) |c| {
            if (!std.ascii.isAlphanumeric(c) and c != '.' and c != '-') return error.InvalidManagedUpdateUrl;
        };
        if (std.ascii.eqlIgnoreCase(uri.scheme, "https")) {
            if (uri.port != null and uri.port.? != 443) return error.InvalidManagedUpdateUrl;
            uri.port = null;
        }
        return std.fmt.allocPrint(a, "{f}", .{uri.fmt(.{ .scheme = true, .authority = true, .port = true })});
    }
    const trimmed = std.mem.trimEnd(u8, path, "/");
    if (trimmed.len != 0 and !std.mem.eql(u8, trimmed, "/v1/electrobun")) return error.InvalidManagedUpdateUrl;
    const origin = try std.fmt.allocPrint(a, "{f}", .{uri.fmt(.{ .scheme = true, .authority = true, .port = true })});
    defer a.free(origin);
    const app = try encodedComponent(a, managed.appId);
    defer a.free(app);
    return std.fmt.allocPrint(a, "{s}/v1/electrobun/apps/{s}/updates", .{ origin, app });
}

pub const Config = struct {
    arena: std.heap.ArenaAllocator,
    local: LocalInfo,
    exe_dir: []const u8,
    resources_dir: []const u8,
    channel_root: []const u8,
    app_bundle_path: []const u8,
    storage_path: []const u8,
    base_url: []const u8,
    platform: Platform = native_platform,
    arch: Arch = native_arch,
    installation_id: ?[32]u8 = null,

    pub fn deinit(self: *Config) void {
        self.arena.deinit();
    }
};

fn inheritedEnvironment(a: A) !std.process.Environ.Map {
    var env = std.process.Environ.Map.init(a);
    errdefer env.deinit();
    // Copy only known keys: runtimes may change unrelated environment entries.
    inline for (.{ "HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_DATA_HOME", "ELECTROBUN_INSTALL_ROOT_NAME" }) |key| {
        const value = if (builtin.os.tag == .windows)
            (std.process.Environ{ .block = .global }).getAlloc(a, key) catch |err| switch (err) {
                error.EnvironmentVariableMissing => null,
                else => return err,
            }
        else if (std.c.getenv(key)) |v| try a.dupe(u8, std.mem.span(v)) else null;
        if (value) |v| {
            defer a.free(v);
            try env.put(key, v);
        }
    }
    return env;
}

fn hasCurrentArchiveEvidence(a: A, io: Io, root: []const u8, hash: []const u8) !bool {
    const recipe = try recipePath(a, root, hash);
    defer a.free(recipe);
    const tar = try retainedTarPath(a, root, hash);
    defer a.free(tar);
    for ([_][]const u8{ recipe, tar }) |path| {
        if (openManagedFile(a, io, root, path)) |file| {
            file.close(io);
            return true;
        } else |_| {}
    }
    return false;
}

pub fn loadConfig(a: A, io: Io, json: []const u8) !Config {
    var env = try inheritedEnvironment(a);
    defer env.deinit();
    const runtime = try std.process.executableDirPathAlloc(io, a);
    defer a.free(runtime);
    return loadConfigForRuntime(a, io, json, &env, runtime);
}

/// Runtime path injection exists for filesystem integration tests. The public
/// ABI always supplies the process's actual executable directory.
pub fn loadConfigForRuntime(a: A, io: Io, json: []const u8, env: *const std.process.Environ.Map, runtime_exe_dir: []const u8) !Config {
    if (json.len > 64 * 1024) return error.InvalidUpdaterConfiguration;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const own = arena.allocator();
    const input_shape = try std.json.parseFromSlice(std.json.Value, own, json, .{});
    if (input_shape.value != .object) return error.InvalidUpdaterConfiguration;
    const input_schema = input_shape.value.object.get("schemaVersion") orelse return error.MissingField;
    if (!jsonNumberEquals(input_schema, 1)) return error.UnsupportedUpdaterConfiguration;
    const input = try std.json.parseFromSlice(struct { schemaVersion: u32, exeDir: []const u8, resourcesDir: []const u8 }, own, json, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
    if (input.value.schemaVersion != 1) return error.UnsupportedUpdaterConfiguration;
    if (!std.fs.path.isAbsolute(input.value.exeDir) or !std.fs.path.isAbsolute(input.value.resourcesDir) or std.mem.indexOfScalar(u8, input.value.exeDir, 0) != null or std.mem.indexOfScalar(u8, input.value.resourcesDir, 0) != null) return error.InvalidUpdaterConfiguration;
    const exe = try Dir.cwd().realPathFileAlloc(io, input.value.exeDir, own);
    const resources = try Dir.cwd().realPathFileAlloc(io, input.value.resourcesDir, own);
    const runtime = try Dir.cwd().realPathFileAlloc(io, runtime_exe_dir, own);
    if (!pathEqual(native_platform, exe, runtime)) return error.UpdaterRuntimePathMismatch;
    const expected_resources = try std.fs.path.resolve(own, &.{ exe, "..", "Resources" });
    if (!pathEqual(native_platform, resources, expected_resources)) return error.InvalidUpdaterResourcesDirectory;
    const exe_leaf = if (native_platform == .macos) "MacOS" else "bin";
    if (!pathEqual(native_platform, std.fs.path.basename(exe), exe_leaf)) return error.InvalidUpdaterExecutableDirectory;
    const version_path = try std.fs.path.join(own, &.{ resources, "version.json" });
    const bytes = try readBounded(own, io, resources, version_path, max_document_bytes);
    const local_shape = try std.json.parseFromSlice(std.json.Value, own, bytes, .{});
    if (local_shape.value != .object) return error.InvalidInstalledUpdateIdentity;
    if (local_shape.value.object.get("updateAuthority")) |authority| {
        if (authority != .string or (!std.mem.eql(u8, authority.string, "direct") and !std.mem.eql(u8, authority.string, "external") and !std.mem.eql(u8, authority.string, "none"))) return error.InvalidInstalledUpdateIdentity;
    }
    if (local_shape.value.object.get("managed")) |managed| {
        if (managed != .object) return error.InvalidManagedUpdateConfig;
        const app_id = managed.object.get("appId") orelse return error.InvalidManagedUpdateConfig;
        if (app_id != .string) return error.InvalidManagedUpdateConfig;
        inline for (.{ "apiUrl", "baseUrl" }) |key| {
            if (managed.object.get(key)) |value| if (value != .string) return error.InvalidManagedUpdateConfig;
        }
    }
    const parsed = try std.json.parseFromSlice(LocalInfo, own, bytes, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
    const local = parsed.value;
    try validateLocal(local, native_platform);
    const data = try appDataRoot(own, env, native_platform);
    const executable = try std.fs.path.join(own, &.{ exe, if (native_platform == .win) "main.exe" else "main" });
    var root = resolveInstalledChannelRootForPlatform(own, io, local, native_platform, executable, data) catch |err| blk: {
        if (err != error.UnmanagedUpdateDirectory or local.updateAuthority == .direct) return err;
        break :blk try std.fs.path.resolve(own, &.{ data, local.identifier, local.channel });
    };
    if (env.get("ELECTROBUN_INSTALL_ROOT_NAME")) |name| {
        if (!validIdentity(name, native_platform) or std.mem.indexOfScalar(u8, name, '\\') != null) return error.InvalidInstalledRootOverride;
        if (native_platform != .macos and local.updateAuthority == .direct and !std.mem.eql(u8, local.channel, "dev") and !pathEqual(native_platform, std.fs.path.basename(root), name)) return error.InstalledRootOverrideMismatch;
        // Older launchers considered tar files but not archive-free recipes.
        // Their marker-derived hint can therefore name a stale modern root.
        // Keep the root proved by the running hash before honoring that hint.
        if (native_platform != .macos or !try hasCurrentArchiveEvidence(own, io, root, local.hash)) {
            root = try std.fs.path.resolve(own, &.{ data, local.identifier, name });
        }
    }
    try requireCanonicalPath(own, root);
    const bundle = try std.fs.path.resolve(own, &.{ exe, "..", if (native_platform == .macos) ".." else "." });
    if (native_platform != .macos and local.updateAuthority == .direct and !std.mem.eql(u8, local.channel, "dev")) {
        const expected = try std.fs.path.join(own, &.{ root, "app" });
        if (!pathEqual(native_platform, expected, bundle)) return error.InvalidInstalledBundlePath;
    }
    const enabled = local.updateAuthority == .direct and !std.mem.eql(u8, local.channel, "dev");
    const base = if (enabled) blk: {
        if (local.managed) |managed| break :blk try managedUpdateBaseUrl(own, managed);
        if (local.baseUrl.len != 0) _ = try checkedUpdateUri(local.baseUrl, false);
        break :blk local.baseUrl;
    } else local.baseUrl;
    return .{ .arena = arena, .local = local, .exe_dir = exe, .resources_dir = resources, .channel_root = root, .app_bundle_path = bundle, .storage_path = try std.fs.path.join(own, &.{ root, "insights" }), .base_url = base };
}

test "managed update URL is app scoped or explicit custom origin" {
    const a = std.testing.allocator;
    const normal = try managedUpdateBaseUrl(a, .{ .appId = "My App+1", .apiUrl = "https://api.example.test/v1/electrobun/" });
    defer a.free(normal);
    try std.testing.expectEqualStrings("https://api.example.test/v1/electrobun/apps/My%20App%2B1/updates", normal);
    const custom = try managedUpdateBaseUrl(a, .{ .appId = "test", .baseUrl = "https://custom.example.test:443/" });
    defer a.free(custom);
    try std.testing.expectEqualStrings("https://custom.example.test", custom);
    const loopback = try managedUpdateBaseUrl(a, .{ .appId = "test", .baseUrl = "http://127.0.0.1:1234/" });
    defer a.free(loopback);
    try std.testing.expectEqualStrings("http://127.0.0.1:1234", loopback);
    for ([_][]const u8{ "https://updates.test/path", "https://updates.test//", "https://updates.test?x=1", "https://updates.test:444", "https://updates.test/../", "https://user@updates.test", "http://updates.test" }) |url| {
        if (managedUpdateBaseUrl(a, .{ .appId = "test", .baseUrl = url })) |value| {
            a.free(value);
            return error.TestUnexpectedResult;
        } else |_| {}
    }
    try std.testing.expectError(error.InvalidManagedUpdateConfig, managedUpdateBaseUrl(a, .{ .appId = "../other" }));
}

test "archive integrity preserves public protocol bounds and optional extensions" {
    const a = std.testing.allocator;
    const bytes = "{\"schemaVersion\":1,\"identifier\":\"sh.blackboard.dash.zig\",\"channel\":\"canary\",\"version\":\"1.1\",\"hash\":\"new\",\"platform\":\"macos\",\"arch\":\"arm64\",\"future\":true,\"artifact\":{\"file\":\"canary-macos-arm64-App.app.tar.zst\",\"tarSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"tarSize\":1,\"future\":true}}";
    const parsed = try std.json.parseFromSlice(Manifest, a, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    try validateManifest(a, parsed.value, fixture, .macos, .arm64);
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, validateChecksum(.{ .tarSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .tarSize = 0 }));
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, validateChecksum(.{ .tarSha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", .tarSize = 512 }));
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, validateChecksum(.{ .tarSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .tarSize = 9007199254740992 }));
}

test "legacy roots and XDG data roots retain installed identity" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    const linux = try resolveInstalledChannelRootForPlatform(a, io, fixture, .linux, "/home/u/.local/share/sh.blackboard.dash.zig/Legacy-canary/app/bin/main", "/home/u/.local/share");
    defer a.free(linux);
    try std.testing.expectEqualStrings("/home/u/.local/share/sh.blackboard.dash.zig/Legacy-canary", linux);
    const win = try resolveInstalledChannelRootForPlatform(a, io, fixture, .win, "C:\\Data\\SH.BLACKBOARD.DASH.ZIG\\Legacy\\app\\bin\\main.exe", "C:\\Data");
    defer a.free(win);
    try std.testing.expectEqualStrings("C:\\Data\\SH.BLACKBOARD.DASH.ZIG\\Legacy", win);
    try std.testing.expectError(error.UnmanagedUpdateDirectory, resolveInstalledChannelRootForPlatform(a, io, fixture, .linux, "/opt/app/bin/main", "/home/u/.local/share"));
    var env = std.process.Environ.Map.init(a);
    defer env.deinit();
    try env.put("HOME", "/home/u");
    for ([_][]const u8{ "/", "relative", "/tmp/.." }) |configured| {
        try env.put("XDG_DATA_HOME", configured);
        const path = try appDataRoot(a, &env, .linux);
        defer a.free(path);
        try std.testing.expectEqualStrings("/home/u/.local/share", path);
    }
}

const TestBundle = struct {
    arena: std.heap.ArenaAllocator,
    root: []const u8,
    exe: []const u8,
    resources: []const u8,
    json: []const u8,
    env: std.process.Environ.Map,
    fn init(a: A, io: Io, parent: []const u8, local: LocalInfo) !TestBundle {
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const own = arena.allocator();
        var env = std.process.Environ.Map.init(a);
        errdefer env.deinit();
        try env.put("HOME", parent);
        try env.put("USERPROFILE", parent);
        try env.put("LOCALAPPDATA", parent);
        try env.put("XDG_DATA_HOME", parent);
        const data = try appDataRoot(own, &env, native_platform);
        const root = try std.fs.path.join(own, &.{ data, local.identifier, "Legacy-canary" });
        try env.put("ELECTROBUN_INSTALL_ROOT_NAME", "Legacy-canary");
        const exe = if (native_platform == .macos) try std.fs.path.join(own, &.{ parent, "App.app", "Contents", "MacOS" }) else try std.fs.path.join(own, &.{ root, "app", "bin" });
        const resources = try std.fs.path.resolve(own, &.{ exe, "..", "Resources" });
        try Dir.cwd().createDirPath(io, exe);
        try Dir.cwd().createDirPath(io, resources);
        try Dir.cwd().createDirPath(io, root);
        const version = try std.fs.path.join(own, &.{ resources, "version.json" });
        const bytes = try std.json.Stringify.valueAlloc(own, local, .{ .emit_null_optional_fields = false });
        try Dir.cwd().writeFile(io, .{ .sub_path = version, .data = bytes });
        const json = try std.json.Stringify.valueAlloc(own, .{ .schemaVersion = 1, .exeDir = exe, .resourcesDir = resources, .manifest = "ignored" }, .{});
        return .{ .arena = arena, .root = root, .exe = exe, .resources = resources, .json = json, .env = env };
    }
    fn deinit(self: *TestBundle) void {
        self.env.deinit();
        self.arena.deinit();
    }
};

test "configuration derives identity and paths from the physical running bundle" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const physical = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(physical);
    var bundle = try TestBundle.init(a, io, physical, fixture);
    defer bundle.deinit();
    var config = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
    defer config.deinit();
    try std.testing.expectEqualStrings(fixture.identifier, config.local.identifier);
    try std.testing.expectEqualStrings(bundle.root, config.channel_root);
    try std.testing.expect(std.mem.endsWith(u8, config.storage_path, "Legacy-canary" ++ std.fs.path.sep_str ++ "insights"));
    try std.testing.expectEqualStrings(fixture.baseUrl, config.base_url);
    try std.testing.expectError(error.UpdaterRuntimePathMismatch, loadConfigForRuntime(a, io, bundle.json, &bundle.env, physical));
    const bad_json = try std.json.Stringify.valueAlloc(a, .{ .schemaVersion = 1, .exeDir = bundle.exe, .resourcesDir = physical }, .{});
    defer a.free(bad_json);
    try std.testing.expectError(error.InvalidUpdaterResourcesDirectory, loadConfigForRuntime(a, io, bad_json, &bundle.env, bundle.exe));
    try bundle.env.put("ELECTROBUN_INSTALL_ROOT_NAME", "../escape");
    try std.testing.expectError(error.InvalidInstalledRootOverride, loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe));
}

test "prepared schemas retain archive and archive-free transactions and reject path escapes" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const physical = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(physical);
    var bundle = try TestBundle.init(a, io, physical, fixture);
    defer bundle.deinit();
    var config = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
    defer config.deinit();
    const extraction = try extractionPath(a, config.channel_root);
    defer a.free(extraction);
    try ensurePrivateDirectory(a, io, extraction);
    const tar = try retainedTarPath(a, config.channel_root, "new123");
    defer a.free(tar);
    try Dir.cwd().writeFile(io, .{ .sub_path = tar, .data = "tar bytes" });
    var record = Prepared{ .identifier = fixture.identifier, .channel = fixture.channel, .version = "1.1", .hash = "new123", .platform = native_platform, .arch = native_arch, .retained_tar_path = tar, .artifact_file = "canary-macos-arm64-App.app.tar.zst" };
    try validatePrepared(a, io, record, config.local, config.channel_root, config.app_bundle_path);
    const record_path = try preparedPath(a, config.channel_root);
    defer a.free(record_path);
    try atomicWriteJson(a, io, config.channel_root, record_path, record, 0o600);
    var parsed = try loadPrepared(a, io, config);
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u32, 1), parsed.value.schema_version);
    const stage = try std.fmt.allocPrint(a, "{s}.prepared-new123", .{config.app_bundle_path});
    defer a.free(stage);
    const recipe = try recipePath(a, config.channel_root, "new123");
    defer a.free(recipe);
    try Dir.cwd().createDirPath(io, stage);
    try Dir.cwd().writeFile(io, .{ .sub_path = recipe, .data = "recipe" });
    record.schema_version = 2;
    record.retained_tar_path = "";
    record.staging_path = stage;
    record.recipe_path = recipe;
    record.recipe_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try atomicWriteJson(a, io, config.channel_root, record_path, record, 0o600);
    var modern = try loadPrepared(a, io, config);
    defer modern.deinit();
    try std.testing.expectEqual(@as(u32, 2), modern.value.schema_version);
    record.staging_path = config.app_bundle_path;
    try std.testing.expectError(error.InvalidPreparedUpdate, validatePrepared(a, io, record, config.local, config.channel_root, config.app_bundle_path));
    const plan = Plan{ .schema_version = 2, .transaction_id = "00000000000000000000000000000000", .identifier = fixture.identifier, .channel = fixture.channel, .platform = native_platform, .arch = native_arch, .version = "1.1", .hash = "new123", .channel_root = config.channel_root, .app_bundle_path = config.app_bundle_path, .staging_path = stage, .recipe_path = recipe, .recipe_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .parent_pid = 42, .result_path = try std.fmt.allocPrint(a, "{s}{s}.electrobun-update-{s}.result.json", .{ config.channel_root, std.fs.path.sep_str, "00000000000000000000000000000000" }) };
    defer a.free(plan.result_path);
    try validatePlan(a, plan);
}

test "macOS legacy recipes select the root before modern installer markers" {
    if (native_platform == .win) return error.SkipZigTest;
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const data = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(data);
    const modern = try std.fs.path.join(a, &.{ data, fixture.identifier, fixture.channel });
    defer a.free(modern);
    const legacy = try std.fs.path.join(a, &.{ data, fixture.identifier, fixture.name });
    defer a.free(legacy);
    const extraction = try extractionPath(a, legacy);
    defer a.free(extraction);
    try ensurePrivateDirectory(a, io, modern);
    try ensurePrivateDirectory(a, io, extraction);
    const marker = try std.fs.path.join(a, &.{ modern, ".electrobun-uninstall.json" });
    defer a.free(marker);
    try Dir.cwd().writeFile(io, .{ .sub_path = marker, .data = "{}" });
    const recipe = try recipePath(a, legacy, fixture.hash);
    defer a.free(recipe);
    try Dir.cwd().writeFile(io, .{ .sub_path = recipe, .data = "{}" });
    const selected = try resolveInstalledChannelRootForPlatform(a, io, fixture, .macos, "/Applications/App.app/Contents/MacOS/main", data);
    defer a.free(selected);
    try std.testing.expectEqualStrings(legacy, selected);
}

test "configuration production entry reads runtime environment without accepting injected metadata" {
    try std.testing.expectError(error.MissingField, loadConfig(std.testing.allocator, std.testing.io, "{}"));
}

test "managed prepared readers reject symlinked files and ancestor directories" {
    if (native_platform == .win) return error.SkipZigTest;
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(root);
    try tmp.dir.createDir(io, "real", .default_dir);
    try tmp.dir.writeFile(io, .{ .sub_path = "real/record", .data = "{}" });
    try tmp.dir.symLink(io, "real/record", "record-link", .{});
    try tmp.dir.symLink(io, "real", "ancestor-link", .{ .is_directory = true });
    for ([_][]const u8{ "record-link", "ancestor-link/record" }) |relative| {
        const path = try std.fs.path.join(a, &.{ root, relative });
        defer a.free(path);
        if (openManagedFile(a, io, root, path)) |file| {
            file.close(io);
            return error.TestUnexpectedResult;
        } else |_| {}
    }
    const outside = try std.fs.path.resolve(a, &.{ root, "..", "outside" });
    defer a.free(outside);
    try std.testing.expectError(error.UpdatePathOutsideRoot, openManagedFile(a, io, root, outside));
}

test "macOS display-name legacy roots and modern current archives preserve precedence" {
    if (native_platform == .win) return error.SkipZigTest;
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const data = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(data);
    for ([_][]const u8{ "stable", "canary" }) |channel| {
        var local = fixture;
        local.channel = channel;
        local.name = "SanitizedApp";
        local.displayName = "Display App";
        const root_name = if (std.mem.eql(u8, channel, "stable")) try a.dupe(u8, "Display App") else try std.fmt.allocPrint(a, "Display App-{s}", .{channel});
        defer a.free(root_name);
        const modern = try std.fs.path.join(a, &.{ data, local.identifier, channel });
        defer a.free(modern);
        const legacy = try std.fs.path.join(a, &.{ data, local.identifier, root_name });
        defer a.free(legacy);
        const modern_extraction = try extractionPath(a, modern);
        defer a.free(modern_extraction);
        const legacy_extraction = try extractionPath(a, legacy);
        defer a.free(legacy_extraction);
        try ensurePrivateDirectory(a, io, modern_extraction);
        try ensurePrivateDirectory(a, io, legacy_extraction);
        const marker = try std.fs.path.join(a, &.{ modern, ".electrobun-uninstall.json" });
        defer a.free(marker);
        try Dir.cwd().writeFile(io, .{ .sub_path = marker, .data = "{}" });
        const legacy_tar = try retainedTarPath(a, legacy, local.hash);
        defer a.free(legacy_tar);
        try Dir.cwd().writeFile(io, .{ .sub_path = legacy_tar, .data = "archive" });
        const selected = try resolveInstalledChannelRootForPlatform(a, io, local, .macos, "/Applications/App.app/Contents/MacOS/main", data);
        defer a.free(selected);
        try std.testing.expectEqualStrings(legacy, selected);
        const modern_recipe = try recipePath(a, modern, local.hash);
        defer a.free(modern_recipe);
        try Dir.cwd().writeFile(io, .{ .sub_path = modern_recipe, .data = "{}" });
        const preferred = try resolveInstalledChannelRootForPlatform(a, io, local, .macos, "/Applications/App.app/Contents/MacOS/main", data);
        defer a.free(preferred);
        try std.testing.expectEqualStrings(modern, preferred);
    }
}

test "configuration and prepared records reject JSON primitive coercions" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const physical = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(physical);
    var bundle = try TestBundle.init(a, io, physical, fixture);
    defer bundle.deinit();
    const wrong_schema = try std.json.Stringify.valueAlloc(a, .{ .schemaVersion = "1", .exeDir = bundle.exe, .resourcesDir = bundle.resources }, .{});
    defer a.free(wrong_schema);
    try std.testing.expectError(error.UnsupportedUpdaterConfiguration, loadConfigForRuntime(a, io, wrong_schema, &bundle.env, bundle.exe));
    var config = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
    defer config.deinit();
    const extraction = try extractionPath(a, config.channel_root);
    defer a.free(extraction);
    try ensurePrivateDirectory(a, io, extraction);
    const path = try preparedPath(a, config.channel_root);
    defer a.free(path);
    try atomicWriteJson(a, io, config.channel_root, path, .{ .schema_version = 1, .platform = @backingInt(native_platform), .arch = @tagName(native_arch) }, 0o600);
    try std.testing.expectError(error.InvalidPreparedUpdate, loadPrepared(a, io, config));
    const version_path = try std.fs.path.join(a, &.{ bundle.resources, "version.json" });
    defer a.free(version_path);
    try atomicWriteJson(a, io, bundle.resources, version_path, .{ .identifier = fixture.identifier, .channel = fixture.channel, .version = fixture.version, .hash = fixture.hash, .baseUrl = fixture.baseUrl, .name = fixture.name, .updateAuthority = 0 }, 0o600);
    try std.testing.expectError(error.InvalidInstalledUpdateIdentity, loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe));
}

test "manifest mutations cannot change installed channel OS architecture or production identity" {
    const a = std.testing.allocator;
    const valid = Manifest{ .schemaVersion = 1, .identifier = fixture.identifier, .channel = fixture.channel, .version = "1.2.0", .hash = "updated", .platform = .macos, .arch = .arm64, .artifact = .{ .file = "canary-macos-arm64-App.app.tar.zst" } };
    for ([_][]const u8{ "stable", "dev", "production", "../canary" }) |channel| {
        var changed = valid;
        changed.channel = channel;
        try std.testing.expectError(error.UpdateIdentityMismatch, validateManifest(a, changed, fixture, .macos, .arm64));
    }
    for ([_]Platform{ .linux, .win }) |platform| {
        var changed = valid;
        changed.platform = platform;
        try std.testing.expectError(error.UpdateIdentityMismatch, validateManifest(a, changed, fixture, .macos, .arm64));
    }
    var changed = valid;
    changed.arch = .x64;
    try std.testing.expectError(error.UpdateIdentityMismatch, validateManifest(a, changed, fixture, .macos, .arm64));
    changed = valid;
    changed.schemaVersion = 2;
    try std.testing.expectError(error.UnsupportedUpdateManifest, validateManifest(a, changed, fixture, .macos, .arm64));
    var production = fixture;
    production.channel = "production";
    changed = valid;
    changed.channel = "production";
    changed.artifact.file = "production-macos-arm64-App.app.tar.zst";
    try std.testing.expectError(error.InvalidInstalledUpdateIdentity, validateManifest(a, changed, production, .macos, .arm64));
    for ([_][]const u8{ "", "UPPER", "abcdefghijklmn", "has/slash", "white space" }) |hash| {
        changed = valid;
        changed.hash = hash;
        try std.testing.expectError(error.UnsafeUpdateMetadata, validateManifest(a, changed, fixture, .macos, .arm64));
    }
}

test "prepared v2 rejects recipe and digest escapes and missing stage" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const physical = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(physical);
    var bundle = try TestBundle.init(a, io, physical, fixture);
    defer bundle.deinit();
    var config = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
    defer config.deinit();
    const extraction = try extractionPath(a, config.channel_root);
    defer a.free(extraction);
    try ensurePrivateDirectory(a, io, extraction);
    const stage = try std.fmt.allocPrint(a, "{s}.prepared-new123", .{config.app_bundle_path});
    defer a.free(stage);
    const recipe = try recipePath(a, config.channel_root, "new123");
    defer a.free(recipe);
    const wrong_recipe = try recipePath(a, config.channel_root, "other123");
    defer a.free(wrong_recipe);
    const outside_recipe = try std.fs.path.join(a, &.{ physical, "outside.recipe.json" });
    defer a.free(outside_recipe);
    const traversal_recipe = try std.fs.path.join(a, &.{ extraction, "..", "new123.recipe.json" });
    defer a.free(traversal_recipe);
    const record = Prepared{ .schema_version = 2, .identifier = fixture.identifier, .channel = fixture.channel, .version = "1.1", .hash = "new123", .platform = native_platform, .arch = native_arch, .artifact_file = "canary-macos-arm64-App.app.tar.zst", .staging_path = stage, .recipe_path = recipe, .recipe_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    try Dir.cwd().writeFile(io, .{ .sub_path = recipe, .data = "{}" });
    try std.testing.expectError(error.FileNotFound, validatePrepared(a, io, record, config.local, config.channel_root, config.app_bundle_path));
    try Dir.cwd().createDirPath(io, stage);
    try validatePrepared(a, io, record, config.local, config.channel_root, config.app_bundle_path);
    for ([_][]const u8{ wrong_recipe, outside_recipe }) |path| {
        var changed = record;
        changed.recipe_path = path;
        try std.testing.expectError(error.InvalidPreparedUpdate, validatePrepared(a, io, changed, config.local, config.channel_root, config.app_bundle_path));
    }
    var changed = record;
    changed.recipe_path = traversal_recipe;
    try std.testing.expectError(error.UnsafeUpdatePath, validatePrepared(a, io, changed, config.local, config.channel_root, config.app_bundle_path));
    for ([_][]const u8{ "", "abc", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) |digest| {
        changed = record;
        changed.recipe_sha256 = digest;
        try std.testing.expectError(error.InvalidPreparedUpdate, validatePrepared(a, io, changed, config.local, config.channel_root, config.app_bundle_path));
    }
    try Dir.cwd().deleteFile(io, recipe);
    try std.testing.expectError(error.FileNotFound, validatePrepared(a, io, record, config.local, config.channel_root, config.app_bundle_path));
    if (native_platform != .win) {
        try Dir.cwd().writeFile(io, .{ .sub_path = outside_recipe, .data = "{}" });
        try Dir.cwd().symLink(io, outside_recipe, recipe, .{});
        try std.testing.expectError(error.UnsafeUpdateFile, validatePrepared(a, io, record, config.local, config.channel_root, config.app_bundle_path));
    }
}

test "managed bundle metadata rejects explicit null and invalid app identity while preserving extensions" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const physical = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(physical);
    var bundle = try TestBundle.init(a, io, physical, fixture);
    defer bundle.deinit();
    const version_path = try std.fs.path.join(a, &.{ bundle.resources, "version.json" });
    defer a.free(version_path);
    const template = "{{\"identifier\":\"{s}\",\"channel\":\"canary\",\"version\":\"1\",\"hash\":\"abc123\",\"name\":\"App\",\"baseUrl\":\"https://static.example.test\",\"managed\":{s},\"futureExtension\":{{\"nested\":true}}}}";
    for ([_][]const u8{ "null", "[]", "{}", "{\"appId\":null}", "{\"appId\":123}", "{\"appId\":\"../other\"}", "{\"appId\":\"app%2fother\"}", "{\"appId\":\"valid\",\"apiUrl\":null}", "{\"appId\":\"valid\",\"baseUrl\":null}" }) |managed| {
        const bytes = try std.fmt.allocPrint(a, template, .{ fixture.identifier, managed });
        defer a.free(bytes);
        try Dir.cwd().writeFile(io, .{ .sub_path = version_path, .data = bytes });
        try std.testing.expectError(error.InvalidManagedUpdateConfig, loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe));
    }
    const extended = try std.fmt.allocPrint(a, template, .{ fixture.identifier, "{\"appId\":\"valid\",\"futureExtension\":42}" });
    defer a.free(extended);
    try Dir.cwd().writeFile(io, .{ .sub_path = version_path, .data = extended });
    var config = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
    defer config.deinit();
    try std.testing.expectEqualStrings("https://api.electrobun.dev/v1/electrobun/apps/valid/updates", config.base_url);
}

test "macOS current archive evidence overrides stale launcher root hints in full configuration" {
    if (native_platform != .macos) return error.SkipZigTest;
    const a = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const physical = try tmp.dir.realPathFileAlloc(io, ".", a);
    defer a.free(physical);
    var local = fixture;
    local.name = "Legacy-canary";
    local.managed = .{ .appId = "managed-test" };
    var bundle = try TestBundle.init(a, io, physical, local);
    defer bundle.deinit();
    const data = try appDataRoot(a, &bundle.env, .macos);
    defer a.free(data);
    const modern = try std.fs.path.join(a, &.{ data, local.identifier, local.channel });
    defer a.free(modern);
    try ensurePrivateDirectory(a, io, modern);
    const marker = try std.fs.path.join(a, &.{ modern, ".electrobun-uninstall.json" });
    defer a.free(marker);
    try Dir.cwd().writeFile(io, .{ .sub_path = marker, .data = "{}" });
    try bundle.env.put("ELECTROBUN_INSTALL_ROOT_NAME", local.channel);
    const extraction = try extractionPath(a, bundle.root);
    defer a.free(extraction);
    try ensurePrivateDirectory(a, io, extraction);
    const recipe = try recipePath(a, bundle.root, local.hash);
    defer a.free(recipe);
    const tar = try retainedTarPath(a, bundle.root, local.hash);
    defer a.free(tar);
    for ([_][]const u8{ recipe, tar }) |evidence| {
        try Dir.cwd().writeFile(io, .{ .sub_path = evidence, .data = "current release" });
        var configured = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
        defer configured.deinit();
        try std.testing.expectEqualStrings(bundle.root, configured.channel_root);
        const storage = try std.fs.path.join(a, &.{ bundle.root, "insights" });
        defer a.free(storage);
        try std.testing.expectEqualStrings(storage, configured.storage_path);
        try Dir.cwd().deleteFile(io, evidence);
    }
    // Without current-release evidence, a safe launcher-selected root remains
    // authoritative even when a different candidate contains an old marker.
    try bundle.env.put("ELECTROBUN_INSTALL_ROOT_NAME", "Launcher-selected");
    var hinted = try loadConfigForRuntime(a, io, bundle.json, &bundle.env, bundle.exe);
    defer hinted.deinit();
    const expected = try std.fs.path.join(a, &.{ data, local.identifier, "Launcher-selected" });
    defer a.free(expected);
    try std.testing.expectEqualStrings(expected, hinted.channel_root);
}
