// Drag Region Support for custom titlebars
// Detects elements with CSS app-region: drag or .electrobun-webkit-app-region-drag class

import "./globals.d.ts";
import { send } from "./internalRpc";

const DRAG_THRESHOLD_PX = 4;

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

function getClosestElement(target: EventTarget | null): HTMLElement | null {
	if (target instanceof HTMLElement) {
		return target;
	}

	if (target instanceof Node && target.parentElement) {
		return target.parentElement;
	}

	return null;
}

function getAppRegionValue(element: HTMLElement): string {
	const computedStyle = window.getComputedStyle(element);
	return (
		computedStyle.getPropertyValue("-webkit-app-region") ||
		computedStyle.getPropertyValue("app-region") ||
		""
	).trim();
}

function findDragRegion(target: EventTarget | null): HTMLElement | null {
	let element = getClosestElement(target);

	while (element) {
		if (
			element.classList.contains("electrobun-webkit-app-region-no-drag") ||
			getAppRegionValue(element) === "no-drag"
		) {
			return null;
		}

		if (
			element.classList.contains("electrobun-webkit-app-region-drag") ||
			getAppRegionValue(element) === "drag"
		) {
			return element;
		}

		element = element.parentElement;
	}

	return null;
}

function clearPendingDrag() {
	pendingDrag = null;
}

export function initDragRegions() {
	const isWindows = isWindowsPlatform();

	document.addEventListener(
		"mousedown",
		(e) => {
			if (e.button !== 0 || !findDragRegion(e.target)) {
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
			e.preventDefault();
		},
		true,
	);

	if (isWindows) {
		document.addEventListener(
			"mousemove",
			(e) => {
				if (!pendingDrag || (e.buttons & 1) === 0) {
					return;
				}

				const movedX = Math.abs(e.clientX - pendingDrag.clientX);
				const movedY = Math.abs(e.clientY - pendingDrag.clientY);
				if (movedX < DRAG_THRESHOLD_PX && movedY < DRAG_THRESHOLD_PX) {
					return;
				}

				clearPendingDrag();
				e.preventDefault();
				send("startWindowMove", { id: window.__electrobunWindowId });
			},
			true,
		);
	}

	document.addEventListener(
		"mouseup",
		() => {
			clearPendingDrag();
			send("stopWindowMove", { id: window.__electrobunWindowId });
		},
		true,
	);

	if (isWindows) {
		document.addEventListener(
			"dblclick",
			(e) => {
				if (e.button !== 0 || !findDragRegion(e.target)) {
					return;
				}

				clearPendingDrag();
				e.preventDefault();
				send("toggleWindowMaximize", { id: window.__electrobunWindowId });
			},
			true,
		);
	}

	window.addEventListener("blur", clearPendingDrag);
}
