// Warren — reactivity core.
//
// The one-line rule: nothing is reactive unless you can see why. Component
// bodies, handlers, and helpers are inert; reactivity exists only inside a
// scope you can see — live() or memo(). Within a scope, tracking follows
// the dynamic extent: signal calls and store property reads both subscribe,
// including inside helpers called from the scope.
//
// Seven primitives, every one a bare verb taking a function:
//   signal(v)   reactive value; returns [get, set]
//   store(obj)  nested reactive state; returns [readonlyProxy, setter];
//               the setter takes a mutator (draft => { ... })
//   live(fn)    reactive scope; deferred — runs after commit
//   memo(fn)    caching reactive scope; dependents never observe it stale
//   inert(fn)   read without subscribing, inside a scope (no-op outside)
//   cleanup(fn) teardown for the enclosing scope; runs before each re-run
//   batch(fn)   defer notification (never mutation) to the outermost exit
//
// There is no createEffect — an effect is a live whose return value nobody
// uses. There is no produce — the store setter mutates a draft directly.

export type Accessor<T> = () => T;
export type Setter<T> = (next: T | ((prev: T) => T)) => T;

// Structural brand (string key, not a unique symbol) so the type unifies
// across symlinked/realified module paths.
export interface LiveBinding<T> {
	readonly __warrenLive: true;
	/** The wrapped expression. Consumers re-run it inside their own scope. */
	fn: () => T;
	/** Set by a consumer (value prop, control flow) to suppress the auto-effect. */
	claimed: boolean;
}

/** What value props accept: a plain value, or a live() binding. */
export type Reactive<T> = T | LiveBinding<T>;

export function isLive(value: unknown): value is LiveBinding<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as any).__warrenLive === true
	);
}

