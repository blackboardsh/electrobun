// Dawn renderer: one instanced-quad pipeline drawing the whole command
// buffer in a single draw call. Rounded corners via SDF with ~1px AA.
// Uses Electrobun's browser-style WebGPU adapter, so this reads like
// standard WebGPU.

import webgpu from "../webgpuAdapter";
import type { GpuWindow } from "../core/GpuWindow";
import type { WGPUView } from "../core/WGPUView";
import { FLOATS_PER_INSTANCE, parseColor, type PaintBuffer } from "./paint";
import { ATLAS_SIZE, textAtlas } from "./text";

const SHADER = /* wgsl */ `
struct Uniforms {
  viewport: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
  @location(2) halfSize: vec2<f32>,
  @location(3) radius: f32,
  @location(4) clip: vec4<f32>,
  @location(5) uv: vec2<f32>,
  @location(6) textured: f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) rect: vec4<f32>,
  @location(1) color: vec4<f32>,
  @location(2) misc: vec4<f32>,
  @location(3) clipRect: vec4<f32>,
  @location(4) uvRect: vec4<f32>,
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  let px = rect.xy + c * rect.zw;
  let ndc = vec2<f32>(
    px.x / u.viewport.x * 2.0 - 1.0,
    1.0 - px.y / u.viewport.y * 2.0,
  );
  var out: VSOut;
  out.pos = vec4<f32>(ndc, 0.0, 1.0);
  out.color = color;
  out.halfSize = rect.zw * 0.5;
  out.local = (c - vec2<f32>(0.5, 0.5)) * rect.zw;
  out.radius = misc.x;
  out.clip = clipRect;
  out.uv = mix(uvRect.xy, uvRect.zw, c);
  out.textured = misc.y;
  return out;
}

fn sdRoundRect(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var atlasTexture: texture_2d<f32>;

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // Sample before any branching: WGSL requires textureSample (implicit
  // derivatives) in uniform control flow.
  let sampled = textureSample(atlasTexture, atlasSampler, in.uv);
  // Scissor to the instance's clip rect (framebuffer pixel space).
  if (in.pos.x < in.clip.x || in.pos.y < in.clip.y
      || in.pos.x >= in.clip.x + in.clip.z || in.pos.y >= in.clip.y + in.clip.w) {
    discard;
  }
  var coverage: f32;
  if (in.textured > 0.5) {
    // Glyphs are rasterized white-on-transparent: alpha is coverage.
    coverage = sampled.a;
  } else {
    let r = clamp(in.radius, 0.0, min(in.halfSize.x, in.halfSize.y));
    let d = sdRoundRect(in.local, in.halfSize, r);
    coverage = 1.0 - smoothstep(-0.75, 0.75, d);
  }
  if (coverage <= 0.003) {
    discard;
  }
  return vec4<f32>(in.color.rgb, in.color.a * coverage);
}
`;

export interface UiRenderer {
	render(buffer: PaintBuffer, width: number, height: number): void;
	resize(width: number, height: number): void;
}

/**
 * Renderer over any Dawn target: a full-window GpuWindow or an individual
 * WGPUView (used when a UI tree renders into a view composited over a
 * webview). Size is pushed explicitly via resize(); the surface reconfigures
 * on the next frame.
 */
