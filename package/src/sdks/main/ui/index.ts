// Electrobun UI: HTML/CSS/JSX rendered by the Zig UI core straight into a
// WGPU view through Dawn — no webview. JSX uses the same warren DOM renderer
// as the browser, so components are portable between the two.
//
//   import { createUIWindow } from "electrobun/main/ui";
//   createUIWindow({ title: "App", width: 800, height: 600, css }, () => <App />);
import { JSCallback, ptr, toArrayBuffer } from "bun:ffi";
import { render as domRender } from "../../../browser/ui/dom";
import { native as wgpuNative } from "../webGPU";
import { GpuWindow } from "../core/GpuWindow";
import { WGPUView } from "../core/WGPUView";
import { BrowserView } from "../core/BrowserView";
import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { uiLib, isNativeUIAvailable as isUIAvailable } from "./ffi";
import { NativeDocument, NativeElement } from "./document";

export { isUIAvailable, NativeDocument as UIDocument, NativeElement as UINode };
export type { NativeEvent as UIEvent, UIRect } from "./document";
import type { UIRect } from "./document";

/** Anything that can be positioned over an element: a WGPUView, a
 * BrowserView, or your own frame setter. */
export type AnchorTarget =
	| WGPUView
	| BrowserView
	| { setFrame(x: number, y: number, width: number, height: number): void; setHidden?(hidden: boolean): void };

export interface AnchorOptions {
	/** called after the view is moved/resized (or hidden) */
	onFrame?: (rect: UIRect) => void;
}

function placeTarget(target: AnchorTarget, r: UIRect, wasVisible: boolean): void {
	if (target instanceof BrowserView) {
		if (r.visible) {
			target.frame = { x: r.x, y: r.y, width: r.width, height: r.height };
			ffi.request.resizeWebview({ id: target.id, frame: target.frame, masks: "[]" });
		}
		if (r.visible !== wasVisible) ffi.request.webviewSetHidden({ id: target.id, hidden: !r.visible });
		return;
	}
	if (target instanceof WGPUView && target.isRemoved) return;
	if (r.visible) target.setFrame(r.x, r.y, r.width, r.height);
	if (r.visible !== wasVisible) target.setHidden?.(!r.visible);
}

const enc = new TextEncoder();

type ViewLike = { ptr: unknown } | { wgpuView: { ptr: unknown } };

function viewPointer(target: ViewLike): unknown {
	if ("wgpuView" in target && target.wgpuView) return target.wgpuView.ptr;
	return (target as { ptr: unknown }).ptr;
}

export interface UIOptions {
	/** CSS stylesheets to add (strings) */
	css?: string | string[];
	/** follow / force the color scheme for prefers-color-scheme */
	dark?: boolean;
	/** add the built-in eb-* component stylesheet */
	components?: boolean;
}

export interface Modifiers {
	shift?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	meta?: boolean;
}

