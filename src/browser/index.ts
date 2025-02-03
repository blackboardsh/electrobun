import {
  type RPCSchema,
  type RPCRequestHandler,
  type RPCOptions,
  type RPCMessageHandlerFn,
  type WildcardRPCMessageHandlerFn,
  type RPCTransport,
  createRPC,
} from "rpc-anywhere";
import { ConfigureWebviewTags } from "./webviewtag";
// todo: should this just be injected as a preload script?
import { isAppRegionDrag } from "./stylesAndElements";
import type { BuiltinBunToWebviewSchema } from "./builtinrpcSchema";

interface ElectrobunWebviewRPCSChema {
  bun: RPCSchema;
  webview: RPCSchema;
}

const WEBVIEW_ID = window.__electrobunWebviewId;
const WINDOW_ID = window.__electrobunWindowId;
const RPC_SOCKET_PORT = window.__electrobunRpcSocketPort;

// todo (yoav): move this stuff to browser/rpc/webview.ts
type ZigWebviewHandlers = RPCSchema<{
  requests: {
    webviewTagCallAsyncJavaScript: {
      params: {
        messageId: string;
        webviewId: number;
        hostWebviewId: number;
        script: string;
      };
      response: void;
    };
  };
}>;

type WebviewTagHandlers = RPCSchema<{
  requests: {};
  messages: {
    webviewTagResize: {
      id: number;
      frame: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      masks: string;
    };
    webviewTagUpdateSrc: {
      id: number;
      url: string;
    };
    webviewTagUpdateHtml: {
      id: number;
      html: string;
    }
    webviewTagGoBack: {
      id: number;
    };
    webviewTagGoForward: {
      id: number;
    };
    webviewTagReload: {
      id: number;
    };
    webviewTagRemove: {
      id: number;
    };
    startWindowMove: {
      id: number;
    };
    stopWindowMove: {
      id: number;
    };
    moveWindowBy: {
      id: number;
      x: number;
      y: number;
    };
    webviewTagSetTransparent: {
      id: number;
      transparent: boolean;
    };
    webviewTagSetPassthrough: {
      id: number;
      enablePassthrough: boolean;
    };
    webviewTagSetHidden: {
      id: number;
      hidden: boolean;
    };
  };
}>;

class Electroview<T> {
  bunSocket?: WebSocket;
  // user's custom rpc browser <-> bun
  rpc?: T;
  rpcHandler?: (msg: any) => void;
  // electrobun rpc browser <-> zig
  zigRpc?: any;
  zigRpcHandler?: (msg: any) => void;
  // give it a default function
  syncRpc: (params: any) => any = () => {
    console.log("syncRpc not initialized");
  };

  constructor(config: { rpc: T }) {
    this.rpc = config.rpc;
    this.init();
  }

  init() {
    // todo (yoav): should init webviewTag by default when src is local
    // and have a setting that forces it enabled or disabled
    this.initZigRpc();
    this.initSocketToBun();
    // Note:
    // syncRPC messages doesn't need to be defined since there's no need for sync 1-way message
    // just use non-blocking async rpc for that, we just need sync requests
    // We don't need request ids either since we're not receiving the response on a different pipe
    if (true) {
      // TODO: define sync requests on schema (separate from async reqeusts and messages)
      // this.syncRpc = (msg: { method: string; params: any }) => {
      //   try {
      //     const messageString = JSON.stringify(msg);
      //     return this.bunBridge(messageString);
      //   } catch (error) {
      //     console.error(
      //       "bun: failed to serialize message to webview syncRpc",
      //       error
      //     );
      //   }
      // };
    }
    ConfigureWebviewTags(true, this.zigRpc, this.rpc);

    this.initElectrobunListeners();

    window.__electrobun = {
      receiveMessageFromBun: this.receiveMessageFromBun.bind(this),
      receiveMessageFromZig: this.receiveMessageFromZig.bind(this),
    };

    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }

  initZigRpc() {
    this.zigRpc = createRPC<WebviewTagHandlers, ZigWebviewHandlers>({
      transport: this.createZigTransport(),
      // requestHandler: {

      // },
      maxRequestTime: 1000,
    });
  }

