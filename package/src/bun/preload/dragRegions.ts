// Drag Region Support for custom titlebars
// Detects elements with CSS app-region: drag or .electrobun-webkit-app-region-drag class

import "./globals.d.ts";
import { send } from "./internalRpc";

function getAppRegionValue(element: HTMLElement): string {
	const inlineRegion =
		element.style.getPropertyValue("-webkit-app-region") ||
		element.style.getPropertyValue("app-region");
	const computedStyle = window.getComputedStyle(element);
	const computedRegion =
		computedStyle.getPropertyValue("-webkit-app-region") ||
		computedStyle.getPropertyValue("app-region");

	return (inlineRegion || computedRegion).trim().toLowerCase();
}

function isAppRegionDrag(e: MouseEvent): boolean {
	const target = e.target;
	if (!(target instanceof HTMLElement)) return false;

	let current: HTMLElement | null = target;
	while (current) {
		if (current.classList.contains("electrobun-webkit-app-region-no-drag")) {
			return false;
		}
		if (current.classList.contains("electrobun-webkit-app-region-drag")) {
			return true;
		}

		const region = getAppRegionValue(current);
		if (region === "no-drag") {
			return false;
		}
		if (region === "drag") {
			return true;
		}

		current = current.parentElement;
	}

	return false;
}

export function initDragRegions() {
	document.addEventListener("mousedown", (e) => {
		if (e.button !== 0) return;
		if (isAppRegionDrag(e)) {
			e.preventDefault();
			send("startWindowMove", { id: window.__electrobunWindowId });
		}
	}, true);

	document.addEventListener("mouseup", (e) => {
		if (e.button !== 0) return;
		if (isAppRegionDrag(e)) {
			send("stopWindowMove", { id: window.__electrobunWindowId });
		}
	}, true);
}
