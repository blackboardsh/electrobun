// @bun
// /Users/yoav/code/electrobun/src/bun/events/eventEmitter.ts
import EventEmitter from "events";

// /Users/yoav/code/electrobun/src/bun/events/event.ts
class ElectrobunEvent {
  name;
  data;
  _response;
  responseWasSet = false;
  constructor(name, data) {
    this.name = name;
    this.data = data;
  }
  get response() {
    return this._response;
  }
  set response(value) {
    this._response = value;
    this.responseWasSet = true;
  }
  clearResponse() {
    this._response = undefined;
    this.responseWasSet = false;
  }
}

// /Users/yoav/code/electrobun/src/bun/events/webviewEvents.ts
var webviewEvents_default = {
  willNavigate: (data) => new ElectrobunEvent("will-navigate", data)
};

// /Users/yoav/code/electrobun/src/bun/events/eventEmitter.ts
class ElectrobunEventEmitter extends EventEmitter {
  constructor() {
    super();
  }
  emitEvent(ElectrobunEvent2, specifier) {
    if (specifier) {
      this.emit(`${ElectrobunEvent2.name}-${specifier}`, ElectrobunEvent2);
    } else {
      this.emit(ElectrobunEvent2.name, ElectrobunEvent2);
    }
  }
  events = {
    webview: {
      ...webviewEvents_default
    }
  };
}
var electrobunEventEmitter = new ElectrobunEventEmitter;
var eventEmitter_default = electrobunEventEmitter;

// /Users/yoav/code/electrobun/src/bun/proc/zig.ts
import {join, resolve} from "path";
// /Users/yoav/code/electrobun/src/bun/node_modules/rpc-anywhere/dist/esm/rpc.js
var missingTransportMethodError = function(methods, action) {
  const methodsString = methods.map((method) => `"${method}"`).join(", ");
  return new Error(`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`);
};
function _createRPC(options = {}) {
  let debugHooks = {};
  function _setDebugHooks(newDebugHooks) {
    debugHooks = newDebugHooks;
  }
  let transport = {};
  function setTransport(newTransport) {
    if (transport.unregisterHandler)
      transport.unregisterHandler();
    transport = newTransport;
    transport.registerHandler?.(handler);
  }
  let requestHandler = undefined;
  function setRequestHandler(handler2) {
    if (typeof handler2 === "function") {
      requestHandler = handler2;
      return;
    }
    requestHandler = (method, params) => {
      const handlerFn = handler2[method];
      if (handlerFn)
        return handlerFn(params);
      const fallbackHandler = handler2._;
      if (!fallbackHandler)
        throw new Error(`The requested method has no handler: ${method}`);
      return fallbackHandler(method, params);
    };
  }
  const { maxRequestTime = DEFAULT_MAX_REQUEST_TIME } = options;
  if (options.transport)
    setTransport(options.transport);
  if (options.requestHandler)
    setRequestHandler(options.requestHandler);
  if (options._debugHooks)
    _setDebugHooks(options._debugHooks);
  let lastRequestId = 0;
  function getRequestId() {
    if (lastRequestId <= MAX_ID)
      return ++lastRequestId;
    return lastRequestId = 0;
  }
  const requestListeners = new Map;
  const requestTimeouts = new Map;
  function requestFn(method, ...args) {
    const params = args[0];
    return new Promise((resolve, reject) => {
      if (!transport.send)
        throw missingTransportMethodError(["send"], "make requests");
      const requestId = getRequestId();
      const request2 = {
        type: "request",
        id: requestId,
        method,
        params
      };
      requestListeners.set(requestId, { resolve, reject });
      if (maxRequestTime !== Infinity)
        requestTimeouts.set(requestId, setTimeout(() => {
          requestTimeouts.delete(requestId);
          reject(new Error("RPC request timed out."));
        }, maxRequestTime));
      debugHooks.onSend?.(request2);
      transport.send(request2);
    });
  }
  const request = new Proxy(requestFn, {
    get: (target, prop, receiver) => {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      return (params) => requestFn(prop, params);
    }
  });
  const requestProxy = request;
  function sendFn(message, ...args) {
    const payload = args[0];
    if (!transport.send)
      throw missingTransportMethodError(["send"], "send messages");
    const rpcMessage = {
      type: "message",
      id: message,
      payload
    };
    debugHooks.onSend?.(rpcMessage);
    transport.send(rpcMessage);
  }
  const send = new Proxy(sendFn, {
    get: (target, prop, receiver) => {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      return (payload) => sendFn(prop, payload);
    }
  });
  const sendProxy = send;
  const messageListeners = new Map;
  const wildcardMessageListeners = new Set;
  function addMessageListener(message, listener) {
    if (!transport.registerHandler)
      throw missingTransportMethodError(["registerHandler"], "register message listeners");
    if (message === "*") {
      wildcardMessageListeners.add(listener);
      return;
    }
    if (!messageListeners.has(message))
      messageListeners.set(message, new Set);
    messageListeners.get(message)?.add(listener);
  }
  function removeMessageListener(message, listener) {
    if (message === "*") {
      wildcardMessageListeners.delete(listener);
      return;
    }
    messageListeners.get(message)?.delete(listener);
    if (messageListeners.get(message)?.size === 0)
      messageListeners.delete(message);
  }
  async function handler(message) {
    debugHooks.onReceive?.(message);
    if (!("type" in message))
      throw new Error("Message does not contain a type.");
    if (message.type === "request") {
      if (!transport.send || !requestHandler)
        throw missingTransportMethodError(["send", "requestHandler"], "handle requests");
      const { id, method, params } = message;
      let response;
      try {
        response = {
          type: "response",
          id,
          success: true,
          payload: await requestHandler(method, params)
        };
      } catch (error) {
        if (!(error instanceof Error))
          throw error;
        response = {
          type: "response",
          id,
          success: false,
          error: error.message
        };
      }
      debugHooks.onSend?.(response);
      transport.send(response);
      return;
    }
    if (message.type === "response") {
      const timeout = requestTimeouts.get(message.id);
      if (timeout != null)
        clearTimeout(timeout);
      const { resolve, reject } = requestListeners.get(message.id) ?? {};
      if (!message.success)
        reject?.(new Error(message.error));
      else
        resolve?.(message.payload);
      return;
    }
    if (message.type === "message") {
      for (const listener of wildcardMessageListeners)
        listener(message.id, message.payload);
      const listeners = messageListeners.get(message.id);
      if (!listeners)
        return;
      for (const listener of listeners)
        listener(message.payload);
      return;
    }
    throw new Error(`Unexpected RPC message type: ${message.type}`);
  }
  const proxy = { send: sendProxy, request: requestProxy };
  return {
    setTransport,
    setRequestHandler,
    request,
    requestProxy,
    send,
    sendProxy,
    addMessageListener,
    removeMessageListener,
    proxy,
    _setDebugHooks
  };
}
var MAX_ID = 10000000000;
var DEFAULT_MAX_REQUEST_TIME = 1000;

