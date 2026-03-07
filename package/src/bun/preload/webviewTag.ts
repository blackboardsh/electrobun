// <electrobun-webview> Custom Element
// Provides OOPIF (out-of-process iframe) functionality

import "./globals.d.ts";
import { send, request } from "./internalRpc";
import { OverlaySyncController, type Rect } from "./overlaySync";

type WebviewEventType =
	| "will-navigate"
	| "did-navigate"
	| "did-navigate-in-page"
	| "did-commit-navigation"
	| "dom-ready"
	| "new-window-open"
	| "host-message"
	| "download-started"
	| "download-progress"
	| "download-completed"
	| "download-failed"
	| "load-started"
	| "load-committed"
	| "load-finished";

// Registry for webview instances (for event routing from bun)
export const webviewRegistry: Record<number, ElectrobunWebviewTag> = {};

export class ElectrobunWebviewTag extends HTMLElement {
	webviewId: number | null = null;
	maskSelectors: Set<string> = new Set();
	private _sync: OverlaySyncController | null = null;
	transparent = false;
	passthroughEnabled = false;
	hidden = false;
	// Sandbox mode: when true, disables RPC and only allows event emission in the child webview
	sandboxed = false;
	private _eventListeners: Record<string, Array<(event: CustomEvent) => void>> =
		{};

	constructor() {
		super();
	}

	connectedCallback() {
		requestAnimationFrame(() => this.initWebview());
	}

	disconnectedCallback() {
		if (this.webviewId !== null) {
			send("webviewTagRemove", { id: this.webviewId });
			delete webviewRegistry[this.webviewId];
		}
		if (this._sync) this._sync.stop();
	}

	async initWebview() {
		const rect = this.getBoundingClientRect();
		const initialRect = {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		};

		const url = this.getAttribute("src");
		const html = this.getAttribute("html");
		const preload = this.getAttribute("preload");
		const partition = this.getAttribute("partition");
		const renderer = (this.getAttribute("renderer") || "native") as
			| "native"
			| "cef";
		const masks = this.getAttribute("masks");
		// Sandbox attribute: when present, the child webview is sandboxed (no RPC, events only)
		const sandbox = this.hasAttribute("sandbox");
		this.sandboxed = sandbox;
		// Read transparent/passthrough attributes for initial state (avoids flash)
		const transparent = this.hasAttribute("transparent");
		const passthrough = this.hasAttribute("passthrough");
		this.transparent = transparent;
		this.passthroughEnabled = passthrough;
		if (transparent) this.style.opacity = "0";
		if (passthrough) this.style.pointerEvents = "none";

		if (masks) {
			masks.split(",").forEach((s) => this.maskSelectors.add(s.trim()));
		}

		try {
			const webviewId = (await request("webviewTagInit", {
				hostWebviewId: window.__electrobunWebviewId,
				windowId: window.__electrobunWindowId,
				renderer,
				url,
				html,
				preload,
				partition,
				frame: {
					width: rect.width,
					height: rect.height,
					x: rect.x,
					y: rect.y,
				},
				navigationRules: null,
				sandbox,
				transparent,
				passthrough,
			})) as number;

			this.webviewId = webviewId;
			this.id = `electrobun-webview-${webviewId}`;
			webviewRegistry[webviewId] = this;

			this.setupObservers(initialRect);
			// Force immediate sync after initialization
			this.syncDimensions(true);

			// When adding a new webview, force all existing webviews to re-sync their positions
			// This handles layout changes caused by the new webview
			// Use requestAnimationFrame to ensure DOM layout is complete
			requestAnimationFrame(() => {
				Object.values(webviewRegistry).forEach((webview) => {
					if (webview !== this && webview.webviewId !== null) {
						webview.syncDimensions(true);
					}
				});
			});
		} catch (err) {
			console.error("Failed to init webview:", err);
		}
	}

	setupObservers(initialRect: Rect) {
		const getMasks = () => {
			const rect = this.getBoundingClientRect();
			const masks: Rect[] = [];
			this.maskSelectors.forEach((selector) => {
				try {
					document.querySelectorAll(selector).forEach((el) => {
						const mr = el.getBoundingClientRect();
						masks.push({
							x: mr.x - rect.x,
							y: mr.y - rect.y,
							width: mr.width,
							height: mr.height,
						});
					});
				} catch (_e) {
					// Invalid selector, ignore
				}
			});
			return masks;
		};

		this._sync = new OverlaySyncController(this, {
			onSync: (rect, masksJson) => {
				if (this.webviewId === null) return;
				send("webviewTagResize", {
					id: this.webviewId,
					frame: rect,
					masks: masksJson,
				});
			},
			getMasks,
			burstIntervalMs: 10,
			baseIntervalMs: 100,
			burstDurationMs: 50,
		});
		this._sync.setLastRect(initialRect);
		this._sync.start();
	}

	syncDimensions(force = false) {
		if (!this._sync) return;
		if (force) {
			this._sync.forceSync();
		}
	}

	// Navigation methods
	loadURL(url: string) {
		if (this.webviewId === null) return;
		this.setAttribute("src", url);
		send("webviewTagUpdateSrc", { id: this.webviewId, url });
	}

	loadHTML(html: string) {
		if (this.webviewId === null) return;
		send("webviewTagUpdateHtml", { id: this.webviewId, html });
	}

	reload() {
		if (this.webviewId !== null)
			send("webviewTagReload", { id: this.webviewId });
	}

	goBack() {
		if (this.webviewId !== null)
			send("webviewTagGoBack", { id: this.webviewId });
	}

	goForward() {
		if (this.webviewId !== null)
			send("webviewTagGoForward", { id: this.webviewId });
	}

