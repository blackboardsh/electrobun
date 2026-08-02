import { describe, expect, it } from "bun:test";
import { parseWebviewEventBridgeMessage } from "./eventBridge";

const eventMessage = (id: number, detail = '{"message":"hello"}') =>
	JSON.stringify({
		id: "webviewEvent",
		type: "message",
		payload: { id, eventName: "host-message", detail },
	});

describe("parseWebviewEventBridgeMessage", () => {
	it("accepts the matching native sender id", () => {
		expect(parseWebviewEventBridgeMessage(17, eventMessage(17))).toEqual({
			id: 17,
			eventName: "host-message",
			detail: '{"message":"hello"}',
		});
	});

	it("rejects spoofed and malformed payloads", () => {
		expect(parseWebviewEventBridgeMessage(17, eventMessage(99))).toBeNull();
		expect(parseWebviewEventBridgeMessage(1, "[]")).toBeNull();
		expect(parseWebviewEventBridgeMessage(1, "{not-json")).toBeNull();
		expect(
			parseWebviewEventBridgeMessage(
				1,
				'{"id":"webviewEvent","type":"message","payload":{"id":1,"eventName":"host-message"}}',
			),
		).toBeNull();
	});

	it("keeps hostile detail as inert string data", () => {
		const detail = 'null); globalThis.pwned = "yes"; //';
		expect(parseWebviewEventBridgeMessage(4, eventMessage(4, detail))).toEqual({
			id: 4,
			eventName: "host-message",
			detail,
		});
	});
});
