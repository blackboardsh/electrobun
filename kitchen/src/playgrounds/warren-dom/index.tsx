/** @jsxImportSource electrobun/browser/ui */
// Warren's DOM renderer running in a real webview: same reactivity core and
// JSX semantics as the GPU renderer, rendered into the page. Includes a
// self-test that verifies keyed reconciliation against real DOM identity.

import {
	For,
	Portal,
	Show,
	live,
	memo,
	render,
	signal,
	store,
} from "electrobun/browser/ui";

interface Row {
	id: number;
	label: string;
}

let nextId = 4;

function App() {
	const [count, setCount] = signal(0);
	const doubled = memo(() => count() * 2);
	const [name, setName] = signal("");
	const [modalOpen, setModalOpen] = signal(false);
	const [state, setState] = store({
		rows: [
			{ id: 1, label: "alpha" },
			{ id: 2, label: "beta" },
			{ id: 3, label: "gamma" },
		] as Row[],
	});

	return (
		<div>
			<h1>Warren DOM renderer</h1>
			<p class="hint">
				electrobun/browser/ui — compiler-less JSX, explicit live() reactivity,
				real DOM.
			</p>

			<section>
				<h2>Signals + memo</h2>
				<div class="count">{live(() => `${count()} (doubled: ${doubled()})`)}</div>
				<div style={{ marginTop: "10px" }}>
					<button onClick={() => setCount((c) => c - 1)}>- 1</button>
					<button onClick={() => setCount((c) => c + 1)}>+ 1</button>
					<button onClick={() => setCount(0)}>Reset</button>
				</div>
			</section>

			<section>
				<h2>Text input (explicit two-way)</h2>
				<input
					type="text"
					placeholder="type here..."
					value={live(name)}
					onInput={(e: any) => setName(e.target.value)}
				/>
				<span style={{ marginLeft: "10px", color: "#8c8ca8" }}>
					{live(() => (name() ? `hello, ${name()}` : "waiting..."))}
				</span>
			</section>

			<section>
				<h2>Keyed list (For) — reorder keeps DOM identity</h2>
				<div style={{ marginBottom: "8px" }}>
					<button id="btn-add" onClick={() =>
						setState((s) => s.rows.push({ id: nextId, label: `row ${nextId++}` }))
					}>Add</button>
					<button id="btn-reverse" onClick={() => setState((s) => s.rows.reverse())}>
						Reverse
					</button>
					<button id="btn-drop" onClick={() => setState((s) => void s.rows.shift())}>
						Drop first
					</button>
				</div>
				<ul id="rows">
					<For
						each={live(() => state.rows.slice())}
						key={(row: Row) => row.id}
						fallback={<li>(empty)</li>}
					>
						{(row: Row, index) => (
							<li classList={live(() => ({ hot: index() === 0 }))}>
								<span>{row.label}</span>
								<span>{live(() => `#${index()}`)}</span>
							</li>
						)}
					</For>
				</ul>
			</section>

			<section>
				<h2>Portal</h2>
				<button id="btn-modal" onClick={() => setModalOpen(true)}>
					Open modal (renders into body)
				</button>
				<Show when={live(modalOpen)}>
					<Portal>
						<div class="portal-card" id="modal">
							<p>Portal content — mounted under document.body.</p>
							<button onClick={() => setModalOpen(false)}>Close</button>
						</div>
					</Portal>
				</Show>
			</section>

			<section>
				<h2>Self-test</h2>
				<div id="selftest">running...</div>
			</section>
		</div>
	);
}

function runSelfTest(root: Element): void {
	const failures: string[] = [];
	const check = (label: string, ok: boolean) => {
		if (!ok) failures.push(label);
	};
	const rows = () =>
		Array.from(root.querySelectorAll<HTMLElement>("#rows li"));
	const click = (selector: string) =>
		root.querySelector<HTMLElement>(selector)!.click();

	check("initial rows render", rows().length === 3);
	check(
		"initial order",
		rows().map((r) => r.textContent).join("|") === "alpha#0|beta#1|gamma#2",
	);
	const [first, , third] = rows();

	click("#btn-reverse");
	check("reversed order", rows()[0]?.textContent === "gamma#0");
	check("identity preserved across reorder", rows()[0] === third && rows()[2] === first);
	check("classList tracks index", rows()[0]!.classList.contains("hot"));

	click("#btn-drop");
	check("drop removes a row", rows().length === 2);
	check("dropped row detached", !document.contains(third!));

	click("#btn-add");
	check("add appends", rows().length === 3 && /row \d/.test(rows()[2]!.textContent ?? ""));

	click("#btn-modal");
	const modal = document.getElementById("modal");
	check("portal mounts in body", modal?.parentElement === document.body);
	modal?.querySelector("button")?.click();
	check("portal cleanup on close", document.getElementById("modal") === null);

	const banner = document.getElementById("selftest")!;
	if (failures.length === 0) {
		banner.textContent = "PASS — reconciliation, identity, portal, cleanup all good";
		banner.className = "pass";
	} else {
		banner.textContent = `FAIL: ${failures.join("; ")}`;
		banner.className = "fail";
	}
}

const container = document.getElementById("app")!;
render(() => <App />, container);
runSelfTest(container);
