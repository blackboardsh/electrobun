const std = @import("std");

pub const MessageType = enum {
    request,
    response,
    message,
};

pub const _RPCMessage = struct {
    id: u32,
    type: []const u8, // request, response, message
};

pub const _RPCRequestPacket = struct {
    id: u32,
    type: []const u8 = "request",
    method: []const u8,
    params: std.json.Value,
};

pub const _RPCResponsePacketSuccess = struct {
    id: u32,
    type: []const u8 = "response",
    success: bool = true,
    payload: ?std.json.Value,
};

pub const _RPCResponsePacketError = struct {
    id: u32,
    type: []const u8, // = "response",
    success: bool, // = false,
    // Note: error is a reserved key in zig so we have to cast it from error to msg
    @"error": ?[]const u8, // error here is /Users/yoav/code/electrobun/libs/zig/webview/rpcAnywhere.zig:34:10: error: expected '.', found ':'
};

pub const _RPCMessagePacket = struct {
    // Note: RPC Anywhere uses the id field for "method" when it's a message
    id: []const u8,
    type: []const u8 = "message",
    payload: std.json.Value,
};
