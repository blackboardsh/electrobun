//! Runtime-independent updater controller. The worker owns network and helper
//! work; callers exchange bounded JSON snapshots and never receive callbacks.
const std = @import("std");
const protocol = @import("updater_protocol.zig");
const http = @import("updater_http.zig");
const handoff = @import("updater_handoff.zig");
const results = @import("updater_results.zig");
const Mutex = @import("synchronization.zig").Mutex;
const A = std.mem.Allocator;
const Io = std.Io;
const max_operations = 64;
const max_events = 256;

pub const UpdateInfo = struct {
    version: []const u8 = "",
    hash: []const u8 = "",
    updateAvailable: bool = false,
    updateReady: bool = false,
    @"error": []const u8 = "",
};
pub const OperationState = enum { idle, queued, running, awaitingApproval, completed, failed, cancelled };
const Action = enum { check, download, requestApply, reconcile };
const Request = struct {
    schemaVersion: u32,
    action: enum { check, download, requestApply, approveApply, reconcile, cancel },
    operationId: ?[]const u8 = null,
    approvalId: ?[]const u8 = null,
    approved: ?bool = null,
};
const Approval = struct { id: [32]u8, prepared_hash: [64]u8 };
const Operation = struct {
    arena: std.heap.ArenaAllocator,
    id: [32]u8,
    action: Action,
    state: OperationState = .queued,
    error_message: ?[]const u8 = null,
    update_info: ?UpdateInfo = null,
    approval: ?Approval = null,
    approved: bool = false,
    cancel_requested: bool = false,
    handoff_started: bool = false,
    failure_detail: ?[]const u8 = null,

    fn terminal(self: *const Operation) bool {
        return self.state == .completed or self.state == .failed or self.state == .cancelled;
    }
};
pub const Details = struct {
    fromHash: ?[]const u8 = null,
    toHash: ?[]const u8 = null,
    currentHash: ?[]const u8 = null,
    latestHash: ?[]const u8 = null,
    patchNumber: ?u64 = null,
    totalPatchesApplied: ?u64 = null,
    progress: ?f64 = null,
    bytesDownloaded: ?u64 = null,
    totalBytes: ?u64 = null,
    usedPatchPath: ?bool = null,
    errorMessage: ?[]const u8 = null,
    url: ?[]const u8 = null,
    zstdPath: ?[]const u8 = null,
    exitCode: ?i32 = null,
};
const Entry = struct {
    sequence: u64,
    operationId: ?[]const u8,
    status: []const u8,
    message: []const u8,
    timestamp: i64,
    details: ?Details = null,
};
const OwnedEntry = struct { arena: std.heap.ArenaAllocator, value: Entry };
const Record = struct {
    operationId: []const u8,
    operation: []const u8,
    state: OperationState,
    @"error": ?[]const u8,
    updateInfo: ?UpdateInfo,
};

