//! An exact, bounded-memory description of a release tar. File contents stay in
//! the installed application; every other archive byte is retained literally.
//! Reconstruction never guesses timestamps, ownership, ordering, PAX records or
//! signing metadata. Recipes are deliberately outside the signed app bundle.
const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Sha256 = std.crypto.hash.sha2.Sha256;

// Large dependency trees can contain tens of thousands of tar headers. Bound
// the complete serialized receipt, including hex expansion and JSON overhead,
// independently of app contents; never publish a receipt readers cannot load.
pub const max_recipe_bytes = 128 * 1024 * 1024;
const max_extension_bytes = 64 * 1024;
const max_entries = 100_000;
const copy_buffer_size = 64 * 1024;

pub const Kind = enum { file, directory, symlink, hardlink };
pub const Entry = struct {
    path: []const u8,
    kind: Kind,
    mode: u32,
    size: u64 = 0,
    sha256: ?[]const u8 = null,
    link_target: ?[]const u8 = null,
    /// Offset of this entry's content in the original uncompressed archive.
    tar_offset: u64 = 0,
};
pub const Span = struct {
    literal_hex: ?[]const u8 = null,
    path: ?[]const u8 = null,
    size: u64,
};
pub const Recipe = struct {
    schema_version: u32 = 1,
    root: []const u8,
    root_mode: u32 = 0o755,
    archive_size: u64,
    archive_sha256: []const u8,
    entries: []const Entry,
    spans: []const Span,
};
pub const Owned = struct {
    arena: std.heap.ArenaAllocator,
    value: Recipe,

    pub fn deinit(self: *Owned) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

pub fn isDigest(value: []const u8) bool {
    if (value.len != 64) return false;
    for (value) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return false;
    return true;
}

/// Traversal and ambiguous separators are rejected everywhere. Filename aliases
/// and punctuation restrictions apply to the target OS, so legitimate Unix
/// payloads can contain names such as "aux", "source:map", or "trailing.".
pub fn validatePath(path: []const u8) !void {
    return validatePathFor(builtin.os.tag, path);
}

fn validatePathFor(os: std.Target.Os.Tag, path: []const u8) !void {
    if (path.len == 0 or path.len > 4096 or !std.unicode.utf8ValidateSlice(path)) return error.InvalidArchivePath;
    var parts = std.mem.splitScalar(u8, path, '/');
    while (parts.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..")) return error.InvalidArchivePath;
        for (part) |c| if (c < 32 or c == 127 or c == '\\') return error.InvalidArchivePath;
        if (os == .windows) {
            if (part[part.len - 1] == '.' or part[part.len - 1] == ' ') return error.InvalidArchivePath;
            for (part) |c| if (std.mem.indexOfScalar(u8, ":*?\"<>|", c) != null) return error.InvalidArchivePath;
            const stem = part[0 .. std.mem.indexOfScalar(u8, part, '.') orelse part.len];
            for ([_][]const u8{ "con", "prn", "aux", "nul" }) |reserved| {
                if (std.ascii.eqlIgnoreCase(stem, reserved)) return error.InvalidArchivePath;
            }
            if (stem.len == 4 and (std.ascii.eqlIgnoreCase(stem[0..3], "com") or std.ascii.eqlIgnoreCase(stem[0..3], "lpt")) and stem[3] >= '1' and stem[3] <= '9') return error.InvalidArchivePath;
        }
    }
}

pub fn validateLinkTarget(path: []const u8, target: []const u8) !void {
    return validateLinkTargetFor(builtin.os.tag, path, target);
}

fn validateLinkTargetFor(os: std.Target.Os.Tag, path: []const u8, target: []const u8) !void {
    if (target.len == 0 or target.len > 4096 or target[0] == '/' or !std.unicode.utf8ValidateSlice(target)) return error.InvalidLinkTarget;
    var depth: usize = std.mem.count(u8, path, "/");
    var parts = std.mem.splitScalar(u8, target, '/');
    while (parts.next()) |part| {
        if (std.mem.eql(u8, part, ".")) continue;
        if (std.mem.eql(u8, part, "..")) {
            if (depth == 0) return error.InvalidLinkTarget;
            depth -= 1;
        } else {
            validatePathFor(os, part) catch return error.InvalidLinkTarget;
            depth += 1;
        }
    }
}

/// Returns an owned directory handle for the parent, opening each component
/// separately without following symlinks. The supplied root is never closed.
pub fn openParent(io: Io, root: Io.Dir, path: []const u8, create: bool) !Io.Dir {
    try validatePath(path);
    var current = try root.openDir(io, ".", .{ .follow_symlinks = false });
    errdefer current.close(io);
    const last = std.mem.lastIndexOfScalar(u8, path, '/') orelse return current;
    var parts = std.mem.splitScalar(u8, path[0..last], '/');
    while (parts.next()) |part| {
        if (create) current.createDir(io, part, .default_dir) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return err,
        };
        const next = try current.openDir(io, part, .{ .follow_symlinks = false });
        current.close(io);
        current = next;
    }
    return current;
}

pub fn leafName(path: []const u8) []const u8 {
    return path[if (std.mem.lastIndexOfScalar(u8, path, '/')) |i| i + 1 else 0..];
}

pub fn openRegularFile(io: Io, root: Io.Dir, path: []const u8) !Io.File {
    var parent = try openParent(io, root, path, false);
    defer parent.close(io);
    const file = try parent.openFile(io, leafName(path), .{ .follow_symlinks = false });
    errdefer file.close(io);
    if ((try file.stat(io)).kind != .file) return error.NotRegularFile;
    return file;
}

fn hex(allocator: Allocator, bytes: []const u8) ![]const u8 {
    const out = try allocator.alloc(u8, bytes.len * 2);
    const digits = "0123456789abcdef";
    for (bytes, 0..) |b, i| {
        out[i * 2] = digits[b >> 4];
        out[i * 2 + 1] = digits[b & 15];
    }
    return out;
}

fn digestString(allocator: Allocator, digest: *Sha256) ![]const u8 {
    return hex(allocator, &digest.finalResult());
}

fn tarString(raw: []const u8) []const u8 {
    return raw[0 .. std.mem.indexOfScalar(u8, raw, 0) orelse raw.len];
}

fn tarNumber(raw: []const u8) !u64 {
    if (raw[0] & 0x80 != 0) {
        if (raw[0] & 0x40 != 0) return error.InvalidTarNumber;
        var value: u64 = raw[0] & 0x3f;
        for (raw[1..]) |b| value = std.math.add(u64, try std.math.mul(u64, value, 256), b) catch return error.InvalidTarNumber;
        return value;
    }
    const value = std.mem.trim(u8, raw, " \x00");
    if (value.len == 0) return 0;
    return std.fmt.parseInt(u64, value, 8) catch error.InvalidTarNumber;
}

fn headerValid(header: *const [512]u8) !void {
    var sum: u64 = 0;
    for (header, 0..) |b, i| sum += if (i >= 148 and i < 156) @as(u8, ' ') else b;
    if (sum != try tarNumber(header[148..156])) return error.InvalidTarChecksum;
}

fn rounded(size: u64) !u64 {
    return (std.math.add(u64, size, 511) catch return error.InvalidTarSize) & ~@as(u64, 511);
}

const Overrides = struct {
    path: ?[]const u8 = null,
    linkpath: ?[]const u8 = null,
    size: ?u64 = null,
};

fn parsePax(allocator: Allocator, bytes: []const u8, values: *Overrides) !void {
    var position: usize = 0;
    while (position < bytes.len) {
        const space = std.mem.indexOfScalarPos(u8, bytes, position, ' ') orelse return error.InvalidPaxRecord;
        const length = std.fmt.parseInt(usize, bytes[position..space], 10) catch return error.InvalidPaxRecord;
        if (length < space - position + 4 or length > bytes.len - position) return error.InvalidPaxRecord;
        const end = position + length;
        if (bytes[end - 1] != '\n') return error.InvalidPaxRecord;
        const equal = std.mem.indexOfScalarPos(u8, bytes[0 .. end - 1], space + 1, '=') orelse return error.InvalidPaxRecord;
        const key = bytes[space + 1 .. equal];
        const value = bytes[equal + 1 .. end - 1];
        if (std.mem.eql(u8, key, "path")) {
            values.path = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "linkpath")) {
            values.linkpath = try allocator.dupe(u8, value);
        } else if (std.mem.eql(u8, key, "size")) {
            values.size = std.fmt.parseInt(u64, value, 10) catch return error.InvalidPaxRecord;
        } else if (std.mem.startsWith(u8, key, "GNU.sparse")) return error.UnsupportedTarType;
        position = end;
    }
}

