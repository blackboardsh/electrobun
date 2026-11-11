//! Native preparation and approved restart handoff. Electrobun's existing
//! extractor owns patching, archive verification, swaps, and durable results.
//! No helper, plan, or scheduled task is created before the SDK approves quit.
const std = @import("std");
const builtin = @import("builtin");
const protocol = @import("updater_protocol.zig");
const A = std.mem.Allocator;
const Io = std.Io;
const native_windows = builtin.os.tag == .windows;
extern "c" fn electrobun_updater_spawn(helper: [*:0]const u8, plan: [*:0]const u8, child_pid: *c_int) c_int;
extern "c" fn getsid(pid: c_int) c_int;

pub const PrepareRequest = struct {
    schema_version: u32 = 1,
    transaction_id: []const u8,
    identifier: []const u8,
    channel: []const u8,
    platform: protocol.Platform,
    arch: protocol.Arch,
    version: []const u8,
    hash: []const u8,
    base_hash: []const u8,
    base_url: []const u8,
    download_base_url: ?[]const u8 = null,
    installation_id: ?[]const u8 = null,
    artifact_file: []const u8,
    channel_root: []const u8,
    app_bundle_path: []const u8,
    tar_sha256: ?[]const u8 = null,
    tar_size: ?u64 = null,
};

pub fn transactionId(io: Io) ![32]u8 {
    var random: [16]u8 = undefined;
    try io.randomSecure(&random);
    return std.fmt.bytesToHex(random, .lower);
}

/// Wait is cancellable. Unwinding kills and joins the helper before deleting
/// its request or copied executable, so Core can safely unload after shutdown.
/// The caller reloads the published prepared record after this function returns.
pub fn prepare(a: A, io: Io, config: *const protocol.Config, manifest: protocol.Manifest, download_base_url: ?[]const u8, installation_id: ?[]const u8) !void {
    var diagnostics: Diagnostics = .{};
    try prepareWithDiagnostics(a, io, config, manifest, download_base_url, installation_id, &diagnostics);
}

pub fn prepareWithDiagnostics(a: A, io: Io, config: *const protocol.Config, manifest: protocol.Manifest, download_base_url: ?[]const u8, installation_id: ?[]const u8, diagnostics: *Diagnostics) !void {
    try protocol.validateManifest(a, manifest, config.local, protocol.native_platform, protocol.native_arch);
    if (config.local.updateAuthority != .direct or std.mem.eql(u8, config.local.channel, "dev")) return error.DirectUpdatesDisabled;
    if (config.local.managed == null and (download_base_url != null or installation_id != null)) return error.InvalidManagedUpdateConfiguration;
    if (config.local.managed != null) {
        if (download_base_url == null or installation_id == null or !validTransaction(installation_id.?)) return error.InvalidManagedUpdateConfiguration;
        if (!std.mem.eql(u8, std.mem.trimEnd(u8, download_base_url.?, "/"), config.base_url)) return error.InvalidManagedUpdateConfiguration;
    }
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const owned = arena.allocator();
    const transaction = try transactionId(io);
    const source = try resolveHelper(owned, io, config.channel_root, config.app_bundle_path, true);
    const request_path = try std.fs.path.join(owned, &.{ config.channel_root, try std.fmt.allocPrint(owned, ".electrobun-prepare-{s}.json", .{transaction}) });
    const request: PrepareRequest = .{
        .transaction_id = &transaction,
        .identifier = manifest.identifier,
        .channel = manifest.channel,
        .platform = manifest.platform,
        .arch = manifest.arch,
        .version = manifest.version,
        .hash = manifest.hash,
        .base_hash = config.local.hash,
        .base_url = config.local.baseUrl,
        .download_base_url = download_base_url,
        .installation_id = installation_id,
        .artifact_file = manifest.artifact.file,
        .channel_root = config.channel_root,
        .app_bundle_path = config.app_bundle_path,
        .tar_sha256 = manifest.artifact.tarSha256,
        .tar_size = manifest.artifact.tarSize,
    };
    const json = try std.json.Stringify.valueAlloc(owned, request, .{ .emit_null_optional_fields = false });
    try publishNew(io, config.channel_root, request_path, json, 0o600);
    defer removeUncancelable(io, request_path);
    // Windows resolves the installed bundled manager only after it gains .exe.
    const helper = if (native_windows) try copyHelper(owned, io, config.channel_root, config.app_bundle_path, &transaction, true, null) else source;
    defer if (native_windows) removeUncancelable(io, helper);
    try executePreparationWithDiagnostics(io, helper, request_path, diagnostics);
    const prepared = try protocol.loadPrepared(a, io, config.*);
    defer prepared.deinit();
    if (prepared.value.schema_version != 2 or !preparedMatchesManifest(prepared.value, manifest)) return error.NativePreparationDidNotPublishRequestedUpdate;
}

fn preparedMatchesManifest(prepared: protocol.Prepared, manifest: protocol.Manifest) bool {
    return std.mem.eql(u8, prepared.hash, manifest.hash) and std.mem.eql(u8, prepared.version, manifest.version) and std.mem.eql(u8, prepared.artifact_file, manifest.artifact.file);
}

pub const Diagnostics = struct {
    bytes: [8192]u8 = undefined,
    len: usize = 0,
    pub fn message(self: *const Diagnostics) []const u8 {
        return std.mem.trim(u8, self.bytes[0..self.len], " \r\n\t");
    }
    fn prepend(self: *Diagnostics, prefix: []const u8) void {
        const header = prefix[0..@min(prefix.len, self.bytes.len)];
        const kept = @min(self.len, self.bytes.len - header.len);
        std.mem.copyBackwards(u8, self.bytes[header.len..][0..kept], self.bytes[self.len - kept .. self.len]);
        @memcpy(self.bytes[0..header.len], header);
        self.len = header.len + kept;
    }
    fn append(self: *Diagnostics, bytes: []const u8) void {
        const kept = @min(bytes.len, self.bytes.len);
        const previous = @min(self.len, self.bytes.len - kept);
        std.mem.copyForwards(u8, self.bytes[0..previous], self.bytes[self.len - previous .. self.len]);
        @memcpy(self.bytes[previous..][0..kept], bytes[bytes.len - kept ..]);
        self.len = previous + kept;
    }
    fn sanitize(self: *Diagnostics) void {
        // A bounded tail can start inside a UTF8 sequence. Keep errorMessage a
        // JSON string even when native diagnostics contain malformed bytes.
        var index: usize = 0;
        while (index < self.len) {
            const count = std.unicode.utf8ByteSequenceLength(self.bytes[index]) catch {
                self.bytes[index] = '?';
                index += 1;
                continue;
            };
            if (count > self.len - index) {
                self.bytes[index] = '?';
                index += 1;
                continue;
            }
            _ = std.unicode.utf8Decode(self.bytes[index..][0..count]) catch {
                self.bytes[index] = '?';
                index += 1;
                continue;
            };
            index += count;
        }
    }
    fn drain(self: *Diagnostics, io: Io, file: Io.File) !void {
        defer self.sanitize();
        var buffer: [4096]u8 = undefined;
        while (true) {
            const count = file.readStreaming(io, &.{&buffer}) catch |err| switch (err) {
                error.EndOfStream => return,
                else => return err,
            };
            if (count == 0) return;
            self.append(buffer[0..count]);
        }
    }
};

