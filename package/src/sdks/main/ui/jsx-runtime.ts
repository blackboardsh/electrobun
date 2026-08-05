// JSX runtime for Warren's GPU renderer — no compiler beyond the
// TypeScript/Bun transpiler that Cottontail already ships. Point tsconfig
// at it:
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
//
// The component model itself (lazy elements, Show/For/Switch/Match) is the
// shared Warren JSX core; this module binds it to the retained-tree builder.

import type { LiveBinding, Reactive } from "./reactive";
import { ui, type BoxProps, type TextProps } from "./ui";
import {
	createJsxRuntime,
	isUIElement,
	Match,
	type ForProps,
	type MatchProps,
	type ShowProps,
	type SwitchProps,
	type UIChild,
	type UIElement,
	type WarrenRenderer,
} from "../../../shared/warren/jsx";

export { isUIElement, Match };
export type {
	ForProps,
	MatchProps,
	ShowProps,
	SwitchProps,
	UIChild,
	UIElement,
};

const INTRINSICS = new Set(["box", "row", "column", "text", "spacer"]);

const renderer: WarrenRenderer = {
	text(value) {
		ui.text(value as Reactive<string | number>);
	},
	dynamic(build) {
		ui.dynamic({}, build);
	},
	each(items, key, render) {
		ui.each({}, items, key, render);
	},
	intrinsic(type, props) {
		if (!INTRINSICS.has(type)) {
			throw new Error(
				`Warren: unknown element <${type}> — the GPU renderer provides box, row, column, text, and spacer.`,
			);
		}
		const { children, ...rest } = props;
		switch (type) {
			case "box":
			case "row":
			case "column": {
				ui[type](
					rest as BoxProps,
					children === undefined
						? undefined
						: () => mountChild(children as UIChild),
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
	},
	escape(fn) {
		// Builder escape: run builder-API code against the current parent.
		// Return values (node ids) are intentionally ignored.
		fn();
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
