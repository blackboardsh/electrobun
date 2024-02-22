const std = @import("std");
const rpc = @import("../rpc/schema/request.zig");
const rpcSchema = @import("../rpc/schema/schema.zig");
const objc = @import("./objc.zig");
const pipesin = @import("../rpc/pipesin.zig");

const alloc = std.heap.page_allocator;

const ELECTROBUN_BROWSER_API_SCRIPT = @embedFile("../build/index.js");

const WebviewMap = std.AutoHashMap(u32, WebviewType);
pub var webviewMap: WebviewMap = WebviewMap.init(alloc);

const WebviewType = struct {
    id: u32,
    handle: *anyopaque,

    // url: ?[]const u8,
    // html: ?[]const u8,
    frame: struct {
        width: f64,
        height: f64,
        x: f64,
        y: f64,
    },
    // todo: de-init these using objc.releaseObjCObject() when the webview closes
    delegate: *anyopaque,
    bunBridgeHandler: *anyopaque,
    bun_out_pipe: ?anyerror!std.fs.File,
    bun_in_pipe: ?std.fs.File,
    // Function to send a message to Bun
    pub fn sendToBun(self: *WebviewType, message: [*:0]const u8) !void {
        if (self.bun_out_pipe) |result| {
            if (result) |file| {
                std.log.info("Opened file successfully", .{});
                // convert null terminated string to slice
                // const message_slice: []const u8 = message[0..std.mem.len(message)];
                // Write the message to the named pipe
                file.writeAll(fromCString(message)) catch |err| {
                    std.debug.print("Failed to write to file: {}\n", .{err});
                };
            } else |err| {
                std.debug.print("Failed to open file: {}\n", .{err});
            }
            // If bun_out_pipe is not an error and not null, write the message
            // try file.writeAll(message);
        } else {
            // If bun_out_pipe is null, print an error or the message to stdio
            std.debug.print("Error: No valid pipe to write to. Message was: {s}\n", .{message});
        }
    }

    pub fn sendToWebview(self: *WebviewType, message: []const u8) void {
        std.log.info("}}}}}}}}Sending message to webview: {s} {}", .{ message, self.handle });

        objc.evaluateJavaScriptWithNoCompletion(self.handle, toCString(message));
    }
};

