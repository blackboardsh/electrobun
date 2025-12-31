const std = @import("std");

pub fn build(b: *std.Build) void {
    // zig build -Doptimize=Debug to enable debug mode
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "extractor",
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Link with libc for chmod and other system calls
    exe.linkLibC();

    // On Windows, use GUI subsystem to hide console window
    if (target.result.os.tag == .windows) {
        exe.subsystem = .Windows;
    }

    b.installArtifact(exe);
}
