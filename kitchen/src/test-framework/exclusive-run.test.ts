import { describe, expect, test } from "bun:test";
import {
	ExclusiveRunCoordinator,
	RunAlreadyInProgressError,
} from "./exclusive-run";

describe("ExclusiveRunCoordinator", () => {
	test("rejects an overlapping top-level run without starting it", async () => {
		const coordinator = new ExclusiveRunCoordinator();
		let finishFirst!: () => void;
		let secondStarted = false;

		const first = coordinator.run(
			"the automated test suite",
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				}),
		);

		expect(coordinator.currentRun).toBe("the automated test suite");
		const second = coordinator.run("interactive tests", async () => {
			secondStarted = true;
		});

		await expect(second).rejects.toEqual(
			new RunAlreadyInProgressError(
				"the automated test suite",
				"interactive tests",
			),
		);
		expect(secondStarted).toBe(false);

		finishFirst();
		await first;
		expect(coordinator.currentRun).toBeUndefined();
	});

	test("releases the guard after an operation fails", async () => {
		const coordinator = new ExclusiveRunCoordinator();

		await expect(
			coordinator.run("failing test", async () => {
				throw new Error("expected failure");
			}),
		).rejects.toThrow("expected failure");

		await expect(
			coordinator.run("next test", async () => "ran"),
		).resolves.toBe("ran");
	});
});
