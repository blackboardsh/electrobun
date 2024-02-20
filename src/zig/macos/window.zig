const std = @import("std");
const objc = @import("./objc/zig-objc/src/main.zig");
const rpc = @import("../rpc/schema/request.zig");
const objcLibImport = @import("./objc/objc.zig");
const pipesin = @import("../rpc/pipesin.zig");

const alloc = std.heap.page_allocator;

const ELECTROBUN_BROWSER_API_SCRIPT = @embedFile("../build/index.js");

// Note: ideally these would be available in zig stdlib but they're not currently

const CGPoint = extern struct {
    x: f64,
    y: f64,
};

const CGSize = extern struct {
    width: f64,
    height: f64,
};

const CGRect = extern struct {
    origin: CGPoint,
    size: CGSize,
};

const NSWindowStyleMaskTitled = 1 << 0;
const NSWindowStyleMaskClosable = 1 << 1;
const NSWindowStyleMaskResizable = 1 << 3;

const NSBackingStoreBuffered = 2;

const WKUserScriptInjectionTimeAtDocumentStart = 0;

const WindowType = struct {
    id: u32,
    window: *anyopaque,
    webview: WebviewType,

    title: []const u8,
    url: ?[]const u8,
    html: ?[]const u8,
    frame: struct {
        width: f64,
        height: f64,
        x: f64,
        y: f64,
    },
};

const WebviewType = struct {
    // id: u32,
    handle: *anyopaque,
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
        std.log.info("}}}}}}}}Sending message to webview: {s}", .{message});

        executeJavaScript(self.handle, message);
        // const NSString = objc.getClass("NSString").?;
        // const jsString = NSString.msgSend(objc.Object, "stringWithUTF8String:", .{message});
        // self.handle.msgSend(void, "evaluateJavaScript:completionHandler:", .{ jsString, null });
    }
};

// todo: use the types in rpc.zig (or move them to a shared location)
const CreateWindowOpts = struct { id: u32, url: ?[]const u8, html: ?[]const u8, title: []const u8, frame: struct { width: f64, height: f64, x: f64, y: f64 } };
const SetTitleOpts = struct {
    winId: u32,
    title: []const u8,
};

const WindowMap = std.AutoHashMap(u32, WindowType);
var windowMap: WindowMap = WindowMap.init(alloc);

pub fn createWindow(opts: CreateWindowOpts) WindowType {
    const objcWin = objcLibImport.createNSWindowWithFrameAndStyle(.{ //
        .styleMask = .{ .Titled = true, .Closable = true, .Resizable = true }, //
        .frame = .{ //
            .origin = .{ .x = opts.frame.x - 600, .y = opts.frame.y - 600 },
            .size = .{ .width = opts.frame.width, .height = opts.frame.height },
        },
    });

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

    const windowBounds = objcLibImport.getWindowBounds(objcWin);
    const objcWebview = objcLibImport.createAndReturnWKWebView(windowBounds);

    const _window = WindowType{ //
        .id = opts.id,
        .title = opts.title,
        .url = opts.url,
        .html = opts.html,
        .frame = .{
            .width = opts.frame.width,
            .height = opts.frame.height,
            .x = opts.frame.x,
            .y = opts.frame.y,
        },
        .window = objcWin,
        .webview = WebviewType{ //
            .handle = objcWebview,
            .bun_out_pipe = bunPipeOutFileResult,
            .bun_in_pipe = bunPipeIn,
        },
    };

    windowMap.put(opts.id, _window) catch {
        std.log.info("Error putting window into hashmap: ", .{});
        return _window;
    };

    objcLibImport.setNSWindowTitle(objcWin, toCString(opts.title));

    objcLibImport.setContentView(objcWin, objcWebview);
    objcLibImport.addPreloadScriptToWebView(objcWebview, ELECTROBUN_BROWSER_API_SCRIPT, false);

    // Can only define functions inline in zig within a struct
    objcLibImport.setNavigationDelegateWithCallback(objcWebview, opts.id, struct {
        fn decideNavigation(windowId: u32, url: [*:0]const u8) bool {
            std.log.info("???????????????????????????????????????????????Deciding navigation for URL: {s}", .{url});
            std.log.info("win doo id: {}", .{windowId});
            // todo: right now this reaches a generic rpc request, but it should be attached
            // to this specific webview's pipe so navigation handlers can be attached to specific webviews
            const _response = rpc.request.decideNavigation(.{
                .url = url,
            });
            std.log.info("response from rpc: {}", .{_response});

            return _response.allow;
        }
    }.decideNavigation);

    objcLibImport.addScriptMessageHandlerWithCallback(objcWebview, opts.id, "bunBridge", struct {
        fn HandlePostMessageCallback(windowId: u32, message: [*:0]const u8) void {
            std.log.info("Received script message ************************************: {s} {}", .{ message, windowId });

            var win = windowMap.get(windowId) orelse {
                std.debug.print("Failed to get window from hashmap for id {}\n", .{windowId});
                return;
            };

            win.webview.sendToBun(message) catch |err| {
                std.debug.print("Failed to send message to bun: {}\n", .{err});
            };
        }
    }.HandlePostMessageCallback);

    if (opts.url) |url| {
        objcLibImport.loadURLInWebView(objcWebview, toCString(url));
    } else if (opts.html) |html| {
        objcLibImport.loadHTMLInWebView(objcWebview, toCString(html));
    }

    objcLibImport.makeNSWindowKeyAndOrderFront(objcWin);

    return _window;
}

