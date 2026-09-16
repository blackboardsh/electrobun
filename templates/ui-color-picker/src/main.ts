// Cottontail UI color picker: a tray eyedropper in a transparent, rounded,
// always-on-top UI window — the "webview is too much, raw GpuWindow is too
// little" showcase. Left: zoomed pixels around the cursor. Right: the color
// in several formats — click a row to copy it, or cmd+C to copy your
// preferred format (persisted across launches).
//
// Screen sampling uses Electrobun's native cross-platform capture API. macOS
// requires Screen Recording permission; Windows and the current Linux/X11
// backend do not require a separate app permission prompt.

import { Screen, Tray, Utils } from "electrobun/main";
import { join } from "node:path";
import {
	live,
	batch,
	charForKey,
	memo,
	signal,
	getUiContext,
	onKey,
	ui,
	inert,
	createUIWindow,
	Key,
	Mod,
} from "electrobun/main/ui";
import { packRgbaPixels, packedPixelsEqual } from "./colorSampling";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const theme = {
	panel: "#16161eee",
	inset: "#10101a",
	line: "#2a2a3e",
	row: "#1d1d2b",
	rowHover: "#262638",
	textPrimary: "#e4e4f0",
	textMuted: "#8c8ca8",
	textFaint: "#616178",
	accent: "#9d7cd8",
};

// ---------------------------------------------------------------------------
// Color state + sampling
// ---------------------------------------------------------------------------

const GRID = 11; // odd, so the cursor pixel is the center cell
const CENTER = Math.floor((GRID * GRID) / 2);
const CURSOR_POLL_INTERVAL_MS = 16; // near-60 Hz while the pointer is moving
const POST_MOTION_SAMPLE_BURST_MS = 70;
const STATIONARY_SAMPLE_INTERVAL_MS = 100;
const IS_WAYLAND_SESSION =
	process.platform === "linux" &&
	(process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
		Boolean(process.env.WAYLAND_DISPLAY));

const [cells, setCells] = signal<Uint32Array>(
	new Uint32Array(GRID * GRID).fill(0x101010ff),
	{ equals: false },
);
// Sampling state machine, driven by the mode button. Wayland cannot observe
// passive global mouse-button state, so its second button freezes immediately
// instead of arming the outside-click flow:
//   live  -> click button   -> armed ("pick mode")
//   armed -> click anywhere outside the window -> frozen
//   armed -> click button / Escape -> live
//   frozen -> click button -> live (click again to re-arm)
// Space toggles live <-> frozen while the window is focused.
type Mode = "live" | "armed" | "frozen";
const [mode, setMode] = signal<Mode>("live");
const [copied, setCopied] = signal("");
const [hasScreenAccess, setHasScreenAccess] = signal(
	Utils.screenCapture.hasAccess(),
);
const [captureAvailable, setCaptureAvailable] = signal(true);

const centerColor = memo(() => cells()[CENTER]! >>> 0);

const r8 = (c: number) => (c >>> 24) & 0xff;
const g8 = (c: number) => (c >>> 16) & 0xff;
const b8 = (c: number) => (c >>> 8) & 0xff;

function toHexString(c: number): string {
	return (
		"#" +
		[r8(c), g8(c), b8(c)]
			.map((v) => v.toString(16).padStart(2, "0"))
			.join("")
	);
}

function toHsl(c: number): { h: number; s: number; l: number } {
	const r = r8(c) / 255;
	const g = g8(c) / 255;
	const b = b8(c) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h =
		max === r ? (g - b) / d + (g < b ? 6 : 0)
		: max === g ? (b - r) / d + 2
		: (r - g) / d + 4;
	h *= 60;
	return {
		h: Math.round(h),
		s: Math.round(s * 100),
		l: Math.round(l * 100),
	};
}

type Format = "hex" | "rgb" | "rgba" | "hsl";
const FORMATS: Format[] = ["hex", "rgb", "rgba", "hsl"];

function formatColor(c: number, format: Format): string {
	switch (format) {
		case "hex":
			return toHexString(c);
		case "rgb":
			return `rgb(${r8(c)}, ${g8(c)}, ${b8(c)})`;
		case "rgba":
			return `rgba(${r8(c)}, ${g8(c)}, ${b8(c)}, 1)`;
		case "hsl": {
			const { h, s, l } = toHsl(c);
			return `hsl(${h}, ${s}%, ${l}%)`;
		}
	}
}

