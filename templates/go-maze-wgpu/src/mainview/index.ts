import { Electroview } from "electrobun/view";

type SurfaceRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type MazeConfig = {
	columns: number;
	rows: number;
	generateSpeed: number;
	solveSpeed: number;
	shortcuts: number;
};

type MazeRPC = {
	bun: {
		requests: {
			startMaze: {
				params: { id: number; rect: SurfaceRect; config: MazeConfig };
				response: { ok: boolean };
			};
			configureMaze: {
				params: { id: number; rect: SurfaceRect; config: MazeConfig };
				response: { ok: boolean };
			};
			regenerateMaze: {
				params: { id: number; rect: SurfaceRect; config: MazeConfig };
				response: { ok: boolean };
			};
			solveMaze: {
				params: {};
				response: { ok: boolean };
			};
		};
		messages: {};
	};
	webview: {
		requests: {};
		messages: {
			mazeFrame: {
				status: string;
				columns: number;
				rows: number;
				cells: number;
				visited: number;
				frontier: number;
				path: number;
				fps: number;
			};
		};
	};
};

const rpc = Electroview.defineRPC<MazeRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {},
		messages: {
			mazeFrame(payload) {
				statusEl.textContent = payload.status;
				cellStat.textContent = payload.cells.toLocaleString();
				fpsStat.textContent = payload.fps.toFixed(0);
				gridStat.textContent = `${payload.columns} x ${payload.rows}`;
				frontierStat.textContent = payload.frontier.toLocaleString();
				pathStat.textContent = payload.path ? payload.path.toLocaleString() : "--";
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
const columnsInput = document.getElementById("columns") as HTMLInputElement;
const rowsInput = document.getElementById("rows") as HTMLInputElement;
const generateSpeedInput = document.getElementById("generate-speed") as HTMLInputElement;
const solveSpeedInput = document.getElementById("solve-speed") as HTMLInputElement;
const shortcutsInput = document.getElementById("shortcuts") as HTMLInputElement;
const generateButton = document.getElementById("generate") as HTMLButtonElement;
const solveButton = document.getElementById("solve") as HTMLButtonElement;
const cellStat = document.getElementById("cell-stat") as HTMLElement;
const fpsStat = document.getElementById("fps-stat") as HTMLElement;
const gridStat = document.getElementById("grid-stat") as HTMLElement;
const frontierStat = document.getElementById("frontier-stat") as HTMLElement;
const pathStat = document.getElementById("path-stat") as HTMLElement;

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

function readConfig(): MazeConfig {
	return {
		columns: Number(columnsInput.value),
		rows: Number(rowsInput.value),
		generateSpeed: Number(generateSpeedInput.value),
		solveSpeed: Number(solveSpeedInput.value),
		shortcuts: Number(shortcutsInput.value),
	};
}

async function configure() {
	if (!wgpuViewId) return;
	await electrobun.rpc!.request.configureMaze({
		id: wgpuViewId,
		rect: readRect(),
		config: readConfig(),
	});
}

function scheduleConfigure() {
	if (configureTimer) clearTimeout(configureTimer);
	configureTimer = setTimeout(() => {
		void configure();
	}, 20);
}

async function regenerate() {
	if (!wgpuViewId) return;
	await electrobun.rpc!.request.regenerateMaze({
		id: wgpuViewId,
		rect: readRect(),
		config: readConfig(),
	});
}

async function startSurface(id: number) {
	if (started) return;
	started = true;
	wgpuViewId = id;
	statusEl.textContent = "Generating";
	await electrobun.rpc!.request.startMaze({
		id: wgpuViewId,
		rect: readRect(),
		config: readConfig(),
	});
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

for (const input of [columnsInput, rowsInput, generateSpeedInput, solveSpeedInput, shortcutsInput]) {
	input.addEventListener("input", scheduleConfigure);
}

generateButton.addEventListener("click", () => {
	void regenerate();
});

solveButton.addEventListener("click", () => {
	void electrobun.rpc!.request.solveMaze({});
});

if ("ResizeObserver" in window) {
	const observer = new ResizeObserver(scheduleConfigure);
	observer.observe(surface);
}

window.addEventListener("resize", scheduleConfigure);

void bindSurfaceReady().catch((error) => {
	statusEl.textContent = "Surface failed";
	console.error("[go-maze-wgpu] failed to bind WGPU surface", error);
});
