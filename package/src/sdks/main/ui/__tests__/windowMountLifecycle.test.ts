import { describe, expect, test } from "bun:test";
import { createWindowMountLifecycle } from "../windowMountLifecycle";

function makeLifecycle() {
	let listener: (() => void) | null = null;
	let unsubscribeCount = 0;
	let closeCount = 0;
	const errors: unknown[] = [];
	const lifecycle = createWindowMountLifecycle({
		subscribe: (handler) => {
			listener = handler;
		},
		unsubscribe: (handler) => {
			expect(listener).toBe(handler);
			unsubscribeCount++;
		},
		close: () => closeCount++,
		reportError: (error) => errors.push(error),
	});
	return {
		lifecycle,
		naturalClose: () => listener!(),
		unsubscribeCount: () => unsubscribeCount,
		closeCount: () => closeCount,
		errors,
	};
}

describe("window mount lifecycle", () => {
	test("captures a natural close before the async mount attaches", async () => {
		const state = makeLifecycle();
		let stopCount = 0;

		state.naturalClose();
		await state.lifecycle.closed;
		expect(state.lifecycle.isClosed()).toBe(true);
		expect(state.unsubscribeCount()).toBe(1);
		expect(state.closeCount()).toBe(0);

		state.lifecycle.attach(() => stopCount++);
		state.lifecycle.dispose();
		expect(stopCount).toBe(1);
		expect(state.closeCount()).toBe(0);
	});

	test("explicit disposal stops, unsubscribes, closes, and settles once", async () => {
		const state = makeLifecycle();
		let stopCount = 0;
		state.lifecycle.attach(() => stopCount++);

		state.lifecycle.dispose();
		state.lifecycle.dispose();
		state.naturalClose();
		await state.lifecycle.closed;

		expect(stopCount).toBe(1);
		expect(state.unsubscribeCount()).toBe(1);
		expect(state.closeCount()).toBe(1);
	});

	test("a throwing stop cannot prevent explicit close or settlement", async () => {
		const state = makeLifecycle();
		const stopError = new Error("stop failed");
		state.lifecycle.attach(() => {
			throw stopError;
		});

		expect(() => state.lifecycle.dispose()).toThrow(stopError);
		await state.lifecycle.closed;
		expect(state.closeCount()).toBe(1);
		expect(state.unsubscribeCount()).toBe(1);
		expect(() => state.lifecycle.dispose()).not.toThrow();
	});

	test("a throwing stop during natural close is reported after settling", async () => {
		const state = makeLifecycle();
		const stopError = new Error("stop failed");
		state.lifecycle.attach(() => {
			throw stopError;
		});

		expect(() => state.naturalClose()).not.toThrow();
		await state.lifecycle.closed;
		expect(state.errors).toEqual([stopError]);
		expect(state.closeCount()).toBe(0);
		expect(state.unsubscribeCount()).toBe(1);
	});
});
