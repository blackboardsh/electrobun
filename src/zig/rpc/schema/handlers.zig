const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
// todo: capitalize files and consts Window and Webview
const window = @import("../../macos/window.zig");
const webview = @import("../../macos/webview.zig");
const std = @import("std");

const alloc = std.heap.page_allocator;

pub fn createWindow(args: rpcSchema.BunSchema.requests.createWindow.args) void {
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
}

pub fn createWebview(args: rpcSchema.BunSchema.requests.createWebview.args) void {
    webview.createWebview(.{
        .id = args.id,
        .url = args.url,
        .html = args.html,
        .frame = .{
            .x = args.frame.x,
            .y = args.frame.y,
            .width = args.frame.width,
            .height = args.frame.height,
        },
    });
}

pub fn setContentView(args: rpcSchema.BunSchema.requests.setContentView.args) void {
    window.setContentView(.{
        .webviewId = args.webviewId,
        .windowId = args.windowId,
    });
}

pub fn setTitle(args: rpcSchema.BunSchema.requests.setTitle.args) void {
    _ = window.setTitle(.{
        .winId = args.winId,
        .title = args.title,
    });
}

pub fn loadURL(args: rpcSchema.BunSchema.requests.loadURL.args) void {
    webview.loadURL(.{
        .webviewId = args.webviewId,
        .url = args.url,
    });
}

pub fn loadHTML(args: rpcSchema.BunSchema.requests.loadHTML.args) void {
    webview.loadHTML(.{
        .webviewId = args.webviewId,
        .html = args.html,
    });
}

pub const handlers = rpcSchema.Handlers{
    .createWindow = createWindow,
    .createWebview = createWebview,
    .setTitle = setTitle,
    .setContentView = setContentView,
    .loadURL = loadURL,
    .loadHTML = loadHTML,
};

pub const RequestResult = struct { errorMsg: ?[]const u8, payload: ?rpcSchema.PayloadType };

// todo: make this function conver the method name to a comptime enum of handlers' fields
// so that it's automated.
pub fn handleRequest(request: rpcTypes._RPCRequestPacket) RequestResult {
    const method = request.method;

    // window handlers
    // todo: clean this up a bit
    if (std.mem.eql(u8, method, "createWindow")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.createWindow.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.createWindow(parsedArgs.value);

        return RequestResult{ .errorMsg = null, .payload = null };

        // todo: send back something from the window potentialy as part of the rpc implementation
        // in this case it would be void

    }

    if (std.mem.eql(u8, method, "setTitle")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.setTitle.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.setTitle(parsedArgs.value);
        return RequestResult{ .errorMsg = null, .payload = null };
    }

    if (std.mem.eql(u8, method, "setContentView")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.setContentView.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.setContentView(parsedArgs.value);

        return RequestResult{ .errorMsg = null, .payload = null };

        // todo: send back something from the window potentialy as part of the rpc implementation
        // in this case it would be void

    }

    // webview handlers
    if (std.mem.eql(u8, method, "createWebview")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.createWebview.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.createWebview(parsedArgs.value);

        return RequestResult{ .errorMsg = null, .payload = null };

        // todo: send back something from the window potentialy as part of the rpc implementation
        // in this case it would be void

    }

    if (std.mem.eql(u8, method, "loadURL")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.loadURL.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.loadURL(parsedArgs.value);

        return RequestResult{ .errorMsg = null, .payload = null };

        // todo: send back something from the window potentialy as part of the rpc implementation
        // in this case it would be void

    }

    if (std.mem.eql(u8, method, "loadHTML")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.loadHTML.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.loadHTML(parsedArgs.value);

        return RequestResult{ .errorMsg = null, .payload = null };

        // todo: send back something from the window potentialy as part of the rpc implementation
        // in this case it would be void

    }

    return RequestResult{ .errorMsg = "unhandled method", .payload = null };
}
