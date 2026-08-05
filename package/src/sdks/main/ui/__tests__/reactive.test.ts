// Warren reactivity — the spec's test checklist.

import { describe, expect, test } from "bun:test";
import {
	batch,
	cleanup,
	commit,
	createRoot,
	inert,
	isLive,
	live,
	memo,
	setDevMode,
	signal,
	store,
	type LiveBinding,
} from "../reactive";

function effect(fn: () => void): void {
	// An effect is a live whose return value nobody uses.
	live(fn);
}

function withWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (msg: unknown) => warnings.push(String(msg));
	try {
		return { result: fn(), warnings };
	} finally {
		console.warn = original;
	}
}

describe("tracking tiers", () => {
	test("signal call inside live subscribes; outside any scope it does not", () => {
		const [count, setCount] = signal(0);
		const seen: number[] = [];
		createRoot(() => {
			effect(() => seen.push(count()));
		});
		expect(seen).toEqual([0]);
		setCount(1);
		expect(seen).toEqual([0, 1]);

		const snapshot = count();
		expect(snapshot).toBe(1);
		setCount(2);
		expect(seen).toEqual([0, 1, 2]); // only the live re-ran; no phantom subs
	});

	test("property read inside live subscribes; component-body read does not", () => {
		const [state, setState] = store({ user: { name: "ada" } });
		const seen: string[] = [];
		let bodySnapshot = "";
		createRoot(() => {
			bodySnapshot = state.user.name; // inert: body is not a scope
			effect(() => seen.push(state.user.name)); // scope: tracks
		});
		expect(bodySnapshot).toBe("ada");
		expect(seen).toEqual(["ada"]);
		setState((s) => (s.user.name = "grace"));
		expect(seen).toEqual(["ada", "grace"]);
	});

	test("dynamic extent: helper property reads track inside live", () => {
		const [state, setState] = store({ user: { name: "ada", plan: "pro" } });
		const label = (u: { name: string; plan: string }) => `${u.name} · ${u.plan}`;
		const seen: string[] = [];
		createRoot(() => {
			effect(() => seen.push(label(state.user)));
		});
		expect(seen).toEqual(["ada · pro"]);
		setState((s) => (s.user.plan = "free"));
		expect(seen).toEqual(["ada · pro", "ada · free"]);
		setState((s) => (s.user.name = "grace"));
		expect(seen).toEqual(["ada · pro", "ada · free", "grace · free"]);
	});

	test("inert inside a scope suppresses that read only", () => {
		const [state, setState] = store({ user: { name: "ada", plan: "pro" } });
		const seen: string[] = [];
		createRoot(() => {
			effect(() => {
				const plan = inert(() => state.user.plan);
				seen.push(`${state.user.name} · ${plan}`);
			});
		});
		expect(seen).toEqual(["ada · pro"]);
		setState((s) => (s.user.plan = "free")); // not subscribed
		expect(seen).toEqual(["ada · pro"]);
		setState((s) => (s.user.name = "grace")); // subscribed
		expect(seen).toEqual(["ada · pro", "grace · free"]);
	});

	test("inert outside a scope is a no-op", () => {
		const [count] = signal(5);
		expect(inert(count)).toBe(5);
	});
});

