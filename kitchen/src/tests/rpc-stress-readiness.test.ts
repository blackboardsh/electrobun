import { describe, expect, test } from "bun:test";
import type { HostSocketStressState } from "../test-harness/index";
import { waitForHostSocketOpen } from "./rpc-stress-readiness";

const openState: HostSocketStressState = {
	hasSocket: true,
	hostSocketPort: 50000,
	socketUrl: "ws://127.0.0.1:50000/socket?webviewId=2",
	readyState: 1,
	bufferedAmount: 0,
	canSend: true,
	hasEncrypt: true,
	hasHostBridge: true,
	sendQueueLength: 0,
	pendingQueueLength: 0,
	flushingSendQueue: false,
	flushingPendingQueue: false,
};

describe("RPC stress harness readiness", () => {
	test("retries a startup request that was sent before the preload receiver existed", async () => {
		let attempts = 0;
		const requestTimeouts: number[] = [];
		const webviewRpc = {
			request: {
				async getHostSocketStressState(
					_params: {},
					options: { maxRequestTime: number },
				) {
					attempts += 1;
					requestTimeouts.push(options.maxRequestTime);
					if (attempts === 1) {
						throw new Error("RPC request timed out.");
					}
					return openState;
				},
			},
		};

		const result = await waitForHostSocketOpen(webviewRpc, 2000);

		expect(result).toEqual(openState);
		expect(attempts).toBe(2);
		expect(requestTimeouts.every((timeout) => timeout > 0 && timeout <= 500)).toBe(
			true,
		);
	});
});
