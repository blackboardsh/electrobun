//! Independent, best-effort telemetry. Nothing here participates in updating.
//! A bounded local queue keeps event IDs stable across retries and app restarts.
const std = @import("std");
const builtin = @import("builtin");
const Mutex = @import("synchronization.zig").Mutex;
const spool_storage = @import("insights_spool.zig");
const installation_identity = @import("installation_identity.zig");
const A = std.mem.Allocator;
const Io = std.Io;
const max_events = 128;
const max_event_bytes = 8 * 1024;
const max_queue_bytes = 512 * 1024;
const max_batch_bytes = 60 * 1024;
const day_ms: i64 = 86_400_000;
const max_age_ms = 30 * day_ms;
const checkpoint_ms = 60_000;

pub const Options = struct {
    appId: []const u8,
    apiUrl: []const u8 = "https://api.electrobun.dev",
    storagePath: []const u8,
    version: []const u8,
    buildHash: []const u8,
    channel: []const u8,
    platform: []const u8 = switch (builtin.os.tag) {
        .macos => "macos",
        .windows => "win",
        .linux => "linux",
        else => "unknown",
    },
    arch: []const u8 = switch (builtin.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        else => "unknown",
    },
    distribution: []const u8 = "direct",
    updateAuthority: []const u8 = "direct",
    /// Collection defaults off on every channel; a persisted user's choice takes precedence.
    enabled: ?bool = null,
};

const Entry = struct { header: []const u8, event: []const u8, id: []const u8, timestamp_ms: i64 };
const Stored = struct {
    installationId: []const u8,
    userId: ?[]const u8 = null,
    enabled: ?bool = null,
    customEventsEnabled: bool = true,
    retryAfterMs: i64 = 0,
};
// Delivery entries and the active session are committed together. After an
// interrupted exit, recovery promotes the exact saved entries into the outbox;
// it never reconstructs elapsed time from the next process's wall clock.
const SessionJournal = struct { days: []const Entry, interrupted: Entry };
const Spool = struct { schemaVersion: u8 = 2, entries: []const Entry, activeSession: ?SessionJournal = null };
const Batch = struct { body: []u8, ids: [32][32]u8, count: usize, consent_generation: u64 };
const Delivery = struct {
    acknowledged: bool = true,
    custom_events: ?bool = null,
    retry_after_ms: ?i64 = null,
};

