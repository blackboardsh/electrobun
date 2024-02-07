const std = @import("std");
const rpc = @import("rpcAnywhere.zig");

// const alloc = std.heap.page_allocator;

// message types
// pub const decideNavigation = struct {
//     const responseType = struct {
//         allow: bool,
//     };

//     pub fn request(url: []const u8) void {
//         const payload = .{
//             .url = url,
//         };
//         sendRequestToBun(xPromiseMessageType.decideNavigation, payload);
//     }

//     pub fn response(rawPayload: std.json.Value) responseType {
//         // const payload = std.json.parse(xPromiseMessage, rawPayload);
// const parsedPayload = std.json.parseFromValue(responseType, alloc, rawPayload, .{}) catch |err| {
//             std.log.info("Error casting parsed json to zig type from stdin xPromise response - {}: \n", .{err});
//             return responseType{ .allow = true };
//         };
//         defer parsedPayload.deinit();

//         return parsedPayload.value;
//     }
// };

// // private methods
// var promiseIdGen = PromiseIdGenerator{};
// const PromiseIdGenerator = struct {
//     next_id: u32 = 0,
//     const NextIdMax: u32 = 100;

//     pub fn nextId(self: *PromiseIdGenerator) u32 {
//         self.next_id = (self.next_id + 1) % (NextIdMax);
//         return self.next_id;
//     }
// };

// fn sendRequestToBun(method: xPromiseMethod, payload: anytype) void {
//     sendMessageToBun(xPromiseType.request, method, payload);
// }

// fn sendResponseToBun(method: xPromiseMethod, payload: anytype) void {
//     sendMessageToBun(xPromiseType.response, method, payload);
// }

// fn sendMessageToBun(messageType: xPromiseType, method: xPromiseMethod, payload: anytype) void {
//     const stdoutWriter = std.io.getStdOut().writer();
//     // if phaseType === request then add promiseId to the payload, sleep thread, and track it
//     std.log.info("Sending message to bun: {} - {}\n", .{ messageType, phaseType });
//     std.json.stringify(.{
//         .id = promiseIdGen.nextId(),
//         .type = messageType,
//         .phase = phaseType,
//         .payload = payload,
//     }, .{}, stdoutWriter) catch |err| {
//         std.debug.print("Failed to stringify message: {}\n", .{err});
//         return;
//     };

//     // add a newline
//     _ = stdoutWriter.writeAll("\n") catch {
//         // Handle potential errors here
//         std.debug.print("Failed to write to stdout\n", .{});
//     };
// }

// // pub const xPromiseMessage = struct {
// //     id: u32,
// //     type: xPromiseMessageType,
// //     phase: xPromiseMessagePhase,
// //     payload: std.json.Value,
// // };

// pub const xPromiseRequest = struct {
//     id: u32,
//     type: xPromiseType.request,
//     method: xPromiseMethod,
//     args: std.json.Value,
// };

// pub const xPromiseResponse = struct {
//     id: u32,
//     type: xPromiseType.response,
//     method: xPromiseMethod,
//     payload: std.json.Value,
// };

// // // explicit phase, always use payload
// pub const xPromiseType = enum {
//     request,
//     response,
//     message,
// };

// pub const xPromiseMethod = enum {
//     setTitle,
//     createWindow,
//     decideNavigation,
// };

////////////////////////////////////

// todo: implement createRPC in rpcAnywhere.zig
// pub const bunRPC = rpc.createRPC(ZigSchema, BunSchema, struct {
//     // transport: createStdioTransport(),
//     requestHandler: struct {
//         fn createWindow(args: BunSchema.requests.createWindow.args) void {
//             std.log.info("received request createWindow: {}\n", .{args.url});
//             // sendRequestToBun(xPromiseMethod.createWindow, args);
//         }
//         fn setTitle(args: BunSchema.requests.setTitle.args) void {
//             std.log.info("received request setTitle: {}\n", .{args.title});
//             // sendRequestToBun(xPromiseMethod.setTitle, args);
//         }
//     },
// });

// pub const bunRPC = rpc.RPC.init(ZigSchema, BunSchema, struct {
//     // transport: createStdioTransport(),
//     requestHandler: struct {
//         fn createWindow(args: BunSchema.requests.createWindow.args) void {
//             std.log.info("received request createWindow: {}\n", .{args.url});
//             // sendRequestToBun(xPromiseMethod.createWindow, args);
//         }
//         fn setTitle(args: BunSchema.requests.setTitle.args) void {
//             std.log.info("received request setTitle: {}\n", .{args.title});
//             // sendRequestToBun(xPromiseMethod.setTitle, args);
//         }
//     },
// });

// pub fn init() void {
//     // const stdinReader = std.io.getStdIn().reader();
//     // const stdoutWriter = std.io.getStdOut().writer();
//     // const transport = rpc.createStdioTransport(stdinReader, stdoutWriter);
//     // const rpc = rpc.createRPC(ZigSchema, BunSchema, transport, requestHandler);
//     // rpc.start();
//     return rpc.RPC.init(ZigSchema, BunSchema, struct {
//         requestHandler: struct {

//         },
//     });
// }
