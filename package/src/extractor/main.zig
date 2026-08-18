const std = @import("std");
const builtin = @import("builtin");
const zstd = std.compress.zstd;
const linux_uninstall_prompt = @import("linux_uninstall_prompt.zig");

// Initialized at the top of main(). Test-only helpers do not touch these.
var g_io: std.Io = undefined;
var g_environ_map: *std.process.Environ.Map = undefined;
var g_bootstrap_stage: []const u8 = "command dispatch";
var g_bootstrap_trace_enabled = false;
var g_installer_failure_presented = false;

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
const WINDOWS_BUNDLED_UNINSTALL_EXE_NAME = "uninstall";
const WINDOWS_UNINSTALL_MANIFEST_NAME = ".electrobun-uninstall.json";
const WINDOWS_UNINSTALL_MANIFEST_VERSION: u32 = 1;
const WINDOWS_DATA_PATH_VERSION: u32 = 1;
const WINDOWS_UPDATE_REFRESH_STAGE_PREFIX = "electrobun-uninstall-refresh-";
const WINDOWS_UPDATE_REFRESH_STAGE_SUFFIX = ".exe";
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
const APPLY_UPDATE_PLAN_SCHEMA_VERSION: u32 = 1;
const APPLY_UPDATE_RESULT_SCHEMA_VERSION: u32 = 1;
const APPLY_UPDATE_TRANSACTION_HEX_LENGTH: usize = 32;
const APPLY_UPDATE_PLAN_PREFIX = ".electrobun-update-";
const APPLY_UPDATE_PLAN_SUFFIX = ".json";
const APPLY_UPDATE_RESULT_SUFFIX = ".result.json";
const APPLY_UPDATE_HELPER_PREFIX = "electrobun-update-";
const APPLY_UPDATE_PREPARED_FILE = ".electrobun-prepared-update.json";
const APPLY_UPDATE_PARENT_WAIT_MILLISECONDS: u64 = 120_000;
const APPLY_UPDATE_WINDOWS_RENAME_RETRIES: usize = 60;
const APPLY_UPDATE_WINDOWS_RENAME_RETRY_MILLISECONDS: u64 = 500;

const macos_uninstall_ui = if (builtin.os.tag == .macos) struct {
    extern fn electrobun_show_uninstall_prompt(app_name_utf8: [*:0]const u8) c_int;
    extern fn electrobun_preview_macos_uninstall_prompt(app_name_utf8: [*:0]const u8) c_int;
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
    extern "kernel32" fn OpenProcess(
        desired_access: win.DWORD,
        inherit_handle: win.BOOL,
        process_id: win.DWORD,
    ) callconv(.winapi) ?win.HANDLE;
    extern "kernel32" fn ReleaseMutex(handle: win.HANDLE) callconv(.winapi) win.BOOL;
    extern "kernel32" fn CloseHandle(handle: win.HANDLE) callconv(.winapi) win.BOOL;
    extern "kernel32" fn GetLastError() callconv(.winapi) win.DWORD;
    extern "kernel32" fn MoveFileExW(
        existing_file_name: [*:0]const u16,
        new_file_name: ?[*:0]const u16,
        flags: win.DWORD,
    ) callconv(.winapi) win.BOOL;

    const wait_object_0: win.DWORD = 0x00000000;
    const wait_abandoned: win.DWORD = 0x00000080;
    const wait_timeout: win.DWORD = 0x00000102;
    const no_wait: win.DWORD = 0;
    const infinite: win.DWORD = 0xffffffff;
    const synchronize: win.DWORD = 0x00100000;
    const wait_failed: win.DWORD = 0xffffffff;
    const error_invalid_parameter: win.DWORD = 87;
    const movefile_delay_until_reboot: win.DWORD = 0x00000004;
} else struct {};

const windows_uninstall_ui = if (builtin.os.tag == .windows) struct {
    extern fn electrobun_show_windows_uninstall_prompt(app_name: [*:0]const u16) callconv(.c) c_int;
    extern fn electrobun_preview_windows_uninstall_prompt(app_name: [*:0]const u16) callconv(.c) c_int;
    extern fn electrobun_atomic_copy_windows_manager(
        source_path: [*:0]const u16,
        destination_path: [*:0]const u16,
    ) callconv(.c) c_int;
    extern fn electrobun_read_windows_file_exact(
        path: [*:0]const u16,
        buffer: [*]u8,
        expected_size: usize,
    ) callconv(.c) c_int;
} else struct {};

const windows_installer_ui = if (builtin.os.tag == .windows) struct {
    extern fn electrobun_windows_installer_ui_start(app_name: [*:0]const u16) callconv(.c) ?*anyopaque;
    extern fn electrobun_windows_installer_ui_set_phase(
        ui: *anyopaque,
        phase: [*:0]const u16,
        marquee: c_int,
    ) callconv(.c) void;
    extern fn electrobun_windows_installer_ui_set_progress(ui: *anyopaque, percent: u32) callconv(.c) void;
    extern fn electrobun_windows_installer_ui_complete(
        ui: *anyopaque,
        succeeded: c_int,
        message: [*:0]const u16,
    ) callconv(.c) void;
    extern fn electrobun_windows_installer_ui_close(ui: *anyopaque) callconv(.c) void;
} else struct {};

const macos_installer_ui = if (builtin.os.tag == .macos) struct {
    extern fn electrobun_macos_installer_ui_start(app_name: [*:0]const u8) callconv(.c) ?*anyopaque;
    extern fn electrobun_macos_installer_ui_set_phase(
        ui: *anyopaque,
        phase: [*:0]const u8,
        marquee: c_int,
    ) callconv(.c) void;
    extern fn electrobun_macos_installer_ui_set_progress(ui: *anyopaque, percent: u32) callconv(.c) void;
    extern fn electrobun_macos_installer_ui_complete(
        ui: *anyopaque,
        succeeded: c_int,
        message: [*:0]const u8,
    ) callconv(.c) void;
    extern fn electrobun_macos_installer_ui_close(ui: *anyopaque) callconv(.c) void;
} else struct {};

// Metadata structure embedded in the binary
const AppMetadata = struct {
    identifier: []const u8,
    name: []const u8,
    channel: []const u8,
    hash: ?[]const u8 = null,
    install_root_name: ?[]const u8 = null,
};

const BootstrapMetadata = struct {
    identifier: []u8,
    name: []u8,
    channel: []u8,
    hash: ?[]u8,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.identifier);
        allocator.free(self.name);
        allocator.free(self.channel);
        if (self.hash) |hash| allocator.free(hash);
        self.* = undefined;
    }

    fn appMetadata(self: *const @This(), install_root_name: []const u8) AppMetadata {
        return .{
            .identifier = self.identifier,
            .name = self.name,
            .channel = self.channel,
            .hash = self.hash,
            .install_root_name = install_root_name,
        };
    }
};

