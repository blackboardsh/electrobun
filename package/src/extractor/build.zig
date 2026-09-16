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
    const windows_console = b.option(
        bool,
        "windows-console",
        "Build the Windows extractor with a diagnostic console",
    ) orelse false;

    const macos_sdk = if (target.result.os.tag == .macos) blk: {
        const output = b.run(&.{ "xcrun", "--sdk", "macosx", "--show-sdk-path" });
        const path = std.mem.trim(u8, output, " \t\r\n");
        if (path.len == 0) @panic("xcrun returned an empty macOS SDK path");
        b.sysroot = path;
        break :blk path;
    } else null;

    const windows_manifest = if (target.result.os.tag == .windows)
        b.path("extractor.manifest")
    else
        null;

    const exe = b.addExecutable(.{
        .name = "extractor",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            // Link with libc for chmod and other system calls
            .link_libc = true,
        }),
        .win32_manifest = windows_manifest,
    });

    if (target.result.os.tag == .macos) {
        exe.root_module.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{
            macos_sdk.?,
            "usr",
            "include",
        }) });
        exe.root_module.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{
            macos_sdk.?,
            "System",
            "Library",
            "Frameworks",
        }) });
        exe.root_module.addCSourceFile(.{
            .file = b.path("macos_uninstall_prompt.m"),
            .flags = &.{"-fobjc-arc"},
        });
        exe.root_module.linkFramework("AppKit", .{});
    }

    if (target.result.os.tag == .windows) {
        exe.root_module.addCSourceFile(.{
            .file = b.path("windows_uninstall_prompt.c"),
            .flags = &.{},
        });
        exe.root_module.linkSystemLibrary("comctl32", .{});

        // Installers are user-facing GUI executables. The console subsystem
        // both flashes a debug terminal and can keep the parent terminal tied
        // to the installer process. Keep an explicit opt-in for diagnostics.
        exe.subsystem = if (windows_console) .Console else .Windows;
    }

    // Developer ID signing must be able to add LC_CODE_SIGNATURE without
    // overwriting __text in unsigned Intel Mach-O binaries.
    if (target.result.os.tag == .macos and target.result.cpu.arch == .x86_64) {
        exe.headerpad_size = 0x1000;
    }

    b.installArtifact(exe);

    // Manual previews exercise the platform installer renderer without an
    // application payload. The extractor handles this environment variable
    // before installer/uninstaller dispatch and returns success after the
    // terminal dialog is dismissed on every supported desktop platform.
    const installer_ui_preview = b.addRunArtifact(exe);
    installer_ui_preview.setEnvironmentVariable(
        "ELECTROBUN_INSTALLER_UI_PREVIEW",
        "all",
    );
    const installer_ui_preview_step = b.step(
        "installer-ui-preview",
        "Preview the successful installer UI",
    );
    installer_ui_preview_step.dependOn(&installer_ui_preview.step);

    const installer_ui_preview_error = b.addRunArtifact(exe);
    installer_ui_preview_error.setEnvironmentVariable(
        "ELECTROBUN_INSTALLER_UI_PREVIEW",
        "error",
    );
    const installer_ui_preview_error_step = b.step(
        "installer-ui-preview-error",
        "Preview the failed installer UI",
    );
    installer_ui_preview_error_step.dependOn(&installer_ui_preview_error.step);

    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        }),
    });
    if (target.result.os.tag == .macos) {
        unit_tests.root_module.addSystemIncludePath(.{ .cwd_relative = b.pathJoin(&.{
            macos_sdk.?,
            "usr",
            "include",
        }) });
        unit_tests.root_module.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{
            macos_sdk.?,
            "System",
            "Library",
            "Frameworks",
        }) });
        unit_tests.root_module.addCSourceFile(.{
            .file = b.path("macos_uninstall_prompt.m"),
            .flags = &.{"-fobjc-arc"},
        });
        unit_tests.root_module.linkFramework("AppKit", .{});
    }
    if (target.result.os.tag == .windows) {
        // Build.TestOptions does not expose this field yet, but tests link the
        // same TaskDialog bridge and therefore need the same activation context.
        unit_tests.win32_manifest = windows_manifest;
        unit_tests.root_module.addCSourceFile(.{
            .file = b.path("windows_uninstall_prompt.c"),
            .flags = &.{},
        });
        unit_tests.root_module.linkSystemLibrary("comctl32", .{});
    }
    const run_unit_tests = b.addRunArtifact(unit_tests);

    const subsystem_parser_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("windows_subsystem_check.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_subsystem_parser_tests = b.addRunArtifact(subsystem_parser_tests);

    const linux_uninstall_prompt_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("linux_uninstall_prompt.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_linux_uninstall_prompt_tests = b.addRunArtifact(linux_uninstall_prompt_tests);

    const test_step = b.step("test", "Run extractor tests");
    test_step.dependOn(&run_unit_tests.step);
    test_step.dependOn(&run_subsystem_parser_tests.step);
    test_step.dependOn(&run_linux_uninstall_prompt_tests.step);

    if (target.result.os.tag == .windows) {
        const subsystem_checker = b.addExecutable(.{
            .name = "windows-subsystem-check",
            .root_module = b.createModule(.{
                .root_source_file = b.path("windows_subsystem_check.zig"),
                .target = b.graph.host,
                .optimize = optimize,
            }),
        });
        const run_subsystem_checker = b.addRunArtifact(subsystem_checker);
        run_subsystem_checker.addArtifactArg(exe);
        run_subsystem_checker.addArg(if (windows_console) "3" else "2");
        test_step.dependOn(&run_subsystem_checker.step);
    }
}
