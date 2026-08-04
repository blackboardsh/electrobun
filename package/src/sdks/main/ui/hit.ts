// Hit testing over the laid-out tree. Later siblings render on top, so the
// deepest match in the last matching branch wins. Pure — testable without a
// GPU or window.

import { Prop, type UiTree } from "./tree";

function contains(tree: UiTree, id: number, x: number, y: number): boolean {
	const node = tree.get(id);
	return x >= node.x && y >= node.y && x < node.x + node.w && y < node.y + node.h;
}

/** Deepest node containing the point, regardless of hittability. */
function deepestAt(tree: UiTree, id: number, x: number, y: number): number {
	if (!contains(tree, id, x, y)) return 0;
	const children = tree.childrenOf(id);
	for (let i = children.length - 1; i >= 0; i--) {
		const hit = deepestAt(tree, children[i]!, x, y);
		if (hit !== 0) return hit;
	}
	return id;
}

/**
 * Hittable nodes under the point, innermost first — the dispatch chain for
 * bubbling. Empty when nothing hittable is under the point.
 */
export function hitChain(tree: UiTree, x: number, y: number): number[] {
	const deepest = deepestAt(tree, tree.root, x, y);
	const chain: number[] = [];
	for (let id = deepest; id !== 0; id = tree.parentOf(id)) {
		if (tree.getProp(id, Prop.Hittable) === 1) chain.push(id);
	}
	return chain;
}
