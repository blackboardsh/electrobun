// Electrobun Full Preload Script (for trusted webviews)
// This is compiled to JS and injected into webviews that are NOT sandboxed
//
// Includes: RPC, encryption, drag regions, webview tags, lifecycle events
//
// Before this script runs, the following must be set:
// - window.__electrobunWebviewId
// - window.__electrobunWindowId
// - window.__electrobunRpcSocketPort
// - window.__electrobunHostSocketPort (optional alias)
// - window.__electrobunSecretKeyBytes
// - window.__electrobunEventBridge (event emission - all webviews)
// - window.__electrobunInternalBridge (internal RPC - trusted only)
// - window.__electrobunHostBridge (user RPC - trusted only)
// - window.__electrobunBunBridge (legacy alias)

import "./globals.d.ts";
import { initEncryption } from "./encryption";
import { handleResponse } from "./internalRpc";
import { initDragRegions } from "./dragRegions";
import { initWebviewTag } from "./webviewTag";
import { initWgpuTag } from "./wgpuTag";
import {
	emitWebviewEvent,
	initLifecycleEvents,
	initCmdClickHandling,
	initSPANavigationInterception,
	initOverscrollPrevention,
} from "./events";

// Initialize encryption first (async)
initEncryption().catch((err) =>
	console.error("Failed to initialize encryption:", err),
);

// Set up global handlers for bun to call back
// Wrapper to satisfy the (msg: unknown) => void type
const internalMessageHandler = (msg: unknown) => {
	handleResponse(msg as { type: string; id: string; success: boolean; payload: unknown });
};

const defaultUserMessageHandler = (msg: unknown) => {
	// Buffer user RPC packets that arrive before the page-specific Electroview
	// instance installs the real handler.
	if (!window.__electrobunPendingHostMessages) {
		window.__electrobunPendingHostMessages = [];
	}
	window.__electrobunPendingHostMessages.push(msg);
};

if (!window.__electrobun) {
	window.__electrobun = {
		receiveInternalMessageFromHost: internalMessageHandler,
		receiveMessageFromHost: defaultUserMessageHandler,
		receiveInternalMessageFromBun: internalMessageHandler,
		receiveMessageFromBun: defaultUserMessageHandler,
	};
} else {
	window.__electrobun.receiveInternalMessageFromHost = internalMessageHandler;
	window.__electrobun.receiveMessageFromHost = defaultUserMessageHandler;
	window.__electrobun.receiveInternalMessageFromBun = internalMessageHandler;
	window.__electrobun.receiveMessageFromBun = defaultUserMessageHandler;
}

// Allow preload scripts to send custom messages to the host webview
window.__electrobunSendToHost = (message: unknown) => {
	emitWebviewEvent("host-message", JSON.stringify(message));
};

// Initialize all features
initLifecycleEvents();
initCmdClickHandling();
initSPANavigationInterception();
initOverscrollPrevention();
initDragRegions();
initWebviewTag();
initWgpuTag();
