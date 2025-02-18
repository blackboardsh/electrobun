// NOTE: This rpc mechanism is loosely based on rpcAnywhere. It's implemented in sort of an inverted way
// to the ts version since that's the most straightforward way to do it in zig and we only need
// the zig version to be compatible with ts version and somewhat organized. Right now this is more
// rpcAnywhere-only-over-stdio in zig, and not a zig rewrite of rpcAnywhere

// NOTE: there is a way to pass in just ClientSchema, ServerSchema, and handlers and generically
// derive things in zig using compile time types and reflection,
// but it's a big lift and outside the current scope of this project.

// needed to access grand central dispatch to dispatch things from
// other threads to the main thread
const std = @import("std");
const pipesin = @import("pipereader.zig");

pub fn init() !void {
    _ = try std.Thread.spawn(.{}, pipesin.initPipeReader, .{});
    // Note: don't defer ipcThread.join() here, doing so will cause init() to wait for the thread to complete
    // which never happens, which will in turn block the calling functino (probably main()) blocking that execution path
}