fn parseBootstrapMetadata(
    allocator: std.mem.Allocator,
    contents: []const u8,
) !BootstrapMetadata {
    const parsed = try std.json.parseFromSlice(
        struct {
            version: []const u8,
            identifier: []const u8,
            channel: []const u8,
            name: []const u8,
            displayName: ?[]const u8 = null,
            hash: ?[]const u8 = null,
        },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();

    const display_name = parsed.value.displayName orelse parsed.value.name;
    const valid_component = if (builtin.os.tag == .windows)
        isSafeWindowsComponent
    else if (builtin.os.tag == .linux)
        isSafeLinuxComponent
    else
        isSafeMacosComponent;
    const valid_display_name = if (builtin.os.tag == .windows)
        isSafeWindowsDisplayName(display_name)
    else if (builtin.os.tag == .linux)
        isSafeLinuxDisplayName(display_name)
    else
        isSafeMacosDisplayName(display_name);
    if (parsed.value.version.len == 0 or
        !valid_component(parsed.value.identifier) or
        !isBuildChannel(parsed.value.channel) or
        !valid_display_name or
        (parsed.value.hash != null and !valid_component(parsed.value.hash.?)))
    {
        return error.InvalidInstalledIdentity;
    }

    const identifier = try allocator.dupe(u8, parsed.value.identifier);
    errdefer allocator.free(identifier);
    const name = try allocator.dupe(u8, display_name);
    errdefer allocator.free(name);
    const channel = try allocator.dupe(u8, parsed.value.channel);
    errdefer allocator.free(channel);
    return .{
        .identifier = identifier,
        .name = name,
        .channel = channel,
        .hash = if (parsed.value.hash) |hash| try allocator.dupe(u8, hash) else null,
    };
}

fn readBootstrapMetadata(
    allocator: std.mem.Allocator,
    version_path: []const u8,
) !BootstrapMetadata {
    var file = try std.Io.Dir.openFileAbsolute(g_io, version_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer file.close(g_io);
    prepareNoFollowFileForRead(&file);
    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(g_io, &read_buffer);
    const contents = reader.interface.allocRemaining(allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return reader.err.?,
        else => |other| return other,
    };
    defer allocator.free(contents);
    return parseBootstrapMetadata(allocator, contents);
}

const ApplyUpdatePlan = struct {
    schema_version: u32,
    transaction_id: []const u8,
    identifier: []const u8,
    channel: []const u8,
    platform: []const u8,
    arch: []const u8,
    version: []const u8,
    hash: []const u8,
    channel_root: []const u8,
    app_bundle_path: []const u8,
    retained_tar_path: []const u8,
    parent_pid: u32,
    result_path: []const u8,
};

const ApplyUpdatePreparedRecord = struct {
    schema_version: u32,
    identifier: []const u8,
    channel: []const u8,
    platform: []const u8,
    arch: []const u8,
    version: []const u8,
    hash: []const u8,
    retained_tar_path: []const u8,
};

const ApplyUpdatePhase = enum {
    validating,
    waiting_for_parent,
    extracting,
    validating_payload,
    swapping,
    integrating,
    launching,
    complete,
};

const ApplyUpdateResult = struct {
    schema_version: u32 = APPLY_UPDATE_RESULT_SCHEMA_VERSION,
    transaction_id: []const u8,
    success: bool,
    phase: []const u8,
    message: []const u8,
    identifier: []const u8,
    channel: []const u8,
    version: []const u8,
    hash: []const u8,
};

const StagedUpdateIdentity = struct {
    version: []const u8,
    hash: []const u8,
    channel: []const u8,
    identifier: []const u8,
    displayName: []const u8,
};

fn isBuildChannel(channel: []const u8) bool {
    return std.mem.eql(u8, channel, "stable") or
        std.mem.eql(u8, channel, "canary") or
        std.mem.eql(u8, channel, "dev");
}

fn installedChannelMatches(actual: []const u8, expected: []const u8) bool {
    return std.mem.eql(u8, actual, expected);
}

const EmbeddedMetadataJson = struct {
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
    install_root_name: ?[]const u8 = null,
    // Missing on manifests written by the first Windows uninstaller. A null
    // value is the legacy spelling of the version-1 managed-path policy.
    data_path_versions: ?[]const u32 = null,
};

const WindowsUninstallMode = enum {
    app,
    app_and_data,
};

const WindowsManagerCommand = union(enum) {
    uninstall: ?WindowsUninstallMode,
    bootstrap_install: []const u8,
    refresh_registration,
    refresh_registration_from_update: []const u8,
    cleanup_uninstaller: struct {
        original_uninstaller: []const u8,
        manifest_path: []const u8,
        install_nonce: []const u8,
        delete_data: bool,
    },
};

fn parseWindowsManagerCommand(args: []const []const u8) !WindowsManagerCommand {
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
    if (std.mem.eql(u8, args[0], "--refresh-registration")) {
        return switch (args.len) {
            1 => .refresh_registration,
            2 => if (std.mem.eql(u8, args[1], "--quiet"))
                .refresh_registration
            else
                error.InvalidArguments,
            else => error.InvalidArguments,
        };
    }
    if (std.mem.eql(u8, args[0], "--bootstrap-install")) {
        if (args.len != 3 or
            args[1].len == 0 or
            !std.mem.eql(u8, args[2], "--quiet"))
        {
            return error.InvalidArguments;
        }
        return .{ .bootstrap_install = args[1] };
    }
    if (std.mem.eql(u8, args[0], "--refresh-registration-from-update")) {
        if (args.len != 3 or
            args[1].len == 0 or
            !std.mem.eql(u8, args[2], "--quiet"))
        {
            return error.InvalidArguments;
        }
        return .{ .refresh_registration_from_update = args[1] };
    }
    if (std.mem.eql(u8, args[0], "--cleanup-uninstaller")) {
        if (args.len != 4 and args.len != 5) return error.InvalidArguments;
        if (args.len == 5 and !std.mem.eql(u8, args[4], "--delete-data")) {
            return error.InvalidArguments;
        }
        return .{ .cleanup_uninstaller = .{
            .original_uninstaller = args[1],
            .manifest_path = args[2],
            .install_nonce = args[3],
            .delete_data = args.len == 5,
        } };
    }
    return error.InvalidArguments;
}

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

const LinuxDesktopCollisionPolicy = enum {
    preserve,
    // v1 created these entries before Linux uninstall manifests recorded
    // ownership hashes. Only migration paths may reclaim an exact match.
    adopt_matching_legacy,
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
    install_root_name: ?[]const u8 = null,
};

const LinuxUninstallMode = enum {
    app,
    app_and_data,
};

const LinuxManagerCommand = union(enum) {
    uninstall: ?LinuxUninstallMode,
    bootstrap_install: []const u8,
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
    if (std.mem.eql(u8, args[0], "--bootstrap-install")) {
        if (args.len != 3 or
            args[1].len == 0 or
            !std.mem.eql(u8, args[2], "--quiet"))
        {
            return error.InvalidArguments;
        }
        return .{ .bootstrap_install = args[1] };
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
    install_root_name: ?[]const u8 = null,
};

const MacosUninstallMode = enum {
    app,
    app_and_data,
};

const MacosManagerCommand = union(enum) {
    uninstall: ?MacosUninstallMode,
    bootstrap_install: []const u8,
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
    if (std.mem.eql(u8, args[0], "--bootstrap-install")) {
        if (args.len != 3 or
            args[1].len == 0 or
            !std.mem.eql(u8, args[2], "--quiet"))
        {
            return error.InvalidArguments;
        }
        return .{ .bootstrap_install = args[1] };
    }
    return error.InvalidArguments;
}

const InstallPhase = enum {
    preparing,
    decompressing,
    extracting,
    installing_files,
    integrating,
    completed,
    failed,

    fn text(self: InstallPhase) []const u8 {
        return switch (self) {
            .preparing => "Preparing installation...",
            .decompressing => "Decompressing application...",
            .extracting => "Extracting application files...",
            .installing_files => "Installing application files...",
            .integrating => "Creating shortcuts and integration...",
            .completed => "Installation completed successfully.",
            .failed => "Installation failed.",
        };
    }
};

const InstallProgress = struct {
    phase: InstallPhase,
    completed_bytes: ?u64 = null,
    total_bytes: ?u64 = null,

    fn isDeterminate(self: InstallProgress) bool {
        return self.completed_bytes != null and self.total_bytes != null and self.total_bytes.? != 0;
    }

    fn percent(self: InstallProgress) ?u32 {
        if (self.phase == .failed) return null;
        if (self.phase == .completed) return 100;
        const completed = self.completed_bytes orelse return null;
        const total = self.total_bytes orelse return null;
        if (total == 0) return null;
        const bounds: struct { start: u32, end: u32 } = switch (self.phase) {
            .preparing => .{ .start = 0, .end = 5 },
            .decompressing => .{ .start = 5, .end = 45 },
            .extracting => .{ .start = 45, .end = 70 },
            .installing_files => .{ .start = 70, .end = 90 },
            .integrating => .{ .start = 90, .end = 99 },
            .completed => unreachable,
            .failed => unreachable,
        };
        const range: u128 = bounds.end - bounds.start;
        const numerator: u128 = @as(u128, @min(completed, total)) * range;
        const mapped: u128 = @as(u128, bounds.start) + numerator / @as(u128, total);
        return @intCast(@min(mapped, bounds.end));
    }
};

const KdialogProgressReference = struct {
    service: []const u8,
    object_path: []const u8,
};

const KdialogProgress = struct {
    dbus_command: []const u8,
    service: []u8,
    object_path: []u8,
};

fn parseKdialogProgressReference(output: []const u8) ?KdialogProgressReference {
    var tokens = std.mem.tokenizeAny(u8, output, " \t\r\n");
    const service = tokens.next() orelse return null;
    const object_path = tokens.next() orelse return null;
    if (tokens.next() != null) return null;

    const service_prefix = "org.kde.kdialog-";
    if (!std.mem.startsWith(u8, service, service_prefix)) return null;
    const pid = service[service_prefix.len..];
    if (pid.len == 0) return null;
    for (pid) |byte| {
        if (byte < '0' or byte > '9') return null;
    }
    if (!std.mem.eql(u8, object_path, "/ProgressDialog")) return null;

    return .{
        .service = service,
        .object_path = object_path,
    };
}

fn kdialogDbusArgv(
    dbus_command: []const u8,
    reference: KdialogProgressReference,
    method_args: []const []const u8,
    storage: *[8][]const u8,
) ?[]const []const u8 {
    if (method_args.len > storage.len - 3) return null;
    storage[0] = dbus_command;
    storage[1] = reference.service;
    storage[2] = reference.object_path;
    @memcpy(storage[3 .. 3 + method_args.len], method_args);
    return storage[0 .. 3 + method_args.len];
}

// Cross-platform progress adapter. The install pipeline reports the same phase
// and byte events on every platform; native frontends only translate them.
const ProgressIndicator = struct {
    child_process: ?std.process.Child,
    allocator: std.mem.Allocator,
    app_name: []const u8 = "",
    native_handle: ?*anyopaque = null,
    kdialog_progress: ?KdialogProgress = null,
    current: InstallProgress = .{ .phase = .preparing },
    last_emitted_phase: ?InstallPhase = null,
    last_emitted_percent: ?u32 = null,
    last_emitted_marquee: ?bool = null,
    completion_reported: bool = false,

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
        self.update(.preparing, null, null);

        return self;
    }

    fn startProgressDialog(self: *ProgressIndicator, metadata: AppMetadata) !void {
        if (builtin.os.tag == .windows) {
            const app_name_w = try std.unicode.wtf8ToWtf16LeAllocZ(self.allocator, metadata.name);
            defer self.allocator.free(app_name_w);
            self.native_handle = windows_installer_ui.electrobun_windows_installer_ui_start(app_name_w.ptr);
            if (self.native_handle == null) return error.NoProgressDialog;
            return;
        }

        if (builtin.os.tag == .macos) {
            const app_name_z = try self.allocator.dupeZ(u8, metadata.name);
            defer self.allocator.free(app_name_z);
            self.native_handle = macos_installer_ui.electrobun_macos_installer_ui_start(app_name_z.ptr);
            if (self.native_handle == null) return error.NoProgressDialog;
            return;
        }

        if (builtin.os.tag != .linux) return;

        const dialog_title = try std.fmt.allocPrint(self.allocator, "{s} Setup", .{metadata.name});
        defer self.allocator.free(dialog_title);
        const zenity_title = try std.fmt.allocPrint(self.allocator, "--title={s}", .{dialog_title});
        defer self.allocator.free(zenity_title);

        // Try zenity first (most common)
        const extract_text = try std.fmt.allocPrint(self.allocator, "--text=Extracting {s}...", .{metadata.name});
        defer self.allocator.free(extract_text);

        const zenity_args = [_][]const u8{
            "zenity",
            "--progress",
            "--no-cancel",
            "--percentage=0",
            zenity_title,
            extract_text,
            "--auto-close",
        };

        const child = std.process.spawn(g_io, .{
            .argv = &zenity_args,
            .stdin = .pipe,
            .stdout = .ignore,
            .stderr = .ignore,
        }) catch |err| {
            // KDialog returns a D-Bus service and object path. Unlike Zenity,
            // its progress dialog does not accept updates over stdin.
            if (err == error.FileNotFound) {
                const kdialog_text = try std.fmt.allocPrint(self.allocator, "Extracting {s}...", .{metadata.name});
                defer self.allocator.free(kdialog_text);

                const dbus_command = self.findKdialogDbusCommand() orelse return error.NoProgressDialog;

                const kdialog_args = [_][]const u8{
                    "kdialog", "--progressbar", kdialog_text, "100",
                    "--title", dialog_title,
                };

                const result = std.process.run(self.allocator, g_io, .{
                    .argv = &kdialog_args,
                    .stdout_limit = .limited(4096),
                    .stderr_limit = .limited(4096),
                }) catch return error.NoProgressDialog;
                defer self.allocator.free(result.stdout);
                defer self.allocator.free(result.stderr);
                if (!processExitedSuccessfully(result.term)) return error.NoProgressDialog;

                const reference = parseKdialogProgressReference(result.stdout) orelse
                    return error.NoProgressDialog;
                const service = try self.allocator.dupe(u8, reference.service);
                const object_path = self.allocator.dupe(u8, reference.object_path) catch |alloc_err| {
                    self.allocator.free(service);
                    return alloc_err;
                };

                self.kdialog_progress = .{
                    .dbus_command = dbus_command,
                    .service = service,
                    .object_path = object_path,
                };
                if (!self.runKdialogDbus(&.{ "org.kde.kdialog.ProgressDialog.showCancelButton", "false" })) {
                    self.closeKdialogProgress();
                    return error.NoProgressDialog;
                }

                return;
            }
            return err;
        };

        self.child_process = child;
    }

    fn findKdialogDbusCommand(self: *ProgressIndicator) ?[]const u8 {
        _ = self;
        const candidates = [_][]const u8{ "qdbus6", "qdbus", "qdbus-qt6", "qdbus-qt5" };
        for (candidates) |candidate| {
            const argv = [_][]const u8{candidate};
            var probe = std.process.spawn(g_io, .{
                .argv = &argv,
                .stdin = .ignore,
                .stdout = .ignore,
                .stderr = .ignore,
            }) catch continue;
            const term = probe.wait(g_io) catch continue;
            if (processExitedSuccessfully(term)) return candidate;
        }
        return null;
    }

    fn runKdialogDbus(self: *ProgressIndicator, method_args: []const []const u8) bool {
        const progress = self.kdialog_progress orelse return false;
        var argv_storage: [8][]const u8 = undefined;
        const argv = kdialogDbusArgv(
            progress.dbus_command,
            .{
                .service = progress.service,
                .object_path = progress.object_path,
            },
            method_args,
            &argv_storage,
        ) orelse return false;
        const result = std.process.run(self.allocator, g_io, .{
            .argv = argv,
            .stdout_limit = .limited(4096),
            .stderr_limit = .limited(4096),
        }) catch return false;
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        return processExitedSuccessfully(result.term);
    }

    fn releaseKdialogProgress(self: *ProgressIndicator) void {
        if (self.kdialog_progress) |progress| {
            self.allocator.free(progress.service);
            self.allocator.free(progress.object_path);
            self.kdialog_progress = null;
        }
    }

    fn closeKdialogProgress(self: *ProgressIndicator) void {
        if (self.kdialog_progress == null) return;
        _ = self.runKdialogDbus(&.{"org.kde.kdialog.ProgressDialog.close"});
        self.releaseKdialogProgress();
    }

    fn update(
        self: *ProgressIndicator,
        phase: InstallPhase,
        completed_bytes: ?u64,
        total_bytes: ?u64,
    ) void {
        const event = InstallProgress{
            .phase = phase,
            .completed_bytes = completed_bytes,
            .total_bytes = total_bytes,
        };
        self.current = event;

        const phase_changed = self.last_emitted_phase != phase;
        const percent = event.percent();
        const marquee = !event.isDeterminate() and phase != .completed;
        const percent_changed = percent != self.last_emitted_percent;
        const marquee_changed = self.last_emitted_marquee != marquee;
        if (!phase_changed and !percent_changed and !marquee_changed) return;

        if (builtin.os.tag == .windows) {
            if (self.native_handle) |ui| {
                if (phase_changed or marquee_changed) {
                    const phase_w = std.unicode.wtf8ToWtf16LeAllocZ(self.allocator, phase.text()) catch return;
                    defer self.allocator.free(phase_w);
                    windows_installer_ui.electrobun_windows_installer_ui_set_phase(
                        ui,
                        phase_w.ptr,
                        if (marquee) 1 else 0,
                    );
                }
                if (!marquee) if (percent) |value| {
                    windows_installer_ui.electrobun_windows_installer_ui_set_progress(ui, value);
                };
            }
        } else if (builtin.os.tag == .macos) {
            if (self.native_handle) |ui| {
                if (phase_changed or marquee_changed) {
                    const phase_z = self.allocator.dupeZ(u8, phase.text()) catch return;
                    defer self.allocator.free(phase_z);
                    macos_installer_ui.electrobun_macos_installer_ui_set_phase(
                        ui,
                        phase_z.ptr,
                        if (marquee) 1 else 0,
                    );
                }
                if (!marquee) if (percent) |value| {
                    macos_installer_ui.electrobun_macos_installer_ui_set_progress(ui, value);
                };
            }
        } else if (builtin.os.tag == .linux) {
            if (self.child_process) |*child| {
                if (child.stdin) |stdin| {
                    var buffer: [512]u8 = undefined;
                    var writer = stdin.writer(g_io, &buffer);
                    if (phase_changed) writer.interface.print("# {s}\n", .{phase.text()}) catch return;
                    if (!marquee) if (percent) |value| writer.interface.print("{d}\n", .{value}) catch return;
                    writer.interface.flush() catch return;
                }
            } else if (self.kdialog_progress != null) {
                var update_succeeded = true;
                if (phase_changed) {
                    update_succeeded = self.runKdialogDbus(&.{
                        "org.kde.kdialog.ProgressDialog.setLabelText",
                        phase.text(),
                    });
                }
                if (update_succeeded and !marquee) if (percent) |value| {
                    var percent_buffer: [4]u8 = undefined;
                    const percent_text = std.fmt.bufPrint(&percent_buffer, "{d}", .{value}) catch {
                        self.closeKdialogProgress();
                        return;
                    };
                    update_succeeded = self.runKdialogDbus(&.{
                        "org.freedesktop.DBus.Properties.Set",
                        "org.kde.kdialog.ProgressDialog",
                        "value",
                        percent_text,
                    });
                };
                if (!update_succeeded) {
                    self.closeKdialogProgress();
                    std.debug.print("KDialog progress updates failed; continuing with console progress.\n", .{});
                }
            }
        }

        if (phase_changed) std.debug.print("{s}\n", .{phase.text()});
        self.last_emitted_phase = phase;
        self.last_emitted_percent = percent;
        self.last_emitted_marquee = marquee;
    }

    fn complete(self: *ProgressIndicator, succeeded: bool, message: []const u8) void {
        if (self.completion_reported) return;
        self.completion_reported = true;
        if (!succeeded) g_installer_failure_presented = true;
        self.update(if (succeeded) .completed else .failed, if (succeeded) 1 else null, if (succeeded) 1 else null);
        if (builtin.os.tag == .linux and succeeded) self.closeKdialogProgress();

        if (builtin.os.tag == .windows) {
            if (self.native_handle) |ui| {
                const message_w = std.unicode.wtf8ToWtf16LeAllocZ(self.allocator, message) catch return;
                defer self.allocator.free(message_w);
                windows_installer_ui.electrobun_windows_installer_ui_complete(
                    ui,
                    if (succeeded) 1 else 0,
                    message_w.ptr,
                );
            }
        } else if (builtin.os.tag == .macos) {
            if (self.native_handle) |ui| {
                const message_z = self.allocator.dupeZ(u8, message) catch return;
                defer self.allocator.free(message_z);
                macos_installer_ui.electrobun_macos_installer_ui_complete(
                    ui,
                    if (succeeded) 1 else 0,
                    message_z.ptr,
                );
            }
        } else if (builtin.os.tag == .linux and !succeeded) {
            // End the progress process before presenting a terminal error.
            self.closeKdialogProgress();
            if (self.child_process) |*child| {
                if (child.stdin) |stdin| {
                    stdin.close(g_io);
                    child.stdin = null;
                }
                child.kill(g_io);
                self.child_process = null;
            }
            const owned_dialog_title = std.fmt.allocPrint(
                self.allocator,
                "{s} Setup",
                .{self.app_name},
            ) catch null;
            defer if (owned_dialog_title) |title| self.allocator.free(title);
            const dialog_title: []const u8 = owned_dialog_title orelse "Installer";
            const owned_zenity_title = std.fmt.allocPrint(
                self.allocator,
                "--title={s}",
                .{dialog_title},
            ) catch null;
            defer if (owned_zenity_title) |title| self.allocator.free(title);
            const zenity_title: []const u8 = owned_zenity_title orelse "--title=Installer";
            const zenity_args = [_][]const u8{
                "zenity",
                "--error",
                zenity_title,
                "--text",
                message,
            };
            var dialog = std.process.spawn(g_io, .{
                .argv = &zenity_args,
                .stdin = .ignore,
                .stdout = .ignore,
                .stderr = .ignore,
            }) catch {
                const kdialog_args = [_][]const u8{
                    "kdialog",
                    "--error",
                    message,
                    "--title",
                    dialog_title,
                };
                var fallback = std.process.spawn(g_io, .{
                    .argv = &kdialog_args,
                    .stdin = .ignore,
                    .stdout = .ignore,
                    .stderr = .ignore,
                }) catch {
                    std.debug.print("Installation failed: {s}\n", .{message});
                    return;
                };
                _ = fallback.wait(g_io) catch {};
                return;
            };
            _ = dialog.wait(g_io) catch {};
        }
    }

    fn deinit(self: *ProgressIndicator) void {
        if (builtin.os.tag == .windows) {
            if (self.native_handle) |ui| {
                windows_installer_ui.electrobun_windows_installer_ui_close(ui);
                self.native_handle = null;
            }
        } else if (builtin.os.tag == .macos) {
            if (self.native_handle) |ui| {
                macos_installer_ui.electrobun_macos_installer_ui_close(ui);
                self.native_handle = null;
            }
        }
        self.closeKdialogProgress();
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

fn installErrorMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.InstallationAlreadyInProgress => "Another installation is already in progress. Close it before trying again.",
        error.AccessDenied, error.FileBusy, error.PermissionDenied => "The application is still running or its files are locked. Close it and try again.",
        else => "The application could not be installed.",
    };
}

fn presentGenericInstallerFailure(allocator: std.mem.Allocator, message: []const u8) void {
    if (g_installer_failure_presented) return;
    const metadata = AppMetadata{
        .identifier = "sh.blackboard.electrobun-installer-error",
        .name = "Application",
        .channel = "error",
    };
    var progress = ProgressIndicator.init(allocator, metadata);
    defer progress.deinit();
    progress.complete(false, message);
}

fn previewPause() void {
    g_io.sleep(.fromMilliseconds(80), .awake) catch {};
}

fn runInstallerUiPreview(allocator: std.mem.Allocator, mode: []const u8) !void {
    if (!std.mem.eql(u8, mode, "all") and !std.mem.eql(u8, mode, "error")) {
        return error.InvalidInstallerUiPreview;
    }
    const metadata = AppMetadata{
        .identifier = "sh.blackboard.electrobun-installer-preview",
        .name = "Example App",
        .channel = "preview",
    };
    var progress = ProgressIndicator.init(allocator, metadata);
    defer progress.deinit();

    progress.update(.preparing, null, null);
    previewPause();
    for (0..11) |step| {
        progress.update(.decompressing, @intCast(step * 10), 100);
        previewPause();
    }
    for (0..11) |step| {
        progress.update(.extracting, @intCast(step * 10), 100);
        previewPause();
    }
    progress.update(.installing_files, null, null);
    previewPause();
    progress.update(.integrating, null, null);
    previewPause();

    if (std.mem.eql(u8, mode, "error")) {
        progress.complete(false, "Preview of an installation failure. No files were changed.");
        return;
    }

    progress.complete(true, "Preview completed. No application was installed.");
    const preview_name = "Example App";
    switch (builtin.os.tag) {
        .windows => {
            const name_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, preview_name);
            defer allocator.free(name_w);
            _ = windows_uninstall_ui.electrobun_preview_windows_uninstall_prompt(name_w.ptr);
        },
        .macos => {
            const name_z = try allocator.dupeZ(u8, preview_name);
            defer allocator.free(name_z);
            _ = macos_uninstall_ui.electrobun_preview_macos_uninstall_prompt(name_z.ptr);
        },
        .linux => {
            _ = try linux_uninstall_prompt.showPreview(allocator, g_io, g_environ_map, preview_name);
        },
        else => {},
    }
}

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
        (!isSafeWindowsComponent(metadata.identifier) or !isBuildChannel(metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }
    if (builtin.os.tag == .linux and
        (!isSafeLinuxComponent(metadata.identifier) or !isBuildChannel(metadata.channel)))
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

    // Metadata established that this is an adjacent installer. From this
    // point, missing or unreadable payloads are visible install failures rather
    // than a silent fallback to legacy embedded discovery.
    var progress = ProgressIndicator.init(allocator, metadata);
    defer progress.deinit();
    errdefer progress.complete(false, "The application could not be installed.");

    std.Io.Dir.cwd().access(g_io, archive_path, .{}) catch |err| switch (err) {
        error.FileNotFound => return error.MissingInstallerArchive,
        else => return err,
    };

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

    const installed = install: {
        if (builtin.os.tag == .windows) {
            var install_lock = try acquireWindowsInstallLock(allocator, app_base_dir);
            defer install_lock.release();
            break :install extractAndInstall(
                allocator,
                .{ .file = archive_path },
                metadata,
                self_extraction_dir,
                app_dir,
                &progress,
            );
        }

        break :install extractAndInstall(
            allocator,
            .{ .file = archive_path },
            metadata,
            self_extraction_dir,
            app_dir,
            &progress,
        );
    } catch |err| {
        progress.complete(false, installErrorMessage(err));
        return err;
    };
    progress.complete(true, "The application was installed successfully.");
    return installed;
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

    // Fall back to embedded archive approach (for Linux or if adjacent files not found on Windows).
    // Marker literals can occur more than once in a Zig executable depending on
    // target and optimization mode, so select a pair by its bounded metadata shape.
    const search_buffer = try std.Io.Dir.cwd().readFileAlloc(g_io, exe_path, allocator, .unlimited);
    defer allocator.free(search_buffer);

    const embedded = (try findEmbeddedMetadata(allocator, search_buffer)) orelse {
        std.debug.print("DEBUG: No metadata marker found at all\n", .{});
        return false;
    };
    const archive_offset = embedded.archive_offset;

    // Read metadata
    const metadata = try readEmbeddedMetadata(allocator, embedded.metadata);

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
        (!isSafeWindowsComponent(safe_metadata.identifier) or !isBuildChannel(safe_metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }
    if (builtin.os.tag == .linux and
        (!isSafeLinuxComponent(safe_metadata.identifier) or !isBuildChannel(safe_metadata.channel)))
    {
        return error.InvalidInstallIdentity;
    }

    var progress = ProgressIndicator.init(allocator, safe_metadata);
    defer progress.deinit();

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
    const installed = install: {
        if (builtin.os.tag == .windows) {
            var install_lock = try acquireWindowsInstallLock(allocator, app_base_dir);
            defer install_lock.release();
            break :install extractAndInstall(
                allocator,
                .{ .memory = compressed_data },
                safe_metadata,
                self_extraction_dir,
                app_dir,
                &progress,
            );
        }
        break :install extractAndInstall(
            allocator,
            .{ .memory = compressed_data },
            safe_metadata,
            self_extraction_dir,
            app_dir,
            &progress,
        );
    } catch |err| {
        progress.complete(false, installErrorMessage(err));
        return err;
    };
    progress.complete(true, "The application was installed successfully.");
    return installed;
}

const EmbeddedMetadataSlice = struct {
    metadata: []const u8,
    archive_offset: usize,
};

fn findEmbeddedMetadata(allocator: std.mem.Allocator, contents: []const u8) !?EmbeddedMetadataSlice {
    var search_end = contents.len;
    while (std.mem.lastIndexOf(u8, contents[0..search_end], METADATA_MARKER)) |marker_offset| {
        const metadata_start = marker_offset + METADATA_MARKER.len;
        const bounded_end = @min(contents.len, metadata_start + 4096 + ARCHIVE_MARKER.len);
        var archive_search_start = metadata_start;
        while (std.mem.indexOf(u8, contents[archive_search_start..bounded_end], ARCHIVE_MARKER)) |relative| {
            const archive_offset = archive_search_start + relative;
            const metadata = contents[metadata_start..archive_offset];
            const valid = valid: {
                const document = std.json.parseFromSlice(EmbeddedMetadataJson, allocator, metadata, .{}) catch |err| switch (err) {
                    error.OutOfMemory => return err,
                    else => break :valid false,
                };
                defer document.deinit();
                break :valid isBuildChannel(document.value.channel);
            };
            if (valid) {
                return .{ .metadata = metadata, .archive_offset = archive_offset };
            }
            archive_search_start = archive_offset + ARCHIVE_MARKER.len;
        }
        search_end = marker_offset;
    }
    return null;
}

const InstallArchiveSource = union(enum) {
    memory: []const u8,
    file: []const u8,
};

fn extractAndInstall(
    allocator: std.mem.Allocator,
    archive_source: InstallArchiveSource,
    metadata: AppMetadata,
    self_extraction_dir: []const u8,
    app_dir: []const u8,
    progress: *ProgressIndicator,
) !bool {
    errdefer progress.update(.failed, null, null);

    // Get exe path for shortcuts
    const exe_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(exe_path);

    var decompressed_data: ?[]u8 = null;
    defer if (decompressed_data) |data| allocator.free(data);
    var staged_extraction_dir: ?[]u8 = null;
    defer if (staged_extraction_dir) |path| allocator.free(path);
    var staging_published = false;
    defer if (!staging_published) if (staged_extraction_dir) |path| {
        std.Io.Dir.cwd().deleteTree(g_io, path) catch {};
    };
    var working_extraction_dir = self_extraction_dir;

    switch (archive_source) {
        .memory => |compressed_data| {
            // Embedded legacy installers retain their existing in-memory path.
            // Shipped adjacent installers use the bounded file path below.
            const window_buffer = try allocator.alloc(u8, zstd.default_window_len + zstd.block_size_max);
            defer allocator.free(window_buffer);
            var input_reader: std.Io.Reader = .fixed(compressed_data);
            var decompress: zstd.Decompress = .init(&input_reader, window_buffer, .{ .verify_checksum = false });
            progress.update(.decompressing, 0, @intCast(compressed_data.len));
            decompressed_data = try decompress.reader.allocRemaining(allocator, .unlimited);
            progress.update(.decompressing, @intCast(compressed_data.len), @intCast(compressed_data.len));
            try extractTarWithProgress(decompressed_data.?, self_extraction_dir, progress);
        },
        .file => |archive_path| {
            const staging_dir = try std.fmt.allocPrint(allocator, "{s}.partial", .{self_extraction_dir});
            staged_extraction_dir = staging_dir;
            try resetExtractionDirectory(staging_dir);

            const tar_path = try retainedTarPath(allocator, staging_dir, metadata.hash);
            defer allocator.free(tar_path);
            try streamZstdToTar(allocator, archive_path, tar_path, progress);
            try extractTarFile(tar_path, staging_dir, progress);
            working_extraction_dir = staging_dir;
        },
    }
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

    const extracted_app_path = try std.fs.path.join(allocator, &.{ working_extraction_dir, app_bundle_name });
    defer allocator.free(extracted_app_path);
    std.debug.print("DEBUG: extracted_app_path = '{s}'\n", .{extracted_app_path});

    // Move the extracted app to the app directory
    std.debug.print("\nDEBUG: Preparing to move app...\n", .{});
    std.debug.print("DEBUG: Source (extracted_app_path) = '{s}'\n", .{extracted_app_path});
    std.debug.print("DEBUG: Destination (app_dir) = '{s}'\n", .{app_dir});

    // Check if source exists
    std.Io.Dir.cwd().access(g_io, extracted_app_path, .{}) catch |err| {
        std.debug.print("ERROR: Source directory does not exist: '{s}' - {}\n", .{ extracted_app_path, err });
        // List what's actually in the extraction directory
        std.debug.print("DEBUG: Listing contents of extraction directory '{s}':\n", .{working_extraction_dir});
        var iter_dir = try std.Io.Dir.cwd().openDir(g_io, working_extraction_dir, .{ .iterate = true });
        defer iter_dir.close(g_io);
        var iterator = iter_dir.iterate();
        while (try iterator.next(g_io)) |entry| {
            std.debug.print("  - {s} ({s})\n", .{ entry.name, @tagName(entry.kind) });
        }
        return err;
    };
    std.debug.print("DEBUG: Source directory exists\n", .{});

    // Keep the previous application available until its matching updater state
    // has also been published. This bounds rollback storage to one app version
    // and avoids leaving a newly copied app paired with the old retained tar
    // when publication fails.
    const previous_app_dir = try std.fmt.allocPrint(allocator, "{s}.previous", .{app_dir});
    defer allocator.free(previous_app_dir);

    var current_app_exists = try extractionPathExists(app_dir);
    if (!current_app_exists and try extractionPathExists(previous_app_dir)) {
        try std.Io.Dir.cwd().rename(previous_app_dir, std.Io.Dir.cwd(), app_dir, g_io);
        current_app_exists = true;
    }
    if (try extractionPathExists(previous_app_dir)) {
        try std.Io.Dir.cwd().deleteTree(g_io, previous_app_dir);
    }

    const had_previous_app = current_app_exists;
    if (had_previous_app) {
        try std.Io.Dir.cwd().rename(app_dir, std.Io.Dir.cwd(), previous_app_dir, g_io);
    }

    var app_rollback_armed = true;
    var app_install_committed = false;
    defer if (app_rollback_armed and !app_install_committed) {
        std.Io.Dir.cwd().deleteTree(g_io, app_dir) catch |err| {
            std.debug.print("WARNING: Failed to remove incomplete application during rollback: {}\n", .{err});
        };
        if (had_previous_app) {
            std.Io.Dir.cwd().rename(previous_app_dir, std.Io.Dir.cwd(), app_dir, g_io) catch |err| {
                std.debug.print("ERROR: Failed to restore previous application during rollback: {}\n", .{err});
            };
        }
    };

    progress.update(.installing_files, null, null);

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
        try std.Io.Dir.cwd().deleteTree(g_io, extracted_app_path);
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
    if ((builtin.os.tag == .linux or builtin.os.tag == .windows) and archive_source == .memory) {
        std.debug.print("\n✓ Saving tar file for Updater API...\n", .{});
        // Make a defensive copy of the hash to prevent memory corruption
        const safe_hash = if (archive_source == .memory and metadata.hash != null)
            try allocator.dupe(u8, metadata.hash.?)
        else
            null;
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
        if (archive_source == .memory) {
            const tar_file = try std.Io.Dir.cwd().createFile(g_io, tar_path, .{});
            defer tar_file.close(g_io);
            try tar_file.writeStreamingAll(g_io, decompressed_data.?);
        }
        if (decompressed_data) |data| std.debug.print("✓ Saved tar file ({} bytes)\n", .{data.len});

        // List files to confirm they're saved
        std.debug.print("\nDEBUG: Final files in self-extraction dir:\n", .{});
        var dir = try std.Io.Dir.cwd().openDir(g_io, self_extraction_dir, .{ .iterate = true });
        defer dir.close(g_io);
        var iter = dir.iterate();
        while (try iter.next(g_io)) |entry| {
            std.debug.print("  - {s} ({s})\n", .{ entry.name, @tagName(entry.kind) });
        }
    }

    // Publish the already-complete adjacent updater state before committing the
    // app replacement. A publication failure therefore rolls the app back to
    // the version matching the retained updater tar.
    if (archive_source == .file) {
        try publishExtractionState(allocator, staged_extraction_dir.?, self_extraction_dir);
        staging_published = true;
    }

    app_install_committed = true;
    app_rollback_armed = false;
    if (had_previous_app) {
        std.Io.Dir.cwd().deleteTree(g_io, previous_app_dir) catch |err| {
            std.debug.print("WARNING: Failed to remove previous application after commit: {}\n", .{err});
        };
    }

    // Platform integration runs only after the app and updater state are a
    // coherent committed pair. If integration fails, the installed files stay
    // coherent and a later installer run can safely retry integration.
    progress.update(.integrating, null, null);
    if (builtin.os.tag == .linux) {
        try installLinuxIntegration(allocator, app_dir, metadata, .preserve);
    } else if (builtin.os.tag == .windows) {
        try installWindowsIntegration(allocator, app_dir, metadata);
    }

    std.debug.print(" Done!\n", .{});
    std.debug.print("Installation completed successfully!\n", .{});
    return true;
}

fn retainedTarPath(
    allocator: std.mem.Allocator,
    extraction_dir: []const u8,
    hash: ?[]const u8,
) ![]u8 {
    if (hash) |value| {
        if (value.len == 0) return error.InvalidArchiveHash;
        for (value) |byte| {
            if (!std.ascii.isAlphanumeric(byte) and byte != '-' and byte != '_') {
                return error.InvalidArchiveHash;
            }
        }
    }
    const file_name = if (hash) |value|
        try std.fmt.allocPrint(allocator, "{s}.tar", .{value})
    else
        try allocator.dupe(u8, "current.tar");
    defer allocator.free(file_name);
    return std.fs.path.join(allocator, &.{ extraction_dir, file_name });
}

fn resetExtractionDirectory(extract_dir: []const u8) !void {
    std.Io.Dir.cwd().deleteTree(g_io, extract_dir) catch |err| switch (err) {
        error.NotDir => try std.Io.Dir.cwd().deleteFile(g_io, extract_dir),
        else => return err,
    };
    try std.Io.Dir.cwd().createDirPath(g_io, extract_dir);
}

fn streamZstdToTar(
    allocator: std.mem.Allocator,
    compressed_path: []const u8,
    tar_path: []const u8,
    progress: *ProgressIndicator,
) !void {
    const partial_path = try std.fmt.allocPrint(allocator, "{s}.partial", .{tar_path});
    defer allocator.free(partial_path);
    std.Io.Dir.cwd().deleteFile(g_io, partial_path) catch {};
    errdefer std.Io.Dir.cwd().deleteFile(g_io, partial_path) catch {};

    const source_file = try std.Io.Dir.cwd().openFile(g_io, compressed_path, .{});
    defer source_file.close(g_io);
    var source_buffer: [64 * 1024]u8 = undefined;
    var source_reader = source_file.reader(g_io, &source_buffer);
    const compressed_size = try source_reader.getSize();

    const window_buffer = try allocator.alloc(u8, zstd.default_window_len + zstd.block_size_max);
    defer allocator.free(window_buffer);
    var decompress: zstd.Decompress = .init(&source_reader.interface, window_buffer, .{ .verify_checksum = false });
    progress.update(.decompressing, 0, compressed_size);

    {
        const partial_file = try std.Io.Dir.cwd().createFile(g_io, partial_path, .{ .truncate = true });
        defer partial_file.close(g_io);
        var writer_buffer: [64 * 1024]u8 = undefined;
        var writer = partial_file.writer(g_io, &writer_buffer);
        var output_buffer: [64 * 1024]u8 = undefined;
        while (true) {
            const count = try decompress.reader.readSliceShort(&output_buffer);
            if (count == 0) break;
            try writer.interface.writeAll(output_buffer[0..count]);
            progress.update(.decompressing, source_reader.logicalPos(), compressed_size);
        }
        try writer.interface.flush();
        try partial_file.sync(g_io);
    }

    try std.Io.Dir.cwd().rename(partial_path, std.Io.Dir.cwd(), tar_path, g_io);
    progress.update(.decompressing, compressed_size, compressed_size);
}

fn extractTarFileOptionalProgress(
    tar_path: []const u8,
    extract_dir: []const u8,
    progress: ?*ProgressIndicator,
) !void {
    const tar_file = try std.Io.Dir.cwd().openFile(g_io, tar_path, .{});
    defer tar_file.close(g_io);
    var reader_buffer: [64 * 1024]u8 = undefined;
    var reader = tar_file.reader(g_io, &reader_buffer);
    const tar_size = try reader.getSize();
    if (progress) |reporter| reporter.update(.extracting, 0, tar_size);
    var extraction_dir = try std.Io.Dir.cwd().openDir(g_io, extract_dir, .{});
    defer extraction_dir.close(g_io);
    try pipeToFileSystemWithProgress(g_io, extraction_dir, &reader.interface, progress, tar_size);
    if (progress) |reporter| reporter.update(.extracting, tar_size, tar_size);
}

fn extractTarFile(tar_path: []const u8, extract_dir: []const u8, progress: *ProgressIndicator) !void {
    return extractTarFileOptionalProgress(tar_path, extract_dir, progress);
}

fn extractTarFileQuiet(tar_path: []const u8, extract_dir: []const u8) !void {
    return extractTarFileOptionalProgress(tar_path, extract_dir, null);
}

fn extractionPathExists(path: []const u8) !bool {
    std.Io.Dir.cwd().access(g_io, path, .{}) catch |err| switch (err) {
        error.FileNotFound => return false,
        else => return err,
    };
    return true;
}

fn publishExtractionState(
    allocator: std.mem.Allocator,
    staged_dir: []const u8,
    final_dir: []const u8,
) !void {
    const previous_dir = try std.fmt.allocPrint(allocator, "{s}.previous", .{final_dir});
    defer allocator.free(previous_dir);

    if (!try extractionPathExists(final_dir) and try extractionPathExists(previous_dir)) {
        try std.Io.Dir.cwd().rename(previous_dir, std.Io.Dir.cwd(), final_dir, g_io);
    }
    if (try extractionPathExists(previous_dir)) try std.Io.Dir.cwd().deleteTree(g_io, previous_dir);

    const had_previous = try extractionPathExists(final_dir);
    if (had_previous) try std.Io.Dir.cwd().rename(final_dir, std.Io.Dir.cwd(), previous_dir, g_io);
    errdefer if (had_previous) {
        std.Io.Dir.cwd().rename(previous_dir, std.Io.Dir.cwd(), final_dir, g_io) catch {};
    };
    try std.Io.Dir.cwd().rename(staged_dir, std.Io.Dir.cwd(), final_dir, g_io);
    if (had_previous) std.Io.Dir.cwd().deleteTree(g_io, previous_dir) catch {};
}

fn extractTarWithProgress(tar_data: []const u8, extract_dir: []const u8, progress: *ProgressIndicator) !void {
    try resetExtractionDirectory(extract_dir);
    progress.update(.extracting, 0, @intCast(tar_data.len));
    var dir = try std.Io.Dir.cwd().openDir(g_io, extract_dir, .{});
    defer dir.close(g_io);
    var reader: std.Io.Reader = .fixed(tar_data);
    try pipeToFileSystemWithProgress(g_io, dir, &reader, progress, @intCast(tar_data.len));
    progress.update(.extracting, @intCast(tar_data.len), @intCast(tar_data.len));
}

fn extractTar(allocator: std.mem.Allocator, tar_data: []const u8, extract_dir: []const u8) !void {
    _ = allocator;

    std.debug.print("DEBUG: Starting tar extraction to: {s}\n", .{extract_dir});
    std.debug.print("DEBUG: Tar data size: {} bytes\n", .{tar_data.len});

    try resetExtractionDirectory(extract_dir);

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
    const parsed = try std.json.parseFromSlice(EmbeddedMetadataJson, allocator, metadata_bytes, .{});
    defer parsed.deinit();
    if (!isBuildChannel(parsed.value.channel)) return error.InvalidInstallIdentity;

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
    collision_policy: LinuxDesktopCollisionPolicy,
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
    var desktop_shortcut_managed = false;
    var applications_entry_managed = false;
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
                            if (collision_policy == .adopt_matching_legacy) {
                                const matches_legacy_entry = matchingLegacyLinuxDesktopEntry(
                                    allocator,
                                    desktop_file_path,
                                    desktop_dir,
                                    &entry_hash,
                                    launcher_path,
                                ) catch |inspect_err| blk: {
                                    std.debug.print("Warning: Could not inspect legacy Desktop entry: {}\n", .{inspect_err});
                                    break :blk false;
                                };
                                if (matches_legacy_entry) {
                                    integration.desktop_entry = try allocator.dupe(u8, desktop_file_path);
                                    integration.desktop_entry_sha256 = try allocator.dupe(u8, &entry_hash);
                                    desktop_shortcut_managed = true;
                                    std.debug.print("Adopted matching legacy Desktop entry: {s}\n", .{desktop_file_path});
                                    break :desktop_shortcut;
                                }
                            }
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
                    desktop_shortcut_managed = true;
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
                        if (collision_policy == .adopt_matching_legacy) {
                            const matches_legacy_entry = matchingLegacyLinuxDesktopEntry(
                                allocator,
                                applications_file_path,
                                applications_dir,
                                &entry_hash,
                                launcher_path,
                            ) catch |inspect_err| blk: {
                                std.debug.print("Warning: Could not inspect legacy application entry: {}\n", .{inspect_err});
                                break :blk false;
                            };
                            if (matches_legacy_entry) {
                                integration.application_entry = try allocator.dupe(u8, applications_file_path);
                                integration.application_entry_sha256 = try allocator.dupe(u8, &entry_hash);
                                applications_entry_managed = true;
                                std.debug.print("Adopted matching legacy application entry: {s}\n", .{applications_file_path});
                                break :write_applications_dir;
                            }
                        }
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

                applications_entry_managed = true;
                integration.application_entry = try allocator.dupe(u8, applications_file_path);
                integration.application_entry_sha256 = try allocator.dupe(u8, &entry_hash);
                std.debug.print("Copied desktop shortcut to applications dir: {s}\n", .{applications_file_path});
            }

            found_desktop_file = true;
            if (desktop_shortcut_created) {
                std.debug.print("Copied desktop shortcut to: {s}\n", .{desktop_file_path});
            }
            if (!desktop_shortcut_managed and !applications_entry_managed) {
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

fn getWindowsSystemExecutablePath(
    allocator: std.mem.Allocator,
    executable_name: []const u8,
) ![]u8 {
    if (builtin.os.tag != .windows) unreachable;
    const system_directory = try std.unicode.wtf16LeToWtf8Alloc(
        allocator,
        std.os.windows.getSystemDirectoryWtf16Le(),
    );
    defer allocator.free(system_directory);
    return std.fs.path.join(allocator, &.{ system_directory, executable_name });
}

fn getWindowsPowerShellPath(allocator: std.mem.Allocator) ![]u8 {
    const system_directory = try std.unicode.wtf16LeToWtf8Alloc(
        allocator,
        std.os.windows.getSystemDirectoryWtf16Le(),
    );
    defer allocator.free(system_directory);
    return std.fs.path.join(allocator, &.{
        system_directory,
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    });
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
    if (isStableChannel(channel)) return allocator.dupe(u8, app_name);
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
    if (sanitized.items.len == 0) try sanitized.appendSlice(allocator, "Application");
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
    const powershell_path = try getWindowsPowerShellPath(allocator);
    defer allocator.free(powershell_path);
    const argv = [_][]const u8{
        powershell_path,
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
    const powershell_path = try getWindowsPowerShellPath(allocator);
    defer allocator.free(powershell_path);

    const ps_args = [_][]const u8{
        powershell_path,
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
    const powershell_path = try getWindowsPowerShellPath(allocator);
    defer allocator.free(powershell_path);

    const argv = [_][]const u8{
        powershell_path,
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        command,
    };
    try runWindowsCommandChecked(&argv);
}

fn preflightWindowsShortcutForCleanup(
    allocator: std.mem.Allocator,
    shortcut_path: []const u8,
) !void {
    const escaped_shortcut = try powershellSingleQuoted(allocator, shortcut_path);
    defer allocator.free(escaped_shortcut);
    const command = try std.fmt.allocPrint(allocator,
        \\$ErrorActionPreference = 'Stop'
        \\if (-not (Test-Path -LiteralPath '{s}')) {{ exit 0 }}
        \\$Item = Get-Item -LiteralPath '{s}' -Force
        \\if ($Item.PSIsContainer -or (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {{ exit 2 }}
        \\try {{
        \\    $WshShell = New-Object -ComObject WScript.Shell
        \\    [void]$WshShell.CreateShortcut('{s}').TargetPath
        \\}} catch {{
        \\    # An edited/non-shortcut file is not Electrobun-owned. Preserve it.
        \\}}
        \\
    , .{ escaped_shortcut, escaped_shortcut, escaped_shortcut });
    defer allocator.free(command);
    const powershell_path = try getWindowsPowerShellPath(allocator);
    defer allocator.free(powershell_path);
    const argv = [_][]const u8{
        powershell_path,
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
        !installedChannelMatches(parsed.value.channel, channel))
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
    const legacy_name = try windowsShortcutFileName(allocator, app_name, "stable");
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
        !installedChannelMatches(parsed.value.channel, manifest.channel))
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
    return getWindowsSystemExecutablePath(allocator, "reg.exe");
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

fn isSafeWindowsDisplayName(value: []const u8) bool {
    if (value.len == 0 or value.len > 240) return false;
    for (value) |byte| switch (byte) {
        0...31, 127 => return false,
        else => {},
    };
    return true;
}

fn validateWindowsDataPathVersions(versions: ?[]const u32) !void {
    // The original Windows manifest predates this field. Those manifests used
    // the same LOCALAPPDATA-based layout that policy version 1 describes.
    const selected = versions orelse return;
    if (selected.len != 1 or selected[0] != WINDOWS_DATA_PATH_VERSION) {
        return error.InvalidUninstallManifest;
    }
}

const WindowsManagedPaths = struct {
    local_appdata: []u8,
    identifier_dir: []u8,
    channel_root: []u8,
    app_dir: []u8,
    self_extraction_dir: []u8,
    update_script: []u8,
    uninstaller: []u8,
    manifest: []u8,
    bundled_uninstaller: []u8,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.local_appdata);
        allocator.free(self.identifier_dir);
        allocator.free(self.channel_root);
        allocator.free(self.app_dir);
        allocator.free(self.self_extraction_dir);
        allocator.free(self.update_script);
        allocator.free(self.uninstaller);
        allocator.free(self.manifest);
        allocator.free(self.bundled_uninstaller);
        self.* = undefined;
    }
};

fn requirePlainWindowsDirectoryPhysical(
    allocator: std.mem.Allocator,
    path: []const u8,
    expected_physical_path: ?[]const u8,
) ![:0]u8 {
    const stat = try std.Io.Dir.cwd().statFile(g_io, path, .{ .follow_symlinks = false });
    if (stat.kind != .directory) return error.InvalidUninstallLocation;
    const physical = try std.Io.Dir.realPathFileAbsoluteAlloc(g_io, path, allocator);
    errdefer allocator.free(physical);
    if (expected_physical_path) |expected| {
        if (!try windowsPathsEqual(allocator, physical, expected)) {
            return error.InvalidUninstallLocation;
        }
    }
    return physical;
}

fn windowsManagedPathsFromBaseDir(
    allocator: std.mem.Allocator,
    base_dir: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !WindowsManagedPaths {
    if (!std.fs.path.isAbsolute(base_dir) or
        !isSafeWindowsComponent(identifier) or
        !isSafeWindowsComponent(channel)) return error.InvalidUninstallLocation;

    const local_appdata_raw = try getAppDataDir(allocator);
    defer allocator.free(local_appdata_raw);
    const local_appdata = try std.fs.path.resolve(allocator, &.{local_appdata_raw});
    errdefer allocator.free(local_appdata);
    if (!std.fs.path.isAbsolute(local_appdata) or
        std.mem.eql(u8, local_appdata, std.fs.path.sep_str)) return error.InvalidUninstallLocation;

    const identifier_dir = try std.fs.path.join(allocator, &.{ local_appdata, identifier });
    errdefer allocator.free(identifier_dir);
    const channel_root = try std.fs.path.resolve(allocator, &.{base_dir});
    errdefer allocator.free(channel_root);
    const root_parent = std.fs.path.dirname(channel_root) orelse return error.InvalidUninstallLocation;
    const root_name = std.fs.path.basename(channel_root);
    if (!try windowsPathsEqual(allocator, base_dir, channel_root) or
        !try windowsPathsEqual(allocator, root_parent, identifier_dir) or
        !isSafeWindowsComponent(root_name))
    {
        return error.InvalidUninstallLocation;
    }

    // Validate each existing ancestor without following its final reparse
    // point, then bind the next child to that ancestor's physical path. A
    // junction anywhere in LOCALAPPDATA/<identifier>/<channel> is therefore
    // rejected before any recursive cleanup is attempted.
    const local_physical = try requirePlainWindowsDirectoryPhysical(allocator, local_appdata, null);
    defer allocator.free(local_physical);
    const expected_identifier_physical = try std.fs.path.join(allocator, &.{ local_physical, identifier });
    defer allocator.free(expected_identifier_physical);
    const identifier_physical = try requirePlainWindowsDirectoryPhysical(
        allocator,
        identifier_dir,
        expected_identifier_physical,
    );
    defer allocator.free(identifier_physical);
    const expected_channel_physical = try std.fs.path.join(allocator, &.{ identifier_physical, root_name });
    defer allocator.free(expected_channel_physical);
    const channel_physical = try requirePlainWindowsDirectoryPhysical(
        allocator,
        channel_root,
        expected_channel_physical,
    );
    allocator.free(channel_physical);

    const app_dir = try std.fs.path.join(allocator, &.{ channel_root, "app" });
    errdefer allocator.free(app_dir);
    const self_extraction_dir = try std.fs.path.join(allocator, &.{ channel_root, "self-extraction" });
    errdefer allocator.free(self_extraction_dir);
    const update_script = try std.fs.path.join(allocator, &.{ channel_root, "update.bat" });
    errdefer allocator.free(update_script);
    const uninstaller = try std.fs.path.join(allocator, &.{ channel_root, WINDOWS_UNINSTALL_EXE_NAME });
    errdefer allocator.free(uninstaller);
    const manifest = try std.fs.path.join(allocator, &.{ channel_root, WINDOWS_UNINSTALL_MANIFEST_NAME });
    errdefer allocator.free(manifest);
    const bundled_uninstaller = try std.fs.path.join(
        allocator,
        &.{ app_dir, "Resources", WINDOWS_BUNDLED_UNINSTALL_EXE_NAME },
    );
    errdefer allocator.free(bundled_uninstaller);
    return .{
        .local_appdata = local_appdata,
        .identifier_dir = identifier_dir,
        .channel_root = channel_root,
        .app_dir = app_dir,
        .self_extraction_dir = self_extraction_dir,
        .update_script = update_script,
        .uninstaller = uninstaller,
        .manifest = manifest,
        .bundled_uninstaller = bundled_uninstaller,
    };
}

fn requirePlainWindowsFile(path: []const u8, invalid_error: anyerror) !void {
    const stat = std.Io.Dir.cwd().statFile(g_io, path, .{ .follow_symlinks = false }) catch return invalid_error;
    if (stat.kind != .file) return invalid_error;
}

fn requirePlainWindowsBundledManager(
    allocator: std.mem.Allocator,
    paths: WindowsManagedPaths,
) !void {
    const channel_physical = try std.Io.Dir.realPathFileAbsoluteAlloc(g_io, paths.channel_root, allocator);
    defer allocator.free(channel_physical);
    const expected_app_physical = try std.fs.path.join(allocator, &.{ channel_physical, "app" });
    defer allocator.free(expected_app_physical);
    const app_physical = try requirePlainWindowsDirectoryPhysical(
        allocator,
        paths.app_dir,
        expected_app_physical,
    );
    defer allocator.free(app_physical);
    const resources_path = try std.fs.path.join(allocator, &.{ paths.app_dir, "Resources" });
    defer allocator.free(resources_path);
    const expected_resources_physical = try std.fs.path.join(allocator, &.{ app_physical, "Resources" });
    defer allocator.free(expected_resources_physical);
    const resources_physical = try requirePlainWindowsDirectoryPhysical(
        allocator,
        resources_path,
        expected_resources_physical,
    );
    defer allocator.free(resources_physical);
    try requirePlainWindowsFile(paths.bundled_uninstaller, error.InvalidUninstallManager);
    const manager_physical = try std.Io.Dir.realPathFileAbsoluteAlloc(
        g_io,
        paths.bundled_uninstaller,
        allocator,
    );
    defer allocator.free(manager_physical);
    const expected_manager_physical = try std.fs.path.join(
        allocator,
        &.{ resources_physical, WINDOWS_BUNDLED_UNINSTALL_EXE_NAME },
    );
    defer allocator.free(expected_manager_physical);
    if (!try windowsPathsEqual(allocator, manager_physical, expected_manager_physical)) {
        return error.InvalidUninstallManager;
    }
}

fn openWindowsIdentifierDir(paths: WindowsManagedPaths, identifier: []const u8) !std.Io.Dir {
    var local_dir = std.Io.Dir.openDirAbsolute(g_io, paths.local_appdata, .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.NotDir, error.SymLinkLoop => return error.InvalidUninstallLocation,
        else => return err,
    };
    defer local_dir.close(g_io);
    return local_dir.openDir(g_io, identifier, .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.NotDir, error.SymLinkLoop => error.InvalidUninstallLocation,
        else => err,
    };
}

fn openWindowsChannelDir(paths: WindowsManagedPaths, identifier: []const u8, channel: []const u8) !std.Io.Dir {
    _ = channel;
    var identifier_dir = try openWindowsIdentifierDir(paths, identifier);
    defer identifier_dir.close(g_io);
    return identifier_dir.openDir(g_io, std.fs.path.basename(paths.channel_root), .{
        .follow_symlinks = false,
        .iterate = true,
    }) catch |err| switch (err) {
        error.NotDir, error.SymLinkLoop => error.InvalidUninstallLocation,
        else => err,
    };
}

fn validateWindowsManagedChildIfExists(
    channel_dir: std.Io.Dir,
    child_name: []const u8,
    allow_directory: bool,
    allow_file: bool,
) !void {
    const stat = channel_dir.statFile(g_io, child_name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound, error.NotDir => return,
        else => return err,
    };
    if ((stat.kind == .directory and allow_directory) or
        (stat.kind == .file and allow_file)) return;
    return error.InvalidUninstallLocation;
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

fn acquireWindowsLock(
    allocator: std.mem.Allocator,
    base_dir: []const u8,
    wait_milliseconds: std.os.windows.DWORD,
) !WindowsUninstallLock {
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
    const wait_result = windows_uninstall_sync.WaitForSingleObject(handle, wait_milliseconds);
    if (wait_result == windows_uninstall_sync.wait_timeout and
        wait_milliseconds == windows_uninstall_sync.no_wait)
    {
        return error.InstallationAlreadyInProgress;
    }
    if (wait_result != windows_uninstall_sync.wait_object_0 and
        wait_result != windows_uninstall_sync.wait_abandoned)
    {
        return error.UninstallLockFailed;
    }
    return .{ .handle = handle };
}

fn acquireWindowsUninstallLock(allocator: std.mem.Allocator, base_dir: []const u8) !WindowsUninstallLock {
    return acquireWindowsLock(allocator, base_dir, windows_uninstall_sync.infinite);
}

fn acquireWindowsInstallLock(allocator: std.mem.Allocator, base_dir: []const u8) !WindowsUninstallLock {
    return acquireWindowsLock(allocator, base_dir, windows_uninstall_sync.no_wait);
}

fn windowsRootMatchesInstallIdentity(
    base_dir: []const u8,
    channel: []const u8,
    name: []const u8,
    install_root_name: ?[]const u8,
) bool {
    const root_name = std.fs.path.basename(base_dir);
    const allowed_alias = install_root_name orelse name;
    return std.ascii.eqlIgnoreCase(root_name, channel) or
        (isSafeWindowsComponent(allowed_alias) and
            std.ascii.eqlIgnoreCase(root_name, allowed_alias));
}

fn validateWindowsUninstallManifest(
    allocator: std.mem.Allocator,
    manifest: WindowsUninstallManifest,
    base_dir: []const u8,
) !void {
    if (manifest.schema_version != WINDOWS_UNINSTALL_MANIFEST_VERSION or
        !isValidWindowsInstallNonce(manifest.install_nonce) or
        !isSafeWindowsComponent(manifest.identifier) or
        !isBuildChannel(manifest.channel) or
        !isSafeWindowsDisplayName(manifest.name) or
        !windowsRootMatchesInstallIdentity(
            base_dir,
            manifest.channel,
            manifest.name,
            manifest.install_root_name,
        ))
    {
        return error.InvalidUninstallManifest;
    }
    try validateWindowsDataPathVersions(manifest.data_path_versions);
    var paths = try windowsManagedPathsFromBaseDir(
        allocator,
        base_dir,
        manifest.identifier,
        manifest.channel,
    );
    defer paths.deinit(allocator);

    const shortcut_name = try windowsShortcutFileName(allocator, manifest.name, manifest.channel);
    defer allocator.free(shortcut_name);
    const desktop_dir = try getWindowsDesktopDir(allocator);
    defer allocator.free(desktop_dir);
    const programs_dir = try getWindowsProgramsDir(allocator);
    defer allocator.free(programs_dir);
    const expected_desktop_shortcut = try std.fs.path.join(allocator, &.{ desktop_dir, shortcut_name });
    defer allocator.free(expected_desktop_shortcut);
    const expected_start_menu_shortcut = try std.fs.path.join(allocator, &.{ programs_dir, shortcut_name });
    defer allocator.free(expected_start_menu_shortcut);
    if (!std.fs.path.isAbsolute(manifest.desktop_shortcut) or
        !std.fs.path.isAbsolute(manifest.start_menu_shortcut) or
        !try windowsPathsEqual(allocator, manifest.desktop_shortcut, expected_desktop_shortcut) or
        !try windowsPathsEqual(allocator, manifest.start_menu_shortcut, expected_start_menu_shortcut))
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
    var atomic_file = try std.Io.Dir.cwd().createFileAtomic(g_io, manifest_path, .{ .replace = true });
    defer atomic_file.deinit(g_io);
    var buffer: [4096]u8 = undefined;
    var writer = atomic_file.file.writer(g_io, &buffer);
    try writer.interface.writeAll(json);
    try writer.flush();
    try atomic_file.file.sync(g_io);
    try atomic_file.replace(g_io);
}

fn atomicCopyWindowsManager(
    allocator: std.mem.Allocator,
    source_path: []const u8,
    destination_path: []const u8,
) !void {
    const source_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, source_path);
    defer allocator.free(source_w);
    const destination_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, destination_path);
    defer allocator.free(destination_w);
    if (windows_uninstall_ui.electrobun_atomic_copy_windows_manager(
        source_w.ptr,
        destination_w.ptr,
    ) == 0) return error.WindowsManagerCopyFailed;
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

fn linuxRootMatchesInstallIdentity(
    root_name: []const u8,
    channel: []const u8,
    name: []const u8,
    install_root_name: ?[]const u8,
) bool {
    const allowed_alias = install_root_name orelse name;
    return std.mem.eql(u8, root_name, channel) or
        (isSafeLinuxComponent(allowed_alias) and std.mem.eql(u8, root_name, allowed_alias));
}

fn validateLinuxUninstallManifest(
    allocator: std.mem.Allocator,
    manifest: LinuxUninstallManifest,
    scope: LinuxInstallScope,
) !void {
    if ((manifest.schema_version != LINUX_UNINSTALL_MANIFEST_VERSION and
        manifest.schema_version != LINUX_LEGACY_UNINSTALL_MANIFEST_VERSION) or
        !isSafeLinuxComponent(manifest.identifier) or
        !isBuildChannel(manifest.channel) or
        !isSafeLinuxDisplayName(manifest.name) or
        manifest.version.len == 0 or
        (manifest.application_entry.len != 0 and !isValidSha256Hex(manifest.application_entry_sha256)) or
        (manifest.application_entry.len == 0 and manifest.application_entry_sha256.len != 0) or
        (manifest.desktop_entry.len != 0 and !isValidSha256Hex(manifest.desktop_entry_sha256)) or
        (manifest.desktop_entry.len == 0 and manifest.desktop_entry_sha256.len != 0))
    {
        return error.InvalidUninstallManifest;
    }
    if (!linuxRootMatchesInstallIdentity(
        scope.channel,
        manifest.channel,
        manifest.name,
        manifest.install_root_name,
    ) or
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
    prepareNoFollowFileForRead(&manifest_file);
    const manifest_stat = try manifest_file.stat(g_io);
    if (manifest_stat.kind != .file) return error.InvalidUninstallManifest;
    var read_buffer: [4096]u8 = undefined;
    var manifest_reader = manifest_file.reader(g_io, &read_buffer);
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
    prepareNoFollowFileForRead(&file);
    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(g_io, &read_buffer);
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

fn matchingLegacyLinuxDesktopEntry(
    allocator: std.mem.Allocator,
    path: []const u8,
    allowed_parent: []const u8,
    expected_hash: []const u8,
    launcher_path: []const u8,
) !bool {
    // Reuse uninstall's no-follow, regular-file, hash, and Exec checks without
    // removing the entry. The caller records ownership only after all match.
    var prepared = try prepareLinuxDesktopEntry(
        allocator,
        path,
        allowed_parent,
        expected_hash,
        launcher_path,
    );
    defer prepared.deinit();
    return prepared.should_delete;
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
    prepareNoFollowFileForRead(&source_file);
    const source_stat = try source_file.stat(g_io);
    if (source_stat.kind != .file) return error.InvalidUninstallManager;

    var atomic_uninstaller = try scope.channel_dir.createFileAtomic(g_io, LINUX_UNINSTALL_EXE_NAME, .{
        .replace = true,
        .permissions = .fromMode(0o755),
    });
    defer atomic_uninstaller.deinit(g_io);
    var source_buffer: [4096]u8 = undefined;
    var source_reader = source_file.reader(g_io, &source_buffer);
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
    collision_policy: LinuxDesktopCollisionPolicy,
) !void {
    if (!isSafeLinuxComponent(metadata.identifier) or
        !isBuildChannel(metadata.channel) or
        !isSafeLinuxDisplayName(metadata.name)) return error.InvalidInstallIdentity;
    const base_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidInstallLocation;
    var scope = try openLinuxInstallScope(allocator, base_dir);
    defer scope.deinit(allocator);
    if (!std.mem.eql(u8, scope.identifier, metadata.identifier) or
        !linuxRootMatchesInstallIdentity(
            scope.channel,
            metadata.channel,
            metadata.name,
            metadata.install_root_name,
        ))
    {
        return error.InvalidInstallLocation;
    }

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
        collision_policy,
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
        .install_root_name = scope.channel,
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
        .install_root_name = old.install_root_name orelse scope.channel,
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
            scope.channel,
        );
        state_target = try prepareLinuxScopedDeletionTarget(
            manifest.xdg_state_home.?,
            manifest.identifier,
            scope.channel,
        );
    }

    _ = try application_entry.remove();
    _ = try desktop_entry.remove();
    refreshLinuxDesktopDatabase(manifest.application_entry);

    if (mode == .app_and_data) {
        try cache_target.remove(manifest.identifier, scope.channel);
        try state_target.remove(manifest.identifier, scope.channel);
        try scope.identifier_dir.deleteTree(g_io, scope.channel);
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
    scope.identifier_dir.deleteDir(g_io, scope.channel) catch {};
    scope.data_home_dir.deleteDir(g_io, manifest.identifier) catch {};
}

fn installWindowsIntegration(
    allocator: std.mem.Allocator,
    app_dir: []const u8,
    metadata: AppMetadata,
) !void {
    bootstrapTrace("windows integration: validate identity");
    if (!isSafeWindowsComponent(metadata.identifier) or
        !isBuildChannel(metadata.channel) or
        !isSafeWindowsDisplayName(metadata.name))
    {
        return error.InvalidInstallIdentity;
    }
    const base_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidInstallLocation;
    bootstrapTrace("windows integration: validate root identity");
    if (!windowsRootMatchesInstallIdentity(
        base_dir,
        metadata.channel,
        metadata.name,
        metadata.install_root_name,
    )) {
        return error.InvalidInstallLocation;
    }
    bootstrapTrace("windows integration: resolve managed paths");
    var paths = try windowsManagedPathsFromBaseDir(
        allocator,
        base_dir,
        metadata.identifier,
        metadata.channel,
    );
    defer paths.deinit(allocator);
    bootstrapTrace("windows integration: validate app path");
    if (!try windowsPathsEqual(allocator, app_dir, paths.app_dir)) {
        return error.InvalidInstallLocation;
    }
    bootstrapTrace("windows integration: acquire lock");
    var uninstall_lock = try acquireWindowsUninstallLock(allocator, paths.channel_root);
    defer uninstall_lock.release();
    bootstrapTrace("windows integration: open channel root");
    var channel_dir = try openWindowsChannelDir(paths, metadata.identifier, metadata.channel);
    defer channel_dir.close(g_io);
    bootstrapTrace("windows integration: attest bundled manager");
    try requirePlainWindowsBundledManager(allocator, paths);

    bootstrapTrace("windows integration: validate launcher");
    const target_path = try std.fs.path.join(allocator, &.{ app_dir, "bin", "launcher.exe" });
    defer allocator.free(target_path);
    try std.Io.Dir.cwd().access(g_io, target_path, .{});
    const working_dir = try std.fs.path.join(allocator, &.{ app_dir, "bin" });
    defer allocator.free(working_dir);

    bootstrapTrace("windows integration: resolve shell folders");
    const shortcut_name = try windowsShortcutFileName(allocator, metadata.name, metadata.channel);
    defer allocator.free(shortcut_name);
    const desktop_dir = try getWindowsDesktopDir(allocator);
    defer allocator.free(desktop_dir);
    const programs_dir = try getWindowsProgramsDir(allocator);
    defer allocator.free(programs_dir);
    bootstrapTrace("windows integration: create shell folders");
    try std.Io.Dir.cwd().createDirPath(g_io, desktop_dir);
    try std.Io.Dir.cwd().createDirPath(g_io, programs_dir);
    const desktop_shortcut = try std.fs.path.join(allocator, &.{ desktop_dir, shortcut_name });
    defer allocator.free(desktop_shortcut);
    const start_menu_shortcut = try std.fs.path.join(allocator, &.{ programs_dir, shortcut_name });
    defer allocator.free(start_menu_shortcut);

    bootstrapTrace("windows integration: copy manager");
    try atomicCopyWindowsManager(allocator, paths.bundled_uninstaller, paths.uninstaller);
    bootstrapTrace("windows integration: remove prior shortcuts");
    removePreviousWindowsShortcuts(
        allocator,
        paths.manifest,
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
    const data_path_versions = [_]u32{WINDOWS_DATA_PATH_VERSION};
    const manifest = WindowsUninstallManifest{
        .schema_version = WINDOWS_UNINSTALL_MANIFEST_VERSION,
        .install_nonce = &install_nonce,
        .identifier = metadata.identifier,
        .name = metadata.name,
        .channel = metadata.channel,
        .desktop_shortcut = desktop_shortcut,
        .start_menu_shortcut = start_menu_shortcut,
        .install_root_name = std.fs.path.basename(paths.channel_root),
        .data_path_versions = &data_path_versions,
    };
    bootstrapTrace("windows integration: write manifest");
    try writeWindowsUninstallManifest(allocator, paths.manifest, manifest);

    errdefer deleteFileIfExists(desktop_shortcut) catch {};
    errdefer deleteFileIfExists(start_menu_shortcut) catch {};
    bootstrapTrace("windows integration: write shortcuts");
    try createWindowsShortcutFile(allocator, desktop_shortcut, target_path, working_dir, target_path);
    try createWindowsShortcutFile(allocator, start_menu_shortcut, target_path, working_dir, target_path);
    bootstrapTrace("windows integration: register uninstall entry");
    try registerWindowsUninstallEntry(allocator, manifest, app_dir, paths.uninstaller);
    bootstrapTrace("windows integration: complete");
}

fn retryDeleteTreeInDir(dir: std.Io.Dir, sub_path: []const u8) !void {
    for (0..60) |attempt| {
        dir.deleteTree(g_io, sub_path) catch |err| {
            if (attempt == 59) return err;
            g_io.sleep(.fromMilliseconds(500), .awake) catch {};
            continue;
        };
        return;
    }
}

fn retryDeleteFileInDir(dir: std.Io.Dir, sub_path: []const u8) !void {
    for (0..20) |attempt| {
        dir.deleteFile(g_io, sub_path) catch |err| switch (err) {
            error.FileNotFound, error.NotDir => return,
            else => {
                if (attempt == 19) return err;
                g_io.sleep(.fromMilliseconds(250), .awake) catch {};
                continue;
            },
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
    const powershell_path = try getWindowsPowerShellPath(allocator);
    defer allocator.free(powershell_path);
    const argv = [_][]const u8{
        powershell_path,
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

fn isValidWindowsUpdateRefreshStageName(name: []const u8) bool {
    const expected_len = WINDOWS_UPDATE_REFRESH_STAGE_PREFIX.len +
        32 + WINDOWS_UPDATE_REFRESH_STAGE_SUFFIX.len;
    if (name.len != expected_len or
        !std.mem.startsWith(u8, name, WINDOWS_UPDATE_REFRESH_STAGE_PREFIX) or
        !std.mem.endsWith(u8, name, WINDOWS_UPDATE_REFRESH_STAGE_SUFFIX))
    {
        return false;
    }
    const nonce = name[WINDOWS_UPDATE_REFRESH_STAGE_PREFIX.len..][0..32];
    for (nonce) |byte| switch (byte) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn validateWindowsUpdateRefreshStageLocation(
    allocator: std.mem.Allocator,
    executable_path: []const u8,
) !void {
    if (!std.fs.path.isAbsolute(executable_path) or
        !isValidWindowsUpdateRefreshStageName(std.fs.path.basename(executable_path)))
    {
        return error.InvalidUninstallLocation;
    }
    try validateWindowsTemporaryExecutableLocation(allocator, executable_path);
}

fn isValidTemporaryUninstallWorkerName(name: []const u8) bool {
    const prefix = "electrobun-uninstall-";
    const suffix = ".exe";
    if (!std.mem.startsWith(u8, name, prefix) or
        !std.mem.endsWith(u8, name, suffix)) return false;
    const nonce = name[prefix.len .. name.len - suffix.len];
    if (nonce.len == 0 or nonce.len > 16) return false;
    for (nonce) |byte| switch (byte) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn validateTemporaryUninstallWorkerLocation(
    allocator: std.mem.Allocator,
    worker_path: []const u8,
) !void {
    if (!isValidTemporaryUninstallWorkerName(std.fs.path.basename(worker_path))) {
        return error.InvalidUninstallLocation;
    }
    try validateWindowsTemporaryExecutableLocation(allocator, worker_path);
}

fn validateWindowsTemporaryExecutableLocation(
    allocator: std.mem.Allocator,
    executable_path: []const u8,
) !void {
    if (!std.fs.path.isAbsolute(executable_path)) return error.InvalidUninstallLocation;
    try requirePlainWindowsFile(executable_path, error.InvalidUninstallLocation);

    const temp_raw = try getWindowsTempDir(allocator);
    defer allocator.free(temp_raw);
    const temp_path = try std.fs.path.resolve(allocator, &.{temp_raw});
    defer allocator.free(temp_path);
    const executable_resolved = try std.fs.path.resolve(allocator, &.{executable_path});
    defer allocator.free(executable_resolved);
    const executable_parent = std.fs.path.dirname(executable_resolved) orelse
        return error.InvalidUninstallLocation;
    if (!std.ascii.eqlIgnoreCase(executable_parent, temp_path)) {
        return error.InvalidUninstallLocation;
    }

    const temp_physical = try requirePlainWindowsDirectoryPhysical(allocator, temp_path, null);
    defer allocator.free(temp_physical);
    const executable_physical = try std.Io.Dir.realPathFileAbsoluteAlloc(
        g_io,
        executable_resolved,
        allocator,
    );
    defer allocator.free(executable_physical);
    const expected_physical = try std.fs.path.join(
        allocator,
        &.{ temp_physical, std.fs.path.basename(executable_resolved) },
    );
    defer allocator.free(expected_physical);
    if (!try windowsPathsEqual(allocator, executable_physical, expected_physical)) {
        return error.InvalidUninstallLocation;
    }
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
    // Use the same Windows-native path as manager installation. Zig 0.16's
    // copyFile/sendFile implementation can hit an internal unreachable when
    // copying this PE on Windows.
    try atomicCopyWindowsManager(allocator, source_path, worker_path);
    return worker_path;
}

fn loadAndValidateWindowsManifest(
    allocator: std.mem.Allocator,
    manifest_path: []const u8,
    base_dir: []const u8,
) !struct { contents: []u8, parsed: std.json.Parsed(WindowsUninstallManifest) } {
    var manifest_file = try std.Io.Dir.openFileAbsolute(g_io, manifest_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer manifest_file.close(g_io);
    const manifest_stat = try manifest_file.stat(g_io);
    if (manifest_stat.kind != .file) return error.InvalidUninstallManifest;
    if (manifest_stat.size > 64 * 1024) return error.InvalidUninstallManifest;
    const manifest_size = std.math.cast(usize, manifest_stat.size) orelse
        return error.InvalidUninstallManifest;
    const contents = try allocator.alloc(u8, manifest_size);
    errdefer allocator.free(contents);
    const manifest_path_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, manifest_path);
    defer allocator.free(manifest_path_w);
    if (windows_uninstall_ui.electrobun_read_windows_file_exact(
        manifest_path_w.ptr,
        contents.ptr,
        contents.len,
    ) == 0) {
        return error.InvalidUninstallManifest;
    }
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

const WindowsManagerInvocation = struct {
    base_dir: []u8,
    bundled: bool,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.base_dir);
        self.* = undefined;
    }
};

fn locateWindowsManagerInvocation(
    allocator: std.mem.Allocator,
    executable_path: []const u8,
    allow_bundled: bool,
) !WindowsManagerInvocation {
    try requirePlainWindowsFile(executable_path, error.InvalidUninstallLocation);
    const executable_name = std.fs.path.basename(executable_path);
    if (std.ascii.eqlIgnoreCase(executable_name, WINDOWS_UNINSTALL_EXE_NAME)) {
        const base_dir = std.fs.path.dirname(executable_path) orelse return error.InvalidUninstallLocation;
        return .{ .base_dir = try allocator.dupe(u8, base_dir), .bundled = false };
    }
    if (!allow_bundled or
        !std.ascii.eqlIgnoreCase(executable_name, WINDOWS_BUNDLED_UNINSTALL_EXE_NAME))
    {
        return error.InvalidUninstallLocation;
    }
    const resources_dir = std.fs.path.dirname(executable_path) orelse return error.InvalidUninstallLocation;
    if (!std.ascii.eqlIgnoreCase(std.fs.path.basename(resources_dir), "Resources")) {
        return error.InvalidUninstallLocation;
    }
    const app_dir = std.fs.path.dirname(resources_dir) orelse return error.InvalidUninstallLocation;
    if (!std.ascii.eqlIgnoreCase(std.fs.path.basename(app_dir), "app")) {
        return error.InvalidUninstallLocation;
    }
    const base_dir = std.fs.path.dirname(app_dir) orelse return error.InvalidUninstallLocation;
    return .{ .base_dir = try allocator.dupe(u8, base_dir), .bundled = true };
}

fn refreshWindowsUninstallRegistration(allocator: std.mem.Allocator) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    var invocation = try locateWindowsManagerInvocation(allocator, executable_path, true);
    defer invocation.deinit(allocator);
    var uninstall_lock = try acquireWindowsUninstallLock(allocator, invocation.base_dir);
    defer uninstall_lock.release();
    const manifest_path = try std.fs.path.join(
        allocator,
        &.{ invocation.base_dir, WINDOWS_UNINSTALL_MANIFEST_NAME },
    );
    defer allocator.free(manifest_path);
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, invocation.base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const old = document.parsed.value;
    var paths = try windowsManagedPathsFromBaseDir(
        allocator,
        invocation.base_dir,
        old.identifier,
        old.channel,
    );
    defer paths.deinit(allocator);
    const expected_invocation_path = if (invocation.bundled)
        paths.bundled_uninstaller
    else
        paths.uninstaller;
    if (!try windowsPathsEqual(allocator, executable_path, expected_invocation_path)) {
        return error.InvalidUninstallLocation;
    }
    var channel_dir = try openWindowsChannelDir(paths, old.identifier, old.channel);
    defer channel_dir.close(g_io);
    if (invocation.bundled) {
        // The update bundle carries a thin, archive-free extractor resource.
        // Replacing through an atomic temp file keeps the previous manager
        // runnable if reading or writing the new resource fails.
        try requirePlainWindowsBundledManager(allocator, paths);
        try atomicCopyWindowsManager(allocator, executable_path, paths.uninstaller);
    } else {
        try requirePlainWindowsFile(paths.uninstaller, error.InvalidUninstallLocation);
    }

    const install_nonce = createWindowsInstallNonce();
    const data_path_versions = [_]u32{WINDOWS_DATA_PATH_VERSION};
    const refreshed = WindowsUninstallManifest{
        .schema_version = WINDOWS_UNINSTALL_MANIFEST_VERSION,
        .install_nonce = &install_nonce,
        .identifier = old.identifier,
        .name = old.name,
        .channel = old.channel,
        .desktop_shortcut = old.desktop_shortcut,
        .start_menu_shortcut = old.start_menu_shortcut,
        .install_root_name = old.install_root_name orelse std.fs.path.basename(paths.channel_root),
        .data_path_versions = &data_path_versions,
    };
    errdefer if (invocation.bundled) {
        // The freshly-copied manager understands the legacy manifest too, but
        // retain a fully usable retry entry if either manifest or registry
        // refresh fails after replacement.
        writeWindowsUninstallManifest(allocator, paths.manifest, old) catch {};
        registerWindowsUninstallEntry(allocator, old, paths.app_dir, paths.uninstaller) catch {};
    };
    try writeWindowsUninstallManifest(allocator, paths.manifest, refreshed);
    try registerWindowsUninstallEntry(allocator, refreshed, paths.app_dir, paths.uninstaller);
}

fn refreshWindowsUninstallRegistrationFromUpdate(
    allocator: std.mem.Allocator,
    requested_channel_root: []const u8,
) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    try validateWindowsUpdateRefreshStageLocation(allocator, executable_path);

    if (!std.fs.path.isAbsolute(requested_channel_root)) {
        return error.InvalidUninstallLocation;
    }
    const channel_root = try std.fs.path.resolve(allocator, &.{requested_channel_root});
    defer allocator.free(channel_root);
    // The updater passes the canonical channel root it staged against. Reject
    // traversal or alternate spellings before deriving the mutex or manifest.
    if (!std.ascii.eqlIgnoreCase(channel_root, requested_channel_root)) {
        return error.InvalidUninstallLocation;
    }

    var uninstall_lock = try acquireWindowsUninstallLock(allocator, channel_root);
    defer uninstall_lock.release();
    const manifest_path = try std.fs.path.join(
        allocator,
        &.{ channel_root, WINDOWS_UNINSTALL_MANIFEST_NAME },
    );
    defer allocator.free(manifest_path);
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, channel_root);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const old = document.parsed.value;
    var paths = try windowsManagedPathsFromBaseDir(
        allocator,
        channel_root,
        old.identifier,
        old.channel,
    );
    defer paths.deinit(allocator);
    if (!try windowsPathsEqual(allocator, requested_channel_root, paths.channel_root) or
        !try windowsPathsEqual(allocator, manifest_path, paths.manifest))
    {
        return error.InvalidUninstallLocation;
    }

    var channel_dir = try openWindowsChannelDir(paths, old.identifier, old.channel);
    defer channel_dir.close(g_io);
    try requirePlainWindowsBundledManager(allocator, paths);
    // A missing external manager is repairable. Any existing target must be a
    // normal file; in particular, never replace through a reparse point.
    try validateWindowsManagedChildIfExists(
        channel_dir,
        WINDOWS_UNINSTALL_EXE_NAME,
        false,
        true,
    );

    // All stage, manifest, identity, resource, and destination checks precede
    // the first mutation. From this point onward the validated staged process
    // arranges its own deferred deletion regardless of refresh success.
    defer scheduleTemporaryWorkerDeletion(allocator, executable_path) catch {};

    const install_nonce = createWindowsInstallNonce();
    const data_path_versions = [_]u32{WINDOWS_DATA_PATH_VERSION};
    const refreshed = WindowsUninstallManifest{
        .schema_version = WINDOWS_UNINSTALL_MANIFEST_VERSION,
        .install_nonce = &install_nonce,
        .identifier = old.identifier,
        .name = old.name,
        .channel = old.channel,
        .desktop_shortcut = old.desktop_shortcut,
        .start_menu_shortcut = old.start_menu_shortcut,
        .install_root_name = old.install_root_name orelse std.fs.path.basename(paths.channel_root),
        .data_path_versions = &data_path_versions,
    };
    var manager_replaced = false;
    errdefer if (manager_replaced) {
        // The new thin manager remains runnable with the old manifest. Restore
        // the previous generation and ARP entry so the operation can be retried.
        writeWindowsUninstallManifest(allocator, paths.manifest, old) catch {};
        registerWindowsUninstallEntry(allocator, old, paths.app_dir, paths.uninstaller) catch {};
    };

    // The staged .exe is only an execution shim. Bind installed manager bytes
    // to the validated extensionless resource from the updated application.
    try atomicCopyWindowsManager(allocator, paths.bundled_uninstaller, paths.uninstaller);
    manager_replaced = true;
    try writeWindowsUninstallManifest(allocator, paths.manifest, refreshed);
    try registerWindowsUninstallEntry(allocator, refreshed, paths.app_dir, paths.uninstaller);
}

fn uninstallWindows(
    allocator: std.mem.Allocator,
    requested_mode: ?WindowsUninstallMode,
) !void {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    var invocation = try locateWindowsManagerInvocation(allocator, executable_path, false);
    defer invocation.deinit(allocator);
    var uninstall_lock = try acquireWindowsUninstallLock(allocator, invocation.base_dir);
    defer uninstall_lock.release();
    const manifest_path = try std.fs.path.join(
        allocator,
        &.{ invocation.base_dir, WINDOWS_UNINSTALL_MANIFEST_NAME },
    );
    defer allocator.free(manifest_path);
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, invocation.base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();
    const manifest = document.parsed.value;

    const mode: WindowsUninstallMode = requested_mode orelse blk: {
        const name_w = try std.unicode.wtf8ToWtf16LeAllocZ(allocator, manifest.name);
        defer allocator.free(name_w);
        break :blk switch (windows_uninstall_ui.electrobun_show_windows_uninstall_prompt(name_w.ptr)) {
            1 => .app,
            2 => .app_and_data,
            else => return,
        };
    };
    var paths = try windowsManagedPathsFromBaseDir(
        allocator,
        invocation.base_dir,
        manifest.identifier,
        manifest.channel,
    );
    defer paths.deinit(allocator);
    if (!try windowsPathsEqual(allocator, executable_path, paths.uninstaller) or
        !try windowsPathsEqual(allocator, manifest_path, paths.manifest))
    {
        return error.InvalidUninstallLocation;
    }

    // Pin the channel directory and validate every selected managed node
    // before creating a worker, stopping a process, deleting a task, or
    // changing any file. App-only intentionally never enumerates data.
    var channel_dir = try openWindowsChannelDir(paths, manifest.identifier, manifest.channel);
    defer channel_dir.close(g_io);
    var uninstaller_file = try channel_dir.openFile(g_io, WINDOWS_UNINSTALL_EXE_NAME, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer uninstaller_file.close(g_io);
    if ((try uninstaller_file.stat(g_io)).kind != .file) return error.InvalidUninstallLocation;
    var manifest_file = try channel_dir.openFile(g_io, WINDOWS_UNINSTALL_MANIFEST_NAME, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer manifest_file.close(g_io);
    if ((try manifest_file.stat(g_io)).kind != .file) return error.InvalidUninstallManifest;
    try validateWindowsManagedChildIfExists(channel_dir, "app", true, true);
    try validateWindowsManagedChildIfExists(channel_dir, "self-extraction", true, true);
    try validateWindowsManagedChildIfExists(channel_dir, "update.bat", false, true);
    try preflightWindowsShortcutForCleanup(allocator, manifest.desktop_shortcut);
    try preflightWindowsShortcutForCleanup(allocator, manifest.start_menu_shortcut);

    const update_task_name = try windowsUpdateTaskName(allocator, manifest.identifier, manifest.channel);
    defer allocator.free(update_task_name);
    const schtasks_path = try getWindowsSystemExecutablePath(allocator, "schtasks.exe");
    defer allocator.free(schtasks_path);
    const query_task_args = [_][]const u8{ schtasks_path, "/query", "/tn", update_task_name };
    const update_task_exists = runWindowsCommand(&query_task_args) catch false;
    const worker_path = try createTemporaryUninstallWorker(allocator, executable_path);
    defer allocator.free(worker_path);
    errdefer deleteFileIfExists(worker_path) catch {};
    const worker_dir = std.fs.path.dirname(worker_path) orelse return error.InvalidPath;

    var cleanup_error: ?anyerror = null;
    if (update_task_exists) {
        const end_task_args = [_][]const u8{ schtasks_path, "/end", "/tn", update_task_name };
        _ = runWindowsCommand(&end_task_args) catch false;
        const delete_task_args = [_][]const u8{ schtasks_path, "/delete", "/tn", update_task_name, "/f" };
        if (!(runWindowsCommand(&delete_task_args) catch false)) {
            cleanup_error = error.WindowsCommandFailed;
        }
    }

    // Stop only processes whose executable lives inside this channel's app
    // directory. This avoids terminating a coexisting stable/canary app.
    terminateWindowsAppProcesses(allocator, paths.app_dir) catch |err| {
        std.debug.print("Warning: Could not stop running app processes: {}\n", .{err});
    };

    retryDeleteTreeInDir(channel_dir, "app") catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    retryDeleteTreeInDir(channel_dir, "self-extraction") catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    retryDeleteFileInDir(channel_dir, "update.bat") catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    const launcher_path = try std.fs.path.join(allocator, &.{ paths.app_dir, "bin", "launcher.exe" });
    defer allocator.free(launcher_path);
    deleteWindowsShortcutIfTargets(allocator, manifest.desktop_shortcut, launcher_path) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    deleteWindowsShortcutIfTargets(allocator, manifest.start_menu_shortcut, launcher_path) catch |err| if (cleanup_error == null) {
        cleanup_error = err;
    };
    if (cleanup_error) |err| return err;

    const app_worker_args = [_][]const u8{
        worker_path,
        "--cleanup-uninstaller",
        paths.uninstaller,
        paths.manifest,
        manifest.install_nonce,
    };
    const data_worker_args = [_][]const u8{
        worker_path,
        "--cleanup-uninstaller",
        paths.uninstaller,
        paths.manifest,
        manifest.install_nonce,
        "--delete-data",
    };
    const worker_args: []const []const u8 = if (mode == .app_and_data)
        &data_worker_args
    else
        &app_worker_args;
    const worker = std.process.spawn(g_io, .{
        .argv = worker_args,
        // App-and-Data removes the channel root. Do not let the worker inherit
        // the manager's channel-root working directory and pin that directory.
        .cwd = .{ .path = worker_dir },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = true,
    }) catch |err| return err;
    _ = worker;
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
    const ping_path = try getWindowsSystemExecutablePath(allocator, "ping.exe");
    defer allocator.free(ping_path);
    const escaped_ping_path = try batchDoubleQuotedPath(allocator, ping_path);
    defer allocator.free(escaped_ping_path);
    const script = try std.fmt.allocPrint(allocator,
        \\@echo off
        \\setlocal DisableDelayedExpansion
        \\set retries=0
        \\:retry
        \\del /f /q "{s}" >nul 2>&1
        \\if not exist "{s}" goto deleted
        \\set /a retries+=1
        \\if %retries% GEQ 30 exit /b 1
        \\"{s}" -n 2 127.0.0.1 >nul
        \\goto retry
        \\:deleted
        \\del /f /q "%~f0" >nul 2>&1
        \\
    , .{ escaped_worker_path, escaped_worker_path, escaped_ping_path });
    defer allocator.free(script);
    try std.Io.Dir.cwd().writeFile(g_io, .{ .sub_path = script_path, .data = script });

    const cmd_path = try getWindowsSystemExecutablePath(allocator, "cmd.exe");
    defer allocator.free(cmd_path);
    const argv = [_][]const u8{ cmd_path, "/d", "/c", script_name };
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
    delete_data: bool,
) !void {
    const worker_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(worker_path);
    if (!isValidWindowsInstallNonce(expected_install_nonce)) return error.InvalidArguments;
    try validateTemporaryUninstallWorkerLocation(allocator, worker_path);
    defer scheduleTemporaryWorkerDeletion(allocator, worker_path) catch {};
    const base_dir = std.fs.path.dirname(original_uninstaller) orelse return error.InvalidUninstallLocation;
    var uninstall_lock = try acquireWindowsUninstallLock(allocator, base_dir);
    defer uninstall_lock.release();
    var document = try loadAndValidateWindowsManifest(allocator, manifest_path, base_dir);
    defer allocator.free(document.contents);
    defer document.parsed.deinit();

    const manifest = document.parsed.value;
    var paths = try windowsManagedPathsFromBaseDir(
        allocator,
        base_dir,
        manifest.identifier,
        manifest.channel,
    );
    defer paths.deinit(allocator);
    const managed_root_name = std.fs.path.basename(paths.channel_root);
    if (!try windowsPathsEqual(allocator, original_uninstaller, paths.uninstaller) or
        !try windowsPathsEqual(allocator, manifest_path, paths.manifest))
    {
        return error.InvalidUninstallLocation;
    }

    // A reinstall can finish before this deferred worker starts. Its new
    // manifest has a different nonce, so a stale worker must leave both files
    // (and the channel directory) intact and only arrange its own deletion.
    if (!windowsInstallNonceMatches(manifest.install_nonce, expected_install_nonce)) return;

    var identifier_dir = try openWindowsIdentifierDir(paths, manifest.identifier);
    defer identifier_dir.close(g_io);
    if (delete_data) {
        {
            var channel_dir = try identifier_dir.openDir(g_io, managed_root_name, .{
                .follow_symlinks = false,
                .iterate = true,
            });
            defer channel_dir.close(g_io);
            var uninstaller_file = try channel_dir.openFile(g_io, WINDOWS_UNINSTALL_EXE_NAME, .{
                .allow_directory = false,
                .follow_symlinks = false,
            });
            defer uninstaller_file.close(g_io);
            if ((try uninstaller_file.stat(g_io)).kind != .file) return error.InvalidUninstallLocation;
            var manifest_file = try channel_dir.openFile(g_io, WINDOWS_UNINSTALL_MANIFEST_NAME, .{
                .allow_directory = false,
                .follow_symlinks = false,
            });
            defer manifest_file.close(g_io);
            if ((try manifest_file.stat(g_io)).kind != .file) return error.InvalidUninstallManifest;
        }

        var registry_deleted = false;
        errdefer if (registry_deleted) {
            registerWindowsUninstallEntry(
                allocator,
                manifest,
                paths.app_dir,
                paths.uninstaller,
            ) catch {};
        };
        try deleteWindowsUninstallEntry(allocator, manifest.identifier, manifest.channel);
        registry_deleted = true;

        // Windows currently maps userData, userCache, and userLogs to this one
        // channel root. Delete that derived root exactly once, from outside it.
        retryDeleteTreeInDir(identifier_dir, managed_root_name) catch |err| {
            restoreWindowsManagerForRetry(
                allocator,
                worker_path,
                identifier_dir,
                paths,
                manifest,
            ) catch {};
            return err;
        };
        std.Io.Dir.cwd().deleteDir(g_io, paths.identifier_dir) catch {};
        registry_deleted = false;
        return;
    }

    {
        var channel_dir = try identifier_dir.openDir(g_io, managed_root_name, .{
            .follow_symlinks = false,
            .iterate = true,
        });
        defer channel_dir.close(g_io);
        {
            var uninstaller_file = try channel_dir.openFile(g_io, WINDOWS_UNINSTALL_EXE_NAME, .{
                .allow_directory = false,
                .follow_symlinks = false,
            });
            defer uninstaller_file.close(g_io);
            if ((try uninstaller_file.stat(g_io)).kind != .file) return error.InvalidUninstallLocation;
            var manifest_file = try channel_dir.openFile(g_io, WINDOWS_UNINSTALL_MANIFEST_NAME, .{
                .allow_directory = false,
                .follow_symlinks = false,
            });
            defer manifest_file.close(g_io);
            if ((try manifest_file.stat(g_io)).kind != .file) return error.InvalidUninstallManifest;
        }

        var registry_deleted = false;
        errdefer if (registry_deleted) {
            registerWindowsUninstallEntry(
                allocator,
                manifest,
                paths.app_dir,
                paths.uninstaller,
            ) catch {};
        };
        try deleteWindowsUninstallEntry(allocator, manifest.identifier, manifest.channel);
        registry_deleted = true;

        retryDeleteFileInDir(channel_dir, WINDOWS_UNINSTALL_EXE_NAME) catch |err| {
            restoreWindowsManagerForRetry(
                allocator,
                worker_path,
                identifier_dir,
                paths,
                manifest,
            ) catch {};
            return err;
        };
        retryDeleteFileInDir(channel_dir, WINDOWS_UNINSTALL_MANIFEST_NAME) catch |err| {
            restoreWindowsManagerForRetry(
                allocator,
                worker_path,
                identifier_dir,
                paths,
                manifest,
            ) catch {};
            return err;
        };
        registry_deleted = false;
    }

    // These are non-recursive on purpose: preserved user data keeps either
    // directory non-empty, while a data-free install leaves no empty shell.
    identifier_dir.deleteDir(g_io, managed_root_name) catch {};
    std.Io.Dir.cwd().deleteDir(g_io, paths.identifier_dir) catch {};
}

fn restoreWindowsManagerForRetry(
    allocator: std.mem.Allocator,
    worker_path: []const u8,
    identifier_dir: std.Io.Dir,
    paths: WindowsManagedPaths,
    manifest: WindowsUninstallManifest,
) !void {
    const managed_root_name = std.fs.path.basename(paths.channel_root);
    identifier_dir.createDir(g_io, managed_root_name, .default_dir) catch |err| switch (err) {
        error.PathAlreadyExists => {},
        else => return err,
    };
    var channel_dir = try identifier_dir.openDir(g_io, managed_root_name, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    defer channel_dir.close(g_io);
    try atomicCopyWindowsManager(allocator, worker_path, paths.uninstaller);
    try writeWindowsUninstallManifest(allocator, paths.manifest, manifest);
    try registerWindowsUninstallEntry(allocator, manifest, paths.app_dir, paths.uninstaller);
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

    // Retain the currently published updater state while the replacement is
    // decompressed and extracted. All managed children must be real
    // directories so cleanup and publication cannot traverse a symlink.
    for ([_][]const u8{ "self-extraction", "self-extraction.previous" }) |name| {
        const stat = channel_dir.statFile(g_io, name, .{ .follow_symlinks = false }) catch |err| switch (err) {
            error.FileNotFound => continue,
            else => return err,
        };
        if (stat.kind != .directory) return error.InvalidUninstallLocation;
    }

    const staging_name = "self-extraction.partial";
    const staging_stat = channel_dir.statFile(g_io, staging_name, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    if (staging_stat) |stat| {
        if (stat.kind != .directory) return error.InvalidUninstallLocation;
        try channel_dir.deleteTree(g_io, staging_name);
    }
    var extraction_dir = try ensurePlainMacosChildDir(channel_dir, staging_name);
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
    const root_name = std.fs.path.basename(resolved_root);
    if (!isSafeMacosComponent(root_name)) return error.InvalidUninstallLocation;
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

    const user_cache = try std.fs.path.join(allocator, &.{ home, "Library", "Caches", identifier, root_name });
    errdefer allocator.free(user_cache);
    const user_logs = try std.fs.path.join(allocator, &.{ home, "Library", "Logs", identifier, root_name });
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
    prepareNoFollowFileForRead(&version_file);
    var read_buffer: [4096]u8 = undefined;
    var version_reader = version_file.reader(g_io, &read_buffer);
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
        !installedChannelMatches(parsed.value.channel, channel))
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
    prepareNoFollowFileForRead(&version_file);
    var read_buffer: [4096]u8 = undefined;
    var reader = version_file.reader(g_io, &read_buffer);
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
        !installedChannelMatches(parsed.value.channel, channel))
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

fn macosRootMatchesInstallIdentity(
    install_root: []const u8,
    channel: []const u8,
    name: []const u8,
    install_root_name: ?[]const u8,
) bool {
    const root_name = std.fs.path.basename(install_root);
    const allowed_alias = install_root_name orelse name;
    return std.mem.eql(u8, root_name, channel) or
        (isSafeMacosComponent(allowed_alias) and std.mem.eql(u8, root_name, allowed_alias));
}

fn validateMacosUninstallManifest(
    allocator: std.mem.Allocator,
    manifest: MacosUninstallManifest,
    base_dir: []const u8,
) !void {
    if (manifest.schema_version != MACOS_UNINSTALL_MANIFEST_VERSION or
        !isValidMacosInstallNonce(manifest.install_nonce) or
        !isSafeMacosComponent(manifest.identifier) or
        !isBuildChannel(manifest.channel) or
        !isSafeMacosDisplayName(manifest.name) or
        !macosRootMatchesInstallIdentity(
            base_dir,
            manifest.channel,
            manifest.name,
            manifest.install_root_name,
        ) or
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
    prepareNoFollowFileForRead(&manifest_file);
    var read_buffer: [4096]u8 = undefined;
    var manifest_reader = manifest_file.reader(g_io, &read_buffer);
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

fn installMacosUninstallManagerAtRoot(
    allocator: std.mem.Allocator,
    base_dir: []const u8,
    source_app_bundle_path: []const u8,
    installed_app_bundle_path: []const u8,
    metadata: AppMetadata,
) !void {
    if (!isSafeMacosComponent(metadata.identifier) or
        !isBuildChannel(metadata.channel) or
        !isSafeMacosDisplayName(metadata.name)) return error.InvalidInstallIdentity;

    if (!macosRootMatchesInstallIdentity(
        base_dir,
        metadata.channel,
        metadata.name,
        metadata.install_root_name,
    )) {
        return error.InvalidInstallLocation;
    }
    var channel_dir = try std.Io.Dir.openDirAbsolute(g_io, base_dir, .{
        .follow_symlinks = false,
        .iterate = true,
    });
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
    prepareNoFollowFileForRead(&source_file);
    const source_stat = try source_file.stat(g_io);
    if (source_stat.kind != .file) return error.InvalidUninstallManager;
    const uninstall_path = try std.fs.path.join(allocator, &.{ base_dir, MACOS_UNINSTALL_EXE_NAME });
    defer allocator.free(uninstall_path);
    var atomic_uninstaller = try channel_dir.createFileAtomic(g_io, MACOS_UNINSTALL_EXE_NAME, .{
        .replace = true,
        .permissions = .fromMode(0o755),
    });
    defer atomic_uninstaller.deinit(g_io);
    var source_buffer: [4096]u8 = undefined;
    var source_reader = source_file.reader(g_io, &source_buffer);
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
        .install_root_name = std.fs.path.basename(base_dir),
    };
    try writeMacosUninstallManifest(allocator, channel_dir, manifest);
    std.debug.print("Installed macOS uninstaller: {s}\n", .{uninstall_path});
}

fn installMacosUninstallManager(
    allocator: std.mem.Allocator,
    source_app_bundle_path: []const u8,
    installed_app_bundle_path: []const u8,
    metadata: AppMetadata,
) !void {
    const home = try getEnvOwned(allocator, "HOME");
    defer allocator.free(home);
    const base_dir = try std.fs.path.join(
        allocator,
        &.{ home, "Library", "Application Support", metadata.identifier, metadata.channel },
    );
    defer allocator.free(base_dir);
    var channel_dir = try ensureMacosInstallRoot(home, metadata.identifier, metadata.channel);
    channel_dir.close(g_io);
    return installMacosUninstallManagerAtRoot(
        allocator,
        base_dir,
        source_app_bundle_path,
        installed_app_bundle_path,
        metadata,
    );
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
        .install_root_name = old.install_root_name orelse std.fs.path.basename(base_dir),
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
    const managed_root_name = std.fs.path.basename(paths.install_root);

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
        try deleteMacosScopedRoot(cache_identifier_dir, managed_root_name);
        try deleteMacosScopedRoot(logs_identifier_dir, managed_root_name);
        try install_identifier_dir.deleteTree(g_io, managed_root_name);
        return;
    }

    {
        var channel_dir = try install_identifier_dir.openDir(g_io, managed_root_name, .{
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
    install_identifier_dir.deleteDir(g_io, managed_root_name) catch {};
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

fn isApplyUpdateTransactionId(value: []const u8) bool {
    if (value.len != APPLY_UPDATE_TRANSACTION_HEX_LENGTH) return false;
    for (value) |byte| switch (byte) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn isApplyUpdateHash(value: []const u8) bool {
    if (value.len == 0 or value.len > 13) return false;
    for (value) |byte| switch (byte) {
        '0'...'9', 'a'...'z' => {},
        else => return false,
    };
    return true;
}

fn isApplyUpdateVersion(value: []const u8) bool {
    if (value.len == 0 or value.len > 256) return false;
    for (value) |byte| switch (byte) {
        0...31, 127 => return false,
        else => {},
    };
    return true;
}

fn expectedApplyUpdatePlatform() []const u8 {
    return switch (builtin.os.tag) {
        .windows => "win",
        .linux => "linux",
        .macos => "macos",
        else => @compileError("Unsupported update-manager platform"),
    };
}

fn expectedApplyUpdateArch() []const u8 {
    return switch (builtin.cpu.arch) {
        .x86_64 => "x64",
        .aarch64 => "arm64",
        else => @compileError("Unsupported update-manager architecture"),
    };
}

fn applyUpdatePlanName(allocator: std.mem.Allocator, transaction_id: []const u8) ![]u8 {
    if (!isApplyUpdateTransactionId(transaction_id)) return error.InvalidUpdatePlan;
    return std.fmt.allocPrint(
        allocator,
        APPLY_UPDATE_PLAN_PREFIX ++ "{s}" ++ APPLY_UPDATE_PLAN_SUFFIX,
        .{transaction_id},
    );
}

fn applyUpdateResultName(allocator: std.mem.Allocator, transaction_id: []const u8) ![]u8 {
    if (!isApplyUpdateTransactionId(transaction_id)) return error.InvalidUpdatePlan;
    return std.fmt.allocPrint(
        allocator,
        APPLY_UPDATE_PLAN_PREFIX ++ "{s}" ++ APPLY_UPDATE_RESULT_SUFFIX,
        .{transaction_id},
    );
}

fn applyUpdateHelperName(allocator: std.mem.Allocator, transaction_id: []const u8) ![]u8 {
    if (!isApplyUpdateTransactionId(transaction_id)) return error.InvalidUpdatePlan;
    return std.fmt.allocPrint(
        allocator,
        APPLY_UPDATE_HELPER_PREFIX ++ "{s}{s}",
        .{ transaction_id, if (builtin.os.tag == .windows) ".exe" else "" },
    );
}

fn applyUpdateTaskName(allocator: std.mem.Allocator, transaction_id: []const u8) ![]u8 {
    if (!isApplyUpdateTransactionId(transaction_id)) return error.InvalidUpdatePlan;
    return std.fmt.allocPrint(allocator, "ApplicationUpdate_{s}", .{transaction_id[0..24]});
}

fn applyUpdatePathsEqual(
    allocator: std.mem.Allocator,
    left: []const u8,
    right: []const u8,
) !bool {
    if (builtin.os.tag == .windows) return windowsPathsEqual(allocator, left, right);
    return std.mem.eql(u8, left, right);
}

const ApplyUpdateRootPlatform = enum {
    windows,
    linux,
    macos,
};

fn applyUpdateRootComponentEqual(
    left: []const u8,
    right: []const u8,
    platform: ApplyUpdateRootPlatform,
) bool {
    return if (platform == .windows)
        std.ascii.eqlIgnoreCase(left, right)
    else
        std.mem.eql(u8, left, right);
}

fn applyUpdateRootMatchesJoined(
    root_name: []const u8,
    base_name: []const u8,
    suffix: []const u8,
    platform: ApplyUpdateRootPlatform,
) bool {
    if (root_name.len != base_name.len + 1 + suffix.len or
        root_name[base_name.len] != '-')
    {
        return false;
    }
    return applyUpdateRootComponentEqual(root_name[0..base_name.len], base_name, platform) and
        applyUpdateRootComponentEqual(root_name[base_name.len + 1 ..], suffix, platform);
}

fn applyUpdateRootMatchesIdentityForPlatform(
    root_name: []const u8,
    channel: []const u8,
    current_bundle_name: []const u8,
    current_display_name: ?[]const u8,
    platform: ApplyUpdateRootPlatform,
) bool {
    if (!isBuildChannel(channel)) return false;
    if (applyUpdateRootComponentEqual(root_name, channel, platform) or
        applyUpdateRootComponentEqual(root_name, current_bundle_name, platform))
    {
        return true;
    }
    const is_stable = applyUpdateRootComponentEqual(channel, "stable", platform);

    // Early v1 Windows and Linux extractors used
    // `<sanitized app name>-<channel>`. For stable, version.json.name
    // omitted the stable suffix, so this alias cannot be covered by the
    // current bundle name comparison above.
    if (platform != .macos and is_stable and
        applyUpdateRootMatchesJoined(root_name, current_bundle_name, "stable", platform))
    {
        return true;
    }

    if (platform == .macos) {
        if (current_display_name) |display_name| {
            // The original macOS extractor used CFBundleName as its data root.
            // Stable bundles used the display name verbatim; other channels
            // appended their v1 channel name.
            if (is_stable) {
                return applyUpdateRootComponentEqual(root_name, display_name, platform);
            }
            return applyUpdateRootMatchesJoined(
                root_name,
                display_name,
                channel,
                platform,
            );
        }
    }
    return false;
}

fn applyUpdateRootMatchesIdentity(
    root_name: []const u8,
    channel: []const u8,
    current_bundle_name: []const u8,
    current_display_name: ?[]const u8,
) bool {
    return applyUpdateRootMatchesIdentityForPlatform(
        root_name,
        channel,
        current_bundle_name,
        current_display_name,
        switch (builtin.os.tag) {
            .windows => .windows,
            .linux => .linux,
            else => .macos,
        },
    );
}

fn requireResolvedApplyUpdatePath(
    allocator: std.mem.Allocator,
    path: []const u8,
) !void {
    if (!std.fs.path.isAbsolute(path) or std.mem.indexOfScalar(u8, path, 0) != null) {
        return error.InvalidUpdatePath;
    }
    const resolved = try std.fs.path.resolve(allocator, &.{path});
    defer allocator.free(resolved);
    if (!try applyUpdatePathsEqual(allocator, resolved, path)) return error.InvalidUpdatePath;
}

fn requireApplyUpdateFile(path: []const u8) !void {
    const stat = std.Io.Dir.cwd().statFile(g_io, path, .{ .follow_symlinks = false }) catch
        return error.InvalidUpdatePath;
    if (stat.kind != .file) return error.InvalidUpdatePath;
}

fn requireApplyUpdateDirectory(path: []const u8) !void {
    const stat = std.Io.Dir.cwd().statFile(g_io, path, .{ .follow_symlinks = false }) catch
        return error.InvalidUpdatePath;
    if (stat.kind != .directory) return error.InvalidUpdatePath;
}

fn prepareNoFollowFileForRead(file: *std.Io.File) void {
    if (builtin.os.tag == .windows) {
        // Zig opens no-follow Windows handles with asynchronous NT semantics,
        // but this vendored stdlib currently reports them as blocking files.
        // Correct the flag before reading so pending reads are awaited safely.
        file.flags.nonblocking = true;
    }
}

fn requirePhysicalApplyUpdateChild(
    allocator: std.mem.Allocator,
    parent_path: []const u8,
    child_path: []const u8,
    expected_kind: std.Io.File.Kind,
) !void {
    try requireResolvedApplyUpdatePath(allocator, parent_path);
    try requireResolvedApplyUpdatePath(allocator, child_path);
    const lexical_parent = std.fs.path.dirname(child_path) orelse return error.InvalidUpdatePath;
    if (!try applyUpdatePathsEqual(allocator, lexical_parent, parent_path)) return error.InvalidUpdatePath;
    const stat = std.Io.Dir.cwd().statFile(g_io, child_path, .{ .follow_symlinks = false }) catch
        return error.InvalidUpdatePath;
    if (stat.kind != expected_kind) return error.InvalidUpdatePath;
    const physical_parent = try std.Io.Dir.realPathFileAbsoluteAlloc(g_io, parent_path, allocator);
    defer allocator.free(physical_parent);
    const physical_child = try std.Io.Dir.realPathFileAbsoluteAlloc(g_io, child_path, allocator);
    defer allocator.free(physical_child);
    const expected_physical = try std.fs.path.join(
        allocator,
        &.{ physical_parent, std.fs.path.basename(child_path) },
    );
    defer allocator.free(expected_physical);
    if (!try applyUpdatePathsEqual(allocator, physical_child, expected_physical)) {
        return error.InvalidUpdatePath;
    }
}

fn expectedApplyUpdateChannelRoot(
    allocator: std.mem.Allocator,
    identifier: []const u8,
    channel: []const u8,
) ![]u8 {
    if (!isBuildChannel(channel)) return error.InvalidUpdateIdentity;
    if (builtin.os.tag == .windows) {
        if (!isSafeWindowsComponent(identifier) or !isSafeWindowsComponent(channel)) {
            return error.InvalidUpdateIdentity;
        }
        const data_root = try getAppDataDir(allocator);
        defer allocator.free(data_root);
        return std.fs.path.resolve(allocator, &.{ data_root, identifier });
    }
    if (builtin.os.tag == .linux) {
        if (!isSafeLinuxComponent(identifier) or !isSafeLinuxComponent(channel)) {
            return error.InvalidUpdateIdentity;
        }
        const data_root = try getAppDataDir(allocator);
        defer allocator.free(data_root);
        return std.fs.path.resolve(allocator, &.{ data_root, identifier });
    }
    if (!isSafeMacosComponent(identifier) or !isSafeMacosComponent(channel)) {
        return error.InvalidUpdateIdentity;
    }
    const home = try getEnvOwned(allocator, "HOME");
    defer allocator.free(home);
    return std.fs.path.resolve(
        allocator,
        &.{ home, "Library", "Application Support", identifier },
    );
}

const LoadedApplyUpdatePlan = struct {
    contents: []u8,
    parsed: std.json.Parsed(ApplyUpdatePlan),

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        self.parsed.deinit();
        allocator.free(self.contents);
        self.* = undefined;
    }
};

fn loadApplyUpdatePlan(
    allocator: std.mem.Allocator,
    plan_path: []const u8,
) !LoadedApplyUpdatePlan {
    try requireResolvedApplyUpdatePath(allocator, plan_path);
    try requireApplyUpdateFile(plan_path);
    var file = try std.Io.Dir.openFileAbsolute(g_io, plan_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer file.close(g_io);
    prepareNoFollowFileForRead(&file);
    const stat = try file.stat(g_io);
    if (stat.kind != .file or stat.size > 64 * 1024) return error.InvalidUpdatePlan;
    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(g_io, &read_buffer);
    const contents = reader.interface.allocRemaining(allocator, .limited(64 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return reader.err.?,
        else => |other| return other,
    };
    errdefer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(ApplyUpdatePlan, allocator, contents, .{});
    errdefer parsed.deinit();
    return .{ .contents = contents, .parsed = parsed };
}

const ValidatedApplyUpdateContext = struct {
    display_name: []u8,
    install_root_name: []u8,
    had_uninstall_manifest: bool,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.display_name);
        allocator.free(self.install_root_name);
        self.* = undefined;
    }
};

const ApplyUpdateValidationProgress = struct {
    plan_path_safe: bool = false,
    result_path_safe: bool = false,
};

const ApplyUpdateValidationFailureActions = struct {
    cleanup_transport: bool,
    cleanup_plan: bool,
    publish_result: bool,
};

fn applyUpdateValidationFailureActions(
    helper_is_valid: bool,
    progress: ApplyUpdateValidationProgress,
) ApplyUpdateValidationFailureActions {
    return .{
        .cleanup_transport = helper_is_valid,
        .cleanup_plan = helper_is_valid and progress.plan_path_safe,
        .publish_result = helper_is_valid and progress.result_path_safe,
    };
}

const CurrentApplyUpdateIdentity = struct {
    name: []u8,
    display_name: ?[]u8,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.name);
        if (self.display_name) |display_name| allocator.free(display_name);
        self.* = undefined;
    }
};

fn currentApplyUpdateIdentity(
    allocator: std.mem.Allocator,
    app_bundle_path: []const u8,
    identifier: []const u8,
    channel: []const u8,
) !CurrentApplyUpdateIdentity {
    const version_path = try applyUpdateBundleResourcePath(
        allocator,
        app_bundle_path,
        "version.json",
    );
    defer allocator.free(version_path);
    var file = try std.Io.Dir.openFileAbsolute(g_io, version_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer file.close(g_io);
    prepareNoFollowFileForRead(&file);
    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(g_io, &read_buffer);
    const contents = reader.interface.allocRemaining(allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return reader.err.?,
        else => |other| return other,
    };
    defer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        struct {
            version: []const u8,
            identifier: []const u8,
            channel: []const u8,
            name: []const u8,
            displayName: ?[]const u8 = null,
        },
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    const valid_name = if (builtin.os.tag == .windows)
        isSafeWindowsDisplayName(parsed.value.name)
    else if (builtin.os.tag == .linux)
        isSafeLinuxDisplayName(parsed.value.name)
    else
        isSafeMacosDisplayName(parsed.value.name);
    const valid_display_name = if (parsed.value.displayName) |display_name|
        if (builtin.os.tag == .windows)
            isSafeWindowsDisplayName(display_name)
        else if (builtin.os.tag == .linux)
            isSafeLinuxDisplayName(display_name)
        else
            isSafeMacosDisplayName(display_name)
    else
        true;
    if (parsed.value.version.len == 0 or
        !std.mem.eql(u8, parsed.value.identifier, identifier) or
        !installedChannelMatches(parsed.value.channel, channel) or
        !valid_name or
        !valid_display_name)
    {
        return error.InvalidUpdateIdentity;
    }
    const name = try allocator.dupe(u8, parsed.value.name);
    errdefer allocator.free(name);
    return .{
        .name = name,
        .display_name = if (parsed.value.displayName) |display_name|
            try allocator.dupe(u8, display_name)
        else
            null,
    };
}

fn legacyApplyUpdateDisplayName(
    allocator: std.mem.Allocator,
    app_bundle_path: []const u8,
    identifier: []const u8,
    channel: []const u8,
) ![]u8 {
    const identity = try currentApplyUpdateIdentity(
        allocator,
        app_bundle_path,
        identifier,
        channel,
    );
    if (identity.display_name) |display_name| {
        allocator.free(identity.name);
        return display_name;
    }
    return identity.name;
}

fn validateApplyUpdateHelper(
    allocator: std.mem.Allocator,
    transaction_id: []const u8,
) ![]u8 {
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    errdefer allocator.free(executable_path);
    const expected_name = try applyUpdateHelperName(allocator, transaction_id);
    defer allocator.free(expected_name);
    if (!std.mem.eql(u8, std.fs.path.basename(executable_path), expected_name)) {
        return error.InvalidUpdateHelper;
    }
    try requireApplyUpdateFile(executable_path);
    if (builtin.os.tag == .windows) {
        try validateWindowsTemporaryExecutableLocation(allocator, executable_path);
    } else {
        const physical = try std.Io.Dir.realPathFileAbsoluteAlloc(g_io, executable_path, allocator);
        defer allocator.free(physical);
        if (!std.mem.eql(u8, physical, executable_path)) return error.InvalidUpdateHelper;
    }
    return executable_path;
}

fn validateApplyUpdatePlanAndPaths(
    allocator: std.mem.Allocator,
    plan_path: []const u8,
    plan: ApplyUpdatePlan,
    progress: *ApplyUpdateValidationProgress,
) !ValidatedApplyUpdateContext {
    if (plan.schema_version != APPLY_UPDATE_PLAN_SCHEMA_VERSION or
        !isApplyUpdateTransactionId(plan.transaction_id) or
        !isBuildChannel(plan.channel) or
        !std.mem.eql(u8, plan.platform, expectedApplyUpdatePlatform()) or
        !std.mem.eql(u8, plan.arch, expectedApplyUpdateArch()) or
        !isApplyUpdateVersion(plan.version) or
        !isApplyUpdateHash(plan.hash) or
        plan.parent_pid == 0)
    {
        return error.InvalidUpdatePlan;
    }

    const expected_identifier_root = try expectedApplyUpdateChannelRoot(
        allocator,
        plan.identifier,
        plan.channel,
    );
    defer allocator.free(expected_identifier_root);
    try requireResolvedApplyUpdatePath(allocator, plan.channel_root);
    const actual_identifier_root = std.fs.path.dirname(plan.channel_root) orelse
        return error.InvalidUpdatePath;
    if (!try applyUpdatePathsEqual(
        allocator,
        actual_identifier_root,
        expected_identifier_root,
    )) {
        return error.InvalidUpdatePath;
    }
    const root_name = std.fs.path.basename(plan.channel_root);
    const safe_root_name = if (builtin.os.tag == .windows)
        isSafeWindowsComponent(root_name)
    else if (builtin.os.tag == .linux)
        isSafeLinuxComponent(root_name)
    else
        isSafeMacosComponent(root_name);
    if (!safe_root_name) return error.InvalidUpdatePath;

    const expected_plan_name = try applyUpdatePlanName(allocator, plan.transaction_id);
    defer allocator.free(expected_plan_name);
    const expected_plan_path = try std.fs.path.join(
        allocator,
        &.{ plan.channel_root, expected_plan_name },
    );
    defer allocator.free(expected_plan_path);
    if (!std.mem.eql(u8, std.fs.path.basename(plan_path), expected_plan_name) or
        !try applyUpdatePathsEqual(allocator, plan_path, expected_plan_path))
    {
        return error.InvalidUpdatePath;
    }
    try requirePhysicalApplyUpdateChild(
        allocator,
        plan.channel_root,
        plan_path,
        .file,
    );
    progress.plan_path_safe = true;

    const expected_result_name = try applyUpdateResultName(allocator, plan.transaction_id);
    defer allocator.free(expected_result_name);
    const expected_result_path = try std.fs.path.join(
        allocator,
        &.{ plan.channel_root, expected_result_name },
    );
    defer allocator.free(expected_result_path);
    try requireResolvedApplyUpdatePath(allocator, plan.result_path);
    if (!std.mem.eql(u8, std.fs.path.basename(plan.result_path), expected_result_name) or
        !try applyUpdatePathsEqual(allocator, plan.result_path, expected_result_path))
    {
        return error.InvalidUpdatePath;
    }
    const result_stat = std.Io.Dir.cwd().statFile(g_io, plan.result_path, .{
        .follow_symlinks = false,
    }) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
    if (result_stat) |stat| {
        if (stat.kind != .file) return error.InvalidUpdatePath;
        try requirePhysicalApplyUpdateChild(
            allocator,
            plan.channel_root,
            plan.result_path,
            .file,
        );
    }
    progress.result_path_safe = true;

    const extraction_dir = try std.fs.path.join(
        allocator,
        &.{ plan.channel_root, "self-extraction" },
    );
    defer allocator.free(extraction_dir);
    const tar_name = try std.fmt.allocPrint(allocator, "{s}.tar", .{plan.hash});
    defer allocator.free(tar_name);
    const expected_tar_path = try std.fs.path.join(allocator, &.{ extraction_dir, tar_name });
    defer allocator.free(expected_tar_path);
    try requireResolvedApplyUpdatePath(allocator, plan.retained_tar_path);
    if (!std.mem.eql(u8, std.fs.path.basename(plan.retained_tar_path), tar_name) or
        !try applyUpdatePathsEqual(allocator, plan.retained_tar_path, expected_tar_path))
    {
        return error.InvalidUpdatePath;
    }

    var display_name: []u8 = undefined;
    var had_uninstall_manifest = false;
    if (builtin.os.tag == .windows) {
        var paths = try windowsManagedPathsFromBaseDir(
            allocator,
            plan.channel_root,
            plan.identifier,
            plan.channel,
        );
        defer paths.deinit(allocator);
        if (!try applyUpdatePathsEqual(allocator, plan.app_bundle_path, paths.app_dir)) {
            return error.InvalidUpdatePath;
        }
        if (loadAndValidateWindowsManifest(
            allocator,
            paths.manifest,
            paths.channel_root,
        )) |document_value| {
            had_uninstall_manifest = true;
            var document = document_value;
            defer allocator.free(document.contents);
            defer document.parsed.deinit();
            if (!std.mem.eql(u8, document.parsed.value.identifier, plan.identifier) or
                !installedChannelMatches(document.parsed.value.channel, plan.channel))
            {
                return error.InvalidUpdateIdentity;
            }
            display_name = try allocator.dupe(u8, document.parsed.value.name);
        } else |err| switch (err) {
            error.FileNotFound => display_name = try legacyApplyUpdateDisplayName(
                allocator,
                plan.app_bundle_path,
                plan.identifier,
                plan.channel,
            ),
            else => return err,
        }
    } else if (builtin.os.tag == .linux) {
        var scope = try openLinuxInstallScope(allocator, plan.channel_root);
        defer scope.deinit(allocator);
        if (!std.mem.eql(u8, scope.identifier, plan.identifier)) {
            return error.InvalidUpdateIdentity;
        }
        const expected_app_path = try std.fs.path.join(
            allocator,
            &.{ plan.channel_root, "app" },
        );
        defer allocator.free(expected_app_path);
        if (!std.mem.eql(u8, plan.app_bundle_path, expected_app_path)) {
            return error.InvalidUpdatePath;
        }
        if (loadAndValidateLinuxManifest(allocator, scope)) |document_value| {
            had_uninstall_manifest = true;
            var document = document_value;
            defer allocator.free(document.contents);
            defer document.parsed.deinit();
            if (!std.mem.eql(u8, document.parsed.value.identifier, plan.identifier) or
                !installedChannelMatches(document.parsed.value.channel, plan.channel))
            {
                return error.InvalidUpdateIdentity;
            }
            display_name = try allocator.dupe(u8, document.parsed.value.name);
        } else |err| switch (err) {
            error.FileNotFound => display_name = try legacyApplyUpdateDisplayName(
                allocator,
                plan.app_bundle_path,
                plan.identifier,
                plan.channel,
            ),
            else => return err,
        }
    } else {
        var paths = try macosManagedPathsFromInstallRoot(
            allocator,
            plan.channel_root,
            plan.identifier,
            plan.channel,
        );
        defer paths.deinit(allocator);
        const manifest_path = try macosManifestPath(allocator, plan.channel_root);
        defer allocator.free(manifest_path);
        if (loadAndValidateMacosManifest(
            allocator,
            manifest_path,
            plan.channel_root,
        )) |document_value| {
            had_uninstall_manifest = true;
            var document = document_value;
            defer allocator.free(document.contents);
            defer document.parsed.deinit();
            if (!std.mem.eql(u8, document.parsed.value.identifier, plan.identifier) or
                !installedChannelMatches(document.parsed.value.channel, plan.channel) or
                !std.mem.eql(u8, document.parsed.value.app_bundle_path, plan.app_bundle_path))
            {
                return error.InvalidUpdateIdentity;
            }
            display_name = try allocator.dupe(u8, document.parsed.value.name);
        } else |err| switch (err) {
            error.FileNotFound => display_name = try legacyApplyUpdateDisplayName(
                allocator,
                plan.app_bundle_path,
                plan.identifier,
                plan.channel,
            ),
            else => return err,
        }
    }
    errdefer allocator.free(display_name);
    var current_identity = try currentApplyUpdateIdentity(
        allocator,
        plan.app_bundle_path,
        plan.identifier,
        plan.channel,
    );
    defer current_identity.deinit(allocator);
    if (!applyUpdateRootMatchesIdentity(
        root_name,
        plan.channel,
        current_identity.name,
        current_identity.display_name,
    )) {
        return error.InvalidUpdatePath;
    }
    const install_root_name = try allocator.dupe(u8, root_name);
    errdefer allocator.free(install_root_name);

    try requirePhysicalApplyUpdateChild(
        allocator,
        plan.channel_root,
        extraction_dir,
        .directory,
    );
    try requirePhysicalApplyUpdateChild(
        allocator,
        extraction_dir,
        plan.retained_tar_path,
        .file,
    );
    try requireResolvedApplyUpdatePath(allocator, plan.app_bundle_path);
    try requireApplyUpdateDirectory(plan.app_bundle_path);
    const app_parent = std.fs.path.dirname(plan.app_bundle_path) orelse return error.InvalidUpdatePath;
    try requirePhysicalApplyUpdateChild(
        allocator,
        app_parent,
        plan.app_bundle_path,
        .directory,
    );

    return .{
        .display_name = display_name,
        .install_root_name = install_root_name,
        .had_uninstall_manifest = had_uninstall_manifest,
    };
}

fn validateApplyUpdateRecoveryTarget(
    allocator: std.mem.Allocator,
    plan: ApplyUpdatePlan,
) !void {
    if (plan.schema_version != APPLY_UPDATE_PLAN_SCHEMA_VERSION or
        !isApplyUpdateTransactionId(plan.transaction_id) or
        !std.mem.eql(u8, plan.platform, expectedApplyUpdatePlatform()) or
        !std.mem.eql(u8, plan.arch, expectedApplyUpdateArch()) or
        plan.parent_pid == 0)
    {
        return error.InvalidUpdatePlan;
    }

    const expected_identifier_root = try expectedApplyUpdateChannelRoot(
        allocator,
        plan.identifier,
        plan.channel,
    );
    defer allocator.free(expected_identifier_root);
    try requireResolvedApplyUpdatePath(allocator, plan.channel_root);
    const actual_identifier_root = std.fs.path.dirname(plan.channel_root) orelse
        return error.InvalidUpdatePath;
    if (!try applyUpdatePathsEqual(
        allocator,
        actual_identifier_root,
        expected_identifier_root,
    )) {
        return error.InvalidUpdatePath;
    }

    if (builtin.os.tag == .windows) {
        var paths = try windowsManagedPathsFromBaseDir(
            allocator,
            plan.channel_root,
            plan.identifier,
            plan.channel,
        );
        defer paths.deinit(allocator);
        if (!try applyUpdatePathsEqual(allocator, plan.app_bundle_path, paths.app_dir)) {
            return error.InvalidUpdatePath;
        }
    } else if (builtin.os.tag == .linux) {
        var scope = try openLinuxInstallScope(allocator, plan.channel_root);
        defer scope.deinit(allocator);
        if (!std.mem.eql(u8, scope.identifier, plan.identifier)) {
            return error.InvalidUpdateIdentity;
        }
        const expected_app_path = try std.fs.path.join(
            allocator,
            &.{ plan.channel_root, "app" },
        );
        defer allocator.free(expected_app_path);
        if (!std.mem.eql(u8, plan.app_bundle_path, expected_app_path)) {
            return error.InvalidUpdatePath;
        }
    } else {
        var paths = try macosManagedPathsFromInstallRoot(
            allocator,
            plan.channel_root,
            plan.identifier,
            plan.channel,
        );
        defer paths.deinit(allocator);
    }

    try requireResolvedApplyUpdatePath(allocator, plan.app_bundle_path);
    try requireApplyUpdateDirectory(plan.app_bundle_path);
    var current_identity = try currentApplyUpdateIdentity(
        allocator,
        plan.app_bundle_path,
        plan.identifier,
        plan.channel,
    );
    defer current_identity.deinit(allocator);
    if (!applyUpdateRootMatchesIdentity(
        std.fs.path.basename(plan.channel_root),
        plan.channel,
        current_identity.name,
        current_identity.display_name,
    )) {
        return error.InvalidUpdatePath;
    }
    const app_parent = std.fs.path.dirname(plan.app_bundle_path) orelse
        return error.InvalidUpdatePath;
    try requirePhysicalApplyUpdateChild(
        allocator,
        app_parent,
        plan.app_bundle_path,
        .directory,
    );
}

fn waitForApplyUpdateParent(parent_pid: u32) !void {
    if (builtin.os.tag == .windows) {
        const handle = windows_uninstall_sync.OpenProcess(
            windows_uninstall_sync.synchronize,
            .FALSE,
            @intCast(parent_pid),
        ) orelse {
            if (windows_uninstall_sync.GetLastError() ==
                windows_uninstall_sync.error_invalid_parameter) return;
            return error.ParentProcessWaitFailed;
        };
        defer _ = windows_uninstall_sync.CloseHandle(handle);
        const result = windows_uninstall_sync.WaitForSingleObject(
            handle,
            @intCast(APPLY_UPDATE_PARENT_WAIT_MILLISECONDS),
        );
        if (result == windows_uninstall_sync.wait_object_0) return;
        if (result == windows_uninstall_sync.wait_timeout) return error.ParentProcessWaitTimedOut;
        if (result == windows_uninstall_sync.wait_failed) return error.ParentProcessWaitFailed;
        return error.ParentProcessWaitFailed;
    }

    const pid = std.math.cast(std.posix.pid_t, parent_pid) orelse
        return error.InvalidParentProcess;
    const attempts = APPLY_UPDATE_PARENT_WAIT_MILLISECONDS / 100;
    var attempt: u64 = 0;
    while (attempt < attempts) : (attempt += 1) {
        std.posix.kill(pid, @enumFromInt(0)) catch |err| switch (err) {
            error.ProcessNotFound => return,
            error.PermissionDenied => {},
            else => return err,
        };
        g_io.sleep(.fromMilliseconds(100), .awake) catch {};
    }
    return error.ParentProcessWaitTimedOut;
}

fn applyUpdateBundleResourcePath(
    allocator: std.mem.Allocator,
    bundle_path: []const u8,
    child: []const u8,
) ![]u8 {
    return if (builtin.os.tag == .macos)
        std.fs.path.join(allocator, &.{ bundle_path, "Contents", "Resources", child })
    else
        std.fs.path.join(allocator, &.{ bundle_path, "Resources", child });
}

fn applyUpdateLauncherPath(
    allocator: std.mem.Allocator,
    bundle_path: []const u8,
) ![]u8 {
    return switch (builtin.os.tag) {
        .windows => std.fs.path.join(allocator, &.{ bundle_path, "bin", "launcher.exe" }),
        .linux => std.fs.path.join(allocator, &.{ bundle_path, "bin", "launcher" }),
        .macos => std.fs.path.join(allocator, &.{ bundle_path, "Contents", "MacOS", "launcher" }),
        else => unreachable,
    };
}

fn validateApplyUpdateBundleIdentity(
    allocator: std.mem.Allocator,
    bundle_path: []const u8,
    plan: ApplyUpdatePlan,
) ![]u8 {
    try requireApplyUpdateDirectory(bundle_path);
    const bundle_parent = std.fs.path.dirname(bundle_path) orelse return error.InvalidUpdatePath;
    try requirePhysicalApplyUpdateChild(allocator, bundle_parent, bundle_path, .directory);
    const contents_path: ?[]u8 = if (builtin.os.tag == .macos)
        try std.fs.path.join(allocator, &.{ bundle_path, "Contents" })
    else
        null;
    defer if (contents_path) |path| allocator.free(path);
    const resource_parent = contents_path orelse bundle_path;
    if (contents_path) |path| {
        try requirePhysicalApplyUpdateChild(allocator, bundle_path, path, .directory);
    }
    const resources_path = try std.fs.path.join(allocator, &.{ resource_parent, "Resources" });
    defer allocator.free(resources_path);
    try requirePhysicalApplyUpdateChild(allocator, resource_parent, resources_path, .directory);
    const version_path = try applyUpdateBundleResourcePath(allocator, bundle_path, "version.json");
    defer allocator.free(version_path);
    try requirePhysicalApplyUpdateChild(allocator, resources_path, version_path, .file);
    var version_file = try std.Io.Dir.openFileAbsolute(g_io, version_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer version_file.close(g_io);
    prepareNoFollowFileForRead(&version_file);
    var read_buffer: [4096]u8 = undefined;
    var reader = version_file.reader(g_io, &read_buffer);
    const contents = reader.interface.allocRemaining(allocator, .limited(1024 * 1024)) catch |err| switch (err) {
        error.ReadFailed => return reader.err.?,
        else => |other| return other,
    };
    defer allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        StagedUpdateIdentity,
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    );
    defer parsed.deinit();
    if (!std.mem.eql(u8, parsed.value.identifier, plan.identifier) or
        !std.mem.eql(u8, parsed.value.channel, plan.channel) or
        !std.mem.eql(u8, parsed.value.version, plan.version) or
        !std.mem.eql(u8, parsed.value.hash, plan.hash))
    {
        return error.InvalidUpdateIdentity;
    }
    const valid_display_name = if (builtin.os.tag == .windows)
        isSafeWindowsDisplayName(parsed.value.displayName)
    else if (builtin.os.tag == .linux)
        isSafeLinuxDisplayName(parsed.value.displayName)
    else
        isSafeMacosDisplayName(parsed.value.displayName);
    if (!valid_display_name) return error.InvalidUpdateIdentity;

    const launcher_path = try applyUpdateLauncherPath(allocator, bundle_path);
    defer allocator.free(launcher_path);
    const launcher_parent = std.fs.path.dirname(launcher_path) orelse return error.InvalidUpdatePath;
    try requirePhysicalApplyUpdateChild(
        allocator,
        resource_parent,
        launcher_parent,
        .directory,
    );
    try requirePhysicalApplyUpdateChild(allocator, launcher_parent, launcher_path, .file);
    const manager_path = try applyUpdateBundleResourcePath(
        allocator,
        bundle_path,
        if (builtin.os.tag == .windows) WINDOWS_BUNDLED_UNINSTALL_EXE_NAME else "uninstall",
    );
    defer allocator.free(manager_path);
    try requirePhysicalApplyUpdateChild(allocator, resources_path, manager_path, .file);
    return allocator.dupe(u8, parsed.value.displayName);
}

fn findSingleApplyUpdateBundle(
    allocator: std.mem.Allocator,
    staging_path: []const u8,
) ![]u8 {
    var staging_dir = try std.Io.Dir.openDirAbsolute(g_io, staging_path, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    defer staging_dir.close(g_io);
    var iterator = staging_dir.iterate();
    var bundle_name: ?[]u8 = null;
    errdefer if (bundle_name) |name| allocator.free(name);
    while (try iterator.next(g_io)) |entry| {
        if (entry.kind != .directory or bundle_name != null) {
            return error.InvalidUpdateArchive;
        }
        bundle_name = try allocator.dupe(u8, entry.name);
    }
    const name = bundle_name orelse return error.InvalidUpdateArchive;
    defer allocator.free(name);
    if (builtin.os.tag == .macos and
        !std.mem.endsWith(u8, name, ".app")) return error.InvalidUpdateArchive;
    return std.fs.path.join(allocator, &.{ staging_path, name });
}

fn removePlainApplyUpdateDirectoryIfPresent(path: []const u8) !void {
    const stat = std.Io.Dir.cwd().statFile(g_io, path, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound, error.NotDir => return,
        else => return err,
    };
    if (stat.kind != .directory) return error.InvalidUpdatePath;
    try std.Io.Dir.cwd().deleteTree(g_io, path);
}

fn renameApplyUpdatePath(
    source_path: []const u8,
    destination_path: []const u8,
) !void {
    try std.Io.Dir.cwd().rename(source_path, std.Io.Dir.cwd(), destination_path, g_io);
}

fn renameCurrentApplyUpdateBundle(
    source_path: []const u8,
    destination_path: []const u8,
) !void {
    if (builtin.os.tag != .windows) return renameApplyUpdatePath(source_path, destination_path);
    var attempt: usize = 0;
    while (attempt < APPLY_UPDATE_WINDOWS_RENAME_RETRIES) : (attempt += 1) {
        renameApplyUpdatePath(source_path, destination_path) catch |err| {
            if (attempt + 1 == APPLY_UPDATE_WINDOWS_RENAME_RETRIES) return err;
            g_io.sleep(
                .fromMilliseconds(APPLY_UPDATE_WINDOWS_RENAME_RETRY_MILLISECONDS),
                .awake,
            ) catch {};
            continue;
        };
        return;
    }
    unreachable;
}

fn removeRollbackApplyUpdateBundle(path: []const u8) !void {
    if (builtin.os.tag != .windows) return removePlainApplyUpdateDirectoryIfPresent(path);
    var attempt: usize = 0;
    while (attempt < APPLY_UPDATE_WINDOWS_RENAME_RETRIES) : (attempt += 1) {
        removePlainApplyUpdateDirectoryIfPresent(path) catch |err| {
            if (attempt + 1 == APPLY_UPDATE_WINDOWS_RENAME_RETRIES) return err;
            g_io.sleep(
                .fromMilliseconds(APPLY_UPDATE_WINDOWS_RENAME_RETRY_MILLISECONDS),
                .awake,
            ) catch {};
            continue;
        };
        return;
    }
    unreachable;
}

fn applyUpdateIntegrationMetadata(
    plan: ApplyUpdatePlan,
    display_name: []const u8,
    hash: ?[]const u8,
    install_root_name: []const u8,
) AppMetadata {
    return .{
        .identifier = plan.identifier,
        .name = display_name,
        .channel = plan.channel,
        .hash = hash,
        .install_root_name = install_root_name,
    };
}

fn applyUpdatePlatformIntegration(
    allocator: std.mem.Allocator,
    bundle_path: []const u8,
    display_name: []const u8,
    plan: ApplyUpdatePlan,
    hash: ?[]const u8,
    install_root_name: []const u8,
    linux_desktop_collision_policy: LinuxDesktopCollisionPolicy,
) !void {
    const metadata = applyUpdateIntegrationMetadata(
        plan,
        display_name,
        hash,
        install_root_name,
    );
    if (builtin.os.tag == .windows) {
        try installWindowsIntegration(allocator, bundle_path, metadata);
    } else if (builtin.os.tag == .linux) {
        try installLinuxIntegration(
            allocator,
            bundle_path,
            metadata,
            linux_desktop_collision_policy,
        );
    } else {
        try installMacosUninstallManagerAtRoot(
            allocator,
            plan.channel_root,
            bundle_path,
            bundle_path,
            metadata,
        );
    }
}

fn launchAppliedUpdate(
    allocator: std.mem.Allocator,
    bundle_path: []const u8,
) !void {
    if (builtin.os.tag == .macos) {
        const argv = [_][]const u8{ "/usr/bin/open", bundle_path };
        _ = try std.process.spawn(g_io, .{
            .argv = &argv,
            .stdin = .ignore,
            .stdout = .ignore,
            .stderr = .ignore,
        });
        return;
    }

    const launcher_path = try applyUpdateLauncherPath(allocator, bundle_path);
    defer allocator.free(launcher_path);
    const working_dir = std.fs.path.dirname(launcher_path) orelse return error.InvalidUpdatePath;
    const argv = [_][]const u8{launcher_path};
    _ = try std.process.spawn(g_io, .{
        .argv = &argv,
        .cwd = .{ .path = working_dir },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .create_no_window = builtin.os.tag == .windows,
    });
}

fn rollbackAppliedUpdate(
    target_path: []const u8,
    previous_path: []const u8,
) !void {
    try removeRollbackApplyUpdateBundle(target_path);
    try renameCurrentApplyUpdateBundle(previous_path, target_path);
}

const ApplyUpdateCommit = struct {
    previous_path: []u8,

    fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.previous_path);
        self.* = undefined;
    }
};

const ApplyUpdateFailureRecovery = enum {
    none,
    wait_then_relaunch,
    relaunch,
};

fn applyUpdateFailureRecovery(
    phase: ApplyUpdatePhase,
    parent_exited: bool,
    update_error: anyerror,
) ApplyUpdateFailureRecovery {
    if (update_error == error.UpdateRollbackFailed or phase == .complete) return .none;
    if (parent_exited) return .relaunch;
    return switch (phase) {
        .validating, .extracting, .validating_payload => .wait_then_relaunch,
        .waiting_for_parent, .swapping, .integrating, .launching, .complete => .none,
    };
}

fn recoverApplyUpdateFailure(
    allocator: std.mem.Allocator,
    plan: ApplyUpdatePlan,
    phase: ApplyUpdatePhase,
    parent_exited: bool,
    update_error: anyerror,
) void {
    switch (applyUpdateFailureRecovery(phase, parent_exited, update_error)) {
        .none => return,
        .wait_then_relaunch => waitForApplyUpdateParent(plan.parent_pid) catch |wait_error| {
            std.debug.print(
                "Warning: Could not safely relaunch the previous application after update failure: {}\n",
                .{wait_error},
            );
            return;
        },
        .relaunch => {},
    }
    launchAppliedUpdate(allocator, plan.app_bundle_path) catch |launch_error| {
        std.debug.print(
            "Warning: Could not relaunch the previous application after update failure: {}\n",
            .{launch_error},
        );
    };
}

fn performApplyUpdateTransaction(
    allocator: std.mem.Allocator,
    plan: ApplyUpdatePlan,
    display_name: []const u8,
    install_root_name: []const u8,
    had_uninstall_manifest: bool,
    phase: *ApplyUpdatePhase,
    parent_exited: *bool,
) !ApplyUpdateCommit {
    const target_parent_path = std.fs.path.dirname(plan.app_bundle_path) orelse
        return error.InvalidUpdatePath;
    try requireResolvedApplyUpdatePath(allocator, target_parent_path);
    try requirePhysicalApplyUpdateChild(
        allocator,
        target_parent_path,
        plan.app_bundle_path,
        .directory,
    );

    const staging_path = try std.fmt.allocPrint(
        allocator,
        "{s}.update-{s}",
        .{ plan.app_bundle_path, plan.transaction_id },
    );
    defer allocator.free(staging_path);
    const previous_path = try std.fmt.allocPrint(
        allocator,
        "{s}.previous",
        .{plan.app_bundle_path},
    );
    errdefer allocator.free(previous_path);

    try removePlainApplyUpdateDirectoryIfPresent(staging_path);
    try std.Io.Dir.createDirAbsolute(g_io, staging_path, .default_dir);
    defer removePlainApplyUpdateDirectoryIfPresent(staging_path) catch {};

    phase.* = .extracting;
    try extractTarFileQuiet(plan.retained_tar_path, staging_path);
    const staged_bundle = try findSingleApplyUpdateBundle(allocator, staging_path);
    defer allocator.free(staged_bundle);

    if (builtin.os.tag != .windows) try fixExecutablePermissions(allocator, staged_bundle);
    if (builtin.os.tag == .linux) try fixCefSymlinks(allocator, staged_bundle);
    if (builtin.os.tag == .macos) removeQuarantine(allocator, staged_bundle) catch |err| {
        std.debug.print("Warning: Could not remove quarantine from staged update: {}\n", .{err});
    };
    phase.* = .validating_payload;
    const staged_display_name = try validateApplyUpdateBundleIdentity(
        allocator,
        staged_bundle,
        plan,
    );
    defer allocator.free(staged_display_name);
    const rollback_display_name = if (had_uninstall_manifest)
        display_name
    else
        staged_display_name;
    const linux_desktop_collision_policy: LinuxDesktopCollisionPolicy = if (had_uninstall_manifest)
        .preserve
    else
        .adopt_matching_legacy;

    phase.* = .waiting_for_parent;
    try waitForApplyUpdateParent(plan.parent_pid);
    parent_exited.* = true;

    var windows_lock: ?WindowsUninstallLock = null;
    defer if (builtin.os.tag == .windows) {
        if (windows_lock) |*lock| lock.release();
    };
    if (builtin.os.tag == .windows) {
        windows_lock = try acquireWindowsUninstallLock(allocator, plan.channel_root);
    }

    phase.* = .swapping;
    const target_exists = try extractionPathExists(plan.app_bundle_path);
    const previous_exists = try extractionPathExists(previous_path);
    if (!target_exists and previous_exists) {
        try requireApplyUpdateDirectory(previous_path);
        try renameCurrentApplyUpdateBundle(previous_path, plan.app_bundle_path);
    } else if (!target_exists) {
        return error.UpdateTargetMissing;
    }
    if (try extractionPathExists(previous_path)) {
        try removePlainApplyUpdateDirectoryIfPresent(previous_path);
    }
    try requirePhysicalApplyUpdateChild(
        allocator,
        target_parent_path,
        plan.app_bundle_path,
        .directory,
    );
    try renameCurrentApplyUpdateBundle(plan.app_bundle_path, previous_path);
    var rollback_armed = true;
    errdefer if (rollback_armed) {
        rollbackAppliedUpdate(plan.app_bundle_path, previous_path) catch |rollback_error| {
            std.debug.print("ERROR: Update rollback failed: {}\n", .{rollback_error});
        };
    };
    renameApplyUpdatePath(staged_bundle, plan.app_bundle_path) catch |err| {
        rollbackAppliedUpdate(plan.app_bundle_path, previous_path) catch |rollback_error| {
            std.debug.print("ERROR: Update rollback failed after swap error: {}\n", .{rollback_error});
            rollback_armed = false;
            return error.UpdateRollbackFailed;
        };
        rollback_armed = false;
        return err;
    };

    phase.* = .integrating;
    applyUpdatePlatformIntegration(
        allocator,
        plan.app_bundle_path,
        staged_display_name,
        plan,
        plan.hash,
        install_root_name,
        linux_desktop_collision_policy,
    ) catch |err| {
        rollbackAppliedUpdate(plan.app_bundle_path, previous_path) catch |rollback_error| {
            std.debug.print("ERROR: Update rollback failed after integration error: {}\n", .{rollback_error});
            rollback_armed = false;
            return error.UpdateRollbackFailed;
        };
        rollback_armed = false;
        applyUpdatePlatformIntegration(
            allocator,
            plan.app_bundle_path,
            rollback_display_name,
            plan,
            null,
            install_root_name,
            linux_desktop_collision_policy,
        ) catch |repair_error| {
            std.debug.print("Warning: Could not restore previous uninstall integration: {}\n", .{repair_error});
        };
        return err;
    };

    phase.* = .launching;
    launchAppliedUpdate(allocator, plan.app_bundle_path) catch |err| {
        rollbackAppliedUpdate(plan.app_bundle_path, previous_path) catch |rollback_error| {
            std.debug.print("ERROR: Update rollback failed after launch error: {}\n", .{rollback_error});
            rollback_armed = false;
            return error.UpdateRollbackFailed;
        };
        rollback_armed = false;
        applyUpdatePlatformIntegration(
            allocator,
            plan.app_bundle_path,
            rollback_display_name,
            plan,
            null,
            install_root_name,
            linux_desktop_collision_policy,
        ) catch |repair_error| {
            std.debug.print("Warning: Could not restore previous uninstall integration: {}\n", .{repair_error});
        };
        return err;
    };
    rollback_armed = false;
    return .{ .previous_path = previous_path };
}

fn publishApplyUpdateResult(
    allocator: std.mem.Allocator,
    plan: ApplyUpdatePlan,
    success: bool,
    phase: ApplyUpdatePhase,
    message: []const u8,
) !void {
    const result = ApplyUpdateResult{
        .transaction_id = plan.transaction_id,
        .success = success,
        .phase = @tagName(phase),
        .message = message,
        .identifier = plan.identifier,
        .channel = plan.channel,
        .version = plan.version,
        .hash = plan.hash,
    };
    const json = try std.json.Stringify.valueAlloc(
        allocator,
        result,
        .{ .whitespace = .indent_2 },
    );
    defer allocator.free(json);
    var atomic_file = try std.Io.Dir.cwd().createFileAtomic(g_io, plan.result_path, .{
        .replace = true,
    });
    defer atomic_file.deinit(g_io);
    var buffer: [4096]u8 = undefined;
    var writer = atomic_file.file.writer(g_io, &buffer);
    try writer.interface.writeAll(json);
    try writer.flush();
    try atomic_file.file.sync(g_io);
    try atomic_file.replace(g_io);
}

fn removeApplyUpdateWindowsTask(
    allocator: std.mem.Allocator,
    transaction_id: []const u8,
) void {
    if (builtin.os.tag != .windows) return;
    const task_name = applyUpdateTaskName(allocator, transaction_id) catch return;
    defer allocator.free(task_name);
    const schtasks_path = getWindowsSystemExecutablePath(allocator, "schtasks.exe") catch return;
    defer allocator.free(schtasks_path);
    const argv = [_][]const u8{ schtasks_path, "/Delete", "/TN", task_name, "/F" };
    _ = runWindowsCommand(&argv) catch {};
}

fn cleanupApplyUpdateHelper(allocator: std.mem.Allocator, helper_path: []const u8) void {
    if (builtin.os.tag == .windows) {
        // A running PE cannot delete itself. Reuse the short-lived deferred
        // cleanup worker used by the Windows uninstaller so the update helper
        // normally disappears as soon as this process exits instead of
        // accumulating in TEMP until the next reboot.
        scheduleTemporaryWorkerDeletion(allocator, helper_path) catch |err| {
            std.debug.print("Warning: Could not start update-helper cleanup: {}\n", .{err});
            const helper_path_w = std.unicode.wtf8ToWtf16LeAllocZ(allocator, helper_path) catch return;
            defer allocator.free(helper_path_w);
            if (windows_uninstall_sync.MoveFileExW(
                helper_path_w.ptr,
                null,
                windows_uninstall_sync.movefile_delay_until_reboot,
            ) == .FALSE) {
                std.debug.print("Warning: Could not schedule update-helper cleanup.\n", .{});
            }
        };
    } else {
        std.Io.Dir.cwd().deleteFile(g_io, helper_path) catch |err| {
            std.debug.print("Warning: Could not remove update helper: {}\n", .{err});
        };
    }
}

fn shouldInvalidateApplyUpdatePayload(phase: ApplyUpdatePhase) bool {
    return phase == .extracting or phase == .validating_payload;
}

fn isApplyUpdateHashTransientName(name: []const u8, hash: []const u8) bool {
    if (std.mem.startsWith(u8, name, hash)) {
        const suffix = name[hash.len..];
        if (std.mem.eql(u8, suffix, ".tar.previous")) return true;
        if (std.mem.startsWith(u8, suffix, ".tar.") and
            std.mem.endsWith(u8, suffix, ".partial"))
        {
            const transaction_id = suffix[".tar.".len .. suffix.len - ".partial".len];
            return isApplyUpdateTransactionId(transaction_id);
        }
    }
    if (name.len <= hash.len + 2 or name[0] != '.' or
        !std.mem.eql(u8, name[1 .. hash.len + 1], hash) or
        name[hash.len + 1] != '.') return false;
    const compressed_suffix = name[hash.len + 2 ..];
    if (compressed_suffix.len < APPLY_UPDATE_TRANSACTION_HEX_LENGTH) return false;
    const transaction_id = compressed_suffix[0..APPLY_UPDATE_TRANSACTION_HEX_LENGTH];
    if (!isApplyUpdateTransactionId(transaction_id)) return false;
    const transaction_suffix = compressed_suffix[APPLY_UPDATE_TRANSACTION_HEX_LENGTH..];
    return std.mem.eql(u8, transaction_suffix, ".tar.zst") or
        std.mem.eql(u8, transaction_suffix, ".tar.zst.partial");
}

fn isApplyUpdatePreparedStateName(name: []const u8) bool {
    return std.mem.eql(u8, name, APPLY_UPDATE_PREPARED_FILE) or
        std.mem.eql(u8, name, APPLY_UPDATE_PREPARED_FILE ++ ".previous") or
        (std.mem.startsWith(u8, name, APPLY_UPDATE_PREPARED_FILE ++ ".") and
            std.mem.endsWith(u8, name, ".partial"));
}

fn applyUpdatePreparedStateMatchesPlan(
    allocator: std.mem.Allocator,
    extraction_path: []const u8,
    name: []const u8,
    plan: ApplyUpdatePlan,
) bool {
    const path = std.fs.path.join(allocator, &.{ extraction_path, name }) catch return false;
    defer allocator.free(path);
    var file = std.Io.Dir.openFileAbsolute(g_io, path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    }) catch return false;
    defer file.close(g_io);
    prepareNoFollowFileForRead(&file);
    const stat = file.stat(g_io) catch return false;
    if (stat.kind != .file or stat.size > 64 * 1024) return false;
    var read_buffer: [4096]u8 = undefined;
    var reader = file.reader(g_io, &read_buffer);
    const contents = reader.interface.allocRemaining(allocator, .limited(64 * 1024)) catch
        return false;
    defer allocator.free(contents);
    const parsed = std.json.parseFromSlice(
        ApplyUpdatePreparedRecord,
        allocator,
        contents,
        .{ .ignore_unknown_fields = true },
    ) catch return false;
    defer parsed.deinit();
    return parsed.value.schema_version == 1 and
        std.mem.eql(u8, parsed.value.identifier, plan.identifier) and
        std.mem.eql(u8, parsed.value.channel, plan.channel) and
        std.mem.eql(u8, parsed.value.platform, plan.platform) and
        std.mem.eql(u8, parsed.value.arch, plan.arch) and
        std.mem.eql(u8, parsed.value.version, plan.version) and
        std.mem.eql(u8, parsed.value.hash, plan.hash) and
        std.mem.eql(u8, parsed.value.retained_tar_path, plan.retained_tar_path);
}

fn cleanupInvalidApplyUpdatePayloadState(
    allocator: std.mem.Allocator,
    plan: ApplyUpdatePlan,
    phase: ApplyUpdatePhase,
) !void {
    if (!shouldInvalidateApplyUpdatePayload(phase)) return;
    const extraction_path = std.fs.path.dirname(plan.retained_tar_path) orelse
        return error.InvalidUpdatePath;
    const retained_tar_name = std.fs.path.basename(plan.retained_tar_path);
    var extraction_dir = try std.Io.Dir.openDirAbsolute(g_io, extraction_path, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    defer extraction_dir.close(g_io);
    var iterator = extraction_dir.iterate();
    while (try iterator.next(g_io)) |entry| {
        if (entry.kind != .file) continue;
        const remove = std.mem.eql(u8, entry.name, retained_tar_name) or
            isApplyUpdateHashTransientName(entry.name, plan.hash) or
            (isApplyUpdatePreparedStateName(entry.name) and
                applyUpdatePreparedStateMatchesPlan(allocator, extraction_path, entry.name, plan));
        if (!remove) continue;
        extraction_dir.deleteFile(g_io, entry.name) catch |err| {
            std.debug.print("Warning: Could not invalidate failed update state {s}: {}\n", .{
                entry.name,
                err,
            });
        };
    }
}

fn shouldRemoveCommittedUpdateState(name: []const u8, retained_tar_name: []const u8) bool {
    if (std.mem.eql(u8, name, retained_tar_name)) return false;
    if (std.mem.eql(u8, name, APPLY_UPDATE_PREPARED_FILE) or
        std.mem.startsWith(u8, name, APPLY_UPDATE_PREPARED_FILE ++ ".")) return true;
    return std.mem.endsWith(u8, name, ".tar") or
        std.mem.endsWith(u8, name, ".tar.previous") or
        std.mem.endsWith(u8, name, ".tar.zst") or
        std.mem.endsWith(u8, name, ".partial");
}

fn cleanupCommittedApplyUpdateState(
    allocator: std.mem.Allocator,
    plan: ApplyUpdatePlan,
) !void {
    const extraction_path = std.fs.path.dirname(plan.retained_tar_path) orelse
        return error.InvalidUpdatePath;
    const retained_tar_name = std.fs.path.basename(plan.retained_tar_path);
    var extraction_dir = try std.Io.Dir.openDirAbsolute(g_io, extraction_path, .{
        .follow_symlinks = false,
        .iterate = true,
    });
    defer extraction_dir.close(g_io);
    var iterator = extraction_dir.iterate();
    while (try iterator.next(g_io)) |entry| {
        if (!shouldRemoveCommittedUpdateState(entry.name, retained_tar_name)) continue;
        if (entry.kind != .file) {
            std.debug.print(
                "Warning: Refusing to remove non-file update state: {s}\n",
                .{entry.name},
            );
            continue;
        }
        extraction_dir.deleteFile(g_io, entry.name) catch |err| {
            std.debug.print("Warning: Could not remove stale update state {s}: {}\n", .{
                entry.name,
                err,
            });
        };
    }
    _ = allocator;
}

fn runApplyUpdateManager(
    allocator: std.mem.Allocator,
    plan_path: []const u8,
) !void {
    var document = try loadApplyUpdatePlan(allocator, plan_path);
    defer document.deinit(allocator);
    const plan = document.parsed.value;
    var phase: ApplyUpdatePhase = .validating;
    var parent_exited = false;
    var validation_progress: ApplyUpdateValidationProgress = .{};
    var context = validateApplyUpdatePlanAndPaths(
        allocator,
        plan_path,
        plan,
        &validation_progress,
    ) catch |err| {
        const helper_path = validateApplyUpdateHelper(
            allocator,
            plan.transaction_id,
        ) catch return err;
        defer allocator.free(helper_path);
        const actions = applyUpdateValidationFailureActions(true, validation_progress);
        if (actions.cleanup_transport) {
            removeApplyUpdateWindowsTask(allocator, plan.transaction_id);
            defer cleanupApplyUpdateHelper(allocator, helper_path);
        }
        if (actions.publish_result) {
            publishApplyUpdateResult(
                allocator,
                plan,
                false,
                phase,
                @errorName(err),
            ) catch |result_error| {
                std.debug.print(
                    "ERROR: Could not publish update validation failure result: {}\n",
                    .{result_error},
                );
            };
        }
        if (actions.cleanup_plan) {
            std.Io.Dir.cwd().deleteFile(g_io, plan_path) catch |cleanup_error| {
                std.debug.print(
                    "Warning: Could not remove rejected update plan: {}\n",
                    .{cleanup_error},
                );
            };
        }
        validateApplyUpdateRecoveryTarget(allocator, plan) catch |recovery_validation_error| {
            std.debug.print(
                "Warning: Refusing to relaunch an unvalidated update target: {}\n",
                .{recovery_validation_error},
            );
            return err;
        };
        recoverApplyUpdateFailure(allocator, plan, phase, parent_exited, err);
        return err;
    };
    defer context.deinit(allocator);
    defer {
        removeApplyUpdateWindowsTask(allocator, plan.transaction_id);
        std.Io.Dir.cwd().deleteFile(g_io, plan_path) catch {};
    }

    const helper_path = validateApplyUpdateHelper(allocator, plan.transaction_id) catch |err| {
        publishApplyUpdateResult(allocator, plan, false, phase, @errorName(err)) catch {};
        cleanupInvalidApplyUpdatePayloadState(allocator, plan, phase) catch {};
        recoverApplyUpdateFailure(allocator, plan, phase, parent_exited, err);
        return err;
    };
    defer allocator.free(helper_path);
    defer cleanupApplyUpdateHelper(allocator, helper_path);

    var commit = performApplyUpdateTransaction(
        allocator,
        plan,
        context.display_name,
        context.install_root_name,
        context.had_uninstall_manifest,
        &phase,
        &parent_exited,
    ) catch |err| {
        publishApplyUpdateResult(allocator, plan, false, phase, @errorName(err)) catch |result_error| {
            std.debug.print("ERROR: Could not publish update failure result: {}\n", .{result_error});
        };
        cleanupInvalidApplyUpdatePayloadState(allocator, plan, phase) catch |cleanup_error| {
            std.debug.print("Warning: Could not invalidate failed update payload: {}\n", .{cleanup_error});
        };
        recoverApplyUpdateFailure(allocator, plan, phase, parent_exited, err);
        return err;
    };
    defer commit.deinit(allocator);

    phase = .complete;
    try publishApplyUpdateResult(allocator, plan, true, phase, "Update applied successfully.");
    cleanupCommittedApplyUpdateState(allocator, plan) catch |err| {
        std.debug.print("Warning: Could not clean stale committed update state: {}\n", .{err});
    };
    removePlainApplyUpdateDirectoryIfPresent(commit.previous_path) catch |err| {
        std.debug.print("Warning: Could not remove previous application after update: {}\n", .{err});
    };
}

/// Electrobun v1 updaters replace only the application bundle. The first v2
/// launcher therefore asks the archive-free manager bundled in that new app to
/// create the v2 standalone manager, manifest, and platform integration in the
/// preserved physical v1 root. The explicit root argument is independently
/// bound to the manager's installed location before any mutation.
fn bootstrapTrace(message: []const u8) void {
    g_bootstrap_stage = message;
    if (g_bootstrap_trace_enabled) {
        std.debug.print("Bootstrap trace: {s}\n", .{message});
    }
}

fn reportBootstrapFailure(err: anyerror) void {
    std.debug.print(
        "Bootstrap install failed during {s}: {s}\n",
        .{ g_bootstrap_stage, @errorName(err) },
    );
}

fn bootstrapWindowsInstall(
    allocator: std.mem.Allocator,
    requested_channel_root: []const u8,
) !void {
    bootstrapTrace("windows: resolve executable");
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    bootstrapTrace("windows: locate bundled invocation");
    var invocation = try locateWindowsManagerInvocation(allocator, executable_path, true);
    defer invocation.deinit(allocator);
    bootstrapTrace("windows: validate requested root");
    if (!invocation.bundled or
        !std.fs.path.isAbsolute(requested_channel_root) or
        !try windowsPathsEqual(allocator, requested_channel_root, invocation.base_dir))
    {
        return error.InvalidUninstallLocation;
    }

    bootstrapTrace("windows: locate version metadata");
    const app_dir = try std.fs.path.join(allocator, &.{ invocation.base_dir, "app" });
    defer allocator.free(app_dir);
    const version_path = try std.fs.path.join(
        allocator,
        &.{ app_dir, "Resources", "version.json" },
    );
    defer allocator.free(version_path);
    bootstrapTrace("windows: read version metadata");
    var metadata = try readBootstrapMetadata(allocator, version_path);
    defer metadata.deinit(allocator);
    bootstrapTrace("windows: install integration");
    try installWindowsIntegration(
        allocator,
        app_dir,
        metadata.appMetadata(std.fs.path.basename(invocation.base_dir)),
    );
    bootstrapTrace("windows: complete");
}

fn bootstrapLinuxInstall(
    allocator: std.mem.Allocator,
    invocation_path: []const u8,
    requested_channel_root: []const u8,
) !void {
    bootstrapTrace("linux: validate bundled manager");
    try validateRunningLinuxManager(allocator, invocation_path);
    const resources_dir = std.fs.path.dirname(invocation_path) orelse
        return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(resources_dir), "Resources")) {
        return error.InvalidUninstallLocation;
    }
    const app_dir = std.fs.path.dirname(resources_dir) orelse return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(app_dir), "app")) {
        return error.InvalidUninstallLocation;
    }
    const channel_root = std.fs.path.dirname(app_dir) orelse return error.InvalidUninstallLocation;
    bootstrapTrace("linux: validate requested root");
    const requested_resolved = try std.fs.path.resolve(allocator, &.{requested_channel_root});
    defer allocator.free(requested_resolved);
    if (!std.fs.path.isAbsolute(requested_channel_root) or
        !std.mem.eql(u8, requested_resolved, requested_channel_root) or
        !std.mem.eql(u8, requested_channel_root, channel_root))
    {
        return error.InvalidUninstallLocation;
    }

    bootstrapTrace("linux: read version metadata");
    const version_path = try std.fs.path.join(allocator, &.{ resources_dir, "version.json" });
    defer allocator.free(version_path);
    var metadata = try readBootstrapMetadata(allocator, version_path);
    defer metadata.deinit(allocator);
    bootstrapTrace("linux: install integration");
    try installLinuxIntegration(
        allocator,
        app_dir,
        metadata.appMetadata(std.fs.path.basename(channel_root)),
        .adopt_matching_legacy,
    );
    bootstrapTrace("linux: complete");
}

fn bootstrapMacosInstall(
    allocator: std.mem.Allocator,
    requested_channel_root: []const u8,
) !void {
    bootstrapTrace("macos: validate bundled manager");
    const executable_path = try std.process.executablePathAlloc(g_io, allocator);
    defer allocator.free(executable_path);
    if (!std.mem.eql(u8, std.fs.path.basename(executable_path), MACOS_UNINSTALL_EXE_NAME)) {
        return error.InvalidUninstallLocation;
    }
    var executable_file = try std.Io.Dir.openFileAbsolute(g_io, executable_path, .{
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer executable_file.close(g_io);
    if ((try executable_file.stat(g_io)).kind != .file) return error.InvalidUninstallLocation;
    const executable_physical = try std.Io.Dir.realPathFileAbsoluteAlloc(
        g_io,
        executable_path,
        allocator,
    );
    defer allocator.free(executable_physical);
    if (!std.mem.eql(u8, executable_path, executable_physical)) {
        return error.InvalidUninstallLocation;
    }

    const resources_dir = std.fs.path.dirname(executable_path) orelse
        return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(resources_dir), "Resources")) {
        return error.InvalidUninstallLocation;
    }
    const contents_dir = std.fs.path.dirname(resources_dir) orelse
        return error.InvalidUninstallLocation;
    if (!std.mem.eql(u8, std.fs.path.basename(contents_dir), "Contents")) {
        return error.InvalidUninstallLocation;
    }
    const app_bundle_path = std.fs.path.dirname(contents_dir) orelse
        return error.InvalidUninstallLocation;
    if (!std.mem.endsWith(u8, std.fs.path.basename(app_bundle_path), ".app")) {
        return error.InvalidUninstallLocation;
    }
    bootstrapTrace("macos: validate requested root");
    const requested_resolved = try std.fs.path.resolve(allocator, &.{requested_channel_root});
    defer allocator.free(requested_resolved);
    if (!std.fs.path.isAbsolute(requested_channel_root) or
        !std.mem.eql(u8, requested_resolved, requested_channel_root))
    {
        return error.InvalidUninstallLocation;
    }

    bootstrapTrace("macos: read version metadata");
    const version_path = try std.fs.path.join(allocator, &.{ resources_dir, "version.json" });
    defer allocator.free(version_path);
    var metadata = try readBootstrapMetadata(allocator, version_path);
    defer metadata.deinit(allocator);
    bootstrapTrace("macos: install integration");
    try installMacosUninstallManagerAtRoot(
        allocator,
        requested_channel_root,
        app_bundle_path,
        app_bundle_path,
        metadata.appMetadata(std.fs.path.basename(requested_channel_root)),
    );
    bootstrapTrace("macos: complete");
}

pub fn main(init: std.process.Init) !void {
    g_io = init.io;
    g_environ_map = init.environ_map;
    g_bootstrap_trace_enabled = g_environ_map.get("ELECTROBUN_BOOTSTRAP_TRACE") != null;

    const allocator = init.gpa;

    // The update helper is always a unique temporary copy of the installed
    // manager. Dispatch it before preview or normal uninstall-manager modes.
    {
        var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
        defer args.deinit();
        _ = args.next() orelse return error.InvalidArguments;
        if (args.next()) |first_arg| {
            if (std.mem.eql(u8, first_arg, "--apply-update")) {
                const plan_path = args.next() orelse return error.InvalidArguments;
                const quiet = args.next() orelse return error.InvalidArguments;
                if (!std.mem.eql(u8, quiet, "--quiet") or args.next() != null) {
                    return error.InvalidArguments;
                }
                try runApplyUpdateManager(allocator, plan_path);
                return;
            }
        }
    }

    // Hidden manual QA entrypoint. It exercises the real platform adapters but
    // returns before manager parsing, payload discovery, or any install state.
    if (g_environ_map.get("ELECTROBUN_INSTALLER_UI_PREVIEW")) |mode| {
        try runInstallerUiPreview(allocator, mode);
        return;
    }

    // Installed uninstallers are copies of this extractor. Dispatch management
    // modes before attempting to discover or extract an installer payload.
    if (builtin.os.tag == .windows) {
        const executable_path = try std.process.executablePathAlloc(g_io, allocator);
        defer allocator.free(executable_path);
        var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
        defer args.deinit();
        _ = args.next() orelse return error.InvalidArguments;
        var manager_args: std.ArrayList([]const u8) = .empty;
        defer manager_args.deinit(allocator);
        while (args.next()) |arg| try manager_args.append(allocator, arg);
        const installed_manager = std.ascii.eqlIgnoreCase(
            std.fs.path.basename(executable_path),
            WINDOWS_UNINSTALL_EXE_NAME,
        );
        if (manager_args.items.len != 0 or installed_manager) {
            const command = try parseWindowsManagerCommand(manager_args.items);
            switch (command) {
                .uninstall => |mode| try uninstallWindows(allocator, mode),
                .bootstrap_install => |channel_root| bootstrapWindowsInstall(
                    allocator,
                    channel_root,
                ) catch |err| {
                    reportBootstrapFailure(err);
                    return err;
                },
                .refresh_registration => try refreshWindowsUninstallRegistration(allocator),
                .refresh_registration_from_update => |channel_root| try refreshWindowsUninstallRegistrationFromUpdate(
                    allocator,
                    channel_root,
                ),
                .cleanup_uninstaller => |cleanup| try cleanupWindowsUninstaller(
                    allocator,
                    cleanup.original_uninstaller,
                    cleanup.manifest_path,
                    cleanup.install_nonce,
                    cleanup.delete_data,
                ),
            }
            return;
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
                .bootstrap_install => |channel_root| bootstrapLinuxInstall(
                    allocator,
                    invocation_path,
                    channel_root,
                ) catch |err| {
                    reportBootstrapFailure(err);
                    return err;
                },
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
                .bootstrap_install => |channel_root| bootstrapMacosInstall(
                    allocator,
                    channel_root,
                ) catch |err| {
                    reportBootstrapFailure(err);
                    return err;
                },
                .refresh_metadata => try refreshMacosUninstallMetadata(allocator),
            }
            return;
        }
    }

    std.debug.print("Self-extractor v1.3 starting...\n", .{});
    var startTime = std.Io.Clock.now(.awake, g_io);

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched

    var exePathBuffer: [1024]u8 = undefined;
    const exe_dir_len = try std.process.executableDirPath(g_io, exePathBuffer[0..]);
    const APPBUNDLE_MACOS_PATH = exePathBuffer[0..exe_dir_len];

    // Platform-specific extraction
    if (builtin.os.tag == .windows or builtin.os.tag == .linux) {
        // Windows and Linux ONLY use self-extraction with magic bytes
        const extracted = extractFromSelf(allocator) catch |err| {
            presentGenericInstallerFailure(
                allocator,
                "The installer package is invalid or could not be read. Download it again and retry.",
            );
            return err;
        };
        if (!extracted) {
            std.debug.print("ERROR: Not a valid self-extracting installer\n", .{});
            presentGenericInstallerFailure(
                allocator,
                "The installer package is incomplete. Download it again and keep its .installer folder beside Setup.",
            );
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
        presentGenericInstallerFailure(
            allocator,
            "The installer package is incomplete. Download it again and retry.",
        );
        return err;
    };
    defer allocator.free(metadataJsonContents);

    const metadataParsed = std.json.parseFromSlice(struct {
        identifier: []const u8,
        name: []const u8,
        channel: []const u8,
        hash: []const u8,
    }, allocator, metadataJsonContents, .{ .ignore_unknown_fields = true }) catch |err| {
        presentGenericInstallerFailure(
            allocator,
            "The installer metadata is invalid. Download the package again and retry.",
        );
        return err;
    };
    defer metadataParsed.deinit();

    if (!isSafeMacosComponent(metadataParsed.value.identifier) or
        !isBuildChannel(metadataParsed.value.channel) or
        !isSafeMacosDisplayName(metadataParsed.value.name))
    {
        presentGenericInstallerFailure(
            allocator,
            "The installer metadata is invalid. Download the package again and retry.",
        );
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

    const macos_metadata = AppMetadata{
        .identifier = identifierName,
        .name = appDisplayName,
        .channel = channelName,
        .hash = hashName,
    };
    var macos_progress = ProgressIndicator.init(allocator, macos_metadata);
    defer macos_progress.deinit();
    errdefer macos_progress.complete(false, "The application could not be installed.");

    const home_dir = try getEnvOwned(allocator, "HOME");
    defer allocator.free(home_dir);

    // Resolve and pin the managed channel root before reading or extracting
    // payload bytes. This rejects pre-existing symlinked path components
    // before any recursive installer cleanup can begin.
    var install_channel_dir = try ensureMacosInstallRoot(home_dir, identifierName, channelName);
    defer install_channel_dir.close(g_io);

    const appBundleResourcesPath = try std.fs.path.resolve(allocator, &.{ APPBUNDLE_MACOS_PATH, BUNLE_RESOURCES_REL_PATH });
    defer allocator.free(appBundleResourcesPath);

    const compressedBundleFileName = try std.fmt.allocPrint(allocator, "{s}.tar.zst", .{hashName});
    defer allocator.free(compressedBundleFileName);

    std.debug.print("compressedBundleFileName: {s}\n", .{compressedBundleFileName});

    const compressedTarballPath = try std.fs.path.join(allocator, &.{ appBundleResourcesPath, compressedBundleFileName });
    defer allocator.free(compressedTarballPath);

    const SELF_EXTRACTION_PATH = try prepareMacosSelfExtractionRoot(
        allocator,
        home_dir,
        identifierName,
        channelName,
    );
    defer allocator.free(SELF_EXTRACTION_PATH);
    const SELF_EXTRACTION_STAGING_PATH = try std.fmt.allocPrint(allocator, "{s}.partial", .{SELF_EXTRACTION_PATH});
    defer allocator.free(SELF_EXTRACTION_STAGING_PATH);
    var extraction_state_published = false;
    defer if (!extraction_state_published) {
        std.Io.Dir.cwd().deleteTree(g_io, SELF_EXTRACTION_STAGING_PATH) catch {};
    };

    // compressedTarballPath replace extension
    // remove the .zst extension from filename.tar.zst
    const tarFileName = std.fs.path.stem(compressedTarballPath);

    const tarPath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_STAGING_PATH, tarFileName });
    defer allocator.free(tarPath);
    std.debug.print("tarPath: {s}\n", .{tarPath});
    try streamZstdToTar(allocator, compressedTarballPath, tarPath, &macos_progress);

    const decompress_done = std.Io.Clock.now(.awake, g_io);
    std.debug.print("Time taken to decompress: {} ns\n", .{startTime.durationTo(decompress_done).toNanoseconds()});

    startTime = decompress_done;

    try extractTarFile(tarPath, SELF_EXTRACTION_STAGING_PATH, &macos_progress);

    const untar_done = std.Io.Clock.now(.awake, g_io);
    std.debug.print("Time taken to untar: {} ns\n", .{startTime.durationTo(untar_done).toNanoseconds()});

    const bundleBaseName = if (isStableChannel(channelName))
        appDisplayName
    else
        try std.fmt.allocPrint(allocator, "{s}-{s}", .{ appDisplayName, channelName });
    defer if (!isStableChannel(channelName)) allocator.free(bundleBaseName);

    const bundleFileName = try std.fmt.allocPrint(allocator, "{s}.app", .{bundleBaseName});
    defer allocator.free(bundleFileName);

    std.debug.print("bundleFileName: {s}\n", .{bundleFileName});
    // Note: the name of the application or bundle may change between builds. By switching distribution channels
    // and/or by the app developer deciding to rename it.
    // todo: consider having a metadata file for the final bundle name and having all the names in this directory consistent
    // const iterableDir = try std.fs.openIterableDirAbsolute(SELF_EXTRACTION_STAGING_PATH, .{});
    // var extractionFolderWalker = try iterableDir.walk(allocator);
    // defer extractionFolderWalker.deinit();

    // while (try extractionFolderWalker.next()) |entry| {
    //     const entryName = entry.basename;
    //     if (std.mem.eql(u8, std.fs.path.extension(entryName), ".app")) {
    const newBundlePath = try std.fs.path.join(allocator, &.{ SELF_EXTRACTION_STAGING_PATH, bundleFileName });
    defer allocator.free(newBundlePath);

    // todo
    // rename the tar file to its hash so we can update it later
    // const hash = "";

    // todo: get the basename of the newBundlePath and join a new path with it
    // in case the name changed.

    // Validate the replacement before moving the running outer bundle aside.
    // installMacosUninstallManager performs the same identity validation when
    // integration is committed, but doing it here keeps malformed payloads out
    // of the app/state transaction entirely.
    var staged_identity = try readAndValidateInstalledMacosIdentity(
        allocator,
        newBundlePath,
        identifierName,
        channelName,
    );
    defer staged_identity.deinit(allocator);

    // Keep at most one previous outer app bundle until the matching retained
    // updater state has been published. A normal publication error therefore
    // restores both the previous bundle and the previous self-extraction tree.
    const previousBundlePath = try std.fmt.allocPrint(allocator, "{s}.previous", .{APPBUNDLE_PATH});
    defer allocator.free(previousBundlePath);

    var current_bundle_exists = try extractionPathExists(APPBUNDLE_PATH);
    if (!current_bundle_exists and try extractionPathExists(previousBundlePath)) {
        try requirePlainDirectory(previousBundlePath);
        try std.Io.Dir.renameAbsolute(previousBundlePath, APPBUNDLE_PATH, g_io);
        current_bundle_exists = true;
    }
    if (current_bundle_exists) try requirePlainDirectory(APPBUNDLE_PATH);
    if (try extractionPathExists(previousBundlePath)) {
        try requirePlainDirectory(previousBundlePath);
        try std.Io.Dir.cwd().deleteTree(g_io, previousBundlePath);
    }

    const had_previous_bundle = current_bundle_exists;
    var bundle_rollback_armed = false;
    defer if (bundle_rollback_armed) {
        std.Io.Dir.cwd().deleteTree(g_io, APPBUNDLE_PATH) catch |err| {
            std.debug.print("WARNING: Failed to remove incomplete macOS app during rollback: {}\n", .{err});
        };
        if (had_previous_bundle) {
            std.Io.Dir.renameAbsolute(previousBundlePath, APPBUNDLE_PATH, g_io) catch |err| {
                std.debug.print("ERROR: Failed to restore previous macOS app during rollback: {}\n", .{err});
            };
        }
    };

    macos_progress.update(.installing_files, null, null);
    if (had_previous_bundle) {
        try std.Io.Dir.renameAbsolute(APPBUNDLE_PATH, previousBundlePath, g_io);
    }
    bundle_rollback_armed = true;
    try std.Io.Dir.renameAbsolute(newBundlePath, APPBUNDLE_PATH, g_io);
    try publishExtractionState(allocator, SELF_EXTRACTION_STAGING_PATH, SELF_EXTRACTION_PATH);
    extraction_state_published = true;
    bundle_rollback_armed = false;
    if (had_previous_bundle) {
        std.Io.Dir.cwd().deleteTree(g_io, previousBundlePath) catch |err| {
            std.debug.print("WARNING: Failed to remove previous macOS app after commit: {}\n", .{err});
        };
    }

    macos_progress.update(.integrating, null, null);
    try installMacosUninstallManager(allocator, APPBUNDLE_PATH, APPBUNDLE_PATH, .{
        .identifier = identifierName,
        .name = appDisplayName,
        .channel = channelName,
        .hash = hashName,
    });

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
        macos_progress.complete(false, "The application was installed, but it could not be launched.");
        return;
    };

    macos_progress.complete(true, "The application was installed successfully.");
    return;

    //     }
    // } else |_| {
    //     // no compressed file found, assume we're the full app bundle and launch the electrobun app

    //     std.debug.print("No compressed bundle found: \n", .{});
    // }
}

fn isStableChannel(channel: []const u8) bool {
    return std.mem.eql(u8, channel, "stable");
}

fn extractedBundleName(
    allocator: std.mem.Allocator,
    app_name: []const u8,
    channel: []const u8,
) ![]u8 {
    const sanitized_name = try std.mem.replaceOwned(u8, allocator, app_name, " ", "");
    if (isStableChannel(channel)) return sanitized_name;
    defer allocator.free(sanitized_name);
    return std.fmt.allocPrint(allocator, "{s}-{s}", .{ sanitized_name, channel });
}

test "embedded metadata discovery skips compiler marker pairs" {
    const metadata =
        \\{"identifier":"com.example.app","name":"Example","channel":"stable","hash":"abc"}
    ;
    const fixture =
        "extractor bytes" ++
        METADATA_MARKER ++ "not embedded metadata" ++ ARCHIVE_MARKER ++
        "more extractor bytes" ++
        METADATA_MARKER ++ metadata ++ ARCHIVE_MARKER ++
        "compressed payload";

    const embedded = (try findEmbeddedMetadata(std.testing.allocator, fixture)) orelse
        return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings(metadata, embedded.metadata);
    try std.testing.expectEqual(
        std.mem.indexOf(u8, fixture, ARCHIVE_MARKER ++ "compressed payload").?,
        embedded.archive_offset,
    );
}

test "first-v2-launch bootstrap metadata uses the developer display name" {
    var metadata = try parseBootstrapMetadata(std.testing.allocator,
        \\{
        \\  "version": "2.0.0-canary.1",
        \\  "identifier": "com.example.archive",
        \\  "channel": "stable",
        \\  "name": "ArchiveApp-stable",
        \\  "displayName": "Archive App",
        \\  "hash": "abc123"
        \\}
    );
    defer metadata.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("com.example.archive", metadata.identifier);
    try std.testing.expectEqualStrings("stable", metadata.channel);
    try std.testing.expectEqualStrings("Archive App", metadata.name);
    try std.testing.expectEqualStrings("abc123", metadata.hash.?);
    try std.testing.expectEqualStrings(
        "stable",
        metadata.appMetadata("stable").install_root_name.?,
    );

    var legacy_display = try parseBootstrapMetadata(std.testing.allocator,
        \\{"version":"2.0.0","identifier":"com.example.archive","channel":"stable","name":"Archive App"}
    );
    defer legacy_display.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("Archive App", legacy_display.name);

    try std.testing.expectError(
        error.InvalidInstalledIdentity,
        parseBootstrapMetadata(std.testing.allocator,
            \\{"version":"","identifier":"com.example.archive","channel":"stable","name":"Archive App"}
        ),
    );
    try std.testing.expectError(
        error.InvalidInstalledIdentity,
        parseBootstrapMetadata(std.testing.allocator,
            \\{"version":"2.0.0","identifier":"../other","channel":"stable","name":"Archive App"}
        ),
    );
    try std.testing.expectError(
        error.InvalidInstalledIdentity,
        parseBootstrapMetadata(std.testing.allocator,
            \\{"version":"2.0.0","identifier":"com.example.archive","channel":"production","name":"Archive App"}
        ),
    );
}

test "Windows integration names and registry keys are channel scoped" {
    const stable_display = try windowsDisplayName(std.testing.allocator, "Archive App", "stable");
    defer std.testing.allocator.free(stable_display);
    try std.testing.expectEqualStrings("Archive App", stable_display);

    const canary_display = try windowsDisplayName(std.testing.allocator, "Archive App", "canary");
    defer std.testing.allocator.free(canary_display);
    try std.testing.expectEqualStrings("Archive App (Canary)", canary_display);

    const stable_shortcut = try windowsShortcutFileName(std.testing.allocator, "Archive: App", "stable");
    defer std.testing.allocator.free(stable_shortcut);
    try std.testing.expectEqualStrings("Archive_ App.lnk", stable_shortcut);

    const canary_shortcut = try windowsShortcutFileName(std.testing.allocator, "Archive: App", "canary");
    defer std.testing.allocator.free(canary_shortcut);
    try std.testing.expectEqualStrings("Archive_ App (Canary).lnk", canary_shortcut);
    try std.testing.expect(!std.mem.eql(u8, stable_shortcut, canary_shortcut));

    const stable_key = try windowsUninstallRegistryKey(std.testing.allocator, "com.example.archive", "stable");
    defer std.testing.allocator.free(stable_key);
    try std.testing.expectEqualStrings(
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.example.archive.stable",
        stable_key,
    );
    const canary_key = try windowsUninstallRegistryKey(std.testing.allocator, "com.example.archive", "canary");
    defer std.testing.allocator.free(canary_key);
    try std.testing.expectEqualStrings(
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.example.archive.canary",
        canary_key,
    );
}

test "Windows uninstall manager accepts only the unified ordered grammar" {
    const direct = try parseWindowsManagerCommand(&.{});
    try std.testing.expect(direct == .uninstall);
    try std.testing.expect(direct.uninstall == null);

    const delegated = try parseWindowsManagerCommand(&.{"--uninstall"});
    try std.testing.expect(delegated == .uninstall);
    try std.testing.expect(delegated.uninstall == null);
    try std.testing.expectEqual(
        WindowsUninstallMode.app,
        (try parseWindowsManagerCommand(&.{"--quiet"})).uninstall.?,
    );
    try std.testing.expectEqual(
        WindowsUninstallMode.app,
        (try parseWindowsManagerCommand(&.{ "--uninstall", "--quiet" })).uninstall.?,
    );
    try std.testing.expectEqual(
        WindowsUninstallMode.app_and_data,
        (try parseWindowsManagerCommand(&.{ "--quiet", "--delete-data" })).uninstall.?,
    );
    try std.testing.expectEqual(
        WindowsUninstallMode.app_and_data,
        (try parseWindowsManagerCommand(&.{ "--uninstall", "--quiet", "--delete-data" })).uninstall.?,
    );
    try std.testing.expect((try parseWindowsManagerCommand(&.{"--refresh-registration"})) == .refresh_registration);
    try std.testing.expect((try parseWindowsManagerCommand(&.{ "--refresh-registration", "--quiet" })) == .refresh_registration);
    const bootstrap = try parseWindowsManagerCommand(&.{
        "--bootstrap-install",
        "C:\\Users\\example\\AppData\\Local\\com.example.app\\stable",
        "--quiet",
    });
    try std.testing.expect(bootstrap == .bootstrap_install);
    try std.testing.expectEqualStrings(
        "C:\\Users\\example\\AppData\\Local\\com.example.app\\stable",
        bootstrap.bootstrap_install,
    );
    const update_refresh = try parseWindowsManagerCommand(&.{
        "--refresh-registration-from-update",
        "C:\\Users\\example\\AppData\\Local\\com.example.app\\stable",
        "--quiet",
    });
    try std.testing.expect(update_refresh == .refresh_registration_from_update);
    try std.testing.expectEqualStrings(
        "C:\\Users\\example\\AppData\\Local\\com.example.app\\stable",
        update_refresh.refresh_registration_from_update,
    );
    const worker = try parseWindowsManagerCommand(&.{
        "--cleanup-uninstaller",
        "C:\\managed\\uninstall.exe",
        "C:\\managed\\.electrobun-uninstall.json",
        "0123456789abcdef0123456789abcdef",
        "--delete-data",
    });
    try std.testing.expect(worker == .cleanup_uninstaller);
    try std.testing.expect(worker.cleanup_uninstaller.delete_data);

    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{"--delete-data"}));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--uninstall", "--delete-data" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--delete-data", "--quiet" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--quiet", "--uninstall" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--quiet", "--quiet" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--uninstall", "--quiet", "--quiet" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--refresh-registration", "--delete-data" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--bootstrap-install", "C:\\managed" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--bootstrap-install", "--quiet", "C:\\managed" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--bootstrap-install", "", "--quiet" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{"--refresh-registration-from-update"}));
    try std.testing.expectError(
        error.InvalidArguments,
        parseWindowsManagerCommand(&.{ "--refresh-registration-from-update", "C:\\managed", "--delete-data" }),
    );
    try std.testing.expectError(
        error.InvalidArguments,
        parseWindowsManagerCommand(&.{ "--refresh-registration-from-update", "--quiet", "C:\\managed" }),
    );
    try std.testing.expectError(
        error.InvalidArguments,
        parseWindowsManagerCommand(&.{ "--refresh-registration-from-update", "", "--quiet" }),
    );
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{ "--cleanup-uninstaller", "one", "two" }));
    try std.testing.expectError(error.InvalidArguments, parseWindowsManagerCommand(&.{"--other"}));
}

test "Windows staged update refresh names require 32 lowercase hex digits" {
    try std.testing.expect(isValidWindowsUpdateRefreshStageName(
        "electrobun-uninstall-refresh-0123456789abcdef0123456789abcdef.exe",
    ));
    try std.testing.expect(!isValidWindowsUpdateRefreshStageName(
        "electrobun-uninstall-refresh-0123456789ABCDEF0123456789abcdef.exe",
    ));
    try std.testing.expect(!isValidWindowsUpdateRefreshStageName(
        "electrobun-uninstall-refresh-0123456789abcdef0123456789abcdeg.exe",
    ));
    try std.testing.expect(!isValidWindowsUpdateRefreshStageName(
        "electrobun-uninstall-refresh-0123456789abcdef0123456789abcde.exe",
    ));
    try std.testing.expect(!isValidWindowsUpdateRefreshStageName(
        "electrobun-uninstall-refresh-0123456789abcdef0123456789abcdef",
    ));
    try std.testing.expect(!isValidWindowsUpdateRefreshStageName(
        "other-0123456789abcdef0123456789abcdef.exe",
    ));
}

test "Windows uninstall data policy accepts legacy manifests and only version 1" {
    try validateWindowsDataPathVersions(null);
    try validateWindowsDataPathVersions(&.{WINDOWS_DATA_PATH_VERSION});
    try std.testing.expectError(error.InvalidUninstallManifest, validateWindowsDataPathVersions(&.{}));
    try std.testing.expectError(error.InvalidUninstallManifest, validateWindowsDataPathVersions(&.{2}));
    try std.testing.expectError(
        error.InvalidUninstallManifest,
        validateWindowsDataPathVersions(&.{ WINDOWS_DATA_PATH_VERSION, WINDOWS_DATA_PATH_VERSION }),
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
    const bootstrap = try parseMacosManagerCommand(&.{
        "--bootstrap-install",
        "/Users/example/Library/Application Support/com.example.app/stable",
        "--quiet",
    });
    try std.testing.expect(bootstrap == .bootstrap_install);
    try std.testing.expectEqualStrings(
        "/Users/example/Library/Application Support/com.example.app/stable",
        bootstrap.bootstrap_install,
    );

    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{"--delete-data"}));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{ "--uninstall", "--delete-data" }));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{ "--quiet", "--quiet" }));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{"--refresh-metadata"}));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{ "--bootstrap-install", "/tmp/root" }));
    try std.testing.expectError(error.InvalidArguments, parseMacosManagerCommand(&.{ "--bootstrap-install", "--quiet", "/tmp/root" }));
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
    const bootstrap = try parseLinuxManagerCommand(&.{
        "--bootstrap-install",
        "/home/example/.local/share/com.example.app/stable",
        "--quiet",
    });
    try std.testing.expect(bootstrap == .bootstrap_install);
    try std.testing.expectEqualStrings(
        "/home/example/.local/share/com.example.app/stable",
        bootstrap.bootstrap_install,
    );

    const invalid = [_][]const []const u8{
        &.{"--delete-data"},
        &.{ "--uninstall", "--delete-data" },
        &.{ "--uninstall", "--delete-data", "--quiet" },
        &.{ "--quiet", "--uninstall" },
        &.{ "--quiet", "--quiet" },
        &.{"--refresh-metadata"},
        &.{ "--refresh-metadata", "--quiet", "extra" },
        &.{ "--bootstrap-install", "/tmp/root" },
        &.{ "--bootstrap-install", "--quiet", "/tmp/root" },
        &.{ "--bootstrap-install", "", "--quiet" },
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
        "stable",
        "/Applications/Example.app",
    );
    try std.testing.expectEqualStrings(
        "7d4d21dc51bd2c14fda970718c146036c7dddd6706eb0ffc2100030d573a773a",
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
        windowsUninstallRegistryKey(std.testing.allocator, "com.example.archive", "..\\stable"),
    );
}

