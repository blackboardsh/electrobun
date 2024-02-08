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
    std.log.info("main starting", .{});
    try rpc.init();
    std.log.info("rpc initialized", .{}); // never gets here
    application.startAppkitGuiEventLoop();
}