pub const Reporter = struct {
    allocator: A,
    io: Io,
    arena: std.heap.ArenaAllocator,
    options: Options,
    endpoint: []const u8,
    state_path: []const u8,
    queue_path: []const u8,
    mutex: Mutex = .init,
    installation_id: [32]u8,
    session_id: [32]u8,
    user_id: ?[]u8 = null,
    collection_allowed: bool,
    enabled: bool,
    /// Only explicit runtime choices override later build defaults.
    consent_enabled: ?bool = null,
    consent_generation: u64 = 0,
    /// Server policy affects custom events only. Basic lifecycle collection
    /// continues while consent remains enabled, and responses can reactivate it.
    custom_events_enabled: bool = true,
    retry_after_ms: i64 = 0,
    queue: std.ArrayList(Entry) = .empty,
    queue_bytes: usize = 0,
    journal: std.ArrayList(Entry) = .empty,
    interrupted: ?Entry = null,
    app_session_id: [32]u8,
    app_started_ms: i64,
    app_duration_ms: u64 = 0,
    session_active: bool = false,
    lifecycle_id: [32]u8,
    sequence: u64 = 0,
    duration_ms: u64 = 0,
    current_day: i64,
    last_awake_ms: i64,
    last_real_ms: i64,
    last_snapshot_ms: i64,
    dirty: bool = false,
    flush_requested: bool = true,
    future: ?Io.Future(void) = null,
    stopped: std.atomic.Value(bool) = .init(false),
    // Injectable transport is private to same-file tests.
    send_context: ?*anyopaque = null,
    send_fn: *const fn (?*anyopaque, A, Io, []const u8, []const u8) anyerror!Delivery = sendHttp,

    pub fn init(a: A, io: Io, options: Options) !Reporter {
        if (options.appId.len == 0 or options.appId.len > 128 or options.storagePath.len == 0 or
            options.version.len == 0 or options.version.len > 128 or options.buildHash.len == 0 or options.buildHash.len > 128 or
            (!eq(options.channel, "stable") and !eq(options.channel, "canary") and !eq(options.channel, "dev"))) return error.InvalidInsightsOptions;
        if (!validToken(options.platform, 32, true) or !validToken(options.arch, 32, false) or
            !validToken(options.distribution, 64, true) or !std.unicode.utf8ValidateSlice(options.version) or
            !std.unicode.utf8ValidateSlice(options.buildHash)) return error.InvalidInsightsOptions;
        for (options.appId) |c| if (!std.ascii.isAlphanumeric(c) and c != '-' and c != '_') return error.InvalidInsightsAppId;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const owned = arena.allocator();
        const copy = try std.json.Stringify.valueAlloc(owned, options, .{});
        const parsed = try std.json.parseFromSlice(Options, owned, copy, .{ .allocate = .alloc_always });
        var base = std.mem.trimEnd(u8, options.apiUrl, "/");
        if (std.mem.endsWith(u8, base, "/v1/electrobun")) base = base[0 .. base.len - "/v1/electrobun".len];
        const endpoint = try std.fmt.allocPrint(owned, "{s}/v1/electrobun/apps/{s}/insights", .{ base, options.appId });
        const uri = try checkedUri(endpoint);
        const identity_options: installation_identity.Options = .{ .appId = options.appId, .storagePath = options.storagePath };
        const installation_id = installation_identity.loadOrCreate(a, io, identity_options) catch |err| switch (err) {
            error.InvalidInstallationIdentity => return error.InvalidInsightsIdentity,
            else => return err,
        };
        const directory = try installation_identity.directory(owned, identity_options);
        try Io.Dir.cwd().createDirPath(io, directory);
        const state_path = try std.fs.path.join(owned, &.{ directory, "identity.json" });
        const queue_path = try std.fs.path.join(owned, &.{ directory, "queue.json" });
        const now = Io.Clock.real.now(io).toMilliseconds();
        const awake = Io.Clock.awake.now(io).toMilliseconds();
        var self: Reporter = .{
            .allocator = a,
            .io = io,
            .arena = arena,
            .options = parsed.value,
            .endpoint = endpoint,
            .state_path = state_path,
            .queue_path = queue_path,
            .installation_id = installation_id,
            .session_id = randomId(io),
            .app_session_id = randomId(io),
            .app_started_ms = now,
            .lifecycle_id = randomId(io),
            .collection_allowed = !eq(options.channel, "dev") or (options.enabled == true and eq(uri.scheme, "http")),
            .enabled = options.enabled orelse false,
            .current_day = @divFloor(now, day_ms),
            .last_awake_ms = awake,
            .last_real_ms = now,
            .last_snapshot_ms = awake,
        };
        errdefer {
            for (self.queue.items) |entry| self.freeEntry(entry);
            self.queue.deinit(a);
            self.clearJournal();
            self.journal.deinit(a);
            if (self.user_id) |user| a.free(user);
        }
        const initial = try std.json.Stringify.valueAlloc(a, Stored{ .installationId = &self.installation_id }, .{});
        defer a.free(initial);
        spool_storage.write(a, io, state_path, initial, 4096, false) catch |err| if (err != error.PathAlreadyExists) return err;
        const bytes = try spool_storage.read(a, io, state_path, 4096);
        defer a.free(bytes);
        const state = try std.json.parseFromSlice(Stored, a, bytes, .{});
        defer state.deinit();
        if (!validId(state.value.installationId) or !eq(state.value.installationId, &self.installation_id)) return error.InvalidInsightsIdentity;
        if (state.value.userId) |user| if (validText(user, 256)) {
            self.user_id = try a.dupe(u8, user);
        };
        self.consent_enabled = state.value.enabled;
        self.custom_events_enabled = state.value.customEventsEnabled;
        self.retry_after_ms = @max(0, state.value.retryAfterMs);
        self.enabled = self.consent_enabled orelse self.enabled;
        // Dev builds may exercise telemetry against an explicitly opted-in
        // loopback test server, but must never submit unsupported dev channels
        // to the public service. Persisted opt-ins cannot override this guard.
        self.enabled = self.enabled and self.collection_allowed;
        if (self.enabled) self.loadQueue() catch {};
        if (!self.custom_events_enabled) self.dropCustomEvents();
        self.dirty = true;
        return self;
    }

    pub fn start(self: *Reporter) !void {
        if (self.future != null or self.stopped.load(.acquire)) return;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.enabled and !self.session_active) try self.beginSession();
        // Never dispatch an event which cannot be recovered after a crash.
        try self.persist();
        self.future = try Io.concurrent(self.io, run, .{self});
    }

    /// Cancellation joins HTTP and timer tasks. Shutdown never waits for a
    /// network acknowledgement; the final duration snapshot remains on disk.
    pub fn stop(self: *Reporter) void {
        if (self.stopped.swap(true, .acq_rel)) return;
        if (self.future) |*future| future.cancel(self.io);
        self.future = null;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.enabled and self.session_active) {
            self.advance(Io.Clock.awake.now(self.io).toMilliseconds(), Io.Clock.real.now(self.io).toMilliseconds());
            self.finishSession() catch {};
        }
        self.persist() catch {};
    }

    pub fn deinit(self: *Reporter) void {
        self.stop();
        for (self.queue.items) |entry| self.freeEntry(entry);
        self.queue.deinit(self.allocator);
        self.clearJournal();
        self.journal.deinit(self.allocator);
        if (self.user_id) |user| self.allocator.free(user);
        self.arena.deinit();
    }

    pub fn installationId(self: *Reporter, a: A) ![:0]u8 {
        return a.dupeSentinel(u8, &self.installation_id, 0);
    }

    pub fn track(self: *Reporter, name: []const u8, properties_json: []const u8) !void {
        if (!validName(name, 80, true) or isLifecycleName(name) or properties_json.len > max_event_bytes) return error.InvalidInsightsEvent;
        const properties = try std.json.parseFromSlice(std.json.Value, self.allocator, properties_json, .{});
        defer properties.deinit();
        if (!validProperties(properties.value)) return error.InvalidInsightsProperties;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (!self.enabled or !self.custom_events_enabled or self.stopped.load(.acquire)) return error.InsightsDisabled;
        const now = Io.Clock.real.now(self.io).toMilliseconds();
        self.advance(Io.Clock.awake.now(self.io).toMilliseconds(), now);
        const id = randomId(self.io);
        const timestamp = timestampString(now);
        const event = try std.json.Stringify.valueAlloc(self.allocator, .{
            .id = &id,
            .kind = "custom",
            .timestamp = &timestamp,
            .sequence = self.sequence,
            .name = name,
            .userId = self.user_id,
            .properties = properties.value,
        }, .{ .emit_null_optional_fields = false });
        if (!fitsEventBytes(event, properties.value)) {
            self.allocator.free(event);
            return error.InvalidInsightsEvent;
        }
        try self.enqueue(event, &id, now, null);
    }

    /// Optional association changes affect future custom events only. They do
    /// not represent app opens/closes or change any lifecycle timing or IDs.
    pub fn identify(self: *Reporter, user: ?[]const u8) !void {
        if (user) |value| if (value.len == 0 or value.len > 256 or !std.unicode.utf8ValidateSlice(value)) return error.InvalidInsightsUser;
        const replacement = if (user) |value| try self.allocator.dupe(u8, value) else null;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (optionalEq(self.user_id, replacement)) {
            if (replacement) |value| self.allocator.free(value);
            return;
        }
        if (self.user_id) |value| self.allocator.free(value);
        self.user_id = replacement;
        self.dirty = true;
        // Association changes must survive an immediate process exit or crash.
        self.persist() catch {};
    }

    pub fn setEnabled(self: *Reporter, enabled: bool) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        const allowed = enabled and self.collection_allowed;
        self.consent_enabled = enabled;
        self.dirty = true;
        if (self.enabled == allowed) {
            self.persist() catch {};
            return;
        }
        self.enabled = allowed;
        self.consent_generation +%= 1;
        // An opt-out discards pending telemetry as well as stopping collection.
        for (self.queue.items) |entry| self.freeEntry(entry);
        self.queue.clearRetainingCapacity();
        self.queue_bytes = 0;
        self.clearJournal();
        self.session_active = false;
        self.rotateSession();
        if (allowed) self.beginSession() catch {};
        self.dirty = true;
        self.persist() catch {};
    }

    pub fn flush(self: *Reporter) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.enabled and self.session_active) {
            self.advance(Io.Clock.awake.now(self.io).toMilliseconds(), Io.Clock.real.now(self.io).toMilliseconds());
            self.checkpoint(self.last_real_ms) catch {};
        }
        self.persist() catch {};
        self.flush_requested = true;
    }

    fn rotateSession(self: *Reporter) void {
        self.session_id = randomId(self.io);
        self.duration_ms = 0;
        self.sequence = 0;
        self.last_awake_ms = Io.Clock.awake.now(self.io).toMilliseconds();
        self.last_real_ms = Io.Clock.real.now(self.io).toMilliseconds();
        self.last_snapshot_ms = self.last_awake_ms;
        self.current_day = @divFloor(self.last_real_ms, day_ms);
    }

    fn beginSession(self: *Reporter) !void {
        if (self.session_active) return;
        self.session_active = true;
        self.app_session_id = self.session_id;
        self.app_started_ms = self.last_real_ms;
        self.app_duration_ms = 0;
        self.lifecycle_id = randomId(self.io);
        const open_id = randomId(self.io);
        try self.appendQueue(try self.lifecycleEntry("electrobun.app.open", self.last_real_ms, &open_id), null);
        // Count the open session immediately, while subsequent duration stays
        // local until close/recovery. This is not a periodic network heartbeat.
        try self.snapshot(self.last_real_ms);
        try self.checkpoint(self.last_real_ms);
    }

    fn lifecycleEntry(self: *Reporter, name: []const u8, real: i64, id: []const u8) !Entry {
        const timestamp = timestampString(real);
        const started = timestampString(self.app_started_ms);
        const ended: ?[]const u8 = if (eq(name, "electrobun.app.open")) null else &timestamp;
        const event = try std.json.Stringify.valueAlloc(self.allocator, .{
            .id = id,
            .kind = "custom",
            .timestamp = &timestamp,
            .sequence = self.sequence,
            .name = name,
            .properties = .{
                .appSessionId = &self.app_session_id,
                .startedAt = &started,
                .endedAt = ended,
                .durationMs = @min(self.app_duration_ms, 9_007_199_254_740_991),
            },
        }, .{ .emit_null_optional_fields = false });
        return self.makeEntry(event, id, real);
    }

    /// Replace only local state. No duration entry enters the delivery outbox
    /// on this path, including UTC midnight and explicit flush requests.
    fn checkpoint(self: *Reporter, real: i64) !void {
        const entry = try self.durationEntry(real);
        errdefer self.freeEntry(entry);
        const interrupted = try self.lifecycleEntry("electrobun.app.interrupted", real, &self.lifecycle_id);
        errdefer self.freeEntry(interrupted);
        try self.journal.ensureUnusedCapacity(self.allocator, 1);
        const day = dayString(self.current_day * day_ms);
        var index: usize = 0;
        while (index < self.journal.items.len) {
            const previous = self.journal.items[index];
            var replace = real - previous.timestamp_ms > max_age_ms;
            if (!replace and eq(entry.header, previous.header)) {
                const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, previous.event, .{}) catch null;
                if (parsed) |value| {
                    defer value.deinit();
                    replace = eq(stringField(value.value, "day") orelse "", &day);
                }
            }
            if (replace) self.freeEntry(self.journal.orderedRemove(index)) else index += 1;
        }
        while (self.journal.items.len >= max_events) self.freeEntry(self.journal.orderedRemove(0));
        self.journal.appendAssumeCapacity(entry);
        if (self.interrupted) |previous| self.freeEntry(previous);
        self.interrupted = interrupted;
        self.last_snapshot_ms = self.last_awake_ms;
        self.dirty = true;
    }

    fn finishSession(self: *Reporter) !void {
        try self.checkpoint(self.last_real_ms);
        for (self.journal.items) |entry| try self.appendQueue(try self.copyEntry(entry), self.entryDay(entry));
        try self.appendQueue(try self.lifecycleEntry("electrobun.app.close", self.last_real_ms, &self.lifecycle_id), null);
        self.clearJournal();
        self.session_active = false;
        self.dirty = true;
    }

    fn clearJournal(self: *Reporter) void {
        for (self.journal.items) |entry| self.freeEntry(entry);
        self.journal.clearRetainingCapacity();
        if (self.interrupted) |entry| self.freeEntry(entry);
        self.interrupted = null;
    }

    fn copyEntry(self: *Reporter, entry: Entry) !Entry {
        const header = try self.allocator.dupe(u8, entry.header);
        errdefer self.allocator.free(header);
        const event = try self.allocator.dupe(u8, entry.event);
        errdefer self.allocator.free(event);
        return .{ .header = header, .event = event, .id = try self.allocator.dupe(u8, entry.id), .timestamp_ms = entry.timestamp_ms };
    }

    fn entryDay(self: *Reporter, entry: Entry) ?i64 {
        // Native duration timestamps fall on their own day or its closing
        // midnight. Parse the stored day instead of using the delivery date.
        var parsed = std.json.parseFromSlice(std.json.Value, self.allocator, entry.event, .{}) catch return null;
        defer parsed.deinit();
        if (!eq(stringField(parsed.value, "kind") orelse "", "session")) return null;
        const day = stringField(parsed.value, "day") orelse return null;
        const timestamp_day = @divFloor(entry.timestamp_ms, day_ms);
        return if (eq(day, &dayString(entry.timestamp_ms))) timestamp_day else timestamp_day - 1;
    }

    fn advance(self: *Reporter, awake: i64, real: i64) void {
        // Clock.awake excludes suspend on macOS/Linux. The cap additionally
        // avoids counting long suspend/scheduling gaps on clock fallbacks.
        const delta: u64 = @intCast(std.math.clamp(awake - self.last_awake_ms, 0, 10_000));
        self.app_duration_ms +|= delta;
        const today = @divFloor(real, day_ms);
        if (today != self.current_day) {
            const before: u64 = @intCast(std.math.clamp((self.current_day + 1) * day_ms - self.last_real_ms, 0, @as(i64, @intCast(delta))));
            self.duration_ms = @min(day_ms, self.duration_ms + before);
            self.checkpoint(self.last_real_ms + @as(i64, @intCast(before))) catch {};
            self.current_day = today;
            self.duration_ms = delta - before;
        } else self.duration_ms = @min(day_ms, self.duration_ms + delta);
        self.last_awake_ms = awake;
        self.last_real_ms = real;
    }

    fn snapshot(self: *Reporter, real: i64) !void {
        const entry = try self.durationEntry(real);
        try self.appendQueue(entry, self.current_day);
    }

    fn durationEntry(self: *Reporter, real: i64) !Entry {
        const id = randomId(self.io);
        const timestamp = timestampString(real);
        const day = dayString(self.current_day * day_ms);
        const event = try std.json.Stringify.valueAlloc(self.allocator, .{
            .id = &id,
            .kind = "session",
            .timestamp = &timestamp,
            .sequence = self.sequence,
            .durationMs = self.duration_ms,
            .day = &day,
            .appSessionId = &self.app_session_id,
        }, .{ .emit_null_optional_fields = false });
        return self.makeEntry(event, &id, real);
    }

    fn enqueue(self: *Reporter, event: []u8, id: []const u8, now: i64, snapshot_day: ?i64) !void {
        const entry = try self.makeEntry(event, id, now);
        try self.appendQueue(entry, snapshot_day);
    }

    fn makeEntry(self: *Reporter, event: []u8, id: []const u8, now: i64) !Entry {
        errdefer self.allocator.free(event);
        if (event.len > max_event_bytes) return error.InvalidInsightsEvent;
        const header = try std.json.Stringify.valueAlloc(self.allocator, .{
            .schemaVersion = 1,
            .installationId = &self.installation_id,
            .sessionId = &self.session_id,
            .appVersion = self.options.version,
            .buildHash = self.options.buildHash,
            .channel = self.options.channel,
            .os = self.options.platform,
            .arch = self.options.arch,
            .distribution = self.options.distribution,
        }, .{});
        errdefer self.allocator.free(header);
        const owned_id = try self.allocator.dupe(u8, id);
        errdefer self.allocator.free(owned_id);
        return .{ .header = header, .event = event, .id = owned_id, .timestamp_ms = now };
    }

    fn appendQueue(self: *Reporter, entry: Entry, snapshot_day: ?i64) !void {
        errdefer self.freeEntry(entry);
        for (self.queue.items) |previous| if (eq(previous.id, entry.id)) {
            self.freeEntry(entry);
            return;
        };
        try self.queue.ensureUnusedCapacity(self.allocator, 1);
        // Cumulative snapshots supersede older pending snapshots for this day.
        // Preserve custom events and prior days, and always use the NEW ID so
        // an acknowledgement for an in-flight old snapshot cannot remove it.
        if (snapshot_day) |day| {
            const day_text = dayString(day * day_ms);
            var index: usize = 0;
            while (index < self.queue.items.len) {
                const previous = self.queue.items[index];
                if (!eq(entry.header, previous.header)) {
                    index += 1;
                    continue;
                }
                const old = std.json.parseFromSlice(std.json.Value, self.allocator, previous.event, .{}) catch {
                    index += 1;
                    continue;
                };
                defer old.deinit();
                if (eq(stringField(old.value, "kind") orelse "", "session") and eq(stringField(old.value, "day") orelse "", &day_text)) {
                    self.remove(index);
                } else index += 1;
            }
        }
        const size = entry.header.len + entry.event.len;
        while (self.queue.items.len != 0 and (self.queue.items.len >= max_events or self.queue_bytes + size > max_queue_bytes)) {
            var oldest: usize = 0;
            for (self.queue.items, 0..) |previous, index| {
                if (previous.timestamp_ms < self.queue.items[oldest].timestamp_ms) oldest = index;
            }
            // Local daily totals can be promoted after much newer custom
            // events. Preserve recent data regardless of append order.
            if (entry.timestamp_ms < self.queue.items[oldest].timestamp_ms) {
                self.freeEntry(entry);
                return;
            }
            self.remove(oldest);
        }
        self.queue.appendAssumeCapacity(entry);
        self.queue_bytes += size;
        self.sequence = (self.sequence + 1) % 9_007_199_254_740_992;
        self.dirty = true;
    }

    fn freeEntry(self: *Reporter, entry: Entry) void {
        self.allocator.free(entry.header);
        self.allocator.free(entry.event);
        self.allocator.free(entry.id);
    }

    fn remove(self: *Reporter, index: usize) void {
        const entry = self.queue.orderedRemove(index);
        self.queue_bytes -= entry.header.len + entry.event.len;
        self.freeEntry(entry);
        self.dirty = true;
    }

    fn dropCustomEvents(self: *Reporter) void {
        var index: usize = 0;
        while (index < self.queue.items.len) {
            const parsed = std.json.parseFromSlice(std.json.Value, self.allocator, self.queue.items[index].event, .{}) catch {
                self.remove(index);
                continue;
            };
            defer parsed.deinit();
            const basic = eq(stringField(parsed.value, "kind") orelse "", "session") or
                isLifecycleName(stringField(parsed.value, "name") orelse "");
            if (basic) index += 1 else self.remove(index);
        }
    }

    fn applyDelivery(self: *Reporter, delivery: Delivery, now: i64) void {
        if (delivery.custom_events) |allowed| {
            if (self.custom_events_enabled != allowed) {
                self.custom_events_enabled = allowed;
                self.dirty = true;
            }
            if (!allowed) self.dropCustomEvents();
        }
        if (delivery.retry_after_ms) |delay| {
            self.retry_after_ms = now +| @max(0, delay);
            self.dirty = true;
        } else if (delivery.acknowledged and self.retry_after_ms != 0) {
            self.retry_after_ms = 0;
            self.dirty = true;
        }
    }

    fn batch(self: *Reporter) !?Batch {
        const now = Io.Clock.real.now(self.io).toMilliseconds();
        var i: usize = 0;
        while (i < self.queue.items.len) {
            if (now - self.queue.items[i].timestamp_ms > max_age_ms) self.remove(i) else i += 1;
        }
        if (!self.enabled or self.queue.items.len == 0) return null;
        const header = self.queue.items[0].header;
        var out: std.Io.Writer.Allocating = .init(self.allocator);
        errdefer out.deinit();
        try out.writer.writeAll(header[0 .. header.len - 1]);
        try out.writer.writeAll(",\"events\":[");
        var result: Batch = .{ .body = undefined, .ids = undefined, .count = 0, .consent_generation = self.consent_generation };
        for (self.queue.items) |entry| {
            if (result.count == result.ids.len or !eq(header, entry.header) or out.written().len + entry.event.len + 3 > max_batch_bytes) break;
            if (result.count != 0) try out.writer.writeByte(',');
            try out.writer.writeAll(entry.event);
            @memcpy(&result.ids[result.count], entry.id);
            result.count += 1;
        }
        try out.writer.writeAll("]}");
        result.body = try out.toOwnedSlice();
        return result;
    }

    fn acknowledge(self: *Reporter, sent: Batch) void {
        for (sent.ids[0..sent.count]) |id| {
            for (self.queue.items, 0..) |entry, index| {
                if (eq(entry.id, &id)) {
                    self.remove(index);
                    break;
                }
            }
        }
    }

    fn mayDispatch(self: *Reporter, sent: Batch) bool {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        return self.enabled and sent.consent_generation == self.consent_generation and !self.stopped.load(.acquire);
    }

    fn persist(self: *Reporter) !void {
        if (!self.dirty) return;
        const state = try std.json.Stringify.valueAlloc(self.allocator, Stored{
            .installationId = &self.installation_id,
            .userId = self.user_id,
            .enabled = self.consent_enabled,
            .customEventsEnabled = self.custom_events_enabled,
            .retryAfterMs = self.retry_after_ms,
        }, .{});
        defer self.allocator.free(state);
        try spool_storage.write(self.allocator, self.io, self.state_path, state, 4096, true);
        const active: ?SessionJournal = if (self.session_active and self.interrupted != null)
            .{ .days = self.journal.items, .interrupted = self.interrupted.? }
        else
            null;
        const queue = try std.json.Stringify.valueAlloc(self.allocator, Spool{
            .entries = self.queue.items,
            .activeSession = active,
        }, .{});
        defer self.allocator.free(queue);
        try spool_storage.write(self.allocator, self.io, self.queue_path, queue, 3 * max_queue_bytes, true);
        self.dirty = false;
    }

    fn loadQueue(self: *Reporter) !void {
        const bytes = try spool_storage.read(self.allocator, self.io, self.queue_path, 3 * max_queue_bytes);
        defer self.allocator.free(bytes);
        // Read the old JSON-array spool as well as the journal-aware format.
        // The next successful persist migrates it to the encoded envelope.
        const trimmed = std.mem.trimStart(u8, bytes, " \r\n\t");
        if (trimmed.len > 0 and trimmed[0] == '[') {
            const legacy = try std.json.parseFromSlice([]Entry, self.allocator, bytes, .{});
            defer legacy.deinit();
            for (legacy.value) |entry| try self.restoreEntry(entry);
            return;
        }
        const parsed = try std.json.parseFromSlice(Spool, self.allocator, bytes, .{});
        defer parsed.deinit();
        if (parsed.value.schemaVersion != 2) return error.InvalidInsightsSpool;
        var recovered: std.ArrayList(Entry) = .empty;
        defer recovered.deinit(self.allocator);
        try recovered.appendSlice(self.allocator, parsed.value.entries);
        if (parsed.value.activeSession) |active| {
            try recovered.appendSlice(self.allocator, active.days);
            try recovered.append(self.allocator, active.interrupted);
        }
        // Bound the combined replay by age, rather than evicting recent custom
        // events just because an older session journal was read after them.
        std.mem.sort(Entry, recovered.items, {}, struct {
            fn lessThan(_: void, left: Entry, right: Entry) bool {
                return left.timestamp_ms < right.timestamp_ms;
            }
        }.lessThan);
        for (recovered.items) |entry| try self.restoreEntry(entry);
    }

    fn restoreEntry(self: *Reporter, entry: Entry) !void {
        const now = Io.Clock.real.now(self.io).toMilliseconds();
        if (!validId(entry.id) or @as(i128, entry.timestamp_ms) < @as(i128, now) - max_age_ms or @as(i128, entry.timestamp_ms) > @as(i128, now) + 300_000 or
            entry.header.len > 2048 or entry.event.len > max_event_bytes or entry.header.len == 0 or entry.header[entry.header.len - 1] != '}') return;
        if (!self.validStoredEntry(entry)) return;
        try self.appendQueue(try self.copyEntry(entry), self.entryDay(entry));
    }

    // The outer spool file may still parse after a partial/manual edit leaves
    // invalid JSON inside an entry. Never let one damaged event poison retries
    // of the otherwise valid queue behind it.
    fn validStoredEntry(self: *Reporter, entry: Entry) bool {
        if (entry.event.len > max_event_bytes) return false;
        const header = std.json.parseFromSlice(std.json.Value, self.allocator, entry.header, .{}) catch return false;
        defer header.deinit();
        if (!onlyFields(header.value, &.{ "schemaVersion", "installationId", "sessionId", "appVersion", "buildHash", "channel", "os", "arch", "distribution" })) return false;
        if (integerField(header.value, "schemaVersion") != 1 or
            !eq(stringField(header.value, "installationId") orelse return false, &self.installation_id) or
            !validId(stringField(header.value, "sessionId") orelse return false) or
            !validText(stringField(header.value, "appVersion") orelse return false, 128) or
            !validText(stringField(header.value, "buildHash") orelse return false, 128) or
            !validToken(stringField(header.value, "os") orelse return false, 32, true) or
            !validToken(stringField(header.value, "arch") orelse return false, 32, false) or
            !validToken(stringField(header.value, "distribution") orelse return false, 64, true)) return false;
        const channel = stringField(header.value, "channel") orelse return false;
        if (!eq(channel, "stable") and !eq(channel, "canary")) return false;

        const event = std.json.parseFromSlice(std.json.Value, self.allocator, entry.event, .{}) catch return false;
        defer event.deinit();
        if (event.value != .object or
            !eq(stringField(event.value, "id") orelse return false, entry.id) or
            !eq(stringField(event.value, "timestamp") orelse return false, &timestampString(entry.timestamp_ms))) return false;
        if (event.value.object.contains("userId") and !validText(stringField(event.value, "userId") orelse return false, 256)) return false;
        if (event.value.object.contains("sequence")) {
            const sequence = integerField(event.value, "sequence") orelse return false;
            if (sequence < 0 or sequence > 9_007_199_254_740_991) return false;
        }
        const kind = stringField(event.value, "kind") orelse return false;
        if (eq(kind, "session")) {
            if (!onlyFields(event.value, &.{ "id", "kind", "timestamp", "sequence", "userId", "day", "durationMs", "appSessionId" })) return false;
            if (event.value.object.contains("appSessionId") and !validId(stringField(event.value, "appSessionId") orelse return false)) return false;
            const duration = integerField(event.value, "durationMs") orelse return false;
            if (duration < 0 or duration > day_ms) return false;
            const day = stringField(event.value, "day") orelse return false;
            return eq(day, &dayString(entry.timestamp_ms)) or eq(day, &dayString(entry.timestamp_ms - day_ms));
        }
        if (!eq(kind, "custom") or !onlyFields(event.value, &.{ "id", "kind", "timestamp", "sequence", "userId", "name", "properties" }) or
            !validName(stringField(event.value, "name") orelse return false, 80, true)) return false;
        const properties = event.value.object.get("properties");
        if (properties) |value| if (!validProperties(value)) return false;
        return fitsEventBytes(entry.event, properties);
    }

    fn run(self: *Reporter) void {
        var next_send: i64 = 0;
        var retry_ms: i64 = 1000;
        while (true) {
            if (self.stopped.load(.acquire)) return;
            Io.checkCancel(self.io) catch return;
            self.mutex.lockUncancelable(self.io);
            const now = Io.Clock.awake.now(self.io).toMilliseconds();
            if (self.enabled) {
                self.advance(now, Io.Clock.real.now(self.io).toMilliseconds());
                if (self.session_active and now - self.last_snapshot_ms >= checkpoint_ms) self.checkpoint(self.last_real_ms) catch {};
            }
            // flush() persists data but must not bypass failure backoff or a
            // server's Retry-After deadline, including after process restarts.
            self.flush_requested = false;
            const persisted = if (self.persist()) |_| true else |_| false;
            const pending = if (persisted and now >= next_send and Io.Clock.real.now(self.io).toMilliseconds() >= self.retry_after_ms)
                self.batch() catch null
            else
                null;
            self.mutex.unlock(self.io);
            if (pending) |sent| {
                defer self.allocator.free(sent.body);
                if (self.stopped.load(.acquire)) return;
                // A toggle invalidates captured batches even if collection was
                // re-enabled before this worker reached dispatch. Requests that
                // have already started may complete after an opt-out.
                if (!self.mayDispatch(sent)) continue;
                const delivery: ?Delivery = self.sendTimed(sent.body) catch |err| blk: {
                    if (err == error.Canceled) return;
                    break :blk null;
                };
                self.mutex.lockUncancelable(self.io);
                const succeeded = if (delivery) |result| result.acknowledged else false;
                if (delivery) |result| self.applyDelivery(result, Io.Clock.real.now(self.io).toMilliseconds());
                if (succeeded) {
                    self.acknowledge(sent);
                    retry_ms = 1000;
                } else retry_ms = @min(retry_ms * 2, 60_000);
                self.persist() catch {};
                self.mutex.unlock(self.io);
                next_send = Io.Clock.awake.now(self.io).toMilliseconds() + if (succeeded) @as(i64, 0) else retry_ms;
            }
            if (self.stopped.load(.acquire)) return;
            Io.sleep(self.io, .fromMilliseconds(1000), .awake) catch return;
        }
    }

    fn sendTimed(self: *Reporter, body: []const u8) !Delivery {
        const Result = union(enum) { send: anyerror!Delivery, timeout: Io.Cancelable!void };
        var storage: [2]Result = undefined;
        var select = Io.Select(Result).init(self.io, &storage);
        defer select.cancelDiscard();
        try select.concurrent(.send, dispatch, .{ self, body });
        try select.concurrent(.timeout, Io.sleep, .{ self.io, Io.Duration.fromMilliseconds(5000), Io.Clock.awake });
        switch (try select.await()) {
            .send => |result| return result,
            .timeout => return error.InsightsTimeout,
        }
    }

    fn dispatch(self: *Reporter, body: []const u8) !Delivery {
        return self.send_fn(self.send_context, self.allocator, self.io, self.endpoint, body);
    }
};

