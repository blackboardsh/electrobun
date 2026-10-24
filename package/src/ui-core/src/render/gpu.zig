//! WebGPU renderer for display lists. Every primitive is an instanced quad
//! whose fragment shader evaluates the same signed-distance math as the CPU
//! renderer (render/sdf.zig). Text uses a glyph atlas, gradients a LUT
//! texture, and opacity/filter groups render into offscreen layers. Frames are
//! drawn into a persistent offscreen target and then blitted to the surface.
const std = @import("std");
const wgpu = @import("wgpu.zig");
const geom = @import("../geom.zig");
const paint = @import("../paint.zig");
const font = @import("../text/font.zig");
const style_mod = @import("../style.zig");
const sdf = @import("sdf.zig");
const images_mod = @import("../images.zig");

const Allocator = std.mem.Allocator;
const Rect = geom.Rect;
const Color = geom.Color;
const Corners = geom.Corners;
const Transform = geom.Transform;

pub const shader_source = @embedFile("ui.wgsl");

const Kind = enum(u32) { rect = 0, border = 1, shadow = 2, gradient = 3, glyph = 4, color_glyph = 5, image = 6, layer = 7 };

const Prim = extern struct {
    bounds: [4]f32,
    rect: [4]f32 = .{ 0, 0, 0, 0 },
    radii: [4]f32 = .{ 0, 0, 0, 0 },
    color: [4]f32 = .{ 0, 0, 0, 0 },
    c1: [4]f32 = .{ 0, 0, 0, 0 },
    c2: [4]f32 = .{ 0, 0, 0, 0 },
    c3: [4]f32 = .{ 0, 0, 0, 0 },
    params: [4]f32 = .{ 0, 0, 0, 0 },
    xf0: [4]f32 = .{ 1, 0, 0, 1 },
    xf1: [4]f32 = .{ 0, 0, 0, 0 }, // e, f, kind, flags
    clip: [4]f32 = .{ -1e9, -1e9, 1e9, 1e9 }, // device-space x0,y0,x1,y1
    clip_rect: [4]f32 = .{ 0, 0, 0, 0 }, // local-space rounded clip
    clip_radii: [4]f32 = .{ 0, 0, 0, 0 },
    uv: [4]f32 = .{ 0, 0, 0, 0 },
};

const Uniforms = extern struct {
    viewport: [4]f32, // w, h (device px), scale, 0
};

const GlyphKey = struct { font: font.FontId, id: u32, sub: u8, scale: u32 };
const AtlasGlyph = struct { x: u16, y: u16, w: u16, h: u16, left: i32, top: i32, color: bool, empty: bool };

const Atlas = struct {
    tex: wgpu.Texture,
    view: wgpu.TextureView,
    size: u32,
    shelf_x: u32 = 0,
    shelf_y: u32 = 0,
    shelf_h: u32 = 0,
    format_bpp: u32,

    fn alloc(a: *Atlas, w: u32, h: u32) ?[2]u32 {
        if (w + 2 > a.size or h + 2 > a.size) return null;
        if (a.shelf_x + w + 1 > a.size) {
            a.shelf_y += a.shelf_h + 1;
            a.shelf_x = 0;
            a.shelf_h = 0;
        }
        if (a.shelf_y + h + 1 > a.size) return null;
        const pos = [2]u32{ a.shelf_x + 1, a.shelf_y + 1 };
        a.shelf_x += w + 1;
        a.shelf_h = @max(a.shelf_h, h + 1);
        return pos;
    }
    fn reset(a: *Atlas) void {
        a.shelf_x = 0;
        a.shelf_y = 0;
        a.shelf_h = 0;
    }
};

const ImageTex = struct {
    tex: wgpu.Texture,
    view: wgpu.TextureView,
    bind: wgpu.BindGroup,
    w: u32,
    h: u32,
};

const Target = struct {
    tex: wgpu.Texture,
    view: wgpu.TextureView,
    bind: ?wgpu.BindGroup = null, // as a group-1 texture
    w: u32,
    h: u32,
};

/// A recorded GPU operation.
const Op = union(enum) {
    /// draw prims [first, first+count) into target `target` with group-1 binding
    draw: struct { target: u32, first: u32, count: u32, bind: ?wgpu.BindGroup, clear: bool },
    /// blur `src` into `dst` along one axis
    blur: struct { src: u32, dst: u32, sigma: f32, horizontal: bool, clear: bool },
    copy: struct { src: u32, dst: u32 },
};

