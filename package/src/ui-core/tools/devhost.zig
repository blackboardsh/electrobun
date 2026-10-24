//! Open an HTML file in a native window rendered by the Electrobun UI core.
//! The file is reloaded when it changes on disk.
//! usage: devhost <file.html> [--dawn path] [--shot out.png] [--size WxH]
const std = @import("std");
const ui_core = @import("electrobun_ui");
const host = ui_core.host_macos;

const State = struct {
    path: []const u8,
    mtime: i96 = 0,
    io: std.Io,
    gpa: std.mem.Allocator,
    shot: ?[]const u8 = null,
    shot_frame: u64 = 0,
    last_check: f64 = 0,
};

fn onFrame(ctx: ?*anyopaque, win: *host.Window) void {
    const s: *State = @ptrCast(@alignCast(ctx.?));
    const now = win.ui.now;
    if (now - s.last_check > 0.3 or s.mtime == 0) {
        s.last_check = now;
        if (std.Io.Dir.cwd().statFile(s.io, s.path, .{})) |st| {
            const m = st.mtime.toNanoseconds();
            if (m != s.mtime) {
                s.mtime = m;
                if (std.Io.Dir.cwd().readFileAlloc(s.io, s.path, s.gpa, .limited(16 << 20))) |src| {
                    defer s.gpa.free(src);
                    // reset stylesheets added by the previous load
                    while (win.ui.doc.sheets.items.len > 0) win.ui.doc.removeStylesheet(win.ui.doc.sheets.items[0]);
                    win.ui.setHtml(src) catch |e| std.log.err("load failed: {}", .{e});
                    std.log.info("loaded {s}", .{s.path});
                } else |e| std.log.err("read failed: {}", .{e});
            }
        } else |_| {}
    }
    if (s.shot) |path| {
        if (win.frames >= 1 and s.shot_frame == 0) {
            s.shot_frame = win.frames;
            win.screenshot(path) catch |e| std.log.err("screenshot failed: {}", .{e});
            std.log.info("wrote {s}", .{path});
            std.process.exit(0);
        }
    }
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    var args = try init.minimal.args.iterateAllocator(gpa);
    defer args.deinit();
    _ = args.next();
    var path: ?[]const u8 = null;
    var dawn: []const u8 = "libwebgpu_dawn.dylib";
    var shot: ?[]const u8 = null;
    var w: f32 = 1000;
    var h: f32 = 680;
    while (args.next()) |a| {
        if (std.mem.eql(u8, a, "--dawn")) {
            dawn = args.next() orelse return error.Usage;
        } else if (std.mem.eql(u8, a, "--shot")) {
            shot = args.next() orelse return error.Usage;
        } else if (std.mem.eql(u8, a, "--size")) {
            const v = args.next() orelse return error.Usage;
            const x = std.mem.indexOfScalar(u8, v, 'x') orelse return error.Usage;
            w = try std.fmt.parseFloat(f32, v[0..x]);
            h = try std.fmt.parseFloat(f32, v[x + 1 ..]);
        } else path = a;
    }
    var state = State{ .path = path orelse return error.Usage, .io = init.io, .gpa = gpa, .shot = shot };
    const ui = try ui_core.Ui.create(gpa, .{});
    defer ui.destroy();
    try ui.images.setBaseDir(std.fs.path.dirname(state.path) orelse ".");
    const win = try host.Window.create(gpa, init.io, ui, .{ .title = "Electrobun UI — devhost", .width = w, .height = h, .dawn_path = dawn, .on_frame = onFrame, .ctx = &state });
    win.run();
}