const Indexer = struct {
    allocator: Allocator,
    reader: *Io.Reader,
    copy_to: ?*Io.Writer,
    position: u64 = 0,
    archive_size: ?u64,
    digest: Sha256 = .init(.{}),
    literal: std.ArrayList(u8) = .empty,
    literal_bytes: usize = 0,
    spans: std.ArrayList(Span) = .empty,

    fn read(self: *Indexer, destination: []u8, literal: bool) !void {
        if (try self.readSome(destination, literal) != destination.len) return error.TruncatedTar;
    }

    fn readSome(self: *Indexer, destination: []u8, literal: bool) !usize {
        if (self.archive_size) |size| if (destination.len > size - self.position) return error.TruncatedTar;
        const count = try self.reader.readSliceShort(destination);
        const bytes = destination[0..count];
        self.position = std.math.add(u64, self.position, count) catch return error.InvalidTarSize;
        self.digest.update(bytes);
        if (self.copy_to) |writer| try writer.writeAll(bytes);
        if (literal) {
            if (count > max_recipe_bytes / 2 -| self.literal_bytes) return error.RecipeTooLarge;
            self.literal_bytes += count;
            try self.literal.appendSlice(self.allocator, bytes);
        }
        return count;
    }

    fn flushLiteral(self: *Indexer) !void {
        if (self.literal.items.len == 0) return;
        try self.spans.append(self.allocator, .{ .literal_hex = try hex(self.allocator, self.literal.items), .size = self.literal.items.len });
        self.literal.clearRetainingCapacity();
    }
};

/// Reads the archive once, with constant-size file buffers. Only archive
/// metadata is allocated; an app-sized tar or file buffer is never retained.
pub fn index(allocator: Allocator, io: Io, tar_file: Io.File) !Owned {
    const stat = try tar_file.stat(io);
    if (stat.kind != .file) return error.NotRegularFile;
    var buffer: [copy_buffer_size]u8 = undefined;
    var reader = tar_file.reader(io, &buffer);
    return indexReader(allocator, &reader.interface, stat.size, null);
}

/// Indexes an uncompressed stream while optionally forwarding exactly those
/// bytes to an extraction sink. The caller supplies the authenticated expected
/// archive length; this function consumes precisely that length.
pub fn indexReader(allocator: Allocator, reader: *Io.Reader, archive_size: u64, copy_to: ?*Io.Writer) !Owned {
    return indexStream(allocator, reader, archive_size, copy_to, null);
}

const Extraction = struct {
    io: Io,
    destination: Io.Dir,
    root: ?Io.Dir = null,

    fn deinit(self: *Extraction) void {
        if (self.root) |root| root.close(self.io);
    }

    fn ensureRoot(self: *Extraction, name: []const u8) !void {
        if (self.root != null) return;
        // Never merge into an existing tree, even an apparently empty one.
        try self.destination.createDir(self.io, name, .default_dir);
        self.root = try self.destination.openDir(self.io, name, .{ .follow_symlinks = false, .iterate = true });
    }

    fn directory(self: *Extraction, path: []const u8) !void {
        var parent = try openParent(self.io, self.root.?, path, true);
        defer parent.close(self.io);
        parent.createDir(self.io, leafName(path), .default_dir) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => return err,
        };
        var dir = try parent.openDir(self.io, leafName(path), .{ .follow_symlinks = false });
        dir.close(self.io);
    }

    fn createFile(self: *Extraction, path: []const u8) !Io.File {
        var parent = try openParent(self.io, self.root.?, path, true);
        defer parent.close(self.io);
        return parent.createFile(self.io, leafName(path), .{ .exclusive = true });
    }

    fn finish(self: *Extraction, allocator: Allocator, recipe: Recipe) !void {
        // No link exists while regular contents are extracted. All paths and
        // ancestor types have been validated before links can enter the tree.
        for (recipe.entries) |entry| {
            if (entry.kind != .symlink and entry.kind != .hardlink) continue;
            var parent = try openParent(self.io, self.root.?, entry.path, true);
            defer parent.close(self.io);
            if (entry.kind == .hardlink) {
                var target_parent = try openParent(self.io, self.root.?, entry.link_target.?, false);
                defer target_parent.close(self.io);
                // The recipe only permits links to regular file entries.
                try createHardlink(self.io, target_parent, leafName(entry.link_target.?), parent, leafName(entry.path));
            } else {
                const is_directory = try linkTargetsDirectory(allocator, recipe, entry);
                try parent.symLink(self.io, entry.link_target.?, leafName(entry.path), .{ .is_directory = is_directory });
            }
        }
        if (builtin.os.tag != .windows) {
            // Apply restrictive directory modes after all descendants exist,
            // deepest first, regardless of the original archive entry order.
            const dirs = try allocator.alloc(Entry, recipe.entries.len);
            defer allocator.free(dirs);
            var count: usize = 0;
            for (recipe.entries) |entry| if (entry.kind == .directory) {
                dirs[count] = entry;
                count += 1;
            };
            std.mem.sort(Entry, dirs[0..count], {}, struct {
                fn less(_: void, left: Entry, right: Entry) bool {
                    return std.mem.count(u8, left.path, "/") > std.mem.count(u8, right.path, "/");
                }
            }.less);
            for (dirs[0..count]) |entry| {
                var parent = try openParent(self.io, self.root.?, entry.path, false);
                defer parent.close(self.io);
                var dir = try parent.openDir(self.io, leafName(entry.path), .{ .follow_symlinks = false, .iterate = true });
                defer dir.close(self.io);
                try dir.setPermissions(self.io, .fromMode(@intCast(entry.mode)));
            }
            try self.root.?.setPermissions(self.io, .fromMode(@intCast(recipe.root_mode)));
        }
    }
};

fn createHardlink(io: Io, source_parent: Io.Dir, source_name: []const u8, destination_parent: Io.Dir, destination_name: []const u8) !void {
    // Both names are leaves under already validated, no-follow directory
    // handles. Do not reopen their full paths or replace an existing object.
    try validatePath(source_name);
    try validatePath(destination_name);
    if (std.mem.indexOfScalar(u8, source_name, '/') != null or std.mem.indexOfScalar(u8, destination_name, '/') != null) return error.InvalidArchivePath;
    if (builtin.os.tag != .windows) {
        return source_parent.hardLink(source_name, destination_parent, destination_name, io, .{});
    }
    // Zig's Windows Io backend does not implement hardLink yet. Use the native
    // handle-relative operation so NTFS keeps the actual shared file identity.
    // FileLinkInformation needs no additional access rights on the source:
    // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_link_information
    const w = std.os.windows;
    const source = try openRegularFile(io, source_parent, source_name);
    defer source.close(io);
    const LinkInformation = extern struct {
        // The low byte is ReplaceIfExists for FileLinkInformation; zero means
        // exclusive creation. The union also reserves a ULONG-sized flags field.
        Flags: w.ULONG = 0,
        RootDirectory: w.HANDLE,
        FileNameLength: w.ULONG = 0,
        FileName: [4096]w.WCHAR = undefined,
    };
    var information: LinkInformation = .{ .RootDirectory = destination_parent.handle };
    const name_length = try std.unicode.utf8ToUtf16Le(&information.FileName, destination_name);
    information.FileNameLength = @intCast(name_length * @sizeOf(w.WCHAR));
    // NT requires at least sizeof(FILE_LINK_INFORMATION), including ABI tail
    // padding after its first WCHAR, even for a single-character filename.
    const name_offset = @offsetOf(LinkInformation, "FileName");
    const minimum_size = std.mem.alignForward(usize, name_offset + @sizeOf(w.WCHAR), @alignOf(LinkInformation));
    const information_size = @max(minimum_size, name_offset + information.FileNameLength);
    var status_block: w.IO_STATUS_BLOCK = undefined;
    while (true) {
        try io.checkCancel();
        switch (w.ntdll.NtSetInformationFile(source.handle, &status_block, &information, @intCast(information_size), .Link)) {
            .SUCCESS => return,
            .CANCELLED => continue,
            .OBJECT_NAME_COLLISION => return error.PathAlreadyExists,
            .ACCESS_DENIED => return error.AccessDenied,
            .OBJECT_NAME_NOT_FOUND, .OBJECT_PATH_NOT_FOUND, .DELETE_PENDING => return error.FileNotFound,
            .NOT_SAME_DEVICE => return error.CrossDevice,
            .DISK_FULL => return error.NoSpaceLeft,
            .QUOTA_EXCEEDED => return error.DiskQuota,
            .TOO_MANY_LINKS => return error.LinkQuotaExceeded,
            .INSUFFICIENT_RESOURCES, .NO_MEMORY => return error.SystemResources,
            .MEDIA_WRITE_PROTECTED => return error.ReadOnlyFileSystem,
            .NOT_SUPPORTED, .INVALID_DEVICE_REQUEST => return error.OperationUnsupported,
            else => |status| return w.unexpectedStatus(status),
        }
    }
}