test "Linux install identities and integration paths reject traversal" {
    try std.testing.expect(isSafeLinuxComponent("com.example.archive"));
    try std.testing.expect(isSafeLinuxComponent("canary channel"));
    try std.testing.expect(!isSafeLinuxComponent(""));
    try std.testing.expect(!isSafeLinuxComponent(".."));
    try std.testing.expect(!isSafeLinuxComponent("../stable"));
    try std.testing.expect(!isSafeLinuxComponent("stable/canary"));
    try std.testing.expect(!isSafeLinuxComponent("stable\n"));

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

test "Linux legacy desktop adoption requires exact generated contents and launcher" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;

    g_io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(std.testing.io, "applications", .default_dir);

    const launcher_path = "/tmp/example app/bin/launcher";
    const generated =
        "[Desktop Entry]\n" ++
        "Name=Example App\n" ++
        "Exec=\"/tmp/example app/bin/launcher\"\n";
    const edited =
        "[Desktop Entry]\n" ++
        "Name=My Edited Name\n" ++
        "Exec=\"/tmp/example app/bin/launcher\"\n";
    const unrelated =
        "[Desktop Entry]\n" ++
        "Name=Example App\n" ++
        "Exec=\"/tmp/other app/bin/launcher\"\n";
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "applications/generated.desktop",
        .data = generated,
    });
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "applications/edited.desktop",
        .data = edited,
    });
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "applications/unrelated.desktop",
        .data = unrelated,
    });

    const tmp_path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(tmp_path);
    const applications_dir = try std.fs.path.join(
        std.testing.allocator,
        &.{ tmp_path, "applications" },
    );
    defer std.testing.allocator.free(applications_dir);
    const generated_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ applications_dir, "generated.desktop" },
    );
    defer std.testing.allocator.free(generated_path);
    const edited_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ applications_dir, "edited.desktop" },
    );
    defer std.testing.allocator.free(edited_path);
    const unrelated_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ applications_dir, "unrelated.desktop" },
    );
    defer std.testing.allocator.free(unrelated_path);

    var generated_digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(generated, &generated_digest, .{});
    const generated_hash = std.fmt.bytesToHex(generated_digest, .lower);
    try std.testing.expect(try matchingLegacyLinuxDesktopEntry(
        std.testing.allocator,
        generated_path,
        applications_dir,
        &generated_hash,
        launcher_path,
    ));
    try std.testing.expect(!try matchingLegacyLinuxDesktopEntry(
        std.testing.allocator,
        edited_path,
        applications_dir,
        &generated_hash,
        launcher_path,
    ));

    var unrelated_digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(unrelated, &unrelated_digest, .{});
    const unrelated_hash = std.fmt.bytesToHex(unrelated_digest, .lower);
    try std.testing.expect(!try matchingLegacyLinuxDesktopEntry(
        std.testing.allocator,
        unrelated_path,
        applications_dir,
        &unrelated_hash,
        launcher_path,
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
    const stable = try windowsUpdateTaskName(std.testing.allocator, "com.example.app", "stable");
    defer std.testing.allocator.free(stable);
    try std.testing.expectEqualStrings("ElectrobunUpdate_3b0d4743415a798b541a0fd0", stable);

    const canary = try windowsUpdateTaskName(std.testing.allocator, "com.example.app", "canary");
    defer std.testing.allocator.free(canary);
    try std.testing.expect(!std.mem.eql(u8, stable, canary));
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

test "stable bundles use the unsuffixed application name" {
    try std.testing.expect(isStableChannel("stable"));
    try std.testing.expect(!isStableChannel("canary"));
    try std.testing.expect(!isStableChannel("dev"));
    try std.testing.expect(!isStableChannel("production"));

    const stable = try extractedBundleName(std.testing.allocator, "My App.Name", "stable");
    defer std.testing.allocator.free(stable);
    try std.testing.expectEqualStrings("MyApp.Name", stable);

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

test "installer progress maps phases monotonically and clamps without overflow" {
    const events = [_]InstallProgress{
        .{ .phase = .decompressing, .completed_bytes = 0, .total_bytes = 100 },
        .{ .phase = .decompressing, .completed_bytes = 100, .total_bytes = 100 },
        .{ .phase = .extracting, .completed_bytes = 0, .total_bytes = 100 },
        .{ .phase = .extracting, .completed_bytes = 100, .total_bytes = 100 },
        .{ .phase = .installing_files, .completed_bytes = 0, .total_bytes = 100 },
        .{ .phase = .installing_files, .completed_bytes = 100, .total_bytes = 100 },
        .{ .phase = .integrating, .completed_bytes = 0, .total_bytes = 100 },
        .{ .phase = .integrating, .completed_bytes = std.math.maxInt(u64), .total_bytes = std.math.maxInt(u64) },
        .{ .phase = .completed },
    };
    var previous: u32 = 0;
    for (events) |event| {
        const percent = event.percent() orelse return error.TestUnexpectedResult;
        try std.testing.expect(percent >= previous);
        try std.testing.expect(percent <= 100);
        previous = percent;
    }
    try std.testing.expectEqual(@as(?u32, null), (InstallProgress{ .phase = .failed }).percent());
    try std.testing.expectEqual(
        @as(?u32, 45),
        (InstallProgress{
            .phase = .decompressing,
            .completed_bytes = std.math.maxInt(u64),
            .total_bytes = 1,
        }).percent(),
    );
}

test "KDialog progress references accept only the detached helper address" {
    const reference = parseKdialogProgressReference(
        "org.kde.kdialog-4821 /ProgressDialog\n",
    ) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("org.kde.kdialog-4821", reference.service);
    try std.testing.expectEqualStrings("/ProgressDialog", reference.object_path);

    try std.testing.expect(parseKdialogProgressReference(
        "org.kde.kdialog-4821 /ProgressDialog trailing",
    ) == null);
    try std.testing.expect(parseKdialogProgressReference(
        "org.kde.kdialog-not-a-pid /ProgressDialog",
    ) == null);
    try std.testing.expect(parseKdialogProgressReference(
        "org.kde.kdialog-4821 /UnexpectedObject",
    ) == null);
}

test "KDialog D-Bus commands preserve service path and typed property arguments" {
    var storage: [8][]const u8 = undefined;
    const method_args = [_][]const u8{
        "org.freedesktop.DBus.Properties.Set",
        "org.kde.kdialog.ProgressDialog",
        "value",
        "73",
    };
    const argv = kdialogDbusArgv(
        "qdbus6",
        .{
            .service = "org.kde.kdialog-4821",
            .object_path = "/ProgressDialog",
        },
        &method_args,
        &storage,
    ) orelse return error.TestUnexpectedResult;
    const expected = [_][]const u8{
        "qdbus6",
        "org.kde.kdialog-4821",
        "/ProgressDialog",
        "org.freedesktop.DBus.Properties.Set",
        "org.kde.kdialog.ProgressDialog",
        "value",
        "73",
    };
    try std.testing.expectEqual(expected.len, argv.len);
    for (expected, argv) |expected_arg, actual_arg| {
        try std.testing.expectEqualStrings(expected_arg, actual_arg);
    }
}

// Note: zig stdlib's untar function doesn't support file modes. They don't plan on adding it later,
// or at least not for windows in the near future which we expect to support in the future. In the meantime this is a patched
// version of std.tar.pipeToFileSystem from the stdlib that supports file modes on unix systems.
// todo: when we add windows support we can revisit
pub fn pipeToFileSystem(io: std.Io, dir: std.Io.Dir, reader: *std.Io.Reader) !void {
    return pipeToFileSystemWithProgress(io, dir, reader, null, null);
}

fn readTarChunk(
    reader: *std.Io.Reader,
    destination: []u8,
    progress: ?*ProgressIndicator,
    bytes_read: *u64,
    total_bytes: ?u64,
) !usize {
    const count = try reader.readSliceShort(destination);
    bytes_read.* += count;
    if (progress) |reporter| reporter.update(.extracting, bytes_read.*, total_bytes);
    return count;
}

fn pipeToFileSystemWithProgress(
    io: std.Io,
    dir: std.Io.Dir,
    reader: *std.Io.Reader,
    progress: ?*ProgressIndicator,
    total_bytes: ?u64,
) !void {
    var file_name_buffer: [255]u8 = undefined;
    var buffer: [512 * 8]u8 = undefined;
    var start: usize = 0;
    var end: usize = 0;
    var bytes_read: u64 = 0;
    header: while (true) {
        if (buffer.len - start < 1024) {
            const dest_end = end - start;
            @memcpy(buffer[0..dest_end], buffer[start..end]);
            end = dest_end;
            start = 0;
        }
        end += try readTarChunk(reader, buffer[end..], progress, &bytes_read, total_bytes);
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
                    end += try readTarChunk(reader, buffer[end..], progress, &bytes_read, total_bytes);
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
                        const read_n = try readTarChunk(reader, buffer[end..], progress, &bytes_read, total_bytes);
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

test "failed updater state publication restores the previous retained state" {
    g_io = std.testing.io;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();

    const final_sub_path = "updater-state";
    const previous_sub_path = "updater-state.previous";
    const missing_staged_sub_path = "missing-staged-state";
    const retained_tar_sub_path = final_sub_path ++ "/previous-hash.tar";
    const retained_metadata_sub_path = final_sub_path ++ "/nested/state.json";
    const retained_tar = "previous retained tar bytes";
    const retained_metadata = "{\"generation\":\"previous\"}";

    try tmp.dir.createDirPath(std.testing.io, final_sub_path ++ "/nested");
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = retained_tar_sub_path,
        .data = retained_tar,
    });
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = retained_metadata_sub_path,
        .data = retained_metadata,
    });

    const tmp_path = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(tmp_path);
    const final_path = try std.fs.path.join(std.testing.allocator, &.{ tmp_path, final_sub_path });
    defer std.testing.allocator.free(final_path);
    const missing_staged_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ tmp_path, missing_staged_sub_path },
    );
    defer std.testing.allocator.free(missing_staged_path);

    if (publishExtractionState(std.testing.allocator, missing_staged_path, final_path)) |_| {
        return error.TestExpectedError;
    } else |_| {}

    const restored_tar = try tmp.dir.readFileAlloc(
        std.testing.io,
        retained_tar_sub_path,
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(restored_tar);
    try std.testing.expectEqualStrings(retained_tar, restored_tar);

    const restored_metadata = try tmp.dir.readFileAlloc(
        std.testing.io,
        retained_metadata_sub_path,
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(restored_metadata);
    try std.testing.expectEqualStrings(retained_metadata, restored_metadata);

    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, previous_sub_path, .{}),
    );
}

