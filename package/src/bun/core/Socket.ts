import type { ServerWebSocket } from "bun";
import { BrowserView } from "./BrowserView";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

function base64ToUint8Array(base64: string) {
  {
    return new Uint8Array(
      atob(base64)
        .split("")
        .map((char) => char.charCodeAt(0))
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
  tag: Uint8Array
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

const startRPCServer = () => {
  const startPort = 50000;
  const endPort = 65535;
  const payloadLimit = 1024 * 1024 * 500; // 500MB
  let port = startPort;
  let server = null;

  while (port <= endPort) {
    try {
      server = Bun.serve<{ webviewId: number }>({
        port,
        fetch(req, server) {
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
          open(ws) {
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
          close(ws, code, reason) {
            if (!ws?.data) {
              return;
            }
            const { webviewId } = ws.data;
            // console.log("Closed:", webviewId, code, reason);
            if (socketMap[webviewId]) {
              socketMap[webviewId].socket = null;
            }
          },

          message(ws, message) {
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
                    base64ToUint8Array(encryptedPacket.tag)
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

export const { rpcServer, rpcPort } = startRPCServer();

// Will return true if message was sent over websocket
// false if it was not (caller should fallback to postMessage/evaluateJS rpc)
export const sendMessageToWebviewViaSocket = (
  webviewId: number,
  message: any
): boolean => {
  const rpc = socketMap[webviewId];
  const browserView = BrowserView.getById(webviewId);

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

console.log("Server started at", rpcServer?.url.origin);
