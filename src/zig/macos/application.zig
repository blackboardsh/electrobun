const std = @import("std");
const objc = @import("./objc.zig");

pub export fn startAppkitGuiEventLoop() void {
    objc.runNSApplication();
}
