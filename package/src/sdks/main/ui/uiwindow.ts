// Mounting a UI tree onto a Dawn target. Two shapes:
//
// - createUIWindow: a GpuWindow whose whole content is the retained UI tree —
//   app chrome without a webview.
// - createUIView: a UI tree rendered into an existing WGPUView composited
//   inside any window (e.g. a view created by an <electrobun-wgpu>-style tag
//   over a webview) — UI layered on top of web content.
//
// Both are invalidation-driven: the frame tick is a cheap input poll unless
// something marked the tree dirty.

import { GpuWindow } from "../core/GpuWindow";
import type { WGPUView } from "../core/WGPUView";
import { batch, createRoot, inert } from "./reactive";
import { Prop } from "./tree";
import { hitChain, scrollTargetAt } from "./hit";
import { computeLayout } from "./layout";
import { paint } from "./paint";
import { createUiRenderer } from "./renderer";
import { attachInput } from "./input";
import { collectWebviewAnchorMasks } from "./nativeLayerGeometry";
import { tryEnableNativeText } from "./text";
import { isUIElement, type UIElement } from "./jsx-runtime";
import { ffi, nativeText } from "../proc/native";
import {
	createUiContext,
	withUiContext,
	type AnchorRect,
	type KeyEventInfo,
	type PointerEventInfo,
	type UiContext,
} from "./ui";
import electrobunEventEmitter from "../events/eventEmitter";
import { createWindowMountLifecycle } from "./windowMountLifecycle";
import { runCleanupSteps } from "./cleanupSteps";
import { createViewMountLifecycle } from "./viewMountLifecycle";

export interface UIMountOptions {
	/** Painted every frame behind the tree. */
	background?: string;
	/** Frame tick in ms: input poll always, render only when dirty. */
	tickMs?: number;
}

export interface UIWindowOptions extends UIMountOptions {
	title: string;
	width: number;
	height: number;
	titleBarStyle?: "hidden" | "hiddenInset" | "default";
	/**
	 * Transparent window: pair with an alpha background (e.g. "#00000000")
	 * and a rounded root box for a floating-panel look.
	 */
	transparent?: boolean;
	alwaysOnTop?: boolean;
}

export interface UIMount {
	context: UiContext;
	dispose(): void;
}

export interface UIWindow extends UIMount {
	window: GpuWindow;
	/** Settles after a natural close is observed or disposal requests close. */
	readonly closed: Promise<void>;
	isClosed(): boolean;
}

export interface UIView extends UIMount {
	view: WGPUView;
}

interface MountTarget {
	renderTarget: GpuWindow | WGPUView;
	/** WGPUView id whose native pointer events drive this mount. */
	viewId: number;
	windowId: number;
	getSize(): { width: number; height: number };
	/** Offset of the render target inside the window's content area. */
	viewOffset(): { x: number; y: number };
	/** False once the underlying native target is gone; ticks become no-ops. */
	isAlive?(): boolean;
	/** False while hidden: skip input polling and rendering until shown. */
	isVisible?(): boolean;
	/** Whether windowDrag nodes may move the host window (window mounts). */
	allowWindowDrag?: boolean;
}

export type UIApp = () => void | UIElement;

