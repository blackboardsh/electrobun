//! Real installed-app lifecycle client. Every update operation crosses the
//! public Zig SDK into the shared core; only the runner publishes artifacts.
const std = @import("std");
const builtin = @import("builtin");
const eb = @import("electrobun");
const a = std.heap.c_allocator;
const Io = std.Io;

const Control = struct {
    runToken: []const u8,
    identifier: []const u8,
    builtVersion: []const u8,
    initialVersion: []const u8,
    intermediateVersion: []const u8,
    patchTargetVersion: []const u8,
    fallbackTargetVersion: []const u8,
    channel: []const u8,
    channelRoot: []const u8,
    appBundlePath: []const u8,
    browserProfileRoot: []const u8,
    signalDirectory: []const u8,
    eventLogPath: []const u8,
    failurePath: []const u8,
    patchRelaunchSentinelPath: []const u8,
    fallbackRelaunchSentinelPath: []const u8,
    updateActivationPath: []const u8,
    bootstrapVerificationPath: []const u8,
    identityProbePath: []const u8,
    managedExitPath: []const u8,
    managedServices: bool,
};
const Saved = struct { runToken: []const u8, value: []const u8, visitedVersions: []const []const u8 = &.{} };
const Activation = struct { runToken: []const u8, targetVersion: []const u8 };
const Probe = struct { runToken: []const u8, probeToken: []const u8 };
const Exit = struct { runToken: []const u8, pid: u32 };
const WaitFor = enum { completed, approval, quit_ready, settled };

fn io() Io {
    return eb.defaultIo();
}
fn eq(left: []const u8, right: []const u8) bool {
    return std.mem.eql(u8, left, right);
}
fn pid() u32 {
    return if (builtin.os.tag == .windows) std.os.windows.GetCurrentProcessId() else @intCast(std.c.getpid());
}
fn sleep(ms: u32) void {
    io().sleep(.fromMilliseconds(ms), .awake) catch {};
}
fn now() i64 {
    return Io.Clock.awake.now(io()).toMilliseconds();
}
fn require(ok: bool, message: []const u8) !void {
    if (!ok) {
        std.debug.print("[native-lifecycle] {s}\n", .{message});
        return error.LifecycleAssertionFailed;
    }
}
fn exists(path: []const u8) bool {
    _ = Io.Dir.cwd().statFile(io(), path, .{ .follow_symlinks = false }) catch return false;
    return true;
}
fn jsonFile(comptime T: type, path: []const u8) !std.json.Parsed(T) {
    const bytes = try Io.Dir.cwd().readFileAlloc(io(), path, a, .limited(1024 * 1024));
    defer a.free(bytes);
    return std.json.parseFromSlice(T, a, bytes, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
}
fn writeJson(path: []const u8, value: anytype) !void {
    const parent_path = std.fs.path.dirname(path) orelse return error.InvalidControlPath;
    try Io.Dir.cwd().createDirPath(io(), parent_path);
    const parent = try Io.Dir.openDirAbsolute(io(), parent_path, .{});
    defer parent.close(io());
    var file = try parent.createFileAtomic(io(), std.fs.path.basename(path), .{ .replace = true });
    defer file.deinit(io());
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{ .emit_null_optional_fields = false });
    defer a.free(bytes);
    try file.file.writeStreamingAll(io(), bytes);
    try file.file.sync(io());
    try file.replace(io());
}
fn samePath(left: []const u8, right: []const u8) bool {
    if (left.len != right.len) return false;
    for (left, right) |l, r| {
        if (builtin.os.tag == .windows) {
            const lc = if (l == '\\') '/' else std.ascii.toLower(l);
            const rc = if (r == '\\') '/' else std.ascii.toLower(r);
            if (lc != rc) return false;
        } else if (l != r) return false;
    }
    return true;
}

