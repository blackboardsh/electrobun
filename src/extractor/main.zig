const std = @import("std");
const builtin = @import("builtin");
const zstd = std.compress.zstd;

// const COMPRESSED_APP_BUNDLE_REL_PATH = "/Users/yoav/code/electrobun/example/build/canary/ElectrobunPlayground-0-0-1-canary.app/Contents/Resources/compressed.tar.zst";
// const COMPRESSED_APP_BUNDLE_REL_PATH = "../Resources/compressed.tar.zst";
const BUNLE_RESOURCES_REL_PATH = "../Resources/";

// Magic markers to identify where data starts
const ARCHIVE_MARKER = "ELECTROBUN_ARCHIVE_V1";
const METADATA_MARKER = "ELECTROBUN_METADATA_V1";

// Metadata structure embedded in the binary
const AppMetadata = struct {
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
};

fn extractFromSelf(allocator: std.mem.Allocator) !bool {
    // Get path to self
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);
    
    // Open self for reading
    const self_file = try std.fs.openFileAbsolute(exe_path, .{});
    defer self_file.close();
    
    // Get file size
    const file_size = try self_file.getEndPos();
    
    // Read the last few KB to search for our magic marker sequence
    const search_size: usize = @min(8192, file_size); // Search last 8KB
    const search_start = file_size - search_size;
    try self_file.seekTo(search_start);
    
    var search_buffer: [8192]u8 = undefined;
    const bytes_read = try self_file.read(search_buffer[0..search_size]);
    if (bytes_read != search_size) {
        return false; // Could not read search area
    }
    
    // Look for metadata marker first
    const metadata_marker_pos = std.mem.lastIndexOf(u8, search_buffer[0..bytes_read], METADATA_MARKER);
    if (metadata_marker_pos == null) {
        return false; // Not a self-extracting exe with metadata
    }
    
    // Calculate absolute position of metadata start
    const metadata_start = search_start + metadata_marker_pos.? + METADATA_MARKER.len;
    
    // Look for archive marker after metadata marker
    const remaining_buffer = search_buffer[metadata_marker_pos.?..bytes_read];
    const archive_marker_pos = std.mem.indexOf(u8, remaining_buffer, ARCHIVE_MARKER);
    if (archive_marker_pos == null) {
        return false; // Archive marker not found
    }
    
    // Calculate absolute position of archive start
    const archive_offset = search_start + metadata_marker_pos.? + archive_marker_pos.? + ARCHIVE_MARKER.len;
    
    // Read metadata
    const metadata = try readEmbeddedMetadata(allocator, self_file, metadata_start, archive_offset);
    defer allocator.free(metadata.identifier);
    defer allocator.free(metadata.name);
    defer allocator.free(metadata.channel);
    
    try self_file.seekTo(archive_offset);
    
    // Build application support directory path
    const app_data_dir = try getAppDataDir(allocator);
    defer allocator.free(app_data_dir);
    
    const app_name_channel = try std.fmt.allocPrint(allocator, "{s}-{s}", .{ metadata.name, metadata.channel });
    defer allocator.free(app_name_channel);
    
    const extract_dir = try std.fs.path.join(allocator, &.{ app_data_dir, metadata.identifier, app_name_channel, "self-extraction" });
    defer allocator.free(extract_dir);
    
    std.debug.print("Self-extracting archive found at offset {d}\n", .{archive_offset});
    std.debug.print("Extracting to: {s}\n", .{extract_dir});
    
    // Read and decompress archive (to end of file)
    const archive_size = file_size - archive_offset;
    const compressed_data = try allocator.alloc(u8, archive_size);
    defer allocator.free(compressed_data);
    
    _ = try self_file.read(compressed_data);
    
    // Decompress using zstd
    var window_buffer: [1 << 20]u8 = undefined; // 1MB window
    var stream = std.io.fixedBufferStream(compressed_data);
    var decompressor = zstd.decompressor(stream.reader(), .{
        .window_buffer = &window_buffer,
    });
    
    var decompressed_data = std.ArrayList(u8).init(allocator);
    defer decompressed_data.deinit();
    
    // Decompress in chunks
    var buffer: [4096]u8 = undefined;
    while (true) {
        const read_size = try decompressor.reader().read(&buffer);
        if (read_size == 0) break;
        try decompressed_data.appendSlice(buffer[0..read_size]);
    }
    
    // Extract tar archive to current directory
    try extractTar(allocator, decompressed_data.items, extract_dir);
    
    // Fix executable permissions on extracted binaries
    try fixExecutablePermissions(allocator, extract_dir);
    
    // Replace self with launcher shortcut
    try replaceSelfWithLauncher(allocator, exe_path, extract_dir);
    
    std.debug.print("Extraction complete!\n", .{});
    return true;
}