pub fn executePreparation(io: Io, helper: []const u8, request_path: []const u8) !void {
    var diagnostics: Diagnostics = .{};
    try executePreparationWithDiagnostics(io, helper, request_path, &diagnostics);
}

fn executePreparationWithDiagnostics(io: Io, helper: []const u8, request_path: []const u8, diagnostics: *Diagnostics) !void {
    var environment = try childEnvironment(std.heap.c_allocator);
    defer environment.deinit();
    var child = try std.process.spawn(io, .{
        .environ_map = &environment,
        .argv = &.{ helper, "--prepare-update", request_path, "--quiet" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .pipe,
        .create_no_window = native_windows,
    });
    defer terminateChild(io, &child);
    const diagnostics_file = child.stderr.?;
    child.stderr = null;
    defer diagnostics_file.close(io);
    diagnostics.len = 0;
    var drain = try Io.concurrent(io, Diagnostics.drain, .{ diagnostics, io, diagnostics_file });
    defer drain.cancel(io) catch {};
    const term = try waitOwnedChild(io, &child);
    try drain.await(io);
    if (term != .exited or term.exited != 0) {
        var prefix: [128]u8 = undefined;
        diagnostics.prepend(std.fmt.bufPrint(&prefix, "Native update preparation failed ({f}): ", .{term}) catch "Native update preparation failed: ");
        return error.NativeUpdatePreparationFailed;
    }
    if (diagnostics.len != 0) std.log.warn("Native update preparation: {s}", .{diagnostics.message()});
}

// Zig 0.17's POSIX childWait clears Child.id even when interrupted by
// cancellation. Preserve the original PID so that shutdown still reaps it.
fn waitOwnedChild(io: Io, child: *std.process.Child) !std.process.Child.Term {
    const original_id = child.id.?;
    return child.wait(io) catch |err| {
        if (!native_windows and child.id == null) killAndReap(original_id);
        return err;
    };
}
fn killAndReap(pid: std.process.Child.Id) void {
    if (native_windows) return;
    // Preparation is disposable, so an ignored TERM must not block Core unload.
    _ = std.c.kill(pid, .KILL);
    var status: c_int = 0;
    while (true) {
        const result = std.c.waitpid(pid, &status, 0);
        if (result == pid) return;
        if (std.posix.errno(result) != .INTR) return;
    }
}
fn terminateChild(io: Io, child: *std.process.Child) void {
    if (child.id == null) return;
    if (native_windows) return child.kill(io);
    const protection = io.swapCancelProtection(.blocked);
    defer _ = io.swapCancelProtection(protection);
    _ = std.c.kill(child.id.?, .KILL);
    _ = child.wait(io) catch {};
}

pub const Staged = struct {
    arena: std.heap.ArenaAllocator,
    io: Io,
    transaction_id: []const u8,
    helper_path: []const u8,
    plan_path: []const u8,
    result_path: []const u8,
    handed_off: bool = false,
    helper_owned: bool = false,
    plan_owned: bool = false,
    child_pid: ?i32 = null,
    diagnostics: Diagnostics = .{},
    pub fn deinit(self: *Staged) void {
        self.rollback();
        self.arena.deinit();
        self.* = undefined;
    }
    pub fn rollback(self: *Staged) void {
        if (self.handed_off) return;
        if (self.plan_owned) removeUncancelable(self.io, self.plan_path);
        if (self.helper_owned) removeUncancelable(self.io, self.helper_path);
        self.plan_owned = false;
        self.helper_owned = false;
    }
};

/// Must only be called after matching both the in-memory approval token and
/// the freshly validated prepared hash. This function publishes handoff files.
pub fn stage(a: A, io: Io, config: *const protocol.Config, prepared: protocol.Prepared, parent_pid: ?i32) !Staged {
    return stageWithTemporaryRoot(a, io, config, prepared, parent_pid, null);
}

fn stageWithTemporaryRoot(a: A, io: Io, config: *const protocol.Config, prepared: protocol.Prepared, parent_pid: ?i32, temp_root: ?[]const u8) !Staged {
    try protocol.validatePrepared(a, io, prepared, config.local, config.channel_root, config.app_bundle_path);
    if (config.local.updateAuthority != .direct or std.mem.eql(u8, config.local.channel, "dev")) return error.DirectUpdatesDisabled;
    if (std.mem.eql(u8, prepared.hash, config.local.hash)) return error.UpdateAlreadyInstalled;
    const pid = parent_pid orelse resolveParentPid(a);
    if (pid <= 0) return error.InvalidUpdateParentPid;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    const transaction = try transactionId(io);
    const transaction_id = try owned.dupe(u8, &transaction);
    const plan_path = try std.fs.path.join(owned, &.{ config.channel_root, try std.fmt.allocPrint(owned, ".electrobun-update-{s}.json", .{transaction_id}) });
    const result_path = try std.fs.path.join(owned, &.{ config.channel_root, try std.fmt.allocPrint(owned, ".electrobun-update-{s}.result.json", .{transaction_id}) });
    const plan: protocol.Plan = .{
        .schema_version = prepared.schema_version,
        .transaction_id = transaction_id,
        .identifier = config.local.identifier,
        .channel = config.local.channel,
        .platform = protocol.native_platform,
        .arch = protocol.native_arch,
        .version = prepared.version,
        .hash = prepared.hash,
        .channel_root = config.channel_root,
        .app_bundle_path = config.app_bundle_path,
        .retained_tar_path = prepared.retained_tar_path,
        .staging_path = prepared.staging_path,
        .recipe_path = prepared.recipe_path,
        .recipe_sha256 = prepared.recipe_sha256,
        .parent_pid = @intCast(pid),
        .result_path = result_path,
    };
    try protocol.validatePlan(a, plan);
    const json = try serializePlan(owned, plan);
    const helper_path = try copyHelper(owned, io, config.channel_root, config.app_bundle_path, transaction_id, prepared.schema_version == 2, temp_root);
    errdefer removeUncancelable(io, helper_path);
    try publishNew(io, config.channel_root, plan_path, json, 0o400);
    return .{ .arena = arena, .io = io, .transaction_id = transaction_id, .helper_path = helper_path, .plan_path = plan_path, .result_path = result_path, .helper_owned = true, .plan_owned = true };
}

fn serializePlan(a: A, plan: protocol.Plan) ![]u8 {
    // Old schema-1 managers reject stage/recipe keys even when they are empty.
    return std.json.Stringify.valueAlloc(a, .{
        .schema_version = plan.schema_version,
        .transaction_id = plan.transaction_id,
        .identifier = plan.identifier,
        .channel = plan.channel,
        .platform = plan.platform,
        .arch = plan.arch,
        .version = plan.version,
        .hash = plan.hash,
        .channel_root = plan.channel_root,
        .app_bundle_path = plan.app_bundle_path,
        .retained_tar_path = plan.retained_tar_path,
        .staging_path = @as(?[]const u8, if (plan.schema_version == 2) plan.staging_path else null),
        .recipe_path = @as(?[]const u8, if (plan.schema_version == 2) plan.recipe_path else null),
        .recipe_sha256 = @as(?[]const u8, if (plan.schema_version == 2) plan.recipe_sha256 else null),
        .parent_pid = plan.parent_pid,
        .result_path = plan.result_path,
    }, .{ .emit_null_optional_fields = false });
}

pub fn handoff(a: A, io: Io, staged: *Staged) !void {
    if (staged.handed_off) return error.UpdateAlreadyHandedOff;
    if (!staged.helper_owned or !staged.plan_owned) return error.UpdateNotStaged;
    errdefer staged.rollback();
    if (native_windows) {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const owned = arena.allocator();
        const system = try std.unicode.wtf16LeToWtf8Alloc(owned, std.os.windows.getSystemDirectoryWtf16Le());
        const plan = try windowsTaskPlan(owned, staged.transaction_id, staged.helper_path, staged.plan_path, system);
        var context = CommandContext{ .io = io };
        try executeWindowsTask(plan, .{ .context = &context, .execute = CommandContext.execute, .io = io, .diagnostics = &staged.diagnostics });
    } else {
        try io.checkCancel();
        const helper_z = try a.dupeSentinel(u8, staged.helper_path, 0);
        defer a.free(helper_z);
        const plan_z = try a.dupeSentinel(u8, staged.plan_path, 0);
        defer a.free(plan_z);
        var pid: c_int = 0;
        if (electrobun_updater_spawn(helper_z.ptr, plan_z.ptr, &pid) != 0) return error.UpdateHelperSpawnFailed;
        staged.child_pid = @intCast(pid);
    }
    // Ownership changes immediately when the process/task is running. No later
    // cancellation point may destroy a plan the detached helper is consuming.
    staged.handed_off = true;
}

fn validTransaction(value: []const u8) bool {
    if (value.len != 32) return false;
    for (value) |byte| if (!std.ascii.isDigit(byte) and !(byte >= 'a' and byte <= 'f')) return false;
    return true;
}

pub fn parseParentPid(value: ?[]const u8, runtime_pid: i32) i32 {
    const text = value orelse return runtime_pid;
    if (text.len == 0 or text.len > 10 or text[0] < '1' or text[0] > '9') return runtime_pid;
    for (text) |byte| if (!std.ascii.isDigit(byte)) return runtime_pid;
    return std.fmt.parseInt(i32, text, 10) catch runtime_pid;
}
fn resolveParentPid(a: A) i32 {
    const pid: i32 = if (native_windows) @intCast(std.os.windows.GetCurrentProcessId()) else std.c.getpid();
    const env = getEnvironment(a, "ELECTROBUN_LAUNCHER_PID") catch return pid;
    defer if (env) |value| a.free(value);
    return parseParentPid(env, pid);
}
fn getEnvironment(a: A, name: [:0]const u8) !?[]u8 {
    if (native_windows) return (std.process.Environ{ .block = .global }).getAlloc(a, name) catch |err| if (err == error.EnvironmentVariableMissing) return null else return err;
    return if (std.c.getenv(name)) |value| try a.dupe(u8, std.mem.span(value)) else null;
}
fn childEnvironment(a: A) !std.process.Environ.Map {
    // Core's independent Io pool deliberately has no borrowed process environ.
    // Copy required child context by individual key; retaining a counted POSIX
    // environ slice can race runtimes adding/removing unrelated variables.
    var environment = std.process.Environ.Map.init(a);
    errdefer environment.deinit();
    inline for (.{
        "HOME",           "USER",                    "LOGNAME",                      "USERPROFILE",                "HOMEDRIVE",         "HOMEPATH",
        "LOCALAPPDATA",   "APPDATA",                 "ProgramData",                  "ProgramFiles",               "ProgramFiles(x86)", "XDG_DATA_HOME",
        "XDG_CACHE_HOME", "XDG_STATE_HOME",          "XDG_CONFIG_HOME",              "XDG_RUNTIME_DIR",            "TEMP",              "TMP",
        "TMPDIR",         "PATH",                    "SystemRoot",                   "SYSTEMROOT",                 "WINDIR",            "COMSPEC",
        "PATHEXT",        "PSModulePath",            "LANG",                         "LC_ALL",                     "LC_CTYPE",          "SSL_CERT_FILE",
        "SSL_CERT_DIR",   "ELECTROBUN_LAUNCHER_PID", "ELECTROBUN_INSTALL_ROOT_NAME", "ELECTROBUN_BOOTSTRAP_TRACE",
    }) |key| {
        if (try getEnvironment(a, key)) |value| {
            defer a.free(value);
            try environment.put(key, value);
        }
    }
    return environment;
}

fn permissions(mode: u16) Io.File.Permissions {
    return if (native_windows) .default_file else .fromMode(mode);
}
fn removeUncancelable(io: Io, path: []const u8) void {
    const protection = io.swapCancelProtection(.blocked);
    defer _ = io.swapCancelProtection(protection);
    Io.Dir.cwd().deleteFile(io, path) catch {};
}
fn publishNew(io: Io, root_path: []const u8, path: []const u8, bytes: []const u8, mode: u16) !void {
    const root = try Io.Dir.openDirAbsolute(io, root_path, .{ .follow_symlinks = false });
    defer root.close(io);
    var atomic = try root.createFileAtomic(io, std.fs.path.basename(path), .{ .permissions = permissions(mode) });
    defer atomic.deinit(io);
    try atomic.file.writeStreamingAll(io, bytes);
    if (!native_windows) try atomic.file.setPermissions(io, permissions(mode));
    try atomic.file.sync(io);
    try atomic.link(io);
    errdefer removeUncancelable(io, path);
    if (!native_windows) {
        const directory = try root.openFile(io, ".", .{ .allow_directory = true });
        defer directory.close(io);
        try directory.sync(io);
    }
}

pub fn resolveHelper(a: A, io: Io, channel_root: []const u8, bundle: []const u8, prefer_bundled: bool) ![]const u8 {
    const standalone = try std.fs.path.join(a, &.{ channel_root, if (native_windows) "uninstall.exe" else "uninstall" });
    const bundled = if (builtin.os.tag == .macos) try std.fs.path.join(a, &.{ bundle, "Contents", "Resources", "uninstall" }) else try std.fs.path.join(a, &.{ bundle, "Resources", "uninstall" });
    const candidates: [2][]const u8 = if (prefer_bundled) .{ bundled, standalone } else .{ standalone, bundled };
    const roots: [2][]const u8 = if (prefer_bundled) .{ bundle, channel_root } else .{ channel_root, bundle };
    for (candidates, roots) |path, root| {
        const file = protocol.openManagedFile(a, io, root, path) catch |err| switch (err) {
            error.Canceled => return err,
            else => continue,
        };
        file.close(io);
        return path;
    }
    return error.NativeUpdateHelperUnavailable;
}
fn copyHelper(a: A, io: Io, channel_root: []const u8, bundle: []const u8, transaction: []const u8, prefer_bundled: bool, temp_override: ?[]const u8) ![]const u8 {
    if (!validTransaction(transaction)) return error.InvalidUpdateTransaction;
    const source_path = try resolveHelper(a, io, channel_root, bundle, prefer_bundled);
    const source_root = if (std.mem.startsWith(u8, source_path, bundle)) bundle else channel_root;
    const source = try protocol.openManagedFile(a, io, source_root, source_path);
    defer source.close(io);
    const stat = try source.stat(io);
    const max_helper_bytes = 128 * 1024 * 1024;
    if (stat.size == 0 or stat.size > max_helper_bytes) return error.InvalidNativeUpdateHelper;
    const temp = try temporaryRoot(a, io, temp_override);
    const path = try std.fs.path.join(a, &.{ temp, try std.fmt.allocPrint(a, "electrobun-update-{s}{s}", .{ transaction, if (native_windows) ".exe" else "" }) });
    const destination = try Io.Dir.cwd().createFile(io, path, .{ .exclusive = true, .permissions = permissions(0o700) });
    errdefer removeUncancelable(io, path);
    defer destination.close(io);
    var buffer: [64 * 1024]u8 = undefined;
    var offset: u64 = 0;
    while (true) {
        const count = try source.readPositionalAll(io, &buffer, offset);
        if (count == 0) break;
        offset += count;
        if (offset > max_helper_bytes) return error.InvalidNativeUpdateHelper;
        try destination.writeStreamingAll(io, buffer[0..count]);
    }
    if (offset != stat.size) return error.NativeUpdateHelperChanged;
    if (!native_windows) try destination.setPermissions(io, permissions(0o700));
    try destination.sync(io);
    return path;
}
fn temporaryRoot(a: A, io: Io, override: ?[]const u8) ![]const u8 {
    const root = if (override) |value| value else if (native_windows) try windowsTemporaryRoot(a) else blk: {
        const value = (try getEnvironment(a, "TMPDIR")) orelse break :blk "/tmp";
        break :blk if (value.len == 0) "/tmp" else value;
    };
    if (!std.fs.path.isAbsolute(root)) return error.InvalidTemporaryDirectory;
    const resolved = try std.fs.path.resolve(a, &.{root});
    if (!native_windows) return Io.Dir.realPathFileAbsoluteAlloc(io, resolved, a);
    const dir = try Io.Dir.openDirAbsolute(io, resolved, .{ .follow_symlinks = false });
    dir.close(io);
    return resolved;
}
fn windowsTemporaryRoot(a: A) ![]const u8 {
    // Keep the extractor's exact TEMP-before-TMP precedence.
    if (try getEnvironment(a, "TEMP")) |value| return value;
    if (try getEnvironment(a, "TMP")) |value| return value;
    if (try getEnvironment(a, "LOCALAPPDATA")) |value| return std.fmt.allocPrint(a, "{s}\\Temp", .{value});
    const profile = (try getEnvironment(a, "USERPROFILE")) orelse return error.TemporaryDirectoryUnavailable;
    return std.fmt.allocPrint(a, "{s}\\AppData\\Local\\Temp", .{profile});
}

pub const Command = struct { argv: []const []const u8 };
pub const WindowsTaskPlan = struct { create: Command, configure: Command, run: Command, end: Command, delete_task: Command };
pub const Executor = struct { context: *anyopaque, execute: *const fn (*anyopaque, Command) anyerror!void, io: ?Io = null, diagnostics: ?*Diagnostics = null };
fn windowsTaskPath(path: []const u8) !void {
    if (!std.fs.path.isAbsoluteWindows(path) or std.mem.indexOfAny(u8, path, "\"\r\n\x00") != null) return error.InvalidWindowsUpdatePath;
    const drive = path.len >= 3 and std.ascii.isAlphabetic(path[0]) and path[1] == ':' and (path[2] == '\\' or path[2] == '/');
    const unc = path.len > 4 and (std.mem.startsWith(u8, path, "\\\\") or std.mem.startsWith(u8, path, "//"));
    if (!drive and !unc) return error.InvalidWindowsUpdatePath;
}
fn powershellLiteral(a: A, text: []const u8) ![]const u8 {
    const escaped = try std.mem.replaceOwned(u8, a, text, "'", "''");
    return std.fmt.allocPrint(a, "'{s}'", .{escaped});
}
pub fn windowsTaskPlan(a: A, transaction: []const u8, helper: []const u8, plan: []const u8, system_directory: []const u8) !WindowsTaskPlan {
    if (!validTransaction(transaction)) return error.InvalidUpdateTransaction;
    for ([_][]const u8{ helper, plan, system_directory }) |path| try windowsTaskPath(path);
    const name = try std.fmt.allocPrint(a, "ApplicationUpdate_{s}", .{transaction[0..24]});
    const scheduler = try std.fs.path.resolveWindows(a, &.{ system_directory, "schtasks.exe" });
    const powershell = try std.fs.path.resolveWindows(a, &.{ system_directory, "WindowsPowerShell", "v1.0", "powershell.exe" });
    const arguments = try std.fmt.allocPrint(a, "--apply-update \"{s}\" --quiet", .{plan});
    const create_script = try std.fmt.allocPrint(a, "$ErrorActionPreference = 'Stop'; $action = New-ScheduledTaskAction -Execute {s} -Argument {s}; $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName '{s}' -Action $action -Principal $principal -Force | Out-Null", .{ try powershellLiteral(a, helper), try powershellLiteral(a, arguments), name });
    const utf16 = try std.unicode.utf8ToUtf16LeAlloc(a, create_script);
    const raw = std.mem.sliceAsBytes(utf16);
    const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(raw.len));
    _ = std.base64.standard.Encoder.encode(encoded, raw);
    const settings = try std.fmt.allocPrint(a, "$ErrorActionPreference = 'Stop'; $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Set-ScheduledTask -TaskName '{s}' -Settings $settings | Out-Null", .{name});
    return .{
        .create = .{ .argv = try a.dupe([]const u8, &.{ powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded }) },
        .configure = .{ .argv = try a.dupe([]const u8, &.{ powershell, "-NoProfile", "-NonInteractive", "-Command", settings }) },
        .run = .{ .argv = try a.dupe([]const u8, &.{ scheduler, "/run", "/tn", name }) },
        .end = .{ .argv = try a.dupe([]const u8, &.{ scheduler, "/end", "/tn", name }) },
        .delete_task = .{ .argv = try a.dupe([]const u8, &.{ scheduler, "/delete", "/tn", name, "/f" }) },
    };
}
pub fn executeWindowsTask(plan: WindowsTaskPlan, executor: Executor) !void {
    executor.execute(executor.context, plan.create) catch |err| {
        // A canceled registration process may already have registered its task.
        // This transaction is unique and safe to clean even on ambiguous failure.
        recordTaskFailure(executor, "Task registration failed: ", err);
        rollbackWindowsTask(plan, executor) catch |cleanup| recordTaskFailure(executor, "; rollback failed: ", cleanup);
        return err;
    };
    executor.execute(executor.context, plan.configure) catch |err| {
        recordTaskFailure(executor, "Task configuration failed: ", err);
        rollbackWindowsTask(plan, executor) catch |cleanup| {
            recordTaskFailure(executor, "; rollback failed: ", cleanup);
            return error.UpdateTaskRollbackFailed;
        };
        return err;
    };
    executor.execute(executor.context, plan.run) catch |err| {
        recordTaskFailure(executor, "Task launch failed: ", err);
        rollbackWindowsTask(plan, executor) catch |cleanup| {
            recordTaskFailure(executor, "; rollback failed: ", cleanup);
            return error.UpdateTaskRollbackFailed;
        };
        return err;
    };
}
fn recordTaskFailure(executor: Executor, prefix: []const u8, err: anyerror) void {
    const diagnostics = executor.diagnostics orelse return;
    diagnostics.append(prefix);
    diagnostics.append(@errorName(err));
}
fn rollbackWindowsTask(plan: WindowsTaskPlan, executor: Executor) !void {
    const protection = if (executor.io) |io| io.swapCancelProtection(.blocked) else null;
    defer if (executor.io) |io| {
        _ = io.swapCancelProtection(protection.?);
    };
    // Stop a partially launched helper before removing its task. Both cleanup
    // commands run after cancellation, and the original cause remains available.
    executor.execute(executor.context, plan.end) catch |err| recordTaskFailure(executor, "; stopping task failed: ", err);
    executor.execute(executor.context, plan.delete_task) catch |err| {
        recordTaskFailure(executor, "; deleting task failed: ", err);
        return error.UpdateTaskRollbackFailed;
    };
}
const CommandContext = struct {
    io: Io,
    fn execute(raw: *anyopaque, command: Command) !void {
        const self: *@This() = @ptrCast(@alignCast(raw));
        var environment = try childEnvironment(std.heap.c_allocator);
        defer environment.deinit();
        var child = try std.process.spawn(self.io, .{ .environ_map = &environment, .argv = command.argv, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore, .create_no_window = true });
        defer terminateChild(self.io, &child);
        const term = try waitOwnedChild(self.io, &child);
        if (term != .exited or term.exited != 0) return error.UpdateTaskCommandFailed;
    }
};

