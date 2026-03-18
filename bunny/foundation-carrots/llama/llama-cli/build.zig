const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "llama-cli",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Link against libc and C++ for llama.cpp
    exe.linkLibC();
    exe.linkLibCpp();
    
    // Link system frameworks (macOS)
    exe.linkFramework("Accelerate");
    
    // Add include paths
    exe.addIncludePath(b.path("deps/llama.cpp/include"));
    exe.addIncludePath(b.path("deps/llama.cpp/ggml/include"));
    exe.addIncludePath(b.path("src"));
    
    // Link against pre-compiled libraries
    exe.addObjectFile(b.path("deps/llama.cpp/build/src/libllama.a"));
    exe.addObjectFile(b.path("deps/llama.cpp/build/ggml/src/libggml.a"));
    exe.addObjectFile(b.path("deps/llama.cpp/build/ggml/src/libggml-base.a"));
    exe.addObjectFile(b.path("deps/llama.cpp/build/ggml/src/libggml-cpu.a"));
    exe.addObjectFile(b.path("deps/llama.cpp/build/common/libcommon.a"));
    exe.addObjectFile(b.path("deps/llama.cpp/build/ggml/src/ggml-blas/libggml-blas.a"));
    
    // Platform-specific optimizations  
    const target_info = target.result;
    if (target_info.cpu.arch.isX86()) {
        exe.defineCMacro("GGML_USE_AVX", "1");
        exe.defineCMacro("GGML_USE_AVX2", "1");
        exe.defineCMacro("GGML_USE_F16C", "1");
        exe.defineCMacro("GGML_USE_FMA", "1");
    } else if (target_info.cpu.arch.isARM()) {
        exe.defineCMacro("GGML_USE_NEON", "1");
    }
    
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());

    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&run_cmd.step);
}