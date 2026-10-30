/** @jsxImportSource electrobun/main/ui */
// Interactive kitchen sink for the native GPU UI: no webview — the Zig UI
// core lays out, styles and paints HTML/CSS + warren JSX through Dawn.

import { defineTest } from "../../test-framework/types";
import { GpuWindow } from "electrobun/main";
import { createUI, isUIAvailable, live, signal, store, memo, For, Show, Portal } from "electrobun/main/ui";

const css = `
	body { margin: 0; }
	.shell { display: flex; height: 100vh; }
	.side { width: 190px; padding: 14px 10px; border-right: 1px solid var(--eb-border); display: flex; flex-direction: column; gap: 2px; }
	.main { flex: 1; overflow: auto; padding: 22px 26px; display: flex; flex-direction: column; gap: 18px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
	.swatch { height: 46px; border-radius: 8px; }
	.ball { width: 28px; height: 28px; border-radius: 50%; background: var(--eb-primary); animation: bounce 1s ease-in-out infinite alternate; }
	@keyframes bounce { to { transform: translateX(180px); background: #f97316; } }
	.spin { width: 36px; height: 36px; background: conic-gradient(#6366f1, #ec4899, #f59e0b, #6366f1); border-radius: 10px; animation: rot 2s linear infinite; }
	@keyframes rot { to { transform: rotate(360deg); } }
	.grow { height: 24px; border-radius: 6px; background: linear-gradient(90deg, #22c55e, #0ea5e9); transition: width .5s cubic-bezier(.2,.9,.3,1.3); }
	.done { text-decoration: line-through; color: var(--eb-muted); }
	.glass { padding: 16px; border-radius: 14px; background: rgba(255,255,255,.25); backdrop-filter: blur(8px); box-shadow: 0 8px 30px rgba(0,0,0,.18); }
	.photo { height: 120px; border-radius: 14px; padding: 18px; background: radial-gradient(circle at 30% 30%, #fde68a, #f472b6 45%, #6366f1); display: flex; align-items: end; }
	.tile { padding: 10px 12px; border: 1px solid var(--eb-border); border-radius: 10px; background: var(--eb-surface); }
	.rows > div { padding: 8px 10px; border-bottom: 1px solid var(--eb-border); }
	.rows > div:nth-child(odd) { background: var(--eb-secondary); }
	.text-demo p { margin: 0 0 8px; line-height: 1.5; }
`;

type Todo = { id: number; text: string; done: boolean };

