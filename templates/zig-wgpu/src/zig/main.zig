const std = @import("std");
const electrobun = @import("electrobun");

const default_secret_key = "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32";

const GpuConfig = struct {
    view_id: u32 = 0,
    host_webview_id: u32 = 0,
    width: u32 = 640,
    height: u32 = 420,
    mode: u32 = 0,
    motion: u32 = 4,
    running: bool = false,
    mutex: std.Thread.Mutex = .{},
};

const AppState = struct {
    allocator: std.mem.Allocator,
    core: *electrobun.Core,
    bundle_paths: *const electrobun.BundlePaths,
    webview_id: u32 = 0,
    gpu: GpuConfig = .{},
    mutex: std.Thread.Mutex = .{},
};

const surface_format = 0x0000001c;
const vertex_count = 3;
const floats_per_vertex = 9;
const vertex_stride = floats_per_vertex * @sizeOf(f32);
const vertex_buffer_size = vertex_count * vertex_stride;

const GpuPipeline = struct {
    pipeline: ?*anyopaque,
    vertex_buffer: ?*anyopaque,
};

const mandelbrot_shader: [:0]const u8 =
    \\struct VSOut {
    \\  @builtin(position) position : vec4<f32>,
    \\  @location(0) uv : vec2<f32>,
    \\  @location(1) time : f32,
    \\  @location(2) resolution : vec2<f32>,
    \\  @location(3) params : vec4<f32>,
    \\};
    \\
    \\fn rotate(p: vec2<f32>, a: f32) -> vec2<f32> {
    \\  let c = cos(a);
    \\  let s = sin(a);
    \\  return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
    \\}
    \\
    \\fn palette(t: f32) -> vec3<f32> {
    \\  let a = vec3<f32>(0.52, 0.42, 0.36);
    \\  let b = vec3<f32>(0.44, 0.35, 0.54);
    \\  let c = vec3<f32>(1.00, 0.78, 0.52);
    \\  let d = vec3<f32>(0.12, 0.36, 0.68);
    \\  return a + b * cos(6.28318 * (c * t + d));
    \\}
    \\
    \\@vertex
    \\fn vs_main(
    \\  @location(0) position: vec2<f32>,
    \\  @location(1) time: f32,
    \\  @location(2) resolution: vec2<f32>,
    \\  @location(3) params: vec4<f32>
    \\) -> VSOut {
    \\  var out: VSOut;
    \\  out.position = vec4<f32>(position, 0.0, 1.0);
    \\  out.uv = position;
    \\  out.time = time;
    \\  out.resolution = resolution;
    \\  out.params = params;
    \\  return out;
    \\}
    \\
    \\@fragment
    \\fn fs_main(
    \\  @location(0) uv: vec2<f32>,
    \\  @location(1) time: f32,
    \\  @location(2) resolution: vec2<f32>,
    \\  @location(3) params: vec4<f32>
    \\) -> @location(0) vec4<f32> {
    \\  let fragCoord = (uv * 0.5 + vec2<f32>(0.5)) * resolution;
    \\  var p = (fragCoord * 2.0 - resolution) / min(resolution.x, resolution.y);
    \\  let motion = max(params.y, 1.0);
    \\  let pulse = 0.5 + 0.5 * sin(time * (0.18 + motion * 0.03));
    \\  let zoom = pow(2.0, 1.5 + pulse * (5.5 + motion * 0.55));
    \\  let angle = 0.12 * sin(time * 0.21);
    \\  p = rotate(p, angle);
    \\
    \\  var z = vec2<f32>(0.0);
    \\  var c = vec2<f32>(0.0);
    \\  if (params.x < 0.5) {
    \\    let center = vec2<f32>(-0.7436439, 0.1318259) +
    \\      vec2<f32>(0.0014 * sin(time * 0.11), 0.0011 * cos(time * 0.13));
    \\    c = center + p / zoom;
    \\  } else {
    \\    z = p * 1.38;
    \\    c = vec2<f32>(
    \\      -0.78 + 0.16 * sin(time * 0.31),
    \\      0.17 + 0.12 * cos(time * 0.27)
    \\    );
    \\  }
    \\
    \\  var escaped = false;
    \\  var iter = 0.0;
    \\  for (var i = 0; i < 144; i = i + 1) {
    \\    let x = z.x * z.x - z.y * z.y + c.x;
    \\    let y = 2.0 * z.x * z.y + c.y;
    \\    z = vec2<f32>(x, y);
    \\    if (dot(z, z) > 256.0) {
    \\      let smooth_iter = f32(i) + 1.0 - log2(max(log2(dot(z, z)) * 0.5, 0.0001));
    \\      iter = smooth_iter;
    \\      escaped = true;
    \\      break;
    \\    }
    \\  }
    \\
    \\  if (!escaped) {
    \\    return vec4<f32>(0.01, 0.012, 0.018, 1.0);
    \\  }
    \\
    \\  let t = iter / 144.0;
    \\  let edge = pow(clamp(t, 0.0, 1.0), 0.42);
    \\  let color = palette(edge + time * 0.035) * (0.45 + 0.95 * edge);
    \\  let glow = 0.16 / max(length(z), 0.35);
    \\  return vec4<f32>(color + vec3<f32>(glow * 0.15, glow * 0.24, glow * 0.36), 1.0);
    \\}
