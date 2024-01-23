const std = @import("std");
const Class = @import("zig-objc/src/class.zig");
const objc = @import("zig-objc/src/main.zig");

pub fn main() void {
    // std.debug.print("NSProcessInfo: {}\n", .{objc.getClass("NSProcessInfo").?});

    // Get the objc class from the runtime
    const NSProcessInfo = objc.getClass("NSObject").?;

    std.debug.print("NSProcessInfo: {}\n", .{NSProcessInfo});

    // Call a class method with no arguments that returns another objc object.
    const info = NSProcessInfo.msgSend(objc.Object, "processInfo", .{});
    // const info = NSProcessInfo.getProperty("processInfo").?;

    std.debug.print("info: {}\n", .{info});
}

// This extern struct matches the Cocoa headers for layout.
const NSOperatingSystemVersion = extern struct {
    major: i64,
    minor: i64,
    patch: i64,
};

// const std = @import("std");
// const objc = @import("zig-objc/src/msg_send.zig");
// const Class = @import("zig-objc/src/class.zig");
// const Sel = @import("zig-objc/src/sel.zig");

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

// pub fn main() void {
//     // Get the NSWindow class
//     const nsWindowClass = Class.getClass("NSWindow") orelse {
//         std.debug.print("Failed to get NSWindow class\n", .{});
//         return;
//     };

//     // Create a selector for the window initialization method
//     const initWithContentRectSelector = Sel.registerName("initWithContentRect:styleMask:backing:defer:");

//     // const initWithContentRectSelector = Sel.registerName("initWithContentRect:styleMask:backing:defer:") orelse {
//     //     std.debug.print("Failed to get selector\n", .{});
//     //     return;
//     // };

//     // Define the frame rectangle (x, y, width, height)
//     const frame = CGRect{ .origin = CGPoint{ .x = 0, .y = 0 }, .size = CGSize{ .width = 800, .height = 600 } };

//     // Define the window style mask (e.g., titled, closable, resizable)
//     const styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;

//     // Define the backing store type
//     const backing = NSBackingStoreBuffered;

//     // Define whether to defer creation
//     const defers = false;

//     // Create the NSWindow instance
//     const window = objc.msg_send(nsWindowClass, initWithContentRectSelector, frame, styleMask, backing, defers) catch {
//         std.debug.print("Failed to create NSWindow instance\n", .{});
//         return;
//     };

//     // Additional configuration for the window...
//     // Create a selector for the makeKeyAndOrderFront method
//     const makeKeyAndOrderFrontSelector = Sel.get("makeKeyAndOrderFront:") orelse {
//         std.debug.print("Failed to get selector\n", .{});
//         return;
//     };

//     // Display the window
//     objc.msg_send(window, makeKeyAndOrderFrontSelector, null);
// }
