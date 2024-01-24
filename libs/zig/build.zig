const std = @import("std");

pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{
        .name = "webview",
        .root_source_file = .{ .path = "main.zig" },
    });

    // need to link objective c runtime in order for zig-objc to work
    exe.linkSystemLibrary("objc");
    // need to link AppKit in order to let zig-objc to reference AppKit related symbols in the objc runtime
    exe.linkFramework("AppKit"); // Link the AppKit framework
    exe.linkFramework("WebKit"); // Link the WebKit framework
    b.installArtifact(exe);
}
