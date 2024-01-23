const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});
    const target = b.standardTargetOptions(.{});

    _ = b.addModule("objc", .{ .root_source_file = .{ .path = "src/main.zig" } });

    const tests = b.addTest(.{
        .name = "objc-test",
        .root_source_file = .{ .path = "src/main.zig" },
        .target = target,
        .optimize = optimize,
    });
    tests.linkSystemLibrary("objc");
    tests.linkFramework("Foundation");
    @import("macos_sdk").addPaths(tests);
    b.installArtifact(tests);

    const test_step = b.step("test", "Run tests");
    const tests_run = b.addRunArtifact(tests);
    test_step.dependOn(&tests_run.step);
}
