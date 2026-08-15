/**
 * Run every cleanup even when an earlier one throws. The first error is
 * rethrown after all remaining resources have had a chance to tear down.
 */
export function runCleanupSteps(steps: ReadonlyArray<() => void>): void {
	let firstError: unknown;
	let failed = false;

	for (const step of steps) {
		try {
			step();
		} catch (error) {
			if (!failed) {
				failed = true;
				firstError = error;
			}
		}
	}

	if (failed) throw firstError;
}