	async canGoBack(): Promise<boolean> {
		if (this.webviewId === null) return false;
		return (await request("webviewTagCanGoBack", {
			id: this.webviewId,
		})) as boolean;
	}

	async canGoForward(): Promise<boolean> {
		if (this.webviewId === null) return false;
		return (await request("webviewTagCanGoForward", {
			id: this.webviewId,
		})) as boolean;
	}

	// Visibility methods
	toggleTransparent(value?: boolean) {
		if (this.webviewId === null) return;
		this.transparent = value !== undefined ? value : !this.transparent;
		this.style.opacity = this.transparent ? "0" : "";
		send("webviewTagSetTransparent", {
			id: this.webviewId,
			transparent: this.transparent,
		});
	}

	togglePassthrough(value?: boolean) {
		if (this.webviewId === null) return;
		this.passthroughEnabled =
			value !== undefined ? value : !this.passthroughEnabled;
		this.style.pointerEvents = this.passthroughEnabled ? "none" : "";
		send("webviewTagSetPassthrough", {
			id: this.webviewId,
			enablePassthrough: this.passthroughEnabled,
		});
	}

	toggleHidden(value?: boolean) {
		if (this.webviewId === null) return;
		this.hidden = value !== undefined ? value : !this.hidden;
		send("webviewTagSetHidden", { id: this.webviewId, hidden: this.hidden });
	}

	// Mask management
	addMaskSelector(selector: string) {
		this.maskSelectors.add(selector);
		this.syncDimensions(true);
	}

	removeMaskSelector(selector: string) {
		this.maskSelectors.delete(selector);
		this.syncDimensions(true);
	}

	// Navigation rules
	setNavigationRules(rules: string[]) {
		if (this.webviewId !== null) {
			send("webviewTagSetNavigationRules", { id: this.webviewId, rules });
		}
	}

	// Find in page
	findInPage(
		searchText: string,
		options?: { forward?: boolean; matchCase?: boolean },
	) {
		if (this.webviewId === null) return;
		const forward = options?.forward !== false;
		const matchCase = options?.matchCase || false;
		send("webviewTagFindInPage", {
			id: this.webviewId,
			searchText,
			forward,
			matchCase,
		});
	}

	stopFindInPage() {
		if (this.webviewId !== null)
			send("webviewTagStopFind", { id: this.webviewId });
	}

	// DevTools
	openDevTools() {
		if (this.webviewId !== null)
			send("webviewTagOpenDevTools", { id: this.webviewId });
	}

	closeDevTools() {
		if (this.webviewId !== null)
			send("webviewTagCloseDevTools", { id: this.webviewId });
	}

	toggleDevTools() {
		if (this.webviewId !== null)
			send("webviewTagToggleDevTools", { id: this.webviewId });
	}

	// JavaScript execution
	executeJavascript(js: string) {
		if (this.webviewId === null) return;
		send("webviewTagExecuteJavascript", { id: this.webviewId, js });
	}

	// Event handling
	on(event: WebviewEventType, listener: (event: CustomEvent) => void) {
		if (!this._eventListeners[event]) this._eventListeners[event] = [];
		this._eventListeners[event].push(listener);
	}

	off(event: WebviewEventType, listener: (event: CustomEvent) => void) {
		if (!this._eventListeners[event]) return;
		const idx = this._eventListeners[event].indexOf(listener);
		if (idx !== -1) this._eventListeners[event].splice(idx, 1);
	}

	emit(event: WebviewEventType, detail: unknown) {
		const listeners = this._eventListeners[event];
		if (listeners) {
			const customEvent = new CustomEvent(event, { detail });
			listeners.forEach((fn) => fn(customEvent));
		}
	}

	// Property getters/setters
	get src(): string | null {
		return this.getAttribute("src");
	}
	set src(value: string | null) {
		if (value) {
			this.setAttribute("src", value);
			if (this.webviewId !== null) this.loadURL(value);
		} else {
			this.removeAttribute("src");
		}
	}

	get html(): string | null {
		return this.getAttribute("html");
	}
	set html(value: string | null) {
		if (value) {
			this.setAttribute("html", value);
			if (this.webviewId !== null) this.loadHTML(value);
		} else {
			this.removeAttribute("html");
		}
	}

	get preload(): string | null {
		return this.getAttribute("preload");
	}
	set preload(value: string | null) {
		if (value) this.setAttribute("preload", value);
		else this.removeAttribute("preload");
	}

	get renderer(): "native" | "cef" {
		return (this.getAttribute("renderer") as "native" | "cef") || "native";
	}
	set renderer(value: "native" | "cef") {
		this.setAttribute("renderer", value);
	}

	// Sandbox is read-only after creation (set via attribute before adding to DOM)
	get sandbox(): boolean {
		return this.sandboxed;
	}
}

export function initWebviewTag() {
	// Register the custom element if not already registered
	if (!customElements.get("electrobun-webview")) {
		customElements.define("electrobun-webview", ElectrobunWebviewTag);
	}

	// Add default styles for <electrobun-webview> elements
	// These can be easily overridden in the host document
	const injectStyles = () => {
		const style = document.createElement("style");
		style.textContent = `
electrobun-webview {
	display: block;
	width: 800px;
	height: 300px;
	background: #fff;
	background-repeat: no-repeat !important;
	overflow: hidden;
}
`;
		// Insert at the beginning of <head> so app styles take precedence
		if (document.head?.firstChild) {
			document.head.insertBefore(style, document.head.firstChild);
		} else if (document.head) {
			document.head.appendChild(style);
		}
	};

	// document.head may not exist at document start, defer if needed
	if (document.head) {
		injectStyles();
	} else {
		document.addEventListener("DOMContentLoaded", injectStyles);
	}
}
