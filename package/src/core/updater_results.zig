//! Reconcile the native update manager's durable result with the running build.
//! Directory scans and documents are bounded; receipt publication deduplicates
//! reports across launches without trusting result filenames or symlinks.
const std = @import("std");
const protocol = @import("updater_protocol.zig");
const A = std.mem.Allocator;

pub const observed_filename = ".electrobun-observed-update-result.json";
const result_prefix = ".electrobun-update-";
const result_suffix = ".result.json";
const filename_bytes = result_prefix.len + 32 + result_suffix.len;
const max_entries = 1024;
const max_files = 64;
const max_result_bytes = 64 * 1024;
const Receipt = struct { schema_version: u32, transaction_id: []const u8 };
const Candidate = struct { result: protocol.Result, modified_at: i96, name: []const u8 };
const Scan = struct { selected: ?Candidate = null, candidates: []const Candidate = &.{}, truncated: bool = false };

fn transactionFromFilename(name: []const u8) ?[]const u8 {
    if (name.len != filename_bytes or !std.mem.startsWith(u8, name, result_prefix) or !std.mem.endsWith(u8, name, result_suffix)) return null;
    const transaction = name[result_prefix.len..][0..32];
    return if (protocol.validTransaction(transaction)) transaction else null;
}

fn matchesRunning(result: protocol.Result, info: protocol.LocalInfo) bool {
    if (result.success) return std.mem.eql(u8, result.hash, info.hash) and std.mem.eql(u8, result.version, info.version);
    // Failed validation may remove the prepared record before relaunching the
    // old build. A failed target still matters without that record.
    return !std.mem.eql(u8, result.hash, info.hash);
}

fn schemaOne(value: std.json.Value) bool {
    return switch (value) {
        .integer => |number| number == 1,
        .float => |number| number == 1,
        else => false,
    };
}

fn parseResult(a: A, bytes: []const u8) !protocol.Result {
    // Typed Zig JSON parsing permits numeric strings and enum ordinals. The
    // durable protocol uses JSON numbers, strings and booleans exactly, so
    // inspect raw types before converting into the native representation.
    const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer raw.deinit();
    if (raw.value != .object or raw.value.object.count() != 9) return error.InvalidNativeUpdateResult;
    const object = raw.value.object;
    if (!schemaOne(object.get("schema_version") orelse return error.InvalidNativeUpdateResult)) return error.InvalidNativeUpdateResult;
    const success = object.get("success") orelse return error.InvalidNativeUpdateResult;
    if (success != .bool) return error.InvalidNativeUpdateResult;
    inline for (.{ "transaction_id", "phase", "message", "identifier", "channel", "version", "hash" }) |field| {
        const value = object.get(field) orelse return error.InvalidNativeUpdateResult;
        if (value != .string) return error.InvalidNativeUpdateResult;
    }
    return std.json.parseFromSliceLeaky(protocol.Result, a, bytes, .{ .allocate = .alloc_always });
}

fn parseReceipt(a: A, bytes: []const u8) !Receipt {
    const raw = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer raw.deinit();
    if (raw.value != .object or raw.value.object.count() != 2) return error.InvalidNativeUpdateReceipt;
    if (!schemaOne(raw.value.object.get("schema_version") orelse return error.InvalidNativeUpdateReceipt)) return error.InvalidNativeUpdateReceipt;
    const transaction = raw.value.object.get("transaction_id") orelse return error.InvalidNativeUpdateReceipt;
    if (transaction != .string or !protocol.validTransaction(transaction.string)) return error.InvalidNativeUpdateReceipt;
    return std.json.parseFromSliceLeaky(Receipt, a, bytes, .{ .allocate = .alloc_always });
}

