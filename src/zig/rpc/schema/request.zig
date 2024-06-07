const std = @import("std");
const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
const rpcStdout = @import("../stdout.zig");

const alloc = std.heap.page_allocator;

pub fn decideNavigation(params: rpcSchema.ZigSchema.requests.decideNavigation.params) rpcSchema.ZigSchema.requests.decideNavigation.response {
    return rpcStdout.sendRequest("decideNavigation", params, rpcSchema.ZigSchema.requests.decideNavigation.response);
}

pub fn log(params: rpcSchema.ZigSchema.requests.log.params) rpcSchema.ZigSchema.requests.log.response {
    return rpcStdout.sendRequest("log", params, rpcSchema.ZigSchema.requests.log.response);
}

pub fn sendSyncRequest(params: rpcSchema.ZigSchema.requests.sendSyncRequest.params) rpcSchema.ZigSchema.requests.sendSyncRequest.response {
    return rpcStdout.sendRequest("syncRequest", params, rpcSchema.ZigSchema.requests.sendSyncRequest.response);
}

pub fn trayEvent(params: rpcSchema.ZigSchema.requests.trayEvent.params) rpcSchema.ZigSchema.requests.trayEvent.response {
    return rpcStdout.sendRequest("trayEvent", params, rpcSchema.ZigSchema.requests.trayEvent.response);
}

pub fn applicationMenuEvent(params: rpcSchema.ZigSchema.requests.applicationMenuEvent.params) rpcSchema.ZigSchema.requests.applicationMenuEvent.response {
    return rpcStdout.sendRequest("applicationMenuEvent", params, rpcSchema.ZigSchema.requests.applicationMenuEvent.response);
}

pub fn contextMenuEvent(params: rpcSchema.ZigSchema.requests.contextMenuEvent.params) rpcSchema.ZigSchema.requests.contextMenuEvent.response {
    return rpcStdout.sendRequest("contextMenuEvent", params, rpcSchema.ZigSchema.requests.contextMenuEvent.response);
}

pub fn webviewEvent(params: rpcSchema.ZigSchema.requests.webviewEvent.params) rpcSchema.ZigSchema.requests.webviewEvent.response {
    return rpcStdout.sendRequest("webviewEvent", params, rpcSchema.ZigSchema.requests.webviewEvent.response);
}

pub fn windowClose(params: rpcSchema.ZigSchema.requests.windowClose.params) rpcSchema.ZigSchema.requests.windowClose.response {
    return rpcStdout.sendRequest("windowClose", params, rpcSchema.ZigSchema.requests.windowClose.response);
}

pub fn windowMove(params: rpcSchema.ZigSchema.requests.windowMove.params) rpcSchema.ZigSchema.requests.windowMove.response {
    return rpcStdout.sendRequest("windowMove", params, rpcSchema.ZigSchema.requests.windowMove.response);
}

pub fn windowResize(params: rpcSchema.ZigSchema.requests.windowResize.params) rpcSchema.ZigSchema.requests.windowResize.response {
    return rpcStdout.sendRequest("windowResize", params, rpcSchema.ZigSchema.requests.windowResize.response);
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