pub const Engine = struct {
    allocator: A,
    io: Io,
    config: protocol.Config,
    mutex: Mutex = .init,
    operations: std.ArrayList(*Operation) = .empty,
    entries: std.ArrayList(OwnedEntry) = .empty,
    current: ?*Operation = null,
    approval_operation: ?*Operation = null,
    revision: u64 = 1,
    sequence: u64 = 0,
    info: UpdateInfo,
    checked: ?http.Resolved = null,
    quit_ready: bool = false,
    observed_transaction: ?[32]u8 = null,
    stopping: std.atomic.Value(bool) = .init(false),
    future: ?Io.Future(void) = null,
    // Same-file tests exercise the real scheduler with controlled work. This
    // hook is never configurable over the ABI or by application metadata.
    work_override: ?*const fn (*Engine, *Operation) anyerror!void = null,

    /// Takes ownership of config only on success. Configuration performs local
    /// validation and identity setup; start schedules only result reconciliation.
    pub fn init(a: A, io: Io, config: protocol.Config) !Engine {
        return .{ .allocator = a, .io = io, .config = config, .info = try copyInfo(a, .{ .version = config.local.version, .hash = config.local.hash }) };
    }

    pub fn start(self: *Engine) !void {
        self.mutex.lockUncancelable(self.io);
        _ = self.enqueueLocked(.reconcile) catch |err| {
            self.mutex.unlock(self.io);
            return err;
        };
        self.mutex.unlock(self.io);
        self.future = try Io.concurrent(self.io, run, .{self});
    }

    pub fn stop(self: *Engine) void {
        if (self.stopping.swap(true, .acq_rel)) return;
        // run's defer cancels AND joins its active child before this returns.
        // HTTP and preparation subprocesses cannot outlive a Core unload.
        if (self.future) |*future| future.cancel(self.io);
        self.future = null;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        for (self.operations.items) |op| if (!op.terminal()) {
            self.finishLocked(op, .cancelled, null);
        };
        self.approval_operation = null;
    }

    pub fn deinit(self: *Engine) void {
        self.stop();
        if (self.checked) |*checked| checked.deinit();
        for (self.operations.items) |op| self.destroyOperation(op);
        self.operations.deinit(self.allocator);
        for (self.entries.items) |*entry| entry.arena.deinit();
        self.entries.deinit(self.allocator);
        freeInfo(self.allocator, self.info);
        self.config.deinit();
    }

    pub fn requestJson(self: *Engine, json: []const u8) ![]u8 {
        if (json.len > 16 * 1024) return envelope(self.allocator, false, null, "UpdaterRequestTooLarge");
        const document = std.json.parseFromSlice(std.json.Value, self.allocator, json, .{}) catch
            return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        defer document.deinit();
        if (document.value != .object) return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        const schema = document.value.object.get("schemaVersion") orelse return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        const action_value = document.value.object.get("action") orelse return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        if (schema != .integer or action_value != .string) return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        if (document.value.object.get("approved")) |value| if (value != .bool) return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        inline for (.{ "operationId", "approvalId" }) |key| {
            if (document.value.object.get(key)) |value| if (value != .string) return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        }
        const parsed = std.json.parseFromSlice(Request, self.allocator, json, .{ .ignore_unknown_fields = true }) catch
            return envelope(self.allocator, false, null, "InvalidUpdaterRequest");
        defer parsed.deinit();
        const request = parsed.value;
        if (request.schemaVersion != 1) return envelope(self.allocator, false, null, "UnsupportedUpdaterSchema");
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.stopping.load(.acquire)) return envelope(self.allocator, false, null, "UpdaterStopped");
        if (request.action == .approveApply or request.action == .cancel) {
            const id = request.operationId orelse return envelope(self.allocator, false, null, "MissingOperationId");
            const op = self.findLocked(id) orelse return envelope(self.allocator, false, id, "UnknownOperation");
            if (op.terminal()) return envelope(self.allocator, false, id, "OperationAlreadyFinished");
            if (request.action == .cancel) {
                if (self.quit_ready) return envelope(self.allocator, false, id, "UpdateAlreadyHandedOff");
                op.cancel_requested = true;
                if (op.state == .queued or op.state == .awaitingApproval) self.finishLocked(op, .cancelled, null);
                self.revision +%= 1;
                return envelope(self.allocator, true, id, null);
            }
            if (op.action != .requestApply or op.state != .awaitingApproval or self.approval_operation != op)
                return envelope(self.allocator, false, id, "NoApplyApprovalPending");
            const token = request.approvalId orelse return envelope(self.allocator, false, id, "MissingApprovalId");
            const approved = request.approved orelse return envelope(self.allocator, false, id, "MissingApprovalDecision");
            if (!std.mem.eql(u8, token, &op.approval.?.id)) return envelope(self.allocator, false, id, "InvalidApprovalId");
            if (!approved) {
                self.emitLocked(op, "idle", "Update restart was cancelled by a before-quit handler", null);
                self.finishLocked(op, .cancelled, null);
            } else {
                // Preserve the approval fingerprint until the worker re-reads
                // and validates the stage. No files or processes are made here.
                op.approved = true;
                op.state = .queued;
                self.revision +%= 1;
            }
            return envelope(self.allocator, true, id, null);
        }
        if (self.quit_ready) return envelope(self.allocator, false, null, "UpdateAlreadyHandedOff");
        const action: Action = switch (request.action) {
            .check => .check,
            .download => .download,
            .requestApply => .requestApply,
            .reconcile => .reconcile,
            else => unreachable,
        };
        // One operation per kind coalesces requests across SDKs as well as
        // within a single runtime. Queued download naturally follows check.
        for (self.operations.items) |op| {
            if (op.action == action and !op.terminal()) return envelope(self.allocator, true, &op.id, null);
            if (action == .download and op.action == .requestApply and !op.terminal())
                return envelope(self.allocator, false, null, "CannotDownloadDuringApply");
        }
        const op = self.enqueueLocked(action) catch |err| return envelope(self.allocator, false, null, @errorName(err));
        return envelope(self.allocator, true, &op.id, null);
    }

    pub fn stateJson(self: *Engine) ![]u8 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        var records: [max_operations]Record = undefined;
        for (self.operations.items, 0..) |op, i| records[i] = .{
            .operationId = &op.id,
            .operation = @tagName(op.action),
            .state = op.state,
            .@"error" = op.error_message,
            .updateInfo = op.update_info,
        };
        const ApprovalView = struct { id: []const u8, preparedHash: []const u8 };
        const approval: ?ApprovalView = if (self.approval_operation) |op| if (op.state == .awaitingApproval) .{
            .id = &op.approval.?.id,
            .preparedHash = &op.approval.?.prepared_hash,
        } else null else null;
        return std.json.Stringify.valueAlloc(self.allocator, .{
            .schemaVersion = @as(u32, 1),
            .revision = self.revision,
            .operationId = if (self.current) |op| @as(?[]const u8, &op.id) else null,
            .operation = if (self.current) |op| @as(?[]const u8, @tagName(op.action)) else null,
            .operationState = if (self.current) |op| op.state else OperationState.idle,
            .localInfo = self.config.local,
            .updateInfo = self.info,
            .approval = approval,
            .quitReady = self.quit_ready,
            .channelRoot = self.config.channel_root,
            .operations = records[0..self.operations.items.len],
        }, .{});
    }

    pub fn eventsJson(self: *Engine, after_sequence: u64, requested_limit: u32) ![]u8 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        const limit = std.math.clamp(requested_limit, 1, max_events);
        var entries: [max_events]Entry = undefined;
        var count: usize = 0;
        var cursor = after_sequence;
        for (self.entries.items) |entry| {
            if (entry.value.sequence <= after_sequence) continue;
            if (count >= limit) break;
            entries[count] = entry.value;
            count += 1;
            cursor = entry.value.sequence;
        }
        const oldest = if (self.entries.items.len != 0) self.entries.items[0].value.sequence else self.sequence +| 1;
        return std.json.Stringify.valueAlloc(self.allocator, .{
            .schemaVersion = @as(u32, 1),
            .entries = entries[0..count],
            .nextSequence = cursor,
            .oldestSequence = oldest,
            .overflow = after_sequence < oldest -| 1,
        }, .{ .emit_null_optional_fields = false });
    }

    fn enqueueLocked(self: *Engine, action: Action) !*Operation {
        if (self.operations.items.len == max_operations) {
            var removable: ?usize = null;
            for (self.operations.items, 0..) |op, i| if (op.terminal() and op != self.current) {
                removable = i;
                break;
            };
            const index = removable orelse return error.UpdaterQueueFull;
            self.destroyOperation(self.operations.orderedRemove(index));
        }
        const op = try self.allocator.create(Operation);
        errdefer self.allocator.destroy(op);
        op.* = .{ .arena = std.heap.ArenaAllocator.init(self.allocator), .id = randomId(self.io), .action = action };
        try self.operations.append(self.allocator, op);
        if (self.current == null or self.current.?.terminal()) self.current = op;
        self.revision +%= 1;
        return op;
    }

    fn destroyOperation(self: *Engine, op: *Operation) void {
        op.arena.deinit();
        self.allocator.destroy(op);
    }

    fn findLocked(self: *Engine, id: []const u8) ?*Operation {
        for (self.operations.items) |op| if (std.mem.eql(u8, &op.id, id)) return op;
        return null;
    }

    fn finishLocked(self: *Engine, op: *Operation, state: OperationState, failure: ?[]const u8) void {
        op.state = state;
        op.error_message = if (failure) |message| op.arena.allocator().dupe(u8, message) catch "OutOfMemory" else null;
        op.update_info = copyInfo(op.arena.allocator(), self.info) catch null;
        if (self.approval_operation == op) self.approval_operation = null;
        op.approval = null;
        self.revision +%= 1;
    }

    fn emitLocked(self: *Engine, op: ?*Operation, status: []const u8, message: []const u8, details: ?Details) void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        const a = arena.allocator();
        const bytes = std.json.Stringify.valueAlloc(a, Entry{
            .sequence = self.sequence +| 1,
            .operationId = if (op) |operation| &operation.id else null,
            .status = status,
            .message = message,
            .timestamp = @intCast(Io.Clock.real.now(self.io).toMilliseconds()),
            .details = details,
        }, .{}) catch {
            arena.deinit();
            return;
        };
        const parsed = std.json.parseFromSlice(Entry, a, bytes, .{ .allocate = .alloc_always }) catch {
            arena.deinit();
            return;
        };
        if (self.entries.items.len == max_events) {
            var oldest = self.entries.orderedRemove(0);
            oldest.arena.deinit();
        }
        self.entries.append(self.allocator, .{ .arena = arena, .value = parsed.value }) catch {
            arena.deinit();
            return;
        };
        self.sequence +|= 1;
        self.revision +%= 1;
    }

    fn emit(self: *Engine, op: *Operation, status: []const u8, message: []const u8, details: ?Details) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.emitLocked(op, status, message, details);
    }

    fn setInfo(self: *Engine, info: UpdateInfo) !void {
        const owned = try copyInfo(self.allocator, info);
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        freeInfo(self.allocator, self.info);
        self.info = owned;
        self.revision +%= 1;
    }

    const Task = struct {
        engine: *Engine,
        op: *Operation,
        done: std.atomic.Value(bool) = .init(false),
        failure: ?anyerror = null,

        fn run(task: *Task) void {
            defer task.done.store(true, .release);
            const engine = task.engine;
            if (engine.work_override) |override| {
                override(engine, task.op) catch |err| {
                    task.failure = err;
                };
            } else engine.work(task.op) catch |err| {
                task.failure = err;
            };
        }
    };

    fn run(self: *Engine) void {
        while (!self.stopping.load(.acquire)) {
            self.mutex.lockUncancelable(self.io);
            var selected: ?*Operation = null;
            // The reserved quit decision serializes subsequent operations.
            // Approved apply resumes the same operation and same token.
            if (self.approval_operation) |op| {
                if (op.state == .queued) selected = op;
            } else {
                for (self.operations.items) |op| if (op.state == .queued) {
                    selected = op;
                    break;
                };
            }
            if (selected) |op| {
                op.state = .running;
                self.current = op;
                self.revision +%= 1;
            }
            self.mutex.unlock(self.io);
            const op = selected orelse {
                Io.sleep(self.io, .fromMilliseconds(20), .awake) catch return;
                continue;
            };
            var task: Task = .{ .engine = self, .op = op };
            var future = Io.concurrent(self.io, Task.run, .{&task}) catch |err| {
                self.fail(op, err);
                continue;
            };
            // The only owner of the child future is this supervisor. Requests
            // merely set flags; neither cancellation nor HTTP blocks a getter.
            defer future.cancel(self.io);
            while (!task.done.load(.acquire)) {
                self.mutex.lockUncancelable(self.io);
                const cancelled = op.cancel_requested;
                self.mutex.unlock(self.io);
                if (cancelled) {
                    future.cancel(self.io);
                    break;
                }
                Io.sleep(self.io, .fromMilliseconds(10), .awake) catch return;
            }
            future.await(self.io);
            if (task.failure) |err| {
                self.fail(op, err);
            } else {
                self.mutex.lockUncancelable(self.io);
                // Publish approval only after joining validation. A runtime
                // may immediately approve/veto and enqueue more work, so no
                // completed child may retain the exposed operation pointer.
                if (op.state == .running) {
                    if (!op.cancel_requested and op.approval != null and !op.approved) {
                        op.state = .awaitingApproval;
                        self.approval_operation = op;
                        self.revision +%= 1;
                    } else self.finishLocked(op, if (op.cancel_requested and !self.quit_ready) .cancelled else .completed, null);
                }
                self.mutex.unlock(self.io);
            }
        }
    }

    fn fail(self: *Engine, op: *Operation, err: anyerror) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (err == error.Canceled or op.cancel_requested) {
            self.finishLocked(op, .cancelled, null);
            return;
        }
        if (op.action == .check) {
            if (self.checked) |*checked| checked.deinit();
            self.checked = null;
        }
        const prefix = switch (op.action) {
            .check => "Failed to check for updates",
            .download => "Failed to download update",
            .requestApply => "Cannot apply update",
            .reconcile => "Failed to reconcile update result",
        };
        const detail = op.failure_detail orelse @errorName(err);
        const message = std.fmt.allocPrint(self.allocator, "{s}: {s}", .{ prefix, detail }) catch null;
        defer if (message) |value| self.allocator.free(value);
        const text = message orelse @errorName(err);
        var info = self.info;
        info.@"error" = text;
        if (op.action == .check) {
            info.version = "";
            info.hash = "";
            info.updateAvailable = false;
            info.updateReady = false;
        }
        if (op.action == .download) info.updateReady = false;
        if (op.action == .requestApply and !op.handoff_started) info.updateReady = false;
        if (copyInfo(self.allocator, info)) |owned| {
            freeInfo(self.allocator, self.info);
            self.info = owned;
        } else |_| {}
        self.emitLocked(op, "error", text, .{ .errorMessage = detail });
        self.finishLocked(op, .failed, text);
    }

    fn work(self: *Engine, op: *Operation) !void {
        switch (op.action) {
            .check => try self.check(op),
            .download => try self.download(op),
            .requestApply => try self.apply(op),
            .reconcile => try self.reconcile(op),
        }
    }

    fn prepared(self: *Engine) !?std.json.Parsed(protocol.Prepared) {
        return protocol.loadPrepared(self.allocator, self.io, self.config) catch |err| switch (err) {
            error.Canceled, error.OutOfMemory => return err,
            else => return null,
        };
    }

    fn check(self: *Engine, op: *Operation) !void {
        self.emit(op, "checking", "Checking for updates...", null);
        var selection = try http.resolve(self.allocator, self.io, .{
            .local = self.config.local,
            .base_url = self.config.base_url,
            .platform = self.config.platform,
            .arch = self.config.arch,
            .installation_id = if (self.config.installation_id) |*id| id else null,
        });
        errdefer selection.deinit();
        const local = self.config.local;
        if (selection.status == .disabled) {
            try self.setInfo(.{ .version = local.version, .hash = local.hash });
            self.emit(op, "no-update", if (std.mem.eql(u8, local.channel, "dev")) "Dev channel - updates disabled" else "Updates are managed externally or disabled", .{ .currentHash = local.hash });
        } else {
            const manifest = selection.manifest.?;
            var ready = false;
            if (try self.prepared()) |existing| {
                defer existing.deinit();
                ready = protocol.preparedMatches(existing.value, manifest);
            }
            const available = !std.mem.eql(u8, local.hash, manifest.hash);
            try self.setInfo(.{ .version = manifest.version, .hash = manifest.hash, .updateAvailable = available, .updateReady = ready and available });
            self.emit(op, if (available) "update-available" else "no-update", if (available) "Update available" else "Already on latest version", .{ .currentHash = local.hash, .latestHash = manifest.hash });
        }
        if (self.checked) |*checked| checked.deinit();
        self.checked = selection;
    }

    fn download(self: *Engine, op: *Operation) !void {
        self.emit(op, "download-starting", "Starting update download...", null);
        if (self.checked == null) try self.check(op);
        const selection = &self.checked.?;
        const manifest = selection.manifest orelse return;
        if (std.mem.eql(u8, manifest.hash, self.config.local.hash)) return;
        // A macOS app can be launched before its first local updater record
        // exists. Preserve the SDK's lazy extraction-directory creation.
        const extraction = try protocol.extractionPath(self.allocator, self.config.channel_root);
        defer self.allocator.free(extraction);
        try protocol.ensurePrivateDirectory(self.allocator, self.io, extraction);
        if (try self.prepared()) |existing| {
            defer existing.deinit();
            if (protocol.preparedMatches(existing.value, manifest)) {
                try self.setInfo(.{ .version = manifest.version, .hash = manifest.hash, .updateAvailable = true, .updateReady = true });
                self.emit(op, "download-complete", "Update is already prepared", .{ .latestHash = manifest.hash });
                return;
            }
        }
        self.emit(op, "downloading", "Preparing the update with the native updater...", .{ .latestHash = manifest.hash });
        var diagnostics: handoff.Diagnostics = .{};
        handoff.prepareWithDiagnostics(self.allocator, self.io, &self.config, manifest, if (self.config.local.managed != null) selection.download_base_url else null, if (self.config.local.managed != null) (if (self.config.installation_id) |*id| id else null) else null, &diagnostics) catch |err| {
            if (diagnostics.message().len != 0) op.failure_detail = try op.arena.allocator().dupe(u8, diagnostics.message());
            return err;
        };
        const staged = try self.prepared() orelse return error.NativePreparationMissingStage;
        defer staged.deinit();
        if (staged.value.schema_version != 2 or !protocol.preparedMatches(staged.value, manifest)) return error.NativePreparationStageMismatch;
        try self.setInfo(.{ .version = manifest.version, .hash = manifest.hash, .updateAvailable = true, .updateReady = true });
        self.emit(op, "download-complete", "Update downloaded, verified, and staged", .{ .latestHash = manifest.hash });
    }

    fn apply(self: *Engine, op: *Operation) !void {
        if (std.mem.eql(u8, self.config.local.channel, "dev") or self.config.local.updateAuthority != .direct) {
            self.emit(op, "no-update", "Direct updates are disabled for this build", null);
            return;
        }
        const staged = try protocol.loadPrepared(self.allocator, self.io, self.config);
        defer staged.deinit();
        if (std.mem.eql(u8, staged.value.hash, self.config.local.hash)) {
            self.emit(op, "no-update", "Already on latest version", .{ .currentHash = self.config.local.hash });
            return;
        }
        const fingerprint = try preparedFingerprint(self.allocator, staged.value);
        if (!op.approved) {
            self.mutex.lockUncancelable(self.io);
            defer self.mutex.unlock(self.io);
            if (op.cancel_requested) return error.Canceled;
            op.approval = .{ .id = randomId(self.io), .prepared_hash = fingerprint };
            return;
        }
        if (!std.mem.eql(u8, &fingerprint, &op.approval.?.prepared_hash)) return error.PreparedUpdateChanged;
        try Io.checkCancel(self.io);
        op.handoff_started = true;
        self.emit(op, "applying", "Preparing update handoff...", null);
        _ = try results.cleanupOlder(self.allocator, self.io, self.config.local, self.config.channel_root);
        var staged_handoff = try handoff.stage(self.allocator, self.io, &self.config, staged.value, null);
        defer staged_handoff.deinit();
        handoff.handoff(self.allocator, self.io, &staged_handoff) catch |err| {
            if (staged_handoff.diagnostics.message().len != 0) op.failure_detail = try op.arena.allocator().dupe(u8, staged_handoff.diagnostics.message());
            return err;
        };
        // The helper now owns its files/process. Shutdown must not revoke a
        // successful handoff, nor may Core force the runtime to exit.
        self.mutex.lockUncancelable(self.io);
        self.quit_ready = true;
        self.revision +%= 1;
        self.emitLocked(op, "launching-new-version", "Update prepared; restarting application...", null);
        self.mutex.unlock(self.io);
    }

    fn reconcile(self: *Engine, op: *Operation) !void {
        const staged = try self.prepared();
        defer if (staged) |value| value.deinit();
        const result = try results.reconcile(self.allocator, self.io, self.config.local, self.config.channel_root, if (staged) |value| value.value else null) orelse return;
        defer results.freeResult(self.allocator, result);
        if (self.observed_transaction) |id| if (std.mem.eql(u8, &id, result.transaction_id)) return;
        self.observed_transaction = result.transaction_id[0..32].*;
        if (result.success) {
            try self.setInfo(.{ .version = result.version, .hash = result.hash });
            const message = try std.fmt.allocPrint(self.allocator, "Update to {s} completed successfully", .{result.version});
            defer self.allocator.free(message);
            self.emit(op, "complete", message, .{ .currentHash = result.hash, .latestHash = result.hash });
        } else {
            const message = try std.fmt.allocPrint(self.allocator, "Update to {s} failed during {s}: {s}", .{ result.version, @tagName(result.phase), result.message });
            defer self.allocator.free(message);
            try self.setInfo(.{ .version = result.version, .hash = result.hash, .updateAvailable = !std.mem.eql(u8, result.hash, self.config.local.hash), .@"error" = message });
            self.emit(op, "error", message, .{ .currentHash = self.config.local.hash, .latestHash = result.hash, .errorMessage = result.message });
        }
    }
};

