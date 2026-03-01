import { WGPUView } from "./core/WGPUView";
import { GpuWindow } from "./core/GpuWindow";
import WGPU from "./webGPU";
import { WGPUBridge } from "./proc/native";
import { ptr, CString, toArrayBuffer, type Pointer } from "bun:ffi";

const WGPUNative = WGPU.native;
const WGPUSType_SurfaceSourceMetalLayer = 0x00000004;
const WGPUTextureFormat_BGRA8Unorm = 0x0000001B;
const WGPUTextureFormat_BGRA8UnormSrgb = 0x0000001C;
const WGPUTextureFormat_RGBA8Unorm = 0x00000016;
const WGPUTextureFormat_RGBA8UnormSrgb = 0x00000017;
const WGPUTextureFormat_Depth24Plus = 0x0000002E;
const WGPUTextureFormat_Depth24PlusStencil8 = 0x0000002F;
const WGPUTextureFormat_Depth32Float = 0x00000030;
const WGPUTextureFormat_Depth16Unorm = 0x0000002D;
const WGPUTextureFormat_Depth32FloatStencil8 = 0x00000031;
const WGPUTextureFormat_RGBA32Sint = 0x0000002B;
const WGPUTextureFormat_RGBA32Uint = 0x0000002A;
const WGPUTextureFormat_RGBA16Sint = 0x00000027;
const WGPUTextureFormat_RGBA16Uint = 0x00000026;
const WGPUTextureFormat_RGBA16Float = 0x00000028;
const WGPUTextureFormat_RG32Sint = 0x00000023;
const WGPUTextureFormat_RG32Uint = 0x00000022;
const WGPUTextureFormat_RG32Float = 0x00000021;
const WGPUTextureFormat_R32Sint = 0x00000010;
const WGPUTextureFormat_R32Uint = 0x0000000F;
const WGPUTextureFormat_R32Float = 0x0000000E;
const WGPUTextureFormat_RGBA8Snorm = 0x00000018;
const WGPUTextureFormat_RGBA8Uint = 0x00000019;
const WGPUTextureFormat_RGBA8Sint = 0x0000001A;
const WGPUTextureFormat_RG8Unorm = 0x0000000A;
const WGPUTextureFormat_RG8Snorm = 0x0000000B;
const WGPUTextureFormat_RG8Uint = 0x0000000C;
const WGPUTextureFormat_RG8Sint = 0x0000000D;
const WGPUTextureFormat_R8Unorm = 0x00000001;
const WGPUTextureFormat_R8Snorm = 0x00000002;
const WGPUTextureFormat_R8Uint = 0x00000003;
const WGPUTextureFormat_R8Sint = 0x00000004;
const WGPUTextureUsage_RenderAttachment = 0x0000000000000010n;
const WGPUTextureUsage_CopyDst = 0x0000000000000002n;
const WGPUTextureUsage_CopySrc = 0x0000000000000001n;
const WGPUTextureUsage_TextureBinding = 0x0000000000000004n;
const WGPUTextureUsage_StorageBinding = 0x0000000000000008n;
const WGPUTextureUsage_TransientAttachment = 0x0000000000000020n;
const WGPUTextureUsage_Present = 0x0000000000000040n;
const WGPUPresentMode_Fifo = 0x00000001;
const WGPUCompositeAlphaMode_Opaque = 0x00000001;
const WGPUCompositeAlphaMode_Premultiplied = 0x00000002;
const WGPUCompositeAlphaMode_Unpremultiplied = 0x00000003;
const WGPUVertexFormat_Float32 = 0x0000001C;
const WGPUVertexFormat_Float32x2 = 0x0000001D;
const WGPUVertexFormat_Float32x3 = 0x0000001E;
const WGPUVertexFormat_Float32x4 = 0x0000001F;
const WGPUVertexFormat_Uint32 = 0x00000020;
const WGPUVertexFormat_Uint32x2 = 0x00000021;
const WGPUVertexFormat_Uint32x3 = 0x00000022;
const WGPUVertexFormat_Uint32x4 = 0x00000023;
const WGPUVertexFormat_Sint32 = 0x00000024;
const WGPUVertexFormat_Sint32x2 = 0x00000025;
const WGPUVertexFormat_Sint32x3 = 0x00000026;
const WGPUVertexFormat_Sint32x4 = 0x00000027;
const WGPUVertexStepMode_Vertex = 0x00000001;
const WGPUVertexStepMode_Instance = 0x00000002;
const WGPUPrimitiveTopology_PointList = 0x00000001;
const WGPUPrimitiveTopology_LineList = 0x00000002;
const WGPUPrimitiveTopology_LineStrip = 0x00000003;
const WGPUPrimitiveTopology_TriangleList = 0x00000004;
const WGPUPrimitiveTopology_TriangleStrip = 0x00000005;
const WGPUFrontFace_CCW = 0x00000001;
const WGPUFrontFace_CW = 0x00000002;
const WGPUCullMode_None = 0x00000001;
const WGPUCullMode_Front = 0x00000002;
const WGPUCullMode_Back = 0x00000003;
const WGPULoadOp_Load = 0x00000001;
const WGPULoadOp_Clear = 0x00000002;
const WGPUStoreOp_Store = 0x00000001;
const WGPUStoreOp_Discard = 0x00000002;
const WGPUTextureDimension_2D = 0x00000002;
const WGPUTextureViewDimension_2D = 0x00000002;
const WGPUTextureViewDimension_2DArray = 0x00000003;
const WGPUTextureViewDimension_3D = 0x00000006;
const WGPUTextureViewDimension_Cube = 0x00000004;
const WGPUTextureViewDimension_CubeArray = 0x00000005;
const WGPUTextureAspect_All = 0x00000001;
const WGPUTextureAspect_StencilOnly = 0x00000002;
const WGPUTextureAspect_DepthOnly = 0x00000003;
const WGPUCompareFunction_Never = 0x00000001;
const WGPUCompareFunction_Less = 0x00000002;
const WGPUCompareFunction_Equal = 0x00000003;
const WGPUCompareFunction_LessEqual = 0x00000004;
const WGPUCompareFunction_Greater = 0x00000005;
const WGPUCompareFunction_NotEqual = 0x00000006;
const WGPUCompareFunction_GreaterEqual = 0x00000007;
const WGPUCompareFunction_Always = 0x00000008;
const WGPUAddressMode_ClampToEdge = 0x00000001;
const WGPUAddressMode_Repeat = 0x00000002;
const WGPUAddressMode_MirrorRepeat = 0x00000003;
const WGPUFilterMode_Nearest = 0x00000001;
const WGPUFilterMode_Linear = 0x00000002;
const WGPUMipmapFilterMode_Nearest = 0x00000001;
const WGPUMipmapFilterMode_Linear = 0x00000002;
const WGPUBufferUsage_CopySrc = 0x0000000000000004n;
const WGPUBufferUsage_CopyDst = 0x0000000000000008n;
const WGPUBufferUsage_Index = 0x0000000000000010n;
const WGPUBufferUsage_Vertex = 0x0000000000000020n;
const WGPUBufferUsage_Uniform = 0x0000000000000040n;
const WGPUBufferUsage_Storage = 0x0000000000000080n;
const WGPUBufferUsage_Indirect = 0x0000000000000100n;
const WGPUBufferUsage_QueryResolve = 0x0000000000000200n;
const WGPUColorWriteMask_All = 0x000000000000000F;
const WGPUBlendOperation_Add = 0x00000001;
const WGPUBlendFactor_One = 0x00000002;
const WGPUBlendFactor_Zero = 0x00000001;
const WGPUBlendFactor_SrcAlpha = 0x00000005;
const WGPUBlendFactor_OneMinusSrcAlpha = 0x00000006;
const WGPUShaderStage_Vertex = 0x0000000000000001;
const WGPUShaderStage_Fragment = 0x0000000000000002;
const WGPUShaderStage_Compute = 0x0000000000000004;
const WGPUBufferBindingType_Uniform = 0x00000002;
const WGPUBufferBindingType_Storage = 0x00000003;
const WGPUBufferBindingType_ReadOnlyStorage = 0x00000004;
const WGPUSamplerBindingType_Filtering = 0x00000002;
const WGPUSamplerBindingType_NonFiltering = 0x00000003;
const WGPUSamplerBindingType_Comparison = 0x00000004;
const WGPUTextureSampleType_Float = 0x00000002;
const WGPUTextureSampleType_UnfilterableFloat = 0x00000003;
const WGPUTextureSampleType_Depth = 0x00000004;
const WGPUTextureSampleType_Sint = 0x00000005;
const WGPUTextureSampleType_Uint = 0x00000006;
const WGPUStorageTextureAccess_WriteOnly = 0x00000002;
const WGPUStorageTextureAccess_ReadOnly = 0x00000003;
const WGPUStorageTextureAccess_ReadWrite = 0x00000004;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;

const WGPU_KEEPALIVE: any[] = [];
let LAST_SURFACE_PTR: number | null = null;

function toBigInt(value: unknown, fallback = 0n) {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isFinite(value)) {
		return BigInt(Math.trunc(value));
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (/^(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) {
			return BigInt(trimmed);
		}
	}
	return fallback;
}

function writePtr(view: DataView, offset: number, value: number | bigint | null) {
	view.setBigUint64(offset, toBigInt(value ?? 0), true);
}

function writeU32(view: DataView, offset: number, value: number | bigint) {
	view.setUint32(offset, Number(value) >>> 0, true);
}

function writeU64(view: DataView, offset: number, value: bigint | number | string) {
	view.setBigUint64(offset, toBigInt(value), true);
}

function writeF32(view: DataView, offset: number, value: number) {
	view.setFloat32(offset, value, true);
}

function writeF64(view: DataView, offset: number, value: number) {
	view.setFloat64(offset, value, true);
}

function makeStringView(str?: string | null) {
	if (!str) {
		return { ptr: 0, len: 0n, cstr: null };
	}
	const cstr = new CString(str);
	WGPU_KEEPALIVE.push(cstr);
	return { ptr: cstr.ptr, len: WGPU_STRLEN, cstr };
}

