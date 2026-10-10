const std = @import("std");

fn countTask(count: *std.atomic.Value(u32)) void {
    _ = count.fetchAdd(1, .monotonic);
}

pub fn main() !void {
    for (0..50) |cycle| {
        var threaded: std.Io.Threaded = .init(std.heap.page_allocator, .{});
        const io = threaded.io();
        var count = std.atomic.Value(u32).init(0);
        var group: std.Io.Group = .init;
        for (0..4) |_| try group.concurrent(io, countTask, .{&count});
        try group.await(io);
        if (count.load(.acquire) != 4) return error.MissingWorker;
        // Retain the last completed work phase if the parent's watchdog fires.
        std.debug.print("cycle {d}: workers completed; shutting down\n", .{cycle});
        threaded.deinit();
    }
    std.debug.print("completed 50 startup/shutdown cycles\n", .{});
}