// Persistent preference: which format cmd+C copies.
const prefsPath = join(Utils.paths.userData, "ui-color-picker.json");
const [copyFormat, setCopyFormatSignal] = signal<Format>(
	await (async () => {
		try {
			const prefs = JSON.parse(await Bun.file(prefsPath).text());
			if (FORMATS.includes(prefs.copyFormat)) return prefs.copyFormat;
		} catch {}
		return "hex" as Format;
	})(),
);

function setCopyFormat(format: Format) {
	setCopyFormatSignal(format);
	Bun.write(prefsPath, JSON.stringify({ copyFormat: format })).catch(() => {});
}

function copy(format: Format) {
	const text = formatColor(centerColor(), format);
	Utils.clipboardWriteText(text);
	setCopied(text);
	setTimeout(() => setCopied(""), 1400);
}

// ---------------------------------------------------------------------------
// Screen sampling: capture a GRID x GRID point region around the cursor.
// Skipped while the cursor is over our own window (so mousing over to click
// a row keeps the sampled color) or while frozen (space bar).
// ---------------------------------------------------------------------------

function sampleAround(cx: number, cy: number): boolean {
	const half = Math.floor(GRID / 2);
	const rgba = Screen.captureRegion({
		x: cx - half,
		y: cy - half,
		width: GRID,
		height: GRID,
	});
	if (!rgba) return false;
	const next = packRgbaPixels(rgba);
	// Unchanged sample (stationary cursor, static screen): skip the update so
	// the invalidation-driven renderer stays idle.
	if (!packedPixelsEqual(next, cells())) setCells(next);
	return true;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const CELL = 17;

function ZoomGrid() {
	// Dragging the loupe area moves the window (frameless). Fixed width so
	// the status text can't inflate the column and squeeze the color panel.
	ui.column({ pad: 14, gap: 8, width: 219, windowDrag: true }, () => {
		ui.column({ bg: theme.inset, pad: 1, gap: 0, radius: 6 }, () => {
			for (let gy = 0; gy < GRID; gy++) {
				const rowStart = gy * GRID;
				ui.row({ gap: 0 }, () => {
					for (let gx = 0; gx < GRID; gx++) {
						const i = rowStart + gx;
						const isCenter = i === CENTER;
						ui.box({
							width: CELL,
							height: CELL,
							bg: live(() => cells()[i]! >>> 0),
							border: isCenter ? 1.5 : 0,
							borderColor: theme.textPrimary,
						});
					}
				});
			}
		});
		ui.row(
			{
				gap: 6,
				align: "center",
				onClick: () => {
					if (!hasScreenAccess()) {
						Utils.screenCapture.requestAccess();
						Utils.screenCapture.openSettings();
					}
				},
			},
			() => {
				ui.box({
					width: 8,
					height: 8,
					radius: 4,
					bg: live(() =>
						!hasScreenAccess() || !captureAvailable()
							? "#f7768e"
							: MODE_COLOR[mode()],
					),
				});
				ui.text(
					live(() =>
						!hasScreenAccess() ? "no access - click here"
						: !captureAvailable() ?
								IS_WAYLAND_SESSION ? "share a monitor..."
								: "capture unavailable"
						: mode(),
					),
					{ size: 9, color: theme.textFaint },
				);
			},
		);
	});
}

function FormatRow(format: Format) {
	const ctx = getUiContext();
	let id = 0;
	id = ui.row(
		{
			pad: 8,
			radius: 6,
			gap: 8,
			align: "center",
			bg: live(() => (ctx.hoveredId() === id ? theme.rowHover : theme.row)),
			border: 1,
			borderColor: live(() => (copyFormat() === format ? theme.accent : theme.line)),
			onClick: () => copy(format),
		},
		() => {
			ui.text(format.toUpperCase(), { size: 10, color: theme.textFaint });
			ui.spacer();
			ui.text(live(() => formatColor(centerColor(), format)), {
				size: 11,
				color: theme.textPrimary,
			});
		},
	);
}

function CopyFormatSelector() {
	const [expanded, setExpanded] = signal(false);
	const ctx = getUiContext();
	ui.column({ gap: 4 }, () => {
		let headerId = 0;
		headerId = ui.row(
			{
				pad: 7,
				radius: 6,
				gap: 6,
				align: "center",
				bg: live(() => (ctx.hoveredId() === headerId ? theme.rowHover : "#00000000")),
				onClick: () => setExpanded((v) => !v),
			},
			() => {
				ui.text("cmd+C copies", { size: 10, color: theme.textFaint });
				ui.spacer();
				ui.text(live(() => copyFormat().toUpperCase()), {
					size: 11,
					color: theme.accent,
				});
				ui.text(live(() => (expanded() ? "^" : "v")), {
					size: 10,
					color: theme.textFaint,
				});
			},
		);
		ui.dynamic({ dir: "row", gap: 6 }, () => {
			const showFormats = expanded();
			if (!showFormats) return;
			inert(() => {
				for (const format of FORMATS) {
					let chipId = 0;
					chipId = ui.box(
						{
							pad: 6,
							radius: 5,
							bg: live(() =>
								ctx.hoveredId() === chipId ? theme.rowHover : theme.row),
							border: 1,
							borderColor: live(() =>
								copyFormat() === format ? theme.accent : theme.line),
							onClick: () => {
								batch(() => {
									setCopyFormat(format);
									setExpanded(false);
								});
							},
						},
						() => {
							ui.text(format.toUpperCase(), {
								size: 10,
								color: live(() =>
									copyFormat() === format
										? theme.accent
										: theme.textMuted),
							});
						},
					);
				}
			});
		});
	});
}

const MODE_COLOR: Record<Mode, string> = {
	live: "#9ece6a",
	armed: "#c8a2ff",
	frozen: "#e0af68",
};

// Two direct-action buttons: "live" resumes cursor sampling; "pick" arms a
// one-shot — the next click outside the window freezes the sample and the
// pick button resets itself.
function ModeButtons() {
	const ctx = getUiContext();

	function StateButton(
		label: () => string,
		active: () => boolean,
		activeColor: string,
		activeBg: string,
		onClick: () => void,
	) {
		let id = 0;
		id = ui.row(
			{
				grow: 1,
				pad: 7,
				radius: 6,
				justify: "center",
				bg: live(() =>
					active()
						? activeBg
						: ctx.hoveredId() === id
							? theme.rowHover
							: theme.row),
				border: 1,
				borderColor: live(() => (active() ? activeColor : theme.line)),
				onClick,
			},
			() => {
				ui.text(live(label), {
					size: 10,
					color: live(() => (active() ? activeColor : theme.textMuted)),
				});
			},
		);
	}

	ui.row({ gap: 8 }, () => {
		StateButton(
			() => "live",
			() => mode() === "live",
			MODE_COLOR.live,
			"#22301f",
			() => setMode("live"),
		);
		StateButton(
			() =>
				IS_WAYLAND_SESSION ? "freeze sample"
				: mode() === "armed" ? "click a pixel..."
				: "pick mode",
			() =>
				mode() === (IS_WAYLAND_SESSION ? "frozen" : "armed"),
			IS_WAYLAND_SESSION ? MODE_COLOR.frozen : MODE_COLOR.armed,
			IS_WAYLAND_SESSION ? "#403820" : "#3d2f56",
			() => setMode(IS_WAYLAND_SESSION ? "frozen" : "armed"),
		);
	});
}

function ColorPanel() {
	ui.column({ pad: 14, gap: 8, grow: 1 }, () => {
		ui.row({ gap: 10, align: "center" }, () => {
			ui.box({
				width: 44,
				height: 44,
				radius: 8,
				bg: live(() => centerColor()),
				border: 1,
				borderColor: theme.line,
			});
			ui.column({ gap: 2 }, () => {
				ui.text(live(() => formatColor(centerColor(), "hex")), {
					size: 16,
					color: theme.textPrimary,
				});
				ui.text(live(() => {
					const c = copied();
					return c ? `copied ${c}` : "click a row to copy";
				}), {
					size: 10,
					color: live(() => (copied() ? "#9ece6a" : theme.textFaint)),
				});
			});
		});
		ModeButtons();
		for (const format of FORMATS) FormatRow(format);
		CopyFormatSelector();
	});
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

const WIDTH = 512;
const HEIGHT = 336;
let pickerVisible = true;

const uiWindow = await createUIWindow(
	{
		title: "Color Picker",
		width: WIDTH,
		height: HEIGHT,
		titleBarStyle: "hidden",
		transparent: true,
		background: "#00000000",
		alwaysOnTop: true,
	},
	() => {
		ui.row(
			{
				grow: 1,
				radius: 14,
				bg: theme.panel,
				border: 1,
				borderColor: theme.line,
			},
			() => {
				ZoomGrid();
				ui.box({ width: 1, bg: theme.line });
				ColorPanel();
			},
		);

		onKey((e) => {
			if (e.modifiers & Mod.Cmd && charForKey(e.keyCode, 0) === "c") {
				copy(copyFormat());
			} else if (e.keyCode === Key.Space) {
				setMode(inert(mode) === "frozen" ? "live" : "frozen");
			} else if (e.keyCode === Key.Escape) {
				if (inert(mode) === "armed") setMode("live");
				else setPickerVisible(false);
			}
		});
	},
);

function setPickerVisible(visible: boolean) {
	if (visible === pickerVisible) return;
	pickerVisible = visible;
	if (visible) uiWindow.window.show();
	else uiWindow.window.hide();
}

const tray = new Tray({ title: "◐" });
tray.on("tray-clicked", () => {
	setPickerVisible(!pickerVisible);
});

// Poll cursor motion near 60 Hz so the sample tracks the pointer. A short tail
// after motion consumes asynchronously refreshed frames (notably PipeWire),
// then capture settles to 10 Hz while stationary. Hidden, frozen, and self-hover
// states skip the work entirely.
let warnedCaptureUnavailable = false;
let lastCursorX = Number.NaN;
let lastCursorY = Number.NaN;
let lastCursorMovedAt = Number.NEGATIVE_INFINITY;
let lastSampleAttemptAt = Number.NEGATIVE_INFINITY;
setInterval(() => {
	if (!pickerVisible || mode() === "frozen") return;
	const cursor = Screen.getCursorScreenPoint();
	const cursorMoved = cursor.x !== lastCursorX || cursor.y !== lastCursorY;
	lastCursorX = cursor.x;
	lastCursorY = cursor.y;

	const now = performance.now();
	if (cursorMoved) lastCursorMovedAt = now;
	const motionBurstActive =
		now - lastCursorMovedAt < POST_MOTION_SAMPLE_BURST_MS;
	if (
		!motionBurstActive &&
		now - lastSampleAttemptAt < STATIONARY_SAMPLE_INTERVAL_MS
	) {
		return;
	}

	const frame = uiWindow.window.getFrame();
	const overSelf =
		cursor.x >= frame.x &&
		cursor.y >= frame.y &&
		cursor.x < frame.x + frame.width &&
		cursor.y < frame.y + frame.height;
	if (overSelf) return;
	lastSampleAttemptAt = now;
	const captured = sampleAround(cursor.x, cursor.y);
	setCaptureAvailable(captured);
	if (!captured && !warnedCaptureUnavailable) {
		console.warn(
			IS_WAYLAND_SESSION ?
				"[ui-color-picker] Waiting for Wayland monitor sharing and the first frame."
			: "[ui-color-picker] Screen pixel capture is unavailable on the current display.",
		);
	}
	warnedCaptureUnavailable = !captured;
}, CURSOR_POLL_INTERVAL_MS);

// Pick-mode click watcher: fast edge-detect poll while armed; a press
// outside our window freezes. Wayland deliberately uses the immediate freeze
// button because passive global button observation is compositor-restricted.
if (!IS_WAYLAND_SESSION) {
	let pickPrevDown = false;
	setInterval(() => {
		if (mode() !== "armed") {
			pickPrevDown = false;
			return;
		}
		const down = (Number(Screen.getMouseButtons()) & 1) === 1;
		if (down && !pickPrevDown) {
			const cursor = Screen.getCursorScreenPoint();
			const frame = uiWindow.window.getFrame();
			const inside =
				cursor.x >= frame.x &&
				cursor.y >= frame.y &&
				cursor.x < frame.x + frame.width &&
				cursor.y < frame.y + frame.height;
			if (!inside) setMode("frozen");
		}
		pickPrevDown = down;
	}, 30);
}

// Ask for Screen Recording permission properly: shows the system prompt the
// first time this app identity runs. After granting in System Settings the
// app must be relaunched for capture to work (macOS TCC behavior).
if (process.platform === "darwin" && !Utils.screenCapture.hasAccess()) {
	Utils.screenCapture.requestAccess();
}
setInterval(() => setHasScreenAccess(Utils.screenCapture.hasAccess()), 3000);

console.log("[ui-color-picker] running (solid-effects-ok)");
if (process.platform === "darwin") {
	console.log(
		Utils.screenCapture.hasAccess()
			? "[ui-color-picker] Screen Recording permission granted."
			: "[ui-color-picker] Awaiting Screen Recording permission (System Settings -> Privacy & Security). Relaunch after granting.",
	);
}
