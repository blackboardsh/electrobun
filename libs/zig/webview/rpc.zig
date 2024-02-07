// needed to access grand central dispatch to dispatch things from
// other threads to the main thread
const dispatch = @cImport({
    @cInclude("dispatch/dispatch.h");
});
const std = @import("std");
const window = @import("window.zig");
const rpcSchema = @import("rpcSchema.zig");
const rpcTypes = @import("rpcTypes.zig");
const rpcSenders = @import("rpcSenders.zig");
const handlers = @import("rpcHandlers.zig").handlers;

const alloc = std.heap.page_allocator;

// const MessageType = enum {
//     request,
//     response,
//     message,
// };

// const _RPCMessage = struct {
//     id: u32,
//     type: []const u8, // request, response, message
// };

// const _RPCRequestPacket = struct {
//     id: u32,
//     type: []const u8 = "request",
//     method: []const u8,
//     params: std.json.Value,
// };

// const _RPCResponsePacketSuccess = struct {
//     id: u32,
//     type: []const u8 = "response",
//     success: bool = true,
//     payload: ?std.json.Value,
// };

// const _RPCResponsePacketError = struct {
//     id: u32,
//     type: []const u8, // = "response",
//     success: bool, // = false,
//     // Note: error is a reserved key in zig so we have to cast it from error to msg
//     @"error": ?[]const u8, // error here is /Users/yoav/code/electrobun/libs/zig/webview/rpcAnywhere.zig:34:10: error: expected '.', found ':'
// };

// // const _RPCResponsePacket = _RPCResponsePacketSuccess | _RPCResponsePacketError;

// const _RPCMessagePacket = struct {
//     id: u32,
//     type: []const u8 = "message",
//     params: std.json.Value,
// };

// pub fn createRPC(ClientSchema: anytype, ServerSchema: anytype, Config: anytype) void {
//     std.log.info("Creating RPC", .{});
//     _ = ClientSchema;
//     _ = ServerSchema;
//     _ = Config;
//     const transport = createStdioTransport();

//     // const getHandler = Handler{};

//     // transport.registerHandler(getHandler.handler);
//     transport.registerHandler();

//     // return an instance with all the requests and things that call transport.send
// }

// I want to end up with const rpc = createRPC(ClientSchema, ServerSchema, Config)
// rpc.request.decideNavigation({url: 'http://google.com'}) // this should pause the thread
// and unpause the thread when it gets a reply
// and the functions in requestHandler should be called when their event type is created

// todo: so there's a message type
// which is either 0: event or 1: response
// 0: events are things bun wants to do (like open a window, set the title, etc.)
// 1: responses are things where zig is waiting for bun to respond to something like a navigation decision
// either
// {type: MessageType, subType: EventType or ResponseType, payload: any}
// or
// {eventType: ?EventType, responseType: ?ResponseType, payload: any}
// or
// {type: MessageType, payload: any} // where MessageType < 500 is an event and MessageType > 500 is a response

