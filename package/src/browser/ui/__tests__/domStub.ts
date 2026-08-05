// Minimal DOM implementation for headless renderer tests — no third-party
// dependency. Implements exactly the surface Warren's DOM renderer touches;
// if the renderer starts using more DOM, this stub fails loudly and the new
// surface gets added here consciously.

export class StubNode {
	nodeType: number;
	ownerDocument: StubDocument | null = null;
	parentNode: StubNode | null = null;
	childNodes: StubNode[] = [];

	constructor(nodeType: number) {
		this.nodeType = nodeType;
	}

	get nextSibling(): StubNode | null {
		if (!this.parentNode) return null;
		const siblings = this.parentNode.childNodes;
		const idx = siblings.indexOf(this);
		return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1]! : null;
	}

	get firstChild(): StubNode | null {
		return this.childNodes[0] ?? null;
	}

	insertBefore(node: StubNode, before: StubNode | null): StubNode {
		if (node.parentNode) node.parentNode.removeChild(node);
		if (before === null) {
			this.childNodes.push(node);
		} else {
			const idx = this.childNodes.indexOf(before);
			if (idx < 0) throw new Error("stub: insertBefore anchor not a child");
			this.childNodes.splice(idx, 0, node);
		}
		node.parentNode = this;
		return node;
	}

	appendChild(node: StubNode): StubNode {
		return this.insertBefore(node, null);
	}

	removeChild(node: StubNode): StubNode {
		const idx = this.childNodes.indexOf(node);
		if (idx < 0) throw new Error("stub: removeChild of non-child");
		this.childNodes.splice(idx, 1);
		node.parentNode = null;
		return node;
	}
}

export class StubText extends StubNode {
	data = "";
	constructor() {
		super(3);
	}
	get textContent(): string {
		return this.data;
	}
}

export class StubComment extends StubNode {
	data = "";
	constructor() {
		super(8);
	}
}

class StubClassList {
	private owner: StubElement;
	constructor(owner: StubElement) {
		this.owner = owner;
	}
	private set(): Set<string> {
		return new Set((this.owner.className ?? "").split(/\s+/).filter(Boolean));
	}
	private write(set: Set<string>): void {
		this.owner.className = [...set].join(" ");
	}
	add(cls: string): void {
		const s = this.set();
		s.add(cls);
		this.write(s);
	}
	remove(cls: string): void {
		const s = this.set();
		s.delete(cls);
		this.write(s);
	}
	toggle(cls: string, force?: boolean): boolean {
		const s = this.set();
		const on = force ?? !s.has(cls);
		if (on) s.add(cls);
		else s.delete(cls);
		this.write(s);
		return on;
	}
	contains(cls: string): boolean {
		return this.set().has(cls);
	}
}

class StubStyle {
	[key: string]: unknown;
	cssText = "";
	setProperty(name: string, value: string): void {
		(this as Record<string, unknown>)[name] = value;
	}
	removeProperty(name: string): void {
		delete (this as Record<string, unknown>)[name];
	}
}

export class StubElement extends StubNode {
	tagName: string;
	namespaceURI: string;
	className = "";
	attributes = new Map<string, string>();
	style = new StubStyle();
	classList = new StubClassList(this);
	listeners = new Map<string, Array<(event: unknown) => void>>();
	// Property-set keys land as plain fields:
	value: unknown;
	checked: unknown;
	innerHTML: unknown;

	constructor(tagName: string, namespaceURI = "") {
		super(1);
		this.tagName = tagName;
		this.namespaceURI = namespaceURI;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
	}
	removeEventListener(type: string, handler: (event: unknown) => void): void {
		const list = this.listeners.get(type);
		if (!list) return;
		const idx = list.indexOf(handler);
		if (idx >= 0) list.splice(idx, 1);
	}
	dispatch(type: string, event: unknown = { type }): void {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}

	/** Test helper: concatenated text of the subtree. */
	get textContent(): string {
		let out = "";
		for (const child of this.childNodes) {
			if (child instanceof StubText) out += child.data;
			else if (child instanceof StubElement) out += child.textContent;
		}
		return out;
	}

	/** Test helper: element children only (comments/text skipped). */
	get children(): StubElement[] {
		return this.childNodes.filter(
			(n): n is StubElement => n instanceof StubElement,
		);
	}
}

export class StubDocument {
	body: StubElement;

	constructor() {
		this.body = this.createElement("body");
	}

	private adopt<T extends StubNode>(node: T): T {
		node.ownerDocument = this;
		return node;
	}

	createElement(tagName: string): StubElement {
		return this.adopt(new StubElement(tagName));
	}
	createElementNS(ns: string, tagName: string): StubElement {
		return this.adopt(new StubElement(tagName, ns));
	}
	createTextNode(data: string): StubText {
		const node = this.adopt(new StubText());
		node.data = data;
		return node;
	}
	createComment(data: string): StubComment {
		const node = this.adopt(new StubComment());
		node.data = data;
		return node;
	}
}

/** A fresh document + detached container, typed loosely for render(). */
export function createStubRoot(): {
	document: StubDocument;
	container: StubElement;
} {
	const document = new StubDocument();
	const container = document.createElement("div");
	return { document, container };
}
