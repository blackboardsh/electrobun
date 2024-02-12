const std = @import("std");

pub fn build(b: *std.Build) void {
    // zig build -Doptimize=Debug to enable debug mode
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // const lib = b.addSharedLibrary(.{
    //     .name = "webview",
    //     .root_source_file = .{ .path = "main.zig" },
    //     .target = target,
    //     .optimize = optimize,
    // });

    // todo: should probably rename webview to something else
    const exe = b.addExecutable(.{
        .name = "webview",
        .root_source_file = .{ .path = "main.zig" },
        .target = target,
        .optimize = optimize,
    });

    // lib.setOutputDir("../../src/");

    // Things to interact with objc directly from zig via msgSending

    // need to link objective c runtime in order for zig-objc to work
    exe.linkSystemLibrary("objc");
    // need to link AppKit for NSApplication (windows, event loop, etc.)
    exe.linkFramework("AppKit"); // Link the AppKit framework
    exe.linkFramework("WebKit"); // Link the WebKit framework

    b.installArtifact(exe);

    // todo for future testing of the methods from cli can pass args like
    // if (b.option(bool, "enable-demo", "install the demo too") orelse false) {
    //     b.installArtifact(exe);
    // }
}
