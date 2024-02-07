const rpcSchema = @import("rpcSchema.zig");
const window = @import("window.zig");

// pub const requestHandlers = struct {
pub fn createWindow(args: rpcSchema.BunSchema.requests.createWindow.args) void {
    _ = window.createWindow(.{
        .id = args.id,
        .title = args.title,
        .url = args.url,
        .html = args.html,
        .width = args.width,
        .height = args.height,
        .x = args.x,
        .y = args.y,
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

// };