function makeSurfaceSourceMetalLayer(layerPtr: number) {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUSType_SurfaceSourceMetalLayer);
	writeU32(view, 12, 0);
	writePtr(view, 16, layerPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeSurfaceDescriptor(nextInChainPtr: number) {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writePtr(view, 0, nextInChainPtr);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	return { buffer, ptr: ptr(buffer) };
}

function makeSurfaceConfiguration(
	devicePtr: number,
	width: number,
	height: number,
	format: number,
	alphaMode: number,
	usage: bigint = WGPUTextureUsage_RenderAttachment,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, devicePtr);
	writeU32(view, 16, format);
	writeU32(view, 20, 0);
	writeU64(view, 24, usage);
	writeU32(view, 32, width);
	writeU32(view, 36, height);
	writeU64(view, 40, 0n);
	writePtr(view, 48, 0);
	writeU32(view, 56, alphaMode);
	writeU32(view, 60, WGPUPresentMode_Fifo);
	return { buffer, ptr: ptr(buffer) };
}

function makeBufferDescriptor(
	size: number,
	usage: bigint,
	mappedAtCreation: boolean,
) {
	const buffer = new ArrayBuffer(48);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, usage);
	writeU64(view, 32, BigInt(size));
	writeU32(view, 40, mappedAtCreation ? 1 : 0);
	writeU32(view, 44, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeTextureDescriptor(
	width: number,
	height: number,
	depthOrArrayLayers: number,
	format: number,
	usage: bigint,
	mipLevelCount = 1,
	sampleCount = 1,
	viewFormatsPtr: number | null = null,
	viewFormatCount = 0,
) {
	const buffer = new ArrayBuffer(80);
	const view = new DataView(buffer);
	writePtr(view, 0, 0); // nextInChain
	writePtr(view, 8, 0); // label.ptr
	writeU64(view, 16, 0n); // label.length
	writeU64(view, 24, usage);
	writeU32(view, 32, WGPUTextureDimension_2D);
	writeU32(view, 36, width);
	writeU32(view, 40, height);
	writeU32(view, 44, depthOrArrayLayers);
	writeU32(view, 48, format);
	writeU32(view, 52, mipLevelCount);
	writeU32(view, 56, sampleCount);
	writeU32(view, 60, 0); // padding for size_t alignment
	writeU64(view, 64, BigInt(viewFormatCount));
	writePtr(view, 72, viewFormatsPtr ?? 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeTextureViewDescriptor(options?: {
	format?: number;
	dimension?: number;
	baseMipLevel?: number;
	mipLevelCount?: number;
	baseArrayLayer?: number;
	arrayLayerCount?: number;
	aspect?: number;
	usage?: bigint;
}) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU32(view, 24, options?.format ?? 0);
	writeU32(view, 28, options?.dimension ?? 0);
	writeU32(view, 32, options?.baseMipLevel ?? 0);
	writeU32(view, 36, options?.mipLevelCount ?? 0xffffffff);
	writeU32(view, 40, options?.baseArrayLayer ?? 0);
	writeU32(view, 44, options?.arrayLayerCount ?? 0xffffffff);
	writeU32(view, 48, options?.aspect ?? 0);
	writeU32(view, 52, 0);
	writeU64(view, 56, options?.usage ?? 0n);
	return { buffer, ptr: ptr(buffer) };
}

function makeSamplerDescriptor(options?: {
	addressModeU?: number;
	addressModeV?: number;
	addressModeW?: number;
	magFilter?: number;
	minFilter?: number;
	mipmapFilter?: number;
	lodMinClamp?: number;
	lodMaxClamp?: number;
	compare?: number;
	maxAnisotropy?: number;
}) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU32(view, 24, options?.addressModeU ?? WGPUAddressMode_ClampToEdge);
	writeU32(view, 28, options?.addressModeV ?? WGPUAddressMode_ClampToEdge);
	writeU32(view, 32, options?.addressModeW ?? WGPUAddressMode_ClampToEdge);
	writeU32(view, 36, options?.magFilter ?? WGPUFilterMode_Linear);
	writeU32(view, 40, options?.minFilter ?? WGPUFilterMode_Linear);
	writeU32(view, 44, options?.mipmapFilter ?? WGPUMipmapFilterMode_Linear);
	writeF32(view, 48, options?.lodMinClamp ?? 0);
	writeF32(view, 52, options?.lodMaxClamp ?? 32);
	writeU32(view, 56, options?.compare ?? 0);
	view.setUint16(60, options?.maxAnisotropy ?? 1, true);
	view.setUint16(62, 0, true);
	return { buffer, ptr: ptr(buffer) };
}

function makeVertexAttribute(
	offset: number,
	shaderLocation: number,
	format: number,
) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, format);
	writeU32(view, 12, 0);
	writeU64(view, 16, BigInt(offset));
	writeU32(view, 24, shaderLocation);
	writeU32(view, 28, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeVertexBufferLayout(
	attributePtr: number,
	attributeCount: number,
	arrayStride: bigint,
	stepMode: number,
) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, stepMode);
	writeU32(view, 12, 0);
	writeU64(view, 16, arrayStride);
	writeU64(view, 24, BigInt(attributeCount));
	writePtr(view, 32, attributePtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeVertexState(
	modulePtr: number,
	entryPoint: { ptr: number; len: bigint },
	bufferLayoutPtr: number,
	bufferLayoutCount: number,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPoint.ptr);
	writeU64(view, 24, entryPoint.len);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, BigInt(bufferLayoutCount));
	writePtr(view, 56, bufferLayoutPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeFragmentState(
	modulePtr: number,
	entryPoint: { ptr: number; len: bigint },
	targetPtr: number,
	targetCount: number,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPoint.ptr);
	writeU64(view, 24, entryPoint.len);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, BigInt(targetCount));
	writePtr(view, 56, targetPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeColorTargetState(
	format: number,
	blendPtr: number | null,
	writeMask = WGPUColorWriteMask_All,
) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, format);
	writeU32(view, 12, 0);
	writePtr(view, 16, blendPtr ?? 0);
	writeU64(view, 24, BigInt(writeMask));
	return { buffer, ptr: ptr(buffer) };
}

function makeBlendComponent(
	operation: number,
	srcFactor: number,
	dstFactor: number,
) {
	const buffer = new ArrayBuffer(12);
	const view = new DataView(buffer);
	writeU32(view, 0, operation);
	writeU32(view, 4, srcFactor);
	writeU32(view, 8, dstFactor);
	return { buffer, ptr: ptr(buffer) };
}

function makeBlendState(color: ArrayBuffer, alpha: ArrayBuffer) {
	const buffer = new ArrayBuffer(24);
	new Uint8Array(buffer, 0, 12).set(new Uint8Array(color, 0, 12));
	new Uint8Array(buffer, 12, 12).set(new Uint8Array(alpha, 0, 12));
	return { buffer, ptr: ptr(buffer) };
}

