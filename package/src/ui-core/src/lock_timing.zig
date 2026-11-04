//! Optional native UI lock diagnostics; no clocks are read unless enabled.
const std = @import("std");
const builtin = @import("builtin");

// Environment is fixed before the native host starts. Multiple first callers
// may compute the same state; later UI lock operations only read one atomic.
var enabled_state = std.atomic.Value(u8).init(0);

pub fn enabled() bool {
    const cached = enabled_state.load(.acquire);
    if (cached != 0) return cached == 2;
    const state: u8 = if (std.c.getenv("EBUI_HOST_DEBUG") != null) 2 else 1;
    enabled_state.store(state, .release);
    return state == 2;
}

pub fn now() f64 {
    if (builtin.os.tag == .windows) {
        var frequency: i64 = 0;
        var counter: i64 = 0;
        if (QueryPerformanceFrequency(&frequency) == 0 or frequency <= 0 or
            QueryPerformanceCounter(&counter) == 0) return 0;
        return @as(f64, @floatFromInt(counter)) / @as(f64, @floatFromInt(frequency));
    }
    var ts: std.c.timespec = undefined;
    if (std.c.clock_gettime(.MONOTONIC, &ts) != 0) return 0;
    return @as(f64, @floatFromInt(ts.sec)) + @as(f64, @floatFromInt(ts.nsec)) * 1e-9;
}

extern "kernel32" fn QueryPerformanceFrequency(frequency: *i64) callconv(.winapi) c_int;
extern "kernel32" fn QueryPerformanceCounter(counter: *i64) callconv(.winapi) c_int;
