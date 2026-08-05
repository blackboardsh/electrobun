const std = @import("std");
const builtin = @import("builtin");
const automation = @import("automation.zig");
const linux_dependencies = @import("linux_dependencies.zig");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("unistd.h");
    @cInclude("stdlib.h");
});

// Initialized at the top of main().
var g_io: std.Io = undefined;

var child_pid: std.process.Child.Id = undefined;
var should_exit: bool = false;
var sigint_count: u32 = 0;

// Windows-specific imports for production builds (GUI subsystem with hidden console)
const windows_imports = if (builtin.os.tag == .windows) struct {
    const win = std.os.windows;
    const BOOL = win.BOOL;
    const DWORD = win.DWORD;
    const HANDLE = win.HANDLE;
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
    ) callconv(.winapi) BOOL;

    extern "kernel32" fn WaitForSingleObject(hHandle: HANDLE, dwMilliseconds: DWORD) callconv(.winapi) DWORD;
    extern "kernel32" fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *DWORD) callconv(.winapi) BOOL;
    extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.winapi) BOOL;

    // Console attachment for dev mode
    extern "kernel32" fn AttachConsole(dwProcessId: DWORD) callconv(.winapi) BOOL;
    extern "kernel32" fn FreeConsole() callconv(.winapi) BOOL;
    extern "kernel32" fn GetStdHandle(nStdHandle: DWORD) callconv(.winapi) ?HANDLE;
    extern "kernel32" fn SetStdHandle(nStdHandle: DWORD, hHandle: HANDLE) callconv(.winapi) BOOL;

    const ATTACH_PARENT_PROCESS: DWORD = 0xFFFFFFFF;
    const STD_OUTPUT_HANDLE: DWORD = 0xFFFFFFF5; // -11
    const STD_ERROR_HANDLE: DWORD = 0xFFFFFFF4; // -12
    const CREATE_NO_WINDOW: DWORD = 0x08000000;
    const INFINITE: DWORD = 0xFFFFFFFF;
} else struct {};

// Check if this is a dev build by reading version.json
fn isDevBuild(allocator: std.mem.Allocator, exe_dir: []const u8) bool {
    // Build path to version.json: exe_dir/../Resources/version.json
    const version_path = std.fs.path.join(allocator, &.{ exe_dir, "..", "Resources", "version.json" }) catch return false;
    defer allocator.free(version_path);

    // Read the file
    const content = std.Io.Dir.cwd().readFileAlloc(g_io, version_path, allocator, .limited(1024 * 10)) catch return false;
    defer allocator.free(content);

    // Parse JSON and look for "channel":"dev"
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return false;
    defer parsed.deinit();

    if (parsed.value.object.get("channel")) |channel_value| {
        if (channel_value == .string) {
            return std.mem.eql(u8, channel_value.string, "dev");
        }
    }

    return false;
}

const MainProcess = enum {
    bun,
    cottontail,
    zig,
    rust,
    go,
    odin,
};

fn detectMainProcess(allocator: std.mem.Allocator, exe_dir: []const u8) MainProcess {
    const build_path = std.fs.path.join(allocator, &.{ exe_dir, "..", "Resources", "build.json" }) catch return .cottontail;
    defer allocator.free(build_path);

    const content = std.Io.Dir.cwd().readFileAlloc(g_io, build_path, allocator, .limited(1024 * 10)) catch return .cottontail;
    defer allocator.free(content);

    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return .cottontail;
    defer parsed.deinit();

    if (parsed.value.object.get("mainProcess")) |main_process_value| {
        if (main_process_value == .string and std.mem.eql(u8, main_process_value.string, "bun")) {
            return .bun;
        }
        if (main_process_value == .string and std.mem.eql(u8, main_process_value.string, "cottontail")) {
            return .cottontail;
        }
        if (main_process_value == .string and std.mem.eql(u8, main_process_value.string, "zig")) {
            return .zig;
        }
        if (main_process_value == .string and std.mem.eql(u8, main_process_value.string, "rust")) {
            return .rust;
        }
        if (main_process_value == .string and std.mem.eql(u8, main_process_value.string, "go")) {
            return .go;
        }
        if (main_process_value == .string and std.mem.eql(u8, main_process_value.string, "odin")) {
            return .odin;
        }
    }

    return .cottontail;
}

fn configureCottontailEnv(allocator: std.mem.Allocator, exe_dir: []const u8, env_map: *std.process.Environ.Map) !void {
    try env_map.put("COTTONTAIL_ELECTROBUN_DIST", exe_dir);

    const version_path = std.fs.path.join(allocator, &.{ exe_dir, "..", "Resources", "version.json" }) catch return;
    const content = std.Io.Dir.cwd().readFileAlloc(g_io, version_path, allocator, .limited(1024 * 10)) catch return;
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return;

    if (parsed.value.object.get("name")) |value| {
        if (value == .string) try env_map.put("COTTONTAIL_ELECTROBUN_NAME", value.string);
    }
    if (parsed.value.object.get("identifier")) |value| {
        if (value == .string) try env_map.put("COTTONTAIL_ELECTROBUN_IDENTIFIER", value.string);
    }
    if (parsed.value.object.get("channel")) |value| {
        if (value == .string) try env_map.put("COTTONTAIL_ELECTROBUN_CHANNEL", value.string);
    }
}

