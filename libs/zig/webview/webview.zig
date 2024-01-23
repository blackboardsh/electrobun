const std = @import("std");
const objc = @import("zig-objc/src/main.zig");

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

    // open a window
    // Get the NSWindow class
    const nsWindowClass = objc.getClass("NSWindow") orelse {
        std.debug.print("Failed to get NSWindow class\n", .{});
        return;
    };

    // Allocate the NSWindow instance
    const windowAlloc = nsWindowClass.msgSend(objc.Object, "alloc", .{});

    // Define the frame rectangle (x, y, width, height)
    const frame = CGRect{ .origin = CGPoint{ .x = 1000, .y = 100 }, .size = CGSize{ .width = 800, .height = 600 } };

    // Define the window style mask (e.g., titled, closable, resizable)
    const styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;

    // Define the backing store type
    const backing = NSBackingStoreBuffered;

    // Define whether to defer creation
    const defers = false;

    // Initialize the NSWindow instance
    const window = windowAlloc.msgSend(objc.Object, "initWithContentRect:styleMask:backing:defer:", .{ frame, styleMask, backing, defers });

    std.debug.print("------window {}\n", .{window});

    // Display the window
    window.msgSend(void, "makeKeyAndOrderFront:", .{});

    // run the event loop
    const nsApplicationClass = objc.getClass("NSApplication") orelse {
        std.debug.print("Failed to get NSApplication class\n", .{});
        return;
    };
    const app = nsApplicationClass.msgSend(objc.Object, "sharedApplication", .{});

    // Run the application event loop
    app.msgSend(void, "run", .{});
}
