//! Local obfuscation and authenticated corruption detection for Insights state.
//! Keys live beside their files, so this is not secrecy from the machine owner.
//! JSON migration is explicit; encrypted decoding never falls back to JSON.
const std = @import("std");
const builtin = @import("builtin");
const A = std.mem.Allocator;
const Io = std.Io;
const Cipher = std.crypto.aead.chacha_poly.XChaCha20Poly1305;

pub const magic = "EBINSQ\r\n";
const version: u8 = 1;
const aad_len = magic.len + 1;
const header_len = aad_len + Cipher.nonce_length;
const overhead = header_len + Cipher.tag_length;

/// Returns owned plaintext. The caller still validates its application schema.
/// Legacy JSON state is accepted for migration and rewritten by the next write.
pub fn read(a: A, io: Io, path: []const u8, max_plaintext_bytes: usize) ![]u8 {
    const wire_limit = try boundedWireSize(max_plaintext_bytes);
    const contents = Io.Dir.cwd().readFileAlloc(io, path, a, .limited(wire_limit)) catch |err| switch (err) {
        error.StreamTooLong => return error.InsightsSpoolTooLarge,
        else => return err,
    };
    defer a.free(contents);
    if (std.mem.startsWith(u8, contents, magic)) {
        if (contents.len < overhead) return error.InvalidInsightsSpool;
        if (contents[magic.len] != version) return error.UnsupportedInsightsSpoolVersion;
        const plaintext_len = contents.len - overhead;
        if (plaintext_len > max_plaintext_bytes) return error.InsightsSpoolTooLarge;
        const key_path = try std.fmt.allocPrint(a, "{s}.key", .{path});
        defer a.free(key_path);
        var key = try readKey(a, io, key_path);
        defer std.crypto.secureZero(u8, &key);
        var nonce: [Cipher.nonce_length]u8 = undefined;
        @memcpy(&nonce, contents[aad_len..header_len]);
        var tag: [Cipher.tag_length]u8 = undefined;
        @memcpy(&tag, contents[contents.len - Cipher.tag_length ..]);
        const plaintext = try a.alloc(u8, plaintext_len);
        errdefer {
            std.crypto.secureZero(u8, plaintext);
            a.free(plaintext);
        }
        try Cipher.decrypt(plaintext, contents[header_len .. contents.len - Cipher.tag_length], tag, contents[0..aad_len], nonce, key);
        return plaintext;
    }
    if (contents.len > max_plaintext_bytes) return error.InsightsSpoolTooLarge;
    const trimmed = std.mem.trim(u8, contents, " \t\r\n");
    if (trimmed.len == 0 or (trimmed[0] != '[' and trimmed[0] != '{')) return error.InvalidInsightsSpool;
    // Recognize a complete old JSON container, not arbitrary data that happens
    // to start with a brace after a damaged envelope header.
    const parsed = std.json.parseFromSlice(std.json.Value, a, trimmed, .{}) catch return error.InvalidInsightsSpool;
    defer parsed.deinit();
    if (parsed.value != .array and parsed.value != .object) return error.InvalidInsightsSpool;
    return a.dupe(u8, contents);
}

/// Atomically persists an authenticated envelope. Use replace=false for the
/// first identity write so simultaneous launches agree on the winning identity.
pub fn write(a: A, io: Io, path: []const u8, plaintext: []const u8, max_plaintext_bytes: usize, replace: bool) !void {
    if (plaintext.len > max_plaintext_bytes) return error.InsightsSpoolTooLarge;
    _ = try boundedWireSize(max_plaintext_bytes);
    const key_path = try std.fmt.allocPrint(a, "{s}.key", .{path});
    defer a.free(key_path);
    var key = try loadOrCreateKey(a, io, path, key_path, max_plaintext_bytes);
    defer std.crypto.secureZero(u8, &key);
    var nonce: [Cipher.nonce_length]u8 = undefined;
    io.random(&nonce);
    const contents = try a.alloc(u8, plaintext.len + overhead);
    defer a.free(contents);
    @memcpy(contents[0..magic.len], magic);
    contents[magic.len] = version;
    @memcpy(contents[aad_len..header_len], &nonce);
    var tag: [Cipher.tag_length]u8 = undefined;
    Cipher.encrypt(contents[header_len .. contents.len - Cipher.tag_length], &tag, plaintext, contents[0..aad_len], nonce, key);
    @memcpy(contents[contents.len - Cipher.tag_length ..], &tag);
    try writeAtomic(io, path, contents, replace);
}

