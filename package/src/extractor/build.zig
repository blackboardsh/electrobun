const std = @import("std");
const builtin = @import("builtin");

fn releaseTarget(b: *std.Build) std.Build.ResolvedTarget {
    var query = b.standardTargetOptionsQueryOnly(.{});
    const os_tag = query.os_tag orelse builtin.os.tag;
    if (os_tag == .macos and query.os_version_min == null) {
        query.os_tag = .macos;
        query.os_version_min = .{ .semver = .{ .major = 14, .minor = 0, .patch = 0 } };
    }
    return b.resolveTargetQuery(query);
}

pub fn build(b: *std.Build) void {
    // zig build -Doptimize=Debug to enable debug mode
    const target = releaseTarget(b);
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "extractor",
        .root_source_file = b.path("main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Developer ID signing must be able to add LC_CODE_SIGNATURE without
    // overwriting __text in unsigned Intel Mach-O binaries.
    if (target.result.os.tag == .macos and target.result.cpu.arch == .x86_64) {
        exe.headerpad_size = 0x1000;
    }

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
