//! Software renderer for display lists. Used for headless rendering, tests
//! (pixel comparisons against the GPU path) and as a no-GPU fallback. Shapes
//! are evaluated per pixel with the same signed-distance formulas as the GPU
//! shaders so both backends agree.
const std = @import("std");
const geom = @import("../geom.zig");
const paint = @import("../paint.zig");
const font = @import("../text/font.zig");
const style_mod = @import("../style.zig");
const props = @import("../css/properties.zig");
const sdf = @import("sdf.zig");
const images = @import("../images.zig");

const Allocator = std.mem.Allocator;
const Rect = geom.Rect;
const Color = geom.Color;
const Corners = geom.Corners;
const Transform = geom.Transform;

/// Premultiplied RGBA8 image.
pub const Image = struct {
    w: u32,
    h: u32,
    px: []u8,

    pub fn init(gpa: Allocator, w: u32, h: u32) !Image {
        const px = try gpa.alloc(u8, @as(usize, w) * h * 4);
        @memset(px, 0);
        return .{ .w = w, .h = h, .px = px };
    }
    pub fn deinit(img: *Image, gpa: Allocator) void {
        gpa.free(img.px);
    }
    pub fn get(img: *const Image, x: u32, y: u32) [4]u8 {
        const i = (@as(usize, y) * img.w + x) * 4;
        return img.px[i..][0..4].*;
    }
};

const GlyphKey = struct { font: font.FontId, id: u32, sub: u8, scale: u32 };

const CachedGlyph = struct {
    w: u32,
    h: u32,
    left: i32,
    top: i32,
    channels: u8,
    px: []u8,
};

const Clip = struct {
    rect: Rect,
    radii: Corners,
    inv: Transform,
    /// device-space bounding box
    bounds: Rect,
};

const Layer = struct {
    img: Image,
    opacity: f32,
    filters: []const style_mod.Filter,
    bounds: Rect,
};

pub const Renderer = struct {
    gpa: Allocator,
    fonts: font.Backend,
    glyphs: std.AutoHashMapUnmanaged(GlyphKey, CachedGlyph) = .empty,
    store: ?*const images.Store = null,

    pub fn init(gpa: Allocator, fonts: font.Backend) Renderer {
        return .{ .gpa = gpa, .fonts = fonts };
    }

    pub fn deinit(r: *Renderer) void {
        var it = r.glyphs.valueIterator();
        while (it.next()) |g| r.gpa.free(g.px);
        r.glyphs.deinit(r.gpa);
    }

    fn glyph(r: *Renderer, fid: font.FontId, id: u32, scale: f32, subpx: f32) ?CachedGlyph {
        const sub: u8 = @intFromFloat(@floor(subpx * 4));
        const key = GlyphKey{ .font = fid, .id = id, .sub = sub, .scale = @intFromFloat(scale * 100) };
        if (r.glyphs.get(key)) |g| return if (g.w == 0) null else g;
        const bm = r.fonts.rasterize(fid, id, scale, @as(f32, @floatFromInt(sub)) / 4) orelse {
            r.glyphs.put(r.gpa, key, .{ .w = 0, .h = 0, .left = 0, .top = 0, .channels = 1, .px = &.{} }) catch {};
            return null;
        };
        const px = r.gpa.dupe(u8, bm.pixels[0 .. @as(usize, bm.width) * bm.height * bm.channels]) catch return null;
        const g = CachedGlyph{ .w = bm.width, .h = bm.height, .left = bm.left, .top = bm.top, .channels = bm.channels, .px = px };
        r.glyphs.put(r.gpa, key, g) catch {};
        return g;
    }

    /// Render a display list into `target` at `scale` device pixels per CSS px.
    pub fn render(r: *Renderer, dl: *const paint.DisplayList, target: *Image, scale: f32) !void {
        var ctx = Ctx{ .r = r, .scale = scale };
        defer ctx.deinit();
        // clear to the canvas background
        const bg = premul(dl.background);
        var i: usize = 0;
        while (i < target.px.len) : (i += 4) @memcpy(target.px[i..][0..4], &bg);
        try ctx.layers.append(r.gpa, .{ .img = target.*, .opacity = 1, .filters = &.{}, .bounds = .{ .w = @floatFromInt(target.w), .h = @floatFromInt(target.h) } });
        try ctx.transforms.append(r.gpa, Transform.scaling(scale, scale));
        for (dl.cmds.items) |cmd| try ctx.exec(cmd);
    }
};

