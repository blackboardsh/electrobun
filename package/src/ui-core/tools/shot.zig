//! Render an HTML file to PNG with the CPU renderer.
//! usage: shot <input.html> <output.png> [width] [height] [scale]
const std = @import("std");
const ui_core = @import("electrobun_ui");

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    var args = try init.minimal.args.iterateAllocator(gpa);
    defer args.deinit();
    _ = args.next();
    const input = args.next() orelse return error.Usage;
    const output = args.next() orelse return error.Usage;
    const w = if (args.next()) |s| try std.fmt.parseFloat(f32, s) else 800;
    const h = if (args.next()) |s| try std.fmt.parseFloat(f32, s) else 600;
    const scale = if (args.next()) |s| try std.fmt.parseFloat(f32, s) else 2;

    const src = try std.Io.Dir.cwd().readFileAlloc(io, input, gpa, .limited(16 << 20));
    defer gpa.free(src);

    const ui = try ui_core.Ui.create(gpa, .{});
    defer ui.destroy();
    ui.images.io = io;
    try ui.images.setBaseDir(std.fs.path.dirname(input) orelse ".");
    if (std.mem.indexOf(u8, src, "eb-") != null) try ui.useComponents();
    try ui.setHtml(src);
    ui.resize(w, h, scale);
    const t0 = std.Io.Timestamp.now(io, .awake);
    _ = try ui.update();
    const t1 = std.Io.Timestamp.now(io, .awake);
    const t_update = t0.durationTo(t1).toNanoseconds();

    var renderer = ui_core.cpu.Renderer.init(gpa, ui.fonts);
    defer renderer.deinit();
    renderer.store = &ui.images;
    var img = try ui_core.cpu.Image.init(gpa, @intFromFloat(w * scale), @intFromFloat(h * scale));
    defer img.deinit(gpa);
    try renderer.render(&ui.dl, &img, scale);
    const t_render = t1.durationTo(std.Io.Timestamp.now(io, .awake)).toNanoseconds();
    const png = try ui_core.cpu.encodePng(gpa, &img);
    defer gpa.free(png);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = output, .data = png });
    std.debug.print("update {d:.2}ms ({d} layouts, {d} cache hits), cpu render {d:.2}ms, {d} cmds\n", .{ @as(f64, @floatFromInt(t_update)) / 1e6, ui.layout.computed, ui.layout.cache_hits, @as(f64, @floatFromInt(t_render)) / 1e6, ui.dl.cmds.items.len });
}
