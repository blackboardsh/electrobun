const std = @import("std");

pub const c = @import("c.zig");
pub usingnamespace @import("autorelease.zig");
pub usingnamespace @import("block.zig");
pub usingnamespace @import("class.zig");
pub usingnamespace @import("encoding.zig");
pub usingnamespace @import("object.zig");
pub usingnamespace @import("property.zig");
pub usingnamespace @import("protocol.zig");
pub usingnamespace @import("sel.zig");

/// This just calls the C allocator free. Some things need to be freed
/// and this is how they can be freed for objc.
pub inline fn free(ptr: anytype) void {
    std.heap.c_allocator.free(ptr);
}

test {
    std.testing.refAllDecls(@This());
}
