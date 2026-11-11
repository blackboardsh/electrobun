//! Bounded manifest/checksum resolution for every Electrobun runtime. Artifact
//! preparation stays in the extractor; this module never downloads an archive.
const std = @import("std");
const protocol = @import("updater_protocol.zig");
const A = std.mem.Allocator;
const Io = std.Io;
pub const max_document_bytes = 1024 * 1024;
pub const max_redirects = 20;

pub const Options = struct {
    local: protocol.LocalInfo,
    /// Already resolved from trusted bundle metadata by updater_protocol.
    base_url: []const u8,
    platform: protocol.Platform,
    arch: protocol.Arch,
    installation_id: ?[]const u8 = null,
    timeout_ms: u32 = 30_000,
};
pub const Resolved = struct {
    arena: std.heap.ArenaAllocator,
    status: enum { available, disabled },
    manifest: ?protocol.Manifest = null,
    download_base_url: []const u8 = "",
    pub fn deinit(self: *Resolved) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

/// Unknown fields in public metadata are deliberately ignored for compatibility
/// with hosts that add release annotations. Identity/integrity remain validated.
pub fn resolve(a: A, io: Io, options: Options) !Resolved {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    if (std.mem.eql(u8, options.local.channel, "dev") or
        options.local.updateAuthority != .direct)
        return .{ .arena = arena, .status = .disabled };
    if (!std.mem.eql(u8, options.local.channel, "stable") and
        !std.mem.eql(u8, options.local.channel, "canary")) return error.InvalidUpdateChannel;
    const base = std.mem.trimEnd(u8, options.base_url, "/");
    const uri = try checkedUri(base);
    if (uri.query != null) return error.InvalidUpdateUrl;
    // A self-hosted folder must never receive the installation header, even if
    // an internal caller accidentally supplied the identity.
    const identity = if (options.local.managed != null)
        options.installation_id orelse return error.MissingManagedInstallationId
    else
        null;
    if (identity) |id| if (!validInstallationId(id)) return error.InvalidInstallationId;
    var nonce: [8]u8 = undefined;
    io.random(&nonce);
    const suffix = std.fmt.bytesToHex(nonce, .lower);
    const prefix = try std.fmt.allocPrint(owned, "{s}/{s}-{s}-{s}", .{ base, options.local.channel, @tagName(options.platform), @tagName(options.arch) });
    const manifest_url = try std.fmt.allocPrint(owned, "{s}-update.json?{s}", .{ prefix, suffix });
    const response = try fetchDocument(owned, io, manifest_url, .{ .installation_id = identity, .timeout_ms = options.timeout_ms });
    if (response.status < 200 or response.status >= 300) return error.UpdateHttpStatus;
    var manifest = try parseManifest(owned, response.body);
    try protocol.validateManifest(owned, manifest, options.local, options.platform, options.arch);
    if (!std.mem.eql(u8, manifest.hash, options.local.hash) and manifest.artifact.tarSha256 == null) {
        const checksum_url = try std.fmt.allocPrint(owned, "{s}-{s}-checksum.json?{s}", .{ prefix, manifest.hash, suffix });
        const checksum_response = try fetchDocument(owned, io, checksum_url, .{ .installation_id = identity, .timeout_ms = options.timeout_ms });
        if (checksum_response.status != 404) {
            if (checksum_response.status < 200 or checksum_response.status >= 300) return error.UpdateHttpStatus;
            const checksum = try parseChecksum(owned, checksum_response.body);
            try protocol.validateChecksum(checksum);
            manifest.artifact.tarSha256 = checksum.tarSha256;
            manifest.artifact.tarSize = checksum.tarSize;
        }
    }
    return .{ .arena = arena, .status = .available, .manifest = manifest, .download_base_url = try owned.dupe(u8, base) };
}

// Optional integrity means omitted properties, matching the JS public API.
// Explicit null must not silently become a legacy host without integrity.
fn parseManifest(a: A, bytes: []const u8) !protocol.Manifest {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidUpdateManifest;
    if (!jsonNumber(parsed.value.object.get("schemaVersion") orelse return error.InvalidUpdateManifest)) return error.InvalidUpdateManifest;
    const platform = parsed.value.object.get("platform") orelse return error.InvalidUpdateManifest;
    const arch = parsed.value.object.get("arch") orelse return error.InvalidUpdateManifest;
    if (platform != .string or std.meta.stringToEnum(protocol.Platform, platform.string) == null or
        arch != .string or std.meta.stringToEnum(protocol.Arch, arch.string) == null) return error.InvalidUpdateManifest;
    const artifact = parsed.value.object.get("artifact") orelse return error.InvalidUpdateManifest;
    if (artifact != .object) return error.InvalidUpdateManifest;
    for ([_][]const u8{ "tarSha256", "tarSize" }) |field| {
        if (artifact.object.get(field)) |value| if (value == .null) return error.InvalidUpdateArchiveIntegrity;
    }
    if (artifact.object.get("tarSize")) |size| if (!jsonNumber(size)) return error.InvalidUpdateArchiveIntegrity;
    return std.json.parseFromValueLeaky(protocol.Manifest, a, parsed.value, .{ .ignore_unknown_fields = true });
}

fn jsonNumber(value: std.json.Value) bool {
    return switch (value) {
        .integer, .float, .number_string => true,
        else => false,
    };
}
fn parseChecksum(a: A, bytes: []const u8) !protocol.Checksum {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidUpdateArchiveIntegrity;
    if (!jsonNumber(parsed.value.object.get("tarSize") orelse return error.InvalidUpdateArchiveIntegrity)) return error.InvalidUpdateArchiveIntegrity;
    return std.json.parseFromValueLeaky(protocol.Checksum, a, parsed.value, .{ .ignore_unknown_fields = true });
}

pub fn validInstallationId(value: []const u8) bool {
    if (value.len != 32) return false;
    for (value) |byte| if (!std.ascii.isDigit(byte) and !(byte >= 'a' and byte <= 'f')) return false;
    return true;
}

pub fn checkedUri(url: []const u8) !std.Uri {
    if (url.len == 0 or url.len > 8192) return error.InvalidUpdateUrl;
    for (url) |byte| if (byte < 0x21 or byte == 0x7f or byte == '\\') return error.InvalidUpdateUrl;
    const uri = std.Uri.parse(url) catch return error.InvalidUpdateUrl;
    if (uri.user != null or uri.password != null or uri.fragment != null or uri.port == 0) return error.InvalidUpdateUrl;
    const host = uriHost(uri) orelse return error.InvalidUpdateUrl;
    if (host.len == 0 or std.mem.indexOfScalar(u8, host, '%') != null) return error.InvalidUpdateUrl;
    if (!std.ascii.eqlIgnoreCase(uri.scheme, "https")) {
        if (!std.ascii.eqlIgnoreCase(uri.scheme, "http") or
            (!std.ascii.eqlIgnoreCase(host, "localhost") and
                !std.mem.eql(u8, host, "127.0.0.1") and !std.mem.eql(u8, host, "::1") and !std.mem.eql(u8, host, "[::1]")))
            return error.InsecureUpdateUrl;
    }
    return uri;
}

fn uriHost(uri: std.Uri) ?[]const u8 {
    return switch (uri.host orelse return null) {
        .raw, .percent_encoded => |value| value,
    };
}
fn effectivePort(uri: std.Uri) u16 {
    return uri.port orelse @as(u16, if (std.ascii.eqlIgnoreCase(uri.scheme, "https")) 443 else 80);
}
/// Once a redirect leaves the configured origin, never restore the identifier.
fn redirectedInstallationId(id: ?[]const u8, previous: []const u8, next: []const u8) !?[]const u8 {
    if (id == null) return null;
    const from = try checkedUri(previous);
    const to = try checkedUri(next);
    return if (std.ascii.eqlIgnoreCase(from.scheme, to.scheme) and
        std.ascii.eqlIgnoreCase(uriHost(from).?, uriHost(to).?) and effectivePort(from) == effectivePort(to)) id else null;
}
fn redirectUrl(a: A, previous: []const u8, location: []const u8) ![]u8 {
    if (location.len == 0 or location.len > 8192) return error.InvalidUpdateRedirect;
    for (location) |byte| if (byte < 0x21 or byte == 0x7f or byte == '\\') return error.InvalidUpdateRedirect;
    const base = try checkedUri(previous);
    var storage: [3 * 8192]u8 = undefined;
    @memcpy(storage[0..location.len], location);
    var auxiliary: []u8 = &storage;
    const resolved = base.resolveInPlace(location.len, &auxiliary) catch return error.InvalidUpdateRedirect;
    const url = try std.fmt.allocPrint(a, "{f}", .{resolved});
    errdefer a.free(url);
    const destination = try checkedUri(url);
    if (std.ascii.eqlIgnoreCase(base.scheme, "https") and !std.ascii.eqlIgnoreCase(destination.scheme, "https"))
        return error.UpdateRedirectDowngrade;
    return url;
}

pub const FetchOptions = struct { installation_id: ?[]const u8 = null, timeout_ms: u32 = 30_000, max_bytes: usize = max_document_bytes };
pub const Response = struct { status: u16, body: []u8 };
/// Caller owns the returned body. The deadline covers headers, redirects and
/// complete body reads; cancellation joins the transfer before returning.
pub fn fetchDocument(a: A, io: Io, url: []const u8, options: FetchOptions) !Response {
    _ = try checkedUri(url);
    if (options.installation_id) |id| if (!validInstallationId(id)) return error.InvalidInstallationId;
    const Transfer = struct {
        a: A,
        io: Io,
        url: []const u8,
        options: FetchOptions,
        response: ?Response = null,
        const Completion = struct { result: anyerror!void, finished_at: Io.Clock.Timestamp };
        fn run(self: *@This()) Completion {
            const result = self.execute();
            return .{ .result = result, .finished_at = .now(self.io, .awake) };
        }
        fn execute(self: *@This()) !void {
            self.response = try exchange(self.a, self.io, self.url, self.options);
        }
    };
    var transfer: Transfer = .{ .a = a, .io = io, .url = url, .options = options };
    defer if (transfer.response) |response| a.free(response.body);
    const Outcome = union(enum) { transfer: Transfer.Completion, timer: Io.Cancelable!void };
    const deadline = (Io.Timeout{ .duration = .{ .raw = .fromMilliseconds(options.timeout_ms), .clock = .awake } }).toDeadline(io);
    const outcome = blk: {
        var buffer: [2]Outcome = undefined;
        var select = Io.Select(Outcome).init(io, &buffer);
        defer select.cancelDiscard();
        try select.concurrent(.transfer, Transfer.run, .{&transfer});
        try select.concurrent(.timer, Io.Timeout.sleep, .{ deadline, io });
        break :blk try select.await();
    };
    switch (outcome) {
        .transfer => |completion| {
            if (completion.finished_at.compare(.gte, deadline.deadline)) return error.UpdateDocumentTimeout;
            try completion.result;
        },
        .timer => return error.UpdateDocumentTimeout,
    }
    const response = transfer.response.?;
    transfer.response = null;
    return response;
}

fn exchange(a: A, io: Io, url: []const u8, options: FetchOptions) !Response {
    var client: std.http.Client = .{ .allocator = a, .io = io };
    defer client.deinit();
    var redirects: std.heap.ArenaAllocator = .init(a);
    defer redirects.deinit();
    var current_url = url;
    var identity = options.installation_id;
    var followed: usize = 0;
    while (true) {
        try io.checkCancel();
        const headers: [1]std.http.Header = .{.{ .name = "X-Electrobun-Installation-Id", .value = identity orelse "" }};
        var uri = try checkedUri(current_url);
        if (std.ascii.eqlIgnoreCase(uriHost(uri).?, "localhost")) uri.host = .{ .raw = "127.0.0.1" };
        var request = try client.request(.GET, uri, .{
            .redirect_behavior = .unhandled,
            .keep_alive = false,
            .headers = .{ .accept_encoding = .{ .override = "identity" } },
            .extra_headers = if (identity != null) &headers else &.{},
        });
        defer {
            if (request.connection) |connection| connection.closing = true;
            request.deinit();
        }
        request.accept_encoding = @splat(false);
        request.accept_encoding[@backingInt(std.http.ContentEncoding.identity)] = true;
        try request.sendBodiless();
        var response = try request.receiveHead(&.{});
        switch (response.head.status) {
            .moved_permanently, .found, .see_other, .temporary_redirect, .permanent_redirect => {
                if (followed == max_redirects) return error.TooManyUpdateRedirects;
                const location = response.head.location orelse return error.UpdateRedirectLocationMissing;
                const next = try redirectUrl(redirects.allocator(), current_url, location);
                identity = try redirectedInstallationId(identity, current_url, next);
                current_url = next;
                followed += 1;
                continue;
            },
            else => {},
        }
        const status: u16 = @backingInt(response.head.status);
        // Missing sidecars are expected on existing hosts. Error bodies can be
        // arbitrarily large, and neither case needs to consume them.
        if (status < 200 or status >= 300) return .{ .status = status, .body = try a.alloc(u8, 0) };
        if (response.head.content_length) |length| if (length > options.max_bytes) return error.UpdateDocumentTooLarge;
        var transfer_buffer: [16 * 1024]u8 = undefined;
        const reader = response.reader(&transfer_buffer);
        var chunk: [16 * 1024]u8 = undefined;
        var bytes: std.ArrayList(u8) = .empty;
        defer bytes.deinit(a);
        while (true) {
            try io.checkCancel();
            const length = try reader.readSliceShort(&chunk);
            if (length == 0) break;
            if (length > options.max_bytes - bytes.items.len) return error.UpdateDocumentTooLarge;
            try bytes.appendSlice(a, chunk[0..length]);
        }
        if (response.head.content_length) |length| if (length != bytes.items.len) return error.TruncatedUpdateDocument;
        return .{ .status = status, .body = try bytes.toOwnedSlice(a) };
    }
}

test "manifest URLs reject insecure hosts and redirect credential leaks" {
    _ = try checkedUri("https://updates.example.test/canary-linux-x64-update.json?123");
    for ([_][]const u8{ "http://localhost/a", "http://127.0.0.1:4000/a", "http://[::1]/a" }) |url| _ = try checkedUri(url);
    for ([_][]const u8{ "http://example.com/a", "http://127.0.0.2/a", "http://localhost.example.com/a", "ftp://localhost/a" }) |url|
        try std.testing.expectError(error.InsecureUpdateUrl, checkedUri(url));
    for ([_][]const u8{ "https://user:password@example.com/a", "https://example.com/a#secret", "https://exa%6dple.com/a", "https://example.com:0/a" }) |url|
        try std.testing.expectError(error.InvalidUpdateUrl, checkedUri(url));
    const a = std.testing.allocator;
    const relative = try redirectUrl(a, "https://updates.example.test/app/start", "../cdn/next?key=one%2Ftwo");
    defer a.free(relative);
    try std.testing.expectEqualStrings("https://updates.example.test/cdn/next?key=one%2Ftwo", relative);
    try std.testing.expectError(error.UpdateRedirectDowngrade, redirectUrl(a, "https://updates.example.test/a", "http://localhost/a"));
    try std.testing.expectError(error.InvalidUpdateRedirect, redirectUrl(a, "https://updates.example.test/a", "/a\r\nX-Injected:yes"));
}

test "installation identity is stripped permanently after any origin change" {
    const id = "abcdef0123456789abcdef0123456789";
    try std.testing.expectEqualStrings(id, (try redirectedInstallationId(id, "https://updates.example.test/a", "https://UPDATES.example.test:443/b")).?);
    for ([_][]const u8{ "https://cdn.example.test/a", "https://updates.example.test:444/a", "http://127.0.0.1/a" }) |destination| {
        const stripped = try redirectedInstallationId(id, "https://updates.example.test/a", destination);
        try std.testing.expectEqual(@as(?[]const u8, null), stripped);
        try std.testing.expectEqual(@as(?[]const u8, null), try redirectedInstallationId(stripped, destination, "https://updates.example.test/a"));
    }
    for ([_][]const u8{ "", "abcdef", "ABCDEF0123456789abcdef0123456789", "abcdef0123456789abcdef012345678x", "abcdef0123456789abcdef0123456789\r\n" }) |invalid|
        try std.testing.expect(!validInstallationId(invalid));
}

const TestServer = struct {
    listener: Io.net.Server,
    steps: []const Step = &.{},
    requested: Io.Event = .unset,
    const Step = struct {
        path: []const u8,
        cache_buster: bool = false,
        status: u16 = 200,
        location: ?[]const u8 = null,
        body: []const u8 = "",
        delay_ms: u32 = 0,
        installation_id: ?[]const u8 = null,
        content_length: bool = true,
    };
    fn init() !TestServer {
        const address = try Io.net.IpAddress.parse("127.0.0.1", 0);
        return .{ .listener = try address.listen(std.testing.io, .{}) };
    }
    fn deinit(self: *TestServer) void {
        self.listener.deinit(std.testing.io);
    }
    fn url(self: *TestServer, path: []const u8) ![]u8 {
        return std.fmt.allocPrint(std.testing.allocator, "http://127.0.0.1:{d}{s}", .{ self.listener.socket.address.getPort(), path });
    }
    fn serve(self: *TestServer) !void {
        const io = std.testing.io;
        for (self.steps) |step| {
            const connection = try self.listener.accept(io);
            defer connection.close(io);
            var read_buffer: [4096]u8 = undefined;
            var reader = connection.reader(io, &read_buffer);
            const line = try reader.interface.takeDelimiterInclusive('\n');
            var parts = std.mem.splitScalar(u8, line, ' ');
            try std.testing.expectEqualStrings("GET", parts.next().?);
            const path = parts.next().?;
            if (step.cache_buster) {
                const query = std.mem.indexOfScalar(u8, path, '?') orelse return error.MissingCacheBuster;
                try std.testing.expectEqualStrings(step.path, path[0..query]);
                try std.testing.expectEqual(@as(usize, 16), path[query + 1 ..].len);
                for (path[query + 1 ..]) |c| try std.testing.expect(std.ascii.isHex(c));
            } else try std.testing.expectEqualStrings(step.path, path);
            var id_seen = false;
            while (true) {
                const header = try reader.interface.takeDelimiterInclusive('\n');
                if (std.mem.eql(u8, header, "\r\n")) break;
                const colon = std.mem.indexOfScalar(u8, header, ':') orelse continue;
                if (!std.ascii.eqlIgnoreCase(header[0..colon], "X-Electrobun-Installation-Id")) continue;
                try std.testing.expect(!id_seen);
                id_seen = true;
                try std.testing.expectEqualStrings(step.installation_id orelse return error.UnexpectedInstallationHeader, std.mem.trim(u8, header[colon + 1 ..], " \r\n"));
            }
            try std.testing.expectEqual(step.installation_id != null, id_seen);
            self.requested.set(io);
            if (step.delay_ms != 0) try Io.sleep(io, .fromMilliseconds(step.delay_ms), .awake);
            var write_buffer: [4096]u8 = undefined;
            var writer = connection.writer(io, &write_buffer);
            try writer.interface.print("HTTP/1.1 {d} Response\r\nConnection: close\r\n", .{step.status});
            if (step.content_length) try writer.interface.print("Content-Length: {d}\r\n", .{step.body.len});
            if (step.location) |location| try writer.interface.print("Location: {s}\r\n", .{location});
            try writer.interface.writeAll("\r\n");
            try writer.interface.writeAll(step.body);
            try writer.interface.flush();
        }
    }
};
fn testFetch(server: *TestServer, url: []const u8, options: FetchOptions) !Response {
    var serving = try std.testing.io.concurrent(TestServer.serve, .{server});
    defer serving.cancel(std.testing.io) catch {};
    const response = try fetchDocument(std.testing.allocator, std.testing.io, url, options);
    errdefer std.testing.allocator.free(response.body);
    try serving.await(std.testing.io);
    return response;
}
const test_id = "abcdef0123456789abcdef0123456789";
const test_digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const test_manifest = "{\"schemaVersion\":1,\"identifier\":\"dev.test.app\",\"channel\":\"stable\",\"version\":\"2\",\"hash\":\"next\",\"platform\":\"linux\",\"arch\":\"x64\",\"artifact\":{\"file\":\"stable-linux-x64-Test.tar.zst\",\"futureField\":true},\"futureField\":true}";
fn testLocal() protocol.LocalInfo {
    return .{ .identifier = "dev.test.app", .channel = "stable", .version = "1", .hash = "old", .baseUrl = "https://unused.example.test", .name = "Test" };
}
fn testResolve(server: *TestServer, local: protocol.LocalInfo) !Resolved {
    var serving = try std.testing.io.concurrent(TestServer.serve, .{server});
    defer serving.cancel(std.testing.io) catch {};
    const base = try server.url("/releases");
    defer std.testing.allocator.free(base);
    var resolved = try resolve(std.testing.allocator, std.testing.io, .{ .local = local, .base_url = base, .platform = .linux, .arch = .x64, .installation_id = test_id, .timeout_ms = 3000 });
    errdefer resolved.deinit();
    try serving.await(std.testing.io);
    return resolved;
}

test "canonical metadata resolves a hash-specific checksum and ignores unknown fields" {
    var server = try TestServer.init();
    defer server.deinit();
    server.steps = &.{
        .{ .path = "/releases/stable-linux-x64-update.json", .cache_buster = true, .body = test_manifest },
        .{ .path = "/releases/stable-linux-x64-next-checksum.json", .cache_buster = true, .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":12345,\"futureField\":true}" },
    };
    var resolved = try testResolve(&server, testLocal());
    defer resolved.deinit();
    try std.testing.expectEqual(.available, resolved.status);
    try std.testing.expectEqualStrings("next", resolved.manifest.?.hash);
    try std.testing.expectEqualStrings(test_digest, resolved.manifest.?.artifact.tarSha256.?);
    try std.testing.expectEqual(@as(?u64, 12345), resolved.manifest.?.artifact.tarSize);
}

test "only missing checksum falls back while malformed or failed checksum aborts" {
    for ([_]TestServer.Step{
        .{ .path = "/releases/stable-linux-x64-next-checksum.json", .cache_buster = true, .status = 404 },
        .{ .path = "/releases/stable-linux-x64-next-checksum.json", .cache_buster = true, .status = 500 },
        .{ .path = "/releases/stable-linux-x64-next-checksum.json", .cache_buster = true, .body = "{}" },
        .{ .path = "/releases/stable-linux-x64-next-checksum.json", .cache_buster = true, .body = "{\"tarSha256\":\"invalid\",\"tarSize\":12345}" },
    }) |checksum| {
        var server = try TestServer.init();
        defer server.deinit();
        server.steps = &.{ .{ .path = "/releases/stable-linux-x64-update.json", .cache_buster = true, .body = test_manifest }, checksum };
        const result = testResolve(&server, testLocal());
        if (checksum.status == 404) {
            var resolved = try result;
            defer resolved.deinit();
            try std.testing.expect(resolved.manifest.?.artifact.tarSha256 == null);
        } else if (result) |value| {
            var unexpected = value;
            unexpected.deinit();
            return error.ExpectedChecksumFailure;
        } else |_| {}
    }
}

test "equal hashes avoid checksum requests and managed manifests carry installation identity" {
    var server = try TestServer.init();
    defer server.deinit();
    var local = testLocal();
    local.hash = "next";
    local.managed = .{ .appId = "test-app" };
    server.steps = &.{.{ .path = "/releases/stable-linux-x64-update.json", .cache_buster = true, .body = test_manifest, .installation_id = test_id }};
    var resolved = try testResolve(&server, local);
    defer resolved.deinit();
    try std.testing.expect(resolved.manifest.?.artifact.tarSha256 == null);
}

test "valid inline integrity avoids sidecar requests" {
    const manifest = "{\"schemaVersion\":1,\"identifier\":\"dev.test.app\",\"channel\":\"stable\",\"version\":\"2\",\"hash\":\"next\",\"platform\":\"linux\",\"arch\":\"x64\",\"artifact\":{\"file\":\"stable-linux-x64-Test.tar.zst\",\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":12345}}";
    var server = try TestServer.init();
    defer server.deinit();
    server.steps = &.{.{ .path = "/releases/stable-linux-x64-update.json", .cache_buster = true, .body = manifest }};
    var resolved = try testResolve(&server, testLocal());
    defer resolved.deinit();
    try std.testing.expectEqualStrings(test_digest, resolved.manifest.?.artifact.tarSha256.?);
}

