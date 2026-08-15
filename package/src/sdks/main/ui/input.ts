// Input for the UI runtime. Preferred path: native pointer events from the
// render target's WGPUView (move/down/up/wheel/enter/exit with view-local,
// top-left coordinates) — no polling, no focus gating, wheel scrolling.
// Fallback path (older native binaries / platforms without the handler):
// poll the cursor and global button bitmask as before.
//
// Keyboard arrives via native window key events in both paths.

import { enableWGPUKeyEvents, enableWGPUPointerEvents, ffi, Screen } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import type { KeyEventInfo } from "./ui";
import { pointerToViewLocal } from "./nativeLayerGeometry";

export interface InputSink {
	/** Hittable chain under the point, innermost first. */
	hitChain(x: number, y: number): number[];
	dispatchPointer(
		type: "click" | "down" | "up" | "enter" | "leave",
		target: number,
		x: number,
		y: number,
	): void;
	dispatchWheel(x: number, y: number, dx: number, dy: number): void;
	dispatchKey(e: KeyEventInfo): void;
	/** True when pressing this node should drag the host window. */
	isDragHandle(id: number): boolean;
}

export interface InputDriver {
	poll(): void;
	dispose(): void;
}

interface DragState {
	startX: number;
	startY: number;
	frameX: number;
	frameY: number;
	targetId: number;
	moved: boolean;
}

