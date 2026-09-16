// JSX runtime for Warren's DOM renderer. Point tsconfig at it:
//
//   { "jsx": "react-jsx", "jsxImportSource": "electrobun/browser/ui" }
//
// (Type-checking configuration only — Cottontail/Bun transpile .tsx natively.)
//
// Any HTML/SVG tag works: the runtime never enumerates elements, it calls
// document.createElement(tag). The IntrinsicElements typing below is
// deliberately open (Solid-style, types only).

import type { Reactive } from "../../shared/warren/reactive";
import type { UIChild, UIElement } from "../../shared/warren/jsx";
import { Fragment, jsx, jsxs } from "./dom";

export { Fragment, jsx, jsxs };
export type { UIChild, UIElement };

export interface DomProps {
	children?: UIChild;
	class?: Reactive<string>;
	className?: Reactive<string>;
	classList?: Reactive<Record<string, boolean | undefined>>;
	style?: Reactive<string | Record<string, string | number | undefined>>;
	id?: Reactive<string>;
	ref?: (el: any) => void;
	onClick?: (e: any) => void;
	onInput?: (e: any) => void;
	onChange?: (e: any) => void;
	onKeyDown?: (e: any) => void;
	onKeyUp?: (e: any) => void;
	onPointerDown?: (e: any) => void;
	onPointerUp?: (e: any) => void;
	onPointerMove?: (e: any) => void;
	onMouseDown?: (e: any) => void;
	onMouseUp?: (e: any) => void;
	onMouseEnter?: (e: any) => void;
	onMouseLeave?: (e: any) => void;
	onFocus?: (e: any) => void;
	onBlur?: (e: any) => void;
	onScroll?: (e: any) => void;
	onWheel?: (e: any) => void;
	onSubmit?: (e: any) => void;
	onDblClick?: (e: any) => void;
	onContextMenu?: (e: any) => void;
	[key: string]: unknown;
}

export declare namespace JSX {
	type Element = UIElement;
	interface ElementChildrenAttribute {
		children: {};
	}
	interface IntrinsicElements {
		[tag: string]: DomProps;
	}
}