test "dev and external update authorities do no networking" {
    for (0..3) |index| {
        var local = testLocal();
        switch (index) {
            0 => local.channel = "dev",
            1 => local.updateAuthority = .external,
            else => local.updateAuthority = .none,
        }
        var resolved = try resolve(std.testing.allocator, std.testing.io, .{ .local = local, .base_url = "invalid URL that must never be accessed", .platform = .linux, .arch = .x64 });
        defer resolved.deinit();
        try std.testing.expectEqual(.disabled, resolved.status);
    }
}

test "manifest redirects retain the historical twenty-hop limit" {
    const a = std.testing.allocator;
    var server = try TestServer.init();
    defer server.deinit();
    const start = try server.url("/loop");
    defer a.free(start);
    var steps: [21]TestServer.Step = @splat(.{ .path = "/loop", .status = 302, .location = "/loop", .installation_id = test_id });
    steps[20] = .{ .path = "/loop", .body = "{}", .installation_id = test_id };
    server.steps = &steps;
    const response = try testFetch(&server, start, .{ .timeout_ms = 3000, .installation_id = test_id });
    defer a.free(response.body);
    try std.testing.expectEqualStrings("{}", response.body);
    steps[20] = .{ .path = "/loop", .status = 302, .location = "/loop", .installation_id = test_id };
    try std.testing.expectError(error.TooManyUpdateRedirects, testFetch(&server, start, .{ .timeout_ms = 3000, .installation_id = test_id }));
}