test "launcher PID validation never accepts zero, overflow, or noncanonical numbers" {
    try std.testing.expectEqual(@as(i32, 42), parseParentPid("42", 12));
    try std.testing.expectEqual(std.math.maxInt(i32), parseParentPid("2147483647", 12));
    for ([_]?[]const u8{ null, "", "0", "-1", "2x", "2147483648", "00042", "42\n" }) |value| try std.testing.expectEqual(@as(i32, 12), parseParentPid(value, 12));
}

test "Windows tasks encode UTF16 and separate the helper from its quoted arguments" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try windowsTaskPlan(a, "0123456789abcdef0123456789abcdef", "C:\\Users\\O'Brien Ω\\Temp\\helper.exe", "C:\\Users\\O'Brien Ω\\Data\\plan.json", "C:\\Windows\\System32");
    try std.testing.expectEqualStrings("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", p.create.argv[0]);
    try std.testing.expectEqualStrings("-EncodedCommand", p.create.argv[3]);
    const decoded = try a.alignedAlloc(u8, .of(u16), std.base64.standard.Decoder.calcSizeForSlice(p.create.argv[4]) catch unreachable);
    try std.base64.standard.Decoder.decode(decoded, p.create.argv[4]);
    const script = try std.unicode.utf16LeToUtf8Alloc(a, std.mem.bytesAsSlice(u16, decoded));
    try std.testing.expect(std.mem.indexOf(u8, script, "New-ScheduledTaskAction -Execute 'C:\\Users\\O''Brien Ω\\Temp\\helper.exe' -Argument '--apply-update \"C:\\Users\\O''Brien Ω\\Data\\plan.json\" --quiet'") != null);
    try std.testing.expect(std.mem.indexOf(u8, script, "-LogonType Interactive -RunLevel Limited") != null);
    try std.testing.expect(std.mem.indexOf(u8, p.configure.argv[4], "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries") != null);
    try std.testing.expectEqualStrings("ApplicationUpdate_0123456789abcdef01234567", p.run.argv[3]);
    for ([_][]const u8{ "relative.exe", "\\rooted.exe", "C:\\bad\"name.exe", "C:\\bad\nname.exe" }) |path| try std.testing.expectError(error.InvalidWindowsUpdatePath, windowsTaskPlan(a, "0123456789abcdef0123456789abcdef", path, "C:\\plan.json", "C:\\Windows\\System32"));
}

