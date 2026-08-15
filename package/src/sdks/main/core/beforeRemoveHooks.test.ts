import { describe, expect, test } from "bun:test";
import { BeforeRemoveHooks } from "./beforeRemoveHooks";

describe("BeforeRemoveHooks", () => {
	test("runs every hook once and collects errors", () => {
		const hooks = new BeforeRemoveHooks();
		const calls: string[] = [];
		const error = new Error("first hook failed");
		hooks.subscribe(() => {
			calls.push("first");
			throw error;
		});
		hooks.subscribe(() => calls.push("second"));

		expect(hooks.run()).toEqual([error]);
		expect(hooks.run()).toEqual([]);
		expect(calls).toEqual(["first", "second"]);
	});

	test("an unsubscribed hook is not run", () => {
		const hooks = new BeforeRemoveHooks();
		let calls = 0;
		const unsubscribe = hooks.subscribe(() => calls++);

		unsubscribe();
		unsubscribe();
		expect(hooks.run()).toEqual([]);
		expect(calls).toBe(0);
	});
});