fn loadCandidate(a: A, io: std.Io, info: protocol.LocalInfo, root: []const u8, name: []const u8) !Candidate {
    const transaction = transactionFromFilename(name) orelse return error.InvalidNativeUpdateResult;
    const path = try std.fs.path.join(a, &.{ root, name });
    const file = try protocol.openManagedFile(a, io, root, path);
    defer file.close(io);
    const stat = try file.stat(io);
    if (stat.size == 0 or stat.size > max_result_bytes) return error.InvalidNativeUpdateResult;
    const bytes = try a.alloc(u8, @intCast(stat.size));
    if (try file.readPositionalAll(io, bytes, 0) != bytes.len) return error.UpdateDocumentChanged;
    var extra: [1]u8 = undefined;
    if (try file.readPositionalAll(io, &extra, stat.size) != 0) return error.UpdateDocumentChanged;
    // Result has no field defaults. Strict parsing requires every field and
    // rejects unknown and duplicate fields, unlike generic updater JSON reads.
    const result = try parseResult(a, bytes);
    try protocol.validateResult(result, info);
    if (!std.mem.eql(u8, result.transaction_id, transaction)) return error.InvalidNativeUpdateResult;
    return .{ .result = result, .modified_at = stat.mtime.nanoseconds, .name = try a.dupe(u8, name) };
}

fn scan(a: A, io: std.Io, info: protocol.LocalInfo, root: []const u8) !Scan {
    return scanWithLimit(max_files, a, io, info, root);
}

fn scanWithLimit(comptime file_limit: usize, a: A, io: std.Io, info: protocol.LocalInfo, root: []const u8) !Scan {
    if (root.len == 0 or root.len > 32768 or !std.fs.path.isAbsolute(root) or std.mem.indexOfScalar(u8, root, 0) != null) return .{ .truncated = true };
    const normalized = try std.fs.path.resolve(a, &.{root});
    if (!std.mem.eql(u8, normalized, root)) return .{ .truncated = true };
    var directory = std.Io.Dir.cwd().openDir(io, root, .{ .iterate = true, .follow_symlinks = false }) catch |err| switch (err) {
        error.FileNotFound => return .{},
        error.Canceled => return err,
        else => return .{ .truncated = true },
    };
    defer directory.close(io);
    var names: [file_limit][filename_bytes]u8 = undefined;
    var name_count: usize = 0;
    var entries: usize = 0;
    var iterator = directory.iterate();
    while (iterator.next(io) catch |err| switch (err) {
        error.Canceled => return err,
        else => return .{ .truncated = true },
    }) |entry| {
        entries += 1;
        if (entries > max_entries) return .{ .truncated = true };
        if (transactionFromFilename(entry.name) == null) continue;
        if (name_count == file_limit) return .{ .truncated = true };
        @memcpy(&names[name_count], entry.name);
        name_count += 1;
    }
    var result: Scan = .{};
    var candidates: std.ArrayList(Candidate) = .empty;
    defer candidates.deinit(a);
    for (names[0..name_count]) |*name| {
        const candidate = loadCandidate(a, io, info, root, name) catch |err| switch (err) {
            error.OutOfMemory, error.Canceled => return err,
            else => continue,
        };
        try candidates.append(a, candidate);
        if (!matchesRunning(candidate.result, info)) continue;
        if (result.selected) |previous| {
            if (candidate.modified_at < previous.modified_at) continue;
            if (candidate.modified_at == previous.modified_at and std.mem.order(u8, candidate.name, previous.name) != .gt) continue;
        }
        result.selected = candidate;
    }
    result.candidates = try candidates.toOwnedSlice(a);
    return result;
}

/// Keep the newest launch-relevant result, or the last observed result when no
/// current result applies. Use exactly the reconciliation bounds: a truncated
/// scan never authorizes deletion, including a backlog above 64 result files.
pub fn cleanupOlder(a: A, io: std.Io, info: protocol.LocalInfo, root: []const u8) !usize {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const found = try scan(temporary, io, info, root);
    if (found.truncated or found.candidates.len == 0) return 0;
    const keep_transaction = if (found.selected) |selected| selected.result.transaction_id else try observed(temporary, io, root);
    var directory = std.Io.Dir.openDirAbsolute(io, root, .{ .follow_symlinks = false }) catch |err| switch (err) {
        error.Canceled => return err,
        else => return 0,
    };
    defer directory.close(io);
    var removed: usize = 0;
    for (found.candidates) |candidate| {
        if (keep_transaction) |keep| if (std.mem.eql(u8, candidate.result.transaction_id, keep)) continue;
        // Revalidate immediately before deletion. A changed or now-untrusted
        // file remains untouched even if it had been valid during the scan.
        var check_arena = std.heap.ArenaAllocator.init(a);
        defer check_arena.deinit();
        const current = loadCandidate(check_arena.allocator(), io, info, root, candidate.name) catch |err| switch (err) {
            error.OutOfMemory, error.Canceled => return err,
            else => continue,
        };
        if (current.modified_at != candidate.modified_at) continue;
        directory.deleteFile(io, candidate.name) catch |err| switch (err) {
            error.Canceled => return err,
            else => continue,
        };
        removed += 1;
    }
    return removed;
}

