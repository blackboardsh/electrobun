import { describe, expect, test } from "bun:test";
import { BeforeRemoveHooks } from "../../core/beforeRemoveHooks";
import { createViewMountLifecycle } from "../viewMountLifecycle";

function makeLifecycle() {
	const hooks = new BeforeRemoveHooks();
	const errors: unknown[] = [];
	const lifecycle = createViewMountLifecycle({
		subscribeBeforeRemove: (handler) => hooks.subscribe(handler),
		reportError: (error) => errors.push(error),
	});
	return { hooks, lifecycle, errors };
}

describe("view mount lifecycle", () => {
	test("captures removal before an asynchronous mount attaches", () => {
		const state = makeLifecycle();
		let stopCount = 0;

		expect(state.hooks.run()).toEqual([]);
		state.lifecycle.attach(() => stopCount++);
		state.lifecycle.dispose();

		expect(stopCount).toBe(1);
	});

	test("stops synchronously inside the before-remove phase", () => {
		const state = makeLifecycle();
		const calls: string[] = [];
		state.lifecycle.attach(() => calls.push("stop"));

		state.hooks.run();
		calls.push("release-context", "remove-native-view");

		expect(calls).toEqual(["stop", "release-context", "remove-native-view"]);
	});

	test("explicit disposal stops and unsubscribes without removing the view", () => {
		const state = makeLifecycle();
		let stopCount = 0;
		let viewRemoved = false;
		state.lifecycle.attach(() => stopCount++);

		state.lifecycle.dispose();
		state.lifecycle.dispose();
		expect(stopCount).toBe(1);
		expect(viewRemoved).toBe(false);

		viewRemoved = true;
		state.hooks.run();
		expect(stopCount).toBe(1);
		expect(viewRemoved).toBe(true);
	});

	test("a throwing stop cannot interrupt later before-remove hooks", () => {
		const state = makeLifecycle();
		const stopError = new Error("stop failed");
		let laterHookRan = false;
		state.lifecycle.attach(() => {
			throw stopError;
		});
		state.hooks.subscribe(() => {
			laterHookRan = true;
		});

		expect(state.hooks.run()).toEqual([]);
		expect(state.errors).toEqual([stopError]);
		expect(laterHookRan).toBe(true);
	});
});
