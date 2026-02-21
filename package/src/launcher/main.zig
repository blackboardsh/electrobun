const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
});

var child_pid: std.process.Child.Id = undefined;
var should_exit: bool = false;
var sigint_count: u32 = 0;

// Windows-specific imports for production builds (GUI subsystem with hidden console)
const windows_imports = if (builtin.os.tag == .windows) struct {
    const win = std.os.windows;
    const BOOL = win.BOOL;
    const DWORD = win.DWORD;
    const HANDLE = win.HANDLE;
    const HWND = win.HWND;
    const LPWSTR = win.LPWSTR;
    const LPVOID = win.LPVOID;

    const PROCESS_INFORMATION = extern struct {
        hProcess: HANDLE,
        hThread: HANDLE,
        dwProcessId: DWORD,
        dwThreadId: DWORD,
    };

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
        wShowWindow: win.WORD,
        cbReserved2: win.WORD,
        lpReserved2: ?*u8,
        hStdInput: ?HANDLE,
        hStdOutput: ?HANDLE,
        hStdError: ?HANDLE,
    };

    extern "kernel32" fn CreateProcessW(
        lpApplicationName: ?LPWSTR,
        lpCommandLine: ?LPWSTR,
        lpProcessAttributes: ?*anyopaque,
        lpThreadAttributes: ?*anyopaque,
        bInheritHandles: BOOL,
        dwCreationFlags: DWORD,
        lpEnvironment: ?LPVOID,
        lpCurrentDirectory: ?LPWSTR,
        lpStartupInfo: *STARTUPINFOW,
        lpProcessInformation: *PROCESS_INFORMATION,
    ) callconv(win.WINAPI) BOOL;

    extern "kernel32" fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) callconv(win.WINAPI) DWORD;
    extern "kernel32" fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *DWORD) callconv(win.WINAPI) BOOL;
    extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(win.WINAPI) BOOL;
    extern "kernel32" fn GetCurrentProcessId() callconv(win.WINAPI) DWORD;
    extern "kernel32" fn GetCurrentThreadId() callconv(win.WINAPI) DWORD;
    extern "kernel32" fn GetConsoleWindow() callconv(win.WINAPI) ?HWND;
    extern "user32" fn ShowWindow(hWnd: HWND, nCmdShow: c_int) callconv(win.WINAPI) BOOL;

    extern "kernel32" fn AttachConsole(dwProcessId: DWORD) callconv(win.WINAPI) BOOL;
    extern "kernel32" fn FreeConsole() callconv(win.WINAPI) BOOL;
    extern "kernel32" fn GetStdHandle(nStdHandle: DWORD) callconv(win.WINAPI) ?HANDLE;
    extern "kernel32" fn SetStdHandle(nStdHandle: DWORD, hHandle: HANDLE) callconv(win.WINAPI) BOOL;
    extern "shell32" fn SetCurrentProcessExplicitAppUserModelID(AppID: [*:0]const u16) callconv(win.WINAPI) win.HRESULT;

    const ATTACH_PARENT_PROCESS: DWORD = 0xFFFFFFFF;
    const STD_OUTPUT_HANDLE: DWORD = 0xFFFFFFF5; // -11
    const STD_ERROR_HANDLE: DWORD = 0xFFFFFFF4; // -12
    const CREATE_NO_WINDOW: DWORD = 0x08000000;
    const INFINITE: DWORD = 0xFFFFFFFF;
    const SW_HIDE: c_int = 0;
    const SW_SHOW: c_int = 5;
} else struct {};

// Version info from version.json
// Convert env_map to Windows environment block format (UTF-16LE, double-null-terminated)
// Based on Zig's std/process.zig createWindowsEnvBlock implementation
fn createWindowsEnvBlock(allocator: std.mem.Allocator, env_map: *const std.process.EnvMap) ![]u16 {
    const max_chars_needed = blk: {
        var max_chars: usize = if (env_map.count() == 0) 2 else 1;
        var it = env_map.iterator();
        while (it.next()) |pair| {
            max_chars += pair.key_ptr.len + pair.value_ptr.len + 2;
        }
        break :blk max_chars;
    };

    const result = try allocator.alloc(u16, max_chars_needed);
    errdefer allocator.free(result);

    var it = env_map.iterator();
    var i: usize = 0;
    while (it.next()) |pair| {
        i += try std.unicode.utf8ToUtf16Le(result[i..], pair.key_ptr.*);
        result[i] = '=';
        i += 1;
        i += try std.unicode.utf8ToUtf16Le(result[i..], pair.value_ptr.*);
        result[i] = 0;
        i += 1;
    }
    result[i] = 0;
    i += 1;

    if (env_map.count() == 0) {
        result[i] = 0;
        i += 1;
    }

    return try allocator.realloc(result, i);
}

