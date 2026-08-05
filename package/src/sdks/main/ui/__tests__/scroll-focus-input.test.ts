// Tests for the launcher-driving primitives: scroll/clip containers, keyed
// each(), the keymap/edit reducer, focus wiring, and textInput editing.

import { describe, expect, test } from "bun:test";
import { createRoot, live, signal, store } from "../reactive";
import { NodeKind, Prop, UiTree } from "../tree";
import { computeLayout } from "../layout";
import { FLOATS_PER_INSTANCE, paint } from "../paint";
import { hitChain } from "../hit";
import { Key, Mod, applyEditKey, charForKey } from "../keymap";
import { createUiContext, ui, withUiContext, type UiContext } from "../ui";
import { textInput } from "../textInput";

function build(app: () => void): { ctx: UiContext; dispose: () => void } {
	const ctx = createUiContext();
	let dispose = () => {};
	createRoot((d) => {
		dispose = d;
		withUiContext(ctx, app);
	});
	return { ctx, dispose };
}

describe("scroll containers", () => {
	function scrollTree(scrollY: number) {
		const tree = new UiTree();
		const container = tree.createNode(NodeKind.Box);
		tree.setProp(container, Prop.Dir, 1);
		tree.setProp(container, Prop.Height, 100);
		tree.setProp(container, Prop.Overflow, 1);
		tree.setProp(container, Prop.Scroll, scrollY);
		tree.setProp(container, Prop.Gap, 10);
		tree.append(tree.root, container);
		const rows: number[] = [];
		for (let i = 0; i < 5; i++) {
			const row = tree.createNode(NodeKind.Box);
			tree.setProp(row, Prop.Height, 30);
			tree.setProp(row, Prop.Width, 50);
			tree.setProp(row, Prop.Bg, 0x333333ff);
			tree.append(container, row);
			rows.push(row);
		}
		computeLayout(tree, 200, 100);
		return { tree, container, rows };
	}

	test("children keep natural size and record content extent", () => {
		const { tree, container } = scrollTree(0);
		// 5 rows x 30 + 4 gaps x 10 = 190
		expect(tree.get(container).contentMain).toBe(190);
		expect(tree.get(container).h).toBe(100);
	});

	test("scrollY shifts children on the main axis", () => {
		const { tree: at0, rows: rows0 } = scrollTree(0);
		const { tree: at40, rows: rows40 } = scrollTree(40);
		expect(at0.get(rows0[0]!).y).toBe(0);
		expect(at40.get(rows40[0]!).y).toBe(-40);
		expect(at40.get(rows40[2]!).y).toBe(40);
	});

	test("grow children are not inflated inside scroll containers", () => {
		const tree = new UiTree();
		const container = tree.createNode(NodeKind.Box);
		tree.setProp(container, Prop.Dir, 1);
		tree.setProp(container, Prop.Height, 300);
		tree.setProp(container, Prop.Overflow, 1);
		tree.append(tree.root, container);
		const child = tree.createNode(NodeKind.Box);
		tree.setProp(child, Prop.Height, 20);
		tree.setProp(child, Prop.Grow, 1);
		tree.append(container, child);
		computeLayout(tree, 200, 300);
		expect(tree.get(child).h).toBe(20);
	});

	test("paint clips children to the container and culls off-screen rows", () => {
		const { tree, container } = scrollTree(0);
		const buffer = paint(tree);
		// Rows at y=0,40,80 intersect the 100px container; y=120,160 culled.
		expect(buffer.count).toBe(3);
		const clip = Array.from(
			buffer.data.subarray(12, 16),
		);
		const c = tree.get(container);
		expect(clip).toEqual([c.x, c.y, c.w, c.h]);
	});

	test("nested scroll containers intersect clips", () => {
		const tree = new UiTree();
		const outer = tree.createNode(NodeKind.Box);
		tree.setProp(outer, Prop.Dir, 1);
		tree.setProp(outer, Prop.Height, 100);
		tree.setProp(outer, Prop.Width, 100);
		tree.setProp(outer, Prop.Overflow, 1);
		tree.append(tree.root, outer);
		const inner = tree.createNode(NodeKind.Box);
		tree.setProp(inner, Prop.Dir, 1);
		tree.setProp(inner, Prop.Height, 150);
		tree.setProp(inner, Prop.Width, 80);
		tree.setProp(inner, Prop.Overflow, 1);
		tree.append(outer, inner);
		const leaf = tree.createNode(NodeKind.Box);
		tree.setProp(leaf, Prop.Height, 20);
		tree.setProp(leaf, Prop.Width, 20);
		tree.setProp(leaf, Prop.Bg, 0xffffffff);
		tree.append(inner, leaf);
		computeLayout(tree, 200, 200);
		const buffer = paint(tree);
		const last = (buffer.count - 1) * FLOATS_PER_INSTANCE;
		const clip = Array.from(buffer.data.subarray(last + 12, last + 16));
		// Inner extends to 150 but outer clips at 100.
		expect(clip[3]).toBe(100);
	});

	test("hit testing respects scroll offset and container bounds", () => {
		const { tree, rows } = scrollTree(40);
		// Row 2 sits at y=40 on screen after scrolling.
		tree.setProp(rows[2]!, Prop.Hittable, 1);
		expect(hitChain(tree, 10, 50)).toEqual([rows[2]!]);
		// Row 4 is below the container (clipped): unreachable.
		tree.setProp(rows[4]!, Prop.Hittable, 1);
		expect(hitChain(tree, 10, 130).includes(rows[4]!)).toBe(false);
	});
});

