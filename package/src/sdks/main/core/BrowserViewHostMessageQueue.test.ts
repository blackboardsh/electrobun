import { describe, expect, test } from "bun:test";
import { BrowserView } from "./BrowserView";

type TestPacket = {
	type: "message" | "response";
	id: string;
};

type QueuedTestPacket = {
	message: TestPacket;
	markSent: () => void;
};

function createQueueOnlyBrowserView(sentIds: string[]) {
	const view = Object.create(BrowserView.prototype) as BrowserView;
	view.isRemoved = false;
	view.hostMessageSendQueue = [];
	view.hostResponseSendQueue = [];
	view.flushingHostMessageSendQueue = false;
	Object.defineProperty(view, "ptr", { value: 1 });
	Object.defineProperty(view, "sendQueuedHostMessageBatch", {
		value(queuedMessages: QueuedTestPacket[]) {
			for (const queuedMessage of queuedMessages) {
				sentIds.push(queuedMessage.message.id);
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
