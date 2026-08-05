// Headless tests for the compiler-less JSX runtime. Uses the jsx() factory
// directly (what the transpiler emits for .tsx files).

import { describe, expect, test } from "bun:test";
import { createRoot, live, signal } from "../reactive";
import { NodeKind, Prop, UiTree } from "../tree";
import { createUiContext, ui, withUiContext, type UiContext } from "../ui";
import { Fragment, jsx, isUIElement, type UIElement } from "../jsx-runtime";
import { parseColor } from "../paint";

function mountApp(app: () => UIElement): { ctx: UiContext; dispose: () => void } {
	const ctx = createUiContext();
	let dispose = () => {};
	createRoot((d) => {
		dispose = d;
		withUiContext(ctx, () => {
			app().create();
		});
	});
	return { ctx, dispose };
}

describe("jsx runtime", () => {
	test("intrinsics build the tree parent-first", () => {
		const { ctx } = mountApp(() =>
			jsx("column", {
				pad: 8,
				children: [
					jsx("text", { children: "hello" }),
					jsx("box", { width: 10, height: 10 }),
				],
			}),
		);
		const [col] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getProp(col!, Prop.Pad)).toBe(8);
		const kids = ctx.tree.childrenOf(col!);
		expect(kids.length).toBe(2);
		expect(ctx.tree.getText(kids[0]!)).toBe("hello");
		expect(ctx.tree.get(kids[1]!).kind).toBe(NodeKind.Box);
	});

	test("components are functions returning elements", () => {
		function Badge(props: { label: string }) {
			return jsx("box", {
				pad: 4,
				children: jsx("text", { children: props.label }),
			});
		}
		const { ctx } = mountApp(() =>
			jsx("row", { children: jsx(Badge as any, { label: "hi" }) }),
		);
		const [row] = ctx.tree.childrenOf(ctx.tree.root);
		const [badge] = ctx.tree.childrenOf(row!);
		const [label] = ctx.tree.childrenOf(badge!);
		expect(ctx.tree.getText(label!)).toBe("hi");
	});

	test("reactive text children via $ update in place", () => {
		const [count, setCount] = signal(0);
		const { ctx } = mountApp(() =>
			jsx("box", { children: live(() => `n=${count()}`) }),
		);
		const [box] = ctx.tree.childrenOf(ctx.tree.root);
		const [label] = ctx.tree.childrenOf(box!);
		expect(ctx.tree.getText(label!)).toBe("n=0");
		setCount(3);
		expect(ctx.tree.getText(label!)).toBe("n=3");
	});

	test("reactive props via $ work in JSX", () => {
		const [bg, setBg] = signal("#111111");
		const { ctx } = mountApp(() => jsx("box", { bg: live(bg) }));
		const [box] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getProp(box!, Prop.Bg)).toBe(parseColor("#111111"));
		setBg("#222222");
		expect(ctx.tree.getProp(box!, Prop.Bg)).toBe(parseColor("#222222"));
	});

	test("conditional and array children", () => {
		const show = false;
		const { ctx } = mountApp(() =>
			jsx("column", {
				children: [
					show && jsx("text", { children: "hidden" }),
					["a", "b"].map((s) => jsx("text", { children: s })),
					null,
					undefined,
				],
			}),
		);
		const [col] = ctx.tree.childrenOf(ctx.tree.root);
		const kids = ctx.tree.childrenOf(col!);
		expect(kids.length).toBe(2);
		expect(ctx.tree.getText(kids[0]!)).toBe("a");
		expect(ctx.tree.getText(kids[1]!)).toBe("b");
	});

	test("fragments flatten", () => {
		const { ctx } = mountApp(() =>
			jsx("column", {
				children: jsx(Fragment as any, {
					children: [
						jsx("text", { children: "one" }),
						jsx("text", { children: "two" }),
					],
				}),
			}),
		);
		const [col] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.childrenOf(col!).length).toBe(2);
	});

	test("bare function children are builder escapes", () => {
		const { ctx } = mountApp(() =>
			jsx("column", {
				children: () => {
					ui.each({ dir: "column" }, () => ["x", "y"], (s) => s, (s) => {
						ui.text(s);
					});
				},
			}),
		);
		const [col] = ctx.tree.childrenOf(ctx.tree.root);
		const [region] = ctx.tree.childrenOf(col!);
		expect(ctx.tree.childrenOf(region!).length).toBe(2);
	});

	test("elements are lazy: nothing mounts until create()", () => {
		const tree = new UiTree();
		const ctx = createUiContext(tree);
		let el: UIElement | null = null;
		createRoot(() => {
			withUiContext(ctx, () => {
				el = jsx("box", { width: 5, height: 5 });
			});
		});
		expect(isUIElement(el)).toBe(true);
		expect(tree.childrenOf(tree.root).length).toBe(0);
	});

	test("number and string children become text", () => {
		const { ctx } = mountApp(() => jsx("box", { children: 42 }));
		const [box] = ctx.tree.childrenOf(ctx.tree.root);
		const [label] = ctx.tree.childrenOf(box!);
		expect(ctx.tree.getText(label!)).toBe("42");
	});
});