fn checkedUri(url: []const u8) !std.Uri {
    if (url.len > 8192) return error.InvalidInsightsUrl;
    for (url) |c| if (c <= 32 or c == 127 or c == '\\') return error.InvalidInsightsUrl;
    var uri = try std.Uri.parse(url);
    if (uri.user != null or uri.password != null or uri.query != null or uri.fragment != null or uri.port == 0) return error.InvalidInsightsUrl;
    const host = switch (uri.host orelse return error.InvalidInsightsUrl) {
        .raw, .percent_encoded => |value| value,
    };
    if (host.len == 0 or std.mem.indexOfScalar(u8, host, '%') != null) return error.InvalidInsightsUrl;
    if (!eq(uri.scheme, "https")) {
        if (!eq(uri.scheme, "http")) return error.InsecureInsightsUrl;
        if (std.ascii.eqlIgnoreCase(host, "localhost")) uri.host = .{ .raw = "127.0.0.1" } else {
            const address = Io.net.IpAddress.parseLiteral(host) catch return error.InsecureInsightsUrl;
            if (!switch (address) {
                .ip4 => |ip| ip.bytes[0] == 127,
                .ip6 => |ip| ip.isLoopBack(),
            }) return error.InsecureInsightsUrl;
        }
    }
    return uri;
}