fn extractTar(allocator: std.mem.Allocator, tar_data: []const u8, extract_dir: []const u8) !void {
    _ = allocator; // Mark as used (needed for potential path operations)
    
    // Create extraction directory
    try std.fs.cwd().makePath(extract_dir);
    
    // Open extraction directory
    const dir = try std.fs.cwd().openDir(extract_dir, .{});
    
    // Create a memory stream from the tar data
    var stream = std.io.fixedBufferStream(tar_data);
    const reader = stream.reader();
    
    // Use existing pipeToFileSystem function which handles file modes
    try pipeToFileSystem(dir, reader);
}

fn fixExecutablePermissions(allocator: std.mem.Allocator, extract_dir: []const u8) !void {
    // List of files that should be executable
    const executables = [_][]const u8{
        "bin/launcher",
        "bin/bun", 
        "bin/bspatch",
        "bin/bsdiff",
    };
    
    // Also check for scripts (handled in the iterator below)
    
    for (executables) |exe| {
        const exe_path = try std.fs.path.join(allocator, &.{ extract_dir, exe });
        defer allocator.free(exe_path);
        
        // Set executable permissions (ignore errors if file doesn't exist)
        const file = std.fs.cwd().openFile(exe_path, .{}) catch continue;
        file.close();
        
        // Use chmod to set executable
        if (builtin.os.tag != .windows) {
            const exe_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{exe_path});
            defer allocator.free(exe_path_z);
            
            const result = std.c.chmod(exe_path_z.ptr, 0o755);
            if (result != 0) {
                std.debug.print("Warning: Could not set executable permissions on {s}\n", .{exe_path});
            }
        }
    }
    
    // Find and fix .sh scripts
    if (builtin.os.tag != .windows) {
        var dir = std.fs.cwd().openDir(extract_dir, .{}) catch return;
        defer dir.close();
        
        var iterator = dir.iterate();
        while (try iterator.next()) |entry| {
            if (entry.kind == .file and std.mem.endsWith(u8, entry.name, ".sh")) {
                const script_path = try std.fs.path.join(allocator, &.{ extract_dir, entry.name });
                defer allocator.free(script_path);
                
                const script_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{script_path});
                defer allocator.free(script_path_z);
                
                const result = std.c.chmod(script_path_z.ptr, 0o755);
                if (result != 0) {
                    std.debug.print("Warning: Could not set executable permissions on {s}\n", .{script_path});
                }
            }
        }
    }
}

fn readEmbeddedMetadata(allocator: std.mem.Allocator, file: std.fs.File, metadata_start: u64, archive_start: u64) !AppMetadata {
    const metadata_size = archive_start - metadata_start;
    if (metadata_size > 4096) return error.MetadataTooLarge; // Sanity check
    
    try file.seekTo(metadata_start);
    const metadata_bytes = try allocator.alloc(u8, metadata_size);
    defer allocator.free(metadata_bytes);
    
    _ = try file.read(metadata_bytes);
    
    // Parse JSON metadata
    const parsed = try std.json.parseFromSlice(struct {
        identifier: []const u8,
        name: []const u8,
        channel: []const u8,
    }, allocator, metadata_bytes, .{});
    defer parsed.deinit();
    
    return AppMetadata{
        .identifier = try allocator.dupe(u8, parsed.value.identifier),
        .name = try allocator.dupe(u8, parsed.value.name),
        .channel = try allocator.dupe(u8, parsed.value.channel),
    };
}

