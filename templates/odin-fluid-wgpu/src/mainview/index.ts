import { Electroview } from "electrobun/view";

type SurfaceRect = {
	width: number;
	height: number;
};

type FluidConfig = {
	palette: number;
	hue: number;
	radius: number;
	force: number;
	swirl: number;
	viscosity: number;
	fade: number;
	paused: boolean;
};

type FluidInjection = {
	x: number;
	y: number;
	dx: number;
	dy: number;
	tool: number;
	hue: number;
	radius: number;
	force: number;
};

type FluidRPC = {
	bun: {
		requests: {
			startFluid: {
				params: { id: number; rect: SurfaceRect; config: FluidConfig };
				response: { ok: boolean };
			};
			configureFluid: {
				params: { id: number; rect: SurfaceRect; config: FluidConfig };
				response: { ok: boolean };
			};
			injectFluid: {
				params: FluidInjection;
				response: { ok: boolean };
			};
			resetFluid: {
				params: {};
				response: { ok: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			fluidFrame: {
				id: number;
				frame: number;
				fps: number;
				columns: number;
				rows: number;
				active: number;
				width: number;
				height: number;
			};
		};
	};
};

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const fpsStat = document.getElementById("fps-stat") as HTMLElement;
const gridStat = document.getElementById("grid-stat") as HTMLElement;
const activeStat = document.getElementById("active-stat") as HTMLElement;

const rpc = Electroview.defineRPC<FluidRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			fluidFrame(payload) {
				fpsStat.textContent = payload.fps.toFixed(0);
				gridStat.textContent = `${payload.columns} x ${payload.rows}`;
				activeStat.textContent = payload.active.toLocaleString();
				statusEl.textContent = payload.fps > 0 ? "Odin solver online" : "Warming fluid field";
			},
		},
	},
});

const electrobun = new Electroview({ rpc });

type WgpuSurfaceElement = HTMLElement & {
	wgpuViewId?: number | null;
	on?: (event: "ready", listener: (event: CustomEvent<{ id: number }>) => void) => void;
};

const surface = document.getElementById("fluid-surface") as WgpuSurfaceElement;
const interactionLayer = document.getElementById("interaction-layer") as HTMLDivElement;
const brushCursor = document.getElementById("brush-cursor") as HTMLDivElement;
const pauseButton = document.getElementById("pause-button") as HTMLButtonElement;
const resetButton = document.getElementById("reset-button") as HTMLButtonElement;
const paletteInput = document.getElementById("palette") as HTMLSelectElement;
const hueInput = document.getElementById("hue") as HTMLInputElement;
const radiusInput = document.getElementById("radius") as HTMLInputElement;
const forceInput = document.getElementById("force") as HTMLInputElement;
const swirlInput = document.getElementById("swirl") as HTMLInputElement;
const viscosityInput = document.getElementById("viscosity") as HTMLInputElement;
const fadeInput = document.getElementById("fade") as HTMLInputElement;
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tool]"));

const rangeInputs = [hueInput, radiusInput, forceInput, swirlInput, viscosityInput, fadeInput];

let wgpuViewId = 0;
let started = false;
let paused = false;
let activeTool = 0;
let pointerDown = false;
let lastPoint = { x: 0.5, y: 0.5 };
let configureTimer: ReturnType<typeof setTimeout> | null = null;
let pendingInjection: FluidInjection | null = null;
let injectionInFlight = false;
let injectionFrame = 0;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readConfig(): FluidConfig {
	return {
		palette: Number(paletteInput.value),
		hue: Number(hueInput.value),
		radius: Number(radiusInput.value),
		force: Number(forceInput.value),
		swirl: Number(swirlInput.value),
		viscosity: Number(viscosityInput.value),
		fade: Number(fadeInput.value),
		paused,
	};
}

function updateOutputs() {
	for (const input of rangeInputs) {
		const output = document.getElementById(`${input.id}-value`);
		if (output) output.textContent = input.value;
	}
	const diameter = 16 + Number(radiusInput.value) * 5;
	brushCursor.style.width = `${diameter}px`;
	brushCursor.style.height = `${diameter}px`;
	const hue = Math.round(Number(hueInput.value) * 3.6);
	brushCursor.style.borderColor = `hsla(${hue}, 94%, 78%, 0.9)`;
}

async function configure() {
	if (!wgpuViewId) return;
	await electrobun.rpc!.request.configureFluid({
		id: wgpuViewId,
		rect: readRect(),
		config: readConfig(),
	});
}