fn observed(a: A, io: std.Io, root: []const u8) !?[]const u8 {
    const path = try std.fs.path.join(a, &.{ root, observed_filename });
    const bytes = protocol.readBounded(a, io, root, path, 4096) catch |err| switch (err) {
        error.OutOfMemory, error.Canceled => return err,
        else => return null,
    };
    const receipt = parseReceipt(a, bytes) catch |err| switch (err) {
        error.OutOfMemory => return err,
        else => return null,
    };
    if (receipt.schema_version != 1 or !protocol.validTransaction(receipt.transaction_id)) return null;
    return receipt.transaction_id;
}

fn pendingResultMayArrive(info: protocol.LocalInfo, prepared: ?protocol.Prepared) bool {
    const record = prepared orelse return false;
    return std.mem.eql(u8, record.hash, info.hash) and std.mem.eql(u8, record.version, info.version);
}

fn copyResult(a: A, result: protocol.Result) !protocol.Result {
    var copy = result;
    copy.transaction_id = try a.dupe(u8, result.transaction_id);
    errdefer a.free(copy.transaction_id);
    copy.message = try a.dupe(u8, result.message);
    errdefer a.free(copy.message);
    copy.identifier = try a.dupe(u8, result.identifier);
    errdefer a.free(copy.identifier);
    copy.channel = try a.dupe(u8, result.channel);
    errdefer a.free(copy.channel);
    copy.version = try a.dupe(u8, result.version);
    errdefer a.free(copy.version);
    copy.hash = try a.dupe(u8, result.hash);
    return copy;
}

pub fn freeResult(a: A, result: protocol.Result) void {
    inline for (.{ "transaction_id", "message", "identifier", "channel", "version", "hash" }) |field| a.free(@field(result, field));
}

/// The returned string fields belong to `a`; a controller request arena is a
/// convenient owner. The receipt is published without following symlinks. A
/// publication failure does not hide the native result from the running app.
/// Only a prepared target already matching the running build warrants waiting
/// for the native helper's final result (at most forty 50 ms intervals).
pub fn reconcile(a: A, io: std.Io, info: protocol.LocalInfo, root: []const u8, prepared: ?protocol.Prepared) !?protocol.Result {
    for (0..40) |_| {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        const found = try scan(temporary, io, info, root);
        if (found.truncated) return null;
        if (found.selected) |candidate| {
            if (try observed(temporary, io, root)) |transaction| {
                if (std.mem.eql(u8, transaction, candidate.result.transaction_id)) return null;
            }
            const receipt_path = try std.fs.path.join(temporary, &.{ root, observed_filename });
            const result = try copyResult(a, candidate.result);
            errdefer freeResult(a, result);
            protocol.atomicWriteJson(temporary, io, root, receipt_path, Receipt{ .schema_version = 1, .transaction_id = candidate.result.transaction_id }, 0o600) catch |err| switch (err) {
                error.OutOfMemory, error.Canceled => return err,
                else => {},
            };
            return result;
        }
        if (!pendingResultMayArrive(info, prepared)) return null;
        try std.Io.sleep(io, .fromMilliseconds(50), .awake);
    }
    return null;
}

fn readReceipt(a: A, io: std.Io, root: []const u8, path: []const u8) !std.json.Parsed(Receipt) {
    const bytes = try protocol.readBounded(a, io, root, path, 4096);
    defer a.free(bytes);
    return std.json.parseFromSlice(Receipt, a, bytes, .{ .allocate = .alloc_always });
}

