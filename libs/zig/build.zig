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

    // Some things can't be done in objc directly from zig via msgSending
    // So we have some objc wrappers that are themselves wrapped in c-abi compatible structures
    // that zig can call in those cases (like executing objc blocks that have unknown context
    // in their closure that can't reliably be replicated in zig)
    // Compile the Objective-C code into a .dylib

    // shared libraries are accessible at runtime, the os looks in standard folders
    // we use Bun spawn's env to extends the DYLD_LIBRARY_PATH during development

    // Used for the cImport call in webview.zig
    // exe.addIncludePath(.{ .path = "../objc/" });

    // exe.linkLibrary(sharedLib);

    b.installArtifact(exe);

    // todo for future testing of the methods from cli can pass args like
    // if (b.option(bool, "enable-demo", "install the demo too") orelse false) {
    //     b.installArtifact(exe);
    // }
}
