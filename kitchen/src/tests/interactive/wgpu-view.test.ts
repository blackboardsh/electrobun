// Interactive WGPUView tests

import { defineTest } from "../../test-framework/types";
import { GpuWindow, WGPU, WGPUBridge } from "electrobun/bun";
import { JSCallback, ptr, CString } from "bun:ffi";

const CALLBACKS: JSCallback[] = [];
const WGPU_KEEPALIVE: any[] = [];

const WGPUNative = WGPU.native;

const WGPUSType_SurfaceSourceMetalLayer = 0x00000004;
const WGPUCallbackMode_AllowSpontaneous = 0x00000003;
const WGPUTextureFormat_BGRA8Unorm = 0x0000001b;
const WGPUTextureFormat_BGRA8UnormSrgb = 0x0000001c;
const WGPUTextureUsage_RenderAttachment = 0x0000000000000010n;
const WGPUBufferUsage_Vertex = 0x0000000000000020n;
const WGPUBufferUsage_CopyDst = 0x0000000000000008n;
const WGPUVertexFormat_Float32x3 = 0x0000001e;
const WGPUVertexStepMode_Vertex = 0x00000001;
const WGPUPrimitiveTopology_TriangleList = 0x00000004;
const WGPUFrontFace_CCW = 0x00000001;
const WGPUCullMode_None = 0x00000001;
const WGPUPresentMode_Fifo = 0x00000001;
const WGPUCompositeAlphaMode_Auto = 0x00000000;
const WGPUCompositeAlphaMode_Opaque = 0x00000001;
const WGPUCompositeAlphaMode_Premultiplied = 0x00000002;
const WGPUCompositeAlphaMode_Unpremultiplied = 0x00000003;
const WGPULoadOp_Clear = 0x00000002;
const WGPUStoreOp_Store = 0x00000001;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;

function writePtr(view: DataView, offset: number, value: number | bigint | null) {
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

function makeVertexAttribute(offset: number, shaderLocation: number) {
	const buffer = new ArrayBuffer(32);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUVertexFormat_Float32x3);
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
	writeU64(view, 16, 12n);
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
	view.setFloat64(40, 0.9, true);
	view.setFloat64(48, 0.1, true);
	view.setFloat64(56, 0.9, true);
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

function makeCommandBufferArray(cmdPtr: number) {
	const buffer = new BigUint64Array([BigInt(cmdPtr)]);
	return { buffer, ptr: ptr(buffer) };
}

const cubeVertices = [
	// front
	-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5,
	-0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
	// back
	-0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5,
	-0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5,
	// left
	-0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5,
	-0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5,
	// right
	0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5,
	0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5,
	// top
	-0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
	-0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5,
	// bottom
	-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5,
	-0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
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
              log(`WGPU: surface format=${pick.format} alpha=${pick.alphaMode}`);
              const surfaceConfig = makeSurfaceConfiguration(
                device,
                size.width,
                size.height,
                pick.format,
                pick.alphaMode,
              );
              WGPUBridge.surfaceConfigure(surface as number, surfaceConfig.ptr as number);

              const shaderText = `
struct VSOut {
  @builtin(position) position : vec4<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 1.0);
  return out;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(0.1, 0.9, 0.4, 1.0);
}
            `;
              const shaderBytes = new TextEncoder().encode(shaderText + "\0");
              const shaderBuf = new Uint8Array(shaderBytes);
              WGPU_KEEPALIVE.push(shaderBuf);
              const shaderPtr = ptr(shaderBuf);
              const shaderSource = makeShaderSourceWGSL(shaderPtr, WGPU_STRLEN);
              const shaderDesc = makeShaderModuleDescriptor(shaderSource.ptr as number);
              const shaderModule = WGPUNative.symbols.wgpuDeviceCreateShaderModule(
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
              const vertexAttr = makeVertexAttribute(0, 0);
              const vertexLayout = makeVertexBufferLayout(vertexAttr.ptr as number, 1);
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

              const pipeline = WGPUNative.symbols.wgpuDeviceCreateRenderPipeline(
                device,
                pipelineDesc.ptr as number,
              );
              if (!pipeline) {
                log("WGPU: pipeline is null");
                return;
              }

              const vertexData = buildRotatedVertices(0);
              const bufferDesc = makeBufferDescriptor(vertexData.byteLength);
              const vertexBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(
                device,
                bufferDesc.ptr as number,
              );
              if (!vertexBuffer) {
                log("WGPU: vertexBuffer is null");
                return;
              }

              WGPUNative.symbols.wgpuQueueWriteBuffer(
                queue,
                vertexBuffer,
                0,
                ptr(vertexData),
                vertexData.byteLength,
              );

              let angle = 0;
              const encoderDesc = makeCommandEncoderDescriptor();

              let frameCount = 0;
              const renderFrame = () => {
                if (frameCount === 0) {
                  log("WGPU: starting render loop");
                }
                angle += 0.02;
                const updated = buildRotatedVertices(angle);
                WGPUNative.symbols.wgpuQueueWriteBuffer(
                  queue,
                  vertexBuffer,
                  0,
                  ptr(updated),
                  updated.byteLength,
                );

                WGPUNative.symbols.wgpuInstanceProcessEvents(instance);

                const surfaceTexture = makeSurfaceTexture();
                WGPUBridge.surfaceGetCurrentTexture(
                  surface as number,
                  surfaceTexture.ptr as number,
                );

                const status = surfaceTexture.view.getUint32(16, true);
                if (frameCount === 0) {
                  log(`WGPU: surface status=${status}`);
                }
                if (status !== 1 && status !== 2) {
                  return;
                }

                const texPtr = Number(
                  surfaceTexture.view.getBigUint64(8, true),
                );
                if (frameCount === 0) {
                  log(`WGPU: surface texture ptr=${texPtr}`);
                }
                if (!texPtr) {
                  if (frameCount === 0) log("WGPU: surface texture is null");
                  return;
                }

                const textureView = WGPUNative.symbols.wgpuTextureCreateView(texPtr, 0);
                if (frameCount === 0) {
                  log(`WGPU: textureView ptr=${textureView}`);
                }
                if (!textureView) {
                  if (frameCount === 0) log("WGPU: textureView is null");
                  return;
                }
                const colorAttachment = makeRenderPassColorAttachment(textureView);
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
                if (drawEnabled) {
                  WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(pass, pipeline);
                  WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(
                    pass,
                    0,
                    vertexBuffer,
                    0,
                    vertexData.byteLength,
                  );
                  WGPUNative.symbols.wgpuRenderPassEncoderDraw(
                    pass,
                    cubeVertices.length / 3,
                    1,
                    0,
                    0,
                  );
                }
                WGPUNative.symbols.wgpuRenderPassEncoderEnd(pass);

                const commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(
                  encoder,
                  0,
                );
                if (frameCount === 0) {
                  log(`WGPU: commandBuffer ptr=${commandBuffer}`);
                }
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
                const presentStatus = WGPUBridge.surfacePresent(surface as number);
                if (frameCount === 0) {
                  log(`WGPU: present status=${presentStatus}`);
                }

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
