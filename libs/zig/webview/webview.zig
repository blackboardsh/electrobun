const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");
// const c = @import("../zig-objc/src/c.zig");
const system = std.c;

// const xp = @import("xPromise.zig");
const rpc = @import("rpc.zig");

// timer reference
// const startTime = std.time.nanoTimestamp();
// // code
// const endTime = std.time.nanoTimestamp();
// const duration = endTime - startTime;
// std.debug.print("Time taken: {} ns\n", .{duration});

// // needed to access grand central dispatch to dispatch things from
// // other threads to the main thread
// const dispatch = @cImport({
//     @cInclude("dispatch/dispatch.h");
// });

const alloc = std.heap.page_allocator;

// const CGPoint = extern struct {
//     x: f64,
//     y: f64,
// };

// const CGSize = extern struct {
//     width: f64,
//     height: f64,
// };

// const CGRect = extern struct {
//     origin: CGPoint,
//     size: CGSize,
// };

// const NSWindowStyleMaskTitled = 1 << 0;
// const NSWindowStyleMaskClosable = 1 << 1;
// const NSWindowStyleMaskResizable = 1 << 3;

// const NSBackingStoreBuffered = 2;

// const WKNavigationResponsePolicyAllow = 1;

// const WKNavigationResponsePolicy = enum(c_int) {
//     cancel = 0,
//     allow = 1,
//     download = 2,
// };

pub const TitleContext = struct {
    title: []const u8,
};

pub const WindowContext = struct {
    id: u32,
};

pub fn main() !void {
    std.log.info("main starting", .{});
    try rpc.init();
    std.log.info("rpc initialized", .{}); // never gets here
    startAppkitGuiEventLoop();
}

const MessageType = enum {
    setTitle,
    createWindow,
    decideNavigation,
    // Add other types as needed
};

const MessageFromBun = struct {
    type: MessageType,
    phase: u32,
    payload: std.json.Value,
};

// const SetTitlePayload = struct {
//     winId: u32,
//     title: []const u8,
// };

// const CreateWindowPayload = struct { id: u32, url: ?[]const u8, html: ?[]const u8, title: []const u8, width: f64, height: f64, x: f64, y: f64 };

const decideNavigationPayload = struct {
    allow: bool,
};

// const WindowType = struct {
//     id: u32,
//     window: ?objc.Object,
//     webview: ?objc.Object,

//     title: []const u8,
//     url: ?[]const u8,
//     html: ?[]const u8,
//     width: f64,
//     height: f64,
//     x: f64,
//     y: f64,
// };

// NOTE: These type must be kept in sync with typescript version
// const xPromiseDecideNavigation = struct {
//     type: xPromiseMessageType.decideNavigation,
//     phases: struct {
//         request: struct { // request payload
//             promiseId: u32,
//             url: []const u8,
//         },
//         response: struct { // response payload
//             promiseId: u32,
//             allow: bool,
//         },
//     },
// };

// const xPromiseMessage = struct {
//     type: xPromiseMessageType,
//     phase: xPromiseMessagePhase,
//     payload: std.json.Value,
// };

// // // explicit phase, always use payload
// const xPromiseMessagePhase = enum {
//     request,
//     response,
//     // message = 2,
//     // error = 3,
// };

// const xPromiseMessageType = enum {
//     setTitle,
//     createWindow,
//     decideNavigation,
// };

// const PromiseIdGenerator = struct {
//     nextId: u32,

//     fn init() PromiseIdGenerator {
//         return PromiseIdGenerator{ .nextId = 1 };
//     }

//     fn nextId(self: *PromiseIdGenerator) u32 {
//         const id = self.nextId;
//         self.nextId += 1;
//         return id;
//     }
// };

// // const xp = xPromise.init();

// const DecideNavigation = struct {
//     fn request(self: *xPromise, url: []const u8) void {
//         const payload = struct {
//             promiseId: u32,
//             url: []const u8,
//         }{
//             .promiseId = self.promiseIdGen.nextId(),
//             .url = url,
//         };
//         self.sendRequestToBun(xPromiseMessageType.decideNavigation, payload);
//     }
// };

// const xPromise = struct {
//     promiseIdGen: PromiseIdGenerator,
//     decideNavigation: DecideNavigation,

//     fn init() xPromise {
//         return xPromise{ .promiseIdGen = PromiseIdGenerator.init(), .decideNavigation = DecideNavigation{} };
//     }