test "cross-origin redirects strip identity on the wire and returning cannot restore it" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var first = try TestServer.init();
    defer first.deinit();
    var second = try TestServer.init();
    defer second.deinit();
    const start = try first.url("/start");
    defer a.free(start);
    const cross = try second.url("/cross");
    defer a.free(cross);
    const returned = try first.url("/return");
    defer a.free(returned);
    first.steps = &.{ .{ .path = "/start", .status = 302, .location = cross, .installation_id = test_id }, .{ .path = "/return", .body = "{}" } };
    second.steps = &.{.{ .path = "/cross", .status = 307, .location = returned }};
    var serving = try io.concurrent(TestServer.serve, .{&second});
    defer serving.cancel(io) catch {};
    const response = try testFetch(&first, start, .{ .timeout_ms = 3000, .installation_id = test_id });
    defer a.free(response.body);
    try serving.await(io);
}

test "body bounds apply with and without content length and error bodies are skipped" {
    const a = std.testing.allocator;
    for ([_]bool{ true, false }) |content_length| {
        var server = try TestServer.init();
        defer server.deinit();
        const url = try server.url("/document");
        defer a.free(url);
        server.steps = &.{.{ .path = "/document", .body = "0123456789", .content_length = content_length }};
        try std.testing.expectError(error.UpdateDocumentTooLarge, testFetch(&server, url, .{ .max_bytes = 9, .timeout_ms = 3000 }));
    }
    var server = try TestServer.init();
    defer server.deinit();
    const url = try server.url("/missing");
    defer a.free(url);
    server.steps = &.{.{ .path = "/missing", .body = "0123456789", .status = 404 }};
    const response = try testFetch(&server, url, .{ .max_bytes = 1, .timeout_ms = 3000 });
    defer a.free(response.body);
    try std.testing.expectEqual(@as(u16, 404), response.status);
    try std.testing.expectEqual(@as(usize, 0), response.body.len);
}