function scheduleConfigure() {
	updateOutputs();
	if (configureTimer) clearTimeout(configureTimer);
	configureTimer = setTimeout(() => {
		void configure().catch((error) => console.error("[odin-fluid] configure failed", error));
	}, 24);
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	statusEl.textContent = "Starting Odin solver";
	await electrobun.rpc!.request.startFluid({
		id,
		rect: readRect(),
		config: readConfig(),
	});
	await configure();
}

async function bindSurfaceReady() {
	await customElements.whenDefined("electrobun-wgpu");
	if (surface.wgpuViewId) {
		await startSurface(surface.wgpuViewId);
		return;
	}
	surface.on?.("ready", (event) => {
		void startSurface(event.detail.id).catch((error) => {
			statusEl.textContent = "Surface failed";
			console.error("[odin-fluid] failed to start WGPU surface", error);
		});
	});
}

function normalizedPoint(event: PointerEvent) {
	const rect = interactionLayer.getBoundingClientRect();
	return {
		x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1))),
		y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(rect.height, 1))),
	};
}

function placeCursor(event: PointerEvent) {
	const rect = interactionLayer.getBoundingClientRect();
	brushCursor.style.left = `${event.clientX - rect.left}px`;
	brushCursor.style.top = `${event.clientY - rect.top}px`;
	brushCursor.classList.add("visible");
}

function queueInjection(point: { x: number; y: number }, dx: number, dy: number) {
	pendingInjection = {
		x: point.x,
		y: point.y,
		dx,
		dy,
		tool: activeTool,
		hue: Number(hueInput.value),
		radius: Number(radiusInput.value),
		force: Number(forceInput.value),
	};
	if (!injectionFrame) injectionFrame = requestAnimationFrame(flushInjection);
}

function flushInjection() {
	injectionFrame = 0;
	if (injectionInFlight || !pendingInjection || !wgpuViewId) return;
	const sample = pendingInjection;
	pendingInjection = null;
	injectionInFlight = true;
	void electrobun.rpc!.request
		.injectFluid(sample)
		.catch((error) => console.error("[odin-fluid] pointer injection failed", error))
		.finally(() => {
			injectionInFlight = false;
			if (pendingInjection && !injectionFrame) {
				injectionFrame = requestAnimationFrame(flushInjection);
			}
		});
}

interactionLayer.addEventListener("pointerenter", (event) => placeCursor(event));
interactionLayer.addEventListener("pointerleave", () => {
	if (!pointerDown) brushCursor.classList.remove("visible");
});
interactionLayer.addEventListener("pointerdown", (event) => {
	pointerDown = true;
	interactionLayer.setPointerCapture(event.pointerId);
	lastPoint = normalizedPoint(event);
	placeCursor(event);
	brushCursor.classList.add("drawing");
	queueInjection(lastPoint, 0, 0);
});
interactionLayer.addEventListener("pointermove", (event) => {
	placeCursor(event);
	if (!pointerDown) return;
	const point = normalizedPoint(event);
	queueInjection(point, point.x - lastPoint.x, point.y - lastPoint.y);
	lastPoint = point;
});

function stopDrawing(event: PointerEvent) {
	pointerDown = false;
	brushCursor.classList.remove("drawing");
	if (interactionLayer.hasPointerCapture(event.pointerId)) {
		interactionLayer.releasePointerCapture(event.pointerId);
	}
}

interactionLayer.addEventListener("pointerup", stopDrawing);
interactionLayer.addEventListener("pointercancel", stopDrawing);

function selectTool(tool: number) {
	activeTool = Math.max(0, Math.min(3, tool));
	for (const button of toolButtons) {
		button.classList.toggle("active", Number(button.dataset.tool) === activeTool);
	}
}

for (const button of toolButtons) {
	button.addEventListener("click", () => selectTool(Number(button.dataset.tool)));
}

for (const input of [...rangeInputs, paletteInput]) {
	input.addEventListener("input", scheduleConfigure);
}

pauseButton.addEventListener("click", () => {
	paused = !paused;
	pauseButton.textContent = paused ? "Resume" : "Pause";
	void configure();
});

resetButton.addEventListener("click", () => {
	void electrobun.rpc!.request.resetFluid({});
});

window.addEventListener("keydown", (event) => {
	if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
	if (event.key >= "1" && event.key <= "4") selectTool(Number(event.key) - 1);
	if (event.key === " ") {
		event.preventDefault();
		pauseButton.click();
	}
});

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(scheduleConfigure);
	observer.observe(surface);
}

window.addEventListener("resize", scheduleConfigure);
updateOutputs();

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	console.error("[odin-fluid] failed to bind WGPU surface", error);
});
