// Cottontail UI command palette: an always-on-top pill you can drag anywhere
// on screen; click it (or hit the global shortcut) to expand into a palette
// that's a calculator when you type math and an app launcher otherwise.
// Exercises the full experimental UI stack: textInput (focus, caret,
// editing), keyed each() lists, scroll containers with clipping, window
// dragging, and a transparent always-on-top window — with no webview
// resident in memory for a surface that idles 98% of the time.

import { GlobalShortcut, Utils } from "electrobun/main";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	live,
	memo,
	signal,
	onKey,
	textInput,
	ui,
	inert,
	createUIWindow,
	Key,
} from "electrobun/main/ui";

const theme = {
	panel: "#16161eee",
	line: "#2a2a3e",
	row: "#00000000",
	rowSelected: "#262649",
	textPrimary: "#e4e4f0",
	textMuted: "#8c8ca8",
	textFaint: "#616178",
	accent: "#9d7cd8",
	good: "#9ece6a",
};

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface Entry {
	key: string;
	title: string;
	hint: string;
	badge: string;
	action: () => void;
}

// App scan (once at startup).
function scanApps(): Array<{ name: string; path: string }> {
	const dirs = [
		"/Applications",
		"/System/Applications",
		join(homedir(), "Applications"),
	];
	const apps: Array<{ name: string; path: string }> = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (file.endsWith(".app")) {
					apps.push({ name: file.slice(0, -4), path: join(dir, file) });
				}
			}
		} catch {}
	}
	apps.sort((a, b) => a.name.localeCompare(b.name));
	return apps;
}
const APPS = scanApps();
// Entries are static per app: build once so keystrokes only score and sort
// references instead of re-allocating closure-bearing objects.
const APP_ENTRIES = new Map(APPS.map((app) => [app.path, appEntry(app)]));

// Subsequence fuzzy score: contiguous runs and word starts score higher.
function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0;
	let score = 0;
	let streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			streak++;
			score += 1 + streak * 2 + (ti === 0 || t[ti - 1] === " " ? 4 : 0);
			qi++;
		} else {
			streak = 0;
		}
	}
	return qi === q.length ? score : 0;
}

