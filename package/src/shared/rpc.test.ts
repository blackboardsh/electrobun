import { describe, expect, it } from "bun:test";
import { createRPC, type RPCSchema } from "./rpc";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type EmptySchema = RPCSchema<{ requests: {}; messages: {} }>;
type DialogRemoteSchema = RPCSchema<{
	requests: {
		openFileDialog: {
			params: { startingFolder: string };
			response: string[];
		};
		quickRequest: {
			params: { value: string };
			response: string;
		};
	};
	messages: {};
}>;

function createControlledRPC(maxRequestTime: number) {
	let receive!: (packet: any) => void;
	const sentPackets: any[] = [];
	const rpc = createRPC<EmptySchema, DialogRemoteSchema>({
		maxRequestTime,
		transport: {
			send: (packet) => {
				sentPackets.push(packet);
			},
			registerHandler: (handler) => {
				receive = handler;
			},
		},
	});

	return { rpc, receive: (packet: any) => receive(packet), sentPackets };
}

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

	it("overrides the timeout for one request without weakening the default", async () => {
		const { rpc, receive, sentPackets } = createControlledRPC(20);
		const dialogResult = rpc.request.openFileDialog(
			{ startingFolder: "/tmp" },
			{ maxRequestTime: Infinity },
		);
		const quickResult = rpc.request.quickRequest({ value: "quick" }).then(
			(value) => ({ success: true, value }),
			(error: Error) => ({ success: false, error: error.message }),
		);

		await sleep(50);
		receive({
			type: "response",
			id: 1,
			success: true,
			payload: ["/tmp/selected.txt"],
		});

		expect(await dialogResult).toEqual(["/tmp/selected.txt"]);
		expect(await quickResult).toEqual({
			success: false,
			error: "RPC request timed out.",
		});
		expect(sentPackets[0]).toEqual({
			type: "request",
			id: 1,
			method: "openFileDialog",
			params: { startingFolder: "/tmp" },
		});
	});

	it("supports a finite per-request timeout", async () => {
		const { rpc } = createControlledRPC(1000);
		const result = rpc.request
			.quickRequest(
				{ value: "quick" },
				{ maxRequestTime: 20 },
			)
			.then(
				(value) => ({ success: true, value }),
				(error: Error) => ({ success: false, error: error.message }),
			);

		expect(await result).toEqual({
			success: false,
			error: "RPC request timed out.",
		});
	});
});