fn linkTargetsDirectory(allocator: Allocator, recipe: Recipe, entry: Entry) !bool {
    var current = entry;
    var remaining = recipe.entries.len + 1;
    while (remaining > 0) : (remaining -= 1) {
        var segments: std.ArrayList([]const u8) = .empty;
        defer segments.deinit(allocator);
        if (std.mem.lastIndexOfScalar(u8, current.path, '/')) |slash| {
            var parent = std.mem.splitScalar(u8, current.path[0..slash], '/');
            while (parent.next()) |part| try segments.append(allocator, part);
        }
        var target = std.mem.splitScalar(u8, current.link_target.?, '/');
        while (target.next()) |part| {
            if (std.mem.eql(u8, part, ".")) continue;
            if (std.mem.eql(u8, part, "..")) {
                if (segments.items.len == 0) return error.InvalidLinkTarget;
                _ = segments.pop();
            } else try segments.append(allocator, part);
        }
        if (segments.items.len == 0) return true;
        const path = try std.mem.join(allocator, "/", segments.items);
        defer allocator.free(path);
        const found = for (recipe.entries) |candidate| {
            if (std.mem.eql(u8, candidate.path, path)) break candidate;
        } else return false; // Tar may intentionally contain a dangling link.
        if (found.kind == .directory) return true;
        if (found.kind != .symlink) return false;
        current = found;
    }
    return error.SymlinkCycle;
}

/// Extracts into a private, empty stage and records the exact incoming tar.
/// No installed path is touched. Unknown-length streams are drained to EOF,
/// including all zero trailer padding; malformed/truncated trailers are errors.
/// The caller owns deletion of a failed stage and validation before publishing.
pub fn extractReader(allocator: Allocator, io: Io, reader: *Io.Reader, archive_size: ?u64, destination: Io.Dir) !Owned {
    var extraction: Extraction = .{ .io = io, .destination = destination };
    defer extraction.deinit();
    return indexStream(allocator, reader, archive_size, null, &extraction);
}

fn indexStream(allocator: Allocator, reader: *Io.Reader, archive_size: ?u64, copy_to: ?*Io.Writer, extraction: ?*Extraction) !Owned {
    var owned: Owned = .{ .arena = .init(allocator), .value = undefined };
    errdefer owned.deinit();
    const a = owned.arena.allocator();
    if (archive_size) |size| if (size < 1024 or size % 512 != 0) return error.InvalidTarSize;
    var state: Indexer = .{ .allocator = a, .reader = reader, .copy_to = copy_to, .archive_size = archive_size };
    var entries: std.ArrayList(Entry) = .empty;
    var root: ?[]const u8 = null;
    var root_mode: u32 = 0o755;
    var local: Overrides = .{};
    var global: Overrides = .{};
    var buffer: [copy_buffer_size]u8 = undefined;
    var ended = false;
    while (archive_size == null or state.position < archive_size.?) {
        var header: [512]u8 = undefined;
        try state.read(&header, true);
        if (std.mem.allEqual(u8, &header, 0)) {
            // Tar end-of-archive requires two complete zero records.
            try state.read(buffer[0..512], true);
            if (!std.mem.allEqual(u8, buffer[0..512], 0)) return error.InvalidTarTrailer;
            while (archive_size == null or state.position < archive_size.?) {
                const wanted: usize = if (archive_size) |size| @intCast(@min(buffer.len, size - state.position)) else buffer.len;
                const count = try state.readSome(buffer[0..wanted], true);
                if (!std.mem.allEqual(u8, buffer[0..count], 0)) return error.InvalidTarTrailer;
                if (count < wanted) {
                    if (archive_size != null) return error.TruncatedTar;
                    break;
                }
            }
            if (state.position % 512 != 0) return error.InvalidTarSize;
            // Reading to EOF also checks a compressed stream's final checksum.
            if (extraction != null and archive_size != null and try reader.readSliceShort(buffer[0..1]) != 0) return error.InvalidTarTrailer;
            ended = true;
            break;
        }
        try headerValid(&header);
        const raw_size = try tarNumber(header[124..136]);
        const kind = header[156];
        if (kind == 'x' or kind == 'g' or kind == 'L' or kind == 'K') {
            if (raw_size > max_extension_bytes) return error.TarExtensionTooLarge;
            const padded: usize = @intCast(try rounded(raw_size));
            const bytes = try a.alloc(u8, padded);
            try state.read(bytes, true);
            const payload = bytes[0..@intCast(raw_size)];
            if (kind == 'x' or kind == 'g') {
                try parsePax(a, payload, if (kind == 'x') &local else &global);
            } else {
                const value = std.mem.trimEnd(u8, payload, "\x00\n");
                if (kind == 'L') local.path = try a.dupe(u8, value) else local.linkpath = try a.dupe(u8, value);
            }
            continue;
        }
        const name = tarString(header[0..100]);
        // GNU's old "ustar " layout stores timestamps where POSIX USTAR has
        // its prefix, so only the exact POSIX magic enables the prefix field.
        const prefix = if (std.mem.eql(u8, header[257..263], "ustar\x00")) tarString(header[345..500]) else "";
        const header_path = if (prefix.len == 0) name else try std.fmt.allocPrint(a, "{s}/{s}", .{ prefix, name });
        var archive_path = local.path orelse global.path orelse header_path;
        while (std.mem.startsWith(u8, archive_path, "./")) archive_path = archive_path[2..];
        archive_path = std.mem.trimEnd(u8, archive_path, "/");
        try validatePath(archive_path);
        const slash = std.mem.indexOfScalar(u8, archive_path, '/');
        const entry_root = archive_path[0 .. slash orelse archive_path.len];
        if (root) |expected| {
            if (!std.mem.eql(u8, expected, entry_root)) return error.MultipleArchiveRoots;
        } else {
            root = try a.dupe(u8, entry_root);
            if (extraction) |stage| try stage.ensureRoot(root.?);
        }
        const path = if (slash) |i| archive_path[i + 1 ..] else "";
        const size = local.size orelse global.size orelse raw_size;
        const mode: u32 = @intCast((try tarNumber(header[100..108])) & 0o777);
        const linkpath = local.linkpath orelse global.linkpath orelse tarString(header[157..257]);
        local = .{};
        const entry_kind: Kind = switch (kind) {
            0, '0', '7' => .file,
            '5' => .directory,
            '2' => .symlink,
            '1' => .hardlink,
            else => return error.UnsupportedTarType,
        };
        if (entry_kind != .file and size != 0) return error.InvalidTarSize;
        if (path.len == 0) {
            if (entry_kind != .directory) return error.InvalidArchiveRoot;
            root_mode = mode;
            continue;
        }
        if (entries.items.len >= max_entries) return error.TooManyArchiveEntries;
        var entry: Entry = .{ .path = try a.dupe(u8, path), .kind = entry_kind, .mode = mode, .size = size, .tar_offset = state.position };
        if (entry_kind == .file) {
            const output = if (extraction) |stage| try stage.createFile(path) else null;
            defer if (output) |file| file.close(extraction.?.io);
            try state.flushLiteral();
            try state.spans.append(a, .{ .path = entry.path, .size = size });
            var file_digest: Sha256 = .init(.{});
            var remaining = size;
            while (remaining > 0) {
                const count: usize = @intCast(@min(remaining, buffer.len));
                try state.read(buffer[0..count], false);
                file_digest.update(buffer[0..count]);
                if (output) |file| try file.writeStreamingAll(extraction.?.io, buffer[0..count]);
                remaining -= count;
            }
            entry.sha256 = try digestString(a, &file_digest);
            if (output) |file| {
                if (builtin.os.tag != .windows) try file.setPermissions(extraction.?.io, .fromMode(@intCast(mode)));
                try file.sync(extraction.?.io);
            }
            const padding: usize = @intCast(try rounded(size) - size);
            try state.read(buffer[0..padding], true);
        } else if (entry_kind == .directory) {
            if (extraction) |stage| try stage.directory(path);
        } else if (entry_kind == .symlink) {
            try validateLinkTarget(path, linkpath);
            entry.link_target = try a.dupe(u8, linkpath);
        } else if (entry_kind == .hardlink) {
            const prefix_root = try std.fmt.allocPrint(a, "{s}/", .{root.?});
            if (!std.mem.startsWith(u8, linkpath, prefix_root)) return error.InvalidLinkTarget;
            const relative = linkpath[prefix_root.len..];
            try validatePath(relative);
            entry.link_target = try a.dupe(u8, relative);
        }
        try entries.append(a, entry);
    }
    if (!ended or root == null or local.path != null or local.size != null or local.linkpath != null) return error.TruncatedTar;
    try state.flushLiteral();
    owned.value = .{
        .root = root.?,
        .root_mode = root_mode,
        .archive_size = state.position,
        .archive_sha256 = try digestString(a, &state.digest),
        .entries = try entries.toOwnedSlice(a),
        .spans = try state.spans.toOwnedSlice(a),
    };
    try validate(a, owned.value);
    if (extraction) |stage| try stage.finish(a, owned.value);
    return owned;
}

fn namespaceKey(allocator: Allocator, path: []const u8, os: std.Target.Os.Tag) ![]const u8 {
    const key = try allocator.dupe(u8, path);
    if (os == .windows or os == .macos) for (key) |*c| {
        c.* = std.ascii.toLower(c.*);
    };
    return key;
}

