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

    // App Sandbox denies mach-lookup of com.apple.coreservices.launchservicesd,
    // so an app has to be checked in with LaunchServices during dyld
    // initialization, while it still holds its launch context. AppKit does that
    // check-in when it loads, and the runtime only meets AppKit later through
    // dlopen, which is too late. Linking Cocoa into the bundle's main
    // executable moves the check-in back into the launch window; the launcher
    // itself never calls into Cocoa, hence `needed` to keep the load command.
    if (target.result.os.tag == .macos) {
        const sdk = std.zig.system.darwin.getSdk(b.allocator, b.graph.io, &target.result) orelse
            std.process.fatal("unable to locate the macOS SDK; install the Xcode command line tools", .{});
        exe.root_module.addSystemFrameworkPath(.{
            .cwd_relative = b.pathJoin(&.{ sdk, "System", "Library", "Frameworks" }),
        });
        exe.root_module.addLibraryPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr", "lib" }) });
        exe.root_module.linkFramework("Cocoa", .{ .needed = true });
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

    const windows_spawn_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("windows_spawn.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_windows_spawn_tests = b.addRunArtifact(windows_spawn_tests);

    const uninstall_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("uninstall.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_uninstall_tests = b.addRunArtifact(uninstall_tests);

    const test_step = b.step("test", "Run launcher tests");
    test_step.dependOn(&run_unit_tests.step);
    test_step.dependOn(&run_automation_tests.step);
    test_step.dependOn(&run_windows_spawn_tests.step);
    test_step.dependOn(&run_uninstall_tests.step);
}
