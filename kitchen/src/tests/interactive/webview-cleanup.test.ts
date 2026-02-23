// Interactive Webview Cleanup Test

import { defineTest } from "../../test-framework/types";
import {
	BrowserView,
	BrowserWindow,
	Screen,
	type RPCSchema,
} from "electrobun/bun";

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
		interactive: true,
		timeout: 120000,
		async run({ log, showInstructions }) {
			await showInstructions([
				"This test spawns 10 transparent bunny windows, then closes all of them.",
				"After closing, check Activity Monitor for WebContent/renderer processes.",
				"No renderer processes should remain after all windows are closed.",
				"The test completes automatically once all windows are closed.",
			]);

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
				const windows: BrowserWindow[] = [];
				const ready = new Set<BrowserWindow>();
				const MAX_BUNNIES = 10;

				function spawnBunny() {
					const rpc = BrowserView.defineRPC<BunnyRPC>({
						maxRequestTime: 5000,
						handlers: {
							requests: {},
							messages: {},
						},
					});

					const win = new BrowserWindow({
						title: `Bunny ${windows.length + 1}`,
						url: "views://playgrounds/webview-cleanup/index.html",
						titleBarStyle: "hidden",
						transparent: true,
						passthrough: true,
						frame: randomFrame(),
						rpc,
					});

					win.setAlwaysOnTop(true);

					win.webview.on("dom-ready", () => {
						ready.add(win);
						try {
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
						} catch {}
					});

					win.on("close", () => {
						ready.delete(win);
					});

					windows.push(win);
					log(`Spawned bunny ${windows.length}/${MAX_BUNNIES}`);
				}

				function spawnLoop() {
					if (windows.length >= MAX_BUNNIES) {
						log("All bunnies spawned. Closing all of them...");
						setTimeout(closeLoop, 1000);
						return;
					}
					spawnBunny();
					setTimeout(spawnLoop, 200 + Math.floor(Math.random() * 300));
				}

				let closed = 0;

				function closeLoop() {
					if (windows.length === 0) {
						log(`Closed all ${closed} windows.`);
						log(
							"Check Activity Monitor — no WebContent/renderer processes should remain."
						);
						log("Test complete.");
						resolve();
						return;
					}
					const win = windows.pop()!;
					ready.delete(win);
					win.close();
					closed++;
					log(`Closed bunny (${closed}/${MAX_BUNNIES})`);
					setTimeout(closeLoop, 200 + Math.floor(Math.random() * 300));
				}

				spawnLoop();
			});
		},
	}),
];
