import {
	BrowserView,
	BrowserWindow,
	Screen,
	WGPU,
	WGPUBridge,
	DCompBridge,
	three,
} from "electrobun/bun";
import { CString, ptr } from "bun:ffi";
import { inflateSync } from "zlib";
import { existsSync } from "fs";
import { resolve } from "path";
import * as CANNON from "cannon-es";

// ── WGPU constants ──────────────────────────────────────────────────────────

const WGPUNative = WGPU.native;
const WGPU_KEEPALIVE: any[] = [];

const WGPUTextureFormat_RGBA8UnormSrgb = 0x00000017;
const WGPUTextureUsage_RenderAttachment = 0x0000000000000010n;
const WGPUTextureUsage_CopyDst = 0x0000000000000002n;
const WGPUTextureUsage_CopySrc = 0x0000000000000001n;
const WGPUTextureUsage_TextureBinding = 0x0000000000000004n;
const WGPUBufferUsage_Vertex = 0x0000000000000020n;
const WGPUBufferUsage_CopyDst = 0x0000000000000008n;
const WGPUBufferUsage_MapRead = 0x0000000000000001n;
const WGPUVertexFormat_Float32 = 0x0000001c;
const WGPUVertexFormat_Float32x2 = 0x0000001d;
const WGPUVertexFormat_Float32x3 = 0x0000001e;
const WGPUVertexStepMode_Vertex = 0x00000001;
const WGPUPrimitiveTopology_TriangleList = 0x00000004;
const WGPUFrontFace_CCW = 0x00000001;
const WGPUCullMode_Back = 0x00000003;
const WGPUPresentMode_Fifo = 0x00000001;
const WGPULoadOp_Clear = 0x00000002;
const WGPUStoreOp_Store = 0x00000001;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;
const WGPUTextureAspect_All = 0x00000001;
const WGPUTextureDimension_2D = 0x00000002;
const WGPUAddressMode_ClampToEdge = 0x00000001;
const WGPUFilterMode_Linear = 0x00000002;
const WGPUMipmapFilterMode_Linear = 0x00000002;

const FLOATS_PER_VERTEX = 12;
const VERTEX_STRIDE = FLOATS_PER_VERTEX * 4;

// ── WGPU struct helpers ─────────────────────────────────────────────────────

function writePtr(view: DataView, offset: number, value: number | bigint | null) {
	view.setBigUint64(offset, BigInt(value ?? 0), true);
}

function writeU32(view: DataView, offset: number, value: number | bigint) {
	view.setUint32(offset, Number(value) >>> 0, true);
}

function writeU64(view: DataView, offset: number, value: bigint) {
	view.setBigUint64(offset, value, true);
}

function makeSurfaceConfiguration(
	devicePtr: number,
	width: number,
	height: number,
	format: number,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, devicePtr);
	writeU32(view, 16, format);
	writeU32(view, 20, 0);
	writeU64(view, 24, WGPUTextureUsage_RenderAttachment);
	writeU32(view, 32, width);
	writeU32(view, 36, height);
	writeU64(view, 40, 0n);
	writePtr(view, 48, 0);
	writeU32(view, 56, 1);
	writeU32(view, 60, WGPUPresentMode_Fifo);
	return { buffer, ptr: ptr(buffer) };
}

function makeShaderSourceWGSL(codePtr: number) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, 0x00000002);
	writeU32(view, 12, 0);
	writePtr(view, 16, codePtr);
	writeU64(view, 24, WGPU_STRLEN);
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

function makeVertexAttribute(offset: number, shaderLocation: number, format: number) {
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

function makeVertexBufferLayout(attributePtr: number, attributeCount: number) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUVertexStepMode_Vertex);
	writeU32(view, 12, 0);
	writeU64(view, 16, BigInt(VERTEX_STRIDE));
	writeU64(view, 24, BigInt(attributeCount));
	writePtr(view, 32, attributePtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeColorTargetState(format: number) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, format);
	writeU32(view, 12, 0);
	writePtr(view, 16, 0);
	writeU64(view, 24, 0x0fn);
	return { buffer, ptr: ptr(buffer) };
}