;

const WgpuApi = struct {
    device_create_shader_module: DeviceCreateShaderModuleFn,
    device_create_render_pipeline: DeviceCreateRenderPipelineFn,
    device_create_buffer: DeviceCreateBufferFn,
    device_create_command_encoder: DeviceCreateCommandEncoderFn,
    texture_create_view: TextureCreateViewFn,
    command_encoder_begin_render_pass: CommandEncoderBeginRenderPassFn,
    render_pass_encoder_set_pipeline: RenderPassEncoderSetPipelineFn,
    render_pass_encoder_set_vertex_buffer: RenderPassEncoderSetVertexBufferFn,
    render_pass_encoder_draw: RenderPassEncoderDrawFn,
    render_pass_encoder_end: RenderPassEncoderEndFn,
    command_encoder_finish: CommandEncoderFinishFn,
    queue_write_buffer: QueueWriteBufferFn,
    queue_submit: QueueSubmitFn,
    instance_process_events: InstanceProcessEventsFn,
    texture_release: ReleaseFn,
    texture_view_release: ReleaseFn,
    command_buffer_release: ReleaseFn,
    command_encoder_release: ReleaseFn,

    const DeviceCreateShaderModuleFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const DeviceCreateRenderPipelineFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const DeviceCreateBufferFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const DeviceCreateCommandEncoderFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const TextureCreateViewFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const CommandEncoderBeginRenderPassFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const RenderPassEncoderSetPipelineFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) void;
    const RenderPassEncoderSetVertexBufferFn = *const fn (?*anyopaque, u32, ?*anyopaque, u64, u64) callconv(.C) void;
    const RenderPassEncoderDrawFn = *const fn (?*anyopaque, u32, u32, u32, u32) callconv(.C) void;
    const RenderPassEncoderEndFn = *const fn (?*anyopaque) callconv(.C) void;
    const CommandEncoderFinishFn = *const fn (?*anyopaque, ?*anyopaque) callconv(.C) ?*anyopaque;
    const QueueWriteBufferFn = *const fn (?*anyopaque, ?*anyopaque, u64, ?*anyopaque, u64) callconv(.C) void;
    const QueueSubmitFn = *const fn (?*anyopaque, u64, ?*anyopaque) callconv(.C) void;
    const InstanceProcessEventsFn = *const fn (?*anyopaque) callconv(.C) void;
    const ReleaseFn = *const fn (?*anyopaque) callconv(.C) void;

    fn load(lib: *std.DynLib) !WgpuApi {
        return .{
            .device_create_shader_module = lib.lookup(DeviceCreateShaderModuleFn, "wgpuDeviceCreateShaderModule") orelse return error.MissingWgpuSymbol,
            .device_create_render_pipeline = lib.lookup(DeviceCreateRenderPipelineFn, "wgpuDeviceCreateRenderPipeline") orelse return error.MissingWgpuSymbol,
            .device_create_buffer = lib.lookup(DeviceCreateBufferFn, "wgpuDeviceCreateBuffer") orelse return error.MissingWgpuSymbol,
            .device_create_command_encoder = lib.lookup(DeviceCreateCommandEncoderFn, "wgpuDeviceCreateCommandEncoder") orelse return error.MissingWgpuSymbol,
            .texture_create_view = lib.lookup(TextureCreateViewFn, "wgpuTextureCreateView") orelse return error.MissingWgpuSymbol,
            .command_encoder_begin_render_pass = lib.lookup(CommandEncoderBeginRenderPassFn, "wgpuCommandEncoderBeginRenderPass") orelse return error.MissingWgpuSymbol,
            .render_pass_encoder_set_pipeline = lib.lookup(RenderPassEncoderSetPipelineFn, "wgpuRenderPassEncoderSetPipeline") orelse return error.MissingWgpuSymbol,
            .render_pass_encoder_set_vertex_buffer = lib.lookup(RenderPassEncoderSetVertexBufferFn, "wgpuRenderPassEncoderSetVertexBuffer") orelse return error.MissingWgpuSymbol,
            .render_pass_encoder_draw = lib.lookup(RenderPassEncoderDrawFn, "wgpuRenderPassEncoderDraw") orelse return error.MissingWgpuSymbol,
            .render_pass_encoder_end = lib.lookup(RenderPassEncoderEndFn, "wgpuRenderPassEncoderEnd") orelse return error.MissingWgpuSymbol,
            .command_encoder_finish = lib.lookup(CommandEncoderFinishFn, "wgpuCommandEncoderFinish") orelse return error.MissingWgpuSymbol,
            .queue_write_buffer = lib.lookup(QueueWriteBufferFn, "wgpuQueueWriteBuffer") orelse return error.MissingWgpuSymbol,
            .queue_submit = lib.lookup(QueueSubmitFn, "wgpuQueueSubmit") orelse return error.MissingWgpuSymbol,
            .instance_process_events = lib.lookup(InstanceProcessEventsFn, "wgpuInstanceProcessEvents") orelse return error.MissingWgpuSymbol,
            .texture_release = lib.lookup(ReleaseFn, "wgpuTextureRelease") orelse return error.MissingWgpuSymbol,
            .texture_view_release = lib.lookup(ReleaseFn, "wgpuTextureViewRelease") orelse return error.MissingWgpuSymbol,
            .command_buffer_release = lib.lookup(ReleaseFn, "wgpuCommandBufferRelease") orelse return error.MissingWgpuSymbol,
            .command_encoder_release = lib.lookup(ReleaseFn, "wgpuCommandEncoderRelease") orelse return error.MissingWgpuSymbol,
        };
    }
};

