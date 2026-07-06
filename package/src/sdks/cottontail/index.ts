import webgpu from "./webgpuAdapter";
import * as babylon from "@babylonjs/core";
import * as three from "three";
export {
	createRPC,
	defineElectrobunRPC,
	type ElectrobunRPCSchema,
	type RPCSchema,
} from "../../shared/rpc.js";
import {
	CString,
	drainTimerShim,
	GpuWindow,
	installTimerShim,
	JSCallback,
	ptr,
	toArrayBuffer,
	WGPU,
	WGPUBridge,
	WGPUView,
	type Pointer,
} from "./wgpuRuntime";

type CottontailHost = {
	nanotime?(): number | bigint;
	sleep?(ms: number): void;
	drainJobs?(): void;
	cwd(): string;
	env(name?: string): string | Record<string, string> | undefined;
	readFile(path: string): string;
	writeFile(path: string, data: string): void;
	existsSync(path: string): boolean;
	mkdirSync(path: string, recursive?: boolean): void;
	rmSync(path: string, recursive?: boolean, force?: boolean): void;
	unlinkSync(path: string): void;
	chmodSync(path: string, mode: number): void;
	spawnSync(
		file: string,
		args?: string[],
		options?: { stdio?: "inherit" | "pipe"; cwd?: string; env?: Record<string, string> },
	): { status: number; stdout?: string; stderr?: string };
	exit(code?: number): never;
	platform(): string;
	arch(): string;
	args: string[];
};

export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Display = {
	id: number;
	bounds: Rect;
	workArea: Rect;
	scaleFactor: number;
	isPrimary: boolean;
};

export type NativeEvent =
	| { type: "windowClose"; windowId: number }
	| { type: "windowMove"; windowId: number; x: number; y: number }
	| { type: "windowResize"; windowId: number; x: number; y: number; width: number; height: number }
	| { type: "windowFocus"; windowId: number }
	| { type: "windowBlur"; windowId: number }
	| { type: "webviewEvent"; webviewId: number; eventName: string; detail: string }
	| { type: "webviewEventBridge"; webviewId: number; message: string }
	| { type: "webviewHostBridge"; webviewId: number; message: string }
	| { type: "webviewInternalBridge"; webviewId: number; message: string }
	| { type: "statusItem"; itemId: number; message: string }
	| { type: "globalShortcut"; accelerator: string }
	| { type: "urlOpen"; url: string }
	| { type: "appReopen" }
	| { type: "quitRequested" };

type ElectrobunRuntimeHost = {
	createWindow(options?: {
		title?: string;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		titleBarStyle?: string;
		transparent?: boolean;
		hidden?: boolean;
		activate?: boolean;
		trafficLightX?: number;
		trafficLightY?: number;
		quitOnClose?: boolean;
	}): number;
	createWebview(options: {
		windowId: number;
		hostWebviewId?: number;
		renderer?: "native" | "cef";
		url?: string;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		autoResize?: boolean;
		partition?: string;
		secretKey?: string;
		preload?: string;
		viewsRoot?: string;
		sandbox?: boolean;
		startTransparent?: boolean;
		startPassthrough?: boolean;
	}): number;
	closeWindow(windowId: number): void;
	setWindowAlwaysOnTop(windowId: number, flag: boolean): void;
	sendHostMessageToWebview(webviewId: number, message: string): boolean;
	popNextQueuedHostMessage(): { webviewId: number; message: string } | null;
	popNextNativeEvent(): string | null;
	coreCall(signature: string, symbol: string, ...args: any[]): any;
	nativeCall(library: "core" | "wgpu", symbol: string, returnType: "void" | "ptr" | "u32" | "u64" | "bool", ...args: any[]): any;
	memoryAddress(value: ArrayBuffer | ArrayBufferView | number | bigint): number;
	memoryView(ptr: number | bigint, offset: number | bigint, length: number | bigint): ArrayBuffer;
	getWindowFrame(windowId: number): string | null;
	resizeView(symbol: string, viewId: number, x: number, y: number, width: number, height: number, masksJSON: string): void;
	createWGPUView(options: {
		windowId: number;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		startTransparent?: boolean;
		startPassthrough?: boolean;
		hidden?: boolean;
	}): number;
	createTray(options: {
		title?: string;
		image?: string;
		isTemplate?: boolean;
		width?: number;
		height?: number;
		handler?: boolean;
	}): number;
	showTray(trayId: number): boolean;
	getTrayBounds(trayId: number): string | null;
	showNotification(options: { title?: string; body?: string; subtitle?: string; silent?: boolean }): void;
	setMenu(symbol: string, menuJSON: string, handler: boolean): void;
	openFileDialog(options: {
		startingFolder?: string;
		allowedFileTypes?: string;
		canChooseFiles?: boolean;
		canChooseDirectory?: boolean;
		allowsMultipleSelection?: boolean;
	}): string | null;
	showMessageBox(options: {
		boxType?: string;
		title?: string;
		message?: string;
		detail?: string;
		buttons?: string;
		defaultID?: number;
		cancelID?: number;
	}): number;
	setNativeCallback(name: "globalShortcut" | "urlOpen" | "appReopen" | "quitRequested", enabled: boolean): void;
	quit(): void;
};

