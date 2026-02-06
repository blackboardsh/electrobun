// Drag Region Support for custom titlebars
// Detects elements with CSS app-region: drag or .electrobun-webkit-app-region-drag class

import "./globals.d.ts";
import { send } from "./internalRpc";

function isAppRegionDrag(e: MouseEvent): boolean {
	const target = e.target as HTMLElement;
	if (!target || !target.closest) return false;

	// Check for inline style with app-region: drag
	const draggableByStyle = target.closest(
		'[style*="app-region"][style*="drag"]',
	);
	// Check for class-based drag region
	const draggableByClass = target.closest(".electrobun-webkit-app-region-drag");

	return !!(draggableByStyle || draggableByClass);
}

export function initDragRegions() {
	document.addEventListener("mousedown", (e) => {
		if (isAppRegionDrag(e)) {
			send("startWindowMove", { id: window.__electrobunWindowId });
		}
	});

	document.addEventListener("mouseup", (e) => {
		if (isAppRegionDrag(e)) {
			send("stopWindowMove", { id: window.__electrobunWindowId });
		}
	});
}
