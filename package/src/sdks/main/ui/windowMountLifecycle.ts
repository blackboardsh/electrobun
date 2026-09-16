import { runCleanupSteps } from "./cleanupSteps";

export interface WindowLifecycleOptions {
	subscribe(handler: () => void): void;
	unsubscribe(handler: () => void): void;
	close(): void;
	reportError?(error: unknown): void;
}

export interface WindowMountLifecycle {
	/** Resolves for either a natural close or an explicit disposal. */
	readonly closed: Promise<void>;
	isClosed(): boolean;
	/** Attach the mount teardown after asynchronous initialization completes. */
	attach(stop: () => void): void;
	dispose(): void;
}

/**
 * Start tracking a native window before its asynchronous UI mount begins.
 * If the window closes first, `closed` settles immediately and the mount is
 * stopped as soon as it is attached.
 */
export function createWindowMountLifecycle(
	options: WindowLifecycleOptions,
): WindowMountLifecycle {
	let didClose = false;
	let didSettle = false;
	let subscribed = false;
	let stopRequested = false;
	let stopRan = false;
	let stop: (() => void) | null = null;
	let resolveClosed = () => {};
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	const settle = () => {
		if (didSettle) return;
		didSettle = true;
		resolveClosed();
	};

	const detach = () => {
		if (!subscribed) return;
		subscribed = false;
		options.unsubscribe(onNaturalClose);
	};

	const requestStop = () => {
		stopRequested = true;
		if (!stop || stopRan) return;
		stopRan = true;
		stop();
	};

	const finishNaturalClose = () => {
		if (didClose) return;
		didClose = true;
		try {
			runCleanupSteps([detach, requestStop]);
		} finally {
			settle();
		}
	};

	function onNaturalClose() {
		try {
			finishNaturalClose();
		} catch (error) {
			// Native event emitters are synchronous. Never let teardown or a custom
			// reporter abort the remaining global close listeners.
			try {
				(options.reportError ?? ((reason) => console.error(reason)))(error);
			} catch {}
		}
	}

	subscribed = true;
	options.subscribe(onNaturalClose);

	return {
		closed,
		isClosed: () => didClose,
		attach(nextStop) {
			if (stop) {
				throw new Error("UI mount lifecycle already has a stop callback");
			}
			stop = nextStop;
			if (stopRequested) requestStop();
		},
		dispose() {
			if (didClose) return;
			didClose = true;
			try {
				runCleanupSteps([detach, requestStop, options.close]);
			} finally {
				settle();
			}
		},
	};
}

export interface WindowMountLifecycleOptions extends WindowLifecycleOptions {
	stop(): void;
}

/** Backward-compatible one-stage binding for callers whose mount is ready. */
export function bindWindowMountLifecycle(
	options: WindowMountLifecycleOptions,
): () => void {
	const lifecycle = createWindowMountLifecycle(options);
	lifecycle.attach(options.stop);
	return lifecycle.dispose;
}
