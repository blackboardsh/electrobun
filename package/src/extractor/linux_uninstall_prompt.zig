const std = @import("std");

pub const Selection = enum {
    app,
    app_and_data,
    cancel,
};

pub const Helper = enum {
    zenity,
    kdialog,
};

pub const HelperOutput = struct {
    term: std.process.Child.Term,
    stdout: []u8,
    stderr: []u8,

    pub fn deinit(self: *@This(), allocator: std.mem.Allocator) void {
        allocator.free(self.stdout);
        allocator.free(self.stderr);
        self.* = undefined;
    }
};

pub const Backend = struct {
    context: *anyopaque,
    run_helper: *const fn (
        context: *anyopaque,
        allocator: std.mem.Allocator,
        helper: Helper,
        argv: []const []const u8,
    ) anyerror!HelperOutput,
    graphical_session_available: *const fn (context: *anyopaque) bool,
    terminal_available: *const fn (context: *anyopaque) bool,
    terminal_prompt: *const fn (
        context: *anyopaque,
        allocator: std.mem.Allocator,
        app_name: []const u8,
    ) anyerror!Selection,
};

const HelperAttempt = union(enum) {
    selected: Selection,
    failed,
};

const SystemContext = struct {
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
};

/// Shows the Linux uninstall chooser. `InteractivePromptUnavailable` is
/// returned only after both graphical helpers fail and no usable terminal is
/// attached. Callers can use that distinct error to explain that an explicit
/// quiet invocation is required.
pub fn show(
    allocator: std.mem.Allocator,
    io: std.Io,
    environ_map: *const std.process.Environ.Map,
    app_name: []const u8,
) !Selection {
    var context = SystemContext{
        .io = io,
        .environ_map = environ_map,
    };
    return showWithBackend(
        allocator,
        app_name,
        shouldPreferKdialog(environ_map),
        .{
            .context = &context,
            .run_helper = runSystemHelper,
            .graphical_session_available = systemGraphicalSessionAvailable,
            .terminal_available = systemTerminalAvailable,
            .terminal_prompt = showSystemTerminalPrompt,
        },
    );
}

pub fn showWithBackend(
    allocator: std.mem.Allocator,
    app_name: []const u8,
    prefer_kdialog: bool,
    backend: Backend,
) !Selection {
    const helpers: [2]Helper = if (prefer_kdialog)
        .{ .kdialog, .zenity }
    else
        .{ .zenity, .kdialog };

    const title = try std.fmt.allocPrint(allocator, "Uninstall {s}?", .{app_name});
    defer allocator.free(title);

    if (backend.graphical_session_available(backend.context)) {
        for (helpers) |helper| {
            switch (tryHelper(allocator, backend, helper, title)) {
                .selected => |selection| return selection,
                .failed => continue,
            }
        }
    }

    if (!backend.terminal_available(backend.context)) {
        return error.InteractivePromptUnavailable;
    }
    return backend.terminal_prompt(backend.context, allocator, app_name);
}

pub fn shouldPreferKdialog(environ_map: *const std.process.Environ.Map) bool {
    if (environ_map.get("KDE_FULL_SESSION")) |value| {
        if (value.len != 0 and !std.ascii.eqlIgnoreCase(value, "false") and
            !std.mem.eql(u8, value, "0")) return true;
    }

    const desktop_keys = [_][]const u8{
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP",
        "DESKTOP_SESSION",
    };
    for (desktop_keys) |key| {
        const value = environ_map.get(key) orelse continue;
        if (std.ascii.indexOfIgnoreCase(value, "kde") != null or
            std.ascii.indexOfIgnoreCase(value, "plasma") != null)
        {
            return true;
        }
    }
    return false;
}