function makePrimitiveState(options?: {
	topology?: number;
	stripIndexFormat?: number;
	frontFace?: number;
	cullMode?: number;
	unclippedDepth?: number;
}) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, options?.topology ?? WGPUPrimitiveTopology_TriangleList);
	writeU32(view, 12, options?.stripIndexFormat ?? 0);
	writeU32(view, 16, options?.frontFace ?? WGPUFrontFace_CCW);
	writeU32(view, 20, options?.cullMode ?? WGPUCullMode_None);
	writeU32(view, 24, options?.unclippedDepth ?? 0);
	writeU32(view, 28, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeMultisampleState(options?: {
	count?: number;
	mask?: number;
	alphaToCoverageEnabled?: boolean;
}) {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, options?.count ?? 1);
	writeU32(view, 12, options?.mask ?? 0xffffffff);
	writeU32(view, 16, options?.alphaToCoverageEnabled ? 1 : 0);
	writeU32(view, 20, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeDepthStencilState(options?: {
	format?: number;
	depthWriteEnabled?: boolean;
	depthCompare?: number;
	stencilReadMask?: number;
	stencilWriteMask?: number;
	depthBias?: number;
	depthBiasSlopeScale?: number;
	depthBiasClamp?: number;
}) {
	const buffer = new ArrayBuffer(72);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, options?.format ?? 0);
	writeU32(view, 12, options?.depthWriteEnabled ? 1 : 0);
	writeU32(view, 16, options?.depthCompare ?? 0);
	writeU32(view, 20, 0); // stencilFront.compare
	writeU32(view, 24, 0); // stencilFront.failOp
	writeU32(view, 28, 0); // stencilFront.depthFailOp
	writeU32(view, 32, 0); // stencilFront.passOp
	writeU32(view, 36, 0); // stencilBack.compare
	writeU32(view, 40, 0); // stencilBack.failOp
	writeU32(view, 44, 0); // stencilBack.depthFailOp
	writeU32(view, 48, 0); // stencilBack.passOp
	writeU32(view, 52, options?.stencilReadMask ?? 0xffffffff);
	writeU32(view, 56, options?.stencilWriteMask ?? 0xffffffff);
	view.setInt32(60, options?.depthBias ?? 0, true);
	writeF32(view, 64, options?.depthBiasSlopeScale ?? 0);
	writeF32(view, 68, options?.depthBiasClamp ?? 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeRenderPipelineDescriptor(
	layoutPtr: number | null,
	vertexStateBuffer: ArrayBuffer,
	primitiveStateBuffer: ArrayBuffer,
	depthStencilPtr: number | null,
	multisampleBuffer: ArrayBuffer,
	fragmentStatePtr: number | null,
) {
	const buffer = new ArrayBuffer(168);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writePtr(view, 24, layoutPtr ?? 0);
	new Uint8Array(buffer, 32, 64).set(new Uint8Array(vertexStateBuffer, 0, 64));
	new Uint8Array(buffer, 96, 32).set(new Uint8Array(primitiveStateBuffer, 0, 32));
	writePtr(view, 128, depthStencilPtr ?? 0);
	new Uint8Array(buffer, 136, 24).set(new Uint8Array(multisampleBuffer, 0, 24));
	writePtr(view, 160, fragmentStatePtr ?? 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupLayoutEntry(entry: {
	binding: number;
	visibility: number;
	bindingArraySize?: number;
	buffer?: { type?: number; hasDynamicOffset?: boolean; minBindingSize?: number };
	sampler?: { type?: number };
	texture?: { sampleType?: number; viewDimension?: number; multisampled?: boolean };
	storageTexture?: { access?: number; format?: number; viewDimension?: number };
}) {
	const buffer = new ArrayBuffer(120);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, entry.binding);
	writeU32(view, 16, entry.visibility);
	writeU32(view, 24, entry.bindingArraySize ?? 0);

	// BufferBindingLayout at 32
	writePtr(view, 32, 0);
	writeU32(view, 40, entry.buffer?.type ?? 0);
	writeU32(view, 44, entry.buffer?.hasDynamicOffset ? 1 : 0);
	writeU64(view, 48, entry.buffer?.minBindingSize ?? 0);

	// SamplerBindingLayout at 56
	writePtr(view, 56, 0);
	writeU32(view, 64, entry.sampler?.type ?? 0);

	// TextureBindingLayout at 72
	writePtr(view, 72, 0);
	writeU32(view, 80, entry.texture?.sampleType ?? 0);
	writeU32(view, 84, entry.texture?.viewDimension ?? 0);
	writeU32(view, 88, entry.texture?.multisampled ? 1 : 0);

	// StorageTextureBindingLayout at 96
	writePtr(view, 96, 0);
	writeU32(view, 104, entry.storageTexture?.access ?? 0);
	writeU32(view, 108, entry.storageTexture?.format ?? 0);
	writeU32(view, 112, entry.storageTexture?.viewDimension ?? 0);

	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupLayoutDescriptor(entriesPtr: number, count: number) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, BigInt(count));
	writePtr(view, 32, entriesPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupEntry(entry: {
	binding: number;
	buffer?: { buffer: GPUBuffer; offset?: number; size?: number };
	sampler?: GPUSampler;
	textureView?: GPUTextureView;
}) {
	const buffer = new ArrayBuffer(56);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, entry.binding);
	writeU32(view, 12, 0);
	writePtr(view, 16, entry.buffer ? entry.buffer.buffer.ptr : 0);
	writeU64(view, 24, BigInt(entry.buffer?.offset ?? 0));
	const sizeValue =
		entry.buffer?.size ?? 0xffffffffffffffffn;
	writeU64(view, 32, toBigInt(sizeValue, 0xffffffffffffffffn));
	writePtr(view, 40, entry.sampler ? entry.sampler.ptr : 0);
	writePtr(view, 48, entry.textureView ? entry.textureView.ptr : 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupDescriptor(
	layoutPtr: number,
	entriesPtr: number,
	count: number,
) {
	const buffer = new ArrayBuffer(48);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writePtr(view, 24, layoutPtr);
	writeU64(view, 32, BigInt(count));
	writePtr(view, 40, entriesPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makePipelineLayoutDescriptor(layoutsPtr: number, count: number) {
	const buffer = new ArrayBuffer(48);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, BigInt(count));
	writePtr(view, 32, layoutsPtr);
	writeU32(view, 40, 0);
	writeU32(view, 44, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeCommandEncoderDescriptor() {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	return { buffer, ptr: ptr(buffer) };
}

function makeSurfaceTexture() {
	const buffer = new ArrayBuffer(24);
	return { buffer, view: new DataView(buffer), ptr: ptr(buffer) };
}

function makeRenderPassColorAttachment(
	viewPtr: number,
	resolveTargetPtr: number | null,
	clear = { r: 0, g: 0, b: 0, a: 1 },
	loadOp = WGPULoadOp_Clear,
	storeOp = WGPUStoreOp_Store,
) {
	const buffer = new ArrayBuffer(72);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, viewPtr);
	writeU32(view, 16, WGPU_DEPTH_SLICE_UNDEFINED);
	writeU32(view, 20, 0);
	writePtr(view, 24, resolveTargetPtr ?? 0);
	writeU32(view, 32, loadOp);
	writeU32(view, 36, storeOp);
	writeF64(view, 40, clear.r);
	writeF64(view, 48, clear.g);
	writeF64(view, 56, clear.b);
	writeF64(view, 64, clear.a);
	return { buffer, ptr: ptr(buffer) };
}

function makeRenderPassDepthStencilAttachment(options: {
	view: number;
	depthLoadOp: number;
	depthStoreOp: number;
	depthClearValue: number;
	depthReadOnly?: boolean;
	stencilLoadOp: number;
	stencilStoreOp: number;
	stencilClearValue: number;
	stencilReadOnly?: boolean;
}) {
	const buffer = new ArrayBuffer(48);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, options.view);
	writeU32(view, 16, options.depthLoadOp);
	writeU32(view, 20, options.depthStoreOp);
	writeF32(view, 24, options.depthClearValue);
	writeU32(view, 28, options.depthReadOnly ? 1 : 0);
	writeU32(view, 32, options.stencilLoadOp);
	writeU32(view, 36, options.stencilStoreOp);
	writeU32(view, 40, options.stencilClearValue);
	writeU32(view, 44, options.stencilReadOnly ? 1 : 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeRenderPassDescriptor(
	colorAttachmentsPtr: number,
	colorAttachmentCount: number,
	depthStencilPtr: number | null,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, BigInt(colorAttachmentCount));
	writePtr(view, 32, colorAttachmentsPtr);
	writePtr(view, 40, depthStencilPtr ?? 0);
	writePtr(view, 48, 0);
	writePtr(view, 56, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeCommandBufferArray(cmdPtr: number) {
	const buffer = new BigUint64Array(1);
	buffer[0] = BigInt(cmdPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeSurfaceTexture() {
	const buffer = new ArrayBuffer(24);
	return { buffer, view: new DataView(buffer), ptr: ptr(buffer) };
}

function makeSurfaceCapabilities() {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU64(view, 8, 0n);
	writeU64(view, 16, 0n);
	writePtr(view, 24, 0);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, 0n);
	writePtr(view, 56, 0);
	return { buffer, view, ptr: ptr(buffer) };
}

function readU64(view: DataView, offset: number) {
	return Number(view.getBigUint64(offset, true));
}

function readPtr(view: DataView, offset: number) {
	const val = view.getBigUint64(offset, true);
	return val === 0n ? 0 : Number(val);
}

function pickSurfaceFormatAlpha(capsView: DataView, preferredFormat: number) {
	const formatCount = readU64(capsView, 16);
	const formatPtr = readPtr(capsView, 24);
	let format = preferredFormat;
	if (formatCount && formatPtr) {
		const formats = new Uint32Array(
			(ptr as any)(formatPtr).buffer,
			(ptr as any)(formatPtr).byteOffset,
			formatCount,
		);
		if (formats.length) {
			format = formats[0]!;
		}
	}

	const alphaCount = readU64(capsView, 48);
	const alphaPtr = readPtr(capsView, 56);
	let alphaMode = WGPUCompositeAlphaMode_Opaque;
	if (alphaCount && alphaPtr) {
		const alphas = new Uint32Array(
			(ptr as any)(alphaPtr).buffer,
			(ptr as any)(alphaPtr).byteOffset,
			alphaCount,
		);
		if (alphas.length) {
			alphaMode = alphas[0]!;
		}
	}

	return { format, alphaMode };
}

class GPUTexture {
	ptr: number;
	format?: number;
	constructor(ptr: number, format?: number) {
		this.ptr = ptr;
		this.format = format;
	}
	createView(descriptor?: {
		format?: string;
		dimension?: string;
		baseMipLevel?: number;
		mipLevelCount?: number;
		baseArrayLayer?: number;
		arrayLayerCount?: number;
		aspect?: string;
		usage?: number;
	}) {
		let descPtr = 0;
		if (descriptor) {
			let format = mapTextureFormat(descriptor.format) ?? 0;
			const baseFormat =
				this.format ?? WGPUNative.symbols.wgpuTextureGetFormat(this.ptr);
			if (isDepthFormat(baseFormat) && !isDepthFormat(format)) {
				format = 0;
			}
			const desc = makeTextureViewDescriptor({
				format,
				dimension: mapTextureViewDimension(descriptor.dimension) ?? 0,
				baseMipLevel: descriptor.baseMipLevel ?? 0,
				mipLevelCount:
					descriptor.mipLevelCount ?? 0xffffffff,
				baseArrayLayer: descriptor.baseArrayLayer ?? 0,
				arrayLayerCount:
					descriptor.arrayLayerCount ?? 0xffffffff,
				aspect: mapTextureAspect(descriptor.aspect) ?? 0,
				usage: toBigInt(descriptor.usage ?? 0),
			});
			WGPU_KEEPALIVE.push(desc.buffer);
			descPtr = desc.ptr as any;
		}
		const view = WGPUNative.symbols.wgpuTextureCreateView(
			this.ptr,
			descPtr,
		);
		return new GPUTextureView(view, this.format);
	}
	destroy() {
		WGPUNative.symbols.wgpuTextureDestroy(this.ptr);
	}
}

class GPUTextureView {
	ptr: number;
	format?: number;
	constructor(ptr: number, format?: number) {
		this.ptr = ptr;
		this.format = format;
	}
}

class GPUQueue {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
	submit(commandBuffers: GPUCommandBuffer[]) {
		const buffer = new BigUint64Array(commandBuffers.length);
		for (let i = 0; i < commandBuffers.length; i += 1) {
			buffer[i] = BigInt(commandBuffers[i]!.ptr);
		}
		WGPU_KEEPALIVE.push(buffer);
		WGPUNative.symbols.wgpuQueueSubmit(
			this.ptr,
			BigInt(commandBuffers.length) as any,
			ptr(buffer),
		);
		if (LAST_SURFACE_PTR) {
			WGPUBridge.surfacePresent(LAST_SURFACE_PTR as any);
		}
	}
	writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView) {
		WGPUNative.symbols.wgpuQueueWriteBuffer(
			this.ptr,
			buffer.ptr,
			BigInt(offset),
			ptr(data),
			data.byteLength,
		);
	}
	writeTexture(
		destination: { texture: GPUTexture; mipLevel?: number; origin?: { x?: number; y?: number; z?: number } },
		data: ArrayBufferView,
		dataLayout: { bytesPerRow: number; rowsPerImage?: number },
		size: { width: number; height: number; depthOrArrayLayers?: number },
	) {
		let bytesPerPixel = bytesPerPixelForFormat(destination.texture.format);
		let width =
			Number.isFinite(size.width) && size.width > 0
				? size.width
				: Math.max(
						1,
						Math.floor(
							(dataLayout.bytesPerRow ?? data.byteLength) / bytesPerPixel,
						),
				  );
		let height =
			Number.isFinite(size.height) && size.height > 0
				? size.height
				: Math.max(1, dataLayout.rowsPerImage ?? 1);
		const layers = size.depthOrArrayLayers ?? 1;
		const inferredBpp = Math.floor(
			data.byteLength / Math.max(1, width * height * layers),
		);
		if (inferredBpp > bytesPerPixel) {
			bytesPerPixel = inferredBpp;
		}
		const exactRGBABytes = width * height * layers * 4;
		if (data.byteLength === exactRGBABytes) {
			bytesPerPixel = 4;
		}
		let minBytesPerRow = Math.max(1, width * bytesPerPixel);
		const minExpectedSize = minBytesPerRow * height * layers;
		if (data.byteLength > minExpectedSize && height > 0) {
			const widthFromData = Math.floor(
				data.byteLength / Math.max(1, height * layers * bytesPerPixel),
			);
			if (widthFromData > width) {
				width = widthFromData;
				minBytesPerRow = Math.max(1, width * bytesPerPixel);
			}
		}
		let bytesPerRow = dataLayout.bytesPerRow ?? minBytesPerRow;
		if (bytesPerRow < minBytesPerRow) bytesPerRow = minBytesPerRow;
		const derivedRowBytes = Math.ceil(
			data.byteLength / Math.max(1, height * layers),
		);
		if (bytesPerRow < derivedRowBytes) {
			bytesPerRow = derivedRowBytes;
		}
		let rowsPerImage = dataLayout.rowsPerImage ?? height;
		if (rowsPerImage === 0) rowsPerImage = height;

		let writeData = data;
		const needsPadding = bytesPerRow % 256 !== 0;
		if (needsPadding) {
			const aligned = alignTo(bytesPerRow, 256);
			const srcStride = Math.max(
				minBytesPerRow,
				dataLayout.bytesPerRow ?? minBytesPerRow,
			);
			writeData = repackTextureData(
				data,
				srcStride,
				aligned,
				minBytesPerRow,
				height,
				rowsPerImage,
				layers,
			);
			bytesPerRow = aligned;
		}

		const texInfo = makeTexelCopyTextureInfo(
			destination.texture.ptr,
			destination.mipLevel ?? 0,
			destination.origin ?? {},
		);
		const layout = makeTexelCopyBufferLayout(
			(dataLayout as { offset?: number }).offset ?? 0,
			bytesPerRow,
			rowsPerImage,
		);
		const extent = makeExtent3D(
			width,
			height,
			layers,
		);
		WGPU_KEEPALIVE.push(texInfo.buffer, layout.buffer, extent.buffer);
		WGPUNative.symbols.wgpuQueueWriteTexture(
			this.ptr,
			texInfo.ptr as any,
			ptr(writeData),
			writeData.byteLength,
			layout.ptr as any,
			extent.ptr as any,
		);
	}
	onSubmittedWorkDone() {
		return Promise.resolve();
	}
}

class GPUDevice {
	ptr: number;
	queue: GPUQueue;
	features = new Set<string>();
	limits: Record<string, number> = {};
	_uncapturedErrorListeners: ((event: { error: Error }) => void)[] = [];
	constructor(ptr: number) {
		this.ptr = ptr;
		this.queue = new GPUQueue(WGPUNative.symbols.wgpuDeviceGetQueue(ptr));
	}
	createBuffer(descriptor: { size: number; usage: number; mappedAtCreation?: boolean }) {
		let usage = toBigInt(descriptor.usage ?? 0);
		const desc = makeBufferDescriptor(
			descriptor.size,
			usage,
			!!descriptor.mappedAtCreation,
		);
		WGPU_KEEPALIVE.push(desc.buffer);
		const bufferPtr = WGPUNative.symbols.wgpuDeviceCreateBuffer(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUBuffer(
			bufferPtr,
			descriptor.size,
			usage,
			this,
			!!descriptor.mappedAtCreation,
		);
	}
	createTexture(descriptor: {
		size: { width: number; height: number; depthOrArrayLayers?: number };
		format: string;
		usage: number;
		mipLevelCount?: number;
		sampleCount?: number;
		viewFormats?: string[];
	}) {
		const mappedFormat =
			mapTextureFormat(descriptor.format) ?? WGPUTextureFormat_BGRA8Unorm;
		const rawSample = Number(descriptor.sampleCount ?? 1);
		let sampleCount = Number.isFinite(rawSample) ? rawSample : 1;
		if (sampleCount > 1 && isIntegerFormat(mappedFormat)) {
			sampleCount = 1;
		}
		let viewFormatsPtr: number | null = null;
		let viewFormatCount = 0;
		if (descriptor.viewFormats && descriptor.viewFormats.length) {
			const arr = new Uint32Array(descriptor.viewFormats.length);
			descriptor.viewFormats.forEach((f, i) => {
				arr[i] = mapTextureFormat(f) ?? 0;
			});
			WGPU_KEEPALIVE.push(arr);
			viewFormatsPtr = ptr(arr) as any;
			viewFormatCount = descriptor.viewFormats.length;
		}
		const desc = makeTextureDescriptor(
			descriptor.size.width,
			descriptor.size.height,
			descriptor.size.depthOrArrayLayers ?? 1,
			mappedFormat,
			toBigInt(descriptor.usage ?? 0),
			descriptor.mipLevelCount ?? 1,
			sampleCount,
			viewFormatsPtr,
			viewFormatCount,
		);
		WGPU_KEEPALIVE.push(desc.buffer);
		const texPtr = WGPUNative.symbols.wgpuDeviceCreateTexture(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUTexture(texPtr, mappedFormat);
	}
	createSampler(descriptor?: {
		addressModeU?: string;
		addressModeV?: string;
		addressModeW?: string;
		magFilter?: string;
		minFilter?: string;
		mipmapFilter?: string;
		lodMinClamp?: number;
		lodMaxClamp?: number;
		compare?: string;
		maxAnisotropy?: number;
	}) {
		const desc = makeSamplerDescriptor({
			addressModeU: mapAddressMode(descriptor?.addressModeU),
			addressModeV: mapAddressMode(descriptor?.addressModeV),
			addressModeW: mapAddressMode(descriptor?.addressModeW),
			magFilter: mapFilterMode(descriptor?.magFilter),
			minFilter: mapFilterMode(descriptor?.minFilter),
			mipmapFilter: mapMipmapFilterMode(descriptor?.mipmapFilter),
			lodMinClamp: descriptor?.lodMinClamp,
			lodMaxClamp: descriptor?.lodMaxClamp,
			compare: mapCompareFunction(descriptor?.compare),
			maxAnisotropy: descriptor?.maxAnisotropy,
		});
		WGPU_KEEPALIVE.push(desc.buffer);
		const samplerPtr = WGPUNative.symbols.wgpuDeviceCreateSampler(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUSampler(samplerPtr);
	}
	createBindGroupLayout(descriptor: { entries: any[] }) {
		const entries = descriptor.entries.map((entry) => {
			const hasBindingKind =
				!!entry.buffer ||
				!!entry.sampler ||
				!!entry.texture ||
				!!entry.storageTexture;
			const normalized = hasBindingKind
				? entry
				: {
						...entry,
						buffer: { type: "uniform" },
				  };
			const bindingEntry = makeBindGroupLayoutEntry({
				binding: normalized.binding ?? 0,
				visibility: mapShaderStage(normalized.visibility) ?? 0,
				bindingArraySize: normalized.bindingArraySize ?? 0,
				buffer: normalized.buffer
					? {
							type: mapBufferBindingType(normalized.buffer.type),
							hasDynamicOffset: !!normalized.buffer.hasDynamicOffset,
							minBindingSize: normalized.buffer.minBindingSize ?? 0,
					  }
					: undefined,
				sampler: normalized.sampler
					? { type: mapSamplerBindingType(normalized.sampler.type) }
					: undefined,
				texture: normalized.texture
					? {
							sampleType: mapTextureSampleType(normalized.texture.sampleType),
							viewDimension: mapTextureViewDimension(
								normalized.texture.viewDimension,
							),
							multisampled: !!normalized.texture.multisampled,
					  }
					: undefined,
				storageTexture: normalized.storageTexture
					? {
							access: mapStorageTextureAccess(
								normalized.storageTexture.access,
							),
							format: mapTextureFormat(normalized.storageTexture.format),
							viewDimension: mapTextureViewDimension(
								normalized.storageTexture.viewDimension,
							),
					  }
					: undefined,
			});
			WGPU_KEEPALIVE.push(bindingEntry.buffer);
			return bindingEntry;
		});
		const entryBuf = new ArrayBuffer(entries.length * 120);
		entries.forEach((entry, i) => {
			new Uint8Array(entryBuf, i * 120, 120).set(
				new Uint8Array(entry.buffer),
			);
		});
		const entryPtr = ptr(entryBuf);
		WGPU_KEEPALIVE.push(entryBuf);
		const desc = makeBindGroupLayoutDescriptor(
			entryPtr as any,
			entries.length,
		);
		WGPU_KEEPALIVE.push(desc.buffer);
		const layoutPtr = WGPUNative.symbols.wgpuDeviceCreateBindGroupLayout(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUBindGroupLayout(layoutPtr);
	}
	createBindGroup(descriptor: { layout: GPUBindGroupLayout; entries: any[] }) {
		const entries = descriptor.entries.map((entry) => {
			if (entry.resource?.buffer || entry.resource instanceof GPUBuffer) {
				const buffer = entry.resource.buffer ?? entry.resource;
				return makeBindGroupEntry({
					binding: entry.binding ?? 0,
					buffer: {
						buffer,
						offset: entry.resource.offset ?? 0,
						size: entry.resource.size ?? 0xffffffffffffffffn,
					},
				});
			}
			if (entry.resource instanceof GPUSampler) {
				return makeBindGroupEntry({
					binding: entry.binding ?? 0,
					sampler: entry.resource,
				});
			}
			if (entry.resource instanceof GPUTextureView) {
				return makeBindGroupEntry({
					binding: entry.binding ?? 0,
					textureView: entry.resource,
				});
			}
			if (entry.resource?.sampler) {
				return makeBindGroupEntry({
					binding: entry.binding ?? 0,
					sampler: entry.resource.sampler,
				});
			}
			if (entry.resource?.textureView) {
				return makeBindGroupEntry({
					binding: entry.binding ?? 0,
					textureView: entry.resource.textureView,
				});
			}
			return makeBindGroupEntry({ binding: entry.binding ?? 0 });
		});
		const entryBuf = new ArrayBuffer(entries.length * 56);
		entries.forEach((entry, i) => {
			new Uint8Array(entryBuf, i * 56, 56).set(
				new Uint8Array(entry.buffer),
			);
		});
		const entryPtr = ptr(entryBuf);
		WGPU_KEEPALIVE.push(entryBuf);
		const desc = makeBindGroupDescriptor(
			descriptor.layout.ptr,
			entryPtr as any,
			entries.length,
		);
		WGPU_KEEPALIVE.push(desc.buffer);
		const bindGroupPtr = WGPUNative.symbols.wgpuDeviceCreateBindGroup(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUBindGroup(bindGroupPtr);
	}
	createPipelineLayout(descriptor: { bindGroupLayouts: GPUBindGroupLayout[] }) {
		const layouts = new BigUint64Array(descriptor.bindGroupLayouts.length);
		for (let i = 0; i < layouts.length; i += 1) {
			layouts[i] = BigInt(descriptor.bindGroupLayouts[i]!.ptr);
		}
		WGPU_KEEPALIVE.push(layouts);
		const desc = makePipelineLayoutDescriptor(ptr(layouts) as any, layouts.length);
		WGPU_KEEPALIVE.push(desc.buffer);
		const layoutPtr = WGPUNative.symbols.wgpuDeviceCreatePipelineLayout(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUPipelineLayout(layoutPtr);
	}
	createShaderModule(descriptor: { code: string }) {
		const code = new TextEncoder().encode(descriptor.code + "\0");
		const codeBuf = new Uint8Array(code);
		WGPU_KEEPALIVE.push(codeBuf);
		const codePtr = ptr(codeBuf);
		const source = makeShaderSourceWGSL(codePtr as any, WGPU_STRLEN);
		const desc = makeShaderModuleDescriptor(source.ptr as any);
		WGPU_KEEPALIVE.push(source.buffer, desc.buffer);
		const modulePtr = WGPUNative.symbols.wgpuDeviceCreateShaderModule(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUShaderModule(modulePtr);
	}
	createRenderPipeline(descriptor: any) {
		const vertexModule = descriptor.vertex.module as GPUShaderModule;
		const vertexEntry = makeStringView(descriptor.vertex.entryPoint ?? "main");
		const vertexBuffers = descriptor.vertex.buffers ?? [];
		const vertexLayouts: ArrayBuffer[] = [];
		const vertexLayoutPtrs: number[] = [];
		for (const buf of vertexBuffers) {
			const attrs = buf.attributes ?? [];
			const attrBuf = new ArrayBuffer(attrs.length * 32);
			attrs.forEach((attr: any, idx: number) => {
				const format = mapVertexFormat(attr.format);
				const attrStruct = makeVertexAttribute(
					attr.offset ?? 0,
					attr.shaderLocation ?? 0,
					format,
				);
				new Uint8Array(attrBuf, idx * 32, 32).set(
					new Uint8Array(attrStruct.buffer),
				);
			});
			const attrPtr = ptr(attrBuf);
			WGPU_KEEPALIVE.push(attrBuf);
			const layout = makeVertexBufferLayout(
				attrPtr as any,
				attrs.length,
				BigInt(buf.arrayStride ?? 0),
				mapVertexStepMode(buf.stepMode),
			);
			WGPU_KEEPALIVE.push(layout.buffer);
			vertexLayouts.push(layout.buffer);
			vertexLayoutPtrs.push(layout.ptr as any);
		}

		const vertexLayoutsBuf = new ArrayBuffer(vertexLayouts.length * 40);
		vertexLayouts.forEach((layoutBuf, i) => {
			new Uint8Array(vertexLayoutsBuf, i * 40, 40).set(
				new Uint8Array(layoutBuf),
			);
		});
		const vertexLayoutsPtr = ptr(vertexLayoutsBuf);
		WGPU_KEEPALIVE.push(vertexLayoutsBuf);

		const vertexState = makeVertexState(
			vertexModule.ptr,
			{ ptr: vertexEntry.ptr as any, len: vertexEntry.len },
			vertexLayoutsPtr as any,
			vertexLayouts.length,
		);
		WGPU_KEEPALIVE.push(vertexState.buffer);

		let fragmentStatePtr: number | null = null;
		if (descriptor.fragment) {
			const fragModule = descriptor.fragment.module as GPUShaderModule;
			const fragEntry = makeStringView(descriptor.fragment.entryPoint ?? "main");
			const targets = descriptor.fragment.targets ?? [];
			const targetBuf = new ArrayBuffer(targets.length * 32);
			targets.forEach((t: any, i: number) => {
				let blendPtr: number | null = null;
				if (t.blend) {
					const colorComp = makeBlendComponent(
						mapBlendOperation(t.blend.color?.operation),
						mapBlendFactor(t.blend.color?.srcFactor),
						mapBlendFactor(t.blend.color?.dstFactor),
					);
					const alphaComp = makeBlendComponent(
						mapBlendOperation(t.blend.alpha?.operation),
						mapBlendFactor(t.blend.alpha?.srcFactor),
						mapBlendFactor(t.blend.alpha?.dstFactor),
					);
					const blend = makeBlendState(colorComp.buffer, alphaComp.buffer);
					WGPU_KEEPALIVE.push(colorComp.buffer, alphaComp.buffer, blend.buffer);
					blendPtr = blend.ptr as any;
				}
				const target = makeColorTargetState(
					mapTextureFormat(t.format) ?? WGPUTextureFormat_BGRA8Unorm,
					blendPtr,
					t.writeMask ?? WGPUColorWriteMask_All,
				);
				new Uint8Array(targetBuf, i * 32, 32).set(
					new Uint8Array(target.buffer),
				);
			});
			const targetPtr = ptr(targetBuf);
			WGPU_KEEPALIVE.push(targetBuf);
			const fragState = makeFragmentState(
				fragModule.ptr,
				{ ptr: fragEntry.ptr as any, len: fragEntry.len },
				targetPtr as any,
				targets.length,
			);
			WGPU_KEEPALIVE.push(fragState.buffer);
			fragmentStatePtr = fragState.ptr as any;
		}

		const primitive = makePrimitiveState({
			topology: mapPrimitiveTopology(descriptor.primitive?.topology),
			stripIndexFormat: mapIndexFormat(descriptor.primitive?.stripIndexFormat),
			frontFace: mapFrontFace(descriptor.primitive?.frontFace),
			cullMode: mapCullMode(descriptor.primitive?.cullMode),
			unclippedDepth: descriptor.primitive?.unclippedDepth ? 1 : 0,
		});
		WGPU_KEEPALIVE.push(primitive.buffer);

		let depthStencilPtr: number | null = null;
		if (descriptor.depthStencil) {
			const depth = makeDepthStencilState({
				format:
					mapTextureFormat(descriptor.depthStencil.format) ??
					WGPUTextureFormat_Depth24Plus,
				depthWriteEnabled: !!descriptor.depthStencil.depthWriteEnabled,
				depthCompare: mapCompareFunction(descriptor.depthStencil.depthCompare),
				stencilReadMask: descriptor.depthStencil.stencilReadMask ?? 0xffffffff,
				stencilWriteMask: descriptor.depthStencil.stencilWriteMask ?? 0xffffffff,
				depthBias: descriptor.depthStencil.depthBias ?? 0,
				depthBiasSlopeScale: descriptor.depthStencil.depthBiasSlopeScale ?? 0,
				depthBiasClamp: descriptor.depthStencil.depthBiasClamp ?? 0,
			});
			WGPU_KEEPALIVE.push(depth.buffer);
			depthStencilPtr = depth.ptr as any;
		}

		const multisample = makeMultisampleState({
			count: descriptor.multisample?.count ?? 1,
			mask: descriptor.multisample?.mask ?? 0xffffffff,
			alphaToCoverageEnabled: !!descriptor.multisample?.alphaToCoverageEnabled,
		});
		WGPU_KEEPALIVE.push(multisample.buffer);

		const pipelineDesc = makeRenderPipelineDescriptor(
			descriptor.layout && descriptor.layout !== "auto"
				? (descriptor.layout as GPUPipelineLayout).ptr
				: null,
			vertexState.buffer,
			primitive.buffer,
			depthStencilPtr,
			multisample.buffer,
			fragmentStatePtr,
		);
		WGPU_KEEPALIVE.push(pipelineDesc.buffer);

		const pipelinePtr = WGPUNative.symbols.wgpuDeviceCreateRenderPipeline(
			this.ptr,
			pipelineDesc.ptr as any,
		);
		return new GPURenderPipeline(pipelinePtr);
	}
	createCommandEncoder() {
		const desc = makeCommandEncoderDescriptor();
		WGPU_KEEPALIVE.push(desc.buffer);
		const encoderPtr = WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(
			this.ptr,
			desc.ptr as any,
		);
		return new GPUCommandEncoder(encoderPtr, this);
	}
	addEventListener(type: string, handler: (event: any) => void) {
		if (type !== "uncapturederror") return;
		this._uncapturedErrorListeners.push(handler);
	}
	pushErrorScope(_filter: any) {
		return;
	}
	popErrorScope() {
		return Promise.resolve(null);
	}
}

class GPUBuffer {
	ptr: number;
	size: number;
	usage: bigint;
	_device: GPUDevice;
	_mapped: boolean;
	constructor(ptr: number, size: number, usage: bigint, device: GPUDevice, mapped = false) {
		this.ptr = ptr;
		this.size = size;
		this.usage = usage;
		this._device = device;
		this._mapped = mapped;
	}
	getMappedRange(_offset = 0, _size?: number) {
		if (!this._mapped) {
			return new ArrayBuffer(0);
		}
		const size = Math.max(0, _size ?? this.size - _offset);
		const mapped = WGPUNative.symbols.wgpuBufferGetMappedRange(
			this.ptr,
			BigInt(_offset),
			BigInt(size),
		);
		return toArrayBuffer(mapped as any, 0, size);
	}
	mapAsync() {
		this._mapped = true;
		return Promise.resolve();
	}
	unmap() {
		WGPUNative.symbols.wgpuBufferUnmap(this.ptr);
		this._mapped = false;
	}
	destroy() {
		WGPUNative.symbols.wgpuBufferDestroy(this.ptr);
	}
}

class GPUSampler {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
}

class GPUBindGroupLayout {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
}

class GPUBindGroup {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
}

class GPUPipelineLayout {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
}

class GPUShaderModule {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
}

class GPURenderPipeline {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
	getBindGroupLayout(index: number) {
		const layoutPtr = WGPUNative.symbols.wgpuRenderPipelineGetBindGroupLayout(
			this.ptr,
			index,
		);
		return new GPUBindGroupLayout(layoutPtr);
	}
}

class GPUCommandBuffer {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
}

class GPUCommandEncoder {
	ptr: number;
	_device: GPUDevice;
	constructor(ptr: number, device: GPUDevice) {
		this.ptr = ptr;
		this._device = device;
	}
	beginRenderPass(descriptor: {
		colorAttachments: Array<{
			view: GPUTextureView;
			resolveTarget?: GPUTextureView | null;
			clearValue?: { r: number; g: number; b: number; a: number };
			loadOp?: string;
			storeOp?: string;
		}>;
		depthStencilAttachment?: {
			view: GPUTextureView;
			depthClearValue?: number;
			depthLoadOp?: string;
			depthStoreOp?: string;
			depthReadOnly?: boolean;
			stencilClearValue?: number;
			stencilLoadOp?: string;
			stencilStoreOp?: string;
			stencilReadOnly?: boolean;
		};
	}) {
		const colorAttachments = descriptor.colorAttachments.map((c) =>
			makeRenderPassColorAttachment(
				c.view.ptr,
				c.resolveTarget ? c.resolveTarget.ptr : null,
				c.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
				mapLoadOp(c.loadOp),
				mapStoreOp(c.storeOp),
			),
		);
		const colorBuf = new ArrayBuffer(colorAttachments.length * 72);
		colorAttachments.forEach((c, i) => {
			new Uint8Array(colorBuf, i * 72, 72).set(new Uint8Array(c.buffer));
		});
		const colorPtr = ptr(colorBuf);
		WGPU_KEEPALIVE.push(colorBuf);

		let depthPtr: number | null = null;
		if (descriptor.depthStencilAttachment) {
			const d = descriptor.depthStencilAttachment;
			const viewFormat = d.view.format ?? 0;
			if (viewFormat && !isDepthFormat(viewFormat)) {
				// Skip invalid depth/stencil view attachments.
			} else {
				const depth = makeRenderPassDepthStencilAttachment({
					view: d.view.ptr,
					depthLoadOp: mapLoadOp(d.depthLoadOp),
					depthStoreOp: mapStoreOp(d.depthStoreOp),
					depthClearValue: d.depthClearValue ?? 1,
					depthReadOnly: !!d.depthReadOnly,
					stencilLoadOp: mapLoadOp(d.stencilLoadOp),
					stencilStoreOp: mapStoreOp(d.stencilStoreOp),
					stencilClearValue: d.stencilClearValue ?? 0,
					stencilReadOnly: !!d.stencilReadOnly,
				});
				WGPU_KEEPALIVE.push(depth.buffer);
				depthPtr = depth.ptr as any;
			}
		}

		const passDesc = makeRenderPassDescriptor(
			colorPtr as any,
			colorAttachments.length,
			depthPtr,
		);
		WGPU_KEEPALIVE.push(passDesc.buffer);
		const passPtr = WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(
			this.ptr,
			passDesc.ptr as any,
		);
		return new GPURenderPassEncoder(passPtr);
	}
	copyBufferToTexture(
		source: {
			buffer: GPUBuffer;
			offset?: number;
			bytesPerRow?: number;
			rowsPerImage?: number;
		},
		destination: {
			texture: GPUTexture;
			mipLevel?: number;
			origin?: { x?: number; y?: number; z?: number };
		},
		size: { width: number; height: number; depthOrArrayLayers?: number },
	) {
		const offset = source.offset ?? 0;
		const mapped = source.buffer.getMappedRange(0, source.buffer.size);
		const data =
			offset > 0
				? new Uint8Array(mapped, offset)
				: new Uint8Array(mapped);
		this._device.queue.writeTexture(
			destination,
			data,
			{
				bytesPerRow: source.bytesPerRow ?? 0,
				rowsPerImage: source.rowsPerImage ?? 0,
			},
			size,
		);
	}
	finish() {
		const cmdPtr = WGPUNative.symbols.wgpuCommandEncoderFinish(this.ptr, 0);
		return new GPUCommandBuffer(cmdPtr);
	}
}

class GPURenderPassEncoder {
	ptr: number;
	constructor(ptr: number) {
		this.ptr = ptr;
	}
	setPipeline(pipeline: GPURenderPipeline) {
		WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(
			this.ptr,
			pipeline.ptr,
		);
	}
	setBindGroup(index: number, bindGroup: GPUBindGroup, offsets?: number[]) {
		let offsetsPtr = 0;
		let count = 0n;
		if (offsets && offsets.length) {
			const arr = new BigUint64Array(offsets.length);
			offsets.forEach((o, i) => {
				arr[i] = BigInt(o);
			});
			WGPU_KEEPALIVE.push(arr);
			offsetsPtr = ptr(arr) as any;
			count = BigInt(offsets.length);
		}
		WGPUNative.symbols.wgpuRenderPassEncoderSetBindGroup(
			this.ptr,
			index,
			bindGroup.ptr,
			count as any,
			offsetsPtr as any,
		);
	}
	setVertexBuffer(slot: number, buffer: GPUBuffer, offset = 0, size?: number) {
		WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(
			this.ptr,
			slot,
			buffer.ptr,
			BigInt(offset),
			BigInt(size ?? buffer.size),
		);
	}
	setIndexBuffer(buffer: GPUBuffer, indexFormat: string, offset = 0, size?: number) {
		const format = mapIndexFormat(indexFormat);
		WGPUNative.symbols.wgpuRenderPassEncoderSetIndexBuffer(
			this.ptr,
			buffer.ptr,
			format ?? 0,
			BigInt(offset),
			BigInt(size ?? buffer.size),
		);
	}
	setViewport(x: number, y: number, width: number, height: number, minDepth = 0, maxDepth = 1) {
		WGPUNative.symbols.wgpuRenderPassEncoderSetViewport(
			this.ptr,
			x,
			y,
			width,
			height,
			minDepth,
			maxDepth,
		);
	}
	setScissorRect(x: number, y: number, width: number, height: number) {
		WGPUNative.symbols.wgpuRenderPassEncoderSetScissorRect(
			this.ptr,
			x,
			y,
			width,
			height,
		);
	}
	draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0) {
		WGPUNative.symbols.wgpuRenderPassEncoderDraw(
			this.ptr,
			vertexCount,
			instanceCount,
			firstVertex,
			firstInstance,
		);
	}
	drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
		WGPUNative.symbols.wgpuRenderPassEncoderDrawIndexed(
			this.ptr,
			indexCount,
			instanceCount,
			firstIndex,
			baseVertex,
			firstInstance,
		);
	}
	end() {
		WGPUNative.symbols.wgpuRenderPassEncoderEnd(this.ptr);
	}
}

class GPUAdapter {
	instancePtr: number;
	surfacePtr: number;
	features = new Set<string>();
	limits: Record<string, number> = {};
	info: Record<string, string> = {};
	constructor(instancePtr: number, surfacePtr: number) {
		this.instancePtr = instancePtr;
		this.surfacePtr = surfacePtr;
	}
	async requestDevice() {
		const adapterDevice = new BigUint64Array(2);
		WGPUBridge.createAdapterDeviceMainThread(
			this.instancePtr as any,
			this.surfacePtr as any,
			ptr(adapterDevice),
		);
		const device = Number(adapterDevice[1]);
		return new GPUDevice(device);
	}
}

class GPUCanvasContext {
	surfacePtr: number;
	devicePtr: number | null = null;
	format: number = WGPUTextureFormat_BGRA8UnormSrgb;
	alphaMode: number = WGPUCompositeAlphaMode_Opaque;
	width = 1;
	height = 1;
	_fallbackSize?: { width: number; height: number };
	constructor(surfacePtr: number) {
		this.surfacePtr = surfacePtr;
	}
	configure(options: {
		device: GPUDevice;
		format?: number | string;
		alphaMode?: number | string;
		usage?: number;
		size?: { width: number; height: number };
	}) {
		if (!options.size && this._fallbackSize) {
			this.width = this._fallbackSize.width;
			this.height = this._fallbackSize.height;
		}
		this.devicePtr = options.device.ptr;
		if (options.format) {
			this.format =
				typeof options.format === "string"
					? mapTextureFormat(options.format) ?? this.format
					: options.format;
		}
		if (options.alphaMode) {
			this.alphaMode =
				typeof options.alphaMode === "string"
					? mapAlphaMode(options.alphaMode) ?? this.alphaMode
					: options.alphaMode;
		}
		if (options.size) {
			this.width = options.size.width;
			this.height = options.size.height;
		}
		const config = makeSurfaceConfiguration(
			this.devicePtr,
			this.width,
			this.height,
			this.format,
			this.alphaMode,
			toBigInt(options.usage ?? WGPUTextureUsage_RenderAttachment),
		);
		WGPUBridge.surfaceConfigure(this.surfacePtr as any, config.ptr as any);
	}
	getCurrentTexture() {
		const surfaceTexture = makeSurfaceTexture();
		WGPUBridge.surfaceGetCurrentTexture(
			this.surfacePtr as any,
			surfaceTexture.ptr as any,
		);
		const status = surfaceTexture.view.getUint32(16, true);
		if (status !== 1 && status !== 2) {
			throw new Error(`Surface status ${status}`);
		}
		const texPtr = Number(surfaceTexture.view.getBigUint64(8, true));
		LAST_SURFACE_PTR = this.surfacePtr;
		return new GPUTexture(texPtr, this.format);
	}
	present() {
		return WGPUBridge.surfacePresent(this.surfacePtr as any);
	}
	unconfigure() {
		return WGPUNative.symbols.wgpuSurfaceUnconfigure(this.surfacePtr as any);
	}
}

function getLayerHandle(view: WGPUView | GpuWindow) {
	if (view instanceof GpuWindow) return view.wgpuView.getNativeHandle();
	return view.getNativeHandle();
}

function createContext(view: WGPUView | GpuWindow) {
	const layerPtr = getLayerHandle(view);
	if (!layerPtr) throw new Error("WGPUView native handle not available");
	const instance = WGPUNative.symbols.wgpuCreateInstance(0);
	const metalLayerDesc = makeSurfaceSourceMetalLayer(layerPtr as number);
	const surfaceDesc = makeSurfaceDescriptor(metalLayerDesc.ptr as number);
	const surface = WGPUBridge.instanceCreateSurface(
		instance as Pointer,
		surfaceDesc.ptr as Pointer,
	);

	const caps = makeSurfaceCapabilities();
	WGPUNative.symbols.wgpuSurfaceGetCapabilities(
		surface as any,
		0,
		caps.ptr as any,
	);
	const pick = pickSurfaceFormatAlpha(caps.view, WGPUTextureFormat_BGRA8UnormSrgb);

	const ctx = new GPUCanvasContext(surface as unknown as number);
	ctx.format = pick.format;
	ctx.alphaMode = pick.alphaMode;
	try {
		if (view instanceof GpuWindow) {
			const size = view.getSize();
			ctx.width = size.width;
			ctx.height = size.height;
			ctx._fallbackSize = { width: size.width, height: size.height };
		}
	} catch {}

	return { instance: Number(instance), surface: Number(surface), context: ctx };
}

function mapTextureFormat(format?: string | number | null) {
	if (typeof format === "number") return format;
	switch (format) {
		case "r8unorm":
			return WGPUTextureFormat_R8Unorm;
		case "r8snorm":
			return WGPUTextureFormat_R8Snorm;
		case "r8uint":
			return WGPUTextureFormat_R8Uint;
		case "r8sint":
			return WGPUTextureFormat_R8Sint;
		case "rg8unorm":
			return WGPUTextureFormat_RG8Unorm;
		case "rg8snorm":
			return WGPUTextureFormat_RG8Snorm;
		case "rg8uint":
			return WGPUTextureFormat_RG8Uint;
		case "rg8sint":
			return WGPUTextureFormat_RG8Sint;
		case "bgra8unorm":
			return WGPUTextureFormat_BGRA8Unorm;
		case "bgra8unorm-srgb":
			return WGPUTextureFormat_BGRA8UnormSrgb;
		case "rgba8unorm":
			return WGPUTextureFormat_RGBA8Unorm;
		case "rgba8unorm-srgb":
			return WGPUTextureFormat_RGBA8UnormSrgb;
		case "rgba8snorm":
			return WGPUTextureFormat_RGBA8Snorm;
		case "rgba8uint":
			return WGPUTextureFormat_RGBA8Uint;
		case "rgba8sint":
			return WGPUTextureFormat_RGBA8Sint;
		case "r32float":
			return WGPUTextureFormat_R32Float;
		case "r32uint":
			return WGPUTextureFormat_R32Uint;
		case "r32sint":
			return WGPUTextureFormat_R32Sint;
		case "rg32float":
			return WGPUTextureFormat_RG32Float;
		case "rg32uint":
			return WGPUTextureFormat_RG32Uint;
		case "rg32sint":
			return WGPUTextureFormat_RG32Sint;
		case "rgba16float":
			return WGPUTextureFormat_RGBA16Float;
		case "rgba16uint":
			return WGPUTextureFormat_RGBA16Uint;
		case "rgba16sint":
			return WGPUTextureFormat_RGBA16Sint;
		case "rgba32uint":
			return WGPUTextureFormat_RGBA32Uint;
		case "rgba32sint":
			return WGPUTextureFormat_RGBA32Sint;
		case "depth24plus":
			return WGPUTextureFormat_Depth24Plus;
		case "depth24plus-stencil8":
			return WGPUTextureFormat_Depth24PlusStencil8;
		case "depth32float":
			return WGPUTextureFormat_Depth32Float;
		case "depth16unorm":
			return WGPUTextureFormat_Depth16Unorm;
		case "depth32float-stencil8":
			return WGPUTextureFormat_Depth32FloatStencil8;
		default:
			return undefined;
	}
}

function isIntegerFormat(format: number) {
	return (
		format === WGPUTextureFormat_R8Uint ||
		format === WGPUTextureFormat_R8Sint ||
		format === WGPUTextureFormat_RG8Uint ||
		format === WGPUTextureFormat_RG8Sint ||
		format === WGPUTextureFormat_RGBA8Uint ||
		format === WGPUTextureFormat_RGBA8Sint ||
		format === WGPUTextureFormat_R32Uint ||
		format === WGPUTextureFormat_R32Sint ||
		format === WGPUTextureFormat_RG32Uint ||
		format === WGPUTextureFormat_RG32Sint ||
		format === WGPUTextureFormat_RGBA16Uint ||
		format === WGPUTextureFormat_RGBA16Sint ||
		format === WGPUTextureFormat_RGBA32Uint ||
		format === WGPUTextureFormat_RGBA32Sint
	);
}

function isDepthFormat(format: number) {
	return (
		format === WGPUTextureFormat_Depth24Plus ||
		format === WGPUTextureFormat_Depth24PlusStencil8 ||
		format === WGPUTextureFormat_Depth32Float ||
		format === WGPUTextureFormat_Depth16Unorm ||
		format === WGPUTextureFormat_Depth32FloatStencil8
	);
}

function mapTextureViewDimension(dim?: string | number | null) {
	if (typeof dim === "number") return dim;
	switch (dim) {
		case "2d":
			return WGPUTextureViewDimension_2D;
		case "2d-array":
			return WGPUTextureViewDimension_2DArray;
		case "3d":
			return WGPUTextureViewDimension_3D;
		case "cube":
			return WGPUTextureViewDimension_Cube;
		case "cube-array":
			return WGPUTextureViewDimension_CubeArray;
		default:
			return undefined;
	}
}

function mapTextureAspect(aspect?: string | number | null) {
	if (typeof aspect === "number") return aspect;
	switch (aspect) {
		case "all":
			return WGPUTextureAspect_All;
		case "depth-only":
			return WGPUTextureAspect_DepthOnly;
		case "stencil-only":
			return WGPUTextureAspect_StencilOnly;
		default:
			return undefined;
	}
}

function mapVertexFormat(format?: string | number | null) {
	if (typeof format === "number") return format;
	switch (format) {
		case "float32":
			return WGPUVertexFormat_Float32;
		case "float32x2":
			return WGPUVertexFormat_Float32x2;
		case "float32x3":
			return WGPUVertexFormat_Float32x3;
		case "float32x4":
			return WGPUVertexFormat_Float32x4;
		case "uint32":
			return WGPUVertexFormat_Uint32;
		case "uint32x2":
			return WGPUVertexFormat_Uint32x2;
		case "uint32x3":
			return WGPUVertexFormat_Uint32x3;
		case "uint32x4":
			return WGPUVertexFormat_Uint32x4;
		case "sint32":
			return WGPUVertexFormat_Sint32;
		case "sint32x2":
			return WGPUVertexFormat_Sint32x2;
		case "sint32x3":
			return WGPUVertexFormat_Sint32x3;
		case "sint32x4":
			return WGPUVertexFormat_Sint32x4;
		default:
			return WGPUVertexFormat_Float32x3;
	}
}

function mapVertexStepMode(mode?: string | number | null) {
	if (typeof mode === "number") return mode;
	switch (mode) {
		case "instance":
			return WGPUVertexStepMode_Instance;
		case "vertex":
		default:
			return WGPUVertexStepMode_Vertex;
	}
}

function mapPrimitiveTopology(topology?: string | number | null) {
	if (typeof topology === "number") return topology;
	switch (topology) {
		case "point-list":
			return WGPUPrimitiveTopology_PointList;
		case "line-list":
			return WGPUPrimitiveTopology_LineList;
		case "line-strip":
			return WGPUPrimitiveTopology_LineStrip;
		case "triangle-strip":
			return WGPUPrimitiveTopology_TriangleStrip;
		case "triangle-list":
		default:
			return WGPUPrimitiveTopology_TriangleList;
	}
}

function mapFrontFace(face?: string | number | null) {
	if (typeof face === "number") return face;
	switch (face) {
		case "cw":
			return WGPUFrontFace_CW;
		case "ccw":
		default:
			return WGPUFrontFace_CCW;
	}
}

function mapCullMode(mode?: string | number | null) {
	if (typeof mode === "number") return mode;
	switch (mode) {
		case "front":
			return WGPUCullMode_Front;
		case "back":
			return WGPUCullMode_Back;
		case "none":
		default:
			return WGPUCullMode_None;
	}
}

function mapCompareFunction(fn?: string | number | null) {
	if (fn == null) return 0;
	if (typeof fn === "number") return fn;
	switch (fn) {
		case "never":
			return WGPUCompareFunction_Never;
		case "less":
			return WGPUCompareFunction_Less;
		case "equal":
			return WGPUCompareFunction_Equal;
		case "less-equal":
			return WGPUCompareFunction_LessEqual;
		case "greater":
			return WGPUCompareFunction_Greater;
		case "not-equal":
			return WGPUCompareFunction_NotEqual;
		case "greater-equal":
			return WGPUCompareFunction_GreaterEqual;
		case "always":
		default:
			return WGPUCompareFunction_Always;
	}
}

function mapAddressMode(mode?: string | number | null) {
	if (typeof mode === "number") return mode;
	switch (mode) {
		case "repeat":
			return WGPUAddressMode_Repeat;
		case "mirror-repeat":
			return WGPUAddressMode_MirrorRepeat;
		case "clamp-to-edge":
		default:
			return WGPUAddressMode_ClampToEdge;
	}
}

function mapFilterMode(mode?: string | number | null) {
	if (typeof mode === "number") return mode;
	switch (mode) {
		case "nearest":
			return WGPUFilterMode_Nearest;
		case "linear":
		default:
			return WGPUFilterMode_Linear;
	}
}

function mapMipmapFilterMode(mode?: string | number | null) {
	if (typeof mode === "number") return mode;
	switch (mode) {
		case "nearest":
			return WGPUMipmapFilterMode_Nearest;
		case "linear":
		default:
			return WGPUMipmapFilterMode_Linear;
	}
}

function mapShaderStage(stage?: string | number | null) {
	if (typeof stage === "number") return stage;
	switch (stage) {
		case "vertex":
			return WGPUShaderStage_Vertex;
		case "fragment":
			return WGPUShaderStage_Fragment;
		case "compute":
			return WGPUShaderStage_Compute;
		default:
			return 0;
	}
}

function mapBufferBindingType(type?: string | number | null) {
	if (typeof type === "number") return type;
	switch (type) {
		case "uniform":
			return WGPUBufferBindingType_Uniform;
		case "storage":
			return WGPUBufferBindingType_Storage;
		case "read-only-storage":
			return WGPUBufferBindingType_ReadOnlyStorage;
		default:
			return WGPUBufferBindingType_Uniform;
	}
}

function mapSamplerBindingType(type?: string | number | null) {
	if (typeof type === "number") return type;
	switch (type) {
		case "comparison":
			return WGPUSamplerBindingType_Comparison;
		case "non-filtering":
			return WGPUSamplerBindingType_NonFiltering;
		case "filtering":
		default:
			return WGPUSamplerBindingType_Filtering;
	}
}

function mapTextureSampleType(type?: string | number | null) {
	if (typeof type === "number") return type;
	switch (type) {
		case "unfilterable-float":
			return WGPUTextureSampleType_UnfilterableFloat;
		case "depth":
			return WGPUTextureSampleType_Depth;
		case "sint":
			return WGPUTextureSampleType_Sint;
		case "uint":
			return WGPUTextureSampleType_Uint;
		case "float":
		default:
			return WGPUTextureSampleType_Float;
	}
}

function mapStorageTextureAccess(access?: string | number | null) {
	if (typeof access === "number") return access;
	switch (access) {
		case "read-only":
			return WGPUStorageTextureAccess_ReadOnly;
		case "read-write":
			return WGPUStorageTextureAccess_ReadWrite;
		case "write-only":
		default:
			return WGPUStorageTextureAccess_WriteOnly;
	}
}

function mapBlendOperation(op?: string | number | null) {
	if (typeof op === "number") return op;
	switch (op) {
		case "add":
		default:
			return WGPUBlendOperation_Add;
	}
}

function mapBlendFactor(factor?: string | number | null) {
	if (typeof factor === "number") return factor;
	switch (factor) {
		case "one":
			return WGPUBlendFactor_One;
		case "zero":
			return WGPUBlendFactor_Zero;
		case "src-alpha":
			return WGPUBlendFactor_SrcAlpha;
		case "one-minus-src-alpha":
			return WGPUBlendFactor_OneMinusSrcAlpha;
		default:
			return WGPUBlendFactor_One;
	}
}

function mapLoadOp(op?: string | number | null) {
	if (typeof op === "number") return op;
	switch (op) {
		case "load":
			return WGPULoadOp_Load;
		case "clear":
		default:
			return WGPULoadOp_Clear;
	}
}

function mapStoreOp(op?: string | number | null) {
	if (typeof op === "number") return op;
	switch (op) {
		case "discard":
			return WGPUStoreOp_Discard;
		case "store":
		default:
			return WGPUStoreOp_Store;
	}
}

function mapIndexFormat(format?: string | number | null) {
	if (typeof format === "number") return format;
	switch (format) {
		case "uint32":
			return 0x00000002;
		case "uint16":
			return 0x00000001;
		default:
			return 0;
	}
}

function mapAlphaMode(mode?: string | number | null) {
	if (typeof mode === "number") return mode;
	switch (mode) {
		case "premultiplied":
			return WGPUCompositeAlphaMode_Premultiplied;
		case "unpremultiplied":
			return WGPUCompositeAlphaMode_Unpremultiplied;
		case "opaque":
		default:
			return WGPUCompositeAlphaMode_Opaque;
	}
}

function makeShaderSourceWGSL(codePtr: number, codeLen: bigint) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, 0x00000002);
	writeU32(view, 12, 0);
	writePtr(view, 16, codePtr);
	writeU64(view, 24, codeLen);
	return { buffer, ptr: ptr(buffer) };
}

function makeShaderModuleDescriptor(nextInChainPtr: number) {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writePtr(view, 0, nextInChainPtr);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	return { buffer, ptr: ptr(buffer) };
}

function makeTexelCopyTextureInfo(
	texturePtr: number,
	mipLevel = 0,
	origin?: { x?: number; y?: number; z?: number },
) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, texturePtr);
	writeU32(view, 8, mipLevel);
	writeU32(view, 12, origin?.x ?? 0);
	writeU32(view, 16, origin?.y ?? 0);
	writeU32(view, 20, origin?.z ?? 0);
	writeU32(view, 24, 0);
	writeU32(view, 28, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeTexelCopyBufferLayout(
	offset: number | bigint,
	bytesPerRow: number,
	rowsPerImage: number,
) {
	const buffer = new ArrayBuffer(16);
	const view = new DataView(buffer);
	writeU64(view, 0, BigInt(offset));
	writeU32(view, 8, bytesPerRow);
	writeU32(view, 12, rowsPerImage);
	return { buffer, ptr: ptr(buffer) };
}

function makeImageCopyBuffer(
	bufferPtr: number,
	offset: number,
	bytesPerRow: number,
	rowsPerImage: number,
) {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writeU64(view, 0, BigInt(offset));
	writeU32(view, 8, bytesPerRow);
	writeU32(view, 12, rowsPerImage);
	writePtr(view, 16, bufferPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeExtent3D(width: number, height: number, depth: number) {
	const buffer = new ArrayBuffer(12);
	const view = new DataView(buffer);
	writeU32(view, 0, width);
	writeU32(view, 4, height);
	writeU32(view, 8, depth);
	return { buffer, ptr: ptr(buffer) };
}

function alignTo(value: number, alignment: number) {
	return Math.ceil(value / alignment) * alignment;
}

function bytesPerPixelForFormat(format?: number) {
	switch (format) {
		case WGPUTextureFormat_R8Unorm:
		case WGPUTextureFormat_R8Snorm:
		case WGPUTextureFormat_R8Uint:
		case WGPUTextureFormat_R8Sint:
			return 1;
		case WGPUTextureFormat_RG8Unorm:
		case WGPUTextureFormat_RG8Snorm:
		case WGPUTextureFormat_RG8Uint:
		case WGPUTextureFormat_RG8Sint:
			return 2;
		case WGPUTextureFormat_BGRA8Unorm:
		case WGPUTextureFormat_BGRA8UnormSrgb:
		case WGPUTextureFormat_RGBA8Unorm:
		case WGPUTextureFormat_RGBA8UnormSrgb:
		case WGPUTextureFormat_Depth24Plus:
		case WGPUTextureFormat_Depth24PlusStencil8:
		case WGPUTextureFormat_Depth32Float:
			return 4;
		case WGPUTextureFormat_Depth32FloatStencil8:
			return 8;
		case WGPUTextureFormat_RG32Float:
		case WGPUTextureFormat_RG32Uint:
		case WGPUTextureFormat_RG32Sint:
		case WGPUTextureFormat_RGBA16Float:
		case WGPUTextureFormat_RGBA16Uint:
		case WGPUTextureFormat_RGBA16Sint:
			return 8;
		case WGPUTextureFormat_RGBA32Uint:
		case WGPUTextureFormat_RGBA32Sint:
			return 16;
		default:
			return 4;
	}
}

function repackTextureData(
	data: ArrayBufferView,
	srcStride: number,
	dstStride: number,
	minRowBytes: number,
	height: number,
	rowsPerImage: number,
	layers: number,
) {
	const src = new Uint8Array(
		data.buffer,
		data.byteOffset,
		data.byteLength,
	);
	const totalRows = rowsPerImage * layers;
	const dst = new Uint8Array(dstStride * totalRows);
	let srcOffset = 0;
	let dstOffset = 0;

	for (let layer = 0; layer < layers; layer += 1) {
		for (let row = 0; row < rowsPerImage; row += 1) {
			if (row < height) {
				dst.set(
					src.subarray(srcOffset, srcOffset + minRowBytes),
					dstOffset,
				);
			}
			srcOffset += srcStride;
			dstOffset += dstStride;
		}
	}

	return dst;
}

const webgpu = {
	navigator: {
		async requestAdapter(options?: { compatibleSurface?: GPUCanvasContext }) {
			const surfacePtr = options?.compatibleSurface
				? options.compatibleSurface.surfacePtr
				: 0;
			const instance = WGPUNative.symbols.wgpuCreateInstance(0);
			return new GPUAdapter(Number(instance), surfacePtr);
		},
		getPreferredCanvasFormat() {
			return "bgra8unorm";
		},
	},
	createContext,
	GPUCanvasContext,
	install() {
		const nav = (globalThis as any).navigator ?? {};
		nav.gpu = webgpu.navigator;
		(globalThis as any).navigator = nav;
		(globalThis as any).GPUCanvasContext = GPUCanvasContext;
	},
};

export {
	webgpu,
	GPUCanvasContext,
	GPUAdapter,
	GPUDevice,
	GPUQueue,
	GPUTexture,
	GPUTextureView,
	GPUBuffer,
	GPUSampler,
	GPUBindGroupLayout,
	GPUBindGroup,
	GPUPipelineLayout,
	GPUShaderModule,
	GPURenderPipeline,
	GPUCommandEncoder,
	GPUCommandBuffer,
	GPURenderPassEncoder,
};
export default webgpu;
