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
    const target = releaseTarget(b);
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addLibrary(.{
        .name = "ElectrobunCore",
        .linkage = .dynamic,
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    b.installArtifact(lib);

    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run Electrobun core tests");
    test_step.dependOn(&run_unit_tests.step);

    // Exercise the native queue, consent, delivery controls, encrypted spool,
    // and shared installation identity without building the framework or UI.
    const managed_services_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("insights.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    const run_managed_services_tests = b.addRunArtifact(managed_services_tests);
    const managed_services_step = b.step("test-managed-services", "Run native Insights and installation identity tests");
    managed_services_step.dependOn(&run_managed_services_tests.step);
}
