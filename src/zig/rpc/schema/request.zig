const std = @import("std");
const rpcSchema = @import("schema.zig");
const rpcStdout = @import("../stdout.zig");

const alloc = std.heap.page_allocator;

pub fn decideNavigation(params: rpcSchema.ZigSchema.requests.decideNavigation.params) rpcSchema.ZigSchema.requests.decideNavigation.response {
    const rawPayload = rpcStdout.sendRequest("decideNavigation", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.decideNavigation.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn log(params: rpcSchema.ZigSchema.requests.log.params) rpcSchema.ZigSchema.requests.log.response {
    const rawPayload = rpcStdout.sendRequest("log", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.log.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn sendSyncRequest(params: rpcSchema.ZigSchema.requests.sendSyncRequest.params) rpcSchema.ZigSchema.requests.sendSyncRequest.response {
    const rawPayload = rpcStdout.sendRequest("syncRequest", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.sendSyncRequest.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn trayEvent(params: rpcSchema.ZigSchema.requests.trayEvent.params) rpcSchema.ZigSchema.requests.trayEvent.response {
    const rawPayload = rpcStdout.sendRequest("trayEvent", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.trayEvent.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub const request = rpcSchema.Requests{ .decideNavigation = decideNavigation, .log = log, .sendSyncRequest = sendSyncRequest, .trayEvent = trayEvent };
