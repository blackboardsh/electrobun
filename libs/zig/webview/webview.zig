const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");
const c = @import("../zig-objc/src/c.zig");

// timer reference
// const startTime = std.time.nanoTimestamp();
// // code
// const endTime = std.time.nanoTimestamp();
// const duration = endTime - startTime;
// std.debug.print("Time taken: {} ns\n", .{duration});

// needed to access grand central dispatch to dispatch things from
// other threads to the main thread
const dispatch = @cImport({
    @cInclude("dispatch/dispatch.h");
});

const alloc = std.heap.page_allocator;

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

const WKNavigationResponsePolicy = enum(c_int) {
    cancel,
    allow,
    download,
};

// const WKNavigationDecisionHandler = fn (WKNavigationResponsePolicy) void;
// In C the first param is a reference to itself
// const WKNavigationDecisionHandler = fn (*anyopaque, WKNavigationResponsePolicy) callconv(.C) void;
// const WKNavigationDecisionHandler = fn (WKNavigationResponsePolicy) callconv(.C) void;
const DecisionHandlerBlock = objc.Block(struct {}, (.{WKNavigationResponsePolicy}), void);

// var window: objc.Object = undefined;

pub const TitleContext = struct {
    title: []const u8,
};

pub const WindowContext = struct {
    id: u32,
};

pub fn main() !void {
    var ipcThread = try std.Thread.spawn(.{}, stdInListener, .{});
    defer ipcThread.join();

    startAppkitGuiEventLoop();
}

const MessageType = enum {
    setTitle,
    createWindow,
    // Add other types as needed
};

const MessageFromBun = struct {
    type: MessageType,
    payload: std.json.Value,
};

const SetTitlePayload = struct {
    winId: u32,
    title: []const u8,
};

const CreateWindowPayload = struct { id: u32, url: ?[]const u8, html: ?[]const u8, title: []const u8, width: f64, height: f64, x: f64, y: f64 };

const WindowType = struct {
    id: u32,
    window: ?objc.Object,
    webview: ?objc.Object,

    title: []const u8,
    url: ?[]const u8,
    html: ?[]const u8,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
};

var jobQueue = std.ArrayList([]const u8).init(alloc);
// defer jobQueue.deinit();

// const WindowMap = std.HashMap(u32, WindowType, std.hash_map.DefaultHashFn(u32));
const WindowMap = std.AutoHashMap(u32, WindowType);
var windowMap: WindowMap = WindowMap.init(alloc);

fn proccessJobQueue(context: ?*anyopaque) callconv(.C) void {
    _ = context;
    // std.log.info("jobqueue items main length {}", .{jobQueue.items.len});

    const line = jobQueue.orderedRemove(0);
    defer alloc.free(line);

    std.log.info("parsed line {s}", .{line});
    // Do the main json parsing work on the stdin thread, add it to a queue, and then
    // process the generic jobs on the main thread
    const messageFromBun = std.json.parseFromSlice(MessageFromBun, alloc, line, .{}) catch |err| {
        std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
        return;
    };

    defer messageFromBun.deinit();

    // Handle the message based on its type
    switch (messageFromBun.value.type) {
        .setTitle => {
            // todo: do we need parseFromValue here? can we just cast the payload to a type?
            const parsedPayload = std.json.parseFromValue(SetTitlePayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
                std.log.info("Error casting parsed json to zig type from stdin - {}: \n", .{err});
                return;
            };
            defer parsedPayload.deinit();

            const payload = parsedPayload.value;

            setTitle(payload);
        },
        .createWindow => {
            const parsedPayload = std.json.parseFromValue(CreateWindowPayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
                std.log.info("Error casting parsed json to zig type from stdin - {}: \n", .{err});
                return;
            };
            defer parsedPayload.deinit();

            const payload = parsedPayload.value;
            const objcWindow = createWindow(payload);

            std.log.info("parsed type {}: \nreceived: ", .{payload.id});

            const _window = WindowType{ .id = payload.id, .title = payload.title, .url = payload.url, .html = payload.html, .width = payload.width, .height = payload.height, .x = payload.x, .y = payload.y, .window = objcWindow, .webview = undefined };

            windowMap.put(payload.id, _window) catch {
                std.log.info("Error putting window into hashmap: \nreceived: {}", .{messageFromBun.value.type});
                return;
            };

            std.log.info("hashmap size{}", .{windowMap.count()});
        },

        // Handle other types
    }
}

