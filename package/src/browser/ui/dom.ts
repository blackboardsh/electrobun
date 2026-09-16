// Warren's DOM renderer — the browser/webview twin of the GPU retained-tree
// renderer. Same reactivity core, same JSX semantics (components run once,
// reactivity is explicit via live()), rendered into real DOM nodes.
//
// The renderer never enumerates HTML tags: any tag name becomes
// document.createElement(tag) (createElementNS inside <svg>), Solid-style.
// The only per-key knowledge is the small property-vs-attribute table below.
//
// Regions (dynamic, each) are delimited by comment anchors so conditional
// and keyed content can live inside any parent without wrapper elements.

import {
	claimLive,
	cleanup,
	createChildScope,
	createRoot,
	disposeScope,
	getOwner,
	isLive,
	liveScope,
	runWithOwner,
	signal,
	type Accessor,
	type LiveBinding,
} from "../../shared/warren/reactive";
import {
	createJsxRuntime,
	element,
	type UIChild,
	type UIElement,
	type WarrenRenderer,
} from "../../shared/warren/jsx";

function bareFunctionError(key: string): never {
	throw new Error(
		`Warren: prop "${key}" received a bare function. Wrap reactive expressions with live(() => ...) from "electrobun/browser/ui", or pass a plain value.`,
	);
}

// ---------------------------------------------------------------------------
// Insertion point — where created nodes attach. Building is synchronous, so
// a single ambient {parent, before} pair (insertBefore semantics) is enough.
// ---------------------------------------------------------------------------

interface InsertPoint {
	parent: Node;
	/** Insert before this node; null appends. */
	before: Node | null;
	/** Namespace for created elements ("" = HTML, else SVG etc.). */
	ns: string;
}

let insert: InsertPoint | null = null;

function requireInsert(): InsertPoint {
	if (!insert) {
		throw new Error(
			"Warren: no active mount — build DOM elements inside render(...)",
		);
	}
	return insert;
}

function withInsert<T>(point: InsertPoint, fn: () => T): T {
	const prev = insert;
	insert = point;
	try {
		return fn();
	} finally {
		insert = prev;
	}
}

function docOf(node: Node): Document {
	return (node.ownerDocument ?? (node as unknown as Document)) as Document;
}

function insertNode(node: Node): void {
	const point = requireInsert();
	point.parent.insertBefore(node, point.before);
}

/**
 * The element (or container) nodes are currently attaching into — escape
 * hatch for imperative DOM code inside a bare-function child.
 */
export function currentParent(): Node {
	return requireInsert().parent;
}

// ---------------------------------------------------------------------------
// Props: property-vs-attribute, class/style shapes, events, refs.
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/** Keys that must be set as element properties, not attributes. */
const PROPERTY_KEYS = new Set([
	"value",
	"checked",
	"selected",
	"muted",
	"volume",
	"srcObject",
	"currentTime",
	"indeterminate",
	"innerHTML",
	"innerText",
	"textContent",
	"scrollTop",
	"scrollLeft",
]);

const ATTR_ALIASES: Record<string, string> = {
	className: "class",
	htmlFor: "for",
};

function applyStyle(el: any, value: unknown): void {
	if (value == null) {
		el.removeAttribute?.("style");
		return;
	}
	if (typeof value === "string") {
		el.style.cssText = value;
		return;
	}
	const style = el.style;
	for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
		if (v == null || v === false) {
			if (name.startsWith("--")) style.removeProperty(name);
			else style[name] = "";
		} else if (name.startsWith("--")) {
			style.setProperty(name, String(v));
		} else {
			style[name] = String(v);
		}
	}
}

function applyClassList(el: any, value: unknown): void {
	if (value == null) return;
	for (const [name, on] of Object.entries(value as Record<string, unknown>)) {
		// Multi-class keys ("a b") toggle each class, matching Solid.
		for (const cls of name.split(/\s+/)) {
			if (cls) el.classList.toggle(cls, !!on);
		}
	}
}

function applyProp(el: any, key: string, value: unknown): void {
	if (key === "class" || key === "className") {
		if (el.namespaceURI === SVG_NS) {
			if (value == null) el.removeAttribute("class");
			else el.setAttribute("class", String(value));
		} else {
			el.className = value == null ? "" : String(value);
		}
		return;
	}
	if (key === "classList") {
		applyClassList(el, value);
		return;
	}
	if (key === "style") {
		applyStyle(el, value);
		return;
	}
	if (PROPERTY_KEYS.has(key)) {
		el[key] = value;
		return;
	}
	const attr = ATTR_ALIASES[key] ?? key;
	if (value == null || value === false) {
		el.removeAttribute(attr);
	} else if (value === true) {
		el.setAttribute(attr, "");
	} else {
		el.setAttribute(attr, String(value));
	}
}

