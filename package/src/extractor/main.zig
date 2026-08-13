const std = @import("std");
const builtin = @import("builtin");
const zstd = std.compress.zstd;
const linux_uninstall_prompt = @import("linux_uninstall_prompt.zig");

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

const WINDOWS_UNINSTALL_EXE_NAME = "uninstall.exe";
const WINDOWS_UNINSTALL_MANIFEST_NAME = ".electrobun-uninstall.json";
const WINDOWS_UNINSTALL_MANIFEST_VERSION: u32 = 1;
const WINDOWS_UNINSTALL_REGISTRY_ROOT = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const LINUX_UNINSTALL_EXE_NAME = "uninstall";
const LINUX_UNINSTALL_MANIFEST_NAME = ".electrobun-uninstall.json";
const LINUX_UNINSTALL_MANIFEST_VERSION: u32 = 2;
const LINUX_LEGACY_UNINSTALL_MANIFEST_VERSION: u32 = 1;
const LINUX_DATA_PATH_VERSION: u32 = 1;
const MACOS_UNINSTALL_EXE_NAME = "uninstall";
const MACOS_UNINSTALL_MANIFEST_NAME = ".electrobun-uninstall.json";
const MACOS_UNINSTALL_MANIFEST_VERSION: u32 = 1;
const MACOS_DATA_PATH_VERSION: u32 = 1;

const macos_uninstall_ui = if (builtin.os.tag == .macos) struct {
    extern fn electrobun_show_uninstall_prompt(app_name_utf8: [*:0]const u8) c_int;
    extern fn electrobun_terminate_app_at_path(app_path_utf8: [*:0]const u8) c_int;
} else struct {};

const windows_uninstall_sync = if (builtin.os.tag == .windows) struct {
    const win = std.os.windows;
    extern "kernel32" fn CreateMutexW(
        lp_mutex_attributes: ?*anyopaque,
        initial_owner: win.BOOL,
        name: [*:0]const u16,
    ) callconv(.winapi) ?win.HANDLE;
    extern "kernel32" fn WaitForSingleObject(handle: win.HANDLE, milliseconds: win.DWORD) callconv(.winapi) win.DWORD;
    extern "kernel32" fn ReleaseMutex(handle: win.HANDLE) callconv(.winapi) win.BOOL;
    extern "kernel32" fn CloseHandle(handle: win.HANDLE) callconv(.winapi) win.BOOL;

    const wait_object_0: win.DWORD = 0x00000000;
    const wait_abandoned: win.DWORD = 0x00000080;
    const infinite: win.DWORD = 0xffffffff;
} else struct {};

// Metadata structure embedded in the binary
const AppMetadata = struct {
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    hash: ?[]const u8 = null,
};

const WindowsUninstallManifest = struct {
    schema_version: u32,
    install_nonce: []const u8,
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    desktop_shortcut: []const u8,
    start_menu_shortcut: []const u8,
};

const LinuxDesktopIntegration = struct {
    application_entry: ?[]u8 = null,
    desktop_entry: ?[]u8 = null,
    application_entry_sha256: ?[]u8 = null,
    desktop_entry_sha256: ?[]u8 = null,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        if (self.application_entry) |path| allocator.free(path);
        if (self.desktop_entry) |path| allocator.free(path);
        if (self.application_entry_sha256) |hash| allocator.free(hash);
        if (self.desktop_entry_sha256) |hash| allocator.free(hash);
        self.* = .{};
    }
};

const LinuxUninstallManifest = struct {
    schema_version: u32,
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    version: []const u8,
    application_entry: []const u8,
    desktop_entry: []const u8,
    application_entry_sha256: []const u8,
    desktop_entry_sha256: []const u8,
    data_path_versions: ?[]const u32 = null,
    home: ?[]const u8 = null,
    xdg_cache_home: ?[]const u8 = null,
    xdg_state_home: ?[]const u8 = null,
};

const LinuxUninstallMode = enum {
    app,
    app_and_data,
};

const LinuxManagerCommand = union(enum) {
    uninstall: ?LinuxUninstallMode,
    refresh_metadata,
};

fn parseLinuxManagerCommand(args: []const []const u8) !LinuxManagerCommand {
    if (args.len == 0) return .{ .uninstall = null };
    if (std.mem.eql(u8, args[0], "--uninstall")) {
        return switch (args.len) {
            1 => .{ .uninstall = null },
            2 => if (std.mem.eql(u8, args[1], "--quiet"))
                .{ .uninstall = .app }
            else
                error.InvalidArguments,
            3 => if (std.mem.eql(u8, args[1], "--quiet") and
                std.mem.eql(u8, args[2], "--delete-data"))
                .{ .uninstall = .app_and_data }
            else
                error.InvalidArguments,
            else => error.InvalidArguments,
        };
    }
    if (std.mem.eql(u8, args[0], "--quiet")) {
        return switch (args.len) {
            1 => .{ .uninstall = .app },
            2 => if (std.mem.eql(u8, args[1], "--delete-data"))
                .{ .uninstall = .app_and_data }
            else
                error.InvalidArguments,
            else => error.InvalidArguments,
        };
    }
    if (std.mem.eql(u8, args[0], "--refresh-metadata") and
        args.len == 2 and
        std.mem.eql(u8, args[1], "--quiet"))
    {
        return .refresh_metadata;
    }
    return error.InvalidArguments;
}

const MacosUninstallManifest = struct {
    schema_version: u32,
    install_nonce: []const u8,
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    version: []const u8,
    app_bundle_path: []const u8,
    app_path_token: []const u8,
    data_path_versions: []const u32,
};

const MacosUninstallMode = enum {
    app,
    app_and_data,
};

const MacosManagerCommand = union(enum) {
    uninstall: ?MacosUninstallMode,
    refresh_metadata,
};

