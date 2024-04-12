const std = @import("std");
const rpc = @import("rpc/rpc.zig");
const application = @import("macos/application.zig");

// timer reference
// var startTime = std.time.nanoTimestamp();
// std.debug.print("Time taken: {} ns\n", .{std.time.nanoTimestamp() - startTime});
// startTime = std.time.nanoTimestamp();

const alloc = std.heap.page_allocator;

pub fn main() !void {
    try rpc.init();

    application.startAppkitGuiEventLoop();
}