fn getAppDataDir(allocator: std.mem.Allocator) ![]const u8 {
    return switch (builtin.os.tag) {
        .windows => blk: {
            // Use %LOCALAPPDATA% on Windows
            const local_appdata = std.process.getEnvVarOwned(allocator, "LOCALAPPDATA") catch 
                std.process.getEnvVarOwned(allocator, "APPDATA") catch {
                    // Fallback to user profile
                    const userprofile = try std.process.getEnvVarOwned(allocator, "USERPROFILE");
                    defer allocator.free(userprofile);
                    break :blk try std.fs.path.join(allocator, &.{ userprofile, "AppData", "Local" });
                };
            break :blk local_appdata;
        },
        .linux => blk: {
            // Use XDG_DATA_HOME or ~/.local/share on Linux
            const xdg_data_home = std.process.getEnvVarOwned(allocator, "XDG_DATA_HOME") catch {
                const home = try std.process.getEnvVarOwned(allocator, "HOME");
                defer allocator.free(home);
                break :blk try std.fs.path.join(allocator, &.{ home, ".local", "share" });
            };
            break :blk xdg_data_home;
        },
        else => @compileError("Unsupported platform for app data directory"),
    };
}

fn replaceSelfWithLauncher(allocator: std.mem.Allocator, exe_path: []const u8, extract_dir: []const u8) !void {
    const launcher_name = if (builtin.os.tag == .windows) "launcher.exe" else "launcher";
    const launcher_path = try std.fs.path.join(allocator, &.{ extract_dir, "bin", launcher_name });
    defer allocator.free(launcher_path);
    
    // Check if launcher exists
    const launcher_file = std.fs.cwd().openFile(launcher_path, .{}) catch |err| {
        std.debug.print("Warning: Could not find launcher at {s}: {}\n", .{ launcher_path, err });
        return;
    };
    launcher_file.close();
    
    // Copy launcher to replace self
    try std.fs.copyFileAbsolute(launcher_path, exe_path, .{});
    
    std.debug.print("Replaced self with launcher shortcut from: {s}\n", .{launcher_path});
}

fn createLinuxShortcut(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    // Get app name from directory
    const app_name = std.fs.path.basename(app_dir);
    
    // Create launcher script next to extracted folder
    const script_name = try std.fmt.allocPrint(allocator, "{s}.sh", .{app_name});
    defer allocator.free(script_name);
    
    const script_path = try std.fs.path.join(allocator, &.{ app_dir, "..", script_name });
    defer allocator.free(script_path);
    
    const launcher_path = try std.fs.path.join(allocator, &.{ app_name, "bin", "launcher" });
    defer allocator.free(launcher_path);
    
    const script_content = try std.fmt.allocPrint(allocator, 
        \\#!/bin/bash
        \\# {s} Launcher
        \\cd "$(dirname "$0")"
        \\exec "./{s}" "$@"
        \\
    , .{ app_name, launcher_path });
    defer allocator.free(script_content);
    
    try std.fs.cwd().writeFile(script_path, script_content);
    
    // Make script executable
    const script_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{script_path});
    defer allocator.free(script_path_z);
    
    const result = std.c.chmod(script_path_z.ptr, 0o755);
    if (result != 0) {
        std.debug.print("Warning: Could not set executable permissions on launcher script\n", .{});
    }
    
    std.debug.print("Created launcher script: {s}\n", .{script_name});
}

