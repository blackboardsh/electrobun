type WebviewEventTypes =
  | "did-navigate"
  | "did-navigate-in-page"
  | "did-commit-navigation"
  | "dom-ready";

const ConfigureWebviewTags = (
  enableWebviewTags: boolean,
  zigRpc: (params: any) => any,
  syncRpc: (params: any) => any
) => {
  if (!enableWebviewTags) {
    return;
  }

  // todo: provide global types for <electrobun-webview> tag elements (like querySelector results etc.)

  class WebviewTag extends HTMLElement {
    // todo (yoav): come up with a better mechanism to eliminate collisions with bun created
    // webviews
    webviewId?: number; // = nextWebviewId++;

    // rpc
    zigRpc: any;
    syncRpc: any;

    // observers
    resizeObserver?: ResizeObserver;
    // intersectionObserver?: IntersectionObserver;
    // mutationObserver?: MutationObserver;

    positionCheckLoop?: Timer;
    positionCheckLoopReset?: Timer;

    lastRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    };

    transparent: boolean = false;
    passthroughEnabled: boolean = false;
    hidden: boolean = false;
    delegateMode: boolean = false;
    hiddenMirrorMode: boolean = false;
    wasZeroRect: boolean = false;

    partition: string | null = null;

    constructor() {
      super();
      this.zigRpc = zigRpc;
      this.syncRpc = syncRpc;

      // Give it a frame to be added to the dom and render before measuring
      requestAnimationFrame(() => {
        this.initWebview();
      });
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
            y: rect.y,
          },
        },
      });

      this.webviewId = webviewId;
      this.id = `electrobun-webview-${this.webviewId}`;
      // todo: replace zig -> webviewtag communication with a global instead of
      // queryselector based on id
      this.setAttribute("id", this.id);
    }

    asyncResolvers: {
      [id: string]: { resolve: (arg: any) => void; reject: (arg: any) => void };
    } = {};

    callAsyncJavaScript({ script }: { script: string }) {
      return new Promise((resolve, reject) => {
        const messageId = "" + Date.now() + Math.random();
        this.asyncResolvers[messageId] = {
          resolve,
          reject,
        };

        this.zigRpc.request.webviewTagCallAsyncJavaScript({
          messageId,
          webviewId: this.webviewId,
          hostWebviewId: window.__electrobunWebviewId,
          script,
        });
      });
    }

    setCallAsyncJavaScriptResponse(messageId: string, response: any) {
      const resolvers = this.asyncResolvers[messageId];
      delete this.asyncResolvers[messageId];
      try {
        response = JSON.parse(response);

        if (response.result) {
          resolvers.resolve(response.result);
        } else {
          resolvers.reject(response.error);
        }
      } catch (e: any) {
        resolvers.reject(e.message);
      }
    }

    async canGoBack() {
      const {
        payload: { webviewTagCanGoBackResponse },
      } = await this.zigRpc.request.webviewTagCanGoBack({ id: this.webviewId });
      return webviewTagCanGoBackResponse;
    }

    async canGoForward() {
      const {
        payload: { webviewTagCanGoForwardResponse },
      } = await this.zigRpc.request.webviewTagCanGoForward({
        id: this.webviewId,
      });
      return webviewTagCanGoForwardResponse;
    }

    // propertie setters/getters. keeps them in sync with dom attributes
    updateAttr(name: string, value: string | null) {
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

    // Note: since <electrobun-webview> is an anchor for a native webview
    // on osx even if we hide it, enable mouse passthrough etc. There
    // are still events like drag events which are natively handled deep in the window manager
    // and will be handled incorrectly. To get around this for now we need to
    // move the webview off screen during delegate mode.
    adjustDimensionsForHiddenMirrorMode(rect: DOMRect) {
      if (this.hiddenMirrorMode) {
        rect.x = 0 - rect.width;
      }

      return rect;
    }

    // Note: in the brwoser-context we can ride on the dom element's uilt in event emitter for managing custom events
    on(event: WebviewEventTypes, listener: () => {}) {
      this.addEventListener(event, listener);
    }

    off(event: WebviewEventTypes, listener: () => {}) {
      this.removeEventListener(event, listener);
    }

    // This is typically called by injected js from zig
    emit(event: WebviewEventTypes, detail: any) {
      this.dispatchEvent(new CustomEvent(event, { detail }));
    }

    // Call this via document.querySelector('electrobun-webview').syncDimensions();
    // That way the host can trigger an alignment with the nested webview when they
    // know that they're chaning something in order to eliminate the lag that the
    // catch all loop will catch
    syncDimensions(force: boolean = false) {
      const rect = this.getBoundingClientRect();
      const { x, y, width, height } =
        this.adjustDimensionsForHiddenMirrorMode(rect);
      const lastRect = this.lastRect;

      if (width === 0 && height === 0) {
        if (this.wasZeroRect === false) {
          this.wasZeroRect = true;
          this.toggleHidden(true, true);
          this.stopMirroring();
        }
        return;
      }

      if (
        force ||
        lastRect.x !== x ||
        lastRect.y !== y ||
        lastRect.width !== width ||
        lastRect.height !== height
      ) {
        // if we're not already in an accelerated loop then accelerate it
        if (!this.positionCheckLoopReset) {
          this.setPositionCheckLoop(true);
        }

        this.lastRect = rect;

        this.zigRpc.send.webviewTagResize({
          id: this.webviewId,
          frame: {
            width: width,
            height: height,
            x: x,
            y: y,
          },
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
        clearTimeout(this.positionCheckLoopReset);
        this.positionCheckLoopReset = setTimeout(() => {
          this.setPositionCheckLoop(false);
        }, 600);
      }
      // Note: Since there's not catch all way to listen for x/y changes
      // we have a 400ms interval to check
      // on m1 max this 400ms interval for one nested webview
      // only uses around 0.1% cpu

      // Note: We also listen for resize events and changes to
      // certain properties to get reactive repositioning for
      // many cases.

      // todo: consider having an option to disable this and let user
      // trigger position sync for high performance cases (like
      // a browser with a hundred tabs)
      this.positionCheckLoop = setInterval(() => this.syncDimensions(), delay);
    }

    connectedCallback() {
      this.setPositionCheckLoop();

      this.resizeObserver = new ResizeObserver(() => {
        this.syncDimensions();
      });
      // Note: In objc the webview is positioned in the window from the bottom-left corner
      // the html anchor is positioned in the webview from the top-left corner
      // In those cases the getBoundingClientRect() will return the same value, but
      // we still need to send it to objc to calculate from its bottom left position
      // otherwise it'll move around unexpectedly.
      window.addEventListener("resize", this.boundForceSyncDimensions);

      window.addEventListener("scroll", this.boundSyncDimensions);

      // todo: For chromium webviews (windows native or chromium bundled)
      // should be able to use performanceObservers on layout-shift to
      // call syncDimensions more reactively
    }

    disconnectedCallback() {
      // removed from the dom
      clearInterval(this.positionCheckLoop);
      this.stopMirroring();

      this.resizeObserver?.disconnect();
      // this.intersectionObserver?.disconnect();
      // this.mutationObserver?.disconnect();
      window.removeEventListener("resize", this.boundForceSyncDimensions);
      window.removeEventListener("scroll", this.boundSyncDimensions);
      this.zigRpc.send.webviewTagRemove({ id: this.webviewId });
    }

    static get observedAttributes() {
      // TODO: support html, preload, and other stuff here
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

    updateIFrameSrc(src: string) {
      if (!this.webviewId) {
        return;
      }
      this.zigRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: src,
      });
    }

    updateIFrameHtml(html: string) {
      if (!this.webviewId) {
        return;
      }
      this.zigRpc.send.webviewTagUpdateHtml({
        id: this.webviewId,
        html,
      });
    }

    updateIFramePreload(preload: string) {
      if (!this.webviewId) {
        return;
      }
      this.zigRpc.send.webviewTagUpdatePreload({
        id: this.webviewId,
        preload,
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
    loadURL(url: string) {
      this.setAttribute("src", url);
      this.zigRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url,
      });
    }
    // Note: you can set an interval and do this 60 times a second and it's pretty smooth
    // but it uses quite a bit of cpu
    // todo: change this to "mirror to dom" or something
    syncScreenshot(callback?: () => void) {
      const cacheBustString = `?${Date.now()}`;
      const url = `views://screenshot/${this.webviewId}${cacheBustString}`;
      const img = new Image();
      img.src = url;
      img.onload = () => {
        this.style.backgroundImage = `url(${url})`;
        if (callback) {
          // We've preloaded the image, but we still want to give it a chance to render
          // after setting the background style. give it quite a bit longer than a rafr
          setTimeout(callback, 100);
        }
      };
    }

    DEFAULT_FRAME_RATE = Math.round(1000 / 30); // 30fps
    streamScreenInterval?: Timer;

    // NOTE: This is very cpu intensive, Prefer startMirroring where possible
    startMirroringToDom(frameRate: number = this.DEFAULT_FRAME_RATE) {
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
      this.zigRpc.send.webviewTagToggleMirroring({
        id: this.webviewId,
        enable: true,
      });
    }

    stopMirroring() {
      this.zigRpc.send.webviewTagToggleMirroring({
        id: this.webviewId,
        enable: false,
      });
    }

    clearScreenImage() {
      this.style.backgroundImage = "";
    }

    tryClearScreenImage() {
      if (
        !this.transparent &&
        !this.hiddenMirrorMode &&
        !this.delegateMode &&
        !this.hidden
      ) {
        this.clearScreenImage();
      }
    }
    // This sets the native webview hovering over the dom to be transparent
    toggleTransparent(transparent?: boolean, bypassState?: boolean) {
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
        transparent: this.transparent || Boolean(transparent),
      });
    }
    togglePassthrough(enablePassthrough?: boolean, bypassState?: boolean) {
      if (!bypassState) {
        if (typeof enablePassthrough === "undefined") {
          this.passthroughEnabled = !this.passthroughEnabled;
        } else {
          this.passthroughEnabled = enablePassthrough;
        }
      }

      this.zigRpc.send.webviewTagSetPassthrough({
        id: this.webviewId,
        enablePassthrough:
          this.passthroughEnabled || Boolean(enablePassthrough),
      });
    }

    toggleHidden(hidden?: boolean, bypassState?: boolean) {
      if (!bypassState) {
        if (typeof hidden === "undefined") {
          this.hidden = !this.hidden;
        } else {
          this.hidden = hidden;
        }
      }

      this.zigRpc.send.webviewTagSetHidden({
        id: this.webviewId,
        hidden: this.hidden || Boolean(hidden),
      });
    }

    // note: delegateMode and hiddenMirrorMode are experimental
    // ideally delegate mode would move the webview off screen
    // and delegate mouse and keyboard events to the webview while
    // streaming the screen so it can be fully layered in the dom
    // and fully interactive.
    toggleDelegateMode(delegateMode?: boolean) {
      const _newDelegateMode =
        typeof delegateMode === "undefined" ? !this.delegateMode : delegateMode;

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

    // While hiddenMirroMode would be similar to delegate mode but non-interactive
    // This is used while scrolling or resizing the <electrobun-webviewtag> to
    // make it smoother (scrolls with the dom) but disables interaction so that
    // during the scroll we don't need to worry about the webview being misaligned
    // with the mirror and accidentlly clicking on the wrong thing.
    toggleHiddenMirrorMode(force: boolean) {
      const enable =
        typeof force === "undefined" ? !this.hiddenMirrorMode : force;

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

// Give <electrobun-webview>s some default styles that can
// be easily overridden in the host document
const insertWebviewTagNormalizationStyles = () => {
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

export { ConfigureWebviewTags };