test "apply-update names are transaction-scoped and neutral" {
    const allocator = std.testing.allocator;
    const transaction_id = "0123456789abcdef0123456789abcdef";
    try std.testing.expect(isApplyUpdateTransactionId(transaction_id));
    try std.testing.expect(!isApplyUpdateTransactionId("0123456789ABCDEF0123456789ABCDEF"));
    try std.testing.expect(!isApplyUpdateTransactionId("0123456789abcdef"));

    const plan_name = try applyUpdatePlanName(allocator, transaction_id);
    defer allocator.free(plan_name);
    try std.testing.expectEqualStrings(
        ".electrobun-update-0123456789abcdef0123456789abcdef.json",
        plan_name,
    );
    const result_name = try applyUpdateResultName(allocator, transaction_id);
    defer allocator.free(result_name);
    try std.testing.expectEqualStrings(
        ".electrobun-update-0123456789abcdef0123456789abcdef.result.json",
        result_name,
    );
    const task_name = try applyUpdateTaskName(allocator, transaction_id);
    defer allocator.free(task_name);
    try std.testing.expectEqualStrings(
        "ApplicationUpdate_0123456789abcdef01234567",
        task_name,
    );
    try std.testing.expect(std.mem.indexOf(u8, task_name, "Electrobun") == null);
}

