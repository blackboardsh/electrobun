const std = @import("std");
const builtin = @import("builtin");
const zstd = std.compress.zstd;

// Initialized at the top of main(). Test-only helpers do not touch these.
var g_io: std.Io = undefined;
var g_environ_map: *std.process.Environ.Map = undefined;

fn getEnvOwned(allocator: std.mem.Allocator, key: []const u8) ![]u8 {
    const value = g_environ_map.get(key) orelse return error.EnvironmentVariableNotFound;
    return allocator.dupe(u8, value);
}

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
    hash: ?[]const u8 = null,
};

// Progress indicator for extraction
const ProgressIndicator = struct {
    child_process: ?std.process.Child,
    allocator: std.mem.Allocator,
    app_name: []const u8 = "",

    fn init(allocator: std.mem.Allocator, metadata: AppMetadata) ProgressIndicator {
        var self = ProgressIndicator{
            .child_process = null,
            .allocator = allocator,
            .app_name = metadata.name,
        };

        // Try to start a progress dialog
        self.startProgressDialog(metadata) catch {
            // Fallback to console output
            std.debug.print("\nInstalling {s}...\n", .{metadata.name});
        };

        return self;
    }

    fn startProgressDialog(self: *ProgressIndicator, metadata: AppMetadata) !void {
        // On Windows, use simple console output (no spinner thread to avoid deadlock)
        if (builtin.os.tag == .windows) {
            return error.NoProgressDialog; // Fallback to simple print
        }

        if (builtin.os.tag != .linux) return;

        // Try zenity first (most common)
        const extract_text = try std.fmt.allocPrint(self.allocator, "--text=Extracting {s}...", .{metadata.name});
        defer self.allocator.free(extract_text);

        const zenity_args = [_][]const u8{
            "zenity",                       "--progress", "--pulsate",    "--no-cancel",
            "--title=Electrobun Installer", extract_text, "--auto-close",
        };

        const child = std.process.spawn(g_io, .{
            .argv = &zenity_args,
            .stdin = .pipe,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| {
            // Try kdialog for KDE
            if (err == error.FileNotFound) {
                const kdialog_text = try std.fmt.allocPrint(self.allocator, "Extracting {s}...", .{metadata.name});
                defer self.allocator.free(kdialog_text);

                const kdialog_args = [_][]const u8{
                    "kdialog", "--progressbar",        kdialog_text, "0",
                    "--title", "Electrobun Installer",
                };

                const kde_child = std.process.spawn(g_io, .{
                    .argv = &kdialog_args,
                    .stdin = .ignore,
                    .stdout = .ignore,
                    .stderr = .ignore,
                }) catch {
                    return error.NoProgressDialog;
                };

                self.child_process = kde_child;
                return;
            }
            return err;
        };

        self.child_process = child;
    }

    fn deinit(self: *ProgressIndicator) void {
        if (self.child_process) |*child| {
            // Close stdin to signal completion for zenity
            if (child.stdin) |stdin| {
                stdin.close(g_io);
                child.stdin = null;
            }

            // Wait a moment for the dialog to close gracefully
            g_io.sleep(.fromMilliseconds(500), .awake) catch {};

            // Terminate if still running; kill() also reaps the child.
            child.kill(g_io);
        }
    }
};

fn linuxAdjacentMetadataPath(allocator: std.mem.Allocator, exe_path: []const u8) !?[]u8 {
    const exe_dir = std.fs.path.dirname(exe_path) orelse return error.InvalidPath;
    if (!std.mem.eql(u8, std.fs.path.basename(exe_dir), "bin")) return null;
    const bundle_dir = std.fs.path.dirname(exe_dir) orelse return error.InvalidPath;
    return try std.fs.path.join(allocator, &.{ bundle_dir, "Resources", "metadata.json" });
}

fn adjacentArchivePathForMetadata(
    allocator: std.mem.Allocator,
    metadata_path: []const u8,
    hash: []const u8,
) ![]u8 {
    const resources_dir = std.fs.path.dirname(metadata_path) orelse return error.InvalidPath;
    const archive_name = try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{hash});
    defer allocator.free(archive_name);
    return std.fs.path.join(allocator, &.{ resources_dir, archive_name });
}

fn extractAdjacentArchive(
    allocator: std.mem.Allocator,
    metadata_path: []const u8,
    explicit_archive_path: ?[]const u8,
) !?bool {
    const metadata_contents = std.Io.Dir.cwd().readFileAlloc(g_io, metadata_path, allocator, .limited(4096)) catch |err| switch (err) {
        error.FileNotFound, error.NotDir => return null,
        else => return err,
    };
    defer allocator.free(metadata_contents);
    const parsed = try std.json.parseFromSlice(
        AppMetadata,
        allocator,
        metadata_contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const metadata = parsed.value;

    const generated_archive_path = if (explicit_archive_path == null)
        try adjacentArchivePathForMetadata(
            allocator,
            metadata_path,
            metadata.hash orelse return error.MissingArchiveHash,
        )
    else
        null;
    defer if (generated_archive_path) |path| allocator.free(path);
    const archive_path = explicit_archive_path orelse generated_archive_path.?;

    const compressed_data = std.Io.Dir.cwd().readFileAlloc(g_io, archive_path, allocator, .unlimited) catch |err| switch (err) {
        error.FileNotFound, error.NotDir => return null,
        else => return err,
    };
    defer allocator.free(compressed_data);

    std.debug.print("Found adjacent archive file: {s}\n", .{archive_path});
    std.debug.print("Using metadata: identifier={s}, name={s}, channel={s}\n", .{
        metadata.identifier,
        metadata.name,
        metadata.channel,
    });

    const app_data_dir = try getAppDataDir(allocator);
    defer allocator.free(app_data_dir);
    const app_base_dir = try std.fs.path.join(allocator, &.{ app_data_dir, metadata.identifier, metadata.channel });
    defer allocator.free(app_base_dir);
    const self_extraction_dir = try std.fs.path.join(allocator, &.{ app_base_dir, "self-extraction" });
    defer allocator.free(self_extraction_dir);
    const app_dir = try std.fs.path.join(allocator, &.{ app_base_dir, "app" });
    defer allocator.free(app_dir);

    std.debug.print("Extracting to: {s}\n", .{self_extraction_dir});
    std.debug.print("App will be installed to: {s}\n", .{app_dir});

    return try extractAndInstall(allocator, compressed_data, metadata, self_extraction_dir, app_dir);
}

fn extractFromSelf(allocator: std.mem.Allocator) !bool {
    // Get path to self
    const exe_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(exe_path);

    // Normal Linux bundles keep their payload and metadata in ../Resources.
    if (builtin.os.tag == .linux) {
        if (try linuxAdjacentMetadataPath(allocator, exe_path)) |metadata_path| {
            defer allocator.free(metadata_path);
            if (try extractAdjacentArchive(allocator, metadata_path, null)) |result| return result;
        }
    }

    // Windows installers keep their adjacent payload in .installer, with a
    // legacy fallback beside the executable.
    if (builtin.os.tag == .windows) {
        const exe_dir = std.fs.path.dirname(exe_path) orelse return error.InvalidPath;
        const exe_stem = std.fs.path.stem(std.fs.path.basename(exe_path));
        const archive_name = try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{exe_stem});
        defer allocator.free(archive_name);
        const metadata_name = try std.fmt.allocPrint(allocator, "{s}.metadata.json", .{exe_stem});
        defer allocator.free(metadata_name);

        const installer_archive_path = try std.fs.path.join(allocator, &.{ exe_dir, ".installer", archive_name });
        defer allocator.free(installer_archive_path);
        const archive_path = try std.fs.path.join(allocator, &.{ exe_dir, archive_name });
        defer allocator.free(archive_path);
        const final_archive_path = if (std.Io.Dir.accessAbsolute(g_io, installer_archive_path, .{})) |_|
            installer_archive_path
        else |_|
            archive_path;

        const installer_metadata_path = try std.fs.path.join(allocator, &.{ exe_dir, ".installer", metadata_name });
        defer allocator.free(installer_metadata_path);
        const metadata_path = try std.fs.path.join(allocator, &.{ exe_dir, metadata_name });
        defer allocator.free(metadata_path);
        const final_metadata_path = if (std.Io.Dir.accessAbsolute(g_io, installer_metadata_path, .{})) |_|
            installer_metadata_path
        else |_|
            metadata_path;

        if (try extractAdjacentArchive(allocator, final_metadata_path, final_archive_path)) |result| return result;
    }

    // Fall back to embedded archive approach (for Linux or if adjacent files not found on Windows)
    // Read self entirely to find the SECOND occurrence of the metadata marker.
    // This avoids false positives if markers appear in the extractor binary or user code
    const search_buffer = try std.Io.Dir.cwd().readFileAlloc(g_io, exe_path, allocator, .unlimited);
    defer allocator.free(search_buffer);

    // Find first occurrence
    const first_metadata_pos = std.mem.indexOf(u8, search_buffer, METADATA_MARKER);
    if (first_metadata_pos == null) {
        std.debug.print("DEBUG: No metadata marker found at all\n", .{});
        return false; // No metadata marker at all
    }
    // Find second occurrence (the real one we appended)
    const search_start = first_metadata_pos.? + METADATA_MARKER.len;
    const remaining_after_first = search_buffer[search_start..];
    const second_metadata_offset = std.mem.indexOf(u8, remaining_after_first, METADATA_MARKER);
    if (second_metadata_offset == null) {
        return false; // No second occurrence found
    }

    // Calculate absolute position of the second metadata marker
    const metadata_marker_pos = search_start + second_metadata_offset.?;
    const metadata_start = metadata_marker_pos + METADATA_MARKER.len;

    // Look for archive marker after the metadata content (not the marker)
    const remaining_buffer = search_buffer[metadata_start..];
    const archive_marker_offset = std.mem.indexOf(u8, remaining_buffer, ARCHIVE_MARKER);
    if (archive_marker_offset == null) {
        return false; // Archive marker not found
    }

    // Calculate absolute position where archive marker starts (this marks end of metadata)
    const archive_offset = metadata_start + archive_marker_offset.?;

    // Read metadata
    const metadata = try readEmbeddedMetadata(allocator, search_buffer[metadata_start..archive_offset]);

    // Create a completely independent copy of the hash to prevent corruption
    const backup_hash = if (metadata.hash) |h| try allocator.dupe(u8, h) else null;
    defer if (backup_hash) |h| allocator.free(h);

    // Create a new metadata struct with the backup hash
    const safe_metadata = AppMetadata{
        .identifier = metadata.identifier,
        .name = metadata.name,
        .channel = metadata.channel,
        .hash = backup_hash,
    };

    // Defer cleanup until after extractAndInstall is done
    defer {
        allocator.free(metadata.identifier);
        allocator.free(metadata.name);
        allocator.free(metadata.channel);
        if (metadata.hash) |hash| {
            allocator.free(hash);
        }
    }

    // Build application support directory path
    const app_data_dir = try getAppDataDir(allocator);
    defer allocator.free(app_data_dir);

    // Use identifier + channel for the app data folder
    // e.g., ~/Library/Application Support/sh.blackboard.myapp/canary/
    const app_base_dir = try std.fs.path.join(allocator, &.{ app_data_dir, metadata.identifier, metadata.channel });
    defer allocator.free(app_base_dir);

    const self_extraction_dir = try std.fs.path.join(allocator, &.{ app_base_dir, "self-extraction" });
    defer allocator.free(self_extraction_dir);

    // Always use "app" folder instead of hash-based versioning
    const app_dir = try std.fs.path.join(allocator, &.{ app_base_dir, "app" });
    defer allocator.free(app_dir);

    std.debug.print("Self-extracting archive found at offset {d}\n", .{archive_offset});
    std.debug.print("Extracting to: {s}\n", .{self_extraction_dir});

    // Archive runs from just past the marker to the end of the file
    const compressed_data = search_buffer[archive_offset + ARCHIVE_MARKER.len ..];

    // Continue with decompression (shared code path)
    return try extractAndInstall(allocator, compressed_data, safe_metadata, self_extraction_dir, app_dir);
}

fn extractAndInstall(allocator: std.mem.Allocator, compressed_data: []const u8, metadata: AppMetadata, self_extraction_dir: []const u8, app_dir: []const u8) !bool {

    // Initialize progress indicator
    var progress = ProgressIndicator.init(allocator, metadata);
    defer progress.deinit();

    // Get exe path for shortcuts
    const exe_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(exe_path);

    // Decompress using zstd
    // Note: the sliding window is a big boy so we allocate it on the heap
    const window_buffer = try allocator.alloc(u8, zstd.default_window_len + zstd.block_size_max);
    defer allocator.free(window_buffer);

    var input_reader: std.Io.Reader = .fixed(compressed_data);
    var decompress: zstd.Decompress = .init(&input_reader, window_buffer, .{ .verify_checksum = false });

    std.debug.print("Decompressing", .{});
    const decompressed_data = try decompress.reader.allocRemaining(allocator, .unlimited);
    defer allocator.free(decompressed_data);
    std.debug.print(" Done!\n", .{});

    // For Linux: Save the compressed archive to self-extraction directory (for future updates)
    // This is similar to what macOS does to enable the Updater API to apply patches
    // We'll save tar files after extraction to avoid them being deleted

    // Extract tar archive to self-extraction directory first
    std.debug.print("Extracting files", .{});

    try extractTar(allocator, decompressed_data, self_extraction_dir);
    std.debug.print(" Done!\n", .{});

    // Now move the extracted app to the app directory
    // The app bundle is nested inside self-extraction, we need to find it
    // Use the same sanitization as the build process: remove spaces.
    std.debug.print("\nDEBUG: Building extracted app path...\n", .{});
    std.debug.print("DEBUG: metadata.name = '{s}'\n", .{metadata.name});
    std.debug.print("DEBUG: metadata.channel = '{s}'\n", .{metadata.channel});

    const app_bundle_name = try extractedBundleName(allocator, metadata.name, metadata.channel);
    defer allocator.free(app_bundle_name);
    std.debug.print("DEBUG: app_bundle_name = '{s}'\n", .{app_bundle_name});

    const extracted_app_path = try std.fs.path.join(allocator, &.{ self_extraction_dir, app_bundle_name });
    defer allocator.free(extracted_app_path);
    std.debug.print("DEBUG: extracted_app_path = '{s}'\n", .{extracted_app_path});

    // Remove existing app directory before installing the new one
    std.Io.Dir.cwd().deleteTree(g_io, app_dir) catch {};

    // Move the extracted app to the app directory
    std.debug.print("\nDEBUG: Preparing to move app...\n", .{});
    std.debug.print("DEBUG: Source (extracted_app_path) = '{s}'\n", .{extracted_app_path});
    std.debug.print("DEBUG: Destination (app_dir) = '{s}'\n", .{app_dir});

    // Check if source exists
    std.Io.Dir.cwd().access(g_io, extracted_app_path, .{}) catch |err| {
        std.debug.print("ERROR: Source directory does not exist: '{s}' - {}\n", .{ extracted_app_path, err });
        // List what's actually in the extraction directory
        std.debug.print("DEBUG: Listing contents of extraction directory '{s}':\n", .{self_extraction_dir});
        var iter_dir = try std.Io.Dir.cwd().openDir(g_io, self_extraction_dir, .{ .iterate = true });
        defer iter_dir.close(g_io);
        var iterator = iter_dir.iterate();
        while (try iterator.next(g_io)) |entry| {
            std.debug.print("  - {s} ({s})\n", .{ entry.name, @tagName(entry.kind) });
        }
        return err;
    };
    std.debug.print("DEBUG: Source directory exists\n", .{});

    // On Windows, we need to create the parent directory first, then copy contents
    if (builtin.os.tag == .windows) {
        // Create the app directory and all parent directories
        std.debug.print("\nDEBUG: Windows directory creation...\n", .{});
        std.debug.print("DEBUG: Current working directory = {s}\n", .{try std.process.currentPathAlloc(g_io, allocator)});
        std.debug.print("DEBUG: About to create Windows app directory: '{s}'\n", .{app_dir});
        std.debug.print("DEBUG: app_dir length = {}\n", .{app_dir.len});

        // Check if parent directory exists
        if (std.fs.path.dirname(app_dir)) |parent| {
            std.debug.print("DEBUG: Parent directory = '{s}'\n", .{parent});
            std.Io.Dir.cwd().access(g_io, parent, .{}) catch |err| {
                std.debug.print("DEBUG: Parent directory does not exist, will create it. Error: {}\n", .{err});
            };
        }

        // Print each character to debug the string
        std.debug.print("DEBUG: app_dir bytes: ", .{});
        for (app_dir) |byte| {
            if (byte >= 32 and byte <= 126) {
                std.debug.print("'{c}' ", .{byte});
            } else {
                std.debug.print("0x{x:02} ", .{byte});
            }
        }
        std.debug.print("\n", .{});

        std.debug.print("DEBUG: Calling createDirPath...\n", .{});
        std.Io.Dir.cwd().createDirPath(g_io, app_dir) catch |err| {
            std.debug.print("ERROR: Failed to create app directory '{s}': {}\n", .{ app_dir, err });

            // Try to create parent directory first
            if (std.fs.path.dirname(app_dir)) |parent| {
                std.debug.print("DEBUG: Trying to create parent directory first: '{s}'\n", .{parent});
                std.Io.Dir.cwd().createDirPath(g_io, parent) catch |parent_err| {
                    std.debug.print("ERROR: Failed to create parent directory: {}\n", .{parent_err});
                };
            }

            return err;
        };
        std.debug.print("DEBUG: Successfully created app directory\n", .{});

        // Copy contents from extracted path to app directory
        try copyDirectory(allocator, extracted_app_path, app_dir);

        // Remove the extracted directory after successful copy
        std.Io.Dir.cwd().deleteTree(g_io, extracted_app_path) catch {};
    } else {
        // On Unix systems, rename works across directories
        std.Io.Dir.cwd().rename(extracted_app_path, std.Io.Dir.cwd(), app_dir, g_io) catch |err| {
            return err;
        };
    }

    // Fix executable permissions on extracted binaries
    try fixExecutablePermissions(allocator, app_dir);

    // On macOS, remove quarantine attributes to allow signed apps to run
    if (builtin.os.tag == .macos) {
        try removeQuarantine(allocator, app_dir);
    }

    // Fix CEF symlinks (they get lost during tar extraction)
    try fixCefSymlinks(allocator, app_dir);

    // On macOS, replace self with launcher shortcut (due to .app bundle structure)
    // On Windows/Linux, keep the self-extractor and create desktop shortcuts
    if (builtin.os.tag == .macos) {
        try replaceSelfWithLauncher(allocator, exe_path, app_dir);
    }

    // Create desktop shortcuts on Linux and Windows
    if (builtin.os.tag == .linux) {
        try createDesktopShortcut(allocator, app_dir);
    }

    if (builtin.os.tag == .windows) {
        try createWindowsShortcut(allocator, app_dir, metadata);
    }

    // Save tar file for Updater API on Linux and Windows after everything else is done
    if (builtin.os.tag == .linux or builtin.os.tag == .windows) {
        std.debug.print("\n✓ Saving tar file for Updater API...\n", .{});
        // Make a defensive copy of the hash to prevent memory corruption
        const safe_hash = if (metadata.hash) |h| try allocator.dupe(u8, h) else null;
        defer if (safe_hash != null) allocator.free(safe_hash.?);

        // Save decompressed tar with hash as filename (for Updater API patching)
        const tar_filename = if (safe_hash) |hash|
            try std.fmt.allocPrint(allocator, "{s}.tar", .{hash})
        else
            "current.tar";
        defer if (safe_hash != null) allocator.free(tar_filename);

        const tar_path = try std.fs.path.join(allocator, &.{ self_extraction_dir, tar_filename });
        defer allocator.free(tar_path);

        // Ensure self-extraction directory exists
        try std.Io.Dir.cwd().createDirPath(g_io, self_extraction_dir);

        std.debug.print("DEBUG: Creating tar file at: {s}\n", .{tar_path});
        const tar_file = try std.Io.Dir.cwd().createFile(g_io, tar_path, .{});
        defer tar_file.close(g_io);
        try tar_file.writeStreamingAll(g_io, decompressed_data);
        std.debug.print("✓ Saved tar file ({} bytes)\n", .{decompressed_data.len});

        // List files to confirm they're saved
        std.debug.print("\nDEBUG: Final files in self-extraction dir:\n", .{});
        var dir = try std.Io.Dir.cwd().openDir(g_io, self_extraction_dir, .{ .iterate = true });
        defer dir.close(g_io);
        var iter = dir.iterate();
        while (try iter.next(g_io)) |entry| {
            std.debug.print("  - {s} ({s})\n", .{ entry.name, @tagName(entry.kind) });
        }
    }

    std.debug.print(" Done!\n", .{});
    std.debug.print("Installation completed successfully!\n", .{});
    return true;
}

fn extractTar(allocator: std.mem.Allocator, tar_data: []const u8, extract_dir: []const u8) !void {
    _ = allocator; // Mark as used (needed for potential path operations)

    std.debug.print("DEBUG: Starting tar extraction to: {s}\n", .{extract_dir});
    std.debug.print("DEBUG: Tar data size: {} bytes\n", .{tar_data.len});

    // Clean up existing directory if it exists to ensure no old files remain
    std.Io.Dir.cwd().deleteTree(g_io, extract_dir) catch |err| switch (err) {
        error.NotDir => {
            // Path exists but is not a directory, try to delete as file
            std.Io.Dir.cwd().deleteFile(g_io, extract_dir) catch {
                // If that fails too, just continue - we'll overwrite
            };
        },
        else => {
            // For any other error (including if directory doesn't exist), just continue
            // The createDirPath call below will create the directory as needed
        },
    };

    // Create extraction directory
    try std.Io.Dir.cwd().createDirPath(g_io, extract_dir);

    // Open extraction directory
    var dir = try std.Io.Dir.cwd().openDir(g_io, extract_dir, .{});
    defer dir.close(g_io);

    // Create a memory stream from the tar data
    var reader: std.Io.Reader = .fixed(tar_data);

    // Use existing pipeToFileSystem function which handles file modes
    try pipeToFileSystem(g_io, dir, &reader);
}

fn fixExecutablePermissions(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    std.debug.print("DEBUG: fixExecutablePermissions called with dir: {s}\n", .{app_dir});

    // List of files that should be executable
    const executables = [_][]const u8{
        "bin/launcher",
        "bin/cottontail",
        "bin/bspatch",
        "bin/bsdiff",
        "bin/zig-zstd",
    };

    // Also check for scripts (handled in the iterator below)

    std.debug.print("DEBUG: Processing executables list...\n", .{});
    for (executables) |exe| {
        const exe_path = try std.fs.path.join(allocator, &.{ app_dir, exe });
        defer allocator.free(exe_path);

        // Set executable permissions (ignore errors if file doesn't exist)
        const file = std.Io.Dir.cwd().openFile(g_io, exe_path, .{}) catch continue;
        file.close(g_io);

        // Use chmod to set executable (skip on macOS app bundles to preserve code signatures)
        if (builtin.os.tag != .windows) {
            // On macOS, skip chmod for app bundles as it breaks code signatures
            if (builtin.os.tag == .macos and std.mem.indexOf(u8, app_dir, ".app") != null) {
                std.debug.print("DEBUG: Skipping chmod on macOS app bundle to preserve code signature: {s}\n", .{exe_path});
                continue;
            }

            const exe_path_z = try allocator.dupeZ(u8, exe_path);
            defer allocator.free(exe_path_z);

            const result = std.c.chmod(exe_path_z.ptr, 0o755);
            if (result != 0) {
                std.debug.print("Warning: Could not set executable permissions on {s}\n", .{exe_path});
            }
        }
    }

    std.debug.print("DEBUG: Done with executables list\n", .{});

    // Find and fix .sh scripts
    // TEMPORARILY DISABLED - causing panic
    if (false and builtin.os.tag != .windows) {
        std.debug.print("DEBUG: Looking for .sh scripts...\n", .{});
        var dir = std.Io.Dir.cwd().openDir(g_io, app_dir, .{ .iterate = true }) catch |err| {
            std.debug.print("DEBUG: Could not open directory {s}: {}\n", .{ app_dir, err });
            return;
        };
        defer dir.close(g_io);

        std.debug.print("DEBUG: Directory opened successfully, starting iteration...\n", .{});
        var iterator = dir.iterate();
        while (try iterator.next(g_io)) |entry| {
            std.debug.print("DEBUG: Found entry: {s} kind: {}\n", .{ entry.name, entry.kind });
            // Only process regular files (not directories, symlinks, etc.)
            switch (entry.kind) {
                .file => {
                    if (std.mem.endsWith(u8, entry.name, ".sh")) {
                        const script_path = try std.fs.path.join(allocator, &.{ app_dir, entry.name });
                        defer allocator.free(script_path);

                        const script_path_z = try allocator.dupeZ(u8, script_path);
                        defer allocator.free(script_path_z);

                        const result = std.c.chmod(script_path_z.ptr, 0o755);
                        if (result != 0) {
                            std.debug.print("Warning: Could not set executable permissions on {s}\n", .{script_path});
                        }
                    }
                },
                .directory => {
                    // Skip directories
                },
                .sym_link => {
                    // Skip symlinks
                },
                else => {
                    // Skip any other file types
                },
            }
        }
    }
    std.debug.print("DEBUG: fixExecutablePermissions completed successfully\n", .{});
}

fn fixCefSymlinks(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    // No need to find app directory anymore since it's passed directly

    const bin_dir = try std.fs.path.join(allocator, &.{ app_dir, "bin" });
    defer allocator.free(bin_dir);

    const cef_dir = try std.fs.path.join(allocator, &.{ bin_dir, "cef" });
    defer allocator.free(cef_dir);

    // Check if cef directory exists
    std.Io.Dir.cwd().access(g_io, cef_dir, .{}) catch {
        std.debug.print("CEF directory not found, skipping symlink creation\n", .{});
        return;
    };

    // List of CEF libraries that need symlinks
    const cef_libs = [_][]const u8{
        "libcef.so",
        "libEGL.so",
        "libGLESv2.so",
        "libvk_swiftshader.so",
        "libvulkan.so.1",
    };

    std.debug.print("Creating CEF symlinks...\n", .{});

    for (cef_libs) |lib| {
        const symlink_path = try std.fs.path.join(allocator, &.{ bin_dir, lib });
        defer allocator.free(symlink_path);

        const target_path = try std.fmt.allocPrint(allocator, "cef/{s}", .{lib});
        defer allocator.free(target_path);

        // Remove existing symlink/file if it exists
        std.Io.Dir.cwd().deleteFile(g_io, symlink_path) catch {};

        // Create the symlink
        std.Io.Dir.cwd().symLink(g_io, target_path, symlink_path, .{}) catch |err| {
            std.debug.print("Warning: Could not create symlink for {s}: {}\n", .{ lib, err });
            continue;
        };

        std.debug.print("Created symlink: {s} -> {s}\n", .{ lib, target_path });
    }
}

fn removeQuarantine(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    std.debug.print("Removing quarantine attributes from: {s}\n", .{app_dir});

    _ = allocator;

    // Use xattr to remove com.apple.quarantine from the entire app bundle
    const args = [_][]const u8{ "xattr", "-r", "-d", "com.apple.quarantine", app_dir };

    var child_process = std.process.spawn(g_io, .{
        .argv = &args,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch |err| {
        std.debug.print("Warning: Failed to run xattr to remove quarantine: {}\n", .{err});
        return;
    };

    const result = child_process.wait(g_io) catch |err| {
        std.debug.print("Warning: Failed to wait for xattr: {}\n", .{err});
        return;
    };

    switch (result) {
        .exited => |code| {
            if (code == 0) {
                std.debug.print("Successfully removed quarantine attributes\n", .{});
            } else {
                std.debug.print("Warning: xattr returned exit code {d} (quarantine might not have been set)\n", .{code});
            }
        },
        else => {
            std.debug.print("Warning: xattr process terminated unexpectedly\n", .{});
        },
    }
}

fn readEmbeddedMetadata(allocator: std.mem.Allocator, metadata_bytes: []const u8) !AppMetadata {
    std.debug.print("DEBUG: metadata_size={d}\n", .{metadata_bytes.len});
    if (metadata_bytes.len > 4096) return error.MetadataTooLarge; // Sanity check

    // Debug: print the raw metadata before parsing
    std.debug.print("DEBUG: Raw metadata bytes (size={d})\n", .{metadata_bytes.len});
    std.debug.print("DEBUG: Raw metadata as hex: ", .{});
    for (metadata_bytes) |byte| {
        std.debug.print("{x:0>2} ", .{byte});
    }
    std.debug.print("\n", .{});
    std.debug.print("DEBUG: Raw metadata as string: '", .{});
    for (metadata_bytes) |byte| {
        if (byte >= 32 and byte <= 126) {
            std.debug.print("{c}", .{byte});
        } else {
            std.debug.print("\\x{x:0>2}", .{byte});
        }
    }
    std.debug.print("'\n", .{});

    // Parse JSON metadata
    const parsed = try std.json.parseFromSlice(struct {
        identifier: []const u8,
        name: []const u8,
        channel: []const u8,
        hash: ?[]const u8 = null,
    }, allocator, metadata_bytes, .{});
    defer parsed.deinit();

    return AppMetadata{
        .identifier = try allocator.dupe(u8, parsed.value.identifier),
        .name = try allocator.dupe(u8, parsed.value.name),
        .channel = try allocator.dupe(u8, parsed.value.channel),
        .hash = if (parsed.value.hash) |h| try allocator.dupe(u8, h) else null,
    };
}

fn getAppDataDir(allocator: std.mem.Allocator) ![]const u8 {
    return switch (builtin.os.tag) {
        .windows => blk: {
            // Use %LOCALAPPDATA% on Windows
            const local_appdata = getEnvOwned(allocator, "LOCALAPPDATA") catch
                getEnvOwned(allocator, "APPDATA") catch {
                // Fallback to user profile
                const userprofile = try getEnvOwned(allocator, "USERPROFILE");
                defer allocator.free(userprofile);
                break :blk try std.fs.path.join(allocator, &.{ userprofile, "AppData", "Local" });
            };
            break :blk local_appdata;
        },
        .linux => blk: {
            // Use XDG_DATA_HOME or ~/.local/share on Linux
            const xdg_data_home = getEnvOwned(allocator, "XDG_DATA_HOME") catch {
                const home = try getEnvOwned(allocator, "HOME");
                defer allocator.free(home);
                break :blk try std.fs.path.join(allocator, &.{ home, ".local", "share" });
            };
            break :blk xdg_data_home;
        },
        else => @compileError("Unsupported platform for app data directory"),
    };
}

fn replaceSelfWithLauncher(allocator: std.mem.Allocator, exe_path: []const u8, app_dir: []const u8) !void {
    const launcher_name = if (builtin.os.tag == .windows) "launcher.exe" else "launcher";
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", launcher_name });
    defer allocator.free(launcher_path);

    // Check if launcher exists
    const launcher_file = std.Io.Dir.cwd().openFile(g_io, launcher_path, .{}) catch |err| {
        std.debug.print("Warning: Could not find launcher at {s}: {}\n", .{ launcher_path, err });
        return;
    };
    launcher_file.close(g_io);

    // Copy launcher to replace self
    try std.Io.Dir.copyFileAbsolute(launcher_path, exe_path, g_io, .{});

    std.debug.print("Replaced self with launcher shortcut from: {s}\n", .{launcher_path});
}

fn escapeDesktopString(allocator: std.mem.Allocator, str: []const u8) ![]u8 {
    // Count how many characters need escaping
    var escape_count: usize = 0;
    for (str) |c| {
        if (c == '\\' or c == '"' or c == '\n' or c == '\r' or c == '\t') {
            escape_count += 1;
        }
    }

    // Allocate buffer for escaped string
    const escaped = try allocator.alloc(u8, str.len + escape_count);
    var i: usize = 0;

    for (str) |c| {
        switch (c) {
            '\\' => {
                escaped[i] = '\\';
                escaped[i + 1] = '\\';
                i += 2;
            },
            '"' => {
                escaped[i] = '\\';
                escaped[i + 1] = '"';
                i += 2;
            },
            '\n' => {
                escaped[i] = '\\';
                escaped[i + 1] = 'n';
                i += 2;
            },
            '\r' => {
                escaped[i] = '\\';
                escaped[i + 1] = 'r';
                i += 2;
            },
            '\t' => {
                escaped[i] = '\\';
                escaped[i + 1] = 't';
                i += 2;
            },
            else => {
                escaped[i] = c;
                i += 1;
            },
        }
    }

    return escaped;
}

fn desktopEntryInstallName(source_name: []const u8) ?[]const u8 {
    if (!std.mem.endsWith(u8, source_name, ".desktop")) return null;
    return source_name;
}

fn rewriteDesktopEntry(
    allocator: std.mem.Allocator,
    desktop_content: []const u8,
    launcher_path: []const u8,
    icon_path: ?[]const u8,
) ![]u8 {
    var lines = std.mem.tokenizeScalar(u8, desktop_content, '\n');
    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);

    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "Exec=")) {
            try result.appendSlice(allocator, "Exec=\"");
            try result.appendSlice(allocator, launcher_path);
            try result.appendSlice(allocator, "\"\n");
        } else if (std.mem.startsWith(u8, line, "Icon=")) {
            if (icon_path) |path| {
                try result.appendSlice(allocator, "Icon=");
                try result.appendSlice(allocator, path);
                try result.appendSlice(allocator, "\n");
            } else if (!std.mem.eql(u8, line, "Icon=appIcon") and
                !std.mem.eql(u8, line, "Icon=appIcon.png"))
            {
                // Keep explicit freedesktop theme icon names. Only remove the
                // generated bundle-relative placeholder when no bundled icon
                // was actually installed.
                try result.appendSlice(allocator, line);
                try result.appendSlice(allocator, "\n");
            }
        } else {
            try result.appendSlice(allocator, line);
            try result.appendSlice(allocator, "\n");
        }
    }

    return result.toOwnedSlice(allocator);
}