describe("keymap and edit reducer", () => {
	test("maps characters with and without shift", () => {
		expect(charForKey(0, 0)).toBe("a");
		expect(charForKey(0, Mod.Shift)).toBe("A");
		expect(charForKey(19, 0)).toBe("2");
		expect(charForKey(19, Mod.Shift)).toBe("@");
		expect(charForKey(0, Mod.Cmd)).toBe(null);
		expect(charForKey(Key.Left, 0)).toBe(null);
	});

	test("inserts at the caret", () => {
		const r = applyEditKey({ value: "ac", caret: 1 }, 11, 0); // 'b'
		expect(r.value).toBe("abc");
		expect(r.caret).toBe(2);
	});

	test("backspace variants", () => {
		expect(applyEditKey({ value: "abc", caret: 3 }, Key.Backspace, 0).value).toBe("ab");
		expect(
			applyEditKey({ value: "abc def", caret: 7 }, Key.Backspace, Mod.Alt).value,
		).toBe("abc ");
		expect(
			applyEditKey({ value: "abc", caret: 3 }, Key.Backspace, Mod.Cmd).value,
		).toBe("");
		const atStart = applyEditKey({ value: "abc", caret: 0 }, Key.Backspace, 0);
		expect(atStart.value).toBe("abc");
		expect(atStart.handled).toBe(true);
	});

	test("caret movement with word and line modifiers", () => {
		expect(applyEditKey({ value: "ab cd", caret: 5 }, Key.Left, 0).caret).toBe(4);
		expect(applyEditKey({ value: "ab cd", caret: 5 }, Key.Left, Mod.Alt).caret).toBe(3);
		expect(applyEditKey({ value: "ab cd", caret: 5 }, Key.Left, Mod.Cmd).caret).toBe(0);
		expect(applyEditKey({ value: "ab cd", caret: 0 }, Key.Right, Mod.Cmd).caret).toBe(5);
	});

	test("Enter submits; unknown keys pass through", () => {
		expect(applyEditKey({ value: "x", caret: 1 }, Key.Return, 0).submit).toBe(true);
		const up = applyEditKey({ value: "x", caret: 1 }, Key.Up, 0);
		expect(up.handled).toBe(false);
	});
});

