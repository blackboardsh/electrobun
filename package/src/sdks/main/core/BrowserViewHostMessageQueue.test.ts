import { describe, expect, test } from "bun:test";
import { BrowserView } from "./BrowserView";

type TestPacket = {
	type: "message" | "response";
	id: string;
};

type QueuedTestPacket = {
	message: string;
	markSent: () => void;
};

function createQueueOnlyBrowserView(sentIds: string[]) {
	const view = Object.create(BrowserView.prototype) as BrowserView;
	view.isRemoved = false;
	view.hostMessageSendQueue = [];
	view.hostResponseSendQueue = [];
	view.flushingHostMessageSendQueue = false;
	Object.assign(view, { hostMessageQueuedBytes: 0, hostMessageEnqueued: 0, hostMessageDrained: 0, hostMessagePeakQueuedBytes: 0, hostMessagePeakQueuedCount: 0 });
	Object.defineProperty(view, "ptr", { value: 1 });
	Object.defineProperty(view, "sendQueuedHostMessageBatch", {
		configurable: true,
		value(queuedMessages: QueuedTestPacket[]) {
			for (const queuedMessage of queuedMessages) {
				sentIds.push(JSON.parse(queuedMessage.message).id);
				queuedMessage.markSent();
			}
		},
	});
	return view;
}

describe.skipIf(process.platform !== "linux")(
	"BrowserView Linux host message queue",
	() => {
		test("prioritizes responses while preserving FIFO within packet classes", async () => {
			const sentIds: string[] = [];
			const view = createQueueOnlyBrowserView(sentIds);
			const packets: TestPacket[] = [
				{ type: "message", id: "message-1" },
				{ type: "response", id: "response-1" },
				{ type: "message", id: "message-2" },
				{ type: "response", id: "response-2" },
			];

			await Promise.all(
				packets.map((packet) => view.queueHostMessageToWebview(packet)),
			);

			expect(sentIds).toEqual([
				"response-1",
				"response-2",
				"message-1",
				"message-2",
			]);
		});
	},
);


describe("BrowserView host delivery backlog", () => {
	test("drains a compilation-sized burst in order", async () => {
		const sentIds: string[] = [];
		const view = createQueueOnlyBrowserView(sentIds);
		const deliveries: Promise<void>[] = [];
		for (let i = 0; i < 10000; i++) {
			deliveries.push(view.queueHostMessageToWebview({ type: "message", id: String(i), payload: "output" }));
		}
		expect(view.getHostMessageQueueStats().queuedMessages).toBe(10000);
		expect(view.getHostMessageQueueStats().queuedBytes).toBeGreaterThan(0);
		await Promise.all(deliveries);
		expect(sentIds).toEqual(Array.from({ length: 10000 }, (_, i) => String(i)));
		expect(view.getHostMessageQueueStats()).toMatchObject({ queuedMessages: 0, queuedBytes: 0, oldestMessageAgeMs: 0, enqueuedMessages: 10000, drainedMessages: 10000 });
	});

	test("bounds batch bytes and makes progress for an oversized packet", async () => {
		const view = createQueueOnlyBrowserView([]);
		const batchSizes: number[] = [];
		Object.defineProperty(view, "sendQueuedHostMessageBatch", { configurable: true, value(batch: QueuedTestPacket[]) {
			batchSizes.push(batch.length);
			for (const entry of batch) entry.markSent();
		} });
		await Promise.all(Array.from({ length: 3 }, () => view.queueHostMessageToWebview({ payload: "x".repeat(600 * 1024) })));
		expect(batchSizes).toEqual([1, 1, 1]);
		expect(view.getHostMessageQueueStats().queuedBytes).toBe(0);
	});

	test("removal releases pending payloads and settles producers", async () => {
		const view = createQueueOnlyBrowserView([]);
		const delivery = view.queueHostMessageToWebview({ type: "message", id: "pending" });
		view.isRemoved = true;
		await delivery;
		expect(view.getHostMessageQueueStats().queuedMessages).toBe(0);
		expect(view.getHostMessageQueueStats().queuedBytes).toBe(0);
	});
});


test.skipIf(process.platform !== "win32")("Windows batches contain RPC objects, not double-encoded JSON strings", async () => {
	const view = createQueueOnlyBrowserView([]);
	delete (view as any).sendQueuedHostMessageBatch;
	const received: unknown[] = [];
	(view as any).sendHostMessagesToWebviewViaExecute = (packets: string[]) => received.push(...packets.map(packet => JSON.parse(packet)));
	const packet = { type: "message", id: "terminalOutput", payload: { data: "line\nwith \"quotes\"" } };
	await view.queueHostMessageToWebview(packet);
	expect(received).toEqual([packet]);
});
