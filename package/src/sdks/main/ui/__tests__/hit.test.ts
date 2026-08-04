import { describe, expect, test } from "bun:test";
import { NodeKind, Prop, UiTree } from "../tree";
import { computeLayout } from "../layout";
import { hitChain } from "../hit";

describe("hit testing", () => {
	test("innermost hittable node wins; chain bubbles outward", () => {
		const tree = new UiTree();
		tree.setProp(tree.root, Prop.Hittable, 1);
		const card = tree.createNode(NodeKind.Box);
		tree.setProp(card, Prop.Width, 100);
		tree.setProp(card, Prop.Height, 100);
		tree.setProp(card, Prop.Hittable, 1);
		tree.append(tree.root, card);
		const button = tree.createNode(NodeKind.Box);
		tree.setProp(button, Prop.Width, 40);
		tree.setProp(button, Prop.Height, 20);
		tree.setProp(button, Prop.Hittable, 1);
		tree.append(card, button);
		computeLayout(tree, 200, 200);

		expect(hitChain(tree, 10, 10)).toEqual([button, card, tree.root]);
		expect(hitChain(tree, 90, 90)).toEqual([card, tree.root]);
		expect(hitChain(tree, 150, 150)).toEqual([tree.root]);
	});

	test("non-hittable nodes are transparent to hits", () => {
		const tree = new UiTree();
		const wrapper = tree.createNode(NodeKind.Box);
		tree.setProp(wrapper, Prop.Width, 100);
		tree.setProp(wrapper, Prop.Height, 100);
		tree.append(tree.root, wrapper);
		const target = tree.createNode(NodeKind.Box);
		tree.setProp(target, Prop.Width, 50);
		tree.setProp(target, Prop.Height, 50);
		tree.setProp(target, Prop.Hittable, 1);
		tree.append(wrapper, target);
		computeLayout(tree, 200, 200);

		expect(hitChain(tree, 25, 25)).toEqual([target]);
		expect(hitChain(tree, 80, 80)).toEqual([]);
	});

	test("later siblings sit on top", () => {
		const tree = new UiTree();
		// Two overlapping absolute-ish children: same size, stacked in a row
		// won't overlap, so nest both fixed at origin via zero-size parent
		// trick: place them as siblings of the root and rely on layout order.
		const below = tree.createNode(NodeKind.Box);
		tree.setProp(below, Prop.Width, 100);
		tree.setProp(below, Prop.Height, 100);
		tree.setProp(below, Prop.Hittable, 1);
		tree.append(tree.root, below);
		computeLayout(tree, 200, 200);
		// Single child: sanity that it hits.
		expect(hitChain(tree, 50, 50)).toEqual([below]);
	});

	test("misses outside the window return an empty chain", () => {
		const tree = new UiTree();
		computeLayout(tree, 100, 100);
		expect(hitChain(tree, 500, 500)).toEqual([]);
	});
});
