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
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // open a window
    // Get the NSWindow class
    // Pointer Note: The `nsWindowClass` is a pointer to the `NSWindow` class in obj-c runtime. it will persist beyond
    // this function call and does not need to be cleaned up
    const nsWindowClass = objc.getClass("NSWindow") orelse {
        std.debug.print("Failed to get NSWindow class\n", .{});
        return;
    };

    // Allocate the NSWindow instance
    // Pointer Note: alloc is objective-c method that creates an instance of the window class in memory (allocates it some memory)
    // so the reference increases by 1 in obj-c's reference counting system. obj-c runtime has no way to know about this zig caller
    // so it can't automatically decrement this reference. Some event handler in obj-c runtime could increment/decrement
    // references and it would be responsible for managing those, but it would never get to 0 because the one we have here
    // would exist until we call windowAlloc.msgSend(void, "release", .{}); to decrement the counter.
    // zig-objc comes with autoreleasePoll integration, so it will automatically decrement the reference count when the pool is drained
    // can switch between the two as needed.
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

    std.debug.print("------window {}\n", .{window});

    // Display the window
    window.msgSend(void, "makeKeyAndOrderFront:", .{});

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
