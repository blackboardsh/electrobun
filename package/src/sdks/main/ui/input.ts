// Input for the prototype: poll the cursor and global mouse-button bitmask,
// edge-detect presses, and translate window keyboard events. Works against
// any native window id (GpuWindow or BrowserWindow host), with an optional
// offset when the UI tree renders inside a child view rather than the whole
// window. Production work is native pointer/move/button/wheel events on
// WGPUView — this file is the part that gets replaced, which is why it stays
// behind a small interface.

import { ffi, Screen } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import type { KeyEventInfo } from "./ui";

export interface InputSink {
	/** Hittable chain under the point, innermost first. */
	hitChain(x: number, y: number): number[];
	dispatchPointer(
		type: "click" | "down" | "up" | "enter" | "leave",
		target: number,
		x: number,
		y: number,
	): void;
	dispatchKey(e: KeyEventInfo): void;
	/** True when pressing this node should drag the host window. */
	isDragHandle(id: number): boolean;
}

export interface InputDriver {
	poll(): void;
	dispose(): void;
}

export function attachInput(
	windowId: number,
	viewOffset: () => { x: number; y: number },
	sink: InputSink,
): InputDriver {
	let focused = true;
	let hoverId = 0;
	let downId = 0;
	let wasDown = false;
	let drag: {
		startX: number;
		startY: number;
		frameX: number;
		frameY: number;
		targetId: number;
		moved: boolean;
	} | null = null;

	const onFocus = () => {
		focused = true;
	};
	const onBlur = () => {
		focused = false;
		if (hoverId !== 0) {
			sink.dispatchPointer("leave", hoverId, -1, -1);
			hoverId = 0;
		}
		wasDown = false;
		downId = 0;
	};
	const onKeyDown = (event: any) => {
		const data = event?.data ?? {};
		sink.dispatchKey({
			keyCode: data.keyCode ?? 0,
			modifiers: data.modifiers ?? 0,
			isRepeat: Boolean(data.isRepeat),
		});
	};

	electrobunEventEmitter.on(`focus-${windowId}`, onFocus);
	electrobunEventEmitter.on(`blur-${windowId}`, onBlur);
	electrobunEventEmitter.on(`keyDown-${windowId}`, onKeyDown);

	return {
		poll() {
			const frame = ffi.request.getWindowFrame({ winId: windowId });
			const offset = viewOffset();
			const point = Screen.getCursorScreenPoint();
			const x = point.x - frame.x - offset.x;
			const y = point.y - frame.y - offset.y;

			// Window drag in progress: move the window with the cursor and
			// suppress normal dispatch until release. A press that never moved
			// still delivers a click, so drag handles stay clickable.
			if (drag) {
				const stillDown =
					focused && (Number(Screen.getMouseButtons()) & 1) === 1;
				if (stillDown) {
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
				} else {
					sink.dispatchPointer("up", drag.targetId, x, y);
					if (!drag.moved) {
						sink.dispatchPointer("click", drag.targetId, x, y);
					}
					drag = null;
					downId = 0;
				}
				wasDown = stillDown;
				return;
			}

			const top = sink.hitChain(x, y)[0] ?? 0;
			if (top !== hoverId) {
				if (hoverId !== 0) sink.dispatchPointer("leave", hoverId, x, y);
				if (top !== 0) sink.dispatchPointer("enter", top, x, y);
				hoverId = top;
			}

			// Gate button state on focus so clicks on other apps or windows
			// stacked above ours don't register.
			const isDown =
				focused && (Number(Screen.getMouseButtons()) & 1) === 1;
			if (isDown && !wasDown) {
				downId = top;
				// Dispatched even for target 0: a background press blurs focus.
				sink.dispatchPointer("down", top, x, y);
				if (top !== 0 && sink.isDragHandle(top)) {
					drag = {
						startX: point.x,
						startY: point.y,
						frameX: frame.x,
						frameY: frame.y,
						targetId: top,
						moved: false,
					};
				}
			} else if (!isDown && wasDown) {
				if (top !== 0) sink.dispatchPointer("up", top, x, y);
				if (downId !== 0 && downId !== top) {
					// Released outside the pressed node: let it reset state.
					sink.dispatchPointer("up", downId, x, y);
				}
				if (downId !== 0 && downId === top) {
					sink.dispatchPointer("click", top, x, y);
				}
				downId = 0;
			}
			wasDown = isDown;
		},
		dispose() {
			electrobunEventEmitter.off(`focus-${windowId}`, onFocus);
			electrobunEventEmitter.off(`blur-${windowId}`, onBlur);
			electrobunEventEmitter.off(`keyDown-${windowId}`, onKeyDown);
		},
	};
}
