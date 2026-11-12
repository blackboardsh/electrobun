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

	test("classifies a late rejection before the timer runs and preserves its cause", async () => {
		const clock = spyOn(performance, "now").mockReturnValue(100);
		const timers = spyOn(globalThis, "setTimeout");
		const clear = spyOn(globalThis, "clearTimeout");
		try {
			const failure = new Error("Fullscreen restoration exceeded its observation limit");
			const operation = Promise.resolve().then(() => {
				// A blocked native getter returns after the outer deadline. Its
				// rejection reaches Promise.race before the overdue timer callback.
				clock.mockReturnValue(1100);
				throw failure;
			});
			const error = await withTestDeadline(operation, 1000).catch(error => error);
			expect(error).toBeInstanceOf(TestDeadlineError);
			expect(error.cause).toBe(failure);
			expect(error.message).toContain("Test timed out after 1000ms");
			expect(error.message).toContain(failure.message);
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
	test("runs the declared early fixtures first only in the complete automated suite", async () => {
		const executor = new TestExecutor();
		const ran: string[] = [];
		const fixture = (name: string, category: string, automatedFirst = false) => ({
			...definition(name, async () => { ran.push(name); }), category, automatedFirst,
		});
		const registered = [
			fixture("view", "BrowserView"), fixture("rpc", "RPC"), fixture("window", "BrowserWindow"),
			fixture("fullscreen", "BrowserWindow", true), fixture("hidden fullscreen", "BrowserWindow", true),
			{ ...fixture("manual", "BrowserWindow", true), interactive: true },
			fixture("second view", "BrowserView"),
		];
		executor.registerTests(registered);
		expect(executor.getTests()).toEqual(registered);
		expect(executor.getTestsByCategory().get("BrowserWindow")?.map((test) => test.name)).toEqual([
			"window", "fullscreen", "hidden fullscreen", "manual",
		]);
		await executor.runTest(registered[2]!);
		expect(ran).toEqual(["window"]);
		ran.length = 0;
		const results = await executor.runAllAutomated();
		expect(ran).toEqual(["fullscreen", "hidden fullscreen", "view", "second view", "rpc", "window"]);
		expect(results.map((result) => result.name)).toEqual(ran);
		expect(results.every((result) => result.status === "passed")).toBe(true);
		expect(executor.getTests()).toEqual(registered);
	});

	test("stops the next test when native work rejects after the deadline before the timer runs", async () => {
		const clock = spyOn(performance, "now").mockReturnValue(100);
		const executor = new TestExecutor();
		let subsequentRuns = 0;
		try {
			executor.registerTests([
				definition("late native rejection", async () => {
					clock.mockReturnValue(10_000);
					throw new Error("Fullscreen restoration exceeded its observation limit");
				}),
				definition("subsequent task", async () => { subsequentRuns++; }),
			]);
			const results = await executor.runAllAutomated();
			expect(results.map(result => result.status)).toEqual(["failed"]);
			expect(results[0]?.error).toContain("Test timed out after");
			expect(results[0]?.error).toContain("Fullscreen restoration exceeded its observation limit");
			expect(subsequentRuns).toBe(0);
			expect(executor.getSummary().pending).toBe(1);
			await expect(executor.runTest(definition("manual retry", async () => { subsequentRuns++; })))
				.rejects.toThrow("Restart Kitchen Sink");
		} finally {
			clock.mockRestore();
		}
	});

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