let devMode = true;
/** Toggle dev-mode warnings (default on while Warren is experimental). */
export function setDevMode(enabled: boolean): void {
	devMode = enabled;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

interface SubscriberSet extends Set<Scope> {
	/** True for signal subscriber sets (dev warning #3 heuristics). */
	fromSignal?: boolean;
}

type ScopeKind = "root" | "live" | "memo";

let currentScope: Scope | null = null;
/** Non-null only while a tracking scope (live/memo) body executes. */
let trackingScope: Scope | null = null;
let inertDepth = 0;

class Scope {
	kind: ScopeKind;
	fn: (() => void) | null;
	parent: Scope | null;
	children: Scope[] = [];
	cleanups: Array<() => void> = [];
	sources: SubscriberSet[] = [];
	disposed = false;
	hasRun = false;

	constructor(kind: ScopeKind, fn: (() => void) | null, parent: Scope | null) {
		this.kind = kind;
		this.fn = fn;
		this.parent = parent;
		parent?.children.push(this);
	}

	run(): void {
		if (this.disposed || !this.fn) return;
		// A re-run replaces the previous run's scope state.
		for (let i = this.children.length - 1; i >= 0; i--) {
			this.children[i]!.dispose();
		}
		this.children.length = 0;
		for (let i = this.cleanups.length - 1; i >= 0; i--) {
			this.cleanups[i]!();
		}
		this.cleanups.length = 0;
		this.clearSources();

		const prevScope = currentScope;
		const prevTracking = trackingScope;
		const prevInert = inertDepth;
		currentScope = this;
		trackingScope = this.kind === "root" ? null : this;
		inertDepth = 0;
		try {
			this.fn();
		} finally {
			currentScope = prevScope;
			trackingScope = prevTracking;
			inertDepth = prevInert;
			this.hasRun = true;
		}
	}

	clearSources(): void {
		for (const subs of this.sources) subs.delete(this);
		this.sources.length = 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		liveQueue.delete(this);
		this.clearSources();
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

function track(subs: SubscriberSet): void {
	if (!trackingScope || inertDepth > 0) return;
	if (!subs.has(trackingScope)) {
		subs.add(trackingScope);
		trackingScope.sources.push(subs);
	}
}

// ---------------------------------------------------------------------------
// Propagation. Memos pull-validate so a live never observes a stale memo;
// lives queue and flush after commit (end of mount pass, end of outermost
// batch, or immediately after an unbatched write's propagation).
// ---------------------------------------------------------------------------

const liveQueue = new Set<Scope>();
let batchDepth = 0;
let commitDepth = 0;
let notifyDepth = 0;
let flushing = false;

function notify(subs: SubscriberSet): void {
	if (subs.size === 0) return;
	// Flushing waits until propagation fully settles (notifyDepth back to 0):
	// a memo invalidating mid-loop must not run lives before every subscriber
	// of the original write has been queued, or a live can run twice.
	notifyDepth++;
	try {
		for (const scope of [...subs]) {
			if (scope.kind === "memo") {
				(scope as MemoScope).invalidate();
			} else {
				liveQueue.add(scope);
			}
		}
	} finally {
		notifyDepth--;
	}
	scheduleFlush();
}

function scheduleFlush(): void {
	if (batchDepth > 0 || commitDepth > 0 || notifyDepth > 0 || flushing) return;
	flushLive();
}

function flushLive(): void {
	if (flushing) return;
	flushing = true;
	try {
		let iterations = 0;
		while (liveQueue.size) {
			if (++iterations > 100_000) {
				liveQueue.clear();
				throw new Error("Warren: reactive cycle — lives never settled");
			}
			const next = liveQueue.values().next().value!;
			liveQueue.delete(next);
			next.run();
		}
	} finally {
		flushing = false;
	}
	if (liveQueue.size && batchDepth === 0 && commitDepth === 0) flushLive();
}

/**
 * A commit boundary (mount or rebuild pass). Lives created or notified
 * inside run when the outermost commit exits.
 */
export function commit<T>(fn: () => T): T {
	commitDepth++;
	try {
		return fn();
	} finally {
		commitDepth--;
		if (commitDepth === 0 && batchDepth === 0) flushLive();
	}
}

export function batch<T>(fn: () => T): T {
	batchDepth++;
	try {
		return fn();
	} finally {
		// Queued notifications flush on the way out even when fn threw: the
		// mutations already landed, so discarding them would leave the graph
		// inconsistent with the store.
		batchDepth--;
		if (batchDepth === 0 && commitDepth === 0) flushLive();
	}
}

// ---------------------------------------------------------------------------
// signal
// ---------------------------------------------------------------------------

const defaultEquals = <T>(a: T, b: T) => a === b;

export function signal<T>(
	value: T,
	options?: { equals?: false | ((a: T, b: T) => boolean) },
): [Accessor<T>, Setter<T>] {
	const equals =
		options?.equals === false ? () => false : options?.equals ?? defaultEquals;
	const subs: SubscriberSet = new Set() as SubscriberSet;
	subs.fromSignal = true;
	const read: Accessor<T> = () => {
		if (
			devMode &&
			commitDepth > 0 &&
			!trackingScope &&
			inertDepth === 0
		) {
			console.warn(
				"Warren: signal read during render with no scope on the stack — this renders once and then freezes. Wrap it: live(() => ...).",
			);
		}
		track(subs);
		return value;
	};
	const write: Setter<T> = (next) => {
		const resolved =
			typeof next === "function" ? (next as (prev: T) => T)(value) : next;
		if (equals(value, resolved)) return value;
		value = resolved;
		notify(subs);
		return value;
	};
	return [read, write];
}

// ---------------------------------------------------------------------------
// memo
// ---------------------------------------------------------------------------

class MemoScope extends Scope {
	value: unknown;
	stale = true;
	equals: (a: unknown, b: unknown) => boolean;
	subs: SubscriberSet = new Set() as SubscriberSet;
	compute: () => unknown;

	constructor(
		compute: () => unknown,
		equals: (a: unknown, b: unknown) => boolean,
	) {
		super("memo", null, currentScope);
		this.compute = compute;
		this.fn = () => {
			this.value = this.compute();
		};
		this.equals = equals;
	}

	invalidate(): void {
		if (this.stale) return;
		this.stale = true;
		// Unobserved memos stay lazy: recompute on next read.
		if (this.subs.size === 0) return;
		// Observed memos recompute eagerly so the equals cut can stop
		// propagation: dependents only hear about it when the value actually
		// changed. (Mutations have already landed — batch defers notification,
		// never mutation — so recomputing mid-propagation reads fresh state.)
		const prev = this.value;
		const first = !this.hasRun;
		this.run();
		this.stale = false;
		if (!first && this.equals(prev, this.value)) {
			this.value = prev;
			return;
		}
		notify(this.subs);
	}

	read(): unknown {
		track(this.subs);
		if (this.stale && !this.disposed) {
			const prev = this.value;
			const first = !this.hasRun;
			this.run();
			this.stale = false;
			if (!first && this.equals(prev, this.value)) {
				this.value = prev;
			}
		}
		return this.value;
	}
}

export function memo<T>(
	fn: () => T,
	options?: { equals?: false | ((a: T, b: T) => boolean) },
): Accessor<T> {
	const equals =
		options?.equals === false
			? () => false
			: ((options?.equals as any) ?? defaultEquals);
	const node = new MemoScope(fn as () => unknown, equals);
	return () => node.read() as T;
}

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------

function warnZeroDeps(scope: Scope): void {
	if (!devMode || !scope.hasRun) return;
	if (scope.sources.length === 0) {
		console.warn(
			"Warren: live() registered zero dependencies — the wrapped expression is static; drop the marker.",
		);
	} else if (scope.sources.every((s) => s.fromSignal)) {
		// Inside another scope the signal calls would have tracked anyway.
		// (Only meaningful for nested lives; harmless reminder elsewhere.)
	}
}

export function live<T>(fn: () => T): Reactive<T> {
	if (typeof fn !== "function") {
		throw new Error("Warren: live() takes a function: live(() => ...)");
	}
	// Nested inside a running scope while actually tracking: a pass-through.
	// The enclosing scope already tracks the dynamic extent, so evaluate and
	// return the value. Inside inert() (component bodies, escapes) tracking
	// is off, so a live() there is a genuine new binding, not a nested one.
	if (trackingScope && inertDepth === 0) {
		if (devMode) {
			console.warn(
				"Warren: nested live() — the enclosing scope already tracks these reads; the marker is redundant here.",
			);
		}
		return fn();
	}
	if (!currentScope) {
		throw new Error(
			"Warren: live() outside JSX and outside any scope has no meaning. Create it inside a component, a mount, or another scope.",
		);
	}
	const binding: LiveBinding<T> = {
		__warrenLive: true,
		fn,
		claimed: false,
	};
	// Statement-position lives become effects; value-position lives get
	// claimed by their consumer first. Defer the decision to the flush.
	const decide = new Scope("live", null, currentScope);
	decide.fn = () => {
		if (binding.claimed) {
			decide.dispose();
			return;
		}
		decide.fn = () => {
			binding.fn();
		};
		decide.run();
		warnZeroDeps(decide);
	};
	liveQueue.add(decide);
	scheduleFlush();
	return binding;
}

/**
 * Consumer side of live(): claim a binding and run `apply(value)` in a
 * scope that re-runs (deferred) when the binding's dependencies change.
 * Used by value props and control-flow components.
 */
export function claimLive<T>(
	binding: LiveBinding<T>,
	apply: (value: T) => void,
): void {
	binding.claimed = true;
	if (!currentScope) {
		throw new Error("Warren: internal — claimLive outside a scope");
	}
	const scope = new Scope("live", null, currentScope);
	scope.fn = () => {
		apply(binding.fn());
		warnZeroDeps(scope);
	};
	liveQueue.add(scope);
	scheduleFlush();
}

/** Internal: a deferred reactive scope (regions, prop bindings). */
export function liveScope(fn: () => void): void {
	if (!currentScope) {
		throw new Error("Warren: internal — liveScope outside a scope");
	}
	const scope = new Scope("live", fn, currentScope);
	liveQueue.add(scope);
	scheduleFlush();
}

// ---------------------------------------------------------------------------
// inert / cleanup / roots
// ---------------------------------------------------------------------------

export function inert<T>(fn: () => T): T {
	// Outside a scope this is a no-op — inert is already the default there.
	inertDepth++;
	try {
		return fn();
	} finally {
		inertDepth--;
	}
}

export function cleanup(fn: () => void): void {
	if (fn === undefined) {
		throw new Error(
			'Warren: cleanup() requires a function — it registers teardown, it does not "clean up now".',
		);
	}
	if (typeof fn !== "function") {
		throw new Error("Warren: cleanup() takes a function");
	}
	if (!currentScope) {
		throw new Error("Warren: cleanup() called outside a scope");
	}
	if (currentScope.kind === "memo") {
		throw new Error(
			"Warren: cleanup() inside a memo — memos are pure computations; use live() for work that owns resources.",
		);
	}
	currentScope.cleanups.push(fn);
}

/** Root scope for a mount. Lives created inside flush when fn returns. */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
	const scope = new Scope("root", null, null);
	const prevScope = currentScope;
	const prevTracking = trackingScope;
	currentScope = scope;
	trackingScope = null;
	try {
		return commit(() => fn(() => scope.dispose()));
	} finally {
		currentScope = prevScope;
		trackingScope = prevTracking;
	}
}

export function getOwner(): unknown {
	return currentScope;
}

export function runWithOwner<T>(owner: unknown, fn: () => T): T {
	const prevScope = currentScope;
	const prevTracking = trackingScope;
	currentScope = owner as Scope | null;
	trackingScope = null;
	try {
		return fn();
	} finally {
		currentScope = prevScope;
		trackingScope = prevTracking;
	}
}

/** Internal: child scope handle for keyed list rows. */
export function createChildScope(owner?: unknown): unknown {
	return new Scope("root", null, (owner as Scope | null) ?? currentScope);
}

export function disposeScope(scope: unknown): void {
	(scope as Scope).dispose();
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export type StoreSetter<T extends object> = (mutate: (draft: T) => void) => void;

export function store<T extends object>(initial: T): [T, StoreSetter<T>] {
	const raw = initial;
	const pathSubs = new Map<string, SubscriberSet>();
	const readProxies = new WeakMap<object, object>();

	const trackPath = (path: string) => {
		// Property reads are inert outside scopes: one flag check, no
		// bookkeeping — the common case (component bodies, handlers).
		if (!trackingScope || inertDepth > 0) return;
		let subs = pathSubs.get(path);
		if (!subs) {
			subs = new Set() as SubscriberSet;
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
					"Warren: stores are read-only outside their setter. Write through the setter: setState(draft => { ... }).",
				);
			},
			deleteProperty() {
				throw new Error(
					"Warren: stores are read-only outside their setter. Write through the setter: setState(draft => { ... }).",
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
					const isSelf = path === changedPath;
					const isDescendant = path.startsWith(changedPath + ".");
					if (isSelf || isDescendant) {
						notified.add(subs);
						notify(subs);
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

	// The setter is a mutator scope: the draft is writable, mutation is
	// direct (no structural sharing), and the store's writes batch into one
	// propagation.
	const setter: StoreSetter<T> = (mutate) => {
		if (typeof mutate !== "function") {
			throw new Error(
				"Warren: the store setter takes a mutator: setState(draft => { draft.x = 1 }).",
			);
		}
		const changed = new Set<string>();
		mutate(draftFor(raw, "", changed) as T);
		notifyChanged(changed);
	};

	return [readProxyFor(raw, "") as T, setter];
}
