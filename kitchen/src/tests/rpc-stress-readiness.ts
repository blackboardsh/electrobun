import type { HostSocketStressState } from "../test-harness/index";

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForHostSocketOpen(
	webviewRpc: any,
	timeoutMs = 10000,
): Promise<HostSocketStressState> {
	const deadline = Date.now() + timeoutMs;
	let lastState: HostSocketStressState | undefined;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			const currentState = (await webviewRpc.request.getHostSocketStressState(
				{},
				{
					maxRequestTime: Math.max(
						1,
						Math.min(500, deadline - Date.now()),
					),
				},
			)) as HostSocketStressState;
			lastState = currentState;
			lastError = undefined;
			if (currentState.readyState === 1) {
				return currentState;
			}
		} catch (error) {
			// A host message sent before the harness preload installs its RPC
			// receiver is dropped. Keep probing instead of inheriting the RPC's
			// 30-second timeout and getting stuck on that first startup request.
			lastError = error;
		}
		await sleep(100);
	}

	const errorDetail =
		lastError instanceof Error ? lastError.message : String(lastError ?? "none");
	throw new Error(
		`Timed out waiting for webview host socket to open: state=${JSON.stringify(lastState)}, lastError=${errorDetail}`,
	);
}