const test_info = protocol.LocalInfo{ .identifier = "dev.electrobun.results-test", .channel = "canary", .version = "1.0.0", .hash = "old123", .baseUrl = "https://example.invalid/", .name = "ResultsTest-canary" };
const transaction_a = "0123456789abcdef0123456789abcdef";
const transaction_b = "1123456789abcdef0123456789abcdef";
const transaction_c = "2123456789abcdef0123456789abcdef";
const Fixture = struct {
    temporary: std.testing.TmpDir,
    arena: std.heap.ArenaAllocator,
    root: []const u8,

    fn init() !Fixture {
        var temporary = std.testing.tmpDir(.{ .iterate = true });
        errdefer temporary.cleanup();
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        errdefer arena.deinit();
        const root = try temporary.dir.realPathFileAlloc(std.testing.io, ".", arena.allocator());
        return .{ .temporary = temporary, .arena = arena, .root = root };
    }
    fn deinit(self: *Fixture) void {
        self.arena.deinit();
        self.temporary.cleanup();
    }
    fn allocator(self: *Fixture) A {
        return self.arena.allocator();
    }
    fn result(transaction: []const u8, success: bool, hash: []const u8, version: []const u8) protocol.Result {
        return .{ .schema_version = 1, .transaction_id = transaction, .success = success, .phase = if (success) .complete else .validating_payload, .message = if (success) "Installed" else "Invalid archive", .identifier = test_info.identifier, .channel = test_info.channel, .version = version, .hash = hash };
    }
    fn name(self: *Fixture, transaction: []const u8) ![]const u8 {
        return std.fmt.allocPrint(self.allocator(), "{s}{s}{s}", .{ result_prefix, transaction, result_suffix });
    }
    fn write(self: *Fixture, value: protocol.Result, modified: i96) !void {
        const filename = try self.name(value.transaction_id);
        try self.writeJson(filename, value);
        const file = try self.temporary.dir.openFile(std.testing.io, filename, .{ .mode = .read_write });
        defer file.close(std.testing.io);
        // Windows timestamps have 100ns resolution. Preserve the fixture's
        // ordering and ties instead of rounding adjacent values to the same tick.
        try file.setTimestamps(std.testing.io, .{ .modify_timestamp = .{ .new = .{ .nanoseconds = modified * 100 } } });
    }
    fn writeJson(self: *Fixture, filename: []const u8, value: anytype) !void {
        const bytes = try std.json.Stringify.valueAlloc(self.allocator(), value, .{});
        try self.temporary.dir.writeFile(std.testing.io, .{ .sub_path = filename, .data = bytes });
    }
    /// Reconciliation receives a record already validated by the controller.
    fn prepared(self: *Fixture, hash: []const u8, version: []const u8) protocol.Prepared {
        _ = self;
        return .{ .identifier = test_info.identifier, .channel = test_info.channel, .version = version, .hash = hash, .platform = protocol.native_platform, .arch = protocol.native_arch, .retained_tar_path = "", .artifact_file = "canary-macos-arm64-ResultsTest.app.tar.zst" };
    }
};

test "native result reconciliation selects installed success and persists dedupe receipt" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, true, test_info.hash, test_info.version), 1);
    // A newer success for a different installed build is not this launch's result.
    try f.write(Fixture.result(transaction_b, true, "new123", "1.0.1"), 3);
    const result = (try reconcile(f.allocator(), std.testing.io, test_info, f.root, null)).?;
    try std.testing.expectEqualStrings(transaction_a, result.transaction_id);
    try std.testing.expect(result.success);
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    const receipt_path = try std.fs.path.join(f.allocator(), &.{ f.root, observed_filename });
    const parsed = try readReceipt(f.allocator(), std.testing.io, f.root, receipt_path);
    defer parsed.deinit();
    try std.testing.expectEqualStrings(transaction_a, parsed.value.transaction_id);
}

test "native results select newest relevant failure without a prepared record" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1_000_000_000);
    try f.write(Fixture.result(transaction_b, false, "target456", "1.0.2"), 2_000_000_000);
    try f.write(Fixture.result(transaction_c, false, test_info.hash, test_info.version), 3_000_000_000);
    const result = (try reconcile(f.allocator(), std.testing.io, test_info, f.root, null)).?;
    try std.testing.expectEqualStrings(transaction_b, result.transaction_id);
    try std.testing.expect(!result.success);
}

test "native result selection breaks equal timestamp ties by filename" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1_000_000_000);
    try f.write(Fixture.result(transaction_b, false, "target456", "1.0.2"), 1_000_000_000);
    const result = (try reconcile(f.allocator(), std.testing.io, test_info, f.root, null)).?;
    try std.testing.expectEqualStrings(transaction_b, result.transaction_id);
}

