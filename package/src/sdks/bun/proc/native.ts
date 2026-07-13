import { dirname, join } from "path";
import { createReadStream } from "node:fs";
import electrobunEventEmitter from "../events/eventEmitter";
import ElectrobunEvent from "../events/event";
import { BrowserView } from "../core/BrowserView";
import { WGPUView } from "../core/WGPUView";
import {
	preloadScript,
	preloadScriptSandboxed,
} from "../../../preload/.generated/compiled";

// Menu data reference system to avoid serialization overhead
const menuDataRegistry = new Map<string, any>();
let menuDataCounter = 0;
function storeMenuData(data: any): string {
	const id = `menuData_${++menuDataCounter}`;
	menuDataRegistry.set(id, data);
	return id;
}

function getMenuData(id: string): any {
	return menuDataRegistry.get(id);
}

function clearMenuData(id: string): void {
	menuDataRegistry.delete(id);
}

// Shared methods for EB delimiter serialization/deserialization
const ELECTROBUN_DELIMITER = "|EB|";

function serializeMenuAction(action: string, data: any): string {
	const dataId = storeMenuData(data);
	return `${ELECTROBUN_DELIMITER}${dataId}|${action}`;
}

function deserializeMenuAction(encodedAction: string): {
	action: string;
	data: any;
} {
	let actualAction = encodedAction;
	let data = undefined;

	if (encodedAction.startsWith(ELECTROBUN_DELIMITER)) {
		const parts = encodedAction.split("|");
		if (parts.length >= 4) {
			// ['', 'EB', 'dataId', 'actualAction', ...]
			const dataId = parts[2]!;
			actualAction = parts.slice(3).join("|"); // Rejoin in case action contains |
			data = getMenuData(dataId);

			// Clean up data from registry after use
			clearMenuData(dataId);
		}
	}

	return { action: actualAction, data };
}

// todo: set up FFI, this is already in the webworker.

import {
	dlopen,
	suffix,
	JSCallback,
	CString,
	ptr,
	FFIType,
	toArrayBuffer,
	type Pointer,
} from "bun:ffi";

function getElectrobunLibraryPathCandidates(fileName: string) {
	const candidates = new Set<string>();
	candidates.add(join(process.cwd(), fileName));
	if (process.argv0) {
		candidates.add(join(dirname(process.argv0), fileName));
	}
	return Array.from(candidates);
}

function tryDlopenCandidates<T extends Record<string, { args: FFIType[]; returns: FFIType }>>(
	fileName: string,
	symbols: T,
) {
	let lastError: unknown = null;
	for (const candidatePath of getElectrobunLibraryPathCandidates(fileName)) {
		try {
			return dlopen(candidatePath, symbols);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error(`Failed to load ${fileName}`);
}

function getWindowPtr(winId: number) {
	return core?.symbols.getWindowPointer(winId) || null;
}

function getCoreLastError(): string | null {
	const error = core?.symbols.electrobun_core_last_error();
	if (!error) {
		return null;
	}

	const message = error.toString();
	return message.length > 0 ? message : null;
}

let webviewRuntimeConfigured = false;

function ensureWebviewRuntimeConfigured() {
	if (webviewRuntimeConfigured) {
		return;
	}

	const configured = core?.symbols.configureWebviewRuntime(
		0,
		toCString(preloadScript),
		toCString(preloadScriptSandboxed),
	);

	if (!configured) {
		throw getCoreLastError() || "Failed to configure webview runtime";
	}

	webviewRuntimeConfigured = true;
}

const core = (() => {
	try {
		const coreFileName =
			process.platform === "win32"
				? "ElectrobunCore.dll"
				: `libElectrobunCore.${suffix}`;
		return tryDlopenCandidates(coreFileName, {
			electrobun_core_last_error: {
				args: [],
				returns: FFIType.cstring,
			},
			getWindowStyle: {
				args: [
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
				],
				returns: FFIType.u32,
			},
			createWindow: {
				args: [
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.u32,
					FFIType.cstring,
					FFIType.bool,
					FFIType.cstring,
					FFIType.bool,
					FFIType.bool,
					FFIType.f64,
					FFIType.f64,
					FFIType.function,
					FFIType.function,
					FFIType.function,
					FFIType.function,
					FFIType.function,
					FFIType.function,
				],
				returns: FFIType.u32,
			},
			getWindowPointer: {
				args: [FFIType.u32],
				returns: FFIType.ptr,
			},
			setWindowTitle: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			minimizeWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			restoreWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			isWindowMinimized: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			maximizeWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			unmaximizeWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			isWindowMaximized: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			showWindow: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			activateWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			hideWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			closeWindow: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			setWindowFullScreen: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			isWindowFullScreen: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			setWindowAlwaysOnTop: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			isWindowAlwaysOnTop: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			setWindowVisibleOnAllWorkspaces: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			isWindowVisibleOnAllWorkspaces: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			setWindowPosition: {
				args: [FFIType.u32, FFIType.f64, FFIType.f64],
				returns: FFIType.void,
			},
			setWindowButtonPosition: {
				args: [FFIType.u32, FFIType.f64, FFIType.f64],
				returns: FFIType.void,
			},
			setWindowSize: {
				args: [FFIType.u32, FFIType.f64, FFIType.f64],
				returns: FFIType.void,
			},
			setWindowFrame: {
				args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64],
				returns: FFIType.void,
			},
			getWindowFrame: {
				args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.void,
			},
			configureWebviewRuntime: {
				args: [
					FFIType.u32,
					FFIType.cstring,
					FFIType.cstring,
				],
				returns: FFIType.bool,
			},
			createWebview: {
				args: [
					FFIType.u32,
					FFIType.u32,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.bool,
					FFIType.cstring,
					FFIType.function,
					FFIType.function,
					FFIType.function,
					FFIType.function,
					FFIType.function,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
				],
				returns: FFIType.u32,
			},
			getWebviewPointer: {
				args: [FFIType.u32],
				returns: FFIType.ptr,
			},
			resizeWebview: {
				args: [
					FFIType.u32,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.cstring,
				],
				returns: FFIType.void,
			},
			loadURLInWebView: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			loadHTMLInWebView: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			updatePreloadScriptToWebView: {
				args: [FFIType.u32, FFIType.cstring, FFIType.cstring, FFIType.bool],
				returns: FFIType.void,
			},
			webviewCanGoBack: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			webviewCanGoForward: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			webviewGoBack: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			webviewGoForward: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			webviewReload: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			webviewRemove: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			setWebviewHTMLContent: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			webviewSetTransparent: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			webviewSetPassthrough: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			webviewSetHidden: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			setWebviewNavigationRules: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			webviewFindInPage: {
				args: [FFIType.u32, FFIType.cstring, FFIType.bool, FFIType.bool],
				returns: FFIType.void,
			},
			webviewStopFind: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			evaluateJavaScriptWithNoCompletion: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			sendHostMessageToWebviewViaTransport: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.bool,
			},
			popNextQueuedHostMessage: {
				args: [FFIType.ptr],
				returns: FFIType.ptr,
			},
			getHostMessageWakeupReadFD: {
				args: [],
				returns: FFIType.int,
			},
			freeCoreString: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			clearWebviewHostTransport: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			dispatchHostWebviewEvent: {
				args: [FFIType.u32, FFIType.cstring, FFIType.cstring],
				returns: FFIType.bool,
			},
			sendInternalMessageToWebview: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.bool,
			},
			webviewOpenDevTools: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			webviewCloseDevTools: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			webviewToggleDevTools: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			webviewSetPageZoom: {
				args: [FFIType.u32, FFIType.f64],
				returns: FFIType.void,
			},
			webviewGetPageZoom: {
				args: [FFIType.u32],
				returns: FFIType.f64,
			},
			createWGPUView: {
				args: [
					FFIType.u32,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.bool,
					FFIType.bool,
					FFIType.bool,
				],
				returns: FFIType.u32,
			},
			getWGPUViewPointer: {
				args: [FFIType.u32],
				returns: FFIType.ptr,
			},
			setWGPUViewFrame: {
				args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64],
				returns: FFIType.void,
			},
			resizeWGPUView: {
				args: [FFIType.u32, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.f64, FFIType.cstring],
				returns: FFIType.void,
			},
			setWGPUViewTransparent: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			setWGPUViewPassthrough: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			setWGPUViewHidden: {
				args: [FFIType.u32, FFIType.bool],
				returns: FFIType.void,
			},
			removeWGPUView: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			getWGPUViewNativeHandle: {
				args: [FFIType.u32],
				returns: FFIType.ptr,
			},
			runWGPUViewTest: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			createTray: {
				args: [
					FFIType.cstring,
					FFIType.cstring,
					FFIType.bool,
					FFIType.u32,
					FFIType.u32,
					FFIType.function,
				],
				returns: FFIType.u32,
			},
			showTray: {
				args: [FFIType.u32],
				returns: FFIType.bool,
			},
			hideTray: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			setTrayTitle: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			setTrayLength: {
				args: [FFIType.u32, FFIType.f64],
				returns: FFIType.void,
			},
			setTrayImage: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			setTrayMenu: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			removeTray: {
				args: [FFIType.u32],
				returns: FFIType.void,
			},
			getTrayBounds: {
				args: [FFIType.u32],
				returns: FFIType.cstring,
			},
			setApplicationMenu: {
				args: [FFIType.cstring, FFIType.function],
				returns: FFIType.void,
			},
			showContextMenu: {
				args: [FFIType.cstring, FFIType.function],
				returns: FFIType.void,
			},
			moveToTrash: {
				args: [FFIType.cstring],
				returns: FFIType.bool,
			},
			showItemInFolder: {
				args: [FFIType.cstring],
				returns: FFIType.void,
			},
			openExternal: {
				args: [FFIType.cstring],
				returns: FFIType.bool,
			},
			openPath: {
				args: [FFIType.cstring],
				returns: FFIType.bool,
			},
			showNotification: {
				args: [
					FFIType.cstring,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.bool,
				],
				returns: FFIType.void,
			},
			getAllDisplays: {
				args: [],
				returns: FFIType.cstring,
			},
			getPrimaryDisplay: {
				args: [],
				returns: FFIType.cstring,
			},
			getCursorScreenPoint: {
				args: [],
				returns: FFIType.cstring,
			},
			getMouseButtons: {
				args: [],
				returns: FFIType.u64,
			},
			openFileDialog: {
				args: [
					FFIType.cstring,
					FFIType.cstring,
					FFIType.int,
					FFIType.int,
					FFIType.int,
				],
				returns: FFIType.cstring,
			},
			showMessageBox: {
				args: [
					FFIType.cstring,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.cstring,
					FFIType.int,
					FFIType.int,
				],
				returns: FFIType.int,
			},
			clipboardReadText: {
				args: [],
				returns: FFIType.cstring,
			},
			clipboardWriteText: {
				args: [FFIType.cstring],
				returns: FFIType.void,
			},
			clipboardReadImage: {
				args: [FFIType.ptr],
				returns: FFIType.ptr,
			},
			clipboardWriteImage: {
				args: [FFIType.ptr, FFIType.u64],
				returns: FFIType.void,
			},
			clipboardClear: {
				args: [],
				returns: FFIType.void,
			},
			clipboardAvailableFormats: {
				args: [],
				returns: FFIType.cstring,
			},
			setDockIconVisible: {
				args: [FFIType.bool],
				returns: FFIType.void,
			},
			isDockIconVisible: {
				args: [],
				returns: FFIType.bool,
			},
			setExitOnLastWindowClosed: {
				args: [FFIType.bool],
				returns: FFIType.void,
			},
			setQuitRequestedHandler: {
				args: [FFIType.function],
				returns: FFIType.void,
			},
			quitGracefully: {
				args: [FFIType.i32, FFIType.i32],
				returns: FFIType.void,
			},
		});
	} catch {
		return null;
	}
})();

