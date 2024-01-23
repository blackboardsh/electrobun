const std = @import("std");

pub const AutoreleasePool = opaque {
    /// Create a new autorelease pool. To clean it up, call deinit.
    pub inline fn init() *AutoreleasePool {
        return @ptrCast(objc_autoreleasePoolPush().?);
    }

    pub inline fn deinit(self: *AutoreleasePool) void {
        objc_autoreleasePoolPop(self);
    }
};

// I'm not sure if these are internal or not... they aren't in any headers,
// but its how autorelease pools are implemented.
extern "c" fn objc_autoreleasePoolPush() ?*anyopaque;
extern "c" fn objc_autoreleasePoolPop(?*anyopaque) void;
