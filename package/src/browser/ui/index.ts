// Warren for the browser — the DOM renderer. Same reactivity core and JSX
// semantics as electrobun/main/ui, rendered into real DOM nodes inside a
// webview (or any web page).

export {
	batch,
	cleanup,
	createRoot,
	inert,
	isLive,
	live,
	memo,
	setDevMode,
	signal,
	store,
	type Accessor,
	type LiveBinding,
	type Reactive,
	type Setter,
	type StoreSetter,
} from "../../shared/warren/reactive";
export { isUIElement } from "../../shared/warren/jsx";
export type {
	ForProps,
	MatchProps,
	ShowProps,
	SwitchProps,
	UIChild,
	UIElement,
} from "../../shared/warren/jsx";
export {
	For,
	Fragment,
	Match,
	Portal,
	Show,
	Switch,
	currentParent,
	jsx,
	jsxs,
	mountChild,
	render,
} from "./dom";
export type { DomProps, JSX } from "./jsx-runtime";