test "managed roots accept only channel or validated legacy app name" {
    try std.testing.expect(linuxRootMatchesInstallIdentity("stable", "stable", "Example App", null));
    try std.testing.expect(linuxRootMatchesInstallIdentity("Legacy-App", "stable", "Example App", "Legacy-App"));
    try std.testing.expect(!linuxRootMatchesInstallIdentity("other", "stable", "Example App", "Legacy-App"));
    try std.testing.expect(windowsRootMatchesInstallIdentity(
        "Example App",
        "stable",
        "Example App",
        "Example App",
    ));
    try std.testing.expect(macosRootMatchesInstallIdentity(
        "Example App",
        "stable",
        "Example App",
        "Example App",
    ));
}

test "apply-update roots accept only exact current and v1 aliases" {
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "stable",
        "stable",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "stable",
        "canary",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "Stable",
        "stable",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "Stable",
        "stable",
        "ExampleApp",
        "Example App",
        .windows,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "stable",
        "production",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "ExampleApp",
        "stable",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "ExampleApp-stable",
        "stable",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "EXAMPLEAPP-STABLE",
        "stable",
        "ExampleApp",
        "Example App",
        .windows,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "ExampleApp-stable",
        "canary",
        "ExampleApp-canary",
        "Example App",
        .linux,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "Example App",
        "stable",
        "ExampleApp",
        "Example App",
        .linux,
    ));
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "Example App",
        "stable",
        "ExampleApp",
        "Example App",
        .macos,
    ));
    try std.testing.expect(applyUpdateRootMatchesIdentityForPlatform(
        "Example App-canary",
        "canary",
        "ExampleApp-canary",
        "Example App",
        .macos,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "Example App",
        "canary",
        "ExampleApp-canary",
        "Example App",
        .macos,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "Example App-stable",
        "stable",
        "ExampleApp",
        "Example App",
        .macos,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "Example App-canary",
        "stable",
        "ExampleApp",
        "Example App",
        .macos,
    ));
    try std.testing.expect(!applyUpdateRootMatchesIdentityForPlatform(
        "unrelated",
        "stable",
        "ExampleApp",
        "Example App",
        .linux,
    ));
}

