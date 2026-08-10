import { describe, expect, test } from "bun:test";
import { autoRunExitCode, scheduleAutoRunExit } from "./auto-run-exit";

describe("Kitchen AUTO_RUN exit handling", () => {
	test("returns a failure status when any test failed", () => {
		expect(autoRunExitCode([{ status: "passed" }])).toBe(0);
		expect(
			autoRunExitCode([
				{ status: "passed" },
				{ status: "failed" },
			]),
		).toBe(1);
	});

	test("passes the status to graceful quit after the flush delay", () => {
		let scheduledDelay: number | undefined;
		let scheduledCallback: (() => void) | undefined;
		let quitCode: number | undefined;

		scheduleAutoRunExit(
			1,
			(code) => {
				quitCode = code;
			},
			(callback, delayMs) => {
				scheduledCallback = callback;
				scheduledDelay = delayMs;
			},
		);

		expect(scheduledDelay).toBe(500);
		expect(quitCode).toBeUndefined();
		scheduledCallback?.();
		expect(quitCode).toBe(1);
	});
});
