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

var window: objc.Object = undefined;

pub const TitleContext = struct {
    title: []const u8,
};

pub const WindowContext = struct {
    id: u32,
};

pub fn main() !void {
    var ipcThread = try std.Thread.spawn(.{}, stdInListener, .{});
    defer ipcThread.join();

    window = createWindow();

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
    title: []const u8,
};

const CreateWindowPayload = struct { id: u32, url: ?[]const u8, html: ?[]const u8, title: []const u8, width: u16, height: u16, x: u16, y: u16 };

const WindowType = struct {
    id: u32,
    window: ?objc.Object,
    webview: ?objc.Object,

    title: []const u8,
    url: ?[]const u8,
    html: ?[]const u8,
    width: u16,
    height: u16,
    x: u16,
    y: u16,
};

// const WindowMap = std.HashMap(u32, WindowType, std.hash_map.DefaultHashFn(u32));
const WindowMap = std.AutoHashMap(u32, WindowType);
var windowMap: WindowMap = WindowMap.init(alloc);

// We listen on stdin for stuff to do from bun and then dispatch it to the main thread where the gui stuff happens
fn stdInListener() void {
    const stdin = std.io.getStdIn().reader();
    // Note: this is a zig string.
    var buffer: [1024]u8 = undefined;

    while (true) {
        const bytesRead = stdin.readUntilDelimiterOrEof(&buffer, '\n') catch continue;
        if (bytesRead) |line| {
            const messageFromBun = std.json.parseFromSlice(MessageFromBun, alloc, line, .{}) catch |err| {
                std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
                continue;
            };
            defer messageFromBun.deinit();

            // Handle the message based on its type
            switch (messageFromBun.value.type) {
                .setTitle => {
                    const parsedPayload = std.json.parseFromValue(SetTitlePayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
                        std.log.info("Error casting parsed json to zig type from stdin - {}: \nreceived: {s}", .{ err, line });
                        continue;
                    };
                    defer parsedPayload.deinit();

                    const payload = parsedPayload.value;

                    // convert the payload to null-terminated string
                    const title = alloc.dupe(u8, payload.title) catch {
                        // Handle the error here, e.g., log it or set a default value
                        std.debug.print("Error: {s}\n", .{line});
                        return;
                    };

                    // Dynamically allocate titleContext on the heap so it lives beyond this while loop iteration
                    const titleContext = alloc.create(TitleContext) catch {
                        // Handle the error here, e.g., log it or set a default value
                        std.debug.print("Error allocating titleContext: \n", .{});
                        return;
                    };
                    titleContext.* = TitleContext{ .title = title };

                    dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), @as(?*anyopaque, titleContext), setTitleOnMainThread);

                    // Parse the payload for 'exampleType'
                    // ...
                },
                .createWindow => {
                    const parsedPayload = std.json.parseFromValue(CreateWindowPayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
                        switch (err) {
                            error.MissingField => |missingFieldError| {
                                std.log.info("Missing field error: field '{}' is missing in JSON data.\nReceived JSON: {s}", .{ missingFieldError, line });
                            },
                            else => {
                                std.log.info("Error casting parsed json to zig type from stdin\nError type {}: \nreceived: {s}", .{ err, line });
                            },
                        }

                        std.log.info("Error casting parsed json to zig type from stdin\nError type {}: \nreceived: {s}", .{ err, line });
                        continue;
                    };
                    defer parsedPayload.deinit();

                    const payload = parsedPayload.value;

                    std.log.info("parsed type {}: \nreceived: ", .{payload.id});

                    const _window = WindowType{ .id = payload.id, .title = payload.title, .url = payload.url, .html = payload.html, .width = payload.width, .height = payload.height, .x = payload.x, .y = payload.y, .window = undefined, .webview = undefined };

                    windowMap.put(payload.id, _window) catch {
                        std.log.info("Error putting window into hashmap: \nreceived: {}", .{messageFromBun.value.type});
                        continue;
                    };

                    // std.log.info("hashmap size{}", .{windowMap.count()});

                    const windowContext = alloc.create(WindowContext) catch {
                        // Handle the error here, e.g., log it or set a default value
                        std.debug.print("Error allocating windowContext: \n", .{});
                        return;
                    };
                    windowContext.* = WindowContext{ .id = payload.id };

                    dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), @as(?*anyopaque, windowContext), createWindowOnMainThread);
                    // todo:
                    // - create a window struct in a hashmap with the id as the key
                    // - dispatch createWindow to the main thread with a specific id
                    // - that function then pulls the window config, creates the window and saves the window and webview pointer to the hashmap
                },

                // Handle other types
            }

            // const stdout = std.io.getStdOut().writer();

            // const message = "Hello, world!\n";
            // // Write the message to stdout
            // _ = stdout.writeAll(message) catch {
            //     // Handle potential errors here
            //     std.debug.print("Failed to write to stdout\n", .{});
            // };

            // Copy the line into a new, null-terminated (C-like) string
            // you can't create an NSString here because it will be freed
            // when dispatch_async chucks it over to the main thread
            // const title = alloc.dupe(u8, line) catch {
            //     // Handle the error here, e.g., log it or set a default value
            //     std.debug.print("Error duplicating string: {s}\n", .{line});
            //     return;
            // };

            // // Dynamically allocate titleContext on the heap so it lives beyond this while loop iteration
            // const titleContext = alloc.create(TitleContext) catch {
            //     // Handle the error here, e.g., log it or set a default value
            //     std.debug.print("Error allocating titleContext: \n", .{});
            //     return;
            // };
            // titleContext.* = TitleContext{ .title = title };

            // dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), @as(?*anyopaque, titleContext), setTitleOnMainThread);
        }
    }
}

