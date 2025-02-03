const dispatch = @cImport({
    @cInclude("dispatch/dispatch.h");
});
const std = @import("std");
const rpcSchema = @import("schema/schema.zig");
const rpcTypes = @import("types.zig");
const rpcStdout = @import("stdout.zig");
const rpcHandlers = @import("schema/handlers.zig");
const handlers = rpcHandlers.handlers;
const webview = @import("../macos/webview.zig");
const builtin = @import("builtin");

const alloc = std.heap.page_allocator;

var messageQueue = std.ArrayList([]const u8).init(alloc);

var kqueue: std.posix.fd_t = 0; // On macOS/Linux this will be i32, on Windows it will be HANDLE.

pub fn pipesInEventListener() !void {
    kqueue = std.posix.kqueue() catch {
        std.log.err("Failed to create kqueue", .{});
        return;
    };
    defer std.posix.close(kqueue);

    const mainPipeIn = blk: {
        // This is passed as an environment variable from bun
        const MAIN_PIPE_IN = std.posix.getenv("MAIN_PIPE_IN") orelse {
            // todo: return an error here
            return error.ELECTROBUN_MAIN_PIPE_IN_NOT_SET;
        };
        const bunPipeInPath = MAIN_PIPE_IN;
        const bunPipeInFileResult = std.fs.cwd().openFile(bunPipeInPath, .{ .mode = .read_only });

        if (bunPipeInFileResult) |file| {
            break :blk file;
        } else |err| {
            std.debug.print("Failed to main pipe file: {}\n", .{err});
            break :blk null;
        }
    };

    if (mainPipeIn) |pipeInFile| {
        addPipe(pipeInFile.handle, 0);
    }

    var events: [10]std.posix.Kevent = undefined; // todo: Adjust based on expected concurrency
    const changelist: []std.posix.Kevent = &[_]std.posix.Kevent{};

    // Event loop
    while (true) {
        const n = std.posix.kevent(kqueue, changelist, &events, null) catch |err| {
            std.log.err("Error in kevent: {}", .{err});
            continue;
        };

        for (0..n) |i| {
            const ev = events[i];
            // Check ev.ident to see which fd has an event
            if (ev.filter == std.c.EVFILT_READ) {
                // Note: readLineFromPipe reads until the end of the buffer or the delimeter.
                // so the buffer has to fit the whole line after the chunks have been joined.
                // setting it to 10MB for now. todo: make this dynamic after upgrading to latest
                // zig version
                var buffer: [1024 * 1024 * 10]u8 = undefined;
                const bytesRead = readLineFromPipe(&buffer, ev.ident);

                if (bytesRead) |line| {
                    // std.debug.print("pipesin line: {s}", .{line});
                    if (mainPipeIn != null and mainPipeIn.?.handle == ev.ident) {
                        // todo: do we need both this and stdin.zig
                        handleLineFromMainPipe(line);
                    } else {
                        webview.sendLineToWebview(@intCast(ev.udata), line);
                    }
                }

                // The fd is ready to be read
                // Proceed to read from the fd
                // .ident is the file descriptor
                // .data is the number of bytes available to read
                // .udata is the window/webview id

            }
        }
    }
}

pub fn addPipe(fd: std.posix.fd_t, webviewId: u32) void {
    var events: [10]std.posix.Kevent = undefined;
    const event = std.posix.Kevent{
        .ident = @as(usize, @intCast(fd)),
        .filter = std.c.EVFILT_READ,
        .flags = std.c.EV_ADD | std.c.EV_ENABLE,
        .fflags = 0,
        .data = 0,
        // The .udata field is typically used to store user-defined data or a pointer to user-defined data that can be retrieved when an event occurs.
        // this could be the id of the window/webview
        .udata = @as(usize, @intCast(webviewId)),
    };

    var changes: [1]std.posix.Kevent = undefined;
    changes[0] = event;

    // Register the event
    const nev = std.posix.kevent(kqueue, &changes, &events, null) catch |err| {
        std.log.err("Failed to register kqueue event: {}\n", .{err});
        return;
    };

    if (nev == -1) {
        std.log.err("Failed to register kqueue event", .{});
        return;
    }
}

pub fn readLineFromPipe(buffer: []u8, fd: usize) ?[]const u8 {
    // Wrap the file descriptor in a std.os.File
    const file = std.fs.File{ .handle = @as(c_int, @intCast(fd)) };

    // Create a buffered reader for more efficient reading
    var pipeReader = file.reader();
    // Create a FixedBufferStream to hold the data
    var fbs = std.io.fixedBufferStream(buffer);
    _ = pipeReader.streamUntilDelimiter(fbs.writer(), '\n', null) catch return null;
    const output = fbs.getWritten();

    if (output.len > 0) {
        // Return the slice of the buffer with the data that was read
        return output[0..output.len];
    } else {
        return null;
    }
}

pub fn handleLineFromMainPipe(line: []const u8) void {
    const messageWithType = std.json.parseFromSlice(rpcTypes._RPCMessage, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
        std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
        return;
    };

    if (std.mem.eql(u8, messageWithType.value.type, "response")) {
        // todo: handle _RPCResponsePacketError
        const lineCopy = alloc.dupe(u8, line) catch {
            // Handle the error here, e.g., log it or set a default value
            std.debug.print("Error: {s}\n", .{line});
            return;
        };
        // rpcStdout.setResponse(messageWithType.value.id, lineCopy);
        // Todo: handle response
        _ = lineCopy;
    } else {
        // Handle UI events on main thread
        // since line is re-used we need to copy it to the heap
        const lineCopy = alloc.dupe(u8, line) catch {
            // Handle the error here, e.g., log it or set a default value
            std.debug.print("Error: {s}\n", .{line});
            return;
        };

        messageQueue.append(lineCopy) catch {
            std.log.info("Error appending to messageQueue: \nreceived: {s}", .{line});
            return;
        };

        dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), null, processMessageQueue);
    }
}

fn processMessageQueue(context: ?*anyopaque) callconv(.C) void {
    _ = context;

    const line = messageQueue.orderedRemove(0);
    defer alloc.free(line);

    // Do the main json parsing work on the stdin thread, add it to a queue, and then
    // process the generic jobs on the main thread
    const json = std.json.parseFromSlice(std.json.Value, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
        std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
        return;
    };

    defer json.deinit();

    const msgType = blk: {
        const obj = json.value.object.get("type").?;
        break :blk obj.string;
    };

    if (std.mem.eql(u8, msgType, "request")) {
        const _request = std.json.parseFromValue(rpcTypes._RPCRequestPacket, alloc, json.value, .{}) catch |err| {
            std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            return;
        };

        const result = rpcHandlers.handleRequest(_request.value);

        if (result.errorMsg == null) {
            rpcStdout.sendResponseSuccess(_request.value.id, result.payload);
        } else {
            rpcStdout.sendResponseError(_request.value.id, result.errorMsg.?);
        }
    } else if (std.mem.eql(u8, msgType, "message")) {
        // todo: rpcHandlers.handleMessage(json.value);
        std.log.info("it's a message meatball", .{});
    } else {
        std.log.info("it's an unhandled meatball", .{});
    }
}
