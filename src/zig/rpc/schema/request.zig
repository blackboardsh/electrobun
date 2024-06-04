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

pub fn applicationMenuEvent(params: rpcSchema.ZigSchema.requests.applicationMenuEvent.params) rpcSchema.ZigSchema.requests.applicationMenuEvent.response {
    const rawPayload = rpcStdout.sendRequest("applicationMenuEvent", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.applicationMenuEvent.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn contextMenuEvent(params: rpcSchema.ZigSchema.requests.contextMenuEvent.params) rpcSchema.ZigSchema.requests.contextMenuEvent.response {
    const rawPayload = rpcStdout.sendRequest("contextMenuEvent", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.contextMenuEvent.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn webviewEvent(params: rpcSchema.ZigSchema.requests.webviewEvent.params) rpcSchema.ZigSchema.requests.webviewEvent.response {
    const rawPayload = rpcStdout.sendRequest("webviewEvent", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.webviewEvent.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn windowClose(params: rpcSchema.ZigSchema.requests.windowClose.params) rpcSchema.ZigSchema.requests.windowClose.response {
    const rawPayload = rpcStdout.sendRequest("windowClose", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.windowClose.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn windowMove(params: rpcSchema.ZigSchema.requests.windowMove.params) rpcSchema.ZigSchema.requests.windowMove.response {
    const rawPayload = rpcStdout.sendRequest("windowMove", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.windowMove.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub fn windowResize(params: rpcSchema.ZigSchema.requests.windowResize.params) rpcSchema.ZigSchema.requests.windowResize.response {
    const rawPayload = rpcStdout.sendRequest("windowResize", params);
    const parsedPayload = std.json.parseFromValue(rpcSchema.ZigSchema.requests.windowResize.response, alloc, rawPayload.?, .{}) catch {
        unreachable;
    };
    return parsedPayload.value;
}

pub const request = rpcSchema.Requests{ //
    .decideNavigation = decideNavigation,
    .log = log,
    .sendSyncRequest = sendSyncRequest,
    .trayEvent = trayEvent,
    .applicationMenuEvent = applicationMenuEvent,
    .contextMenuEvent = contextMenuEvent,
    .webviewEvent = webviewEvent,
    .windowClose = windowClose,
    .windowMove = windowMove,
    .windowResize = windowResize,
};