test "validation failure cleanup only touches independently validated paths" {
    try std.testing.expectEqualDeep(
        ApplyUpdateValidationFailureActions{
            .cleanup_transport = false,
            .cleanup_plan = false,
            .publish_result = false,
        },
        applyUpdateValidationFailureActions(false, .{
            .plan_path_safe = true,
            .result_path_safe = true,
        }),
    );
    try std.testing.expectEqualDeep(
        ApplyUpdateValidationFailureActions{
            .cleanup_transport = true,
            .cleanup_plan = false,
            .publish_result = false,
        },
        applyUpdateValidationFailureActions(true, .{}),
    );
    try std.testing.expectEqualDeep(
        ApplyUpdateValidationFailureActions{
            .cleanup_transport = true,
            .cleanup_plan = true,
            .publish_result = false,
        },
        applyUpdateValidationFailureActions(true, .{ .plan_path_safe = true }),
    );
    try std.testing.expectEqualDeep(
        ApplyUpdateValidationFailureActions{
            .cleanup_transport = true,
            .cleanup_plan = true,
            .publish_result = true,
        },
        applyUpdateValidationFailureActions(true, .{
            .plan_path_safe = true,
            .result_path_safe = true,
        }),
    );
}

test "successful update cleanup preserves the committed retained tar" {
    const keep = "newhash.tar";
    try std.testing.expect(!shouldRemoveCommittedUpdateState(keep, keep));
    try std.testing.expect(shouldRemoveCommittedUpdateState("oldhash.tar", keep));
    try std.testing.expect(shouldRemoveCommittedUpdateState("oldhash.tar.previous", keep));
    try std.testing.expect(shouldRemoveCommittedUpdateState(
        ".electrobun-prepared-update.json",
        keep,
    ));
    try std.testing.expect(shouldRemoveCommittedUpdateState(
        ".electrobun-prepared-update.json.previous",
        keep,
    ));
    try std.testing.expect(shouldRemoveCommittedUpdateState("download.tar.zst", keep));
    try std.testing.expect(shouldRemoveCommittedUpdateState("download.partial", keep));
    try std.testing.expect(!shouldRemoveCommittedUpdateState("unrelated.json", keep));

    g_io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(std.testing.io, "self-extraction", .default_dir);
    for ([_][]const u8{
        "self-extraction/newhash.tar",
        "self-extraction/oldhash.tar",
        "self-extraction/.electrobun-prepared-update.json",
        "self-extraction/download.partial",
        "self-extraction/unrelated.json",
    }) |path| {
        try tmp.dir.writeFile(std.testing.io, .{ .sub_path = path, .data = "test" });
    }
    const root = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(root);
    const retained_tar_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ root, "self-extraction", keep },
    );
    defer std.testing.allocator.free(retained_tar_path);
    const plan = ApplyUpdatePlan{
        .schema_version = 1,
        .transaction_id = "0123456789abcdef0123456789abcdef",
        .identifier = "dev.example.application",
        .channel = "stable",
        .platform = expectedApplyUpdatePlatform(),
        .arch = expectedApplyUpdateArch(),
        .version = "2.0.0",
        .hash = "newhash",
        .channel_root = root,
        .app_bundle_path = root,
        .retained_tar_path = retained_tar_path,
        .parent_pid = 1,
        .result_path = root,
    };
    try cleanupCommittedApplyUpdateState(std.testing.allocator, plan);
    try tmp.dir.access(std.testing.io, "self-extraction/newhash.tar", .{});
    try tmp.dir.access(std.testing.io, "self-extraction/unrelated.json", .{});
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, "self-extraction/oldhash.tar", .{}),
    );
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, "self-extraction/.electrobun-prepared-update.json", .{}),
    );
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, "self-extraction/download.partial", .{}),
    );
}

