// Electrobun UI showcase: HTML/CSS + JSX rendered by Electrobun's Zig UI
// engine straight to the GPU — no webview for the app chrome. The right-hand
// column embeds two native layers positioned by the layout: a live WebGPU
// scene (a Dawn view running a Mandelbrot zoom) and an out-of-process webview.

import { BrowserView, WGPUView, webgpu } from "electrobun/main";
import {
	createUIWindow,
	For,
	inert,
	live,
	memo,
	Show,
	signal,
	store,
	type UIEvent,
	type UINode,
} from "electrobun/main/ui";

// ---------------------------------------------------------------------------
// Styles: plain CSS, including variables, nesting and :hover/:active
// ---------------------------------------------------------------------------

const css = /* css */ `
	:root {
		--bg: #13131c;
		--surface: #1b1b28;
		--surface-hover: #232336;
		--surface-active: #2c2c44;
		--line: #262638;
		--text: #e4e4f0;
		--muted: #8c8ca8;
		--faint: #616178;
	}
	body { margin: 0; height: 100vh; display: flex; flex-direction: column; color: var(--text);
	       font: 13px system-ui; background: var(--bg) }
	header { display: flex; align-items: center; gap: 8px; padding: 12px 14px 12px 82px;
	         border-bottom: 1px solid var(--line); -webkit-app-region: drag }
	header h1 { margin: 0; font-size: 15px; font-weight: 600 }
	header .sub, header .size { font-size: 11px; color: var(--faint) }
	header .size { margin-left: auto }
	main { flex: 1; display: flex; min-height: 0 }
	.left { flex: 3; display: flex; flex-direction: column; border-right: 1px solid var(--line) }
	.right { flex: 2; display: flex; flex-direction: column; min-width: 0 }
	.counter { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px }
	.counter .tagline, .panel .label { font-size: 11px; color: var(--muted) }
	.counter .value { font-size: 88px; font-weight: 300; line-height: 1; transition: color .25s }
	.counter .hint { font-size: 11px; color: var(--faint) }
	.buttons { display: flex; gap: 10px }
	.btn { width: 92px; padding: 12px; border-radius: 9px; background: var(--surface); color: var(--text);
	       border: 1px solid var(--line); font-size: 14px; transition: background-color .12s, border-color .12s;
	       &:hover { background: var(--surface-hover); border-color: var(--accent) }
	       &:active { background: var(--surface-active) } }
	.log { padding: 16px; display: flex; flex-direction: column; gap: 6px; background: #171722;
	       border-top: 1px solid var(--line); min-height: 108px }
	.log .row { display: flex; gap: 8px; animation: slide-in .2s ease-out }
	.log .n { color: var(--accent); font-variant-numeric: tabular-nums }
	.log .empty { color: var(--faint) }
	@keyframes slide-in { from { opacity: 0; transform: translateY(-4px) } }
	.panel { flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 12px; min-height: 0 }
	.panel + .panel { border-top: 1px solid var(--line) }
	/* native layers are anchored over these slots */
	.slot { flex: 1; border-radius: 8px; background: #0d0d14; min-height: 60px }
`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const [count, setCount] = signal(0);
const accent = memo(() => hslToHex(260 + count() * 14, 0.72, 0.68));

const [log, setLog] = store({
	entries: [] as Array<{ n: number; label: string }>,
	total: 0,
});

function record(label: string) {
	setLog((s) => {
		s.total += 1;
		s.entries.unshift({ n: s.total, label });
		if (s.entries.length > 4) s.entries.length = 4;
	});
}

function adjust(delta: number) {
	setCount((c) => c + delta);
	record(`${delta > 0 ? "incremented" : "decremented"} to ${inert(count)}`);
}

function reset() {
	setCount(0);
	record("reset to 0");
}

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
// Window
// ---------------------------------------------------------------------------

const app = createUIWindow({
	title: "Electrobun UI",
	width: 900,
	height: 560,
	titleBarStyle: "hiddenInset",
	css,
});

// ---------------------------------------------------------------------------
// Components: plain functions returning JSX
// ---------------------------------------------------------------------------

function Counter() {
	return (
		<section class="counter">
			<div class="tagline">HTML/CSS + JSX on the GPU, without a webview</div>
			<div class="value" style={live(() => `color: ${accent()}`)}>
				{live(() => String(count()))}
			</div>
			<div class="buttons">
				<button class="btn" onClick={() => adjust(-1)}>− 1</button>
				<button class="btn" onClick={() => adjust(1)}>+ 1</button>
				<button class="btn" onClick={reset}>Reset</button>
			</div>
			<div class="hint">Keyboard: space or +/− adjust, r resets</div>
		</section>
	);
}

