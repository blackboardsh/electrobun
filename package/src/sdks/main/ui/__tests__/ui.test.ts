// Headless integration: the builder API driving the retained tree through
// signals — the whole runtime except the GPU and the window.

import { describe, expect, test } from "bun:test";
import { createRoot, live, signal, store } from "../reactive";
import { Prop } from "../tree";
import { computeLayout } from "../layout";
import { hitChain } from "../hit";
import { parseColor } from "../paint";
import { createUiContext, ui, withUiContext, type UiContext } from "../ui";

function build(app: () => void): {
	ctx: UiContext;
	dispose: () => void;
} {
	const ctx = createUiContext();
	let dispose = () => {};
	createRoot((d) => {
		dispose = d;
		withUiContext(ctx, app);
	});
	return { ctx, dispose };
}

describe("builder API", () => {
	test("children nest under the declaring parent", () => {
		const { ctx } = build(() => {
			ui.column({}, () => {
				ui.text("a");
				ui.text("b");
			});
		});
		const [col] = ctx.tree.childrenOf(ctx.tree.root);
		const kids = ctx.tree.childrenOf(col!);
		expect(kids.length).toBe(2);
		expect(ctx.tree.getText(kids[0]!)).toBe("a");
		expect(ctx.tree.getText(kids[1]!)).toBe("b");
	});

	test("thunk props become fine-grained effects on one tree prop", () => {
		const [bg, setBg] = signal("#111111");
		const { ctx } = build(() => {
			ui.box({ bg: live(bg) });
		});
		const [box] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getProp(box!, Prop.Bg)).toBe(parseColor("#111111"));
		ctx.tree.takeDirty();
		setBg("#222222");
		expect(ctx.tree.getProp(box!, Prop.Bg)).toBe(parseColor("#222222"));
		expect(ctx.tree.takeDirty()).toBe(true);
	});

	test("reactive text updates the text node", () => {
		const [count, setCount] = signal(0);
		const { ctx } = build(() => {
			ui.text(live(() => `Count: ${count()}`));
		});
		const [label] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getText(label!)).toBe("Count: 0");
		setCount(5);
		expect(ctx.tree.getText(label!)).toBe("Count: 5");
	});

	test("bare functions in value props throw loudly", () => {
		const [bg] = signal("#111111");
		expect(() =>
			build(() => {
				ui.box({ bg: bg as any });
			}),
		).toThrow(/live\(/);
		expect(() =>
			build(() => {
				ui.text((() => "nope") as any);
			}),
		).toThrow(/live\(/);
	});

	test("reactive text updates via marker", () => {
		const [count, setCount] = signal(0);
		const { ctx } = build(() => {
			ui.text(live(() => `Count: ${count()}`));
		});
		const [label] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getText(label!)).toBe("Count: 0");
		setCount(5);
		expect(ctx.tree.getText(label!)).toBe("Count: 5");
	});

	test("handlers register, mark hittable, and unregister on dispose", () => {
		let clicks = 0;
		const { ctx, dispose } = build(() => {
			ui.box({
				width: 50,
				height: 50,
				onClick: () => clicks++,
			});
		});
		const [box] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.getProp(box!, Prop.Hittable)).toBe(1);
		computeLayout(ctx.tree, 100, 100);
		expect(hitChain(ctx.tree, 10, 10)).toEqual([box!]);
		ctx.handlers.get(box!)!.onClick!({ x: 10, y: 10, target: box! });
		expect(clicks).toBe(1);
		dispose();
		expect(ctx.handlers.size).toBe(0);
	});

	test("dynamic regions rebuild when store state changes", () => {
		const [state, setState] = store({
			items: [] as string[],
		});
		const { ctx } = build(() => {
			ui.dynamic({ dir: "column" }, () => {
				for (const item of state.items) {
					ui.text(item);
				}
			});
		});
		const [region] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.tree.childrenOf(region!).length).toBe(0);

		setState(((s) => s.items.push("first")));
		expect(ctx.tree.childrenOf(region!).length).toBe(1);

		setState(((s) => s.items.push("second")));
		const kids = ctx.tree.childrenOf(region!);
		expect(kids.length).toBe(2);
		expect(ctx.tree.getText(kids[0]!)).toBe("first");
		expect(ctx.tree.getText(kids[1]!)).toBe("second");
	});

	test("dynamic rebuilds dispose stale handlers and nodes", () => {
		const [show, setShow] = signal(true);
		const { ctx } = build(() => {
			ui.dynamic({}, () => {
				if (show()) {
					ui.box({ width: 10, height: 10, onClick: () => {} });
				}
			});
		});
		expect(ctx.handlers.size).toBe(1);
		const sizeWithButton = ctx.tree.size;
		setShow(false);
		expect(ctx.handlers.size).toBe(0);
		expect(ctx.tree.size).toBe(sizeWithButton - 1);
		setShow(true);
		expect(ctx.handlers.size).toBe(1);
	});

	test("anchors report through the anchor registry", () => {
		const frames: Array<{ width: number }> = [];
		const { ctx } = build(() => {
			ui.anchor({
				grow: 1,
				onFrame: (rect) => frames.push({ width: rect.width }),
			});
		});
		expect(ctx.anchors.size).toBe(1);
		const [anchorId] = ctx.tree.childrenOf(ctx.tree.root);
		computeLayout(ctx.tree, 300, 100);
		const node = ctx.tree.get(anchorId!);
		ctx.anchors.get(anchorId!)!({
			x: node.x,
			y: node.y,
			width: node.w,
			height: node.h,
		});
		expect(frames).toEqual([{ width: 300 }]);
	});

	test("webview anchors are registered for native compositor masks", () => {
		const { ctx, dispose } = build(() => {
			ui.anchor({ nativeLayer: "webview", onFrame: () => {} });
		});
		const [anchorId] = ctx.tree.childrenOf(ctx.tree.root);
		expect(ctx.webviewAnchors.has(anchorId!)).toBe(true);

		dispose();
		expect(ctx.webviewAnchors.size).toBe(0);
	});
});