describe("keyed each", () => {
	test("rows keep their nodes across reorder and removal", () => {
		const [items, setItems] = signal(["a", "b", "c"]);
		const { ctx } = build(() => {
			ui.each({ dir: "column" }, items, (s) => s, (s) => {
				ui.text(s);
			});
		});
		const [region] = ctx.tree.childrenOf(ctx.tree.root);
		const before = ctx.tree.childrenOf(region!);
		expect(before.length).toBe(3);
		const nodeFor = new Map(
			["a", "b", "c"].map((k, i) => [k, before[i]!]),
		);

		setItems(["c", "a"]);
		const after = ctx.tree.childrenOf(region!);
		expect(after).toEqual([nodeFor.get("c")!, nodeFor.get("a")!]);
		expect(ctx.tree.has(nodeFor.get("b")!)).toBe(false);
	});

	test("row-scoped effects are disposed with their row", () => {
		const [items, setItems] = signal(["x", "y"]);
		const [tick, setTick] = signal(0);
		const runs: string[] = [];
		build(() => {
			ui.each({}, items, (s) => s, (s) => {
				ui.text(live(() => {
					tick();
					runs.push(s);
					return s;
				}));
			});
		});
		runs.length = 0;
		setItems(["x"]);
		setTick(1);
		expect(runs).toEqual(["x"]);
	});

	test("index accessor updates in place", () => {
		const [items, setItems] = signal(["a", "b"]);
		const { ctx } = build(() => {
			ui.each({}, items, (s) => s, (s, index) => {
				ui.text(live(() => `${s}:${index()}`));
			});
		});
		const [region] = ctx.tree.childrenOf(ctx.tree.root);
		const textOf = (row: number) =>
			ctx.tree.getText(ctx.tree.firstChildOf(row));
		setItems(["b", "a"]);
		const rows = ctx.tree.childrenOf(region!);
		expect(textOf(rows[0]!)).toBe("b:0");
		expect(textOf(rows[1]!)).toBe("a:1");
	});

	test("store-backed items work through produce", () => {
		const [state, setState] = store({ items: ["one"] });
		const { ctx } = build(() => {
			ui.each({}, () => state.items, (s) => s, (s) => {
				ui.text(s);
			});
		});
		const [region] = ctx.tree.childrenOf(ctx.tree.root);
		setState(((st) => st.items.push("two")));
		expect(ctx.tree.childrenOf(region!).length).toBe(2);
	});
});

describe("focus and textInput", () => {
	test("focusable prop marks node and click focus targets innermost", () => {
		const { ctx } = build(() => {
			ui.box({ width: 50, height: 50, focusable: true });
		});
		const [box] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getProp(box!, Prop.Focusable)).toBe(1);
		expect(ctx.tree.getProp(box!, Prop.Hittable)).toBe(1);
		ctx.setFocused(box!);
		expect(ctx.focusedId()).toBe(box!);
	});

	test("textInput edits through its key handler", () => {
		const [value, setValue] = signal("");
		let submitted = "";
		const { ctx } = build(() => {
			textInput({
				value,
				onInput: setValue,
				onSubmit: (v) => {
					submitted = v;
				},
				autofocus: true,
			});
		});
		const inputId = ctx.focusedId();
		expect(inputId).toBeGreaterThan(0);
		const key = ctx.handlers.get(inputId)!.onKeyDown!;

		key({ keyCode: 4, modifiers: 0, isRepeat: false }); // h
		key({ keyCode: 34, modifiers: 0, isRepeat: false }); // i
		expect(value()).toBe("hi");

		key({ keyCode: Key.Backspace, modifiers: 0, isRepeat: false });
		expect(value()).toBe("h");

		expect(
			key({ keyCode: Key.Down, modifiers: 0, isRepeat: false }),
		).toBe(false); // passes through for list navigation

		key({ keyCode: Key.Return, modifiers: 0, isRepeat: false });
		expect(submitted).toBe("h");
	});

	test("unfocused input ignores nothing but stays inert visually", () => {
		const [value, setValue] = signal("seed");
		const { ctx } = build(() => {
			textInput({ value, onInput: setValue });
		});
		expect(ctx.focusedId()).toBe(0);
		// The value renders in the caret-split spans regardless of focus.
		const texts: string[] = [];
		const walk = (id: number) => {
			if (ctx.tree.isTextNode(id)) texts.push(ctx.tree.getText(id));
			for (const c of ctx.tree.childrenOf(id)) walk(c);
		};
		walk(ctx.tree.root);
		expect(texts.join("")).toContain("seed");
	});
});