fn boundedWireSize(max_plaintext_bytes: usize) !usize {
    // Allow one extra byte in the I/O limit, then enforce the exact bound after
    // reading; this also keeps an exact maximum-size plaintext valid.
    return std.math.add(usize, max_plaintext_bytes, overhead + 1) catch error.InsightsSpoolTooLarge;
}

fn readKey(a: A, io: Io, path: []const u8) ![Cipher.key_length]u8 {
    const bytes = Io.Dir.cwd().readFileAlloc(io, path, a, .limited(Cipher.key_length + 1)) catch |err| switch (err) {
        error.StreamTooLong => return error.InvalidInsightsSpoolKey,
        else => return err,
    };
    defer {
        std.crypto.secureZero(u8, bytes);
        a.free(bytes);
    }
    if (bytes.len != Cipher.key_length) return error.InvalidInsightsSpoolKey;
    var result: [Cipher.key_length]u8 = undefined;
    @memcpy(&result, bytes);
    return result;
}

fn loadOrCreateKey(a: A, io: Io, path: []const u8, key_path: []const u8, max_plaintext_bytes: usize) ![Cipher.key_length]u8 {
    return readKey(a, io, key_path) catch |err| switch (err) {
        error.FileNotFound => blk: {
            // Do not silently replace an unreadable encrypted spool with a new
            // key. A read never generates keys, and a lost existing key needs
            // explicit state recovery by the caller.
            const old = Io.Dir.cwd().readFileAlloc(io, path, a, .limited(try boundedWireSize(max_plaintext_bytes))) catch |read_error| switch (read_error) {
                error.FileNotFound => null,
                error.StreamTooLong => return error.InsightsSpoolTooLarge,
                else => return read_error,
            };
            if (old) |bytes| {
                defer a.free(bytes);
                if (std.mem.startsWith(u8, bytes, magic)) {
                    // The first writer can publish its key and spool after
                    // our initial missing-key observation. Recheck before
                    // classifying an otherwise valid concurrent launch as a
                    // lost-key recovery case.
                    break :blk readKey(a, io, key_path) catch |key_error| switch (key_error) {
                        error.FileNotFound => return error.InsightsSpoolKeyMissing,
                        else => return key_error,
                    };
                }
            }
            var candidate: [Cipher.key_length]u8 = undefined;
            io.random(&candidate);
            defer std.crypto.secureZero(u8, &candidate);
            writeAtomic(io, key_path, &candidate, false) catch |write_error| switch (write_error) {
                error.PathAlreadyExists => {},
                else => return write_error,
            };
            // Another process may have created the key first. Always use the
            // complete winning key, never the losing random candidate.
            break :blk try readKey(a, io, key_path);
        },
        else => return err,
    };
}

fn writeAtomic(io: Io, path: []const u8, bytes: []const u8, replace: bool) !void {
    var file = try Io.Dir.cwd().createFileAtomic(io, path, .{
        .replace = replace,
        .permissions = if (builtin.os.tag == .windows) .default_file else .fromMode(0o600),
    });
    defer file.deinit(io);
    try file.file.writeStreamingAll(io, bytes);
    try file.file.sync(io);
    if (replace) try file.replace(io) else try file.link(io);
}

fn testPath(temp: *std.testing.TmpDir, filename: []const u8) ![]u8 {
    const directory = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(directory);
    return std.fs.path.join(std.testing.allocator, &.{ directory, filename });
}

test "encrypted state round trips, randomizes nonces, and preserves exclusive identities" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const io = std.testing.io;
    const path = try testPath(&temp, "identity.json");
    defer a.free(path);
    const payload = "{\"installationId\":\"install-id\",\"userId\":\"private-user\"}";
    try write(a, io, path, payload, payload.len, false);
    const first = try Io.Dir.cwd().readFileAlloc(io, path, a, .limited(4096));
    defer a.free(first);
    try std.testing.expect(std.mem.startsWith(u8, first, magic));
    try std.testing.expect(std.mem.indexOf(u8, first, "private-user") == null);
    const decoded = try read(a, io, path, payload.len);
    defer a.free(decoded);
    try std.testing.expectEqualStrings(payload, decoded);
    try std.testing.expectError(error.PathAlreadyExists, write(a, io, path, "{}", 4096, false));
    const unchanged = try read(a, io, path, 4096);
    defer a.free(unchanged);
    try std.testing.expectEqualStrings(payload, unchanged);
    try write(a, io, path, payload, payload.len, true);
    const second = try Io.Dir.cwd().readFileAlloc(io, path, a, .limited(4096));
    defer a.free(second);
    try std.testing.expect(!std.mem.eql(u8, first, second));
    if (builtin.os.tag != .windows) {
        const file = try Io.Dir.cwd().openFile(io, path, .{});
        defer file.close(io);
        try std.testing.expectEqual(@as(std.posix.mode_t, 0o600), (try file.stat(io)).permissions.toMode() & 0o777);
        const key_path = try std.fmt.allocPrint(a, "{s}.key", .{path});
        defer a.free(key_path);
        const key_file = try Io.Dir.cwd().openFile(io, key_path, .{});
        defer key_file.close(io);
        try std.testing.expectEqual(@as(std.posix.mode_t, 0o600), (try key_file.stat(io)).permissions.toMode() & 0o777);
    }
}