//     // fn decideNavigationRequest(self: *xPromise, url: []const u8) void {
//     //     const payload = struct {
//     //         promiseId: u32,
//     //         url: []const u8,
//     //     }{
//     //         .promiseId = self.promiseIdGen.nextId(),
//     //         .url = url,
//     //     };
//     //     self.sendRequestToBun(xPromiseMessageType.decideNavigation, payload);
//     // }

//     // fn decideNavigationResponse(self: *xPromise, allow: bool) void {
//     //     const payload = struct {
//     //         promiseId: u32,
//     //         allow: bool,
//     //     }{
//     //         .promiseId = self.promiseIdGen.nextId(),
//     //         .allow = allow,
//     //     };
//     //     self.sendResponseToBun(xPromiseMessageType.decideNavigation, payload);
//     // }

//     fn sendRequestToBun(self: *xPromise, messageType: xPromiseMessageType, payload: anytype) void {
//         self.sendMessageToBun(messageType, xPromiseMessagePhase.request, payload);
//     }

//     fn sendResponseToBun(self: *xPromise, messageType: xPromiseMessageType, payload: anytype) void {
//         self.sendMessageToBun(messageType, xPromiseMessagePhase.response, payload);
//     }

//     fn sendMessageToBun(_: *xPromise, messageType: xPromiseMessageType, phaseType: xPromiseMessagePhase, payload: anytype) void {
//         // if phaseType === request then add promiseId to the payload, sleep thread, and track it

//         std.json.stringify(.{
//             .type = messageType,
//             .phase = phaseType,
//             .payload = payload,
//         }, .{}, std.io.getStdOut().writer()) catch |err| {
//             std.debug.print("Failed to stringify message: {}\n", .{err});
//             return;
//         };
//     }
// };

// fn getPayloadType(messageType: xPromiseMessageType, phase: xPromiseMessagePhase) type {
//     return switch (messageType) {
//         // .setTitle => todo,
//         // .createWindow => todo
//         .decideNavigation => switch (phase) {
//             .request => struct { // request payload
//                 promiseId: u32,
//                 url: []const u8,
//             },
//             .response => struct { // response payload
//                 promiseId: u32,
//                 allow: bool,
//             },
//         },
//     };
// }

// fn getPayloadType(comptime messageType: xPromiseMessageType, comptime phase: xPromiseMessagePhase) type {
//     _ = switch (messageType) {
//         .setTitle => xPromiseSetTitle,
//         // .createWindow => xPromiseCreateWindow, // Assuming xPromiseCreateWindow is defined
//         .decideNavigation => xPromiseDecideNavigation, // Assuming xPromiseDecideNavigation is defined
//     };

//     const payloadType = switch (phase) {
//         xPromiseMessagePhase.request => testPayload,
//         xPromiseMessagePhase.response => testPayload,
//     };

//     return payloadType;
// }

// const xPromiseSetTitle = struct {
//     type: xPromiseMessageType.setTitle,
//     phases: struct {
//         request: struct { // request payload
//             promiseId: u32,
//             winId: u32,
//             title: []const u8,
//         },
//         response: struct { // response payload
//             promiseId: u32,
//             success: bool,
//         },
//     },
// };

// todo: create event mapping types in zig and typescript
// fn sendMessageToBun(message: []const u8) void {
//     const stdout = std.io.getStdOut().writer();

//     // Write the message to stdout
//     _ = stdout.writeAll(message) catch {
//         // Handle potential errors here
//         std.debug.print("Failed to write to stdout\n", .{});
//     };
// }

// fn sendMessageToBun(messageType: xPromiseMessageType, phaseType: xPromiseMessagePhase, payload: anytype) void {
//     var out = std.ArrayList(u8).init(alloc);
//     defer out.deinit();
//     std.json.stringify(payload, .{}, out.writer()) catch |err| {
//         std.debug.print("Failed to stringify message: {}\n", .{err});
//         return;
//     };
//     const stringifiedPayload = out.items;

//     std.log.info("stringifiedPayload {s}", .{stringifiedPayload});

//     std.json.stringify(.{
//         .type = messageType,
//         .phase = phaseType,
//         .payload = payload,
//     }, .{}, std.io.getStdOut().writer()) catch |err| {
//         std.debug.print("Failed to stringify message: {}\n", .{err});
//         return;
//     };
// }

// fn sendRequestToBun(messageType: xPromiseMessageType, payload: anytype) void {
//     sendMessageToBun(messageType, xPromiseMessagePhase.request, payload);
// }