// /Users/yoav/code/electrobun/src/bun/node_modules/rpc-anywhere/dist/esm/create-rpc.js
function createRPC(options) {
  return _createRPC(options);
}
// /Users/yoav/code/electrobun/src/bun/proc/zig.ts
import {execSync} from "child_process";
import * as fs from "fs";
var createStdioTransport = function(proc) {
  return {
    send(message) {
      try {
        const messageString = JSON.stringify(message) + "\n";
        inStream.write(messageString);
      } catch (error) {
        console.error("bun: failed to serialize message to zig", error);
      }
    },
    registerHandler(handler) {
      async function readStream(stream) {
        const reader = stream.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done)
              break;
            buffer += new TextDecoder().decode(value);
            let eolIndex;
            while ((eolIndex = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, eolIndex).trim();
              buffer = buffer.slice(eolIndex + 1);
              if (line) {
                try {
                  const event2 = JSON.parse(line);
                  handler(event2);
                } catch (error) {
                  console.error("zig: ", line);
                }
              }
            }
          }
        } catch (error) {
          console.error("Error reading from stream:", error);
        } finally {
          reader.releaseLock();
        }
      }
      readStream(proc.stdout);
    }
  };
};
var webviewBinaryPath = join("native", "webview");
var zigProc = Bun.spawn([webviewBinaryPath], {
  stdin: "pipe",
  stdout: "pipe",
  env: {
    ...process.env,
    ELECTROBUN_VIEWS_FOLDER: resolve("../Resources/app/views")
  },
  onExit: (_zigProc) => {
    process.exit(0);
  }
});
var mainPipe = "/private/tmp/electrobun_ipc_pipe_my-app-id_main";
process.on("SIGINT", (code) => {
  zigProc.kill();
  process.exit();
});
try {
  execSync("mkfifo " + mainPipe);
} catch (e) {
  console.log("pipe out already exists");
}
var inStream = fs.createWriteStream(mainPipe, {
  flags: "r+"
});
var zigRPC = createRPC({
  transport: createStdioTransport(zigProc),
  requestHandler: {
    decideNavigation: ({ webviewId, url }) => {
      const willNavigate = eventEmitter_default.events.webview.willNavigate({ url, webviewId });
      let result;
      result = eventEmitter_default.emitEvent(willNavigate);
      result = eventEmitter_default.emitEvent(willNavigate, webviewId);
      if (willNavigate.responseWasSet) {
        return willNavigate.response || { allow: true };
      } else {
        return { allow: true };
      }
    }
  },
  maxRequestTime: 25000
});

