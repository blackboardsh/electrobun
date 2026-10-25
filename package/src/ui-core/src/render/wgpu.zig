//! Minimal WebGPU (Dawn webgpu.h) bindings: the structs and entry points the
//! UI renderer uses, loaded at runtime from libwebgpu_dawn so the core has
//! no link-time GPU dependency. Layouts mirror vendor/webgpu/webgpu.h.
const std = @import("std");
const builtin = @import("builtin");
const dynlib = @import("../platform/dynlib.zig");

pub const Instance = *opaque {};
pub const Adapter = *opaque {};
pub const Device = *opaque {};
pub const Queue = *opaque {};
pub const Surface = *opaque {};
pub const ShaderModule = *opaque {};
pub const Buffer = *opaque {};
pub const Texture = *opaque {};
pub const TextureView = *opaque {};
pub const Sampler = *opaque {};
pub const BindGroupLayout = *opaque {};
pub const BindGroup = *opaque {};
pub const PipelineLayout = *opaque {};
pub const RenderPipeline = *opaque {};
pub const CommandEncoder = *opaque {};
pub const CommandBuffer = *opaque {};
pub const RenderPassEncoder = *opaque {};

pub const Bool = u32;
pub const Flags = u64;

pub const StringView = extern struct {
    data: ?[*]const u8 = null,
    length: usize = std.math.maxInt(usize),

    pub fn from(s: []const u8) StringView {
        return .{ .data = s.ptr, .length = s.len };
    }
};

pub const ChainedStruct = extern struct {
    next: ?*const ChainedStruct = null,
    s_type: u32,
};

// sType
pub const stype_shader_source_wgsl: u32 = 0x02;
pub const stype_surface_source_metal_layer: u32 = 0x04;
pub const stype_surface_source_windows_hwnd: u32 = 0x05;
pub const stype_surface_source_xlib_window: u32 = 0x06;
pub const stype_surface_source_wayland_surface: u32 = 0x07;

// enums
pub const TextureFormat = struct {
    pub const r8_unorm: u32 = 0x01;
    pub const rgba8_unorm: u32 = 0x16;
    pub const bgra8_unorm: u32 = 0x1B;
    pub const bgra8_unorm_srgb: u32 = 0x1C;
};
pub const callback_mode_allow_process_events: u32 = 0x02;
pub const callback_mode_allow_spontaneous: u32 = 0x03;
pub const load_op_load: u32 = 0x01;
pub const load_op_clear: u32 = 0x02;
pub const store_op_store: u32 = 0x01;
pub const topology_triangle_list: u32 = 0x04;
pub const topology_triangle_strip: u32 = 0x05;
pub const blend_factor_one: u32 = 0x02;
pub const blend_factor_one_minus_src_alpha: u32 = 0x06;
pub const blend_op_add: u32 = 0x01;
pub const address_clamp: u32 = 0x01;
pub const filter_nearest: u32 = 0x01;
pub const filter_linear: u32 = 0x02;
pub const mipmap_nearest: u32 = 0x01;
pub const buffer_binding_uniform: u32 = 0x02;
pub const buffer_binding_read_only_storage: u32 = 0x04;
pub const sampler_binding_filtering: u32 = 0x02;
pub const texture_sample_float: u32 = 0x02;
pub const view_dimension_2d: u32 = 0x02;
pub const texture_dimension_2d: u32 = 0x02;
pub const texture_aspect_all: u32 = 0x01;
pub const alpha_mode_auto: u32 = 0x00;
pub const alpha_mode_opaque: u32 = 0x01;
pub const alpha_mode_premultiplied: u32 = 0x02;
pub const present_mode_fifo: u32 = 0x01;
pub const surface_status_optimal: u32 = 0x01;
pub const surface_status_suboptimal: u32 = 0x02;
pub const request_status_success: u32 = 0x01;
pub const status_success: u32 = 0x01;
pub const feature_level_core: u32 = 0x02;
pub const power_low: u32 = 0x01;
pub const power_high: u32 = 0x02;
pub const front_face_ccw: u32 = 0x01;
pub const cull_none: u32 = 0x01;
pub const map_status_success: u32 = 0x01;
pub const optional_bool_undefined: u32 = 0x02;

