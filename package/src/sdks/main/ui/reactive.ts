// Fine-grained reactivity for the Cottontail UI runtime, inspired by Solid:
// synchronous signals, auto-tracked effects, batched writes, and a store with
// produce()-style draft mutations. No compiler and no dependencies — small
// enough for Electrobun to own, close enough to Solid that the authoring
// model transfers directly.

export type Accessor<T> = () => T;
export type Setter<T> = (next: T | ((prev: T) => T)) => T;

// ---------------------------------------------------------------------------
// Reactive marker. Value props accept `T | ReactiveThunk<T>` — a plain value,
// or a thunk explicitly marked with $()/reactive(). Bare functions in value
// positions are an error, so every reactive boundary in a component is
// findable by searching for "$(".
// ---------------------------------------------------------------------------

export const REACTIVE_BRAND = Symbol.for("electrobun.ui.reactive");

export interface ReactiveThunk<T> {
	(): T;
	[REACTIVE_BRAND]: true;
}

/** Mark a thunk as reactive: its reads are tracked and drive one effect. */
export function reactive<T>(fn: () => T): ReactiveThunk<T> {
	(fn as any)[REACTIVE_BRAND] = true;
	return fn as ReactiveThunk<T>;
}

/** Short alias for {@link reactive}: `bg: $(() => hover() ? a : b)`. */
export const $ = reactive;

export function isReactive(value: unknown): value is ReactiveThunk<unknown> {
	return (
		typeof value === "function" && (value as any)[REACTIVE_BRAND] === true
	);
}

type SubscriberSet = Set<Effect>;

let currentEffect: Effect | null = null;
let currentOwner: Owner | null = null;
let pendingEffects: Set<Effect> | null = null;
let batchDepth = 0;

export class Owner {
	parent: Owner | null;
	children: Owner[] = [];
	cleanups: Array<() => void> = [];
	disposed = false;

	constructor(parent: Owner | null = currentOwner) {
		this.parent = parent;
		parent?.children.push(this);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (let i = this.children.length - 1; i >= 0; i--) {
			this.children[i]!.dispose();
		}
		this.children.length = 0;
		for (let i = this.cleanups.length - 1; i >= 0; i--) {
			this.cleanups[i]!();
		}
		this.cleanups.length = 0;
		if (this.parent && !this.parent.disposed) {
			const idx = this.parent.children.indexOf(this);
			if (idx >= 0) this.parent.children.splice(idx, 1);
		}
	}
}

class Effect extends Owner {
	fn: () => void;
	sources: SubscriberSet[] = [];

	constructor(fn: () => void) {
		super();
		this.fn = fn;
	}

	run() {
		if (this.disposed) return;
		// A re-run replaces the previous run's scope: nested owners, cleanups,
		// and dependency edges all belong to a single execution.
		for (let i = this.children.length - 1; i >= 0; i--) {
			this.children[i]!.dispose();
		}
		this.children.length = 0;
		for (let i = this.cleanups.length - 1; i >= 0; i--) {
			this.cleanups[i]!();
		}
		this.cleanups.length = 0;
		this.clearSources();

		const prevEffect = currentEffect;
		const prevOwner = currentOwner;
		currentEffect = this;
		currentOwner = this;
		try {
			this.fn();
		} finally {
			currentEffect = prevEffect;
			currentOwner = prevOwner;
		}
	}

	clearSources() {
		for (const subs of this.sources) subs.delete(this);
		this.sources.length = 0;
	}

	dispose() {
		this.clearSources();
		super.dispose();
	}
}

function track(subs: SubscriberSet) {
	if (!currentEffect) return;
	if (!subs.has(currentEffect)) {
		subs.add(currentEffect);
		currentEffect.sources.push(subs);
	}
}

function scheduleEffects(subs: SubscriberSet) {
	if (subs.size === 0) return;
	const isRootFlush = pendingEffects === null && batchDepth === 0;
	const queue = (pendingEffects ??= new Set());
	for (const effect of subs) queue.add(effect);
	if (isRootFlush) flushEffects();
}

function flushEffects() {
	const queue = pendingEffects;
	if (!queue) return;
	let iterations = 0;
	while (queue.size) {
		if (++iterations > 100_000) {
			pendingEffects = null;
			throw new Error("Reactive cycle: effects never settled");
		}
		const next = queue.values().next().value!;
		queue.delete(next);
		next.run();
	}
	pendingEffects = null;
}

const defaultEquals = <T>(a: T, b: T) => a === b;

export function createSignal<T>(
	value: T,
	options?: { equals?: false | ((a: T, b: T) => boolean) },
): [Accessor<T>, Setter<T>] {
	const equals = options?.equals === false
		? () => false
		: options?.equals ?? defaultEquals;
	const subs: SubscriberSet = new Set();
	const read: Accessor<T> = () => {
		track(subs);
		return value;
	};
	const write: Setter<T> = (next) => {
		const resolved = typeof next === "function"
			? (next as (prev: T) => T)(value)
			: next;
		if (equals(value, resolved)) return value;
		value = resolved;
		scheduleEffects(subs);
		return value;
	};
	return [read, write];
}

export function createEffect(fn: () => void): void {
	const effect = new Effect(fn);
	effect.run();
}

export function createMemo<T>(
	fn: () => T,
	options?: { equals?: false | ((a: T, b: T) => boolean) },
): Accessor<T> {
	const [get, set] = createSignal<T>(undefined as T, options);
	createEffect(() => {
		const value = fn();
		set(() => value);
	});
	return get;
}

export function batch<T>(fn: () => T): T {
	batchDepth++;
	const owns = pendingEffects === null;
	pendingEffects ??= new Set();
	try {
		return fn();
	} finally {
		batchDepth--;
		if (batchDepth === 0 && owns) flushEffects();
	}
}