describe("scopes", () => {
	test("live is deferred: runs after commit, then re-runs on change", () => {
		const [count, setCount] = signal(0);
		const runs: number[] = [];
		createRoot(() => {
			effect(() => runs.push(count()));
			expect(runs).toEqual([]); // not yet — commit hasn't exited
		});
		expect(runs).toEqual([0]);
		setCount(1);
		expect(runs).toEqual([0, 1]);
	});

	test("memo caches and recomputes on dependency change", () => {
		const [count, setCount] = signal(2);
		let computes = 0;
		let doubled: () => number = () => 0;
		createRoot(() => {
			doubled = memo(() => {
				computes++;
				return count() * 2;
			});
		});
		expect(doubled()).toBe(4);
		expect(doubled()).toBe(4);
		expect(computes).toBe(1);
		setCount(3);
		expect(doubled()).toBe(6);
		expect(computes).toBe(2);
	});

	test("a live reading a memo never observes a stale value (no glitch)", () => {
		const [count, setCount] = signal(1);
		const observed: Array<[number, number]> = [];
		createRoot(() => {
			const doubled = memo(() => count() * 2);
			effect(() => observed.push([count(), doubled()]));
		});
		setCount(2);
		setCount(3);
		for (const [c, d] of observed) {
			expect(d).toBe(c * 2); // consistent at every observation
		}
		expect(observed.length).toBe(3);
	});

	test("memo equals cut stops propagation: dependents skip equal values", () => {
		const [items, setItems] = signal<string[]>(["a", "b"]);
		let runs = 0;
		createRoot(() => {
			const empty = memo(() => items().length === 0);
			effect(() => {
				empty();
				runs++;
			});
		});
		expect(runs).toBe(1);
		setItems(["b", "a"]); // memo recomputes, value unchanged -> no re-run
		expect(runs).toBe(1);
		setItems([]); // value flips -> dependent re-runs
		expect(runs).toBe(2);
	});

	test("cleanup runs before every re-run, not only at disposal", () => {
		const [count, setCount] = signal(0);
		const events: string[] = [];
		createRoot(() => {
			effect(() => {
				const value = count();
				cleanup(() => events.push(`cleanup ${value}`));
			});
		});
		expect(events).toEqual([]);
		setCount(1);
		expect(events).toEqual(["cleanup 0"]);
	});

	test("nested scopes dispose with their parent", () => {
		const [outer, setOuter] = signal(0);
		const [inner, setInner] = signal(0);
		let innerRuns = 0;
		createRoot(() => {
			effect(() => {
				outer();
				effect(() => {
					inner();
					innerRuns++;
				});
			});
		});
		expect(innerRuns).toBe(1);
		setOuter(1); // outer re-runs; previous inner scope disposed
		expect(innerRuns).toBe(2);
		setInner(1); // only the current inner scope re-runs
		expect(innerRuns).toBe(3);
	});

	test("body-level lives dispose with the root", () => {
		const [count, setCount] = signal(0);
		let runs = 0;
		createRoot((dispose) => {
			effect(() => {
				count();
				runs++;
			});
			dispose();
		});
		setCount(1);
		expect(runs).toBe(0); // disposed before its first (deferred) run
	});
});

describe("state", () => {
	test("store proxy throws on write (in production too)", () => {
		const [state] = store({ value: 1 });
		expect(() => {
			(state as any).value = 2;
		}).toThrow(/read-only/);
		expect(() => {
			delete (state as any).value;
		}).toThrow(/read-only/);
	});

	test("the setter's draft is writable and mutates directly", () => {
		const [state, setState] = store({
			user: { name: "ada" },
			tags: [] as string[],
		});
		setState((s) => {
			s.user.name = "grace";
			s.tags.push("admin");
		});
		expect(state.user.name).toBe("grace");
		expect(state.tags.length).toBe(1);
	});

	test("a setter call is one propagation for its store", () => {
		const [state, setState] = store({ a: 1, b: 2 });
		let runs = 0;
		createRoot(() => {
			effect(() => {
				state.a;
				state.b;
				runs++;
			});
		});
		expect(runs).toBe(1);
		setState((s) => {
			s.a = 10;
			s.b = 20;
		});
		expect(runs).toBe(2); // one propagation, not two
	});

	test("signal tuple get/set with functional updates", () => {
		const [count, setCount] = signal(10);
		setCount((c) => c + 5);
		expect(count()).toBe(15);
	});
});

