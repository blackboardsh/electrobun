const std = @import("std");
const rpcSchema = @import("schema.zig");
const rpcStdout = @import("../stdout.zig");

const alloc = std.heap.page_allocator;

pub fn decideNavigation(args: rpcSchema.ZigSchema.requests.decideNavigation.args) rpcSchema.ZigSchema.requests.decideNavigation.returns {
    const rawPayload = rpcStdout.sendRequest("decideNavigation", args);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.decideNavigation.returns, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub const request = rpcSchema.Requests{
    .decideNavigation = decideNavigation,
};
