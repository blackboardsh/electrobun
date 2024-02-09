const std = @import("std");
const objc = @import("./objc/zig-objc/src/main.zig");

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
