type JsonRecord = Record<string, unknown>;

export type WebviewEventBridgeMessage = {
	id: number;
	eventName: string;
	detail: string;
};

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWebviewEventBridgeMessage(
	sourceId: number,
	rawMessage: string,
): WebviewEventBridgeMessage | null {
	if (!rawMessage.startsWith("{")) {
		return null;
	}

	let message: unknown;
	try {
		message = JSON.parse(rawMessage);
	} catch {
		return null;
	}
	if (
		!isJsonRecord(message) ||
		message.id !== "webviewEvent" ||
		!isJsonRecord(message.payload)
	) {
		return null;
	}

	const { eventName, detail } = message.payload;
	if (typeof eventName !== "string" || typeof detail !== "string") {
		return null;
	}

	return { id: sourceId, eventName, detail };
}
