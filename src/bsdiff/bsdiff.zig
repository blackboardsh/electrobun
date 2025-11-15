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

// Note: This is a modified version of bsdiff from Colin Percival.
// The goal is to move compression from bzip2 sections in the patch file to zstd for the whole patch file,
// explore other performance improvements leveraging zig, and potentially optimize for tar file diffing
// used by electrobun.

// todo:
// 1. implement qsufsort and split
// 2. implement search and matchlen
// 3. implement diffb
// 4. add wrapper that takes two absolute file paths and test creating patches
// 5. implement bspatch.zig
// 6. test applying a patch file with checksum
// 7. compare TRDIFF10 with zstd compression with bsdiff4.
// 8. create a cli interace that takes two file paths and creates a patch file
// 9. make build zig fast and small to compare sizes and perf and use in cli
// 10. consider making a standalone repo
const std = @import("std");
const builtin = @import("builtin");

const zstd = @cImport({
    @cInclude("zstd.h");
});

const vectorSize = std.simd.suggestVectorLength(u8) orelse 4;

// 1. create a bsdiff implementation that supports bzip2 classic bsdiff, and a mode that doesn't compress the patch file at all (so you can apply any compression to the whole file)
// since only the electrobun cli needs to compress the file size doesn't matter, we just need prebuilt binaries to electrobun build on different platforms
// 2. compile binaries for every target platform of bsdiff and bspatch with/without bzip2 compression.
// 2. the electrobun launcher will import the bzip-less bspatch.zig implementation and use the bspatch.zig directly in launcher.zig
// 4. the launcher will have an alternate mode to decompress a zstd file.
// 5. the cli will just use exec to run bsdiff against two tar files, it can do this in parallel to compare multiple versions at the same time.
// 6. the cli will then compress all the patch files with the zstd node library, also in parallel. support maybe the last 5 versions of the app. (configurable)
// 5. the electrobun bun api will call the launcher in the mode when it needs to decompress a zstd compressed patch file and apply it.

// 1. update bsdiff to take file path args instead of hardcoded
// 2. build bsdiff binary for arm and make it available to the cli
// 3. update electrobun cli to use bsdiff and the node zstd to generate patches in parallel by spawning multiple processes
// Note: patches don't contain all the information to create the old file from the new file, so the last x versions need to be kept and downloaded.
// 4. write the cli logic to download, generate patches, and create the artifacts folder
// 5. update the launcher binary to include zstd decompress and bspatch.zig directly.
// 6. create electrobun update api to check for updates, download, apply patches, and restart the app.

// 7. then later move bsdiff to its own repo, implement bzip backwards compatability, and a npm package with typescript wrapper.
pub fn main() !void {
    var allocator = std.heap.page_allocator;

    var args = try std.process.argsWithAllocator(allocator);

    defer args.deinit();

    // skip the first arg which is the program name
    _ = args.skip();

    const oldFilePath = args.next() orelse "";
    const newFilePath = args.next() orelse "";
    const patchFilePath = args.next() orelse "";
    // By default we compress the blocks with bzip2 to make patches compatible with
    // the original bsdiff implementation.
    // In electrobun we disable block compression and compress the whole patch file with zstd
    // in a separate process.
    const optionUseZstd = args.next() orelse "";
    const useZstd = std.mem.eql(u8, optionUseZstd, "--use-zstd");

    if (oldFilePath.len == 0 or newFilePath.len == 0 or patchFilePath.len == 0) {
        std.debug.print("Usage: bsdiff <oldFilePath> <newFilePath> <patchFilePath>\n", .{});
        std.debug.print("Usage: bsdiff <oldFilePath> <newFilePath> <patchFilePath> --use-zstd\n", .{});
        std.process.exit(1);
    }

    const oldFile = try std.fs.cwd().openFile(oldFilePath, .{ .mode = .read_only });
    defer oldFile.close();

    const oldFileSize = try oldFile.getEndPos();
    const oldFileBuff = try allocator.alloc(u8, oldFileSize);
    defer allocator.free(oldFileBuff);
    _ = try oldFile.readAll(oldFileBuff);

    const newFile = try std.fs.cwd().openFile(newFilePath, .{ .mode = .read_only });
    defer newFile.close();

    const newFileSize = try newFile.getEndPos();
    const newFileBuff = try allocator.alloc(u8, newFileSize);
    defer allocator.free(newFileBuff);
    _ = try newFile.readAll(newFileBuff);

    // Log SIMD capabilities    
    std.debug.print("SIMD Status:\n", .{});
    std.debug.print("  Vector size: {d} bytes\n", .{vectorSize});
    std.debug.print("  Platform: {s}\n", .{@tagName(builtin.target.cpu.arch)});
    std.debug.print("  SIMD support: {s}\n", .{if (vectorSize > 1) "enabled" else "disabled (fallback to scalar)"});
    std.debug.print("\n", .{});

    const patch = try calculateDifferences(&allocator, oldFileBuff, newFileBuff, useZstd);

    // Write the patch file, internal blocks compressed with bzip2
    const patchFile = try std.fs.cwd().createFile(patchFilePath, .{});
    defer patchFile.close();

    _ = try patchFile.writeAll(patch);
}

