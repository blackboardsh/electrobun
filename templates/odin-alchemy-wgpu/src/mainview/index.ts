import { Electroview } from "electrobun/view";

type SurfaceRect = {
	width: number;
	height: number;
};

type SurfaceParams = {
	id: number;
	rect: SurfaceRect;
	paused: boolean;
};

type PaintStroke = {
	fromX: number;
	fromY: number;
	toX: number;
	toY: number;
	radius: number;
	material: number;
};

type AlchemyRPC = {
	bun: {
		requests: {
			startGpu: {
				params: SurfaceParams;
				response: { ok: boolean };
			};
			configureGpu: {
				params: SurfaceParams;
				response: { ok: boolean };
			};
			resetSim: {
				params: { seed: number };
				response: { ok: boolean };
			};
			stepSim: {
				params: {};
				response: { ok: boolean };
			};
		};
		messages: {
			paintStroke: PaintStroke;
		};
	};
	webview: {
		requests: {};
		messages: {
			simStats: {
				fps: number;
				cells: number;
				tick: number;
				width: number;
				height: number;
			};
		};
	};
};

const statusEl = document.getElementById("surface-status") as HTMLParagraphElement;
const surfaceStat = document.getElementById("surface-stat") as HTMLElement;
const fpsStat = document.getElementById("fps-stat") as HTMLElement;
const cellStat = document.getElementById("cell-stat") as HTMLElement;
const tickStat = document.getElementById("tick-stat") as HTMLElement;

const rpc = Electroview.defineRPC<AlchemyRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			simStats(payload) {
				fpsStat.textContent = payload.fps.toFixed(0);
				cellStat.textContent = payload.cells.toLocaleString();
				tickStat.textContent = payload.tick.toLocaleString();
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

const surface = document.getElementById("alchemy-surface") as WgpuSurfaceElement;
const paintLayer = document.getElementById("paint-layer") as HTMLDivElement;
const pauseButton = document.getElementById("pause-button") as HTMLButtonElement;
const stepButton = document.getElementById("step-button") as HTMLButtonElement;
const resetButton = document.getElementById("reset-button") as HTMLButtonElement;
const brushInput = document.getElementById("brush-size") as HTMLInputElement;
const brushValue = document.getElementById("brush-value") as HTMLElement;
const seedInput = document.getElementById("seed-input") as HTMLInputElement;
const seedButton = document.getElementById("seed-button") as HTMLButtonElement;
const materialButtons = Array.from(
	document.querySelectorAll<HTMLButtonElement>(".material"),
);

let wgpuViewId = 0;
let started = false;
let paused = false;
let selectedMaterial = 1;
let activePointer: number | null = null;
let previousPoint = { x: 0, y: 0 };
let resizeFrame = 0;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readParams(): SurfaceParams {
	return {
		id: wgpuViewId,
		rect: readRect(),
		paused,
	};
}

function readSeed(): number {
	const parsed = Number(seedInput.value);
	if (!Number.isFinite(parsed)) return 0x10203040;
	return Math.max(1, Math.min(0xffffffff, Math.trunc(parsed)));
}

async function configure() {
	if (!wgpuViewId) return;
	const params = readParams();
	await electrobun.rpc!.request.configureGpu(params);
	surfaceStat.textContent = `${params.rect.width} x ${params.rect.height}`;
}

function scheduleConfigure() {
	cancelAnimationFrame(resizeFrame);
	resizeFrame = requestAnimationFrame(() => {
		void configure().catch((error) => {
			console.error("[odin-alchemy] surface resize failed", error);
		});
	});
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	statusEl.textContent = "Native surface ready";
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

function selectMaterial(material: number) {
	selectedMaterial = material;
	for (const button of materialButtons) {
		const active = Number(button.dataset.material) === material;
		button.classList.toggle("active", active);
		button.setAttribute("aria-pressed", String(active));
	}
}

function normalizedPoint(event: PointerEvent) {
	const rect = paintLayer.getBoundingClientRect();
	return {
		x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
		y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
	};
}

function sendStroke(from: { x: number; y: number }, to: { x: number; y: number }, material: number) {
	if (!started) return;
	electrobun.rpc!.send.paintStroke({
		fromX: from.x,
		fromY: from.y,
		toX: to.x,
		toY: to.y,
		radius: Number(brushInput.value),
		material,
	});
}

paintLayer.addEventListener("pointerdown", (event) => {
	if (event.button !== 0 && event.button !== 2) return;
	event.preventDefault();
	activePointer = event.pointerId;
	paintLayer.setPointerCapture(event.pointerId);
	previousPoint = normalizedPoint(event);
	sendStroke(previousPoint, previousPoint, event.button === 2 ? 0 : selectedMaterial);
});

paintLayer.addEventListener("pointermove", (event) => {
	if (activePointer !== event.pointerId) return;
	const point = normalizedPoint(event);
	sendStroke(previousPoint, point, (event.buttons & 2) !== 0 ? 0 : selectedMaterial);
	previousPoint = point;
});

function finishPointer(event: PointerEvent) {
	if (activePointer !== event.pointerId) return;
	activePointer = null;
	if (paintLayer.hasPointerCapture(event.pointerId)) {
		paintLayer.releasePointerCapture(event.pointerId);
	}
}

paintLayer.addEventListener("pointerup", finishPointer);
paintLayer.addEventListener("pointercancel", finishPointer);
paintLayer.addEventListener("contextmenu", (event) => event.preventDefault());

for (const button of materialButtons) {
	button.addEventListener("click", () => {
		selectMaterial(Number(button.dataset.material));
	});
}

brushInput.addEventListener("input", () => {
	brushValue.textContent = brushInput.value;
});

pauseButton.addEventListener("click", () => {
	paused = !paused;
	pauseButton.textContent = paused ? "Resume" : "Pause";
	void configure();
});

stepButton.addEventListener("click", () => {
	paused = true;
	pauseButton.textContent = "Resume";
	void configure().then(() => electrobun.rpc!.request.stepSim({}));
});

function resetSimulation() {
	void electrobun.rpc!.request.resetSim({ seed: readSeed() });
}

resetButton.addEventListener("click", resetSimulation);
seedButton.addEventListener("click", resetSimulation);
seedInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") resetSimulation();
});

window.addEventListener("keydown", (event) => {
	if (event.target instanceof HTMLInputElement) return;
	if (event.key >= "1" && event.key <= "7") {
		const materialOrder = [1, 2, 3, 4, 5, 6, 0];
		selectMaterial(materialOrder[Number(event.key) - 1]);
		return;
	}
	if (event.code === "Space") {
		event.preventDefault();
		pauseButton.click();
	} else if (event.key === ".") {
		stepButton.click();
	} else if (event.key.toLowerCase() === "r") {
		resetSimulation();
	}
});

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(scheduleConfigure);
	observer.observe(surface);
}
window.addEventListener("resize", scheduleConfigure);

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	console.error("[odin-alchemy] failed to bind WGPU surface", error);
});