function applyProps(el: any, props: Record<string, unknown>): void {
	for (const [key, raw] of Object.entries(props)) {
		if (raw === undefined) continue;
		if (key === "ref") {
			if (typeof raw !== "function") {
				throw new Error("Warren: ref takes a function: ref={(el) => ...}");
			}
			raw(el);
			continue;
		}
		if (key.startsWith("on") && key.length > 2) {
			if (typeof raw !== "function") {
				throw new Error(`Warren: handler "${key}" must be a function`);
			}
			el.addEventListener(key.slice(2).toLowerCase(), raw);
			continue;
		}
		if (isLive(raw)) {
			claimLive(raw as LiveBinding<unknown>, (v) => applyProp(el, key, v));
			continue;
		}
		if (typeof raw === "function") bareFunctionError(key);
		applyProp(el, key, raw);
	}
}

// ---------------------------------------------------------------------------
// Renderer primitives
// ---------------------------------------------------------------------------

function createText(value: string | number | LiveBinding<string | number>): void {
	const point = requireInsert();
	const node = docOf(point.parent).createTextNode("");
	if (isLive(value)) {
		claimLive(value as LiveBinding<string | number>, (v) => {
			node.data = v == null ? "" : String(v);
		});
	} else {
		node.data = String(value);
	}
	insertNode(node);
}

/** Remove every node strictly between `start` and `end` (exclusive). */
function clearRange(parent: Node, start: Node, end: Node): void {
	let node = start.nextSibling;
	while (node && node !== end) {
		const next = node.nextSibling;
		parent.removeChild(node);
		node = next;
	}
}

function createDynamic(build: () => void): void {
	const point = requireInsert();
	const doc = docOf(point.parent);
	const start = doc.createComment("warren");
	const end = doc.createComment("/warren");
	insertNode(start);
	insertNode(end);
	const parent = point.parent;
	const ns = point.ns;
	liveScope(() => {
		clearRange(parent, start, end);
		withInsert({ parent, before: end, ns }, build);
	});
}

interface RowEntry {
	scope: unknown;
	start: Comment;
	end: Comment;
	setIndex: (i: number) => void;
}

/** Move the inclusive node range [entry.start, entry.end] before `before`. */
function moveRange(parent: Node, entry: RowEntry, before: Node | null): void {
	let node: Node = entry.start;
	for (;;) {
		const next = node.nextSibling;
		parent.insertBefore(node, before);
		if (node === entry.end) break;
		node = next!;
	}
}

function removeRange(parent: Node, entry: RowEntry): void {
	clearRange(parent, entry.start, entry.end);
	parent.removeChild(entry.start);
	parent.removeChild(entry.end);
}

function createEach<T>(
	items: () => readonly T[],
	key: (item: T, index: number) => string | number,
	render: (item: T, index: Accessor<number>) => void,
): void {
	const point = requireInsert();
	const doc = docOf(point.parent);
	const start = doc.createComment("warren:each");
	const end = doc.createComment("/warren:each");
	insertNode(start);
	insertNode(end);
	const parent = point.parent;
	const ns = point.ns;
	const hostOwner = getOwner();
	if (!hostOwner) {
		throw new Error("Warren: each must be created inside a reactive root");
	}
	// Row scopes parent under the host scope (not the diff scope), so rows
	// survive re-runs and are torn down with the region.
	const entries = new Map<string | number, RowEntry>();
	cleanup(() => entries.clear());

	liveScope(() => {
		const list = items();
		const seen = new Set<string | number>();
		let prevEnd: Node = start;

		for (let i = 0; i < list.length; i++) {
			const item = list[i]!;
			const k = key(item, i);
			if (seen.has(k)) {
				throw new Error(`Warren: <For> duplicate key "${String(k)}"`);
			}
			seen.add(k);

			let entry = entries.get(k);
			if (!entry) {
				const scope = createChildScope(hostOwner);
				const [index, setIndex] = signal(i);
				const rowStart = doc.createComment("row");
				const rowEnd = doc.createComment("/row");
				parent.insertBefore(rowStart, end);
				parent.insertBefore(rowEnd, end);
				// runWithOwner suspends tracking, so the diff scope never tracks
				// reads made while building a row.
				runWithOwner(scope, () =>
					withInsert({ parent, before: rowEnd, ns }, () =>
						render(item, index),
					),
				);
				entry = { scope, start: rowStart, end: rowEnd, setIndex };
				entries.set(k, entry);
			} else {
				entry.setIndex(i);
			}

			// Keep sibling order in sync with item order.
			if (prevEnd.nextSibling !== entry.start) {
				moveRange(parent, entry, prevEnd.nextSibling);
			}
			prevEnd = entry.end;
		}

		// Remove rows whose keys are gone.
		for (const [k, entry] of entries) {
			if (!seen.has(k)) {
				disposeScope(entry.scope);
				removeRange(parent, entry);
				entries.delete(k);
			}
		}
	});
}