export const native = (() => {
	try {
		const nativeWrapperFileName = `libNativeWrapper.${suffix}`;
		return tryDlopenCandidates(nativeWrapperFileName, {
			// webview
			initWebview: {
				args: [
					FFIType.u32, // webviewId
					FFIType.ptr, // windowPtr
					FFIType.cstring, // renderer
					FFIType.cstring, // url
					FFIType.f64,
					FFIType.f64, // x, y
					FFIType.f64,
					FFIType.f64, // width, height
					FFIType.bool, // autoResize
					FFIType.cstring, // partition
					FFIType.function, // decideNavigation: *const fn (u32, [*:0]const u8) callconv(.C) bool,
					FFIType.function, // webviewEventHandler: *const fn (u32, [*:0]const u8, [*:0]const u8) callconv(.C) void,
					FFIType.function, // eventBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void (events only, always active)
					FFIType.function, // hostBridgePostmessageHandler: *const fn (u32, [*:0]const u8) callconv(.C) void (user RPC, disabled in sandbox)
					FFIType.function, // internalBridgeHandler: *const fn (u32, [*:0]const u8) callconv(.C) void (internal RPC, disabled in sandbox)
					FFIType.cstring, // electrobunPreloadScript
					FFIType.cstring, // customPreloadScript
					FFIType.cstring, // viewsRoot
					FFIType.bool, // transparent
					FFIType.bool, // sandbox - when true, hostBridge and internalBridge are not set up
				],
				returns: FFIType.ptr,
			},
			initWGPUView: {
				args: [
					FFIType.u32, // viewId
					FFIType.ptr, // windowPtr
					FFIType.f64,
					FFIType.f64, // x, y
					FFIType.f64,
					FFIType.f64, // width, height
					FFIType.bool, // autoResize
					FFIType.bool, // startTransparent
					FFIType.bool, // startPassthrough
				],
				returns: FFIType.ptr,
			},
			// Pre-set flags for the next initWebview call (workaround for FFI param count limits)
			setNextWebviewFlags: {
				args: [
					FFIType.bool, // startTransparent
					FFIType.bool, // startPassthrough
				],
				returns: FFIType.void,
			},

			// webviewtag
			webviewCanGoBack: {
				args: [FFIType.ptr],
				returns: FFIType.bool,
			},

			webviewCanGoForward: {
				args: [FFIType.ptr],
				returns: FFIType.bool,
			},
			// Note: callAsyncJavaScript not implemented - CEF doesn't support this directly.
			// Users can use RPC for JavaScript execution.
			resizeWebview: {
				args: [
					FFIType.ptr, // webview handle
					FFIType.f64, // x
					FFIType.f64, // y
					FFIType.f64, // width
					FFIType.f64, // height
					FFIType.cstring, // maskJson
				],
				returns: FFIType.void,
			},

			loadURLInWebView: {
				args: [FFIType.ptr, FFIType.cstring],
				returns: FFIType.void,
			},
			loadHTMLInWebView: {
				args: [FFIType.ptr, FFIType.cstring],
				returns: FFIType.void,
			},

			updatePreloadScriptToWebView: {
				args: [
					FFIType.ptr, // webview handle
					FFIType.cstring, // script identifier
					FFIType.cstring, // script
					FFIType.bool, // allframes
				],
				returns: FFIType.void,
			},
			webviewGoBack: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			webviewGoForward: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			webviewReload: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			webviewRemove: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			setWebviewHTMLContent: {
				args: [FFIType.u32, FFIType.cstring],
				returns: FFIType.void,
			},
			startWindowMove: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			stopWindowMove: {
				args: [],
				returns: FFIType.void,
			},
			webviewSetTransparent: {
				args: [FFIType.ptr, FFIType.bool],
				returns: FFIType.void,
			},
			webviewSetPassthrough: {
				args: [FFIType.ptr, FFIType.bool],
				returns: FFIType.void,
			},
			webviewSetHidden: {
				args: [FFIType.ptr, FFIType.bool],
				returns: FFIType.void,
			},
			setWebviewNavigationRules: {
				args: [FFIType.ptr, FFIType.cstring],
				returns: FFIType.void,
			},
			webviewFindInPage: {
				args: [FFIType.ptr, FFIType.cstring, FFIType.bool, FFIType.bool],
				returns: FFIType.void,
			},
			webviewStopFind: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			evaluateJavaScriptWithNoCompletion: {
				args: [FFIType.ptr, FFIType.cstring],
				returns: FFIType.void,
			},
			webviewOpenDevTools: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			webviewCloseDevTools: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			webviewToggleDevTools: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			webviewSetPageZoom: {
				args: [FFIType.ptr, FFIType.f64],
				returns: FFIType.void,
			},
			webviewGetPageZoom: {
				args: [FFIType.ptr],
				returns: FFIType.f64,
			},
			wgpuViewSetFrame: {
				args: [
					FFIType.ptr,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
					FFIType.f64,
				],
				returns: FFIType.void,
			},
			wgpuViewSetTransparent: {
				args: [FFIType.ptr, FFIType.bool],
				returns: FFIType.void,
			},
			wgpuViewSetPassthrough: {
				args: [FFIType.ptr, FFIType.bool],
				returns: FFIType.void,
			},
			wgpuViewSetHidden: {
				args: [FFIType.ptr, FFIType.bool],
				returns: FFIType.void,
			},
			wgpuViewRemove: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			wgpuViewGetNativeHandle: {
				args: [FFIType.ptr],
				returns: FFIType.ptr,
			},
			wgpuInstanceCreateSurfaceMainThread: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.ptr,
			},
			wgpuSurfaceConfigureMainThread: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.void,
			},
			wgpuSurfaceGetCurrentTextureMainThread: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.void,
			},
			wgpuSurfacePresentMainThread: {
				args: [FFIType.ptr],
				returns: FFIType.i32,
			},
			wgpuQueueOnSubmittedWorkDoneShim: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.u64,
			},
			wgpuBufferMapAsyncShim: {
				args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr],
				returns: FFIType.u64,
			},
			wgpuInstanceWaitAnyShim: {
				args: [FFIType.ptr, FFIType.u64, FFIType.u64],
				returns: FFIType.i32,
			},
			wgpuBufferReadSyncShim: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr],
				returns: FFIType.ptr,
			},
			wgpuBufferReadSyncIntoShim: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr],
				returns: FFIType.i32,
			},
			wgpuBufferReadbackBeginShim: {
				args: [FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.ptr],
				returns: FFIType.ptr,
			},
			wgpuBufferReadbackStatusShim: {
				args: [FFIType.ptr],
				returns: FFIType.i32,
			},
			wgpuBufferReadbackFreeShim: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			wgpuRunGPUTest: {
				args: [FFIType.ptr],
				returns: FFIType.void,
			},
			wgpuCreateAdapterDeviceMainThread: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.void,
			},
			wgpuCreateSurfaceForView: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.ptr,
			},
			// Global keyboard shortcuts
			setGlobalShortcutCallback: {
				args: [FFIType.function],
				returns: FFIType.void,
			},
			registerGlobalShortcut: {
				args: [FFIType.cstring],
				returns: FFIType.bool,
			},
			unregisterGlobalShortcut: {
				args: [FFIType.cstring],
				returns: FFIType.bool,
			},
			unregisterAllGlobalShortcuts: {
				args: [],
				returns: FFIType.void,
			},
			isGlobalShortcutRegistered: {
				args: [FFIType.cstring],
				returns: FFIType.bool,
			},

			// Session/Cookie API
			sessionGetCookies: {
				args: [FFIType.cstring, FFIType.cstring],
				returns: FFIType.cstring,
			},
			sessionSetCookie: {
				args: [FFIType.cstring, FFIType.cstring],
				returns: FFIType.bool,
			},
			sessionRemoveCookie: {
				args: [FFIType.cstring, FFIType.cstring, FFIType.cstring],
				returns: FFIType.bool,
			},
			sessionClearCookies: {
				args: [FFIType.cstring],
				returns: FFIType.void,
			},
			sessionClearStorageData: {
				args: [FFIType.cstring, FFIType.cstring],
				returns: FFIType.void,
			},

			// URL scheme handler (macOS only)
			setURLOpenHandler: {
				args: [FFIType.function], // handler callback
				returns: FFIType.void,
			},
			setAppReopenHandler: {
				args: [FFIType.function],
				returns: FFIType.void,
			},

			// JSCallback utils for native code to use
			setJSUtils: {
				args: [
					FFIType.function, // get Mimetype from url/filename
					FFIType.function, // get html property from webview
				],
				returns: FFIType.void,
			},
			setWindowIcon: {
				args: [
					FFIType.ptr, // window pointer
					FFIType.cstring, // icon path
				],
				returns: FFIType.void,
			},
			killApp: {
				args: [],
				returns: FFIType.void,
			},
			stopEventLoop: {
				args: [],
				returns: FFIType.void,
			},
			waitForShutdownComplete: {
				args: [FFIType.i32],
				returns: FFIType.void,
			},
			forceExit: {
				args: [FFIType.i32],
				returns: FFIType.void,
			},
			setQuitRequestedHandler: {
				args: [FFIType.function],
				returns: FFIType.void,
			},
			testFFI2: {
				args: [FFIType.function],
				returns: FFIType.void,
			},
			// FFIFn: {
			//   args: [],
			//   returns: FFIType.void
			// },
		});
	} catch (err) {
		// FFI not available — running as a carrot inside Bunny Ears or in a build-only context.
		return null;
	}
})();