fn premul(c: Color) [4]u8 {
    const a: u32 = c.a;
    return .{ @intCast((@as(u32, c.r) * a + 127) / 255), @intCast((@as(u32, c.g) * a + 127) / 255), @intCast((@as(u32, c.b) * a + 127) / 255), c.a };
}

const Ctx = struct {
    r: *Renderer,
    scale: f32,
    layers: std.ArrayList(Layer) = .empty,
    clips: std.ArrayList(Clip) = .empty,
    transforms: std.ArrayList(Transform) = .empty,

    fn deinit(c: *Ctx) void {
        // layer 0 is the caller's target
        for (c.layers.items[1..]) |*l| l.img.deinit(c.r.gpa);
        c.layers.deinit(c.r.gpa);
        c.clips.deinit(c.r.gpa);
        c.transforms.deinit(c.r.gpa);
    }

    fn top(c: *Ctx) *Image {
        return &c.layers.items[c.layers.items.len - 1].img;
    }
    fn xf(c: *Ctx) Transform {
        return c.transforms.items[c.transforms.items.len - 1];
    }

    fn exec(c: *Ctx, cmd: paint.Cmd) !void {
        switch (cmd) {
            .rect => |rc| c.fillShape(rc.rect, rc.radii, .{ .solid = premulF(rc.color) }),
            .border => |b| c.drawBorder(b.rect, b.radii, b.sides),
            .shadow => |s| c.drawShadow(s),
            .gradient => |g| c.drawGradient(g.rect, g.radii, g.clip, g.gradient),
            .glyphs => |g| c.drawGlyphs(g.glyphs, g.color, g.shadow),
            .image => |im| c.drawImage(im.rect, im.radii, im.image, im.src, im.opacity),
            .surface => {},
            .push_clip => |pc| {
                const t = c.xf();
                try c.clips.append(c.r.gpa, .{ .rect = pc.rect, .radii = pc.radii, .inv = t.invert() orelse Transform.identity, .bounds = t.boundsOf(pc.rect) });
            },
            .pop_clip => _ = c.clips.pop(),
            .push_transform => |t| {
                // element transforms are in CSS px; device = css * scale
                const cur = c.xf();
                try c.transforms.append(c.r.gpa, t.then(cur));
            },
            .pop_transform => _ = c.transforms.pop(),
            .push_layer => |l| {
                if (l.backdrop.len > 0) c.applyBackdrop(l.bounds, l.radii, l.backdrop);
                const base = c.top();
                const img = try Image.init(c.r.gpa, base.w, base.h);
                try c.layers.append(c.r.gpa, .{ .img = img, .opacity = l.opacity, .filters = l.filters, .bounds = c.xf().boundsOf(l.bounds) });
            },
            .pop_layer => {
                var layer = c.layers.pop().?;
                defer layer.img.deinit(c.r.gpa);
                c.applyFilters(&layer);
                c.composite(&layer);
            },
        }
    }

    // ------------------------------------------------------------------
    // Pixel loop
    // ------------------------------------------------------------------

    const Paint = union(enum) {
        solid: [4]f32,
    };

    fn deviceBounds(c: *Ctx, r: Rect, pad: f32) ?[4]i32 {
        var b = c.xf().boundsOf(r.outset(pad));
        for (c.clips.items) |cl| b = b.intersect(cl.bounds);
        const img = c.top();
        const x0: i32 = @intFromFloat(@max(0, @floor(b.x)));
        const y0: i32 = @intFromFloat(@max(0, @floor(b.y)));
        const x1: i32 = @intFromFloat(@min(@as(f32, @floatFromInt(img.w)), @ceil(b.x + b.w)));
        const y1: i32 = @intFromFloat(@min(@as(f32, @floatFromInt(img.h)), @ceil(b.y + b.h)));
        if (x1 <= x0 or y1 <= y0) return null;
        return .{ x0, y0, x1, y1 };
    }

    fn clipCoverage(c: *Ctx, dx: f32, dy: f32) f32 {
        var cov: f32 = 1;
        for (c.clips.items) |cl| {
            const p = cl.inv.apply(.{ .x = dx, .y = dy });
            const s = scaleOf(cl.inv);
            const d = sdf.roundedRect(p.x, p.y, cl.rect, cl.radii) / s;
            cov *= std.math.clamp(0.5 - d, 0, 1);
            if (cov <= 0) return 0;
        }
        return cov;
    }

    inline fn blend(img: *Image, x: i32, y: i32, src: [4]f32, cov: f32) void {
        if (cov <= 0) return;
        const i = (@as(usize, @intCast(y)) * img.w + @as(usize, @intCast(x))) * 4;
        const d = img.px[i..][0..4];
        const sa = src[3] * cov;
        const inv = 1 - sa;
        inline for (0..4) |k| {
            const sv = src[k] * cov * 255;
            const dv = @as(f32, @floatFromInt(d[k]));
            d[k] = @intFromFloat(std.math.clamp(sv + dv * inv + 0.5, 0, 255));
        }
    }

    fn fillShape(c: *Ctx, r: Rect, radii: Corners, p: Paint) void {
        const b = c.deviceBounds(r, 1) orelse return;
        const t = c.xf();
        const inv = t.invert() orelse return;
        const s = scaleOf(inv);
        const img = c.top();
        const color = p.solid;
        const has_clips = c.clips.items.len > 0;
        var y = b[1];
        while (y < b[3]) : (y += 1) {
            var x = b[0];
            while (x < b[2]) : (x += 1) {
                const dx = @as(f32, @floatFromInt(x)) + 0.5;
                const dy = @as(f32, @floatFromInt(y)) + 0.5;
                const lp = inv.apply(.{ .x = dx, .y = dy });
                const d = sdf.roundedRect(lp.x, lp.y, r, radii) / s;
                var cov = std.math.clamp(0.5 - d, 0, 1);
                if (cov <= 0) continue;
                if (has_clips) cov *= c.clipCoverage(dx, dy);
                blend(img, x, y, color, cov);
            }
        }
    }

    fn drawBorder(c: *Ctx, r: Rect, radii: Corners, sides: [4]paint.BorderSide) void {
        const b = c.deviceBounds(r, 1) orelse return;
        const t = c.xf();
        const inv = t.invert() orelse return;
        const s = scaleOf(inv);
        const img = c.top();
        const widths = geom.Edges{ .top = sides[0].width, .right = sides[1].width, .bottom = sides[2].width, .left = sides[3].width };
        const inner = r.inset(widths);
        const inner_r = sdf.innerRadii(radii, widths);
        const colors = [4][4]f32{ premulF(sides[0].color), premulF(sides[1].color), premulF(sides[2].color), premulF(sides[3].color) };
        const uniform = sides[0].color.eql(sides[1].color) and sides[1].color.eql(sides[2].color) and sides[2].color.eql(sides[3].color);
        var y = b[1];
        while (y < b[3]) : (y += 1) {
            var x = b[0];
            while (x < b[2]) : (x += 1) {
                const dx = @as(f32, @floatFromInt(x)) + 0.5;
                const dy = @as(f32, @floatFromInt(y)) + 0.5;
                const lp = inv.apply(.{ .x = dx, .y = dy });
                const d_out = sdf.roundedRect(lp.x, lp.y, r, radii) / s;
                const d_in = sdf.roundedRect(lp.x, lp.y, inner, inner_r) / s;
                var cov = @max(0, std.math.clamp(0.5 - d_out, 0, 1) - std.math.clamp(0.5 - d_in, 0, 1));
                if (cov <= 0) continue;
                const styled = sides[0].style == .dashed or sides[0].style == .dotted or sides[1].style == .dashed or sides[1].style == .dotted or sides[2].style == .dashed or sides[2].style == .dotted or sides[3].style == .dashed or sides[3].style == .dotted;
                const side = if (uniform and !styled) 0 else sdf.borderSide(lp.x, lp.y, r, widths);
                const st = sides[side].style;
                if (st == .dashed or st == .dotted) {
                    cov *= sdf.dashMask(lp.x, lp.y, r, side, sides[side].width, st == .dotted);
                    if (cov <= 0) continue;
                }
                if (c.clips.items.len > 0) cov *= c.clipCoverage(dx, dy);
                blend(img, x, y, colors[side], cov);
            }
        }
    }

    fn drawShadow(c: *Ctx, s: anytype) void {
        const sigma = s.blur / 2;
        const shape = Rect{ .x = s.box.x + s.offset_x - (if (s.inset) -s.spread else s.spread), .y = s.box.y + s.offset_y - (if (s.inset) -s.spread else s.spread), .w = s.box.w + 2 * (if (s.inset) -s.spread else s.spread), .h = s.box.h + 2 * (if (s.inset) -s.spread else s.spread) };
        const shape_r = if (s.inset) s.radii.shrink(s.spread) else growRadii(s.radii, s.spread);
        const extent = if (s.inset) s.box else shape.outset(sigma * 3 + 1);
        const b = c.deviceBounds(extent, 1) orelse return;
        const inv = c.xf().invert() orelse return;
        const sc = scaleOf(inv);
        const img = c.top();
        const color = premulF(s.color);
        var y = b[1];
        while (y < b[3]) : (y += 1) {
            var x = b[0];
            while (x < b[2]) : (x += 1) {
                const dx = @as(f32, @floatFromInt(x)) + 0.5;
                const dy = @as(f32, @floatFromInt(y)) + 0.5;
                const lp = inv.apply(.{ .x = dx, .y = dy });
                const box_d = sdf.roundedRect(lp.x, lp.y, s.box, s.radii) / sc;
                var cov: f32 = undefined;
                const sh = sdf.shadowAlpha(lp.x, lp.y, shape, shape_r, sigma);
                if (s.inset) {
                    cov = std.math.clamp(0.5 - box_d, 0, 1) * (1 - sh);
                } else {
                    cov = sh * std.math.clamp(0.5 + box_d, 0, 1);
                }
                if (cov <= 0.001) continue;
                if (c.clips.items.len > 0) cov *= c.clipCoverage(dx, dy);
                blend(img, x, y, color, cov);
            }
        }
    }

    fn drawGradient(c: *Ctx, r: Rect, radii: Corners, clip: Rect, g: style_mod.Gradient) void {
        const b = c.deviceBounds(clip, 1) orelse return;
        const inv = c.xf().invert() orelse return;
        const s = scaleOf(inv);
        const img = c.top();
        var lut: [256][4]f32 = undefined;
        sdf.gradientLut(g, r, &lut);
        var y = b[1];
        while (y < b[3]) : (y += 1) {
            var x = b[0];
            while (x < b[2]) : (x += 1) {
                const dx = @as(f32, @floatFromInt(x)) + 0.5;
                const dy = @as(f32, @floatFromInt(y)) + 0.5;
                const lp = inv.apply(.{ .x = dx, .y = dy });
                const d = @max(sdf.roundedRect(lp.x, lp.y, clip, radii), sdf.roundedRect(lp.x, lp.y, clip, .{})) / s;
                var cov = std.math.clamp(0.5 - d, 0, 1);
                if (cov <= 0) continue;
                if (c.clips.items.len > 0) cov *= c.clipCoverage(dx, dy);
                const t = sdf.gradientT(g, r, lp.x, lp.y);
                const idx: usize = @intFromFloat(std.math.clamp(t * 255 + 0.5, 0, 255));
                blend(img, x, y, lut[idx], cov);
            }
        }
    }

    fn drawGlyphs(c: *Ctx, glyphs: []const paint.GlyphInstance, color: Color, shadow: ?style_mod.Shadow) void {
        const t = c.xf();
        const sc = @sqrt(@abs(t.a * t.d - t.b * t.c));
        const col = premulF(if (shadow) |sh| sh.color else color);
        const ox: f32 = if (shadow) |sh| sh.x else 0;
        const oy: f32 = if (shadow) |sh| sh.y else 0;
        const img = c.top();
        const axis_aligned = t.b == 0 and t.c == 0;
        for (glyphs) |gi| {
            const dp = t.apply(.{ .x = gi.x + ox, .y = gi.y + oy });
            const fx = @floor(dp.x);
            const sub = dp.x - fx;
            const g = c.r.glyph(gi.font, gi.id, sc, if (axis_aligned) sub else 0) orelse continue;
            const gx0: i32 = @as(i32, @intFromFloat(fx)) + g.left;
            const gy0: i32 = @as(i32, @intFromFloat(@round(dp.y))) - g.top;
            var yy: u32 = 0;
            while (yy < g.h) : (yy += 1) {
                const py = gy0 + @as(i32, @intCast(yy));
                if (py < 0 or py >= img.h) continue;
                var xx: u32 = 0;
                while (xx < g.w) : (xx += 1) {
                    const px = gx0 + @as(i32, @intCast(xx));
                    if (px < 0 or px >= img.w) continue;
                    var cov: f32 = 1;
                    if (c.clips.items.len > 0) {
                        cov = c.clipCoverage(@as(f32, @floatFromInt(px)) + 0.5, @as(f32, @floatFromInt(py)) + 0.5);
                        if (cov <= 0) continue;
                    }
                    if (g.channels == 1) {
                        const a = @as(f32, @floatFromInt(g.px[yy * g.w + xx])) / 255;
                        if (a <= 0) continue;
                        blend(img, px, py, col, a * cov);
                    } else {
                        // BGRA premultiplied color glyph
                        const i = (yy * g.w + xx) * 4;
                        const src = [4]f32{
                            @as(f32, @floatFromInt(g.px[i + 2])) / 255,
                            @as(f32, @floatFromInt(g.px[i + 1])) / 255,
                            @as(f32, @floatFromInt(g.px[i + 0])) / 255,
                            @as(f32, @floatFromInt(g.px[i + 3])) / 255,
                        };
                        if (src[3] <= 0) continue;
                        const alpha_mul = @as(f32, @floatFromInt(color.a)) / 255;
                        blend(img, px, py, .{ src[0] * alpha_mul, src[1] * alpha_mul, src[2] * alpha_mul, src[3] * alpha_mul }, cov);
                    }
                }
            }
        }
    }

    fn drawImage(c: *Ctx, dst: Rect, radii: Corners, id: u32, src: Rect, opacity: f32) void {
        const store = c.r.store orelse return;
        const si = store.get(id) orelse return;
        const tex_v = Image{ .w = si.w, .h = si.h, .px = si.px };
        const tex = &tex_v;
        const b = c.deviceBounds(dst, 1) orelse return;
        const inv = c.xf().invert() orelse return;
        const s = scaleOf(inv);
        const img = c.top();
        var y = b[1];
        while (y < b[3]) : (y += 1) {
            var x = b[0];
            while (x < b[2]) : (x += 1) {
                const dx = @as(f32, @floatFromInt(x)) + 0.5;
                const dy = @as(f32, @floatFromInt(y)) + 0.5;
                const lp = inv.apply(.{ .x = dx, .y = dy });
                const d = sdf.roundedRect(lp.x, lp.y, dst, radii) / s;
                var cov = std.math.clamp(0.5 - d, 0, 1);
                if (cov <= 0) continue;
                if (c.clips.items.len > 0) cov *= c.clipCoverage(dx, dy);
                const u = src.x + (lp.x - dst.x) / dst.w * src.w;
                const v = src.y + (lp.y - dst.y) / dst.h * src.h;
                const texel = sampleBilinear(tex, u, v);
                blend(img, x, y, .{ texel[0] * opacity, texel[1] * opacity, texel[2] * opacity, texel[3] * opacity }, cov);
            }
        }
    }

    fn composite(c: *Ctx, layer: *Layer) void {
        const dst = c.top();
        const b = layer.bounds.outset(2);
        const x0: usize = @intFromFloat(std.math.clamp(@floor(b.x), 0, @as(f32, @floatFromInt(dst.w))));
        const y0: usize = @intFromFloat(std.math.clamp(@floor(b.y), 0, @as(f32, @floatFromInt(dst.h))));
        // filters (blur, drop-shadow) can extend past the bounds: composite the whole layer
        const whole = layer.filters.len > 0;
        const xs: usize = if (whole) 0 else x0;
        const ys: usize = if (whole) 0 else y0;
        const xe: usize = if (whole) dst.w else @intFromFloat(std.math.clamp(@ceil(b.x + b.w), 0, @as(f32, @floatFromInt(dst.w))));
        const ye: usize = if (whole) dst.h else @intFromFloat(std.math.clamp(@ceil(b.y + b.h), 0, @as(f32, @floatFromInt(dst.h))));
        var y = ys;
        while (y < ye) : (y += 1) {
            var x = xs;
            while (x < xe) : (x += 1) {
                const i = (y * dst.w + x) * 4;
                const s = layer.img.px[i..][0..4];
                if (s[3] == 0) continue;
                const src = [4]f32{ @as(f32, @floatFromInt(s[0])) / 255, @as(f32, @floatFromInt(s[1])) / 255, @as(f32, @floatFromInt(s[2])) / 255, @as(f32, @floatFromInt(s[3])) / 255 };
                blend(dst, @intCast(x), @intCast(y), src, layer.opacity);
            }
        }
    }

    fn applyFilters(c: *Ctx, layer: *Layer) void {
        for (layer.filters) |f| switch (f) {
            .blur => |radius| boxBlur(c.r.gpa, &layer.img, radius * c.scale),
            .opacity => |o| layer.opacity *= o,
            .drop_shadow => {},
            else => colorFilter(&layer.img, f),
        };
    }

    fn applyBackdrop(c: *Ctx, bounds: Rect, radii: Corners, filters: []const style_mod.Filter) void {
        const dst = c.top();
        const b = c.xf().boundsOf(bounds);
        const x0: u32 = @intFromFloat(std.math.clamp(@floor(b.x), 0, @as(f32, @floatFromInt(dst.w))));
        const y0: u32 = @intFromFloat(std.math.clamp(@floor(b.y), 0, @as(f32, @floatFromInt(dst.h))));
        const x1: u32 = @intFromFloat(std.math.clamp(@ceil(b.x + b.w), 0, @as(f32, @floatFromInt(dst.w))));
        const y1: u32 = @intFromFloat(std.math.clamp(@ceil(b.y + b.h), 0, @as(f32, @floatFromInt(dst.h))));
        if (x1 <= x0 or y1 <= y0) return;
        var region = Image.init(c.r.gpa, x1 - x0, y1 - y0) catch return;
        defer region.deinit(c.r.gpa);
        for (y0..y1) |y| {
            const srow = dst.px[(y * dst.w + x0) * 4 ..][0 .. (x1 - x0) * 4];
            @memcpy(region.px[(y - y0) * region.w * 4 ..][0 .. region.w * 4], srow);
        }
        for (filters) |f| switch (f) {
            .blur => |radius| boxBlur(c.r.gpa, &region, radius * c.scale),
            .opacity, .drop_shadow => {},
            else => colorFilter(&region, f),
        };
        const inv = c.xf().invert() orelse return;
        const s = scaleOf(inv);
        for (y0..y1) |y| for (x0..x1) |x| {
            const lp = inv.apply(.{ .x = @as(f32, @floatFromInt(x)) + 0.5, .y = @as(f32, @floatFromInt(y)) + 0.5 });
            const cov = std.math.clamp(0.5 - sdf.roundedRect(lp.x, lp.y, bounds, radii) / s, 0, 1);
            if (cov <= 0) continue;
            const di = (y * dst.w + x) * 4;
            const si = ((y - y0) * region.w + (x - x0)) * 4;
            for (0..4) |k| {
                const a = @as(f32, @floatFromInt(dst.px[di + k]));
                const bv = @as(f32, @floatFromInt(region.px[si + k]));
                dst.px[di + k] = @intFromFloat(a + (bv - a) * cov + 0.5);
            }
        };
    }
};

