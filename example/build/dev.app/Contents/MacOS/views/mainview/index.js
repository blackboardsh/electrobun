// /Users/yoav/code/electrobun/src/browser/node_modules/rpc-anywhere/dist/esm/rpc.js
var missingTransportMethodError = function(methods, action) {
  const methodsString = methods.map((method) => `"${method}"`).join(", ");
  return new Error(`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`);
};
function _createRPC(options = {}) {
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
    proxy
  };
}
var MAX_ID = 10000000000;
var DEFAULT_MAX_REQUEST_TIME = 1000;

// /Users/yoav/code/electrobun/src/browser/node_modules/rpc-anywhere/dist/esm/create-rpc.js
function createRPC(options) {
  return _createRPC(options);
}
// /Users/yoav/code/electrobun/example/node_modules/electrobun/src/browser/index.ts
class Electroview {
  rpc;
  rpcHandler;
  constructor(config) {
    this.rpc = config.rpc;
    this.init();
  }
  init() {
    window.__electrobun = {
      receiveMessageFromBun: this.receiveMessageFromBun.bind(this)
    };
    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
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
      }
    };
  }
  bunBridge(msg) {
    window.webkit.messageHandlers.bunBridge.postMessage(msg);
  }
  receiveMessageFromBun(msg) {
    document.body.innerHTML += "receiving message from bun";
    if (this.rpcHandler) {
      this.rpcHandler(msg);
    }
  }
}
var ElectrobunView = {
  Electroview
};
var browser_default = ElectrobunView;

// src/mainview/index.ts
var rpc2 = createRPC({
  requestHandler: {
    doMath: ({ a, b }) => {
      document.body.innerHTML += `bun asked me to do math with ${a} and ${b}\n`;
      return a + b;
    }
  }
});
var electrobun = new browser_default.Electroview({ rpc: rpc2 });
setTimeout(() => {
  if (electrobun.rpc) {
    electrobun.rpc.request.doMoreMath({ a: 9, b: 8 }).then((result) => {
      document.body.innerHTML += `I asked bun to do more math and it said ${result}\n`;
    });
    electrobun.rpc.send.logToBun({ msg: "hello from webview" });
  }
}, 5000);
