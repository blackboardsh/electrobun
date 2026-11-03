import { describe, expect, mock, spyOn, test } from "bun:test";
import { TestDeadlineError, withTestDeadline } from "./test-deadline";
import type { TestDefinition } from "./types";

const closedWindows: number[] = [];
let nextWindowId = 1;
mock.module("electrobun/main", () => ({
	BuildConfig: { getSync: () => ({ availableRenderers: ["native", "cef"] }) },
	BrowserView: { getById: () => undefined },
	BrowserWindow: class {
		id = nextWindowId++;
		webviewId = this.id;
		webview = { id: this.id };
		close() { closedWindows.push(this.id); }
	},
}));
const { TestExecutor } = await import("./executor");

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function definition(name: string, run: TestDefinition["run"], timeout = 1000): TestDefinition {
	return { id: name, name, category: name, interactive: false, timeout, run };
}

describe("test deadlines", () => {
	test("clears the timer after success and ordinary failure", async () => {
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			await expect(withTestDeadline(Promise.resolve("done"), 60_000)).resolves.toBe("done");
			const failure = new Error("assertion failed");
			await expect(withTestDeadline(Promise.reject(failure), 60_000)).rejects.toBe(failure);
			const handles = timers.mock.results.map(result => {
				if (result.type !== "return") throw new Error("setTimeout did not return a timer handle");
				return result.value;
			});
			expect(clear.mock.calls.map(([handle]) => handle)).toEqual(handles);
		} finally {
			timers.mockRestore();
			clear.mockRestore();
		}
	});

	test("reports a typed deadline without treating late completion as cancellation", async () => {
		const operation = deferred();
		await expect(withTestDeadline(operation.promise, 1)).rejects.toBeInstanceOf(TestDeadlineError);
		operation.resolve();
		await operation.promise;
	});

	test("rejects completion past the monotonic deadline before the timer runs", async () => {
		const clock = spyOn(performance, "now").mockReturnValue(100);
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			// Simulate native work consuming time while JavaScript timers cannot
			// run. The operation settles in a microtask before the timer phase.
			const operation = Promise.resolve().then(() => {
				clock.mockReturnValue(1100);
				return "late completion";
			});
			await expect(withTestDeadline(operation, 1000)).rejects.toBeInstanceOf(TestDeadlineError);
			const handles = timers.mock.results.map(result => {
				if (result.type !== "return") throw new Error("setTimeout did not return a timer handle");
				return result.value;
			});
			expect(clear.mock.calls.map(([handle]) => handle)).toEqual(handles);
		} finally {
			clock.mockRestore();
			timers.mockRestore();
			clear.mockRestore();
		}
	});
});

describe("executor timeout isolation", () => {
	test("stops the suite and defers cleanup until the timed-out task settles", async () => {
		const executor = new TestExecutor();
		const finished = deferred();
		const windowCreated = deferred<number>();
		let subsequentRuns = 0;
		const completed: string[] = [];
		executor.onEvent(event => {
			if (event.type === "all-completed") completed.push(...(event.results ?? []).map(result => result.status));
		});
		executor.registerTests([
			definition("timed-out task", async context => {
				const window = await context.createWindow({});
				windowCreated.resolve(window.id);
				await finished.promise;
			}, 1),
			definition("subsequent task", async () => { subsequentRuns++; }),
		]);
		const results = await executor.runAllAutomated();
		expect(results.map(result => result.status)).toEqual(["failed"]);
		expect(results[0]?.error).toMatch(/Test timed out/);
		expect(completed).toEqual(["failed"]);
		expect(subsequentRuns).toBe(0);
		expect(executor.getSummary().pending).toBe(1);
		const windowId = await windowCreated.promise;
		expect(closedWindows).not.toContain(windowId);
		await expect(executor.runAllAutomated()).rejects.toThrow("Restart Kitchen Sink");
		await expect(executor.runInteractiveTests()).rejects.toThrow("Restart Kitchen Sink");
		await expect(executor.runTest(definition("manual retry", async () => { subsequentRuns++; }))).rejects.toThrow("Restart Kitchen Sink");
		finished.resolve();
		// Deferred cleanup begins after the original operation settles.
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(closedWindows).toContain(windowId);
		expect(subsequentRuns).toBe(0);
		await expect(executor.runAllAutomated()).rejects.toThrow("Restart Kitchen Sink");
	});

	test("continues after ordinary failures because their test work has settled", async () => {
		const executor = new TestExecutor();
		let subsequentRuns = 0;
		executor.registerTests([
			definition("assertion failure", async () => { throw new Error("expected assertion failure"); }),
			definition("next task", async () => { subsequentRuns++; }),
		]);
		const results = await executor.runAllAutomated();
		expect(results.map(result => result.status)).toEqual(["failed", "passed"]);
		expect(subsequentRuns).toBe(1);
		await expect(executor.runTest(definition("manual retry", async () => {}))).resolves.toMatchObject({ status: "passed" });
	});

	test("observes late rejection after timeout without starting another test", async () => {
		const executor = new TestExecutor();
		const finished = deferred();
		const result = await executor.runTest(definition("late failure", () => finished.promise, 1));
		expect(result.status).toBe("failed");
		finished.reject(new Error("late native failure"));
		await new Promise(resolve => setTimeout(resolve, 0));
		await expect(executor.runAllAutomated()).rejects.toThrow("Restart Kitchen Sink");
	});
});