pub fn validate(allocator: Allocator, recipe: Recipe) !void {
    return validateFor(allocator, recipe, builtin.os.tag);
}

fn validateFor(allocator: Allocator, recipe: Recipe, os: std.Target.Os.Tag) !void {
    if (recipe.schema_version != 1 or recipe.archive_size < 1024 or recipe.archive_size % 512 != 0 or !isDigest(recipe.archive_sha256)) return error.InvalidRecipe;
    try validatePathFor(os, recipe.root);
    if (std.mem.indexOfScalar(u8, recipe.root, '/') != null or recipe.root_mode > 0o777 or recipe.entries.len > max_entries or recipe.spans.len > max_entries * 2 + 1) return error.InvalidRecipe;
    var entries: std.StringHashMapUnmanaged(Entry) = .empty;
    defer entries.deinit(allocator);
    var paths: std.StringHashMapUnmanaged(Kind) = .empty;
    defer {
        var keys = paths.keyIterator();
        while (keys.next()) |key| allocator.free(key.*);
        paths.deinit(allocator);
    }
    for (recipe.entries) |entry| {
        try validatePathFor(os, entry.path);
        if (entry.mode > 0o777 or entry.tar_offset > recipe.archive_size or entry.size > recipe.archive_size - entry.tar_offset) return error.InvalidRecipe;
        const folded = try namespaceKey(allocator, entry.path, os);
        const seen = try paths.getOrPut(allocator, folded);
        if (seen.found_existing) {
            allocator.free(folded);
            return error.DuplicateArchivePath;
        }
        seen.value_ptr.* = entry.kind;
        try entries.put(allocator, entry.path, entry);
        switch (entry.kind) {
            .file => if (entry.sha256 == null or !isDigest(entry.sha256.?) or entry.link_target != null) return error.InvalidRecipe,
            .directory => if (entry.size != 0 or entry.sha256 != null or entry.link_target != null) return error.InvalidRecipe,
            .symlink => {
                if (entry.size != 0 or entry.sha256 != null or entry.link_target == null) return error.InvalidRecipe;
                try validateLinkTargetFor(os, entry.path, entry.link_target.?);
            },
            .hardlink => {
                if (entry.size != 0 or entry.sha256 != null or entry.link_target == null) return error.InvalidRecipe;
                try validatePathFor(os, entry.link_target.?);
            },
        }
    }
    for (recipe.entries) |entry| {
        var parent = entry.path;
        while (std.mem.lastIndexOfScalar(u8, parent, '/')) |slash| {
            parent = parent[0..slash];
            const key = try namespaceKey(allocator, parent, os);
            defer allocator.free(key);
            if (paths.get(key)) |kind| if (kind != .directory) return error.NonDirectoryArchiveAncestor;
        }
        if (entry.kind == .hardlink) {
            const target = entries.get(entry.link_target.?) orelse return error.InvalidLinkTarget;
            if (target.kind != .file) return error.InvalidLinkTarget;
        }
    }
    var seen_files: std.StringHashMapUnmanaged(void) = .empty;
    defer seen_files.deinit(allocator);
    var size: u64 = 0;
    var literal_size: u64 = 0;
    for (recipe.spans) |span| {
        if ((span.path == null) == (span.literal_hex == null)) return error.InvalidRecipe;
        if (span.literal_hex) |literal| {
            if (span.size > max_recipe_bytes / 2 or literal.len != span.size * 2) return error.InvalidRecipe;
            for (literal) |c| if (!std.ascii.isHex(c)) return error.InvalidRecipe;
            literal_size = std.math.add(u64, literal_size, span.size) catch return error.InvalidRecipe;
            if (literal_size > max_recipe_bytes / 2) return error.RecipeTooLarge;
        } else {
            const entry = entries.get(span.path.?) orelse return error.InvalidRecipe;
            if (entry.kind != .file or entry.size != span.size or entry.tar_offset != size) return error.InvalidRecipe;
            const seen = try seen_files.getOrPut(allocator, entry.path);
            if (seen.found_existing) return error.InvalidRecipe;
        }
        size = std.math.add(u64, size, span.size) catch return error.InvalidRecipe;
    }
    if (size != recipe.archive_size) return error.InvalidRecipe;
    for (recipe.entries) |entry| if (entry.kind == .file and !seen_files.contains(entry.path)) return error.InvalidRecipe;
    // This covers both indexed receipts and parsed receipts whose canonical
    // serialization may be larger than their original JSON representation.
    try checkSerializedSize(recipe, max_recipe_bytes);
}

pub fn parse(allocator: Allocator, json: []const u8) !Owned {
    if (json.len > max_recipe_bytes) return error.RecipeTooLarge;
    var owned: Owned = .{ .arena = .init(allocator), .value = undefined };
    errdefer owned.deinit();
    const a = owned.arena.allocator();
    owned.value = try std.json.parseFromSliceLeaky(Recipe, a, json, .{ .allocate = .alloc_always });
    try validate(a, owned.value);
    return owned;
}

pub fn writeJson(recipe: Recipe, writer: *Io.Writer) !void {
    return writeJsonLimited(recipe, writer, max_recipe_bytes);
}

fn serializedSize(recipe: Recipe) !u64 {
    var sizing: Io.Writer.Discarding = .init(&.{});
    try std.json.Stringify.value(recipe, .{}, &sizing.writer);
    return sizing.fullCount();
}

fn checkSerializedSize(recipe: Recipe, limit: u64) !void {
    if (try serializedSize(recipe) > limit) return error.RecipeTooLarge;
}

fn writeJsonLimited(recipe: Recipe, writer: *Io.Writer, limit: u64) !void {
    // Check before touching the output, including when a caller bypassed parse
    // and constructed a Recipe directly. No full JSON buffer is allocated.
    try checkSerializedSize(recipe, limit);
    try std.json.Stringify.value(recipe, .{}, writer);
}

pub fn hashFile(io: Io, file: Io.File, expected_size: u64) ![64]u8 {
    const stat = try file.stat(io);
    if (stat.kind != .file or stat.size != expected_size) return error.FileSizeMismatch;
    var hash: Sha256 = .init(.{});
    var offset: u64 = 0;
    var buffer: [copy_buffer_size]u8 = undefined;
    while (offset < expected_size) {
        const count: usize = @intCast(@min(buffer.len, expected_size - offset));
        if (try file.readPositionalAll(io, buffer[0..count], offset) != count) return error.FileSizeMismatch;
        hash.update(buffer[0..count]);
        offset += count;
    }
    return std.fmt.bytesToHex(hash.finalResult(), .lower);
}

/// Emits the exact CI archive while verifying both individual file bytes and
/// the entire result. The caller must not activate output until this returns.
pub fn reconstruct(allocator: Allocator, io: Io, recipe: Recipe, app_root: Io.Dir, writer: *Io.Writer) !void {
    try validate(allocator, recipe);
    var entries: std.StringHashMapUnmanaged(Entry) = .empty;
    defer entries.deinit(allocator);
    for (recipe.entries) |entry| try entries.put(allocator, entry.path, entry);
    var archive_hash: Sha256 = .init(.{});
    var buffer: [copy_buffer_size]u8 = undefined;
    for (recipe.spans) |span| {
        if (span.literal_hex) |literal| {
            var offset: usize = 0;
            while (offset < literal.len) {
                const count = @min(buffer.len, (literal.len - offset) / 2);
                const bytes = try std.fmt.hexToBytes(buffer[0..count], literal[offset .. offset + count * 2]);
                archive_hash.update(bytes);
                try writer.writeAll(bytes);
                offset += count * 2;
            }
        } else {
            const path = span.path.?;
            const file = try openRegularFile(io, app_root, path);
            defer file.close(io);
            if ((try file.stat(io)).size != span.size) return error.FileSizeMismatch;
            const entry = entries.get(path) orelse return error.InvalidRecipe;
            var file_hash: Sha256 = .init(.{});
            var offset: u64 = 0;
            while (offset < span.size) {
                const count: usize = @intCast(@min(buffer.len, span.size - offset));
                if (try file.readPositionalAll(io, buffer[0..count], offset) != count) return error.FileSizeMismatch;
                archive_hash.update(buffer[0..count]);
                file_hash.update(buffer[0..count]);
                try writer.writeAll(buffer[0..count]);
                offset += count;
            }
            if (!std.mem.eql(u8, &std.fmt.bytesToHex(file_hash.finalResult(), .lower), entry.sha256.?)) return error.FileHashMismatch;
        }
    }
    if (!std.mem.eql(u8, &std.fmt.bytesToHex(archive_hash.finalResult(), .lower), recipe.archive_sha256)) return error.ArchiveHashMismatch;
}

