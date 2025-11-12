const std = @import("std");
const bsdiff = @import("bsdiff.zig");
const bspatch = @import("bspatch.zig");

const Header = std.tar.output.Header;
const block_size: usize = 512;

const FileSpec = struct {
    path: []const u8,
    contents: []const u8,
};

const originalSpecs = [_]FileSpec{
    .{
        .path = "co(lab)-canary/app/notes.txt",
        .contents =
        \\Alpha
        \\Beta
        \\Gamma
        \\Delta
        ,
    },
    .{
        .path = "co(lab)-canary/app/config/settings.json",
        .contents =
        \\{
        \\  "theme": "dark",
        \\  "autosave": true,
        \\  "fontSize": 14
        \\}
        ,
    },
    .{
        .path = "co(lab)-canary/app/bin/runner",
        .contents = "chunk-a\nchunk-b\nchunk-c\n",
    },
};

const updatedSpecs = [_]FileSpec{
    .{
        .path = "co(lab)-canary/app/notes.txt",
        .contents =
        \\Alpha
        \\Beta
        \\Gamma
        \\Echo
        ,
    },
    .{
        .path = "co(lab)-canary/app/config/settings.json",
        .contents =
        \\{
        \\  "theme": "light",
        \\  "autosave": false,
        \\  "fontSize": 16
        \\}
        ,
    },
    .{
        .path = "co(lab)-canary/app/bin/runner",
        .contents = "chunk-a\nchunk-b\nchunk-d\n",
    },
    .{
        .path = "co(lab)-canary/app/README.md",
        .contents = "# Release Notes\nThis file was added in the update.\n",
    },
};

test "bsdiff/bspatch roundtrip across tar archives" {
    try runRoundTripPatch(true);
}

fn runRoundTripPatch(useZstd: bool) !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();

    const allocator = arena.allocator();

    const originalTar = try buildTarArchive(allocator, originalSpecs[0..]);
    const updatedTar = try buildTarArchive(allocator, updatedSpecs[0..]);

    var allocator_handle = allocator;
    const patch = try bsdiff.calculateDifferences(&allocator_handle, originalTar, updatedTar, useZstd);

    allocator_handle = allocator;
    const patchedTar = try bspatch.applyPatch(&allocator_handle, originalTar, patch);

    try std.testing.expectEqualSlices(u8, updatedTar, patchedTar);
}

fn buildTarArchive(allocator: std.mem.Allocator, specs: []const FileSpec) ![]u8 {
    var buffer = std.ArrayList(u8).init(allocator);
    defer buffer.deinit();

    var writer = buffer.writer();

    for (specs) |spec| {
        var header = Header.init();
        try setName(&header, spec.path);
        try writeOctal7(header.mode[0..header.mode.len], 0o644);
        try writeOctal7(header.uid[0..header.uid.len], 0);
        try writeOctal7(header.gid[0..header.gid.len], 0);
        try header.setSize(spec.contents.len);
        try writeOctal11(header.mtime[0..header.mtime.len], 0);
        header.typeflag = .regular;
        try header.updateChecksum();

        try writer.writeAll(std.mem.asBytes(&header));
        try writer.writeAll(spec.contents);

        const remainder = spec.contents.len % block_size;
        const padding = if (remainder == 0) 0 else block_size - remainder;
        if (padding > 0) {
            try writer.writeByteNTimes(0, padding);
        }
    }

    try writer.writeByteNTimes(0, block_size * 2);

    return buffer.toOwnedSlice();
}

fn setName(header: *Header, name: []const u8) !void {
    if (name.len > header.name.len) return error.PathTooLong;
    @memset(header.name[0..], 0);
    @memcpy(header.name[0..name.len], name);
}

fn writeOctal7(buffer: []u8, value: u64) !void {
    if (buffer.len < 7) return error.BufferTooSmall;
    _ = try std.fmt.bufPrint(buffer[0..7], "{o:0>7}", .{value});
}

fn writeOctal11(buffer: []u8, value: u64) !void {
    if (buffer.len < 11) return error.BufferTooSmall;
    _ = try std.fmt.bufPrint(buffer[0..11], "{o:0>11}", .{value});
}