test "invalid payload cleanup removes only the failed hash and matching prepared state" {
    try std.testing.expect(shouldInvalidateApplyUpdatePayload(.extracting));
    try std.testing.expect(shouldInvalidateApplyUpdatePayload(.validating_payload));
    try std.testing.expect(!shouldInvalidateApplyUpdatePayload(.integrating));
    const transaction_id = "0123456789abcdef0123456789abcdef";
    try std.testing.expect(isApplyUpdateHashTransientName(
        ".newhash.0123456789abcdef0123456789abcdef.tar.zst.partial",
        "newhash",
    ));
    try std.testing.expect(isApplyUpdateHashTransientName(
        "newhash.tar.0123456789abcdef0123456789abcdef.partial",
        "newhash",
    ));
    try std.testing.expect(!isApplyUpdateHashTransientName(
        "oldhash.tar.0123456789abcdef0123456789abcdef.partial",
        "newhash",
    ));

    g_io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(std.testing.io, "self-extraction", .default_dir);
    const root = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(root);
    const retained_tar_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ root, "self-extraction", "newhash.tar" },
    );
    defer std.testing.allocator.free(retained_tar_path);
    const plan = ApplyUpdatePlan{
        .schema_version = 1,
        .transaction_id = transaction_id,
        .identifier = "dev.example.application",
        .channel = "stable",
        .platform = expectedApplyUpdatePlatform(),
        .arch = expectedApplyUpdateArch(),
        .version = "2.0.0",
        .hash = "newhash",
        .channel_root = root,
        .app_bundle_path = root,
        .retained_tar_path = retained_tar_path,
        .parent_pid = 1,
        .result_path = root,
    };
    for ([_][]const u8{
        "self-extraction/newhash.tar",
        "self-extraction/oldhash.tar",
        "self-extraction/newhash.tar.previous",
        "self-extraction/oldhash.tar.previous",
        "self-extraction/.newhash.0123456789abcdef0123456789abcdef.tar.zst.partial",
        "self-extraction/.oldhash.0123456789abcdef0123456789abcdef.tar.zst.partial",
        "self-extraction/newhash.tar.0123456789abcdef0123456789abcdef.partial",
        "self-extraction/oldhash.tar.0123456789abcdef0123456789abcdef.partial",
    }) |path| {
        try tmp.dir.writeFile(std.testing.io, .{ .sub_path = path, .data = "test" });
    }
    const matching_record = ApplyUpdatePreparedRecord{
        .schema_version = 1,
        .identifier = plan.identifier,
        .channel = plan.channel,
        .platform = plan.platform,
        .arch = plan.arch,
        .version = plan.version,
        .hash = plan.hash,
        .retained_tar_path = plan.retained_tar_path,
    };
    const matching_json = try std.json.Stringify.valueAlloc(
        std.testing.allocator,
        matching_record,
        .{},
    );
    defer std.testing.allocator.free(matching_json);
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "self-extraction/.electrobun-prepared-update.json",
        .data = matching_json,
    });
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "self-extraction/.electrobun-prepared-update.json.0123.partial",
        .data = matching_json,
    });
    const previous_record = ApplyUpdatePreparedRecord{
        .schema_version = 1,
        .identifier = plan.identifier,
        .channel = plan.channel,
        .platform = plan.platform,
        .arch = plan.arch,
        .version = "1.0.0",
        .hash = "oldhash",
        .retained_tar_path = "oldhash.tar",
    };
    const previous_json = try std.json.Stringify.valueAlloc(
        std.testing.allocator,
        previous_record,
        .{},
    );
    defer std.testing.allocator.free(previous_json);
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "self-extraction/.electrobun-prepared-update.json.previous",
        .data = previous_json,
    });

    try cleanupInvalidApplyUpdatePayloadState(
        std.testing.allocator,
        plan,
        .validating_payload,
    );
    for ([_][]const u8{
        "self-extraction/oldhash.tar",
        "self-extraction/oldhash.tar.previous",
        "self-extraction/.oldhash.0123456789abcdef0123456789abcdef.tar.zst.partial",
        "self-extraction/oldhash.tar.0123456789abcdef0123456789abcdef.partial",
        "self-extraction/.electrobun-prepared-update.json.previous",
    }) |path| try tmp.dir.access(std.testing.io, path, .{});
    for ([_][]const u8{
        "self-extraction/newhash.tar",
        "self-extraction/newhash.tar.previous",
        "self-extraction/.newhash.0123456789abcdef0123456789abcdef.tar.zst.partial",
        "self-extraction/newhash.tar.0123456789abcdef0123456789abcdef.partial",
        "self-extraction/.electrobun-prepared-update.json",
        "self-extraction/.electrobun-prepared-update.json.0123.partial",
    }) |path| try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, path, .{}),
    );
}

