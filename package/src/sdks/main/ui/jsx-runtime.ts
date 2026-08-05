// JSX runtime for Electrobun UI — no compiler beyond the TypeScript/Bun
// transpiler that Cottontail already ships. Point tsconfig at it:
//
//   { "jsx": "react-jsx", "jsxImportSource": "electrobun/main/ui" }
//
// Semantics mirror the builder API exactly:
// - Elements are lazy values; mounting creates nodes parent-first.
// - Components are plain functions called once with their props (Solid-style,
//   no re-render); they return elements.
// - Reactivity stays explicit: `bg={_(() => ...)}` is reactive, `bg={value}`
//   is static, and a bare function child `{() => ui.anything(...)}` is a
//   builder escape that runs against the current parent — so the whole
//   builder API (each, dynamic, textInput, webview, wgpuSurface) is usable
//   inside JSX unchanged.

import { isReactive, type ReactiveThunk } from "./reactive";
import {
	ui,
	type BoxProps,
	type Reactive,
	type TextProps,
} from "./ui";

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
	| ReactiveThunk<string | number>
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
	if (isReactive(child)) {
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
					"<text> takes a single child (string, number, or _(() => ...)); compose the string inside one expression.",
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
			children?: string | number | ReactiveThunk<string | number>;
		};
		spacer: { grow?: Reactive<number> };
	}
}
