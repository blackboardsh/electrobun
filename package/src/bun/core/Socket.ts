import type { Server, ServerWebSocket } from "bun";
import { BrowserView } from "./BrowserView";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export type RpcTransport = "auto" | "websocket" | "postMessage";

function base64ToUint8Array(base64: string) {
	{
		return new Uint8Array(
			atob(base64)
				.split("")
				.map((char) => char.charCodeAt(0)),
		);
	}
}

// Encrypt function
function encrypt(secretKey: Uint8Array, text: string) {
	const iv = new Uint8Array(randomBytes(12)); // IV for AES-GCM
	const cipher = createCipheriv("aes-256-gcm", secretKey, iv);
	const encrypted = Buffer.concat([
		new Uint8Array(cipher.update(text, "utf8")),
		new Uint8Array(cipher.final()),
	]).toString("base64");
	const tag = cipher.getAuthTag().toString("base64");
	return { encrypted, iv: Buffer.from(iv).toString("base64"), tag };
}

// Decrypt function
function decrypt(
	secretKey: Uint8Array,
	encryptedData: Uint8Array,
	iv: Uint8Array,
	tag: Uint8Array,
) {
	const decipher = createDecipheriv("aes-256-gcm", secretKey, iv);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([
		new Uint8Array(decipher.update(encryptedData)),
		new Uint8Array(decipher.final()),
	]);
	return decrypted.toString("utf8");
}

export const socketMap: {
	[webviewId: string]: {
		socket: null | ServerWebSocket<unknown>;
		queue: string[];
	};
} = {};

export const removeSocketForWebview = (webviewId: number) => {
	const rpc = socketMap[webviewId];
	if (!rpc) return;

	rpc.socket = null;
	delete socketMap[webviewId];
};

const validRpcTransports: RpcTransport[] = ["auto", "websocket", "postMessage"];

const normalizeRpcTransport = (transport: unknown): RpcTransport => {
	if (Bun.env["ELECTROBUN_DISABLE_RPC_SOCKET"] === "1") {
		return "postMessage";
	}

	const envTransport = Bun.env["ELECTROBUN_RPC_TRANSPORT"];
	if (validRpcTransports.includes(envTransport as RpcTransport)) {
		return envTransport as RpcTransport;
	}

	if (validRpcTransports.includes(transport as RpcTransport)) {
		return transport as RpcTransport;
	}

	return "auto";
};

let currentRpcTransport: RpcTransport = normalizeRpcTransport(undefined);
export let rpcServer: Server<unknown> | null = null;
export let rpcPort = 0;

const startRPCServer = () => {
	const startPort = 50000;
	const endPort = 65535;
	const payloadLimit = 1024 * 1024 * 500; // 500MB
	let port = startPort;
	let server = null;

	while (port <= endPort) {
		try {
			server = Bun.serve<{ webviewId: number }>({
				hostname: "127.0.0.1",
				port,
				fetch(req: Request, server: Server<{ webviewId: number }>) {
					const url = new URL(req.url);
					//   const token = new URL(req.url).searchParams.get("token");
					//   if (token !== AUTH_TOKEN)
					//     return new Response("Unauthorized", { status: 401 });
					//   console.log("fetch!!", url.pathname);
					if (url.pathname === "/socket") {
						const webviewIdString = url.searchParams.get("webviewId");
						if (!webviewIdString) {
							return new Response("Missing webviewId", { status: 400 });
						}
						const webviewId = parseInt(webviewIdString, 10);
						const success = server.upgrade(req, { data: { webviewId } });
						return success
							? undefined
							: new Response("Upgrade failed", { status: 500 });
					}

					console.log("unhandled RPC Server request", req.url);
				},
				websocket: {
					idleTimeout: 960,
					// 500MB max payload should be plenty
					maxPayloadLength: payloadLimit,
					// Anything beyond the backpressure limit will be dropped
					backpressureLimit: payloadLimit * 2,
					open(ws: ServerWebSocket<{ webviewId: number }>) {
						if (!ws?.data) {
							return;
						}
						const { webviewId } = ws.data;

						if (!socketMap[webviewId]) {
							socketMap[webviewId] = { socket: ws, queue: [] };
						} else {
							socketMap[webviewId].socket = ws;
						}
					},
					close(ws: ServerWebSocket<{ webviewId: number }>, _code: number, _reason: string) {
						if (!ws?.data) {
							return;
						}
						const { webviewId } = ws.data;
						// console.log("Closed:", webviewId, code, reason);
						if (socketMap[webviewId]) {
							socketMap[webviewId].socket = null;
						}
					},

					message(ws: ServerWebSocket<{ webviewId: number }>, message: string | Buffer) {
						if (!ws?.data) {
							return;
						}
						const { webviewId } = ws.data;
						const browserView = BrowserView.getById(webviewId);
						if (!browserView) {
							return;
						}

						if (browserView.rpcHandler) {
							if (typeof message === "string") {
								try {
									const encryptedPacket = JSON.parse(message);
									const decrypted = decrypt(
										browserView.secretKey,
										base64ToUint8Array(encryptedPacket.encryptedData),
										base64ToUint8Array(encryptedPacket.iv),
										base64ToUint8Array(encryptedPacket.tag),
									);

									// Note: At this point the secretKey for the webview id would
									// have had to match the encrypted packet data, so we can trust
									// that this message can be passed to this browserview's rpc
									// methods.
									browserView.rpcHandler(JSON.parse(decrypted));
								} catch (error) {
									console.log("Error handling message:", error);
								}
							} else if (message instanceof ArrayBuffer) {
								console.log("TODO: Received ArrayBuffer message:", message);
							}
						}
					},
				},
			});

			break;
		} catch (error: any) {
			if (error.code === "EADDRINUSE") {
				console.log(`Port ${port} in use, trying next port...`);
				port++;
			} else {
				throw error;
			}
		}
	}

	return { rpcServer: server, rpcPort: port };
};

export const ensureRPCServer = (transport?: unknown) => {
	currentRpcTransport = normalizeRpcTransport(transport);

	if (currentRpcTransport === "postMessage") {
		rpcServer = null;
		rpcPort = 0;
		console.log("Electrobun RPC socket disabled; using postMessage bridge.");
		return { rpcServer, rpcPort };
	}

	if (!rpcServer) {
		const serverState = startRPCServer();
		rpcServer = serverState.rpcServer;
		rpcPort = serverState.rpcPort;
		console.log("Server started at", rpcServer?.url.origin);
	}

	return { rpcServer, rpcPort };
};

// Will return true if message was sent over websocket
// false if it was not (caller should fallback to postMessage/evaluateJS rpc)
export const sendMessageToWebviewViaSocket = (
	webviewId: number,
	message: any,
): boolean => {
	const rpc = socketMap[webviewId];
	const browserView = BrowserView.getById(webviewId);

	if (!browserView) return false;

	if (rpc?.socket?.readyState === WebSocket.OPEN) {
		try {
			const unencryptedString = JSON.stringify(message);
			const encrypted = encrypt(browserView.secretKey, unencryptedString);

			const encryptedPacket = {
				encryptedData: encrypted.encrypted,
				iv: encrypted.iv,
				tag: encrypted.tag,
			};

			const encryptedPacketString = JSON.stringify(encryptedPacket);

			rpc.socket.send(encryptedPacketString);
			return true;
		} catch (error) {
			console.error("Error sending message to webview via socket:", error);
		}
	}

	return false;
};
