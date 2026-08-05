// Interactive test: the Cottontail UI demo window — reactive counter card
// rendered by Dawn with embedded native-layer elements (wgpuSurface +
// OOPIF webview) positioned by the UI layout.

import { defineTest } from "../../test-framework/types";
import { webgpu } from "electrobun/main";
import {
	$,
	createEffect,
	createMemo,
	createSignal,
	onKey,
	parseColor,
	ui,
	webview,
	wgpuSurface,
	createUIWindow,
	type UIWindow,
} from "electrobun/main/ui";

function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
		return Math.round(255 * c)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

async function openDemoWindow(): Promise<UIWindow> {
	const [count, setCount] = createSignal(0);
	const accent = createMemo(() => hslToHex(260 + count() * 14, 0.72, 0.68));

	function Button(label: string, onClick: () => void) {
		const [hover, setHover] = createSignal(false);
		const [active, setActive] = createSignal(false);
		ui.box(
			{
				width: 90,
				pad: 12,
				radius: 9,
				justify: "center",
				bg: $(() =>
					active() ? "#2c2c44" : hover() ? "#232336" : "#1b1b28"),
				border: 1,
				borderColor: $(() => (hover() ? accent() : "#262638")),
				onClick,
				onPointerEnter: () => setHover(true),
				onPointerLeave: () => {
					setHover(false);
					setActive(false);
				},
				onPointerDown: () => setActive(true),
				onPointerUp: () => setActive(false),
			},
			() => {
				ui.text(label, { size: 14, color: "#e4e4f0" });
			},
		);
	}

	return createUIWindow(
		{
			title: "Cottontail UI (kitchen)",
			width: 860,
			height: 480,
			background: "#13131c",
		},
		() => {
			ui.row({ grow: 1 }, () => {
				ui.column({ grow: 3, justify: "center", align: "center", gap: 16 }, () => {
					ui.text("Cottontail UI - reactive GPU chrome", {
						size: 12,
						color: "#8c8ca8",
					});
					ui.text($(() => String(count())), { size: 88, color: $(accent) });
					ui.row({ gap: 10 }, () => {
						Button("- 1", () => setCount((c) => c - 1));
						Button("+ 1", () => setCount((c) => c + 1));
						Button("Reset", () => setCount(0));
					});
					ui.text("Hover changes borders; space or +/- keys work", {
						size: 11,
						color: "#616178",
					});
				});
				ui.box({ width: 1, bg: "#262638" });
				ui.column({ grow: 2 }, () => {
					ui.column({ pad: 12, gap: 6, grow: 1 }, () => {
						ui.text("wgpuSurface (accent-colored)", {
							size: 11,
							color: "#8c8ca8",
						});
						let repaint: (() => void) | null = null;
						wgpuSurface({
							grow: 1,
							onReady: async (view) => {
								const { context } = webgpu.createContext(view as any);
								const adapter = await webgpu.navigator.requestAdapter({
									compatibleSurface: context,
								});
								const device = await adapter.requestDevice();
								context._fallbackSize = {
									width: view.frame.width,
									height: view.frame.height,
								};
								context.configure({ device, format: "bgra8unorm" });
								repaint = () => {
									const rgba = parseColor(accent()) >>> 0;
									context._fallbackSize = {
										width: view.frame.width,
										height: view.frame.height,
									};
									const encoder = device.createCommandEncoder();
									const pass = encoder.beginRenderPass({
										colorAttachments: [
											{
												view: context.getCurrentTexture().createView(),
												loadOp: "clear",
												storeOp: "store",
												clearValue: {
													r: ((rgba >>> 24) & 0xff) / 255,
													g: ((rgba >>> 16) & 0xff) / 255,
													b: ((rgba >>> 8) & 0xff) / 255,
													a: 1,
												},
											},
										],
									});
									pass.end();
									device.queue.submit([encoder.finish()]);
								};
								createEffect(() => repaint!());
							},
							onFrame: () => repaint?.(),
						});
					});
					ui.box({ height: 1, bg: "#262638" });
					ui.column({ pad: 12, gap: 6, grow: 1 }, () => {
						ui.text("webview (OOPIF)", { size: 11, color: "#8c8ca8" });
						webview({
							grow: 1,
							html: `<!doctype html><html><head><style>
								body { background:#171722; color:#e4e4f0; font-family:-apple-system,sans-serif;
								       display:grid; place-items:center; height:100vh; margin:0; text-align:center; }
								small { color:#8c8ca8; }
							</style></head><body><div><h3>Real webview</h3>
							<small>Out-of-process web content positioned<br/>by the Cottontail UI layout.</small>
							</div></body></html>`,
						});
					});
				});
			});

			onKey((e) => {
				if (e.keyCode === 49 || e.keyCode === 24) setCount((c) => c + 1);
				else if (e.keyCode === 27) setCount((c) => c - 1);
				else if (e.keyCode === 15) setCount(0);
			});
		},
	);
}

export const cottontailUiTests = [
	defineTest({
		name: "Cottontail UI demo window",
		category: "Cottontail UI",
		description:
			"Reactive counter card rendered by Dawn, with an accent-colored wgpuSurface and an OOPIF webview panel laid out by the UI tree.",
		interactive: true,
		async run({ showInstructions, waitForUserVerification, log }) {
			const uiWindow = await openDemoWindow();
			try {
				await showInstructions([
					"A dark window titled 'Cottontail UI (kitchen)' should be open.",
					"Hover the three buttons: their borders should tint to the accent color.",
					"Click +1 / -1: the large number and the right-hand color panel should change together.",
					"Press space (or +/-): the counter should respond to the keyboard.",
					"The bottom-right panel is a real webview showing 'Real webview'.",
					"Resize the window: everything should reflow, including both panels.",
				]);
				const result = await waitForUserVerification();
				log(`user verdict: ${result.action}`);
				if (result.action === "fail") {
					throw new Error(result.notes || "User reported failure");
				}
			} finally {
				uiWindow.dispose();
			}
		},
	}),
];