function KitchenSink(props: { toggleDark: () => void; diagnosticBufferLength?: () => number }) {
	const [page, setPage] = signal(process.env["NATIVE_UI_SINK_PAGE"] || "Components");
	const [count, setCount] = signal(0);
	const [form, setForm] = store({ name: "", email: "", plan: "pro", notify: true, volume: 40, bio: "" });
	const [todos, setTodos] = signal<Todo[]>([
		{ id: 1, text: "Render without a webview", done: true },
		{ id: 2, text: "Fine-grained reactivity in Zig", done: true },
		{ id: 3, text: "Ship it", done: false },
	]);
	const [draft, setDraft] = signal("");
	const [progress, setProgress] = signal(35);
	const [wide, setWide] = signal(false);
	const [tab, setTab] = signal("One");
	const [dialog, setDialog] = signal(false);
	const changeDialog = (open: boolean, action: "Open" | "Cancel") => {
		const trace = (phase: string) => {
			if (props.diagnosticBufferLength) {
				console.log("[ebui fixture] " + JSON.stringify({
					action, phase, wallTimeMs: Date.now(), dialog: dialog(),
					bufferBytes: props.diagnosticBufferLength(),
				}));
			}
		};
		trace("handler-before");
		setDialog(open);
		trace("handler-after");
		if (props.diagnosticBufferLength) {
			// Observe after the setter's already-queued work; never force a flush.
			queueMicrotask(() => trace("queued-after-setter"));
		}
	};
	const [toasts, setToasts] = signal<{ id: number; msg: string }[]>([]);
	const remaining = memo(() => todos().filter((t) => !t.done).length);
	let nextId = 4;

	const toast = (msg: string) => {
		const id = nextId++;
		setToasts((t) => [...t, { id, msg }]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2500);
	};
	const addTodo = () => {
		const text = draft().trim();
		if (!text) return;
		setTodos((t) => [...t, { id: nextId++, text, done: false }]);
		setDraft("");
	};
	const pages = ["Components", "Forms", "Todo", "Motion", "Text", "Layout"];

	return (
		<div class="eb-app shell">
			<nav class="side eb-nav">
				<div class="eb-title" style="padding: 4px 10px 12px">Native UI</div>
				<For each={pages}>
					{(p) => (
						<button class="eb-nav-item" aria-current={live(() => (page() === p ? "page" : undefined))} onClick={() => setPage(p)}>
							{p}
						</button>
					)}
				</For>
				<div class="eb-grow" />
				<button class="eb-btn outline sm" onClick={props.toggleDark}>Toggle dark mode</button>
			</nav>

			<main class="main">
				<Show when={live(() => page() === "Components")}>
					<h2 class="eb-title">Components</h2>
					<div class="eb-row" style="gap: 8px; flex-wrap: wrap">
						<button class="eb-btn" onClick={() => setCount((c) => c + 1)}>{live(() => `Clicked ${count()}×`)}</button>
						<button class="eb-btn secondary" onClick={() => toast("Saved!")}>Show toast</button>
						<button class="eb-btn outline" onClick={() => changeDialog(true, "Open")}>Open dialog</button>
						<button class="eb-btn ghost">Ghost</button>
						<button class="eb-btn danger">Danger</button>
						<button class="eb-btn" disabled>Disabled</button>
					</div>
					<div class="eb-row" style="gap: 6px">
						<span class="eb-badge">Default</span>
						<span class="eb-badge primary">Primary</span>
						<span class="eb-badge danger">Danger</span>
						<span class="eb-kbd">⌘K</span>
						<span class="eb-spinner" />
					</div>
					<div class="grid">
						<div class="eb-card">
							<div class="eb-card-header">
								<div class="eb-card-title">Card</div>
								<div class="eb-card-desc">Borders, radii, shadows and text — all SDF on the GPU.</div>
							</div>
							<div class="eb-card-body">
								<div class="eb-progress"><div style={live(() => `width: ${progress()}%`)} /></div>
							</div>
							<div class="eb-card-footer">
								<button class="eb-btn sm" onClick={() => setProgress((p) => (p >= 100 ? 0 : p + 15))}>Advance</button>
							</div>
						</div>
						<div class="eb-alert">
							<div>
								<div class="eb-alert-title">Heads up</div>
								Hover the nav, Tab through controls, try VoiceOver (⌘F5).
							</div>
						</div>
						<div class="photo"><div class="glass">backdrop-filter: blur</div></div>
					</div>
					<div class="eb-tabs" role="tablist" style="align-self: start">
						<For each={["One", "Two", "Three"]}>
							{(t) => <button class="eb-tab" role="tab" aria-selected={live(() => String(tab() === t))} onClick={() => setTab(t)}>{t}</button>}
						</For>
					</div>
					<div class="eb-row" style="gap: 8px">
						<For each={["#ef4444", "#f59e0b", "#22c55e", "#0ea5e9", "#6366f1", "#ec4899"]}>
							{(c) => <div class="swatch eb-grow" style={`background: ${c}`} />}
						</For>
					</div>
				</Show>

				<Show when={live(() => page() === "Forms")}>
					<h2 class="eb-title">Forms</h2>
					<div class="grid">
						<div class="eb-col" style="gap: 12px">
							<label class="eb-field"><span class="eb-label">Name</span>
								<input class="eb-input" placeholder="Ada Lovelace" value={live(() => form.name)} onInput={(e: any) => setForm((d) => { d.name = e.target.value; })} /></label>
							<label class="eb-field"><span class="eb-label">Email</span>
								<input class="eb-input" type="email" placeholder="ada@example.com" value={live(() => form.email)} onInput={(e: any) => setForm((d) => { d.email = e.target.value; })} /></label>
							<label class="eb-field"><span class="eb-label">Password</span><input class="eb-input" type="password" /></label>
							<label class="eb-field"><span class="eb-label">Plan</span>
								<select class="eb-select" onChange={(e: any) => setForm((d) => { d.plan = e.target.value; })}>
									<option value="free">Free</option><option value="pro" selected>Pro</option><option value="team">Team</option>
								</select></label>
							<label class="eb-field"><span class="eb-label">Bio</span>
								<textarea class="eb-textarea" rows="3" onInput={(e: any) => setForm((d) => { d.bio = e.target.value; })} /></label>
							<label class="eb-check-row"><span class="eb-switch"><input type="checkbox" checked={live(() => form.notify)} onChange={(e: any) => setForm((d) => { d.notify = e.target.checked; })} /><span /></span> Email notifications</label>
							<label class="eb-check-row"><input class="eb-checkbox" type="checkbox" /> I agree</label>
							<div class="eb-row" style="gap: 12px">
								<label class="eb-check-row"><input class="eb-radio" type="radio" name="r" checked /> Monthly</label>
								<label class="eb-check-row"><input class="eb-radio" type="radio" name="r" /> Yearly</label>
							</div>
							<label class="eb-field"><span class="eb-label">{live(() => `Volume ${form.volume}`)}</span>
								<input class="eb-slider" type="range" min="0" max="100" value={live(() => String(form.volume))} onInput={(e: any) => setForm((d) => { d.volume = Number(e.target.value); })} /></label>
						</div>
						<div class="eb-card">
							<div class="eb-card-header"><div class="eb-card-title">Live values</div></div>
							<div class="eb-card-body rows">
								<div>{live(() => `name: ${form.name || "—"}`)}</div>
								<div>{live(() => `email: ${form.email || "—"}`)}</div>
								<div>{live(() => `plan: ${form.plan}`)}</div>
								<div>{live(() => `notify: ${form.notify}`)}</div>
								<div>{live(() => `volume: ${form.volume}`)}</div>
								<div>{live(() => `bio: ${form.bio.length} chars`)}</div>
							</div>
						</div>
					</div>
				</Show>

				<Show when={live(() => page() === "Todo")}>
					<h2 class="eb-title">{live(() => `Todo — ${remaining()} left`)}</h2>
					<div class="eb-row" style="gap: 8px">
						<input class="eb-input eb-grow" placeholder="What needs doing? (Enter to add)" value={live(draft)}
							onInput={(e: any) => setDraft(e.target.value)} onKeyDown={(e: any) => e.key === "Enter" && addTodo()} />
						<button class="eb-btn" onClick={addTodo}>Add</button>
					</div>
					<div class="eb-list">
						<For each={live(todos)} key={(t: Todo) => t.id}>
							{(t: Todo) => (
								<div class="eb-list-item">
									<input class="eb-checkbox" type="checkbox" checked={t.done}
										onChange={() => setTodos((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
									<span class={t.done ? "eb-grow done" : "eb-grow"}>{t.text}</span>
									<button class="eb-btn ghost sm" aria-label={`Delete ${t.text}`} onClick={() => setTodos((all) => all.filter((x) => x.id !== t.id))}>✕</button>
								</div>
							)}
						</For>
					</div>
				</Show>

				<Show when={live(() => page() === "Motion")}>
					<h2 class="eb-title">Motion</h2>
					<div class="ball" />
					<div class="spin" />
					<div class="grow" style={live(() => `width: ${wide() ? 420 : 120}px`)} />
					<div class="eb-row" style="gap: 8px">
						<button class="eb-btn" onClick={() => setWide((w) => !w)}>Toggle transition</button>
						<button class="eb-btn secondary" onClick={() => toast(`Toast at ${new Date().toLocaleTimeString()}`)}>Toast (enter animation)</button>
					</div>
					<div class="eb-tooltip-host" style="align-self: start">
						<button class="eb-btn outline">Hover me</button>
						<div class="eb-tooltip">Tooltips are CSS :hover</div>
					</div>
				</Show>

				<Show when={live(() => page() === "Text")}>
					<h2 class="eb-title">Text</h2>
					<div class="text-demo" style="max-width: 560px">
						<p style="font-size: 28px; font-weight: 700; letter-spacing: -0.5px">Display heading</p>
						<p>Body text wraps across lines with <b>bold</b>, <i>italic</i>, <u>underline</u>, <code>code</code> and <a href="#">links</a>. Emoji 🎉🚀 and CJK 日本語 use font fallback.</p>
						<p style="text-align: center; color: var(--eb-muted)">Centered muted text</p>
						<p style="-webkit-line-clamp: 2; display: -webkit-box; overflow: hidden">Line clamp: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
						<p style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">Ellipsis: this single line is far too long to fit in the box so it ends with an ellipsis character.</p>
					</div>
					<label class="eb-field"><span class="eb-label">Editing & IME — select with shift+arrows, ⌘A/⌘C/⌘V, double-click a word, try Japanese input</span>
						<textarea class="eb-textarea" rows="4">Edit me. 編集してください。</textarea></label>
				</Show>

				<Show when={live(() => page() === "Layout")}>
					<h2 class="eb-title">Layout & scrolling</h2>
					<div style="display: grid; grid-template-columns: 1fr 2fr 1fr; grid-template-rows: 60px 60px; gap: 8px">
						<div class="tile" style="grid-row: span 2">span 2 rows</div>
						<div class="tile">2fr</div>
						<div class="tile">1fr</div>
						<div class="tile" style="grid-column: 2 / 4">columns 2–4</div>
					</div>
					<div class="eb-row" style="gap: 8px; align-items: stretch">
						<div class="tile" style="flex: 1">flex: 1</div>
						<div class="tile" style="flex: 2; height: 60px">flex: 2 (60px tall, siblings stretch)</div>
						<div class="tile" style="width: 90px">90px</div>
					</div>
					<div class="eb-scroll rows" style="height: 220px; border: 1px solid var(--eb-border); border-radius: 10px">
						{Array.from({ length: 200 }, (_, i) => <div>Scrollable row {i + 1}</div>)}
					</div>
				</Show>
			</main>

			<Show when={live(dialog)}>
				<Portal>
					<div class="eb-overlay" onClick={(e: any) => e.target === e.currentTarget && setDialog(false)}>
						<div class="eb-dialog" role="dialog">
							<div class="eb-dialog-header">
								<div class="eb-dialog-title">Dialog</div>
								<div class="eb-dialog-desc">Rendered in a Portal over a blurred backdrop.</div>
							</div>
							<div class="eb-dialog-footer">
								<button class="eb-btn outline" onClick={() => changeDialog(false, "Cancel")}>Cancel</button>
								<button class="eb-btn" onClick={() => { setDialog(false); toast("Confirmed"); }}>Confirm</button>
							</div>
						</div>
					</div>
				</Portal>
			</Show>

			<div class="eb-toasts">
				<For each={live(toasts)} key={(t) => t.id}>
					{(t) => <div class="eb-toast">{t.msg}</div>}
				</For>
			</div>
		</div>
	);
}

export const nativeUiInteractiveTests = [
	defineTest({
		name: "Native GPU UI kitchen sink",
		category: "Native UI",
		description:
			"electrobun/main/ui: JSX + CSS laid out and painted by the Zig UI core through Dawn, no webview. Component gallery, forms, todo, motion, text editing and layout.",
		instructions: [
			"A GpuWindow opened rendering the native UI kitchen sink (no webview).",
			"1. Components: buttons hover/press, counter increments, toast slides in, dialog opens over a blurred backdrop.",
			"2. Forms: typing updates the Live values card; select popup, switch, checkbox, radio and slider all work; Tab moves focus with a ring.",
			"3. Todo: Enter adds, checkbox toggles strike-through, ✕ deletes; header count updates.",
			"4. Motion: ball bounces, square spins, transition toggles smoothly.",
			"5. Text: wrapping, fallback emoji/CJK, clamp + ellipsis; edit the textarea (selection, copy/paste, IME).",
			"6. Layout: grid/flex render correctly; the 200-row list scrolls smoothly with the trackpad.",
			"7. Resize the window — layout reflows live. Toggle dark mode in the sidebar.",
			"Close the window when you are done.",
		],
		interactive: true,
		timeout: 900000,
		async run({ log }) {
			if (!isUIAvailable()) throw new Error("libElectrobunUI not found (is bundleWGPU enabled?)");
			const win = new GpuWindow({ title: "Native UI kitchen sink", frame: { x: 160, y: 90, width: 980, height: 760 } });
			const ui = createUI(win, { css, components: true });
			let dark = !!process.env["NATIVE_UI_SINK_DARK"];
			if (dark) ui.setDark(true);
			ui.render(() => <KitchenSink toggleDark={() => ui.setDark((dark = !dark))}
				diagnosticBufferLength={process.env["EBUI_EVENT_TIMING"] === "1" ? () => ui.document.buf.len : undefined} />);
			log("kitchen sink rendered");
			await new Promise<void>((resolve) => win.on("close", () => resolve()));
		},
	}),
];
