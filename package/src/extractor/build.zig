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

    // Use Console subsystem on all platforms so users can see extraction progress
    // The console window will automatically close when extraction completes

    b.installArtifact(exe);

    const unit_tests = b.addTest(.{
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });
    unit_tests.linkLibC();
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run extractor tests");
    test_step.dependOn(&run_unit_tests.step);
}
