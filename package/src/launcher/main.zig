const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("unistd.h");
});

// Windows-specific imports for hiding console
const windows = if (builtin.os.tag == .windows) struct {
    const BOOL = c_int;
    const DWORD = u32;
    const HANDLE = *anyopaque;
    const LPVOID = *anyopaque;
    const LPWSTR = [*:0]u16;
    const LPSTR = [*:0]u8;

    const STARTUPINFOW = extern struct {
        cb: DWORD,
        lpReserved: ?LPWSTR,
        lpDesktop: ?LPWSTR,
        lpTitle: ?LPWSTR,
        dwX: DWORD,
        dwY: DWORD,
        dwXSize: DWORD,
        dwYSize: DWORD,
        dwXCountChars: DWORD,
        dwYCountChars: DWORD,
        dwFillAttribute: DWORD,
        dwFlags: DWORD,
        wShowWindow: u16,
        cbReserved2: u16,
        lpReserved2: ?*u8,
        hStdInput: ?HANDLE,
        hStdOutput: ?HANDLE,
        hStdError: ?HANDLE,
    };

    const PROCESS_INFORMATION = extern struct {
        hProcess: HANDLE,
        hThread: HANDLE,
        dwProcessId: DWORD,
        dwThreadId: DWORD,
    };

    const CREATE_NO_WINDOW: DWORD = 0x08000000;
    const STARTF_USESTDHANDLES: DWORD = 0x00000100;
    const INFINITE: DWORD = 0xFFFFFFFF;

    extern "kernel32" fn CreateProcessW(
        lpApplicationName: ?LPWSTR,
        lpCommandLine: ?LPWSTR,
        lpProcessAttributes: ?*anyopaque,
        lpThreadAttributes: ?*anyopaque,
        bInheritHandles: BOOL,
        dwCreationFlags: DWORD,
        lpEnvironment: ?*anyopaque,
        lpCurrentDirectory: ?LPWSTR,
        lpStartupInfo: *STARTUPINFOW,
        lpProcessInformation: *PROCESS_INFORMATION,
    ) callconv(.C) BOOL;

    extern "kernel32" fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) callconv(.C) DWORD;
    extern "kernel32" fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *DWORD) callconv(.C) BOOL;
    extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.C) BOOL;
} else struct {};