async function mount(
	target: MountTarget,
	options: UIMountOptions,
	app: UIApp,
): Promise<{ context: UiContext; stop: () => void }> {
	const background = options.background ?? "#141420";
	// System-font text when the native wrapper provides it (macOS); the
	// built-in bitmap font otherwise.
	tryEnableNativeText(nativeText.available() ? nativeText : null);
	const renderer = await createUiRenderer(
		target.renderTarget,
		background,
		target.getSize(),
	);
	if (target.isAlive && !target.isAlive()) {
		const error = new Error("UI mount target closed during renderer initialization");
		try {
			renderer.dispose();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"UI mount target closed and renderer cleanup failed",
			);
		}
		throw error;
	}
	let ctx: UiContext;
	try {
		ctx = createUiContext();
	} catch (error) {
		try {
			renderer.dispose();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to create the UI context and clean up its renderer",
			);
		}
		throw error;
	}
	ctx.windowId = target.windowId;
	const { tree } = ctx;

	let disposeRoot = () => {};
	try {
		createRoot((dispose) => {
			disposeRoot = dispose;
			withUiContext(ctx, () => {
				const result = app();
				// JSX apps return a lazy element; the builder API returns nothing.
				if (isUIElement(result)) result.create();
			});
		});
	} catch (error) {
		try {
			runCleanupSteps([disposeRoot, renderer.dispose]);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to mount and clean up the UI tree",
			);
		}
		throw error;
	}

	const pointerHandler = (
		type: "click" | "down" | "up" | "enter" | "leave",
		targetId: number,
		x: number,
		y: number,
	) => {
		if (type === "down") {
			// Click-to-focus: innermost focusable ancestor of the hit, or blur
			// (targetId 0 = background click).
			let id = targetId;
			while (id !== 0 && tree.has(id)) {
				if (tree.getProp(id, Prop.Focusable) === 1) break;
				id = tree.parentOf(id);
			}
			ctx.setFocused(id);
		} else if (type === "enter") {
			ctx.setHovered(targetId);
		} else if (type === "leave") {
			if (inert(ctx.hoveredId) === targetId) ctx.setHovered(0);
		}
		const handlers = ctx.handlers.get(targetId);
		if (!handlers) return;
		const event: PointerEventInfo = { x, y, target: targetId };
		const fn =
			type === "click"
				? handlers.onClick
				: type === "down"
					? handlers.onPointerDown
					: type === "up"
						? handlers.onPointerUp
						: type === "enter"
							? handlers.onPointerEnter
							: handlers.onPointerLeave;
		if (fn) batch(() => fn(event));
	};

	let input: ReturnType<typeof attachInput>;
	try {
		input = attachInput(target.windowId, target.viewId, target.viewOffset, {
			hitChain: (x, y) => hitChain(tree, x, y),
			dispatchWheel: (x, y, dx, dy) => {
				const targetId = scrollTargetAt(tree, x, y);
				if (targetId === 0) return;
				const node = tree.get(targetId);
				const column = tree.getProp(targetId, Prop.Dir) === 1;
				const delta = column ? dy : dx;
				const viewport = column ? node.h : node.w;
				const max = Math.max(0, node.contentMain - viewport);
				const current = tree.getProp(targetId, Prop.Scroll);
				// Natural scrolling: positive delta scrolls content down/right.
				const next = Math.max(0, Math.min(max, current - delta));
				tree.setProp(targetId, Prop.Scroll, next);
			},
			isDragHandle: (id) => {
				if (!target.allowWindowDrag) return false;
				for (let n = id; n !== 0 && tree.has(n); n = tree.parentOf(n)) {
					if (tree.getProp(n, Prop.WindowDrag) === 1) return true;
				}
				return false;
			},
			dispatchPointer: pointerHandler,
			dispatchKey: (e: KeyEventInfo) => {
				batch(() => {
					// Focused node first, bubbling through ancestors; a handler
					// returning true stops propagation to the window-level handlers.
					let id = inert(ctx.focusedId);
					while (id !== 0 && tree.has(id)) {
						const handler = ctx.handlers.get(id)?.onKeyDown;
						if (handler && handler(e) === true) return;
						id = tree.parentOf(id);
					}
					for (const handler of ctx.keyHandlers) handler(e);
				});
			},
		});
	} catch (error) {
		try {
			runCleanupSteps([disposeRoot, renderer.dispose]);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to attach input and clean up the UI mount",
			);
		}
		throw error;
	}

	let lastWidth = 0;
	let lastHeight = 0;
	const lastAnchorRects = new Map<number, AnchorRect>();
	let lastWebviewMaskKey: string | null = null;
	const applyWebviewMasks = (
		width: number,
		height: number,
		masks = collectWebviewAnchorMasks(ctx),
	) => {
		if (process.platform !== "linux") return;

		const offset = target.viewOffset();
		const masksJson = JSON.stringify(masks);
		if (masks.length === 0) {
			if (lastWebviewMaskKey === null) return;
			ffi.request.resizeWGPUView({
				id: target.viewId,
				frame: { x: offset.x, y: offset.y, width, height },
				masks: masksJson,
			});
			lastWebviewMaskKey = null;
			return;
		}

		const key = `${offset.x},${offset.y},${width},${height}:${masksJson}`;
		if (key === lastWebviewMaskKey) return;
		ffi.request.resizeWGPUView({
			id: target.viewId,
			frame: { x: offset.x, y: offset.y, width, height },
			masks: masksJson,
		});
		lastWebviewMaskKey = key;
	};
	const clearWebviewMasks = () => {
		if (process.platform !== "linux" || lastWebviewMaskKey === null) return;
		const { width, height } = target.getSize();
		applyWebviewMasks(width, height, []);
	};
	const syncAnchors = () => {
		for (const [id, onFrame] of ctx.anchors) {
			if (!tree.has(id)) {
				lastAnchorRects.delete(id);
				continue;
			}
			const node = tree.get(id);
			const rect: AnchorRect = {
				x: node.x,
				y: node.y,
				width: node.w,
				height: node.h,
			};
			const last = lastAnchorRects.get(id);
			if (
				!last ||
				last.x !== rect.x ||
				last.y !== rect.y ||
				last.width !== rect.width ||
				last.height !== rect.height
			) {
				lastAnchorRects.set(id, rect);
				onFrame(rect);
			}
		}
	};

	const renderFrame = (width: number, height: number) => {
		if (width <= 0 || height <= 0) return;
		renderer.resize(width, height);
		computeLayout(tree, width, height);
		syncAnchors();
		applyWebviewMasks(width, height);
		renderer.render(paint(tree), width, height);
	};

	// A hidden window skips ticks entirely, so nothing marks the tree dirty
	// while it is hidden. Track the visibility edge and force a frame on
	// re-show; otherwise the swapchain keeps presenting its pre-hide contents
	// until some input or state change happens to dirty the tree.
	let wasVisible = true;
	const tick = () => {
		if (target.isAlive && !target.isAlive()) return;
		if (target.isVisible && !target.isVisible()) {
			wasVisible = false;
			return;
		}
		const becameVisible = !wasVisible;
		wasVisible = true;
		input.poll();
		const { width, height } = target.getSize();
		const sizeChanged = width !== lastWidth || height !== lastHeight;
		if (tree.takeDirty() || sizeChanged || becameVisible) {
			lastWidth = width;
			lastHeight = height;
			renderFrame(width, height);
		}
	};
	let timer: ReturnType<typeof setInterval>;
	try {
		timer = setInterval(tick, options.tickMs ?? 8);
	} catch (error) {
		try {
			runCleanupSteps([input.dispose, disposeRoot, renderer.dispose]);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to schedule and clean up the UI mount",
			);
		}
		throw error;
	}

	let stopped = false;
	return {
		context: ctx,
		stop() {
			if (stopped) return;
			stopped = true;
			runCleanupSteps([
				() => clearInterval(timer),
				input.dispose,
				clearWebviewMasks,
				disposeRoot,
				renderer.dispose,
			]);
		},
	};
}