var g_state: ?*AppState = null;
var host_queue_running = std.atomic.Value(bool).init(false);
var gpu_thread_started = std.atomic.Value(bool).init(false);

fn appState() *AppState {
    return g_state orelse @panic("zig-wgpu state not initialized");
}

fn ptrInt(value: ?*anyopaque) u64 {
    return if (value) |ptr| @intCast(@intFromPtr(ptr)) else 0;
}

fn ptrFromBytes(bytes: []u8) ?*anyopaque {
    return @ptrCast(bytes.ptr);
}

fn ptrFromConstBytes(bytes: []const u8) ?*anyopaque {
    return @ptrCast(@constCast(bytes.ptr));
}

fn writeU32(bytes: []u8, offset: usize, value: u32) void {
    std.mem.writeInt(u32, bytes[offset..][0..4], value, .little);
}

fn writeU64(bytes: []u8, offset: usize, value: u64) void {
    std.mem.writeInt(u64, bytes[offset..][0..8], value, .little);
}

fn writePtr(bytes: []u8, offset: usize, value: ?*anyopaque) void {
    writeU64(bytes, offset, ptrInt(value));
}

fn writeF64(bytes: []u8, offset: usize, value: f64) void {
    writeU64(bytes, offset, @as(u64, @bitCast(value)));
}

fn copyBytes(dest: []u8, offset: usize, src: []const u8) void {
    @memcpy(dest[offset..][0..src.len], src);
}

fn jsonField(object: *const std.json.ObjectMap, name: []const u8) ?std.json.Value {
    return object.get(name);
}

fn jsonString(object: *const std.json.ObjectMap, name: []const u8) ?[]const u8 {
    const value = jsonField(object, name) orelse return null;
    return switch (value) {
        .string => |string| string,
        .number_string => |string| string,
        else => null,
    };
}

fn jsonU32(object: *const std.json.ObjectMap, name: []const u8, fallback: u32) u32 {
    const value = jsonField(object, name) orelse return fallback;
    const parsed: ?u64 = switch (value) {
        .integer => |integer| if (integer < 0) null else @intCast(integer),
        .float => |float| if (float < 0) null else @intFromFloat(float),
        .number_string => |string| std.fmt.parseUnsigned(u64, string, 10) catch null,
        else => null,
    };
    const number = parsed orelse return fallback;
    return @intCast(@min(number, std.math.maxInt(u32)));
}

fn rectDimension(params_object: *const std.json.ObjectMap, name: []const u8, fallback: u32) u32 {
    const rect_value = jsonField(params_object, "rect") orelse return fallback;
    if (rect_value != .object) return fallback;
    return @min(@max(jsonU32(&rect_value.object, name, fallback), 1), 4096);
}

fn sendRpcResponseSuccess(webview_id: u32, request_id: u64, payload: anytype) void {
    appState().core.sendHostMessageToWebview(webview_id, .{
        .type = "response",
        .id = request_id,
        .success = true,
        .payload = payload,
    }) catch |err| {
        std.debug.print("[zig-wgpu] failed to send response: {s}\n", .{@errorName(err)});
    };
}

fn sendRpcResponseError(webview_id: u32, request_id: u64, message: []const u8) void {
    appState().core.sendHostMessageToWebview(webview_id, .{
        .type = "response",
        .id = request_id,
        .success = false,
        .@"error" = message,
    }) catch |err| {
        std.debug.print("[zig-wgpu] failed to send error response: {s}\n", .{@errorName(err)});
    };
}

fn sendGpuFrame(webview_id: u32, view_id: u32, frame: u64, width: u32, height: u32) void {
    appState().core.sendHostMessageToWebview(webview_id, .{
        .type = "message",
        .id = "gpuFrame",
        .payload = .{
            .id = view_id,
            .frame = frame,
            .width = width,
            .height = height,
        },
    }) catch {};
}