  initSocketToBun() {
    // todo: upgrade to tls
    const socket = new WebSocket(
      `ws://localhost:${RPC_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`
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
            encryptedPacket.tag
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

    socket.addEventListener("close", (event) => {
      // console.log("Socket closed:", event);
    });
  }

  // This will be attached to the global object, zig can rpc reply by executingJavascript
  // of that global reference to the function
  receiveMessageFromZig(msg: any) {
    if (this.zigRpcHandler) {
      this.zigRpcHandler(msg);
    }
  }

  // TODO: implement proper rpc-anywhere style rpc here
  // todo: this is duplicated in webviewtag.ts and should be DRYed up
  sendToZig(message: {}) {    
    if (window.webkit?.messageHandlers?.webviewTagBridge) {
      window.webkit.messageHandlers.webviewTagBridge.postMessage(
        JSON.stringify(message)
      );
    } else {
      window.webviewTagBridge.postMessage(
        JSON.stringify(message)
      );
    }
  }

  initElectrobunListeners() {
    document.addEventListener("mousedown", (e) => {
      if (isAppRegionDrag(e)) {
        this.zigRpc?.send.startWindowMove({ id: WINDOW_ID });
      }
    });

    document.addEventListener("mouseup", (e) => {
      if (isAppRegionDrag(e)) {
        this.zigRpc?.send.stopWindowMove({ id: WINDOW_ID });
      }
    });
  }

  createTransport() {
    const that = this;
    return {
      send(message) {
        try {
          const messageString = JSON.stringify(message);
          // console.log("sending message bunbridge", messageString);
          that.bunBridge(messageString);
        } catch (error) {
          console.error("bun: failed to serialize message to webview", error);
        }
      },
      registerHandler(handler) {
        that.rpcHandler = handler;
      },
    };
  }

  // todo: just use with sendToZig();
  createZigTransport(): RPCTransport {
    const that = this;
    return {
      send(message) {             
        if (window.webkit?.messageHandlers?.webviewTagBridge) {
          window.webkit.messageHandlers.webviewTagBridge.postMessage(
            JSON.stringify(message)
          );
        } else {
          window.webviewTagBridge.postMessage(
            JSON.stringify(message)
          );
        }
      },
      registerHandler(handler) {
        that.zigRpcHandler = handler;
        // webview tag doesn't handle any messages from zig just yet
      },
    };
  }

  // call any of your bun syncrpc methods in a way that appears synchronous from the browser context
  bunBridgeSync(msg: string) {
    console.warn("DEPRECATED: use async rpc if possible");
    var xhr = new XMLHttpRequest();
    // Note: setting false here makes the xhr request blocking. This completely
    // blocks the main thread which is terrible. You can use this safely from a webworker.
    // There are also cases where exposing bun sync apis (eg: existsSync) is useful especially
    // on a first pass when migrating from Electron to Electrobun.
    // This mechanism is designed to make any rpc call over the bridge into a sync blocking call
    // from the browser context while bun asynchronously replies. Use it sparingly from the main thread.
    xhr.open("POST", "views://syncrpc", false); // Synchronous call
    xhr.send(msg);
    if (!xhr.responseText) {
      return xhr.responseText;
    }

    try {
      return JSON.parse(xhr.responseText);
    } catch {
      return xhr.responseText;
    }
  }

  async bunBridge(msg: string) {
    if (this.bunSocket?.readyState === WebSocket.OPEN) {
      try {
        const { encryptedData, iv, tag } = await window.__electrobun_encrypt(
          msg
        );

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

    // Note: messageHandlers seem to freeze when sending large messages
    // but xhr to views://rpc can run into CORS issues on non views://
    // loaded content (eg: when writing extensions/preload scripts for
    // remote content).

    // Since most messages--especially those on remote content, are small
    // we can solve most use cases by having a fallback to xhr for
    // large messages

    // TEMP: disable the fallback for now. for some reason suddenly can't
    // repro now that other places are chunking messages and laptop restart

    if (true || msg.length < 8 * 1024) {      
      if (window.webkit?.messageHandlers?.bunBridge){
        window.webkit.messageHandlers.bunBridge.postMessage(msg);
      } else {
        window.bunBridge.postMessage(msg);
      }
    } else {
      var xhr = new XMLHttpRequest();

      // Note: we're only using synchronouse http on this async
      // call to get around CORS for now
      // Note: DO NOT use postMessage handlers since it
      // freezes the process when sending lots of large messages

      xhr.open("POST", "views://rpc", false); // sychronous call
      xhr.send(msg);
    }
  }

  receiveMessageFromBun(msg) {
    // NOTE: in the webview messages are passed by executing ElectrobunView.receiveMessageFromBun(object)
    // so they're already parsed into an object here
    if (this.rpcHandler) {
      this.rpcHandler(msg);
    }
  }
  // todo (yoav): This is mostly just the reverse of the one in BrowserView.ts on the bun side. Should DRY this up.
  static defineRPC<
    Schema extends ElectrobunWebviewRPCSChema,
    BunSchema extends RPCSchema = Schema["bun"],
    WebviewSchema extends RPCSchema = Schema["webview"]
  >(config: {
    maxRequestTime?: number;
    handlers: {
      requests?: RPCRequestHandler<WebviewSchema["requests"]>;
      messages?: {
        [key in keyof WebviewSchema["messages"]]: RPCMessageHandlerFn<
          WebviewSchema["messages"],
          key
        >;
      } & {
        "*"?: WildcardRPCMessageHandlerFn<WebviewSchema["messages"]>;
      };
    };
  }) {
    // Note: RPC Anywhere requires defining the requests that a schema handles and the messages that a schema sends.
    // eg: BunSchema {
    //   requests: // ... requests bun handles, sent by webview
    //   messages: // ... messages bun sends, handled by webview
    // }
    // In some generlized contexts that makes sense,
    // In the Electrobun context it can feel a bit counter-intuitive so we swap this around a bit. In Electrobun, the
    // webview and bun are known endpoints so we simplify schema definitions by combining them.
    // Schema {
    //   bun: BunSchema {
    //      requests: // ... requests bun sends, handled by webview,
    //      messages: // ... messages bun sends, handled by webview
    //    },
    //   webview: WebviewSchema {
    //      requests: // ... requests webview sends, handled by bun,
    //      messages: // ... messages webview sends, handled by bun
    //    },
    // }
    // electrobun also treats messages as "requests that we don't wait for to complete", and normalizes specifying the
    // handlers for them alongside request handlers.

    const builtinHandlers: {
      requests: RPCRequestHandler<BuiltinBunToWebviewSchema["requests"]>;
    } = {
      requests: {
        evaluateJavascriptWithResponse: ({ script }) => {
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
    };

    type mixedWebviewSchema = {
      requests: BunSchema["requests"];
      messages: WebviewSchema["messages"];
    };

    type mixedBunSchema = {
      requests: WebviewSchema["requests"] &
        BuiltinBunToWebviewSchema["requests"];
      messages: BunSchema["messages"];
    };

    const rpcOptions = {
      maxRequestTime: config.maxRequestTime,
      requestHandler: {
        ...config.handlers.requests,
        ...builtinHandlers.requests,
      },
      transport: {
        // Note: RPC Anywhere will throw if you try add a message listener if transport.registerHandler is falsey
        registerHandler: () => {},
      },
    } as RPCOptions<mixedBunSchema, mixedWebviewSchema>;

    const rpc = createRPC<mixedBunSchema, mixedWebviewSchema>(rpcOptions);
    
    const messageHandlers = config.handlers.messages;
    if (messageHandlers) {
      // note: this can only be done once there is a transport
      // @ts-ignore - this is due to all the schema mixing we're doing, fine to ignore
      // while types in here are borked, they resolve correctly/bubble up to the defineRPC call site.
      rpc.addMessageListener(
        "*",
        (messageName: keyof WebviewSchema["messages"], payload) => {
          const globalHandler = messageHandlers["*"];
          if (globalHandler) {
            globalHandler(messageName, payload);
          }

          const messageHandler = messageHandlers[messageName];
          if (messageHandler) {
            messageHandler(payload);
          }
        }
      );
    }

    return rpc;
  }
}

export { type RPCSchema, createRPC, Electroview };

const Electrobun = {
  Electroview,
};

export default Electrobun;


