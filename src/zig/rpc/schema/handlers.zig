const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
const RequestResult = rpcSchema.RequestResult;
// todo: capitalize files and consts Window and Webview
const window = @import("../../macos/window.zig");
const webview = @import("../../macos/webview.zig");
const tray = @import("../../macos/tray.zig");
const std = @import("std");
const utils = @import("../../utils.zig");

const strEql = utils.strEql;

// const rpc = @import("./request.zig");

const alloc = std.heap.page_allocator;

pub fn createWindow(params: rpcSchema.BunSchema.requests.createWindow.params) RequestResult {
    _ = window.createWindow(.{
        .id = params.id,
        .title = params.title,
        .url = params.url,
        .frame = .{
            .x = params.frame.x,
            .y = params.frame.y,
            .width = params.frame.width,
            .height = params.frame.height,
        },
        .styleMask = params.styleMask,
        .titleBarStyle = params.titleBarStyle,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn createWebview(params: rpcSchema.BunSchema.requests.createWebview.params) RequestResult {
    // std.log.info("createWebview handler preload {s}", .{params.preload});
    webview.createWebview(.{
        .id = params.id,
        .windowId = params.windowId,
        .renderer = params.renderer,
        .rpcPort = params.rpcPort,
        .secretKey = params.secretKey,
        .hostWebviewId = params.hostWebviewId,
        .pipePrefix = params.pipePrefix,
        .url = params.url,
        .html = params.html,
        .preload = params.preload,
        .partition = params.partition,
        .frame = .{ //
            .x = params.frame.x,
            .y = params.frame.y,
            .width = params.frame.width,
            .height = params.frame.height,
        },
        .autoResize = params.autoResize,
        .navigationRules = params.navigationRules,
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
pub fn startWindowMove(params: rpcSchema.BrowserSchema.messages.startWindowMove) RequestResult {
    window.startWindowMove(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn stopWindowMove(params: rpcSchema.BrowserSchema.messages.stopWindowMove) RequestResult {
    window.stopWindowMove(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn closeWindow(params: rpcSchema.BunSchema.requests.closeWindow.params) RequestResult {
    _ = window.closeWindow(.{
        .winId = params.winId,
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

pub fn moveToTrash(params: rpcSchema.BunSchema.requests.moveToTrash.params) RequestResult {
    _ = webview.moveToTrash(params.path);
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn showItemInFolder(params: rpcSchema.BunSchema.requests.showItemInFolder.params) RequestResult {
    _ = webview.showItemInFolder(params.path);
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn openFileDialog(params: rpcSchema.BunSchema.requests.openFileDialog.params) RequestResult {
    const result = webview.openFileDialog(params.startingFolder, params.allowedFileTypes, params.canChooseFiles, params.canChooseDirectory, params.allowsMultipleSelection);
    return RequestResult{ .errorMsg = null, .payload = .{ .openFileDialogResponse = result } };
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
pub fn webviewTagRemove(params: rpcSchema.BrowserSchema.messages.webviewTagRemove) RequestResult {
    webview.remove(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn webviewTagSetTransparent(params: rpcSchema.BrowserSchema.messages.webviewTagSetTransparent) RequestResult {
    webview.webviewTagSetTransparent(.{ .id = params.id, .transparent = params.transparent });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn webviewTagToggleMirroring(params: rpcSchema.BrowserSchema.messages.webviewTagToggleMirroring) RequestResult {
    webview.webviewTagToggleMirroring(.{ .id = params.id, .enable = params.enable });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn webviewTagSetPassthrough(params: rpcSchema.BrowserSchema.messages.webviewTagSetPassthrough) RequestResult {
    webview.webviewTagSetPassthrough(.{ .id = params.id, .enablePassthrough = params.enablePassthrough });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn webviewTagSetHidden(params: rpcSchema.BrowserSchema.messages.webviewTagSetHidden) RequestResult {
    webview.webviewSetHidden(.{ .id = params.id, .hidden = params.hidden });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn webviewEvent(params: rpcSchema.BrowserSchema.messages.webviewEvent) RequestResult {
    webview.webviewEvent(.{ .id = params.id, .eventName = params.eventName, .detail = params.detail });
    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn createTray(params: rpcSchema.BunSchema.requests.createTray.params) RequestResult {
    _ = tray.createTray(.{
        .id = params.id,
        .title = params.title,
        .image = params.image,
        .template = params.template,
        .width = params.width,
        .height = params.height,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn setTrayTitle(params: rpcSchema.BunSchema.requests.setTrayTitle.params) RequestResult {
    _ = tray.setTrayTitle(.{ .id = params.id, .title = params.title });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn setTrayImage(params: rpcSchema.BunSchema.requests.setTrayImage.params) RequestResult {
    _ = tray.setTrayImage(.{
        .id = params.id,
        .image = params.image,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn setTrayMenu(params: rpcSchema.BunSchema.requests.setTrayMenu.params) RequestResult {
    _ = tray.setTrayMenu(.{
        .id = params.id,
        .menuConfig = params.menuConfig,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn setApplicationMenu(params: rpcSchema.BunSchema.requests.setApplicationMenu.params) RequestResult {
    _ = tray.setApplicationMenu(.{
        .menuConfig = params.menuConfig,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}
pub fn showContextMenu(params: rpcSchema.BunSchema.requests.showContextMenu.params) RequestResult {
    _ = tray.showContextMenu(.{
        .menuConfig = params.menuConfig,
    });
    return RequestResult{ .errorMsg = null, .payload = null };
}

// This gives type safety that every handler is implemented, and implements the correct signature
pub const handlers = rpcSchema.Handlers{ //
    .createWindow = createWindow,
    .createWebview = createWebview,
    .setTitle = setTitle,
    .closeWindow = closeWindow,
    .loadURL = loadURL,
    .moveToTrash = moveToTrash,
    .showItemInFolder = showItemInFolder,
    .openFileDialog = openFileDialog,
    .createTray = createTray,
    .setTrayTitle = setTrayTitle,
    .setTrayImage = setTrayImage,
    .setTrayMenu = setTrayMenu,
    .setApplicationMenu = setApplicationMenu,
    .showContextMenu = showContextMenu,
};

pub const fromBrowserHandlers = rpcSchema.FromBrowserHandlers{
    .webviewTagCanGoBack = webviewTagCanGoBack,
    .webviewTagCanGoForward = webviewTagCanGoForward,
    .webviewTagCallAsyncJavaScript = webviewTagCallAsyncJavaScript,
    .webviewTagResize = webviewTagResize,
    .webviewTagUpdateSrc = webviewTagUpdateSrc,
    .webviewTagUpdateHtml = webviewTagUpdateHtml,
    .webviewTagUpdatePreload = webviewTagUpdatePreload,
    .webviewTagGoBack = webviewTagGoBack,
    .webviewTagGoForward = webviewTagGoForward,
    .webviewTagReload = webviewTagReload,
    .webviewTagRemove = webviewTagRemove,
    .startWindowMove = startWindowMove,
    .stopWindowMove = stopWindowMove,
    .webviewTagSetTransparent = webviewTagSetTransparent,
    .webviewTagToggleMirroring = webviewTagToggleMirroring,
    .webviewTagSetPassthrough = webviewTagSetPassthrough,
    .webviewTagSetHidden = webviewTagSetHidden,
    .webviewEvent = webviewEvent,
};

pub fn webviewTagCanGoBack(params: rpcSchema.BrowserSchema.requests.webviewTagCanGoBack.params) RequestResult {
    const canGoBack = webview.canGoBack(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = .{ .webviewTagCanGoBackResponse = canGoBack } };
}

pub fn webviewTagCanGoForward(params: rpcSchema.BrowserSchema.requests.webviewTagCanGoForward.params) RequestResult {
    const canGoForward = webview.canGoForward(.{ .id = params.id });
    return RequestResult{ .errorMsg = null, .payload = .{ .webviewTagCanGoForwardResponse = canGoForward } };
}

pub fn webviewTagCallAsyncJavaScript(params: rpcSchema.BrowserSchema.requests.webviewTagCallAsyncJavaScript.params) RequestResult {
    const handler = struct {
        pub fn handler(messageId: [*:0]const u8, webviewId: u32, hostWebviewId: u32, responseJSON: [*:0]const u8) callconv(.C) void {
            const jsCall = std.fmt.allocPrint(alloc, "document.querySelector('#electrobun-webview-{d}').setCallAsyncJavaScriptResponse(`{s}`, `{s}`);\n", .{ webviewId, messageId, responseJSON }) catch {
                return;
            };
            defer alloc.free(jsCall);

            webview.sendLineToWebview(hostWebviewId, jsCall);
        }
    }.handler;

    webview.callAsyncJavaScript(params.messageId, params.webviewId, params.hostWebviewId, params.script, handler);

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
        .masks = params.masks,
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

pub fn webviewTagUpdateHtml(params: rpcSchema.BrowserSchema.messages.webviewTagUpdateHtml) RequestResult {
    webview.loadHTML(.{
        .webviewId = params.id,
        .html = params.html,
    });

    return RequestResult{ .errorMsg = null, .payload = null };
}

pub fn webviewTagUpdatePreload(params: rpcSchema.BrowserSchema.messages.webviewTagUpdatePreload) RequestResult {
    webview.updatePreloadScriptToWebview(params.id, "electrobun_custom_preload_script", params.preload, true);

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
    } else if (strEql(method, "closeWindow")) {
        return parseParamsAndCall(handlers.closeWindow, BunRequests.closeWindow.params, request.params);
    } else if (strEql(method, "createWebview")) {
        return parseParamsAndCall(handlers.createWebview, BunRequests.createWebview.params, request.params);
    } else if (strEql(method, "loadURL")) {
        return parseParamsAndCall(handlers.loadURL, BunRequests.loadURL.params, request.params);
    } else if (strEql(method, "moveToTrash")) {
        return parseParamsAndCall(handlers.moveToTrash, BunRequests.moveToTrash.params, request.params);
    } else if (strEql(method, "showItemInFolder")) {
        return parseParamsAndCall(handlers.showItemInFolder, BunRequests.showItemInFolder.params, request.params);
    } else if (strEql(method, "openFileDialog")) {
        return parseParamsAndCall(handlers.openFileDialog, BunRequests.openFileDialog.params, request.params);
    } else if (strEql(method, "createTray")) {
        return parseParamsAndCall(handlers.createTray, BunRequests.createTray.params, request.params);
    } else if (strEql(method, "setTrayTitle")) {
        return parseParamsAndCall(handlers.setTrayTitle, BunRequests.setTrayTitle.params, request.params);
    } else if (strEql(method, "setTrayImage")) {
        return parseParamsAndCall(handlers.setTrayImage, BunRequests.setTrayImage.params, request.params);
    } else if (strEql(method, "setTrayMenu")) {
        return parseParamsAndCall(handlers.setTrayMenu, BunRequests.setTrayMenu.params, request.params);
    } else if (strEql(method, "setApplicationMenu")) {
        return parseParamsAndCall(handlers.setApplicationMenu, BunRequests.setApplicationMenu.params, request.params);
    } else if (strEql(method, "showContextMenu")) {
        return parseParamsAndCall(handlers.showContextMenu, BunRequests.showContextMenu.params, request.params);
    } else {
        return RequestResult{ .errorMsg = "unhandled method", .payload = null };
    }
}

pub fn fromBrowserHandleRequest(request: rpcTypes._RPCRequestPacket) RequestResult {
    const method = request.method;

    if (strEql(method, "webviewTagCanGoBack")) {
        return parseParamsAndCall(fromBrowserHandlers.webviewTagCanGoBack, rpcSchema.BrowserSchema.requests.webviewTagCanGoBack.params, request.params);
    } else if (strEql(method, "webviewTagCanGoForward")) {
        return parseParamsAndCall(fromBrowserHandlers.webviewTagCanGoForward, rpcSchema.BrowserSchema.requests.webviewTagCanGoForward.params, request.params);
    } else if (strEql(method, "webviewTagCallAsyncJavaScript")) {
        return parseParamsAndCall(fromBrowserHandlers.webviewTagCallAsyncJavaScript, rpcSchema.BrowserSchema.requests.webviewTagCallAsyncJavaScript.params, request.params);
    } else {
        return RequestResult{ .errorMsg = "unhandled method", .payload = null };
    }
}

pub fn fromBrowserHandleMessage(message: rpcTypes._RPCMessagePacket) void {
    const method = message.id;
    std.debug.print("fromBrowserHandleMessage method {s}\n", .{method});
    if (strEql(method, "webviewTagResize")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagResize, rpcSchema.BrowserSchema.messages.webviewTagResize, message.payload);
    } else if (strEql(method, "webviewTagUpdateSrc")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagUpdateSrc, rpcSchema.BrowserSchema.messages.webviewTagUpdateSrc, message.payload);
    } else if (strEql(method, "webviewTagUpdateHtml")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagUpdateHtml, rpcSchema.BrowserSchema.messages.webviewTagUpdateHtml, message.payload);
    } else if (strEql(method, "webviewTagUpdatePreload")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagUpdatePreload, rpcSchema.BrowserSchema.messages.webviewTagUpdatePreload, message.payload);
    } else if (strEql(method, "webviewTagGoBack")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagGoBack, rpcSchema.BrowserSchema.messages.webviewTagGoBack, message.payload);
    } else if (strEql(method, "webviewTagGoForward")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagGoForward, rpcSchema.BrowserSchema.messages.webviewTagGoForward, message.payload);
    } else if (strEql(method, "webviewTagReload")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagReload, rpcSchema.BrowserSchema.messages.webviewTagReload, message.payload);
    } else if (strEql(method, "webviewTagRemove")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagRemove, rpcSchema.BrowserSchema.messages.webviewTagRemove, message.payload);
    } else if (strEql(method, "startWindowMove")) {
        _ = parseParamsAndCall(fromBrowserHandlers.startWindowMove, rpcSchema.BrowserSchema.messages.startWindowMove, message.payload);
    } else if (strEql(method, "stopWindowMove")) {
        _ = parseParamsAndCall(fromBrowserHandlers.stopWindowMove, rpcSchema.BrowserSchema.messages.stopWindowMove, message.payload);
    } else if (strEql(method, "webviewTagSetTransparent")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagSetTransparent, rpcSchema.BrowserSchema.messages.webviewTagSetTransparent, message.payload);
    } else if (strEql(method, "webviewTagToggleMirroring")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagToggleMirroring, rpcSchema.BrowserSchema.messages.webviewTagToggleMirroring, message.payload);
    } else if (strEql(method, "webviewTagSetPassthrough")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagSetPassthrough, rpcSchema.BrowserSchema.messages.webviewTagSetPassthrough, message.payload);
    } else if (strEql(method, "webviewTagSetHidden")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewTagSetHidden, rpcSchema.BrowserSchema.messages.webviewTagSetHidden, message.payload);
    } else if (strEql(method, "webviewEvent")) {
        _ = parseParamsAndCall(fromBrowserHandlers.webviewEvent, rpcSchema.BrowserSchema.messages.webviewEvent, message.payload);
    }
}

pub fn parseParamsAndCall(handler: anytype, paramsSchema: anytype, unparsedParams: anytype) RequestResult {
    const parsedParams = std.json.parseFromValue(paramsSchema, alloc, unparsedParams, .{}) catch |err| {
        std.log.info("Error casting parsed json to zig type from stdin - {}: \n", .{err});
        return RequestResult{ .errorMsg = "failed to parse params", .payload = null };
    };

    return handler(parsedParams.value);
}