pub fn setTitle(opts: SetTitleOpts) void {
    const win = windowMap.get(opts.winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.winId});
        return;
    };

    objcLibImport.setNSWindowTitle(win.window, toCString(opts.title));
}

// todo: move these to a different file
fn createNSString(string: []const u8) objc.Object {
    const NSString = objc.getClass("NSString").?;
    return NSString.msgSend(objc.Object, "stringWithUTF8String:", .{string});
}

fn createNSStringFromNullTerminatedString(string: [*:0]const u8) objc.Object {
    const NSString = objc.getClass("NSString").?;
    return NSString.msgSend(objc.Object, "stringWithUTF8String:", .{string});
}

fn createNSNumber(value: u32) objc.Object {
    const NSNumber = objc.getClass("NSNumber").?;
    // Use numberWithUnsignedInt: method to create NSNumber from u32
    return NSNumber.msgSend(objc.Object, "numberWithUnsignedInt:", .{value});
}

fn createNSURL(string: []const u8) objc.Object {
    const NSURL = objc.getClass("NSURL").?;
    std.log.info("Creating NSURL with string: {s}", .{string});
    const urlString = createNSString(string);
    const nsUrl = NSURL.msgSend(objc.Object, "URLWithString:", .{urlString});
    std.log.info("NSURL created: {}", .{nsUrl});
    return nsUrl;
}

// fn readJsFileContents(filePath: []const u8) ![]u8 {
//     const file = try std.fs.cwd().openFile(filePath, .{});
//     defer file.close();

//     const fileSize = try file.getEndPos();
//     var buffer = try alloc.alloc(u8, fileSize);
//     _ = try file.readAll(buffer);

//     return buffer;
// }

fn executeJavaScript(webview: *anyopaque, jsCode: []const u8) void {
    const nullTerminatedJsCode = toCString(jsCode);

    objcLibImport.evaluateJavaScriptWithNoCompletion(webview, nullTerminatedJsCode);
}

pub fn sendLineToWebview(winId: u32, line: []const u8) void {
    var win = windowMap.get(winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{winId});
        return;
    };

    win.webview.sendToWebview(line);
}

fn addPreloadScriptToWebViewConfig(config: *const objc.Object, scriptContent: []const u8) void {
    const WKUserScript = objc.getClass("WKUserScript").?;
    const userScriptAlloc = WKUserScript.msgSend(objc.Object, "alloc", .{});

    // Convert your script content to an NSString
    const scriptNSString = createNSString(scriptContent);

    // Initialize a WKUserScript with your script content
    // Injection time is .atDocumentStart to ensure it runs before the page content loads
    // ForMainFrameOnly: true or false depending on your needs
    const userScript = userScriptAlloc.msgSend(objc.Object, "initWithSource:injectionTime:forMainFrameOnly:", .{
        scriptNSString,
        WKUserScriptInjectionTimeAtDocumentStart,
        // it's odd that the preload script only runs before the page's scripts if this is set to false
        false,
    });

    // Get the userContentController from the config
    const userContentController = config.msgSend(objc.Object, "userContentController", .{});

    // Add the user script to the content controller
    userContentController.msgSend(void, "addUserScript:", .{userScript});
}

// effecient string concatenation that returns the template if there's an error
// this makes handling errors a bit easier
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
