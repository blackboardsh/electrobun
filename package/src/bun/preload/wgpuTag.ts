// <electrobun-wgpu> Custom Element
// Provides a layout-driven native WGPU view that is positioned via a DOM element.

import "./globals.d.ts";
import { send, request } from "./internalRpc";

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

type WgpuTagEventType = "ready";

// Registry for WGPU view instances (for event routing if needed)
export const wgpuTagRegistry: Record<number, ElectrobunWgpuTag> = {};

export class ElectrobunWgpuTag extends HTMLElement {
	wgpuViewId: number | null = null;
	maskSelectors: Set<string> = new Set();
	lastRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
	resizeObserver: ResizeObserver | null = null;
	positionCheckLoop: ReturnType<typeof setInterval> | null = null;
	private _resizeHandler: (() => void) | null = null;
	private _burstUntil = 0;
	transparent = false;
	passthroughEnabled = false;
	hidden = false;
	private _eventListeners: Record<string, Array<(event: CustomEvent) => void>> =
		{};

	constructor() {
		super();
	}

	connectedCallback() {
		requestAnimationFrame(() => this.initWgpuView());
	}

	disconnectedCallback() {
		if (this.wgpuViewId !== null) {
			send("wgpuTagRemove", { id: this.wgpuViewId });
			delete wgpuTagRegistry[this.wgpuViewId];
		}
		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.positionCheckLoop) clearTimeout(this.positionCheckLoop);
		if (this._resizeHandler) {
			window.removeEventListener("resize", this._resizeHandler);
			this._resizeHandler = null;
		}
	}

	async initWgpuView() {
		const rect = this.getBoundingClientRect();
		this.lastRect = {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		};

		const transparent = this.hasAttribute("transparent");
		const passthrough = this.hasAttribute("passthrough");
		const hidden = this.hasAttribute("hidden");
		const masks = this.getAttribute("masks");

		this.transparent = transparent;
		this.passthroughEnabled = passthrough;
		this.hidden = hidden;

		if (masks) {
			masks.split(",").forEach((s) => this.maskSelectors.add(s.trim()));
		}

		if (transparent) this.style.opacity = "0";
		if (passthrough) this.style.pointerEvents = "none";

		try {
			const wgpuViewId = (await request("wgpuTagInit", {
				windowId: window.__electrobunWindowId,
				frame: {
					width: rect.width,
					height: rect.height,
					x: rect.x,
					y: rect.y,
				},
				transparent,
				passthrough,
			})) as number;

			this.wgpuViewId = wgpuViewId;
			this.id = `electrobun-wgpu-${wgpuViewId}`;
			wgpuTagRegistry[wgpuViewId] = this;

			this.setupObservers();
			// Force immediate sync after initialization
			this.syncDimensions(true);

			// Apply hidden state after creation (no init flag for hidden)
			if (hidden) {
				this.toggleHidden(true);
			}

			// When adding a new WGPU view, force all existing WGPU views to re-sync
			requestAnimationFrame(() => {
				Object.values(wgpuTagRegistry).forEach((view) => {
					if (view !== this && view.wgpuViewId !== null) {
						view.syncDimensions(true);
					}
				});
			});

			this.emit("ready", { id: wgpuViewId });
		} catch (err) {
			console.error("Failed to init WGPU view:", err);
		}
	}

	setupObservers() {
		this.resizeObserver = new ResizeObserver(() => this.syncDimensions());
		this.resizeObserver.observe(this);

		const loop = () => {
			this.syncDimensions();
			const now = performance.now();
			const interval = now < this._burstUntil ? 10 : 100;
			this.positionCheckLoop = setTimeout(loop, interval);
		};
		this.positionCheckLoop = setTimeout(loop, 100);

		// Ensure we re-sync on window resize even if the element rect doesn't change.
		this._resizeHandler = () => this.syncDimensions(true);
		window.addEventListener("resize", this._resizeHandler);
	}

	syncDimensions(force = false) {
		if (this.wgpuViewId === null) return;

		const rect = this.getBoundingClientRect();
		const newRect: Rect = {
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
		};

		if (newRect.width === 0 && newRect.height === 0) {
			return;
		}

		if (
			!force &&
			newRect.x === this.lastRect.x &&
			newRect.y === this.lastRect.y &&
			newRect.width === this.lastRect.width &&
			newRect.height === this.lastRect.height
		) {
			return;
		}

		this._burstUntil = performance.now() + 50;
		this.lastRect = newRect;

		// Calculate mask rectangles
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

		send("wgpuTagResize", {
			id: this.wgpuViewId,
			frame: newRect,
			masks: JSON.stringify(masks),
		});
	}

	// Visibility methods
	toggleTransparent(value?: boolean) {
		if (this.wgpuViewId === null) return;
		this.transparent = value !== undefined ? value : !this.transparent;
		this.style.opacity = this.transparent ? "0" : "";
		send("wgpuTagSetTransparent", {
			id: this.wgpuViewId,
			transparent: this.transparent,
		});
	}

	togglePassthrough(value?: boolean) {
		if (this.wgpuViewId === null) return;
		this.passthroughEnabled =
			value !== undefined ? value : !this.passthroughEnabled;
		this.style.pointerEvents = this.passthroughEnabled ? "none" : "";
		send("wgpuTagSetPassthrough", {
			id: this.wgpuViewId,
			passthrough: this.passthroughEnabled,
		});
	}

	toggleHidden(value?: boolean) {
		if (this.wgpuViewId === null) return;
		this.hidden = value !== undefined ? value : !this.hidden;
		send("wgpuTagSetHidden", { id: this.wgpuViewId, hidden: this.hidden });
	}

	// Debug helper (native test renderer)
	runTest() {
		if (this.wgpuViewId === null) return;
		send("wgpuTagRunTest", { id: this.wgpuViewId });
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

	// Event handling
	on(event: WgpuTagEventType, listener: (event: CustomEvent) => void) {
		if (!this._eventListeners[event]) this._eventListeners[event] = [];
		this._eventListeners[event].push(listener);
	}

	off(event: WgpuTagEventType, listener: (event: CustomEvent) => void) {
		if (!this._eventListeners[event]) return;
		const idx = this._eventListeners[event].indexOf(listener);
		if (idx !== -1) this._eventListeners[event].splice(idx, 1);
	}

	emit(event: WgpuTagEventType, detail: unknown) {
		const listeners = this._eventListeners[event];
		if (listeners) {
			const customEvent = new CustomEvent(event, { detail });
			listeners.forEach((fn) => fn(customEvent));
		}
	}
}

export function initWgpuTag() {
	if (!customElements.get("electrobun-wgpu")) {
		customElements.define("electrobun-wgpu", ElectrobunWgpuTag);
	}

	const injectStyles = () => {
		const style = document.createElement("style");
		style.textContent = `
electrobun-wgpu {
	display: block;
	width: 800px;
	height: 300px;
	background: #000;
	overflow: hidden;
}
`;
		if (document.head?.firstChild) {
			document.head.insertBefore(style, document.head.firstChild);
		} else if (document.head) {
			document.head.appendChild(style);
		}
	};

	if (document.head) {
		injectStyles();
	} else {
		document.addEventListener("DOMContentLoaded", injectStyles);
	}
}
