import {
	type RPCSchema,
	type RPCTransport,
	type RPCRequestOptions,
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

type QueuedHostMessage = {
	message: string;
	markSent: () => void;
};

type SettledHostMessage =
	| { status: "fulfilled"; value: unknown }
	| { status: "rejected"; reason: unknown };

class Electroview<T extends RPCWithTransport> {
	hostSocket?: WebSocket;
	hostSocketCanSend = false;
	pendingHostSocketMessages: QueuedHostMessage[] = [];
	flushingHostSocketMessages = false;
	hostSocketSendQueue: QueuedHostMessage[] = [];
	flushingHostSocketSendQueue = false;
	linuxHostSocketDispatchTail: Promise<void> = Promise.resolve();
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
					const packet = JSON.parse(message);
					this.hostSocketCanSend = true;
					if (
						typeof packet?.encryptedData === "string" &&
						typeof packet?.iv === "string" &&
						typeof packet?.tag === "string"
					) {
						if (window.__electrobunPlatform === "linux") {
							const decodedMessage = window
								.__electrobun_decrypt(
									packet.encryptedData,
									packet.iv,
									packet.tag,
								)
								.then((decrypted) => JSON.parse(decrypted));
							this.queueLinuxHostSocketDispatch(decodedMessage);
							return;
						}
						const decrypted = await window.__electrobun_decrypt(
							packet.encryptedData,
							packet.iv,
							packet.tag,
						);
						this.rpcHandler?.(JSON.parse(decrypted));
					} else {
						this.rpcHandler?.(packet);
					}
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
			this.flushHostMessagesViaFallback(this.pendingHostSocketMessages);
			this.flushHostMessagesViaFallback(this.hostSocketSendQueue);
			// console.log("Socket closed:", event);
		});
	}

	queueLinuxHostSocketDispatch(decodedMessage: Promise<unknown>) {
		// Start WebCrypto work as each frame arrives, but dispatch in frame order.
		// Attaching both handlers immediately also prevents delayed rejections from
		// being reported as unhandled while an earlier frame is still decrypting.
		const settledMessage: Promise<SettledHostMessage> = decodedMessage.then(
			(value) => ({ status: "fulfilled", value }),
			(reason) => ({ status: "rejected", reason }),
		);

		this.linuxHostSocketDispatchTail = this.linuxHostSocketDispatchTail
			.then(async () => {
				const result = await settledMessage;
				if (result.status === "rejected") {
					console.error("Error parsing bun message:", result.reason);
					return;
				}
				this.rpcHandler?.(result.value);
			})
			.catch((err) => {
				// Keep a single bad frame or handler from poisoning the dispatch tail.
				console.error("Error parsing bun message:", err);
			});
	}

	createTransport(): RPCTransport {
		const that = this;
		return {
			send(message: unknown) {
				try {
					const messageString = JSON.stringify(message);
					return that.sendMessageToHost(messageString);
				} catch (error) {
					console.error("host: failed to serialize message to webview", error);
				}
			},
			registerHandler(handler: (msg: unknown) => void) {
				that.rpcHandler = handler;
			},
		};
	}

	sendMessageToHost(msg: string): Promise<void> {
		return new Promise((markSent) => {
			const queuedMessage = { message: msg, markSent };

			if (this.canSendToHostSocket()) {
				this.hostSocketSendQueue.push(queuedMessage);
				void this.flushHostSocketSendQueue();
				return;
			}

			if (this.hostSocket?.readyState === WebSocket.CONNECTING) {
				this.pendingHostSocketMessages.push(queuedMessage);
				return;
			}

			// If sockets are unavailable, hand the packet to the native bridge.
			this.sendMessageToHostViaFallback(queuedMessage);
		});
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
			if (window.__electrobunPlaintextHostSocket) {
				this.hostSocket!.send(msg);
				return true;
			}
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

	sendMessageToHostViaFallback(queuedMessage: QueuedHostMessage) {
		try {
			window.__electrobunHostBridge?.postMessage(queuedMessage.message);
		} catch (error) {
			console.error("Error sending message to host via native bridge:", error);
		} finally {
			queuedMessage.markSent();
		}
	}

	flushHostMessagesViaFallback(queue: QueuedHostMessage[]) {
		while (queue.length > 0) {
			this.sendMessageToHostViaFallback(queue.shift()!);
		}
	}

	async flushHostSocketSendQueue() {
		if (this.flushingHostSocketSendQueue) {
			return;
		}

		this.flushingHostSocketSendQueue = true;
		try {
			while (
				this.hostSocketSendQueue.length > 0 &&
				this.canSendToHostSocket()
			) {
				const queuedMessage = this.hostSocketSendQueue[0]!;
				this.hostSocketSendQueue.shift();
				if (!(await this.sendMessageToHostSocket(queuedMessage.message))) {
					this.sendMessageToHostViaFallback(queuedMessage);
				} else {
					queuedMessage.markSent();
				}
			}
		} finally {
			this.flushingHostSocketSendQueue = false;
		}
	}

	async flushPendingHostSocketMessages() {
		if (this.flushingHostSocketMessages) {
			return;
		}

		this.flushingHostSocketMessages = true;
		try {
			while (this.pendingHostSocketMessages.length > 0) {
				const queuedMessage = this.pendingHostSocketMessages.shift()!;
				this.hostSocketSendQueue.push(queuedMessage);
			}
			await this.flushHostSocketSendQueue();
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
	type RPCRequestOptions,
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