const VersionInfo = struct {
    identifier: ?[]const u8,
    channel: ?[]const u8,
    
    fn deinit(self: *VersionInfo, allocator: std.mem.Allocator) void {
        if (self.identifier) |id| allocator.free(id);
        if (self.channel) |ch| allocator.free(ch);
    }
};

// Read version.json once and extract all needed fields (DRY)
fn readVersionInfo(allocator: std.mem.Allocator, exe_dir: []const u8) ?VersionInfo {
    const version_path = std.fs.path.join(allocator, &.{ exe_dir, "..", "Resources", "version.json" }) catch return null;
    defer allocator.free(version_path);

    const file = std.fs.openFileAbsolute(version_path, .{}) catch return null;
    defer file.close();

    const content = file.readToEndAlloc(allocator, 1024 * 10) catch return null;
    defer allocator.free(content);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return null;
    defer parsed.deinit();

    var info = VersionInfo{ .identifier = null, .channel = null };

    if (parsed.value.object.get("identifier")) |id_value| {
        if (id_value == .string) {
            info.identifier = allocator.dupe(u8, id_value.string) catch null;
        }
    }

    if (parsed.value.object.get("channel")) |ch_value| {
        if (ch_value == .string) {
            info.channel = allocator.dupe(u8, ch_value.string) catch null;
        }
    }

    return info;
}

// SIGALRM handler - safety net timeout for hung shutdowns
fn alarmHandler(_: c_int) callconv(.C) void {
    // Timeout expired - app hung during shutdown. Kill entire process group.
    _ = c.kill(0, c.SIGKILL);
}

