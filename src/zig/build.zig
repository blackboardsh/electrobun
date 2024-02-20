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

    // need to link AppKit for NSApplication (windows, event loop, etc.)
    // so that the ObjcWrapper objc code can be linked against these frameworks
    exe.linkFramework("AppKit"); // Link the AppKit framework
    exe.linkFramework("WebKit"); // Link the WebKit framework

    // Embed our static objc wrapping library in the zig binary
    exe.addLibraryPath(.{ .path = "build" });
    // Note: zig will add the lib prefix and .a suffix in the library Path above
    // so src/zig/build/libObjcWrapperLib.a will be linked in
    exe.linkSystemLibrary("ObjcWrapper");

    b.installArtifact(exe);

    // todo for future testing of the methods from cli can pass args like
    // if (b.option(bool, "enable-demo", "install the demo too") orelse false) {
    //     b.installArtifact(exe);
    // }
}