test "failed Windows handoff stops and deletes exactly its transaction task" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const plan = try windowsTaskPlan(arena.allocator(), "0123456789abcdef0123456789abcdef", "C:\\Temp\\helper.exe", "C:\\Data\\plan.json", "C:\\Windows\\System32");
    const Mock = struct {
        fail_at: usize,
        count: usize = 0,
        ended: bool = false,
        deleted: bool = false,
        fn execute(raw: *anyopaque, command: Command) !void {
            const self: *@This() = @ptrCast(@alignCast(raw));
            self.count += 1;
            if (std.mem.eql(u8, command.argv[1], "/end")) self.ended = true;
            if (std.mem.eql(u8, command.argv[1], "/delete")) self.deleted = true;
            if (self.count == self.fail_at) return error.InjectedCommandFailure;
        }
    };
    for (1..4) |failure| {
        var mock = Mock{ .fail_at = failure };
        try std.testing.expectError(error.InjectedCommandFailure, executeWindowsTask(plan, .{ .context = &mock, .execute = Mock.execute }));
        try std.testing.expect(mock.ended);
        try std.testing.expect(mock.deleted);
    }
    var success = Mock{ .fail_at = 99 };
    try executeWindowsTask(plan, .{ .context = &success, .execute = Mock.execute });
    try std.testing.expectEqual(@as(usize, 3), success.count);
    try std.testing.expect(!success.deleted);
}