export const hasFFI = native !== null && core !== null;

// PostMessage bridge for carrot workers (inter-carrot communication, host events).
// Created when __bunnyCarrotBootstrap exists, regardless of FFI availability.
class PostMessageBridge {
	private requestId = 0;
	private pendingRequests = new Map<number, {
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}>();
	private eventHandlers = new Map<string, Set<(payload: unknown) => void>>();

	constructor() {
		if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
			self.addEventListener("message", (event: MessageEvent) => {
				this.handleMessage(event.data);
			});
		}
	}

	sendAction(action: string, payload?: unknown) {
		self.postMessage({ type: "action", action, payload });
	}

	requestHost<T = unknown>(method: string, params?: unknown): Promise<T> {
		const id = ++this.requestId;
		self.postMessage({ type: "host-request", requestId: id, method, params });
		return new Promise<T>((resolve, reject) => {
			this.pendingRequests.set(id, {
				resolve: (v) => resolve(v as T),
				reject,
			});
		});
	}

	on(name: string, handler: (payload: unknown) => void) {
		const handlers = this.eventHandlers.get(name) ?? new Set();
		handlers.add(handler);
		this.eventHandlers.set(name, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.eventHandlers.delete(name);
		};
	}

	emit(name: string, payload: unknown) {
		this.eventHandlers.get(name)?.forEach((h) => {
			try { h(payload); } catch (e) { console.error(`[bridge] event handler failed: ${name}`, e); }
		});
	}

	private handleMessage(message: any) {
		if (!message || typeof message !== "object" || !("type" in message)) return;

		if (message.type === "host-response") {
			const pending = this.pendingRequests.get(message.requestId);
			if (!pending) return;
			this.pendingRequests.delete(message.requestId);
			if (message.success) {
				pending.resolve(message.payload);
			} else {
				pending.reject(new Error(message.error || "Host request failed"));
			}
		} else if (message.type === "event") {
			this.emit(message.name, message.payload);
		} else if (message.type === "init") {
			this.emit("init", message);
		}
	}
}

const isCarrotWorker = !!(globalThis as any).__bunnyCarrotBootstrap;
export const bridge: PostMessageBridge | null = isCarrotWorker ? new PostMessageBridge() : null;

// Proxy wrapper: routes ffi.request calls through FFI when available,
// or through the postMessage bridge when running as a carrot without FFI.
function createFfiRequestProxy(ffiRequest: Record<string, Function>): Record<string, Function> {
	if (hasFFI) return ffiRequest;

	return new Proxy(ffiRequest, {
		get(target, method: string) {
			if (typeof method !== "string") return target[method];
			return (params?: unknown) => {
				if (!bridge) {
					throw new Error(
						`Electrobun FFI is unavailable and no host bridge exists for request ${method}`,
					);
				}
				return bridge.requestHost(method, params);
			};
		},
	});
}

// const _callbacks: unknown[] = [];

// NOTE: Bun seems to hit limits on args or arg types. eg: trying to send 12 bools results
// in only about 8 going through then params after that. I think it may be similar to
// a zig bug I ran into last year. So check number of args in a signature when alignment issues occur.

// Non-null accessor for use inside _ffiImpl — these methods are only called when hasFFI is true.
const core_ = core!;
const native_ = native!;
const queuedHostMessageWebviewIdBuf = new Uint32Array(1);

const drainQueuedHostMessages = () => {
	if (!core) {
		return;
	}

	for (;;) {
		let rawMessage = "";
		let webviewId = 0;
		const messagePtr = core_.symbols.popNextQueuedHostMessage(
			ptr(queuedHostMessageWebviewIdBuf),
		) as Pointer | null;

		if (!messagePtr) {
			return;
		}

		try {
			webviewId = queuedHostMessageWebviewIdBuf[0]!;
			rawMessage = new CString(messagePtr).toString();
			if (!rawMessage) {
				continue;
			}

			const webview = BrowserView.ensureWrapped(webviewId);
			if (!webview) {
				continue;
			}

			webview.rpcHandler?.(JSON.parse(rawMessage));
		} catch (err) {
			console.error("error draining queued host message:", {
				webviewId,
				messagePreview: rawMessage.slice(0, 500),
				error:
					err instanceof Error
						? { name: err.name, message: err.message, stack: err.stack }
						: err,
			});
		} finally {
			core_.symbols.freeCoreString(messagePtr);
		}
	}
};

let hostMessagePollingStarted = false;
const startHostMessagePolling = (error?: unknown) => {
	if (hostMessagePollingStarted) {
		return;
	}
	hostMessagePollingStarted = true;
	const code =
		error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code)
			: "";
	if (error && code !== "EAGAIN") {
		console.error("host message wakeup stream failed, falling back to polling:", error);
	}
	setInterval(drainQueuedHostMessages, 16);
	drainQueuedHostMessages();
};

if (core) {
	const wakeupReadFd = core_.symbols.getHostMessageWakeupReadFD();
	const isRealBunRuntime = typeof process.versions?.bun === "string";

	if (isRealBunRuntime) {
		startHostMessagePolling();
	} else if (typeof wakeupReadFd === "number" && wakeupReadFd >= 0) {
		try {
			const wakeupStream = createReadStream("/dev/null", {
				fd: wakeupReadFd,
				autoClose: false,
			});
			wakeupStream.on("data", () => {
				drainQueuedHostMessages();
			});
			wakeupStream.on("error", (error) => {
				wakeupStream.destroy();
				startHostMessagePolling(error);
			});
		} catch (error) {
			startHostMessagePolling(error);
		}
	} else {
		startHostMessagePolling();
	}

	drainQueuedHostMessages();
}

