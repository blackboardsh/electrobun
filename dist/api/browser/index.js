// node_modules/rpc-anywhere/dist/esm/rpc.js
function missingTransportMethodError(methods, action) {
  const methodsString = methods.map((method) => `"${method}"`).join(", ");
  return new Error(`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`);
}
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

// node_modules/rpc-anywhere/dist/esm/create-rpc.js
function createRPC(options) {
  return _createRPC(options);
}
// src/browser/webviewtag.ts
var ConfigureWebviewTags = (enableWebviewTags, zigRpc, syncRpc) => {
  if (!enableWebviewTags) {
    return;
  }

  class WebviewTag extends HTMLElement {
    webviewId;
    zigRpc;
    syncRpc;
    maskSelectors = new Set;
    resizeObserver;
    positionCheckLoop;
    positionCheckLoopReset;
    lastRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0
    };
    lastMasksJSON = "";
    lastMasks = [];
    transparent = false;
    passthroughEnabled = false;
    hidden = false;
    delegateMode = false;
    hiddenMirrorMode = false;
    wasZeroRect = false;
    isMirroring = false;
    partition = null;
    constructor() {
      super();
      this.zigRpc = zigRpc;
      this.syncRpc = syncRpc;
      requestAnimationFrame(() => {
        this.initWebview();
      });
    }
    addMaskSelector(selector) {
      this.maskSelectors.add(selector);
      this.syncDimensions();
    }
    removeMaskSelector(selector) {
      this.maskSelectors.delete(selector);
      this.syncDimensions();
    }
    initWebview() {
      const rect = this.getBoundingClientRect();
      this.lastRect = rect;
      const webviewId = this.syncRpc({
        method: "webviewTagInit",
        params: {
          hostWebviewId: window.__electrobunWebviewId,
          windowId: window.__electrobunWindowId,
          url: this.src || this.getAttribute("src") || null,
          html: this.html || this.getAttribute("html") || null,
          preload: this.preload || this.getAttribute("preload") || null,
          partition: this.partition || this.getAttribute("partition") || null,
          frame: {
            width: rect.width,
            height: rect.height,
            x: rect.x,
            y: rect.y
          }
        }
      });
      this.webviewId = webviewId;
      this.id = `electrobun-webview-${this.webviewId}`;
      this.setAttribute("id", this.id);
    }
    asyncResolvers = {};
    callAsyncJavaScript({ script }) {
      return new Promise((resolve, reject) => {
        const messageId = "" + Date.now() + Math.random();
        this.asyncResolvers[messageId] = {
          resolve,
          reject
        };
        this.zigRpc.request.webviewTagCallAsyncJavaScript({
          messageId,
          webviewId: this.webviewId,
          hostWebviewId: window.__electrobunWebviewId,
          script
        });
      });
    }
    setCallAsyncJavaScriptResponse(messageId, response) {
      const resolvers = this.asyncResolvers[messageId];
      delete this.asyncResolvers[messageId];
      try {
        response = JSON.parse(response);
        if (response.result) {
          resolvers.resolve(response.result);
        } else {
          resolvers.reject(response.error);
        }
      } catch (e) {
        resolvers.reject(e.message);
      }
    }
    async canGoBack() {
      const {
        payload: { webviewTagCanGoBackResponse }
      } = await this.zigRpc.request.webviewTagCanGoBack({ id: this.webviewId });
      return webviewTagCanGoBackResponse;
    }
    async canGoForward() {
      const {
        payload: { webviewTagCanGoForwardResponse }
      } = await this.zigRpc.request.webviewTagCanGoForward({
        id: this.webviewId
      });
      return webviewTagCanGoForwardResponse;
    }
    updateAttr(name, value) {
      if (value) {
        this.setAttribute(name, value);
      } else {
        this.removeAttribute(name);
      }
    }
    get src() {
      return this.getAttribute("src");
    }
    set src(value) {
      this.updateAttr("src", value);
    }
    get html() {
      return this.getAttribute("html");
    }
    set html(value) {
      this.updateAttr("html", value);
    }
    get preload() {
      return this.getAttribute("preload");
    }
    set preload(value) {
      this.updateAttr("preload", value);
    }
    adjustDimensionsForHiddenMirrorMode(rect) {
      if (this.hiddenMirrorMode) {
        rect.x = 0 - rect.width;
      }
      return rect;
    }
    on(event, listener) {
      this.addEventListener(event, listener);
    }
    off(event, listener) {
      this.removeEventListener(event, listener);
    }
    emit(event, detail) {
      this.dispatchEvent(new CustomEvent(event, { detail }));
    }
    syncDimensions(force = false) {
      if (!force && this.hidden) {
        return;
      }
      const rect = this.getBoundingClientRect();
      const { x, y, width, height } = this.adjustDimensionsForHiddenMirrorMode(rect);
      const lastRect = this.lastRect;
      if (width === 0 && height === 0) {
        if (this.wasZeroRect === false) {
          this.wasZeroRect = true;
          this.toggleHidden(true, true);
        }
        return;
      }
      const masks = [];
      this.maskSelectors.forEach((selector) => {
        const els = document.querySelectorAll(selector);
        for (let i = 0;i < els.length; i++) {
          const el = els[i];
          if (el) {
            const maskRect = el.getBoundingClientRect();
            masks.push({
              x: maskRect.x - x,
              y: maskRect.y - y,
              width: maskRect.width,
              height: maskRect.height
            });
          }
        }
      });
      const masksJson = masks.length ? JSON.stringify(masks) : "";
      if (force || lastRect.x !== x || lastRect.y !== y || lastRect.width !== width || lastRect.height !== height || this.lastMasksJSON !== masksJson) {
        this.setPositionCheckLoop(true);
        this.lastRect = rect;
        this.lastMasks = masks;
        this.lastMasksJSON = masksJson;
        this.zigRpc.send.webviewTagResize({
          id: this.webviewId,
          frame: {
            width,
            height,
            x,
            y
          },
          masks: masksJson
        });
      }
      if (this.wasZeroRect) {
        this.wasZeroRect = false;
        this.toggleHidden(false, true);
      }
    }
    boundSyncDimensions = () => this.syncDimensions();
    boundForceSyncDimensions = () => this.syncDimensions(true);
    setPositionCheckLoop(accelerate = false) {
      if (this.positionCheckLoop) {
        clearInterval(this.positionCheckLoop);
        this.positionCheckLoop = undefined;
      }
      if (this.positionCheckLoopReset) {
        clearTimeout(this.positionCheckLoopReset);
        this.positionCheckLoopReset = undefined;
      }
      const delay = accelerate ? 0 : 300;
      if (accelerate) {
        this.positionCheckLoopReset = setTimeout(() => {
          this.setPositionCheckLoop(false);
        }, 2000);
      }
      this.positionCheckLoop = setInterval(() => this.syncDimensions(), delay);
    }
    connectedCallback() {
      this.setPositionCheckLoop();
      this.resizeObserver = new ResizeObserver(() => {
        this.syncDimensions();
      });
      window.addEventListener("resize", this.boundForceSyncDimensions);
      window.addEventListener("scroll", this.boundSyncDimensions);
    }
    disconnectedCallback() {
      clearInterval(this.positionCheckLoop);
      this.resizeObserver?.disconnect();
      window.removeEventListener("resize", this.boundForceSyncDimensions);
      window.removeEventListener("scroll", this.boundSyncDimensions);
      this.zigRpc.send.webviewTagRemove({ id: this.webviewId });
    }
    static get observedAttributes() {
      return ["src", "html", "preload", "class", "style"];
    }
    attributeChangedCallback(name, oldValue, newValue) {
      if (name === "src" && oldValue !== newValue) {
        this.updateIFrameSrc(newValue);
      } else if (name === "html" && oldValue !== newValue) {
        this.updateIFrameHtml(newValue);
      } else if (name === "preload" && oldValue !== newValue) {
        this.updateIFramePreload(newValue);
      } else {
        this.syncDimensions();
      }
    }
    updateIFrameSrc(src) {
      if (!this.webviewId) {
        return;
      }
      this.zigRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: src
      });
    }
    updateIFrameHtml(html) {
      if (!this.webviewId) {
        return;
      }
      this.zigRpc.send.webviewTagUpdateHtml({
        id: this.webviewId,
        html
      });
    }
    updateIFramePreload(preload) {
      if (!this.webviewId) {
        return;
      }
      this.zigRpc.send.webviewTagUpdatePreload({
        id: this.webviewId,
        preload
      });
    }
    goBack() {
      this.zigRpc.send.webviewTagGoBack({ id: this.webviewId });
    }
    goForward() {
      this.zigRpc.send.webviewTagGoForward({ id: this.webviewId });
    }
    reload() {
      this.zigRpc.send.webviewTagReload({ id: this.webviewId });
    }
    loadURL(url) {
      this.setAttribute("src", url);
      this.zigRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url
      });
    }
    syncScreenshot(callback) {
      const cacheBustString = `?${Date.now()}`;
      const url = `views://screenshot/${this.webviewId}${cacheBustString}`;
      const img = new Image;
      img.src = url;
      img.onload = () => {
        this.style.backgroundImage = `url(${url})`;
        if (callback) {
          setTimeout(callback, 100);
        }
      };
    }
    DEFAULT_FRAME_RATE = Math.round(1000 / 30);
    streamScreenInterval;
    startMirroringToDom(frameRate = this.DEFAULT_FRAME_RATE) {
      if (this.streamScreenInterval) {
        clearInterval(this.streamScreenInterval);
      }
      this.streamScreenInterval = setInterval(() => {
        this.syncScreenshot();
      }, frameRate);
    }
    stopMirroringToDom() {
      if (this.streamScreenInterval) {
        clearInterval(this.streamScreenInterval);
        this.streamScreenInterval = undefined;
      }
    }
    startMirroring() {
      return;
      if (this.isMirroring === false) {
        this.isMirroring = true;
        this.zigRpc.send.webviewTagToggleMirroring({
          id: this.webviewId,
          enable: true
        });
      }
    }
    stopMirroring() {
      return;
      if (this.isMirroring === true) {
        this.isMirroring = false;
        this.zigRpc.send.webviewTagToggleMirroring({
          id: this.webviewId,
          enable: false
        });
      }
    }
    clearScreenImage() {
      this.style.backgroundImage = "";
    }
    tryClearScreenImage() {
      if (!this.transparent && !this.hiddenMirrorMode && !this.delegateMode && !this.hidden) {
        this.clearScreenImage();
      }
    }
    toggleTransparent(transparent, bypassState) {
      if (!bypassState) {
        if (typeof transparent === "undefined") {
          this.transparent = !this.transparent;
        } else {
          this.transparent = transparent;
        }
      }
      if (!this.transparent && !transparent) {
        this.tryClearScreenImage();
      }
      this.zigRpc.send.webviewTagSetTransparent({
        id: this.webviewId,
        transparent: this.transparent || Boolean(transparent)
      });
    }
    togglePassthrough(enablePassthrough, bypassState) {
      if (!bypassState) {
        if (typeof enablePassthrough === "undefined") {
          this.passthroughEnabled = !this.passthroughEnabled;
        } else {
          this.passthroughEnabled = enablePassthrough;
        }
      }
      this.zigRpc.send.webviewTagSetPassthrough({
        id: this.webviewId,
        enablePassthrough: this.passthroughEnabled || Boolean(enablePassthrough)
      });
    }
    toggleHidden(hidden, bypassState) {
      if (!bypassState) {
        if (typeof hidden === "undefined") {
          this.hidden = !this.hidden;
        } else {
          this.hidden = hidden;
        }
      }
      this.zigRpc.send.webviewTagSetHidden({
        id: this.webviewId,
        hidden: this.hidden || Boolean(hidden)
      });
    }
    toggleDelegateMode(delegateMode) {
      const _newDelegateMode = typeof delegateMode === "undefined" ? !this.delegateMode : delegateMode;
      if (_newDelegateMode) {
        this.syncScreenshot(() => {
          this.delegateMode = true;
          this.toggleTransparent(true, true);
          this.startMirroringToDom();
        });
      } else {
        this.delegateMode = false;
        this.stopMirroringToDom();
        this.toggleTransparent(this.transparent);
        this.tryClearScreenImage();
      }
    }
    toggleHiddenMirrorMode(force) {
      const enable = typeof force === "undefined" ? !this.hiddenMirrorMode : force;
      if (enable === true) {
        this.syncScreenshot(() => {
          this.hiddenMirrorMode = true;
          this.toggleHidden(true, true);
          this.togglePassthrough(true, true);
          this.startMirroringToDom();
        });
      } else {
        this.stopMirroringToDom();
        this.toggleHidden(this.hidden);
        this.togglePassthrough(this.passthroughEnabled);
        this.tryClearScreenImage();
        this.hiddenMirrorMode = false;
      }
    }
  }
  customElements.define("electrobun-webview", WebviewTag);
  insertWebviewTagNormalizationStyles();
};
var insertWebviewTagNormalizationStyles = () => {
  var style = document.createElement("style");
  style.type = "text/css";
  var css = `
electrobun-webview {
    display: block;
    width: 800px;
    height: 300px;
    background: #fff;
    background-repeat: no-repeat!important;   
    overflow: hidden; 
}
`;
  style.appendChild(document.createTextNode(css));
  var head = document.getElementsByTagName("head")[0];
  if (!head) {
    return;
  }
  if (head.firstChild) {
    head.insertBefore(style, head.firstChild);
  } else {
    head.appendChild(style);
  }
};