export async function createUIWindow(
	options: UIWindowOptions,
	app: UIApp,
): Promise<UIWindow> {
	const win = new GpuWindow({
		title: options.title,
		frame: { width: options.width, height: options.height },
		// hiddenInset keeps the window frame equal to the content area, so
		// cursor-to-local math needs no title-bar offset.
		titleBarStyle: options.titleBarStyle ?? "hiddenInset",
		transparent: options.transparent ?? false,
	});
	const closeEvent = `close-${win.id}`;
	const lifecycle = createWindowMountLifecycle({
		subscribe: (handler) => electrobunEventEmitter.on(closeEvent, handler),
		unsubscribe: (handler) => electrobunEventEmitter.off(closeEvent, handler),
		close: () => win.close(),
		reportError: (error) => {
			console.error("Failed to stop a UI mount during window close", error);
		},
	});

	try {
		if (options.alwaysOnTop && !lifecycle.isClosed()) {
			win.setAlwaysOnTop(true);
		}

		const mounted = await mount(
			{
				renderTarget: win,
				viewId: win.wgpuViewId,
				windowId: win.id,
				getSize: () => win.getSize(),
				viewOffset: () => ({ x: 0, y: 0 }),
				isAlive: () => !lifecycle.isClosed(),
				// Hidden windows skip layout/paint/GPU entirely (e.g. a focused
				// textInput's caret blink must not keep a hidden palette rendering).
				isVisible: () => win.isVisible(),
				allowWindowDrag: true,
			},
			options,
			app,
		);
		lifecycle.attach(mounted.stop);

		return {
			window: win,
			context: mounted.context,
			closed: lifecycle.closed,
			isClosed: lifecycle.isClosed,
			dispose: lifecycle.dispose,
		};
	} catch (error) {
		try {
			lifecycle.dispose();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to create and clean up the UI window",
			);
		}
		throw error;
	}
}

/**
 * Mount a UI tree into an existing WGPUView. The view's frame (tracked via
 * the JS wrapper) supplies size and pointer offset; pair it with an
 * <electrobun-wgpu>-style tag to layer reactive native UI over a webview.
 * Note: frames moved natively without updating the JS wrapper (tag overlay
 * sync) are not observed yet — production work alongside native pointer
 * events.
 */
export async function createUIView(
	view: WGPUView,
	options: UIMountOptions,
	app: UIApp,
): Promise<UIView> {
	if (view.isRemoved) {
		throw new Error("Cannot mount UI into a removed WGPUView");
	}
	const lifecycle = createViewMountLifecycle({
		subscribeBeforeRemove: (handler) => view.onBeforeRemove(handler),
		reportError: (error) => {
			console.error("Failed to stop a UI mount before view removal", error);
		},
	});

	try {
		const mounted = await mount(
			{
				renderTarget: view,
				viewId: view.id,
				windowId: view.windowId,
				getSize: () => ({
					width: view.frame.width,
					height: view.frame.height,
				}),
				viewOffset: () => ({ x: view.frame.x, y: view.frame.y }),
				isAlive: () => !view.isRemoved,
			},
			options,
			app,
		);
		lifecycle.attach(mounted.stop);

		return {
			view,
			context: mounted.context,
			dispose: lifecycle.dispose,
		};
	} catch (error) {
		try {
			lifecycle.dispose();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to create and clean up the UI view",
			);
		}
		throw error;
	}
}
