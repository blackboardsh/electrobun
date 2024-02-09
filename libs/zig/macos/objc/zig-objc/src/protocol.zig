const std = @import("std");
const c = @import("c.zig");
const objc = @import("main.zig");

pub const Protocol = extern struct {
    value: *c.Protocol,

    pub fn conformsToProtocol(self: Protocol, other: Protocol) bool {
        return c.protocol_conformsToProtocol(self.value, other.value) == 1;
    }

    pub fn isEqual(self: Protocol, other: Protocol) bool {
        return c.protocol_isEqual(self.value, other.value) == 1;
    }

    pub fn getName(self: Protocol) [:0]const u8 {
        return std.mem.sliceTo(c.protocol_getName(self.value), 0);
    }

    pub fn getProperty(
        self: Protocol,
        name: [:0]const u8,
        is_required: bool,
        is_instance: bool,
    ) ?objc.Property {
        const isRequired: u8 = if (is_required) 1 else 0;
        const isInstance: u8 = if (is_instance) 1 else 0;
        return .{ .value = c.protocol_getProperty(
            self.value,
            name,
            isRequired,
            isInstance,
        ) orelse return null };
    }

    comptime {
        std.debug.assert(@sizeOf(@This()) == @sizeOf([*c]c.Protocol));
        std.debug.assert(@alignOf(@This()) == @alignOf([*c]c.Protocol));
    }
};

pub fn getProtocol(name: [:0]const u8) ?Protocol {
    return .{ .value = c.objc_getProtocol(name) orelse return null };
}
