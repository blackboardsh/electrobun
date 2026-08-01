const std = @import("std");

pub const ErrorRoute = enum {
    missing_desktop_runtime,
    unrelated,
};

const desktop_runtime_prefixes = [_][]const u8{
    "libwebkit2gtk-",
    "libjavascriptcoregtk-",
    "libgtk-3",
    "libgdk-3",
    "libayatana-appindicator",
    "libappindicator",
    "librsvg-2",
    "libsoup-",
    "libglib-2",
    "libgobject-2",
    "libgio-2",
    "libgdk_pixbuf-2",
    "libcairo",
    "libpango",
    "libatk-",
};

fn isTokenBoundary(byte: u8) bool {
    return std.ascii.isWhitespace(byte) or switch (byte) {
        ':', '(', ')', '[', ']', '"', '\'', '=', '>' => true,
        else => false,
    };
}

fn normalizeSharedObjectToken(raw: []const u8) ?[]const u8 {
    var token = std.mem.trim(u8, raw, " \t\r\n:'\"()[]");
    if (std.mem.lastIndexOfScalar(u8, token, '/')) |slash| {
        token = token[slash + 1 ..];
    }

    if (!std.mem.startsWith(u8, token, "lib") or
        std.mem.indexOf(u8, token, ".so") == null)
    {
        return null;
    }

    for (desktop_runtime_prefixes) |prefix| {
        if (std.mem.startsWith(u8, token, prefix)) return token;
    }
    return null;
}

fn tokenBefore(line: []const u8, marker_index: usize) ?[]const u8 {
    var end = marker_index;
    while (end > 0 and isTokenBoundary(line[end - 1])) : (end -= 1) {}

    var start = end;
    while (start > 0 and !isTokenBoundary(line[start - 1])) : (start -= 1) {}
    return normalizeSharedObjectToken(line[start..end]);
}

fn tokenAfter(line: []const u8, start_index: usize) ?[]const u8 {
    var start = start_index;
    while (start < line.len and isTokenBoundary(line[start])) : (start += 1) {}

    var end = start;
    while (end < line.len and !isTokenBoundary(line[end])) : (end += 1) {}
    return normalizeSharedObjectToken(line[start..end]);
}

pub fn parseMissingDesktopLibrary(line: []const u8) ?[]const u8 {
    if (std.mem.indexOf(u8, line, "=> not found")) |marker| {
        return tokenBefore(line, marker);
    }

    if (std.mem.indexOf(u8, line, ": cannot open shared object file")) |marker| {
        return tokenBefore(line, marker);
    }

    const musl_prefix = "Error loading shared library ";
    if (std.mem.indexOf(u8, line, musl_prefix)) |prefix| {
        return tokenAfter(line, prefix + musl_prefix.len);
    }

    if (std.mem.indexOf(u8, line, ": No such file or directory")) |marker| {
        return tokenBefore(line, marker);
    }

    return null;
}

pub fn routeLoaderError(output: []const u8) ErrorRoute {
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        if (parseMissingDesktopLibrary(line) != null) {
            return .missing_desktop_runtime;
        }
    }
    return .unrelated;
}

pub fn appendMissingDesktopLibraries(
    libraries: *std.ArrayList([]const u8),
    output: []const u8,
) !void {
    var lines = std.mem.splitScalar(u8, output, '\n');
    while (lines.next()) |line| {
        const library = parseMissingDesktopLibrary(line) orelse continue;
        for (libraries.items) |existing| {
            if (std.mem.eql(u8, existing, library)) break;
        } else {
            try libraries.append(library);
        }
    }
}

pub fn formatDiagnostic(
    allocator: std.mem.Allocator,
    native_wrapper_path: []const u8,
    missing_libraries: []const []const u8,
) ![]u8 {
    var output = std.ArrayList(u8).init(allocator);
    errdefer output.deinit();
    const writer = output.writer();

    try writer.writeAll(
        "[LAUNCHER] Electrobun cannot start because Linux desktop runtime libraries are missing.\n" ++
            "[LAUNCHER] Missing shared libraries:\n",
    );
    for (missing_libraries) |library| {
        try writer.print("  - {s}\n", .{library});
    }

    try writer.writeAll(
        "[LAUNCHER] Install the runtime packages for your distro family:\n" ++
            "  Ubuntu/Debian: sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2\n" ++
            "  Fedora/RHEL:   sudo dnf install gtk3 webkit2gtk4.1 libappindicator-gtk3 librsvg2\n" ++
            "  Arch/Manjaro:  sudo pacman -S gtk3 webkit2gtk-4.1 libayatana-appindicator librsvg\n",
    );
    try writer.print(
        "[LAUNCHER] Inspect the complete dependency list with: ldd {s}\n",
        .{native_wrapper_path},
    );

    return output.toOwnedSlice();
}