export async function createUiRenderer(
	target: GpuWindow | WGPUView,
	clearColor: string | number,
	initialSize: { width: number; height: number },
): Promise<UiRenderer> {
	const { context: ctx } = webgpu.createContext(target as any);
	ctx._fallbackSize = { ...initialSize };
	const adapter = await webgpu.navigator.requestAdapter({
		compatibleSurface: ctx,
	});
	const device = await adapter.requestDevice();
	// Non-sRGB surface (command-buffer colors are already display-referred).
	// Premultiplied alpha lets transparent windows composite; configure falls
	// back to the surface's supported mode when unavailable, and our blend
	// state produces premultiplied output over the alpha clear either way.
	ctx.configure({ device, format: "bgra8unorm", alphaMode: "premultiplied" });

	const clear = parseColor(clearColor) >>> 0;
	const clearValue = {
		r: ((clear >>> 24) & 0xff) / 255,
		g: ((clear >>> 16) & 0xff) / 255,
		b: ((clear >>> 8) & 0xff) / 255,
		a: (clear & 0xff) / 255,
	};

	const module = device.createShaderModule({ code: SHADER });
	const pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: {
			module,
			entryPoint: "vs",
			buffers: [
				{
					arrayStride: FLOATS_PER_INSTANCE * 4,
					stepMode: "instance",
					attributes: [
						{ shaderLocation: 0, offset: 0, format: "float32x4" },
						{ shaderLocation: 1, offset: 16, format: "float32x4" },
						{ shaderLocation: 2, offset: 32, format: "float32x4" },
						{ shaderLocation: 3, offset: 48, format: "float32x4" },
						{ shaderLocation: 4, offset: 64, format: "float32x4" },
					],
				},
			],
		},
		fragment: {
			module,
			entryPoint: "fs",
			targets: [
				{
					format: ctx.format,
					blend: {
						color: {
							operation: "add",
							srcFactor: "src-alpha",
							dstFactor: "one-minus-src-alpha",
						},
						alpha: {
							operation: "add",
							srcFactor: "one",
							dstFactor: "one-minus-src-alpha",
						},
					},
				},
			],
		},
		primitive: { topology: "triangle-list" },
	});

	const uniformBuffer = device.createBuffer({
		size: 16,
		usage: 0x40 | 0x8, // UNIFORM | COPY_DST
	});
	const atlasTexture = device.createTexture({
		size: { width: ATLAS_SIZE, height: ATLAS_SIZE },
		format: "rgba8unorm",
		usage: 0x4 | 0x2, // TEXTURE_BINDING | COPY_DST
	});
	const atlasView = atlasTexture.createView();
	const atlasSampler = device.createSampler({
		magFilter: "linear",
		minFilter: "linear",
	});
	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniformBuffer } },
			{ binding: 1, resource: atlasSampler },
			{ binding: 2, resource: atlasView },
		],
	});

	let atlasGeneration = -1;
	const flushAtlas = () => {
		const dirty = textAtlas.takeDirty();
		const generationChanged = textAtlas.generation !== atlasGeneration;
		if (!dirty && !generationChanged) return;
		atlasGeneration = textAtlas.generation;
		const region = generationChanged
			? { x0: 0, y0: 0, x1: ATLAS_SIZE, y1: ATLAS_SIZE }
			: dirty!;
		const x = Math.max(0, Math.floor(region.x0));
		const y = Math.max(0, Math.floor(region.y0));
		const w = Math.min(ATLAS_SIZE, Math.ceil(region.x1)) - x;
		const h = Math.min(ATLAS_SIZE, Math.ceil(region.y1)) - y;
		if (w <= 0 || h <= 0) return;
		// Pack the dirty rows into a tight buffer for the upload.
		const packed = new Uint8Array(w * h * 4);
		for (let row = 0; row < h; row++) {
			const src = ((y + row) * ATLAS_SIZE + x) * 4;
			packed.set(textAtlas.pixels.subarray(src, src + w * 4), row * w * 4);
		}
		device.queue.writeTexture(
			{ texture: atlasTexture, origin: { x, y } },
			packed,
			{ bytesPerRow: w * 4, rowsPerImage: h },
			{ width: w, height: h },
		);
	};

	let instanceCapacity = 1024;
	let instanceBuffer = device.createBuffer({
		size: instanceCapacity * FLOATS_PER_INSTANCE * 4,
		usage: 0x20 | 0x8, // VERTEX | COPY_DST
	});

	return {
		resize(width: number, height: number) {
			ctx._fallbackSize = { width, height };
		},
		render(buffer: PaintBuffer, width: number, height: number) {
			if (width <= 0 || height <= 0) return;
			flushAtlas();
			if (buffer.count > instanceCapacity) {
				while (instanceCapacity < buffer.count) instanceCapacity *= 2;
				instanceBuffer = device.createBuffer({
					size: instanceCapacity * FLOATS_PER_INSTANCE * 4,
					usage: 0x20 | 0x8,
				});
			}
			device.queue.writeBuffer(
				uniformBuffer,
				0,
				new Float32Array([width, height, 0, 0]),
			);
			if (buffer.count > 0) {
				device.queue.writeBuffer(
					instanceBuffer,
					0,
					buffer.data.subarray(0, buffer.count * FLOATS_PER_INSTANCE),
				);
			}
			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: ctx.getCurrentTexture().createView(),
						loadOp: "clear",
						storeOp: "store",
						clearValue,
					},
				],
			});
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bindGroup);
			pass.setVertexBuffer(0, instanceBuffer);
			if (buffer.count > 0) {
				pass.draw(6, buffer.count);
			}
			pass.end();
			device.queue.submit([encoder.finish()]);
		},
	};
}
