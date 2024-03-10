const std = @import("std");
const rpc = @import("rpc/rpc.zig");
const application = @import("macos/application.zig");

// timer reference
// const startTime = std.time.nanoTimestamp();
// // code
// const endTime = std.time.nanoTimestamp();
// const duration = endTime - startTime;
// std.debug.print("Time taken: {} ns\n", .{duration});

const alloc = std.heap.page_allocator;

pub fn main() !void {
    try rpc.init();

    // const sigint = std.os.signals.get(std.os.signals.SIGINT) catch {
    //     std.debug.print("Failed to get SIGINT signal\n", .{});
    //     return;
    // };

    // try sigint.setHandler(SigIntHandler.handle, null, null);

    application.startAppkitGuiEventLoop();
}
