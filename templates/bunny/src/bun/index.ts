import {
	BrowserView,
	BrowserWindow,
	Screen,
	Utils,
	type RPCSchema,
} from "electrobun/bun";

const display = Screen.getPrimaryDisplay();
const workArea = display.workArea;

export type BunnyRPC = {
	bun: RPCSchema<{
		requests: {};
		messages: {
			bunnyClicked: void;
		};
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

const size = 100 + Math.floor(Math.random() * 200);
const x =
	workArea.x + Math.floor(Math.random() * Math.max(0, workArea.width - size));
const y =
	workArea.y + Math.floor(Math.random() * Math.max(0, workArea.height - size));

const rpc = BrowserView.defineRPC<BunnyRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			bunnyClicked: () => {
				Utils.openExternal("https://blackboard.sh/electrobun");
			},
		},
	},
});

const win = new BrowserWindow({
	title: "Bunny",
	url: "views://mainview/index.html",
	titleBarStyle: "hidden",
	transparent: true,
	passthrough: true,
	frame: { width: size, height: size, x, y },
	rpc,
});

win.setAlwaysOnTop(true);
win.setVisibleOnAllWorkspaces(true);

function sendCursor() {
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

// Send initial cursor position as soon as the webview is ready
win.webview.on("dom-ready", () => {
	try { sendCursor(); } catch {}
	startPolling();
});

// Adaptive-rate cursor polling: slow (400ms) when idle, fast (100ms) when moving
const POLL_SLOW = 400;
const POLL_FAST = 100;
const FAST_DURATION = 1000;

let pollTimeout: ReturnType<typeof setTimeout> | null = null;
let lastCursorX = 0;
let lastCursorY = 0;
let fastUntil = 0;

function pollCursor() {
	pollTimeout = null;

	try {
		const cursor = Screen.getCursorScreenPoint();
		const moved = cursor.x !== lastCursorX || cursor.y !== lastCursorY;
		lastCursorX = cursor.x;
		lastCursorY = cursor.y;

		if (moved) {
			fastUntil = Date.now() + FAST_DURATION;
			sendCursor();
		}

		const delay = Date.now() < fastUntil ? POLL_FAST : POLL_SLOW;
		pollTimeout = setTimeout(pollCursor, delay);
	} catch {}
}

function startPolling() {
	if (pollTimeout) return;
	try {
		const cursor = Screen.getCursorScreenPoint();
		lastCursorX = cursor.x;
		lastCursorY = cursor.y;
	} catch {}
	pollTimeout = setTimeout(pollCursor, POLL_SLOW);
}