test "document deadline cancels and joins a pending response" {
    const a = std.testing.allocator;
    var server = try TestServer.init();
    defer server.deinit();
    const start = try server.url("/start");
    defer a.free(start);
    server.steps = &.{.{ .path = "/start", .delay_ms = 1000, .body = "{}" }};
    try std.testing.expectError(error.UpdateDocumentTimeout, testFetch(&server, start, .{ .timeout_ms = 50 }));
}

test "explicit null integrity is invalid rather than treated as an absent sidecar hint" {
    const a = std.testing.allocator;
    const manifest = "{\"schemaVersion\":1,\"identifier\":\"dev.test.app\",\"channel\":\"stable\",\"version\":\"2\",\"hash\":\"next\",\"platform\":\"linux\",\"arch\":\"x64\",\"artifact\":{\"file\":\"stable-linux-x64-Test.tar.zst\",\"tarSha256\":null,\"tarSize\":null}}";
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, parseManifest(a, manifest));
}

test "missing canonical metadata fails without searching alternate manifests" {
    var server = try TestServer.init();
    defer server.deinit();
    server.steps = &.{.{ .path = "/releases/stable-linux-x64-update.json", .cache_buster = true, .status = 404 }};
    try std.testing.expectError(error.UpdateHttpStatus, testResolve(&server, testLocal()));
}

