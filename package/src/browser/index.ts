import {
	type RPCSchema,
	type RPCTransport,
	type ElectrobunRPCSchema,
	type ElectrobunRPCConfig,
	type RPCWithTransport,
	createRPC,
	defineElectrobunRPC,
} from "../shared/rpc.js";
import {
	type WebviewTagElement,
	type WebviewEventTypes,
} from "./webviewtag";
import "./global.d.ts";

const WEBVIEW_ID = window.__electrobunWebviewId;
const RPC_SOCKET_PORT = window.__electrobunRpcSocketPort;

class Electroview<T extends RPCWithTransport> {
	bunSocket?: WebSocket;
	// user's custom rpc browser <-> bun
	rpc?: T;
	rpcHandler?: (msg: unknown) => void;

	constructor(config: { rpc: T }) {
		this.rpc = config.rpc;
		this.init();
	}

	init() {
		this.initSocketToBun();

		// Set up handler for user RPC messages from bun
		// Note: receiveInternalMessageFromBun is set up by the preload script
		window.__electrobun!.receiveMessageFromBun =
			this.receiveMessageFromBun.bind(this);

		if (this.rpc) {
			this.rpc.setTransport(this.createTransport());
		}
	}

	initSocketToBun() {
		// Note: Using ws:// for localhost is intentional - all RPC messages are
		// encrypted with per-webview AES-GCM keys, making TLS redundant
		const socket = new WebSocket(
			`ws://localhost:${RPC_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`,
		);

		this.bunSocket = socket;

		socket.addEventListener("open", () => {
			// this.bunSocket?.send("Hello from webview " + WEBVIEW_ID);
		});

		socket.addEventListener("message", async (event) => {
			const message = event.data;
			if (typeof message === "string") {
				try {
					const encryptedPacket = JSON.parse(message);

					const decrypted = await window.__electrobun_decrypt(
						encryptedPacket.encryptedData,
						encryptedPacket.iv,
						encryptedPacket.tag,
					);

					this.rpcHandler?.(JSON.parse(decrypted));
				} catch (err) {
					console.error("Error parsing bun message:", err);
				}
			} else if (message instanceof Blob) {
				// Handle binary data (e.g., convert Blob to ArrayBuffer if needed)
			} else {
				console.error("UNKNOWN DATA TYPE RECEIVED:", event.data);
			}
		});

		socket.addEventListener("error", (event) => {
			console.error("Socket error:", event);
		});

		socket.addEventListener("close", (_event) => {
			// console.log("Socket closed:", event);
		});
	}

	createTransport(): RPCTransport {
		const that = this;
		return {
			send(message: unknown) {
				try {
					const messageString = JSON.stringify(message);
					that.bunBridge(messageString);
				} catch (error) {
					console.error("bun: failed to serialize message to webview", error);
				}
			},
			registerHandler(handler: (msg: unknown) => void) {
				that.rpcHandler = handler;
			},
		};
	}

	async bunBridge(msg: string) {
		if (this.bunSocket?.readyState === WebSocket.OPEN) {
			try {
				const { encryptedData, iv, tag } =
					await window.__electrobun_encrypt(msg);

				const encryptedPacket = {
					encryptedData: encryptedData,
					iv: iv,
					tag: tag,
				};
				const encryptedPacketString = JSON.stringify(encryptedPacket);
				this.bunSocket.send(encryptedPacketString);
				return;
			} catch (error) {
				console.error("Error sending message to bun via socket:", error);
			}
		}

		// if socket's are unavailable, fallback to postMessage
		window.__electrobunBunBridge?.postMessage(msg);
	}

	receiveMessageFromBun(msg: unknown) {
		// NOTE: in the webview messages are passed by executing ElectrobunView.receiveMessageFromBun(object)
		// so they're already parsed into an object here
		if (this.rpcHandler) {
			this.rpcHandler(msg);
		}
	}
	static defineRPC<Schema extends ElectrobunRPCSchema>(
		config: ElectrobunRPCConfig<Schema, "webview">,
	) {
		return defineElectrobunRPC("webview", {
			...config,
			extraRequestHandlers: {
				evaluateJavascriptWithResponse: ({ script }: { script: string }) => {
					return new Promise((resolve) => {
						try {
							const resultFunction = new Function(script);
							const result = resultFunction();

							if (result instanceof Promise) {
								result
									.then((resolvedResult) => {
										resolve(resolvedResult);
									})
									.catch((error) => {
										console.error("bun: async script execution failed", error);
										resolve(String(error));
									});
							} else {
								resolve(result);
							}
						} catch (error) {
							console.error("bun: failed to eval script", error);
							resolve(String(error));
						}
					});
				},
			},
		});
	}
}

export {
	type RPCSchema,
	type ElectrobunRPCSchema,
	type ElectrobunRPCConfig,
	createRPC,
	Electroview,
	type WebviewTagElement,
	type WebviewEventTypes,
};

const Electrobun = {
	Electroview,
};

export default Electrobun;
