const std = @import("std");
const objc = @import("./objc/zig-objc/src/main.zig");
const rpc = @import("../rpc/schema/request.zig");
const objcLibImport = @import("./objc/objc.zig");
const pipesin = @import("../rpc/pipesin.zig");
// const objcLib = objcLibImport.objcLib;

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
    window: ?objc.Object,
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
    handle: objc.Object,
    bun_out_pipe: ?anyerror!std.fs.File,
    bun_in_pipe: ?std.fs.File,
    // Function to send a message to Bun
    pub fn sendToBun(self: *WebviewType, message: []const u8) !void {
        if (self.bun_out_pipe) |result| {
            if (result) |file| {
                std.log.info("Opened file successfully", .{});
                // Write the message to the named pipe
                file.writeAll(message) catch |err| {
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

        executeJavaScript(&self.handle, message);
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
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // open a window
    const nsWindowClass = objc.getClass("NSWindow").?;
    const windowAlloc = nsWindowClass.msgSend(objc.Object, "alloc", .{});

    // Pointer Note: if using manual memory management then the memory will need to be cleaned up using `release` method
    // but we're using obc.AutoreleasePool so we don't need to do that
    // windowAlloc.msgSend(void, "release", .{});

    // Define the frame rectangle (x, y, width, height)
    const frame = CGRect{ .origin = CGPoint{ .x = opts.frame.x, .y = opts.frame.y }, .size = CGSize{ .width = opts.frame.width, .height = opts.frame.height } };

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

    // todo: implement WKWebViewConfiguration -> specifically also the userContentController (to create a bridge between zig and js)
    // pass in a new config object
    const configClass = objc.getClass("WKWebViewConfiguration").?;
    const configAlloc = configClass.msgSend(objc.Object, "alloc", .{});
    const configInstance = configAlloc.msgSend(objc.Object, "init", .{});

    const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});
    // https://developer.apple.com/documentation/webkit/wkwebview/1414998-initwithframe?language=objc
    const windowWebview = webkitAlloc.msgSend(objc.Object, "initWithFrame:configuration:", .{ windowBounds, configInstance });

    // get instance's config
    const config = windowWebview.msgSend(objc.Object, "configuration", .{});

    addPreloadScriptToWebViewConfig(&config, ELECTROBUN_BROWSER_API_SCRIPT);
    // addPreloadScriptToWebViewConfig(&config, "window.webkit.messageHandlers.bunBridge.postMessage('Hello from the other side!');");

    // Note: we need the controller from the instance, passing a new one into config when initializing the
    // webview doesn't seem to work
    const userContentController = config.msgSend(objc.Object, "userContentController", .{});

    objcWindow.msgSend(void, "setContentView:", .{windowWebview});

    // defer file.close();
    std.log.info("---> opening file descriptor", .{});

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
        .window = objcWindow,
        .webview = WebviewType{ //
            .handle = windowWebview,
            .bun_out_pipe = bunPipeOutFileResult,
            .bun_in_pipe = bunPipeIn,
        },
    };

    windowMap.put(opts.id, _window) catch {
        std.log.info("Error putting window into hashmap: ", .{});
        return _window;
    };

    // Add a script message handler
    const BunBridgeHandler = setup: {
        const BunBridgeHandler = objc.allocateClassPair(objc.getClass("NSObject").?, "bunBridgeHandler").?;

        std.debug.assert(try BunBridgeHandler.addMethod("userContentController:didReceiveScriptMessage:", struct {
            fn imp(target: objc.c.id, sel: objc.c.SEL, _userContentController: *anyopaque, message: *anyopaque) callconv(.C) void {
                _ = sel;
                _ = _userContentController;

                const body_cstr = objcLibImport.getBodyFromScriptMessage(message);
                const body_str = std.mem.span(body_cstr);

                std.log.info("Received script message: {s}", .{body_str});

                const _BunBridgeHandler = objc.Object.fromId(target);
                const windowIdIvar = _BunBridgeHandler.getInstanceVariable("windowId");
                const windowId = windowIdIvar.getProperty(c_uint, "unsignedIntValue");

                var win = windowMap.get(windowId) orelse {
                    std.debug.print("Failed to get window from hashmap for id {}\n", .{windowId});
                    return;
                };

                win.webview.sendToBun(body_str) catch |err| {
                    std.debug.print("Failed to send message to bun: {}\n", .{err});
                };
            }
        }.imp));

        _ = BunBridgeHandler.addIvar("windowId");

        break :setup BunBridgeHandler;
    };

    var win = windowMap.get(opts.id) orelse {
        // std.debug.print("Failed to get window from hashmap for id {d}\n", .{opts.id});
        return _window;
    };

    win.webview.sendToBun("<><><<<><>< wowowowow yay! body_str") catch |err| {
        std.debug.print("Failed to send message to bun: {}\n", .{err});
    };

    const bunBridgeHandler: objc.Object = .{ .value = BunBridgeHandler.msgSend(objc.Object, "alloc", .{}).msgSend(objc.Object, "init", .{}).value };

    bunBridgeHandler.setInstanceVariable("windowId", createNSNumber(opts.id)); //opts.id);
    // const bunBridgeHandler = BunBridgeHandler.msgSend(objc.Object, "alloc", .{}).msgSend(objc.Object, "init", .{});

    // todo: also implement addScriptMessageHandler with reply (https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply?language=objc)
    userContentController.msgSend(void, "addScriptMessageHandler:name:", .{ bunBridgeHandler, createNSString("bunBridge") });

    //

    // WKWebViewConfiguration

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

                // Call the function
                const url_cstr = objcLibImport.getUrlFromNavigationAction(navigationAction);
                // Note: this is needed to convert the c-style string to a zig string
                const url_str = std.mem.span(url_cstr);

                std.log.info("----> navigating to URL: {s}", .{url_str});

                // timer reference
                const startTime = std.time.nanoTimestamp();

                const _response = rpc.request.decideNavigation(.{
                    .url = url_str,
                });

                std.log.info("response from rpc: {}", .{_response});

                const endTime = std.time.nanoTimestamp();
                const duration = endTime - startTime;
                std.debug.print("Time taken: {} ns\n", .{@divTrunc(duration, std.time.ns_per_ms)});

                var policyResponse: objcLibImport.WKNavigationResponsePolicy = undefined;

                if (_response.allow == true) {
                    policyResponse = objcLibImport.WKNavigationResponsePolicy.allow;
                } else {
                    policyResponse = objcLibImport.WKNavigationResponsePolicy.cancel;
                }

                // Call the objc callback function
                objcLibImport.invokeDecisionHandler(decisionHandler, policyResponse);
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

    std.log.info("hashmap size{}", .{windowMap.count()});

    return _window;
}

