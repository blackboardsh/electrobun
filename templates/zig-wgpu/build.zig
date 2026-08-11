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

    const exe = b.addExecutable(.{
        .name = "main",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/main.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
            .imports = &.{
                .{ .name = "electrobun", .module = electrobun },
            },
        }),
    });

    b.installArtifact(exe);
}