fn configureGpuFromParams(state: *AppState, webview_id: u32, params_value: ?std.json.Value) !void {
    const params = params_value orelse return error.InvalidParams;
    if (params != .object) return error.InvalidParams;

    const view_id = jsonU32(&params.object, "id", 0);
    if (view_id == 0) return error.InvalidWgpuView;

    state.gpu.mutex.lock();
    defer state.gpu.mutex.unlock();
    state.gpu.view_id = view_id;
    state.gpu.host_webview_id = webview_id;
    state.gpu.width = rectDimension(&params.object, "width", state.gpu.width);
    state.gpu.height = rectDimension(&params.object, "height", state.gpu.height);
    state.gpu.mode = @min(jsonU32(&params.object, "mode", state.gpu.mode), 1);
    state.gpu.motion = @min(@max(jsonU32(&params.object, "motion", state.gpu.motion), 1), 8);
}

fn configureSurface(core: *electrobun.Core, context: electrobun.WgpuContext, width: u32, height: u32) !void {
    const WGPUTextureUsage_RenderAttachment = 0x0000000000000010;
    const WGPUCompositeAlphaMode_Opaque = 0x00000001;
    const WGPUPresentMode_Fifo = 0x00000001;

    var config = [_]u8{0} ** 64;
    writePtr(config[0..], 0, null);
    writePtr(config[0..], 8, context.device_ptr);
    writeU32(config[0..], 16, surface_format);
    writeU32(config[0..], 20, 0);
    writeU64(config[0..], 24, WGPUTextureUsage_RenderAttachment);
    writeU32(config[0..], 32, width);
    writeU32(config[0..], 36, height);
    writeU64(config[0..], 40, 0);
    writePtr(config[0..], 48, null);
    writeU32(config[0..], 56, WGPUCompositeAlphaMode_Opaque);
    writeU32(config[0..], 60, WGPUPresentMode_Fifo);
    try core.wgpuSurfaceConfigureMainThread(context.surface_ptr, ptrFromBytes(config[0..]));
}

fn makeShaderSourceWGSL(code: [:0]const u8) [32]u8 {
    const WGPUSType_ShaderSourceWGSL = 0x00000002;
    const WGPU_STRLEN = std.math.maxInt(u64);

    var bytes = [_]u8{0} ** 32;
    writePtr(bytes[0..], 0, null);
    writeU32(bytes[0..], 8, WGPUSType_ShaderSourceWGSL);
    writePtr(bytes[0..], 16, ptrFromConstBytes(code));
    writeU64(bytes[0..], 24, WGPU_STRLEN);
    return bytes;
}

fn makeShaderModuleDescriptor(source_ptr: ?*anyopaque) [24]u8 {
    var bytes = [_]u8{0} ** 24;
    writePtr(bytes[0..], 0, source_ptr);
    writePtr(bytes[0..], 8, null);
    writeU64(bytes[0..], 16, 0);
    return bytes;
}

fn writeVertexAttribute(bytes: []u8, index: usize, offset: u64, shader_location: u32, format: u32) void {
    const base = index * 32;
    writePtr(bytes, base, null);
    writeU32(bytes, base + 8, format);
    writeU64(bytes, base + 16, offset);
    writeU32(bytes, base + 24, shader_location);
}

fn makeVertexBufferLayout(attributes_ptr: ?*anyopaque, attribute_count: u64) [40]u8 {
    const WGPUVertexStepMode_Vertex = 0x00000001;

    var bytes = [_]u8{0} ** 40;
    writePtr(bytes[0..], 0, null);
    writeU32(bytes[0..], 8, WGPUVertexStepMode_Vertex);
    writeU64(bytes[0..], 16, vertex_stride);
    writeU64(bytes[0..], 24, attribute_count);
    writePtr(bytes[0..], 32, attributes_ptr);
    return bytes;
}

fn makeColorTargetState(format: u32) [32]u8 {
    const WGPUColorWriteMask_All = 0x000000000000000f;

    var bytes = [_]u8{0} ** 32;
    writePtr(bytes[0..], 0, null);
    writeU32(bytes[0..], 8, format);
    writePtr(bytes[0..], 16, null);
    writeU64(bytes[0..], 24, WGPUColorWriteMask_All);
    return bytes;
}

fn makeVertexState(module: ?*anyopaque, entry: [:0]const u8, vertex_layout_ptr: ?*anyopaque) [64]u8 {
    const WGPU_STRLEN = std.math.maxInt(u64);

    var bytes = [_]u8{0} ** 64;
    writePtr(bytes[0..], 0, null);
    writePtr(bytes[0..], 8, module);
    writePtr(bytes[0..], 16, ptrFromConstBytes(entry));
    writeU64(bytes[0..], 24, WGPU_STRLEN);
    writeU64(bytes[0..], 32, 0);
    writePtr(bytes[0..], 40, null);
    writeU64(bytes[0..], 48, 1);
    writePtr(bytes[0..], 56, vertex_layout_ptr);
    return bytes;
}

