const std = @import("std");
const builtin = @import("builtin");
const win = std.os.windows;

const FileTime = extern struct { low: u32, high: u32 };
extern "kernel32" fn GetProcessId(process: win.HANDLE) callconv(.winapi) u32;
extern "kernel32" fn GetCurrentProcessId() callconv(.winapi) u32;
extern "kernel32" fn GetCurrentProcess() callconv(.winapi) win.HANDLE;
extern "kernel32" fn GetProcessTimes(process: win.HANDLE, created: *FileTime, exited: *FileTime, kernel: *FileTime, user: *FileTime) callconv(.winapi) win.BOOL;
extern "kernel32" fn GetSystemTimeAsFileTime(time: *FileTime) callconv(.winapi) void;
extern "kernel32" fn GetExitCodeProcess(process: win.HANDLE, code: *u32) callconv(.winapi) win.BOOL;
extern "kernel32" fn DuplicateHandle(source_process: win.HANDLE, source: win.HANDLE, target_process: win.HANDLE, target: *win.HANDLE, access: u32, inherit: win.BOOL, options: u32) callconv(.winapi) win.BOOL;
extern "kernel32" fn CloseHandle(handle: win.HANDLE) callconv(.winapi) win.BOOL;
extern "kernel32" fn ExitProcess(code: u32) callconv(.winapi) noreturn;

pub const Identity = struct { pid: u32, created_filetime: u64 };

/// Child.wait closes its HANDLE and truncates Windows NTSTATUS to u8. Own one
/// additional handle until the full DWORD can be read after the wait.
pub fn retain(process: win.HANDLE) !win.HANDLE {
    var copy: win.HANDLE = undefined;
    const current = GetCurrentProcess();
    if (!DuplicateHandle(current, process, current, &copy, 0, .FALSE, 2).toBool()) return error.ProcessHandleUnavailable;
    return copy;
}

pub fn close(process: win.HANDLE) void {
    _ = CloseHandle(process);
}

pub fn exitCode(process: win.HANDLE) !u32 {
    var code: u32 = undefined;
    if (!GetExitCodeProcess(process, &code).toBool()) return error.ProcessExitUnavailable;
    return code;
}

pub fn exit(code: u32) noreturn {
    ExitProcess(code);
}

fn ticks(time: FileTime) u64 {
    return (@as(u64, time.high) << 32) | time.low;
}

/// The Windows Child.Id is a kernel HANDLE, not a PID. Read identity while the
/// launcher still owns that handle; birth time disambiguates later PID reuse.
pub fn read(process: win.HANDLE) !Identity {
    const pid = GetProcessId(process);
    if (pid == 0) return error.ProcessIdUnavailable;
    var created: FileTime = undefined;
    var exited: FileTime = undefined;
    var kernel: FileTime = undefined;
    var user: FileTime = undefined;
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user).toBool()) return error.ProcessBirthUnavailable;
    return .{ .pid = pid, .created_filetime = ticks(created) };
}

fn now() u64 {
    var time: FileTime = undefined;
    GetSystemTimeAsFileTime(&time);
    return ticks(time);
}

// Fixed-schema lines contain no paths, arguments, environment or app content.
// FILETIME values are decimal strings to preserve all 100 ns ticks in JS logs.
pub fn logSpawn(process: win.HANDLE) ?Identity {
    const identity = read(process) catch |err| {
        std.debug.print("[electrobun:process] {{\"event\":\"identity-error\",\"launcherPid\":{d},\"observedFiletime\":\"{d}\",\"error\":\"{s}\"}}\n", .{ GetCurrentProcessId(), now(), @errorName(err) });
        return null;
    };
    std.debug.print("Child process spawned with PID {d}\n", .{identity.pid});
    std.debug.print("[electrobun:process] {{\"event\":\"spawn\",\"launcherPid\":{d},\"pid\":{d},\"createdFiletime\":\"{d}\",\"observedFiletime\":\"{d}\"}}\n", .{ GetCurrentProcessId(), identity.pid, identity.created_filetime, now() });
    return identity;
}

pub fn logExit(identity: ?Identity, code: u32) void {
    if (identity) |child| std.debug.print("[electrobun:process] {{\"event\":\"exit\",\"launcherPid\":{d},\"pid\":{d},\"createdFiletime\":\"{d}\",\"observedFiletime\":\"{d}\",\"code\":{d}}}\n", .{ GetCurrentProcessId(), child.pid, child.created_filetime, now(), code });
}

pub fn logWaitError(identity: ?Identity) void {
    if (identity) |child| std.debug.print("[electrobun:process] {{\"event\":\"wait-error\",\"launcherPid\":{d},\"pid\":{d},\"createdFiletime\":\"{d}\",\"observedFiletime\":\"{d}\"}}\n", .{ GetCurrentProcessId(), child.pid, child.created_filetime, now() });
}

test "FILETIME combines unsigned words without precision loss" {
    try std.testing.expectEqual(@as(u64, 0x12345678fedcba98), ticks(.{ .low = 0xfedcba98, .high = 0x12345678 }));
}

test "Windows process identity is the kernel PID and stable birth time, not a handle" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    const process = GetCurrentProcess();
    const first = try read(process);
    const second = try read(process);
    try std.testing.expectEqual(GetCurrentProcessId(), first.pid);
    try std.testing.expect(first.pid != @intFromPtr(process));
    try std.testing.expect(first.created_filetime > 0 and first.created_filetime <= now());
    try std.testing.expectEqual(first, second);
}

test "Windows retained child handle preserves full exit DWORD after Child.wait closes its handle" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    for ([_]u32{ 0, 9, 0xc0000409, 0xc0000400 }) |expected| {
        var code_buffer: [24]u8 = undefined;
        const code = try std.fmt.bufPrint(&code_buffer, "{d}", .{@as(i32, @bitCast(expected))});
        var child = try std.process.spawn(std.testing.io, .{
            .argv = &.{ "cmd.exe", "/d", "/c", "exit", code },
            .stdout = .ignore,
            .stderr = .ignore,
        });
        const identity = try read(child.id.?);
        const retained = try retain(child.id.?);
        defer close(retained);
        try std.testing.expect(identity.pid != GetCurrentProcessId());
        try std.testing.expect(identity.created_filetime > 0);
        _ = try child.wait(std.testing.io);
        try std.testing.expectEqual(expected, try exitCode(retained));
        try std.testing.expectEqual(identity, try read(retained));
    }
}
