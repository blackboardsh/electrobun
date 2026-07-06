// <electrobun-wgpu> Custom Element
// Provides a layout-driven native WGPU view that is positioned via a DOM element.

import "./globals.d.ts";
import { send, request } from "./internalRpc";
import { OverlaySyncController, type Rect } from "./overlaySync";

type WgpuTagEventType = "ready";

// Registry for WGPU view instances (for event routing if needed)
export const wgpuTagRegistry: Record<number, ElectrobunWgpuTag> = {};

export class ElectrobunWgpuTag extends HTMLElement {
	wgpuViewId: number | null = null;
	maskSelectors: Set<string> = new Set();
	private _sync: OverlaySyncController | null = null;
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
		if (this._sync) this._sync.stop();
	}

	async initWgpuView() {
		const rect = this.getBoundingClientRect();
		const initialRect = {
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

			this.setupObservers(initialRect);
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
				if (this.wgpuViewId === null) return;
				send("wgpuTagResize", {
					id: this.wgpuViewId,
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
