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
    hash: ?[]const u8 = null,
};

// Progress indicator for extraction
const ProgressIndicator = struct {
    child_process: ?std.process.Child,
    allocator: std.mem.Allocator,
    
    fn init(allocator: std.mem.Allocator, app_name: []const u8) ProgressIndicator {
        var self = ProgressIndicator{
            .child_process = null,
            .allocator = allocator,
        };
        
        // Try to start a progress dialog
        self.startProgressDialog(app_name) catch {
            // Fallback to console output
            std.debug.print("Extracting {s}...\n", .{app_name});
        };
        
        return self;
    }
    
    fn startProgressDialog(self: *ProgressIndicator, app_name: []const u8) !void {
        if (builtin.os.tag == .windows) {
            // For Windows, create an HTA (HTML Application) that shows a custom progress window
            // HTA runs without showing a console window and gives us full control over the UI
            const hta_content = try std.fmt.allocPrint(self.allocator,
                \\<html>
                \\<head>
                \\<title>Electrobun Installer</title>
                \\<HTA:APPLICATION
                \\    BORDER="dialog"
                \\    BORDERSTYLE="normal"
                \\    CAPTION="yes"
                \\    MAXIMIZEBUTTON="no"
                \\    MINIMIZEBUTTON="no"
                \\    SYSMENU="no"
                \\    SCROLL="no"
                \\    SINGLEINSTANCE="yes"
                \\    SHOWINTASKBAR="yes"
                \\/>
                \\<style>
                \\body {{
                \\    font-family: 'Segoe UI', Tahoma, sans-serif;
                \\    margin: 0;
                \\    padding: 30px;
                \\    background: white;
                \\    text-align: center;
                \\    overflow: hidden;
                \\}}
                \\h2 {{
                \\    color: #333;
                \\    margin: 0 0 15px 0;
                \\    font-size: 16px;
                \\    font-weight: 600;
                \\}}
                \\p {{
                \\    color: #666;
                \\    margin: 0;
                \\    font-size: 13px;
                \\}}
                \\</style>
                \\</head>
                \\<body>
                \\<h2>Extracting {s}...</h2>
                \\<p>Please wait, this may take a moment.</p>
                \\<script>
                \\window.resizeTo(400, 150);
                \\window.moveTo((screen.width - 400) / 2, (screen.height - 150) / 2);
                \\// Bring window to front after it's fully loaded and positioned
                \\var shell = new ActiveXObject("WScript.Shell");
                \\setTimeout(function() {{
                \\    shell.AppActivate("Electrobun Installer");
                \\}}, 200);
                \\</script>
                \\</body>
                \\</html>
            , .{app_name});
            defer self.allocator.free(hta_content);

            // Create temp HTA file
            const temp_dir = std.fs.getAppDataDir(self.allocator, "electrobun-installer") catch {
                return;
            };
            defer self.allocator.free(temp_dir);

            std.fs.makeDirAbsolute(temp_dir) catch {};

            const hta_path = try std.fs.path.join(self.allocator, &[_][]const u8{ temp_dir, "progress.hta" });
            defer self.allocator.free(hta_path);

            const file = std.fs.createFileAbsolute(hta_path, .{}) catch {
                return;
            };
            defer file.close();

            file.writeAll(hta_content) catch {
                return;
            };

            // Execute HTA file using mshta (no console window)
            const args = [_][]const u8{ "mshta", hta_path };

            var child = std.process.Child.init(&args, self.allocator);
            child.stdin_behavior = .Ignore;
            child.stdout_behavior = .Ignore;
            child.stderr_behavior = .Ignore;

            child.spawn() catch {
                // If mshta fails, silently continue without progress dialog
                return;
            };

            self.child_process = child;
            return;
        }

        if (builtin.os.tag != .linux) return;

        // Try zenity first (most common)
        const extract_text = try std.fmt.allocPrint(self.allocator, "--text=Extracting {s}...", .{app_name});
        defer self.allocator.free(extract_text);
        
        const zenity_args = [_][]const u8{
            "zenity", "--progress", "--pulsate", "--no-cancel",
            "--title=Electrobun Installer",
            extract_text,
            "--auto-close",
        };
        
        var child = std.process.Child.init(&zenity_args, self.allocator);
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Ignore;
        child.stderr_behavior = .Ignore;
        
        child.spawn() catch |err| {
            // Try kdialog for KDE
            if (err == error.FileNotFound) {
                const kdialog_text = try std.fmt.allocPrint(self.allocator, "Extracting {s}...", .{app_name});
                defer self.allocator.free(kdialog_text);
                
                const kdialog_args = [_][]const u8{
                    "kdialog", "--progressbar", kdialog_text, "0",
                    "--title", "Electrobun Installer",
                };
                
                var kde_child = std.process.Child.init(&kdialog_args, self.allocator);
                kde_child.stdin_behavior = .Ignore;
                kde_child.stdout_behavior = .Ignore;
                kde_child.stderr_behavior = .Ignore;
                
                kde_child.spawn() catch {
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
                stdin.close();
                child.stdin = null;
            }
            
            // Wait a moment for the dialog to close gracefully
            std.time.sleep(500 * std.time.ns_per_ms);
            
            // Terminate if still running
            _ = child.kill() catch {};
            _ = child.wait() catch {};
        }
    }
};

fn extractFromSelf(allocator: std.mem.Allocator) !bool {
    // Get path to self
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);
    
    // For Windows, check for adjacent archive file first
    if (builtin.os.tag == .windows) {
        // Try to read from adjacent .tar.zst file
        const exe_dir = std.fs.path.dirname(exe_path) orelse return error.InvalidPath;
        const exe_name = std.fs.path.basename(exe_path);
        const exe_stem = std.fs.path.stem(exe_name);
        
        // Look for adjacent archive file with pattern: <exe_stem>.tar.zst
        const archive_name = try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{exe_stem});
        defer allocator.free(archive_name);
        
        const archive_path = try std.fs.path.join(allocator, &.{ exe_dir, archive_name });
        defer allocator.free(archive_path);
        
        // Also check for metadata file
        const metadata_name = try std.fmt.allocPrint(allocator, "{s}.metadata.json", .{exe_stem});
        defer allocator.free(metadata_name);
        
        const metadata_path = try std.fs.path.join(allocator, &.{ exe_dir, metadata_name });
        defer allocator.free(metadata_path);
        
        // Try to open the metadata file
        if (std.fs.cwd().openFile(metadata_path, .{})) |metadata_file| {
            defer metadata_file.close();
            
            // Read metadata
            const metadata_contents = try metadata_file.readToEndAlloc(allocator, 4096);
            defer allocator.free(metadata_contents);
            
            const parsed = try std.json.parseFromSlice(struct {
                identifier: []const u8,
                name: []const u8,
                channel: []const u8,
                hash: []const u8,
            }, allocator, metadata_contents, .{ .ignore_unknown_fields = true });
            defer parsed.deinit();
            
            const metadata = AppMetadata{
                .identifier = try allocator.dupe(u8, parsed.value.identifier),
                .name = try allocator.dupe(u8, parsed.value.name),
                .channel = try allocator.dupe(u8, parsed.value.channel),
                .hash = try allocator.dupe(u8, parsed.value.hash),
            };
            
            std.debug.print("DEBUG: Parsed metadata hash: {s}\n", .{parsed.value.hash});
            
            // Don't free metadata fields here - they need to persist through extractAndInstall
            // They will be freed at the end of this function
            
            // Try to open the archive file
            if (std.fs.cwd().openFile(archive_path, .{})) |archive_file| {
                defer archive_file.close();
                
                std.debug.print("Found adjacent archive file: {s}\n", .{archive_path});
                std.debug.print("Using metadata: identifier={s}, name={s}, channel={s}\n", .{ metadata.identifier, metadata.name, metadata.channel });
                
                // Build application support directory path
                const app_data_dir = try getAppDataDir(allocator);
                defer allocator.free(app_data_dir);
                
                const app_name_channel = try std.fmt.allocPrint(allocator, "{s}-{s}", .{ metadata.name, metadata.channel });
                defer allocator.free(app_name_channel);
                
                // Build paths for new directory structure
                const app_base_dir = try std.fs.path.join(allocator, &.{ app_data_dir, metadata.identifier, app_name_channel });
                defer allocator.free(app_base_dir);
                
                const self_extraction_dir = try std.fs.path.join(allocator, &.{ app_base_dir, "self-extraction" });
                defer allocator.free(self_extraction_dir);
                
                // Handle Windows versioned app directories
                std.debug.print("\nDEBUG: Building app_dir path...\n", .{});
                std.debug.print("DEBUG: builtin.os.tag = {}\n", .{builtin.os.tag});
                std.debug.print("DEBUG: metadata.hash = {s}\n", .{metadata.hash orelse "null"});
                std.debug.print("DEBUG: app_base_dir = '{s}'\n", .{app_base_dir});
                
                const app_dir = if (builtin.os.tag == .windows) blk: {
                    if (metadata.hash) |hash| {
                        std.debug.print("DEBUG: Creating app folder name with hash: {s}\n", .{hash});
                        const app_folder_name = try std.fmt.allocPrint(allocator, "app-{s}", .{hash});
                        defer allocator.free(app_folder_name);
                        std.debug.print("DEBUG: app_folder_name = '{s}'\n", .{app_folder_name});
                        const joined_path = try std.fs.path.join(allocator, &.{ app_base_dir, app_folder_name });
                        std.debug.print("DEBUG: joined app_dir = '{s}'\n", .{joined_path});
                        break :blk joined_path;
                    } else {
                        std.debug.print("DEBUG: No hash, using 'app' folder\n", .{});
                        break :blk try std.fs.path.join(allocator, &.{ app_base_dir, "app" });
                    }
                } else try std.fs.path.join(allocator, &.{ app_base_dir, "app" });
                defer allocator.free(app_dir);
                
                std.debug.print("DEBUG: Final app_dir = '{s}'\n", .{app_dir});
                std.debug.print("DEBUG: app_dir length = {}\n", .{app_dir.len});
                
                std.debug.print("Extracting to: {s}\n", .{self_extraction_dir});
                std.debug.print("App will be installed to: {s}\n", .{app_dir});
                std.debug.print("DEBUG: app_base_dir = {s}\n", .{app_base_dir});
                std.debug.print("DEBUG: metadata.hash = {s}\n", .{metadata.hash orelse "null"});
                
                // Read compressed data from archive file
                const file_size = try archive_file.getEndPos();
                const compressed_data = try allocator.alloc(u8, file_size);
                defer allocator.free(compressed_data);
                
                try archive_file.seekTo(0);
                _ = try archive_file.read(compressed_data);
                
                // Continue with decompression (shared code path)
                const result = try extractAndInstall(allocator, compressed_data, metadata, self_extraction_dir, app_dir);
                // Clean up metadata fields
                allocator.free(metadata.identifier);
                allocator.free(metadata.name);
                allocator.free(metadata.channel);
                if (metadata.hash) |hash| {
                    allocator.free(hash);
                }
                
                return result;
            } else |_| {}
        } else |_| {}
    }
    
    // Fall back to embedded archive approach (for Linux or if adjacent files not found on Windows)
    // Open self for reading
    const self_file = try std.fs.openFileAbsolute(exe_path, .{});
    defer self_file.close();
    
    // Get file size
    const file_size = try self_file.getEndPos();
    
    
    // Read file to find the SECOND occurrence of the metadata marker
    // This avoids false positives if markers appear in the extractor binary or user code
    const search_buffer = try allocator.alloc(u8, file_size);
    defer allocator.free(search_buffer);
    
    try self_file.seekTo(0);
    _ = try self_file.readAll(search_buffer);
    
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
    const metadata = try readEmbeddedMetadata(allocator, self_file, metadata_start, archive_offset);
    
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
    
    try self_file.seekTo(archive_offset + ARCHIVE_MARKER.len);
    
    // Build application support directory path
    const app_data_dir = try getAppDataDir(allocator);
    defer allocator.free(app_data_dir);
    
    const app_name_channel = try std.fmt.allocPrint(allocator, "{s}-{s}", .{ metadata.name, metadata.channel });
    defer allocator.free(app_name_channel);
    
    // Build paths for new directory structure
    const app_base_dir = try std.fs.path.join(allocator, &.{ app_data_dir, metadata.identifier, app_name_channel });
    defer allocator.free(app_base_dir);
    
    const self_extraction_dir = try std.fs.path.join(allocator, &.{ app_base_dir, "self-extraction" });
    defer allocator.free(self_extraction_dir);
    
    const app_dir = if (builtin.os.tag == .windows) 
        if (metadata.hash) |hash| try std.fs.path.join(allocator, &.{ app_base_dir, try std.fmt.allocPrint(allocator, "app-{s}", .{hash}) }) else try std.fs.path.join(allocator, &.{ app_base_dir, "app" })
    else 
        try std.fs.path.join(allocator, &.{ app_base_dir, "app" });
    defer allocator.free(app_dir);
    
    std.debug.print("Self-extracting archive found at offset {d}\n", .{archive_offset});
    std.debug.print("Extracting to: {s}\n", .{self_extraction_dir});
    
    // Read and decompress archive (to end of file)
    const archive_size = file_size - (archive_offset + ARCHIVE_MARKER.len);
    const compressed_data = try allocator.alloc(u8, archive_size);
    defer allocator.free(compressed_data);
    
    _ = try self_file.read(compressed_data);
    
    // Continue with decompression (shared code path)
    return try extractAndInstall(allocator, compressed_data, safe_metadata, self_extraction_dir, app_dir);
}

