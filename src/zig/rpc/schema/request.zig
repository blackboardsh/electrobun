const std = @import("std");
const rpcSchema = @import("schema.zig");
const rpcStdout = @import("../stdout.zig");

const alloc = std.heap.page_allocator;

pub fn decideNavigation(params: rpcSchema.ZigSchema.requests.decideNavigation.params) rpcSchema.ZigSchema.requests.decideNavigation.returns {
    const rawPayload = rpcStdout.sendRequest("decideNavigation", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.decideNavigation.returns, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub const request = rpcSchema.Requests{
    .decideNavigation = decideNavigation,
};