fn makeFragmentState(module: ?*anyopaque, entry: [:0]const u8, color_target_ptr: ?*anyopaque) [64]u8 {
    const WGPU_STRLEN = std.math.maxInt(u64);

    var bytes = [_]u8{0} ** 64;
    writePtr(bytes[0..], 0, null);
    writePtr(bytes[0..], 8, module);
    writePtr(bytes[0..], 16, ptrFromConstBytes(entry));
    writeU64(bytes[0..], 24, WGPU_STRLEN);
    writeU64(bytes[0..], 32, 0);
    writePtr(bytes[0..], 40, null);
    writeU64(bytes[0..], 48, 1);
    writePtr(bytes[0..], 56, color_target_ptr);
    return bytes;
}

fn makePrimitiveState() [32]u8 {
    const WGPUPrimitiveTopology_TriangleList = 0x00000004;
    const WGPUFrontFace_CCW = 0x00000001;
    const WGPUCullMode_None = 0x00000001;

    var bytes = [_]u8{0} ** 32;
    writePtr(bytes[0..], 0, null);
    writeU32(bytes[0..], 8, WGPUPrimitiveTopology_TriangleList);
    writeU32(bytes[0..], 16, WGPUFrontFace_CCW);
    writeU32(bytes[0..], 20, WGPUCullMode_None);
    return bytes;
}

fn makeMultisampleState() [24]u8 {
    var bytes = [_]u8{0} ** 24;
    writePtr(bytes[0..], 0, null);
    writeU32(bytes[0..], 8, 1);
    writeU32(bytes[0..], 12, 0xffffffff);
    return bytes;
}

fn makeRenderPipelineDescriptor(vertex_state: *const [64]u8, primitive_state: *const [32]u8, multisample_state: *const [24]u8, fragment_state_ptr: ?*anyopaque) [168]u8 {
    var bytes = [_]u8{0} ** 168;
    writePtr(bytes[0..], 0, null);
    writePtr(bytes[0..], 8, null);
    writeU64(bytes[0..], 16, 0);
    writePtr(bytes[0..], 24, null);
    copyBytes(bytes[0..], 32, vertex_state[0..]);
    copyBytes(bytes[0..], 96, primitive_state[0..]);
    writePtr(bytes[0..], 128, null);
    copyBytes(bytes[0..], 136, multisample_state[0..]);
    writePtr(bytes[0..], 160, fragment_state_ptr);
    return bytes;
}

fn makeBufferDescriptor(size: u64) [48]u8 {
    const WGPUBufferUsage_Vertex = 0x0000000000000020;
    const WGPUBufferUsage_CopyDst = 0x0000000000000008;

    var bytes = [_]u8{0} ** 48;
    writePtr(bytes[0..], 0, null);
    writePtr(bytes[0..], 8, null);
    writeU64(bytes[0..], 16, 0);
    writeU64(bytes[0..], 24, WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst);
    writeU64(bytes[0..], 32, size);
    return bytes;
}

fn createMandelbrotPipeline(api: WgpuApi, context: electrobun.WgpuContext) !GpuPipeline {
    const WGPUVertexFormat_Float32 = 0x0000001c;
    const WGPUVertexFormat_Float32x2 = 0x0000001d;
    const WGPUVertexFormat_Float32x4 = 0x0000001f;
    const vs_entry: [:0]const u8 = "vs_main";
    const fs_entry: [:0]const u8 = "fs_main";

    var shader_source = makeShaderSourceWGSL(mandelbrot_shader);
    var shader_descriptor = makeShaderModuleDescriptor(ptrFromBytes(shader_source[0..]));
    const shader_module = api.device_create_shader_module(context.device_ptr, ptrFromBytes(shader_descriptor[0..])) orelse return error.MissingShaderModule;

    var attributes = [_]u8{0} ** (32 * 4);
    writeVertexAttribute(attributes[0..], 0, 0, 0, WGPUVertexFormat_Float32x2);
    writeVertexAttribute(attributes[0..], 1, 8, 1, WGPUVertexFormat_Float32);
    writeVertexAttribute(attributes[0..], 2, 12, 2, WGPUVertexFormat_Float32x2);
    writeVertexAttribute(attributes[0..], 3, 20, 3, WGPUVertexFormat_Float32x4);

    var vertex_layout = makeVertexBufferLayout(ptrFromBytes(attributes[0..]), 4);
    var vertex_state = makeVertexState(shader_module, vs_entry, ptrFromBytes(vertex_layout[0..]));
    var color_target = makeColorTargetState(surface_format);
    var fragment_state = makeFragmentState(shader_module, fs_entry, ptrFromBytes(color_target[0..]));
    var primitive_state = makePrimitiveState();
    var multisample_state = makeMultisampleState();
    var pipeline_descriptor = makeRenderPipelineDescriptor(&vertex_state, &primitive_state, &multisample_state, ptrFromBytes(fragment_state[0..]));

    const pipeline = api.device_create_render_pipeline(context.device_ptr, ptrFromBytes(pipeline_descriptor[0..])) orelse return error.MissingRenderPipeline;
    var vertex_buffer_descriptor = makeBufferDescriptor(vertex_buffer_size);
    const vertex_buffer = api.device_create_buffer(context.device_ptr, ptrFromBytes(vertex_buffer_descriptor[0..])) orelse return error.MissingVertexBuffer;

    return .{
        .pipeline = pipeline,
        .vertex_buffer = vertex_buffer,
    };
}