const Fixture = struct {
    core: *eb.Core,
    control: *const Control,
    version: []const u8,
    local_hash: []const u8 = "",
    cursor: u64 = 0,
    completed: ?std.json.Parsed(std.json.Value) = null,

    fn deinit(self: *Fixture) void {
        if (self.completed) |*entry| entry.deinit();
    }
    fn event(self: *Fixture, name: []const u8, details: anytype) !void {
        try Io.Dir.cwd().createDirPath(io(), self.control.signalDirectory);
        const bytes = try std.json.Stringify.valueAlloc(a, .{
            .time = Io.Clock.real.now(io()).toMilliseconds(),
            .pid = pid(),
            .event = name,
            .version = self.version,
            .details = details,
        }, .{ .emit_null_optional_fields = false });
        defer a.free(bytes);
        const line = try std.fmt.allocPrint(a, "{s}\n", .{bytes});
        defer a.free(line);
        const file = try Io.Dir.cwd().createFile(io(), self.control.eventLogPath, .{ .truncate = false, .lock = .exclusive });
        defer file.close(io());
        try file.writePositionalAll(io(), line, (try file.stat(io())).size);
    }
    fn drain(self: *Fixture) !void {
        while (true) {
            var events = try self.core.updaterGetEvents(self.cursor, 128);
            defer events.deinit();
            try require(!events.value.overflow, "native updater events overflowed");
            for (events.value.entries) |entry| {
                try self.event("updater-status", entry);
                if (eq(entry.status, "complete")) {
                    const details = entry.details orelse return error.MissingReconciledBuild;
                    try require(details.currentHash != null and details.latestHash != null and
                        eq(details.currentHash.?, self.local_hash) and eq(details.latestHash.?, self.local_hash), "reconciled update result does not match the running build");
                    if (self.completed) |*prior| prior.deinit();
                    const bytes = try std.json.Stringify.valueAlloc(a, entry, .{ .emit_null_optional_fields = false });
                    defer a.free(bytes);
                    self.completed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{ .allocate = .alloc_always });
                }
                if (eq(entry.status, "error")) {
                    std.debug.print("[native-lifecycle] updater: {s}\n", .{entry.message});
                    return error.NativeUpdaterReportedFailure;
                }
            }
            self.cursor = events.value.nextSequence;
            if (events.value.entries.len < 128) return;
        }
    }
    fn accepted(_: *Fixture, response: std.json.Parsed(eb.UpdaterRequestResult)) ![]u8 {
        defer response.deinit();
        if (!response.value.accepted) {
            std.debug.print("[native-lifecycle] rejected operation: {s}\n", .{response.value.@"error" orelse "unknown"});
            return error.NativeUpdaterRejectedOperation;
        }
        return a.dupe(u8, response.value.operationId orelse return error.MissingOperationId);
    }
    fn wait(self: *Fixture, operation: []const u8, until: WaitFor) !std.json.Parsed(eb.UpdaterState) {
        const deadline = now() + 15 * 60 * 1000;
        while (now() < deadline) {
            try self.drain();
            var state = try self.core.updaterGetState();
            errdefer state.deinit();
            for (state.value.operations) |item| {
                if (!eq(item.operationId, operation)) continue;
                if (item.state == .failed or (item.state == .cancelled and until != .settled)) {
                    std.debug.print("[native-lifecycle] operation failed: {s}\n", .{item.@"error" orelse @tagName(item.state)});
                    return error.NativeUpdaterOperationFailed;
                }
                const selected = state.value.operationId != null and eq(state.value.operationId.?, operation);
                const done = switch (until) {
                    .completed => item.state == .completed,
                    .approval => selected and item.state == .awaitingApproval and state.value.approval != null,
                    .quit_ready => selected and item.state == .completed and state.value.quitReady,
                    .settled => item.state == .completed or item.state == .cancelled,
                };
                if (done) {
                    try self.drain();
                    return state;
                }
            }
            state.deinit();
            sleep(50);
        }
        return error.NativeUpdaterOperationTimedOut;
    }
    fn planCount(self: *Fixture) !usize {
        const root = try Io.Dir.openDirAbsolute(io(), self.control.channelRoot, .{ .iterate = true });
        defer root.close(io());
        var iterator = root.iterate();
        var count: usize = 0;
        while (try iterator.next(io())) |entry| {
            if (std.mem.startsWith(u8, entry.name, ".electrobun-update-") and std.mem.endsWith(u8, entry.name, ".json") and
                !std.mem.endsWith(u8, entry.name, ".result.json")) count += 1;
        }
        return count;
    }
    fn apply(self: *Fixture, target_hash: []const u8) !void {
        const prior_plans = try self.planCount();
        const veto_operation = try self.accepted(try self.core.updaterRequestApply());
        defer a.free(veto_operation);
        var pending = try self.wait(veto_operation, .approval);
        defer pending.deinit();
        // preparedHash is the core's opaque fingerprint of the entire staged
        // record. The selected release hash remains in updateInfo.
        try require(!pending.value.quitReady and eq(pending.value.updateInfo.hash, target_hash) and pending.value.approval.?.preparedHash.len != 0, "apply requested premature quit or wrong prepared release");
        try require(try self.planCount() == prior_plans, "requestApply published an apply plan before quit approval");
        const veto = try self.accepted(try self.core.updaterApproveApply(veto_operation, pending.value.approval.?.id, false));
        defer a.free(veto);
        var vetoed = try self.wait(veto_operation, .settled);
        defer vetoed.deinit();
        try require(!vetoed.value.quitReady and vetoed.value.updateInfo.updateReady, "quit veto did not retain prepared update");
        try require(try self.planCount() == prior_plans, "quit veto published an apply plan");
        try self.event("before-apply-vetoed", .{ .operationId = veto_operation, .hash = target_hash, .quitReady = false, .updateReady = true, .plansBefore = prior_plans, .plansAfter = try self.planCount() });

        const operation = try self.accepted(try self.core.updaterRequestApply());
        defer a.free(operation);
        var approval = try self.wait(operation, .approval);
        defer approval.deinit();
        const approved = try self.accepted(try self.core.updaterApproveApply(operation, approval.value.approval.?.id, true));
        defer a.free(approved);
        var handed_off = try self.wait(operation, .quit_ready);
        defer handed_off.deinit();
        try self.event("apply-handoff-ready", .{ .operationId = operation, .hash = target_hash, .quitReady = true });
        // Returning through main performs Core.close()/updaterShutdown() and
        // Insights persistence before this native runtime exits normally.
    }
    fn verifySaved(self: *Fixture, data_path: []const u8, profile_path: []const u8, visits: []const []const u8) !void {
        var data = try jsonFile(Saved, data_path);
        defer data.deinit();
        var profile = try jsonFile(Saved, profile_path);
        defer profile.deinit();
        try require(eq(data.value.runToken, self.control.runToken) and eq(data.value.value, "preserved-across-update") and data.value.visitedVersions.len == visits.len, "installed user data changed across update");
        for (data.value.visitedVersions, visits) |actual, expected| try require(eq(actual, expected), "installed update history changed");
        try require(eq(profile.value.runToken, self.control.runToken) and eq(profile.value.value, "profile-preserved-across-update"), "installed profile data changed across update");
    }
    fn run(self: *Fixture, bundle: *const eb.BundlePaths, paths: *const eb.Paths) !void {
        const c = self.control;
        try require(self.core.updaterAvailable(), "bundled core has no native updater ABI");
        // Auto-configuration is SDK startup behavior, but make failure explicit.
        var initial = try self.core.updaterGetState();
        defer initial.deinit();
        const local = initial.value.localInfo;
        self.local_hash = local.hash;
        try require(eq(local.version, c.builtVersion) and eq(local.identifier, c.identifier) and eq(local.channel, c.channel), "bundled native fixture identity mismatch");
        try self.event("launched", .{ .hash = local.hash, .channel = local.channel, .identifier = local.identifier, .baseUrl = local.baseUrl, .backend = "zig" });
        const running_bundle = try std.fs.path.resolve(a, &.{ bundle.resources_dir, if (builtin.os.tag == .macos) "../.." else ".." });
        defer a.free(running_bundle);
        const scoped = samePath(initial.value.channelRoot, c.channelRoot) and samePath(running_bundle, c.appBundlePath);
        if (scoped) {
            const id = (try self.core.getInstallationId()) orelse return error.MissingInstallationIdentity;
            defer a.free(id);
            const insights_id = try self.core.insightsGetInstallationId();
            defer if (insights_id) |value| a.free(value);
            if (c.managedServices) try require(insights_id != null and eq(id, insights_id.?), "managed updates and Insights have different installation IDs");
            try self.event("installation-identity", .{ .installationId = id, .insightsId = insights_id });
            if (c.managedServices) {
                try require(try self.core.insightsTrack("lifecycle.launched", .{ .runToken = c.runToken, .version = local.version, .hash = local.hash }), "native Insights rejected lifecycle event");
                self.core.insightsFlush();
                sleep(1500);
            }
        }
        if (exists(c.identityProbePath)) {
            var probe = try jsonFile(Probe, c.identityProbePath);
            defer probe.deinit();
            try require(scoped and eq(probe.value.runToken, c.runToken), "identity probe did not use isolated profile");
            try self.event("installation-probed", .{ .probeToken = probe.value.probeToken });
            return;
        }
        if (!exists(c.updateActivationPath)) {
            try self.event("ignored-installer-relaunch", .{ .appDataFolder = initial.value.channelRoot, .runningAppBundlePath = running_bundle });
            return;
        }
        var activation = try jsonFile(Activation, c.updateActivationPath);
        defer activation.deinit();
        try require(scoped and eq(activation.value.runToken, c.runToken), "update activation did not use isolated profile");
        const manager = try std.fs.path.join(a, &.{ c.channelRoot, if (builtin.os.tag == .windows) "uninstall.exe" else "uninstall" });
        defer a.free(manager);
        const manifest = try std.fs.path.join(a, &.{ c.channelRoot, ".electrobun-uninstall.json" });
        defer a.free(manifest);
        try require(exists(manager) and exists(manifest), "launcher did not bootstrap standalone installer integration");
        const root_name = std.fs.path.basename(c.channelRoot);
        const published_root = try eb.processEnviron().getAlloc(a, "ELECTROBUN_INSTALL_ROOT_NAME");
        defer a.free(published_root);
        try require(eq(published_root, root_name) and samePath(paths.userData, c.channelRoot) and eq(std.fs.path.basename(paths.userCache), root_name) and eq(std.fs.path.basename(paths.userLogs), root_name), "app paths lost the physical install root");
        if (exists(c.bootstrapVerificationPath)) {
            try require(eq(local.version, c.patchTargetVersion), "bootstrap probe ran on wrong release");
            try self.event("target-bootstrap-repaired", .{ .standaloneManagerPath = manager, .uninstallManifestPath = manifest });
            return;
        }
        const data_path = try std.fs.path.join(a, &.{ paths.userData, "updater-lifecycle-user-data.json" });
        defer a.free(data_path);
        const profile_path = try std.fs.path.join(a, &.{ c.browserProfileRoot, "updater-lifecycle-profile.json" });
        defer a.free(profile_path);
        const path_details = .{ .userData = paths.userData, .userCache = paths.userCache, .userLogs = paths.userLogs, .browserProfileRoot = c.browserProfileRoot };
        if (eq(local.version, activation.value.targetVersion)) {
            const visits: []const []const u8 = if (eq(local.version, c.patchTargetVersion)) &.{} else &.{c.patchTargetVersion};
            try self.verifySaved(data_path, profile_path, visits);
            try self.event("user-data-preserved", path_details);
            const next_visits: []const []const u8 = if (eq(local.version, c.patchTargetVersion)) &.{c.patchTargetVersion} else &.{ c.patchTargetVersion, c.fallbackTargetVersion };
            try writeJson(data_path, Saved{ .runToken = c.runToken, .value = "preserved-across-update", .visitedVersions = next_visits });
            const reconcile = try self.accepted(try self.core.updaterReconcile());
            defer a.free(reconcile);
            var reconciled = try self.wait(reconcile, .completed);
            defer reconciled.deinit();
            try self.drain();
            try require(self.completed != null, "installed core did not reconcile its durable update result");
            try self.event("update-result-reconciled", self.completed.?.value);
            const sentinel = if (eq(local.version, c.patchTargetVersion)) c.patchRelaunchSentinelPath else c.fallbackRelaunchSentinelPath;
            try self.event("target-relaunched", .{ .hash = local.hash });
            // The runner treats this atomic sentinel as the commit point for
            // every target assertion and event above.
            try writeJson(sentinel, .{ .runToken = c.runToken, .pid = pid(), .version = local.version, .hash = local.hash, .identifier = local.identifier, .channel = local.channel });
            if (c.managedServices) {
                const deadline = now() + 120_000;
                while (now() < deadline) {
                    if (exists(c.managedExitPath)) {
                        var finish = try jsonFile(Exit, c.managedExitPath);
                        defer finish.deinit();
                        if (eq(finish.value.runToken, c.runToken) and finish.value.pid == pid()) return;
                    }
                    sleep(100);
                }
                return error.ManagedLifecycleDidNotFinish;
            }
            return;
        }
        const first = eq(local.version, c.initialVersion) and eq(activation.value.targetVersion, c.patchTargetVersion);
        const fallback = eq(local.version, c.patchTargetVersion) and eq(activation.value.targetVersion, c.fallbackTargetVersion);
        try require(first or fallback, "unsupported native fixture transition");
        if (first) {
            try self.event("integration-bootstrapped", .{ .standaloneManagerPath = manager, .uninstallManifestPath = manifest });
            try writeJson(data_path, Saved{ .runToken = c.runToken, .value = "preserved-across-update" });
            try writeJson(profile_path, Saved{ .runToken = c.runToken, .value = "profile-preserved-across-update" });
            try self.event("user-data-seeded", path_details);
        } else {
            try self.verifySaved(data_path, profile_path, &.{c.patchTargetVersion});
            try self.event("source-data-preserved", path_details);
        }
        const check = try self.accepted(try self.core.updaterCheck());
        defer a.free(check);
        var checked = try self.wait(check, .completed);
        defer checked.deinit();
        const info = checked.value.updateInfo;
        try require(info.@"error".len == 0 and info.updateAvailable and eq(info.version, activation.value.targetVersion) and !eq(info.hash, local.hash), "core did not select the expected changed build");
        try self.event("download-started", .{ .targetHash = info.hash });
        const download = try self.accepted(try self.core.updaterDownload());
        defer a.free(download);
        var prepared = try self.wait(download, .completed);
        defer prepared.deinit();
        try require(prepared.value.updateInfo.updateReady and prepared.value.updateInfo.@"error".len == 0, "native core did not publish ready update");
        try self.event("download-completed", prepared.value.updateInfo);
        try self.apply(info.hash);
    }
};

