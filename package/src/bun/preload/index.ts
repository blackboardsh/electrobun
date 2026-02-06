// Electrobun Default Preload Script
// This is compiled to JS and injected into every webview
//
// Before this script runs, the following must be set:
// - window.__electrobunWebviewId
// - window.__electrobunWindowId
// - window.__electrobunRpcSocketPort
// - window.__electrobunSecretKeyBytes
// - window.__electrobunInternalBridge
// - window.__electrobunBunBridge

import "./globals.d.ts";
import { initEncryption } from "./encryption";
import { handleResponse } from "./internalRpc";
import { initDragRegions } from "./dragRegions";
import { initWebviewTag, webviewRegistry } from "./webviewTag";

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

// Emit webview events to native
function emitWebviewEvent(eventName: string, detail: string) {
	// Note: setTimeout works around a race condition with Bun FFI
	setTimeout(() => {
		window.__electrobunInternalBridge?.postMessage(
			JSON.stringify({
				id: "webviewEvent",
				type: "message",
				payload: {
					id: window.__electrobunWebviewId,
					eventName,
					detail,
				},
			}),
		);
	});
}

// Lifecycle events
window.addEventListener("load", () => {
	// Only emit dom-ready for top-level window
	if (window === window.top) {
		emitWebviewEvent("dom-ready", document.location.href);
	}
});

window.addEventListener("popstate", () => {
	emitWebviewEvent("did-navigate-in-page", window.location.href);
});

window.addEventListener("hashchange", () => {
	emitWebviewEvent("did-navigate-in-page", window.location.href);
});

// Track cmd key state for SPA navigation detection
let cmdKeyHeld = false;
let cmdKeyTimestamp = 0;
const CMD_KEY_THRESHOLD_MS = 500;

window.addEventListener(
	"keydown",
	(event) => {
		if (event.key === "Meta" || event.metaKey) {
			cmdKeyHeld = true;
			cmdKeyTimestamp = Date.now();
		}
	},
	true,
);

window.addEventListener(
	"keyup",
	(event) => {
		if (event.key === "Meta") {
			cmdKeyHeld = false;
			cmdKeyTimestamp = Date.now();
		}
	},
	true,
);

window.addEventListener("blur", () => {
	cmdKeyHeld = false;
});

function isCmdHeld(): boolean {
	if (cmdKeyHeld) return true;
	return (
		Date.now() - cmdKeyTimestamp < CMD_KEY_THRESHOLD_MS && cmdKeyTimestamp > 0
	);
}

// Intercept cmd+clicks on anchors before SPA frameworks can handle them
window.addEventListener(
	"click",
	(event) => {
		if (event.metaKey || event.ctrlKey) {
			const anchor = (event.target as HTMLElement)?.closest?.("a");
			if (anchor && (anchor as HTMLAnchorElement).href) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
				emitWebviewEvent(
					"new-window-open",
					JSON.stringify({
						url: (anchor as HTMLAnchorElement).href,
						isCmdClick: true,
						isSPANavigation: false,
					}),
				);
			}
		}
	},
	true,
);

// Intercept history.pushState and replaceState for SPA navigation
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function (
	state: unknown,
	title: string,
	url?: string | URL | null,
) {
	if (isCmdHeld() && url) {
		const resolvedUrl = new URL(String(url), window.location.href).href;
		emitWebviewEvent(
			"new-window-open",
			JSON.stringify({
				url: resolvedUrl,
				isCmdClick: true,
				isSPANavigation: true,
			}),
		);
		return;
	}
	return originalPushState.apply(this, [state, title, url]);
};

history.replaceState = function (
	state: unknown,
	title: string,
	url?: string | URL | null,
) {
	if (isCmdHeld() && url) {
		const resolvedUrl = new URL(String(url), window.location.href).href;
		emitWebviewEvent(
			"new-window-open",
			JSON.stringify({
				url: resolvedUrl,
				isCmdClick: true,
				isSPANavigation: true,
			}),
		);
		return;
	}
	return originalReplaceState.apply(this, [state, title, url]);
};

// Prevent overscroll
document.addEventListener("DOMContentLoaded", () => {
	const style = document.createElement("style");
	style.type = "text/css";
	style.appendChild(
		document.createTextNode("html, body { overscroll-behavior: none; }"),
	);
	document.head.appendChild(style);
});

// Initialize features
initDragRegions();
initWebviewTag();
