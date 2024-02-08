const std = @import("std");
const rpcTypes = @import("rpcTypes.zig");
const rpcSchema = @import("rpcSchema.zig");

const alloc = std.heap.page_allocator;

pub fn decideNavigation(args: rpcSchema.ZigSchema.requests.decideNavigation.args) rpcSchema.ZigSchema.requests.decideNavigation.returns {
    const rawPayload = sendRequest("decideNavigation", args);

    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.decideNavigation.returns, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub const senders = rpcSchema.Senders{
    .decideNavigation = decideNavigation,
};

var _waitingForResponse = false;
var _response: ?std.json.Value = null;
var m = std.Thread.Mutex{};
var c = std.Thread.Condition{};

pub fn sendRequest(method: []const u8, args: anytype) ?std.json.Value {
    send(.{
        .id = idGen.nextId(),
        .type = "request",
        .method = method,
        .params = args,
    });

    m.lock();
    defer m.unlock();
    _waitingForResponse = true;
    _response = null;

    while (_waitingForResponse) {
        c.wait(&m);
    }

    return _response;
}

pub fn setResponse(id: u32, response: anytype) void {
    // todo: consider using a hashmap instead of a single variable
    // note: technically since main thread gets blocked and all
    // requests currently originate from the main thread, we don't need
    // this yet
    _ = id;

    m.lock();
    defer m.unlock();
    _response = response;
    _waitingForResponse = false;
    c.signal();
}

pub fn sendResponseSuccess(id: u32, payload: ?rpcSchema.PayloadType) void {
    send(.{
        .id = id,
        .type = "response",
        .success = true,
        .payload = payload,
    });
}

pub fn sendResponseError(id: u32, errorMsg: []const u8) void {
    send(.{
        .id = id,
        .type = "response",
        .success = false,
        .@"error" = errorMsg,
    });
}

pub fn sendMessage(payload: anytype) void {
    send(.{
        .id = idGen.nextId(),
        .type = "message",
        .payload = payload,
    });
}

pub fn send(message: anytype) void {
    // stringify message and send to stdout. note: message already has id and everything
    // added
    const stdoutWriter = std.io.getStdOut().writer();

    std.json.stringify(message, .{}, stdoutWriter) catch |err| {
        std.debug.print("Failed to stringify message: {}\n", .{err});
        return;
    };

    // add a newline
    _ = stdoutWriter.writeAll("\n") catch {
        std.debug.print("Failed to write to stdout\n", .{});
    };
}

var idGen = idGenerator{};
const idGenerator = struct {
    next_id: u32 = 0,
    const NextIdMax: u32 = 100;

    pub fn nextId(self: *idGenerator) u32 {
        self.next_id = (self.next_id + 1) % (NextIdMax);
        return self.next_id;
    }
};
