// Interactive WGPUView tests

import { defineTest } from "../../test-framework/types";
import {
	GpuWindow,
	Screen,
	WGPU,
	WGPUBridge,
	three,
	babylon,
	webgpu,
} from "electrobun/bun";
import { ptr, CString } from "bun:ffi";
import { inflateSync } from "zlib";

const WGPU_KEEPALIVE: any[] = [];

const WGPUNative = WGPU.native;

const WGPUSType_SurfaceSourceMetalLayer = 0x00000004;
const WGPUCallbackMode_AllowSpontaneous = 0x00000003;
const WGPUTextureFormat_BGRA8Unorm = 0x0000001b;
const WGPUTextureFormat_BGRA8UnormSrgb = 0x0000001c;
const WGPUTextureFormat_RGBA8UnormSrgb = 0x00000017;
const WGPUTextureUsage_RenderAttachment = 0x0000000000000010n;
const WGPUTextureUsage_CopyDst = 0x0000000000000002n;
const WGPUTextureUsage_TextureBinding = 0x0000000000000004n;
const WGPUBufferUsage_Vertex = 0x0000000000000020n;
const WGPUBufferUsage_CopyDst = 0x0000000000000008n;
const WGPUVertexFormat_Float32 = 0x0000001c;
const WGPUVertexFormat_Float32x2 = 0x0000001d;
const WGPUVertexFormat_Float32x3 = 0x0000001e;
const WGPUVertexStepMode_Vertex = 0x00000001;
const WGPUPrimitiveTopology_TriangleList = 0x00000004;
const WGPUFrontFace_CCW = 0x00000001;
const WGPUCullMode_None = 0x00000001;
const WGPUCullMode_Back = 0x00000003;
const WGPUPresentMode_Fifo = 0x00000001;
const WGPUCompositeAlphaMode_Auto = 0x00000000;
const WGPUCompositeAlphaMode_Opaque = 0x00000001;
const WGPUCompositeAlphaMode_Premultiplied = 0x00000002;
const WGPUCompositeAlphaMode_Unpremultiplied = 0x00000003;
const WGPULoadOp_Clear = 0x00000002;
const WGPUStoreOp_Store = 0x00000001;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;
const WGPUTextureAspect_All = 0x00000001;
const WGPUTextureDimension_2D = 0x00000002;
const WGPUAddressMode_ClampToEdge = 0x00000001;
const WGPUFilterMode_Linear = 0x00000002;
const WGPUMipmapFilterMode_Linear = 0x00000002;

function writePtr(
	view: DataView,
	offset: number,
	value: number | bigint | null,
) {
	view.setBigUint64(offset, BigInt(value ?? 0), true);
}

function writeU32(view: DataView, offset: number, value: number) {
	view.setUint32(offset, value >>> 0, true);
}

function writeU64(view: DataView, offset: number, value: bigint) {
	view.setBigUint64(offset, value, true);
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

function makeRequestAdapterOptions(surfacePtr: number) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, 0);
	writeU32(view, 12, 0);
	writeU32(view, 16, 0);
	writeU32(view, 20, 0);
	writePtr(view, 24, surfacePtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeRequestAdapterCallbackInfo(callbackPtr: number) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUCallbackMode_AllowSpontaneous);
	writeU32(view, 12, 0);
	writePtr(view, 16, callbackPtr);
	writePtr(view, 24, 0);
	writePtr(view, 32, 0);
	return { buffer, ptr: ptr(buffer) };
}

function makeRequestDeviceCallbackInfo(callbackPtr: number) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUCallbackMode_AllowSpontaneous);
	writeU32(view, 12, 0);
	writePtr(view, 16, callbackPtr);
	writePtr(view, 24, 0);
	writePtr(view, 32, 0);
	return { buffer, ptr: ptr(buffer) };
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

function makeVertexAttribute(
	offset: number,
	shaderLocation: number,
	format = WGPUVertexFormat_Float32x3,
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
	arrayStride = 12n,
) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUVertexStepMode_Vertex);
	writeU32(view, 12, 0);
	writeU64(view, 16, arrayStride);
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

function makeVertexState(
	modulePtr: number,
	entryPointPtr: number,
	entryPointLen: bigint,
	bufferLayoutPtr: number,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPointPtr);
	writeU64(view, 24, entryPointLen);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, 1n);
	writePtr(view, 56, bufferLayoutPtr);
	return { buffer, ptr: ptr(buffer) };
}

function makeFragmentState(
	modulePtr: number,
	entryPointPtr: number,
	entryPointLen: bigint,
	targetPtr: number,
) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPointPtr);
	writeU64(view, 24, entryPointLen);
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
	layoutPtr: number,
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
	writePtr(view, 24, layoutPtr);
	new Uint8Array(buffer, 32, 64).set(new Uint8Array(vertexStatePtr.buffer));
	new Uint8Array(buffer, 96, 32).set(new Uint8Array(primitiveStatePtr.buffer));
	writePtr(view, 128, 0);
	new Uint8Array(buffer, 136, 24).set(
		new Uint8Array(multisampleStatePtr.buffer),
	);
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

function makeRenderPassColorAttachment(
	viewPtr: number,
	clear = { r: 0.1, g: 0.2, b: 0.35, a: 1.0 },
) {
	const buffer = new ArrayBuffer(72);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, viewPtr);
	writeU32(view, 16, WGPU_DEPTH_SLICE_UNDEFINED);
	writeU32(view, 20, 0);
	writePtr(view, 24, 0);
	writeU32(view, 32, WGPULoadOp_Clear);
	writeU32(view, 36, WGPUStoreOp_Store);
	view.setFloat64(40, clear.r, true);
	view.setFloat64(48, clear.g, true);
	view.setFloat64(56, clear.b, true);
	view.setFloat64(64, clear.a, true);
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