pub fn calculateDifferences(allocator: *std.mem.Allocator, oldData: []const u8, newData: []const u8, useZstd: bool) ![]u8 {
    if (!useZstd) {
        std.debug.print("Block compression with bzip2 not yet implemented.\n", .{});
    }

    // Start progress logging thread at the very beginning
    var progressRunning: bool = true;
    var progressPercent: f32 = 0.0;
    const progressThread = try std.Thread.spawn(.{}, logProgressPercent, .{ &progressRunning, &progressPercent, "Diffing" });

    // Allocate memory for the suffix array based on the length of the old data
    const suffixIndexes = try allocator.alloc(i64, oldData.len + 1);
    defer allocator.free(suffixIndexes);

    // Note: This is where a significant amount of time is spent in the diffing process
    // Todo: replace with a more modern suffix sort algorithm like libdivsufsort
    try qsufsortFast(allocator, suffixIndexes, oldData);

    const newsize = newData.len;
    const oldsize = oldData.len;

    var streamingBytes = true;
    // compression threads
    // control block - each triplet is 24 bytes, ensure minimum buffer size
    var controlBlockStreamOffset: usize = 0;
    var controlBlockStream = try allocator.alloc(u8, @max(newsize, 64 * 1024));
    var controlBlockInput = zstd.ZSTD_inBuffer{ .src = controlBlockStream.ptr, .size = 0, .pos = 0 };
    const controlBlockCompressed = try allocator.alloc(u8, zstd.ZSTD_compressBound(controlBlockStream.len));
    var controlBlockOutput = zstd.ZSTD_outBuffer{ .dst = controlBlockCompressed.ptr, .size = controlBlockCompressed.len, .pos = 0 };
    const controlBlockThread = try std.Thread.spawn(.{}, compressBlockStream, .{ &controlBlockInput, &controlBlockOutput, &streamingBytes });
    // diff block
    // var diffBlockStreamOffset: usize = 0;
    var diffBlockStream = try allocator.alloc(u8, newsize);
    var diffBlockInput = zstd.ZSTD_inBuffer{ .src = diffBlockStream.ptr, .size = 0, .pos = 0 };
    const diffBlockCompressed = try allocator.alloc(u8, zstd.ZSTD_compressBound(diffBlockStream.len));
    var diffBlockOutput = zstd.ZSTD_outBuffer{ .dst = diffBlockCompressed.ptr, .size = diffBlockCompressed.len, .pos = 0 };
    const diffBlockThread = try std.Thread.spawn(.{}, compressBlockStream, .{ &diffBlockInput, &diffBlockOutput, &streamingBytes });
    // extra block
    var extraBlockStream = try allocator.alloc(u8, newsize);
    var extraBlockInput = zstd.ZSTD_inBuffer{ .src = extraBlockStream.ptr, .size = 0, .pos = 0 };
    const extraBlockCompressed = try allocator.alloc(u8, zstd.ZSTD_compressBound(extraBlockStream.len));
    var extraBlockOutput = zstd.ZSTD_outBuffer{ .dst = extraBlockCompressed.ptr, .size = extraBlockCompressed.len, .pos = 0 };
    const extraBlockThread = try std.Thread.spawn(.{}, compressBlockStream, .{ &extraBlockInput, &extraBlockOutput, &streamingBytes });

    // Header is
    //	0	8	"BSDIFF40" or "TRDIFF10" // The only difference in file format is bzip2 vs zstd compression of the blocks
    //	8	8	length of ctrl block  i64
    //	16	8	length of diff block  i64
    //	24	8	length of extra block i64
    // File is
    //  0	32	Header
    //  32	??	ctrl block  uncompresses to i64
    //  ??	??	diff block  uncompresses to i8
    //  ??	??	extra block uncompresses to u8

    // Placeholder for the buffer used in offtout
    var buffer = [_]u8{0} ** 8;

    // Initialize variables for tracking positions and scores during the diffing process
    var scanIndex: i64 = 0;
    var matchLength: i64 = 0;
    var lastScanIndex: i64 = 0;
    var lastMatchPosition: i64 = 0;
    var lastOffset: i64 = 0;
    var matchScore: i64 = 0;
    var matchPosition: i64 = 0;

    // More variables for managing the diffing process
    var scoreCounter: i64 = 0;
    var forwardScore: i64 = 0;
    var forwardLength: i64 = 0;
    var backwardScore: i64 = 0;
    var backwardLength: i64 = 0;

    // Variables for handling overlaps in the diffing process
    var overlapLength: i64 = 0;
    var bestOverlapScore: i64 = 0;
    var bestOverlapLength: i64 = 0;

    // var controlBlockOffset: usize = 0;

    // Begin the main loop for calculating differences
    while (scanIndex < newsize) {
        // Update progress percentage for logging thread
        progressPercent = (@as(f32, @floatFromInt(scanIndex)) / @as(f32, @floatFromInt(newsize))) * 100.0;

        matchScore = 0;
        scanIndex += matchLength;
        scoreCounter = scanIndex;

        // Loop through newData, searching for matches in oldData
        while (scanIndex < newsize) {
            // Note: most of the time during the diffing phase is spend in search()
            matchLength = @intCast(search(suffixIndexes, oldData, newData[@intCast(scanIndex)..], 0, @intCast(oldsize), &matchPosition));

            // Increment matchScore based on direct matches between newData and shifted oldData
            while (scoreCounter < scanIndex + matchLength) {
                const currentScanPos = scoreCounter + lastOffset;
                if (currentScanPos < oldsize and oldData[@intCast(currentScanPos)] == newData[@intCast(scoreCounter)]) {
                    matchScore += 1;
                }
                scoreCounter += 1;
            }

            // Break conditions for optimizing the search process
            if (matchLength == matchScore and matchLength != 0) {
                break;
            }
            if (matchLength > matchScore + 8) {
                break;
            }
            if (scanIndex + lastOffset < oldsize and oldData[@intCast(scanIndex + lastOffset)] == newData[@intCast(scanIndex)]) {
                matchScore -= 1;
            }

            scanIndex += 1;
        }

        // After finding a match, calculate the forward and backward lengths for the diff and extra blocks
        if (matchLength != matchScore or scanIndex == newsize) {
            scoreCounter = 0;
            forwardScore = 0;
            forwardLength = 0;
            var i: i64 = 0;

            // Calculate forward length - how much data from the old file matches directly after the current position
            while (lastScanIndex + i < scanIndex and lastMatchPosition + i < oldsize) {
                if (oldData[@intCast(lastMatchPosition + i)] == newData[@intCast(lastScanIndex + i)]) {
                    scoreCounter += 1;
                }
                i += 1;
                if (scoreCounter * 2 - i > forwardScore * 2 - forwardLength) {
                    forwardScore = scoreCounter;
                    forwardLength = i;
                }
            }

            // Calculate backward length - similar to forward length but in the opposite direction
            backwardLength = 0;
            if (scanIndex < newsize) {
                scoreCounter = 0;
                backwardScore = 0;
                i = 1;
                while (scanIndex >= lastScanIndex + i and matchPosition >= i) {
                    if (oldData[@intCast(matchPosition - i)] == newData[@intCast(scanIndex - i)]) {
                        scoreCounter += 1;
                    }
                    if (scoreCounter * 2 - i > backwardScore * 2 - backwardLength) {
                        backwardScore = scoreCounter;
                        backwardLength = i;
                    }
                    i += 1;
                }
            }

            // Handle overlaps between forward and backward matches
            if (lastScanIndex + forwardLength > scanIndex - backwardLength) {
                overlapLength = (lastScanIndex + forwardLength) - (scanIndex - backwardLength);
                scoreCounter = 0;
                bestOverlapScore = 0;
                bestOverlapLength = 0;
                i = 0;

                while (i < overlapLength) {
                    if (newData[@intCast(lastScanIndex + forwardLength - overlapLength + i)] == oldData[@intCast(lastMatchPosition + forwardLength - overlapLength + i)]) {
                        scoreCounter += 1;
                    }

                    if (newData[@intCast(scanIndex - backwardLength + i)] == oldData[@intCast(matchPosition - backwardLength + i)]) {
                        scoreCounter -= 1;
                    }

                    if (scoreCounter > bestOverlapScore) {
                        bestOverlapScore = scoreCounter;
                        bestOverlapLength = i + 1;
                    }

                    i += 1;
                }

                forwardLength += bestOverlapLength - overlapLength;
                backwardLength -= bestOverlapLength;
            }

            i = 0;

            // Write the calculated diff and extra data to their respective blocks
            while (i < forwardLength) {
                // perf: use simd for calculations where possible
                if (i + vectorSize <= forwardLength) {
                    const oldpos: usize = @intCast(lastMatchPosition + i);
                    const newpos: usize = @intCast(lastScanIndex + i);
                    const diffpos: usize = @intCast(diffBlockInput.size + @as(usize, @intCast(i)));

                    const newVec: @Vector(vectorSize, u8) = newData[newpos..][0..vectorSize].*;
                    const oldVec: @Vector(vectorSize, u8) = oldData[oldpos..][0..vectorSize].*;
                    const resultVec = @subWithOverflow(newVec, oldVec)[0];
                    const resultArray: [vectorSize]u8 = resultVec;
                    @memcpy(diffBlockStream[diffpos..][0..vectorSize], &resultArray);

                    i += vectorSize;
                    continue;
                }

                const newByte: u8 = newData[@intCast(lastScanIndex + i)];
                const oldByte: u8 = oldData[@intCast(lastMatchPosition + i)];
                const diffByte: u8 = @subWithOverflow(newByte, oldByte)[0];

                diffBlockStream[@intCast(diffBlockInput.size + @as(usize, @intCast(i)))] = diffByte;

                i += 1;
            }

            i = 0;

            // Write extra data that doesn't match directly but needs to be added to the new data
            const newBytesAded = (scanIndex - backwardLength) - (lastScanIndex + forwardLength);

            // Note: Oddly doing a @memcpy here is significantly slower than a loop
            while (i < newBytesAded) {
                // extraBlock[@intCast(extraBlockInput.size + @as(usize, @intCast(i)))] = newData[@intCast(lastScanIndex + forwardLength + i)];
                extraBlockStream[@intCast(extraBlockInput.size + @as(usize, @intCast(i)))] = newData[@intCast(lastScanIndex + forwardLength + i)];
                i += 1;
            }

            const readDiffBy = forwardLength;
            const readExtraBy = newBytesAded;
            const seekBy = (matchPosition - backwardLength) - (lastMatchPosition + forwardLength);

            // Update lengths and control block information for the next iteration
            diffBlockInput.size += @intCast(readDiffBy);
            extraBlockInput.size += @intCast(readExtraBy);

            offtout(readDiffBy, controlBlockStream[controlBlockStreamOffset..][0..8]);
            controlBlockStreamOffset += 8;
            offtout(readExtraBy, controlBlockStream[controlBlockStreamOffset..][0..8]);
            controlBlockStreamOffset += 8;
            offtout(seekBy, controlBlockStream[controlBlockStreamOffset..][0..8]);
            controlBlockStreamOffset += 8;
            controlBlockInput.size = controlBlockStreamOffset;

            // Update positions for the next loop iteration
            lastScanIndex = scanIndex - backwardLength;
            lastMatchPosition = matchPosition - backwardLength;
            lastOffset = matchPosition - scanIndex;
        }
    }

    // Stop progress logging
    progressPercent = 100.0;
    progressRunning = false;
    progressThread.join();

    // Tell the compression threads to wrap up and wait for them
    streamingBytes = false;
    diffBlockThread.join();
    controlBlockThread.join();
    extraBlockThread.join();

    // Combine header, diffBlock, and extraBlock into a single byte slice to return
    const headerLength = 32;

    var patch = try allocator.alloc(u8, headerLength + controlBlockOutput.pos + diffBlockOutput.pos + extraBlockOutput.pos);
    // write the header compressed
    @memcpy(patch[0..8], "TRDIFF10");

    offtout(@intCast(controlBlockOutput.pos), &buffer);
    @memcpy(patch[8..16], &buffer);

    offtout(@intCast(diffBlockOutput.pos), &buffer);
    @memcpy(patch[16..24], &buffer);

    offtout(@intCast(newsize), &buffer);
    @memcpy(patch[24..32], &buffer);

    var patchFileOffset: usize = headerLength;
    @memcpy(patch[patchFileOffset..][0..controlBlockOutput.pos], controlBlockCompressed.ptr);
    patchFileOffset += controlBlockOutput.pos;

    @memcpy(patch[patchFileOffset..][0..diffBlockOutput.pos], diffBlockCompressed.ptr);
    patchFileOffset += diffBlockOutput.pos;

    @memcpy(patch[patchFileOffset..][0..extraBlockOutput.pos], extraBlockCompressed.ptr);
    patchFileOffset += extraBlockOutput.pos;

    const patchSizeMB = @as(f64, @floatFromInt(patch.len)) / (1024.0 * 1024.0);
    const compressionRatio = (@as(f64, @floatFromInt(patch.len)) / @as(f64, @floatFromInt(newData.len))) * 100.0;
    std.debug.print("Completed - Patch: {d:.2} MB ({d:.1}% of new size)\n", .{ patchSizeMB, compressionRatio });

    return patch;
}

