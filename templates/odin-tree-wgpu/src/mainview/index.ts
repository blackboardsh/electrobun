import { Electroview } from "electrobun/view";

type SurfaceRect = {
	width: number;
	height: number;
};

type TreeParams = {
	id: number;
	rect: SurfaceRect;
	seed: number;
	species: number;
	branching: number;
	density: number;
	growth: number;
	wind: number;
};

type TreeStudioRPC = {
	bun: {
		requests: {
			startGpu: { params: TreeParams; response: { ok: boolean } };
			configureGpu: { params: TreeParams; response: { ok: boolean } };
			regenerateTree: { params: TreeParams; response: { ok: boolean } };
			restartGrowth: { params: {}; response: { ok: boolean } };
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			treeFrame: {
				id: number;
				frame: number;
				width: number;
				height: number;
				branches: number;
				leaves: number;
				growth: number;
			};
		};
	};
};

const frameStat = document.getElementById("frame-stat") as HTMLElement;
const branchStat = document.getElementById("branch-stat") as HTMLElement;
const leafStat = document.getElementById("leaf-stat") as HTMLElement;
const growthStat = document.getElementById("growth-stat") as HTMLElement;
const surfaceStat = document.getElementById("surface-stat") as HTMLElement;

const rpc = Electroview.defineRPC<TreeStudioRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			treeFrame(payload) {
				frameStat.textContent = payload.frame.toLocaleString();
				branchStat.textContent = payload.branches.toLocaleString();
				leafStat.textContent = payload.leaves.toLocaleString();
				growthStat.textContent = `${Math.round(payload.growth * 100)}%`;
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

const surface = document.getElementById("tree-surface") as WgpuSurfaceElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const speciesInput = document.getElementById("species") as HTMLSelectElement;
const seedInput = document.getElementById("seed") as HTMLInputElement;
const branchingInput = document.getElementById("branching") as HTMLInputElement;
const densityInput = document.getElementById("density") as HTMLInputElement;
const growthInput = document.getElementById("growth") as HTMLInputElement;
const windInput = document.getElementById("wind") as HTMLInputElement;
const branchingValue = document.getElementById("branching-value") as HTMLElement;
const densityValue = document.getElementById("density-value") as HTMLElement;
const growthValue = document.getElementById("growth-value") as HTMLElement;
const windValue = document.getElementById("wind-value") as HTMLElement;
const regenerateButton = document.getElementById("regenerate-button") as HTMLButtonElement;
const restartButton = document.getElementById("restart-button") as HTMLButtonElement;

let wgpuViewId = 0;
let started = false;
let regenerateTimer: ReturnType<typeof setTimeout> | undefined;

function readRect(): SurfaceRect {
	const rect = surface.getBoundingClientRect();
	return {
		width: Math.max(1, Math.round(rect.width)),
		height: Math.max(1, Math.round(rect.height)),
	};
}

function readSeed(): number {
	const parsed = Number.parseInt(seedInput.value, 10);
	const seed = Number.isFinite(parsed) ? parsed : 1847;
	const normalized = Math.max(1, Math.min(0xffffffff, Math.trunc(seed)));
	seedInput.value = String(normalized);
	return normalized;
}

function readParams(): TreeParams {
	return {
		id: wgpuViewId,
		rect: readRect(),
		seed: readSeed(),
		species: Number(speciesInput.value),
		branching: Number(branchingInput.value),
		density: Number(densityInput.value),
		growth: Number(growthInput.value),
		wind: Number(windInput.value),
	};
}

function updateLabels() {
	branchingValue.textContent = branchingInput.value;
	densityValue.textContent = densityInput.value;
	growthValue.textContent = growthInput.value;
	windValue.textContent = windInput.value;
}

async function configure() {
	if (!wgpuViewId) return;
	const params = readParams();
	await electrobun.rpc!.request.configureGpu(params);
	surfaceStat.textContent = `${params.rect.width} x ${params.rect.height}`;
}

async function regenerate() {
	if (!wgpuViewId) return;
	regenerateButton.disabled = true;
	statusEl.textContent = "Growing a new canopy";
	try {
		await electrobun.rpc!.request.regenerateTree(readParams());
		statusEl.textContent = `${speciesInput.selectedOptions[0]?.textContent ?? "Tree"} generated`;
	} finally {
		regenerateButton.disabled = false;
	}
}

function scheduleRegenerate() {
	if (regenerateTimer) clearTimeout(regenerateTimer);
	regenerateTimer = setTimeout(() => {
		void regenerate().catch(reportError);
	}, 160);
}

function reportError(error: unknown) {
	statusEl.textContent = "Native renderer unavailable";
	console.error("[odin-tree] Tree Studio request failed", error);
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
		void startSurface(event.detail.id).catch(reportError);
	});
}

speciesInput.addEventListener("change", scheduleRegenerate);
branchingInput.addEventListener("input", () => {
	updateLabels();
	scheduleRegenerate();
});
densityInput.addEventListener("input", () => {
	updateLabels();
	scheduleRegenerate();
});
growthInput.addEventListener("input", () => {
	updateLabels();
	void configure().catch(reportError);
});
windInput.addEventListener("input", () => {
	updateLabels();
	void configure().catch(reportError);
});

seedInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") void regenerate().catch(reportError);
});
regenerateButton.addEventListener("click", () => void regenerate().catch(reportError));
restartButton.addEventListener("click", () => {
	void electrobun.rpc!.request.restartGrowth({}).catch(reportError);
});

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(() => void configure().catch(reportError));
	observer.observe(surface);
}
window.addEventListener("resize", () => void configure().catch(reportError));

updateLabels();
void bindSurfaceReady().catch(reportError);
