// Drag Region Support for custom titlebars
// Detects elements with CSS app-region: drag or .electrobun-webkit-app-region-drag class

import "./globals.d.ts";
import { send } from "./internalRpc";

type PendingDrag = {
	clientX: number;
	clientY: number;
};

let pendingDrag: PendingDrag | null = null;

function isWindowsPlatform(): boolean {
	const userAgentDataPlatform =
		(navigator as Navigator & { userAgentData?: { platform?: string } })
			.userAgentData?.platform ?? "";
	const platform = navigator.platform ?? "";

	return /win/i.test(userAgentDataPlatform) || /win/i.test(platform);
}

function isAppRegionDrag(e: MouseEvent): boolean {
	const target = e.target as HTMLElement;
	if (!target || !target.closest) return false;

	// If the target is inside a no-drag region, it should not trigger window move
	if (
		target.closest(".electrobun-webkit-app-region-no-drag") ||
		target.closest('[style*="app-region"][style*="no-drag"]')
	) {
		return false;
	}

	// Check for inline style with app-region: drag
	const draggableByStyle = target.closest(
		'[style*="app-region"][style*="drag"]',
	);
	// Check for class-based drag region
	const draggableByClass = target.closest(".electrobun-webkit-app-region-drag");

	return !!(draggableByStyle || draggableByClass);
}

function clearPendingDrag() {
	pendingDrag = null;
}

export function initDragRegions() {
	const isWindows = isWindowsPlatform();

	document.addEventListener("mousedown", (e) => {
		if (e.button !== 0) {
			return;
		}

		if (!isAppRegionDrag(e)) {
			return;
		}

		if (!isWindows) {
			send("startWindowMove", { id: window.__electrobunWindowId });
			return;
		}

		pendingDrag = {
			clientX: e.clientX,
			clientY: e.clientY,
		};
	});

	if (isWindows) {
		document.addEventListener(
			"mousemove",
			(e) => {
				if (!pendingDrag) {
					return;
				}

				// Some CEF OSR paths do not reliably populate MouseEvent.buttons during
				// drag-region moves. Only cancel if the browser explicitly reports a
				// non-primary button state; otherwise trust the pending mousedown state.
				if (e.buttons !== 0 && (e.buttons & 1) === 0) {
					clearPendingDrag();
					return;
				}

				if (
					e.clientX === pendingDrag.clientX &&
					e.clientY === pendingDrag.clientY
				) {
					return;
				}

				clearPendingDrag();
				e.preventDefault();
				send("startWindowMove", { id: window.__electrobunWindowId });
			},
			true,
		);

		document.addEventListener(
			"dblclick",
			(e) => {
				if (e.button !== 0 || !isAppRegionDrag(e)) {
					return;
				}

				clearPendingDrag();
				e.preventDefault();
				send("toggleWindowMaximize", { id: window.__electrobunWindowId });
			},
			true,
		);

		window.addEventListener("blur", clearPendingDrag);
	}

	document.addEventListener("mouseup", (e) => {
		if (isWindows) {
			clearPendingDrag();
		}
		if (e.button === 0 && isAppRegionDrag(e)) {
			send("stopWindowMove", { id: window.__electrobunWindowId });
		}
	});
}