pub fn shouldDiagnoseChildExit(exit_code: u8) bool {
    return exit_code != 0;
}

pub fn diagnoseNativeWrapperFailure(
    allocator: std.mem.Allocator,
    native_wrapper_path: []const u8,
    child_ld_library_path: ?[]const u8,
) !bool {
    std.fs.accessAbsolute(native_wrapper_path, .{}) catch return false;

    var diagnostic_env = try std.process.getEnvMap(allocator);
    defer diagnostic_env.deinit();
    _ = diagnostic_env.remove("LD_PRELOAD");
    if (child_ld_library_path) |ld_library_path| {
        try diagnostic_env.put("LD_LIBRARY_PATH", ld_library_path);
    } else {
        _ = diagnostic_env.remove("LD_LIBRARY_PATH");
    }

    const result = std.process.Child.run(.{
        .allocator = allocator,
        .argv = &.{ "ldd", native_wrapper_path },
        .env_map = &diagnostic_env,
        .max_output_bytes = 256 * 1024,
    }) catch return false;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);

    var missing_libraries = std.ArrayList([]const u8).init(allocator);
    defer missing_libraries.deinit();
    try appendMissingDesktopLibraries(&missing_libraries, result.stdout);
    try appendMissingDesktopLibraries(&missing_libraries, result.stderr);

    if (missing_libraries.items.len == 0) return false;

    const diagnostic = try formatDiagnostic(
        allocator,
        native_wrapper_path,
        missing_libraries.items,
    );
    defer allocator.free(diagnostic);
    std.debug.print("{s}", .{diagnostic});
    return true;
}

test "parses glibc ldd and runtime loader errors" {
    try std.testing.expectEqualStrings(
        "libwebkit2gtk-4.1.so.0",
        parseMissingDesktopLibrary("\tlibwebkit2gtk-4.1.so.0 => not found").?,
    );
    try std.testing.expectEqualStrings(
        "libgtk-3.so.0",
        parseMissingDesktopLibrary("launcher: error while loading shared libraries: libgtk-3.so.0: cannot open shared object file: No such file or directory").?,
    );
    try std.testing.expectEqualStrings(
        "libsoup-3.0.so.0",
        parseMissingDesktopLibrary("Error loading shared library libsoup-3.0.so.0 (needed by libwebkit2gtk-4.1.so.0)").?,
    );
}

test "runs dependency diagnosis only after a nonzero child exit" {
    try std.testing.expect(!shouldDiagnoseChildExit(0));
    try std.testing.expect(shouldDiagnoseChildExit(1));
    try std.testing.expect(shouldDiagnoseChildExit(127));
}

test "routes only missing Linux desktop runtime dependencies" {
    try std.testing.expectEqual(
        ErrorRoute.missing_desktop_runtime,
        routeLoaderError("ERR_DLOPEN_FAILED: libjavascriptcoregtk-4.1.so.0: cannot open shared object file: No such file or directory"),
    );
    try std.testing.expectEqual(
        ErrorRoute.unrelated,
        routeLoaderError("ERR_DLOPEN_FAILED: libPlugin.so: undefined symbol: plugin_init"),
    );
    try std.testing.expectEqual(
        ErrorRoute.unrelated,
        routeLoaderError("libNativeWrapper.so: invalid ELF header"),
    );
}

test "deduplicates missing libraries and formats package guidance" {
    const ldd_output =
        \\libgtk-3.so.0 => not found
        \\libwebkit2gtk-4.1.so.0 => not found
        \\libgtk-3.so.0 => not found
    ;

    var missing_libraries = std.ArrayList([]const u8).init(std.testing.allocator);
    defer missing_libraries.deinit();
    try appendMissingDesktopLibraries(&missing_libraries, ldd_output);
    try std.testing.expectEqual(@as(usize, 2), missing_libraries.items.len);

    const diagnostic = try formatDiagnostic(
        std.testing.allocator,
        "/opt/MyApp/libNativeWrapper.so",
        missing_libraries.items,
    );
    defer std.testing.allocator.free(diagnostic);

    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "libgtk-3.so.0") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "libwebkit2gtk-4.1.so.0") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "Ubuntu/Debian: sudo apt install") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "Fedora/RHEL:   sudo dnf install") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "Arch/Manjaro:  sudo pacman -S") != null);
    try std.testing.expect(std.mem.indexOf(u8, diagnostic, "ldd /opt/MyApp/libNativeWrapper.so") != null);
}