var totalCompressedSize: usize = 0;

// Notes on Zstd:
// compressed output between single shot and streaming with a single frame is roughly the same.
// with a single frame zstd takes roughly 20% longer to compress the same data. but with streaming you can compress in parallel to the actual diffing in another thread.
fn compressBlock(allocator: *std.mem.Allocator, block: []const u8) !void {
    // non-streaming
    const maxCompressedSize = zstd.ZSTD_compressBound(block.len);
    const compressedBlock = try allocator.alloc(u8, maxCompressedSize);
    // defer allocator.free(compressedBlock);

    const compressedSize = zstd.ZSTD_compress(compressedBlock.ptr, compressedBlock.len, block.ptr, block.len, 22);
    totalCompressedSize += compressedSize;
    // return compressedSize;
    // return compressedBlock[0..compressedSize];
}

fn compressBlockStream(input: *zstd.ZSTD_inBuffer, output: *zstd.ZSTD_outBuffer, streamingBytes: *bool) !void {
    const cstream = zstd.ZSTD_createCStream();
    defer {
        _ = zstd.ZSTD_freeCStream(cstream);
    }

    // Note: Experimentally there's no significant difference between 19 and 22 with regard to compression output
    // creates smaller output at 19 than bzip2. However there is a huge time cost between 19 and 22, roughly 20% longer.
    // setting this to 22 the total bsdiff time matches the original bsdiff c implementation
    // setting this to 19 the total bsdiff time is roughly 20% faster than the original bsdiff c implementation
    // in both cases the output is roughly 10% smaller.
    // obviously this will vary based on the data being compressed.
    _ = zstd.ZSTD_initCStream(cstream, 19);

    while (streamingBytes.* or input.pos < input.size) {
        if (input.pos < input.size) {
            _ = zstd.ZSTD_compressStream(cstream, output, input);
        } else {
            std.time.sleep(std.time.ns_per_ms * 10);
        }
    }

    _ = zstd.ZSTD_endStream(cstream, output);
}