fn envelope(a: A, accepted: bool, id: ?[]const u8, message: ?[]const u8) ![]u8 {
    return std.json.Stringify.valueAlloc(a, .{ .schemaVersion = @as(u32, 1), .accepted = accepted, .operationId = id, .@"error" = message }, .{});
}

fn randomId(io: Io) [32]u8 {
    var bytes: [16]u8 = undefined;
    io.random(&bytes);
    return std.fmt.bytesToHex(bytes, .lower);
}

fn copyInfo(a: A, info: UpdateInfo) !UpdateInfo {
    const version = try a.dupe(u8, info.version);
    errdefer a.free(version);
    const hash = try a.dupe(u8, info.hash);
    errdefer a.free(hash);
    return .{ .version = version, .hash = hash, .updateAvailable = info.updateAvailable, .updateReady = info.updateReady, .@"error" = try a.dupe(u8, info.@"error") };
}

fn freeInfo(a: A, info: UpdateInfo) void {
    a.free(info.version);
    a.free(info.hash);
    a.free(info.@"error");
}

fn preparedFingerprint(a: A, prepared: protocol.Prepared) ![64]u8 {
    const bytes = try std.json.Stringify.valueAlloc(a, prepared, .{});
    defer a.free(bytes);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(bytes, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

const TestFixture = struct {
    temporary: std.testing.TmpDir,
    engine: Engine,

    fn init() !TestFixture {
        var temporary = std.testing.tmpDir(.{ .iterate = true });
        errdefer temporary.cleanup();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const root = try temporary.dir.realPathFileAlloc(std.testing.io, ".", a);
        const bundle = try std.fs.path.join(a, &.{ root, "Fixture.app" });
        const resources = try std.fs.path.join(a, &.{ bundle, if (protocol.native_platform == .macos) "Contents/Resources" else "Resources" });
        try Io.Dir.cwd().createDirPath(std.testing.io, resources);
        return .{ .temporary = temporary, .engine = try Engine.init(std.testing.allocator, std.testing.io, .{
            .arena = arena,
            .local = .{ .identifier = "dev.electrobun.core-test", .channel = "canary", .version = "1.0.0", .hash = "old123", .baseUrl = "https://example.invalid", .name = "Fixture" },
            .exe_dir = bundle,
            .resources_dir = resources,
            .channel_root = root,
            .app_bundle_path = bundle,
            .storage_path = root,
            .base_url = "https://example.invalid",
        }) };
    }

    fn deinit(self: *TestFixture) void {
        self.engine.deinit();
        self.temporary.cleanup();
    }

    fn writePrepared(self: *TestFixture, hash: []const u8) !void {
        const a = std.testing.allocator;
        const root = self.engine.config.channel_root;
        const extraction = try protocol.extractionPath(a, root);
        defer a.free(extraction);
        try protocol.ensurePrivateDirectory(a, std.testing.io, extraction);
        const tar = try protocol.retainedTarPath(a, root, hash);
        defer a.free(tar);
        try Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = tar, .data = "retained tar fixture" });
        const record_path = try protocol.preparedPath(a, root);
        defer a.free(record_path);
        try protocol.atomicWriteJson(a, std.testing.io, root, record_path, protocol.Prepared{
            .identifier = self.engine.config.local.identifier,
            .channel = "canary",
            .version = "1.0.0",
            .hash = hash,
            .platform = protocol.native_platform,
            .arch = protocol.native_arch,
            .retained_tar_path = tar,
            .artifact_file = "canary-macos-arm64-Fixture.app.tar.zst",
        }, 0o600);
    }

    fn noApplyResources(self: *TestFixture) !void {
        var iterator = self.temporary.dir.iterate();
        while (try iterator.next(std.testing.io)) |entry| {
            try std.testing.expect(!std.mem.startsWith(u8, entry.name, ".electrobun-update-"));
        }
    }
};