fn createDesktopShortcut(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    // Get home directory for desktop path
    const home = getEnvOwned(allocator, "HOME") catch {
        std.debug.print("Warning: Could not get HOME directory\n", .{});
        return;
    };
    defer allocator.free(home);

    // Build desktop file path
    const desktop_dir = try std.fs.path.join(allocator, &.{ home, "Desktop" });
    defer allocator.free(desktop_dir);

    const desktop_dir_available = blk: {
        std.Io.Dir.cwd().access(g_io, desktop_dir, .{}) catch {
            std.debug.print("Note: Desktop directory not found at {s}; skipping Desktop shortcut creation\n", .{desktop_dir});
            break :blk false;
        };
        break :blk true;
    };

    // On Linux, look for the launcher binary in the app directory
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher" });
    defer allocator.free(launcher_path);

    // Check if launcher exists
    std.Io.Dir.cwd().access(g_io, launcher_path, .{}) catch |err| {
        std.debug.print("Warning: launcher binary not found at {s}: {}\n", .{ launcher_path, err });
        return;
    };

    // Look for the desktop file in the extracted app directory and copy it
    var app_dir_handle = try std.Io.Dir.cwd().openDir(g_io, app_dir, .{ .iterate = true });
    defer app_dir_handle.close(g_io);

    var found_desktop_file = false;
    var desktop_shortcut_created = false;
    var applications_entry_created = false;
    var iterator = app_dir_handle.iterate();
    while (try iterator.next(g_io)) |entry| {
        if (entry.kind == .file) {
            const desktop_filename = desktopEntryInstallName(entry.name) orelse continue;
            const desktop_file_path = try std.fs.path.join(allocator, &.{ desktop_dir, desktop_filename });
            defer allocator.free(desktop_file_path);

            // Copy the desktop file from app dir to Desktop
            const source_desktop = try std.fs.path.join(allocator, &.{ app_dir, entry.name });
            defer allocator.free(source_desktop);

            // Read the desktop file content
            const desktop_content = try std.Io.Dir.cwd().readFileAlloc(g_io, source_desktop, allocator, .limited(4096));
            defer allocator.free(desktop_content);

            // Find icon file in app directory (first try root, then Resources subdirectory)
            var icon_path: []const u8 = undefined;
            var icon_path_allocated = false;

            // First, try to find icon in the app root directory
            var icon_iterator = app_dir_handle.iterate();
            while (try icon_iterator.next(g_io)) |icon_entry| {
                if (icon_entry.kind == .file and std.mem.endsWith(u8, icon_entry.name, ".png")) {
                    icon_path = try std.fs.path.join(allocator, &.{ app_dir, icon_entry.name });
                    icon_path_allocated = true;
                    break;
                }
            }

            // If no icon found in root, try Resources subdirectory
            if (!icon_path_allocated) {
                const resources_path = try std.fs.path.join(allocator, &.{ app_dir, "Resources" });
                defer allocator.free(resources_path);

                var resources_dir_handle = std.Io.Dir.cwd().openDir(g_io, resources_path, .{ .iterate = true }) catch |err| blk: {
                    // Resources directory doesn't exist, that's okay
                    if (err == error.FileNotFound) break :blk null;
                    return err;
                };

                if (resources_dir_handle) |*res_handle| {
                    defer res_handle.close(g_io);
                    var res_icon_iterator = res_handle.iterate();
                    while (try res_icon_iterator.next(g_io)) |icon_entry| {
                        if (icon_entry.kind == .file and std.mem.endsWith(u8, icon_entry.name, ".png")) {
                            icon_path = try std.fs.path.join(allocator, &.{ resources_path, icon_entry.name });
                            icon_path_allocated = true;
                            break;
                        }
                    }
                }
            }
            defer if (icon_path_allocated) allocator.free(icon_path);

            const rewritten_desktop = try rewriteDesktopEntry(
                allocator,
                desktop_content,
                launcher_path,
                if (icon_path_allocated) icon_path else null,
            );
            defer allocator.free(rewritten_desktop);

            // Write the updated desktop file to Desktop (optional)
            if (desktop_dir_available) {
                desktop_shortcut: {
                    const desktop_file = std.Io.Dir.cwd().createFile(g_io, desktop_file_path, .{}) catch |err| {
                        std.debug.print("Warning: Could not create Desktop shortcut file: {}\n", .{err});
                        break :desktop_shortcut;
                    };
                    defer desktop_file.close(g_io);
                    desktop_file.writeStreamingAll(g_io, rewritten_desktop) catch |err| {
                        std.debug.print("Warning: Could not write Desktop shortcut file: {}\n", .{err});
                        break :desktop_shortcut;
                    };
                    desktop_shortcut_created = true;
                }
            }

            // Also write to XDG applications directory for menu integration
            // This ensures the app appears in the desktop environment's application menu
            // This is optional - failure should not prevent the desktop shortcut from working
            write_applications_dir: {
                const xdg_data_home = getAppDataDir(allocator) catch |err| {
                    std.debug.print("Warning: Could not get app data dir for menu integration: {}\n", .{err});
                    break :write_applications_dir;
                };
                defer allocator.free(xdg_data_home);

                const applications_dir = std.fs.path.join(allocator, &.{ xdg_data_home, "applications" }) catch |err| {
                    std.debug.print("Warning: Could not build applications dir path: {}\n", .{err});
                    break :write_applications_dir;
                };
                defer allocator.free(applications_dir);

                // Create applications directory if it doesn't exist
                std.Io.Dir.cwd().createDirPath(g_io, applications_dir) catch |err| {
                    std.debug.print("Warning: Could not create applications directory: {}\n", .{err});
                    // Continue anyway - createFile will fail gracefully
                };

                const applications_file_path = std.fs.path.join(allocator, &.{ applications_dir, desktop_filename }) catch |err| {
                    std.debug.print("Warning: Could not build applications file path: {}\n", .{err});
                    break :write_applications_dir;
                };
                defer allocator.free(applications_file_path);

                const applications_file = std.Io.Dir.cwd().createFile(g_io, applications_file_path, .{}) catch |err| {
                    std.debug.print("Warning: Could not create applications desktop file: {}\n", .{err});
                    break :write_applications_dir;
                };
                defer applications_file.close(g_io);

                applications_file.writeStreamingAll(g_io, rewritten_desktop) catch |err| {
                    std.debug.print("Warning: Could not write applications desktop file: {}\n", .{err});
                    break :write_applications_dir;
                };

                // Set permissions on the desktop file (0o644 - readable, not executable)
                // Desktop files in ~/.local/share/applications/ don't need execute bit
                // (execute bit is only needed for Desktop surface, not application menus)
                const applications_file_path_z = allocator.dupeZ(u8, applications_file_path) catch |err| {
                    std.debug.print("Warning: Could not format applications file path: {}\n", .{err});
                    break :write_applications_dir;
                };
                defer allocator.free(applications_file_path_z);
                const chmod_result = std.c.chmod(applications_file_path_z.ptr, 0o644);
                if (chmod_result != 0) {
                    std.debug.print("Warning: Could not set permissions on applications desktop file\n", .{});
                }

                // Note: gio set metadata::trusted is NOT needed for application menu entries
                // It's only for .desktop files on the Desktop surface (~/Desktop)

                // Update desktop database for legacy desktop environments (Xfce, LXDE, etc.)
                const update_db_argv = [_][]const u8{ "update-desktop-database", applications_dir };
                if (std.process.spawn(g_io, .{
                    .argv = &update_db_argv,
                    .stdin = .ignore,
                    .stdout = .ignore,
                    .stderr = .inherit,
                })) |spawned| {
                    var update_db_child = spawned;
                    _ = update_db_child.wait(g_io) catch {};
                } else |err| {
                    std.debug.print("Note: Could not update desktop database: {}\n", .{err});
                }

                applications_entry_created = true;
                std.debug.print("Copied desktop shortcut to applications dir: {s}\n", .{applications_file_path});
            }

            found_desktop_file = true;
            if (desktop_shortcut_created) {
                std.debug.print("Copied desktop shortcut to: {s}\n", .{desktop_file_path});
            }
            if (!desktop_shortcut_created and !applications_entry_created) {
                std.debug.print("Warning: Could not create Desktop shortcut or applications menu entry\n", .{});
            }

            if (desktop_shortcut_created) {
                // Make desktop file executable (required for some desktop environments)
                const desktop_file_path_z = try allocator.dupeZ(u8, desktop_file_path);
                defer allocator.free(desktop_file_path_z);

                const result = std.c.chmod(desktop_file_path_z.ptr, 0o755);
                if (result != 0) {
                    std.debug.print("Warning: Could not set executable permissions on desktop file\n", .{});
                }

                // Try to mark as trusted for GNOME/Ubuntu using gio
                const gio_argv = [_][]const u8{ "gio", "set", desktop_file_path, "metadata::trusted", "true" };
                if (std.process.spawn(g_io, .{
                    .argv = &gio_argv,
                    .stdin = .ignore,
                    .stdout = .ignore,
                    .stderr = .inherit,
                })) |spawned| {
                    var gio_child = spawned;
                    _ = gio_child.wait(g_io) catch {};
                } else |err| {
                    std.debug.print("Note: Could not mark desktop file as trusted with gio: {}\n", .{err});
                }

                std.debug.print("Created desktop shortcut: {s}\n", .{desktop_file_path});
                std.debug.print("Note: If the desktop icon opens as text, right-click it and select 'Allow Launching' or 'Trust and Launch'\n", .{});
            }
            break;
        }
    }

    if (!found_desktop_file) {
        std.debug.print("Warning: No desktop file found in extracted app directory\n", .{});
    }
}