function createIntrinsic(type: string, props: Record<string, unknown>): void {
	const point = requireInsert();
	const doc = docOf(point.parent);
	const ns = type === "svg" ? SVG_NS : point.ns;
	const el =
		ns !== ""
			? doc.createElementNS(ns, type)
			: doc.createElement(type);
	const { children, ...rest } = props;
	applyProps(el, rest);
	insertNode(el);
	if (children !== undefined) {
		// foreignObject re-enters HTML namespace.
		const childNs = type === "foreignObject" ? "" : ns;
		withInsert({ parent: el, before: null, ns: childNs }, () =>
			mountChild(children as UIChild),
		);
	}
}

function createLiveChild(binding: LiveBinding<unknown>): void {
	const point = requireInsert();
	const doc = docOf(point.parent);
	const start = doc.createComment("warren");
	const end = doc.createComment("/warren");
	insertNode(start);
	insertNode(end);
	const parent = point.parent;
	const ns = point.ns;
	liveScope(() => {
		const value = binding.fn();
		if (typeof value === "string" || typeof value === "number") {
			// Primitive result: update a single text node in place instead of
			// rebuilding the region.
			const existing = start.nextSibling;
			if (
				existing !== null &&
				existing !== end &&
				existing.nodeType === 3 &&
				existing.nextSibling === end
			) {
				(existing as Text).data = String(value);
				return;
			}
			clearRange(parent, start, end);
			parent.insertBefore(doc.createTextNode(String(value)), end);
			return;
		}
		clearRange(parent, start, end);
		if (value == null || typeof value === "boolean") return;
		withInsert({ parent, before: end, ns }, () =>
			mountChild(value as UIChild),
		);
	});
}

const renderer: WarrenRenderer = {
	text: createText,
	liveChild: createLiveChild,
	dynamic: createDynamic,
	each: createEach,
	intrinsic: createIntrinsic,
	escape(fn) {
		// A bare function child runs imperatively against the current parent;
		// if it returns something mountable, mount it.
		const result = fn();
		if (result != null) mountChild(result as UIChild);
	},
};

const runtime = createJsxRuntime(renderer);
export const jsx = runtime.jsx;
export const jsxs = runtime.jsxs;
export const Fragment = runtime.Fragment;
export const mountChild = runtime.mountChild;
export const Show = runtime.Show;
export const For = runtime.For;
export const Switch = runtime.Switch;
export { Match } from "../../shared/warren/jsx";

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * Mount a Warren app into a DOM container. The container's existing content
 * is left alone; everything Warren created is removed on dispose.
 */
export function render(
	app: () => UIElement | UIChild | void,
	container: Element,
): () => void {
	const doc = docOf(container);
	const start = doc.createComment("warren:root");
	const end = doc.createComment("/warren:root");
	container.appendChild(start);
	container.appendChild(end);
	let disposeRoot = () => {};
	createRoot((dispose) => {
		disposeRoot = dispose;
		withInsert({ parent: container, before: end, ns: "" }, () => {
			const result = app();
			if (result !== undefined) mountChild(result as UIChild);
		});
	});
	return () => {
		disposeRoot();
		clearRange(container, start, end);
		container.removeChild(start);
		container.removeChild(end);
	};
}

/**
 * Render children into a different parent (dialogs, context menus) while
 * keeping ownership — cleanup removes them when the owning scope goes away.
 */
export function Portal(props: {
	mount?: Element;
	children?: UIChild;
}): UIElement {
	return element(() => {
		const point = requireInsert();
		const target = props.mount ?? docOf(point.parent).body;
		if (!target) {
			throw new Error("Warren: <Portal> needs a mount element (no body)");
		}
		const doc = docOf(target);
		const start = doc.createComment("warren:portal");
		const end = doc.createComment("/warren:portal");
		target.appendChild(start);
		target.appendChild(end);
		cleanup(() => {
			clearRange(target, start, end);
			target.removeChild(start);
			target.removeChild(end);
		});
		withInsert({ parent: target, before: end, ns: "" }, () =>
			mountChild(props.children),
		);
	});
}
