// Interactive Webview Cleanup Test

import { defineTest } from "../../test-framework/types";
import {
	BrowserView,
	BrowserWindow,
	Screen,
	type RPCSchema,
} from "electrobun/main";
import { createWebviewCleanupLifecycle } from "./webview-cleanup-lifecycle";

type BunnyRPC = {
	bun: RPCSchema<{
		requests: {};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			cursorMove: {
				screenX: number;
				screenY: number;
				winX: number;
				winY: number;
				winW: number;
				winH: number;
			};
		};
	}>;
};

export const webviewCleanupTests = [
	defineTest({
		name: "Webview process cleanup on window close",
		category: "Webview Cleanup (Interactive)",
		description:
			"Spawns 10 bunny windows, closes all of them, and verifies renderer processes are cleaned up",
		instructions: [
			"This test spawns 10 transparent bunny windows, then closes all of them.",
			"After closing, check Activity Monitor for WebContent/renderer processes.",
			"No renderer processes should remain after all windows are closed.",
			"The test completes automatically once all windows are closed.",
		],
		interactive: true,
		timeout: 120000,
		async run({ log }) {
			const display = Screen.getPrimaryDisplay();
			const workArea = display.workArea;

			function randomFrame() {
				const size = 100 + Math.floor(Math.random() * 200);
				const x =
					workArea.x +
					Math.floor(Math.random() * Math.max(0, workArea.width - size));
				const y =
					workArea.y +
					Math.floor(Math.random() * Math.max(0, workArea.height - size));
				return { width: size, height: size, x, y };
			}

			await new Promise<void>((resolve, reject) => {
				const closeQueue: BrowserWindow<any>[] = [];
				const ready = new Set<BrowserWindow>();
				const MAX_BUNNIES = 10;
				const lifecycle = createWebviewCleanupLifecycle(resolve, reject);
				let spawned = 0;
				let closed = 0;
				let closingStarted = false;
				let closeDeadlineScheduled = false;

				function completeIfAllClosed() {
					if (
						closingStarted &&
						spawned === MAX_BUNNIES &&
						lifecycle.getOpenWindowCount() === 0
					) {
						log(`Closed all ${closed} windows.`);
						log(
							"Check Activity Monitor — no WebContent/renderer processes should remain."
						);
						log("Test complete.");
						lifecycle.complete();
					}
				}

				function spawnBunny() {
					const rpc = BrowserView.defineRPC<BunnyRPC>({
						maxRequestTime: 5000,
						handlers: {
							requests: {},
							messages: {},
						},
					});

					const win = new BrowserWindow({
						title: `Bunny ${spawned + 1}`,
						url: "views://playgrounds/webview-cleanup/index.html",
						titleBarStyle: "hidden",
						transparent: true,
						frame: randomFrame(),
						rpc,
					});
					lifecycle.trackWindow(win);
					closeQueue.push(win);
					spawned++;

					win.on("close", () => {
						lifecycle.guard(() => {
							if (!lifecycle.markWindowClosed(win)) return;
							ready.delete(win);
							closed++;
							log(`Closed bunny (${closed}/${MAX_BUNNIES})`);
							completeIfAllClosed();
						});
					});

					win.setAlwaysOnTop(true);

					win.webview.on("dom-ready", () => {
						lifecycle.guard(() => {
							if (!lifecycle.hasWindow(win)) return;
							ready.add(win);
							const cursor = Screen.getCursorScreenPoint();
							const frame = win.getFrame();
							(win.webview.rpc as any)?.send?.cursorMove({
								screenX: cursor.x,
								screenY: cursor.y,
								winX: frame.x,
								winY: frame.y,
								winW: frame.width,
								winH: frame.height,
							});
						});
					});

					log(`Spawned bunny ${spawned}/${MAX_BUNNIES}`);
				}

				function spawnLoop() {
					if (spawned >= MAX_BUNNIES) {
						closingStarted = true;
						log("All bunnies spawned. Closing all of them...");
						lifecycle.schedule(closeLoop, 1000);
						return;
					}
					spawnBunny();
					lifecycle.schedule(
						spawnLoop,
						200 + Math.floor(Math.random() * 300),
					);
				}

				function closeLoop() {
					let win = closeQueue.pop();
					while (win && !lifecycle.hasWindow(win)) win = closeQueue.pop();

					if (!win) {
						completeIfAllClosed();
						if (lifecycle.isActive() && !closeDeadlineScheduled) {
							closeDeadlineScheduled = true;
							lifecycle.schedule(() => {
								throw new Error(
									`${lifecycle.getOpenWindowCount()} bunny window(s) did not emit a close event`,
								);
							}, 10000);
						}
						return;
					}

					win.close();
					if (lifecycle.isActive()) {
						lifecycle.schedule(
							closeLoop,
							200 + Math.floor(Math.random() * 300),
						);
					}
				}

				lifecycle.schedule(() => {
					throw new Error("Webview cleanup sequence timed out after 120 seconds");
				}, 120000);
				lifecycle.guard(spawnLoop);
			});
		},
	}),
];
