// ABI-shaped retained UI tree. Everything crossing this interface is a number
// (u32 node ids, numeric prop ids, f64 values) or a UTF-8 string, so the
// implementation can later move behind Electrobun's core C ABI — with each
// mainProcess language SDK binding the same operations — without changing any
// code written against it.

export const enum NodeKind {
	Box = 1,
	Text = 2,
	// Layout-only anchor: reports its computed rect so nativeWrapper can
	// position a native layer (webview, wgpu view) over it — the same anchor
	// role <electrobun-webview>/<electrobun-wgpu> play inside webviews.
	Anchor = 3,
}

export const enum Prop {
	Dir = 1, // 0 row, 1 column
	Gap = 2,
	Pad = 3,
	Width = 4, // -1 auto
	Height = 5, // -1 auto
	Grow = 6,
	Justify = 7, // 0 start, 1 center, 2 end, 3 space-between
	Align = 8, // 0 start, 1 center, 2 end, 3 stretch
	Bg = 9, // color as u32 0xRRGGBBAA; alpha 0 = not painted
	Radius = 10,
	BorderWidth = 11,
	BorderColor = 12, // u32 0xRRGGBBAA
	FontSize = 13, // glyph height in px
	TextColor = 14, // u32 0xRRGGBBAA
	Hittable = 15, // 0/1
	Overflow = 16, // 0 visible, 1 scroll (clips children, scrollable main axis)
	Scroll = 17, // main-axis scroll offset in px (Overflow=1 boxes)
	Focusable = 18, // 0/1
	WindowDrag = 19, // 0/1 — pressing this node drags the host window
}

const PROP_SLOTS = 20;

export const AUTO = -1;

export const enum Justify {
	Start = 0,
	Center = 1,
	End = 2,
	SpaceBetween = 3,
}

export const enum Align {
	Start = 0,
	Center = 1,
	End = 2,
	Stretch = 3,
}

export interface NodeRecord {
	kind: NodeKind;
	parent: number;
	first: number;
	last: number;
	prev: number;
	next: number;
	props: Float64Array;
	text: string;
	// Computed layout, absolute px from the window's top-left content corner.
	x: number;
	y: number;
	w: number;
	h: number;
	// Natural main-axis extent of children (Overflow=1 boxes): scroll range.
	// Main-axis means height for columns, width for rows.
	contentMain: number;
}

function defaultProps(kind: NodeKind): Float64Array {
	const props = new Float64Array(PROP_SLOTS);
	props[Prop.Width] = AUTO;
	props[Prop.Height] = AUTO;
	// Flexbox default: children stretch on the cross axis (layout applies it
	// only to auto-sized, non-text children).
	props[Prop.Align] = Align.Stretch;
	if (kind === NodeKind.Text) {
		props[Prop.FontSize] = 14;
		props[Prop.TextColor] = 0xffffffff;
	}
	return props;
}

export class UiTree {
	private nodes = new Map<number, NodeRecord>();
	private nextId = 1;
	private dirty = true;
	readonly root: number;

	constructor() {
		this.root = this.createNode(NodeKind.Box);
	}

	get(id: number): NodeRecord {
		const node = this.nodes.get(id);
		if (!node) throw new Error(`Unknown UI node ${id}`);
		return node;
	}

	has(id: number): boolean {
		return this.nodes.has(id);
	}

	createNode(kind: NodeKind): number {
		const id = this.nextId++;
		this.nodes.set(id, {
			kind,
			parent: 0,
			first: 0,
			last: 0,
			prev: 0,
			next: 0,
			props: defaultProps(kind),
			text: "",
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			contentMain: 0,
		});
		this.dirty = true;
		return id;
	}

	createTextNode(text: string): number {
		const id = this.createNode(NodeKind.Text);
		this.get(id).text = text;
		return id;
	}

	setProp(id: number, prop: Prop, value: number): void {
		const node = this.get(id);
		if (node.props[prop] !== value) {
			node.props[prop] = value;
			this.dirty = true;
		}
	}

	getProp(id: number, prop: Prop): number {
		return this.get(id).props[prop]!;
	}

	setText(id: number, text: string): void {
		const node = this.get(id);
		if (node.kind !== NodeKind.Text) {
			throw new Error(`Node ${id} is not a text node`);
		}
		if (node.text !== text) {
			node.text = text;
			this.dirty = true;
		}
	}

	getText(id: number): string {
		return this.get(id).text;
	}

	isTextNode(id: number): boolean {
		return this.get(id).kind === NodeKind.Text;
	}

	parentOf(id: number): number {
		return this.get(id).parent;
	}

	firstChildOf(id: number): number {
		return this.get(id).first;
	}

	nextSiblingOf(id: number): number {
		return this.get(id).next;
	}

	childrenOf(id: number): number[] {
		const out: number[] = [];
		for (let c = this.get(id).first; c !== 0; c = this.get(c).next) {
			out.push(c);
		}
		return out;
	}

	/** Insert `id` under `parent`, before `anchor` (0 appends). */
	insertBefore(parent: number, id: number, anchor = 0): void {
		if (id === this.root) throw new Error("Cannot re-parent the root node");
		const node = this.get(id);
		const parentNode = this.get(parent);
		if (node.parent !== 0) this.detach(id);

		if (anchor === 0) {
			node.prev = parentNode.last;
			node.next = 0;
			if (parentNode.last !== 0) this.get(parentNode.last).next = id;
			parentNode.last = id;
			if (parentNode.first === 0) parentNode.first = id;
		} else {
			const anchorNode = this.get(anchor);
			if (anchorNode.parent !== parent) {
				throw new Error(`Anchor ${anchor} is not a child of ${parent}`);
			}
			node.prev = anchorNode.prev;
			node.next = anchor;
			if (anchorNode.prev !== 0) this.get(anchorNode.prev).next = id;
			else parentNode.first = id;
			anchorNode.prev = id;
		}
		node.parent = parent;
		this.dirty = true;
	}

	append(parent: number, id: number): void {
		this.insertBefore(parent, id, 0);
	}

	/** Unlink `id` from its parent, keeping the subtree alive. */
	detach(id: number): void {
		const node = this.get(id);
		if (node.parent === 0) return;
		const parentNode = this.get(node.parent);
		if (node.prev !== 0) this.get(node.prev).next = node.next;
		else parentNode.first = node.next;
		if (node.next !== 0) this.get(node.next).prev = node.prev;
		else parentNode.last = node.prev;
		node.parent = 0;
		node.prev = 0;
		node.next = 0;
		this.dirty = true;
	}

	/** Detach `id` and free its whole subtree. */
	destroy(id: number): void {
		if (id === this.root) throw new Error("Cannot destroy the root node");
		this.detach(id);
		const stack = [id];
		while (stack.length) {
			const current = stack.pop()!;
			for (
				let c = this.get(current).first;
				c !== 0;
				c = this.nodes.get(c)?.next ?? 0
			) {
				stack.push(c);
			}
			this.nodes.delete(current);
		}
		this.dirty = true;
	}

	destroyChildren(id: number): void {
		for (const child of this.childrenOf(id)) {
			this.destroy(child);
		}
	}

	get size(): number {
		return this.nodes.size;
	}

	markDirty(): void {
		this.dirty = true;
	}

	isDirty(): boolean {
		return this.dirty;
	}

	takeDirty(): boolean {
		const was = this.dirty;
		this.dirty = false;
		return was;
	}
}
