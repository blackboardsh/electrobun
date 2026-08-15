export type CleanupWindow = {
	close(): void;
};

type LifecycleCallback = () => void | Promise<void>;

export function createWebviewCleanupLifecycle<T extends CleanupWindow>(
	resolve: () => void,
	reject: (error: unknown) => void,
) {
	let settled = false;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const openWindows = new Set<T>();

	const cancelTimers = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};

	const closeOpenWindows = () => {
		for (const win of openWindows) {
			try {
				win.close();
			} catch {}
		}
		openWindows.clear();
	};

	const complete = () => {
		if (settled) return;
		settled = true;
		cancelTimers();
		closeOpenWindows();
		resolve();
	};

	const fail = (error: unknown) => {
		if (settled) return;
		settled = true;
		cancelTimers();
		closeOpenWindows();
		reject(error);
	};

	const guard = (callback: LifecycleCallback) => {
		if (settled) return;
		try {
			const result = callback();
			if (result) void result.catch(fail);
		} catch (error) {
			fail(error);
		}
	};

	const schedule = (callback: LifecycleCallback, delay: number) => {
		if (settled) return;
		let timer: ReturnType<typeof setTimeout>;
		try {
			timer = setTimeout(() => {
				timers.delete(timer);
				guard(callback);
			}, delay);
			timers.add(timer);
		} catch (error) {
			fail(error);
		}
	};

	return {
		isActive: () => !settled,
		trackWindow(win: T) {
			if (settled) {
				try {
					win.close();
				} catch {}
				return false;
			}
			openWindows.add(win);
			return true;
		},
		markWindowClosed: (win: T) => openWindows.delete(win),
		hasWindow: (win: T) => openWindows.has(win),
		getOpenWindowCount: () => openWindows.size,
		guard,
		schedule,
		complete,
		fail,
	};
}
