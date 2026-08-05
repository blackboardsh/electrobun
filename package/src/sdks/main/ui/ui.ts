// Builder-style UI API over the retained tree. Components are plain
// functions; children are declared in a callback so code indents like
// markup; any prop can be a thunk, which becomes its own fine-grained
// effect updating exactly one tree prop.
//
//   ui.column({ pad: 24, gap: 12, bg: "#16161e" }, () => {
//     ui.text(() => `Count: ${count()}`, { size: 42, color: accent });
//     ui.row({ gap: 8 }, () => { ... });
//   });

import {
	Owner,
	createEffect,
	createSignal,
	getOwner,
	isReactive,
	onCleanup,
	runWithOwner,
	untrack,
	type Accessor,
	type ReactiveThunk,
} from "./reactive";
import { NodeKind, Prop, UiTree } from "./tree";
import { Align, Justify } from "./layout";
import { parseColor } from "./paint";

/**
 * A value prop: a plain value, or a thunk marked with `_()` / `reactive()`.
 * Bare functions are rejected so reactive boundaries stay searchable.
 */
export type Reactive<T> = T | ReactiveThunk<T>;

function bareFunctionError(): never {
	throw new Error(
		'ui: a value prop received a bare function. Wrap reactive expressions with _(() => ...) from "electrobun/main/ui", or pass a plain value.',
	);
}

export interface PointerEventInfo {
	x: number;
	y: number;
	target: number;
}

export interface KeyEventInfo {
	keyCode: number;
	modifiers: number;
	isRepeat: boolean;
	/** Characters produced by the keyboard layout (native key events only). */
	chars?: string;
}

export interface Handlers {
	onClick?: (e: PointerEventInfo) => void;
	onPointerDown?: (e: PointerEventInfo) => void;
	onPointerUp?: (e: PointerEventInfo) => void;
	onPointerEnter?: (e: PointerEventInfo) => void;
	onPointerLeave?: (e: PointerEventInfo) => void;
	/** Keys route to the focused node first; return true to stop bubbling. */
	onKeyDown?: (e: KeyEventInfo) => boolean | void;
}

export interface BoxProps extends Handlers {
	dir?: "row" | "column";
	gap?: Reactive<number>;
	pad?: Reactive<number>;
	width?: Reactive<number>;
	height?: Reactive<number>;
	grow?: Reactive<number>;
	justify?: "start" | "center" | "end" | "between";
	align?: "start" | "center" | "end" | "stretch";
	bg?: Reactive<string | number>;
	radius?: Reactive<number>;
	border?: Reactive<number>;
	borderColor?: Reactive<string | number>;
	/** "scroll" clips children and offsets them by scroll on the main axis. */
	overflow?: "visible" | "scroll";
	scroll?: Reactive<number>;
	/** Focusable nodes receive clicks-to-focus and focused key routing. */
	focusable?: boolean;
	/**
	 * Pressing and dragging this node moves the host window (frameless
	 * windows). A press without movement still delivers onClick.
	 */
	windowDrag?: boolean;
}

export interface TextProps {
	size?: Reactive<number>;
	color?: Reactive<string | number>;
}

export interface AnchorRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AnchorProps {
	width?: Reactive<number>;
	height?: Reactive<number>;
	grow?: Reactive<number>;
	/** Called with the anchor's absolute rect whenever layout moves it. */
	onFrame: (rect: AnchorRect) => void;
}

export interface UiContext {
	tree: UiTree;
	handlers: Map<number, Handlers>;
	anchors: Map<number, (rect: AnchorRect) => void>;
	keyHandlers: Set<(e: KeyEventInfo) => void>;
	parentStack: number[];
	/** Native window hosting this tree; 0 when headless (tests). */
	windowId: number;
	/** Reactive id of the focused node (0 = none). */
	focusedId: Accessor<number>;
	setFocused(id: number): void;
	/** Reactive id of the hovered node (0 = none) — set by the input driver. */
	hoveredId: Accessor<number>;
	setHovered(id: number): void;
}

export function createUiContext(tree = new UiTree()): UiContext {
	const [focusedId, setFocusedId] = createSignal(0);
	const [hoveredId, setHoveredId] = createSignal(0);
	return {
		tree,
		handlers: new Map(),
		anchors: new Map(),
		keyHandlers: new Set(),
		parentStack: [tree.root],
		windowId: 0,
		focusedId,
		setFocused: (id: number) => setFocusedId(id),
		hoveredId,
		setHovered: (id: number) => setHoveredId(id),
	};
}

let current: UiContext | null = null;

export function withUiContext<T>(ctx: UiContext, fn: () => T): T {
	const prev = current;
	current = ctx;
	try {
		return fn();
	} finally {
		current = prev;
	}
}

