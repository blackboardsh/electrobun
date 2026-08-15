import { ffi } from "../proc/native";
import { encryptHostTransportPacket } from "./hostTransportEncryption";

export const removeSocketForWebview = (webviewId: number) => {
	ffi.request.clearWebviewHostTransport({ id: webviewId });
};

// Will return true if message was sent over the core-owned websocket transport.
// False means the caller should fall back to the native bridge / evaluateJS path.
export const sendMessageToWebviewViaSocket = (
	webviewId: number,
	message: unknown,
	secretKey?: Uint8Array,
): boolean => {
	try {
		const messageJson = JSON.stringify(message);
		if (process.platform === "linux" && secretKey?.byteLength === 32) {
			const encryptedPacket = encryptHostTransportPacket(messageJson, secretKey);
			if (
				ffi.request.sendPreEncryptedHostMessageToWebviewViaTransport({
					id: webviewId,
					encryptedPacketJson: JSON.stringify(encryptedPacket),
				}) as boolean
			) {
				return true;
			}
		}

		return ffi.request.sendHostMessageToWebviewViaTransport({
			id: webviewId,
			messageJson,
		}) as boolean;
	} catch (error) {
		console.error("Error sending message to webview via host transport:", error);
		return false;
	}
};
