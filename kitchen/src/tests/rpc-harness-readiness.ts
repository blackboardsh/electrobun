export type HarnessReadyNotice = {
	rendererReadyAt: number;
	webviewId: number;
};

type HarnessReadyReceipt = HarnessReadyNotice & { hostReceivedAt: number };

/** Remember the first page-ready notification; the test owns its deadline. */
export function createHarnessReadiness(now: () => number = Date.now) {
	let signalled = false;
	let resolveReady!: (receipt: HarnessReadyReceipt) => void;
	const ready = new Promise<HarnessReadyReceipt>((resolve) => {
		resolveReady = resolve;
	});

	return {
		signal(notice: HarnessReadyNotice): void {
			if (signalled) return;
			const receipt = {
				rendererReadyAt: notice.rendererReadyAt,
				webviewId: notice.webviewId,
				hostReceivedAt: now(),
			};
			signalled = true;
			resolveReady(receipt);
		},
		wait: (): Promise<HarnessReadyReceipt> => ready,
	};
}