// /Users/yoav/code/electrobun/src/bun/core/BrowserView.ts
import * as fs2 from "fs";
import {execSync as execSync2} from "child_process";
var BrowserViewMap = {};
var nextWebviewId = 1;
var defaultOptions = {
  url: "https://electrobun.dev",
  html: null,
  preload: null,
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600
  }
};

class BrowserView {
  id = nextWebviewId++;
  url = null;
  html = null;
  preload = null;
  frame = {
    x: 0,
    y: 0,
    width: 800,
    height: 600
  };
  inStream;
  outStream;
  rpc;
  constructor(options = defaultOptions) {
    this.url = options.url || defaultOptions.url;
    this.html = options.html || defaultOptions.html;
    this.preload = options.preload || defaultOptions.preload;
    this.frame = options.frame ? { ...defaultOptions.frame, ...options.frame } : { ...defaultOptions.frame };
    this.rpc = options.rpc;
    this.init();
  }
  init() {
    zigRPC.request.createWebview({
      id: this.id,
      url: this.url,
      html: this.html,
      preload: this.preload,
      frame: {
        width: this.frame.width,
        height: this.frame.height,
        x: this.frame.x,
        y: this.frame.y
      }
    });
    this.createStreams();
    BrowserViewMap[this.id] = this;
  }
  createStreams() {
    const webviewPipe = `/private/tmp/electrobun_ipc_pipe_${this.id}_1`;
    const webviewPipeIn = webviewPipe + "_in";
    const webviewPipeOut = webviewPipe + "_out";
    try {
      execSync2("mkfifo " + webviewPipeOut);
    } catch (e) {
      console.log("pipe out already exists");
    }
    try {
      execSync2("mkfifo " + webviewPipeIn);
    } catch (e) {
      console.log("pipe in already exists");
    }
    const inStream2 = fs2.createWriteStream(webviewPipeIn, {
      flags: "r+"
    });
    inStream2.write("\n");
    this.inStream = inStream2;
    const outStream = fs2.createReadStream(webviewPipeOut, {
      flags: "r+"
    });
    this.outStream = outStream;
    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }
  sendMessageToWebview(jsonMessage) {
    const stringifiedMessage = typeof jsonMessage === "string" ? jsonMessage : JSON.stringify(jsonMessage);
    const wrappedMessage = `window.__electrobun.receiveMessageFromBun(${stringifiedMessage})`;
    this.executeJavascript(wrappedMessage);
  }
  executeJavascript(js) {
    this.inStream.write(js + "\n");
  }
  loadURL(url) {
    this.url = url;
    zigRPC.request.loadURL({ webviewId: this.id, url: this.url });
  }
  loadHTML(html) {
    this.html = html;
    zigRPC.request.loadHTML({ webviewId: this.id, html: this.html });
  }
  on(name, handler) {
    const specificName = `${name}-${this.id}`;
    eventEmitter_default.on(specificName, handler);
  }
  createTransport = () => {
    const that = this;
    return {
      send(message) {
        try {
          const messageString = JSON.stringify(message);
          that.sendMessageToWebview(messageString);
        } catch (error) {
          console.error("bun: failed to serialize message to webview", error);
        }
      },
      registerHandler(handler) {
        let buffer = "";
        that.outStream.on("data", (chunk) => {
          buffer += chunk.toString();
          let eolIndex;
          while ((eolIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, eolIndex).trim();
            buffer = buffer.slice(eolIndex + 1);
            if (line) {
              try {
                const event2 = JSON.parse(line);
                handler(event2);
              } catch (error) {
                console.error("webview: ", line);
              }
            }
          }
        });
      }
    };
  };
  static getById(id) {
    return BrowserViewMap[id];
  }
  static getAll() {
    return Object(BrowserViewMap).values();
  }
  static defineRPC(config) {
    const rpcOptions = {
      maxRequestTime: config.maxRequestTime,
      requestHandler: config.handlers.requests,
      transport: {
        registerHandler: () => {
        }
      }
    };
    const rpc2 = createRPC(rpcOptions);
    const messageHandlers = config.handlers.messages;
    if (messageHandlers) {
      rpc2.addMessageListener("*", (messageName, payload) => {
        const globalHandler = messageHandlers["*"];
        if (globalHandler) {
          globalHandler(messageName, payload);
        }
        const messageHandler = messageHandlers[messageName];
        if (messageHandler) {
          messageHandler(payload);
        }
      });
    }
    return rpc2;
  }
}