// flags
pub const buffer_usage_map_read: Flags = 0x1;
pub const buffer_usage_copy_src: Flags = 0x4;
pub const buffer_usage_copy_dst: Flags = 0x8;
pub const buffer_usage_vertex: Flags = 0x20;
pub const buffer_usage_uniform: Flags = 0x40;
pub const buffer_usage_storage: Flags = 0x80;
pub const texture_usage_copy_src: Flags = 0x1;
pub const texture_usage_copy_dst: Flags = 0x2;
pub const texture_usage_texture_binding: Flags = 0x4;
pub const texture_usage_render_attachment: Flags = 0x10;
pub const shader_stage_vertex: Flags = 0x1;
pub const shader_stage_fragment: Flags = 0x2;
pub const color_write_all: Flags = 0xF;
pub const map_mode_read: Flags = 0x1;

pub const Future = extern struct { id: u64 };
pub const FutureWaitInfo = extern struct { future: Future, completed: Bool = 0 };

pub const InstanceLimits = extern struct {
    next: ?*const ChainedStruct = null,
    timed_wait_any_max_count: usize = 0,
};

pub const InstanceDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    required_feature_count: usize = 0,
    required_features: ?[*]const u32 = null,
    required_limits: ?*const InstanceLimits = null,
};

pub const RequestAdapterOptions = extern struct {
    next: ?*const ChainedStruct = null,
    feature_level: u32 = feature_level_core,
    power_preference: u32 = 0,
    force_fallback_adapter: Bool = 0,
    backend_type: u32 = 0,
    compatible_surface: ?Surface = null,
};

pub const RequestAdapterCallback = *const fn (status: u32, adapter: ?Adapter, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void;
pub const RequestDeviceCallback = *const fn (status: u32, device: ?Device, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void;
pub const DeviceLostCallback = *const fn (device: *const ?Device, reason: u32, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void;
pub const UncapturedErrorCallback = *const fn (device: *const ?Device, kind: u32, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void;
pub const BufferMapCallback = *const fn (status: u32, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void;

pub const RequestAdapterCallbackInfo = extern struct {
    next: ?*const ChainedStruct = null,
    mode: u32 = callback_mode_allow_process_events,
    callback: ?RequestAdapterCallback = null,
    userdata1: ?*anyopaque = null,
    userdata2: ?*anyopaque = null,
};

pub const RequestDeviceCallbackInfo = extern struct {
    next: ?*const ChainedStruct = null,
    mode: u32 = callback_mode_allow_process_events,
    callback: ?RequestDeviceCallback = null,
    userdata1: ?*anyopaque = null,
    userdata2: ?*anyopaque = null,
};

pub const QueueDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
};

pub const DeviceLostCallbackInfo = extern struct {
    next: ?*const ChainedStruct = null,
    mode: u32 = callback_mode_allow_spontaneous,
    callback: ?DeviceLostCallback = null,
    userdata1: ?*anyopaque = null,
    userdata2: ?*anyopaque = null,
};

pub const UncapturedErrorCallbackInfo = extern struct {
    next: ?*const ChainedStruct = null,
    callback: ?UncapturedErrorCallback = null,
    userdata1: ?*anyopaque = null,
    userdata2: ?*anyopaque = null,
};

pub const DeviceDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    required_feature_count: usize = 0,
    required_features: ?[*]const u32 = null,
    required_limits: ?*const anyopaque = null,
    default_queue: QueueDescriptor = .{},
    device_lost: DeviceLostCallbackInfo = .{},
    uncaptured_error: UncapturedErrorCallbackInfo = .{},
};

pub const SurfaceDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
};

pub const SurfaceSourceMetalLayer = extern struct {
    chain: ChainedStruct = .{ .s_type = stype_surface_source_metal_layer },
    layer: *anyopaque,
};

/// X11 window (Xlib); `window` is the XID.
pub const SurfaceSourceXlibWindow = extern struct {
    chain: ChainedStruct = .{ .s_type = stype_surface_source_xlib_window },
    display: *anyopaque,
    window: u64,
};

pub const SurfaceSourceWindowsHWND = extern struct {
    chain: ChainedStruct = .{ .s_type = stype_surface_source_windows_hwnd },
    hinstance: ?*anyopaque,
    hwnd: *anyopaque,
};

pub const SurfaceConfiguration = extern struct {
    next: ?*const ChainedStruct = null,
    device: Device,
    format: u32,
    usage: Flags = texture_usage_render_attachment,
    width: u32,
    height: u32,
    view_format_count: usize = 0,
    view_formats: ?[*]const u32 = null,
    alpha_mode: u32 = alpha_mode_auto,
    present_mode: u32 = present_mode_fifo,
};

pub const SurfaceTexture = extern struct {
    next: ?*const ChainedStruct = null,
    texture: ?Texture = null,
    status: u32 = 0,
};

pub const AdapterInfo = extern struct {
    next: ?*const ChainedStruct = null,
    vendor: StringView = .{},
    architecture: StringView = .{},
    device: StringView = .{},
    description: StringView = .{},
    backend_type: u32 = 0,
    adapter_type: u32 = 0,
    vendor_id: u32 = 0,
    device_id: u32 = 0,
    subgroup_min_size: u32 = 0,
    subgroup_max_size: u32 = 0,
};

pub const SurfaceCapabilities = extern struct {
    next: ?*const ChainedStruct = null,
    usages: Flags = 0,
    format_count: usize = 0,
    formats: ?[*]const u32 = null,
    present_mode_count: usize = 0,
    present_modes: ?[*]const u32 = null,
    alpha_mode_count: usize = 0,
    alpha_modes: ?[*]const u32 = null,
};

pub const ShaderSourceWGSL = extern struct {
    chain: ChainedStruct = .{ .s_type = stype_shader_source_wgsl },
    code: StringView,
};

pub const ShaderModuleDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
};

pub const BufferDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    usage: Flags,
    size: u64,
    mapped_at_creation: Bool = 0,
};

