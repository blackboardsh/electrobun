import { BrowserView, BrowserWindow, type RPCSchema } from "electrobun/bun";

// Track child windows
const childWindows: Map<number, BrowserWindow> = new Map();
let nextChildId = 1;

// RPC schema for the main window
type MainWindowRPC = {
	bun: RPCSchema<{
		requests: {
			openChildWindow: {
				params: { title?: string };
				response: { id: number };
			};
			closeChildWindow: {
				params: { id: number };
				response: { success: boolean };
			};
			getChildWindows: {
				params: {};
				response: Array<{ id: number; title: string }>;
			};
			sendToChild: {
				params: { id: number; message: string };
				response: { success: boolean };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			childWindowOpened: { id: number; title: string };
			childWindowClosed: { id: number };
		};
	}>;
};

// RPC schema for child windows
type ChildWindowRPC = {
	bun: RPCSchema<{
		requests: {
			sendToMain: {
				params: { message: string };
				response: { success: boolean };
			};
			sendToChild: {
				params: { id: number; message: string };
				response: { success: boolean };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			receiveMessage: { from: string; message: string };
			setWindowInfo: { id: number; title: string };
		};
	}>;
};

// Main window RPC handlers
const mainRPC = BrowserView.defineRPC<MainWindowRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {
			openChildWindow: ({ title }) => {
				const id = nextChildId++;
				const windowTitle = title || `Child Window ${id}`;
				createChildWindow(id, windowTitle);
				return { id };
			},
			closeChildWindow: ({ id }) => {
				const child = childWindows.get(id);
				if (child) {
					child.close();
					return { success: true };
				}
				return { success: false };
			},
			getChildWindows: () => {
				const windows: Array<{ id: number; title: string }> = [];
				for (const [id, win] of childWindows) {
					windows.push({ id, title: `Child Window ${id}` });
				}
				return windows;
			},
			sendToChild: ({ id, message }) => {
				const child = childWindows.get(id);
				if (child) {
					(child.webview.rpc as any)?.send?.receiveMessage({
						from: "Main Window",
						message,
					});
					return { success: true };
				}
				return { success: false };
			},
		},
		messages: {},
	},
});

const mainWindow = new BrowserWindow({
	title: "Multi-Window Demo",
	url: "views://mainview/index.html",
	rpc: mainRPC,
	frame: {
		width: 700,
		height: 600,
		x: 100,
		y: 100,
	},
});

function createChildWindow(id: number, title: string) {
	const childRPC = BrowserView.defineRPC<ChildWindowRPC>({
		maxRequestTime: 5000,
		handlers: {
			requests: {
				sendToMain: ({ message }) => {
					(mainWindow.webview.rpc as any)?.send?.receiveMessage({
						from: `Child ${id}`,
						message,
					});
					return { success: true };
				},
				sendToChild: ({ id: targetId, message }) => {
					const target = childWindows.get(targetId);
					if (target) {
						(target.webview.rpc as any)?.send?.receiveMessage({
							from: `Child ${id}`,
							message,
						});
						return { success: true };
					}
					return { success: false };
				},
			},
			messages: {},
		},
	});

	const offset = (id - 1) * 30;
	const child = new BrowserWindow({
		title,
		url: "views://childview/index.html",
		rpc: childRPC,
		frame: {
			width: 500,
			height: 400,
			x: 500 + offset,
			y: 150 + offset,
		},
	});

	childWindows.set(id, child);

	// Notify child of its identity when DOM is ready
	child.webview.on("dom-ready", () => {
		(child.webview.rpc as any)?.send?.setWindowInfo({ id, title });
	});

	// Notify main window
	(mainWindow.webview.rpc as any)?.send?.childWindowOpened({ id, title });

	// Clean up when child closes
	child.on("close", () => {
		childWindows.delete(id);
		(mainWindow.webview.rpc as any)?.send?.childWindowClosed({ id });
	});
}

console.log("Multi-window app started!");
