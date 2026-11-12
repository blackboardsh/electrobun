import { describe, expect, test } from "bun:test";
import { TestDeadlineError, withTestDeadline } from "../test-framework/test-deadline";
import { createHarnessReadiness } from "./rpc-harness-readiness";

describe("RPC harness readiness", () => {
	test("gates work until a delayed ready notification arrives", async () => {
		const readiness = createHarnessReadiness(() => 200);
		let continued = false;
		const waiting = readiness.wait().then((receipt) => {
			continued = true;
			return receipt;
		});
		await Promise.resolve();
		expect(continued).toBe(false);

		readiness.signal({ rendererReadyAt: 100, webviewId: 7 });
		expect(await waiting).toEqual({ rendererReadyAt: 100, webviewId: 7, hostReceivedAt: 200 });
		expect(continued).toBe(true);
	});

	test("retains readiness before waiting and ignores duplicate notifications", async () => {
		let clockReads = 0;
		const readiness = createHarnessReadiness(() => 200 + clockReads++);
		const notice = { rendererReadyAt: 100, webviewId: 7 };
		readiness.signal(notice);
		notice.rendererReadyAt = 300;
		readiness.signal({ rendererReadyAt: 400, webviewId: 8 });

		const expected = { rendererReadyAt: 100, webviewId: 7, hostReceivedAt: 200 };
		expect(await readiness.wait()).toEqual(expected);
		expect(await readiness.wait()).toEqual(expected);
		expect(clockReads).toBe(1);
	});

	test("isolates readiness between windows", async () => {
		const first = createHarnessReadiness(() => 200);
		const second = createHarnessReadiness(() => 400);
		let secondContinued = false;
		const secondWaiting = second.wait().then((receipt) => {
			secondContinued = true;
			return receipt;
		});
		first.signal({ rendererReadyAt: 100, webviewId: 7 });
		expect(await first.wait()).toEqual({ rendererReadyAt: 100, webviewId: 7, hostReceivedAt: 200 });
		expect(secondContinued).toBe(false);

		second.signal({ rendererReadyAt: 300, webviewId: 8 });
		expect(await secondWaiting).toEqual({ rendererReadyAt: 300, webviewId: 8, hostReceivedAt: 400 });
	});

	test("leaves a missing ready notification to the existing test deadline", async () => {
		const readiness = createHarnessReadiness(() => 200);
		await expect(withTestDeadline(readiness.wait(), 20)).rejects.toBeInstanceOf(TestDeadlineError);

		// The outer deadline reports failure without cancelling the page's work.
		readiness.signal({ rendererReadyAt: 100, webviewId: 7 });
		expect(await readiness.wait()).toEqual({ rendererReadyAt: 100, webviewId: 7, hostReceivedAt: 200 });
	});
});
