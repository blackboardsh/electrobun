const std = @import("std");

pub fn main() !void {
    var allocator = std.heap.page_allocator;

    // try get the absolute path to the executable inside the app bundle
    // to set the cwd. Otherwise it's likely to be / or ~/ depending on how the app was launched
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    const cwd = std.fs.path.dirname(args[0]).?;

    // Create an instance of ChildProcess
    const argv = &[_][]const u8{ "./bun", "../Resources/app/bun/index.js" };
    var child_process = std.ChildProcess.init(argv, allocator);

    child_process.cwd = cwd;

    // Wait for the subprocess to complete
    const exit_code = child_process.spawnAndWait() catch |err| {
        std.debug.print("Failed to wait for child process: {}\n", .{err});
        return;
    };

    std.debug.print("Subprocess exited with code: {}\n", .{exit_code});
}
