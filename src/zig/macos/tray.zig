const std = @import("std");
const rpc = @import("../rpc/schema/request.zig");
const objc = @import("./objc.zig");
const rpcSchema = @import("../rpc/schema/schema.zig");
const utils = @import("../utils.zig");

const alloc = std.heap.page_allocator;

const TrayType = struct {
    id: u32,
    handle: *anyopaque,
};

const TrayMap = std.AutoHashMap(u32, TrayType);
pub var trayMap: TrayMap = TrayMap.init(alloc);

fn menuHandler(trayId: u32, action: [*:0]const u8) void {
    _ = rpc.request.trayEvent(.{
        .id = trayId,
        .action = utils.fromCString(action),
    });
}

pub fn createTray(opts: rpcSchema.BunSchema.requests.createTray.params) TrayType {
    const trayHandle = objc.createTray(opts.id, utils.toCString(opts.image), utils.toCString(opts.title), menuHandler);

    const _tray = TrayType{ //
        .id = opts.id,
        .handle = trayHandle,
    };

    trayMap.put(opts.id, _tray) catch {
        std.log.info("Error putting window into hashmap: ", .{});
        return _tray;
    };

    return _tray;
}

pub fn setTrayTitle(opts: rpcSchema.BunSchema.requests.setTrayTitle.params) void {
    const tray = trayMap.get(opts.id) orelse {
        std.debug.print("Failed to get tray from hashmap for id {}\n", .{opts.id});
        return;
    };

    _ = objc.setTrayTitle(tray.handle, utils.toCString(opts.title));
}
pub fn setTrayImage(opts: rpcSchema.BunSchema.requests.setTrayImage.params) void {
    const tray = trayMap.get(opts.id) orelse {
        std.debug.print("Failed to get tray from hashmap for id {}\n", .{opts.id});
        return;
    };

    _ = objc.setTrayTitle(tray.handle, utils.toCString(opts.image));
}
