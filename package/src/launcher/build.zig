const std = @import("std");

pub fn build(b: *std.Build) void {
    // zig build -Doptimize=Debug to enable debug mode
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "launcher",
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Link libc for signal handling on Linux
    exe.linkLibC();

    // For production Windows builds, use GUI subsystem to hide console window
    // For dev builds (Debug mode), use default console subsystem for CLI interaction
    const is_windows = target.result.os.tag == .windows;
    const is_production = optimize != .Debug;
    if (is_windows and is_production) {
        exe.subsystem = .Windows;
    }

    b.installArtifact(exe);
}