fn sendHttp(_: ?*anyopaque, allocator: A, io: Io, endpoint: []const u8, body: []const u8) !Delivery {
    var client: std.http.Client = .{ .allocator = allocator, .io = io };
    defer client.deinit();
    var request = try client.request(.POST, try checkedUri(endpoint), .{
        .redirect_behavior = .unhandled,
        .keep_alive = false,
        .headers = .{ .accept_encoding = .{ .override = "identity" } },
        .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }},
    });
    defer {
        if (request.connection) |connection| connection.closing = true;
        request.deinit();
    }
    request.accept_encoding = @splat(false);
    request.accept_encoding[@backingInt(std.http.ContentEncoding.identity)] = true;
    try request.sendBodyComplete(@constCast(body));
    var response = try request.receiveHead(&.{});
    // Invalid/removed destinations and rejected payloads cannot succeed by
    // retrying the same batch. Remove those entries, but never disable consent.
    // Network failures, timeouts and rate limiting remain retryable.
    const status = @backingInt(response.head.status);
    const permanent_rejection = status >= 400 and status < 500 and status != 408 and status != 425 and status != 429;
    var result: Delivery = .{ .acknowledged = status == 202 or permanent_rejection };
    var headers = response.head.iterateHeaders();
    while (headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "retry-after")) {
            const seconds = std.fmt.parseInt(u64, std.mem.trim(u8, header.value, " \t"), 10) catch continue;
            result.retry_after_ms = @intCast(@min(seconds, 365 * 24 * 60 * 60) * 1000);
        }
    }
    if (status != 202) return result;
    // Older servers acknowledge without a policy. A malformed/oversized
    // response cannot change collection state or cause an acknowledged batch
    // to be retried indefinitely.
    const bytes = response.reader(&.{}).allocRemaining(allocator, .limited(4096)) catch return result;
    defer allocator.free(bytes);
    result.custom_events = customEventsPolicy(allocator, bytes);
    return result;
}

fn customEventsPolicy(allocator: A, bytes: []const u8) ?bool {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, bytes, .{}) catch return null;
    defer parsed.deinit();
    if (parsed.value != .object) return null;
    const collection = parsed.value.object.get("collection") orelse return null;
    if (collection != .object) return null;
    const allowed = collection.object.get("customEvents") orelse return null;
    return if (allowed == .bool) allowed.bool else null;
}

fn isLifecycleName(name: []const u8) bool {
    return eq(name, "electrobun.app.open") or eq(name, "electrobun.app.close") or eq(name, "electrobun.app.interrupted");
}

fn randomId(io: Io) [32]u8 {
    var random: [16]u8 = undefined;
    io.random(&random);
    return std.fmt.bytesToHex(random, .lower);
}
fn validId(id: []const u8) bool {
    if (id.len != 32) return false;
    for (id) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}
fn eq(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
fn optionalEq(a: ?[]const u8, b: ?[]const u8) bool {
    if (a) |first| return if (b) |second| eq(first, second) else false;
    return b == null;
}
fn validText(value: []const u8, max: usize) bool {
    return value.len > 0 and value.len <= max and std.unicode.utf8ValidateSlice(value);
}
fn onlyFields(value: std.json.Value, fields: []const []const u8) bool {
    if (value != .object) return false;
    for (value.object.keys()) |key| {
        for (fields) |field| {
            if (eq(key, field)) break;
        } else return false;
    }
    return true;
}
fn stringField(value: std.json.Value, key: []const u8) ?[]const u8 {
    if (value != .object) return null;
    return switch (value.object.get(key) orelse return null) {
        .string => |text| text,
        else => null,
    };
}
fn integerField(value: std.json.Value, key: []const u8) ?i64 {
    if (value != .object) return null;
    return switch (value.object.get(key) orelse return null) {
        .integer => |number| number,
        else => null,
    };
}
fn validToken(value: []const u8, max: usize, alpha_first: bool) bool {
    if (value.len == 0 or value.len > max) return false;
    if (!std.ascii.isLower(value[0]) and (alpha_first or !std.ascii.isDigit(value[0]))) return false;
    for (value) |c| if (!std.ascii.isLower(c) and !std.ascii.isDigit(c) and c != '_' and c != '-') return false;
    return true;
}
fn validName(value: []const u8, max: usize, spaces: bool) bool {
    if (value.len == 0 or value.len > max or !std.ascii.isAlphanumeric(value[0])) return false;
    for (value) |c| if (!std.ascii.isAlphanumeric(c) and c != '_' and c != '.' and c != ':' and c != '-' and !(spaces and c == ' ')) return false;
    return true;
}
fn validProperties(value: std.json.Value) bool {
    if (value != .object or value.object.count() > 16) return false;
    var iterator = value.object.iterator();
    while (iterator.next()) |entry| {
        if (!validName(entry.key_ptr.*, 64, false)) return false;
        switch (entry.value_ptr.*) {
            .null, .bool, .integer => {},
            .float => |number| if (!std.math.isFinite(number)) return false,
            .string => |text| if (text.len > 256) return false,
            else => return false,
        }
    }
    return true;
}

// The API measures JSON.stringify(event)'s UTF-8 bytes. Zig and JavaScript
// escape strings equivalently, but JS number normalization can grow a native
// integer by rounding across a decimal boundary. Reserve possible growth:
// finite ECMAScript Number output is at most 25 bytes. Internal sequence and
// duration fields are safe integers and already use the same decimal format.
// This intentionally allows a small conservative margin for numeric events.
fn fitsEventBytes(event: []const u8, properties: ?std.json.Value) bool {
    if (event.len > max_event_bytes) return false;
    var bytes = event.len;
    if (properties) |value| {
        if (value != .object) return false;
        for (value.object.values()) |property| switch (property) {
            .integer, .float => {
                var buffer: [64]u8 = undefined;
                var writer = Io.Writer.fixed(&buffer);
                std.json.Stringify.value(property, .{}, &writer) catch return false;
                bytes += 25 -| writer.buffered().len;
            },
            else => {},
        };
    }
    return bytes <= max_event_bytes;
}
fn dayString(milliseconds: i64) [10]u8 {
    const seconds: std.time.epoch.EpochSeconds = .{ .secs = @intCast(@max(0, @divFloor(milliseconds, 1000))) };
    const yd = seconds.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    var result: [10]u8 = undefined;
    _ = std.fmt.bufPrint(&result, "{d:0>4}-{d:0>2}-{d:0>2}", .{ yd.year, @backingInt(md.month), md.day_index + 1 }) catch unreachable;
    return result;
}
fn timestampString(milliseconds: i64) [24]u8 {
    const ms: u64 = @intCast(@max(0, milliseconds));
    const seconds: std.time.epoch.EpochSeconds = .{ .secs = ms / 1000 };
    const ds = seconds.getDaySeconds();
    const day = dayString(milliseconds);
    var result: [24]u8 = undefined;
    _ = std.fmt.bufPrint(&result, "{s}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{ day, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute(), ms % 1000 }) catch unreachable;
    return result;
}

test "timestamps and custom property limits match ingest contract" {
    try std.testing.expectEqualStrings("2026-11-05T00:00:00.123Z", &timestampString(1_793_836_800_123));
    const valid = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"ok\":true,\"n\":1,\"empty\":null}", .{});
    defer valid.deinit();
    try std.testing.expect(validProperties(valid.value));
    const nested = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"nested\":{}}", .{});
    defer nested.deinit();
    try std.testing.expect(!validProperties(nested.value));
    try std.testing.expect(validName("purchase.completed:trial 1", 80, true));
    try std.testing.expect(!validName("bad/event", 80, true));
    try std.testing.expect(!validName("key with spaces", 64, false));
    try std.testing.expectError(error.InsecureInsightsUrl, checkedUri("http://example.com/insights"));
    _ = try checkedUri("http://127.0.0.1:8787/v1/electrobun/apps/test/insights");
}