fn testRequest(engine: *Engine, request: anytype) ![32]u8 {
    const a = std.testing.allocator;
    const bytes = try std.json.Stringify.valueAlloc(a, request, .{});
    defer a.free(bytes);
    const response = try engine.requestJson(bytes);
    defer a.free(response);
    const parsed = try std.json.parseFromSlice(struct { schemaVersion: u32, accepted: bool, operationId: ?[]const u8, @"error": ?[]const u8 }, a, response, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value.accepted);
    try std.testing.expectEqual(@as(usize, 32), parsed.value.operationId.?.len);
    return parsed.value.operationId.?[0..32].*;
}

fn testState(engine: *Engine, id: []const u8, expected: OperationState) !void {
    for (0..400) |_| {
        engine.mutex.lockUncancelable(engine.io);
        const state = if (engine.findLocked(id)) |op| op.state else OperationState.idle;
        engine.mutex.unlock(engine.io);
        if (state == expected) return;
        if ((state == .failed or state == .cancelled) and expected != state) return error.UnexpectedOperationFailure;
        try Io.sleep(engine.io, .fromMilliseconds(5), .awake);
    }
    return error.OperationDidNotFinish;
}

fn testApproval(engine: *Engine, id: []const u8) ![32]u8 {
    try testState(engine, id, .awaitingApproval);
    engine.mutex.lockUncancelable(engine.io);
    defer engine.mutex.unlock(engine.io);
    return engine.findLocked(id).?.approval.?.id;
}

