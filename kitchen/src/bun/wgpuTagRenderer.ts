import { BrowserWindow, Screen, WGPU, WGPUBridge, WGPUView } from "electrobun/bun";
import { CString, ptr } from "bun:ffi";

type Rect = { x: number; y: number; width: number; height: number };

type ViewState = {
	viewId: number;
	window: BrowserWindow<any>;
	rect: Rect;
	lastWidth: number;
	lastHeight: number;
	instance: number;
	surface: number;
	adapter: number;
	device: number;
	queue: number;
	pipelineA: number;
	pipelineB: number;
	vertexBuffer: number;
	encoderDesc: { buffer: ArrayBuffer; ptr: number };
	surfaceFormat: number;
	alphaMode: number;
	timerId: ReturnType<typeof setInterval> | null;
	useAlt: boolean;
	keepAlive: unknown[];
	stopped: boolean;
};

const WGPUNative = WGPU.native;

const WGPUTextureFormat_BGRA8Unorm = 0x0000001b;
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
const WGPUCompositeAlphaMode_Opaque = 0x00000001;
const WGPULoadOp_Clear = 0x00000002;
const WGPUStoreOp_Store = 0x00000001;
const WGPU_STRLEN = 0xffffffffffffffffn;
const WGPU_DEPTH_SLICE_UNDEFINED = 0xffffffff;

const kShaderWindow = `
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

const kShaderTemplate = `
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

function writePtr(view: DataView, offset: number, value: number | bigint | null) {
	view.setBigUint64(offset, BigInt(value ?? 0), true);
}

function writeU32(view: DataView, offset: number, value: number) {
	view.setUint32(offset, value >>> 0, true);
}