fn tryHelper(
    allocator: std.mem.Allocator,
    backend: Backend,
    helper: Helper,
    title: []const u8,
) HelperAttempt {
    const message = "The application will be removed.";
    var output = switch (helper) {
        .zenity => blk: {
            const argv = [_][]const u8{
                "zenity",
                "--question",
                "--title",
                title,
                "--text",
                message,
                "--ok-label",
                "App",
                "--cancel-label",
                "Cancel",
                "--extra-button",
                "App and Data",
            };
            break :blk backend.run_helper(
                backend.context,
                allocator,
                helper,
                &argv,
            ) catch return .failed;
        },
        .kdialog => blk: {
            const argv = [_][]const u8{
                "kdialog",
                "--yesnocancel",
                message,
                "--title",
                title,
                "--yes-label",
                "App",
                "--no-label",
                "App and Data",
                "--cancel-label",
                "Cancel",
            };
            break :blk backend.run_helper(
                backend.context,
                allocator,
                helper,
                &argv,
            ) catch return .failed;
        },
    };
    defer output.deinit(allocator);
    return parseHelperOutput(helper, output);
}

fn parseHelperOutput(helper: Helper, output: HelperOutput) HelperAttempt {
    const exit_code = switch (output.term) {
        .exited => |code| code,
        else => return .failed,
    };

    return switch (helper) {
        .zenity => if (hasDisplayConnectionDiagnostic(output.stderr))
            .failed
        else switch (exit_code) {
            // Verified Zenity behavior: the normal affirmative button exits 0
            // without output, while an extra button exits 1 and prints its
            // exact label. Exit 1 without output is cancel/window-close.
            0 => if (output.stdout.len == 0)
                .{ .selected = .app }
            else
                .failed,
            1 => if (std.mem.eql(u8, output.stdout, "App and Data\n"))
                .{ .selected = .app_and_data }
            else if (output.stdout.len == 0)
                .{ .selected = .cancel }
            else
                .failed,
            else => .failed,
        },
        .kdialog => switch (exit_code) {
            // KDialog documents yes/no/cancel as 0/1/2. Requiring no output
            // or diagnostics for the mutating results prevents a failed
            // helper from being confused with its exit-1 "No" selection.
            0 => if (output.stdout.len == 0 and output.stderr.len == 0)
                .{ .selected = .app }
            else
                .failed,
            1 => if (output.stdout.len == 0 and output.stderr.len == 0)
                .{ .selected = .app_and_data }
            else
                .failed,
            2 => if (output.stdout.len == 0 and output.stderr.len == 0)
                .{ .selected = .cancel }
            else
                .failed,
            else => .failed,
        },
    };
}

fn hasDisplayConnectionDiagnostic(stderr: []const u8) bool {
    const diagnostics = [_][]const u8{
        "failed to open display",
        "cannot open display",
        "can't open display",
        "unable to open display",
        "could not connect to display",
    };
    for (diagnostics) |diagnostic| {
        if (std.ascii.indexOfIgnoreCase(stderr, diagnostic) != null) return true;
    }
    return false;
}

fn runSystemHelper(
    raw_context: *anyopaque,
    allocator: std.mem.Allocator,
    _: Helper,
    argv: []const []const u8,
) !HelperOutput {
    const context: *SystemContext = @ptrCast(@alignCast(raw_context));
    const result = try std.process.run(allocator, context.io, .{
        .argv = argv,
        .environ_map = context.environ_map,
        .stdout_limit = .limited(4096),
        .stderr_limit = .limited(4096),
    });
    return .{
        .term = result.term,
        .stdout = result.stdout,
        .stderr = result.stderr,
    };
}

fn systemTerminalAvailable(raw_context: *anyopaque) bool {
    const context: *SystemContext = @ptrCast(@alignCast(raw_context));
    const stdin_is_tty = std.Io.File.stdin().isTty(context.io) catch false;
    const stderr_is_tty = std.Io.File.stderr().isTty(context.io) catch false;
    return stdin_is_tty and stderr_is_tty;
}

fn systemGraphicalSessionAvailable(raw_context: *anyopaque) bool {
    const context: *SystemContext = @ptrCast(@alignCast(raw_context));
    const display = context.environ_map.get("DISPLAY") orelse "";
    const wayland_display = context.environ_map.get("WAYLAND_DISPLAY") orelse "";
    return display.len != 0 or wayland_display.len != 0;
}