fn parseMacosManagerCommand(args: []const []const u8) !MacosManagerCommand {
    if (args.len == 0) return .{ .uninstall = null };
    if (std.mem.eql(u8, args[0], "--uninstall")) {
        return switch (args.len) {
            1 => .{ .uninstall = null },
            2 => if (std.mem.eql(u8, args[1], "--quiet"))
                .{ .uninstall = .app }
            else
                error.InvalidArguments,
            3 => if (std.mem.eql(u8, args[1], "--quiet") and
                std.mem.eql(u8, args[2], "--delete-data"))
                .{ .uninstall = .app_and_data }
            else
                error.InvalidArguments,
            else => error.InvalidArguments,
        };
    }
    if (std.mem.eql(u8, args[0], "--quiet")) {
        return switch (args.len) {
            1 => .{ .uninstall = .app },
            2 => if (std.mem.eql(u8, args[1], "--delete-data"))
                .{ .uninstall = .app_and_data }
            else
                error.InvalidArguments,
            else => error.InvalidArguments,
        };
    }
    if (std.mem.eql(u8, args[0], "--refresh-metadata") and
        args.len == 2 and
        std.mem.eql(u8, args[1], "--quiet"))
    {
        return .refresh_metadata;
    }
    return error.InvalidArguments;
}

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
    if (builtin.os.tag == .windows and
        (!isSafeWindowsComponent(metadata.identifier) or !isSafeWindowsComponent(metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }
    if (builtin.os.tag == .linux and
        (!isSafeLinuxComponent(metadata.identifier) or !isSafeLinuxComponent(metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }

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

    if (builtin.os.tag == .windows) {
        var uninstall_lock = try acquireWindowsUninstallLock(allocator, app_base_dir);
        defer uninstall_lock.release();
        return try extractAndInstall(allocator, compressed_data, metadata, self_extraction_dir, app_dir);
    }

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
    if (builtin.os.tag == .windows and
        (!isSafeWindowsComponent(safe_metadata.identifier) or !isSafeWindowsComponent(safe_metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }
    if (builtin.os.tag == .linux and
        (!isSafeLinuxComponent(safe_metadata.identifier) or !isSafeLinuxComponent(safe_metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }

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

    // Serialize the complete Windows install against uninstall and deferred
    // cleanup. This prevents an uninstall that is already running from
    // deleting a newly extracted app before its integration files are written.
    if (builtin.os.tag == .windows) {
        var uninstall_lock = try acquireWindowsUninstallLock(allocator, app_base_dir);
        defer uninstall_lock.release();
        return try extractAndInstall(allocator, compressed_data, safe_metadata, self_extraction_dir, app_dir);
    }

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
    if (builtin.os.tag == .windows and !isSafeWindowsComponent(app_bundle_name)) {
        return error.InvalidAppBundleName;
    }
    if (builtin.os.tag == .linux and !isSafeLinuxComponent(app_bundle_name)) {
        return error.InvalidAppBundleName;
    }
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

    // Commit platform integration only after both the app and updater state are
    // in place. Package-managed Linux formats never execute this extractor.
    if (builtin.os.tag == .linux) {
        try installLinuxIntegration(allocator, app_dir, metadata);
    } else if (builtin.os.tag == .windows) {
        try installWindowsIntegration(allocator, app_dir, metadata, exe_path);
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
            const local_appdata = getEnvOwned(allocator, "LOCALAPPDATA") catch {
                // Fallback to user profile
                const userprofile = try getEnvOwned(allocator, "USERPROFILE");
                defer allocator.free(userprofile);
                break :blk try std.fs.path.join(allocator, &.{ userprofile, "AppData", "Local" });
            };
            break :blk local_appdata;
        },
        .linux => blk: {
            break :blk try linuxXdgRoot(allocator, "XDG_DATA_HOME", &.{ ".local", "share" });
        },
        else => @compileError("Unsupported platform for app data directory"),
    };
}

fn isValidLinuxAbsoluteRoot(path: []const u8) bool {
    if (!std.fs.path.isAbsolute(path) or path.len <= 1 or path[path.len - 1] == std.fs.path.sep) {
        return false;
    }
    var parts = std.mem.splitScalar(u8, path[1..], std.fs.path.sep);
    while (parts.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".") or std.mem.eql(u8, part, "..") or
            std.mem.indexOfScalar(u8, part, 0) != null) return false;
    }
    return true;
}

fn linuxHome(allocator: std.mem.Allocator) ![]u8 {
    const home = g_environ_map.get("HOME") orelse return error.EnvironmentVariableNotFound;
    if (home.len == 0 or !std.fs.path.isAbsolute(home)) return error.InvalidEnvironmentRoot;
    const resolved = try std.fs.path.resolve(allocator, &.{home});
    if (!isValidLinuxAbsoluteRoot(resolved)) {
        allocator.free(resolved);
        return error.InvalidEnvironmentRoot;
    }
    return resolved;
}

fn linuxXdgRoot(
    allocator: std.mem.Allocator,
    key: []const u8,
    fallback_parts: []const []const u8,
) ![]u8 {
    if (g_environ_map.get(key)) |value| {
        if (value.len != 0 and std.fs.path.isAbsolute(value)) {
            const resolved = try std.fs.path.resolve(allocator, &.{value});
            if (isValidLinuxAbsoluteRoot(resolved)) return resolved;
            allocator.free(resolved);
        }
    }
    const home = try linuxHome(allocator);
    defer allocator.free(home);
    var parts: std.ArrayList([]const u8) = .empty;
    defer parts.deinit(allocator);
    try parts.append(allocator, home);
    try parts.appendSlice(allocator, fallback_parts);
    const result = try std.fs.path.join(allocator, parts.items);
    if (!isValidLinuxAbsoluteRoot(result)) {
        allocator.free(result);
        return error.InvalidEnvironmentRoot;
    }
    return result;
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
            const escaped_launcher_path = try escapeDesktopString(allocator, launcher_path);
            defer allocator.free(escaped_launcher_path);
            try result.appendSlice(allocator, "Exec=\"");
            try result.appendSlice(allocator, escaped_launcher_path);
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

fn createDesktopShortcut(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
    normalized_home: []const u8,
    data_home_path: []const u8,
    preserved_application_entry: ?[]const u8,
    preserved_desktop_entry: ?[]const u8,
) !LinuxDesktopIntegration {
    var integration: LinuxDesktopIntegration = .{};
    errdefer integration.deinit(allocator);

    // Build desktop file path
    const desktop_dir = try std.fs.path.join(allocator, &.{ normalized_home, "Desktop" });
    defer allocator.free(desktop_dir);

    var desktop_dir_handle = openOptionalLinuxAbsoluteDirNoSymlinks(desktop_dir) catch |err| blk: {
        std.debug.print("Note: Unsafe or unavailable Desktop directory at {s}: {}; skipping Desktop shortcut creation\n", .{ desktop_dir, err });
        break :blk null;
    };
    defer if (desktop_dir_handle) |*dir| dir.close(g_io);

    const applications_dir = try std.fs.path.join(allocator, &.{ data_home_path, "applications" });
    defer allocator.free(applications_dir);
    var applications_dir_handle: ?std.Io.Dir = blk: {
        var data_home_dir = openLinuxAbsoluteDirNoSymlinks(data_home_path) catch |err| {
            std.debug.print("Warning: Unsafe or unavailable XDG data directory: {}\n", .{err});
            break :blk null;
        };
        defer data_home_dir.close(g_io);
        data_home_dir.createDir(g_io, "applications", .default_dir) catch |err| switch (err) {
            error.PathAlreadyExists => {},
            else => {
                std.debug.print("Warning: Could not create applications directory: {}\n", .{err});
                break :blk null;
            },
        };
        break :blk data_home_dir.openDir(g_io, "applications", .{
            .follow_symlinks = false,
            .iterate = true,
        }) catch |err| {
            std.debug.print("Warning: Unsafe applications directory: {}\n", .{err});
            break :blk null;
        };
    };
    defer if (applications_dir_handle) |*dir| dir.close(g_io);

    // On Linux, look for the launcher binary in the app directory
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher" });
    defer allocator.free(launcher_path);

    // Check if launcher exists
    std.Io.Dir.cwd().access(g_io, launcher_path, .{}) catch |err| {
        std.debug.print("Warning: launcher binary not found at {s}: {}\n", .{ launcher_path, err });
        return integration;
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
            var entry_digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(rewritten_desktop, &entry_digest, .{});
            const entry_hash = std.fmt.bytesToHex(entry_digest, .lower);

            // Write the updated desktop file to Desktop (optional)
            if (desktop_dir_handle != null) {
                desktop_shortcut: {
                    if (preserved_desktop_entry) |preserved_path| {
                        if (std.mem.eql(u8, preserved_path, desktop_file_path)) {
                            std.debug.print("Preserving user-edited Desktop entry: {s}\n", .{desktop_file_path});
                            break :desktop_shortcut;
                        }
                    }
                    const desktop_file = desktop_dir_handle.?.createFile(
                        g_io,
                        desktop_filename,
                        .{ .exclusive = true },
                    ) catch |err| switch (err) {
                        error.PathAlreadyExists => {
                            std.debug.print("Preserving pre-existing Desktop entry: {s}\n", .{desktop_file_path});
                            break :desktop_shortcut;
                        },
                        else => {
                            std.debug.print("Warning: Could not create Desktop shortcut file: {}\n", .{err});
                            break :desktop_shortcut;
                        },
                    };
                    defer desktop_file.close(g_io);
                    desktop_file.writeStreamingAll(g_io, rewritten_desktop) catch |err| {
                        std.debug.print("Warning: Could not write Desktop shortcut file: {}\n", .{err});
                        desktop_dir_handle.?.deleteFile(g_io, desktop_filename) catch {};
                        break :desktop_shortcut;
                    };
                    desktop_file.setPermissions(g_io, .fromMode(0o755)) catch |err| {
                        std.debug.print("Warning: Could not set Desktop shortcut permissions: {}\n", .{err});
                        desktop_dir_handle.?.deleteFile(g_io, desktop_filename) catch {};
                        break :desktop_shortcut;
                    };
                    integration.desktop_entry = try allocator.dupe(u8, desktop_file_path);
                    integration.desktop_entry_sha256 = try allocator.dupe(u8, &entry_hash);
                    desktop_shortcut_created = true;
                }
            }

            // Also write to XDG applications directory for menu integration
            // This ensures the app appears in the desktop environment's application menu
            // This is optional - failure should not prevent the desktop shortcut from working
            write_applications_dir: {
                const applications_handle = applications_dir_handle orelse break :write_applications_dir;

                const applications_file_path = std.fs.path.join(allocator, &.{ applications_dir, desktop_filename }) catch |err| {
                    std.debug.print("Warning: Could not build applications file path: {}\n", .{err});
                    break :write_applications_dir;
                };
                defer allocator.free(applications_file_path);

                if (preserved_application_entry) |preserved_path| {
                    if (std.mem.eql(u8, preserved_path, applications_file_path)) {
                        std.debug.print("Preserving user-edited application entry: {s}\n", .{applications_file_path});
                        break :write_applications_dir;
                    }
                }

                const applications_file = applications_handle.createFile(
                    g_io,
                    desktop_filename,
                    .{ .exclusive = true },
                ) catch |err| switch (err) {
                    error.PathAlreadyExists => {
                        std.debug.print("Preserving pre-existing application entry: {s}\n", .{applications_file_path});
                        break :write_applications_dir;
                    },
                    else => {
                        std.debug.print("Warning: Could not create applications desktop file: {}\n", .{err});
                        break :write_applications_dir;
                    },
                };
                defer applications_file.close(g_io);

                applications_file.writeStreamingAll(g_io, rewritten_desktop) catch |err| {
                    std.debug.print("Warning: Could not write applications desktop file: {}\n", .{err});
                    applications_handle.deleteFile(g_io, desktop_filename) catch {};
                    break :write_applications_dir;
                };

                // Set permissions on the desktop file (0o644 - readable, not executable)
                // Desktop files in ~/.local/share/applications/ don't need execute bit
                // (execute bit is only needed for Desktop surface, not application menus)
                applications_file.setPermissions(g_io, .fromMode(0o644)) catch |err| {
                    std.debug.print("Warning: Could not set applications entry permissions: {}\n", .{err});
                    applications_handle.deleteFile(g_io, desktop_filename) catch {};
                    break :write_applications_dir;
                };

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
                integration.application_entry = try allocator.dupe(u8, applications_file_path);
                integration.application_entry_sha256 = try allocator.dupe(u8, &entry_hash);
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
    return integration;
}

fn processExitedSuccessfully(term: std.process.Child.Term) bool {
    return switch (term) {
        .exited => |code| code == 0,
        else => false,
    };
}

fn runWindowsCommand(argv: []const []const u8) !bool {
    var child = try std.process.spawn(g_io, .{
        .argv = argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = true,
    });
    return processExitedSuccessfully(try child.wait(g_io));
}

fn runWindowsCommandChecked(argv: []const []const u8) !void {
    if (!try runWindowsCommand(argv)) return error.WindowsCommandFailed;
}

fn isSafeWindowsComponent(value: []const u8) bool {
    if (value.len == 0 or std.mem.eql(u8, value, ".") or std.mem.eql(u8, value, "..")) return false;
    if (value[value.len - 1] == ' ' or value[value.len - 1] == '.') return false;
    for (value) |byte| switch (byte) {
        0...31, '"', '%', '*', '/', ':', '<', '>', '?', '\\', '|' => return false,
        else => {},
    };
    return true;
}

fn windowsDisplayName(allocator: std.mem.Allocator, app_name: []const u8, channel: []const u8) ![]u8 {
    if (isProductionChannel(channel)) return allocator.dupe(u8, app_name);
    if (std.mem.eql(u8, channel, "canary")) return std.fmt.allocPrint(allocator, "{s} (Canary)", .{app_name});
    if (std.mem.eql(u8, channel, "dev")) return std.fmt.allocPrint(allocator, "{s} (Development)", .{app_name});
    return std.fmt.allocPrint(allocator, "{s} ({s})", .{ app_name, channel });
}

fn windowsShortcutFileName(allocator: std.mem.Allocator, app_name: []const u8, channel: []const u8) ![]u8 {
    const display_name = try windowsDisplayName(allocator, app_name, channel);
    defer allocator.free(display_name);

    var sanitized: std.ArrayList(u8) = .empty;
    errdefer sanitized.deinit(allocator);
    for (display_name) |byte| {
        const replacement: u8 = switch (byte) {
            0...31, '<', '>', ':', '"', '/', '\\', '|', '?', '*' => '_',
            else => byte,
        };
        try sanitized.append(allocator, replacement);
    }
    while (sanitized.items.len > 0 and
        (sanitized.items[sanitized.items.len - 1] == ' ' or sanitized.items[sanitized.items.len - 1] == '.'))
    {
        _ = sanitized.pop();
    }
    if (sanitized.items.len == 0) try sanitized.appendSlice(allocator, "Electrobun App");
    try sanitized.appendSlice(allocator, ".lnk");
    return sanitized.toOwnedSlice(allocator);
}

fn powershellSingleQuoted(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var escaped: std.ArrayList(u8) = .empty;
    errdefer escaped.deinit(allocator);
    for (value) |byte| {
        try escaped.append(allocator, byte);
        if (byte == '\'') try escaped.append(allocator, '\'');
    }
    return escaped.toOwnedSlice(allocator);
}

fn queryWindowsKnownFolder(allocator: std.mem.Allocator, special_folder: []const u8) ![]u8 {
    const command = try std.fmt.allocPrint(
        allocator,
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Environment]::GetFolderPath([Environment+SpecialFolder]::{s})",
        .{special_folder},
    );
    defer allocator.free(command);
    const argv = [_][]const u8{
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        command,
    };
    const result = try std.process.run(allocator, g_io, .{
        .argv = &argv,
        .stdout_limit = .limited(32 * 1024),
        .stderr_limit = .limited(32 * 1024),
        .create_no_window = true,
    });
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    if (!processExitedSuccessfully(result.term)) return error.KnownFolderLookupFailed;
    const path = std.mem.trim(u8, result.stdout, " \t\r\n");
    if (path.len == 0 or !std.fs.path.isAbsolute(path)) return error.KnownFolderLookupFailed;
    return allocator.dupe(u8, path);
}

fn getWindowsDesktopDir(allocator: std.mem.Allocator) ![]u8 {
    return queryWindowsKnownFolder(allocator, "DesktopDirectory") catch {
        const userprofile = try getEnvOwned(allocator, "USERPROFILE");
        defer allocator.free(userprofile);
        return std.fs.path.join(allocator, &.{ userprofile, "Desktop" });
    };
}

fn getWindowsProgramsDir(allocator: std.mem.Allocator) ![]u8 {
    return queryWindowsKnownFolder(allocator, "Programs") catch {
        const appdata = getEnvOwned(allocator, "APPDATA") catch blk: {
            const userprofile = try getEnvOwned(allocator, "USERPROFILE");
            defer allocator.free(userprofile);
            break :blk try std.fs.path.join(allocator, &.{ userprofile, "AppData", "Roaming" });
        };
        defer allocator.free(appdata);
        return std.fs.path.join(allocator, &.{ appdata, "Microsoft", "Windows", "Start Menu", "Programs" });
    };
}

fn createWindowsShortcutFile(
    allocator: std.mem.Allocator,
    lnk_path: []const u8,
    target_path: []const u8,
    working_dir: []const u8,
    icon_path: []const u8,
) !void {
    const escaped_lnk = try powershellSingleQuoted(allocator, lnk_path);
    defer allocator.free(escaped_lnk);
    const escaped_target = try powershellSingleQuoted(allocator, target_path);
    defer allocator.free(escaped_target);
    const escaped_working = try powershellSingleQuoted(allocator, working_dir);
    defer allocator.free(escaped_working);
    const escaped_icon = try powershellSingleQuoted(allocator, icon_path);
    defer allocator.free(escaped_icon);

    const ps_content = try std.fmt.allocPrint(allocator,
        \\$WshShell = New-Object -ComObject WScript.Shell
        \\$Shortcut = $WshShell.CreateShortcut('{s}')
        \\$Shortcut.TargetPath = '{s}'
        \\$Shortcut.WorkingDirectory = '{s}'
        \\$Shortcut.IconLocation = '{s}'
        \\$Shortcut.WindowStyle = 1
        \\$Shortcut.Save()
        \\
    , .{ escaped_lnk, escaped_target, escaped_working, escaped_icon });
    defer allocator.free(ps_content);

    const ps_args = [_][]const u8{
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        ps_content,
    };
    try runWindowsCommandChecked(&ps_args);
    std.debug.print("Created Windows shortcut: {s}\n", .{lnk_path});
}

fn deleteWindowsShortcutIfTargets(
    allocator: std.mem.Allocator,
    shortcut_path: []const u8,
    expected_target: []const u8,
) !void {
    const escaped_shortcut = try powershellSingleQuoted(allocator, shortcut_path);
    defer allocator.free(escaped_shortcut);
    const escaped_target = try powershellSingleQuoted(allocator, expected_target);
    defer allocator.free(escaped_target);

    const command = try std.fmt.allocPrint(allocator,
        \\$ErrorActionPreference = 'Stop'
        \\if (-not (Test-Path -LiteralPath '{s}' -PathType Leaf)) {{ exit 0 }}
        \\$WshShell = New-Object -ComObject WScript.Shell
        \\$Target = $WshShell.CreateShortcut('{s}').TargetPath
        \\if ([String]::IsNullOrWhiteSpace($Target)) {{ exit 0 }}
        \\$Target = [Environment]::ExpandEnvironmentVariables($Target)
        \\$Actual = [IO.Path]::GetFullPath($Target)
        \\$Expected = [IO.Path]::GetFullPath('{s}')
        \\if ([String]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) {{
        \\    Remove-Item -LiteralPath '{s}' -Force
        \\}}
        \\
    , .{ escaped_shortcut, escaped_shortcut, escaped_target, escaped_shortcut });
    defer allocator.free(command);

    const argv = [_][]const u8{
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        command,
    };
    try runWindowsCommandChecked(&argv);
}

fn deleteObsoleteWindowsShortcut(
    allocator: std.mem.Allocator,
    shortcut_path: []const u8,
    current_shortcut_path: []const u8,
    expected_target: []const u8,
) !void {
    if (try windowsPathsEqual(allocator, shortcut_path, current_shortcut_path)) return;
    try deleteWindowsShortcutIfTargets(allocator, shortcut_path, expected_target);
}

fn removePreviousWindowsShortcuts(
    allocator: std.mem.Allocator,
    manifest_path: []const u8,
    identifier: []const u8,
    channel: []const u8,
    desktop_dir: []const u8,
    programs_dir: []const u8,
    current_desktop_shortcut: []const u8,
    current_start_menu_shortcut: []const u8,
    expected_target: []const u8,
) !void {
    const contents = std.Io.Dir.cwd().readFileAlloc(
        g_io,
        manifest_path,
        allocator,
        .limited(64 * 1024),
    ) catch |err| switch (err) {
        error.FileNotFound => return,
        else => return err,
    };
    defer allocator.free(contents);

    const parsed = try std.json.parseFromSlice(
        struct {
            identifier: []const u8,
            channel: []const u8,
            desktop_shortcut: []const u8,
            start_menu_shortcut: []const u8,
        },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    if (!std.ascii.eqlIgnoreCase(parsed.value.identifier, identifier) or
        !std.ascii.eqlIgnoreCase(parsed.value.channel, channel))
    {
        return;
    }

    const previous_desktop_name = std.fs.path.basename(parsed.value.desktop_shortcut);
    if (std.ascii.endsWithIgnoreCase(previous_desktop_name, ".lnk")) {
        const previous_desktop = try std.fs.path.join(allocator, &.{ desktop_dir, previous_desktop_name });
        defer allocator.free(previous_desktop);
        try deleteObsoleteWindowsShortcut(
            allocator,
            previous_desktop,
            current_desktop_shortcut,
            expected_target,
        );
    }

    const previous_start_name = std.fs.path.basename(parsed.value.start_menu_shortcut);
    if (std.ascii.endsWithIgnoreCase(previous_start_name, ".lnk")) {
        const previous_start = try std.fs.path.join(allocator, &.{ programs_dir, previous_start_name });
        defer allocator.free(previous_start);
        try deleteObsoleteWindowsShortcut(
            allocator,
            previous_start,
            current_start_menu_shortcut,
            expected_target,
        );
    }
}

fn removeLegacyWindowsShortcuts(
    allocator: std.mem.Allocator,
    app_name: []const u8,
    desktop_dir: []const u8,
    programs_dir: []const u8,
    current_desktop_shortcut: []const u8,
    current_start_menu_shortcut: []const u8,
    expected_target: []const u8,
) !void {
    // Older installers used the unqualified app name for every channel. The
    // target check is what makes removing that shared legacy name channel-safe.
    const legacy_name = try windowsShortcutFileName(allocator, app_name, "production");
    defer allocator.free(legacy_name);
    const legacy_desktop = try std.fs.path.join(allocator, &.{ desktop_dir, legacy_name });
    defer allocator.free(legacy_desktop);
    try deleteObsoleteWindowsShortcut(
        allocator,
        legacy_desktop,
        current_desktop_shortcut,
        expected_target,
    );
    const legacy_start = try std.fs.path.join(allocator, &.{ programs_dir, legacy_name });
    defer allocator.free(legacy_start);
    try deleteObsoleteWindowsShortcut(
        allocator,
        legacy_start,
        current_start_menu_shortcut,
        expected_target,
    );
}

fn windowsUninstallRegistryKey(allocator: std.mem.Allocator, identifier: []const u8, channel: []const u8) ![]u8 {
    if (!isSafeWindowsComponent(identifier) or !isSafeWindowsComponent(channel)) {
        return error.InvalidInstallIdentity;
    }
    return std.fmt.allocPrint(
        allocator,
        "{s}\\{s}.{s}",
        .{ WINDOWS_UNINSTALL_REGISTRY_ROOT, identifier, channel },
    );
}

fn parseInstalledVersion(allocator: std.mem.Allocator, contents: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(
        struct { version: []const u8 },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    if (parsed.value.version.len == 0) return error.InvalidAppVersion;
    return allocator.dupe(u8, parsed.value.version);
}

fn readInstalledVersion(allocator: std.mem.Allocator, app_dir: []const u8) ![]u8 {
    const version_path = try std.fs.path.join(allocator, &.{ app_dir, "Resources", "version.json" });
    defer allocator.free(version_path);
    const contents = std.Io.Dir.cwd().readFileAlloc(g_io, version_path, allocator, .limited(1024 * 1024)) catch |err| {
        std.debug.print("Warning: Could not read installed version metadata at {s}: {}\n", .{ version_path, err });
        return allocator.dupe(u8, "0.0.0");
    };
    defer allocator.free(contents);
    return parseInstalledVersion(allocator, contents) catch |err| {
        std.debug.print("Warning: Could not parse installed version metadata at {s}: {}\n", .{ version_path, err });
        return allocator.dupe(u8, "0.0.0");
    };
}

fn linuxDisplayNameFromDesktop(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
    channel: []const u8,
    fallback: []const u8,
) ![]u8 {
    var app_dir_handle = std.Io.Dir.cwd().openDir(g_io, app_dir, .{ .iterate = true }) catch {
        return allocator.dupe(u8, fallback);
    };
    defer app_dir_handle.close(g_io);
    var iterator = app_dir_handle.iterate();
    while (try iterator.next(g_io)) |entry| {
        if (entry.kind != .file or desktopEntryInstallName(entry.name) == null) continue;
        const desktop_path = try std.fs.path.join(allocator, &.{ app_dir, entry.name });
        defer allocator.free(desktop_path);
        const contents = std.Io.Dir.cwd().readFileAlloc(
            g_io,
            desktop_path,
            allocator,
            .limited(1024 * 1024),
        ) catch continue;
        defer allocator.free(contents);
        var lines = std.mem.tokenizeScalar(u8, contents, '\n');
        while (lines.next()) |line| {
            if (!std.mem.startsWith(u8, line, "Name=")) continue;
            var display_name = std.mem.trim(u8, line["Name=".len..], " \t\r");
            const channel_suffix = if (std.mem.eql(u8, channel, "canary"))
                " (Canary)"
            else if (std.mem.eql(u8, channel, "dev"))
                " (Development)"
            else
                "";
            if (channel_suffix.len != 0 and std.mem.endsWith(u8, display_name, channel_suffix)) {
                display_name = display_name[0 .. display_name.len - channel_suffix.len];
            }
            if (display_name.len != 0) return allocator.dupe(u8, display_name);
        }
    }
    return allocator.dupe(u8, fallback);
}

fn readInstalledLinuxIdentity(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
    manifest: LinuxUninstallManifest,
) !struct { version: []u8, name: []u8 } {
    const version_path = try std.fs.path.join(allocator, &.{ app_dir, "Resources", "version.json" });
    defer allocator.free(version_path);
    const contents = try std.Io.Dir.cwd().readFileAlloc(
        g_io,
        version_path,
        allocator,
        .limited(1024 * 1024),
    );
    defer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        struct {
            version: []const u8,
            identifier: []const u8,
            channel: []const u8,
        },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    if (parsed.value.version.len == 0 or
        !std.mem.eql(u8, parsed.value.identifier, manifest.identifier) or
        !std.mem.eql(u8, parsed.value.channel, manifest.channel))
    {
        return error.InvalidInstalledIdentity;
    }
    const version = try allocator.dupe(u8, parsed.value.version);
    errdefer allocator.free(version);
    const name = try linuxDisplayNameFromDesktop(
        allocator,
        app_dir,
        manifest.channel,
        manifest.name,
    );
    if (!isSafeLinuxDisplayName(name)) {
        allocator.free(name);
        return error.InvalidInstalledIdentity;
    }
    return .{ .version = version, .name = name };
}

fn getWindowsRegExePath(allocator: std.mem.Allocator) ![]u8 {
    const system_root = getEnvOwned(allocator, "SYSTEMROOT") catch allocator.dupe(u8, "C:\\Windows") catch return error.OutOfMemory;
    defer allocator.free(system_root);
    return std.fs.path.join(allocator, &.{ system_root, "System32", "reg.exe" });
}

fn registryKeyExists(reg_exe: []const u8, key: []const u8) !bool {
    const argv = [_][]const u8{ reg_exe, "query", key, "/reg:64" };
    return runWindowsCommand(&argv);
}

fn deleteWindowsUninstallEntry(allocator: std.mem.Allocator, identifier: []const u8, channel: []const u8) !void {
    const key = try windowsUninstallRegistryKey(allocator, identifier, channel);
    defer allocator.free(key);
    const reg_exe = try getWindowsRegExePath(allocator);
    defer allocator.free(reg_exe);
    const argv = [_][]const u8{ reg_exe, "delete", key, "/f", "/reg:64" };
    // The entry is expected to exist for a registered installation. Treat any
    // delete failure as fatal so an access/registry error cannot orphan an
    // Installed Apps entry with a dead command after self-cleanup.
    try runWindowsCommandChecked(&argv);
}

fn registerWindowsUninstallEntry(
    allocator: std.mem.Allocator,
    manifest: WindowsUninstallManifest,
    app_dir: []const u8,
    uninstall_path: []const u8,
) !void {
    const key = try windowsUninstallRegistryKey(allocator, manifest.identifier, manifest.channel);
    defer allocator.free(key);
    const reg_exe = try getWindowsRegExePath(allocator);
    defer allocator.free(reg_exe);

    const display_name = try windowsDisplayName(allocator, manifest.name, manifest.channel);
    defer allocator.free(display_name);
    const version = try readInstalledVersion(allocator, app_dir);
    defer allocator.free(version);
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(launcher_path);
    const display_icon = try std.fmt.allocPrint(allocator, "\"{s}\",0", .{launcher_path});
    defer allocator.free(display_icon);
    const uninstall_command = try std.fmt.allocPrint(allocator, "\"{s}\" --uninstall", .{uninstall_path});
    defer allocator.free(uninstall_command);
    const quiet_uninstall_command = try std.fmt.allocPrint(allocator, "\"{s}\" --uninstall --quiet", .{uninstall_path});
    defer allocator.free(quiet_uninstall_command);

    const values = [_]struct { name: []const u8, kind: []const u8, data: []const u8 }{
        .{ .name = "DisplayName", .kind = "REG_SZ", .data = display_name },
        .{ .name = "DisplayVersion", .kind = "REG_SZ", .data = version },
        .{ .name = "DisplayIcon", .kind = "REG_SZ", .data = display_icon },
        .{ .name = "InstallLocation", .kind = "REG_SZ", .data = app_dir },
        .{ .name = "UninstallString", .kind = "REG_SZ", .data = uninstall_command },
        .{ .name = "QuietUninstallString", .kind = "REG_SZ", .data = quiet_uninstall_command },
        .{ .name = "NoModify", .kind = "REG_DWORD", .data = "1" },
        .{ .name = "NoRepair", .kind = "REG_DWORD", .data = "1" },
    };

    // A refresh updates an existing entry value-by-value. If one write fails,
    // retain the previous entry (with any successful new values) rather than
    // deleting a still-usable uninstaller registration. A brand-new partial
    // entry is safe to remove because there was no prior registration to lose.
    const key_existed_before = try registryKeyExists(reg_exe, key);
    errdefer if (!key_existed_before) {
        const delete_argv = [_][]const u8{ reg_exe, "delete", key, "/f", "/reg:64" };
        if (!(runWindowsCommand(&delete_argv) catch false)) {
            std.debug.print("Warning: Could not clean up incomplete Windows uninstaller registration: {s}\n", .{key});
        }
    };
    for (values) |value| {
        const argv = [_][]const u8{
            reg_exe, "add", key, "/v", value.name, "/t", value.kind, "/d", value.data, "/f", "/reg:64",
        };
        try runWindowsCommandChecked(&argv);
    }
    std.debug.print("Registered Windows uninstaller: {s}\n", .{key});
}

fn windowsPathsEqual(allocator: std.mem.Allocator, left: []const u8, right: []const u8) !bool {
    const resolved_left = try std.fs.path.resolve(allocator, &.{left});
    defer allocator.free(resolved_left);
    const resolved_right = try std.fs.path.resolve(allocator, &.{right});
    defer allocator.free(resolved_right);
    return std.ascii.eqlIgnoreCase(resolved_left, resolved_right);
}

fn isValidWindowsInstallNonce(nonce: []const u8) bool {
    if (nonce.len != 32) return false;
    for (nonce) |byte| {
        if (!std.ascii.isHex(byte)) return false;
    }
    return true;
}

fn createWindowsInstallNonce() [32]u8 {
    var random_bytes: [16]u8 = undefined;
    g_io.random(&random_bytes);
    return std.fmt.bytesToHex(random_bytes, .lower);
}

fn windowsInstallNonceMatches(current: []const u8, expected: []const u8) bool {
    return isValidWindowsInstallNonce(current) and
        isValidWindowsInstallNonce(expected) and
        std.mem.eql(u8, current, expected);
}

const WindowsUninstallLock = if (builtin.os.tag == .windows) struct {
    handle: std.os.windows.HANDLE,

    fn release(self: *@This()) void {
        _ = windows_uninstall_sync.ReleaseMutex(self.handle);
        _ = windows_uninstall_sync.CloseHandle(self.handle);
    }
} else struct {};

fn acquireWindowsUninstallLock(allocator: std.mem.Allocator, base_dir: []const u8) !WindowsUninstallLock {
    if (builtin.os.tag != .windows) unreachable;

    const resolved_base = try std.fs.path.resolve(allocator, &.{base_dir});
    defer allocator.free(resolved_base);
    const normalized_base = try allocator.dupe(u8, resolved_base);
    defer allocator.free(normalized_base);
    _ = std.ascii.lowerString(normalized_base, resolved_base);
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(normalized_base);
    hasher.final(&digest);
    const mutex_name = try std.fmt.allocPrint(allocator, "Local\\ElectrobunUninstall_{x}", .{digest[0..16]});
    defer allocator.free(mutex_name);
    const mutex_name_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, mutex_name);
    defer allocator.free(mutex_name_w);

    const handle = windows_uninstall_sync.CreateMutexW(null, .FALSE, mutex_name_w.ptr) orelse
        return error.UninstallLockFailed;
    errdefer _ = windows_uninstall_sync.CloseHandle(handle);
    const wait_result = windows_uninstall_sync.WaitForSingleObject(handle, windows_uninstall_sync.infinite);
    if (wait_result != windows_uninstall_sync.wait_object_0 and
        wait_result != windows_uninstall_sync.wait_abandoned)
    {
        return error.UninstallLockFailed;
    }
    return .{ .handle = handle };
}

fn validateWindowsUninstallManifest(
    allocator: std.mem.Allocator,
    manifest: WindowsUninstallManifest,
    base_dir: []const u8,
) !void {
    if (manifest.schema_version != WINDOWS_UNINSTALL_MANIFEST_VERSION or
        !isValidWindowsInstallNonce(manifest.install_nonce) or
        !isSafeWindowsComponent(manifest.identifier) or
        !isSafeWindowsComponent(manifest.channel))
    {
        return error.InvalidUninstallManifest;
    }

    if (!std.fs.path.isAbsolute(base_dir) or
        !std.ascii.eqlIgnoreCase(std.fs.path.basename(base_dir), manifest.channel))
    {
        return error.InvalidUninstallLocation;
    }
    const identifier_dir = std.fs.path.dirname(base_dir) orelse return error.InvalidUninstallLocation;
    if (!std.ascii.eqlIgnoreCase(std.fs.path.basename(identifier_dir), manifest.identifier)) {
        return error.InvalidUninstallLocation;
    }

    const shortcut_name = try windowsShortcutFileName(allocator, manifest.name, manifest.channel);
    defer allocator.free(shortcut_name);
    if (!std.fs.path.isAbsolute(manifest.desktop_shortcut) or
        !std.fs.path.isAbsolute(manifest.start_menu_shortcut) or
        !std.ascii.eqlIgnoreCase(std.fs.path.basename(manifest.desktop_shortcut), shortcut_name) or
        !std.ascii.eqlIgnoreCase(std.fs.path.basename(manifest.start_menu_shortcut), shortcut_name))
    {
        return error.InvalidUninstallManifest;
    }
}

fn writeWindowsUninstallManifest(
    allocator: std.mem.Allocator,
    manifest_path: []const u8,
    manifest: WindowsUninstallManifest,
) !void {
    const json = try std.json.Stringify.valueAlloc(
        allocator,
        manifest,
        .{ .whitespace = .indent_2 },
    );
    defer allocator.free(json);
    try std.Io.Dir.cwd().writeFile(g_io, .{ .sub_path = manifest_path, .data = json });
}

fn deleteFileIfExists(path: []const u8) !void {
    std.Io.Dir.cwd().deleteFile(g_io, path) catch |err| switch (err) {
        error.FileNotFound, error.NotDir => {},
        else => return err,
    };
}

fn isSafeLinuxComponent(value: []const u8) bool {
    if (value.len == 0 or std.mem.eql(u8, value, ".") or std.mem.eql(u8, value, "..")) return false;
    for (value) |byte| switch (byte) {
        0...31, 127, '/' => return false,
        else => {},
    };
    return true;
}

fn isSafeLinuxDisplayName(value: []const u8) bool {
    if (value.len == 0) return false;
    for (value) |byte| switch (byte) {
        0...31, 127 => return false,
        else => {},
    };
    return true;
}

fn validateLinuxIntegrationPath(
    path: []const u8,
    allowed_parent: []const u8,
) !void {
    if (path.len == 0) return;
    if (!std.fs.path.isAbsolute(path) or !std.fs.path.isAbsolute(allowed_parent)) {
        return error.InvalidUninstallManifest;
    }
    var components = std.mem.splitScalar(u8, path, std.fs.path.sep);
    while (components.next()) |component| {
        if (std.mem.eql(u8, component, ".") or std.mem.eql(u8, component, "..")) {
            return error.InvalidUninstallManifest;
        }
    }
    const parent = std.fs.path.dirname(path) orelse return error.InvalidUninstallManifest;
    if (!std.mem.eql(u8, parent, allowed_parent) or
        !std.mem.endsWith(u8, std.fs.path.basename(path), ".desktop") or
        std.mem.eql(u8, std.fs.path.basename(path), ".desktop"))
    {
        return error.InvalidUninstallManifest;
    }
}

fn isValidSha256Hex(value: []const u8) bool {
    if (value.len != std.crypto.hash.sha2.Sha256.digest_length * 2) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

fn linuxManifestPath(allocator: std.mem.Allocator, base_dir: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ base_dir, LINUX_UNINSTALL_MANIFEST_NAME });
}

fn openLinuxAbsoluteDirNoSymlinks(path: []const u8) !std.Io.Dir {
    if (!isValidLinuxAbsoluteRoot(path)) return error.InvalidUninstallLocation;
    var current = try std.Io.Dir.openDirAbsolute(g_io, std.fs.path.sep_str, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    errdefer current.close(g_io);
    var parts = std.mem.splitScalar(u8, path[1..], std.fs.path.sep);
    while (parts.next()) |part| {
        const next = current.openDir(g_io, part, .{
            .follow_symlinks = false,
            .iterate = true,
        }) catch |err| switch (err) {
            error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
            else => return err,
        };
        current.close(g_io);
        current = next;
    }
    return current;
}

fn openOptionalLinuxAbsoluteDirNoSymlinks(path: []const u8) !?std.Io.Dir {
    if (!isValidLinuxAbsoluteRoot(path)) return error.InvalidUninstallLocation;
    var current = try std.Io.Dir.openDirAbsolute(g_io, std.fs.path.sep_str, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    errdefer current.close(g_io);
    var parts = std.mem.splitScalar(u8, path[1..], std.fs.path.sep);
    while (parts.next()) |part| {
        const next = current.openDir(g_io, part, .{
            .follow_symlinks = false,
            .iterate = true,
        }) catch |err| switch (err) {
            error.FileNotFound => {
                current.close(g_io);
                return null;
            },
            error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
            else => return err,
        };
        current.close(g_io);
        current = next;
    }
    return current;
}

const LinuxInstallScope = struct {
    data_home_path: []u8,
    identifier: []const u8,
    channel: []const u8,
    data_home_dir: std.Io.Dir,
    identifier_dir: std.Io.Dir,
    channel_dir: std.Io.Dir,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        self.channel_dir.close(g_io);
        self.identifier_dir.close(g_io);
        self.data_home_dir.close(g_io);
        allocator.free(self.data_home_path);
        self.* = undefined;
    }
};

fn openLinuxInstallScope(
    allocator: std.mem.Allocator,
    base_dir: []const u8,
) !LinuxInstallScope {
    if (!isValidLinuxAbsoluteRoot(base_dir)) return error.InvalidUninstallLocation;
    const resolved = try std.fs.path.resolve(allocator, &.{base_dir});
    defer allocator.free(resolved);
    if (!std.mem.eql(u8, resolved, base_dir)) return error.InvalidUninstallLocation;

    const channel = std.fs.path.basename(base_dir);
    const identifier_path = std.fs.path.dirname(base_dir) orelse return error.InvalidUninstallLocation;
    const identifier = std.fs.path.basename(identifier_path);
    const data_home = std.fs.path.dirname(identifier_path) orelse return error.InvalidUninstallLocation;
    if (!isSafeLinuxComponent(identifier) or !isSafeLinuxComponent(channel) or
        !isValidLinuxAbsoluteRoot(data_home)) return error.InvalidUninstallLocation;

    const data_home_path = try allocator.dupe(u8, data_home);
    errdefer allocator.free(data_home_path);
    var data_home_dir = try openLinuxAbsoluteDirNoSymlinks(data_home);
    errdefer data_home_dir.close(g_io);
    var identifier_dir = data_home_dir.openDir(g_io, identifier, .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    errdefer identifier_dir.close(g_io);
    const channel_dir = identifier_dir.openDir(g_io, channel, .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    return .{
        .data_home_path = data_home_path,
        .identifier = std.fs.path.basename(identifier_path),
        .channel = std.fs.path.basename(base_dir),
        .data_home_dir = data_home_dir,
        .identifier_dir = identifier_dir,
        .channel_dir = channel_dir,
    };
}

fn validateLinuxDataPathVersions(versions: ?[]const u32) !void {
    const values = versions orelse return error.InvalidUninstallManifest;
    if (values.len != 1 or values[0] != LINUX_DATA_PATH_VERSION) {
        return error.InvalidUninstallManifest;
    }
}

fn validateLinuxUninstallManifest(
    allocator: std.mem.Allocator,
    manifest: LinuxUninstallManifest,
    scope: LinuxInstallScope,
) !void {
    if ((manifest.schema_version != LINUX_UNINSTALL_MANIFEST_VERSION and
        manifest.schema_version != LINUX_LEGACY_UNINSTALL_MANIFEST_VERSION) or
        !isSafeLinuxComponent(manifest.identifier) or
        !isSafeLinuxComponent(manifest.channel) or
        !isSafeLinuxDisplayName(manifest.name) or
        manifest.version.len == 0 or
        (manifest.application_entry.len != 0 and !isValidSha256Hex(manifest.application_entry_sha256)) or
        (manifest.application_entry.len == 0 and manifest.application_entry_sha256.len != 0) or
        (manifest.desktop_entry.len != 0 and !isValidSha256Hex(manifest.desktop_entry_sha256)) or
        (manifest.desktop_entry.len == 0 and manifest.desktop_entry_sha256.len != 0))
    {
        return error.InvalidUninstallManifest;
    }
    if (!std.mem.eql(u8, scope.channel, manifest.channel) or
        !std.mem.eql(u8, scope.identifier, manifest.identifier))
    {
        return error.InvalidUninstallLocation;
    }

    var home: []const u8 = undefined;
    var legacy_home: ?[]u8 = null;
    defer if (legacy_home) |value| allocator.free(value);
    if (manifest.schema_version == LINUX_UNINSTALL_MANIFEST_VERSION) {
        try validateLinuxDataPathVersions(manifest.data_path_versions);
        home = manifest.home orelse return error.InvalidUninstallManifest;
        const cache_root = manifest.xdg_cache_home orelse return error.InvalidUninstallManifest;
        const state_root = manifest.xdg_state_home orelse return error.InvalidUninstallManifest;
        if (!isValidLinuxAbsoluteRoot(home) or
            !isValidLinuxAbsoluteRoot(cache_root) or
            !isValidLinuxAbsoluteRoot(state_root)) return error.InvalidUninstallManifest;
    } else {
        legacy_home = try linuxHome(allocator);
        home = legacy_home.?;
    }

    if (manifest.application_entry.len != 0) {
        const applications_dir = try std.fs.path.join(allocator, &.{ scope.data_home_path, "applications" });
        defer allocator.free(applications_dir);
        try validateLinuxIntegrationPath(manifest.application_entry, applications_dir);
    }
    if (manifest.desktop_entry.len != 0) {
        const desktop_dir = try std.fs.path.join(allocator, &.{ home, "Desktop" });
        defer allocator.free(desktop_dir);
        try validateLinuxIntegrationPath(manifest.desktop_entry, desktop_dir);
    }
}

fn writeLinuxUninstallManifest(
    allocator: std.mem.Allocator,
    channel_dir: std.Io.Dir,
    manifest: LinuxUninstallManifest,
) !void {
    const json = try std.json.Stringify.valueAlloc(
        allocator,
        manifest,
        .{ .whitespace = .indent_2 },
    );
    defer allocator.free(json);

    var atomic_file = try channel_dir.createFileAtomic(g_io, LINUX_UNINSTALL_MANIFEST_NAME, .{ .replace = true });
    defer atomic_file.deinit(g_io);
    var buffer: [4096]u8 = undefined;
    var writer = atomic_file.file.writer(g_io, &buffer);
    try writer.interface.writeAll(json);
    try writer.flush();
    try atomic_file.file.sync(g_io);
    try atomic_file.replace(g_io);
}

fn loadAndValidateLinuxManifest(
    allocator: std.mem.Allocator,
    scope: LinuxInstallScope,
) !struct { contents: []u8, parsed: std.json.Parsed(LinuxUninstallManifest) } {
    var manifest_file = try scope.channel_dir.openFile(g_io, LINUX_UNINSTALL_MANIFEST_NAME, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer manifest_file.close(g_io);
    const manifest_stat = try manifest_file.stat(g_io);
    if (manifest_stat.kind != .file) return error.InvalidUninstallManifest;
    var manifest_reader = manifest_file.reader(g_io, &.{});
    const contents = manifest_reader.interface.allocRemaining(allocator, .limited(64 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return manifest_reader.err.?,
        else => |e| return e,
    };
    errdefer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        LinuxUninstallManifest,
        allocator,
        contents,
        .{},
    );
    errdefer parsed.deinit();
    try validateLinuxUninstallManifest(allocator, parsed.value, scope);
    return .{ .contents = contents, .parsed = parsed };
}

fn refreshLinuxDesktopDatabase(application_entry: []const u8) void {
    if (application_entry.len == 0) return;
    const applications_dir = std.fs.path.dirname(application_entry) orelse return;
    const argv = [_][]const u8{ "update-desktop-database", applications_dir };
    var child = std.process.spawn(g_io, .{
        .argv = &argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch return;
    _ = child.wait(g_io) catch {};
}

fn unescapeLinuxDesktopExecPath(
    allocator: std.mem.Allocator,
    value: []const u8,
) !?[]u8 {
    if (value.len < 2 or value[0] != '"' or value[value.len - 1] != '"') return null;
    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);
    var index: usize = 1;
    while (index < value.len - 1) : (index += 1) {
        const byte = value[index];
        if (byte != '\\') {
            try result.append(allocator, byte);
            continue;
        }
        index += 1;
        if (index >= value.len - 1) return null;
        const unescaped: u8 = switch (value[index]) {
            '\\' => '\\',
            '"' => '"',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            else => return null,
        };
        try result.append(allocator, unescaped);
    }
    return try result.toOwnedSlice(allocator);
}

fn linuxDesktopEntryTargetsLauncher(
    allocator: std.mem.Allocator,
    contents: []const u8,
    launcher_path: []const u8,
) !bool {
    var found_exec = false;
    var lines = std.mem.tokenizeScalar(u8, contents, '\n');
    while (lines.next()) |raw_line| {
        const line = std.mem.trimEnd(u8, raw_line, "\r");
        if (!std.mem.startsWith(u8, line, "Exec=")) continue;
        const parsed_path = (try unescapeLinuxDesktopExecPath(allocator, line["Exec=".len..])) orelse return false;
        defer allocator.free(parsed_path);
        if (!std.mem.eql(u8, parsed_path, launcher_path)) return false;
        found_exec = true;
    }
    return found_exec;
}

const PreparedLinuxDesktopEntry = struct {
    parent: ?std.Io.Dir = null,
    basename: []const u8 = "",
    should_delete: bool = false,
    already_absent: bool = false,

    fn deinit(self: *@This()) void {
        if (self.parent) |*dir| dir.close(g_io);
        self.* = .{};
    }

    fn remove(self: @This()) !bool {
        if (self.already_absent) return true;
        if (!self.should_delete) return false;
        const parent = self.parent orelse return false;
        parent.deleteFile(g_io, self.basename) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
        return true;
    }
};

fn prepareLinuxDesktopEntry(
    allocator: std.mem.Allocator,
    path: []const u8,
    allowed_parent: []const u8,
    expected_hash: []const u8,
    launcher_path: []const u8,
) !PreparedLinuxDesktopEntry {
    if (path.len == 0) return .{ .already_absent = true };
    try validateLinuxIntegrationPath(path, allowed_parent);
    var parent = (try openOptionalLinuxAbsoluteDirNoSymlinks(allowed_parent)) orelse
        return .{ .already_absent = true };
    errdefer parent.close(g_io);
    const basename = std.fs.path.basename(path);
    const stat = parent.statFile(g_io, basename, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return .{
            .parent = parent,
            .basename = basename,
            .already_absent = true,
        },
        else => return err,
    };
    if (stat.kind != .file) return .{ .parent = parent, .basename = basename };
    var file = try parent.openFile(g_io, basename, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer file.close(g_io);
    var reader = file.reader(g_io, &.{});
    const contents = reader.interface.allocRemaining(allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return reader.err.?,
        else => |e| return e,
    };
    defer allocator.free(contents);
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(contents, &digest, .{});
    const actual_hash = std.fmt.bytesToHex(digest, .lower);
    const owned = std.ascii.eqlIgnoreCase(&actual_hash, expected_hash) and
        try linuxDesktopEntryTargetsLauncher(allocator, contents, launcher_path);
    return .{
        .parent = parent,
        .basename = basename,
        .should_delete = owned,
    };
}

const LinuxManagedChild = enum { missing, file, directory };

fn prepareLinuxManagedChild(parent: std.Io.Dir, name: []const u8) !LinuxManagedChild {
    const stat = parent.statFile(g_io, name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return .missing,
        else => return err,
    };
    return switch (stat.kind) {
        .file => .file,
        .directory => .directory,
        else => error.InvalidUninstallLocation,
    };
}

fn deleteLinuxManagedChild(parent: std.Io.Dir, name: []const u8, kind: LinuxManagedChild) !void {
    switch (kind) {
        .missing => {},
        .file => parent.deleteFile(g_io, name) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        },
        .directory => try parent.deleteTree(g_io, name),
    }
}

const LinuxScopedDeletionTarget = struct {
    root_dir: ?std.Io.Dir = null,
    identifier_dir: ?std.Io.Dir = null,
    channel_present: bool = false,

    fn deinit(self: *@This()) void {
        if (self.identifier_dir) |*dir| dir.close(g_io);
        if (self.root_dir) |*dir| dir.close(g_io);
        self.* = .{};
    }

    fn remove(self: @This(), identifier: []const u8, channel: []const u8) !void {
        const identifier_dir = self.identifier_dir orelse return;
        if (self.channel_present) try identifier_dir.deleteTree(g_io, channel);
        const root_dir = self.root_dir orelse return;
        root_dir.deleteDir(g_io, identifier) catch {};
    }
};

fn prepareLinuxScopedDeletionTarget(
    root_path: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !LinuxScopedDeletionTarget {
    var root_dir = (try openOptionalLinuxAbsoluteDirNoSymlinks(root_path)) orelse return .{};
    errdefer root_dir.close(g_io);
    var identifier_dir = root_dir.openDir(g_io, identifier, .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.FileNotFound => return .{ .root_dir = root_dir },
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    errdefer identifier_dir.close(g_io);
    const channel_stat = identifier_dir.statFile(g_io, channel, .{
        .follow_symlinks = false,
    }) catch |err| switch (err) {
        error.FileNotFound => return .{
            .root_dir = root_dir,
            .identifier_dir = identifier_dir,
        },
        else => return err,
    };
    if (channel_stat.kind != .directory) return error.InvalidUninstallLocation;
    return .{
        .root_dir = root_dir,
        .identifier_dir = identifier_dir,
        .channel_present = true,
    };
}

fn installLinuxManagerFromResource(
    allocator: std.mem.Allocator,
    scope: LinuxInstallScope,
    app_dir: []const u8,
) !void {
    const resources_path = try std.fs.path.join(allocator, &.{ app_dir, "Resources" });
    defer allocator.free(resources_path);
    var resources_dir = try openLinuxAbsoluteDirNoSymlinks(resources_path);
    defer resources_dir.close(g_io);
    var source_file = try resources_dir.openFile(g_io, LINUX_UNINSTALL_EXE_NAME, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer source_file.close(g_io);
    const source_stat = try source_file.stat(g_io);
    if (source_stat.kind != .file) return error.InvalidUninstallManager;

    var atomic_uninstaller = try scope.channel_dir.createFileAtomic(g_io, LINUX_UNINSTALL_EXE_NAME, .{
        .replace = true,
        .permissions = .fromMode(0o755),
    });
    defer atomic_uninstaller.deinit(g_io);
    var source_reader = source_file.reader(g_io, &.{});
    var copy_buffer: [4096]u8 = undefined;
    var destination_writer = atomic_uninstaller.file.writer(g_io, &copy_buffer);
    _ = destination_writer.interface.sendFileAll(&source_reader, .unlimited) catch |err| switch (err) {
        error.ReadFailed => return source_reader.err.?,
        error.WriteFailed => return destination_writer.err.?,
    };
    try destination_writer.flush();
    try atomic_uninstaller.file.setPermissions(g_io, .fromMode(0o755));
    try atomic_uninstaller.file.sync(g_io);
    try atomic_uninstaller.replace(g_io);
}

fn preflightLinuxManagerResource(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
) !void {
    const resources_path = try std.fs.path.join(allocator, &.{ app_dir, "Resources" });
    defer allocator.free(resources_path);
    var resources_dir = try openLinuxAbsoluteDirNoSymlinks(resources_path);
    defer resources_dir.close(g_io);
    var source_file = try resources_dir.openFile(g_io, LINUX_UNINSTALL_EXE_NAME, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer source_file.close(g_io);
    const source_stat = try source_file.stat(g_io);
    if (source_stat.kind != .file) return error.InvalidUninstallManager;
}

fn installLinuxIntegration(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
    metadata: AppMetadata,
) !void {
    if (!isSafeLinuxComponent(metadata.identifier) or
        !isSafeLinuxComponent(metadata.channel) or
        !isSafeLinuxDisplayName(metadata.name)) return error.InvalidInstallIdentity;
    const base_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidInstallLocation;
    var scope = try openLinuxInstallScope(allocator, base_dir);
    defer scope.deinit(allocator);
    if (!std.mem.eql(u8, scope.identifier, metadata.identifier) or
        !std.mem.eql(u8, scope.channel, metadata.channel)) return error.InvalidInstallLocation;

    const home = try linuxHome(allocator);
    defer allocator.free(home);
    const cache_root = try linuxXdgRoot(allocator, "XDG_CACHE_HOME", &.{".cache"});
    defer allocator.free(cache_root);
    const state_root = try linuxXdgRoot(allocator, "XDG_STATE_HOME", &.{ ".local", "state" });
    defer allocator.free(state_root);
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher" });
    defer allocator.free(launcher_path);

    // Refuse an incomplete bundle before touching any existing desktop
    // integration. Hutch self-extracting packages must carry this thin manager.
    try preflightLinuxManagerResource(allocator, app_dir);

    var preserved_application_entry: ?[]u8 = null;
    defer if (preserved_application_entry) |path| allocator.free(path);
    var preserved_desktop_entry: ?[]u8 = null;
    defer if (preserved_desktop_entry) |path| allocator.free(path);

    // Reinstall cleanup is conservative: prepare both recorded integration
    // entries before removing either, and retain anything edited by the user.
    if (loadAndValidateLinuxManifest(allocator, scope)) |old_document_value| {
        var old_document = old_document_value;
        defer allocator.free(old_document.contents);
        defer old_document.parsed.deinit();
        const old = old_document.parsed.value;
        const applications_dir = try std.fs.path.join(allocator, &.{ scope.data_home_path, "applications" });
        defer allocator.free(applications_dir);
        const old_home = if (old.schema_version == LINUX_UNINSTALL_MANIFEST_VERSION)
            old.home.?
        else
            home;
        const desktop_dir = try std.fs.path.join(allocator, &.{ old_home, "Desktop" });
        defer allocator.free(desktop_dir);
        var application = prepareLinuxDesktopEntry(
            allocator,
            old.application_entry,
            applications_dir,
            old.application_entry_sha256,
            launcher_path,
        ) catch |err| blk: {
            std.debug.print("Warning: Could not inspect previous application entry: {}\n", .{err});
            break :blk PreparedLinuxDesktopEntry{};
        };
        defer application.deinit();
        var desktop = prepareLinuxDesktopEntry(
            allocator,
            old.desktop_entry,
            desktop_dir,
            old.desktop_entry_sha256,
            launcher_path,
        ) catch |err| blk: {
            std.debug.print("Warning: Could not inspect previous Desktop entry: {}\n", .{err});
            break :blk PreparedLinuxDesktopEntry{};
        };
        defer desktop.deinit();
        const application_removed = application.remove() catch false;
        const desktop_removed = desktop.remove() catch false;
        if (old.application_entry.len != 0 and !application_removed) {
            preserved_application_entry = try allocator.dupe(u8, old.application_entry);
        }
        if (old.desktop_entry.len != 0 and !desktop_removed) {
            preserved_desktop_entry = try allocator.dupe(u8, old.desktop_entry);
        }
    } else |err| switch (err) {
        error.FileNotFound => {},
        else => std.debug.print("Warning: Could not inspect previous Linux integration metadata: {}\n", .{err}),
    }

    var integration = try createDesktopShortcut(
        allocator,
        app_dir,
        home,
        scope.data_home_path,
        preserved_application_entry,
        preserved_desktop_entry,
    );
    defer integration.deinit(allocator);
    const version = try readInstalledVersion(allocator, app_dir);
    defer allocator.free(version);

    try installLinuxManagerFromResource(allocator, scope, app_dir);
    const data_path_versions = [_]u32{LINUX_DATA_PATH_VERSION};
    try writeLinuxUninstallManifest(allocator, scope.channel_dir, .{
        .schema_version = LINUX_UNINSTALL_MANIFEST_VERSION,
        .identifier = metadata.identifier,
        .name = metadata.name,
        .channel = metadata.channel,
        .version = version,
        .application_entry = integration.application_entry orelse "",
        .desktop_entry = integration.desktop_entry orelse "",
        .application_entry_sha256 = integration.application_entry_sha256 orelse "",
        .desktop_entry_sha256 = integration.desktop_entry_sha256 orelse "",
        .data_path_versions = &data_path_versions,
        .home = home,
        .xdg_cache_home = cache_root,
        .xdg_state_home = state_root,
    });
    std.debug.print("Installed Linux uninstaller under: {s}\n", .{base_dir});
}

fn linuxManagerInvocationPath(
    allocator: std.mem.Allocator,
    argv0: []const u8,
) ![]u8 {
    if (argv0.len == 0) return error.InvalidUninstallLocation;
    if (std.fs.path.isAbsolute(argv0)) return std.fs.path.resolve(allocator, &.{argv0});
    return error.InvalidUninstallLocation;
}

fn validateRunningLinuxManager(
    allocator: std.mem.Allocator,
    invocation_path: []const u8,
) !void {
    if (!std.mem.eql(u8, std.fs.path.basename(invocation_path), LINUX_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    const executable_stat = try std.Io.Dir.cwd().statFile(g_io, invocation_path, .{ .follow_symlinks = false });
    if (executable_stat.kind != .file) return error.InvalidUninstallLocation;
    const physical_invocation = try std.Io.Dir.realPathFileAbsoluteAlloc(g_io, invocation_path, allocator);
    defer allocator.free(physical_invocation);
    const running_executable = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(running_executable);
    if (!std.mem.eql(u8, physical_invocation, running_executable)) {
        return error.InvalidUninstallLocation;
    }
}

fn refreshLinuxUninstallMetadata(
    allocator: std.mem.Allocator,
    invocation_path: []const u8,
) !void {
    try validateRunningLinuxManager(allocator, invocation_path);
    const base_dir = std.fs.path.dirname(invocation_path) orelse return error.InvalidUninstallLocation;
    var scope = try openLinuxInstallScope(allocator, base_dir);
    defer scope.deinit(allocator);
    var document = try loadAndValidateLinuxManifest(allocator, scope);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const old = document.parsed.value;
    const app_dir = try std.fs.path.join(allocator, &.{ base_dir, "app" });
    defer allocator.free(app_dir);
    const installed_identity = try readInstalledLinuxIdentity(allocator, app_dir, old);
    defer allocator.free(installed_identity.version);
    defer allocator.free(installed_identity.name);
    try writeLinuxUninstallManifest(allocator, scope.channel_dir, .{
        .schema_version = old.schema_version,
        .identifier = old.identifier,
        .name = installed_identity.name,
        .channel = old.channel,
        .version = installed_identity.version,
        .application_entry = old.application_entry,
        .desktop_entry = old.desktop_entry,
        .application_entry_sha256 = old.application_entry_sha256,
        .desktop_entry_sha256 = old.desktop_entry_sha256,
        .data_path_versions = old.data_path_versions,
        .home = old.home,
        .xdg_cache_home = old.xdg_cache_home,
        .xdg_state_home = old.xdg_state_home,
    });
}

fn uninstallLinux(
    allocator: std.mem.Allocator,
    invocation_path: []const u8,
    requested_mode: ?LinuxUninstallMode,
) !void {
    try validateRunningLinuxManager(allocator, invocation_path);
    const base_dir = std.fs.path.dirname(invocation_path) orelse return error.InvalidUninstallLocation;
    var scope = try openLinuxInstallScope(allocator, base_dir);
    defer scope.deinit(allocator);
    var document = try loadAndValidateLinuxManifest(allocator, scope);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const manifest = document.parsed.value;

    const mode: LinuxUninstallMode = requested_mode orelse blk: {
        const selection = linux_uninstall_prompt.show(
            allocator,
            g_io,
            g_environ_map,
            manifest.name,
        ) catch |err| switch (err) {
            error.InteractivePromptUnavailable => {
                std.debug.print(
                    "No graphical uninstall dialog or terminal is available. " ++
                        "Run '{s} --quiet' explicitly to remove the app only.\n",
                    .{invocation_path},
                );
                return err;
            },
            else => return err,
        };
        break :blk switch (selection) {
            .app => .app,
            .app_and_data => .app_and_data,
            .cancel => return,
        };
    };

    const launcher_path = try std.fs.path.join(allocator, &.{ base_dir, "app", "bin", "launcher" });
    defer allocator.free(launcher_path);
    const applications_dir = try std.fs.path.join(allocator, &.{ scope.data_home_path, "applications" });
    defer allocator.free(applications_dir);
    const recorded_home = if (manifest.schema_version == LINUX_UNINSTALL_MANIFEST_VERSION)
        manifest.home.?
    else blk: {
        const current_home = try linuxHome(allocator);
        break :blk current_home;
    };
    defer if (manifest.schema_version == LINUX_LEGACY_UNINSTALL_MANIFEST_VERSION)
        allocator.free(recorded_home);
    const desktop_dir = try std.fs.path.join(allocator, &.{ recorded_home, "Desktop" });
    defer allocator.free(desktop_dir);

    // Complete the preflight before the first mutation. The recursive children
    // and integration parents are pinned without following symlinks.
    const app_kind = try prepareLinuxManagedChild(scope.channel_dir, "app");
    const extraction_kind = try prepareLinuxManagedChild(scope.channel_dir, "self-extraction");
    var application_entry = try prepareLinuxDesktopEntry(
        allocator,
        manifest.application_entry,
        applications_dir,
        manifest.application_entry_sha256,
        launcher_path,
    );
    defer application_entry.deinit();
    var desktop_entry = try prepareLinuxDesktopEntry(
        allocator,
        manifest.desktop_entry,
        desktop_dir,
        manifest.desktop_entry_sha256,
        launcher_path,
    );
    defer desktop_entry.deinit();

    var cache_target: LinuxScopedDeletionTarget = .{};
    defer cache_target.deinit();
    var state_target: LinuxScopedDeletionTarget = .{};
    defer state_target.deinit();
    if (mode == .app_and_data) {
        if (manifest.schema_version != LINUX_UNINSTALL_MANIFEST_VERSION) {
            return error.DataDeletionUnavailableForLegacyManifest;
        }
        cache_target = try prepareLinuxScopedDeletionTarget(
            manifest.xdg_cache_home.?,
            manifest.identifier,
            manifest.channel,
        );
        state_target = try prepareLinuxScopedDeletionTarget(
            manifest.xdg_state_home.?,
            manifest.identifier,
            manifest.channel,
        );
    }

    _ = try application_entry.remove();
    _ = try desktop_entry.remove();
    refreshLinuxDesktopDatabase(manifest.application_entry);

    if (mode == .app_and_data) {
        try cache_target.remove(manifest.identifier, manifest.channel);
        try state_target.remove(manifest.identifier, manifest.channel);
        try scope.identifier_dir.deleteTree(g_io, manifest.channel);
        scope.data_home_dir.deleteDir(g_io, manifest.identifier) catch {};
        return;
    }

    try deleteLinuxManagedChild(scope.channel_dir, "app", app_kind);
    try deleteLinuxManagedChild(scope.channel_dir, "self-extraction", extraction_kind);
    scope.channel_dir.deleteFile(g_io, LINUX_UNINSTALL_EXE_NAME) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    scope.channel_dir.deleteFile(g_io, LINUX_UNINSTALL_MANIFEST_NAME) catch |err| switch (err) {
        error.FileNotFound => {},
        else => return err,
    };
    scope.identifier_dir.deleteDir(g_io, manifest.channel) catch {};
    scope.data_home_dir.deleteDir(g_io, manifest.identifier) catch {};
}

fn installWindowsIntegration(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
    metadata: AppMetadata,
    installer_path: []const u8,
) !void {
    if (!isSafeWindowsComponent(metadata.identifier) or !isSafeWindowsComponent(metadata.channel)) {
        return error.InvalidInstallIdentity;
    }
    const base_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidInstallLocation;
    const target_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(target_path);
    try std.Io.Dir.cwd().access(g_io, target_path, .{});
    const working_dir = try std.fs.path.join(allocator, &.{ app_dir, "bin" });
    defer allocator.free(working_dir);

    const shortcut_name = try windowsShortcutFileName(allocator, metadata.name, metadata.channel);
    defer allocator.free(shortcut_name);
    const desktop_dir = try getWindowsDesktopDir(allocator);
    defer allocator.free(desktop_dir);
    const programs_dir = try getWindowsProgramsDir(allocator);
    defer allocator.free(programs_dir);
    try std.Io.Dir.cwd().createDirPath(g_io, desktop_dir);
    try std.Io.Dir.cwd().createDirPath(g_io, programs_dir);
    const desktop_shortcut = try std.fs.path.join(allocator, &.{ desktop_dir, shortcut_name });
    defer allocator.free(desktop_shortcut);
    const start_menu_shortcut = try std.fs.path.join(allocator, &.{ programs_dir, shortcut_name });
    defer allocator.free(start_menu_shortcut);

    const uninstall_path = try std.fs.path.join(allocator, &.{ base_dir, WINDOWS_UNINSTALL_EXE_NAME });
    defer allocator.free(uninstall_path);
    try std.Io.Dir.copyFileAbsolute(installer_path, uninstall_path, g_io, .{});
    const manifest_path = try std.fs.path.join(allocator, &.{ base_dir, WINDOWS_UNINSTALL_MANIFEST_NAME });
    defer allocator.free(manifest_path);
    removePreviousWindowsShortcuts(
        allocator,
        manifest_path,
        metadata.identifier,
        metadata.channel,
        desktop_dir,
        programs_dir,
        desktop_shortcut,
        start_menu_shortcut,
        target_path,
    ) catch |err| {
        std.debug.print("Warning: Could not remove previous Windows shortcuts: {}\n", .{err});
    };
    removeLegacyWindowsShortcuts(
        allocator,
        metadata.name,
        desktop_dir,
        programs_dir,
        desktop_shortcut,
        start_menu_shortcut,
        target_path,
    ) catch |err| {
        std.debug.print("Warning: Could not remove legacy Windows shortcuts: {}\n", .{err});
    };
    const install_nonce = createWindowsInstallNonce();
    const manifest = WindowsUninstallManifest{
        .schema_version = WINDOWS_UNINSTALL_MANIFEST_VERSION,
        .install_nonce = &install_nonce,
        .identifier = metadata.identifier,
        .name = metadata.name,
        .channel = metadata.channel,
        .desktop_shortcut = desktop_shortcut,
        .start_menu_shortcut = start_menu_shortcut,
    };
    try writeWindowsUninstallManifest(allocator, manifest_path, manifest);

    errdefer deleteFileIfExists(desktop_shortcut) catch {};
    errdefer deleteFileIfExists(start_menu_shortcut) catch {};
    try createWindowsShortcutFile(allocator, desktop_shortcut, target_path, working_dir, target_path);
    try createWindowsShortcutFile(allocator, start_menu_shortcut, target_path, working_dir, target_path);
    try registerWindowsUninstallEntry(allocator, manifest, app_dir, uninstall_path);
}

fn retryDeleteTree(path: []const u8) !void {
    for (0..60) |attempt| {
        std.Io.Dir.cwd().deleteTree(g_io, path) catch |err| {
            if (attempt == 59) return err;
            g_io.sleep(.fromMilliseconds(500), .awake) catch {};
            continue;
        };
        return;
    }
}

fn retryDeleteFile(path: []const u8) !void {
    for (0..20) |attempt| {
        deleteFileIfExists(path) catch |err| {
            if (attempt == 19) return err;
            g_io.sleep(.fromMilliseconds(250), .awake) catch {};
            continue;
        };
        return;
    }
}

fn terminateWindowsAppProcesses(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    const escaped_app_dir = try powershellSingleQuoted(allocator, app_dir);
    defer allocator.free(escaped_app_dir);
    const command = try std.fmt.allocPrint(
        allocator,
        "$root = [IO.Path]::GetFullPath('{s}').TrimEnd('\\') + '\\'; " ++
            "Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -and " ++
            "[IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) }} | " ++
            "ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
        .{escaped_app_dir},
    );
    defer allocator.free(command);
    const argv = [_][]const u8{
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        command,
    };
    try runWindowsCommandChecked(&argv);
    g_io.sleep(.fromMilliseconds(500), .awake) catch {};
}

fn getWindowsTempDir(allocator: std.mem.Allocator) ![]u8 {
    return getEnvOwned(allocator, "TEMP") catch
        getEnvOwned(allocator, "TMP") catch {
        const local_appdata = try getAppDataDir(allocator);
        defer allocator.free(local_appdata);
        return std.fs.path.join(allocator, &.{ local_appdata, "Temp" });
    };
}

fn createTemporaryUninstallWorker(allocator: std.mem.Allocator, source_path: []const u8) ![]u8 {
    const temp_dir = try getWindowsTempDir(allocator);
    defer allocator.free(temp_dir);
    try std.Io.Dir.cwd().createDirPath(g_io, temp_dir);
    var nonce: u64 = undefined;
    g_io.random(std.mem.asBytes(&nonce));
    const worker_name = try std.fmt.allocPrint(
        allocator,
        "electrobun-uninstall-{x}.exe",
        .{nonce},
    );
    defer allocator.free(worker_name);
    const worker_path = try std.fs.path.join(allocator, &.{ temp_dir, worker_name });
    errdefer allocator.free(worker_path);
    try std.Io.Dir.copyFileAbsolute(source_path, worker_path, g_io, .{});
    return worker_path;
}

fn loadAndValidateWindowsManifest(
    allocator: std.mem.Allocator,
    manifest_path: []const u8,
    base_dir: []const u8,
) !struct { contents: []u8, parsed: std.json.Parsed(WindowsUninstallManifest) } {
    const contents = try std.Io.Dir.cwd().readFileAlloc(
        g_io,
        manifest_path,
        allocator,
        .limited(64 * 1024),
    );
    errdefer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        WindowsUninstallManifest,
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    errdefer parsed.deinit();
    try validateWindowsUninstallManifest(allocator, parsed.value, base_dir);
    return .{ .contents = contents, .parsed = parsed };
}

fn refreshWindowsUninstallRegistration(allocator: std.mem.Allocator) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    const base_dir = std.fs.path.dirname(executable_path) orelse return error.InvalidUninstallLocation;
    if (!std.ascii.eqlIgnoreCase(std.fs.path.basename(executable_path), WINDOWS_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    var uninstall_lock = try acquireWindowsUninstallLock(allocator, base_dir);
    defer uninstall_lock.release();
    const manifest_path = try std.fs.path.join(allocator, &.{ base_dir, WINDOWS_UNINSTALL_MANIFEST_NAME });
    defer allocator.free(manifest_path);
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const app_dir = try std.fs.path.join(allocator, &.{ base_dir, "app" });
    defer allocator.free(app_dir);
    try registerWindowsUninstallEntry(allocator, document.parsed.value, app_dir, executable_path);
}

fn uninstallWindows(allocator: std.mem.Allocator) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    const base_dir = std.fs.path.dirname(executable_path) orelse return error.InvalidUninstallLocation;
    if (!std.ascii.eqlIgnoreCase(std.fs.path.basename(executable_path), WINDOWS_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    var uninstall_lock = try acquireWindowsUninstallLock(allocator, base_dir);
    defer uninstall_lock.release();
    const manifest_path = try std.fs.path.join(allocator, &.{ base_dir, WINDOWS_UNINSTALL_MANIFEST_NAME });
    defer allocator.free(manifest_path);
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const manifest = document.parsed.value;

    const worker_path = try createTemporaryUninstallWorker(allocator, executable_path);
    defer allocator.free(worker_path);
    errdefer deleteFileIfExists(worker_path) catch {};

    const app_dir = try std.fs.path.join(allocator, &.{ base_dir, "app" });
    defer allocator.free(app_dir);
    const self_extraction_dir = try std.fs.path.join(allocator, &.{ base_dir, "self-extraction" });
    defer allocator.free(self_extraction_dir);
    const update_script = try std.fs.path.join(allocator, &.{ base_dir, "update.bat" });
    defer allocator.free(update_script);

    // Update tasks use a stable, channel-scoped name. Remove only this
    // installation's task so production/canary and unrelated apps are safe.
    const update_task_name = try windowsUpdateTaskName(allocator, manifest.identifier, manifest.channel);
    defer allocator.free(update_task_name);
    const end_task_args = [_][]const u8{ "schtasks.exe", "/end", "/tn", update_task_name };
    _ = runWindowsCommand(&end_task_args) catch false;
    const delete_task_args = [_][]const u8{ "schtasks.exe", "/delete", "/tn", update_task_name, "/f" };
    _ = runWindowsCommand(&delete_task_args) catch false;

    // Stop only processes whose executable lives inside this channel's app
    // directory. This avoids terminating a coexisting production/canary app.
    terminateWindowsAppProcesses(allocator, app_dir) catch |err| {
        std.debug.print("Warning: Could not stop running app processes: {}\n", .{err});
    };

    // Deliberately delete only Electrobun-managed paths. The channel root is
    // also the public userData/cache/logs and browser-profile root.
    // Attempt every independent item, but retain the ARP entry/uninstaller if
    // any managed cleanup failed so Windows can retry the uninstall later.
    var cleanup_error: ?anyerror = null;
    retryDeleteTree(app_dir) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    retryDeleteTree(self_extraction_dir) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    retryDeleteFile(update_script) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(launcher_path);
    deleteWindowsShortcutIfTargets(allocator, manifest.desktop_shortcut, launcher_path) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    deleteWindowsShortcutIfTargets(allocator, manifest.start_menu_shortcut, launcher_path) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    if (cleanup_error) |err| return err;
    try deleteWindowsUninstallEntry(allocator, manifest.identifier, manifest.channel);

    const worker_args = [_][]const u8{
        worker_path,
        "--cleanup-uninstaller",
        executable_path,
        manifest_path,
        manifest.install_nonce,
    };
    _ = try std.process.spawn(g_io, .{
        .argv = &worker_args,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = true,
    });
}

fn batchDoubleQuotedPath(allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    if (std.mem.indexOfAny(u8, path, "\"\r\n") != null) return error.InvalidPath;
    return std.mem.replaceOwned(u8, allocator, path, "%", "%%");
}

fn scheduleTemporaryWorkerDeletion(allocator: std.mem.Allocator, worker_path: []const u8) !void {
    const temp_dir = std.fs.path.dirname(worker_path) orelse return error.InvalidPath;
    var nonce: u64 = undefined;
    g_io.random(std.mem.asBytes(&nonce));
    const script_name = try std.fmt.allocPrint(allocator, "electrobun-cleanup-{x}.cmd", .{nonce});
    defer allocator.free(script_name);
    const script_path = try std.fs.path.join(allocator, &.{ temp_dir, script_name });
    defer allocator.free(script_path);
    const escaped_worker_path = try batchDoubleQuotedPath(allocator, worker_path);
    defer allocator.free(escaped_worker_path);
    const script = try std.fmt.allocPrint(allocator,
        \\@echo off
        \\setlocal DisableDelayedExpansion
        \\set retries=0
        \\:retry
        \\del /f /q "{s}" >nul 2>&1
        \\if not exist "{s}" goto deleted
        \\set /a retries+=1
        \\if %retries% GEQ 30 exit /b 1
        \\ping -n 2 127.0.0.1 >nul
        \\goto retry
        \\:deleted
        \\del /f /q "%~f0" >nul 2>&1
        \\
    , .{ escaped_worker_path, escaped_worker_path });
    defer allocator.free(script);
    try std.Io.Dir.cwd().writeFile(g_io, .{ .sub_path = script_path, .data = script });

    const argv = [_][]const u8{ "cmd.exe", "/d", "/c", script_name };
    _ = try std.process.spawn(g_io, .{
        .argv = &argv,
        .cwd = .{ .path = temp_dir },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = true,
    });
}

fn cleanupWindowsUninstaller(
    allocator: std.mem.Allocator,
    original_uninstaller: []const u8,
    manifest_path: []const u8,
    expected_install_nonce: []const u8,
) !void {
    const worker_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(worker_path);
    defer scheduleTemporaryWorkerDeletion(allocator, worker_path) catch {};

    if (!std.ascii.eqlIgnoreCase(std.fs.path.basename(original_uninstaller), WINDOWS_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    if (!isValidWindowsInstallNonce(expected_install_nonce)) return error.InvalidArguments;
    const base_dir = std.fs.path.dirname(original_uninstaller) orelse return error.InvalidUninstallLocation;
    const expected_manifest_path = try std.fs.path.join(allocator, &.{ base_dir, WINDOWS_UNINSTALL_MANIFEST_NAME });
    defer allocator.free(expected_manifest_path);
    if (!try windowsPathsEqual(allocator, manifest_path, expected_manifest_path)) return error.InvalidUninstallLocation;

    var uninstall_lock = try acquireWindowsUninstallLock(allocator, base_dir);
    defer uninstall_lock.release();
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();

    // A reinstall can finish before this deferred worker starts. Its new
    // manifest has a different nonce, so a stale worker must leave both files
    // (and the channel directory) intact and only arrange its own deletion.
    if (!windowsInstallNonceMatches(document.parsed.value.install_nonce, expected_install_nonce)) return;

    for (0..40) |attempt| {
        deleteFileIfExists(original_uninstaller) catch |err| {
            if (attempt == 39) return err;
            g_io.sleep(.fromMilliseconds(250), .awake) catch {};
            continue;
        };
        break;
    }
    try deleteFileIfExists(manifest_path);

    // These are non-recursive on purpose: preserved user data keeps either
    // directory non-empty, while a data-free install leaves no empty shell.
    std.Io.Dir.cwd().deleteDir(g_io, base_dir) catch {};
    if (std.fs.path.dirname(base_dir)) |identifier_dir| {
        std.Io.Dir.cwd().deleteDir(g_io, identifier_dir) catch {};
    }
}

fn isSafeMacosComponent(value: []const u8) bool {
    if (value.len == 0 or std.mem.eql(u8, value, ".") or std.mem.eql(u8, value, "..")) return false;
    for (value) |byte| switch (byte) {
        0...31, 127, '/', '\\' => return false,
        else => {},
    };
    return true;
}

fn isSafeMacosDisplayName(value: []const u8) bool {
    if (value.len == 0) return false;
    for (value) |byte| switch (byte) {
        0...31, 127 => return false,
        else => {},
    };
    return true;
}

fn isValidMacosInstallNonce(value: []const u8) bool {
    if (value.len != 32) return false;
    for (value) |byte| if (!std.ascii.isHex(byte)) return false;
    return true;
}

fn createMacosInstallNonce() [32]u8 {
    var random_bytes: [16]u8 = undefined;
    g_io.random(&random_bytes);
    return std.fmt.bytesToHex(random_bytes, .lower);
}

fn macosAppPathToken(
    install_nonce: []const u8,
    identifier: []const u8,
    channel: []const u8,
    app_bundle_path: []const u8,
) [64]u8 {
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(install_nonce);
    hasher.update(&.{0});
    hasher.update(identifier);
    hasher.update(&.{0});
    hasher.update(channel);
    hasher.update(&.{0});
    hasher.update(app_bundle_path);
    hasher.update(&.{0});
    hasher.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

const MacosManagedPaths = struct {
    home: []u8,
    install_root: []u8,
    user_cache: []u8,
    user_logs: []u8,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.home);
        allocator.free(self.install_root);
        allocator.free(self.user_cache);
        allocator.free(self.user_logs);
        self.* = undefined;
    }
};

fn requirePlainDirectory(path: []const u8) !void {
    const stat = try std.Io.Dir.cwd().statFile(g_io, path, .{ .follow_symlinks = false });
    if (stat.kind != .directory) return error.InvalidUninstallLocation;
}

fn ensurePlainMacosChildDir(parent: std.Io.Dir, name: []const u8) !std.Io.Dir {
    parent.createDir(g_io, name, .default_dir) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    return parent.openDir(g_io, name, .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.NotDir, error.SymLinkLoop => error.InvalidUninstallLocation,
        else => err,
    };
}

fn ensureMacosInstallRoot(
    home: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !std.Io.Dir {
    if (!std.fs.path.isAbsolute(home) or
        !isSafeMacosComponent(identifier) or
        !isSafeMacosComponent(channel)) return error.InvalidUninstallLocation;
    std.Io.Dir.createDirAbsolute(g_io, home, .default_dir) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    var home_dir = try std.Io.Dir.openDirAbsolute(g_io, home, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    defer home_dir.close(g_io);
    var library_dir = try ensurePlainMacosChildDir(home_dir, "Library");
    defer library_dir.close(g_io);
    var application_support_dir = try ensurePlainMacosChildDir(library_dir, "Application Support");
    defer application_support_dir.close(g_io);
    var identifier_dir = try ensurePlainMacosChildDir(application_support_dir, identifier);
    defer identifier_dir.close(g_io);
    return ensurePlainMacosChildDir(identifier_dir, channel);
}

fn prepareMacosSelfExtractionRoot(
    allocator: std.mem.Allocator,
    home: []const u8,
    identifier: []const u8,
    channel: []const u8,
) ![]u8 {
    var channel_dir = try ensureMacosInstallRoot(home, identifier, channel);
    defer channel_dir.close(g_io);
    try channel_dir.deleteTree(g_io, "self-extraction");
    var extraction_dir = try ensurePlainMacosChildDir(channel_dir, "self-extraction");
    extraction_dir.close(g_io);
    return std.fs.path.join(
        allocator,
        &.{ home, "Library", "Application Support", identifier, channel, "self-extraction" },
    );
}

fn macosManagedPathsFromInstallRoot(
    allocator: std.mem.Allocator,
    install_root: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !MacosManagedPaths {
    if (!std.fs.path.isAbsolute(install_root) or
        !isSafeMacosComponent(identifier) or
        !isSafeMacosComponent(channel)) return error.InvalidUninstallLocation;

    const resolved_root = try std.fs.path.resolve(allocator, &.{install_root});
    errdefer allocator.free(resolved_root);
    if (!std.mem.eql(u8, std.fs.path.basename(resolved_root), channel)) {
        return error.InvalidUninstallLocation;
    }
    const identifier_dir = std.fs.path.dirname(resolved_root) orelse return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(identifier_dir), identifier)) {
        return error.InvalidUninstallLocation;
    }
    const application_support = std.fs.path.dirname(identifier_dir) orelse return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(application_support), "Application Support")) {
        return error.InvalidUninstallLocation;
    }
    const library_dir = std.fs.path.dirname(application_support) orelse return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(library_dir), "Library")) {
        return error.InvalidUninstallLocation;
    }
    const home = std.fs.path.dirname(library_dir) orelse return error.InvalidUninstallLocation;
    if (!std.fs.path.isAbsolute(home) or std.mem.eql(u8, home, std.fs.path.sep_str)) {
        return error.InvalidUninstallLocation;
    }

    // Refuse roots reached through symlinks. This makes every recursive target
    // a structural consequence of the manager's physical, canonical location.
    try requirePlainDirectory(library_dir);
    try requirePlainDirectory(application_support);
    try requirePlainDirectory(identifier_dir);
    try requirePlainDirectory(resolved_root);

    const user_cache = try std.fs.path.join(allocator, &.{ home, "Library", "Caches", identifier, channel });
    errdefer allocator.free(user_cache);
    const user_logs = try std.fs.path.join(allocator, &.{ home, "Library", "Logs", identifier, channel });
    errdefer allocator.free(user_logs);
    return .{
        .home = try allocator.dupe(u8, home),
        .install_root = resolved_root,
        .user_cache = user_cache,
        .user_logs = user_logs,
    };
}

const InstalledMacosIdentity = struct {
    version: []u8,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.version);
        self.* = undefined;
    }
};

fn readAndValidateInstalledMacosIdentity(
    allocator: std.mem.Allocator,
    app_bundle_path: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !InstalledMacosIdentity {
    if (!std.fs.path.isAbsolute(app_bundle_path) or
        !std.mem.endsWith(u8, std.fs.path.basename(app_bundle_path), ".app"))
    {
        return error.InvalidInstalledIdentity;
    }
    const resolved_path = try std.fs.path.resolve(allocator, &.{app_bundle_path});
    defer allocator.free(resolved_path);
    if (!std.mem.eql(u8, resolved_path, app_bundle_path)) return error.InvalidInstalledIdentity;
    const stat = try std.Io.Dir.cwd().statFile(g_io, app_bundle_path, .{ .follow_symlinks = false });
    if (stat.kind != .directory) return error.InvalidInstalledIdentity;

    const version_path = try std.fs.path.join(
        allocator,
        &.{ app_bundle_path, "Contents", "Resources", "version.json" },
    );
    defer allocator.free(version_path);
    var version_file = try std.Io.Dir.openFileAbsolute(g_io, version_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer version_file.close(g_io);
    var version_reader = version_file.reader(g_io, &.{});
    const contents = version_reader.interface.allocRemaining(allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return version_reader.err.?,
        else => |e| return e,
    };
    defer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        struct {
            version: []const u8,
            identifier: []const u8,
            channel: []const u8,
        },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    if (parsed.value.version.len == 0 or
        !std.mem.eql(u8, parsed.value.identifier, identifier) or
        !std.mem.eql(u8, parsed.value.channel, channel))
    {
        return error.InvalidInstalledIdentity;
    }
    return .{ .version = try allocator.dupe(u8, parsed.value.version) };
}

fn validateRecordedMacosAppPath(
    allocator: std.mem.Allocator,
    app_bundle_path: []const u8,
    install_root: []const u8,
) !void {
    if (!std.fs.path.isAbsolute(app_bundle_path)) return error.InvalidUninstallManifest;
    const basename = std.fs.path.basename(app_bundle_path);
    if (basename.len <= ".app".len or !std.mem.endsWith(u8, basename, ".app")) {
        return error.InvalidUninstallManifest;
    }
    const resolved = try std.fs.path.resolve(allocator, &.{app_bundle_path});
    defer allocator.free(resolved);
    if (!std.mem.eql(u8, resolved, app_bundle_path)) return error.InvalidUninstallManifest;

    // The program target must never be the manager/data root or contain it.
    // This makes an accidentally edited manifest incapable of widening the
    // recursive cleanup to the channel's managed state hierarchy.
    if (std.mem.eql(u8, resolved, install_root) or
        (std.mem.startsWith(u8, install_root, resolved) and
            install_root.len > resolved.len and
            install_root[resolved.len] == std.fs.path.sep))
    {
        return error.InvalidUninstallManifest;
    }
}

fn validateExistingMacosAppIdentityIfReadable(
    allocator: std.mem.Allocator,
    app_bundle_path: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !void {
    const app_stat = std.Io.Dir.cwd().statFile(g_io, app_bundle_path, .{
        .follow_symlinks = false,
    }) catch |err| switch (err) {
        error.FileNotFound, error.NotDir => return,
        else => return err,
    };
    if (app_stat.kind != .directory) return error.InvalidUninstallManifest;

    const version_path = try std.fs.path.join(
        allocator,
        &.{ app_bundle_path, "Contents", "Resources", "version.json" },
    );
    defer allocator.free(version_path);
    var version_file = std.Io.Dir.openFileAbsolute(g_io, version_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    }) catch return;
    defer version_file.close(g_io);
    var reader = version_file.reader(g_io, &.{});
    const contents = reader.interface.allocRemaining(allocator, .limited(1024 * 1024)) catch return;
    defer allocator.free(contents);
    const parsed = std.json.parseFromSlice(
        struct {
            identifier: []const u8,
            channel: []const u8,
        },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    ) catch return;
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.identifier, identifier) or
        !std.mem.eql(u8, parsed.value.channel, channel))
    {
        return error.InvalidUninstallManifest;
    }
}

fn validateMacosDataPathVersions(versions: []const u32) !void {
    if (versions.len == 0) return error.InvalidUninstallManifest;
    var saw_v1 = false;
    for (versions) |version| {
        if (version != MACOS_DATA_PATH_VERSION or saw_v1) return error.InvalidUninstallManifest;
        saw_v1 = true;
    }
}

fn validateMacosUninstallManifest(
    allocator: std.mem.Allocator,
    manifest: MacosUninstallManifest,
    base_dir: []const u8,
) !void {
    if (manifest.schema_version != MACOS_UNINSTALL_MANIFEST_VERSION or
        !isValidMacosInstallNonce(manifest.install_nonce) or
        !isSafeMacosComponent(manifest.identifier) or
        !isSafeMacosComponent(manifest.channel) or
        !isSafeMacosDisplayName(manifest.name) or
        manifest.version.len == 0)
    {
        return error.InvalidUninstallManifest;
    }
    try validateMacosDataPathVersions(manifest.data_path_versions);
    var paths = try macosManagedPathsFromInstallRoot(
        allocator,
        base_dir,
        manifest.identifier,
        manifest.channel,
    );
    defer paths.deinit(allocator);
    try validateRecordedMacosAppPath(allocator, manifest.app_bundle_path, paths.install_root);
    const expected_token = macosAppPathToken(
        manifest.install_nonce,
        manifest.identifier,
        manifest.channel,
        manifest.app_bundle_path,
    );
    if (manifest.app_path_token.len != expected_token.len) return error.InvalidUninstallManifest;
    if (!std.crypto.timing_safe.eql([64]u8, expected_token, manifest.app_path_token[0..64].*)) {
        return error.InvalidUninstallManifest;
    }
    try validateExistingMacosAppIdentityIfReadable(
        allocator,
        manifest.app_bundle_path,
        manifest.identifier,
        manifest.channel,
    );
}

fn writeMacosUninstallManifest(
    allocator: std.mem.Allocator,
    channel_dir: std.Io.Dir,
    manifest: MacosUninstallManifest,
) !void {
    const json = try std.json.Stringify.valueAlloc(allocator, manifest, .{ .whitespace = .indent_2 });
    defer allocator.free(json);
    var atomic_file = try channel_dir.createFileAtomic(g_io, MACOS_UNINSTALL_MANIFEST_NAME, .{ .replace = true });
    defer atomic_file.deinit(g_io);
    var buffer: [4096]u8 = undefined;
    var writer = atomic_file.file.writer(g_io, &buffer);
    try writer.interface.writeAll(json);
    try writer.flush();
    try atomic_file.file.sync(g_io);
    try atomic_file.replace(g_io);
}

fn loadAndValidateMacosManifest(
    allocator: std.mem.Allocator,
    manifest_path: []const u8,
    base_dir: []const u8,
) !struct { contents: []u8, parsed: std.json.Parsed(MacosUninstallManifest) } {
    var manifest_file = try std.Io.Dir.openFileAbsolute(g_io, manifest_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer manifest_file.close(g_io);
    var manifest_reader = manifest_file.reader(g_io, &.{});
    const contents = manifest_reader.interface.allocRemaining(allocator, .limited(64 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return manifest_reader.err.?,
        else => |e| return e,
    };
    errdefer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        MacosUninstallManifest,
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    errdefer parsed.deinit();
    try validateMacosUninstallManifest(allocator, parsed.value, base_dir);
    return .{ .contents = contents, .parsed = parsed };
}

fn macosManifestPath(allocator: std.mem.Allocator, base_dir: []const u8) ![]u8 {
    return std.fs.path.join(allocator, &.{ base_dir, MACOS_UNINSTALL_MANIFEST_NAME });
}

fn installMacosUninstallManager(
    allocator: std.mem.Allocator,
    source_app_bundle_path: []const u8,
    installed_app_bundle_path: []const u8,
    metadata: AppMetadata,
) !void {
    if (!isSafeMacosComponent(metadata.identifier) or
        !isSafeMacosComponent(metadata.channel) or
        !isSafeMacosDisplayName(metadata.name)) return error.InvalidInstallIdentity;

    const home = try getEnvOwned(allocator, "HOME");
    defer allocator.free(home);
    const base_dir = try std.fs.path.join(
        allocator,
        &.{ home, "Library", "Application Support", metadata.identifier, metadata.channel },
    );
    defer allocator.free(base_dir);
    var channel_dir = try ensureMacosInstallRoot(home, metadata.identifier, metadata.channel);
    defer channel_dir.close(g_io);

    var managed_paths = try macosManagedPathsFromInstallRoot(
        allocator,
        base_dir,
        metadata.identifier,
        metadata.channel,
    );
    defer managed_paths.deinit(allocator);
    const canonical_source_path = try std.Io.Dir.cwd().realPathFileAlloc(g_io, source_app_bundle_path, allocator);
    defer allocator.free(canonical_source_path);
    const canonical_installed_path = try std.Io.Dir.cwd().realPathFileAlloc(g_io, installed_app_bundle_path, allocator);
    defer allocator.free(canonical_installed_path);
    try validateRecordedMacosAppPath(allocator, canonical_installed_path, managed_paths.install_root);
    var installed = try readAndValidateInstalledMacosIdentity(
        allocator,
        canonical_source_path,
        metadata.identifier,
        metadata.channel,
    );
    defer installed.deinit(allocator);

    const source_path = try std.fs.path.join(
        allocator,
        &.{ canonical_source_path, "Contents", "Resources", MACOS_UNINSTALL_EXE_NAME },
    );
    defer allocator.free(source_path);
    var source_file = try std.Io.Dir.openFileAbsolute(g_io, source_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer source_file.close(g_io);
    const source_stat = try source_file.stat(g_io);
    if (source_stat.kind != .file) return error.InvalidUninstallManager;
    const uninstall_path = try std.fs.path.join(allocator, &.{ base_dir, MACOS_UNINSTALL_EXE_NAME });
    defer allocator.free(uninstall_path);
    var atomic_uninstaller = try channel_dir.createFileAtomic(g_io, MACOS_UNINSTALL_EXE_NAME, .{
        .replace = true,
        .permissions = .fromMode(0o755),
    });
    defer atomic_uninstaller.deinit(g_io);
    var source_reader = source_file.reader(g_io, &.{});
    var copy_buffer: [4096]u8 = undefined;
    var destination_writer = atomic_uninstaller.file.writer(g_io, &copy_buffer);
    _ = destination_writer.interface.sendFileAll(&source_reader, .unlimited) catch |err| switch (err) {
        error.ReadFailed => return source_reader.err.?,
        error.WriteFailed => return destination_writer.err.?,
    };
    try destination_writer.flush();
    try atomic_uninstaller.file.sync(g_io);
    try atomic_uninstaller.replace(g_io);

    const install_nonce = createMacosInstallNonce();
    const app_path_token = macosAppPathToken(
        &install_nonce,
        metadata.identifier,
        metadata.channel,
        canonical_installed_path,
    );
    const data_path_versions = [_]u32{MACOS_DATA_PATH_VERSION};
    const manifest = MacosUninstallManifest{
        .schema_version = MACOS_UNINSTALL_MANIFEST_VERSION,
        .install_nonce = &install_nonce,
        .identifier = metadata.identifier,
        .name = metadata.name,
        .channel = metadata.channel,
        .version = installed.version,
        .app_bundle_path = canonical_installed_path,
        .app_path_token = &app_path_token,
        .data_path_versions = &data_path_versions,
    };
    try writeMacosUninstallManifest(allocator, channel_dir, manifest);
    std.debug.print("Installed macOS uninstaller: {s}\n", .{uninstall_path});
}

fn refreshMacosUninstallMetadata(allocator: std.mem.Allocator) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    if (!std.mem.eql(u8, std.fs.path.basename(executable_path), MACOS_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    const base_dir = std.fs.path.dirname(executable_path) orelse return error.InvalidUninstallLocation;
    const manifest_path = try macosManifestPath(allocator, base_dir);
    defer allocator.free(manifest_path);
    var document = try loadAndValidateMacosManifest(allocator, manifest_path, base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const old = document.parsed.value;
    var installed = try readAndValidateInstalledMacosIdentity(
        allocator,
        old.app_bundle_path,
        old.identifier,
        old.channel,
    );
    defer installed.deinit(allocator);
    var channel_dir = try std.Io.Dir.openDirAbsolute(g_io, base_dir, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    defer channel_dir.close(g_io);
    const data_path_versions = [_]u32{MACOS_DATA_PATH_VERSION};
    try writeMacosUninstallManifest(allocator, channel_dir, .{
        .schema_version = MACOS_UNINSTALL_MANIFEST_VERSION,
        .install_nonce = old.install_nonce,
        .identifier = old.identifier,
        .name = old.name,
        .channel = old.channel,
        .version = installed.version,
        .app_bundle_path = old.app_bundle_path,
        .app_path_token = old.app_path_token,
        .data_path_versions = &data_path_versions,
    });
}

fn openMacosScopedIdentifierDir(
    home: []const u8,
    category: []const u8,
    identifier: []const u8,
) !?std.Io.Dir {
    var home_dir = std.Io.Dir.openDirAbsolute(g_io, home, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return null,
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    defer home_dir.close(g_io);
    var library_dir = home_dir.openDir(g_io, "Library", .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return null,
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    defer library_dir.close(g_io);
    var category_dir = library_dir.openDir(g_io, category, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return null,
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    defer category_dir.close(g_io);
    return category_dir.openDir(g_io, identifier, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => null,
        error.NotDir, error.SymLinkLoop => error.InvalidUninstallLocation,
        else => err,
    };
}

fn openMacosAppParent(app_bundle_path: []const u8) !?std.Io.Dir {
    const parent_path = std.fs.path.dirname(app_bundle_path) orelse return error.InvalidUninstallManifest;
    return std.Io.Dir.openDirAbsolute(g_io, parent_path, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => null,
        error.NotDir, error.SymLinkLoop => error.InvalidUninstallManifest,
        else => err,
    };
}

fn deleteMacosScopedRoot(parent: ?std.Io.Dir, channel: []const u8) !void {
    const dir = parent orelse return;
    try dir.deleteTree(g_io, channel);
}

fn uninstallMacos(allocator: std.mem.Allocator, requested_mode: ?MacosUninstallMode) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    if (!std.mem.eql(u8, std.fs.path.basename(executable_path), MACOS_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    const executable_stat = try std.Io.Dir.cwd().statFile(g_io, executable_path, .{ .follow_symlinks = false });
    if (executable_stat.kind != .file) return error.InvalidUninstallLocation;
    const base_dir = std.fs.path.dirname(executable_path) orelse return error.InvalidUninstallLocation;
    const manifest_path = try macosManifestPath(allocator, base_dir);
    defer allocator.free(manifest_path);
    var document = try loadAndValidateMacosManifest(allocator, manifest_path, base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const manifest = document.parsed.value;

    const mode: MacosUninstallMode = requested_mode orelse blk: {
        const name_z = try allocator.dupeZ(u8, manifest.name);
        defer allocator.free(name_z);
        break :blk switch (macos_uninstall_ui.electrobun_show_uninstall_prompt(name_z.ptr)) {
            1 => .app,
            2 => .app_and_data,
            else => return,
        };
    };
    var paths = try macosManagedPathsFromInstallRoot(
        allocator,
        base_dir,
        manifest.identifier,
        manifest.channel,
    );
    defer paths.deinit(allocator);

    // Open every recursive target's parent without following symlinks before
    // making any changes. Deletion is then relative to a pinned directory
    // handle and the final channel/app entry is handled by deleteTree without
    // following a root symlink.
    var install_identifier_dir = (try openMacosScopedIdentifierDir(
        paths.home,
        "Application Support",
        manifest.identifier,
    )) orelse return error.InvalidUninstallLocation;
    defer install_identifier_dir.close(g_io);
    var app_parent = try openMacosAppParent(manifest.app_bundle_path);
    defer if (app_parent) |*dir| dir.close(g_io);
    var cache_identifier_dir: ?std.Io.Dir = null;
    defer if (cache_identifier_dir) |*dir| dir.close(g_io);
    var logs_identifier_dir: ?std.Io.Dir = null;
    defer if (logs_identifier_dir) |*dir| dir.close(g_io);
    if (mode == .app_and_data) {
        cache_identifier_dir = try openMacosScopedIdentifierDir(
            paths.home,
            "Caches",
            manifest.identifier,
        );
        logs_identifier_dir = try openMacosScopedIdentifierDir(
            paths.home,
            "Logs",
            manifest.identifier,
        );
    }

    const app_path_z = try allocator.dupeZ(u8, manifest.app_bundle_path);
    defer allocator.free(app_path_z);
    _ = macos_uninstall_ui.electrobun_terminate_app_at_path(app_path_z.ptr);

    if (app_parent) |dir| try dir.deleteTree(g_io, std.fs.path.basename(manifest.app_bundle_path));

    if (mode == .app_and_data) {
        // Version 1 maps exactly to the three existing Utils.paths roots. The
        // manifest stores only resolver versions, never deletion paths.
        try deleteMacosScopedRoot(cache_identifier_dir, manifest.channel);
        try deleteMacosScopedRoot(logs_identifier_dir, manifest.channel);
        try install_identifier_dir.deleteTree(g_io, manifest.channel);
        return;
    }

    {
        var channel_dir = try install_identifier_dir.openDir(g_io, manifest.channel, .{
            .follow_symlinks = false,
            .iterate = true,
        });
        defer channel_dir.close(g_io);
        try channel_dir.deleteTree(g_io, "self-extraction");
        channel_dir.deleteFile(g_io, MACOS_UNINSTALL_EXE_NAME) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
        channel_dir.deleteFile(g_io, MACOS_UNINSTALL_MANIFEST_NAME) catch |err| switch (err) {
            error.FileNotFound => {},
            else => return err,
        };
    }
    install_identifier_dir.deleteDir(g_io, manifest.channel) catch {};
}

fn windowsUpdateTaskName(allocator: std.mem.Allocator, identifier: []const u8, channel: []const u8) ![]u8 {
    if (!isSafeWindowsComponent(identifier) or !isSafeWindowsComponent(channel)) {
        return error.InvalidInstallIdentity;
    }
    var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    hasher.update(identifier);
    hasher.update(&.{0});
    hasher.update(channel);
    hasher.final(&digest);
    return std.fmt.allocPrint(allocator, "ElectrobunUpdate_{x}", .{digest[0..12]});
}

pub fn main(init: std.process.Init) !void {
    g_io = init.io;
    g_environ_map = init.environ_map;

    const allocator = init.gpa;

    // Installed uninstallers are copies of this extractor. Dispatch management
    // modes before attempting to discover or extract an installer payload.
    if (builtin.os.tag == .windows) {
        var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
        defer args.deinit();
        _ = args.next() orelse return error.InvalidArguments;
        if (args.next()) |command| {
            if (std.mem.eql(u8, command, "--uninstall")) {
                if (args.next()) |option| {
                    if (!std.mem.eql(u8, option, "--quiet") or args.next() != null) {
                        return error.InvalidArguments;
                    }
                }
                try uninstallWindows(allocator);
                return;
            }
            if (std.mem.eql(u8, command, "--refresh-registration")) {
                if (args.next()) |option| {
                    if (!std.mem.eql(u8, option, "--quiet") or args.next() != null) {
                        return error.InvalidArguments;
                    }
                }
                try refreshWindowsUninstallRegistration(allocator);
                return;
            }
            if (std.mem.eql(u8, command, "--cleanup-uninstaller")) {
                const original_uninstaller = args.next() orelse return error.InvalidArguments;
                const manifest_path = args.next() orelse return error.InvalidArguments;
                const expected_install_nonce = args.next() orelse return error.InvalidArguments;
                if (args.next() != null) return error.InvalidArguments;
                try cleanupWindowsUninstaller(allocator, original_uninstaller, manifest_path, expected_install_nonce);
                return;
            }
            return error.InvalidArguments;
        }
    }
    if (builtin.os.tag == .linux) {
        var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
        defer args.deinit();
        const argv0 = args.next() orelse return error.InvalidArguments;
        // Only the installed manager requires an absolute lexical argv[0].
        // Setup archives are documented to run as `./installer`; resolving
        // every Linux executable as a manager would reject that normal path.
        if (std.mem.eql(u8, std.fs.path.basename(argv0), LINUX_UNINSTALL_EXE_NAME)) {
            const invocation_path = try linuxManagerInvocationPath(allocator, argv0);
            defer allocator.free(invocation_path);
            var command_args: [4][]const u8 = undefined;
            var command_args_len: usize = 0;
            while (args.next()) |arg| {
                if (command_args_len == command_args.len) return error.InvalidArguments;
                command_args[command_args_len] = arg;
                command_args_len += 1;
            }
            switch (try parseLinuxManagerCommand(command_args[0..command_args_len])) {
                .uninstall => |mode| try uninstallLinux(allocator, invocation_path, mode),
                .refresh_metadata => try refreshLinuxUninstallMetadata(allocator, invocation_path),
            }
            return;
        }
    }
    if (builtin.os.tag == .macos) {
        const executable_path = try std.process.executablePathAlloc(g_io, allocator);
        defer allocator.free(executable_path);
        if (std.mem.eql(u8, std.fs.path.basename(executable_path), MACOS_UNINSTALL_EXE_NAME)) {
            var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
            defer args.deinit();
            _ = args.next() orelse return error.InvalidArguments;
            var command_args: [4][]const u8 = undefined;
            var command_args_len: usize = 0;
            while (args.next()) |arg| {
                if (command_args_len == command_args.len) return error.InvalidArguments;
                command_args[command_args_len] = arg;
                command_args_len += 1;
            }
            switch (try parseMacosManagerCommand(command_args[0..command_args_len])) {
                .uninstall => |mode| try uninstallMacos(allocator, mode),
                .refresh_metadata => try refreshMacosUninstallMetadata(allocator),
            }
            return;
        }
    }

    std.debug.print("Electrobun self-extractor v1.3 starting...\n", .{});
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

    if (!isSafeMacosComponent(metadataParsed.value.identifier) or
        !isSafeMacosComponent(metadataParsed.value.channel) or
        !isSafeMacosDisplayName(metadataParsed.value.name))
    {
        return error.InvalidInstallIdentity;
    }

    const identifierName = try allocator.dupe(u8, metadataParsed.value.identifier);
    defer allocator.free(identifierName);

    const channelName = try allocator.dupe(u8, metadataParsed.value.channel);
    defer allocator.free(channelName);

    const appDisplayName = try allocator.dupe(u8, metadataParsed.value.name);
    defer allocator.free(appDisplayName);

    const hashName = try allocator.dupe(u8, metadataParsed.value.hash);
    defer allocator.free(hashName);

    const home_dir = try getEnvOwned(allocator, "HOME");
    defer allocator.free(home_dir);

    // Resolve and pin the managed channel root before reading or extracting
    // payload bytes. This rejects pre-existing symlinked path components
    // before any recursive installer cleanup can begin.
    var install_channel_dir = try ensureMacosInstallRoot(home_dir, identifierName, channelName);
    defer install_channel_dir.close(g_io);

    const appBundleResourcesPath = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, BUNLE_RESOURCES_REL_PATH });

    const compressedBundleFileName = try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{hashName});
    defer allocator.free(compressedBundleFileName);

    std.debug.print("compressedBundleFileName: {s}\n", .{compressedBundleFileName});

    const compressedTarballPath = try std.fs.path.join(allocator, &.{ appBundleResourcesPath, compressedBundleFileName });

    const compressedAppBundle = try std.Io.Dir.cwd().openFile(g_io, compressedTarballPath, .{}); //|compressedAppBundle| {
    const SELF_EXTRACTION_PATH = try prepareMacosSelfExtractionRoot(
        allocator,
        home_dir,
        identifierName,
        channelName,
    );
    defer allocator.free(SELF_EXTRACTION_PATH);

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

    try installMacosUninstallManager(allocator, newBundlePath, APPBUNDLE_PATH, .{
        .identifier = identifierName,
        .name = appDisplayName,
        .channel = channelName,
        .hash = hashName,
    });

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

test "Windows integration names and registry keys are channel scoped" {
    const production_display = try windowsDisplayName(std.testing.allocator, "Archive App", "production");
    defer std.testing.allocator.free(production_display);
    try std.testing.expectEqualStrings("Archive App", production_display);

    const canary_display = try windowsDisplayName(std.testing.allocator, "Archive App", "canary");
    defer std.testing.allocator.free(canary_display);
    try std.testing.expectEqualStrings("Archive App (Canary)", canary_display);

    const production_shortcut = try windowsShortcutFileName(std.testing.allocator, "Archive: App", "production");
    defer std.testing.allocator.free(production_shortcut);
    try std.testing.expectEqualStrings("Archive_ App.lnk", production_shortcut);

    const canary_shortcut = try windowsShortcutFileName(std.testing.allocator, "Archive: App", "canary");
    defer std.testing.allocator.free(canary_shortcut);
    try std.testing.expectEqualStrings("Archive_ App (Canary).lnk", canary_shortcut);
    try std.testing.expect(!std.mem.eql(u8, production_shortcut, canary_shortcut));

    const production_key = try windowsUninstallRegistryKey(std.testing.allocator, "com.example.archive", "production");
    defer std.testing.allocator.free(production_key);
    try std.testing.expectEqualStrings(
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.example.archive.production",
        production_key,
    );
    const canary_key = try windowsUninstallRegistryKey(std.testing.allocator, "com.example.archive", "canary");
    defer std.testing.allocator.free(canary_key);
    try std.testing.expectEqualStrings(
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.example.archive.canary",
        canary_key,
    );
}

test "macOS uninstall manager accepts only the explicit interactive and quiet grammar" {
    const interactive = try parseMacosManagerCommand(&.{});
    try std.testing.expect(interactive == .uninstall);
    try std.testing.expect(interactive.uninstall == null);

    const delegated = try parseMacosManagerCommand(&.{"--uninstall"});
    try std.testing.expect(delegated == .uninstall);
    try std.testing.expect(delegated.uninstall == null);

    const quiet = try parseMacosManagerCommand(&.{ "--uninstall", "--quiet" });
    try std.testing.expectEqual(MacosUninstallMode.app, quiet.uninstall.?);
    const delete_data = try parseMacosManagerCommand(&.{ "--quiet", "--delete-data" });
    try std.testing.expectEqual(MacosUninstallMode.app_and_data, delete_data.uninstall.?);
    try std.testing.expect((try parseMacosManagerCommand(&.{ "--refresh-metadata", "--quiet" })) == .refresh_metadata);

    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{"--delete-data"}));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{ "--uninstall", "--delete-data" }));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{ "--quiet", "--quiet" }));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{"--refresh-metadata"}));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{"--other"}));
}

test "Linux uninstall manager accepts only the explicit interactive and quiet grammar" {
    const direct = try parseLinuxManagerCommand(&.{});
    try std.testing.expect(direct == .uninstall);
    try std.testing.expect(direct.uninstall == null);

    const delegated = try parseLinuxManagerCommand(&.{"--uninstall"});
    try std.testing.expect(delegated == .uninstall);
    try std.testing.expect(delegated.uninstall == null);

    const quiet = try parseLinuxManagerCommand(&.{"--quiet"});
    try std.testing.expectEqual(LinuxUninstallMode.app, quiet.uninstall.?);
    const delegated_quiet = try parseLinuxManagerCommand(&.{ "--uninstall", "--quiet" });
    try std.testing.expectEqual(LinuxUninstallMode.app, delegated_quiet.uninstall.?);
    const delete_data = try parseLinuxManagerCommand(&.{ "--quiet", "--delete-data" });
    try std.testing.expectEqual(LinuxUninstallMode.app_and_data, delete_data.uninstall.?);
    const delegated_delete_data = try parseLinuxManagerCommand(&.{ "--uninstall", "--quiet", "--delete-data" });
    try std.testing.expectEqual(LinuxUninstallMode.app_and_data, delegated_delete_data.uninstall.?);
    try std.testing.expect((try parseLinuxManagerCommand(&.{ "--refresh-metadata", "--quiet" })) == .refresh_metadata);

    const invalid = [_][]const []const u8{
        &.{"--delete-data"},
        &.{ "--uninstall", "--delete-data" },
        &.{ "--uninstall", "--delete-data", "--quiet" },
        &.{ "--quiet", "--uninstall" },
        &.{ "--quiet", "--quiet" },
        &.{"--refresh-metadata"},
        &.{ "--refresh-metadata", "--quiet", "extra" },
        &.{"--other"},
    };
    for (invalid) |args| {
        try std.testing.expectError(error.InvalidArguments, parseLinuxManagerCommand(args));
    }
}

test "macOS uninstall manifest path token binds identity channel and exact app path" {
    const nonce = "0123456789abcdef0123456789abcdef";
    const expected = macosAppPathToken(
        nonce,
        "com.example.app",
        "production",
        "/Applications/Example.app",
    );
    try std.testing.expectEqualStrings(
        "7fa6c0415eb8c0360d268485b4fd9576e3c2d8d1163b3c76b7ec6359a7e9844e",
        &expected,
    );
    const canary = macosAppPathToken(
        nonce,
        "com.example.app",
        "canary",
        "/Applications/Example.app",
    );
    try std.testing.expect(!std.mem.eql(u8, &expected, &canary));
}

test "Windows install identities reject path traversal" {
    try std.testing.expect(isSafeWindowsComponent("com.example.archive"));
    try std.testing.expect(isSafeWindowsComponent("canary"));
    try std.testing.expect(!isSafeWindowsComponent(""));
    try std.testing.expect(!isSafeWindowsComponent(".."));
    try std.testing.expect(!isSafeWindowsComponent("..\\other"));
    try std.testing.expect(!isSafeWindowsComponent("C:escape"));
    try std.testing.expect(!isSafeWindowsComponent("%TEMP%"));
    try std.testing.expectError(
        error.InvalidInstallIdentity,
        windowsUninstallRegistryKey(std.testing.allocator, "com.example.archive", "..\\production"),
    );
}

test "Linux install identities and integration paths reject traversal" {
    try std.testing.expect(isSafeLinuxComponent("com.example.archive"));
    try std.testing.expect(isSafeLinuxComponent("canary channel"));
    try std.testing.expect(!isSafeLinuxComponent(""));
    try std.testing.expect(!isSafeLinuxComponent(".."));
    try std.testing.expect(!isSafeLinuxComponent("../production"));
    try std.testing.expect(!isSafeLinuxComponent("production/canary"));
    try std.testing.expect(!isSafeLinuxComponent("production\n"));

    try validateLinuxIntegrationPath(
        "/tmp/xdg data/applications/archive.desktop",
        "/tmp/xdg data/applications",
    );
    try std.testing.expectError(
        error.InvalidUninstallManifest,
        validateLinuxIntegrationPath(
            "/tmp/xdg data/applications/../archive.desktop",
            "/tmp/xdg data/applications",
        ),
    );
    try std.testing.expectError(
        error.InvalidUninstallManifest,
        validateLinuxIntegrationPath(
            "/tmp/xdg data/applications/nested/archive.desktop",
            "/tmp/xdg data/applications",
        ),
    );
    try std.testing.expectError(
        error.InvalidUninstallManifest,
        validateLinuxIntegrationPath(
            "archive.desktop",
            "/tmp/xdg data/applications",
        ),
    );
    try std.testing.expectError(
        error.InvalidUninstallManifest,
        validateLinuxIntegrationPath(
            "/tmp/not-the-current-root/applications/archive.desktop",
            "/tmp/xdg data/applications",
        ),
    );
}

test "Linux pinned roots reject a symlinked XDG intermediate" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDirPath(std.testing.io, "physical/applications");
    try tmp.dir.symLink(std.testing.io, "physical", "xdg-link", .{ .is_directory = true });
    const tmp_path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(tmp_path);
    const linked_root = try std.fs.path.join(
        std.testing.allocator,
        &.{ tmp_path, "xdg-link", "applications" },
    );
    defer std.testing.allocator.free(linked_root);
    g_io = std.testing.io;
    try std.testing.expectError(
        error.InvalidUninstallLocation,
        openLinuxAbsoluteDirNoSymlinks(linked_root),
    );
}

test "Linux desktop entry launcher paths are escaped" {
    const rewritten = try rewriteDesktopEntry(
        std.testing.allocator,
        "[Desktop Entry]\nExec=launcher\nIcon=theme-icon\n",
        "/tmp/Quoted \"App\"/bin/launcher",
        null,
    );
    defer std.testing.allocator.free(rewritten);
    try std.testing.expectEqualStrings(
        "[Desktop Entry]\nExec=\"/tmp/Quoted \\\"App\\\"/bin/launcher\"\nIcon=theme-icon\n",
        rewritten,
    );
    try std.testing.expect(try linuxDesktopEntryTargetsLauncher(
        std.testing.allocator,
        rewritten,
        "/tmp/Quoted \"App\"/bin/launcher",
    ));
    try std.testing.expect(!try linuxDesktopEntryTargetsLauncher(
        std.testing.allocator,
        rewritten,
        "/tmp/Quoted \"App\"/canary/bin/launcher",
    ));
    try std.testing.expect(!try linuxDesktopEntryTargetsLauncher(
        std.testing.allocator,
        "[Desktop Entry]\nExec=launcher --unexpected-argument\n",
        "/tmp/Quoted \"App\"/bin/launcher",
    ));
}

test "Windows deferred cleanup accepts only its install generation" {
    const first = "00112233445566778899aabbccddeeff";
    const second = "ffeeddccbbaa99887766554433221100";
    try std.testing.expect(isValidWindowsInstallNonce(first));
    try std.testing.expect(windowsInstallNonceMatches(first, first));
    try std.testing.expect(!windowsInstallNonceMatches(first, second));
    try std.testing.expect(!windowsInstallNonceMatches(first, "001122"));
    try std.testing.expect(!windowsInstallNonceMatches(first, "00112233445566778899aabbccddeezz"));
}

test "Windows update task identities are stable and channel scoped" {
    const production = try windowsUpdateTaskName(std.testing.allocator, "com.example.app", "production");
    defer std.testing.allocator.free(production);
    try std.testing.expectEqualStrings("ElectrobunUpdate_e765e7a8ffa45d1ada904e46", production);

    const canary = try windowsUpdateTaskName(std.testing.allocator, "com.example.app", "canary");
    defer std.testing.allocator.free(canary);
    try std.testing.expect(!std.mem.eql(u8, production, canary));
}

test "Windows uninstall registration reads the packaged app version" {
    const version = try parseInstalledVersion(
        std.testing.allocator,
        "{\"identifier\":\"com.example.archive\",\"version\":\"2.3.4-canary.5\"}",
    );
    defer std.testing.allocator.free(version);
    try std.testing.expectEqualStrings("2.3.4-canary.5", version);
    try std.testing.expectError(
        error.InvalidAppVersion,
        parseInstalledVersion(std.testing.allocator, "{\"version\":\"\"}"),
    );
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
