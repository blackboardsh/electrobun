const std = @import("std");
const objc = @import("../zig-objc/src/main.zig");
const rpc = @import("rpc.zig");

// timer reference
// const startTime = std.time.nanoTimestamp();
// // code
// const endTime = std.time.nanoTimestamp();
// const duration = endTime - startTime;
// std.debug.print("Time taken: {} ns\n", .{duration});

const alloc = std.heap.page_allocator;

pub fn main() !void {
    std.log.info("main starting", .{});
    try rpc.init();
    std.log.info("rpc initialized", .{}); // never gets here
    startAppkitGuiEventLoop();
}

pub export fn startAppkitGuiEventLoop() void {
    const pool = objc.AutoreleasePool.init();
    defer pool.deinit();

    // run the event loop
    const nsApplicationClass = objc.getClass("NSApplication") orelse {
        std.debug.print("Failed to get NSApplication class\n", .{});
        return;
    };

    const app = nsApplicationClass.msgSend(objc.Object, "sharedApplication", .{});

    // Run the application event loop
    app.msgSend(void, "run", .{});
}