fn extractAndInstall(allocator: std.mem.Allocator, compressed_data: []const u8, metadata: AppMetadata, self_extraction_dir: []const u8, app_dir: []const u8) !bool {
    
    // Initialize progress indicator
    var progress = ProgressIndicator.init(allocator, metadata.name);
    defer progress.deinit();
    
    // Get exe path for shortcuts
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);
    
    // Decompress using zstd
    // Note: because it's a big boy we need to allocate it on the heap (like macOS does)
    const window_buffer = try allocator.alloc(u8, 128 * 1024 * 1024); // 128MB Buffer
    defer allocator.free(window_buffer);
    
    var stream = std.io.fixedBufferStream(compressed_data);
    var decompressor = zstd.decompressor(stream.reader(), .{
        .window_buffer = window_buffer,
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
    
    // For Linux: Save the compressed archive to self-extraction directory (for future updates)
    // This is similar to what macOS does to enable the Updater API to apply patches
    // We'll save tar files after extraction to avoid them being deleted
    
    // Extract tar archive to self-extraction directory first
    std.debug.print("Extracting application files...\n", .{});
    
    try extractTar(allocator, decompressed_data.items, self_extraction_dir);
    
    // Now move the extracted app to the app directory
    // The app bundle is nested inside self-extraction, we need to find it
    // Use same sanitization as build process: remove spaces and dots
    std.debug.print("\nDEBUG: Building extracted app path...\n", .{});
    std.debug.print("DEBUG: metadata.name = '{s}'\n", .{metadata.name});
    std.debug.print("DEBUG: metadata.channel = '{s}'\n", .{metadata.channel});
    
    const sanitized_name = try std.mem.replaceOwned(u8, allocator, metadata.name, " ", "");
    defer allocator.free(sanitized_name);
    std.debug.print("DEBUG: sanitized_name = '{s}'\n", .{sanitized_name});
    
    const dots_removed = try std.mem.replaceOwned(u8, allocator, sanitized_name, ".", "-");
    defer allocator.free(dots_removed);
    std.debug.print("DEBUG: dots_removed = '{s}'\n", .{dots_removed});
    
    const app_bundle_name = try std.fmt.allocPrint(allocator, "{s}-{s}", .{ dots_removed, metadata.channel });
    defer allocator.free(app_bundle_name);
    std.debug.print("DEBUG: app_bundle_name = '{s}'\n", .{app_bundle_name});
    
    const extracted_app_path = try std.fs.path.join(allocator, &.{ self_extraction_dir, app_bundle_name });
    defer allocator.free(extracted_app_path);
    std.debug.print("DEBUG: extracted_app_path = '{s}'\n", .{extracted_app_path});
    
    // Check if app directory exists and move it to backup
    const backup_dir = try std.fs.path.join(allocator, &.{ self_extraction_dir, "backup" });
    defer allocator.free(backup_dir);
    
    // Clean up old backup if it exists
    std.fs.cwd().deleteTree(backup_dir) catch {};
    
    // Move existing app to backup (if it exists)
    std.fs.cwd().rename(app_dir, backup_dir) catch |err| switch (err) {
        error.FileNotFound => {},  // No existing app, that's fine
        else => return err,
    };
    
    // Move the extracted app to the app directory
    std.debug.print("\nDEBUG: Preparing to move app...\n", .{});
    std.debug.print("DEBUG: Source (extracted_app_path) = '{s}'\n", .{ extracted_app_path });
    std.debug.print("DEBUG: Destination (app_dir) = '{s}'\n", .{ app_dir });
    
    // Check if source exists
    std.fs.cwd().access(extracted_app_path, .{}) catch |err| {
        std.debug.print("ERROR: Source directory does not exist: '{s}' - {}\n", .{ extracted_app_path, err });
        // List what's actually in the extraction directory
        std.debug.print("DEBUG: Listing contents of extraction directory '{s}':\n", .{self_extraction_dir});
        var iter_dir = try std.fs.cwd().openDir(self_extraction_dir, .{ .iterate = true });
        defer iter_dir.close();
        var iterator = iter_dir.iterate();
        while (try iterator.next()) |entry| {
            std.debug.print("  - {s} ({s})\n", .{ entry.name, @tagName(entry.kind) });
        }
        return err;
    };
    std.debug.print("DEBUG: Source directory exists\n", .{});
    
    // On Windows, we need to create the parent directory first, then copy contents
    if (builtin.os.tag == .windows) {
        // Create the app directory and all parent directories
        std.debug.print("\nDEBUG: Windows directory creation...\n", .{});
        std.debug.print("DEBUG: Current working directory = {s}\n", .{try std.fs.cwd().realpathAlloc(allocator, ".")});
        std.debug.print("DEBUG: About to create Windows app directory: '{s}'\n", .{app_dir});
        std.debug.print("DEBUG: app_dir length = {}\n", .{app_dir.len});
        
        // Check if parent directory exists
        if (std.fs.path.dirname(app_dir)) |parent| {
            std.debug.print("DEBUG: Parent directory = '{s}'\n", .{parent});
            std.fs.cwd().access(parent, .{}) catch |err| {
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
        
        std.debug.print("DEBUG: Calling makePath...\n", .{});
        std.fs.cwd().makePath(app_dir) catch |err| {
            std.debug.print("ERROR: Failed to create app directory '{s}': {}\n", .{ app_dir, err });
            
            // Try to create parent directory first
            if (std.fs.path.dirname(app_dir)) |parent| {
                std.debug.print("DEBUG: Trying to create parent directory first: '{s}'\n", .{parent});
                std.fs.cwd().makePath(parent) catch |parent_err| {
                    std.debug.print("ERROR: Failed to create parent directory: {}\n", .{parent_err});
                };
            }
            
            return err;
        };
        std.debug.print("DEBUG: Successfully created app directory\n", .{});
        
        // Copy contents from extracted path to app directory
        try copyDirectory(allocator, extracted_app_path, app_dir);
        
        // Remove the extracted directory after successful copy
        std.fs.cwd().deleteTree(extracted_app_path) catch {};
    } else {
        // On Unix systems, rename works across directories
        std.fs.cwd().rename(extracted_app_path, app_dir) catch |err| {
            // If move fails, try to restore backup
            std.fs.cwd().rename(backup_dir, app_dir) catch {};
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
    
    // Create launcher symlink in same directory as self-extractor
    try createLocalLauncherScript(allocator, app_dir, metadata);
    
    // Create desktop shortcuts on Linux and Windows
    if (builtin.os.tag == .linux) {
        try createDesktopShortcut(allocator, app_dir, metadata);
    }
    
    if (builtin.os.tag == .windows) {
        try createWindowsShortcut(allocator, app_dir, metadata);
        if (metadata.hash != null) {
            try createWindowsLauncherScript(allocator, app_dir, metadata);
        }
    }
    
    // Save tar files for Updater API on Linux after everything else is done
    if (builtin.os.tag == .linux) {
        std.debug.print("\n✓ Saving tar files for Updater API...\n", .{});
        // Make a defensive copy of the hash to prevent memory corruption
        const safe_hash = if (metadata.hash) |h| try allocator.dupe(u8, h) else null;
        defer if (safe_hash != null) allocator.free(safe_hash.?);
        
        // Save compressed tar.zst file with hash as filename (for Updater API compatibility)
        const compressed_filename = if (safe_hash) |hash| 
            try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{hash})
        else 
            "current.tar.zst";
        defer if (safe_hash != null) allocator.free(compressed_filename);
        
        const compressed_path = try std.fs.path.join(allocator, &.{ self_extraction_dir, compressed_filename });
        defer allocator.free(compressed_path);
        
        // Ensure self-extraction directory exists
        try std.fs.cwd().makePath(self_extraction_dir);
        
        std.debug.print("DEBUG: Creating compressed file at: {s}\n", .{compressed_path});
        const compressed_file = try std.fs.cwd().createFile(compressed_path, .{});
        defer compressed_file.close();
        try compressed_file.writeAll(compressed_data);
        std.debug.print("✓ Saved compressed tar.zst ({} bytes)\n", .{compressed_data.len});
        
        // Also save decompressed tar for immediate use
        const tar_filename = if (safe_hash) |hash|
            try std.fmt.allocPrint(allocator, "{s}.tar", .{hash})
        else
            "current.tar";
        defer if (safe_hash != null) allocator.free(tar_filename);
        
        const tar_path = try std.fs.path.join(allocator, &.{ self_extraction_dir, tar_filename });
        defer allocator.free(tar_path);
        
        std.debug.print("DEBUG: Creating tar file at: {s}\n", .{tar_path});
        const tar_file = try std.fs.cwd().createFile(tar_path, .{});
        defer tar_file.close();
        try tar_file.writeAll(decompressed_data.items);
        std.debug.print("✓ Saved decompressed tar ({} bytes)\n", .{decompressed_data.items.len});
        
        // List files to confirm they're saved
        std.debug.print("\nDEBUG: Final files in self-extraction dir:\n", .{});
        var dir = try std.fs.cwd().openDir(self_extraction_dir, .{ .iterate = true });
        defer dir.close();
        var iter = dir.iterate();
        while (try iter.next()) |entry| {
            std.debug.print("  - {s} ({s})\n", .{ entry.name, @tagName(entry.kind) });
        }
    }
    
    std.debug.print("Installation completed successfully!\n", .{});
    return true;
}

fn extractTar(allocator: std.mem.Allocator, tar_data: []const u8, extract_dir: []const u8) !void {
    _ = allocator; // Mark as used (needed for potential path operations)
    
    std.debug.print("DEBUG: Starting tar extraction to: {s}\n", .{extract_dir});
    std.debug.print("DEBUG: Tar data size: {} bytes\n", .{tar_data.len});
    
    // Clean up existing directory if it exists to ensure no old files remain
    std.fs.cwd().deleteTree(extract_dir) catch |err| switch (err) {
        error.NotDir => {
            // Path exists but is not a directory, try to delete as file
            std.fs.cwd().deleteFile(extract_dir) catch {
                // If that fails too, just continue - we'll overwrite
            };
        },
        else => {
            // For any other error (including if directory doesn't exist), just continue
            // The makePath call below will create the directory as needed
        },
    };
    
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

fn fixExecutablePermissions(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    std.debug.print("DEBUG: fixExecutablePermissions called with dir: {s}\n", .{app_dir});
    
    // List of files that should be executable
    const executables = [_][]const u8{
        "bin/launcher",
        "bin/bun", 
        "bin/bspatch",
        "bin/bsdiff",
    };
    
    // Also check for scripts (handled in the iterator below)
    
    std.debug.print("DEBUG: Processing executables list...\n", .{});
    for (executables) |exe| {
        const exe_path = try std.fs.path.join(allocator, &.{ app_dir, exe });
        defer allocator.free(exe_path);
        
        // Set executable permissions (ignore errors if file doesn't exist)
        const file = std.fs.cwd().openFile(exe_path, .{}) catch continue;
        file.close();
        
        // Use chmod to set executable (skip on macOS app bundles to preserve code signatures)
        if (builtin.os.tag != .windows) {
            // On macOS, skip chmod for app bundles as it breaks code signatures
            if (builtin.os.tag == .macos and std.mem.indexOf(u8, app_dir, ".app") != null) {
                std.debug.print("DEBUG: Skipping chmod on macOS app bundle to preserve code signature: {s}\n", .{exe_path});
                continue;
            }
            
            const exe_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{exe_path});
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
        var dir = std.fs.cwd().openDir(app_dir, .{}) catch |err| {
            std.debug.print("DEBUG: Could not open directory {s}: {}\n", .{app_dir, err});
            return;
        };
        defer dir.close();
        
        std.debug.print("DEBUG: Directory opened successfully, starting iteration...\n", .{});
        var iterator = dir.iterate();
        while (try iterator.next()) |entry| {
            std.debug.print("DEBUG: Found entry: {s} kind: {}\n", .{entry.name, entry.kind});
            // Only process regular files (not directories, symlinks, etc.)
            switch (entry.kind) {
                .file => {
                    if (std.mem.endsWith(u8, entry.name, ".sh")) {
                        const script_path = try std.fs.path.join(allocator, &.{ app_dir, entry.name });
                        defer allocator.free(script_path);
                        
                        const script_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{script_path});
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
                }
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
    std.fs.cwd().access(cef_dir, .{}) catch {
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
        std.fs.cwd().deleteFile(symlink_path) catch {};
        
        // Create the symlink
        std.fs.cwd().symLink(target_path, symlink_path, .{}) catch |err| {
            std.debug.print("Warning: Could not create symlink for {s}: {}\n", .{ lib, err });
            continue;
        };
        
        std.debug.print("Created symlink: {s} -> {s}\n", .{ lib, target_path });
    }
}

fn removeQuarantine(allocator: std.mem.Allocator, app_dir: []const u8) !void {
    std.debug.print("Removing quarantine attributes from: {s}\n", .{app_dir});
    
    // Use xattr to remove com.apple.quarantine from the entire app bundle
    const args = [_][]const u8{ "xattr", "-r", "-d", "com.apple.quarantine", app_dir };
    
    var child_process = std.process.Child.init(&args, allocator);
    child_process.stdout_behavior = .Ignore;
    child_process.stderr_behavior = .Ignore;
    
    const result = child_process.spawnAndWait() catch |err| {
        std.debug.print("Warning: Failed to run xattr to remove quarantine: {}\n", .{err});
        return;
    };
    
    switch (result) {
        .Exited => |code| {
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

fn readEmbeddedMetadata(allocator: std.mem.Allocator, file: std.fs.File, metadata_start: u64, archive_start: u64) !AppMetadata {
    std.debug.print("DEBUG: metadata_start={d}, archive_start={d}\n", .{ metadata_start, archive_start });
    const metadata_size = archive_start - metadata_start;
    std.debug.print("DEBUG: calculated metadata_size={d}\n", .{metadata_size});
    if (metadata_size > 4096) return error.MetadataTooLarge; // Sanity check
    
    try file.seekTo(metadata_start);
    const metadata_bytes = try allocator.alloc(u8, metadata_size);
    defer allocator.free(metadata_bytes);
    
    _ = try file.read(metadata_bytes);
    
    // Debug: print the raw metadata before parsing
    std.debug.print("DEBUG: Raw metadata bytes (size={d})\n", .{metadata_size});
    std.debug.print("DEBUG: Raw metadata as hex: ", .{});
    for (metadata_bytes) |byte| {
        std.debug.print("{x:02} ", .{byte});
    }
    std.debug.print("\n", .{});
    std.debug.print("DEBUG: Raw metadata as string: '", .{});
    for (metadata_bytes) |byte| {
        if (byte >= 32 and byte <= 126) {
            std.debug.print("{c}", .{byte});
        } else {
            std.debug.print("\\x{x:02}", .{byte});
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

fn replaceSelfWithLauncher(allocator: std.mem.Allocator, exe_path: []const u8, app_dir: []const u8) !void {
    const launcher_name = if (builtin.os.tag == .windows) "launcher.exe" else "launcher";
    const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", launcher_name });
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

fn createLocalLauncherScript(allocator: std.mem.Allocator, app_dir: []const u8, metadata: AppMetadata) !void {
    // Get the directory where the self-extractor is located
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);
    
    const extractor_dir = std.fs.path.dirname(exe_path) orelse {
        std.debug.print("Warning: Could not get directory of self-extractor\n", .{});
        return;
    };
    
    // Create launcher symlink in the same directory as the self-extractor
    if (builtin.os.tag == .linux) {
        const symlink_name = try std.fmt.allocPrint(allocator, "{s}", .{metadata.name});
        defer allocator.free(symlink_name);
        
        const symlink_path = try std.fs.path.join(allocator, &.{ extractor_dir, symlink_name });
        defer allocator.free(symlink_path);
        
        // On Linux, look for an AppImage in the app directory
        const app_name_with_channel = try std.fmt.allocPrint(allocator, "{s}-{s}.AppImage", .{ 
            try std.mem.replaceOwned(u8, allocator, metadata.name, " ", ""),
            metadata.channel 
        });
        defer allocator.free(app_name_with_channel);
        
        const appimage_path = try std.fs.path.join(allocator, &.{ app_dir, app_name_with_channel });
        defer allocator.free(appimage_path);
        
        // Check if AppImage exists
        std.fs.cwd().access(appimage_path, .{}) catch |err| {
            std.debug.print("Warning: AppImage not found at {s}: {}\n", .{ appimage_path, err });
            return;
        };
        
        // Remove existing symlink if it exists
        std.fs.cwd().deleteFile(symlink_path) catch {};
        
        // Create symlink to the AppImage
        const appimage_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{appimage_path});
        defer allocator.free(appimage_path_z);
        
        const symlink_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{symlink_path});
        defer allocator.free(symlink_path_z);
        
        const result = std.c.symlink(appimage_path_z.ptr, symlink_path_z.ptr);
        if (result != 0) {
            std.debug.print("Warning: Failed to create symlink {s} -> {s}: errno={}\n", .{ symlink_path, appimage_path, result });
            return;
        }
        
        std.debug.print("Created launcher symlink: {s} -> {s}\n", .{ symlink_path, appimage_path });
    } else if (builtin.os.tag == .windows) {
        const script_name = try std.fmt.allocPrint(allocator, "Launch {s}.vbs", .{metadata.name});
        defer allocator.free(script_name);

        const script_path = try std.fs.path.join(allocator, &.{ extractor_dir, script_name });
        defer allocator.free(script_path);

        const launcher_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
        defer allocator.free(launcher_path);

        // Check if launcher exists
        std.fs.cwd().access(launcher_path, .{}) catch |err| {
            std.debug.print("Warning: Launcher not found at {s}: {}\n", .{ launcher_path, err });
            return;
        };

        // Use VBScript to launch without showing console window
        const script_content = try std.fmt.allocPrint(allocator,
            \\' Electrobun App Launcher
            \\' Launch {s}
            \\Set objShell = CreateObject("WScript.Shell")
            \\objShell.CurrentDirectory = "{s}\bin"
            \\objShell.Run "launcher.exe", 0, False
            \\
        , .{ metadata.name, app_dir });
        defer allocator.free(script_content);

        const script_file = try std.fs.cwd().createFile(script_path, .{});
        defer script_file.close();
        try script_file.writeAll(script_content);

        std.debug.print("Created local launcher script: {s}\n", .{script_path});
    }
}

fn createDesktopShortcut(allocator: std.mem.Allocator, app_dir: []const u8, metadata: AppMetadata) !void {
    // Get home directory for desktop path
    const home = std.process.getEnvVarOwned(allocator, "HOME") catch {
        std.debug.print("Warning: Could not get HOME directory\n", .{});
        return;
    };
    defer allocator.free(home);
    
    // Build desktop file path
    const desktop_dir = try std.fs.path.join(allocator, &.{ home, "Desktop" });
    defer allocator.free(desktop_dir);
    
    // Check if Desktop directory exists
    std.fs.cwd().access(desktop_dir, .{}) catch {
        std.debug.print("Warning: Desktop directory not found at {s}\n", .{desktop_dir});
        return;
    };
    
    // On Linux, look for an AppImage in the app directory
    const app_name_with_channel = try std.fmt.allocPrint(allocator, "{s}-{s}.AppImage", .{ 
        try std.mem.replaceOwned(u8, allocator, metadata.name, " ", ""),
        metadata.channel 
    });
    defer allocator.free(app_name_with_channel);
    
    const appimage_path = try std.fs.path.join(allocator, &.{ app_dir, app_name_with_channel });
    defer allocator.free(appimage_path);
    
    // Check if AppImage exists
    std.fs.cwd().access(appimage_path, .{}) catch |err| {
        std.debug.print("Warning: AppImage not found at {s}: {}\n", .{ appimage_path, err });
        return;
    };
    
    // Create desktop file name
    const desktop_filename = try std.fmt.allocPrint(allocator, "{s}.desktop", .{metadata.name});
    defer allocator.free(desktop_filename);
    
    const desktop_file_path = try std.fs.path.join(allocator, &.{ desktop_dir, desktop_filename });
    defer allocator.free(desktop_file_path);
    
    // Create a wrapper script for better library path handling
    // Place it as a sibling to the app directory so it persists across updates
    const parent_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidPath;
    const wrapper_script_path = try std.fs.path.join(allocator, &.{ parent_dir, "run.sh" });
    defer allocator.free(wrapper_script_path);
    
    const wrapper_content = try std.fmt.allocPrint(allocator,
        \\#!/bin/bash
        \\# Electrobun App Launcher for AppImage
        \\# This script launches the AppImage
        \\
        \\# Get the directory where this script is located
        \\SCRIPT_DIR="$(cd "$(dirname "${{BASH_SOURCE[0]}})" && pwd)"
        \\APP_DIR="$SCRIPT_DIR/app"
        \\
        \\# Execute the AppImage
        \\exec "$APP_DIR/{s}" "$@"
        \\
    , .{app_name_with_channel});
    defer allocator.free(wrapper_content);
    
    const wrapper_file = try std.fs.cwd().createFile(wrapper_script_path, .{});
    defer wrapper_file.close();
    try wrapper_file.writeAll(wrapper_content);
    
    // Make wrapper script executable
    const wrapper_script_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{wrapper_script_path});
    defer allocator.free(wrapper_script_path_z);
    _ = std.c.chmod(wrapper_script_path_z.ptr, 0o755);
    
    // Look for the desktop file in the extracted app directory and copy it
    var app_dir_handle = try std.fs.cwd().openDir(app_dir, .{ .iterate = true });
    defer app_dir_handle.close();
    
    var found_desktop_file = false;
    var iterator = app_dir_handle.iterate();
    while (try iterator.next()) |entry| {
        if (entry.kind == .file and std.mem.endsWith(u8, entry.name, ".desktop")) {
            // Copy the desktop file from app dir to Desktop
            const source_desktop = try std.fs.path.join(allocator, &.{ app_dir, entry.name });
            defer allocator.free(source_desktop);
            
            // Read the desktop file content
            const desktop_content = try std.fs.cwd().readFileAlloc(allocator, source_desktop, 4096);
            defer allocator.free(desktop_content);
            
            // Find icon file in app directory
            var icon_path: []const u8 = undefined;
            var icon_path_allocated = false;
            
            var icon_iterator = app_dir_handle.iterate();
            while (try icon_iterator.next()) |icon_entry| {
                if (icon_entry.kind == .file and std.mem.endsWith(u8, icon_entry.name, ".png")) {
                    icon_path = try std.fs.path.join(allocator, &.{ app_dir, icon_entry.name });
                    icon_path_allocated = true;
                    break;
                }
            }
            defer if (icon_path_allocated) allocator.free(icon_path);
            
            // Update the Exec and Icon lines in the desktop file
            var lines = std.mem.tokenize(u8, desktop_content, "\n");
            var result = std.ArrayList(u8).init(allocator);
            defer result.deinit();
            
            while (lines.next()) |line| {
                if (std.mem.startsWith(u8, line, "Exec=")) {
                    // Replace with new Exec line - point directly to AppImage
                    try result.appendSlice("Exec=\"");
                    try result.appendSlice(appimage_path);
                    try result.appendSlice("\"\n");
                } else if (std.mem.startsWith(u8, line, "Icon=") and icon_path_allocated) {
                    // Replace with new Icon line
                    try result.appendSlice("Icon=");
                    try result.appendSlice(icon_path);
                    try result.appendSlice("\n");
                } else {
                    try result.appendSlice(line);
                    try result.appendSlice("\n");
                }
            }
            
            // Write the updated desktop file to Desktop
            const desktop_file = try std.fs.cwd().createFile(desktop_file_path, .{});
            defer desktop_file.close();
            try desktop_file.writeAll(result.items);
            
            found_desktop_file = true;
            std.debug.print("Copied desktop shortcut to: {s}\n", .{desktop_file_path});
            break;
        }
    }
    
    if (!found_desktop_file) {
        std.debug.print("Warning: No desktop file found in extracted app directory\n", .{});
    }
    
    // Make desktop file executable (required for some desktop environments)
    const desktop_file_path_z = try std.fmt.allocPrintZ(allocator, "{s}", .{desktop_file_path});
    defer allocator.free(desktop_file_path_z);
    
    const result = std.c.chmod(desktop_file_path_z.ptr, 0o755);
    if (result != 0) {
        std.debug.print("Warning: Could not set executable permissions on desktop file\n", .{});
    }
    
    // Try to mark as trusted for GNOME/Ubuntu using gio
    const gio_argv = [_][]const u8{ "gio", "set", desktop_file_path, "metadata::trusted", "true" };
    _ = std.process.Child.run(.{
        .allocator = allocator,
        .argv = &gio_argv,
    }) catch |err| {
        std.debug.print("Note: Could not mark desktop file as trusted with gio: {}\n", .{err});
    };
    
    std.debug.print("Created desktop shortcut: {s}\n", .{desktop_file_path});
    std.debug.print("Note: If the desktop icon opens as text, right-click it and select 'Allow Launching' or 'Trust and Launch'\n", .{});
}

fn createWindowsShortcutFile(allocator: std.mem.Allocator, shortcut_dir: []const u8, app_name: []const u8, target_path: []const u8, working_dir: []const u8) !void {
    // Create a VBS script that launches without showing any console windows
    const vbs_name = try std.fmt.allocPrint(allocator, "{s}.vbs", .{app_name});
    defer allocator.free(vbs_name);
    
    const vbs_path = try std.fs.path.join(allocator, &.{ shortcut_dir, vbs_name });
    defer allocator.free(vbs_path);
    
    // VBS script to launch without console windows
    const vbs_content = try std.fmt.allocPrint(allocator,
        \\' Electrobun App Launcher - No Console Windows
        \\Set objShell = CreateObject("WScript.Shell")
        \\objShell.CurrentDirectory = "{s}"
        \\objShell.Run """{s}""", 0, False
        \\
    , .{ working_dir, target_path });
    defer allocator.free(vbs_content);
    
    // Create and write VBS file
    const vbs_file = std.fs.cwd().createFile(vbs_path, .{}) catch |err| {
        std.debug.print("Warning: Could not create shortcut at {s}: {}\n", .{ vbs_path, err });
        return;
    };
    defer vbs_file.close();
    
    vbs_file.writeAll(vbs_content) catch |err| {
        std.debug.print("Warning: Could not write shortcut content: {}\n", .{err});
        return;
    };
    
    std.debug.print("Created Windows shortcut: {s}\n", .{vbs_path});
}

fn createWindowsShortcut(allocator: std.mem.Allocator, app_dir: []const u8, metadata: AppMetadata) !void {
    // Get user directories
    const userprofile = std.process.getEnvVarOwned(allocator, "USERPROFILE") catch {
        std.debug.print("Warning: Could not get USERPROFILE directory\n", .{});
        return;
    };
    defer allocator.free(userprofile);
    
    const desktop_dir = try std.fs.path.join(allocator, &.{ userprofile, "Desktop" });
    defer allocator.free(desktop_dir);
    
    const start_menu_dir = try std.fs.path.join(allocator, &.{ userprofile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs" });
    defer allocator.free(start_menu_dir);
    
    // Check if Desktop directory exists
    std.fs.cwd().access(desktop_dir, .{}) catch {
        std.debug.print("Warning: Desktop directory not found at {s}\n", .{desktop_dir});
        // Continue anyway, might work
    };
    
    // For versioned app folders, point to run.bat instead of launcher.exe
    const parent_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidPath;
    const target_path = if (metadata.hash != null) 
        try std.fs.path.join(allocator, &.{ parent_dir, "run.bat" })
    else 
        try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(target_path);
    
    // Check if target exists
    std.fs.cwd().access(target_path, .{}) catch |err| {
        std.debug.print("Warning: Could not find target at {s}: {}\n", .{ target_path, err });
        return;
    };
    
    // Working directory should be the parent directory for run.bat or bin directory for launcher.exe
    const working_dir = if (metadata.hash != null)
        parent_dir
    else
        try std.fs.path.join(allocator, &.{ app_dir, "bin" });
    defer if (metadata.hash == null) allocator.free(working_dir);
    
    // Create desktop shortcut
    try createWindowsShortcutFile(allocator, desktop_dir, metadata.name, target_path, working_dir);
    
    // Create Start Menu shortcut
    // Make sure Start Menu directory exists
    std.fs.cwd().makePath(start_menu_dir) catch {
        std.debug.print("Warning: Could not create Start Menu directory\n", .{});
    };
    try createWindowsShortcutFile(allocator, start_menu_dir, metadata.name, target_path, working_dir);
    
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
    const reg_file = std.fs.cwd().createFile(reg_path, .{}) catch |err| {
        std.debug.print("Warning: Could not create uninstall registry file: {}\n", .{err});
        return;
    };
    defer reg_file.close();
    
    reg_file.writeAll(reg_content) catch |err| {
        std.debug.print("Warning: Could not write registry content: {}\n", .{err});
        return;
    };
    
    std.debug.print("Created uninstall registry file: {s}\n", .{reg_path});
    std.debug.print("Note: Users can double-click {s} to add uninstall info to Windows\n", .{reg_name});
}

pub fn main() !void {
    std.debug.print("Electrobun self-extractor v1.3 starting...\n", .{});
    var allocator = std.heap.page_allocator;

    var startTime = std.time.nanoTimestamp();

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched
    // const args = try std.process.argsAlloc(allocator);
    // defer std.process.argsFree(allocator, args);
    // const cwd = std.fs.path.dirname(args[0]).?;

    var exePathBuffer: [1024]u8 = undefined;
    const APPBUNDLE_MACOS_PATH = try std.fs.selfExeDirPath(exePathBuffer[0..]);
    
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
    
    // macOS uses the plist approach
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
                    if (builtin.os.tag == .windows) {
                        std.debug.print("DEBUG: Creating directory: '{s}'\n", .{file_name});
                    }
                    dir.makePath(file_name) catch |err| {
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
                    dir.makePath(dir_name) catch |err| {
                        if (builtin.os.tag == .windows) {
                            std.debug.print("ERROR: Failed to create parent dir '{s}': {}\n", .{ dir_name, err });
                        }
                        return err;
                    };
                }

                const mode = if (builtin.os.tag == .windows) 0 else header.mode() catch undefined;

                if (builtin.os.tag == .windows) {
                    std.debug.print("DEBUG: Creating file: '{s}'\n", .{file_name});
                }
                var file = dir.createFile(file_name, .{ .mode = mode }) catch |err| {
                    if (builtin.os.tag == .windows) {
                        std.debug.print("ERROR: Failed to create file '{s}': {}\n", .{ file_name, err });
                    }
                    return err;
                };
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
                        const ask = @min(buffer.len - end, 512);
                        end += try reader.readAtLeast(buffer[end..], ask);
                    }
                    
                    @memcpy(link_target_buffer[0..bytes_to_read], buffer[start..start + bytes_to_read]);
                    start += file_size;
                    
                    // Add padding
                    const rounded_link_size = std.mem.alignForward(u64, file_size, 512);
                    const link_pad_len = @as(usize, @intCast(rounded_link_size - file_size));
                    start += link_pad_len;
                    
                    const link_target = link_target_buffer[0..bytes_to_read];
                    
                    // Create parent directory if needed
                    if (std.fs.path.dirname(link_name)) |dir_name| {
                        try dir.makePath(dir_name);
                    }
                    
                    // Create the symbolic link
                    if (builtin.os.tag == .windows) {
                        // On Windows, symlinks require special privileges, so skip them
                        // TODO: Consider copying the target file instead for Windows
                        std.debug.print("Skipping symlink creation on Windows: {s} -> {s}\n", .{ link_name, link_target });
                    } else {
                        dir.symLink(link_target, link_name, .{}) catch {
                            // On error, try to remove existing file/link and retry
                            dir.deleteFile(link_name) catch {};
                            dir.symLink(link_target, link_name, .{}) catch |err| {
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
    const run_bat_file = try std.fs.cwd().createFile(run_bat_path, .{});
    defer run_bat_file.close();
    try run_bat_file.writeAll(launcher_content);
    
    std.debug.print("Created Windows launcher script: {s}\n", .{run_bat_path});
}
fn copyDirectory(allocator: std.mem.Allocator, src_path: []const u8, dest_path: []const u8) !void {
    std.debug.print("\nDEBUG copyDirectory: src='{s}' dest='{s}'\n", .{ src_path, dest_path });
    
    var src_dir = std.fs.cwd().openDir(src_path, .{ .iterate = true }) catch |err| {
        std.debug.print("ERROR: Failed to open source directory '{s}': {}\n", .{ src_path, err });
        return err;
    };
    defer src_dir.close();
    
    var iterator = src_dir.iterate();
    while (try iterator.next()) |entry| {
        const src_item_path = try std.fs.path.join(allocator, &.{ src_path, entry.name });
        defer allocator.free(src_item_path);
        
        const dest_item_path = try std.fs.path.join(allocator, &.{ dest_path, entry.name });
        defer allocator.free(dest_item_path);
        
        switch (entry.kind) {
            .directory => {
                // Create directory and recursively copy contents
                std.fs.cwd().makeDir(dest_item_path) catch |err| switch (err) {
                    error.PathAlreadyExists => {},
                    else => return err,
                };
                try copyDirectory(allocator, src_item_path, dest_item_path);
            },
            .file => {
                // Copy file
                try std.fs.cwd().copyFile(src_item_path, std.fs.cwd(), dest_item_path, .{});
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