//! Core's native callbacks and transport threads share these locks. On Windows,
//! use the OS mutex/condition pair: the user-space parking handoff can stall
//! under x64 emulation even though the protected queue has been unlocked.
const std = @import("std");
const builtin = @import("builtin");
const windows = std.os.windows;

pub const Mutex = if (builtin.os.tag == .windows) WindowsMutex else std.Io.Mutex;
pub const Condition = if (builtin.os.tag == .windows) WindowsCondition else std.Io.Condition;

const native = struct {
    extern "kernel32" fn AcquireSRWLockExclusive(*windows.SRWLOCK) callconv(.winapi) void;
    extern "kernel32" fn ReleaseSRWLockExclusive(*windows.SRWLOCK) callconv(.winapi) void;
    extern "kernel32" fn SleepConditionVariableSRW(*windows.CONDITION_VARIABLE, *windows.SRWLOCK, windows.DWORD, windows.ULONG) callconv(.winapi) windows.BOOL;
    extern "kernel32" fn WakeConditionVariable(*windows.CONDITION_VARIABLE) callconv(.winapi) void;
    extern "kernel32" fn WakeAllConditionVariable(*windows.CONDITION_VARIABLE) callconv(.winapi) void;
};

const WindowsMutex = struct {
    value: windows.SRWLOCK = .{},
    pub const init: WindowsMutex = .{};

    pub fn lockUncancelable(self: *WindowsMutex, _: std.Io) void {
        native.AcquireSRWLockExclusive(&self.value);
    }

    pub fn unlock(self: *WindowsMutex, _: std.Io) void {
        native.ReleaseSRWLockExclusive(&self.value);
    }
};

const WindowsCondition = struct {
    value: windows.CONDITION_VARIABLE = .{},
    pub const init: WindowsCondition = .{};

    /// The caller holds the mutex and checks its predicate in a loop. Windows
    /// releases and reacquires that same exclusive SRW lock around the wait.
    pub fn waitUncancelable(self: *WindowsCondition, _: std.Io, mutex: *WindowsMutex) void {
        if (!native.SleepConditionVariableSRW(&self.value, &mutex.value, std.math.maxInt(windows.DWORD), 0).toBool()) {
            std.debug.panic("Core condition wait failed: {d}", .{@backingInt(windows.GetLastError())});
        }
    }

    pub fn signal(self: *WindowsCondition, _: std.Io) void {
        native.WakeConditionVariable(&self.value);
    }

    pub fn broadcast(self: *WindowsCondition, _: std.Io) void {
        native.WakeAllConditionVariable(&self.value);
    }
};
