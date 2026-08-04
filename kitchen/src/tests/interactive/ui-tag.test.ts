// Interactive test: <electrobun-ui> — a Cottontail UI tree mounted from the
// main process into a native Dawn layer composited over a webview, anchored
// by a custom element in the page.

import { defineTest } from "../../test-framework/types";
import { BrowserWindow } from "electrobun/main";
import {
	createSignal,
	registerUIRoot,
	ui,
} from "electrobun/main/ui";

const PAGE = `<!doctype html><html><head><style>
	body { background: #fdf6e3; color: #333; font-family: -apple-system, sans-serif;
	       margin: 0; padding: 24px; }
	main { max-width: 560px; margin: 0 auto; }
	electrobun-ui { width: 260px; height: 150px; margin: 16px auto; display: block;
	                border: 1px dashed #b58900; }
	p { line-height: 1.5; }
</style></head><body><main>
	<h2>Web content (webview)</h2>
	<p>The framed panel below is <b>not</b> DOM: it is an
	&lt;electrobun-ui&gt; tag anchoring a native Dawn layer whose content is a
	reactive Cottontail UI tree running in the main process.</p>
	<electrobun-ui name="kitchen-overlay"></electrobun-ui>
	<p>Scroll and resize this window: the panel should track its anchor.</p>
	<div style="height: 60vh"></div>
	<p>(spacer to make the page scrollable)</p>
</main></body></html>`;

export const uiTagTests = [
	defineTest({
		name: "<electrobun-ui> overlay on a webview",
		category: "Cottontail UI",
		description:
			"registerUIRoot mounts a reactive counter into a Dawn layer anchored by an <electrobun-ui> tag inside web content.",
		interactive: true,
		async run({ showInstructions, waitForUserVerification, log }) {
			const registration = registerUIRoot(
				"kitchen-overlay",
				{ background: "#1b1b28" },
				() => {
					const [clicks, setClicks] = createSignal(0);
					ui.column(
						{ grow: 1, pad: 14, gap: 10, justify: "center", align: "center" },
						() => {
							ui.text("Native UI in a webview", {
								size: 12,
								color: "#8c8ca8",
							});
							ui.text(() => `clicks: ${clicks()}`, {
								size: 22,
								color: "#e4e4f0",
							});
							ui.box(
								{
									pad: 10,
									radius: 8,
									bg: "#232336",
									border: 1,
									borderColor: "#3b3b58",
									onClick: () => setClicks((c) => c + 1),
								},
								() => {
									ui.text("Click me", { size: 13, color: "#e4e4f0" });
								},
							);
						},
					);
				},
			);

			const win = new BrowserWindow({
				title: "<electrobun-ui> overlay",
				html: PAGE,
				frame: { width: 640, height: 560 },
			});

			try {
				await showInstructions([
					"A window with cream-colored web content should be open.",
					"Inside it, a dark panel renders 'Native UI in a webview' — that panel is a Dawn layer, not DOM.",
					"Click the 'Click me' button in the dark panel: the click counter should increment.",
					"Scroll the page: the panel should track the dashed anchor rectangle.",
				]);
				const result = await waitForUserVerification();
				log(`user verdict: ${result.action}`);
				if (result.action === "fail") {
					throw new Error(result.notes || "User reported failure");
				}
			} finally {
				registration.dispose();
				win.close();
			}
		},
	}),
];