/// Validates a freshly extracted tree before activation. Unlike reconstruction
/// of an installed baseline, this verifies filesystem objects represented by
/// literal tar metadata too, and rejects unlisted files or directories.
pub fn verifyTree(allocator: Allocator, io: Io, recipe: Recipe, app_root: Io.Dir) !void {
    var discard: Io.Writer.Discarding = .init(&.{});
    try reconstruct(allocator, io, recipe, app_root, &discard.writer);
    var entries: std.StringHashMapUnmanaged(Entry) = .empty;
    defer entries.deinit(allocator);
    var expected: std.StringHashMapUnmanaged(Kind) = .empty;
    defer expected.deinit(allocator);
    for (recipe.entries) |entry| {
        try entries.put(allocator, entry.path, entry);
        try expected.put(allocator, entry.path, entry.kind);
    }
    for (recipe.entries) |entry| {
        var path = entry.path;
        while (std.mem.lastIndexOfScalar(u8, path, '/')) |slash| {
            path = path[0..slash];
            const parent = try expected.getOrPut(allocator, path);
            if (parent.found_existing) {
                if (parent.value_ptr.* != .directory) return error.NonDirectoryArchiveAncestor;
            } else parent.value_ptr.* = .directory;
        }
        var parent = try openParent(io, app_root, entry.path, false);
        defer parent.close(io);
        const stat = try parent.statFile(io, leafName(entry.path), .{ .follow_symlinks = false });
        switch (entry.kind) {
            .file => if (stat.kind != .file) return error.StagedEntryTypeMismatch,
            .directory => if (stat.kind != .directory) return error.StagedEntryTypeMismatch,
            .symlink => {
                if (stat.kind != .sym_link) return error.StagedEntryTypeMismatch;
                var buffer: [4096]u8 = undefined;
                const count = try parent.readLink(io, leafName(entry.path), &buffer);
                if (!std.mem.eql(u8, buffer[0..count], entry.link_target.?)) return error.StagedLinkTargetMismatch;
            },
            .hardlink => {
                if (stat.kind != .file) return error.StagedEntryTypeMismatch;
                const target = entries.get(entry.link_target.?) orelse return error.InvalidLinkTarget;
                const file = try openRegularFile(io, app_root, entry.path);
                defer file.close(io);
                const hash = try hashFile(io, file, target.size);
                if (!std.mem.eql(u8, &hash, target.sha256.?)) return error.FileHashMismatch;
                const target_file = try openRegularFile(io, app_root, target.path);
                defer target_file.close(io);
                if ((try target_file.stat(io)).inode != stat.inode) return error.StagedHardlinkTargetMismatch;
            },
        }
    }
    const StackEntry = struct { dir: Io.Dir, iterator: Io.Dir.Iterator, path: []const u8 };
    var stack: std.ArrayList(StackEntry) = .empty;
    defer {
        for (stack.items) |item| {
            item.dir.close(io);
            allocator.free(item.path);
        }
        stack.deinit(allocator);
    }
    {
        var root = try app_root.openDir(io, ".", .{ .iterate = true, .follow_symlinks = false });
        errdefer root.close(io);
        const path = try allocator.dupe(u8, "");
        errdefer allocator.free(path);
        try stack.append(allocator, .{ .dir = root, .iterator = root.iterate(), .path = path });
    }
    var visited: usize = 0;
    while (stack.items.len > 0) {
        const top = &stack.items[stack.items.len - 1];
        if (try top.iterator.next(io)) |actual| {
            const path = if (top.path.len == 0)
                try allocator.dupe(u8, actual.name)
            else
                try std.fmt.allocPrint(allocator, "{s}/{s}", .{ top.path, actual.name });
            var path_owned = true;
            defer if (path_owned) allocator.free(path);
            const kind = expected.get(path) orelse return error.UnexpectedStagedPath;
            const stat = try top.dir.statFile(io, actual.name, .{ .follow_symlinks = false });
            const matches = switch (kind) {
                .file, .hardlink => stat.kind == .file,
                .directory => stat.kind == .directory,
                .symlink => stat.kind == .sym_link,
            };
            if (!matches) return error.StagedEntryTypeMismatch;
            visited += 1;
            if (kind == .directory) {
                var dir = try top.dir.openDir(io, actual.name, .{ .iterate = true, .follow_symlinks = false });
                errdefer dir.close(io);
                try stack.append(allocator, .{ .dir = dir, .iterator = dir.iterate(), .path = path });
                path_owned = false;
            }
        } else {
            const item = stack.pop().?;
            item.dir.close(io);
            allocator.free(item.path);
        }
    }
    if (visited != expected.count()) return error.MissingStagedPath;
}

fn testHeader(path: []const u8, kind: u8, size: usize, link: []const u8) ![512]u8 {
    var header: [512]u8 = @splat(0);
    if (path.len > 100 or link.len > 100) return error.TestPathTooLong;
    @memcpy(header[0..path.len], path);
    @memcpy(header[100..108], "0000751\x00");
    @memcpy(header[108..116], "0000107\x00");
    @memcpy(header[116..124], "0000203\x00");
    const length = try std.fmt.bufPrint(header[124..135], "{o:0>11}", .{size});
    std.debug.assert(length.len == 11);
    @memcpy(header[136..148], "12345670123\x00");
    @memset(header[148..156], ' ');
    header[156] = kind;
    @memcpy(header[157..][0..link.len], link);
    @memcpy(header[257..263], "ustar\x00");
    @memcpy(header[263..265], "00");
    @memcpy(header[265..270], "alice");
    @memcpy(header[297..302], "staff");
    var sum: usize = 0;
    for (header) |b| sum += b;
    _ = try std.fmt.bufPrint(header[148..154], "{o:0>6}", .{sum});
    header[154] = 0;
    header[155] = ' ';
    return header;
}

fn testAppend(writer: *Io.Writer, path: []const u8, kind: u8, payload: []const u8, link: []const u8) !void {
    const header = try testHeader(path, kind, payload.len, link);
    try writer.writeAll(&header);
    try writer.writeAll(payload);
    // Nonzero padding is legal tar data and must also survive reconstruction.
    var padding: [511]u8 = @splat(0xa5);
    const count: usize = @intCast(try rounded(payload.len) - payload.len);
    try writer.writeAll(padding[0..count]);
}

fn testPax(allocator: Allocator, key: []const u8, value: []const u8) ![]u8 {
    var digits: usize = 1;
    while (true) {
        const length = digits + 1 + key.len + 1 + value.len + 1;
        var number: [32]u8 = undefined;
        const actual = try std.fmt.bufPrint(&number, "{d}", .{length});
        if (actual.len == digits) return std.fmt.allocPrint(allocator, "{d} {s}={s}\n", .{ length, key, value });
        digits = actual.len;
    }
}

fn testFixture(writer: *Io.Writer) !void {
    try testAppend(writer, "Example.app/", '5', "", "");
    try testAppend(writer, "Example.app/bin/", '5', "", "");
    try testAppend(writer, "Example.app/bin/main", '0', "signed executable bytes\x00\xff", "");
    const pax = try testPax(std.testing.allocator, "path", "Example.app/readme-\xc3\xa9.txt");
    defer std.testing.allocator.free(pax);
    try testAppend(writer, "PaxHeader", 'x', pax, "");
    try testAppend(writer, "Example.app/placeholder", '0', "documentation", "");
    try testAppend(writer, "Example.app/empty", '0', "", "");
    try testAppend(writer, "Example.app/link", '2', "", "bin/main");
    try testAppend(writer, "Example.app/hard", '1', "", "Example.app/bin/main");
    var end: [2048]u8 = @splat(0);
    try writer.writeAll(&end);
}

test "exact recipe replays PAX headers, padding, metadata and signatures without retaining file bytes" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testFixture(&original.writer);
    try tmp.dir.writeFile(io, .{ .sub_path = "source.tar", .data = original.written() });
    const source = try tmp.dir.openFile(io, "source.tar", .{});
    defer source.close(io);
    var receipt = try index(allocator, io, source);
    defer receipt.deinit();
    try std.testing.expectEqualStrings("Example.app", receipt.value.root);
    try std.testing.expectEqual(@as(usize, 6), receipt.value.entries.len);
    try std.testing.expectEqualStrings("readme-\xc3\xa9.txt", receipt.value.entries[2].path);
    var json: Io.Writer.Allocating = .init(allocator);
    defer json.deinit();
    try writeJson(receipt.value, &json.writer);
    try std.testing.expect(std.mem.indexOf(u8, json.written(), "signed executable bytes") == null);
    var parsed = try parse(allocator, json.written());
    defer parsed.deinit();
    // Install contents with intentionally unrelated filesystem metadata.
    try tmp.dir.createDir(io, "app", .default_dir);
    var app = try tmp.dir.openDir(io, "app", .{});
    defer app.close(io);
    try app.createDir(io, "bin", .default_dir);
    try app.writeFile(io, .{ .sub_path = "bin/main", .data = "signed executable bytes\x00\xff" });
    try app.writeFile(io, .{ .sub_path = "readme-\xc3\xa9.txt", .data = "documentation" });
    try app.writeFile(io, .{ .sub_path = "empty", .data = "" });
    var reconstructed: Io.Writer.Allocating = .init(allocator);
    defer reconstructed.deinit();
    try reconstruct(allocator, io, parsed.value, app, &reconstructed.writer);
    try std.testing.expectEqualSlices(u8, original.written(), reconstructed.written());
    try app.writeFile(io, .{ .sub_path = "bin/main", .data = "changed executable byte\x00\xff" });
    var discard: Io.Writer.Discarding = .init(&.{});
    try std.testing.expectError(error.FileHashMismatch, reconstruct(allocator, io, parsed.value, app, &discard.writer));
}

