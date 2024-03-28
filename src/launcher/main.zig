const std = @import("std");
const zstd = std.compress.zstd;

// const COMPRESSED_APP_BUNDLE_REL_PATH = "/Users/yoav/code/electrobun/example/build/canary/ElectrobunPlayground-0-0-1-canary.app/Contents/Resources/compressed.tar.zst";
const COMPRESSED_APP_BUNDLE_REL_PATH = "../Resources/compressed.tar.zst";
// todo: for some reason it's saying std.compress.zstd.DecompressorOptions doesn't exist so hardcoding the value
pub const default_window_buffer_len = 8 * 1024 * 1024;

// Note: in 0.11.0 there's a bug in the zstd signature, hardcoding the fix here since the api for 0.12.0 looks like it's changing substantially
// zstd.DecompressStream(@TypeOf(reader, options)) bug
// zstd.DecompressStream(@TypeOf(reader), options) fix
pub fn decompressStreamOptions(
    allocator: std.mem.Allocator,
    reader: anytype,
    comptime options: zstd.DecompressStreamOptions,
) zstd.DecompressStream(@TypeOf(reader), options) {
    return zstd.DecompressStream(@TypeOf(reader), options).init(allocator, reader);
}

pub fn main() !void {
    var allocator = std.heap.page_allocator;

    const cache_path = try getCachePath(allocator, "ElectrobunPlaygroundtest");
    std.debug.print("cache_path: {s}\n", .{cache_path});
    defer allocator.free(cache_path);

    var startTime = std.time.nanoTimestamp();

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched
    // const args = try std.process.argsAlloc(allocator);
    // defer std.process.argsFree(allocator, args);
    // const cwd = std.fs.path.dirname(args[0]).?;

    var exePathBuffer: [1024]u8 = undefined;
    const APPBUNDLE_MACOS_PATH = try std.fs.selfExeDirPath(exePathBuffer[0..]);
    const APPBUNDLE_PATH = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, "../../" });

    // const joinedPath = try std.fs.path.join(allocator, &.{ ELECTROBUN_VIEWS_FOLDER, filePath });
    const resolvedPath = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, COMPRESSED_APP_BUNDLE_REL_PATH });

    std.debug.print("resolvedPath: {s}\n", .{resolvedPath});

    if (std.fs.cwd().openFile(resolvedPath, .{})) |compressedAppBundle| {
        const SELF_EXTRACTION_PATH = try std.fs.path.join(allocator, &.{ cache_path, "self-extraction" });

        if (std.fs.openDirAbsolute(SELF_EXTRACTION_PATH, .{})) |_| {
            try std.fs.deleteTreeAbsolute(SELF_EXTRACTION_PATH);
        } else |_| {
            // do nothing
        }

        try std.fs.cwd().makePath(SELF_EXTRACTION_PATH);

        // compressed file found, assume I'm the self-extractor
        defer compressedAppBundle.close();

        const src_reader = compressedAppBundle.reader();

        // Initialize the decompressor
        // Set window size to 128 MiB which facebook's zstd docs state is the max
        var zstd_stream = decompressStreamOptions(allocator, src_reader, .{ .window_size_max = 128 << 20 });

        defer zstd_stream.deinit();

        const tarPath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, "extracted.tar" });
        std.debug.print("tarPath: {s}\n", .{tarPath});
        // Open the destination file for writing

        const dst_file = try std.fs.cwd().createFile(tarPath, .{ .truncate = true });
        defer dst_file.close();

        // Create a writer for the destination file
        var dst_writer = dst_file.writer();

        // Allocate a buffer for reading decompressed data chunks
        var buffer: [4096]u8 = undefined;

        // Read from the decompressor and write to the destination file
        while (true) {
            // Read a chunk of decompressed data into the buffer
            const read_bytes = try zstd_stream.reader().read(&buffer);
            if (read_bytes == 0) break; // Check for end of the decompressed stream

            // Write the decompressed chunk to the destination file
            try dst_writer.writeAll(buffer[0..read_bytes]);
        }

        std.debug.print("Time taken to decompress: {} ns\n", .{std.time.nanoTimestamp() - startTime});

        startTime = std.time.nanoTimestamp();

        // const unpackedBundlePath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, "unpacked" });
        // try std.fs.cwd().makeDir(unpackedBundlePath);

        const extractionFolder = try std.fs.cwd().openDir(SELF_EXTRACTION_PATH, .{});

        const tarfile = try std.fs.cwd().openFile(tarPath, .{});
        defer tarfile.close();

        try pipeToFileSystem(extractionFolder, tarfile.reader());

        std.debug.print("Time taken to untar: {} ns\n", .{std.time.nanoTimestamp() - startTime});

        // Note: the name of the application or bundle may change between builds. By switching distribution channels
        // and/or by the app developer deciding to rename it.
        // todo: consider having a metadata file for the final bundle name and having all the names in this directory consistent
        const iterableDir = try std.fs.openIterableDirAbsolute(SELF_EXTRACTION_PATH, .{});
        var extractionFolderWalker = try iterableDir.walk(allocator);
        defer extractionFolderWalker.deinit();

        while (try extractionFolderWalker.next()) |entry| {
            const entryName = entry.basename;
            if (std.mem.eql(u8, std.fs.path.extension(entryName), ".app")) {
                const newBundlePath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, entryName });
                // todo: get the basename of the newBundlePath and join a new path with it
                // in case the name changed.

                // Note: Since the new and old app path will be the same in the end, seems osx doesn't like that we
                // move the running self-extrator that was opened with path X and then try open the new app bundle that was
                // put in its place. So we launch the new app bundle before moving it.
                // todo: make sure to note in docs that this is possible, and that apps should be designed to run from anywhere.
                const argv = &[_][]const u8{ "open", newBundlePath };
                var child_process = std.ChildProcess.init(argv, allocator);

                child_process.cwd = newBundlePath;

                // The open command will exit and run the opened app (the unpacked/updated app bundle in a separate process)
                _ = child_process.spawnAndWait() catch |err| {
                    std.debug.print("Failed to wait for child process: {}\n", .{err});
                    return;
                };

                // give the open command a second to actually launch it before moving it to the original bundle location
                std.time.sleep(std.time.ns_per_s * 1);

                // Note: move the current bundle to application support as a backup in case the update fails
                // We only need to keep it around until the next update since we assume if you didn't need it
                // before then you won't need it in the future. ie: only keep one backup around.
                const backupBundlePath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, "backup.app" });
                try std.fs.renameAbsolute(APPBUNDLE_PATH, backupBundlePath);
                try std.fs.renameAbsolute(newBundlePath, APPBUNDLE_PATH);

                break;
            }
        }

        // find .app bundle in the extracted directory, copy it to the same location as the APPBUNDLE_PATH
        // if the app bundle name is different then delete the old one then quit and launch the new app bundle

        std.debug.print("APPBUNDLE_PATH: {s}\n", .{APPBUNDLE_PATH});
    } else |_| {
        // no compressed file found, assume we're the full app bundle and launch the electrobun app

        // Create an instance of ChildProcess
        const argv = &[_][]const u8{ "./bun", "../Resources/app/bun/index.js" };
        var child_process = std.ChildProcess.init(argv, allocator);

        child_process.cwd = APPBUNDLE_MACOS_PATH;

        // Wait for the subprocess to complete
        const exit_code = child_process.spawnAndWait() catch |err| {
            std.debug.print("Failed to wait for child process: {}\n", .{err});
            return;
        };

        std.debug.print("Subprocess exited with code: {}\n", .{exit_code});
    }
}

