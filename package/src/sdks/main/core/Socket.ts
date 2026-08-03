import { ffi } from "../proc/native";

export const removeSocketForWebview = (webviewId: number) => {
	ffi.request.clearWebviewHostTransport({ id: webviewId });
};

// Will return true if message was sent over the core-owned websocket transport.
// False means the caller should fall back to the native bridge / evaluateJS path.
export const sendMessageToWebviewViaSocket = (
	webviewId: number,
	message: unknown,
): boolean => {
	try {
		return ffi.request.sendHostMessageToWebviewViaTransport({
			id: webviewId,
			messageJson: JSON.stringify(message),
		}) as boolean;
	} catch (error) {
		console.error("Error sending message to webview via host transport:", error);
		return false;
	}
};
