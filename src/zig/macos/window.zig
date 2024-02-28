const std = @import("std");
const rpc = @import("../rpc/schema/request.zig");
const objc = @import("./objc.zig");
const pipesin = @import("../rpc/pipesin.zig");
const webview = @import("./webview.zig");

const alloc = std.heap.page_allocator;

const WindowType = struct {
    id: u32,
    // todo: rename this to 'handle'
    window: *anyopaque,
    webview: ?u32,
    title: []const u8,
    frame: struct {
        width: f64,
        height: f64,
        x: f64,
        y: f64,
    },
};

// todo: use the types in rpc.zig (or move them to a shared location)
const CreateWindowOpts = struct { id: u32, url: ?[]const u8, html: ?[]const u8, title: []const u8, frame: struct { width: f64, height: f64, x: f64, y: f64 } };
const SetTitleOpts = struct {
    winId: u32,
    title: []const u8,
};

const WindowMap = std.AutoHashMap(u32, WindowType);
pub var windowMap: WindowMap = WindowMap.init(alloc);

pub fn createWindow(opts: CreateWindowOpts) WindowType {
    const objcWin = objc.createNSWindowWithFrameAndStyle(.{ //
        .styleMask = .{ .Titled = true, .Closable = true, .Resizable = true }, //
        .frame = .{ //
            .origin = .{ .x = opts.frame.x - 600, .y = opts.frame.y - 600 },
            .size = .{ .width = opts.frame.width, .height = opts.frame.height },
        },
    });

    objc.setNSWindowTitle(objcWin, toCString(opts.title));

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
        // todo: make it an array of webview ids or something
        .webview = null,
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

    objc.setNSWindowTitle(win.window, toCString(opts.title));
}

pub fn setContentView(opts: struct { webviewId: u32, windowId: u32 }) void {
    var win = windowMap.get(opts.windowId) orelse {
        std.debug.print("Failed to get window from hashmap for id {}\n", .{opts.windowId});
        return;
    };

    var view = webview.webviewMap.get(opts.webviewId) orelse {
        std.debug.print("Failed to get webview from hashmap for id {}\n", .{opts.webviewId});
        return;
    };

    objc.setContentView(win.window, view.handle);
}

// effecient string concatenation that returns the template if there's an error
// this makes handling errors a bit easier
fn concatOrFallback(comptime fmt: []const u8, args: anytype) []const u8 {
    var buffer: [100]u8 = undefined;
    const result = std.fmt.bufPrint(&buffer, fmt, args) catch |err| {
        std.log.info("Error concatenating string {}", .{err});
        return fmt;
    };

    return result;
}

fn toCString(input: []const u8) [*:0]const u8 {
    // Attempt to allocate memory, handle error without bubbling it up
    const allocResult = alloc.alloc(u8, input.len + 1) catch {
        return "console.error('failed to allocate string');";
    };

    std.mem.copy(u8, allocResult, input); // Copy input to the allocated buffer
    allocResult[input.len] = 0; // Null-terminate
    return allocResult[0..input.len :0]; // Correctly typed slice with null terminator
}

fn fromCString(input: [*:0]const u8) []const u8 {
    return input[0 .. std.mem.len(input) - 1];
}
