// Automated tests for the Cottontail UI runtime (electrobun/main/ui):
// mounting a UIWindow, reactive tree updates, hit testing, and the
// native-layer elements (wgpuSurface, webview) positioned by layout.

import { defineTest, expect } from "../test-framework/types";
import type { WGPUView, BrowserView } from "electrobun/main";
import {
	createSignal,
	createUIWindow,
	hitChain,
	Prop,
	ui,
	webview,
	wgpuSurface,
} from "electrobun/main/ui";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A couple of frame ticks (tick is 8ms) plus scheduling slack.
const TICKS = 120;

export const uiRuntimeTests = [
	defineTest({
		name: "UIWindow mounts, lays out, and disposes",
		category: "Cottontail UI",
		description:
			"createUIWindow renders a retained tree sized to the window and tears down cleanly.",
		async run({ log }) {
			let headerId = 0;
			const uiWindow = await createUIWindow(
				{ title: "ui-test-mount", width: 420, height: 320 },
				() => {
					ui.column({ grow: 1 }, () => {
						headerId = ui.box({ height: 40, bg: "#222222" });
						ui.box({ grow: 1, bg: "#111111" });
					});
				},
			);
			try {
				await sleep(TICKS);
				const { tree } = uiWindow.context;
				const rootNode = tree.get(tree.root);
				expect(rootNode.w).toBeGreaterThan(0);
				expect(rootNode.h).toBeGreaterThan(0);
				const header = tree.get(headerId);
				expect(header.h).toBe(40);
				expect(header.w).toBe(rootNode.w);
				log(`root=${rootNode.w}x${rootNode.h}, header=${header.w}x${header.h}`);
			} finally {
				uiWindow.dispose();
			}
		},
	}),

	defineTest({
		name: "Reactive props update the mounted tree",
		category: "Cottontail UI",
		description:
			"A signal-backed prop becomes a fine-grained effect writing one tree prop; text thunks re-render.",
		async run({ log }) {
			const [bg, setBg] = createSignal("#111111");
			const [label, setLabel] = createSignal("before");
			let boxId = 0;
			let textId = 0;
			const uiWindow = await createUIWindow(
				{ title: "ui-test-reactive", width: 300, height: 200 },
				() => {
					boxId = ui.box({ width: 100, height: 100, bg });
					textId = ui.text(label, { size: 14 });
				},
			);
			try {
				await sleep(TICKS);
				const { tree } = uiWindow.context;
				expect(tree.getProp(boxId, Prop.Bg) >>> 0).toBe(0x111111ff);
				expect(tree.getText(textId)).toBe("before");
				setBg("#22cc44");
				setLabel("after");
				expect(tree.getProp(boxId, Prop.Bg) >>> 0).toBe(0x22cc44ff);
				expect(tree.getText(textId)).toBe("after");
				log("signal writes propagated synchronously to the tree");
			} finally {
				uiWindow.dispose();
			}
		},
	}),

	defineTest({
		name: "Hit testing resolves the innermost hittable node",
		category: "Cottontail UI",
		description:
			"hitChain over the laid-out tree returns the dispatch chain for pointer coordinates.",
		async run({ log }) {
			let buttonId = 0;
			const uiWindow = await createUIWindow(
				{ title: "ui-test-hit", width: 300, height: 200 },
				() => {
					ui.column({ grow: 1, pad: 20 }, () => {
						buttonId = ui.box({
							width: 100,
							height: 40,
							onClick: () => {},
						});
					});
				},
			);
			try {
				await sleep(TICKS);
				const { tree } = uiWindow.context;
				const chain = hitChain(tree, 25, 25);
				expect(chain[0]).toBe(buttonId);
				expect(hitChain(tree, 290, 190).length).toBe(0);
				log(`chain=${JSON.stringify(chain)}`);
			} finally {
				uiWindow.dispose();
			}
		},
	}),

	defineTest({
		name: "wgpuSurface creates a native Dawn view positioned by layout",
		category: "Cottontail UI",
		description:
			"The <electrobun-wgpu> equivalent: an anchor node that owns a real WGPUView, framed by the UI layout.",
		async run({ log }) {
			let view: WGPUView | null = null;
			const uiWindow = await createUIWindow(
				{ title: "ui-test-wgpu-surface", width: 400, height: 300 },
				() => {
					ui.column({ grow: 1, pad: 10 }, () => {
						wgpuSurface({
							width: 160,
							height: 90,
							onReady: (v) => {
								view = v;
							},
						});
					});
				},
			);
			try {
				await sleep(TICKS);
				expect(view !== null).toBe(true);
				expect(view!.frame.width).toBe(160);
				expect(view!.frame.height).toBe(90);
				expect(view!.frame.x).toBe(10);
				expect(view!.frame.y).toBe(10);
				log(`WGPUView id=${view!.id} frame=${JSON.stringify(view!.frame)}`);
			} finally {
				uiWindow.dispose();
			}
			await sleep(40);
			expect(view!.isRemoved).toBe(true);
		},
	}),

	defineTest({
		name: "webview element creates and removes an OOPIF webview",
		category: "Cottontail UI",
		description:
			"The <electrobun-webview> equivalent: an anchor node that owns a BrowserView, framed by the UI layout and torn down with its reactive scope.",
		async run({ log }) {
			let view: BrowserView | null = null;
			const uiWindow = await createUIWindow(
				{ title: "ui-test-webview", width: 400, height: 300 },
				() => {
					ui.column({ grow: 1 }, () => {
						webview({
							width: 200,
							height: 150,
							html: "<p>ui-element webview</p>",
							onReady: (v) => {
								view = v;
							},
						});
					});
				},
			);
			try {
				await sleep(TICKS);
				expect(view !== null).toBe(true);
				expect(view!.id).toBeGreaterThan(0);
				expect(view!.frame.width).toBe(200);
				log(`BrowserView id=${view!.id} frame=${JSON.stringify(view!.frame)}`);
			} finally {
				uiWindow.dispose();
			}
			await sleep(40);
			expect(view!.isRemoved).toBe(true);
		},
	}),
];
