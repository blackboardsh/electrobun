import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebviewCleanupLifecycle } from "./webview-cleanup-lifecycle.ts";

const wait = (delay: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, delay));

describe("webview cleanup lifecycle", () => {
	it("rejects timer errors, closes owned windows, and cancels later work", async () => {
		let closeCount = 0;
		let laterCallbackCount = 0;
		let resolveCount = 0;
		let rejectCount = 0;
		let lifecycle!: ReturnType<
			typeof createWebviewCleanupLifecycle<{ close(): void }>
		>;
		const result = new Promise<void>((resolve, reject) => {
			lifecycle = createWebviewCleanupLifecycle(
				() => {
					resolveCount++;
					resolve();
				},
				(error) => {
					rejectCount++;
					reject(error);
				},
			);
		});

		lifecycle.trackWindow({
			close() {
				closeCount++;
			},
		});
		lifecycle.schedule(() => {
			throw new Error("spawn failed");
		}, 0);
		lifecycle.schedule(() => {
			laterCallbackCount++;
		}, 20);

		await assert.rejects(result, /spawn failed/);
		await wait(30);

		assert.equal(closeCount, 1);
		assert.equal(laterCallbackCount, 0);
		assert.equal(resolveCount, 0);
		assert.equal(rejectCount, 1);
		assert.equal(lifecycle.isActive(), false);
		lifecycle.complete();
		lifecycle.fail(new Error("late failure"));
		assert.equal(closeCount, 1);
		assert.equal(resolveCount, 0);
		assert.equal(rejectCount, 1);
	});

	it("does not close an already-closed window during successful cleanup", async () => {
		let closeCount = 0;
		let lifecycle!: ReturnType<
			typeof createWebviewCleanupLifecycle<{ close(): void }>
		>;
		const result = new Promise<void>((resolve, reject) => {
			lifecycle = createWebviewCleanupLifecycle(resolve, reject);
		});
		const win = {
			close() {
				closeCount++;
			},
		};

		lifecycle.trackWindow(win);
		assert.equal(lifecycle.markWindowClosed(win), true);
		assert.equal(lifecycle.markWindowClosed(win), false);
		lifecycle.complete();
		await result;

		assert.equal(closeCount, 0);
		assert.equal(lifecycle.getOpenWindowCount(), 0);
	});
});
