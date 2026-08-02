// Internal RPC System for webview tags, drag regions, etc.
// Communicates with Bun via __electrobunInternalBridge

import "./globals.d.ts";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

const pendingRequests: Record<string, PendingRequest> = {};
let requestId = 0;
let isProcessingQueue = false;
const sendQueue: string[] = [];

function processQueue() {
	if (isProcessingQueue) {
		setTimeout(processQueue);
		return;
	}
	if (sendQueue.length === 0) return;

	isProcessingQueue = true;
	const batch = JSON.stringify(sendQueue);
	sendQueue.length = 0;
	window.__electrobunInternalBridge?.postMessage(batch);

	// 2ms delay to work around Bun JSCallback threading issue
	setTimeout(() => {
		isProcessingQueue = false;
	}, 2);
}

export function send(type: string, payload: unknown) {
	// Format: { type: 'message', id: handlerName, payload: data }
	sendQueue.push(JSON.stringify({ type: "message", id: type, payload }));
	processQueue();
}

export function request(type: string, payload: unknown): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const id = `req_${++requestId}_${Date.now()}`;
		pendingRequests[id] = { resolve, reject };
		// Format: { type: 'request', method: handlerName, id: requestId, params: data, hostWebviewId: ... }
		sendQueue.push(
			JSON.stringify({
				type: "request",
				method: type,
				id,
				params: payload,
				hostWebviewId: window.__electrobunWebviewId,
			}),
		);
		processQueue();
		// Timeout after 10s
		setTimeout(() => {
			if (pendingRequests[id]) {
				delete pendingRequests[id];
				reject(new Error(`Request timeout: ${type}`));
			}
		}, 10000);
	});
}

export function handleResponse(msg: {
	type: string;
	id: string;
	success: boolean;
	payload: unknown;
}) {
	// msg format: { type: 'response', id: requestId, success: bool, payload: data }
	if (msg && msg.type === "response" && msg.id) {
		const pending = pendingRequests[msg.id];
		if (pending) {
			delete pendingRequests[msg.id];
			if (msg.success) pending.resolve(msg.payload);
			else pending.reject(msg.payload);
		}
	}
}
