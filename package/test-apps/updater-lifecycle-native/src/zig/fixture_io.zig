const std = @import("std");

fn lockWriters(io: std.Io, directory: std.Io.Dir, path: []const u8) !std.Io.File {
    var buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const lock_path = try std.fmt.bufPrint(&buffer, "{s}.lock", .{path});
    return directory.createFile(io, lock_path, .{ .truncate = false, .lock = .exclusive });
}

pub fn appendLine(io: std.Io, directory: std.Io.Dir, path: []const u8, line: []const u8) !void {
    // Windows byte-range locks also deny reads through other handles. Keep
    // writer coordination off the log that the runner polls without locking.
    const writer_lock = try lockWriters(io, directory, path);
    defer writer_lock.close(io);
    // Windows file.stat() queries FileAllInformation, which requires read
    // attributes. A write-only handle can create the file but cannot query its
    // length, so the first fixture event would fail with AccessDenied.
    const file = try directory.createFile(io, path, .{ .read = true, .truncate = false });
    defer file.close(io);
    try file.writePositionalAll(io, line, (try file.stat(io)).size);
}

test "native lifecycle events append through a handle that can query its length" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const first = "{\"event\":\"launched\"}\n";
    const second = "{\"event\":\"installation-identity\"}\n";
    try appendLine(std.testing.io, temporary.dir, "events.jsonl", first);
    try appendLine(std.testing.io, temporary.dir, "events.jsonl", second);
    const contents = try temporary.dir.readFileAlloc(std.testing.io, "events.jsonl", std.testing.allocator, .limited(1024));
    defer std.testing.allocator.free(contents);
    try std.testing.expectEqualStrings(first ++ second, contents);
}

test "native lifecycle writer lock serializes writers while allowing separate log readers" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const line = "{\"event\":\"launched\"}\n";
    try appendLine(std.testing.io, temporary.dir, "events.jsonl", line);

    const writer_lock = try lockWriters(std.testing.io, temporary.dir, "events.jsonl");
    defer writer_lock.close(std.testing.io);
    try std.testing.expectError(error.WouldBlock, temporary.dir.createFile(std.testing.io, "events.jsonl.lock", .{
        .truncate = false,
        .lock = .exclusive,
        .lock_nonblocking = true,
    }));
    // Open a separate handle exactly as the runner does, while the production
    // writer lock remains held. Locking events.jsonl itself fails on Windows.
    const contents = try temporary.dir.readFileAlloc(std.testing.io, "events.jsonl", std.testing.allocator, .limited(1024));
    defer std.testing.allocator.free(contents);
    try std.testing.expectEqualStrings(line, contents);
}
