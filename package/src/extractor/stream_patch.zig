// Copyright 2003-2005 Colin Percival
// Copyright 2024 Yoav Givati
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR IMPLIED
// WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
// EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
// OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
// WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
// OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED
// OF THE POSSIBILITY OF SUCH DAMAGE.

//! Bounded-memory reader for blackboardsh/zig-bsdiff's TRDIFF10 format.
//! The old data must remain immutable until `apply` returns. The destination
//! must be a temporary file or another unpublished sink: errors can occur after
//! output has been written. Authenticate the patch and verify the target digest
//! before publishing. No entire old file, new file, or patch is allocated.
const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const zstd = std.compress.zstd;

pub const max_window_bytes = zstd.default_window_len;
const chunk_bytes = 64 * 1024;

/// A virtual archive can implement this callback without materializing a tar.
/// The callback must fill the entire destination, or return an error.
pub const Source = struct {
    context: *anyopaque,
    size: u64,
    read_at: *const fn (context: *anyopaque, offset: u64, destination: []u8) anyerror!void,
};

const FileSource = struct {
    io: Io,
    file: Io.File,

    fn readAt(context: *anyopaque, offset: u64, destination: []u8) !void {
        const self: *FileSource = @ptrCast(@alignCast(context));
        if (try self.file.readPositionalAll(self.io, destination, offset) != destination.len)
            return error.TruncatedPatchSource;
    }
};

const Header = struct {
    control_len: u64,
    diff_len: u64,
    new_size: u64,
    file_size: u64,

    fn read(io: Io, file: Io.File) !Header {
        const size = (try file.stat(io)).size;
        if (size < 32) return error.CorruptPatch;
        var bytes: [32]u8 = undefined;
        if (try file.readPositionalAll(io, &bytes, 0) != bytes.len)
            return error.CorruptPatch;
        if (!std.mem.eql(u8, bytes[0..8], "TRDIFF10")) return error.CorruptPatch;
        const control = signedOffset(bytes[8..16]);
        const diff = signedOffset(bytes[16..24]);
        const new = signedOffset(bytes[24..32]);
        if (control < 0 or diff < 0 or new < 0) return error.CorruptPatch;
        const control_len: u64 = @intCast(control);
        const diff_len: u64 = @intCast(diff);
        if (control_len > size - 32 or diff_len > size - 32 - control_len)
            return error.CorruptPatch;
        return .{ .control_len = control_len, .diff_len = diff_len, .new_size = @intCast(new), .file_size = size };
    }
};

/// Inspect before calling `apply` to enforce the authenticated target's size.
pub fn outputSize(io: Io, patch_file: Io.File) !u64 {
    return (try Header.read(io, patch_file)).new_size;
}

pub fn apply(allocator: Allocator, io: Io, patch_file: Io.File, old_file: Io.File, old_size: u64, output: *Io.Writer) !u64 {
    var context: FileSource = .{ .io = io, .file = old_file };
    return applySource(allocator, io, patch_file, .{
        .context = &context,
        .size = old_size,
        .read_at = FileSource.readAt,
    }, output);
}

pub const MemorySource = struct {
    bytes: []const u8,

    pub fn source(self: *MemorySource) Source {
        return .{ .context = self, .size = self.bytes.len, .read_at = readAt };
    }

    fn readAt(context: *anyopaque, offset: u64, destination: []u8) !void {
        const self: *MemorySource = @ptrCast(@alignCast(context));
        if (offset > self.bytes.len or destination.len > self.bytes.len - offset)
            return error.TruncatedPatchSource;
        @memcpy(destination, self.bytes[@intCast(offset)..][0..destination.len]);
    }
};

pub fn applySource(allocator: Allocator, io: Io, patch_file: Io.File, source: Source, output: *Io.Writer) !u64 {
    var reader: PatchReader = undefined;
    try reader.init(allocator, io, patch_file, source);
    defer reader.deinit();
    _ = reader.interface.streamRemaining(output) catch |err| {
        if (err == error.ReadFailed) return reader.err orelse error.CorruptPatch;
        return err;
    };
    return reader.new_position;
}

