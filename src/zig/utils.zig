// todo: move to a better place
const std = @import("std");

const alloc = std.heap.page_allocator;

// todo: move to a util and dedup with window.zig
// todo: make buffer an arg
// todo: use a for loop with mem.copy for simpler concat
// template string concat with arbitrary number of params
pub fn concatOrFallback(comptime fmt: []const u8, params: anytype) []const u8 {
    var buffer: [250]u8 = undefined;
    const result = std.fmt.bufPrint(&buffer, fmt, params) catch |err| {
        std.log.info("Error concatenating string {}", .{err});
        return fmt;
    };

    return result;
}

// join two strings
pub fn concatStrings(a: []const u8, b: []const u8) []u8 {
    const totalLength: usize = a.len + b.len;
    var result = alloc.alloc(u8, totalLength) catch unreachable;

    std.mem.copyForwards(u8, result[0..a.len], a);
    std.mem.copyForwards(u8, result[a.len..totalLength], b);

    return result;
}

pub fn toCString(input: []const u8) [*:0]const u8 {
    // Attempt to allocate memory, handle error without bubbling it up
    const allocResult = alloc.alloc(u8, input.len + 1) catch {
        return "console.error('failed to allocate string');";
    };

    std.mem.copyForwards(u8, allocResult, input);
    allocResult[input.len] = 0; // Null-terminate
    return allocResult[0..input.len :0]; // Correctly typed slice with null terminator
}

pub fn fromCString(input: [*:0]const u8) []const u8 {
    return input[0..std.mem.len(input)];
}

// todo: move to string util (duplicated in handlers.zig)
pub fn strEql(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
