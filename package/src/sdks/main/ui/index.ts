// Public surface of the prototype UI runtime.

export {
	_,
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	createStore,
	isReactive,
	onCleanup,
	produce,
	reactive,
	untrack,
	type Accessor,
	type ReactiveThunk,
	type Setter,
} from "./reactive";
export { AUTO, NodeKind, Prop, UiTree } from "./tree";
export { Align, Justify, computeLayout } from "./layout";
export { FLOATS_PER_INSTANCE, paint, parseColor } from "./paint";
export { hitChain } from "./hit";
export { measureText } from "./font";
export {
	createUiContext,
	getUiContext,
	onKey,
	read,
	ui,
	withUiContext,
	type AnchorRect,
	type BoxProps,
	type KeyEventInfo,
	type PointerEventInfo,
	type Reactive,
	type TextProps,
	type UiContext,
} from "./ui";
export {
	webview,
	wgpuSurface,
	type WebviewElementProps,
	type WgpuSurfaceProps,
} from "./elements";
export { applyEditKey, charForKey, Key, Mod } from "./keymap";
export { textInput, type TextInputProps } from "./textInput";
export {
	createUIView,
	createUIWindow,
	type UIView,
	type UIWindow,
	type UIWindowOptions,
} from "./uiwindow";
export { registerUIRoot, type UIRootRegistration } from "./uiTagHost";
export {
	Fragment,
	isUIElement,
	jsx,
	jsxs,
	mountChild,
	type UIChild,
	type UIElement,
} from "./jsx-runtime";
