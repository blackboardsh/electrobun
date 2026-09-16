import { runCleanupSteps } from "./cleanupSteps";

export interface ViewMountLifecycleOptions {
	subscribeBeforeRemove(handler: () => void): () => void;
	reportError?(error: unknown): void;
}

export interface ViewMountLifecycle {
	/** Attach teardown after asynchronous mount initialization completes. */
	attach(stop: () => void): void;
	/** Stop the mount without removing its caller-owned view. */
	dispose(): void;
}

/**
 * Subscribe before an asynchronous view mount begins. If removal wins the
 * race, the eventual mount teardown runs as soon as it is attached.
 */
export function createViewMountLifecycle(
	options: ViewMountLifecycleOptions,
): ViewMountLifecycle {
	let finished = false;
	let subscribed = true;
	let detachRequested = false;
	let unsubscribe: (() => void) | null = null;
	let stopRequested = false;
	let stopRan = false;
	let stop: (() => void) | null = null;

	const detach = () => {
		if (!unsubscribe) {
			detachRequested = true;
			return;
		}
		if (!subscribed) return;
		subscribed = false;
		const detachSubscription = unsubscribe;
		unsubscribe = null;
		detachSubscription();
	};

	const requestStop = () => {
		stopRequested = true;
		if (!stop || stopRan) return;
		stopRan = true;
		stop();
	};

	const finish = () => {
		if (finished) return;
		finished = true;
		runCleanupSteps([detach, requestStop]);
	};

	const onBeforeRemove = () => {
		try {
			finish();
		} catch (error) {
			try {
				(options.reportError ?? ((reason) => console.error(reason)))(error);
			} catch {}
		}
	};

	unsubscribe = options.subscribeBeforeRemove(onBeforeRemove);
	if (detachRequested) detach();

	return {
		attach(nextStop) {
			if (stop) {
				throw new Error("UI view lifecycle already has a stop callback");
			}
			stop = nextStop;
			if (stopRequested) requestStop();
		},
		dispose() {
			finish();
		},
	};
}
