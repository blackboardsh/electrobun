// JSX runtime for Electrobun UI — no compiler beyond the TypeScript/Bun
// transpiler that Cottontail already ships. Point tsconfig at it:
//
//   { "jsx": "react-jsx", "jsxImportSource": "electrobun/main/ui" }
//
// Semantics mirror the builder API exactly:
// - Elements are lazy values; mounting creates nodes parent-first.
// - Components are plain functions called once with their props (Solid-style,
//   no re-render); they return elements.
// - Reactivity stays explicit: `bg={live(() => ...)}` is reactive, `bg={value}`
//   is static, and a bare function child `{() => ui.anything(...)}` is a
//   builder escape that runs against the current parent — so the whole
//   builder API (each, dynamic, textInput, webview, wgpuSurface) is usable
//   inside JSX unchanged.

import { isLive, type LiveBinding, type Reactive } from "./reactive";
import { ui, type BoxProps, type TextProps } from "./ui";

export interface UIElement {
	readonly __electrobunElement: true;
	/** Create this element's nodes under the current build parent. */
	create(): void;
}

export function isUIElement(value: unknown): value is UIElement {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as any).__electrobunElement === true
	);
}

export type UIChild =
	| UIElement
	| string
	| number
	| boolean
	| null
	| undefined
	| LiveBinding<string | number>
	| (() => void)
	| UIChild[];

function element(create: () => void): UIElement {
	return { __electrobunElement: true, create };
}

export function mountChild(child: UIChild): void {
	if (child == null || typeof child === "boolean") return;
	if (Array.isArray(child)) {
		for (const c of child) mountChild(c);
		return;
	}
	if (isUIElement(child)) {
		child.create();
		return;
	}
	if (isLive(child)) {
		ui.text(child as Reactive<string | number>);
		return;
	}
	if (typeof child === "function") {
		// Builder escape: run builder-API code against the current parent.
		(child as () => void)();
		return;
	}
	ui.text(String(child));
}

type IntrinsicName = "box" | "row" | "column" | "text" | "spacer";

function createIntrinsic(type: IntrinsicName, props: Record<string, unknown>): void {
	const { children, ...rest } = props;
	switch (type) {
		case "box":
		case "row":
		case "column": {
			ui[type](
				rest as BoxProps,
				children === undefined ? undefined : () => mountChild(children as UIChild),
			);
			return;
		}
		case "text": {
			if (Array.isArray(children)) {
				throw new Error(
					"<text> takes a single child (string, number, or live(() => ...)); compose the string inside one expression.",
				);
			}
			ui.text(
				(children ?? "") as Reactive<string | number>,
				rest as TextProps,
			);
			return;
		}
		case "spacer": {
			ui.spacer((rest as { grow?: Reactive<number> }).grow ?? 1);
			return;
		}
	}
}

type ComponentFn = (props: Record<string, unknown>) => UIElement | UIChild;

export function jsx(
	type: IntrinsicName | ComponentFn,
	props: Record<string, unknown> | null,
	_key?: unknown,
): UIElement {
	const resolved = props ?? {};
	if (typeof type === "function") {
		const result = type(resolved);
		if (isUIElement(result)) return result;
		// Match markers pass through raw so Switch can collect them.
		if (isMatch(result)) return result as unknown as UIElement;
		// Components may return any child shape (fragment arrays, strings...).
		return element(() => mountChild(result as UIChild));
	}
	return element(() => createIntrinsic(type, resolved));
}

export const jsxs = jsx;

export function Fragment(props: { children?: UIChild }): UIElement {
	return element(() => mountChild(props.children));
}

// ---------------------------------------------------------------------------
// Control flow — explicit in both directions: a live() prop reconciles on
// change; a plain value is a snapshot that renders once and never updates.
// ---------------------------------------------------------------------------

import type { Accessor } from "./reactive";

export interface ShowProps {
	when: unknown;
	fallback?: UIChild;
	children?: UIChild;
}

export function Show(props: ShowProps): UIElement {
	const { when } = props;
	if (isLive(when)) {
		when.claimed = true;
		return element(() => {
			ui.dynamic({}, () => {
				mountChild(when.fn() ? props.children : props.fallback);
			});
		});
	}
	// Snapshot: evaluated at mount, frozen.
	return element(() => mountChild(when ? props.children : props.fallback));
}

export interface ForProps<T> {
	each: readonly T[] | LiveBinding<readonly T[]>;
	/** Row identity for reconciliation; defaults to item identity. */
	key?: (item: T, index: number) => string | number;
	fallback?: UIChild;
	children?: (item: T, index: Accessor<number>) => UIChild;
}

export function For<T>(props: ForProps<T>): UIElement {
	const render = props.children;
	if (typeof render !== "function") {
		throw new Error("Warren: <For> takes a function child: (item, index) => ...");
	}
	const keyOf =
		props.key ?? ((item: T) => item as unknown as string | number);
	const { each } = props;
	if (isLive(each)) {
		each.claimed = true;
		const items = () => (each.fn() ?? []) as readonly T[];
		return element(() => {
			// Fallback flips in a region; rows reconcile in a keyed each.
			ui.dynamic({}, () => {
				if (items().length === 0) {
					mountChild(props.fallback);
					return;
				}
				ui.each({}, items, keyOf as any, (item, index) => {
					mountChild(render(item as T, index));
				});
			});
		});
	}
	// Snapshot: rendered once, no reconciliation.
	const list = (each ?? []) as readonly T[];
	return element(() => {
		if (list.length === 0) {
			mountChild(props.fallback);
			return;
		}
		list.forEach((item, i) => mountChild(render(item, () => i)));
	});
}

const MATCH_BRAND = "__warrenMatch";

export interface MatchProps {
	when: unknown;
	children?: UIChild;
}

interface MatchMarker {
	[MATCH_BRAND]: true;
	when: unknown;
	children?: UIChild;
}

export function Match(props: MatchProps): MatchMarker {
	return { [MATCH_BRAND]: true, when: props.when, children: props.children };
}

function isMatch(value: unknown): value is MatchMarker {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as any)[MATCH_BRAND] === true
	);
}

export interface SwitchProps {
	fallback?: UIChild;
	children?: unknown;
}

export function Switch(props: SwitchProps): UIElement {
	const kids = Array.isArray(props.children)
		? props.children
		: [props.children];
	const matches = kids.filter(isMatch);
	const anyLive = matches.some((m) => isLive(m.when));
	for (const m of matches) {
		if (isLive(m.when)) (m.when as LiveBinding<unknown>).claimed = true;
	}
	const pick = (): UIChild | undefined => {
		for (const m of matches) {
			const truthy = isLive(m.when)
				? (m.when as LiveBinding<unknown>).fn()
				: m.when;
			if (truthy) return m.children;
		}
		return props.fallback;
	};
	if (anyLive) {
		return element(() => {
			ui.dynamic({}, () => {
				mountChild(pick());
			});
		});
	}
	return element(() => mountChild(pick()));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WithChildren<P> = P & { children?: UIChild };

export declare namespace JSX {
	type Element = UIElement;
	interface ElementChildrenAttribute {
		children: {};
	}
	interface IntrinsicElements {
		box: WithChildren<BoxProps>;
		row: WithChildren<BoxProps>;
		column: WithChildren<BoxProps>;
		text: TextProps & {
			children?: string | number | LiveBinding<string | number>;
		};
		spacer: { grow?: Reactive<number> };
	}
}