const event_limit_key: [64]u8 = @splat('k');
const event_limit_name: [80]u8 = @splat('n');
const event_limit_controls: [256]u8 = @splat(1);
const event_limit_utf8: [256]u8 = blk: {
    var bytes: [256]u8 = undefined;
    for (0..128) |index| @memcpy(bytes[index * 2 ..][0..2], "é");
    break :blk bytes;
};

// Fixed keys keep the serialized overhead constant while padding grows. The
// escaped controls and multibyte text exercise bytes rather than character counts.
fn eventLimitProperties(a: A, padding: usize, numeric: bool) ![]u8 {
    var properties: std.json.Value = .{ .object = .empty };
    var controls: usize = 1100;
    var remaining = padding;
    for (0..16) |index| {
        const key = if (index == 0) &event_limit_key else try std.fmt.allocPrint(a, "p{d}", .{index});
        const value: std.json.Value = if (index < 5) blk: {
            const count = @min(controls, 256);
            controls -= count;
            const bytes = try a.alloc(u8, count);
            @memset(bytes, 1);
            break :blk .{ .string = bytes };
        } else if (index == 5) .{ .string = &event_limit_utf8 } else if (numeric and index == 15) .{ .integer = 999_999_999_999_999_999 } else blk: {
            const count = @min(remaining, 256);
            remaining -= count;
            const bytes = try a.alloc(u8, count);
            @memset(bytes, 'x');
            break :blk .{ .string = bytes };
        };
        try properties.object.put(a, key, value);
    }
    try std.testing.expectEqual(@as(usize, 0), remaining);
    return std.json.Stringify.valueAlloc(a, properties, .{});
}

test "whole event byte limit includes escaped properties maximum name sequence and captured identity" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    try reporter.identify(&event_limit_utf8);
    reporter.sequence = 9_007_199_254_740_991;
    try reporter.track(&event_limit_name, try eventLimitProperties(a, 0, false));
    const base_size = reporter.queue.items[0].event.len;
    const padding = max_event_bytes - base_size;
    reporter.remove(0);
    reporter.sequence = 9_007_199_254_740_991;
    const properties = try eventLimitProperties(a, padding, false);
    try std.testing.expect(properties.len < max_event_bytes);
    try reporter.track(&event_limit_name, properties);
    try std.testing.expectEqual(max_event_bytes, reporter.queue.items[0].event.len);
    try std.testing.expect(reporter.validStoredEntry(reporter.queue.items[0]));
    reporter.sequence = 9_007_199_254_740_991;
    try std.testing.expectError(error.InvalidInsightsEvent, reporter.track(&event_limit_name, try eventLimitProperties(a, padding + 1, false)));
    try std.testing.expectEqual(@as(usize, 1), reporter.queue.items.len);
    // The identity is also bounded in bytes, but JSON escapes can expand it.
    // Already queued entries retain the former identity without growing.
    try reporter.identify(&event_limit_controls);
    try std.testing.expectError(error.InvalidInsightsEvent, reporter.track(&event_limit_name, properties));
    try std.testing.expectEqual(@as(usize, 1), reporter.queue.items.len);
    try std.testing.expectEqual(max_event_bytes, reporter.queue.items[0].event.len);
    try std.testing.expect(reporter.validStoredEntry(reporter.queue.items[0]));
    try reporter.track("still-valid", "{}");
    try std.testing.expectEqual(@as(usize, 2), reporter.queue.items.len);
}

test "numeric properties reserve JSON normalization growth before enqueue" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    reporter.sequence = 9_007_199_254_740_991;
    try reporter.track(&event_limit_name, try eventLimitProperties(a, 0, true));
    const base_size = reporter.queue.items[0].event.len;
    var number_buffer: [64]u8 = undefined;
    var number_writer = Io.Writer.fixed(&number_buffer);
    try std.json.Stringify.value(@as(i64, 999_999_999_999_999_999), .{}, &number_writer);
    const growth = 25 - number_writer.buffered().len;
    try std.testing.expect(growth > 0);
    const padding = max_event_bytes - base_size - growth;
    reporter.remove(0);
    reporter.sequence = 9_007_199_254_740_991;
    try reporter.track(&event_limit_name, try eventLimitProperties(a, padding, true));
    try std.testing.expectEqual(max_event_bytes - growth, reporter.queue.items[0].event.len);
    reporter.sequence = 9_007_199_254_740_991;
    const too_large = try eventLimitProperties(a, padding + 1, true);
    try std.testing.expectError(error.InvalidInsightsEvent, reporter.track(&event_limit_name, too_large));
    try std.testing.expectEqual(@as(usize, 1), reporter.queue.items.len);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, too_large, .{});
    defer parsed.deinit();
    var legacy = reporter.queue.items[0];
    legacy.event = try changedJson(a, legacy.event, "properties", parsed.value);
    try std.testing.expect(legacy.event.len <= max_event_bytes);
    try std.testing.expect(!reporter.validStoredEntry(legacy));
}

test "oversized legacy events cannot block valid offline replay" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    try reporter.track("legacy-large", try eventLimitProperties(a, 0, false));
    var oversized = reporter.queue.items[0];
    oversized.event = try changedJson(a, oversized.event, "userId", .{ .string = &event_limit_controls });
    try std.testing.expect(oversized.event.len > max_event_bytes);
    try std.testing.expect(!reporter.validStoredEntry(oversized));
    try reporter.track("valid-sibling", "{}");
    const queue_path = try a.dupe(u8, reporter.queue_path);
    const legacy = try std.json.Stringify.valueAlloc(a, &[_]Entry{ oversized, reporter.queue.items[1] }, .{});
    reporter.deinit();
    try Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = queue_path, .data = legacy });
    var recovered = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer recovered.deinit();
    try std.testing.expectEqual(@as(usize, 1), recovered.queue.items.len);
    try std.testing.expect(std.mem.indexOf(u8, recovered.queue.items[0].event, "valid-sibling") != null);
}

test "corrupt identity fails initialization without a double free" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var first = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    const state_path = try std.testing.allocator.dupe(u8, first.state_path);
    defer std.testing.allocator.free(state_path);
    first.deinit();
    try Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = state_path, .data = "{\"installationId\":\"corrupt\"}" });
    try std.testing.expectError(error.InvalidInsightsIdentity, Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path)));
}

test "Insights uses the hosted service when its API URL is omitted" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    const options_json = try std.json.Stringify.valueAlloc(std.testing.allocator, .{
        .appId = "app_example",
        .storagePath = path,
        .version = "1.0.0",
        .buildHash = "build-123",
        .channel = "stable",
        .enabled = false,
    }, .{});
    defer std.testing.allocator.free(options_json);
    const parsed = try std.json.parseFromSlice(Options, std.testing.allocator, options_json, .{});
    defer parsed.deinit();
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, parsed.value);
    defer reporter.deinit();
    try std.testing.expectEqualStrings("https://api.electrobun.dev/v1/electrobun/apps/app_example/insights", reporter.endpoint);
    try std.testing.expect(!reporter.enabled);
}

fn changedJson(a: A, source: []const u8, key: []const u8, value: std.json.Value) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, source, .{});
    defer parsed.deinit();
    try parsed.value.object.put(parsed.arena.allocator(), key, value);
    return std.json.Stringify.valueAlloc(a, parsed.value, .{});
}

test "corrupt inner spool entries are skipped while valid custom and session events survive" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    var first = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    try first.track("valid.event", "{\"source\":\"test\"}");
    try first.snapshot(first.last_real_ms);
    const custom = first.queue.items[0];
    const session = first.queue.items[1];
    const queue_path = try a.dupe(u8, first.queue_path);
    var entries: std.ArrayList(Entry) = .empty;
    try entries.append(a, .{ .header = custom.header, .event = "not json", .id = custom.id, .timestamp_ms = custom.timestamp_ms });
    const Mutation = struct { key: []const u8, value: std.json.Value };
    for ([_]Mutation{
        .{ .key = "installationId", .value = .{ .string = "00000000000000000000000000000000" } },
        .{ .key = "sessionId", .value = .{ .string = "bad" } },
        .{ .key = "appVersion", .value = .{ .string = "" } },
        .{ .key = "buildHash", .value = .{ .string = "" } },
        .{ .key = "channel", .value = .{ .string = "dev" } },
        .{ .key = "os", .value = .{ .string = "MacOS" } },
        .{ .key = "arch", .value = .{ .string = "bad/arch" } },
        .{ .key = "distribution", .value = .{ .string = "bad/store" } },
        .{ .key = "schemaVersion", .value = .{ .integer = 2 } },
        .{ .key = "unexpected", .value = .{ .bool = true } },
    }) |mutation| {
        var bad = custom;
        bad.header = try changedJson(a, custom.header, mutation.key, mutation.value);
        try entries.append(a, bad);
    }
    for ([_]Mutation{
        .{ .key = "id", .value = .{ .string = "00000000000000000000000000000000" } },
        .{ .key = "timestamp", .value = .{ .string = "2020-01-01T00:00:00.000Z" } },
        .{ .key = "kind", .value = .{ .string = "unknown" } },
        .{ .key = "userId", .value = .{ .string = "" } },
        .{ .key = "userId", .value = .null },
        .{ .key = "sequence", .value = .{ .integer = -1 } },
        .{ .key = "sequence", .value = .{ .integer = 9_007_199_254_740_992 } },
        .{ .key = "sequence", .value = .{ .float = 1.5 } },
        .{ .key = "name", .value = .{ .string = "bad/event" } },
        .{ .key = "properties", .value = .{ .string = "not an object" } },
        .{ .key = "unexpected", .value = .{ .bool = true } },
    }) |mutation| {
        var bad = custom;
        bad.event = try changedJson(a, custom.event, mutation.key, mutation.value);
        try entries.append(a, bad);
    }
    for ([_]Mutation{
        .{ .key = "day", .value = .{ .string = "2000-01-01" } },
        .{ .key = "appSessionId", .value = .{ .string = "invalid" } },
        .{ .key = "durationMs", .value = .{ .integer = -1 } },
        .{ .key = "durationMs", .value = .{ .integer = day_ms + 1 } },
        .{ .key = "name", .value = .{ .string = "wrong-kind-field" } },
    }) |mutation| {
        var bad = session;
        bad.event = try changedJson(a, session.event, mutation.key, mutation.value);
        try entries.append(a, bad);
    }
    for ([_]i64{ std.math.minInt(i64), std.math.maxInt(i64) }) |timestamp| {
        var bad = custom;
        bad.timestamp_ms = timestamp;
        try entries.append(a, bad);
    }
    var legacy_session = session;
    const legacy_event = try std.json.parseFromSlice(std.json.Value, a, session.event, .{});
    defer legacy_event.deinit();
    var legacy_value = legacy_event.value;
    _ = legacy_value.object.swapRemove("appSessionId");
    legacy_session.event = try std.json.Stringify.valueAlloc(a, legacy_value, .{});
    try std.testing.expect(first.validStoredEntry(legacy_session));
    try entries.appendSlice(a, &.{ custom, legacy_session });
    const spool = try std.json.Stringify.valueAlloc(a, entries.items, .{});
    first.deinit();
    try Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = queue_path, .data = spool });
    var reopened = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expectEqual(@as(usize, 2), reopened.queue.items.len);
    try std.testing.expect(std.mem.indexOf(u8, reopened.queue.items[0].event, "valid.event") != null);
    try std.testing.expect(reopened.validStoredEntry(reopened.queue.items[0]));
    try std.testing.expect(reopened.validStoredEntry(reopened.queue.items[1]));
}