// SIGALRM handler - safety net timeout for hung shutdowns
fn alarmHandler(_: c_int) callconv(.c) void {
    // Timeout expired - app hung during shutdown. Kill entire process group.
    _ = c.kill(0, c.SIGKILL);
}

// Signal handler for graceful shutdown coordination
fn signalHandler(sig: c_int) callconv(.c) void {
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

pub fn main(init: std.process.Init) !void {
    g_io = init.io;
    const io = init.io;
    const alloc = init.gpa;

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const arena_alloc = arena.allocator();

    const exe_path = try std.process.executablePathAlloc(io, arena_alloc);
    const exe_dir = std.fs.path.dirname(exe_path) orelse return error.InvalidExePath;

    std.debug.print("Launcher starting on {s}...\n", .{@tagName(builtin.os.tag)});
    std.debug.print("Current directory: {s}\n", .{exe_dir});

    // Set up signal handlers (not on Windows)
    if (builtin.os.tag != .windows) {
        _ = c.signal(c.SIGINT, signalHandler);
        _ = c.signal(c.SIGTERM, signalHandler);
        _ = c.signal(c.SIGHUP, signalHandler);
        _ = c.signal(c.SIGALRM, alarmHandler);
    }

    const launcher_args = blk: {
        var args_list: std.ArrayList([]const u8) = .empty;
        var args_iterator = try std.process.Args.Iterator.initAllocator(init.minimal.args, arena_alloc);
        while (args_iterator.next()) |arg| {
            try args_list.append(arena_alloc, arg);
        }
        break :blk args_list.items;
    };
    const main_process = detectMainProcess(arena_alloc, exe_dir);

    // Platform-specific paths
    var argv: []const []const u8 = undefined;

    switch (main_process) {
        .zig, .rust, .go, .odin => {
            const main_binary_name = if (builtin.os.tag == .windows) "main.exe" else "main";
            const main_binary_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, main_binary_name });
            argv = &[_][]const u8{main_binary_path};
        },
        .bun, .cottontail => {
            const main_script = try std.fs.path.join(arena_alloc, &.{ exe_dir, "..", "Resources", "main.js" });
            const runtime_name = switch (main_process) {
                .bun => if (builtin.os.tag == .windows) "bun.exe" else "bun",
                .cottontail => if (builtin.os.tag == .windows) "cottontail.exe" else "cottontail",
                else => unreachable,
            };
            const runtime_path = switch (builtin.os.tag) {
                .macos, .linux, .windows => try std.fs.path.join(arena_alloc, &.{ exe_dir, runtime_name }),
                else => @panic("Unsupported platform"),
            };
            argv = &[_][]const u8{ runtime_path, main_script };
        },
    }

    // Child processes inherit the launcher's environment plus our overrides.
    const env_map = init.environ_map;

    // Handle platform-specific environment setup
    if (builtin.os.tag == .linux) {
        // WebKitGTK automation is disabled unless WebKitWebDriver launches the
        // app with the exact `--automation` flag. Keep the marker private to the
        // child process so the application's own argument contract is unchanged.
        if (automation.requested(launcher_args)) {
            try env_map.put(automation.environment_variable, "1");

            // WebKitWebDriver supplies this endpoint for WebKitGTK. Shield it
            // while Cottontail/Bun initializes its own JavaScriptCore runtime,
            // then let the native wrapper restore it immediately before WebKit
            // creates its context. Otherwise the main runtime claims the port.
            if (env_map.get(automation.inspector_server_environment_variable)) |server| {
                try env_map.put(
                    automation.private_inspector_server_environment_variable,
                    server,
                );
                _ = env_map.swapRemove(automation.inspector_server_environment_variable);
            }
        }

        // Check for CEF libraries that need LD_PRELOAD
        const cef_lib_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "libcef.so" });
        const swiftshader_lib_path = try std.fs.path.join(arena_alloc, &.{ exe_dir, "libvk_swiftshader.so" });

        // Set LD_LIBRARY_PATH to include current directory
        if (env_map.get("LD_LIBRARY_PATH")) |existing_ld_path| {
            const new_ld_path = try std.fmt.allocPrint(arena_alloc, "{s}:{s}", .{ exe_dir, existing_ld_path });
            try env_map.put("LD_LIBRARY_PATH", new_ld_path);
        } else {
            try env_map.put("LD_LIBRARY_PATH", exe_dir);
        }

        // Check if CEF libraries exist and set LD_PRELOAD if needed
        const cef_exists = blk: {
            std.Io.Dir.accessAbsolute(io, cef_lib_path, .{}) catch {
                break :blk false;
            };
            break :blk true;
        };
        const swiftshader_exists = blk: {
            std.Io.Dir.accessAbsolute(io, swiftshader_lib_path, .{}) catch {
                break :blk false;
            };
            break :blk true;
        };

        if (cef_exists or swiftshader_exists) {
            var preload_libs: std.ArrayList([]const u8) = .empty;
            if (cef_exists) try preload_libs.append(arena_alloc, "./libcef.so");
            if (swiftshader_exists) try preload_libs.append(arena_alloc, "./libvk_swiftshader.so");

            const ld_preload = try std.mem.join(arena_alloc, ":", preload_libs.items);
            try env_map.put("LD_PRELOAD", ld_preload);
            std.debug.print("Setting LD_PRELOAD: {s}\n", .{ld_preload});
        }

        // Set ICU_DATA for external ICU data file (Linux)
        try env_map.put("ICU_DATA", exe_dir);
        if (main_process == .cottontail) {
            try configureCottontailEnv(arena_alloc, exe_dir, env_map);
        }
    } else if (builtin.os.tag == .windows) {
        // On Windows, get environment and set ICU_DATA for external ICU data
        try env_map.put("ICU_DATA", exe_dir);
        if (main_process == .cottontail) {
            try configureCottontailEnv(arena_alloc, exe_dir, env_map);
        }
    } else {
        // On macOS, get environment and inherit it (uses system ICU)
        if (main_process == .cottontail) {
            try configureCottontailEnv(arena_alloc, exe_dir, env_map);
        }
    }

    std.debug.print("Spawning: {s} {s}\n", .{ argv[0], if (argv.len > 1) argv[1] else "" });

    // Check if console mode is forced via environment variable
    const force_console = if (env_map.get("ELECTROBUN_CONSOLE")) |val|
        std.mem.eql(u8, val, "1")
    else
        false;

    // Check if this is a dev build by reading version.json, or if console is forced
    const is_dev_build = force_console or isDevBuild(arena_alloc, exe_dir);
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

        // Build command line (needs to be mutable for CreateProcessW)
        const cmd_line = try std.fmt.allocPrintSentinel(arena_alloc, "\"{s}\" \"{s}\"", .{ argv[0], argv[1] }, 0);
        const cmd_line_w = try std.unicode.wtf8ToWtf16LeAllocZ(arena_alloc, cmd_line);

        // Convert current directory to UTF-16
        const cwd_w = try std.unicode.wtf8ToWtf16LeAllocZ(arena_alloc, exe_dir);

        var si: win.STARTUPINFOW = std.mem.zeroes(win.STARTUPINFOW);
        si.cb = @sizeOf(win.STARTUPINFOW);

        var pi: win.PROCESS_INFORMATION = undefined;

        const success = win.CreateProcessW(
            null,
            @constCast(cmd_line_w.ptr),
            null,
            null,
            .FALSE, // Don't inherit handles
            win.CREATE_NO_WINDOW,
            null,
            @constCast(cwd_w.ptr),
            &si,
            &pi,
        );

        if (!success.toBool()) {
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
            if (win.AttachConsole(win.ATTACH_PARENT_PROCESS).toBool()) {
                std.debug.print("Attached to parent console\n", .{});
            }
        }

        var child_process = try std.process.spawn(io, .{
            .argv = argv,
            .cwd = .{ .path = exe_dir },
            .environ_map = env_map,
            .stdout = .inherit,
            .stderr = .inherit,
        });
        child_pid = child_process.id.?;

        const child_pid_value: usize = if (builtin.os.tag == .windows)
            @intFromPtr(child_pid)
        else
            @intCast(child_pid);
        std.debug.print("Child process spawned with PID {d}\n", .{child_pid_value});

        // Wait for the subprocess to complete
        const result = child_process.wait(io) catch |err| {
            std.debug.print("Failed to wait for child process: {}\n", .{err});
            return;
        };

        switch (result) {
            .exited => |code| {
                if (code != 0) {
                    std.debug.print("Child process exited with code: {d}\n", .{code});

                    if (builtin.os.tag == .linux and linux_dependencies.shouldDiagnoseChildExit(code)) {
                        if (std.fs.path.join(arena_alloc, &.{ exe_dir, "libNativeWrapper.so" })) |native_wrapper_path| {
                            _ = linux_dependencies.diagnoseNativeWrapperFailure(
                                alloc,
                                io,
                                init.minimal.environ,
                                native_wrapper_path,
                                env_map.get("LD_LIBRARY_PATH"),
                            ) catch false;
                        } else |_| {}
                    }

                    std.process.exit(code);
                }
            },
            .signal => |sig| {
                const sig_value: u32 = @intFromEnum(sig);
                // Don't print on SIGINT/SIGTERM - these are expected during graceful shutdown
                if (builtin.os.tag != .windows and sig_value != c.SIGINT and sig_value != c.SIGTERM) {
                    std.debug.print("Child process terminated by signal: {d}\n", .{sig_value});
                }
                std.process.exit(@intCast(128 + @as(u8, @intCast(sig_value))));
            },
            else => {
                std.debug.print("Child process terminated unexpectedly\n", .{});
                std.process.exit(1);
            },
        }
    }
}