fn growRadii(r: Corners, d: f32) Corners {
    return .{ .tl = if (r.tl > 0) r.tl + d else 0, .tr = if (r.tr > 0) r.tr + d else 0, .br = if (r.br > 0) r.br + d else 0, .bl = if (r.bl > 0) r.bl + d else 0 };
}

fn scaleOf(inv: Transform) f32 {
    // device px per local unit is 1/sqrt(det(inv))
    const det = @abs(inv.a * inv.d - inv.b * inv.c);
    return if (det > 0) @sqrt(det) else 1;
}

fn premulF(c: Color) [4]f32 {
    const a = @as(f32, @floatFromInt(c.a)) / 255;
    return .{ @as(f32, @floatFromInt(c.r)) / 255 * a, @as(f32, @floatFromInt(c.g)) / 255 * a, @as(f32, @floatFromInt(c.b)) / 255 * a, a };
}

fn sampleBilinear(img: *const Image, u: f32, v: f32) [4]f32 {
    const fx = std.math.clamp(u - 0.5, 0, @as(f32, @floatFromInt(img.w - 1)));
    const fy = std.math.clamp(v - 0.5, 0, @as(f32, @floatFromInt(img.h - 1)));
    const x0: u32 = @intFromFloat(@floor(fx));
    const y0: u32 = @intFromFloat(@floor(fy));
    const x1 = @min(x0 + 1, img.w - 1);
    const y1 = @min(y0 + 1, img.h - 1);
    const tx = fx - @as(f32, @floatFromInt(x0));
    const ty = fy - @as(f32, @floatFromInt(y0));
    var out: [4]f32 = undefined;
    const p00 = img.get(x0, y0);
    const p10 = img.get(x1, y0);
    const p01 = img.get(x0, y1);
    const p11 = img.get(x1, y1);
    for (0..4) |k| {
        const top = @as(f32, @floatFromInt(p00[k])) * (1 - tx) + @as(f32, @floatFromInt(p10[k])) * tx;
        const bot = @as(f32, @floatFromInt(p01[k])) * (1 - tx) + @as(f32, @floatFromInt(p11[k])) * tx;
        out[k] = (top * (1 - ty) + bot * ty) / 255;
    }
    return out;
}

