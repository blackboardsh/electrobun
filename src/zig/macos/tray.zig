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

fn trayItemHandler(trayId: u32, action: [*:0]const u8) void {
    // Note: the action will be an empty string if there is no menu and the tray is clicked
    // it'll also be an empty string if there is a menu and the menu item has no action defined.
    _ = rpc.request.trayEvent(.{
        .id = trayId,
        .action = utils.fromCString(action),
    });
}

pub fn createTray(opts: rpcSchema.BunSchema.requests.createTray.params) TrayType {
    const trayHandle = objc.createTray(opts.id, utils.toCString(opts.image), utils.toCString(opts.title), trayItemHandler);
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

pub fn setTrayMenu(opts: rpcSchema.BunSchema.requests.setTrayMenu.params) void {
    const tray = trayMap.get(opts.id) orelse {
        std.debug.print("Failed to get tray from hashmap for id {}\n", .{opts.id});
        return;
    };

    // serializing the menuConfig to a zig struct with nested submenues and then passing that
    // to objc and serialziing it to a nested NSArray is a bit of a pain, you have to pass the count
    // at every level. Much easier to just pass the menuConfig json string straight though to objc
    // and serialize it once.
    _ = objc.setTrayMenu(tray.handle, utils.toCString(opts.menuConfig));
}