fn sendMessageToBun(message: []const u8) void {
    const stdout = std.io.getStdOut().writer();

    // Write the message to stdout
    _ = stdout.writeAll(message) catch {
        // Handle potential errors here
        std.debug.print("Failed to write to stdout\n", .{});
    };
}

fn createWindowOnMainThread(context: ?*anyopaque) callconv(.C) void {
    const windowContext = @as(*WindowContext, @ptrCast(@alignCast(context)));

    const _window = windowMap.get(windowContext.id) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{windowContext.id});
        return;
    };

    std.log.info("hashmap size from main thread {} - window id {}", .{ windowMap.count(), _window.id });

    // createWindow();
}

fn setTitleOnMainThread(context: ?*anyopaque) callconv(.C) void {
    const titleContext = @as(*TitleContext, @ptrCast(@alignCast(context)));
    const titleString = createNSString(titleContext.title);
    alloc.free(titleContext.title);
    window.msgSend(void, "setTitle:", .{titleString});
    alloc.destroy(titleContext);
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

pub fn createWindow() objc.Object {
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // open a window
    const nsWindowClass = objc.getClass("NSWindow").?;
    const windowAlloc = nsWindowClass.msgSend(objc.Object, "alloc", .{});

    // Pointer Note: if using manual memory management then the memory will need to be cleaned up using `release` method
    // windowAlloc.msgSend(void, "release", .{});

    // Define the frame rectangle (x, y, width, height)
    const frame = CGRect{ .origin = CGPoint{ .x = 1000, .y = 100 }, .size = CGSize{ .width = 800, .height = 600 } };

    // Define the window style mask (e.g., titled, closable, resizable)
    const styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;

    // Define the backing store type
    const backing = NSBackingStoreBuffered;

    // Define whether to defer creation
    const defers = true;

    // Initialize the NSWindow instance
    const _window = windowAlloc.msgSend(objc.Object, "initWithContentRect:styleMask:backing:defer:", .{ frame, styleMask, backing, defers });

    // You have to initialize obj-c string and then pass a pointer to it
    const titleString = createNSString("Bun WebView");
    _window.msgSend(void, "setTitle:", .{titleString});

    // Get the content view of the window
    const contentView = _window.msgSend(objc.Object, "contentView", .{});

    // Get the bounds of the content view
    const windowBounds: CGRect = contentView.msgSend(CGRect, "bounds", .{});

    const wkWebviewClass = objc.getClass("WKWebView").?;
    const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});
    const webView = webkitAlloc.msgSend(objc.Object, "initWithFrame:", .{windowBounds});
    _window.msgSend(void, "setContentView:", .{webView});

    // load url
    // const url = createNSURL("https://www.google.com");
    // const request = objc.getClass("NSURLRequest").?.msgSend(objc.Object, "requestWithURL:", .{url});
    // webView.msgSend(void, "loadRequest:", .{request});

    // load local html content
    const htmlString = createNSString("<html><body><h1>Hello World<webview style='width:100px; height:100px;' src='https://google.com'></webview></h1></body></html>");
    webView.msgSend(void, "loadHTMLString:baseURL:", .{ htmlString, createNSURL("file://") });

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
    const urlString = createNSString(string);
    return NSURL.msgSend(objc.Object, "URLWithString:", .{urlString});
}
