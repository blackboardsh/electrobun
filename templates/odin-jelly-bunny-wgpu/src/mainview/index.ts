import { Electroview } from "electrobun/view";

type SurfaceRect = {
	width: number;
	height: number;
};

type JellyParams = {
	id: number;
	rect: SurfaceRect;
	gravity: number;
	squish: number;
	stiffness: number;
	paused: boolean;
};

type PointerParams = {
	phase: number;
	x: number;
	y: number;
};

type JellyRPC = {
	bun: {
		requests: {
			startJelly: {
				params: JellyParams;
				response: { ok: boolean };
			};
			configureJelly: {
				params: JellyParams;
				response: { ok: boolean };
			};
			pointerJelly: {
				params: PointerParams;
				response: { ok: boolean };
			};
			resetJelly: {
				params: {};
				response: { ok: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			jellyFrame: {
				frame: number;
				fps: number;
				iterations: number;
				grabbed: boolean;
				width: number;
				height: number;
			};
		};
	};
};

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const fpsStat = document.getElementById("fps-stat") as HTMLElement;
const physicsStat = document.getElementById("physics-stat") as HTMLElement;
const grabStat = document.getElementById("grab-stat") as HTMLElement;
const frameStat = document.getElementById("frame-stat") as HTMLElement;
const surfaceStat = document.getElementById("surface-stat") as HTMLElement;
const viewStat = document.getElementById("view-stat") as HTMLElement;

const rpc = Electroview.defineRPC<JellyRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			jellyFrame(payload) {
				fpsStat.textContent = payload.fps.toFixed(0);
				physicsStat.textContent = `${payload.iterations} x 2`;
				grabStat.textContent = payload.grabbed ? "held" : "free";
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
const surfaceShell = document.getElementById("surface-shell") as HTMLDivElement;
const pauseButton = document.getElementById("pause-button") as HTMLButtonElement;
const resetButton = document.getElementById("reset-button") as HTMLButtonElement;
const gravityInput = document.getElementById("gravity") as HTMLInputElement;
const squishInput = document.getElementById("squish") as HTMLInputElement;
const stiffnessInput = document.getElementById("stiffness") as HTMLInputElement;
const gravityValue = document.getElementById("gravity-value") as HTMLOutputElement;
const squishValue = document.getElementById("squish-value") as HTMLOutputElement;
const stiffnessValue = document.getElementById("stiffness-value") as HTMLOutputElement;
const materialLabel = document.getElementById("material-label") as HTMLElement;

let wgpuViewId = 0;
let started = false;
let paused = false;
let configureFrame = 0;
let activePointer: number | null = null;
let queuedPointer: PointerParams | null = null;
let pointerSending = false;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readParams(): JellyParams {
	return {
		id: wgpuViewId,
		rect: readRect(),
		gravity: Number(gravityInput.value),
		squish: Number(squishInput.value),
		stiffness: Number(stiffnessInput.value),
		paused,
	};
}

function updateControlLabels() {
	gravityValue.value = gravityInput.value;
	squishValue.value = squishInput.value;
	stiffnessValue.value = stiffnessInput.value;
	const squish = Number(squishInput.value);
	materialLabel.textContent = squish > 72 ? "Taffy" : squish > 38 ? "Jelly" : "Firm";
}

async function configure() {
	if (!wgpuViewId) return;
	const params = readParams();
	await electrobun.rpc!.request.configureJelly(params);
	surfaceStat.textContent = `${params.rect.width} x ${params.rect.height}`;
}

function scheduleConfigure() {
	updateControlLabels();
	if (configureFrame) cancelAnimationFrame(configureFrame);
	configureFrame = requestAnimationFrame(() => {
		configureFrame = 0;
		void configure();
	});
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	viewStat.textContent = String(id);
	await electrobun.rpc!.request.startJelly(readParams());
	statusEl.textContent = "Surface ready";
	statusEl.dataset.state = "ready";
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

function pointerPayload(phase: number, event: PointerEvent): PointerParams {
	const rect = surfaceShell.getBoundingClientRect();
	return {
		phase,
		x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(rect.width, 1))),
		y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(rect.height, 1))),
	};
}

async function flushPointerQueue() {
	if (pointerSending || !wgpuViewId) return;
	pointerSending = true;
	try {
		while (queuedPointer) {
			const payload = queuedPointer;
			queuedPointer = null;
			await electrobun.rpc!.request.pointerJelly(payload);
		}
	} finally {
		pointerSending = false;
		if (queuedPointer) void flushPointerQueue();
	}
}

function queuePointer(phase: number, event: PointerEvent) {
	queuedPointer = pointerPayload(phase, event);
	void flushPointerQueue();
}

surfaceShell.addEventListener("pointerdown", (event) => {
	if (activePointer !== null) return;
	activePointer = event.pointerId;
	surfaceShell.setPointerCapture(event.pointerId);
	surfaceShell.dataset.dragging = "true";
	queuePointer(0, event);
});

surfaceShell.addEventListener("pointermove", (event) => {
	if (event.pointerId !== activePointer) return;
	queuePointer(1, event);
});

function releasePointer(event: PointerEvent) {
	if (event.pointerId !== activePointer) return;
	queuePointer(2, event);
	if (surfaceShell.hasPointerCapture(event.pointerId)) {
		surfaceShell.releasePointerCapture(event.pointerId);
	}
	activePointer = null;
	surfaceShell.dataset.dragging = "false";
}

surfaceShell.addEventListener("pointerup", releasePointer);
surfaceShell.addEventListener("pointercancel", releasePointer);

pauseButton.addEventListener("click", () => {
	paused = !paused;
	pauseButton.textContent = paused ? "Resume" : "Pause";
	void configure();
});

resetButton.addEventListener("click", () => {
	void electrobun.rpc!.request.resetJelly({});
});

for (const input of [gravityInput, squishInput, stiffnessInput]) {
	input.addEventListener("input", scheduleConfigure);
}

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(scheduleConfigure);
	observer.observe(surface);
}

window.addEventListener("resize", scheduleConfigure);
updateControlLabels();

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	statusEl.dataset.state = "error";
	console.error("[odin-jelly] failed to bind WGPU surface", error);
});