function makeSurfaceConfiguration(
	devicePtr: number,
	width: number,
	height: number,
	format: number,
	alphaMode: number,
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
	writeU32(view, 56, alphaMode);
	writeU32(view, 60, WGPUPresentMode_Fifo);
	return { buffer, ptr: ptr(buffer) };
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

function pickSurfaceFormatAlpha(
	capsView: DataView,
	preferredFormat: number,
): { format: number; alphaMode: number } {
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

function pickAlphaMode(capsView: DataView) {
	const alphaCount = readU64(capsView, 48);
	const alphaPtr = readPtr(capsView, 56);
	if (alphaCount && alphaPtr) {
		const alphas = new Uint32Array(
			(ptr as any)(alphaPtr).buffer,
			(ptr as any)(alphaPtr).byteOffset,
			alphaCount,
		);
		const preferred = [
			WGPUCompositeAlphaMode_Unpremultiplied,
			WGPUCompositeAlphaMode_Premultiplied,
			WGPUCompositeAlphaMode_Auto,
			WGPUCompositeAlphaMode_Opaque,
		];
		for (const mode of preferred) {
			for (let i = 0; i < alphas.length; i += 1) {
				if (alphas[i] === mode) return mode;
			}
		}
		return alphas[0] ?? WGPUCompositeAlphaMode_Opaque;
	}
	return WGPUCompositeAlphaMode_Opaque;
}

function pickAlphaModeTransparent(capsView: DataView) {
	const alphaCount = readU64(capsView, 48);
	const alphaPtr = readPtr(capsView, 56);
	if (alphaCount && alphaPtr) {
		const alphas = new Uint32Array(
			(ptr as any)(alphaPtr).buffer,
			(ptr as any)(alphaPtr).byteOffset,
			alphaCount,
		);
		const preferred = [
			WGPUCompositeAlphaMode_Unpremultiplied,
			WGPUCompositeAlphaMode_Premultiplied,
			WGPUCompositeAlphaMode_Auto,
		];
		for (const mode of preferred) {
			for (let i = 0; i < alphas.length; i += 1) {
				if (alphas[i] === mode) return mode;
			}
		}
	}
	return pickAlphaMode(capsView);
}

function makeCommandBufferArray(cmdPtr: number) {
	const buffer = new BigUint64Array([BigInt(cmdPtr)]);
	return { buffer, ptr: ptr(buffer) };
}

function decodePngRGBA(png: Uint8Array) {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	for (let i = 0; i < signature.length; i += 1) {
		if (png[i] !== signature[i]) throw new Error("Invalid PNG signature");
	}

	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	const idatChunks: Uint8Array[] = [];

	const readU32BE = (pos: number) => view.getUint32(pos, false);

	while (offset + 8 <= png.length) {
		const length = readU32BE(offset);
		offset += 4;
		const type = String.fromCharCode(
			png[offset]!,
			png[offset + 1]!,
			png[offset + 2]!,
			png[offset + 3]!,
		);
		offset += 4;
		const data = png.subarray(offset, offset + length);
		offset += length;
		offset += 4; // CRC

		if (type === "IHDR") {
			const ihdrView = new DataView(
				data.buffer,
				data.byteOffset,
				data.byteLength,
			);
			width = ihdrView.getUint32(0, false);
			height = ihdrView.getUint32(4, false);
			bitDepth = data[8]!;
			colorType = data[9]!;
			interlace = data[12]!;
		} else if (type === "IDAT") {
			idatChunks.push(data);
		} else if (type === "IEND") {
			break;
		}
	}

	if (!width || !height) throw new Error("PNG missing IHDR");
	if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
		throw new Error("PNG must be 8-bit RGBA non-interlaced");
	}

	const total = idatChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const compressed = new Uint8Array(total);
	let cursor = 0;
	for (const chunk of idatChunks) {
		compressed.set(chunk, cursor);
		cursor += chunk.length;
	}

	const raw = inflateSync(compressed);
	const bpp = 4;
	const stride = width * bpp;
	const output = new Uint8Array(width * height * bpp);
	let inOffset = 0;

	const paeth = (a: number, b: number, c: number) => {
		const p = a + b - c;
		const pa = Math.abs(p - a);
		const pb = Math.abs(p - b);
		const pc = Math.abs(p - c);
		if (pa <= pb && pa <= pc) return a;
		if (pb <= pc) return b;
		return c;
	};

	for (let y = 0; y < height; y += 1) {
		const filter = raw[inOffset++]!;
		const row = raw.subarray(inOffset, inOffset + stride);
		inOffset += stride;
		const outRow = y * stride;

		for (let x = 0; x < stride; x += 1) {
			const left = x >= bpp ? output[outRow + x - bpp]! : 0;
			const up = y > 0 ? output[outRow - stride + x]! : 0;
			const upLeft = y > 0 && x >= bpp ? output[outRow - stride + x - bpp]! : 0;
			const rawVal = row[x]!;
			let val = rawVal;
			if (filter === 1) val = (rawVal + left) & 0xff;
			else if (filter === 2) val = (rawVal + up) & 0xff;
			else if (filter === 3)
				val = (rawVal + Math.floor((left + up) / 2)) & 0xff;
			else if (filter === 4) val = (rawVal + paeth(left, up, upLeft)) & 0xff;
			output[outRow + x] = val;
		}
	}

	return { width, height, data: output };
}

function alignTo(value: number, alignment: number) {
	return Math.ceil(value / alignment) * alignment;
}

const LOGO_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA0XpUWHRSYXcgcHJvZmlsZSB0eXBlIGV4aWYAAHjabVHbEcMgDPv3FB0BEA8zDmnoXTfo+DXYSUOuymFsiVOMof55v+gxEMAUU+Fcc3aCWGMNTRJ2ijajd3HGiWCS1AtPpxCEguzQkrOdP3h/GujWJEsXI36asK1CjebPNyP7EUZHo4vdjKoZIajgzaDptVyuXK5X2LpbwbpoBBS9+mFyr2OR6e1JSITQ4eEkAqwNYKxIaJJkiVLIQS9fQwJP5piZDOTfnNx4GeuWlpfAT1h4A30B9LpipE7bZioAAAGEaUNDUElDQyBwcm9maWxlAAB4nH2RPUjDQBzFX1u1IpUOdiiikKE62UVFHGsVilAh1AqtOphc+gVNGpIUF0fBteDgx2LVwcVZVwdXQRD8AHF2cFJ0kRL/lxRaxHhw3I939x537wB/s8pUsycBqJplZFJJIZdfFYKv6EMUYYzCJzFTnxPFNDzH1z18fL2L8yzvc3+OQaVgMsAnECeYbljEG8Qzm5bOeZ84wsqSQnxOPGHQBYkfuS67/Ma55LCfZ0aMbGaeOEIslLpY7mJWNlTiaeKYomqU78+5rHDe4qxW66x9T/7CUEFbWeY6zRGksIgliBAgo44KqrAQp1UjxUSG9pMe/mHHL5JLJlcFjBwLqEGF5PjB/+B3t2ZxatJNCiWB3hfb/hgDgrtAq2Hb38e23ToBAs/Aldbx15rA7CfpjY4WOwLC28DFdUeT94DLHSD6pEuG5EgBmv5iEXg/o2/KA0O3wMCa21t7H6cPQJa6St8AB4fAeImy1z3e3d/d279n2v39AFmAcpwNAxNFAAAN5WlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iWE1QIENvcmUgNC40LjAtRXhpdjIiPgogPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iCiAgICB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIgogICAgeG1sbnM6R0lNUD0iaHR0cDovL3d3dy5naW1wLm9yZy94bXAvIgogICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICAgeG1sbnM6ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iCiAgICB4bWxuczp0aWZmPSJodHRwOi8vbnMuYWRvYmUuY29tL3RpZmYvMS4wLyIKICAgIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIKICAgeG1wTU06RG9jdW1lbnRJRD0iZ2ltcDpkb2NpZDpnaW1wOjM4MjdmZDM1LTRkZDgtNGFjZS04MWY1LTQyMTVhOTQzOWY3MiIKICAgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo0MjcwODYxMS1jYTI5LTQyMjMtYjAwZi0wMmU0ODA3YzBhNjgiCiAgIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDplYjBiOGJjZS03MmNjLTQ3ZmUtOWY5Yy01OTYyNTBjZTkwM2EiCiAgIEdJTVA6QVBJPSIyLjAiCiAgIEdJTVA6UGxhdGZvcm09Ik1hYyBPUyIKICAgR0lNUDpUaW1lU3RhbXA9IjE3MTkyNDQ3MDMwOTc4NTAiCiAgIEdJTVA6VmVyc2lvbj0iMi4xMC4zOCIKICAgZGM6Rm9ybWF0PSJpbWFnZS9wbmciCiAgIGV4aWY6UGl4ZWxYRGltZW5zaW9uPSIxOTEiCiAgIGV4aWY6UGl4ZWxZRGltZW5zaW9uPSIxOTEiCiAgIHRpZmY6T3JpZW50YXRpb249IjEiCiAgIHhtcDpDcmVhdG9yVG9vbD0iR0lNUCAyLjEwIgogICB4bXA6TWV0YWRhdGFEYXRlPSIyMDI0OjA2OjI0VDExOjU4OjIzLTA0OjAwIgogICB4bXA6TW9kaWZ5RGF0ZT0iMjAyNDowNjoyNFQxMTo1ODoyMy0wNDowMCI+CiAgIDx4bXBNTTpIaXN0b3J5PgogICAgPHJkZjpTZXE+CiAgICAgPHJkZjpsaQogICAgICBzdEV2dDphY3Rpb249InNhdmVkIgogICAgICBzdEV2dDpjaGFuZ2VkPSIvIgogICAgICBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjRkMzUyZThjLTFmNzctNGFhNS1iMDkxLTIxNGU2NmMyZWJlNSIKICAgICAgc3RFdnQ6c29mdHdhcmVBZ2VudD0iR2ltcCAyLjEwIChNYWMgT1MpIgogICAgICBzdEV2dDp3aGVuPSIyMDI0LTA2LTI0VDExOjU4OjIzLTA0OjAwIi8+CiAgICA8L3JkZjpTZXE+CiAgIDwveG1wTU06SGlzdG9yeT4KICA8L3JkZjpEZXNjcmlwdGlvbj4KIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAKPD94cGFja2V0IGVuZD0idyI/Pljb+xIAAAAJcEhZcwAACxMAAAsTAQCanBgAAAAHdElNRQfoBhgPOheBCKUcAAAHpUlEQVRYw8VXbUxU6RV+7r3DICAOiMIwgKJCN12UtTtpibUxbgKGxE7MijYbUFNjsCWtsVStkfhBbNaojavUNVknMXxFE2o0olELKiRoFlyNQElQRGEcoDADw8fM/Zg7977v2x/LTVh3lQ9/9Py7X+ec9znnec65wBwsKSlJwP/LUlNTTQDgcDji6urqDnd0dFy5ePHi5wCwePFiHgASEhL4tLQ007Jly0zT+TPNJvjSpUsFl8ul5+fn20pKSr6KjY1N1TRNttlsywEgKiqKN5vN3MDAAPF4PHQmPk2zgf3NmzfE4XDElZSUfGWxWJLHx8fdvb2937W2tn4bHh7OuVwuHQB27969fO3atWtkWRaLiopqASA8PJxTVZXNCfYFCxZwAGC1WvknT55809fX96irq6v29u3bf3M6nZvtdvs8ACguLv64ra2tUpblYUJIiDHGbt26tQ8A3lWOGSEwf/583u/3E6fT+RebzbZalmVfX19fq8fjeXP69Ombr1690uvq6g6vW7euODw8PCYUCvklSRqKjo5OiYqKigEAQZhj36akpAgAcPTo0V+63e6mnp6e+paWlvMVFRX5KSkpgsPhiOvt7b3PGGOKovgkSfKIojio63rQ5/O9yM3NjQWAuLg4/oO6//HjxxdcLldDZ2fn1ZqamkKr1coXFxd/PD4+3kMICYmiOKgoik8UxUFN0+RAIDCwb9++lUbzzinokiVLBAC4cOGCw+v1/mdgYKClsbHxy9TUVFNJScmnsiwPa5omS5LkkWV5WJIkD6WUjI6Ovty7d+/PAWD58uUmAIiMjOTmLDg1NTWF9+/fL71+/fqfs7OzLXv27PlIluVhVVX9gUBgQJIkTygUEhljrKurqzYvLy8eANLT08M+WHAAIDs725Kfn2/LycmxFBYWLvP5fC80TZONbqeUkqGhoWdVVVXbjG+MkwPAqlWrwtPS0kyzbrytW7cmtLS0nB8dHX0py/KwKIqDkiR5VFX1G9fd3d23KysrCzIyMswAYLFYOJvNJgCAEbSmpqbw0qVLv3sfHX8U/MCBA6vGxsZeMcZYMBgcUxTFFwwGx4LB4JgoioOUUtLc3PzPd/mxWq08AFRXV29XVdU/Pj7es3///lVTn/3IoqOjOQBYvXr1PI/H00YICQUCgYFgMDimqqpfVVV/MBgck2V5OBQKiSMjI50OhyPOcFpUVJSWmZkZDgAxMTEcAOTk5FieP39+7d69e8emitpPmgFZRUVFPqWUBAKBAVVV/RMTE67S0tKs8vLyLww0JEnyMMZYRUVFPgBkZWVFPnz48B8FBQVJxmESExN5ANi0adOi9evXR0+rB0Z9mpqaTlNKiUEzj8fTBgB5eXnxkiR5gsHgmEG5O3fuHDQm4U/x3aAyAMTHx/MzkmJCiMZxHO/1ejvi4uI+io2NTXO73U1ms3m+yWSKoJRqAMBxHK8oiggAdrvd4nK5RADE8GOxWDi32002bNgQMzg4qHR0dKhvx/pBRhz3fXk6OztbJuuVLAiCmRCi2my2Xy1cuPBnhBB1UtvNoij+t7a29iYAKIqiS5L0gxE8MTHBJiehwPOzVOLOzs6rjDFmqJwsy8MGEyRJ8hBCQs+ePbsUHx/PT92QpvL9+PHja7KysiJnFdjYaux2+7zW1tZyQkgoGAyOUUpJY2Pjl/X19UcYY0yW5WG/3+/2+Xwv3G5304MHD44bDWjoQG5ubuyc1repzXLq1Kn1LpergTHGqqqqtjmdzs0GMgY1VVX1G5Strq7e/q6Gm5UtWrSIX7lypRkArl279ifGGLt8+fLvy8vLvzASMBhBKSWMMabrepAxxm7evPlXAFixYsW08vvOLEdGRqiiKBQATCZT2CQ7dEIIAQDGGDWbzdGapsnNzc1lV69e/WN/f/+3mqZJGzduPHnmzJns169f69ON4hnBxBhjAEC/NwIAYWFhUSMjI53btm37pLKy8uvBwcE3k2sYpZTqW7ZsOQwAqqqy95VjVlsxY4waCBBC1CNHjmxxOByf7dq1618AoGmapOu6QinVrFbrp6WlpVmlpaWPo6Ojufj4eN7r9dK5IkCnIEABoLu7+989PT2jBQUF34RCoYAkSUO6riscx/GUUj0sLCzKZrMl7dy5c8natWtjvF4vnbESTllGBQC6cU0ppUY5AoGANzMzM8lkMkVomiYJgmB+S9T4QCDg37Fjxx/S09M/S05O/rXX66WRkZGcLMtsWgQSEhL49vZ29W0kDDQIIZogCALHcfy7UJMkSRJFcTQpKWmN0+ncDACJiYnCtAhYrVZ+aGiIHjp06BcvX74cMPR+aglUVZUm7+mUUt1IhFKqR0RExI2OjnY5nc7vGhoaSqYyadoSJCcnC/39/eTgwYOfnDhx4tmVK1d2KooiAQDP87wgCKbJWRDG8zwXFhYWZTKZIqZCHwqFAufOndt+7Nixz9PT03/b29t77+zZszcAwOPxkPcmoGkam3TENTc3l929e/eexWKJzMjI+Prp06dtsiyrdrv9/KNHj+60t7f3NTQ0/N14nxCih0Ihpb6+/lZZWdnzGzdu/Ka+vv7IyZMnyzo6OtSEhAR+Rv+MsbGxHD7Qpi6175Pm/wFw34ZVYdhjdwAAAABJRU5ErkJggg==";

const cubeVertices = [
	// front
	-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5,
	0.5, -0.5, 0.5, 0.5,
	// back
	-0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.5, 0.5,
	-0.5, 0.5, -0.5, -0.5,
	// left
	-0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5,
	0.5, 0.5, -0.5, 0.5, -0.5,
	// right
	0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5,
	0.5, 0.5, -0.5, 0.5,
	// top
	-0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
	0.5, 0.5, 0.5, -0.5,
	// bottom
	-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5,
	-0.5, 0.5, -0.5, -0.5, 0.5,
];

function buildRotatedVertices(angle: number) {
	const out = new Float32Array(cubeVertices.length);
	const sinY = Math.sin(angle);
	const cosY = Math.cos(angle);
	const sinX = Math.sin(angle * 0.7);
	const cosX = Math.cos(angle * 0.7);

	for (let i = 0; i < cubeVertices.length; i += 3) {
		let x = cubeVertices[i]!;
		let y = cubeVertices[i + 1]!;
		let z = cubeVertices[i + 2]!;

		// rotate Y
		let x1 = x * cosY + z * sinY;
		let z1 = -x * sinY + z * cosY;

		// rotate X
		let y1 = y * cosX - z1 * sinX;
		let z2 = y * sinX + z1 * cosX;

		const depth = z2 + 2.5;
		const proj = 1.2 / depth;

		out[i] = x1 * proj;
		out[i + 1] = y1 * proj;
		out[i + 2] = 0;
	}

	return out;
}

export const wgpuViewTests = [
  defineTest({
    name: "WGPUView native cube",
		category: "WGPUView (Interactive)",
		description: "Render a rotating cube using native WGPU on the main thread",
		interactive: true,
		timeout: 120000,
		async run({ log, showInstructions }) {
			await showInstructions([
				"A GPU window will open",
				"You should see a rotating cube",
				"Close the window when done",
			]);

			log("Opening WGPUView native cube window");

			await new Promise<void>((resolve) => {
				const win = new GpuWindow({
					title: "WGPU Native Cube",
					frame: { width: 500, height: 400, x: 240, y: 160 },
					titleBarStyle: "default",
					transparent: false,
				});

				win.setAlwaysOnTop(true);

				if (process.platform !== "darwin") {
					log("Native WGPU test only implemented on macOS for now");
				} else {
					WGPUBridge.runTest(win.wgpuViewId);
					log("WGPU native test started");
				}

				win.on("close", () => resolve());
			});
		},
  }),
	defineTest({
		name: "Three.js WGPU playground",
		category: "WGPUView (Interactive)",
		description: "Use three.js math + raycasting with WGPU rendering",
		interactive: true,
		timeout: 120000,
		async run({ log, showInstructions }) {
			await showInstructions([
				"A GPU window will open",
				"Click and drag across the cube to fling it",
				"Move the mouse over the cube to change the background",
				"Close the window when done",
			]);

			log("Opening Three.js playground window");

			await new Promise<void>((resolve) => {
				const win = new GpuWindow({
					title: "Three.js WGPU Playground",
					frame: { width: 600, height: 450, x: 260, y: 180 },
					titleBarStyle: "default",
					transparent: false,
				});

				win.setAlwaysOnTop(true);

				if (!WGPUNative.available) {
					log("WGPU native library not available");
					return;
				}
				if (process.platform !== "darwin") {
					log("Three.js playground only implemented on macOS for now");
					return;
				}

				const layerPtr = win.wgpuView.getNativeHandle();
				if (!layerPtr) {
					log("Failed to get WGPUView native handle");
					return;
				}

				const start = async () => {
					const instance = WGPUNative.symbols.wgpuCreateInstance(0);
					const metalLayerDesc = makeSurfaceSourceMetalLayer(
						layerPtr as number,
					);
					const surfaceDesc = makeSurfaceDescriptor(
						metalLayerDesc.ptr as number,
					);
					const surface = WGPUBridge.instanceCreateSurface(
						instance as number,
						surfaceDesc.ptr as number,
					);

					const adapterDevice = new BigUint64Array(2);
					WGPUBridge.createAdapterDeviceMainThread(
						instance as number,
						surface as number,
						ptr(adapterDevice),
					);
					const adapter = Number(adapterDevice[0]);
					const device = Number(adapterDevice[1]);
					if (!adapter || !device) {
						log("WGPU: adapter/device is null");
						return;
					}

					const queue = WGPUNative.symbols.wgpuDeviceGetQueue(device);

					const size = win.getSize();
					const caps = makeSurfaceCapabilities();
					WGPUNative.symbols.wgpuSurfaceGetCapabilities(
						surface,
						adapter,
						caps.ptr as number,
					);
					const pick = pickSurfaceFormatAlpha(
						caps.view,
						WGPUTextureFormat_BGRA8UnormSrgb,
					);
					const surfaceConfig = makeSurfaceConfiguration(
						device,
						size.width,
						size.height,
						pick.format,
						pick.alphaMode,
					);
					WGPUBridge.surfaceConfigure(
						surface as number,
						surfaceConfig.ptr as number,
					);

					const geometry = new three.BoxGeometry(
						0.55,
						0.55,
						0.55,
					).toNonIndexed();
					geometry.computeBoundingSphere();
					const mesh = new three.Mesh(
						geometry,
						new three.MeshBasicMaterial({ color: 0x00ff88 }),
					);
					const camera = new three.PerspectiveCamera(
						50,
						size.width / size.height,
						0.1,
						10,
					);
					camera.position.z = 2.6;
					camera.updateMatrixWorld();

					const raycaster = new three.Raycaster();
					const mouse = new three.Vector2();
					const drag = { active: false, lastX: 0, lastY: 0 };
					const dragVel = new three.Vector2(0, 0);
					const pos = new three.Vector3(0, 0, 0);
					const vel = new three.Vector2(0.004, 0.003);
					const bounds = 0.75;

					const positions = geometry.attributes.position.array as Float32Array;
					const normals = geometry.attributes.normal.array as Float32Array;
					const uvs = geometry.attributes.uv.array as Float32Array;
					const masks = new Float32Array(positions.length / 3);
					for (let i = 0; i < normals.length; i += 3) {
						const nx = normals[i]!;
						const ny = normals[i + 1]!;
						const nz = normals[i + 2]!;
            const faceMask =
              nz > 0.9 || nz < -0.9 || nx > 0.9 || nx < -0.9 ? 1 : 0;
						masks[i / 3] = faceMask;
					}
					const projected = new Float32Array(positions.length);

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
					const shaderSource = makeShaderSourceWGSL(shaderPtr, WGPU_STRLEN);
					const shaderDesc = makeShaderModuleDescriptor(
						shaderSource.ptr as number,
					);
					const shaderModule = WGPUNative.symbols.wgpuDeviceCreateShaderModule(
						device,
						shaderDesc.ptr as number,
					);
					if (!shaderModule) {
						log("WGPU: shaderModule is null");
						return;
					}

					const entryPoint = new CString("vs_main");
					const fragEntryPoint = new CString("fs_main");
					WGPU_KEEPALIVE.push(entryPoint, fragEntryPoint);
					const posAttr = makeVertexAttribute(0, 0, WGPUVertexFormat_Float32x3);
					const normalAttr = makeVertexAttribute(
						12,
						1,
						WGPUVertexFormat_Float32x3,
					);
					const uvAttr = makeVertexAttribute(24, 2, WGPUVertexFormat_Float32x2);
					const maskAttr = makeVertexAttribute(32, 3, WGPUVertexFormat_Float32);
					const colorAttr = makeVertexAttribute(
						36,
						4,
						WGPUVertexFormat_Float32x3,
					);
					const attrBuf = new ArrayBuffer(32 * 5);
					new Uint8Array(attrBuf, 0, 32).set(new Uint8Array(posAttr.buffer));
					new Uint8Array(attrBuf, 32, 32).set(
						new Uint8Array(normalAttr.buffer),
					);
					new Uint8Array(attrBuf, 64, 32).set(new Uint8Array(uvAttr.buffer));
					new Uint8Array(attrBuf, 96, 32).set(new Uint8Array(maskAttr.buffer));
					new Uint8Array(attrBuf, 128, 32).set(new Uint8Array(colorAttr.buffer));
					const attrPtr = ptr(attrBuf);
					WGPU_KEEPALIVE.push(attrBuf);
					const vertexLayout = makeVertexBufferLayout(
						attrPtr as number,
						5,
						48n,
					);
					const vertexState = makeVertexState(
						shaderModule,
						entryPoint.ptr,
						WGPU_STRLEN,
						vertexLayout.ptr as number,
					);
					const colorTarget = makeColorTargetState(pick.format);
					const fragmentState = makeFragmentState(
						shaderModule,
						fragEntryPoint.ptr,
						WGPU_STRLEN,
						colorTarget.ptr as number,
					);
					const primitiveState = makePrimitiveState();
					const multisampleState = makeMultisampleState();
					const pipelineDesc = makeRenderPipelineDescriptor(
						0,
						vertexState,
						primitiveState,
						multisampleState,
						fragmentState,
					);

					const pipeline = WGPUNative.symbols.wgpuDeviceCreateRenderPipeline(
						device,
						pipelineDesc.ptr as number,
					);
					if (!pipeline) {
						log("WGPU: pipeline is null");
						return;
					}

					const packed = new Float32Array((positions.length / 3) * 12);
					for (let i = 0; i < positions.length; i += 3) {
						const idx = (i / 3) * 12;
						const uvIndex = (i / 3) * 2;
						const mask = masks[i / 3]!;
						let u = uvs[uvIndex]!;
						let v = uvs[uvIndex + 1]!;
						if (mask > 0.5) v = 1 - v;
						packed[idx] = positions[i]!;
						packed[idx + 1] = positions[i + 1]!;
						packed[idx + 2] = positions[i + 2]!;
						packed[idx + 3] = normals[i]!;
						packed[idx + 4] = normals[i + 1]!;
						packed[idx + 5] = normals[i + 2]!;
						packed[idx + 6] = u;
						packed[idx + 7] = v;
						packed[idx + 8] = mask;
						packed[idx + 9] = 0.04;
						packed[idx + 10] = 0.04;
						packed[idx + 11] = 0.04;
					}
					const packedProjected = new Float32Array(packed.length);

					const bufferDesc = makeBufferDescriptor(packedProjected.byteLength);
					const vertexBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(
						device,
						bufferDesc.ptr as number,
					);
					if (!vertexBuffer) {
						log("WGPU: vertexBuffer is null");
						return;
					}

					const logoBytes = Buffer.from(LOGO_PNG_BASE64, "base64");
					const logo = decodePngRGBA(logoBytes);
					const bytesPerRow = alignTo(logo.width * 4, 256);
					const padded = new Uint8Array(bytesPerRow * logo.height);
					for (let y = 0; y < logo.height; y += 1) {
						const src = logo.data.subarray(
							y * logo.width * 4,
							(y + 1) * logo.width * 4,
						);
						padded.set(src, y * bytesPerRow);
					}

					const logoTextureDesc = makeTextureDescriptor(
						logo.width,
						logo.height,
						WGPUTextureFormat_RGBA8UnormSrgb,
						WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst,
					);
					const logoTexture = WGPUNative.symbols.wgpuDeviceCreateTexture(
						device,
						logoTextureDesc.ptr as number,
					);
					if (!logoTexture) {
						log("WGPU: logo texture is null");
						return;
					}
					const logoTextureView = WGPUNative.symbols.wgpuTextureCreateView(
						logoTexture,
						0,
					);
					const samplerDesc = makeSamplerDescriptor();
					const logoSampler = WGPUNative.symbols.wgpuDeviceCreateSampler(
						device,
						samplerDesc.ptr as number,
					);
					if (!logoSampler || !logoTextureView) {
						log("WGPU: logo sampler/view is null");
						return;
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

					const bindGroupLayout =
						WGPUNative.symbols.wgpuRenderPipelineGetBindGroupLayout(
							pipeline,
							0,
						);
					const samplerEntry = makeBindGroupEntrySampler(0, logoSampler);
					const textureEntry = makeBindGroupEntryTexture(1, logoTextureView);
					const entriesBuf = new ArrayBuffer(56 * 2);
					new Uint8Array(entriesBuf, 0, 56).set(
						new Uint8Array(samplerEntry.buffer),
					);
					new Uint8Array(entriesBuf, 56, 56).set(
						new Uint8Array(textureEntry.buffer),
					);
					const entriesPtr = ptr(entriesBuf);
					WGPU_KEEPALIVE.push(entriesBuf);
					const bindGroupDesc = makeBindGroupDescriptor(
						bindGroupLayout,
						entriesPtr as number,
						2,
					);
					const bindGroup = WGPUNative.symbols.wgpuDeviceCreateBindGroup(
						device,
						bindGroupDesc.ptr as number,
					);
					if (!bindGroup) {
						log("WGPU: bindGroup is null");
						return;
					}

					const encoderDesc = makeCommandEncoderDescriptor();
					const v = new three.Vector3();
					const n = new three.Vector3();
					const viewProj = new three.Matrix4();
					const modelViewProj = new three.Matrix4();
					const normalMatrix = new three.Matrix3();
					const rotSpeed = new three.Vector2(0.0014, 0.001);

					const renderFrame = () => {
						const frame = win.getFrame();
						const cursorPos = Screen.getCursorScreenPoint();
						const mx = (cursorPos.x - frame.x) / frame.width;
						const my = (cursorPos.y - frame.y) / frame.height;
						mouse.set(mx * 2 - 1, -(my * 2 - 1));
						raycaster.setFromCamera(mouse, camera);

						const buttons = Screen.getMouseButtons();
						const leftDown = (buttons & 1n) === 1n;
						const hit = raycaster.intersectObject(mesh, false).length > 0;

						if (leftDown && hit) {
							if (!drag.active) {
								drag.active = true;
								drag.lastX = cursorPos.x;
								drag.lastY = cursorPos.y;
							}
							const dx = cursorPos.x - drag.lastX;
							const dy = cursorPos.y - drag.lastY;
							dragVel.set(dx, dy);
							drag.lastX = cursorPos.x;
							drag.lastY = cursorPos.y;
						} else if (drag.active) {
							vel.set(dragVel.x * 0.0006, -dragVel.y * 0.0006);
							drag.active = false;
							dragVel.set(0, 0);
						}

						pos.x += vel.x;
						pos.y += vel.y;
						if (pos.x > bounds || pos.x < -bounds) vel.x *= -1;
						if (pos.y > bounds || pos.y < -bounds) vel.y *= -1;
						pos.x = Math.max(-bounds, Math.min(bounds, pos.x));
						pos.y = Math.max(-bounds, Math.min(bounds, pos.y));

						mesh.position.set(pos.x, pos.y, 0);
						mesh.rotation.y += rotSpeed.x;
						mesh.rotation.x += rotSpeed.y;
						mesh.updateMatrixWorld();
						camera.updateMatrixWorld();
						viewProj.multiplyMatrices(
							camera.projectionMatrix,
							camera.matrixWorldInverse,
						);
						modelViewProj.multiplyMatrices(viewProj, mesh.matrixWorld);
						normalMatrix.getNormalMatrix(mesh.matrixWorld);

						const time = performance.now() * 0.001;
						for (let i = 0; i < positions.length; i += 3) {
							const idx = (i / 3) * 12;
							const uvIndex = (i / 3) * 2;
							v.set(positions[i]!, positions[i + 1]!, positions[i + 2]!);
							v.applyMatrix4(modelViewProj);
							n.set(normals[i]!, normals[i + 1]!, normals[i + 2]!);
							n.applyMatrix3(normalMatrix).normalize();
							const mask = masks[i / 3]!;
							let u = uvs[uvIndex]!;
							let vUv = uvs[uvIndex + 1]!;
							if (mask > 0.5) vUv = 1 - vUv;
							packedProjected[idx] = v.x;
							packedProjected[idx + 1] = v.y;
							packedProjected[idx + 2] = v.z;
							packedProjected[idx + 3] = n.x;
							packedProjected[idx + 4] = n.y;
							packedProjected[idx + 5] = n.z;
							packedProjected[idx + 6] = u;
							packedProjected[idx + 7] = vUv;
							packedProjected[idx + 8] = mask;
							const sparkleSeed = u * 37 + vUv * 57 + n.x * 13 + n.y * 23;
							const sparkle =
								hit && Math.sin(time * 10 + sparkleSeed * 10) > 0.7 ? 1 : 0;
							const sparkleStrength =
								sparkle *
								(0.2 + 0.6 * Math.abs(Math.sin(time * 6 + sparkleSeed)));
							packedProjected[idx + 9] = 0.04 + sparkleStrength * 0.2;
							packedProjected[idx + 10] = 0.04 + sparkleStrength * 0.8;
							packedProjected[idx + 11] = 0.04 + sparkleStrength * 1.0;
						}

						WGPUNative.symbols.wgpuQueueWriteBuffer(
							queue,
							vertexBuffer,
							0,
							ptr(packedProjected),
							packedProjected.byteLength,
						);

						const surfaceTexture = makeSurfaceTexture();
						WGPUBridge.surfaceGetCurrentTexture(
							surface as number,
							surfaceTexture.ptr as number,
						);

						const status = surfaceTexture.view.getUint32(16, true);
						if (status !== 1 && status !== 2) return;
						const texPtr = Number(surfaceTexture.view.getBigUint64(8, true));
						if (!texPtr) return;

						const textureView = WGPUNative.symbols.wgpuTextureCreateView(
							texPtr,
							0,
						);
						if (!textureView) return;

						const clear = { r: 0.02, g: 0.02, b: 0.04, a: 1.0 };

						const colorAttachment = makeRenderPassColorAttachment(
							textureView,
							clear,
						);
						const renderPassDesc = makeRenderPassDescriptor(
							colorAttachment.ptr as number,
						);

						const encoder = WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(
							device,
							encoderDesc.ptr as number,
						);
						const pass = WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(
							encoder,
							renderPassDesc.ptr as number,
						);
						WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(pass, pipeline);
						WGPUNative.symbols.wgpuRenderPassEncoderSetBindGroup(
							pass,
							0,
							bindGroup,
							0,
							0,
						);
						WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(
							pass,
							0,
							vertexBuffer,
							0,
							packedProjected.byteLength,
						);
						WGPUNative.symbols.wgpuRenderPassEncoderDraw(
							pass,
							positions.length / 3,
							1,
							0,
							0,
						);
						WGPUNative.symbols.wgpuRenderPassEncoderEnd(pass);

						const commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(
							encoder,
							0,
						);
						const commandArray = makeCommandBufferArray(commandBuffer);
						WGPUNative.symbols.wgpuQueueSubmit(
							queue,
							1,
							commandArray.ptr as number,
						);
						WGPUBridge.surfacePresent(surface as number);

						WGPUNative.symbols.wgpuTextureViewRelease(textureView);
						WGPUNative.symbols.wgpuTextureRelease(texPtr);
						WGPUNative.symbols.wgpuCommandBufferRelease(commandBuffer);
						WGPUNative.symbols.wgpuCommandEncoderRelease(encoder);
					};

					const interval = setInterval(renderFrame, 16);
					win.on("close", () => clearInterval(interval));
				};

				start().catch((err) => {
					log(`Three.js render setup failed: ${String(err)}`);
				});
			});
		},
	}),
	defineTest({
		name: "Babylon.js WGPU playground",
		category: "WGPUView (Interactive)",
		description: "Use Babylon WebGPUEngine with Electrobun WebGPU adapter",
		interactive: true,
		timeout: 120000,
		async run({ log, showInstructions }) {
			await showInstructions([
				"A GPU window will open",
				"You should see a rotating cube lit with a simple shader",
				"Close the window when done",
			]);

			log("Opening Babylon.js playground window");

			await new Promise<void>((resolve) => {
				const win = new GpuWindow({
					title: "Babylon.js WGPU Playground",
					frame: { width: 600, height: 450, x: 280, y: 200 },
					titleBarStyle: "default",
					transparent: false,
				});

				win.setAlwaysOnTop(true);

				if (!WGPUNative.available) {
					log("WGPU native library not available");
					return;
				}
				if (process.platform !== "darwin") {
					log("Babylon.js playground only implemented on macOS for now");
					return;
				}

				const start = async () => {
					webgpu.install();
					const size = win.getSize();
					const canvas = {
						width: size.width,
						height: size.height,
						clientWidth: size.width,
						clientHeight: size.height,
						style: {},
						getContext: (type: string) => {
							if (type !== "webgpu") return null;
							const ctx = webgpu.createContext(win);
							return ctx.context;
						},
						getBoundingClientRect: () => ({
							left: 0,
							top: 0,
							width: win.getSize().width,
							height: win.getSize().height,
						}),
						addEventListener: () => {},
						removeEventListener: () => {},
						setAttribute: () => {},
					};

					if (!(globalThis as any).requestAnimationFrame) {
						(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
							setTimeout(() => cb(performance.now()), 16) as any;
						(globalThis as any).cancelAnimationFrame = (id: any) =>
							clearTimeout(id);
					}

					const engine = new babylon.WebGPUEngine(canvas as any, {
						antialias: false,
					});
					await engine.initAsync();

					const scene = new babylon.Scene(engine);
					scene.clearColor = new babylon.Color4(0.12, 0.12, 0.14, 1);

					const camera = new babylon.ArcRotateCamera(
						"camera",
						Math.PI / 4,
						Math.PI / 3,
						2.5,
						new babylon.Vector3(0, 0, 0),
						scene,
					);
					camera.attachControl(canvas as any, true);

					const light = new babylon.HemisphericLight(
						"light",
						new babylon.Vector3(0.4, 1, 0.6),
						scene,
					);
					light.intensity = 0.9;

					const box = babylon.MeshBuilder.CreateBox(
						"box",
						{ size: 0.7 },
						scene,
					);
					const material = new babylon.StandardMaterial("mat", scene);
					material.diffuseColor = new babylon.Color3(0.12, 0.12, 0.12);
					material.specularColor = new babylon.Color3(0.4, 0.4, 0.5);
					box.material = material;

					engine.runRenderLoop(() => {
						box.rotation.y += 0.012;
						box.rotation.x += 0.007;
						scene.render();
					});

					win.on("resize", () => {
						const next = win.getSize();
						canvas.width = next.width;
						canvas.height = next.height;
						canvas.clientWidth = next.width;
						canvas.clientHeight = next.height;
						engine.resize();
					});

					win.on("close", () => {
						engine.stopRenderLoop();
						scene.dispose();
						engine.dispose();
					});
				};

				start().catch((err) => {
					log(`Babylon.js render setup failed: ${String(err)}`);
				});
			});
		},
	}),
	defineTest({
		name: "WGPUView basic window",
		category: "WGPUView (Interactive)",
		description: "Open a GPU-backed window and verify it appears",
		interactive: true,
		timeout: 120000,
		async run({ log, showInstructions, waitForUserVerification }) {
			await showInstructions([
				"A blank GPU window will open",
				"You should see an empty window (no webview)",
				"Wait for the view to resize once",
				"Close the window when done",
				"Click Pass if the window opened and resized without crashing",
			]);

			log("Opening WGPUView test window");

			await new Promise<void>((resolve) => {
				const win = new GpuWindow({
					title: "WGPUView Test",
					frame: { width: 500, height: 400, x: 200, y: 120 },
					titleBarStyle: "default",
					transparent: false,
				});

				win.setAlwaysOnTop(true);

				if (!WGPUNative.available) {
					log("WGPU native library not available");
				} else if (process.platform !== "darwin") {
					log("WGPUView rendering test only implemented on macOS for now");
				} else {
					const layerPtr = win.wgpuView.getNativeHandle();
					if (!layerPtr) {
						log("Failed to get WGPUView native handle");
					} else {
						const startRendering = async () => {
							log("WGPU: creating instance + surface");
							await new Promise((resolve) => setTimeout(resolve, 100));
							const instance = WGPUNative.symbols.wgpuCreateInstance(0);
							const metalLayerDesc = makeSurfaceSourceMetalLayer(
								layerPtr as number,
							);
							const surfaceDesc = makeSurfaceDescriptor(
								metalLayerDesc.ptr as number,
							);
							const surface = WGPUBridge.instanceCreateSurface(
								instance as number,
								surfaceDesc.ptr as number,
							);

							const adapterDevice = new BigUint64Array(2);
							WGPUBridge.createAdapterDeviceMainThread(
								instance as number,
								surface as number,
								ptr(adapterDevice),
							);
							const adapter = Number(adapterDevice[0]);
							const device = Number(adapterDevice[1]);
							log(`WGPU: adapter=${adapter} device=${device}`);
							if (!adapter || !device) {
								log("WGPU: adapter/device is null");
								return;
							}
							const queue = WGPUNative.symbols.wgpuDeviceGetQueue(device);

							const size = win.getSize();
							const caps = makeSurfaceCapabilities();
							WGPUNative.symbols.wgpuSurfaceGetCapabilities(
								surface,
								adapter,
								caps.ptr as number,
							);
							const pick = pickSurfaceFormatAlpha(
								caps.view,
								WGPUTextureFormat_BGRA8UnormSrgb,
							);
							log(
								`WGPU: surface format=${pick.format} alpha=${pick.alphaMode}`,
							);
							const surfaceConfig = makeSurfaceConfiguration(
								device,
								size.width,
								size.height,
								pick.format,
								pick.alphaMode,
							);
							WGPUBridge.surfaceConfigure(
								surface as number,
								surfaceConfig.ptr as number,
							);

							const shaderText = `
var<private> gTime: f32 = 0.0;
const REPEAT: f32 = 5.0;

fn rot(a: f32) -> mat2x2<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat2x2<f32>(c, s, -s, c);
}

fn sdBox(p: vec3<f32>, b: vec3<f32>) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn box(pos: vec3<f32>, scale: f32) -> f32 {
  var p = pos * scale;
  let base = sdBox(p, vec3<f32>(0.4, 0.4, 0.1)) / 1.5;
  p.x = p.x * 5.0;
  p.y = p.y * 5.0 - 3.5;
  let xy = rot(0.75) * vec2<f32>(p.x, p.y);
  p.x = xy.x;
  p.y = xy.y;
  let result = -base;
  return result;
}

fn box_set(pos: vec3<f32>, iTime: f32) -> f32 {
  let pos_origin = pos;
  var p = pos_origin;
  p.y = p.y + sin(gTime * 0.4) * 2.5;
  var xy = rot(0.8) * vec2<f32>(p.x, p.y);
  p.x = xy.x;
  p.y = xy.y;
  let box1 = box(p, 2.0 - abs(sin(gTime * 0.4)) * 1.5);
  p = pos_origin;
  p.y = p.y - sin(gTime * 0.4) * 2.5;
  xy = rot(0.8) * vec2<f32>(p.x, p.y);
  p.x = xy.x;
  p.y = xy.y;
  let box2 = box(p, 2.0 - abs(sin(gTime * 0.4)) * 1.5);
  p = pos_origin;
  p.x = p.x + sin(gTime * 0.4) * 2.5;
  xy = rot(0.8) * vec2<f32>(p.x, p.y);
  p.x = xy.x;
  p.y = xy.y;
  let box3 = box(p, 2.0 - abs(sin(gTime * 0.4)) * 1.5);
  p = pos_origin;
  p.x = p.x - sin(gTime * 0.4) * 2.5;
  xy = rot(0.8) * vec2<f32>(p.x, p.y);
  p.x = xy.x;
  p.y = xy.y;
  let box4 = box(p, 2.0 - abs(sin(gTime * 0.4)) * 1.5);
  p = pos_origin;
  xy = rot(0.8) * vec2<f32>(p.x, p.y);
  p.x = xy.x;
  p.y = xy.y;
  let box5 = box(p, 0.5) * 6.0;
  p = pos_origin;
  let box6 = box(p, 0.5) * 6.0;
  let result = max(max(max(max(max(box1, box2), box3), box4), box5), box6);
  return result;
}

fn map(pos: vec3<f32>, iTime: f32) -> f32 {
  let box_set1 = box_set(pos, iTime);
  return box_set1;
}

fn modv(a: vec3<f32>, b: f32) -> vec3<f32> {
  return a - b * floor(a / b);
}

struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) time : f32,
  @location(2) resolution : vec2<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) time: f32,
  @location(2) resolution: vec2<f32>
) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.uv = position;
  out.time = time;
  out.resolution = resolution;
  return out;
}

@fragment
fn fs_main(
  @location(0) uv: vec2<f32>,
  @location(1) time: f32,
  @location(2) resolution: vec2<f32>
) -> @location(0) vec4<f32> {
  let fragCoord = (uv * 0.5 + vec2<f32>(0.5)) * resolution;
  let p = (fragCoord * 2.0 - resolution) / min(resolution.x, resolution.y);
  var ro = vec3<f32>(0.0, -0.2, time * 4.0);
  var ray = normalize(vec3<f32>(p, 1.5));
  var rayxy = rot(sin(time * 0.03) * 5.0) * vec2<f32>(ray.x, ray.y);
  ray.x = rayxy.x;
  ray.y = rayxy.y;
  var rayyz = rot(sin(time * 0.05) * 0.2) * vec2<f32>(ray.y, ray.z);
  ray.y = rayyz.x;
  ray.z = rayyz.y;
  var t = 0.1;
  var col = vec3<f32>(0.0);
  var ac = 0.0;

  for (var i = 0; i < 99; i = i + 1) {
    var pos = ro + ray * t;
    pos = modv(pos - vec3<f32>(2.0), 4.0) - vec3<f32>(2.0);
    gTime = time - f32(i) * 0.01;
    var d = map(pos, time);
    d = max(abs(d), 0.01);
    ac = ac + exp(-d * 23.0);
    t = t + d * 0.55;
  }

  col = vec3<f32>(ac * 0.02);
  col = col + vec3<f32>(0.0, 0.2 * abs(sin(time)), 0.5 + sin(time) * 0.2);
  let alpha = 1.0 - t * (0.02 + 0.02 * sin(time));
  return vec4<f32>(col, alpha);
}
            `;
							const shaderBytes = new TextEncoder().encode(shaderText + "\0");
							const shaderBuf = new Uint8Array(shaderBytes);
							WGPU_KEEPALIVE.push(shaderBuf);
							const shaderPtr = ptr(shaderBuf);
							const shaderSource = makeShaderSourceWGSL(shaderPtr, WGPU_STRLEN);
							const shaderDesc = makeShaderModuleDescriptor(
								shaderSource.ptr as number,
							);
							const shaderModule =
								WGPUNative.symbols.wgpuDeviceCreateShaderModule(
									device,
									shaderDesc.ptr as number,
								);
							if (!shaderModule) {
								log("WGPU: shaderModule is null");
								return;
							}

							const drawEnabled = true;
							const vsName = "vs_main";
							const fsName = "fs_main";
							const entryPoint = new CString(vsName);
							const fragEntryPoint = new CString(fsName);
							WGPU_KEEPALIVE.push(entryPoint, fragEntryPoint);
							const vsLen = WGPU_STRLEN;
							const fsLen = WGPU_STRLEN;
							const posAttr = makeVertexAttribute(0, 0, WGPUVertexFormat_Float32x2);
							const timeAttr = makeVertexAttribute(8, 1, WGPUVertexFormat_Float32);
							const resAttr = makeVertexAttribute(12, 2, WGPUVertexFormat_Float32x2);
							const attrBuf = new ArrayBuffer(32 * 3);
							new Uint8Array(attrBuf, 0, 32).set(new Uint8Array(posAttr.buffer));
							new Uint8Array(attrBuf, 32, 32).set(new Uint8Array(timeAttr.buffer));
							new Uint8Array(attrBuf, 64, 32).set(new Uint8Array(resAttr.buffer));
							const attrPtr = ptr(attrBuf);
							WGPU_KEEPALIVE.push(attrBuf);
							const vertexLayout = makeVertexBufferLayout(attrPtr as number, 3, 20n);
							const vertexState = makeVertexState(
								shaderModule,
								entryPoint.ptr,
								vsLen,
								vertexLayout.ptr as number,
							);
							const colorTarget = makeColorTargetState(pick.format);
							const fragmentState = makeFragmentState(
								shaderModule,
								fragEntryPoint.ptr,
								fsLen,
								colorTarget.ptr as number,
							);
							const primitiveState = makePrimitiveState();
							const multisampleState = makeMultisampleState();
							const pipelineDesc = makeRenderPipelineDescriptor(
								0,
								vertexState,
								primitiveState,
								multisampleState,
								fragmentState,
							);

							const pipeline =
								WGPUNative.symbols.wgpuDeviceCreateRenderPipeline(
									device,
									pipelineDesc.ptr as number,
								);
							if (!pipeline) {
								log("WGPU: pipeline is null");
								return;
							}

							const vertexCount = 3;
							const bufferDesc = makeBufferDescriptor(vertexCount * 5 * 4);
							const vertexBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(
								device,
								bufferDesc.ptr as number,
							);
							if (!vertexBuffer) {
								log("WGPU: vertexBuffer is null");
								return;
							}

							const encoderDesc = makeCommandEncoderDescriptor();

							let frameCount = 0;
							const renderFrame = () => {
								const sizeNow = win.getSize();
								const t = performance.now() * 0.001;
								const positions = [-1, -1, 3, -1, -1, 3];
								const packed = new Float32Array(vertexCount * 5);
								for (let i = 0; i < vertexCount; i += 1) {
									const idx = i * 5;
									packed[idx] = positions[i * 2]!;
									packed[idx + 1] = positions[i * 2 + 1]!;
									packed[idx + 2] = t;
									packed[idx + 3] = sizeNow.width;
									packed[idx + 4] = sizeNow.height;
								}
								WGPUNative.symbols.wgpuQueueWriteBuffer(
									queue,
									vertexBuffer,
									0,
									ptr(packed),
									packed.byteLength,
								);

								WGPUNative.symbols.wgpuInstanceProcessEvents(instance);

								const surfaceTexture = makeSurfaceTexture();
								WGPUBridge.surfaceGetCurrentTexture(
									surface as number,
									surfaceTexture.ptr as number,
								);

								const status = surfaceTexture.view.getUint32(16, true);
								if (status !== 1 && status !== 2) {
									return;
								}

								const texPtr = Number(
									surfaceTexture.view.getBigUint64(8, true),
								);
								if (!texPtr) {
									if (frameCount === 0) log("WGPU: surface texture is null");
									return;
								}

								const textureView = WGPUNative.symbols.wgpuTextureCreateView(
									texPtr,
									0,
								);
								if (!textureView) {
									if (frameCount === 0) log("WGPU: textureView is null");
									return;
								}
								const colorAttachment =
									makeRenderPassColorAttachment(textureView);
								const renderPassDesc = makeRenderPassDescriptor(
									colorAttachment.ptr as number,
								);

								const encoder =
									WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(
										device,
										encoderDesc.ptr as number,
									);

								const pass =
									WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(
										encoder,
										renderPassDesc.ptr as number,
									);
								if (drawEnabled) {
									WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(
										pass,
										pipeline,
									);
									WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(
										pass,
										0,
										vertexBuffer,
										0,
										packed.byteLength,
									);
									WGPUNative.symbols.wgpuRenderPassEncoderDraw(
										pass,
										vertexCount,
										1,
										0,
										0,
									);
								}
								WGPUNative.symbols.wgpuRenderPassEncoderEnd(pass);

								const commandBuffer =
									WGPUNative.symbols.wgpuCommandEncoderFinish(encoder, 0);
								if (!commandBuffer) {
									if (frameCount === 0) log("WGPU: commandBuffer is null");
									return;
								}
								const commandArray = makeCommandBufferArray(commandBuffer);
								WGPUNative.symbols.wgpuQueueSubmit(
									queue,
									1,
									commandArray.ptr as number,
								);
								WGPUBridge.surfacePresent(surface as number);

								WGPUNative.symbols.wgpuTextureViewRelease(textureView);
								WGPUNative.symbols.wgpuTextureRelease(texPtr);
								WGPUNative.symbols.wgpuCommandBufferRelease(commandBuffer);
								WGPUNative.symbols.wgpuCommandEncoderRelease(encoder);
								frameCount += 1;
							};

							const interval = setInterval(renderFrame, 16);

							win.on("close", () => {
								clearInterval(interval);
							});
						};

						startRendering().catch((err) => {
							log(`WGPU render setup failed: ${String(err)}`);
						});
					}
				}

				setTimeout(() => {
					try {
						win.wgpuView.setFrame(20, 20, 300, 200);
						log("Resized WGPUView to 300x200");
					} catch (err) {
						log(`Resize failed: ${String(err)}`);
					}
				}, 1000);

				setTimeout(() => {
					try {
						win.wgpuView.setFrame(0, 0, 500, 400);
						log("Resized WGPUView back to full size");
					} catch (err) {
						log(`Resize failed: ${String(err)}`);
					}
				}, 2000);

				win.on("close", () => {
					log("WGPUView window closed");
					resolve();
				});
			});

			await waitForUserVerification();
		},
	}),
];