test "archive paths reject traversal everywhere and Windows aliases only on Windows" {
    for ([_][]const u8{ "", ".", "..", "/absolute", "a/../b", "a//b", "a\\b" }) |path| {
        try std.testing.expectError(error.InvalidArchivePath, validatePath(path));
    }
    for ([_][]const u8{ "C:/file", "a/CON.txt", "a/lpt9", "a/aux", "a/trailing.", "a/trailing ", "a/stream:secret", "a/quoted\"name" }) |path| {
        try std.testing.expectError(error.InvalidArchivePath, validatePathFor(.windows, path));
        try validatePathFor(.linux, path);
        try validatePathFor(.macos, path);
        if (builtin.os.tag == .windows) try std.testing.expectError(error.InvalidArchivePath, validatePath(path)) else try validatePath(path);
    }
    try validatePath("Contents/Resources/lib.dylib");
    try validateLinkTarget("a/b/link", "../../real");
    try std.testing.expectError(error.InvalidLinkTarget, validateLinkTarget("a/link", "../../outside"));
    try std.testing.expectError(error.InvalidLinkTarget, validateLinkTarget("link", "/outside"));
}

test "index rejects truncated archives, invalid checksum, duplicate paths and symlink ancestors" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var archive: Io.Writer.Allocating = .init(allocator);
    defer archive.deinit();
    const endings: [1024]u8 = @splat(0);
    try testAppend(&archive.writer, "App/", '5', "", "");
    try testAppend(&archive.writer, "App/a", '0', "one", "");
    try testAppend(&archive.writer, "App/a", '0', "two", "");
    try archive.writer.writeAll(&endings);
    try tmp.dir.writeFile(io, .{ .sub_path = "duplicate.tar", .data = archive.written() });
    const duplicate = try tmp.dir.openFile(io, "duplicate.tar", .{});
    defer duplicate.close(io);
    try std.testing.expectError(error.DuplicateArchivePath, index(allocator, io, duplicate));
    archive.clearRetainingCapacity();
    try testAppend(&archive.writer, "App/", '5', "", "");
    try testAppend(&archive.writer, "App/dir", '2', "", "real");
    try testAppend(&archive.writer, "App/dir/file", '0', "unsafe", "");
    try archive.writer.writeAll(&endings);
    try tmp.dir.writeFile(io, .{ .sub_path = "ancestor.tar", .data = archive.written() });
    const ancestor = try tmp.dir.openFile(io, "ancestor.tar", .{});
    defer ancestor.close(io);
    try std.testing.expectError(error.NonDirectoryArchiveAncestor, index(allocator, io, ancestor));
    try tmp.dir.writeFile(io, .{ .sub_path = "short.tar", .data = archive.written()[0 .. archive.written().len - 1] });
    const short = try tmp.dir.openFile(io, "short.tar", .{});
    defer short.close(io);
    try std.testing.expectError(error.InvalidTarSize, index(allocator, io, short));
    archive.written()[0] ^= 1;
    try tmp.dir.writeFile(io, .{ .sub_path = "checksum.tar", .data = archive.written() });
    const checksum = try tmp.dir.openFile(io, "checksum.tar", .{});
    defer checksum.close(io);
    try std.testing.expectError(error.InvalidTarChecksum, index(allocator, io, checksum));
}

test "case-distinct Linux payloads remain valid without allowing aliases on Windows or macOS" {
    const allocator = std.testing.allocator;
    var archive: Io.Writer.Allocating = .init(allocator);
    defer archive.deinit();
    try testAppend(&archive.writer, "App/", '5', "", "");
    try testAppend(&archive.writer, "App/Case", '0', "uppercase", "");
    try testAppend(&archive.writer, "App/case", '0', "lowercase", "");
    const endings: [1024]u8 = @splat(0);
    try archive.writer.writeAll(&endings);
    var reader: Io.Reader = .fixed(archive.written());
    if (builtin.os.tag == .macos or builtin.os.tag == .windows) {
        try std.testing.expectError(error.DuplicateArchivePath, indexReader(allocator, &reader, archive.written().len, null));
    } else {
        var receipt = try indexReader(allocator, &reader, archive.written().len, null);
        defer receipt.deinit();
        try std.testing.expectEqualStrings("Case", receipt.value.entries[0].path);
        try std.testing.expectEqualStrings("case", receipt.value.entries[1].path);
        try std.testing.expectError(error.DuplicateArchivePath, validateFor(allocator, receipt.value, .windows));
        try std.testing.expectError(error.DuplicateArchivePath, validateFor(allocator, receipt.value, .macos));
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        var stream: Io.Reader = .fixed(archive.written());
        var extracted = try extractReader(allocator, std.testing.io, &stream, null, tmp.dir);
        defer extracted.deinit();
        var app = try tmp.dir.openDir(std.testing.io, "App", .{});
        defer app.close(std.testing.io);
        try verifyTree(allocator, std.testing.io, extracted.value, app);
    }
    // Exercise Linux's namespace policy even when the suite runs on macOS.
    const lower = try namespaceKey(allocator, "name", .linux);
    defer allocator.free(lower);
    const upper = try namespaceKey(allocator, "Name", .linux);
    defer allocator.free(upper);
    try std.testing.expect(!std.mem.eql(u8, lower, upper));
}

test "reconstruction refuses a symlink in the installed source path" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(io, "real", .default_dir);
    try tmp.dir.writeFile(io, .{ .sub_path = "real/file", .data = "outside baseline" });
    try tmp.dir.symLink(io, "real", "alias", .{ .is_directory = true });
    if (openRegularFile(io, tmp.dir, "alias/file")) |file| {
        file.close(io);
        return error.TestExpectedError;
    } else |_| {}
    try tmp.dir.symLink(io, "real/file", "link", .{});
    if (openRegularFile(io, tmp.dir, "link")) |file| {
        file.close(io);
        return error.TestExpectedError;
    } else |_| {}
}

test "stream indexing preserves GNU long names and link targets and forwards exact bytes" {
    const allocator = std.testing.allocator;
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testAppend(&original.writer, "App/", '5', "", "");
    const long = "long-name-long-name-long-name-long-name-long-name-long-name-long-name-long-name-long-name-long-name-long-name-long-name";
    const archive_path = "App/" ++ long;
    try testAppend(&original.writer, "././@LongLink", 'L', archive_path ++ "\x00", "");
    try testAppend(&original.writer, "App/short", '0', "bytes", "");
    try testAppend(&original.writer, "././@LongLink", 'K', long ++ "\x00", "");
    try testAppend(&original.writer, "App/link", '2', "", "short");
    const end: [1024]u8 = @splat(0);
    try original.writer.writeAll(&end);
    var reader: Io.Reader = .fixed(original.written());
    var forwarded: Io.Writer.Allocating = .init(allocator);
    defer forwarded.deinit();
    var recipe = try indexReader(allocator, &reader, original.written().len, &forwarded.writer);
    defer recipe.deinit();
    try std.testing.expectEqualSlices(u8, original.written(), forwarded.written());
    try std.testing.expectEqualStrings(long, recipe.value.entries[0].path);
    try std.testing.expectEqualStrings(long, recipe.value.entries[1].link_target.?);
    try std.testing.expectEqual(@as(u64, 5), recipe.value.entries[0].size);
    var short: Io.Reader = .fixed(original.written()[0 .. original.written().len - 512]);
    try std.testing.expectError(error.TruncatedTar, indexReader(allocator, &short, original.written().len, null));
}

test "recipe validation rejects forged file spans and original archive identity" {
    const allocator = std.testing.allocator;
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testFixture(&original.writer);
    var reader: Io.Reader = .fixed(original.written());
    var recipe = try indexReader(allocator, &reader, original.written().len, null);
    defer recipe.deinit();
    const spans = try allocator.dupe(Span, recipe.value.spans);
    defer allocator.free(spans);
    var forged = recipe.value;
    forged.spans = spans;
    spans[1].path = "../outside";
    try std.testing.expectError(error.InvalidRecipe, validate(allocator, forged));
    spans[1] = recipe.value.spans[1];
    spans[1].size += 1;
    try std.testing.expectError(error.InvalidRecipe, validate(allocator, forged));
    forged = recipe.value;
    forged.archive_sha256 = "not-a-hash";
    try std.testing.expectError(error.InvalidRecipe, validate(allocator, forged));
}

