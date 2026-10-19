import { expect, test } from "bun:test";
import { NodeKind, Prop, UiTree } from "../tree";
import { computeLayout } from "../layout";
import { paint } from "../paint";
import { physicalSize, pixelRatioForFrame } from "../pixelSize";

test("renderer measurements stay mount-local; external text preserves painter order and clipping", () => {
	const tree = new UiTree();
	const container = tree.createNode(NodeKind.Box);
	tree.setProp(container, Prop.Width, 100);
	tree.setProp(container, Prop.Height, 30);
	tree.setProp(container, Prop.Overflow, 1);
	tree.setProp(container, Prop.Bg, 0xffffffff);
	tree.append(tree.root, container);
	const text = tree.createNode(NodeKind.Text);
	tree.setText(text, "office fi");
	tree.append(container, text);
	const cover = tree.createNode(NodeKind.Box);
	tree.setProp(cover, Prop.Width, 10);
	tree.setProp(cover, Prop.Height, 10);
	tree.setProp(cover, Prop.Bg, 0xffffffff);
	tree.append(container, cover);
	computeLayout(tree, 200, 100, () => ({ w: 64, h: 20 }));
	expect(tree.get(text).w).toBe(64);
	const buffer = paint(tree, true);
	expect(buffer.count).toBe(2);
	expect(buffer.texts).toHaveLength(1);
	expect(buffer.texts![0]).toMatchObject({ id: text, text: "office fi", beforeInstance: 1, clip: { x: 0, y: 0, w: 100, h: 30 } });
	computeLayout(tree, 200, 100, () => ({ w: 25, h: 12 }));
	expect(tree.get(text).w).toBe(25);
	expect(paint(tree).texts).toBeUndefined();
});

test("physical extents scale once, including fractional DPI, without changing logical geometry", () => {
	expect(physicalSize(900, 540, 2)).toEqual({ width: 1800, height: 1080 });
	expect(physicalSize(101, 51, 1.25)).toEqual({ width: 126, height: 64 });
	expect(physicalSize(900, 540, 1)).toEqual({ width: 900, height: 540 });
	expect(() => physicalSize(900, 540, 0)).toThrow(RangeError);
});

test("moving between displays chooses the largest overlap in logical screen coordinates", () => {
	const displays = [
		{ bounds: { x: -1000, y: 0, width: 1000, height: 800 }, scaleFactor: 1.25 },
		{ bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 2 },
	];
	expect(pixelRatioForFrame({ x: -600, y: 50, width: 800, height: 400 }, displays)).toBe(1.25);
	expect(pixelRatioForFrame({ x: -200, y: 50, width: 800, height: 400 }, displays)).toBe(2);
});