/// Three box-blur passes approximate a gaussian with the given sigma.
pub fn boxBlur(gpa: Allocator, img: *Image, sigma: f32) void {
    if (sigma < 0.5) return;
    const tmp = gpa.alloc(u8, img.px.len) catch return;
    defer gpa.free(tmp);
    // box sizes for 3 passes (Ivan Kutskir)
    const n: f32 = 3;
    const w_ideal = @sqrt(12 * sigma * sigma / n + 1);
    var wl: i32 = @intFromFloat(@floor(w_ideal));
    if (@rem(wl, 2) == 0) wl -= 1;
    const wu = wl + 2;
    const m_ideal = (12 * sigma * sigma - n * @as(f32, @floatFromInt(wl * wl)) - 4 * n * @as(f32, @floatFromInt(wl)) - 3 * n) / (-4 * @as(f32, @floatFromInt(wl)) - 4);
    const m: i32 = @intFromFloat(@round(m_ideal));
    var pass: i32 = 0;
    while (pass < 3) : (pass += 1) {
        const size = if (pass < m) wl else wu;
        const radius: usize = @intCast(@divTrunc(size - 1, 2));
        blurPass(img.px, tmp, img.w, img.h, radius, true);
        blurPass(tmp, img.px, img.w, img.h, radius, false);
    }
}