function writeU64(view: DataView, offset: number, value: bigint) {
	view.setBigUint64(offset, value, true);
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

function makeVertexBufferLayout(attributePtr: number, attributeCount: number, arrayStride: bigint) {
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
	vertexStatePtr: { buffer: ArrayBuffer; ptr: number },
	primitiveStatePtr: { buffer: ArrayBuffer; ptr: number },
	multisampleStatePtr: { buffer: ArrayBuffer; ptr: number },
	fragmentStatePtr: { buffer: ArrayBuffer; ptr: number },
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

function makeRenderPassColorAttachment(
	viewPtr: number,
	clear = { r: 0.05, g: 0.05, b: 0.1, a: 1.0 },
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

function makeCommandBufferArray(cmdPtr: number) {
	const buffer = new ArrayBuffer(16);
	const view = new DataView(buffer);
	writePtr(view, 0, cmdPtr);
	writeU64(view, 8, 1n);
	return { buffer, ptr: ptr(buffer) };
}

function createPipeline(
	device: number,
	shaderText: string,
	attributes: { offset: number; location: number; format: number }[],
	stride: number,
	format: number,
	keepAlive: unknown[],
) {
	const shaderBytes = new TextEncoder().encode(shaderText + "\0");
	const shaderBuf = new Uint8Array(shaderBytes);
	keepAlive.push(shaderBuf);
	const shaderPtr = ptr(shaderBuf);
	const shaderSource = makeShaderSourceWGSL(shaderPtr, WGPU_STRLEN);
	const shaderDesc = makeShaderModuleDescriptor(shaderSource.ptr as number);
	const shaderModule = WGPUNative.symbols.wgpuDeviceCreateShaderModule(
		device,
		shaderDesc.ptr as number,
	);
	if (!shaderModule) {
		throw new Error("WGPU shader module is null");
	}

	const entryPoint = new CString("vs_main");
	const fragEntryPoint = new CString("fs_main");
	keepAlive.push(entryPoint, fragEntryPoint);

	const attrBuf = new ArrayBuffer(32 * attributes.length);
	for (let i = 0; i < attributes.length; i += 1) {
		const attr = attributes[i]!;
		const attrDesc = makeVertexAttribute(attr.offset, attr.location, attr.format);
		new Uint8Array(attrBuf, i * 32, 32).set(new Uint8Array(attrDesc.buffer));
	}
	const attrPtr = ptr(attrBuf);
	keepAlive.push(attrBuf);

	const vertexLayout = makeVertexBufferLayout(
		attrPtr as number,
		attributes.length,
		BigInt(stride),
	);
	const vertexState = makeVertexState(
		shaderModule,
		entryPoint.ptr,
		WGPU_STRLEN,
		vertexLayout.ptr as number,
	);
	const colorTarget = makeColorTargetState(format);
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
		throw new Error("WGPU pipeline is null");
	}

	return pipeline;
}

export class WgpuTagRenderer {
	private states = new Map<number, ViewState>();
	private cleanupInProgress = new Set<number>();

	updateRect(viewId: number, rect: Rect) {
		const state = this.states.get(viewId);
		if (state) {
			state.rect = rect;
		}
	}

	start(viewId: number, win: BrowserWindow<any>, rect: Rect) {
		if (this.states.has(viewId)) return;
		if (!WGPUNative.available) {
			throw new Error("WGPU native library not available");
		}
		const view = WGPUView.getById(viewId);
		if (!view?.ptr) {
			throw new Error(`WGPUView not found for id ${viewId}`);
		}

		const instance = WGPUNative.symbols.wgpuCreateInstance(0) as number;
		const surface = WGPUBridge.createSurfaceForView(
			instance,
			view.ptr as number,
		) as number;
		if (!surface) {
			throw new Error("Failed to create WGPU surface for view");
		}

		const adapterDevice = new BigUint64Array(2);
		WGPUBridge.createAdapterDeviceMainThread(
			instance,
			surface,
			ptr(adapterDevice),
		);
		const adapter = Number(adapterDevice[0]);
		const device = Number(adapterDevice[1]);
		if (!adapter || !device) {
			throw new Error("Failed to get WGPU adapter/device");
		}
		const queue = WGPUNative.symbols.wgpuDeviceGetQueue(device);

		const caps = makeSurfaceCapabilities();
		WGPUNative.symbols.wgpuSurfaceGetCapabilities(
			surface,
			adapter,
			caps.ptr as number,
		);
		const pick = pickSurfaceFormatAlpha(
			caps.view,
			WGPUTextureFormat_BGRA8Unorm,
		);

		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		const surfaceConfig = makeSurfaceConfiguration(
			device,
			width,
			height,
			pick.format,
			pick.alphaMode,
		);
		WGPUBridge.surfaceConfigure(surface, surfaceConfig.ptr as number);

		const keepAlive: unknown[] = [];
		const pipelineA = createPipeline(
			device,
			kShaderWindow,
			[
				{ offset: 0, location: 0, format: WGPUVertexFormat_Float32x2 },
				{ offset: 8, location: 1, format: WGPUVertexFormat_Float32 },
				{ offset: 12, location: 2, format: WGPUVertexFormat_Float32x2 },
			],
			36,
			pick.format,
			keepAlive,
		);

		const pipelineB = createPipeline(
			device,
			kShaderTemplate,
			[
				{ offset: 0, location: 0, format: WGPUVertexFormat_Float32x2 },
				{ offset: 8, location: 1, format: WGPUVertexFormat_Float32 },
				{ offset: 12, location: 2, format: WGPUVertexFormat_Float32x2 },
				{ offset: 20, location: 3, format: WGPUVertexFormat_Float32x4 },
			],
			36,
			pick.format,
			keepAlive,
		);

		const vertexCount = 3;
		const bufferDesc = makeBufferDescriptor(vertexCount * 9 * 4);
		const vertexBuffer = WGPUNative.symbols.wgpuDeviceCreateBuffer(
			device,
			bufferDesc.ptr as number,
		);
		if (!vertexBuffer) {
			throw new Error("Failed to create vertex buffer");
		}

		const encoderDesc = makeCommandEncoderDescriptor();
		const state: ViewState = {
			viewId,
			window: win,
			rect,
			lastWidth: width,
			lastHeight: height,
			instance,
			surface,
			adapter,
			device,
			queue,
			pipelineA,
			pipelineB,
			vertexBuffer,
			encoderDesc,
			surfaceFormat: pick.format,
			alphaMode: pick.alphaMode,
			timerId: null,
			useAlt: false,
			keepAlive,
			stopped: false,
		};

		state.timerId = setInterval(() => this.renderFrame(state), 16);
		this.states.set(viewId, state);
	}

	toggleShader(viewId: number) {
		const state = this.states.get(viewId);
		if (!state) return;
		state.useAlt = !state.useAlt;
	}

	stop(viewId: number) {
		const state = this.states.get(viewId);
		if (!state || this.cleanupInProgress.has(viewId)) {
			return;
		}
		
		// Prevent double cleanup
		this.cleanupInProgress.add(viewId);
		
		// Mark as stopped to prevent render loop from continuing
		state.stopped = true;
		
		if (state.timerId) {
			clearInterval(state.timerId);
			state.timerId = null;
		}
		
		// Remove from states immediately to prevent any further access
		this.states.delete(viewId);
		
		// Mark the associated WGPU view as stopped to prevent double cleanup
		const wgpuView = WGPUView.getById(viewId);
		if (wgpuView) {
			wgpuView.ptr = null as any;
		}
		
		// Don't manually release WGPU resources - let the native view cleanup handle them
		// Manually calling wgpuDeviceRelease/wgpuSurfaceRelease after view destruction causes crashes
		
		{
			// Clear all references
			state.window = null as any;
			state.keepAlive = [];
			state.encoderDesc = null as any;
			this.cleanupInProgress.delete(viewId);
		}
	}

	stopAll() {
		for (const viewId of this.states.keys()) {
			this.stop(viewId);
		}
	}

	private renderFrame(state: ViewState) {
		// Check if renderer has been stopped
		if (state.stopped) return;
		
		const rect = state.rect;
		const width = Math.max(1, Math.floor(rect.width));
		const height = Math.max(1, Math.floor(rect.height));
		if (width <= 1 || height <= 1) return;

		if (width !== state.lastWidth || height !== state.lastHeight) {
			const surfaceConfig = makeSurfaceConfiguration(
				state.device,
				width,
				height,
				state.surfaceFormat,
				state.alphaMode,
			);
			WGPUBridge.surfaceConfigure(state.surface, surfaceConfig.ptr as number);
			state.lastWidth = width;
			state.lastHeight = height;
		}

		const t = performance.now() * 0.001;
		const positions = [-1, -1, 3, -1, -1, 3];

		const windowFrame = state.window.getFrame();
		const cursor = Screen.getCursorScreenPoint();
		const rawX = cursor.x - windowFrame.x - rect.x;
		const rawY = cursor.y - windowFrame.y - rect.y;
		const mx = Math.max(0, Math.min(width, rawX));
		const my = Math.max(0, Math.min(height, rawY));
		const buttons = Screen.getMouseButtons();
		const leftDown = (buttons & 1n) === 1n ? 1 : 0;

		const packed = new Float32Array(3 * 9);
		for (let i = 0; i < 3; i += 1) {
			const idx = i * 9;
			packed[idx] = positions[i * 2]!;
			packed[idx + 1] = positions[i * 2 + 1]!;
			packed[idx + 2] = t;
			packed[idx + 3] = width;
			packed[idx + 4] = height;
			packed[idx + 5] = mx;
			packed[idx + 6] = my;
			packed[idx + 7] = leftDown;
			packed[idx + 8] = 0;
		}

		WGPUNative.symbols.wgpuQueueWriteBuffer(
			state.queue,
			state.vertexBuffer,
			0,
			ptr(packed),
			packed.byteLength,
		);

		// Check again before using native resources
		if (state.stopped) return;
		
		WGPUNative.symbols.wgpuInstanceProcessEvents(state.instance);

		const surfaceTexture = makeSurfaceTexture();
		WGPUBridge.surfaceGetCurrentTexture(
			state.surface,
			surfaceTexture.ptr as number,
		);
		const status = surfaceTexture.view.getUint32(16, true);
		if (status !== 1 && status !== 2) return;
		const texPtr = Number(surfaceTexture.view.getBigUint64(8, true));
		if (!texPtr) return;

		const textureView = WGPUNative.symbols.wgpuTextureCreateView(texPtr, 0);
		if (!textureView) return;

		const colorAttachment = makeRenderPassColorAttachment(textureView);
		const renderPassDesc = makeRenderPassDescriptor(colorAttachment.ptr as number);
		const encoder = WGPUNative.symbols.wgpuDeviceCreateCommandEncoder(
			state.device,
			state.encoderDesc.ptr as number,
		);
		const pass = WGPUNative.symbols.wgpuCommandEncoderBeginRenderPass(
			encoder,
			renderPassDesc.ptr as number,
		);
		const pipeline = state.useAlt ? state.pipelineB : state.pipelineA;
		WGPUNative.symbols.wgpuRenderPassEncoderSetPipeline(pass, pipeline);
		WGPUNative.symbols.wgpuRenderPassEncoderSetVertexBuffer(
			pass,
			0,
			state.vertexBuffer,
			0,
			packed.byteLength,
		);
		WGPUNative.symbols.wgpuRenderPassEncoderDraw(pass, 3, 1, 0, 0);
		WGPUNative.symbols.wgpuRenderPassEncoderEnd(pass);

		const commandBuffer = WGPUNative.symbols.wgpuCommandEncoderFinish(encoder, 0);
		const commandArray = makeCommandBufferArray(commandBuffer);
		WGPUNative.symbols.wgpuQueueSubmit(
			state.queue,
			1,
			commandArray.ptr as number,
		);
		WGPUBridge.surfacePresent(state.surface);

		WGPUNative.symbols.wgpuTextureViewRelease(textureView);
		WGPUNative.symbols.wgpuTextureRelease(texPtr);
		WGPUNative.symbols.wgpuCommandBufferRelease(commandBuffer);
		WGPUNative.symbols.wgpuCommandEncoderRelease(encoder);
	}
}