function requireCtx(): UiContext {
	if (!current) {
		throw new Error(
			"No active UI context: build nodes inside createUIWindow(...) or withUiContext(...)",
		);
	}
	return current;
}

/** The active build context — for element libraries layered on the core. */
export function getUiContext(): UiContext {
	return requireCtx();
}

/** Unwrap a Reactive<T> — marked thunk or plain value. */
export function read<T>(value: Reactive<T>): T {
	if (isReactive(value)) return (value as () => T)();
	if (typeof value === "function") bareFunctionError();
	return value as T;
}

/** Run `fn` with `parent` as the attachment point for created nodes. */
function withParent<T>(ctx: UiContext, parent: number, fn: () => T): T {
	ctx.parentStack.push(parent);
	try {
		return fn();
	} finally {
		ctx.parentStack.pop();
	}
}

const JUSTIFY: Record<string, Justify> = {
	start: Justify.Start,
	center: Justify.Center,
	end: Justify.End,
	between: Justify.SpaceBetween,
};

const ALIGN: Record<string, Align> = {
	start: Align.Start,
	center: Align.Center,
	end: Align.End,
	stretch: Align.Stretch,
};

function applyNumber(
	ctx: UiContext,
	id: number,
	prop: Prop,
	value: Reactive<number> | undefined,
): void {
	if (value === undefined) return;
	if (isReactive(value)) {
		createEffect(() => ctx.tree.setProp(id, prop, value()));
	} else if (typeof value === "function") {
		bareFunctionError();
	} else {
		ctx.tree.setProp(id, prop, value);
	}
}

function applyColor(
	ctx: UiContext,
	id: number,
	prop: Prop,
	value: Reactive<string | number> | undefined,
): void {
	if (value === undefined) return;
	if (isReactive(value)) {
		createEffect(() => ctx.tree.setProp(id, prop, parseColor(value())));
	} else if (typeof value === "function") {
		bareFunctionError();
	} else {
		ctx.tree.setProp(id, prop, parseColor(value));
	}
}

function attachToParent(ctx: UiContext, id: number): void {
	const parent = ctx.parentStack[ctx.parentStack.length - 1]!;
	ctx.tree.append(parent, id);
}

const HANDLER_KEYS = [
	"onClick",
	"onPointerDown",
	"onPointerUp",
	"onPointerEnter",
	"onPointerLeave",
	"onKeyDown",
] as const;

function registerHandlers(ctx: UiContext, id: number, props: Handlers): void {
	if (!HANDLER_KEYS.some((key) => props[key])) return;
	ctx.tree.setProp(id, Prop.Hittable, 1);
	// Handlers is a structural subset of the props object; the map is only
	// ever read by handler key.
	ctx.handlers.set(id, props);
	onCleanup(() => ctx.handlers.delete(id));
}

function box(props: BoxProps, children?: () => void): number {
	const ctx = requireCtx();
	const id = ctx.tree.createNode(NodeKind.Box);
	if (props.dir === "column") ctx.tree.setProp(id, Prop.Dir, 1);
	if (props.justify) ctx.tree.setProp(id, Prop.Justify, JUSTIFY[props.justify]!);
	if (props.align) ctx.tree.setProp(id, Prop.Align, ALIGN[props.align]!);
	applyNumber(ctx, id, Prop.Gap, props.gap);
	applyNumber(ctx, id, Prop.Pad, props.pad);
	applyNumber(ctx, id, Prop.Width, props.width);
	applyNumber(ctx, id, Prop.Height, props.height);
	applyNumber(ctx, id, Prop.Grow, props.grow);
	applyNumber(ctx, id, Prop.Radius, props.radius);
	applyNumber(ctx, id, Prop.BorderWidth, props.border);
	applyColor(ctx, id, Prop.Bg, props.bg);
	applyColor(ctx, id, Prop.BorderColor, props.borderColor);
	if (props.overflow === "scroll") ctx.tree.setProp(id, Prop.Overflow, 1);
	applyNumber(ctx, id, Prop.Scroll, props.scroll);
	if (props.windowDrag) {
		ctx.tree.setProp(id, Prop.WindowDrag, 1);
		ctx.tree.setProp(id, Prop.Hittable, 1);
	}
	if (props.focusable) {
		ctx.tree.setProp(id, Prop.Focusable, 1);
		ctx.tree.setProp(id, Prop.Hittable, 1);
		// Focus lifecycle belongs with the focusable flag: never leave a
		// destroyed node focused.
		onCleanup(() => {
			if (untrack(ctx.focusedId) === id) ctx.setFocused(0);
		});
	}
	registerHandlers(ctx, id, props);
	attachToParent(ctx, id);
	if (children) withParent(ctx, id, children);
	return id;
}

function row(props: BoxProps = {}, children?: () => void): number {
	return box({ ...props, dir: "row" }, children);
}

