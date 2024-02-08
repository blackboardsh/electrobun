const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");
const rpcSenders = @import("../rpc/schema/senders.zig").senders;
const system = std.c;

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

// todo: use the types in rpc.zig (or move them to a shared location)
const CreateWindowPayload = struct { id: u32, url: ?[]const u8, html: ?[]const u8, title: []const u8, width: f64, height: f64, x: f64, y: f64 };
const SetTitlePayload = struct {
    winId: u32,
    title: []const u8,
};

const WKNavigationResponsePolicy = enum(c_int) {
    cancel = 0,
    allow = 1,
    download = 2,
};

const WindowMap = std.AutoHashMap(u32, WindowType);
var windowMap: WindowMap = WindowMap.init(alloc);

pub fn createWindow(opts: CreateWindowPayload) WindowType {
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // open a window
    const nsWindowClass = objc.getClass("NSWindow").?;
    const windowAlloc = nsWindowClass.msgSend(objc.Object, "alloc", .{});

    // Pointer Note: if using manual memory management then the memory will need to be cleaned up using `release` method
    // but we're using obc.AutoreleasePool so we don't need to do that
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
    const objcWindow = windowAlloc.msgSend(objc.Object, "initWithContentRect:styleMask:backing:defer:", .{ frame, styleMask, backing, defers });

    // You have to initialize obj-c string and then pass a pointer to it
    const titleString = createNSString(opts.title);
    objcWindow.msgSend(void, "setTitle:", .{titleString});

    // Get the content view of the window
    const contentView = objcWindow.msgSend(objc.Object, "contentView", .{});

    // Get the bounds of the content view
    const windowBounds: CGRect = contentView.msgSend(CGRect, "bounds", .{});

    const wkWebviewClass = objc.getClass("WKWebView").?;
    const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});
    const windowWebview = webkitAlloc.msgSend(objc.Object, "initWithFrame:", .{windowBounds});
    objcWindow.msgSend(void, "setContentView:", .{windowWebview});

    const MyNavigationDelegate = setup: {
        const MyNavigationDelegate = objc.allocateClassPair(objc.getClass("NSObject").?, "my_navigation_delegate").?;

        std.log.info("MyNavigationDelegate class allocated successfully", .{});

        std.debug.assert(try MyNavigationDelegate.addMethod("webView:decidePolicyForNavigationAction:decisionHandler:", struct {
            fn imp(target: objc.c.id, sel: objc.c.SEL, webView: *anyopaque, navigationAction: *anyopaque, decisionHandler: *anyopaque) callconv(.C) void {
                // Note:
                // target = a reference to the object who's method is being called, so in this case it's the NavigationDelegate
                // sel (objc selector) basically the name of the method on the target. in js it's like `target[sel]()`
                // in this case it's thiswebviewinstance:decidePolicyForNavigationAction:decisionHandler:
                // webView = the WKWebview that's calling the method
                _ = target;
                _ = sel;
                _ = webView;

                std.log.info("----> navigationg thingy running ", .{});

                // To compile this dylib, in the repo root run:
                // clang -dynamiclib -o ./libs/objc/libDecisionWrapper.dylib ./libs/objc/DecisionHandlerWrapper.m -framework WebKit -framework Cocoa -fobjc-arc
                const dylib_path = "./libs/objc/libDecisionWrapper.dylib";
                const RTLD_NOW = 0x2;
                const handle = system.dlopen(dylib_path, RTLD_NOW);
                if (handle == null) {
                    std.debug.print("Failed to load library: {s}\n", .{dylib_path});
                    return;
                }

                const getUrlFromNavigationAction = system.dlsym(handle, "getUrlFromNavigationAction");
                if (getUrlFromNavigationAction == null) {
                    std.debug.print("Failed to load symbol: getUrlFromNavigationAction\n", .{});
                    // system.dlclose(handle);
                    return;
                }

                // Define the function pointer type
                // Note: [*:0]const u8 is a null terminated c-style string that obj returns
                const getUrlFromNavigationActionFunc = fn (*anyopaque) callconv(.C) [*:0]const u8;

                // Cast the function pointer to the appropriate type
                const getUrlFromNavigationActionWrapper = @as(*const getUrlFromNavigationActionFunc, @alignCast(@ptrCast(getUrlFromNavigationAction)));

                // Call the function
                const url_cstr = getUrlFromNavigationActionWrapper(navigationAction);
                // Note: this is needed to convert the c-style string to a zig string
                const url_str = std.mem.span(url_cstr);

                std.log.info("----> navigating to URL: {s}", .{url_str});

                // Suppose 'someFunction' is a function in your dylib you want to call
                const invokeDecisionHandler = system.dlsym(handle, "invokeDecisionHandler");
                if (invokeDecisionHandler == null) {
                    std.debug.print("Failed to load symbol: invokeDecisionHandler\n", .{});
                    // system.dlclose(handle);
                    return;
                }

                // Cast the function pointer to the appropriate type
                const decisionHandlerWrapper: *const fn (*anyopaque, WKNavigationResponsePolicy) callconv(.C) *void = @alignCast(@ptrCast(invokeDecisionHandler));

                // timer reference
                const startTime = std.time.nanoTimestamp();

                const _response = rpcSenders.decideNavigation(.{
                    .url = url_str,
                });

                std.log.info("response from rpc: {}", .{_response});

                const endTime = std.time.nanoTimestamp();
                const duration = endTime - startTime;
                std.debug.print("Time taken: {} ns\n", .{@divTrunc(duration, std.time.ns_per_ms)});

                var policyResponse: WKNavigationResponsePolicy = undefined;

                if (_response.allow == true) {
                    policyResponse = WKNavigationResponsePolicy.allow;
                } else {
                    policyResponse = WKNavigationResponsePolicy.cancel;
                }

                // Call the function
                _ = decisionHandlerWrapper(decisionHandler, policyResponse);

                // Close the library
                // system.dlclose(handle);
            }
        }.imp));

        break :setup MyNavigationDelegate;
    };

    // Use your custom delegate
    const myDelegate = MyNavigationDelegate.msgSend(objc.Object, "alloc", .{}).msgSend(objc.Object, "init", .{});
    windowWebview.msgSend(void, "setNavigationDelegate:", .{myDelegate});

    // load url
    if (opts.url) |url| {
        // Note: we pass responsibility to objc to free the memory
        const urlCopy = alloc.dupe(u8, url) catch {
            std.log.info("Error copying url", .{});
            unreachable;
        };

        const request = objc.getClass("NSURLRequest").?.msgSend(objc.Object, "requestWithURL:", .{createNSURL(urlCopy)});
        windowWebview.msgSend(void, "loadRequest:", .{request});
    } else if (opts.html) |html| {
        const htmlCopy = alloc.dupe(u8, html) catch {
            std.log.info("Error copying html", .{});
            unreachable;
        };
        std.log.info("creating html window: {s}", .{html});

        windowWebview.msgSend(void, "loadHTMLString:baseURL:", .{ createNSString(htmlCopy), createNSURL("file://") });
    }

    // Display the window
    objcWindow.msgSend(void, "makeKeyAndOrderFront:", .{});

    const _window = WindowType{ .id = opts.id, .title = opts.title, .url = opts.url, .html = opts.html, .width = opts.width, .height = opts.height, .x = opts.x, .y = opts.y, .window = objcWindow, .webview = undefined };

    windowMap.put(opts.id, _window) catch {
        std.log.info("Error putting window into hashmap: ", .{});
        return _window;
    };

    std.log.info("hashmap size{}", .{windowMap.count()});

    return _window;
}

pub fn setTitle(opts: SetTitlePayload) void {
    const win = windowMap.get(opts.winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.winId});
        return;
    };

    if (win.window) |window| {
        const titleString = createNSString(opts.title);
        window.msgSend(void, "setTitle:", .{titleString});
    }
}

// todo: move these to a different file
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
}
