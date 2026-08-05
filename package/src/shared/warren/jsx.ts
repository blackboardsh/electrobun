// Warren JSX core — renderer-agnostic.
//
// Everything a renderer target shares: lazy elements, child mounting,
// component invocation, and the control-flow components (Show / For /
// Switch / Match) with their live-vs-frozen-snapshot semantics. A renderer
// (GPU retained tree, browser DOM) supplies five primitives and gets the
// whole component model:
//
//   text(value)              create a text leaf at the insertion point
//   dynamic(build)           reactive region: build re-runs on change
//   each(items, key, render) keyed list region with row reconciliation
//   intrinsic(type, props)   create one intrinsic element (tag vocabulary
//                            is renderer-owned; children arrive in props)
//   escape(fn)               a bare function child — renderer escape hatch
//
// Each package binds a renderer once via createJsxRuntime() and re-exports
// the result as its jsx-runtime module; JSX.IntrinsicElements typing stays
// per-package (types only, Solid-style — the runtime never enumerates tags).

import { isLive, memo, type Accessor, type LiveBinding } from "./reactive";

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

export function element(create: () => void): UIElement {
	return { __electrobunElement: true, create };
}

export interface WarrenRenderer {
	text(value: string | number | LiveBinding<string | number>): void;
	dynamic(build: () => void): void;
	each<T>(
		items: () => readonly T[],
		key: (item: T, index: number) => string | number,
		render: (item: T, index: Accessor<number>) => void,
	): void;
	intrinsic(type: string, props: Record<string, unknown>): void;
	escape(fn: () => unknown): void;
}

// --- Match markers (structural brand: survives mixed module realms) -------

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

// --- Control-flow prop shapes ---------------------------------------------

export interface ShowProps {
	when: unknown;
	fallback?: UIChild;
	children?: UIChild;
}

export interface ForProps<T> {
	each: readonly T[] | LiveBinding<readonly T[]>;
	/** Row identity for reconciliation; defaults to item identity. */
	key?: (item: T, index: number) => string | number;
	fallback?: UIChild;
	children?: (item: T, index: Accessor<number>) => UIChild;
}

export interface SwitchProps {
	fallback?: UIChild;
	children?: unknown;
}

type ComponentFn = (props: Record<string, unknown>) => UIElement | UIChild;

export interface WarrenJsxRuntime {
	jsx(
		type: string | ComponentFn,
		props: Record<string, unknown> | null,
		key?: unknown,
	): UIElement;
	jsxs(
		type: string | ComponentFn,
		props: Record<string, unknown> | null,
		key?: unknown,
	): UIElement;
	Fragment(props: { children?: UIChild }): UIElement;
	mountChild(child: UIChild): void;
	Show(props: ShowProps): UIElement;
	For<T>(props: ForProps<T>): UIElement;
	Switch(props: SwitchProps): UIElement;
	Match: typeof Match;
}

export function createJsxRuntime(renderer: WarrenRenderer): WarrenJsxRuntime {
	function mountChild(child: UIChild): void {
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
			renderer.text(child as LiveBinding<string | number>);
			return;
		}
		if (typeof child === "function") {
			renderer.escape(child as () => unknown);
			return;
		}
		renderer.text(String(child));
	}

	function jsx(
		type: string | ComponentFn,
		props: Record<string, unknown> | null,
		key?: unknown,
	): UIElement {
		let resolved = props ?? {};
		if (typeof type === "function") {
			// The automatic JSX transform lifts `key` out of props into the
			// third argument; components (For) receive it back as a prop.
			if (key !== undefined && resolved["key"] === undefined) {
				resolved = { ...resolved, key };
			}
			const result = type(resolved);
			if (isUIElement(result)) return result;
			// Match markers pass through raw so Switch can collect them.
			if (isMatch(result)) return result as unknown as UIElement;
			// Components may return any child shape (fragment arrays, strings...).
			return element(() => mountChild(result as UIChild));
		}
		return element(() => renderer.intrinsic(type, resolved));
	}

	function Fragment(props: { children?: UIChild }): UIElement {
		return element(() => mountChild(props.children));
	}

	// --- Control flow: a live() prop reconciles on change; a plain value is
	// a snapshot that renders once and never updates. ------------------------

	function Show(props: ShowProps): UIElement {
		const { when } = props;
		if (isLive(when)) {
			when.claimed = true;
			return element(() => {
				renderer.dynamic(() => {
					mountChild(when.fn() ? props.children : props.fallback);
				});
			});
		}
		return element(() => mountChild(when ? props.children : props.fallback));
	}

	function For<T>(props: ForProps<T>): UIElement {
		const render = props.children;
		if (typeof render !== "function") {
			throw new Error(
				"Warren: <For> takes a function child: (item, index) => ...",
			);
		}
		const keyOf =
			props.key ?? ((item: T) => item as unknown as string | number);
		const { each } = props;
		if (isLive(each)) {
			each.claimed = true;
			const items = () => (each.fn() ?? []) as readonly T[];
			return element(() => {
				// The region depends only on emptiness (equality-cut memo), so
				// list changes reconcile rows in the keyed each instead of
				// rebuilding the whole region; only empty<->non-empty flips it.
				const empty = memo(() => items().length === 0);
				renderer.dynamic(() => {
					if (empty()) {
						mountChild(props.fallback);
						return;
					}
					renderer.each(items, keyOf, (item, index) => {
						mountChild(render(item, index));
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

	function Switch(props: SwitchProps): UIElement {
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
				renderer.dynamic(() => {
					mountChild(pick());
				});
			});
		}
		return element(() => mountChild(pick()));
	}

	return { jsx, jsxs: jsx, Fragment, mountChild, Show, For, Switch, Match };
}
