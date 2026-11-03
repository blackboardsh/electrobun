export class TestDeadlineError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Test timed out after ${timeoutMs}ms`);
		this.name = "TestDeadlineError";
	}
}

/** Reports a deadline; it cannot cancel the test's native work. */
export async function withTestDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = performance.now() + timeoutMs;
	try {
		const result = await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TestDeadlineError(timeoutMs)), timeoutMs);
			}),
		]);
		// A synchronous native call can block the event loop past the deadline,
		// then resolve its promise before the overdue timer callback runs.
		if (performance.now() >= deadline) throw new TestDeadlineError(timeoutMs);
		return result;
	} finally {
		clearTimeout(timer);
	}
}