pub const Extent3D = extern struct {
    width: u32,
    height: u32 = 1,
    depth_or_array_layers: u32 = 1,
};

pub const Origin3D = extern struct { x: u32 = 0, y: u32 = 0, z: u32 = 0 };

pub const TextureDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    usage: Flags,
    dimension: u32 = texture_dimension_2d,
    size: Extent3D,
    format: u32,
    mip_level_count: u32 = 1,
    sample_count: u32 = 1,
    view_format_count: usize = 0,
    view_formats: ?[*]const u32 = null,
};

pub const SamplerDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    address_u: u32 = address_clamp,
    address_v: u32 = address_clamp,
    address_w: u32 = address_clamp,
    mag_filter: u32 = filter_linear,
    min_filter: u32 = filter_linear,
    mipmap_filter: u32 = mipmap_nearest,
    lod_min_clamp: f32 = 0,
    lod_max_clamp: f32 = 32,
    compare: u32 = 0,
    max_anisotropy: u16 = 1,
};

pub const BufferBindingLayout = extern struct {
    next: ?*const ChainedStruct = null,
    type: u32 = 0,
    has_dynamic_offset: Bool = 0,
    min_binding_size: u64 = 0,
};
pub const SamplerBindingLayout = extern struct {
    next: ?*const ChainedStruct = null,
    type: u32 = 0,
};
pub const TextureBindingLayout = extern struct {
    next: ?*const ChainedStruct = null,
    sample_type: u32 = 0,
    view_dimension: u32 = 0,
    multisampled: Bool = 0,
};
pub const StorageTextureBindingLayout = extern struct {
    next: ?*const ChainedStruct = null,
    access: u32 = 0,
    format: u32 = 0,
    view_dimension: u32 = 0,
};

pub const BindGroupLayoutEntry = extern struct {
    next: ?*const ChainedStruct = null,
    binding: u32,
    visibility: Flags,
    binding_array_size: u32 = 0,
    buffer: BufferBindingLayout = .{},
    sampler: SamplerBindingLayout = .{},
    texture: TextureBindingLayout = .{},
    storage_texture: StorageTextureBindingLayout = .{},
};

pub const BindGroupLayoutDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    entry_count: usize,
    entries: [*]const BindGroupLayoutEntry,
};