const _ffiImpl = {
	request: {
		createWindow: (params: {
			url: string | null;
			title: string;
			frame: {
				width: number;
				height: number;
				x: number;
				y: number;
			};
			styleMask: {
				Borderless: boolean;
				Titled: boolean;
				Closable: boolean;
				Miniaturizable: boolean;
				Resizable: boolean;
				UnifiedTitleAndToolbar: boolean;
				FullScreen: boolean;
				FullSizeContentView: boolean;
				UtilityWindow: boolean;
				DocModalWindow: boolean;
				NonactivatingPanel: boolean;
				HUDWindow: boolean;
			};
			titleBarStyle: string;
			transparent: boolean;
			hidden?: boolean;
			activate?: boolean;
			trafficLightOffset?: {
				x: number;
				y: number;
			};
		}): number => {
			const {
				url: _url,
				title,
				frame: { x, y, width, height },
				styleMask: {
					Borderless,
					Titled,
					Closable,
					Miniaturizable,
					Resizable,
					UnifiedTitleAndToolbar,
					FullScreen,
					FullSizeContentView,
					UtilityWindow,
					DocModalWindow,
					NonactivatingPanel,
					HUDWindow,
				},
				titleBarStyle,
				transparent,
				hidden = false,
				activate = true,
				trafficLightOffset = { x: 0, y: 0 },
			} = params;

			const styleMask = core_.symbols.getWindowStyle(
				Borderless,
				Titled,
				Closable,
				Miniaturizable,
				Resizable,
				UnifiedTitleAndToolbar,
				FullScreen,
				FullSizeContentView,
				UtilityWindow,
				DocModalWindow,
				NonactivatingPanel,
				HUDWindow,
			);

			const windowId = core_.symbols.createWindow(
				// frame
				x,
				y,
				width,
				height,
				styleMask,
				// style
				toCString(titleBarStyle),
				transparent,
				toCString(title),
				hidden,
				activate,
				trafficLightOffset.x,
				trafficLightOffset.y,
				// callbacks
				windowCloseCallback,
				windowMoveCallback,
				windowResizeCallback,
				windowFocusCallback,
				windowBlurCallback,
				windowKeyCallback,
			);

			if (!windowId) {
				throw getCoreLastError() || "Failed to create window";
			}

			return windowId;
		},
		getWindowPointer: (params: { winId: number }): Pointer | null => {
			return getWindowPtr(params.winId);
		},
		setTitle: (params: { winId: number; title: string }) => {
			const { winId, title } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set window title. Window no longer exists`;
			}

			core_.symbols.setWindowTitle(winId, toCString(title));
		},

		closeWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				// Window already closed — silently ignore the race condition
				return;
			}

			core_.symbols.closeWindow(winId);
			// Note: Cleanup of BrowserWindowMap happens in the windowCloseCallback
		},

		showWindow: (params: { winId: number; activate?: boolean }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't show window. Window no longer exists`;
			}

			core_.symbols.showWindow(winId, params.activate ?? true);
		},

		activateWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't activate window. Window no longer exists`;
			}

			core_.symbols.activateWindow(winId);
		},

		hideWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't hide window. Window no longer exists`;
			}

			core_.symbols.hideWindow(winId);
		},

		minimizeWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't minimize window. Window no longer exists`;
			}

			core_.symbols.minimizeWindow(winId);
		},

		restoreWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't restore window. Window no longer exists`;
			}

			core_.symbols.restoreWindow(winId);
		},

		isWindowMinimized: (params: { winId: number }): boolean => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				return false;
			}

			return core_.symbols.isWindowMinimized(winId);
		},

		maximizeWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't maximize window. Window no longer exists`;
			}

			core_.symbols.maximizeWindow(winId);
		},

		unmaximizeWindow: (params: { winId: number }) => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't unmaximize window. Window no longer exists`;
			}

			core_.symbols.unmaximizeWindow(winId);
		},

		isWindowMaximized: (params: { winId: number }): boolean => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				return false;
			}

			return core_.symbols.isWindowMaximized(winId);
		},

		setWindowFullScreen: (params: { winId: number; fullScreen: boolean }) => {
			const { winId, fullScreen } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set fullscreen. Window no longer exists`;
			}

			core_.symbols.setWindowFullScreen(winId, fullScreen);
		},

		isWindowFullScreen: (params: { winId: number }): boolean => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				return false;
			}

			return core_.symbols.isWindowFullScreen(winId);
		},

		setWindowAlwaysOnTop: (params: { winId: number; alwaysOnTop: boolean }) => {
			const { winId, alwaysOnTop } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set always on top. Window no longer exists`;
			}

			core_.symbols.setWindowAlwaysOnTop(winId, alwaysOnTop);
		},

		isWindowAlwaysOnTop: (params: { winId: number }): boolean => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				return false;
			}

			return core_.symbols.isWindowAlwaysOnTop(winId);
		},

		setWindowVisibleOnAllWorkspaces: (params: {
			winId: number;
			visibleOnAllWorkspaces: boolean;
		}) => {
			const { winId, visibleOnAllWorkspaces } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set visible on all workspaces. Window no longer exists`;
			}

			core_.symbols.setWindowVisibleOnAllWorkspaces(
				winId,
				visibleOnAllWorkspaces,
			);
		},

		isWindowVisibleOnAllWorkspaces: (params: { winId: number }): boolean => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				return false;
			}

			return core_.symbols.isWindowVisibleOnAllWorkspaces(winId);
		},

		setWindowPosition: (params: { winId: number; x: number; y: number }) => {
			const { winId, x, y } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set window position. Window no longer exists`;
			}

			core_.symbols.setWindowPosition(winId, x, y);
		},

		setWindowButtonPosition: (params: { winId: number; x: number; y: number }) => {
			const { winId, x, y } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set window button position. Window no longer exists`;
			}

			core_.symbols.setWindowButtonPosition(winId, x, y);
		},

		setWindowSize: (params: {
			winId: number;
			width: number;
			height: number;
		}) => {
			const { winId, width, height } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set window size. Window no longer exists`;
			}

			core_.symbols.setWindowSize(winId, width, height);
		},

		setWindowFrame: (params: {
			winId: number;
			x: number;
			y: number;
			width: number;
			height: number;
		}) => {
			const { winId, x, y, width, height } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				throw `Can't set window frame. Window no longer exists`;
			}

			core_.symbols.setWindowFrame(winId, x, y, width, height);
		},

		getWindowFrame: (params: {
			winId: number;
		}): { x: number; y: number; width: number; height: number } => {
			const { winId } = params;
			const windowPtr = getWindowPtr(winId);

			if (!windowPtr) {
				return { x: 0, y: 0, width: 0, height: 0 };
			}

			// Create buffers to receive the output values
			const xBuf = new Float64Array(1);
			const yBuf = new Float64Array(1);
			const widthBuf = new Float64Array(1);
			const heightBuf = new Float64Array(1);

			core_.symbols.getWindowFrame(
				winId,
				ptr(xBuf),
				ptr(yBuf),
				ptr(widthBuf),
				ptr(heightBuf),
			);

			return {
				x: xBuf[0]!,
				y: yBuf[0]!,
				width: widthBuf[0]!,
				height: heightBuf[0]!,
			};
		},
		createWebview: (params: {
			windowId: number;
			hostWebviewId: number | null;
			renderer: "cef" | "native";
			secretKey: string;
			url: string | null;
			partition: string | null;
			preload: string | null;
			viewsRoot: string | null;
			frame: {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			autoResize: boolean;
			navigationRules: string | null;
			sandbox: boolean;
			startTransparent: boolean;
			startPassthrough: boolean;
		}): number => {
			const {
				windowId,
				hostWebviewId,
				renderer,
				secretKey,
				url,
				partition,
				preload,
				viewsRoot,
				frame: { x, y, width, height },
				autoResize,
				sandbox,
				startTransparent,
				startPassthrough,
			} = params;
			ensureWebviewRuntimeConfigured();

			const webviewId = core_.symbols.createWebview(
				windowId,
				hostWebviewId || 0,
				toCString(renderer),
				toCString(url || ""),
				x,
				y,
				width,
				height,
				autoResize,
				toCString(partition || "persist:default"),
				webviewDecideNavigation,
				webviewEventJSCallback,
				eventBridgeHandler,
				hostBridgePostmessageHandler,
				internalBridgeHandler,
				toCString(secretKey),
				toCString(preload || ""),
				toCString(viewsRoot || ""),
				sandbox, // When true, hostBridge and internalBridge are not set up in native code
				startTransparent,
				startPassthrough,
			);

			if (!webviewId) {
				throw getCoreLastError() || "Failed to create webview";
			}

			return webviewId;
		},
		getWebviewPointer: (params: { id: number }): Pointer | null => {
			return core_.symbols.getWebviewPointer(params.id) || null;
		},
		resizeWebview: (params: {
			id: number;
			frame: { x: number; y: number; width: number; height: number };
			masks?: string;
		}) => {
			const { id, frame: { x, y, width, height }, masks = "[]" } = params;
			core_.symbols.resizeWebview(id, x, y, width, height, toCString(masks));
		},
		loadURLInWebView: (params: { id: number; url: string }) => {
			core_.symbols.loadURLInWebView(params.id, toCString(params.url));
		},
		loadHTMLInWebView: (params: { id: number; html: string }) => {
			core_.symbols.loadHTMLInWebView(params.id, toCString(params.html));
		},
		updatePreloadScriptToWebView: (params: {
			id: number;
			scriptIdentifier: string;
			script: string;
			allFrames: boolean;
		}) => {
			core_.symbols.updatePreloadScriptToWebView(
				params.id,
				toCString(params.scriptIdentifier),
				toCString(params.script),
				params.allFrames,
			);
		},
		webviewCanGoBack: (params: { id: number }) => {
			return core_.symbols.webviewCanGoBack(params.id);
		},
		webviewCanGoForward: (params: { id: number }) => {
			return core_.symbols.webviewCanGoForward(params.id);
		},
		webviewGoBack: (params: { id: number }) => {
			core_.symbols.webviewGoBack(params.id);
		},
		webviewGoForward: (params: { id: number }) => {
			core_.symbols.webviewGoForward(params.id);
		},
		webviewReload: (params: { id: number }) => {
			core_.symbols.webviewReload(params.id);
		},
		webviewRemove: (params: { id: number }) => {
			core_.symbols.webviewRemove(params.id);
		},
		setWebviewHTMLContent: (params: { id: number; html: string }) => {
			core_.symbols.setWebviewHTMLContent(params.id, toCString(params.html));
		},
		webviewSetTransparent: (params: { id: number; transparent: boolean }) => {
			core_.symbols.webviewSetTransparent(params.id, params.transparent);
		},
		webviewSetPassthrough: (params: { id: number; passthrough: boolean }) => {
			core_.symbols.webviewSetPassthrough(params.id, params.passthrough);
		},
		webviewSetHidden: (params: { id: number; hidden: boolean }) => {
			core_.symbols.webviewSetHidden(params.id, params.hidden);
		},
		setWebviewNavigationRules: (params: { id: number; rulesJson: string }) => {
			core_.symbols.setWebviewNavigationRules(params.id, toCString(params.rulesJson));
		},
		webviewFindInPage: (params: {
			id: number;
			searchText: string;
			forward: boolean;
			matchCase: boolean;
		}) => {
			core_.symbols.webviewFindInPage(
				params.id,
				toCString(params.searchText),
				params.forward,
				params.matchCase,
			);
		},
		webviewStopFind: (params: { id: number }) => {
			core_.symbols.webviewStopFind(params.id);
		},

		createWGPUView: (params: {
			windowId: number;
			frame: {
				x: number;
				y: number;
				width: number;
				height: number;
			};
			autoResize: boolean;
			startTransparent: boolean;
			startPassthrough: boolean;
		}): number => {
			const {
				windowId,
				frame: { x, y, width, height },
				autoResize,
				startTransparent,
				startPassthrough,
			} = params;

			const viewId = core_.symbols.createWGPUView(
				windowId,
				x,
				y,
				width,
				height,
				autoResize,
				startTransparent,
				startPassthrough,
			);

			if (!viewId) {
				throw "Failed to create WGPUView";
			}

			return viewId;
		},
		getWGPUViewPointer: (params: { id: number }): Pointer | null => {
			return core_.symbols.getWGPUViewPointer(params.id) || null;
		},

		wgpuViewSetFrame: (params: {
			id: number;
			x: number;
			y: number;
			width: number;
			height: number;
		}) => {
			core_.symbols.setWGPUViewFrame(
				params.id,
				params.x,
				params.y,
				params.width,
				params.height,
			);
		},

		wgpuViewSetTransparent: (params: { id: number; transparent: boolean }) => {
			core_.symbols.setWGPUViewTransparent(params.id, params.transparent);
		},

		wgpuViewSetPassthrough: (params: {
			id: number;
			passthrough: boolean;
		}) => {
			core_.symbols.setWGPUViewPassthrough(params.id, params.passthrough);
		},

		wgpuViewSetHidden: (params: { id: number; hidden: boolean }) => {
			core_.symbols.setWGPUViewHidden(params.id, params.hidden);
		},

		wgpuViewRemove: (params: { id: number }) => {
			core_.symbols.removeWGPUView(params.id);
		},
		wgpuViewGetNativeHandle: (params: { id: number }): Pointer | null => {
			return core_.symbols.getWGPUViewNativeHandle(params.id) || null;
		},
		runWGPUViewTest: (params: { id: number }) => {
			core_.symbols.runWGPUViewTest(params.id);
		},

		evaluateJavascriptWithNoCompletion: (params: {
			id: number;
			js: string;
		}) => {
			core_.symbols.evaluateJavaScriptWithNoCompletion(
				params.id,
				toCString(params.js),
			);
		},
		sendHostMessageToWebviewViaTransport: (params: {
			id: number;
			messageJson: string;
		}): boolean => {
			return core_.symbols.sendHostMessageToWebviewViaTransport(
				params.id,
				toCString(params.messageJson),
			);
		},
		clearWebviewHostTransport: (params: { id: number }) => {
			core_.symbols.clearWebviewHostTransport(params.id);
		},
		webviewOpenDevTools: (params: { id: number }) => {
			core_.symbols.webviewOpenDevTools(params.id);
		},
		webviewCloseDevTools: (params: { id: number }) => {
			core_.symbols.webviewCloseDevTools(params.id);
		},
		webviewToggleDevTools: (params: { id: number }) => {
			core_.symbols.webviewToggleDevTools(params.id);
		},
		webviewSetPageZoom: (params: { id: number; zoomLevel: number }) => {
			core_.symbols.webviewSetPageZoom(params.id, params.zoomLevel);
		},
		webviewGetPageZoom: (params: { id: number }): number => {
			return core_.symbols.webviewGetPageZoom(params.id);
		},
		setExitOnLastWindowClosed: (params: { enabled: boolean }) => {
			core_.symbols.setExitOnLastWindowClosed(params.enabled);
		},
		quitGracefully: (params: { code: number; timeoutMs: number }) => {
			core_.symbols.quitGracefully(params.code, params.timeoutMs);
		},

		createTray: (params: {
			title: string;
			image: string;
			template: boolean;
			width: number;
			height: number;
		}): number => {
			const { title, image, template, width, height } = params;

			const trayId = core_.symbols.createTray(
				toCString(title),
				toCString(image),
				template,
				width,
				height,
				trayItemHandler,
			);

			if (!trayId) {
				throw "Failed to create tray";
			}

			return trayId;
		},
		showTray: (params: { id: number }): boolean => {
			return core_.symbols.showTray(params.id);
		},
		hideTray: (params: { id: number }): void => {
			core_.symbols.hideTray(params.id);
		},
		setTrayTitle: (params: { id: number; title: string }): void => {
			const { id, title } = params;
			core_.symbols.setTrayTitle(id, toCString(title));
		},
		setTrayLength: (params: { id: number; length: number }): void => {
			core_.symbols.setTrayLength(params.id, params.length);
		},
		setTrayImage: (params: { id: number; image: string }): void => {
			const { id, image } = params;
			core_.symbols.setTrayImage(id, toCString(image));
		},
		setTrayMenu: (params: {
			id: number;
			// json string of config
			menuConfig: string;
		}): void => {
			const { id, menuConfig } = params;
			core_.symbols.setTrayMenu(id, toCString(menuConfig));
		},

		removeTray: (params: { id: number }): void => {
			core_.symbols.removeTray(params.id);
		},
		getTrayBounds: (params: { id: number }): Rectangle => {
			const jsonStr = core_.symbols.getTrayBounds(params.id);
			if (!jsonStr) {
				return { x: 0, y: 0, width: 0, height: 0 };
			}

			try {
				return JSON.parse(jsonStr.toString());
			} catch {
				return { x: 0, y: 0, width: 0, height: 0 };
			}
		},
		setApplicationMenu: (params: { menuConfig: string }): void => {
			const { menuConfig } = params;

			core_.symbols.setApplicationMenu(
				toCString(menuConfig),
				applicationMenuHandler,
			);
		},
		showContextMenu: (params: { menuConfig: string }): void => {
			const { menuConfig } = params;

			core_.symbols.showContextMenu(toCString(menuConfig), contextMenuHandler);
		},
		moveToTrash: (params: { path: string }): boolean => {
			const { path } = params;

			return core_.symbols.moveToTrash(toCString(path));
		},
		showItemInFolder: (params: { path: string }): void => {
			const { path } = params;

			core_.symbols.showItemInFolder(toCString(path));
		},
		openExternal: (params: { url: string }): boolean => {
			const { url } = params;
			return core_.symbols.openExternal(toCString(url));
		},
		openPath: (params: { path: string }): boolean => {
			const { path } = params;
			return core_.symbols.openPath(toCString(path));
		},
		showNotification: (params: {
			title: string;
			body?: string;
			subtitle?: string;
			silent?: boolean;
		}): void => {
			const { title, body = "", subtitle = "", silent = false } = params;
			core_.symbols.showNotification(
				toCString(title),
				toCString(body),
				toCString(subtitle),
				silent,
			);
		},
		setDockIconVisible: (params: { visible: boolean }): void => {
			core_.symbols.setDockIconVisible(params.visible);
		},
		isDockIconVisible: (): boolean => {
			return core_.symbols.isDockIconVisible();
		},
		openFileDialog: (params: {
			startingFolder: string;
			allowedFileTypes: string;
			canChooseFiles: boolean;
			canChooseDirectory: boolean;
			allowsMultipleSelection: boolean;
		}): string => {
			const {
				startingFolder,
				allowedFileTypes,
				canChooseFiles,
				canChooseDirectory,
				allowsMultipleSelection,
			} = params;
			const filePath = core_.symbols.openFileDialog(
				toCString(startingFolder),
				toCString(allowedFileTypes),
				canChooseFiles ? 1 : 0,
				canChooseDirectory ? 1 : 0,
				allowsMultipleSelection ? 1 : 0,
			);

			return filePath.toString();
		},
		showMessageBox: (params: {
			type?: string;
			title?: string;
			message?: string;
			detail?: string;
			buttons?: string[];
			defaultId?: number;
			cancelId?: number;
		}): number => {
			const {
				type = "info",
				title = "",
				message = "",
				detail = "",
				buttons = ["OK"],
				defaultId = 0,
				cancelId = -1,
			} = params;
			// Convert buttons array to comma-separated string
			const buttonsStr = buttons.join(",");
			return core_.symbols.showMessageBox(
				toCString(type),
				toCString(title),
				toCString(message),
				toCString(detail),
				toCString(buttonsStr),
				defaultId,
				cancelId,
			);
		},

		// Clipboard API
		clipboardReadText: (): string | null => {
			const result = core_.symbols.clipboardReadText();
			if (!result) return null;
			return result.toString();
		},
		clipboardWriteText: (params: { text: string }): void => {
			core_.symbols.clipboardWriteText(toCString(params.text));
		},
		clipboardReadImage: (): Uint8Array | null => {
			// Allocate a buffer for the size output
			const sizeBuffer = new BigUint64Array(1);
			const dataPtr = core_.symbols.clipboardReadImage(ptr(sizeBuffer));

			if (!dataPtr) return null;

			const size = Number(sizeBuffer[0]);
			if (size === 0) return null;

			// Copy the data to a Uint8Array
			const result = new Uint8Array(size);
			const sourceView = new Uint8Array(toArrayBuffer(dataPtr, 0, size));
			result.set(sourceView);

			// Note: The native code allocated this memory with malloc
			// We should free it, but Bun's FFI doesn't expose free directly
			// The memory will be reclaimed when the process exits

			return result;
		},
		clipboardWriteImage: (params: { pngData: Uint8Array }): void => {
			const { pngData } = params;
			core_.symbols.clipboardWriteImage(ptr(pngData), BigInt(pngData.length));
		},
		clipboardClear: (): void => {
			core_.symbols.clipboardClear();
		},
		clipboardAvailableFormats: (): string[] => {
			const result = core_.symbols.clipboardAvailableFormats();
			if (!result) return [];
			const formatsStr = result.toString();
			if (!formatsStr) return [];
			return formatsStr.split(",").filter((f) => f.length > 0);
		},

		// ffifunc: (params: {}): void => {
		//   const {

		//   } = params;

		//   native_.symbols.ffifunc(

		//   );
		// },
	},
	// Internal functions for menu data management
	internal: {
		storeMenuData,
		getMenuData,
		clearMenuData,
		serializeMenuAction,
		deserializeMenuAction,
	},
};

