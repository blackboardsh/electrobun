const std = @import("std");
const json = std.json;
const posix = std.posix;

const MessageType = enum {
    spawn,
    input,
    resize,
    shutdown,
    get_cwd,
};

const SpawnMessage = struct {
    shell: []const u8,
    cwd: []const u8,
    cols: u32,
    rows: u32,
};

const InputMessage = struct {
    data: []const u8,
};

const ResizeMessage = struct {
    cols: u32,
    rows: u32,
};

const Message = struct {
    type: MessageType,
    spawn: ?SpawnMessage = null,
    input: ?InputMessage = null,
    resize: ?ResizeMessage = null,
};

const OutputMessage = struct {
    type: []const u8,
    data: ?[]const u8 = null,
    error_msg: ?[]const u8 = null,
};

var allocator: std.mem.Allocator = undefined;
var pty_master: ?posix.fd_t = null;
var child_pid: ?posix.pid_t = null;

fn openPty() !posix.fd_t {
    const c = @cImport({
        @cInclude("stdlib.h");
        @cInclude("unistd.h");
        @cInclude("fcntl.h");
        @cInclude("sys/ioctl.h");
        @cInclude("termios.h");
    });

    const master_fd = c.open("/dev/ptmx", c.O_RDWR);
    if (master_fd < 0) {
        return error.OpenFailed;
    }

    if (c.grantpt(master_fd) != 0) {
        return error.GrantPtFailed;
    }

    if (c.unlockpt(master_fd) != 0) {
        return error.UnlockPtFailed;
    }

    return @intCast(master_fd);
}

fn getPtyName(master_fd: posix.fd_t) ![]const u8 {
    const c = @cImport({
        @cInclude("stdlib.h");
    });

    const name_ptr = c.ptsname(@intCast(master_fd));
    if (name_ptr == null) {
        return error.PtsNameFailed;
    }

    const name_len = std.mem.len(name_ptr);
    const name = try allocator.dupe(u8, name_ptr[0..name_len]);
    return name;
}

fn spawnShell(shell: []const u8, cwd: []const u8, cols: u32, rows: u32) !void {
    pty_master = try openPty();
    const pty_name = try getPtyName(pty_master.?);
    defer allocator.free(pty_name);

    const c = @cImport({
        @cInclude("unistd.h");
        @cInclude("fcntl.h");
        @cInclude("sys/ioctl.h");
        @cInclude("termios.h");
        @cInclude("stdlib.h");
    });

    const pid = c.fork();
    if (pid < 0) {
        return error.ForkFailed;
    }

    if (pid == 0) {
        const pty_name_z = try allocator.dupeZ(u8, pty_name);
        defer allocator.free(pty_name_z);

        const slave_fd = c.open(pty_name_z.ptr, c.O_RDWR);
        if (slave_fd < 0) {
            return error.SlaveOpenFailed;
        }

        _ = c.setsid();
        _ = c.ioctl(slave_fd, c.TIOCSCTTY, @as(c_int, 0));

        var winsize = c.struct_winsize{
            .ws_row = @intCast(rows),
            .ws_col = @intCast(cols),
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        _ = c.ioctl(slave_fd, c.TIOCSWINSZ, &winsize);

        _ = c.dup2(slave_fd, 0);
        _ = c.dup2(slave_fd, 1);
        _ = c.dup2(slave_fd, 2);

        _ = c.close(slave_fd);
        _ = c.close(@intCast(pty_master.?));

        const cwd_z = try allocator.dupeZ(u8, cwd);
        defer allocator.free(cwd_z);
        _ = c.chdir(cwd_z.ptr);

        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);

        const shell_z = try allocator.dupeZ(u8, shell);
        defer allocator.free(shell_z);
        const login_flag_z = try allocator.dupeZ(u8, "-l");
        defer allocator.free(login_flag_z);

        const args = [_:null]?[*:0]u8{ shell_z.ptr, login_flag_z.ptr, null };
        _ = c.execvp(shell_z.ptr, &args);
        c.exit(1);
    } else {
        child_pid = pid;

        output_thread = std.Thread.spawn(.{}, readPtyOutput, .{}) catch |err| {
            const error_str = try std.fmt.allocPrint(allocator, "Failed to start output thread: {}", .{err});
            defer allocator.free(error_str);
            try sendOutputMessage("error", null, error_str);
            return;
        };

        sendOutputMessage("ready", null, null) catch {};
    }
}

fn writeToShell(data: []const u8) !void {
    if (pty_master) |master| {
        const c = @cImport({
            @cInclude("unistd.h");
        });
        _ = c.write(@intCast(master), data.ptr, data.len);
    }
}

fn getCurrentWorkingDirectory() !void {
    if (child_pid) |pid| {
        const c = @cImport({
            @cInclude("libproc.h");
            @cInclude("stdlib.h");
        });

        var path_buffer: [4096]u8 = undefined;
        const result = c.proc_pidpath(@intCast(pid), &path_buffer, path_buffer.len);

        if (result > 0) {
            const vnodepathinfo_size = @sizeOf(c.proc_vnodepathinfo);
            var vnode_info: c.proc_vnodepathinfo = undefined;

            const info_result = c.proc_pidinfo(@intCast(pid), c.PROC_PIDVNODEPATHINFO, 0, &vnode_info, vnodepathinfo_size);

            if (info_result == vnodepathinfo_size) {
                const cwd_path = std.mem.sliceTo(&vnode_info.pvi_cdir.vip_path, 0);
                try sendOutputMessage("cwd_update", cwd_path, null);
            } else {
                try sendOutputMessage("error", null, "Failed to get CWD via proc_pidinfo");
            }
        } else {
            try sendOutputMessage("error", null, "Failed to get process info");
        }
    }
}

