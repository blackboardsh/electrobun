import { describe, expect, test } from "bun:test";
import { OverlaySyncController, type Rect } from "./overlaySync";

describe("native overlay coordinate contract", () => {
	test("forwards CSS-pixel frames and masks as DIPs at fractional and 2x DPR", () => {
		const cssRect: Rect = { x: 100.25, y: 40.5, width: 800.5, height: 600.25 };
		const cssMasks: Rect[] = [
			{ x: 10.5, y: 20.25, width: 100.75, height: 50.5 },
		];
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

		try {
			for (const devicePixelRatio of [1.5, 2]) {
				Object.defineProperty(globalThis, "window", {
					configurable: true,
					value: {
						__electrobunPlatform: "windows",
						devicePixelRatio,
					},
				});

				const synchronized: Array<{ frame: Rect; masks: Rect[] }> = [];
				const element = {
					getBoundingClientRect: () => cssRect,
				} as HTMLElement;
				const controller = new OverlaySyncController(element, {
					getMasks: () => cssMasks,
					onSync: (frame, masksJson) => {
						synchronized.push({
							frame,
							masks: JSON.parse(masksJson) as Rect[],
						});
					},
				});

				controller.forceSync();

				expect(synchronized).toEqual([
					{ frame: cssRect, masks: cssMasks },
				]);
			}
		} finally {
			if (originalWindow) {
				Object.defineProperty(globalThis, "window", originalWindow);
			} else {
				Reflect.deleteProperty(globalThis, "window");
			}
		}
	});
});