// fn sendResponseToBun(messageType: xPromiseMessageType, payload: anytype) void {
//     sendMessageToBun(messageType, xPromiseMessagePhase.response, payload);
// }

//

// var jobQueue = std.ArrayList([]const u8).init(alloc);
// defer jobQueue.deinit();

// const WindowMap = std.HashMap(u32, WindowType, std.hash_map.DefaultHashFn(u32));
// const WindowMap = std.AutoHashMap(u32, WindowType);
// var windowMap: WindowMap = WindowMap.init(alloc);

// fn proccessJobQueue(context: ?*anyopaque) callconv(.C) void {
//     _ = context;
//     // std.log.info("jobqueue items main length {}", .{jobQueue.items.len});

//     const line = jobQueue.orderedRemove(0);
//     defer alloc.free(line);

//     std.log.info("parsed line {s}", .{line});

//     // Do the main json parsing work on the stdin thread, add it to a queue, and then
//     // process the generic jobs on the main thread
//     const messageFromBun = std.json.parseFromSlice(xp.xPromiseMessage, alloc, line, .{}) catch |err| {
//         std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
//         return;
//     };

//     defer messageFromBun.deinit();

//     std.log.info("parsed line {}", .{messageFromBun.value.type});

//     // Handle the message based on its type
//     switch (messageFromBun.value.type) {
//         .setTitle => {
//             // todo: do we need parseFromValue here? can we just cast the payload to a type?
//             const parsedPayload = std.json.parseFromValue(SetTitlePayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
//                 std.log.info("Error casting parsed json to zig type from stdin setTitle - {}: \n", .{err});
//                 return;
//             };
//             defer parsedPayload.deinit();

//             const payload = parsedPayload.value;

//             setTitle(payload);
//         },
//         .createWindow => {
//             const parsedPayload = std.json.parseFromValue(CreateWindowPayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
//                 std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
//                 return;
//             };
//             defer parsedPayload.deinit();

//             const payload = parsedPayload.value;
//             const objcWindow = createWindow(payload);

//             std.log.info("parsed type {}: \nreceived: ", .{payload.id});

//             const _window = WindowType{ .id = payload.id, .title = payload.title, .url = payload.url, .html = payload.html, .width = payload.width, .height = payload.height, .x = payload.x, .y = payload.y, .window = objcWindow, .webview = undefined };

//             windowMap.put(payload.id, _window) catch {
//                 std.log.info("Error putting window into hashmap: \nreceived: {}", .{messageFromBun.value.type});
//                 return;
//             };

//             std.log.info("hashmap size{}", .{windowMap.count()});
//         },

//         else => {
//             std.log.info("Error: Unhandled event type on main thread", .{});
//         },

//         // Handle other types
//     }
// }

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

// todo: wrap in struct for each blocking response
var _waitingForResponse = false;
var _response = false;
var m = std.Thread.Mutex{};
var c = std.Thread.Condition{};

// pub fn createWindow(opts: CreateWindowPayload) objc.Object {
//     const pool = objc.AutoreleasePool.init();
//     defer pool.deinit();

//     // open a window
//     const nsWindowClass = objc.getClass("NSWindow").?;
//     const windowAlloc = nsWindowClass.msgSend(objc.Object, "alloc", .{});

//     // Pointer Note: if using manual memory management then the memory will need to be cleaned up using `release` method
//     // windowAlloc.msgSend(void, "release", .{});

//     // Define the frame rectangle (x, y, width, height)
//     const frame = CGRect{ .origin = CGPoint{ .x = opts.x, .y = opts.y }, .size = CGSize{ .width = opts.width, .height = opts.height } };

//     // Define the window style mask (e.g., titled, closable, resizable)
//     const styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;

//     // Define the backing store type
//     const backing = NSBackingStoreBuffered;

//     // Define whether to defer creation
//     const defers = true;

//     // Initialize the NSWindow instance
//     const _window = windowAlloc.msgSend(objc.Object, "initWithContentRect:styleMask:backing:defer:", .{ frame, styleMask, backing, defers });

//     // You have to initialize obj-c string and then pass a pointer to it
//     const titleString = createNSString(opts.title);
//     _window.msgSend(void, "setTitle:", .{titleString});

//     // Get the content view of the window
//     const contentView = _window.msgSend(objc.Object, "contentView", .{});

//     // Get the bounds of the content view
//     const windowBounds: CGRect = contentView.msgSend(CGRect, "bounds", .{});

