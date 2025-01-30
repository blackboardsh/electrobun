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
import type { BuiltinBunToWebviewSchema } from "../../browser/builtinrpcSchema";
import { rpcPort, sendMessageToWebviewViaSocket } from "./Socket";
import { randomBytes } from "crypto";

const BrowserViewMap: {
  [id: number]: BrowserView<any>;
} = {};
let nextWebviewId = 1;

const CHUNK_SIZE = 1024 * 4; // 4KB

type BrowserViewOptions<T = undefined> = {
  url: string | null;
  html: string | null;
  preload: string | null;
  renderer: 'native' | 'cef';
  partition: string | null;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  rpc: T;
  // todo: remove syncrpc and internal syncrpc
  syncRpc: { [method: string]: (params: any) => any };
  hostWebviewId: number;
  autoResize: boolean;

  windowId: number;
  navigationRules: string | null;
  // renderer: 
};

interface ElectrobunWebviewRPCSChema {
  bun: RPCSchema;
  webview: RPCSchema;
}

const defaultOptions: Partial<BrowserViewOptions> = {
  url: null,
  html: null,
  preload: null,
  renderer: 'native',
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  },
};

const internalSyncRpcHandlers = {
  // todo: this shouldn't be getting method, just params.
  webviewTagInit: ({
    method,
    params,
  }: {
    method: string;
    params: BrowserViewOptions & { windowId: number };
  }) => {
    
    const {
      hostWebviewId,
      windowId,
      renderer,
      html,
      preload,
      partition,
      frame,
      navigationRules,
    } = params;

    const url = !params.url && !html ? "https://electrobun.dev" : params.url;    

    const webviewForTag = new BrowserView({
      url,
      html,
      preload,
      partition,
      frame,
      hostWebviewId,
      autoResize: false,
      windowId,
      renderer,//: "cef",
      navigationRules,
    });

    return webviewForTag.id;
  },
};

const hash = await Updater.localInfo.hash();
// Note: we use the build's hash to separate from different apps and different builds
// but we also want a randomId to separate different instances of the same app
const randomId = Math.random().toString(36).substring(7);

export class BrowserView<T> {
  id: number = nextWebviewId++;
  hostWebviewId?: number;
  windowId: number;
  renderer: 'cef' | 'native';
  url: string | null = null;
  html: string | null = null;
  preload: string | null = null;
  partition: string | null = null;
  autoResize: boolean = true;
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
  outStream: ReadableStream<Uint8Array>;
  secretKey: Uint8Array;
  rpc?: T;
  syncRpc?: { [method: string]: (params: any) => any };
  rpcHandler?: (msg: any) => void;
  navigationRules: string | null;

  constructor(options: Partial<BrowserViewOptions<T>> = defaultOptions) {
    // const rpc = options.rpc;

    // if (rpc) {
    //   rpc.
    // }

    console.log('CONSTRUCTOR 1')

    this.url = options.url || defaultOptions.url || null;
    this.html = options.html || defaultOptions.html || null;
    this.preload = options.preload || defaultOptions.preload || null;
    this.frame = options.frame
      ? { ...defaultOptions.frame, ...options.frame }
      : { ...defaultOptions.frame };
    this.rpc = options.rpc;
    this.secretKey = new Uint8Array(randomBytes(32));
    this.syncRpc = { ...(options.syncRpc || {}), ...internalSyncRpcHandlers };
    this.partition = options.partition || null;
    // todo (yoav): since collisions can crash the app add a function that checks if the
    // file exists first
    this.pipePrefix = `/private/tmp/electrobun_ipc_pipe_${hash}_${randomId}_${this.id}`;
    this.hostWebviewId = options.hostWebviewId;
    this.windowId = options.windowId;
    this.autoResize = options.autoResize === false ? false : true;
    this.navigationRules = options.navigationRules || null;
    this.renderer = options.renderer || defaultOptions.renderer;

    this.init();
  }

  init() {
    this.createStreams();

    

    // TODO: add a then to this that fires an onReady event
    zigRPC.request.createWebview({
      id: this.id,
      windowId: this.windowId,
      renderer: this.renderer, 
      rpcPort: rpcPort,
      // todo: consider sending secretKey as base64
      secretKey: this.secretKey.toString(),
      hostWebviewId: this.hostWebviewId || null,
      pipePrefix: this.pipePrefix,
      partition: this.partition,      
      url: this.url,      
      html: this.html,
      preload: this.preload,
      frame: {
        width: this.frame.width,
        height: this.frame.height,
        x: this.frame.x,
        y: this.frame.y,
      },
      autoResize: this.autoResize,
      navigationRules: this.navigationRules,
    });

    BrowserViewMap[this.id] = this;
  }

