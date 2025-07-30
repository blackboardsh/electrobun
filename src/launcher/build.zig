const std = @import("std");

pub fn build(b: *std.Build) void {
    // zig build -Doptimize=Debug to enable debug mode
    var target = b.standardTargetOptions(.{});
    
    // Force baseline CPU features for Windows x64 to ensure ARM64 emulation compatibility
    if (target.result.os.tag == .windows and target.result.cpu.arch == .x86_64) {
        target.result.cpu.features = std.Target.x86.baseline(.x86_64).features;
    }
    
    const optimize = b.standardOptimizeOption(.{});

    // todo: should probably rename webview to something else
    const exe = b.addExecutable(.{
        .name = "launcher",
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });

    b.installArtifact(exe);
}
