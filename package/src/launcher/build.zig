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
        .name = "launcher",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            // Link libc for signal handling on Linux
            .link_libc = true,
        }),
    });

    // Developer ID signing must be able to add LC_CODE_SIGNATURE without
    // overwriting __text in unsigned Intel Mach-O binaries.
    if (target.result.os.tag == .macos and target.result.cpu.arch == .x86_64) {
        exe.headerpad_size = 0x1000;
    }

    // For production Windows builds, use GUI subsystem to hide console window
    // For dev builds (Debug mode), use default console subsystem for CLI interaction
    const is_windows = target.result.os.tag == .windows;
    const is_production = optimize != .Debug;
    if (is_windows and is_production) {
        exe.subsystem = .Windows;
    }

    b.installArtifact(exe);

    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("linux_dependencies.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_unit_tests = b.addRunArtifact(unit_tests);

    const automation_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("automation.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_automation_tests = b.addRunArtifact(automation_tests);

    const test_step = b.step("test", "Run launcher tests");
    test_step.dependOn(&run_unit_tests.step);
    test_step.dependOn(&run_automation_tests.step);
}
