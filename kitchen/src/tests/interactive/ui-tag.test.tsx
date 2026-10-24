/** @jsxImportSource electrobun/main/ui */
// Interactive test: <electrobun-ui> — a Electrobun UI tree mounted from the
// main process into a native Dawn layer composited over a webview, anchored
// by a custom element in the page.

import { defineTest } from "../../test-framework/types";
import { BrowserWindow } from "electrobun/main";
import { live, signal, registerUIRoot } from "electrobun/main/ui";

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
	reactive Electrobun UI tree running in the main process.</p>
	<electrobun-ui name="kitchen-overlay"></electrobun-ui>
	<p>Scroll and resize this window: the panel should track its anchor.</p>
	<div style="height: 60vh"></div>
	<p>(spacer to make the page scrollable)</p>
</main></body></html>`;

export const uiTagTests = [
	defineTest({
		name: "<electrobun-ui> overlay on a webview",
		category: "Electrobun UI",
		description:
			"registerUIRoot mounts a reactive counter into a Dawn layer anchored by an <electrobun-ui> tag inside web content.",
		instructions: [
			"A window with cream-colored web content should be open.",
			"Inside it, a dark panel renders 'Native UI in a webview' — that panel is a Dawn layer, not DOM.",
			"Click the 'Click me' button in the dark panel: the click counter should increment.",
			"Scroll the page: the panel should track the dashed anchor rectangle.",
			"Close the overlay window when you are done.",
		],
		interactive: true,
		timeout: 600000,
		async run() {
			const registration = registerUIRoot(
				"kitchen-overlay",
				{
					background: "#1b1b28",
					css: `body { margin: 0; height: 100vh; display: flex; flex-direction: column; gap: 10px;
					              align-items: center; justify-content: center; font: 13px system-ui; color: #e4e4f0 }
					      .muted { font-size: 12px; color: #8c8ca8 }
					      .count { font-size: 22px }
					      button { padding: 10px; border-radius: 8px; background: #232336; color: #e4e4f0;
					               border: 1px solid #3b3b58 }
					      button:hover { background: #2c2c44 }`,
				},
				() => {
					const [clicks, setClicks] = signal(0);
					return (
						<>
							<div class="muted">Native UI in a webview</div>
							<div class="count">{live(() => `clicks: ${clicks()}`)}</div>
							<button onClick={() => setClicks((c) => c + 1)}>Click me</button>
						</>
					);
				},
			);
			const win = new BrowserWindow({
				title: "<electrobun-ui> overlay",
				html: PAGE,
				frame: { width: 640, height: 560 },
			});

			let closed = false;
			try {
				await new Promise<void>((resolve) =>
					win.on("close", () => {
						closed = true;
						resolve();
					}),
				);
			} finally {
				registration.dispose();
				if (!closed) win.close();
			}
		},
	}),
];
