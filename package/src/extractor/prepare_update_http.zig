//! Verified-TLS, bounded, deadline-limited update bodies. A consumer sees the
//! live response stream, so full archives need no compressed temporary file.
const std = @import("std");
const Io = std.Io;
const A = std.mem.Allocator;
const max_redirects = 5;
pub const Consumer = *const fn (context: *anyopaque, reader: *Io.Reader) anyerror!void;
pub const Options = struct {
    max_bytes: u64 = 16 * 1024 * 1024 * 1024,
    timeout_ms: u32 = 600_000,
};

pub fn checkedUri(url: []const u8) !std.Uri {
    if (url.len == 0 or url.len > 8192) return error.InvalidUpdateUrl;
    for (url) |byte| if (byte < 0x21 or byte == 0x7f or byte == '\\') return error.InvalidUpdateUrl;
    var uri = std.Uri.parse(url) catch return error.InvalidUpdateUrl;
    if (uri.user != null or uri.password != null or uri.fragment != null or uri.port == 0) return error.InvalidUpdateUrl;
    const host = switch (uri.host orelse return error.InvalidUpdateUrl) {
        .raw, .percent_encoded => |value| value,
    };
    if (host.len == 0 or std.mem.indexOfScalar(u8, host, '%') != null) return error.InvalidUpdateUrl;
    if (!std.mem.eql(u8, uri.scheme, "https")) {
        if (!std.mem.eql(u8, uri.scheme, "http")) return error.InsecureUpdateUrl;
        if (std.ascii.eqlIgnoreCase(host, "localhost")) uri.host = .{ .raw = "127.0.0.1" } else {
            const address = Io.net.IpAddress.parseLiteral(host) catch return error.InsecureUpdateUrl;
            if (!switch (address) {
                .ip4 => |ip| ip.bytes[0] == 127,
                .ip6 => |ip| ip.isLoopBack(),
            }) return error.InsecureUpdateUrl;
        }
    }
    return uri;
}

pub fn fetch(allocator: A, io: Io, url: []const u8, context: *anyopaque, consume: Consumer, options: Options) !void {
    _ = try checkedUri(url);
    const Transfer = struct {
        result: anyerror!void,
        finished_at: Io.Clock.Timestamp,

        fn run(a: A, transfer_io: Io, transfer_url: []const u8, transfer_context: *anyopaque, consumer: Consumer, transfer_options: Options) @This() {
            const result = exchange(a, transfer_io, transfer_url, transfer_context, consumer, transfer_options);
            return .{ .result = result, .finished_at = .now(transfer_io, .awake) };
        }
    };
    const Outcome = union(enum) { transfer: Transfer, timer: Io.Cancelable!void };
    var buffer: [2]Outcome = undefined;
    var select = Io.Select(Outcome).init(io, &buffer);
    defer select.cancelDiscard();
    const deadline = (Io.Timeout{ .duration = .{ .raw = .fromMilliseconds(options.timeout_ms), .clock = .awake } }).toDeadline(io);
    try select.concurrent(.transfer, Transfer.run, .{ allocator, io, url, context, consume, options });
    try select.concurrent(.timer, Io.Timeout.sleep, .{ deadline, io });
    return switch (try select.await()) {
        // The timer task may be scheduled late on a busy machine. Completion
        // order alone must not accept a transfer that exceeded the deadline.
        .transfer => |transfer| if (transfer.finished_at.compare(.gte, deadline.deadline)) error.UpdateDownloadTimeout else transfer.result,
        .timer => error.UpdateDownloadTimeout,
    };
}

fn exchange(allocator: A, io: Io, url: []const u8, context: *anyopaque, consume: Consumer, options: Options) !void {
    var client: std.http.Client = .{ .allocator = allocator, .io = io };
    defer client.deinit();
    var redirects: std.heap.ArenaAllocator = .init(allocator);
    defer redirects.deinit();
    var current_url = url;
    var followed: usize = 0;
    while (true) {
        try io.checkCancel();
        var request = try client.request(.GET, try checkedUri(current_url), .{
            // Inspect every destination before connecting. Automatic redirects
            // cannot enforce our HTTPS and loopback-origin restrictions.
            .redirect_behavior = .unhandled,
            .keep_alive = false,
            .headers = .{ .accept_encoding = .{ .override = "identity" } },
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
                current_url = try redirectUrl(redirects.allocator(), current_url, location);
                followed += 1;
                // Closing the old connection avoids downloading an arbitrary
                // redirect body. Only the final response reaches the consumer.
                continue;
            },
            else => {},
        }
        if (response.head.status == .not_found) return error.UpdateArtifactNotFound;
        if (response.head.status != .ok) return error.UpdateHttpStatus;
        if (response.head.content_length) |length| if (length > options.max_bytes) return error.UpdateDownloadTooLarge;
        var transfer: [64 * 1024]u8 = undefined;
        var reader: CountedReader = undefined;
        reader.init(response.reader(&transfer), options.max_bytes);
        consume(context, &reader.interface) catch |err| return reader.err orelse err;
        _ = reader.interface.discardRemaining() catch |err| return reader.err orelse err;
        if (reader.received == 0) return error.EmptyUpdateDownload;
        if (response.head.content_length) |length| if (length != reader.received) return error.TruncatedUpdateDownload;
        return;
    }
}