describe("control flow", () => {
	const { For, Show, Switch, Match } = require("../jsx-runtime");
	const { live, signal, store } = require("../reactive");

	test("<Show when={live(...)}> toggles; static when is frozen", () => {
		const [on, setOn] = signal(false);
		const { ctx } = mountApp(() =>
			jsx("column", {
				children: [
					jsx(Show, {
						when: live(() => on()),
						children: jsx("text", { children: "live-on" }),
						fallback: jsx("text", { children: "live-off" }),
					}),
					jsx(Show, {
						when: false,
						children: jsx("text", { children: "static-on" }),
						fallback: jsx("text", { children: "static-off" }),
					}),
				],
			}),
		);
		const texts = () => {
			const out: string[] = [];
			const walk = (id: number) => {
				if (ctx.tree.isTextNode(id)) out.push(ctx.tree.getText(id));
				for (const c of ctx.tree.childrenOf(id)) walk(c);
			};
			walk(ctx.tree.root);
			return out;
		};
		expect(texts()).toEqual(["live-off", "static-off"]);
		setOn(true);
		expect(texts()).toEqual(["live-on", "static-off"]); // static stays frozen
	});

	test("<For each={live(...)}> reconciles; static each renders once", () => {
		const [state, setState] = store({ items: ["a", "b"] });
		const frozen = ["x", "y"];
		const { ctx } = mountApp(() =>
			jsx("column", {
				children: [
					jsx(For, {
						each: live(() => state.items),
						children: (item: string) => jsx("text", { children: item }),
					}),
					jsx(For, {
						each: frozen,
						children: (item: string) => jsx("text", { children: item }),
					}),
				],
			}),
		);
		const count = () => {
			let n = 0;
			const walk = (id: number) => {
				if (ctx.tree.isTextNode(id)) n++;
				for (const c of ctx.tree.childrenOf(id)) walk(c);
			};
			walk(ctx.tree.root);
			return n;
		};
		expect(count()).toBe(4);
		setState((s: any) => s.items.push("c"));
		expect(count()).toBe(5); // live grew; static did not
	});

	test("<Switch>/<Match> picks the first truthy live match", () => {
		const [status, setStatus] = signal("urgent");
		const { ctx } = mountApp(() =>
			jsx("column", {
				children: jsx(Switch, {
					fallback: jsx("text", { children: "none" }),
					children: [
						jsx(Match, {
							when: live(() => status() === "urgent"),
							children: jsx("text", { children: "fire" }),
						}),
						jsx(Match, {
							when: live(() => status() === "waiting"),
							children: jsx("text", { children: "clock" }),
						}),
					],
				}),
			}),
		);
		const first = () => {
			const walk = (id: number): string | null => {
				if (ctx.tree.isTextNode(id)) return ctx.tree.getText(id);
				for (const c of ctx.tree.childrenOf(id)) {
					const r = walk(c);
					if (r) return r;
				}
				return null;
			};
			return walk(ctx.tree.root);
		};
		expect(first()).toBe("fire");
		setStatus("waiting");
		expect(first()).toBe("clock");
		setStatus("done");
		expect(first()).toBe("none");
	});
});