declare global {
	// Provided by the Cottontail runtime.
	// eslint-disable-next-line no-var
	var cottontail: CottontailHost | undefined;
	// Provided only when running through `cottontail electrobun`.
	// eslint-disable-next-line no-var
	var electrobun: ElectrobunRuntimeHost | undefined;
	// Compatibility shim installed below.
	// eslint-disable-next-line no-var
	var Bun: any;
}

function requireCottontail(): CottontailHost {
	if (!globalThis.cottontail) {
		throw new Error("electrobun/cottontail requires the Cottontail runtime");
	}
	return globalThis.cottontail;
}

function requireElectrobun(): ElectrobunRuntimeHost {
	if (!globalThis.electrobun) {
		throw new Error("electrobun/cottontail requires `cottontail electrobun` mode");
	}
	return globalThis.electrobun;
}

export const host = requireCottontail();
const runtimeNative = requireElectrobun();
installTimerShim();
const rawHostDrainJobs = host.drainJobs?.bind(host);
host.drainJobs = () => {
	rawHostDrainJobs?.();
	drainTimerShim();
	rawHostDrainJobs?.();
};
const rawCoreCall = runtimeNative.coreCall.bind(runtimeNative);
const rawCreateWebview = runtimeNative.createWebview.bind(runtimeNative);
const rawGetWindowFrame = runtimeNative.getWindowFrame.bind(runtimeNative);
const rawResizeView = runtimeNative.resizeView.bind(runtimeNative);
const rawCreateWGPUView = runtimeNative.createWGPUView.bind(runtimeNative);
const rawGetTrayBounds = runtimeNative.getTrayBounds.bind(runtimeNative);
const rawSetMenu = runtimeNative.setMenu.bind(runtimeNative);
const rawPopNextNativeEvent = runtimeNative.popNextNativeEvent.bind(runtimeNative);

function parseJSON<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	return JSON.parse(value) as T;
}

function coreCall(signature: string, symbol: string, ...args: any[]): any {
	return rawCoreCall(signature, symbol, ...args);
}

function ensureRect(rect: Partial<Rect> | undefined, fallback: Rect): Rect {
	return {
		x: rect?.x ?? fallback.x,
		y: rect?.y ?? fallback.y,
		width: rect?.width ?? fallback.width,
		height: rect?.height ?? fallback.height,
	};
}