test "empty stored user identity is ignored instead of poisoning future events" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var first = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    const state_path = try a.dupe(u8, first.state_path);
    defer a.free(state_path);
    const state = try std.json.Stringify.valueAlloc(a, Stored{ .installationId = &first.installation_id, .userId = "" }, .{});
    defer a.free(state);
    first.deinit();
    try Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = state_path, .data = state });
    var reopened = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expect(reopened.user_id == null);
    try reopened.track("anonymous", "{}");
    try std.testing.expect(reopened.validStoredEntry(reopened.queue.items[reopened.queue.items.len - 1]));
}

test "dev collection requires explicit loopback opt in and cannot inherit production opt in" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var options = fixtureOptions(path);
    options.enabled = true;
    var stable = try Reporter.init(a, std.testing.io, options);
    const installation_id = stable.installation_id;
    stable.deinit();
    options.channel = "dev";
    options.apiUrl = "https://api.example.com";
    var production = try Reporter.init(a, std.testing.io, options);
    try std.testing.expectEqualStrings(&installation_id, &production.installation_id);
    try std.testing.expect(!production.enabled);
    production.setEnabled(true);
    try std.testing.expect(!production.enabled);
    try std.testing.expectError(error.InsightsDisabled, production.track("do-not-send", "{}"));
    production.deinit();

    options.appId = "dev-local";
    options.apiUrl = "http://127.0.0.1:8787";
    var local = try Reporter.init(a, std.testing.io, options);
    try std.testing.expect(local.enabled);
    try local.track("local-test", "{}");
    local.deinit();
    // Removing the explicit opt-in returns dev builds to their default, even
    // when the same profile previously persisted an enabled local session.
    options.enabled = null;
    var implicit = try Reporter.init(a, std.testing.io, options);
    defer implicit.deinit();
    try std.testing.expect(!implicit.enabled);
    implicit.setEnabled(true);
    try std.testing.expect(!implicit.enabled);
}

fn fixtureOptions(path: []const u8) Options {
    return .{ .appId = "example", .apiUrl = "http://127.0.0.1:8787", .storagePath = path, .version = "1.0.0", .buildHash = "abc123", .channel = "canary", .enabled = true };
}

test "omitted collection preference never records or sends events on any channel" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    for ([_][]const u8{ "stable", "canary", "dev" }) |channel| {
        var options = fixtureOptions(path);
        options.appId = channel;
        options.channel = channel;
        options.enabled = null;
        var reporter = try Reporter.init(a, std.testing.io, options);
        var transport: SuccessfulTransport = .{};
        reporter.send_context = &transport;
        reporter.send_fn = SuccessfulTransport.send;
        defer reporter.deinit();
        try std.testing.expect(!reporter.enabled);
        try reporter.start();
        try reporter.identify("local-user");
        try std.testing.expectError(error.InsightsDisabled, reporter.track("must-not-collect", "{}"));
        reporter.flush();
        reporter.stop();
        try std.testing.expect(!reporter.session_active);
        try std.testing.expectEqual(@as(usize, 0), reporter.queue.items.len);
        try std.testing.expectEqual(@as(usize, 0), reporter.journal.items.len);
        try std.testing.expectEqual(@as(usize, 0), transport.calls.load(.acquire));
        var reopened = try Reporter.init(a, std.testing.io, options);
        defer reopened.deinit();
        try std.testing.expect(!reopened.enabled);
        try std.testing.expect((try reopened.batch()) == null);
    }
}

test "explicit runtime opt in survives restart when the build omits enabled" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var options = fixtureOptions(path);
    options.enabled = null;
    var first = try Reporter.init(a, std.testing.io, options);
    try std.testing.expect(!first.enabled);
    first.setEnabled(true);
    try first.track("explicit-opt-in", "{}");
    first.deinit();
    var reopened = try Reporter.init(a, std.testing.io, options);
    defer reopened.deinit();
    try std.testing.expect(reopened.enabled);
    try std.testing.expect(reopened.queue.items.len > 0);
}

test "build defaults do not become persisted consent and explicit unchanged opt out does" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var options = fixtureOptions(path);
    options.enabled = null;
    var initial = try Reporter.init(a, std.testing.io, options);
    try std.testing.expect(!initial.enabled);
    initial.deinit();

    options.enabled = true;
    var explicitly_configured = try Reporter.init(a, std.testing.io, options);
    try std.testing.expect(explicitly_configured.enabled);
    explicitly_configured.deinit();

    options.enabled = null;
    var default_again = try Reporter.init(a, std.testing.io, options);
    try std.testing.expect(!default_again.enabled);
    default_again.setEnabled(false);
    default_again.deinit();

    options.enabled = true;
    var opted_out = try Reporter.init(a, std.testing.io, options);
    defer opted_out.deinit();
    try std.testing.expect(!opted_out.enabled);
    try std.testing.expectEqual(@as(?bool, false), opted_out.consent_enabled);
}

test "runtime opt in persists even when the build already enabled collection" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var options = fixtureOptions(path);
    var initial = try Reporter.init(a, std.testing.io, options);
    try std.testing.expect(initial.enabled);
    try std.testing.expect(initial.consent_enabled == null);
    initial.setEnabled(true);
    initial.deinit();
    options.enabled = null;
    var reopened = try Reporter.init(a, std.testing.io, options);
    defer reopened.deinit();
    try std.testing.expect(reopened.enabled);
    try std.testing.expectEqual(@as(?bool, true), reopened.consent_enabled);
}

test "installation identity persists and is scoped by app and profile" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var first = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    const id = first.installation_id;
    first.deinit();
    var second = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer second.deinit();
    try std.testing.expectEqualStrings(&id, &second.installation_id);
    var another = fixtureOptions(path);
    another.appId = "another-app";
    const another_path = try std.fs.path.join(std.testing.allocator, &.{ path, "another-app-profile" });
    defer std.testing.allocator.free(another_path);
    another.storagePath = another_path;
    var third = try Reporter.init(std.testing.allocator, std.testing.io, another);
    defer third.deinit();
    try std.testing.expect(!eq(&id, &third.installation_id));
}

test "offline queue is bounded persists event IDs and acknowledges only sent events" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var first = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    for (0..max_events + 10) |_| try first.track("clicked", "{\"source\":\"test\"}");
    try std.testing.expectEqual(max_events, first.queue.items.len);
    const sent = (try first.batch()).?;
    defer std.testing.allocator.free(sent.body);
    const retry = (try first.batch()).?;
    defer std.testing.allocator.free(retry.body);
    try std.testing.expectEqualStrings(sent.body, retry.body);
    try std.testing.expect(sent.body.len <= max_batch_bytes);
    // New events can arrive (and evict old entries) while a request is in flight.
    try first.track("later", "{}");
    first.acknowledge(sent);
    const remaining = first.queue.items.len;
    try std.testing.expectEqual(max_events - sent.count + 1, remaining);
    var preserved: [32]u8 = undefined;
    @memcpy(&preserved, first.queue.items[0].id);
    try first.persist();
    first.deinit();
    var reopened = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expectEqualStrings(&preserved, reopened.queue.items[0].id);
    try std.testing.expect(reopened.queue.items.len >= remaining);
}

test "identity changes only associate future custom events without changing session or duration" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    const install = reporter.installation_id;
    const anonymous_session = reporter.session_id;
    const app_session = reporter.app_session_id;
    reporter.duration_ms = 1234;
    reporter.app_duration_ms = 1234;
    const awake = reporter.last_awake_ms;
    const real = reporter.last_real_ms;
    try reporter.track("anonymous", "{}");
    const duration = reporter.duration_ms;
    const app_duration = reporter.app_duration_ms;
    try reporter.identify("opaque-user");
    try std.testing.expectEqualStrings(&anonymous_session, &reporter.session_id);
    try std.testing.expectEqualStrings(&app_session, &reporter.app_session_id);
    try std.testing.expectEqual(duration, reporter.duration_ms);
    try std.testing.expectEqual(app_duration, reporter.app_duration_ms);
    try std.testing.expect(reporter.last_awake_ms >= awake);
    try std.testing.expect(reporter.last_real_ms >= real);
    try std.testing.expectEqual(@as(usize, 0), reporter.journal.items.len);
    try reporter.track("identified", "{}");
    try std.testing.expect(std.mem.indexOf(u8, reporter.queue.items[0].event, "opaque-user") == null);
    try std.testing.expect(std.mem.indexOf(u8, reporter.queue.items[1].event, "opaque-user") != null);
    const identified_session = reporter.session_id;
    try reporter.identify(null);
    try std.testing.expectEqualStrings(&identified_session, &reporter.session_id);
    try std.testing.expectEqualStrings(&install, &reporter.installation_id);
    try std.testing.expect(reporter.user_id == null);
}