//     const wkWebviewClass = objc.getClass("WKWebView").?;
//     const webkitAlloc = wkWebviewClass.msgSend(objc.Object, "alloc", .{});
//     const windowWebview = webkitAlloc.msgSend(objc.Object, "initWithFrame:", .{windowBounds});
//     _window.msgSend(void, "setContentView:", .{windowWebview});

//     // fn proccessJobQueue(context: ?*anyopaque) callconv(.C) void {
//     const MyNavigationDelegate = setup: {
//         const MyNavigationDelegate = objc.allocateClassPair(objc.getClass("NSObject").?, "my_navigation_delegate").?;

//         std.log.info("MyNavigationDelegate class allocated successfully", .{});

//         // defer objc.registerClassPair(MyNavigationDelegate);

//         // go implemetation
//         //         func (ad *cocoaDefaultDelegateClassWrapper) handleWebViewDecidePolicyForNavigationActionDecisionHandler(delegate objc.Object, webview objc.Object, navigation objc.Object, decisionHandler objc.Object) {
//         // 	reqURL := mdCore.NSURLRequest_fromRef(navigation.Send("request")).URL()
//         // 	destinationHost := reqURL.Host().String()
//         // 	var decisionPolicy int
//         // 	if appURL.Hostname() != destinationHost {
//         // 		decisionPolicy = NavigationActionPolicyCancel
//         // 		openURL(reqURL.String())
//         // 	}
//         // 	completionHandler.Send("decisionHandler:withPolicy:", decisionHandler, decisionPolicy)
//         // }

//         std.debug.assert(try MyNavigationDelegate.addMethod("webView:decidePolicyForNavigationAction:decisionHandler:", struct {
//             fn imp(target: objc.c.id, sel: objc.c.SEL, webView: *anyopaque, navigationAction: *anyopaque, decisionHandler: *anyopaque) callconv(.C) void {
//                 // Note:
//                 // target = a reference to the object who's method is being called, so in this case it's the NavigationDelegate
//                 // sel (objc selector) basically the name of the method on the target. in js it's like `target[sel]()`
//                 // in this case it's thiswebviewinstance:decidePolicyForNavigationAction:decisionHandler:
//                 // webView = the WKWebview that's calling the method
//                 _ = target;
//                 _ = sel;
//                 _ = webView;

//                 std.log.info("----> navigationg thingy running ", .{});

//                 // To compile this dylib, in the repo root run:
//                 // clang -dynamiclib -o ./libs/objc/libDecisionWrapper.dylib ./libs/objc/DecisionHandlerWrapper.m -framework WebKit -framework Cocoa -fobjc-arc
//                 const dylib_path = "./libs/objc/libDecisionWrapper.dylib";
//                 const RTLD_NOW = 0x2;
//                 const handle = system.dlopen(dylib_path, RTLD_NOW);
//                 if (handle == null) {
//                     std.debug.print("Failed to load library: {s}\n", .{dylib_path});
//                     return;
//                 }

//                 const getUrlFromNavigationAction = system.dlsym(handle, "getUrlFromNavigationAction");
//                 if (getUrlFromNavigationAction == null) {
//                     std.debug.print("Failed to load symbol: getUrlFromNavigationAction\n", .{});
//                     // system.dlclose(handle);
//                     return;
//                 }

//                 // Define the function pointer type
//                 // Note: [*:0]const u8 is a null terminated c-style string that obj returns
//                 const getUrlFromNavigationActionFunc = fn (*anyopaque) callconv(.C) [*:0]const u8;

//                 // Cast the function pointer to the appropriate type
//                 const getUrlFromNavigationActionWrapper = @as(*const getUrlFromNavigationActionFunc, @alignCast(@ptrCast(getUrlFromNavigationAction)));

//                 // Call the function
//                 const url_cstr = getUrlFromNavigationActionWrapper(navigationAction);
//                 // Note: this is needed to convert the c-style string to a zig string
//                 const url_str = std.mem.span(url_cstr);

//                 std.log.info("----> navigating to URL: {s}", .{url_str});

//                 // Suppose 'someFunction' is a function in your dylib you want to call
//                 const invokeDecisionHandler = system.dlsym(handle, "invokeDecisionHandler");
//                 if (invokeDecisionHandler == null) {
//                     std.debug.print("Failed to load symbol: invokeDecisionHandler\n", .{});
//                     // system.dlclose(handle);
//                     return;
//                 }

