import { describe, expect, test } from "bun:test";
import { NodeKind, Prop, UiTree } from "../tree";
import { computeLayout } from "../layout";
import { FLOATS_PER_INSTANCE, paint, parseColor } from "../paint";
import { glyphRuns } from "../font";

function instance(data: Float32Array, i: number): number[] {
	return Array.from(data.subarray(i * FLOATS_PER_INSTANCE, (i + 1) * FLOATS_PER_INSTANCE));
}

describe("parseColor", () => {
	test("parses #rrggbb with implicit opaque alpha", () => {
		expect(parseColor("#ff8000")).toBe(0xff8000ff);
	});
	test("parses #rgb shorthand", () => {
		expect(parseColor("#fff")).toBe(0xffffffff);
	});
	test("parses #rrggbbaa", () => {
		expect(parseColor("#11223344")).toBe(0x11223344);
	});
	test("passes numbers through", () => {
		expect(parseColor(0x12345678)).toBe(0x12345678);
	});
	test("rejects malformed colors", () => {
		expect(() => parseColor("#12345")).toThrow();
	});
});

describe("paint", () => {
	test("boxes with background emit one rounded rect", () => {
		const tree = new UiTree();
		const box = tree.createNode(NodeKind.Box);
		tree.setProp(box, Prop.Width, 100);
		tree.setProp(box, Prop.Height, 40);
		tree.setProp(box, Prop.Bg, parseColor("#ff0000"));
		tree.setProp(box, Prop.Radius, 6);
		tree.append(tree.root, box);
		computeLayout(tree, 200, 200);
		const buffer = paint(tree);
		expect(buffer.count).toBe(1);
		const [x, y, w, h, r, g, b, a, radius] = instance(buffer.data, 0);
		expect([x, y, w, h]).toEqual([0, 0, 100, 40]);
		expect([r, g, b, a]).toEqual([1, 0, 0, 1]);
		expect(radius).toBe(6);
	});

	test("transparent boxes emit nothing", () => {
		const tree = new UiTree();
		const box = tree.createNode(NodeKind.Box);
		tree.setProp(box, Prop.Width, 10);
		tree.setProp(box, Prop.Height, 10);
		tree.append(tree.root, box);
		computeLayout(tree, 100, 100);
		expect(paint(tree).count).toBe(0);
	});

	test("border emits outer border rect then inset background", () => {
		const tree = new UiTree();
		const box = tree.createNode(NodeKind.Box);
		tree.setProp(box, Prop.Width, 50);
		tree.setProp(box, Prop.Height, 30);
		tree.setProp(box, Prop.Bg, parseColor("#000000"));
		tree.setProp(box, Prop.BorderWidth, 2);
		tree.setProp(box, Prop.BorderColor, parseColor("#00ff00"));
		tree.setProp(box, Prop.Radius, 5);
		tree.append(tree.root, box);
		computeLayout(tree, 100, 100);
		const buffer = paint(tree);
		expect(buffer.count).toBe(2);
		const border = instance(buffer.data, 0);
		const bg = instance(buffer.data, 1);
		expect(border.slice(0, 4)).toEqual([0, 0, 50, 30]);
		expect(bg.slice(0, 4)).toEqual([2, 2, 46, 26]);
		expect(bg[8]).toBe(3); // radius shrinks by border width
	});

	test("parents paint before children (painter's order)", () => {
		const tree = new UiTree();
		const parent = tree.createNode(NodeKind.Box);
		tree.setProp(parent, Prop.Width, 100);
		tree.setProp(parent, Prop.Height, 100);
		tree.setProp(parent, Prop.Bg, parseColor("#111111"));
		tree.append(tree.root, parent);
		const child = tree.createNode(NodeKind.Box);
		tree.setProp(child, Prop.Width, 10);
		tree.setProp(child, Prop.Height, 10);
		tree.setProp(child, Prop.Bg, parseColor("#eeeeee"));
		tree.append(parent, child);
		computeLayout(tree, 100, 100);
		const buffer = paint(tree);
		expect(buffer.count).toBe(2);
		expect(instance(buffer.data, 0)[2]).toBe(100); // parent first
		expect(instance(buffer.data, 1)[2]).toBe(10);
	});

	test("text emits one instance per glyph run", () => {
		const tree = new UiTree();
		const label = tree.createTextNode("II");
		tree.setProp(label, Prop.FontSize, 14);
		tree.append(tree.root, label);
		computeLayout(tree, 100, 100);
		const runsPerGlyph = glyphRuns("I").length;
		expect(paint(tree).count).toBe(runsPerGlyph * 2);
	});

	test("anchor nodes paint nothing", () => {
		const tree = new UiTree();
		const anchor = tree.createNode(NodeKind.Anchor);
		tree.setProp(anchor, Prop.Width, 50);
		tree.setProp(anchor, Prop.Height, 50);
		tree.append(tree.root, anchor);
		computeLayout(tree, 100, 100);
		expect(paint(tree).count).toBe(0);
	});
});