test "caller cancellation joins pending HTTP before the updater can unload" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    var server = try TestServer.init();
    defer server.deinit();
    const url = try server.url("/pending");
    defer a.free(url);
    server.steps = &.{.{ .path = "/pending", .delay_ms = 30_000, .body = "{}" }};
    var serving = try io.concurrent(TestServer.serve, .{&server});
    defer serving.cancel(io) catch {};
    var request = try io.concurrent(fetchDocument, .{ a, io, url, FetchOptions{ .timeout_ms = 30_000 } });
    try server.requested.wait(io);
    try std.testing.expectError(error.Canceled, request.cancel(io));
}

test "numeric strings do not weaken the public metadata schema" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.InvalidUpdateArchiveIntegrity, parseChecksum(a, "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":\"12345\"}"));
    const manifest = "{\"schemaVersion\":\"1\",\"identifier\":\"dev.test.app\",\"channel\":\"stable\",\"version\":\"2\",\"hash\":\"next\",\"platform\":\"linux\",\"arch\":\"x64\",\"artifact\":{\"file\":\"stable-linux-x64-Test.tar.zst\"}}";
    try std.testing.expectError(error.InvalidUpdateManifest, parseManifest(a, manifest));
}

test "platform and architecture JSON cannot use enum ordinals" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "1", "\"1\"" }) |platform| {
        const bytes = try std.fmt.allocPrint(a, "{{\"schemaVersion\":1,\"platform\":{s},\"arch\":\"x64\",\"artifact\":{{}}}}", .{platform});
        defer a.free(bytes);
        try std.testing.expectError(error.InvalidUpdateManifest, parseManifest(a, bytes));
    }
}