fn uriHost(uri: std.Uri) []const u8 {
    return switch (uri.host.?) {
        .raw, .percent_encoded => |value| value,
    };
}

fn redirectUrl(allocator: A, previous: []const u8, location: []const u8) ![]u8 {
    if (location.len == 0 or location.len > 8192) return error.InvalidUpdateRedirect;
    for (location) |byte| if (byte < 0x21 or byte == 0x7f or byte == '\\') return error.InvalidUpdateRedirect;
    const base = try checkedUri(previous);
    var storage: [3 * 8192]u8 = undefined;
    @memcpy(storage[0..location.len], location);
    var auxiliary: []u8 = &storage;
    const resolved = base.resolveInPlace(location.len, &auxiliary) catch return error.InvalidUpdateRedirect;
    const url = try std.fmt.allocPrint(allocator, "{f}", .{resolved});
    errdefer allocator.free(url);
    const destination = try checkedUri(url);
    if (std.mem.eql(u8, base.scheme, "https") and !std.mem.eql(u8, destination.scheme, "https"))
        return error.UpdateRedirectDowngrade;
    // Plain HTTP is solely a local-development transport. It cannot redirect
    // to another local service, even though that service is also loopback.
    if (std.mem.eql(u8, destination.scheme, "http") and
        (!std.ascii.eqlIgnoreCase(uriHost(base), uriHost(destination)) or (base.port orelse 80) != (destination.port orelse 80)))
        return error.UnsafeUpdateRedirect;
    return url;
}

const CountedReader = struct {
    source: *Io.Reader,
    interface: Io.Reader,
    buffer: [64 * 1024]u8,
    max_bytes: u64,
    received: u64 = 0,
    err: ?anyerror = null,

    fn init(self: *CountedReader, source: *Io.Reader, max_bytes: u64) void {
        self.source = source;
        self.max_bytes = max_bytes;
        self.received = 0;
        self.err = null;
        self.interface = .{ .vtable = &.{ .stream = stream, .readVec = readVec }, .buffer = &self.buffer, .seek = 0, .end = 0 };
    }
    fn stream(reader: *Io.Reader, _: *Io.Writer, _: Io.Limit) Io.Reader.StreamError!usize {
        return fill(reader);
    }
    fn readVec(reader: *Io.Reader, _: [][]u8) Io.Reader.Error!usize {
        return fill(reader);
    }
    fn fill(reader: *Io.Reader) Io.Reader.Error!usize {
        const self: *CountedReader = @fieldParentPtr("interface", reader);
        // readVec may be called by peek/fill while a suffix is still unread.
        // Preserve it before appending: Zstd table parsing routinely needs a
        // contiguous view spanning transport reads.
        const unread = reader.end - reader.seek;
        std.debug.assert(unread < reader.buffer.len);
        @memmove(reader.buffer[0..unread], reader.buffer[reader.seek..reader.end]);
        reader.seek = 0;
        reader.end = unread;
        const count = self.source.readSliceShort(reader.buffer[unread..]) catch |err| {
            self.err = err;
            return error.ReadFailed;
        };
        if (count == 0) return error.EndOfStream;
        if (count > self.max_bytes - self.received) {
            self.err = error.UpdateDownloadTooLarge;
            return error.ReadFailed;
        }
        self.received += count;
        reader.end += count;
        return 0;
    }
};