// Tiny arithmetic evaluator: + - * / % ( ) and decimal numbers. No eval.
function evaluateMath(input: string): number | null {
	const tokens = input.match(/\d+\.?\d*|[+\-*/%()]/g);
	if (!tokens || tokens.join("").replace(/\s/g, "") !== input.replace(/\s/g, "")) {
		return null;
	}
	let pos = 0;
	const peek = () => tokens[pos];
	const next = () => tokens[pos++];
	function expr(): number {
		let value = term();
		while (peek() === "+" || peek() === "-") {
			value = next() === "+" ? value + term() : value - term();
		}
		return value;
	}
	function term(): number {
		let value = factor();
		while (peek() === "*" || peek() === "/" || peek() === "%") {
			const op = next();
			const rhs = factor();
			value = op === "*" ? value * rhs : op === "/" ? value / rhs : value % rhs;
		}
		return value;
	}
	function factor(): number {
		if (peek() === "-") {
			next();
			return -factor();
		}
		if (peek() === "(") {
			next();
			const value = expr();
			if (peek() === ")") next();
			return value;
		}
		const token = next();
		if (token === undefined || !/^\d/.test(token)) throw new Error("parse");
		return Number.parseFloat(token);
	}
	try {
		const value = expr();
		return pos === tokens.length && Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

const looksLikeMath = (s: string) => /^[\d\s+\-*/%().]+$/.test(s) && /\d/.test(s);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const [query, setQuery] = signal("");
const [selected, setSelected] = signal(0);
const [flash, setFlash] = signal("");

const results = memo<Entry[]>(() => {
	const q = query().trim();
	if (q.length === 0) {
		return APPS.slice(0, 8).map((app) => APP_ENTRIES.get(app.path)!);
	}
	if (looksLikeMath(q)) {
		const value = evaluateMath(q);
		if (value !== null) {
			const text = String(Math.round(value * 1e10) / 1e10);
			return [
				{
					key: "=calc",
					title: `= ${text}`,
					hint: "Enter copies the result",
					badge: "=",
					action: () => {
						Utils.clipboardWriteText(text);
						setFlash(`copied ${text}`);
						setTimeout(() => setFlash(""), 1400);
					},
				},
			];
		}
	}
	return APPS.map((app) => ({ app, score: fuzzyScore(q, app.name) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 32)
		.map((x) => APP_ENTRIES.get(x.app.path)!);
});

function appEntry(app: { name: string; path: string }): Entry {
	return {
		key: app.path,
		title: app.name,
		hint: app.path,
		badge: app.name[0]?.toUpperCase() ?? "?",
		action: () => {
			Bun.spawn(["open", app.path]);
			hidePalette();
		},
	};
}

live(() => {
	query();
	setSelected(0);
});

function activate(index: number) {
	const entry = inert(results)[index];
	entry?.action();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const ROW_H = 46;
const ROW_GAP = 2;
const LIST_H = 5 * (ROW_H + ROW_GAP);

// Follow-scroll: keep the selected row inside the viewport.
const [listScroll, setListScroll] = signal(0);
live(() => {
	// Clamp scroll into [top + ROW_H - LIST_H, top]: selected row stays visible.
	const top = selected() * (ROW_H + ROW_GAP);
	setListScroll((s) => Math.min(top, Math.max(s, top + ROW_H - LIST_H)));
});

function ResultRow(entry: Entry, index: () => number) {
	ui.row(
		{
			height: ROW_H,
			pad: 8,
			gap: 10,
			radius: 8,
			align: "center",
			bg: live(() => (selected() === index() ? theme.rowSelected : theme.row)),
			onClick: () => {
				setSelected(index());
				activate(index());
			},
		},
		() => {
			ui.box(
				{
					width: 30,
					height: 30,
					radius: 7,
					justify: "center",
					align: "center",
					bg: live(() => (selected() === index() ? theme.accent : "#2a2a3e")),
				},
				() => {
					ui.text(entry.badge, { size: 14, color: theme.textPrimary });
				},
			);
			ui.column({ gap: 2, grow: 1 }, () => {
				ui.text(entry.title, { size: 14, color: theme.textPrimary });
				ui.text(entry.hint, { size: 9, color: theme.textFaint });
			});
			ui.dynamic({}, () => {
				if (selected() === index()) {
					ui.text("enter", { size: 9, color: theme.textMuted });
				}
			});
		},
	);
}

const FULL_W = 620;
const FULL_H = 372;
const PILL_W = 128;
const PILL_H = 46;

const [expanded, setExpanded] = signal(false);
const [activeShortcut, setActiveShortcut] = signal("");

// Persisted window position (drag the pill anywhere; it comes back there).
const prefsPath = join(Utils.paths.userData, "ui-launcher.json");
const savedPrefs = await (async () => {
	try {
		return JSON.parse(await Bun.file(prefsPath).text());
	} catch {
		return {};
	}
})();

function Pill() {
	ui.row(
		{
			grow: 1,
			radius: PILL_H / 2,
			gap: 8,
			justify: "center",
			align: "center",
			bg: theme.panel,
			border: 1,
			borderColor: theme.line,
			windowDrag: true,
			onClick: () => expand(),
		},
		() => {
			ui.box({ width: 8, height: 8, radius: 4, bg: theme.accent });
			ui.text("palette", { size: 13, color: theme.textPrimary });
		},
	);
}

const uiWindow = await createUIWindow(
	{
		title: "Palette",
		width: PILL_W,
		height: PILL_H,
		titleBarStyle: "hidden",
		transparent: true,
		background: "#00000000",
		alwaysOnTop: true,
	},
	() => {
		ui.dynamic({ grow: 1 }, () => {
			if (!expanded()) {
				Pill();
				return;
			}
			Palette();
		});

		onKey((e) => {
			if (!inert(expanded)) return;
			if (e.keyCode === Key.Down) {
				setSelected((i) => Math.min(inert(results).length - 1, i + 1));
			} else if (e.keyCode === Key.Up) {
				setSelected((i) => Math.max(0, i - 1));
			} else if (e.keyCode === Key.Escape) {
				collapse();
			}
		});
	},
);

function Palette() {
	ui.column(
			{
				grow: 1,
				pad: 10,
				gap: 8,
				radius: 14,
				bg: theme.panel,
				border: 1,
				borderColor: theme.line,
			},
			() => {
				textInput({
					value: query,
					onInput: setQuery,
					onSubmit: () => activate(inert(selected)),
					placeholder: "Search apps or type math...",
					autofocus: true,
					size: 17,
					pad: 12,
					bg: "#10101a",
					focusBorderColor: theme.accent,
				});
				ui.box(
					{
						dir: "column",
						height: LIST_H,
						overflow: "scroll",
						scroll: live(listScroll),
					},
					() => {
						ui.each({ dir: "column", gap: ROW_GAP }, results, (e) => e.key, ResultRow);
					},
				);
				ui.row({ pad: 4, gap: 8, align: "center" }, () => {
					ui.text(live(() => `enter runs - esc collapses${activeShortcut() ? ` - ${activeShortcut()} toggles` : ""}`), {
						size: 9,
						color: theme.textFaint,
					});
					ui.spacer();
					ui.text(live(() => flash()), { size: 10, color: theme.good });
					ui.text(live(() => `${results().length} results`), {
						size: 9,
						color: theme.textFaint,
					});
				});
			},
		);
}

function collapse() {
	setQuery("");
	setExpanded(false);
	uiWindow.window.setSize(PILL_W, PILL_H);
}

function expand() {
	setExpanded(true);
	uiWindow.window.setSize(FULL_W, FULL_H);
	uiWindow.window.activate();
}

function hidePalette() {
	// Launching something collapses back to the pill.
	collapse();
}

// Restore the dragged-to position from the last run.
if (typeof savedPrefs.x === "number" && typeof savedPrefs.y === "number") {
	uiWindow.window.setPosition(savedPrefs.x, savedPrefs.y);
}
setInterval(() => {
	const frame = uiWindow.window.getFrame();
	if (frame.x !== savedPrefs.x || frame.y !== savedPrefs.y) {
		savedPrefs.x = frame.x;
		savedPrefs.y = frame.y;
		Bun.write(prefsPath, JSON.stringify(savedPrefs)).catch(() => {});
	}
}, 2000);

// First free shortcut wins (cmd+shift+space is often taken, e.g. by 1Password).
const SHORTCUTS = [
	["CommandOrControl+Shift+Space", "cmd+shift+space"],
	["CommandOrControl+Alt+Space", "cmd+opt+space"],
	["CommandOrControl+Shift+K", "cmd+shift+K"],
] as const;
for (const [accelerator, label] of SHORTCUTS) {
	const ok = GlobalShortcut.register(accelerator, () => {
		if (inert(expanded)) collapse();
		else expand();
	});
	if (ok) {
		setActiveShortcut(label);
		break;
	}
}

console.log("[ui-launcher] running (solid-effects-ok)");
console.log(
	inert(activeShortcut)
		? `[ui-launcher] Toggle with ${inert(activeShortcut)}`
		: "[ui-launcher] No global shortcut available; click the pill",
);