pub const BindGroupEntry = extern struct {
    next: ?*const ChainedStruct = null,
    binding: u32,
    buffer: ?Buffer = null,
    offset: u64 = 0,
    size: u64 = std.math.maxInt(u64),
    sampler: ?Sampler = null,
    texture_view: ?TextureView = null,
};

pub const BindGroupDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    layout: BindGroupLayout,
    entry_count: usize,
    entries: [*]const BindGroupEntry,
};

pub const PipelineLayoutDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    bind_group_layout_count: usize,
    bind_group_layouts: [*]const BindGroupLayout,
    immediate_size: u32 = 0,
};

pub const ConstantEntry = extern struct {
    next: ?*const ChainedStruct = null,
    key: StringView,
    value: f64,
};

pub const VertexAttribute = extern struct {
    next: ?*const ChainedStruct = null,
    format: u32,
    offset: u64,
    shader_location: u32,
};

pub const VertexBufferLayout = extern struct {
    next: ?*const ChainedStruct = null,
    step_mode: u32,
    array_stride: u64,
    attribute_count: usize,
    attributes: [*]const VertexAttribute,
};

pub const VertexState = extern struct {
    next: ?*const ChainedStruct = null,
    module: ShaderModule,
    entry_point: StringView,
    constant_count: usize = 0,
    constants: ?[*]const ConstantEntry = null,
    buffer_count: usize = 0,
    buffers: ?[*]const VertexBufferLayout = null,
};

pub const PrimitiveState = extern struct {
    next: ?*const ChainedStruct = null,
    topology: u32 = topology_triangle_list,
    strip_index_format: u32 = 0,
    front_face: u32 = front_face_ccw,
    cull_mode: u32 = cull_none,
    unclipped_depth: Bool = 0,
};

pub const MultisampleState = extern struct {
    next: ?*const ChainedStruct = null,
    count: u32 = 1,
    mask: u32 = 0xffffffff,
    alpha_to_coverage_enabled: Bool = 0,
};

pub const BlendComponent = extern struct {
    operation: u32 = blend_op_add,
    src_factor: u32 = blend_factor_one,
    dst_factor: u32 = blend_factor_one_minus_src_alpha,
};

pub const BlendState = extern struct {
    color: BlendComponent = .{},
    alpha: BlendComponent = .{},
};

pub const ColorTargetState = extern struct {
    next: ?*const ChainedStruct = null,
    format: u32,
    blend: ?*const BlendState = null,
    write_mask: Flags = color_write_all,
};

pub const FragmentState = extern struct {
    next: ?*const ChainedStruct = null,
    module: ShaderModule,
    entry_point: StringView,
    constant_count: usize = 0,
    constants: ?[*]const ConstantEntry = null,
    target_count: usize,
    targets: [*]const ColorTargetState,
};

pub const RenderPipelineDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    layout: ?PipelineLayout,
    vertex: VertexState,
    primitive: PrimitiveState = .{},
    depth_stencil: ?*const anyopaque = null,
    multisample: MultisampleState = .{},
    fragment: ?*const FragmentState,
};

pub const Color = extern struct { r: f64 = 0, g: f64 = 0, b: f64 = 0, a: f64 = 0 };

pub const RenderPassColorAttachment = extern struct {
    next: ?*const ChainedStruct = null,
    view: ?TextureView,
    depth_slice: u32 = std.math.maxInt(u32),
    resolve_target: ?TextureView = null,
    load_op: u32,
    store_op: u32 = store_op_store,
    clear_value: Color = .{},
};

pub const RenderPassDescriptor = extern struct {
    next: ?*const ChainedStruct = null,
    label: StringView = .{},
    color_attachment_count: usize,
    color_attachments: [*]const RenderPassColorAttachment,
    depth_stencil_attachment: ?*const anyopaque = null,
    occlusion_query_set: ?*anyopaque = null,
    timestamp_writes: ?*const anyopaque = null,
};

pub const TexelCopyTextureInfo = extern struct {
    texture: Texture,
    mip_level: u32 = 0,
    origin: Origin3D = .{},
    aspect: u32 = texture_aspect_all,
};