fn showSystemTerminalPrompt(
    raw_context: *anyopaque,
    allocator: std.mem.Allocator,
    app_name: []const u8,
) !Selection {
    const context: *SystemContext = @ptrCast(@alignCast(raw_context));
    const prompt = try std.fmt.allocPrint(
        allocator,
        "Uninstall {s}?\n" ++
            "The application will be removed.\n\n" ++
            "  1) App (default)\n" ++
            "  2) App and Data\n" ++
            "  3) Cancel\n\n" ++
            "Choice [1]: ",
        .{app_name},
    );
    defer allocator.free(prompt);
    try std.Io.File.stderr().writeStreamingAll(context.io, prompt);

    var input_buffer: [128]u8 = undefined;
    var file_reader = std.Io.File.stdin().readerStreaming(context.io, &input_buffer);
    const answer = file_reader.interface.takeDelimiter('\n') catch return .cancel;
    return parseTerminalAnswer(answer);
}

fn parseTerminalAnswer(answer: ?[]const u8) Selection {
    const trimmed = std.mem.trim(u8, answer orelse return .cancel, " \t\r\n");
    if (trimmed.len == 0 or std.mem.eql(u8, trimmed, "1")) return .app;
    if (std.mem.eql(u8, trimmed, "2")) return .app_and_data;
    return .cancel;
}

const FakeResponse = struct {
    helper: Helper,
    term: std.process.Child.Term = .{ .exited = 0 },
    stdout: []const u8 = "",
    stderr: []const u8 = "",
    fail: bool = false,
};

const FakeContext = struct {
    responses: []const FakeResponse,
    response_index: usize = 0,
    calls: [4]Helper = undefined,
    call_count: usize = 0,
    graphical_session_is_available: bool = true,
    terminal_is_available: bool = false,
    terminal_selection: Selection = .cancel,
    terminal_call_count: usize = 0,
    saw_contract_arguments: bool = true,

    fn backend(self: *@This()) Backend {
        return .{
            .context = self,
            .run_helper = fakeRunHelper,
            .graphical_session_available = fakeGraphicalSessionAvailable,
            .terminal_available = fakeTerminalAvailable,
            .terminal_prompt = fakeTerminalPrompt,
        };
    }
};

fn fakeRunHelper(
    raw_context: *anyopaque,
    allocator: std.mem.Allocator,
    helper: Helper,
    argv: []const []const u8,
) !HelperOutput {
    const context: *FakeContext = @ptrCast(@alignCast(raw_context));
    context.calls[context.call_count] = helper;
    context.call_count += 1;
    context.saw_contract_arguments = context.saw_contract_arguments and
        argvHasPair(argv, "--title", "Uninstall Test App?") and
        (argvHasPair(argv, "--text", "The application will be removed.") or
            argvHasValue(argv, "The application will be removed.")) and
        (argvHasPair(argv, "--ok-label", "App") or
            argvHasPair(argv, "--yes-label", "App")) and
        (argvHasPair(argv, "--extra-button", "App and Data") or
            argvHasPair(argv, "--no-label", "App and Data")) and
        argvHasPair(argv, "--cancel-label", "Cancel");

    if (context.response_index >= context.responses.len) return error.NoFakeResponse;
    const response = context.responses[context.response_index];
    context.response_index += 1;
    if (response.helper != helper) return error.UnexpectedHelper;
    if (response.fail) return error.HelperUnavailable;
    return .{
        .term = response.term,
        .stdout = try allocator.dupe(u8, response.stdout),
        .stderr = try allocator.dupe(u8, response.stderr),
    };
}

fn fakeTerminalAvailable(raw_context: *anyopaque) bool {
    const context: *FakeContext = @ptrCast(@alignCast(raw_context));
    return context.terminal_is_available;
}

fn fakeGraphicalSessionAvailable(raw_context: *anyopaque) bool {
    const context: *FakeContext = @ptrCast(@alignCast(raw_context));
    return context.graphical_session_is_available;
}

fn fakeTerminalPrompt(
    raw_context: *anyopaque,
    _: std.mem.Allocator,
    _: []const u8,
) !Selection {
    const context: *FakeContext = @ptrCast(@alignCast(raw_context));
    context.terminal_call_count += 1;
    return context.terminal_selection;
}

fn argvHasValue(argv: []const []const u8, value: []const u8) bool {
    for (argv) |arg| {
        if (std.mem.eql(u8, arg, value)) return true;
    }
    return false;
}