// We listen on stdin for stuff to do from bun and then dispatch it to the main thread where the gui stuff happens
fn stdInListener() void {
    const stdin = std.io.getStdIn().reader();
    // Note: this is a zig string.
    var buffer: [1024]u8 = undefined;

    while (true) {
        const bytesRead = stdin.readUntilDelimiterOrEof(&buffer, '\n') catch continue;
        if (bytesRead) |line| {
            std.log.info("received line: {s}", .{line});

            const messageWithType = std.json.parseFromSlice(rpcTypes._RPCMessage, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
                std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
                return;
            };

            std.log.info("parsed line {s}", .{messageWithType.value.type});
            if (std.mem.eql(u8, messageWithType.value.type, "response")) {

                // todo: handle _RPCResponsePacketError
                const _response = std.json.parseFromSlice(rpcTypes._RPCResponsePacketSuccess, alloc, line, .{}) catch |err| {
                    std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
                    return;
                };
                // handle response
                // _response = payload.allow;

                std.log.info("decide Navigation - {}", .{_response.value.payload.?});

                rpcSenders.setResponse(messageWithType.value.id, _response.value.payload);
            } else {
                // Handle UI events on main thread
                // since line is re-used we need to copy it to the heap
                const lineCopy = alloc.dupe(u8, line) catch {
                    // Handle the error here, e.g., log it or set a default value
                    std.debug.print("Error: {s}\n", .{line});
                    continue;
                };

                messageQueue.append(lineCopy) catch {
                    std.log.info("Error appending to messageQueue: \nreceived: {s}", .{line});
                    continue;
                };

                dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), null, processMessageQueue);

                std.log.info("sending over to main thread", .{});
            }

            // switch (messageWithType.value.type) {
            //     .request => {
            //         const _request = std.json.parseFromSlice(_RPCRequestPacket, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
            //             std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            //             return;
            //         };

            //         std.log.info("zig: received request: {d}", .{_request.value.id});
            //         if (std.mem.eql(u8, _request.value.method, "createWindow")) {
            //             const args = std.json.parseFromValue(BunSchema.requests.createWindow.args, alloc, _request.value.params, .{}) catch |err| {
            //                 std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            //                 return;
            //             };

            //             std.log.info("---> decideNAvigation handler {}", .{args.value.width});
            //             defer args.deinit();
            //         }
            //     },
            //     .response => {
            //         // todo: handle error shape
            //         const response = std.json.parseFromSlice(_RPCResponsePacketSuccess, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
            //             std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            //             return;
            //         };
            //         std.log.info("zig: received response: {d}", .{response.value.id});
            //         // handle response
            //         // look at the id, and unfreeze the thread that's waiting for a response returning the value
            //     },
            //     .message => {
            //         const message = std.json.parseFromSlice(_RPCMessagePacket, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
            //             std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
            //             return;
            //         };
            //         std.log.info("zig: received message: {d}", .{message.value.id});
            //         // handle message
            //         // call the message handler
            //     },
            // }

            // const messageFromBun = std.json.parseFromSlice(xp.xPromiseMessage, alloc, line, .{}) catch |err| {
            //     std.log.info("Error parsing wrapper from stdin - {}: \nreceived: {s}", .{ err, line });
            //     continue;
            // };

            // defer messageFromBun.deinit();
            // std.log.info("parsed line {}", .{messageFromBun.value.type});
            // // Handle blocking event responses

            // switch (messageFromBun.value.method) {
            //     // handle responses by unblocking the main thread and resolving the value from here
            //     .decideNavigation => {
            //         const payload = xp.decideNavigation.response(messageFromBun.value.payload);

            //         // const parsedPayload = std.json.parseFromValue(decideNavigationPayload, alloc, messageFromBun.value.payload, .{}) catch |err| {
            //         //     std.log.info("Error casting parsed json to zig type from stdin - {}: \n", .{err});
            //         //     continue;
            //         // };
            //         // defer parsedPayload.deinit();

            //         // const payload = parsedPayload.value;

            //         _response = payload.allow;

            //         std.log.info("decide Navigation{}", .{_response});

            //         {
            //             m.lock();
            //             defer m.unlock();
            //             _waitingForResponse = false;
            //         }
            //         // wake the thread up
            //         c.signal();
            //         continue;
            //     },

            //     else => {
            //         // Handle UI events on main thread

            //         // since line is re-used we need to copy it to the heap
            //         const lineCopy = alloc.dupe(u8, line) catch {
            //             // Handle the error here, e.g., log it or set a default value
            //             std.debug.print("Error: {s}\n", .{line});
            //             continue;
            //         };

            //         jobQueue.append(lineCopy) catch {
            //             std.log.info("Error appending to jobQueue: \nreceived: {s}", .{line});
            //             continue;
            //         };

            //         dispatch.dispatch_async_f(dispatch.dispatch_get_main_queue(), null, proccessJobQueue);
            //     },
            // }
        }
    }
}

var messageQueue = std.ArrayList([]const u8).init(alloc);