// offtout puts an int64 (little endian) to buf
fn offtout(x: i64, buf: []u8) void {
    var y: u64 = undefined;
    if (x < 0) {
        y = @as(u64, @bitCast(-x)) | 0x8000000000000000;
    } else {
        y = @as(u64, @bitCast(x));
    }

    buf[0] = @intCast(y & 0xFF);
    buf[1] = @intCast((y >> 8) & 0xFF);
    buf[2] = @intCast((y >> 16) & 0xFF);
    buf[3] = @intCast((y >> 24) & 0xFF);
    buf[4] = @intCast((y >> 32) & 0xFF);
    buf[5] = @intCast((y >> 40) & 0xFF);
    buf[6] = @intCast((y >> 48) & 0xFF);
    buf[7] = @intCast((y >> 56) & 0xFF);
}

/// Do a binary search to find the longest match of `newData` within `oldData` using precomputed suffixIndexes.
fn search(suffixIndexes: []i64, oldData: []const u8, newData: []const u8, from: usize, to: usize, bestMatchPosition: *i64) usize {
    var midPoint: usize = 0;
    var matchLength: usize = 0;
    const oldDataSize = oldData.len;
    const newDataSize = newData.len;
    const searchLength = to - from;

    // Base case: If the search range is less than 2, directly compare the matches at the start and end points.
    if (searchLength < 2) {
        midPoint = matchlenFast(oldData[@intCast(suffixIndexes[from])..], newData);
        matchLength = matchlenFast(oldData[@intCast(suffixIndexes[to])..], newData);

        if (midPoint > matchLength) {
            bestMatchPosition.* = suffixIndexes[from];
            return midPoint;
        }
        bestMatchPosition.* = suffixIndexes[to];
        return matchLength;
    }

    // Calculate the midpoint of the current search range.
    midPoint = from + @divTrunc((searchLength), 2);
    // Determine the length to compare based on the remaining length in `oldData` and the total length of `newData`.
    const compareLength = @min(oldDataSize - @as(usize, @intCast(suffixIndexes[midPoint])), newDataSize);
    const compareFrom: usize = @intCast(suffixIndexes[midPoint]);
    // Compare the substring of `oldData` starting from `compareStart` with the beginning of `newData`.
    const compareResult = compareSlicesFast(oldData[compareFrom .. compareFrom + compareLength], newData[0..compareLength]);

    // Recursively search in the half of the range where the comparison indicates the match might be found.
    if (compareResult < 0) {
        return search(suffixIndexes, oldData, newData, midPoint, to, bestMatchPosition);
    } else {
        return search(suffixIndexes, oldData, newData, from, midPoint, bestMatchPosition);
    }
}

