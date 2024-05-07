import {
  type RPCSchema,
  type RPCRequestHandler,
  type RPCOptions,
  type RPCMessageHandlerFn,
  type WildcardRPCMessageHandlerFn,
  createRPC,
} from "rpc-anywhere";
import { ConfigureWebviewTags } from "./webviewtag";

interface ElectrobunWebviewRPCSChema {
  bun: RPCSchema;
  webview: RPCSchema;
}

class Electroview<T> {
  rpc?: T;
  rpcHandler?: (msg: any) => void;
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
    const { receiveMessageFromZig } = ConfigureWebviewTags(true);

    window.__electrobun = {
      receiveMessageFromBun: this.receiveMessageFromBun.bind(this),
      receiveMessageFromZig,
    };

    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());

      // Note:
      // syncRPC doesn't need to be defined since there's no need for sync 1-way message
      // just use non-blocking async rpc for that
      // We don't need request ids either since we're not receiving the response on a different pipe
      if (true) {
        // TODO: define sync requests on schema (separate from async reqeusts and messages)
        this.syncRpc = (msg: { method: string; params: any }) => {
          try {
            const messageString = JSON.stringify(msg);
            return this.bunBridgeSync(messageString);
          } catch (error) {
            console.error(
              "bun: failed to serialize message to webview syncRpc",
              error
            );
          }
        };
      }
    }
  }

  createTransport() {
    const that = this;
    return {
      send(message) {
        try {
          const messageString = JSON.stringify(message);
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

  // call any of your bun syncrpc methods in a way that appears synchronous from the browser context
  bunBridgeSync(msg: string) {
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

  bunBridge(msg: string) {
    // Note: zig sets up this custom message handler bridge
    window.webkit.messageHandlers.bunBridge.postMessage(msg);
  }

  bunBridgeWithReply(msg: string) {
    // Note: zig sets up this custom message handler bridge
    // Note: Since post message is async in the browser context and bun will reply async
    // We're using postMessage handler (via bunBridge above) without a reply, and then letting bun reply
    // via pipesin and evaluateJavascript.
    // addScriptMessageHandlerWithReply is just here as reference and for future use cases.
    return window.webkit.messageHandlers.bunBridgeWithReply.postMessage(msg);
  }

  // webviewTagBridge(msg) {
  //     // Note: zig sets up this custom message handler bridge
  //     window.webkit.messageHandlers.webviewTagBridge.postMessage(msg);
  // }

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

    type mixedWebviewSchema = {
      requests: BunSchema["requests"];
      messages: WebviewSchema["messages"];
    };

    type mixedBunSchema = {
      requests: WebviewSchema["requests"];
      messages: BunSchema["messages"];
    };

    const rpcOptions = {
      maxRequestTime: config.maxRequestTime,
      requestHandler: config.handlers.requests,
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

const ElectrobunView = {
  Electroview,
};

export default ElectrobunView;