fn argvHasPair(argv: []const []const u8, option: []const u8, value: []const u8) bool {
    if (argv.len < 2) return false;
    for (argv[0 .. argv.len - 1], argv[1..]) |arg, next| {
        if (std.mem.eql(u8, arg, option) and std.mem.eql(u8, next, value)) return true;
    }
    return false;
}

test "parses verified Zenity exit and output combinations conservatively" {
    const app = HelperOutput{
        .term = .{ .exited = 0 },
        .stdout = @constCast(""),
        .stderr = @constCast(""),
    };
    try std.testing.expectEqual(Selection.app, parseHelperOutput(.zenity, app).selected);

    const app_and_data = HelperOutput{
        .term = .{ .exited = 1 },
        .stdout = @constCast("App and Data\n"),
        .stderr = @constCast(""),
    };
    try std.testing.expectEqual(
        Selection.app_and_data,
        parseHelperOutput(.zenity, app_and_data).selected,
    );

    const cancel = HelperOutput{
        .term = .{ .exited = 1 },
        .stdout = @constCast(""),
        .stderr = @constCast(""),
    };
    try std.testing.expectEqual(Selection.cancel, parseHelperOutput(.zenity, cancel).selected);

    const timeout = HelperOutput{
        .term = .{ .exited = 5 },
        .stdout = @constCast(""),
        .stderr = @constCast(""),
    };
    try std.testing.expect(parseHelperOutput(.zenity, timeout) == .failed);

    const ambiguous = HelperOutput{
        .term = .{ .exited = 1 },
        .stdout = @constCast("unexpected\n"),
        .stderr = @constCast(""),
    };
    try std.testing.expect(parseHelperOutput(.zenity, ambiguous) == .failed);

    const gtk_warning = HelperOutput{
        .term = .{ .exited = 0 },
        .stdout = @constCast(""),
        .stderr = @constCast("Gtk-WARNING: benign measurement warning\n"),
    };
    try std.testing.expectEqual(
        Selection.app,
        parseHelperOutput(.zenity, gtk_warning).selected,
    );

    const unavailable_display = HelperOutput{
        .term = .{ .exited = 1 },
        .stdout = @constCast(""),
        .stderr = @constCast("Gtk-WARNING: Failed to open display\n"),
    };
    try std.testing.expect(parseHelperOutput(.zenity, unavailable_display) == .failed);
}

test "parses KDialog yes no cancel and rejects diagnostic failures" {
    const empty = @constCast("");
    try std.testing.expectEqual(
        Selection.app,
        parseHelperOutput(.kdialog, .{
            .term = .{ .exited = 0 },
            .stdout = empty,
            .stderr = empty,
        }).selected,
    );
    try std.testing.expectEqual(
        Selection.app_and_data,
        parseHelperOutput(.kdialog, .{
            .term = .{ .exited = 1 },
            .stdout = empty,
            .stderr = empty,
        }).selected,
    );
    try std.testing.expectEqual(
        Selection.cancel,
        parseHelperOutput(.kdialog, .{
            .term = .{ .exited = 2 },
            .stdout = empty,
            .stderr = empty,
        }).selected,
    );
    try std.testing.expect(parseHelperOutput(.kdialog, .{
        .term = .{ .exited = 1 },
        .stdout = empty,
        .stderr = @constCast("could not connect to display\n"),
    }) == .failed);
}

test "prefers KDialog on KDE and falls back to Zenity on helper failure" {
    const responses = [_]FakeResponse{
        .{ .helper = .kdialog, .fail = true },
        .{ .helper = .zenity, .term = .{ .exited = 0 } },
    };
    var context = FakeContext{ .responses = &responses };
    try std.testing.expectEqual(
        Selection.app,
        try showWithBackend(std.testing.allocator, "Test App", true, context.backend()),
    );
    try std.testing.expectEqualSlices(Helper, &.{ .kdialog, .zenity }, context.calls[0..context.call_count]);
    try std.testing.expect(context.saw_contract_arguments);
    try std.testing.expectEqual(@as(usize, 0), context.terminal_call_count);
}

