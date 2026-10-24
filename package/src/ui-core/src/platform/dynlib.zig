//! Shared libraries on every platform. Zig 0.17's std.DynLib has no Windows
//! implementation, so loading Dawn and finding the native wrapper's symbols
//! goes through here: dlopen/dlsym on POSIX, LoadLibraryW/GetProcAddress on
//! Windows.
const std = @import("std");
const builtin = @import("builtin");

const is_windows = builtin.os.tag == .windows;

const win = struct {
    const HMODULE = *opaque {};
    extern "kernel32" fn LoadLibraryW(name: [*:0]const u16) callconv(.winapi) ?HMODULE;
    extern "kernel32" fn GetModuleHandleW(name: ?[*:0]const u16) callconv(.winapi) ?HMODULE;
    extern "kernel32" fn GetProcAddress(module: HMODULE, name: [*:0]const u8) callconv(.winapi) ?*anyopaque;
    extern "kernel32" fn FreeLibrary(module: HMODULE) callconv(.winapi) c_int;

    fn wide(buf: []u16, s: []const u8) ?[*:0]const u16 {
        if (s.len + 1 > buf.len) return null;
        const n = std.unicode.utf8ToUtf16Le(buf[0 .. buf.len - 1], s) catch return null;
        buf[n] = 0;
        return buf[0..n :0].ptr;
    }
};

pub const Error = error{ NotFound, NameTooLong };

pub const DynLib = struct {
    handle: *anyopaque,

    pub fn open(path: []const u8) Error!DynLib {
        if (is_windows) {
            var buf: [std.fs.max_path_bytes]u16 = undefined;
            const w = win.wide(&buf, path) orelse return error.NameTooLong;
            const h = win.LoadLibraryW(w) orelse return error.NotFound;
            return .{ .handle = h };
        }
        var buf: [std.fs.max_path_bytes]u8 = undefined;
        if (path.len + 1 > buf.len) return error.NameTooLong;
        @memcpy(buf[0..path.len], path);
        buf[path.len] = 0;
        const h = std.c.dlopen(buf[0..path.len :0], .{ .LAZY = true }) orelse return error.NotFound;
        return .{ .handle = h };
    }

    pub fn close(lib: *DynLib) void {
        if (is_windows) {
            _ = win.FreeLibrary(@ptrCast(lib.handle));
        } else {
            _ = std.c.dlclose(lib.handle);
        }
    }

    pub fn lookup(lib: *DynLib, comptime T: type, name: [:0]const u8) ?T {
        const p = rawLookup(lib.handle, name) orelse return null;
        return @ptrCast(@alignCast(p));
    }
};

fn rawLookup(handle: *anyopaque, name: [:0]const u8) ?*anyopaque {
    if (is_windows) return win.GetProcAddress(@ptrCast(handle), name.ptr);
    return std.c.dlsym(handle, name);
}

/// Find a symbol in a library that is already loaded in the process (e.g.
/// Electrobun's native wrapper). `modules` are file names to try first; on
/// POSIX the process-wide namespace is searched last. Never loads anything.
pub fn loadedSymbol(comptime T: type, modules: []const [:0]const u8, name: [:0]const u8) ?T {
    for (modules) |m| {
        if (is_windows) {
            var buf: [260]u16 = undefined;
            const w = win.wide(&buf, m) orelse continue;
            const h = win.GetModuleHandleW(w) orelse continue;
            if (win.GetProcAddress(h, name.ptr)) |p| return @ptrCast(@alignCast(p));
        } else if (builtin.os.tag != .macos) {
            // RTLD_NOLOAD: only succeeds if the library is already loaded
            const h = std.c.dlopen(m, .{ .LAZY = true, .NOLOAD = true }) orelse continue;
            defer _ = std.c.dlclose(h);
            if (std.c.dlsym(h, name)) |p| return @ptrCast(@alignCast(p));
        }
    }
    if (is_windows) return null;
    // RTLD_DEFAULT: null on glibc/musl, -2 on Darwin
    const default: ?*anyopaque = if (builtin.os.tag == .macos) @ptrFromInt(@as(usize, @bitCast(@as(isize, -2)))) else null;
    const p = std.c.dlsym(default, name) orelse return null;
    return @ptrCast(@alignCast(p));
}

test "missing libraries and symbols fail cleanly" {
    try std.testing.expectError(error.NotFound, DynLib.open("definitely-not-a-library-ebui"));
    const f = loadedSymbol(*const fn () callconv(.c) void, &.{"definitely-not-loaded-ebui"}, "definitely_not_a_symbol_ebui");
    try std.testing.expect(f == null);
}
