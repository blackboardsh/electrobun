import { describe, expect, test } from "bun:test";
import { NodeKind, Prop, UiTree } from "../tree";
import { Align, Justify, computeLayout } from "../layout";
import { measureText } from "../font";

function boxNode(
	tree: UiTree,
	parent: number,
	props: Partial<Record<Prop, number>> = {},
): number {
	const id = tree.createNode(NodeKind.Box);
	for (const [prop, value] of Object.entries(props)) {
		tree.setProp(id, Number(prop) as Prop, value as number);
	}
	tree.append(parent, id);
	return id;
}

describe("layout", () => {
	test("column stacks children with gap and padding", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Dir, 1);
		tree.setProp(tree.root, Prop.Pad, 10);
		tree.setProp(tree.root, Prop.Gap, 5);
		const a = boxNode(tree, tree.root, {
			[Prop.Width]: 50,
			[Prop.Height]: 20,
		});
		const b = boxNode(tree, tree.root, {
			[Prop.Width]: 50,
			[Prop.Height]: 30,
		});
		computeLayout(tree, 200, 200);
		expect([tree.get(a).x, tree.get(a).y]).toEqual([10, 10]);
		expect([tree.get(b).x, tree.get(b).y]).toEqual([10, 35]);
	});

	test("row grow distributes leftover space by weight", () => {
		const tree = new UiTree();
		const fixed = boxNode(tree, tree.root, {
			[Prop.Width]: 100,
			[Prop.Height]: 10,
		});
		const growA = boxNode(tree, tree.root, {
			[Prop.Grow]: 1,
			[Prop.Height]: 10,
		});
		const growB = boxNode(tree, tree.root, {
			[Prop.Grow]: 3,
			[Prop.Height]: 10,
		});
		computeLayout(tree, 500, 100);
		expect(tree.get(fixed).w).toBe(100);
		expect(tree.get(growA).w).toBe(100);
		expect(tree.get(growB).w).toBe(300);
		expect(tree.get(growB).x).toBe(200);
	});

	test("justify center offsets children along the main axis", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Justify, Justify.Center);
		const child = boxNode(tree, tree.root, {
			[Prop.Width]: 100,
			[Prop.Height]: 50,
		});
		computeLayout(tree, 300, 100);
		expect(tree.get(child).x).toBe(100);
	});

	test("justify space-between spreads children", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Justify, Justify.SpaceBetween);
		const a = boxNode(tree, tree.root, {
			[Prop.Width]: 50,
			[Prop.Height]: 10,
		});
		const b = boxNode(tree, tree.root, {
			[Prop.Width]: 50,
			[Prop.Height]: 10,
		});
		computeLayout(tree, 300, 100);
		expect(tree.get(a).x).toBe(0);
		expect(tree.get(b).x).toBe(250);
	});

	test("align stretch fills the cross axis inside padding", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Align, Align.Stretch);
		tree.setProp(tree.root, Prop.Pad, 8);
		const child = boxNode(tree, tree.root, {
			[Prop.Width]: 40,
		});
		computeLayout(tree, 200, 100);
		expect(tree.get(child).h).toBe(84);
		expect(tree.get(child).y).toBe(8);
	});

	test("align center positions on the cross axis", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Align, Align.Center);
		const child = boxNode(tree, tree.root, {
			[Prop.Width]: 40,
			[Prop.Height]: 40,
		});
		computeLayout(tree, 200, 100);
		expect(tree.get(child).y).toBe(30);
	});

	test("auto box wraps its content plus padding (align start)", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Align, Align.Start);
		const wrapper = boxNode(tree, tree.root, { [Prop.Pad]: 6 });
		boxNode(tree, wrapper, { [Prop.Width]: 30, [Prop.Height]: 20 });
		computeLayout(tree, 400, 400);
		expect(tree.get(wrapper).w).toBe(42);
		expect(tree.get(wrapper).h).toBe(32);
	});

	test("children stretch on the cross axis by default (flexbox rule)", () => {
		const tree = new UiTree();
		// Row: auto-height box stretches to the container's height...
		const auto = boxNode(tree, tree.root, { [Prop.Width]: 40 });
		// ...a fixed cross size wins over stretch...
		const fixed = boxNode(tree, tree.root, {
			[Prop.Width]: 40,
			[Prop.Height]: 25,
		});
		// ...and text keeps its intrinsic size.
		const label = tree.createTextNode("hi");
		tree.append(tree.root, label);
		computeLayout(tree, 400, 300);
		expect(tree.get(auto).h).toBe(300);
		expect(tree.get(fixed).h).toBe(25);
		expect(tree.get(label).h).toBe(14);
	});

	test("text nodes measure from the bitmap font", () => {
		const tree = new UiTree();
		const label = tree.createTextNode("hello");
		tree.setProp(label, Prop.FontSize, 14);
		tree.append(tree.root, label);
		computeLayout(tree, 400, 400);
		const expected = measureText("hello", 14);
		expect(tree.get(label).w).toBeCloseTo(expected.w);
		expect(tree.get(label).h).toBe(14);
	});

	test("anchor nodes occupy layout space", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Dir, 1);
		boxNode(tree, tree.root, { [Prop.Height]: 40, [Prop.Width]: 40 });
		const anchor = tree.createNode(NodeKind.Anchor);
		tree.setProp(anchor, Prop.Grow, 1);
		tree.append(tree.root, anchor);
		computeLayout(tree, 300, 200);
		expect(tree.get(anchor).y).toBe(40);
		expect(tree.get(anchor).h).toBe(160);
	});
});