fn controlledWork(engine: *Engine, op: *Operation) !void {
    switch (op.action) {
        .reconcile => {},
        .check => {
            try Io.sleep(engine.io, .fromMilliseconds(50), .awake);
            try engine.setInfo(.{ .version = "1.0.0", .hash = "next123", .updateAvailable = true });
        },
        .download => try engine.setInfo(.{ .version = "1.0.0", .hash = "next123", .updateAvailable = true, .updateReady = true }),
        .requestApply => {},
    }
}

test "coalesced checks serialize downloads and retain completed operation results" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    const engine = &fixture.engine;
    engine.work_override = controlledWork;
    try engine.start();
    const check_id = try testRequest(engine, .{ .schemaVersion = 1, .action = "check" });
    const duplicate_id = try testRequest(engine, .{ .schemaVersion = 1, .action = "check" });
    try std.testing.expectEqualStrings(&check_id, &duplicate_id);
    const download_id = try testRequest(engine, .{ .schemaVersion = 1, .action = "download" });
    try testState(engine, &download_id, .completed);
    engine.mutex.lockUncancelable(engine.io);
    defer engine.mutex.unlock(engine.io);
    const check = engine.findLocked(&check_id).?;
    try std.testing.expectEqual(OperationState.completed, check.state);
    try std.testing.expect(check.update_info.?.updateAvailable);
    try std.testing.expect(!check.update_info.?.updateReady);
    try std.testing.expect(engine.findLocked(&download_id).?.update_info.?.updateReady);
}

