// Interactive test: Warren's DOM renderer (electrobun/browser/ui) running
// inside a real webview. The playground page runs a self-test on load that
// verifies keyed reconciliation against real DOM node identity, Portal
// mounting, and cleanup — plus manual widgets to poke.

import { defineTest } from "../../test-framework/types";
import { BrowserWindow } from "electrobun/main";

export const uiDomTests = [
	defineTest({
		name: "Warren DOM renderer in a webview",
		category: "Cottontail UI",
		description:
			"electrobun/browser/ui renders JSX into real DOM: signals, memo, keyed For, Portal, input. The page's self-test banner must show PASS.",
		instructions: [
			"A webview window opened rendering Warren via the DOM renderer.",
			"1. The Self-test section must show a green PASS banner.",
			"2. Counter buttons update the number (and its memo) instantly.",
			"3. Typing in the input echoes 'hello, <name>'.",
			"4. Reverse/Add/Drop reorder the keyed list; top row highlights.",
			"5. 'Open modal' shows a Portal card; Close removes it.",
			"Close the playground window when you are done.",
		],
		interactive: true,
		timeout: 600000,
		async run() {
			const win = new BrowserWindow({
				title: "Warren DOM playground",
				frame: { x: 220, y: 120, width: 720, height: 820 },
				url: "views://playgrounds/warren-dom/index.html",
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
				if (!closed) win.close();
			}
		},
	}),
];
