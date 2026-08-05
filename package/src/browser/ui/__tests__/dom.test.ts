// Warren DOM renderer against the stub DOM: structure, explicit reactivity,
// control flow with keyed reconciliation, events, Portal, and teardown.

import { describe, expect, test } from "bun:test";
import { live, memo, setDevMode, signal, store } from "../../../shared/warren/reactive";
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
		expect(div!.style.color).toBe("red");
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
			return jsx("em", { children: props.label as string });
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