fn compareSlicesOrig(a: []const u8, b: []const u8) i64 {
    const minSize = @min(a.len, b.len);
    // std.debug.print("minSize: {}\n", .{minSize});
    for (0..minSize) |i| {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }

    // If all compared elements are equal, decide based on length
    if (a.len < b.len) return -1;
    if (a.len > b.len) return 1;
    return 0;
}

// For two 48MB files doing lookaheads makes it about 6.5 seconds (30%) faster
// this is because for software updates the files are typically mostly the same
// and this function tends to compare large swaths of the file in one go as it
// bisects down
fn compareSlicesFast(a: []const u8, b: []const u8) i64 {
    const minSize = @min(a.len, b.len);
    var i: usize = 0;
    var lookAheadIndex: usize = 0;
    const lookAheadDistance: usize = 8;

    while (i < minSize) {
        if (i >= lookAheadIndex and i + lookAheadDistance < minSize) {
            while (i + lookAheadDistance < minSize) {
                lookAheadIndex = i + lookAheadDistance;

                const aSlice = a[i..lookAheadIndex];
                const bSlice = b[i..lookAheadIndex];

                const aSlicePointer: *const [8]u8 = @ptrCast(&aSlice[0]);
                const bSlicePointer: *const [8]u8 = @ptrCast(&bSlice[0]);

                const aAs64 = std.mem.readInt(u64, aSlicePointer, std.builtin.Endian.big);
                const bAs64 = std.mem.readInt(u64, bSlicePointer, std.builtin.Endian.big);

                if (aAs64 == bAs64) {
                    i = lookAheadIndex;
                } else {
                    break;
                }
            }
        }

        // perf: 0 and -1 tend to be most common, so check those first
        if (a[i] == b[i]) {
            i += 1;
            continue;
        } else if (a[i] < b[i]) {
            return -1;
        } else {
            return 1;
        }

        if (a[i] == b[i]) {
            i += 1;
            continue;
        } else if (a[i] < b[i]) {
            return -1;
        } else {
            return 1;
        }

        // i += 1;
        // std.debug.print("match: {}\n", .{i});
    }
    // If all compared elements are equal, decide based on length
    // perf: when used in the diffing algorithm search function
    // these tend to be equal when we get here, so check that first
    // this saves a surprising amount of time. for file diffs that take 20 seconds
    // with the c bsdiff, this saves about 500ms.
    if (a.len == b.len) {
        return 0;
    } else if (a.len < b.len) {
        return -1;
    } else {
        return 1;
    }
}