export const ffi = {
	request: createFfiRequestProxy(_ffiImpl.request as unknown as Record<string, Function>) as typeof _ffiImpl.request,
	internal: _ffiImpl.internal,
};

export const WGPUBridge = {
	available: !!native?.symbols?.wgpuInstanceCreateSurfaceMainThread,
	instanceCreateSurface: (instancePtr: Pointer, descriptorPtr: Pointer): Pointer =>
		native_.symbols.wgpuInstanceCreateSurfaceMainThread(
			instancePtr as any,
			descriptorPtr as any,
		) as Pointer,
	surfaceConfigure: (surfacePtr: Pointer, configPtr: Pointer) =>
		native_.symbols.wgpuSurfaceConfigureMainThread(
			surfacePtr as any,
			configPtr as any,
		),
	surfaceGetCurrentTexture: (surfacePtr: Pointer, surfaceTexturePtr: Pointer) =>
		native_.symbols.wgpuSurfaceGetCurrentTextureMainThread(
			surfacePtr as any,
			surfaceTexturePtr as any,
		),
	surfacePresent: (surfacePtr: Pointer): number =>
		native_.symbols.wgpuSurfacePresentMainThread(surfacePtr as any),
	queueOnSubmittedWorkDone: (queuePtr: Pointer, callbackInfoPtr: Pointer): bigint =>
		native_.symbols.wgpuQueueOnSubmittedWorkDoneShim(
			queuePtr as any,
			callbackInfoPtr as any,
		),
	bufferMapAsync: (
		bufferPtr: Pointer,
		mode: bigint,
		offset: bigint,
		size: bigint,
		callbackInfoPtr: Pointer,
	): bigint =>
		native_.symbols.wgpuBufferMapAsyncShim(
			bufferPtr as any,
			mode as any,
			offset as any,
			size as any,
			callbackInfoPtr as any,
		),
	instanceWaitAny: (
		instancePtr: Pointer,
		futureId: bigint,
		timeoutNs: bigint,
	): number =>
		native_.symbols.wgpuInstanceWaitAnyShim(
			instancePtr as any,
			futureId as any,
			timeoutNs as any,
		),
	bufferReadSync: (
		instancePtr: Pointer,
		bufferPtr: Pointer,
		offset: bigint,
		size: bigint,
		timeoutNs: bigint,
		outSizePtr: Pointer,
	): Pointer =>
		native_.symbols.wgpuBufferReadSyncShim(
			instancePtr as any,
			bufferPtr as any,
			offset as any,
			size as any,
			timeoutNs as any,
			outSizePtr as any,
		) as Pointer,
	bufferReadSyncInto: (
		instancePtr: Pointer,
		bufferPtr: Pointer,
		offset: bigint,
		size: bigint,
		timeoutNs: bigint,
		dstPtr: Pointer,
	): number =>
		native_.symbols.wgpuBufferReadSyncIntoShim(
			instancePtr as any,
			bufferPtr as any,
			offset as any,
			size as any,
			timeoutNs as any,
			dstPtr as any,
		),
	bufferReadbackBegin: (
		bufferPtr: Pointer,
		offset: bigint,
		size: bigint,
		dstPtr: Pointer,
	): Pointer =>
		native_.symbols.wgpuBufferReadbackBeginShim(
			bufferPtr as any,
			offset as any,
			size as any,
			dstPtr as any,
		) as Pointer,
	bufferReadbackStatus: (jobPtr: Pointer): number =>
		native_.symbols.wgpuBufferReadbackStatusShim(jobPtr as any),
	bufferReadbackFree: (jobPtr: Pointer) =>
		native_.symbols.wgpuBufferReadbackFreeShim(jobPtr as any),
	runTest: (viewId: number) => {
		const view = WGPUView.getById(viewId);
		if (!view?.ptr) {
			console.error(`wgpuRunGPUTest: WGPUView not found for id ${viewId}`);
			return;
		}
		if (!native?.symbols?.wgpuRunGPUTest) {
			console.error("wgpuRunGPUTest not available");
			return;
		}
		native_.symbols.wgpuRunGPUTest(view.ptr);
	},
	createAdapterDeviceMainThread: (
		instancePtr: Pointer,
		surfacePtr: Pointer,
		outAdapterDevicePtr: Pointer,
	) =>
		native_.symbols.wgpuCreateAdapterDeviceMainThread(
			instancePtr as any,
			surfacePtr as any,
			outAdapterDevicePtr as any,
		),
	createSurfaceForView: (instancePtr: Pointer, viewPtr: Pointer): Pointer | null => {
		if (!native?.symbols?.wgpuCreateSurfaceForView) return null;
		return native_.symbols.wgpuCreateSurfaceForView(instancePtr as any, viewPtr as any) as Pointer;
	},
};


