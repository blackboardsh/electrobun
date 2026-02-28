import { existsSync } from "fs";
import { join, dirname } from "path";
import { dlopen, suffix, FFIType } from "bun:ffi";

// NOTE: WGPUStringView is passed by value in the C API. Bun FFI does not support
// by-value structs, so WGPUStringView parameters are exposed as pointers for now.
// If you need these calls, add a small C shim that accepts a pointer and
// forwards by value. WGPUFuture is a single u64 and is mapped to FFIType.u64.
const WGPU_SYMBOLS = {
	wgpuCreateInstance: { args: [FFIType.ptr], returns: FFIType.ptr },
	wgpuGetInstanceFeatures: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuGetInstanceLimits: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuHasInstanceFeature: { args: [FFIType.u32], returns: FFIType.u32 },
	wgpuGetProcAddress: { args: [FFIType.ptr], returns: FFIType.ptr },
	wgpuAdapterCreateDevice: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuAdapterGetFeatures: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuAdapterGetFormatCapabilities: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
	wgpuAdapterGetInfo: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuAdapterGetInstance: { args: [FFIType.ptr], returns: FFIType.ptr },
	wgpuAdapterGetLimits: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuAdapterHasFeature: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	wgpuAdapterRequestDevice: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuAdapterAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuAdapterRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuAdapterInfoFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuAdapterPropertiesMemoryHeapsFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuAdapterPropertiesSubgroupMatrixConfigsFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBindGroupSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuBindGroupAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBindGroupRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBindGroupLayoutSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuBindGroupLayoutAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBindGroupLayoutRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBufferCreateTexelView: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuBufferDestroy: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBufferGetConstMappedRange: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.ptr },
	wgpuBufferGetMappedRange: { args: [FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.ptr },
	wgpuBufferGetMapState: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuBufferGetSize: { args: [FFIType.ptr], returns: FFIType.u64 },
	wgpuBufferGetUsage: { args: [FFIType.ptr], returns: FFIType.u64 },
	wgpuBufferMapAsync: { args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.u64 },
	wgpuBufferReadMappedRange: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.u32 },
	wgpuBufferSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuBufferUnmap: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBufferWriteMappedRange: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.u32 },
	wgpuBufferAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuBufferRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuCommandBufferSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandBufferAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuCommandBufferRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderBeginComputePass: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuCommandEncoderBeginRenderPass: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuCommandEncoderClearBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.void },
	wgpuCommandEncoderCopyBufferToBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.void },
	wgpuCommandEncoderCopyBufferToTexture: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderCopyTextureToBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderCopyTextureToTexture: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderFinish: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuCommandEncoderInjectValidationError: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderInsertDebugMarker: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderPopDebugGroup: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderPushDebugGroup: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderResolveQuerySet: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuCommandEncoderSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderWriteBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuCommandEncoderWriteTimestamp: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.void },
	wgpuCommandEncoderAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuCommandEncoderRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderDispatchWorkgroups: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.void },
	wgpuComputePassEncoderDispatchWorkgroupsIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuComputePassEncoderEnd: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderInsertDebugMarker: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderPopDebugGroup: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderPushDebugGroup: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderSetBindGroup: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderSetImmediates: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuComputePassEncoderSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderSetPipeline: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderSetResourceTable: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderWriteTimestamp: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.void },
	wgpuComputePassEncoderAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuComputePassEncoderRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuComputePipelineGetBindGroupLayout: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
	wgpuComputePipelineSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuComputePipelineAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuComputePipelineRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuDawnDrmFormatCapabilitiesFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuDeviceCreateBindGroup: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateBindGroupLayout: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateBuffer: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateCommandEncoder: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateComputePipeline: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateComputePipelineAsync: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuDeviceCreateErrorBuffer: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateErrorExternalTexture: { args: [FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateErrorShaderModule: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateErrorTexture: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateExternalTexture: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreatePipelineLayout: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateQuerySet: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateRenderBundleEncoder: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateRenderPipeline: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateRenderPipelineAsync: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuDeviceCreateResourceTable: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateSampler: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateShaderModule: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceCreateTexture: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceDestroy: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuDeviceForceLoss: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.void },
	wgpuDeviceGetAdapter: { args: [FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceGetAdapterInfo: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuDeviceGetAHardwareBufferProperties: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuDeviceGetFeatures: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuDeviceGetLimits: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuDeviceGetLostFuture: { args: [FFIType.ptr], returns: FFIType.u64 },
	wgpuDeviceGetQueue: { args: [FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceHasFeature: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	wgpuDeviceImportSharedBufferMemory: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceImportSharedFence: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceImportSharedTextureMemory: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuDeviceInjectError: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.void },
	wgpuDevicePopErrorScope: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuDevicePushErrorScope: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
	wgpuDeviceSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuDeviceSetLoggingCallback: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuDeviceTick: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuDeviceValidateTextureDescriptor: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuDeviceAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuDeviceRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuExternalTextureDestroy: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuExternalTextureExpire: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuExternalTextureRefresh: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuExternalTextureSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuExternalTextureAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuExternalTextureRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuInstanceCreateSurface: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuInstanceGetWGSLLanguageFeatures: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuInstanceHasWGSLLanguageFeature: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	wgpuInstanceProcessEvents: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuInstanceRequestAdapter: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuInstanceWaitAny: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.u32 },
	wgpuInstanceAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuInstanceRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuPipelineLayoutSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuPipelineLayoutAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuPipelineLayoutRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuQuerySetDestroy: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuQuerySetGetCount: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuQuerySetGetType: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuQuerySetSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuQuerySetAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuQuerySetRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuQueueCopyExternalTextureForBrowser: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuQueueCopyTextureForBrowser: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuQueueOnSubmittedWorkDone: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuQueueSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuQueueSubmit: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
	wgpuQueueWriteBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuQueueWriteTexture: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuQueueAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuQueueRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderDraw: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.void },
	wgpuRenderBundleEncoderDrawIndexed: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.void },
	wgpuRenderBundleEncoderDrawIndexedIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderBundleEncoderDrawIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderBundleEncoderFinish: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuRenderBundleEncoderInsertDebugMarker: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderPopDebugGroup: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderPushDebugGroup: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderSetBindGroup: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderSetImmediates: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderBundleEncoderSetIndexBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.void },
	wgpuRenderBundleEncoderSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderSetPipeline: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderSetResourceTable: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderSetVertexBuffer: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.void },
	wgpuRenderBundleEncoderAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderBundleEncoderRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderBeginOcclusionQuery: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
	wgpuRenderPassEncoderDraw: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.void },
	wgpuRenderPassEncoderDrawIndexed: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.void },
	wgpuRenderPassEncoderDrawIndexedIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderDrawIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderEnd: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderEndOcclusionQuery: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderExecuteBundles: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderInsertDebugMarker: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderMultiDrawIndexedIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderMultiDrawIndirect: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderPixelLocalStorageBarrier: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderPopDebugGroup: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderPushDebugGroup: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderSetBindGroup: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderSetBlendConstant: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderSetImmediates: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderSetIndexBuffer: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderSetPipeline: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderSetResourceTable: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderSetScissorRect: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.void },
	wgpuRenderPassEncoderSetStencilReference: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
	wgpuRenderPassEncoderSetVertexBuffer: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u64], returns: FFIType.void },
	wgpuRenderPassEncoderSetViewport: { args: [FFIType.ptr, FFIType.f32, FFIType.f32, FFIType.f32, FFIType.f32, FFIType.f32, FFIType.f32], returns: FFIType.void },
	wgpuRenderPassEncoderWriteTimestamp: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.void },
	wgpuRenderPassEncoderAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPassEncoderRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPipelineGetBindGroupLayout: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
	wgpuRenderPipelineSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuRenderPipelineAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuRenderPipelineRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuResourceTableDestroy: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuResourceTableGetSize: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuResourceTableInsertBinding: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuResourceTableRemoveBinding: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
	wgpuResourceTableUpdate: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
	wgpuResourceTableAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuResourceTableRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSamplerSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSamplerAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSamplerRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuShaderModuleGetCompilationInfo: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
	wgpuShaderModuleSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuShaderModuleAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuShaderModuleRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedBufferMemoryBeginAccess: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedBufferMemoryCreateBuffer: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuSharedBufferMemoryEndAccess: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedBufferMemoryGetProperties: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedBufferMemoryIsDeviceLost: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedBufferMemorySetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSharedBufferMemoryAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedBufferMemoryRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedBufferMemoryEndAccessStateFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedFenceExportInfo: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSharedFenceAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedFenceRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedTextureMemoryBeginAccess: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedTextureMemoryCreateTexture: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuSharedTextureMemoryEndAccess: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedTextureMemoryGetProperties: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedTextureMemoryIsDeviceLost: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuSharedTextureMemorySetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSharedTextureMemoryAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedTextureMemoryRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSharedTextureMemoryEndAccessStateFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSupportedFeaturesFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSupportedInstanceFeaturesFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSupportedWGSLLanguageFeaturesFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSurfaceConfigure: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSurfaceGetCapabilities: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
	wgpuSurfaceGetCurrentTexture: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSurfacePresent: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuSurfaceSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuSurfaceUnconfigure: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSurfaceAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSurfaceRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuSurfaceCapabilitiesFreeMembers: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTexelBufferViewSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuTexelBufferViewAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTexelBufferViewRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTextureCreateErrorView: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuTextureCreateView: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
	wgpuTextureDestroy: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTextureGetDepthOrArrayLayers: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetDimension: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetFormat: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetHeight: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetMipLevelCount: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetSampleCount: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetTextureBindingViewDimension: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTextureGetUsage: { args: [FFIType.ptr], returns: FFIType.u64 },
	wgpuTextureGetWidth: { args: [FFIType.ptr], returns: FFIType.u32 },
	wgpuTexturePin: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuTextureSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuTextureSetOwnershipForMemoryDump: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.void },
	wgpuTextureUnpin: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTextureAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTextureRelease: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTextureViewSetLabel: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
	wgpuTextureViewAddRef: { args: [FFIType.ptr], returns: FFIType.void },
	wgpuTextureViewRelease: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