describe("batch", () => {
	test("nests and collapses to a single flush", () => {
		const [a, setA] = signal(0);
		const [b, setB] = signal(0);
		let runs = 0;
		createRoot(() => {
			effect(() => {
				a();
				b();
				runs++;
			});
		});
		expect(runs).toBe(1);
		batch(() => {
			setA(1);
			batch(() => {
				setB(1);
			});
			setA(2);
		});
		expect(runs).toBe(2);
	});

	test("reads inside a batch see pending writes", () => {
		const [total, setTotal] = signal(0);
		batch(() => {
			for (const price of [1, 2, 3]) {
				setTotal((t) => t + price);
			}
			expect(total()).toBe(6);
		});
		expect(total()).toBe(6);
	});

	test("throw inside a batch: exception propagates, depth resets, queue flushes", () => {
		const [count, setCount] = signal(0);
		let runs = 0;
		createRoot(() => {
			effect(() => {
				count();
				runs++;
			});
		});
		expect(runs).toBe(1);
		expect(() =>
			batch(() => {
				setCount(1);
				throw new Error("boom");
			}),
		).toThrow("boom");
		// The mutation landed; the queued notification flushed on the way out.
		expect(runs).toBe(2);
		// Depth reset: later writes propagate normally.
		setCount(2);
		expect(runs).toBe(3);
	});

	test("throw inside live/inert restores tracking (no phantom subscriptions)", () => {
		const [count, setCount] = signal(0);
		const [other, setOther] = signal(0);
		let runs = 0;
		createRoot(() => {
			effect(() => {
				count();
				runs++;
				if (count() === 1) throw new Error("live boom");
			});
		});
		expect(runs).toBe(1);
		expect(() => setCount(1)).toThrow("live boom");
		// Tracking stack restored: reads out here must not subscribe.
		other();
		setOther(1);
		expect(runs).toBe(2);
	});
});

describe("hard errors", () => {
	test("cleanup() with no argument throws", () => {
		const seen: string[] = [];
		createRoot(() => {
			effect(() => {
				try {
					(cleanup as any)();
				} catch (e) {
					seen.push(String(e));
				}
			});
		});
		expect(seen.length).toBe(1);
		expect(seen[0]).toContain("requires a function");
	});

	test("cleanup() outside a scope throws", () => {
		expect(() => cleanup(() => {})).toThrow(/outside a scope/);
	});

	test("cleanup() inside a memo throws", () => {
		createRoot(() => {
			const bad = memo(() => {
				cleanup(() => {});
				return 1;
			});
			expect(() => bad()).toThrow(/inside a memo/);
		});
	});

	test("live() outside JSX and outside any scope throws", () => {
		expect(() => live(() => 1)).toThrow(/outside/);
	});
});

describe("dev warnings", () => {
	test("signal read during render with no scope warns", () => {
		setDevMode(true);
		const [count] = signal(0);
		const { warnings } = withWarnings(() => {
			createRoot(() => {
				count(); // unwrapped read during a commit
			});
		});
		expect(warnings.some((w) => w.includes("no scope"))).toBe(true);
	});

	test("live() with zero dependencies warns", () => {
		setDevMode(true);
		const { warnings } = withWarnings(() => {
			createRoot(() => {
				live(() => 42); // static expression, defensive over-wrap
			});
		});
		expect(warnings.some((w) => w.includes("zero dependencies"))).toBe(true);
	});

	test("nested live() warns and stays transparent", () => {
		setDevMode(true);
		const [state, setState] = store({ user: { tier: "gold" } });
		const seen: string[] = [];
		const { warnings } = withWarnings(() => {
			createRoot(() => {
				live(() => {
					const tier = live(() => state.user.tier);
					seen.push(String(tier));
				});
			});
			setState((s) => (s.user.tier = "silver"));
		});
		expect(warnings.some((w) => w.includes("nested live"))).toBe(true);
		expect(seen).toEqual(["gold", "silver"]);
	});

	test("warnings are silent when dev mode is off", () => {
		setDevMode(false);
		const [count] = signal(0);
		const { warnings } = withWarnings(() => {
			createRoot(() => {
				count();
				live(() => 42);
			});
		});
		expect(warnings.length).toBe(0);
		setDevMode(true);
	});
});

describe("live bindings", () => {
	test("statement live is an effect; value live is a claimable binding", () => {
		const [count] = signal(1);
		const applied: number[] = [];
		createRoot(() => {
			const binding = live(() => count() * 10);
			expect(isLive(binding)).toBe(true);
			(binding as LiveBinding<number>).claimed = true;
			applied.push((binding as LiveBinding<number>).fn());
		});
		expect(applied).toEqual([10]);
	});

	test("commit boundaries defer lives created inside", () => {
		const runs: number[] = [];
		const [count] = signal(7);
		createRoot(() => {
			commit(() => {
				live(() => {
					runs.push(count());
				});
				expect(runs).toEqual([]);
			});
			// Inner commit exited but the root's commit is still open.
			expect(runs).toEqual([]);
		});
		expect(runs).toEqual([7]);
	});
});