test "ciphertext, nonce, key, version and truncated envelopes fail without plaintext fallback" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const io = std.testing.io;
    const path = try testPath(&temp, "queue.json");
    defer a.free(path);
    const key_path = try std.fmt.allocPrint(a, "{s}.key", .{path});
    defer a.free(key_path);
    try write(a, io, path, "{\"events\":[1]}", 4096, true);
    const original = try Io.Dir.cwd().readFileAlloc(io, path, a, .limited(4096));
    defer a.free(original);
    const bytes = try a.dupe(u8, original);
    defer a.free(bytes);
    for ([_]usize{ aad_len, header_len, bytes.len - 1 }) |offset| {
        @memcpy(bytes, original);
        bytes[offset] ^= 1;
        try writeAtomic(io, path, bytes, true);
        try std.testing.expectError(error.AuthenticationFailed, read(a, io, path, 4096));
    }
    @memcpy(bytes, original);
    bytes[magic.len] = 99;
    try writeAtomic(io, path, bytes, true);
    try std.testing.expectError(error.UnsupportedInsightsSpoolVersion, read(a, io, path, 4096));
    try writeAtomic(io, path, original[0..header_len], true);
    try std.testing.expectError(error.InvalidInsightsSpool, read(a, io, path, 4096));
    try writeAtomic(io, path, "EBINSQ", true);
    try std.testing.expectError(error.InvalidInsightsSpool, read(a, io, path, 4096));
    try writeAtomic(io, path, original, true);
    try writeAtomic(io, key_path, &std.mem.zeroes([Cipher.key_length]u8), true);
    try std.testing.expectError(error.AuthenticationFailed, read(a, io, path, 4096));
    try writeAtomic(io, key_path, "short", true);
    try std.testing.expectError(error.InvalidInsightsSpoolKey, read(a, io, path, 4096));
    try std.testing.expectError(error.InvalidInsightsSpoolKey, write(a, io, path, "{}", 4096, true));
    try Io.Dir.cwd().deleteFile(io, key_path);
    try std.testing.expectError(error.FileNotFound, read(a, io, path, 4096));
    try std.testing.expectError(error.InsightsSpoolKeyMissing, write(a, io, path, "{}", 4096, true));
}

test "legacy JSON migrates without changing plaintext or key and obeys independent size bounds" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const io = std.testing.io;
    const path = try testPath(&temp, "queue.json");
    defer a.free(path);
    for ([_][]const u8{ " []\n", "{\"version\":1,\"events\":[]}" }) |legacy| {
        try writeAtomic(io, path, legacy, true);
        const plaintext = try read(a, io, path, legacy.len);
        defer a.free(plaintext);
        try std.testing.expectEqualStrings(legacy, plaintext);
        try std.testing.expectError(error.InsightsSpoolTooLarge, read(a, io, path, legacy.len - 1));
        try write(a, io, path, plaintext, legacy.len, true);
        const restored = try read(a, io, path, legacy.len);
        defer a.free(restored);
        try std.testing.expectEqualStrings(legacy, restored);
        try std.testing.expectError(error.InsightsSpoolTooLarge, read(a, io, path, legacy.len - 1));
        try std.testing.expectError(error.InsightsSpoolTooLarge, write(a, io, path, legacy, legacy.len - 1, true));
    }
    try std.testing.expectError(error.InsightsSpoolTooLarge, read(a, io, path, std.math.maxInt(usize)));
    try writeAtomic(io, path, "{broken-json", true);
    try std.testing.expectError(error.InvalidInsightsSpool, read(a, io, path, 4096));
}