test "stable and canary route manifests and checksums through self-hosted managed and custom folders" {
    const a = std.testing.allocator;
    const io = std.testing.io;
    const Hosting = enum { self_hosted, managed_api_origin, managed_versioned_api, managed_custom_origin };
    const Target = struct { platform: protocol.Platform, arch: protocol.Arch };
    for ([_][]const u8{ "stable", "canary" }) |channel| {
        for ([_]Hosting{ .self_hosted, .managed_api_origin, .managed_versioned_api, .managed_custom_origin }) |hosting| {
            for ([_]Target{ .{ .platform = .linux, .arch = .x64 }, .{ .platform = .macos, .arch = .arm64 }, .{ .platform = .win, .arch = .x64 } }) |target| {
                var arena: std.heap.ArenaAllocator = .init(a);
                defer arena.deinit();
                const owned = arena.allocator();
                var server = try TestServer.init();
                defer server.deinit();
                const origin = try server.url("");
                defer a.free(origin);
                var local = testLocal();
                local.channel = channel;
                local.baseUrl = try std.fmt.allocPrint(owned, "{s}/releases", .{origin});
                local.managed = switch (hosting) {
                    .self_hosted => null,
                    .managed_api_origin => .{ .appId = "Test App+One", .apiUrl = origin },
                    .managed_versioned_api => .{ .appId = "Test App+One", .apiUrl = try std.fmt.allocPrint(owned, "{s}/v1/electrobun///", .{origin}) },
                    .managed_custom_origin => .{ .appId = "Test App+One", .apiUrl = "https://unused.example.test", .baseUrl = try std.fmt.allocPrint(owned, "{s}/", .{origin}) },
                };
                const base = if (local.managed) |managed| try protocol.managedUpdateBaseUrl(owned, managed) else local.baseUrl;
                const expected_root = switch (hosting) {
                    .self_hosted => "/releases",
                    .managed_api_origin, .managed_versioned_api => "/v1/electrobun/apps/Test%20App%2BOne/updates",
                    .managed_custom_origin => "",
                };
                const prefix = try std.fmt.allocPrint(owned, "{s}-{s}-{s}", .{ channel, @tagName(target.platform), @tagName(target.arch) });
                const manifest_path = try std.fmt.allocPrint(owned, "{s}/{s}-update.json", .{ expected_root, prefix });
                const checksum_path = try std.fmt.allocPrint(owned, "{s}/{s}-next-checksum.json", .{ expected_root, prefix });
                const manifest = try std.json.Stringify.valueAlloc(owned, protocol.Manifest{
                    .schemaVersion = 1,
                    .identifier = local.identifier,
                    .channel = channel,
                    .version = "2",
                    .hash = "next",
                    .platform = target.platform,
                    .arch = target.arch,
                    .artifact = .{ .file = try std.fmt.allocPrint(owned, "{s}-Test.tar.zst", .{prefix}) },
                }, .{ .emit_null_optional_fields = false });
                const expected_id: ?[]const u8 = if (hosting == .self_hosted) null else test_id;
                server.steps = &.{
                    .{ .path = manifest_path, .cache_buster = true, .body = manifest, .installation_id = expected_id },
                    .{ .path = checksum_path, .cache_buster = true, .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":12345}", .installation_id = expected_id },
                };
                var serving = try io.concurrent(TestServer.serve, .{&server});
                defer serving.cancel(io) catch {};
                // Even an accidentally supplied ID must never reach a self-hosted folder.
                var resolved = try resolve(a, io, .{ .local = local, .base_url = base, .platform = target.platform, .arch = target.arch, .installation_id = test_id, .timeout_ms = 3000 });
                defer resolved.deinit();
                try serving.await(io);
                try std.testing.expectEqual(.available, resolved.status);
                try std.testing.expectEqualStrings(base, resolved.download_base_url);
                try std.testing.expectEqualStrings(channel, resolved.manifest.?.channel);
                try std.testing.expectEqual(target.platform, resolved.manifest.?.platform);
                try std.testing.expectEqual(target.arch, resolved.manifest.?.arch);
                try std.testing.expectEqualStrings(test_digest, resolved.manifest.?.artifact.tarSha256.?);
            }
        }
    }
}

