import { describe, expect, it } from "bun:test";
import { parseWebviewEventBridgeMessage } from "./eventBridge";

describe("parseWebviewEventBridgeMessage", () => {
	it("uses the native sender id instead of the payload id", () => {
		expect(
			parseWebviewEventBridgeMessage(
				17,
				JSON.stringify({
					id: "webviewEvent",
					payload: {
						id: 99,
						eventName: "host-message",
						detail: "{\"message\":\"hello\"}",
					},
				}),
			),
		).toEqual({
			id: 17,
			eventName: "host-message",
			detail: "{\"message\":\"hello\"}",
		});
	});

	it("ignores malformed event payloads", () => {
		expect(parseWebviewEventBridgeMessage(1, "[]")).toBeNull();
		expect(parseWebviewEventBridgeMessage(1, "{not-json")).toBeNull();
		expect(
			parseWebviewEventBridgeMessage(
				1,
				'{"id":"webviewEvent","payload":{"eventName":"host-message"}}',
			),
		).toBeNull();
	});
});