function makeVertexState(modulePtr: number, entryPointPtr: number, bufferLayoutPtr: number) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPointPtr);
	writeU64(view, 24, WGPU_STRLEN);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, 1n);
	writePtr(view, 56, bufferLayoutPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeFragmentState(modulePtr: number, entryPointPtr: number, targetPtr: number) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPointPtr);
	writeU64(view, 24, WGPU_STRLEN);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, 1n);
	writePtr(view, 56, targetPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makePrimitiveState() {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUPrimitiveTopology_TriangleList);
	writeU32(view, 12, 0);
	writeU32(view, 16, WGPUFrontFace_CCW);
	writeU32(view, 20, WGPUCullMode_Back);
	writeU32(view, 24, 0);
	writeU32(view, 28, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeMultisampleState() {
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, 1);
	writeU32(view, 12, 0xffffffff);
	writeU32(view, 16, 0);
	writeU32(view, 20, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeRenderPipelineDescriptor(
	vertexStatePtr: number,
	primitiveStatePtr: number,
	multisampleStatePtr: number,
	fragmentStatePtr: number,
) {
	const buffer = new ArrayBuffer(168);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writePtr(view, 24, 0);
	new Uint8Array(buffer, 32, 64).set(new Uint8Array(vertexStatePtr.buffer));
	new Uint8Array(buffer, 96, 32).set(new Uint8Array(primitiveStatePtr.buffer));
	writePtr(view, 128, 0);
	new Uint8Array(buffer, 136, 24).set(new Uint8Array(multisampleStatePtr.buffer));
	writePtr(view, 160, fragmentStatePtr.ptr as unknown as number);
	return { buffer, ptr: ptr(buffer) };
}

function makeBufferDescriptor(size: number) {
	const buffer = new ArrayBuffer(48);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst);
	writeU64(view, 32, BigInt(size));
	writeU32(view, 40, 0);
	writeU32(view, 44, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeReadbackBufferDescriptor(size: number) {
	const buffer = new ArrayBuffer(48);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead);
	writeU64(view, 32, BigInt(size));
	writeU32(view, 40, 0);
	writeU32(view, 44, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeTexelCopyBufferInfo(bufferPtr: number, bytesPerRow: number, rowsPerImage: number) {
	// Dawn's WGPUTexelCopyBufferInfo (from webgpu.h):
	//   layout.offset:       u64 (8 bytes)  @ 0
	//   layout.bytesPerRow:  u32 (4 bytes)  @ 8
	//   layout.rowsPerImage: u32 (4 bytes)  @ 12
	//   buffer:              ptr (8 bytes)  @ 16
	// Total: 24 bytes — buffer comes AFTER layout!
	const buffer = new ArrayBuffer(24);
	const view = new DataView(buffer);
	writeU64(view, 0, 0n);          // layout.offset
	writeU32(view, 8, bytesPerRow);  // layout.bytesPerRow
	writeU32(view, 12, rowsPerImage);// layout.rowsPerImage
	writePtr(view, 16, bufferPtr);   // buffer
	return { buffer, ptr: ptr(buffer) };
}

function makeTextureDescriptor(
	width: number,
	height: number,
	format: number,
	usage: bigint,
) {
	const buffer = new ArrayBuffer(80);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, usage);
	writeU32(view, 32, WGPUTextureDimension_2D);
	writeU32(view, 36, width);
	writeU32(view, 40, height);
	writeU32(view, 44, 1);
	writeU32(view, 48, format);
	writeU32(view, 52, 1);
	writeU32(view, 56, 1);
	writeU32(view, 60, 0);
	writeU64(view, 64, 0n);
	writePtr(view, 72, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeSamplerDescriptor() {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU32(view, 24, WGPUAddressMode_ClampToEdge);
	writeU32(view, 28, WGPUAddressMode_ClampToEdge);
	writeU32(view, 32, WGPUAddressMode_ClampToEdge);
	writeU32(view, 36, WGPUFilterMode_Linear);
	writeU32(view, 40, WGPUFilterMode_Linear);
	writeU32(view, 44, WGPUMipmapFilterMode_Linear);
	view.setFloat32(48, 0, true);
	view.setFloat32(52, 32, true);
	writeU32(view, 56, 0);
	view.setUint16(60, 1, true);
	view.setUint16(62, 0, true);
	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupEntrySampler(binding: number, samplerPtr: number) {
	const buffer = new ArrayBuffer(56);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, binding);
	writeU32(view, 12, 0);
	writePtr(view, 16, 0);
	writeU64(view, 24, 0n);
	writeU64(view, 32, 0n);
	writePtr(view, 40, samplerPtr);
	writePtr(view, 48, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupEntryTexture(binding: number, textureViewPtr: number) {
	const buffer = new ArrayBuffer(56);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, binding);
	writeU32(view, 12, 0);
	writePtr(view, 16, 0);
	writeU64(view, 24, 0n);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writePtr(view, 48, textureViewPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeBindGroupDescriptor(layoutPtr: number, entriesPtr: number, count: number) {
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

function makeTexelCopyTextureInfo(texturePtr: number) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, texturePtr);
	writeU32(view, 8, 0);
	writeU32(view, 12, 0);
	writeU32(view, 16, 0);
	writeU32(view, 20, 0);
	writeU32(view, 24, WGPUTextureAspect_All);
	writeU32(view, 28, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeTexelCopyBufferLayout(bytesPerRow: number, rowsPerImage: number) {
	const buffer = new ArrayBuffer(16);
	const view = new DataView(buffer);
	writeU64(view, 0, 0n);
	writeU32(view, 8, bytesPerRow);
	writeU32(view, 12, rowsPerImage);
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

function makeRenderPassColorAttachment(viewPtr: number) {
	const buffer = new ArrayBuffer(72);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, viewPtr);
	writeU32(view, 16, WGPU_DEPTH_SLICE_UNDEFINED);
	writeU32(view, 20, 0);
	writePtr(view, 24, 0);
	writeU32(view, 32, WGPULoadOp_Clear);
	writeU32(view, 36, WGPUStoreOp_Store);
	view.setFloat64(40, 0.1, true);
	view.setFloat64(48, 0.1, true);
	view.setFloat64(56, 0.11, true);
	view.setFloat64(64, 1.0, true);
	return { buffer, ptr: ptr(buffer) };
}

function makeRenderPassDescriptor(colorAttachmentPtr: number) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, 0);
	writeU64(view, 16, 0n);
	writeU64(view, 24, 1n);
	writePtr(view, 32, colorAttachmentPtr);
	writePtr(view, 40, 0);
	writePtr(view, 48, 0);
	writePtr(view, 56, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeCommandBufferArray(cmdPtr: number) {
	const buffer = new BigUint64Array([BigInt(cmdPtr)]);
	return { buffer, ptr: ptr(buffer) };
}

function alignTo(value: number, alignment: number) {
	return Math.ceil(value / alignment) * alignment;
}

// ── PNG decoder ─────────────────────────────────────────────────────────────

function decodePngRGBA(data: Uint8Array) {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const readU32 = (offset: number) => view.getUint32(offset, false);

	if (readU32(0) !== 0x89504e47) {
		throw new Error("Invalid PNG header");
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idat: Uint8Array[] = [];

	while (offset < data.length) {
		const length = readU32(offset);
		const type = String.fromCharCode(
			data[offset + 4]!,
			data[offset + 5]!,
			data[offset + 6]!,
			data[offset + 7]!,
		);
		const chunkStart = offset + 8;
		const chunkEnd = chunkStart + length;

		if (type === "IHDR") {
			width = readU32(chunkStart);
			height = readU32(chunkStart + 4);
			bitDepth = data[chunkStart + 8]!;
			colorType = data[chunkStart + 9]!;
		} else if (type === "IDAT") {
			idat.push(data.subarray(chunkStart, chunkEnd));
		} else if (type === "IEND") {
			break;
		}

		offset = chunkEnd + 4;
	}

	if (bitDepth !== 8 || colorType !== 6) {
		throw new Error("PNG must be RGBA 8-bit");
	}

	const compressed = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
	let cursor = 0;
	for (const chunk of idat) {
		compressed.set(chunk, cursor);
		cursor += chunk.length;
	}

	const inflated = inflateSync(compressed);
	const bpp = 4;
	const stride = width * bpp;
	const output = new Uint8Array(height * stride);
	let inOffset = 0;
	let outOffset = 0;

	for (let y = 0; y < height; y += 1) {
		const filter = inflated[inOffset]!;
		inOffset += 1;
		const row = inflated.subarray(inOffset, inOffset + stride);
		inOffset += stride;

		for (let x = 0; x < stride; x += 1) {
			const left = x >= bpp ? output[outOffset + x - bpp]! : 0;
			const up = y > 0 ? output[outOffset - stride + x]! : 0;
			const upLeft = y > 0 && x >= bpp ? output[outOffset - stride + x - bpp]! : 0;
			let val = row[x]!;
			if (filter === 1) val = (val + left) & 0xff;
			else if (filter === 2) val = (val + up) & 0xff;
			else if (filter === 3) val = (val + Math.floor((left + up) / 2)) & 0xff;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				val = (val + paeth) & 0xff;
			}
			output[outOffset + x] = val;
		}
		outOffset += stride;
	}

	return { width, height, data: output };
}

// ── Window setup ────────────────────────────────────────────────────────────

const display = Screen.getPrimaryDisplay();
const workArea = display.workArea;

// Physics settings (controlled by HUD sliders)
const settings = {
	dropRateMs: 300,
	cubeSize: 0.4,
};

// Single window dimensions
const winW = 920;
const winH = 640;
const winX = workArea.x + Math.floor((workArea.width - winW) / 2);
const winY = workArea.y + Math.floor((workArea.height - winH) / 2);

// RPC for HUD → Bun communication (slider settings)
const rpc = BrowserView.defineRPC<{
	bun: {
		requests: {};
		messages: {
			setDropRate: { ms: number };
			setCubeSize: { size: number };
		};
	};
	webview: {
		requests: {};
		messages: {};
	};
}>({
	maxRequestTime: 10000,
	handlers: {
		requests: {},
		messages: {
			setDropRate: ({ ms }) => {
				settings.dropRateMs = Math.max(100, Math.min(2000, ms));
				restartDropTimer();
				console.log(`[HUD] Drop rate: ${settings.dropRateMs}ms`);
			},
			setCubeSize: ({ size }) => {
				settings.cubeSize = Math.max(0.2, Math.min(1.5, size));
				console.log(`[HUD] Cube size: ${settings.cubeSize}`);
			},
		},
	},
});

// Enable DComp BEFORE creating BrowserWindow — DComp swap chain renders
// behind WebView2 child windows (topmost=FALSE). Three.js pixels will be
// blitted to this swap chain each frame.
DCompBridge.enableMode(winW, winH);

// Single window: BrowserWindow with transparent WebView2 (SolidJS HUD).
// DComp swap chain is the back layer — Three.js renders there.
const win = new BrowserWindow({
	title: "Three.js + SolidJS + DComp — Unified Demo",
	url: "views://mainview/index.html",
	frame: { width: winW, height: winH, x: winX, y: winY },
	titleBarStyle: "default",
	transparent: true,
	rpc,
});

// ── WGPU initialization ────────────────────────────────────────────────────

if (!WGPUNative.available) {
	throw new Error("WGPU native library not available");
}

// ── WGPU initialization (offscreen — no surface/GpuWindow) ──────────────────
// Dawn creates adapter+device without a surface. We render to an offscreen
// texture, read back pixels, and blit to the DComp swap chain.

// Create WGPU instance with TimedWaitAny enabled (required for bufferReadSyncInto)
const WGPUInstanceFeatureName_TimedWaitAny = 0x00000001;
const featuresArray = new Uint32Array([WGPUInstanceFeatureName_TimedWaitAny]);
WGPU_KEEPALIVE.push(featuresArray);
// WGPUInstanceDescriptor: nextInChain(ptr) + requiredFeatureCount(u64) + requiredFeatures(ptr) + requiredLimits(ptr)
const instanceDescBuf = new ArrayBuffer(32);
const instanceDescView = new DataView(instanceDescBuf);
writePtr(instanceDescView, 0, 0);                    // nextInChain
writeU64(instanceDescView, 8, 1n);                    // requiredFeatureCount
writePtr(instanceDescView, 16, ptr(featuresArray));    // requiredFeatures
writePtr(instanceDescView, 24, 0);                    // requiredLimits
WGPU_KEEPALIVE.push(instanceDescBuf);
const instance = WGPUNative.symbols.wgpuCreateInstance(ptr(instanceDescBuf));

// Create adapter+device without a compatible surface (pass 0 for surface)
const adapterDevice = new BigUint64Array(2);
WGPUBridge.createAdapterDeviceMainThread(instance as number, 0 as number, ptr(adapterDevice));
const adapter = Number(adapterDevice[0]);
const device = Number(adapterDevice[1]);
if (!adapter || !device) {
	throw new Error("Failed to create adapter/device");
}

const queue = WGPUNative.symbols.wgpuDeviceGetQueue(device);

// Use BGRA8Unorm to match the DComp D3D11 swap chain format
const WGPUTextureFormat_BGRA8Unorm = 0x0000001B;
const surfaceFormat = WGPUTextureFormat_BGRA8Unorm;
let currentWidth = winW;
let currentHeight = winH;

// Offscreen render resources (recreated on resize)
let renderTexture: any = null;

// Zero-copy bridge: staging texture lives on Dawn's DX12 device,
// wrapped for D3D11 access to the DComp swap chain back buffer.
// Replaces readback buffer + CPU pixel copy with GPU-to-GPU CopyTextureToTexture.
const zeroCopyTexture = DCompBridge.initZeroCopyBridge(device as any, currentWidth, currentHeight);
if (!zeroCopyTexture) {
	console.warn("[zero-copy] Bridge init failed, falling back to readback path");
}
const useZeroCopy = !!zeroCopyTexture;
// Check if the zero-copy texture supports RenderAttachment (single-copy path)
// If so, we render directly to it — no separate renderTexture needed.
const zeroCopyUsage = zeroCopyTexture
	? Number(WGPUNative.symbols.wgpuTextureGetUsage(zeroCopyTexture as number))
	: 0;
const canRenderDirect = useZeroCopy && (zeroCopyUsage & Number(WGPUTextureUsage_RenderAttachment)) !== 0;
console.log(`[bridge] ${useZeroCopy
	? (canRenderDirect ? "ZERO-COPY DIRECT RENDER (single copy)" : "ZERO-COPY (two copies)")
	: "READBACK (GPU→CPU→GPU)"} usage=0x${zeroCopyUsage.toString(16)}`);

// Readback resources (fallback path only)
let readbackBytesPerRow = alignTo(currentWidth * 4, 256);
let readbackSize = readbackBytesPerRow * currentHeight;
let readbackBuffer: any = null;

function recreateRenderResources() {
	// Release old resources (don't release zeroCopyTexture — it's owned by C++)
	if (!canRenderDirect && renderTexture) WGPUNative.symbols.wgpuTextureRelease(renderTexture);
	if (!useZeroCopy && readbackBuffer) WGPUNative.symbols.wgpuBufferRelease(readbackBuffer);

	if (canRenderDirect) {
		// Single-copy: render directly to the staging texture
		renderTexture = zeroCopyTexture;
	} else {
		const texDesc = makeTextureDescriptor(
			currentWidth, currentHeight,
			surfaceFormat,
			WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc,
		);
		renderTexture = WGPUNative.symbols.wgpuDeviceCreateTexture(device, texDesc.ptr as number);
	}

	if (!useZeroCopy) {
		readbackBytesPerRow = alignTo(currentWidth * 4, 256);
		readbackSize = readbackBytesPerRow * currentHeight;
		const bufDesc = makeReadbackBufferDescriptor(readbackSize);
		readbackBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(device, bufDesc.ptr as number);
	}

	console.log(`[resize] ${currentWidth}x${currentHeight}${canRenderDirect ? " (direct render)" : ""}`);
}

recreateRenderResources();
if (!renderTexture || (!useZeroCopy && !readbackBuffer)) {
	throw new Error("Failed to create offscreen render resources");
}

// Enable bridge mode: DComp won't clear/render on resize — WGPU provides frames
DCompBridge.setBridgeMode(true);

// ── Shader ──────────────────────────────────────────────────────────────────

const shaderText = `
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) normal : vec3<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) logoMask : f32,
  @location(3) baseColor : vec3<f32>,
};

@group(0) @binding(0) var logoSampler: sampler;
@group(0) @binding(1) var logoTex: texture_2d<f32>;

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) logoMask: f32,
  @location(4) baseColor: vec3<f32>
) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 1.0);
  out.normal = normal;
  out.uv = uv;
  out.logoMask = logoMask;
  out.baseColor = baseColor;
  return out;
}

@fragment
fn fs_main(
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) logoMask: f32,
  @location(3) baseColor: vec3<f32>
) -> @location(0) vec4<f32> {
  let light = normalize(vec3<f32>(0.4, 0.7, 0.9));
  let n = normalize(normal);
  let diff = max(dot(n, light), 0.0);
  var color = baseColor * (0.2 + diff * 0.8);
  let tex = textureSample(logoTex, logoSampler, uv);
  let mask = clamp(logoMask, 0.0, 1.0);
  color = mix(color, tex.rgb, tex.a * mask);
  return vec4<f32>(color, 1.0);
}
`;

const shaderBytes = new TextEncoder().encode(shaderText + "\0");
const shaderBuf = new Uint8Array(shaderBytes);
WGPU_KEEPALIVE.push(shaderBuf);
const shaderPtr = ptr(shaderBuf);
const shaderSource = makeShaderSourceWGSL(shaderPtr);
const shaderDesc = makeShaderModuleDescriptor(shaderSource.ptr as number);
const shaderModule = WGPUNative.symbols.wgpuDeviceCreateShaderModule(device, shaderDesc.ptr as number);
if (!shaderModule) {
	throw new Error("Failed to create shader module");
}

// ── Pipeline ────────────────────────────────────────────────────────────────

const entryPoint = new CString("vs_main");
const fragEntryPoint = new CString("fs_main");
WGPU_KEEPALIVE.push(entryPoint, fragEntryPoint);
const posAttr = makeVertexAttribute(0, 0, WGPUVertexFormat_Float32x3);
const normalAttr = makeVertexAttribute(12, 1, WGPUVertexFormat_Float32x3);
const uvAttr = makeVertexAttribute(24, 2, WGPUVertexFormat_Float32x2);
const maskAttr = makeVertexAttribute(32, 3, WGPUVertexFormat_Float32);
const colorAttr = makeVertexAttribute(36, 4, WGPUVertexFormat_Float32x3);
const attrBuf = new ArrayBuffer(32 * 5);
new Uint8Array(attrBuf, 0, 32).set(new Uint8Array(posAttr.buffer));
new Uint8Array(attrBuf, 32, 32).set(new Uint8Array(normalAttr.buffer));
new Uint8Array(attrBuf, 64, 32).set(new Uint8Array(uvAttr.buffer));
new Uint8Array(attrBuf, 96, 32).set(new Uint8Array(maskAttr.buffer));
new Uint8Array(attrBuf, 128, 32).set(new Uint8Array(colorAttr.buffer));
const attrPtr = ptr(attrBuf);
WGPU_KEEPALIVE.push(attrBuf);
const vertexLayout = makeVertexBufferLayout(attrPtr as number, 5);
const vertexState = makeVertexState(shaderModule, entryPoint.ptr, vertexLayout.ptr as number);
const colorTarget = makeColorTargetState(surfaceFormat);
const fragmentState = makeFragmentState(shaderModule, fragEntryPoint.ptr, colorTarget.ptr as number);
const primitiveState = makePrimitiveState();
const multisampleState = makeMultisampleState();
const pipelineDesc = makeRenderPipelineDescriptor(
	vertexState,
	primitiveState,
	multisampleState,
	fragmentState,
);
const pipeline = WGPUNative.symbols.wgpuDeviceCreateRenderPipeline(device, pipelineDesc.ptr as number);
if (!pipeline) {
	throw new Error("Failed to create pipeline");
}

// ── Logo texture ────────────────────────────────────────────────────────────

const assetCandidates = [
	resolve(import.meta.dir, "..", "assets", "bunny.png"),
	resolve(import.meta.dir, "assets", "bunny.png"),
	resolve(process.execPath, "..", "Resources", "app", "assets", "bunny.png"),
	resolve(process.cwd(), "..", "Resources", "app", "assets", "bunny.png"),
	resolve(process.cwd(), "assets", "bunny.png"),
	resolve(process.cwd(), "src", "assets", "bunny.png"),
];
let logoBytes: Uint8Array | null = null;
for (const candidate of assetCandidates) {
	if (!existsSync(candidate)) continue;
	const bytes = new Uint8Array(await Bun.file(candidate).arrayBuffer());
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		logoBytes = bytes;
		console.log(`[three-physics] logo loaded: ${candidate}`);
		break;
	}
}

if (!logoBytes) {
	throw new Error("Bunny logo asset not found or invalid");
}

const logo = decodePngRGBA(logoBytes);
const bytesPerRow = alignTo(logo.width * 4, 256);
const padded = new Uint8Array(bytesPerRow * logo.height);
for (let y = 0; y < logo.height; y += 1) {
	const src = logo.data.subarray(y * logo.width * 4, (y + 1) * logo.width * 4);
	padded.set(src, y * bytesPerRow);
}

const logoTextureDesc = makeTextureDescriptor(
	logo.width,
	logo.height,
	WGPUTextureFormat_RGBA8UnormSrgb,
	WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding,
);
const logoTexture = WGPUNative.symbols.wgpuDeviceCreateTexture(device, logoTextureDesc.ptr as number);
if (!logoTexture) {
	throw new Error("Failed to create logo texture");
}
const logoTextureView = WGPUNative.symbols.wgpuTextureCreateView(logoTexture, 0);
const logoSamplerDesc = makeSamplerDescriptor();
const logoSampler = WGPUNative.symbols.wgpuDeviceCreateSampler(device, logoSamplerDesc.ptr as number);
if (!logoSampler || !logoTextureView) {
	throw new Error("Failed to create logo sampler/view");
}

const copyTex = makeTexelCopyTextureInfo(logoTexture);
const layout = makeTexelCopyBufferLayout(bytesPerRow, logo.height);
const extent = makeExtent3D(logo.width, logo.height, 1);
WGPUNative.symbols.wgpuQueueWriteTexture(
	queue,
	copyTex.ptr as number,
	ptr(padded),
	padded.byteLength,
	layout.ptr as number,
	extent.ptr as number,
);

const bindGroupLayout = WGPUNative.symbols.wgpuRenderPipelineGetBindGroupLayout(pipeline, 0);
const samplerEntry = makeBindGroupEntrySampler(0, logoSampler);
const textureEntry = makeBindGroupEntryTexture(1, logoTextureView);
const entriesBuf = new ArrayBuffer(56 * 2);
new Uint8Array(entriesBuf, 0, 56).set(new Uint8Array(samplerEntry.buffer));
new Uint8Array(entriesBuf, 56, 56).set(new Uint8Array(textureEntry.buffer));
const entriesPtr = ptr(entriesBuf);
WGPU_KEEPALIVE.push(entriesBuf);
const bindGroupDesc = makeBindGroupDescriptor(bindGroupLayout, entriesPtr as number, 2);
const bindGroup = WGPUNative.symbols.wgpuDeviceCreateBindGroup(device, bindGroupDesc.ptr as number);
if (!bindGroup) {
	throw new Error("Failed to create bind group");
}

// ── Geometry + Physics ──────────────────────────────────────────────────────

const geometry = new three.BoxGeometry(1, 1, 1).toNonIndexed();
const basePositions = geometry.attributes.position.array as Float32Array;
const baseNormals = geometry.attributes.normal.array as Float32Array;
const baseUvs = geometry.attributes.uv.array as Float32Array;
const logoMask = new Float32Array(basePositions.length / 3);
for (let i = 0; i < baseNormals.length; i += 3) {
	const nx = baseNormals[i]!;
	const nz = baseNormals[i + 2]!;
	logoMask[i / 3] = Math.abs(nx) > 0.9 || Math.abs(nz) > 0.9 ? 1 : 0;
}

const vertexCountPerCube = basePositions.length / 3;
const maxCubes = 240;
const maxVertices = vertexCountPerCube * maxCubes;
const vertexBufferSize = maxVertices * FLOATS_PER_VERTEX * 4;
const bufferDesc = makeBufferDescriptor(vertexBufferSize);
const vertexBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(device, bufferDesc.ptr as number);
const encoderDesc = makeCommandEncoderDescriptor();

const camera = new three.PerspectiveCamera(50, currentWidth / currentHeight, 0.1, 50);
camera.position.set(0, 4.2, 8.5);
const lookAt = new three.Vector3(0, 1.0, 0);

const raycaster = new three.Raycaster();
const mouse = new three.Vector2();

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.allowSleep = true;
world.defaultContactMaterial.restitution = 0.5;
world.defaultContactMaterial.friction = 0.25;

const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

const wallSize = 6;
const wallHeight = 3;
const wallShape = new CANNON.Box(new CANNON.Vec3(wallSize, wallHeight, 0.2));
const walls = [
	{ pos: new CANNON.Vec3(0, wallHeight - 0.1, -wallSize), rot: new CANNON.Quaternion() },
	{ pos: new CANNON.Vec3(0, wallHeight - 0.1, wallSize), rot: new CANNON.Quaternion() },
	{ pos: new CANNON.Vec3(-wallSize, wallHeight - 0.1, 0), rot: new CANNON.Quaternion().setFromEuler(0, Math.PI / 2, 0) },
	{ pos: new CANNON.Vec3(wallSize, wallHeight - 0.1, 0), rot: new CANNON.Quaternion().setFromEuler(0, Math.PI / 2, 0) },
];
for (const wall of walls) {
	const body = new CANNON.Body({ mass: 0, shape: wallShape });
	body.position.copy(wall.pos);
	body.quaternion.copy(wall.rot);
	body.material = new CANNON.Material({ restitution: 0.5 });
	world.addBody(body);
}

const cubes: {
	body: CANNON.Body;
	color: three.Color;
	size: number;
}[] = [];

function addCube() {
	const size = settings.cubeSize;
	const shape = new CANNON.Box(new CANNON.Vec3(size * 0.5, size * 0.5, size * 0.5));
	const body = new CANNON.Body({ mass: 1, shape });
	body.material = new CANNON.Material({ restitution: 0.45 });
	body.position.set((Math.random() - 0.5) * 3, 6 + Math.random() * 2, (Math.random() - 0.5) * 3);
	body.angularVelocity.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
	body.angularDamping = 0.35;
	world.addBody(body);

	const color = new three.Color(0.02, 0.02, 0.02);
	cubes.push({ body, color, size });

	if (cubes.length > maxCubes) {
		const removed = cubes.shift();
		if (removed) {
			world.removeBody(removed.body);
		}
	}
}

let dropTimer: ReturnType<typeof setInterval> | null = null;
function restartDropTimer() {
	if (dropTimer) clearInterval(dropTimer);
	dropTimer = setInterval(addCube, settings.dropRateMs);
}

restartDropTimer();
addCube();
addCube();

// ── Drag interaction ────────────────────────────────────────────────────────

let lastFrame = performance.now();
let lastLeftDown = false;

const dragState = {
	active: false,
	body: null as CANNON.Body | null,
	offset: new three.Vector3(),
	plane: new three.Plane(),
	prevAngularDamping: 0,
	prevLinearDamping: 0,
};

const tempMatrix = new three.Matrix4();
const tempQuat = new three.Quaternion();
const tempPos = new three.Vector3();
const viewProj = new three.Matrix4();
const modelViewProj = new three.Matrix4();
const normalMatrix = new three.Matrix3();
const tempNormal = new three.Vector3();
const tempVec = new three.Vector3();
const tempVec2 = new three.Vector3();
const tempHit = new three.Vector3();
const tempBox = new three.Box3();
const dragTarget = new three.Vector3();

function pickCube(ray: three.Ray) {
	let closest: { cube: (typeof cubes)[number]; point: three.Vector3; dist: number } | null = null;
	for (const cube of cubes) {
		const body = cube.body;
		const half = cube.size * 0.5;
		tempBox.min.set(body.position.x - half, body.position.y - half, body.position.z - half);
		tempBox.max.set(body.position.x + half, body.position.y + half, body.position.z + half);
		const hit = ray.intersectBox(tempBox, tempHit);
		if (!hit) continue;
		const dist = ray.origin.distanceTo(hit);
		if (!closest || dist < closest.dist) {
			closest = { cube, point: hit.clone(), dist };
		}
	}
	return closest;
}

// ── Render loop ─────────────────────────────────────────────────────────────

function renderFrame() {
	const now = performance.now();
	const delta = Math.min(0.05, (now - lastFrame) / 1000);
	lastFrame = now;

	world.step(1 / 60, delta, 3);

	// Check for resize
	const winSize = win.getSize();
	if (winSize.width > 0 && winSize.height > 0 &&
		(winSize.width !== currentWidth || winSize.height !== currentHeight)) {
		currentWidth = winSize.width;
		currentHeight = winSize.height;
		recreateRenderResources();
		camera.aspect = currentWidth / currentHeight;
		camera.updateProjectionMatrix();
	}

	camera.lookAt(lookAt);
	camera.updateMatrixWorld();
	viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

	// Mouse drag interaction
	const frame = win.getFrame();
	const cursor = Screen.getCursorScreenPoint();
	const mx = (cursor.x - frame.x) / frame.width;
	const my = (cursor.y - frame.y) / frame.height;
	const inside = mx >= 0 && mx <= 1 && my >= 0 && my <= 1;
	const buttons = Screen.getMouseButtons();
	const leftDown = (buttons & 1n) === 1n;
	if (inside) {
		mouse.set(mx * 2 - 1, -(my * 2 - 1));
		raycaster.setFromCamera(mouse, camera);

		if (leftDown && !lastLeftDown) {
			const picked = pickCube(raycaster.ray);
			if (picked) {
				dragState.active = true;
				dragState.body = picked.cube.body;
				dragState.body.wakeUp();
				dragState.prevAngularDamping = dragState.body.angularDamping;
				dragState.prevLinearDamping = dragState.body.linearDamping;
				dragState.body.angularVelocity.set(0, 0, 0);
				dragState.body.angularDamping = 0.92;
				dragState.body.linearDamping = 0.4;
				dragState.offset.copy(picked.point);
				dragState.offset.sub(
					new three.Vector3(
						dragState.body.position.x,
						dragState.body.position.y,
						dragState.body.position.z,
					),
				);
				camera.getWorldDirection(tempVec);
				dragState.plane.setFromNormalAndCoplanarPoint(tempVec, picked.point);
			}
		}

		if (dragState.active && dragState.body) {
			if (raycaster.ray.intersectPlane(dragState.plane, dragTarget)) {
				const body = dragState.body;
				body.angularVelocity.set(0, 0, 0);
				tempVec.set(body.position.x, body.position.y, body.position.z);
				tempVec2.set(
					dragTarget.x - dragState.offset.x,
					dragTarget.y - dragState.offset.y,
					dragTarget.z - dragState.offset.z,
				);
				tempVec2.sub(tempVec);
				const force = tempVec2.multiplyScalar(18);
				body.velocity.scale(0.92, body.velocity);
				body.applyForce(
					new CANNON.Vec3(force.x, force.y, force.z),
					body.position,
				);
			}
		}
	}
	if (!leftDown && lastLeftDown) {
		if (dragState.body) {
			dragState.body.angularDamping = dragState.prevAngularDamping;
			dragState.body.linearDamping = dragState.prevLinearDamping;
		}
		dragState.active = false;
		dragState.body = null;
	}
	lastLeftDown = leftDown;

	// Build vertex buffer
	const vertexData = new Float32Array(cubes.length * vertexCountPerCube * FLOATS_PER_VERTEX);
	let writeIndex = 0;
	for (const cube of cubes) {
		const body = cube.body;
		tempPos.set(body.position.x, body.position.y, body.position.z);
		tempQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
		tempMatrix.compose(tempPos, tempQuat, new three.Vector3(cube.size, cube.size, cube.size));
		normalMatrix.getNormalMatrix(tempMatrix);
		modelViewProj.multiplyMatrices(viewProj, tempMatrix);

		for (let i = 0; i < basePositions.length; i += 3) {
			tempVec.set(basePositions[i]!, basePositions[i + 1]!, basePositions[i + 2]!);
			tempVec.applyMatrix4(modelViewProj);
			vertexData[writeIndex++] = tempVec.x;
			vertexData[writeIndex++] = tempVec.y;
			vertexData[writeIndex++] = tempVec.z;

			tempNormal.set(baseNormals[i]!, baseNormals[i + 1]!, baseNormals[i + 2]!);
			tempNormal.applyMatrix3(normalMatrix).normalize();
			vertexData[writeIndex++] = tempNormal.x;
			vertexData[writeIndex++] = tempNormal.y;
			vertexData[writeIndex++] = tempNormal.z;

			const uvIndex = (i / 3) * 2;
			vertexData[writeIndex++] = baseUvs[uvIndex]!;
			vertexData[writeIndex++] = baseUvs[uvIndex + 1]!;
			vertexData[writeIndex++] = logoMask[i / 3]!;

			vertexData[writeIndex++] = cube.color.r;
			vertexData[writeIndex++] = cube.color.g;
			vertexData[writeIndex++] = cube.color.b;
		}
	}

	const totalVertices = cubes.length * vertexCountPerCube;
	if (totalVertices === 0) {
		return;
	}

	WGPUNative.symbols.wgpuQueueWriteBuffer(
		queue,
		vertexBuffer,
		0,
		ptr(vertexData),
		totalVertices * FLOATS_PER_VERTEX * 4,
	);

	WGPUNative.symbols.wgpuInstanceProcessEvents(instance);

	// Render to offscreen texture
	const renderTextureView = WGPUNative.symbols.wgpuTextureCreateView(renderTexture, 0);
	if (!renderTextureView) return;

	const colorAttachment = makeRenderPassColorAttachment(renderTextureView);
	const renderPassDesc = makeRenderPassDescriptor(colorAttachment.ptr as number);
	const encoder = WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(device, encoderDesc.ptr as number);
	if (!encoder) return;

	const pass = WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(encoder, renderPassDesc.ptr as number);
	if (!pass) return;

	WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(pass, pipeline);
	WGPUNative.symbols.wgpuRenderPassEncoderSetBindGroup(pass, 0, bindGroup, 0, 0);
	WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vertexBuffer, 0, totalVertices * FLOATS_PER_VERTEX * 4);
	WGPUNative.symbols.wgpuRenderPassEncoderDraw(pass, totalVertices, 1, 0, 0);
	WGPUNative.symbols.wgpuRenderPassEncoderEnd(pass);

	let commandBuffer: any;
	if (useZeroCopy && canRenderDirect) {
		// Single-copy: rendered directly to staging texture, just finish + present
		DCompBridge.zeroCopyBeginFrame();

		commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(encoder, 0);
		if (!commandBuffer) return;
		const commandArray = makeCommandBufferArray(commandBuffer);
		WGPUNative.symbols.wgpuQueueSubmit(queue, 1, commandArray.ptr as number);

		DCompBridge.zeroCopyEndFrameAndPresent();
	} else if (useZeroCopy) {
		// Two-copy: render → staging via CopyTextureToTexture
		DCompBridge.zeroCopyBeginFrame();

		const copySrc = makeTexelCopyTextureInfo(renderTexture);
		const copyDst = makeTexelCopyTextureInfo(zeroCopyTexture as number);
		const copyExtent = makeExtent3D(currentWidth, currentHeight, 1);
		WGPUNative.symbols.wgpuCommandEncoderCopyTextureToTexture(
			encoder, copySrc.ptr as number, copyDst.ptr as number, copyExtent.ptr as number);

		commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(encoder, 0);
		if (!commandBuffer) return;
		const commandArray = makeCommandBufferArray(commandBuffer);
		WGPUNative.symbols.wgpuQueueSubmit(queue, 1, commandArray.ptr as number);

		DCompBridge.zeroCopyEndFrameAndPresent();
	} else {
		// Fallback: readback path (GPU → CPU → GPU)
		const copySrc = makeTexelCopyTextureInfo(renderTexture);
		const copyDst = makeTexelCopyBufferInfo(readbackBuffer, readbackBytesPerRow, currentHeight);
		const copyExtent = makeExtent3D(currentWidth, currentHeight, 1);
		WGPUNative.symbols.wgpuCommandEncoderCopyTextureToBuffer(
			encoder, copySrc.ptr as number, copyDst.ptr as number, copyExtent.ptr as number);

		commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(encoder, 0);
		if (!commandBuffer) return;
		const commandArray = makeCommandBufferArray(commandBuffer);
		WGPUNative.symbols.wgpuQueueSubmit(queue, 1, commandArray.ptr as number);

		DCompBridge.blitFromWGPUBuffer(
			instance as any, readbackBuffer as any,
			readbackBytesPerRow, currentWidth, currentHeight,
		);
	}

	// Cleanup
	WGPUNative.symbols.wgpuTextureViewRelease(renderTextureView);
	WGPUNative.symbols.wgpuCommandBufferRelease(commandBuffer);
	WGPUNative.symbols.wgpuCommandEncoderRelease(encoder);

	const frameEndTime = performance.now();
	avgFrameTimeMs += (frameEndTime - now);
	frameTimeSamples++;
	statsFrameCount++;
}

// Use setImmediate for the render loop — fires on next event loop tick
// without the 1-4ms minimum delay that setTimeout(0) imposes on Windows.
let renderRunning = true;
function renderLoop() {
	if (!renderRunning) return;
	renderFrame();
	setImmediate(renderLoop);
}
renderLoop();

// ── DComp initialization ────────────────────────────────────────────────────

// ── Stats push ──────────────────────────────────────────────────────────────

// DComp is already initialized by enableMode. Push render stats to HUD.
let statsFrameCount = 0;
let lastStatsTime = performance.now();
let avgFrameTimeMs = 0;
let frameTimeSamples = 0;

setInterval(() => {
	const now = performance.now();
	const elapsed = (now - lastStatsTime) / 1000;
	const fps = elapsed > 0 ? Math.round(statsFrameCount / elapsed) : 0;
	const ft = frameTimeSamples > 0 ? (avgFrameTimeMs / frameTimeSamples) : 0;
	statsFrameCount = 0;
	avgFrameTimeMs = 0;
	frameTimeSamples = 0;
	lastStatsTime = now;

	win.setTitle(`Three.js + SolidJS + DComp | ${fps} FPS | ${ft.toFixed(1)}ms | Cubes: ${cubes.length}`);

	const js = `if(window.__updateDCompStats){window.__updateDCompStats(${fps},${ft.toFixed(2)},${cubes.length})}`;
	try { win.webview.executeJavascript(js); } catch {}
}, 1000);

// ── Cleanup ─────────────────────────────────────────────────────────────────

win.on("close", () => {
	if (dropTimer) clearInterval(dropTimer);
	renderRunning = false;
	DCompBridge.shutdown();
});

console.log("Unified Demo: Three.js WGPU -> DComp -> SolidJS — single window!");