test "native result strict schema filename and identity checks ignore impostors" {
    var f = try Fixture.init();
    defer f.deinit();
    const result = Fixture.result(transaction_a, false, "target123", "1.0.1");
    try f.writeJson(try f.name(transaction_b), result);
    try f.writeJson("arbitrary.result.json", result);
    var extra = try std.json.parseFromSliceLeaky(std.json.Value, f.allocator(), try std.json.Stringify.valueAlloc(f.allocator(), result, .{}), .{});
    try extra.object.put(f.allocator(), "unexpected", .{ .bool = true });
    try f.writeJson(try f.name(transaction_a), extra);
    var unrelated = result;
    unrelated.transaction_id = transaction_c;
    unrelated.identifier = "other.app";
    try f.write(unrelated, 1);
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
}

test "native result receipt must have exact fields and matching transaction" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1);
    try f.writeJson(observed_filename, .{ .schema_version = 1, .transaction_id = transaction_a, .extra = true });
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) != null);
    try f.writeJson(observed_filename, Receipt{ .schema_version = 1, .transaction_id = transaction_b });
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) != null);
}

test "native result receipts reject numeric strings duplicate fields and invalid JSON types" {
    var f = try Fixture.init();
    defer f.deinit();
    for ([_]std.json.Value{
        .{ .string = "1" }, .{ .float = 1.5 }, .{ .bool = true }, .null,
    }) |schema| {
        try f.writeJson(observed_filename, .{ .schema_version = schema, .transaction_id = transaction_a });
        try std.testing.expect(try observed(f.allocator(), std.testing.io, f.root) == null);
    }
    try f.writeJson(observed_filename, .{ .schema_version = 1, .transaction_id = @as(?[]const u8, null) });
    try std.testing.expect(try observed(f.allocator(), std.testing.io, f.root) == null);
    try f.writeJson(observed_filename, .{ .schema_version = 1, .transaction_id = 123 });
    try std.testing.expect(try observed(f.allocator(), std.testing.io, f.root) == null);
    const duplicate = "{\"schema_version\":1,\"schema_version\":1,\"transaction_id\":\"0123456789abcdef0123456789abcdef\"}";
    try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = observed_filename, .data = duplicate });
    try std.testing.expect(try observed(f.allocator(), std.testing.io, f.root) == null);
    // JavaScript's schema_version === 1 also accepts JSON 1.0 and 1e0.
    for ([_][]const u8{ "1.0", "1e0" }) |schema| {
        const raw = try std.fmt.allocPrint(f.allocator(), "{{\"schema_version\":{s},\"transaction_id\":\"{s}\"}}", .{ schema, transaction_a });
        try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = observed_filename, .data = raw });
        try std.testing.expectEqualStrings(transaction_a, (try observed(f.allocator(), std.testing.io, f.root)).?);
    }
}

