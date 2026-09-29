export type AcceptanceRPC = {
	bun: {
		requests: { challenge: { params: { text: string }; response: string } };
		messages: { complete: { token: string; text: string } };
	};
	webview: { requests: {}; messages: {} };
};
