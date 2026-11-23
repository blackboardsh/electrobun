// Warren DOM renderer against the stub DOM: structure, explicit reactivity,
// control flow with keyed reconciliation, events, Portal, and teardown.

import { describe, expect, test } from "bun:test";
import { cleanup, inert, live, memo, setDevMode, signal, store } from "../../../shared/warren/reactive";
import {
	For,
	Fragment,
	Match,
	Portal,
	Show,
	Switch,
	jsx,
	render,
} from "../dom";
import { createStubRoot, StubComment, StubElement, StubText } from "./domStub";

function mount(app: () => unknown): {
	container: StubElement;
	document: ReturnType<typeof createStubRoot>["document"];
	dispose: () => void;
} {
	const { document, container } = createStubRoot();
	const dispose = render(app as any, container as any);
	return { container, document, dispose };
}

describe("DOM renderer", () => {
	test("mounts an intrinsic tree with attributes, class, and style", () => {
		const { container } = mount(() =>
			jsx("div", {
				id: "app",
				class: "shell dark",
				style: { color: "red", "--accent": "#fff" },
				children: [
					jsx("span", { children: "hello" }),
					jsx("input", { type: "text", value: "abc", disabled: true }),
				],
			}),
		);
		const [div] = container.children;
		expect(div!.tagName).toBe("div");
		expect(div!.getAttribute("id")).toBe("app");
		expect(div!.className).toBe("shell dark");
		expect(div!.style["color"]).toBe("red");
		expect((div!.style as any)["--accent"]).toBe("#fff");
		const [span, input] = div!.children;
		expect(span!.textContent).toBe("hello");
		expect(input!.value).toBe("abc"); // property, not attribute
		expect(input!.hasAttribute("value")).toBe(false);
		expect(input!.getAttribute("disabled")).toBe(""); // boolean attribute
	});

	test("static text and live text children", () => {
		const [count, setCount] = signal(0);
		const { container } = mount(() =>
			jsx("p", { children: [live(() => `n=${count()}`), " (static)"] }),
		);
		const [p] = container.children;
		expect(p!.textContent).toBe("n=0 (static)");
		setCount(7);
		expect(p!.textContent).toBe("n=7 (static)");
	});

	test("live props update in place; element identity is stable", () => {
		const [cls, setCls] = signal("a");
		const { container } = mount(() =>
			jsx("div", { class: live(cls), title: live(() => cls().toUpperCase()) }),
		);
		const [div] = container.children;
		expect(div!.className).toBe("a");
		expect(div!.getAttribute("title")).toBe("A");
		setCls("b");
		expect(container.children[0]).toBe(div!);
		expect(div!.className).toBe("b");
		expect(div!.getAttribute("title")).toBe("B");
	});

	test("unchanged live text does not write CharacterData on a fresh response", () => {
		const [response, setResponse] = signal<{ value: string | number }>({ value: 1 });
		const { container, dispose } = mount(() =>
			jsx("code", { children: live(() => response().value) }),
		);
		try {
			const code = container.children[0]!;
			const text = code.childNodes.find(node => node instanceof StubText) as StubText;
			let value = text.data;
			let writes = 0;
			Object.defineProperty(text, "data", {
				get: () => value,
				set: (next: string) => { writes++; value = next; },
			});
			setResponse({ value: 1 });
			setResponse({ value: "1" });
			expect(writes).toBe(0);
			expect(code.childNodes.includes(text)).toBe(true);
			setResponse({ value: "new command" });
			expect(writes).toBe(1);
			expect(code.textContent).toBe("new command");
			expect(code.childNodes.includes(text)).toBe(true);
		} finally { dispose(); }
	});

	test("classList toggles classes from an object", () => {
		const [active, setActive] = signal(false);
		const { container } = mount(() =>
			jsx("div", {
				class: "base",
				classList: live(() => ({ active: active(), muted: !active() })),
			}),
		);
		const [div] = container.children;
		expect(div!.classList.contains("base")).toBe(true);
		expect(div!.classList.contains("muted")).toBe(true);
		expect(div!.classList.contains("active")).toBe(false);
		setActive(true);
		expect(div!.classList.contains("active")).toBe(true);
		expect(div!.classList.contains("muted")).toBe(false);
	});

	test("bare functions in value props throw loudly", () => {
		const [x] = signal(1);
		expect(() => mount(() => jsx("div", { title: x as any }))).toThrow(
			/live\(/,
		);
	});

	test("event handlers attach; ref sees the element", () => {
		let clicks = 0;
		let reffed: unknown = null;
		const { container } = mount(() =>
			jsx("button", {
				ref: (el: unknown) => {
					reffed = el;
				},
				onClick: () => clicks++,
				children: "go",
			}),
		);
		const [button] = container.children;
		expect(reffed).toBe(button!);
		button!.dispatch("click");
		expect(clicks).toBe(1);
	});

	test("components run once; nested structure mounts", () => {
		let calls = 0;
		function Badge(props: Record<string, unknown>) {
			calls++;
			return jsx("em", { children: props["label"] as string });
		}
		const { container } = mount(() =>
			jsx("div", {
				children: [jsx(Badge, { label: "one" }), jsx(Badge, { label: "two" })],
			}),
		);
		expect(calls).toBe(2);
		expect(container.children[0]!.textContent).toBe("onetwo");
	});

	test("Show with live when swaps content and fallback", () => {
		const [on, setOn] = signal(false);
		const { container } = mount(() =>
			jsx("div", {
				children: Show({
					when: live(on),
					fallback: jsx("span", { class: "off", children: "off" }),
					children: jsx("span", { class: "on", children: "on" }),
				}),
			}),
		);
		const [div] = container.children;
		expect(div!.children[0]!.className).toBe("off");
		setOn(true);
		expect(div!.children[0]!.className).toBe("on");
		setOn(false);
		expect(div!.children[0]!.className).toBe("off");
	});

	test("Show with a plain value is a frozen snapshot", () => {
		const [on, setOn] = signal(false);
		const { container } = mount(() =>
			jsx("div", {
				children: Show({
					when: on(), // evaluated once, not reactive
					fallback: jsx("span", { children: "frozen-off" }),
					children: jsx("span", { children: "frozen-on" }),
				}),
			}),
		);
		setOn(true);
		expect(container.children[0]!.textContent).toBe("frozen-off");
	});

	test("Show retains truthy and falsy branches until their boolean selection changes", () => {
		const [response, setResponse] = signal<{ ready: unknown; version: string }>({ ready: 1, version: "1.0" });
		let mounted = 0;
		let cleaned = 0;
		const branch = (tag: string) => () => inert(() => {
			mounted++;
			cleanup(() => { cleaned++; });
			return jsx(tag, { children: live(() => response().version) });
		});
		const { container, dispose } = mount(() => Show({
			when: live(() => response().ready),
			children: branch("details"),
			fallback: branch("aside"),
		}));
		try {
			const details = container.children[0]!;
			details.setAttribute("open", "");
			setResponse({ ready: true, version: "1.0" });
			setResponse({ ready: { uploaded: true }, version: "1.1" });
			expect(container.children[0]).toBe(details);
			expect(details.hasAttribute("open")).toBe(true);
			expect(details.textContent).toBe("1.1");
			expect(mounted).toBe(1);
			expect(cleaned).toBe(0);

			setResponse({ ready: false, version: "1.2" });
			const fallback = container.children[0]!;
			expect(fallback.tagName).toBe("aside");
			expect(details.parentNode).toBe(null);
			expect(cleaned).toBe(1);
			setResponse({ ready: null, version: "1.3" });
			setResponse({ ready: 0, version: "1.4" });
			expect(container.children[0]).toBe(fallback);
			expect(fallback.textContent).toBe("1.4");
			expect(mounted).toBe(2);
			expect(cleaned).toBe(1);

			setResponse({ ready: true, version: "1.5" });
			expect(container.children[0]!.tagName).toBe("details");
			expect(container.children[0]).not.toBe(details);
			expect(container.children[0]!.textContent).toBe("1.5");
			expect(cleaned).toBe(2);
		} finally { dispose(); }
		expect(cleaned).toBe(3);
		setResponse({ ready: false, version: "after disposal" });
		expect(container.childNodes.length).toBe(0);
	});

	test("For reconciles keyed rows: identity preserved across reorder", () => {
		const [state, setState] = store({ items: ["a", "b", "c"] });
		const { container } = mount(() =>
			jsx("ul", {
				children: For({
					each: live(() => state.items.slice()),
					key: (item: string) => item,
					children: (item: string) => jsx("li", { children: item }),
				}),
			}),
		);
		const [ul] = container.children;
		expect(ul!.children.map((li) => li.textContent)).toEqual(["a", "b", "c"]);
		const [liA, liB, liC] = ul!.children;

		setState((s) => s.items.reverse());
		expect(ul!.children.map((li) => li.textContent)).toEqual(["c", "b", "a"]);
		// Same DOM nodes, moved — not rebuilt.
		expect(ul!.children[0]).toBe(liC!);
		expect(ul!.children[1]).toBe(liB!);
		expect(ul!.children[2]).toBe(liA!);
	});

	test("For adds and removes rows; fallback flips on empty", () => {
		const [state, setState] = store({ items: ["x"] });
		const { container } = mount(() =>
			jsx("div", {
				children: For({
					each: live(() => state.items.slice()),
					key: (item: string) => item,
					fallback: jsx("i", { children: "empty" }),
					children: (item: string) => jsx("b", { children: item }),
				}),
			}),
		);
		const [div] = container.children;
		expect(div!.children[0]!.tagName).toBe("b");
		setState((s) => {
			s.items.length = 0;
		});
		expect(div!.children[0]!.tagName).toBe("i");
		setState((s) => s.items.push("y", "z"));
		expect(div!.children.map((el) => el.textContent)).toEqual(["y", "z"]);
	});

	test("For row index accessor is reactive", () => {
		const [state, setState] = store({ items: ["a", "b"] });
		const { container } = mount(() =>
			jsx("div", {
				children: For({
					each: live(() => state.items.slice()),
					key: (item: string) => item,
					children: (item: string, index) =>
						jsx("span", { children: live(() => `${item}${index()}`) }),
				}),
			}),
		);
		const [div] = container.children;
		expect(div!.textContent).toBe("a0b1");
		setState((s) => s.items.reverse());
		expect(div!.textContent).toBe("b0a1");
	});

	test("static For rows under Switch own live bindings without rebuilding the branch", () => {
		const [tab, setTab] = signal("desktop");
		let mounted = 0;
		let cleaned = 0;
		let rowCleanups = 0;
		let setHeld = (_next: string[]) => {};
		let setReady = (_next: boolean) => {};
		function Desktop() {
			// Bound the broken implementation's remount loop so the regression
			// fails quickly rather than reaching the scheduler's cycle limit.
			if (++mounted > 4) throw new Error("static For repeatedly remounted its Switch branch");
			const [held, updateHeld] = signal<string[]>([]);
			const [ready, updateReady] = signal(false);
			setHeld = updateHeld;
			setReady = updateReady;
			cleanup(() => { cleaned++; updateHeld([]); });
			// Match a controller publishing its first state after the branch mounts.
			live(() => inert(() => updateReady(true)));
			return jsx("section", {
				children: For({
					each: ["Shift", "Control"],
					children: (key: string, index) => {
						cleanup(() => { rowCleanups++; });
						return jsx("button", {
							title: live(() => `${index()}:${ready()}`),
							"aria-pressed": live(() => String(held().includes(key))),
							children: key,
						});
					},
				}),
			});
		}
		const { container, dispose } = mount(() => Switch({
			children: Match({
				when: live(() => tab() === "desktop"),
				children: () => jsx(Desktop, {}),
			}),
			fallback: jsx("aside", { children: "other tab" }),
		}));
		try {
			const section = container.children[0]!;
			const [shift, control] = section.children;
			expect(mounted).toBe(1);
			expect(shift!.getAttribute("title")).toBe("0:true");
			expect(control!.getAttribute("title")).toBe("1:true");
			setHeld(["Shift"]);
			setReady(false);
			expect(container.children[0]).toBe(section);
			expect(section.children[0]).toBe(shift!);
			expect(shift!.getAttribute("aria-pressed")).toBe("true");
			expect(control!.getAttribute("aria-pressed")).toBe("false");
			expect(shift!.getAttribute("title")).toBe("0:false");
			expect(mounted).toBe(1);
			expect(cleaned).toBe(0);
			expect(rowCleanups).toBe(0);

			setTab("other");
			expect(container.children[0]!.tagName).toBe("aside");
			expect(cleaned).toBe(1);
			expect(rowCleanups).toBe(2);
			// Cleanup writes and updates to the retired controller cannot revive it.
			setHeld(["Control"]);
			setReady(true);
			expect(mounted).toBe(1);
			setTab("desktop");
			expect(mounted).toBe(2);
			expect(container.children[0]).not.toBe(section);
			expect(container.children[0]!.children[0]!.getAttribute("aria-pressed")).toBe("false");
		} finally { dispose(); }
		expect(cleaned).toBe(2);
		expect(rowCleanups).toBe(4);
		setHeld(["Shift"]);
		expect(container.childNodes.length).toBe(0);
	});

	test("static For rows stay isolated inside a direct live element child", () => {
		const [visible, setVisible] = signal(true);
		const [label, setLabel] = signal("first");
		let rows = 0;
		const { container, dispose } = mount(() => jsx("main", {
			children: live(() => visible() ? For({
				each: ["row"],
				children: () => { rows++; return jsx("button", { title: live(label), children: "row" }); },
			}) : null),
		}));
		try {
			const button = container.children[0]!.children[0]!;
			setLabel("second");
			expect(container.children[0]!.children[0]).toBe(button);
			expect(button.getAttribute("title")).toBe("second");
			expect(rows).toBe(1);
			setVisible(false);
			expect(container.children[0]!.children.length).toBe(0);
		} finally { dispose(); }
	});

	for (const scenario of [
		{ name: "static Show", reactive: false, branch: (selected: () => boolean, child: () => unknown) => Show({ when: selected(), children: child, fallback: jsx("aside", { children: "inner off" }) }) },
		{ name: "live Show", reactive: true, branch: (selected: () => boolean, child: () => unknown) => Show({ when: live(selected), children: child, fallback: jsx("aside", { children: "inner off" }) }) },
		{ name: "static Show fallback", reactive: false, branch: (selected: () => boolean, child: () => unknown) => Show({ when: !selected(), children: jsx("aside", { children: "inner off" }), fallback: child }) },
		{ name: "live Show fallback", reactive: true, branch: (selected: () => boolean, child: () => unknown) => Show({ when: live(() => !selected()), children: jsx("aside", { children: "inner off" }), fallback: child }) },
		{ name: "static Switch", reactive: false, branch: (selected: () => boolean, child: () => unknown) => Switch({ children: Match({ when: selected(), children: child }), fallback: jsx("aside", { children: "inner off" }) }) },
		{ name: "live Switch", reactive: true, branch: (selected: () => boolean, child: () => unknown) => Switch({ children: Match({ when: live(selected), children: child }), fallback: jsx("aside", { children: "inner off" }) }) },
		{ name: "static Switch fallback", reactive: false, branch: (selected: () => boolean, child: () => unknown) => Switch({ children: Match({ when: !selected(), children: jsx("aside", { children: "inner off" }) }), fallback: child }) },
		{ name: "live Switch fallback", reactive: true, branch: (selected: () => boolean, child: () => unknown) => Switch({ children: Match({ when: live(() => !selected()), children: jsx("aside", { children: "inner off" }) }), fallback: child }) },
		{ name: "static For fallback", reactive: false, branch: (selected: () => boolean, child: () => unknown) => For({ each: selected() ? [] : ["item"], children: () => jsx("aside", { children: "inner off" }), fallback: child }) },
		{ name: "live For fallback", reactive: true, branch: (selected: () => boolean, child: () => unknown) => For({ each: live(() => selected() ? [] : ["item"]), children: () => jsx("aside", { children: "inner off" }), fallback: child }) },
	]) {
		test(`${scenario.name} isolates branch bindings from selectors and enclosing regions`, () => {
			const [tab, setTab] = signal(true);
			const [selected, setSelected] = signal(true);
			const [label, setLabel] = signal("initial");
			let panels = 0;
			let branches = 0;
			let cleanups = 0;
			function Panel() {
				if (++panels > 4) throw new Error("Control flow remounted its enclosing region");
				return scenario.branch(selected, () => {
					if (++branches > 4) throw new Error("Control flow rebuilt its selected branch");
					cleanup(() => { cleanups++; setLabel("released"); });
					return jsx("button", { title: live(label), children: live(label) });
				});
			}
			const { container, dispose } = mount(() => Switch({
				children: Match({ when: live(tab), children: () => jsx(Panel, {}) }),
				fallback: jsx("p", { children: "outer off" }),
			}));
			try {
				const button = container.children[0]!;
				setLabel("updated");
				expect(container.children[0]).toBe(button);
				expect(button.getAttribute("title")).toBe("updated");
				expect(button.textContent).toBe("updated");
				expect(panels).toBe(1);
				expect(branches).toBe(1);
				expect(cleanups).toBe(0);

				setSelected(false);
				if (scenario.reactive) {
					expect(container.children[0]!.textContent).toBe("inner off");
					expect(cleanups).toBe(1);
					setSelected(true);
					expect(container.children[0]!.tagName).toBe("button");
					expect(container.children[0]).not.toBe(button);
					expect(branches).toBe(2);
				} else {
					expect(container.children[0]).toBe(button);
					expect(cleanups).toBe(0);
				}
				expect(panels).toBe(1);
				setTab(false);
				expect(container.children[0]!.textContent).toBe("outer off");
				expect(cleanups).toBe(scenario.reactive ? 2 : 1);
				setLabel("retired");
				expect(panels).toBe(1);
			} finally { dispose(); }
			expect(container.childNodes.length).toBe(0);
		});
	}

	test("JSX key attribute reaches For via the transform's third argument", () => {
		// <For key={fn}> transpiles to jsx(For, props, fn) — key must land
		// back in props or reconciliation silently degrades to item identity.
		const [state, setState] = store({ items: [{ n: 1 }, { n: 2 }] });
		const { container } = mount(() =>
			jsx("div", {
				children: jsx(
					For as any,
					{
						each: live(() => state.items.map((it) => ({ ...it }))),
						children: (item: { n: number }) =>
							jsx("span", { children: String(item.n) }),
					},
					(item: { n: number }) => item.n, // key as third arg
				),
			}),
		);
		const [div] = container.children;
		const [span1] = div!.children;
		setState((s) => s.items.reverse());
		// Fresh objects each read: only a working key preserves identity.
		expect(div!.children[1]).toBe(span1!);
	});

	test("Switch/Match picks the first live truthy branch", () => {
		const [tab, setTab] = signal("home");
		const { container } = mount(() =>
			jsx("div", {
				children: Switch({
					fallback: jsx("span", { children: "none" }),
					children: [
						Match({
							when: live(() => tab() === "home"),
							children: jsx("span", { children: "home" }),
						}),
						Match({
							when: live(() => tab() === "settings"),
							children: jsx("span", { children: "settings" }),
						}),
					],
				}),
			}),
		);
		const [div] = container.children;
		expect(div!.textContent).toBe("home");
		setTab("settings");
		expect(div!.textContent).toBe("settings");
		setTab("nope");
		expect(div!.textContent).toBe("none");
	});

	test("memo feeds live bindings glitch-free", () => {
		const [n, setN] = signal(2);
		const double = memo(() => n() * 2);
		const { container } = mount(() =>
			jsx("output", { children: live(() => `${n()}:${double()}`) }),
		);
		const [output] = container.children;
		expect(output!.textContent).toBe("2:4");
		setN(5);
		expect(output!.textContent).toBe("5:10");
	});

	test("live element children become dynamic regions (cond && <el/>)", () => {
		const [open, setOpen] = signal(false);
		const { container } = mount(() =>
			jsx("div", {
				children: live(() =>
					open() ? jsx("span", { class: "panel", children: "open" }) : null,
				),
			}),
		);
		const [div] = container.children;
		expect(div!.children.length).toBe(0);
		setOpen(true);
		expect(div!.children[0]!.className).toBe("panel");
		setOpen(false);
		expect(div!.children.length).toBe(0);
	});

	test("live text children stay fine-grained text nodes", () => {
		const [n, setN] = signal(1);
		const { container } = mount(() =>
			jsx("div", { children: live(() => `v${n()}`) }),
		);
		const [div] = container.children;
		const textNode = div!.childNodes.find((c) => c instanceof StubText);
		setN(2);
		// Same text node updated in place — not a rebuilt region.
		expect(div!.childNodes.find((c) => c instanceof StubText)).toBe(textNode!);
		expect(div!.textContent).toBe("v2");
	});

	test("components created inside live regions keep inert bodies and deferred lives", () => {
		const [open, setOpen] = signal(true);
		const [label, setLabel] = signal("a");
		let regionBuilds = 0;
		let effectRuns = 0;
		function Panel() {
			// Statement live in a body mounted from a live region: must be
			// deferred (declared-later variable is fine) and must NOT leak
			// its reads into the region's dependencies.
			live(() => {
				effectRuns++;
				laterDeclared();
			});
			const laterDeclared = () => label();
			return jsx("span", { class: live(label), children: "panel" });
		}
		const { container } = mount(() =>
			jsx("div", {
				children: live(() => {
					regionBuilds++;
					return open() ? jsx(Panel, {}) : null;
				}),
			}),
		);
		const [div] = container.children;
		expect(div!.children[0]!.className).toBe("a");
		expect(effectRuns).toBe(1);
		expect(regionBuilds).toBe(1);
		// Inner signal change: value binding + effect update, region untouched.
		setLabel("b");
		expect(div!.children[0]!.className).toBe("b");
		expect(effectRuns).toBe(2);
		expect(regionBuilds).toBe(1);
		// Region's own dependency still reconciles it.
		setOpen(false);
		expect(div!.children.length).toBe(0);
		expect(regionBuilds).toBe(2);
	});

	test("Fragment and array children mount in order", () => {
		const { container } = mount(() =>
			Fragment({
				children: [
					jsx("i", { children: "1" }),
					"mid",
					jsx("b", { children: "2" }),
				],
			}),
		);
		expect(container.textContent).toBe("1mid2");
	});

	test("bare function children run as escapes; returned elements mount", () => {
		const { container } = mount(() =>
			jsx("div", {
				children: [() => jsx("span", { children: "escaped" }), () => {}],
			}),
		);
		expect(container.children[0]!.textContent).toBe("escaped");
	});

	test("direct imperative escapes inside an explicit live region still track reads", () => {
		const [label, setLabel] = signal("first");
		let builds = 0;
		const { container, dispose } = mount(() => jsx("div", {
			children: live(() => {
				builds++;
				return jsx("section", { children: () => jsx("span", { children: label() }) });
			}),
		}));
		try {
			const first = container.children[0]!.children[0]!;
			expect(first.textContent).toBe("first");
			setLabel("second");
			expect(container.children[0]!.children[0]!.textContent).toBe("second");
			expect(container.children[0]!.children[0]).not.toBe(first);
			expect(builds).toBe(2);
		} finally { dispose(); }
	});

	test("Portal renders into document.body and cleans up with its scope", () => {
		const [open, setOpen] = signal(true);
		const { container, document } = mount(() =>
			jsx("div", {
				children: Show({
					when: live(open),
					children: Portal({
						children: jsx("dialog", { children: "modal" }),
					}),
				}),
			}),
		);
		expect(container.textContent).toBe("");
		expect(
			document.body.children.some((el) => el.tagName === "dialog"),
		).toBe(true);
		setOpen(false);
		expect(
			document.body.children.some((el) => el.tagName === "dialog"),
		).toBe(false);
		setOpen(true);
		expect(
			document.body.children.some((el) => el.tagName === "dialog"),
		).toBe(true);
	});

	test("svg subtrees use the SVG namespace; class works via attribute", () => {
		const { container } = mount(() =>
			jsx("svg", {
				viewBox: "0 0 10 10",
				class: "icon",
				children: jsx("path", { d: "M0 0L10 10" }),
			}),
		);
		const [svg] = container.children;
		expect(svg!.namespaceURI).toBe("http://www.w3.org/2000/svg");
		expect(svg!.getAttribute("viewBox")).toBe("0 0 10 10");
		expect(svg!.getAttribute("class")).toBe("icon");
		expect(svg!.children[0]!.namespaceURI).toBe(
			"http://www.w3.org/2000/svg",
		);
	});

	test("dispose removes everything Warren created and stops updates", () => {
		const [n, setN] = signal(0);
		const { container, dispose } = mount(() =>
			jsx("div", { children: live(() => `n=${n()}`) }),
		);
		expect(container.children.length).toBe(1);
		dispose();
		expect(container.childNodes.length).toBe(0);
		// Writes after dispose must not throw or resurrect nodes.
		setN(1);
		expect(container.childNodes.length).toBe(0);
	});

	test("dynamic region rebuild tears down row state (no leaked comments)", () => {
		setDevMode(false);
		try {
			const [state, setState] = store({ items: ["a", "b", "c"] });
			const { container } = mount(() =>
				jsx("div", {
					children: For({
						each: live(() => state.items.slice()),
						key: (item: string) => item,
						children: (item: string) => jsx("span", { children: item }),
					}),
				}),
			);
			const [div] = container.children;
			const countComments = () =>
				div!.childNodes.filter((n) => n instanceof StubComment).length;
			const before = countComments();
			// Shrinking to one row removes the other rows' anchors too.
			setState((s) => {
				s.items = ["b"];
			});
			expect(div!.textContent).toBe("b");
			expect(countComments()).toBeLessThan(before);
			// Text nodes from removed rows are gone.
			const texts = div!.childNodes.filter((n) => n instanceof StubText);
			expect(texts.length).toBe(0); // row text lives inside spans
		} finally {
			setDevMode(true);
		}
	});
});