fn blurPass(src: []const u8, dst: []u8, w: u32, h: u32, r: usize, horizontal: bool) void {
    const len: usize = if (horizontal) w else h;
    const lines: usize = if (horizontal) h else w;
    const div: f32 = @floatFromInt(2 * r + 1);
    for (0..lines) |line| {
        var acc = [4]f32{ 0, 0, 0, 0 };
        const idx = struct {
            fn f(hz: bool, ww: u32, ln: usize, i: usize) usize {
                return if (hz) (ln * ww + i) * 4 else (i * ww + ln) * 4;
            }
        }.f;
        // initial window (clamped edges = transparent)
        var i: usize = 0;
        while (i <= r and i < len) : (i += 1) {
            const p = idx(horizontal, w, line, i);
            for (0..4) |k| acc[k] += @floatFromInt(src[p + k]);
        }
        for (0..len) |x| {
            const p = idx(horizontal, w, line, x);
            for (0..4) |k| dst[p + k] = @intFromFloat(std.math.clamp(acc[k] / div + 0.5, 0, 255));
            const add = x + r + 1;
            if (add < len) {
                const pa = idx(horizontal, w, line, add);
                for (0..4) |k| acc[k] += @floatFromInt(src[pa + k]);
            }
            if (x >= r) {
                const pr = idx(horizontal, w, line, x - r);
                for (0..4) |k| acc[k] -= @floatFromInt(src[pr + k]);
            }
        }
    }
}