test "native result parser rejects duplicate missing and invalid protocol fields" {
    var f = try Fixture.init();
    defer f.deinit();
    const valid = Fixture.result(transaction_a, false, "target123", "1.0.1");
    const filename = try f.name(transaction_a);
    const bytes = try std.json.Stringify.valueAlloc(f.allocator(), valid, .{});
    const duplicate = try std.fmt.allocPrint(f.allocator(), "{s},\"success\":false}}", .{bytes[0 .. bytes.len - 1]});
    try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = filename, .data = duplicate });
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);

    inline for (.{ "schema_version", "transaction_id", "success", "phase", "message", "identifier", "channel", "version", "hash" }) |missing| {
        var document = try std.json.parseFromSliceLeaky(std.json.Value, f.allocator(), bytes, .{});
        try std.testing.expect(document.object.swapRemove(missing));
        try f.writeJson(filename, document);
        try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    }
    const Invalid = struct { field: []const u8, value: std.json.Value };
    const long_message: [4097]u8 = @splat('x');
    const long_version: [257]u8 = @splat('v');
    const uppercase_transaction: [32]u8 = @splat('A');
    for ([_]Invalid{
        .{ .field = "schema_version", .value = .{ .integer = 2 } },
        .{ .field = "schema_version", .value = .{ .string = "1" } },
        .{ .field = "schema_version", .value = .{ .float = 1.5 } },
        .{ .field = "schema_version", .value = .null },
        .{ .field = "success", .value = .{ .bool = true } },
        .{ .field = "success", .value = .{ .integer = 0 } },
        .{ .field = "success", .value = .{ .string = "false" } },
        .{ .field = "success", .value = .null },
        .{ .field = "phase", .value = .{ .integer = 0 } },
        .{ .field = "phase", .value = .null },
        .{ .field = "phase", .value = .{ .string = "complete" } },
        .{ .field = "phase", .value = .{ .string = "unknown" } },
        .{ .field = "message", .value = .{ .string = "" } },
        .{ .field = "message", .value = .{ .string = "Control\ncharacter" } },
        .{ .field = "message", .value = .{ .string = &long_message } },
        .{ .field = "version", .value = .{ .string = &long_version } },
        .{ .field = "hash", .value = .{ .string = "UPPERCASE" } },
        .{ .field = "transaction_id", .value = .{ .string = &uppercase_transaction } },
    }) |invalid| {
        var document = try std.json.parseFromSliceLeaky(std.json.Value, f.allocator(), bytes, .{});
        try document.object.put(f.allocator(), invalid.field, invalid.value);
        try f.writeJson(filename, document);
        try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    }
    inline for (.{ "transaction_id", "message", "identifier", "channel", "version", "hash" }) |field| {
        for ([_]std.json.Value{ .{ .integer = 1 }, .{ .bool = true }, .null }) |value| {
            var document = try std.json.parseFromSliceLeaky(std.json.Value, f.allocator(), bytes, .{});
            try document.object.put(f.allocator(), field, value);
            try f.writeJson(filename, document);
            try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
        }
    }
    for ([_][]const u8{ "1.0", "1e0" }) |schema| {
        const numeric = try std.mem.replaceOwned(u8, f.allocator(), bytes, "\"schema_version\":1", try std.fmt.allocPrint(f.allocator(), "\"schema_version\":{s}", .{schema}));
        const result = try parseResult(f.allocator(), numeric);
        try protocol.validateResult(result, test_info);
        try std.testing.expectEqual(@as(u32, 1), result.schema_version);
    }
}

test "native result scanner accepts exactly sixty four candidates" {
    var f = try Fixture.init();
    defer f.deinit();
    var latest: []const u8 = undefined;
    for (0..64) |index| {
        latest = try std.fmt.allocPrint(f.allocator(), "{x:0>32}", .{index});
        try f.write(Fixture.result(latest, false, "target123", "1.0.1"), @intCast(index + 1));
    }
    const result = (try reconcile(f.allocator(), std.testing.io, test_info, f.root, null)).?;
    try std.testing.expectEqualStrings(latest, result.transaction_id);
    try std.testing.expectEqual(@as(usize, 63), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, f.root));
}

test "native result scan fails closed beyond file and directory limits" {
    {
        var f = try Fixture.init();
        defer f.deinit();
        try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1);
        for (0..64) |index| {
            const transaction = try std.fmt.allocPrint(f.allocator(), "{x:0>32}", .{index});
            try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = try f.name(transaction), .data = "{}" });
        }
        try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    }
    {
        var f = try Fixture.init();
        defer f.deinit();
        try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1);
        for (0..1024) |index| {
            const filename = try std.fmt.allocPrint(f.allocator(), "irrelevant-{d}", .{index});
            try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = filename, .data = "" });
        }
        try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    }
}

test "native result pruning refuses a backlog beyond the reconciliation limit" {
    var f = try Fixture.init();
    defer f.deinit();
    for (0..70) |index| {
        const transaction = try std.fmt.allocPrint(f.allocator(), "{x:0>32}", .{index});
        try f.write(Fixture.result(transaction, false, "target123", "1.0.1"), @as(i96, @intCast(index + 1)) * std.time.ns_per_s);
    }
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    try std.testing.expectEqual(@as(usize, 0), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, f.root));
    var iterator = f.temporary.dir.iterate();
    var count: usize = 0;
    while (try iterator.next(std.testing.io)) |_| count += 1;
    try std.testing.expectEqual(@as(usize, 70), count);
}

test "native result pruning retains an observed receipt when no result matches the running build" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, true, "past123", "0.9.0"), 1);
    try f.write(Fixture.result(transaction_b, true, "past456", "0.9.1"), 2);
    try f.writeJson(observed_filename, Receipt{ .schema_version = 1, .transaction_id = transaction_a });
    try std.testing.expectEqual(@as(usize, 1), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, f.root));
    _ = try f.temporary.dir.statFile(std.testing.io, try f.name(transaction_a), .{});
    try std.testing.expectError(error.FileNotFound, f.temporary.dir.statFile(std.testing.io, try f.name(transaction_b), .{}));
}

