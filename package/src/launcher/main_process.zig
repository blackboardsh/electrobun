const std = @import("std");

pub const MainProcess = enum { bun, cottontail, zig, rust, go, odin };

pub fn fromMetadata(allocator: std.mem.Allocator, content: []const u8) MainProcess {
    const parsed = std.json.parseFromSlice(std.json.Value, allocator, content, .{}) catch return .bun;
    defer parsed.deinit();
    if (parsed.value != .object) return .bun;
    const selected = parsed.value.object.get("mainProcess") orelse return .bun;
    if (selected != .string) return .bun;
    return std.meta.stringToEnum(MainProcess, selected.string) orelse .bun;
}

test "missing or invalid metadata defaults to Bun" {
    for ([_][]const u8{ "", "not json", "null", "[]", "{}", "{\"mainProcess\":null}", "{\"mainProcess\":\"unknown\"}" }) |content| {
        try std.testing.expectEqual(MainProcess.bun, fromMetadata(std.testing.allocator, content));
    }
}

test "explicit Cottontail and native backends retain their launch selection" {
    inline for (@typeInfo(MainProcess).@"enum".field_names) |name| {
        try std.testing.expectEqual(@field(MainProcess, name), fromMetadata(std.testing.allocator, "{\"mainProcess\":\"" ++ name ++ "\"}"));
    }
}
