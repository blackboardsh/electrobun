import { zigRPC } from "../proc/zig";
import * as fs from "fs";
import { execSync } from "child_process";
import electrobunEventEmitter from "../events/eventEmitter";
import {
  type RPCSchema,
  type RPCRequestHandler,
  type RPCMessageHandlerFn,
  type WildcardRPCMessageHandlerFn,
  type RPCOptions,
  createRPC,
} from "rpc-anywhere";
import { Updater } from "./Updater";

const BrowserViewMap = {};
let nextWebviewId = 1;

type BrowserViewOptions<T = undefined> = {
  url: string | null;
  html: string | null;
  preload: string | null;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  rpc: T;
  syncRpc: { [method: string]: (params: any) => any };
};

interface ElectrobunWebviewRPCSChema {
  bun: RPCSchema;
  webview: RPCSchema;
}

const defaultOptions: BrowserViewOptions = {
  url: "https://electrobun.dev",
  html: null,
  preload: null,
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  },
};

const hash = await Updater.localInfo.hash();
// Note: we use the build's hash to separate from different apps and different builds
// but we also want a randomId to separate different instances of the same app
const randomId = Math.random().toString(36).substring(7);

export class BrowserView<T> {
  id: number = nextWebviewId++;
  url: string | null = null;
  html: string | null = null;
  preload: string | null = null;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  } = {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  };
  pipePrefix: string;
  inStream: fs.WriteStream;
  outStream: fs.ReadStream;
  rpc?: T;
  syncRpc?: { [method: string]: (params: any) => any };

  constructor(options: Partial<BrowserViewOptions<T>> = defaultOptions) {
    this.url = options.url || defaultOptions.url;
    this.html = options.html || defaultOptions.html;
    this.preload = options.preload || defaultOptions.preload;
    this.frame = options.frame
      ? { ...defaultOptions.frame, ...options.frame }
      : { ...defaultOptions.frame };
    this.rpc = options.rpc;
    this.syncRpc = options.syncRpc;
    this.pipePrefix = `/private/tmp/electrobun_ipc_pipe_${hash}_${randomId}_${this.id}`;

    this.init();
  }

  init() {
    zigRPC.request.createWebview({
      id: this.id,
      pipePrefix: this.pipePrefix,
      // TODO: decide whether we want to keep sending url/html
      // here, if we're manually calling loadURL/loadHTML below
      // then we can remove it from the api here
      url: this.url,
      html: this.html,
      preload: this.preload,
      frame: {
        width: this.frame.width,
        height: this.frame.height,
        x: this.frame.x,
        y: this.frame.y,
      },
      //   autoResize: true,
    });

    this.createStreams();

    BrowserViewMap[this.id] = this;
  }

  createStreams() {
    const webviewPipeIn = this.pipePrefix + "_in";
    const webviewPipeOut = this.pipePrefix + "_out";

    try {
      execSync("mkfifo " + webviewPipeOut);
    } catch (e) {
      console.log("pipe out already exists");
    }

    try {
      execSync("mkfifo " + webviewPipeIn);
    } catch (e) {
      console.log("pipe in already exists");
    }

    const inStream = fs.createWriteStream(webviewPipeIn, {
      flags: "r+",
    });

    // todo: something has to be written to it to open it
    // look into this
    inStream.write("\n");

    this.inStream = inStream;

    // Open the named pipe for reading

    const outStream = fs.createReadStream(webviewPipeOut, {
      flags: "r+",
    });

    this.outStream = outStream;

    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }

  sendMessageToWebview(jsonMessage) {
    const stringifiedMessage =
      typeof jsonMessage === "string"
        ? jsonMessage
        : JSON.stringify(jsonMessage);
    // todo (yoav): make this a shared const with the browser api
    const wrappedMessage = `window.__electrobun.receiveMessageFromBun(${stringifiedMessage})`;
    this.executeJavascript(wrappedMessage);
  }

  executeJavascript(js: string) {
    this.inStream.write(js + "\n");
  }

  loadURL(url: string) {
    this.url = url;
    zigRPC.request.loadURL({ webviewId: this.id, url: this.url });
  }

  loadHTML(html: string) {
    this.html = html;
    zigRPC.request.loadHTML({ webviewId: this.id, html: this.html });
  }

  // todo (yoav): move this to a class that also has off, append, prepend, etc.
  // name should only allow browserView events
  // Note: normalize event names to willNavigate instead of ['will-navigate'] to save
  // 5 characters per usage and allow minification to be more effective.
  on(name: "will-navigate", handler) {
    const specificName = `${name}-${this.id}`;
    electrobunEventEmitter.on(specificName, handler);
  }

  createTransport = () => {
    const that = this;

    return {
      send(message) {
        // todo (yoav): note: this is the same as the zig transport
        try {
          const messageString = JSON.stringify(message);
          that.sendMessageToWebview(messageString);
        } catch (error) {
          console.error("bun: failed to serialize message to webview", error);
        }
      },
      registerHandler(handler) {
        let buffer = "";
        // todo (yoav): readStream function is identical to the one in zig.ts
        that.outStream.on("data", (chunk) => {
          buffer += chunk.toString();
          let eolIndex;

          while ((eolIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, eolIndex).trim();
            buffer = buffer.slice(eolIndex + 1);
            if (line) {
              try {
                const event = JSON.parse(line);
                handler(event);
              } catch (error) {
                // Non-json things are just bubbled up to the console.
                console.error("webview: ", line);
              }
            }
          }
        });
      },
    };
  };

  static getById(id: number) {
    return BrowserViewMap[id];
  }

  static getAll() {
    return Object.values(BrowserViewMap);
  }

  static defineRPC<
    Schema extends ElectrobunWebviewRPCSChema,
    BunSchema extends RPCSchema = Schema["bun"],
    WebviewSchema extends RPCSchema = Schema["webview"]
  >(config: {
    maxRequestTime?: number;
    handlers: {
      requests?: RPCRequestHandler<BunSchema["requests"]>;
      messages?: {
        [key in keyof BunSchema["messages"]]: RPCMessageHandlerFn<
          BunSchema["messages"],
          key
        >;
      } & {
        "*"?: WildcardRPCMessageHandlerFn<BunSchema["messages"]>;
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
    //      requests: // ... requests bun handles, sent by webview,
    //      messages: // ... messages bun handles, sent by webview
    //    },
    //   webview: WebviewSchema {
    //      requests: // ... requests webview handles, sent by bun,
    //      messages: // ... messages webview handles, sent by bun
    //    },
    // }
    // This way from bun, webview.rpc.request.getTitle() and webview.rpc.send.someMessage maps to the schema
    // MySchema.webview.requests.getTitle and MySchema.webview.messages.someMessage
    // and in the webview, Electroview.rpc.request.getFileContents maps to
    // MySchema.bun.requests.getFileContents.
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
    } as RPCOptions<mixedWebviewSchema, mixedBunSchema>;

    const rpc = createRPC<mixedWebviewSchema, mixedBunSchema>(rpcOptions);

    const messageHandlers = config.handlers.messages;
    if (messageHandlers) {
      // note: this can only be done once there is a transport
      // @ts-ignore - this is due to all the schema mixing we're doing, fine to ignore
      // while types in here are borked, they resolve correctly/bubble up to the defineRPC call site.
      rpc.addMessageListener(
        "*",
        (messageName: keyof BunSchema["messages"], payload) => {
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
