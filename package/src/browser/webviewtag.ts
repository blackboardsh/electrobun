type WebviewEventTypes =
  | "did-navigate"
  | "did-navigate-in-page"
  | "did-commit-navigation"
  | "dom-ready"
  | "host-message";

type Rect = { x: number; y: number; width: number; height: number };

const ConfigureWebviewTags = (
  enableWebviewTags: boolean,
  internalRpc: (params: any) => any,
  bunRpc: (params: any) => any
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
    internalRpc: any;
    bunRpc: any;

    // querySelectors for elements that you want to appear
    // in front of the webview.
    maskSelectors: Set<string> = new Set();

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

    lastMasksJSON: string = "";
    lastMasks: Rect[] = [];

    transparent: boolean = false;
    passthroughEnabled: boolean = false;
    hidden: boolean = false;    
    hiddenMirrorMode: boolean = false;
    wasZeroRect: boolean = false;
    isMirroring: boolean = false;
    masks: string = '';

    partition: string | null = null;

    constructor() {
      super();
      this.internalRpc = internalRpc;
      this.bunRpc = bunRpc;      

      // Give it a frame to be added to the dom and render before measuring
      requestAnimationFrame(() => {
        this.initWebview();
      });
    }

    addMaskSelector(selector: string) {
      this.maskSelectors.add(selector);
      this.syncDimensions();
    }

    removeMaskSelector(selector: string) {
      this.maskSelectors.delete(selector);
      this.syncDimensions();
    }

    async initWebview() {      
      const rect = this.getBoundingClientRect();
      this.lastRect = rect;

      const url = this.src || this.getAttribute("src");
      const html = this.html || this.getAttribute("html");   
      
      const maskSelectors = this.masks || this.getAttribute("masks");

      if (maskSelectors) {
        maskSelectors.split(',').forEach(s => {
          this.maskSelectors.add(s);
        })
      }

      const webviewId = await this.internalRpc.request.webviewTagInit({        
        hostWebviewId: window.__electrobunWebviewId,
        windowId: window.__electrobunWindowId,
        renderer: this.renderer,
        url: url, 
        html: html,         
        preload: this.preload || this.getAttribute("preload") || null,
        partition: this.partition || this.getAttribute("partition") || null,
        frame: {
          width: rect.width,
          height: rect.height,
          x: rect.x,
          y: rect.y,
        },
        // todo: wire up to a param and a method to update them
        navigationRules: null,        
      });
      console.log('electrobun webviewid: ', webviewId)
      this.webviewId = webviewId;
      this.id = `electrobun-webview-${webviewId}`;
      // todo: replace bun -> webviewtag communication with a global instead of
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

        this.internalRpc.request.webviewTagCallAsyncJavaScript({
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
      return this.internalRpc.request.webviewTagCanGoBack({ id: this.webviewId });      
    }

    async canGoForward() {
      return this.internalRpc.request.webviewTagCanGoForward({
        id: this.webviewId,
      });      
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

    get renderer() {
      const _renderer = this.getAttribute("renderer") === "cef" ? "cef" : "native";
      return _renderer;
    }

    set renderer(value: 'cef' | 'native') {
      const _renderer = value === "cef" ? "cef" : "native";
      this.updateAttr("renderer", _renderer);
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

    // This is typically called by injected js from bun
    emit(event: WebviewEventTypes, detail: any) {
      this.dispatchEvent(new CustomEvent(event, { detail }));
    }

    // Call this via document.querySelector('electrobun-webview').syncDimensions();
    // That way the host can trigger an alignment with the nested webview when they
    // know that they're chaning something in order to eliminate the lag that the
    // catch all loop will catch
    syncDimensions(force: boolean = false) {
      if (!this.webviewId || (!force && this.hidden)) {
        return;
      }

      const rect = this.getBoundingClientRect();
      const { x, y, width, height } =
        this.adjustDimensionsForHiddenMirrorMode(rect);
      const lastRect = this.lastRect;

      if (width === 0 && height === 0) {
        if (this.wasZeroRect === false) {
          console.log('WAS NOT ZERO RECT', this.webviewId)
          this.wasZeroRect = true;
          this.toggleTransparent(true, true);
          this.togglePassthrough(true, true);
        }
        return;
      }

      const masks: Rect[] = [];
      this.maskSelectors.forEach((selector) => {
        const els = document.querySelectorAll(selector);

        for (let i = 0; i < els.length; i++) {
          const el = els[i];

          if (el) {
            const maskRect = el.getBoundingClientRect();

            masks.push({
              // reposition the bounding rect to be relative to the webview rect
              // so objc can apply the mask correctly and handle the actual overlap
              x: maskRect.x - x,
              y: maskRect.y - y,
              width: maskRect.width,
              height: maskRect.height,
            });
          }
        }
      });

      // store jsonStringified last masks value to compare
      const masksJson = masks.length ? JSON.stringify(masks) : "";

      if (
        force ||
        lastRect.x !== x ||
        lastRect.y !== y ||
        lastRect.width !== width ||
        lastRect.height !== height ||
        this.lastMasksJSON !== masksJson
      ) {
        // let it know we're still accelerating
        this.setPositionCheckLoop(true);

        this.lastRect = rect;
        this.lastMasks = masks;
        this.lastMasksJSON = masksJson;
        
        this.internalRpc.send.webviewTagResize({
          id: this.webviewId,
          frame: {
            width: width,
            height: height,
            x: x,
            y: y,
          },
          masks: masksJson,
        });
      }

      if (this.wasZeroRect) {
        this.wasZeroRect = false;
        console.log('WAS ZERO RECT', this.webviewId)
        this.toggleTransparent(false, true);
        this.togglePassthrough(false, true);
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

      this.resizeObserver?.disconnect();
      // this.intersectionObserver?.disconnect();
      // this.mutationObserver?.disconnect();
      window.removeEventListener("resize", this.boundForceSyncDimensions);
      window.removeEventListener("scroll", this.boundSyncDimensions);
      
      if (this.webviewId) {
        this.internalRpc.send.webviewTagRemove({ id: this.webviewId });
        // Mark webview as removed to prevent further method calls
        this.webviewId = undefined;
      }
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
        console.warn('updateIFrameSrc called on removed webview');
        return;
      }
      this.internalRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: src,
      });
    }

    updateIFrameHtml(html: string) {
      if (!this.webviewId) {
        console.warn('updateIFrameHtml called on removed webview');
        return;
      }
      
      this.internalRpc.send.webviewTagUpdateHtml({
        id: this.webviewId,
        html: html,
      });
    }

    updateIFramePreload(preload: string) {
      if (!this.webviewId) {
        console.warn('updateIFramePreload called on removed webview');
        return;
      }
      this.internalRpc.send.webviewTagUpdatePreload({
        id: this.webviewId,
        preload,
      });
    }

    goBack() {
      if (!this.webviewId) {
        console.warn('goBack called on removed webview');
        return;
      }
      this.internalRpc.send.webviewTagGoBack({ id: this.webviewId });
    }

    goForward() {
      if (!this.webviewId) {
        console.warn('goForward called on removed webview');
        return;
      }
      this.internalRpc.send.webviewTagGoForward({ id: this.webviewId });
    }

    reload() {
      if (!this.webviewId) {
        console.warn('reload called on removed webview');
        return;
      }
      this.internalRpc.send.webviewTagReload({ id: this.webviewId });
    }
    loadURL(url: string) {
      if (!this.webviewId) {
        console.warn('loadURL called on removed webview');
        return;
      }
      this.setAttribute("src", url);
      this.internalRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url,
      });
    }
    loadHTML(html: string) {
      if (!this.webviewId) {
        console.warn('loadHTML called on removed webview');
        return;
      }
      this.setAttribute("html", html);
      this.internalRpc.send.webviewTagUpdateHtml({
        id: this.webviewId,
        html,
      })
    }

    // This sets the native webview hovering over the dom to be transparent
    toggleTransparent(transparent?: boolean, bypassState?: boolean) {
      if (!this.webviewId) {
        console.warn('toggleTransparent called on removed webview');
        return;
      }

      let newValue;
      if (typeof transparent === "undefined") {
        newValue = !this.transparent;
      } else {
        newValue = Boolean(transparent);
      }

      if (!bypassState) {
        this.transparent = newValue;
      }               

      this.internalRpc.send.webviewTagSetTransparent({
        id: this.webviewId,
        transparent: newValue,
      });
    }
    togglePassthrough(enablePassthrough?: boolean, bypassState?: boolean) {
      if (!this.webviewId) {
        console.warn('togglePassthrough called on removed webview');
        return;
      }

      let newValue;
      if (typeof enablePassthrough === "undefined") {
        newValue = !this.passthroughEnabled;
      } else {
        newValue = Boolean(enablePassthrough);
      }

      if (!bypassState) {        
        this.passthroughEnabled = newValue;        
      }

      this.internalRpc.send.webviewTagSetPassthrough({
        id: this.webviewId,
        enablePassthrough:
          this.passthroughEnabled || Boolean(enablePassthrough),
      });
    }

    toggleHidden(hidden?: boolean, bypassState?: boolean) {
      if (!this.webviewId) {
        console.warn('toggleHidden called on removed webview');
        return;
      }

      let newValue;
      if (typeof hidden === "undefined") {
        newValue = !this.hidden;
      } else {
        newValue = Boolean(hidden);
      }

      if (!bypassState) {       
        this.hidden = newValue;        
      }

      console.trace('electrobun toggle hidden: ', this.hidden, this.webviewId)
      this.internalRpc.send.webviewTagSetHidden({
        id: this.webviewId,
        hidden: this.hidden|| Boolean(hidden),
      });
    }

    setNavigationRules(rules: string[]) {
      if (!this.webviewId) {
        console.warn('setNavigationRules called on removed webview');
        return;
      }

      this.internalRpc.send.webviewTagSetNavigationRules({
        id: this.webviewId,
        rules: rules,
      });
    }

    findInPage(searchText: string, options?: {forward?: boolean; matchCase?: boolean}) {
      if (!this.webviewId) {
        console.warn('findInPage called on removed webview');
        return;
      }

      const forward = options?.forward ?? true;
      const matchCase = options?.matchCase ?? false;

      this.internalRpc.send.webviewTagFindInPage({
        id: this.webviewId,
        searchText,
        forward,
        matchCase,
      });
    }

    stopFindInPage() {
      if (!this.webviewId) {
        console.warn('stopFindInPage called on removed webview');
        return;
      }

      this.internalRpc.send.webviewTagStopFind({
        id: this.webviewId,
      });
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