pub fn setTitle(opts: SetTitleOpts) void {
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

fn executeJavaScript(webview: *objc.Object, jsCode: []const u8) void {
    // std.log.info("Executing JavaScript: {s}", .{jsCode});
    // // Note: this works (passing weview pointer and nullTerminatedJsCode to objc function)
    const nullTerminatedJsCode = sliceToNullTerminated(jsCode);

    objcLibImport.evaluateJavaScriptWithNoCompletion(webview.value, nullTerminatedJsCode);

    // Note: this works, passing null terminated nsstring and nil to msgSend
    // const nullTerminatedJsCode = sliceToNullTerminated(jsCode);
    // const jsString = createNSStringFromNullTerminatedString(nullTerminatedJsCode);
    // const _objcLib = objcLib();
    // const nil = _objcLib.getNilValue();
    // webview.msgSend(void, "evaluateJavaScript:completionHandler:", .{ jsString, nil });
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

fn sliceToNullTerminated(input: []const u8) [*:0]const u8 {
    var buffer: [*:0]u8 = undefined; // Initially undefined

    // Attempt to allocate memory, handle error without bubbling it up
    const allocResult = alloc.alloc(u8, input.len + 1) catch {
        return "console.error('failed to allocate string');";
    };

    std.mem.copy(u8, allocResult, input); // Copy input to the allocated buffer
    allocResult[input.len] = 0; // Null-terminate
    buffer = allocResult[0..input.len :0]; // Correctly typed slice with null terminator

    return buffer;
}
