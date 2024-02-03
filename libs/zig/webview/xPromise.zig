const std = @import("std");

const alloc = std.heap.page_allocator;

// message types
pub const decideNavigation = struct {
    const responseType = struct {
        allow: bool,
    };

    pub fn request(url: []const u8) void {
        const payload = .{
            .url = url,
        };
        sendRequestToBun(xPromiseMessageType.decideNavigation, payload);
    }

    pub fn response(rawPayload: std.json.Value) responseType {
        // const payload = std.json.parse(xPromiseMessage, rawPayload);
        const parsedPayload = std.json.parseFromValue(responseType, alloc, rawPayload, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin xPromise response - {}: \n", .{err});
            return responseType{ .allow = true };
        };
        defer parsedPayload.deinit();

        return parsedPayload.value;
    }
};

// private methods
var promiseIdGen = PromiseIdGenerator{};
const PromiseIdGenerator = struct {
    next_id: u32 = 0,
    const NextIdMax: u32 = 100;

    pub fn nextId(self: *PromiseIdGenerator) u32 {
        self.next_id = (self.next_id + 1) % (NextIdMax);
        return self.next_id;
    }
};

fn sendRequestToBun(messageType: xPromiseMessageType, payload: anytype) void {
    sendMessageToBun(messageType, xPromiseMessagePhase.request, payload);
}

fn sendResponseToBun(messageType: xPromiseMessageType, payload: anytype) void {
    sendMessageToBun(messageType, xPromiseMessagePhase.response, payload);
}

fn sendMessageToBun(messageType: xPromiseMessageType, phaseType: xPromiseMessagePhase, payload: anytype) void {
    const stdoutWriter = std.io.getStdOut().writer();
    // if phaseType === request then add promiseId to the payload, sleep thread, and track it
    std.log.info("Sending message to bun: {} - {}\n", .{ messageType, phaseType });
    std.json.stringify(.{
        .id = promiseIdGen.nextId(),
        .type = messageType,
        .phase = phaseType,
        .payload = payload,
    }, .{}, stdoutWriter) catch |err| {
        std.debug.print("Failed to stringify message: {}\n", .{err});
        return;
    };

    // add a newline
    _ = stdoutWriter.writeAll("\n") catch {
        // Handle potential errors here
        std.debug.print("Failed to write to stdout\n", .{});
    };
}

pub const xPromiseMessage = struct {
    id: u32,
    type: xPromiseMessageType,
    phase: xPromiseMessagePhase,
    payload: std.json.Value,
};

// // explicit phase, always use payload
pub const xPromiseMessagePhase = enum {
    request,
    response,
    // message = 2,
    // error = 3,
};

pub const xPromiseMessageType = enum {
    setTitle,
    createWindow,
    decideNavigation,
};