fn createWindowsShortcutFile(allocator: std.mem.Allocator, shortcut_dir: []const u8, app_name: []const u8, target_path: []const u8, working_dir: []const u8, icon_path: []const u8) !void {
    // Create a .lnk shortcut using PowerShell
    const lnk_name = try std.fmt.allocPrint(allocator, "{s}.lnk", .{app_name});
    defer allocator.free(lnk_name);

    const lnk_path = try std.fs.path.join(allocator, &.{ shortcut_dir, lnk_name });
    defer allocator.free(lnk_path);

    // Create PowerShell script to create the shortcut with icon
    const ps_content = try std.fmt.allocPrint(allocator,
        \\$WshShell = New-Object -ComObject WScript.Shell
        \\$Shortcut = $WshShell.CreateShortcut("{s}")
        \\$Shortcut.TargetPath = "{s}"
        \\$Shortcut.WorkingDirectory = "{s}"
        \\$Shortcut.IconLocation = "{s}"
        \\$Shortcut.WindowStyle = 1
        \\$Shortcut.Save()
        \\
    , .{ lnk_path, target_path, working_dir, icon_path });
    defer allocator.free(ps_content);

    // Execute PowerShell command
    const ps_args = [_][]const u8{
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        ps_content,
    };

    var child = std.process.spawn(g_io, .{
        .argv = &ps_args,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch |err| {
        std.debug.print("Warning: Could not spawn PowerShell to create shortcut: {}\n", .{err});
        return;
    };

    _ = child.wait(g_io) catch |err| {
        std.debug.print("Warning: PowerShell shortcut creation failed: {}\n", .{err});
        return;
    };

    std.debug.print("Created Windows shortcut: {s}\n", .{lnk_path});
}

fn createWindowsShortcut(allocator: std.mem.Allocator, app_dir: []const u8, metadata: AppMetadata) !void {
    // Get user directories
    const userprofile = getEnvOwned(allocator, "USERPROFILE") catch {
        std.debug.print("Warning: Could not get USERPROFILE directory\n", .{});
        return;
    };
    defer allocator.free(userprofile);

    const desktop_dir = try std.fs.path.join(allocator, &.{ userprofile, "Desktop" });
    defer allocator.free(desktop_dir);

    const start_menu_dir = try std.fs.path.join(allocator, &.{ userprofile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs" });
    defer allocator.free(start_menu_dir);

    // Check if Desktop directory exists
    std.Io.Dir.cwd().access(g_io, desktop_dir, .{}) catch {
        std.debug.print("Warning: Desktop directory not found at {s}\n", .{desktop_dir});
        // Continue anyway, might work
    };

    // Point directly to launcher.exe (no more run.bat wrapper)
    const target_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(target_path);

    // Check if target exists
    std.Io.Dir.cwd().access(g_io, target_path, .{}) catch |err| {
        std.debug.print("Warning: Could not find launcher.exe at {s}: {}\n", .{ target_path, err });
        return;
    };

    // Working directory is the bin directory
    const working_dir = try std.fs.path.join(allocator, &.{ app_dir, "bin" });
    defer allocator.free(working_dir);

    // Icon is embedded in launcher.exe, so use it directly as icon source
    const icon_to_use = target_path;

    // Create desktop shortcut
    try createWindowsShortcutFile(allocator, desktop_dir, metadata.name, target_path, working_dir, icon_to_use);

    // Create Start Menu shortcut
    // Make sure Start Menu directory exists
    std.Io.Dir.cwd().createDirPath(g_io, start_menu_dir) catch {
        std.debug.print("Warning: Could not create Start Menu directory\n", .{});
    };
    try createWindowsShortcutFile(allocator, start_menu_dir, metadata.name, target_path, working_dir, icon_to_use);

    std.debug.print("Created Windows shortcuts for: {s}\n", .{metadata.name});

    // Add uninstall registry entry for better Windows integration
    try addWindowsUninstallEntry(allocator, metadata, app_dir);
}

fn addWindowsUninstallEntry(allocator: std.mem.Allocator, metadata: AppMetadata, app_dir: []const u8) !void {
    // Create a simple registry file that users can double-click to install uninstall info
    // This is a safer approach than directly modifying the registry from our code
    const reg_name = try std.fmt.allocPrint(allocator, "{s}_uninstall.reg", .{metadata.name});
    defer allocator.free(reg_name);

    const reg_path = try std.fs.path.join(allocator, &.{ app_dir, reg_name });
    defer allocator.free(reg_path);

    const app_display_name = try std.fmt.allocPrint(allocator, "{s} ({s})", .{ metadata.name, metadata.channel });
    defer allocator.free(app_display_name);

    // Create registry content for Windows uninstall entry
    const reg_content = try std.fmt.allocPrint(allocator,
        \\Windows Registry Editor Version 5.00
        \\
        \\[HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{s}]
        \\@="{s}"
        \\"DisplayName"="{s}"
        \\"DisplayVersion"="1.0"
        \\"Publisher"="Electrobun"
        \\"InstallLocation"="{s}"
        \\"UninstallString"="cmd.exe /c rmdir /s /q \"{s}\""
        \\"NoModify"=dword:00000001
        \\"NoRepair"=dword:00000001
        \\
    , .{ metadata.identifier, app_display_name, app_display_name, app_dir, app_dir });
    defer allocator.free(reg_content);

    // Create and write registry file
    const reg_file = std.Io.Dir.cwd().createFile(g_io, reg_path, .{}) catch |err| {
        std.debug.print("Warning: Could not create uninstall registry file: {}\n", .{err});
        return;
    };
    defer reg_file.close(g_io);

    reg_file.writeStreamingAll(g_io, reg_content) catch |err| {
        std.debug.print("Warning: Could not write registry content: {}\n", .{err});
        return;
    };

    std.debug.print("Created uninstall registry file: {s}\n", .{reg_path});
    std.debug.print("Note: Users can double-click {s} to add uninstall info to Windows\n", .{reg_name});
}

pub fn main(init: std.process.Init) !void {
    g_io = init.io;
    g_environ_map = init.environ_map;

    std.debug.print("Electrobun self-extractor v1.3 starting...\n", .{});
    const allocator = init.gpa;

    var startTime = std.Io.Clock.now(.awake, g_io);

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched

    var exePathBuffer: [1024]u8 = undefined;
    const exe_dir_len = try std.process.executableDirPath(g_io, exePathBuffer[0..]);
    const APPBUNDLE_MACOS_PATH = exePathBuffer[0..exe_dir_len];

    // Platform-specific extraction
    if (builtin.os.tag == .windows or builtin.os.tag == .linux) {
        // Windows and Linux ONLY use self-extraction with magic bytes
        const extracted = try extractFromSelf(allocator);
        if (!extracted) {
            std.debug.print("ERROR: Not a valid self-extracting installer\n", .{});
            return error.InvalidInstaller;
        }
        return;
    }

    // macOS reads metadata.json from outer bundle (consistent with Windows/Linux)
    const APPBUNDLE_PATH = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, "../../" });

    // Use identifier/channel structure for app data path (consistent with CLI, updater, and native wrappers)
    // Read metadata.json from outer bundle's Resources folder (same format as Windows/Linux)
    const metadataJsonPath = try std.fs.path.join(allocator, &.{ APPBUNDLE_PATH, "Contents/Resources/metadata.json" });
    defer allocator.free(metadataJsonPath);

    const metadataJsonContents = std.Io.Dir.cwd().readFileAlloc(g_io, metadataJsonPath, allocator, .unlimited) catch |err| {
        std.debug.print("Failed to read metadata.json at {s}: {}\n", .{ metadataJsonPath, err });
        return err;
    };
    defer allocator.free(metadataJsonContents);

    const metadataParsed = try std.json.parseFromSlice(struct {
        identifier: []const u8,
        name: []const u8,
        channel: []const u8,
        hash: []const u8,
    }, allocator, metadataJsonContents, .{ .ignore_unknown_fields = true });
    defer metadataParsed.deinit();

    const identifierName = try allocator.dupe(u8, metadataParsed.value.identifier);
    defer allocator.free(identifierName);

    const channelName = try allocator.dupe(u8, metadataParsed.value.channel);
    defer allocator.free(channelName);

    const appDisplayName = try allocator.dupe(u8, metadataParsed.value.name);
    defer allocator.free(appDisplayName);

    const hashName = try allocator.dupe(u8, metadataParsed.value.hash);
    defer allocator.free(hashName);

    const appDataPathSegment = try std.fs.path.join(allocator, &.{ identifierName, channelName });

    // macOS application data lives in ~/Library/Application Support/<identifier>/<channel>
    const home_dir = try getEnvOwned(allocator, "HOME");
    defer allocator.free(home_dir);
    const APPDATA_PATH = try std.fs.path.join(allocator, &.{ home_dir, "Library", "Application Support", appDataPathSegment });
    defer allocator.free(APPDATA_PATH);

    const appBundleResourcesPath = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, BUNLE_RESOURCES_REL_PATH });

    const compressedBundleFileName = try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{hashName});
    defer allocator.free(compressedBundleFileName);

    std.debug.print("compressedBundleFileName: {s}\n", .{compressedBundleFileName});

    const compressedTarballPath = try std.fs.path.join(allocator, &.{ appBundleResourcesPath, compressedBundleFileName });

    const compressedAppBundle = try std.Io.Dir.cwd().openFile(g_io, compressedTarballPath, .{}); //|compressedAppBundle| {
    const SELF_EXTRACTION_PATH = try std.fs.path.join(allocator, &.{ APPDATA_PATH, "self-extraction" });

    // Remove any previous extraction directory before starting fresh
    std.Io.Dir.cwd().deleteTree(g_io, SELF_EXTRACTION_PATH) catch {};

    try std.Io.Dir.cwd().createDirPath(g_io, SELF_EXTRACTION_PATH);

    // compressed file found, assume I'm the self-extractor
    defer compressedAppBundle.close(g_io);

    var src_reader_buffer: [64 * 1024]u8 = undefined;
    var src_file_reader = compressedAppBundle.reader(g_io, src_reader_buffer[0..]);

    // Initialize the decompressor
    // Note: the sliding window is a big boy so we allocate it on the heap
    const window_buffer = try allocator.alloc(u8, zstd.default_window_len + zstd.block_size_max);
    defer allocator.free(window_buffer);

    var zstd_stream: zstd.Decompress = .init(&src_file_reader.interface, window_buffer, .{ .verify_checksum = false });

    // compressedTarballPath replace extension
    // remove the .zst extension from filename.tar.zst
    const tarFileName = std.fs.path.stem(compressedTarballPath);

    const tarPath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_PATH, tarFileName });
    std.debug.print("tarPath: {s}\n", .{tarPath});
    // Open the destination file for writing

    const dst_file = try std.Io.Dir.cwd().createFile(g_io, tarPath, .{ .truncate = true });
    defer dst_file.close(g_io);

    // Create a writer for the destination file
    var dst_writer_buffer: [64 * 1024]u8 = undefined;
    var dst_file_writer = dst_file.writer(g_io, dst_writer_buffer[0..]);

    // Stream from the decompressor into the destination file
    _ = try zstd_stream.reader.streamRemaining(&dst_file_writer.interface);
    try dst_file_writer.interface.flush();

    const decompress_done = std.Io.Clock.now(.awake, g_io);
    std.debug.print("Time taken to decompress: {} ns\n", .{startTime.durationTo(decompress_done).toNanoseconds()});

    startTime = decompress_done;

    var extractionFolder = try std.Io.Dir.cwd().openDir(g_io, SELF_EXTRACTION_PATH, .{});
    defer extractionFolder.close(g_io);

    const tarfile = try std.Io.Dir.cwd().openFile(g_io, tarPath, .{});
    defer tarfile.close(g_io);

    var tar_reader_buffer: [64 * 1024]u8 = undefined;
    var tar_file_reader = tarfile.reader(g_io, tar_reader_buffer[0..]);
    try pipeToFileSystem(g_io, extractionFolder, &tar_file_reader.interface);

    const untar_done = std.Io.Clock.now(.awake, g_io);
    std.debug.print("Time taken to untar: {} ns\n", .{startTime.durationTo(untar_done).toNanoseconds()});

    const bundleBaseName = if (isProductionChannel(channelName))
        appDisplayName
    else
        try std.fmt.allocPrint(allocator, "{s}-{s}", .{ appDisplayName, channelName });
    defer if (!isProductionChannel(channelName)) allocator.free(bundleBaseName);

    const bundleFileName = try std.fmt.allocPrint(allocator, "{s}.app", .{bundleBaseName});
    defer allocator.free(bundleFileName);

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

    std.Io.Dir.cwd().deleteTree(g_io, APPBUNDLE_PATH) catch {};
    try std.Io.Dir.renameAbsolute(newBundlePath, APPBUNDLE_PATH, g_io);

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

    // The command will exit and run the opened app (the unpacked/updated app bundle in a separate process)
    // so we want to just spawn (so it detaches) and exit as soon as possible
    _ = std.process.spawn(g_io, .{ .argv = argv }) catch |err| {
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

fn isProductionChannel(channel: []const u8) bool {
    return std.mem.eql(u8, channel, "production");
}

fn extractedBundleName(
    allocator: std.mem.Allocator,
    app_name: []const u8,
    channel: []const u8,
) ![]u8 {
    const sanitized_name = try std.mem.replaceOwned(u8, allocator, app_name, " ", "");
    if (isProductionChannel(channel)) return sanitized_name;
    defer allocator.free(sanitized_name);
    return std.fmt.allocPrint(allocator, "{s}-{s}", .{ sanitized_name, channel });
}

test "production bundles use the unsuffixed application name" {
    try std.testing.expect(isProductionChannel("production"));
    try std.testing.expect(!isProductionChannel("canary"));
    try std.testing.expect(!isProductionChannel("dev"));
    try std.testing.expect(!isProductionChannel("stable"));

    const production = try extractedBundleName(std.testing.allocator, "My App.Name", "production");
    defer std.testing.allocator.free(production);
    try std.testing.expectEqualStrings("MyApp.Name", production);

    const canary = try extractedBundleName(std.testing.allocator, "My App.Name", "canary");
    defer std.testing.allocator.free(canary);
    try std.testing.expectEqualStrings("MyApp.Name-canary", canary);
}

test "normal Linux bundle launchers resolve their adjacent release payload" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;

    const metadata_path = (try linuxAdjacentMetadataPath(
        std.testing.allocator,
        "/opt/ArchiveApp/bin/launcher",
    )) orelse return error.TestUnexpectedResult;
    defer std.testing.allocator.free(metadata_path);
    try std.testing.expectEqualStrings(
        "/opt/ArchiveApp/Resources/metadata.json",
        metadata_path,
    );

    const archive_path = try adjacentArchivePathForMetadata(
        std.testing.allocator,
        metadata_path,
        "release-hash",
    );
    defer std.testing.allocator.free(archive_path);
    try std.testing.expectEqualStrings(
        "/opt/ArchiveApp/Resources/release-hash.tar.zst",
        archive_path,
    );

    try std.testing.expect(
        try linuxAdjacentMetadataPath(std.testing.allocator, "/tmp/staging/installer") == null,
    );
}

