const std = @import("std");

pub fn build(b: *std.Build) void {
    // zig build -Doptimize=Debug to enable debug mode
    const target = b.standardTargetOptions(.{});
    // const optimize = b.standardOptimizeOption(.{});
    const optimize = b.standardOptimizeOption(.{});

    // todo: should probably rename webview to something else
    const exe = b.addExecutable(.{
        .name = "webview",
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Embed our static objc wrapping library in the zig binary
    exe.addLibraryPath(b.path("build"));
    // Note: zig will add the lib prefix and .a suffix in the library Path above
    // so src/zig/build/libObjcWrapperLib.a will be linked in
    exe.linkSystemLibrary("ObjcWrapper");

    b.installArtifact(exe);
}