pub const Renderer = struct {
    gpa: Allocator,
    api: *const wgpu.Api,
    ctx: wgpu.Context,
    fonts: font.Backend,
    format: u32,

    pipeline: wgpu.RenderPipeline,
    blur_pipeline: wgpu.RenderPipeline,
    blit_pipeline: wgpu.RenderPipeline,
    bgl0: wgpu.BindGroupLayout,
    bgl1: wgpu.BindGroupLayout,
    blur_bgl: wgpu.BindGroupLayout,
    sampler: wgpu.Sampler,
    nearest: wgpu.Sampler,
    uniforms: wgpu.Buffer,
    prims_buf: ?wgpu.Buffer = null,
    prims_cap: usize = 0,
    bind0: ?wgpu.BindGroup = null,
    blur_uniforms: wgpu.Buffer,

    atlas: Atlas,
    color_atlas: Atlas,
    glyphs: std.AutoHashMapUnmanaged(GlyphKey, AtlasGlyph) = .empty,
    lut: wgpu.Texture,
    lut_view: wgpu.TextureView,
    lut_rows: u32 = 0,
    lut_data: std.ArrayList(u8) = .empty,
    dummy: ImageTex,
    store: ?*const images_mod.Store = null,
    textures: std.AutoHashMapUnmanaged(u32, struct { tex: ImageTex, version: u32 }) = .empty,

    /// target 0 = main offscreen; others are layer textures
    targets: std.ArrayList(Target) = .empty,
    free_layers: std.ArrayList(u32) = .empty,

    prims: std.ArrayList(Prim) = .empty,
    ops: std.ArrayList(Op) = .empty,
    blur_params: std.ArrayList([4]f32) = .empty,
    width: u32 = 0,
    height: u32 = 0,
    scale: f32 = 1,
    frame_count: u64 = 0,

    pub fn init(gpa: Allocator, api: *const wgpu.Api, ctx: wgpu.Context, fonts: font.Backend, format: u32) !*Renderer {
        const r = try gpa.create(Renderer);
        errdefer gpa.destroy(r);
        const dev = ctx.device;
        // shader
        var wgsl = wgpu.ShaderSourceWGSL{ .code = wgpu.StringView.from(shader_source) };
        const smd = wgpu.ShaderModuleDescriptor{ .next = &wgsl.chain };
        const module = api.deviceCreateShaderModule(dev, &smd) orelse return error.Shader;
        defer api.shaderModuleRelease(module);

        // group 0: uniforms, prims, glyph atlas, color atlas, lut, sampler
        const e0 = [_]wgpu.BindGroupLayoutEntry{
            .{ .binding = 0, .visibility = wgpu.shader_stage_vertex | wgpu.shader_stage_fragment, .buffer = .{ .type = wgpu.buffer_binding_uniform } },
            .{ .binding = 1, .visibility = wgpu.shader_stage_vertex | wgpu.shader_stage_fragment, .buffer = .{ .type = wgpu.buffer_binding_read_only_storage } },
            .{ .binding = 2, .visibility = wgpu.shader_stage_fragment, .texture = .{ .sample_type = wgpu.texture_sample_float, .view_dimension = wgpu.view_dimension_2d } },
            .{ .binding = 3, .visibility = wgpu.shader_stage_fragment, .texture = .{ .sample_type = wgpu.texture_sample_float, .view_dimension = wgpu.view_dimension_2d } },
            .{ .binding = 4, .visibility = wgpu.shader_stage_fragment, .texture = .{ .sample_type = wgpu.texture_sample_float, .view_dimension = wgpu.view_dimension_2d } },
            .{ .binding = 5, .visibility = wgpu.shader_stage_fragment, .sampler = .{ .type = wgpu.sampler_binding_filtering } },
        };
        const bgl0 = api.deviceCreateBindGroupLayout(dev, &.{ .entry_count = e0.len, .entries = &e0 }) orelse return error.Layout;
        // group 1: one texture (image / layer)
        const e1 = [_]wgpu.BindGroupLayoutEntry{
            .{ .binding = 0, .visibility = wgpu.shader_stage_fragment, .texture = .{ .sample_type = wgpu.texture_sample_float, .view_dimension = wgpu.view_dimension_2d } },
        };
        const bgl1 = api.deviceCreateBindGroupLayout(dev, &.{ .entry_count = e1.len, .entries = &e1 }) orelse return error.Layout;
        const layouts = [_]wgpu.BindGroupLayout{ bgl0, bgl1 };
        const pl = api.deviceCreatePipelineLayout(dev, &.{ .bind_group_layout_count = 2, .bind_group_layouts = &layouts }) orelse return error.Layout;
        const blend = wgpu.BlendState{};
        const target_state = [_]wgpu.ColorTargetState{.{ .format = wgpu.TextureFormat.bgra8_unorm, .blend = &blend }};
        const frag = wgpu.FragmentState{ .module = module, .entry_point = wgpu.StringView.from("fs_main"), .target_count = 1, .targets = &target_state };
        const pipeline = api.deviceCreateRenderPipeline(dev, &.{
            .layout = pl,
            .vertex = .{ .module = module, .entry_point = wgpu.StringView.from("vs_main") },
            .primitive = .{ .topology = wgpu.topology_triangle_strip },
            .fragment = &frag,
        }) orelse return error.Pipeline;

        // blur: uniforms + source texture + sampler
        const eb = [_]wgpu.BindGroupLayoutEntry{
            .{ .binding = 0, .visibility = wgpu.shader_stage_fragment, .buffer = .{ .type = wgpu.buffer_binding_uniform, .has_dynamic_offset = 1, .min_binding_size = 16 } },
            .{ .binding = 1, .visibility = wgpu.shader_stage_fragment, .texture = .{ .sample_type = wgpu.texture_sample_float, .view_dimension = wgpu.view_dimension_2d } },
            .{ .binding = 2, .visibility = wgpu.shader_stage_fragment, .sampler = .{ .type = wgpu.sampler_binding_filtering } },
        };
        const blur_bgl = api.deviceCreateBindGroupLayout(dev, &.{ .entry_count = eb.len, .entries = &eb }) orelse return error.Layout;
        const blur_layouts = [_]wgpu.BindGroupLayout{blur_bgl};
        const blur_pl = api.deviceCreatePipelineLayout(dev, &.{ .bind_group_layout_count = 1, .bind_group_layouts = &blur_layouts }) orelse return error.Layout;
        const no_blend_target = [_]wgpu.ColorTargetState{.{ .format = wgpu.TextureFormat.bgra8_unorm, .blend = null }};
        const blur_frag = wgpu.FragmentState{ .module = module, .entry_point = wgpu.StringView.from("fs_blur"), .target_count = 1, .targets = &no_blend_target };
        const blur_pipeline = api.deviceCreateRenderPipeline(dev, &.{
            .layout = blur_pl,
            .vertex = .{ .module = module, .entry_point = wgpu.StringView.from("vs_fullscreen") },
            .primitive = .{ .topology = wgpu.topology_triangle_list },
            .fragment = &blur_frag,
        }) orelse return error.Pipeline;
        const blit_target = [_]wgpu.ColorTargetState{.{ .format = format, .blend = null }};
        const blit_frag = wgpu.FragmentState{ .module = module, .entry_point = wgpu.StringView.from("fs_blit"), .target_count = 1, .targets = &blit_target };
        const blit_pipeline = api.deviceCreateRenderPipeline(dev, &.{
            .layout = blur_pl,
            .vertex = .{ .module = module, .entry_point = wgpu.StringView.from("vs_fullscreen") },
            .primitive = .{ .topology = wgpu.topology_triangle_list },
            .fragment = &blit_frag,
        }) orelse return error.Pipeline;

        const sampler = api.deviceCreateSampler(dev, &.{}) orelse return error.Sampler;
        const nearest = api.deviceCreateSampler(dev, &.{ .mag_filter = wgpu.filter_nearest, .min_filter = wgpu.filter_nearest }) orelse return error.Sampler;
        const uniforms = api.deviceCreateBuffer(dev, &.{ .usage = wgpu.buffer_usage_uniform | wgpu.buffer_usage_copy_dst, .size = @sizeOf(Uniforms) }) orelse return error.Buffer;
        const blur_uniforms = api.deviceCreateBuffer(dev, &.{ .usage = wgpu.buffer_usage_uniform | wgpu.buffer_usage_copy_dst, .size = 256 * 64 }) orelse return error.Buffer;

        r.* = .{
            .gpa = gpa,
            .api = api,
            .ctx = ctx,
            .fonts = fonts,
            .format = format,
            .pipeline = pipeline,
            .blur_pipeline = blur_pipeline,
            .blit_pipeline = blit_pipeline,
            .bgl0 = bgl0,
            .bgl1 = bgl1,
            .blur_bgl = blur_bgl,
            .sampler = sampler,
            .nearest = nearest,
            .uniforms = uniforms,
            .blur_uniforms = blur_uniforms,
            .atlas = try r.makeAtlas(2048, wgpu.TextureFormat.r8_unorm, 1),
            .color_atlas = try r.makeAtlas(1024, wgpu.TextureFormat.rgba8_unorm, 4),
            .lut = undefined,
            .lut_view = undefined,
            .dummy = undefined,
        };
        r.lut = api.deviceCreateTexture(dev, &.{ .usage = wgpu.texture_usage_texture_binding | wgpu.texture_usage_copy_dst, .size = .{ .width = 256, .height = 512 }, .format = wgpu.TextureFormat.rgba8_unorm }) orelse return error.Texture;
        r.lut_view = api.textureCreateView(r.lut, null) orelse return error.Texture;
        const white = [4]u8{ 255, 255, 255, 255 };
        r.dummy = try r.createImageTex(1, 1, &white);
        return r;
    }

    fn makeAtlas(r: *Renderer, size: u32, format: u32, bpp: u32) !Atlas {
        const tex = r.api.deviceCreateTexture(r.ctx.device, &.{ .usage = wgpu.texture_usage_texture_binding | wgpu.texture_usage_copy_dst, .size = .{ .width = size, .height = size }, .format = format }) orelse return error.Texture;
        const view = r.api.textureCreateView(tex, null) orelse return error.Texture;
        return .{ .tex = tex, .view = view, .size = size, .format_bpp = bpp };
    }

    pub fn deinit(r: *Renderer) void {
        const api = r.api;
        for (r.targets.items) |t| releaseTarget(api, t);
        r.targets.deinit(r.gpa);
        r.free_layers.deinit(r.gpa);
        var tit = r.textures.valueIterator();
        while (tit.next()) |t| releaseImage(api, t.tex);
        r.textures.deinit(r.gpa);
        releaseImage(api, r.dummy);
        r.glyphs.deinit(r.gpa);
        r.prims.deinit(r.gpa);
        r.ops.deinit(r.gpa);
        r.blur_params.deinit(r.gpa);
        r.lut_data.deinit(r.gpa);
        if (r.bind0) |b| api.bindGroupRelease(b);
        if (r.prims_buf) |b| api.bufferRelease(b);
        api.bufferRelease(r.uniforms);
        api.bufferRelease(r.blur_uniforms);
        api.textureViewRelease(r.atlas.view);
        api.textureRelease(r.atlas.tex);
        api.textureViewRelease(r.color_atlas.view);
        api.textureRelease(r.color_atlas.tex);
        api.textureViewRelease(r.lut_view);
        api.textureRelease(r.lut);
        api.samplerRelease(r.sampler);
        api.samplerRelease(r.nearest);
        r.gpa.destroy(r);
    }

    fn releaseImage(api: *const wgpu.Api, img: ImageTex) void {
        api.bindGroupRelease(img.bind);
        api.textureViewRelease(img.view);
        api.textureRelease(img.tex);
    }

    fn releaseTarget(api: *const wgpu.Api, t: Target) void {
        if (t.bind) |b| api.bindGroupRelease(b);
        api.textureViewRelease(t.view);
        api.textureDestroy(t.tex);
        api.textureRelease(t.tex);
    }

    fn createImageTex(r: *Renderer, w: u32, h: u32, rgba_premul: []const u8) !ImageTex {
        const api = r.api;
        const tex = api.deviceCreateTexture(r.ctx.device, &.{ .usage = wgpu.texture_usage_texture_binding | wgpu.texture_usage_copy_dst, .size = .{ .width = w, .height = h }, .format = wgpu.TextureFormat.rgba8_unorm }) orelse return error.Texture;
        const view = api.textureCreateView(tex, null) orelse return error.Texture;
        api.queueWriteTexture(r.ctx.queue, &.{ .texture = tex }, rgba_premul.ptr, rgba_premul.len, &.{ .bytes_per_row = w * 4, .rows_per_image = h }, &.{ .width = w, .height = h });
        const entries = [_]wgpu.BindGroupEntry{.{ .binding = 0, .texture_view = view }};
        const bind = api.deviceCreateBindGroup(r.ctx.device, &.{ .layout = r.bgl1, .entry_count = 1, .entries = &entries }) orelse return error.BindGroup;
        return .{ .tex = tex, .view = view, .bind = bind, .w = w, .h = h };
    }

    /// GPU texture for a store image, uploading on first use or change.
    fn textureFor(r: *Renderer, id: u32) ?ImageTex {
        const store = r.store orelse return null;
        const img = store.get(id) orelse return null;
        if (r.textures.get(id)) |t| {
            if (t.version == img.version) return t.tex;
            releaseImage(r.api, t.tex);
        }
        const tex = r.createImageTex(img.w, img.h, img.px) catch return null;
        r.textures.put(r.gpa, id, .{ .tex = tex, .version = img.version }) catch return null;
        return tex;
    }

    fn ensureTargets(r: *Renderer, w: u32, h: u32) !void {
        if (r.width == w and r.height == h and r.targets.items.len > 0) return;
        for (r.targets.items) |t| releaseTarget(r.api, t);
        r.targets.clearRetainingCapacity();
        r.free_layers.clearRetainingCapacity();
        r.width = w;
        r.height = h;
        _ = try r.newTarget();
    }

    fn newTarget(r: *Renderer) !u32 {
        const api = r.api;
        const tex = api.deviceCreateTexture(r.ctx.device, &.{
            .usage = wgpu.texture_usage_render_attachment | wgpu.texture_usage_texture_binding | wgpu.texture_usage_copy_src | wgpu.texture_usage_copy_dst,
            .size = .{ .width = r.width, .height = r.height },
            .format = wgpu.TextureFormat.bgra8_unorm,
        }) orelse return error.Texture;
        const view = api.textureCreateView(tex, null) orelse return error.Texture;
        const entries = [_]wgpu.BindGroupEntry{.{ .binding = 0, .texture_view = view }};
        const bind = api.deviceCreateBindGroup(r.ctx.device, &.{ .layout = r.bgl1, .entry_count = 1, .entries = &entries });
        try r.targets.append(r.gpa, .{ .tex = tex, .view = view, .bind = bind, .w = r.width, .h = r.height });
        return @intCast(r.targets.items.len - 1);
    }

    fn acquireLayer(r: *Renderer) !u32 {
        if (r.free_layers.pop()) |i| return i;
        return r.newTarget();
    }

    // ------------------------------------------------------------------
    // Glyphs
    // ------------------------------------------------------------------

    fn glyph(r: *Renderer, fid: font.FontId, id: u32, scale: f32, subpx: f32) ?AtlasGlyph {
        const sub: u8 = @intFromFloat(@floor(subpx * 4));
        const key = GlyphKey{ .font = fid, .id = id, .sub = sub, .scale = @intFromFloat(scale * 100) };
        if (r.glyphs.get(key)) |g| return if (g.empty) null else g;
        const bm = r.fonts.rasterize(fid, id, scale, @as(f32, @floatFromInt(sub)) / 4) orelse {
            r.glyphs.put(r.gpa, key, .{ .x = 0, .y = 0, .w = 0, .h = 0, .left = 0, .top = 0, .color = false, .empty = true }) catch {};
            return null;
        };
        const color = bm.channels == 4;
        const atlas = if (color) &r.color_atlas else &r.atlas;
        const pos = atlas.alloc(bm.width, bm.height) orelse blk: {
            // atlas full: start over (glyphs re-rasterize on demand)
            r.resetGlyphs();
            break :blk atlas.alloc(bm.width, bm.height) orelse return null;
        };
        if (color) {
            // BGRA premultiplied -> RGBA premultiplied
            const n = @as(usize, bm.width) * bm.height;
            const buf = r.gpa.alloc(u8, n * 4) catch return null;
            defer r.gpa.free(buf);
            for (0..n) |i| {
                buf[i * 4 + 0] = bm.pixels[i * 4 + 2];
                buf[i * 4 + 1] = bm.pixels[i * 4 + 1];
                buf[i * 4 + 2] = bm.pixels[i * 4 + 0];
                buf[i * 4 + 3] = bm.pixels[i * 4 + 3];
            }
            r.api.queueWriteTexture(r.ctx.queue, &.{ .texture = atlas.tex, .origin = .{ .x = pos[0], .y = pos[1] } }, buf.ptr, buf.len, &.{ .bytes_per_row = bm.width * 4, .rows_per_image = bm.height }, &.{ .width = bm.width, .height = bm.height });
        } else {
            r.api.queueWriteTexture(r.ctx.queue, &.{ .texture = atlas.tex, .origin = .{ .x = pos[0], .y = pos[1] } }, bm.pixels.ptr, @as(usize, bm.width) * bm.height, &.{ .bytes_per_row = bm.width, .rows_per_image = bm.height }, &.{ .width = bm.width, .height = bm.height });
        }
        const g = AtlasGlyph{ .x = @intCast(pos[0]), .y = @intCast(pos[1]), .w = @intCast(bm.width), .h = @intCast(bm.height), .left = bm.left, .top = bm.top, .color = color, .empty = false };
        r.glyphs.put(r.gpa, key, g) catch {};
        return g;
    }

    fn resetGlyphs(r: *Renderer) void {
        r.glyphs.clearRetainingCapacity();
        r.atlas.reset();
        r.color_atlas.reset();
    }

    // ------------------------------------------------------------------
    // Frame building
    // ------------------------------------------------------------------

    const ClipEntry = struct { rect: Rect, radii: Corners, xf: Transform, device: Rect };

    const Builder = struct {
        r: *Renderer,
        transforms: std.ArrayList(Transform) = .empty,
        clips: std.ArrayList(ClipEntry) = .empty,
        layer_stack: std.ArrayList(struct { target: u32, opacity: f32, filters: []const style_mod.Filter, bounds: Rect, saved_clips: usize }) = .empty,
        target: u32 = 0,
        pending_first: u32 = 0,
        pending_bind: ?wgpu.BindGroup = null,
        first_draw_of_target: bool = true,
        clear_next: bool = true,

        fn deinit(b: *Builder) void {
            const gpa = b.r.gpa;
            b.transforms.deinit(gpa);
            b.clips.deinit(gpa);
            b.layer_stack.deinit(gpa);
        }

        fn xf(b: *Builder) Transform {
            return b.transforms.items[b.transforms.items.len - 1];
        }

        /// flush pending prims as a draw op
        fn flush(b: *Builder) !void {
            const r = b.r;
            const n: u32 = @intCast(r.prims.items.len);
            if (n > b.pending_first or b.clear_next) {
                try r.ops.append(r.gpa, .{ .draw = .{ .target = b.target, .first = b.pending_first, .count = n - b.pending_first, .bind = b.pending_bind, .clear = b.clear_next } });
                b.clear_next = false;
            }
            b.pending_first = n;
        }

        fn setBind(b: *Builder, bind: ?wgpu.BindGroup) !void {
            if (bind == b.pending_bind) return;
            if (b.r.prims.items.len > b.pending_first) try b.flush();
            b.pending_bind = bind;
        }

        fn emit(b: *Builder, p0: Prim) !void {
            var p = p0;
            const t = b.xf();
            p.xf0 = .{ t.a, t.b, t.c, t.d };
            p.xf1[0] = t.e;
            p.xf1[1] = t.f;
            // device-space rect clip: intersection of all clip bounds
            var dev = Rect{ .x = -1e9, .y = -1e9, .w = 2e9, .h = 2e9 };
            for (b.clips.items) |c| dev = dev.intersect(c.device);
            const s = b.r.scale;
            p.clip = .{ dev.x * s, dev.y * s, (dev.x + dev.w) * s, (dev.y + dev.h) * s };
            // innermost rounded clip in the prim's own space (when it shares the transform)
            var i = b.clips.items.len;
            while (i > 0) {
                i -= 1;
                const c = b.clips.items[i];
                if (c.radii.isZero()) continue;
                if (std.meta.eql(c.xf, t)) {
                    p.clip_rect = .{ c.rect.x, c.rect.y, c.rect.w, c.rect.h };
                    p.clip_radii = .{ c.radii.tl, c.radii.tr, c.radii.br, c.radii.bl };
                    p.xf1[3] = 1;
                }
                break;
            }
            if (dev.w <= 0 or dev.h <= 0) return;
            try b.r.prims.append(b.r.gpa, p);
        }
    };

    fn premulF(c: Color) [4]f32 {
        const a = @as(f32, @floatFromInt(c.a)) / 255;
        return .{ @as(f32, @floatFromInt(c.r)) / 255 * a, @as(f32, @floatFromInt(c.g)) / 255 * a, @as(f32, @floatFromInt(c.b)) / 255 * a, a };
    }

    fn rectArr(r: Rect) [4]f32 {
        return .{ r.x, r.y, r.w, r.h };
    }
    fn radiiArr(c: Corners) [4]f32 {
        return .{ c.tl, c.tr, c.br, c.bl };
    }

    fn kindBits(k: Kind) f32 {
        return @floatFromInt(@intFromEnum(k));
    }

    fn lutRow(r: *Renderer, g: style_mod.Gradient, rect: Rect) !u32 {
        if (r.lut_rows >= 512) return 511;
        var lut: [256][4]f32 = undefined;
        sdf.gradientLut(g, rect, &lut);
        const row = r.lut_rows;
        r.lut_rows += 1;
        try r.lut_data.ensureTotalCapacity(r.gpa, (row + 1) * 256 * 4);
        for (lut) |c| {
            for (0..4) |k| r.lut_data.appendAssumeCapacity(@intFromFloat(std.math.clamp(c[k] * 255 + 0.5, 0, 255)));
        }
        return row;
    }

    fn buildFrame(r: *Renderer, dl: *const paint.DisplayList) !void {
        r.prims.clearRetainingCapacity();
        r.ops.clearRetainingCapacity();
        r.blur_params.clearRetainingCapacity();
        r.lut_rows = 0;
        r.lut_data.clearRetainingCapacity();
        var b = Builder{ .r = r };
        defer b.deinit();
        try b.transforms.append(r.gpa, Transform.identity);
        // background
        try b.emit(.{ .bounds = .{ 0, 0, @as(f32, @floatFromInt(r.width)) / r.scale, @as(f32, @floatFromInt(r.height)) / r.scale }, .rect = .{ -1, -1, 1e6, 1e6 }, .color = premulF(dl.background), .xf1 = .{ 0, 0, kindBits(.rect), 0 } });
        const aa = 1.0 / r.scale;
        for (dl.cmds.items) |cmd| switch (cmd) {
            .rect => |c| {
                if (c.color.a == 0) continue;
                try b.setBind(null);
                try b.emit(.{ .bounds = rectArr(c.rect.outset(aa)), .rect = rectArr(c.rect), .radii = radiiArr(c.radii), .color = premulF(c.color), .xf1 = .{ 0, 0, kindBits(.rect), 0 } });
            },
            .border => |c| {
                try b.setBind(null);
                const s = c.sides;
                const style_code = struct {
                    fn f(st: @import("../css/properties.zig").BorderStyle) f32 {
                        return switch (st) {
                            .dashed => 1,
                            .dotted => 2,
                            else => 0,
                        };
                    }
                }.f;
                try b.emit(.{
                    .bounds = rectArr(c.rect.outset(aa)),
                    .rect = rectArr(c.rect),
                    .radii = radiiArr(c.radii),
                    .color = premulF(s[0].color),
                    .c1 = premulF(s[1].color),
                    .c2 = premulF(s[2].color),
                    .c3 = premulF(s[3].color),
                    .params = .{ s[0].width, s[1].width, s[2].width, s[3].width },
                    .uv = .{ style_code(s[0].style), style_code(s[1].style), style_code(s[2].style), style_code(s[3].style) },
                    .xf1 = .{ 0, 0, kindBits(.border), 0 },
                });
            },
            .shadow => |c| {
                try b.setBind(null);
                const sigma = c.blur / 2;
                const sp = if (c.inset) -c.spread else c.spread;
                const shape = Rect{ .x = c.box.x + c.offset_x - sp, .y = c.box.y + c.offset_y - sp, .w = c.box.w + 2 * sp, .h = c.box.h + 2 * sp };
                const shape_r = if (c.inset) c.radii.shrink(c.spread) else growRadii(c.radii, c.spread);
                const extent = if (c.inset) c.box else shape.outset(sigma * 3 + 1);
                try b.emit(.{
                    .bounds = rectArr(extent.outset(aa)),
                    .rect = rectArr(shape),
                    .radii = radiiArr(shape_r),
                    .color = premulF(c.color),
                    .c1 = rectArr(c.box),
                    .c2 = radiiArr(c.radii),
                    .params = .{ sigma, if (c.inset) 1 else 0, 0, 0 },
                    .xf1 = .{ 0, 0, kindBits(.shadow), 0 },
                });
            },
            .gradient => |c| {
                try b.setBind(null);
                const row = try r.lutRow(c.gradient, c.rect);
                const gg = sdf.gradientGeom(c.gradient, c.rect);
                var range = [2]f32{ 0, 1 };
                if (c.gradient.repeating) {
                    var pos: [64]f32 = undefined;
                    const n = sdf.resolveStops(c.gradient, c.rect, &pos);
                    if (n > 0) range = .{ pos[0], pos[n - 1] };
                }
                const kind: f32 = switch (c.gradient.kind) {
                    .linear => 0,
                    .radial => 1,
                    .conic => 2,
                };
                try b.emit(.{
                    .bounds = rectArr(c.clip.outset(aa)),
                    .rect = rectArr(c.clip),
                    .radii = radiiArr(c.radii),
                    .c1 = .{ gg.cx, gg.cy, gg.dx, gg.dy },
                    .c2 = .{ gg.len, gg.rx, gg.ry, kind },
                    .c3 = .{ (@as(f32, @floatFromInt(row)) + 0.5) / 512.0, range[0], range[1], if (c.gradient.repeating) 1 else 0 },
                    .params = .{ c.gradient.angle, 0, 0, 0 },
                    .xf1 = .{ 0, 0, kindBits(.gradient), 0 },
                });
            },
            .glyphs => |c| {
                try b.setBind(null);
                const t = b.xf();
                const sc = @sqrt(@abs(t.a * t.d - t.b * t.c)) * r.scale;
                const axis = t.b == 0 and t.c == 0;
                const ox: f32 = if (c.shadow) |sh| sh.x else 0;
                const oy: f32 = if (c.shadow) |sh| sh.y else 0;
                const col = premulF(if (c.shadow) |sh| sh.color else c.color);
                for (c.glyphs) |gi| {
                    // device-space pen position
                    const dp = t.apply(.{ .x = gi.x + ox, .y = gi.y + oy });
                    const dx = dp.x * r.scale;
                    const dy = dp.y * r.scale;
                    const fx = @floor(dx);
                    const sub = if (axis) dx - fx else 0;
                    const g = r.glyph(gi.font, gi.id, sc, sub) orelse continue;
                    const gx = fx + @as(f32, @floatFromInt(g.left));
                    const gy = @round(dy) - @as(f32, @floatFromInt(g.top));
                    const atlas_size: f32 = @floatFromInt(if (g.color) r.color_atlas.size else r.atlas.size);
                    var p = Prim{
                        .bounds = .{ gx / r.scale, gy / r.scale, @as(f32, @floatFromInt(g.w)) / r.scale, @as(f32, @floatFromInt(g.h)) / r.scale },
                        .color = if (g.color) .{ 1, 1, 1, @as(f32, @floatFromInt(c.color.a)) / 255 } else col,
                        .uv = .{ @as(f32, @floatFromInt(g.x)) / atlas_size, @as(f32, @floatFromInt(g.y)) / atlas_size, @as(f32, @floatFromInt(g.w)) / atlas_size, @as(f32, @floatFromInt(g.h)) / atlas_size },
                        .xf1 = .{ 0, 0, kindBits(if (g.color) .color_glyph else .glyph), 0 },
                    };
                    // glyph quads are in device space already: identity transform
                    const saved = b.transforms.items[b.transforms.items.len - 1];
                    b.transforms.items[b.transforms.items.len - 1] = Transform.identity;
                    p.rect = p.bounds;
                    try b.emit(p);
                    b.transforms.items[b.transforms.items.len - 1] = saved;
                }
            },
            .image => |c| {
                const img = r.textureFor(c.image) orelse continue;
                try b.setBind(img.bind);
                const iw: f32 = @floatFromInt(img.w);
                const ih: f32 = @floatFromInt(img.h);
                try b.emit(.{
                    .bounds = rectArr(c.rect),
                    .rect = rectArr(c.rect),
                    .radii = radiiArr(c.radii),
                    .uv = .{ c.src.x / iw, c.src.y / ih, c.src.w / iw, c.src.h / ih },
                    .params = .{ c.opacity, 0, 0, 0 },
                    .xf1 = .{ 0, 0, kindBits(.image), 0 },
                });
            },
            .surface => {},
            .push_clip => |c| {
                const t = b.xf();
                try b.clips.append(r.gpa, .{ .rect = c.rect, .radii = c.radii, .xf = t, .device = t.boundsOf(c.rect) });
            },
            .pop_clip => _ = b.clips.pop(),
            .push_transform => |t| {
                const cur = b.xf();
                try b.transforms.append(r.gpa, t.then(cur));
            },
            .pop_transform => _ = b.transforms.pop(),
            .push_layer => |l| {
                if (l.backdrop.len > 0) try r.backdrop(&b, l.bounds, l.radii, l.backdrop);
                try b.flush();
                const layer = try r.acquireLayer();
                try b.layer_stack.append(r.gpa, .{ .target = b.target, .opacity = l.opacity, .filters = l.filters, .bounds = b.xf().boundsOf(l.bounds), .saved_clips = b.clips.items.len });
                b.target = layer;
                b.clear_next = true;
                b.pending_bind = null;
            },
            .pop_layer => {
                try b.flush();
                const top = b.layer_stack.pop() orelse continue;
                const layer = b.target;
                b.target = top.target;
                b.pending_bind = null;
                var src = layer;
                var opacity = top.opacity;
                var matrix: ?[12]f32 = null;
                for (top.filters) |f| switch (f) {
                    .blur => |radius| {
                        const tmp = try r.acquireLayer();
                        const sigma = radius * r.scale;
                        try r.ops.append(r.gpa, .{ .blur = .{ .src = src, .dst = tmp, .sigma = sigma, .horizontal = true, .clear = true } });
                        try r.ops.append(r.gpa, .{ .blur = .{ .src = tmp, .dst = src, .sigma = sigma, .horizontal = false, .clear = true } });
                        try r.free_layers.append(r.gpa, tmp);
                    },
                    .opacity => |o| opacity *= o,
                    .drop_shadow => {},
                    else => matrix = composeMatrix(matrix, f),
                };
                _ = &src;
                // composite the layer onto its parent
                try b.setBind(r.targets.items[layer].bind);
                const full = Rect{ .w = @as(f32, @floatFromInt(r.width)) / r.scale, .h = @as(f32, @floatFromInt(r.height)) / r.scale };
                const m = matrix orelse identityMatrix();
                const saved = b.transforms.items[b.transforms.items.len - 1];
                b.transforms.items[b.transforms.items.len - 1] = Transform.identity;
                // layers are composited in device space, unclipped by the clips pushed inside
                const saved_clip_len = b.clips.items.len;
                b.clips.shrinkRetainingCapacity(@min(saved_clip_len, top.saved_clips));
                try b.emit(.{
                    .bounds = rectArr(if (top.filters.len > 0) full else top.bounds.outset(2).intersect(full)),
                    .rect = rectArr(full),
                    .color = .{ m[0], m[1], m[2], m[3] },
                    .c1 = .{ m[4], m[5], m[6], m[7] },
                    .c2 = .{ m[8], m[9], m[10], m[11] },
                    .params = .{ opacity, if (matrix != null) 1 else 0, 0, 0 },
                    .uv = .{ 0, 0, 1, 1 },
                    .xf1 = .{ 0, 0, kindBits(.layer), 0 },
                });
                b.transforms.items[b.transforms.items.len - 1] = saved;
                try b.setBind(null);
                try r.free_layers.append(r.gpa, layer);
            },
        };
        try b.flush();
    }

    fn backdrop(r: *Renderer, b: *Builder, bounds: Rect, radii: Corners, filters: []const style_mod.Filter) !void {
        try b.flush();
        const copy = try r.acquireLayer();
        try r.ops.append(r.gpa, .{ .copy = .{ .src = b.target, .dst = copy } });
        var matrix: ?[12]f32 = null;
        for (filters) |f| switch (f) {
            .blur => |radius| {
                const tmp = try r.acquireLayer();
                const sigma = radius * r.scale;
                try r.ops.append(r.gpa, .{ .blur = .{ .src = copy, .dst = tmp, .sigma = sigma, .horizontal = true, .clear = true } });
                try r.ops.append(r.gpa, .{ .blur = .{ .src = tmp, .dst = copy, .sigma = sigma, .horizontal = false, .clear = true } });
                try r.free_layers.append(r.gpa, tmp);
            },
            .opacity, .drop_shadow => {},
            else => matrix = composeMatrix(matrix, f),
        };
        b.pending_first = @intCast(r.prims.items.len);
        try b.setBind(r.targets.items[copy].bind);
        const full = Rect{ .w = @as(f32, @floatFromInt(r.width)) / r.scale, .h = @as(f32, @floatFromInt(r.height)) / r.scale };
        const m = matrix orelse identityMatrix();
        // draw the filtered backdrop clipped to the element's rounded box: the
        // layer kind samples in device space; the rounded box is the shape
        try b.emit(.{
            .bounds = rectArr(bounds.outset(1 / r.scale)),
            .rect = rectArr(full),
            .radii = .{ 0, 0, 0, 0 },
            .color = .{ m[0], m[1], m[2], m[3] },
            .c1 = .{ m[4], m[5], m[6], m[7] },
            .c2 = .{ m[8], m[9], m[10], m[11] },
            .c3 = rectArr(bounds),
            .params = .{ 1, if (matrix != null) 1 else 0, 1, 0 },
            .clip_radii = radiiArr(radii),
            .uv = .{ 0, 0, 1, 1 },
            .xf1 = .{ 0, 0, kindBits(.layer), 0 },
        });
        try b.setBind(null);
        try r.free_layers.append(r.gpa, copy);
    }

    // ------------------------------------------------------------------
    // Submission
    // ------------------------------------------------------------------

    /// Render a display list into the internal target. Call `present` (or
    /// `readPixels`) afterwards.
    pub fn render(r: *Renderer, dl: *const paint.DisplayList, w: u32, h: u32, scale: f32) !void {
        r.scale = scale;
        try r.ensureTargets(w, h);
        // layer textures freed last frame are reusable again
        r.free_layers.clearRetainingCapacity();
        var ti: u32 = 1;
        while (ti < r.targets.items.len) : (ti += 1) try r.free_layers.append(r.gpa, ti);
        std.mem.reverse(u32, r.free_layers.items);
        try r.buildFrame(dl);
        const api = r.api;
        const q = r.ctx.queue;
        const u = Uniforms{ .viewport = .{ @floatFromInt(w), @floatFromInt(h), scale, 0 } };
        api.queueWriteBuffer(q, r.uniforms, 0, &u, @sizeOf(Uniforms));
        if (r.lut_rows > 0) api.queueWriteTexture(q, &.{ .texture = r.lut }, r.lut_data.items.ptr, r.lut_data.items.len, &.{ .bytes_per_row = 256 * 4, .rows_per_image = r.lut_rows }, &.{ .width = 256, .height = r.lut_rows });
        // prims buffer
        const need = @max(1, r.prims.items.len) * @sizeOf(Prim);
        if (r.prims_buf == null or r.prims_cap < need) {
            if (r.prims_buf) |pb| {
                api.bufferDestroy(pb);
                api.bufferRelease(pb);
            }
            const cap = std.math.ceilPowerOfTwo(usize, need) catch need;
            r.prims_buf = api.deviceCreateBuffer(r.ctx.device, &.{ .usage = wgpu.buffer_usage_storage | wgpu.buffer_usage_copy_dst, .size = cap }) orelse return error.Buffer;
            r.prims_cap = cap;
            if (r.bind0) |bg| api.bindGroupRelease(bg);
            r.bind0 = null;
        }
        if (r.bind0 == null) {
            const entries = [_]wgpu.BindGroupEntry{
                .{ .binding = 0, .buffer = r.uniforms, .size = @sizeOf(Uniforms) },
                .{ .binding = 1, .buffer = r.prims_buf.? },
                .{ .binding = 2, .texture_view = r.atlas.view },
                .{ .binding = 3, .texture_view = r.color_atlas.view },
                .{ .binding = 4, .texture_view = r.lut_view },
                .{ .binding = 5, .sampler = r.sampler },
            };
            r.bind0 = api.deviceCreateBindGroup(r.ctx.device, &.{ .layout = r.bgl0, .entry_count = entries.len, .entries = &entries }) orelse return error.BindGroup;
        }
        if (r.prims.items.len > 0) api.queueWriteBuffer(q, r.prims_buf.?, 0, r.prims.items.ptr, r.prims.items.len * @sizeOf(Prim));

        // blur parameter slots (256-byte aligned dynamic offsets)
        var blur_slots: std.ArrayList(u8) = .empty;
        defer blur_slots.deinit(r.gpa);
        for (r.ops.items) |op| if (op == .blur) {
            var slot: [256]u8 = @splat(0);
            const params = [4]f32{ op.blur.sigma, if (op.blur.horizontal) 1 else 0, @floatFromInt(w), @floatFromInt(h) };
            @memcpy(slot[0..16], std.mem.asBytes(&params));
            try blur_slots.appendSlice(r.gpa, &slot);
        };
        if (blur_slots.items.len > 0) api.queueWriteBuffer(q, r.blur_uniforms, 0, blur_slots.items.ptr, @min(blur_slots.items.len, 256 * 64));

        const enc = api.deviceCreateCommandEncoder(r.ctx.device, null) orelse return error.Encoder;
        defer api.commandEncoderRelease(enc);
        var blur_index: u32 = 0;
        var cleared = std.ArrayList(bool).empty;
        defer cleared.deinit(r.gpa);
        try cleared.appendNTimes(r.gpa, false, r.targets.items.len);
        for (r.ops.items) |op| switch (op) {
            .draw => |d| {
                const t = r.targets.items[d.target];
                const att = [_]wgpu.RenderPassColorAttachment{.{ .view = t.view, .load_op = if (d.clear) wgpu.load_op_clear else wgpu.load_op_load, .clear_value = .{} }};
                const pass = api.commandEncoderBeginRenderPass(enc, &.{ .color_attachment_count = 1, .color_attachments = &att }) orelse return error.Pass;
                if (d.count > 0) {
                    api.renderPassSetPipeline(pass, r.pipeline);
                    api.renderPassSetBindGroup(pass, 0, r.bind0, 0, null);
                    api.renderPassSetBindGroup(pass, 1, d.bind orelse r.dummy.bind, 0, null);
                    api.renderPassDraw(pass, 4, d.count, 0, d.first);
                }
                api.renderPassEnd(pass);
                api.renderPassRelease(pass);
            },
            .blur => |bl| {
                if (blur_index >= 64) continue;
                const src = r.targets.items[bl.src];
                const dst = r.targets.items[bl.dst];
                const entries = [_]wgpu.BindGroupEntry{
                    .{ .binding = 0, .buffer = r.blur_uniforms, .size = 16 },
                    .{ .binding = 1, .texture_view = src.view },
                    .{ .binding = 2, .sampler = r.sampler },
                };
                const bg = api.deviceCreateBindGroup(r.ctx.device, &.{ .layout = r.blur_bgl, .entry_count = entries.len, .entries = &entries }) orelse return error.BindGroup;
                defer api.bindGroupRelease(bg);
                const att = [_]wgpu.RenderPassColorAttachment{.{ .view = dst.view, .load_op = wgpu.load_op_clear }};
                const pass = api.commandEncoderBeginRenderPass(enc, &.{ .color_attachment_count = 1, .color_attachments = &att }) orelse return error.Pass;
                api.renderPassSetPipeline(pass, r.blur_pipeline);
                const off = [_]u32{blur_index * 256};
                api.renderPassSetBindGroup(pass, 0, bg, 1, &off);
                api.renderPassDraw(pass, 3, 1, 0, 0);
                api.renderPassEnd(pass);
                api.renderPassRelease(pass);
                blur_index += 1;
            },
            .copy => |c| {
                const src = r.targets.items[c.src];
                const dst = r.targets.items[c.dst];
                api.commandEncoderCopyTextureToTexture(enc, &.{ .texture = src.tex }, &.{ .texture = dst.tex }, &.{ .width = w, .height = h });
            },
        };
        const cmd = api.commandEncoderFinish(enc, null) orelse return error.Encoder;
        defer api.commandBufferRelease(cmd);
        const cmds = [_]wgpu.CommandBuffer{cmd};
        api.queueSubmit(q, 1, &cmds);
        r.frame_count += 1;
    }

    /// Blit the rendered frame to a surface texture view.
    pub fn present(r: *Renderer, view: wgpu.TextureView) !void {
        const api = r.api;
        const t = r.targets.items[0];
        const entries = [_]wgpu.BindGroupEntry{
            .{ .binding = 0, .buffer = r.blur_uniforms, .size = 16 },
            .{ .binding = 1, .texture_view = t.view },
            .{ .binding = 2, .sampler = r.nearest },
        };
        const bg = api.deviceCreateBindGroup(r.ctx.device, &.{ .layout = r.blur_bgl, .entry_count = entries.len, .entries = &entries }) orelse return error.BindGroup;
        defer api.bindGroupRelease(bg);
        const enc = api.deviceCreateCommandEncoder(r.ctx.device, null) orelse return error.Encoder;
        defer api.commandEncoderRelease(enc);
        const att = [_]wgpu.RenderPassColorAttachment{.{ .view = view, .load_op = wgpu.load_op_clear }};
        const pass = api.commandEncoderBeginRenderPass(enc, &.{ .color_attachment_count = 1, .color_attachments = &att }) orelse return error.Pass;
        api.renderPassSetPipeline(pass, r.blit_pipeline);
        const off = [_]u32{0};
        api.renderPassSetBindGroup(pass, 0, bg, 1, &off);
        api.renderPassDraw(pass, 3, 1, 0, 0);
        api.renderPassEnd(pass);
        api.renderPassRelease(pass);
        const cmd = api.commandEncoderFinish(enc, null) orelse return error.Encoder;
        defer api.commandBufferRelease(cmd);
        const cmds = [_]wgpu.CommandBuffer{cmd};
        api.queueSubmit(r.ctx.queue, 1, &cmds);
    }

    /// Read the main target back as premultiplied RGBA (tests, screenshots).
    pub fn readPixels(r: *Renderer, gpa: Allocator) ![]u8 {
        const api = r.api;
        const w = r.width;
        const h = r.height;
        const row = std.mem.alignForward(u32, w * 4, 256);
        const size: u64 = @as(u64, row) * h;
        const buf = api.deviceCreateBuffer(r.ctx.device, &.{ .usage = wgpu.buffer_usage_map_read | wgpu.buffer_usage_copy_dst, .size = size }) orelse return error.Buffer;
        defer {
            api.bufferDestroy(buf);
            api.bufferRelease(buf);
        }
        const enc = api.deviceCreateCommandEncoder(r.ctx.device, null) orelse return error.Encoder;
        defer api.commandEncoderRelease(enc);
        api.commandEncoderCopyTextureToBuffer(enc, &.{ .texture = r.targets.items[0].tex }, &.{ .layout = .{ .bytes_per_row = row, .rows_per_image = h }, .buffer = buf }, &.{ .width = w, .height = h });
        const cmd = api.commandEncoderFinish(enc, null) orelse return error.Encoder;
        defer api.commandBufferRelease(cmd);
        const cmds = [_]wgpu.CommandBuffer{cmd};
        api.queueSubmit(r.ctx.queue, 1, &cmds);
        var done = false;
        const cb = struct {
            fn f(status: u32, message: wgpu.StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void {
                _ = status;
                _ = message;
                _ = ud2;
                const d: *bool = @ptrCast(@alignCast(ud1.?));
                d.* = true;
            }
        }.f;
        _ = api.bufferMapAsync(buf, wgpu.map_mode_read, 0, @intCast(size), .{ .callback = cb, .userdata1 = &done });
        var spins: usize = 0;
        while (!done and spins < 1_000_000) : (spins += 1) api.instanceProcessEvents(r.ctx.instance);
        if (!done) return error.MapTimeout;
        const ptr = api.bufferGetConstMappedRange(buf, 0, @intCast(size)) orelse return error.Map;
        const src: [*]const u8 = @ptrCast(ptr);
        const out = try gpa.alloc(u8, @as(usize, w) * h * 4);
        for (0..h) |y| {
            for (0..w) |x| {
                const s = src[y * row + x * 4 ..][0..4];
                const d = out[(y * w + x) * 4 ..][0..4];
                // BGRA -> RGBA
                d[0] = s[2];
                d[1] = s[1];
                d[2] = s[0];
                d[3] = s[3];
            }
        }
        api.bufferUnmap(buf);
        return out;
    }
};

fn growRadii(r: Corners, d: f32) Corners {
    return .{ .tl = if (r.tl > 0) r.tl + d else 0, .tr = if (r.tr > 0) r.tr + d else 0, .br = if (r.br > 0) r.br + d else 0, .bl = if (r.bl > 0) r.bl + d else 0 };
}

fn identityMatrix() [12]f32 {
    return .{ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0 };
}

/// Compose an affine color filter (3x4 row-major: rgb rows with offset) after `prev`.
fn composeMatrix(prev: ?[12]f32, f: style_mod.Filter) [12]f32 {
    var m: [12]f32 = identityMatrix();
    switch (f) {
        .grayscale => |a| {
            const l = [3]f32{ 0.2126, 0.7152, 0.0722 };
            for (0..3) |row| for (0..3) |col| {
                const id: f32 = if (row == col) 1 else 0;
                m[row * 4 + col] = id + (l[col] - id) * a;
            };
        },
        .sepia => |a| {
            const s = [9]f32{ 0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131 };
            for (0..3) |row| for (0..3) |col| {
                const id: f32 = if (row == col) 1 else 0;
                m[row * 4 + col] = id + (s[row * 3 + col] - id) * a;
            };
        },
        .saturate => |a| {
            const l = [3]f32{ 0.2126, 0.7152, 0.0722 };
            for (0..3) |row| for (0..3) |col| {
                const id: f32 = if (row == col) 1 else 0;
                m[row * 4 + col] = l[col] + (id - l[col]) * a;
            };
        },
        .brightness => |a| {
            m[0] = a;
            m[5] = a;
            m[10] = a;
        },
        .contrast => |a| {
            m[0] = a;
            m[5] = a;
            m[10] = a;
            m[3] = 0.5 * (1 - a);
            m[7] = 0.5 * (1 - a);
            m[11] = 0.5 * (1 - a);
        },
        .invert => |a| {
            m[0] = 1 - 2 * a;
            m[5] = 1 - 2 * a;
            m[10] = 1 - 2 * a;
            m[3] = a;
            m[7] = a;
            m[11] = a;
        },
        .hue_rotate => |ang| {
            const c = @cos(ang);
            const s = @sin(ang);
            const h = [9]f32{
                0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
                0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
                0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
            };
            for (0..3) |row| for (0..3) |col| {
                m[row * 4 + col] = h[row * 3 + col];
            };
        },
        else => {},
    }
    const p = prev orelse return m;
    // result = m * p (apply p first)
    var out: [12]f32 = undefined;
    for (0..3) |row| {
        for (0..3) |col| {
            out[row * 4 + col] = m[row * 4 + 0] * p[0 * 4 + col] + m[row * 4 + 1] * p[1 * 4 + col] + m[row * 4 + 2] * p[2 * 4 + col];
        }
        out[row * 4 + 3] = m[row * 4 + 0] * p[3] + m[row * 4 + 1] * p[7] + m[row * 4 + 2] * p[11] + m[row * 4 + 3];
    }
    return out;
}