test "Linux desktop entries preserve channel-specific names and omit missing icons" {
    try std.testing.expectEqualStrings(
        "ArchiveApp.desktop",
        desktopEntryInstallName("ArchiveApp.desktop") orelse return error.TestUnexpectedResult,
    );
    try std.testing.expectEqualStrings(
        "ArchiveApp-canary.desktop",
        desktopEntryInstallName("ArchiveApp-canary.desktop") orelse return error.TestUnexpectedResult,
    );
    try std.testing.expect(desktopEntryInstallName("ArchiveApp.png") == null);

    const source =
        "[Desktop Entry]\n" ++
        "Name=Archive App\n" ++
        "Exec=launcher\n" ++
        "Icon=appIcon\n" ++
        "Terminal=false\n";
    const without_icon = try rewriteDesktopEntry(std.testing.allocator, source, "/opt/archive/bin/launcher", null);
    defer std.testing.allocator.free(without_icon);
    try std.testing.expect(std.mem.indexOf(u8, without_icon, "Exec=\"/opt/archive/bin/launcher\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, without_icon, "Icon=") == null);

    const themed_source =
        "[Desktop Entry]\n" ++
        "Exec=launcher\n" ++
        "Icon=org.example.ArchiveApp\n";
    const themed_icon = try rewriteDesktopEntry(std.testing.allocator, themed_source, "/opt/archive/bin/launcher", null);
    defer std.testing.allocator.free(themed_icon);
    try std.testing.expect(std.mem.indexOf(u8, themed_icon, "Icon=org.example.ArchiveApp") != null);

    const with_icon = try rewriteDesktopEntry(std.testing.allocator, source, "/opt/archive/bin/launcher", "/opt/archive/Resources/appIcon.png");
    defer std.testing.allocator.free(with_icon);
    try std.testing.expect(std.mem.indexOf(u8, with_icon, "Icon=/opt/archive/Resources/appIcon.png") != null);
}

// Note: zig stdlib's untar function doesn't support file modes. They don't plan on adding it later,
// or at least not for windows in the near future which we expect to support in the future. In the meantime this is a patched
// version of std.tar.pipeToFileSystem from the stdlib that supports file modes on unix systems.
// todo: when we add windows support we can revisit
pub fn pipeToFileSystem(io: std.Io, dir: std.Io.Dir, reader: *std.Io.Reader) !void {
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
        end += try reader.readSliceShort(buffer[end..]);
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
                    if (builtin.os.tag == .windows) {
                        std.debug.print("DEBUG: Creating directory: '{s}'\n", .{file_name});
                    }
                    dir.createDirPath(io, file_name) catch |err| {
                        if (builtin.os.tag == .windows) {
                            std.debug.print("ERROR: Failed to create directory '{s}': {}\n", .{ file_name, err });
                        }
                        return err;
                    };
                }
            },
            .normal => {
                if (file_size == 0 and unstripped_file_name.len == 0) return;
                const file_name = unstripped_file_name;

                if (std.fs.path.dirname(file_name)) |dir_name| {
                    if (builtin.os.tag == .windows) {
                        std.debug.print("DEBUG: Creating parent dir: '{s}'\n", .{dir_name});
                    }
                    dir.createDirPath(io, dir_name) catch |err| {
                        if (builtin.os.tag == .windows) {
                            std.debug.print("ERROR: Failed to create parent dir '{s}': {}\n", .{ dir_name, err });
                        }
                        return err;
                    };
                }

                const permissions: std.Io.File.Permissions = if (builtin.os.tag == .windows)
                    .default_file
                else blk: {
                    const mode = header.mode() catch 0;
                    break :blk if (mode == 0) .default_file else .fromMode(@intCast(mode));
                };

                if (builtin.os.tag == .windows) {
                    std.debug.print("DEBUG: Creating file: '{s}'\n", .{file_name});
                }
                const file = dir.createFile(io, file_name, .{ .permissions = permissions }) catch |err| {
                    if (builtin.os.tag == .windows) {
                        std.debug.print("ERROR: Failed to create file '{s}': {}\n", .{ file_name, err });
                    }
                    return err;
                };
                defer file.close(io);

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
                    end += try reader.readSliceShort(buffer[end..]);
                    if (end - start < ask) return error.UnexpectedEndOfStream;
                    // TODO: https://github.com/ziglang/zig/issues/14039
                    const slice = buffer[start..@as(usize, @intCast(@min(file_size - file_off + start, end)))];
                    try file.writeStreamingAll(io, slice);

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
            .symbolic_link => {
                if (file_size == 0 and unstripped_file_name.len == 0) return;
                const link_name = unstripped_file_name;

                // Read the link target from the tar data
                var link_target_buffer: [1024]u8 = undefined;
                const bytes_to_read = @min(file_size, link_target_buffer.len);

                if (bytes_to_read > 0) {
                    // Ensure we have enough data in buffer
                    while (end - start < bytes_to_read) {
                        const dest_end = end - start;
                        @memcpy(buffer[0..dest_end], buffer[start..end]);
                        end = dest_end;
                        start = 0;
                        const read_n = try reader.readSliceShort(buffer[end..]);
                        if (read_n == 0) return error.UnexpectedEndOfStream;
                        end += read_n;
                    }

                    @memcpy(link_target_buffer[0..bytes_to_read], buffer[start .. start + bytes_to_read]);
                    start += file_size;

                    // Add padding
                    const rounded_link_size = std.mem.alignForward(u64, file_size, 512);
                    const link_pad_len = @as(usize, @intCast(rounded_link_size - file_size));
                    start += link_pad_len;

                    const link_target = link_target_buffer[0..bytes_to_read];

                    // Create parent directory if needed
                    if (std.fs.path.dirname(link_name)) |dir_name| {
                        try dir.createDirPath(io, dir_name);
                    }

                    // Create the symbolic link
                    if (builtin.os.tag == .windows) {
                        // On Windows, symlinks require special privileges, so skip them
                        // TODO: Consider copying the target file instead for Windows
                        std.debug.print("Skipping symlink creation on Windows: {s} -> {s}\n", .{ link_name, link_target });
                    } else {
                        dir.symLink(io, link_target, link_name, .{}) catch {
                            // On error, try to remove existing file/link and retry
                            dir.deleteFile(io, link_name) catch {};
                            dir.symLink(io, link_target, link_name, .{}) catch |err| {
                                std.debug.print("Warning: Could not create symlink {s} -> {s}: {}\n", .{ link_name, link_target, err });
                                // Continue extraction even if symlink fails
                            };
                        };
                    }
                }
            },
            .hard_link => return error.TarUnsupportedFileType,
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
        const ltrimmed = std.mem.trimStart(u8, raw, "0");
        const rtrimmed = std.mem.trimEnd(u8, ltrimmed, " \x00");
        if (rtrimmed.len == 0) return 0;
        return std.fmt.parseInt(u64, rtrimmed, 8);
    }

    pub fn is_ustar(header: Header) bool {
        return std.mem.eql(u8, header.bytes[257..][0..6], "ustar\x00");
    }

    /// Includes prefix concatenated, if any.
    /// Return value may point into Header buffer, or might point into the
    /// argument buffer.
    /// Returns error.PathTraversal if the path attempts to escape the extraction directory.
    pub fn fullFileName(header: Header, buffer: *[255]u8) ![]const u8 {
        const n = name(header);
        const result = blk: {
            if (!is_ustar(header))
                break :blk n;
            const p = prefix(header);
            if (p.len == 0)
                break :blk n;
            @memcpy(buffer[0..p.len], p);
            buffer[p.len] = '/';
            @memcpy(buffer[p.len + 1 ..][0..n.len], n);
            break :blk buffer[0 .. p.len + 1 + n.len];
        };

        // Security: reject paths that could escape the extraction directory
        // Check for absolute paths (Unix-style / or Windows-style \ or drive letters)
        if (result.len > 0 and (result[0] == '/' or result[0] == '\\')) {
            return error.PathTraversal;
        }
        // Check for Windows drive letters (e.g., C:)
        if (result.len >= 2 and result[1] == ':') {
            return error.PathTraversal;
        }

        // Check for path traversal components (..)
        // Handle both Unix (/) and Windows (\) separators
        var i: usize = 0;
        while (i < result.len) {
            // Find the end of this path component
            var j = i;
            while (j < result.len and result[j] != '/' and result[j] != '\\') {
                j += 1;
            }
            const component = result[i..j];
            if (std.mem.eql(u8, component, "..")) {
                return error.PathTraversal;
            }
            // Skip the separator
            i = if (j < result.len) j + 1 else j;
        }

        return result;
    }

    pub fn mode(header: Header) !u32 {
        const raw = header.bytes[100..][0..8];
        const ltrimmed = std.mem.trimStart(u8, raw, "0");
        const rtrimmed = std.mem.trimEnd(u8, ltrimmed, " \x00");
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

fn createWindowsLauncherScript(allocator: std.mem.Allocator, app_dir: []const u8, metadata: AppMetadata) !void {
    // Get the parent directory (contains app-<hash> and where run.bat should go)
    const parent_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidPath;
    const run_bat_path = try std.fs.path.join(allocator, &.{ parent_dir, "run.bat" });
    defer allocator.free(run_bat_path);

    // Create launcher batch file content
    const launcher_content = try std.fmt.allocPrint(allocator,
        \\@echo off
        \\:: Electrobun App Launcher
        \\:: This file launches the current version
        \\
        \\:: Set current version
        \\set CURRENT_HASH={s}
        \\set APP_DIR=%~dp0app-%CURRENT_HASH%
        \\
        \\:: TODO: Implement proper cleanup mechanism that checks for running processes
        \\:: For now, old versions are kept to avoid race conditions during updates
        \\:: :: Clean up old app versions (keep current only)
        \\:: for /d %%D in ("%~dp0app-*") do (
        \\::     if not "%%~nxD"=="app-%CURRENT_HASH%" (
        \\::         echo Removing old version: %%~nxD
        \\::         rmdir /s /q "%%D" 2>nul
        \\::     )
        \\:: )
        \\
        \\:: Launch the app
        \\cd /d "%APP_DIR%\bin"
        \\start "" launcher.exe
        \\
    , .{metadata.hash orelse "unknown"});
    defer allocator.free(launcher_content);

    // Write the launcher batch file
    const run_bat_file = try std.Io.Dir.cwd().createFile(g_io, run_bat_path, .{});
    defer run_bat_file.close(g_io);
    try run_bat_file.writeStreamingAll(g_io, launcher_content);

    std.debug.print("Created Windows launcher script: {s}\n", .{run_bat_path});
}
fn copyDirectory(allocator: std.mem.Allocator, src_path: []const u8, dest_path: []const u8) !void {
    std.debug.print("\nDEBUG copyDirectory: src='{s}' dest='{s}'\n", .{ src_path, dest_path });

    var src_dir = std.Io.Dir.cwd().openDir(g_io, src_path, .{ .iterate = true }) catch |err| {
        std.debug.print("ERROR: Failed to open source directory '{s}': {}\n", .{ src_path, err });
        return err;
    };
    defer src_dir.close(g_io);

    var iterator = src_dir.iterate();
    while (try iterator.next(g_io)) |entry| {
        const src_item_path = try std.fs.path.join(allocator, &.{ src_path, entry.name });
        defer allocator.free(src_item_path);

        const dest_item_path = try std.fs.path.join(allocator, &.{ dest_path, entry.name });
        defer allocator.free(dest_item_path);

        switch (entry.kind) {
            .directory => {
                // Create directory and recursively copy contents
                std.Io.Dir.cwd().createDir(g_io, dest_item_path, .default_dir) catch |err| switch (err) {
                    error.PathAlreadyExists => {},
                    else => return err,
                };
                try copyDirectory(allocator, src_item_path, dest_item_path);
            },
            .file => {
                // Copy file
                try std.Io.Dir.cwd().copyFile(src_item_path, std.Io.Dir.cwd(), dest_item_path, g_io, .{});
            },
            else => {
                // Skip other file types (symlinks, etc.)
                std.debug.print("Skipping file type for: {s}\n", .{entry.name});
            },
        }
    }
}

fn sanitizeWindowsPath(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    // Windows invalid characters: < > : " | ? * and control chars (0-31)
    var sanitized = try allocator.alloc(u8, path.len);
    var write_pos: usize = 0;

    for (path) |char| {
        switch (char) {
            // Replace invalid characters with underscore
            '<', '>', ':', '"', '|', '?', '*' => {
                sanitized[write_pos] = '_';
                write_pos += 1;
            },
            // Skip control characters (0-31)
            0...31 => {},
            // Keep valid characters
            else => {
                sanitized[write_pos] = char;
                write_pos += 1;
            },
        }
    }

    // Resize to actual length
    const result = try allocator.alloc(u8, write_pos);
    @memcpy(result, sanitized[0..write_pos]);
    allocator.free(sanitized);

    return result;
}
