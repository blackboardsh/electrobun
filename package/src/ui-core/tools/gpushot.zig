//! Render an HTML file with the WebGPU renderer (headless) and compare it
//! against the CPU renderer.
//! usage: gpushot <libwebgpu_dawn path> <input.html> <out.png> [w] [h] [scale]
const std = @import("std");
const ui_core = @import("electrobun_ui");
const wgpu = ui_core.wgpu;

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    var args = try init.minimal.args.iterateAllocator(gpa);
    defer args.deinit();
    _ = args.next();
    const lib = args.next() orelse return error.Usage;
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
    _ = try ui.update();

    const api = try gpa.create(wgpu.Api);
    defer gpa.destroy(api);
    api.* = try wgpu.Api.load(lib);
    const ctx = try wgpu.Context.create(api, null);
    const r = try ui_core.gpu.Renderer.init(gpa, api, ctx, ui.fonts, wgpu.TextureFormat.bgra8_unorm);
    defer r.deinit();
    r.store = &ui.images;
    const pw: u32 = @intFromFloat(w * scale);
    const ph: u32 = @intFromFloat(h * scale);
    const t0 = std.Io.Timestamp.now(io, .awake);
    try r.render(&ui.dl, pw, ph, scale);
    const px = try r.readPixels(gpa);
    defer gpa.free(px);
    const t1 = std.Io.Timestamp.now(io, .awake);
    // second frame timing (warm)
    try r.render(&ui.dl, pw, ph, scale);
    const px2 = try r.readPixels(gpa);
    gpa.free(px2);
    const t2 = std.Io.Timestamp.now(io, .awake);
    var img = ui_core.cpu.Image{ .w = pw, .h = ph, .px = px };
    const png = try ui_core.cpu.encodePng(gpa, &img);
    defer gpa.free(png);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = output, .data = png });

    // compare with the CPU renderer
    var cr = ui_core.cpu.Renderer.init(gpa, ui.fonts);
    defer cr.deinit();
    cr.store = &ui.images;
    var cimg = try ui_core.cpu.Image.init(gpa, pw, ph);
    defer cimg.deinit(gpa);
    try cr.render(&ui.dl, &cimg, scale);
    var diff: u64 = 0;
    var max_diff: u32 = 0;
    var bad: usize = 0;
    for (px, cimg.px) |a, b| {
        const d: u32 = @abs(@as(i32, a) - @as(i32, b));
        diff += d;
        max_diff = @max(max_diff, d);
        if (d > 24) bad += 1;
    }
    std.debug.print("gpu first frame {d:.2}ms, warm {d:.2}ms; {d} prims; vs cpu: mean abs diff {d:.3}, max {d}, {d} channels > 24\n", .{
        @as(f64, @floatFromInt(t0.durationTo(t1).toNanoseconds())) / 1e6,
        @as(f64, @floatFromInt(t1.durationTo(t2).toNanoseconds())) / 1e6,
        r.prims.items.len,
        @as(f64, @floatFromInt(diff)) / @as(f64, @floatFromInt(px.len)),
        max_diff,
        bad,
    });
}
