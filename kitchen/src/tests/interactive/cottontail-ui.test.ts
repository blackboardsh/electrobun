// Interactive test: the Cottontail UI demo window — reactive counter card
// rendered by Dawn with embedded native-layer elements (wgpuSurface +
// OOPIF webview) positioned by the UI layout.

import { defineTest } from "../../test-framework/types";
import { webgpu } from "electrobun/main";
import {
	cleanup,
	live,
	memo,
	signal,
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
	const [count, setCount] = signal(0);
	const accent = memo(() => hslToHex(260 + count() * 14, 0.72, 0.68));

	function Button(label: string, onClick: () => void) {
		const [hover, setHover] = signal(false);
		const [active, setActive] = signal(false);
		ui.box(
			{
				width: 90,
				pad: 12,
				radius: 9,
				justify: "center",
				bg: live(() =>
					active() ? "#2c2c44" : hover() ? "#232336" : "#1b1b28"),
				border: 1,
				borderColor: live(() => (hover() ? accent() : "#262638")),
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
					ui.text(live(() => String(count())), { size: 88, color: live(accent) });
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
						let repaint: ((color: string) => void) | null = null;
						let surfaceDevice: { destroy(): void } | null = null;
						let surfaceDisposed = false;
						wgpuSurface({
							grow: 1,
							onReady: async (view) => {
								try {
									const { context } = webgpu.createContext(view as any);
									const adapter = await webgpu.navigator.requestAdapter({
										compatibleSurface: context,
									});
									if (surfaceDisposed || view.isRemoved) return;
									const device = await adapter.requestDevice();
									if (surfaceDisposed || view.isRemoved) {
										device.destroy();
										return;
									}
									surfaceDevice = device;
									try {
										context._fallbackSize = {
											width: view.frame.width,
											height: view.frame.height,
										};
										context.configure({ device, format: "bgra8unorm" });
										repaint = (color) => {
											const rgba = parseColor(color) >>> 0;
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
										repaint(accent());
									} catch (error) {
										repaint = null;
										surfaceDevice = null;
										device.destroy();
										throw error;
									}
								} catch (error) {
									if (surfaceDisposed || view.isRemoved) return;
									throw error;
								}
							},
							onFrame: () => repaint?.(accent()),
						});
						cleanup(() => {
							surfaceDisposed = true;
							repaint = null;
							const device = surfaceDevice;
							surfaceDevice = null;
							device?.destroy();
						});
						// Register the effect while the UI root scope is active. onReady is
						// asynchronous, so registering it there would happen outside Warren's
						// root scope after requestAdapter/requestDevice resolve.
						live(() => {
							const color = accent();
							repaint?.(color);
						});
					});
					ui.box({ height: 1, bg: "#262638" });
					ui.column({ pad: 12, gap: 6, grow: 1 }, () => {
						ui.text("webview (https://blackboard.sh)", {
							size: 11,
							color: "#8c8ca8",
						});
						webview({
							grow: 1,
							url: "https://blackboard.sh",
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
			"Reactive counter card rendered by Dawn, with an accent-colored wgpuSurface and a blackboard.sh OOPIF webview panel laid out by the UI tree.",
		instructions: [
			"A dark window titled 'Cottontail UI (kitchen)' should be open.",
			"Hover the three buttons: their borders should tint to the accent color.",
			"Click +1 / -1: the large number and the right-hand color panel should change together.",
			"Press space (or +/-): the counter should respond to the keyboard.",
			"The bottom-right webview should load https://blackboard.sh.",
			"Resize the window: everything should reflow, including both panels.",
			"Close the demo window when you are done.",
		],
		interactive: true,
		timeout: 600000,
		async run() {
			const uiWindow = await openDemoWindow();
			const lifecycle = uiWindow as UIWindow & {
				readonly closed: Promise<void>;
				isClosed(): boolean;
			};
			try {
				await lifecycle.closed;
			} finally {
				if (!lifecycle.isClosed()) uiWindow.dispose();
			}
		},
	}),
];
