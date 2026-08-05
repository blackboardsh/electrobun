// Interactive test: live monitor for the UI runtime's input pipeline.
// Left: interactive targets (hover/click button, drag handle, text input,
// wheel-scrollable list). Right: the raw native event stream
// (wgpu-pointer-*/wgpu-key-*) that the input driver consumes, so you can see
// exactly what is being registered — and whether the native event path or
// the polling fallback is active.

import { defineTest } from "../../test-framework/types";
import Electrobun from "electrobun/main";
import {
	createSignal,
	createStore,
	onKey,
	produce,
	textInput,
	ui,
	untrack,
	createUIWindow,
	Mod,
} from "electrobun/main/ui";

const theme = {
	panel: "#16161e",
	line: "#2a2a3e",
	row: "#1d1d2b",
	rowHover: "#262638",
	text: "#e4e4f0",
	muted: "#8c8ca8",
	faint: "#616178",
	accent: "#9d7cd8",
	good: "#9ece6a",
	warn: "#e0af68",
	info: "#7aa2f7",
};

const POINTER_TYPE = ["move", "down", "up", "wheel", "enter", "exit"] as const;

interface LogEntry {
	seq: number;
	kind: "pointer" | "key" | "ui";
	label: string;
	detail: string;
}

function modString(modifiers: number): string {
	const parts: string[] = [];
	if (modifiers & Mod.Shift) parts.push("shift");
	if (modifiers & Mod.Ctrl) parts.push("ctrl");
	if (modifiers & Mod.Alt) parts.push("alt");
	if (modifiers & Mod.Cmd) parts.push("cmd");
	return parts.length ? parts.join("+") : "-";
}

