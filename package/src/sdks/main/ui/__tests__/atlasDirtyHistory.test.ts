import { describe, expect, test } from "bun:test";
import { AtlasDirtyHistory } from "../atlasDirtyHistory";

const full = { x0: 0, y0: 0, x1: 100, y1: 100 };

describe("atlas dirty history", () => {
	test("keeps updates independently available to multiple renderers", () => {
		const history = new AtlasDirtyHistory(full);
		history.mark({ x0: 10, y0: 20, x1: 20, y1: 30 });

		let firstRevision = 0;
		let secondRevision = 0;
		const first = history.snapshotSince(firstRevision)!;
		const second = history.snapshotSince(secondRevision)!;
		expect(first).toEqual(second);
		firstRevision = first.revision;

		history.mark({ x0: 40, y0: 5, x1: 50, y1: 15 });
		expect(history.snapshotSince(firstRevision)?.region).toEqual({
			x0: 40,
			y0: 5,
			x1: 50,
			y1: 15,
		});
		expect(history.snapshotSince(secondRevision)?.region).toEqual({
			x0: 10,
			y0: 5,
			x1: 50,
			y1: 30,
		});
		secondRevision = second.revision;
		expect(secondRevision).toBe(1);
	});

	test("a failed upload can retry the same unacknowledged snapshot", () => {
		const history = new AtlasDirtyHistory(full);
		history.mark({ x0: 4, y0: 6, x1: 8, y1: 10 });
		let acknowledgedRevision = 0;

		const failedAttempt = history.snapshotSince(acknowledgedRevision)!;
		const retry = history.snapshotSince(acknowledgedRevision)!;
		expect(retry).toEqual(failedAttempt);

		acknowledgedRevision = retry.revision;
		expect(history.snapshotSince(acknowledgedRevision)).toBeNull();
	});

	test("falls back to the full atlas after bounded history is exceeded", () => {
		const history = new AtlasDirtyHistory(full, 2);
		history.mark({ x0: 1, y0: 1, x1: 2, y1: 2 });
		history.mark({ x0: 3, y0: 3, x1: 4, y1: 4 });
		history.mark({ x0: 5, y0: 5, x1: 6, y1: 6 });

		expect(history.snapshotSince(0)?.region).toEqual(full);
		expect(history.snapshotSince(1)?.region).toEqual({
			x0: 3,
			y0: 3,
			x1: 6,
			y1: 6,
		});
	});
});