test "requestApply validates existing stage then veto preserves it without side effects" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    try fixture.writePrepared("next123");
    try fixture.engine.setInfo(.{ .version = "1.0.0", .hash = "next123", .updateAvailable = true, .updateReady = true });
    try fixture.engine.start();
    const id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "requestApply" });
    const token = try testApproval(&fixture.engine, &id);
    try fixture.noApplyResources();
    const rejected = try fixture.engine.requestJson("{\"schemaVersion\":1,\"action\":\"download\"}");
    defer std.testing.allocator.free(rejected);
    try std.testing.expect(std.mem.indexOf(u8, rejected, "CannotDownloadDuringApply") != null);
    _ = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "approveApply", .operationId = &id, .approvalId = &token, .approved = false });
    try testState(&fixture.engine, &id, .cancelled);
    try fixture.noApplyResources();
    const staged = try protocol.loadPrepared(std.testing.allocator, std.testing.io, fixture.engine.config);
    defer staged.deinit();
    try std.testing.expectEqualStrings("next123", staged.value.hash);
    try std.testing.expect(fixture.engine.info.updateReady);
    try std.testing.expect(!fixture.engine.quit_ready);
}

test "stale approvals reject a replaced prepared record before helper or plan creation" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    try fixture.writePrepared("next123");
    try fixture.engine.setInfo(.{ .version = "1.0.0", .hash = "next123", .updateAvailable = true, .updateReady = true });
    try fixture.engine.start();
    const id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "requestApply" });
    const token = try testApproval(&fixture.engine, &id);
    try fixture.writePrepared("other456");
    _ = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "approveApply", .operationId = &id, .approvalId = &token, .approved = true });
    try testState(&fixture.engine, &id, .failed);
    try fixture.noApplyResources();
    const json = try fixture.engine.stateJson();
    defer std.testing.allocator.free(json);
    try std.testing.expect(std.mem.indexOf(u8, json, "PreparedUpdateChanged") != null);
    try std.testing.expect(!fixture.engine.quit_ready);
    try std.testing.expect(!fixture.engine.info.updateReady);
}

test "approval tokens are bound to operations and cannot be replayed after cancellation" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    try fixture.writePrepared("next123");
    try fixture.engine.start();
    const id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "requestApply" });
    const token = try testApproval(&fixture.engine, &id);
    const wrong_json = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .schemaVersion = 1, .action = "approveApply", .operationId = &id, .approvalId = "00000000000000000000000000000000", .approved = true }, .{});
    defer std.testing.allocator.free(wrong_json);
    const wrong = try fixture.engine.requestJson(wrong_json);
    defer std.testing.allocator.free(wrong);
    try std.testing.expect(std.mem.indexOf(u8, wrong, "InvalidApprovalId") != null);
    _ = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "cancel", .operationId = &id });
    const replay_json = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .schemaVersion = 1, .action = "approveApply", .operationId = &id, .approvalId = &token, .approved = true }, .{});
    defer std.testing.allocator.free(replay_json);
    const replay = try fixture.engine.requestJson(replay_json);
    defer std.testing.allocator.free(replay);
    try std.testing.expect(std.mem.indexOf(u8, replay, "OperationAlreadyFinished") != null);
    try fixture.noApplyResources();
}

var long_work_entered: std.atomic.Value(bool) = .init(false);
var long_work_exited: std.atomic.Value(bool) = .init(false);
fn longWork(engine: *Engine, op: *Operation) !void {
    if (op.action == .reconcile) return;
    long_work_entered.store(true, .release);
    defer long_work_exited.store(true, .release);
    try Io.sleep(engine.io, .fromSeconds(600), .awake);
}

test "queries and cancellation remain nonblocking while shutdown joins outstanding work" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    long_work_entered.store(false, .release);
    long_work_exited.store(false, .release);
    fixture.engine.work_override = longWork;
    try fixture.engine.start();
    const id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "check" });
    while (!long_work_entered.load(.acquire)) try Io.sleep(std.testing.io, .fromMilliseconds(1), .awake);
    const state = try fixture.engine.stateJson();
    defer std.testing.allocator.free(state);
    try std.testing.expect(std.mem.indexOf(u8, state, "running") != null);
    _ = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "cancel", .operationId = &id });
    try testState(&fixture.engine, &id, .cancelled);
    try std.testing.expect(long_work_exited.load(.acquire));
    long_work_entered.store(false, .release);
    long_work_exited.store(false, .release);
    _ = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "check" });
    while (!long_work_entered.load(.acquire)) try Io.sleep(std.testing.io, .fromMilliseconds(1), .awake);
    fixture.engine.stop();
    try std.testing.expect(long_work_exited.load(.acquire));
}

test "event history reports overflow and advances by the last delivered sequence" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    fixture.engine.mutex.lockUncancelable(fixture.engine.io);
    for (0..max_events + 4) |_| fixture.engine.emitLocked(null, "idle", "bounded history", .{ .usedPatchPath = true, .totalPatchesApplied = 2 });
    fixture.engine.mutex.unlock(fixture.engine.io);
    const first = try fixture.engine.eventsJson(0, 2);
    defer std.testing.allocator.free(first);
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, first, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value.object.get("overflow").?.bool);
    try std.testing.expectEqual(@as(i64, 6), parsed.value.object.get("nextSequence").?.integer);
    try std.testing.expectEqual(@as(usize, 2), parsed.value.object.get("entries").?.array.items.len);
    const empty = try fixture.engine.eventsJson(260, 0);
    defer std.testing.allocator.free(empty);
    try std.testing.expect(std.mem.indexOf(u8, empty, "\"nextSequence\":260") != null);
}

