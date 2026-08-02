import { Electroview } from "electrobun/view";

type SurfaceRect = {
	width: number;
	height: number;
};

type GpuParams = {
	id: number;
	rect: SurfaceRect;
	mode: number;
	count: number;
	gravity: number;
	force: number;
	paused: boolean;
};

type OdinParticlesRPC = {
	bun: {
		requests: {
			startGpu: {
				params: GpuParams;
				response: { ok: boolean };
			};
			configureGpu: {
				params: GpuParams;
				response: { ok: boolean };
			};
			resetSim: {
				params: {};
				response: { ok: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			gpuFrame: {
				id: number;
				frame: number;
				width: number;
				height: number;
				alive: number;
			};
		};
	};
};

const rpc = Electroview.defineRPC<OdinParticlesRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			gpuFrame(payload) {
				frameStat.textContent = payload.frame.toLocaleString();
				aliveStat.textContent = payload.alive.toLocaleString();
				surfaceStat.textContent = `${payload.width} x ${payload.height}`;
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
const pauseButton = document.getElementById("pause-button") as HTMLButtonElement;
const resetButton = document.getElementById("reset-button") as HTMLButtonElement;
const emitterModeInput = document.getElementById("emitter-mode") as HTMLSelectElement;
const countInput = document.getElementById("count") as HTMLInputElement;
const countLabel = document.getElementById("count-label") as HTMLElement;
const gravityInput = document.getElementById("gravity") as HTMLInputElement;
const forceInput = document.getElementById("force") as HTMLInputElement;
const frameStat = document.getElementById("frame-stat") as HTMLElement;
const aliveStat = document.getElementById("alive-stat") as HTMLElement;
const surfaceStat = document.getElementById("surface-stat") as HTMLElement;
const viewStat = document.getElementById("view-stat") as HTMLElement;

let wgpuViewId = 0;
let started = false;
let paused = false;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readParams(): GpuParams {
	return {
		id: wgpuViewId,
		rect: readRect(),
		mode: Number(emitterModeInput.value),
		count: Number(countInput.value),
		gravity: Number(gravityInput.value),
		force: Number(forceInput.value),
		paused,
	};
}

function updateCountLabel() {
	countLabel.textContent = Number(countInput.value).toLocaleString();
}

async function configure() {
	if (!wgpuViewId) return;
	const params = readParams();
	await electrobun.rpc!.request.configureGpu(params);
	surfaceStat.textContent = `${params.rect.width} x ${params.rect.height}`;
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	viewStat.textContent = String(wgpuViewId);
	statusEl.textContent = "Surface ready";
	await electrobun.rpc!.request.startGpu(readParams());
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

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	console.error("[odin-particles] failed to bind WGPU surface", error);
});

pauseButton.addEventListener("click", () => {
	paused = !paused;
	pauseButton.textContent = paused ? "Resume" : "Pause";
	void configure();
});

resetButton.addEventListener("click", () => {
	void electrobun.rpc!.request.resetSim({});
});

emitterModeInput.addEventListener("change", () => void configure());
countInput.addEventListener("input", () => {
	updateCountLabel();
	void configure();
});
gravityInput.addEventListener("input", () => void configure());
forceInput.addEventListener("input", () => void configure());

updateCountLabel();

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(() => void configure());
	observer.observe(surface);
}

window.addEventListener("resize", () => void configure());
