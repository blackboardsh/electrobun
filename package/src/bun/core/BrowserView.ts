import {  native, toCString, ffi } from "../proc/native";
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
import { BuildConfig } from "./BuildConfig";
import type { BuiltinBunToWebviewSchema,BuiltinWebviewToBunSchema } from "../../browser/builtinrpcSchema";
import { rpcPort, sendMessageToWebviewViaSocket } from "./Socket";
import { randomBytes } from "crypto";
import {FFIType, type Pointer}  from 'bun:ffi';

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

const hash = await Updater.localInfo.hash();
const buildConfig = await BuildConfig.get();

const defaultOptions: Partial<BrowserViewOptions> = {
  url: null,
  html: null,
  preload: null,
  renderer: buildConfig.defaultRenderer,
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  },
};
// Note: we use the build's hash to separate from different apps and different builds
// but we also want a randomId to separate different instances of the same app
const randomId = Math.random().toString(36).substring(7);

export class BrowserView<T> {
  id: number = nextWebviewId++;
  ptr: Pointer;
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
  rpcHandler?: (msg: any) => void;
  navigationRules: string | null;

  constructor(options: Partial<BrowserViewOptions<T>> = defaultOptions) {
    // const rpc = options.rpc;        
    
    this.url = options.url || defaultOptions.url || null;
    this.html = options.html || defaultOptions.html || null;
    this.preload = options.preload || defaultOptions.preload || null;
    this.frame = options.frame
      ? { ...defaultOptions.frame, ...options.frame }
      : { ...defaultOptions.frame };
    this.rpc = options.rpc;
    this.secretKey = new Uint8Array(randomBytes(32));    
    this.partition = options.partition || null;
    // todo (yoav): since collisions can crash the app add a function that checks if the
    // file exists first
    this.pipePrefix = `/private/tmp/electrobun_ipc_pipe_${hash}_${randomId}_${this.id}`;
    this.hostWebviewId = options.hostWebviewId;
    this.windowId = options.windowId;
    this.autoResize = options.autoResize === false ? false : true;
    this.navigationRules = options.navigationRules || null;
    this.renderer = options.renderer || defaultOptions.renderer;

    BrowserViewMap[this.id] = this;
    this.ptr = this.init();
    
    // If HTML content was provided, load it after webview creation
    if (this.html) {
      console.log(`DEBUG: BrowserView constructor triggering loadHTML for webview ${this.id}`);
      // Small delay to ensure webview is ready
      setTimeout(() => {
        console.log(`DEBUG: BrowserView delayed loadHTML for webview ${this.id}`);
        this.loadHTML(this.html!);
      }, 100);  // Back to 100ms since we fixed the race condition
    } else {
      console.log(`DEBUG: BrowserView constructor - no HTML provided for webview ${this.id}`);
    }
  }

  init() {
    this.createStreams();

    // TODO: add a then to this that fires an onReady event
    return ffi.request.createWebview({
      id: this.id,
      windowId: this.windowId,
      renderer: this.renderer,
      rpcPort: rpcPort,
      // todo: consider sending secretKey as base64
      secretKey: this.secretKey.toString(),
      hostWebviewId: this.hostWebviewId || null,
      pipePrefix: this.pipePrefix,
      partition: this.partition,
      // Only pass URL if no HTML content is provided to avoid conflicts
      url: this.html ? null : this.url,
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
      // transparent is looked up from parent window in native.ts
    });

    
  }

  createStreams() {    
    if (!this.rpc) {
      this.rpc = BrowserView.defineRPC({
        handlers: { requests: {}, messages: {} },
      });
    }
    
    this.rpc.setTransport(this.createTransport());
    
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

  sendInternalMessageViaExecute(jsonMessage) {
    const stringifiedMessage =
      typeof jsonMessage === "string"
        ? jsonMessage
        : JSON.stringify(jsonMessage);
    // todo (yoav): make this a shared const with the browser api
    const wrappedMessage = `window.__electrobun.receiveInternalMessageFromBun(${stringifiedMessage})`;
    this.executeJavascript(wrappedMessage);
  }

  // Note: the OS has a buffer limit on named pipes. If we overflow it
  // it won't trigger the kevent for zig to read the pipe and we'll be stuck.
  // so we have to chunk it
  // TODO: is this still needed after switching from named pipes
  executeJavascript(js: string) {
    ffi.request.evaluateJavascriptWithNoCompletion({id: this.id, js});
  }

  loadURL(url: string) {
    console.log(`DEBUG: loadURL called for webview ${this.id}: ${url}`);
    this.url = url;    
    native.symbols.loadURLInWebView(this.ptr, toCString(this.url))      
  }

  loadHTML(html: string) {
    this.html = html;
    console.log(`DEBUG: Setting HTML content for webview ${this.id}:`, html.substring(0, 50) + '...');

    if (this.renderer === 'cef') {
      // For CEF, store HTML content in native map and use scheme handler
      native.symbols.setWebviewHTMLContent(this.id, toCString(html));
      this.loadURL('views://internal/index.html');
    } else {
      // For WKWebView, load HTML content directly
      native.symbols.loadHTMLInWebView(this.ptr, toCString(html));
    }
  }

  setNavigationRules(rules: string[]) {
    this.navigationRules = JSON.stringify(rules);
    const rulesJson = JSON.stringify(rules);
    native.symbols.setWebviewNavigationRules(this.ptr, toCString(rulesJson));
  }

  findInPage(searchText: string, options?: {forward?: boolean; matchCase?: boolean}) {
    const forward = options?.forward ?? true;
    const matchCase = options?.matchCase ?? false;
    native.symbols.webviewFindInPage(this.ptr, toCString(searchText), forward, matchCase);
  }

  stopFindInPage() {
    native.symbols.webviewStopFind(this.ptr);
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
      | "dom-ready"
      | "download-started"
      | "download-progress"
      | "download-completed"
      | "download-failed",
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
      requests: BunSchema["requests"]// & BuiltinWebviewToBunSchema["requests"];
      messages: WebviewSchema["messages"];
    };

    type mixedBunSchema = {      
      messages: BunSchema["messages"];
    };

    const rpcOptions = {
      maxRequestTime: config.maxRequestTime,
      requestHandler: {
        ...config.handlers.requests,
        // ...internalRpcHandlers,
      },
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
