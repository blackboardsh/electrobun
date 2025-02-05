const std = @import("std");
const rpcTypes = @import("types.zig");
const rpcSchema = @import("schema/schema.zig");


// todo: refactor when zig supports async/await
pub fn sendRequest(method: []const u8, params: anytype) void {
    const id = idGen.nextId();
    send(.{
        .id = id,
        .type = "request",
        .method = method,
        .params = params,
    });
}

pub fn sendResponseSuccess(id: u32, payload: ?rpcSchema.RequestResponseType) void {
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
        // todo: the message id might need to be the eventName (different api to requests)
        // revisit when refactoring event system
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
