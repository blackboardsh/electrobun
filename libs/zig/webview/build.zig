// const std = @import("std");
// const objc = @import("zig-objc/build.zig");

// pub fn build(b: *std.Build) !void {
//     // const exe = b.addExecutable("myapp", "src/main.zig");
//     b.addExecutable(.{
//         .name = "webview_wrapper",
//         .root_source_file = .{ .path = "src/main.zig" },
//         // .target = b.host,
//     });

//     // exe.addPackage(objc.pkg);
// }

const std = @import("std");

pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{
        .name = "webview",
        .root_source_file = .{ .path = "webview.zig" },
        // .target = b.host,
    });
    // exe.addPackage(objc.pkg);
    // need to link objective c runtime in order for zig-objc to work
    exe.linkSystemLibrary("objc");
    // need to link AppKit in order to let zig-objc to reference AppKit related symbols in the objc runtime
    exe.linkFramework("AppKit"); // Link the AppKit framework
    b.installArtifact(exe);
}