export const native = Object.assign(runtimeNative, {
	coreCall,
	createWebview(options: Parameters<ElectrobunRuntimeHost["createWebview"]>[0]): number {
		const plaintextSocketPreload = "window.__electrobunPlaintextHostSocket = true;";
		const webviewId = rawCreateWebview({
			...options,
			preload: options.preload
				? `${options.preload}\n${plaintextSocketPreload}`
				: plaintextSocketPreload,
		});
		coreCall("u32_bool", "setWebviewPlaintextHostTransport", webviewId, true);
		return webviewId;
	},

	setWindowTitle(windowId: number, title: string): void {
		coreCall("u32_string", "setWindowTitle", windowId, title);
	},
	minimizeWindow(windowId: number): void {
		coreCall("u32", "minimizeWindow", windowId);
	},
	restoreWindow(windowId: number): void {
		coreCall("u32", "restoreWindow", windowId);
	},
	isWindowMinimized(windowId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "isWindowMinimized", windowId));
	},
	maximizeWindow(windowId: number): void {
		coreCall("u32", "maximizeWindow", windowId);
	},
	unmaximizeWindow(windowId: number): void {
		coreCall("u32", "unmaximizeWindow", windowId);
	},
	isWindowMaximized(windowId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "isWindowMaximized", windowId));
	},
	setWindowFullScreen(windowId: number, fullScreen: boolean): void {
		coreCall("u32_bool", "setWindowFullScreen", windowId, fullScreen);
	},
	isWindowFullScreen(windowId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "isWindowFullScreen", windowId));
	},
	isWindowAlwaysOnTop(windowId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "isWindowAlwaysOnTop", windowId));
	},
	setWindowVisibleOnAllWorkspaces(windowId: number, visible: boolean): void {
		coreCall("u32_bool", "setWindowVisibleOnAllWorkspaces", windowId, visible);
	},
	isWindowVisibleOnAllWorkspaces(windowId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "isWindowVisibleOnAllWorkspaces", windowId));
	},
	showWindow(windowId: number, activate = true): void {
		coreCall("u32_bool", "showWindow", windowId, activate);
	},
	activateWindow(windowId: number): void {
		coreCall("u32", "activateWindow", windowId);
	},
	hideWindow(windowId: number): void {
		coreCall("u32", "hideWindow", windowId);
	},
	setWindowButtonPosition(windowId: number, x: number, y: number): void {
		coreCall("u32_f64_f64", "setWindowButtonPosition", windowId, x, y);
	},
	setWindowPosition(windowId: number, x: number, y: number): void {
		coreCall("u32_f64_f64", "setWindowPosition", windowId, x, y);
	},
	setWindowSize(windowId: number, width: number, height: number): void {
		coreCall("u32_f64_f64", "setWindowSize", windowId, width, height);
	},
	setWindowFrame(windowId: number, frame: Rect): void {
		coreCall("u32_f64_f64_f64_f64", "setWindowFrame", windowId, frame.x, frame.y, frame.width, frame.height);
	},
	getWindowFrame(windowId: number): Rect {
		return parseJSON(rawGetWindowFrame(windowId), { x: 0, y: 0, width: 0, height: 0 });
	},

	resizeWebview(webviewId: number, frame: Rect, masksJSON = "[]"): void {
		rawResizeView("resizeWebview", webviewId, frame.x, frame.y, frame.width, frame.height, masksJSON);
	},
	loadURLInWebview(webviewId: number, url: string): void {
		coreCall("u32_string", "loadURLInWebView", webviewId, url);
	},
	loadHTMLInWebview(webviewId: number, html: string): void {
		coreCall("u32_string", "loadHTMLInWebView", webviewId, html);
	},
	canWebviewGoBack(webviewId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "webviewCanGoBack", webviewId));
	},
	canWebviewGoForward(webviewId: number): boolean {
		return Boolean(coreCall("u32_bool_ret", "webviewCanGoForward", webviewId));
	},
	webviewGoBack(webviewId: number): void {
		coreCall("u32", "webviewGoBack", webviewId);
	},
	webviewGoForward(webviewId: number): void {
		coreCall("u32", "webviewGoForward", webviewId);
	},
	reloadWebview(webviewId: number): void {
		coreCall("u32", "webviewReload", webviewId);
	},
	removeWebview(webviewId: number): void {
		coreCall("u32", "webviewRemove", webviewId);
	},
	setWebviewHTMLContent(webviewId: number, html: string): void {
		coreCall("u32_string", "setWebviewHTMLContent", webviewId, html);
	},
	setWebviewTransparent(webviewId: number, transparent: boolean): void {
		coreCall("u32_bool", "webviewSetTransparent", webviewId, transparent);
	},
	setWebviewPassthrough(webviewId: number, passthrough: boolean): void {
		coreCall("u32_bool", "webviewSetPassthrough", webviewId, passthrough);
	},
	setWebviewHidden(webviewId: number, hidden: boolean): void {
		coreCall("u32_bool", "webviewSetHidden", webviewId, hidden);
	},
	setWebviewNavigationRules(webviewId: number, rulesJSON: string): void {
		coreCall("u32_string", "setWebviewNavigationRules", webviewId, rulesJSON);
	},
	webviewFindInPage(webviewId: number, text: string, forward = true, matchCase = false): void {
		coreCall("u32_string_bool_bool", "webviewFindInPage", webviewId, text, forward, matchCase);
	},
	webviewStopFind(webviewId: number): void {
		coreCall("u32", "webviewStopFind", webviewId);
	},
	openWebviewDevtools(webviewId: number): void {
		coreCall("u32", "webviewOpenDevTools", webviewId);
	},
	closeWebviewDevtools(webviewId: number): void {
		coreCall("u32", "webviewCloseDevTools", webviewId);
	},
	toggleWebviewDevtools(webviewId: number): void {
		coreCall("u32", "webviewToggleDevTools", webviewId);
	},
	setWebviewPageZoom(webviewId: number, zoom: number): void {
		coreCall("u32_f64", "webviewSetPageZoom", webviewId, zoom);
	},
	getWebviewPageZoom(webviewId: number): number {
		return Number(coreCall("u32_f64_ret", "webviewGetPageZoom", webviewId));
	},
	evaluateJavaScriptWithNoCompletion(webviewId: number, script: string): void {
		coreCall("u32_string", "evaluateJavaScriptWithNoCompletion", webviewId, script);
	},
	sendInternalMessageToWebview(webviewId: number, messageJSON: string): boolean {
		return Boolean(coreCall("u32_string_bool_ret", "sendInternalMessageToWebview", webviewId, messageJSON));
	},

	createWGPUViewForWindow(windowId: number, frame: Partial<Rect> = {}): number {
		const rect = ensureRect(frame, { x: 0, y: 0, width: 320, height: 240 });
		return rawCreateWGPUView({ windowId, ...rect });
	},
	setWGPUViewFrame(viewId: number, frame: Rect): void {
		coreCall("u32_f64_f64_f64_f64", "setWGPUViewFrame", viewId, frame.x, frame.y, frame.width, frame.height);
	},
	resizeWGPUView(viewId: number, frame: Rect, masksJSON = "[]"): void {
		rawResizeView("resizeWGPUView", viewId, frame.x, frame.y, frame.width, frame.height, masksJSON);
	},
	setWGPUViewTransparent(viewId: number, transparent: boolean): void {
		coreCall("u32_bool", "setWGPUViewTransparent", viewId, transparent);
	},
	setWGPUViewPassthrough(viewId: number, passthrough: boolean): void {
		coreCall("u32_bool", "setWGPUViewPassthrough", viewId, passthrough);
	},
	setWGPUViewHidden(viewId: number, hidden: boolean): void {
		coreCall("u32_bool", "setWGPUViewHidden", viewId, hidden);
	},
	removeWGPUView(viewId: number): void {
		coreCall("u32", "removeWGPUView", viewId);
	},
	getWGPUViewPointerExists(viewId: number): boolean {
		return Boolean(coreCall("u32_ptr_exists", "getWGPUViewPointer", viewId));
	},
	getWGPUViewNativeHandleExists(viewId: number): boolean {
		return Boolean(coreCall("u32_ptr_exists", "getWGPUViewNativeHandle", viewId));
	},
	runWGPUViewTest(viewId: number): void {
		coreCall("u32", "runWGPUViewTest", viewId);
	},
	toggleWGPUViewTestShader(viewId: number): void {
		coreCall("u32", "toggleWGPUViewTestShader", viewId);
	},

	hideTray(trayId: number): void {
		coreCall("u32", "hideTray", trayId);
	},
	setTrayTitle(trayId: number, title: string): void {
		coreCall("u32_string", "setTrayTitle", trayId, title);
	},
	setTrayMenuJSON(trayId: number, menuJSON: string): void {
		coreCall("u32_string", "setTrayMenu", trayId, menuJSON);
	},
	removeTray(trayId: number): void {
		coreCall("u32", "removeTray", trayId);
	},
	getTrayBounds(trayId: number): Rect {
		return parseJSON(rawGetTrayBounds(trayId), { x: 0, y: 0, width: 0, height: 0 });
	},

	setDockIconVisible(visible: boolean): void {
		coreCall("bool", "setDockIconVisible", visible);
	},
	isDockIconVisible(): boolean {
		return Boolean(coreCall("bool_ret", "isDockIconVisible"));
	},
	getPrimaryDisplay(): Display {
		return parseJSON(coreCall("string_ret", "getPrimaryDisplay"), {
			id: 0,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			workArea: { x: 0, y: 0, width: 0, height: 0 },
			scaleFactor: 1,
			isPrimary: true,
		});
	},
	getAllDisplays(): Display[] {
		return parseJSON(coreCall("string_ret", "getAllDisplays"), []);
	},
	getCursorScreenPoint(): Point {
		return parseJSON(coreCall("string_ret", "getCursorScreenPoint"), { x: 0, y: 0 });
	},
	getMouseButtons(): bigint {
		try {
			return BigInt(runtimeNative.nativeCall("core", "getMouseButtons", "u64"));
		} catch {
			return 0n;
		}
	},

	moveToTrash(path: string): boolean {
		return Boolean(coreCall("string_bool_ret", "moveToTrash", path));
	},
	showItemInFolder(path: string): void {
		coreCall("string", "showItemInFolder", path);
	},
	openExternal(url: string): boolean {
		return Boolean(coreCall("string_bool_ret", "openExternal", url));
	},
	openPath(path: string): boolean {
		return Boolean(coreCall("string_bool_ret", "openPath", path));
	},
	clipboardReadText(): string {
		return String(coreCall("string_ret", "clipboardReadText") ?? "");
	},
	clipboardWriteText(text: string): void {
		coreCall("string", "clipboardWriteText", text);
	},
	clipboardClear(): void {
		coreCall("void", "clipboardClear");
	},
	clipboardAvailableFormats(): string {
		return String(coreCall("string_ret", "clipboardAvailableFormats") ?? "");
	},
	setApplicationMenuJSON(menuJSON: string, handler = false): void {
		rawSetMenu("setApplicationMenu", menuJSON, handler);
	},
	showContextMenuJSON(menuJSON: string, handler = false): void {
		rawSetMenu("showContextMenu", menuJSON, handler);
	},
	registerGlobalShortcut(accelerator: string): boolean {
		return Boolean(coreCall("string_bool_ret", "registerGlobalShortcut", accelerator));
	},
	unregisterGlobalShortcut(accelerator: string): boolean {
		return Boolean(coreCall("string_bool_ret", "unregisterGlobalShortcut", accelerator));
	},
	unregisterAllGlobalShortcuts(): void {
		coreCall("void", "unregisterAllGlobalShortcuts");
	},
	isGlobalShortcutRegistered(accelerator: string): boolean {
		return Boolean(coreCall("string_bool_ret", "isGlobalShortcutRegistered", accelerator));
	},
	sessionGetCookies(partition: string, filterJSON = "{}"): string {
		return String(coreCall("string_string_ret", "sessionGetCookies", partition, filterJSON) ?? "[]");
	},
	sessionSetCookie(partition: string, cookieJSON: string): boolean {
		return Boolean(coreCall("string_string_bool_ret", "sessionSetCookie", partition, cookieJSON));
	},
	sessionRemoveCookie(partition: string, url: string, name: string): boolean {
		return Boolean(coreCall("string_string_string_bool_ret", "sessionRemoveCookie", partition, url, name));
	},
	sessionClearCookies(partition: string): void {
		coreCall("string", "sessionClearCookies", partition);
	},
	sessionClearStorageData(partition: string, storageTypesJSON: string): void {
		coreCall("string_string", "sessionClearStorageData", partition, storageTypesJSON);
	},
	waitForShutdownComplete(timeoutMS: number): void {
		coreCall("int", "waitForShutdownComplete", timeoutMS);
	},
	forceExit(code: number): void {
		coreCall("int", "forceExit", code);
	},
	popNativeEvent(): NativeEvent | null {
		return parseJSON(rawPopNextNativeEvent(), null);
	},
});

