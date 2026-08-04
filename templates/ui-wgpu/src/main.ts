// Cottontail UI: a reactive counter/card rendered by Dawn through the
// electrobun/main/ui runtime — no webview for the chrome, no browser DOM,
// no compile step. The right side embeds the two native-layer elements:
// a wgpuSurface (the <electrobun-wgpu> equivalent) and an out-of-process
// webview (the <electrobun-webview> equivalent), both positioned by the
// UI layout.

import { webgpu } from "electrobun/main";
import {
	createMemo,
	createSignal,
	createStore,
	onKey,
	produce,
	ui,
	webview,
	wgpuSurface,
	createUIWindow,
	untrack,
	type Reactive,
} from "electrobun/main/ui";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const theme = {
	background: "#13131c",
	surface: "#1b1b28",
	surfaceHover: "#232336",
	surfaceActive: "#2c2c44",
	line: "#262638",
	textPrimary: "#e4e4f0",
	textMuted: "#8c8ca8",
	textFaint: "#616178",
};

function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
		return Math.round(255 * c)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const [count, setCount] = createSignal(0);
const accent = createMemo(() => hslToHex(260 + count() * 14, 0.72, 0.68));

const [log, setLog] = createStore({
	entries: [] as Array<{ n: number; label: string }>,
	total: 0,
});

function record(label: string) {
	setLog(
		produce((s) => {
			s.total += 1;
			s.entries.unshift({ n: s.total, label });
			if (s.entries.length > 4) s.entries.length = 4;
		}),
	);
}

function adjust(delta: number) {
	setCount((c) => c + delta);
	record(delta > 0 ? `incremented to ${count()}` : `decremented to ${count()}`);
}

function reset() {
	setCount(0);
	record("reset to 0");
}

// ---------------------------------------------------------------------------
// Components: plain functions over the builder API
// ---------------------------------------------------------------------------

function Button(label: string, onClick: () => void, width?: number) {
	const [hover, setHover] = createSignal(false);
	const [active, setActive] = createSignal(false);
	ui.box(
		{
			width,
			pad: 12,
			radius: 9,
			justify: "center",
			bg: () =>
				active()
					? theme.surfaceActive
					: hover()
						? theme.surfaceHover
						: theme.surface,
			border: 1,
			borderColor: () => (hover() ? accent() : theme.line),
			onClick,
			onPointerEnter: () => setHover(true),
			onPointerLeave: () => {
				setHover(false);
				setActive(false);
			},
			onPointerDown: () => setActive(true),
			onPointerUp: () => setActive(false),
		},
		() => {
			ui.text(label, { size: 14, color: theme.textPrimary });
		},
	);
}

function Divider() {
	ui.box({ height: 1, bg: theme.line });
}

function Header(sizeLabel: Reactive<string>) {
	// Left padding clears the macOS traffic lights under hiddenInset.
	ui.row({ pad: 14, align: "center", gap: 8 }, () => {
		ui.box({ width: 62 });
		ui.text("Cottontail UI", { size: 15, color: theme.textPrimary });
		ui.text("prototype", { size: 11, color: theme.textFaint });
		ui.spacer();
		ui.text(sizeLabel, { size: 11, color: theme.textFaint });
	});
}

function Counter() {
	ui.column({ grow: 1, justify: "center", align: "center", gap: 16 }, () => {
		ui.text("A reactive UI runtime without a webview", {
			size: 12,
			color: theme.textMuted,
		});
		ui.text(() => String(count()), { size: 88, color: accent });
		ui.row({ gap: 10 }, () => {
			Button("- 1", () => adjust(-1), 92);
			Button("+ 1", () => adjust(1), 92);
			Button("Reset", reset, 92);
		});
		ui.text("Keyboard: space or +/- adjust, r resets", {
			size: 11,
			color: theme.textFaint,
		});
	});
}

function EventLog() {
	ui.column({ pad: 16, gap: 8, bg: "#171722" }, () => {
		ui.text("Event log - createStore + produce()", {
			size: 11,
			color: theme.textMuted,
		});
		ui.dynamic({ dir: "column", gap: 4 }, () => {
			if (log.entries.length === 0) {
				ui.text("No events yet. Click a button.", {
					size: 12,
					color: theme.textFaint,
				});
				return;
			}
			for (const entry of log.entries) {
				ui.row({ gap: 8 }, () => {
					ui.text(`#${entry.n}`, { size: 12, color: accent });
					ui.text(entry.label, { size: 12, color: theme.textPrimary });
				});
			}
		});
	});
}

