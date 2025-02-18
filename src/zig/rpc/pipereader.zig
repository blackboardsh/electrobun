const std = @import("std");
const builtin = @import("builtin");
const rpcSchema = @import("schema/schema.zig");
const rpcTypes = @import("types.zig");
const rpcStdout = @import("stdout.zig");
const rpcHandlers = @import("schema/handlers.zig");
const handlers = rpcHandlers.handlers;
const webview = @import("../macos/webview.zig");

pub const PipeReader = struct {
    const Error = error{
        MainPipeNotSet,
        PipeCreationFailed,
        PipeReadFailed,
        OutOfMemory,
    };

    const MacOS = struct {
        const dispatch = @cImport({
            @cInclude("dispatch/dispatch.h");
        });
    };

    const Windows = struct {
        const WINAPI = std.os.windows;
        const HANDLE = WINAPI.HANDLE;
        const OVERLAPPED = WINAPI.OVERLAPPED;
        const DWORD = WINAPI.DWORD;
        const LPOVERLAPPED = *OVERLAPPED;
        const INFINITE = WINAPI.INFINITE;
        const kernel32 = WINAPI.kernel32;
        const WAIT_FAILED = @as(DWORD, @bitCast(@as(i32, -1))); // 0xFFFFFFFF
        const WAIT_OBJECT_0 = 0;

        const PipeState = struct {
            handle: HANDLE,
            overlapped: OVERLAPPED,
            buffer: []u8,
            allocator: std.mem.Allocator,
            webview_id: WebviewId,

            fn init(allocator: std.mem.Allocator, handle: HANDLE, id: WebviewId) !*PipeState {
                const state = try allocator.create(PipeState);
                state.* = .{
                    .handle = handle,
                    .overlapped = std.mem.zeroes(OVERLAPPED),
                    .buffer = try allocator.alloc(u8, BufferSize),
                    .allocator = allocator,
                    .webview_id = id,
                };
                return state;
            }

            fn deinit(self: *PipeState) void {
                self.allocator.free(self.buffer);
                WINAPI.CloseHandle(self.handle);
                self.allocator.destroy(self);
            }
        };

        var pipe_states = std.ArrayList(*PipeState).init(std.heap.page_allocator);
    };

    const BufferSize = 1024 * 1024 * 10;
    const WebviewId = u32;

    allocator: std.mem.Allocator,
    message_queue: std.ArrayList([]const u8),
    platform_data: union(enum) {
        macos: struct {
            kqueue_fd: ?std.posix.fd_t,
        },
        windows: struct {
            event_loop_running: bool,
        },
    },

    pub fn init(allocator: std.mem.Allocator) !PipeReader {
        return PipeReader{
            .allocator = allocator,
            .message_queue = std.ArrayList([]const u8).init(allocator),
            .platform_data = switch (builtin.target.os.tag) {
                .macos => .{ .macos = .{ .kqueue_fd = null } },
                .windows => .{ .windows = .{ .event_loop_running = false } },
                else => @compileError("Unsupported operating system"),
            },
        };
    }

    pub fn deinit(self: *PipeReader) void {
        switch (self.platform_data) {
            .macos => |*data| {
                if (data.kqueue_fd) |fd| {
                    std.posix.close(fd);
                }
            },
            .windows => {
                for (Windows.pipe_states.items) |state| {
                    state.deinit();
                }
                Windows.pipe_states.deinit();
            },
        }

        for (self.message_queue.items) |item| {
            self.allocator.free(item);
        }
        self.message_queue.deinit();
    }

    fn initPlatform(self: *PipeReader) !void {
        switch (builtin.target.os.tag) {
            .macos => {
                self.platform_data.macos.kqueue_fd = try std.posix.kqueue();
            },
            .windows => {
                if (!self.platform_data.windows.event_loop_running) {
                    // Windows initialization is done per-pipe
                    self.platform_data.windows.event_loop_running = true;
                }
            },
            else => @compileError("Unsupported operating system"),
        }
    }

    pub fn start(self: *PipeReader) !void {
        try self.initPlatform();

        // Set up main pipe
        const main_pipe = try self.openMainPipe();
        try self.addPipe(main_pipe, 0);

        try self.startEventLoop();
    }

    fn openMainPipe(self: *PipeReader) !std.fs.File {
        _ = self;

        // Use a global allocator; you may also pass an allocator as a parameter if needed.
        const allocator = std.heap.page_allocator;
        const pipe_path = std.process.getEnvVarOwned(allocator, "MAIN_PIPE_IN") catch {
            return Error.MainPipeNotSet;
        };

        // Attempt to open the file.
        const file = std.fs.cwd().openFile(pipe_path, .{ .mode = .read_only }) catch |err| {
            std.log.err("Failed to open main pipe: {}", .{err});
            allocator.free(pipe_path);
            return err;
        };

        // Free the allocated environment string.
        allocator.free(pipe_path);
        return file;
    }

    pub fn addPipe(self: *PipeReader, pipe: std.fs.File, id: WebviewId) !void {
        switch (builtin.target.os.tag) {
            .macos => try self.macOSAddPipe(pipe.handle, id),
            .windows => {
                try self.windowsAddPipe(pipe.handle, id);
            },
            else => @compileError("Unsupported operating system"),
        }
    }

    fn startEventLoop(self: *PipeReader) !void {
        switch (builtin.target.os.tag) {
            .macos => try self.macOSEventLoop(),
            .windows => try self.windowsEventLoop(),
            else => @compileError("Unsupported operating system"),
        }
    }

    // Windows-specific implementations
    fn windowsAddPipe(self: *PipeReader, handle: Windows.HANDLE, id: WebviewId) !void {
        const pipe_state = try Windows.PipeState.init(self.allocator, handle, id);
        try Windows.pipe_states.append(pipe_state);

        // Start the first async read
        try self.windowsStartRead(pipe_state);
    }

    fn windowsStartRead(self: *PipeReader, pipe_state: *Windows.PipeState) !void {
        _ = self;
        var bytes_read: Windows.DWORD = undefined;

        const success = Windows.kernel32.ReadFile(
            pipe_state.handle,
            pipe_state.buffer.ptr,
            @intCast(pipe_state.buffer.len),
            &bytes_read,
            &pipe_state.overlapped,
        );

        if (success == 0) {
            const err = Windows.kernel32.GetLastError();
            // Convert error code to integer for comparison
            const err_int = @intFromEnum(err);
            if (err_int != 997) { // ERROR_IO_PENDING
                std.log.err("Failed to start async read: {}", .{err});
                return Error.PipeReadFailed;
            }
        }
    }

    fn windowsEventLoop(self: *PipeReader) !void {
        while (self.platform_data.windows.event_loop_running) {
            // Create array of handles to wait on
            var handles = try self.allocator.alloc(Windows.HANDLE, Windows.pipe_states.items.len);
            defer self.allocator.free(handles);

            for (Windows.pipe_states.items, 0..) |state, i| {
                handles[i] = state.handle;
            }

            // Wait for any handle to signal
            const wait_result = Windows.kernel32.WaitForMultipleObjects(@intCast(handles.len), handles.ptr, @intFromBool(false), // wait for any handle
                Windows.INFINITE);

            if (wait_result == Windows.WAIT_FAILED) {
                const err = Windows.kernel32.GetLastError();
                std.log.err("Wait failed: {}", .{err});
                continue;
            }

            // Calculate which handle was signaled
            const signaled_index = wait_result - Windows.WAIT_OBJECT_0;
            if (signaled_index >= 0 and signaled_index < handles.len) {
                const pipe_state = Windows.pipe_states.items[@intCast(signaled_index)];

                // Get the completion status and process the data
                const bytes_read = windowsWaitForIoCompletion(pipe_state) catch |err| {
                    std.log.err("Failed to get IO completion: {}", .{err});
                    continue;
                };

                if (bytes_read > 0) {
                    const line = pipe_state.buffer[0..bytes_read];

                    if (pipe_state.webview_id == 0) {
                        // Main pipe
                        try PipeReader.handleMainPipeMessage(self.allocator, line);
                    } else {
                        webview.sendLineToWebview(pipe_state.webview_id, line);
                    }

                    // Start next read
                    try self.windowsStartRead(pipe_state);
                }
            }

            // Process any pending messages in the queue
            while (self.message_queue.items.len > 0) {
                processMessageQueue(@ptrCast(self));
            }
        }
    }

    fn windowsWaitForIoCompletion(pipe_state: *Windows.PipeState) !usize {
        var bytes_transferred: Windows.DWORD = undefined;
        const success = Windows.kernel32.GetOverlappedResult(
            pipe_state.handle,
            &pipe_state.overlapped,
            &bytes_transferred,
            @intFromBool(true), // wait for completion
        );

        if (success == 0) {
            const err = Windows.kernel32.GetLastError();
            std.log.err("IO completion failed: {}", .{err});
            return Error.PipeReadFailed;
        }

        return bytes_transferred;
    }

    // Existing macOS implementations remain the same...
    fn macOSEventLoop(self: *PipeReader) !void {
        comptime if (builtin.target.os.tag == .macos) {
            const kqueue_fd = self.platform_data.macos.kqueue_fd orelse return Error.PipeCreationFailed;
            var events: [10]std.posix.Kevent = undefined;
            const changelist = &[_]std.posix.Kevent{};

            while (true) {
                const n = try std.posix.kevent(
                    kqueue_fd,
                    changelist,
                    &events,
                    null,
                );

                for (events[0..n]) |ev| {
                    if (ev.filter == std.c.EVFILT_READ) {
                        var buffer: [BufferSize]u8 = undefined;
                        if (try self.readLine(&buffer, ev.ident)) |line| {
                            const source_id: WebviewId = @intCast(ev.udata);
                            if (source_id == 0) {
                                try PipeReader.handleMainPipeMessage(line);
                            } else {
                                webview.sendLineToWebview(source_id, line);
                            }
                        }
                    }
                }
            }
        };
    }

    fn macOSAddPipe(self: *PipeReader, fd: std.posix.fd_t, id: WebviewId) !void {
        comptime if (builtin.target.os.tag == .macos) {
            const kqueue_fd = self.platform_data.macos.kqueue_fd orelse return Error.PipeCreationFailed;

            var events: [10]std.posix.Kevent = undefined;
            const event = std.posix.Kevent{
                .ident = @as(usize, @intCast(fd)),
                .filter = std.c.EVFILT_READ,
                .flags = std.c.EV_ADD | std.c.EV_ENABLE,
                .fflags = 0,
                .data = 0,
                .udata = @as(usize, @intCast(id)),
            };

            var changes = [_]std.posix.Kevent{event};

            const result = try std.posix.kevent(
                kqueue_fd,
                &changes,
                &events,
                null,
            );

            if (result == -1) {
                return Error.PipeCreationFailed;
            }
        };
    }

    fn readLine(self: *PipeReader, buffer: []u8, fd: usize) !?[]const u8 {
        _ = self;
        const file = std.fs.File{ .handle = @as(c_int, @intCast(fd)) };
        var reader = file.reader();
        var fixed_buffer = std.io.fixedBufferStream(buffer);

        reader.streamUntilDelimiter(fixed_buffer.writer(), '\n', null) catch |err| {
            std.log.err("Failed to read from pipe: {}", .{err});
            return null;
        };

        const output = fixed_buffer.getWritten();
        return if (output.len > 0) output else null;
    }

    fn handleMainPipeMessage(allocator: std.mem.Allocator, line: []const u8) !void {
        const message = try std.json.parseFromSlice(
            rpcTypes._RPCMessage,
            allocator,
            line,
            .{ .ignore_unknown_fields = true },
        );
        defer message.deinit();

        if (std.mem.eql(u8, message.value.type, "response")) {
            // Handle response
            const line_copy = try allocator.dupe(u8, line);
            _ = line_copy; // TODO: handle response
        } else {
            const line_copy = try allocator.dupe(u8, line);

            if (global_reader) |*reader| {
                try reader.message_queue.append(line_copy);

                switch (builtin.target.os.tag) {
                    .macos => {
                        MacOS.dispatch.dispatch_async_f(
                            MacOS.dispatch.dispatch_get_main_queue(),
                            @ptrCast(&reader),
                            processMessageQueue,
                        );
                    },
                    .windows => {
                        // Queue will be processed in the event loop
                    },
                    else => @compileError("Unsupported operating system"),
                }
            } else {
                allocator.free(line_copy);
            }
        }
    }
};

