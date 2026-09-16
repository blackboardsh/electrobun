import { describe, expect, test } from "bun:test";
import { observeAsyncReady } from "../asyncReady";

describe("observeAsyncReady", () => {
	test("reports a rejected ready callback", async () => {
		const error = new Error("ready failed");
		const reported: unknown[] = [];
		observeAsyncReady(Promise.reject(error), () => false, (reason) => {
			reported.push(reason);
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(reported).toEqual([error]);
	});

	test("ignores rejection after the owning view is removed", async () => {
		const reported: unknown[] = [];
		observeAsyncReady(Promise.reject(new Error("cancelled")), () => true, (error) => {
			reported.push(error);
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(reported).toEqual([]);
	});
});