pub const TexelCopyBufferLayout = extern struct {
    offset: u64 = 0,
    bytes_per_row: u32,
    rows_per_image: u32,
};

pub const TexelCopyBufferInfo = extern struct {
    layout: TexelCopyBufferLayout,
    buffer: Buffer,
};

pub const BufferMapCallbackInfo = extern struct {
    next: ?*const ChainedStruct = null,
    mode: u32 = callback_mode_allow_process_events,
    callback: ?BufferMapCallback = null,
    userdata1: ?*anyopaque = null,
    userdata2: ?*anyopaque = null,
};

/// Entry points resolved from the Dawn shared library.
pub const Api = struct {
    lib: dynlib.DynLib,
    createInstance: *const fn (?*const InstanceDescriptor) callconv(.c) ?Instance,
    instanceCreateSurface: *const fn (Instance, *const SurfaceDescriptor) callconv(.c) ?Surface,
    instanceRequestAdapter: *const fn (Instance, ?*const RequestAdapterOptions, RequestAdapterCallbackInfo) callconv(.c) Future,
    instanceProcessEvents: *const fn (Instance) callconv(.c) void,
    adapterRequestDevice: *const fn (Adapter, ?*const DeviceDescriptor, RequestDeviceCallbackInfo) callconv(.c) Future,
    deviceGetQueue: *const fn (Device) callconv(.c) Queue,
    surfaceConfigure: *const fn (Surface, *const SurfaceConfiguration) callconv(.c) void,
    surfaceGetCapabilities: *const fn (Surface, Adapter, *SurfaceCapabilities) callconv(.c) u32,
    surfaceCapabilitiesFreeMembers: *const fn (SurfaceCapabilities) callconv(.c) void,
    surfaceGetCurrentTexture: *const fn (Surface, *SurfaceTexture) callconv(.c) void,
    surfacePresent: *const fn (Surface) callconv(.c) u32,
    surfaceRelease: *const fn (Surface) callconv(.c) void,
    deviceCreateShaderModule: *const fn (Device, *const ShaderModuleDescriptor) callconv(.c) ?ShaderModule,
    deviceCreateBuffer: *const fn (Device, *const BufferDescriptor) callconv(.c) ?Buffer,
    deviceCreateTexture: *const fn (Device, *const TextureDescriptor) callconv(.c) ?Texture,
    textureCreateView: *const fn (Texture, ?*const anyopaque) callconv(.c) ?TextureView,
    deviceCreateSampler: *const fn (Device, ?*const SamplerDescriptor) callconv(.c) ?Sampler,
    deviceCreateBindGroupLayout: *const fn (Device, *const BindGroupLayoutDescriptor) callconv(.c) ?BindGroupLayout,
    deviceCreateBindGroup: *const fn (Device, *const BindGroupDescriptor) callconv(.c) ?BindGroup,
    deviceCreatePipelineLayout: *const fn (Device, *const PipelineLayoutDescriptor) callconv(.c) ?PipelineLayout,
    deviceCreateRenderPipeline: *const fn (Device, *const RenderPipelineDescriptor) callconv(.c) ?RenderPipeline,
    deviceCreateCommandEncoder: *const fn (Device, ?*const anyopaque) callconv(.c) ?CommandEncoder,
    commandEncoderBeginRenderPass: *const fn (CommandEncoder, *const RenderPassDescriptor) callconv(.c) ?RenderPassEncoder,
    renderPassSetPipeline: *const fn (RenderPassEncoder, RenderPipeline) callconv(.c) void,
    renderPassSetBindGroup: *const fn (RenderPassEncoder, u32, ?BindGroup, usize, ?[*]const u32) callconv(.c) void,
    renderPassSetScissorRect: *const fn (RenderPassEncoder, u32, u32, u32, u32) callconv(.c) void,
    renderPassDraw: *const fn (RenderPassEncoder, u32, u32, u32, u32) callconv(.c) void,
    renderPassEnd: *const fn (RenderPassEncoder) callconv(.c) void,
    renderPassRelease: *const fn (RenderPassEncoder) callconv(.c) void,
    commandEncoderFinish: *const fn (CommandEncoder, ?*const anyopaque) callconv(.c) ?CommandBuffer,
    commandEncoderCopyTextureToBuffer: *const fn (CommandEncoder, *const TexelCopyTextureInfo, *const TexelCopyBufferInfo, *const Extent3D) callconv(.c) void,
    commandEncoderCopyTextureToTexture: *const fn (CommandEncoder, *const TexelCopyTextureInfo, *const TexelCopyTextureInfo, *const Extent3D) callconv(.c) void,
    commandEncoderRelease: *const fn (CommandEncoder) callconv(.c) void,
    commandBufferRelease: *const fn (CommandBuffer) callconv(.c) void,
    queueSubmit: *const fn (Queue, usize, [*]const CommandBuffer) callconv(.c) void,
    queueWriteBuffer: *const fn (Queue, Buffer, u64, *const anyopaque, usize) callconv(.c) void,
    queueWriteTexture: *const fn (Queue, *const TexelCopyTextureInfo, *const anyopaque, usize, *const TexelCopyBufferLayout, *const Extent3D) callconv(.c) void,
    bufferMapAsync: *const fn (Buffer, Flags, usize, usize, BufferMapCallbackInfo) callconv(.c) Future,
    bufferGetConstMappedRange: *const fn (Buffer, usize, usize) callconv(.c) ?*const anyopaque,
    bufferUnmap: *const fn (Buffer) callconv(.c) void,
    bufferRelease: *const fn (Buffer) callconv(.c) void,
    bufferDestroy: *const fn (Buffer) callconv(.c) void,
    textureRelease: *const fn (Texture) callconv(.c) void,
    textureDestroy: *const fn (Texture) callconv(.c) void,
    textureViewRelease: *const fn (TextureView) callconv(.c) void,
    bindGroupRelease: *const fn (BindGroup) callconv(.c) void,
    samplerRelease: *const fn (Sampler) callconv(.c) void,
    shaderModuleRelease: *const fn (ShaderModule) callconv(.c) void,
    deviceRelease: *const fn (Device) callconv(.c) void,
    adapterRelease: *const fn (Adapter) callconv(.c) void,
    adapterGetInfo: *const fn (Adapter, *AdapterInfo) callconv(.c) u32,
    adapterInfoFreeMembers: *const fn (AdapterInfo) callconv(.c) void,
    instanceRelease: *const fn (Instance) callconv(.c) void,
    queueRelease: *const fn (Queue) callconv(.c) void,

    pub fn load(path: []const u8) !Api {
        var lib = try dynlib.DynLib.open(path);
        errdefer lib.close();
        var api: Api = undefined;
        api.lib = lib;
        const names = .{
            .{ "createInstance", "wgpuCreateInstance" },
            .{ "instanceCreateSurface", "wgpuInstanceCreateSurface" },
            .{ "instanceRequestAdapter", "wgpuInstanceRequestAdapter" },
            .{ "instanceProcessEvents", "wgpuInstanceProcessEvents" },
            .{ "adapterRequestDevice", "wgpuAdapterRequestDevice" },
            .{ "deviceGetQueue", "wgpuDeviceGetQueue" },
            .{ "surfaceConfigure", "wgpuSurfaceConfigure" },
            .{ "surfaceGetCapabilities", "wgpuSurfaceGetCapabilities" },
            .{ "surfaceCapabilitiesFreeMembers", "wgpuSurfaceCapabilitiesFreeMembers" },
            .{ "surfaceGetCurrentTexture", "wgpuSurfaceGetCurrentTexture" },
            .{ "surfacePresent", "wgpuSurfacePresent" },
            .{ "surfaceRelease", "wgpuSurfaceRelease" },
            .{ "deviceCreateShaderModule", "wgpuDeviceCreateShaderModule" },
            .{ "deviceCreateBuffer", "wgpuDeviceCreateBuffer" },
            .{ "deviceCreateTexture", "wgpuDeviceCreateTexture" },
            .{ "textureCreateView", "wgpuTextureCreateView" },
            .{ "deviceCreateSampler", "wgpuDeviceCreateSampler" },
            .{ "deviceCreateBindGroupLayout", "wgpuDeviceCreateBindGroupLayout" },
            .{ "deviceCreateBindGroup", "wgpuDeviceCreateBindGroup" },
            .{ "deviceCreatePipelineLayout", "wgpuDeviceCreatePipelineLayout" },
            .{ "deviceCreateRenderPipeline", "wgpuDeviceCreateRenderPipeline" },
            .{ "deviceCreateCommandEncoder", "wgpuDeviceCreateCommandEncoder" },
            .{ "commandEncoderBeginRenderPass", "wgpuCommandEncoderBeginRenderPass" },
            .{ "renderPassSetPipeline", "wgpuRenderPassEncoderSetPipeline" },
            .{ "renderPassSetBindGroup", "wgpuRenderPassEncoderSetBindGroup" },
            .{ "renderPassSetScissorRect", "wgpuRenderPassEncoderSetScissorRect" },
            .{ "renderPassDraw", "wgpuRenderPassEncoderDraw" },
            .{ "renderPassEnd", "wgpuRenderPassEncoderEnd" },
            .{ "renderPassRelease", "wgpuRenderPassEncoderRelease" },
            .{ "commandEncoderFinish", "wgpuCommandEncoderFinish" },
            .{ "commandEncoderCopyTextureToBuffer", "wgpuCommandEncoderCopyTextureToBuffer" },
            .{ "commandEncoderCopyTextureToTexture", "wgpuCommandEncoderCopyTextureToTexture" },
            .{ "commandEncoderRelease", "wgpuCommandEncoderRelease" },
            .{ "commandBufferRelease", "wgpuCommandBufferRelease" },
            .{ "queueSubmit", "wgpuQueueSubmit" },
            .{ "queueWriteBuffer", "wgpuQueueWriteBuffer" },
            .{ "queueWriteTexture", "wgpuQueueWriteTexture" },
            .{ "bufferMapAsync", "wgpuBufferMapAsync" },
            .{ "bufferGetConstMappedRange", "wgpuBufferGetConstMappedRange" },
            .{ "bufferUnmap", "wgpuBufferUnmap" },
            .{ "bufferRelease", "wgpuBufferRelease" },
            .{ "bufferDestroy", "wgpuBufferDestroy" },
            .{ "textureRelease", "wgpuTextureRelease" },
            .{ "textureDestroy", "wgpuTextureDestroy" },
            .{ "textureViewRelease", "wgpuTextureViewRelease" },
            .{ "bindGroupRelease", "wgpuBindGroupRelease" },
            .{ "samplerRelease", "wgpuSamplerRelease" },
            .{ "shaderModuleRelease", "wgpuShaderModuleRelease" },
            .{ "deviceRelease", "wgpuDeviceRelease" },
            .{ "adapterRelease", "wgpuAdapterRelease" },
            .{ "adapterGetInfo", "wgpuAdapterGetInfo" },
            .{ "adapterInfoFreeMembers", "wgpuAdapterInfoFreeMembers" },
            .{ "instanceRelease", "wgpuInstanceRelease" },
            .{ "queueRelease", "wgpuQueueRelease" },
        };
        inline for (names) |n| {
            @field(api, n[0]) = api.lib.lookup(@FieldType(Api, n[0]), n[1]) orelse {
                std.log.err("webgpu: missing symbol {s}", .{n[1]});
                return error.MissingSymbol;
            };
        }
        return api;
    }
};