//                 // Cast the function pointer to the appropriate type
//                 const decisionHandlerWrapper: *const fn (*anyopaque, WKNavigationResponsePolicy) callconv(.C) *void = @alignCast(@ptrCast(invokeDecisionHandler));

//                 // timer reference
//                 const startTime = std.time.nanoTimestamp();

//                 // wrap this in xPromise functions
//                 // const payload = .{
//                 //     // const payload: testPayload = .{
//                 //     // make this auto incremenet
//                 //     .promiseId = 1,
//                 //     .wow = url_str,
//                 // };

//                 // sendRequestToBun(xPromiseMessageType.decideNavigation, payload);

//                 // xPromise.decideNavigationRequest(url_str);

//                 rpc.request.decideNavigation.request(url_str);

//                 m.lock();
//                 defer m.unlock();

//                 _waitingForResponse = true;

//                 while (_waitingForResponse) {
//                     c.wait(&m);
//                 }

//                 const endTime = std.time.nanoTimestamp();
//                 const duration = endTime - startTime;
//                 std.debug.print("Time taken: {} ns\n", .{@divTrunc(duration, std.time.ns_per_ms)});

//                 var policyResponse: WKNavigationResponsePolicy = undefined;

//                 if (_response == true) {
//                     policyResponse = WKNavigationResponsePolicy.allow;
//                 } else {
//                     policyResponse = WKNavigationResponsePolicy.cancel;
//                 }

//                 // Call the function
//                 _ = decisionHandlerWrapper(decisionHandler, policyResponse);

//                 // Close the library
//                 // system.dlclose(handle);
//             }
//         }.imp));

//         break :setup MyNavigationDelegate;
//     };

//     // Use your custom delegate
//     const myDelegate = MyNavigationDelegate.msgSend(objc.Object, "alloc", .{}).msgSend(objc.Object, "init", .{});
//     windowWebview.msgSend(void, "setNavigationDelegate:", .{myDelegate});

//     // works, basic zig example creating an obj c block that references zig code
//     // const AddBlock = objc.Block(struct {
//     //     x: i32,
//     //     y: i32,
//     // }, .{}, i32);

//     // const captures: AddBlock.Captures = .{
//     //     .x = 2,
//     //     .y = 3,
//     // };

//     // var block = AddBlock.init(captures, (struct {
//     //     fn addFn(block: *const AddBlock.Context) callconv(.C) i32 {
//     //         std.log.info("----> addFn running", .{});
//     //         return block.x + block.y;
//     //     }
//     // }).addFn) catch null;
//     // defer if (block != null) block.?.deinit();

//     // if (block) |_block| {
//     //     _ = _block.invoke(.{});
//     // }

//     // load url
//     if (opts.url) |url| {
//         // Note: we pass responsibility to objc to free the memory
//         const urlCopy = alloc.dupe(u8, url) catch {
//             unreachable;
//         };
//         // std.log.info("creating url window: {s}", .{url});
//         const request = objc.getClass("NSURLRequest").?.msgSend(objc.Object, "requestWithURL:", .{createNSURL(urlCopy)});
//         windowWebview.msgSend(void, "loadRequest:", .{request});
//     } else if (opts.html) |html| {
//         const htmlCopy = alloc.dupe(u8, html) catch {
//             unreachable;
//         };
//         std.log.info("creating html window: {s}", .{html});
//         // const NSHtmlString = createNSString(html);
//         windowWebview.msgSend(void, "loadHTMLString:baseURL:", .{ createNSString(htmlCopy), createNSURL("file://") });
//     }

//     // Display the window
//     _window.msgSend(void, "makeKeyAndOrderFront:", .{});

//     return _window;
// }

// fn createNSString(string: []const u8) objc.Object {
//     const NSString = objc.getClass("NSString").?;
//     return NSString.msgSend(objc.Object, "stringWithUTF8String:", .{string});
// }

// fn createNSURL(string: []const u8) objc.Object {
//     const NSURL = objc.getClass("NSURL").?;
//     std.log.info("Creating NSURL with string: {s}", .{string});
//     const urlString = createNSString(string);
//     const nsUrl = NSURL.msgSend(objc.Object, "URLWithString:", .{urlString});
//     std.log.info("NSURL created: {}", .{nsUrl});
//     return nsUrl;
//     // const NSURL = objc.getClass("NSURL").?;
//     // const urlString = createNSString(string);
//     // return NSURL.msgSend(objc.Object, "URLWithString:", .{urlString});
// }