test "complete serialized recipe budget includes hex expansion and JSON overhead" {
    const allocator = std.testing.allocator;
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testFixture(&original.writer);
    var reader: Io.Reader = .fixed(original.written());
    var receipt = try indexReader(allocator, &reader, original.written().len, null);
    defer receipt.deinit();
    var hex_bytes: u64 = 0;
    for (receipt.value.spans) |span| if (span.literal_hex) |literal| {
        hex_bytes += literal.len;
    };
    const full_size = try serializedSize(receipt.value);
    try std.testing.expect(full_size > hex_bytes);
    try std.testing.expectError(error.RecipeTooLarge, checkSerializedSize(receipt.value, hex_bytes));
    try checkSerializedSize(receipt.value, full_size);
    var output: Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    try std.testing.expectError(error.RecipeTooLarge, writeJsonLimited(receipt.value, &output.writer, full_size - 1));
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try writeJsonLimited(receipt.value, &output.writer, full_size);
    try std.testing.expectEqual(full_size, output.written().len);
    var parsed = try parse(allocator, output.written());
    defer parsed.deinit();
    try std.testing.expectEqualStrings(receipt.value.archive_sha256, parsed.value.archive_sha256);
}

test "PAX overrides are bounded and reject malformed lengths and sparse archives" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var overrides: Overrides = .{};
    try std.testing.expectError(error.InvalidPaxRecord, parsePax(arena.allocator(), "999 path=outside\n", &overrides));
    try std.testing.expectError(error.InvalidPaxRecord, parsePax(arena.allocator(), "0 a=b\n", &overrides));
    const sparse = try testPax(arena.allocator(), "GNU.sparse.map", "0,1024");
    try std.testing.expectError(error.UnsupportedTarType, parsePax(arena.allocator(), sparse, &overrides));
    const size = try testPax(arena.allocator(), "size", "12345");
    try parsePax(arena.allocator(), size, &overrides);
    try std.testing.expectEqual(@as(?u64, 12345), overrides.size);
}

test "indexing and reconstruction metadata memory does not grow with file contents" {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const file_size = 4 * 1024 * 1024;
    const source = try tmp.dir.createFile(io, "large.tar", .{ .read = true });
    defer source.close(io);
    try source.writeStreamingAll(io, &try testHeader("App/", '5', 0, ""));
    try source.writeStreamingAll(io, &try testHeader("App/data", '0', file_size, ""));
    const installed = try tmp.dir.createFile(io, "data", .{});
    defer installed.close(io);
    const chunk: [64 * 1024]u8 = @splat(0xf7);
    var offset: usize = 0;
    while (offset < file_size) : (offset += chunk.len) {
        try source.writeStreamingAll(io, &chunk);
        try installed.writeStreamingAll(io, &chunk);
    }
    const trailer: [1024]u8 = @splat(0);
    try source.writeStreamingAll(io, &trailer);
    var memory: [256 * 1024]u8 = undefined;
    var fixed = std.heap.FixedBufferAllocator.init(&memory);
    var recipe = try index(fixed.allocator(), io, source);
    defer recipe.deinit();
    var discard: Io.Writer.Discarding = .init(&.{});
    try reconstruct(fixed.allocator(), io, recipe.value, tmp.dir, &discard.writer);
    try std.testing.expectEqual(@as(u64, file_size + 2048), discard.fullCount());
}

test "unknown-length extraction stages files and hardlinks while recording byte-exact tar" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testAppend(&original.writer, "App/", '5', "", "");
    try testAppend(&original.writer, "App/bin/", '5', "", "");
    try testAppend(&original.writer, "App/bin/executable", '0', "preserve these signed bytes\x00\xff", "");
    const pax = try testPax(allocator, "path", "App/utf8-\xc3\xa9.txt");
    defer allocator.free(pax);
    try testAppend(&original.writer, "PaxHeader", 'x', pax, "");
    try testAppend(&original.writer, "App/placeholder", '0', "long-name payload", "");
    try testAppend(&original.writer, "App/hard", '1', "", "App/bin/executable");
    const end: [2048]u8 = @splat(0);
    try original.writer.writeAll(&end);
    var reader: Io.Reader = .fixed(original.written());
    var receipt = try extractReader(allocator, io, &reader, null, tmp.dir);
    defer receipt.deinit();
    var app = try tmp.dir.openDir(io, "App", .{});
    defer app.close(io);
    try verifyTree(allocator, io, receipt.value, app);
    const content = try app.readFileAlloc(io, "hard", allocator, .limited(1024));
    defer allocator.free(content);
    try std.testing.expectEqualStrings("preserve these signed bytes\x00\xff", content);
    var reconstructed: Io.Writer.Allocating = .init(allocator);
    defer reconstructed.deinit();
    try reconstruct(allocator, io, receipt.value, app, &reconstructed.writer);
    try std.testing.expectEqualSlices(u8, original.written(), reconstructed.written());
    if (builtin.os.tag != .windows) {
        const executable = try openRegularFile(io, app, "bin/executable");
        defer executable.close(io);
        try std.testing.expectEqual(@as(std.posix.mode_t, 0o751), (try executable.stat(io)).permissions.toMode() & 0o777);
    }
    try app.deleteFile(io, "hard");
    try app.writeFile(io, .{ .sub_path = "hard", .data = "preserve these signed bytes\x00\xff" });
    try std.testing.expectError(error.StagedHardlinkTargetMismatch, verifyTree(allocator, io, receipt.value, app));
    try app.writeFile(io, .{ .sub_path = "hard", .data = "modified these signed bytes\x00\xff" });
    try std.testing.expectError(error.FileHashMismatch, verifyTree(allocator, io, receipt.value, app));
    // A failed/retried extraction never merges into a prior or installed tree.
    var retry: Io.Reader = .fixed(original.written());
    try std.testing.expectError(error.PathAlreadyExists, extractReader(allocator, io, &retry, original.written().len, tmp.dir));
}

test "extracted hardlinks preserve file identity and never overwrite paths" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var payload: [copy_buffer_size * 2 + 37]u8 = undefined;
    for (&payload, 0..) |*byte, i| byte.* = @truncate(i *% 37);
    try tmp.dir.writeFile(io, .{ .sub_path = "target", .data = &payload });
    try tmp.dir.createDir(io, "nested", .default_dir);
    var nested = try tmp.dir.openDir(io, "nested", .{ .follow_symlinks = false });
    defer nested.close(io);
    try createHardlink(io, tmp.dir, "target", nested, "hard");
    const content = try nested.readFileAlloc(io, "hard", allocator, .limited(payload.len + 1));
    defer allocator.free(content);
    try std.testing.expectEqualSlices(u8, &payload, content);
    const source_stat = try tmp.dir.statFile(io, "target", .{ .follow_symlinks = false });
    const linked_stat = try nested.statFile(io, "hard", .{ .follow_symlinks = false });
    try std.testing.expectEqual(source_stat.inode, linked_stat.inode);
    try std.testing.expectEqual(@as(Io.File.NLink, 2), linked_stat.nlink);
    try tmp.dir.writeFile(io, .{ .sub_path = "other", .data = "different target" });
    try std.testing.expectError(error.PathAlreadyExists, createHardlink(io, tmp.dir, "other", nested, "hard"));
    const preserved = try nested.readFileAlloc(io, "hard", allocator, .limited(payload.len + 1));
    defer allocator.free(preserved);
    try std.testing.expectEqualSlices(u8, &payload, preserved);
    try tmp.dir.writeFile(io, .{ .sub_path = "empty", .data = "" });
    // A single UTF-16 character exercises native ABI minimum buffer length as
    // well as UTF-8 filename conversion on Windows.
    try createHardlink(io, tmp.dir, "empty", nested, "\xc3\xa9");
    try std.testing.expectEqual(@as(u64, 0), (try nested.statFile(io, "\xc3\xa9", .{ .follow_symlinks = false })).size);
    try std.testing.expectError(error.InvalidArchivePath, createHardlink(io, tmp.dir, "nested/../target", nested, "unsafe"));
    try std.testing.expectError(error.InvalidArchivePath, createHardlink(io, tmp.dir, "target", nested, "other/unsafe"));
}

test "staged extraction creates validated symlinks only after regular files" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testFixture(&original.writer);
    var reader: Io.Reader = .fixed(original.written());
    var receipt = try extractReader(allocator, io, &reader, original.written().len, tmp.dir);
    defer receipt.deinit();
    var target: [256]u8 = undefined;
    const n = try tmp.dir.readLink(io, "Example.app/link", &target);
    try std.testing.expectEqualStrings("bin/main", target[0..n]);
    const linked = try tmp.dir.readFileAlloc(io, "Example.app/link", allocator, .limited(1024));
    defer allocator.free(linked);
    try std.testing.expectEqualStrings("signed executable bytes\x00\xff", linked);
}