fn runConfigured(bundle: *const eb.BundlePaths, control: *const Control) !void {
    var core = try eb.Core.load(a);
    defer core.close();
    var app_info = try eb.resolveAppInfoFromBundle(a, bundle);
    defer app_info.deinit(a);
    var paths = try eb.Paths.resolve(a, app_info.borrowed());
    defer paths.deinit(a);
    var fixture = Fixture{ .core = &core, .control = control, .version = control.builtVersion };
    defer fixture.deinit();
    fixture.run(bundle, &paths) catch |err| {
        fixture.event("failed", .{ .message = @errorName(err) }) catch {};
        return err;
    };
}

pub fn main() !void {
    var bundle = try eb.resolveBundlePaths(a);
    defer bundle.deinit(a);
    // build.copy destinations are relative to Resources/app for every main
    // process, including native binaries whose executable lives in MacOS/bin.
    const control_path = try std.fs.path.join(a, &.{ bundle.resources_dir, "app", "updater-lifecycle-control.json" });
    defer a.free(control_path);
    var control = try jsonFile(Control, control_path);
    defer control.deinit();
    // Report core-loading and bundled metadata errors through the same runner
    // signal as updater failures, including installer-triggered app launches.
    runConfigured(&bundle, &control.value) catch |err| {
        writeJson(control.value.failurePath, .{ .runToken = control.value.runToken, .version = control.value.builtVersion, .message = @errorName(err) }) catch {};
        return err;
    };
}
