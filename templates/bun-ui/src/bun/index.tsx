// A Bun main process rendering its window with Electrobun UI: HTML/CSS + JSX
// laid out and painted by the Zig UI engine straight to the GPU — no webview.
// The eb-* classes come from the built-in component stylesheet
// (`components: true`); everything else is plain CSS below.

import { createUIWindow, For, live, memo, Show, signal, store, type UIEvent } from "electrobun/main/ui";

const css = /* css */ `
	body { margin: 0 }
	.shell { height: 100vh; display: flex; flex-direction: column }
	header { display: flex; align-items: center; gap: 12px; padding: 14px 20px 14px 84px;
	         border-bottom: 1px solid var(--eb-border); -webkit-app-region: drag }
	header .eb-title { margin: 0; font-size: 17px }
	header .spacer { flex: 1 }
	header label { -webkit-app-region: no-drag }
	main { flex: 1; overflow: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px }
	.add { display: flex; gap: 8px; align-items: flex-end }
	.add .eb-field { flex: 1; margin: 0 }
	.toolbar { display: flex; align-items: center; justify-content: space-between }
	.tasks { padding: 2px 14px }
	.task { display: flex; align-items: center; gap: 10px }
	.task .text { flex: 1 }
	.task.done .text { text-decoration: line-through; color: var(--eb-muted) }
	.empty { padding: 28px; text-align: center; color: var(--eb-muted) }
	footer { padding: 10px 20px; border-top: 1px solid var(--eb-border); color: var(--eb-muted); font-size: 12px }
`;

// ---------------------------------------------------------------------------
// State: a store for the tasks, signals for UI state, memos for derived data
// ---------------------------------------------------------------------------

type Priority = "low" | "normal" | "high";
type Task = { id: number; text: string; priority: Priority; done: boolean };
type Filter = "all" | "active" | "done";

let nextId = 1;
const task = (text: string, priority: Priority, done = false): Task => ({ id: nextId++, text, priority, done });

const [state, setState] = store({
	tasks: [
		task("Read the Electrobun UI guide", "normal", true),
		task("Style it with plain CSS", "high"),
		task("Ship a GPU-rendered app", "normal"),
	] as Task[],
});
const [draft, setDraft] = signal("");
const [priority, setPriority] = signal<Priority>("normal");
const [filter, setFilter] = signal<Filter>("all");
const [dark, setDark] = signal(false);

const visible = memo(() =>
	state.tasks.filter((t) => (filter() === "all" ? true : filter() === "done" ? t.done : !t.done)),
);
const remaining = memo(() => state.tasks.filter((t) => !t.done).length);

function addTask() {
	const text = draft().trim();
	if (!text) return;
	setState((s) => {
		s.tasks.push(task(text, priority()));
	});
	setDraft("");
}

function toggle(id: number) {
	setState((s) => {
		const t = s.tasks.find((t) => t.id === id);
		if (t) t.done = !t.done;
	});
}

function remove(id: number) {
	setState((s) => {
		s.tasks = s.tasks.filter((t) => t.id !== id);
	});
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const badge: Record<Priority, string> = { low: "eb-badge", normal: "eb-badge primary", high: "eb-badge danger" };

function TaskRow(props: { task: Task }) {
	const t = props.task;
	return (
		<div class={live(() => (t.done ? "eb-list-item task done" : "eb-list-item task"))}>
			<input class="eb-checkbox" type="checkbox" checked={live(() => t.done)} onChange={() => toggle(t.id)} />
			<span class="text">{t.text}</span>
			<span class={badge[t.priority]}>{t.priority}</span>
			<button class="eb-btn ghost sm" aria-label={`Delete ${t.text}`} onClick={() => remove(t.id)}>
				✕
			</button>
		</div>
	);
}

function App() {
	return (
		<div class="eb-app shell">
			<header>
				<h1 class="eb-title">Tasks</h1>
				<span class="eb-badge">{live(() => `${remaining()} left`)}</span>
				<div class="spacer" />
				<label class="eb-check-row">
					<span class="eb-switch">
						<input type="checkbox" checked={live(dark)} onChange={(e: UIEvent) => toggleDark(Boolean(e.target?.checked))} />
						<span />
					</span>
					Dark
				</label>
			</header>

			<main>
				{/* Enter in the input and the Add button both submit the form */}
				<form class="add" onSubmit={addTask}>
					<label class="eb-field">
						<span class="eb-label">New task</span>
						<input
							class="eb-input"
							placeholder="What needs doing? (Enter to add)"
							value={live(draft)}
							onInput={(e: UIEvent) => setDraft(e.data)}
						/>
					</label>
					<select class="eb-select" style="width: 120px" onChange={(e: UIEvent) => setPriority(e.data as Priority)}>
						<option value="low">Low</option>
						<option value="normal" selected>
							Normal
						</option>
						<option value="high">High</option>
					</select>
					<button class="eb-btn" type="submit">
						Add
					</button>
				</form>

				<div class="toolbar">
					<div class="eb-tabs" role="tablist">
						<For each={["all", "active", "done"] as Filter[]}>
							{(f) => (
								<button
									class="eb-tab"
									role="tab"
									aria-selected={live(() => String(filter() === f))}
									onClick={() => setFilter(f)}
								>
									{f[0]!.toUpperCase() + f.slice(1)}
								</button>
							)}
						</For>
					</div>
					<button
						class="eb-btn outline sm"
						onClick={() =>
							setState((s) => {
								s.tasks = s.tasks.filter((t) => !t.done);
							})
						}
					>
						Clear completed
					</button>
				</div>

				<div class="eb-card tasks">
					<div class="eb-list">
						<For each={live(visible)} key={(t) => t.id}>
							{(t) => <TaskRow task={t} />}
						</For>
					</div>
					<Show when={live(() => visible().length === 0)}>
						<div class="empty">Nothing here.</div>
					</Show>
				</div>
			</main>

			<footer>Rendered by Electrobun UI from a Bun main process — no webview.</footer>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const app = createUIWindow(
	{
		title: "Tasks",
		width: 640,
		height: 620,
		titleBarStyle: "hiddenInset",
		components: true,
		css,
	},
	App,
);

// The eb-* theme follows prefers-color-scheme; setDark overrides it.
function toggleDark(on: boolean) {
	setDark(on);
	app.ui.setDark(on);
}
