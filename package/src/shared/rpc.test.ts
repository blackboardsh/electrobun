import { describe, expect, it } from "bun:test";
import { createRPC } from "./rpc";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createRPC request timeouts", () => {
	it("starts an async transport timeout after the packet is sent", async () => {
		let markSent!: () => void;
		let receive!: (packet: any) => void;
		const sendCompleted = new Promise<void>((resolve) => {
			markSent = resolve;
		});
		const rpc = createRPC({
			maxRequestTime: 20,
			transport: {
				send: () => sendCompleted,
				registerHandler: (handler) => {
					receive = handler;
				},
			},
		});

		const observedResult = (rpc.request as any)("echo", {}).then(
			(value: unknown) => ({ success: true, value }),
			(error: Error) => ({ success: false, error: error.message }),
		);

		await sleep(40);
		markSent();
		receive({ type: "response", id: 1, success: true, payload: "ok" });

		expect(await observedResult).toEqual({ success: true, value: "ok" });
	});
});