fn makeFrameVertices(frame: u64, width: u32, height: u32, mode: u32, motion: u32) [vertex_count * floats_per_vertex]f32 {
    const t = @as(f32, @floatFromInt(frame)) / 60.0;
    const width_f = @as(f32, @floatFromInt(width));
    const height_f = @as(f32, @floatFromInt(height));
    const mode_f = @as(f32, @floatFromInt(mode));
    const motion_f = @as(f32, @floatFromInt(motion));
    const positions = [_]f32{ -1.0, -1.0, 3.0, -1.0, -1.0, 3.0 };
    var vertices = [_]f32{0} ** (vertex_count * floats_per_vertex);

    var i: usize = 0;
    while (i < vertex_count) : (i += 1) {
        const base = i * floats_per_vertex;
        vertices[base] = positions[i * 2];
        vertices[base + 1] = positions[i * 2 + 1];
        vertices[base + 2] = t;
        vertices[base + 3] = width_f;
        vertices[base + 4] = height_f;
        vertices[base + 5] = mode_f;
        vertices[base + 6] = motion_f;
        vertices[base + 7] = 0.0;
        vertices[base + 8] = 0.0;
    }

    return vertices;
}

fn renderFrame(core: *electrobun.Core, api: WgpuApi, context: electrobun.WgpuContext, pipeline: GpuPipeline, queue: ?*anyopaque, frame: u64, width: u32, height: u32, mode: u32, motion: u32) !void {
    const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;
    const WGPULoadOp_Clear = 0x00000002;
    const WGPUStoreOp_Store = 0x00000001;

    api.instance_process_events(context.instance_ptr);

    var vertices = makeFrameVertices(frame, width, height, mode, motion);
    api.queue_write_buffer(queue, pipeline.vertex_buffer, 0, @ptrCast(&vertices), vertex_buffer_size);

    var surface_texture = [_]u8{0} ** 24;
    try core.wgpuSurfaceGetCurrentTextureMainThread(context.surface_ptr, ptrFromBytes(surface_texture[0..]));
    const texture_ptr: ?*anyopaque = @ptrFromInt(std.mem.readInt(u64, surface_texture[8..][0..8], .little));
    const status = std.mem.readInt(u32, surface_texture[16..][0..4], .little);
    if (status != 1 and status != 2) {
        return error.SurfaceTextureUnavailable;
    }
    if (texture_ptr == null) {
        return error.MissingSurfaceTexture;
    }
    defer api.texture_release(texture_ptr);

    const texture_view = api.texture_create_view(texture_ptr, null) orelse return error.MissingTextureView;
    defer api.texture_view_release(texture_view);

    const encoder = api.device_create_command_encoder(context.device_ptr, null) orelse return error.MissingCommandEncoder;
    defer api.command_encoder_release(encoder);

    var color_attachment = [_]u8{0} ** 72;
    writePtr(color_attachment[0..], 8, texture_view);
    writeU32(color_attachment[0..], 16, WGPU_DEPTH_SLICE_UNDEFINED);
    writePtr(color_attachment[0..], 24, null);
    writeU32(color_attachment[0..], 32, WGPULoadOp_Clear);
    writeU32(color_attachment[0..], 36, WGPUStoreOp_Store);
    writeF64(color_attachment[0..], 40, 0.005);
    writeF64(color_attachment[0..], 48, 0.007);
    writeF64(color_attachment[0..], 56, 0.012);
    writeF64(color_attachment[0..], 64, 1.0);

    var pass_descriptor = [_]u8{0} ** 64;
    writeU64(pass_descriptor[0..], 24, 1);
    writePtr(pass_descriptor[0..], 32, ptrFromBytes(color_attachment[0..]));

    const pass = api.command_encoder_begin_render_pass(encoder, ptrFromBytes(pass_descriptor[0..])) orelse return error.MissingRenderPass;
    api.render_pass_encoder_set_pipeline(pass, pipeline.pipeline);
    api.render_pass_encoder_set_vertex_buffer(pass, 0, pipeline.vertex_buffer, 0, vertex_buffer_size);
    api.render_pass_encoder_draw(pass, vertex_count, 1, 0, 0);
    api.render_pass_encoder_end(pass);
    const command_buffer = api.command_encoder_finish(encoder, null) orelse return error.MissingCommandBuffer;
    defer api.command_buffer_release(command_buffer);

    var commands = [_]u64{ptrInt(command_buffer)};
    api.queue_submit(queue, 1, @ptrCast(&commands));
    _ = try core.wgpuSurfacePresentMainThread(context.surface_ptr);
}