const Fixture = struct {
    tmp: std.testing.TmpDir,
    config: protocol.Config,
    prepared: protocol.Prepared,
    standalone: []const u8,
    bundled: []const u8,
    temp_root: []const u8,
    fn init() !Fixture {
        const io = std.testing.io;
        var tmp = std.testing.tmpDir(.{});
        errdefer tmp.cleanup();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const root = try tmp.dir.realPathFileAlloc(io, ".", a);
        const channel = try std.fs.path.join(a, &.{ root, "app.identifier", "canary" });
        const extraction = try std.fs.path.join(a, &.{ channel, "self-extraction" });
        const bundle = if (builtin.os.tag == .macos) try std.fs.path.join(a, &.{ root, "Fixture.app" }) else try std.fs.path.join(a, &.{ channel, "app" });
        const resources = if (builtin.os.tag == .macos) try std.fs.path.join(a, &.{ bundle, "Contents", "Resources" }) else try std.fs.path.join(a, &.{ bundle, "Resources" });
        const temporary = try std.fs.path.join(a, &.{ root, "temp" });
        for ([_][]const u8{ extraction, resources, temporary }) |path| try protocol.ensurePrivateDirectory(a, io, path);
        const tar = try std.fs.path.join(a, &.{ extraction, "new123.tar" });
        const standalone = try std.fs.path.join(a, &.{ channel, if (native_windows) "uninstall.exe" else "uninstall" });
        const bundled = try std.fs.path.join(a, &.{ resources, "uninstall" });
        try writeFixture(io, tar, "retained release tar; never applied");
        try writeFixture(io, standalone, "#!/bin/sh\n/bin/sleep 0.2\nexit 0\n");
        try writeFixture(io, bundled, "#!/bin/sh\n# Bundled manager matches current Core.\nexit 0\n");
        return .{
            .tmp = tmp,
            .config = .{
                .arena = arena,
                .local = .{ .identifier = "app.identifier", .channel = "canary", .version = "1.0.0", .hash = "old123", .baseUrl = "https://example.invalid", .name = "Fixture" },
                .exe_dir = bundle,
                .resources_dir = resources,
                .channel_root = channel,
                .app_bundle_path = bundle,
                .storage_path = root,
                .base_url = "https://example.invalid",
            },
            .prepared = .{ .schema_version = 1, .identifier = "app.identifier", .channel = "canary", .version = "1.0.1", .hash = "new123", .platform = protocol.native_platform, .arch = protocol.native_arch, .retained_tar_path = tar, .artifact_file = try std.fmt.allocPrint(a, "canary-{s}-{s}-Fixture.tar.zst", .{ @tagName(protocol.native_platform), @tagName(protocol.native_arch) }) },
            .standalone = standalone,
            .bundled = bundled,
            .temp_root = temporary,
        };
    }
    fn deinit(self: *Fixture) void {
        self.tmp.cleanup();
        self.config.deinit();
    }
};
fn writeFixture(io: Io, path: []const u8, content: []const u8) !void {
    const file = try Io.Dir.cwd().createFile(io, path, .{ .permissions = permissions(0o700) });
    defer file.close(io);
    try file.writeStreamingAll(io, content);
}

