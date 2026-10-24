// Electrobun UI color picker: a tray eyedropper in a transparent, rounded,
// always-on-top window — the "webview is too much, raw GpuWindow is too
// little" showcase. Left: zoomed pixels around the cursor. Right: the color
// in several formats — click a row to copy it, or cmd+C to copy your
// preferred format (persisted across launches). Rendered by
// electrobun/main/ui: HTML/CSS + JSX drawn straight to the GPU.
//
// Screen sampling uses Electrobun's native cross-platform capture API. macOS
// requires Screen Recording permission; Windows and the current Linux/X11
// backend do not require a separate app permission prompt.

import { Screen, Tray, Utils } from "electrobun/main";
import { join } from "node:path";
import { createUIWindow, For, Show, batch, inert, live, memo, signal } from "electrobun/main/ui";
import { packRgbaPixels, packedPixelsEqual } from "./colorSampling";

const css = `
	:root {
		--panel: #16161eee; --inset: #10101a; --line: #2a2a3e; --row: #1d1d2b; --row-hover: #262638;
		--text: #e4e4f0; --muted: #8c8ca8; --faint: #616178; --accent: #9d7cd8;
	}
	html, body { margin: 0; height: 100%; font: 11px system-ui; color: var(--text); }
	body { display: flex; }
	.panel {
		flex: 1; display: flex; border-radius: 14px; background: var(--panel);
		border: 1px solid var(--line); overflow: hidden;
	}

	/* left: the loupe doubles as the window's drag handle (frameless) */
	.loupe { width: 219px; box-sizing: border-box; padding: 14px; display: flex; flex-direction: column; gap: 8px;
	         -webkit-app-region: drag; }
	.grid { display: grid; grid-template-columns: repeat(11, 17px); padding: 1px; border-radius: 6px;
	        background: var(--inset); align-self: start; }
	.cell { width: 17px; height: 17px; box-sizing: border-box; }
	.cell.center { border: 1.5px solid var(--text); }
	.status { display: flex; align-items: center; gap: 6px; font-size: 9px; color: var(--faint); }
	.status .dot { width: 8px; height: 8px; border-radius: 4px; }

	.divider { width: 1px; background: var(--line); }

	/* right: color + formats */
	.color { flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
	.summary { display: flex; align-items: center; gap: 10px; }
	.swatch { width: 44px; height: 44px; border-radius: 8px; border: 1px solid var(--line); box-sizing: border-box; }
	.hex { font-size: 16px; }
	.note { font-size: 10px; color: var(--faint); }
	.note.copied { color: #9ece6a; }

	.modes { display: flex; gap: 8px; }
	.mode { flex: 1; padding: 7px; border-radius: 6px; text-align: center; font-size: 10px;
	        background: var(--row); border: 1px solid var(--line); color: var(--muted); }
	.mode:hover { background: var(--row-hover); }

	.format { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px;
	          background: var(--row); border: 1px solid var(--line); }
	.format:hover { background: var(--row-hover); }
	.format.preferred { border-color: var(--accent); }
	.format .name { font-size: 10px; color: var(--faint); flex: 1; }

	.selector-head { display: flex; align-items: center; gap: 6px; padding: 7px; border-radius: 6px; font-size: 10px; color: var(--faint); }
	.selector-head:hover { background: var(--row-hover); }
	.selector-head .grow { flex: 1; }
	.selector-head .current { font-size: 11px; color: var(--accent); }
	.chips { display: flex; gap: 6px; }
	.chip { padding: 6px; border-radius: 5px; font-size: 10px; background: var(--row);
	        border: 1px solid var(--line); color: var(--muted); }
	.chip:hover { background: var(--row-hover); }
	.chip.preferred { border-color: var(--accent); color: var(--accent); }
`;

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

const MODE_COLOR: Record<Mode, string> = {
	live: "#9ece6a",
	armed: "#c8a2ff",
	frozen: "#e0af68",
};

const cssColor = (c: number) => `#${(c >>> 0).toString(16).padStart(8, "0")}`;
const CELL_INDICES = Array.from({ length: GRID * GRID }, (_, i) => i);

function Loupe() {
	return (
		<div class="loupe">
			<div class="grid">
				<For each={CELL_INDICES}>
					{(i) => (
						<div
							class={i === CENTER ? "cell center" : "cell"}
							style={live(() => `background: ${cssColor(cells()[i]!)}`)}
						/>
					)}
				</For>
			</div>
			<div
				class="status"
				onClick={() => {
					if (!hasScreenAccess()) {
						Utils.screenCapture.requestAccess();
						Utils.screenCapture.openSettings();
					}
				}}
			>
				<div
					class="dot"
					style={live(() => `background: ${!hasScreenAccess() || !captureAvailable() ? "#f7768e" : MODE_COLOR[mode()]}`)}
				/>
				<span>
					{live(() =>
						!hasScreenAccess() ? "no access - click here"
						: !captureAvailable() ? (IS_WAYLAND_SESSION ? "share a monitor..." : "capture unavailable")
						: mode(),
					)}
				</span>
			</div>
		</div>
	);
}