var child_pid: if (builtin.os.tag == .windows) u32 else std.process.Child.Id = undefined;
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
    const exe_dir = try std.fs.selfExeDirPath(exePathBuffer[0..]);

    std.debug.print("Launcher starting on {s}...\n", .{@tagName(builtin.os.tag)});
    std.debug.print("Current directory: {s}\n", .{exe_dir});

    // Set up signal handlers (not on Windows)
    if (builtin.os.tag != .windows) {
        _ = c.signal(c.SIGINT, signalHandler);
        _ = c.signal(c.SIGTERM, signalHandler);
        _ = c.signal(c.SIGHUP, signalHandler);
    }

    // Platform-specific paths
    var argv: []const []const u8 = undefined;
    var resources_path: []u8 = undefined;
    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const arena_alloc = arena.allocator();
    
    switch (builtin.os.tag) {
        .macos => {
            // macOS: launcher is in MacOS/, resources in Resources/
            resources_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "..", "Resources", "main.js" });
            argv = &[_][]const u8{ "./bun", resources_path };
        },
        .linux, .windows => {
            // Linux/Windows: launcher is in bin/, resources in Resources/
            resources_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "..", "Resources", "main.js" });
            const bun_name = if (builtin.os.tag == .windows) "bun.exe" else "bun";
            argv = &[_][]const u8{ try std.fs.path.join(arena_alloc, &.{ exe_dir, bun_name }), resources_path };
        },
        else => @panic("Unsupported platform"),
    }
    
    // Create an instance of ChildProcess
    var child_process = std.process.Child.init(argv, alloc);
    child_process.cwd = exe_dir;

    // Handle platform-specific environment setup
    if (builtin.os.tag == .linux) {
        // Check for CEF libraries that need LD_PRELOAD
        const cef_lib_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "libcef.so" });
        const swiftshader_lib_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "libvk_swiftshader.so" });
        
        var env_map = try std.process.getEnvMap(arena_alloc);
        
        // Set LD_LIBRARY_PATH to include current directory
        if (env_map.get("LD_LIBRARY_PATH")) |existing_ld_path| {
            const new_ld_path = try std.fmt.allocPrint(arena_alloc, "{s}:{s}", .{ exe_dir, existing_ld_path });
            try env_map.put("LD_LIBRARY_PATH", new_ld_path);
        } else {
            try env_map.put("LD_LIBRARY_PATH", exe_dir);
        }
        
        // Check if CEF libraries exist and set LD_PRELOAD if needed
        const cef_exists = blk: {
            std.fs.accessAbsolute(cef_lib_path, .{}) catch {
                break :blk false;
            };
            break :blk true;
        };
        const swiftshader_exists = blk: {
            std.fs.accessAbsolute(swiftshader_lib_path, .{}) catch {
                break :blk false;
            };
            break :blk true;
        };
        
        if (cef_exists or swiftshader_exists) {
            var preload_libs = std.ArrayList([]const u8).init(arena_alloc);
            if (cef_exists) try preload_libs.append("./libcef.so");
            if (swiftshader_exists) try preload_libs.append("./libvk_swiftshader.so");
            
            const ld_preload = try std.mem.join(arena_alloc, ":", preload_libs.items);
            try env_map.put("LD_PRELOAD", ld_preload);
            std.debug.print("Setting LD_PRELOAD: {s}\n", .{ld_preload});
        }

        child_process.env_map = &env_map;
    } else {
        // On Windows and macOS, get environment and inherit it
        var env_map = try std.process.getEnvMap(arena_alloc);
        child_process.env_map = &env_map;
    }

    // On Windows GUI builds, we can't inherit stdout/stderr when launched without a console
    // because there's no console to inherit from. This would cause the child process to crash.
    // Instead, ignore output (it will go to detached console or nowhere).
    if (builtin.os.tag == .windows) {
        // For Windows GUI apps, ignore stdout/stderr to avoid crashes
        child_process.stdout_behavior = .Ignore;
        child_process.stderr_behavior = .Ignore;
    } else {
        // On macOS/Linux, inherit stdout/stderr so we can see any errors
        child_process.stdout_behavior = .Inherit;
        child_process.stderr_behavior = .Inherit;
    }
    
    std.debug.print("Spawning: {s} {s}\n", .{argv[0], if (argv.len > 1) argv[1] else ""});

    // On Windows, use CreateProcessW with CREATE_NO_WINDOW to hide the console
    if (builtin.os.tag == .windows) {
        // Build command line: "path\to\bun.exe" "path\to\main.js"
        const cmd_line = try std.fmt.allocPrintZ(arena_alloc, "\"{s}\" \"{s}\"", .{argv[0], argv[1]});
        const cmd_line_w = try std.unicode.utf8ToUtf16LeWithNull(arena_alloc, cmd_line);

        // Convert working directory to wide string
        const cwd_w = try std.unicode.utf8ToUtf16LeWithNull(arena_alloc, exe_dir);

        var startup_info = std.mem.zeroes(windows.STARTUPINFOW);
        startup_info.cb = @sizeOf(windows.STARTUPINFOW);
        startup_info.dwFlags = windows.STARTF_USESTDHANDLES;
        startup_info.hStdInput = null;
        startup_info.hStdOutput = null;
        startup_info.hStdError = null;

        var process_info: windows.PROCESS_INFORMATION = undefined;

        const result = windows.CreateProcessW(
            null, // lpApplicationName
            @constCast(cmd_line_w.ptr), // lpCommandLine
            null, // lpProcessAttributes
            null, // lpThreadAttributes
            0, // bInheritHandles = false
            windows.CREATE_NO_WINDOW, // dwCreationFlags - this hides the console!
            null, // lpEnvironment
            cwd_w.ptr, // lpCurrentDirectory
            &startup_info,
            &process_info,
        );

        if (result == 0) {
            std.debug.print("Failed to create process\n", .{});
            return error.ProcessSpawnFailed;
        }

        child_pid = process_info.dwProcessId;
        std.debug.print("Child process spawned with PID {d}\n", .{child_pid});

        // Close thread handle as we don't need it
        _ = windows.CloseHandle(process_info.hThread);

        // Wait for process to complete
        _ = windows.WaitForSingleObject(process_info.hProcess, windows.INFINITE);

        // Get exit code
        var exit_code: windows.DWORD = 0;
        _ = windows.GetExitCodeProcess(process_info.hProcess, &exit_code);

        // Close process handle
        _ = windows.CloseHandle(process_info.hProcess);

        std.debug.print("Child process exited with code: {d}\n", .{exit_code});
        if (exit_code != 0) {
            std.process.exit(@intCast(exit_code));
        }
    } else {
        // On macOS/Linux, use standard spawn
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
}
