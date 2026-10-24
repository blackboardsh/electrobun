const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const electrobun_sdk = b.option(
        []const u8,
        "electrobun-sdk",
        "Absolute path to the Electrobun Zig SDK projected by Hutch",
    ) orelse @panic("missing -Delectrobun-sdk; build this project through Hutch");

    const electrobun = b.createModule(.{
        .root_source_file = .{ .cwd_relative = electrobun_sdk },
        .target = target,
        .optimize = optimize,
    });

    // The Electrobun UI engine ships as source next to the SDK and is
    // compiled into the app, so unused parts of it are left out.
    const ui_root = b.pathJoin(&.{ std.fs.path.dirname(electrobun_sdk).?, "ui", "root.zig" });
    const electrobun_ui = b.createModule(.{
        .root_source_file = .{ .cwd_relative = ui_root },
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    if (target.result.os.tag == .macos) {
        // Hutch passes an explicit target, so point Zig at the macOS SDK for
        // the system frameworks the UI engine uses (text, images, graphics).
        const sdk = b.option([]const u8, "macos-sdk", "macOS SDK path (defaults to xcrun --show-sdk-path)") orelse
            std.mem.trim(u8, b.run(&.{ "xcrun", "--show-sdk-path" }), " \n");
        electrobun_ui.addSystemFrameworkPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "System/Library/Frameworks" }) });
        electrobun_ui.addLibraryPath(.{ .cwd_relative = b.pathJoin(&.{ sdk, "usr/lib" }) });
        for ([_][]const u8{ "CoreText", "CoreGraphics", "CoreFoundation", "ImageIO" }) |fw| {
            electrobun_ui.linkFramework(fw, .{});
        }
    }

    const exe = b.addExecutable(.{
        .name = "main",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .imports = &.{
                .{ .name = "electrobun", .module = electrobun },
                .{ .name = "electrobun_ui", .module = electrobun_ui },
            },
        }),
    });

    b.installArtifact(exe);
}
