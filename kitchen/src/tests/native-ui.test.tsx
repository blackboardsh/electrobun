/** @jsxImportSource electrobun/main/ui */
// Automated tests for the native GPU UI (electrobun/main/native-ui): HTML/CSS
// and warren JSX rendered by the Zig UI core into a GpuWindow through Dawn.
// Input is synthesized through the same engine path native events take.

import { defineTest, expect, sleep } from "../test-framework/types";
import { GpuWindow, WGPUView } from "electrobun/main";
import { createUI, isUIAvailable, live, signal, store, For, type UI } from "electrobun/main/ui";

async function withUI(
	title: string,
	css: string,
	app: () => unknown,
	fn: (ui: UI, win: GpuWindow) => Promise<void>,
	size = { width: 480, height: 360 },
) {
	if (!isUIAvailable()) throw new Error("libElectrobunUI not found (is bundleWGPU enabled?)");
	const win = new GpuWindow({ title, frame: { x: 120, y: 120, ...size } });
	const ui = createUI(win, { css, components: true });
	try {
		ui.render(app);
		await ui.nextFrame();
		await ui.nextFrame();
		await fn(ui, win);
	} finally {
		ui.destroy();
		win.close();
		await sleep(50);
	}
}

function near(actual: number[], expected: number[], tol = 6) {
	for (let i = 0; i < expected.length; i++) {
		if (Math.abs((actual[i] ?? 0) - expected[i]!) > tol) {
			throw new Error(`pixel ${JSON.stringify(actual)} != ${JSON.stringify(expected)} (±${tol})`);
		}
	}
}

const base = `body { margin: 0; font: 14px system-ui; background: #ffffff; }`;