fn resizeTerminal(cols: u32, rows: u32) !void {
    if (pty_master) |master| {
        const c = @cImport({
            @cInclude("sys/ioctl.h");
            @cInclude("termios.h");
        });

        var winsize = c.struct_winsize{
            .ws_row = @intCast(rows),
            .ws_col = @intCast(cols),
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };

        _ = c.ioctl(@intCast(master), c.TIOCSWINSZ, &winsize);
    }
}

fn processCwdUpdates(input: []const u8) ![]const u8 {
    const escape_start = "\x1b]9999;";
    const escape_end = "\x07";

    var result = std.ArrayList(u8).init(allocator);
    defer result.deinit();

    var i: usize = 0;
    while (i < input.len) {
        if (i + escape_start.len < input.len and std.mem.eql(u8, input[i..i + escape_start.len], escape_start)) {
            const start_pos = i + escape_start.len;
            if (std.mem.indexOf(u8, input[start_pos..], escape_end)) |end_offset| {
                const end_pos = start_pos + end_offset;
                const cwd_path = input[start_pos..end_pos];
                sendOutputMessage("cwd_update", cwd_path, null) catch {};
                i = end_pos + escape_end.len;
                continue;
            }
        }

        try result.append(input[i]);
        i += 1;
    }

    return result.toOwnedSlice();
}

fn sendOutputMessage(msg_type: []const u8, data: ?[]const u8, error_msg: ?[]const u8) !void {
    const msg = OutputMessage{
        .type = msg_type,
        .data = data,
        .error_msg = error_msg,
    };

    var string = std.ArrayList(u8).init(allocator);
    defer string.deinit();

    try json.stringify(msg, .{}, string.writer());
    try string.append('\n');

    const c = @cImport({
        @cInclude("unistd.h");
    });
    _ = c.write(1, string.items.ptr, string.items.len);
}

fn readPtyOutput() !void {
    if (pty_master) |master| {
        var buffer: [4096]u8 = undefined;
        var accumulated_buffer = std.ArrayList(u8).init(allocator);
        defer accumulated_buffer.deinit();

        const c = @cImport({
            @cInclude("unistd.h");
            @cInclude("errno.h");
        });

        while (true) {
            const bytes_read = c.read(@intCast(master), &buffer, buffer.len);
            if (bytes_read < 0) {
                const errno_val = c.__error().*;
                if (errno_val == c.EAGAIN or errno_val == c.EWOULDBLOCK) {
                    continue;
                } else {
                    break;
                }
            }

            if (bytes_read == 0) break;

            const output = buffer[0..@intCast(bytes_read)];
            try accumulated_buffer.appendSlice(output);

            const processed_output = try processCwdUpdates(accumulated_buffer.items);
            defer allocator.free(processed_output);

            accumulated_buffer.clearRetainingCapacity();
            sendOutputMessage("data", processed_output, null) catch {};
        }
    }
}

fn handleMessage(message: []const u8) !void {
    var parsed = json.parseFromSlice(Message, allocator, message, .{}) catch {
        try sendOutputMessage("error", null, "Invalid JSON message");
        return;
    };
    defer parsed.deinit();

    const msg = parsed.value;

    switch (msg.type) {
        .spawn => {
            if (msg.spawn) |spawn_data| {
                spawnShell(spawn_data.shell, spawn_data.cwd, spawn_data.cols, spawn_data.rows) catch |err| {
                    const error_str = try std.fmt.allocPrint(allocator, "Failed to spawn shell: {}", .{err});
                    defer allocator.free(error_str);
                    try sendOutputMessage("error", null, error_str);
                };
            }
        },
        .input => {
            if (msg.input) |input_data| {
                writeToShell(input_data.data) catch |err| {
                    const error_str = try std.fmt.allocPrint(allocator, "Failed to write input: {}", .{err});
                    defer allocator.free(error_str);
                    try sendOutputMessage("error", null, error_str);
                };
            }
        },
        .resize => {
            if (msg.resize) |resize_data| {
                resizeTerminal(resize_data.cols, resize_data.rows) catch |err| {
                    const error_str = try std.fmt.allocPrint(allocator, "Failed to resize: {}", .{err});
                    defer allocator.free(error_str);
                    try sendOutputMessage("error", null, error_str);
                };
            }
        },
        .shutdown => {
            if (child_pid) |pid| {
                const c = @cImport({
                    @cInclude("signal.h");
                });
                _ = c.kill(pid, c.SIGTERM);
            }
            return;
        },
        .get_cwd => {
            getCurrentWorkingDirectory() catch |err| {
                const error_str = try std.fmt.allocPrint(allocator, "Failed to get CWD: {}", .{err});
                defer allocator.free(error_str);
                try sendOutputMessage("error", null, error_str);
            };
        },
    }
}

var output_thread: ?std.Thread = null;

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    allocator = gpa.allocator();

    const stdin = std.io.getStdIn().reader();
    var buffer: [8192]u8 = undefined;

    while (true) {
        if (try stdin.readUntilDelimiterOrEof(buffer[0..], '\n')) |line| {
            handleMessage(line) catch |err| {
                const error_str = try std.fmt.allocPrint(allocator, "Message handling error: {}", .{err});
                defer allocator.free(error_str);
                sendOutputMessage("error", null, error_str) catch {};
            };
        } else {
            break;
        }
    }

    if (output_thread) |thread| {
        thread.join();
    }

    if (child_pid) |pid| {
        const c = @cImport({
            @cInclude("signal.h");
            @cInclude("unistd.h");
        });
        _ = c.kill(pid, c.SIGTERM);
    }

    if (pty_master) |master| {
        const c = @cImport({
            @cInclude("unistd.h");
        });
        _ = c.close(@intCast(master));
    }
}
