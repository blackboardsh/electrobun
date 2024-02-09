const std = @import("std");
const libc = std.c;
const os = std.os;

const alloc = std.heap.page_allocator;

pub const WKNavigationResponsePolicy = enum(c_int) {
    cancel = 0,
    allow = 1,
    download = 2,
};

// This file exposes a singleton that automatically loads the dynamic library and symbols
// when they are first used.
// example:
// const _objcLib = objcLib();
// const url_cstr = _objcLib.getUrlFromNavigationAction(navigationAction);

const ObcLib = struct {
    handle: ?*anyopaque = null,
    getUrlFromNavigationActionSymbol: *const fn (*anyopaque) callconv(.C) [*:0]const u8 = undefined,
    invokeDecisionHandlerSymbol: *const fn (*anyopaque, WKNavigationResponsePolicy) callconv(.C) *void = undefined,

    fn loadSymbols(self: *ObcLib) void {
        if (self.handle == null) {
            // Note: Just use the name of the .dylib, in typescript we set the DYLD_LIBRARY_PATH as an env
            // variable to the zig process, which signals to the OS which folders to let this process look
            // for dynamic libraries
            const dylib_path = "libDecisionWrapper.dylib";
            const RTLD_NOW = 2;
            self.handle = libc.dlopen(dylib_path, RTLD_NOW);
            if (self.handle == null) {
                std.debug.print("Failed to load library, make sure DYLD_LIBRARY_PATH is set correctly: {s}\n", .{dylib_path});
                return;
            }

            // Load symbols
            self.getUrlFromNavigationActionSymbol = @alignCast(@ptrCast(libc.dlsym(self.handle.?, "getUrlFromNavigationAction"))); //orelse return error.CannotLoadSymbol;
            self.invokeDecisionHandlerSymbol = @alignCast(@ptrCast(libc.dlsym(self.handle.?, "invokeDecisionHandler"))); //orelse return error.CannotLoadSymbol;
        }
    }

    pub fn getUrlFromNavigationAction(self: *ObcLib, navigationAction: *anyopaque) [*:0]const u8 {
        self.loadSymbols();
        return self.getUrlFromNavigationActionSymbol(navigationAction);
    }

    pub fn invokeDecisionHandler(self: *ObcLib, decisionHandler: *anyopaque, policy: WKNavigationResponsePolicy) void {
        self.loadSymbols();
        _ = self.invokeDecisionHandlerSymbol(decisionHandler, policy);
    }

    pub fn unload(self: *ObcLib) void {
        if (self.handle) |handle| {
            libc.dlclose(handle);
            self.handle = null;
            self.getUrlFromNavigationActionSymbol = null;
            self.invokeDecisionHandlerSymbol = null;
        }
    }
};

var _objcLibInstance: ?ObcLib = null;

pub fn objcLib() *ObcLib {
    if (_objcLibInstance == null) {
        _objcLibInstance = ObcLib{};
    }

    return &_objcLibInstance.?;
}