// /Users/yoav/code/electrobun/src/bun/core/BrowserWindow.ts
var nextWindowId = 1;
var defaultOptions2 = {
  title: "Electrobun",
  frame: {
    x: 0,
    y: 0,
    width: 800,
    height: 600
  },
  url: "https://electrobun.dev",
  html: null,
  preload: null
};
var BrowserWindowMap = {};

class BrowserWindow {
  id = nextWindowId++;
  title = "Electrobun";
  state = "creating";
  url = null;
  html = null;
  preload = null;
  frame = {
    x: 0,
    y: 0,
    width: 800,
    height: 600
  };
  webviewId;
  constructor(options = defaultOptions2) {
    this.title = options.title || "New Window";
    this.frame = options.frame ? { ...defaultOptions2.frame, ...options.frame } : { ...defaultOptions2.frame };
    this.url = options.url || null;
    this.html = options.html || null;
    this.preload = options.preload || null;
    this.init(options.rpc);
  }
  init(rpc2) {
    zigRPC.request.createWindow({
      id: this.id,
      title: this.title,
      url: this.url,
      html: this.html,
      frame: {
        width: this.frame.width,
        height: this.frame.height,
        x: this.frame.x,
        y: this.frame.y
      }
    });
    const webview = new BrowserView({
      url: this.url,
      html: this.html,
      preload: this.preload,
      frame: this.frame,
      rpc: rpc2
    });
    this.webviewId = webview.id;
    zigRPC.request.setContentView({
      windowId: this.id,
      webviewId: webview.id
    });
    if (this.url) {
      webview.loadURL(this.url);
    } else if (this.html) {
      webview.loadHTML(this.html);
    }
    BrowserWindowMap[this.id] = this;
  }
  get webview() {
    return BrowserView.getById(this.webviewId);
  }
  setTitle(title) {
    this.title = title;
    return zigRPC.request.setTitle({ winId: this.id, title });
  }
  on(name, handler) {
    const specificName = `${name}-${this.id}`;
    eventEmitter_default.on(specificName, handler);
  }
}

// /Users/yoav/code/electrobun/example/node_modules/electrobun/src/bun/index.ts
var Electrobun = {
  BrowserWindow,
  BrowserView,
  events: eventEmitter_default
};
var bun_default = Electrobun;

// src/bun/index.ts
var myWebviewRPC = BrowserView.defineRPC({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      doMoreMath: ({ a, b }) => {
        console.log("\n\n\n\n");
        console.log(`win1 webview asked me to do more math with: ${a} and ${b}`);
        return a + b;
      }
    },
    messages: {
      "*": (messageName, payload) => {
        console.log("----------.,.,.,.", messageName, payload);
      },
      logToBun: ({ msg }) => {
        console.log("^^^^^^^^^^^^^^^^^^^^^^^^^------------............ received message", msg);
      }
    }
  }
});
var win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000
  },
  rpc: myWebviewRPC
});
win.setTitle("url browserwindow");
var wikiWindow = new BrowserWindow({
  title: "my url window",
  url: "https://en.wikipedia.org/wiki/Special:Random",
  preload: "views://myextension/preload.js",
  frame: {
    width: 1800,
    height: 600,
    x: 1000,
    y: 0
  },
  rpc: BrowserView.defineRPC({
    maxRequestTime: 5000,
    handlers: {
      requests: {},
      messages: {}
    }
  })
});
bun_default.events.on("will-navigate", (e) => {
  console.log("example global will navigate handler", e.data.url, e.data.webviewId);
  e.response = { allow: true };
});
wikiWindow.webview.on("will-navigate", (e) => {
  console.log("example webview will navigate handler", e.data.url, e.data.webviewId);
  if (e.responseWasSet && e.response.allow === false) {
    e.response.allow = true;
  }
});
wikiWindow.setTitle("New title from bun");
setTimeout(() => {
  win.webview.executeJavascript('document.body.innerHTML = "executing random js in win2 webview";');
  setTimeout(() => {
    wikiWindow.webview.rpc?.request.getTitle().then((result) => {
      console.log("\n\n\n\n");
      console.log(`visiting wikipedia article for: ${result}`);
      console.log("\n\n\n\n");
    }).catch((err) => {
      console.log("getTitle error", err);
    });
    win.webview.rpc?.request.doMath({ a: 3, b: 4 }).then((result) => {
      console.log("\n\n\n\n");
      console.log(`I asked win1 webview to do math and it said: ${result}`);
      console.log("\n\n\n\n");
    });
    win.webview.rpc?.send.logToWebview({ msg: "hi from bun!" });
  }, 1000);
}, 3000);