test "awake duration excludes suspend jumps and splits at UTC midnight" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    const midnight: i64 = 1_793_836_800_000;
    reporter.last_real_ms = midnight - 500;
    reporter.last_awake_ms = 1000;
    reporter.current_day = @divFloor(midnight - 500, day_ms);
    reporter.duration_ms = 2000;
    reporter.advance(2000, midnight + 500);
    try std.testing.expectEqual(@as(u64, 500), reporter.duration_ms);
    try std.testing.expectEqual(@as(usize, 0), reporter.queue.items.len);
    const old = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, reporter.journal.items[0].event, .{});
    defer old.deinit();
    try std.testing.expectEqual(@as(i64, 2500), old.value.object.get("durationMs").?.integer);
    try std.testing.expectEqualStrings("2026-11-04", old.value.object.get("day").?.string);
    // Real time advances an hour while the awake clock advances one second.
    reporter.advance(3000, midnight + 3_600_500);
    try std.testing.expectEqual(@as(u64, 1500), reporter.duration_ms);
    // Conservative cap also bounds implementations whose awake clock counts suspend.
    reporter.advance(3_603_000, midnight + 7_200_500);
    try std.testing.expectEqual(@as(u64, 11_500), reporter.duration_ms);
}

test "opt out clears queued telemetry and survives restart" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    try reporter.track("before", "{}");
    reporter.setEnabled(false);
    try std.testing.expectError(error.InsightsDisabled, reporter.track("after", "{}"));
    try std.testing.expectEqual(@as(usize, 0), reporter.queue.items.len);
    reporter.deinit();
    var reopened = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expect(!reopened.enabled);
    try std.testing.expectEqual(@as(usize, 0), reopened.queue.items.len);
}

test "consent persists when collection is initially disabled in the build" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var options = fixtureOptions(path);
    options.enabled = false;
    var first = try Reporter.init(std.testing.allocator, std.testing.io, options);
    try std.testing.expect(!first.enabled);
    first.setEnabled(true);
    try first.track("consented", "{}");
    first.deinit();

    var reopened = try Reporter.init(std.testing.allocator, std.testing.io, options);
    try std.testing.expect(reopened.enabled);
    var found = false;
    for (reopened.queue.items) |entry| if (std.mem.indexOf(u8, entry.event, "consented") != null) {
        found = true;
        break;
    };
    try std.testing.expect(found);
    reopened.setEnabled(false);
    reopened.deinit();

    var opted_out = try Reporter.init(std.testing.allocator, std.testing.io, options);
    defer opted_out.deinit();
    try std.testing.expect(!opted_out.enabled);
    try std.testing.expectEqual(@as(usize, 0), opted_out.queue.items.len);
}

const HangingTransport = struct {
    entered: Io.Event = .unset,
    canceled: std.atomic.Value(bool) = .init(false),
    fn send(context: ?*anyopaque, _: A, io: Io, _: []const u8, _: []const u8) !Delivery {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.entered.set(io);
        Io.sleep(io, .fromSeconds(3600), .awake) catch |err| {
            self.canceled.store(err == error.Canceled, .release);
            return err;
        };
        return .{};
    }
};

test "shutdown cancels blocked transport and preserves unacknowledged queue" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    var transport: HangingTransport = .{};
    reporter.send_context = &transport;
    reporter.send_fn = HangingTransport.send;
    try reporter.track("offline", "{}");
    try reporter.start();
    try transport.entered.wait(std.testing.io);
    reporter.stop();
    try std.testing.expect(transport.canceled.load(.acquire));
    try std.testing.expect(reporter.queue.items.len > 0);
    try std.testing.expect(reporter.future == null);
}

test "immediate repeated startup and shutdown cannot consume cancellation and loop forever" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    for (0..32) |_| {
        var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
        var transport: HangingTransport = .{};
        reporter.send_context = &transport;
        reporter.send_fn = HangingTransport.send;
        try reporter.start();
        reporter.deinit();
    }
}

test "offline snapshots coalesce without evicting custom events or earlier day totals" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    try reporter.track("important", "{}");
    const today = reporter.current_day;
    reporter.current_day = today - 1;
    reporter.duration_ms = 3000;
    try reporter.snapshot(reporter.last_real_ms - day_ms);
    reporter.current_day = today;
    for (0..400) |n| {
        reporter.duration_ms = n * 1000;
        try reporter.snapshot(reporter.last_real_ms);
    }
    try std.testing.expectEqual(@as(usize, 3), reporter.queue.items.len);
    try std.testing.expect(std.mem.indexOf(u8, reporter.queue.items[0].event, "important") != null);
    const previous = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, reporter.queue.items[1].event, .{});
    defer previous.deinit();
    try std.testing.expectEqualStrings(&dayString((today - 1) * day_ms), stringField(previous.value, "day").?);
    const in_flight = (try reporter.batch()).?;
    defer std.testing.allocator.free(in_flight.body);
    reporter.duration_ms = 400_000;
    try reporter.snapshot(reporter.last_real_ms);
    reporter.acknowledge(in_flight);
    try std.testing.expectEqual(@as(usize, 1), reporter.queue.items.len);
    const latest = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, reporter.queue.items[0].event, .{});
    defer latest.deinit();
    try std.testing.expectEqual(@as(i64, 400_000), integerField(latest.value, "durationMs").?);
    for (in_flight.ids[0..in_flight.count]) |id| try std.testing.expect(!eq(&id, reporter.queue.items[0].id));
}

test "opt out invalidates captured batch even after re-enabling collection" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var reporter = try Reporter.init(std.testing.allocator, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    try reporter.track("before", "{}");
    const captured = (try reporter.batch()).?;
    defer std.testing.allocator.free(captured.body);
    try std.testing.expect(reporter.mayDispatch(captured));
    reporter.setEnabled(false);
    reporter.setEnabled(true);
    try std.testing.expect(!reporter.mayDispatch(captured));
    try reporter.track("after", "{}");
    const next = (try reporter.batch()).?;
    defer std.testing.allocator.free(next.body);
    try std.testing.expect(reporter.mayDispatch(next));
}

test "concurrent first launches share the atomically created installation identity" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", std.testing.allocator);
    defer std.testing.allocator.free(path);
    var left_task = try Io.concurrent(std.testing.io, Reporter.init, .{ std.testing.allocator, std.testing.io, fixtureOptions(path) });
    var right_task = try Io.concurrent(std.testing.io, Reporter.init, .{ std.testing.allocator, std.testing.io, fixtureOptions(path) });
    var left = try left_task.await(std.testing.io);
    defer left.deinit();
    var right = try right_task.await(std.testing.io);
    defer right.deinit();
    try std.testing.expectEqualStrings(&left.installation_id, &right.installation_id);
}

fn namedEntry(reporter: *Reporter, name: []const u8) ?Entry {
    for (reporter.queue.items) |entry| {
        const parsed = std.json.parseFromSlice(std.json.Value, reporter.allocator, entry.event, .{}) catch continue;
        defer parsed.deinit();
        if (eq(stringField(parsed.value, "name") orelse "", name)) return entry;
    }
    return null;
}

fn acknowledgeAll(reporter: *Reporter) !void {
    while (try reporter.batch()) |pending| {
        defer reporter.allocator.free(pending.body);
        reporter.acknowledge(pending);
    }
}

test "normal lifecycle has one app open and close across identity changes and replays cleanly" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var reporter = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    try reporter.beginSession();
    const app_session = reporter.app_session_id;
    const started = reporter.app_started_ms;
    try std.testing.expect(namedEntry(&reporter, "electrobun.app.open") != null);
    try acknowledgeAll(&reporter);
    try reporter.identify("custom-event-user");
    reporter.advance(reporter.last_awake_ms + 1000, reporter.last_real_ms + 1000);
    reporter.flush();
    try reporter.identify(null);
    try std.testing.expectEqualStrings(&app_session, &reporter.app_session_id);
    try std.testing.expectEqual(@as(usize, 0), reporter.queue.items.len);
    try std.testing.expectEqual(@as(usize, 1), reporter.journal.items.len);
    for (reporter.journal.items) |entry| {
        const duration = try std.json.parseFromSlice(std.json.Value, a, entry.event, .{});
        defer duration.deinit();
        try std.testing.expectEqualStrings(&app_session, stringField(duration.value, "appSessionId").?);
        try std.testing.expect(!duration.value.object.contains("userId"));
    }
    reporter.stop();
    const closed = namedEntry(&reporter, "electrobun.app.close").?;
    const parsed = try std.json.parseFromSlice(std.json.Value, a, closed.event, .{});
    defer parsed.deinit();
    const properties = parsed.value.object.get("properties").?;
    try std.testing.expect(!parsed.value.object.contains("userId"));
    try std.testing.expectEqualStrings(&app_session, stringField(properties, "appSessionId").?);
    try std.testing.expectEqualStrings(&timestampString(started), stringField(properties, "startedAt").?);
    try std.testing.expect(integerField(properties, "durationMs").? >= 1000);
    try std.testing.expect(namedEntry(&reporter, "electrobun.app.interrupted") == null);
    try std.testing.expect(!reporter.session_active);
    reporter.deinit();
    var reopened = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expect(namedEntry(&reopened, "electrobun.app.close") != null);
    try std.testing.expect(namedEntry(&reopened, "electrobun.app.interrupted") == null);
    for (reopened.queue.items) |entry| {
        const duration = try std.json.parseFromSlice(std.json.Value, a, entry.event, .{});
        defer duration.deinit();
        if (eq(stringField(duration.value, "kind").?, "session")) {
            try std.testing.expectEqualStrings(&app_session, stringField(duration.value, "appSessionId").?);
        }
    }
}

test "custom collection policy persists without blocking basic events and a later response reactivates it" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var first = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    try first.beginSession();
    try first.track("pending-custom", "{}");
    const session = first.session_id;
    first.duration_ms = 1200;
    first.app_duration_ms = 1200;
    first.applyDelivery(.{ .custom_events = false }, first.last_real_ms);
    try std.testing.expectEqual(@as(usize, 2), first.queue.items.len);
    try std.testing.expect(namedEntry(&first, "electrobun.app.open") != null);
    try std.testing.expect(namedEntry(&first, "pending-custom") == null);
    try std.testing.expectError(error.InsightsDisabled, first.track("disabled-custom", "{}"));
    try std.testing.expectEqualStrings(&session, &first.session_id);
    try std.testing.expectEqual(@as(u64, 1200), first.duration_ms);
    try first.persist();
    first.deinit();

    var reopened = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expect(reopened.enabled);
    try std.testing.expect(!reopened.custom_events_enabled);
    try std.testing.expect(namedEntry(&reopened, "electrobun.app.close") != null);
    reopened.setEnabled(true);
    try std.testing.expectError(error.InsightsDisabled, reopened.track("still-disabled", "{}"));
    const pending = (try reopened.batch()).?;
    defer a.free(pending.body);
    try std.testing.expect(std.mem.indexOf(u8, pending.body, "electrobun.app.open") != null);
    reopened.acknowledge(pending);
    reopened.applyDelivery(.{ .custom_events = true }, reopened.last_real_ms);
    try reopened.track("reactivated", "{}");
    try std.testing.expect(namedEntry(&reopened, "reactivated") != null);
    reopened.setEnabled(false);
    reopened.applyDelivery(.{ .custom_events = true }, reopened.last_real_ms);
    try std.testing.expect(!reopened.enabled);
    try std.testing.expectError(error.InsightsDisabled, reopened.track("not-consented", "{}"));
    try std.testing.expectEqual(@as(usize, 0), reopened.queue.items.len);
}