fn processMessageQueue(context: ?*anyopaque) callconv(.C) void {
    std.log.info("processMessageQueue on main thread", .{});
    _ = context;
    // std.log.info("messageQueue items main length {}", .{messageQueue.items.len});

    const line = messageQueue.orderedRemove(0);
    defer alloc.free(line);

    std.log.info("parsed line on main thread {s}", .{line});

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

    std.log.info("parsed line main thread {s}", .{msgType});

    // if (std.mem.eql(u8, _request.value.method, "createWindow")) {
    if (std.mem.eql(u8, msgType, "request")) {
        const _request = std.json.parseFromValue(rpcTypes._RPCRequestPacket, alloc, json.value, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return;
        };

        const method = _request.value.method;

        std.log.info("it's a request meatball {s}", .{method});

        if (std.mem.eql(u8, method, "createWindow")) {
            const params = _request.value.params;

            const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.createWindow.args, alloc, params, .{}) catch |err| {
                std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
                return;
            };
            std.log.info("it's a createWindow meatball {}", .{parsedArgs.value});

            // this is the handler, mapping the args and return value
            // window.createWindow is not a handler it's a window method called by the handler
            // everything above this line should be abstracted away as part of the generic rpc internals
            handlers.createWindow(parsedArgs.value);

            rpcSenders.sendResponseSuccess(_request.value.id, null);

            // todo: send back something from the window potentialy as part of the rpc implementation
            // in this case it would be void

        } else if (std.mem.eql(u8, method, "setTitle")) {
            const params = _request.value.params;

            const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.setTitle.args, alloc, params, .{}) catch |err| {
                std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
                return;
            };
            std.log.info("it's a createWindow meatball {}", .{parsedArgs.value});

            // this is the handler, mapping the args and return value
            // window.createWindow is not a handler it's a window method called by the handler
            // everything above this line should be abstracted away as part of the generic rpc internals
            handlers.setTitle(parsedArgs.value);

            rpcSenders.sendResponseSuccess(_request.value.id, null);
        }
    } else if (std.mem.eql(u8, msgType, "message")) {
        std.log.info("it's a message meatball", .{});
    } else {
        std.log.info("it's an unhandled meatball", .{});
    }

    // switch (messageWithType.value.type) {
    //     .request => {
    //         const _request = std.json.parseFromSlice(_RPCRequestPacket, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
    //             std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
    //             return;
    //         };

    //         std.log.info("zig: received request: {d}", .{_request.value.id});
    //         if (std.mem.eql(u8, _request.value.method, "createWindow")) {
    //             const args = std.json.parseFromValue(BunSchema.requests.createWindow.args, alloc, _request.value.params, .{}) catch |err| {
    //                 std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
    //                 return;
    //             };

    //             std.log.info("---> decideNAvigation handler {}", .{args.value.width});
    //             defer args.deinit();
    //         }
    //     },
    //     // .response => {
    //     //     // todo: handle error shape
    //     //     const response = std.json.parseFromSlice(_RPCResponsePacketSuccess, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
    //     //         std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
    //     //         return;
    //     //     };
    //     //     std.log.info("zig: received response: {d}", .{response.value.id});
    //     //     // handle response
    //     //     // look at the id, and unfreeze the thread that's waiting for a response returning the value
    //     // },
    //     .message => {
    //         const message = std.json.parseFromSlice(_RPCMessagePacket, alloc, line, .{ .ignore_unknown_fields = true }) catch |err| {
    //             std.log.info("Error parsing line from stdin - {}: \nreceived: {s}", .{ err, line });
    //             return;
    //         };
    //         std.log.info("zig: received message: {d}", .{message.value.id});
    //         // handle message
    //         // call the message handler
    //     },
    // }

    // // Handle the message based on its type
    // switch (messageFromBun.value.type) {
    //     .setTitle => {
    //         // todo: do we need parseFromValue here? can we just cast the payload to a type?
    //         const parsedPayload = std.json.parseFromValue(BunSchema.requests.setTitle.args, alloc, messageFromBun.value.args, .{}) catch |err| {
    //             std.log.info("Error casting parsed json to zig type from stdin setTitle - {}: \n", .{err});
    //             return;
    //         };
    //         defer parsedPayload.deinit();

    //         const payload = parsedPayload.value;

    //         // todo: move window stuff to another file and import it here
    //         _ = payload;
    //         // setTitle(payload);
    //     },
    //     .createWindow => {
    //         const parsedPayload = std.json.parseFromValue(BunSchema.requests.createWindow.args, alloc, messageFromBun.value.args, .{}) catch |err| {
    //             std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
    //             return;
    //         };
    //         defer parsedPayload.deinit();

    //         const payload = parsedPayload.value;
    //         _ = payload;
    //         // const objcWindow = createWindow(payload);

    //         // std.log.info("parsed type {}: \nreceived: ", .{payload.id});

    //         // const _window = WindowType{ .id = payload.id, .title = payload.title, .url = payload.url, .html = payload.html, .width = payload.width, .height = payload.height, .x = payload.x, .y = payload.y, .window = objcWindow, .webview = undefined };

    //         // windowMap.put(payload.id, _window) catch {
    //         //     std.log.info("Error putting window into hashmap: \nreceived: {}", .{messageFromBun.value.type});
    //         //     return;
    //         // };

    //         // std.log.info("hashmap size{}", .{windowMap.count()});
    //     },

    //     else => {
    //         std.log.info("Error: Unhandled event type on main thread", .{});
    //     },

    //     // Handle other types
    // }
}

