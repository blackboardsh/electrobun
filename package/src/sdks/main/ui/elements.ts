// Native-layer elements: the UIWindow equivalents of <electrobun-wgpu> and
// <electrobun-webview>. Each is an anchor node in the retained tree — the UI
// layout decides where it goes, the anchor reports its rect, and nativeWrapper
// composites the real native surface there. Lifecycle follows the reactive
// scope: removed nodes tear down their native views.

import { WGPUView } from "../core/WGPUView";
import { BrowserView } from "../core/BrowserView";
import { ffi } from "../proc/native";
import { cleanup, inert } from "./reactive";
import { getUiContext, ui, type AnchorRect, type Reactive } from "./ui";
import { observeAsyncReady } from "./asyncReady";

export interface WgpuSurfaceProps {
	width?: Reactive<number>;
	height?: Reactive<number>;
	grow?: Reactive<number>;
	transparent?: boolean;
	/** Called once, after layout first places the surface. */
	onReady?: (view: WGPUView) => void | PromiseLike<void>;
	/** Called on every subsequent layout move/resize. */
	onFrame?: (view: WGPUView, rect: AnchorRect) => void;
}

/**
 * A native Dawn surface positioned by the UI layout — the `<electrobun-wgpu>`
 * equivalent. The view is created lazily on first layout so it never exists
 * at a zero-size frame.
 */
export function wgpuSurface(props: WgpuSurfaceProps): number {
	const ctx = getUiContext();
	if (ctx.windowId === 0) {
		throw new Error("wgpuSurface requires a mounted UIWindow (no windowId)");
	}
	const windowId = ctx.windowId;
	let view: WGPUView | null = null;

	const id = ui.anchor({
		width: props.width,
		height: props.height,
		grow: props.grow,
		onFrame: (rect) => {
			if (rect.width <= 0 || rect.height <= 0) return;
			if (!view) {
				view = new WGPUView({
					windowId,
					frame: {
						x: rect.x,
						y: rect.y,
						width: rect.width,
						height: rect.height,
					},
					autoResize: false,
					startTransparent: props.transparent ?? false,
					startPassthrough: false,
				});
				const ready = inert(() => props.onReady?.(view!));
				observeAsyncReady(
					ready,
					() => view === null || view.isRemoved,
					(error) => console.error("wgpuSurface onReady failed", error),
				);
			} else {
				view.setFrame(rect.x, rect.y, rect.width, rect.height);
				inert(() => props.onFrame?.(view!, rect));
			}
		},
	});

	cleanup(() => {
		view?.remove();
		view = null;
	});
	return id;
}

export interface WebviewElementProps {
	url?: string;
	html?: string;
	width?: Reactive<number>;
	height?: Reactive<number>;
	grow?: Reactive<number>;
	partition?: string;
	sandbox?: boolean;
	onReady?: (view: BrowserView) => void;
}

/**
 * An out-of-process webview positioned by the UI layout — the
 * `<electrobun-webview>` equivalent. Runs in the OOPIF-style webview
 * infrastructure (own process for CEF, own WKWebView otherwise); the UI tree
 * only owns its rectangle.
 */
export function webview(props: WebviewElementProps): number {
	const ctx = getUiContext();
	if (ctx.windowId === 0) {
		throw new Error("webview requires a mounted UIWindow (no windowId)");
	}
	const windowId = ctx.windowId;
	let view: BrowserView | null = null;

	const id = ui.anchor({
		nativeLayer: "webview",
		width: props.width,
		height: props.height,
		grow: props.grow,
		onFrame: (rect) => {
			if (rect.width <= 0 || rect.height <= 0) return;
			if (!view) {
				view = new BrowserView({
					windowId,
					url: props.url ?? null,
					html: props.html ?? null,
					partition: props.partition,
					sandbox: props.sandbox ?? false,
					autoResize: false,
					frame: {
						x: rect.x,
						y: rect.y,
						width: rect.width,
						height: rect.height,
					},
				});
				inert(() => props.onReady?.(view!));
			} else {
				view.frame = {
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height,
				};
				ffi.request.resizeWebview({ id: view.id, frame: view.frame });
			}
		},
	});

	cleanup(() => {
		view?.remove();
		view = null;
	});
	return id;
}