test "schema1 handoff preserves old manager fields and rollback owns only its unpublished resources" {
    var f = try Fixture.init();
    defer f.deinit();
    const a = std.testing.allocator;
    const io = std.testing.io;
    var staged = try stageWithTemporaryRoot(a, io, &f.config, f.prepared, 42, f.temp_root);
    defer staged.deinit();
    const bytes = try protocol.readBounded(a, io, f.config.channel_root, staged.plan_path, 64 * 1024);
    defer a.free(bytes);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, 1), parsed.value.object.get("schema_version").?.integer);
    try std.testing.expect(parsed.value.object.get("staging_path") == null);
    try std.testing.expect(parsed.value.object.get("recipe_path") == null);
    try std.testing.expectEqualStrings(f.prepared.retained_tar_path, parsed.value.object.get("retained_tar_path").?.string);
    if (!native_windows) {
        try std.testing.expectEqual(@as(u32, 0o700), (try Io.Dir.cwd().statFile(io, staged.helper_path, .{})).permissions.toMode() & 0o777);
        try std.testing.expectEqual(@as(u32, 0o400), (try Io.Dir.cwd().statFile(io, staged.plan_path, .{})).permissions.toMode() & 0o777);
    }
    staged.rollback();
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().statFile(io, staged.helper_path, .{}));
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().statFile(io, staged.plan_path, .{}));
    _ = try Io.Dir.cwd().statFile(io, f.prepared.retained_tar_path, .{});
}

test "schema2 handoff prefers current bundled manager and contains archive-free recipe payload" {
    var f = try Fixture.init();
    defer f.deinit();
    const a = f.config.arena.allocator();
    const io = std.testing.io;
    f.prepared.schema_version = 2;
    f.prepared.retained_tar_path = "";
    f.prepared.staging_path = try std.fmt.allocPrint(a, "{s}.prepared-new123", .{f.config.app_bundle_path});
    f.prepared.recipe_path = try protocol.recipePath(a, f.config.channel_root, "new123");
    f.prepared.recipe_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try protocol.ensurePrivateDirectory(a, io, f.prepared.staging_path);
    try writeFixture(io, f.prepared.recipe_path, "{}");
    var staged = try stageWithTemporaryRoot(std.testing.allocator, io, &f.config, f.prepared, 42, f.temp_root);
    defer staged.deinit();
    const helper = try protocol.readBounded(a, io, f.temp_root, staged.helper_path, 1024);
    try std.testing.expect(std.mem.indexOf(u8, helper, "Bundled manager") != null);
    const bytes = try protocol.readBounded(a, io, f.config.channel_root, staged.plan_path, 64 * 1024);
    const parsed = try std.json.parseFromSlice(protocol.Plan, a, bytes, .{});
    try std.testing.expectEqualStrings("", parsed.value.retained_tar_path);
    try std.testing.expectEqualStrings(f.prepared.staging_path, parsed.value.staging_path);
    try std.testing.expectEqualStrings(f.prepared.recipe_path, parsed.value.recipe_path);
    try std.testing.expectEqualStrings(f.prepared.recipe_sha256, parsed.value.recipe_sha256);
}

test "detached POSIX helper has a separate session and failed spawn removes unhanded resources" {
    if (native_windows) return error.SkipZigTest;
    var f = try Fixture.init();
    defer f.deinit();
    const a = std.testing.allocator;
    const io = std.testing.io;
    var staged = try stageWithTemporaryRoot(a, io, &f.config, f.prepared, 42, f.temp_root);
    defer staged.deinit();
    try handoff(a, io, &staged);
    try std.testing.expect(staged.handed_off);
    const pid = staged.child_pid.?;
    try std.testing.expectEqual(pid, getsid(pid));
    var status: c_int = 0;
    try std.testing.expectEqual(pid, std.c.waitpid(pid, &status, 0));
    try std.testing.expectError(error.UpdateAlreadyHandedOff, handoff(a, io, &staged));
    staged.handed_off = false; // Fake helper deliberately leaves cleanup to test.
    staged.rollback();
    var failed = try stageWithTemporaryRoot(a, io, &f.config, f.prepared, 42, f.temp_root);
    defer failed.deinit();
    try writeFixture(io, failed.helper_path, "not an executable");
    try std.testing.expectError(error.UpdateHelperSpawnFailed, handoff(a, io, &failed));
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().statFile(io, failed.plan_path, .{}));
    try std.testing.expectError(error.FileNotFound, Io.Dir.cwd().statFile(io, failed.helper_path, .{}));
}

