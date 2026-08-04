import { describe, expect, test } from "bun:test";
import { NodeKind, Prop, UiTree } from "../tree";

describe("retained tree", () => {
	test("append and traverse siblings in order", () => {
		const tree = new UiTree();
		const a = tree.createNode(NodeKind.Box);
		const b = tree.createNode(NodeKind.Box);
		const c = tree.createNode(NodeKind.Box);
		tree.append(tree.root, a);
		tree.append(tree.root, b);
		tree.append(tree.root, c);
		expect(tree.childrenOf(tree.root)).toEqual([a, b, c]);
		expect(tree.firstChildOf(tree.root)).toBe(a);
		expect(tree.nextSiblingOf(a)).toBe(b);
		expect(tree.parentOf(c)).toBe(tree.root);
	});

	test("insertBefore an anchor", () => {
		const tree = new UiTree();
		const a = tree.createNode(NodeKind.Box);
		const b = tree.createNode(NodeKind.Box);
		const c = tree.createNode(NodeKind.Box);
		tree.append(tree.root, a);
		tree.append(tree.root, c);
		tree.insertBefore(tree.root, b, c);
		expect(tree.childrenOf(tree.root)).toEqual([a, b, c]);
	});

	test("insertBefore the first child updates first pointer", () => {
		const tree = new UiTree();
		const a = tree.createNode(NodeKind.Box);
		const b = tree.createNode(NodeKind.Box);
		tree.append(tree.root, a);
		tree.insertBefore(tree.root, b, a);
		expect(tree.childrenOf(tree.root)).toEqual([b, a]);
	});

	test("re-parenting detaches from the old parent", () => {
		const tree = new UiTree();
		const parentA = tree.createNode(NodeKind.Box);
		const parentB = tree.createNode(NodeKind.Box);
		const child = tree.createNode(NodeKind.Box);
		tree.append(tree.root, parentA);
		tree.append(tree.root, parentB);
		tree.append(parentA, child);
		tree.append(parentB, child);
		expect(tree.childrenOf(parentA)).toEqual([]);
		expect(tree.childrenOf(parentB)).toEqual([child]);
	});

	test("destroy frees the whole subtree", () => {
		const tree = new UiTree();
		const parent = tree.createNode(NodeKind.Box);
		const child = tree.createNode(NodeKind.Box);
		const grandchild = tree.createTextNode("hi");
		tree.append(tree.root, parent);
		tree.append(parent, child);
		tree.append(child, grandchild);
		const before = tree.size;
		tree.destroy(parent);
		expect(tree.size).toBe(before - 3);
		expect(tree.has(parent)).toBe(false);
		expect(tree.has(grandchild)).toBe(false);
		expect(tree.childrenOf(tree.root)).toEqual([]);
	});

	test("props only dirty the tree when they change", () => {
		const tree = new UiTree();
		const box = tree.createNode(NodeKind.Box);
		tree.append(tree.root, box);
		tree.takeDirty();
		tree.setProp(box, Prop.Gap, 8);
		expect(tree.takeDirty()).toBe(true);
		tree.setProp(box, Prop.Gap, 8);
		expect(tree.takeDirty()).toBe(false);
	});

	test("text updates dirty the tree", () => {
		const tree = new UiTree();
		const label = tree.createTextNode("a");
		tree.append(tree.root, label);
		tree.takeDirty();
		tree.setText(label, "b");
		expect(tree.takeDirty()).toBe(true);
		tree.setText(label, "b");
		expect(tree.takeDirty()).toBe(false);
	});

	test("guards: root cannot be destroyed or re-parented", () => {
		const tree = new UiTree();
		expect(() => tree.destroy(tree.root)).toThrow();
		const box = tree.createNode(NodeKind.Box);
		expect(() => tree.insertBefore(box, tree.root)).toThrow();
	});
});