// Note: zig stdlib's untar function doesn't support file modes. They don't plan on adding it later,
// or at least not for windows in the near future which we expect to support in the future. In the meantime this is a patched
// version of std.tar.pipeToFileSystem from the stdlib that supports file modes on unix systems.
// todo: when we add windows support we can revisit
pub fn pipeToFileSystem(dir: std.fs.Dir, reader: anytype) !void {
    var file_name_buffer: [255]u8 = undefined;
    var buffer: [512 * 8]u8 = undefined;
    var start: usize = 0;
    var end: usize = 0;
    header: while (true) {
        if (buffer.len - start < 1024) {
            const dest_end = end - start;
            @memcpy(buffer[0..dest_end], buffer[start..end]);
            end = dest_end;
            start = 0;
        }
        const ask_header = @min(buffer.len - end, 1024 -| (end - start));
        end += try reader.readAtLeast(buffer[end..], ask_header);
        switch (end - start) {
            0 => return,
            1...511 => return error.UnexpectedEndOfStream,
            else => {},
        }
        const header: Header = .{ .bytes = buffer[start..][0..512] };
        start += 512;
        const file_size = try header.fileSize();
        const rounded_file_size = std.mem.alignForward(u64, file_size, 512);
        const pad_len = @as(usize, @intCast(rounded_file_size - file_size));
        const unstripped_file_name = try header.fullFileName(&file_name_buffer);
        switch (header.fileType()) {
            .directory => {
                const file_name = unstripped_file_name;
                if (file_name.len != 0) {
                    try dir.makePath(file_name);
                }
            },
            .normal => {
                if (file_size == 0 and unstripped_file_name.len == 0) return;
                const file_name = unstripped_file_name;

                if (std.fs.path.dirname(file_name)) |dir_name| {
                    try dir.makePath(dir_name);
                }

                var mode: u32 = undefined;

                if (header.mode()) |_mode| {
                    // std.debug.print("mode {any} {s}\n", .{ mode, file_name });
                    mode = _mode;
                } else |_| {
                    // to nothing
                }

                var file = try dir.createFile(file_name, .{ .mode = mode });
                defer file.close();

                var file_off: usize = 0;
                while (true) {
                    if (buffer.len - start < 1024) {
                        const dest_end = end - start;
                        @memcpy(buffer[0..dest_end], buffer[start..end]);
                        end = dest_end;
                        start = 0;
                    }
                    // Ask for the rounded up file size + 512 for the next header.
                    // TODO: https://github.com/ziglang/zig/issues/14039
                    const ask = @as(usize, @intCast(@min(
                        buffer.len - end,
                        rounded_file_size + 512 - file_off -| (end - start),
                    )));
                    end += try reader.readAtLeast(buffer[end..], ask);
                    if (end - start < ask) return error.UnexpectedEndOfStream;
                    // TODO: https://github.com/ziglang/zig/issues/14039
                    const slice = buffer[start..@as(usize, @intCast(@min(file_size - file_off + start, end)))];
                    try file.writeAll(slice);

                    file_off += slice.len;
                    start += slice.len;
                    if (file_off >= file_size) {
                        start += pad_len;
                        // Guaranteed since we use a buffer divisible by 512.
                        std.debug.assert(start <= end);
                        continue :header;
                    }
                }
            },
            .global_extended_header, .extended_header => {
                if (start + rounded_file_size > end) return error.TarHeadersTooBig;
                start = @as(usize, @intCast(start + rounded_file_size));
            },
            .hard_link => return error.TarUnsupportedFileType,
            .symbolic_link => return error.TarUnsupportedFileType,
            else => return error.TarUnsupportedFileType,
        }
    }
}

