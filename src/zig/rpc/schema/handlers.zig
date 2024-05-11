const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
const RequestResult = rpcSchema.RequestResult;
// todo: capitalize files and consts Window and Webview
const window = @import("../../macos/window.zig");
const webview = @import("../../macos/webview.zig");
const std = @import("std");

const rpc = @import("./request.zig");

const alloc = std.heap.page_allocator;

pub fn createWindow(params: rpcSchema.BunSchema.requests.createWindow.params) RequestResult {
    _ = window.createWindow(.{
        .id = params.id,
        .title = params.title,
        .url = params.url,
        .html = params.html,
        .frame = .{
            .x = params.frame.x,
            .y = params.frame.y,
            .width = params.frame.width,
            .height = params.frame.height,
        },
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn createWebview(params: rpcSchema.BunSchema.requests.createWebview.params) RequestResult {
    // std.log.info("createWebview handler preload {s}", .{params.preload});
    webview.createWebview(.{
        .id = params.id,
        .pipePrefix = params.pipePrefix,
        .url = params.url,
        .html = params.html,
        .preload = params.preload,
        .frame = .{ //
            .x = params.frame.x,
            .y = params.frame.y,
            .width = params.frame.width,
            .height = params.frame.height,
        },
        .autoResize = true,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn addWebviewToWindow(params: rpcSchema.BunSchema.requests.addWebviewToWindow.params) RequestResult {
    window.addWebviewToWindow(.{
        .webviewId = params.webviewId,
        .windowId = params.windowId,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn setTitle(params: rpcSchema.BunSchema.requests.setTitle.params) RequestResult {
    _ = window.setTitle(.{
        .winId = params.winId,
        .title = params.title,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn loadURL(params: rpcSchema.BunSchema.requests.loadURL.params) RequestResult {
    webview.loadURL(.{
        .webviewId = params.webviewId,
        .url = params.url,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn loadHTML(params: rpcSchema.BunSchema.requests.loadHTML.params) RequestResult {
    webview.loadHTML(.{
        .webviewId = params.webviewId,
        .html = params.html,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn moveToTrash(params: rpcSchema.BunSchema.requests.moveToTrash.params) RequestResult {
    _ = webview.moveToTrash(params.path);
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn webviewTagGoBack(params: rpcSchema.BrowserSchema.messages.webviewTagGoBack) RequestResult {
    webview.goBack(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn webviewTagGoForward(params: rpcSchema.BrowserSchema.messages.webviewTagGoForward) RequestResult {
    webview.goForward(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn webviewTagReload(params: rpcSchema.BrowserSchema.messages.webviewTagReload) RequestResult {
    webview.reload(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = null };
}

// This gives type safety that every handler is implemented, and implements the correct signature
pub const handlers = rpcSchema.Handlers{
    .createWindow = createWindow,
    .createWebview = createWebview,
    .setTitle = setTitle,
    .addWebviewToWindow = addWebviewToWindow,
    .loadURL = loadURL,
    .loadHTML = loadHTML,
    .moveToTrash = moveToTrash,
};

pub const fromBrowserHandlers = rpcSchema.FromBrowserHandlers{
    .webviewTagInit = webviewTagInit,
    .webviewTagResize = webviewTagResize,
    .webviewTagUpdateSrc = webviewTagUpdateSrc,
    .webviewTagGoBack = webviewTagGoBack,
    .webviewTagGoForward = webviewTagGoForward,
    .webviewTagReload = webviewTagReload,
};

pub fn webviewTagInit(params: rpcSchema.BrowserSchema.requests.webviewTagInit.params) RequestResult {
    // todo: this should go through bun so bun is aware of the webview
    // and so it can create and wire up the in/out pipes
    webview.createWebview(.{
        .id = params.id,
        // note: currently setting to empty string because zig skips over pipe creation for webview tags
        // for now.
        .pipePrefix = "",
        .url = params.url,
        .html = params.html,
        .preload = params.preload,
        .frame = .{ //
            .x = params.frame.x,
            .y = params.frame.y,
            .width = params.frame.width,
            .height = params.frame.height,
        },
        .autoResize = false,
    });

    const webviewId = params.id;
    const windowId = params.windowId;

    _ = addWebviewToWindow(.{ .webviewId = webviewId, .windowId = windowId });

    // note this will be a separate thing as well
    _ = loadURL(.{ .webviewId = webviewId, .url = params.url.? });

    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn webviewTagResize(params: rpcSchema.BrowserSchema.messages.webviewTagResize) RequestResult {
    webview.resizeWebview(.{
        .id = params.id,
        .frame = .{
            .x = params.frame.x,
            .y = params.frame.y,
            .width = params.frame.width,
            .height = params.frame.height,
        },
    });

    // We don't really need to return anything here since it's a message and not a request
    // but keeping the same api as requests here for now in case we want to log errors when
    // handling messages or something.
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn webviewTagUpdateSrc(params: rpcSchema.BrowserSchema.messages.webviewTagUpdateSrc) RequestResult {
    webview.loadURL(.{
        .webviewId = params.id,
        .url = params.url,
    });

    return RequestResult{ .errorMsg = null, .payload = null };
}

// todo: This is currently O(n), in the worst case it needs to do a mem.eql for every method
// ideally we modify rpcAnywhere to use enum/int for method name instead of the string method names
// so we can parse it into a zig enum and do an optimized lookup that can take advantage of binary search
// and other optimizations in a switch statement. That method enum + switch would also eliminate the need
// to have the handlers const and rpcSchema.Handlers struct.
// With that said the current methods are not things that need to be overly optimized, they're not really hot paths
const BunRequests = rpcSchema.BunSchema.requests;
pub fn handleRequest(request: rpcTypes._RPCRequestPacket) RequestResult {
    const method = request.method;

    if (strEql(method, "createWindow")) {
        return parseParamsAndCall(handlers.createWindow, BunRequests.createWindow.params, request.params);
    } else if (strEql(method, "setTitle")) {
        return parseParamsAndCall(handlers.setTitle, BunRequests.setTitle.params, request.params);
    } else if (strEql(method, "addWebviewToWindow")) {
        return parseParamsAndCall(handlers.addWebviewToWindow, BunRequests.addWebviewToWindow.params, request.params);
    } else if (strEql(method, "createWebview")) {
        return parseParamsAndCall(handlers.createWebview, BunRequests.createWebview.params, request.params);
    } else if (strEql(method, "loadURL")) {
        return parseParamsAndCall(handlers.loadURL, BunRequests.loadURL.params, request.params);
    } else if (strEql(method, "loadHTML")) {
        return parseParamsAndCall(handlers.loadHTML, BunRequests.loadHTML.params, request.params);
    } else if (strEql(method, "moveToTrash")) {
        return parseParamsAndCall(handlers.moveToTrash, BunRequests.moveToTrash.params, request.params);
    } else {
        return RequestResult{ .errorMsg = "unhandled method", .payload = null };
    }
}

pub fn fromBrowserHandleRequest(request: rpcTypes._RPCRequestPacket) RequestResult {
    const method = request.method;

    if (strEql(method, "webviewTagInit")) {
        return parseParamsAndCall(fromBrowserHandlers.webviewTagInit, rpcSchema.BrowserSchema.requests.webviewTagInit.params, request.params);
    } else {
        return RequestResult{ .errorMsg = "unhandled method", .payload = null };
    }
}

pub fn fromBrowserHandleMessage(message: rpcTypes._RPCMessagePacket) void {
    const method = message.id;

    if (strEql(method, "webviewTagResize")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagResize, rpcSchema.BrowserSchema.messages.webviewTagResize, message.payload);
    } else if (strEql(method, "webviewTagUpdateSrc")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagUpdateSrc, rpcSchema.BrowserSchema.messages.webviewTagUpdateSrc, message.payload);
    } else if (strEql(method, "webviewTagGoBack")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagGoBack, rpcSchema.BrowserSchema.messages.webviewTagGoBack, message.payload);
    } else if (strEql(method, "webviewTagGoForward")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagGoForward, rpcSchema.BrowserSchema.messages.webviewTagGoForward, message.payload);
    } else if (strEql(method, "webviewTagReload")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagReload, rpcSchema.BrowserSchema.messages.webviewTagReload, message.payload);
    }
}

pub fn parseParamsAndCall(handler: anytype, paramsSchema: anytype, unparsedParams: anytype) RequestResult {
    const parsedParams = std.json.parseFromValue(paramsSchema, alloc, unparsedParams, .{}) catch |err| {
        std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
        return RequestResult{ .errorMsg = "failed to parse params", .payload = null };
    };

    return handler(parsedParams.value);
}

// todo: move to string util (duplicated in webview.zig)
pub fn strEql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