pub fn download(allocator: A, io: Io, url: []const u8, file: Io.File, options: Options) !void {
    const Context = struct {
        io: Io,
        file: Io.File,
        fn consume(context: *anyopaque, reader: *Io.Reader) !void {
            const self: *@This() = @ptrCast(@alignCast(context));
            var buffer: [64 * 1024]u8 = undefined;
            while (true) {
                const count = try reader.readSliceShort(&buffer);
                if (count == 0) break;
                try self.file.writeStreamingAll(self.io, buffer[0..count]);
            }
            try self.file.sync(self.io);
        }
    };
    var context: Context = .{ .io = io, .file = file };
    try fetch(allocator, io, url, &context, Context.consume, options);
}

test "native prepare only permits HTTPS and literal loopback HTTP" {
    _ = try checkedUri("https://artifacts.electrobun.dev/app.tar.zst");
    _ = try checkedUri("http://127.0.0.1:4317/app.tar.zst");
    _ = try checkedUri("http://[::1]/app.tar.zst");
    const local = try checkedUri("http://LOCALHOST/app.tar.zst");
    try std.testing.expectEqualStrings("127.0.0.1", local.host.?.raw);
    for ([_][]const u8{ "http://example.com/a", "http://127.0.0.1.evil.test/a", "http://192.168.0.1/a", "ftp://example.com/a" }) |url|
        try std.testing.expectError(error.InsecureUpdateUrl, checkedUri(url));
    for ([_][]const u8{ "https://user:pass@example.com/a", "https://example.com/a#fragment", "https://exa%6dple.com/a", "https://example.com:0/a" }) |url|
        try std.testing.expectError(error.InvalidUpdateUrl, checkedUri(url));
}

test "streaming HTTP reader enforces size limits without buffering body" {
    var source: Io.Reader = .fixed("abcdef");
    var reader: CountedReader = undefined;
    reader.init(&source, 5);
    var output: [8]u8 = undefined;
    try std.testing.expectError(error.ReadFailed, reader.interface.readSliceShort(&output));
    try std.testing.expectEqual(error.UpdateDownloadTooLarge, reader.err.?);
    try std.testing.expectEqual(@as(u64, 0), reader.received);
}

test "streaming HTTP reader preserves unread bytes when a peek crosses a buffer boundary" {
    const allocator = std.testing.allocator;
    const bytes = try allocator.alloc(u8, 64 * 1024 + 32);
    defer allocator.free(bytes);
    for (bytes, 0..) |*byte, index| byte.* = @truncate(index *% 37);
    var source: Io.Reader = .fixed(bytes);
    var reader: CountedReader = undefined;
    reader.init(&source, bytes.len);
    const prefix = bytes.len - 39;
    try std.testing.expectEqualSlices(u8, bytes[0..prefix], try reader.interface.take(prefix));
    // Zstd table parsing peeks beyond the remaining compressed bytes, then
    // consumes only part of that view. Both operations must retain the suffix.
    try std.testing.expectEqualSlices(u8, bytes[prefix..][0..16], try reader.interface.peek(16));
    try std.testing.expectEqualSlices(u8, bytes[prefix..][0..9], try reader.interface.take(9));
    try std.testing.expectEqualSlices(u8, bytes[prefix + 9 ..], try reader.interface.take(bytes.len - prefix - 9));
    try std.testing.expectError(error.EndOfStream, reader.interface.takeByte());
    try std.testing.expectEqual(@as(u64, bytes.len), reader.received);
}

test "redirect destinations resolve relative references and preserve HTTPS" {
    const allocator = std.testing.allocator;
    const relative = try redirectUrl(allocator, "https://example.test/releases/start", "../assets/archive.tar.zst?token=a%2Fb");
    defer allocator.free(relative);
    try std.testing.expectEqualStrings("https://example.test/assets/archive.tar.zst?token=a%2Fb", relative);
    const cdn = try redirectUrl(allocator, "https://example.test/releases/start", "//cdn.example.test/download?signature=abc");
    defer allocator.free(cdn);
    try std.testing.expectEqualStrings("https://cdn.example.test/download?signature=abc", cdn);
    try std.testing.expectError(error.UpdateRedirectDowngrade, redirectUrl(allocator, "https://example.test/a", "http://127.0.0.1/a"));
    try std.testing.expectError(error.UnsafeUpdateRedirect, redirectUrl(allocator, "http://127.0.0.1:4000/a", "http://127.0.0.1:4001/a"));
    try std.testing.expectError(error.InsecureUpdateUrl, redirectUrl(allocator, "http://127.0.0.1/a", "http://example.test/a"));
    try std.testing.expectError(error.InvalidUpdateUrl, redirectUrl(allocator, "https://example.test/a", "https://user:secret@cdn.example.test/a"));
    try std.testing.expectError(error.InvalidUpdateRedirect, redirectUrl(allocator, "https://example.test/a", "/bad\r\nInjected:header"));
}

