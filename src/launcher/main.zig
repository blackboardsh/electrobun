const std = @import("std");

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var exePathBuffer: [1024]u8 = undefined;
    const APPBUNDLE_MACOS_PATH = try std.fs.selfExeDirPath(exePathBuffer[0..]);

    // TODO XX: you probably need to set the cwd since now we're forking and piping instead of spawning
    // Create an instance of ChildProcess
    const argv = &[_][]const u8{ "./bun", "./main.js" };
    var child_process = std.process.Child.init(argv, alloc);

    child_process.cwd = APPBUNDLE_MACOS_PATH;

    // Wait for the subprocess to complete
    _ = child_process.spawnAndWait() catch |err| {
        std.debug.print("Failed to wait for child process: {}\n", .{err});
        return;
    };
}
