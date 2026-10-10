const std = @import("std");

var count = std.atomic.Value(u32).init(0);
fn countTask() void {
    _ = count.fetchAdd(1, .monotonic);
}

test "Threaded workers shut down" {
    var threaded: std.Io.Threaded = .init(std.testing.allocator, .{});
    const io = threaded.io();
    var group: std.Io.Group = .init;
    for (0..4) |_| try group.concurrent(io, countTask, .{});
    try group.await(io);
    try std.testing.expectEqual(@as(u32, 4), count.load(.acquire));
    // Retain the last completed phase if the parent's watchdog fires.
    std.debug.print("workers completed; shutting down\n", .{});
    threaded.deinit();
    std.debug.print("completed startup/shutdown cycle\n", .{});
}
