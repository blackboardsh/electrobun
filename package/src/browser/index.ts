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
import type { BuiltinBunToWebviewSchema, BuiltinWebviewToBunSchema } from "./builtinrpcSchema";
import type { InternalWebviewHandlers, WebviewTagHandlers } from "./rpc/webview";

interface ElectrobunWebviewRPCSChema {
  bun: RPCSchema;
  webview: RPCSchema;
}

const WEBVIEW_ID = window.__electrobunWebviewId;
const WINDOW_ID = window.__electrobunWindowId;
const RPC_SOCKET_PORT = window.__electrobunRpcSocketPort;


class Electroview<T> {
  bunSocket?: WebSocket;
  // user's custom rpc browser <-> bun
  rpc?: T;
  rpcHandler?: (msg: any) => void;
  // electrobun rpc browser <-> bun
  internalRpc?: any;
  internalRpcHandler?: (msg: any) => void;
  
  constructor(config: { rpc: T }) {
    this.rpc = config.rpc;
    this.init();
  }

  init() {
    // todo (yoav): should init webviewTag by default when src is local
    // and have a setting that forces it enabled or disabled
    this.initInternalRpc();
    this.initSocketToBun();

    ConfigureWebviewTags(true, this.internalRpc, this.rpc);

    this.initElectrobunListeners();

    window.__electrobun = {
      receiveMessageFromBun: this.receiveMessageFromBun.bind(this),
      receiveInternalMessageFromBun: this.receiveInternalMessageFromBun.bind(this),
    };

    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }

  initInternalRpc() {
    this.internalRpc = createRPC<WebviewTagHandlers, InternalWebviewHandlers>({
      transport: this.createInternalTransport(),
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

  // This will be attached to the global object, bun can rpc reply by executingJavascript
  // of that global reference to the function
  receiveInternalMessageFromBun(msg: any) {    
    if (this.internalRpcHandler) {
      
      this.internalRpcHandler(msg);
    }
  }

  // TODO: implement proper rpc-anywhere style rpc here
  // todo: this is duplicated in webviewtag.ts and should be DRYed up
  isProcessingQueue = false;
  sendToInternalQueue = [];
  sendToBunInternal(message: {}) {   
    try {    
      const strMessage = JSON.stringify(message);    
      this.sendToInternalQueue.push(strMessage);    

      this.processQueue();
    } catch (err) {
      console.error('failed to send to bun internal', err);
    }
  }

  processQueue() {
    const that = this;
    if (that.isProcessingQueue) {

      // This timeout is just to schedule a retry "later"
      setTimeout(() => {
        that.processQueue();
      });
      return;
    }

    if (that.sendToInternalQueue.length === 0) {
      // that.isProcessingQueue = false;
      return;  
    }

    that.isProcessingQueue = true;
    
    const batchMessage = JSON.stringify(that.sendToInternalQueue);
    that.sendToInternalQueue = [];
    window.__electrobunInternalBridge?.postMessage(batchMessage);
    
    // Note: The postmessage handler is routed via native code to a Bun JSCallback.
    // Currently JSCallbacks are somewhat experimental and were designed for a single invocation
    // But we have tons of resize events in this webview's thread that are sent, maybe to main thread
    // and then the JSCallback is invoked on the Bun worker thread. JSCallbacks have a little virtual memory 
    // or something that can segfault when called from a thread while the worker(bun) thread is still executing
    // a previous call. The segfaults were really only triggered with multiple <electrobun-webview>s on a page
    // all trying to resize at the same time.
    // 
    // To work around this we batch high frequency postMessage calls here with a timeout. While not deterministic hopefully Bun
    // fixes the underlying FFI/JSCallback issue before we have to invest time in a more deterministic solution.
    // 
    // On my m4 max a 1ms delay is not long enough to let it complete and can segfault, a 2ms delay is long enough
    // This may be different on slower hardware but not clear if it would need more or less time so leaving this for now
    setTimeout(() => {
      that.isProcessingQueue = false;
    }, 2);
  }

  initElectrobunListeners() {
    document.addEventListener("mousedown", (e) => {
      if (isAppRegionDrag(e)) {
        this.internalRpc?.send.startWindowMove({ id: WINDOW_ID });
      }
    });

    document.addEventListener("mouseup", (e) => {
      if (isAppRegionDrag(e)) {
        this.internalRpc?.send.stopWindowMove({ id: WINDOW_ID });
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
  
  createInternalTransport(): RPCTransport {
    const that = this;    
    return {
      send(message) {                  
        message.hostWebviewId = WEBVIEW_ID;        
        that.sendToBunInternal(message);      
      },
      registerHandler(handler) {        
        that.internalRpcHandler = handler;
        // webview tag doesn't handle any messages from bun just yet
      },
    };
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
      window.__electrobunBunBridge?.postMessage(msg);
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
      requests: BunSchema["requests"] & BuiltinWebviewToBunSchema["requests"];
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