fn gpuRenderLoop() void {
    const state = appState();

    var native = electrobun.WgpuNative.load(state.allocator) catch |err| {
        std.debug.print("[zig-wgpu] failed to load WGPU library: {s}\n", .{@errorName(err)});
        return;
    };
    defer native.close();

    const api = WgpuApi.load(&native.lib) catch |err| {
        std.debug.print("[zig-wgpu] failed to load WGPU symbols: {s}\n", .{@errorName(err)});
        return;
    };

    var active_view_id: u32 = 0;
    var context: ?electrobun.WgpuContext = null;
    var pipeline: ?GpuPipeline = null;
    var queue: ?*anyopaque = null;
    var configured_width: u32 = 0;
    var configured_height: u32 = 0;
    var frame: u64 = 0;

    while (host_queue_running.load(.acquire)) {
        const current_state = g_state orelse break;

        current_state.gpu.mutex.lock();
        const running = current_state.gpu.running;
        const view_id = current_state.gpu.view_id;
        const host_webview_id = current_state.gpu.host_webview_id;
        const width = current_state.gpu.width;
        const height = current_state.gpu.height;
        const mode = current_state.gpu.mode;
        const motion = current_state.gpu.motion;
        current_state.gpu.mutex.unlock();

        if (!running or view_id == 0) {
            std.time.sleep(16 * std.time.ns_per_ms);
            continue;
        }

        if (context == null or active_view_id != view_id) {
            context = electrobun.WgpuContext.createForWgpuView(current_state.core, &native, view_id) catch |err| {
                std.debug.print("[zig-wgpu] failed to create WGPU context: {s}\n", .{@errorName(err)});
                std.time.sleep(250 * std.time.ns_per_ms);
                continue;
            };
            queue = context.?.getQueue(&native);
            if (queue == null) {
                std.debug.print("[zig-wgpu] failed to get WGPU queue\n", .{});
                context = null;
                std.time.sleep(250 * std.time.ns_per_ms);
                continue;
            }
            active_view_id = view_id;
            pipeline = createMandelbrotPipeline(api, context.?) catch |err| {
                std.debug.print("[zig-wgpu] failed to create Mandelbrot pipeline: {s}\n", .{@errorName(err)});
                context = null;
                queue = null;
                std.time.sleep(250 * std.time.ns_per_ms);
                continue;
            };
            configured_width = 0;
            configured_height = 0;
            std.debug.print("[zig-wgpu] WGPU context ready for view {d}\n", .{view_id});
        }

        if (configured_width != width or configured_height != height) {
            configureSurface(current_state.core, context.?, width, height) catch |err| {
                std.debug.print("[zig-wgpu] failed to configure surface: {s}\n", .{@errorName(err)});
                std.time.sleep(250 * std.time.ns_per_ms);
                continue;
            };
            configured_width = width;
            configured_height = height;
        }

        renderFrame(current_state.core, api, context.?, pipeline.?, queue, frame, width, height, mode, motion) catch |err| {
            std.debug.print("[zig-wgpu] failed to render frame: {s}\n", .{@errorName(err)});
            std.time.sleep(100 * std.time.ns_per_ms);
            continue;
        };

        if (frame % 30 == 0 and host_webview_id != 0) {
            sendGpuFrame(host_webview_id, view_id, frame, width, height);
        }

        frame += 1;
        std.time.sleep(16 * std.time.ns_per_ms);
    }
}

fn ensureGpuThread() !void {
    if (gpu_thread_started.swap(true, .acq_rel)) {
        return;
    }
    const thread = try std.Thread.spawn(.{}, gpuRenderLoop, .{});
    thread.detach();
}

fn handleRpcRequest(webview_id: u32, request_id: u64, method: []const u8, params: ?std.json.Value) void {
    const state = appState();

    if (std.mem.eql(u8, method, "startGpu")) {
        configureGpuFromParams(state, webview_id, params) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        state.gpu.mutex.lock();
        const started_view_id = state.gpu.view_id;
        state.gpu.mutex.unlock();
        std.debug.print("[zig-wgpu] starting WGPU view {d}\n", .{started_view_id});
        state.gpu.mutex.lock();
        state.gpu.running = true;
        state.gpu.mutex.unlock();
        ensureGpuThread() catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .ok = true });
        return;
    }

    if (std.mem.eql(u8, method, "configureGpu")) {
        configureGpuFromParams(state, webview_id, params) catch |err| {
            sendRpcResponseError(webview_id, request_id, @errorName(err));
            return;
        };
        sendRpcResponseSuccess(webview_id, request_id, .{ .ok = true });
        return;
    }

    sendRpcResponseError(webview_id, request_id, "Unknown RPC request");
}

