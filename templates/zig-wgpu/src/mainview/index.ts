import { Electroview } from "electrobun/view";

type SurfaceRect = {
	width: number;
	height: number;
};

type ZigWgpuRPC = {
	bun: {
		requests: {
			startGpu: {
				params: { id: number; rect: SurfaceRect; mode: number; motion: number };
				response: { ok: boolean };
			};
			configureGpu: {
				params: { id: number; rect: SurfaceRect; mode: number; motion: number };
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
			};
		};
	};
};

const rpc = Electroview.defineRPC<ZigWgpuRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			gpuFrame(payload) {
				frameStat.textContent = payload.frame.toLocaleString();
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
const modeButton = document.getElementById("mode-button") as HTMLButtonElement;
const motionInput = document.getElementById("motion") as HTMLInputElement;
const shaderModeInput = document.getElementById("shader-mode") as HTMLSelectElement;
const frameStat = document.getElementById("frame-stat") as HTMLElement;
const surfaceStat = document.getElementById("surface-stat") as HTMLElement;
const viewStat = document.getElementById("view-stat") as HTMLElement;

let wgpuViewId = 0;
let started = false;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readMode() {
	return Number(shaderModeInput.value);
}

function readMotion() {
	return Number(motionInput.value);
}

async function configure() {
	if (!wgpuViewId) return;
	const rect = readRect();
	await electrobun.rpc!.request.configureGpu({
		id: wgpuViewId,
		rect,
		mode: readMode(),
		motion: readMotion(),
	});
	surfaceStat.textContent = `${rect.width} x ${rect.height}`;
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	viewStat.textContent = String(wgpuViewId);
	const rect = readRect();
	statusEl.textContent = "Surface ready";
	await electrobun.rpc!.request.startGpu({
		id: wgpuViewId,
		rect,
		mode: readMode(),
		motion: readMotion(),
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

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	console.error("[zig-wgpu] failed to bind WGPU surface", error);
});

modeButton.addEventListener("click", () => {
	shaderModeInput.value = shaderModeInput.value === "0" ? "1" : "0";
	void configure();
});
shaderModeInput.addEventListener("change", () => void configure());
motionInput.addEventListener("input", () => void configure());

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(() => void configure());
	observer.observe(surface);
}

window.addEventListener("resize", () => void configure());
