const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");

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

pub fn main() void {
    const window = createWindow();
    const window2 = createWindow();
    std.debug.print("------window {}{}\n", .{ window, window2 });
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
    const window = windowAlloc.msgSend(objc.Object, "initWithContentRect:styleMask:backing:defer:", .{ frame, styleMask, backing, defers });

    // You have to initialize obj-c string and then pass a pointer to it
    const titleString = createNSString("Bun WebView");
    window.msgSend(void, "setTitle:", .{titleString});

    // Get the content view of the window
    const contentView = window.msgSend(objc.Object, "contentView", .{});

    // Get the bounds of the content view
    const windowBounds: CGRect = contentView.msgSend(CGRect, "bounds", .{});

    const wkWebviewClass = objc.getClass("WKWebView").?;
    const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});
    const webView = webkitAlloc.msgSend(objc.Object, "initWithFrame:", .{windowBounds});
    window.msgSend(void, "setContentView:", .{webView});

    const url = createNSURL("https://www.google.com");
    const request = objc.getClass("NSURLRequest").?.msgSend(objc.Object, "requestWithURL:", .{url});
    webView.msgSend(void, "loadRequest:", .{request});

    // Display the window
    window.msgSend(void, "makeKeyAndOrderFront:", .{});

    return window;
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