// "live" resumes cursor sampling; "pick" arms a one-shot — the next click
// outside the window freezes the sample and the pick button resets itself.
function ModeButton(props: { label: () => string; active: () => boolean; color: string; bg: string; onClick: () => void }) {
	return (
		<div
			class="mode"
			style={live(() => (props.active() ? `background: ${props.bg}; border-color: ${props.color}; color: ${props.color}` : ""))}
			onClick={props.onClick}
		>
			{live(props.label)}
		</div>
	);
}

function ModeButtons() {
	return (
		<div class="modes">
			<ModeButton
				label={() => "live"}
				active={() => mode() === "live"}
				color={MODE_COLOR.live}
				bg="#22301f"
				onClick={() => setMode("live")}
			/>
			<ModeButton
				label={() =>
					IS_WAYLAND_SESSION ? "freeze sample" : mode() === "armed" ? "click a pixel..." : "pick mode"}
				active={() => mode() === (IS_WAYLAND_SESSION ? "frozen" : "armed")}
				color={IS_WAYLAND_SESSION ? MODE_COLOR.frozen : MODE_COLOR.armed}
				bg={IS_WAYLAND_SESSION ? "#403820" : "#3d2f56"}
				onClick={() => setMode(IS_WAYLAND_SESSION ? "frozen" : "armed")}
			/>
		</div>
	);
}

function FormatRow(format: Format) {
	return (
		<div
			class={live(() => (copyFormat() === format ? "format preferred" : "format"))}
			onClick={() => copy(format)}
		>
			<span class="name">{format.toUpperCase()}</span>
			<span>{live(() => formatColor(centerColor(), format))}</span>
		</div>
	);
}

function CopyFormatSelector() {
	const [expanded, setExpanded] = signal(false);
	return (
		<div>
			<div class="selector-head" onClick={() => setExpanded((v) => !v)}>
				<span class="grow">cmd+C copies</span>
				<span class="current">{live(() => copyFormat().toUpperCase())}</span>
				<span>{live(() => (expanded() ? "^" : "v"))}</span>
			</div>
			<Show when={live(expanded)}>
				<div class="chips">
					<For each={FORMATS}>
						{(format) => (
							<div
								class={live(() => (copyFormat() === format ? "chip preferred" : "chip"))}
								onClick={() =>
									batch(() => {
										setCopyFormat(format);
										setExpanded(false);
									})}
							>
								{format.toUpperCase()}
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

function ColorPanel() {
	return (
		<div class="color">
			<div class="summary">
				<div class="swatch" style={live(() => `background: ${cssColor(centerColor())}`)} />
				<div>
					<div class="hex">{live(() => formatColor(centerColor(), "hex"))}</div>
					<div class={live(() => (copied() ? "note copied" : "note"))}>
						{live(() => {
							const c = copied();
							return c ? `copied ${c}` : "click a row to copy";
						})}
					</div>
				</div>
			</div>
			<ModeButtons />
			<For each={FORMATS}>{FormatRow}</For>
			<CopyFormatSelector />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

const WIDTH = 512;
const HEIGHT = 336;
let pickerVisible = true;

const { window: pickerWindow, ui } = createUIWindow(
	{
		title: "Color Picker",
		width: WIDTH,
		height: HEIGHT,
		titleBarStyle: "hidden",
		transparent: true,
		alwaysOnTop: true,
		css,
	},
	() => (
		<div class="panel">
			<Loupe />
			<div class="divider" />
			<ColorPanel />
		</div>
	),
);

// Keys bubble to <body> when nothing else has focus.
ui.body.addEventListener("keydown", (e: { key: string; metaKey: boolean; ctrlKey: boolean }) => {
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
		copy(inert(copyFormat));
	} else if (e.key === " ") {
		setMode(inert(mode) === "frozen" ? "live" : "frozen");
	} else if (e.key === "Escape") {
		if (inert(mode) === "armed") setMode("live");
		else setPickerVisible(false);
	}
});

function setPickerVisible(visible: boolean) {
	if (visible === pickerVisible) return;
	pickerVisible = visible;
	if (visible) pickerWindow.show();
	else pickerWindow.hide();
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

	const frame = pickerWindow.getFrame();
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
			const frame = pickerWindow.getFrame();
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

console.log("[ui-color-picker] running");
if (process.platform === "darwin") {
	console.log(
		Utils.screenCapture.hasAccess()
			? "[ui-color-picker] Screen Recording permission granted."
			: "[ui-color-picker] Awaiting Screen Recording permission (System Settings -> Privacy & Security). Relaunch after granting.",
	);
}
