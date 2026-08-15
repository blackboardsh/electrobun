/** Observe an async ready callback without leaving a rejected promise loose. */
export function observeAsyncReady(
	result: void | PromiseLike<void>,
	isCancelled: () => boolean,
	reportError: (error: unknown) => void,
): void {
	if (!result || typeof result.then !== "function") return;
	void Promise.resolve(result).catch((error) => {
		if (isCancelled()) return;
		try {
			reportError(error);
		} catch {}
	});
}
