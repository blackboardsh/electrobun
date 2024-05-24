const std = @import("std");
const zstd = std.compress.zstd;

// const COMPRESSED_APP_BUNDLE_REL_PATH = "/Users/yoav/code/electrobun/example/build/canary/ElectrobunPlayground-0-0-1-canary.app/Contents/Resources/compressed.tar.zst";
// const COMPRESSED_APP_BUNDLE_REL_PATH = "../Resources/compressed.tar.zst";
const BUNLE_RESOURCES_REL_PATH = "../Resources/";
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

    var startTime = std.time.nanoTimestamp();

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched
    // const args = try std.process.argsAlloc(allocator);
    // defer std.process.argsFree(allocator, args);
    // const cwd = std.fs.path.dirname(args[0]).?;

    var exePathBuffer: [1024]u8 = undefined;
    const APPBUNDLE_MACOS_PATH = try std.fs.selfExeDirPath(exePathBuffer[0..]);
    const APPBUNDLE_PATH = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, "../../" });
    const PLIST_PATH = try std.fs.path.join(allocator, &.{ APPBUNDLE_PATH, "Contents/Info.plist" });

    const plistContents = try std.fs.cwd().readFileAlloc(allocator, PLIST_PATH, std.math.maxInt(usize));
    defer allocator.free(plistContents);

    // Note: We want to use the app name, since electrobun cli adds the "- <channel name>" which allws dev, canary, and stable
    // builds to coexist on a machine.
    // todo: consider putting it in <app identifier>/<app name> for better organization and reduce namespace collisions with other
    // apps that might use the same name. (CFBundleIdentifier)
    const identifierName = try getPlistStringValue(plistContents, "CFBundleIdentifier") orelse {
        return error.UnexpectedNull;
    };

    const bundleName = try getPlistStringValue(plistContents, "CFBundleExecutable") orelse {
        return error.UnexpectedNull;
    };

    const appDataPathSegment = try std.fs.path.join(allocator, &.{ identifierName, bundleName });

    const APPDATA_PATH = try std.fs.getAppDataDir(allocator, appDataPathSegment);
    defer allocator.free(APPDATA_PATH);

    const appBundleResourcesPath = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, BUNLE_RESOURCES_REL_PATH });

    const compressedBundleFileName = try getFilenameFromExtension(allocator, appBundleResourcesPath, ".zst");

    std.debug.print("compressedBundleFileName: {s}\n", .{compressedBundleFileName});

    const compressedTarballPath = try std.fs.path.join(allocator, &.{ appBundleResourcesPath, compressedBundleFileName });

    const compressedAppBundle = try std.fs.cwd().openFile(compressedTarballPath, .{}); //|compressedAppBundle| {
    const SELF_EXTRACTION_PATH = try std.fs.path.join(allocator, &.{ APPDATA_PATH, "self-extraction" });

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

    // compressedTarballPath replace extension
    // remove the .zst extension from filename.tar.zst
    const tarFileName = std.fs.path.stem(compressedTarballPath);

    const tarPath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, tarFileName });
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

    const bundleFileName = try getFilenameFromExtension(allocator, SELF_EXTRACTION_PATH, ".app");
    std.debug.print("bundleFileName: {s}\n", .{bundleFileName});
    // Note: the name of the application or bundle may change between builds. By switching distribution channels
    // and/or by the app developer deciding to rename it.
    // todo: consider having a metadata file for the final bundle name and having all the names in this directory consistent
    // const iterableDir = try std.fs.openIterableDirAbsolute(SELF_EXTRACTION_PATH, .{});
    // var extractionFolderWalker = try iterableDir.walk(allocator);
    // defer extractionFolderWalker.deinit();

    // while (try extractionFolderWalker.next()) |entry| {
    //     const entryName = entry.basename;
    //     if (std.mem.eql(u8, std.fs.path.extension(entryName), ".app")) {
    const newBundlePath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, bundleFileName });

    // todo
    // rename the tar file to its hash so we can update it later
    // const hash = "";

    // todo: get the basename of the newBundlePath and join a new path with it
    // in case the name changed.

    // Note: move the current bundle to application support as a backup in case the update fails
    // We only need to keep it around until the next update since we assume if you didn't need it
    // before then you won't need it in the future. ie: only keep one backup around.
    const backupBundlePath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, "backup.app" });
    try std.fs.renameAbsolute(APPBUNDLE_PATH, backupBundlePath);
    try std.fs.renameAbsolute(newBundlePath, APPBUNDLE_PATH);

    const argv = &[_][]const u8{ "open", APPBUNDLE_PATH };
    var child_process = std.ChildProcess.init(argv, allocator);

    // The open command will exit and run the opened app (the unpacked/updated app bundle in a separate process)
    // so we want to just spawn (so it detaches) and exit as soon as possible
    _ = child_process.spawn() catch |err| {
        std.debug.print("Failed to wait for child process: {}\n", .{err});
        return;
    };

    std.os.exit(0);

    //     }
    // } else |_| {
    //     // no compressed file found, assume we're the full app bundle and launch the electrobun app

    //     std.debug.print("No compressed bundle found: \n", .{});
    // }
}

pub fn getFilenameFromExtension(allocator: std.mem.Allocator, folderPath: []const u8, extension: []const u8) ![]const u8 {
    // std.debug.print("one\n", .{});
    const iterableDir = try std.fs.openIterableDirAbsolute(folderPath, .{});
    var extractionFolderWalker = try iterableDir.walk(allocator);
    // std.debug.print("two\n", .{});
    defer extractionFolderWalker.deinit();

    while (try extractionFolderWalker.next()) |entry| {
        const entryName = entry.basename;
        if (std.mem.eql(u8, std.fs.path.extension(entryName), extension)) {
            // Copy the filename to the allocator since we deinit the walker in here
            // and the entryName will be deallocated along with it
            const fileName = try allocator.alloc(u8, entryName.len);
            std.mem.copy(u8, fileName, entryName);
            return fileName;
        }
    }

    return error.FileNotFound;
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

fn getPlistStringValue(plistContents: []const u8, key: []const u8) !?[]const u8 {
    var index: usize = 0;
    while (true) {
        index = std.mem.indexOfPos(u8, plistContents, index, key) orelse break;
        index += key.len;

        const openTag = "<string>";
        index = std.mem.indexOfPos(u8, plistContents, index, openTag) orelse break;
        index += openTag.len;

        const closeTag = "</string>";
        const endIndex = std.mem.indexOfPos(u8, plistContents, index, closeTag) orelse break;

        const value = plistContents[index..endIndex];
        const trimmedValue = std.mem.trim(u8, value, " \t\n\r");

        return trimmedValue;
    }
    return null; // Key not found or malformed plist
}