function column(props: BoxProps = {}, children?: () => void): number {
	return box({ ...props, dir: "column" }, children);
}

function text(
	content: Reactive<string | number>,
	props: TextProps = {},
): number {
	const ctx = requireCtx();
	const id = ctx.tree.createTextNode("");
	if (isReactive(content)) {
		createEffect(() => ctx.tree.setText(id, String(content())));
	} else if (typeof content === "function") {
		bareFunctionError();
	} else {
		ctx.tree.setText(id, String(content));
	}
	applyNumber(ctx, id, Prop.FontSize, props.size);
	applyColor(ctx, id, Prop.TextColor, props.color);
	attachToParent(ctx, id);
	return id;
}

/** Fixed or growing empty space along the parent's main axis. */
function spacer(grow: Reactive<number> = 1): number {
	return box({ grow });
}

/**
 * Anchor for a native layer (webview, wgpu view): occupies layout space and
 * reports its rect so nativeWrapper can composite the real surface over it.
 */
function anchor(props: AnchorProps): number {
	const ctx = requireCtx();
	const id = ctx.tree.createNode(NodeKind.Anchor);
	applyNumber(ctx, id, Prop.Width, props.width);
	applyNumber(ctx, id, Prop.Height, props.height);
	applyNumber(ctx, id, Prop.Grow, props.grow);
	ctx.anchors.set(id, props.onFrame);
	onCleanup(() => ctx.anchors.delete(id));
	attachToParent(ctx, id);
	return id;
}

/**
 * Reactive region: the builder re-runs (and the subtree rebuilds) whenever a
 * signal it reads changes. Prop-level updates elsewhere stay fine-grained;
 * this is the coarse escape hatch for lists and conditionals.
 */
function dynamic(props: BoxProps, builder: () => void): number {
	const ctx = requireCtx();
	const id = box(props);
	createEffect(() => {
		ctx.tree.destroyChildren(id);
		withParent(ctx, id, () => withUiContext(ctx, builder));
	});
	return id;
}

/** Register a window-level key handler (removed on owner disposal). */
export function onKey(handler: (e: KeyEventInfo) => void): void {
	const ctx = requireCtx();
	ctx.keyHandlers.add(handler);
	onCleanup(() => ctx.keyHandlers.delete(handler));
}

interface EachEntry {
	owner: Owner;
	node: number;
	setIndex: (i: number) => void;
}

/**
 * Keyed list region: items are diffed by key, so unchanged rows keep their
 * subtree (and per-row state) across filters and reorders. Each row renders
 * inside its own container box; `render` receives the item and a reactive
 * index accessor.
 */
function each<T>(
	props: BoxProps,
	items: Accessor<readonly T[]>,
	key: (item: T, index: number) => string | number,
	render: (item: T, index: Accessor<number>) => void,
): number {
	const ctx = requireCtx();
	const regionId = box(props);
	const hostOwner = getOwner();
	if (!hostOwner) {
		throw new Error("ui.each must be created inside a reactive root");
	}
	// Row owners parent under hostOwner (not the diff effect), so rows
	// survive re-runs and are torn down with the region's scope.
	const entries = new Map<string | number, EachEntry>();

	createEffect(() => {
		const list = items();
		const seen = new Set<string | number>();
		let prevNode = 0;

		for (let i = 0; i < list.length; i++) {
			const item = list[i]!;
			const k = key(item, i);
			if (seen.has(k)) {
				throw new Error(`ui.each: duplicate key "${String(k)}"`);
			}
			seen.add(k);

			let entry = entries.get(k);
			if (!entry) {
				const owner = new Owner(hostOwner);
				const [index, setIndex] = createSignal(i);
				// runWithOwner nulls the current effect, so the diff effect
				// never tracks reads made while building a row.
				const node = runWithOwner(owner, () =>
					withUiContext(ctx, () =>
						withParent(ctx, regionId, () => box({}, () => render(item, index))),
					),
				);
				entry = { owner, node, setIndex };
				entries.set(k, entry);
			} else {
				entry.setIndex(i);
			}

			// Keep sibling order in sync with item order.
			const anchorNode = prevNode === 0
				? ctx.tree.firstChildOf(regionId)
				: ctx.tree.nextSiblingOf(prevNode);
			if (anchorNode !== entry.node) {
				ctx.tree.insertBefore(regionId, entry.node, anchorNode);
			}
			prevNode = entry.node;
		}

		// Remove rows whose keys are gone.
		for (const [k, entry] of entries) {
			if (!seen.has(k)) {
				entry.owner.dispose();
				if (ctx.tree.has(entry.node)) ctx.tree.destroy(entry.node);
				entries.delete(k);
			}
		}
	});

	return regionId;
}

export const ui = {
	box,
	row,
	column,
	text,
	spacer,
	anchor,
	dynamic,
	each,
};