fn createWindowsShortcut(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    // Get app name from directory
    const app_name = std.fs.path.basename(app_dir);
    
    // Create shortcut next to extracted folder
    const shortcut_name = try std.fmt.allocPrint(allocator, "{s}.lnk", .{app_name});
    defer allocator.free(shortcut_name);
    
    const shortcut_path = try std.fs.path.join(allocator, &.{ app_dir, "..", shortcut_name });
    defer allocator.free(shortcut_path);
    
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(launcher_path);
    
    // Create a simple batch file as a workaround for .lnk complexity
    const batch_name = try std.fmt.allocPrint(allocator, "{s}.bat", .{app_name});
    defer allocator.free(batch_name);
    
    const batch_path = try std.fs.path.join(allocator, &.{ app_dir, "..", batch_name });
    defer allocator.free(batch_path);
    
    const batch_content = try std.fmt.allocPrint(allocator, "@echo off\nstart \"\" \"{s}\"\n", .{launcher_path});
    defer allocator.free(batch_content);
    
    try std.fs.cwd().writeFile(batch_path, batch_content);
    
    std.debug.print("Created launcher shortcut: {s}\n", .{batch_name});
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
    
    // On Windows and Linux, check if we're a self-extracting exe with appended archive
    if (builtin.os.tag == .windows or builtin.os.tag == .linux) {
        // Try to extract from self first
        if (try extractFromSelf(allocator)) {
            return;
        }
        // If not a self-extracting exe, continue with normal flow
    }
    const APPBUNDLE_PATH = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, "../../" });
    const PLIST_PATH = try std.fs.path.join(allocator, &.{ APPBUNDLE_PATH, "Contents/Info.plist" });

    const plistContents = std.fs.cwd().readFileAlloc(allocator, PLIST_PATH, std.math.maxInt(usize)) catch |err| {
        std.debug.print("Failed to read plist at {s}: {}\n", .{ PLIST_PATH, err });
        return err;
    };
    defer allocator.free(plistContents);

    // Note: We want to use the app name, since electrobun cli adds the "- <channel name>" which allws dev, canary, and stable
    // builds to coexist on a machine.
    // todo: consider putting it in <app identifier>/<app name> for better organization and reduce namespace collisions with other
    // apps that might use the same name. (CFBundleIdentifier)
    const identifierName = try getPlistStringValue(plistContents, "CFBundleIdentifier") orelse {
        return error.UnexpectedNull;
    };

    const bundleName = try getPlistStringValue(plistContents, "CFBundleName") orelse {
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
    // Note: because it's a big boy we need to allocate it on the heap
    const window_buffer = try allocator.alloc(u8, 128 * 1024 * 1024); // 128MB Buffer
    defer allocator.free(window_buffer);

    var zstd_stream = zstd.decompressor(src_reader, .{ .verify_checksum = false, .window_buffer = window_buffer });

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
    var decompressed_buffer: [4096]u8 = undefined;

    // Read from the decompressor and write to the destination file
    while (true) {
        // Read a chunk of decompressed data into the buffer
        const read_bytes = try zstd_stream.reader().read(&decompressed_buffer);

        if (read_bytes == 0) break; // Check for end of the decompressed stream

        // Write the decompressed chunk to the destination file
        try dst_writer.writeAll(decompressed_buffer[0..read_bytes]);
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

    // Platform-specific app launching
    const argv = switch (builtin.os.tag) {
        .macos => &[_][]const u8{ "open", APPBUNDLE_PATH },
        .linux => blk: {
            // On Linux, find the launcher binary inside the app bundle
            const launcher_path = try std.fs.path.join(allocator, &.{ APPBUNDLE_PATH, "bin", "launcher" });
            break :blk &[_][]const u8{launcher_path};
        },
        .windows => &[_][]const u8{ "cmd", "/c", "start", "", APPBUNDLE_PATH },
        else => @compileError("Unsupported platform for app launching"),
    };
    
    var child_process = std.process.Child.init(argv, allocator);

    // The command will exit and run the opened app (the unpacked/updated app bundle in a separate process)
    // so we want to just spawn (so it detaches) and exit as soon as possible
    _ = child_process.spawn() catch |err| {
        std.debug.print("Failed to spawn child process: {}\n", .{err});
        return;
    };

    std.process.exit(0);

    //     }
    // } else |_| {
    //     // no compressed file found, assume we're the full app bundle and launch the electrobun app

    //     std.debug.print("No compressed bundle found: \n", .{});
    // }
}

pub fn getFilenameFromExtension(allocator: std.mem.Allocator, folderPath: []const u8, extension: []const u8) ![]const u8 {
    const dir = try std.fs.openDirAbsolute(folderPath, .{});
    var iterator = dir.iterate();

    while (try iterator.next()) |entry| {
        const entryName = entry.name;
        if (std.mem.eql(u8, std.fs.path.extension(entryName), extension)) {
            const fileName = try allocator.alloc(u8, entryName.len);
            @memcpy(fileName, entryName);
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

                const mode = if (builtin.os.tag == .windows) 0 else header.mode() catch undefined;

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