test "terminal operation history remains bounded and retains the latest result" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    const engine = &fixture.engine;
    engine.mutex.lockUncancelable(engine.io);
    defer engine.mutex.unlock(engine.io);
    for (0..100) |_| {
        const op = try engine.enqueueLocked(.check);
        engine.finishLocked(op, .completed, null);
    }
    try std.testing.expectEqual(@as(usize, max_operations), engine.operations.items.len);
    try std.testing.expect(engine.current.?.terminal());
    try std.testing.expect(engine.current.?.update_info != null);
}

test "dev external and none operations never consult network or require staging" {
    for ([_]enum { dev, external, none }{ .dev, .external, .none }) |disabled| {
        var fixture = try TestFixture.init();
        defer fixture.deinit();
        if (disabled == .dev) fixture.engine.config.local.channel = "dev" else {
            fixture.engine.config.local.updateAuthority = if (disabled == .external) .external else .none;
        }
        fixture.engine.config.base_url = "invalid URL must never be used";
        try fixture.engine.start();
        const id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "download" });
        try testState(&fixture.engine, &id, .completed);
        try std.testing.expect(!fixture.engine.info.updateAvailable);
        const apply_id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "requestApply" });
        try testState(&fixture.engine, &apply_id, .completed);
        try std.testing.expect(fixture.engine.approval_operation == null);
    }
}

test "reconciliation maps real success and failure files into public state and statuses" {
    for ([_]bool{ true, false }) |success| {
        var fixture = try TestFixture.init();
        defer fixture.deinit();
        const a = std.testing.allocator;
        const id = "123456789abcdef0123456789abcdef0";
        const target_hash = if (success) fixture.engine.config.local.hash else "new123";
        const result: protocol.Result = .{
            .schema_version = 1,
            .transaction_id = id,
            .success = success,
            .phase = if (success) .complete else .validating_payload,
            .message = if (success) "Activated" else "Invalid recipe",
            .identifier = fixture.engine.config.local.identifier,
            .channel = "canary",
            .version = fixture.engine.config.local.version,
            .hash = target_hash,
        };
        const filename = try std.fmt.allocPrint(a, ".electrobun-update-{s}.result.json", .{id});
        defer a.free(filename);
        const path = try std.fs.path.join(a, &.{ fixture.engine.config.channel_root, filename });
        defer a.free(path);
        try protocol.atomicWriteJson(a, std.testing.io, fixture.engine.config.channel_root, path, result, 0o600);
        try fixture.engine.start();
        const reconcile_id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "reconcile" });
        try testState(&fixture.engine, &reconcile_id, .completed);
        try std.testing.expectEqual(!success, fixture.engine.info.updateAvailable);
        try std.testing.expect(!fixture.engine.info.updateReady);
        try std.testing.expectEqual(success, fixture.engine.info.@"error".len == 0);
        const events = try fixture.engine.eventsJson(0, 256);
        defer a.free(events);
        try std.testing.expect(std.mem.indexOf(u8, events, if (success) "\"status\":\"complete\"" else "\"status\":\"error\"") != null);
        const old_sequence = fixture.engine.sequence;
        const again = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "reconcile" });
        try testState(&fixture.engine, &again, .completed);
        try std.testing.expectEqual(old_sequence, fixture.engine.sequence);
    }
}

const ManifestServer = struct {
    listener: Io.net.Server,
    body: []const u8,
    fn serve(self: *@This()) !void {
        const io = std.testing.io;
        const connection = try self.listener.accept(io);
        defer connection.close(io);
        var read_buffer: [4096]u8 = undefined;
        var reader = connection.reader(io, &read_buffer);
        const first = try reader.interface.takeDelimiterInclusive('\n');
        try std.testing.expect(std.mem.indexOf(u8, first, "-update.json?") != null);
        while (true) {
            const line = try reader.interface.takeDelimiterInclusive('\n');
            if (std.mem.eql(u8, line, "\r\n")) break;
            if (std.mem.indexOfScalar(u8, line, ':')) |colon| try std.testing.expect(!std.ascii.eqlIgnoreCase(line[0..colon], "X-Electrobun-Installation-Id"));
        }
        var write_buffer: [4096]u8 = undefined;
        var writer = connection.writer(io, &write_buffer);
        try writer.interface.print("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {d}\r\n\r\n{s}", .{ self.body.len, self.body });
        try writer.interface.flush();
    }
};

fn testManifest(config: protocol.Config, hash: []const u8) protocol.Manifest {
    return .{
        .schemaVersion = 1,
        .identifier = config.local.identifier,
        .channel = config.local.channel,
        .version = config.local.version,
        .hash = hash,
        .platform = config.platform,
        .arch = config.arch,
        .artifact = .{ .file = switch (protocol.native_platform) {
            .macos => if (protocol.native_arch == .arm64) "canary-macos-arm64-Fixture.app.tar.zst" else "canary-macos-x64-Fixture.app.tar.zst",
            .linux => if (protocol.native_arch == .arm64) "canary-linux-arm64-Fixture.tar.zst" else "canary-linux-x64-Fixture.tar.zst",
            .win => if (protocol.native_arch == .arm64) "canary-win-arm64-Fixture.tar.zst" else "canary-win-x64-Fixture.tar.zst",
        }, .tarSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", .tarSize = 512 },
    };
}

test "real checks compare hashes at identical versions and do not prepare downloads" {
    for ([_]bool{ true, false }) |changed| {
        var fixture = try TestFixture.init();
        defer fixture.deinit();
        const a = std.testing.allocator;
        const manifest = testManifest(fixture.engine.config, if (changed) "next123" else fixture.engine.config.local.hash);
        const body = try std.json.Stringify.valueAlloc(a, manifest, .{});
        defer a.free(body);
        const address = try Io.net.IpAddress.parse("127.0.0.1", 0);
        var server = ManifestServer{ .listener = try address.listen(std.testing.io, .{}), .body = body };
        defer server.listener.deinit(std.testing.io);
        const base = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{server.listener.socket.address.getPort()});
        defer a.free(base);
        fixture.engine.config.base_url = base;
        var serving = try Io.concurrent(std.testing.io, ManifestServer.serve, .{&server});
        defer serving.cancel(std.testing.io) catch {};
        try fixture.engine.start();
        const id = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "check" });
        try testState(&fixture.engine, &id, .completed);
        try serving.await(std.testing.io);
        try std.testing.expectEqual(changed, fixture.engine.info.updateAvailable);
        try std.testing.expect(!fixture.engine.info.updateReady);
        try std.testing.expectEqualStrings("1.0.0", fixture.engine.info.version);
        var iterator = fixture.temporary.dir.iterate();
        while (try iterator.next(std.testing.io)) |entry| try std.testing.expect(!std.mem.startsWith(u8, entry.name, ".electrobun-prepare-"));
    }
}

