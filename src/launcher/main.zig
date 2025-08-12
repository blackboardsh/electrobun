const std = @import("std");

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var exePathBuffer: [1024]u8 = undefined;
    const APPBUNDLE_MACOS_PATH = try std.fs.selfExeDirPath(exePathBuffer[0..]);

    std.debug.print("Launcher starting...\n", .{});
    std.debug.print("Current directory: {s}\n", .{APPBUNDLE_MACOS_PATH});

    // TODO XX: you probably need to set the cwd since now we're forking and piping instead of spawning
    // Create an instance of ChildProcess
    const argv = &[_][]const u8{ "./bun", "../Resources/main.js" };
    var child_process = std.process.Child.init(argv, alloc);

    child_process.cwd = APPBUNDLE_MACOS_PATH;
    // Inherit stdout/stderr so we can see any errors
    child_process.stdout_behavior = .Inherit;
    child_process.stderr_behavior = .Inherit;
    
    std.debug.print("Spawning: {s} {s}\n", .{argv[0], argv[1]});

    // Wait for the subprocess to complete
    const result = child_process.spawnAndWait() catch |err| {
        std.debug.print("Failed to spawn child process: {}\n", .{err});
        return;
    };
    
    switch (result) {
        .Exited => |code| {
            std.debug.print("Child process exited with code: {d}\n", .{code});
            if (code != 0) {
                std.process.exit(@intCast(code));
            }
        },
        else => {
            std.debug.print("Child process terminated unexpectedly\n", .{});
        },
    }
}