// We listen on stdin for stuff to do from bun and then dispatch it to the main thread where the gui stuff happens
fn stdInListener() void {
    const stdin = std.io.getStdIn().reader();
    // Note: this is a zig string.
    var buffer: [1024]u8 = undefined;

    while (true) {
        const bytesRead = stdin.readUntilDelimiterOrEof(&buffer, '\n') catch continue;
        if (bytesRead) |line| {
            std.log.info("received line: {s}", .{line});

            // since line is re-used we need to copy it to the heap
            const lineCopy = alloc.dupe(u8, line) catch {
                // Handle the error here, e.g., log it or set a default value
                std.debug.print("Error: {s}\n", .{line});
                continue;
            };

            jobQueue.append(lineCopy) catch {
                std.log.info("Error appending to jobQueue: \nreceived: {s}", .{line});
                continue;
            };

            dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), null, proccessJobQueue);
        }
    }
}

// todo: create event mapping types in zig and typescript
fn sendMessageToBun(message: []const u8) void {
    const stdout = std.io.getStdOut().writer();

    // Write the message to stdout
    _ = stdout.writeAll(message) catch {
        // Handle potential errors here
        std.debug.print("Failed to write to stdout\n", .{});
    };
}

pub export fn startAppkitGuiEventLoop() void {
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // run the event loop
    const nsApplicationClass = objc.getClass("NSApplication") orelse {
        std.debug.print("Failed to get NSApplication class\n", .{});
        return;
    };

    // windowAlloc.msgSend(void, "release", .{});
    const app = nsApplicationClass.msgSend(objc.Object, "sharedApplication", .{});

    // Run the application event loop
    app.msgSend(void, "run", .{});
}

fn setTitle(opts: SetTitlePayload) void {
    const win = windowMap.get(opts.winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.winId});
        return;
    };

    if (win.window) |window| {
        const titleString = createNSString(opts.title);
        window.msgSend(void, "setTitle:", .{titleString});
    }
}