export function attachInput(
	windowId: number,
	viewId: number,
	viewOffset: () => { x: number; y: number },
	sink: InputSink,
): InputDriver {
	let hoverId = 0;
	let downId = 0;
	let drag: DragState | null = null;

	const syncHover = (x: number, y: number): number => {
		const top = sink.hitChain(x, y)[0] ?? 0;
		if (top !== hoverId) {
			if (hoverId !== 0) sink.dispatchPointer("leave", hoverId, x, y);
			if (top !== 0) sink.dispatchPointer("enter", top, x, y);
			hoverId = top;
		}
		return top;
	};

	const clearHover = () => {
		if (hoverId !== 0) {
			sink.dispatchPointer("leave", hoverId, -1, -1);
			hoverId = 0;
		}
	};

	const beginDragIfHandle = (top: number) => {
		if (top !== 0 && sink.isDragHandle(top)) {
			const point = Screen.getCursorScreenPoint();
			const frame = ffi.request.getWindowFrame({ winId: windowId });
			drag = {
				startX: point.x,
				startY: point.y,
				frameX: frame.x,
				frameY: frame.y,
				targetId: top,
				moved: false,
			};
		}
	};

	const dragMove = () => {
		if (!drag) return;
		const point = Screen.getCursorScreenPoint();
		const dx = point.x - drag.startX;
		const dy = point.y - drag.startY;
		if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
		if (drag.moved) {
			ffi.request.setWindowPosition({
				winId: windowId,
				x: drag.frameX + dx,
				y: drag.frameY + dy,
			});
		}
	};

	const endPress = (top: number, x: number, y: number) => {
		if (drag) {
			sink.dispatchPointer("up", drag.targetId, x, y);
			if (!drag.moved) sink.dispatchPointer("click", drag.targetId, x, y);
			drag = null;
			downId = 0;
			return;
		}
		if (top !== 0) sink.dispatchPointer("up", top, x, y);
		if (downId !== 0 && downId !== top) {
			// Released outside the pressed node: let it reset state.
			sink.dispatchPointer("up", downId, x, y);
		}
		if (downId !== 0 && downId === top) {
			sink.dispatchPointer("click", top, x, y);
		}
		downId = 0;
	};

	// ---- Keyboard (both paths) ----

	// Prefer view-level key events (they carry the layout's characters);
	// fall back to window key events otherwise.
	const hasNativeKeys = enableWGPUKeyEvents();
	const onViewKey = (e: any) => {
		if (!e?.isDown) return;
		sink.dispatchKey({
			keyCode: e.keyCode ?? 0,
			modifiers: e.modifiers ?? 0,
			isRepeat: Boolean(e.isRepeat),
			chars: typeof e.chars === "string" ? e.chars : undefined,
		});
	};
	const onKeyDown = (event: any) => {
		const data = event?.data ?? {};
		sink.dispatchKey({
			keyCode: data.keyCode ?? 0,
			modifiers: data.modifiers ?? 0,
			isRepeat: Boolean(data.isRepeat),
		});
	};
	if (hasNativeKeys) {
		electrobunEventEmitter.on(`wgpu-key-${viewId}`, onViewKey);
	} else {
		electrobunEventEmitter.on(`keyDown-${windowId}`, onKeyDown);
	}
	const disposeKeys = () => {
		if (hasNativeKeys) {
			electrobunEventEmitter.off(`wgpu-key-${viewId}`, onViewKey);
		} else {
			electrobunEventEmitter.off(`keyDown-${windowId}`, onKeyDown);
		}
	};

	// ---- Native pointer events path ----

	if (enableWGPUPointerEvents()) {
		const onPointer = (e: {
			type: number;
			x: number;
			y: number;
			buttonOrDx: number;
			dy: number;
		}) => {
			const { x, y } = e;
			switch (e.type) {
				case 0: {
					// move / drag-move
					if (drag) {
						dragMove();
						return;
					}
					syncHover(x, y);
					break;
				}
				case 1: {
					// down (left button only participates in UI presses)
					if (e.buttonOrDx !== 0) return;
					const top = syncHover(x, y);
					downId = top;
					sink.dispatchPointer("down", top, x, y);
					beginDragIfHandle(top);
					break;
				}
				case 2: {
					if (e.buttonOrDx !== 0) return;
					const top = drag ? drag.targetId : syncHover(x, y);
					endPress(top, x, y);
					break;
				}
				case 3: {
					sink.dispatchWheel(x, y, e.buttonOrDx, e.dy);
					break;
				}
				case 5: {
					clearHover();
					break;
				}
			}
		};
		electrobunEventEmitter.on(`wgpu-pointer-${viewId}`, onPointer);

		return {
			poll() {
				// Event-driven: nothing to poll.
			},
			dispose() {
				electrobunEventEmitter.off(`wgpu-pointer-${viewId}`, onPointer);
				disposeKeys();
			},
		};
	}

	// ---- Polling fallback ----

	let focused = true;
	let wasDown = false;

	const onFocus = () => {
		focused = true;
	};
	const onBlur = () => {
		focused = false;
		clearHover();
		wasDown = false;
		downId = 0;
	};
	electrobunEventEmitter.on(`focus-${windowId}`, onFocus);
	electrobunEventEmitter.on(`blur-${windowId}`, onBlur);

	return {
		poll() {
			// GTK reports decorated frame coordinates from getWindowFrame(), while
			// the WGPU view starts at the client area's origin. Use the native client
			// origin on Linux so titlebar/shadow extents do not skew hit testing.
			const windowOrigin = process.platform === "linux"
				? ffi.request.getWindowContentOrigin({ winId: windowId })
				: ffi.request.getWindowFrame({ winId: windowId });
			const offset = viewOffset();
			const point = Screen.getCursorScreenPoint();
			const { x, y } = pointerToViewLocal(point, windowOrigin, offset);

			if (drag) {
				const stillDown =
					focused && (Number(Screen.getMouseButtons()) & 1) === 1;
				if (stillDown) dragMove();
				else endPress(drag.targetId, x, y);
				wasDown = stillDown;
				return;
			}

			const top = syncHover(x, y);

			// Gate button state on focus so clicks on other apps or windows
			// stacked above ours don't register.
			const isDown =
				focused && (Number(Screen.getMouseButtons()) & 1) === 1;
			if (isDown && !wasDown) {
				downId = top;
				// Dispatched even for target 0: a background press blurs focus.
				sink.dispatchPointer("down", top, x, y);
				beginDragIfHandle(top);
			} else if (!isDown && wasDown) {
				endPress(top, x, y);
			}
			wasDown = isDown;
		},
		dispose() {
			electrobunEventEmitter.off(`focus-${windowId}`, onFocus);
			electrobunEventEmitter.off(`blur-${windowId}`, onBlur);
			disposeKeys();
		},
	};
}