test "invalid managed installation identities fail before any network connection" {
    const NoNetwork = struct {
        var attempts: std.atomic.Value(usize) = .init(0);
        fn connect(_: ?*anyopaque, _: *const Io.net.IpAddress, _: Io.net.IpAddress.ConnectOptions) Io.net.IpAddress.ConnectError!Io.net.Socket {
            _ = attempts.fetchAdd(1, .monotonic);
            return error.ConnectionRefused;
        }
    };
    NoNetwork.attempts.store(0, .monotonic);
    var vtable = std.testing.io.vtable.*;
    vtable.netConnectIp = NoNetwork.connect;
    const io: Io = .{ .userdata = std.testing.io.userdata, .vtable = &vtable };
    var local = testLocal();
    local.managed = .{ .appId = "test-app" };
    const base = "http://127.0.0.1:9";
    try std.testing.expectError(error.MissingManagedInstallationId, resolve(std.testing.allocator, io, .{ .local = local, .base_url = base, .platform = .linux, .arch = .x64 }));
    for ([_][]const u8{
        "",                                 "abcdef",                           "abcdef0123456789abcdef012345678",      "abcdef0123456789abcdef01234567890",
        "ABCDEF0123456789abcdef0123456789", "abcdef0123456789abcdef012345678x", "abcdef0123456789abcdef0123456789\r\n",
    }) |identity| {
        try std.testing.expectError(error.InvalidInstallationId, resolve(std.testing.allocator, io, .{ .local = local, .base_url = base, .platform = .linux, .arch = .x64, .installation_id = identity }));
        try std.testing.expectError(error.InvalidInstallationId, fetchDocument(std.testing.allocator, io, base ++ "/manifest", .{ .installation_id = identity }));
    }
    try std.testing.expectEqual(@as(usize, 0), NoNetwork.attempts.load(.monotonic));
}

