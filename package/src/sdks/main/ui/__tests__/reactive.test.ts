import { describe, expect, test } from "bun:test";
import {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	createStore,
	onCleanup,
	produce,
	untrack,
} from "../reactive";

describe("signals and effects", () => {
	test("effect tracks reads and re-runs on writes", () => {
		createRoot(() => {
			const [count, setCount] = createSignal(0);
			const seen: number[] = [];
			createEffect(() => seen.push(count()));
			setCount(1);
			setCount(2);
			expect(seen).toEqual([0, 1, 2]);
		});
	});

	test("equal writes do not re-run effects", () => {
		createRoot(() => {
			const [count, setCount] = createSignal(1);
			let runs = 0;
			createEffect(() => {
				count();
				runs++;
			});
			setCount(1);
			expect(runs).toBe(1);
		});
	});

	test("functional updates receive the previous value", () => {
		const [count, setCount] = createSignal(10);
		setCount((c) => c + 5);
		expect(count()).toBe(15);
	});

	test("batch coalesces multiple writes into one run", () => {
		createRoot(() => {
			const [a, setA] = createSignal(0);
			const [b, setB] = createSignal(0);
			let runs = 0;
			createEffect(() => {
				a();
				b();
				runs++;
			});
			batch(() => {
				setA(1);
				setB(1);
			});
			expect(runs).toBe(2); // initial + one batched re-run
		});
	});

	test("dependencies re-track each run", () => {
		createRoot(() => {
			const [flag, setFlag] = createSignal(true);
			const [a, setA] = createSignal("a");
			const [b, setB] = createSignal("b");
			const seen: string[] = [];
			createEffect(() => seen.push(flag() ? a() : b()));
			setFlag(false);
			setA("a2"); // no longer tracked
			setB("b2");
			expect(seen).toEqual(["a", "b", "b2"]);
		});
	});

	test("untrack reads without subscribing", () => {
		createRoot(() => {
			const [tracked, setTracked] = createSignal(0);
			const [untracked, setUntracked] = createSignal(0);
			let runs = 0;
			createEffect(() => {
				tracked();
				untrack(untracked);
				runs++;
			});
			setUntracked(1);
			expect(runs).toBe(1);
			setTracked(1);
			expect(runs).toBe(2);
		});
	});

	test("memo caches and re-derives", () => {
		createRoot(() => {
			const [count, setCount] = createSignal(2);
			let computes = 0;
			const doubled = createMemo(() => {
				computes++;
				return count() * 2;
			});
			expect(doubled()).toBe(4);
			expect(doubled()).toBe(4);
			expect(computes).toBe(1);
			setCount(3);
			expect(doubled()).toBe(6);
			expect(computes).toBe(2);
		});
	});

	test("onCleanup runs before each re-run and on dispose", () => {
		const events: string[] = [];
		createRoot((dispose) => {
			const [count, setCount] = createSignal(0);
			createEffect(() => {
				const value = count();
				onCleanup(() => events.push(`cleanup ${value}`));
			});
			setCount(1);
			dispose();
		});
		expect(events).toEqual(["cleanup 0", "cleanup 1"]);
	});

	test("dispose stops future runs", () => {
		let runs = 0;
		const [count, setCount] = createSignal(0);
		createRoot((dispose) => {
			createEffect(() => {
				count();
				runs++;
			});
			dispose();
		});
		setCount(1);
		expect(runs).toBe(1);
	});

	test("nested effects are disposed when the outer effect re-runs", () => {
		createRoot(() => {
			const [outer, setOuter] = createSignal(0);
			const [inner, setInner] = createSignal(0);
			let innerRuns = 0;
			createEffect(() => {
				outer();
				createEffect(() => {
					inner();
					innerRuns++;
				});
			});
			expect(innerRuns).toBe(1);
			setOuter(1); // replaces the nested effect
			expect(innerRuns).toBe(2);
			setInner(1); // only the current nested effect runs
			expect(innerRuns).toBe(3);
		});
	});
});

describe("store with produce", () => {
	test("path-level reads only wake effects for touched paths", () => {
		createRoot(() => {
			const [state, setState] = createStore({
				profile: { name: "ada", age: 36 },
				theme: "dark",
			});
			let nameRuns = 0;
			let themeRuns = 0;
			createEffect(() => {
				state.profile.name;
				nameRuns++;
			});
			createEffect(() => {
				state.theme;
				themeRuns++;
			});
			setState(produce((s) => (s.profile.age = 37)));
			expect(nameRuns).toBe(1);
			expect(themeRuns).toBe(1);
			setState(produce((s) => (s.profile.name = "grace")));
			expect(nameRuns).toBe(2);
			expect(themeRuns).toBe(1);
			expect(state.profile.name).toBe("grace");
		});
	});

	test("array mutations through produce notify list readers", () => {
		createRoot(() => {
			const [state, setState] = createStore({
				items: [] as string[],
			});
			const snapshots: string[][] = [];
			createEffect(() => snapshots.push(state.items.map((s) => s)));
			setState(produce((s) => s.items.push("a")));
			setState(produce((s) => s.items.unshift("b")));
			expect(snapshots.at(-1)).toEqual(["b", "a"]);
		});
	});

	test("ancestor readers are notified of deep changes", () => {
		createRoot(() => {
			const [state, setState] = createStore({
				doc: { title: "one", tags: ["x"] },
			});
			let docRuns = 0;
			createEffect(() => {
				JSON.stringify(state.doc);
				docRuns++;
			});
			setState(produce((s) => (s.doc.title = "two")));
			expect(docRuns).toBe(2);
		});
	});

	test("direct writes to the store throw", () => {
		const [state] = createStore({ value: 1 });
		expect(() => {
			(state as any).value = 2;
		}).toThrow();
	});

	test("shallow merge setter", () => {
		createRoot(() => {
			const [state, setState] = createStore({ a: 1, b: 2 });
			let runs = 0;
			createEffect(() => {
				state.a;
				runs++;
			});
			setState({ a: 5 });
			expect(state.a).toBe(5);
			expect(state.b).toBe(2);
			expect(runs).toBe(2);
		});
	});
});