// src/browser/stylesAndElements.ts
var isAppRegionDrag = (e) => {
  return e.target?.classList.contains("electrobun-webkit-app-region-drag");
};

// src/browser/index.ts
var WEBVIEW_ID = window.__electrobunWebviewId;

class Electroview {
  rpc;
  rpcHandler;
  zigRpc;
  zigRpcHandler;
  syncRpc = () => {
    console.log("syncRpc not initialized");
  };
  constructor(config) {
    this.rpc = config.rpc;
    this.init();
  }
  init() {
    this.initZigRpc();
    if (true) {
      this.syncRpc = (msg) => {
        try {
          const messageString = JSON.stringify(msg);
          return this.bunBridgeSync(messageString);
        } catch (error) {
          console.error("bun: failed to serialize message to webview syncRpc", error);
        }
      };
    }
    ConfigureWebviewTags(true, this.zigRpc, this.syncRpc);
    this.initElectrobunListeners();
    window.__electrobun = {
      receiveMessageFromBun: this.receiveMessageFromBun.bind(this),
      receiveMessageFromZig: this.receiveMessageFromZig.bind(this)
    };
    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }
  initZigRpc() {
    this.zigRpc = createRPC({
      transport: this.createZigTransport(),
      maxRequestTime: 1000
    });
  }
  receiveMessageFromZig(msg) {
    if (this.zigRpcHandler) {
      this.zigRpcHandler(msg);
    }
  }
  sendToZig(message) {
    window.webkit.messageHandlers.webviewTagBridge.postMessage(JSON.stringify(message));
  }
  initElectrobunListeners() {
    document.addEventListener("mousedown", (e) => {
      if (isAppRegionDrag(e)) {
        this.zigRpc?.send.startWindowMove({ id: WEBVIEW_ID });
      }
    });
    document.addEventListener("mouseup", (e) => {
      if (isAppRegionDrag(e)) {
        this.zigRpc?.send.stopWindowMove({ id: WEBVIEW_ID });
      }
    });
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
  createZigTransport() {
    const that = this;
    return {
      send(message) {
        window.webkit.messageHandlers.webviewTagBridge.postMessage(JSON.stringify(message));
      },
      registerHandler(handler) {
        that.zigRpcHandler = handler;
      }
    };
  }
  bunBridgeSync(msg) {
    var xhr = new XMLHttpRequest;
    xhr.open("POST", "views://syncrpc", false);
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
  bunBridge(msg) {
    if (true) {
      window.webkit.messageHandlers.bunBridge.postMessage(msg);
    } else {
      var xhr;
    }
  }
  receiveMessageFromBun(msg) {
    if (this.rpcHandler) {
      this.rpcHandler(msg);
    }
  }
  static defineRPC(config) {
    const builtinHandlers = {
      requests: {
        evaluateJavascriptWithResponse: ({ script }) => {
          return new Promise((resolve) => {
            try {
              const resultFunction = new Function(script);
              const result = resultFunction();
              if (result instanceof Promise) {
                result.then((resolvedResult) => {
                  resolve(resolvedResult);
                }).catch((error) => {
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
        }
      }
    };
    const rpcOptions = {
      maxRequestTime: config.maxRequestTime,
      requestHandler: {
        ...config.handlers.requests,
        ...builtinHandlers.requests
      },
      transport: {
        registerHandler: () => {
        }
      }
    };
    const rpc = createRPC(rpcOptions);
    const messageHandlers = config.handlers.messages;
    if (messageHandlers) {
      rpc.addMessageListener("*", (messageName, payload) => {
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
    return rpc;
  }
}
var Electrobun = {
  Electroview
};
var browser_default = Electrobun;
export {
  browser_default as default,
  createRPC,
  Electroview
};

//# debugId=0C464F3546058B4E64756E2164756E21