/// Pull interface for directly feeding a tar extractor. The address must remain
/// stable between init and deinit. Consume through EOF, even if the tar parser
/// stops at its end markers, to validate every block and checksum. `finished`
/// becomes true only after successful EOF validation; `err` contains a detailed
/// error when the Io.Reader interface reports ReadFailed.
pub const PatchReader = struct {
    allocator: Allocator,
    io: Io,
    source: Source,
    header: Header,
    control: Block,
    diff: Block,
    extra: Block,
    interface: Io.Reader,
    output_buffer: [chunk_bytes]u8,
    old_buffer: [chunk_bytes]u8,
    old_position: i64,
    new_position: u64,
    diff_remaining: u64,
    extra_remaining: u64,
    pending_seek: ?i64,
    triples: u64,
    finished: bool,
    err: ?anyerror,

    pub fn init(self: *PatchReader, allocator: Allocator, io: Io, patch_file: Io.File, source: Source) !void {
        const header = try Header.read(io, patch_file);
        if (source.size > std.math.maxInt(i64)) return error.PatchSourceTooLarge;
        self.allocator = allocator;
        self.io = io;
        self.source = source;
        self.header = header;
        self.old_position = 0;
        self.new_position = 0;
        self.diff_remaining = 0;
        self.extra_remaining = 0;
        self.pending_seek = null;
        self.triples = 0;
        self.finished = false;
        self.err = null;
        const diff_start = 32 + header.control_len;
        const extra_start = diff_start + header.diff_len;
        try self.control.init(allocator, io, patch_file, 32, header.control_len);
        errdefer self.control.deinit(allocator);
        try self.diff.init(allocator, io, patch_file, diff_start, header.diff_len);
        errdefer self.diff.deinit(allocator);
        try self.extra.init(allocator, io, patch_file, extra_start, header.file_size - extra_start);
        self.interface = .{
            .vtable = &.{ .stream = stream, .readVec = readVec },
            .buffer = &self.output_buffer,
            .seek = 0,
            .end = 0,
        };
    }

    pub fn deinit(self: *PatchReader) void {
        self.control.deinit(self.allocator);
        self.diff.deinit(self.allocator);
        self.extra.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn expectedSize(self: *const PatchReader) u64 {
        return self.header.new_size;
    }

    fn stream(reader: *Io.Reader, _: *Io.Writer, _: Io.Limit) Io.Reader.StreamError!usize {
        return fill(reader);
    }

    fn readVec(reader: *Io.Reader, _: [][]u8) Io.Reader.Error!usize {
        return fill(reader);
    }

    fn fill(reader: *Io.Reader) Io.Reader.Error!usize {
        const self: *PatchReader = @fieldParentPtr("interface", reader);
        if (self.err != null) return error.ReadFailed;
        // peek/take can request contiguous bytes across diff/literal records
        // while a suffix is still unread. Append without discarding that tail.
        const unread = reader.end - reader.seek;
        std.debug.assert(unread < reader.buffer.len);
        @memmove(reader.buffer[0..unread], reader.buffer[reader.seek..reader.end]);
        reader.seek = 0;
        reader.end = unread;
        const count = self.next(reader.buffer[unread..]) catch |err| {
            self.err = err;
            return error.ReadFailed;
        };
        if (count == 0) return error.EndOfStream;
        reader.end += count;
        return 0;
    }

    fn next(self: *PatchReader, destination: []u8) !usize {
        if (self.finished) return 0;
        while (true) {
            try self.io.checkCancel();
            if (self.diff_remaining > 0) {
                const count: usize = @intCast(@min(self.diff_remaining, destination.len));
                const output = destination[0..count];
                const old = self.old_buffer[0..count];
                try self.diff.readAll(output);
                @memset(old, 0);
                // BSDiff defines bytes outside the original file as zero. Use
                // widened arithmetic so negative seeks and large sizes do not wrap.
                const begin: i128 = self.old_position;
                const end = begin + count;
                const valid_begin = @max(begin, 0);
                const valid_end = @min(end, self.source.size);
                if (valid_begin < valid_end) {
                    const from: usize = @intCast(valid_begin - begin);
                    const to: usize = @intCast(valid_end - begin);
                    try self.source.read_at(self.source.context, @intCast(valid_begin), old[from..to]);
                }
                for (output, old) |*byte, old_byte| byte.* +%= old_byte;
                self.old_position = std.math.add(i64, self.old_position, @intCast(count)) catch return error.CorruptPatch;
                self.diff_remaining -= count;
                self.new_position += count;
                return count;
            }
            if (self.extra_remaining > 0) {
                const count: usize = @intCast(@min(self.extra_remaining, destination.len));
                try self.extra.readAll(destination[0..count]);
                self.extra_remaining -= count;
                self.new_position += count;
                return count;
            }
            if (self.pending_seek) |seek| {
                self.old_position = std.math.add(i64, self.old_position, seek) catch return error.CorruptPatch;
                self.pending_seek = null;
            }
            var bytes: [24]u8 = undefined;
            const count = try self.control.read(&bytes);
            if (count == 0) {
                if (self.new_position != self.header.new_size) return error.CorruptPatch;
                try self.control.finish();
                try self.diff.finish();
                try self.extra.finish();
                self.finished = true;
                return 0;
            }
            if (count != bytes.len) return error.CorruptPatch;
            self.triples += 1;
            // zig-bsdiff can emit a seek-only triple before a data triple. Bound
            // compressed zero-progress runs without scaling memory with output.
            if (self.triples > self.header.new_size *| 2 +| 1024) return error.CorruptPatch;
            const diff_signed = signedOffset(bytes[0..8]);
            const extra_signed = signedOffset(bytes[8..16]);
            if (diff_signed < 0 or extra_signed < 0) return error.CorruptPatch;
            self.diff_remaining = @intCast(diff_signed);
            self.extra_remaining = @intCast(extra_signed);
            if (self.diff_remaining > self.header.new_size - self.new_position) return error.CorruptPatch;
            if (self.extra_remaining > self.header.new_size - self.new_position - self.diff_remaining) return error.CorruptPatch;
            self.pending_seek = signedOffset(bytes[16..24]);
        }
    }
};

/// Each compressed block is exactly one Zstd frame, as emitted by zig-bsdiff.
/// Validate the envelope before output so concatenated/skippable frames and
/// bytes outside a block can never be accepted as its compressed payload.
const FrameInfo = struct {
    window_size: u32,
    checksum: ?u32,
};

fn inspectFrame(io: Io, file: Io.File, offset: u64, length: u64) !FrameInfo {
    var source_buffer: [4096]u8 = undefined;
    var source = file.reader(io, &source_buffer);
    try source.seekTo(offset);
    var limit_buffer: [64]u8 = undefined;
    var limited = source.interface.limited(.limited64(length), &limit_buffer);
    const reader = &limited.interface;
    if ((reader.takeInt(u32, .little) catch return error.CorruptPatch) != 0xfd2fb528)
        return error.CorruptPatch;
    const header = zstd.Decompress.Frame.Zstandard.Header.decode(reader) catch return error.CorruptPatch;
    if (header.dictionary_id != null) return error.UnsupportedPatchDictionary;
    const window_size = header.windowSize() orelse return error.CorruptPatch;
    if (window_size > max_window_bytes) return error.PatchWindowTooLarge;
    while (true) {
        try io.checkCancel();
        const block = reader.takeStruct(zstd.Decompress.Frame.Zstandard.Block.Header, .little) catch return error.CorruptPatch;
        if (block.size > zstd.block_size_max or block.size > window_size)
            return error.CorruptPatch;
        const payload_size: u64 = switch (block.type) {
            .raw, .compressed => block.size,
            .rle => 1,
            .reserved => return error.CorruptPatch,
        };
        reader.discardAll64(payload_size) catch return error.CorruptPatch;
        if (block.last) break;
    }
    const checksum: ?u32 = if (header.descriptor.content_checksum_flag)
        reader.takeInt(u32, .little) catch return error.CorruptPatch
    else
        null;
    var byte: [1]u8 = undefined;
    if ((reader.readSliceShort(&byte) catch return error.CorruptPatch) != 0)
        return error.CorruptPatch;
    if (source.logicalPos() != offset + length) return error.CorruptPatch;
    return .{ .window_size = @intCast(window_size), .checksum = checksum };
}

const Block = struct {
    source_buffer: [16 * 1024]u8,
    limit_buffer: [512]u8,
    source: Io.File.Reader,
    limited: Io.Reader.Limited,
    decoder: zstd.Decompress,
    window: []u8,
    checksum: ?u32,
    hasher: std.hash.XxHash64,

    fn init(self: *Block, allocator: Allocator, io: Io, file: Io.File, offset: u64, length: u64) !void {
        const info = try inspectFrame(io, file, offset, length);
        self.window = try allocator.alloc(u8, @as(usize, info.window_size) + zstd.block_size_max);
        errdefer allocator.free(self.window);
        self.source = file.reader(io, &self.source_buffer);
        try self.source.seekTo(offset);
        self.limited = self.source.interface.limited(.limited64(length), &self.limit_buffer);
        // The stdlib's verify_checksum=true currently panics. Hash every byte
        // consumed here and compare with the envelope's checksum in finish().
        self.decoder = .init(&self.limited.interface, self.window, .{ .window_len = info.window_size, .verify_checksum = false });
        self.checksum = info.checksum;
        self.hasher = .init(0);
    }

    fn deinit(self: *Block, allocator: Allocator) void {
        allocator.free(self.window);
    }

    fn read(self: *Block, bytes: []u8) !usize {
        const count = self.decoder.reader.readSliceShort(bytes) catch return error.CorruptPatch;
        self.hasher.update(bytes[0..count]);
        return count;
    }

    fn readAll(self: *Block, bytes: []u8) !void {
        if (try self.read(bytes) != bytes.len) return error.CorruptPatch;
    }

    fn finish(self: *Block) !void {
        var byte: [1]u8 = undefined;
        if (try self.read(&byte) != 0) return error.CorruptPatch;
        if (self.checksum) |expected| {
            if (@as(u32, @truncate(self.hasher.final())) != expected)
                return error.PatchChecksumMismatch;
        }
    }
};

fn signedOffset(bytes: *const [8]u8) i64 {
    const raw = std.mem.readInt(u64, bytes, .little);
    const magnitude: i64 = @intCast(raw & std.math.maxInt(i64));
    return if (raw >> 63 != 0) -magnitude else magnitude;
}

fn writeOffset(value: i64, bytes: *[8]u8) void {
    const magnitude: u64 = @intCast(if (value < 0) -value else value);
    std.mem.writeInt(u64, bytes, magnitude | (if (value < 0) @as(u64, 1) << 63 else 0), .little);
}

const Triple = [3]i64;

fn testFrame(allocator: Allocator, bytes: []const u8, checksum: bool) ![]u8 {
    var writer: Io.Writer.Allocating = .init(allocator);
    defer writer.deinit();
    try writer.writer.writeAll("\x28\xb5\x2f\xfd");
    // Non-single-segment, 128 KiB window, no pledged size.
    try writer.writer.writeAll(&.{ if (checksum) 4 else 0, 56 });
    var offset: usize = 0;
    while (true) {
        const count = @min(bytes.len - offset, zstd.block_size_max);
        const last = offset + count == bytes.len;
        try writer.writer.writeInt(u24, @as(u24, @intCast(count)) << 3 | @as(u24, @intFromBool(last)), .little);
        try writer.writer.writeAll(bytes[offset..][0..count]);
        offset += count;
        if (last) break;
    }
    if (checksum) try writer.writer.writeInt(u32, @truncate(std.hash.XxHash64.hash(0, bytes)), .little);
    return writer.toOwnedSlice();
}

fn testPatch(allocator: Allocator, triples: []const Triple, diff: []const u8, extra: []const u8, new_size: u64, checksum: bool) ![]u8 {
    const control_bytes = try allocator.alloc(u8, triples.len * 24);
    defer allocator.free(control_bytes);
    for (triples, 0..) |triple, i| {
        for (triple, 0..) |value, j| writeOffset(value, control_bytes[i * 24 + j * 8 ..][0..8]);
    }
    const control_frame = try testFrame(allocator, control_bytes, checksum);
    defer allocator.free(control_frame);
    const diff_frame = try testFrame(allocator, diff, checksum);
    defer allocator.free(diff_frame);
    const extra_frame = try testFrame(allocator, extra, checksum);
    defer allocator.free(extra_frame);
    const patch = try allocator.alloc(u8, 32 + control_frame.len + diff_frame.len + extra_frame.len);
    @memcpy(patch[0..8], "TRDIFF10");
    writeOffset(@intCast(control_frame.len), patch[8..16]);
    writeOffset(@intCast(diff_frame.len), patch[16..24]);
    writeOffset(@intCast(new_size), patch[24..32]);
    @memcpy(patch[32..][0..control_frame.len], control_frame);
    @memcpy(patch[32 + control_frame.len ..][0..diff_frame.len], diff_frame);
    @memcpy(patch[32 + control_frame.len + diff_frame.len ..], extra_frame);
    return patch;
}

fn testApply(allocator: Allocator, old: []const u8, patch: []const u8) ![]u8 {
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(io, .{ .sub_path = "old", .data = old });
    try tmp.dir.writeFile(io, .{ .sub_path = "patch", .data = patch });
    const old_file = try tmp.dir.openFile(io, "old", .{});
    defer old_file.close(io);
    const patch_file = try tmp.dir.openFile(io, "patch", .{});
    defer patch_file.close(io);
    var output: Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    const count = try apply(allocator, io, patch_file, old_file, old.len, &output.writer);
    try std.testing.expectEqual(count, output.written().len);
    return output.toOwnedSlice();
}

test "stream patch combines diff and literals with backward seeks" {
    const allocator = std.testing.allocator;
    const patch = try testPatch(allocator, &.{ .{ 3, 2, -3 }, .{ 3, 0, 0 } }, &.{ 1, 0, 255, 0, 0, 0 }, "!?", 8, true);
    defer allocator.free(patch);
    const output = try testApply(allocator, "abc", patch);
    defer allocator.free(output);
    try std.testing.expectEqualStrings("bbb!?abc", output);
}

test "stream patch supports seek-only records and zero outside source" {
    const allocator = std.testing.allocator;
    const patch = try testPatch(allocator, &.{ .{ 0, 0, -2 }, .{ 6, 0, 0 } }, &.{ 65, 66, 0, 0, 67, 68 }, "", 6, false);
    defer allocator.free(patch);
    const output = try testApply(allocator, "xy", patch);
    defer allocator.free(output);
    try std.testing.expectEqualStrings("ABxyCD", output);
}

test "stream patch handles an empty target" {
    const allocator = std.testing.allocator;
    const patch = try testPatch(allocator, &.{}, "", "", 0, true);
    defer allocator.free(patch);
    const output = try testApply(allocator, "source", patch);
    defer allocator.free(output);
    try std.testing.expectEqual(@as(usize, 0), output.len);
}

test "stream patch rejects short headers and invalid lengths" {
    const allocator = std.testing.allocator;
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", "TRDIFF10"));
    const patch = try testPatch(allocator, &.{.{ 0, 1, 0 }}, "", "a", 1, false);
    defer allocator.free(patch);
    writeOffset(-1, patch[8..16]);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", patch));
    writeOffset(std.math.maxInt(i64), patch[8..16]);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", patch));
}

test "stream patch rejects truncated frames and checksums" {
    const allocator = std.testing.allocator;
    const patch = try testPatch(allocator, &.{.{ 0, 1, 0 }}, "", "a", 1, true);
    defer allocator.free(patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", patch[0 .. patch.len - 1]));
    patch[patch.len - 1] ^= 1;
    try std.testing.expectError(error.PatchChecksumMismatch, testApply(allocator, "", patch));
}

test "stream patch rejects unused decompressed bytes and wrong output size" {
    const allocator = std.testing.allocator;
    const extra_patch = try testPatch(allocator, &.{.{ 0, 1, 0 }}, "", "ab", 1, false);
    defer allocator.free(extra_patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", extra_patch));
    const diff_patch = try testPatch(allocator, &.{.{ 1, 0, 0 }}, "00", "", 1, false);
    defer allocator.free(diff_patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "x", diff_patch));
    const short_patch = try testPatch(allocator, &.{.{ 0, 1, 0 }}, "", "a", 2, false);
    defer allocator.free(short_patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", short_patch));
    writeOffset(0, short_patch[24..32]);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", short_patch));
}

test "stream patch rejects negative counts and overflowing signed seeks" {
    const allocator = std.testing.allocator;
    const negative_patch = try testPatch(allocator, &.{.{ -1, 1, 0 }}, "", "a", 1, false);
    defer allocator.free(negative_patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", negative_patch));
    const overflow_patch = try testPatch(allocator, &.{ .{ 0, 0, std.math.maxInt(i64) }, .{ 1, 0, 1 } }, "a", "", 1, false);
    defer allocator.free(overflow_patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", overflow_patch));
}

test "stream patch rejects concatenated frames and cross-block reads" {
    const allocator = std.testing.allocator;
    const patch = try testPatch(allocator, &.{.{ 0, 1, 0 }}, "", "a", 1, false);
    defer allocator.free(patch);
    const trailing = try testFrame(allocator, "", false);
    defer allocator.free(trailing);
    const concatenated = try std.mem.concat(allocator, u8, &.{ patch, trailing });
    defer allocator.free(concatenated);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", concatenated));
    writeOffset(signedOffset(patch[8..16]) + 1, patch[8..16]);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", patch));
}

test "stream patch pull reader uses an immutable memory source and validates EOF" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const patch = try testPatch(allocator, &.{ .{ 3, 2, -3 }, .{ 3, 0, 0 } }, &.{ 1, 0, 255, 0, 0, 0 }, "!?", 8, true);
    defer allocator.free(patch);
    try tmp.dir.writeFile(io, .{ .sub_path = "patch", .data = patch });
    const patch_file = try tmp.dir.openFile(io, "patch", .{});
    defer patch_file.close(io);
    var source: MemorySource = .{ .bytes = "abc" };
    var reader: PatchReader = undefined;
    try reader.init(allocator, io, patch_file, source.source());
    defer reader.deinit();
    try std.testing.expectEqual(@as(u64, 8), reader.expectedSize());
    for ("bbb!?abc") |expected| {
        try std.testing.expectEqual(expected, try reader.interface.takeByte());
    }
    try std.testing.expect(!reader.finished);
    try std.testing.expectError(error.EndOfStream, reader.interface.takeByte());
    try std.testing.expect(reader.finished);
    try std.testing.expect(reader.err == null);
}

test "stream patch pull reader preserves unread bytes across segment boundaries" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const bytes = try testPatch(allocator, &.{ .{ 3, 2, -3 }, .{ 3, 0, 0 } }, &.{ 1, 0, 255, 0, 0, 0 }, "!?", 8, true);
    defer allocator.free(bytes);
    try tmp.dir.writeFile(io, .{ .sub_path = "patch", .data = bytes });
    const patch_file = try tmp.dir.openFile(io, "patch", .{});
    defer patch_file.close(io);
    var source: MemorySource = .{ .bytes = "abc" };
    var reader: PatchReader = undefined;
    try reader.init(allocator, io, patch_file, source.source());
    defer reader.deinit();
    try std.testing.expectEqual(@as(u8, 'b'), try reader.interface.takeByte());
    // Refill with two unread diff bytes, then span literal bytes and the next
    // diff record. Byte-at-a-time and readSliceShort consumers miss this case.
    try std.testing.expectEqualStrings("bb!?a", try reader.interface.take(5));
    try std.testing.expectEqualStrings("bc", try reader.interface.take(2));
    try std.testing.expectError(error.EndOfStream, reader.interface.takeByte());
    try std.testing.expect(reader.finished);
    try std.testing.expect(reader.err == null);
}

test "stream patch is compatible with compressed output from zig-bsdiff 0.1.26" {
    const allocator = std.testing.allocator;
    // Produced by the published zig-bsdiff binary, using --use-zstd, from the
    // generated source/target below. Unlike raw-frame tests this exercises real
    // compressed control, diff, and extra blocks and an 8 MiB frame window.
    const hex = "54524449464631301d000000000000001200000000000000190002000000000028b52ffd0068a500008201040af01903eff2ff9174c914fff4311f070028b52ffd00684d000008000100fc7f1d080128b52ffd0068250900941173747265616d696e672064656c746120696e73657274696f6e07102132435c6d7e8f98a9bacbe4f50617203142536c7d8e9fa8b9cadbf4051627304152637c8d9eafb8c9daeb04152637405162738c9daebfc8d9eafb14253647506172839cadbecfd8e9fa0b2435465760718293acbdcedfe8f90a1b34455667708192a3bccddeeff8091a2b445566778091a2b3ccddeeff08192a3b5465768790a1b2c3dcedfe0f18293a4b64758697a0b1c2d3ecfd0e1f28394a5b748596a7b0c1d2e3fc0d1e2f38495a6b8495a6b7c0d1e2f30c1d2e3f48596a7b94a5b6c7d0e1f2031c2d3e4f58697a8ba4b5c6d7e0f102132c3d4e5f68798a9bb4c5d6e7f00112233c4d5e6f78899aabc4d5e6f7001122334c5d6e7f8899aabbd4e5f6010019fdfe017d4d01";
    var patch: [hex.len / 2]u8 = undefined;
    _ = try std.fmt.hexToBytes(&patch, hex);
    const old = try allocator.alloc(u8, 131072);
    defer allocator.free(old);
    for (old, 0..) |*byte, i| byte.* = @truncate(i * 17 + 3);
    const output = try testApply(allocator, old, &patch);
    defer allocator.free(output);
    const insertion = "streaming delta insertion";
    try std.testing.expectEqual(old.len + insertion.len, output.len);
    try std.testing.expectEqualSlices(u8, old[65536..], output[0..65536]);
    try std.testing.expectEqualStrings(insertion, output[65536..][0..insertion.len]);
    for (old[0..65536], output[65536 + insertion.len ..]) |before, after|
        try std.testing.expectEqual(before ^ 4, after);
}

test "stream patch consumes a large source and target within a fixed memory budget" {
    const allocator = std.testing.allocator;
    const io = std.testing.io;
    const target_size = 16 * 1024 * 1024;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    var control: [24]u8 = @splat(0);
    writeOffset(target_size, control[0..8]);
    const control_frame = try testFrame(allocator, &control, false);
    defer allocator.free(control_frame);
    const empty_frame = try testFrame(allocator, "", false);
    defer allocator.free(empty_frame);
    var diff_frame: Io.Writer.Allocating = .init(allocator);
    defer diff_frame.deinit();
    try diff_frame.writer.writeAll("\x28\xb5\x2f\xfd\x00\x38");
    for (0..target_size / zstd.block_size_max) |i| {
        const last: u24 = @intFromBool(i + 1 == target_size / zstd.block_size_max);
        try diff_frame.writer.writeInt(u24, zstd.block_size_max << 3 | 2 | last, .little);
        try diff_frame.writer.writeByte(0);
    }
    var header: [32]u8 = undefined;
    @memcpy(header[0..8], "TRDIFF10");
    writeOffset(@intCast(control_frame.len), header[8..16]);
    writeOffset(@intCast(diff_frame.written().len), header[16..24]);
    writeOffset(target_size, header[24..32]);
    const patch_file = try tmp.dir.createFile(io, "patch", .{ .read = true });
    defer patch_file.close(io);
    try patch_file.writeStreamingAll(io, &header);
    try patch_file.writeStreamingAll(io, control_frame);
    try patch_file.writeStreamingAll(io, diff_frame.written());
    try patch_file.writeStreamingAll(io, empty_frame);

    const PatternSource = struct {
        fn read(_: *anyopaque, _: u64, destination: []u8) !void {
            @memset(destination, 7);
        }
    };
    var context: u8 = 0;
    const budget = try allocator.alloc(u8, 1024 * 1024);
    defer allocator.free(budget);
    var fixed: std.heap.FixedBufferAllocator = .init(budget);
    var hash_writer: Io.Writer.Hashing(std.hash.XxHash64) = .initHasher(.init(0), &.{});
    try std.testing.expectEqual(target_size, try applySource(fixed.allocator(), io, patch_file, .{
        .context = &context,
        .size = target_size,
        .read_at = PatternSource.read,
    }, &hash_writer.writer));
    var expected: std.hash.XxHash64 = .init(0);
    const repeated: [chunk_bytes]u8 = @splat(7);
    for (0..target_size / repeated.len) |_| expected.update(&repeated);
    try std.testing.expectEqual(expected.final(), hash_writer.hasher.final());
}

test "stream patch bounds zero-progress control runs" {
    const allocator = std.testing.allocator;
    const triples = try allocator.alloc(Triple, 1025);
    defer allocator.free(triples);
    @memset(triples, .{ 0, 0, 0 });
    const patch = try testPatch(allocator, triples, "", "", 0, false);
    defer allocator.free(patch);
    try std.testing.expectError(error.CorruptPatch, testApply(allocator, "", patch));
}
