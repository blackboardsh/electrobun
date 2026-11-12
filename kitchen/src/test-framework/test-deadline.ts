export class TestDeadlineError extends Error {
	constructor(readonly timeoutMs: number, options?: ErrorOptions) {
		const detail = options ? `; underlying failure: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}` : "";
		super(`Test timed out after ${timeoutMs}ms${detail}`, options);
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
	} catch (error) {
		// A late native call can reject before the timer runs too. Preserve the
		// failure for diagnosis while still invalidating this test's executor.
		if (!(error instanceof TestDeadlineError) && performance.now() >= deadline) {
			throw new TestDeadlineError(timeoutMs, { cause: error });
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}