export const uiInputEventTests = [
	defineTest({
		name: "Cottontail UI input event monitor",
		category: "Cottontail UI",
		description:
			"Visualizes the raw native pointer/key event stream and UI-level dispatch (hover, click, focus, drag, wheel).",
		interactive: true,
		async run({ showInstructions, waitForUserVerification, log }) {
			const [pos, setPos] = createSignal({ x: 0, y: 0 });
			const [pathLabel, setPathLabel] = createSignal("waiting for events...");
			const [query, setQuery] = createSignal("");
			const [lastChars, setLastChars] = createSignal("");
			const [clicks, setClicks] = createSignal(0);
			const [entries, setEntries] = createStore({
				items: [] as LogEntry[],
				seq: 0,
			});

			let lastMoveLogged = 0;
			const push = (kind: LogEntry["kind"], label: string, detail: string) => {
				setEntries(
					produce((s) => {
						s.seq += 1;
						s.items.unshift({ seq: s.seq, kind, label, detail });
						if (s.items.length > 16) s.items.length = 16;
					}),
				);
			};

			const uiWindow = await createUIWindow(
				{
					title: "UI input events",
					width: 720,
					height: 520,
					background: theme.panel,
					titleBarStyle: "hiddenInset",
				},
				() => {
					ui.column({ grow: 1, pad: 12, gap: 10 }, () => {
						ui.row({ gap: 8, align: "center" }, () => {
							ui.box({ width: 58 });
							ui.text("input event monitor", { size: 14, color: theme.text });
							ui.spacer();
							ui.text(() => pathLabel(), { size: 11, color: theme.good });
							ui.text(
								() => `cursor ${pos().x.toFixed(0)},${pos().y.toFixed(0)}`,
								{ size: 11, color: theme.faint },
							);
						});
						ui.box({ height: 1, bg: theme.line });

						ui.row({ grow: 1, gap: 10 }, () => {
							// Interactive targets
							ui.column({ width: 300, gap: 8 }, () => {
								ui.text("targets", { size: 10, color: theme.muted });

								const [hover, setHover] = createSignal(false);
								ui.row(
									{
										pad: 12,
										radius: 8,
										justify: "center",
										bg: () => (hover() ? theme.rowHover : theme.row),
										border: 1,
										borderColor: () => (hover() ? theme.accent : theme.line),
										onClick: () => {
											setClicks((c) => c + 1);
											push("ui", "click", `button (total ${untrack(clicks)})`);
										},
										onPointerEnter: () => {
											setHover(true);
											push("ui", "enter", "button");
										},
										onPointerLeave: () => {
											setHover(false);
											push("ui", "leave", "button");
										},
									},
									() => {
										ui.text(() => `hover + click me (${clicks()})`, {
											size: 12,
											color: theme.text,
										});
									},
								);

								ui.row(
									{
										pad: 10,
										radius: 8,
										justify: "center",
										bg: theme.row,
										border: 1,
										borderColor: theme.warn,
										windowDrag: true,
										onClick: () => push("ui", "click", "drag handle (no move)"),
									},
									() => {
										ui.text("drag me to move the window", {
											size: 11,
											color: theme.warn,
										});
									},
								);

								textInput({
									value: query,
									onInput: (next) => {
										setQuery(next);
									},
									placeholder: "type here - chars shown in log",
									focusBorderColor: theme.accent,
								});
								ui.text(
									() =>
										lastChars()
											? `last chars: "${lastChars()}"`
											: "last chars: -",
									{ size: 10, color: theme.faint },
								);

								ui.text("wheel over this list:", {
									size: 10,
									color: theme.muted,
								});
								ui.box(
									{
										dir: "column",
										grow: 1,
										overflow: "scroll",
										radius: 6,
										bg: "#10101a",
										pad: 4,
									},
									() => {
										for (let i = 1; i <= 30; i++) {
											ui.row({ pad: 6 }, () => {
												ui.text(`scrollable row ${i}`, {
													size: 11,
													color: i % 5 === 0 ? theme.info : theme.muted,
												});
											});
										}
									},
								);
							});

							ui.box({ width: 1, bg: theme.line });

							// Raw event log
							ui.column({ grow: 1, gap: 6 }, () => {
								ui.text("raw + dispatched events (newest first)", {
									size: 10,
									color: theme.muted,
								});
								ui.each(
									{ dir: "column", gap: 2, grow: 1 },
									() => entries.items,
									(entry) => entry.seq,
									(entry) => {
										ui.row({ gap: 8, pad: 3 }, () => {
											ui.text(`#${entry.seq}`, {
												size: 10,
												color: theme.faint,
											});
											ui.text(entry.label, {
												size: 10,
												color:
													entry.kind === "pointer"
														? theme.info
														: entry.kind === "key"
															? theme.good
															: theme.accent,
											});
											ui.text(entry.detail, {
												size: 10,
												color: theme.muted,
											});
										});
									},
								);
							});
						});
					});

					onKey((e) => {
						push(
							"key",
							"window key",
							`code=${e.keyCode} mods=${modString(e.modifiers)}`,
						);
					});
				},
			);

			// Tap the raw native streams the input driver consumes.
			const viewId = uiWindow.window.wgpuViewId;
			const events = (Electrobun as any).events;
			const onRawPointer = (e: any) => {
				setPathLabel("native event path active");
				if (e.type === 0) {
					setPos({ x: e.x, y: e.y });
					const now = Date.now();
					if (now - lastMoveLogged < 150) return;
					lastMoveLogged = now;
					push("pointer", "move", `${e.x.toFixed(0)},${e.y.toFixed(0)}`);
					return;
				}
				const name = POINTER_TYPE[e.type] ?? `type${e.type}`;
				const detail =
					e.type === 3
						? `dx=${e.buttonOrDx.toFixed(1)} dy=${e.dy.toFixed(1)}`
						: e.type === 1 || e.type === 2
							? `button=${e.buttonOrDx} at ${e.x.toFixed(0)},${e.y.toFixed(0)}`
							: `${e.x.toFixed(0)},${e.y.toFixed(0)}`;
				push("pointer", name, detail);
			};
			const onRawKey = (e: any) => {
				if (!e.isDown) return;
				setLastChars(typeof e.chars === "string" ? e.chars : "");
				push(
					"key",
					"raw key",
					`code=${e.keyCode} chars="${e.chars ?? ""}" mods=${modString(e.modifiers)}${e.isRepeat ? " repeat" : ""}`,
				);
			};
			events.on(`wgpu-pointer-${viewId}`, onRawPointer);
			events.on(`wgpu-key-${viewId}`, onRawKey);

			try {
				await showInstructions([
					"A window titled 'UI input events' is open.",
					"Move the mouse over it: the header should say 'native event path active' and show live coordinates.",
					"Hover and click the button: enter/leave/click entries appear (violet = UI dispatch, blue = raw pointer).",
					"Drag the amber handle: the window moves; a still click logs instead.",
					"Click the input and type (try your OS keyboard layout): green raw-key entries show keycodes AND the produced characters.",
					"Two-finger scroll over the list: wheel events with deltas, and the list scrolls.",
				]);
				const result = await waitForUserVerification();
				log(`user verdict: ${result.action}`);
				if (result.action === "fail") {
					throw new Error(result.notes || "User reported failure");
				}
			} finally {
				events.off(`wgpu-pointer-${viewId}`, onRawPointer);
				events.off(`wgpu-key-${viewId}`, onRawKey);
				uiWindow.dispose();
			}
		},
	}),
];