test "native result pruning preserves malformed foreign and arbitrary files" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 2);
    try f.write(Fixture.result(transaction_b, false, "target456", "1.0.2"), 1);
    var foreign = Fixture.result(transaction_c, false, "target789", "1.0.3");
    foreign.identifier = "other.app";
    try f.write(foreign, 3);
    const malformed = try f.name("3123456789abcdef0123456789abcdef");
    try f.writeJson(malformed, .{ .schema_version = 1 });
    const mismatch = try f.name("4123456789abcdef0123456789abcdef");
    try f.writeJson(mismatch, Fixture.result(transaction_a, false, "target123", "1.0.1"));
    try f.writeJson("arbitrary.result.json", Fixture.result(transaction_b, false, "target456", "1.0.2"));
    const directory = try f.name("5123456789abcdef0123456789abcdef");
    try f.temporary.dir.createDir(std.testing.io, directory, .default_dir);
    try std.testing.expectEqual(@as(usize, 1), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, f.root));
    try std.testing.expectError(error.FileNotFound, f.temporary.dir.statFile(std.testing.io, try f.name(transaction_b), .{}));
    for ([_][]const u8{ try f.name(transaction_a), try f.name(transaction_c), malformed, mismatch, "arbitrary.result.json", directory }) |name| {
        _ = try f.temporary.dir.statFile(std.testing.io, name, .{ .follow_symlinks = false });
    }
}

test "native result pruning refuses symlink files roots and directory overflow" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 2);
    try f.write(Fixture.result(transaction_b, false, "target456", "1.0.2"), 1);
    if (@import("builtin").os.tag != .windows) {
        var outside = try Fixture.init();
        defer outside.deinit();
        try outside.write(Fixture.result(transaction_c, false, "target789", "1.0.3"), 3);
        const name = try f.name(transaction_c);
        const external = try std.fs.path.join(f.allocator(), &.{ outside.root, name });
        try f.temporary.dir.symLink(std.testing.io, external, name, .{});
        try f.temporary.dir.symLink(std.testing.io, outside.root, "linked-root", .{ .is_directory = true });
        const linked_root = try std.fs.path.join(f.allocator(), &.{ f.root, "linked-root" });
        try std.testing.expectEqual(@as(usize, 0), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, linked_root));
        try std.testing.expectEqual(@as(usize, 1), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, f.root));
        try std.testing.expectEqual(std.Io.File.Kind.sym_link, (try f.temporary.dir.statFile(std.testing.io, name, .{ .follow_symlinks = false })).kind);
        _ = try outside.temporary.dir.statFile(std.testing.io, name, .{});
        try f.write(Fixture.result(transaction_b, false, "target456", "1.0.2"), 1);
    }
    for (0..max_entries) |index| {
        const name = try std.fmt.allocPrint(f.allocator(), "irrelevant-{d}", .{index});
        try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = name, .data = "" });
    }
    try std.testing.expectEqual(@as(usize, 0), try cleanupOlder(std.testing.allocator, std.testing.io, test_info, f.root));
    _ = try f.temporary.dir.statFile(std.testing.io, try f.name(transaction_a), .{});
    _ = try f.temporary.dir.statFile(std.testing.io, try f.name(transaction_b), .{});
}

test "native results wait only when a prepared update is already installed" {
    var f = try Fixture.init();
    defer f.deinit();
    const prepared = f.prepared("target123", "1.0.1");
    const start = std.Io.Clock.awake.now(std.testing.io).nanoseconds;
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, prepared) == null);
    try std.testing.expect(std.Io.Clock.awake.now(std.testing.io).nanoseconds - start < std.time.ns_per_s);
}

test "native results wait for the installed target helper to publish its result" {
    var f = try Fixture.init();
    defer f.deinit();
    const prepared = f.prepared(test_info.hash, test_info.version);
    const Delayed = struct {
        fn publish(root: []const u8) anyerror!void {
            try std.Io.sleep(std.testing.io, .fromMilliseconds(100), .awake);
            var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
            defer arena.deinit();
            const a = arena.allocator();
            const name = try std.fmt.allocPrint(a, "{s}{s}{s}", .{ result_prefix, transaction_a, result_suffix });
            const path = try std.fs.path.join(a, &.{ root, name });
            try protocol.atomicWriteJson(a, std.testing.io, root, path, Fixture.result(transaction_a, true, test_info.hash, test_info.version), 0o600);
        }
    };
    var helper = try std.testing.io.concurrent(Delayed.publish, .{f.root});
    defer helper.cancel(std.testing.io) catch {};
    const result = (try reconcile(f.allocator(), std.testing.io, test_info, f.root, prepared)).?;
    try helper.await(std.testing.io);
    try std.testing.expect(result.success);
    try std.testing.expectEqualStrings(transaction_a, result.transaction_id);
}