test "rollback integration metadata never carries the new update hash" {
    const plan = ApplyUpdatePlan{
        .schema_version = 1,
        .transaction_id = "0123456789abcdef0123456789abcdef",
        .identifier = "dev.example.application",
        .channel = "stable",
        .platform = expectedApplyUpdatePlatform(),
        .arch = expectedApplyUpdateArch(),
        .version = "2.0.0",
        .hash = "newhash",
        .channel_root = "unused",
        .app_bundle_path = "unused",
        .retained_tar_path = "unused",
        .parent_pid = 1,
        .result_path = "unused",
    };
    const rollback = applyUpdateIntegrationMetadata(plan, "Example App", null, "Legacy-App");
    try std.testing.expect(rollback.hash == null);
    try std.testing.expectEqualStrings("Legacy-App", rollback.install_root_name.?);
}

test "apply-update rollback restores the previous application tree" {
    g_io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(std.testing.io, "app", .default_dir);
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "app/new.txt",
        .data = "new",
    });
    try tmp.dir.createDir(std.testing.io, "app.previous", .default_dir);
    try tmp.dir.writeFile(std.testing.io, .{
        .sub_path = "app.previous/old.txt",
        .data = "old",
    });
    const root = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(root);
    const target = try std.fs.path.join(std.testing.allocator, &.{ root, "app" });
    defer std.testing.allocator.free(target);
    const previous = try std.fs.path.join(std.testing.allocator, &.{ root, "app.previous" });
    defer std.testing.allocator.free(previous);

    try rollbackAppliedUpdate(target, previous);
    const restored = try tmp.dir.readFileAlloc(
        std.testing.io,
        "app/old.txt",
        std.testing.allocator,
        .limited(16),
    );
    defer std.testing.allocator.free(restored);
    try std.testing.expectEqualStrings("old", restored);
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, "app/new.txt", .{}),
    );
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.access(std.testing.io, "app.previous", .{}),
    );
}

test "apply-update failure recovery never duplicates or launches uncertain state" {
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.wait_then_relaunch,
        applyUpdateFailureRecovery(.validating, false, error.InvalidUpdateHelper),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.wait_then_relaunch,
        applyUpdateFailureRecovery(.extracting, false, error.InvalidUpdateArchive),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.none,
        applyUpdateFailureRecovery(.waiting_for_parent, false, error.ParentProcessWaitTimedOut),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.none,
        applyUpdateFailureRecovery(.waiting_for_parent, false, error.ParentProcessWaitFailed),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.relaunch,
        applyUpdateFailureRecovery(.waiting_for_parent, true, error.WindowsUninstallBusy),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.relaunch,
        applyUpdateFailureRecovery(.swapping, true, error.AccessDenied),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.relaunch,
        applyUpdateFailureRecovery(.integrating, true, error.AccessDenied),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.relaunch,
        applyUpdateFailureRecovery(.launching, true, error.FileNotFound),
    );
    try std.testing.expectEqual(
        ApplyUpdateFailureRecovery.none,
        applyUpdateFailureRecovery(.integrating, true, error.UpdateRollbackFailed),
    );
}

test "successful apply-update result uses the complete phase" {
    g_io = std.testing.io;
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(root);
    const result_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ root, ".electrobun-update-0123456789abcdef0123456789abcdef.result.json" },
    );
    defer std.testing.allocator.free(result_path);
    const plan = ApplyUpdatePlan{
        .schema_version = 1,
        .transaction_id = "0123456789abcdef0123456789abcdef",
        .identifier = "dev.example.application",
        .channel = "stable",
        .platform = expectedApplyUpdatePlatform(),
        .arch = expectedApplyUpdateArch(),
        .version = "2.0.0",
        .hash = "abc123",
        .channel_root = root,
        .app_bundle_path = root,
        .retained_tar_path = root,
        .parent_pid = 1,
        .result_path = result_path,
    };
    try publishApplyUpdateResult(
        std.testing.allocator,
        plan,
        true,
        .complete,
        "Update applied successfully.",
    );
    const contents = try tmp.dir.readFileAlloc(
        std.testing.io,
        std.fs.path.basename(result_path),
        std.testing.allocator,
        .limited(4096),
    );
    defer std.testing.allocator.free(contents);
    const parsed = try std.json.parseFromSlice(
        ApplyUpdateResult,
        std.testing.allocator,
        contents,
        .{},
    );
    defer parsed.deinit();
    try std.testing.expect(parsed.value.success);
    try std.testing.expectEqualStrings("complete", parsed.value.phase);
}