// Worker management. Move to a different file
process.on("uncaughtException", (err) => {
	console.error("Uncaught exception in worker:", err);
	if (native) {
		native_.symbols.stopEventLoop();
		native_.symbols.waitForShutdownComplete(5000);
		native_.symbols.forceExit(1);
	} else {
		process.exit(1);
	}
});

process.on("unhandledRejection", (reason, _promise) => {
	console.error("Unhandled rejection in worker:", reason);
});

process.on("SIGINT", () => {
	console.log("[electrobun] Received SIGINT, running quit sequence...");
	const { quit } = require("../core/Utils");
	quit();
});

process.on("SIGTERM", () => {
	console.log("[electrobun] Received SIGTERM, running quit sequence...");
	const { quit } = require("../core/Utils");
	quit();
});

// const testCallback = new JSCallback(
//   (windowId, x, y) => {
//     console.log(`TEST FFI Callback reffed GLOBALLY in js`);
//     // Your window move handler implementation
//   },
//   {
//     args: [],
//     returns: "void",
//     threadsafe: true,

//   }
// );

const windowCloseCallback = new JSCallback(
	(id) => {
		const handler = electrobunEventEmitter.events.window.close;
		const event = handler({
			id,
		});

		// emit specific event first so user per-window handlers run
		// before the global handler (e.g. exitOnLastWindowClosed)
		electrobunEventEmitter.emitEvent(event, id);
		electrobunEventEmitter.emitEvent(event);
	},
	{
		args: ["u32"],
		returns: "void",
		threadsafe: true,
	},
);

const windowMoveCallback = new JSCallback(
	(id, x, y) => {
		const handler = electrobunEventEmitter.events.window.move;
		const event = handler({
			id,
			x,
			y,
		});

		// global event
		electrobunEventEmitter.emitEvent(event);
		electrobunEventEmitter.emitEvent(event, id);
	},
	{
		args: ["u32", "f64", "f64"],
		returns: "void",
		threadsafe: true,
	},
);

const windowResizeCallback = new JSCallback(
	(id, x, y, width, height) => {
		const handler = electrobunEventEmitter.events.window.resize;
		const event = handler({
			id,
			x,
			y,
			width,
			height,
		});

		// global event
		electrobunEventEmitter.emitEvent(event);
		electrobunEventEmitter.emitEvent(event, id);
	},
	{
		args: ["u32", "f64", "f64", "f64", "f64"],
		returns: "void",
		threadsafe: true,
	},
);

const windowFocusCallback = new JSCallback(
	(id) => {
		const handler = electrobunEventEmitter.events.window.focus;
		const event = handler({
			id,
		});

		// global event
		electrobunEventEmitter.emitEvent(event);
		electrobunEventEmitter.emitEvent(event, id);
	},
	{
		args: ["u32"],
		returns: "void",
		threadsafe: true,
	},
);

const windowBlurCallback = new JSCallback(
	(id) => {
		const handler = electrobunEventEmitter.events.window.blur;
		const event = handler({
			id,
		});
		
		// global event
        electrobunEventEmitter.emitEvent(event);
        electrobunEventEmitter.emitEvent(event, id);
  },
  {
		args: ["u32"],
		returns: "void",
		threadsafe: true,
	},
);

// global event
const windowKeyCallback = new JSCallback(
	(id, keyCode, modifiers, isDown, isRepeat) => {
		const handler = isDown
			? electrobunEventEmitter.events.window.keyDown
			: electrobunEventEmitter.events.window.keyUp;
		const event = handler({
			id,
			keyCode,
			modifiers,
			isRepeat: !!isRepeat,
		});
		electrobunEventEmitter.emitEvent(event);
		electrobunEventEmitter.emitEvent(event, id);
	},
	{
		args: ["u32", "u32", "u32", "u32", "u32"],
		returns: "void",
		threadsafe: true,
	},
);

const getMimeType = new JSCallback(
	(filePath) => {
		const _filePath = new CString(filePath).toString();
		const mimeType = Bun.file(_filePath).type; // || "application/octet-stream";

		// For this usecase we generally don't want the charset included in the mimetype
		// otherwise it can break. eg: for html with text/javascript;charset=utf-8 browsers
		// will tend to render the code/text instead of interpreting the html.

		return toCString(mimeType.split(";")[0]!);
	},
	{
		args: [FFIType.cstring],
		returns: FFIType.cstring,
		// threadsafe: true
	},
);

const getHTMLForWebviewSync = new JSCallback(
	(webviewId) => {
		const webview = BrowserView.ensureWrapped(webviewId);

		return toCString(webview?.html || "");
	},
	{
		args: [FFIType.u32],
		returns: FFIType.cstring,
		// threadsafe: true
	},
);

if (native) native_.symbols.setJSUtils(getMimeType, getHTMLForWebviewSync);

// Native-only init: URL scheme handlers, quit handler, global shortcuts.
// Skipped when running without FFI (carrot mode).
const globalShortcutHandlers = new Map<string, () => void>();

if (native) {
	const urlOpenCallback = new JSCallback(
		(urlPtr) => {
			const url = new CString(urlPtr).toString();
			const handler = electrobunEventEmitter.events.app.openUrl;
			const event = handler({ url });
			electrobunEventEmitter.emitEvent(event);
		},
		{ args: [FFIType.cstring], returns: "void", threadsafe: true },
	);
	if (process.platform === "darwin") {
		native_.symbols.setURLOpenHandler(urlOpenCallback);
	}

	const appReopenCallback = new JSCallback(
		() => {
			if (process.platform === "darwin") {
				core_.symbols.setDockIconVisible(true);
			}
			const handler = electrobunEventEmitter.events.app.reopen;
			const event = handler({});
			electrobunEventEmitter.emitEvent(event);
		},
		{ args: [], returns: "void", threadsafe: true },
	);
	if (process.platform === "darwin") {
		native_.symbols.setAppReopenHandler(appReopenCallback);
	}

	const quitRequestedCallback = new JSCallback(
		() => {
			const { quit } = require("../core/Utils");
			quit();
		},
		{ args: [], returns: "void", threadsafe: true },
	);
	core_.symbols.setQuitRequestedHandler(quitRequestedCallback);

	const globalShortcutCallback = new JSCallback(
		(acceleratorPtr) => {
			const accelerator = new CString(acceleratorPtr).toString();
			const handler = globalShortcutHandlers.get(accelerator);
			if (handler) handler();
		},
		{ args: [FFIType.cstring], returns: "void", threadsafe: true },
	);
	native_.symbols.setGlobalShortcutCallback(globalShortcutCallback);
}

// GlobalShortcut module for external use
export const GlobalShortcut = {
	/**
	 * Register a global keyboard shortcut
	 * @param accelerator - The shortcut string (e.g., "CommandOrControl+Shift+Space")
	 * @param callback - Function to call when the shortcut is triggered
	 * @returns true if registered successfully, false otherwise
	 */
	register: (accelerator: string, callback: () => void): boolean => {
		if (!native || globalShortcutHandlers.has(accelerator)) return false;
		const result = native_.symbols.registerGlobalShortcut(toCString(accelerator));
		if (result) globalShortcutHandlers.set(accelerator, callback);
		return result;
	},
	unregister: (accelerator: string): boolean => {
		if (!native) return false;
		const result = native_.symbols.unregisterGlobalShortcut(toCString(accelerator));
		if (result) globalShortcutHandlers.delete(accelerator);
		return result;
	},
	unregisterAll: (): void => {
		if (native) native_.symbols.unregisterAllGlobalShortcuts();
		globalShortcutHandlers.clear();
	},
	isRegistered: (accelerator: string): boolean => {
		if (!native) return false;
		return native_.symbols.isGlobalShortcutRegistered(toCString(accelerator));
	},
};

// Types for Screen API
export interface Rectangle {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface Display {
	id: number;
	bounds: Rectangle;
	workArea: Rectangle;
	scaleFactor: number;
	isPrimary: boolean;
}

export interface Point {
	x: number;
	y: number;
}

// Screen module for display and cursor information
export const Screen = {
	/**
	 * Get the primary display
	 * @returns Display object for the primary monitor
	 */
	getPrimaryDisplay: (): Display => {
		const jsonStr = hasFFI ? core_.symbols.getPrimaryDisplay() : null;
		if (!jsonStr) {
			return {
				id: 0,
				bounds: { x: 0, y: 0, width: 0, height: 0 },
				workArea: { x: 0, y: 0, width: 0, height: 0 },
				scaleFactor: 1,
				isPrimary: true,
			};
		}
		try {
			return JSON.parse(jsonStr.toString());
		} catch {
			return {
				id: 0,
				bounds: { x: 0, y: 0, width: 0, height: 0 },
				workArea: { x: 0, y: 0, width: 0, height: 0 },
				scaleFactor: 1,
				isPrimary: true,
			};
		}
	},

	/**
	 * Get all connected displays
	 * @returns Array of Display objects
	 */
	getAllDisplays: (): Display[] => {
		const jsonStr = hasFFI ? core_.symbols.getAllDisplays() : null;
		if (!jsonStr) {
			return [];
		}
		try {
			return JSON.parse(jsonStr.toString());
		} catch {
			return [];
		}
	},

	/**
	 * Get the current cursor position in screen coordinates
	 * @returns Point with x and y coordinates
	 */
	getCursorScreenPoint: (): Point => {
		const jsonStr = hasFFI ? core_.symbols.getCursorScreenPoint() : null;
		if (!jsonStr) {
			return { x: 0, y: 0 };
		}
		try {
			return JSON.parse(jsonStr.toString());
		} catch {
			return { x: 0, y: 0 };
		}
	},

	/**
	 * Get current mouse button bitmask (bit 0 = left, bit 1 = right, bit 2 = middle)
	 */
	getMouseButtons: (): bigint => {
		try {
			return hasFFI ? core_.symbols.getMouseButtons() : BigInt(0);
		} catch {
			return 0n;
		}
	},
};

// Types for Session/Cookie API
export interface Cookie {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "no_restriction" | "lax" | "strict";
	expirationDate?: number; // Unix timestamp in seconds
}

export interface CookieFilter {
	url?: string;
	name?: string;
	domain?: string;
	path?: string;
	secure?: boolean;
	session?: boolean;
}

export type StorageType =
	| "cookies"
	| "localStorage"
	| "sessionStorage"
	| "indexedDB"
	| "webSQL"
	| "cache"
	| "all";

// Cookies API for a session
class SessionCookies {
	private partitionId: string;

