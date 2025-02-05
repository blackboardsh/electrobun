const std = @import("std");
const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
const rpcStdout = @import("../stdout.zig");

const alloc = std.heap.page_allocator;


// TEMP: made all these "requests" that just ignore the response for now.
// todo: most of these should be messages. pending a complete refactor of electrobun event system

// pub fn decideNavigation(params: rpcSchema.ZigSchema.requests.decideNavigation.params) {
//     rpcStdout.sendRequest("decideNavigation", params);
// }

pub fn log(params: rpcSchema.ZigSchema.requests.log.params) void {
    rpcStdout.sendRequest("log", params);
}

// pub fn sendSyncRequest(params: rpcSchema.ZigSchema.requests.sendSyncRequest.params) void {
//     rpcStdout.sendRequest("syncRequest", params);
// }

pub fn trayEvent(params: rpcSchema.ZigSchema.requests.trayEvent.params) void {
    rpcStdout.sendRequest("trayEvent", params);
}

pub fn applicationMenuEvent(params: rpcSchema.ZigSchema.requests.applicationMenuEvent.params) void {
    rpcStdout.sendRequest("applicationMenuEvent", params);
}

pub fn contextMenuEvent(params: rpcSchema.ZigSchema.requests.contextMenuEvent.params) void {
    rpcStdout.sendRequest("contextMenuEvent", params);
}

pub fn webviewEvent(params: rpcSchema.ZigSchema.requests.webviewEvent.params) void {
    rpcStdout.sendRequest("webviewEvent", params);
}

pub fn windowClose(params: rpcSchema.ZigSchema.requests.windowClose.params) void {
    rpcStdout.sendRequest("windowClose", params);
}

pub fn windowMove(params: rpcSchema.ZigSchema.requests.windowMove.params) void {
    rpcStdout.sendRequest("windowMove", params);
}

pub fn windowResize(params: rpcSchema.ZigSchema.requests.windowResize.params) void {
    rpcStdout.sendRequest("windowResize", params);
}

pub const request = rpcSchema.Requests{ //
//     .decideNavigation = decideNavigation,
//     .sendSyncRequest = sendSyncRequest,
    .log = log,
    .trayEvent = trayEvent,
    .applicationMenuEvent = applicationMenuEvent,
    .contextMenuEvent = contextMenuEvent,
    .webviewEvent = webviewEvent,
    .windowClose = windowClose,
    .windowMove = windowMove,
    .windowResize = windowResize,
};
