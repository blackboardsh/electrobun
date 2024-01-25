const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");
const c = @import("../zig-objc/src/c.zig");
// needed to access grand central dispatch to dispatch things from
// other threads to the main thread
const c2 = @cImport({
    @cInclude("dispatch/dispatch.h");
});

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
    var buffer: [256]u8 = undefined;

    while (true) {
        const bytesRead = stdin.readUntilDelimiterOrEof(&buffer, '\n') catch break;
        if (bytesRead) |line| {
            std.debug.print("Received from Bun: {s} - {}\n", .{ line, window });

            // const titleString = createNSString("Bun WebView wow");
            // var titleContext = TitleContext{ .title = "Bun WebView wow" };

            // window.msgSend(void, "setTitle:", .{titleString});
            // Make sure that the context you pass to dispatch_async_f is correctly managed. It often involves passing a pointer to some data structure that both the caller and the callback understand.
            // c2.dispatch_async_f(c2.dispatch_get_main_queue(), null, &setTitleOnMainThread);
            // var titleContext = TitleContext{
            //     .title = "Bun WebView wow",
            // };

            // c2.dispatch_async_f(c2.dispatch_get_main_queue(), @as(*c_void, @ptrCast(&titleContext)), setTitleOnMainThread);

            // var titleContext = TitleContext{ .title = "Bun WebView wow" };
            // c2.dispatch_async_f(c2.dispatch_get_main_queue(), @as(*std.c_void, @ptrCast(&titleContext)), setTitleOnMainThread);

            // Process the message and possibly send a response
            // ...
        }
    }
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