function modBits(m: Modifiers = {}): number {
	return (m.shift ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.alt ? 4 : 0) | (m.meta ? 8 : 0);
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

export class UI {
	readonly id: number;
	readonly document: NativeDocument;
	private wakeup: JSCallback | null = null;
	private poll: ReturnType<typeof setInterval> | null = null;
	private sheets: number[] = [];

	constructor(target: ViewLike, options: UIOptions = {}) {
		const lib = uiLib();
		this.id = lib.ebui_create();
		if (!this.id) throw new Error("electrobun UI: failed to create instance");
		this.document = new NativeDocument(this.id);
		const view = viewPointer(target);
		if (!view) throw new Error("electrobun UI: target has no WGPU view");
		const dawn = wgpuNative.path ? enc.encode(wgpuNative.path + "\0") : null;
		const ok = lib.ebui_attach_wgpu_view(this.id, view as any, dawn ? ptr(dawn) : null);
		if (!ok) throw new Error("electrobun UI: could not attach to the WGPU view (is bundleWGPU enabled?)");
		if (options.components) lib.ebui_use_components(this.id);
		for (const css of ([] as string[]).concat(options.css ?? [])) this.addStylesheet(css);
		if (options.dark !== undefined) lib.ebui_set_dark(this.id, options.dark);
		this.startEventPump();
		// tear down before the native view goes away
		const owner = target as { on?: (name: string, fn: () => void) => unknown };
		if (typeof owner.on === "function") owner.on("close", () => this.destroy());
	}

	private startEventPump() {
		const lib = uiLib();
		try {
			// native input arrives on the main thread; wake the JS thread to drain it
			this.wakeup = new JSCallback(() => queueMicrotask(() => this.document.pump()), {
				args: ["ptr"],
				returns: "void",
				threadsafe: true,
			});
			lib.ebui_set_wakeup(this.id, this.wakeup, null);
		} catch {
			this.wakeup = null;
		}
		// safety net (runtimes without thread-safe callbacks)
		this.poll = setInterval(() => this.document.pump(), this.wakeup ? 250 : 16);
	}

	addStylesheet(css: string): number {
		const b = enc.encode(css);
		const h = Number(uiLib().ebui_add_stylesheet(this.id, ptr(b.length ? b : new Uint8Array(1)), b.length));
		this.sheets.push(h);
		return h;
	}

	removeStylesheet(handle: number): void {
		uiLib().ebui_remove_stylesheet(this.id, handle);
	}

	/** Mount a warren app (JSX) into the native document body. */
	render(app: () => unknown): () => void {
		return domRender(app as any, this.document.body as unknown as Element);
	}

	get body(): NativeElement {
		return this.document.body;
	}

	querySelector(selector: string): NativeElement | null {
		// the JS mirror only knows nodes created from JS
		const walk = (n: any): NativeElement | null => {
			for (let c = n.firstChild; c; c = c.nextSibling) {
				if (c.nodeType === 1) {
					if (matchesSimple(c, selector)) return c;
					const r = walk(c);
					if (r) return r;
				}
			}
			return null;
		};
		return walk(this.document.body);
	}

	/**
	 * Keep a native view (WGPUView, BrowserView, or any `setFrame` target)
	 * positioned over `element`'s border box. The core reports the element's
	 * window rect after each frame in which it changed — layout, scrolling,
	 * window resizes — and when it is hidden or removed, in which case the view
	 * is hidden too. Native views draw above the UI and are not clipped by
	 * overflow:hidden ancestors. Returns a function that stops anchoring.
	 */
	anchor(element: NativeElement, target: AnchorTarget, options: AnchorOptions = {}): () => void {
		let visible = true;
		const stop = this.document.watchRect(element, (r) => {
			placeTarget(target, r, visible);
			visible = r.visible;
			options.onFrame?.(r);
		});
		this.anchors.add(stop);
		return () => {
			this.anchors.delete(stop);
			stop();
		};
	}

	private anchors = new Set<() => void>();

	setDark(dark: boolean): void {
		uiLib().ebui_set_dark(this.id, dark);
	}

	// ---- testing / automation -------------------------------------------

	/** Frames presented to the window so far. */
	get frames(): number {
		return Number(uiLib().ebui_host_frames(this.id));
	}

	/** Resolve after at least one more frame has been presented. */
	async nextFrame(timeoutMs = 2000): Promise<void> {
		this.document.flush();
		const start = this.frames;
		const deadline = Date.now() + timeoutMs;
		uiLib().ebui_request_capture(this.id); // forces a frame
		while (this.frames <= start && Date.now() < deadline) await sleep(4);
		this.document.pump();
	}

	/** Premultiplied RGBA of the presented frame at a point (CSS px). */
	async pixel(x: number, y: number): Promise<[number, number, number, number]> {
		this.document.flush();
		const lib = uiLib();
		lib.ebui_request_capture(this.id);
		const deadline = Date.now() + 3000;
		while (!lib.ebui_capture_ready(this.id) && Date.now() < deadline) await sleep(5);
		const out = new Uint8Array(4);
		lib.ebui_capture_pixel(this.id, x, y, ptr(out));
		return [out[0]!, out[1]!, out[2]!, out[3]!];
	}

	/** Accessibility tree lines: "role|name|value|flags". */
	accessibilityTree(): string[] {
		this.document.flush();
		const lenBuf = new BigUint64Array(1);
		const p = uiLib().ebui_a11y_dump(this.id, ptr(lenBuf));
		const len = Number(lenBuf[0]);
		if (!p || !len) return [];
		return new TextDecoder().decode(new Uint8Array(toArrayBuffer(p, 0, len))).trim().split("\n");
	}

	/** Synthetic input that goes through the same path as native events. */
	readonly simulate = {
		move: async (x: number, y: number) => {
			await this.nextFrame();
			uiLib().ebui_pointer(this.id, 0, x, y, 0, 0);
			await this.nextFrame();
		},
		click: async (target: NativeElement | { x: number; y: number }, mods?: Modifiers) => {
			await this.nextFrame();
			const p = "x" in target ? target : centerOf(target as NativeElement);
			const lib = uiLib();
			lib.ebui_pointer(this.id, 0, p.x, p.y, 0, modBits(mods));
			lib.ebui_pointer(this.id, 1, p.x, p.y, 0, modBits(mods));
			lib.ebui_pointer(this.id, 2, p.x, p.y, 0, modBits(mods));
			await this.nextFrame();
		},
		wheel: async (x: number, y: number, dx: number, dy: number) => {
			await this.nextFrame();
			uiLib().ebui_wheel(this.id, x, y, dx, dy, 0);
			await this.nextFrame();
		},
		key: async (key: string, mods?: Modifiers) => {
			this.document.flush();
			const b = new TextEncoder().encode(key);
			const lib = uiLib();
			lib.ebui_key(this.id, true, ptr(b.length ? b : new Uint8Array(1)), b.length, modBits(mods));
			lib.ebui_key(this.id, false, ptr(b.length ? b : new Uint8Array(1)), b.length, modBits(mods));
			await this.nextFrame();
		},
		type: async (text: string) => {
			this.document.flush();
			const b = new TextEncoder().encode(text);
			uiLib().ebui_text_input(this.id, ptr(b.length ? b : new Uint8Array(1)), b.length);
			await this.nextFrame();
		},
	};

	private destroyed = false;

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const stop of this.anchors) stop();
		this.anchors.clear();
		if (this.poll) clearInterval(this.poll);
		this.document.dispose();
		const lib = uiLib();
		lib.ebui_detach_view(this.id);
		lib.ebui_destroy(this.id);
		this.wakeup?.close();
	}
}

