const std = @import("std");

fn readU16Little(bytes: []const u8, offset: usize) !u16 {
    if (offset > bytes.len or bytes.len - offset < 2) return error.InvalidPeImage;
    return @as(u16, bytes[offset]) |
        (@as(u16, bytes[offset + 1]) << 8);
}

fn readU32Little(bytes: []const u8, offset: usize) !u32 {
    if (offset > bytes.len or bytes.len - offset < 4) return error.InvalidPeImage;
    return @as(u32, bytes[offset]) |
        (@as(u32, bytes[offset + 1]) << 8) |
        (@as(u32, bytes[offset + 2]) << 16) |
        (@as(u32, bytes[offset + 3]) << 24);
}

fn peSubsystem(bytes: []const u8) !u16 {
    if (bytes.len < 0x40 or bytes[0] != 'M' or bytes[1] != 'Z') {
        return error.InvalidPeImage;
    }

    const pe_offset: usize = @intCast(try readU32Little(bytes, 0x3c));
    if (pe_offset > bytes.len or bytes.len - pe_offset < 24) {
        return error.InvalidPeImage;
    }
    if (!std.mem.eql(u8, bytes[pe_offset .. pe_offset + 4], "PE\x00\x00")) {
        return error.InvalidPeImage;
    }

    const optional_header = pe_offset + 24;
    const magic = try readU16Little(bytes, optional_header);
    if (magic != 0x10b and magic != 0x20b) return error.InvalidPeImage;

    // The Subsystem field is at offset 68 in both PE32 and PE32+ optional headers.
    return readU16Little(bytes, optional_header + 68);
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    var args = try std.process.Args.Iterator.initAllocator(init.minimal.args, allocator);
    defer args.deinit();

    _ = args.next() orelse return error.InvalidArguments;
    const executable_path = args.next() orelse return error.InvalidArguments;
    const expected_arg = args.next() orelse return error.InvalidArguments;
    if (args.next() != null) return error.InvalidArguments;

    const expected = try std.fmt.parseInt(u16, expected_arg, 10);
    const executable = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        executable_path,
        allocator,
        .limited(512 * 1024 * 1024),
    );
    defer allocator.free(executable);

    const actual = try peSubsystem(executable);
    if (actual != expected) {
        std.debug.print(
            "extractor PE subsystem mismatch: expected {d}, found {d} in {s}\n",
            .{ expected, actual, executable_path },
        );
        return error.UnexpectedPeSubsystem;
    }
}

test "reads the subsystem from a PE32+ image" {
    var fixture = [_]u8{0} ** 256;
    fixture[0] = 'M';
    fixture[1] = 'Z';
    fixture[0x3c] = 0x80;
    fixture[0x80] = 'P';
    fixture[0x81] = 'E';
    fixture[0x98] = 0x0b;
    fixture[0x99] = 0x02;
    fixture[0xdc] = 0x02;

    try std.testing.expectEqual(@as(u16, 2), try peSubsystem(&fixture));
}

test "rejects a non-PE image" {
    try std.testing.expectError(error.InvalidPeImage, peSubsystem("not a PE image"));
}
