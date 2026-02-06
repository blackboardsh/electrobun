// Electrobun Full Preload Script (for trusted webviews)
// This is compiled to JS and injected into webviews that are NOT sandboxed
//
// Includes: RPC, encryption, drag regions, webview tags, lifecycle events
//
// Before this script runs, the following must be set:
// - window.__electrobunWebviewId
// - window.__electrobunWindowId
// - window.__electrobunRpcSocketPort
// - window.__electrobunSecretKeyBytes
// - window.__electrobunEventBridge (event emission - all webviews)
// - window.__electrobunInternalBridge (internal RPC - trusted only)
// - window.__electrobunBunBridge (user RPC - trusted only)

import "./globals.d.ts";
import { initEncryption } from "./encryption";
import { handleResponse } from "./internalRpc";
import { initDragRegions } from "./dragRegions";
import { initWebviewTag } from "./webviewTag";
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
window.__electrobun = window.__electrobun || ({} as typeof window.__electrobun);
window.__electrobun.receiveInternalMessageFromBun = handleResponse;
window.__electrobun.receiveMessageFromBun = (msg: unknown) => {
	// Default handler for user RPC - will be overridden if user creates Electroview
	console.log("receiveMessageFromBun (no handler):", msg);
};

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
