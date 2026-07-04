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
import { type WgpuTagElement, type WgpuEventTypes } from "./wgputag";
import "./global.d.ts";

const WEBVIEW_ID = window.__electrobunWebviewId;
const HOST_SOCKET_PORT =
	window.__electrobunHostSocketPort ?? window.__electrobunRpcSocketPort;

class Electroview<T extends RPCWithTransport> {
	hostSocket?: WebSocket;
	hostSocketCanSend = false;
	pendingHostSocketMessages: string[] = [];
	flushingHostSocketMessages = false;
	// user's custom rpc browser <-> bun
	rpc?: T;
	rpcHandler?: (msg: unknown) => void;
	carrots = {
		invoke: <R = unknown>(
			carrotId: string,
			method: string,
			params?: unknown,
			options?: { windowId?: string },
		) => this.invokeCarrot<R>(carrotId, method, params, options),
	};

	constructor(config: { rpc: T }) {
		this.rpc = config.rpc;
		this.init();
	}

	init() {
		this.initSocketToHost();

		// Set up handler for user RPC messages from the host runtime.
		const hostMessageHandler = this.receiveMessageFromHost.bind(this);
		window.__electrobun!.receiveMessageFromHost = hostMessageHandler;
		window.__electrobun!.receiveMessageFromBun = hostMessageHandler;

		if (this.rpc) {
			this.rpc.setTransport(this.createTransport());
		}

		const pendingMessages = window.__electrobunPendingHostMessages;
		if (pendingMessages?.length) {
			window.__electrobunPendingHostMessages = [];
			for (const message of pendingMessages) {
				hostMessageHandler(message);
			}
		}
	}

	initSocketToHost() {
		// Skip native socket when running in a remote browser (no port/webview ID)
		if (!HOST_SOCKET_PORT || !WEBVIEW_ID) {
			return;
		}

		// Note: Using ws:// for loopback is intentional - all RPC messages are
		// encrypted with per-webview AES-GCM keys, making TLS redundant
		const socket = new WebSocket(
			`ws://127.0.0.1:${HOST_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`,
		);

		this.hostSocket = socket;

		socket.addEventListener("open", () => {
			this.hostSocketCanSend = true;
			void this.flushPendingHostSocketMessages();
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

					this.hostSocketCanSend = true;
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
			this.hostSocketCanSend = false;
			console.error("Socket error:", event);
		});

		socket.addEventListener("close", (_event) => {
			this.hostSocketCanSend = false;
			this.pendingHostSocketMessages = [];
			// console.log("Socket closed:", event);
		});
	}

	createTransport(): RPCTransport {
		const that = this;
		return {
			send(message: unknown) {
				try {
					const messageString = JSON.stringify(message);
					that.sendMessageToHost(messageString);
				} catch (error) {
					console.error("host: failed to serialize message to webview", error);
				}
			},
			registerHandler(handler: (msg: unknown) => void) {
				that.rpcHandler = handler;
			},
		};
	}

	async sendMessageToHost(msg: string) {
		if (this.canSendToHostSocket()) {
			if (await this.sendMessageToHostSocket(msg)) {
				return;
			}
		}

		if (this.hostSocket?.readyState === WebSocket.CONNECTING) {
			this.pendingHostSocketMessages.push(msg);
			return;
		}

		// if socket's are unavailable, fallback to postMessage
		window.__electrobunHostBridge?.postMessage(msg);
	}

	canSendToHostSocket() {
		return (
			this.hostSocketCanSend &&
			this.hostSocket?.readyState === WebSocket.OPEN
		);
	}

	async sendMessageToHostSocket(msg: string) {
		if (!this.canSendToHostSocket()) {
			return false;
		}

		try {
			const { encryptedData, iv, tag } =
				await window.__electrobun_encrypt(msg);

			const encryptedPacket = {
				encryptedData: encryptedData,
				iv: iv,
				tag: tag,
			};
			const encryptedPacketString = JSON.stringify(encryptedPacket);
			this.hostSocket!.send(encryptedPacketString);
			return true;
		} catch (error) {
			console.error("Error sending message to host via socket:", error);
			return false;
		}
	}

	async flushPendingHostSocketMessages() {
		if (this.flushingHostSocketMessages) {
			return;
		}

		this.flushingHostSocketMessages = true;
		try {
			while (
				this.pendingHostSocketMessages.length > 0 &&
				this.canSendToHostSocket()
			) {
				const message = this.pendingHostSocketMessages[0]!;
				if (!(await this.sendMessageToHostSocket(message))) {
					return;
				}
				this.pendingHostSocketMessages.shift();
			}
		} finally {
			this.flushingHostSocketMessages = false;
		}
	}

	receiveMessageFromHost(msg: unknown) {
		// NOTE: in the webview messages are passed by executing window.__electrobun.receiveMessageFromHost(object)
		// so they're already parsed into an object here
		if (this.rpcHandler) {
			this.rpcHandler(msg);
		}
	}

	async invokeCarrot<R = unknown>(
		carrotId: string,
		method: string,
		params?: unknown,
		options?: { windowId?: string },
	): Promise<R> {
		const requestProxy = (this.rpc as any)?.request;
		if (!requestProxy || typeof requestProxy.invokeCarrot !== "function") {
			throw new Error("Renderer carrot invocation is not available in this Electrobun host.");
		}
		return requestProxy.invokeCarrot({
			carrotId,
			method,
			params,
			windowId: options?.windowId,
		}) as Promise<R>;
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
	type WgpuTagElement,
	type WgpuEventTypes,
};

const Electrobun = {
	Electroview,
};

export default Electrobun;