/// Calculates the length of the longest prefix match between two byte arrays using a lookahead optimization.
// in practice the total iterations using matchlenFast are around 16% of the total iterations needed by a brute force matchlen
// eg: diff did 297,101,075 total iterations instead of 1,852,824,342
// on m1 max it shaves about 4% off the total time when diffing two 48MB files
fn matchlenFast(oldData: []const u8, newData: []const u8) usize {
    var matchLength: usize = 0;
    var lookAheadIndex: usize = 0;
    // This works well with 8, you tend be able to skip more iteration loops and get more matches with 7
    // eg: in a 48MB file diff, you skip an additional 50 million iterations with 7 than with 8
    const lookAheadDistance: usize = 7;

    const oldsize = oldData.len;
    const newsize = newData.len;
    const minSize = @min(oldsize, newsize);

    while (matchLength < minSize) {
        // perf: Go faster by comparing 7 bytes at a time
        if (matchLength >= lookAheadIndex and matchLength + lookAheadDistance < minSize) {
            while (matchLength + lookAheadDistance < minSize) {
                lookAheadIndex = matchLength + lookAheadDistance;

                const oldSlice = oldData[matchLength..lookAheadIndex];
                const newSlice = newData[matchLength..lookAheadIndex];

                const oldSlicePointer: *const [7]u8 = @ptrCast(&oldSlice[0]);
                const newSlicePointer: *const [7]u8 = @ptrCast(&newSlice[0]);

                const oldAs56 = std.mem.readInt(u56, oldSlicePointer, std.builtin.Endian.big);
                const newAs56 = std.mem.readInt(u56, newSlicePointer, std.builtin.Endian.big);

                if (oldAs56 == newAs56) {
                    matchLength = lookAheadIndex;
                } else {
                    break;
                }
            }
        }

        if (oldData[matchLength] != newData[matchLength]) {
            break;
        }
        matchLength += 1;
    }
    return matchLength;
}