test "self-hosted download reaches native preparation and approved handoff preserves owned resources" {
    if (protocol.native_platform == .win) return error.SkipZigTest;
    // Match the dynamic Core's independent pool, whose default inherited
    // environment is empty (std.testing.io would conceal helper env bugs).
    var pool = Io.Threaded.init(std.testing.allocator, .{});
    defer pool.deinit();
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    const engine = &fixture.engine;
    engine.io = pool.io();
    const a = std.testing.allocator;
    const root = engine.config.channel_root;
    const selection_arena = std.heap.ArenaAllocator.init(a);
    const manifest = testManifest(engine.config, "next123");
    engine.checked = .{ .arena = selection_arena, .status = .available, .manifest = manifest, .download_base_url = engine.config.base_url };
    // Even if another service has loaded the local identity, self-hosted
    // preparation receives neither its header nor a managed URL override.
    engine.config.installation_id = "abcdef0123456789abcdef0123456789".*;
    try std.testing.expectError(error.FileNotFound, fixture.temporary.dir.access(std.testing.io, "self-extraction", .{}));
    const stage = try std.fmt.allocPrint(a, "{s}.prepared-next123", .{engine.config.app_bundle_path});
    defer a.free(stage);
    const recipe = try protocol.recipePath(a, root, "next123");
    defer a.free(recipe);
    const record_fixture = try std.fs.path.join(a, &.{ root, "prepared-fixture.json" });
    defer a.free(record_fixture);
    const record: protocol.Prepared = .{
        .schema_version = 2,
        .identifier = engine.config.local.identifier,
        .channel = "canary",
        .version = "1.0.0",
        .hash = "next123",
        .platform = protocol.native_platform,
        .arch = protocol.native_arch,
        .staging_path = stage,
        .recipe_path = recipe,
        .recipe_sha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .artifact_file = manifest.artifact.file,
    };
    try protocol.atomicWriteJson(a, std.testing.io, root, record_fixture, record, 0o600);
    const helper_path = try std.fs.path.join(a, &.{ engine.config.resources_dir, "uninstall" });
    defer a.free(helper_path);
    const helper_script =
        "#!/bin/sh\nset -eu\nroot=$(dirname \"$2\")\n" ++
        "if [ \"$1\" = --prepare-update ]; then\n" ++
        "cp \"$2\" \"$root/last-request.json\"\n" ++
        "mkdir -p \"$root/Fixture.app.prepared-next123\"\n" ++
        "printf recipe > \"$root/self-extraction/next123.recipe.json\"\n" ++
        "cp \"$root/prepared-fixture.json\" \"$root/self-extraction/.electrobun-prepared-update.json\"\n" ++
        "else\n: > \"$root/handoff-ran\"\nrm -f \"$0\"\nfi\n";
    const helper = try Io.Dir.cwd().createFile(std.testing.io, helper_path, .{ .permissions = .fromMode(0o700) });
    try helper.writeStreamingAll(std.testing.io, helper_script);
    helper.close(std.testing.io);
    try engine.start();
    const download_id = try testRequest(engine, .{ .schemaVersion = 1, .action = "download" });
    try testState(engine, &download_id, .completed);
    try std.testing.expect(engine.info.updateReady);
    const request_path = try std.fs.path.join(a, &.{ root, "last-request.json" });
    defer a.free(request_path);
    const request = try protocol.readBounded(a, std.testing.io, root, request_path, 64 * 1024);
    defer a.free(request);
    try std.testing.expect(std.mem.indexOf(u8, request, "installation_id") == null);
    try std.testing.expect(std.mem.indexOf(u8, request, "download_base_url") == null);
    const apply_id = try testRequest(engine, .{ .schemaVersion = 1, .action = "requestApply" });
    const approval_id = try testApproval(engine, &apply_id);
    _ = try testRequest(engine, .{ .schemaVersion = 1, .action = "approveApply", .operationId = &apply_id, .approvalId = &approval_id, .approved = true });
    try testState(engine, &apply_id, .completed);
    try std.testing.expect(engine.quit_ready);
    // Reaching this assertion proves Core did not exit the calling runtime.
    engine.stop();
    var found_plan = false;
    var iterator = fixture.temporary.dir.iterate();
    while (try iterator.next(std.testing.io)) |entry| if (std.mem.startsWith(u8, entry.name, ".electrobun-update-")) {
        found_plan = true;
    };
    try std.testing.expect(found_plan);
    for (0..100) |_| {
        fixture.temporary.dir.access(std.testing.io, "handoff-ran", .{}) catch {
            try Io.sleep(std.testing.io, .fromMilliseconds(5), .awake);
            continue;
        };
        return;
    }
    return error.DetachedHelperDidNotRun;
}

test "request JSON rejects enum and numeric coercion while ignoring extension fields" {
    var fixture = try TestFixture.init();
    defer fixture.deinit();
    for ([_][]const u8{
        "{\"schemaVersion\":\"1\",\"action\":\"check\"}",
        "{\"schemaVersion\":1,\"action\":0}",
        "{\"schemaVersion\":1,\"action\":\"check\",\"approved\":1}",
    }) |bytes| {
        const response = try fixture.engine.requestJson(bytes);
        defer std.testing.allocator.free(response);
        try std.testing.expect(std.mem.indexOf(u8, response, "\"accepted\":false") != null);
    }
    _ = try testRequest(&fixture.engine, .{ .schemaVersion = 1, .action = "check", .futureField = true });
}