const CreateWebviewOpts = struct { id: u32, url: ?[]const u8, html: ?[]const u8, frame: struct { width: f64, height: f64, x: f64, y: f64 } };
pub fn createWebview(opts: CreateWebviewOpts) void {
    const bunPipeIn = blk: {
        const bunPipeInPath = concatOrFallback("/private/tmp/electrobun_ipc_pipe_{}_1_in", .{opts.id});
        const bunPipeInFileResult = std.fs.cwd().openFile(bunPipeInPath, .{ .mode = .read_only });

        if (bunPipeInFileResult) |file| {
            std.log.info("Opened file successfully", .{});
            break :blk file; //std.fs.File{ .handle = fd };
        } else |err| {
            std.debug.print("Failed to open file: {}\n", .{err});
            break :blk null;
        }
    };

    std.log.info("Finished opening file descriptor", .{});

    if (bunPipeIn) |pipeInFile| {
        // _ = pipeInFile;
        pipesin.addPipe(pipeInFile.handle, opts.id);
    }

    const bunPipeOutPath = concatOrFallback("/private/tmp/electrobun_ipc_pipe_{}_1_out", .{opts.id});

    std.log.info("concat result {s}", .{bunPipeOutPath});

    const bunPipeOutFileResult = std.fs.cwd().openFile(bunPipeOutPath, .{ .mode = .read_write });

    std.log.info("after read", .{});

    // const windowBounds = objc.getWindowBounds(objcWin);
    const objcWebview = objc.createAndReturnWKWebView(.{
        // .frame = .{ //
        .origin = .{ .x = opts.frame.x, .y = opts.frame.y },
        .size = .{ .width = opts.frame.width, .height = opts.frame.height },
        // },
    });

    objc.addPreloadScriptToWebView(objcWebview, ELECTROBUN_BROWSER_API_SCRIPT, false);

    // Can only define functions inline in zig within a struct
    const delegate = objc.setNavigationDelegateWithCallback(objcWebview, opts.id, struct {
        fn decideNavigation(webviewId: u32, url: [*:0]const u8) bool {
            std.log.info("???????????????????????????????????????????????Deciding navigation for URL: {s}", .{url});
            std.log.info("web voo id: {}", .{webviewId});
            // todo: right now this reaches a generic rpc request, but it should be attached
            // to this specific webview's pipe so navigation handlers can be attached to specific webviews
            const _response = rpc.request.decideNavigation(.{
                .webviewId = webviewId,
                .url = fromCString(url),
            });
            std.log.info("response from rpc: {}", .{_response});

            return _response.allow;
        }
    }.decideNavigation);

    const bunBridgeHandler = objc.addScriptMessageHandlerWithCallback(objcWebview, opts.id, "bunBridge", struct {
        fn HandlePostMessageCallback(webviewId: u32, message: [*:0]const u8) void {
            // bun bridge just forwards messages to the bun

            std.log.info("Received script message ************************************: {s} {}", .{ message, webviewId });

            var webview = webviewMap.get(webviewId) orelse {
                std.debug.print("Failed to get webview from hashmap for id {}\n", .{webviewId});
                return;
            };

            webview.sendToBun(message) catch |err| {
                std.debug.print("Failed to send message to bun: {}\n", .{err});
            };
        }
    }.HandlePostMessageCallback);

    const _webview = WebviewType{ //
        .id = opts.id,
        // .url = opts.url,
        // .html = opts.html,
        .frame = .{
            .width = opts.frame.width,
            .height = opts.frame.height,
            .x = opts.frame.x,
            .y = opts.frame.y,
        },
        .handle = objcWebview,
        .bun_out_pipe = bunPipeOutFileResult,
        .bun_in_pipe = bunPipeIn,
        .delegate = delegate,
        .bunBridgeHandler = bunBridgeHandler,
    };

    webviewMap.put(opts.id, _webview) catch {
        std.log.info("Error putting webview into hashmap: ", .{});
        return;
    };

    // todo: I think you can only load webview once it's added to a window
    // so will need to call this RPC from bun
    // if (opts.url) |url| {
    //     objc.loadURLInWebView(objcWebview, toCString(url));
    // } else if (opts.html) |html| {
    //     objc.loadHTMLInWebView(objcWebview, toCString(html));
    // }
}

pub fn loadURL(opts: rpcSchema.BunSchema.requests.loadURL.args) void {
    var webview = webviewMap.get(opts.webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.webviewId});
        return;
    };

    // webview.url = opts.url;
    objc.loadURLInWebView(webview.handle, toCString(opts.url));
}

pub fn loadHTML(opts: rpcSchema.BunSchema.requests.loadHTML.args) void {
    var webview = webviewMap.get(opts.webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.webviewId});
        return;
    };

    // webview.html = opts.html;
    objc.loadHTMLInWebView(webview.handle, toCString(opts.html));
}

pub fn sendLineToWebview(webviewId: u32, line: []const u8) void {
    var webview = webviewMap.get(webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{webviewId});
        return;
    };

    webview.sendToWebview(line);
}

// todo: move to a util and dedup with window.zig
fn concatOrFallback(comptime fmt: []const u8, args: anytype) []const u8 {
    var buffer: [100]u8 = undefined;
    const result = std.fmt.bufPrint(&buffer, fmt, args) catch |err| {
        std.log.info("Error concatenating string {}", .{err});
        return fmt;
    };

    return result;
}

fn toCString(input: []const u8) [*:0]const u8 {
    // Attempt to allocate memory, handle error without bubbling it up
    const allocResult = alloc.alloc(u8, input.len + 1) catch {
        return "console.error('failed to allocate string');";
    };

    std.mem.copy(u8, allocResult, input); // Copy input to the allocated buffer
    allocResult[input.len] = 0; // Null-terminate
    return allocResult[0..input.len :0]; // Correctly typed slice with null terminator
}

fn fromCString(input: [*:0]const u8) []const u8 {
    return input[0 .. std.mem.len(input) - 1];
}