fn processMessageQueue(context: ?*anyopaque) callconv(.C) void {
    const self = @as(*PipeReader, @ptrCast(@alignCast(context orelse return)));

    const line = self.message_queue.orderedRemove(0);
    defer self.allocator.free(line);

    const json = std.json.parseFromSlice(
        std.json.Value,
        self.allocator,
        line,
        .{ .ignore_unknown_fields = true },
    ) catch |err| {
        std.log.err("Error parsing message: {s}", .{@errorName(err)});
        return;
    };
    defer json.deinit();

    const msg_type = if (json.value.object.get("type")) |t| t.string else return;

    if (std.mem.eql(u8, msg_type, "request")) {
        const request = std.json.parseFromValue(
            rpcTypes._RPCRequestPacket,
            self.allocator,
            json.value,
            .{},
        ) catch |err| {
            std.log.err("Error parsing request: {s}", .{@errorName(err)});
            return;
        };

        const result = rpcHandlers.handleRequest(request.value);

        if (result.errorMsg == null) {
            rpcStdout.sendResponseSuccess(request.value.id, result.payload);
        } else {
            rpcStdout.sendResponseError(request.value.id, result.errorMsg.?);
        }
    }
}

// Global instance for backward compatibility
var global_reader: ?PipeReader = null;

pub fn initPipeReader() !void {
    if (global_reader != null) return;

    var reader = try PipeReader.init(std.heap.page_allocator);
    try reader.start();
    global_reader = reader;
}

pub fn addPipe(fd: std.fs.File, id: PipeReader.WebviewId) void {
    if (global_reader) |*reader| {
        reader.addPipe(fd, id) catch |err| {
            std.log.err("Failed to add pipe: {s}", .{@errorName(err)});
        };
    }
}
