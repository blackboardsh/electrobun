const std = @import("std");

pub fn appendLine(io: std.Io, directory: std.Io.Dir, path: []const u8, line: []const u8) !void {
    // Windows file.stat() queries FileAllInformation, which requires read
    // attributes. A write-only handle can create the file but cannot query its
    // length, so the first fixture event would fail with AccessDenied.
    const file = try directory.createFile(io, path, .{ .read = true, .truncate = false, .lock = .exclusive });
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
