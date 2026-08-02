import { Electroview } from "electrobun/view";

type SurfaceRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type FlockConfig = {
	agents: number;
	repel: number;
	speed: number;
	cohesion: number;
	separation: number;
};

type RustFlockRPC = {
	bun: {
		requests: {
			startFlock: {
				params: { id: number; rect: SurfaceRect; config: FlockConfig };
				response: { ok: boolean };
			};
			configureFlock: {
				params: { id: number; rect: SurfaceRect; config: FlockConfig };
				response: { ok: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			flockFrame: {
				frame: number;
				agents: number;
				fps: number;
				cursorX: number;
				cursorY: number;
				width: number;
				height: number;
			};
		};
	};
};

const rpc = Electroview.defineRPC<RustFlockRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			flockFrame(payload) {
				agentStat.textContent = payload.agents.toLocaleString();
				fpsStat.textContent = payload.fps.toFixed(0);
				surfaceStat.textContent = `${payload.width} x ${payload.height}`;
				cursorStat.textContent =
					payload.cursorX >= 0 && payload.cursorY >= 0
						? `${Math.round(payload.cursorX)}, ${Math.round(payload.cursorY)}`
						: "--";
			},
		},
	},
});

const electrobun = new Electroview({ rpc });

type WgpuSurfaceElement = HTMLElement & {
	wgpuViewId?: number | null;
	on?: (event: "ready", listener: (event: CustomEvent<{ id: number }>) => void) => void;
};

const surface = document.querySelector("electrobun-wgpu") as WgpuSurfaceElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const agentsInput = document.getElementById("agents") as HTMLInputElement;
const repelInput = document.getElementById("repel") as HTMLInputElement;
const speedInput = document.getElementById("speed") as HTMLInputElement;
const cohesionInput = document.getElementById("cohesion") as HTMLInputElement;
const separationInput = document.getElementById("separation") as HTMLInputElement;
const agentStat = document.getElementById("agent-stat") as HTMLElement;
const fpsStat = document.getElementById("fps-stat") as HTMLElement;
const surfaceStat = document.getElementById("surface-stat") as HTMLElement;
const viewStat = document.getElementById("view-stat") as HTMLElement;
const cursorStat = document.getElementById("cursor-stat") as HTMLElement;

let wgpuViewId = 0;
let started = false;
let configureTimer: ReturnType<typeof setTimeout> | null = null;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readConfig(): FlockConfig {
	return {
		agents: Number(agentsInput.value),
		repel: Number(repelInput.value),
		speed: Number(speedInput.value),
		cohesion: Number(cohesionInput.value),
		separation: Number(separationInput.value),
	};
}

async function configure() {
	if (!wgpuViewId) return;
	const rect = readRect();
	await electrobun.rpc!.request.configureFlock({
		id: wgpuViewId,
		rect,
		config: readConfig(),
	});
	surfaceStat.textContent = `${rect.width} x ${rect.height}`;
}

function scheduleConfigure() {
	if (configureTimer) clearTimeout(configureTimer);
	configureTimer = setTimeout(() => {
		void configure();
	}, 20);
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	viewStat.textContent = String(wgpuViewId);
	const rect = readRect();
	statusEl.textContent = "Surface ready";
	await electrobun.rpc!.request.startFlock({
		id: wgpuViewId,
		rect,
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
		void startSurface(event.detail.id);
	});
}

for (const input of [agentsInput, repelInput, speedInput, cohesionInput, separationInput]) {
	input.addEventListener("input", scheduleConfigure);
}

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(scheduleConfigure);
	observer.observe(surface);
}

window.addEventListener("resize", scheduleConfigure);

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	console.error("[rust-flock-wgpu] failed to bind WGPU surface", error);
});