export const nativeUiTests = [
	defineTest({
		name: "Native UI renders HTML/CSS into a GpuWindow",
		category: "Native UI",
		description: "Background, borders and layout reach the screen through Dawn; frames are presented on demand.",
		async run({ log }) {
			await withUI(
				"native-ui-render",
				`${base} .box { position: absolute; left: 40px; top: 30px; width: 120px; height: 80px; background: rgb(200, 30, 60); border-radius: 12px; }`,
				() => <div class="box" id="box" />,
				async (ui) => {
					expect(ui.frames).toBeGreaterThan(0);
					near(await ui.pixel(100, 70), [200, 30, 60, 255]);
					near(await ui.pixel(300, 200), [255, 255, 255, 255]);
					// rounded corner is cut
					const corner = await ui.pixel(41, 31);
					expect(corner[0]).toBeGreaterThan(240);
					const r = ui.querySelector("#box")!.getBoundingClientRect();
					expect(r.width).toBe(120);
					expect(r.height).toBe(80);
					log(`frames=${ui.frames} box=${r.x},${r.y} ${r.width}x${r.height}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: JSX reactivity drives fine-grained native updates",
		category: "Native UI",
		description: "live() bindings update attributes, styles and text in place; keyed For moves rows.",
		async run({ log }) {
			const [width, setWidth] = signal(100);
			const [items, setItems] = signal(["a", "b", "c"]);
			await withUI(
				"native-ui-reactive",
				`${base} .bar { height: 20px; background: #4f46e5 } li { height: 20px }`,
				() => (
					<div>
						<div class="bar" id="bar" style={live(() => `width: ${width()}px`)} />
						<ul id="list">
							<For each={live(items)} key={(s) => s}>{(s) => <li id={`li-${s}`}>{s}</li>}</For>
						</ul>
					</div>
				),
				async (ui) => {
					expect(ui.querySelector("#bar")!.getBoundingClientRect().width).toBe(100);
					setWidth(260);
					await ui.nextFrame();
					expect(ui.querySelector("#bar")!.getBoundingClientRect().width).toBe(260);
					const liC = ui.querySelector("#li-c")!;
					const yBefore = liC.getBoundingClientRect().y;
					setItems(["c", "a", "b"]);
					await ui.nextFrame();
					expect(ui.querySelector("#li-c")).toBe(liC); // same node, moved
					expect(liC.getBoundingClientRect().y).toBeLessThan(yBefore);
					log("width + keyed reorder updated natively");
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: pointer events, hover and :active styles",
		category: "Native UI",
		description: "Clicks reach onClick handlers; :hover restyles are painted.",
		async run({ log }) {
			const [count, setCount] = signal(0);
			await withUI(
				"native-ui-pointer",
				`${base} #btn { position: absolute; left: 20px; top: 20px; width: 140px; height: 50px; border: none; border-radius: 0; background: rgb(10, 120, 40); }
				 #btn:hover { background: rgb(200, 100, 0); }`,
				() => <button id="btn" onClick={() => setCount((c) => c + 1)}>{live(() => `Clicked ${count()}`)}</button>,
				async (ui) => {
					near(await ui.pixel(30, 30), [10, 120, 40, 255]);
					await ui.simulate.move(90, 45);
					near(await ui.pixel(30, 30), [200, 100, 0, 255]);
					await ui.simulate.click({ x: 90, y: 45 });
					await ui.simulate.click({ x: 90, y: 45 });
					await sleep(30);
					ui.document.pump();
					expect(count()).toBe(2);
					await ui.simulate.move(400, 300);
					near(await ui.pixel(30, 30), [10, 120, 40, 255]);
					log(`count=${count()}, hover painted and cleared`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: text input, editing keys and onInput",
		category: "Native UI",
		description: "Typing, Backspace, arrow keys and select-all work in <input>; value is readable from JS.",
		async run({ log }) {
			let last = "";
			await withUI(
				"native-ui-input",
				base,
				() => <input id="name" class="eb-input" style="width: 240px; margin: 20px" onInput={(e: any) => (last = e.target.value)} />,
				async (ui) => {
					const input = ui.querySelector("#name")!;
					await ui.simulate.click(input);
					await ui.simulate.type("hello world");
					expect(input.value).toBe("hello world");
					await ui.simulate.key("Backspace");
					await ui.simulate.key("ArrowLeft");
					await ui.simulate.type("X");
					expect(input.value).toBe("hello worXl");
					await ui.simulate.key("a", { meta: true, ctrl: true });
					await ui.simulate.type("new");
					expect(input.value).toBe("new");
					await sleep(30);
					ui.document.pump();
					expect(last).toBe("new");
					log(`value=${input.value}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: typing into an input with a placeholder",
		category: "Native UI",
		description: "Clicking over placeholder text puts the caret at the start of the (empty) value; typing replaces the placeholder.",
		async run({ log }) {
			await withUI(
				"native-ui-placeholder",
				base,
				() => <input id="p" class="eb-input" placeholder="Ada Lovelace" style="width: 260px; margin: 20px" />,
				async (ui) => {
					const input = ui.querySelector("#p")!;
					const r = input.getBoundingClientRect();
					await ui.simulate.click({ x: r.x + 60, y: r.y + r.height / 2 });
					await ui.simulate.type("Grace");
					await ui.simulate.type(" Hopper");
					expect(input.value).toBe("Grace Hopper");
					log(`value=${input.value}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: entrance animation ends on the cascaded style",
		category: "Native UI",
		description: "A toast's keyframe entrance (opacity + transform) must leave its blurred box-shadow exactly as a fresh restyle would paint it.",
		async run({ log }) {
			await withUI(
				"native-ui-toast",
				`${base} body { background: #fff }`,
				() => (
					<div class="eb-app" style="padding: 40px">
						<div class="eb-toast" id="toast">Saved!</div>
					</div>
				),
				async (ui) => {
					const toast = ui.querySelector("#toast")!;
					// restart the entrance so we can sample it mid-flight
					toast.className = "";
					await ui.nextFrame();
					toast.className = "eb-toast";
					await ui.nextFrame();
					const r0 = toast.getBoundingClientRect();
					const mid = await Promise.all([6, 12, 20, 40].map((d) => ui.pixel(Math.round(r0.x + r0.width / 2), Math.round(r0.y + r0.height + d))));
					log(`mid-animation shadow ${JSON.stringify(mid)}`);
					// a faded-in shadow is never darker than the settled one; far away it is background
					expect(mid[3]![0]!).toBeGreaterThan(250);
					// ...but the shadow is visible while fading in (not clipped to the border box)
					expect(mid[1]![0]!).toBeLessThan(255);
					await sleep(400);
					await ui.nextFrame();
					const r = toast.getBoundingClientRect();
					// points in the shadow falloff below the toast
					const pts = [6, 12, 20].map((d) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height + d) }));
					const after = await Promise.all(pts.map((p) => ui.pixel(p.x, p.y)));
					// force a restyle without changing any styles
					toast.setAttribute("data-poke", "1");
					await ui.nextFrame();
					const fresh = await Promise.all(pts.map((p) => ui.pixel(p.x, p.y)));
					for (let i = 0; i < pts.length; i++) near(after[i]!, fresh[i]!, 2);
					// a blurred shadow fades out with distance
					expect(fresh[0]![0]!).toBeLessThan(fresh[2]![0]! + 1);
					log(`shadow ${JSON.stringify(after)} == ${JSON.stringify(fresh)}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: forms submit on Enter and via submit buttons",
		category: "Native UI",
		description: "Implicit submission: Enter in a text input and clicking a <button> (type=submit by default) each fire the form's submit once.",
		async run({ log }) {
			let submits = 0;
			let typed = "";
			await withUI(
				"native-ui-form",
				base,
				() => (
					<form onSubmit={() => submits++} style="margin: 20px; display: flex; gap: 8px">
						<input id="q" class="eb-input" style="width: 200px" onInput={(e: any) => (typed = e.data)} />
						<button id="go" class="eb-btn">Add</button>
					</form>
				),
				async (ui) => {
					await ui.simulate.click(ui.querySelector("#q")!);
					await ui.simulate.type("milk");
					await ui.simulate.key("Enter");
					await sleep(30);
					ui.document.pump();
					expect(submits).toBe(1);
					await ui.simulate.click(ui.querySelector("#go")!);
					await sleep(30);
					ui.document.pump();
					expect(submits).toBe(2);
					expect(typed).toBe("milk");
					log(`submits=${submits}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: native views anchored to elements follow layout",
		category: "Native UI",
		description: "ui.anchor keeps a WGPUView (and any setFrame target) over an element through layout changes, hiding it with the element.",
		async run({ log }) {
			const [wide, setWide] = signal(false);
			const [shown, setShown] = signal(true);
			await withUI(
				"native-ui-anchor",
				`${base} #slot { margin: 30px 0 0 40px; height: 80px; background: #ddd }`,
				() => (
					<div style={live(() => (shown() ? "" : "display: none"))}>
						<div id="slot" style={live(() => `width: ${wide() ? 300 : 120}px`)} />
					</div>
				),
				async (ui, win) => {
					const slot = ui.querySelector("#slot")!;
					const view = new WGPUView({ windowId: win.id, frame: { x: 0, y: 0, width: 1, height: 1 }, autoResize: false });
					const frames: Array<{ x: number; y: number; w: number; h: number }> = [];
					let hidden = false;
					const fake = {
						setFrame: (x: number, y: number, w: number, h: number) => frames.push({ x, y, w, h }),
						setHidden: (h: boolean) => (hidden = h),
					};
					const settle = async () => {
						for (let i = 0; i < 3; i++) await ui.nextFrame();
					};
					const stopView = ui.anchor(slot, view);
					// several native views may anchor to one element
					const stopFake = ui.anchor(slot, fake);
					await settle();
					const r = slot.getBoundingClientRect();
					expect(view.frame.x).toBe(r.x);
					expect(view.frame.y).toBe(r.y);
					expect(view.frame.width).toBe(120);
					expect(view.frame.height).toBe(80);
					setWide(true);
					await settle();
					expect(view.frame.width).toBe(300);
					expect(frames.at(-1)!.w).toBe(300);
					// unchanged frames are not re-sent
					const sent = frames.length;
					await settle();
					expect(frames.length).toBe(sent);
					setShown(false);
					await settle();
					expect(hidden).toBe(true);
					setShown(true);
					await settle();
					expect(hidden).toBe(false);
					stopView();
					stopFake();
					view.remove();
					log(`anchored frame ${JSON.stringify(view.frame)} after ${frames.length} updates`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: hover sweep over styled components",
		category: "Native UI",
		description: "Sweeps the pointer across nav items, buttons and a placeholder input repeatedly; paint-only restyles must not leave stale style pointers in cached layout.",
		async run({ log }) {
			await withUI(
				"native-ui-hover-sweep",
				`${base} .nav { width: 180px; padding: 8px }`,
				() => (
					<div class="eb-app" style="display: flex; gap: 16px; padding: 8px">
						<nav class="nav eb-nav">
							{["Components", "Forms", "Todo", "Motion", "Text", "Layout"].map((p) => <button class="eb-nav-item">{p}</button>)}
						</nav>
						<div style="display: flex; flex-direction: column; gap: 8px">
							<button class="eb-btn">Primary</button>
							<button class="eb-btn outline">Outline</button>
							<input class="eb-input" placeholder="Placeholder text" />
							<label class="eb-switch"><input type="checkbox" /><span /></label>
						</div>
					</div>
				),
				async (ui) => {
					const start = ui.frames;
					for (let pass = 0; pass < 6; pass++) {
						for (let y = 10; y < 260; y += 9) {
							await ui.simulate.move(pass % 2 ? 300 : 90, y);
						}
						await ui.nextFrame();
					}
					const nav = ui.querySelector(".eb-nav-item")!;
					expect(nav.getBoundingClientRect().width).toBeGreaterThan(100);
					expect(ui.frames).toBeGreaterThan(start);
					log(`swept ${6 * 28} moves over ${ui.frames - start} frames`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: keyboard focus order and activation",
		category: "Native UI",
		description: "Tab moves focus through controls in document order; Enter/Space activate buttons and checkboxes.",
		async run({ log }) {
			const [hits, setHits] = signal(0);
			const [checked, setChecked] = signal(false);
			await withUI(
				"native-ui-focus",
				base,
				() => (
					<div style="padding: 20px; display: flex; gap: 10px">
						<input id="a" class="eb-input" style="width: 100px" />
						<button id="b" class="eb-btn" onClick={() => setHits((h) => h + 1)}>Go</button>
						<input id="c" type="checkbox" onChange={(e: any) => setChecked(e.target.checked)} />
					</div>
				),
				async (ui) => {
					await ui.simulate.key("Tab");
					await ui.simulate.key("Tab");
					await ui.simulate.key("Enter");
					await ui.simulate.key(" ");
					await ui.simulate.key("Tab");
					await ui.simulate.key(" ");
					await sleep(30);
					ui.document.pump();
					expect(hits()).toBe(2);
					expect(checked()).toBe(true);
					const tree = ui.accessibilityTree().join("\n");
					expect(tree.includes("checkbox||")).toBe(true);
					log(`button activations=${hits()} checkbox=${checked()}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: select popup with keyboard",
		category: "Native UI",
		description: "Clicking a <select> opens the core's popup; arrows + Enter choose an option and fire change.",
		async run({ log }) {
			let changed = "";
			await withUI(
				"native-ui-select",
				base,
				() => (
					<select id="s" class="eb-select" style="width: 180px; margin: 20px" onChange={(e: any) => (changed = e.target.value)}>
						<option value="mac">macOS</option>
						<option value="win" selected>Windows</option>
						<option value="linux">Linux</option>
					</select>
				),
				async (ui) => {
					const sel = ui.querySelector("#s")!;
					expect(sel.value).toBe("win"); // JSX `selected` + option value attributes
					await ui.simulate.click(sel);
					await ui.simulate.key("ArrowDown");
					await ui.simulate.key("Enter");
					await sleep(30);
					ui.document.pump();
					expect(sel.value).toBe("linux");
					expect(changed).toBe("linux");
					log(`selected ${sel.value}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: scroll containers respond to the wheel",
		category: "Native UI",
		description: "overflow: auto clips content and scrolls with wheel deltas.",
		async run({ log }) {
			await withUI(
				"native-ui-scroll",
				`${base} #s { width: 200px; height: 120px; overflow: auto; margin: 10px } .row { height: 40px; border-bottom: 1px solid #ddd }`,
				() => (
					<div id="s">
						{Array.from({ length: 20 }, (_, i) => <div class="row" id={`r${i}`}>Row {i}</div>)}
					</div>
				),
				async (ui) => {
					const r5 = ui.querySelector("#r5")!;
					const before = r5.getBoundingClientRect().y;
					await ui.simulate.wheel(60, 60, 0, 120);
					const after = r5.getBoundingClientRect().y;
					expect(Math.round(before - after)).toBe(120);
					log(`row 5 moved ${before} -> ${after}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: CSS transitions animate",
		category: "Native UI",
		description: "A width transition produces intermediate values over time and settles at the target.",
		async run({ log }) {
			const [wide, setWide] = signal(false);
			await withUI(
				"native-ui-transition",
				`${base} #t { height: 20px; width: 100px; background: #000; transition: width .4s linear } #t.wide { width: 300px }`,
				() => <div id="t" class={live(() => (wide() ? "wide" : ""))} />,
				async (ui) => {
					const el = ui.querySelector("#t")!;
					setWide(true);
					await ui.nextFrame();
					await sleep(180);
					await ui.nextFrame();
					const mid = el.getBoundingClientRect().width;
					await sleep(400);
					await ui.nextFrame();
					const end = el.getBoundingClientRect().width;
					expect(mid).toBeGreaterThan(110);
					expect(mid).toBeLessThan(290);
					expect(end).toBe(300);
					log(`mid=${mid.toFixed(1)} end=${end}`);
				},
			);
		},
	}),

	defineTest({
		name: "Native UI: accessibility tree",
		category: "Native UI",
		description: "Headings, buttons, links, labelled fields and checkbox states are exposed with names.",
		async run({ log }) {
			const [state] = store({ email: "a@b.c" });
			await withUI(
				"native-ui-a11y",
				base,
				() => (
					<main>
						<h1>Settings</h1>
						<label>Email <input value={live(() => state.email)} /></label>
						<button aria-label="Close settings">×</button>
						<a href="#">Help</a>
						<input type="checkbox" id="n" checked /><label for="n">Notify me</label>
					</main>
				),
				async (ui) => {
					const lines = ui.accessibilityTree();
					const has = (prefix: string) => lines.some((l) => l.startsWith(prefix));
					expect(has("heading|Settings")).toBe(true);
					expect(has("text_field|Email|a@b.c")).toBe(true);
					expect(has("button|Close settings")).toBe(true);
					expect(has("link|Help")).toBe(true);
					expect(lines.some((l) => l.startsWith("checkbox|Notify me") && l.includes("checked"))).toBe(true);
					log(lines.join(" ; "));
				},
			);
		},
	}),
];