	constructor(partitionId: string) {
		this.partitionId = partitionId;
	}

	/**
	 * Get cookies matching the filter criteria
	 * @param filter - Optional filter to match cookies
	 * @returns Array of matching cookies
	 */
	get(filter?: CookieFilter): Cookie[] {
		const filterJson = JSON.stringify(filter || {});
		const result = native_.symbols.sessionGetCookies(
			toCString(this.partitionId),
			toCString(filterJson),
		);
		if (!result) return [];
		try {
			return JSON.parse(result.toString());
		} catch {
			return [];
		}
	}

	/**
	 * Set a cookie
	 * @param cookie - The cookie to set
	 * @returns true if the cookie was set successfully
	 */
	set(cookie: Cookie): boolean {
		const cookieJson = JSON.stringify(cookie);
		return native_.symbols.sessionSetCookie(
			toCString(this.partitionId),
			toCString(cookieJson),
		);
	}

	/**
	 * Remove a specific cookie
	 * @param url - The URL associated with the cookie
	 * @param name - The name of the cookie
	 * @returns true if the cookie was removed successfully
	 */
	remove(url: string, name: string): boolean {
		return native_.symbols.sessionRemoveCookie(
			toCString(this.partitionId),
			toCString(url),
			toCString(name),
		);
	}

	/**
	 * Clear all cookies for this session
	 */
	clear(): void {
		native_.symbols.sessionClearCookies(toCString(this.partitionId));
	}
}

// Session class representing a storage partition
class SessionInstance {
	readonly partition: string;
	readonly cookies: SessionCookies;

	constructor(partition: string) {
		this.partition = partition;
		this.cookies = new SessionCookies(partition);
	}

