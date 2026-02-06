// Type declarations for Electrobun preload globals
// These are set dynamically per-webview before the preload script runs

declare global {
	interface Window {
		__electrobunWebviewId: number;
		__electrobunWindowId: number;
		__electrobunRpcSocketPort: number;
		__electrobunSecretKeyBytes: number[];
		__electrobunInternalBridge?: {
			postMessage: (message: string) => void;
		};
		__electrobunBunBridge?: {
			postMessage: (message: string) => void;
		};
		__electrobun_encrypt: (
			plaintext: string,
		) => Promise<{ encryptedData: string; iv: string; tag: string }>;
		__electrobun_decrypt: (
			encryptedData: string,
			iv: string,
			tag: string,
		) => Promise<string>;
		__electrobunSendToHost: (message: unknown) => void;
		__electrobun: {
			receiveMessageFromBun: (msg: unknown) => void;
			receiveInternalMessageFromBun: (msg: unknown) => void;
		};
	}
}

export {};
