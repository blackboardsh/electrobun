const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
const RequestResult = rpcSchema.RequestResult;
// todo: capitalize files and consts Window and Webview
const window = @import("../../macos/window.zig");
const webview = @import("../../macos/webview.zig");
const std = @import("std");

const alloc = std.heap.page_allocator;

pub fn createWindow(args: rpcSchema.BunSchema.requests.createWindow.args) RequestResult {
    _ = window.createWindow(.{
        .id = args.id,
        .title = args.title,
        .url = args.url,
        .html = args.html,
        .frame = .{
            .x = args.frame.x,
            .y = args.frame.y,
            .width = args.frame.width,
            .height = args.frame.height,
        },
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn createWebview(args: rpcSchema.BunSchema.requests.createWebview.args) RequestResult {
    // std.log.info("createWebview handler preload {s}", .{args.preload});
    webview.createWebview(.{
        .id = args.id,
        .url = args.url,
        .html = args.html,
        .preload = args.preload,
        .frame = .{
            .x = args.frame.x,
            .y = args.frame.y,
            .width = args.frame.width,
            .height = args.frame.height,
        },
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn setContentView(args: rpcSchema.BunSchema.requests.setContentView.args) RequestResult {
    window.setContentView(.{
        .webviewId = args.webviewId,
        .windowId = args.windowId,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn setTitle(args: rpcSchema.BunSchema.requests.setTitle.args) RequestResult {
    _ = window.setTitle(.{
        .winId = args.winId,
        .title = args.title,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn loadURL(args: rpcSchema.BunSchema.requests.loadURL.args) RequestResult {
    webview.loadURL(.{
        .webviewId = args.webviewId,
        .url = args.url,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn loadHTML(args: rpcSchema.BunSchema.requests.loadHTML.args) RequestResult {
    webview.loadHTML(.{
        .webviewId = args.webviewId,
        .html = args.html,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

// This gives type safety that every handler is implemented, and implements the correct signature
pub const handlers = rpcSchema.Handlers{
    .createWindow = createWindow,
    .createWebview = createWebview,
    .setTitle = setTitle,
    .setContentView = setContentView,
    .loadURL = loadURL,
    .loadHTML = loadHTML,
};

// todo: This is currently O(n), in the worst case it needs to do a mem.eql for every method
// ideally we modify rpcAnywhere to use enum/int for method name instead of the string method names
// so we can parse it into a zig enum and do an optimized lookup that can take advantage of binary search
// and other optimizations in a switch statement. That method enum + switch would also eliminate the need
// to have the handlers const and rpcSchema.Handlers struct.
// With that said the current methods are not things that need to be overly optimized, they're not really hot paths
const BunRequests = rpcSchema.BunSchema.requests;
pub fn handleRequest(request: rpcTypes._RPCRequestPacket) RequestResult {
    const method = request.method;
    std.log.info("hanlde request {s}", .{method});
    if (strEql(method, "createWindow")) {
        return parseArgsAndCall(handlers.createWindow, BunRequests.createWindow.args, request.params);
    } else if (strEql(method, "setTitle")) {
        return parseArgsAndCall(handlers.setTitle, BunRequests.setTitle.args, request.params);
    } else if (strEql(method, "setContentView")) {
        return parseArgsAndCall(handlers.setContentView, BunRequests.setContentView.args, request.params);
    } else if (strEql(method, "createWebview")) {
        return parseArgsAndCall(handlers.createWebview, BunRequests.createWebview.args, request.params);
    } else if (strEql(method, "loadURL")) {
        return parseArgsAndCall(handlers.loadURL, BunRequests.loadURL.args, request.params);
    } else if (strEql(method, "loadHTML")) {
        return parseArgsAndCall(handlers.loadHTML, BunRequests.loadHTML.args, request.params);
    } else {
        return RequestResult{ .errorMsg = "unhandled method", .payload = null };
    }
}

pub fn parseArgsAndCall(handler: anytype, argSchema: anytype, unparsedArgs: anytype) RequestResult {
    const parsedArgs = std.json.parseFromValue(argSchema, alloc, unparsedArgs, .{}) catch |err| {
        std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
        return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
    };

    std.log.info("parse and call", .{});

    return handler(parsedArgs.value);
}

// todo: move to string util (duplicated in webview.zig)
pub fn strEql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