  createStreams() {
    console.log('createStreams 1', this.html)
    const webviewPipeIn = this.pipePrefix + "_in";
    const webviewPipeOut = this.pipePrefix + "_out";
    console.log('createStreams 2', "mkfifo " + webviewPipeOut)
    try {
      execSync("mkfifo " + webviewPipeOut);
    } catch (e) {
      console.log("pipe out already exists");
    }
    console.log('createStreams 3')
    try {
      execSync("mkfifo " + webviewPipeIn);
    } catch (e) {
      console.log("pipe in already exists");
    }

    // setTimeout(() => {
    console.log('createStreams 4')
    const inStream = fs.createWriteStream(webviewPipeIn, {
      flags: "r+",
    });

    // todo: something has to be written to it to open it
    // look into this
    inStream.write("\n");

    this.inStream = inStream;
    console.log('createStreams 5')
    // Open the named pipe for reading
    const outStream = Bun.file(webviewPipeOut).stream();
    this.outStream = outStream;
    console.log('createStreams 6')
    if (!this.rpc) {
      this.rpc = BrowserView.defineRPC({
        handlers: { requests: {}, messages: {} },
      });
    }
    console.log('createStreams 7')
    this.rpc.setTransport(this.createTransport());
    console.log('createStreams 8')
  // }, 5000)
  }

  sendMessageToWebviewViaExecute(jsonMessage) {
    const stringifiedMessage =
      typeof jsonMessage === "string"
        ? jsonMessage
        : JSON.stringify(jsonMessage);
    // todo (yoav): make this a shared const with the browser api
    const wrappedMessage = `window.__electrobun.receiveMessageFromBun(${stringifiedMessage})`;
    this.executeJavascript(wrappedMessage);
  }

  // Note: the OS has a buffer limit on named pipes. If we overflow it
  // it won't trigger the kevent for zig to read the pipe and we'll be stuck.
  // so we have to chunk it
  executeJavascript(js: string) {
    let offset = 0;
    while (offset < js.length) {
      const chunk = js.slice(offset, offset + CHUNK_SIZE);
      this.inStream.write(chunk);
      offset += CHUNK_SIZE;
    }

    // Ensure the newline is written after all chunks
    this.inStream.write("\n");
  }

  loadURL(url: string) {
    this.url = url;
    zigRPC.request.loadURL({ webviewId: this.id, url: this.url });
  }

  loadHTML(html: string) {
    this.html = html;
    // todo: reimplement
    // const url = this.htmlToDataURI(html);
    // zigRPC.request.loadHTML({ webviewId: this.id, html: html });    
  }

  
  htmlToDataURI(html: string) {
    return "data:text/html;base64," + Buffer.from(html, "utf8").toString("base64");
  }

  

  // todo (yoav): move this to a class that also has off, append, prepend, etc.
  // name should only allow browserView events
  // Note: normalize event names to willNavigate instead of ['will-navigate'] to save
  // 5 characters per usage and allow minification to be more effective.
  on(
    name:
      | "will-navigate"
      | "did-navigate"
      | "did-navigate-in-page"
      | "did-commit-navigation"
      | "dom-ready",
    handler
  ) {
    const specificName = `${name}-${this.id}`;
    electrobunEventEmitter.on(specificName, handler);
  }

  createTransport = () => {
    const that = this;

    return {
      send(message: any) {
        const sentOverSocket = sendMessageToWebviewViaSocket(that.id, message);

        if (!sentOverSocket) {
          try {
            const messageString = JSON.stringify(message);
            that.sendMessageToWebviewViaExecute(messageString);
          } catch (error) {
            console.error("bun: failed to serialize message to webview", error);
          }
        }
      },
      registerHandler(handler) {
        that.rpcHandler = handler;

        async function readFromPipe(
          reader: ReadableStreamDefaultReader<Uint8Array>
        ) {
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += new TextDecoder().decode(value);
            let eolIndex;

            while ((eolIndex = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, eolIndex).trim();
              buffer = buffer.slice(eolIndex + 1);
              if (line) {
                try {
                  const event = JSON.parse(line);

                  handler(event);
                } catch (error) {
                  console.error("webview: ", line);
                }
              }
            }
          }
        }

        const reader = that.outStream.getReader();
        readFromPipe(reader);
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
      requests: WebviewSchema["requests"] &
        BuiltinBunToWebviewSchema["requests"];
      messages: BunSchema["messages"];
    };

    const rpcOptions = {
      maxRequestTime: config.maxRequestTime,
      requestHandler: {
        ...config.handlers.requests,
        ...internalSyncRpcHandlers,
      },
      transport: {
        // Note: RPC Anywhere will throw if you try add a message listener if transport.registerHandler is falsey
        registerHandler: () => {},
      },
    } as RPCOptions<mixedWebviewSchema, mixedBunSchema>;

    const rpc = createRPC<mixedWebviewSchema, mixedBunSchema>(rpcOptions);

    console.log('messageHandler 6')
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
