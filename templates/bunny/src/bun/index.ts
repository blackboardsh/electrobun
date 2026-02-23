import {
	BrowserView,
	BrowserWindow,
	Screen,
	type RPCSchema,
} from "electrobun/bun";

const display = Screen.getPrimaryDisplay();
const workArea = display.workArea;

const MAX_BUNNIES = 10;
const ready = new Set<BrowserWindow>();

export type BunnyRPC = {
	bun: RPCSchema<{
		requests: {};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			cursorMove: {
				screenX: number;
				screenY: number;
				winX: number;
				winY: number;
				winW: number;
				winH: number;
			};
		};
	}>;
};

function randomFrame() {
	const size = 100 + Math.floor(Math.random() * 200);
	const x =
		workArea.x + Math.floor(Math.random() * Math.max(0, workArea.width - size));
	const y =
		workArea.y +
		Math.floor(Math.random() * Math.max(0, workArea.height - size));
	return { width: size, height: size, x, y };
}

const windows: BrowserWindow[] = [];

function spawnBunny() {
	const rpc = BrowserView.defineRPC<BunnyRPC>({
		maxRequestTime: 5000,
		handlers: {
			requests: {},
			messages: {},
		},
	});

	const win = new BrowserWindow({
		title: "Bunny",
		url: "views://mainview/index.html",
		titleBarStyle: "hidden",
		transparent: true,
		passthrough: true,
		frame: randomFrame(),
		rpc,
	});

	win.setAlwaysOnTop(true);

	// Send initial cursor position as soon as the webview is ready
	win.webview.on("dom-ready", () => {
		ready.add(win);
		try {
			const cursor = Screen.getCursorScreenPoint();
			const frame = win.getFrame();
			(win.webview.rpc as any)?.send?.cursorMove({
				screenX: cursor.x,
				screenY: cursor.y,
				winX: frame.x,
				winY: frame.y,
				winW: frame.width,
				winH: frame.height,
			});
		} catch {}
	});

	win.on("close", () => {
		ready.delete(win);
	});

	windows.push(win);
	console.log(`Bunny ${windows.length} hopping!`);
}

function sendCursor(win: BrowserWindow) {
	const cursor = Screen.getCursorScreenPoint();
	const frame = win.getFrame();
	(win.webview.rpc as any)?.send?.cursorMove({
		screenX: cursor.x,
		screenY: cursor.y,
		winX: frame.x,
		winY: frame.y,
		winW: frame.width,
		winH: frame.height,
	});
}

// Start polling cursor for the last remaining bunny
let pollInterval: ReturnType<typeof setInterval> | null = null;

function startPolling() {
	if (pollInterval) return;
	pollInterval = setInterval(() => {
		if (ready.size !== 1) {
			stopPolling();
			return;
		}
		const win = ready.values().next().value!;
		try {
			sendCursor(win);
		} catch {
			ready.delete(win);
		}
	}, 50);
}

function stopPolling() {
	if (pollInterval) {
		clearInterval(pollInterval);
		pollInterval = null;
	}
}

// Spawn the first bunny immediately
spawnBunny();

// Spawn more on random intervals until we hit the max
function spawnLoop() {
	if (windows.length >= MAX_BUNNIES) {
		hideLoop();
		return;
	}
	spawnBunny();
	const delay = 200 + Math.floor(Math.random() * 800);
	setTimeout(spawnLoop, delay);
}

// Close bunnies one by one, leaving a random survivor
let toClose: BrowserWindow[] = [];

function hideLoop() {
	// On first call, pick a random survivor
	if (toClose.length === 0 && windows.length > 1) {
		const survivorIndex = Math.floor(Math.random() * windows.length);
		const survivor = windows[survivorIndex];
		toClose = windows.filter((_, i) => i !== survivorIndex);
		windows.length = 0;
		windows.push(survivor);
	}

	if (toClose.length === 0) {
		console.log("Just one bunny left!");
		startPolling();
		return;
	}
	const win = toClose.pop()!;
	ready.delete(win);
	win.close();
	const delay = 100 + Math.floor(Math.random() * 400);
	setTimeout(hideLoop, delay);
}

// Start spawning after a short initial delay
setTimeout(spawnLoop, 100 + Math.floor(Math.random() * 1000));