export type Native = typeof native;

export function env(name: string): string | undefined {
	const value = host.env(name);
	return typeof value === "string" ? value : undefined;
}

export function sleep(ms: number): void {
	if (ms <= 0) return;
	const deadline = nowNanoseconds() + ms * 1_000_000;
	try {
		while (nowNanoseconds() < deadline) {
			const remainingMs = Math.max(
				1,
				Math.ceil((deadline - nowNanoseconds()) / 1_000_000),
			);
			coreCall("int", "runNativeEventLoopTick", Math.min(remainingMs, 10));
			host.drainJobs?.();
		}
		return;
	} catch {}
	if (host.sleep) {
		host.sleep(ms);
		return;
	}
	while (nowNanoseconds() < deadline) {}
}

function nowNanoseconds(): number {
	const value = host.nanotime?.();
	if (typeof value === "bigint") return Number(value);
	return value ?? Date.now() * 1_000_000;
}

export function nowMs(): number {
	return Math.floor(nowNanoseconds() / 1_000_000);
}

export function pathJoin(...parts: string[]): string {
	let result = "";
	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("/")) {
			result = part;
			continue;
		}
		if (!result || result.endsWith("/")) {
			result += part;
		} else {
			result += `/${part}`;
		}
	}
	return normalizePath(result || ".");
}