fn qsufsortFast(allocator: *std.mem.Allocator, suffixIndexes: []i64, buf: []const u8) !void {
    // perf: instead of creating a buckets array of 256 elements, and shifting them over one index back and forth in the alogirthm,
    // we can create a slightly longer array, and just reposition the slice which should be a bit faster

    var _buckets: [257]i64 = [_]i64{0} ** 257;
    var buckets = _buckets[1..];

    // inverse of the suffix array, sorted array of suffixes. indexes are suffixes sorted longest to shortest, values the index of the first character group in the sorted array
    const inverseSuffix = try allocator.alloc(i64, suffixIndexes.len);
    defer allocator.free(inverseSuffix);
    const bufzise = buf.len;
    const bufzisePlusOne: i64 = @intCast(buf.len + 1);
    var startTime = std.time.milliTimestamp();

    for (buf) |b| {
        buckets[b] += 1;
    }

    startTime = std.time.milliTimestamp();

    // looping up, set each element to the sum of the previous elements
    // bucket[1] = bucket[0] + bucket[1];
    // this effectively makes them the starting index of the next bucket
    for (1..256) |i| {
        buckets[i] += buckets[i - 1];
    }

    // looping down, shift each element one index to the right
    // bucket[255] = bucket[254];
    // then set bucket[0] = 0;
    buckets = _buckets[0..256];

    buckets[0] = 0;
    // incrementing each 'starting index' for each bucket to get the 'next index for that bucket'
    // use the index to set the position of each suffix
    for (buf, 0..) |b, i| {
        buckets[b] += 1;
        // Note: in zig array indexes are assumed to be usize, so we need to cast i64 to usize
        suffixIndexes[@intCast(buckets[@intCast(b)])] = @intCast(i);
    }
    // at this point we have the suffixes sorted by bucket

    startTime = std.time.milliTimestamp();
    suffixIndexes[0] = @intCast(bufzise);

    // create inverseSuffix that maps each suffix to the last index of
    // that suffix grouping in the semi-sorted array.
    for (buf, 0..) |b, i| {
        inverseSuffix[i] = buckets[b];
    }

    startTime = std.time.milliTimestamp();

    inverseSuffix[bufzise] = 0;

    for (1..256) |i| {
        if (buckets[i] == buckets[i - 1] + 1) {
            suffixIndexes[@intCast(buckets[i])] = -1;
        }
    }

    suffixIndexes[0] = -1;

    var h: i64 = 1;
    while (suffixIndexes[0] != -bufzisePlusOne) {
        var ln: i64 = 0;
        var i: i64 = 0;
        while (i < bufzisePlusOne) {
            const suffixIndexesI = suffixIndexes[@intCast(i)];
            if (suffixIndexesI < 0) {
                ln -= suffixIndexesI;
                i -= suffixIndexesI;
            } else {
                if (ln != 0) {
                    suffixIndexes[@intCast(i - ln)] = -ln;
                }
                ln = inverseSuffix[@intCast(suffixIndexesI)] + 1 - i;
                split(suffixIndexes, inverseSuffix, i, ln, h);
                i += ln;
                ln = 0;
            }
        }
        if (ln != 0) {
            suffixIndexes[@intCast(i - ln)] = -ln;
        }
        h += h;
    }

    startTime = std.time.milliTimestamp();

    for (0..buf.len) |i| {
        suffixIndexes[@intCast(inverseSuffix[@intCast(i)])] = @intCast(i);
    }

    startTime = std.time.milliTimestamp();

    suffixIndexes[0] = 0;
}

var swapTemp: i64 = 0;