function centerOf(el: NativeElement): { x: number; y: number } {
	const r = el.getBoundingClientRect();
	return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Minimal selector support for the JS mirror: tag, #id, .class, [attr=value]. */
function matchesSimple(el: NativeElement, sel: string): boolean {
	const m = /^([a-z0-9-]*)(#[\w-]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="?([^"\]]*)"?)?\])?$/i.exec(sel.trim());
	if (!m) return false;
	const [, tag, id, classes, attr, value] = m;
	if (tag && el.localName !== tag.toLowerCase()) return false;
	if (id && el.getAttribute("id") !== id.slice(1)) return false;
	if (classes) for (const c of classes.split(".").filter(Boolean)) if (!el.classList.contains(c)) return false;
	if (attr) {
		const v = el.getAttribute(attr);
		if (v === null) return false;
		if (value !== undefined && v !== value) return false;
	}
	return true;
}

/** Mount a UI into a GpuWindow or WGPUView you created yourself. */
export function createUI(target: ViewLike, options?: UIOptions): UI {
	return new UI(target, options);
}

export type UIApp = () => unknown;

export interface UIWindowOptions extends UIOptions {
	title?: string;
	width?: number;
	height?: number;
	x?: number;
	y?: number;
	/** `hiddenInset` keeps native window controls over a full-size content view */
	titleBarStyle?: "hidden" | "hiddenInset" | "default";
	/** alpha-composited window: only what the page paints is visible */
	transparent?: boolean;
	alwaysOnTop?: boolean;
	/** page background; defaults to the light/dark canvas colour (none when transparent) */
	background?: string;
}

export interface UIWindow {
	window: GpuWindow;
	ui: UI;
	/** unmount the app and close the window */
	dispose(): void;
}

function backgroundCss(background: string | undefined, transparent: boolean): string {
	if (background) return `html { background: ${background} }`;
	if (transparent) return "html, body { background: transparent }";
	return "html { background: #fff } @media (prefers-color-scheme: dark) { html { background: #18181b } }";
}

/** Open a window and render `app` into it. */
export function createUIWindow(options: UIWindowOptions = {}, app?: UIApp): UIWindow {
	const transparent = options.transparent ?? false;
	const window = new GpuWindow({
		title: options.title ?? "Electrobun",
		frame: { x: options.x, y: options.y, width: options.width ?? 800, height: options.height ?? 600 },
		titleBarStyle: options.titleBarStyle ?? "default",
		transparent,
	});
	if (options.alwaysOnTop) window.setAlwaysOnTop(true);
	const css = [backgroundCss(options.background, transparent)].concat(options.css ?? []);
	const ui = new UI(window, { ...options, css });
	const unmount = app ? ui.render(app) : () => {};
	return {
		window,
		ui,
		dispose() {
			unmount();
			ui.destroy();
			window.close();
		},
	};
}

export interface UIView {
	view: WGPUView;
	ui: UI;
	dispose(): void;
}

/** Render `app` into an existing WGPUView (e.g. an <electrobun-ui> tag's view). */
export function createUIView(view: WGPUView, options: UIOptions & { background?: string } = {}, app?: UIApp): UIView {
	const css = [backgroundCss(options.background, !options.background)].concat(options.css ?? []);
	const ui = new UI(view, { ...options, css });
	const unmount = app ? ui.render(app) : () => {};
	return {
		view,
		ui,
		dispose() {
			unmount();
			ui.destroy();
		},
	};
}

export interface UIRootRegistration {
	/** stop accepting new mounts and dispose all live ones */
	dispose(): void;
}

/**
 * Mount `app` into every <electrobun-ui name="..."> tag with this name, in
 * any webview. Each tag instance gets its own tree; views the page removes
 * are disposed.
 */
export function registerUIRoot(
	name: string,
	options: UIOptions & { background?: string },
	app: UIApp,
): UIRootRegistration {
	const live = new Set<{ mounted: UIView; watch: ReturnType<typeof setInterval> }>();
	const onMount = (params: { id: number; name: string }) => {
		if ((params?.name ?? "") !== name) return;
		const view = WGPUView.getById(params.id);
		if (!view || view.isRemoved) return;
		const mounted = createUIView(view, options, app);
		const entry = {
			mounted,
			watch: setInterval(() => {
				if (view.isRemoved) {
					clearInterval(entry.watch);
					live.delete(entry);
					mounted.dispose();
				}
			}, 250),
		};
		live.add(entry);
	};
	electrobunEventEmitter.on("ui-tag-mount", onMount);
	return {
		dispose() {
			electrobunEventEmitter.off("ui-tag-mount", onMount);
			for (const entry of live) {
				clearInterval(entry.watch);
				entry.mounted.dispose();
			}
			live.clear();
		},
	};
}