// Signal handler for graceful shutdown coordination
fn signalHandler(sig: c_int) callconv(.C) void {
    if (sig == c.SIGINT) {
        sigint_count += 1;
        if (sigint_count == 1) {
            // First Ctrl+C: The child process already received SIGINT from the
            // process group. It will run its graceful quit sequence.
            // Set a safety timeout in case the app hangs during shutdown.
            // No message here - the CLI prints the user-facing message.
            _ = c.alarm(10);
            return;
        } else {
            // Second Ctrl+C: force kill entire process group
            _ = c.alarm(0);
            _ = c.kill(0, c.SIGKILL);
            return;
        }
    }

    // For other signals (SIGTERM, SIGHUP), forward to child
    _ = c.kill(@intCast(child_pid), sig);

    if (sig == c.SIGTERM) {
        should_exit = true;
    }
}

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var exePathBuffer: [1024]u8 = undefined;
    const exe_dir = try std.fs.selfExeDirPath(exePathBuffer[0..]);

    // Read version.json once for all needed fields (DRY)
    var version_info = readVersionInfo(alloc, exe_dir);
    defer if (version_info) |*info| info.deinit(alloc);

    // CRITICAL: Set AppUserModelID FIRST, before any console output or window creation.
    // This ensures Windows taskbar groups launcher.exe and bun.exe correctly.
    // If set too late, the console window gets its own taskbar identity.
    if (builtin.os.tag == .windows) {
        const win = windows_imports;
        
        // Use identifier from version.json, fallback to generic ID
        const identifier = if (version_info) |info| info.identifier orelse "com.electrobun.app" else "com.electrobun.app";
        
        const app_id_utf16 = std.unicode.utf8ToUtf16LeWithNull(alloc, identifier) catch {
            const fallback = std.unicode.utf8ToUtf16LeStringLiteral("com.electrobun.app");
            _ = win.SetCurrentProcessExplicitAppUserModelID(fallback);
            return;
        };
        defer alloc.free(app_id_utf16);
        
        const hr = win.SetCurrentProcessExplicitAppUserModelID(app_id_utf16.ptr);
        
        // Hide console window immediately (console windows prevent taskbar grouping)
        const console_hwnd = win.GetConsoleWindow();
        const console_hidden = if (console_hwnd) |hwnd| blk: {
            _ = win.ShowWindow(hwnd, win.SW_HIDE);
            break :blk true;
        } else false;
        
        // Log to %temp%\electrobun-launcher.log (before any console output)
        var arena = std.heap.ArenaAllocator.init(alloc);
        defer arena.deinit();
        const arena_alloc = arena.allocator();
        
        const temp_dir = std.process.getEnvVarOwned(arena_alloc, "TEMP") catch "C:\\Windows\\Temp";
        defer arena_alloc.free(temp_dir);
        const log_path = std.fs.path.join(arena_alloc, &.{ temp_dir, "electrobun-launcher.log" }) catch "";
        if (log_path.len > 0) {
            const log_file = std.fs.cwd().createFile(log_path, .{ .truncate = false }) catch null;
            if (log_file) |file| {
                defer file.close();
                _ = file.seekFromEnd(0) catch {};
                const pid = win.GetCurrentProcessId();
                const tid = win.GetCurrentThreadId();
                const log_msg = std.fmt.allocPrint(arena_alloc, 
                    "[LAUNCHER EARLY] PID={d} TID={d} SetCurrentProcessExplicitAppUserModelID(\"{s}\") result: 0x{x} (0x0=success) | Console hidden: {}\n", 
                    .{pid, tid, identifier, hr, console_hidden}) catch "";
                _ = file.writeAll(log_msg) catch {};
            }
        }
    }

    std.debug.print("Launcher starting on {s}...\n", .{@tagName(builtin.os.tag)});
    std.debug.print("Current directory: {s}\n", .{exe_dir});

    // Set up signal handlers (not on Windows)
    if (builtin.os.tag != .windows) {
        _ = c.signal(c.SIGINT, signalHandler);
        _ = c.signal(c.SIGTERM, signalHandler);
        _ = c.signal(c.SIGHUP, signalHandler);
        _ = c.signal(c.SIGALRM, alarmHandler);
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
    // Prepare environment for child process
    var env_map = try std.process.getEnvMap(arena_alloc);
    
    if (builtin.os.tag == .linux) {
        // On Linux, check for CEF and SwiftShader libraries
        const cef_lib_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "libcef.so" });
        const swiftshader_lib_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "libvk_swiftshader.so" });

        // Set LD_LIBRARY_PATH to include current directory
        if (env_map.get("LD_LIBRARY_PATH")) |existing_ld_path| {
            const new_ld_path = try std.fmt.allocPrint(arena_alloc, "{s}:{s}", .{ exe_dir, existing_ld_path });
            try env_map.put("LD_LIBRARY_PATH", new_ld_path);
        } else {
            try env_map.put("LD_LIBRARY_PATH", exe_dir);
        }

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
    }

    // Pass app identifier to bun for unique AppUserModelID
    if (version_info) |info| {
        if (info.identifier) |id| {
            try env_map.put("ELECTROBUN_APP_IDENTIFIER", id);
        }
    }

    child_process.env_map = &env_map;

    std.debug.print("Spawning: {s} {s}\n", .{ argv[0], if (argv.len > 1) argv[1] else "" });

    // Check if console mode is forced via environment variable
    const force_console = if (std.process.getEnvVarOwned(arena_alloc, "ELECTROBUN_CONSOLE")) |val| blk: {
        defer arena_alloc.free(val);
        break :blk std.mem.eql(u8, val, "1");
    } else |_| false;

    // Check if this is a dev build using version_info.channel
    const is_dev_build = force_console or (if (version_info) |info| blk: {
        if (info.channel) |ch| {
            break :blk std.mem.eql(u8, ch, "dev");
        }
        break :blk false;
    } else false);
    
    if (force_console) {
        std.debug.print("Console mode forced via ELECTROBUN_CONSOLE=1\n", .{});
    } else if (is_dev_build) {
        std.debug.print("Dev build detected - console output enabled\n", .{});
    }

    // Windows non-dev builds: Use CreateProcessW with CREATE_NO_WINDOW (no console)
    // Dev builds and other platforms: Use standard spawn with inherited I/O
    const use_gui_mode = builtin.os.tag == .windows and !is_dev_build;

    if (use_gui_mode) {
        // Windows non-dev build - use CreateProcessW with CREATE_NO_WINDOW
        const win = windows_imports;

        // Note: AppUserModelID already set at start of main() for proper taskbar grouping
        
        // Build command line (needs to be mutable for CreateProcessW)
        const cmd_line = try std.fmt.allocPrintZ(arena_alloc, "\"{s}\" \"{s}\"", .{ argv[0], argv[1] });
        const cmd_line_w = try std.unicode.utf8ToUtf16LeWithNull(arena_alloc, cmd_line);
        const cwd_w = try std.unicode.utf8ToUtf16LeWithNull(arena_alloc, exe_dir);

        const env_block_w = try createWindowsEnvBlock(arena_alloc, &env_map);
        defer arena_alloc.free(env_block_w);

        const temp_dir = std.process.getEnvVarOwned(arena_alloc, "TEMP") catch "C:\\Windows\\Temp";
        defer arena_alloc.free(temp_dir);
        const log_path = std.fs.path.join(arena_alloc, &.{ temp_dir, "electrobun-launcher.log" }) catch "";
        if (log_path.len > 0) {
            const log_file = std.fs.cwd().createFile(log_path, .{ .truncate = false }) catch null;
            if (log_file) |file| {
                defer file.close();
                _ = file.seekFromEnd(0) catch {};
                const identifier_for_log = if (version_info) |info| info.identifier orelse "com.electrobun.app" else "com.electrobun.app";
                const log_msg = std.fmt.allocPrint(arena_alloc,
                    "[LAUNCHER GUI] Passing env block to CreateProcessW with ELECTROBUN_APP_IDENTIFIER=\"{s}\"\n",
                    .{identifier_for_log}) catch "";
                _ = file.writeAll(log_msg) catch {};
            }
        }

        var si: win.STARTUPINFOW = std.mem.zeroes(win.STARTUPINFOW);
        si.cb = @sizeOf(win.STARTUPINFOW);

        var pi: win.PROCESS_INFORMATION = undefined;

        const success = win.CreateProcessW(
            null,
            @constCast(cmd_line_w.ptr),
            null,
            null,
            0,
            win.CREATE_NO_WINDOW | 0x00000400,
            env_block_w.ptr,
            cwd_w.ptr,
            &si,
            &pi,
        );

        if (success == 0) {
            std.debug.print("Failed to create process\n", .{});
            return error.SpawnFailed;
        }

        std.debug.print("Child process spawned with PID {d}\n", .{pi.dwProcessId});

        // Wait for the process to complete
        _ = win.WaitForSingleObject(pi.hProcess, win.INFINITE);

        var exit_code: win.DWORD = 0;
        _ = win.GetExitCodeProcess(pi.hProcess, &exit_code);

        _ = win.CloseHandle(pi.hProcess);
        _ = win.CloseHandle(pi.hThread);

        std.debug.print("Child process exited with code: {d}\n", .{exit_code});
        if (exit_code != 0) {
            std.process.exit(@intCast(exit_code));
        }
    } else {
        // Dev build or non-Windows: Use standard spawn with inherited I/O

        // On Windows dev builds, attach to parent console for output
        if (builtin.os.tag == .windows) {
            const win = windows_imports;
            if (win.AttachConsole(win.ATTACH_PARENT_PROCESS) != 0) {
                std.debug.print("Attached to parent console\n", .{});
            }
        }

        child_process.stdout_behavior = .Inherit;
        child_process.stderr_behavior = .Inherit;

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
                if (code != 0) {
                    std.debug.print("Child process exited with code: {d}\n", .{code});
                    std.process.exit(@intCast(code));
                }
            },
            .Signal => |sig| {
                // Don't print on SIGINT/SIGTERM - these are expected during graceful shutdown
                if (builtin.os.tag != .windows and sig != c.SIGINT and sig != c.SIGTERM) {
                    std.debug.print("Child process terminated by signal: {d}\n", .{sig});
                }
                std.process.exit(128 + @as(u8, @intCast(sig)));
            },
            else => {
                std.debug.print("Child process terminated unexpectedly\n", .{});
                std.process.exit(1);
            },
        }
    }
}