test "preparation diagnostics are bounded and preparation failure is reported" {
    var tail: Diagnostics = .{};
    tail.append("old bytes");
    tail.append(&@as([10000]u8, @splat('x')));
    tail.append("last");
    try std.testing.expectEqual(@as(usize, 8192), tail.len);
    try std.testing.expectEqualStrings("last", tail.bytes[tail.len - 4 .. tail.len]);
    tail.append(&.{ 0xff, 0x80 });
    tail.sanitize();
    try std.testing.expect(std.unicode.utf8ValidateSlice(tail.message()));
    if (native_windows) return;
    var f = try Fixture.init();
    defer f.deinit();
    try writeFixture(std.testing.io, f.bundled, "#!/bin/sh\ni=0; while [ \"$i\" -lt 3000 ]; do printf 'noise line %04d\\n' \"$i\" >&2; i=$((i + 1)); done\necho ArchiveHashMismatch >&2\nexit 2\n");
    var diagnostics: Diagnostics = .{};
    try std.testing.expectError(error.NativeUpdatePreparationFailed, executePreparationWithDiagnostics(std.testing.io, f.bundled, "unused-request.json", &diagnostics));
    try std.testing.expect(std.mem.indexOf(u8, diagnostics.message(), "ArchiveHashMismatch") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostics.message(), "exited with code 2") != null);
    try std.testing.expectEqual(@as(usize, 8192), diagnostics.len);
}

test "preparation waits can be cancelled and the helper is joined before Core unloads" {
    if (native_windows) return error.SkipZigTest;
    var f = try Fixture.init();
    defer f.deinit();
    const io = std.testing.io;
    const a = f.config.arena.allocator();
    const request = try std.fs.path.join(a, &.{ f.temp_root, "cancellation-probe" });
    const marker = try std.fmt.allocPrint(a, "{s}.pid", .{request});
    try writeFixture(io, f.bundled, "#!/bin/sh\necho $$ > \"$2.pid\"\nexec /bin/sleep 60\n");
    var future = try Io.concurrent(io, executePreparation, .{ io, f.bundled, request });
    defer future.cancel(io) catch {};
    var started: ?i32 = null;
    for (0..200) |_| {
        const bytes = protocol.readBounded(a, io, f.temp_root, marker, 32) catch |err| switch (err) {
            error.FileNotFound => {
                try Io.sleep(io, .fromMilliseconds(5), .awake);
                continue;
            },
            else => return err,
        };
        started = std.fmt.parseInt(i32, std.mem.trim(u8, bytes, " \r\n"), 10) catch {
            try Io.sleep(io, .fromMilliseconds(5), .awake);
            continue;
        };
        break;
    }
    try std.testing.expect(started != null);
    try std.testing.expect(getsid(started.?) >= 0);
    try std.testing.expectError(error.Canceled, future.cancel(io));
    try std.testing.expectEqual(@as(c_int, -1), getsid(started.?));
    var status: c_int = 0;
    try std.testing.expectEqual(@as(c_int, -1), std.c.waitpid(started.?, &status, 0));
}

test "native prepare request validates disabled builds before launching helpers" {
    var f = try Fixture.init();
    defer f.deinit();
    const manifest: protocol.Manifest = .{ .schemaVersion = 1, .identifier = f.prepared.identifier, .channel = f.prepared.channel, .version = f.prepared.version, .hash = f.prepared.hash, .platform = f.prepared.platform, .arch = f.prepared.arch, .artifact = .{ .file = f.prepared.artifact_file } };
    f.config.local.updateAuthority = .external;
    try std.testing.expectError(error.DirectUpdatesDisabled, prepare(std.testing.allocator, std.testing.io, &f.config, manifest, null, null));
}

test "preparation forwards only trusted request fields and requires matching schema2 output after exit zero" {
    if (native_windows) return error.SkipZigTest;
    var f = try Fixture.init();
    defer f.deinit();
    const a = f.config.arena.allocator();
    const io = std.testing.io;
    const manifest: protocol.Manifest = .{ .schemaVersion = 1, .identifier = f.prepared.identifier, .channel = f.prepared.channel, .version = f.prepared.version, .hash = f.prepared.hash, .platform = f.prepared.platform, .arch = f.prepared.arch, .artifact = .{ .file = f.prepared.artifact_file, .tarSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .tarSize = 2048 } };
    f.prepared.schema_version = 2;
    f.prepared.retained_tar_path = "";
    f.prepared.staging_path = try std.fmt.allocPrint(a, "{s}.prepared-new123", .{f.config.app_bundle_path});
    f.prepared.recipe_path = try protocol.recipePath(a, f.config.channel_root, "new123");
    f.prepared.recipe_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try protocol.ensurePrivateDirectory(a, io, f.prepared.staging_path);
    try writeFixture(io, f.prepared.recipe_path, "{}");
    const prepared_path = try protocol.preparedPath(a, f.config.channel_root);
    try writeFixture(io, prepared_path, try std.json.Stringify.valueAlloc(a, f.prepared, .{}));
    try writeFixture(io, f.bundled, "#!/bin/sh\n[ \"$1\" = \"--prepare-update\" ] && [ \"$3\" = \"--quiet\" ] || exit 9\n/bin/cp \"$2\" \"$2.capture\"\nexit 0\n");
    try prepare(std.testing.allocator, io, &f.config, manifest, null, null);
    const root = try Io.Dir.openDirAbsolute(io, f.config.channel_root, .{ .iterate = true });
    defer root.close(io);
    var iterator = root.iterate();
    var captured: usize = 0;
    while (try iterator.next(io)) |entry| {
        if (!std.mem.startsWith(u8, entry.name, ".electrobun-prepare-")) continue;
        try std.testing.expect(std.mem.endsWith(u8, entry.name, ".capture"));
        const path = try std.fs.path.join(a, &.{ f.config.channel_root, entry.name });
        const bytes = try protocol.readBounded(a, io, f.config.channel_root, path, 64 * 1024);
        const document = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        const request = try std.json.parseFromSlice(PrepareRequest, a, bytes, .{});
        try std.testing.expectEqual(@as(u32, 1), request.value.schema_version);
        try std.testing.expect(validTransaction(request.value.transaction_id));
        try std.testing.expectEqualStrings(f.config.local.baseUrl, request.value.base_url);
        try std.testing.expectEqualStrings(f.config.local.hash, request.value.base_hash);
        try std.testing.expectEqualStrings(f.config.channel_root, request.value.channel_root);
        try std.testing.expectEqualStrings(f.config.app_bundle_path, request.value.app_bundle_path);
        try std.testing.expectEqualStrings(manifest.hash, request.value.hash);
        try std.testing.expectEqualStrings(manifest.artifact.tarSha256.?, request.value.tar_sha256.?);
        try std.testing.expectEqual(manifest.artifact.tarSize, request.value.tar_size);
        try std.testing.expect(document.value.object.get("installation_id") == null);
        try std.testing.expect(document.value.object.get("download_base_url") == null);
        captured += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), captured);
    // A helper exiting successfully is insufficient: it must publish exactly the
    // selected archive-free update before the caller is allowed to mark ready.
    try Io.Dir.cwd().deleteFile(io, prepared_path);
    try std.testing.expectError(error.FileNotFound, prepare(std.testing.allocator, io, &f.config, manifest, null, null));
    f.prepared.version = "1.0.2";
    try writeFixture(io, prepared_path, try std.json.Stringify.valueAlloc(a, f.prepared, .{}));
    try std.testing.expectError(error.NativePreparationDidNotPublishRequestedUpdate, prepare(std.testing.allocator, io, &f.config, manifest, null, null));
}