export function untrack<T>(fn: () => T): T {
	const prev = currentEffect;
	currentEffect = null;
	try {
		return fn();
	} finally {
		currentEffect = prev;
	}
}

export function onCleanup(fn: () => void): void {
	currentOwner?.cleanups.push(fn);
}

export function createRoot<T>(fn: (dispose: () => void) => T): T {
	const owner = new Owner(null);
	const prevOwner = currentOwner;
	const prevEffect = currentEffect;
	currentOwner = owner;
	currentEffect = null;
	try {
		return fn(() => owner.dispose());
	} finally {
		currentOwner = prevOwner;
		currentEffect = prevEffect;
	}
}

export function getOwner(): Owner | null {
	return currentOwner;
}

export function runWithOwner<T>(owner: Owner, fn: () => T): T {
	const prevOwner = currentOwner;
	const prevEffect = currentEffect;
	currentOwner = owner;
	currentEffect = null;
	try {
		return fn();
	} finally {
		currentOwner = prevOwner;
		currentEffect = prevEffect;
	}
}

// ---------------------------------------------------------------------------
// Store: nested reactive reads with path-level granularity, written to only
// through the setter — most ergonomically with produce(), which applies
// imperative mutations to a draft and notifies exactly the touched paths.
// ---------------------------------------------------------------------------

const PRODUCE = Symbol("produce");

type ProduceMarker<T> = { [PRODUCE]: (draft: T) => void };

export function produce<T extends object>(
	mutator: (draft: T) => void,
): ProduceMarker<T> {
	return { [PRODUCE]: mutator };
}

export type StoreSetter<T extends object> = (
	update: ProduceMarker<T> | Partial<T>,
) => void;

export function createStore<T extends object>(
	initial: T,
): [T, StoreSetter<T>] {
	const raw = initial;
	const pathSubs = new Map<string, SubscriberSet>();
	const readProxies = new WeakMap<object, object>();

	const trackPath = (path: string) => {
		if (!currentEffect) return;
		let subs = pathSubs.get(path);
		if (!subs) {
			subs = new Set();
			pathSubs.set(path, subs);
		}
		track(subs);
	};

	const childPath = (path: string, key: string) =>
		path ? `${path}.${key}` : key;

	const readProxyFor = (target: object, path: string): object => {
		const existing = readProxies.get(target);
		if (existing) return existing;
		const proxy = new Proxy(target, {
			get(t: any, key) {
				if (typeof key === "symbol") return t[key];
				const value = t[key];
				// Method lookups (array iteration helpers etc.) should not
				// register as reads of a "map"/"push" path.
				if (typeof value === "function" && !Object.hasOwn(t, key)) {
					return value;
				}
				const p = childPath(path, String(key));
				trackPath(p);
				if (value !== null && typeof value === "object") {
					return readProxyFor(value, p);
				}
				return value;
			},
			set() {
				throw new Error(
					"Store is read-only; write through the setter (see produce()).",
				);
			},
			deleteProperty() {
				throw new Error(
					"Store is read-only; write through the setter (see produce()).",
				);
			},
		});
		readProxies.set(target, proxy);
		return proxy;
	};

	const notifyChanged = (changed: Set<string>) => {
		if (changed.size === 0) return;
		batch(() => {
			const notified = new Set<SubscriberSet>();
			for (const changedPath of changed) {
				for (const [path, subs] of pathSubs) {
					if (notified.has(subs)) continue;
					// A write at a path invalidates readers of that exact path and
					// of anything beneath it (a replaced parent changes every
					// descendant value). Readers of ancestor paths only saw the
					// still-identical object reference, so they stay quiet —
					// matching Solid store semantics.
					const isSelf = path === changedPath;
					const isDescendant = path.startsWith(changedPath + ".");
					if (isSelf || isDescendant) {
						notified.add(subs);
						scheduleEffects(subs);
					}
				}
			}
		});
	};

	const draftFor = (
		target: object,
		path: string,
		changed: Set<string>,
	): object =>
		new Proxy(target, {
			get(t: any, key) {
				if (typeof key === "symbol") return t[key];
				const value = t[key];
				if (typeof value === "function" && !Object.hasOwn(t, key)) {
					// Bind array/object prototype methods (push, splice, ...) to the
					// draft so their internal writes are recorded.
					return value.bind(draftFor(t, path, changed));
				}
				if (value !== null && typeof value === "object") {
					return draftFor(value, childPath(path, String(key)), changed);
				}
				return value;
			},
			set(t: any, key, value) {
				const p = childPath(path, String(key));
				if (t[key] !== value) {
					// Index stores on arrays mutate `length` as a JS side effect;
					// record it so length readers (iteration) are invalidated.
					const prevLength = Array.isArray(t) ? t.length : -1;
					t[key] = value;
					changed.add(p);
					if (Array.isArray(t) && t.length !== prevLength) {
						changed.add(childPath(path, "length"));
					}
				}
				return true;
			},
			deleteProperty(t: any, key) {
				const p = childPath(path, String(key));
				if (key in t) {
					delete t[key];
					changed.add(p);
				}
				return true;
			},
		});

	const setStore: StoreSetter<T> = (update) => {
		const changed = new Set<string>();
		if (update && PRODUCE in (update as object)) {
			const mutator = (update as ProduceMarker<T>)[PRODUCE];
			mutator(draftFor(raw, "", changed) as T);
		} else {
			for (const [key, value] of Object.entries(update as Partial<T>)) {
				if ((raw as any)[key] !== value) {
					(raw as any)[key] = value;
					changed.add(key);
				}
			}
		}
		notifyChanged(changed);
	};

	return [readProxyFor(raw, "") as T, setStore];
}