pub const Header = struct {
    bytes: *const [512]u8,

    pub const FileType = enum(u8) {
        normal = '0',
        hard_link = '1',
        symbolic_link = '2',
        character_special = '3',
        block_special = '4',
        directory = '5',
        fifo = '6',
        contiguous = '7',
        global_extended_header = 'g',
        extended_header = 'x',
        _,
    };

    pub fn fileSize(header: Header) !u64 {
        const raw = header.bytes[124..][0..12];
        const ltrimmed = std.mem.trimLeft(u8, raw, "0");
        const rtrimmed = std.mem.trimRight(u8, ltrimmed, " \x00");
        if (rtrimmed.len == 0) return 0;
        return std.fmt.parseInt(u64, rtrimmed, 8);
    }

    pub fn is_ustar(header: Header) bool {
        return std.mem.eql(u8, header.bytes[257..][0..6], "ustar\x00");
    }

    /// Includes prefix concatenated, if any.
    /// Return value may point into Header buffer, or might point into the
    /// argument buffer.
    /// TODO: check against "../" and other nefarious things
    pub fn fullFileName(header: Header, buffer: *[255]u8) ![]const u8 {
        const n = name(header);
        if (!is_ustar(header))
            return n;
        const p = prefix(header);
        if (p.len == 0)
            return n;
        @memcpy(buffer[0..p.len], p);
        buffer[p.len] = '/';
        @memcpy(buffer[p.len + 1 ..][0..n.len], n);
        return buffer[0 .. p.len + 1 + n.len];
    }

    pub fn mode(header: Header) !u32 {
        const raw = header.bytes[100..][0..8];
        const ltrimmed = std.mem.trimLeft(u8, raw, "0");
        const rtrimmed = std.mem.trimRight(u8, ltrimmed, " \x00");
        if (rtrimmed.len == 0) return 0;
        return std.fmt.parseInt(u32, rtrimmed, 8);
    }

    pub fn name(header: Header) []const u8 {
        return str(header, 0, 0 + 100);
    }

    pub fn prefix(header: Header) []const u8 {
        return str(header, 345, 345 + 155);
    }

    pub fn fileType(header: Header) FileType {
        const result = @as(FileType, @enumFromInt(header.bytes[156]));
        return if (result == @as(FileType, @enumFromInt(0))) .normal else result;
    }

    fn str(header: Header, start: usize, end: usize) []const u8 {
        var i: usize = start;
        while (i < end) : (i += 1) {
            if (header.bytes[i] == 0) break;
        }
        return header.bytes[start..i];
    }
};

// todo: consider using std.fs.getAppDataDir instead as it's cross platform (Library/Application Support on macos)
pub fn getCachePath(allocator: std.mem.Allocator, appName: []const u8) ![]u8 {
    const home_dir = std.os.getenv("HOME") orelse {
        return error.UnexpectedNull;
    };

    var cache_path = try std.fs.path.join(allocator, &.{ home_dir, "Library", "Caches", appName });
    return cache_path;
}
