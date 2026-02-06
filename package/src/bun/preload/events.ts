// Shared Event Emission for webview lifecycle events
// Uses __electrobunEventBridge which is available on ALL webviews (including sandboxed)
// Falls back to __electrobunInternalBridge for backwards compatibility until native code
// is updated to include the eventBridge handler
// This is a one-way channel for emitting events to native/bun - no RPC capability

import "./globals.d.ts";

// Emit a webview event to native code
export function emitWebviewEvent(eventName: string, detail: string) {
	// setTimeout works around a race condition with Bun FFI
	setTimeout(() => {
		// Prefer eventBridge (available on all webviews), fall back to internalBridge
		// (for backwards compatibility until native code adds eventBridge handler)
		const bridge =
			window.__electrobunEventBridge || window.__electrobunInternalBridge;
		bridge?.postMessage(
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

// Set up standard lifecycle event listeners
export function initLifecycleEvents() {
	// Emit dom-ready when page loads (top-level window only)
	window.addEventListener("load", () => {
		if (window === window.top) {
			emitWebviewEvent("dom-ready", document.location.href);
		}
	});

	// Track in-page navigation
	window.addEventListener("popstate", () => {
		emitWebviewEvent("did-navigate-in-page", window.location.href);
	});

	window.addEventListener("hashchange", () => {
		emitWebviewEvent("did-navigate-in-page", window.location.href);
	});
}

// Track cmd key state for SPA navigation detection
let cmdKeyHeld = false;
let cmdKeyTimestamp = 0;
const CMD_KEY_THRESHOLD_MS = 500;

export function isCmdHeld(): boolean {
	if (cmdKeyHeld) return true;
	return (
		Date.now() - cmdKeyTimestamp < CMD_KEY_THRESHOLD_MS && cmdKeyTimestamp > 0
	);
}

// Set up cmd+click detection for opening links in new windows
export function initCmdClickHandling() {
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
}

// Intercept SPA navigation (history.pushState/replaceState) when cmd is held
export function initSPANavigationInterception() {
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
}

// Prevent overscroll bounce effect
export function initOverscrollPrevention() {
	document.addEventListener("DOMContentLoaded", () => {
		const style = document.createElement("style");
		style.type = "text/css";
		style.appendChild(
			document.createTextNode("html, body { overscroll-behavior: none; }"),
		);
		document.head.appendChild(style);
	});
}
