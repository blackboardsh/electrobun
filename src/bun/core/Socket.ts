import type { ServerWebSocket } from "bun";
import { BrowserView } from "./BrowserView";

const AUTH_TOKEN = "secret";

export const socketMap: {
  [webviewId: string]: {
    socket: null | ServerWebSocket<unknown>;
    queue: string[];
  };
} = {};

const startRPCServer = () => {
  const startPort = 50000;
  const endPort = 65535;
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
        //   tls: {
        //     key: Bun.file("key.pem"),
        //     cert: Bun.file("cert.pem"),
        //   },

        websocket: {
          idleTimeout: 960,
          maxPayloadLength: 1024 * 1024 * 500, // 500MB
          //   backpressureLimit: Infinity,
          open(ws) {
            const { webviewId } = ws.data;

            if (!socketMap[webviewId]) {
              socketMap[webviewId] = { socket: ws, queue: [] };
            } else {
              socketMap[webviewId].socket = ws;
            }
          },
          close(ws, code, reason) {
            const { webviewId } = ws.data;
            console.log("Closed:", webviewId, code, reason);
            socketMap[webviewId].socket = null;
          },

          message(ws, message) {
            const { webviewId } = ws.data;
            const browserView = BrowserView.getById(webviewId);

            if (browserView.rpcHandler) {
              if (typeof message === "string") {
                try {
                  browserView.rpcHandler(JSON.parse(message));
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

  if (rpc?.socket?.readyState === WebSocket.OPEN) {
    try {
      rpc.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error("Error sending message to webview via socket:", error);
    }
  }

  return false;
};

console.log("Server started at", rpcServer?.url.origin);