// fn createStdioTransport() void {
//     return struct {
//         fn send(message: anytype) void {
//             // stringify message and send to stdout. note: message already has id and everything
//             // added
//             const stdoutWriter = std.io.getStdOut().writer();
//             // std.log.info("Sending message to bun: {} - {}\n", .{ messageType, phaseType });
//             std.json.stringify(message, .{}, stdoutWriter) catch |err| {
//                 std.debug.print("Failed to stringify message: {}\n", .{err});
//                 return;
//             };

//             // add a newline
//             _ = stdoutWriter.writeAll("\n") catch {
//                 // Handle potential errors here
//                 std.debug.print("Failed to write to stdout\n", .{});
//             };
//         }
//         fn registerHandler() void {
//             var ipcThread = try std.Thread.spawn(.{}, stdInListener, .{});
//             defer ipcThread.join();

//             // parse stdin and call handler
//             // Note: internally this will be run by rpc anywhere on a differen thread

//         }
//     };
// }

// fn send(message: anytype) void {
//     // stringify message and send to stdout. note: message already has id and everything
//     // added
//     const stdoutWriter = std.io.getStdOut().writer();
//     // std.log.info("Sending message to bun: {} - {}\n", .{ messageType, phaseType });
//     std.json.stringify(message, .{}, stdoutWriter) catch |err| {
//         std.debug.print("Failed to stringify message: {}\n", .{err});
//         return;
//     };

//     // add a newline
//     _ = stdoutWriter.writeAll("\n") catch {
//         // Handle potential errors here
//         std.debug.print("Failed to write to stdout\n", .{});
//     };
// }

// fn createWindow(args: BunSchema.requests.createWindow.args) void {
//     std.log.info("received request createWindow: {}\n", .{args.url});
//     // sendRequestToBun(xPromiseMethod.createWindow, args);
// }
// fn setTitle(args: BunSchema.requests.setTitle.args) void {
//     std.log.info("received request setTitle: {}\n", .{args.title});
//     // sendRequestToBun(xPromiseMethod.setTitle, args);
// }

pub fn init() !void {
    _ = try std.Thread.spawn(.{}, stdInListener, .{});
    // Note: don't defer ipcThread.join() here, doing so will cause init() to wait for the thread to complete
    // which never happens, which will in turn block the calling functino (probably main()) blocking that execution path
}

// pub const request = struct {
//     decideNavigation: fn(args: ZigSchema.requests.decideNavigation.args) ZigSchema.requests.decideNavigation.response,
// };

pub const request = struct {
    pub fn decideNavigation(args: rpcSchema.ZigSchema.requests.decideNavigation.args) rpcSchema.ZigSchema.requests.decideNavigation.response {
        rpcSenders.sendRequest("decideNavigation", args);
    }
    // decideNavigation: fn (args: ZigSchema.requests.decideNavigation.args) ZigSchema.requests.decideNavigation.response,
};