test "missing or invalid response policies preserve custom collection state and reserved names cannot be tracked" {
    const a = std.testing.allocator;
    try std.testing.expectEqual(@as(?bool, false), customEventsPolicy(a, "{\"accepted\":true,\"collection\":{\"customEvents\":false}}"));
    try std.testing.expectEqual(@as(?bool, true), customEventsPolicy(a, "{\"collection\":{\"customEvents\":true}}"));
    for ([_][]const u8{ "", "{}", "[]", "{\"collection\":null}", "{\"collection\":{}}", "{\"collection\":{\"customEvents\":\"true\"}}" }) |body| {
        try std.testing.expect(customEventsPolicy(a, body) == null);
    }
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var reporter = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    reporter.applyDelivery(.{ .custom_events = false }, reporter.last_real_ms);
    reporter.applyDelivery(.{}, reporter.last_real_ms);
    try std.testing.expect(!reporter.custom_events_enabled);
    for ([_][]const u8{ "electrobun.app.open", "electrobun.app.close", "electrobun.app.interrupted" }) |name| {
        try std.testing.expectError(error.InvalidInsightsEvent, reporter.track(name, "{}"));
    }
}

const RateLimitedTransport = struct {
    calls: std.atomic.Value(usize) = .init(0),
    fn send(context: ?*anyopaque, _: A, _: Io, _: []const u8, _: []const u8) !Delivery {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        _ = self.calls.fetchAdd(1, .acq_rel);
        return .{ .acknowledged = false, .retry_after_ms = 60_000 };
    }
};

test "Retry-After survives flush and restart while pending basic events remain queued" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var first = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    var transport: RateLimitedTransport = .{};
    first.send_context = &transport;
    first.send_fn = RateLimitedTransport.send;
    try first.start();
    var ready = false;
    for (0..200) |_| {
        first.mutex.lockUncancelable(std.testing.io);
        ready = first.retry_after_ms > Io.Clock.real.now(std.testing.io).toMilliseconds();
        first.mutex.unlock(std.testing.io);
        if (ready) break;
        try Io.sleep(std.testing.io, .fromMilliseconds(10), .awake);
    }
    try std.testing.expect(ready);
    first.flush();
    try Io.sleep(std.testing.io, .fromMilliseconds(1200), .awake);
    try std.testing.expectEqual(@as(usize, 1), transport.calls.load(.acquire));
    first.deinit();

    var reopened = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expect(reopened.retry_after_ms > Io.Clock.real.now(std.testing.io).toMilliseconds());
    try std.testing.expect(reopened.queue.items.len > 0);
    var success: SuccessfulTransport = .{};
    reopened.send_context = &success;
    reopened.send_fn = SuccessfulTransport.send;
    try reopened.start();
    reopened.flush();
    try Io.sleep(std.testing.io, .fromMilliseconds(1200), .awake);
    try std.testing.expectEqual(@as(usize, 0), success.calls.load(.acquire));
}

test "interrupted recovery keeps old timestamps build identity duration and delivery IDs after a long gap" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var first = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    const started = Io.Clock.real.now(std.testing.io).toMilliseconds() - 10 * day_ms;
    first.last_real_ms = started;
    first.last_awake_ms = 1000;
    first.current_day = @divFloor(started, day_ms);
    try first.beginSession();
    const app_session = first.app_session_id;
    const installation = first.installation_id;
    try acknowledgeAll(&first);
    first.advance(2000, started + 1000);
    try first.checkpoint(first.last_real_ms);
    try first.persist();
    const interrupted_id = first.lifecycle_id;
    // Simulate termination without invoking the normal shutdown hook.
    first.stopped.store(true, .release);
    first.deinit();
    var next_options = fixtureOptions(path);
    next_options.version = "2.0.0";
    next_options.buildHash = "new-build";
    var recovered = try Reporter.init(a, std.testing.io, next_options);
    const event = namedEntry(&recovered, "electrobun.app.interrupted").?;
    try std.testing.expectEqualStrings(&interrupted_id, event.id);
    try std.testing.expectEqual(started + 1000, event.timestamp_ms);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, event.event, .{});
    defer parsed.deinit();
    const properties = parsed.value.object.get("properties").?;
    try std.testing.expectEqualStrings(&app_session, stringField(properties, "appSessionId").?);
    try std.testing.expectEqualStrings(&timestampString(started), stringField(properties, "startedAt").?);
    try std.testing.expectEqualStrings(&timestampString(started + 1000), stringField(properties, "endedAt").?);
    try std.testing.expectEqual(@as(i64, 1000), integerField(properties, "durationMs").?);
    const header = try std.json.parseFromSlice(std.json.Value, a, event.header, .{});
    defer header.deinit();
    try std.testing.expectEqualStrings("1.0.0", stringField(header.value, "appVersion").?);
    try std.testing.expectEqualStrings("abc123", stringField(header.value, "buildHash").?);
    try std.testing.expectEqualStrings(&installation, stringField(header.value, "installationId").?);
    const initial_batch = (try recovered.batch()).?;
    defer a.free(initial_batch.body);
    // A second interruption before recovery is committed must reuse IDs.
    recovered.stopped.store(true, .release);
    recovered.deinit();
    var retried = try Reporter.init(a, std.testing.io, next_options);
    defer retried.deinit();
    const retry_batch = (try retried.batch()).?;
    defer a.free(retry_batch.body);
    try std.testing.expectEqualStrings(initial_batch.body, retry_batch.body);
    try retried.persist();
    const disk = try spool_storage.read(a, std.testing.io, retried.queue_path, 3 * max_queue_bytes);
    defer a.free(disk);
    const saved = try std.json.parseFromSlice(Spool, a, disk, .{});
    defer saved.deinit();
    try std.testing.expect(saved.value.activeSession == null);
}

const SuccessfulTransport = struct {
    calls: std.atomic.Value(usize) = .init(0),
    fn send(context: ?*anyopaque, _: A, _: Io, _: []const u8, _: []const u8) !Delivery {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        _ = self.calls.fetchAdd(1, .acq_rel);
        return .{};
    }
};

test "worker checkpoints and explicit flush persist duration without periodic network delivery" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var reporter = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reporter.deinit();
    var transport: SuccessfulTransport = .{};
    reporter.send_context = &transport;
    reporter.send_fn = SuccessfulTransport.send;
    try reporter.start();
    var ready = false;
    for (0..200) |_| {
        reporter.mutex.lockUncancelable(std.testing.io);
        ready = transport.calls.load(.acquire) == 1 and reporter.queue.items.len == 0;
        if (ready) reporter.last_snapshot_ms = Io.Clock.awake.now(std.testing.io).toMilliseconds() - checkpoint_ms;
        reporter.mutex.unlock(std.testing.io);
        if (ready) break;
        try Io.sleep(std.testing.io, .fromMilliseconds(10), .awake);
    }
    try std.testing.expect(ready);
    try Io.sleep(std.testing.io, .fromMilliseconds(1200), .awake);
    reporter.flush();
    try Io.sleep(std.testing.io, .fromMilliseconds(1200), .awake);
    try std.testing.expectEqual(@as(usize, 1), transport.calls.load(.acquire));
    reporter.mutex.lockUncancelable(std.testing.io);
    defer reporter.mutex.unlock(std.testing.io);
    try std.testing.expectEqual(@as(usize, 0), reporter.queue.items.len);
    const bytes = try spool_storage.read(a, std.testing.io, reporter.queue_path, 3 * max_queue_bytes);
    defer a.free(bytes);
    const saved = try std.json.parseFromSlice(Spool, a, bytes, .{});
    defer saved.deinit();
    try std.testing.expect(saved.value.activeSession != null);
    try std.testing.expect(saved.value.activeSession.?.days.len > 0);
    const last = try std.json.parseFromSlice(std.json.Value, a, saved.value.activeSession.?.days[0].event, .{});
    defer last.deinit();
    try std.testing.expect(integerField(last.value, "durationMs").? >= 1000);
}

test "opt out discards active journal and encoded user data does not appear in stored bytes" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var reporter = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    try reporter.beginSession();
    try reporter.identify("private-app-user-123");
    reporter.flush();
    try reporter.persist();
    for ([_][]const u8{ reporter.queue_path, reporter.state_path }) |filename| {
        const raw = try Io.Dir.cwd().readFileAlloc(std.testing.io, filename, a, .limited(3 * max_queue_bytes));
        defer a.free(raw);
        try std.testing.expect(std.mem.indexOf(u8, raw, "private-app-user-123") == null);
        try std.testing.expect(std.mem.indexOf(u8, raw, "electrobun.app.open") == null);
    }
    reporter.setEnabled(false);
    const bytes = try spool_storage.read(a, std.testing.io, reporter.queue_path, 3 * max_queue_bytes);
    defer a.free(bytes);
    const saved = try std.json.parseFromSlice(Spool, a, bytes, .{});
    defer saved.deinit();
    try std.testing.expect(saved.value.activeSession == null);
    try std.testing.expectEqual(@as(usize, 0), saved.value.entries.len);
    reporter.deinit();
    var reopened = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer reopened.deinit();
    try std.testing.expect(!reopened.enabled);
    try std.testing.expect(namedEntry(&reopened, "electrobun.app.interrupted") == null);
}

test "old journal days do not evict newer custom events on close or recovery" {
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const a = std.testing.allocator;
    const path = try temp.dir.realPathFileAlloc(std.testing.io, ".", a);
    defer a.free(path);
    var reporter = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    const old = reporter.last_real_ms - 2 * day_ms;
    reporter.last_real_ms = old;
    reporter.current_day = @divFloor(old, day_ms);
    try reporter.beginSession();
    try acknowledgeAll(&reporter);
    for (0..max_events) |_| try reporter.track("recent", "{}");
    try reporter.persist();
    reporter.stopped.store(true, .release);
    reporter.deinit();
    var recovered = try Reporter.init(a, std.testing.io, fixtureOptions(path));
    defer recovered.deinit();
    for (recovered.queue.items) |entry| try std.testing.expect(entry.timestamp_ms > old + day_ms);
    try recovered.beginSession();
    for (0..max_events) |_| try recovered.track("recent", "{}");
    // Insert an old local day after the newer queued entries.
    recovered.current_day = @divFloor(old, day_ms);
    try recovered.checkpoint(old);
    recovered.current_day = @divFloor(recovered.last_real_ms, day_ms);
    recovered.stop();
    for (recovered.queue.items) |entry| try std.testing.expect(entry.timestamp_ms > old + day_ms);
}
