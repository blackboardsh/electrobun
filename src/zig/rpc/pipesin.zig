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

const alloc = std.heap.page_allocator;

var messageQueue = std.ArrayList([]const u8).init(alloc);
var kqueue: std.os.fd_t = 0;

pub fn pipesInEventListener() void {
    kqueue = std.os.kqueue() catch {
        std.log.err("Failed to create kqueue", .{});
        return;
    };
    defer std.os.close(kqueue);

    const mainPipeIn = blk: {
        const bunPipeInPath = "/private/tmp/electrobun_ipc_pipe_my-app-id_main";
        const bunPipeInFileResult = std.fs.cwd().openFile(bunPipeInPath, .{ .mode = .read_only });

        if (bunPipeInFileResult) |file| {
            break :blk file;
        } else |err| {
            std.debug.print("Failed to open file: {}\n", .{err});
            break :blk null;
        }
    };

    if (mainPipeIn) |pipeInFile| {
        addPipe(pipeInFile.handle, 0);
    }

    var events: [10]std.os.Kevent = undefined; // todo: Adjust based on expected concurrency
    var changelist: []std.os.Kevent = &[_]std.os.Kevent{};

    // Event loop
    while (true) {
        const n = std.os.kevent(kqueue, changelist, &events, null) catch |err| {
            std.log.err("Error in kevent: {}", .{err});
            continue;
        };

        for (0..n) |i| {
            const ev = events[i];
            // Check ev.ident to see which fd has an event
            if (ev.filter == std.os.darwin.EVFILT_READ) {
                // Note: readLineFromPipe reads until the end of the buffer or the delimeter.
                // so the buffer is the max size of a line.
                // setting it to 1MB
                var buffer: [1024 * 1024]u8 = undefined;
                const bytesRead = readLineFromPipe(&buffer, ev.ident);

                if (bytesRead) |line| {
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

pub fn addPipe(fd: std.os.fd_t, webviewId: u32) void {
    var events: [10]std.os.Kevent = undefined;
    var event = std.os.Kevent{
        .ident = @as(usize, @intCast(fd)),
        .filter = std.os.darwin.EVFILT_READ,
        .flags = std.os.darwin.EV_ADD | std.os.darwin.EV_ENABLE,
        .fflags = 0,
        .data = 0,
        // The .udata field is typically used to store user-defined data or a pointer to user-defined data that can be retrieved when an event occurs.
        // this could be the id of the window/webview
        .udata = @as(usize, @intCast(webviewId)),
    };

    var changes: [1]std.os.Kevent = undefined;
    changes[0] = event;

    // Register the event
    const nev = std.os.kevent(kqueue, &changes, &events, null) catch |err| {
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
    // var buffer: [1024]u8 = undefined;

    const bytesRead = pipeReader.readUntilDelimiterOrEof(buffer, '\n') catch return null;

    if (bytesRead) |line| {
        return line;
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
        const _response = std.json.parseFromSlice(rpcTypes._RPCResponsePacketSuccess, alloc, line, .{}) catch |err| {
            std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            return;
        };
        // handle response
        rpcStdout.setResponse(messageWithType.value.id, _response.value.payload);
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
