// Copyright 2003-2005 Colin Percival
// Copyright 2024 Yoav Givati
// All rights reserved
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted providing that the following conditions
// are met:
// 1. Redistributions of source code must retain the above copyright
//    notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
// IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
// OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
// HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
// STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
// IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

// Note: This is a modified version of bspatch.
// The goal is to leverage zig's vector and slice operations to speed up the patching process.
// Aside from a compatible port, exploration into an iteration on bsdiff patch file format, and patch
// generation to improve performance and compression ratios. Eg: using zstd, compressing all
// the blocks together, modern suffix sorting, and so on.

const std = @import("std");

const zstd = @cImport({
    @cInclude("zstd.h");
});

const vectorSize = std.simd.suggestVectorLength(u8) orelse 4;

pub fn main() !void {
    var allocator = std.heap.page_allocator;

    var args = try std.process.argsWithAllocator(allocator);

    defer args.deinit();

    // skip the first arg which is the program name
    _ = args.skip();

    const oldFilePath = args.next() orelse "";
    const newFilePath = args.next() orelse "";
    const patchFilePath = args.next() orelse "";

    if (oldFilePath.len == 0 or newFilePath.len == 0 or patchFilePath.len == 0) {
        std.debug.print("Usage: bsdiff <oldFilePath> <newFilePath> <patchFilePath>\n", .{});
        std.process.exit(1);
    }

    const oldFile = try std.fs.cwd().openFile(oldFilePath, .{ .mode = .read_only });
    defer oldFile.close();

    const oldFileSize = try oldFile.getEndPos();
    const oldFileBuff = try allocator.alloc(u8, oldFileSize);
    defer allocator.free(oldFileBuff);
    _ = try oldFile.readAll(oldFileBuff);

    const patchFile = try std.fs.cwd().openFile(patchFilePath, .{ .mode = .read_only });
    defer patchFile.close();

    const patchFileSize = try patchFile.getEndPos();
    const patchFileBuff = try allocator.alloc(u8, patchFileSize);
    defer allocator.free(patchFileBuff);
    _ = try patchFile.readAll(patchFileBuff);

    const newfile = try applyPatch(&allocator, oldFileBuff, patchFileBuff);

    const newFile = try std.fs.cwd().createFile(newFilePath, .{});
    defer newFile.close();

    _ = try newFile.writeAll(newfile);
}