fn split(suffixIndexes: []i64, inverseSuffix: []i64, start: i64, ln: i64, h: i64) void {
    var i: i64 = 0;
    var j: i64 = 0;
    var k: i64 = 0;
    var x: i64 = 0;
    var jj: i64 = 0;
    var kk: i64 = 0;

    if (ln < 16) {
        k = start;
        const end = start + ln;
        while (k < end) {
            j = 1;
            x = inverseSuffix[@intCast(suffixIndexes[@intCast(k)] + h)];
            i = 1;

            while (k + i < end) {
                const KplusI: usize = @intCast(k + i);
                const suffixIndexesKplusI: usize = @intCast(suffixIndexes[KplusI]);
                const suffixIndexesKplusIh: usize = @intCast(suffixIndexesKplusI + @as(usize, @intCast(h)));
                const inverseSuffixsuffixIndexeskPlusIh: i64 = inverseSuffix[suffixIndexesKplusIh];

                if (inverseSuffixsuffixIndexeskPlusIh < x) {
                    x = inverseSuffixsuffixIndexeskPlusIh;
                    j = 0;
                }
                if (inverseSuffixsuffixIndexeskPlusIh == x) {
                    const kPlusJ: usize = @intCast(k + j);
                    swapTemp = suffixIndexes[kPlusJ];
                    suffixIndexes[kPlusJ] = @intCast(suffixIndexesKplusI);
                    suffixIndexes[KplusI] = swapTemp;
                    j += 1;
                }

                i += 1;
            }

            const kPlusJMinus1: i64 = k + j - 1;
            const k_usize: usize = @intCast(k);
            for (0..@intCast(j)) |ii| {
                inverseSuffix[@intCast(suffixIndexes[k_usize + ii])] = kPlusJMinus1;
            }

            if (j == 1) suffixIndexes[@intCast(k)] = -1;
            k += j;
        }
        return;
    }

    x = inverseSuffix[@intCast(suffixIndexes[@intCast(start + (@divTrunc(ln, 2)))] + h)];
    kk = 0;
    jj = kk;

    i = start;
    const startPlusLn: i64 = start + ln;
    while (i < startPlusLn) {
        const inverseSuffixsuffixIndexesIPlusH: i64 = inverseSuffix[@intCast(suffixIndexes[@intCast(i)] + h)];
        if (inverseSuffixsuffixIndexesIPlusH < x) {
            jj += 1;
        } else if (inverseSuffixsuffixIndexesIPlusH == x) {
            kk += 1;
        }

        i += 1;
    }

    jj += start;
    kk += jj;

    i = start;
    k = 0;
    j = k;

    while (i < jj) {
        const inverseSuffixsuffixIndexesIPlusH: i64 = inverseSuffix[@intCast(suffixIndexes[@intCast(i)] + h)];
        if (inverseSuffixsuffixIndexesIPlusH < x) {
            i += 1;
        } else if (inverseSuffixsuffixIndexesIPlusH == x) {
            swapTemp = suffixIndexes[@intCast(i)];
            suffixIndexes[@intCast(i)] = suffixIndexes[@intCast(jj + j)];
            suffixIndexes[@intCast(jj + j)] = swapTemp;
            j += 1;
        } else {
            swapTemp = suffixIndexes[@intCast(i)];
            suffixIndexes[@intCast(i)] = suffixIndexes[@intCast(kk + k)];
            suffixIndexes[@intCast(kk + k)] = swapTemp;
            k += 1;
        }
    }

    const kkMinusJJ: i64 = kk - jj;
    while (j < kkMinusJJ) {
        // while (jj + j < kk) {
        const jjPlusJ: usize = @intCast(jj + j);
        if (inverseSuffix[@intCast(suffixIndexes[jjPlusJ] + h)] == x) {
            j += 1;
        } else {
            swapTemp = suffixIndexes[jjPlusJ];
            suffixIndexes[jjPlusJ] = suffixIndexes[@intCast(kk + k)];
            suffixIndexes[@intCast(kk + k)] = swapTemp;
            k += 1;
        }
    }

    if (jj > start) {
        split(suffixIndexes, inverseSuffix, start, jj - start, h);
    }

    i = 0;
    while (i < kk - jj) {
        inverseSuffix[@intCast(suffixIndexes[@intCast(jj + i)])] = kk - 1;
        i += 1;
    }

    if (jj == kk - 1) {
        suffixIndexes[@intCast(jj)] = -1;
    }

    if (start + ln > kk) {
        split(suffixIndexes, inverseSuffix, kk, start + ln - kk, h);
    }
}

fn logProgressPercent(running: *bool, percent: *f32, operation: []const u8) void {
    while (running.*) {
        std.time.sleep(std.time.ns_per_s * 10); // Wait 10s between messages
        if (!running.*) break;
        std.debug.print("{s}... {d:.1}% complete\n", .{ operation, percent.* });
    }
}
