import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { computeLayout } from "../layout";
import { paint } from "../paint";
import { textScissor } from "../textRenderer";
import { Align, NodeKind, Prop, UiTree } from "../tree";

describe("custom text layout and painting", () => {
	test("nested content uses the mount's text metrics", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Align, Align.Start);
		const panel = tree.createNode(NodeKind.Box);
		tree.setProp(panel, Prop.Pad, 4);
		tree.append(tree.root, panel);
		const label = tree.createTextNode("AV fi");
		tree.setProp(label, Prop.FontSize, 18);
		tree.append(panel, label);
		computeLayout(tree, 300, 100, (text, size) => {
			expect([text, size]).toEqual(["AV fi", 18]);
			return { w: 47, h: 23 };
		});
		expect([tree.get(panel).w, tree.get(panel).h]).toEqual([55, 31]);
		expect([tree.get(label).x, tree.get(label).y]).toEqual([4, 4]);
	});

	test("records text between its surrounding quads with the ancestor clip", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Overflow, 1);
		tree.setProp(tree.root, Prop.Bg, 0x111111ff);
		const label = tree.createTextNode("hello");
		tree.setProp(label, Prop.TextColor, 0xaabbccff);
		tree.append(tree.root, label);
		const after = tree.createNode(NodeKind.Box);
		tree.setProp(after, Prop.Width, 10);
		tree.setProp(after, Prop.Height, 10);
		tree.setProp(after, Prop.Bg, 0x222222ff);
		tree.append(tree.root, after);
		computeLayout(tree, 100, 30, () => ({ w: 40, h: 20 }));
		const buffer = paint(tree, true);
		expect(buffer.count).toBe(2);
		expect(buffer.texts).toEqual([{
			id: label, text: "hello", size: tree.getProp(label, Prop.FontSize),
			color: 0xaabbccff, x: 0, y: 0,
			clip: { x: 0, y: 0, w: 100, h: 30 }, beforeInstance: 1,
		}]);
		expect(paint(tree).texts).toBeUndefined();
	});

	test("preserves intrinsic text overflow when its fixed layout box is offscreen", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Dir, 0);
		tree.setProp(tree.root, Prop.Overflow, 1);
		tree.setProp(tree.root, Prop.Scroll, 10);
		const label = tree.createTextNode("intrinsic text extends into the viewport");
		tree.setProp(label, Prop.Width, 1);
		tree.append(tree.root, label);
		computeLayout(tree, 100, 30, () => ({ w: 200, h: 20 }));
		expect(tree.get(label).x + tree.get(label).w).toBeLessThan(0);
		const runs = paint(tree, true).texts!;
		expect(runs).toHaveLength(1);
		expect(runs[0]!.x).toBe(-10);
		expect(runs[0]!.clip).toEqual({ x: 0, y: 0, w: 100, h: 30 });
	});

	test("omits empty, transparent, and fully clipped text", () => {
		for (const [value, color, height] of [
			["", 0xffffffff, 30],
			["transparent", 0xffffff00, 30],
			["clipped", 0xffffffff, 0],
		] as const) {
			const tree = new UiTree();
			tree.setProp(tree.root, Prop.Overflow, 1);
			const label = tree.createTextNode(value);
			tree.setProp(label, Prop.TextColor, color);
			tree.append(tree.root, label);
			computeLayout(tree, 100, height);
			expect(paint(tree, true).texts).toEqual([]);
		}
	});
});

describe("physical text clipping", () => {
	test("uses actual attachment dimensions and pixel-center boundaries", () => {
		expect(textScissor({ x: 1.25, y: 2.5, w: 4, h: 6 }, {
			width: 100, height: 100, pixelWidth: 200, pixelHeight: 150,
		})).toEqual({ x: 2, y: 4, width: 8, height: 9 });
	});
	test("clamps rectangles to the attachment", () => {
		expect(textScissor({ x: -20, y: -10, w: 200, h: 100 }, {
			width: 100, height: 40, pixelWidth: 125, pixelHeight: 50,
		})).toEqual({ x: 0, y: 0, width: 125, height: 50 });
	});
});

test("renderer interleaves text, restores state, and cleans failed frames", () => {
	const fixture = fileURLToPath(new URL("../__fixtures__/textRenderer.ts", import.meta.url));
	const result = Bun.spawnSync([process.execPath, fixture], { env: process.env });
	expect(result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("Warren text renderer contract: PASS");
});
