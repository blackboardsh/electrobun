const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");
const c = @import("../zig-objc/src/c.zig");
// needed to access grand central dispatch to dispatch things from
// other threads to the main thread
const c2 = @cImport({
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

pub fn main() !void {
    var ipcThread = try std.Thread.spawn(.{}, stdInListener, .{});
    defer ipcThread.join();

    window = createWindow();

    startEventLoop();
    std.debug.print("------after event loop {}\n", .{window});
}

fn stdInListener() void {
    const stdin = std.io.getStdIn().reader();
    // Note: this is a zig string
    var buffer: [256]u8 = undefined;

    while (true) {
        const bytesRead = stdin.readUntilDelimiterOrEof(&buffer, '\n') catch break;
        if (bytesRead) |line| {
            std.debug.print("Received from Bun: {s} - {}\n", .{ line, window });

            // Copy the line into a new, null-terminated (C-like) string
            const title = alloc.dupe(u8, line) catch {
                // Handle the error here, e.g., log it or set a default value
                std.debug.print("Error duplicating string: {s}\n", .{line});
                return;
            };

            // var titleContext = TitleContext{ .title = "Bun WebView from thread!!" };
            // Dynamically allocate titleContext on the heap so it lives beyond this while loop iteration
            const titleContext = alloc.create(TitleContext) catch {
                // Handle the error here, e.g., log it or set a default value
                std.debug.print("Error allocating titleContext: \n", .{});
                return;
            };
            titleContext.* = TitleContext{ .title = title };

            // defer alloc.free(titleContext);
            c2.dispatch_async_f(c2.dispatch_get_main_queue(), @as(?*anyopaque, titleContext), setTitleOnMainThread);
        }
    }
}

fn setTitleOnMainThread(context: ?*anyopaque) callconv(.C) void {
    const titleContext = @as(*TitleContext, @ptrCast(@alignCast(context)));
    const titleString = createNSString(titleContext.title);
    alloc.free(titleContext.title);
    const startTime = std.time.nanoTimestamp();
    window.msgSend(void, "setTitle:", .{titleString});
    const endTime = std.time.nanoTimestamp();
    const duration = endTime - startTime;
    std.debug.print("Time taken: {} ns\n", .{duration});

    // Schedule freeing of titleContext and title after a delay
    // to ensure they are not used by the Objective-C runtime
    // This is a simplistic approach and may need refinement
    // std.time.sleep(1 * std.time.ns_per_s); // Example delay of 1 second

    // alloc.free(title);
    // alloc.free(titleContext);
}

// fn setTitleOnMainThread(context: *c_void) void {
//     const titleContext = @as(*TitleContext, @ptrCast(context));
//     std.debug.print("------setTitleOnMainThread {s}\n", .{titleContext.title});
//     const titleString = createNSString(titleContext.title);
//     window.msgSend(void, "setTitle:", .{titleString});
// }

// pub fn initStdio void {
//     const stdin = std.io.getStdIn().reader();
//     var buffer: [256]u8 = undefined;

//     // Read a message from stdin
//     const bytesRead = try stdin.readUntilDelimiterOrEof(&buffer, '\n');
//     if (bytesRead) |line| {
//         std.debug.print("Received from Bun: {}\n", .{line});
//     }

//     // Send a message to stdout
//     const stdout = std.io.getStdOut().writer();
//     try stdout.writeAll("Hello from Zig\n");
// }

pub export fn startEventLoop() void {
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

    const url = createNSURL("https://www.google.com");
    const request = objc.getClass("NSURLRequest").?.msgSend(objc.Object, "requestWithURL:", .{url});
    webView.msgSend(void, "loadRequest:", .{request});

    // Display the window
    _window.msgSend(void, "makeKeyAndOrderFront:", .{});

    // startEventLoop();

    // std.debug.print("------after event loop started {}\n", .{window});

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

// pub fn createWebview() {
//     const pool = objc.AutoreleasePool.init();
//     defer pool.deinit();

//     const wkWebviewClass = objc.getClass("WKWebView").?;
//     const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});

// }

// #import <Cocoa/Cocoa.h>
// #import <WebKit/WebKit.h>

// void createWebView(const char *url) {
//     @autoreleasepool {
//         // Set default URL to Google if none is provided
//         const char *defaultUrl = "https://www.google.com";
//         if (url == NULL || strlen(url) == 0) {
//             url = defaultUrl;
//         }

//         NSApplication *app = [NSApplication sharedApplication];
//         NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 800, 600)
//                                                        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
//                                                          backing:NSBackingStoreBuffered
//                                                            defer:NO];
//         [window cascadeTopLeftFromPoint:NSMakePoint(20,20)];
//         [window setTitle:@"Bun WebView"];
//         [window makeKeyAndOrderFront:nil];

//         WKWebView *webView = [[WKWebView alloc] initWithFrame:[[window contentView] bounds]];
//         [[window contentView] addSubview:webView];
//         NSURL *nsurl = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
//         NSURLRequest *nsrequest = [NSURLRequest requestWithURL:nsurl];
//         [webView loadRequest:nsrequest];

//         [app run];
//     }
// }
