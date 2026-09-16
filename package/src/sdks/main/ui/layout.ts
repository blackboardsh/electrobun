// Minimal flex-like layout over the retained tree: row/column direction,
// padding, gap, fixed or content sizing, grow distribution, justify/align.
// Pure — no Electrobun imports — so it runs under plain `bun test`.

import { Align, Justify, NodeKind, Prop, type UiTree } from "./tree";
import { measure as measureText } from "./text";

export { Align, Justify };

const isColumn = (tree: UiTree, id: number) => tree.getProp(id, Prop.Dir) === 1;

/**
 * Natural (content) size of a node given no forced dimensions. Fixed props
 * win; boxes sum children along the main axis and take the max cross size.
 */
function measure(tree: UiTree, id: number): { w: number; h: number } {
	const node = tree.get(id);
	const fixedW = node.props[Prop.Width]!;
	const fixedH = node.props[Prop.Height]!;

	if (node.kind === NodeKind.Text) {
		const size = measureText(node.text, node.props[Prop.FontSize]!);
		return {
			w: fixedW >= 0 ? fixedW : size.w,
			h: fixedH >= 0 ? fixedH : size.h,
		};
	}

	if (fixedW >= 0 && fixedH >= 0) return { w: fixedW, h: fixedH };

	const pad = node.props[Prop.Pad]!;
	const gap = node.props[Prop.Gap]!;
	const column = isColumn(tree, id);

	let main = 0;
	let cross = 0;
	let count = 0;
	for (let c = node.first; c !== 0; c = tree.get(c).next) {
		const size = measure(tree, c);
		const childMain = column ? size.h : size.w;
		const childCross = column ? size.w : size.h;
		main += childMain;
		cross = Math.max(cross, childCross);
		count++;
	}
	if (count > 1) main += gap * (count - 1);

	const contentW = (column ? cross : main) + pad * 2;
	const contentH = (column ? main : cross) + pad * 2;
	return {
		w: fixedW >= 0 ? fixedW : contentW,
		h: fixedH >= 0 ? fixedH : contentH,
	};
}

/**
 * Assign the final rect for `id` and arrange its children inside it.
 * Coordinates are absolute (window content space).
 */
function place(
	tree: UiTree,
	id: number,
	x: number,
	y: number,
	w: number,
	h: number,
): void {
	const node = tree.get(id);
	node.x = x;
	node.y = y;
	node.w = w;
	node.h = h;

	if (node.kind !== NodeKind.Box && node.kind !== NodeKind.Anchor) return;

	const pad = node.props[Prop.Pad]!;
	const gap = node.props[Prop.Gap]!;
	const justify = node.props[Prop.Justify]! as Justify;
	const align = node.props[Prop.Align]! as Align;
	const column = isColumn(tree, id);

	const innerX = x + pad;
	const innerY = y + pad;
	const innerW = Math.max(0, w - pad * 2);
	const innerH = Math.max(0, h - pad * 2);
	const innerMain = column ? innerH : innerW;
	const innerCross = column ? innerW : innerH;

	const scrollable = node.props[Prop.Overflow]! === 1;

	// First pass: natural sizes and grow weights.
	const children = tree.childrenOf(id);
	if (children.length === 0) {
		node.contentMain = pad * 2;
		return;
	}
	const mains: number[] = [];
	const crosses: number[] = [];
	let usedMain = 0;
	let totalGrow = 0;
	for (const child of children) {
		const size = measure(tree, child);
		const main = column ? size.h : size.w;
		const cross = column ? size.w : size.h;
		mains.push(main);
		crosses.push(cross);
		usedMain += main;
		totalGrow += tree.getProp(child, Prop.Grow);
	}
	const gapsTotal = gap * (children.length - 1);
	usedMain += gapsTotal;
	node.contentMain = usedMain + pad * 2;

	// Distribute leftover space to grow children. Scroll containers keep
	// natural sizes — content defines its own extent.
	const leftover = Math.max(0, innerMain - usedMain);
	if (!scrollable && leftover > 0 && totalGrow > 0) {
		for (let i = 0; i < children.length; i++) {
			const grow = tree.getProp(children[i]!, Prop.Grow);
			if (grow > 0) {
				mains[i]! += (leftover * grow) / totalGrow;
			}
		}
		usedMain = innerMain;
	}

	// Main-axis start offset / spacing from justify. Scroll containers pin to
	// start and offset by the scroll position instead.
	let cursor = column ? innerY : innerX;
	let spacing = gap;
	if (scrollable) {
		cursor -= node.props[Prop.Scroll]!;
	} else {
		const free = Math.max(0, innerMain - usedMain);
		if (justify === Justify.Center) cursor += free / 2;
		else if (justify === Justify.End) cursor += free;
		else if (justify === Justify.SpaceBetween && children.length > 1) {
			spacing = gap + free / (children.length - 1);
		}
	}

	for (let i = 0; i < children.length; i++) {
		const child = children[i]!;
		const main = mains[i]!;
		let cross = crosses[i]!;
		if (align === Align.Stretch) {
			// Flexbox rule: stretch only fills auto cross sizes — a fixed
			// width/height wins, and text keeps its intrinsic size.
			const childNode = tree.get(child);
			const crossFixed =
				childNode.props[column ? Prop.Width : Prop.Height]! >= 0;
			if (!crossFixed && childNode.kind !== NodeKind.Text) {
				cross = innerCross;
			}
		}
		cross = Math.min(cross, innerCross);

		let crossOffset = 0;
		if (align === Align.Center) crossOffset = (innerCross - cross) / 2;
		else if (align === Align.End) crossOffset = innerCross - cross;

		if (column) {
			place(tree, child, innerX + crossOffset, cursor, cross, main);
		} else {
			place(tree, child, cursor, innerY + crossOffset, main, cross);
		}
		cursor += main + spacing;
	}
}

/** Lay out the whole tree into a width x height window content area. */
export function computeLayout(
	tree: UiTree,
	width: number,
	height: number,
): void {
	place(tree, tree.root, 0, 0, width, height);
}
