const std = @import("std");
const json = std.json;
const posix = std.posix;
const print = std.debug.print;

// Message types for JSON communication
const MessageType = enum {
    spawn,
    input,
    resize,
    shutdown,
    get_cwd,
};

// Message structures
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

// PTY utilities
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
    // Open PTY
    pty_master = try openPty();
    const pty_name = try getPtyName(pty_master.?);
    defer allocator.free(pty_name);
    
    // Fork process  
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
        // Child process - setup shell with PTY
        
        // Open slave side of PTY - need to create null-terminated string
        const pty_name_z = try allocator.dupeZ(u8, pty_name);
        defer allocator.free(pty_name_z);
        
        const slave_fd = c.open(pty_name_z.ptr, c.O_RDWR);
        if (slave_fd < 0) {
            return error.SlaveOpenFailed;
        }
        
        // Create a new session
        _ = c.setsid();
        
        // Set controlling terminal
        _ = c.ioctl(slave_fd, c.TIOCSCTTY, @as(c_int, 0));
        
        // Set terminal size
        var winsize = c.struct_winsize{
            .ws_row = @intCast(rows),
            .ws_col = @intCast(cols),
            .ws_xpixel = 0,
            .ws_ypixel = 0,
        };
        _ = c.ioctl(slave_fd, c.TIOCSWINSZ, &winsize);
        
        // Redirect stdio to PTY slave
        _ = c.dup2(slave_fd, 0); // STDIN
        _ = c.dup2(slave_fd, 1); // STDOUT 
        _ = c.dup2(slave_fd, 2); // STDERR
        
        // Close PTY fds in child
        _ = c.close(slave_fd);
        _ = c.close(@intCast(pty_master.?));
        
        // Change to working directory
        const cwd_z = try allocator.dupeZ(u8, cwd);
        defer allocator.free(cwd_z);
        _ = c.chdir(cwd_z.ptr);
        
        // Setup environment - inherit from parent and add terminal specific vars
        _ = c.setenv("TERM", "xterm-256color", 1);
        _ = c.setenv("COLORTERM", "truecolor", 1);
        
        // For now, let's skip the shell hooks and use a simpler approach
        // We'll implement CWD tracking differently
        
        // Execute shell as login shell to get full environment
        const shell_z = try allocator.dupeZ(u8, shell);
        defer allocator.free(shell_z);

        // Use -l flag to make it a login shell (sources profile files)
        const login_flag = "-l";
        const login_flag_z = try allocator.dupeZ(u8, login_flag);
        defer allocator.free(login_flag_z);

        const args = [_:null]?[*:0]u8{ shell_z.ptr, login_flag_z.ptr, null };
        _ = c.execvp(shell_z.ptr, &args);
        
        // If we get here, execvpe failed
        c.exit(1);
    } else {
        // Parent process - store child PID
        child_pid = pid;
        
        // Start output reading thread now that PTY is created
        output_thread = std.Thread.spawn(.{}, readPtyOutput, .{}) catch |err| {
            const error_str = try std.fmt.allocPrint(allocator, "Failed to start output thread: {}", .{err});
            defer allocator.free(error_str);
            try sendOutputMessage("error", null, error_str);
            return;
        };
        
        // Send ready message
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
        
        // Allocate buffer for the path
        var path_buffer: [4096]u8 = undefined;
        
        // Use proc_pidpath to get the current working directory on macOS
        const result = c.proc_pidpath(@intCast(pid), &path_buffer, path_buffer.len);
        
        if (result > 0) {
            // Success - we got the executable path, but we need the CWD
            // Let's try a different approach using proc_pidinfo
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
    // Look for our special CWD escape sequence: \033]9999;/path/to/dir\007
    const escape_start = "\x1b]9999;";
    const escape_end = "\x07";
    
    // We no longer need to process escape sequences since we're using direct queries
    
    var result = std.ArrayList(u8).init(allocator);
    defer result.deinit();
    
    var i: usize = 0;
    while (i < input.len) {
        if (i + escape_start.len < input.len and std.mem.eql(u8, input[i..i + escape_start.len], escape_start)) {
            // Found start of CWD escape sequence
            // Found start of CWD escape sequence
            const start_pos = i + escape_start.len;
            
            // Look for the end marker
            if (std.mem.indexOf(u8, input[start_pos..], escape_end)) |end_offset| {
                const end_pos = start_pos + end_offset;
                const cwd_path = input[start_pos..end_pos];
                
                // Found CWD path
                
                // Send CWD update message
                sendOutputMessage("cwd_update", cwd_path, null) catch {};
                
                // Skip this escape sequence in the output
                i = end_pos + escape_end.len;
                continue;
            }
        }
        
        // Regular character, add to result
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
    _ = c.write(1, string.items.ptr, string.items.len); // STDOUT_FILENO = 1
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
            
            // Add to accumulated buffer for processing escape sequences
            try accumulated_buffer.appendSlice(output);
            
            // Process the accumulated buffer for CWD updates
            const processed_output = try processCwdUpdates(accumulated_buffer.items);
            defer allocator.free(processed_output);
            
            // Clear the accumulated buffer and add any remaining data
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
    
    // Read stdin line by line for commands
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
            break; // EOF
        }
    }
    
    // Cleanup
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