import { GpuWindow, Screen, WGPU, WGPUBridge } from "electrobun/bun";
import { CString, ptr } from "bun:ffi";

const WGPUNative = WGPU.native;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;
const WGPUTextureFormat_BGRA8UnormSrgb = 0x0000001c;
const WGPUTextureUsage_RenderAttachment = 0x0000000000000010n;
const WGPUBufferUsage_Vertex = 0x0000000000000020n;
const WGPUBufferUsage_CopyDst = 0x0000000000000008n;
const WGPUVertexFormat_Float32 = 0x0000001c;
const WGPUVertexFormat_Float32x2 = 0x0000001d;
const WGPUVertexFormat_Float32x4 = 0x0000001f;
const WGPUVertexStepMode_Vertex = 0x00000001;
const WGPUPrimitiveTopology_TriangleList = 0x00000004;
const WGPUFrontFace_CCW = 0x00000001;
const WGPUCullMode_None = 0x00000001;
const WGPUPresentMode_Fifo = 0x00000001;

const KEEPALIVE: any[] = [];

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
	writeU32(view, 8, 0x00000004);
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

function makeVertexBufferLayout(
	attributePtr: number,
	attributeCount: number,
	stride: number,
) {
	const buffer = new ArrayBuffer(40);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writeU32(view, 8, WGPUVertexStepMode_Vertex);
	writeU32(view, 12, 0);
	writeU64(view, 16, BigInt(stride));
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
	bufferLayoutPtr: number,
) {
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

function makeFragmentState(
	modulePtr: number,
	entryPointPtr: number,
	targetPtr: number,
) {
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

function makeRenderPassColorAttachment(viewPtr: number, clear: { r: number; g: number; b: number; a: number }) {
	const buffer = new ArrayBuffer(72);
	const view = new DataView(buffer);
	writePtr(view, 0, 0);
	writePtr(view, 8, viewPtr);
	writeU32(view, 16, WGPU_DEPTH_SLICE_UNDEFINED);
	writeU32(view, 20, 0);
	writePtr(view, 24, 0);
	writeU32(view, 32, 2);
	writeU32(view, 36, 1);
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

function makeCommandBufferArray(cmdPtr: number) {
	const buffer = new BigUint64Array([BigInt(cmdPtr)]);
	return { buffer, ptr: ptr(buffer) };
}

const size = 640;
const display = Screen.getPrimaryDisplay();
const workArea = display.workArea;
const x = workArea.x + Math.floor((workArea.width - size) / 2);
const y = workArea.y + Math.floor((workArea.height - size) / 2);

const win = new GpuWindow({
	title: "WGPU Shader",
	frame: { width: size, height: size, x, y },
	titleBarStyle: "default",
	transparent: false,
});

const layerPtr = win.wgpuView.getNativeHandle();
if (!WGPUNative.available || !layerPtr) {
	throw new Error("WGPU not available for wgpu");
}

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
if (!adapter || !device) {
	throw new Error("Failed to get WGPU adapter/device");
}

const queue = WGPUNative.symbols.wgpuDeviceGetQueue(device);

const surfaceConfig = makeSurfaceConfiguration(
	device,
	size,
	size,
	WGPUTextureFormat_BGRA8UnormSrgb,
);
WGPUBridge.surfaceConfigure(surface as number, surfaceConfig.ptr as number);

const shaderText = `
struct VSOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) time : f32,
  @location(2) resolution : vec2<f32>,
  @location(3) mouse : vec4<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) time: f32,
  @location(2) resolution: vec2<f32>,
  @location(3) mouse: vec4<f32>
) -> VSOut {
  var out: VSOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.uv = position;
  out.time = time;
  out.resolution = resolution;
  out.mouse = mouse;
  return out;
}

@fragment
fn fs_main(
  @location(0) uv: vec2<f32>,
  @location(1) time: f32,
  @location(2) resolution: vec2<f32>,
  @location(3) mouse: vec4<f32>
) -> @location(0) vec4<f32> {
  let fragCoord = (uv * 0.5 + vec2<f32>(0.5)) * resolution;
  let m = (mouse.xy / max(resolution, vec2<f32>(1.0))) * 2.0 - vec2<f32>(1.0);
  let loopMax: i32 = select(32, 64, mouse.z > 0.5);
  var o = vec4<f32>(0.0);
  var i: f32 = 0.0;
  var d: f32 = 0.0;
  var c: f32 = 0.0;
  var s: f32 = 0.0;
  var q = vec3<f32>(0.0);
  var p = vec3<f32>(0.0);
  let r = vec3<f32>(resolution, 0.0);
  var dir = normalize(vec3<f32>((fragCoord + fragCoord - r.xy) / r.y, 1.0));
  dir.x = dir.x + m.x * 0.35;
  dir.y = dir.y + -m.y * 0.35;

  for (var iter: i32 = 0; iter < loopMax; iter = iter + 1) {
    i = f32(iter + 1);
    p = dir * d;
    p.z = p.z + time * 4.0;
    q = p;
    s = 0.0;
    c = 20.0;
    loop {
      if (c <= 0.2) { break; }
      let m = mat2x2<f32>(
        vec2<f32>(cos(c / 30.0 + 0.0), cos(c / 30.0 + 33.0)),
        vec2<f32>(cos(c / 30.0 + 11.0), cos(c / 30.0 + 0.0))
      );
      let xz = m * vec2<f32>(p.x, p.z);
      p.x = xz.x;
      p.z = xz.y;
      p = abs(fract(p / c) * c - vec3<f32>(c * 0.5)) - vec3<f32>(c * 0.2);
      s = max(
        9.0 + 3.0 * sin(q.z * 0.05) - abs(q.x),
        max(s, min(p.x, min(p.y, p.z)))
      );
      p = q;
      c = c * 0.5;
    }
    let sinp = sin(p * 12.0);
    let dotv = dot(sinp, vec3<f32>(0.1, 0.1, 0.1));
    s = min(s, p.y + 8.0 + dotv);
    d = d + s;
    let add = i / max(s, 0.001);
    o = o + vec4<f32>(add, add, add, add);
  }

  let denom = max(d, 0.000001);
  o = tanh(o / denom / 30000.0);
  return vec4<f32>(o.xyz, 1.0);
}
`;

const shaderBytes = new TextEncoder().encode(shaderText + "\0");
const shaderBuf = new Uint8Array(shaderBytes);
KEEPALIVE.push(shaderBuf);
const shaderPtr = ptr(shaderBuf);
const shaderSource = makeShaderSourceWGSL(shaderPtr);
const shaderDesc = makeShaderModuleDescriptor(shaderSource.ptr as number);
const shaderModule = WGPUNative.symbols.wgpuDeviceCreateShaderModule(device, shaderDesc.ptr as number);

const entryPoint = new CString("vs_main");
const fragEntryPoint = new CString("fs_main");
KEEPALIVE.push(entryPoint, fragEntryPoint);
const posAttr = makeVertexAttribute(0, 0, WGPUVertexFormat_Float32x2);
const timeAttr = makeVertexAttribute(8, 1, WGPUVertexFormat_Float32);
const resAttr = makeVertexAttribute(12, 2, WGPUVertexFormat_Float32x2);
const mouseAttr = makeVertexAttribute(20, 3, WGPUVertexFormat_Float32x4);
const attrBuf = new ArrayBuffer(32 * 4);
new Uint8Array(attrBuf, 0, 32).set(new Uint8Array(posAttr.buffer));
new Uint8Array(attrBuf, 32, 32).set(new Uint8Array(timeAttr.buffer));
new Uint8Array(attrBuf, 64, 32).set(new Uint8Array(resAttr.buffer));
new Uint8Array(attrBuf, 96, 32).set(new Uint8Array(mouseAttr.buffer));
const attrPtr = ptr(attrBuf);
KEEPALIVE.push(attrBuf);
const vertexLayout = makeVertexBufferLayout(attrPtr as number, 4, 36);
const vertexState = makeVertexState(shaderModule, entryPoint.ptr, vertexLayout.ptr as number);
const colorTarget = makeColorTargetState(WGPUTextureFormat_BGRA8UnormSrgb);
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

const vertexCount = 3;
const bufferDesc = makeBufferDescriptor(vertexCount * 9 * 4);
const vertexBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(device, bufferDesc.ptr as number);
const encoderDesc = makeCommandEncoderDescriptor();
let lastLeftDown = false;
let qualityBoost = false;
let clickX = 0;
let clickY = 0;

function renderFrame() {
	const sizeNow = win.getSize();
	const t = performance.now() * 0.001;
	const positions = [-1, -1, 3, -1, -1, 3];
	const frame = win.getFrame();
	const cursor = Screen.getCursorScreenPoint();
	const rawX = cursor.x - frame.x;
	const rawY = cursor.y - frame.y;
	const mx = Math.max(0, Math.min(frame.width, rawX));
	const my = Math.max(0, Math.min(frame.height, rawY));
	const buttons = Screen.getMouseButtons();
	const leftDown = (buttons & 1n) === 1n;
	if (leftDown && !lastLeftDown) {
		qualityBoost = !qualityBoost;
		clickX = mx;
		clickY = my;
	}
	lastLeftDown = leftDown;
	const packed = new Float32Array(vertexCount * 9);
	for (let i = 0; i < vertexCount; i += 1) {
		const idx = i * 9;
		packed[idx] = positions[i * 2]!;
		packed[idx + 1] = positions[i * 2 + 1]!;
		packed[idx + 2] = t;
		packed[idx + 3] = sizeNow.width;
		packed[idx + 4] = sizeNow.height;
		packed[idx + 5] = mx;
		packed[idx + 6] = my;
		packed[idx + 7] = qualityBoost ? clickX : 0;
		packed[idx + 8] = qualityBoost ? clickY : 0;
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
	WGPUBridge.surfaceGetCurrentTexture(surface as number, surfaceTexture.ptr as number);
	const status = surfaceTexture.view.getUint32(16, true);
	if (status !== 1 && status !== 2) return;
	const texPtr = Number(surfaceTexture.view.getBigUint64(8, true));
	if (!texPtr) return;

	const textureView = WGPUNative.symbols.wgpuTextureCreateView(texPtr, 0);
	if (!textureView) return;

	const colorAttachment = makeRenderPassColorAttachment(textureView, {
		r: 0.05,
		g: 0.05,
		b: 0.1,
		a: 1.0,
	});
	const renderPassDesc = makeRenderPassDescriptor(colorAttachment.ptr as number);
	const encoder = WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(device, encoderDesc.ptr as number);
	const pass = WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(encoder, renderPassDesc.ptr as number);
	WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(pass, pipeline);
	WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(pass, 0, vertexBuffer, 0, packed.byteLength);
	WGPUNative.symbols.wgpuRenderPassEncoderDraw(pass, vertexCount, 1, 0, 0);
	WGPUNative.symbols.wgpuRenderPassEncoderEnd(pass);

	const commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(encoder, 0);
	const commandArray = makeCommandBufferArray(commandBuffer);
	WGPUNative.symbols.wgpuQueueSubmit(queue, 1, commandArray.ptr as number);
	WGPUBridge.surfacePresent(surface as number);

	WGPUNative.symbols.wgpuTextureViewRelease(textureView);
	WGPUNative.symbols.wgpuTextureRelease(texPtr);
	WGPUNative.symbols.wgpuCommandBufferRelease(commandBuffer);
	WGPUNative.symbols.wgpuCommandEncoderRelease(encoder);
}

setInterval(renderFrame, 16);