test "prefers Zenity outside KDE and does not retry a cancel" {
    const responses = [_]FakeResponse{
        .{ .helper = .zenity, .term = .{ .exited = 1 } },
    };
    var context = FakeContext{ .responses = &responses };
    try std.testing.expectEqual(
        Selection.cancel,
        try showWithBackend(std.testing.allocator, "Test App", false, context.backend()),
    );
    try std.testing.expectEqualSlices(Helper, &.{.zenity}, context.calls[0..context.call_count]);
    try std.testing.expectEqual(@as(usize, 0), context.terminal_call_count);
}

test "falls back to an attached terminal only after both GUI helpers fail" {
    const responses = [_]FakeResponse{
        .{ .helper = .zenity, .fail = true },
        .{ .helper = .kdialog, .term = .{ .exited = 5 } },
    };
    var context = FakeContext{
        .responses = &responses,
        .terminal_is_available = true,
        .terminal_selection = .app_and_data,
    };
    try std.testing.expectEqual(
        Selection.app_and_data,
        try showWithBackend(std.testing.allocator, "Test App", false, context.backend()),
    );
    try std.testing.expectEqual(@as(usize, 1), context.terminal_call_count);
}

test "reports unavailable when graphical helpers fail without a TTY" {
    const responses = [_]FakeResponse{
        .{ .helper = .zenity, .fail = true },
        .{ .helper = .kdialog, .fail = true },
    };
    var context = FakeContext{ .responses = &responses };
    try std.testing.expectError(
        error.InteractivePromptUnavailable,
        showWithBackend(std.testing.allocator, "Test App", false, context.backend()),
    );
    try std.testing.expectEqual(@as(usize, 0), context.terminal_call_count);
}

test "skips graphical helpers when no GUI session is available" {
    var context = FakeContext{
        .responses = &.{},
        .graphical_session_is_available = false,
        .terminal_is_available = true,
        .terminal_selection = .app,
    };
    try std.testing.expectEqual(
        Selection.app,
        try showWithBackend(std.testing.allocator, "Test App", false, context.backend()),
    );
    try std.testing.expectEqual(@as(usize, 0), context.call_count);
    try std.testing.expectEqual(@as(usize, 1), context.terminal_call_count);
}

test "no GUI session and no TTY reports unavailable without spawning" {
    var context = FakeContext{
        .responses = &.{},
        .graphical_session_is_available = false,
    };
    try std.testing.expectError(
        error.InteractivePromptUnavailable,
        showWithBackend(std.testing.allocator, "Test App", false, context.backend()),
    );
    try std.testing.expectEqual(@as(usize, 0), context.call_count);
    try std.testing.expectEqual(@as(usize, 0), context.terminal_call_count);
}

test "terminal answers keep App as default and cancel on EOF-invalid input" {
    try std.testing.expectEqual(Selection.app, parseTerminalAnswer("\n"));
    try std.testing.expectEqual(Selection.app, parseTerminalAnswer("1\n"));
    try std.testing.expectEqual(Selection.app_and_data, parseTerminalAnswer(" 2 \r\n"));
    try std.testing.expectEqual(Selection.cancel, parseTerminalAnswer("3\n"));
    try std.testing.expectEqual(Selection.cancel, parseTerminalAnswer("yes\n"));
    try std.testing.expectEqual(Selection.cancel, parseTerminalAnswer(null));
}

test "desktop environment detection prefers KDialog only for KDE and Plasma" {
    var environ_map = std.process.Environ.Map.init(std.testing.allocator);
    defer environ_map.deinit();

    try std.testing.expect(!shouldPreferKdialog(&environ_map));
    try environ_map.put("XDG_CURRENT_DESKTOP", "GNOME");
    try std.testing.expect(!shouldPreferKdialog(&environ_map));
    try environ_map.put("XDG_CURRENT_DESKTOP", "KDE");
    try std.testing.expect(shouldPreferKdialog(&environ_map));
    try environ_map.put("XDG_CURRENT_DESKTOP", "ubuntu:GNOME");
    try environ_map.put("XDG_SESSION_DESKTOP", "plasma");
    try std.testing.expect(shouldPreferKdialog(&environ_map));
}