const TestServer = struct {
    listener: Io.net.Server,
    steps: []const Step = &.{},
    const Step = struct {
        path: []const u8,
        status: u16 = 200,
        location: ?[]const u8 = null,
        body: []const u8 = "",
        delay_ms: u32 = 0,
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
            try std.testing.expectEqualStrings(step.path, parts.next().?);
            while (!std.mem.eql(u8, try reader.interface.takeDelimiterInclusive('\n'), "\r\n")) {}
            if (step.delay_ms != 0) try Io.sleep(io, .fromMilliseconds(step.delay_ms), .awake);
            var write_buffer: [4096]u8 = undefined;
            var writer = connection.writer(io, &write_buffer);
            try writer.interface.print("HTTP/1.1 {d} Response\r\nContent-Length: {d}\r\nConnection: close\r\n", .{ step.status, step.body.len });
            if (step.location) |location| try writer.interface.print("Location: {s}\r\n", .{location});
            try writer.interface.writeAll("\r\n");
            try writer.interface.writeAll(step.body);
            try writer.interface.flush();
        }
    }
};

fn testDownload(server: *TestServer, url: []const u8, options: Options) ![]u8 {
    return testDownloadWithIo(server, url, options, std.testing.io);
}

fn testDownloadWithIo(server: *TestServer, url: []const u8, options: Options, io: Io) ![]u8 {
    const allocator = std.testing.allocator;
    var serving = try io.concurrent(TestServer.serve, .{server});
    defer serving.cancel(io) catch {};
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const file = try temporary.dir.createFile(io, "download", .{ .read = true });
    defer file.close(io);
    try download(allocator, io, url, file, options);
    try serving.await(io);
    return temporary.dir.readFileAlloc(io, "download", allocator, .limited(1024 * 1024));
}

test "HTTP download follows five relative and absolute redirects into one streamed body" {
    const allocator = std.testing.allocator;
    var server = try TestServer.init();
    defer server.deinit();
    const start = try server.url("/releases/start");
    defer allocator.free(start);
    const absolute = try server.url("/assets/two");
    defer allocator.free(absolute);
    server.steps = &.{
        .{ .path = "/releases/start", .status = 301, .location = "../assets/one?token=a" },
        .{ .path = "/assets/one?token=a", .status = 302, .location = absolute },
        .{ .path = "/assets/two", .status = 303, .location = "/assets/three" },
        .{ .path = "/assets/three", .status = 307, .location = "four" },
        .{ .path = "/assets/four", .status = 308, .location = "/final?signature=a%2Fb&expires=1" },
        .{ .path = "/final?signature=a%2Fb&expires=1", .body = "payload\x00\xff" },
    };
    const result = try testDownload(&server, start, .{ .timeout_ms = 3000 });
    defer allocator.free(result);
    try std.testing.expectEqualStrings("payload\x00\xff", result);
}

test "HTTP streaming decodes compressed Zstd blocks across buffer boundaries" {
    const io = std.testing.io;
    const allocator = std.testing.allocator;
    const frame = @embedFile("testdata/http-compressed-blocks.zst");
    // A valid skippable frame positions the compressed Huffman table across
    // the transport's 64 KiB boundary. Decoding raw blocks cannot expose this.
    const frame_offset = 64 * 1024 - 20;
    const compressed = try allocator.alloc(u8, frame_offset + frame.len);
    defer allocator.free(compressed);
    @memset(compressed[0..frame_offset], 0);
    std.mem.writeInt(u32, compressed[0..4], 0x184d2a50, .little);
    std.mem.writeInt(u32, compressed[4..8], frame_offset - 8, .little);
    @memcpy(compressed[frame_offset..], frame);
    var server = try TestServer.init();
    defer server.deinit();
    const url = try server.url("/archive.tar.zst");
    defer allocator.free(url);
    server.steps = &.{.{ .path = "/archive.tar.zst", .body = compressed }};
    var serving = try io.concurrent(TestServer.serve, .{&server});
    defer serving.cancel(io) catch {};
    const Context = struct {
        size: usize = 0,
        hash: [32]u8 = undefined,
        fn consume(pointer: *anyopaque, input: *Io.Reader) !void {
            const self: *@This() = @ptrCast(@alignCast(pointer));
            const zstd = std.compress.zstd;
            const window = try std.testing.allocator.alloc(u8, zstd.default_window_len + zstd.block_size_max);
            defer std.testing.allocator.free(window);
            var decoder: zstd.Decompress = .init(input, window, .{ .verify_checksum = false });
            var digest: std.crypto.hash.sha2.Sha256 = .init(.{});
            var bytes: [4096]u8 = undefined;
            while (true) {
                const count = decoder.reader.readSliceShort(&bytes) catch |err| return decoder.err orelse err;
                if (count == 0) break;
                self.size += count;
                digest.update(bytes[0..count]);
            }
            self.hash = digest.finalResult();
        }
    };
    var context: Context = .{};
    try fetch(allocator, io, url, &context, Context.consume, .{ .timeout_ms = 5000 });
    try serving.await(io);
    try std.testing.expectEqual(@as(usize, 8192), context.size);
    try std.testing.expectEqualStrings("07e0756ccdfdb405f9e883e589b1f338f6b53daff3f1783dfbbda63320374c52", &std.fmt.bytesToHex(context.hash, .lower));
}