test "native result strings outlive temporary parsing allocations" {
    var f = try Fixture.init();
    defer f.deinit();
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1);
    const result = (try reconcile(std.testing.allocator, std.testing.io, test_info, f.root, null)).?;
    defer freeResult(std.testing.allocator, result);
    try std.testing.expectEqualStrings("Invalid archive", result.message);
    try std.testing.expectEqualStrings(test_info.identifier, result.identifier);
}

test "native result scan ignores oversized files and refuses noncanonical roots" {
    var f = try Fixture.init();
    defer f.deinit();
    const oversized = try f.allocator().alloc(u8, max_result_bytes + 1);
    @memset(oversized, ' ');
    try f.temporary.dir.writeFile(std.testing.io, .{ .sub_path = try f.name(transaction_a), .data = oversized });
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    const missing = try std.fs.path.join(f.allocator(), &.{ f.root, "missing" });
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, missing, null) == null);
    try f.write(Fixture.result(transaction_a, false, "target123", "1.0.1"), 1);
    const noncanonical = try std.fmt.allocPrint(f.allocator(), "{s}/.", .{f.root});
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, noncanonical, null) == null);
}

test "native results do not follow symlink results roots or receipts" {
    if (@import("builtin").os.tag == .windows) return error.SkipZigTest;
    var f = try Fixture.init();
    defer f.deinit();
    var outside = try Fixture.init();
    defer outside.deinit();
    const result = Fixture.result(transaction_a, false, "target123", "1.0.1");
    try outside.write(result, 1);
    const filename = try f.name(transaction_a);
    const outside_result = try std.fs.path.join(f.allocator(), &.{ outside.root, filename });
    try f.temporary.dir.symLink(std.testing.io, outside_result, filename, .{});
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, f.root, null) == null);
    try f.temporary.dir.symLink(std.testing.io, outside.root, "linked-root", .{ .is_directory = true });
    const linked_root = try std.fs.path.join(f.allocator(), &.{ f.root, "linked-root" });
    try std.testing.expect(try reconcile(f.allocator(), std.testing.io, test_info, linked_root, null) == null);
    try f.temporary.dir.deleteFile(std.testing.io, filename);
    try f.write(result, 1);
    try outside.writeJson(observed_filename, Receipt{ .schema_version = 1, .transaction_id = transaction_b });
    const outside_receipt = try std.fs.path.join(f.allocator(), &.{ outside.root, observed_filename });
    try f.temporary.dir.symLink(std.testing.io, outside_receipt, observed_filename, .{});
    const reported = (try reconcile(std.testing.allocator, std.testing.io, test_info, f.root, null)).?;
    defer freeResult(std.testing.allocator, reported);
    try std.testing.expectEqualStrings(transaction_a, reported.transaction_id);
    const unchanged = try readReceipt(f.allocator(), std.testing.io, outside.root, outside_receipt);
    defer unchanged.deinit();
    try std.testing.expectEqualStrings(transaction_b, unchanged.value.transaction_id);
}

test "native result polling responds promptly to cancellation" {
    var f = try Fixture.init();
    defer f.deinit();
    const prepared = f.prepared(test_info.hash, test_info.version);
    var polling = try std.testing.io.concurrent(reconcile, .{ std.testing.allocator, std.testing.io, test_info, f.root, @as(?protocol.Prepared, prepared) });
    defer _ = polling.cancel(std.testing.io) catch {};
    try std.Io.sleep(std.testing.io, .fromMilliseconds(20), .awake);
    const start = std.Io.Clock.awake.now(std.testing.io).nanoseconds;
    try std.testing.expectError(error.Canceled, polling.cancel(std.testing.io));
    try std.testing.expect(std.Io.Clock.awake.now(std.testing.io).nanoseconds - start < std.time.ns_per_s);
}
