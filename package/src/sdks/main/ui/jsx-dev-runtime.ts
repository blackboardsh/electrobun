// Dev-transform entrypoint: same runtime, jsxDEV signature.
import { Fragment, jsx, type UIElement } from "./jsx-runtime";

export { Fragment };
export type { JSX, UIChild, UIElement } from "./jsx-runtime";

export function jsxDEV(
	type: Parameters<typeof jsx>[0],
	props: Parameters<typeof jsx>[1],
	key?: unknown,
	_isStaticChildren?: boolean,
	_source?: unknown,
	_self?: unknown,
): UIElement {
	return jsx(type, props, key);
}
