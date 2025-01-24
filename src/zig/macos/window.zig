const std = @import("std");
const rpc = @import("../rpc/schema/request.zig");
const objc = @import("./objc.zig");
const pipesin = @import("../rpc/pipesin.zig");
const webview = @import("./webview.zig");
const rpcSchema = @import("../rpc/schema/schema.zig");
const utils = @import("../utils.zig");

const alloc = std.heap.page_allocator;

const WindowType = struct {
    id: u32,
    // todo: rename this to 'handle'
    window: *anyopaque,
    webviews: std.ArrayList(u32),
    title: []const u8,
    frame: struct {
        width: f64,
        height: f64,
        x: f64,
        y: f64,
    },

    pub fn deinit(self: *WindowType) void {
        for (self.webviews.items) |webviewId| {
            webview.remove(.{ .id = webviewId });
        }

        defer self.webviews.deinit();
    }
};

// todo: use the types in rpc.zig (or move them to a shared location)
const CreateWindowOpts = struct {
    id: u32,
    url: ?[]const u8, // todo remove
    html: ?[]const u8,
    title: []const u8,
    frame: struct { width: f64, height: f64, x: f64, y: f64 },
    styleMask: struct {
        Borderless: bool,
        Titled: bool,
        Closable: bool,
        Miniaturizable: bool,
        Resizable: bool,
        UnifiedTitleAndToolbar: bool,
        FullScreen: bool,
        FullSizeContentView: bool,
        UtilityWindow: bool,
        DocModalWindow: bool,
        NonactivatingPanel: bool,
        HUDWindow: bool,
    },
};
const SetTitleOpts = struct {
    winId: u32,
    title: []const u8,
};

const WindowMap = std.AutoHashMap(u32, WindowType);
pub var windowMap: WindowMap = WindowMap.init(alloc);

pub fn windowCloseHandler(windowId: u32) callconv(.C) void {
    rpc.request.windowClose(.{ .id = windowId });
    windowCleanup(windowId);
}

pub fn windowMoveHandler(windowId: u32, x: f64, y: f64) callconv(.C) void {
    rpc.request.windowMove(.{ .id = windowId, .x = x, .y = y });
}

pub fn windowResizeHandler(windowId: u32, x: f64, y: f64, width: f64, height: f64) callconv(.C) void {
    _ = rpc.request.windowResize(.{ .id = windowId, .x = x, .y = y, .width = width, .height = height });
}

pub fn createWindow(opts: rpcSchema.BunSchema.requests.createWindow.params) WindowType {
    const objcWin = objc.createNSWindowWithFrameAndStyle(opts.id, .{ //
        .styleMask = .{
            .Borderless = opts.styleMask.Borderless,
            .Titled = opts.styleMask.Titled,
            .Closable = opts.styleMask.Closable,
            .Miniaturizable = opts.styleMask.Miniaturizable,
            .Resizable = opts.styleMask.Resizable,
            .UnifiedTitleAndToolbar = opts.styleMask.UnifiedTitleAndToolbar,
            .FullScreen = opts.styleMask.FullScreen,
            .FullSizeContentView = opts.styleMask.FullSizeContentView,
            .UtilityWindow = opts.styleMask.UtilityWindow,
            .DocModalWindow = opts.styleMask.DocModalWindow,
            .NonactivatingPanel = opts.styleMask.NonactivatingPanel,
            .HUDWindow = opts.styleMask.HUDWindow,
        },
        .frame = .{ //
            .origin = .{ .x = opts.frame.x, .y = opts.frame.y },
            .size = .{ .width = opts.frame.width, .height = opts.frame.height },
        },
        .titleBarStyle = utils.toCString(opts.titleBarStyle),
    }, windowCloseHandler, windowMoveHandler, windowResizeHandler);

    objc.setNSWindowTitle(objcWin, utils.toCString(opts.title));

    const _window = WindowType{ //
        .id = opts.id,
        .title = opts.title,
        .frame = .{
            .width = opts.frame.width,
            .height = opts.frame.height,
            .x = opts.frame.x,
            .y = opts.frame.y,
        },
        .window = objcWin,
        .webviews = std.ArrayList(u32).init(alloc),
    };

    windowMap.put(opts.id, _window) catch {
        std.log.info("Error putting window into hashmap: ", .{});
        return _window;
    };

    objc.makeNSWindowKeyAndOrderFront(objcWin);

    // todo: no need to return anything here
    return _window;
}

pub fn setTitle(opts: SetTitleOpts) void {
    const win = windowMap.get(opts.winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.winId});
        return;
    };

    objc.setNSWindowTitle(win.window, utils.toCString(opts.title));
}

pub fn startWindowMove(opts: rpcSchema.BrowserSchema.messages.startWindowMove) void {
    const window = windowMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };
    std.debug.print("calling objc.startWindowMove: \n", .{});
    objc.startWindowMove(window.window);
}

pub fn stopWindowMove(opts: rpcSchema.BrowserSchema.messages.stopWindowMove) void {
    const window = windowMap.get(opts.id) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.id});
        return;
    };
    objc.stopWindowMove(window.window);
}

pub fn windowCleanup(winId: u32) void {
    var win = windowMap.get(winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{winId});
        return;
    };

    defer win.deinit();
    _ = windowMap.remove(winId);
}

pub fn closeWindow(opts: rpcSchema.BunSchema.requests.closeWindow.params) void {
    const win = windowMap.get(opts.winId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.winId});
        return;
    };

    objc.closeNSWindow(
        win.window,
    );
}