fn applyPatch(allocator: *std.mem.Allocator, oldfile: []const u8, patch: []const u8) ![]u8 {
    const header = patch[0..32];
    var newfile = std.ArrayList(u8).init(allocator.*);

    // Header is
    //	0	8	"BSDIFF40" or "TSDIFF10" // The only difference in file format is bzip2 vs zstd compression of the blocks
    //	8	8	length of ctrl block  i64
    //	16	8	length of diff block  i64
    //	24	8	length of extra block i64
    // File is
    //  0	32	Header
    //  32	??	ctrl block  uncompresses to i64
    //  ??	??	diff block  uncompresses to i8
    //  ??	??	extra block uncompresses to u8

    // Check for appropriate magic
    if (std.mem.eql(u8, header[0..8], "TRDIFF10") == false) {
        std.debug.print("corrupt patch {s}\n", .{header[0..8].*});
        return error.CorruptPatch;
    }

    // Read lengths from header
    const controlLen = offtin(header[8..16]);
    const diffLen = offtin(header[16..24]);
    const newSize = offtin(header[24..32]);

    const controlStart: usize = 32;
    const diffStart: usize = controlStart + @as(usize, @intCast(controlLen));
    const extraStart: usize = diffStart + @as(usize, @intCast(diffLen));

    if (controlLen < 0 or diffLen < 0 or newSize < 0) {
        return error.CorruptPatch;
    }

    const controlBlockCompressed = patch[controlStart..@intCast(diffStart)];
    // The size of the decoded block is going to be <= the size of the new file.
    var controlBlockBuffer = try allocator.alloc(u8, @intCast(newSize));
    // const controlBlockDecodedLen = try std.compress.zstd.decompress.decode(controlBlockDecoded, patch[controlStart..@intCast(diffStart)], false);
    const controlBlockDecodedLength: usize = zstd.ZSTD_decompress(controlBlockBuffer.ptr, controlBlockBuffer.len, controlBlockCompressed.ptr, controlBlockCompressed.len);
    if (zstd.ZSTD_isError(controlBlockDecodedLength) != 0) {
        // Handle the error. ZSTD_getErrorName can provide a string describing the error
        const errorMsg = zstd.ZSTD_getErrorName(controlBlockDecodedLength);
        std.debug.print("Decompression error: {s}\n", .{errorMsg});
        std.process.exit(1);
    }
    const controlBlock = controlBlockBuffer[0..controlBlockDecodedLength];

    // diffblock
    const diffBlockCompressed = patch[diffStart..@intCast(extraStart)];
    // The size of the decoded block is going to be <= the size of the new file.
    var diffBlockBuffer = try allocator.alloc(u8, @intCast(newSize));
    const diffBlockDecodedLength: usize = zstd.ZSTD_decompress(diffBlockBuffer.ptr, diffBlockBuffer.len, diffBlockCompressed.ptr, diffBlockCompressed.len);
    if (zstd.ZSTD_isError(diffBlockDecodedLength) != 0) {
        // Handle the error. ZSTD_getErrorName can provide a string describing the error
        const errorMsg = zstd.ZSTD_getErrorName(diffBlockDecodedLength);
        std.debug.print("Decompression error: {s}\n", .{errorMsg});
        std.process.exit(1);
    }
    const diffBlock = diffBlockBuffer[0..diffBlockDecodedLength];

    // extrablock
    const extraBlockCompressed = patch[extraStart..];
    // The size of the decoded block is going to be <= the size of the new file.
    var extraBlockBuffer = try allocator.alloc(u8, @intCast(newSize));
    const extraBlockDecodedLength: usize = zstd.ZSTD_decompress(extraBlockBuffer.ptr, extraBlockBuffer.len, extraBlockCompressed.ptr, extraBlockCompressed.len);
    if (zstd.ZSTD_isError(extraBlockDecodedLength) != 0) {
        // Handle the error. ZSTD_getErrorName can provide a string describing the error
        const errorMsg = zstd.ZSTD_getErrorName(extraBlockDecodedLength);
        std.debug.print("Decompression error: {s}\n", .{errorMsg});
        std.process.exit(1);
    }
    const extraBlock = extraBlockBuffer[0..extraBlockDecodedLength];

    var controlpos: usize = 0;
    var diffpos: usize = 0;
    var extrapos: usize = 0;
    var oldpos: usize = 0;
    var newpos: usize = 0;

    while (controlpos < controlBlockDecodedLength) {
        // Read control data
        const readDiffBy: usize = @intCast(offtin(controlBlock[controlpos .. controlpos + 8]));
        controlpos += 8;
        const readExtraBy: usize = @intCast(offtin(controlBlock[controlpos .. controlpos + 8]));
        controlpos += 8;
        // Note: this can be negative, since we may seek backwards in the old file to use different data
        // for different parts of the file.
        const seekBy: i64 = offtin(controlBlock[controlpos .. controlpos + 8]);
        controlpos += 8;

        // Setup the diff slices
        const diffSlice = diffBlock[diffpos .. diffpos + readDiffBy];
        diffpos += readDiffBy;
        const oldSlice = oldfile[oldpos .. oldpos + readDiffBy];

        var i: usize = 0;

        while (i < diffSlice.len) {
            // Note: the overhead of padding the last vector actually makes it slower than
            // letting it iterate (tested on machine with vector size of 16)
            if (i + vectorSize <= diffSlice.len) {
                const oldVec: @Vector(vectorSize, u8) = oldSlice[i..][0..vectorSize].*;
                const diffVec: @Vector(vectorSize, u8) = diffSlice[i..][0..vectorSize].*;
                const resultVec = @addWithOverflow(oldVec, diffVec)[0];
                const resultArray: [vectorSize]u8 = resultVec;
                try newfile.appendSlice(&resultArray);
                i += vectorSize;
                continue;
            }

            // Vector overhead here requires vector size of 4 or greater to get any benefit
            // less than 4 actually slows it down.
            const vectorSize4 = 4;

            if (i + vectorSize4 <= diffSlice.len) {
                const oldVec: @Vector(vectorSize4, u8) = oldSlice[i..][0..vectorSize4].*;
                const diffVec: @Vector(vectorSize4, u8) = diffSlice[i..][0..vectorSize4].*;
                const resultVec = @addWithOverflow(oldVec, diffVec)[0];
                const resultArray: [vectorSize4]u8 = resultVec;
                try newfile.appendSlice(&resultArray);
                i += vectorSize4;
                continue;
            }

            // Note: The diff block can contain the difference between the byte in the old and new fle,
            // modulo 256. Technically you can just do oldByte + diffByte and it'll operate modulo 256
            // as well, and get the right result.
            // Running zig in release mode it'll ignore the integer overflow but in dev mode the "warning"
            // exits the program. Zig likes it when you declare your intention explicitely.
            // More lines of code, but also anyone looking at this can immediately see what's going on.
            // no hidden bullshit; which is nice. And I'm guessing the optimizer could generally use
            // more explicit code to optimize better. Had the c or go reference implementations had this,
            // it would have saved me time hunting down an obscure bug generating corrupt patches, and I
            // wouldn't have had to write such a long comment to get closure on how I spent the last 2 hours.
            const oldByte = oldSlice[i];
            const diffByte = diffSlice[i];
            const newByte: u8 = @addWithOverflow(diffByte, oldByte)[0];

            try newfile.append(newByte);
            i += 1;
        }

        const to = extrapos + readExtraBy;
        try newfile.appendSlice(extraBlock[extrapos..to]);

        extrapos += readExtraBy;

        oldpos = @intCast(@as(i64, @intCast(oldpos + readDiffBy)) + seekBy);
        newpos += readDiffBy + readExtraBy;
    }
    return newfile.items;
}

// offtin reads an int64 (little endian)
fn offtin(buf: []const u8) i64 {
    var y: i64 = 0;

    y = @as(i64, (@intCast(buf[7] & 0x7f)));
    y = y << 8 | @as(i64, (@intCast(buf[6])));
    y = y << 8 | @as(i64, (@intCast(buf[5])));
    y = y << 8 | @as(i64, (@intCast(buf[4])));
    y = y << 8 | @as(i64, (@intCast(buf[3])));
    y = y << 8 | @as(i64, (@intCast(buf[2])));
    y = y << 8 | @as(i64, (@intCast(buf[1])));
    y = y << 8 | @as(i64, (@intCast(buf[0])));

    if ((buf[7] & 0x80) != 0) {
        y = -y;
    }
    return y;
}
