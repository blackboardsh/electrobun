//! Bounded diagnostics for the manager's System32 tools. Always drain both
//! pipes: verbose output must not change a command's completion or exit status.
const std = @import("std");
const builtin = @import("builtin");

pub const output_limit = 4096;

pub const Output = struct {
    storage: [output_limit]u8 = undefined,
    len: usize = 0,
    total: u64 = 0,

    fn append(self: *Output, chunk: []const u8) void {
        self.total +|= chunk.len;
        if (chunk.len >= self.storage.len) {
            @memcpy(&self.storage, chunk[chunk.len - self.storage.len ..]);
            self.len = self.storage.len;
            return;
        }
        const retained = @min(self.len, self.storage.len - chunk.len);
        std.mem.copyForwards(u8, self.storage[0..retained], self.storage[self.len - retained .. self.len]);
        @memcpy(self.storage[retained..][0..chunk.len], chunk);
        self.len = retained + chunk.len;
    }

    pub fn bytes(self: *const Output) []const u8 {
        return self.storage[0..self.len];
    }

    fn write(self: *const Output, writer: *std.Io.Writer, name: []const u8) !void {
        try writer.print("{s}: {d} bytes", .{ name, self.total });
        if (self.total > self.len) try writer.print(" (truncated; last {d} bytes retained)", .{self.len});
        try writer.print("\n{s}\n", .{self.bytes()});
    }
};

pub const Result = struct {
    term: std.process.Child.Term,
    stdout: Output = .{},
    stderr: Output = .{},

    pub fn writeFailure(self: *const Result, writer: *std.Io.Writer, operation: []const u8, executable: []const u8) !void {
        // No argv or environment dump: operations have fixed caller-owned
        // labels, and only the failed tool's bounded output is retained.
        try writer.print("[electrobun windows command] operation={s} executable={s} ", .{ operation, executable });
        switch (self.term) {
            .exited => |code| try writer.print("exitCode={d}\n", .{code}),
            .signal => |signal| try writer.print("signal={t}\n", .{signal}),
            .stopped => |signal| try writer.print("stopped={t}\n", .{signal}),
            .unknown => |code| try writer.print("unknownStatus={d}\n", .{code}),
        }
        try self.stdout.write(writer, "stdout");
        try self.stderr.write(writer, "stderr");
    }
};

pub fn run(allocator: std.mem.Allocator, io: std.Io, argv: []const []const u8) !Result {
    var child = try std.process.spawn(io, .{
        .argv = argv,
        .stdin = .ignore,
        .stdout = .pipe,
        .stderr = .pipe,
        .create_no_window = true,
    });
    defer child.kill(io);
    var streams: std.Io.File.MultiReader.Buffer(2) = undefined;
    var reader: std.Io.File.MultiReader = undefined;
    reader.init(allocator, io, streams.toStreams(), &.{ child.stdout.?, child.stderr.? });
    defer reader.deinit();
    var result: Result = .{ .term = undefined };
    while (reader.fill(1024, .none)) |_| {
        for ([_]*Output{ &result.stdout, &result.stderr }, 0..) |output, index| {
            const stream = reader.reader(index);
            output.append(stream.buffered());
            stream.tossBuffered();
        }
    } else |err| switch (err) {
        error.EndOfStream => {},
        else => return err,
    }
    try reader.checkAnyError();
    result.term = try child.wait(io);
    return result;
}

fn testCommand(exit_code: u8) !Result {
    const allocator = std.testing.allocator;
    if (builtin.os.tag == .windows) {
        const system = try std.unicode.wtf16LeToWtf8Alloc(allocator, std.os.windows.getSystemDirectoryWtf16Le());
        defer allocator.free(system);
        const executable = try std.fs.path.join(allocator, &.{ system, "WindowsPowerShell", "v1.0", "powershell.exe" });
        defer allocator.free(executable);
        const script = try std.fmt.allocPrint(
            allocator,
            "[Console]::Out.Write(('o' * 65536) + 'out-tail'); [Console]::Error.Write(('e' * 65536) + 'err-tail'); exit {d}",
            .{exit_code},
        );
        defer allocator.free(script);
        return run(allocator, std.testing.io, &.{ executable, "-NoProfile", "-NonInteractive", "-Command", script });
    }
    const script = try std.fmt.allocPrint(
        allocator,
        "printf '%0*d' 65536 0; printf out-tail; printf '%0*d' 65536 0 >&2; printf err-tail >&2; exit {d}",
        .{exit_code},
    );
    defer allocator.free(script);
    return run(allocator, std.testing.io, &.{ "/bin/sh", "-c", script });
}

test "failed command drains both pipes and reports operation status and bounded output" {
    const result = try testCommand(7);
    try std.testing.expectEqual(@as(u8, 7), result.term.exited);
    for ([_]*const Output{ &result.stdout, &result.stderr }) |output| {
        try std.testing.expectEqual(@as(u64, 65544), output.total);
        try std.testing.expectEqual(output_limit, output.len);
    }
    try std.testing.expect(std.mem.endsWith(u8, result.stdout.bytes(), "out-tail"));
    try std.testing.expect(std.mem.endsWith(u8, result.stderr.bytes(), "err-tail"));
    var buffer: [2 * output_limit + 1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    try result.writeFailure(&writer, "preflight-desktop-shortcut", "powershell.exe");
    const diagnostic = writer.buffered();
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "operation=preflight-desktop-shortcut executable=powershell.exe exitCode=7") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "stderr: 65544 bytes (truncated; last 4096 bytes retained)") != null);
    try std.testing.expect(std.mem.endsWith(u8, diagnostic, "err-tail\n"));
    try std.testing.expect(diagnostic.len < buffer.len);
}

test "verbose successful command retains its successful status" {
    const result = try testCommand(0);
    try std.testing.expect(result.term.success());
    try std.testing.expect(result.stdout.total > output_limit);
    try std.testing.expect(result.stderr.total > output_limit);
}

test "bounded output retains the exact tail across uneven writes" {
    var output: Output = .{};
    const prefix: [output_limit - 2]u8 = @splat('a');
    output.append(&prefix);
    output.append("bcde");
    try std.testing.expectEqual(output_limit, output.len);
    try std.testing.expectEqual(@as(u64, output_limit + 2), output.total);
    try std.testing.expect(std.mem.endsWith(u8, output.bytes(), "abcde"));
}