test "stream extraction rejects truncation, trailing bytes and paths outside its stage" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testAppend(&original.writer, "App/", '5', "", "");
    try testAppend(&original.writer, "App/file", '0', "payload", "");
    const end: [1024]u8 = @splat(0);
    try original.writer.writeAll(&end);
    {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        var truncated: Io.Reader = .fixed(original.written()[0 .. original.written().len - 512]);
        try std.testing.expectError(error.TruncatedTar, extractReader(allocator, io, &truncated, null, tmp.dir));
    }
    {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        try original.writer.writeByte(1);
        var trailing: Io.Reader = .fixed(original.written());
        try std.testing.expectError(error.InvalidTarTrailer, extractReader(allocator, io, &trailing, null, tmp.dir));
    }
    {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        var trailing: Io.Reader = .fixed(original.written());
        try std.testing.expectError(error.InvalidTarTrailer, extractReader(allocator, io, &trailing, original.written().len - 1, tmp.dir));
    }
    {
        var tmp = std.testing.tmpDir(.{});
        defer tmp.cleanup();
        original.clearRetainingCapacity();
        try testAppend(&original.writer, "App/../outside", '0', "must not escape", "");
        try original.writer.writeAll(&end);
        var escape: Io.Reader = .fixed(original.written());
        try std.testing.expectError(error.InvalidArchivePath, extractReader(allocator, io, &escape, null, tmp.dir));
        try std.testing.expectError(error.FileNotFound, tmp.dir.access(io, "outside", .{}));
    }
}

test "fresh stage verification rejects modified data, extra executables and directory substitution" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testAppend(&original.writer, "App/", '5', "", "");
    // The parent directory is deliberately implicit in this archive.
    try testAppend(&original.writer, "App/bin/main", '0', "original bytes", "");
    try testAppend(&original.writer, "App/empty/", '5', "", "");
    const end: [1024]u8 = @splat(0);
    try original.writer.writeAll(&end);
    var reader: Io.Reader = .fixed(original.written());
    var receipt = try extractReader(allocator, io, &reader, null, tmp.dir);
    defer receipt.deinit();
    var app = try tmp.dir.openDir(io, "App", .{});
    defer app.close(io);
    try verifyTree(allocator, io, receipt.value, app);
    try app.writeFile(io, .{ .sub_path = "bin/main", .data = "modified bytes" });
    try std.testing.expectError(error.FileHashMismatch, verifyTree(allocator, io, receipt.value, app));
    try app.writeFile(io, .{ .sub_path = "bin/main", .data = "original bytes" });
    try app.writeFile(io, .{ .sub_path = "bin/injected", .data = "unlisted executable" });
    try std.testing.expectError(error.UnexpectedStagedPath, verifyTree(allocator, io, receipt.value, app));
    try app.deleteFile(io, "bin/injected");
    try app.deleteDir(io, "empty");
    try app.writeFile(io, .{ .sub_path = "empty", .data = "directory replaced by file" });
    try std.testing.expectError(error.StagedEntryTypeMismatch, verifyTree(allocator, io, receipt.value, app));
}

test "fresh stage verification checks actual symlink and hardlink content beyond archive replay" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var original: Io.Writer.Allocating = .init(allocator);
    defer original.deinit();
    try testFixture(&original.writer);
    var reader: Io.Reader = .fixed(original.written());
    var receipt = try extractReader(allocator, io, &reader, null, tmp.dir);
    defer receipt.deinit();
    var app = try tmp.dir.openDir(io, "Example.app", .{});
    defer app.close(io);
    try verifyTree(allocator, io, receipt.value, app);
    try app.deleteFile(io, "link");
    try app.symLink(io, "empty", "link", .{});
    // Reconstructing a baseline ignores filesystem metadata fixups by design.
    var discard: Io.Writer.Discarding = .init(&.{});
    try reconstruct(allocator, io, receipt.value, app, &discard.writer);
    try std.testing.expectError(error.StagedLinkTargetMismatch, verifyTree(allocator, io, receipt.value, app));
    try app.deleteFile(io, "link");
    try app.symLink(io, "bin/main", "link", .{});
    try app.deleteFile(io, "hard");
    try app.writeFile(io, .{ .sub_path = "hard", .data = "changed executable byte\x00\xff" });
    try std.testing.expectError(error.FileHashMismatch, verifyTree(allocator, io, receipt.value, app));
}

fn testCommand(argv: []const []const u8, environment: ?*const std.process.Environ.Map) !void {
    const allocator = std.testing.allocator;
    const result = try std.process.run(allocator, std.testing.io, .{
        .argv = argv,
        .environ_map = environment,
        .stdout_limit = .limited(64 * 1024),
        .stderr_limit = .limited(64 * 1024),
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (!result.term.success()) {
        std.debug.print("archive recipe integration command failed ({s}): {f}\n{s}\n{s}\n", .{ argv[0], result.term, result.stdout, result.stderr });
        return error.TestCommandFailed;
    }
}

test "macOS signed bundle survives exact archive reconstruction after installed timestamps change" {
    if (builtin.os.tag != .macos) return error.SkipZigTest;
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(io, "Signed.app/Contents/MacOS");
    try tmp.dir.createDirPath(io, "Signed.app/Contents/Resources");
    const plist =
        \\<?xml version="1.0" encoding="UTF-8"?>
        \\<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        \\<plist version="1.0"><dict>
        \\<key>CFBundleExecutable</key><string>main</string>
        \\<key>CFBundleIdentifier</key><string>dev.electrobun.archive-recipe-test</string>
        \\<key>CFBundleName</key><string>Signed</string>
        \\<key>CFBundlePackageType</key><string>APPL</string>
        \\<key>CFBundleVersion</key><string>1</string>
        \\</dict></plist>
    ;
    try tmp.dir.writeFile(io, .{ .sub_path = "Signed.app/Contents/Info.plist", .data = plist });
    try tmp.dir.writeFile(io, .{ .sub_path = "Signed.app/Contents/Resources/payload.txt", .data = "Resource contents sealed by codesign.\n" });
    try Io.Dir.cwd().copyFile("/usr/bin/true", tmp.dir, "Signed.app/Contents/MacOS/main", io, .{});
    const root_path = try tmp.dir.realPathFileAlloc(io, ".", allocator);
    defer allocator.free(root_path);
    const app_path = try std.fs.path.join(allocator, &.{ root_path, "Signed.app" });
    defer allocator.free(app_path);
    try testCommand(&.{ "/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", app_path }, null);
    try testCommand(&.{ "/usr/bin/codesign", "--verify", "--deep", "--strict", app_path }, null);
    const tar_path = try std.fs.path.join(allocator, &.{ root_path, "signed.tar" });
    defer allocator.free(tar_path);
    var tar_environment = std.process.Environ.Map.init(allocator);
    defer tar_environment.deinit();
    try tar_environment.put("COPYFILE_DISABLE", "1");
    try testCommand(&.{ "/usr/bin/tar", "--no-xattrs", "-cf", tar_path, "-C", root_path, "Signed.app" }, &tar_environment);
    const original = try tmp.dir.readFileAlloc(io, "signed.tar", allocator, .limited(8 * 1024 * 1024));
    defer allocator.free(original);
    const source = try tmp.dir.openFile(io, "signed.tar", .{});
    defer source.close(io);
    var receipt = try index(allocator, io, source);
    defer receipt.deinit();
    var app = try tmp.dir.openDir(io, "Signed.app", .{});
    defer app.close(io);
    // A normal installation creates new filesystem timestamps. Those must not
    // leak into reconstructed tar headers or require re-signing the bundle.
    const changed_timestamp: Io.File.SetTimestamp = .{ .new = .fromNanoseconds(123456789 * std.time.ns_per_s) };
    try app.setTimestamps(io, "Contents/MacOS/main", .{ .modify_timestamp = changed_timestamp });
    try app.setTimestamps(io, "Contents/Resources/payload.txt", .{ .modify_timestamp = changed_timestamp });
    var reconstructed: Io.Writer.Allocating = .init(allocator);
    defer reconstructed.deinit();
    try reconstruct(allocator, io, receipt.value, app, &reconstructed.writer);
    try std.testing.expectEqualSlices(u8, original, reconstructed.written());
    try tmp.dir.createDir(io, "stage", .default_dir);
    var stage = try tmp.dir.openDir(io, "stage", .{});
    defer stage.close(io);
    var input: Io.Reader = .fixed(reconstructed.written());
    var staged_receipt = try extractReader(allocator, io, &input, null, stage);
    defer staged_receipt.deinit();
    var staged_app = try stage.openDir(io, "Signed.app", .{});
    defer staged_app.close(io);
    try verifyTree(allocator, io, staged_receipt.value, staged_app);
    const staged_path = try std.fs.path.join(allocator, &.{ root_path, "stage", "Signed.app" });
    defer allocator.free(staged_path);
    // This is verification only: the extracted stage is never re-signed.
    try testCommand(&.{ "/usr/bin/codesign", "--verify", "--deep", "--strict", staged_path }, null);
}
