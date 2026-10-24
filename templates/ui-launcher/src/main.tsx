// Electrobun UI command palette: an always-on-top pill you can drag anywhere
// on screen; click it (or hit the global shortcut) to expand into a palette
// that's a calculator when you type math and an app launcher otherwise.
// Rendered by electrobun/main/ui — HTML/CSS + JSX drawn straight to the GPU,
// no webview resident in memory for a surface that idles 98% of the time.

import { GlobalShortcut, Utils } from "electrobun/main";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUIWindow, For, Show, inert, live, memo, signal, type UINode } from "electrobun/main/ui";

const css = `
	:root {
		--panel: #16161eee; --line: #2a2a3e; --selected: #262649; --input: #10101a;
		--text: #e4e4f0; --muted: #8c8ca8; --faint: #616178; --accent: #9d7cd8; --good: #9ece6a;
	}
	html, body { margin: 0; height: 100%; font: 13px system-ui; color: var(--text); }
	body { display: flex; }

	.pill {
		flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
		border-radius: 23px; background: var(--panel); border: 1px solid var(--line);
		-webkit-app-region: drag; cursor: pointer;
	}
	.pill .dot { width: 8px; height: 8px; border-radius: 4px; background: var(--accent); }

	.palette {
		flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 10px;
		border-radius: 14px; background: var(--panel); border: 1px solid var(--line);
	}
	.search {
		font: 17px system-ui; color: var(--text); padding: 12px; border-radius: 10px;
		background: var(--input); border: 1px solid var(--line); outline: none;
	}
	.search:focus { border-color: var(--accent); }
	.search::placeholder { color: var(--faint); }

	.results { height: 240px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
	.row {
		flex-shrink: 0; height: 46px; box-sizing: border-box; padding: 8px; gap: 10px;
		display: flex; align-items: center; border-radius: 8px; cursor: default;
	}
	.row.selected { background: var(--selected); }
	.badge {
		width: 30px; height: 30px; border-radius: 7px; background: var(--line);
		display: flex; align-items: center; justify-content: center; font-size: 14px;
	}
	.row.selected .badge { background: var(--accent); }
	.titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.title { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.hint { font-size: 9px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.enter { font-size: 9px; color: var(--muted); visibility: hidden; }
	.row.selected .enter { visibility: visible; }

	.footer { display: flex; align-items: center; gap: 8px; padding: 4px; font-size: 9px; color: var(--faint); }
	.footer .grow { flex: 1; }
	.footer .flash { font-size: 10px; color: var(--good); }
`;

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

const [query, writeQuery] = signal("");
const [selected, setSelected] = signal(0);
const [flash, setFlash] = signal("");
const [expanded, setExpanded] = signal(false);
const [activeShortcut, setActiveShortcut] = signal("");

function setQuery(value: string) {
	writeQuery(value);
	setSelected(0);
}

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
			collapse();
		},
	};
}

function activate(index: number) {
	inert(results)[index]?.action();
}

// Row elements by entry key, for keyboard follow-scroll.
const rowElements = new Map<string, UINode>();

function select(index: number) {
	const list = inert(results);
	const next = Math.max(0, Math.min(list.length - 1, index));
	setSelected(next);
	const key = list[next]?.key;
	if (key) rowElements.get(key)?.scrollIntoView();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function ResultRow(entry: Entry, index: () => number) {
	return (
		<div
			class={live(() => (selected() === index() ? "row selected" : "row"))}
			ref={(el: UINode) => rowElements.set(entry.key, el)}
			onClick={() => {
				setSelected(index());
				activate(index());
			}}
		>
			<div class="badge">{entry.badge}</div>
			<div class="titles">
				<div class="title">{entry.title}</div>
				<div class="hint">{entry.hint}</div>
			</div>
			<div class="enter">enter</div>
		</div>
	);
}

function Pill() {
	// the pill is a window-drag region; a press that doesn't drag still clicks
	return (
		<div class="pill" onClick={expand}>
			<div class="dot" />
			<span>palette</span>
		</div>
	);
}

function Palette() {
	return (
		<div class="palette">
			<input
				class="search"
				placeholder="Search apps or type math..."
				autofocus
				onInput={(e: { target: { value: string } }) => setQuery(e.target.value)}
			/>
			<div class="results">
				<For each={live(results)} key={(e) => e.key}>
					{ResultRow}
				</For>
			</div>
			<div class="footer">
				<span>
					{live(() => `enter runs - esc collapses${activeShortcut() ? ` - ${activeShortcut()} toggles` : ""}`)}
				</span>
				<span class="grow" />
				<span class="flash">{live(flash)}</span>
				<span>{live(() => `${results().length} results`)}</span>
			</div>
		</div>
	);
}

const FULL_W = 620;
const FULL_H = 372;
const PILL_W = 128;
const PILL_H = 46;

// Persisted window position (drag the pill anywhere; it comes back there).
const prefsPath = join(Utils.paths.userData, "ui-launcher.json");
const savedPrefs = await (async () => {
	try {
		return JSON.parse(await Bun.file(prefsPath).text());
	} catch {
		return {};
	}
})();

const { window: paletteWindow, ui } = createUIWindow(
	{
		title: "Palette",
		width: PILL_W,
		height: PILL_H,
		titleBarStyle: "hidden",
		transparent: true,
		alwaysOnTop: true,
		css,
	},
	() => (
		<Show when={live(expanded)} fallback={<Pill />}>
			<Palette />
		</Show>
	),
);

// Keys bubble to <body> from whatever has focus (the search box).
ui.body.addEventListener("keydown", (e: { key: string }) => {
	if (!inert(expanded)) return;
	if (e.key === "ArrowDown") select(inert(selected) + 1);
	else if (e.key === "ArrowUp") select(inert(selected) - 1);
	else if (e.key === "Enter") activate(inert(selected));
	else if (e.key === "Escape") collapse();
});

function collapse() {
	rowElements.clear();
	setQuery("");
	setExpanded(false);
	paletteWindow.setSize(PILL_W, PILL_H);
}

function expand() {
	paletteWindow.setSize(FULL_W, FULL_H);
	setExpanded(true);
	paletteWindow.activate();
}

// Restore the dragged-to position from the last run.
if (typeof savedPrefs.x === "number" && typeof savedPrefs.y === "number") {
	paletteWindow.setPosition(savedPrefs.x, savedPrefs.y);
}
setInterval(() => {
	const frame = paletteWindow.getFrame();
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

console.log("[ui-launcher] running");
console.log(
	inert(activeShortcut)
		? `[ui-launcher] Toggle with ${inert(activeShortcut)}`
		: "[ui-launcher] No global shortcut available; click the pill",
);