pub fn createWindow(opts: CreateWindowPayload) objc.Object {
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // open a window
    const nsWindowClass = objc.getClass("NSWindow").?;
    const windowAlloc = nsWindowClass.msgSend(objc.Object, "alloc", .{});

    // Pointer Note: if using manual memory management then the memory will need to be cleaned up using `release` method
    // windowAlloc.msgSend(void, "release", .{});

    // Define the frame rectangle (x, y, width, height)
    const frame = CGRect{ .origin = CGPoint{ .x = opts.x, .y = opts.y }, .size = CGSize{ .width = opts.width, .height = opts.height } };

    // Define the window style mask (e.g., titled, closable, resizable)
    const styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;

    // Define the backing store type
    const backing = NSBackingStoreBuffered;

    // Define whether to defer creation
    const defers = true;

    // Initialize the NSWindow instance
    const _window = windowAlloc.msgSend(objc.Object, "initWithContentRect:styleMask:backing:defer:", .{ frame, styleMask, backing, defers });

    // You have to initialize obj-c string and then pass a pointer to it
    const titleString = createNSString(opts.title);
    _window.msgSend(void, "setTitle:", .{titleString});

    // Get the content view of the window
    const contentView = _window.msgSend(objc.Object, "contentView", .{});

    // Get the bounds of the content view
    const windowBounds: CGRect = contentView.msgSend(CGRect, "bounds", .{});

    const wkWebviewClass = objc.getClass("WKWebView").?;
    const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});
    const windowWebview = webkitAlloc.msgSend(objc.Object, "initWithFrame:", .{windowBounds});
    _window.msgSend(void, "setContentView:", .{windowWebview});

    // fn proccessJobQueue(context: ?*anyopaque) callconv(.C) void {
    const MyNavigationDelegate = setup: {
        const MyNavigationDelegate = objc.allocateClassPair(objc.getClass("NSObject").?, "my_navigation_delegate").?;

        std.log.info("MyNavigationDelegate class allocated successfully", .{});

        defer objc.registerClassPair(MyNavigationDelegate);

        std.debug.assert(try MyNavigationDelegate.addMethod("webView:decidePolicyForNavigationAction:decisionHandler:", struct {
            fn imp(target: objc.c.id, webView: *anyopaque, navigationAction: *anyopaque, decisionHandler: objc.c.id) callconv(.C) void {
                // Note:
                // target = a reference to the object who's method is being called, so in this case it's the NavigationDelegate
                // sel (objc selector) basically the name of the method on the target. in js it's like `target[sel]()`
                // in this case it's thiswebviewinstance:decidePolicyForNavigationAction:decisionHandler:
                // webView = the WKWebview that's calling the method
                _ = target;
                // _ = sel;
                _ = webView;
                _ = navigationAction;
                _ = decisionHandler;
                // const navigationActionObj = @as(*const objc.Object, @alignCast(@ptrCast(navigationAction)));
                // // const navigationActionObj = @as(*const objc.Object, @ptrCast(navigationAction));
                // const requestObj = navigationActionObj.msgSend(objc.Object, "request", .{});
                // const url = requestObj.msgSend(objc.Object, "url", .{});

                // We have to cast the objc opaque type to a defined zig type for zig to let us call it like a function
                // and type it correctly

                // std.log.info("----> navigationg thingy running {}", .{url});

                std.log.info("----> navigationg thingy running ", .{});

                // Error: causes panic
                // const decisionHandlerCallback: *WKNavigationDecisionHandler = @ptrCast(decisionHandler);
                // decisionHandlerCallback(decisionHandler, WKNavigationResponsePolicy.allow);

                // Error: invalid selector
                // const decisionHandlerObj = @as(*const objc.Object, @ptrCast(decisionHandler));
                // decisionHandlerObj.msgSend(void, "invokeWithArgument:", .{WKNavigationResponsePolicy.allow});

                // Error: panic
                // const decisionHandlerCallback = @as(*const WKNavigationDecisionHandler, @ptrCast(decisionHandler));
                // decisionHandlerCallback(decisionHandler, .allow); // Assuming .allow is a valid value for WKNavigationResponsePolicy

                // Cast decisionHandler to the DecisionHandlerBlock type
                // const decisionHandlerBlock: *DecisionHandlerBlock = @ptrCast(decisionHandler);

                // Invoke the decisionHandler block with the appropriate arguments
                // decisionHandlerBlock.invoke(.{.allow});
            }
        }.imp));

        break :setup MyNavigationDelegate;
    };

    // Use your custom delegate
    const myDelegate = MyNavigationDelegate.msgSend(objc.Object, "alloc", .{}).msgSend(objc.Object, "init", .{});
    windowWebview.msgSend(void, "setNavigationDelegate:", .{myDelegate});

    // works, basic zig example creating an obj c block that references zig code
    // const AddBlock = objc.Block(struct {
    //     x: i32,
    //     y: i32,
    // }, .{}, i32);

    // const captures: AddBlock.Captures = .{
    //     .x = 2,
    //     .y = 3,
    // };

    // var block = AddBlock.init(captures, (struct {
    //     fn addFn(block: *const AddBlock.Context) callconv(.C) i32 {
    //         std.log.info("----> addFn running", .{});
    //         return block.x + block.y;
    //     }
    // }).addFn) catch null;
    // defer if (block != null) block.?.deinit();

    // if (block) |_block| {
    //     _ = _block.invoke(.{});
    // }

    // load url
    if (opts.url) |url| {
        // Note: we pass responsibility to objc to free the memory
        const urlCopy = alloc.dupe(u8, url) catch {
            unreachable;
        };
        // std.log.info("creating url window: {s}", .{url});
        const request = objc.getClass("NSURLRequest").?.msgSend(objc.Object, "requestWithURL:", .{createNSURL(urlCopy)});
        windowWebview.msgSend(void, "loadRequest:", .{request});
    } else if (opts.html) |html| {
        const htmlCopy = alloc.dupe(u8, html) catch {
            unreachable;
        };
        std.log.info("creating html window: {s}", .{html});
        // const NSHtmlString = createNSString(html);
        windowWebview.msgSend(void, "loadHTMLString:baseURL:", .{ createNSString(htmlCopy), createNSURL("file://") });
    }

    // Display the window
    _window.msgSend(void, "makeKeyAndOrderFront:", .{});

    return _window;
}

fn createNSString(string: []const u8) objc.Object {
    const NSString = objc.getClass("NSString").?;
    return NSString.msgSend(objc.Object, "stringWithUTF8String:", .{string});
}

fn createNSURL(string: []const u8) objc.Object {
    const NSURL = objc.getClass("NSURL").?;
    std.log.info("Creating NSURL with string: {s}", .{string});
    const urlString = createNSString(string);
    const nsUrl = NSURL.msgSend(objc.Object, "URLWithString:", .{urlString});
    std.log.info("NSURL created: {}", .{nsUrl});
    return nsUrl;
    // const NSURL = objc.getClass("NSURL").?;
    // const urlString = createNSString(string);
    // return NSURL.msgSend(objc.Object, "URLWithString:", .{urlString});
}
