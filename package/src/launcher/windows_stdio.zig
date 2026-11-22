const std = @import("std");
const builtin = @import("builtin");
const win = std.os.windows;

extern "kernel32" fn GetStdHandle(kind: u32) callconv(.winapi) ?win.HANDLE;
extern "kernel32" fn GetCurrentProcess() callconv(.winapi) win.HANDLE;
extern "kernel32" fn DuplicateHandle(source_process: win.HANDLE, source: win.HANDLE, target_process: win.HANDLE, target: *win.HANDLE, access: u32, inherit: win.BOOL, options: u32) callconv(.winapi) win.BOOL;
extern "kernel32" fn CreateFileW(name: [*:0]const u16, access: u32, share: u32, attributes: ?*win.SECURITY_ATTRIBUTES, creation: u32, flags: u32, template: ?win.HANDLE) callconv(.winapi) win.HANDLE;
extern "kernel32" fn CloseHandle(handle: win.HANDLE) callconv(.winapi) win.BOOL;
extern "kernel32" fn InitializeProcThreadAttributeList(list: ?*anyopaque, count: u32, flags: u32, size: *usize) callconv(.winapi) win.BOOL;
extern "kernel32" fn UpdateProcThreadAttribute(list: *anyopaque, flags: u32, attribute: usize, value: *anyopaque, size: usize, previous: ?*anyopaque, returned_size: ?*usize) callconv(.winapi) win.BOOL;
extern "kernel32" fn DeleteProcThreadAttributeList(list: *anyopaque) callconv(.winapi) void;

pub const extended_startupinfo_present: u32 = 0x00080000;
const proc_thread_attribute_handle_list: usize = 0x00020002;

pub const StartupInfoEx = extern struct {
    startup: win.STARTUPINFOW,
    attributes: ?*anyopaque,
};

pub fn capture() [3]?win.HANDLE {
    return .{ GetStdHandle(0xfffffff6), GetStdHandle(0xfffffff5), GetStdHandle(0xfffffff4) };
}

fn valid(handle: ?win.HANDLE) bool {
    return if (handle) |value| value != win.INVALID_HANDLE_VALUE else false;
}

fn inheritOrNul(source: ?win.HANDLE, input: bool) !win.HANDLE {
    if (valid(source)) {
        const process = GetCurrentProcess();
        var copy: win.HANDLE = undefined;
        if (DuplicateHandle(process, source.?, process, &copy, 0, .TRUE, 2).toBool()) return copy;
        if (win.GetLastError() != .INVALID_HANDLE) return error.StandardHandleDuplicationFailed;
    }
    // GUI launches commonly have no standard handles. NUL supplies EOF for
    // stdin and discards output without attaching or allocating a console.
    var attributes: win.SECURITY_ATTRIBUTES = .{
        .nLength = @sizeOf(win.SECURITY_ATTRIBUTES),
        .lpSecurityDescriptor = null,
        .bInheritHandle = .TRUE,
    };
    const handle = CreateFileW(std.unicode.utf8ToUtf16LeStringLiteral("NUL"), if (input) 0x80000000 else 0x40000000, 3, &attributes, 3, 0x80, null);
    if (handle == win.INVALID_HANDLE_VALUE) return error.NullStandardHandleUnavailable;
    return handle;
}

/// Only these three owned duplicates are inherited. The caller's original
/// handles and every other inheritable process handle stay out of the list.
/// Keep this context at a stable address between startupInfo() and CreateProcess.
pub const Context = struct {
    allocator: std.mem.Allocator,
    handles: [3]win.HANDLE,
    attribute_storage: []usize,

    pub fn init(allocator: std.mem.Allocator, sources: [3]?win.HANDLE) !Context {
        var handles: [3]win.HANDLE = undefined;
        var initialized: usize = 0;
        errdefer {
            for (handles[0..initialized]) |handle| _ = CloseHandle(handle);
        }
        for (sources, 0..) |source, index| {
            handles[index] = try inheritOrNul(source, index == 0);
            initialized += 1;
        }
        var bytes: usize = 0;
        // This sizing call fails by design and returns the required capacity.
        _ = InitializeProcThreadAttributeList(null, 1, 0, &bytes);
        if (bytes == 0) return error.ProcessAttributesUnavailable;
        const storage = try allocator.alloc(usize, try std.math.divCeil(usize, bytes, @sizeOf(usize)));
        errdefer allocator.free(storage);
        if (!InitializeProcThreadAttributeList(storage.ptr, 1, 0, &bytes).toBool()) return error.ProcessAttributesUnavailable;
        return .{ .allocator = allocator, .handles = handles, .attribute_storage = storage };
    }

    pub fn startupInfo(self: *Context) !StartupInfoEx {
        if (!UpdateProcThreadAttribute(self.attribute_storage.ptr, 0, proc_thread_attribute_handle_list, &self.handles, @sizeOf(@TypeOf(self.handles)), null, null).toBool()) return error.ProcessHandleListUnavailable;
        var result: StartupInfoEx = std.mem.zeroes(StartupInfoEx);
        result.startup.cb = @sizeOf(StartupInfoEx);
        result.startup.dwFlags = win.STARTF_USESTDHANDLES;
        result.startup.hStdInput = self.handles[0];
        result.startup.hStdOutput = self.handles[1];
        result.startup.hStdError = self.handles[2];
        result.attributes = self.attribute_storage.ptr;
        return result;
    }

    /// Capture redirected streams before AttachConsole can replace them. Only
    /// missing streams adopt a newly attached dev console's standard handles.
    pub fn adoptAttachedConsole(self: *Context, before: [3]?win.HANDLE, after: [3]?win.HANDLE) !void {
        for (before, 0..) |handle, index| {
            if (valid(handle) or !valid(after[index])) continue;
            const replacement = try inheritOrNul(after[index], index == 0);
            _ = CloseHandle(self.handles[index]);
            self.handles[index] = replacement;
        }
    }

    pub fn deinit(self: *Context) void {
        DeleteProcThreadAttributeList(self.attribute_storage.ptr);
        self.allocator.free(self.attribute_storage);
        for (self.handles) |handle| _ = CloseHandle(handle);
        self.* = undefined;
    }
};

test "missing GUI standard handles produce valid inheritable NUL handles" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    var context = Context.init(std.testing.allocator, .{ null, win.INVALID_HANDLE_VALUE, null }) catch |err| {
        std.debug.print("NUL stdio setup failed: {s}\n", .{@errorName(err)});
        return err;
    };
    defer context.deinit();
    const startup = context.startupInfo() catch |err| {
        std.debug.print("Stdio handle allowlist setup failed: {s}\n", .{@errorName(err)});
        return err;
    };
    try std.testing.expectEqual(@as(u32, @sizeOf(StartupInfoEx)), startup.startup.cb);
    for (context.handles) |handle| {
        var flags: win.OBJECT.HANDLE_FLAG = undefined;
        const status = win.ntdll.NtQueryObject(handle, .HandleFlag, &flags, @sizeOf(@TypeOf(flags)), null);
        try std.testing.expectEqual(win.NTSTATUS.SUCCESS, status);
        try std.testing.expectEqual(true, flags.INHERIT);
    }
    const input: std.Io.File = .{ .handle = context.handles[0], .flags = .{ .nonblocking = false } };
    var buffer: [16]u8 = undefined;
    // Zig's streaming file API reports EOF as EndOfStream, including the
    // Windows NUL device; it does not return a successful zero-byte read.
    try std.testing.expectError(error.EndOfStream, input.readStreaming(std.testing.io, &.{&buffer}));
}