	/**
	 * Clear storage data for this session
	 * @param types - Array of storage types to clear, or 'all' to clear everything
	 */
	clearStorageData(types: StorageType[] | "all" = "all"): void {
		const typesArray = types === "all" ? ["all"] : types;
		native_.symbols.sessionClearStorageData(
			toCString(this.partition),
			toCString(JSON.stringify(typesArray)),
		);
	}
}

// Cache of session instances
const sessionCache = new Map<string, SessionInstance>();

// Session module for storage/cookie management
export const Session = {
	/**
	 * Get or create a session for a given partition
	 * @param partition - The partition identifier (e.g., "persist:myapp" or "ephemeral")
	 * @returns Session instance for the partition
	 */
	fromPartition: (partition: string): SessionInstance => {
		let session = sessionCache.get(partition);
		if (!session) {
			session = new SessionInstance(partition);
			sessionCache.set(partition, session);
		}
		return session;
	},

	/**
	 * Get the default session (persist:default partition)
	 */
	get defaultSession(): SessionInstance {
		return Session.fromPartition("persist:default");
	},
};

// DEPRECATED: This callback is no longer used for navigation decisions.
// Navigation rules are now stored in native code and evaluated synchronously
// without calling back to Bun. Use webview.setNavigationRules() instead.
// This callback is kept for FFI signature compatibility but is not called.
const webviewDecideNavigation = new JSCallback(
	(_webviewId, _url) => {
		return true;
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.u32,
		threadsafe: true,
	},
);

const webviewEventHandler = (id: number, eventName: string, detail: string) => {
	BrowserView.ensureWrapped(id);

	core_.symbols.dispatchHostWebviewEvent(
		id,
		toCString(eventName),
		toCString(detail),
	);

	const eventMap: Record<string, string> = {
		"will-navigate": "willNavigate",
		"did-navigate": "didNavigate",
		"did-navigate-in-page": "didNavigateInPage",
		"did-commit-navigation": "didCommitNavigation",
		"dom-ready": "domReady",
		"new-window-open": "newWindowOpen",
		"host-message": "hostMessage",
		"download-started": "downloadStarted",
		"download-progress": "downloadProgress",
		"download-completed": "downloadCompleted",
		"download-failed": "downloadFailed",
		"load-started": "loadStarted",
		"load-committed": "loadCommitted",
		"load-finished": "loadFinished",
	};

	const mappedName = eventMap[eventName];
	const handler = mappedName
		? (electrobunEventEmitter.events.webview as Record<string, unknown>)[
				mappedName
			]
		: undefined;

	if (!handler) {
		// console.error(
		// 	"[webviewEventHandler] No handler found for event:",
		// 	eventName,
		// 	"(mapped to:",
		// 	mappedName,
		// 	")",
		// );
		return { success: false };
	}

	// Parse JSON data for events that send JSON
	let parsedDetail = detail;
	if (
		eventName === "new-window-open" ||
		eventName === "host-message" ||
		eventName === "download-started" ||
		eventName === "download-progress" ||
		eventName === "download-completed" ||
		eventName === "download-failed"
	) {
		try {
			parsedDetail = JSON.parse(detail);
		} catch (e) {
			console.error("[webviewEventHandler] Failed to parse JSON:", e);
			// Fallback to string if parsing fails (backward compatibility)
			parsedDetail = detail;
		}
	}

	const event = (
		handler as (data: { detail: string }) => ElectrobunEvent<unknown, unknown>
	)({
		detail: parsedDetail,
	});

	// global event
	electrobunEventEmitter.emitEvent(event);
	electrobunEventEmitter.emitEvent(event, id);
};

const webviewEventJSCallback = new JSCallback(
	(id, _eventName, _detail) => {
		let eventName = "";
		let detail = "";

		try {
			// Convert cstring pointers to actual strings
			eventName = new CString(_eventName).toString();
			detail = new CString(_detail).toString();
		} catch (err) {
			console.error("[webviewEventJSCallback] Error converting strings:", err);
			console.error("[webviewEventJSCallback] Raw values:", {
				_eventName,
				_detail,
			});
			return;
		}

		webviewEventHandler(id, eventName, detail);
	},
	{
		args: [FFIType.u32, FFIType.cstring, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

const hostBridgePostmessageHandler = new JSCallback(
	(id, msg) => {
		try {
			const msgStr = new CString(msg);

			if (!msgStr.length) {
				return;
			}
			const rawMessage = msgStr.toString().trim();
			if (!rawMessage || (rawMessage[0] !== "{" && rawMessage[0] !== "[")) {
				return;
			}
			const msgJson = JSON.parse(rawMessage);

			const webview = BrowserView.ensureWrapped(id);
			if (!webview) {
				return;
			}

			webview.rpcHandler?.(msgJson);
		} catch (err) {
			console.error("error sending message to host: ", err);
		}
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

// internalRPC (bun <-> browser internal stuff)
// BrowserView.rpc (user defined bun <-> browser rpc unique to each webview)
// nativeRPC (internal bun <-> native rpc)

// eventBridgeHandler: handles ONLY webview events (dom-ready, navigation, etc.)
// This is available on ALL webviews including sandboxed ones.
// It cannot process RPC requests - only event emission.
const eventBridgeHandler = new JSCallback(
	(_id: number, msg: number) => {
		try {
			const message = new CString(msg as unknown as Pointer);
			const rawMessage = message.toString().trim();
			if (!rawMessage || (rawMessage[0] !== "{" && rawMessage[0] !== "[")) {
				return;
			}
			const jsonMessage = JSON.parse(rawMessage);

			// Only handle webviewEvent messages - no RPC
			if (jsonMessage.id === "webviewEvent") {
				const { payload } = jsonMessage;
				webviewEventHandler(payload.id, payload.eventName, payload.detail);
			}
			// Silently ignore any other message types - sandboxed webviews shouldn't send them
		} catch (err) {
			console.error("error in eventBridgeHandler: ", err);
		}
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

// internalBridgeHandler: handles internal RPC (webview tags, drag regions, etc.)
// This is only available on trusted (non-sandboxed) webviews.
const internalBridgeHandler = new JSCallback(
	(_id: number, msg: number) => {
		try {
			const batchMessage = new CString(msg as unknown as Pointer);
			const jsonBatch = JSON.parse(batchMessage.toString());

			if (jsonBatch.id === "webviewEvent") {
				// Note: Some WebviewEvents from inside the webview are routed through here
				// Others call the JSCallback directly from native code.
				const { payload } = jsonBatch;
				webviewEventHandler(payload.id, payload.eventName, payload.detail);
				return;
			}

			jsonBatch.forEach((msgStr: string) => {
				// if (!msgStr.length) {
				//   console.error('WEBVIEW EVENT SENT TO WEBVIEW TAG BRIDGE HANDLER?', )
				//   return;
				// }
				const msgJson = JSON.parse(msgStr);

				if (msgJson.type === "message") {
					const handler = (
						internalRpcHandlers.message as Record<
							string,
							(params: unknown) => void
						>
					)[msgJson.id];
					handler?.(msgJson.payload);
				} else if (msgJson.type === "request") {
					const handler = (
						internalRpcHandlers.request as Record<
							string,
							(params: unknown) => unknown
						>
					)[msgJson.method];

					const payload = handler?.(msgJson.params);

					const resultObj = {
						type: "response",
						id: msgJson.id,
						success: true,
						payload,
					};
					core_.symbols.sendInternalMessageToWebview(
						msgJson.hostWebviewId,
						toCString(JSON.stringify(resultObj)),
					);
				}
			});
		} catch (err) {
			console.error("error in internalBridgeHandler: ", err);
			// console.log('msgStr: ', id, new CString(msg));
		}
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

const trayItemHandler = new JSCallback(
	(id, action) => {
		// Note: Some invisible character that doesn't appear in .length
		// is causing issues
		const actionString = (new CString(action).toString() || "").trim();

		// Use shared deserialization method
		const { action: actualAction, data } = deserializeMenuAction(actionString);

		const event = electrobunEventEmitter.events.tray.trayClicked({
			id,
			action: actualAction,
			data, // Always include data property (undefined if no data)
		});

		// global event
		electrobunEventEmitter.emitEvent(event);
		electrobunEventEmitter.emitEvent(event, id);
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

const applicationMenuHandler = new JSCallback(
	(id, action) => {
		const actionString = new CString(action).toString();

		// Use shared deserialization method
		const { action: actualAction, data } = deserializeMenuAction(actionString);

		const event = electrobunEventEmitter.events.app.applicationMenuClicked({
			id,
			action: actualAction,
			data, // Always include data property (undefined if no data)
		});

		// global event
		electrobunEventEmitter.emitEvent(event);
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

const contextMenuHandler = new JSCallback(
	(_id, action) => {
		const actionString = new CString(action).toString();

		// Use shared deserialization method
		const { action: actualAction, data } = deserializeMenuAction(actionString);

		const event = electrobunEventEmitter.events.app.contextMenuClicked({
			action: actualAction,
			data, // Always include data property (undefined if no data)
		});

		electrobunEventEmitter.emitEvent(event);
	},
	{
		args: [FFIType.u32, FFIType.cstring],
		returns: FFIType.void,
		threadsafe: true,
	},
);

// Note: When passed over FFI JS will GC the buffer/pointer. Make sure to use strdup() or something
// on the c side to duplicate the string so objc/c++ gc can own it
export function toCString(
	jsString: string,
	addNullTerminator: boolean = true,
): CString {
	let appendWith = "";

	if (addNullTerminator && !jsString.endsWith("\0")) {
		appendWith = "\0";
	}
	const buff = Buffer.from(jsString + appendWith, "utf8");

	// @ts-ignore - This is valid in Bun
	return ptr(buff);
}

type WebviewTagInitParams = {
	url: string | null;
	html: string | null;
	preload: string | null;
	renderer: "native" | "cef";
	partition: string | null;
	frame: { x: number; y: number; width: number; height: number };
	hostWebviewId: number;
	windowId: number;
	navigationRules: string | null;
	sandbox: boolean;
	transparent: boolean;
	passthrough: boolean;
};

type WgpuTagInitParams = {
	windowId: number;
	frame: { x: number; y: number; width: number; height: number };
	transparent: boolean;
	passthrough: boolean;
};

export const internalRpcHandlers = {
	request: {
		// todo: this shouldn't be getting method, just params.
		webviewTagInit: (params: WebviewTagInitParams) => {
			const {
				hostWebviewId,
				windowId,
				renderer,
				html,
				preload,
				partition,
				frame,
				navigationRules,
				sandbox,
				transparent,
				passthrough,
			} = params;

			const url = !params.url && !html ? "https://electrobun.dev" : params.url;

			const webviewForTag = new BrowserView({
				url,
				html,
				preload,
				partition,
				frame,
				hostWebviewId,
				autoResize: false,
				windowId,
				renderer, //: "cef",
				navigationRules,
				sandbox,
				startTransparent: transparent,
				startPassthrough: passthrough,
			});

			return webviewForTag.id;
		},
		wgpuTagInit: (params: WgpuTagInitParams) => {
			const {
				windowId,
				frame,
				transparent,
				passthrough,
			} = params;

			const viewForTag = new WGPUView({
				windowId,
				frame,
				autoResize: false,
				startTransparent: transparent,
				startPassthrough: passthrough,
			});

			return viewForTag.id;
		},
		webviewTagCanGoBack: (params: { id: number }) => {
			return core_.symbols.webviewCanGoBack(params.id);
		},
		webviewTagCanGoForward: (params: { id: number }) => {
			return core_.symbols.webviewCanGoForward(params.id);
		},
	},
	message: {
		webviewTagResize: (params: {
			id: number;
			frame: { x: number; y: number; width: number; height: number };
			masks: string;
		}) => {
			const { x, y, width, height } = params.frame;
			core_.symbols.resizeWebview(
				params.id,
				x,
				y,
				width,
				height,
				toCString(params.masks ?? "[]"),
			);
		},
		wgpuTagResize: (params: {
			id: number;
			frame: { x: number; y: number; width: number; height: number };
			masks: string;
		}) => {
			const view = WGPUView.getById(params.id);
			if (!view?.ptr) {
				console.error(
					`wgpuTagResize: WGPUView not found or has no ptr for id ${params.id}`,
				);
				return;
			}

			const { x, y, width, height } = params.frame;
			native_.symbols.resizeWebview(
				view.ptr,
				x,
				y,
				width,
				height,
				toCString(params.masks ?? "[]"),
			);
		},
		webviewTagUpdateSrc: (params: { id: number; url: string }) => {
			const webview = BrowserView.ensureWrapped(params.id);
			if (webview) {
				webview.url = params.url;
			}
			core_.symbols.loadURLInWebView(params.id, toCString(params.url));
		},
		webviewTagUpdateHtml: (params: { id: number; html: string }) => {
			const webview = BrowserView.ensureWrapped(params.id);
			if (!webview) {
				console.error(`webviewTagUpdateHtml: BrowserView not found for id ${params.id}`);
				return;
			}

			webview.loadHTML(params.html);
			webview.html = params.html;
		},
		webviewTagUpdatePreload: (params: { id: number; preload: string }) => {
			const webview = BrowserView.ensureWrapped(params.id);
			if (webview) {
				webview.preload = params.preload;
			}
			core_.symbols.updatePreloadScriptToWebView(
				params.id,
				toCString("electrobun_custom_preload_script"),
				toCString(params.preload),
				true,
			);
		},
		webviewTagGoBack: (params: { id: number }) => {
			core_.symbols.webviewGoBack(params.id);
		},
		webviewTagGoForward: (params: { id: number }) => {
			core_.symbols.webviewGoForward(params.id);
		},
		webviewTagReload: (params: { id: number }) => {
			core_.symbols.webviewReload(params.id);
		},
		webviewTagRemove: (params: { id: number }) => {
			const webview = BrowserView.ensureWrapped(params.id);
			if (!webview) {
				console.error(`webviewTagRemove: BrowserView not found for id ${params.id}`);
				return;
			}
			webview.remove();
		},
		startWindowMove: (params: { id: number }) => {
			const windowPtr = getWindowPtr(params.id);
			if (!windowPtr) return;
			native_.symbols.startWindowMove(windowPtr);
		},
		stopWindowMove: (_params: unknown) => {
			native_.symbols.stopWindowMove();
		},
		webviewTagSetTransparent: (params: {
			id: number;
			transparent: boolean;
		}) => {
			core_.symbols.webviewSetTransparent(params.id, params.transparent);
		},
		wgpuTagSetTransparent: (params: {
			id: number;
			transparent: boolean;
		}) => {
			const view = WGPUView.getById(params.id);
			if (!view?.ptr) {
				console.error(
					`wgpuTagSetTransparent: WGPUView not found or has no ptr for id ${params.id}`,
				);
				return;
			}
			native_.symbols.wgpuViewSetTransparent(view.ptr, params.transparent);
		},
		webviewTagSetPassthrough: (params: {
			id: number;
			enablePassthrough: boolean;
		}) => {
			core_.symbols.webviewSetPassthrough(params.id, params.enablePassthrough);
		},
		wgpuTagSetPassthrough: (params: { id: number; passthrough: boolean }) => {
			const view = WGPUView.getById(params.id);
			if (!view?.ptr) {
				console.error(
					`wgpuTagSetPassthrough: WGPUView not found or has no ptr for id ${params.id}`,
				);
				return;
			}
			native_.symbols.wgpuViewSetPassthrough(view.ptr, params.passthrough);
		},
		webviewTagSetHidden: (params: { id: number; hidden: boolean }) => {
			core_.symbols.webviewSetHidden(params.id, params.hidden);
		},
		wgpuTagSetHidden: (params: { id: number; hidden: boolean }) => {
			const view = WGPUView.getById(params.id);
			if (!view?.ptr) {
				console.error(
					`wgpuTagSetHidden: WGPUView not found or has no ptr for id ${params.id}`,
				);
				return;
			}
			native_.symbols.wgpuViewSetHidden(view.ptr, params.hidden);
		},
		wgpuTagRemove: (params: { id: number }) => {
			const view = WGPUView.getById(params.id);
			if (!view?.ptr) {
				console.error(
					`wgpuTagRemove: WGPUView not found or has no ptr for id ${params.id}`,
				);
				return;
			}
			view.remove();
		},
		wgpuTagRunTest: (params: { id: number }) => {
			const view = WGPUView.getById(params.id);
			if (!view?.ptr) {
				console.error(
					`wgpuTagRunTest: WGPUView not found or has no ptr for id ${params.id}`,
				);
				return;
			}
			if (!native?.symbols?.wgpuRunGPUTest) {
				console.error("wgpuTagRunTest: wgpuRunGPUTest not available");
				return;
			}
			native_.symbols.wgpuRunGPUTest(view.ptr);
		},
		webviewTagSetNavigationRules: (params: { id: number; rules: string[] }) => {
			const rulesJson = JSON.stringify(params.rules);
			const webview = BrowserView.ensureWrapped(params.id);
			if (webview) {
				webview.navigationRules = rulesJson;
			}
			core_.symbols.setWebviewNavigationRules(params.id, toCString(rulesJson));
		},
		webviewTagFindInPage: (params: {
			id: number;
			searchText: string;
			forward: boolean;
			matchCase: boolean;
		}) => {
			core_.symbols.webviewFindInPage(
				params.id,
				toCString(params.searchText),
				params.forward,
				params.matchCase,
			);
		},
		webviewTagStopFind: (params: { id: number }) => {
			core_.symbols.webviewStopFind(params.id);
		},
		webviewTagOpenDevTools: (params: { id: number }) => {
			core_.symbols.webviewOpenDevTools(params.id);
		},
		webviewTagCloseDevTools: (params: { id: number }) => {
			core_.symbols.webviewCloseDevTools(params.id);
		},
		webviewTagToggleDevTools: (params: { id: number }) => {
			core_.symbols.webviewToggleDevTools(params.id);
		},
		webviewTagExecuteJavascript: (params: { id: number; js: string }) => {
			core_.symbols.evaluateJavaScriptWithNoCompletion(
				params.id,
				toCString(params.js),
			);
		},
		webviewEvent: (params: unknown) => {
			console.log("-----------------+webviewEvent", params);
		},
	},
};

// todo: consider renaming to TrayMenuItemConfig
export type MenuItemConfig =
	| { type: "divider" | "separator" }
	| {
			type: "normal";
			label: string;
			tooltip?: string;
			action?: string;
			data?: any;
			submenu?: Array<MenuItemConfig>;
			enabled?: boolean;
			checked?: boolean;
			hidden?: boolean;
	  };

export type ApplicationMenuItemConfig =
	| { type: "divider" | "separator" }
	| {
			type?: "normal";
			label: string;
			tooltip?: string;
			action?: string;
			data?: any;
			submenu?: Array<ApplicationMenuItemConfig>;
			enabled?: boolean;
			checked?: boolean;
			hidden?: boolean;
			accelerator?: string;
	  }
	| {
			type?: "normal";
			label?: string;
			tooltip?: string;
			role?: string;
			data?: any;
			submenu?: Array<ApplicationMenuItemConfig>;
			enabled?: boolean;
			checked?: boolean;
			hidden?: boolean;
			accelerator?: string;
	  };