fn handleHostMessage(webview_id: u32, message: [*:0]const u8) void {
    const state = appState();
    const message_slice = std.mem.span(message);
    if (message_slice.len == 0) return;

    var parsed = std.json.parseFromSlice(std.json.Value, state.allocator, message_slice, .{}) catch |err| {
        std.debug.print("[zig-wgpu] failed to parse RPC packet: {s}\n", .{@errorName(err)});
        return;
    };
    defer parsed.deinit();

    if (parsed.value != .object) return;
    const packet_type = jsonString(&parsed.value.object, "type") orelse return;
    if (!std.mem.eql(u8, packet_type, "request")) return;

    const request_id_value = jsonField(&parsed.value.object, "id") orelse return;
    const request_id: u64 = switch (request_id_value) {
        .integer => |integer| if (integer < 0) return else @intCast(integer),
        else => return,
    };
    const method = jsonString(&parsed.value.object, "method") orelse return;
    const params = jsonField(&parsed.value.object, "params");
    handleRpcRequest(webview_id, request_id, method, params);
}

fn drainHostMessageQueue() void {
    while (host_queue_running.load(.acquire)) {
        const state = g_state orelse {
            std.time.sleep(10 * std.time.ns_per_ms);
            continue;
        };

        var drained_any = false;
        while (host_queue_running.load(.acquire)) {
            var webview_id: u32 = 0;
            const message = state.core.popNextQueuedHostMessage(&webview_id) orelse break;
            handleHostMessage(webview_id, message);
            state.core.freeCoreString(message);
            drained_any = true;
        }

        if (!drained_any) {
            std.time.sleep(10 * std.time.ns_per_ms);
        }
    }
}

fn hostBridge(webview_id: u32, message: [*:0]const u8) callconv(.C) void {
    handleHostMessage(webview_id, message);
}

fn createUi(state: *AppState) void {
    std.time.sleep(150 * std.time.ns_per_ms);

    state.core.configureWebviewRuntimeFromExecutableDir(state.bundle_paths, 0) catch |err| {
        std.debug.print("[zig-wgpu] failed to configure webview runtime: {s}\n", .{@errorName(err)});
        return;
    };

    const window_id = state.core.createWindow(.{
        .title = "Zig WGPU",
        .frame = .{
            .x = 160,
            .y = 100,
            .width = 1040,
            .height = 720,
        },
    }) catch |err| {
        std.debug.print("[zig-wgpu] failed to create window: {s}\n", .{@errorName(err)});
        return;
    };

    const webview_id = state.core.createWebview(.{
        .window_id = window_id,
        .renderer = .native,
        .url = "views://mainview/index.html",
        .frame = .{
            .x = 0,
            .y = 0,
            .width = 1040,
            .height = 720,
        },
        .secret_key = default_secret_key,
        .callbacks = .{
            .decide_navigation = electrobun.allowAllNavigation,
            .event = electrobun.noopWebviewEvent,
            .event_bridge = electrobun.noopWebviewPostMessage,
            .host_bridge = hostBridge,
        },
        .sandbox = false,
    }) catch |err| {
        std.debug.print("[zig-wgpu] failed to create webview: {s}\n", .{@errorName(err)});
        state.core.closeWindow(window_id) catch {};
        return;
    };

    state.mutex.lock();
    state.webview_id = webview_id;
    state.mutex.unlock();
}

pub fn main() !void {
    const allocator = std.heap.c_allocator;

    var core = try electrobun.Core.load(allocator);
    defer core.close();

    var bundle_paths = try electrobun.resolveBundlePaths(allocator);
    defer bundle_paths.deinit(allocator);

    var owned_app_info = try electrobun.resolveAppInfoFromBundle(allocator, &bundle_paths);
    defer owned_app_info.deinit(allocator);
    const app_info = owned_app_info.borrowed();

    var state = AppState{
        .allocator = allocator,
        .core = &core,
        .bundle_paths = &bundle_paths,
    };

    g_state = &state;
    defer g_state = null;

    const ui_thread = try std.Thread.spawn(.{}, createUi, .{&state});
    ui_thread.detach();

    host_queue_running.store(true, .release);
    const host_queue_thread = try std.Thread.spawn(.{}, drainHostMessageQueue, .{});
    defer {
        state.gpu.mutex.lock();
        state.gpu.running = false;
        state.gpu.mutex.unlock();
        host_queue_running.store(false, .release);
        host_queue_thread.join();
    }

    try core.runMainThread(app_info);
}
