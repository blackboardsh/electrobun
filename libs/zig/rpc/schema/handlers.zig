const rpcTypes = @import("../types.zig");
const rpcSchema = @import("schema.zig");
const window = @import("../../macos/window.zig");
const std = @import("std");

const alloc = std.heap.page_allocator;

pub fn createWindow(args: rpcSchema.BunSchema.requests.createWindow.args) void {
    _ = window.createWindow(.{
        .id = args.id,
        .title = args.title,
        .url = args.url,
        .html = args.html,
        .frame = .{
            .x = args.frame.x,
            .y = args.frame.y,
            .width = args.frame.width,
            .height = args.frame.height,
        },
        // .width = args.width,
        // .height = args.height,
        // .x = args.x,
        // .y = args.y,
    });
}

pub fn setTitle(args: rpcSchema.BunSchema.requests.setTitle.args) void {
    _ = window.setTitle(.{
        .winId = args.winId,
        .title = args.title,
    });
}

pub const handlers = rpcSchema.Handlers{
    .createWindow = createWindow,
    .setTitle = setTitle,
};

pub const RequestResult = struct { errorMsg: ?[]const u8, payload: ?rpcSchema.PayloadType };

pub fn handleRequest(request: rpcTypes._RPCRequestPacket) RequestResult {
    const method = request.method;

    if (std.mem.eql(u8, method, "createWindow")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.createWindow.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.createWindow(parsedArgs.value);

        return RequestResult{ .errorMsg = null, .payload = null };

        // todo: send back something from the window potentialy as part of the rpc implementation
        // in this case it would be void

    } else if (std.mem.eql(u8, method, "setTitle")) {
        const params = request.params;

        const parsedArgs = std.json.parseFromValue(rpcSchema.BunSchema.requests.setTitle.args, alloc, params, .{}) catch |err| {
            std.log.info("Error casting parsed json to zig type from stdin createWindow - {}: \n", .{err});
            return RequestResult{ .errorMsg = "failed to parse args", .payload = null };
        };

        // this is the handler, mapping the args and return value
        // window.createWindow is not a handler it's a window method called by the handler
        // everything above this line should be abstracted away as part of the generic rpc internals
        handlers.setTitle(parsedArgs.value);
        return RequestResult{ .errorMsg = null, .payload = null };
    } else {
        return RequestResult{ .errorMsg = "unhandled method", .payload = null };
    }
}