test "HTTP redirect loops stop after five followed responses" {
    const allocator = std.testing.allocator;
    var server = try TestServer.init();
    defer server.deinit();
    const start = try server.url("/loop");
    defer allocator.free(start);
    const steps: [6]TestServer.Step = @splat(.{ .path = "/loop", .status = 302, .location = "/loop" });
    server.steps = &steps;
    try std.testing.expectError(error.TooManyUpdateRedirects, testDownload(&server, start, .{ .timeout_ms = 3000 }));
}

test "HTTP redirects cannot escape local HTTP policy or omit a destination" {
    const allocator = std.testing.allocator;
    for ([_]?[]const u8{ "http://example.test/artifact", null }) |location| {
        var server = try TestServer.init();
        defer server.deinit();
        const start = try server.url("/start");
        defer allocator.free(start);
        server.steps = &.{.{ .path = "/start", .status = 302, .location = location }};
        try std.testing.expectError(if (location != null) error.InsecureUpdateUrl else error.UpdateRedirectLocationMissing, testDownload(&server, start, .{ .timeout_ms = 3000 }));
    }
}

test "the download deadline covers the complete redirect chain" {
    const allocator = std.testing.allocator;
    var server = try TestServer.init();
    defer server.deinit();
    const start = try server.url("/start");
    defer allocator.free(start);
    server.steps = &.{
        .{ .path = "/start", .status = 302, .location = "/final", .delay_ms = 60 },
        .{ .path = "/final", .body = "late payload", .delay_ms = 60 },
    };
    const result = testDownload(&server, start, .{ .timeout_ms = 100 });
    defer if (result) |bytes| allocator.free(bytes) else |_| {};
    try std.testing.expectError(error.UpdateDownloadTimeout, result);
}

test "a delayed timer cannot accept a transfer completed past the deadline" {
    const allocator = std.testing.allocator;
    var server = try TestServer.init();
    defer server.deinit();
    const start = try server.url("/start");
    defer allocator.free(start);
    server.steps = &.{
        .{ .path = "/start", .status = 302, .location = "/final", .delay_ms = 60 },
        .{ .path = "/final", .body = "late payload", .delay_ms = 60 },
    };

    // Delay only the client's deadline task. The server still uses the real
    // test IO, so the transfer finishes first but beyond its original budget.
    // This reproduces a delayed timer on a busy VM without scheduling races.
    var delayed_timer_vtable = std.testing.io.vtable.*;
    delayed_timer_vtable.sleep = struct {
        fn sleep(userdata: ?*anyopaque, timeout: Io.Timeout) Io.Cancelable!void {
            const delayed: Io.Timeout = switch (timeout) {
                .deadline => |deadline| .{ .deadline = deadline.addDuration(.{
                    .raw = .fromMilliseconds(1000),
                    .clock = deadline.clock,
                }) },
                else => timeout,
            };
            return std.testing.io.vtable.sleep(userdata, delayed);
        }
    }.sleep;
    const io: Io = .{ .userdata = std.testing.io.userdata, .vtable = &delayed_timer_vtable };
    const result = testDownloadWithIo(&server, start, .{ .timeout_ms = 100 }, io);
    defer if (result) |bytes| allocator.free(bytes) else |_| {};
    try std.testing.expectError(error.UpdateDownloadTimeout, result);
}
