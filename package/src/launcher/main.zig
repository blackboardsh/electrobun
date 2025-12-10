const std = @import("std");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("unistd.h");
});

var child_pid: std.process.Child.Id = undefined;
var should_exit: bool = false;

// Signal handler that forwards signals to child process
fn signalHandler(sig: c_int) callconv(.C) void {
    std.debug.print("Launcher received signal {d}, forwarding to child PID {d}\n", .{sig, child_pid});
    
    // Forward the signal to the child process
    const result = c.kill(@intCast(child_pid), sig);
    if (result == 0) {
        std.debug.print("Signal {d} forwarded successfully\n", .{sig});
    } else {
        std.debug.print("Failed to forward signal {d}, kill returned: {d}\n", .{sig, result});
    }
    
    // Set exit flag for certain signals
    if (sig == c.SIGINT or sig == c.SIGTERM) {
        should_exit = true;
    }
}

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var exePathBuffer: [1024]u8 = undefined;
    const APPBUNDLE_MACOS_PATH = try std.fs.selfExeDirPath(exePathBuffer[0..]);

    std.debug.print("Launcher starting...\n", .{});
    std.debug.print("Current directory: {s}\n", .{APPBUNDLE_MACOS_PATH});

    // Set up signal handlers
    _ = c.signal(c.SIGINT, signalHandler);
    _ = c.signal(c.SIGTERM, signalHandler);
    _ = c.signal(c.SIGHUP, signalHandler);

    // Create an instance of ChildProcess
    const argv = &[_][]const u8{ "./bun", "../Resources/main.js" };
    var child_process = std.process.Child.init(argv, alloc);

    child_process.cwd = APPBUNDLE_MACOS_PATH;
    // Inherit stdout/stderr so we can see any errors
    child_process.stdout_behavior = .Inherit;
    child_process.stderr_behavior = .Inherit;
    
    std.debug.print("Spawning: {s} {s}\n", .{argv[0], argv[1]});

    // Spawn the child process
    try child_process.spawn();
    child_pid = child_process.id;
    
    std.debug.print("Child process spawned with PID {d}\n", .{child_pid});

    // Wait for the subprocess to complete
    const result = child_process.wait() catch |err| {
        std.debug.print("Failed to wait for child process: {}\n", .{err});
        return;
    };
    
    switch (result) {
        .Exited => |code| {
            std.debug.print("Child process exited with code: {d}\n", .{code});
            if (code != 0) {
                std.process.exit(@intCast(code));
            }
        },
        .Signal => |sig| {
            std.debug.print("Child process terminated by signal: {d}\n", .{sig});
            std.process.exit(128 + @as(u8, @intCast(sig)));
        },
        else => {
            std.debug.print("Child process terminated unexpectedly\n", .{});
            std.process.exit(1);
        },
    }
}
