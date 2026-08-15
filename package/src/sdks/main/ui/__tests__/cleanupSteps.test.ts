import { describe, expect, test } from "bun:test";
import { runCleanupSteps } from "../cleanupSteps";

describe("runCleanupSteps", () => {
	test("runs later cleanup after an earlier step throws", () => {
		const calls: string[] = [];
		const firstError = new Error("first cleanup failed");

		expect(() =>
			runCleanupSteps([
				() => {
					calls.push("first");
					throw firstError;
				},
				() => {
					calls.push("second");
				},
			]),
		).toThrow(firstError);
		expect(calls).toEqual(["first", "second"]);
	});
});