/// A device + queue, created synchronously.
pub const Context = struct {
    api: *const Api,
    instance: Instance,
    adapter: Adapter,
    device: Device,
    queue: Queue,

    const Req = struct {
        adapter: ?Adapter = null,
        device: ?Device = null,
        done: bool = false,
        status: u32 = 0,
    };

    fn onAdapter(status: u32, adapter: ?Adapter, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void {
        _ = ud2;
        const r: *Req = @ptrCast(@alignCast(ud1.?));
        r.status = status;
        r.adapter = adapter;
        r.done = true;
        if (status != request_status_success) logMessage("adapter request failed", message);
    }

    fn onDevice(status: u32, device: ?Device, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void {
        _ = ud2;
        const r: *Req = @ptrCast(@alignCast(ud1.?));
        r.status = status;
        r.device = device;
        r.done = true;
        if (status != request_status_success) logMessage("device request failed", message);
    }

    fn onError(device: *const ?Device, kind: u32, message: StringView, ud1: ?*anyopaque, ud2: ?*anyopaque) callconv(.c) void {
        _ = device;
        _ = ud1;
        _ = ud2;
        std.log.err("webgpu error {d}", .{kind});
        logMessage("webgpu", message);
    }

    pub fn create(api: *const Api, compatible: ?Surface) !Context {
        const instance = api.createInstance(null) orelse return error.NoInstance;
        var req = Req{};
        const opts = RequestAdapterOptions{ .power_preference = power_low, .compatible_surface = compatible };
        _ = api.instanceRequestAdapter(instance, &opts, .{ .callback = onAdapter, .userdata1 = &req });
        var spins: usize = 0;
        while (!req.done and spins < 100000) : (spins += 1) api.instanceProcessEvents(instance);
        const adapter = req.adapter orelse return error.NoAdapter;
        req = .{};
        const desc = DeviceDescriptor{ .uncaptured_error = .{ .callback = onError } };
        _ = api.adapterRequestDevice(adapter, &desc, .{ .callback = onDevice, .userdata1 = &req });
        spins = 0;
        while (!req.done and spins < 100000) : (spins += 1) api.instanceProcessEvents(instance);
        const device = req.device orelse return error.NoDevice;
        return .{ .api = api, .instance = instance, .adapter = adapter, .device = device, .queue = api.deviceGetQueue(device) };
    }

    /// Log the adapter and backend Dawn picked (once per process, at info level).
    pub fn logAdapter(ctx: *const Context) void {
        var info = AdapterInfo{};
        if (ctx.api.adapterGetInfo(ctx.adapter, &info) != status_success) return;
        defer ctx.api.adapterInfoFreeMembers(info);
        const backends = [_][]const u8{ "undefined", "null", "webgpu", "d3d11", "d3d12", "metal", "vulkan", "opengl", "opengles" };
        const backend = if (info.backend_type < backends.len) backends[info.backend_type] else "?";
        std.log.info("webgpu adapter: {s} ({s}) backend={s} type={d}", .{ viewString(info.device), viewString(info.description), backend, info.adapter_type });
    }

    /// Context for a surface; the instance must be the one that created it.
    pub fn createWithInstance(api: *const Api, instance: Instance, surface: ?Surface) !Context {
        var req = Req{};
        const opts = RequestAdapterOptions{ .power_preference = power_low, .compatible_surface = surface };
        _ = api.instanceRequestAdapter(instance, &opts, .{ .callback = onAdapter, .userdata1 = &req });
        var spins: usize = 0;
        while (!req.done and spins < 100000) : (spins += 1) api.instanceProcessEvents(instance);
        const adapter = req.adapter orelse return error.NoAdapter;
        req = .{};
        const desc = DeviceDescriptor{ .uncaptured_error = .{ .callback = onError } };
        _ = api.adapterRequestDevice(adapter, &desc, .{ .callback = onDevice, .userdata1 = &req });
        spins = 0;
        while (!req.done and spins < 100000) : (spins += 1) api.instanceProcessEvents(instance);
        const device = req.device orelse return error.NoDevice;
        return .{ .api = api, .instance = instance, .adapter = adapter, .device = device, .queue = api.deviceGetQueue(device) };
    }
};

fn viewString(sv: StringView) []const u8 {
    const d = sv.data orelse return "";
    const len = if (sv.length == std.math.maxInt(usize)) std.mem.len(@as([*:0]const u8, @ptrCast(d))) else sv.length;
    return d[0..len];
}

fn logMessage(prefix: []const u8, m: StringView) void {
    if (m.data) |d| {
        const len = if (m.length == std.math.maxInt(usize)) std.mem.len(@as([*:0]const u8, @ptrCast(d))) else m.length;
        std.log.err("{s}: {s}", .{ prefix, d[0..len] });
    } else std.log.err("{s}", .{prefix});
}

pub fn defaultLibraryPath() []const u8 {
    return switch (builtin.os.tag) {
        .macos => "libwebgpu_dawn.dylib",
        .windows => "webgpu_dawn.dll",
        else => "libwebgpu_dawn.so",
    };
}