// A native Dawn surface running an animated Mandelbrot zoom — the layout
// owns its rectangle, the app owns its pipeline. The palette phase follows
// the counter, so the UI state reaches into the shader.
const MANDELBROT_WGSL = /* wgsl */ `
struct Uniforms {
  // time (s), width (px), height (px), palette phase
  d0: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
  let t = u.d0.x;
  let res = vec2<f32>(u.d0.y, u.d0.z);
  let phase = u.d0.w;

  // Ping-pong zoom into seahorse valley (~40s cycle, no snapping).
  let cycle = 0.5 - 0.5 * cos(t * 0.157);
  let scale = mix(1.8, 0.0035, pow(cycle, 1.5));
  let center = vec2<f32>(-0.743643887, 0.131825904);
  let uv = (fragPos.xy - 0.5 * res) / res.y;
  let c = center + uv * scale;

  var z = vec2<f32>(0.0, 0.0);
  let maxIter = 160.0;
  var i: f32 = 0.0;
  for (var n: f32 = 0.0; n < maxIter; n += 1.0) {
    z = vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 16.0) { break; }
    i += 1.0;
  }
  if (i >= maxIter) {
    return vec4<f32>(0.02, 0.02, 0.05, 1.0);
  }
  let smoothed = i + 1.0 - log2(max(1.0, log2(dot(z, z))));
  let x = smoothed / maxIter;
  let col = vec3<f32>(0.5) + vec3<f32>(0.5)
    * cos(6.2831 * (vec3<f32>(0.0, 0.33, 0.67) + x * 3.0 + phase));
  return vec4<f32>(col, 1.0);
}
`;

function MandelbrotSurface() {
	ui.column({ pad: 12, gap: 6, grow: 1 }, () => {
		ui.text("wgpuSurface - Mandelbrot (palette follows count)", {
			size: 11,
			color: theme.textMuted,
		});
		wgpuSurface({
			grow: 1,
			onReady: async (view) => {
				const { context } = webgpu.createContext(view as any);
				const adapter = await webgpu.navigator.requestAdapter({
					compatibleSurface: context,
				});
				const device = await adapter.requestDevice();
				context._fallbackSize = {
					width: view.frame.width,
					height: view.frame.height,
				};
				context.configure({ device, format: "bgra8unorm" });

				const module = device.createShaderModule({ code: MANDELBROT_WGSL });
				const pipeline = device.createRenderPipeline({
					layout: "auto",
					vertex: { module, entryPoint: "vs" },
					fragment: {
						module,
						entryPoint: "fs",
						targets: [{ format: context.format }],
					},
					primitive: { topology: "triangle-list" },
				});
				const uniforms = device.createBuffer({
					size: 16,
					usage: 0x40 | 0x8, // UNIFORM | COPY_DST
				});
				const bindGroup = device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [{ binding: 0, resource: { buffer: uniforms } }],
				});

				const start = Date.now();
				const timer = setInterval(() => {
					if (view.isRemoved) {
						clearInterval(timer);
						return;
					}
					const { width, height } = view.frame;
					if (width <= 0 || height <= 0) return;
					context._fallbackSize = { width, height };
					device.queue.writeBuffer(
						uniforms,
						0,
						new Float32Array([
							(Date.now() - start) / 1000,
							width,
							height,
							untrack(count) * 0.08,
						]),
					);
					const encoder = device.createCommandEncoder();
					const pass = encoder.beginRenderPass({
						colorAttachments: [
							{
								view: context.getCurrentTexture().createView(),
								loadOp: "clear",
								storeOp: "store",
								clearValue: { r: 0, g: 0, b: 0, a: 1 },
							},
						],
					});
					pass.setPipeline(pipeline);
					pass.setBindGroup(0, bindGroup);
					pass.draw(3);
					pass.end();
					device.queue.submit([encoder.finish()]);
				}, 33);
			},
		});
	});
}

// An out-of-process webview panel positioned by the same layout.
function WebPanel() {
	ui.column({ pad: 12, gap: 6, grow: 1 }, () => {
		ui.text("webview - https://blackboard.sh", {
			size: 11,
			color: theme.textMuted,
		});
		webview({
			grow: 1,
			url: "https://blackboard.sh",
		});
	});
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const [sizeLabel, setSizeLabel] = createSignal("");

const uiWindow = await createUIWindow(
	{
		title: "Cottontail UI",
		width: 900,
		height: 540,
		background: theme.background,
	},
	() => {
		ui.column({ grow: 1 }, () => {
			Header(sizeLabel);
			Divider();
			ui.row({ grow: 1 }, () => {
				ui.column({ grow: 3 }, () => {
					Counter();
					Divider();
					EventLog();
				});
				ui.box({ width: 1, bg: theme.line });
				ui.column({ grow: 2 }, () => {
					MandelbrotSurface();
					Divider();
					WebPanel();
				});
			});
		});

		onKey((e) => {
			// macOS virtual key codes (prototype; production maps per platform).
			if (e.keyCode === 49 || e.keyCode === 24) adjust(1); // space, =
			else if (e.keyCode === 27) adjust(-1); // -
			else if (e.keyCode === 15) reset(); // r
		});
	},
);

const updateSizeLabel = () => {
	const { width, height } = uiWindow.window.getSize();
	setSizeLabel(`${width} x ${height}`);
};
updateSizeLabel();
uiWindow.window.on("resize", updateSizeLabel);

console.log("[ui-wgpu] Cottontail UI prototype running (solid-effects-ok)");