export function dirname(path: string): string {
	const normalized = normalizePath(path);
	const index = normalized.lastIndexOf("/");
	if (index <= 0) return index === 0 ? "/" : ".";
	return normalized.slice(0, index);
}

export function normalizePath(path: string): string {
	const absolute = path.startsWith("/");
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0) parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}

export function basename(path: string): string {
	const normalized = normalizePath(path);
	const index = normalized.lastIndexOf("/");
	return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function jsonStringLiteral(value: string): string {
	return JSON.stringify(value);
}

export function sendRPCMessage(webviewId: number, id: string, payload: unknown): void {
	native.sendHostMessageToWebview(
		webviewId,
		JSON.stringify({ type: "message", id, payload }),
	);
}

export function sendRPCResponse(
	webviewId: number,
	id: number,
	payload: unknown,
): void {
	native.sendHostMessageToWebview(
		webviewId,
		JSON.stringify({ type: "response", id, success: true, payload }),
	);
}

export function sendRPCError(
	webviewId: number,
	id: number,
	error: string,
): void {
	native.sendHostMessageToWebview(
		webviewId,
		JSON.stringify({ type: "response", id, success: false, error }),
	);
}

export type Paths = {
	home: string;
	appData: string;
	config: string;
	cache: string;
	temp: string;
	logs: string;
	documents: string;
	downloads: string;
	desktop: string;
	pictures: string;
	music: string;
	videos: string;
	userData: string;
	userCache: string;
	userLogs: string;
};

function envString(name: string): string {
	return env(name) ?? "";
}

export function resolvePaths(appIdentifier = "dev.electrobun.cottontail"): Paths {
	const home = envString("HOME") || host.cwd();
	const temp = normalizePath(envString("TMPDIR") || "/tmp");
	const appData = pathJoin(home, "Library", "Application Support");
	const cache = pathJoin(home, "Library", "Caches");
	const logs = pathJoin(home, "Library", "Logs");
	return {
		home,
		appData,
		config: appData,
		cache,
		temp: temp.endsWith("/") && temp.length > 1 ? temp.slice(0, -1) : temp,
		logs,
		documents: pathJoin(home, "Documents"),
		downloads: pathJoin(home, "Downloads"),
		desktop: pathJoin(home, "Desktop"),
		pictures: pathJoin(home, "Pictures"),
		music: pathJoin(home, "Music"),
		videos: pathJoin(home, "Movies"),
		userData: pathJoin(appData, appIdentifier),
		userCache: pathJoin(cache, appIdentifier),
		userLogs: pathJoin(logs, appIdentifier),
	};
}

type LocalUpdateInfo = {
	version: string;
	hash: string;
	baseUrl: string;
	channel: string;
	name: string;
	identifier: string;
};

type UpdateStatusEntry = {
	status: string;
	message: string;
	timestamp: number;
	details?: Record<string, unknown>;
};

let cachedLocalInfo: LocalUpdateInfo | null = null;
const updateStatusHistory: UpdateStatusEntry[] = [];
let updateStatusCallback: ((entry: UpdateStatusEntry) => void) | null = null;

function readJSONFile<T>(filePath: string): T | null {
	try {
		if (!host.existsSync(filePath)) return null;
		return JSON.parse(host.readFile(filePath)) as T;
	} catch {
		return null;
	}
}

function loadLocalUpdateInfo(): LocalUpdateInfo {
	if (cachedLocalInfo) return cachedLocalInfo;

	const versionCandidates = [
		pathJoin(host.cwd(), "..", "Resources", "version.json"),
		pathJoin(host.cwd(), "Resources", "version.json"),
		pathJoin(host.cwd(), "version.json"),
	];
	const versionFile = versionCandidates.map((candidate) => readJSONFile<Partial<LocalUpdateInfo>>(candidate)).find(Boolean) ?? {};
	const identifier = env("COTTONTAIL_ELECTROBUN_IDENTIFIER") || env("ELECTROBUN_APP_IDENTIFIER") || versionFile.identifier || "dev.electrobun.cottontail";
	const channel = env("COTTONTAIL_ELECTROBUN_CHANNEL") || env("ELECTROBUN_BUILD_ENV") || versionFile.channel || "dev";

	cachedLocalInfo = {
		version: env("ELECTROBUN_APP_VERSION") || versionFile.version || "0.0.0-dev",
		hash: versionFile.hash || "dev",
		baseUrl: versionFile.baseUrl || "",
		channel,
		name: env("COTTONTAIL_ELECTROBUN_NAME") || env("ELECTROBUN_APP_NAME") || versionFile.name || "Cottontail",
		identifier,
	};
	return cachedLocalInfo;
}

function emitUpdateStatus(status: string, message: string, details?: Record<string, unknown>): void {
	const entry = { status, message, timestamp: Date.now(), ...(details ? { details } : {}) };
	updateStatusHistory.push(entry);
	updateStatusCallback?.(entry);
}

export const Updater = {
	updateInfo() {
		const localInfo = loadLocalUpdateInfo();
		return {
			version: localInfo.version,
			hash: localInfo.hash,
			updateAvailable: false,
			updateReady: false,
			error: "",
		};
	},
	getStatusHistory() {
		return [...updateStatusHistory];
	},
	clearStatusHistory() {
		updateStatusHistory.length = 0;
	},
	onStatusChange(callback: ((entry: UpdateStatusEntry) => void) | null) {
		updateStatusCallback = callback;
	},
	async checkForUpdate() {
		const localInfo = loadLocalUpdateInfo();
		emitUpdateStatus("checking", "Checking for updates...");
		emitUpdateStatus("no-update", "Cottontail dev updater does not apply remote updates", { currentHash: localInfo.hash });
		return {
			version: localInfo.version,
			hash: localInfo.hash,
			updateAvailable: false,
			updateReady: false,
			error: localInfo.channel === "dev" ? "" : "Cottontail update downloads are not implemented yet",
		};
	},
	async channelBucketUrl() {
		return loadLocalUpdateInfo().baseUrl;
	},
	async appDataFolder() {
		const localInfo = loadLocalUpdateInfo();
		return pathJoin(resolvePaths(localInfo.identifier).appData, localInfo.identifier, localInfo.channel);
	},
	localInfo: {
		async version() {
			return loadLocalUpdateInfo().version;
		},
		async hash() {
			return loadLocalUpdateInfo().hash;
		},
		async channel() {
			return loadLocalUpdateInfo().channel;
		},
		async baseUrl() {
			return loadLocalUpdateInfo().baseUrl;
		},
	},
	async getLocalInfo() {
		return loadLocalUpdateInfo();
	},
	async getLocallocalInfo() {
		return loadLocalUpdateInfo();
	},
};

class BunFile {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	textSync(): string {
		return host.readFile(this.path);
	}

	async text(): Promise<string> {
		return this.textSync();
	}

	jsonSync(): any {
		return JSON.parse(this.textSync());
	}

	async json(): Promise<any> {
		return this.jsonSync();
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const text = this.textSync();
		const bytes = new Uint8Array(text.length);
		for (let index = 0; index < text.length; index += 1) {
			bytes[index] = text.charCodeAt(index) & 0xff;
		}
		return bytes.buffer;
	}

	exists(): boolean {
		return host.existsSync(this.path);
	}

	get size(): number {
		return this.textSync().length;
	}
}

export const Bun = (globalThis.Bun ??= {});
Bun.File ??= BunFile;
Bun.file ??= (path: string) => new BunFile(path);

export {
	babylon,
	CString,
	GpuWindow,
	JSCallback,
	ptr,
	three,
	toArrayBuffer,
	webgpu,
	WGPU,
	WGPUBridge,
	WGPUView,
	type Pointer,
};

export {
	createCanvasShim,
	decodePngRGBA,
	GPUAdapter,
	GPUBindGroup,
	GPUBindGroupLayout,
	GPUBuffer,
	GPUCanvasContext,
	GPUCommandBuffer,
	GPUCommandEncoder,
	GPUComputePipeline,
	GPUDevice,
	GPUPipelineLayout,
	GPUQueue,
	GPURenderPassEncoder,
	GPURenderPipeline,
	GPUSampler,
	GPUShaderModule,
	GPUTexture,
	GPUTextureView,
} from "./webgpuAdapter";