fn colorFilter(img: *Image, f: style_mod.Filter) void {
    var i: usize = 0;
    while (i < img.px.len) : (i += 4) {
        const a = @as(f32, @floatFromInt(img.px[i + 3])) / 255;
        if (a == 0) continue;
        var c = [3]f32{ @as(f32, @floatFromInt(img.px[i])) / 255 / a, @as(f32, @floatFromInt(img.px[i + 1])) / 255 / a, @as(f32, @floatFromInt(img.px[i + 2])) / 255 / a };
        c = sdf.applyColorFilter(f, c);
        for (0..3) |k| img.px[i + k] = @intFromFloat(std.math.clamp(c[k] * a * 255 + 0.5, 0, 255));
    }
}

// ---------------------------------------------------------------------------
// PNG encoding (for screenshots and tests)
// ---------------------------------------------------------------------------

pub fn encodePng(gpa: Allocator, img: *const Image) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    try out.appendSlice(gpa, "\x89PNG\r\n\x1a\n");
    var ihdr: [13]u8 = undefined;
    std.mem.writeInt(u32, ihdr[0..4], img.w, .big);
    std.mem.writeInt(u32, ihdr[4..8], img.h, .big);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    try chunk(gpa, &out, "IHDR", &ihdr);
    // raw scanlines: filter byte 0 + un-premultiplied RGBA
    var raw: std.ArrayList(u8) = .empty;
    defer raw.deinit(gpa);
    for (0..img.h) |y| {
        try raw.append(gpa, 0);
        for (0..img.w) |x| {
            const p = img.get(@intCast(x), @intCast(y));
            if (p[3] == 0) {
                try raw.appendSlice(gpa, &.{ 0, 0, 0, 0 });
            } else {
                const a: u32 = p[3];
                try raw.appendSlice(gpa, &.{
                    @intCast(@min(255, (@as(u32, p[0]) * 255 + a / 2) / a)),
                    @intCast(@min(255, (@as(u32, p[1]) * 255 + a / 2) / a)),
                    @intCast(@min(255, (@as(u32, p[2]) * 255 + a / 2) / a)),
                    p[3],
                });
            }
        }
    }
    // zlib with stored deflate blocks
    var z: std.ArrayList(u8) = .empty;
    defer z.deinit(gpa);
    try z.appendSlice(gpa, &.{ 0x78, 0x01 });
    var off: usize = 0;
    while (off < raw.items.len or off == 0) {
        const n = @min(65535, raw.items.len - off);
        const last = off + n >= raw.items.len;
        try z.append(gpa, if (last) 1 else 0);
        var len: [4]u8 = undefined;
        std.mem.writeInt(u16, len[0..2], @intCast(n), .little);
        std.mem.writeInt(u16, len[2..4], ~@as(u16, @intCast(n)), .little);
        try z.appendSlice(gpa, &len);
        try z.appendSlice(gpa, raw.items[off .. off + n]);
        off += n;
        if (last) break;
    }
    const adler = std.hash.Adler32.permute(1, raw.items);
    var ad: [4]u8 = undefined;
    std.mem.writeInt(u32, &ad, adler, .big);
    try z.appendSlice(gpa, &ad);
    try chunk(gpa, &out, "IDAT", z.items);
    try chunk(gpa, &out, "IEND", "");
    return out.toOwnedSlice(gpa);
}

fn chunk(gpa: Allocator, out: *std.ArrayList(u8), kind: *const [4]u8, data: []const u8) !void {
    var len: [4]u8 = undefined;
    std.mem.writeInt(u32, &len, @intCast(data.len), .big);
    try out.appendSlice(gpa, &len);
    try out.appendSlice(gpa, kind);
    try out.appendSlice(gpa, data);
    var crc = std.hash.Crc32.init();
    crc.update(kind);
    crc.update(data);
    var c: [4]u8 = undefined;
    std.mem.writeInt(u32, &c, crc.final(), .big);
    try out.appendSlice(gpa, &c);
}