test "checksum rejection matrix covers missing partial type range digest and malformed JSON" {
    const Case = struct { body: []const u8, expected: anyerror };
    const cases = [_]Case{
        .{ .body = "{}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\"}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSize\":12345}", .expected = error.MissingField },
        .{ .body = "{\"tarSha256\":12345,\"tarSize\":12345}", .expected = error.UnexpectedToken },
        .{ .body = "{\"tarSha256\":null,\"tarSize\":12345}", .expected = error.UnexpectedToken },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":\"12345\"}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":true}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":null}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":-1}", .expected = error.Overflow },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":0}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":1.5}", .expected = error.InvalidNumber },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":9007199254740992}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "\",\"tarSize\":184467440737095516160}", .expected = error.Overflow },
        .{ .body = "{\"tarSha256\":\"0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef\",\"tarSize\":12345}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"0123456789abcdef\",\"tarSize\":12345}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"" ++ test_digest ++ "0\",\"tarSize\":12345}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg\",\"tarSize\":12345}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{\"tarSha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\\n\",\"tarSize\":12345}", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "[]", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "null", .expected = error.InvalidUpdateArchiveIntegrity },
        .{ .body = "{", .expected = error.UnexpectedEndOfInput },
        .{ .body = "not-json", .expected = error.SyntaxError },
    };
    const a = std.testing.allocator;
    const io = std.testing.io;
    for (cases) |case| {
        var server = try TestServer.init();
        defer server.deinit();
        server.steps = &.{
            .{ .path = "/releases/stable-linux-x64-update.json", .cache_buster = true, .body = test_manifest },
            .{ .path = "/releases/stable-linux-x64-next-checksum.json", .cache_buster = true, .body = case.body },
        };
        const base = try server.url("/releases");
        defer a.free(base);
        var serving = try io.concurrent(TestServer.serve, .{&server});
        defer serving.cancel(io) catch {};
        const result = resolve(a, io, .{ .local = testLocal(), .base_url = base, .platform = .linux, .arch = .x64, .timeout_ms = 3000 });
        defer if (result) |value| {
            var unexpected = value;
            unexpected.deinit();
        } else |_| {};
        // Await the complete fixture, so a request/path/header mismatch cannot
        // masquerade as the expected metadata rejection.
        try serving.await(io);
        try std.testing.expectError(case.expected, result);
    }
}
