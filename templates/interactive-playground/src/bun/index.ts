import Electrobun, { BrowserWindow, BrowserView, Utils } from "electrobun/bun";
import { type PlaygroundRPC } from "./types/rpc";

// Import demo modules
import { windowManager } from "./demos/windows";
import { menuManager } from "./demos/menus";
import { fileManager } from "./demos/files";
import { rpcTester } from "./demos/rpc";

console.log("🚀 Electrobun Interactive Playground starting...");

// Set up RPC communication
const rpc = BrowserView.defineRPC<PlaygroundRPC>({
	maxRequestTime: 10000,
	handlers: {
		requests: {
			// Window Management
			createWindow: windowManager.createWindow.bind(windowManager),
			closeWindow: windowManager.closeWindow.bind(windowManager),
			focusWindow: windowManager.focusWindow.bind(windowManager),
			getWindowList: windowManager.getWindowList.bind(windowManager),

			// RPC Testing
			doMath: rpcTester.doMath.bind(rpcTester),
			echoBigData: rpcTester.echoBigData.bind(rpcTester),

			// Menu Operations
			createTray: menuManager.createTray.bind(menuManager),
			removeTray: menuManager.removeTray.bind(menuManager),
			showContextMenu: menuManager.showContextMenu.bind(menuManager),

			// File Operations
			openFileDialog: fileManager.openFileDialog.bind(fileManager),
			moveToTrash: fileManager.moveToTrash.bind(fileManager),
			showInFinder: fileManager.showInFinder.bind(fileManager),

			// WebView Operations (placeholder)
			createWebView: async (_url: string) => ({ id: 1 }),
			executeJSInWebView: async (_params: { id: number; script: string }) =>
				null,
		},
		messages: {
			"*": (messageName, payload) => {
				console.log(`📨 Message received: ${messageName}`, payload);
			},
		},
	},
});

// Create main playground window
const mainWindow = new BrowserWindow({
	title: "Electrobun Interactive Playground",
	url: "views://mainview/index.html",
	renderer: "cef",
	frame: {
		width: 1400,
		height: 900,
		x: 100,
		y: 100,
	},
	titleBarStyle: "default",
	rpc,
});

// Set up event forwarding from demo modules to the UI
windowManager.onWindowCreated = (id, title) => {
	rpc.send.windowCreated({ id, title });
};

windowManager.onWindowClosed = (id) => {
	rpc.send.windowClosed({ id });
};

windowManager.onWindowFocused = (id) => {
	rpc.send.windowFocused({ id });
};

menuManager.onTrayClicked = (id, action) => {
	rpc.send.trayClicked({ id, action });
	console.log(`🔔 Tray ${id} clicked: ${action}`);
};

menuManager.onMenuClicked = (action) => {
	rpc.send.menuClicked({ action });
	console.log(`🎛️ Menu clicked: ${action}`);
};

fileManager.onFileSelected = (paths) => {
	rpc.send.fileSelected({ paths });
	console.log(`📁 Files selected:`, paths);
};

fileManager.onSystemEvent = (event) => {
	rpc.send.systemEvent(event);
	console.log(`⚙️ System event:`, event);
};

rpcTester.onRpcTestResult = (data) => {
	rpc.send.rpcTestResult(data);
	console.log(`📡 RPC test result:`, data);
};

// Listen for global events
Electrobun.events.on("application-menu-clicked", (e) => {
	menuManager.onMenuClicked?.(e.data.action);
});

Electrobun.events.on("context-menu-clicked", (e) => {
	menuManager.onMenuClicked?.(e.data.action);
});

// Send initial status
mainWindow.webview.on("dom-ready", () => {
	console.log("✅ Main window DOM ready");
	rpc.send.logMessage({
		level: "info",
		message: "Electrobun Interactive Playground loaded successfully!",
	});
});

// Quit the app when the main window is closed
mainWindow.on("close", () => {
	Utils.quit();
});

console.log("🎮 Playground initialized successfully");