const WGPU_LIB_NAMES: Record<string, string[]> = {
	darwin: ["libwebgpu_dawn.dylib"],
	win32: ["webgpu_dawn.dll", "libwebgpu_dawn.dll"],
	linux: ["libwebgpu_dawn.so"],
};

function findWgpuLibraryPath(): string | null {
	const debug = process.env.ELECTROBUN_WGPU_DEBUG === "1";
	const envPath = process.env.ELECTROBUN_WGPU_PATH;
	if (envPath && existsSync(envPath)) {
		if (debug) console.log("[WGPU] using ELECTROBUN_WGPU_PATH:", envPath);
		return envPath;
	} else if (envPath && debug) {
		console.warn("[WGPU] ELECTROBUN_WGPU_PATH not found:", envPath);
	}

	const names = WGPU_LIB_NAMES[process.platform] ?? ["libwebgpu_dawn." + suffix];
	for (const name of names) {
		const cwdCandidate = join(process.cwd(), name);
		if (existsSync(cwdCandidate)) {
			if (debug) console.log("[WGPU] found in cwd:", cwdCandidate);
			return cwdCandidate;
		}
		const execDir = dirname(process.execPath);
		const macCandidate = join(execDir, "..", "MacOS", name);
		if (existsSync(macCandidate)) {
			if (debug) console.log("[WGPU] found in bundle MacOS:", macCandidate);
			return macCandidate;
		}
		const resCandidate = join(execDir, "..", "Resources", name);
		if (existsSync(resCandidate)) {
			if (debug) console.log("[WGPU] found in bundle Resources:", resCandidate);
			return resCandidate;
		}
		const execCandidate = join(execDir, name);
		if (existsSync(execCandidate)) {
			if (debug) console.log("[WGPU] found next to exec:", execCandidate);
			return execCandidate;
		}
	}

	if (debug) {
		console.warn("[WGPU] not found. platform:", process.platform, "execPath:", process.execPath, "cwd:", process.cwd());
		console.warn("[WGPU] names:", names);
	}

	return null;
}

export const native = (() => {
	const libPath = findWgpuLibraryPath();
	if (!libPath) {
		return {
			available: false,
			path: null as string | null,
			symbols: {} as Record<string, never>,
			close: () => {},
		};
	}

	try {
		const lib = dlopen(libPath, WGPU_SYMBOLS);
		return {
			available: true,
			path: libPath,
			symbols: lib.symbols,
			close: lib.close,
		};
	} catch (err) {
		console.warn("[WGPU] dlopen failed:", libPath, err?.message ?? err);
		return {
			available: false,
			path: libPath,
			symbols: {} as Record<string, never>,
			close: () => {},
		};
	}
})();

const WGPU = {
	native,
};

export default WGPU;