test "Windows rollback blocks cancellation and retains both launch and cleanup diagnostics" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const plan = try windowsTaskPlan(arena.allocator(), "0123456789abcdef0123456789abcdef", "C:\\Temp\\helper.exe", "C:\\Data\\plan.json", "C:\\Windows\\System32");
    const Mock = struct {
        io: Io,
        fn execute(raw: *anyopaque, command: Command) !void {
            const self: *@This() = @ptrCast(@alignCast(raw));
            if (std.mem.eql(u8, command.argv[1], "/run")) return error.InjectedLaunchFailure;
            if (std.mem.eql(u8, command.argv[1], "/end") or std.mem.eql(u8, command.argv[1], "/delete")) {
                const previous = self.io.swapCancelProtection(.blocked);
                defer _ = self.io.swapCancelProtection(previous);
                try std.testing.expectEqual(Io.CancelProtection.blocked, previous);
                if (std.mem.eql(u8, command.argv[1], "/delete")) return error.InjectedDeleteFailure;
            }
        }
    };
    var mock = Mock{ .io = std.testing.io };
    var diagnostics: Diagnostics = .{};
    var future = try Io.concurrent(std.testing.io, executeWindowsTask, .{ plan, Executor{ .context = &mock, .execute = Mock.execute, .io = std.testing.io, .diagnostics = &diagnostics } });
    try std.testing.expectError(error.UpdateTaskRollbackFailed, future.await(std.testing.io));
    try std.testing.expect(std.mem.indexOf(u8, diagnostics.message(), "InjectedLaunchFailure") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostics.message(), "InjectedDeleteFailure") != null);
}

test "managed preparation binds custom routing and shared identity while failures remove only request files" {
    if (native_windows) return error.SkipZigTest;
    var f = try Fixture.init();
    defer f.deinit();
    const a = f.config.arena.allocator();
    const io = std.testing.io;
    f.config.local.managed = .{ .appId = "cloud-app", .baseUrl = "https://custom.example.invalid/updates" };
    f.config.base_url = "https://custom.example.invalid/updates";
    const id = "abcdef0123456789abcdef0123456789";
    const manifest: protocol.Manifest = .{ .schemaVersion = 1, .identifier = f.prepared.identifier, .channel = f.prepared.channel, .version = f.prepared.version, .hash = f.prepared.hash, .platform = f.prepared.platform, .arch = f.prepared.arch, .artifact = .{ .file = f.prepared.artifact_file } };
    try writeFixture(io, f.bundled, "#!/bin/sh\n/bin/cp \"$2\" \"$2.capture\"\necho ArchiveHashMismatch >&2\nexit 2\n");
    var diagnostics: Diagnostics = .{};
    try std.testing.expectError(error.InvalidManagedUpdateConfiguration, prepareWithDiagnostics(std.testing.allocator, io, &f.config, manifest, "https://wrong.invalid", id, &diagnostics));
    try std.testing.expectError(error.NativeUpdatePreparationFailed, prepareWithDiagnostics(std.testing.allocator, io, &f.config, manifest, f.config.base_url, id, &diagnostics));
    try std.testing.expect(std.mem.indexOf(u8, diagnostics.message(), "ArchiveHashMismatch") != null);
    const root = try Io.Dir.openDirAbsolute(io, f.config.channel_root, .{ .iterate = true });
    defer root.close(io);
    var iterator = root.iterate();
    var captured: usize = 0;
    while (try iterator.next(io)) |entry| {
        if (!std.mem.startsWith(u8, entry.name, ".electrobun-prepare-")) continue;
        try std.testing.expect(std.mem.endsWith(u8, entry.name, ".capture"));
        const path = try std.fs.path.join(a, &.{ f.config.channel_root, entry.name });
        const bytes = try protocol.readBounded(a, io, f.config.channel_root, path, 64 * 1024);
        const request = try std.json.parseFromSlice(PrepareRequest, a, bytes, .{});
        try std.testing.expectEqualStrings(f.config.local.baseUrl, request.value.base_url);
        try std.testing.expectEqualStrings(f.config.base_url, request.value.download_base_url.?);
        try std.testing.expectEqualStrings(id, request.value.installation_id.?);
        captured += 1;
    }
    try std.testing.expectEqual(@as(usize, 1), captured);
    const source = try protocol.readBounded(a, io, f.config.app_bundle_path, f.bundled, 4096);
    try std.testing.expect(std.mem.indexOf(u8, source, "ArchiveHashMismatch") != null);
    _ = try Io.Dir.cwd().statFile(io, f.standalone, .{});
    _ = try Io.Dir.cwd().statFile(io, f.prepared.retained_tar_path, .{});
}

test "preparation inherits home and execution context with an independently initialized empty Io pool" {
    if (native_windows) return error.SkipZigTest;
    var f = try Fixture.init();
    defer f.deinit();
    const a = f.config.arena.allocator();
    const expected_home = (try getEnvironment(a, "HOME")) orelse return error.SkipZigTest;
    const expected_path = (try getEnvironment(a, "PATH")) orelse "";
    const output = try std.fs.path.join(a, &.{ f.temp_root, "inherited-context" });
    try writeFixture(std.testing.io, f.bundled, "#!/bin/sh\n[ -n \"$HOME\" ] || { echo MissingUpdateHome >&2; exit 2; }\nprintf '%s\\n%s' \"$HOME\" \"$PATH\" > \"$2\"\n");
    // std.testing.io already inherits environ; production Core initializes a
    // separate pool with .environ=.empty, so use exactly that boundary here.
    var pool = Io.Threaded.init(std.testing.allocator, .{});
    defer pool.deinit();
    const io = pool.io();
    var diagnostics: Diagnostics = .{};
    try executePreparationWithDiagnostics(io, f.bundled, output, &diagnostics);
    const contents = try protocol.readBounded(a, io, f.temp_root, output, 64 * 1024);
    const expected = try std.fmt.allocPrint(a, "{s}\n{s}", .{ expected_home, expected_path });
    try std.testing.expectEqualStrings(expected, contents);
    try std.testing.expectEqual(@as(usize, 0), diagnostics.len);
}
