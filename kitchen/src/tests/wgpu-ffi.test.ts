import { defineTest, expect } from "../test-framework/types";
import { GpuWindow, WGPU, WGPUBridge } from "electrobun/bun";
import { CString, ptr } from "bun:ffi";

const WGPUNative = WGPU.native;

const WGPUSType_SurfaceSourceMetalLayer = 0x00000004;
const WGPUTextureFormat_BGRA8UnormSrgb = 0x0000001c;
const WGPUTextureUsage_RenderAttachment = 0x0000000000000010n;
const WGPUVertexStepMode_Vertex = 0x00000001;
const WGPUPrimitiveTopology_TriangleList = 0x00000004;
const WGPUFrontFace_CCW = 0x00000001;
const WGPUCullMode_None = 0x00000001;
const WGPUPresentMode_Fifo = 0x00000001;
const WGPUCompositeAlphaMode_Opaque = 0x00000001;
const WGPULoadOp_Clear = 0x00000002;
const WGPUStoreOp_Store = 0x00000001;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;

function writePtr(view: DataView, offset: number, value: number | bigint | null) {
	view.setBigUint64(offset, BigInt(value ?? 0), true);
}

function writeU32(view: DataView, offset: number, value: number | bigint) {
	view.setUint32(offset, Number(value) >>> 0, true);
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

function makeVertexStateNoBuffers(modulePtr: number, entryPointPtr: number) {
	const buffer = new ArrayBuffer(64);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, modulePtr);
	writePtr(view, 16, entryPointPtr);
	writeU64(view, 24, WGPU_STRLEN);
	writeU64(view, 32, 0n);
	writePtr(view, 40, 0);
	writeU64(view, 48, 0n);
	writePtr(view, 56, 0);
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
	writeU32(view, 20, WGPUCullMode_None);
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
	view.setFloat64(40, 0.15, true);
	view.setFloat64(48, 0.15, true);
	view.setFloat64(56, 0.15, true);
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

export const wgpuFfiTests = [
	defineTest({
		name: "WGPU FFI smoke test",
		category: "WGPU",
		description: "Create WGPU instance/surface and render a frame",
		async run({ log }) {
			if (!WGPUNative.available) {
				log("WGPU native library not available; skipping");
				return;
			}
			if (process.platform !== "darwin") {
				log("WGPU smoke test only implemented on macOS for now");
				return;
			}

			const win = new GpuWindow({
				title: "WGPU FFI Smoke",
				frame: { width: 360, height: 260, x: 200, y: 120 },
				titleBarStyle: "default",
				transparent: false,
			});

			const layerPtr = win.wgpuView.getNativeHandle();
			expect(!!layerPtr).toBeTruthy();

			const instance = WGPUNative.symbols.wgpuCreateInstance(0);
			const metalLayerDesc = makeSurfaceSourceMetalLayer(layerPtr as number);
			const surfaceDesc = makeSurfaceDescriptor(metalLayerDesc.ptr as number);
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
			expect(adapter).toBeGreaterThan(0);
			expect(device).toBeGreaterThan(0);

			const queue = WGPUNative.symbols.wgpuDeviceGetQueue(device);
			expect(!!queue).toBeTruthy();

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
			WGPUBridge.surfaceConfigure(surface as number, surfaceConfig.ptr as number);

			const shaderText = `
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.2, 0.2, 0.25, 1.0);
}
`;
			const shaderBytes = new TextEncoder().encode(shaderText + "\0");
			const shaderBuf = new Uint8Array(shaderBytes);
			const shaderPtr = ptr(shaderBuf);
			const shaderSource = makeShaderSourceWGSL(shaderPtr);
			const shaderDesc = makeShaderModuleDescriptor(shaderSource.ptr as number);
			const shaderModule = WGPUNative.symbols.wgpuDeviceCreateShaderModule(
				device,
				shaderDesc.ptr as number,
			);
			expect(!!shaderModule).toBeTruthy();

			const entryPoint = new CString("vs_main");
			const fragEntryPoint = new CString("fs_main");
			const vertexState = makeVertexStateNoBuffers(
				shaderModule,
				entryPoint.ptr,
			);
			const colorTarget = makeColorTargetState(pick.format);
			const fragmentState = makeFragmentState(
				shaderModule,
				fragEntryPoint.ptr,
				colorTarget.ptr as number,
			);
			const primitiveState = makePrimitiveState();
			const multisampleState = makeMultisampleState();
			const pipelineDesc = makeRenderPipelineDescriptor(
				vertexState,
				primitiveState,
				multisampleState,
				fragmentState,
			);
			const pipeline = WGPUNative.symbols.wgpuDeviceCreateRenderPipeline(
				device,
				pipelineDesc.ptr as number,
			);
			expect(!!pipeline).toBeTruthy();

			const renderOnce = () => {
				const surfaceTexture = makeSurfaceTexture();
				WGPUBridge.surfaceGetCurrentTexture(
					surface as number,
					surfaceTexture.ptr as number,
				);
				const status = surfaceTexture.view.getUint32(16, true);
				if (status !== 1 && status !== 2) {
					throw new Error(`Surface status ${status}`);
				}
				const texPtr = Number(surfaceTexture.view.getBigUint64(8, true));
				if (!texPtr) throw new Error("Surface texture null");
				const textureView = WGPUNative.symbols.wgpuTextureCreateView(texPtr, 0);
				if (!textureView) throw new Error("Texture view null");

				const colorAttachment = makeRenderPassColorAttachment(textureView);
				const renderPassDesc = makeRenderPassDescriptor(colorAttachment.ptr as number);
				const encoderDesc = makeCommandEncoderDescriptor();
				const encoder = WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(
					device,
					encoderDesc.ptr as number,
				);
				const pass = WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(
					encoder,
					renderPassDesc.ptr as number,
				);
				WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(pass, pipeline);
				WGPUNative.symbols.wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
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

			renderOnce();

			const newConfig = makeSurfaceConfiguration(
				device,
				size.width + 20,
				size.height + 10,
				pick.format,
				pick.alphaMode,
			);
			WGPUBridge.surfaceConfigure(surface as number, newConfig.ptr as number);
			renderOnce();

			win.close();
		},
	}),
];