function EventLog() {
	return (
		<section class="log">
			<div class="label">Event log — store</div>
			<Show when={live(() => log.entries.length === 0)}>
				<div class="empty">No events yet. Click a button.</div>
			</Show>
			<For each={live(() => log.entries)} key={(e) => e.n}>
				{(e) => (
					<div class="row">
						<span class="n">#{String(e.n)}</span>
						<span>{e.label}</span>
					</div>
				)}
			</For>
		</section>
	);
}

// A native Dawn view anchored over the slot, running an animated Mandelbrot
// zoom whose palette phase follows the counter.
const MANDELBROT_WGSL = /* wgsl */ `
struct Uniforms { d0: vec4<f32> };
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0));
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
  let t = u.d0.x;
  let res = vec2<f32>(u.d0.y, u.d0.z);
  let phase = u.d0.w;
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
  if (i >= maxIter) { return vec4<f32>(0.02, 0.02, 0.05, 1.0); }
  let smoothed = i + 1.0 - log2(max(1.0, log2(dot(z, z))));
  let x = smoothed / maxIter;
  let col = vec3<f32>(0.5) + vec3<f32>(0.5) * cos(6.2831 * (vec3<f32>(0.0, 0.33, 0.67) + x * 3.0 + phase));
  return vec4<f32>(col, 1.0);
}
`;

async function startMandelbrot(view: WGPUView) {
	const { context } = webgpu.createContext(view as any);
	const adapter = await webgpu.navigator.requestAdapter({ compatibleSurface: context });
	const device = await adapter.requestDevice();
	context._fallbackSize = { width: view.frame.width, height: view.frame.height };
	context.configure({ device, format: "bgra8unorm" });
	const module = device.createShaderModule({ code: MANDELBROT_WGSL });
	const pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module, entryPoint: "vs" },
		fragment: { module, entryPoint: "fs", targets: [{ format: context.format }] },
		primitive: { topology: "triangle-list" },
	});
	const uniforms = device.createBuffer({ size: 16, usage: 0x40 | 0x8 });
	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [{ binding: 0, resource: { buffer: uniforms } }],
	});
	const start = Date.now();
	const timer = setInterval(() => {
		if (view.isRemoved) return clearInterval(timer);
		const { width, height } = view.frame;
		if (width <= 1 || height <= 1) return;
		context._fallbackSize = { width, height };
		device.queue.writeBuffer(
			uniforms,
			0,
			new Float32Array([(Date.now() - start) / 1000, width, height, inert(count) * 0.08]),
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
}

const placeholder = { x: 0, y: 0, width: 1, height: 1 };

function MandelbrotPanel() {
	const attach = (el: UINode) => {
		const view = new WGPUView({ windowId: app.window.id, frame: placeholder, autoResize: false });
		// the layout decides where the view goes; it follows resizes and scrolling
		app.ui.anchor(el, view);
		startMandelbrot(view).catch((e) => console.error("[ui-wgpu] WebGPU setup failed", e));
	};
	return (
		<section class="panel">
			<div class="label">WGPUView — Mandelbrot (palette follows the count)</div>
			<div class="slot" ref={attach} />
		</section>
	);
}

function WebPanel() {
	const attach = (el: UINode) => {
		const view = new BrowserView({
			windowId: app.window.id,
			url: "https://blackboard.sh",
			frame: placeholder,
			autoResize: false,
		});
		app.ui.anchor(el, view);
	};
	return (
		<section class="panel">
			<div class="label">BrowserView — https://blackboard.sh</div>
			<div class="slot" ref={attach} />
		</section>
	);
}

const [sizeLabel, setSizeLabel] = signal("");

function App() {
	return (
		<>
			<header style={live(() => `--accent: ${accent()}`)}>
				<h1>Electrobun UI</h1>
				<span class="sub">wgpu showcase</span>
				<span class="size">{live(sizeLabel)}</span>
			</header>
			<main style={live(() => `--accent: ${accent()}`)}>
				<div class="left">
					<Counter />
					<EventLog />
				</div>
				<div class="right">
					<MandelbrotPanel />
					<WebPanel />
				</div>
			</main>
		</>
	);
}

app.ui.render(App);

// window-level shortcuts: key events bubble to <body>
app.ui.body.addEventListener("keydown", (e: UIEvent) => {
	if (e.key === " " || e.key === "+" || e.key === "=") adjust(1);
	else if (e.key === "-") adjust(-1);
	else if (e.key === "r") reset();
});

const updateSizeLabel = () => {
	const { width, height } = app.window.getSize();
	setSizeLabel(`${width} × ${height}`);
};
updateSizeLabel();
app.window.on("resize", updateSizeLabel);

console.log("[ui-wgpu] Electrobun UI showcase running");
